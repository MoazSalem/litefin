/**
 * WebOSPlayer - LG WebOS Native Video Backend
 *
 * Uses the HTML5 <video> element with the WebOS native media pipeline for
 * hardware-accelerated playback on LG smart TVs. WebOS backs the standard
 * <video> element with its own media engine, giving us all the benefits of
 * native HLS/codec support without the complexity of the Luna service API.
 *
 * Key WebOS optimizations over stock HtmlVideoPlayer:
 *   - Native HLS via 'application/vnd.apple.mpegURL' source type (no Hls.js needed)
 *   - Hls.js used only as a fallback if native HLS detection fails
 *   - Playback rate clamped to values WebOS reliably supports (0.5, 1, 2, 4)
 *   - Fullscreen is always a no-op (WebOS TV apps run fullscreen by definition)
 *   - supportsNativeAudioTracks() returns true (WebOS audioTracks API is stable)
 *   - Buffer-aware stall recovery: only kicks forward when genuinely starved (< 5s
 *     of buffer ahead). Segment-boundary micro-stalls are allowed to self-recover
 *     silently, eliminating the user-visible choppiness caused by kicking during
 *     a full-buffer decoder hiccup.
 *
 * @module core/WebOSPlayer
 */

import Hls from 'hls.js';
import { MediaHelper } from './MediaHelper.js';
import { logger } from '../../utils/Logger.js';

const log = logger.create('WebOSPlayer');

// ============================================================================
// Constants
// ============================================================================

/** Minimum seek delta in ms before we actually call video.currentTime */
const SEEK_THRESHOLD_MS = 1000;

/**
 * Playback rates that WebOS reliably supports across known TV generations.
 * When the user requests a speed, we snap to the nearest safe rate.
 */
const WEBOS_SAFE_RATES = [0.5, 1, 2, 4];

// ============================================================================
// WebOSPlayer Class
// ============================================================================

export class WebOSPlayer {
    /**
     * @param {Object} options
     * @param {HTMLElement} options.container  - Container element for the video
     * @param {Object}      options.settings   - PlayerSettings instance
     * @param {Function}    options.onEvent    - Event callback: ({ type, data }) => void
     */
    constructor(options) {
        this.container = options.container;
        this.settings  = options.settings;
        this.onEvent   = options.onEvent || (() => {});

        // ====================================================================
        // Internal State
        // ====================================================================

        /** @type {HTMLVideoElement|null} */
        this._videoElement = null;

        /** @type {Hls|null} Hls.js instance — only created as fallback */
        this._hlsPlayer = null;

        /** Current stream URL */
        this._currentSrc = null;

        /** Options passed to the last play() call */
        this._currentPlayOptions = null;

        /** True after the first 'playing' event fires */
        this._started = false;

        /** True once the first timeupdate fires (payload > 0) */
        this._timeUpdated = false;

        // ---- Subtitle state ----
        this._currentSubtitleIndex = -1;
        this._subtitleOffset  = 0;
        this._previousOffset  = 0;

        // ---- Bound event handlers (stored so we can removeEventListener cleanly) ----
        this._boundHandlers = {};

        // ---- Timeupdate throttle —— only emit at ~250 ms intervals ----
        this._lastTimeUpdateTicks = 0;

        // ---- Stall recovery timer ----
        this._stallTimer = null;

        log.info('WebOSPlayer constructed');
    }

    // ========================================================================
    // Video Element Management
    // ========================================================================

    /**
     * Return the <video> element, creating it if it does not exist yet.
     * On subsequent calls the existing element is reused and events are
     * re-bound if they were removed during a previous stop().
     * @returns {HTMLVideoElement}
     */
    getVideoElement() {
        return this._ensureVideoElement();
    }

    /**
     * Create (or fetch) the <video> element and append it to the container.
     * @private
     * @returns {HTMLVideoElement}
     */
    _ensureVideoElement() {
        if (this._videoElement) {
            // Re-bind events if they were stripped in stop()
            if (Object.keys(this._boundHandlers).length === 0) {
                this._bindEvents(this._videoElement);
            }
            return this._videoElement;
        }

        // ------------------------------------------------------------------
        // Build the <video> element with the attributes WebOS needs.
        // We deliberately set playsinline so the OS doesn't hijack fullscreen.
        // ------------------------------------------------------------------
        const video = document.createElement('video');
        video.className = 'jellyfin-video-player';
        video.setAttribute('playsinline', 'true');
        video.setAttribute('webkit-playsinline', 'true');
        video.preload = 'metadata';
        video.volume = MediaHelper.getSavedVolume();

        // Ensure the container exists before we try to append
        if (!this.container) {
            this.container = document.createElement('div');
            this.container.className = 'jellyfin-player-container';
            document.body.appendChild(this.container);
        }

        this.container.appendChild(video);
        this._videoElement = video;

        this._bindEvents(video);

        return video;
    }

    /**
     * Attach all HTML5 media event listeners to the given video element.
     * We store references so _unbindEvents() can clean them up later.
     * @private
     * @param {HTMLVideoElement} video
     */
    _bindEvents(video) {
        const handlers = {
            timeupdate:    this._onTimeUpdate.bind(this),
            ended:         this._onEnded.bind(this),
            error:         this._onError.bind(this),
            pause:         this._onPause.bind(this),
            play:          this._onPlay.bind(this),
            playing:       this._onPlaying.bind(this),
            waiting:       this._onWaiting.bind(this),
            stalled:       this._onStalled.bind(this),
            seeking:       this._onSeeking.bind(this),
            seeked:        this._onSeeked.bind(this),
            volumechange:  this._onVolumeChange.bind(this),
            loadedmetadata: this._onLoadedMetadata.bind(this),
            // 'progress' = buffered range updates — useful for stall detection
            progress:      this._onProgress.bind(this)
        };

        for (const [event, handler] of Object.entries(handlers)) {
            video.addEventListener(event, handler);
            this._boundHandlers[event] = handler;
        }
    }

    /**
     * Remove all previously bound event listeners from the video element.
     * @private
     * @param {HTMLVideoElement} video
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
     * Start playback of a new stream.
     *
     * Decision tree for HLS streams:
     *   1. Try native HLS (WebOS backs <video> with hardware decode).
     *   2. Fall back to Hls.js if native is not available (dev browser, emulator).
     *
     * @param {Object} options - Play options forwarded by JellyfinPlayer
     * @param {string}  options.url                      - Stream URL
     * @param {boolean} [options.isHls]                  - True when URL is an HLS manifest
     * @param {number}  [options.playerStartPositionTicks] - Seek target in ticks
     * @param {number}  [options.audioStreamIndex]
     * @param {number}  [options.subtitleStreamIndex]
     * @param {Object}  [options.mediaSource]
     * @param {string}  [options.playMethod]              - 'DirectPlay', 'Transcode', etc.
     * @returns {Promise<void>}
     */
    async play(options) {
        log.info('WebOSPlayer: Starting playback', options.url);

        this._currentPlayOptions = options;
        this._started    = false;
        this._timeUpdated = false;
        this._subtitleOffset = 0;
        this._previousOffset = 0;

        const video = this._ensureVideoElement();

        // Tear down any active Hls.js session before starting fresh
        this._destroyHlsPlayer();

        const isHlsStream = options.isHls || (options.url && options.url.includes('.m3u8'));

        if (isHlsStream && this._shouldUseNativeHls()) {
            /* ----------------------------------------------------------------
             * Path A: Native HLS
             * WebOS's media engine handles HLS natively — just point the src
             * at the manifest. Using the source element with a type hint
             * ensures the OS routes it through the hardware decoder.
             * ---------------------------------------------------------------- */
            log.info('WebOSPlayer: Using native HLS pipeline');
            await this._playNativeHls(video, options);

        } else if (isHlsStream && Hls.isSupported()) {
            /* ----------------------------------------------------------------
             * Path B: Hls.js fallback
             * Only used on dev browsers / WebOS emulators where native HLS
             * is not available. Production hardware should always take Path A.
             * ---------------------------------------------------------------- */
            log.info('WebOSPlayer: Native HLS not available — using Hls.js fallback');
            await this._playWithHlsJs(video, options);

        } else {
            /* ----------------------------------------------------------------
             * Path C: Direct MP4/MKV/etc. — assign src directly
             * ---------------------------------------------------------------- */
            log.info('WebOSPlayer: Using native direct-play (non-HLS)');
            await this._playNativeDirect(video, options);
        }

        this._currentSrc = options.url;
    }

    /**
     * Detect whether the current environment supports native HLS.
     * On WebOS hardware this is always true. On a dev browser it may not be.
     * @private
     * @returns {boolean}
     */
    _shouldUseNativeHls() {
        const video = document.createElement('video');
        const nativeHls = !!(
            video.canPlayType('application/x-mpegURL').replace(/no/, '') ||
            video.canPlayType('application/vnd.apple.mpegURL').replace(/no/, '')
        );
        log.debug('Native HLS support:', nativeHls);
        return nativeHls;
    }

    /**
     * Start HLS playback using the browser/WebOS native media engine.
     * We assign the stream URL as the <video> src, letting WebOS route
     * it through its hardware HLS pipeline automatically.
     * @private
     */
    async _playNativeHls(video, options) {
        // Clear any stale source first
        video.removeAttribute('src');
        video.load();

        // Use a <source> element with the MIME type hint so WebOS picks the
        // right codec path — without it, some versions skip the native HLS path.
        while (video.firstChild) {
            video.removeChild(video.firstChild);
        }
        const source = document.createElement('source');
        source.src  = options.url;
        source.type = 'application/vnd.apple.mpegURL';
        video.appendChild(source);

        video.load();

        return new Promise((resolve, reject) => {
            /**
             * Wait for 'canplay' before calling video.play() so we don't
             * trigger an Autoplay Policy error before the manifest is parsed.
             */
            const onCanPlay = () => {
                video.removeEventListener('canplay', onCanPlay);
                video.removeEventListener('error', onLoadError);

                // Attempt tracks after metadata is loaded
                this._applyInitialTracks(options);

                video.play()
                    .then(() => {
                        this._applyRobustResume(video, options.playerStartPositionTicks);
                        resolve();
                    })
                    .catch(err => this._handleAutoplayError(err, video, options, resolve, reject));
            };

            const onLoadError = () => {
                video.removeEventListener('canplay', onCanPlay);
                const err = video.error;
                log.error('WebOSPlayer: Native HLS source load error', err);
                reject(err || new Error('Native HLS load failed'));
            };

            video.addEventListener('canplay', onCanPlay);
            video.addEventListener('error', onLoadError);
        });
    }

    /**
     * Start non-HLS (MP4, MKV, etc.) playback via direct src assignment.
     * Uses <source> element with type hints for better WebOS hardware decoder steering.
     * @private
     */
    async _playNativeDirect(video, options) {
        // Clear any stale source
        video.removeAttribute('src');
        while (video.firstChild) {
            video.removeChild(video.firstChild);
        }

        // Assign directly to video.src. WebOS hardware media pipeline will
        // probe the container automatically. Using <source> elements with
        // MIME types like 'video/x-matroska' causes the Chromium layer to
        // silently reject the source before the media pipeline sees it.
        video.src = options.url;
        video.autoplay = true;

        video.load();

        return new Promise((resolve, reject) => {
            const onLoadedMetadata = () => {
                video.removeEventListener('loadedmetadata', onLoadedMetadata);
                this._applyInitialTracks(options);
            };

            const onCanPlay = () => {
                video.removeEventListener('canplay', onCanPlay);
                video.removeEventListener('error', onError);

                if (options.playerStartPositionTicks) {
                    // Pre-seek logic disabled here; robust resume will handle it
                }

                video.play()
                    .then(() => {
                        this._applyRobustResume(video, options.playerStartPositionTicks);
                        resolve();
                    })
                    .catch(err => this._handleAutoplayError(err, video, options, resolve, reject));
            };

            const onError = () => {
                video.removeEventListener('canplay', onCanPlay);
                video.removeEventListener('loadedmetadata', onLoadedMetadata);
                reject(video.error || new Error('Direct playback load failed'));
            };

            video.addEventListener('loadedmetadata', onLoadedMetadata);
            video.addEventListener('canplay', onCanPlay);
            video.addEventListener('error', onError);
        });
    }

    /**
     * Hls.js path — only used when native HLS is unavailable (emulator / browser).
     * @private
     */
    _playWithHlsJs(video, options) {
        return new Promise((resolve, reject) => {
            log.info('WebOSPlayer: Hls.js loading', options.url);

            const hls = new Hls({
                startPosition:         (options.playerStartPositionTicks || 0) / 10000000,
                maxBufferLength:       60,
                maxMaxBufferLength:    120,
                manifestLoadingTimeOut: 20000,
                levelLoadingTimeOut:    20000,
                fragLoadingTimeOut:     20000,
                maxBufferSize:          60 * 1000 * 1000, // 60 MB
                enableWorker:           true
            });

            hls.on(Hls.Events.MANIFEST_PARSED, () => {
                log.info('WebOSPlayer: Hls.js manifest parsed');
                this._applyInitialTracks(options, hls);
                video.play()
                    .then(resolve)
                    .catch(err => this._handleAutoplayError(err, video, options, resolve, reject));
            });

            if (options.playerStartPositionTicks) {
                hls.once(Hls.Events.LEVEL_LOADED, () => {
                    this._applyRobustResume(video, options.playerStartPositionTicks);
                });
            }

            hls.on(Hls.Events.ERROR, (event, data) => {
                // Swallow non-fatal buffer stalls — they typically self-recover
                if (data.details === 'bufferStalledError' && !data.fatal) {
                    log.warn('WebOSPlayer: Hls.js non-fatal buffer stall');
                    return;
                }
                log.error('WebOSPlayer: Hls.js error', data);

                if (data.fatal) {
                    switch (data.type) {
                        case Hls.ErrorTypes.NETWORK_ERROR:
                            log.info('WebOSPlayer: Attempting Hls.js network error recovery');
                            hls.startLoad();
                            break;
                        case Hls.ErrorTypes.MEDIA_ERROR:
                            log.info('WebOSPlayer: Attempting Hls.js media error recovery');
                            hls.recoverMediaError();
                            break;
                        default:
                            hls.destroy();
                            reject(new Error('Hls.js fatal error'));
                            break;
                    }
                }
            });

            hls.loadSource(options.url);
            hls.attachMedia(video);
            this._hlsPlayer = hls;
        });
    }

    /**
     * Apply the initial audio/subtitle tracks from play options.
     * Called after metadata is loaded and the player is ready to accept track switching.
     *
     * @param {Object} options  - Play options
     * @param {Hls}    [hls]    - Hls.js instance if active
     * @private
     */
    _applyInitialTracks(options, hls) {
        // ---- Audio track ----
        if (options.audioStreamIndex !== undefined && options.audioStreamIndex !== null) {
            if (hls) {
                // Hls.js uses 0-based audioTrack index
                if (options.audioStreamIndex < hls.audioTracks.length) {
                    hls.audioTrack = options.audioStreamIndex;
                    log.debug('WebOSPlayer: Hls.js audio track set to', options.audioStreamIndex);
                }
            } else {
                // Native: toggle HTML5 AudioTrack objects
                this.setAudioStreamIndex(options.audioStreamIndex);
            }
        }

        // ---- Subtitle track ----
        // Native text track selection — SubtitleManager will override this
        // for external/ASS/PGS tracks. We just handle embedded VTT here.
        if (options.subtitleStreamIndex !== undefined) {
            if (hls && options.subtitleStreamIndex >= 0) {
                if (options.subtitleStreamIndex < hls.subtitleTracks.length) {
                    hls.subtitleTrack = options.subtitleStreamIndex;
                }
            }
            // For native, JellyfinPlayer handles this via SubtitleManager
        }
    }

    /**
     * Handle autoplay policy rejections — mute the video and retry,
     * then schedule an unmute once the user physically interacts with the TV.
     * @private
     */
    _handleAutoplayError(err, video, options, resolve, reject) {
        if (err.name === 'NotAllowedError') {
            log.warn('WebOSPlayer: Autoplay blocked — retrying muted (remote launch)');
            video.muted = true;
            video.play()
                .then(() => {
                    this._applyRobustResume(video, options.playerStartPositionTicks);
                    this._scheduleUnmuteOnInteraction(video);
                    resolve();
                })
                .catch(reject);
        } else {
            reject(err);
        }
    }

    /**
     * Apply a verified seek using a retry loop.
     * WebOS 4 often discards `currentTime` changes made during early buffering,
     * causing playbacks to snap back to 0. This method waits for the video
     * to be seekable, attempts the seek, and then re-applies it if the video
     * snaps back when 'playing' fires.
     * @private
     * @param {HTMLVideoElement} video
     * @param {number} ticks - Jellyfin position ticks
     */
    _applyRobustResume(video, ticks) {
        if (!ticks) return;
        const resumeSeconds = ticks / 10000000;

        if (resumeSeconds < 5) return;

        // Safety guard: do not seek beyond the end
        if (MediaHelper.isValidDuration(video.duration) && resumeSeconds > video.duration - 10) {
            log.warn('WebOSPlayer: Resume position near end of video, ignoring', resumeSeconds);
            return;
        }

        log.info('WebOSPlayer: Applying robust resume to', resumeSeconds, 's');

        const seekWithRetry = (time, attempts = 5) => {
            let tries = 0;
            const attempt = () => {
                tries++;
                try {
                    video.currentTime = time;
                } catch (e) {}

                setTimeout(() => {
                    if (Math.abs(video.currentTime - time) < 2) {
                        log.debug('WebOSPlayer: Seek successful on attempt', tries);
                    } else if (tries < attempts) {
                        log.debug('WebOSPlayer: Retrying seek... attempt', tries + 1);
                        attempt();
                    } else {
                        log.warn('WebOSPlayer: Seek failed after', attempts, 'retries');
                    }
                }, 500);
            };
            attempt();
        };

        const tryApply = () => {
            // readyState 3 (HAVE_FUTURE_DATA) or 4 (HAVE_ENOUGH_DATA) + seekable ranges
            if (video.readyState >= 3 && video.seekable.length > 0) {
                seekWithRetry(resumeSeconds);
            } else {
                setTimeout(tryApply, 300);
            }
        };

        tryApply();

        const onPlaying = () => {
            if (Math.abs(video.currentTime - resumeSeconds) > 5) {
                log.info('WebOSPlayer: Detected snap-back, re-applying seek');
                seekWithRetry(resumeSeconds);
            }
        };
        video.addEventListener('playing', onPlaying, { once: true });
    }

    /**
     * Schedule unmute when the user first presses a remote button or clicks.
     * WebOS autoplay policy lifts the moment any real user interaction occurs.
     * @private
     * @param {HTMLVideoElement} video
     */
    _scheduleUnmuteOnInteraction(video) {
        const unmute = () => {
            if (video.muted) {
                log.info('WebOSPlayer: User interaction detected — unmuting');
                video.muted = false;
            }
            document.removeEventListener('keydown', unmute, true);
            document.removeEventListener('click',   unmute, true);
        };
        document.addEventListener('keydown', unmute, { capture: true, once: true });
        document.addEventListener('click',   unmute, { capture: true, once: true });
        log.info('WebOSPlayer: Unmute scheduled on next user interaction');
    }

    /**
     * Pause playback.
     */
    pause() {
        this._videoElement?.pause();
    }

    /**
     * Resume playback.
     */
    unpause() {
        if (!this._videoElement) return;
        this._videoElement.play().catch(err => {
            if (err.name === 'NotAllowedError') {
                log.warn('WebOSPlayer: unpause blocked — retrying muted');
                this._videoElement.muted = true;
                this._videoElement.play().catch(e => log.error('WebOSPlayer: muted retry failed', e));
            } else {
                log.error('WebOSPlayer: unpause failed', err);
            }
        });
    }

    /**
     * Stop playback and clean up the current session.
     * The <video> element itself is kept alive for the next play() call;
     * only the source and event bindings are reset.
     * @returns {Promise<void>}
     */
    async stop() {
        this._clearStallCheck();
        this._destroyHlsPlayer();

        const video = this._videoElement;
        if (video) {
            // Remove events BEFORE clearing src to stop spurious error events
            this._unbindEvents(video);
            video.pause();
            video.removeAttribute('src');
            // Remove any <source> children created for native HLS path
            while (video.firstChild) {
                video.removeChild(video.firstChild);
            }
            video.load();
        }

        this._currentSrc         = null;
        this._currentPlayOptions = null;
        this._started            = false;
        this._timeUpdated        = false;
    }

    /**
     * Seek to an absolute position expressed in ticks (100 ns units).
     * Accounts for the transcoding time offset so the displayed position
     * matches what the UI expects.
     *
     * @param {number} positionTicks
     */
    seek(positionTicks) {
        const video = this._videoElement;
        if (!video) return;

        let seconds = positionTicks / 10000000;

        // Subtract the transcoding offset so the seek lands at the right place
        // in the server-generated HLS segment (which starts at its own 0).
        if (this._currentPlayOptions?.transcodingOffsetTicks) {
            seconds = (positionTicks - this._currentPlayOptions.transcodingOffsetTicks) / 10000000;
        }

        // Skip tiny seeks — avoids decoder stutter on redundant calls
        if (Math.abs(video.currentTime - seconds) > SEEK_THRESHOLD_MS / 1000) {
            video.currentTime = Math.max(0, seconds);
        }

        // Emit a synthetic timeupdate immediately so paused-state UI refreshes
        this.onEvent({ type: 'timeupdate', data: { time: Math.max(0, seconds) } });
    }

    // ========================================================================
    // Volume Control
    // ========================================================================

    /**
     * @param {number} volume - 0–100
     */
    setVolume(volume) {
        if (this._videoElement) {
            const normalized = Math.max(0, Math.min(100, volume)) / 100;
            this._videoElement.volume = normalized;
            MediaHelper.saveVolume(normalized);
        }
    }

    /** @returns {number} 0–100 */
    getVolume() {
        return (this._videoElement?.volume ?? 1) * 100;
    }

    /**
     * Toggle mute on the underlying <video> element.
     */
    toggleMute() {
        if (this._videoElement) {
            this._videoElement.muted = !this._videoElement.muted;
        }
    }

    /**
     * Set mute state explicitly.
     * Guard against Chrome-style autoplay policy pausing the video when
     * we try to un-mute — resume muted if that happens.
     * @param {boolean} muted
     */
    setMuted(muted) {
        if (!this._videoElement) return;
        try {
            this._videoElement.muted = muted;
        } catch (e) {
            log.warn('WebOSPlayer: setMuted threw:', e);
        }

        // If unmute got blocked and the browser paused the video as a side effect
        if (!muted && this._videoElement.paused && this._videoElement.muted) {
            log.warn('WebOSPlayer: Unmute blocked — resuming muted to keep playback going');
            this._videoElement.play().catch(() => {});
        }
    }

    /** @returns {boolean} */
    isMuted() {
        return this._videoElement?.muted ?? false;
    }

    // ========================================================================
    // Track Selection
    // ========================================================================

    /**
     * Switch the audio track by 0-based list index.
     *
     * For HLS streams Hls.js owns track switching. For native streams
     * we toggle the HTML5 AudioTrack objects (supported and stable on WebOS).
     *
     * @param {number} listIndex - 0-based index into the audio track list
     */
    setAudioStreamIndex(listIndex) {
        // ---- Hls.js path ----
        if (this._hlsPlayer) {
            const tracks = this._hlsPlayer.audioTracks;
            if (tracks && listIndex >= 0 && listIndex < tracks.length) {
                log.info('WebOSPlayer: Hls.js audio track →', listIndex, tracks[listIndex]?.name);
                this._hlsPlayer.audioTrack = listIndex;
            } else {
                log.warn('WebOSPlayer: Hls.js audio index', listIndex, 'out of range (', tracks?.length, ')');
            }
            return;
        }

        // ---- Native HTML5 AudioTrack path ----
        const video = this._videoElement;
        if (!video) return;

        const audioTracks = video.audioTracks;
        if (!audioTracks || audioTracks.length < 2) {
            log.debug('WebOSPlayer: Native audioTracks not available or single-track');
            return;
        }

        for (let i = 0; i < audioTracks.length; i++) {
            audioTracks[i].enabled = (i === listIndex);
        }
        log.info('WebOSPlayer: Native audio track → list index', listIndex);
    }

    /**
     * Enable or disable a subtitle track.
     *
     * For native VTT tracks embedded in the HLS manifest, toggle via textTracks.
     * For external/ASS/PGS tracks, SubtitleManager handles rendering and will
     * call this with index=-1 to disable native tracks (avoid double rendering).
     *
     * @param {number} index - Stream index, or -1 to disable all
     */
    setSubtitleStreamIndex(index) {
        const video = this._videoElement;
        if (!video) return;

        this._currentSubtitleIndex = index;

        // Reset any previously applied offset state
        this._subtitleOffset = 0;
        this._previousOffset = 0;

        // Toggle native text tracks
        const textTracks = video.textTracks;
        if (textTracks) {
            for (let i = 0; i < textTracks.length; i++) {
                textTracks[i].mode = (i === index) ? 'showing' : 'hidden';
            }
        }
    }

    /**
     * Check if this backend can natively switch audio tracks without restart.
     * WebOS's audioTracks API is stable across all supported TV generations.
     * @returns {boolean}
     */
    supportsNativeAudioTracks() {
        // WebOS reliably supports the HTML5 audioTracks API — no need for
        // the Tizen version check we do in HtmlVideoPlayer.
        return true;
    }

    // ========================================================================
    // Subtitle Offset
    // ========================================================================

    /**
     * Shift native VTT cue timing by a positive or negative offset (seconds).
     * Uses a delta approach — only the difference from the last applied offset
     * is added, preventing compound drift across multiple calls.
     *
     * @param {number} seconds - New absolute offset in seconds
     */
    setSubtitleOffset(seconds) {
        this._subtitleOffset = seconds;

        const video = this._videoElement;
        if (!video || !video.textTracks) {
            log.debug('WebOSPlayer: Subtitle offset stored:', seconds, 's (no video/tracks)');
            return;
        }

        const delta = seconds - this._previousOffset;
        if (delta === 0) return;

        for (let i = 0; i < video.textTracks.length; i++) {
            const track = video.textTracks[i];
            if (track.mode !== 'showing' || !track.cues) continue;
            for (let j = 0; j < track.cues.length; j++) {
                const cue = track.cues[j];
                cue.startTime += delta;
                cue.endTime   += delta;
            }
        }

        this._previousOffset = seconds;
        log.debug('WebOSPlayer: Subtitle offset applied:', seconds, 's (delta:', delta, 's)');
    }

    // ========================================================================
    // Playback Speed
    // ========================================================================

    /**
     * Set the playback rate.
     *
     * WebOS hardware only reliably supports a subset of speeds. We snap to the
     * nearest safe value in WEBOS_SAFE_RATES to prevent silent no-ops or
     * decoder stalls on obscure speeds like 1.5 or 3.
     *
     * @param {number} speed
     */
    setSpeed(speed) {
        if (!this._videoElement) return;

        // Find the closest supported rate to the requested value
        const safeRate = WEBOS_SAFE_RATES.reduce((prev, curr) => {
            return Math.abs(curr - speed) < Math.abs(prev - speed) ? curr : prev;
        });

        if (safeRate !== speed) {
            log.info('WebOSPlayer: Speed', speed, '→ snapped to safe rate', safeRate);
        }

        this._videoElement.playbackRate = safeRate;
    }

    // ========================================================================
    // Aspect Ratio
    // ========================================================================

    /**
     * Set the video's CSS object-fit to simulate aspect ratio modes.
     * @param {'auto'|'zoom'|'stretch'} mode
     */
    setAspectRatio(mode) {
        if (!this._videoElement) return;

        const fitMap = {
            zoom:    'cover',
            stretch: 'fill',
            auto:    'contain'
        };

        const objectFit = fitMap[mode] || 'contain';
        log.info('WebOSPlayer: Aspect ratio', mode, '→', objectFit);
        this._videoElement.style.objectFit = objectFit;
    }

    // ========================================================================
    // Fullscreen
    // ========================================================================

    /**
     * No-op on WebOS — TV apps are always fullscreen.
     */
    toggleFullscreen() {
        // WebOS TV apps always run fullscreen — nothing to do here
    }

    /** @returns {boolean} Always true on WebOS */
    isFullscreen() {
        return true;
    }

    // ========================================================================
    // State Getters
    // ========================================================================

    /** @returns {number} Current playback position in seconds */
    getCurrentTime() {
        return this._videoElement?.currentTime ?? 0;
    }

    /** @returns {number} Total duration in seconds */
    getDuration() {
        return this._videoElement?.duration ?? 0;
    }

    /**
     * The seek-to start position that was requested in the last play() call.
     * Used by JellyfinPlayer for transcoding offset calculations.
     * @returns {number}
     */
    getStartPositionTicks() {
        return this._currentPlayOptions?.playerStartPositionTicks || 0;
    }

    /** @returns {boolean} */
    isPaused() {
        return this._videoElement?.paused ?? true;
    }

    // ========================================================================
    // HTML5 Event Handlers → onEvent Callbacks
    // ========================================================================

    /** @private */
    _onTimeUpdate() {
        if (!this._timeUpdated && this._videoElement?.currentTime) {
            this._timeUpdated = true;
        }

        const currentTime  = this.getCurrentTime();
        const currentTicks = Math.floor(currentTime * 10000000);

        // Throttle to ~250 ms to avoid hammering the main thread on slow TVs
        if (Math.abs(currentTicks - this._lastTimeUpdateTicks) > 2500000) {
            this._lastTimeUpdateTicks = currentTicks;
            this.onEvent({ type: 'timeupdate', data: { time: currentTime } });
        }
    }

    /**
     * Returns the number of seconds of data buffered ahead of the current playhead.
     *
     * We deliberately iterate buffered ranges to find the one CONTAINING the
     * playhead rather than taking buffered.end(last). The naive approach reports
     * the very last downloaded segment's end — which can be 40+ s ahead — even
     * when there is a zero-byte gap sitting 2 s in front of the playhead. That gap
     * is what actually causes a decoder stall. This version returns 0 in that case,
     * making the root cause immediately visible in logs and recovery decisions.
     *
     * @private
     * @returns {number} Seconds of continue data ahead of currentTime, or 0 if gapped/empty.
     */
    _getBufferAhead() {
        const video = this._videoElement;
        if (!video || !video.buffered) return 0;
        const ct = video.currentTime;
        try {
            for (let i = 0; i < video.buffered.length; i++) {
                // Find the range that contains our current playhead
                if (video.buffered.start(i) <= ct && ct < video.buffered.end(i)) {
                    return Math.max(0, video.buffered.end(i) - ct);
                }
            }
        } catch (e) {
            // Benign — buffered may be momentarily empty between segments
        }
        return 0;
    }

    /**
     * Track progress events to log buffer state. Uses _getBufferAhead() for
     * accurate gap-aware reporting.
     * @private
     */
    _onProgress() {
        const video = this._videoElement;
        if (!video || !video.buffered || video.buffered.length === 0) return;
        log.debug('WebOSPlayer: Buffer ahead', this._getBufferAhead().toFixed(1), 's');
    }

    /** @private */
    _onEnded() {
        log.info('WebOSPlayer: Playback ended');
        this.onEvent({ type: 'ended' });
    }

    /** @private */
    _onError(e) {
        const video = e.target;

        // Ignore stale error events fired during stop/cleanup (no src set)
        if (!video.src && !this._hlsPlayer) {
            log.debug('WebOSPlayer: Ignoring error on empty source during cleanup');
            return;
        }

        const errorCode    = video.error?.code    || 0;
        const errorMessage = video.error?.message || 'Unknown error';
        log.error('WebOSPlayer: Error', errorCode, errorMessage);

        // Attempt Hls.js media error recovery before giving up
        if (errorCode === 3 && this._hlsPlayer) {
            log.info('WebOSPlayer: Attempting Hls.js media error recovery');
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
            log.info('WebOSPlayer: Playback started');
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
        log.warn('WebOSPlayer: Playback stalled');
        this.onEvent({ type: 'waiting' });
        this._startStallCheck();
    }

    /** @private */
    _onSeeking() {
        const video = this._videoElement;
        // Only emit 'waiting' if we're seeking while playing (not paused-seeking)
        if (video && !video.paused) {
            this.onEvent({ type: 'waiting' });
        }
    }

    /** @private */
    _onSeeked() {
        const video = this._videoElement;
        if (video && !video.paused) {
            this._onPlaying();
        }
        this._clearStallCheck();
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
        log.debug('WebOSPlayer: Metadata loaded, duration:', this.getDuration());
        this.onEvent({ type: 'loadedmetadata', data: { duration: this.getDuration() } });
    }

    // ========================================================================
    // Stall Recovery
    // ========================================================================

    /**
     * Start a 2.5-second timer that fires a recovery kick ONLY if the buffer
     * is genuinely starved (< 5 s ahead) when it expires.
     *
     * WHY THE BUFFER GATE:
     *   The WebOS native HLS player fires a 'waiting' or 'stalled' event at
     *   every MPEG-TS segment boundary while the decoder pipeline is transitioning
     *   to the next IDR frame — even when 28+ seconds of data are already buffered.
     *   Before this change, we kicked the playhead +0.5 s unconditionally, which:
     *     1. Skipped visible content (audible/visual jump every 6-7 s on DV content).
     *     2. Invalidated the pre-buffered window (dropping from 28 s → 7 s).
     *     3. Immediately re-triggered another 'waiting' event → another stall check
     *        → infinite choppiness loop.
     *
     *   With the gate, we let the native decoder self-recover at segment
     *   boundaries (it always does, in < 500 ms). The kick is reserved for genuine
     *   buffer underruns (network drop, server-side transcode lag) where < 5 s
     *   of data remain and a larger skip is the only way to resume cleanly.
     *
     * KICK MAGNITUDE (kept at 0.5 s):
     *   A 10 ms nudge often lands inside the same decoded frame and is silently
     *   ignored by the WebOS native media engine on high-bitrate HEVC streams.
     *   A 500 ms nudge crosses at least one HLS segment boundary, forcing a
     *   clean IDR re-init — which is what actually clears a genuine underrun.
     *
     * @private
     */
    _startStallCheck() {
        this._clearStallCheck();
        this._stallTimer = setTimeout(() => {
            if (!this._videoElement || this._videoElement.paused || !this._started) return;

            const bufferAhead = this._getBufferAhead();

            // ----------------------------------------------------------------
            // Buffer gate: if the pipeline has plenty of data, this is a
            // decoder micro-stall at a segment boundary — not a real underrun.
            // The native engine will self-recover; kicking forward would skip
            // content and restart the choppiness cycle. Just bail.
            // ----------------------------------------------------------------
            if (bufferAhead > 5) {
                log.debug(
                    'WebOSPlayer: Stall timer fired with',
                    bufferAhead.toFixed(1),
                    's buffered — segment-boundary micro-stall, letting decoder self-recover'
                );
                return;
            }

            // Genuine underrun — kick forward half a second to force the
            // pipeline to seek to the next clean IDR frame.
            log.warn(
                'WebOSPlayer: Still stalled after 2.5s (buffer:',
                bufferAhead.toFixed(1),
                's) — recovery kick (+0.5s)'
            );
            try {
                this._videoElement.currentTime += 0.5;
            } catch (e) {
                log.error('WebOSPlayer: Recovery kick failed', e);
            }
        }, 2500);
    }

    /** @private */
    _clearStallCheck() {
        if (this._stallTimer) {
            clearTimeout(this._stallTimer);
            this._stallTimer = null;
        }
    }

    // ========================================================================
    // Cleanup
    // ========================================================================

    /**
     * Destroy the Hls.js instance cleanly.
     * @private
     */
    _destroyHlsPlayer() {
        if (this._hlsPlayer) {
            try {
                this._hlsPlayer.destroy();
            } catch (e) {
                log.error('WebOSPlayer: Error destroying Hls.js player', e);
            }
            this._hlsPlayer = null;
        }
    }

    /**
     * Full cleanup — stop playback, destroy Hls.js, remove the <video> element
     * from the DOM, and null out all state.
     */
    destroy() {
        this.stop();
        this._destroyHlsPlayer();

        if (this._videoElement) {
            this._unbindEvents(this._videoElement);
            if (this._videoElement.parentNode) {
                this._videoElement.parentNode.removeChild(this._videoElement);
            }
            this._videoElement = null;
        }
    }
}
