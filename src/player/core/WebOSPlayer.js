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
import { getDeviceCapabilities } from '../../api/DeviceProfile.js';

const log = logger.create('WebOSPlayer');

// ────────────────────────────────────────────────────────────────────────────
// Audio Capability Detection Helpers
// ────────────────────────────────────────────────────────────────────────────
// Evaluates user settings ('enable', 'disable', 'auto') for high-end audio
// formats. On 'auto', we dynamically query getDeviceCapabilities() to see
// if the current TV hardware actually advertises native decoding capability
// for DTS and TrueHD.
// ────────────────────────────────────────────────────────────────────────────
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

        // ---- DoVi stall loop detection ----
        // Tracks the last recovery kick timestamp to detect and break
        // seek → stall → seek feedback loops on Dolby Vision content.
        this._lastRecoveryKickTime = 0;
        this._recoveryPauseTimer  = null;

        // ---- Robust resume state ----
        this._robustSeekTarget   = null;
        this._robustSeekPending  = false;
        this._cancelRobustResume = false;

        // ---- Audio normalization (Web Audio API) ----
        this._audioContext = null;
        this._gainNode = null;

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

        // ====================================================================
        // Temporary OSD and Playback Audio Debugging Logs
        // ====================================================================
        log.info('[AudioDebug] WebOSPlayer.play:');
        log.info('  - options.url:', options.url);
        log.info('  - options.audioStreamIndex:', options.audioStreamIndex);
        log.info('  - options.audioTrackListIndex:', options.audioTrackListIndex);

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

        this._applyAudioNormalization(options);
        this._currentSrc = options.url;
    }

    /**
     * Apply audio normalization (TrackGain / AlbumGain) using the Web Audio API.
     * Only applies to audio-only items. The gain value comes from the server
     * metadata (NormalizationGain / albumNormalizationGain).
     * @private
     * @param {Object} options - Play options (item, mediaSource)
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
        } catch (e) {
            log.error('Audio normalization: failed to create gain node', e);
        }
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

        // ====================================================================
        // MEDIA FRAGMENT RESUME:
        // Append `#t=seconds` to the url for HLS streaming to hint the native HLS demuxer
        // to download chunks starting from the resume position immediately.
        // ====================================================================
        let url = options.url;
        const seconds = (options.playerStartPositionTicks || 0) / 10000000;
        if (seconds > 0) {
            log.info(`WebOSPlayer: Appending media fragment #t=${seconds} to native HLS URL`);
            url += `#t=${seconds}`;
        }

        // Use a <source> element with the MIME type hint so WebOS picks the
        // right codec path — without it, some versions skip the native HLS path.
        while (video.firstChild) {
            video.removeChild(video.firstChild);
        }
        const source = document.createElement('source');
        source.src  = url;
        source.type = 'application/vnd.apple.mpegURL';
        video.appendChild(source);

        video.load();

        return new Promise((resolve, reject) => {
            const onCanPlay = () => {
                video.removeEventListener('canplay', onCanPlay);
                video.removeEventListener('error', onLoadError);

                // Attempt tracks after metadata is loaded
                this._applyInitialTracks(options);

                this._resumeSeekThenPlay(video, options, resolve, reject);
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
     *
     * For most containers (MKV, MP4, etc.) we assign src directly so the
     * WebOS native media pipeline auto-probes the container — using a
     * <source> element with a MIME type like 'video/x-matroska' causes the
     * Chromium layer to silently reject it before the media pipeline sees it.
     *
     * DOLBY VISION EXCEPTION:
     * For DoVi content we provide a <source> element with the codec hint
     * `video/mp4; codecs="dvh1"`. This is the same in-band parameter-set
     * codec tag that WebOS uses to activate its Dolby Vision hardware decoder
     * pipeline (see the hvc1|dvh1|hev1 CodecProfile gate in WebOSProfile.js).
     *
     * Without this hint the WebOS decoder initialises the standard HEVC
     * pipeline. When it later encounters DoVi RPU NAL units (type 62) it
     * stalls — the buffer keeps filling (25+ seconds) but the decoder can't
     * produce frames, triggering the repeated fast-recovery kicks. The codec
     * string bypasses the container MIME check because WebOS Chromium passes
     * the `dvh1` tag directly to the native media engine, which then opens
     * the DoVi path before the first segment is decoded.
     *
     * A canPlayType guard ensures we fall back to raw video.src if Chromium
     * would reject the codec string (e.g. on a dev browser), preventing a
     * silent load failure.
     *
     * @private
     */
    async _playNativeDirect(video, options) {
        // Clear any stale source
        video.removeAttribute('src');
        while (video.firstChild) {
            video.removeChild(video.firstChild);
        }

        // ====================================================================
        // MEDIA FRAGMENT RESUME:
        // We append the media fragment `#t=seconds` to the direct play URL.
        // This instructs the WebOS media pipeline to start demuxing/decoding
        // from the resume position right from the first packet load.
        // ====================================================================
        let url = options.url;
        const seconds = (options.playerStartPositionTicks || 0) / 10000000;
        if (seconds > 0) {
            log.info(`WebOSPlayer: Appending media fragment #t=${seconds} to native DirectPlay URL`);
            url += `#t=${seconds}`;
        }

        // ── Dolby Vision hint path ───────────────────────────────────────────
        // Detect DoVi from the media stream metadata passed down via options.
        const videoStream = options.mediaSource?.MediaStreams?.find(s => s.Type === 'Video');
        const rangeType = videoStream?.VideoRangeType || '';
        const isDoVi = rangeType.startsWith('DOVI') || rangeType === 'DOVIWithHDR10' ||
                       rangeType === 'DOVIWithHLG' || rangeType === 'DOVIWithSDR';

        if (isDoVi) {
            // The 'dvh1' codec string tells WebOS to activate the DV hardware
            // decoder pipeline. We use video/mp4 as the MIME wrapper because
            // WebOS Chromium validates codec tags against MP4 codec strings
            // (dvh1 / dvhe are ISO BMFF-defined tags). video/x-matroska with
            // dvh1 would be rejected by Chromium's codec validation.
            const dvHint = 'video/mp4; codecs="dvh1"';
            const testVideo = document.createElement('video');
            const canPlayDv = testVideo.canPlayType(dvHint) !== '';

            if (canPlayDv) {
                log.info('WebOSPlayer: DoVi content detected — using dvh1 codec hint to activate DV decoder pipeline');
                const source = document.createElement('source');
                source.src  = url;
                source.type = dvHint;
                video.appendChild(source);
            } else {
                // canPlayType rejected the codec — fall back to raw src so
                // the native pipeline still gets a chance to probe it.
                log.warn('WebOSPlayer: DoVi detected but canPlayType("dvh1") returned false — falling back to raw src (dev browser?)');
                video.src = url;
            }
        } else {
            // Standard path: direct src assignment for all non-DoVi containers.
            // Using <source> with MIME types like 'video/x-matroska' causes the
            // Chromium layer to silently reject the source before the media
            // pipeline sees it, so we avoid it here.
            video.src = url;
        }

        video.load();

        return new Promise((resolve, reject) => {
            const onCanPlay = () => {
                video.removeEventListener('canplay', onCanPlay);
                video.removeEventListener('error', onError);

                // Apply audio/subtitle tracks at canplay — same timing as _playNativeHls.
                // audioTracks is not reliably populated at loadedmetadata on WebOS native
                // player, so doing it here (before play()) ensures the array is ready.
                this._applyInitialTracks(options);

                this._resumeSeekThenPlay(video, options, resolve, reject);
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
        // ====================================================================
        // Temporary OSD and Playback Audio Debugging Logs
        // ====================================================================
        log.info('[AudioDebug] WebOSPlayer._applyInitialTracks:');
        log.info('  - hls active:', !!hls);
        log.info('  - options.audioStreamIndex:', options.audioStreamIndex);
        log.info('  - options.audioTrackListIndex:', options.audioTrackListIndex);

        if (hls) {
            log.info('  - Hls.js Audio Tracks:');
            (hls.audioTracks || []).forEach((t, idx) => {
                log.info(`    * [${idx}] id: ${t.id}, name: ${t.name}, lang: ${t.lang}`);
            });
        } else if (this._videoElement) {
            const nativeTracks = this._videoElement.audioTracks;
            log.info('  - Native audioTracks present:', !!nativeTracks);
            if (nativeTracks) {
                log.info('  - Native audioTracks length:', nativeTracks.length);
                for (let i = 0; i < nativeTracks.length; i++) {
                    const t = nativeTracks[i];
                    log.info(`    * [${i}] id: ${t.id}, language: ${t.language}, label: ${t.label}, enabled: ${t.enabled}`);
                }
            }
        }

        // ---- Audio track ----
        if (options.audioStreamIndex !== undefined && options.audioStreamIndex !== null) {
            // JellyfinPlayer precomputes the backend-visible list index because
            // WebOS may hide unsupported passthrough tracks from audioTracks.
            const resolvedIndex = options.audioTrackListIndex >= 0 ? options.audioTrackListIndex : 0;

            if (hls) {
                // Single-track = Transcode/DirectStream (server picked one); multi-track = Remux/DirectPlay.
                const outputIndex = hls.audioTracks.length <= 1 ? 0 : resolvedIndex;
                if (outputIndex < hls.audioTracks.length) {
                    hls.audioTrack = outputIndex;
                    log.debug('WebOSPlayer: Hls.js audio track set to', outputIndex);
                }
            } else {
                const nativeTracks = this._videoElement?.audioTracks;

                // ── Direct-play with no audioTracks yet ───────────────────────
                // For MKV/MP4 direct-play, WebOS does not populate audioTracks.
                // That is fine here — JellyfinPlayer already embedded
                // AudioStreamIndex in the stream URL, so the server is already
                // serving the correct track. Calling setAudioStreamIndex() now
                // would fire audiotrackswitchfailed → restart → "play() was
                // interrupted by a new load request" error on every startup.
                //
                // We only need to call setAudioStreamIndex() when audioTracks IS
                // populated (HLS native path), so the decoder reinitialises on
                // the right track.  Mid-playback user switches still reach
                // setAudioStreamIndex() via JellyfinPlayer and will correctly
                // fire audiotrackswitchfailed → restart if tracks are empty.
                // ─────────────────────────────────────────────────────────────
                if (!nativeTracks || nativeTracks.length === 0) {
                    // ── Direct-play MKV/MP4: AudioStreamIndex is ignored by the server ──
                    //
                    // When Jellyfin serves a file with Static=true (DirectPlay), it just
                    // pipes raw container bytes. The AudioStreamIndex query parameter is
                    // silently ignored — the server never demuxes or selects a track.
                    // WebOS then picks whatever track the container flags as default.
                    //
                    // Strategy:
                    //   • Requested track = container default → nothing to do, correct
                    //     track is already playing. Skip silently.
                    //
                    //   • Requested track ≠ container default → the wrong track is playing.
                    //     We fire audiotrackswitchfailed to schedule a deferred remux
                    //     restart AFTER play() finishes resolving (so we don't cause
                    //     "play() interrupted by new load request").
                    //     The restart uses 'remux' mode so the server runs ffmpeg and
                    //     actually selects the correct audio track.
                    // ─────────────────────────────────────────────────────────────────
                    // Retrieve the actual default audio track index from the container streams.
                    // This is necessary because options.mediaSource.DefaultAudioStreamIndex holds
                    // the server-resolved preference track, but for progressive DirectPlay,
                    // the TV natively plays whatever track is designated default in the file.
                    const defaultIndex = this._getContainerDefaultAudioIndex(options.mediaSource);

                    // Track stream index requested by the player UI
                    const requestedIndex = options.audioStreamIndex;

                    // Compare requested index against container default index
                    const isDefaultTrack = (defaultIndex !== undefined && Number(requestedIndex) === Number(defaultIndex));

                    if (isDefaultTrack) {
                        log.debug('WebOSPlayer: _applyInitialTracks — audioTracks empty (direct-play), requested track is the container default. No action needed.');
                    } else {
                        log.warn('WebOSPlayer: _applyInitialTracks — audioTracks empty, requested index', requestedIndex,
                            '≠ container default', defaultIndex, '. Scheduling deferred remux restart.');
                        // Use setTimeout (macrotask) rather than Promise.resolve() (microtask)
                        // to guarantee the restart fires AFTER play() has fully resolved.
                        // A microtask still races with video.play()'s own promise within the
                        // same event loop tick and can trigger "AbortError: play() was interrupted".
                        setTimeout(() => {
                            this.onEvent({ type: 'audiotrackswitchfailed', data: { listIndex: resolvedIndex } });
                        }, 0);
                    }
                } else {
                    const outputIndex = nativeTracks.length <= 1 ? 0 : resolvedIndex;
                    this.setAudioStreamIndex(outputIndex);
                }
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

        // ====================================================================
        // MEDIA FRAGMENT CHECK:
        // If the media fragment seek already succeeded natively and the video
        // is close to the resume target (within 15s GOP keyframe tolerance),
        // we skip the robust seek retry loop.
        // ====================================================================
        const currentPos = video.currentTime || 0;
        const fragmentDrift = Math.abs(currentPos - resumeSeconds);
        if (fragmentDrift < 15 || currentPos >= (resumeSeconds - 15)) {
            log.info('WebOSPlayer: Robust resume target already reached (via media fragment). Skipping retry loop.');
            this._robustSeekTarget = null;
            return;
        }

        const tryApply = () => {
            if (this._cancelRobustResume || this._robustSeekTarget === null) return;

            // Only apply proactively if we're actually resuming from significantly past 0
            if (resumeSeconds >= 5) {
                // readyState 3 (HAVE_FUTURE_DATA) or 4 (HAVE_ENOUGH_DATA) + seekable ranges
                if (video.readyState >= 3 && video.seekable.length > 0) {
                    // Don't start a retry loop if _onPlaying's drift detection already started one
                    if (!this._robustSeekPending) {
                        this._seekWithRetry(resumeSeconds);
                    } else {
                        log.debug('WebOSPlayer: Robust resume already pending from _onPlaying, skipping');
                    }
                } else {
                    setTimeout(tryApply, 300);
                }
            }
        };

        tryApply();
    }

    /**
     * Re-apply resume seek with retry loop if the playhead failed to land.
     *
     * @private
     * @param {number} time - Target resume time in seconds
     * @param {number} maxRetries - Max retry attempts
     */
    _seekWithRetry(time, maxRetries = 3) {
        if (this._robustSeekPending) {
            log.debug('WebOSPlayer: Seek already pending, skipping concurrent retry');
            return;
        }
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
            } catch (e) {
                // Ignore synchronous currentTime assignment errors
            }

            // ----------------------------------------------------------------
            // Wait 3 seconds per attempt before checking the result.
            //
            // We use a 15-second acceptance window to safely cover standard
            // 24fps 240/250-frame GOP keyframe intervals (~10.4s) on hardware TV
            // decoders plus ~3s of forward playback advancement during the wait.
            //
            // Acceptance conditions:
            //   1. Playhead landed within 15s drift of target, OR
            //   2. Playhead has advanced past (target - 15s) playing forward.
            // ----------------------------------------------------------------
            setTimeout(() => {
                if (this._cancelRobustResume) return;

                // Measure how far currentTime landed from our requested target.
                const currentPos = video.currentTime || 0;
                const drift = Math.abs(currentPos - time);
                const isNearTarget = drift < 15 || currentPos >= (time - 15);

                if (isNearTarget) {
                    // Within 15s of target or playing forward — seek landed on a valid keyframe boundary.
                    log.debug(`WebOSPlayer: Seek accepted on attempt ${tries} (current: ${currentPos.toFixed(2)}s, target: ${time}s, drift: ${drift.toFixed(2)}s)`);
                    this._robustSeekPending = false;
                    this._robustSeekTarget = null;
                    if (!video.paused) this._onPlaying();
                } else if (tries < maxRetries) {
                    // Still far from target — video may not have seeked yet.
                    log.debug(`WebOSPlayer: Seek still off (current: ${currentPos.toFixed(2)}s, target: ${time}s, drift: ${drift.toFixed(2)}s) — retrying, attempt ${tries + 1}`);
                    attempt();
                } else {
                    // All retries exhausted and still far from target — genuine failure.
                    log.warn(`WebOSPlayer: Seek failed after ${maxRetries} retries (final drift: ${drift.toFixed(2)}s from target ${time}s)`);
                    this._robustSeekPending = false;
                    this._robustSeekTarget = null;

                    // Emit event so JellyfinPlayer can restart with Remux mode
                    this.onEvent({
                        type: 'resumeseekfailed',
                        data: { targetPositionTicks: Math.round(time * 10000000) }
                    });

                    if (!video.paused) this._onPlaying();
                }
            }, 3000);
        };
        attempt();
    }

     /**
      * Resume seek-then-play helper.
      *
      * Called from both _playNativeHls and _playNativeDirect canplay handlers.
      * First checks if the media fragment (#t=) already positioned the playhead.
      * If not, performs an explicit seek and waits for the seeked event.
      * On WebOS Chromium, calling play() first and then seeking to an unbuffered
      * position silently discards the seek — the native media pipeline starts
      * playback from 0 and ignores the currentTime assignment. This is why we
      * must seek before play().
      *
      * @private
      * @param {HTMLVideoElement} video
      * @param {Object}           options  - Play options
      * @param {Function}         resolve  - Promise resolve
      * @param {Function}         reject   - Promise reject
      */
     _resumeSeekThenPlay(video, options, resolve, reject) {
         const resumeSeconds = this._robustSeekTarget;
         if (resumeSeconds !== null && resumeSeconds !== undefined && resumeSeconds > 0) {
             log.info('WebOSPlayer: Applying resume seek at canplay for', resumeSeconds, 's');

             // ====================================================================
             // MEDIA FRAGMENT CHECK:
             // The #t= fragment in the URL already hints the native pipeline to
             // start downloading from the resume position. Check if it worked by
             // verifying the playhead is within 15s keyframe tolerance of target.
             // ====================================================================
             try {
                 const currentPos = video.currentTime || 0;
                 const drift = Math.abs(currentPos - resumeSeconds);
                 if (drift < 15 || currentPos >= (resumeSeconds - 15)) {
                     log.info('WebOSPlayer: Media fragment already positioned the playhead — skipping explicit seek.');
                     this._doPlayWithResume(video, options, resolve, reject);
                     return;
                 }
             } catch (e) {
                 // Defensive: accessing currentTime may throw on some exotic platforms.
                 log.error('WebOSPlayer: currentTime read threw during fragment check', e);
             }

             // ====================================================================
             // FALLBACK SEEK (only if fragment didn't work):
             // Media fragment failed or wasn't used. Explicitly seek to resume target.
             // This avoids racing between URL-level and playback-layer positioning.
             // ====================================================================
             log.info('WebOSPlayer: Media fragment did not position playhead — falling back to explicit seek');

             let seekCompleted = false;
             let seekTimeout = null;

             const onSeeked = () => {
                 video.removeEventListener('seeked', onSeeked);
                 if (seekTimeout) clearTimeout(seekTimeout);
                 seekCompleted = true;
                 log.debug('WebOSPlayer: Explicit seek completed');
                 this._doPlayWithResume(video, options, resolve, reject);
             };

             video.addEventListener('seeked', onSeeked);

             try {
                 video.currentTime = resumeSeconds;
             } catch (e) {
                 // Some implementations throw synchronously for impossible/early seeks.
                 log.error('WebOSPlayer: Setting currentTime threw during resume seek', e);
             }

             // Shorter safety net: 3s is sufficient on most devices and avoids
             // long UI freezes when the media fragment already worked.
             seekTimeout = setTimeout(() => {
                 video.removeEventListener('seeked', onSeeked);
                 if (!seekCompleted) {
                     log.warn('WebOSPlayer: Explicit seek timed out (3s) — starting playback from current position');
                     this._doPlayWithResume(video, options, resolve, reject);
                 }
             }, 3000);
         } else {
             this._doPlayWithResume(video, options, resolve, reject);
         }
     }

    /**
     * Play the video and apply the robust resume safety net.
     * Extracted so both _resumeSeekThenPlay and the no-seek path converge.
     * @private
     */
    _doPlayWithResume(video, options, resolve, reject) {
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
        if (this._directSeekVerifyTimeout) {
            clearTimeout(this._directSeekVerifyTimeout);
            this._directSeekVerifyTimeout = null;
        }
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

        // Only guard against snap-backs during initial startup resume before first playback.
        // Once playback is running (_started === true), normal user scrubbing should not arm
        // the startup _seekWithRetry loop (which could falsely trigger resumeseekfailed on keyframe landing).
        const isLive = this._currentPlayOptions?.item?.Type === 'TvChannel' || this._currentPlayOptions?.mediaSource?.LiveStreamId;
        this._robustSeekTarget = (!this._started && !isLive) ? seconds : null;

        // Re-enable robust check for the new seek
        this._cancelRobustResume = false;

        // Skip tiny seeks — avoids decoder stutter on redundant calls
        if (Math.abs(video.currentTime - seconds) > SEEK_THRESHOLD_MS / 1000) {
            video.currentTime = Math.max(0, seconds);
        }

        // Emit a synthetic timeupdate immediately so paused-state UI refreshes
        this.onEvent({ type: 'timeupdate', data: { time: Math.max(0, seconds) } });

        // ---------------------------------------------------------------------
        // DirectPlay Seek Verification Guard:
        // When DirectPlaying raw progressive files (like MKVs with chained or
        // missing SeekHead Cues), the webOS hardware demuxer may silently fail
        // to seek, staying at 0s or rolling back.
        //
        // If this is a direct stream (non-HLS) and the target is >= 5s, we
        // schedule a verification check after 2.5s. If the playhead has not
        // arrived near the target, we immediately escalate to _seekWithRetry,
        // which triggers the Remux fallback path if the hardware cannot seek.
        // ---------------------------------------------------------------------
        if (!this._isHls && !isLive && seconds >= 5) {
            if (this._directSeekVerifyTimeout) {
                clearTimeout(this._directSeekVerifyTimeout);
            }
            this._directSeekVerifyTimeout = setTimeout(() => {
                if (this._cancelRobustResume || !this._videoElement) return;
                const cur = this.getCurrentTime();
                const drift = Math.abs(cur - seconds);
                const isNear = drift < 15 || cur >= (seconds - 15);
                if (!isNear) {
                    log.warn(`WebOSPlayer: DirectPlay seek to ${seconds}s failed (stuck at ${cur.toFixed(2)}s). Escalating to robust seek / Remux.`);
                    this._seekWithRetry(seconds, 2);
                }
            }, 2500);
        }
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
        // ====================================================================
        // Temporary OSD and Playback Audio Debugging Logs
        // ====================================================================
        log.info('[AudioDebug] WebOSPlayer.setAudioStreamIndex called with listIndex:', listIndex);

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

        // ── Empty audioTracks: deferred restart fallback ──────────────────────
        //
        // WebOS does not populate video.audioTracks for progressive MKV/MP4.
        // supportsNativeAudioTracks() already accounts for this at play-setup
        // time, but a race is possible if the media was loaded before tracks
        // became available, or if the server returned DirectPlay when we
        // expected HLS. Either way, silently failing here leaves the user on
        // the wrong track — we log clearly and signal to the caller instead.
        if (!audioTracks || audioTracks.length === 0) {
            // ── Direct-play MKV/MP4: audioTracks is not populated by WebOS ───────
            //
            // WebOS does not expose the HTML5 audioTracks API for progressive
            // container downloads (MKV, MP4). The collection stays empty for
            // the entire playback session, so any .enabled toggle is a no-op.
            //
            // Signal a restart to JellyfinPlayer so it can re-open the stream
            // with AudioStreamIndex in the server URL, which causes the server
            // (or the container parser) to serve the correct audio track from
            // the start. This is the same path used for Transcode audio switches.
            // ─────────────────────────────────────────────────────────────────
            log.warn('WebOSPlayer: video.audioTracks is empty for direct-play — firing audiotrackswitchfailed to trigger restart');
            this.onEvent({ type: 'audiotrackswitchfailed', data: { listIndex } });
            return;
        }

        // ── WebOS track reordering guard ──────────────────────────────────────
        //
        // WebOS Chromium does NOT guarantee that video.audioTracks reflects the
        // physical stream order from the container. Specifically, the track
        // flagged as "default" in the MKV/MP4 container is placed at
        // audioTracks[0] regardless of its source stream index. This inverts our
        // positional assumptions:
        //
        //   Jellyfin order  (by stream Index): [1=English, 2=Japanese*(default)]
        //   WebOS audioTracks order:           [0=Japanese*(default), 1=English]
        //
        // listIndex=1 (intended: Japanese) would then incorrectly enable
        // audioTracks[1] (English), inverting every audio track selection.
        //
        // _resolveNativeAudioIndex() uses BCP-47 language tag matching to find
        // the correct audioTracks position, falling back to positional indexing
        // only when language data is absent or ambiguous.
        // ─────────────────────────────────────────────────────────────────────
        const nativeIndex = this._resolveNativeAudioIndex(listIndex, audioTracks);

        // Guard against out-of-bounds index resolution
        if (nativeIndex < 0 || nativeIndex >= audioTracks.length) {
            log.warn('WebOSPlayer: _resolveNativeAudioIndex returned out-of-range index', nativeIndex, 'for listIndex', listIndex, '— firing audiotrackswitchfailed');
            this.onEvent({ type: 'audiotrackswitchfailed', data: { listIndex } });
            return;
        }

        for (let i = 0; i < audioTracks.length; i++) {
            audioTracks[i].enabled = (i === nativeIndex);
        }
        log.info('WebOSPlayer: Native audio track → list index', listIndex, '→ native index', nativeIndex);

        // WebOS native media pipeline does not apply audioTracks.enabled changes
        // mid-playback without a seek. A sub-frame back-seek (≤0.1 s) forces the
        // hardware decoder to reinitialize with the new track state while staying
        // in DirectPlay mode (preserving Dolby Vision passthrough).
        if (video.readyState >= 2 /* HAVE_CURRENT_DATA */ && video.currentTime > 0.1) {
            video.currentTime = video.currentTime - 0.1;
        }
    }

    /**
     * Resolve a Jellyfin-visible audio list index to the actual position inside
     * the browser's video.audioTracks collection.
     *
     * WebOS Chromium reorders audioTracks — the container's "default" track is
     * always placed at index 0, regardless of its physical stream order. Our
     * Jellyfin-side index (sorted by stream Index) therefore doesn't map 1-to-1.
     *
     * Resolution strategy (in priority order):
     *
     *   1. Language-tag match — find all native tracks whose BCP-47 language
     *      code overlaps the Jellyfin stream's Language field. Prefix matching
     *      is used to bridge ISO 639-2 ("eng", "jpn") ↔ BCP-47 ("en", "ja")
     *      differences.
     *
     *   2. Same-language disambiguation — when multiple native tracks share the
     *      same language, pick by the stream's relative position among Jellyfin
     *      streams with that same language (e.g. the 2nd English track maps to
     *      the 2nd native English track).
     *
     *   3. Positional fallback — used when language data is absent, 'und', or
     *      when no native track language matches. Identical to the original
     *      pre-fix behaviour, preserving backwards compatibility.
     *
     * @param   {number}         listIndex    0-based index into the Jellyfin
     *                                        filtered audio stream array
     *                                        (audioTrackListIndex from play options).
     * @param   {AudioTrackList} nativeTracks video.audioTracks from the element.
     * @returns {number}  Index to use for audioTracks[i].enabled.
     * @private
     */
    _getContainerDefaultAudioIndex(mediaSource) {
        // Guard check: Ensure mediaSource and MediaStreams are present
        if (!mediaSource || !mediaSource.MediaStreams) return undefined;

        // Filter streams to supported audio formats matching player settings
        const audioStreams = mediaSource.MediaStreams.filter(s => {
            if (s.Type !== 'Audio') return false;
            const codec = (s.Codec || '').toLowerCase();

            // Exclude TrueHD audio formats if disabled in settings
            if (codec === 'truehd' && !isTrueHdSupported()) return false;

            // Exclude DTS / DCA audio formats if disabled in settings
            if ((codec.includes('dts') || codec === 'dca') && !isDtsSupported()) return false;

            // Exclude FLAC / ALAC audio formats if disabled in settings
            if ((codec === 'flac' || codec === 'alac') && !PlayerSettings.get('enableFlacInVideo')) return false;

            return true;
        });

        // Find the stream explicitly marked as default in the container metadata,
        // or default to the first available audio track if none are marked.
        const defaultStream = audioStreams.find(s => s.IsDefault) || audioStreams[0];
        return defaultStream ? defaultStream.Index : undefined;
    }

    /**
     * Resolve a Jellyfin-visible audio list index to the actual position inside
     * the browser's video.audioTracks collection.
     *
     * WebOS Chromium reorders audioTracks — the container's "default" track is
     * always placed at index 0, regardless of its physical stream order. Our
     * Jellyfin-side index (sorted by stream Index) therefore doesn't map 1-to-1.
     *
     * Resolution strategy (in priority order):
     *
     *   1. Language-tag match — find all native tracks whose BCP-47 language
     *      code overlaps the Jellyfin stream's Language field. Prefix matching
     *      is used to bridge ISO 639-2 ("eng", "jpn") ↔ BCP-47 ("en", "ja")
     *      differences.
     *
     *   2. Same-language disambiguation — when multiple native tracks share the
     *      same language, pick by the stream's relative position among Jellyfin
     *      streams with that same language (e.g. the 2nd English track maps to
     *      the 2nd native English track).
     *
     *   3. Positional fallback — used when language data is absent, 'und', or
     *      when no native track language matches. Identical to the original
     *      pre-fix behaviour, preserving backwards compatibility.
     *
     * @param   {number}         listIndex    0-based index into the Jellyfin
     *                                        filtered audio stream array
     *                                        (audioTrackListIndex from play options).
     * @param   {AudioTrackList} nativeTracks video.audioTracks from the element.
     * @returns {number}  Index to use for audioTracks[i].enabled.
     * @private
     */
    _resolveNativeAudioIndex(listIndex, nativeTracks) {
        // Guard: empty native track collection exposed by WebOS Chromium
        if (!nativeTracks || nativeTracks.length === 0) {
            log.warn('[AudioDebug] WebOSPlayer._resolveNativeAudioIndex: nativeTracks is empty');
            return -1;
        }

        // Fast-path: single native track — no ambiguity possible
        if (nativeTracks.length === 1) {
            log.info('[AudioDebug] WebOSPlayer._resolveNativeAudioIndex: single native track fast-path → 0');
            return 0;
        }

        // ====================================================================
        // Gather Jellyfin-visible audio streams from current media source
        // Uses the same codec filters as JellyfinPlayer._getBackendAudioTracks
        // ====================================================================
        const mediaStreams = this._currentPlayOptions?.mediaSource?.MediaStreams || [];
        const jellyfinAudioStreams = mediaStreams.filter(s => {
            if (s.Type !== 'Audio') return false;
            const codec = (s.Codec || '').toLowerCase();
            if (codec === 'truehd' && !isTrueHdSupported()) return false;
            if ((codec.includes('dts') || codec === 'dca') && !isDtsSupported()) return false;
            if ((codec === 'flac' || codec === 'alac') && !PlayerSettings.get('enableFlacInVideo')) return false;
            return true;
        });

        // ====================================================================
        // Diagnostic logging
        // ====================================================================
        log.info('[AudioDebug] WebOSPlayer._resolveNativeAudioIndex:');
        log.info('  - listIndex:', listIndex);
        log.info('  - Jellyfin Audio Streams count:', jellyfinAudioStreams.length);
        jellyfinAudioStreams.forEach((s, idx) => {
            log.info(`    * [${idx}] Index: ${s.Index}, Lang: ${s.Language}, Codec: ${s.Codec}, IsDefault: ${s.IsDefault}`);
        });

        log.info('  - Native audioTracks count:', nativeTracks.length);
        for (let i = 0; i < nativeTracks.length; i++) {
            const t = nativeTracks[i];
            log.info(`    * [${i}] id: ${t.id}, language: ${t.language}, label: ${t.label}, enabled: ${t.enabled}`);
        }

        // Guard: ensure listIndex points to a valid Jellyfin audio stream
        const targetStream = jellyfinAudioStreams[listIndex];
        if (!targetStream) {
            log.warn('[AudioDebug] WebOSPlayer: listIndex out of range, returning clamped fallback');
            return Math.min(Math.max(0, listIndex), nativeTracks.length - 1);
        }

        log.info('  - targetStream Index:', targetStream.Index, 'Language:', targetStream.Language, 'Codec:', targetStream.Codec);

        // ====================================================================
        // Strategy 1: Codec-Aware Playable Stream Mapping (PRIMARY)
        //
        // When the native player exposes fewer tracks than the Jellyfin-filtered
        // list, additional codecs were silently dropped by the browser demuxer.
        // Build a "playable" subset by filtering out suspect codecs, verify the
        // count matches native tracks, then use the filtered list for mapping.
        //
        // This MUST run before language matching because language matching alone
        // cannot disambiguate when all tracks share the same language but some
        // codecs were dropped (e.g. 4 English tracks → 3 native tracks).
        // ====================================================================
        if (nativeTracks.length !== jellyfinAudioStreams.length) {
            const SUSPECT_CODECS = ['flac', 'alac', 'truehd', 'dts', 'dca'];
            const isUnsupportedCodec = (codec) => {
                const c = (codec || '').toLowerCase();
                return SUSPECT_CODECS.some(sc => c === sc || c.includes(sc));
            };

            const playableStreams = jellyfinAudioStreams.filter(s => !isUnsupportedCodec(s.Codec));
            log.info(`  - Codec-aware mapping: ${jellyfinAudioStreams.length} jellyfin → ${playableStreams.length} playable (native: ${nativeTracks.length})`);

            if (playableStreams.length === nativeTracks.length) {
                const targetCodec = (targetStream.Codec || '').toLowerCase();

                if (isUnsupportedCodec(targetCodec)) {
                    log.info(`[AudioDebug] WebOSPlayer: Target codec "${targetCodec}" is unsupported by native player → returning -1`);
                    return -1;
                }

                const nativeIdx = playableStreams.findIndex(s => s.Index === targetStream.Index);
                if (nativeIdx >= 0) {
                    log.info(`[AudioDebug] WebOSPlayer: Codec-aware mapping resolved listIndex ${listIndex} → native index ${nativeIdx}`);
                    return nativeIdx;
                }
            }
        }

        // ====================================================================
        // Strategy 2: Language-Tag Matching (ISO 639-2 ↔ BCP-47 / ISO 639-1)
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
            log.info(`  - Lang match attempt: targetLang = ${targetLang}, normalized = ${normTarget}`);

            for (let i = 0; i < nativeTracks.length; i++) {
                const nativeLang = (nativeTracks[i].language || '').toLowerCase().trim();
                if (!nativeLang) continue;
                const normNative = normalize(nativeLang);
                if (normNative === normTarget || normNative.startsWith(normTarget) || normTarget.startsWith(normNative)) {
                    nativeMatches.push(i);
                }
            }

            if (nativeMatches.length === 1) {
                log.info('[AudioDebug] WebOSPlayer: Resolved native audio index by unique language match', listIndex, '→', nativeMatches[0]);
                return nativeMatches[0];
            }

            if (nativeMatches.length > 1) {
                const sameLanguageStreams = jellyfinAudioStreams.filter(s => normalize(s.Language || '') === normTarget);
                const posWithinLang = sameLanguageStreams.findIndex(s => s.Index === targetStream.Index);
                if (posWithinLang >= 0 && posWithinLang < nativeMatches.length) {
                    log.info('[AudioDebug] WebOSPlayer: Disambiguated same language match', listIndex, '→', nativeMatches[posWithinLang]);
                    return nativeMatches[posWithinLang];
                }
            }
        } else {
            log.info('  - targetLang is empty, und, or unknown. Skipping language match.');
        }

        // ====================================================================
        // Strategy 3: Deterministic Default-Reordering Fallback
        // WebOS moves the container's default audio track to native index 0.
        // ====================================================================
        const defaultStreamIndex = this._getContainerDefaultAudioIndex(this._currentPlayOptions?.mediaSource);
        log.info('  - Default reordering attempt: defaultStreamIndex =', defaultStreamIndex);
        if (defaultStreamIndex !== undefined && defaultStreamIndex !== null) {
            const defaultListIndex = jellyfinAudioStreams.findIndex(s => s.Index === defaultStreamIndex);
            log.info('    * defaultListIndex in jellyfin streams =', defaultListIndex);

            if (defaultListIndex !== -1) {
                if (listIndex === defaultListIndex) {
                    log.info('[AudioDebug] WebOSPlayer: Resolved via default reordering (target is default) → 0');
                    return 0;
                }

                const resolvedIndex = listIndex < defaultListIndex ? listIndex + 1 : listIndex;
                if (resolvedIndex >= 0 && resolvedIndex < nativeTracks.length) {
                    log.info('[AudioDebug] WebOSPlayer: Resolved via default reordering (non-default)', listIndex, '→', resolvedIndex);
                    return resolvedIndex;
                }
            }
        }

        // ====================================================================
        // Strategy 4: Positional Fallback — clamped to native track bounds
        // ====================================================================
        const fallbackIndex = Math.min(Math.max(0, listIndex), nativeTracks.length - 1);
        log.info('[AudioDebug] WebOSPlayer: Clamped positional fallback used', listIndex, '→', fallbackIndex);
        return fallbackIndex;
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
     * Report whether this backend can natively switch audio tracks without
     * requiring a full playback restart.
     *
     * For WebOS, this returns true unconditionally because:
     *   - HLS streams (native or Hls.js) always expose video.audioTracks.
     *   - DirectPlay MKV/MP4 does NOT populate audioTracks — but that case
     *     is handled at switch-time in setAudioStreamIndex() by firing an
     *     'audiotrackswitchfailed' event so JellyfinPlayer can restart.
     *
     * Returning false here would cause JellyfinPlayer to force a remux upgrade
     * even for HLS content where native switching works perfectly, so we keep
     * the answer static and resolve the edge case at call time instead.
     *
     * @returns {boolean}
     */
    supportsNativeAudioTracks() {
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
            const current = this.getCurrentTime();
            const drift   = Math.abs(current - target);
            const isNearTarget = drift < 15 || current >= (target - 15);

            // ----------------------------------------------------------------
            // Drift gate: use a 15-second window to accommodate standard 24fps
            // 240/250-frame GOP keyframe distances on TV hardware decoders.
            //
            // If the video is within 15s of target or playing forward, accept.
            // Only escalate to _seekWithRetry when the playhead is genuinely
            // stuck (e.g. video stuck at 0s when target was 420s).
            // ----------------------------------------------------------------
            if (!isNearTarget) {
                log.info(`WebOSPlayer: Detected position drift (current: ${current.toFixed(2)}s, expected: ${target}s, drift: ${drift.toFixed(2)}s) — applying robust seek`);
                this._seekWithRetry(target);
                return; // suppress this playing event until seek resolves
            } else {
                // Close enough — keyframe boundary or normal forward progression. Accept.
                log.debug(`WebOSPlayer: Resume target reached (current: ${current.toFixed(2)}s, target: ${target}s, drift: ${drift.toFixed(2)}s). Clearing seek guard.`);
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
     * SELF-RECOVERY DETECTION:
     *   Both tiers record `currentTime` at the moment the stall is detected.
     *   When the timer fires, we compare against the current `currentTime`.
     *   If it has advanced by more than 0.1 s, the decoder has recovered on
     *   its own — even if the 'playing' event never fired (WebOS Chromium
     *   event timing is unreliable). In that case we skip the recovery action
     *   entirely, avoiding disruption of playback that's already working.
     *
     *   This is the primary fix for the DoVi stall issue: WebOS fires
     *   'stalled' events for brief decoder hiccups (< 1 s) that resolve
     *   before our timer fires. Without the self-recovery check, we were
     *   blindly firing pause/play or seek kicks on a decoder that had
     *   already recovered — creating visible disruption for no benefit.
     *
     * WHY TWO TIERS:
     *
     *   Tier 1 — FAST: Decoder hiccup with healthy buffer.
     *   ─────────────────────────────────────────────────────────
     *   Buffer is healthy, so the network is fine — the decoder froze.
     *
     *   For NON-DoVi content: 1.5 s timer, then currentTime += 0.5 kick.
     *
     *   For DoVi content: 4 s timer (DoVi decoder needs more time to
     *   self-recover from RPU sync hiccups), then a PAUSE/PLAY flush
     *   as the first recovery attempt. If the stall recurs within 15 s
     *   (indicating a stall loop), the second attempt is suppressed to
     *   let the decoder work through it on its own.
     *
     *   WHY PAUSE/PLAY INSTEAD OF SEEK FOR DoVi:
     *   The 0.5 s currentTime kick forces an IDR re-init. On DoVi
     *   content, the IDR re-init itself can trigger another decoder
     *   stall (the RPU layer must re-synchronize with the base layer),
     *   creating a seek → stall → seek feedback loop. A pause/play
     *   cycle flushes the decoder pipeline without an IDR re-init,
     *   breaking the loop.
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
        // Sample the buffer AND currentTime RIGHT NOW, at the moment the
        // stall is detected. Buffer tells us network vs decoder. currentTime
        // lets us detect self-recovery in the timer callback: if currentTime
        // has advanced by the time the timer fires, the decoder recovered on
        // its own and no intervention is needed.
        // ----------------------------------------------------------------
        const bufferAtStall = this._getBufferAhead();
        const timeAtStall = this._videoElement?.currentTime || 0;

        const HICCUP_BUFFER_THRESHOLD = 3;

        // ── DoVi detection ────────────────────────────────────────────────
        const videoStream = this._currentPlayOptions?.mediaSource?.MediaStreams?.find(s => s.Type === 'Video');
        const rangeType = videoStream?.VideoRangeType || '';
        const isDoVi = rangeType.indexOf('DOVI') !== -1;

        if (bufferAtStall > HICCUP_BUFFER_THRESHOLD) {
            // ────────────────────────────────────────────────────────────────
            // FAST PATH: Decoder hiccup — buffer is healthy, network is fine.
            // ────────────────────────────────────────────────────────────────

            // ── Re-stall loop detection ───────────────────────────────────
            // If we already fired a recovery kick within the last 15 s,
            // another kick risks creating a seek → stall → seek feedback
            // loop. Suppress the kick and let the decoder self-recover.
            const RECOVERY_COOLDOWN_MS = 15000;
            const timeSinceLastKick = Date.now() - this._lastRecoveryKickTime;
            const inCooldown = this._lastRecoveryKickTime > 0 && timeSinceLastKick < RECOVERY_COOLDOWN_MS;

            if (inCooldown) {
                log.info(
                    'WebOSPlayer: Stall detected but recovery cooldown active (' +
                    Math.round(timeSinceLastKick / 1000) + 's since last kick) — ' +
                    'suppressing kick to break stall loop, letting decoder self-recover'
                );
                return;
            }

            // DoVi content gets a longer window (4 s) because the DoVi
            // decoder frequently needs 2–3 s to re-sync the RPU layer
            // with the base layer after a hiccup. Kicking at 1.5 s
            // interrupts this self-recovery.
            const fastDelay = isDoVi ? 4000 : 1500;

            this._stallTimer = setTimeout(() => {
                if (!this._videoElement || this._videoElement.paused || !this._started) return;

                // ── Self-recovery detection ──────────────────────────────
                // If currentTime has advanced since the stall was detected,
                // the decoder recovered on its own — even if the 'playing'
                // event didn't fire (WebOS Chromium event timing is unreliable).
                // Skip the recovery action entirely to avoid disrupting
                // playback that's already working.
                const timeNow = this._videoElement.currentTime;
                if (timeNow > timeAtStall + 0.1) {
                    log.info(
                        'WebOSPlayer: Decoder self-recovered (currentTime advanced +' +
                        (timeNow - timeAtStall).toFixed(1) + 's) — no recovery kick needed'
                    );
                    return;
                }

                const bufferNow = this._getBufferAhead();

                if (isDoVi) {
                    // ── DoVi recovery: pause/play flush ──────────────────
                    // A pause/play cycle flushes the decoder pipeline
                    // without triggering an IDR re-init. This avoids the
                    // stall loop caused by seeks on DoVi content.
                    log.warn(
                        'WebOSPlayer: DoVi decoder genuinely stuck — stalled ' + (fastDelay / 1000) + 's with',
                        bufferNow.toFixed(1),
                        's buffered, currentTime frozen — attempting pause/play flush'
                    );
                    this._lastRecoveryKickTime = Date.now();
                    try {
                        this._videoElement.pause();
                        // Short pause (200 ms) lets the decoder pipeline
                        // drain its internal queues before we restart.
                        this._recoveryPauseTimer = setTimeout(() => {
                            this._recoveryPauseTimer = null;
                            if (!this._videoElement) return;
                            this._videoElement.play().catch(e => {
                                log.error('WebOSPlayer: DoVi pause/play resume failed', e);
                            });
                        }, 200);
                    } catch (e) {
                        log.error('WebOSPlayer: DoVi pause/play flush failed', e);
                    }
                } else {
                    // ── Standard HEVC recovery: currentTime kick ─────────
                    log.warn(
                        'WebOSPlayer: Decoder hiccup — stalled 1.5s with',
                        bufferNow.toFixed(1),
                        's buffered — fast recovery kick (+0.5s)'
                    );
                    this._lastRecoveryKickTime = Date.now();
                    try {
                        this._videoElement.currentTime += 0.5;
                    } catch (e) {
                        log.error('WebOSPlayer: Fast recovery kick failed', e);
                    }
                }
            }, fastDelay);

        } else {
            // ────────────────────────────────────────────────────────────────
            // SLOW PATH: Thin buffer at stall time — possible network underrun.
            // Give the download time to fill the buffer. Only kick after the
            // full recovery window, and only if still below the buffer gate.
            // ────────────────────────────────────────────────────────────────
            this._stallTimer = setTimeout(() => {
                if (!this._videoElement || this._videoElement.paused || !this._started) return;

                // Self-recovery check (same as fast path)
                const timeNow = this._videoElement.currentTime;
                if (timeNow > timeAtStall + 0.1) {
                    log.info(
                        'WebOSPlayer: Decoder self-recovered during slow path (currentTime advanced +' +
                        (timeNow - timeAtStall).toFixed(1) + 's) — no kick needed'
                    );
                    return;
                }

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
                this._lastRecoveryKickTime = Date.now();
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
        if (this._recoveryPauseTimer) {
            clearTimeout(this._recoveryPauseTimer);
            this._recoveryPauseTimer = null;
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
