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
import { platformInfo } from '../../utils/PlatformInfo.js';
import { customHeaders } from '../../utils/CustomHeaders.js';
import { api } from '../../api/ApiClient.js';

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

/** How long a resume seek may hold playback back before it starts anyway (non-webOS). */
const RESUME_SEEK_PLAY_GRACE_MS = 1000;

/** How long the picture/sound stay hidden for a resume seek that 'playing' overtook. */
const RESUME_REVEAL_FAILSAFE_MS = 10000;

/**
 * Buffer ahead (s) above which a 'stalled' event is the download pausing,
 * not playback running dry.
 */
const STALLED_HEALTHY_BUFFER_S = 3;

/** Playhead movement (s) during the stall check that shows playback went on by itself. */
const STALL_PROGRESS_S = 0.1;

/**
 * How long unpause() waits for a pending seek's 'seeked' before it starts
 * playback anyway: webOS carries out a seek on a paused element only once
 * playback starts (see the resume path), so that 'seeked' may never come.
 */
const SEEK_PLAY_FALLBACK_MS = 500;

/** Stall recovery jump (s); webOS ignores sub-frame jumps (see WebOSPlayer). */
const STALL_KICK_S = 0.01;
const STALL_KICK_WEBOS_S = 0.5;

/** HLS.js fatal network errors retried (1 s, 2 s, 4 s apart) before giving up. */
const HLS_MAX_NETWORK_RETRIES = 3;

/** Fatal HLS.js errors of the manifest request: retried with loadSource(), not startLoad(). */
const HLS_MANIFEST_ERRORS = [
    Hls.ErrorDetails.MANIFEST_LOAD_ERROR,
    Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT,
    Hls.ErrorDetails.MANIFEST_PARSING_ERROR
];

/**
 * HLS.js start watchdog: how long a start may wait for its playlists, and
 * after each fragment request, before it fails. A stalled fragment request
 * ends sooner, through HLS.js's own fatal timeout (20 s, retried).
 */
const HLS_START_LOAD_TIMEOUT_MS = 60000;

/**
 * HLS start check (_onHlsStartTimeout): due this long after the HLS.js load
 * began, and not sooner than the second delay after the first buffered
 * segment, which the decoder needs to start on.
 */
const HLS_START_CHECK_MS = 8000;
const HLS_START_SEGMENT_WAIT_MS = 5000;

/** HLS.js fatal media errors: a decoder reset, then a codec swap, once per window each. */
const HLS_MEDIA_RECOVERY_WINDOW_MS = 3000;

/**
 * Decoder resets one HLS.js instance gets for fatal media errors, and the
 * playback progress (s) past every earlier reset after which a new fault
 * gets a fresh budget.
 */
const HLS_MAX_DECODER_RESETS = 3;
const HLS_DECODER_RESET_PROGRESS_S = 30;

/**
 * Minimum real-time spacing of forwarded timeupdate events (as WebOSPlayer).
 * Chromium fires timeupdate about every 250 ms and webOS about every 156 ms;
 * a gap below both keeps every one, only bursts are dropped.
 */
const TIMEUPDATE_MIN_INTERVAL_MS = 100;

/**
 * Monotonic milliseconds for interval throttling. Date.now() follows the TV's
 * clock, which can step backwards on a time sync and stall the throttle.
 * @returns {number}
 */
const monotonicNow = () =>
    typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();

/**
 * Rejection for a load abandoned by stop() or a newer play(). Named
 * 'AbortError' like a DOM abort, so JellyfinPlayer treats it as a cancel.
 * @returns {Error}
 */
function createAbortError() {
    const error = new Error('Playback load was superseded by a newer request');
    error.name = 'AbortError';
    // A cancel by stop() / a newer play(): JellyfinPlayer.play() resolves false for it,
    // and its callers stop there (unlike a DOM AbortError from an interrupted play())
    error.superseded = true;
    return error;
}

/**
 * Rejection for an HLS.js start that made no progress within the start watchdog.
 * @param {boolean} noData - Not even a playlist arrived: the server is not
 *   delivering, so it is a network error (a transcode would not help either)
 * @returns {Error}
 */
function createLoadTimeoutError(noData) {
    const seconds = HLS_START_LOAD_TIMEOUT_MS / 1000;
    const error = new Error(
        noData ? `No data arrived from the server for ${seconds} s` : `HLS.js start made no progress for ${seconds} s`
    );
    error.name = 'PlaybackLoadTimeoutError';
    error.code = noData ? 2 : 0;
    error.isNetworkError = noData;
    return error;
}

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
        /** @type {WeakMap<TextTrackCue, number[]>} [start, end] of each native cue without the offset */
        this._cueBaseTimes = new WeakMap();

        // Bound event handlers (for cleanup)
        this._boundHandlers = {};

        // Throttle for timeupdate events
        this._lastTimeUpdateTicks = 0;
        this._lastTimeUpdateAt = 0;

        // Audio normalization (Web Audio API):
        // { element, context, source, gain } — see _applyAudioNormalization();
        // the context is shared by every element of this player
        this._audioGraph = null;
        this._audioContext = null;

        // ====================================================================
        // Audio Suppression State (Resume Playback):
        // Prevents brief audio bursts from timestamp 0:00 when resuming playback.
        // ====================================================================
        this._resumeAudioSuppressed = false;

        // ====================================================================
        // Video Suppression State (Resume Playback):
        // Prevents stale or pre-resume video frames (such as timestamp 0:00)
        // from flashing on screen before the resume seek to target completes.
        // ====================================================================
        this._resumeVideoSuppressed = false;
        // Pending reveal for a resume seek that 'playing' overtook
        this._resumeRevealOnSeeked = null;

        // Startup verification watchdog timer for HLS playback initiation, and its
        // wait after the first buffered segment
        this._hlsStartTimeout = null;
        this._hlsSegmentWaitTimeout = null;

        // Media element error that HLS.js is recovering from (one recovery per HLS.js session)
        this._hlsRecoveringError = null;

        // { hls, onError } — bounded recovery of the current HLS.js instance, for <video> errors
        this._hlsElementErrorHandler = null;

        // Aspect ratio mode ('auto' | 'zoom' | 'stretch')
        this._aspectRatio = 'auto';

        // ---- Load / seek lifecycle ----
        // True for HLS sources (read by seek()'s direct-play verification)
        this._isHls = false;
        // Bumped by every play() and stop(); async callbacks of an older load check it
        this._loadToken = 0;
        // Undoes the listeners/timers of a load that has not started yet and rejects it
        this._abortPendingLoad = null;
        // Direct-play seek verification and the post-play resume follow-up check
        this._directSeekVerifyTimeout = null;
        this._resumeFollowUpTimeout = null;
        // A seek began during playback (its 'waiting' reported), and the element
        // fired 'waiting' itself, so it fires 'playing' once it can play on
        this._seekWhilePlaying = false;
        this._elementWaiting = false;
    }

    /**
     * Abandon the load in progress (if any) and every timer of the current
     * playback, so nothing of it acts on the next item. The <video> element
     * is reused across items.
     * @private
     */
    _endPlaybackSession() {
        this._loadToken++;
        if (this._abortPendingLoad) {
            const abort = this._abortPendingLoad;
            this._abortPendingLoad = null;
            abort();
        }
        clearTimeout(this._directSeekVerifyTimeout);
        this._directSeekVerifyTimeout = null;
        clearTimeout(this._resumeFollowUpTimeout);
        this._resumeFollowUpTimeout = null;
        // A Play queued behind a seek: the next item's first 'seeked' would run it
        clearTimeout(this._seekPlayFallbackTimer);
        this._seekPlayFallbackTimer = null;
        this._pendingPlayAfterSeek = false;
        this._seekWhilePlaying = false;
        this._elementWaiting = false;
        this._cancelResumeRevealOnSeeked();
        this._clearStallCheck();
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

        // Drop whatever the previous load left behind (its play() rejects with AbortError)
        this._endPlaybackSession();
        this._isHls = Boolean(options.isHls || (options.url && options.url.includes('.m3u8')));

        this._currentPlayOptions = options;
        this._started = false;
        this._timeUpdated = false;
        // JellyfinPlayer takes it as the duration of an item without RunTimeTicks
        this._hlsManifestDuration = null;

        // Reset subtitle offset for new playback session
        this._subtitleOffset = 0;
        this._cueBaseTimes = new WeakMap();

        const video = this._ensureVideoElement();

        // Apply display layout geometry for active stream
        this._applyDisplayGeometry();

        // ====================================================================
        // Temporarily Mute Audio When Resuming Playback:
        // When resuming media from a non-zero start timestamp on webOS, the media
        // pipeline may decode the first audio frames from timestamp 0:00 for a split
        // second before the seek completes or before the target HLS segment is buffered.
        // If the stream is resuming and not already user-muted, temporarily mute
        // the video element there to prevent this audio burst leak. Audio is safely
        // unmuted once the playback reaches the 'playing' state. Other platforms do not
        // need it, and on WebKitGTK/WPE 2.54.0 a muted video that is hidden when loading
        // starts fails to play (https://bugs.webkit.org/show_bug.cgi?id=327551).
        // ====================================================================
        const isLive = options.item?.Type === 'TvChannel' || options.mediaSource?.LiveStreamId;
        const resumeSeconds = isLive ? 0 : (options.playerStartPositionTicks || 0) / 10000000;
        // ====================================================================
        // Audio & Video Suppression for Seamless Resume:
        // When resuming playback from a non-zero position, HTML5 video decoders
        // (and HLS.js pipeline initializations) decode the initial keyframe at
        // timestamp 0:00 for a few frames before the seek to resumeSeconds takes effect.
        // Mute audio (webOS, see above) and suppress visual presentation until the target GOP keyframe
        // is reached, preventing the random 0:00 frame and audio burst from leaking.
        // ====================================================================
        if (resumeSeconds > 0) {
            if (platformInfo.isWebOS && !video.muted) {
                video.muted = true;
                this._resumeAudioSuppressed = true;
            }
            this._suppressVideoForResume(video);
        }

        // Destroy any existing HLS player
        this._destroyHlsPlayer();

        // Apply audio normalization for audio-only items before the load starts:
        // routed in once playback had started, a track began at full level
        this._applyAudioNormalization(options);

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
     * Resolve the normalization gain (linear) for an item, or null when none applies.
     * Only audio-only items (music, audiobooks) are normalized; the value comes
     * from the server metadata (NormalizationGain / albumNormalizationGain).
     * @private
     * @param {Object} options - Play options with item and mediaSource metadata
     * @returns {number|null}
     */
    _getNormalizationGain(options) {
        const mode = PlayerSettings.get('audioNormalization');
        if (mode === 'Off') return null;

        const isAudioItem = options.item?.MediaType === 'Audio' || options.item?.Type === 'AudioBook';
        if (!isAudioItem) return null;

        let normalizationGain;
        if (mode === 'TrackGain') {
            normalizationGain = options.item?.NormalizationGain
                ?? options.mediaSource?.albumNormalizationGain;
        } else if (mode === 'AlbumGain') {
            normalizationGain = options.mediaSource?.albumNormalizationGain
                ?? options.item?.NormalizationGain;
        }

        if (normalizationGain == null) return null;
        return Math.pow(10, normalizationGain / 20);
    }

    /**
     * Apply audio normalization (TrackGain / AlbumGain) via the Web Audio API.
     *
     * A media element can be connected to a MediaElementAudioSourceNode only
     * once, and from then on its audio only reaches the speakers through that
     * graph. So the graph is built once per <video> element and reused (only
     * the gain changes); stop() releases it together with the element, so the
     * next item starts on a fresh element with its normal audio path.
     *
     * The AudioContext itself is kept for the player's lifetime and reused for
     * every element: old TV browsers (Chromium 38) cannot close() a context and
     * Chromium caps how many can exist, so a context per item would stop
     * working after a few tracks.
     *
     * @private
     * @param {Object} options - Play options with item and mediaSource metadata
     */
    _applyAudioNormalization(options) {
        const video = this._videoElement;
        if (!video) return;

        const gainValue = this._getNormalizationGain(options);
        const graph = this._audioGraph && this._audioGraph.element === video ? this._audioGraph : null;

        if (gainValue === null) {
            // The element is still routed through an earlier item's graph
            // (play() without stop()): play this item at unity gain.
            if (graph) graph.gain.gain.value = 1;
            return;
        }

        try {
            let activeGraph = graph;
            if (!activeGraph) {
                const AudioContext = window.AudioContext || window.webkitAudioContext;
                if (!AudioContext) {
                    log.warn('Audio normalization: Web Audio API not available');
                    return;
                }
                this._releaseAudioGraph();
                if (!this._audioContext || this._audioContext.state === 'closed') {
                    this._audioContext = new AudioContext();
                }
                const context = this._audioContext;
                const source = context.createMediaElementSource(video);
                const gain = context.createGain();
                source.connect(gain);
                gain.connect(context.destination);
                activeGraph = { element: video, context, source, gain };
                this._audioGraph = activeGraph;
            }

            activeGraph.gain.gain.value = gainValue;
            // Always resume: the context may still be suspending after the last stop()
            if (typeof activeGraph.context.resume === 'function') {
                const resuming = activeGraph.context.resume();
                if (resuming && typeof resuming.catch === 'function') {
                    resuming.catch((e) => log.warn('Audio normalization: AudioContext resume failed', e));
                }
            }
            log.info(`Audio normalization: applied ${PlayerSettings.get('audioNormalization')} gain of ${gainValue}`);
        } catch (e) {
            log.error('Audio normalization: failed to set up the gain node', e);
        }
    }

    /**
     * Disconnect the normalization graph, if any. The shared AudioContext is
     * kept for the next element and suspended meanwhile (where supported).
     * @private
     */
    _releaseAudioGraph() {
        const graph = this._audioGraph;
        if (!graph) return;
        this._audioGraph = null;
        try {
            graph.source.disconnect();
            graph.gain.disconnect();
        } catch (e) {
            // already disconnected
        }
        if (typeof graph.context.suspend === 'function') {
            try {
                const suspending = graph.context.suspend();
                if (suspending && typeof suspending.catch === 'function') suspending.catch(() => {});
            } catch (e) {
                // closed
            }
        }
    }

    /**
     * Close the shared normalization AudioContext (destroy() only; Chromium 38
     * has no close(), the context then ends with the page).
     * @private
     */
    _closeAudioContext() {
        const context = this._audioContext;
        this._audioContext = null;
        if (!context || typeof context.close !== 'function') return;
        try {
            const closing = context.close();
            if (closing && typeof closing.catch === 'function') closing.catch(() => {});
        } catch (e) {
            // already closed
        }
    }

    /**
     * Release the normalization graph and drop the <video> element it captured.
     * The next getVideoElement() / play() creates a fresh element, whose audio
     * goes straight to the speakers again. The user's mute state carries over.
     * @private
     */
    _replaceVideoElement() {
        const old = this._videoElement;
        this._releaseAudioGraph();
        if (!old) return;

        this._unbindEvents(old);
        if (old.parentNode) {
            old.parentNode.removeChild(old);
        }
        this._videoElement = null;

        const fresh = this._ensureVideoElement();
        fresh.muted = old.muted;
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
     * Create the HLS.js instance of a load (tests supply a stand-in here).
     * @private
     * @param {Object} config - HLS.js configuration
     * @returns {Hls}
     */
    _createHlsPlayer(config) {
        return new Hls(config);
    }

    /**
     * Play using HLS.js
     * @private
     */
    _playWithHlsJs(video, options) {
        return new Promise((resolve, reject) => {
            log.info('Using HLS.js for playback');
            this._hlsRecoveringError = null;

            // -------------------------------------------------------------------------
            // HLS.js Buffer Configuration & Stall Prevention
            // -------------------------------------------------------------------------
            // Browsers impose strict MediaSource Engine (MSE) memory quotas. Retaining 60-120s
            // of forward buffer at high bitrates (e.g. 4K / high-bitrate 1080p) triggers quota
            // exceeded exceptions, GC pauses, and aggressive buffer evictions.
            // We align with the official jellyfin-web baseline (30s buffer / 60s max).
            // -------------------------------------------------------------------------
            const configuredMaxBuffer = PlayerSettings.get('html5MaxBufferLength');
            const maxBufferLength = configuredMaxBuffer !== undefined && configuredMaxBuffer !== null
                ? Number(configuredMaxBuffer)
                : 30;
            const configuredMaxMaxBuffer = PlayerSettings.get('html5MaxMaxBufferLength');
            const maxMaxBufferLength = configuredMaxMaxBuffer !== undefined && configuredMaxMaxBuffer !== null
                ? Number(configuredMaxMaxBuffer)
                : 60;

            const hls = this._createHlsPlayer({
                startPosition: (options.playerStartPositionTicks || 0) / 10000000,
                maxBufferLength: maxBufferLength,
                maxMaxBufferLength: maxMaxBufferLength,
                manifestLoadingTimeOut: 20000,
                levelLoadingTimeOut: 20000,
                fragLoadingTimeOut: 20000,
                maxBufferSize: 60 * 1000 * 1000,
                enableWorker: true,
                // Tolerates up to 500ms of MSE GOP boundary timestamp discrepancy
                // between audio and video tracks without triggering bufferSeekOverHole.
                maxBufferHole: 0.5,
                // =====================================================================
                // Reverse Proxy Custom Headers Injection for HLS Requests
                // Injects custom headers into all playlist (.m3u8) and segment (.ts/.m4s)
                // requests destined for the Jellyfin server.
                // =====================================================================
                xhrSetup: (xhr, url) => {
                    const headers = customHeaders.getHeadersForUrl(url, api.serverUrl);
                    if (headers && typeof headers === 'object') {
                        for (const [k, v] of Object.entries(headers)) {
                            if (k && v) {
                                try {
                                    xhr.setRequestHeader(k, v);
                                } catch (_) {
                                    // Ignore errors on restricted header names
                                }
                            }
                        }
                    }
                }
            });

            let bufferReady = false;
            let initialBufferTimer = null;
            let resolved = false;
            // Main segments HLS.js has buffered: in all (for the start watchdog), and
            // since the buffer gate was armed
            let segmentsBuffered = 0;
            let gateSegments = 0;
            // Set when HLS.js detaches the element: recoverMediaError() reloads it
            let mediaReloaded = false;
            // The start check is due (8 s since the load began), and the wait after
            // the first segment is over
            let startCheckDue = false;
            let segmentWaitOver = false;
            // Start watchdog, and whether a playlist or fragment arrived
            let startWatchdog = null;
            let sawData = false;

            const resolveOnce = (value) => {
                if (resolved) return;
                resolved = true;
                clearTimeout(initialBufferTimer);
                clearTimeout(startWatchdog);
                hls.off(Hls.Events.FRAG_BUFFERED, onFragBuffered);
                resolve(value);
            };

            const rejectOnce = (reason) => {
                if (resolved) return;
                resolved = true;
                clearTimeout(initialBufferTimer);
                clearTimeout(startWatchdog);
                hls.off(Hls.Events.FRAG_BUFFERED, onFragBuffered);
                reject(reason);
            };

            // stop() / a newer play() abandons this start (also clears the 3 s timer)
            this._abortPendingLoad = () => rejectOnce(createAbortError());

            // Start again once HLS.js has reset the MediaSource and buffered; fail
            // with `failure` if that does not happen within 10 s.
            const waitForRecovery = (failure) => {
                bufferReady = false;
                gateSegments = 0;
                initialBufferTimer = setTimeout(() => rejectOnce(failure), 10000);
            };

            const startPlayback = () => {
                // Restore visual presentation once Hls.js is ready to render playback
                this._restoreVideoAfterResume(video);
                mediaReloaded = false;
                const playPromise = video.play();
                if (playPromise !== undefined && typeof playPromise.then === 'function') {
                    playPromise.then(() => resolveOnce()).catch((err) => {
                        if (err.name === 'NotAllowedError') {
                            log.warn('Autoplay blocked — retrying muted (remote launch).');
                            video.muted = true;
                            const retryPromise = video.play();
                            if (retryPromise !== undefined && typeof retryPromise.then === 'function') {
                                retryPromise.then(() => {
                                    this._scheduleUnmuteOnInteraction(video);
                                    resolveOnce();
                                }).catch((retryErr) => rejectOnce(retryErr));
                            } else {
                                this._scheduleUnmuteOnInteraction(video);
                                resolveOnce();
                            }
                        } else if (this._hlsPlayer === hls && this._leaveErrorToHls(video)) {
                            waitForRecovery(err);
                        } else if (err.name === 'AbortError' && mediaReloaded && this._hlsPlayer === hls && !resolved) {
                            // HLS.js reset the decoder (a fatal media error): recoverMediaError()
                            // reloads the element, which aborts the pending play(). JellyfinPlayer
                            // takes an AbortError for a cancel and drops it, so this is no reason
                            // to end the load; a start that does not follow is a decode error.
                            const error = new Error('HLS media error (no playback after a decoder reset)');
                            error.code = 3;
                            waitForRecovery(error);
                        } else {
                            rejectOnce(err);
                        }
                    });
                } else {
                    resolveOnce();
                }
            };

            // Calculate target resume position in seconds
            const resumeSeconds = (options.playerStartPositionTicks || 0) / 10000000;

            // -----------------------------------------------------------------
            // Buffer-Readiness Gate with Resume Stabilization:
            // Defer play() until initial media data is buffered.
            // On resume (resumeSeconds > 0), the playhead may land near the end
            // of a segment (e.g. 200ms before segment boundary). If play() starts
            // immediately with < 1.0s of buffer, the decoder starves before the
            // next segment loads, causing an instant bufferSeekOverHole jump.
            // We inspect the native video.buffered TimeRanges directly to ensure
            // at least 1.0s of forward cushion exists (or wait for segment #2).
            // Segments are counted on FRAG_BUFFERED, once all their tracks are
            // appended: BUFFER_APPENDED fires per SourceBuffer append, so the audio
            // of segment #1 passed for segment #2. Counting goes on after the gate
            // opened (the 3 s fallback opens it with none) for the start watchdog.
            // -----------------------------------------------------------------
            const onFragBuffered = (event, data) => {
                if (data?.id !== 'main') return;
                segmentsBuffered++;
                if (segmentsBuffered === 1) {
                    this._hlsSegmentWaitTimeout = setTimeout(() => {
                        this._hlsSegmentWaitTimeout = null;
                        segmentWaitOver = true;
                        if (startCheckDue) checkStart();
                    }, HLS_START_SEGMENT_WAIT_MS);
                }
                if (bufferReady) return;
                gateSegments++;

                // If resuming, calculate forward buffer cushion from the native video element
                if (resumeSeconds > 0 && video) {
                    let forwardBuffer = 0;
                    const checkPos = (video.currentTime > 0) ? video.currentTime : resumeSeconds;
                    const ranges = video.buffered;

                    // Locate the buffered range covering our current resume target position
                    if (ranges && ranges.length > 0) {
                        for (let i = 0; i < ranges.length; i++) {
                            // Allow a small 0.5s tolerance for GOP boundary rounding
                            if (checkPos >= ranges.start(i) - 0.5 && checkPos <= ranges.end(i)) {
                                forwardBuffer = ranges.end(i) - checkPos;
                                break;
                            }
                        }
                    }

                    // If forward cushion is thin (< 1.0s) and we haven't buffered segment #2 yet, wait
                    if (forwardBuffer < 1.0 && gateSegments < 2) {
                        log.info(
                            `HLS.js: segment #${gateSegments} buffered, forward buffer ${forwardBuffer.toFixed(2)}s < 1.0s — waiting for next segment to stabilize resume`
                        );
                        return;
                    }
                }

                // Buffer is now healthy and stabilized for smooth playback engagement
                bufferReady = true;
                clearTimeout(initialBufferTimer);
                log.info(`HLS.js: initial buffer ready (${gateSegments} segment(s)), starting playback`);
                startPlayback();
            };

            // 3s fallback: if no segment arrives, force play anyway
            initialBufferTimer = setTimeout(() => {
                if (!bufferReady) {
                    log.warn('HLS.js: initial buffer timeout (3s) — forcing play');
                    bufferReady = true;
                    startPlayback();
                }
            }, 3000);

            // Apply track selection and set up the buffer gate once manifest is parsed
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
                    if (options.subtitleStreamIndex === -1) {
                        hls.subtitleTrack = -1;
                    } else if (options.subtitleStreamIndex < hls.subtitleTracks.length) {
                        hls.subtitleTrack = options.subtitleStreamIndex;
                        log.debug('Set HLS subtitle track:', options.subtitleStreamIndex);
                    }
                }

                if (options.autoPlay === false) {
                    log.info('HLS.js path: Skipping initial play() due to autoPlay=false');
                    resolveOnce();
                }
                // Otherwise FRAG_BUFFERED or timeout will call startPlayback()
            });

            // ================================================================
            // LEVEL_UPDATED — fired every time the manifest playlist is
            // fetched and parsed (live: every ~4s; VOD: once at the end).
            // ================================================================
            hls.on(Hls.Events.LEVEL_UPDATED, (event, data) => {
                const details = data?.details;
                if (!details) return;

                if (!details.live && details.totalduration > 0) {
                    log.info(`[HLS] Manifest complete (EXT-X-ENDLIST). Total duration: ${details.totalduration.toFixed(1)}s`);
                    this._hlsManifestDuration = details.totalduration;
                    video.dispatchEvent(new Event('durationchange'));
                }
            });

            // -----------------------------------------------------------------
            // Unrecoverable HLS.js error: before playback started it rejects
            // play(); afterwards it is reported as a backend 'error' event so
            // JellyfinPlayer can escalate or show the error dialog.
            // -----------------------------------------------------------------
            const failHls = (reason) => {
                log.error('Fatal HLS error, cannot recover:', reason.message);
                if (this._hlsPlayer === hls) {
                    this._hlsPlayer = null;
                }
                try {
                    hls.destroy();
                } catch (e) {
                    log.warn('HLS.js destroy threw', e);
                }
                if (!resolved) {
                    rejectOnce(reason);
                    return;
                }
                this.onEvent({
                    type: 'error',
                    data: {
                        code: reason.code || 0,
                        name: 'HLS_FATAL_ERROR',
                        message: reason.message,
                        isNetworkError: Boolean(reason.isNetworkError)
                    }
                });
            };

            const errorHandling = this._createHlsErrorHandler(hls, failHls, options.url);
            hls.on(Hls.Events.ERROR, errorHandling.onError);
            hls.on(Hls.Events.FRAG_LOADED, errorHandling.onFragLoaded);
            this._hlsElementErrorHandler = { hls, onError: errorHandling.onError };

            // -----------------------------------------------------------------
            // Start watchdog: without one, a server that stopped answering left
            // play() pending forever, as the 3 s fallback's video.play() never
            // settles without media. The playlists get 60 s. Each fragment request
            // re-arms it: HLS.js ends a stalled request with its own fatal
            // timeout, so a slow cold transcode is not cut off. When not even a
            // playlist arrived, the server is not delivering at all: a network
            // error, so JellyfinPlayer shows it instead of trying a transcode.
            // -----------------------------------------------------------------
            const armStartWatchdog = () => {
                clearTimeout(startWatchdog);
                if (resolved) return;
                startWatchdog = setTimeout(() => {
                    log.warn(`HLS.js start made no progress for ${HLS_START_LOAD_TIMEOUT_MS / 1000} s`);
                    failHls(createLoadTimeoutError(!sawData));
                }, HLS_START_LOAD_TIMEOUT_MS);
            };
            const onDataLoaded = () => {
                sawData = true;
            };
            hls.on(Hls.Events.MANIFEST_LOADED, onDataLoaded);
            hls.on(Hls.Events.LEVEL_LOADED, onDataLoaded);
            hls.on(Hls.Events.FRAG_LOADED, onDataLoaded);
            hls.on(Hls.Events.FRAG_LOADING, armStartWatchdog);
            armStartWatchdog();

            // Listen for the first segment buffered — triggers play()
            hls.on(Hls.Events.FRAG_BUFFERED, onFragBuffered);
            hls.on(Hls.Events.MEDIA_DETACHING, () => {
                mediaReloaded = true;
            });

            // The buffer gate starts playback (not at all for autoPlay: false); autoplay
            // left on by a native item would start the element by itself
            video.autoplay = false;

            log.debug('HLS Loading source:', options.url);
            hls.loadSource(options.url);
            hls.attachMedia(video);

            this._hlsPlayer = hls;
            this._hlsManifestDuration = null;

            // -----------------------------------------------------------------
            // Startup Stall & Resume Playback Failure Watchdog:
            // When resuming an HLS stream (particularly DirectStream/Remux streams
            // where video was copied mid-GOP), HLS.js or MSE may encounter decoder
            // freezes, aborted fragment loads, or missing IDR keyframes.
            // If playback does not transition to 'playing' within 8 seconds:
            //   - For resume sessions: emit 'resumeseekfailed' so JellyfinPlayer can
            //     escalate to Remux or full Transcoding.
            //   - For 0:00 start: log warning for diagnostics.
            // A segment buffered less than 5 s before puts the check off until 5 s
            // after it: a cold transcode can deliver its first segment just before
            // 8 s, and restarting it then only starts another cold transcode.
            // -----------------------------------------------------------------
            const checkStart = () => {
                if (segmentsBuffered > 0 && !segmentWaitOver) return;
                this._onHlsStartTimeout(options, resumeSeconds, segmentsBuffered);
            };
            this._clearHlsStartTimeout();
            this._hlsStartTimeout = setTimeout(() => {
                this._hlsStartTimeout = null;
                startCheckDue = true;
                checkStart();
            }, HLS_START_CHECK_MS);
        });
    }

    /**
     * HLS start watchdog, 8 s after the HLS.js load began and at least 5 s
     * after its first buffered segment.
     *
     * A resume that has buffered segments but still not started points at a
     * stuck decoder (e.g. a remux cut mid-GOP), so JellyfinPlayer gets a
     * 'resumeseekfailed' and restarts at the target. A transcode that has not
     * delivered its first segment yet is just slow (a 4K transcode can take
     * longer than 8 s); restarting it would only start the transcode again.
     *
     * @private
     * @param {Object} options - Play options of the load
     * @param {number} resumeSeconds - Resume target in seconds (0 for a start from the beginning)
     * @param {number} segmentsBuffered - Segments HLS.js buffered so far
     */
    _onHlsStartTimeout(options, resumeSeconds, segmentsBuffered) {
        if (this._started || this._videoElement?.paused) return;

        if (resumeSeconds <= 0) {
            log.warn('HtmlVideoPlayer: No playback start detected after 8s');
            return;
        }
        if (options.playMethod === 'Transcode' && segmentsBuffered === 0) {
            log.warn('HtmlVideoPlayer: Transcode has not delivered its first segment after 8s — still waiting, not a failed resume');
            return;
        }
        log.warn(`HtmlVideoPlayer: HLS playback failed to start after 8s on resume (target: ${resumeSeconds.toFixed(2)}s) — emitting resumeseekfailed for transcode fallback`);
        this.onEvent({
            type: 'resumeseekfailed',
            data: { targetPositionTicks: options.playerStartPositionTicks || 0 }
        });
    }

    /**
     * Bounded recovery for one HLS.js instance (same policy as WebOSPlayer).
     *
     * - Non-fatal errors: HLS.js retries them itself; nothing to do here.
     * - Fatal network errors: retried with backoff (1 s, 2 s, 4 s); an HTTP
     *   4xx/5xx response or a fourth failure in a row gives up. A loaded
     *   fragment resets the count. A manifest that failed is requested again
     *   with loadSource(): startLoad() does not reload it.
     * - Fatal media errors: recoverMediaError(), then swapAudioCodec() +
     *   recoverMediaError(), each at most once per 3 s window (jellyfin-web's
     *   policy); a third error inside the window gives up. A decoder that keeps
     *   failing a few seconds apart gives up after three resets in all; playback
     *   30 s past every earlier reset gives a new fault a fresh budget.
     * - Other fatal errors give up straight away.
     *
     * @private
     * @param {Hls} hls
     * @param {Function} fail - (error) => void, called when recovery is exhausted
     * @param {string} [url] - Manifest URL, loaded again after a manifest error (default: hls.url)
     * @returns {{onError: Function, onFragLoaded: Function}} HLS.js event handlers
     */
    _createHlsErrorHandler(hls, fail, url) {
        let networkRetries = 0;
        let lastDecoderReset = 0;
        let lastCodecSwap = 0;
        // Decoder resets so far, and the furthest position one was made at
        let decoderResets = 0;
        let resetPosition = 0;

        const onError = (event, data) => {
            if (!data.fatal) {
                if (data.details === 'bufferStalledError') {
                    log.warn('HLS buffer low (non-fatal):', data.buffer);
                } else {
                    log.warn('HLS non-fatal error:', data.details);
                }
                return;
            }
            log.error('HLS fatal error:', data.type, data.details);

            if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
                const status = data.response?.code || 0;
                if (status >= 400 || networkRetries >= HLS_MAX_NETWORK_RETRIES) {
                    const error = new Error(`HLS network error (${data.details}${status ? `, HTTP ${status}` : ''})`);
                    error.code = 2;
                    error.isNetworkError = true;
                    fail(error);
                    return;
                }
                const delay = 1000 * Math.pow(2, networkRetries);
                networkRetries++;
                log.info(`Retrying HLS load in ${delay} ms (attempt ${networkRetries}/${HLS_MAX_NETWORK_RETRIES})`);
                // startLoad() does not request a manifest that never loaded (HLS.js 1.7:
                // with no levels it only flags a start for later), so that retry did
                // nothing and no further event came
                const reloadManifest = HLS_MANIFEST_ERRORS.indexOf(data.details) !== -1;
                setTimeout(() => {
                    if (this._hlsPlayer !== hls) return;
                    if (reloadManifest) {
                        hls.loadSource(url || hls.url);
                    } else {
                        hls.startLoad();
                    }
                }, delay);
                return;
            }

            if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
                const now = Date.now();
                // Playback went on well past every earlier reset: a new fault, not the
                // same one coming back (the playhead is at 0 while the element reloads)
                const position = this._videoElement?.currentTime || 0;
                if (position >= resetPosition + HLS_DECODER_RESET_PROGRESS_S) decoderResets = 0;
                const resetsLeft = decoderResets < HLS_MAX_DECODER_RESETS;
                if (resetsLeft && now - lastDecoderReset > HLS_MEDIA_RECOVERY_WINDOW_MS) {
                    lastDecoderReset = now;
                    log.info('Attempting to recover from media error');
                    hls.recoverMediaError();
                } else if (resetsLeft && now - lastCodecSwap > HLS_MEDIA_RECOVERY_WINDOW_MS) {
                    lastCodecSwap = now;
                    log.info('Attempting to recover from media error with audio codec swap');
                    hls.swapAudioCodec();
                    hls.recoverMediaError();
                } else {
                    const error = new Error(`HLS media error (${data.details})`);
                    error.code = 3;
                    fail(error);
                    return;
                }
                decoderResets++;
                resetPosition = Math.max(resetPosition, position);
                return;
            }

            fail(new Error(`HLS playback failed (${data.details})`));
        };

        const onFragLoaded = () => {
            networkRetries = 0;
        };

        return { onError, onFragLoaded };
    }

    /**
     * Play using native video element
     * @private
     */
    async _playNative(video, options) {
        log.info('Using native playback');

        const loadToken = this._loadToken;

        // Ensure HLS manifest exists before assigning source
        if (options.url && options.url.includes('.m3u8')) {
            await MediaHelper.pollHlsManifest(options.url, () => loadToken !== this._loadToken);
            if (loadToken !== this._loadToken) throw createAbortError();
        }

        // Set cross-origin if needed
        const crossOrigin = MediaHelper.getCrossOriginValue(options.mediaSource);
        if (crossOrigin) {
            video.crossOrigin = crossOrigin;
        }

        // ====================================================================
        // PROGRESSIVE STREAM URL SETUP:
        // Use clean stream URL without media fragments (#t=).
        // Resume positioning is handled reliably by _applyPlaybackResume
        // after loadedmetadata, avoiding concurrent Range request storms.
        // ====================================================================
        const url = options.url;
        const resumeSeconds = (options.playerStartPositionTicks || 0) / 10000000;

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
            let seekPlayTimer = null;
            let onSeeked = null;

            // Remove this load's one-shot listeners (they would otherwise run for the next item)
            const removeListeners = () => {
                video.removeEventListener('loadedmetadata', onLoadedMetadata);
                video.removeEventListener('canplay', onCanPlay);
                video.removeEventListener('error', onError);
                if (onSeeked) video.removeEventListener('seeked', onSeeked);
                clearTimeout(seekTimeout);
                clearTimeout(seekPlayTimer);
            };

            const resolveOnce = (value) => {
                if (!seekResolved) {
                    seekResolved = true;
                    resolve(value);
                }
            };

            const rejectOnce = (reason) => {
                if (!seekResolved) {
                    seekResolved = true;
                    reject(reason);
                }
            };

            // stop() / a newer play() abandons this load
            this._abortPendingLoad = () => {
                removeListeners();
                rejectOnce(createAbortError());
            };

            // The resume follow-up belongs to this load only
            const applyResume = () => {
                if (loadToken === this._loadToken) this._applyPlaybackResume(video, options);
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
                            applyResume();
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
                                            applyResume();
                                            resolveOnce();
                                        })
                                        .catch(rejectOnce);
                                } else {
                                    this._scheduleUnmuteOnInteraction(video);
                                    applyResume();
                                    resolveOnce();
                                }
                            } else {
                                rejectOnce(err);
                            }
                        });
                } else {
                    applyResume();
                    resolveOnce();
                }
            };

            const onLoadedMetadata = () => {
                video.removeEventListener('loadedmetadata', onLoadedMetadata);

                // Check if the media fragment naturally landed us at the target (within 15s GOP keyframe tolerance)
                const currentPos = video.currentTime || 0;
                const fragmentDrift = Math.abs(currentPos - resumeSeconds);
                if (resumeSeconds > 0 && currentPos > 0.5 && (fragmentDrift < 15 || currentPos >= (resumeSeconds - 15))) {
                    log.info('HtmlVideoPlayer: Media fragment seek (#t=) successfully applied natively');
                    seekCompleted = true;
                    // Media fragment landed natively at resume point; reveal video surface
                    this._restoreVideoAfterResume(video);
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

                // The media fragment (#t=) can land the playhead only after
                // 'loadedmetadata' (webOS does). Seeking to where the playhead already
                // is fires no 'seeked' there, so every resume waited the full 10 s
                // failsafe below before it started playing.
                const currentPos = video.currentTime || 0;
                if (resumeSeconds > 0 && !seekCompleted && currentPos > 0.5 && Math.abs(currentPos - resumeSeconds) < 15) {
                    log.info('HtmlVideoPlayer: Media fragment positioned the playhead by canplay — skipping explicit seek');
                    seekCompleted = true;
                }

                // If we need to resume and haven't landed at the target yet,
                // perform a seek-then-play: set currentTime and wait for seeked.
                if (resumeSeconds > 0 && !seekCompleted) {
                    log.info('HtmlVideoPlayer: Seeking to resume position', resumeSeconds, 's at canplay');

                    let playbackStarted = false;
                    const startOnce = () => {
                        if (playbackStarted) return;
                        playbackStarted = true;
                        clearTimeout(seekPlayTimer);
                        startPlayback();
                    };

                    onSeeked = () => {
                        video.removeEventListener('seeked', onSeeked);
                        clearTimeout(seekTimeout);
                        seekCompleted = true;

                        const drift = Math.abs(video.currentTime - resumeSeconds);
                        log.debug(`HtmlVideoPlayer: Seek completed (current: ${video.currentTime.toFixed(2)} s, target: ${resumeSeconds} s, drift: ${drift.toFixed(2)} s)`);
                        // The native seek completed and the actual target resume frame is decoded;
                        // safely restore sound and picture (and play, if not started yet).
                        this._endResumeSuppression(video);
                        startOnce();
                    };

                    video.addEventListener('seeked', onSeeked);

                    // Initiate the seek
                    video.currentTime = resumeSeconds;

                    // ---------------------------------------------------------
                    // Some pipelines carry out a seek on a paused element only
                    // once playback starts. On webOS 'seeking' stays true and no
                    // 'seeked' comes while paused (LG C4, webOS 25: 'seeked'
                    // arrived 1.2 s after play()), so every resume sat out the
                    // 10 s failsafe below. Start playback right away there, and
                    // elsewhere after a short grace period; the picture stays
                    // hidden until 'seeked'.
                    // ---------------------------------------------------------
                    seekPlayTimer = setTimeout(() => {
                        if (!seekCompleted) {
                            log.info('HtmlVideoPlayer: Starting playback while the resume seek is pending');
                        }
                        startOnce();
                    }, platformInfo.isWebOS ? 0 : RESUME_SEEK_PLAY_GRACE_MS);

                    // Failsafe: if the seek never completes (e.g. server doesn't
                    // support Range requests), show the picture anyway after 10 s
                    seekTimeout = setTimeout(() => {
                        video.removeEventListener('seeked', onSeeked);
                        if (!seekCompleted) {
                            log.warn('HtmlVideoPlayer: Seek timed out after 10s — continuing from current position');
                            seekCompleted = true;
                            this._endResumeSuppression(video);
                            startOnce();
                        }
                    }, 10000);
                } else {
                    // No resume needed, or media fragment already put us at target
                    this._restoreVideoAfterResume(video);
                    startPlayback();
                }
            };

            const onError = () => {
                const err = video.error;
                log.error('Native video error:', err);
                this._restoreVideoAfterResume(video);
                removeListeners();
                rejectOnce(err);
            };

            video.addEventListener('loadedmetadata', onLoadedMetadata);
            video.addEventListener('canplay', onCanPlay);
            video.addEventListener('error', onError);
        });
    }

    /**
     * Check if player is actively seeking
     * @returns {boolean} True if HTML5 video is seeking
     */
    get isSeeking() {
        return Boolean(this._videoElement?.seeking);
    }

    /**
     * Pause playback
     */
    pause() {
        // Disarm any queued post-seek unpause operations so an explicit pause halts playback
        const cancelledPlay = this._pendingPlayAfterSeek;
        this._pendingPlayAfterSeek = false;
        const video = this._videoElement;
        if (!video) return;
        if (video.paused) {
            // A play queued behind a seek never started the element, so no 'pause'
            // event will come. JellyfinPlayer already counts playback as resumed and
            // took every later Play press for a pause (LG C4: Play did nothing until
            // the user left the item), so report the pause here.
            if (cancelledPlay) this.onEvent({ type: 'pause' });
            return;
        }
        video.pause();
    }

    /**
     * Resume playback
     */
    unpause() {
        if (!this._videoElement) return;

        /*
         * ====================================================================
         * ACTIVE SEEK PLAYBACK GUARD
         * ====================================================================
         * If the HTML5 media element is currently seeking (video.seeking === true),
         * calling video.play() immediately unpauses playback of the stale pre-seek
         * buffer while the demuxer is still fetching the target keyframe.
         * Queue the play command to execute in _onSeeked once repositioning completes.
         *
         * webOS carries out a seek on a paused element only once playback starts,
         * so 'seeked' may never come: start playback anyway SEEK_PLAY_FALLBACK_MS
         * later, and at once when unpause() is asked again meanwhile.
         * ====================================================================
         */
        if (this._videoElement.seeking) {
            if (this._pendingPlayAfterSeek) {
                log.info('HtmlVideoPlayer: unpause() again while the seek is pending — starting playback now');
                this._pendingPlayAfterSeek = false;
                this._playVideo();
                return;
            }
            log.debug('HtmlVideoPlayer: seek in progress — queueing play on seeked');
            this._pendingPlayAfterSeek = true;
            clearTimeout(this._seekPlayFallbackTimer);
            this._seekPlayFallbackTimer = setTimeout(() => {
                this._seekPlayFallbackTimer = null;
                if (!this._pendingPlayAfterSeek) return;
                this._pendingPlayAfterSeek = false;
                log.info(`HtmlVideoPlayer: no 'seeked' ${SEEK_PLAY_FALLBACK_MS} ms after unpause() — starting playback, which completes the seek`);
                this._playVideo();
            }, SEEK_PLAY_FALLBACK_MS);
            return;
        }

        this._pendingPlayAfterSeek = false;
        this._playVideo();
    }

    /** video.play() with the autoplay-policy retry. @private */
    _playVideo() {
        const video = this._videoElement;
        if (!video) return;
        video.play().catch((err) => {
            if (err.name === 'NotAllowedError') {
                log.warn('unpause: Autoplay blocked — retrying muted.');
                video.muted = true;
                video.play().catch(e => log.error('unpause: Muted retry failed', e));
            } else {
                log.error('unpause: Play failed', err);
            }
        });
    }

    /**
     * Stop playback
     */
    async stop() {
        // Pending load, seek verification, resume follow-up and stall timers
        this._endPlaybackSession();
        this._clearHlsStartTimeout();
        this._destroyHlsPlayer();

        const video = this._videoElement;

        // ====================================================================
        // Clean Up Resume Audio Suppression:
        // If playback was stopped or cancelled before the playing event unmuted,
        // restore muted status so future playback is not muted unintentionally.
        // ====================================================================
        if (this._resumeAudioSuppressed && video) {
            video.muted = false;
        }
        this._resumeAudioSuppressed = false;

        // Restore video element presentation if stopped while resume was in flight
        if (this._resumeVideoSuppressed && video) {
            this._restoreVideoAfterResume(video);
        }
        this._resumeVideoSuppressed = false;

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

        // --------------------------------------------------------------------
        // Audio normalization: an element routed into Web Audio cannot be routed
        // back, and closing its AudioContext silences it. Release the graph with
        // the element; the next item starts on a fresh <video>.
        // --------------------------------------------------------------------
        if (this._audioGraph) {
            this._replaceVideoElement();
        }

        this._currentSrc = null;
        this._currentPlayOptions = null;
        this._started = false;
        this._timeUpdated = false;
        this._hlsManifestDuration = null;
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

        // ---------------------------------------------------------------------
        // Defer timeupdate to native demuxer arrival:
        // Do NOT fire a synthetic timeupdate here with targetSeconds. In HLS
        // (especially with transcoded audio and direct-streamed video), the
        // underlying browser demuxer lands on the nearest GOP keyframe, which
        // may differ by 1–5 seconds from targetSeconds. Emitting a synthetic
        // timeupdate prematurely causes SubtitleManager and the UI clock to desync
        // before the presentation time is settled.
        // The authoritative timeupdate will fire from _onSeeked once the hardware
        // demuxer completes repositioning.
        // ---------------------------------------------------------------------

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
                this._directSeekVerifyTimeout = null;
                if (!this._videoElement) return;
                const cur = this.getCurrentTime();
                const drift = Math.abs(cur - targetSeconds);
                // Distance either way: a backward seek that did not land stays past
                // the target (while a seek is pending, currentTime reports the target)
                const isNear = drift < 15;
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
     * Suppress video element presentation during resume seek operations.
     * Prevents stale pre-seek or timestamp 0:00 video frames from rendering
     * onto the screen before the decoder finishes seeking to the resume target.
     *
     * @private
     * @param {HTMLVideoElement} video - The HTML5 video element
     */
    _suppressVideoForResume(video) {
        if (!video) return;
        this._resumeVideoSuppressed = true;
        // Apply both zero opacity and hidden visibility for robust compositor handling
        video.style.opacity = '0';
        video.style.visibility = 'hidden';
        log.debug('HtmlVideoPlayer: Suppressed video visibility for resume');
    }

    /**
     * Restore video element presentation once the resume position is landed.
     * Re-reveals the video element displaying the confirmed target resume frame.
     *
     * @private
     * @param {HTMLVideoElement} [video] - The HTML5 video element (optional, defaults to _videoElement)
     */
    _restoreVideoAfterResume(video) {
        if (!this._resumeVideoSuppressed) return;
        this._resumeVideoSuppressed = false;
        const targetVideo = video || this._videoElement;
        if (targetVideo) {
            targetVideo.style.opacity = '';
            targetVideo.style.visibility = '';
            log.debug('HtmlVideoPlayer: Restored video visibility after resume landing');
        }
    }

    /**
     * End the resume mute and hide: the playhead is at the resume point.
     * @private
     * @param {HTMLVideoElement} [video] - The HTML5 video element (defaults to _videoElement)
     */
    _endResumeSuppression(video) {
        this._cancelResumeRevealOnSeeked();
        if (this._resumeAudioSuppressed) {
            this._resumeAudioSuppressed = false;
            this.setMuted(false);
        }
        if (this._resumeVideoSuppressed) {
            this._restoreVideoAfterResume(video || this._videoElement);
        }
    }

    /**
     * 'playing' arrived while the resume seek is still in flight: keep the
     * pre-seek frame and sound hidden until 'seeked' (or a failsafe).
     * @private
     * @param {HTMLVideoElement} video - The HTML5 video element
     */
    _revealResumeOnSeeked(video) {
        if (this._resumeRevealOnSeeked) return;
        const reveal = () => this._endResumeSuppression(video);
        this._resumeRevealOnSeeked = { video, reveal, timer: setTimeout(reveal, RESUME_REVEAL_FAILSAFE_MS) };
        video.addEventListener('seeked', reveal);
    }

    /** @private */
    _cancelResumeRevealOnSeeked() {
        const pending = this._resumeRevealOnSeeked;
        if (!pending) return;
        this._resumeRevealOnSeeked = null;
        clearTimeout(pending.timer);
        pending.video.removeEventListener('seeked', pending.reveal);
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
        // assignment was too early (buffer not yet ready). Cleared by stop()/play().
        clearTimeout(this._resumeFollowUpTimeout);
        this._resumeFollowUpTimeout = setTimeout(() => {
            this._resumeFollowUpTimeout = null;
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
            if (listIndex === 0) {
                // listIndex 0 = the default/first track, which is already playing.
                // No need to restart — the stream is serving the right track regardless
                // of whether the browser exposes audioTracks (it often doesn't for
                // direct-play progressive files on HTML5 / WebOS / Tizen).
                log.info('HtmlVideoPlayer: audioTracks empty but listIndex=0 (default track) — no restart needed.');
                return;
            }
            // listIndex > 0: user wants a non-default track the player can't switch to
            // natively. Escalate to JellyfinPlayer so it can restart with remux/DirectStream.
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

        // Handle native text tracks (HLS-embedded VTT, etc.).
        // Unselected tracks must be set to 'disabled' rather than 'hidden'.
        // Under the HTML5 specification, a 'hidden' track remains active, continuing
        // to download media fragments, parse cues, and fire cue events in the background.
        // Marking unselected tracks 'disabled' stops background parsing and network usage.
        const textTracks = video.textTracks;
        if (textTracks) {
            for (let i = 0; i < textTracks.length; i++) {
                textTracks[i].mode = (i === index) ? 'showing' : 'disabled';
            }
        }

        // A track switch resets the offset; cues of a track shown earlier are
        // moved back by the offset they still carry
        this._subtitleOffset = 0;
        this._applySubtitleOffset();

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
     * Retrieve active video stream dimensions and presentation Display Aspect Ratio (DAR).
     *
     * Non-square pixel streams (such as standard-definition DVD remuxes in NTSC 720x480
     * or PAL 720x576) store frames using rectangular pixels. By default, HTML5 <video> elements
     * calculate display bounds solely from videoWidth / videoHeight, distorting NTSC 4:3 DVDs
     * to a squashed 3:2 frame. This method inspects media source and container stream metadata
     * to resolve the intended DAR.
     *
     * @private
     * @returns {{width: number, height: number, aspectRatio: number, isAnamorphic: boolean}}
     */
    _getVideoDimensions() {
        const video = this._videoElement;
        let vw = video?.videoWidth || 0;
        let vh = video?.videoHeight || 0;
        let aspectStr = '';

        // Query active HLS variant if running HLS.js
        if ((!vw || !vh) && this._hlsPlayer) {
            const level = this._hlsPlayer.levels?.[this._hlsPlayer.currentLevel];
            if (level?.width && level?.height) {
                vw = level.width;
                vh = level.height;
            }
        }

        // Query Jellyfin MediaSource metadata
        const mediaSource = this._currentPlayOptions?.mediaSource;
        if (mediaSource) {
            if (!vw || !vh) {
                vw = mediaSource.Width || 0;
                vh = mediaSource.Height || 0;
            }
            if (Array.isArray(mediaSource.MediaStreams)) {
                const videoStream = mediaSource.MediaStreams.find((s) => s && s.Type === 'Video');
                if (videoStream) {
                    if (!vw || !vh) {
                        vw = videoStream.Width || 0;
                        vh = videoStream.Height || 0;
                    }
                    if (videoStream.AspectRatio) {
                        aspectStr = String(videoStream.AspectRatio);
                    }
                }
            }
            if (!aspectStr && mediaSource.AspectRatio) {
                aspectStr = String(mediaSource.AspectRatio);
            }
        }

        // Query Jellyfin Item metadata
        const item = this._currentPlayOptions?.item;
        if (item) {
            if (!vw || !vh) {
                vw = item.Width || 0;
                vh = item.Height || 0;
            }
            if (!aspectStr) {
                const streams = item.MediaStreams || item.MediaSources?.[0]?.MediaStreams;
                if (Array.isArray(streams)) {
                    const videoStream = streams.find((s) => s && s.Type === 'Video');
                    if (videoStream?.AspectRatio) {
                        aspectStr = String(videoStream.AspectRatio);
                    }
                }
            }
            if (!aspectStr && item.AspectRatio) {
                aspectStr = String(item.AspectRatio);
            }
        }

        // Parse AspectRatio string into numeric ratio
        let parsedRatio = 0;
        if (aspectStr && typeof aspectStr === 'string') {
            if (aspectStr.includes(':')) {
                const parts = aspectStr.split(':');
                const num = parseFloat(parts[0]);
                const den = parseFloat(parts[1]);
                if (num > 0 && den > 0) {
                    parsedRatio = num / den;
                }
            } else {
                const val = parseFloat(aspectStr);
                if (!isNaN(val) && val > 0) {
                    parsedRatio = val;
                }
            }
        }

        // Evaluate Anamorphic / Non-Square Pixel Geometry
        let isAnamorphic = false;
        if (vw > 0 && vh > 0 && parsedRatio > 0) {
            const storageRatio = vw / vh;
            if (Math.abs(storageRatio - parsedRatio) > 0.05) {
                isAnamorphic = true;
            }
        } else if (parsedRatio <= 0 && vw > 0 && vh > 0) {
            parsedRatio = vw / vh;
        }

        return {
            width: vw,
            height: vh,
            aspectRatio: parsedRatio > 0 ? parsedRatio : 0,
            isAnamorphic
        };
    }

    /**
     * Compute and apply layout geometry to the HTML5 <video> element.
     *
     * In standard HTML5 video, object-fit: contain relies on intrinsic videoWidth / videoHeight.
     * For non-square pixel (anamorphic) video, the browser assumes square pixels and distorts
     * the image. By calculating the exact target layout bounding box and centering it,
     * we guarantee that non-square pixel content (such as NTSC/PAL DVD remuxes) renders in
     * the intended display aspect ratio (e.g., 4:3 or 16:9).
     *
     * @private
     */
    _applyDisplayGeometry() {
        const video = this._videoElement;
        if (!video) return;

        // Container dimensions with viewport fallback
        const cw = (this.container && this.container.clientWidth) || (typeof window !== 'undefined' ? window.innerWidth : 1920) || 1920;
        const ch = (this.container && this.container.clientHeight) || (typeof window !== 'undefined' ? window.innerHeight : 1080) || 1080;
        const style = video.style;

        const mode = this._aspectRatio || 'auto';

        // --------------------------------------------------------------------
        // Mode 1: Fullscreen Stretch
        // --------------------------------------------------------------------
        if (mode === 'stretch') {
            style.position = 'absolute';
            style.left = '0px';
            style.top = '0px';
            style.width = '100%';
            style.height = '100%';
            style.objectFit = 'fill';
            style.objectPosition = 'center';
            log.info('Setting aspect ratio (stretch): 100% fill');
            return;
        }

        // --------------------------------------------------------------------
        // Mode 2: Zoom / Cover
        // --------------------------------------------------------------------
        if (mode === 'zoom') {
            style.position = 'absolute';
            style.left = '0px';
            style.top = '0px';
            style.width = '100%';
            style.height = '100%';
            style.objectFit = 'cover';
            style.objectPosition = 'center';
            log.info('Setting aspect ratio (zoom): 100% cover');
            return;
        }

        // --------------------------------------------------------------------
        // Mode 3: Auto (Contain / Anamorphic DAR Correction)
        // --------------------------------------------------------------------
        const dims = this._getVideoDimensions();
        if (dims.isAnamorphic && dims.aspectRatio > 0) {
            const targetRatio = dims.aspectRatio;
            const containerRatio = cw / ch;
            let targetW = cw;
            let targetH = ch;
            let targetLeft = 0;
            let targetTop = 0;

            if (targetRatio < containerRatio) {
                // Taller/narrower than viewport (e.g. 4:3 inside 16:9 screen) -> Pillarbox
                targetH = Math.round(ch);
                targetW = Math.round(ch * targetRatio);
                targetLeft = Math.round((cw - targetW) / 2);
                targetTop = 0;
            } else if (targetRatio > containerRatio) {
                // Wider than viewport (e.g. Cinemascope inside 16:9 screen) -> Letterbox
                targetW = Math.round(cw);
                targetH = Math.round(cw / targetRatio);
                targetLeft = 0;
                targetTop = Math.round((ch - targetH) / 2);
            }

            // Set explicit bounding box coordinates and stretch frame into DAR box
            style.position = 'absolute';
            style.left = `${targetLeft}px`;
            style.top = `${targetTop}px`;
            style.width = `${targetW}px`;
            style.height = `${targetH}px`;
            style.objectFit = 'fill';
            style.objectPosition = 'center';
            log.info('Setting aspect ratio (auto anamorphic DAR correction):', {
                x: targetLeft,
                y: targetTop,
                width: targetW,
                height: targetH,
                aspectRatio: targetRatio
            });
            return;
        }

        // Standard square-pixel content in auto mode
        style.position = 'absolute';
        style.left = '0px';
        style.top = '0px';
        style.width = '100%';
        style.height = '100%';
        style.objectFit = 'contain';
        style.objectPosition = 'center';
        log.info('Setting aspect ratio (auto): 100% contain');
    }

    /**
     * Set aspect ratio mode
     * @param {string} mode - 'auto', 'zoom', 'stretch'
     */
    setAspectRatio(mode) {
        this._aspectRatio = mode || 'auto';
        this._applyDisplayGeometry();
    }

    /**
     * Get current aspect ratio mode
     * @returns {string} 'auto', 'zoom', 'stretch'
     */
    getAspectRatio() {
        return this._aspectRatio || 'auto';
    }

    /**
     * Set subtitle offset by shifting VTT cue timing.
     * Positive offset = subtitles display later, negative = earlier.
     * @param {number} seconds - New absolute offset in seconds
     */
    setSubtitleOffset(seconds) {
        this._subtitleOffset = seconds;
        this._applySubtitleOffset();
    }

    /**
     * Bring the cues of every showing native track to _subtitleOffset. Each
     * cue's times without the offset are kept in _cueBaseTimes from when it is
     * first seen here, so switching tracks and back never doubles the offset,
     * and cues added since (HLS.js WebVTT segments, a track still loading),
     * which carry none yet, get it too.
     * @private
     */
    _applySubtitleOffset() {
        const seconds = this._subtitleOffset;
        const video = this._videoElement;
        if (!video || !video.textTracks) {
            log.debug(`HtmlVideoPlayer: Subtitle offset stored: ${seconds}s (no video/tracks)`);
            return;
        }

        // Iterate through all native text tracks attached to the video element
        for (let i = 0; i < video.textTracks.length; i++) {
            const track = video.textTracks[i];
            // Only apply offsets to actively rendered tracks with parsed cues
            if (track.mode !== 'showing' || !track.cues) continue;

            for (let j = 0; j < track.cues.length; j++) {
                const cue = track.cues[j];
                let base = this._cueBaseTimes.get(cue);
                if (!base) {
                    // Not shifted yet: only this method moves cues
                    base = [cue.startTime, cue.endTime];
                    this._cueBaseTimes.set(cue, base);
                }
                if (cue.startTime !== base[0] + seconds) cue.startTime = base[0] + seconds;
                if (cue.endTime !== base[1] + seconds) cue.endTime = base[1] + seconds;
            }
            log.debug(`HtmlVideoPlayer: Subtitle offset applied: ${seconds}s`);
        }
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
        const now = monotonicNow();

        // Throttle by elapsed time, not by media time, to spare slow TVs bursts.
        // Requiring the media time to move by more than 0.25 s dropped every
        // other event at webOS's ~156 ms cadence, so external subtitles (ticked
        // only from these events) changed on a ~0.3 s grid. A jump of a second
        // or more (seek, new stream) is forwarded at once.
        const jumped = Math.abs(currentTimeTicks - this._lastTimeUpdateTicks) >= 10000000;
        if (jumped || now - this._lastTimeUpdateAt >= TIMEUPDATE_MIN_INTERVAL_MS) {
            this._lastTimeUpdateTicks = currentTimeTicks;
            this._lastTimeUpdateAt = now;
            this.onEvent({ type: 'timeupdate', data: { time: currentTime } });
        }
    }

    /** @private */
    _onEnded() {
        log.info('Playback ended');
        this.onEvent({ type: 'ended' });
    }

    /**
     * HLS.js owns the MediaSource and resets it after a media element error (it reports
     * mediaSourceRequiresReset), so leave the first such failure of an HLS.js session to it.
     * HLS.js clears its retry count on every successful append, so it never gives up on a failure
     * that recurs after appending; a second failure is therefore reported as usual.
     * @private
     * @param {HTMLVideoElement} video
     * @returns {boolean} True if HLS.js is left to recover from video.error
     */
    _leaveErrorToHls(video) {
        const error = video?.error;
        if (!this._hlsPlayer || !error) return false;
        // The 'error' event and the rejected play() report the same failure
        if (error === this._hlsRecoveringError) return true;
        if (this._hlsRecoveringError) return false;
        this._hlsRecoveringError = error;
        log.warn(`HtmlVideoPlayer: Media error ${error.code} during HLS.js playback — leaving recovery to HLS.js`);
        return true;
    }

    /** @private */
    _onError(e) {
        const video = e.target;

        // Ignore errors if we don't have a source and no HLS player is active.
        // This commonly happens during stop/cleanup when src is removed.
        if (!video.src && !this._hlsPlayer && (!video.firstChild || !video.firstChild.src)) {
            log.debug('Ignoring error event on empty source during cleanup');
            return;
        }

        const formatted = MediaHelper.formatMediaError(video.error);
        log.error(`HtmlVideoPlayer: Error ${formatted.code} (${formatted.name}): ${formatted.message}`);

        const isNetworkError = formatted.code === 2 || /network|connection|pipeline_error_network/i.test(formatted.message);
        const reportError = () => {
            this.onEvent({
                type: 'error',
                data: {
                    ...formatted,
                    isNetworkError
                }
            });
        };

        // ---------------------------------------------------------------------
        // HLS.js does not recover from errors of the <video> element itself (it
        // only logs them). A decode error goes through the same bounded recovery
        // as HLS.js's own fatal media errors — a decoder reset, then a codec swap,
        // then a reported failure — instead of an unlimited recoverMediaError().
        // Its 3 s window keeps an element error and an HLS.js error for the same
        // fault from resetting the decoder twice.
        // ---------------------------------------------------------------------
        const hlsHandling = this._hlsElementErrorHandler;
        if (formatted.code === 3 && this._hlsPlayer && hlsHandling && hlsHandling.hls === this._hlsPlayer) {
            log.warn('HtmlVideoPlayer: Decode error during HLS.js playback — recovering');
            hlsHandling.onError(null, {
                fatal: true,
                type: Hls.ErrorTypes.MEDIA_ERROR,
                details: 'mediaElementDecodeError'
            });
            return;
        }

        if (this._leaveErrorToHls(video)) {
            // Report it after all if HLS.js has not reset the MediaSource within 10s
            const error = video.error;
            setTimeout(() => {
                if (video.error === error) reportError();
            }, 10000);
            return;
        }

        reportError();
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
        // ====================================================================
        // Unmute After Safe Resume:
        // Resume playback has transitioned to the active 'playing' state at the
        // target timestamp: restore the sound and picture suppressed for resume.
        // webOS carries out a resume seek on a paused element only once playback
        // starts, and fires 'playing' about a second before 'seeked' (LG C4,
        // webOS 25). Lifting the suppression then would show the frame and
        // sound from before the resume point, so wait for 'seeked'.
        // ====================================================================
        const video = this._videoElement;
        if ((this._resumeAudioSuppressed || this._resumeVideoSuppressed) && video && video.seeking) {
            this._revealResumeOnSeeked(video);
        } else {
            this._endResumeSuppression(video);
        }

        if (!this._started) {
            this._started = true;
            log.info('Playback started');
            this.onEvent({ type: 'playbackstart' });
        }
        this._clearHlsStartTimeout();
        this._clearStallCheck();
        this._elementWaiting = false;
        this.onEvent({ type: 'playing' });
    }

    /** @private */
    _onWaiting() {
        this._elementWaiting = true;
        this.onEvent({ type: 'waiting' });
        this._startStallCheck();
    }

    /** @private */
    _onStalled() {
        // 'stalled' only says that no media data arrived for about 3 s. With a
        // full buffer that is the download pausing, not an underrun (a real one
        // also fires 'waiting'): no spinner and no network-health ping for it.
        // The stall check still runs and does nothing while the playhead moves.
        const video = this._videoElement;
        const bufferAhead = this._getBufferAhead();
        if (video && video.readyState >= 3 && bufferAhead >= STALLED_HEALTHY_BUFFER_S) {
            log.debug('Stalled with', bufferAhead.toFixed(1), 's buffered — download paused, not an underrun');
        } else {
            log.warn('Playback stalled');
            this.onEvent({ type: 'waiting' });
        }
        this._startStallCheck();
    }

    /**
     * Seconds buffered ahead of the playhead in the range that contains it.
     * @private
     * @returns {number}
     */
    _getBufferAhead() {
        const video = this._videoElement;
        if (!video || !video.buffered) return 0;
        const current = video.currentTime;
        try {
            for (let i = 0; i < video.buffered.length; i++) {
                if (video.buffered.start(i) <= current && current < video.buffered.end(i)) {
                    return Math.max(0, video.buffered.end(i) - current);
                }
            }
        } catch (e) {
            // buffered can be briefly unreadable while the source changes
        }
        return 0;
    }

    /** @private */
    _onSeeking() {
        const video = this._videoElement;
        // Only show spinner if we are NOT paused (real buffering during playback)
        this._seekWhilePlaying = Boolean(video && !video.paused);
        if (this._seekWhilePlaying) {
            this.onEvent({ type: 'waiting' });
        }
    }

    /** @private */
    _onSeeked() {
        const video = this._videoElement;

        // ---------------------------------------------------------------------
        // Demuxer Landed Confirmation:
        // Dispatch the official 'seeked' event so orchestrator clears seeking lock.
        // ---------------------------------------------------------------------
        this.onEvent({ type: 'seeked' });

        /*
         * Execute queued play command if unpause() was called while seek was in flight
         */
        if (this._pendingPlayAfterSeek) {
            this._pendingPlayAfterSeek = false;
            this.unpause();
        }

        // ---------------------------------------------------------------------
        // Accurate Post-Seek Presentation Timestamp:
        // Emit a timeupdate using the media element's true landed currentTime.
        // In HLS (particularly with transcoded audio and direct-streamed video),
        // the hardware demuxer snaps to the nearest GOP keyframe. Reporting
        // the actual position ensures subtitles and the OSD timeline stay
        // strictly synchronized with the hardware video presentation clock.
        // ---------------------------------------------------------------------
        this.onEvent({
            type: 'timeupdate',
            data: { time: this.getCurrentTime() }
        });

        // ---------------------------------------------------------------------
        // A seek during playback ends the spinner of _onSeeking() with 'playing'.
        // The element fires that itself when the seek dropped its readyState
        // (it fired 'waiting' then). A seek inside the buffer can complete
        // without either: report 'playing' here for it, once the element plays
        // on with data ahead (not at HAVE_CURRENT_DATA).
        // ---------------------------------------------------------------------
        const seekWhilePlaying = this._seekWhilePlaying;
        this._seekWhilePlaying = false;
        if (seekWhilePlaying && !this._elementWaiting && video && !video.paused && video.readyState >= 3) {
            this._onPlaying();
        }
        this._clearStallCheck();
    }

    /** @private */
    _startStallCheck() {
        this._clearStallCheck();
        
        // Immediate check if navigator is already explicitly offline
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
            log.warn('Playback stalled while navigator is offline — emitting network error early');
            this.onEvent({
                type: 'error',
                data: {
                    code: 2,
                    message: 'MEDIA_ERR_NETWORK: Playback stalled while offline',
                    isNetworkError: true
                }
            });
            return;
        }

        // If we stay in waiting/stalled for too long on Tizen, try to kick it
        const video = this._videoElement;
        const timeAtStall = video ? video.currentTime : 0;
        this._stallTimer = setTimeout(() => {
            this._stallTimer = null;
            if (this._videoElement && !this._videoElement.paused && this._started) {
                // The playhead moved on: playback recovered by itself (or never stopped)
                if (this._videoElement === video && Math.abs(video.currentTime - timeAtStall) >= STALL_PROGRESS_S) {
                    log.debug('Playback moved on during the stall check — no recovery kick');
                    return;
                }
                log.warn('Playback still stalled after 3.5s - attempting recovery kick');
                
                // If navigator turned offline during stall, fire network error immediately
                if (typeof navigator !== 'undefined' && navigator.onLine === false) {
                    this.onEvent({
                        type: 'error',
                        data: {
                            code: 2,
                            message: 'MEDIA_ERR_NETWORK: Playback stalled while offline',
                            isNetworkError: true
                        }
                    });
                    return;
                }

                try {
                    // Small jump to trigger buffer re-evaluation. The webOS media
                    // engine ignores a jump inside the decoded frame, so it gets the
                    // 0.5 s WebOSPlayer uses, enough to re-initialise the decoder.
                    this._videoElement.currentTime += platformInfo.isWebOS ? STALL_KICK_WEBOS_S : STALL_KICK_S;
                } catch (e) {
                    log.error('Stall recovery kick failed:', e);
                }
            }
        }, 3500);
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
        this._applyDisplayGeometry();
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
     * Clear startup HLS detection timer
     * @private
     */
    _clearHlsStartTimeout() {
        if (this._hlsStartTimeout) {
            clearTimeout(this._hlsStartTimeout);
            this._hlsStartTimeout = null;
        }
        clearTimeout(this._hlsSegmentWaitTimeout);
        this._hlsSegmentWaitTimeout = null;
    }

    /**
     * Destroy HLS.js player
     * @private
     */
    _destroyHlsPlayer() {
        this._clearHlsStartTimeout();
        if (this._hlsPlayer) {
            try {
                this._hlsPlayer.destroy();
            } catch (e) {
                log.error('Error destroying HLS player:', e);
            }
            this._hlsPlayer = null;
        }
        this._hlsElementErrorHandler = null;
    }

    /**
     * Destroy the player and clean up
     */
    destroy() {
        this.stop();
        this._releaseAudioGraph();
        this._closeAudioContext();

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
