/**
 * HtmlVideoPlayer - HTML5 Video Backend
 *
 * Core video playback using HTML5 video element with HLS.js support.
 * Extracted and simplified from jellyfin-web's htmlVideoPlayer plugin.
 *
 * @module core/HtmlVideoPlayer
 */

import Hls from 'hls.js';
import Screenfull from 'screenfull';
import { MediaHelper } from './MediaHelper.js';
import { logger } from '../../utils/Logger.js';
import { PlayerSettings } from '../../utils/PlayerSettings.js';
import { getDeviceCapabilities } from '../../api/DeviceProfile.js';

const log = logger.create('HtmlVideoPlayer');

// ============================================================================
// Platform Audio Codec Helpers
// ============================================================================

const isTrueHdSupported = () => {
    const setting = PlayerSettings.get('enableTrueHd');
    if (setting === 'enable') return true;
    if (setting === 'disable') return false;
    try {
        const caps = getDeviceCapabilities();
        return !!caps?.truehd;
    } catch (e) {
        return false;
    }
};

const isDtsSupported = () => {
    const setting = PlayerSettings.get('enableDts');
    if (setting === 'enable') return true;
    if (setting === 'disable') return false;
    try {
        const caps = getDeviceCapabilities();
        return !!caps?.dts;
    } catch (e) {
        return false;
    }
};

// ============================================================================
// Constants
// ============================================================================

const SEEK_THRESHOLD_MS = 1000; // Minimum seek difference to trigger seek

// ============================================================================
// HtmlVideoPlayer Class
// ============================================================================

export class HtmlVideoPlayer {
    /**
     * @param {Object} options
     * @param {HTMLElement} options.container - Container element
     * @param {Object} options.settings - Settings manager
     * @param {Function} options.onEvent - Event callback
     */
    constructor(options) {
        this.container = options.container;
        this.settings = options.settings;
        this.onEvent = options.onEvent || (() => {});

        // ====================================================================
        // State
        // ====================================================================

        this._videoElement = null;
        this._hlsPlayer = null;
        this._currentSrc = null;
        this._currentPlayOptions = null;
        this._started = false;
        this._timeUpdated = false;

        // Subtitle state
        this._currentSubtitleIndex = -1;
        this._subtitleOffset = 0;
        this._previousOffset = 0; // Tracks the last applied offset for delta calc

        // Bound event handlers (for cleanup)
        this._boundHandlers = {};

        // Throttle for timeupdate events
        this._lastTimeUpdateTicks = 0;

        // Audio normalization (Web Audio API)
        this._audioContext = null;
        this._gainNode = null;
    }

    // ========================================================================
    // Initialization
    // ========================================================================

    /**
     * Get the underlying HTML5 video element.
     * @returns {HTMLVideoElement|null}
     */
    getVideoElement() {
        return this._ensureVideoElement();
    }

    /**
     * Create or get video element
     * @private
     */
    _ensureVideoElement() {
        if (this._videoElement) {
            // Ensure events are bound if they were unbound in stop()
            if (Object.keys(this._boundHandlers).length === 0) {
                this._bindEvents(this._videoElement);
            }
            return this._videoElement;
        }

        // Create video element
        const video = document.createElement('video');
        video.className = 'jellyfin-video-player';
        video.setAttribute('playsinline', 'true');
        video.setAttribute('webkit-playsinline', 'true');
        video.preload = 'metadata';

        // Apply saved volume
        video.volume = MediaHelper.getSavedVolume();

        // Create container if needed
        if (!this.container) {
            this.container = document.createElement('div');
            this.container.className = 'jellyfin-player-container';
            document.body.appendChild(this.container);
        }

        this.container.appendChild(video);
        this._videoElement = video;

        // Bind event handlers
        this._bindEvents(video);

        return video;
    }

    /**
     * Bind event handlers to video element
     * @private
     */
    _bindEvents(video) {
        const handlers = {
            timeupdate: this._onTimeUpdate.bind(this),
            ended: this._onEnded.bind(this),
            error: this._onError.bind(this),
            pause: this._onPause.bind(this),
            play: this._onPlay.bind(this),
            playing: this._onPlaying.bind(this),
            waiting: this._onWaiting.bind(this),
            stalled: this._onStalled.bind(this),
            seeking: this._onSeeking.bind(this),
            seeked: this._onSeeked.bind(this),
            volumechange: this._onVolumeChange.bind(this),
            durationchange: this._onDurationChange.bind(this),
            loadedmetadata: this._onLoadedMetadata.bind(this)
        };

        for (const [event, handler] of Object.entries(handlers)) {
            video.addEventListener(event, handler);
            this._boundHandlers[event] = handler;
        }
    }

    /**
     * Remove event handlers from video element
     * @private
     */
    _unbindEvents(video) {
        if (!video) return;

        for (const [event, handler] of Object.entries(this._boundHandlers)) {
            video.removeEventListener(event, handler);
        }
        this._boundHandlers = {};
    }

    // ========================================================================
    // Playback Control
    // ========================================================================

    /**
     * Start playback
     * @param {Object} options - Play options from JellyfinPlayer
     */
    async play(options) {
        log.info('Starting playback');

        this._currentPlayOptions = options;
        this._started = false;
        this._timeUpdated = false;

        // Reset subtitle offset for new playback session
        this._subtitleOffset = 0;
        this._previousOffset = 0;

        const video = this._ensureVideoElement();

        // Destroy any existing HLS player
        this._destroyHlsPlayer();

        // Determine playback method
        if (this._shouldUseHlsJs(options)) {
            await this._playWithHlsJs(video, options);
        } else {
            await this._playNative(video, options);
        }

        this._currentSrc = options.url;

        // Apply audio normalization for audio-only items
        this._applyAudioNormalization(options);
    }

    /**
     * Check if we should use HLS.js
     * @private
     */
    _shouldUseHlsJs(options) {
        // Use HLS.js if:
        // 1. Browser supports MSE (required for HLS.js)
        // 2. It's an HLS stream
        // 3. Native HLS isn't preferred (non-Safari)
        if (!Hls.isSupported()) {
            return false;
        }

        const isHlsStream = options.isHls || (options.url && options.url.includes('.m3u8'));

        if (!isHlsStream) {
            return false;
        }

        // Safari has native HLS support, but we might want HLS.js for better control
        const hasNativeHls = this._checkNativeHlsSupport();

        // Prefer HLS.js on most platforms for better control
        // But use native on Tizen where HLS.js might face strict CORS/CSP issues with Blob URLs
        const isTizen = /Tizen/.test(navigator.userAgent);
        
        if (isTizen && hasNativeHls) {
            log.info('Preferring native HLS playback (Tizen detected)');
            return false;
        }

        return true;
    }

    /**
     * Apply audio normalization gain via Web Audio API.
     * Only applies to audio-only items (music, audiobooks).
     * @private
     * @param {Object} options - Play options with item and mediaSource metadata
     */
    _applyAudioNormalization(options) {
        log.info('Audio normalization: entered, mode=' + PlayerSettings.get('audioNormalization') + ' itemType=' + (options.item?.MediaType || options.item?.Type || 'unknown'));

        const mode = PlayerSettings.get('audioNormalization');
        if (mode === 'Off') {
            log.info('Audio normalization: mode is Off, skipping');
            return;
        }

        const isAudioItem = options.item?.MediaType === 'Audio' || options.item?.Type === 'AudioBook';
        if (!isAudioItem) {
            log.info('Audio normalization: not an audio item, skipping');
            return;
        }

        const video = this._videoElement;
        if (!video) {
            log.info('Audio normalization: no video element');
            return;
        }

        let normalizationGain;
        if (mode === 'TrackGain') {
            normalizationGain = options.item?.NormalizationGain
                ?? options.mediaSource?.albumNormalizationGain;
        } else if (mode === 'AlbumGain') {
            normalizationGain = options.mediaSource?.albumNormalizationGain
                ?? options.item?.NormalizationGain;
        }

        if (normalizationGain == null) {
            log.info('Audio normalization: no gain value available');
            return;
        }

        try {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            if (!AudioContext) {
                log.warn('Audio normalization: Web Audio API not available');
                return;
            }

            if (!this._audioContext) {
                this._audioContext = new AudioContext();
            }

            const source = this._audioContext.createMediaElementSource(video);
            const gainNode = this._audioContext.createGain();
            const gainValue = Math.pow(10, normalizationGain / 20);
            gainNode.gain.value = gainValue;

            source.connect(gainNode);
            gainNode.connect(this._audioContext.destination);

            this._gainNode = gainNode;
            log.info(`Audio normalization: applied ${mode} gain of ${gainValue} (${normalizationGain} dB)`);

            // Store original volume change handler to scale gain on volume changes
            this._normalizationGainValue = gainValue;
        } catch (e) {
            log.error('Audio normalization: failed to create gain node', e);
        }
    }

    /**
     * Check native HLS support
     * @private
     */
    _checkNativeHlsSupport() {
        const video = document.createElement('video');
        return !!(
            video.canPlayType('application/x-mpegURL').replace(/no/, '') ||
            video.canPlayType('application/vnd.apple.mpegURL').replace(/no/, '')
        );
    }

    /**
     * Play using HLS.js
     * @private
     */
    _playWithHlsJs(video, options) {
        return new Promise((resolve, reject) => {
            log.info('Using HLS.js for playback');

            const hls = new Hls({
                startPosition: (options.playerStartPositionTicks || 0) / 10000000,
                maxBufferLength: PlayerSettings.get('html5MaxBufferLength') || 60,
                maxMaxBufferLength: PlayerSettings.get('html5MaxMaxBufferLength') || 120,
                manifestLoadingTimeOut: 20000,
                levelLoadingTimeOut: 20000,
                fragLoadingTimeOut: 20000,
                // Increase initial buffer goal for stability (matching Tizen's 6s goal)
                maxBufferSize: 60 * 1000 * 1000, // 60MB roughly
                enableWorker: true
            });

            // HLS.js events
            hls.on(Hls.Events.MANIFEST_PARSED, () => {
                log.info('HLS manifest parsed');

                // =========================================================================
                // Initial HLS Audio Track Selection Fix
                // =========================================================================
                // hls.audioTrack expects a 0-based list index into hls.audioTracks,
                // NOT the raw Jellyfin StreamID (options.audioStreamIndex).
                // Use options.audioTrackListIndex pre-computed by JellyfinPlayer.
                // =========================================================================
                if (options.audioStreamIndex !== undefined && options.audioStreamIndex >= 0) {
                    const listIndex = (options.audioTrackListIndex !== undefined && options.audioTrackListIndex !== null && options.audioTrackListIndex >= 0)
                        ? options.audioTrackListIndex
                        : 0;
                    const outputIndex = hls.audioTracks.length <= 1 ? 0 : listIndex;
                    if (outputIndex < hls.audioTracks.length) {
                        hls.audioTrack = outputIndex;
                        log.debug(`Set HLS audio track listIndex ${listIndex} mapped to outputIndex ${outputIndex}`);
                    }
                }

                if (options.subtitleStreamIndex !== undefined) {
                    // HLS.js subtitle tracks
                    if (options.subtitleStreamIndex === -1) {
                        hls.subtitleTrack = -1; // Disabled
                    } else if (options.subtitleStreamIndex < hls.subtitleTracks.length) {
                        hls.subtitleTrack = options.subtitleStreamIndex;
                        log.debug('Set HLS subtitle track:', options.subtitleStreamIndex);
                    }
                }

                if (options.autoPlay === false) {
                    log.info('HLS.js path: Skipping initial play() due to autoPlay=false');
                    resolve();
                } else {
                    const playPromise = video.play();
                    if (playPromise !== undefined && typeof playPromise.then === 'function') {
                        playPromise.then(resolve).catch((err) => {
                            if (err.name === 'NotAllowedError') {
                                log.warn('Autoplay blocked — retrying muted (remote launch).');
                                video.muted = true;
                                const retryPromise = video.play();
                                if (retryPromise !== undefined && typeof retryPromise.then === 'function') {
                                    retryPromise.then(() => {
                                        this._scheduleUnmuteOnInteraction(video);
                                        resolve();
                                    }).catch(reject);
                                } else {
                                    this._scheduleUnmuteOnInteraction(video);
                                    resolve();
                                }
                            } else {
                                reject(err);
                            }
                        });
                    } else {
                        resolve();
                    }
                }
            });

            // ================================================================
            // LEVEL_UPDATED — fired every time the manifest playlist is
            // fetched and parsed (live: every ~4s; VOD: once at the end).
            //
            // When details.live === false the server has appended #EXT-X-ENDLIST
            // to the manifest, which means the Jellyfin transcoder has finished
            // encoding the entire file. At that point details.totalduration is
            // the accurate total, and we can lock in the OSD to the right value.
            //
            // We store it on the HLS player instance and dispatch a synthetic
            // durationchange on the video element so JellyfinPlayer's existing
            // durationchange handler picks it up automatically.
            // ================================================================
            hls.on(Hls.Events.LEVEL_UPDATED, (event, data) => {
                const details = data?.details;
                if (!details) return;

                if (!details.live && details.totalduration > 0) {
                    // Manifest is complete — store duration for JellyfinPlayer to read
                    log.info(`[HLS] Manifest complete (EXT-X-ENDLIST). Total duration: ${details.totalduration.toFixed(1)}s`);
                    this._hlsManifestDuration = details.totalduration;

                    // Dispatch durationchange on the video element so the OSD
                    // refreshes without needing a separate polling mechanism.
                    video.dispatchEvent(new Event('durationchange'));
                }
            });

            hls.on(Hls.Events.ERROR, (event, data) => {
                // Filter out benign buffer stall errors
                if (data.details === 'bufferStalledError' && !data.fatal) {
                    log.warn('HLS buffer low (non-fatal):', data.buffer);
                    return;
                }

                if (!data.fatal) {
                    // ============================================================
                    // Non-fatal fragment load error — the most common cause is
                    // seeking ahead of the Jellyfin transcoder: segment N hasn't
                    // been encoded yet, so the server returns an empty response.
                    //
                    // Immediately calling startLoad() would hammer the server.
                    // Wait 2 seconds so the transcoder has time to produce the
                    // next segment, then tell HLS.js to retry loading.
                    // ============================================================
                    if (data.details === 'fragLoadError') {
                        log.warn('[HLS] Non-fatal fragLoadError — waiting 2s for transcoder, then retrying');
                        setTimeout(() => {
                            if (this._hlsPlayer === hls) {
                                hls.startLoad();
                            }
                        }, 2000);
                        return;
                    }

                    // All other non-fatal errors — log but let HLS.js handle automatically
                    log.warn('HLS non-fatal error:', data);
                    return;
                }

                log.error('HLS error:', data);

                if (data.fatal) {
                    switch (data.type) {
                        case Hls.ErrorTypes.NETWORK_ERROR:
                            log.info('Attempting to recover from network error');
                            hls.startLoad();
                            break;
                        case Hls.ErrorTypes.MEDIA_ERROR:
                            log.info('Attempting to recover from media error');
                            hls.recoverMediaError();
                            break;
                        default:
                            log.error('Fatal HLS error, cannot recover');
                            hls.destroy();
                            reject(new Error('HLS playback failed'));
                            break;
                    }
                }
            });

            // Load source
            log.debug('HLS Loading source:', options.url);
            hls.loadSource(options.url);
            hls.attachMedia(video);

            this._hlsPlayer = hls;
            this._hlsManifestDuration = null; // Reset for this session

            // Failsafe timeout
            setTimeout(() => {
                if (!this._started && !this._videoElement?.paused) {
                    log.warn('No playback start detected after 10s');
                }
            }, 10000);
        });
    }

    /**
     * Play using native video element
     * @private
     */
    async _playNative(video, options) {
        log.info('Using native playback');

        // Set cross-origin if needed
        const crossOrigin = MediaHelper.getCrossOriginValue(options.mediaSource);
        if (crossOrigin) {
            video.crossOrigin = crossOrigin;
        }

        // ====================================================================
        // MEDIA FRAGMENT INJECTION:
        // We append the media fragment `#t=seconds` to the stream URL.
        // This instructs standard HTML5 engines to begin loading and buffering
        // segments from the target seek position natively.
        // ====================================================================
        let url = options.url;
        const resumeSeconds = (options.playerStartPositionTicks || 0) / 10000000;
        if (resumeSeconds > 0) {
            log.info(`HtmlVideoPlayer: Appending media fragment #t=${resumeSeconds} for native seek`);
            url += `#t=${resumeSeconds}`;
        }

        // ====================================================================
        // RESUME SEEK TIMING FIX:
        // When resuming, disable autoplay so the browser does not start playback
        // before we have a chance to seek. Autoplay causes the browser to call
        // play() internally after canplay, and on WebOS Chromium this overrides
        // any pending currentTime assignment — the seek to the unbuffered resume
        // position is silently discarded and playback starts from 0.
        //
        // Instead, we seek at canplay and wait for the seeked event to confirm
        // the seek took effect before calling play().
        // ====================================================================
        if (resumeSeconds > 0) {
            video.autoplay = false;
        } else {
            video.autoplay = options.autoPlay !== false;
        }
        video.src = url;

        return new Promise((resolve, reject) => {
            let seekCompleted = false;
            let seekResolved = false;
            let seekTimeout = null;

            const resolveOnce = (value) => {
                if (!seekResolved) {
                    seekResolved = true;
                    resolve(value);
                }
            };

            const startPlayback = () => {
                if (options.autoPlay === false) {
                    log.info('Native path: Skipping initial play() due to autoPlay=false');
                    video.pause();
                    resolveOnce();
                    return;
                }

                const playPromise = video.play();
                if (playPromise !== undefined && typeof playPromise.then === 'function') {
                    playPromise
                        .then(() => {
                            this._applyPlaybackResume(video, options);
                            resolveOnce();
                        })
                        .catch((err) => {
                            if (err.name === 'NotAllowedError') {
                                log.warn('Autoplay blocked — retrying muted (remote launch).');
                                video.muted = true;
                                const retryPromise = video.play();
                                if (retryPromise !== undefined && typeof retryPromise.then === 'function') {
                                    retryPromise
                                        .then(() => {
                                            this._scheduleUnmuteOnInteraction(video);
                                            this._applyPlaybackResume(video, options);
                                            resolveOnce();
                                        })
                                        .catch(reject);
                                } else {
                                    this._scheduleUnmuteOnInteraction(video);
                                    this._applyPlaybackResume(video, options);
                                    resolveOnce();
                                }
                            } else {
                                reject(err);
                            }
                        });
                } else {
                    this._applyPlaybackResume(video, options);
                    resolveOnce();
                }
            };

            const onLoadedMetadata = () => {
                video.removeEventListener('loadedmetadata', onLoadedMetadata);

                // Check if the media fragment naturally landed us at the target (within 15s GOP keyframe tolerance)
                const currentPos = video.currentTime || 0;
                const fragmentDrift = Math.abs(currentPos - resumeSeconds);
                if (resumeSeconds > 0 && (fragmentDrift < 15 || currentPos >= (resumeSeconds - 15))) {
                    log.info('HtmlVideoPlayer: Media fragment seek (#t=) successfully applied natively');
                    seekCompleted = true;
                }

                // =========================================================================
                // Initial Audio Track Selection Fix
                // =========================================================================
                // setAudioStreamIndex expects a 0-based listIndex into native video.audioTracks
                // (or HLS tracks), NOT the raw Jellyfin audioStreamIndex StreamID.
                // JellyfinPlayer pre-computes audioTrackListIndex on options for this purpose.
                // Using raw StreamID (e.g. 4) caused an out-of-bounds index lookup on
                // video.audioTracks, disabling all tracks and falling back to track 0.
                // =========================================================================
                if (options.audioStreamIndex !== undefined && options.audioStreamIndex !== null) {
                    const listIndex = (options.audioTrackListIndex !== undefined && options.audioTrackListIndex !== null && options.audioTrackListIndex >= 0)
                        ? options.audioTrackListIndex
                        : 0;
                    log.info(`[HtmlVideoPlayer] Applying initial audio track: StreamID ${options.audioStreamIndex} → listIndex ${listIndex}`);
                    this.setAudioStreamIndex(listIndex);
                }
                if (options.subtitleStreamIndex !== undefined && options.subtitleStreamIndex !== null) {
                    this.setSubtitleStreamIndex(options.subtitleStreamIndex);
                }
            };

            const onCanPlay = () => {
                video.removeEventListener('canplay', onCanPlay);
                video.removeEventListener('error', onError);

                // If we need to resume and haven't landed at the target yet,
                // perform a seek-then-play: set currentTime and wait for seeked.
                if (resumeSeconds > 0 && !seekCompleted) {
                    log.info('HtmlVideoPlayer: Seeking to resume position', resumeSeconds, 's at canplay');

                    const onSeeked = () => {
                        video.removeEventListener('seeked', onSeeked);
                        if (seekTimeout) clearTimeout(seekTimeout);
                        seekCompleted = true;

                        const drift = Math.abs(video.currentTime - resumeSeconds);
                        log.debug(`HtmlVideoPlayer: Seek completed (current: ${video.currentTime.toFixed(2)} s, target: ${resumeSeconds} s, drift: ${drift.toFixed(2)} s)`);
                        startPlayback();
                    };

                    video.addEventListener('seeked', onSeeked);

                    // Initiate the seek
                    video.currentTime = resumeSeconds;

                    // Failsafe: if seek never completes (e.g. server doesn't support
                    // Range requests), proceed anyway after 10s
                    seekTimeout = setTimeout(() => {
                        video.removeEventListener('seeked', onSeeked);
                        if (!seekCompleted) {
                            log.warn('HtmlVideoPlayer: Seek timed out after 10s — starting playback from current position');
                            seekCompleted = true;
                            startPlayback();
                        }
                    }, 10000);
                } else {
                    // No resume needed, or media fragment already put us at target
                    startPlayback();
                }
            };

            const onError = () => {
                const err = video.error;
                log.error('Native video error:', err);
                video.removeEventListener('canplay', onCanPlay);
                video.removeEventListener('loadedmetadata', onLoadedMetadata);
                reject(err);
            };

            video.addEventListener('loadedmetadata', onLoadedMetadata);
            video.addEventListener('canplay', onCanPlay);
            video.addEventListener('error', onError);
        });
    }

    /**
     * Pause playback
     */
    pause() {
        this._videoElement?.pause();
    }

    /**
     * Resume playback
     */
    unpause() {
        if (!this._videoElement) return;
        
        this._videoElement.play().catch((err) => {
            if (err.name === 'NotAllowedError') {
                log.warn('unpause: Autoplay blocked — retrying muted.');
                this._videoElement.muted = true;
                this._videoElement.play().catch(e => log.error('unpause: Muted retry failed', e));
            } else {
                log.error('unpause: Play failed', err);
            }
        });
    }

    /**
     * Stop playback
     */
    async stop() {
        this._destroyHlsPlayer();

        const video = this._videoElement;

        if (video) {
            // Unbind events before clearing src to prevent error events from firing
            this._unbindEvents(video);
            
            video.pause();
            // Use removeAttribute instead of setting src to empty string to be cleaner
            video.removeAttribute('src');
            video.load();

            // ── Tizen Chromium GPU surface release ────────────────────────────
            //
            // On Tizen's embedded Chromium, a <video> element that remains in
            // the DOM continues to hold its decoded frame buffer as a GPU texture
            // even after src is cleared and load() is called. For 4K content,
            // this surface can be 20–80MB of VRAM that the compositor cannot
            // reclaim. The result: GPU memory fragmentation that manifests as
            // visual glitches (flickering icons, white button flashes) on the
            // next page.
            //
            // The fix: temporarily remove the element from the DOM. This signals
            // to the compositor that the GPU surface is no longer needed and
            // should be released. We immediately re-insert a placeholder so that
            // _ensureVideoElement() re-uses the same DOM node on the next play()
            // call without needing to recreate it.
            //
            if (video.parentNode) {
                const parent = video.parentNode;
                parent.removeChild(video);
                // Re-insert so the element is still reachable — _ensureVideoElement()
                // checks this._videoElement (not the DOM), so re-insertion order
                // doesn't matter, but having it in the tree avoids surprises with
                // any code that queries the container's children.
                parent.appendChild(video);
                log.debug('stop(): video element cycled out/in DOM to flush GPU surface');
            }
        }

        // Clean up audio normalization
        if (this._gainNode) {
            try {
                this._gainNode.disconnect();
            } catch (e) {
                // ignore
            }
            this._gainNode = null;
        }
        if (this._audioContext) {
            try {
                this._audioContext.close();
            } catch (e) {
                // ignore
            }
            this._audioContext = null;
        }
        this._normalizationGainValue = null;

        this._currentSrc = null;
        this._currentPlayOptions = null;
        this._started = false;
        this._timeUpdated = false;
    }

    /**
     * Seek to position
     * @param {number} positionTicks - Position in ticks
     */
    seek(positionTicks) {
        const video = this._videoElement;
        if (!video) return;

        const seconds = positionTicks / 10000000;
        log.debug('seek to seconds', seconds, 'ticks', positionTicks);

        // Account for transcoding offset
        let targetSeconds = seconds;
        if (this._currentPlayOptions?.transcodingOffsetTicks) {
            targetSeconds = (positionTicks - this._currentPlayOptions.transcodingOffsetTicks) / 10000000;
        }

        if (Math.abs(video.currentTime - targetSeconds) > SEEK_THRESHOLD_MS / 1000) {
            video.currentTime = Math.max(0, targetSeconds);
        }

        // Manual timeupdate for paused state (native event is delayed or absent on many browsers)
        this.onEvent({ type: 'timeupdate', data: { time: targetSeconds } });

        // ---------------------------------------------------------------------
        // DirectPlay Seek Verification Guard:
        // When DirectPlaying raw progressive files (like MKVs with chained or
        // missing SeekHead Cues), the browser demuxer may silently fail to seek.
        // If this is a direct stream (non-HLS) and target >= 5s, verify after 2.5s.
        // ---------------------------------------------------------------------
        const isLive = this._currentPlayOptions?.item?.Type === 'TvChannel' || this._currentPlayOptions?.mediaSource?.LiveStreamId;
        if (!this._isHls && !isLive && targetSeconds >= 5) {
            if (this._directSeekVerifyTimeout) {
                clearTimeout(this._directSeekVerifyTimeout);
            }
            this._directSeekVerifyTimeout = setTimeout(() => {
                if (!this._videoElement) return;
                const cur = this.getCurrentTime();
                const drift = Math.abs(cur - targetSeconds);
                const isNear = drift < 15 || cur >= (targetSeconds - 15);
                if (!isNear) {
                    log.warn(`HtmlVideoPlayer: DirectPlay seek to ${targetSeconds}s failed (stuck at ${cur.toFixed(2)}s) — emitting resumeseekfailed for Remux fallback`);
                    this.onEvent({
                        type: 'resumeseekfailed',
                        data: { targetPositionTicks: positionTicks }
                    });
                }
            }, 2500);
        }
    }

    // ========================================================================
    // Volume Control
    // ========================================================================

    /**
     * Set volume
     * @param {number} volume - Volume (0-100)
     */
    setVolume(volume) {
        if (this._videoElement) {
            const normalizedVolume = Math.max(0, Math.min(100, volume)) / 100;
            this._videoElement.volume = normalizedVolume;
            MediaHelper.saveVolume(normalizedVolume);
        }
    }

    /**
     * Get current volume
     * @returns {number} Volume (0-100)
     */
    getVolume() {
        return (this._videoElement?.volume ?? 1) * 100;
    }

    /**
     * Set playback speed
     * @param {number} speed
     */
    setSpeed(speed) {
        if (this._videoElement) {
            this._videoElement.playbackRate = speed;
        }
    }

    /**
     * Toggle mute
     */
    toggleMute() {
        if (this._videoElement) {
            this._videoElement.muted = !this._videoElement.muted;
        }
    }

    /**
     * Set mute state explicitly.
     * Called by JellyfinPlayer when a remote Mute/Unmute command arrives.
     *
     * In browser mode, Chrome blocks setting muted=false if the video was
     * started without a user gesture — it pauses the video as a side-effect.
     * We catch that case and resume playback muted so at least it keeps playing.
     * On Tizen this path is irrelevant (system audio control is used instead).
     *
     * @param {boolean} muted
     */
    setMuted(muted) {
        if (!this._videoElement) return;

        try {
            this._videoElement.muted = muted;
        } catch (e) {
            // Swallow any synchronous errors (shouldn't happen but guard anyway)
            log.warn('setMuted threw:', e);
        }

        // If Chrome blocked the unmute and paused the video as a side effect,
        // resume playback muted so the user isn't left with a frozen screen.
        if (!muted && this._videoElement.paused && this._videoElement.muted) {
            log.warn('Unmute blocked by browser — resuming muted to keep playback going.');
            this._videoElement.play().catch(() => {});
        }
    }

    /**
     * Schedule an unmute once the user physically interacts with the document.
     *
     * Chrome's autoplay policy blocks setting muted=false mid-playback if the
     * video was started without a user gesture.  The policy is lifted the moment
     * any real interaction occurs.  We listen for the first keydown or click and
     * unmute at that point — completely transparent to the user.
     *
     * @param {HTMLVideoElement} video
     * @private
     */
    _scheduleUnmuteOnInteraction(video) {
        const unmute = () => {
            // Only unmute if the video is still the one we started (not already
            // replaced by a new play() call) and is still muted programmatically.
            if (video.muted) {
                log.info('User interaction detected — unmuting video.');
                video.muted = false;
            }
            document.removeEventListener('keydown', unmute, true);
            document.removeEventListener('click', unmute, true);
        };

        // Use capture phase so we intercept before any other handler consumes the event
        document.addEventListener('keydown', unmute, { capture: true, once: true });
        document.addEventListener('click', unmute, { capture: true, once: true });

        log.info('Scheduled unmute on next user interaction (keydown/click).');
    }

    /**
     * Post-play resume seek fallback.
     * If the initial currentTime set in loadedmetadata was ignored (common on
     * webOS when the decoder hasn't fully initialized), try again after play()
     * resolves and give it a second chance with a short delay.
     * @private
     * @param {HTMLVideoElement} video
     * @param {Object} options
     */
    _applyPlaybackResume(video, options) {
        if (!options.playerStartPositionTicks) return;
        const targetSec = options.playerStartPositionTicks / 10000000;
        if (targetSec < 5) return;

        // ====================================================================
        // PLAYHEAD DRIFT CHECK:
        // If the playhead is already within 15 s of the target, the earlier
        // seek (either the #t= fragment or the currentTime set in loadedmetadata)
        // already worked. Skip the re-seek to avoid a disruptive backward stutter.
        //
        // We use 15 s (matching WebOS and JellyfinPlayer's resume-verification
        // threshold) rather than 2 s or 10 s, because:
        //   1. The browser seeks to the nearest keyframe, not the exact timestamp,
        //      which can land up to ~10.4 s away for 24fps 250-frame GOPs.
        //   2. play() may take 1-3+ seconds to resolve on a slow buffer, so the
        //      video may have already played forward from the seek landing point
        //      by the time this guard runs.
        // ====================================================================
        const currentPos = video.currentTime || 0;
        const drift = Math.abs(currentPos - targetSec);
        const isNearTarget = drift < 15 || currentPos >= (targetSec - 15);

        if (isNearTarget) {
            log.info(`HtmlVideoPlayer: Playhead within ${drift.toFixed(2)} s of target — skipping fallback resume seek.`);
            return;
        }

        log.info('HtmlVideoPlayer: Re-applying resume seek to', targetSec, 's');
        video.currentTime = targetSec;

        // Give it one more chance after a 2-second delay in case the first
        // assignment was too early (buffer not yet ready).
        setTimeout(() => {
            const retryPos = video.currentTime || 0;
            const retryDrift = Math.abs(retryPos - targetSec);
            const retryNear = retryDrift < 15 || retryPos >= (targetSec - 15);

            if (!retryNear) {
                log.warn(`HtmlVideoPlayer: Resume seek failed (current: ${retryPos.toFixed(2)} s, target: ${targetSec} s, drift: ${retryDrift.toFixed(2)} s) — signaling fallback to Remux`);

                // Emit event so JellyfinPlayer can restart playback using Remux/DirectStream
                // mode. In Remux mode the server streams from the target position, making
                // seeks work where DirectPlay + #t= fragment fails on WebOS Chromium.
                this.onEvent({
                    type: 'resumeseekfailed',
                    data: { targetPositionTicks: options.playerStartPositionTicks }
                });
            }
        }, 2000);
    }

    /**
     * Check if muted
     * @returns {boolean}
     */
    isMuted() {
        return this._videoElement?.muted ?? false;
    }

    // ========================================================================
    // Track Selection
    // ========================================================================

    /**
     * Resolve a Jellyfin-visible audio list index to the actual position inside
     * the browser's video.audioTracks collection for HTML5 direct-play.
     *
     * HTML5 video engines may omit unsupported audio codecs (e.g. FLAC in MKV)
     * from video.audioTracks while preserving the relative order of remaining
     * tracks. This method dynamically detects which Jellyfin streams are missing
     * from the native track list and maps the requested listIndex accordingly.
     *
     * Resolution strategy (in priority order):
     *
     *   1. Codec-aware playable stream mapping — when nativeTracks.length differs
     *      from jellyfinAudioStreams.length, filter out "suspect" codecs (FLAC,
     *      ALAC, TrueHD, DTS) from the Jellyfin list. If the filtered count
     *      matches nativeTracks.length, use the filtered list to map the target
     *      stream to its position among playable streams. If the target stream
     *      itself has an unsupported codec, return -1 to trigger a server-side
     *      transcode restart.
     *
     *   2. Language-tag match — find native tracks matching the target stream's
     *      language using ISO 639-2 ↔ BCP-47 normalisation.
     *
     *   3. Same-language disambiguation — when multiple native tracks share the
     *      same language, pick by relative position within the playable Jellyfin
     *      streams for that language.
     *
     *   4. Positional fallback — clamped to native track bounds.
     *
     * @param   {number}         listIndex    0-based index into Jellyfin audio streams
     *                                        (from _getBackendAudioTrackListIndex).
     * @param   {AudioTrackList} nativeTracks video.audioTracks from the HTML5 video element.
     * @returns {number}  Index to use for audioTracks[i].enabled, or -1 if unmapped.
     * @private
     */
    _resolveNativeAudioIndex(listIndex, nativeTracks) {
        // Guard: no native tracks exposed by the browser engine
        if (!nativeTracks || nativeTracks.length === 0) {
            log.warn('[AudioDebug] HtmlVideoPlayer._resolveNativeAudioIndex: nativeTracks is empty');
            return -1;
        }

        // Fast-path: only one native track — no ambiguity possible
        if (nativeTracks.length === 1) {
            log.info('[AudioDebug] HtmlVideoPlayer._resolveNativeAudioIndex: single native track fast-path → 0');
            return 0;
        }

        // ── Gather Jellyfin audio streams from current media source ──────────
        const mediaStreams = this._currentPlayOptions?.mediaSource?.MediaStreams || [];
        const jellyfinAudioStreams = mediaStreams.filter(s => {
            if (s.Type !== 'Audio') return false;
            const codec = (s.Codec || '').toLowerCase();
            if (codec === 'truehd' && !isTrueHdSupported()) return false;
            if ((codec.includes('dts') || codec === 'dca') && !isDtsSupported()) return false;
            if ((codec === 'flac' || codec === 'alac') && !PlayerSettings.get('enableFlacInVideo')) return false;
            return true;
        });

        // ── Detailed diagnostic logging ──────────────────────────────────────
        log.info('[AudioDebug] HtmlVideoPlayer._resolveNativeAudioIndex:');
        log.info('  - listIndex requested:', listIndex);
        log.info('  - Jellyfin Audio Streams count:', jellyfinAudioStreams.length);
        jellyfinAudioStreams.forEach((s, idx) => {
            log.info(`    * [${idx}] Index: ${s.Index}, Lang: ${s.Language}, Codec: ${s.Codec}, IsDefault: ${s.IsDefault}`);
        });

        log.info('  - HTML5 video.audioTracks count:', nativeTracks.length);
        for (let i = 0; i < nativeTracks.length; i++) {
            const t = nativeTracks[i];
            log.info(`    * [${i}] id: ${t.id}, language: ${t.language}, label: ${t.label}, enabled: ${t.enabled}`);
        }

        // Guard: ensure listIndex points to a valid Jellyfin audio stream
        const targetStream = jellyfinAudioStreams[listIndex];
        if (!targetStream) {
            log.warn('[AudioDebug] HtmlVideoPlayer: listIndex out of range, returning clamped fallback');
            return Math.min(Math.max(0, listIndex), nativeTracks.length - 1);
        }

        log.info('  - targetStream Index:', targetStream.Index, 'Language:', targetStream.Language, 'Codec:', targetStream.Codec);

        // ====================================================================
        // Strategy 1: Codec-Aware Playable Stream Mapping (PRIMARY)
        //
        // When the native player exposes fewer tracks than Jellyfin reports,
        // it means certain codecs were silently dropped by the browser demuxer
        // (e.g. FLAC in MKV, TrueHD, DTS). We build a "playable" subset of
        // Jellyfin streams by filtering out suspect codecs, then verify the
        // count matches native tracks. If it does, we have a reliable 1:1 map.
        //
        // This MUST run before language matching because language matching alone
        // cannot disambiguate when all tracks share the same language but some
        // codecs were dropped (e.g. 4 English tracks → 3 native tracks).
        // ====================================================================
        if (nativeTracks.length !== jellyfinAudioStreams.length) {
            // Codecs commonly unsupported by HTML5 video element native demuxers
            const SUSPECT_CODECS = ['flac', 'alac', 'truehd', 'dts', 'dca'];

            // Helper: check if a codec string matches any suspect codec
            const isUnsupportedCodec = (codec) => {
                const c = (codec || '').toLowerCase();
                return SUSPECT_CODECS.some(sc => c === sc || c.includes(sc));
            };

            // Build the "playable" stream list by removing suspect codecs
            const playableStreams = jellyfinAudioStreams.filter(s => !isUnsupportedCodec(s.Codec));

            log.info(`  - Codec-aware mapping: ${jellyfinAudioStreams.length} jellyfin → ${playableStreams.length} playable (native: ${nativeTracks.length})`);

            // Verify our hypothesis: playable count should match native track count
            if (playableStreams.length === nativeTracks.length) {
                const targetCodec = (targetStream.Codec || '').toLowerCase();

                // If the user selected an unsupported track (e.g. FLAC), signal
                // that native switching is impossible — caller should trigger a
                // server-side transcode restart instead.
                if (isUnsupportedCodec(targetCodec)) {
                    log.info(`[AudioDebug] HtmlVideoPlayer: Target codec "${targetCodec}" is unsupported by native player → returning -1 for transcode restart`);
                    return -1;
                }

                // Find the target stream's position within the playable list
                const nativeIdx = playableStreams.findIndex(s => s.Index === targetStream.Index);
                if (nativeIdx >= 0) {
                    log.info(`[AudioDebug] HtmlVideoPlayer: Codec-aware mapping resolved listIndex ${listIndex} → native index ${nativeIdx}`);
                    return nativeIdx;
                }
            }
        }

        // ====================================================================
        // Strategy 2: Language-Tag Matching (ISO 639-2 ↔ BCP-47 / ISO 639-1)
        //
        // When track counts match (no codecs were dropped) but the native
        // player reordered tracks (e.g. moving default track to index 0),
        // language tags can identify the correct native track position.
        // ====================================================================
        const targetLang = (targetStream.Language || '').toLowerCase().trim();
        if (targetLang && targetLang !== 'und' && targetLang !== 'unknown') {
            const ISO_MAP = {
                'eng': 'en', 'zho': 'zh', 'chi': 'zh', 'spa': 'es', 'fre': 'fr', 'fra': 'fr',
                'ger': 'de', 'deu': 'de', 'jpn': 'ja', 'kor': 'ko', 'rus': 'ru', 'ita': 'it',
                'por': 'pt', 'dut': 'nl', 'nld': 'nl', 'swe': 'sv', 'nor': 'no', 'dan': 'da',
                'fin': 'fi', 'pol': 'pl', 'tur': 'tr', 'ara': 'ar', 'hin': 'hi', 'vie': 'vi',
                'tha': 'th', 'heb': 'he', 'ell': 'el', 'gre': 'el', 'ind': 'id', 'msa': 'ms',
                'ron': 'ro', 'hun': 'hu', 'ces': 'cs', 'slk': 'sk', 'ukr': 'uk', 'bul': 'bg',
                'hrv': 'hr', 'srp': 'sr', 'slv': 'sl', 'est': 'et', 'lav': 'lv', 'lit': 'lt'
            };

            const normalize = (l) => {
                const clean = (l || '').toLowerCase().trim();
                return ISO_MAP[clean] || clean;
            };

            const normTarget = normalize(targetLang);
            const nativeMatches = [];

            for (let i = 0; i < nativeTracks.length; i++) {
                const nativeLang = normalize(nativeTracks[i].language);
                if (!nativeLang) continue;
                if (nativeLang === normTarget || nativeLang.startsWith(normTarget) || normTarget.startsWith(nativeLang)) {
                    nativeMatches.push(i);
                }
            }

            // Unique language match — unambiguous resolution
            if (nativeMatches.length === 1) {
                log.info('[AudioDebug] HtmlVideoPlayer: Resolved native audio index by unique language match', listIndex, '→', nativeMatches[0]);
                return nativeMatches[0];
            }

            // Multiple same-language matches — disambiguate by relative position
            if (nativeMatches.length > 1) {
                const sameLangStreams = jellyfinAudioStreams.filter(s => normalize(s.Language) === normTarget);
                const posWithinLang = sameLangStreams.findIndex(s => s.Index === targetStream.Index);
                if (posWithinLang >= 0 && posWithinLang < nativeMatches.length) {
                    log.info('[AudioDebug] HtmlVideoPlayer: Disambiguated same language match', listIndex, '→', nativeMatches[posWithinLang]);
                    return nativeMatches[posWithinLang];
                }
            }
        }

        // ====================================================================
        // Strategy 3: Positional Fallback — clamped to native track bounds
        // ====================================================================
        const fallbackIndex = Math.min(Math.max(0, listIndex), nativeTracks.length - 1);
        log.info('[AudioDebug] HtmlVideoPlayer: Positional fallback index', listIndex, '→ native index', fallbackIndex);
        return fallbackIndex;
    }

    /**
     * Set audio stream index.
     *
     * Receives a 0-based list index (already converted from Jellyfin stream ID
     * by JellyfinPlayer.setAudioStreamIndex before calling the backend).
     *
     * For HLS streams, we switch via hls.js's audioTrack property.
     * For native multi-audio (e.g. MP4 DirectPlay), we toggle video.audioTracks.
     *
     * @param {number} listIndex - 0-based index into the available audio tracks
     */
    setAudioStreamIndex(listIndex) {
        // ── HLS path: delegate to hls.js which owns the audio track selection ──
        if (this._hlsPlayer) {
            const tracks = this._hlsPlayer.audioTracks;
            if (tracks) {
                const outputIndex = tracks.length <= 1 ? 0 : listIndex;
                if (outputIndex >= 0 && outputIndex < tracks.length) {
                    log.info('HLS: switching audio track to list index', listIndex, '→ outputIndex', outputIndex, '(', tracks[outputIndex]?.name, ')');
                    this._hlsPlayer.audioTrack = outputIndex;
                } else {
                    log.warn('HLS: audio track index', listIndex, 'mapped to', outputIndex, 'out of range (', tracks.length, 'tracks)');
                }
            }
            return;
        }

        // ── Native path: toggle HTML5 AudioTrack objects (MP4 DirectPlay) ──
        const video = this._videoElement;
        if (!video) return;

        const audioTracks = video.audioTracks;
        if (!audioTracks || audioTracks.length === 0) {
            log.warn('HtmlVideoPlayer: video.audioTracks is empty for direct-play — firing audiotrackswitchfailed to trigger restart');
            this.onEvent({ type: 'audiotrackswitchfailed', data: { listIndex } });
            return;
        }

        const nativeIndex = this._resolveNativeAudioIndex(listIndex, audioTracks);
        if (nativeIndex < 0 || nativeIndex >= audioTracks.length) {
            log.warn('HtmlVideoPlayer: _resolveNativeAudioIndex out of range — firing audiotrackswitchfailed');
            this.onEvent({ type: 'audiotrackswitchfailed', data: { listIndex } });
            return;
        }

        for (let i = 0; i < audioTracks.length; i++) {
            // Enable only the track at the resolved native index
            audioTracks[i].enabled = (i === nativeIndex);
        }
        log.info('HtmlVideoPlayer: Switched native audio track list index', listIndex, '→ native index', nativeIndex);
    }

    /**
     * Set subtitle stream index.
     * For HTML5 backend, this manages native text tracks (e.g., HLS-embedded VTT).
     * External subtitle rendering is now handled by SubtitleManager at the
     * JellyfinPlayer level, so this method may be called with -1 to disable
     * native tracks when SubtitleManager takes over.
     *
     * @param {number} index - Subtitle stream index (-1 to disable)
     */
    setSubtitleStreamIndex(index) {
        const video = this._videoElement;
        if (!video) return;

        this._currentSubtitleIndex = index;

        // Reset offset state when switching tracks
        this._subtitleOffset = 0;
        this._previousOffset = 0;

        // Handle native text tracks (HLS-embedded VTT, etc.)
        const textTracks = video.textTracks;
        if (textTracks) {
            for (let i = 0; i < textTracks.length; i++) {
                textTracks[i].mode = i === index ? 'showing' : 'hidden';
            }
        }

        // Note: ASS/PGS rendering is planned for Phase 2/3 via SubtitleManager
    }

    /**
     * Check if the backend can native switch audio tracks without restarting
     * @returns {boolean}
     */
    supportsNativeAudioTracks() {
        // Use existing video element, or create a throwaway one just to test feature support
        const video = this._videoElement || document.createElement('video');
        if (!video.audioTracks) return false;
        
        const userAgent = navigator.userAgent.toLowerCase();
        
        // Firefox only sees the first track
        if (userAgent.includes('firefox')) return false;
        
        // Tizen logic: Requires 5.5+, but reportedly broken on Tizen 8
        const tizenMatch = userAgent.match(/tizen (\d+\.\d+)/);
        if (tizenMatch) {
            const version = parseFloat(tizenMatch[1]);
            if (version < 5.5 || version >= 8) return false;
        }
        
        return true;
    }

    /**
     * Set aspect ratio mode
     * @param {string} mode - 'auto', 'zoom', 'stretch'
     */
    setAspectRatio(mode) {
        if (!this._videoElement) return;

        let objectFit = 'contain'; // Default/Auto

        switch (mode) {
            case 'zoom':
                objectFit = 'cover';
                break;
            case 'stretch':
                objectFit = 'fill';
                break;
            case 'auto':
            default:
                objectFit = 'contain';
                break;
        }

        log.info('Setting aspect ratio:', mode, '->', objectFit);
        this._videoElement.style.objectFit = objectFit;
    }

    /**
     * Set subtitle offset by shifting VTT cue timing.
     * Uses delta-based approach: calculates the difference between the new
     * offset and the previously applied offset, then shifts all cue times.
     * Positive offset = subtitles display later, negative = earlier.
     * @param {number} seconds - Offset in seconds
     */
    setSubtitleOffset(seconds) {
        this._subtitleOffset = seconds;

        const video = this._videoElement;
        if (!video || !video.textTracks) {
            log.debug(`Subtitle offset stored: ${seconds}s (no video/tracks)`);
            return;
        }

        // Calculate the relative delta from the last applied offset
        const delta = seconds - this._previousOffset;
        if (delta === 0) return; // No change needed

        // Apply the delta to all 'showing' text tracks' cues
        for (let i = 0; i < video.textTracks.length; i++) {
            const track = video.textTracks[i];
            if (track.mode !== 'showing' || !track.cues) continue;

            // Shift every cue's start and end time by the delta
            for (let j = 0; j < track.cues.length; j++) {
                const cue = track.cues[j];
                cue.startTime += delta;
                cue.endTime += delta;
            }
        }

        // Update the tracked offset for next delta calculation
        this._previousOffset = seconds;
        log.debug(`Subtitle offset applied: ${seconds}s (delta: ${delta}s)`);
    }

    // ========================================================================
    // State Getters
    // ========================================================================

    /**
     * Get current time in seconds
     * @returns {number}
     */
    getCurrentTime() {
        return this._videoElement?.currentTime ?? 0;
    }

    /**
     * Get duration in seconds
     * @returns {number}
     */
    getDuration() {
        return this._videoElement?.duration ?? 0;
    }

    /**
     * Get the accurate total duration (in seconds) derived from a completed HLS.js manifest.
     *
     * Jellyfin transcodes HLS as a rolling live stream, so `video.duration` grows
     * chunk by chunk. Once the Jellyfin transcoder finishes encoding the entire file,
     * it appends `#EXT-X-ENDLIST` to the manifest and HLS.js fires LEVEL_UPDATED with
     * `details.live === false`. At that point `details.totalduration` is the real total,
     * which we cache in `_hlsManifestDuration` and expose here.
     *
     * Returns null if the manifest has not yet completed (still a live stream window).
     *
     * @returns {number|null} Accurate total duration in seconds, or null if not yet known
     */
    getHlsManifestDuration() {
        // `_hlsManifestDuration` is set inside the LEVEL_UPDATED handler when
        // the server has finished transcoding (details.live === false).
        return (this._hlsManifestDuration != null && this._hlsManifestDuration > 0)
            ? this._hlsManifestDuration
            : null;
    }

    /**
     * Get start position in ticks
     * @returns {number}
     */
    getStartPositionTicks() {
        return this._currentPlayOptions?.playerStartPositionTicks || 0;
    }


    /**
     * Check if paused
     * @returns {boolean}
     */
    isPaused() {
        return this._videoElement?.paused ?? true;
    }

    // ========================================================================
    // Fullscreen
    // ========================================================================

    /**
     * Toggle fullscreen
     */
    toggleFullscreen() {
        if (Screenfull.isEnabled) {
            if (Screenfull.isFullscreen) {
                Screenfull.exit();
            } else {
                Screenfull.request(this.container || this._videoElement);
            }
        }
    }

    /**
     * Check if in fullscreen
     * @returns {boolean}
     */
    isFullscreen() {
        if (Screenfull.isEnabled) {
            return Screenfull.isFullscreen;
        }
        return !!document.fullscreenElement;
    }

    // ========================================================================
    // Event Handlers
    // ========================================================================

    /** @private */
    _onTimeUpdate() {
        if (!this._timeUpdated && this._videoElement?.currentTime) {
            this._timeUpdated = true;
        }

        const currentTime = this.getCurrentTime();
        const currentTimeTicks = Math.floor(currentTime * 10000000);
        
        // Throttle to ~250ms to reduce main thread load on slow TVs
        if (Math.abs(currentTimeTicks - this._lastTimeUpdateTicks) > 2500000) {
            this._lastTimeUpdateTicks = currentTimeTicks;
            this.onEvent({ type: 'timeupdate', data: { time: currentTime } });
        }
    }

    /** @private */
    _onEnded() {
        log.info('Playback ended');
        this.onEvent({ type: 'ended' });
    }

    /** @private */
    _onError(e) {
        const video = e.target;

        // Ignore errors if we don't have a source and no HLS player is active.
        // This commonly happens during stop/cleanup when src is removed.
        if (!video.src && !this._hlsPlayer) {
            log.debug('Ignoring error event on empty source during cleanup');
            return;
        }

        const errorCode = video.error?.code || 0;
        const errorMessage = video.error?.message || 'Unknown error';

        log.error(`Error ${errorCode}: ${errorMessage}`);

        // Try HLS.js recovery for decode errors
        if (errorCode === 3 && this._hlsPlayer) {
            log.info('Attempting HLS.js media error recovery');
            this._hlsPlayer.recoverMediaError();
            return;
        }

        this.onEvent({ type: 'error', data: { code: errorCode, message: errorMessage } });
    }

    /** @private */
    _onPause() {
        this.onEvent({ type: 'pause' });
    }

    /** @private */
    _onPlay() {
        this.onEvent({ type: 'play' });
    }

    /** @private */
    _onPlaying() {
        if (!this._started) {
            this._started = true;
            log.info('Playback started');
            this.onEvent({ type: 'playbackstart' });
        }
        this._clearStallCheck();
        this.onEvent({ type: 'playing' });
    }

    /** @private */
    _onWaiting() {
        this.onEvent({ type: 'waiting' });
        this._startStallCheck();
    }

    /** @private */
    _onStalled() {
        log.warn('Playback stalled');
        this.onEvent({ type: 'waiting' });
        this._startStallCheck();
    }

    /** @private */
    _onSeeking() {
        const video = this._videoElement;
        // Only show spinner if we are NOT paused (real buffering during playback)
        if (video && !video.paused) {
            this.onEvent({ type: 'waiting' });
        }
    }

    /** @private */
    _onSeeked() {
        const video = this._videoElement;
        if (video && !video.paused) {
            // Re-use _onPlaying logic for seeked-playing transition
            this._onPlaying();
        }
        this._clearStallCheck();
    }

    /** @private */
    _startStallCheck() {
        this._clearStallCheck();
        
        // If we stay in waiting/stalled for too long on Tizen, try to kick it
        this._stallTimer = setTimeout(() => {
            if (this._videoElement && !this._videoElement.paused && this._started) {
                log.warn('Playback still stalled after 5s - attempting recovery kick');
                try {
                    // Small jump to trigger buffer re-evaluation
                    this._videoElement.currentTime += 0.01;
                } catch (e) {
                    log.error('Stall recovery kick failed:', e);
                }
            }
        }, 5000);
    }

    /** @private */
    _clearStallCheck() {
        if (this._stallTimer) {
            clearTimeout(this._stallTimer);
            this._stallTimer = null;
        }
    }

    /** @private */
    _onVolumeChange() {
        if (this._videoElement) {
            MediaHelper.saveVolume(this._videoElement.volume);
        }
        this.onEvent({ type: 'volumechange', data: { volume: this.getVolume() } });
    }

    /** @private */
    _onLoadedMetadata() {
        log.debug('Metadata loaded');
        this.onEvent({ type: 'loadedmetadata', data: { duration: this.getDuration() } });
    }

    /** @private */
    _onDurationChange() {
        this.onEvent({ type: 'durationchange', data: { duration: this.getDuration() } });
    }

    // ========================================================================
    // Cleanup
    // ========================================================================

    /**
     * Destroy HLS.js player
     * @private
     */
    _destroyHlsPlayer() {
        if (this._hlsPlayer) {
            try {
                this._hlsPlayer.destroy();
            } catch (e) {
                log.error('Error destroying HLS player:', e);
            }
            this._hlsPlayer = null;
        }
    }

    /**
     * Destroy the player and clean up
     */
    destroy() {
        this.stop();

        if (this._videoElement) {
            this._unbindEvents(this._videoElement);

            if (this._videoElement.parentNode) {
                this._videoElement.parentNode.removeChild(this._videoElement);
            }

            this._videoElement = null;
        }

        // Exit fullscreen if active
        if (Screenfull.isEnabled && Screenfull.isFullscreen) {
            Screenfull.exit();
        }
    }
}
