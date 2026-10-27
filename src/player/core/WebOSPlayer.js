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
import { customHeaders } from '../../utils/CustomHeaders.js';
import { api } from '../../api/ApiClient.js';
import { logger } from '../../utils/Logger.js';
import { PlayerSettings } from '../../utils/PlayerSettings.js';
import { platformInfo } from '../../utils/PlatformInfo.js';
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

/**
 * Verify whether an audio track is natively decodable by the WebOS hardware media engine.
 *
 * WebOS natively decodes standard web audio (AAC, MP3, AC3, E-AC3, PCM), and can pass through
 * discrete DTS streams when DTS decode/passthrough is enabled in settings and supported by the TV.
 * However, Dolby TrueHD and 7.1/lossless streams cannot be decoded by internal WebOS web apps.
 *
 * @param {Object} stream - Audio stream metadata from MediaStreams
 * @returns {boolean} True if WebOS hardware can play this track natively in DirectPlay
 */
const isWebOSAudioTrackPlayable = (stream) => {
    if (!stream || !stream.Codec) return true;
    const codec = stream.Codec.toLowerCase();

    // Dolby TrueHD: WebOS web applications lack native decode or bitstream capability for TrueHD
    if (codec === 'truehd' || codec === 'mlp') return isTrueHdSupported();

    // DTS / DTS-HD / DCA multi-channel surround tracks
    if (codec.includes('dts') || codec === 'dca') return isDtsSupported();

    // ALAC / FLAC channels constraint check
    if (codec === 'alac' && !PlayerSettings.get('enableFlacInVideo')) return false;
    if (codec === 'flac' && typeof stream.Channels === 'number' && stream.Channels > 2) return false;

    return true;
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

/**
 * Load watchdogs: longest wait from load() to 'canplay' while the media
 * pipeline reports no progress at all. 'loadedmetadata' and 'progress' re-arm
 * the timer, so slow but working servers are not cut off.
 */
const LOAD_WATCHDOG_HLS_MS = 60000;
const LOAD_WATCHDOG_DIRECT_MS = 30000;

/**
 * After a native HLS load that got no data at all: how long the server gets
 * to answer a playlist request before the load counts as a network failure.
 */
const SERVER_PROBE_TIMEOUT_MS = 5000;

/** Polls (300 ms apart) of _applyRobustResume waiting for a seekable state. */
const ROBUST_RESUME_MAX_POLLS = 40;

/** Hls.js fatal network errors retried (1 s, 2 s, 4 s apart) before giving up. */
const HLS_MAX_NETWORK_RETRIES = 3;

/** Fatal Hls.js errors of the manifest request: retried with loadSource(), not startLoad(). */
const HLS_MANIFEST_ERRORS = [
    Hls.ErrorDetails.MANIFEST_LOAD_ERROR,
    Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT,
    Hls.ErrorDetails.MANIFEST_PARSING_ERROR
];

/**
 * Hls.js fatal media errors: a decoder reset, then a codec swap, are each
 * allowed once per window — like jellyfin-web's handleHlsJsMediaError().
 */
const HLS_MEDIA_RECOVERY_WINDOW_MS = 3000;

/**
 * Hls.js decoder resets (recoverMediaError) allowed per Hls.js instance until
 * playback has got HLS_MEDIA_RECOVERY_PROGRESS_S past every earlier reset.
 * The window alone reset a decoder that fails at the same spot forever,
 * behind a spinner, whenever each re-buffer took longer than the window.
 */
const HLS_MAX_DECODER_RESETS = 3;
const HLS_MEDIA_RECOVERY_PROGRESS_S = 30;

/**
 * Minimum real-time spacing of forwarded timeupdate events. Chromium fires
 * timeupdate about every 250 ms, and webOS's WebAppMgr raises that to about
 * every 150 ms (--max-timeupdate-event-frequency=150; 156 ms measured on
 * webOS 25). A gap below both keeps every one; only bursts are dropped.
 */
const TIMEUPDATE_MIN_INTERVAL_MS = 100;

/**
 * Compact description of an audioTracks list (native or Hls.js) for debug logs.
 * @param {AudioTrackList|Array|null|undefined} tracks
 * @returns {string}
 */
function describeAudioTracks(tracks) {
    if (!tracks) return 'none';
    const parts = [];
    for (let i = 0; i < tracks.length; i++) {
        const t = tracks[i];
        const name = t.label || t.name || '';
        parts.push(`[${i}] ${t.language || t.lang || '?'}${name ? ` "${name}"` : ''}${t.enabled ? ' (enabled)' : ''}`);
    }
    return parts.length ? parts.join(', ') : 'empty';
}

/**
 * How long unpause() waits for a pending seek's 'seeked' before it starts
 * playback anyway: webOS carries out a seek on a paused element only once
 * playback starts, so for some pipelines that 'seeked' never comes.
 */
const SEEK_PLAY_FALLBACK_MS = 500;

/**
 * How long the element stays muted after a failed startup audio track switch
 * was reported, if no restart (its stop() lifts the mute) comes.
 */
const TRACK_SWITCH_RESTART_WAIT_MS = 5000;

/**
 * A seek the pipeline never completes. On an LG C4 the pipeline rejected a
 * seek in a native-HLS remux ('seek Failure', error 700) and never finished
 * the next one: the element stayed `seeking` with playback requested, and
 * Chromium held every later seek and play behind it. While the element seeks
 * with playback requested, it is checked every SEEK_STUCK_CHECK_MS. The seek
 * counts as stuck after SEEK_STUCK_MS without new buffered data, or after
 * SEEK_STUCK_MAX_MS in any case, and the player is asked to reload the stream
 * at the target ('seekstuck'). A paused seek is not counted: webOS completes it
 * only once playback starts.
 */
const SEEK_STUCK_CHECK_MS = 2000;
const SEEK_STUCK_MS = 8000;
const SEEK_STUCK_MAX_MS = 30000;

/** canPlayType answers by MIME type; they do not change while the app runs. */
const canPlayTypeCache = Object.create(null);

/**
 * canPlayType through one throw-away <video> per MIME type for the app's
 * lifetime, instead of a new element on every play.
 * @param {string} type - MIME type with optional codecs parameter
 * @returns {string} '', 'maybe' or 'probably' (or 'no' on very old engines)
 */
function canPlayTypeCached(type) {
    if (!(type in canPlayTypeCache)) {
        let answer = '';
        try {
            answer = document.createElement('video').canPlayType(type) || '';
        } catch (e) {
            answer = '';
        }
        canPlayTypeCache[type] = answer;
    }
    return canPlayTypeCache[type];
}

/**
 * Buffer ahead (s) above which a 'stalled' event is the download pausing,
 * not playback running dry.
 */
const STALLED_HEALTHY_BUFFER_S = 3;

/** Refresh of an accepted TV video window: every 3 s for the first five, then every 30 s. */
const OUTPUT_WINDOW_REFRESH_MS = 3000;
const OUTPUT_WINDOW_SLOW_REFRESH_MS = 30000;
const OUTPUT_WINDOW_FAST_REFRESHES = 5;

/**
 * Monotonic milliseconds for interval throttling. Date.now() follows the TV's
 * clock, which can step backwards on a time sync and stall the throttle.
 * @returns {number}
 */
const monotonicNow = () =>
    typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();

// ============================================================================
// Playback Errors
// ============================================================================

/**
 * Rejects a pending play() when stop() or a newer play() ends its session
 * before the load finished. Named 'AbortError' like a DOM abort, so callers
 * treat it as a cancel and not as a playback failure.
 */
export class PlaybackAbortedError extends Error {
    constructor() {
        super('Playback load was superseded by a newer request');
        this.name = 'AbortError';
        // Marks a cancel by stop() / a newer play(), as opposed to a DOM AbortError
        // (e.g. video.play() interrupted by pause()). JellyfinPlayer.play() resolves
        // false for it, and its callers must not carry on with this request.
        this.superseded = true;
    }
}

/** Rejects play() when the media pipeline makes no progress within the load watchdog. */
export class PlaybackLoadTimeoutError extends Error {
    /**
     * @param {number} timeoutMs
     * @param {boolean} [noData] - Not a byte of media arrived: the server is not
     *   delivering, so it is a network error (a transcode would not help either)
     */
    constructor(timeoutMs, noData = false) {
        const seconds = Math.round(timeoutMs / 1000);
        super(noData ? `No media data arrived from the server for ${seconds} s` : `Media load made no progress for ${seconds} s`);
        this.name = 'PlaybackLoadTimeoutError';
        this.isNetworkError = noData;
    }
}

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

        /** { hls, onError } — bounded recovery of the current Hls.js instance, for <video> errors */
        this._hlsElementErrorHandler = null;

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
        /** @type {WeakMap<TextTrackCue, number[]>} [start, end] of each native cue without the offset */
        this._cueBaseTimes = new WeakMap();

        // ---- Bound event handlers (stored so we can removeEventListener cleanly) ----
        this._boundHandlers = {};

        // ---- Aspect ratio mode ('auto' | 'zoom' | 'stretch') ----
        this._aspectMode = 'auto';

        // ---- TV video window override for old webOS (see _applyOutputWindow) ----
        this._outputWindowState = 'unknown'; // 'unknown' | 'ok' | 'failed'
        /** Items in a row on which the TV rejected the video window */
        this._outputWindowFailedItems = 0;
        this._outputWindowActive = false;
        this._outputWindowFailures = 0;
        this._outputWindowRetryTimer = null;
        this._outputWindowRefreshTimer = null;
        this._outputWindowRefreshes = 0;
        this._outputWindowInFlight = false;
        this._outputWindowRerun = false;

        /** Last box written to the <video> style by _fitVideoBox */
        this._appliedVideoBox = null;

        /** @type {ResizeObserver|null} Refits the video box when the container resizes */
        this._containerObserver = null;

        // ---- Timeupdate throttle —— see _onTimeUpdate() ----
        this._lastTimeUpdateTicks = 0;
        this._lastTimeUpdateAt = 0;

        // ---- Stall recovery timer ----
        this._stallTimer = null;

        // ---- DoVi stall loop detection ----
        // Tracks the last recovery kick timestamp to detect and break
        // seek → stall → seek feedback loops on Dolby Vision content.
        this._lastRecoveryKickTime = 0;
        this._recoveryPauseTimer  = null;
        // Dolby Vision pause/play flush in progress: null | 'pausing' | 'resuming'
        this._recoveryFlush = null;

        // ---- Robust resume state ----
        this._robustSeekTarget   = null;
        this._robustSeekPending  = false;
        // Bumped to cancel every running resume/seek retry loop (seek, stop, new play)
        this._resumeGeneration   = 0;

        // ---- Playback session (one per play() call) ----
        // One-shot listeners, timers and pending load promises of a session are
        // registered through _listen() / _timer() / _sessionCleanups, so stop()
        // and the next play() remove them. The <video> element is reused across
        // items, so anything left behind would otherwise act on the next item.
        this._sessionId = 0;
        this._sessionCleanups = [];
        // True while play() waits for the first 'canplay' (the load waiter owns load errors)
        this._loadPending = false;
        // Seek being watched until it lands (_watchSeek)
        this._seekWatch = null;

        // ====================================================================
        // Audio Suppression State (Resume Playback):
        // Prevents brief audio bursts from timestamp 0:00 when resuming playback.
        // ====================================================================
        this._resumeAudioSuppressed = false;
        // Keeps the resume mute on until a deferred audio track switch is done
        this._resumeTrackSwitchPending = false;
        // { listIndex } of an audio track switch that failed at startup, reported once play() resolved
        this._startupTrackSwitchFailure = null;

        // ====================================================================
        // Video Suppression State (Resume Playback):
        // Prevents stale or pre-resume video frames (such as timestamp 0:00)
        // from flashing on screen before the resume seek to target completes.
        // ====================================================================
        this._resumeVideoSuppressed = false;

        // ---- Audio normalization (Web Audio API) ----
        // { element, context, source, gain } — see _applyAudioNormalization();
        // the context is shared by every element of this player
        this._audioGraph = null;
        this._audioContext = null;

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

        // ------------------------------------------------------------------
        // Start visually hidden: prevent any stale frame cached in the GPU
        // surface from flashing when a new playback session initializes.
        // ------------------------------------------------------------------
        video.style.opacity = '0';
        video.style.visibility = 'hidden';

        // Ensure the container exists before we try to append
        if (!this.container) {
            this.container = document.createElement('div');
            this.container.className = 'jellyfin-player-container';
            document.body.appendChild(this.container);
        }

        /*
         * ====================================================================
         * Container Letterbox Background Normalization
         * ====================================================================
         * WebOSPlayer fits the hardware-associated <video> element layout box
         * to match the stream's exact aspect ratio in _fitVideoBox().
         * Because document-level player-active transparency rules make the body
         * and app wrappers transparent, the container itself must have an opaque
         * solid black background to ensure pillarbox and letterbox borders render
         * in deep black rather than showing through to the underlying canvas.
         * ====================================================================
         */
        this.container.style.backgroundColor = '#000000';

        this.container.appendChild(video);
        this._videoElement = video;

        this._bindEvents(video);

        // The container narrows when lyrics are shown, so the box has to follow it
        if (typeof ResizeObserver !== 'undefined' && !this._containerObserver) {
            this._containerObserver = new ResizeObserver(() => this._fitVideoBox());
            this._containerObserver.observe(this.container);
        }

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
            // Re-evaluate video bounding box once canplay fires (critical on webOS 5 where dimensions can be 0 at loadedmetadata)
            canplay:       this._fitVideoBox.bind(this),
            // Fires when the intrinsic size changes, e.g. an HLS variant switch
            resize:        this._fitVideoBox.bind(this),
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
    // Playback Session Helpers
    // ========================================================================

    /**
     * End the current session and start a new one.
     * @private
     * @returns {number} The new session id
     */
    _beginSession() {
        this._endSession();
        return this._sessionId;
    }

    /**
     * Run and clear every cleanup registered by the current session: removes
     * its one-shot listeners, clears its timers and rejects a pending load
     * with PlaybackAbortedError. The session id then moves on, so code that
     * resumes after an await of the ended session (e.g. a manifest poll)
     * sees it is no longer current.
     * @private
     */
    _endSession() {
        this._loadPending = false;
        this._seekWatch = null;
        // A Dolby Vision flush ends with its session (its resume timer is cleared below)
        this._recoveryFlush = null;
        const cleanups = this._sessionCleanups;
        this._sessionCleanups = [];
        for (let i = 0; i < cleanups.length; i++) {
            try {
                cleanups[i]();
            } catch (e) {
                log.warn('WebOSPlayer: session cleanup threw', e);
            }
        }
        this._sessionId++;
    }

    /**
     * @private
     * @param {number} session
     * @returns {boolean} True while `session` is the current session
     */
    _isSessionActive(session) {
        return session === this._sessionId;
    }

    /**
     * addEventListener that is undone when the current session ends.
     * @private
     * @returns {Function} Removes the listener early
     */
    _listen(target, type, handler, options) {
        target.addEventListener(type, handler, options);
        const remove = () => {
            target.removeEventListener(type, handler, options);
            this._dropSessionCleanup(remove);
        };
        this._sessionCleanups.push(remove);
        return remove;
    }

    /**
     * setTimeout that is cleared when the current session ends and never runs
     * for a later session.
     * @private
     * @returns {number} Timer id (clearTimeout works as usual)
     */
    _timer(fn, ms) {
        const session = this._sessionId;
        let id = null;
        const cancel = () => clearTimeout(id);
        id = setTimeout(() => {
            // A fired timer needs no cleanup any more. Left in the list, those of
            // re-armed timers (seek watch, retry polls) piled up for the session.
            this._dropSessionCleanup(cancel);
            if (this._isSessionActive(session)) fn();
        }, ms);
        this._sessionCleanups.push(cancel);
        return id;
    }

    /**
     * Forget a cleanup of the current session that is no longer needed. One of
     * an ended session is not in the list any more, so nothing happens then.
     * @private
     * @param {Function} cleanup
     */
    _dropSessionCleanup(cleanup) {
        const index = this._sessionCleanups.lastIndexOf(cleanup);
        if (index !== -1) this._sessionCleanups.splice(index, 1);
    }

    /**
     * Promise settled once, and rejected with PlaybackAbortedError if the
     * session ends first.
     * @private
     * @param {Function} executor - (resolve, reject) => void
     * @returns {Promise<void>}
     */
    _sessionPromise(executor) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const resolveOnce = (value) => {
                if (settled) return;
                settled = true;
                resolve(value);
            };
            const rejectOnce = (reason) => {
                if (settled) return;
                settled = true;
                reject(reason);
            };
            this._sessionCleanups.push(() => rejectOnce(new PlaybackAbortedError()));
            executor(resolveOnce, rejectOnce);
        });
    }

    /**
     * Cancel every running resume / seek retry loop. Loops capture
     * _resumeGeneration when they start and stop once it changes.
     * @private
     */
    _cancelResume() {
        this._resumeGeneration++;
        this._robustSeekPending = false;
    }

    /**
     * Drop the element's pending load: no request stays open and no late
     * load error reaches the player.
     * @private
     * @param {HTMLVideoElement} video
     * @param {HTMLSourceElement|null} source
     */
    _abandonLoad(video, source) {
        try {
            if (source && source.parentNode === video) video.removeChild(source);
            video.removeAttribute('src');
            video.load();
        } catch (e) {
            log.debug('WebOSPlayer: abandoning the load failed:', e);
        }
    }

    /**
     * Wait for the first 'canplay' of the load that was just started.
     *
     * Errors are taken from the <video> and, when the stream was given as a
     * <source> child, from that <source>: per the HTML resource selection
     * algorithm a failing <source> fires 'error' on itself (it does not bubble)
     * and leaves video.error null, so listening on the <video> alone misses it.
     *
     * @private
     * @param {HTMLVideoElement} video
     * @param {HTMLSourceElement|null} source
     * @param {number} timeoutMs - Load watchdog, re-armed by 'loadedmetadata' / 'progress'
     * @returns {Promise<void>} Rejects with the load error, PlaybackLoadTimeoutError
     *   or PlaybackAbortedError
     */
    _waitForCanPlay(video, source, timeoutMs) {
        return this._sessionPromise((resolve, reject) => {
            const removers = [];
            let watchdog = null;
            let sawData = false;

            const finish = (err) => {
                clearTimeout(watchdog);
                removers.forEach((remove) => remove());
                if (err) reject(err);
                else resolve();
            };
            const armWatchdog = () => {
                clearTimeout(watchdog);
                watchdog = setTimeout(() => {
                    const noData = !sawData && !(video.readyState > 0);
                    finish(new PlaybackLoadTimeoutError(timeoutMs, noData));
                    // Abandon the request too. The pipeline keeps it open and reports its own
                    // error once it gives up (MEDIA_ERR_SRC_NOT_SUPPORTED 10 s after the timeout
                    // on an LG C4), which JellyfinPlayer took for a direct-play failure and
                    // restarted as a transcode behind the error dialog.
                    this._abandonLoad(video, source);
                }, timeoutMs);
            };
            const onData = () => {
                sawData = true;
                armWatchdog();
            };
            const onError = () => {
                // A failing <source> leaves video.error null
                const mediaError = video.error || { code: 4, message: 'The media source failed to load' };
                const formatted = MediaHelper.formatMediaError(mediaError);
                const err = video.error || Object.assign(new Error(formatted.message), { code: formatted.code });
                // The pipeline's own error when nothing arrived (an LG C4 gives up on
                // a silent server after about 40 s, before the watchdog): the caller
                // checks the server before it falls back to Hls.js
                try {
                    err.gotNoData = !sawData && !(video.readyState > 0);
                } catch (e) {
                    // A MediaError that takes no property: treated as a load that got data
                }
                finish(err);
            };

            removers.push(this._listen(video, 'canplay', () => finish()));
            removers.push(this._listen(video, 'error', onError));
            if (source) {
                removers.push(this._listen(source, 'error', () => {
                    // A <source> already taken out no longer decides the load: the
                    // Dolby Vision path retries a rejected hint with a raw src (its
                    // listener, added first, runs first), whose errors fire on the <video>
                    if (source.parentNode !== video) return;
                    onError();
                }));
            }
            removers.push(this._listen(video, 'loadedmetadata', onData));
            removers.push(this._listen(video, 'progress', onData));
            // Also clear the watchdog if the session ends first
            this._sessionCleanups.push(() => clearTimeout(watchdog));
            armWatchdog();
        });
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

        log.debug('WebOSPlayer: audio stream', options.audioStreamIndex, '/ list index', options.audioTrackListIndex);

        // A new session: drops listeners, timers and the pending load of the
        // previous one (its play() promise rejects with PlaybackAbortedError).
        this._beginSession();
        this._cancelResume();

        this._currentPlayOptions = options;
        this._started    = false;
        this._timeUpdated = false;
        this._subtitleOffset = 0;
        this._hlsFallbackAttempted = false;
        this._startupTrackSwitchFailure = null;

        // Initialize robust seek state immediately to avoid race conditions with early 'playing' events.
        // Do not attempt robust resume for live TV/streams.
        const isLive = options.item?.Type === 'TvChannel' || options.mediaSource?.LiveStreamId;
        this._robustSeekTarget = isLive ? null : (options.playerStartPositionTicks || 0) / 10000000;

        const video = this._ensureVideoElement();

        // Route the audio through the normalization gain (or back to unity gain) before the
        // load starts. Set up once play() had resolved, every queued track started at full
        // level on its fresh element, then dropped by the gain a moment later.
        this._applyAudioNormalization(options);

        // ====================================================================
        // Audio & Video Suppression for Seamless Resume:
        // When resuming playback from a non-zero position, native TV decoders
        // and Chromium pipelines decode the initial keyframe at timestamp 0:00
        // for a few frames before the seek to resumeSeconds takes effect.
        // Mute audio and suppress visual presentation until the target GOP keyframe
        // is reached, preventing the random 0:00 frame and audio burst from leaking.
        // ====================================================================
        this._resumeTrackSwitchPending = false;
        if (this._robustSeekTarget > 0) {
            // Mute audio if not already muted by the user
            if (!video.muted) {
                video.muted = true;
                this._resumeAudioSuppressed = true;
            }
            // Suppress video element visibility until the seek completes
            this._suppressVideoForResume(video);
        }

        // Tear down any active Hls.js session before starting fresh
        this._destroyHlsPlayer();

        /*
         * ====================================================================
         * HLS MASTER VARIANT BYPASS FOR VIDEO STREAM COPY:
         *
         * When remuxing or direct-streaming an HDR source (e.g. 4K HEVC HDR10 /
         * Dolby Vision with unsupported audio like DTS-HD MA), Jellyfin server's
         * DynamicHlsHelper injects an H.264 SDR fallback variant into master.m3u8
         * with identical BANDWIDTH ("Provide H.264 SDR entrance for backward
         * compatibility").
         *
         * The native webOS HLS demuxer treats identical bandwidth variants as
         * interchangeable and periodically switches to the SDR variant, which
         * contains AllowVideoStreamCopy=false. This forces Jellyfin into a full
         * 4K h264_qsv + tonemap transcode mid-stream, exhausting server CPU/GPU
         * and stalling playback.
         *
         * By replacing /master.m3u8 with /main.m3u8, the webOS player requests
         * the direct media playlist with the stream-copy query parameters.
         * The secondary SDR variant is eliminated entirely, locking webOS into
         * the stream-copied HDR track.
         * ====================================================================
         */
        let streamUrl = options.url;
        const isVideoDirect = options.playMethod === 'DirectStream' ||
                              options.playMethod === 'Remux' ||
                              (options.mediaSource ? MediaHelper.getTranscodeStatus(options.mediaSource).isVideoDirect : false);

        if (isVideoDirect && typeof streamUrl === 'string' && streamUrl.includes('/master.m3u8')) {
            log.info('WebOSPlayer: Video stream copy active — requesting main.m3u8 directly to bypass server SDR variant');
            streamUrl = streamUrl.replace(/\/master\.m3u8/i, '/main.m3u8');
            options = { ...options, url: streamUrl };
        }

        // Detect whether the incoming stream is HLS (transcode, remux, or raw m3u8)
        const isHlsStream = options.isHls || (options.url && options.url.includes('.m3u8'));
        // Persist HLS stream flag on the player instance for seeking and recovery logic
        this._isHls = isHlsStream;
        // Reset fallback guard so new stream playback can attempt clean Hls.js recovery if needed
        this._hlsFallbackAttempted = false;

        if (isHlsStream && this._shouldUseNativeHls(options)) {
            /* ----------------------------------------------------------------
             * Path A: Native HLS
             * WebOS's media engine handles HLS natively — point the src at the
             * manifest. Using the source element with a type hint ensures the
             * TV operating system routes it through the hardware decoder.
             * Mandatory for Dolby Vision (ICtCp color mapping) and E-AC-3/AC-3.
             * ---------------------------------------------------------------- */
            log.info('WebOSPlayer: Using native HLS pipeline');
            await this._playNativeHls(video, options);

        } else if (isHlsStream && this._canUseHlsJs(options)) {
            /* ----------------------------------------------------------------
             * Path B: Hls.js fallback
             * Used for standard SDR/H.264/AAC streams on webOS < 5 where native
             * startup seeking is unreliable, or dev browsers/emulators without
             * native media engine support.
             * ---------------------------------------------------------------- */
            log.info('WebOSPlayer: Native HLS not selected — using Hls.js fallback');
            await this._playWithHlsJs(video, options);

        } else {
            /* ----------------------------------------------------------------
             * Path C: Direct MP4/MKV/etc. — assign src directly
             * ---------------------------------------------------------------- */
            log.info('WebOSPlayer: Using native direct-play (non-HLS)');
            await this._playNativeDirect(video, options);
        }

        this._currentSrc = options.url;

        // The audio track switch at startup failed (see _applyInitialTracks): report it
        // in a later task, once the caller has gone on from this resolved play()
        const trackSwitchFailure = this._startupTrackSwitchFailure;
        if (trackSwitchFailure) {
            this._startupTrackSwitchFailure = null;
            this._timer(() => this.onEvent({ type: 'audiotrackswitchfailed', data: trackSwitchFailure }), 0);
            // No restart came: play on with the default track rather than in silence
            this._timer(() => {
                log.warn('WebOSPlayer: no restart after the failed audio track switch — unmuting');
                this._resumeTrackSwitchPending = false;
                if (this._resumeAudioSuppressed && !this._robustSeekPending) {
                    this._resumeAudioSuppressed = false;
                    this.setMuted(false);
                }
            }, TRACK_SWITCH_RESTART_WAIT_MS);
        }
    }

    /**
     * Resolve the normalization gain (linear) for an item, or null when none applies.
     * Only audio-only items are normalized. The gain value comes from the server
     * metadata (NormalizationGain / albumNormalizationGain).
     * @private
     * @param {Object} options - Play options (item, mediaSource)
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
     * Apply audio normalization (TrackGain / AlbumGain) using the Web Audio API.
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
     * @param {Object} options - Play options (item, mediaSource)
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
     * goes straight to the TV again. The user's mute state carries over.
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
     * Detect whether the current environment supports native HLS.
     * On WebOS hardware this is always true. On a dev browser it may not be.
     * @private
     * @returns {boolean}
     */
    /**
     * Inspect stream metadata to determine if Hls.js can reliably handle the stream.
     * The MSE pipeline has strict hardware and container limitations on TV browsers:
     *
     * 1. Dolby Vision (Profile 5, etc.): Profile 5 relies on ICtCp color space and
     *    dynamic metadata (RPU). In MSE, the Chromium layer lacks the proprietary
     *    color management hooks to signal the display processor, yielding a
     *    green/purple tint. Native hardware video pipelines are required.
     *
     * 2. Non-AAC audio in MPEG-TS: The Hls.js TS demuxer parses ADTS AAC and MP3 only.
     *    Encountering E-AC-3 (Dolby Digital Plus), AC-3, DTS, or TrueHD in MPEG-TS
     *    chunks triggers fatal demuxer exceptions ("Unsupported EC-3 in M2TS found").
     *
     * 3. HEVC (H.265) / HDR: On older webOS (< 5), MSE lacks HEVC SourceBuffer support
     *    and Hls.js cannot transmux HEVC from TS chunks.
     *
     * @private
     * @param {Object} [options]
     * @returns {boolean}
     */
    _canUseHlsJs(options = this._currentPlayOptions) {
        // Ensure Hls.js library is loaded and MSE is supported by the environment
        if (!Hls.isSupported()) {
            return false;
        }

        // If options or media stream metadata is unavailable, allow default MSE support check
        if (!options) {
            return true;
        }

        const mediaStreams = options.mediaSource?.MediaStreams || [];

        // ---------------------------------------------------------------------
        // Check 1: Dolby Vision
        // Profile 5 / 8 streams require the native TV hardware pipeline for ICtCp
        // color space conversion. MSE cannot map these and produces distorted colors.
        // ---------------------------------------------------------------------
        const videoStream = mediaStreams.find(s => s.Type === 'Video');
        const rangeType = (videoStream?.VideoRangeType || options.item?.VideoRangeType || '').toUpperCase();
        const extendedRange = (videoStream?.ExtendedVideoRangeType || '').toUpperCase();
        const itemRange = (options.item?.VideoRange || '').toUpperCase();
        const isDoVi = rangeType.startsWith('DOVI') || extendedRange.startsWith('DOVI') ||
                       rangeType.includes('DOVI') || itemRange.includes('DOVI');

        if (isDoVi) {
            log.info('WebOSPlayer: Dolby Vision stream detected — Hls.js MSE cannot process DV metadata, forcing native HLS');
            return false;
        }

        // ---------------------------------------------------------------------
        // Check 2: HEVC / H.265 video codec
        // Hls.js TS demuxer only parses H.264 (AVC) in TS segments, and older webOS
        // Chromium versions do not expose HEVC SourceBuffer decoding over MSE.
        // ---------------------------------------------------------------------
        const videoCodec = (videoStream?.Codec || '').toLowerCase();
        if (videoCodec === 'hevc' || videoCodec === 'h265') {
            log.info('WebOSPlayer: HEVC video stream detected — incompatible with Hls.js TS demuxer, forcing native HLS');
            return false;
        }

        // ---------------------------------------------------------------------
        // Check 3: HDR content (HDR10, HDR10+, HLG)
        // Static and dynamic HDR metadata require direct hardware video decoders.
        // ---------------------------------------------------------------------
        const isHdr = rangeType.startsWith('HDR') || rangeType.startsWith('HLG') ||
                      itemRange.startsWith('HDR') || itemRange.startsWith('HLG');
        if (isHdr) {
            log.info('WebOSPlayer: HDR stream detected — forcing native HLS');
            return false;
        }

        // ---------------------------------------------------------------------
        // Check 4: Audio codec compatibility in MPEG-TS
        // The Hls.js TS demuxer only parses AAC and MP3 from MPEG-TS containers.
        // E-AC-3 (Dolby Digital Plus), AC-3, DTS, or TrueHD in TS trigger fatal
        // fragParsingError events that disrupt playback.
        // ---------------------------------------------------------------------
        const selectedAudioIndex = options.audioStreamIndex;
        const audioStreams = mediaStreams.filter(s => s.Type === 'Audio');
        const activeAudio = (selectedAudioIndex !== undefined && audioStreams.find(s => s.Index === selectedAudioIndex)) ||
                            audioStreams.find(s => s.IsDefault) ||
                            audioStreams[0];
        const audioCodec = (activeAudio?.Codec || '').toLowerCase();
        const unsupportedAudioCodecs = ['eac3', 'ac3', 'dolbydigitalplus', 'dts', 'dca', 'truehd', 'mlp'];

        if (unsupportedAudioCodecs.includes(audioCodec)) {
            log.info(`WebOSPlayer: Audio codec '${audioCodec}' unsupported by Hls.js TS demuxer — forcing native HLS`);
            return false;
        }

        return true;
    }

    /**
     * Detect whether the current environment supports and should use native HLS.
     * On WebOS hardware, native HLS routes through the platform's hardware media engine.
     *
     * @private
     * @param {Object} [options]
     * @returns {boolean}
     */
    _shouldUseNativeHls(options = this._currentPlayOptions) {
        // Query TV hardware capabilities and webOS major version
        const caps = getDeviceCapabilities();
        const webosVersion = caps?.webosVersion || 1;

        // ---------------------------------------------------------------------
        // HARDWARE CODEC & CONTAINER COMPATIBILITY GATE:
        // If the stream contains Dolby Vision, HEVC, HDR, or E-AC-3/AC-3 audio in TS,
        // Hls.js MSE will either fail to demux or produce green/purple picture.
        // These streams MUST use the native hardware HLS pipeline across all webOS versions.
        // ---------------------------------------------------------------------
        if (!this._canUseHlsJs(options)) {
            log.info('WebOSPlayer: Stream requires native hardware decoder pipeline');
            return true;
        }

        // ---------------------------------------------------------------------
        // WEBOS VERSION COMPATIBILITY GATE:
        // On older webOS (< 5, including webOS 3 and 4.x), media fragments (#t=)
        // are strictly disabled because older demuxers crash with MEDIA_ERR_DECODE.
        // Furthermore, the native webOS 3/4 HLS pipeline silently discards or snaps back
        // programmatic seeks into unbuffered HLS chunks at startup.
        // For standard SDR/H.264/AAC streams where Hls.js MSE is fully supported,
        // prefer Hls.js MSE on webOS < 5 so resume seeks land reliably at the target position.
        // ---------------------------------------------------------------------
        if (webosVersion < 5 && Hls.isSupported()) {
            log.info(`WebOSPlayer: webOS ${webosVersion} (< 5) detected with standard stream — preferring Hls.js MSE pipeline for reliable resume seek`);
            return false;
        }

        // Test native browser HLS MIME support for webOS 5+ hardware decoding
        const nativeHls = !!(
            canPlayTypeCached('application/x-mpegURL').replace(/no/, '') ||
            canPlayTypeCached('application/vnd.apple.mpegURL').replace(/no/, '')
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
        const session = this._sessionId;

        // Clear any stale source first
        video.removeAttribute('src');

        // Ensure HLS manifest exists before assigning source. Polling stops as
        // soon as stop() or a newer play() ends this session.
        await MediaHelper.pollHlsManifest(options.url, () => !this._isSessionActive(session));
        if (!this._isSessionActive(session)) throw new PlaybackAbortedError();
        // ====================================================================
        // MEDIA FRAGMENT RESUME:
        // Append `#t=seconds` to the url for HLS streaming to hint the native HLS demuxer
        // to download chunks starting from the resume position immediately.
        // NOTE: Older WebOS 3/4 demuxers crash with MEDIA_ERR_DECODE when `#t=` is present,
        // so we strictly gate media fragments to WebOS 5+.
        // ====================================================================
        let url = options.url;
        const seconds = (options.playerStartPositionTicks || 0) / 10000000;
        const webosVersion = getDeviceCapabilities()?.webosVersion || 1;
        if (seconds > 0 && webosVersion >= 5) {
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
        const loadStartedAt = Date.now();

        this._loadPending = true;
        try {
            await this._waitForCanPlay(video, source, LOAD_WATCHDOG_HLS_MS);
        } catch (err) {
            // Checked by name: legacy (ES5) builds transpile Error subclasses
            if (err?.name === 'AbortError') throw err;
            log.error('WebOSPlayer: Native HLS source load error', err?.message || err);

            // If native HLS failed on this platform, fall back to Hls.js seamlessly
            // only if the stream format and codecs are verified to be compatible with Hls.js MSE.
            // After a load that got no data at all, only if the server still answers: a cold
            // transcode can take over a minute to its first segment, but Hls.js would only
            // wait again for a server that stopped answering.
            if (this._canUseHlsJs(options) && !this._hlsFallbackAttempted) {
                if (err?.isNetworkError || err?.gotNoData === true) {
                    const answers = await this._hlsServerAnswers(options.url);
                    if (!this._isSessionActive(session)) throw new PlaybackAbortedError();
                    if (!answers) {
                        log.warn('WebOSPlayer: the server does not answer either — no Hls.js fallback');
                        // The pipeline's own error would read as an unsupported format
                        throw err?.isNetworkError ? err : new PlaybackLoadTimeoutError(Date.now() - loadStartedAt, true);
                    }
                }
                log.info('WebOSPlayer: Native HLS load failed — attempting seamless fallback to Hls.js MSE pipeline');
                this._hlsFallbackAttempted = true;
                return this._playWithHlsJs(video, options);
            }
            throw err;
        } finally {
            if (this._isSessionActive(session)) this._loadPending = false;
        }

        // Attempt tracks after metadata is loaded
        this._applyInitialTracks(options);

        return this._sessionPromise((resolve, reject) => {
            this._resumeSeekThenPlay(video, options, resolve, reject);
        });
    }

    /**
     * Whether the server answers a request for the HLS playlist within
     * SERVER_PROBE_TIMEOUT_MS.
     * @private
     * @param {string} url - Playlist URL
     * @returns {Promise<boolean>}
     */
    async _hlsServerAnswers(url) {
        try {
            const text = await MediaHelper.fetchWithTimeout(
                url,
                { method: 'GET' },
                SERVER_PROBE_TIMEOUT_MS,
                (response) => (response.ok ? response.text() : '')
            );
            return typeof text === 'string' && text.indexOf('#EXTM3U') !== -1;
        } catch (e) {
            return false;
        }
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
     * For HEVC DoVi content we provide a <source> element with the codec hint
     * `video/mp4; codecs="dvh1"`. This is the same in-band parameter-set
     * codec tag that WebOS uses to activate its Dolby Vision hardware decoder
     * pipeline (see the hvc1|dvh1|hev1 CodecProfile gate in WebOSProfile.js).
     *
     * DoVi in other codecs (AV1 profile 10) takes the standard path: dvh1
     * names HEVC, so the pipeline rejects the hinted source outright, while a
     * raw src plays it on its HDR10 base layer.
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
        // NOTE: Strictly gated to WebOS 5+ to prevent decode errors on WebOS 3/4.
        // ====================================================================
        let url = options.url;
        const seconds = (options.playerStartPositionTicks || 0) / 10000000;
        const webosVersion = getDeviceCapabilities()?.webosVersion || 1;
        if (seconds > 0 && webosVersion >= 5) {
            log.info(`WebOSPlayer: Appending media fragment #t=${seconds} to native DirectPlay URL`);
            url += `#t=${seconds}`;
        }

        // ── Dolby Vision hint path ───────────────────────────────────────────
        // Detect DoVi from the media stream metadata passed down via options.
        const videoStream = options.mediaSource?.MediaStreams?.find(s => s.Type === 'Video');
        const rangeType = videoStream?.VideoRangeType || '';
        const isDoVi = rangeType.startsWith('DOVI') || rangeType === 'DOVIWithHDR10' ||
                       rangeType === 'DOVIWithHLG' || rangeType === 'DOVIWithSDR';
        // dvh1 names HEVC-based Dolby Vision. DoVi carried in another codec (AV1
        // profile 10) makes the native pipeline reject the hinted source outright,
        // while the plain src plays it on its HDR10 base layer.
        const videoCodec = (videoStream?.Codec || '').toLowerCase();
        const isHevc = videoCodec === 'hevc' || videoCodec === 'h265';

        // The <source> element of the DoVi hint path (its load errors fire on it)
        let sourceElement = null;

        if (isDoVi && isHevc) {
            // The 'dvh1' codec string tells WebOS to activate the DV hardware
            // decoder pipeline. We use video/mp4 as the MIME wrapper because
            // WebOS Chromium validates codec tags against MP4 codec strings
            // (dvh1 / dvhe are ISO BMFF-defined tags). video/x-matroska with
            // dvh1 would be rejected by Chromium's codec validation.
            const dvHint = 'video/mp4; codecs="dvh1"';
            const canPlayDv = canPlayTypeCached(dvHint) !== '';

            if (canPlayDv) {
                log.info('WebOSPlayer: DoVi content detected — using dvh1 codec hint to activate DV decoder pipeline');
                const source = document.createElement('source');
                source.src  = url;
                source.type = dvHint;
                // A rejected <source> fires 'error' on the source element, not on the
                // video, so the load would otherwise only fail via the startup
                // watchdog (and escalate to a transcode). Retry once with a raw src.
                const onSourceError = () => {
                    source.removeEventListener('error', onSourceError);
                    if (source.parentNode !== video) return;
                    log.warn('WebOSPlayer: dvh1-hinted source rejected — retrying with raw src');
                    video.removeChild(source);
                    video.src = url;
                    video.load();
                };
                source.addEventListener('error', onSourceError);
                video.appendChild(source);
                sourceElement = source;
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

        const session = this._sessionId;
        this._loadPending = true;
        try {
            await this._waitForCanPlay(video, sourceElement, LOAD_WATCHDOG_DIRECT_MS);
        } finally {
            if (this._isSessionActive(session)) this._loadPending = false;
        }

        // Apply audio/subtitle tracks at canplay — same timing as _playNativeHls.
        // audioTracks is not reliably populated at loadedmetadata on WebOS native
        // player, so doing it here (before play()) ensures the array is ready.
        this._applyInitialTracks(options);

        return this._sessionPromise((resolve, reject) => {
            this._resumeSeekThenPlay(video, options, resolve, reject);
        });
    }

    /**
     * Hls.js path — only used when native HLS is unavailable (emulator / browser).
     * @private
     */
    _playWithHlsJs(video, options) {
        return new Promise((resolve, reject) => {
            log.info('WebOSPlayer: Hls.js loading', options.url);

            // A native HLS attempt leaves its <source>. With it in place, the error
            // the element fires when Hls.js gives up and detaches passed the cleanup
            // check in _onError and replaced Hls.js's own error in the dialog
            Array.prototype.slice.call(video.children || video.childNodes || []).forEach((child) => {
                if (child.tagName === 'SOURCE') video.removeChild(child);
            });

            // -------------------------------------------------------------------------
            // HLS.js Buffer Configuration & Stall Prevention
            // -------------------------------------------------------------------------
            // Browsers/emulators impose strict MSE memory quotas. Retaining 60-120s of
            // forward buffer at high bitrates triggers quota exceeded exceptions and stalls.
            // Align with jellyfin-web MSE defaults (30s buffer / 60s max).
            // -------------------------------------------------------------------------
            const configuredMaxBuffer = PlayerSettings.get('html5MaxBufferLength');
            const maxBufferLength = configuredMaxBuffer !== undefined && configuredMaxBuffer !== null
                ? Number(configuredMaxBuffer)
                : 30;
            const configuredMaxMaxBuffer = PlayerSettings.get('html5MaxMaxBufferLength');
            const maxMaxBufferLength = configuredMaxMaxBuffer !== undefined && configuredMaxMaxBuffer !== null
                ? Number(configuredMaxMaxBuffer)
                : 60;

            const hls = new Hls({
                startPosition:         (options.playerStartPositionTicks || 0) / 10000000,
                maxBufferLength:       maxBufferLength,
                maxMaxBufferLength:    maxMaxBufferLength,
                manifestLoadingTimeOut: 20000,
                levelLoadingTimeOut:    20000,
                fragLoadingTimeOut:     20000,
                maxBufferSize:          60 * 1000 * 1000,
                enableWorker:           true,
                // Rely on standard Hls.js hole handling (matching official jellyfin-web baseline).
                // Do not force high maxBufferHole or aggressive watchdog nudging: setting maxBufferHole
                // triggers premature _trySkipBufferHole seeks whenever the forward buffer drops below the
                // threshold, making the player skip back and forth and causing subtitle desync.
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
            let loadWatchdog = null;
            let sawData = false;
            let playlistsLoaded = false;
            let resolved = false;
            let appendedSegmentsCount = 0;
            // Set when Hls.js detaches the element: recoverMediaError() reloads it
            let mediaReloaded = false;

            const resolveOnce = (value) => {
                if (resolved) return;
                resolved = true;
                clearTimeout(initialBufferTimer);
                clearTimeout(loadWatchdog);
                hls.off(Hls.Events.BUFFER_APPENDED, onBufferAppended);
                resolve(value);
            };

            const rejectOnce = (reason) => {
                if (resolved) return;
                resolved = true;
                clearTimeout(initialBufferTimer);
                clearTimeout(loadWatchdog);
                hls.off(Hls.Events.BUFFER_APPENDED, onBufferAppended);
                reject(reason);
            };

            // stop() or a newer play() abandons this start (clears the 3 s timer too)
            this._sessionCleanups.push(() => rejectOnce(new PlaybackAbortedError()));

            // Calculate target resume position in seconds
            const resumeSeconds = (options.playerStartPositionTicks || 0) / 10000000;

            // Start again once Hls.js has reset the MediaSource and buffered; fail with
            // `failure` if that does not happen within 10 s.
            const waitForRecovery = (failure) => {
                bufferReady = false;
                appendedSegmentsCount = 0;
                clearTimeout(initialBufferTimer);
                initialBufferTimer = setTimeout(() => {
                    if (!resolved) failHls(failure);
                }, 10000);
            };

            const startPlayback = () => {
                // -----------------------------------------------------------------
                // Visual presentation restoration:
                // Only restore immediately if playing from timestamp 0 (not resuming).
                // On resume (resumeSeconds > 0), maintain suppression until _onPlaying
                // confirms that the decoder has actively landed on the target frame.
                // -----------------------------------------------------------------
                if (!resumeSeconds || resumeSeconds <= 0) {
                    this._restoreVideoAfterResume(video);
                }
                mediaReloaded = false;
                const playPromise = video.play();
                if (playPromise !== undefined && typeof playPromise.then === 'function') {
                    playPromise
                        .then(() => resolveOnce())
                        .catch((err) => {
                            if (err?.name === 'AbortError' && mediaReloaded && this._hlsPlayer === hls && !resolved) {
                                /*
                                 * Hls.js reset the decoder (a fatal media error): in hls.js 1.7
                                 * recoverMediaError() reloads the element, which aborts the
                                 * pending play() with a DOM AbortError. JellyfinPlayer takes
                                 * that for a cancel and skipped what follows a start, so play
                                 * again once Hls.js has buffered; no playback after the reset
                                 * is a decode error.
                                 */
                                log.warn('WebOSPlayer: Hls.js reset the decoder during the start — waiting for it');
                                const error = new Error('Hls.js media error (no playback after a decoder reset)');
                                error.code = 3;
                                waitForRecovery(error);
                                return;
                            }
                            this._handleAutoplayError(err, video, options, resolveOnce, rejectOnce);
                        });
                } else {
                    // Chromium 38 (webOS 3) returns no promise: the start is done once the element
                    // plays. Resolving here cleared the load watchdog with nothing buffered yet,
                    // and 'waiting' is not reported before the first frame.
                    const removePlaying = this._listen(video, 'playing', () => {
                        removePlaying();
                        resolveOnce();
                    });
                }
            };

            // -----------------------------------------------------------------
            // Buffer-Readiness Gate with Resume Stabilization:
            // Defer play() until initial media data is buffered.
            // On resume (resumeSeconds > 0), the playhead may land near the end
            // of a segment (e.g. 200ms before segment boundary). If play() starts
            // immediately with < 1.0s of buffer, the decoder starves before the
            // next segment loads, causing an instant bufferSeekOverHole jump.
            // We inspect the native video.buffered TimeRanges directly to ensure
            // at least 1.0s of forward cushion exists (or wait for segment #2).
            // -----------------------------------------------------------------
            const onBufferAppended = () => {
                if (bufferReady) return;
                appendedSegmentsCount++;

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
                    if (forwardBuffer < 1.0 && appendedSegmentsCount < 2) {
                        log.info(`WebOSPlayer: HLS.js segment #${appendedSegmentsCount} appended, forward buffer ${forwardBuffer.toFixed(2)}s < 1.0s — waiting for next segment to stabilize resume`);
                        return;
                    }
                }

                // Buffer is now healthy and stabilized for smooth playback engagement
                bufferReady = true;
                clearTimeout(initialBufferTimer);
                log.info(`WebOSPlayer: HLS.js initial buffer ready (${appendedSegmentsCount} segment(s)), starting playback`);
                startPlayback();
            };

            initialBufferTimer = setTimeout(() => {
                if (!bufferReady) {
                    log.warn('WebOSPlayer: Hls.js initial buffer timeout (3s) — forcing play');
                    bufferReady = true;
                    startPlayback();
                }
            }, 3000);

            hls.on(Hls.Events.MANIFEST_PARSED, () => {
                log.info('WebOSPlayer: Hls.js manifest parsed');
                this._applyInitialTracks(options, hls);

                if (options.autoPlay === false) {
                    resolveOnce();
                }
                // Otherwise BUFFER_APPENDED or timeout will call startPlayback()
            });

            if (options.playerStartPositionTicks) {
                hls.once(Hls.Events.LEVEL_LOADED, () => {
                    this._applyRobustResume(video, options.playerStartPositionTicks);
                });
            }

            // -----------------------------------------------------------------
            // Unrecoverable Hls.js error: before playback started it rejects
            // play(); afterwards it is reported as a backend 'error' event so
            // JellyfinPlayer can escalate or show the error dialog.
            // -----------------------------------------------------------------
            const failHls = (reason) => {
                log.error('WebOSPlayer: Hls.js could not recover —', reason.message);
                if (this._hlsPlayer === hls) {
                    this._hlsPlayer = null;
                }
                try {
                    hls.destroy();
                } catch (e) {
                    log.warn('WebOSPlayer: Hls.js destroy threw', e);
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
            hls.on(Hls.Events.MEDIA_DETACHING, () => {
                mediaReloaded = true;
            });

            // Listen for the first segment buffered — triggers play()
            hls.on(Hls.Events.BUFFER_APPENDED, onBufferAppended);

            /*
             * -----------------------------------------------------------------
             * Load watchdog, like the native path's (LOAD_WATCHDOG_HLS_MS):
             * without one, a server that stopped answering left play() pending
             * forever, as the 3 s fallback's video.play() never settles without
             * media. It allows that long for the playlists. Once they are in, a
             * slow first segment is up to hls.js's own fragment policy (a cold
             * transcode can take over a minute; a fragment that never comes
             * ends in a fatal error), so the watchdog only runs again from the
             * next fragment request, re-armed by each request, loaded fragment
             * and appended segment. When not even a playlist arrived, the server
             * is not delivering at all, so the timeout counts as a network error
             * (a transcode would not help).
             * -----------------------------------------------------------------
             */
            const armLoadWatchdog = () => {
                clearTimeout(loadWatchdog);
                if (resolved) return;
                loadWatchdog = setTimeout(() => {
                    const noData = !sawData && !(video.readyState > 0);
                    failHls(new PlaybackLoadTimeoutError(LOAD_WATCHDOG_HLS_MS, noData));
                }, LOAD_WATCHDOG_HLS_MS);
            };
            const onManifestLoaded = () => {
                sawData = true;
            };
            const onLevelLoaded = () => {
                sawData = true;
                if (playlistsLoaded) return;
                playlistsLoaded = true;
                clearTimeout(loadWatchdog);
            };
            const onMediaLoaded = () => {
                sawData = true;
                armLoadWatchdog();
            };
            hls.on(Hls.Events.MANIFEST_LOADED, onManifestLoaded);
            hls.on(Hls.Events.LEVEL_LOADED, onLevelLoaded);
            hls.on(Hls.Events.FRAG_LOADING, armLoadWatchdog);
            hls.on(Hls.Events.FRAG_LOADED, onMediaLoaded);
            hls.on(Hls.Events.BUFFER_APPENDED, onMediaLoaded);
            armLoadWatchdog();

            hls.loadSource(options.url);
            hls.attachMedia(video);
            this._hlsPlayer = hls;
        });
    }

    /**
     * Bounded recovery for one Hls.js instance.
     *
     * - Fatal network errors: retried with backoff (1 s, 2 s, 4 s); an HTTP
     *   4xx/5xx response or a fourth failure in a row gives up. A loaded
     *   fragment resets the count. A manifest that failed is requested again
     *   with loadSource(): startLoad() does not reload it.
     * - Fatal media errors: recoverMediaError(), then swapAudioCodec() +
     *   recoverMediaError(), each at most once per 3 s window; a third error
     *   inside the window gives up (same policy as jellyfin-web).
     *   At most HLS_MAX_DECODER_RESETS resets in all, until playback got
     *   HLS_MEDIA_RECOVERY_PROGRESS_S past every earlier reset.
     * - Other fatal errors give up straight away.
     *
     * @private
     * @param {Hls} hls
     * @param {Function} fail - (error) => void, called when recovery is exhausted
     * @param {string} [url] - Manifest URL, loaded again after a manifest error (default: hls.url)
     * @returns {{onError: Function, onFragLoaded: Function}} Hls.js event handlers
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
                    log.warn('WebOSPlayer: Hls.js non-fatal buffer stall');
                } else {
                    log.warn('WebOSPlayer: Hls.js non-fatal error', data.details);
                }
                return;
            }
            log.error('WebOSPlayer: Hls.js fatal error', data.type, data.details);

            if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
                const status = data.response?.code || 0;
                if (status >= 400 || networkRetries >= HLS_MAX_NETWORK_RETRIES) {
                    const error = new Error(`Hls.js network error (${data.details}${status ? `, HTTP ${status}` : ''})`);
                    error.code = 2;
                    error.isNetworkError = true;
                    fail(error);
                    return;
                }
                const delay = 1000 * Math.pow(2, networkRetries);
                networkRetries++;
                log.info(`WebOSPlayer: Retrying Hls.js load in ${delay} ms (attempt ${networkRetries}/${HLS_MAX_NETWORK_RETRIES})`);
                // startLoad() does not request a manifest that never loaded (hls.js 1.7:
                // with no levels it only flags a start for later), so that retry did
                // nothing and no further event came
                const reloadManifest = HLS_MANIFEST_ERRORS.indexOf(data.details) !== -1;
                this._timer(() => {
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
                // A decoder that fails at the same spot each time playback gets back to it
                // is not reset forever: the count starts over only once playback got well
                // past every earlier reset. The furthest spot counts: the position is 0
                // while the element reloads after a reset.
                const media = hls.media || this._videoElement;
                const position = media && media.currentTime > 0 ? media.currentTime : 0;
                if (position - resetPosition >= HLS_MEDIA_RECOVERY_PROGRESS_S) decoderResets = 0;
                const canReset = decoderResets < HLS_MAX_DECODER_RESETS;
                if (canReset && now - lastDecoderReset > HLS_MEDIA_RECOVERY_WINDOW_MS) {
                    lastDecoderReset = now;
                    decoderResets++;
                    resetPosition = Math.max(resetPosition, position);
                    log.info('WebOSPlayer: Attempting Hls.js media error recovery');
                    hls.recoverMediaError();
                } else if (canReset && now - lastCodecSwap > HLS_MEDIA_RECOVERY_WINDOW_MS) {
                    lastCodecSwap = now;
                    decoderResets++;
                    resetPosition = Math.max(resetPosition, position);
                    log.info('WebOSPlayer: Attempting Hls.js media error recovery with audio codec swap');
                    hls.swapAudioCodec();
                    hls.recoverMediaError();
                } else {
                    if (!canReset) {
                        log.warn(`WebOSPlayer: Hls.js decoder reset ${decoderResets} times without progress`);
                    }
                    const error = new Error(`Hls.js media error (${data.details})`);
                    error.code = 3;
                    fail(error);
                }
                return;
            }

            fail(new Error(`Hls.js fatal error (${data.details})`));
        };

        const onFragLoaded = () => {
            networkRetries = 0;
        };

        return { onError, onFragLoaded };
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
        log.debug('WebOSPlayer._applyInitialTracks: audio stream', options.audioStreamIndex, '/ list index',
            options.audioTrackListIndex, hls
                ? `— Hls.js tracks: ${describeAudioTracks(hls.audioTracks)}`
                : `— native tracks: ${describeAudioTracks(this._videoElement && this._videoElement.audioTracks)}`);

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
                // ─────────────────────────────────────────────────────────────
                // Progressive DirectPlay track selection
                // ─────────────────────────────────────────────────────────────
                // Retrieve the actual default audio track index from the container streams.
                // This is necessary because options.mediaSource.DefaultAudioStreamIndex holds
                // the server-resolved preference track, but for progressive DirectPlay,
                // the TV natively plays whatever track is designated default in the file.
                const defaultIndex = this._getContainerDefaultAudioIndex(options.mediaSource);

                // Track stream index requested by the player UI
                const requestedIndex = options.audioStreamIndex;

                // Compare requested index against actual container default index.
                // NOTE: Do not compare against options.mediaSource.DefaultAudioStreamIndex because
                // Jellyfin dynamically echoes the requested AudioStreamIndex there, which would
                // falsely cause every requested track to be treated as container default!
                const isDefaultTrack = (defaultIndex !== undefined && Number(requestedIndex) === Number(defaultIndex)) ||
                                       (defaultIndex === undefined && resolvedIndex === 0);

                // ---------------------------------------------------------------------
                // Container Default Track Playability Verification
                // ---------------------------------------------------------------------
                // Resolve the container's designated default audio stream metadata.
                // We must verify that the default track is actually natively decodable
                // by the WebOS media engine before assuming it is playing in hardware.
                // If the default track is TrueHD or an unsupported format, the hardware
                // is NOT playing it successfully, so we must not skip track switching.
                // ---------------------------------------------------------------------
                const defaultStream = options.mediaSource?.MediaStreams?.find(
                    s => s.Type === 'Audio' && s.Index === Number(defaultIndex)
                );
                const isDefaultPlayable = isWebOSAudioTrackPlayable(defaultStream);

                // If the requested track is already the container's default track AND
                // that default track is confirmed natively decodable, WebOS hardware
                // is already demuxing and playing it natively.
                // Skipping track switch prevents spurious audiotrackswitchfailed events.
                if (isDefaultTrack && isDefaultPlayable) {
                    log.info('WebOSPlayer: _applyInitialTracks — requested track', requestedIndex,
                        'is container default and natively playable. Already playing in hardware, skipping track switch.');
                    return;
                }

                // If audioTracks collection is absent or empty, we cannot switch tracks in the browser
                if (!nativeTracks || nativeTracks.length === 0) {
                    log.warn('WebOSPlayer: _applyInitialTracks — audioTracks empty, requested index', requestedIndex,
                        '≠ container default', defaultIndex, '. Scheduling deferred remux restart.');
                    // Reported by play() once it has resolved: JellyfinPlayer restarts the
                    // item on it, and a restart while play() is still pending cancels that
                    // play(). A 0 ms timer started here fired before video.play() resolved
                    // (Chromium resolves it only once playback starts).
                    this._startupTrackSwitchFailure = { listIndex: resolvedIndex };
                    // Until then the file's default track must not be heard: the element stays
                    // muted, past 'playing' too, until the restart's stop() lifts the mute
                    const video = this._videoElement;
                    if (video && !video.muted) {
                        video.muted = true;
                        this._resumeAudioSuppressed = true;
                    }
                    this._resumeTrackSwitchPending = true;
                } else {
                    // Non-default track requested and nativeTracks is populated: switch via HTML5 audioTracks
                    const outputIndex = nativeTracks.length <= 1 ? 0 : resolvedIndex;
                    if (!this._isHls && options.playerStartPositionTicks > 0) {
                        // Resuming direct play: switching before playback moves (even right at
                        // 'playing') left the webOS pipeline stalled with an empty buffer at the resume
                        // position, so wait until 0.3 s have actually played. Seek jumps do not count
                        // as played time. The resume mute stays on until then, so the default track
                        // is not heard.
                        const video = this._videoElement;
                        let lastTime = video.currentTime;
                        let played = 0;
                        this._resumeTrackSwitchPending = true;
                        let removeListener = null;
                        const onTimeUpdate = () => {
                            if (this._currentPlayOptions !== options) {
                                removeListener();
                                return;
                            }
                            const step = video.currentTime - lastTime;
                            lastTime = video.currentTime;
                            if (step > 0 && step < 1) played += step;
                            if (played < 0.3) return;
                            removeListener();
                            this._resumeTrackSwitchPending = false;
                            this.setAudioStreamIndex(outputIndex);
                            if (this._resumeAudioSuppressed) {
                                this._resumeAudioSuppressed = false;
                                this.setMuted(false);
                            }
                        };
                        removeListener = this._listen(video, 'timeupdate', onTimeUpdate);
                    } else {
                        this.setAudioStreamIndex(outputIndex);
                    }
                }
            }
        }

        // ---- Subtitle track ----
        // SubtitleManager renders every subtitle on webOS (text tracks are
        // requested as External, which Jellyfin prefers over Hls). Keep any
        // Hls.js subtitle rendition off: options.subtitleStreamIndex is a
        // Jellyfin stream index, not a position in hls.subtitleTracks, so
        // selecting by it could show a second, wrong track.
        if (hls && hls.subtitleTrack !== -1) {
            hls.subtitleTrack = -1;
        }
    }

    /**
     * Handle autoplay policy rejections — mute the video and retry,
     * then schedule an unmute once the user physically interacts with the TV.
     * @private
     */
    _handleAutoplayError(err, video, options, resolve, reject) {
        const session = this._sessionId;
        if (err.name === 'NotAllowedError') {
            log.warn('WebOSPlayer: Autoplay blocked — retrying muted (remote launch)');
            video.muted = true;
            video.play()
                .then(() => {
                    if (this._isSessionActive(session)) {
                        this._applyRobustResume(video, options.playerStartPositionTicks);
                        this._scheduleUnmuteOnInteraction(video);
                    }
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

        const generation = this._resumeGeneration;
        let polls = 0;
        const tryApply = () => {
            if (generation !== this._resumeGeneration || this._robustSeekTarget === null) return;

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
                } else if (++polls < ROBUST_RESUME_MAX_POLLS) {
                    this._timer(tryApply, 300);
                } else {
                    log.warn('WebOSPlayer: Media never became seekable for the resume seek — giving up the robust resume');
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
        // A user seek, stop() or a new play() bumps the generation and ends this loop
        const generation = this._resumeGeneration;
        let tries = 0;
        const video = this._videoElement;

        log.info('WebOSPlayer: Applying robust resume seek to', time, 's');

        // --------------------------------------------------------------------
        // Suppress video visibility and mute audio during the retry loop.
        // Prevents leaking visible playback or audio if the playhead snapped
        // back to 0:00 while the decoder processes the re-seek.
        // --------------------------------------------------------------------
        if (video) {
            this._suppressVideoForResume(video);
            if (!video.muted) {
                video.muted = true;
                this._resumeAudioSuppressed = true;
            }
        }

        const attempt = () => {
            if (generation !== this._resumeGeneration) {
                // The canceller (seek / stop / play) owns the resume state now
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
            // decoders plus forward playback advancement during the wait.
            //
            // Guard against false positives at 0:00 when target is small (< 15s).
            // ----------------------------------------------------------------
            this._timer(() => {
                if (generation !== this._resumeGeneration) return;

                // Measure how far currentTime landed from our requested target.
                const currentPos = video.currentTime || 0;
                const drift = Math.abs(currentPos - time);
                const isStuckAtZero = time >= 3 && currentPos < 0.5;
                const isNearTarget = !isStuckAtZero && (drift < 15 || (currentPos >= time && currentPos <= time + 15));

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

                    // Unmute and restore video presentation if retries exhausted
                    if (this._resumeAudioSuppressed && video) {
                        this._resumeAudioSuppressed = false;
                        this.setMuted(false);
                    }
                    if (this._resumeVideoSuppressed && video) {
                        this._restoreVideoAfterResume(video);
                    }

                    // ---------------------------------------------------------
                    // SEAMLESS HLS.JS FALLBACK ON NATIVE HLS SEEK FAILURE:
                    // If native HLS seeking failed to land (common on older hardware or
                    // exotic streams), seamlessly hand off to Hls.js MSE pipeline.
                    // Hls.js manages segments via MediaSource without relying on native #t=.
                    // ---------------------------------------------------------
                    // Fall back to Hls.js only if the stream is safe for MSE demuxing (not Dolby Vision / E-AC-3)
                    if (this._isHls && this._canUseHlsJs(this._currentPlayOptions) && !this._hlsFallbackAttempted) {
                        log.info('WebOSPlayer: Native HLS seek failed — attempting seamless fallback to Hls.js MSE pipeline');
                        this._hlsFallbackAttempted = true;
                        this._destroyHlsPlayer();
                        this._playWithHlsJs(video, this._currentPlayOptions).catch(err => {
                            log.error('WebOSPlayer: Hls.js fallback failed', err);
                            // Report it unless stop() / a newer play() cancelled it: the
                            // native pipeline is gone, so playback has nowhere to go
                            if (!err?.superseded) {
                                this.onEvent({
                                    type: 'error',
                                    data: {
                                        code: err?.code || 0,
                                        name: 'HLS_FALLBACK_FAILED',
                                        message: err?.message || 'Hls.js fallback failed',
                                        isNetworkError: Boolean(err?.isNetworkError)
                                    }
                                });
                            }
                        });
                        return;
                    }

                    // Emit event so JellyfinPlayer can handle the failure cleanly
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
                 const isStuckAtZero = resumeSeconds >= 3 && currentPos < 0.5;
                 const isNearTarget = !isStuckAtZero && (drift < 15 || (currentPos >= resumeSeconds && currentPos <= resumeSeconds + 15));
                 if (isNearTarget) {
                     log.info('WebOSPlayer: Media fragment already positioned the playhead — skipping explicit seek.');
                     // Defer unhiding video element until _onPlaying confirms active presentation
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
             let removeSeeked = null;

             const onSeeked = () => {
                 removeSeeked();
                 if (seekTimeout) clearTimeout(seekTimeout);
                 seekCompleted = true;
                 log.debug('WebOSPlayer: Explicit seek completed');
                 // The DOM 'seeked' event signals command acceptance, but the hardware decoder
                 // has not yet painted the target frame texture. We keep video suppressed
                 // until _onPlaying confirms active playback at the target position.
                 this._doPlayWithResume(video, options, resolve, reject);
             };

             removeSeeked = this._listen(video, 'seeked', onSeeked);

             try {
                 video.currentTime = resumeSeconds;
             } catch (e) {
                 // Some implementations throw synchronously for impossible/early seeks.
                 log.error('WebOSPlayer: Setting currentTime threw during resume seek', e);
             }

             // Shorter safety net: 3.5s is sufficient on most devices and avoids
             // long UI freezes when the media fragment already worked.
             seekTimeout = this._timer(() => {
                 removeSeeked();
                 if (!seekCompleted) {
                     log.warn('WebOSPlayer: Explicit seek timed out (3.5s) — starting playback from current position');
                     this._doPlayWithResume(video, options, resolve, reject);
                 }
             }, 3500);
         } else {
             // No resume seek required; ensure video surface is visible
             this._restoreVideoAfterResume(video);
             this._doPlayWithResume(video, options, resolve, reject);
         }
     }

    /**
     * Play the video and apply the robust resume safety net.
     * Extracted so both _resumeSeekThenPlay and the no-seek path converge.
     * @private
     */
    _doPlayWithResume(video, options, resolve, reject) {
        const session = this._sessionId;
        const playPromise = video.play();
        if (playPromise !== undefined && typeof playPromise.then === 'function') {
            playPromise
                .then(() => {
                    if (this._isSessionActive(session)) {
                        this._applyRobustResume(video, options.playerStartPositionTicks);
                    }
                    resolve();
                })
                .catch((err) => {
                    // Rejected because stop() / a new load interrupted it: nothing left to do
                    if (!this._isSessionActive(session)) return;
                    this._handleAutoplayError(err, video, options, resolve, reject);
                });
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
        // Session-scoped: must not unmute a later item the user muted
        this._listen(document, 'keydown', unmute, { capture: true, once: true });
        this._listen(document, 'click',   unmute, { capture: true, once: true });
        log.info('WebOSPlayer: Unmute scheduled on next user interaction');
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
        log.debug('WebOSPlayer: Suppressed video visibility for resume');
    }

    /**
     * Restore video element presentation once the resume position is landed.
     * Re-reveals the video element displaying the confirmed target resume frame.
     *
     * @private
     * @param {HTMLVideoElement} [video] - The HTML5 video element (optional, defaults to _videoElement)
     */
    _restoreVideoAfterResume(video) {
        this._resumeVideoSuppressed = false;
        const targetVideo = video || this._videoElement;
        if (targetVideo) {
            targetVideo.style.opacity = '';
            targetVideo.style.visibility = '';
            log.debug('WebOSPlayer: Restored video visibility after resume landing');
        }
    }

    /**
     * Pause playback.
     */
    pause() {
        // Disarm any queued post-seek unpause operations so an explicit pause halts playback
        const cancelledPlay = this._pendingPlayAfterSeek;
        this._pendingPlayAfterSeek = false;
        // A Dolby Vision flush holding the element paused does not resume it now: the user's
        // pause stands. Its own pause was not reported, so this one is reported below.
        const cancelledFlush = this._recoveryFlush === 'pausing';
        if (cancelledFlush) {
            clearTimeout(this._recoveryPauseTimer);
            this._recoveryPauseTimer = null;
            this._recoveryFlush = null;
        }
        const video = this._videoElement;
        if (!video) return;
        if (video.paused) {
            // A play queued behind a seek never started the element, so no 'pause'
            // event will come. JellyfinPlayer already counts playback as resumed and
            // took every later Play press for a pause (LG C4: Play did nothing until
            // the user left the item), so report the pause here.
            if (cancelledPlay || cancelledFlush) this.onEvent({ type: 'pause' });
            return;
        }
        video.pause();
    }

    /**
     * Check if player is actively seeking
     * @returns {boolean} True if WebOS HTML5 video is seeking
     */
    get isSeeking() {
        return Boolean(this._videoElement?.seeking);
    }

    /**
     * Resume playback.
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
         * But webOS carries out a seek on a paused element only once playback
         * starts. On an LG C4, a seek in a paused native-HLS remux never fired
         * 'seeked': the queued play never ran, the picture stayed frozen at the
         * new position and Play did nothing. So playback starts anyway when
         * 'seeked' has not come SEEK_PLAY_FALLBACK_MS later, and at once when
         * unpause() is asked again while a play is already queued.
         * ====================================================================
         */
        if (this._videoElement.seeking) {
            if (this._pendingPlayAfterSeek) {
                log.info('WebOSPlayer: unpause() again while the seek is pending — starting playback now');
                this._pendingPlayAfterSeek = false;
                this._playVideo();
                return;
            }
            log.debug('WebOSPlayer: seek in progress — queueing play on seeked');
            this._pendingPlayAfterSeek = true;
            this._timer(() => {
                if (!this._pendingPlayAfterSeek) return;
                this._pendingPlayAfterSeek = false;
                log.info(`WebOSPlayer: no 'seeked' ${SEEK_PLAY_FALLBACK_MS} ms after unpause() — starting playback, which completes the seek`);
                this._playVideo();
            }, SEEK_PLAY_FALLBACK_MS);
            return;
        }

        // Seek is not in flight — clear queued play flag
        this._pendingPlayAfterSeek = false;
        this._playVideo();
    }

    /** video.play() with the autoplay-policy retry. @private */
    _playVideo() {
        const video = this._videoElement;
        if (!video) return;
        video.play().catch(err => {
            if (err.name === 'NotAllowedError') {
                log.warn('WebOSPlayer: unpause blocked — retrying muted');
                video.muted = true;
                video.play().catch(e => log.error('WebOSPlayer: muted retry failed', e));
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
        // Drop the session's listeners/timers; a pending play() rejects with PlaybackAbortedError
        this._endSession();
        this._cancelResume();
        this._pendingPlayAfterSeek = false;
        this._robustSeekTarget   = null;
        if (this._directSeekVerifyTimeout) {
            clearTimeout(this._directSeekVerifyTimeout);
            this._directSeekVerifyTimeout = null;
        }
        this._clearStallCheck();
        this._destroyHlsPlayer();
        this._stopOutputWindowTimers();
        this._outputWindowActive = false;
        this._outputWindowFailures = 0;
        this._outputWindowRerun = false;
        // One rejected item (a pipeline that never registered, a busy service) must not
        // turn the output window off for the rest of the app session; two in a row do
        if (this._outputWindowState === 'failed' && this._outputWindowFailedItems < 2) {
            this._outputWindowState = 'unknown';
        }
        // A recovery kick on this item must not hold back stall recovery on the next one
        this._lastRecoveryKickTime = 0;

        const video = this._videoElement;

        if (this._resumeAudioSuppressed && video) {
            video.muted = false;
        }

        this._resumeAudioSuppressed = false;
        this._resumeTrackSwitchPending = false;

        // --------------------------------------------------------------------
        // Keep the stopped video element visually suppressed so any decoded frame
        // lingering in the hardware buffer is not shown before the next session.
        // --------------------------------------------------------------------
        if (video) {
            video.style.opacity = '0';
            video.style.visibility = 'hidden';
        }
        this._resumeVideoSuppressed = false;

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

        // --------------------------------------------------------------------
        // Audio normalization: an element routed into Web Audio cannot be routed
        // back, and closing its AudioContext silences it. Release the graph with
        // the element; the next item starts on a fresh <video>.
        // --------------------------------------------------------------------
        if (this._audioGraph) {
            this._replaceVideoElement();
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

        // Cancel any pending retry loops (startup resume or earlier seeks): they
        // must not pull the playhead back after the user moved it
        this._cancelResume();
        const generation = this._resumeGeneration;

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

        // Skip tiny seeks — avoids decoder stutter on redundant calls
        if (Math.abs(video.currentTime - seconds) > SEEK_THRESHOLD_MS / 1000) {
            video.currentTime = Math.max(0, seconds);
        }

        // ---------------------------------------------------------------------
        // Defer timeupdate to native demuxer arrival:
        // Do NOT fire a synthetic timeupdate here with seconds. In HLS
        // (especially with transcoded audio and direct-streamed video), the
        // webOS hardware demuxer lands on the nearest GOP keyframe, which
        // may differ by 1–5 seconds from requested seconds. Emitting a synthetic
        // timeupdate prematurely causes SubtitleManager and the UI clock to desync
        // before the presentation time is settled.
        // The authoritative timeupdate will fire from _onSeeked once the hardware
        // demuxer completes repositioning.
        // ---------------------------------------------------------------------

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
            this._directSeekVerifyTimeout = this._timer(() => {
                this._directSeekVerifyTimeout = null;
                if (generation !== this._resumeGeneration || !this._videoElement) return;
                const cur = this.getCurrentTime();
                // Distance either way: being past the target is no proof a backward seek worked
                const isNear = Math.abs(cur - seconds) < 15;
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
        log.debug('WebOSPlayer.setAudioStreamIndex: list index', listIndex);

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
            // If listIndex is 0 (first/default track), the container default track is
            // already active and playing natively. There is no reason to restart.
            if (listIndex === 0) {
                log.info('WebOSPlayer: video.audioTracks is empty for direct-play, but listIndex is 0 (default track already playing). Skipping restart.');
                return;
            }

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
            // Check if this stream is the container default track (e.g. TrueHD or DTS).
            // Passthrough formats are omitted from Chromium's audioTracks collection,
            // returning nativeIndex -1. But since it is the default track, the TV hardware
            // is already bitstreaming it over eARC natively — do NOT abort DirectPlay.
            // ================================================================
            // Verify Container Default Stream or Primary Passthrough Stream
            // ================================================================
            // Passthrough codecs (such as DTS-HD MA and TrueHD) are not mapped
            // inside Chromium's audioTracks collection, yielding nativeIndex -1.
            // When listIndex is 0 (the primary audio track) or when the track matches
            // the container/server default, the WebOS hardware media engine is
            // already bitstreaming this track over HDMI eARC natively.
            // Suppress the restart to maintain seamless DirectPlay.
            // ================================================================
            const mediaStreams = this._currentPlayOptions?.mediaSource?.MediaStreams || [];
            // Filter audio streams matching user player configuration
            const audioStreams = mediaStreams.filter(s => {
                if (s.Type !== 'Audio') return false;
                const codec = (s.Codec || '').toLowerCase();
                if (codec === 'truehd' && !isTrueHdSupported()) return false;
                if ((codec.includes('dts') || codec === 'dca') && !isDtsSupported()) return false;
                if (codec === 'alac' && !PlayerSettings.get('enableFlacInVideo')) return false;
                return true;
            });
            // Resolve target stream from filtered audio list, falling back to all audio streams
            const targetStream = audioStreams[listIndex] || mediaStreams.filter(s => s.Type === 'Audio')[listIndex];

            const isDefault = targetStream
                ? (targetStream.IsDefault || listIndex === 0)
                : (listIndex === 0);

            // -----------------------------------------------------------------
            // Hardware Decoding Capability Check on Target Stream
            // -----------------------------------------------------------------
            // Only suppress the restart if the track is actually decodable or
            // genuinely bitstreamable by the TV hardware (e.g. DTS passthrough).
            // For unsupported codecs like Dolby TrueHD, suppression leaves the user
            // stranded with no audio or player stalls. Firing audiotrackswitchfailed
            // initiates a seamless server remux (DirectStream) with transcoded audio.
            // -----------------------------------------------------------------
            const isTargetPlayable = isWebOSAudioTrackPlayable(targetStream);

            if (isDefault && isTargetPlayable) {
                log.info('WebOSPlayer: _resolveNativeAudioIndex returned out-of-range index for playable default/primary track (passthrough codec playing natively). Skipping restart.');
                return;
            }

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

        // ---------------------------------------------------------------------
        // Filter Candidate Streams Strictly to Audio Type
        // ---------------------------------------------------------------------
        // NOTE: We deliberately do NOT filter out TrueHD, DTS, or other codecs here.
        // This function determines the physical container default audio track as
        // written in the media container header on disk.
        //
        // If an unplayable format like TrueHD were filtered out here, a secondary
        // track (such as AC3) would be misidentified as the container default,
        // causing _applyInitialTracks to falsely skip track switching while the
        // TV hardware actually begins playing the real default track (TrueHD).
        // ---------------------------------------------------------------------
        const audioStreams = mediaSource.MediaStreams.filter(s => s.Type === 'Audio');

        // 1. Check if an audio stream is explicitly marked IsDefault in container metadata
        const containerDefault = audioStreams.find(s => s.IsDefault);
        if (containerDefault) return containerDefault.Index;

        // 2. Default to the first available audio track if none are explicitly marked.
        // NOTE: We do not check mediaSource.DefaultAudioStreamIndex because Jellyfin
        // dynamically overrides it with the client-requested track.
        const defaultStream = audioStreams[0];
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
            log.warn('WebOSPlayer._resolveNativeAudioIndex: nativeTracks is empty');
            return -1;
        }

        // Fast-path: single native track — no ambiguity possible
        if (nativeTracks.length === 1) {
            log.debug('WebOSPlayer._resolveNativeAudioIndex: single native track fast-path → 0');
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
            if (codec === 'alac' && !PlayerSettings.get('enableFlacInVideo')) return false;
            return true;
        });

        log.debug('WebOSPlayer._resolveNativeAudioIndex: list index', listIndex,
            '— Jellyfin streams:', jellyfinAudioStreams
                .map((st, idx) => `[${idx}] #${st.Index} ${st.Language || '?'} ${st.Codec}${st.IsDefault ? ' (default)' : ''}`)
                .join(', '),
            '— native tracks:', describeAudioTracks(nativeTracks));

        // Guard: ensure listIndex points to a valid Jellyfin audio stream
        const targetStream = jellyfinAudioStreams[listIndex];
        if (!targetStream) {
            log.warn('WebOSPlayer: listIndex out of range, returning clamped fallback');
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
                    log.debug(`WebOSPlayer: Target codec "${targetCodec}" is unsupported by native player → returning -1`);
                    return -1;
                }

                const nativeIdx = playableStreams.findIndex(s => s.Index === targetStream.Index);
                if (nativeIdx >= 0) {
                    log.debug(`WebOSPlayer: Codec-aware mapping resolved listIndex ${listIndex} → native index ${nativeIdx}`);
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
                log.debug('WebOSPlayer: Resolved native audio index by unique language match', listIndex, '→', nativeMatches[0]);
                return nativeMatches[0];
            }

            if (nativeMatches.length > 1) {
                const sameLanguageStreams = jellyfinAudioStreams.filter(s => normalize(s.Language || '') === normTarget);
                const posWithinLang = sameLanguageStreams.findIndex(s => s.Index === targetStream.Index);
                if (posWithinLang >= 0 && posWithinLang < nativeMatches.length) {
                    log.debug('WebOSPlayer: Disambiguated same language match', listIndex, '→', nativeMatches[posWithinLang]);
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
                    log.debug('WebOSPlayer: Resolved via default reordering (target is default) → 0');
                    return 0;
                }

                const resolvedIndex = listIndex < defaultListIndex ? listIndex + 1 : listIndex;
                if (resolvedIndex >= 0 && resolvedIndex < nativeTracks.length) {
                    log.debug('WebOSPlayer: Resolved via default reordering (non-default)', listIndex, '→', resolvedIndex);
                    return resolvedIndex;
                }
            }
        }

        // ====================================================================
        // Strategy 4: Positional Fallback — clamped to native track bounds
        // ====================================================================
        const fallbackIndex = Math.min(Math.max(0, listIndex), nativeTracks.length - 1);
        log.debug('WebOSPlayer: Clamped positional fallback used', listIndex, '→', fallbackIndex);
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

        // Toggle native text tracks. 'disabled', not 'hidden': a hidden track
        // still loads and fires cue events. JellyfinPlayer only ever passes -1
        // on webOS (SubtitleManager renders), so a non-negative index is a
        // textTracks position here.
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
     *
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
     * and cues added since (Hls.js WebVTT segments, a track still loading),
     * which carry none yet, get it too.
     * @private
     */
    _applySubtitleOffset() {
        const seconds = this._subtitleOffset;
        const video = this._videoElement;
        if (!video || !video.textTracks) {
            log.debug('WebOSPlayer: Subtitle offset stored:', seconds, 's (no video/tracks)');
            return;
        }

        for (let i = 0; i < video.textTracks.length; i++) {
            const track = video.textTracks[i];
            if (track.mode !== 'showing' || !track.cues) continue;
            for (let j = 0; j < track.cues.length; j++) {
                const cue = track.cues[j];
                let base = this._cueBaseTimes.get(cue);
                if (!base) {
                    // Not moved yet: only this method moves cues
                    base = [cue.startTime, cue.endTime];
                    this._cueBaseTimes.set(cue, base);
                }
                if (cue.startTime !== base[0] + seconds) cue.startTime = base[0] + seconds;
                if (cue.endTime !== base[1] + seconds) cue.endTime = base[1] + seconds;
            }
            log.debug('WebOSPlayer: Subtitle offset applied:', seconds, 's');
        }
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
     * Set the video's aspect ratio mode.
     *
     * WebOS Hardware Display Architecture:
     * - Video decoding is handled by a dedicated hardware overlay plane beneath the web runtime.
     * - The TV hardware video scaler maps its output window directly to the layout bounding box
     *   (left, top, width, height) of the <video> DOM element.
     * - The webOS hardware pipeline does not evaluate CSS object-fit properties on <video>.
     * - Therefore, aspect ratio modes (auto, zoom, stretch) are achieved by explicitly computing
     *   and applying layout geometry coordinates to the element style.
     *
     * @param {'auto'|'zoom'|'stretch'} mode
     */
    setAspectRatio(mode) {
        // Fallback safely to auto if an invalid or empty mode is passed
        const targetMode = mode || 'auto';

        // --------------------------------------------------------------------
        // Reset Aspect Ratio Before Applying Zoom
        // --------------------------------------------------------------------
        // If previous mode was 'stretch' (or any non-default mode), reset the
        // layout box to 'auto' first so residual stretch styling is cleared before
        // computing and applying the oversized zoom bounding box.
        if (targetMode === 'zoom' && !this._canUseOutputWindow()) {
            log.info('WebOSPlayer: Resetting aspect ratio to auto prior to applying zoom');
            this._aspectMode = 'auto';
            if (this._videoElement) {
                this._fitVideoBox();
            }
        }

        // Normalize aspect mode, falling back to 'auto'
        this._aspectMode = targetMode;
        if (!this._videoElement) return;

        log.info('WebOSPlayer: Setting aspect ratio mode:', this._aspectMode);

        // Recalculate and apply explicit layout coordinates for the hardware punch-through window
        this._fitVideoBox();
    }

    /**
     * Get active aspect ratio mode.
     * @returns {'auto'|'zoom'|'stretch'}
     */
    getAspectRatio() {
        return this._aspectMode || 'auto';
    }

    /**
     * Resolve intrinsic video stream dimensions with comprehensive fallback hierarchy.
     *
     * On webOS TV (particularly webOS 5 and native HLS demuxers), the <video> element
     * often returns 0 for videoWidth/videoHeight around loadedmetadata, or delays dimension
     * reporting until active frame rendering begins. Furthermore, 1080p stream containers
     * may package letterboxed cinemascope (e.g. 2.40:1) content where videoWidth/videoHeight
     * report 1920x1080 despite the actual content aspect ratio being wide.
     *
     * Resolution hierarchy:
     *   1. Direct HTML5 video element intrinsic dimensions (videoWidth / videoHeight)
     *   2. HLS.js current variant level dimensions if MSE pipeline is running
     *   3. Jellyfin playback options MediaStreams (Type === 'Video')
     *   4. MediaSource container width/height fallback
     *   5. Item metadata width/height fallback
     *   6. AspectRatio string evaluation for letterboxed or anamorphic content
     *
     * @private
     * @returns {{ width: number, height: number } | null}
     */
    _getVideoDimensions() {
        const video = this._videoElement;

        // 1. Direct HTML5 video element intrinsic dimensions
        let vw = video?.videoWidth || 0;
        let vh = video?.videoHeight || 0;

        // 2. HLS.js variant level dimensions if MSE pipeline is running
        if ((!vw || !vh) && this._hlsPlayer) {
            const level = this._hlsPlayer.levels?.[this._hlsPlayer.currentLevel];
            if (level?.width && level?.height) {
                vw = level.width;
                vh = level.height;
            }
        }

        // 3. Jellyfin MediaStreams video stream metadata
        const mediaSource = this._currentPlayOptions?.mediaSource;
        const videoStream = mediaSource?.MediaStreams?.find((s) => s.Type === 'Video');
        if ((!vw || !vh) && videoStream) {
            vw = videoStream.Width || 0;
            vh = videoStream.Height || 0;
        }

        // 4. MediaSource container width/height fallback
        if ((!vw || !vh) && mediaSource) {
            vw = mediaSource.Width || 0;
            vh = mediaSource.Height || 0;
        }

        // 5. Item width/height fallback
        const item = this._currentPlayOptions?.item;
        if ((!vw || !vh) && item) {
            vw = item.Width || 0;
            vh = item.Height || 0;
        }

        // 6. Content dimensions accounting for baked letterbox / pillarbox bars
        let contentWidth = vw;
        let contentHeight = vh;

        // AspectRatio string evaluation for letterboxed or anamorphic content
        const aspectStr = videoStream?.AspectRatio || item?.AspectRatio || '';
        if (aspectStr && typeof aspectStr === 'string') {
            let parsedRatio = 0;
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

            if (parsedRatio > 0) {
                // If dimensions are currently absent, synthesize baseline dimensions
                if (!vw || !vh) {
                    vw = 1920;
                    vh = Math.round(1920 / parsedRatio);
                    contentWidth = vw;
                    contentHeight = vh;
                } else {
                    // Check if content aspect ratio differs from container aspect ratio
                    const containerRatio = vw / vh;
                    if (Math.abs(containerRatio - parsedRatio) > 0.05) {
                        if (parsedRatio > containerRatio) {
                            // Ultra-wide cinemascope in 16:9 container (e.g. 2.40:1 in 1080p)
                            contentHeight = Math.round(vw / parsedRatio);
                        } else {
                            // 4:3 pillarbox in 16:9 container
                            contentWidth = Math.round(vh * parsedRatio);
                        }
                    }
                }
            }
        }

        // Verify positive integer dimensions before returning
        if (vw > 0 && vh > 0) {
            return {
                width: vw,
                height: vh,
                contentWidth: contentWidth || vw,
                contentHeight: contentHeight || vh
            };
        }

        return null;
    }

    /**
     * Calculate and apply layout geometry for the <video> element.
     *
     * On webOS TV, the hardware video plane is aligned and scaled directly to the element's layout rect.
     * We support three distinct modes:
     *   1. 'auto' (Letterbox / Contain): Scale down using Math.min so the entire video fits inside the screen,
     *      centering it with pillarbox or letterbox black borders.
     *   2. 'zoom' (Crop / Cover): Scale up using Math.max so the video completely fills the screen without bars,
     *      cropping symmetrically on the overflowing axis via negative offsets.
     *   3. 'stretch' (Fill): Force the video box to match 100% of the screen width and height (0,0 to cw,ch),
     *      stretching non-16:9 streams across the entire display panel.
     *
     * @private
     */
    _fitVideoBox() {
        const video = this._videoElement;
        if (!video) return;

        // Container dimensions with fallback to viewport dimensions
        const cw = (this.container && this.container.clientWidth) || window.innerWidth || 1920;
        const ch = (this.container && this.container.clientHeight) || window.innerHeight || 1080;

        // Container has no valid layout dimensions yet
        if (!cw || !ch) return;

        // The TV crops via _applyOutputWindow. The box covers the screen because the TV clips the
        // picture (and the OSD over it) to the box when the page is composited above the video.
        if (this._canUseOutputWindow()) {
            this._applyVideoBox(video, this._fullScreenBox(cw, ch, 'fill'));
            this._applyOutputWindow();
            return;
        }

        this._applyVideoBox(video, this._computeVideoBox(cw, ch));
    }

    /** A box covering the whole container. @private */
    _fullScreenBox(cw, ch, objectFit) {
        return { left: 0, top: 0, width: cw, height: ch, anchored: true, objectFit };
    }

    /**
     * Video box for the current aspect mode inside a cw × ch container.
     * @private
     * @returns {{left: number, top: number, width: number, height: number, anchored: boolean, objectFit: string}}
     */
    _computeVideoBox(cw, ch) {
        // ====================================================================
        // Mode 1: Fullscreen Stretch
        // ====================================================================
        // Forces the hardware video plane to stretch edge-to-edge across the screen
        if (this._aspectMode === 'stretch') {
            return this._fullScreenBox(cw, ch, 'fill');
        }

        // Intrinsic video stream dimensions with comprehensive fallback chain
        const dims = this._getVideoDimensions();
        const vw = dims?.width || 0;
        const vh = dims?.height || 0;
        const cwContent = dims?.contentWidth || vw;
        const chContent = dims?.contentHeight || vh;

        // If metadata has not loaded yet, default to full viewport until metadata/playback initializes
        if (!vw || !vh) {
            return this._fullScreenBox(cw, ch, 'contain');
        }

        // ====================================================================
        // Mode 2: Zoom (Cover / Crop) scales by the larger factor to cover the
        // screen and crops the overflowing edges symmetrically (negative offsets).
        // Mode 3: Auto (Contain / Letterbox) scales by the smaller factor to fit
        // the screen and centers the picture between the bars.
        // ====================================================================
        const zoom = this._aspectMode === 'zoom';
        const scale = zoom ? Math.max(cw / cwContent, ch / chContent) : Math.min(cw / vw, ch / vh);
        const w = Math.round(vw * scale);
        const h = Math.round(vh * scale);
        return {
            left: Math.round((cw - w) / 2),
            top: Math.round((ch - h) / 2),
            width: w,
            height: h,
            anchored: false,
            objectFit: zoom ? 'cover' : 'contain'
        };
    }

    /**
     * Write the video box to the element's inline style, only when it changed.
     * _fitVideoBox runs on every 'playing' (after each seek, unpause and
     * rebuffer), 'resize' and container resize; rewriting identical styles
     * still invalidates style and layout on the TV each time.
     * @private
     * @param {HTMLVideoElement} video
     * @param {{left: number, top: number, width: number, height: number, anchored: boolean, objectFit: string}} box
     * @returns {boolean} Whether the styles were written
     */
    _applyVideoBox(video, box) {
        const key = `${box.left},${box.top},${box.width},${box.height},${box.anchored},${box.objectFit}`;
        if (this._appliedVideoBox && this._appliedVideoBox.video === video && this._appliedVideoBox.key === key) {
            return false;
        }

        const style = video.style;
        // Absolute positioning within the container, no residual margins
        style.position = 'absolute';
        style.margin = '0';
        style.left = `${box.left}px`;
        style.top = `${box.top}px`;
        // A full-screen box is anchored on all four edges; a computed one only by left/top
        style.right = box.anchored ? '0px' : '';
        style.bottom = box.anchored ? '0px' : '';
        style.width = `${box.width}px`;
        style.height = `${box.height}px`;
        style.objectFit = box.objectFit;
        style.objectPosition = 'center';
        this._appliedVideoBox = { video, key };
        return true;
    }

    /** Old webOS (Chromium < 79) cannot crop centered via the box, so the TV's video output service does it. */
    _canUseOutputWindow() {
        return platformInfo.chromeVersion < 79 &&
            this._outputWindowState !== 'failed' &&
            typeof window.PalmServiceBridge !== 'undefined';
    }

    _callLuna(uri, params) {
        return new Promise((resolve) => {
            let bridge = null;
            let timer = null;
            const done = (reply) => {
                clearTimeout(timer);
                try { if (bridge) bridge.cancel(); } catch (e) { /* ignore */ }
                resolve(reply);
            };
            try {
                bridge = new window.PalmServiceBridge();
                bridge.onservicecallback = (msg) => {
                    try { done(JSON.parse(msg)); } catch (e) { done({ returnValue: false }); }
                };
                timer = setTimeout(() => done({ returnValue: false }), 5000);
                bridge.call(uri, JSON.stringify(params));
            } catch (e) {
                done({ returnValue: false });
            }
        });
    }

    /** Source crop (video px) and target rectangle (screen px) for the video output service. */
    _computeOutputWindow(mode, vw, vh, sw, sh) {
        const full = { x: 0, y: 0, width: vw, height: vh };
        const screenRect = { x: 0, y: 0, width: sw, height: sh };

        if (mode === 'stretch') {
            // A source with the screen's aspect ratio leaves nothing to letterbox
            const declared = { x: 0, y: 0, width: vw, height: Math.round((vw * sh) / sw) };
            return { original: declared, source: declared, output: screenRect };
        }

        if (mode === 'zoom') {
            if (vw / vh < sw / sh) {
                const h = Math.round((vw * sh) / sw);
                return {
                    original: full,
                    source: { x: 0, y: Math.round((vh - h) / 2), width: vw, height: h },
                    output: screenRect
                };
            }
            const w = Math.round((vh * sw) / sh);
            return {
                original: full,
                source: { x: Math.round((vw - w) / 2), y: 0, width: w, height: vh },
                output: screenRect
            };
        }

        const scale = Math.min(sw / vw, sh / vh);
        const w = Math.round(vw * scale);
        const h = Math.round(vh * scale);
        return {
            original: full,
            source: full,
            output: { x: Math.round((sw - w) / 2), y: Math.round((sh - h) / 2), width: w, height: h }
        };
    }

    /**
     * Send the aspect mode to the TV (once per load plus a slow refresh), else fall back to the box geometry.
     * One request at a time: a Luna call can take up to 5 s, and _fitVideoBox asks again on every
     * 'playing', resize and refresh tick. A request made meanwhile runs once the current one is done.
     */
    async _applyOutputWindow() {
        if (this._outputWindowInFlight) {
            this._outputWindowRerun = true;
            return;
        }
        this._outputWindowInFlight = true;
        try {
            await this._sendOutputWindow();
        } finally {
            this._outputWindowInFlight = false;
        }
        if (this._outputWindowRerun) {
            this._outputWindowRerun = false;
            await this._applyOutputWindow();
        }
    }

    /** @private */
    async _sendOutputWindow() {
        const video = this._videoElement;
        if (!video) return;

        const mode = this._aspectMode;
        if (mode === 'auto' && !this._outputWindowActive) {
            this._stopOutputWindowTimers();
            return;
        }

        const vw = video.videoWidth;
        const vh = video.videoHeight;
        // No metadata yet, loadedmetadata/resize will fit the box again
        if (!vw || !vh) return;

        const mediaId = video.mediaId;
        let ok = false;
        // A new pipeline registers with the service a few seconds after load (errorCode 53 until then)
        let pending = !mediaId;

        if (mediaId) {
            const sw = window.screen.width || window.innerWidth || 1920;
            const sh = window.screen.height || window.innerHeight || 1080;
            const rects = this._computeOutputWindow(mode, vw, vh, sw, sh);

            const reply = await this._callLuna('luna://com.webos.service.videooutput/display/setDisplayWindow', {
                context: mediaId,
                sourcePort: 3,
                originalInput: rects.original,
                sourceInput: rects.source,
                displayOutput: rects.output,
                fullScreen: false
            });

            // The mode or the element changed while the call was in flight
            if (mode !== this._aspectMode || video !== this._videoElement) return;
            ok = Boolean(reply && reply.returnValue);
            pending = Boolean(reply && reply.errorCode === 53);
        }

        if (ok) {
            if (this._outputWindowState !== 'ok') {
                log.info('WebOSPlayer: video output window accepted by the TV for mode', mode);
            }
            this._outputWindowState = 'ok';
            this._outputWindowFailedItems = 0;
            this._outputWindowFailures = 0;
            this._outputWindowActive = mode !== 'auto';

            if (mode === 'auto') {
                this._stopOutputWindowTimers();
            } else {
                this._scheduleOutputWindowRefresh();
            }
            return;
        }

        this._outputWindowFailures++;
        if (this._outputWindowFailures < (pending ? 40 : 5)) {
            clearTimeout(this._outputWindowRetryTimer);
            this._outputWindowRetryTimer = setTimeout(() => this._applyOutputWindow(), 500);
            return;
        }

        log.warn('WebOSPlayer: TV rejected the video output window, using layout geometry instead');
        this._outputWindowState = 'failed';
        this._outputWindowFailedItems++;
        this._outputWindowActive = false;
        this._stopOutputWindowTimers();
        this._fitVideoBox();
    }

    /**
     * Re-send an accepted window now and then, in case the TV drops it. Every 3 s at first, then
     * every 30 s: _fitVideoBox re-sends it anyway on load, 'playing' (each seek) and resize.
     * @private
     */
    _scheduleOutputWindowRefresh() {
        if (this._outputWindowRefreshTimer) return;
        const delay = this._outputWindowRefreshes < OUTPUT_WINDOW_FAST_REFRESHES
            ? OUTPUT_WINDOW_REFRESH_MS
            : OUTPUT_WINDOW_SLOW_REFRESH_MS;
        this._outputWindowRefreshTimer = setTimeout(() => {
            this._outputWindowRefreshTimer = null;
            this._outputWindowRefreshes++;
            this._applyOutputWindow();
        }, delay);
    }

    _stopOutputWindowTimers() {
        clearTimeout(this._outputWindowRetryTimer);
        this._outputWindowRetryTimer = null;
        clearTimeout(this._outputWindowRefreshTimer);
        this._outputWindowRefreshTimer = null;
        this._outputWindowRefreshes = 0;
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
        const now = monotonicNow();

        // ---------------------------------------------------------------------
        // Throttle by elapsed time, not by media time. Chromium fires timeupdate
        // about every 250 ms, so requiring the media time to move by MORE than
        // 0.25 s dropped roughly every other event, and external subtitles
        // (ticked only from these events) appeared / cleared up to ~0.5 s late.
        // A jump of a second or more (seek, new stream) is forwarded at once.
        // ---------------------------------------------------------------------
        const jumped = Math.abs(currentTicks - this._lastTimeUpdateTicks) >= 10000000;
        if (jumped || now - this._lastTimeUpdateAt >= TIMEUPDATE_MIN_INTERVAL_MS) {
            this._lastTimeUpdateTicks = currentTicks;
            this._lastTimeUpdateAt = now;
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
        if (!video.src && !this._hlsPlayer && (!video.firstChild || !video.firstChild.src)) {
            log.debug('WebOSPlayer: Ignoring error on empty source during cleanup');
            return;
        }

        // While play() waits for 'canplay', the load waiter handles the error
        // (including the Hls.js fallback); handling it here too would race it.
        if (this._loadPending) {
            log.debug('WebOSPlayer: Error during load is handled by the load waiter');
            return;
        }

        const formatted = MediaHelper.formatMediaError(video.error);
        log.error(`WebOSPlayer: Error ${formatted.code} (${formatted.name}): ${formatted.message}`);

        const isNetworkError = formatted.code === 2 || /network|connection|pipeline_error_network/i.test(formatted.message);

        // ---------------------------------------------------------------------
        // Hls.js does not recover from errors of the <video> element itself (it
        // only logs them), so they go through the same bounded recovery as its
        // own fatal media errors: a decoder reset, then a codec swap, then a
        // reported failure. Its 3 s window keeps an element error and an Hls.js
        // error for the same fault from resetting the decoder twice.
        // ---------------------------------------------------------------------
        const hlsHandling = this._hlsElementErrorHandler;
        if (this._hlsPlayer && hlsHandling && hlsHandling.hls === this._hlsPlayer) {
            log.warn(`WebOSPlayer: Media element error ${formatted.code} during Hls.js playback — recovering`);
            hlsHandling.onError(null, {
                fatal: true,
                type: Hls.ErrorTypes.MEDIA_ERROR,
                details: `mediaElementError(${formatted.code})`
            });
            return;
        }

        // If native HLS playback triggered a decode error (code 3) or not supported (code 4)
        // and Hls.js is available in this environment, attempt seamless fallback to Hls.js
        const isHlsStream = this._currentPlayOptions?.isHls || (this._currentSrc && this._currentSrc.includes('.m3u8'));
        if ((formatted.code === 3 || formatted.code === 4) && !this._hlsPlayer && isHlsStream && this._canUseHlsJs(this._currentPlayOptions) && !this._hlsFallbackAttempted) {
            log.warn('WebOSPlayer: Native HLS pipeline threw decode error. Attempting seamless Hls.js fallback...');
            this._hlsFallbackAttempted = true;
            // Continue where playback failed, not at the item's start position. The position is
            // in the stream's own time, like playerStartPositionTicks, so a transcoding offset
            // the options carry still applies on top. Before the first frame the position is
            // not reliable yet (webOS can report 0 while the resume seek is pending). A live
            // item starts at the live edge, as in play().
            const options = this._currentPlayOptions;
            const isLive = options?.item?.Type === 'TvChannel' || options?.mediaSource?.LiveStreamId;
            const position = this._started && !isLive ? video.currentTime : 0;
            const fallbackOptions =
                position > 0 ? { ...options, playerStartPositionTicks: Math.round(position * 10000000) } : options;
            this._playWithHlsJs(video, fallbackOptions)
                .catch(err => {
                    // stop() or a newer play() cancelled it: that item is gone
                    if (err?.superseded) return;
                    log.error('WebOSPlayer: Fallback to Hls.js also failed:', err);
                    this.onEvent({
                        type: 'error',
                        data: {
                            ...formatted,
                            isNetworkError
                        }
                    });
                });
            return;
        }

        this.onEvent({
            type: 'error',
            data: {
                ...formatted,
                isNetworkError
            }
        });
    }

    /** @private */
    _onPause() {
        // The Dolby Vision flush pausing the element: not a pause of the user's
        if (this._recoveryFlush === 'pausing') return;
        this.onEvent({ type: 'pause' });
    }

    /** @private */
    _onPlay() {
        // The Dolby Vision flush resuming the element: as far as the user is concerned,
        // playback never stopped
        if (this._recoveryFlush === 'resuming') {
            this._recoveryFlush = null;
            return;
        }
        this.onEvent({ type: 'play' });
    }

    /** @private */
    _onPlaying() {
        if (this._robustSeekTarget !== null && this._robustSeekTarget !== undefined) {
            const target = this._robustSeekTarget;
            const current = this.getCurrentTime();
            const drift   = Math.abs(current - target);

            // ----------------------------------------------------------------
            // Drift gate: ensure the playhead has genuinely landed near target.
            // Accommodate standard 24fps GOP keyframe distances (~10.4s) while
            // guarding against false positives at 0:00 when target is small (< 15s).
            // ----------------------------------------------------------------
            const isStuckAtZero = target >= 3 && current < 0.5;
            const isNearTarget = !isStuckAtZero && (drift < 15 || (current >= target && current <= target + 15));

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

        // Resume is now confirmed safe. Unmute audio (after a pending audio track switch).
        if (this._resumeAudioSuppressed && !this._resumeTrackSwitchPending) {
            this._resumeAudioSuppressed = false;
            this.setMuted(false);
        }

        // Playhead is confirmed at target. Restore video presentation smoothly.
        this._restoreVideoAfterResume(this._videoElement);

        // --------------------------------------------------------------------
        // Refit Video Layout Geometry on First Decoded Frame
        // --------------------------------------------------------------------
        // On webOS (especially webOS 5), intrinsic dimensions may evaluate to 0
        // until the initial video frame is decoded. Re-evaluating geometry here
        // guarantees that aspect ratio cropping / letterboxing is applied immediately.
        this._fitVideoBox();

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
        // ----------------------------------------------------------------
        // 'stalled' only says that no media data arrived for about 3 s. With
        // a full buffer that is the pipeline pausing its download: on an LG
        // C4 it fired every ~6 s with 45 s buffered, and each one became a
        // 'waiting', so PlayerPage's watchdog pinged the server 3.5 s later
        // although playback never stopped. A real underrun also fires
        // 'waiting'. The local stall check still runs: it does nothing while
        // the playhead keeps moving.
        // ----------------------------------------------------------------
        const video = this._videoElement;
        const bufferAhead = this._getBufferAhead();
        const downloadIdle = Boolean(video) && video.readyState >= 3 && bufferAhead >= STALLED_HEALTHY_BUFFER_S;
        if (downloadIdle) {
            log.debug('WebOSPlayer: stalled with', bufferAhead.toFixed(1), 's buffered — download paused, not an underrun');
        } else {
            log.warn('WebOSPlayer: Playback stalled');
        }

        // Same guard as _onWaiting — a 'stalled' event immediately at load
        // time is the WebOS pipeline warming up, not a genuine underrun.
        // Let the decoder self-recover silently; only engage stall machinery
        // once we know the player is already producing frames.
        if (!this._started) return;

        if (!downloadIdle) this.onEvent({ type: 'waiting' });
        this._startStallCheck();
    }

    /** @private */
    _onSeeking() {
        const video = this._videoElement;
        // Only emit 'waiting' if we're seeking while playing (not paused-seeking)
        if (video && !video.paused) {
            this.onEvent({ type: 'waiting' });
        }
        // The startup resume has its own retries and watchdogs
        if (video && this._started) {
            this._watchSeek(video);
        }
    }

    /**
     * Watch the seek that just started until it lands (see SEEK_STUCK_MS).
     * A new seek restarts the watch.
     * @private
     * @param {HTMLVideoElement} video
     */
    _watchSeek(video) {
        const bufferedEnd = () => {
            const ranges = video.buffered;
            let sum = 0;
            for (let i = 0; i < (ranges?.length || 0); i++) sum += ranges.end(i);
            return sum;
        };
        const watch = { buffered: bufferedEnd(), playingMs: 0, noDataMs: 0 };
        this._seekWatch = watch;

        const check = () => {
            if (this._seekWatch !== watch || this._videoElement !== video) return;
            if (!video.seeking) {
                this._seekWatch = null;
                return;
            }
            if (video.paused) {
                // A paused seek completes only once playback starts: watch it again from
                // the element's next 'play' (a Dolby Vision flush's too), unless a newer
                // seek or 'seeked' replaced this watch. Checking every 2 s for as long as
                // the pause lasted only added timers.
                const removePlay = this._listen(video, 'play', () => {
                    removePlay();
                    if (this._seekWatch === watch && this._videoElement === video && video.seeking) {
                        this._watchSeek(video);
                    }
                });
                return;
            } else {
                watch.playingMs += SEEK_STUCK_CHECK_MS;
                const buffered = bufferedEnd();
                if (buffered !== watch.buffered) {
                    watch.buffered = buffered;
                    watch.noDataMs = 0;
                } else {
                    watch.noDataMs += SEEK_STUCK_CHECK_MS;
                }
                if (watch.noDataMs >= SEEK_STUCK_MS || watch.playingMs >= SEEK_STUCK_MAX_MS) {
                    this._seekWatch = null;
                    // While seeking, currentTime reports the pending target
                    const offsetTicks = this._currentPlayOptions?.transcodingOffsetTicks || 0;
                    const targetTicks = Math.round(video.currentTime * 10000000) + offsetTicks;
                    log.warn(
                        `WebOSPlayer: seek to ${video.currentTime.toFixed(2)}s still pending after ` +
                        `${watch.playingMs / 1000}s of playback (${watch.noDataMs / 1000}s without new data) — ` +
                        'asking for a reload at the target'
                    );
                    this.onEvent({ type: 'seekstuck', data: { targetPositionTicks: targetTicks } });
                    return;
                }
            }
            this._timer(check, SEEK_STUCK_CHECK_MS);
        };
        this._timer(check, SEEK_STUCK_CHECK_MS);
    }

    /** @private */
    _onSeeked() {
        const video = this._videoElement;
        this._seekWatch = null;

        // ---------------------------------------------------------------------
        // Demuxer Landed Confirmation:
        // Dispatch the official 'seeked' event so orchestrator clears seeking lock.
        // ---------------------------------------------------------------------
        this.onEvent({ type: 'seeked' });

        /*
         * ====================================================================
         * DEFERRED POST-SEEK PLAY DISPATCH
         * ====================================================================
         * If unpause() was requested while the native seek was actively in flight,
         * execute the deferred playback resumption now that the hardware demuxer
         * has firmly established its position on the target GOP keyframe.
         * ====================================================================
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
        this._fitVideoBox();
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

        // Immediate check if navigator is already explicitly offline
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
            log.warn('WebOSPlayer: Playback stalled while navigator is offline — emitting network error early');
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
                    const video = this._videoElement;
                    try {
                        /*
                         * Not a pause of the user's: _onPause() and _onPlay() do not
                         * report the flush's pause and play, so the player does not
                         * show playback paused for a moment. The resume is a session
                         * timer that _clearStallCheck() leaves alone: a 'stalled',
                         * 'waiting' or 'playing' within the 200 ms used to cancel it
                         * and left the element paused. A Pause of the user's
                         * meanwhile cancels it (see pause()).
                         */
                        this._recoveryFlush = 'pausing';
                        video.pause();
                        // Short pause (200 ms) lets the decoder pipeline
                        // drain its internal queues before we restart.
                        this._recoveryPauseTimer = this._timer(() => {
                            this._recoveryPauseTimer = null;
                            if (this._recoveryFlush !== 'pausing') return;
                            if (this._videoElement !== video || !video.paused) {
                                this._recoveryFlush = null;
                                return;
                            }
                            this._recoveryFlush = 'resuming';
                            video.play().catch((e) => {
                                log.error('WebOSPlayer: DoVi pause/play resume failed', e);
                                // Nothing resumed: report the pause that was held back
                                if (this._recoveryFlush !== 'resuming') return;
                                this._recoveryFlush = null;
                                if (video.paused) this.onEvent({ type: 'pause' });
                            });
                        }, 200);
                    } catch (e) {
                        this._recoveryFlush = null;
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
            // Settings UI offers timeouts in milliseconds (250ms to 10000ms).
            // Legacy user settings or historic defaults stored the value in seconds
            // (< 100, e.g. 8). We normalize values below 100 by multiplying by 1000,
            // while preserving millisecond values directly without double-multiplying.
            const rawRecoverySetting = Number(PlayerSettings.get('webosStallRecovery')) || 8000;
            const recoveryDelayMs = rawRecoverySetting < 100 ? rawRecoverySetting * 1000 : rawRecoverySetting;

            this._stallTimer = setTimeout(() => {
                if (!this._videoElement || this._videoElement.paused || !this._started) return;

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
                    `WebOSPlayer: Still stalled after ${(recoveryDelayMs / 1000).toFixed(1)}s (buffer: ` +
                    `${bufferAhead.toFixed(1)}s) — recovery kick (+0.5s)`
                );
                this._lastRecoveryKickTime = Date.now();
                try {
                    this._videoElement.currentTime += 0.5;
                } catch (e) {
                    log.error('WebOSPlayer: Recovery kick failed', e);
                }
            }, recoveryDelayMs);
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
        this._hlsElementErrorHandler = null;
    }

    /**
     * Full cleanup — stop playback, destroy Hls.js, remove the <video> element
     * from the DOM, and null out all state.
     */
    destroy() {
        this.stop();
        this._destroyHlsPlayer();
        this._releaseAudioGraph();
        this._closeAudioContext();

        if (this._containerObserver) {
            this._containerObserver.disconnect();
            this._containerObserver = null;
        }

        if (this._videoElement) {
            this._unbindEvents(this._videoElement);
            if (this._videoElement.parentNode) {
                this._videoElement.parentNode.removeChild(this._videoElement);
            }
            this._videoElement = null;
        }

        // ---------------------------------------------------------------------
        // Reset container background presentation override
        // ---------------------------------------------------------------------
        if (this.container) {
            this.container.style.backgroundColor = '';
        }
    }
}
