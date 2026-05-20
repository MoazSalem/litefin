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
import { PlayerSettings } from '../../utils/PlayerSettings.js';

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

        // ---- Robust resume state ----
        this._robustSeekTarget   = null;
        this._robustSeekPending  = false;
        this._cancelRobustResume = false;

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

        // Initialize robust seek state immediately to avoid race conditions with early 'playing' events.
        // Do not attempt robust resume for live TV/streams.
        const isLive = options.item?.Type === 'TvChannel' || options.mediaSource?.LiveStreamId;
        this._robustSeekTarget = isLive ? null : (options.playerStartPositionTicks || 0) / 10000000;
        this._robustSeekPending = false;
        this._cancelRobustResume = false;

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

                const playPromise = video.play();
                if (playPromise !== undefined && typeof playPromise.then === 'function') {
                    playPromise
                        .then(() => {
                            this._applyRobustResume(video, options.playerStartPositionTicks);
                            resolve();
                        })
                        .catch(err => this._handleAutoplayError(err, video, options, resolve, reject));
                } else {
                    // Older browsers (Chrome < 50) don't return a Promise from play()
                    this._applyRobustResume(video, options.playerStartPositionTicks);
                    resolve();
                }
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

        video.load();

        return new Promise((resolve, reject) => {
            const onCanPlay = () => {
                video.removeEventListener('canplay', onCanPlay);
                video.removeEventListener('error', onError);

                // Apply audio/subtitle tracks at canplay — same timing as _playNativeHls.
                // audioTracks is not reliably populated at loadedmetadata on WebOS native
                // player, so doing it here (before play()) ensures the array is ready.
                this._applyInitialTracks(options);

                const playPromise = video.play();
                if (playPromise !== undefined && typeof playPromise.then === 'function') {
                    playPromise
                        .then(() => {
                            this._applyRobustResume(video, options.playerStartPositionTicks);
                            resolve();
                        })
                        .catch(err => this._handleAutoplayError(err, video, options, resolve, reject));
                } else {
                    this._applyRobustResume(video, options.playerStartPositionTicks);
                    resolve();
                }
            };

            const onError = () => {
                video.removeEventListener('canplay', onCanPlay);
                reject(video.error || new Error('Direct playback load failed'));
            };

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
                const playPromise = video.play();
                if (playPromise !== undefined && typeof playPromise.then === 'function') {
                    playPromise
                        .then(resolve)
                        .catch(err => this._handleAutoplayError(err, video, options, resolve, reject));
                } else {
                    resolve();
                }
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
            // Convert Jellyfin stream index (e.g. 1) to 0-based audio-only list index (e.g. 0)
            // so it maps correctly onto hls.audioTracks / video.audioTracks arrays.
            const audioStreams = (options.mediaSource?.MediaStreams || []).filter(s => s.Type === 'Audio');
            const listIndex = audioStreams.findIndex(s => s.Index === options.audioStreamIndex);
            const resolvedIndex = listIndex >= 0 ? listIndex : 0;

            if (hls) {
                // Single-track = Transcode/DirectStream (server picked one); multi-track = Remux/DirectPlay.
                const outputIndex = hls.audioTracks.length <= 1 ? 0 : resolvedIndex;
                if (outputIndex < hls.audioTracks.length) {
                    hls.audioTrack = outputIndex;
                    log.debug('WebOSPlayer: Hls.js audio track set to', outputIndex);
                }
            } else {
                const nativeTracks = this._videoElement?.audioTracks;
                const outputIndex = (!nativeTracks || nativeTracks.length <= 1) ? 0 : resolvedIndex;
                this.setAudioStreamIndex(outputIndex);
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
        if (this._robustSeekTarget === null || this._robustSeekTarget === undefined) return;

        const resumeSeconds = this._robustSeekTarget;

        // Safety guard: do not seek beyond the end
        if (MediaHelper.isValidDuration(video.duration) && resumeSeconds > video.duration - 10) {
            log.warn('WebOSPlayer: Resume position near end of video, ignoring', resumeSeconds);
            this._robustSeekTarget = null;
            return;
        }

        const tryApply = () => {
            if (this._cancelRobustResume || this._robustSeekTarget === null) return;

            // Only apply proactively if we're actually resuming from significantly past 0
            if (resumeSeconds >= 5) {
                // readyState 3 (HAVE_FUTURE_DATA) or 4 (HAVE_ENOUGH_DATA) + seekable ranges
                if (video.readyState >= 3 && video.seekable.length > 0) {
                    this._seekWithRetry(resumeSeconds);
                } else {
                    setTimeout(tryApply, 300);
                }
            }
        };

        tryApply();
    }

    _seekWithRetry(time, attempts = 5) {
        this._robustSeekPending = true;
        let tries = 0;
        const video = this._videoElement;

        log.info('WebOSPlayer: Applying robust resume seek to', time, 's');

        const attempt = () => {
            if (this._cancelRobustResume) {
                this._robustSeekPending = false;
                this._robustSeekTarget = null;
                log.info('WebOSPlayer: Robust resume cancelled by manual seek or stop');
                return;
            }
            tries++;
            try {
                video.currentTime = time;
            } catch (e) {}

            setTimeout(() => {
                if (this._cancelRobustResume) return;

                if (Math.abs(video.currentTime - time) < 2) {
                    log.debug('WebOSPlayer: Seek successful on attempt', tries);
                    this._robustSeekPending = false;
                    this._robustSeekTarget = null;
                    if (!video.paused) this._onPlaying();
                } else if (tries < attempts) {
                    log.debug('WebOSPlayer: Retrying seek... attempt', tries + 1);
                    attempt();
                } else {
                    log.warn('WebOSPlayer: Seek failed after', attempts, 'retries');
                    this._robustSeekPending = false;
                    this._robustSeekTarget = null;
                    if (!video.paused) this._onPlaying();
                }
            }, 500);
        };
        attempt();
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
        this._cancelRobustResume = true;
        this._robustSeekTarget   = null;
        this._robustSeekPending  = false;
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

            // ── WebOS Chromium GPU surface release ───────────────────────────
            //
            // WebOS uses the same embedded Chromium compositor as Tizen's HTML
            // backend. A <video> element remaining in the DOM after src is cleared
            // still holds its decoded frame buffer as a GPU texture. For 4K content
            // this can be 20–80MB of VRAM that the compositor cannot reclaim,
            // resulting in GPU memory fragmentation that shows up as glitching UI
            // (flickering icons, white flashes) on the next page.
            //
            // Temporarily removing the element from the DOM signals the compositor
            // to release the GPU surface. We immediately re-insert it so that
            // _ensureVideoElement() can reuse the same DOM node on the next play().
            //
            if (video.parentNode) {
                const parent = video.parentNode;
                parent.removeChild(video);
                parent.appendChild(video);
                log.debug('stop(): video element cycled out/in DOM to flush GPU surface');
            }
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

        // Cancel any pending retry loops from previous seeks
        this._cancelRobustResume = true;
        this._robustSeekPending = false;

        let seconds = positionTicks / 10000000;

        // Subtract the transcoding offset so the seek lands at the right place
        // in the server-generated HLS segment (which starts at its own 0).
        if (this._currentPlayOptions?.transcodingOffsetTicks) {
            seconds = (positionTicks - this._currentPlayOptions.transcodingOffsetTicks) / 10000000;
        }

        // Update the robust seek target so that _onPlaying can detect if this seek snaps back.
        // We skip this for Live TV where currentTime logic is often non-standard.
        const isLive = this._currentPlayOptions?.item?.Type === 'TvChannel' || this._currentPlayOptions?.mediaSource?.LiveStreamId;
        this._robustSeekTarget = isLive ? null : seconds;

        // Re-enable robust check for the new seek
        this._cancelRobustResume = false;

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
        if (!audioTracks || audioTracks.length === 0) {
            log.debug('WebOSPlayer: Native audioTracks not available');
            return;
        }

        for (let i = 0; i < audioTracks.length; i++) {
            audioTracks[i].enabled = (i === listIndex);
        }
        log.info('WebOSPlayer: Native audio track → list index', listIndex);

        // WebOS native media pipeline does not apply audioTracks.enabled changes
        // mid-playback without a seek. A sub-frame back-seek (≤0.1 s) forces the
        // hardware decoder to reinitialize with the new track state while staying
        // in DirectPlay mode (preserving Dolby Vision passthrough).
        if (video.readyState >= 2 /* HAVE_CURRENT_DATA */ && video.currentTime > 0.1) {
            video.currentTime = video.currentTime - 0.1;
        }
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
        if (this._robustSeekPending) return;

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
     *
     * We only log after playback has actually started — before that the
     * progress events are just the initial segment prefetch and clutter
     * the log while the decoder pipeline spins up.
     * @private
     */
    _onProgress() {
        const video = this._videoElement;
        if (!video || !video.buffered || video.buffered.length === 0) return;
        if (!this._started) return;
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
        if (this._robustSeekTarget !== null && this._robustSeekTarget !== undefined) {
            const target = this._robustSeekTarget;
            // If we drifted past the target
            if (Math.abs(this.getCurrentTime() - target) > 2) {
                log.info(`WebOSPlayer: Detected position drift (current: ${this.getCurrentTime()}, expected: ${target}), applying robust seek`);
                this._seekWithRetry(target);
                return; // suppress this playing event
            } else {
                // No drift, we are good.
                this._robustSeekTarget = null;
            }
        }

        if (this._robustSeekPending) {
            return; // suppress playing event until retry loop finishes
        }

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
        // ----------------------------------------------------------------
        // Suppress waiting events before the first 'playing' fires.
        // WebOS fires 'waiting' as a normal part of its decoder
        // initialization pipeline — the hardware HLS engine needs time to
        // parse the first IDR frame before it can emit 'playing'. Surfacing
        // this to the UI or arming the stall timer at this stage causes the
        // stall-recovery kick to fire 8 s later against a perfectly healthy
        // buffer, creating the visible freeze at start of playback.
        // ----------------------------------------------------------------
        if (!this._started) return;

        this.onEvent({ type: 'waiting' });
        this._startStallCheck();
    }

    /** @private */
    _onStalled() {
        log.warn('WebOSPlayer: Playback stalled');

        // Same guard as _onWaiting — a 'stalled' event immediately at load
        // time is the WebOS pipeline warming up, not a genuine underrun.
        // Let the decoder self-recover silently; only engage stall machinery
        // once we know the player is already producing frames.
        if (!this._started) return;

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
     * Adaptive stall recovery — two-tier timer based on buffer health at stall time.
     *
     * WHY TWO TIERS:
     *
     *   Tier 1 — FAST (1.5 s): Decoder hiccup with healthy buffer.
     *   ─────────────────────────────────────────────────────────
     *   On Dolby Vision / HEVC content served via direct-play MKV, the WebOS
     *   native media pipeline sometimes freezes the decoder mid-stream even
     *   when 10–18 s of data is already buffered. This is a hardware quirk
     *   (the decoder pipeline stalls waiting for an IDR frame that it never
     *   initiates itself). Since the buffer is healthy, we know immediately
     *   this is NOT a network problem — the decoder just needs a nudge.
     *   Waiting the full 8 s to confirm this causes the visible "freeze at
     *   start" that the user experiences. 1.5 s is long enough to confirm the
     *   decoder won't self-recover, while keeping the stall nearly imperceptible.
     *
     *   Tier 2 — SLOW (8 s, configurable): Thin buffer / genuine underrun.
     *   ────────────────────────────────────────────────────────────────────
     *   When the buffer is thin at stall time the network may still be filling
     *   the segment. We wait the full recovery window before kicking so we
     *   don't interrupt a segment download mid-flight and cause a worse stall.
     *   The bufferGate check at the end ensures we only kick for real underruns
     *   and not for HLS segment-boundary micro-stalls that always self-recover.
     *
     * KICK MAGNITUDE (0.5 s):
     *   A 10 ms nudge lands inside the same decoded frame and is silently
     *   ignored by the WebOS native media engine on high-bitrate HEVC streams.
     *   A 500 ms nudge crosses at least one segment boundary, forcing a clean
     *   IDR re-init — which is what actually unblocks the decoder.
     *
     * @private
     */
    _startStallCheck() {
        this._clearStallCheck();

        // ----------------------------------------------------------------
        // Sample the buffer RIGHT NOW, at the moment the stall is detected.
        // This tells us whether the network is fine (decoder hiccup) or
        // whether we're genuinely starved (network underrun). The buffer
        // state at stall time is far more diagnostic than what it looks like
        // 8 seconds later when the slow timer fires.
        // ----------------------------------------------------------------
        const bufferAtStall = this._getBufferAhead();

        // Threshold: if we have more than this many seconds buffered at the
        // moment of stall, the network is not the problem — the decoder froze.
        // 3 s is conservative enough to exclude mid-segment download drops
        // while still catching the DV/HEVC decoder hiccup pattern clearly.
        const HICCUP_BUFFER_THRESHOLD = 3;

        if (bufferAtStall > HICCUP_BUFFER_THRESHOLD) {
            // ────────────────────────────────────────────────────────────────
            // FAST PATH: Decoder hiccup — buffer is healthy, network is fine.
            // Don't wait 8 s to confirm what we already know. 1.5 s is enough
            // to rule out a transient self-recovering wobble and still feel
            // nearly instant to the user.
            // ────────────────────────────────────────────────────────────────
            this._stallTimer = setTimeout(() => {
                if (!this._videoElement || this._videoElement.paused || !this._started) return;

                const bufferNow = this._getBufferAhead();
                log.warn(
                    'WebOSPlayer: Decoder hiccup — stalled 1.5s with',
                    bufferNow.toFixed(1),
                    's buffered — fast recovery kick (+0.5s)'
                );
                try {
                    this._videoElement.currentTime += 0.5;
                } catch (e) {
                    log.error('WebOSPlayer: Fast recovery kick failed', e);
                }
            }, 1500);

        } else {
            // ────────────────────────────────────────────────────────────────
            // SLOW PATH: Thin buffer at stall time — possible network underrun.
            // Give the download time to fill the buffer. Only kick after the
            // full recovery window, and only if still below the buffer gate.
            // ────────────────────────────────────────────────────────────────
            this._stallTimer = setTimeout(() => {
                if (!this._videoElement || this._videoElement.paused || !this._started) return;

                const bufferAhead = this._getBufferAhead();

                // If the buffer has since refilled past the gate, this was a
                // transient HLS segment-boundary micro-stall — let it go.
                const bufferGate = PlayerSettings.get('webosBufferGate') || 10;
                if (bufferAhead > bufferGate) {
                    log.debug(
                        'WebOSPlayer: Stall timer fired with',
                        bufferAhead.toFixed(1),
                        's buffered — segment-boundary micro-stall, letting decoder self-recover'
                    );
                    return;
                }

                // Genuine underrun — kick forward to force a clean IDR re-init.
                log.warn(
                    'WebOSPlayer: Still stalled after 8s (buffer:',
                    bufferAhead.toFixed(1),
                    's) — recovery kick (+0.5s)'
                );
                try {
                    this._videoElement.currentTime += 0.5;
                } catch (e) {
                    log.error('WebOSPlayer: Recovery kick failed', e);
                }
            }, (PlayerSettings.get('webosStallRecovery') || 8) * 1000);
        }
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
