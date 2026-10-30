/**
 * JellyfinPlayer - Main orchestrating class
 *
 * Manages video playback using HtmlVideoPlayer, TizenAVPlayer, or WebOSPlayer
 * backend. Handles media source selection, track switching, and playback state.
 *
 * The active backend is exposed through `this._backendType` ('tizen', 'webos', 'html5')
 * for all platform-specific branching — prefer _backendType string checks over
 * `instanceof` so that adding new backends never requires touching this class.
 *
 * Integrated directly into litefin — no UMD bundle, no bridge, no standalone
 * @module core/JellyfinPlayer
 */

import { HtmlVideoPlayer } from './HtmlVideoPlayer.js';
import { TizenAVPlayer } from './TizenAVPlayer.js';
import { WebOSPlayer } from './WebOSPlayer.js';
import { MoviVideoPlayer } from './MoviVideoPlayer.js';
import { ExoVideoPlayer } from './ExoVideoPlayer.js';
import { platformInfo } from '../../utils/PlatformInfo.js';
import { MediaHelper } from './MediaHelper.js';
import { buildJellyfinProfile } from '../../api/DeviceProfile.js';
import SubtitleManager, { DeliveryMethod } from './SubtitleManager.js';
import { logger } from '../../utils/Logger.js';
import { PlayerSettings } from '../../utils/PlayerSettings.js';
import { api, customHeaders } from '../../api/index.js';
import { storage } from '../../utils/StorageService.js';
import { prewarmManager } from './PrewarmManager.js';
import { webCodecsProbe } from '../../utils/WebCodecsProbe.js';
import { languageManager } from '../../utils/LanguageManager.js';

const log = logger.create('JellyfinPlayer');

/**
 * PlaybackInfo request timeout. Matches ApiClient's request timeout; it stays
 * generous because the server may open a live stream (AutoOpenLiveStream)
 * before answering. Without one, a stalled server kept the loading spinner
 * up until the TV's TCP timeout.
 */
const PLAYBACK_INFO_TIMEOUT_MS = 30000;

/**
 * Remux stuck watchdog (see _armRemuxStuckWatchdog). A remux restart gets
 * REMUX_WATCHDOG_FIRST_CHECK_MS to start advancing. A remux that is still
 * filling its buffer (data arriving, less than REMUX_STUCK_BUFFER_AHEAD_S
 * buffered) is checked again every REMUX_WATCHDOG_RECHECK_MS, up to
 * REMUX_WATCHDOG_MAX_MS in all. More buffered data than a pipeline needs to
 * start (one to two 6 s segments) and no progress is the decoder freeze the
 * watchdog exists for; over a LAN a frozen remux fills that much well
 * within the first check.
 */
const REMUX_WATCHDOG_FIRST_CHECK_MS = 8000;
const REMUX_WATCHDOG_RECHECK_MS = 4000;
const REMUX_WATCHDOG_MAX_MS = 30000;
const REMUX_STUCK_BUFFER_AHEAD_S = 10;

/**
 * Longest the loading screen stays up after a resume landed while playback
 * has not started advancing (see _isAwaitingResumeAdvance). Matches the
 * remux watchdog's limit, after which a start that is still not moving is
 * handed over to the escalation paths.
 */
const RESUME_ADVANCE_WAIT_MS = REMUX_WATCHDOG_MAX_MS;

/**
 * A transcode seeks by restarting FFmpeg at the target on the server, so no
 * new data for a while is normal there: on a slow NAS well over the 8 s after
 * which webOS reports a seek as stuck. A Transcode session is reloaded only
 * when the seek is still pending this long after it started.
 */
const TRANSCODE_SEEK_STUCK_MS = 30000;

// ============================================================================
// Stream Utilities & Audio Capability Detection Helpers
// ============================================================================
// Delegated to StreamUtils.js to prevent heavy player backends from leaking
// into non-player page chunks. Re-exported here for backwards compatibility.
import {
    isTrueHdSupported,
    isDtsSupported,
    isAudioTrackNativelyPlayable,
    isLanguageMatch,
    getEffectiveSubtitleMode,
    isForcedStream,
    resolveSubtitleStream,
    resolveBestAudioStream,
    rememberContainerWithoutAudioTracks,
    hasContainerWithoutAudioTracks,
    doesAudioTrackRequireDirectStream
} from './StreamUtils.js';

export {
    isTrueHdSupported,
    isDtsSupported,
    isAudioTrackNativelyPlayable,
    isLanguageMatch,
    getEffectiveSubtitleMode,
    isForcedStream,
    resolveSubtitleStream,
    resolveBestAudioStream,
    rememberContainerWithoutAudioTracks,
    hasContainerWithoutAudioTracks,
    doesAudioTrackRequireDirectStream
};


// ============================================================================
// Minimal EventEmitter (inlined from player/src/bridge/EventEmitter.js)
// Only the on/off/once/emit/removeAllListeners subset — no postMessage stuff.
// ============================================================================

class EventEmitter {
    constructor() {
        this._listeners = {};
    }

    /**
     * Register a listener for an event
     * @param {string} event - Event name
     * @param {Function} callback - Callback function
     * @returns {this}
     */
    on(event, callback) {
        if (!this._listeners[event]) {
            this._listeners[event] = [];
        }
        this._listeners[event].push(callback);
        return this;
    }

    /**
     * Register a one-time listener
     * @param {string} event - Event name
     * @param {Function} callback - Callback function
     * @returns {this}
     */
    once(event, callback) {
        const wrapper = (...args) => {
            this.off(event, wrapper);
            callback.apply(this, args);
        };
        wrapper._original = callback;
        return this.on(event, wrapper);
    }

    /**
     * Remove a listener
     * @param {string} event - Event name
     * @param {Function} callback - Callback function
     * @returns {this}
     */
    off(event, callback) {
        if (!this._listeners[event]) return this;
        this._listeners[event] = this._listeners[event].filter(
            (fn) => fn !== callback && fn._original !== callback
        );
        return this;
    }

    /**
     * Emit an event to all registered listeners
     * @param {string} event - Event name
     * @param {...*} args - Arguments to pass to listeners
     * @returns {this}
     */
    emit(event, ...args) {
        const listeners = this._listeners[event];
        if (listeners) {
            // Iterate a copy so listeners can safely remove themselves
            [...listeners].forEach((fn) => {
                try {
                    fn.apply(this, args);
                } catch (e) {
                    console.error(`Error in listener for event "${event}":`, e);
                }
            });
        }
        return this;
    }

    /**
     * Remove all listeners, optionally for a specific event
     * @param {string} [event] - Event name (omit to clear all)
     * @returns {this}
     */
    removeAllListeners(event) {
        if (event) {
            delete this._listeners[event];
        } else {
            this._listeners = {};
        }
        return this;
    }
}

// ============================================================================
// Player Events
// ============================================================================

export const PlayerEvent = {
    PLAY: 'play',
    PAUSE: 'pause',
    STOP: 'stop',
    SEEK: 'seek',
    SEEKED: 'seeked',
    TIME_UPDATE: 'timeupdate',
    VOLUME_CHANGE: 'volumechange',
    PLAYBACK_START: 'playbackstart',
    PLAYBACK_STOP: 'playbackstop',
    MEDIA_STREAMS_CHANGE: 'mediastreamschange',
    ERROR: 'error',
    WAITING: 'waiting',
    PLAYING: 'playing',
    FULLSCREEN_CHANGE: 'fullscreenchange',
    STATE_CHANGE: 'statechange',
    RESTARTING: 'restarting',
    ENDED: 'ended',
    CAN_PLAY: 'canplay',
    LOAD_START: 'loadstart',
    LOADED_METADATA: 'loadedmetadata'
};

// ============================================================================
// JellyfinPlayer Class
// ============================================================================

export class JellyfinPlayer extends EventEmitter {
    /**
     * @param {Object} options - Player options
     * @param {HTMLElement} options.container  - Container element for the player
     * @param {string}      options.serverUrl  - Jellyfin server URL
     * @param {string}      options.authToken  - Authentication token
     * @param {boolean}     [options.useTizenPlayer=false] - Use Tizen AVPlay backend
     */
    constructor(options) {
        super();

        // ====================================================================
        // Configuration
        // ====================================================================

        this.container = options.container;
        this.serverUrl = options.serverUrl;
        this.authToken = options.authToken;
        this.useTizenPlayer = options.useTizenPlayer || false;
        this.forcedPlayerBackend = options.playerBackend || null;

        // ====================================================================
        // State
        // ====================================================================

        this._currentItem = null;
        this._currentMediaSource = null;
        this._currentPlayOptions = null;
        this._isPlaying = false;
        this._isPaused = false;
        // Quality picked in the OSD (null: Auto). Only that forces a transcode;
        // the global limit (maxBitrateInternet) is the MaxStreamingBitrate the
        // device profiles send for every item.
        this._manualBitrate = null;
        this._isRestarting = false; // Flag to suppress stop events during manual quality change
        // Play options of the restart flow that owns _isRestarting and its guard flags; a
        // stop() or a newer restart takes the restart over (see _playAfterRestartPause())
        this._restartOwner = null;
        this._playRequestId = 0; // Advanced by play(), stop() and destroy(); see play()
        this._latestPlay = null; // The latest play() request, for a restart that replaces it (see stop())
        this._restartHandover = null; // A restart's stop() until its play() starts (see stop())
        this._lastReportedPlayError = null; // Last error play() emitted (restart flows skip re-reporting it)
        this._playbackMode = 'auto'; // Current playback mode ('auto', 'directPlay', 'transcode', 'remux', 'transcodeVideo', 'transcodeAudio')

        // ────────────────────────────────────────────────────────────────────
        // User Playback Mode
        // ────────────────────────────────────────────────────────────────────
        // The mode the user chose: the one a fresh play() from the page asks
        // for, or the one picked in the Playback Mode menu. _playbackMode is
        // the current item's mode, which play() and the restart flows change
        // on their own (remux for an audio track, remux or transcode after a
        // failure). getPlaybackMode() reports the user's mode, so only that
        // one carries over to the next item, and an audio track switch goes
        // back to it instead of staying in a fallback.
        // ────────────────────────────────────────────────────────────────────
        this._userPlaybackMode = 'auto';

        // The mode the last restart of an item asked for ({ itemId, mode }), for
        // a fresh play() of the same item (Retry, network recovery; see play())
        this._itemFallbackMode = null;

        this._transcodingOffsetTicks = 0; // Offset for transcoded streams that start at 0
        this._pendingStartPositionTicks = null; // Target position before first frame
        this._resumeLastTime = null; // Last landed position while waiting for a resume to advance
        this._resumeAdvanceTimer = null; // Limit on that wait
        this._isSeeking = false; // Track seeking state to suppress loading screens during seek
        this._seekFailsafeTimeout = null; // Failsafe timer to clear _isSeeking if seeked event is lost
        this._seekStartedAt = 0; // When the last seek() started (Date.now())
        this._seekStuckWait = null; // A transcode's stuck seek waiting for TRANSCODE_SEEK_STUCK_MS

        // Secondary subtitle stream index (kept here for OSD queries)
        this._currentSecondarySubtitleStreamIndex = -1;

        // ────────────────────────────────────────────────────────────────────
        // Remux Stuck Watchdog
        // ────────────────────────────────────────────────────────────────────
        // Detects when falling back from a DirectPlay seek failure to Remux causes
        // the client hardware decoder (e.g., WebOS MediaPipeline) to freeze on
        // mid-GOP fMP4 stream segments lacking keyframe reference frames.
        // If forward media progression does not occur within the evaluation window,
        // this watchdog automatically escalates playback from 'remux' to 'transcode'.
        // ────────────────────────────────────────────────────────────────────
        this._remuxWatchdogTimeout = null;
        this._remuxWatchdogActive = false;
        this._remuxWatchdogTargetTicks = null;
        this._remuxWatchdogInitialTime = null;
        this._remuxWatchdogArmedAt = 0; // When the watchdog was armed (Date.now())
        this._remuxWatchdogBufferedEnd = null; // End of the buffered range at the last check

        // Play options of the one fresh transcode a failed transcoded resume gets
        // (see the resumeseekfailed handler); any other restart creates new options
        this._resumeRetryOptions = null;

        // Play options of the reload a stuck seek gets (see the seekstuck handler)
        this._seekReloadOptions = null;

        // Play options of a transcode retry that got stuck too and ended with an
        // error: its later stuck reports are ignored (see resumeseekfailed)
        this._seekGaveUpOptions = null;

        // ────────────────────────────────────────────────────────────────────
        // DirectPlay Failure Escalation Guard
        // ────────────────────────────────────────────────────────────────────
        // Tracks whether the active playback session has already attempted
        // automatic fallback from a failed DirectPlay/Remux stream to server-side
        // transcoding. Prevents recursive escalation loops if transcoding also errors.
        // ────────────────────────────────────────────────────────────────────
        this._directPlayEscalated = false;

        // ====================================================================
        // Subtitle Manager — centralized subtitle orchestration
        // Handles delivery method selection, external subtitle fetching,
        // cue parsing, and time-based cue ticking for both primary and
        // secondary subtitles. Embedded subs on Tizen are still routed
        // through the backend, but the manager coordinates everything.
        // ====================================================================

        this._subtitleManager = new SubtitleManager({
            container: this.container,
            serverUrl: this.serverUrl,
            authToken: this.authToken,
            // Primary cue callback — emits to PlayerPage for DOM rendering
            onPrimaryCue: (data) => this.emit('subtitlechange', data),
            // Secondary cue callback — emits to PlayerPage for secondary overlay
            onSecondaryCue: (data) => this.emit('secondarysubtitlechange', data),
            // Delivery method change — used for logging / debugging
            onDeliveryChange: (info) => {
                log.info('[SubtitleManager] Delivery changed:', info);
            }
        });

        // Chapters
        this._chapters = [];

        // ====================================================================
        // Player Backend
        // ====================================================================

        this._backend = null;
        // Device profile now uses unified api/DeviceProfile module

        // Initialize the appropriate backend
        this._initBackend();
    }

    // ========================================================================
    // Initialization
    // ========================================================================

    /**
     * Initialize the player backend based on platform and settings.
     *
     * Priority order:
     *   1. Explicit 'playerBackend' setting ('avplay' / 'html5' / 'webos')
     *   2. Auto-detect: WebOS platform → WebOSPlayer
     *   3. Auto-detect: Tizen AVPlay API available → TizenAVPlayer
     *   4. Fallback: HtmlVideoPlayer
     *
     * The resolved backend type is stored in `this._backendType` as a plain
     * string so other methods can branch on it without instanceof checks.
     * @private
     */
    _initBackend() {
        // Detect Tizen AVPlay API (present on either namespace depending on Tizen version)
        const hasAvPlay = !!(window.tizen?.avplay || window.webapis?.avplay);
        const backendSetting = this.forcedPlayerBackend || PlayerSettings.get('playerBackend') || 'auto';

        /*
         * ====================================================================
         * Platform-Aware Backend Initialization Diagnostics
         * ====================================================================
         * Compile a clean, contextual diagnostics summary reflecting the active
         * device runtime (Android, WebOS, Desktop, Tizen, Web) and its capabilities,
         * rather than outputting legacy Tizen-specific booleans across all devices.
         */
        const envDetails = [
            `platform: ${platformInfo.platformString}`,
            `setting: ${backendSetting}`
        ];

        // Report hardware AVPlay support on Samsung Tizen or when the API is explicitly exposed
        if (platformInfo.isTizen || hasAvPlay) {
            envDetails.push(`avplay: ${hasAvPlay}`);
        }

        // Report WebCodecs engine support when running in Desktop shells or Web browsers
        if (platformInfo.isDesktop || platformInfo.isWeb) {
            envDetails.push(`webCodecs: ${platformInfo.hasWebCodecsSupport}`);
        }

        // Surface explicit caller overrides if present
        if (this.forcedPlayerBackend) {
            envDetails.push(`forced: ${this.forcedPlayerBackend}`);
        }

        log.info(`Initializing backend — ${envDetails.join(' | ')}`);

        const sharedOptions = {
            container: this.container,
            settings: PlayerSettings,
            onEvent: this._handleBackendEvent.bind(this)
        };

        // ----------------------------------------------------------------
        // Explicit override: 'exoplayer' → use ExoVideoPlayer if bridge available
        // ----------------------------------------------------------------
        if (backendSetting === 'exoplayer') {
            const isExoSupported = typeof ExoVideoPlayer.isSupported === 'function'
                ? ExoVideoPlayer.isSupported()
                : (platformInfo.isAndroid && (typeof window !== 'undefined' && Boolean(window.LitefinExoPlayer || window.LitefinAndroid || window.__TAURI__)));

            if (isExoSupported) {
                log.info('Using ExoPlayer backend (forced by setting)');
                this._backendType = 'exoplayer';
                this._backend = new ExoVideoPlayer(sharedOptions);
                return;
            } else {
                log.warn('Forced exoplayer backend requested, but native Android bridge is not available in this build — falling back to HTML5');
                this._backendType = 'html5';
                this._backend = new HtmlVideoPlayer(sharedOptions);
                return;
            }
        }

        // ----------------------------------------------------------------
        // Explicit override: 'movi' → use MoviVideoPlayer if bundled & WebCodecs available
        // ----------------------------------------------------------------
        if (backendSetting === 'movi') {
            const isMoviAvailable = !MoviVideoPlayer.isStub &&
                (typeof MoviVideoPlayer.isSupported === 'function' ? MoviVideoPlayer.isSupported() : platformInfo.hasWebCodecsSupport);

            if (isMoviAvailable && platformInfo.hasWebCodecsSupport && !platformInfo.isTizen && !platformInfo.isWebOS) {
                log.info('Using MoviPlayer backend (forced by setting)');
                this._backendType = 'movi';
                this._backend = new MoviVideoPlayer(sharedOptions);
                return;
            } else {
                log.warn('Forced movi backend requested, but MoviPlayer is not included or supported in this build — falling back to HTML5');
                this._backendType = 'html5';
                this._backend = new HtmlVideoPlayer(sharedOptions);
                return;
            }
        }

        // ----------------------------------------------------------------
        // Explicit override: 'avplay' → always try TizenAVPlayer
        // ----------------------------------------------------------------
        if (backendSetting === 'avplay') {
            if (!hasAvPlay) {
                log.warn('Forced avplay backend, but AVPlay API not found — attempting anyway');
            }
            log.info('Using Tizen AVPlay backend (forced by setting)');
            this._backendType = 'tizen';
            this._backend = new TizenAVPlayer(sharedOptions);
            return;
        }

        // ----------------------------------------------------------------
        // Explicit override: 'html5' → always use HtmlVideoPlayer
        // ----------------------------------------------------------------
        if (backendSetting === 'html5') {
            log.info('Using HTML5 Video backend (forced by setting)');
            this._backendType = 'html5';
            this._backend = new HtmlVideoPlayer(sharedOptions);
            return;
        }

        // ----------------------------------------------------------------
        // Explicit override: 'webos' → always use WebOSPlayer
        // ----------------------------------------------------------------
        if (backendSetting === 'webos') {
            log.info('Using WebOS backend (forced by setting)');
            this._backendType = 'webos';
            this._backend = new WebOSPlayer(sharedOptions);
            return;
        }

        // ----------------------------------------------------------------
        // Auto-detect: Android platform → ExoVideoPlayer.
        // Provides native hardware-accelerated MediaCodec decoding via
        // Android SurfaceView and Media3 ExoPlayer, bypassing Chromium
        // video stack bottlenecks and delivering steady 60 FPS playback.
        // If native bridge is not available (e.g. mobile browser), falls back to HTML5.
        // ----------------------------------------------------------------
        if (platformInfo.isAndroid) {
            const isExoSupported = typeof ExoVideoPlayer.isSupported === 'function'
                ? ExoVideoPlayer.isSupported()
                : (typeof window !== 'undefined' && Boolean(window.LitefinExoPlayer || window.LitefinAndroid || window.__TAURI__));

            if (isExoSupported) {
                log.info('Android platform detected with native ExoPlayer bridge — using ExoPlayer backend');
                this._backendType = 'exoplayer';
                this._backend = new ExoVideoPlayer(sharedOptions);
                return;
            } else {
                log.warn('Android platform detected without native ExoPlayer bridge (e.g. mobile web browser) — falling back to HTML5');
                this._backendType = 'html5';
                this._backend = new HtmlVideoPlayer(sharedOptions);
                return;
            }
        }

        // ----------------------------------------------------------------
        // Auto-detect: WebOS platform → use the native WebOS backend.
        // This gives us hardware-accelerated HLS and track switching
        // without the complexity of the Luna media service API.
        // ----------------------------------------------------------------
        if (platformInfo.isWebOS) {
            log.info('WebOS platform detected — using WebOS backend');
            this._backendType = 'webos';
            this._backend = new WebOSPlayer(sharedOptions);
            return;
        }

        // ----------------------------------------------------------------
        // Auto-detect: Tizen with AVPlay available → TizenAVPlayer
        // ----------------------------------------------------------------
        if (this.useTizenPlayer && hasAvPlay) {
            log.info('Using Tizen AVPlay backend (auto-detected)');
            this._backendType = 'tizen';
            this._backend = new TizenAVPlayer(sharedOptions);
            return;
        }

        // ----------------------------------------------------------------
        // Auto-detect: Desktop platform or Web browser with WebCodecs support → MoviVideoPlayer.
        // Provides full MKV container demuxing, WebCodecs hardware decoding,
        // and multi-audio decoding (AC-3, E-AC-3, TrueHD, DTS) natively.
        // Excluded on television builds where Movi is replaced with a stub.
        // If on web and WebCodecs is missing, falls through to HTML5.
        // ----------------------------------------------------------------
        const isMoviCandidate = (platformInfo.isDesktop || platformInfo.isWeb) &&
            platformInfo.hasWebCodecsSupport &&
            !MoviVideoPlayer.isStub &&
            !platformInfo.isTizen &&
            !platformInfo.isWebOS;

        if (isMoviCandidate) {
            // Log successful auto-detection of WebCodecs capability across desktop and web
            log.info('Platform with WebCodecs detected (Desktop/Web) — defaulting to MoviPlayer backend');
            // Bind player backend type to movi
            this._backendType = 'movi';
            // Instantiate hardware-accelerated MoviVideoPlayer instance with shared options
            this._backend = new MoviVideoPlayer(sharedOptions);
            return;
        }

        // ----------------------------------------------------------------
        // Fallback: stock HTML5 video (standard browser, Tizen without AVPlay, or Web without WebCodecs)
        // ----------------------------------------------------------------
        log.info('Using HTML5 Video backend (fallback)');
        this._backendType = 'html5';
        this._backend = new HtmlVideoPlayer(sharedOptions);
    }

    /**
     * Check if player is currently seeking
     * @returns {boolean}
     */
    get isSeeking() {
        return Boolean(this._isSeeking);
    }

    /**
     * Whether the backend holds a play requested during a seek until the seek
     * lands, and starts it anyway when 'seeked' does not come (webOS carries out
     * a seek on a paused element only once playback starts). Callers need not
     * wait for 'seeked' before unpause() then.
     * @returns {boolean}
     */
    get queuesPostSeekPlay() {
        return this._backendType === 'webos' || this._backendType === 'html5';
    }

    /**
     * Get the current backend type string.
     * Possible values: 'tizen', 'webos', 'html5'
     * @returns {string}
     */
    get backendType() {
        return this._backendType;
    }

    /**
     * Check if the currently playing item is an audio-only item
     * (Music, Audiobooks, Podcasts). Used by OSD and PlayerPage to
     * hide video-specific controls (subtitles, tracks, chapters).
     * @returns {boolean}
     */
    isAudio() {
        const item = this._currentItem;
        if (!item) return false;
        return item.MediaType === 'Audio' || item.Type === 'AudioBook';
    }

    /**
     * Handle events from the backend player
     * @private
     */
    _handleBackendEvent(event) {
        // Clear seeking flag on relevant events
        // Only clear _isSeeking on explicit SEEKED or PLAYING events, never on TIME_UPDATE.
        // Clearing on TIME_UPDATE causes premature un-gating of subtitle ticking before
        // the hardware demuxer has settled on the post-seek keyframe PTS.
        if (event.type === PlayerEvent.SEEKED ||
            event.type === PlayerEvent.PLAYING) {
            this._isSeeking = false;
            const clearTimer = typeof clearTimeout !== 'undefined'
                ? clearTimeout
                : (typeof globalThis !== 'undefined' ? globalThis.clearTimeout : null);
            if (clearTimer && this._seekFailsafeTimeout) {
                clearTimer(this._seekFailsafeTimeout);
                this._seekFailsafeTimeout = null;
            }
            // The seek landed: a transcode's stuck report waiting for it is over
            if (clearTimer && this._seekStuckWait) {
                clearTimer(this._seekStuckWait.timer);
                this._seekStuckWait = null;
            }

            /*
             * ================================================================
             * DEFERRED POST-SEEK UNPAUSE DISPATCH
             * ================================================================
             * If unpause() was requested while the hardware seek was in flight
             * (e.g., from OSD debounced seek or remote Play button), playback
             * was held paused to prevent playing audio/video at the pre-seek
             * position. Now that the hardware seek has completed and landed on
             * the target GOP keyframe, release and execute the pending unpause.
             * ================================================================
             */
            if (this._pendingPlayAfterSeek) {
                log.info('[JellyfinPlayer] Seek completed (seeked/playing) — executing queued post-seek unpause');
                this._pendingPlayAfterSeek = false;
                this.unpause();
            }
        }

        // ---------------------------------------------------------------------
        // Remux Playback Health Monitor
        // ---------------------------------------------------------------------
        // When recovering from seek failures via Remux, check if playback is actively
        // advancing. If time progresses forward by >= 0.3s, hardware decoding has
        // successfully engaged with valid reference frames, so we can disarm the watchdog.
        // ---------------------------------------------------------------------
        if (this._remuxWatchdogActive && event.type === PlayerEvent.TIME_UPDATE && event.data?.time !== undefined) {
            const rawTime = event.data.time;
            if (this._remuxWatchdogInitialTime === null) {
                // Record baseline presentation time upon the first timeupdate
                this._remuxWatchdogInitialTime = rawTime;
            } else if (rawTime > this._remuxWatchdogInitialTime + 0.3) {
                // Playhead is moving forward smoothly; decoder is healthy
                log.info(`[JellyfinPlayer] Remux stream verified advancing at ${rawTime.toFixed(2)}s — disarming stuck watchdog.`);
                this._clearRemuxStuckWatchdog();
            }
        }

        // If the user manually pauses playback, disarm the watchdog to prevent false escalations
        if (this._remuxWatchdogActive && event.type === PlayerEvent.PAUSE) {
            log.info('[JellyfinPlayer] Playback paused during remux evaluation; disarming stuck watchdog.');
            this._clearRemuxStuckWatchdog();
        }

        // Intercept events if we are waiting for a native client-side Resume Seek to complete
        // This prevents the UI from hiding the loading spinner and flashing the 0:00 frame
        // before the player has actually jumped to the resume position.
        if (this._pendingStartPositionTicks !== null) {
            const targetSec = this._pendingStartPositionTicks / 10000000;
            // Account for any active transcoding offset so transcoded segments calculate target position accurately
            const offsetSec = (this._transcodingOffsetTicks || 0) / 10000000;
            const effectiveCurrentTime = (event.data?.time || 0) + offsetSec;

            if (event.type === PlayerEvent.TIME_UPDATE && (event.data?.time || 0) > 0) {
                // =============================================================
                // Backend Buffering Check
                // =============================================================
                // If the player backend (such as ExoVideoPlayer) is still actively
                // buffering media data at the resume seek destination, suppress
                // early resume verification so the loading overlay remains visible.
                // =============================================================
                const isBackendBuffering = Boolean(
                    typeof this._backend?.isBuffering === 'function' && this._backend.isBuffering()
                );
                if (isBackendBuffering) {
                    return;
                }

                // Check if we have arrived near our target resume position (within 15s GOP keyframe tolerance)
                if (Math.abs(effectiveCurrentTime - targetSec) < 15 || effectiveCurrentTime >= (targetSec - 15)) {
                    // A media element reports the landed position as soon as the seek
                    // completes, before a frame is decoded: keep the loading screen up
                    // until time actually moves, instead of a black screen meanwhile
                    if (this._isAwaitingResumeAdvance(effectiveCurrentTime)) {
                        return;
                    }
                    this._finishResumeWait(`Resume verified at ${effectiveCurrentTime}s. Dismissing loading screen.`);
                    // A transcode retry that plays has done its job: a later stuck
                    // seek in this session gets a reload and a retry of its own
                    if (this._resumeRetryOptions && this._currentPlayOptions === this._resumeRetryOptions) {
                        this._resumeRetryOptions = null;
                    }
                    // allow timeupdate to proceed below
                } else if (Date.now() - (this._resumeWaitStartTime || 0) > 3500 ||
                    (effectiveCurrentTime >= 2.0 && effectiveCurrentTime < (targetSec - 15))) {
                    // Fallback: 3.5s elapsed without landing near target, OR the decoder has
                    // already started advancing forward past 2.0s while still far from target.
                    // The resume seek was lost or discarded by the underlying platform demuxer.
                    // Release the pending start lock immediately so the OSD seekbar, timeline,
                    // and SubtitleManager track the real decoder position instead of freezing for 15 seconds.
                    this._pendingStartPositionTicks = null;
                    this._clearResumeAdvanceWait();
                    log.warn(`Resume fallback: decoder playing at ${effectiveCurrentTime}s but expected ${targetSec}s. Syncing UI to decoder.`);

                    // Restore active playing state even upon fallback
                    this._isPaused = false;
                    this._subtitleManager?.play();

                    this.emit(PlayerEvent.PLAY);
                    this.emit(PlayerEvent.PLAYING);
                } else {
                    // Still waiting to reach target time. Suppress early timeupdates.
                    return;
                }
            } else if (event.type === PlayerEvent.PLAY ||
                event.type === PlayerEvent.PLAYING ||
                event.type === PlayerEvent.TIME_UPDATE) {
                // Suppress events while the buffer is jumping
                return;
            }
        }

        // Sync internal state
        if (event.type === PlayerEvent.PAUSE) {
            this._isPaused = true;
            this._subtitleManager?.pause();
        } else if (event.type === PlayerEvent.PLAY || event.type === PlayerEvent.PLAYING) {
            this._isPaused = false;
            this._subtitleManager?.play();
        }

        // webOS carries out a seek on a paused element only once playback starts:
        // a transcode's stuck-seek wait (see the seekstuck handler) counts from Play
        if (event.type === PlayerEvent.PLAY && this._currentPlayMethod === 'Transcode') {
            const backend = this._backend;
            const video = backend && typeof backend.getVideoElement === 'function' ? backend.getVideoElement() : null;
            if (video && video.seeking) {
                this._seekStartedAt = Date.now();
            }
            const stuckWait = this._seekStuckWait;
            if (stuckWait && !stuckWait.timer) {
                stuckWait.timer = setTimeout(stuckWait.check, 0);
            }
        }

        // =====================================================================
        // SUBTITLE SYNC & ABSOLUTE CLOCK TICKING:
        // Handle timeupdate from backend player and tick SubtitleManager.
        //
        // Crucial timeline synchronization note:
        // event.data.time reflects the backend player's stream-relative position in seconds.
        // When audio or video is transcoded, or remuxed to HLS with an offset, the stream
        // decoder starts at presentation time 0s, but external subtitles (and PlayerPage's
        // cue cleanup checks) live on the absolute media timeline.
        //
        // We add (this._transcodingOffsetTicks / 10000000) to event.data.time to convert
        // the stream position into absolute media seconds. This prevents subtitle desync
        // when audio is transcoded, across initial resume offsets, and during scrubbing/seeks.
        // =====================================================================
        if (event.type === PlayerEvent.TIME_UPDATE && event.data?.time !== undefined) {
            const offsetSeconds = (this._transcodingOffsetTicks || 0) / 10000000;
            const absoluteTimeSeconds = event.data.time + offsetSeconds;

            try {
                // Tick SubtitleManager using absolute media timeline seconds.
                // Suppress cue ticking while seeking is actively in flight to prevent premature cue display
                // before the demuxer lands on the keyframe PTS.
                if (this._subtitleManager && !this._isSeeking) {
                    this._subtitleManager.tick(absoluteTimeSeconds);
                }
            } catch (e) {
                console.error('Error ticking subtitle manager:', e.message || e, e.stack);
            }

            // Re-emit normalized timeupdate with absolute ticks for UI/OSD and playback reporting
            this.emit(PlayerEvent.TIME_UPDATE, this.getCurrentPositionTicks());
            return;
        }

        // Route embedded subtitle events through SubtitleManager
        if (event.type === 'subtitlechange') {
            if (this._subtitleManager) {
                this._subtitleManager.handleEmbeddedSubtitleEvent(event.data);
            }
            return;
        }


        if (event.type === 'subtitlefallback') {
            log.warn('Backend requested subtitle fallback for index:', event.data.index);
            if (event.data.index !== undefined && event.data.index !== null) {
                // ================================================================
                // Guard: Only escalate to external text fallback if SubtitleManager
                // is NOT already managing this track via a specialised canvas renderer.
                //
                // When SubtitleManager chose PGS_BITMAP or ASS_CANVAS for the primary
                // track, it has already set up a PGSRenderer/ASSRenderer that is
                // actively fetching and rendering the subtitle.  Calling
                // forceExternalTextFallback() here would:
                //   1. Try to fetch the subtitle as .vtt (Jellyfin cannot convert PGS
                //      bitmaps to text → returns empty cues or garbage).
                //   2. Mark delivery as EXTERNAL_TEXT, which kills the canvas tick
                //      path and leaves the subtitle invisible.
                //
                // The backend fires subtitlefallback only to signal that IT cannot
                // render the track natively (e.g. PGS on AVPlay DirectPlay).  If
                // SubtitleManager is already covering it, we honour that and do nothing.
                // ================================================================
                const delivery = this._subtitleManager.getPrimaryDelivery();
                const primaryTrack = this._subtitleManager.getPrimaryTrack();
                const alreadyManaged = primaryTrack?.Index === event.data.index && (
                    delivery === 'pgs_bitmap' ||
                    delivery === 'ass_canvas'
                );

                if (alreadyManaged) {
                    log.info(`Subtitle fallback skipped for index ${event.data.index} — SubtitleManager already handling via ${delivery}`);
                } else {
                    // EMBEDDED_NATIVE delivery failed on the backend, or SubtitleManager
                    // hadn't set up any renderer for this track yet. Try fetching it as
                    // an external text subtitle (VTT) from the Jellyfin API.
                    this._subtitleManager.forceExternalTextFallback(event.data.index).catch(e => {
                        log.error('Failed to apply subtitle fallback:', e);
                    });
                }
            }
            return;
        }

        // ── WebOS: native audio switch fell through (audioTracks empty) ───────
        //
        // WebOS does not expose video.audioTracks for progressive MKV/MP4
        // direct-play. When setAudioStreamIndex() can't toggle .enabled, it
        // fires this event so we can restart playback with the correct index
        // embedded in the stream URL — same mechanism as a Transcode restart.
        if (event.type === 'audiotrackswitchfailed') {
            const targetIndex = this._currentAudioStreamIndex;
            log.warn('audiotrackswitchfailed: audioTracks empty on WebOS direct-play.',
                'Restarting to apply audio index', targetIndex);

            // Direct play of this container exposes no track list here: later
            // non-default tracks of it go to the remux directly (see
            // doesAudioTrackRequireDirectStream)
            if (this._currentPlayMethod === 'DirectPlay' && this._currentMediaSource) {
                rememberContainerWithoutAudioTracks(this._backendType, this._currentMediaSource.Container);
            }

            if (this._currentPlayOptions && !this._audioRestartInProgress) {
                const currentTicks = this.getCurrentPositionTicks();

                // Build clean restart options carrying active audio and subtitle tracks
                const restartOptions = {
                    ...this._currentPlayOptions,
                    audioStreamIndex: targetIndex,
                    subtitleStreamIndex: this._currentSubtitleStreamIndex,
                    secondarySubtitleStreamIndex: this._currentSecondarySubtitleStreamIndex,
                    startPositionTicks: currentTicks,
                    // MUST use 'remux' here — not 'directPlay'.
                    //
                    // For DirectPlay (Static=true), Jellyfin streams the raw container
                    // bytes and completely ignores the AudioStreamIndex query parameter.
                    // The WebOS pipeline then picks up whatever track the container flags
                    // as default, ignoring our request.
                    //
                    // 'remux' forces DirectStream mode: the server runs ffmpeg to
                    // rewrap the container, selecting exactly the requested audio track
                    // and copying the video stream bitstream. The resulting URL will be
                    // a .m3u8/stream endpoint that actually honours AudioStreamIndex.
                    //
                    // If the session was already in transcode mode, keep it there —
                    // switching to remux would skip necessary codec profile checks.
                    playbackMode: this._playbackMode === 'transcode' ? 'transcode' : 'remux'
                };

                this._currentPlayOptions = restartOptions;
                this._lastPlayOptions = restartOptions;
                this._audioRestartInProgress = true;
                this._isRestarting = true;
                this._restartOwner = restartOptions;

                this.emit(PlayerEvent.RESTARTING);

                // Restart asynchronously so this event handler can return cleanly.
                // No pause between stop() and play(): only the webOS and HTML5
                // backends fire this event, their stop() is synchronous, and the
                // stopped session was a static direct-play file, so there is no
                // server transcode to wind down first.
                (async () => {
                    try {
                        await this.stop({ restart: true });
                        await this._playAfterRestartPause(restartOptions, 0);
                    } catch (e) {
                        log.error('audiotrackswitchfailed restart failed:', e);
                    } finally {
                        // Unless a newer restart has taken over meanwhile
                        if (this._restartOwner === restartOptions) {
                            this._isRestarting = false;
                            this._audioRestartInProgress = false;
                        }
                    }
                    this.emit(PlayerEvent.MEDIA_STREAMS_CHANGE, { audioStreamIndex: targetIndex });
                })();
            }
            return;
        }

        // ── A seek the backend's pipeline never completes ─────────────────────
        //
        // The element stays 'seeking' with playback requested and holds every
        // later seek and play (an LG C4 after a rejected seek in a native-HLS
        // remux). Reload the stream at the target in the same mode. If the
        // reloaded stream gets stuck too, the resumeseekfailed escalation
        // takes over (remux → transcode). The one fresh transcode a stuck
        // transcode gets there is not reloaded: when it gets stuck as well,
        // playback ends with an error (see resumeseekfailed).
        if (event.type === 'seekstuck') {
            if (this._isRestarting || !this._currentPlayOptions) return;
            if (this._currentPlayOptions === this._seekGaveUpOptions) return;
            const targetTicks = event.data?.targetPositionTicks ?? this.getCurrentPositionTicks();

            // A transcode that has had less than TRANSCODE_SEEK_STUCK_MS for the
            // seek is checked again then: 'seeked' or 'playing' meanwhile ends
            // the wait, as do stop() and play(). A new seek, and Play while the
            // seek is pending (the backend's 'play'), restart the time. Nothing is
            // reloaded while paused (webOS carries out the seek only once
            // playback starts) or once the backend no longer seeks. Reloading
            // earlier only starts another server job at the target.
            if (this._currentPlayMethod === 'Transcode') {
                const pending = this._seekStuckWait;
                if (pending && pending.request === this._playRequestId) {
                    // A later seek's report: reload at its target when the wait ends
                    pending.event = event;
                    return;
                }
                const waitMs = TRANSCODE_SEEK_STUCK_MS - (Date.now() - (this._seekStartedAt || 0));
                if (waitMs > 0) {
                    log.info(
                        `seekstuck: transcode seek still pending — checking again in ${Math.ceil(waitMs / 1000)} s`
                    );
                    const wait = { request: this._playRequestId, event, timer: null, check: null };
                    wait.check = () => {
                        wait.timer = null;
                        if (this._seekStuckWait !== wait) return;
                        const remainingMs = TRANSCODE_SEEK_STUCK_MS - (Date.now() - (this._seekStartedAt || 0));
                        if (wait.request !== this._playRequestId) {
                            this._seekStuckWait = null;
                        } else if (remainingMs > 0) {
                            wait.timer = setTimeout(wait.check, remainingMs);
                        } else if (!this._isPaused) {
                            this._seekStuckWait = null;
                            const backend = this._backend;
                            const video =
                                backend && typeof backend.getVideoElement === 'function'
                                    ? backend.getVideoElement()
                                    : null;
                            if (!video || video.seeking) {
                                this._handleBackendEvent(wait.event);
                            }
                        }
                    };
                    wait.timer = setTimeout(wait.check, waitMs);
                    this._seekStuckWait = wait;
                    return;
                }
            }

            // Each reload replaces the play options, so reloading the transcode
            // retry would hide that it already was the retry: a spot the server
            // can't deliver then alternated reload and retry for good, each
            // starting another server job, behind a spinner
            const isReload = this._seekReloadOptions && this._currentPlayOptions === this._seekReloadOptions;
            const isTranscodeRetry = this._resumeRetryOptions && this._currentPlayOptions === this._resumeRetryOptions;
            if (isReload || isTranscodeRetry) {
                log.warn(
                    `seekstuck: the ${isReload ? 'reloaded stream' : 'transcode retry'} got stuck too — escalating like a failed resume`
                );
                this._handleBackendEvent({
                    type: 'resumeseekfailed',
                    data: { targetPositionTicks: targetTicks, stuck: true }
                });
                return;
            }

            log.warn(`seekstuck: seek to ${(targetTicks / 10000000).toFixed(2)} s never completed — reloading the stream there`);
            const restartOptions = {
                ...this._currentPlayOptions,
                audioStreamIndex: this._currentAudioStreamIndex,
                subtitleStreamIndex: this._currentSubtitleStreamIndex,
                secondarySubtitleStreamIndex: this._currentSecondarySubtitleStreamIndex,
                startPositionTicks: targetTicks,
                playbackMode: this._playbackMode
            };
            // Identity, as for _resumeRetryOptions: later restarts create new options
            this._seekReloadOptions = restartOptions;
            this._currentPlayOptions = restartOptions;
            this._lastPlayOptions = restartOptions;
            this._isRestarting = true;
            this._restartOwner = restartOptions;
            this.emit(PlayerEvent.RESTARTING);

            (async () => {
                try {
                    await this.stop({ restart: true });
                    const started = await this._playAfterRestartPause(restartOptions, 0);
                    // A reloaded remux that does not start is escalated by the watchdog,
                    // as after a failed resume. Not when another restart replaced this
                    // one: `started` is then that restart's outcome.
                    const isRemux = this._currentPlayMethod === 'Remux' || this._currentPlayMethod === 'DirectStream';
                    if (started !== false && isRemux && this._currentPlayOptions === restartOptions) {
                        this._armRemuxStuckWatchdog(targetTicks);
                    }
                } catch (e) {
                    log.error('seekstuck reload failed:', e);
                    this._clearRemuxStuckWatchdog();
                } finally {
                    // Unless a newer restart has taken over meanwhile
                    if (this._restartOwner === restartOptions) {
                        this._isRestarting = false;
                    }
                }
            })();
            return;
        }

        // ── HtmlVideoPlayer: DirectPlay resume seek failed ─────────────────────
        //
        // When the HtmlVideoPlayer backend fails to seek to the resume position
        // during DirectPlay (common on WebOS Chromium where #t= fragments are
        // ignored and programmatic seeks to unbuffered positions silently fail),
        // the backend emits resumeseekfailed. We restart playback in Remux mode
        // so the server streams from the target position, making the seek reliable.
        if (event.type === 'resumeseekfailed') {
            // Clear pending start position lock immediately so UI doesn't remain trapped
            this._pendingStartPositionTicks = null;
            this._clearResumeAdvanceWait();
            const targetTicks = event.data?.targetPositionTicks;
            const currentPosTicks = this.getCurrentPositionTicks();
            const effectiveTicks = targetTicks || currentPosTicks;

            // -----------------------------------------------------------------
            // Dynamic Fallback Escalation (DirectPlay -> Remux -> Transcode):
            // If the current stream is already running in DirectStream or Remux mode,
            // restarting in Remux would simply re-attempt the exact mid-GOP stream copy
            // that failed or stalled. In that case, escalate straight to 'transcode'.
            // Otherwise, fall back from DirectPlay to 'remux' first.
            // -----------------------------------------------------------------
            const isAlreadyRemux = this._playbackMode === 'remux' ||
                this._currentPlayMethod === 'DirectStream' ||
                this._currentPlayMethod === 'Remux';

            // -----------------------------------------------------------------
            // Never step down the ladder. A transcode exists because the TV
            // cannot decode the original video; restarting it as a remux sent
            // that video again (remux mode drops all CodecProfiles), which then
            // stalled into the remux watchdog → transcode → resumeseekfailed
            // loop. A transcode gets one fresh transcode at the target; if
            // that fails to land too, playback continues where it is. If its
            // seek never completes (seekstuck), there is nothing to continue
            // from: show the error instead of a spinner that never ends.
            // -----------------------------------------------------------------
            const isTranscoding = this._playbackMode === 'transcode' || this._currentPlayMethod === 'Transcode';
            if (isTranscoding && this._resumeRetryOptions && this._currentPlayOptions === this._resumeRetryOptions) {
                if (event.data?.stuck) {
                    log.error(
                        `resumeseekfailed: the transcode retry is stuck at ${(effectiveTicks / 10000000).toFixed(2)} s too — giving up`
                    );
                    this._clearRemuxStuckWatchdog();
                    this._seekGaveUpOptions = this._currentPlayOptions;
                    this.emit(PlayerEvent.ERROR, {
                        code: 'SEEK_STUCK',
                        message: 'Playback could not continue from this point',
                        type: 'playback'
                    });
                    return;
                }
                log.warn('resumeseekfailed: Transcoded resume already retried once — continuing from the current position');
                return;
            }
            const restartMode = isAlreadyRemux || isTranscoding ? 'transcode' : 'remux';

            log.warn('resumeseekfailed: Resume failed at', (currentPosTicks / 10000000).toFixed(2),
                `s (playMethod: ${this._currentPlayMethod}, mode: ${this._playbackMode}). Restarting with ${restartMode} at target`,
                (effectiveTicks / 10000000).toFixed(2), 's');

            if (this._currentPlayOptions && !this._isRestarting) {
                // Build restart options preserving active audio and subtitle selections
                const restartOptions = {
                    ...this._currentPlayOptions,
                    audioStreamIndex: this._currentAudioStreamIndex,
                    subtitleStreamIndex: this._currentSubtitleStreamIndex,
                    secondarySubtitleStreamIndex: this._currentSecondarySubtitleStreamIndex,
                    startPositionTicks: effectiveTicks,
                    playbackMode: restartMode
                };
                // Identity, not a flag on the options: a flag would be copied into
                // every later restart of the item (quality, audio, burn-in) and
                // block their resume fallback for good
                this._resumeRetryOptions = isTranscoding ? restartOptions : null;

                this._currentPlayOptions = restartOptions;
                this._lastPlayOptions = restartOptions;
                this._isRestarting = true;
                this._restartOwner = restartOptions;

                this.emit(PlayerEvent.RESTARTING);

                (async () => {
                    try {
                        await this.stop({ restart: true });
                        const started = await this._playAfterRestartPause(restartOptions, 500);

                        // -------------------------------------------------------------
                        // Arm stuck-detection watchdog once remux stream is initiated.
                        // If the hardware decoder hangs on mid-GOP stream copy, the
                        // watchdog will detect lack of progress and escalate to transcode.
                        // Not when the user stopped playback while the restart loaded,
                        // nor when another restart (audio track, burn-in) replaced this
                        // one: `started` is then that restart's outcome.
                        // -------------------------------------------------------------
                        const isOwnSession = this._currentPlayOptions === restartOptions;
                        if (started !== false && restartMode === 'remux' && isOwnSession) {
                            this._armRemuxStuckWatchdog(effectiveTicks);
                        }
                    } catch (e) {
                        log.error('resumeseekfailed restart failed:', e);
                        this._clearRemuxStuckWatchdog();
                    } finally {
                        // Unless a newer restart has taken over meanwhile
                        if (this._restartOwner === restartOptions) {
                            this._isRestarting = false;
                        }
                    }
                })();
            }
            return;
        }

        // Log backend errors with backend context before forwarding to UI layer
        if (event.type === PlayerEvent.ERROR) {
            log.error(`[JellyfinPlayer] Error event received from ${this._backendType} backend:`, event.data);

            // ────────────────────────────────────────────────────────────────
            // Smart Backend Fallback: Movi / ExoPlayer Runtime Error → HTML5
            // ────────────────────────────────────────────────────────────────
            // If the Movi or ExoPlayer backend encounters an unrecoverable runtime error
            // (e.g. demuxer/WASM crash, hardware decoder deadlock, or missing bridge),
            // switch to the universal HTML5 backend so the user doesn't get stuck.
            // ────────────────────────────────────────────────────────────────
            if (
                (this._backendType === 'movi' || this._backendType === 'exoplayer') &&
                !this._backendFallbackAttempted &&
                this._currentPlayOptions &&
                !this._isRestarting
            ) {
                this._backendFallbackAttempted = true;
                const failedBackend = this._backendType;
                const errorDesc = event.data?.error || event.data?.message || 'Playback error';
                log.warn(
                    `[BackendFallback] Fatal error from '${failedBackend}' backend (${errorDesc}). ` +
                    'Switching to HTML5 video backend and restarting...'
                );

                const currentTicks = this.getCurrentPositionTicks() || this._currentPlayOptions.startPositionTicks || 0;
                const restartOptions = {
                    ...this._currentPlayOptions,
                    audioStreamIndex: this._currentAudioStreamIndex,
                    subtitleStreamIndex: this._currentSubtitleStreamIndex,
                    secondarySubtitleStreamIndex: this._currentSecondarySubtitleStreamIndex,
                    startPositionTicks: currentTicks,
                    _backendFallbackAttempted: true
                };

                this._currentPlayOptions = restartOptions;
                this._lastPlayOptions = restartOptions;
                this._isRestarting = true;
                this._restartOwner = restartOptions;
                this.emit(PlayerEvent.RESTARTING);

                (async () => {
                    try {
                        await this.stop({ restart: true });
                        const request = this._playRequestId;
                        if (typeof this._backend?.destroy === 'function') {
                            this._backend.destroy();
                        }
                        await new Promise(resolve => setTimeout(resolve, 300));

                        // Reconfigure to HTML5 backend
                        this._backendType = 'html5';
                        this._backend = new HtmlVideoPlayer({
                            container: this.container,
                            settings: PlayerSettings,
                            onEvent: this._handleBackendEvent.bind(this)
                        });

                        const html5Profile = buildJellyfinProfile({
                            manualBitrate: this._manualBitrate,
                            playbackMode: this._playbackMode,
                            backend: 'html5'
                        });
                        restartOptions._deviceProfile = html5Profile;

                        // The new backend stays in place either way; the old one is destroyed
                        if (request !== this._playRequestId || this._restartOwner !== restartOptions) {
                            log.info('[BackendFallback] Playback was stopped or replaced meanwhile — not restarting');
                            return;
                        }
                        await this._playAfterRestartPause(restartOptions, 0);
                    } catch (fallbackErr) {
                        log.error('[BackendFallback] Failed to recover via HTML5 backend:', fallbackErr);
                        // play() has already reported its own failure
                        if (fallbackErr !== this._lastReportedPlayError) {
                            this.emit(PlayerEvent.ERROR, event.data);
                        }
                    } finally {
                        // Unless a newer restart has taken over meanwhile
                        if (this._restartOwner === restartOptions) {
                            this._isRestarting = false;
                        }
                    }
                })();
                return;
            }

            // ────────────────────────────────────────────────────────────────
            // DirectPlay / Remux Failure Transcode Escalation
            // ────────────────────────────────────────────────────────────────
            // When DirectPlay or Remux fails at startup or mid-playback (e.g.,
            // MKV container errors, decoder stalls, network disconnects on static
            // files, or unsupported bit depths/profiles), we seamlessly escalate
            // to server-side transcoding instead of dropping the user into a red
            // error modal. Jellyfin server then serves a compliant HLS stream.
            // ────────────────────────────────────────────────────────────────
            const isAutoTranscodeEnabled = PlayerSettings.get('autoTranscodeOnError') !== false;
            const canEscalate =
                isAutoTranscodeEnabled &&
                !this._isRestarting &&
                !this._directPlayEscalated &&
                this._currentPlayOptions &&
                // A forced remux copies the video even when labelled 'Transcode'
                (this._currentPlayMethod !== 'Transcode' || this._playbackMode === 'remux') &&
                this._playbackMode !== 'transcode';

            if (canEscalate) {
                // Prevent cyclic escalation cascades if transcoding also errors
                this._directPlayEscalated = true;
                const errorDesc = event.data?.error || event.data?.message || 'Playback error';
                log.warn(
                    `[JellyfinPlayer] ${this._currentPlayMethod || 'DirectPlay'} failed on ${this._backendType} (${errorDesc}). ` +
                    `Escalating session to server transcoding...`
                );

                // Preserve exact timestamp where DirectPlay errored
                const currentTicks = this.getCurrentPositionTicks() || this._currentPlayOptions.startPositionTicks || 0;
                const restartOptions = {
                    ...this._currentPlayOptions,
                    audioStreamIndex: this._currentAudioStreamIndex,
                    subtitleStreamIndex: this._currentSubtitleStreamIndex,
                    secondarySubtitleStreamIndex: this._currentSecondarySubtitleStreamIndex,
                    startPositionTicks: currentTicks,
                    playbackMode: 'transcode'
                };

                // Store options and flag restarting state to suppress transient stop events
                this._currentPlayOptions = restartOptions;
                this._lastPlayOptions = restartOptions;
                this._isRestarting = true;
                this._restartOwner = restartOptions;

                // Signal UI that recovery/restart is taking place
                this.emit(PlayerEvent.RESTARTING);

                (async () => {
                    try {
                        // Tear down existing backend decoder cleanly
                        await this.stop({ restart: true });
                        // Brief stabilization pause, then re-launch with strict transcode parameters
                        await this._playAfterRestartPause(restartOptions, 500);
                    } catch (escalateErr) {
                        log.error('[JellyfinPlayer] DirectPlay transcode escalation failed:', escalateErr);
                        // Forward error to UI if transcode restart fails (play() reports its own failures)
                        if (escalateErr !== this._lastReportedPlayError) {
                            this.emit(PlayerEvent.ERROR, event.data);
                        }
                    } finally {
                        // Unless a newer restart has taken over meanwhile
                        if (this._restartOwner === restartOptions) {
                            this._isRestarting = false;
                        }
                    }
                })();
                return;
            }
        }

        // Re-emit events from backend
        this.emit(event.type, event.data);
    }

    /**
     * Play method of a forced remux (video copy requested) that the server
     * reports like a transcode.
     *
     * - TranscodeReasons=DirectPlayError only: the streams are copied.
     * - Current Jellyfin keeps only h264/hevc/vp9/av1 in an HLS video codec
     *   list, so the requested 'copy' is dropped and VideoCodecNotSupported
     *   is added, yet the server still copies the video because no target
     *   codec is left. So the video is copied when the TranscodingUrl names
     *   no target video codec (or 'copy').
     * - Either way, a source above the URL's VideoBitrate/MaxWidth/MaxHeight
     *   is re-encoded (a quality limit below the source bitrate).
     *
     * @private
     * @param {Object} mediaSource
     * @param {string} playMethod - Method derived by MediaHelper.getPlayMethod()
     * @returns {string} 'Remux' or 'DirectStream' when the video is copied, else playMethod
     */
    _resolveForcedRemuxPlayMethod(mediaSource, playMethod) {
        // A source above the URL's bitrate or size limits is re-encoded even in remux mode
        if (MediaHelper.isVideoOverTranscodeLimits(mediaSource)) {
            return playMethod;
        }

        const url = mediaSource.TranscodingUrl || '';
        const reasons = mediaSource.TranscodingReasons;
        const hasOnlyDirectPlayError = reasons === 'DirectPlayError' ||
            (Array.isArray(reasons) && reasons.length === 1 && reasons[0] === 'DirectPlayError');

        // Also check the URL parameters if reasons property is empty (it's often in the URL)
        const urlHasOnlyDirectPlayError = url.includes('TranscodeReasons=DirectPlayError') &&
            !url.includes('ContainerNotSupported') &&
            !url.includes('VideoCodecNotSupported') &&
            !url.includes('AudioCodecNotSupported');

        if (hasOnlyDirectPlayError || urlHasOnlyDirectPlayError) {
            log.info('[PlaybackMode] Inferring Remux based on DirectPlayError only.');
            return 'Remux';
        }

        const videoCodecParam = url.match(/[?&]VideoCodec=([^&]*)/i);
        const targetVideoCodecs = videoCodecParam
            ? decodeURIComponent(videoCodecParam[1]).toLowerCase().split(',').filter(Boolean)
            : [];
        if (targetVideoCodecs.length > 0 && !targetVideoCodecs.includes('copy')) {
            return playMethod;
        }

        const { isAudioDirect } = MediaHelper.getTranscodeStatus(mediaSource);
        const method = isAudioDirect ? 'Remux' : 'DirectStream';
        log.info(`[PlaybackMode] Forced remux with no target video codec — video is copied (${method}).`);
        return method;
    }

    // ========================================================================
    // Remux Stuck Watchdog & Transcode Escalation
    // ========================================================================

    /**
     * Whether a resume that landed near its target should keep the loading
     * screen up because playback has not advanced yet.
     *
     * The <video> backends (webOS, HTML5) report the landed position as soon
     * as the seek completes, before any frame is decoded. A high-bitrate
     * remux took 8+ s from there to its first frame on an LG C4, all of it a
     * black screen with the spinner already gone. So the first report only
     * starts the wait; the next report that moves forward ends it. Native
     * players (AVPlay, ExoPlayer, Movi) report time only while playing, and a
     * paused start (autoPlay false) never advances, so neither waits.
     *
     * @private
     * @param {number} time - Reported media position (seconds)
     * @returns {boolean} True while the loading screen should stay up
     */
    _isAwaitingResumeAdvance(time) {
        const reportsSeekLanding = this._backendType === 'webos' || this._backendType === 'html5';
        if (!reportsSeekLanding || this._currentPlayOptions?.autoPlay === false) {
            return false;
        }

        if (this._resumeLastTime === null || this._resumeLastTime === undefined) {
            this._resumeLastTime = time;
            log.info(`Resume landed at ${time}s. Keeping the loading screen until playback advances.`);

            // Never hold the loading screen for good on a start that does not move
            const request = this._playRequestId;
            this._resumeAdvanceTimer = setTimeout(() => {
                this._resumeAdvanceTimer = null;
                if (request !== this._playRequestId || this._pendingStartPositionTicks === null) return;
                this._finishResumeWait(
                    `Resume landed at ${time}s but playback has not advanced for ${RESUME_ADVANCE_WAIT_MS / 1000}s. Dismissing loading screen.`
                );
            }, RESUME_ADVANCE_WAIT_MS);
            return true;
        }

        const advanced = time > this._resumeLastTime + 0.05;
        this._resumeLastTime = time;
        return !advanced;
    }

    /**
     * End the resume wait: the loading screen goes and playback state is synced.
     * @private
     * @param {string} message - Log line
     */
    _finishResumeWait(message) {
        this._clearResumeAdvanceWait();
        this._pendingStartPositionTicks = null;
        log.info(message);

        // Synchronize logical paused state — playback has safely engaged at the target position
        this._isPaused = false;
        this._subtitleManager?.play();

        // Emit PLAY followed by PLAYING so OSD and higher layers reflect active playback immediately
        this.emit(PlayerEvent.PLAY);
        this.emit(PlayerEvent.PLAYING);
    }

    /** @private */
    _clearResumeAdvanceWait() {
        if (this._resumeAdvanceTimer) {
            clearTimeout(this._resumeAdvanceTimer);
            this._resumeAdvanceTimer = null;
        }
        this._resumeLastTime = null;
    }

    /**
     * Arm the remux stuck-detection watchdog after falling back from DirectPlay seek failure.
     *
     * Why this is needed:
     * When seeking in DirectPlay fails (e.g. on MKV over HTTP on webOS), we restart in
     * 'remux' mode. However, if the stream has a long GOP and FFmpeg stream-copies mid-GOP
     * (-codec:v copy), the first HLS segment starts on a non-IDR (P/B) frame without
     * preceding reference frames. On hardware decoders (such as LG webOS MediaPipeline),
     * this causes an indefinite decoder freeze: currentTime never advances, and the
     * loading spinner never dismisses.
     *
     * This watchdog grants remuxing 8 seconds to decode frames and advance. If time
     * ticks forward by at least 0.3s, the watchdog clears. If 8 seconds elapse without
     * progression, it escalates playback to 'transcode', which forces a clean IDR
     * keyframe and unblocks the decoder immediately.
     *
     * A remux of a high-bitrate source (4K at ~120 Mbps) can still be filling
     * its first segments after 8 s; that is not a freeze. While data keeps
     * arriving and less than REMUX_STUCK_BUFFER_AHEAD_S is buffered, the check
     * is repeated (up to REMUX_WATCHDOG_MAX_MS in all).
     *
     * @private
     * @param {number} targetTicks - Target resume position in ticks
     */
    _armRemuxStuckWatchdog(targetTicks) {
        // Disarm any preexisting watchdog timer first
        this._clearRemuxStuckWatchdog();

        this._remuxWatchdogActive = true;
        this._remuxWatchdogTargetTicks = targetTicks;
        this._remuxWatchdogInitialTime = null;
        this._remuxWatchdogArmedAt = Date.now();
        // Baseline for "is data still arriving" at the first check
        const buffer = this._getBackendBufferState();
        this._remuxWatchdogBufferedEnd = buffer ? buffer.end : null;

        log.info(`[JellyfinPlayer] Armed remux stuck watchdog (8s timeout) at ${(targetTicks / 10000000).toFixed(2)}s`);

        // Schedule stuck evaluation window (8 seconds)
        this._scheduleRemuxWatchdogCheck(REMUX_WATCHDOG_FIRST_CHECK_MS);
    }

    /** @private */
    _scheduleRemuxWatchdogCheck(delayMs) {
        const timerFn = typeof setTimeout !== 'undefined'
            ? setTimeout
            : (typeof globalThis !== 'undefined' ? globalThis.setTimeout : null);

        if (!timerFn) return;

        this._remuxWatchdogTimeout = timerFn(() => {
            this._remuxWatchdogTimeout = null;
            this._handleRemuxWatchdogTimeout();
        }, delayMs);
    }

    /**
     * Media buffered ahead of the playhead in the backend's <video> element.
     * @private
     * @returns {{ahead: number, end: number}|null} Seconds ahead and the end of the
     *   buffered range (media time), or null when the backend has no media element
     *   (AVPlay) or it cannot be read
     */
    _getBackendBufferState() {
        const backend = this._backend;
        const video = backend && typeof backend.getVideoElement === 'function' ? backend.getVideoElement() : null;
        if (!video || !video.buffered) return null;

        try {
            const ct = video.currentTime || 0;
            for (let i = 0; i < video.buffered.length; i++) {
                const start = video.buffered.start(i);
                const end = video.buffered.end(i);
                // The first remuxed segment can start just after the playhead
                if (start <= ct + 1 && end > ct) {
                    return { ahead: end - ct, end };
                }
            }
            return { ahead: 0, end: ct };
        } catch (e) {
            return null;
        }
    }

    /**
     * Clear and disarm the remux stuck watchdog.
     * @private
     */
    _clearRemuxStuckWatchdog() {
        if (this._remuxWatchdogTimeout) {
            const clearTimer = typeof clearTimeout !== 'undefined'
                ? clearTimeout
                : (typeof globalThis !== 'undefined' ? globalThis.clearTimeout : null);
            if (clearTimer) {
                clearTimer(this._remuxWatchdogTimeout);
            }
            this._remuxWatchdogTimeout = null;
        }
        this._remuxWatchdogActive = false;
        this._remuxWatchdogTargetTicks = null;
        this._remuxWatchdogInitialTime = null;
        this._remuxWatchdogBufferedEnd = null;
    }

    /**
     * Handler invoked when the remux stuck watchdog times out without time progression.
     * Automatically escalates playback from 'remux' to 'transcode' to break decoder freeze.
     * @private
     */
    _handleRemuxWatchdogTimeout() {
        // Guard against stale triggers if watchdog was already cleared or player is stopping
        if (!this._remuxWatchdogActive || this._isRestarting || !this._currentPlayOptions) {
            return;
        }

        // ---------------------------------------------------------------------
        // Still filling the buffer, or frozen?
        // ---------------------------------------------------------------------
        // A freeze shows as buffered data the playhead does not move into. A
        // remux of a high-bitrate source can simply not have enough data yet:
        // keep waiting while data arrives, up to REMUX_WATCHDOG_MAX_MS.
        // ---------------------------------------------------------------------
        const buffer = this._getBackendBufferState();
        const waitedMs = Date.now() - (this._remuxWatchdogArmedAt || 0);
        if (buffer) {
            const previousEnd = this._remuxWatchdogBufferedEnd;
            const dataArriving = previousEnd === null ? buffer.ahead > 0 : buffer.end > previousEnd + 0.1;
            this._remuxWatchdogBufferedEnd = buffer.end;

            if (dataArriving && buffer.ahead < REMUX_STUCK_BUFFER_AHEAD_S && waitedMs < REMUX_WATCHDOG_MAX_MS) {
                log.info(
                    `[JellyfinPlayer] Remux still buffering (${buffer.ahead.toFixed(1)}s ahead after ${(waitedMs / 1000).toFixed(1)}s) — not frozen, checking again`
                );
                this._scheduleRemuxWatchdogCheck(Math.min(REMUX_WATCHDOG_RECHECK_MS, REMUX_WATCHDOG_MAX_MS - waitedMs));
                return;
            }
        }

        const targetTicks = this._remuxWatchdogTargetTicks || this.getCurrentPositionTicks();
        const why = !buffer
            ? 'no progress'
            : buffer.ahead >= REMUX_STUCK_BUFFER_AHEAD_S
                ? `${buffer.ahead.toFixed(1)}s buffered but the decoder is not advancing`
                : waitedMs >= REMUX_WATCHDOG_MAX_MS
                    ? `still not playing after ${Math.round(waitedMs / 1000)}s`
                    : `no data arriving (${buffer.ahead.toFixed(1)}s buffered)`;
        log.warn(`[JellyfinPlayer] Remux playback stuck after fallback at ${(targetTicks / 10000000).toFixed(2)}s (${why}). Escalating to transcode.`);

        // Disarm watchdog so we don't re-trigger or cascade
        this._clearRemuxStuckWatchdog();

        /*
         * ====================================================================
         * AUTO-TRANSCODE ERROR ESCALATION GUARD:
         *
         * Respect the user's explicit preference for automatic transcode
         * fallback on error. If autoTranscodeOnError is disabled, do not
         * restart the session into server-side transcoding. Emit an error
         * and stop playback cleanly instead of forcing unwanted transcode.
         * ====================================================================
         */
        const isAutoTranscodeEnabled = typeof PlayerSettings !== 'undefined'
            ? PlayerSettings.get('autoTranscodeOnError') !== false
            : true;
        if (!isAutoTranscodeEnabled) {
            log.warn(
                `[JellyfinPlayer] Remux playback stuck at ${(targetTicks / 10000000).toFixed(2)}s (${why}), ` +
                'but autoTranscodeOnError is disabled — stopping playback without transcode escalation'
            );
            this.emit(PlayerEvent.ERROR, {
                error: `Playback stuck (${why}) and auto-transcode fallback is disabled.`,
                code: 3,
                isPlaybackStuck: true
            });
            this.stop();
            return;
        }

        // Build transcode restart configuration preserving active stream selections
        const transcodeOptions = {
            ...this._currentPlayOptions,
            audioStreamIndex: this._currentAudioStreamIndex,
            subtitleStreamIndex: this._currentSubtitleStreamIndex,
            secondarySubtitleStreamIndex: this._currentSecondarySubtitleStreamIndex,
            startPositionTicks: targetTicks,
            playbackMode: 'transcode'
        };

        this._currentPlayOptions = transcodeOptions;
        this._lastPlayOptions = transcodeOptions;
        this._isRestarting = true;
        this._restartOwner = transcodeOptions;

        this.emit(PlayerEvent.RESTARTING);

        (async () => {
            try {
                // Teardown backend session cleanly before transcode re-initialization
                await this.stop({ restart: true });
                // Start playback in full transcode mode
                await this._playAfterRestartPause(transcodeOptions, 500);
            } catch (e) {
                log.error('[JellyfinPlayer] Transcode escalation restart failed:', e);
            } finally {
                // Unless a newer restart has taken over meanwhile
                if (this._restartOwner === transcodeOptions) {
                    this._isRestarting = false;
                }
            }
        })();
    }

    // ========================================================================
    // Playback Control
    // ========================================================================

    /**
     * Ends a play() request that stop(), destroy() or a newer play() replaced.
     * @param {string} stage - The await the request was waiting on
     * @returns {false} The value play() resolves for a superseded request
     * @private
     */
    _abandonSupersededPlay(stage) {
        log.info(`play() request superseded by stop() or a newer request (after ${stage}) — abandoning it`);
        return false;
    }

    /**
     * Starts a restart's play() after the pause that follows its stop(),
     * unless stop(), destroy() or another play() came in during the pause
     * (Back or next item while the restart was pending). A restart started
     * anyway would load the old item again on a stopped or replaced player.
     *
     * @param {Object} options - The restart's play options
     * @param {number} pauseMs - Pause before play()
     * @returns {Promise<boolean>} play()'s result, or false when abandoned
     * @private
     */
    async _playAfterRestartPause(options, pauseMs) {
        const request = this._playRequestId;
        // Set up by the restart's stop() for a play() request it replaced (see stop())
        const handover =
            this._restartHandover && this._restartHandover.request === request ? this._restartHandover : null;
        if (pauseMs > 0) {
            await new Promise(resolve => setTimeout(resolve, pauseMs));
        }
        // A stop() or a newer restart takes the restart over (see _restartOwner), also
        // while the restart's own stop() still waited for an asynchronous backend
        // (ExoPlayer, AVPlay), before `request` was read
        if (request !== this._playRequestId || this._restartOwner !== options) {
            log.info('Restart abandoned: playback was stopped or replaced while it was pending');
            return false;
        }
        if (handover) {
            this._restartHandover = null;
        }
        const playing = this.play(options);
        if (handover) {
            handover.settle(playing);
        }
        return playing;
    }

    /**
     * Play media item
     *
     * @param {Object} options - Play options
     * @param {string} options.itemId - Jellyfin item ID
     * @param {string} [options.mediaSourceId] - Specific media source ID
     * @param {number} [options.startPositionTicks=0] - Start position in ticks
     * @param {number} [options.audioStreamIndex] - Audio track index
     * @param {number} [options.subtitleStreamIndex] - Subtitle track index
     * @returns {Promise<boolean>} false when stop() or a newer play() superseded
     *   this request before it started; callers must then not continue with it.
     *   Otherwise true (also when this request's own escalation started playback).
     *   A request that a restart replaced resolves with the restart's play().
     */
    async play(options) {
        // ────────────────────────────────────────────────────────────────
        // Request token: stop(), destroy() and a newer play() advance it.
        // A request checks it after every await, so a stale request (Back
        // while PlaybackInfo loads, quick next/previous) never touches the
        // player state, the backend or the page once it has been replaced.
        // ────────────────────────────────────────────────────────────────
        const request = (this._playRequestId = (this._playRequestId || 0) + 1);
        const isSuperseded = () => request !== this._playRequestId;
        // A restart flow's stop() that replaces this request leaves the restart's
        // outcome here (see stop()): the request was not cancelled, it resolves with
        // the restart. webOS reports a failed audio track switch while video.play()
        // is pending, and PlayerPage skips its OSD setup when play() resolves false.
        const latest = (this._latestPlay = { request, restart: null });
        const abandon = (stage) => {
            if (latest.restart) {
                log.info(`play() request replaced by a restart (after ${stage}) — resolving with the restart`);
                return latest.restart;
            }
            return this._abandonSupersededPlay(stage);
        };
        // A restart that has not started its play() yet is over: this one came first
        if (this._restartHandover) {
            this._restartHandover.settle(false);
            this._restartHandover = null;
        }
        // Set when the backend's load fails: the only failure a transcode restart can help
        let backendLoadFailed = false;

        //log.info('Play requested:', options);
        /*
         * ====================================================================
         * Active Player Backend Diagnostics
         * ====================================================================
         * Log the resolved backend engine ('exoplayer', 'movi', 'webos', 'tizen', 'html5').
         * The old 'Use Tizen Player' log is omitted here as backendType unifies all platforms.
         */
        log.info('Backend Type:', this._backendType);

        // Update server URL/Auth if provided in play options
        if (options.serverUrl) this.serverUrl = options.serverUrl;
        if (options.authToken) this.authToken = options.authToken;

        this._currentPlayOptions = options;
        // Store initial options for potential reload
        this._lastPlayOptions = options;

        // A remux watchdog belongs to the session it was armed for (Next while a
        // restart loaded left one that restarted the next item); play() arms it
        // again below when this session needs it
        if (this._remuxWatchdogActive) {
            this._clearRemuxStuckWatchdog();
        }

        // Reset fallback attempt flag on fresh playback sessions
        if (!options._backendFallbackAttempted) {
            this._backendFallbackAttempted = false;
        }

        try {
            log.debug(`Requesting PlaybackInfo from ${this.serverUrl}...`);

            this._playbackMode = options.playbackMode || 'auto';

            // ────────────────────────────────────────────────────────────────
            // Capture User Intent
            // ────────────────────────────────────────────────────────────────
            // A fresh play request (when _isRestarting is false) asks for the
            // user's mode. A restart's mode (the remux or transcode it falls
            // back to) stays with the current item: a fresh play of the same
            // item in the user's mode (Retry, network recovery) starts in it
            // again instead of the direct play that failed. Any other item
            // starts without it.
            // ────────────────────────────────────────────────────────────────
            if (!this._isRestarting) {
                const requestedMode = this._playbackMode;
                const fallback = this._itemFallbackMode;
                if (fallback && fallback.itemId === options.itemId && requestedMode === this._userPlaybackMode) {
                    this._playbackMode = options.playbackMode = fallback.mode;
                } else {
                    this._itemFallbackMode = null;
                }
                this._userPlaybackMode = requestedMode;
                // Fresh playback request resets the escalation safeguard
                this._directPlayEscalated = false;
            } else {
                this._itemFallbackMode = { itemId: options.itemId, mode: this._playbackMode };
            }

            // Determine if we need to force a remux for audio tracks on HTML5
            const isHtml5Backend = !(this._backend instanceof TizenAVPlayer);
            const supportsNativeAudio = this._backend && typeof this._backend.supportsNativeAudioTracks === 'function' && this._backend.supportsNativeAudioTracks();

            // Auto-resolve best DirectPlay audio track if not explicitly requested
            if ((options.audioStreamIndex === undefined || options.audioStreamIndex === null) && options.item && options.item.MediaSources) {
                const fallbackSource = options.item.MediaSources[0];
                const ms = options.item.MediaSources.find(m => m.Id === options.mediaSourceId) || fallbackSource;
                if (ms) {
                    const bestAudioStream = resolveBestAudioStream(ms, null, this._backendType);
                    if (bestAudioStream) {
                        options.audioStreamIndex = bestAudioStream.Index;
                        log.info(`[AudioSelection] Auto-resolved DirectPlay audio stream index: ${options.audioStreamIndex} (${bestAudioStream.Codec})`);
                    }
                }
            }

            // Locate active MediaSource for track requirement evaluation
            let activeMs = null;
            if (options.item && options.item.MediaSources) {
                const fallbackSource = options.item.MediaSources[0];
                activeMs = options.item.MediaSources.find(m => m.Id === options.mediaSourceId) || fallbackSource;
            }

            let isCustomAudioTrack = false;
            let isFirstAudioTrack = true;
            if (options.audioStreamIndex !== undefined && options.audioStreamIndex !== null) {
                // Determine the default and first tracks from the pre-fetched item if available
                let defaultIndex = undefined;
                let firstAudioIndex = undefined;

                if (activeMs) {
                    const audioStreams = (activeMs.MediaStreams || []).filter(s => s.Type === 'Audio');
                    // Find actual container default without using the dynamically echoed DefaultAudioStreamIndex
                    const defaultAudioStream = audioStreams.find(s => s.IsDefault && isAudioTrackNativelyPlayable(s, activeMs, this._backendType)) ||
                        audioStreams.find(s => isAudioTrackNativelyPlayable(s, activeMs, this._backendType)) ||
                        audioStreams[0];
                    defaultIndex = defaultAudioStream ? defaultAudioStream.Index : undefined;
                    if (audioStreams.length > 0) {
                        firstAudioIndex = audioStreams[0].Index;
                    }
                }

                // Compare indices (cast to number to avoid type mismatches)
                const reqIndex = Number(options.audioStreamIndex);
                isCustomAudioTrack = (reqIndex !== Number(defaultIndex));
                isFirstAudioTrack = (firstAudioIndex !== undefined && reqIndex === Number(firstAudioIndex));

                log.info(`[AudioSelection] Requested: ${reqIndex}, Default: ${defaultIndex}, First: ${firstAudioIndex}, Custom: ${isCustomAudioTrack}, IsFirst: ${isFirstAudioTrack}`);
            }

            // Determine if the requested audio track requires server remuxing (DirectStream)
            // This catches non-default passthrough tracks (DTS, TrueHD, FLAC) on WebOS/HTML5
            // that Chromium cannot switch natively in progressive DirectPlay.
            const trackRequiresDirectStream = activeMs && options.audioStreamIndex !== undefined && options.audioStreamIndex !== null
                ? doesAudioTrackRequireDirectStream(activeMs, options.audioStreamIndex, this._backendType)
                : false;

            const needsDirectStreamForAudio = options._forceDirectStream ||
                trackRequiresDirectStream ||
                (isHtml5Backend && !supportsNativeAudio && (isCustomAudioTrack || !isFirstAudioTrack));

            // Determine effective playback mode for profiling
            let profilePlaybackMode = this._playbackMode;
            const forceDirectPlay = PlayerSettings.get('forceDirectPlay');
            // If direct play is forced for audio specifically or for everything, audio demuxing must not downgrade direct play
            const isAudioDirectPlayForced = (forceDirectPlay === 'all' || forceDirectPlay === 'audio' || forceDirectPlay === true);
            // Unless the user explicitly forced Direct Play for audio or all formats in preferences,
            // audio tracks requiring server demuxing are upgraded to remux mode.
            if (!isAudioDirectPlayForced && needsDirectStreamForAudio && profilePlaybackMode === 'auto') {
                log.info('Audio track selection requires remux: Upgrading profile mode to "remux" to ensure video Direct Stream.');
                profilePlaybackMode = 'remux';
                this._playbackMode = 'remux';
            }

            // The desktop and web profiles depend on the WebCodecs AV1 probe; it is cached after the first run.
            if ((platformInfo.isDesktop || platformInfo.isWeb) && platformInfo.hasWebCodecsSupport) {
                await webCodecsProbe.probeAV1();
                if (isSuperseded()) return abandon('AV1 probe');
            }

            // Build device profile once (avoids duplicate logs/work).
            // On an interlaced fallback retry, a pre-built html5 profile is passed in
            // via options._deviceProfile so we don't rebuild with the wrong settings.
            const deviceProfile = options._deviceProfile || buildJellyfinProfile({
                manualBitrate: this._manualBitrate,
                playbackMode: profilePlaybackMode,
                backend: this._backendType
            });
            log.info('Built DeviceProfile:', deviceProfile.Name);

            // If we still need to force remux but didn't use the 'remux' mode in profile
            // (e.g. user set bitrate limits), still clear DirectPlayProfiles as a safeguard.
            // When Force Direct Play (audio or all) is enabled, direct play profiles must remain intact.
            if (needsDirectStreamForAudio && !isAudioDirectPlayForced) {
                deviceProfile.DirectPlayProfiles = [];
            }

            // Apply Subtitle Mode logic before fetching PlaybackInfo
            // This ensures the server includes the correct subtitle in TranscodingUrls (burn-in)
            if (options.subtitleStreamIndex === undefined && options.item && options.item.MediaSources) {
                const fallbackSource = options.item.MediaSources[0];
                const ms = options.item.MediaSources.find(m => m.Id === options.mediaSourceId) || fallbackSource;
                if (ms && ms.MediaStreams) {
                    // Resolve target subtitle track based on active Subtitle Mode preference
                    const resolvedSub = resolveSubtitleStream(ms, {
                        audioStreamIndex: options.audioStreamIndex
                    });
                    options.subtitleStreamIndex = resolvedSub;
                    const subtitleMode = PlayerSettings.get('subtitleMode') || 'Default';
                    log.info(`[SubtitleSelection] Pre-flight Mode: ${subtitleMode}, Chosen Index: ${resolvedSub}`);
                }
            }

            // Get playback info from server
            const playbackInfo = await this._getPlaybackInfo(options, deviceProfile, this._manualBitrate);
            if (isSuperseded()) return abandon('PlaybackInfo');
            log.debug('PlaybackInfo keys:', Object.keys(playbackInfo));
            if (playbackInfo.MediaSources && playbackInfo.MediaSources.length > 0) {
                log.debug('MediaSource[0] keys:', Object.keys(playbackInfo.MediaSources[0]));
            }


            if (!playbackInfo || !playbackInfo.MediaSources?.length) {
                log.error('No media sources in PlaybackInfo');
                throw new Error('No media sources available');
            }

            // Select best media source:
            // For Live TV channels, the server dynamically generates the media source ID
            // when it opens the tuner — it will NEVER match options.mediaSourceId (which is
            // the channel item ID). Always pick the first source for live channels.
            const isLiveChannel = options.item?.Type === 'TvChannel';
            const mediaSource = (!isLiveChannel && options.mediaSourceId)
                ? playbackInfo.MediaSources.find((ms) => ms.Id === options.mediaSourceId)
                : playbackInfo.MediaSources[0];

            if (!mediaSource) {
                log.error('Media source selection failed');
                throw new Error('Media source not found');
            }

            if (mediaSource.TranscodingInfo) {
                log.info(`[PlaybackMode] IsDirectStream: ${mediaSource.TranscodingInfo.IsVideoDirect ? 'Yes' : 'No'}`);
            }

            // ================================================================
            // DEBUG: Log video stream properties to diagnose transcoding decisions
            // This helps identify exactly which CodecProfile condition fails.
            // ================================================================
            const videoStream = (mediaSource.MediaStreams || []).find(s => s.Type === 'Video');
            if (videoStream) {
                log.info(`[PlaybackMode] VideoStream: Codec=${videoStream.Codec}, Profile=${videoStream.Profile}, Level=${videoStream.Level}, BitDepth=${videoStream.BitDepth}, RangeType=${videoStream.VideoRangeType}, Width=${videoStream.Width}x${videoStream.Height}`);
            }
            if (mediaSource.TranscodingUrl) {
                log.info(`[PlaybackMode] TranscodingUrl: ${mediaSource.TranscodingUrl}`);
            }
            log.info(`[PlaybackMode] SupportsDirectPlay=${mediaSource.SupportsDirectPlay}, SupportsDirectStream=${mediaSource.SupportsDirectStream}`);
            // MediaHelper also derives PlayMethod, let's check that
            let playMethod = MediaHelper.getPlayMethod(mediaSource);

            // In "Force Remux" mode, the server might report "Transcode" because it technically
            // falls back to the transcoding pipeline while it copies the video.
            const wasForcedRemux = (this._playbackMode === 'remux' || (typeof profilePlaybackMode !== 'undefined' && profilePlaybackMode === 'remux'));
            if (wasForcedRemux && playMethod === 'Transcode') {
                playMethod = this._resolveForcedRemuxPlayMethod(mediaSource, playMethod);
                if (playMethod !== 'Transcode') {
                    // MediaHelper.getPlayMethod() still reads this source as a
                    // transcode; Playback Info uses getCurrentPlayMethod()
                    mediaSource.SupportsDirectStream = true;
                }
            }
            if (this._playbackMode === 'transcode') {
                playMethod = 'Transcode';
                mediaSource.SupportsDirectStream = false;
                mediaSource.SupportsDirectPlay = false;

                // Force MediaHelper to evaluate this as a full transcode for UI overlays
                if (!mediaSource.TranscodingInfo) {
                    mediaSource.TranscodingInfo = {
                        IsVideoDirect: false,
                        IsAudioDirect: false,
                        VideoCodec: 'h264', // Dummy value to prevent !VideoCodec fallback
                        AudioCodec: 'aac'
                    };
                } else {
                    mediaSource.TranscodingInfo.IsVideoDirect = false;
                    mediaSource.TranscodingInfo.IsAudioDirect = false;
                }

                log.info('[PlaybackMode] Enforcing Transcode label due to strict transcode mode.');
            }

            log.info(`[PlaybackMode] Calculated PlayMethod: ${playMethod}`);

            // Store the resolved play method so track-switching logic can
            // reliably detect transcoding without re-deriving from media source
            // flags (which may have been mutated, e.g. by the remux case above).
            this._currentPlayMethod = playMethod;

            // Attach play session ID to media source
            if (playbackInfo.PlaySessionId) {
                mediaSource.PlaySessionId = playbackInfo.PlaySessionId;
            }

            // ================================================================
            // Interlaced Backend Fallback — AVPlay Auto-Switch
            //
            // Samsung's AVPlay HLS parser crashes with PLAYER_ERROR_NOT_SUPPORTED_FORMAT
            // when the video stream contains interlaced H264 frames (e.g. 1080i DVB/ATSC
            // broadcasts). The Chromium software decoder in the HTML5 backend handles
            // interlaced H264 natively, so we transparently restart the session on HTML5
            // when all of the following conditions are met:
            //
            //   1. We are currently on the AVPlay (tizen) backend
            //   2. The user has 'interlacedBackendFallback' enabled in settings
            //   3. The video stream is flagged IsInterlaced=true by Jellyfin
            //   4. A non-HTML5 restart has not already been attempted (guard flag)
            //
            // No server-side transcoding happens — the device profile built for HTML5
            // omits the IsInterlaced=false CodecProfile condition, so the server will
            // direct-stream or direct-play the interlaced content as-is.
            // ================================================================
            if (
                this._backendType === 'tizen' &&
                PlayerSettings.get('interlacedBackendFallback') &&
                !options._interlacedFallbackAttempted
            ) {
                // Validate interlaced flag against actual stream geometry:
                // 1. Must be flagged IsInterlaced by Jellyfin.
                // 2. Must have verified dimensions (avoid false positives on unprobed live streams).
                // 3. 4K UHD broadcasts (>= 2160p) are strictly progressive by standard, so never fallback 4K.
                const isInterlaced = Boolean(
                    videoStream &&
                    videoStream.IsInterlaced === true &&
                    videoStream.Width &&
                    videoStream.Height &&
                    videoStream.Height <= 1080
                );
                if (isInterlaced) {
                    log.info(
                        `[InterlacedFallback] Interlaced video detected (${videoStream.Width}x${videoStream.Height}i). ` +
                        'AVPlay cannot handle interlaced HLS — restarting on HTML5 backend.'
                    );

                    // Stop the current backend before switching — it hasn't started playing yet,
                    // but belt-and-suspenders in case prepareAsync was triggered internally.
                    try {
                        await this._backend.stop();
                    } catch (stopErr) {
                        log.warn('[InterlacedFallback] Backend stop() threw during pre-switch cleanup:', stopErr);
                    }
                    if (isSuperseded()) return abandon('interlaced fallback');

                    // Switch backend to HTML5 in-place (no page reload needed).
                    // HtmlVideoPlayer is already statically imported at the top of this module,
                    // so we just construct a new instance directly.
                    this._backend = new HtmlVideoPlayer({
                        container: this.container,
                        settings: PlayerSettings,
                        onEvent: this._handleBackendEvent.bind(this)
                    });
                    this._backendType = 'html5';
                    log.info('[InterlacedFallback] Backend switched to html5. Rebuilding profile and restarting...');

                    // Rebuild with html5 backend so the profile omits IsInterlaced=false,
                    // allowing the server to direct-stream the interlaced content unchanged.
                    const html5Profile = buildJellyfinProfile({
                        manualBitrate: this._manualBitrate,
                        playbackMode: profilePlaybackMode,
                        backend: 'html5'
                    });

                    // Re-request PlaybackInfo with the html5 profile so the server
                    // knows it no longer needs to deinterlace, then start playback.
                    // Set the guard flag so we never loop if html5 also somehow fails.
                    return this.play({
                        ...options,
                        _interlacedFallbackAttempted: true,
                        _deviceProfile: html5Profile
                    });
                }
            }

            // ================================================================
            // WebCodecs AV1 Backend Fallback — Movi Auto-Switch
            //
            // Some engines advertise AV1 through WebCodecs but fail every decode
            // (WebKitGTK/WPE up to 2.54.0, see WebCodecsProbe), so Movi cannot play it.
            // The HTML5 backend decodes through the media element instead of WebCodecs:
            // it plays AV1 with the engine's own decoders, and the server transcodes when
            // the engine has none. Restart on it when the conditions below hold. Needed
            // only until WebKitGTK/WPE releases with the AV1 fixes ship; on those the
            // probe passes and this is skipped.
            //
            //   1. We are currently on the Movi backend
            //   2. The startup probe showed WebCodecs cannot decode AV1
            //   3. The video stream is AV1
            //   4. This fallback has not already been attempted (guard flag)
            // ================================================================
            if (
                this._backendType === 'movi' &&
                webCodecsProbe.av1Decodes === false &&
                (videoStream?.Codec || '').toLowerCase() === 'av1' &&
                !options._webCodecsAV1FallbackAttempted
            ) {
                log.info('[WebCodecsAV1Fallback] WebCodecs cannot decode AV1 here — restarting on HTML5 backend.');

                // Movi is not reused: destroy() stops it and also removes its element and event callback.
                try {
                    this._backend.destroy();
                } catch (destroyErr) {
                    log.warn('[WebCodecsAV1Fallback] Backend destroy() threw during the switch:', destroyErr);
                }

                this._backend = new HtmlVideoPlayer({
                    container: this.container,
                    settings: PlayerSettings,
                    onEvent: this._handleBackendEvent.bind(this)
                });
                this._backendType = 'html5';

                const html5Profile = buildJellyfinProfile({
                    manualBitrate: this._manualBitrate,
                    playbackMode: profilePlaybackMode,
                    backend: 'html5'
                });

                return this.play({
                    ...options,
                    _webCodecsAV1FallbackAttempted: true,
                    _deviceProfile: html5Profile
                });
            }

            this._currentMediaSource = mediaSource;
            this._currentItem = options.item || { Id: options.itemId };

            // ================================================================
            // Chapter Resolution
            //
            // We resolve chapters after establishing _currentMediaSource and
            // _currentItem. This prevents race conditions where the 'chaptersloaded'
            // event triggers an OSD render that tries to read duration from a
            // null media source.
            // ================================================================
            const isAudioItemForChapters = this._currentItem?.MediaType === 'Audio' ||
                this._currentItem?.Type === 'AudioBook';

            let chapters = [];
            if (!isAudioItemForChapters) {
                chapters = this._currentItem?.Chapters || [];

                if (chapters.length > 0) {
                    log.info('Using chapters from item object:', chapters.length);
                } else if (playbackInfo.Chapters && playbackInfo.Chapters.length > 0) {
                    chapters = playbackInfo.Chapters;
                    log.info('Using chapters from PlaybackInfo:', chapters.length);
                } else {
                    log.info('Chapters missing. Fetching item details...');
                    try {
                        const itemDetails = await api.getItem(options.itemId, { Fields: 'Chapters,Trickplay,RunTimeTicks' });
                        if (itemDetails?.Chapters) {
                            chapters = itemDetails.Chapters;
                            log.info('Chapters fetched from API:', chapters.length);
                        }
                        // Back-fill RunTimeTicks if missing
                        if (itemDetails?.RunTimeTicks && !this._currentItem.RunTimeTicks) {
                            this._currentItem.RunTimeTicks = itemDetails.RunTimeTicks;
                        }
                    } catch (e) {
                        log.warn('Failed to fetch item details for chapters:', e);
                    }
                    if (isSuperseded()) return abandon('chapters');
                }
            }

            this._chapters = chapters;
            this.emit('chaptersloaded', { chapters: this._chapters });

            // ================================================================
            // Duration Resolution — back-fill from item metadata
            //
            // Jellyfin's PlaybackInfo often omits RunTimeTicks on the
            // MediaSource for transcoded HLS streams, even though the item's
            // own API response carries it. We copy it over here so that
            // getDurationTicks() can find it without needing a second API call.
            //
            // If BOTH sources lack RunTimeTicks (server has genuinely never
            // scanned/stored duration for this file), we fall through. In that
            // case getDurationTicks() will try to read the HLS.js manifest
            // duration once the transcoder finishes encoding, then fall back to
            // the growing backend value as a last resort.
            // ================================================================
            if (!this._currentMediaSource.RunTimeTicks && this._currentItem?.RunTimeTicks) {
                log.info(`[Duration] Back-filling RunTimeTicks from item metadata: ${this._currentItem.RunTimeTicks} ticks`);
                this._currentMediaSource.RunTimeTicks = this._currentItem.RunTimeTicks;
            }

            if (!this._currentMediaSource.RunTimeTicks) {
                log.warn('[Duration] MediaSource and item both lack RunTimeTicks — will rely on HLS manifest or backend duration');
            }

            // Set up the SubtitleManager with the current media context
            // This tells it what item/source we're playing and what backend we're using
            const backend = this._backend || this._videoPlayer;
            this._subtitleManager.setMediaContext({
                itemId: options.itemId,
                mediaSourceId: mediaSource.Id,
                mediaStreams: mediaSource.MediaStreams || [],
                mediaAttachments: mediaSource.MediaAttachments || [],
                // Use the resolved _backendType string so SubtitleManager knows
                // whether it should attempt embedded-native subtitle routing
                // (Tizen only) or always defer to external text/ASS/PGS paths.
                backendType: this._backendType,
                videoElement: (backend && backend.getVideoElement) ? backend.getVideoElement() : null,
                playMethod: this._currentPlayMethod,
                isHdr: this.isCurrentMediaHDR()
            });

            // Initialize current stream indices from options
            this._currentAudioStreamIndex = options.audioStreamIndex;
            this._currentSubtitleStreamIndex = options.subtitleStreamIndex;
            if (options.secondarySubtitleStreamIndex !== undefined) {
                // Preserve secondary subtitle index if supplied in restart options
                this._currentSecondarySubtitleStreamIndex = options.secondarySubtitleStreamIndex;
            }

            // If not provided, resolve best DirectPlay audio track from MediaSource
            if (this._currentAudioStreamIndex === undefined && mediaSource.MediaStreams) {
                const bestStream = resolveBestAudioStream(mediaSource, null, this._backendType);
                if (bestStream) {
                    this._currentAudioStreamIndex = bestStream.Index;
                } else {
                    const audioStream =
                        mediaSource.MediaStreams.find((s) => s.Type === 'Audio' && s.IsDefault) ||
                        mediaSource.MediaStreams.find((s) => s.Type === 'Audio');
                    if (audioStream) this._currentAudioStreamIndex = audioStream.Index;
                }
            }

            // If not provided (and not resolved pre-flight), resolve target subtitle track
            // based on the user's active Subtitle Mode preference (Default, OnlyForced, Always, Smart, None)
            if (this._currentSubtitleStreamIndex === undefined) {
                if (mediaSource.MediaStreams) {
                    this._currentSubtitleStreamIndex = resolveSubtitleStream(mediaSource, {
                        audioStreamIndex: this._currentAudioStreamIndex
                    });
                } else {
                    this._currentSubtitleStreamIndex = -1;
                }
            }

            // -------------------------------------------------------------------------
            // Start Position & Resume Offset Handling
            // -------------------------------------------------------------------------
            // We pass the intended startPositionTicks directly to MediaHelper.buildStreamUrl.
            // In HLS streaming (whether Transcode, DirectStream, or Remux), the server's HLS playlist
            // covers the entire media timeline from 0s. The player backend (Hls.js, webOS native,
            // or Tizen AVPlay) directly seeks to playerStartPositionTicks.
            //
            // MediaHelper handles timeline mapping cleanly:
            //   - HLS (Transcode / DirectStream / Remux / DirectPlay):
            //       transcodingOffsetTicks = 0, playerStartPositionTicks = startPositionTicks
            //   - Progressive Transcode (!isHls):
            //       transcodingOffsetTicks = startPositionTicks, playerStartPositionTicks = 0
            // -------------------------------------------------------------------------
            const originalStartPositionTicks = options.startPositionTicks || 0;
            const effectiveStartPositionTicks = originalStartPositionTicks;

            // Save the intended start position for the UI before the backend initializes.
            this._pendingStartPositionTicks = originalStartPositionTicks > 0 ? originalStartPositionTicks : null;
            this._clearResumeAdvanceWait();

            if (this._pendingStartPositionTicks) {
                // For native client-side seeking, start the 15-second wall-clock timeout immediately
                this._resumeWaitStartTime = Date.now();
            }

            // Build stream URL
            const streamInfo = MediaHelper.buildStreamUrl({
                serverUrl: this.serverUrl,
                itemId: options.itemId,
                mediaSource,
                startPositionTicks: effectiveStartPositionTicks,
                playSessionId: playbackInfo.PlaySessionId,
                authToken: this.authToken,
                deviceProfile: deviceProfile,
                backendType: this._backendType,
                // Pass audioStreamIndex so it's included in manually-built fallback URLs.
                // When TranscodingUrl is present (the normal case), the server already
                // has this baked in and this param is unused.
                audioStreamIndex: this._currentAudioStreamIndex
            });

            //log.debug('Stream Info built:', streamInfo);

            // Save transcoding offset
            this._transcodingOffsetTicks = streamInfo.transcodingOffsetTicks || 0;
            if (this._transcodingOffsetTicks > 0) {
                log.info('Transcoding offset:', this._transcodingOffsetTicks);
            }

            // Start playback on backend
            log.info('Initializing backend playback...');

            /*
             * =========================================================================
             * Reverse Proxy Custom Authentication Headers Injection
             * =========================================================================
             * Native media decoders (such as ExoPlayer on Android or Tizen AVPlay)
             * execute their bitstream HTTP requests outside Chromium's standard
             * fetch() / XHR pipeline.
             *
             * When the Jellyfin instance sits behind reverse proxies with Zero Trust
             * access control (e.g. Cloudflare Access service tokens, Authentik,
             * Authelia, or Cloudflare Tunnel), unauthenticated requests to
             * /Videos/.../stream.* receive an HTML error or redirect page. ExoPlayer
             * then fails with UNRECOGNIZED_INPUT_FORMAT (sniff failures).
             *
             * We query the CustomHeadersManager for all credentials associated with
             * this server URL and attach them directly to backendOptions so native
             * platform bridges can set DefaultRequestProperties on their HTTP data source.
             * =========================================================================
             */
            const targetServerUrl = this.serverUrl || (typeof api !== 'undefined' ? api?.serverUrl : null) || (typeof customHeaders !== 'undefined' ? customHeaders?._activeServerUrl : null);
            const streamHeaders = (typeof customHeaders !== 'undefined' && customHeaders && typeof customHeaders.getHeadersForUrl === 'function')
                ? customHeaders.getHeadersForUrl(streamInfo.url, targetServerUrl)
                : {};

            const streamHeaderCount = streamHeaders ? Object.keys(streamHeaders).length : 0;
            if (streamHeaderCount > 0) {
                log.info(`[JellyfinPlayer] Attaching ${streamHeaderCount} custom reverse proxy header(s) to backend stream options`);
            }

            const backendOptions = {
                ...streamInfo,
                headers: streamHeaders,
                item: this._currentItem,
                mediaSource,
                startPositionTicks: streamInfo.playerStartPositionTicks, // Use adjusted start position
                audioStreamIndex: this._currentAudioStreamIndex,
                audioTrackListIndex: this._getBackendAudioTrackListIndex(this._currentAudioStreamIndex, mediaSource),
                subtitleStreamIndex: this._currentSubtitleStreamIndex,
                // Tell the backend what play method was negotiated — critical so
                // TizenAVPlayer knows NOT to apply native track selection when
                // the server is transcoding (audio is baked into the HLS stream).
                playMethod: playMethod,
                autoPlay: options.autoPlay
            };

            /*
             * -------------------------------------------------------------------------
             * Pre-flight Subtitle Awaiting
             * -------------------------------------------------------------------------
             * If the user opted into the 'awaitTracksBeforePlayback' setting, we block
             * and fully download/parse the subtitle cues (e.g. SRT, VTT, ASS canvas fonts,
             * or PGS bitmaps) BEFORE starting the native player decoder. This completely
             * eliminates the visual subtitle flash/pop-in effect on TV displays.
             * -------------------------------------------------------------------------
             */
            const isAudioItemSetup = options.item?.MediaType === 'Audio' ||
                options.item?.Type === 'AudioBook';

            const awaitTracks = PlayerSettings.get('awaitTracksBeforePlayback');

            if (awaitTracks && !isAudioItemSetup && this._currentSubtitleStreamIndex !== undefined && this._currentSubtitleStreamIndex !== -1) {
                log.info('[Play-Flow] Awaiting subtitle track setup pre-flight...');
                this._playSetupInProgress = true;

                let preFlightTimeoutId = null;
                try {
                    /*
                     * -----------------------------------------------------------------
                     * Pre-Flight Safety Timeout (Vanguard Strategy)
                     * -----------------------------------------------------------------
                     * We wrap the pre-flight subtitle setup in a Promise.race. If
                     * subtitle extraction on the server takes a long time (e.g. OCR)
                     * or font downloading hangs, we bypass the gate after 15 seconds.
                     *
                     * This prevents TV UI deadlocks, letting the subtitle load in
                     * the background asynchronously.
                     * -----------------------------------------------------------------
                     */
                    const subtitlePromise = this.setSubtitleStreamIndex(this._currentSubtitleStreamIndex);

                    const timeoutPromise = new Promise((_, reject) => {
                        preFlightTimeoutId = setTimeout(() => {
                            reject(new Error('Pre-flight subtitle loading timed out (15s threshold exceeded)'));
                        }, 15000);
                    });

                    await Promise.race([subtitlePromise, timeoutPromise]);
                    log.info('[Play-Flow] Pre-flight subtitle setup completed successfully');
                } catch (err) {
                    log.warn('[Play-Flow] Pre-flight initial subtitle setup failed or timed out:', err.message || err);
                } finally {
                    if (preFlightTimeoutId) {
                        clearTimeout(preFlightTimeoutId);
                    }
                    this._playSetupInProgress = false;
                }
                if (isSuperseded()) return abandon('subtitle pre-flight');

                /*
                 * -----------------------------------------------------------------
                 * Secondary Subtitle Re-application (awaitTracks path)
                 * -----------------------------------------------------------------
                 * setMediaContext() clears all SubtitleManager state — including
                 * the secondary track and its cue list — as it sets up a fresh
                 * session. After the primary subtitle is loaded we must explicitly
                 * re-fetch and re-apply the secondary track so it is not lost
                 * across remux/restart events (e.g. audio track switches).
                 *
                 * We call _subtitleManager.setSecondaryTrack() directly rather than
                 * setSecondarySubtitleStreamIndex() to bypass the equality guard —
                 * that guard blocks re-fetching when the index hasn't changed, but
                 * the cue list has been wiped by setMediaContext() and MUST be
                 * re-loaded regardless.
                 *
                 * Fire-and-forget secondary loading since its delay does not
                 * affect video decode or initial frame display.
                 * -----------------------------------------------------------------
                 */
                if (this._currentSecondarySubtitleStreamIndex !== undefined &&
                    this._currentSecondarySubtitleStreamIndex !== null &&
                    this._currentSecondarySubtitleStreamIndex !== -1) {
                    log.info('[Play-Flow] Re-applying secondary subtitle after session restart:', this._currentSecondarySubtitleStreamIndex);
                    this._subtitleManager.setSecondaryTrack(this._currentSecondarySubtitleStreamIndex)
                        .catch(err => log.warn('[Play-Flow] Secondary subtitle re-application failed:', err));
                }
            }

            // ====================================================================
            // Temporary OSD and Playback Audio Debugging Logs
            // ====================================================================
            log.info('[AudioDebug] JellyfinPlayer.play:');
            log.info('  - options.audioStreamIndex:', options.audioStreamIndex);
            log.info('  - this._currentAudioStreamIndex:', this._currentAudioStreamIndex);
            log.info('  - playMethod:', playMethod);
            log.info('  - audioTrackListIndex:', backendOptions.audioTrackListIndex);
            log.info('  - mediaSource.DefaultAudioStreamIndex:', mediaSource.DefaultAudioStreamIndex);
            if (mediaSource.MediaStreams) {
                log.info('  - Jellyfin Audio Streams:');
                mediaSource.MediaStreams.filter(s => s.Type === 'Audio').forEach(s => {
                    log.info(`    * Index: ${s.Index}, Language: ${s.Language}, Codec: ${s.Codec}, IsDefault: ${s.IsDefault}`);
                });
            }

            // Instruct the resolved backend (TizenAVPlayer, WebOSPlayer, or HTML5) to initialize
            try {
                await this._backend.play(backendOptions);
            } catch (backendErr) {
                // ------------------------------------------------------------------
                // Superseded load: stop() or a newer play() ended this backend session
                // before it started. This request is over: resolve false so callers do
                // not report playback start, arm watchdogs or escalate it (or, when a
                // restart replaced it, with that restart's outcome).
                // (A DOM AbortError from an interrupted video.play() is not a cancel of
                // the request; it goes on to the catch below as before.)
                // ------------------------------------------------------------------
                if (backendErr?.superseded) {
                    log.info('Backend play() was superseded by stop() or a newer request — abandoning this play() call');
                    return abandon('superseded backend load');
                }
                backendLoadFailed = true;
                throw backendErr;
            }
            // Backends without load sessions (Tizen AVPlay) resolve even after stop()
            if (isSuperseded()) return abandon('backend play()');
            log.info('Backend play() promise resolved');

            // A restart recreates the video element, so re-apply speed and aspect ratio
            if (this._playbackSpeed && this._playbackSpeed !== 1) {
                try {
                    this._backend.setSpeed(this._playbackSpeed);
                } catch (e) {
                    log.warn('Failed to restore playback speed:', e);
                }
            }
            if (this._currentAspectRatio && this._currentAspectRatio !== 'auto') {
                try {
                    this._backend.setAspectRatio(this._currentAspectRatio);
                } catch (e) {
                    log.warn('Failed to restore aspect ratio:', e);
                }
            }

            this._isPlaying = true;
            this._isPaused = options.autoPlay === false;

            // -----------------------------------------------------------------
            // DirectStream / Remux Startup Stuck Watchdog:
            // When resuming media in DirectStream or Remux mode, FFmpeg stream-copies
            // the video bitstream starting mid-GOP without inserting a clean IDR keyframe.
            // On both hardware decoders (webOS/Tizen) and browser MSE (HtmlVideoPlayer/Hls.js),
            // this can freeze the decoder or fail segment decoding.
            // Arm the stuck watchdog (8s window) so if playback does not advance forward,
            // we automatically escalate to full transcode.
            // -----------------------------------------------------------------
            if ((this._currentPlayMethod === 'DirectStream' || this._currentPlayMethod === 'Remux' || this._playbackMode === 'remux') &&
                effectiveStartPositionTicks > 0) {
                this._armRemuxStuckWatchdog(effectiveStartPositionTicks);
            }

            this.emit(PlayerEvent.PLAYBACK_START, {
                item: this._currentItem,
                mediaSource
            });

            /*
             * -------------------------------------------------------------------------
             * Standard Asynchronous Subtitle Setup
             * -------------------------------------------------------------------------
             * If the awaitTracks option is disabled, we restore the original behavior:
             * start decoding instantly and load subtitles in the background asynchronously.
             * -------------------------------------------------------------------------
             */
            if (!awaitTracks && !isAudioItemSetup && this._currentSubtitleStreamIndex !== undefined && this._currentSubtitleStreamIndex !== -1) {
                // Initialize the SubtitleManager with the selected subtitle track.
                // The subtitle index is already included in the server request, so
                // this call only needs to set up CLIENT-SIDE rendering.
                this._playSetupInProgress = true;
                // Fire-and-forget — don't block playback on subtitle fetch
                this.setSubtitleStreamIndex(this._currentSubtitleStreamIndex)
                    .catch((err) => log.warn('Initial subtitle setup failed:', err))
                    .finally(() => { this._playSetupInProgress = false; });
            }

            /*
             * -------------------------------------------------------------------------
             * Secondary Subtitle Re-application (standard async path)
             * -------------------------------------------------------------------------
             * This mirrors the awaitTracks path above. setMediaContext() resets
             * SubtitleManager's secondary state on every new play() call, including
             * playback restarts triggered by audio track switches that force a remux.
             *
             * We call _subtitleManager.setSecondaryTrack() directly to bypass the
             * equality guard in setSecondarySubtitleStreamIndex(), which would
             * otherwise skip re-loading when the same index is passed again after
             * the cue list has been cleared by setMediaContext().
             *
             * Fire-and-forget; secondary cues arriving slightly late is acceptable
             * since they are a supplemental overlay over the primary subtitle.
             * -------------------------------------------------------------------------
             */
            if (!awaitTracks &&
                !isAudioItemSetup &&
                this._currentSecondarySubtitleStreamIndex !== undefined &&
                this._currentSecondarySubtitleStreamIndex !== null &&
                this._currentSecondarySubtitleStreamIndex !== -1) {
                log.info('[Play-Flow] Re-applying secondary subtitle after session restart:', this._currentSecondarySubtitleStreamIndex);
                this._subtitleManager.setSecondaryTrack(this._currentSecondarySubtitleStreamIndex)
                    .catch(err => log.warn('[Play-Flow] Secondary subtitle re-application failed:', err));
            }
            return true;
        } catch (error) {
            // A replaced request has nothing left to report or escalate: its
            // failure (a timed-out PlaybackInfo after Back, a destroyed
            // backend) belongs to playback the user already left.
            if (isSuperseded()) return abandon(`failure: ${error?.message || error}`);

            // =================================================================
            // Suppress False-Positive Interruption Errors During Session Restart
            // =================================================================
            // When an internal playback restart is triggered (e.g. quality switch,
            // remux track fallback, or backend reload), the previous in-flight
            // play() promise on the HTML5 video element is aborted by Chromium
            // with 'The play() request was interrupted by a new load request'.
            // Because a fresh play session is already in progress, emitting
            // PlayerEvent.ERROR causes PlayerPage to display an intrusive error modal
            // over a successfully starting stream. Suppress this transient abort.
            // =================================================================
            const isInterrupted =
                error?.message?.includes('interrupted by a new load request') ||
                error?.name === 'AbortError';

            // -----------------------------------------------------------------
            // Only the interruption itself is swallowed. Real failures are
            // reported even while a restart is in progress: the restart flows
            // await play() and the page shows a spinner on RESTARTING, so a
            // swallowed failure left that spinner up forever with no error.
            // -----------------------------------------------------------------
            if (isInterrupted) {
                log.warn(
                    'Playback play() promise interrupted during restart/reload — suppressing error modal:',
                    error?.message || error
                );
                // Not a cancel: this is still the current request (see isSuperseded above)
                return true;
            }

            // ────────────────────────────────────────────────────────────────
            // Smart Backend Fallback: Movi / ExoPlayer → HTML5 Video Player
            // ────────────────────────────────────────────────────────────────
            // If the active backend is 'movi' or 'exoplayer' and fails during play
            // (e.g. backend not included in the build, stubbed out on TV targets,
            // native bridge missing, or WebCodecs/WASM initialization threw),
            // transparently fall back to HtmlVideoPlayer instead of getting stuck
            // in an error loop or hanging indefinitely.
            // ────────────────────────────────────────────────────────────────
            if (
                (this._backendType === 'movi' || this._backendType === 'exoplayer') &&
                !options._backendFallbackAttempted
            ) {
                const failedBackend = this._backendType;
                log.warn(
                    `[BackendFallback] Backend '${failedBackend}' failed to start playback (${error?.message || error}). ` +
                    'Switching to HTML5 video backend and restarting...'
                );

                // Safely stop and destroy the failed backend
                try {
                    await this._backend?.stop();
                    if (typeof this._backend?.destroy === 'function') {
                        this._backend.destroy();
                    }
                } catch (tearDownErr) {
                    log.warn(`[BackendFallback] Clean stop failed for ${failedBackend}:`, tearDownErr);
                }
                if (isSuperseded()) return abandon('backend fallback');

                // Switch to HTML5 player
                this._backendType = 'html5';
                this._backend = new HtmlVideoPlayer({
                    container: this.container,
                    settings: PlayerSettings,
                    onEvent: this._handleBackendEvent.bind(this)
                });

                // Build a compliant HTML5 device profile
                const html5Profile = buildJellyfinProfile({
                    manualBitrate: this._manualBitrate,
                    playbackMode: this._playbackMode,
                    backend: 'html5'
                });

                // Re-attempt playback on HTML5 backend
                return this.play({
                    ...options,
                    _backendFallbackAttempted: true,
                    _deviceProfile: html5Profile
                });
            }

            // ────────────────────────────────────────────────────────────────
            // DirectPlay Launch Failure Escalation (Synchronous / Pipeline Rejection)
            // ────────────────────────────────────────────────────────────────
            // If the initial backend preparation or media pipeline setup rejected
            // during DirectPlay or Remux, immediately attempt server transcode before
            // surfacing a fatal error. Not when the server sent nothing at all
            // (stalled or unreachable): a transcode request would only add another
            // timeout before the error shows. Not for a failure before the load
            // either (PlaybackInfo timed out or answered with an error): the
            // transcode would start with another PlaybackInfo request.
            // ────────────────────────────────────────────────────────────────
            const isAutoTranscodeEnabled = PlayerSettings.get('autoTranscodeOnError') !== false;
            const canEscalate =
                isAutoTranscodeEnabled &&
                backendLoadFailed &&
                !error?.isNetworkError &&
                !this._isRestarting &&
                !this._directPlayEscalated &&
                this._currentPlayOptions &&
                // A forced remux copies the video even when labelled 'Transcode'
                (this._currentPlayMethod !== 'Transcode' || this._playbackMode === 'remux') &&
                this._playbackMode !== 'transcode';

            if (canEscalate) {
                this._directPlayEscalated = true;
                log.warn(
                    `[JellyfinPlayer] DirectPlay setup failed (${error?.message || error}). ` +
                    `Escalating session to server transcoding...`
                );

                const currentTicks = this.getCurrentPositionTicks() || this._currentPlayOptions.startPositionTicks || 0;
                const restartOptions = {
                    ...this._currentPlayOptions,
                    audioStreamIndex: this._currentAudioStreamIndex,
                    subtitleStreamIndex: this._currentSubtitleStreamIndex,
                    secondarySubtitleStreamIndex: this._currentSecondarySubtitleStreamIndex,
                    startPositionTicks: currentTicks,
                    playbackMode: 'transcode'
                };

                this._currentPlayOptions = restartOptions;
                this._lastPlayOptions = restartOptions;
                this._isRestarting = true;
                this._restartOwner = restartOptions;

                this.emit(PlayerEvent.RESTARTING);

                try {
                    await this.stop({ restart: true });
                    // The escalation's outcome is this request's: false when Back or
                    // a newer play() cancelled it, so the caller does not report a start
                    return await this._playAfterRestartPause(restartOptions, 500);
                } catch (escalateErr) {
                    log.error('[JellyfinPlayer] DirectPlay setup transcode escalation failed:', escalateErr);
                    if (escalateErr !== this._lastReportedPlayError) {
                        this._lastReportedPlayError = escalateErr;
                        this.emit(PlayerEvent.ERROR, { error: escalateErr, type: 'playback' });
                    }
                    throw escalateErr;
                } finally {
                    // Unless a newer restart has taken over meanwhile
                    if (this._restartOwner === restartOptions) {
                        this._isRestarting = false;
                    }
                }
            }

            log.error('Playback error caught:', error);
            // Remembered so restart flows awaiting this play() don't report it twice
            this._lastReportedPlayError = error;
            this.emit(PlayerEvent.ERROR, { error, type: 'playback' });
            throw error;
        }
    }

    /**
     * Pause playback
     */
    pause() {
        /*
         * Cancel any queued post-seek playback resume so that an explicit pause
         * command issued during or immediately after a seek reliably halts playback.
         */
        this._pendingPlayAfterSeek = false;

        this._backend?.pause();
        // State update and event emission handled by _handleBackendEvent
    }

    /**
     * Resume playback
     */
    unpause() {
        /*
         * ====================================================================
         * ACTIVE SEEK RESUME GATE
         * ====================================================================
         * If the player or underlying hardware backend is currently seeking,
         * calling unpause() immediately instructs the audio/video decoder to
         * start playback at the PRE-SEEK position while the demuxer buffers the
         * target frames. This causes 1-3 seconds of ghost playback at the old
         * position before jumping to the seeked point.
         *
         * To eliminate this ghost playback, queue the unpause request and allow
         * it to execute once the hardware fires the authoritative 'seeked' event.
         *
         * The webOS and HTML5 backends queue it themselves, and start playback
         * when 'seeked' does not come: webOS completes a seek on a paused
         * element only once playback starts, so waiting here (up to the 5 s
         * failsafe) only held the picture frozen after every scrub.
         * ====================================================================
         */
        if (this.isSeeking && !this.queuesPostSeekPlay) {
            log.info('[JellyfinPlayer] unpause() requested while seek in flight — queueing play for post-seek landing');
            this._pendingPlayAfterSeek = true;
            return;
        }

        // Cancel any stale queued play state now that we are executing
        this._pendingPlayAfterSeek = false;

        // Immediately mark state as unpaused so togglePlay and UI stay in sync
        this._isPaused = false;
        this._subtitleManager?.play();

        // Notify listeners that playback has been resumed
        this.emit(PlayerEvent.PLAY);

        // Instruct active hardware backend to unpause
        this._backend?.unpause();
    }

    /**
     * Toggle play/pause
     */
    togglePlay() {
        if (this._isPaused || this._pendingPlayAfterSeek) {
            this.unpause();
        } else {
            this.pause();
        }
    }

    /**
     * Stop playback
     * @param {Object} [options]
     * @param {boolean} [options.restart] - The restart flow's own stop(): the item, its
     *   quality and speed stay for the session the restart starts, and no STOP events
     *   are sent. Any other stop() (Back, next item, destroy) resets them and also ends
     *   a restart that is still pending or loading.
     */
    async stop(options = {}) {
        const isRestartStop = Boolean(options.restart);
        if (!isRestartStop) {
            this._isRestarting = false;
            this._audioRestartInProgress = false;
            this._burnInRestartInProgress = false;
            this._restartOwner = null;
        }

        // Ends any play() request still loading (see play())
        const replacedRequest = this._playRequestId || 0;
        this._playRequestId = replacedRequest + 1;
        this._clearResumeAdvanceWait();

        // --------------------------------------------------------------------
        // Restart handover: a play() request that a restart's own stop()
        // replaces while it loads resolves with that restart instead of as
        // cancelled. _playAfterRestartPause() settles the handover with the
        // restart's play(). A stop() or play() that comes before it settles
        // the handover with false (Back, next item), or a restart's stop()
        // with the restart that replaces this one.
        // --------------------------------------------------------------------
        const pendingHandover = this._restartHandover;
        this._restartHandover = null;
        if (isRestartStop) {
            let settle;
            const promise = new Promise((resolve) => {
                settle = resolve;
            });
            // The restart's play() reports its own failure; only a replaced request awaits this
            promise.catch(() => {});
            this._restartHandover = { request: this._playRequestId, promise, settle };
            if (this._latestPlay && this._latestPlay.request === replacedRequest) {
                this._latestPlay.restart = promise;
            }
        }
        if (pendingHandover) {
            pendingHandover.settle(this._restartHandover ? this._restartHandover.promise : false);
        }

        const item = this._currentItem;
        const positionTicks = this.getCurrentPositionTicks();

        if (this._backend) {
            await this._backend.stop();
        }

        // Only clear state if NOT restarting
        if (!isRestartStop) {
            this._pendingStartPositionTicks = null;
            this._clearRemuxStuckWatchdog();
            this._currentItem = null;
            this._currentMediaSource = null;
            this._currentPlayOptions = null;
            this._directPlayEscalated = false;
        }

        this._isPlaying = false;
        this._isPaused = false;
        this._isSeeking = false;
        this._pendingPlayAfterSeek = false;
        const clearTimer = typeof clearTimeout !== 'undefined'
            ? clearTimeout
            : (typeof globalThis !== 'undefined' ? globalThis.clearTimeout : null);
        if (clearTimer && this._seekFailsafeTimeout) {
            clearTimer(this._seekFailsafeTimeout);
            this._seekFailsafeTimeout = null;
        }

        // Only emit stop events if we are NOT restarting
        if (!isRestartStop) {
            this._manualBitrate = null;
            this._transcodingOffsetTicks = 0;
            this._playbackSpeed = 1; // Reset speed on stop
            this.emit(PlayerEvent.STOP);
            this.emit(PlayerEvent.PLAYBACK_STOP, { item, positionTicks });
        } else {
            log.info('Suppressing STOP events due to restart');
        }
    }

    /**
     * Seek to position
     * @param {number} positionTicks - Position in ticks (1 tick = 100 nanoseconds)
     * @param {Object} [options] - Additional options
     * @param {boolean} [options.suppressWaitingEvent] - Don't emit 'waiting' during this seek's buffer phase
     */
    seek(positionTicks, options = {}) {
        // High-Priority State Update: Indicate that seeking is actively occurring
        this._isSeeking = true;
        this._seekTargetTicks = positionTicks;
        this._seekStartedAt = Date.now();

        // Failsafe seeking timer: If neither SEEKED nor PLAYING fires within 5 seconds
        // (e.g. edge-case decoder stalls on some TV firmware), ensure _isSeeking resets.
        const clearTimer = typeof clearTimeout !== 'undefined'
            ? clearTimeout
            : (typeof globalThis !== 'undefined' ? globalThis.clearTimeout : null);
        if (clearTimer && this._seekFailsafeTimeout) {
            clearTimer(this._seekFailsafeTimeout);
            this._seekFailsafeTimeout = null;
        }
        const setTimer = typeof setTimeout !== 'undefined'
            ? setTimeout
            : (typeof globalThis !== 'undefined' ? globalThis.setTimeout : null);
        if (setTimer) {
            this._seekFailsafeTimeout = setTimer(() => {
                log.warn('[JellyfinPlayer] Seek failsafe timeout (5s) fired — resetting isSeeking');
                this._isSeeking = false;
                this._seekFailsafeTimeout = null;
                // Dispatch any queued play that was waiting for seek completion
                if (this._pendingPlayAfterSeek) {
                    log.info('[JellyfinPlayer] Releasing deferred play upon seek failsafe timer expiry');
                    this._pendingPlayAfterSeek = false;
                    this.unpause();
                }
            }, 5000);
        }

        // INSTANT SUBTITLE WIPE:
        // Clear all active subtitles instantly when seeking. This prevents the currently
        // displayed cue from lingering as a ghost overlay during the buffering/loading phase
        // of a seek operation (whether scrubbing, chapter skips, or direct d-pad seeks).
        if (this._subtitleManager) {
            // Fancy explanation: reset active state caches and flush any DOM / canvas subtitle layers
            this._subtitleManager.resetActiveCues();
        }

        // Delegate the core seek execution to our underlying player backend (AVPlay, HTML5, WebOS)
        this._backend?.seek(positionTicks, options);

        // Notify all registered UI/OSD event listeners that seek has successfully fired
        this.emit('seek', { positionTicks });
    }

    /**
     * Seek relative to current position
     * @param {number} offsetMs - Offset in milliseconds (positive = forward)
     */
    seekRelative(offsetMs) {
        const currentMs = this.getCurrentPositionMs();
        const newMs = Math.max(0, currentMs + offsetMs);
        this.seek(newMs * 10000); // Convert ms to ticks
    }

    // ========================================================================
    // Volume Control
    // ========================================================================

    /**
     * Set volume
     * @param {number} volume - Volume level (0-100)
     */
    setVolume(volume) {
        this._backend?.setVolume(volume);
        this.emit(PlayerEvent.VOLUME_CHANGE, { volume });
    }

    /**
     * Get current volume
     * @returns {number} Volume level (0-100)
     */
    getVolume() {
        return this._backend?.getVolume() ?? 100;
    }

    /**
     * Toggle mute
     */
    toggleMute() {
        this._backend?.toggleMute();
    }

    /**
     * Set mute state explicitly.
     * Called by PlayerPage when a remote Mute / Unmute command arrives via WebSocket.
     * Delegates to the backend player (HtmlVideoPlayer.setMuted or TizenAVPlayer).
     * @param {boolean} muted
     */
    setMuted(muted) {
        if (this._backend?.setMuted) {
            this._backend.setMuted(muted);
        } else {
            // Fallback: backend may only expose toggleMute — use isMuted to decide
            if (Boolean(muted) !== this.isMuted()) {
                this._backend?.toggleMute?.();
            }
        }
        this.emit(PlayerEvent.VOLUME_CHANGE, { volume: this.getVolume() });
    }

    /**
     * Check if muted
     * @returns {boolean}
     */
    isMuted() {
        return (typeof this._backend?.isMuted === 'function') ? this._backend.isMuted() : false;
    }

    // ========================================================================
    // Track Selection
    // ========================================================================

    /**
     * Set audio track.
     *
     * During DirectPlay, the backend can switch tracks natively.
     * During Transcode/DirectStream (server re-encodes the video), the audio
     * channel is baked into the server's output stream. Changing it requires
     * a full retranscode restart with the new AudioStreamIndex, exactly like
     * switching subtitle tracks in burn-in mode.
     *
     * @param {number} index - Audio stream index (Jellyfin ID)
     */
    async setAudioStreamIndex(index) {
        // ====================================================================
        // Prewarm Cache Invalidation
        // ====================================================================
        // When the user changes the audio track inside the player, any prewarmed
        // cache in PrewarmManager holds stale metadata reflecting previous or
        // default audio tracks. Invalidate the cache immediately so that subsequent
        // launches re-query fresh metadata and correctly remember the updated track.
        // ====================================================================
        if (this._currentAudioStreamIndex !== index) {
            log.info(`[Prewarm] Invalidating prewarm cache due to audio stream change (${this._currentAudioStreamIndex} -> ${index})`);
            prewarmManager.invalidateCache();
        }

        this._currentAudioStreamIndex = index;

        // =====================================================================
        // Play Options Synchronization (Audio Track)
        // =====================================================================
        // Persist the updated audio index into active play options immediately.
        // This ensures that any subsequent playback restart (e.g. subtitle burn-in
        // transition, transcode escalation, or bitrate adjustments) carries this
        // track forward rather than reverting to the container's default stream.
        // =====================================================================
        if (this._currentPlayOptions) {
            this._currentPlayOptions.audioStreamIndex = index;
        }
        if (this._lastPlayOptions) {
            this._lastPlayOptions.audioStreamIndex = index;
        }

        // Determine if target track codec is natively supported by current hardware backend
        let isTargetCodecSupported = true;
        if (this._backendType === 'tizen' || this._backendType === 'webos' || this._backendType === 'html5') {
            const AudioTracks = this.getAudioTracks();
            const targetTrack = AudioTracks.find(t => t.Index === index);

            if (targetTrack) {
                isTargetCodecSupported = isAudioTrackNativelyPlayable(targetTrack, this._currentMediaSource, this._backendType);
            }
        }

        const supportsNativeAudio = this._backend && typeof this._backend.supportsNativeAudioTracks === 'function' && this._backend.supportsNativeAudioTracks();

        // ────────────────────────────────────────────────────────────────────
        // Transcode and Remux Stream Switching State
        // ────────────────────────────────────────────────────────────────────
        // During Transcode, DirectStream, and Remux playback methods, the
        // server-side HLS/progressive packaging only outputs a single audio
        // stream (the requested index) to the TV. Because the other audio
        // tracks are not muxed in the current playing stream, we cannot perform
        // native track switching on the client side. A playback restart is
        // required to request the new track stream index from the server.
        // ────────────────────────────────────────────────────────────────────
        const isTranscoding = this._currentPlayMethod === 'Transcode' ||
            this._currentPlayMethod === 'DirectStream' ||
            this._currentPlayMethod === 'Remux';
        const requiresRestart = isTranscoding || !isTargetCodecSupported || (this._backendType !== 'tizen' && this._backendType !== 'movi' && this._backendType !== 'exoplayer' && !supportsNativeAudio);

        log.info(`setAudioStreamIndex: index=${index} playMethod=${this._currentPlayMethod} requiresRestart=${requiresRestart} isTargetCodecSupported=${isTargetCodecSupported}`);

        if (requiresRestart && this._currentPlayOptions && !this._audioRestartInProgress) {
            log.info(`Restarting playback for audio track: ${index} (method: ${this._currentPlayMethod ?? 'DirectPlay/HTML5'})`);

            const currentTicks = this.getCurrentPositionTicks();

            // ────────────────────────────────────────────────────────────────
            // Determine if the requested audio track requires server remuxing
            // ────────────────────────────────────────────────────────────────
            // In progressive DirectPlay (HTML5 / Chromium), the native media
            // element cannot switch audio tracks in a multi-audio container and
            // always decodes the container's physical default / first audio stream.
            //
            // If the user requests that physical default / first track, DirectPlay
            // works natively without server remuxing.
            //
            // NOTE: We deliberately do NOT compare against ms.DefaultAudioStreamIndex
            // because Jellyfin dynamically overwrites DefaultAudioStreamIndex with
            // whatever track was requested in the previous PlaybackInfo call!
            // ────────────────────────────────────────────────────────────────
            let isCustomAudioTrack = false;
            let isFirstAudioTrack = true;
            let trackRequiresDirectStream = false;

            if (this._currentItem && this._currentItem.MediaSources) {
                const msId = this._currentPlayOptions?.mediaSourceId;
                const fallbackSource = this._currentItem.MediaSources[0];
                const ms = this._currentItem.MediaSources.find(m => m.Id === msId) || fallbackSource;

                if (ms && Array.isArray(ms.MediaStreams)) {
                    const audioStreams = ms.MediaStreams.filter(s => s.Type === 'Audio');
                    const defaultAudioStream = audioStreams.find(s => s.IsDefault && isAudioTrackNativelyPlayable(s, ms, this._backendType)) ||
                        audioStreams.find(s => isAudioTrackNativelyPlayable(s, ms, this._backendType)) ||
                        audioStreams[0];
                    const defaultIndex = defaultAudioStream ? defaultAudioStream.Index : undefined;
                    const firstAudioIndex = audioStreams.length > 0 ? audioStreams[0].Index : undefined;

                    const reqIndex = Number(index);
                    isCustomAudioTrack = (defaultIndex !== undefined && reqIndex !== Number(defaultIndex));
                    isFirstAudioTrack = (firstAudioIndex !== undefined && reqIndex === Number(firstAudioIndex));

                    trackRequiresDirectStream = doesAudioTrackRequireDirectStream(ms, reqIndex, this._backendType);
                }
            }

            const needsDirectStreamForAudio = trackRequiresDirectStream ||
                (this._backendType !== 'tizen' && this._backendType !== 'movi' && this._backendType !== 'exoplayer' && !supportsNativeAudio && (isCustomAudioTrack || !isFirstAudioTrack));

            // ────────────────────────────────────────────────────────────────
            // Calculate Restart Playback Mode
            // ────────────────────────────────────────────────────────────────
            // - If the user's mode is explicitly a forced mode
            //   ('transcode' or 'remux'), we preserve it.
            // - Otherwise, we default to 'auto' to let the server decide.
            // - If the target codec is unsupported or audio requires remux,
            //   we ensure 'auto' mode so CodecProfiles / DirectStream profiles
            //   are evaluated by the server.
            // - If the target track can DirectPlay natively, we revert to the
            //   user's playback mode (allowing return to DirectPlay).
            // ────────────────────────────────────────────────────────────────
            const baseMode =
                this._userPlaybackMode === 'transcode' || this._userPlaybackMode === 'remux'
                    ? this._userPlaybackMode
                    : 'auto';
            const restartPlaybackMode = baseMode === 'transcode' ? 'transcode'
                : (!isTargetCodecSupported || needsDirectStreamForAudio) ? 'auto'
                    : baseMode;

            const restartOptions = {
                ...this._currentPlayOptions,
                audioStreamIndex: index,
                subtitleStreamIndex: this._currentSubtitleStreamIndex,
                secondarySubtitleStreamIndex: this._currentSecondarySubtitleStreamIndex,
                startPositionTicks: currentTicks,
                playbackMode: restartPlaybackMode,
                _forceDirectStream: needsDirectStreamForAudio
            };

            // Persist so future restarts (bitrate change, etc.) carry the right track
            this._currentPlayOptions = restartOptions;
            this._lastPlayOptions = restartOptions;

            // Set guard BEFORE play() to block re-entrant restarts
            this._audioRestartInProgress = true;
            this._isRestarting = true;
            this._restartOwner = restartOptions;
            try {
                this.emit(PlayerEvent.RESTARTING);
                await this.stop({ restart: true });
                await this._playAfterRestartPause(restartOptions, 500);
            } catch (e) {
                log.error('Failed to restart playback for audio track switch:', e);
            } finally {
                // Clear the flag and the guard when done, success or failure, unless
                // a newer restart has taken over meanwhile
                if (this._restartOwner === restartOptions) {
                    this._isRestarting = false;
                    this._audioRestartInProgress = false;
                }
            }

            this.emit(PlayerEvent.MEDIA_STREAMS_CHANGE, { audioStreamIndex: index });
            return;
        }

        // In transcoding mode but called from play()'s internal audio setup —
        // there's nothing to do; the server already has the correct index.
        if (isTranscoding) {
            log.info(`[${this._currentPlayMethod}] Skipping native audio switch — server already has the correct track`);
            this.emit(PlayerEvent.MEDIA_STREAMS_CHANGE, { audioStreamIndex: index });
            return;
        }

        // =====================================================================
        // DirectPlay: native backend audio switching (no restart needed)
        // =====================================================================

        // Both Tizen (AVPlay) and HtmlVideoPlayer work with 0-based list
        // indices of available audio tracks, NOT the raw Jellyfin stream ID.
        // Convert here so both backends share the same simple interface.
        const tracks = this._getBackendAudioTracks();
        const listIndex = this._getBackendAudioTrackListIndex(index);

        if (listIndex === -1) {
            log.warn('StreamID', index, 'not found in audio tracks:', tracks.map(t => t.Index));
            this.emit(PlayerEvent.MEDIA_STREAMS_CHANGE, { audioStreamIndex: index });
            return;
        }

        log.debug('Converting StreamID', index, 'to list index', listIndex);
        this._backend?.setAudioStreamIndex(listIndex);

        this.emit(PlayerEvent.MEDIA_STREAMS_CHANGE, { audioStreamIndex: index });
    }

    /**
     * Set subtitle track — delegates to SubtitleManager for delivery routing.
     * SubtitleManager decides whether to use embedded native rendering
     * (Tizen AVPlay) or fetch/parse the subtitle externally.
     *
     * Special case: in "Always Burn In" mode, every subtitle track is burned
     * into the video server-side during transcoding. Changing the track in this
     * mode means re-sending a new transcoding request with the updated
     * SubtitleStreamIndex — we must restart playback from the current position.
     *
     * @param {number} index - Subtitle stream index (-1 to disable)
     */
    async setSubtitleStreamIndex(index) {
        // =====================================================================
        // Prewarm Cache Invalidation
        // =====================================================================
        // If the user changes the subtitle track during active playback (and
        // this is not the initial playback setup phase where tracks are first applied),
        // invalidate the PrewarmManager cache. This ensures subsequent launches
        // fetch fresh item metadata from Jellyfin rather than reusing stale
        // prewarmed metadata with the previous default subtitle track.
        // =====================================================================
        if (!this._playSetupInProgress && this._currentSubtitleStreamIndex !== index) {
            log.info(`[Prewarm] Invalidating prewarm cache due to subtitle stream change (${this._currentSubtitleStreamIndex} -> ${index})`);
            prewarmManager.invalidateCache();
        }

        this._currentSubtitleStreamIndex = index;

        // =====================================================================
        // Play Options Synchronization (Primary Subtitle Track)
        // =====================================================================
        // Persist the updated subtitle index into active play options immediately.
        // If a subsequent event triggers a session restart (such as switching audio
        // tracks which forces a server-side remux, or manual bitrate adjustments),
        // the restart options will inherit this active subtitle track instead of
        // reverting to the item's initial or default subtitle stream.
        // =====================================================================
        if (this._currentPlayOptions) {
            this._currentPlayOptions.subtitleStreamIndex = index;
        }
        if (this._lastPlayOptions) {
            this._lastPlayOptions.subtitleStreamIndex = index;
        }

        // =====================================================================
        // Burn-in restart: if the server is baking the subtitle into the video,
        // switching tracks requires a full retranscode. Two applicable modes:
        //
        //   'all'        → server burns EVERY subtitle format. Always restart.
        //
        //   'allcomplex' / 'auto' → server burns ONLY complex/bitmap formats (PGS,
        //                   VOBSUB, ASS, SSA). Simple Text formats (SRT, VTT) are 
        //                   delivered externally — no restart needed for those.
        //
        // Guards: _playSetupInProgress     → called from play()'s own setup;
        //                                    subtitle index already in server req.
        //         _burnInRestartInProgress → already inside a restart; prevents
        //                                    re-entrant second restart from play().
        // =====================================================================
        const burnIn = PlayerSettings.get('subtitleBurnIn');
        const isTranscodingSession = this._currentPlayMethod === 'Transcode' ||
            this._currentPlayMethod === 'DirectStream';

        // In 'allcomplex' / 'auto' mode:
        //
        //   Complex formats (PGS, VOBSUB, ASS, SSA): the server burns them in when it
        //   transcodes. Selecting a complex subtitle while DIRECT-PLAYING must also
        //   trigger a restart — the server needs to start transcoding with the
        //   subtitle burned in. So complex = ALWAYS restart in allcomplex mode.
        //
        //   Simple Text formats (SRT, VTT): served externally by the server API,
        //   so the client can render them without a restart UNLESS we're already
        //   transcoding — in that case the server has a specific SubtitleStreamIndex
        //   locked into the current HLS session and we must restart to change it.
        const _isAllComplex = burnIn === 'allcomplex' || burnIn === 'auto';
        const isComplexCodec = (() => {
            if (!_isAllComplex || index === -1) return false;
            const track = this.getSubtitleTracks().find(t => t.Index === index);
            const codec = (track?.Codec || '').toLowerCase();
            return codec === 'pgs' || codec === 'pgssub' ||
                codec === 'vobsub' || codec === 'dvdsub' || codec === 'dvd_subtitle' ||
                codec === 'ass' || codec === 'ssa';
        })();

        // Complex in allcomplex: always restart (even from direct play)
        // Simple text in allcomplex + transcoding: restart (subtitle locked in stream URL)
        const isComplexBurnIn = (_isAllComplex && isComplexCodec) ||
            (_isAllComplex && isTranscodingSession);

        const needsBurnInRestart = burnIn === 'all' || isComplexBurnIn;

        if (needsBurnInRestart && this._currentPlayOptions && !this._burnInRestartInProgress && !this._playSetupInProgress) {
            log.info(`Burn-in restart (mode: ${burnIn}, track: ${index}) — retranscoding`);

            // Capture current position so we can resume from the same spot
            const currentTicks = this.getCurrentPositionTicks();

            // Build new play options with the updated subtitle stream index
            const restartOptions = {
                ...this._currentPlayOptions,
                subtitleStreamIndex: index,
                startPositionTicks: currentTicks,
                playbackMode: this._playbackMode
            };

            // Persist the new index so that subsequent restarts (e.g. bitrate
            // changes) also carry the correct subtitle stream index
            this._currentPlayOptions = restartOptions;
            this._lastPlayOptions = restartOptions;

            // Set the guard BEFORE calling play() so that the internal
            // setSubtitleStreamIndex call from play() skips this path
            this._burnInRestartInProgress = true;
            this._isRestarting = true;
            this._restartOwner = restartOptions;
            try {
                this.emit(PlayerEvent.RESTARTING);
                await this.stop({ restart: true });
                await this._playAfterRestartPause(restartOptions, 500);
            } catch (e) {
                // play() reports its own failure (error event); only clean up here
                log.error('Failed to restart playback for subtitle burn-in:', e);
            } finally {
                // Always clear both flags, so subsequent stop() calls behave normally
                // and later errors still escalate even if the restart failed (unless
                // a newer restart has taken over meanwhile)
                if (this._restartOwner === restartOptions) {
                    this._isRestarting = false;
                    this._burnInRestartInProgress = false;
                }
            }

            // Notify OSD of the track change
            this.emit(PlayerEvent.MEDIA_STREAMS_CHANGE, { subtitleStreamIndex: index });
            return;
        }

        // Called from play()'s internal setup during a burn-in session —
        // the server already has the correct subtitle index, nothing to do client-side.
        if (needsBurnInRestart) {
            log.info(`Burn-in mode (${burnIn}) — skipping client-side setup (server already has correct track)`);
            this.emit(PlayerEvent.MEDIA_STREAMS_CHANGE, { subtitleStreamIndex: index });
            return;
        }

        // Let SubtitleManager determine the best delivery method
        const delivery = await this._subtitleManager.setPrimaryTrack(index);

        // If SubtitleManager chose embedded native, we need to tell the backend.
        //
        // IMPORTANT: In a transcoding session (Transcode or DirectStream play method)
        // the HLS/transcode output from the server carries NO embedded subtitle tracks.
        // Calling AVPlay's setSubtitleStreamIndex() would silently do nothing.
        // The only way to switch the subtitle is to restart the transcode with the
        // new SubtitleStreamIndex so the server re-encodes / remuxes the correct track.
        if (delivery === DeliveryMethod.EMBEDDED_NATIVE) {
            const isTranscoding = this._currentPlayMethod === 'Transcode' ||
                this._currentPlayMethod === 'DirectStream';

            if (isTranscoding && this._currentPlayOptions && !this._burnInRestartInProgress && !this._playSetupInProgress) {
                // Same restart pattern as burn-in — we reuse the burn-in guard flag
                // because the two paths are mutually exclusive (burn-in was already
                // checked earlier and would have returned by now).
                log.info(`EMBEDDED_NATIVE + ${this._currentPlayMethod} — restarting transcode for subtitle: ${index}`);

                const currentTicks = this.getCurrentPositionTicks();
                const restartOptions = {
                    ...this._currentPlayOptions,
                    subtitleStreamIndex: index,
                    startPositionTicks: currentTicks
                };

                this._currentPlayOptions = restartOptions;
                this._lastPlayOptions = restartOptions;

                this._burnInRestartInProgress = true;
                this._isRestarting = true;
                this._restartOwner = restartOptions;
                try {
                    this.emit(PlayerEvent.RESTARTING);
                    await this.stop({ restart: true });
                    await this._playAfterRestartPause(restartOptions, 500);
                } catch (e) {
                    log.error('Failed to restart for embedded subtitle switch during transcode:', e);
                } finally {
                    // Unless a newer restart has taken over meanwhile
                    if (this._restartOwner === restartOptions) {
                        this._isRestarting = false;
                        this._burnInRestartInProgress = false;
                    }
                }

                this.emit(PlayerEvent.MEDIA_STREAMS_CHANGE, { subtitleStreamIndex: index });
                return;
            }

            // DirectPlay: Tizen AVPlay can read embedded subtitle tracks natively.
            // WebOS and HTML5 backends do not surface embedded subtitle track APIs
            // reliably, so they always defer to SubtitleManager external rendering.
            if (this._backendType === 'tizen') {
                // Skip explicit backend call during initial playback setup.
                // TizenAVPlayer natively handles initial track selection via _pendingSubtitleIndex
                // deferred until the 'onbufferingcomplete' event safely transitions the player.
                if (this._playSetupInProgress) {
                    log.info('Skipping backend subtitle assignment during initial play (Tizen handles natively via pending index)');
                } else if (index === -1) {
                    this._backend.setSubtitleStreamIndex(-1);
                } else {
                    const tracks = this.getSubtitleTracks();
                    const trackExists = tracks.some((t) => t.Index === index);
                    if (trackExists) {
                        try {
                            this._backend.setSubtitleStreamIndex(index);
                        } catch (err) {
                            if (err.message === 'OUT_OF_BOUNDS_TIZEN_LIMIT') {
                                log.warn(`Tizen Backend rejected track ${index} (out of bounds). Falling back to EXTERNAL_TEXT rendering.`);
                                this._subtitleManager.forceExternalTextFallback(index);
                            } else {
                                throw err;
                            }
                        }
                    } else {
                        log.warn('Subtitle StreamID', index, 'not found in backend tracks');
                    }
                }
            }
        } else {
            // SubtitleManager is handling rendering via DOM (EXTERNAL_TEXT, ASS_CANVAS, PGS_BITMAP)
            // or delivery is NONE (subtitles disabled / unsupported format).
            // Tell the backend to turn off embedded subs so they don't double-render.
            // All backend types support setSubtitleStreamIndex(-1) to disable.
            this._backend?.setSubtitleStreamIndex(-1);
        }

        this.emit(PlayerEvent.MEDIA_STREAMS_CHANGE, { subtitleStreamIndex: index });
    }

    /**
     * ========================================================================
     * Download and Apply Subtitle Stream During Playback
     * ========================================================================
     * Downloads a remote subtitle provider result from the Jellyfin server,
     * refreshes the item's MediaStreams inventory, reconciles track indices to
     * prevent stream-shifting desync, and immediately activates the new subtitle
     * track in the active video session.
     * ========================================================================
     * 
     * @param {string} subtitleId - The remote subtitle result identifier
     * @returns {Promise<{success: boolean, track: Object, error?: Error}>}
     */
    /**
     * Download a remote subtitle from Jellyfin server, poll for updated streams,
     * reconcile shifted audio/subtitle indices, and activate the new subtitle track.
     *
     * @param {string} subtitleId - The remote subtitle result identifier
     * @param {Object} [subtitleInfo={}] - Optional metadata of the downloaded subtitle { language, name, format }
     * @returns {Promise<{success: boolean, track: Object, error?: Error}>}
     */
    async downloadAndApplySubtitle(subtitleId) {
        const subtitleInfo = arguments[1] || {};
        if (!this._currentItem?.Id || !subtitleId) {
            log.warn('downloadAndApplySubtitle aborted: missing item or subtitleId');
            return { success: false, error: new Error('Missing item or subtitleId') };
        }

        const itemId = this._currentItem.Id;
        log.info(`[Subtitle Downloader] Initiating download: item=${itemId}, subId=${subtitleId}`);

        // ====================================================================
        // Step 1: Snapshot Existing Tracks and Pre-Download State
        // ====================================================================
        // Query server to get an accurate baseline of currently existing streams
        // (including any previously downloaded external subtitles).
        let baseItem = null;
        try {
            baseItem = await api.getItem(itemId, { Fields: 'MediaStreams,MediaSources' });
        } catch (err) {
            log.warn('[Subtitle Downloader] Failed to fetch pre-download streams baseline:', err);
        }

        const currentSource = this._currentMediaSource || this._currentItem?.MediaSources?.[0];
        const baseSource = baseItem?.MediaSources?.find((ms) => ms.Id === currentSource?.Id) ||
            baseItem?.MediaSources?.[0] ||
            currentSource;
        const baselineStreams = baseSource?.MediaStreams || baseItem?.MediaStreams || currentSource?.MediaStreams || [];

        // Snapshot existing audio track identity
        const activeAudioStream = baselineStreams.find(
            (s) => s.Type === 'Audio' && s.Index === this._currentAudioStreamIndex
        );
        const audioSnapshot = activeAudioStream ? {
            language: (activeAudioStream.Language || 'und').toLowerCase(),
            title: activeAudioStream.DisplayTitle || activeAudioStream.Title || 'none',
            codec: (activeAudioStream.Codec || '').toLowerCase(),
            channels: activeAudioStream.Channels || null,
            index: activeAudioStream.Index
        } : null;

        // Snapshot existing subtitle fingerprints and indices
        const baselineSubtitles = baselineStreams.filter((s) => s.Type === 'Subtitle');
        const previousSubtitleIndices = new Set(baselineSubtitles.map((s) => s.Index));
        const previousSubtitleFingerprints = new Set(
            baselineSubtitles.map((s) => s.Path || s.DeliveryUrl || `${s.Index}:${(s.Language || '').toLowerCase()}:${(s.Codec || '').toLowerCase()}:${s.IsExternal}`)
        );

        // ====================================================================
        // Step 2: Trigger Server-Side Subtitle Download
        // ====================================================================
        try {
            await api.downloadSubtitle(itemId, subtitleId);
            log.info(`[Subtitle Downloader] Server download requested for: ${subtitleId}`);
        } catch (downloadErr) {
            log.error('[Subtitle Downloader] Download API request failed:', downloadErr);
            throw downloadErr;
        }

        // ====================================================================
        // Step 3: Poll / Refresh MediaStreams Metadata
        // ====================================================================
        // Server writes file to disk and refreshes item streams. We poll up to
        // 6 times (with 400ms delay) until a new subtitle stream is detected.
        let freshItem = null;
        let freshStreams = [];
        let freshSource = null;
        let newSubtitleTrack = null;

        const targetNormLang = subtitleInfo?.language ? languageManager.normalizeLanguage(subtitleInfo.language)?.code : null;

        for (let attempt = 0; attempt < 6; attempt++) {
            if (attempt > 0) {
                await new Promise((resolve) => setTimeout(resolve, 400));
            }

            try {
                freshItem = await api.getItem(itemId, { Fields: 'MediaStreams,MediaSources' });
                freshSource = freshItem?.MediaSources?.find((ms) => ms.Id === currentSource?.Id) ||
                    freshItem?.MediaSources?.[0];
                freshStreams = freshSource?.MediaStreams || freshItem?.MediaStreams || [];

                // Look for subtitle streams not present in the pre-download baseline
                const candidateNewSubs = freshStreams.filter((s) => {
                    if (s.Type !== 'Subtitle') return false;
                    const fp = s.Path || s.DeliveryUrl || `${s.Index}:${(s.Language || '').toLowerCase()}:${(s.Codec || '').toLowerCase()}:${s.IsExternal}`;
                    return !previousSubtitleFingerprints.has(fp) && (!previousSubtitleIndices.has(s.Index) || s.IsExternal);
                });

                if (candidateNewSubs.length > 0) {
                    // Filter candidates that are external subtitles
                    const externalCandidates = candidateNewSubs.filter((s) => s.IsExternal);
                    const pool = externalCandidates.length > 0 ? externalCandidates : candidateNewSubs;

                    // If language was provided, find candidate matching target language (searching from latest)
                    let matchedTrack = null;
                    if (targetNormLang) {
                        matchedTrack = [...pool].reverse().find((s) => {
                            const trackNorm = languageManager.normalizeLanguage(s.Language)?.code;
                            return trackNorm === targetNormLang || (s.Language || '').toLowerCase().startsWith(targetNormLang.slice(0, 2));
                        });
                    }

                    // Newly downloaded external subtitles are appended by Jellyfin at the END of external streams.
                    // Always pick the newest/last matching stream, NEVER the first!
                    newSubtitleTrack = matchedTrack || pool[pool.length - 1];
                    log.info(`[Subtitle Downloader] New subtitle stream detected at attempt ${attempt + 1}: index=${newSubtitleTrack.Index} (${newSubtitleTrack.DisplayTitle || newSubtitleTrack.Language})`);
                    break;
                }
            } catch (fetchErr) {
                log.warn(`[Subtitle Downloader] Fetching updated streams failed (attempt ${attempt + 1}):`, fetchErr);
            }
        }

        // Fallback: If no newly created stream detected, take the latest external subtitle stream matching language
        if (!newSubtitleTrack && freshStreams.length > 0) {
            const externalSubs = freshStreams.filter((s) => s.Type === 'Subtitle' && s.IsExternal);
            if (externalSubs.length > 0) {
                let matchedFallback = null;
                if (targetNormLang) {
                    matchedFallback = [...externalSubs].reverse().find((s) => {
                        const trackNorm = languageManager.normalizeLanguage(s.Language)?.code;
                        return trackNorm === targetNormLang || (s.Language || '').toLowerCase().startsWith(targetNormLang.slice(0, 2));
                    });
                }
                newSubtitleTrack = matchedFallback || externalSubs[externalSubs.length - 1];
                log.info(`[Subtitle Downloader] Falling back to latest external subtitle track: index=${newSubtitleTrack.Index}`);
            }
        }

        // ====================================================================
        // Step 4: Update In-Memory MediaSources and MediaStreams
        // ====================================================================
        const updatedStreams = freshSource?.MediaStreams || freshItem?.MediaStreams || freshStreams;
        if (freshItem?.MediaSources) {
            this._currentItem.MediaSources = freshItem.MediaSources;
        }
        if (this._currentMediaSource && updatedStreams.length > 0) {
            this._currentMediaSource.MediaStreams = updatedStreams;
        }
        if (this._currentItem && updatedStreams.length > 0) {
            this._currentItem.MediaStreams = updatedStreams;
        }
        // Update SubtitleManager's stream registry
        this._subtitleManager.updateMediaStreams(updatedStreams);

        // ====================================================================
        // Step 5: Reconcile Audio Stream Index
        // ====================================================================
        // If stream indices shifted on the server, reconcile audio track so
        // that playback doesn't point to an invalid or swapped stream.
        if (audioSnapshot && freshSource) {
            const candidateAudios = freshSource.MediaStreams.filter((s) => s.Type === 'Audio');
            const exactIndexMatch = candidateAudios.find((s) => s.Index === audioSnapshot.index);

            // Verify if stream at the same index still has matching identity
            const isSameTrack = exactIndexMatch &&
                (exactIndexMatch.Language || 'und').toLowerCase() === audioSnapshot.language &&
                (!audioSnapshot.codec || (exactIndexMatch.Codec || '').toLowerCase() === audioSnapshot.codec);

            if (!isSameTrack) {
                // Audio track shifted! Find the matching stream in fresh inventory
                const matchedAudio = candidateAudios.find(
                    (s) => (s.Language || 'und').toLowerCase() === audioSnapshot.language &&
                        (s.Codec || '').toLowerCase() === audioSnapshot.codec
                ) || candidateAudios.find(
                    (s) => (s.Language || 'und').toLowerCase() === audioSnapshot.language
                );

                if (matchedAudio && matchedAudio.Index !== this._currentAudioStreamIndex) {
                    log.warn(`[Subtitle Downloader] Reconciling shifted audio stream index: ${this._currentAudioStreamIndex} -> ${matchedAudio.Index}`);
                    this._currentAudioStreamIndex = matchedAudio.Index;
                    MediaHelper.saveTrackMemory(itemId, 'Audio', matchedAudio, freshSource);
                }
            }
        }

        // ====================================================================
        // Step 6: Apply and Activate the New Subtitle Track
        // ====================================================================
        if (newSubtitleTrack) {
            log.info(`[Subtitle Downloader] Applying new subtitle track: index=${newSubtitleTrack.Index}`);

            // Invalidate prewarm cache so next plays fetch fresh metadata
            prewarmManager.invalidateCache();

            // Set new subtitle stream on the player
            await this.setSubtitleStreamIndex(newSubtitleTrack.Index);

            // Persist to track memory
            MediaHelper.saveTrackMemory(itemId, 'Subtitle', newSubtitleTrack, this._currentMediaSource || freshSource);
            storage.setItem('session:lastSubtitleLang', newSubtitleTrack.Language || 'und');
            storage.setItem(
                'session:lastSubtitleTitle',
                newSubtitleTrack.DisplayTitle || newSubtitleTrack.Title || 'none'
            );

            // Emit streams change to update OSD and subscribers
            this.emit(PlayerEvent.MEDIA_STREAMS_CHANGE, {
                subtitleStreamIndex: newSubtitleTrack.Index,
                audioStreamIndex: this._currentAudioStreamIndex
            });

            return { success: true, track: newSubtitleTrack };
        } else {
            log.warn('[Subtitle Downloader] Download completed but could not resolve target subtitle stream');
            return { success: false, error: new Error('Could not resolve new subtitle stream') };
        }
    }

    /**
     * ========================================================================
     * Delete and Reconcile Subtitle Stream During Active Playback
     * ========================================================================
     * Requests the Jellyfin server to delete a local external subtitle track,
     * pulls fresh stream metadata, cleans up active rendering references if the
     * deleted track was in use, and re-reconciles shifted track indices.
     * ========================================================================
     *
     * @param {number} streamIndex - Server MediaStream index of subtitle to delete
     * @returns {Promise<{success: boolean, error?: Error}>}
     */
    async deleteAndReconcileSubtitle(streamIndex) {
        // Validate that an active playback item exists and stream index was specified
        if (!this._currentItem?.Id || streamIndex === undefined || streamIndex === null) {
            log.warn('deleteAndReconcileSubtitle aborted: missing item or streamIndex');
            return { success: false, error: new Error('Missing item or streamIndex') };
        }

        const itemId = this._currentItem.Id;
        log.info(`[Subtitle Editor] Initiating server deletion: item=${itemId}, streamIndex=${streamIndex}`);

        // ====================================================================
        // Step 1: Delete Subtitle File on Jellyfin Server
        // ====================================================================
        try {
            await api.deleteSubtitle(itemId, streamIndex);
            log.info(`[Subtitle Editor] Subtitle stream ${streamIndex} deleted on server`);
        } catch (deleteErr) {
            log.error('[Subtitle Editor] Server deletion request failed:', deleteErr);
            throw deleteErr;
        }

        // ====================================================================
        // Step 2: Query Server for Updated Stream Inventory
        // ====================================================================
        // Subtitle deletion causes stream indices above the deleted index to shift.
        // Query fresh inventory to capture the newly indexed state.
        let freshItem = null;
        try {
            freshItem = await api.getItem(itemId, { Fields: 'MediaStreams,MediaSources' });
        } catch (fetchErr) {
            log.warn('[Subtitle Editor] Failed to fetch updated streams after deletion:', fetchErr);
        }

        const currentSource = this._currentMediaSource || this._currentItem?.MediaSources?.[0];
        const freshSource = freshItem?.MediaSources?.find((ms) => ms.Id === currentSource?.Id) ||
            freshItem?.MediaSources?.[0];
        const freshStreams = freshSource?.MediaStreams || freshItem?.MediaStreams || [];

        // ====================================================================
        // Step 3: Synchronize In-Memory MediaSource and Subtitle Registry
        // ====================================================================
        if (freshItem?.MediaSources) {
            this._currentItem.MediaSources = freshItem.MediaSources;
        }
        if (this._currentMediaSource && freshStreams.length > 0) {
            this._currentMediaSource.MediaStreams = freshStreams;
        }
        if (this._currentItem && freshStreams.length > 0) {
            this._currentItem.MediaStreams = freshStreams;
        }
        // Notify SubtitleManager of updated stream list so renderer has current metadata
        this._subtitleManager.updateMediaStreams(freshStreams);

        // Clear prewarm cache so upcoming play sessions fetch refreshed descriptors
        prewarmManager.invalidateCache();

        // ====================================================================
        // Step 4: Reconcile Active Playback Track Selections
        // ====================================================================
        // If the deleted track was currently rendering on screen, immediately turn off
        if (this._currentSubtitleStreamIndex === streamIndex) {
            log.info(`[Subtitle Editor] Active subtitle ${streamIndex} was deleted; disabling subtitles`);
            await this.setSubtitleStreamIndex(-1);
            MediaHelper.saveTrackMemory(itemId, 'Subtitle', { Index: -1 }, this._currentMediaSource || freshSource);
        } else if (this._currentSubtitleStreamIndex !== -1) {
            // Check if active subtitle stream shifted or no longer exists
            const stillPresent = freshStreams.some(
                (s) => s.Type === 'Subtitle' && s.Index === this._currentSubtitleStreamIndex
            );
            if (!stillPresent) {
                log.warn(`[Subtitle Editor] Active subtitle index ${this._currentSubtitleStreamIndex} invalidated by shift; disabling`);
                await this.setSubtitleStreamIndex(-1);
            }
        }

        // Check if audio track index shifted due to stream re-indexing on server
        if (this._currentAudioStreamIndex !== undefined && this._currentAudioStreamIndex !== null) {
            const audioStillValid = freshStreams.some(
                (s) => s.Type === 'Audio' && s.Index === this._currentAudioStreamIndex
            );
            if (!audioStillValid) {
                const fallbackAudio = freshStreams.find((s) => s.Type === 'Audio');
                if (fallbackAudio) {
                    log.warn(`[Subtitle Editor] Reconciling shifted audio stream: ${this._currentAudioStreamIndex} -> ${fallbackAudio.Index}`);
                    this._currentAudioStreamIndex = fallbackAudio.Index;
                    MediaHelper.saveTrackMemory(itemId, 'Audio', fallbackAudio, freshSource);
                }
            }
        }

        // ====================================================================
        // Step 5: Broadcast Track State to OSD and Subscribers
        // ====================================================================
        this.emit(PlayerEvent.MEDIA_STREAMS_CHANGE, {
            subtitleStreamIndex: this._currentSubtitleStreamIndex,
            audioStreamIndex: this._currentAudioStreamIndex
        });

        return { success: true };
    }

    /**
     * Set subtitle offset — routes to SubtitleManager for DOM-rendered subs
     * or to the backend for embedded native subs.
     *
     * @param {number} seconds - Offset in seconds
     */
    setSubtitleOffset(seconds) {
        // If SubtitleManager is handling the primary subtitle, apply offset there
        if (this._subtitleManager.isPrimaryManagedByUs()) {
            this._subtitleManager.setPrimaryOffset(seconds);
        } else {
            // Embedded native subs — delegate to backend (Tizen has native offset API)
            this._backend?.setSubtitleOffset(seconds);
        }
    }

    /**
     * Set aspect ratio mode
     * @param {string} mode - 'auto', 'zoom', 'stretch'
     */
    setAspectRatio(mode) {
        this._currentAspectRatio = mode;
        this._backend?.setAspectRatio(mode);
    }

    /**
     * Get current aspect ratio
     * @returns {string} 'auto', 'zoom', 'stretch'
     */
    getAspectRatio() {
        return this._currentAspectRatio || 'auto';
    }

    /**
     * Get current audio stream index
     * @returns {number}
     */
    getCurrentAudioStreamIndex() {
        return this._currentAudioStreamIndex;
    }

    /**
     * Get current subtitle stream index
     * @returns {number}
     */
    getCurrentSubtitleStreamIndex() {
        return this._currentSubtitleStreamIndex;
    }

    // ========================================================================
    // Secondary Subtitle Support
    // ========================================================================

    /**
     * Set secondary subtitle stream index — delegates to SubtitleManager.
     * Secondary subtitles are always fetched externally and rendered on DOM,
     * even if the track is embedded in the container.
     *
     * @param {number} index - Stream index (-1 to disable)
     */
    async setSecondarySubtitleStreamIndex(index) {
        if (this._currentSecondarySubtitleStreamIndex === index) return;

        log.info('Setting secondary subtitle index:', index);
        this._currentSecondarySubtitleStreamIndex = index;

        // =====================================================================
        // Play Options Synchronization (Secondary Subtitle Track)
        // =====================================================================
        // Keep active play options in sync so secondary subtitle selections are
        // preserved across audio track switches, transcode escalation, or bitrate changes.
        // =====================================================================
        if (this._currentPlayOptions) {
            this._currentPlayOptions.secondarySubtitleStreamIndex = index;
        }
        if (this._lastPlayOptions) {
            this._lastPlayOptions.secondarySubtitleStreamIndex = index;
        }

        // Delegate to SubtitleManager — it handles fetch, parse, and cue ticking
        await this._subtitleManager.setSecondaryTrack(index);

        this.emit(PlayerEvent.MEDIA_STREAMS_CHANGE, { secondarySubtitleStreamIndex: index });
    }

    // ========================================================================
    // Playback Speed
    // ========================================================================

    /**
     * Set playback speed
     * @param {number} speed - Playback speed (0.5 to 4.0)
     */
    setPlaybackSpeed(speed) {
        this._playbackSpeed = speed;
        this._backend?.setSpeed(speed);
        this.emit('speedchange', { speed });
    }

    /**
     * Get current playback speed
     * @returns {number}
     */
    getPlaybackSpeed() {
        return this._playbackSpeed || 1;
    }

    /**
     * Retrieve the active backend type identifier.
     * Maps to one of Litefin's hardware/platform player engines:
     * 'movi', 'html5', 'tizen', 'webos', or 'exoplayer'.
     *
     * @returns {'movi'|'html5'|'tizen'|'webos'|'exoplayer'} Active backend identifier
     */
    getBackendType() {
        // Return active backend or fall back to standard HTML5 video engine
        return this._backendType || 'html5';
    }

    /**
     * Evaluates whether a specific playback speed rate is natively supported
     * by the active player backend without hardware down-snapping, buffer stalls,
     * or audio pipeline exceptions.
     *
     * @param {number} speed - The playback speed multiplier to test
     * @returns {boolean} True if natively supported, false if clamped or unsupported
     */
    isPlaybackSpeedSupported(speed) {
        // Resolve active player backend engine
        const backend = this.getBackendType();

        // Evaluate backend-specific hardware constraints
        switch (backend) {
            case 'webos':
                // WebOSPlayer sends the rate to the TV's media service (sound stays on).
                // 0.5x to 2x is confirmed on hardware; faster rates may be rejected and
                // then fall back to the element playbackRate, which mutes the sound
                return speed >= 0.5 && speed <= 2;

            case 'tizen':
                // Samsung AVPlay trickplay requires integer multipliers (1, 2, 4, 8);
                // fractional rates throw exceptions or freeze video frames
                return Number.isInteger(speed) && [1, 2, 4, 8].includes(speed);

            case 'movi':
                // movi-player WebCodecs WASM pipeline strictly enforces a 2.0x ceiling
                // to prevent hardware decoder buffer underruns on high-res video
                return speed >= 0.25 && speed <= 2;

            case 'exoplayer':
                // Android ExoPlayer with Sonic audio processor supports standard positive floats
                return speed >= 0.25 && speed <= 8;

            case 'html5':
            default:
                // Standard desktop/mobile browser HTML5 video element (Chrome, Edge, Firefox, Safari)
                return speed >= 0.25 && speed <= 4;
        }
    }

    /**
     * Get current secondary subtitle stream index
     * @returns {number}
     */
    getCurrentSecondarySubtitleStreamIndex() {
        return this._currentSecondarySubtitleStreamIndex;
    }

    // ========================================================================
    // Chapter Support
    // ========================================================================

    getChapters() {
        return this._chapters || [];
    }

    getCurrentChapterIndex(timeTicks) {
        if (!this._chapters || this._chapters.length === 0) return -1;

        const currentTicks = timeTicks !== undefined ? timeTicks : this.getCurrentPositionTicks();
        // log.debug('Chapter Debug: Current Ticks', currentTicks);

        // Find the last chapter that started before current time
        for (let i = this._chapters.length - 1; i >= 0; i--) {
            const startTicks = this._chapters[i].StartPositionTicks || 0;
            if (currentTicks >= startTicks) {
                // log.debug('Chapter Debug: Found index', i, 'StartTicks', startTicks);
                return i;
            }
        }
        return -1;
    }

    nextChapter() {
        // Tizen Seek Offset Workaround:
        // On Tizen, we apply a -2.5s offset to chapter seeks (see below).
        // This causes "Next Chapter" to land slightly before the actual chapter start.
        // Determining the current chapter index strictly by current time would place us in the PREVIOUS chapter.
        // To avoid getting stuck in a loop (Next -> Prev Chapter End -> Next -> Prev Chapter End),
        // we look ahead by 3s (slightly more than the 2.5s hack) to see "where we effectively are".
        let lookAhead = 0;
        if (this._backendType === 'tizen') {
            lookAhead = 30000000; // 3 seconds in ticks
        }

        const index = this.getCurrentChapterIndex(this.getCurrentPositionTicks() + lookAhead);
        log.debug('Chapter Debug (Next): Current Index', index, 'Total', this._chapters ? this._chapters.length : 0);

        if (index === -1) {
            if (this._chapters && this._chapters.length > 0) {
                this._lastChapterSeekTime = Date.now();
                this.seek(this._chapters[0].StartPositionTicks);
                return;
            }
            return;
        }

        if (index >= this._chapters.length - 1) {
            log.debug('Chapter Debug: Already at last chapter');
            return;
        }

        const nextChapter = this._chapters[index + 1];
        if (nextChapter) {
            let seekTarget = nextChapter.StartPositionTicks;
            if (this._backendType === 'tizen') {
                // hack: Tizen AVPlay seek subtract 2.5s (25,000,000 ticks) from next chapter until we find what is wrong
                seekTarget = Math.max(0, seekTarget - 25000000);
                log.info('TizenAVPlayer: Applying 2.5s offset to next chapter jump');
            }
            log.info('Skipping to next chapter:', nextChapter.Name);
            this._lastChapterSeekTime = Date.now();
            this.seek(seekTarget);
        }
    }

    previousChapter() {
        // Tizen Seek Offset Workaround:
        // On Tizen, nextChapter() applies a -2.5s offset to chapter seeks, landing slightly
        // before the actual chapter start. To prevent previousChapter() from misidentifying
        // the current chapter and getting stuck in a loop, we look ahead by 3s (matching nextChapter).
        let lookAhead = 0;
        if (this._backendType === 'tizen') {
            lookAhead = 30000000; // 3 seconds in ticks
        }

        const index = this.getCurrentChapterIndex(this.getCurrentPositionTicks() + lookAhead);
        log.debug('Chapter Debug (Prev): Current Index', index);

        if (index === -1) return;

        const currentTicks = this.getCurrentPositionTicks();
        const currentChapter = this._chapters[index];
        const chapterStart = currentChapter.StartPositionTicks || 0;

        const diff = currentTicks - chapterStart;
        log.debug('Chapter Debug: Diff from start', diff);

        // STICKY CHAPTER SEEK PROTECTION (Bypasses restart block if user clicks quickly)
        const now = Date.now();
        const isRepeatedClick = this._lastChapterSeekTime && (now - this._lastChapterSeekTime < 2500);

        // If we are more than 3 seconds into the chapter AND it's not a rapid repeated click, restart current chapter.
        // On Tizen, keyframe seeking can make us land up to 8-10 seconds after the target chapter start.
        // Therefore, if the user repeatedly clicks "Previous Chapter" (within 2.5 seconds),
        // we bypass the restart protection entirely and skip to the previous chapter.
        if (diff > 30000000 && !isRepeatedClick) {
            log.info('Restarting current chapter:', currentChapter.Name);
            this._lastChapterSeekTime = now;
            this.seek(chapterStart);
        } else if (index > 0) {
            // Go to previous chapter
            const prevChapter = this._chapters[index - 1];
            log.info('Skipping to previous chapter:', prevChapter.Name);
            this._lastChapterSeekTime = now;
            this.seek(prevChapter.StartPositionTicks);
        } else {
            // First chapter, just seek to start
            this._lastChapterSeekTime = now;
            this.seek(0);
        }
    }

    /**
     * Refresh subtitle styles — delegate to backend (for embedded subs)
     * or emit event for DOM-rendered subs.
     */
    refreshSubtitles() {
        // Always try to refresh managed subtitles (ASS/Text)
        if (this._subtitleManager) {
            this._subtitleManager.refreshStyles();
        }

        /*
         * ====================================================================
         * Dual Backend and DOM Subtitle Synchronization
         * ====================================================================
         * If the platform backend supports native/hardware subtitle refreshing,
         * delegate to it. Crucially, always emit the 'refreshsubtitles' event
         * so PlayerPage can update external SRT, VTT, and secondary subtitle
         * DOM overlay layers simultaneously.
         * ====================================================================
         */
        if (this._backend && this._backend.refreshSubtitles) {
            this._backend.refreshSubtitles();
        }
        this.emit('refreshsubtitles');
    }

    /**
     * Get current stream type
     * @returns {string} 'HLS' or 'Video'
     */
    getStreamType() {
        if (this._backend && this._backend._hlsPlayer) {
            return 'HLS';
        }
        return 'Video';
    }

    /**
     * Get available audio tracks
     * @returns {Array} Audio streams
     */
    getAudioTracks() {
        return this._currentMediaSource?.MediaStreams?.filter((s) => s.Type === 'Audio') || [];
    }

    /**
     * Check if an audio track can be played natively by the current backend
     * without requiring a server-side transcode restart.
     *
     * Used by the OSD TrackMenu to visually grey out tracks that the native
     * player cannot decode (e.g. FLAC in MKV on HTML5 browsers, DTS/TrueHD
     * when passthrough is disabled). Selecting such a track will still work
     * — it triggers a playback restart with server transcoding — but the
     * visual indicator helps the user understand why switching is slower.
     *
     * @param {Object} track - Jellyfin MediaStream object with a Codec field
     * @returns {boolean} true if the track can be toggled natively, false if
     *                    selecting it would require a transcode restart
     */
    isAudioTrackNativelyPlayable(track) {
        return isAudioTrackNativelyPlayable(track, this._currentMediaSource, this._backendType);
    }

    /**
     * Resolve the best audio track for DirectPlay without transcoding
     * @param {Object} mediaSource
     * @param {string} [targetLang]
     * @returns {Object|null}
     */
    resolveBestAudioStream(mediaSource, targetLang) {
        return resolveBestAudioStream(mediaSource, targetLang, this._backendType);
    }

    /**
     * Resolve subtitle stream based on player subtitle mode and preferences
     * @param {Object} mediaSource - Jellyfin MediaSource object containing MediaStreams
     * @param {Object} [options] - Resolution options
     * @returns {number} Resolved stream index, or -1 for off
     */
    resolveSubtitleStream(mediaSource, options = {}) {
        return resolveSubtitleStream(mediaSource, options);
    }

    /**
     * Resolve effective subtitle mode taking server user configuration into account
     * @param {string} [mode] - Optional mode override
     * @returns {string} Effective subtitle mode
     */
    getEffectiveSubtitleMode(mode) {
        return getEffectiveSubtitleMode(mode);
    }

    /**
     * Get audio tracks as exposed by the current native backend.
     *
     * Native media engines (WebOS HTML5 video and Tizen AVPlay) keep original
     * container stream IDs, but omit tracks that cannot be output natively when
     * passthrough audio codecs (e.g., DTS and TrueHD) are disabled or unsupported.
     * Including those omitted streams shifts the 0-based backend track list index,
     * which causes the player to select the wrong audio track on in-player switching.
     *
     * @param {Object} [mediaSource]
     * @returns {Array} Backend-visible audio streams
     * @private
     */
    _getBackendAudioTracks(mediaSource = this._currentMediaSource) {
        // Retrieve all audio streams attached to the current media source
        const tracks = mediaSource?.MediaStreams?.filter((s) => s.Type === 'Audio') || [];

        // For MoviPlayer (WebCodecs) and ExoPlayer (Android Media3), demuxing happens natively
        // inside the backend engine, exposing all container audio tracks without browser element filtering.
        if (this._backendType === 'movi' || this._backendType === 'exoplayer') {
            return tracks;
        }

        // Filter out audio formats that the hardware pipeline or browser omits from native track lists
        return tracks.filter((track) => {
            const codec = (track.Codec || '').toLowerCase();

            // Omit Dolby TrueHD if passthrough/decoding is disabled or unsupported by hardware
            if (codec === 'truehd' && !isTrueHdSupported()) {
                return false;
            }

            // Omit DTS / DTS-HD / DCA streams if passthrough/decoding is disabled or unsupported
            if ((codec.includes('dts') || codec === 'dca') && !isDtsSupported()) {
                return false;
            }

            // Omit FLAC / ALAC in video containers if enableFlacInVideo setting is disabled.
            // That setting is Tizen-only: webOS lists FLAC tracks in video.audioTracks.
            const isWebOSFlac = codec === 'flac' && this._backendType === 'webos';
            if ((codec === 'flac' || codec === 'alac') && !isWebOSFlac && !PlayerSettings.get('enableFlacInVideo')) {
                return false;
            }

            return true;
        });
    }

    /**
     * Convert a Jellyfin audio stream Index to the 0-based backend track index.
     * @param {number} streamIndex
     * @param {Object} [mediaSource]
     * @returns {number}
     * @private
     */
    _getBackendAudioTrackListIndex(streamIndex, mediaSource = this._currentMediaSource) {
        if (streamIndex === undefined || streamIndex === null) {
            return -1;
        }

        return this._getBackendAudioTracks(mediaSource).findIndex((t) => t.Index === streamIndex);
    }

    /**
     * Get available subtitle tracks
     * @returns {Array} Subtitle streams
     */
    getSubtitleTracks() {
        if (!this._currentMediaSource || !this._currentMediaSource.MediaStreams) {
            return [];
        }

        const disablePgs = PlayerSettings.get('pgsPlaybackMode') === 'disable';

        return this._currentMediaSource.MediaStreams.filter((s) => {
            if (s.Type !== 'Subtitle') return false;

            if (disablePgs) {
                const codec = (s.Codec || '').toLowerCase();
                if (codec === 'pgs' || codec === 'pgssub') {
                    return false;
                }
            }

            return true;
        });
    }

    // ========================================================================
    // State Getters
    // ========================================================================

    /**
     * Get current position in ticks
     * @returns {number}
     */
    getCurrentPositionTicks() {
        if (this._isSeeking && this._seekTargetTicks !== null) {
            return this._seekTargetTicks;
        }

        const backendTime = this._backend?.getCurrentTime ? this._backend.getCurrentTime() : 0;
        const backendTicks = Math.round(backendTime * 10000000);

        // If playback hasn't fully started yet (time is 0), but we requested a specific
        // start position, return it so the UI (OSD) shows the correct time immediately
        // instead of flashing 00:00.
        if (backendTicks === 0 && this._pendingStartPositionTicks) {
            return this._pendingStartPositionTicks;
        }

        // Add offset if we are playing a transcoded segment
        const total = backendTicks + this._transcodingOffsetTicks;
        return isNaN(total) ? 0 : total;
    }

    /**
     * Get current position in milliseconds
     * @returns {number}
     */
    getCurrentPositionMs() {
        // A progressive transcode started at an offset reports time from 0;
        // seek() takes media positions, like getCurrentPositionTicks() returns
        const backendMs = (this._backend?.getCurrentTime() ?? 0) * 1000;
        return backendMs + (this._transcodingOffsetTicks || 0) / 10000;
    }

    /**
     * ========================================================================
     * Start / Resume Position Getter
     * ========================================================================
     * Retrieve the initial start or resume position ticks configured for this
     * playback session. Used by PlayerPage and OSDController to compute watch
     * time thresholds and safeguard against overwriting resume positions.
     * ========================================================================
     * @returns {number} Start position in 100-nanosecond ticks
     */
    getStartPositionTicks() {
        return this._pendingStartPositionTicks || this._startPositionTicks || 0;
    }

    /**
     * Get total duration in ticks.
     *
     * Resolution priority:
     *   1. MediaSource.RunTimeTicks  — most authoritative; set from Jellyfin metadata at
     *                                  play() time. Also used as a latch once Priority 3
     *                                  populates a valid value (so subsequent calls are free).
     *   2. HLS.js manifest duration  — set by getHlsManifestDuration() after LEVEL_UPDATED
     *                                  fires with details.live===false (transcoder done).
     *   3. Backend video.duration    — for DirectPlay this is the container-header duration
     *                                  (accurate from metadata load). For live HLS this is
     *                                  Infinity (rejected). Once a valid value is found here
     *                                  it is cached onto MediaSource so Priority 1 wins next time.
     *
     * @returns {number} Duration in 100-nanosecond ticks
     */
    getDurationTicks() {
        // ====================================================================
        // Priority 1: Jellyfin metadata (MediaSource or Item RunTimeTicks).
        //   This is the most reliable source — set at play() time, including
        //   the back-fill from item metadata when PlaybackInfo omits it.
        // ====================================================================
        const metadataTicks = this._currentMediaSource?.RunTimeTicks || this._currentItem?.RunTimeTicks || 0;
        if (metadataTicks > 0) {
            return metadataTicks;
        }

        // ====================================================================
        // Priority 2: HLS.js manifest-derived duration.
        //
        // When Jellyfin finishes transcoding the entire file it appends
        // #EXT-X-ENDLIST to the HLS playlist. HLS.js detects this via the
        // LEVEL_UPDATED event (details.live === false) and stores the accurate
        // total in _hlsManifestDuration via getHlsManifestDuration(). Once
        // available this is perfectly accurate — far better than the growing
        // video.duration value we'd get before the manifest is complete.
        //
        // This is only available for HtmlVideoPlayer (HLS.js backend). On
        // TizenAVPlayer the native media engine reports duration directly.
        // ====================================================================
        if (this._backend && typeof this._backend.getHlsManifestDuration === 'function') {
            const hlsDur = this._backend.getHlsManifestDuration();
            if (hlsDur !== null) {
                log.debug(`[Duration] Using HLS manifest duration: ${hlsDur.toFixed(1)}s`);

                const ticks = Math.floor(hlsDur * 10000000);
                // Cache it on the MediaSource so subsequent calls skip this lookup
                if (this._currentMediaSource) {
                    this._currentMediaSource.RunTimeTicks = ticks;
                }
                return ticks;
            }
        }

        // ====================================================================
        // Priority 3 (last resort): Backend-reported duration.
        //   For DirectPlay, video.duration is read accurately from the
        //   container header (MKV/MP4/etc.) once metadata loads.
        //   For live TV this may be Infinity, and for HLS transcoding it may
        //   grow as segments are encoded — both are rejected below.
        //   Once a valid finite value is found it is cached onto the
        //   MediaSource so subsequent calls hit Priority 1 directly.
        // ====================================================================
        if (this._backend && typeof this._backend.getDuration === 'function') {
            const backendDur = this._backend.getDuration();
            if (backendDur > 0 && isFinite(backendDur) && !isNaN(backendDur)) {
                const ticks = Math.floor(backendDur * 10000000);
                // Latch the value so the OSD never has to re-read video.duration
                if (this._currentMediaSource) {
                    this._currentMediaSource.RunTimeTicks = ticks;
                }
                return ticks;
            }
        }

        return 0;
    }

    /**
     * Check if currently playing
     * @returns {boolean}
     */
    isPlaying() {
        return this._isPlaying && !this._isPaused;
    }

    /**
     * Check if paused
     * Queries the underlying backend hardware state if available to prevent state desync
     * @returns {boolean}
     */
    isPaused() {
        // Consult backend as the ultimate source of truth when running
        if (this._backend && typeof this._backend.isPaused === 'function') {
            return this._backend.isPaused();
        }
        return this._isPaused;
    }

    /**
     * Get current item
     * @returns {Object|null}
     */
    getCurrentItem() {
        return this._currentItem;
    }

    /**
     * Get current media source
     * @returns {Object|null}
     */
    getCurrentMediaSource() {
        return this._currentMediaSource;
    }

    /**
     * Play method resolved for the current item: 'DirectPlay', 'Remux',
     * 'DirectStream' or 'Transcode'. Unlike MediaHelper.getPlayMethod(), it
     * includes the forced-remux correction (_resolveForcedRemuxPlayMethod)
     * and the strict transcode mode.
     * @returns {string|null} null before the first play
     */
    getCurrentPlayMethod() {
        return this._currentPlayMethod || null;
    }

    /**
     * Retrieves the user-facing name of the currently active subtitle rendering engine.
     * Delegates the lookup directly to the internal SubtitleManager instance.
     * 
     * @returns {string} Human-readable subtitle renderer name.
     */
    getSubtitleRendererName() {
        // Delegate to subtitle manager if initialized; otherwise return 'None'.
        if (this._subtitleManager) {
            return this._subtitleManager.getSubtitleRendererName();
        }
        return 'None';
    }

    /* =========================================================================
       HDR DETECTION UTILITY
       =========================================================================
       Determines if the currently loaded/playing media source contains a video
       stream in High Dynamic Range (HDR). Checks the video stream properties
       which are parsed dynamically from the Jellyfin media metadata.
       ========================================================================= */
    isCurrentMediaHDR() {
        // Retrieve the selected active media source
        const mediaSource = this.getCurrentMediaSource();
        if (!mediaSource) {
            // No active playback media loaded
            return false;
        }

        // Locate the primary video stream within the streams list
        const videoStream = (mediaSource.MediaStreams || []).find(s => s.Type === 'Video');
        if (!videoStream) {
            // No valid video tracks found
            return false;
        }

        // ---------------------------------------------------------------------
        // Check 1: Coarse range description (e.g. HDR vs SDR)
        // ---------------------------------------------------------------------
        const videoRange = (videoStream.VideoRange || '').toUpperCase();
        if (videoRange.includes('HDR')) {
            return true;
        }

        // ---------------------------------------------------------------------
        // Check 2: Fine-grained Range Type (e.g., HDR10, HDR10Plus, DOVI, HLG)
        // Ensure we filter out explicit 'SDR' values
        // ---------------------------------------------------------------------
        const videoRangeType = (videoStream.VideoRangeType || '').toUpperCase();
        if (videoRangeType && videoRangeType !== 'SDR') {
            return true;
        }

        // Content is fallback SDR (Standard Dynamic Range)
        return false;
    }

    // ========================================================================
    // Fullscreen
    // ========================================================================

    /**
     * Toggle fullscreen mode
     */
    toggleFullscreen() {
        this._backend?.toggleFullscreen();
    }

    /**
     * Check if in fullscreen
     * @returns {boolean}
     */
    isFullscreen() {
        return this._backend?.isFullscreen() ?? false;
    }

    // ========================================================================
    // API Helpers
    // ========================================================================

    /**
     * Get playback info from Jellyfin server
     * @private
     */
    async _getPlaybackInfo(options, deviceProfile, manualBitrate = null) {
        // Read max bitrate: priority to deviceProfile if passed (it contains the logic)
        // Fallback to manualBitrate or 120Mbps
        const maxBitrate = deviceProfile?.MaxStreamingBitrate || manualBitrate || 120000000;

        // ---------------------------------------------------------------------
        // Check for Zero-Latency Prewarmed PlaybackInfo
        // ---------------------------------------------------------------------
        // The prewarm is only reused when it was requested with the same
        // bitrate limit (a quality change in the OSD lowers it)
        const prewarmedPromise = prewarmManager.consumePlaybackInfo(options.itemId, {
            ...options,
            maxStreamingBitrate: maxBitrate
        });
        if (prewarmedPromise) {
            log.info('[Prewarm] Zero-Latency Cache Hit! Awaiting pre-fetched PlaybackInfo for:', options.itemId);
            try {
                const prewarmedData = await prewarmedPromise;
                if (prewarmedData && prewarmedData.MediaSources?.length) {
                    const firstSource = prewarmedData.MediaSources[0];

                    // =================================================================
                    // Safeguard Against Audio-Transcode Induced Prewarm Corruption
                    // =================================================================
                    // If the prewarmed PlaybackInfo forced transcoding specifically because
                    // of 'AudioCodecNotSupported', but the active session resolved a playable
                    // audio track in DirectPlay or Auto mode, the prewarmed data was generated
                    // against an unsupported default stream (e.g. TrueHD 7.1). Consuming it
                    // would force server HLS transcoding and break Dolby Vision dynamic metadata.
                    // Discard this prewarmed data immediately and fall back to a fresh request.
                    // =================================================================
                    const isAudioCodecError =
                        firstSource.TranscodingUrl &&
                        firstSource.TranscodingUrl.includes('TranscodeReasons=AudioCodecNotSupported');

                    // =================================================================
                    // Safeguard Against Prewarmed DirectPlay with Active MKV Remux
                    // =================================================================
                    // If the user enabled "Remux MKV to MP4", but the prewarmed PlaybackInfo
                    // cached DirectPlay for an MKV file, discard the cached response so
                    // we make a fresh request with 'mkv' stripped from DirectPlayProfiles.
                    // =================================================================
                    const remuxMkvToMp4Setting = PlayerSettings.get('remuxMkvToMp4');
                    const prewarmedContainer = (
                        firstSource.Container ||
                        options.item?.Container ||
                        options.item?.MediaSources?.[0]?.Container ||
                        ''
                    ).toLowerCase();
                    const isPrewarmedMkv = prewarmedContainer === 'mkv' ||
                        prewarmedContainer === 'matroska' ||
                        prewarmedContainer.includes('mkv');

                    // Start position of a prewarmed progressive transcode (null for HLS and direct play)
                    const prewarmedStartTicks = MediaHelper.getProgressiveTranscodeStartTicks(firstSource);

                    // Resolve whether the active audio track is actually playable natively on this backend
                    const activeAudioTrack = firstSource.MediaStreams?.find(
                        (s) => s.Type === 'Audio' && s.Index === Number(options.audioStreamIndex)
                    );
                    const isActiveAudioPlayable = activeAudioTrack
                        ? isAudioTrackNativelyPlayable(activeAudioTrack, firstSource, this._backendType)
                        : true;

                    // =================================================================
                    // Safeguard Against Prewarmed Transcode when Force Direct Play Active
                    // =================================================================
                    // When the user has Force Direct Play active ('all', 'video', or 'audio'),
                    // or Force Transcode active, the cached response must align with that policy.
                    // If prewarmed data resolved to a server transcode while direct play is forced,
                    // or cached direct play while transcode is forced, discard it immediately.
                    // =================================================================
                    const activeForceDirectPlay = PlayerSettings.get('forceDirectPlay');
                    const activeForceTranscode = Boolean(PlayerSettings.get('forceTranscode'));
                    const isStrictDirectPlay = activeForceDirectPlay === 'all' || activeForceDirectPlay === true;
                    const isVideoDirectPlayForced = activeForceDirectPlay === 'video';
                    const isAudioDirectPlayForced = activeForceDirectPlay === 'audio';
                    const isPrewarmedTranscoding = firstSource.SupportsDirectPlay === false || Boolean(firstSource.TranscodingUrl);

                    if (activeForceTranscode && (firstSource.SupportsDirectPlay || firstSource.SupportsDirectStream)) {
                        log.info(
                            '[Prewarm] Prewarmed PlaybackInfo cached direct stream/play, but Force Transcode is active. ' +
                            'Discarding in favor of fresh transcode request.'
                        );
                    } else if (isStrictDirectPlay && isPrewarmedTranscoding) {
                        log.warn(
                            '[Prewarm] Prewarmed PlaybackInfo resolved to Transcode, but Force Direct Play (all) is active. ' +
                            'Discarding in favor of fresh direct-play request.'
                        );
                    } else if (isVideoDirectPlayForced && firstSource.SupportsDirectPlay === false && firstSource.SupportsDirectStream === false) {
                        log.warn(
                            '[Prewarm] Prewarmed PlaybackInfo requires full Transcode, but Force Direct Play (video) is active. ' +
                            'Discarding in favor of fresh direct-play request.'
                        );
                    } else if (isAudioDirectPlayForced && firstSource.TranscodingUrl && firstSource.TranscodingUrl.includes('TranscodeReasons=AudioCodecNotSupported')) {
                        log.warn(
                            '[Prewarm] Prewarmed PlaybackInfo transcodes audio, but Force Direct Play (audio) is active. ' +
                            'Discarding in favor of fresh direct-play request.'
                        );
                    } else if (isAudioCodecError && isActiveAudioPlayable && (this._playbackMode === 'auto' || this._playbackMode === 'directPlay')) {
                        log.warn(
                            '[Prewarm] Prewarmed PlaybackInfo forced transcode for AudioCodecNotSupported despite track being playable. Discarding in favor of fresh direct-play request.'
                        );
                    } else if (deviceProfile?.DirectPlayProfiles?.length === 0 && firstSource.SupportsDirectPlay) {
                        log.info(
                            '[Prewarm] Prewarmed PlaybackInfo cached DirectPlay, but active track requires Remux. Discarding in favor of fresh direct-stream request.'
                        );
                    } else if (remuxMkvToMp4Setting && isPrewarmedMkv && this._playbackMode === 'transcode' && (firstSource.SupportsDirectPlay || firstSource.SupportsDirectStream)) {
                        log.info(
                            '[Prewarm] Prewarmed PlaybackInfo cached DirectPlay/DirectStream, but active mode requires Transcode. Discarding in favor of fresh transcode request.'
                        );
                    } else if (prewarmedStartTicks !== null && prewarmedStartTicks !== (options.startPositionTicks || 0)) {
                        // A progressive (non-HLS) transcode starts at the position in its URL;
                        // HLS playlists always cover the whole timeline
                        log.info(
                            '[Prewarm] Prewarmed progressive transcode starts at another position (e.g. "start from beginning"). Discarding in favor of a fresh request.'
                        );
                    } else {
                        return prewarmedData;
                    }
                }
            } catch (err) {
                log.warn('[Prewarm] Prewarmed PlaybackInfo failed, falling back to fresh request:', err);
            }
        }

        const url = `${this.serverUrl}/Items/${options.itemId}/PlaybackInfo?UserId=${options.userId}`;

        /*
         * Audio items (Music, Audiobooks) do NOT have subtitle streams.
         * The Jellyfin server returns HTTP 500 if SubtitleStreamIndex is
         * present in the request body for Audio-type items. Only send it
         * for Video items where subtitle selection makes sense.
         */
        const isAudioItem = (options.item?.MediaType === 'Audio') ||
            (options.item?.Type === 'Audio') ||
            (options.item?.Type === 'MusicAlbum') ||
            (options.item?.Type === 'MusicArtist') ||
            (options.item?.Type === 'Artist') ||
            (options.item?.Type === 'AudioBook') ||
            (options.item?.Type === 'PodcastEpisode');

        // Deep clone the device profile so we can mutilate it to trick the server without affecting future calls
        const clonedProfile = JSON.parse(JSON.stringify(deviceProfile || buildJellyfinProfile(maxBitrate)));

        const requestBody = {
            DeviceProfile: clonedProfile,
            UserId: options.userId,
            MaxStreamingBitrate: maxBitrate,
            StartTimeTicks: options.startPositionTicks || 0,
            AutoOpenLiveStream: true,
            IsPlayback: true,
            // Default to true for both, let server profiles decide unless strictly overridden below
            EnableDirectPlay: true,
            EnableDirectStream: true
        };

        // ---------------------------------------------------------------------
        // Playback Mode Priority: In-Player Selection vs Settings Defaults
        // ---------------------------------------------------------------------
        // User selections made inside the active player session (via the OSD
        // Playback Mode menu or Quality menu manual bitrate cap) MUST take
        // precedence over global default settings.
        // ---------------------------------------------------------------------
        const explicitPlayerMode = (options.playbackMode && options.playbackMode !== 'auto')
            ? options.playbackMode
            : (this._playbackMode && this._playbackMode !== 'auto' ? this._playbackMode : null);

        const hasManualBitrate = typeof manualBitrate === 'number' && manualBitrate > 0 && manualBitrate < 120000000;

        let currentMode = 'auto';

        if (explicitPlayerMode) {
            // In-player selection explicitly chosen (remux, transcode, transcodeVideo, transcodeAudio, directPlay)
            currentMode = explicitPlayerMode;
            log.info(`[PlaybackMode] Honoring explicit in-player mode selection: ${currentMode}`);
        } else if (hasManualBitrate) {
            // Manual bitrate cap requires transcoding
            currentMode = 'transcode';
            log.info(`[PlaybackMode] Manual bitrate limit active (${manualBitrate} bps): using transcode mode`);
        } else {
            // Default policy from global user settings
            const forceTranscodeSetting = PlayerSettings.get('forceTranscode');
            const forceDirectPlaySetting = PlayerSettings.get('forceDirectPlay');

            if (forceTranscodeSetting) {
                currentMode = 'transcode';
            } else if (forceDirectPlaySetting === 'all' || forceDirectPlaySetting === true) {
                currentMode = 'directPlay';
            } else if (forceDirectPlaySetting === 'video') {
                currentMode = 'forceDirectPlayVideo';
            } else if (forceDirectPlaySetting === 'audio') {
                currentMode = 'forceDirectPlayAudio';
            }
        }

        switch (currentMode) {
            case 'directPlay':
                // Enforce strict Direct Play: direct play all audio and video formats natively
                requestBody.EnableDirectPlay = true;
                requestBody.EnableDirectStream = false;
                requestBody.EnableTranscoding = false;
                requestBody.AllowVideoStreamCopy = false;
                requestBody.AllowAudioStreamCopy = false;

                // Nuclear option: declare support for all formats so server streams raw file
                requestBody.DeviceProfile.DirectPlayProfiles = [{
                    Container: 'm4v,3gp,ts,mpegts,mov,xvid,vob,mkv,wmv,asf,ogm,ogv,m2v,avi,mpg,mpeg,mp4,webm,wtv,dvr-ms,m2ts,rmvb,mxf',
                    AudioCodec: 'aac,mp3,mpa,wav,wma,wv,flac,ogg,oga,vorbis,ac3,eac3,dts,dtshd,opus,truehd,alac',
                    VideoCodec: 'h264,h265,hevc,vp8,vp9,mpeg1video,mpeg2video,mpeg4,wmv2,wmv3,vcl,theora,vc1,mpeg,h263,msmpeg4,av1',
                    Type: 'Video'
                }, {
                    Container: 'aac,mp3,mpa,wav,wma,wv,flac,ogg,oga,vorbis,ac3,eac3,dts,dtshd,opus,truehd,alac',
                    AudioCodec: 'aac,mp3,mpa,wav,wma,wv,flac,ogg,oga,vorbis,ac3,eac3,dts,dtshd,opus,truehd,alac',
                    Type: 'Audio'
                }];
                // Clear any transcoding profiles and ALL codec limits to prevent false transcode
                requestBody.DeviceProfile.TranscodingProfiles = [];
                requestBody.DeviceProfile.DirectStreamProfiles = [];
                requestBody.DeviceProfile.CodecProfiles = [];
                requestBody.DeviceProfile.ContainerProfiles = [];

                log.info('PlaybackInfo API Override: Enforcing STRICT Direct Play (Safeguarded DeviceProfile)');
                break;
            case 'forceDirectPlayVideo': {
                // Enforce Direct Play for video codecs only:
                // Video is always stream-copied or direct-played without server re-encoding.
                // EnableTranscoding and EnableDirectStream remain enabled so that
                // if the audio track is unsupported, the server remuxes/transcodes audio only.
                requestBody.EnableDirectPlay = true;
                requestBody.EnableDirectStream = true;
                requestBody.EnableTranscoding = true;
                requestBody.AllowVideoStreamCopy = true;
                requestBody.AllowAudioStreamCopy = true;

                // Expand video codecs and containers in DirectPlayProfiles to include all common video formats
                const allVideoContainers = 'm4v,3gp,ts,mpegts,mov,xvid,vob,mkv,wmv,asf,ogm,ogv,m2v,avi,mpg,mpeg,mp4,webm,wtv,dvr-ms,m2ts,rmvb,mxf';
                const allVideoCodecs = 'h264,h265,hevc,vp8,vp9,mpeg1video,mpeg2video,mpeg4,wmv2,wmv3,vcl,theora,vc1,mpeg,h263,msmpeg4,av1';

                if (Array.isArray(requestBody.DeviceProfile.DirectPlayProfiles)) {
                    // Extract existing supported audio codecs from the profile
                    const supportedAudioCodecs = requestBody.DeviceProfile.DirectPlayProfiles
                        .filter(p => p.Type === 'Video' && p.AudioCodec)
                        .map(p => p.AudioCodec)
                        .join(',');
                    const audioCodecsList = supportedAudioCodecs || 'aac,mp3,ac3,eac3,flac,vorbis,opus';

                    requestBody.DeviceProfile.DirectPlayProfiles = [{
                        Container: allVideoContainers,
                        AudioCodec: audioCodecsList,
                        VideoCodec: allVideoCodecs,
                        Type: 'Video'
                    }, {
                        Container: 'aac,mp3,mpa,wav,wma,wv,flac,ogg,oga,vorbis,ac3,eac3,dts,dtshd,opus,truehd,alac',
                        AudioCodec: 'aac,mp3,mpa,wav,wma,wv,flac,ogg,oga,vorbis,ac3,eac3,dts,dtshd,opus,truehd,alac',
                        Type: 'Audio'
                    }];
                }

                // Strip video codec restrictions from CodecProfiles so video is always stream-copied
                if (Array.isArray(requestBody.DeviceProfile.CodecProfiles)) {
                    requestBody.DeviceProfile.CodecProfiles = requestBody.DeviceProfile.CodecProfiles.filter(p => p.Type !== 'Video' && p.Type !== 'VideoAudio');
                }

                log.info('PlaybackInfo API Override: Enforcing Video Direct Play Only (Audio transcode allowed)');
                break;
            }
            case 'forceDirectPlayAudio': {
                // Enforce Direct Play for audio codecs only:
                // Audio is always stream-copied or direct-played without server re-encoding.
                // EnableTranscoding and EnableDirectStream remain enabled so that
                // if the video track is unsupported, the server transcodes video only.
                requestBody.EnableDirectPlay = true;
                requestBody.EnableDirectStream = true;
                requestBody.EnableTranscoding = true;
                requestBody.AllowVideoStreamCopy = true;
                requestBody.AllowAudioStreamCopy = true;

                const allAudioCodecs = 'aac,mp3,mpa,wav,wma,wv,flac,ogg,oga,vorbis,ac3,eac3,dts,dtshd,opus,truehd,alac';
                const allContainersList = 'm4v,3gp,ts,mpegts,mov,xvid,vob,mkv,wmv,asf,ogm,ogv,m2v,avi,mpg,mpeg,mp4,webm,wtv,dvr-ms,m2ts,rmvb,mxf';

                if (Array.isArray(requestBody.DeviceProfile.DirectPlayProfiles)) {
                    // Extract existing supported video codecs from the profile
                    const supportedVideoCodecs = requestBody.DeviceProfile.DirectPlayProfiles
                        .filter(p => p.Type === 'Video' && p.VideoCodec)
                        .map(p => p.VideoCodec)
                        .join(',');
                    const videoCodecsList = supportedVideoCodecs || 'h264,hevc,vp9,av1';

                    requestBody.DeviceProfile.DirectPlayProfiles = [{
                        Container: allContainersList,
                        AudioCodec: allAudioCodecs,
                        VideoCodec: videoCodecsList,
                        Type: 'Video'
                    }, {
                        Container: allAudioCodecs,
                        AudioCodec: allAudioCodecs,
                        Type: 'Audio'
                    }];
                }

                // Strip audio codec restrictions from CodecProfiles so audio is always stream-copied
                if (Array.isArray(requestBody.DeviceProfile.CodecProfiles)) {
                    requestBody.DeviceProfile.CodecProfiles = requestBody.DeviceProfile.CodecProfiles.filter(p => p.Type !== 'Audio');
                }

                log.info('PlaybackInfo API Override: Enforcing Audio Direct Play Only (Video transcode allowed)');
                break;
            }
            case 'remux':
                requestBody.EnableDirectPlay = false;
                requestBody.EnableDirectStream = true;
                // EnableTranscoding must be true for Jellyfin to process a Remux stream
                requestBody.EnableTranscoding = true;
                requestBody.AllowVideoStreamCopy = true;
                requestBody.AllowAudioStreamCopy = true;

                // Clear ALL codec limits to prevent "VideoBitDepthNotSupported" etc which block generic remux
                requestBody.DeviceProfile.CodecProfiles = [];
                requestBody.DeviceProfile.ContainerProfiles = [];
                requestBody.DeviceProfile.DirectPlayProfiles = [];

                log.info('PlaybackInfo API Override: Enforcing STRICT Remuxing (Safeguarded DeviceProfile)');
                break;
            case 'transcodeVideo':
                requestBody.EnableDirectPlay = false;
                requestBody.EnableDirectStream = true;
                requestBody.EnableTranscoding = true;
                requestBody.AllowVideoStreamCopy = false;
                requestBody.AllowAudioStreamCopy = true;
                requestBody.DeviceProfile.DirectPlayProfiles = [];
                log.info('PlaybackInfo API Override: Enforcing Video Transcode Only (Audio Copy)');
                break;
            case 'transcodeAudio':
                requestBody.EnableDirectPlay = false;
                requestBody.EnableDirectStream = true;
                requestBody.EnableTranscoding = true;
                requestBody.AllowVideoStreamCopy = true;
                requestBody.AllowAudioStreamCopy = false;
                requestBody.DeviceProfile.DirectPlayProfiles = [];
                log.info('PlaybackInfo API Override: Enforcing Audio Transcode Only (Video Stream Copy)');
                break;
            case 'transcode':
                requestBody.EnableDirectPlay = false;
                requestBody.EnableDirectStream = false;
                requestBody.EnableTranscoding = true;
                requestBody.AllowVideoStreamCopy = false;
                requestBody.AllowAudioStreamCopy = false;

                // Force server to drop standard formats so it transcodes
                requestBody.DeviceProfile.DirectPlayProfiles = [];
                requestBody.DeviceProfile.DirectStreamProfiles = [];

                log.info('PlaybackInfo API Override: Enforcing STRICT Transcoding (No stream copying)');
                break;
            case 'auto':
            default:
                // Keep defaults, Server and DeviceProfile make the decision
                break;
        }

        // -------------------------------------------------------------------------
        // MKV → MP4 Remux Enforcement
        // -------------------------------------------------------------------------
        // If the user enabled "Remux MKV to MP4", we surgically remove 'mkv' from
        // every DirectPlayProfile entry in the cloned device profile — but ONLY when
        // the item being played is actually an MKV container. The server then cannot
        // DirectPlay that MKV file and falls back to DirectStream, which remuxes the
        // container into MP4 (lossless stream copy — no re-encoding).
        //
        // We also skip when already in a locked override mode (directPlay / transcode /
        // remux) since those modes rebuild the profile wholesale themselves.
        const remuxMkvToMp4Setting = PlayerSettings.get('remuxMkvToMp4');
        const modeLockedProfiles = currentMode === 'directPlay' || currentMode === 'transcode' || currentMode === 'remux';
        // Treat both 'mkv' and 'matroska' as Matroska containers.
        // Check top-level item container, nested MediaSources[0].Container, and mediaSource.Container
        // because Jellyfin episode and item metadata responses frequently place the container
        // format under MediaSources rather than the root item object.
        const itemContainer = (
            options.item?.Container ||
            options.item?.MediaSources?.[0]?.Container ||
            options.mediaSource?.Container ||
            ''
        ).toLowerCase();
        const isMkvItem = itemContainer === 'mkv' || itemContainer === 'matroska' || itemContainer.includes('mkv');
        if (remuxMkvToMp4Setting && !modeLockedProfiles && isMkvItem) {
            const profiles = requestBody.DeviceProfile.DirectPlayProfiles;
            if (Array.isArray(profiles)) {
                for (const profile of profiles) {
                    if (typeof profile.Container === 'string') {
                        // Split the comma-separated container list, filter out 'mkv', rejoin
                        const containers = profile.Container.split(',').filter(c => c.trim() !== 'mkv');
                        profile.Container = containers.join(',');
                    }
                }
                // Remove any entries that became empty after stripping mkv
                requestBody.DeviceProfile.DirectPlayProfiles = profiles.filter(
                    p => typeof p.Container !== 'string' || p.Container.length > 0
                );
            }
            log.info('[RemuxMkvToMp4] Item container is MKV — stripping from DirectPlayProfiles so server remuxes to MP4.');
        } else if (remuxMkvToMp4Setting && !isMkvItem) {
            // Item is not MKV — leave the profile untouched, let the server DirectPlay normally
            log.debug(`[RemuxMkvToMp4] Setting enabled but item container "${itemContainer}" is not MKV — skipping.`);
        }


        // IMPORTANT: For Live TV channels, do NOT pass MediaSourceId in the PlaybackInfo request.
        // The server dynamically generates a MediaSourceId when it opens the tuner; passing the
        // channel's ItemId as MediaSourceId causes the server's source-matching logic to fail
        // with "NoCompatibleStream" because it tries to find a pre-existing specific source.
        const isLiveChannel = options.item?.Type === 'TvChannel';
        if (options.mediaSourceId && !isLiveChannel) {
            requestBody.MediaSourceId = options.mediaSourceId;
        }


        // For Audio items, sending SubtitleStreamIndex often causes an HTTP 500 
        // from the Jellyfin server. Therefore, we entirely omit it for audio playback.
        // However, we MUST send AudioStreamIndex if available, even for audio tracks,
        // otherwise forced transcode requests will fail with a 500 error.
        if (options.audioStreamIndex !== undefined && options.audioStreamIndex !== null) {
            requestBody.AudioStreamIndex = options.audioStreamIndex;
        }


        if (!isAudioItem) {
            if (options.subtitleStreamIndex !== undefined && options.subtitleStreamIndex !== null) {
                requestBody.SubtitleStreamIndex = options.subtitleStreamIndex;
            }
        }

        /*
         * Construct the request headers for PlaybackInfo.
         * For Emby compatibility, we format the Authorization header
         * with the Emby scheme and pass the token in X-Emby-Token.
         * For Jellyfin, we use the standard MediaBrowser scheme containing the Token.
         */
        const headers = {
            'Content-Type': 'application/json'
        };

        if (api.isEmby()) {
            /*
             * Fetch client/device information formatted under the Emby schema.
             * Note that Emby's getAuthHeader() does not bake the token directly.
             */
            headers['Authorization'] = api.getAuthHeader();
            if (this.authToken) {
                headers['X-Emby-Token'] = this.authToken;
            }
        } else {
            // Standard Jellyfin Authorization format
            headers['Authorization'] = api.getAuthHeader(this.authToken);
        }

        let result;
        try {
            result = await MediaHelper.fetchWithTimeout(
                url,
                {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(requestBody)
                },
                PLAYBACK_INFO_TIMEOUT_MS,
                async (response) => {
                    if (!response.ok) {
                        let errorText = '';
                        try {
                            errorText = await response.text();
                        } catch (e) { }
                        return { response, errorText };
                    }
                    return { response, body: await response.json() };
                }
            );
        } catch (err) {
            // No answer at all is a network error, which play() does not escalate
            if (err?.name === 'TimeoutError') {
                const timeoutError = new Error(
                    `Failed to get playback info: the server did not answer within ${PLAYBACK_INFO_TIMEOUT_MS / 1000} s`
                );
                timeoutError.isNetworkError = true;
                throw timeoutError;
            }
            // fetch() rejects with a TypeError when the server cannot be reached
            if (err?.name === 'TypeError') {
                err.isNetworkError = true;
            }
            throw err;
        }

        if (!result.response.ok) {
            throw new Error(`Failed to get playback info: ${result.response.status} - ${result.errorText}`);
        }

        return result.body;
    }

    // ========================================================================
    // Cleanup
    // ========================================================================

    // ========================================================================
    // Manual Bitrate Control
    // ========================================================================

    /**
     * Set max bitrate and restart playback
     * @param {number} bitrate - Max bitrate in bps (0 = Auto)
     */
    async setMaxBitrate(bitrate) {
        if (!this._currentItem) return;

        log.info('Setting manual bitrate:', bitrate);

        // Update state (0 means null/Auto)
        this._manualBitrate = bitrate > 0 ? bitrate : null;

        // Capture current position to resume
        const currentTicks = this.getCurrentPositionTicks();

        // Strategy: Standard - Play from current position
        // This is more robust than seeking from 0 for HLS
        const playOptions = {
            ...this._currentPlayOptions,
            audioStreamIndex: this._currentAudioStreamIndex,
            subtitleStreamIndex: this._currentSubtitleStreamIndex,
            secondarySubtitleStreamIndex: this._currentSecondarySubtitleStreamIndex,
            startPositionTicks: currentTicks,
            playbackMode: this._playbackMode
        };

        // Restart playback
        this._isRestarting = true;
        this._restartOwner = playOptions;

        try {
            // Trigger loading state immediately
            this.emit(PlayerEvent.RESTARTING);

            await this.stop({ restart: true });
            // _manualBitrate is preserved: this is the restart's own stop()

            // Tizen: Give AVPlay time to cleanup
            await this._playAfterRestartPause(playOptions, 500);

            // No manual seek needed - server starts transcode at correct offset
            // and MediaHelper handles the time reporting offset.
        } catch (e) {
            log.error('Failed to restart with new bitrate:', e);
        } finally {
            // play() never clears this flag. Left set, it disabled every later
            // recovery path (escalation, resume fallback, remux watchdog),
            // silenced every later play() error, and stop() stopped emitting
            // STOP events, for the rest of the session. Unless a newer restart
            // has taken over meanwhile.
            if (this._restartOwner === playOptions) {
                this._isRestarting = false;
            }
        }
    }


    /**
     * Get current max bitrate setting
     * @returns {number} Current bitrate limit (0 = Auto)
     */
    getMaxBitrate() {
        return this._manualBitrate || 0;
    }

    /**
     * Playback mode the user chose ('auto', 'remux', 'transcode', ...)
     * @returns {string}
     */
    getPlaybackMode() {
        // Not the current item's mode: play() and the restart flows switch an
        // item to remux or transcode on their own. PlayerPage passes this
        // mode to the next item, and the Playback Mode menu shows it as the
        // selection.
        return this._userPlaybackMode;
    }

    /**
     * Force a specific playback mode and restart if playing
     * @param {string} mode - 'auto', 'directPlay', 'transcode', 'remux',
     *                        'transcodeVideo', 'transcodeAudio'
     */
    async setPlaybackMode(mode) {
        // ----------------------------------------------------------------
        // Validate the incoming mode against the full supported set.
        // 'transcodeVideo' → copy video + transcode audio (partial transcode)
        // 'transcodeAudio' → transcode video + copy audio (partial transcode)
        // ----------------------------------------------------------------
        if (!['auto', 'directPlay', 'transcode', 'remux', 'transcodeVideo', 'transcodeAudio'].includes(mode)) return;

        // The Playback Mode menu shows getPlaybackMode(): confirming that one
        // changes nothing (an item remuxed for its audio track would only be
        // restarted into the same remux)
        if (mode === this.getPlaybackMode()) return;

        // A mode picked here is the user's, also for the next items, and replaces
        // the mode a restart of the item fell back to
        this._userPlaybackMode = mode;
        this._itemFallbackMode = null;

        // The item may already play in it (the remux play() chose for its
        // audio track, the transcode a failed direct play fell back to)
        if (this._playbackMode === mode) return;

        this._playbackMode = mode;
        log.info(`Playback mode set to: ${mode}`);

        // Re-initialize playback if active
        // Check for specific backend states that imply activity
        if (this._isPlaying || this._isPaused || this._state === 'buffering') {
            log.info('Restarting playback to apply new mode');

            if (this._lastPlayOptions) {
                const currentTicks = this.getCurrentPositionTicks();
                const newOptions = {
                    ...this._lastPlayOptions,
                    audioStreamIndex: this._currentAudioStreamIndex,
                    subtitleStreamIndex: this._currentSubtitleStreamIndex,
                    secondarySubtitleStreamIndex: this._currentSecondarySubtitleStreamIndex,
                    startPositionTicks: currentTicks,
                    playbackMode: mode
                };

                // Reuse restart logic pattern from setMaxBitrate
                this._isRestarting = true;
                this._restartOwner = newOptions;

                try {
                    this.emit(PlayerEvent.RESTARTING);
                    await this.stop({ restart: true });
                    // Give backend time to cleanup
                    await this._playAfterRestartPause(newOptions, 500);
                    // _isRestarting reset in play() success path implicitly? 
                    // No, wait. play() calls stop(). stop() checks _isRestarting.
                    // But play() sets _isRestarting = false ?
                    // Let's check play():
                    // play() calls stop().
                    // play() calls _resetState().
                    // _resetState() does NOT play with _isRestarting ??
                    // Actually setMaxBitrate comment says: " _isRestarting is reset to false in play() success"
                    // checking play():
                    // it does NOT seem to reset _isRestarting explicitly.
                    // Wait, stop() checks _isRestarting.

                    // Actually, looking at setMaxBitrate, it sets `this._isRestarting = true;`.
                    // Then calls `stop()`. `stop()` sees true, so it doesn't emit STOP events.
                    // Then `play()` is called. `play()` calls `stop()` again (first thing).
                    // `stop()` sees true again.
                    // Then `play()` proceeds.

                    // The issue is: when does `_isRestarting` go back to false?
                    // `setMaxBitrate` does NOT set it back to false in try block!
                    // This looks like a bug in `setMaxBitrate` potentially, or I missed where it is reset.
                    // I should check `_resetState` or `play`.

                    // If `_isRestarting` stays true, subsequent stops won't emit events?
                    // Let's check `_resetState`.
                } catch (e) {
                    log.error('Failed to restart after mode change:', e);
                }

                // Unless a newer restart has taken over meanwhile
                if (this._restartOwner === newOptions) {
                    this._isRestarting = false;
                }
            }
        }
    }

    /**
     * Destroy the player and clean up resources
     */
    destroy() {
        log.info('destroy() called');
        this.stop();

        // Destroy subtitle manager BEFORE the backend — the PGS download loop
        // checks _isDestroyed / _pgsLoadToken (set by SubtitleManager.destroy())
        // to abort any in-flight chunked fetch. If we destroy the backend first
        // the HTML video element goes away but libpgs may still be running.
        if (this._subtitleManager) {
            this._subtitleManager.destroy();
            this._subtitleManager = null;
        }

        this._backend?.destroy();
        this._backend = null;
        this.removeAllListeners();
        log.info('destroy() complete');
    }
}
