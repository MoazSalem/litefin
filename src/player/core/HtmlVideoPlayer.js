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

const log = logger.create('HtmlVideoPlayer');

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

                if (options.audioStreamIndex !== undefined && options.audioStreamIndex >= 0) {
                    const outputIndex = hls.audioTracks.length <= 1 ? 0 : options.audioStreamIndex;
                    if (outputIndex < hls.audioTracks.length) {
                        hls.audioTrack = outputIndex;
                        log.debug('Set HLS audio track:', options.audioStreamIndex, 'mapped to', outputIndex);
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

        video.src = options.url;
        video.autoplay = options.autoPlay !== false;

        // Seek if starting from position
        if (options.playerStartPositionTicks) {
            const startSeconds = options.playerStartPositionTicks / 10000000;
            if (video.duration >= startSeconds || !MediaHelper.isValidDuration(video.duration)) {
                video.currentTime = startSeconds;
            }
        }

        return new Promise((resolve, reject) => {
            const onLoadedMetadata = () => {
                video.removeEventListener('loadedmetadata', onLoadedMetadata);
                // Apply initially requested tracks once native tracks are populated
                if (options.audioStreamIndex !== undefined && options.audioStreamIndex !== null) {
                    this.setAudioStreamIndex(options.audioStreamIndex);
                }
                if (options.subtitleStreamIndex !== undefined && options.subtitleStreamIndex !== null) {
                    this.setSubtitleStreamIndex(options.subtitleStreamIndex);
                }
            };

            const onCanPlay = () => {
                video.removeEventListener('canplay', onCanPlay);
                video.removeEventListener('error', onError);

                if (options.autoPlay === false) {
                    log.info('Native path: Skipping initial play() due to autoPlay=false');
                    // Explicitly ensure paused since 'autoplay' attr was set to false
                    video.pause();
                    resolve();
                } else {
                    // Attempt unmuted playback.
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
        if (!audioTracks || audioTracks.length === 0) return;

        const outputIndex = audioTracks.length <= 1 ? 0 : listIndex;

        for (let i = 0; i < audioTracks.length; i++) {
            // Enable only the track at the requested list index
            audioTracks[i].enabled = (i === outputIndex);
        }
        log.info('Native: switched audio track to list index', listIndex, 'mapped to', outputIndex);
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
