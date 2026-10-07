/**
 * ============================================================================
 * Litefin - Movi Video Player Backend
 * ============================================================================
 * Hardware-accelerated and container-agnostic video player backend powered by
 * movi-player (FFmpeg libavformat WebAssembly demuxer + WebCodecs API + WebGL2).
 *
 * Designed primarily for desktop releases of Litefin (Windows, macOS, Linux),
 * enabling native Direct Play of MKV, MP4, and WebM containers with HEVC, AV1,
 * VP9, H.264 video, and multi-channel AC-3, E-AC-3, TrueHD, DTS, Opus, and FLAC
 * audio without requiring server-side transcoding or remuxing.
 *
 * Architecture & Integration:
 * - Implements the identical backend interface as HtmlVideoPlayer & TizenAVPlayer.
 * - Wraps the <movi-player> custom element with controls disabled, delegating
 *   all UI and user interaction to Litefin's native OSDController.
 * - Synchronizes audio track switching directly within the WASM demuxer.
 * - Bridges stream events into Litefin's PlayerEvent bus for SubtitleManager,
 *   TrickplayManager, and server progress reporting.
 *
 * @module core/MoviVideoPlayer
 * ============================================================================
 */

import { logger } from '../../utils/Logger.js';
import { MediaHelper } from './MediaHelper.js';
import { PlayerEvent } from './JellyfinPlayer.js';
import { storage } from '../../utils/StorageService.js';
import { eventBus } from '../../core/EventBus.js';


// Dedicated logger channels
const log = logger.create('MoviVideoPlayer');
const engineLog = logger.create('MoviEngine');

// ----------------------------------------------------------------------------
// Global Logging Interception State
// ----------------------------------------------------------------------------
// Track global movi-player internal logger interception to avoid duplicate wrappers
let moviLoggingConfigured = false;

// Cached reference to dynamically imported movi-player module
let cachedMoviModule = null;

// Track whether the eventBus listener for debug log preference is registered
let moviLoggingEventBusBound = false;

/**
 * Dynamically adjusts the log level on the underlying movi-player WebAssembly
 * demuxer and JavaScript engine logger based on the user's debug preferences.
 *
 * @param {boolean} enabled - Whether verbose engine debug logs should be emitted
 */
export function configureMoviEngineLogging(enabled) {
    // If movi-player module hasn't been imported yet, nothing to adjust
    if (!cachedMoviModule) {
        return;
    }

    const MoviPlayer = cachedMoviModule.MoviPlayer;
    const MoviLogger = cachedMoviModule.Logger;
    const LogLevel = cachedMoviModule.LogLevel;

    // Use DEBUG (4) when enabled, otherwise SILENT (0) to suppress low-level demuxer output
    const targetLevel = enabled
        ? (LogLevel?.DEBUG ?? 4)
        : (LogLevel?.SILENT ?? 0);

    // Update WebAssembly demuxer and C-level FFmpeg log level
    if (MoviPlayer && typeof MoviPlayer.setLogLevel === 'function') {
        try {
            MoviPlayer.setLogLevel(targetLevel);
            log.info(`MoviPlayer WebAssembly demuxer log level set to: ${enabled ? 'DEBUG' : 'SILENT'}`);
        } catch (err) {
            log.warn('Could not update MoviPlayer WASM log level:', err);
        }
    }

    // Update JS-level Logger threshold
    if (MoviLogger && typeof MoviLogger.setLevel === 'function') {
        try {
            MoviLogger.setLevel(targetLevel);
            log.info(`MoviLogger JS level set to: ${enabled ? 'DEBUG' : 'SILENT'}`);
        } catch (err) {
            log.warn('Could not update MoviLogger JS level:', err);
        }
    }
}

// Minimum seek difference in milliseconds to trigger a hardware seek
const SEEK_THRESHOLD_MS = 1000;

/*
 * ============================================================================
 * Startup Deadlock & Playback Health Constants
 * ============================================================================
 * Maximum time in milliseconds to wait for the WebAssembly demuxer and
 * WebCodecs hardware pipeline to emit the first presentation frame ('playing')
 * before tripping the startup failure watchdog. Prevents infinite loading screens
 * when stream endpoints fail to respond or codecs deadlock.
 * ============================================================================
 */
const STARTUP_TIMEOUT_MS = 15000;

// ============================================================================
// Movi Video Player Backend Class
// ============================================================================

export class MoviVideoPlayer {
    /**
     * @param {Object} options - Initialization options
     * @param {HTMLElement} options.container - DOM container hosting video elements
     * @param {Object} options.settings - PlayerSettings configuration manager
     * @param {Function} options.onEvent - Callback for normalized player events ({ type, data })
     */
    constructor(options) {
        this.container = options.container;
        this.settings = options.settings;
        this.onEvent = options.onEvent || (() => { });

        // Core player DOM elements and state
        this._moviElement = null;
        this._videoElement = null;
        this._currentSrc = null;
        this._currentPlayOptions = null;
        this._started = false;
        this._timeUpdated = false;
        this._startPositionTicks = 0;

        // Active track indexes
        this._currentAudioIndex = -1;
        this._currentSubtitleIndex = -1;
        this._subtitleOffset = 0;

        // Playback state tracking
        this._isPaused = false;
        this._isSeeking = false;
        this._playInitiated = false;
        this._lastTimeUpdateTicks = 0;

        // Startup watchdog timer preventing permanent loading freeze
        this._startupWatchdogTimer = null;

        // Bound event handler map for clean teardown and unbinding
        this._boundHandlers = {};

        // Module loading state
        this._isLoaded = false;
    }

    // ========================================================================
    // Module and Custom Element Initialization
    // ========================================================================

    /**
     * Bridges movi-player's internal Logger and FFmpeg WebAssembly log levels
     * directly into Litefin's centralized Logger system.
     *
     * Controlled by the 'debug_movi_logs' setting in the Settings Debug tab
     * (disabled by default). When enabled, demuxer, WebCodecs, WASM loader,
     * and audio pipeline diagnostics are routed into Litefin's log buffer.
     *
     * @private
     * @param {Object} moviModule - The dynamically imported movi-player module
     */
    _setupMoviEngineLogging(moviModule) {
        if (!moviModule) {
            return;
        }

        // Cache module reference for runtime log level adjustments
        cachedMoviModule = moviModule;

        // Register event listener once so toggling in Settings immediately applies
        if (!moviLoggingEventBusBound) {
            moviLoggingEventBusBound = true;
            eventBus.on('prefChanged:debug_movi_logs', (enabled) => {
                configureMoviEngineLogging(enabled);
            });
        }

        // Helper to check if engine logging is actively enabled by the user in Settings
        const isEngineLoggingEnabled = () => storage.getItem('debug_movi_logs') === 'true';

        // Apply initial log level based on current stored preference (defaults to disabled)
        configureMoviEngineLogging(isEngineLoggingEnabled());

        // Prevent re-hooking wrapper methods if already intercepted in the current session
        if (moviLoggingConfigured) {
            return;
        }
        moviLoggingConfigured = true;

        const MoviLogger = moviModule.Logger;

        // Bridge JS-level Logger methods directly to Litefin's centralized logger
        if (MoviLogger) {
            try {
                // Intercept error-level messages (demuxing failures, decoding stalls, network drops)
                MoviLogger.error = (tag, message, ...args) => {
                    engineLog.error(`[${tag}] ${message}`, ...args);
                };

                // Intercept warning-level messages (dropping frames, buffering renegotiations)
                MoviLogger.warn = (tag, message, ...args) => {
                    engineLog.warn(`[${tag}] ${message}`, ...args);
                };

                // Intercept informational messages (stream specs, codec detection, track counts)
                MoviLogger.info = (tag, message, ...args) => {
                    if (isEngineLoggingEnabled()) {
                        engineLog.info(`[${tag}] ${message}`, ...args);
                    }
                };

                // Intercept debug-level messages (PTS synchronization, seek offsets, buffer windows)
                MoviLogger.debug = (tag, message, ...args) => {
                    if (isEngineLoggingEnabled()) {
                        engineLog.debug(`[${tag}] ${message}`, ...args);
                    }
                };

                // Intercept trace-level messages
                MoviLogger.trace = (tag, message, ...args) => {
                    if (isEngineLoggingEnabled()) {
                        engineLog.verbose(`[${tag}] ${message}`, ...args);
                    }
                };

                log.info('Bridged movi-player internal engine logger to Litefin Logger [MoviEngine]');
            } catch (err) {
                log.warn('Failed to bridge movi-player internal logger:', err);
            }
        }
    }

    /**
     * Attaches an error listener to the underlying MoviPlayer engine instance
     * once instantiated on the custom element.
     *
     * @private
     * @param {HTMLElement} element - The <movi-player> element
     */
    _attachInnerPlayerErrorListener(element) {
        if (!element || !element.player) {
            return;
        }

        // Guard against duplicate event listener registration
        if (element._innerPlayerErrorBound) {
            return;
        }
        element._innerPlayerErrorBound = true;

        // Register error listener on inner engine instance
        if (typeof element.player.on === 'function') {
            element.player.on('error', (err) => {
                log.error('movi-player: Core engine reported error:', err);
            });
        }
    }

    /**
     * Ensures the movi-player web component bundle is registered in the DOM.
     * Uses dynamic import to allow smooth fallbacks on non-WASM runtimes.
     *
     * @private
     * @returns {Promise<boolean>} True if element is registered and ready.
     */
    async _ensureMoviRegistered() {
        if (typeof window === 'undefined') {
            return false;
        }

        // Check if the custom element is already registered
        if (window.customElements && window.customElements.get('movi-player')) {
            this._isLoaded = true;

            // Ensure logging bridge is configured even if custom element was already defined
            if (!moviLoggingConfigured) {
                try {
                    const moviModule = await import(/* webpackChunkName: "movi-player" */ 'movi-player');
                    this._setupMoviEngineLogging(moviModule);
                } catch (e) {
                    log.warn('Could not import movi-player for logging bridge initialization:', e);
                }
            }

            return true;
        }

        try {
            // Log entry into web component dynamic import
            log.info('Dynamically registering movi-player web component...');

            /*
             * -----------------------------------------------------------------
             * Bundle Web Component Registration
             * -----------------------------------------------------------------
             * Importing the root 'movi-player' bundle executes element.ts which
             * registers the custom HTML element <movi-player> with the browser's
             * CustomElementRegistry. Webpack bundles this into a dedicated chunk.
             * -----------------------------------------------------------------
             */
            const moviModule = await import(/* webpackChunkName: "movi-player" */ 'movi-player');

            // Initialize and configure movi-player internal logging
            this._setupMoviEngineLogging(moviModule);

            // Mark module as successfully loaded
            this._isLoaded = true;
            log.info('movi-player web component registered successfully');
            return true;
        } catch (err) {
            // Log registration failure if module cannot be found or loaded
            log.error('Failed to register movi-player custom element:', err);
            return false;
        }
    }

    /**
     * Create or retrieve the <movi-player> custom element.
     *
     * @private
     * @returns {HTMLElement} The <movi-player> DOM element
     */
    _ensurePlayerElement() {
        if (this._moviElement) {
            // Re-bind events if they were unbound during stop()
            if (Object.keys(this._boundHandlers).length === 0) {
                this._bindEvents(this._moviElement);
            }
            return this._moviElement;
        }

        // Instantiate the custom element
        const element = document.createElement('movi-player');
        element.className = 'jellyfin-video-player movi-player-container';

        // Configure presentation attributes
        // Disable built-in controls so Litefin's native OSD handles all UI
        element.removeAttribute('controls');
        element.setAttribute('objectfit', 'contain');
        element.setAttribute('playsinline', 'true');

        /*
         * -----------------------------------------------------------------
         * Local WebAssembly Binary & Autoplay Configuration
         * -----------------------------------------------------------------
         * Point the engine directly to the bundled movi.wasm copied by Webpack
         * to avoid external CDN resolution in offline / desktop runtimes.
         * Default to autoplay enabled so the WASM engine kicks off immediately.
         * -----------------------------------------------------------------
         */
        element.setAttribute('wasmurl', 'wasm/movi.wasm');
        element.setAttribute('autoplay', '');
        element.autoplay = true;

        /*
         * -----------------------------------------------------------------
         * Decouple Strict A/V Lockstep Stall Binding (bindav)
         * -----------------------------------------------------------------
         * By default, movi-player runs with bindav="true", locking audio and
         * video pipelines into rigid lockstep. When multi-channel lossless
         * streams (TrueHD / FLAC 5.1 / DTS) initialize, heavy software buffer
         * priming can stall video decoders from delivering until a multi-second
         * cushion is assembled. Setting bindav="false" unbinds the two pipelines,
         * permitting the escape timers to unfreeze frames and avoiding infinite
         * buffering stalls on initial load.
         * -----------------------------------------------------------------
         */
        element.setAttribute('bindav', 'false');

        /*
         * -----------------------------------------------------------------
         * Prevent Internal Track Persistence Hijacking (persist)
         * -----------------------------------------------------------------
         * MoviElement persists user language choices to localStorage / OPFS
         * (legacySettingsEnabled). When unconstrained, it silently restores
         * the previously remembered language (e.g. English TrueHD) over Litefin's
         * requested track (e.g. Japanese FLAC) during initial container load.
         * Setting persist="none" explicitly marks the host as owning track
         * persistence, disabling legacySettings and preventing unwanted track swaps.
         * -----------------------------------------------------------------
         */
        element.setAttribute('persist', 'none');


        // Apply saved system volume
        const savedVol = MediaHelper.getSavedVolume();
        element.volume = typeof savedVol === 'number' ? savedVol : 1.0;

        // Explicit layout box styling ensuring the custom element occupies the full container
        // without collapsing or falling back to inline layout on WebView runtimes
        element.style.position = 'absolute';
        element.style.top = '0';
        element.style.left = '0';
        element.style.width = '100%';
        element.style.height = '100%';
        element.style.display = 'block';
        element.style.backgroundColor = '#000000';

        // Ensure parent container exists
        if (!this.container) {
            this.container = document.createElement('div');
            this.container.className = 'jellyfin-player-container';
            document.body.appendChild(this.container);
        }

        this.container.appendChild(element);
        this._moviElement = element;
        this._videoElement = element;

        // Force initial layout size sync if engine is ready
        if (typeof element.updateCanvasSize === 'function') {
            try {
                element.updateCanvasSize();
            } catch (_) {}
        }

        // Bind DOM events to normalized Litefin events
        this._bindEvents(element);

        return element;
    }

    /**
     * Bind media events from the <movi-player> element to Litefin handlers.
     *
     * @private
     * @param {HTMLElement} element - The <movi-player> element
     */
    _bindEvents(element) {
        this._unbindEvents();

        // Attempt initial inner player error listener binding if engine is already created
        this._attachInnerPlayerErrorListener(element);

        const handlers = {
            loadstart: () => {
                log.debug('movi-player: loadstart');
                // Ensure inner player engine errors are tracked once initialization begins
                this._attachInnerPlayerErrorListener(element);
                this.onEvent({ type: PlayerEvent.LOAD_START });
            },

            loadedmetadata: () => {
                log.info(`movi-player: loadedmetadata (duration: ${element.duration}s)`);
                // Ensure inner player engine errors are tracked after demuxer metadata pass
                // Ensure internal WebGL canvas sizes are updated to match host box
                if (typeof element.updateCanvasSize === 'function') {
                    try {
                        element.updateCanvasSize();
                    } catch (_) {}
                }

                this.onEvent({
                    type: PlayerEvent.LOADED_METADATA,
                    data: { duration: element.duration }
                });

                /*
                 * -----------------------------------------------------------------
                 * Initial Audio Track Application
                 * -----------------------------------------------------------------
                 * Now that the demuxer has parsed the Matroska/MP4 container header,
                 * switch to the requested audio track explicitly.
                 *
                 * Crucial Fix: Check for >= 0 rather than > 0. When track index 0
                 * is selected (such as the primary FLAC stream), MoviElement's
                 * internal localStorage language persistence could otherwise take
                 * precedence and switch away to a secondary track (e.g. English TrueHD).
                 * Explicitly invoking setAudioStreamIndex(0) pins the user's desired
                 * stream regardless of persisted client preferences.
                 * -----------------------------------------------------------------
                 */
                if (typeof this._currentAudioIndex === 'number' && this._currentAudioIndex >= 0) {
                    log.info(`movi-player: Applying initial audio track index ${this._currentAudioIndex} after metadata load`);
                    this.setAudioStreamIndex(this._currentAudioIndex);
                }
            },

            canplay: () => {
                log.info('movi-player: canplay');
                this.onEvent({ type: PlayerEvent.CAN_PLAY });

                /*
                 * -----------------------------------------------------------------
                 * Autoplay Engagement
                 * -----------------------------------------------------------------
                 * If playback is requested and the web component sits in paused state
                 * at canplay, kick off playback via element.play() to begin rendering.
                 * Guard against re-entrancy if play() was already initiated during
                 * play(options) to prevent destroying and re-instantiating the inner
                 * engine pipeline mid-seek.
                 * -----------------------------------------------------------------
                 */
                if (!this._started && !this._playInitiated && this._currentPlayOptions?.autoPlay !== false && element.paused) {
                    log.info('movi-player: canplay fired while paused — starting playback');
                    element.play().catch(err => {
                        // Suppress expected AbortErrors when seeking or switching streams
                        if (err?.name === 'AbortError') {
                            log.debug('movi-player: element.play() execution in canplay aborted:', err);
                        } else {
                            log.error('movi-player: element.play() execution in canplay failed:', err);
                        }
                    });
                }
            },

            play: () => {
                log.debug('movi-player: play');
                this._isPaused = false;
                this.onEvent({ type: PlayerEvent.PLAY });
            },

            playing: () => {
                log.info('movi-player: playing');
                // Playback has successfully engaged; disarm startup timeout
                this._started = true;
                this._isPaused = false;
                this._clearStartupWatchdog();
                this.onEvent({ type: PlayerEvent.PLAYING });
            },

            pause: () => {
                log.debug('movi-player: pause');
                this._isPaused = true;
                this.onEvent({ type: PlayerEvent.PAUSE });
            },

            seeking: () => {
                log.debug('movi-player: seeking');
                this._isSeeking = true;
                this.onEvent({ type: PlayerEvent.SEEK });
            },

            seeked: () => {
                log.info(`movi-player: seeked to ${element.currentTime.toFixed(2)}s`);
                this._isSeeking = false;
                this.onEvent({
                    type: PlayerEvent.SEEKED,
                    data: { time: element.currentTime }
                });
            },

            timeupdate: () => {
                // If presentation time is advancing past 0s, disarm watchdog immediately
                if (!this._started && element.currentTime > 0) {
                    this._started = true;
                    this._clearStartupWatchdog();
                }

                // Throttle updates to ~4 times per second to prevent OSD thrashing
                const now = Date.now();
                if (now - this._lastTimeUpdateTicks < 250) {
                    return;
                }
                this._lastTimeUpdateTicks = now;
                this._timeUpdated = true;

                this.onEvent({
                    type: PlayerEvent.TIME_UPDATE,
                    data: { time: element.currentTime }
                });
            },

            waiting: () => {
                log.debug('movi-player: waiting / buffering');
                this.onEvent({ type: PlayerEvent.WAITING });
            },

            stalled: () => {
                log.debug('movi-player: stalled');
                this.onEvent({ type: PlayerEvent.WAITING });
            },

            ended: () => {
                log.info('movi-player: playback ended');
                this.onEvent({ type: PlayerEvent.ENDED });
            },

            volumechange: () => {
                this.onEvent({
                    type: PlayerEvent.VOLUME_CHANGE,
                    data: {
                        volume: Math.round(element.volume * 100),
                        muted: element.muted
                    }
                });
            },

            /*
             * -----------------------------------------------------------------
             * Error Event Handlers
             * -----------------------------------------------------------------
             * movi-player dispatches standard 'error' events (CustomEvent with detail)
             * as well as 'errordisplay' events for hardware decoder incompatibilities,
             * unplayable containers, and file parsing aborts.
             * -----------------------------------------------------------------
             */
            error: (event) => {
                // Disarm startup watchdog since an explicit playback error occurred
                this._clearStartupWatchdog();

                // Extract error details from event.detail (CustomEvent) or element.error
                const rawErr = event?.detail || element.error || event?.error || new Error('Unknown playback error');
                const formatted = MediaHelper.formatMediaError(rawErr);

                // Check for network or connectivity faults
                const isNetworkError = Boolean(
                    formatted.code === 2 ||
                    rawErr?.code === 2 ||
                    rawErr?.code === 'PLAYER_ERROR_CONNECTION_FAILED' ||
                    /network|fetch|http|connection|failed to fetch/i.test(formatted.message || rawErr?.message || '')
                );

                // Format comprehensive diagnostic log for the error logger
                log.error(
                    `movi-player: Playback error encountered (Code: ${formatted.code}, Name: ${formatted.name}): ${formatted.message}`,
                    formatted.details,
                    rawErr
                );

                // Forward normalized error event to JellyfinPlayer / PlayerPage
                this.onEvent({
                    type: PlayerEvent.ERROR,
                    data: {
                        ...formatted,
                        isNetworkError,
                        rawError: rawErr
                    }
                });
            },

            /*
             * =================================================================
             * Error Display Event Handler (<movi-player> custom event)
             * =================================================================
             * movi-player raises 'errordisplay' when it encounters format/codec
             * incompatibilities, corrupted streams, or network failures handled
             * by handleUnsupportedVideo(). These do NOT raise a standard 'error'
             * event, so intercepting 'errordisplay' is vital to preventing the
             * Litefin loading spinner from hanging forever over the player.
             * =================================================================
             */
            errordisplay: (event) => {
                // Cancel the startup timer since error display has been established
                this._clearStartupWatchdog();

                const detail = event?.detail || {};
                const title = detail.title || 'Playback Error';
                const message = detail.message || detail.title || 'Movi player encountered an unrecoverable playback error';

                // Log error screen details surfaced by the web component
                log.error(`movi-player: Error display surfaced — [${title}] ${message}`, detail);

                const isNetworkError = /network|connection|fetch|offline|dropped/i.test(`${title} ${message}`);

                // Inform player subscribers of the surfaced error screen
                this.onEvent({
                    type: PlayerEvent.ERROR,
                    data: {
                        code: -1,
                        name: title,
                        message: `${title}: ${message}`,
                        details: message,
                        isNetworkError,
                        canRetry: detail.canRetry,
                        canTrySoftware: detail.canTrySoftware
                    }
                });
            },

            /*
             * =================================================================
             * State Machine Change Listener
             * =================================================================
             * movi-player manages an explicit internal state machine. If state
             * transitions to 'error' without an explicit DOM error event, surface
             * the failure immediately.
             * =================================================================
             */
            statechange: (event) => {
                const state = event?.detail;
                log.debug(`movi-player: State changed to "${state}"`);

                // Capture transition to error state if element.error holds detail
                if (state === 'error') {
                    this._clearStartupWatchdog();

                    const elemError = element.error;
                    log.error('movi-player: Engine transitioned to error state:', elemError);

                    const formatted = elemError ? MediaHelper.formatMediaError(elemError) : {
                        code: -1,
                        name: 'ENGINE_ERROR_STATE',
                        message: 'Movi player transitioned to error state'
                    };

                    this.onEvent({
                        type: PlayerEvent.ERROR,
                        data: {
                            ...formatted,
                            rawError: elemError
                        }
                    });
                }
            },

            filerevoked: (event) => {
                const detail = event?.detail;
                log.error('movi-player: Stream file handle was revoked:', detail);

                // Surface fatal revoke as network/resource error
                this.onEvent({
                    type: PlayerEvent.ERROR,
                    data: {
                        code: -1,
                        name: 'FILE_REVOKED',
                        message: detail?.reason || 'Media file revoked or stream unavailable',
                        isNetworkError: true
                    }
                });
            },

            trackschange: (event) => {
                log.info('movi-player: trackschange event fired', event?.detail);
                // Ensure inner player engine errors are tracked after track demuxing
                this._attachInnerPlayerErrorListener(element);

                // Ensure inner engine bindav is false so audio prime does not block video presentation
                if (element.player && typeof element.player.setBindAV === 'function') {
                    try {
                        element.player.setBindAV(false);
                    } catch (_) {}
                }

                // When container streams are parsed, re-apply the user's requested audio track index
                if (typeof this._currentAudioIndex === 'number' && this._currentAudioIndex >= 0) {
                    log.info(`movi-player: Re-applying audio track index ${this._currentAudioIndex} on trackschange`);
                    this.setAudioStreamIndex(this._currentAudioIndex);
                }
            },

            nativeaudiounsupported: (event) => {
                log.error('movi-player: Native audio codec unsupported by browser runtime:', event?.detail);
            },

            smoothwarning: (event) => {
                log.warn('movi-player: Stream not expected to play smoothly on this hardware:', event?.detail);
            }
        };

        // Attach listeners and cache handles for removal
        for (const [eventName, handler] of Object.entries(handlers)) {
            element.addEventListener(eventName, handler);
            this._boundHandlers[eventName] = handler;
        }
    }

    /**
     * Arm the startup watchdog timer.
     * If playback does not begin (no 'playing' or positive 'timeupdate' event)
     * within the timeout period, an error is surfaced to prevent infinite loading.
     *
     * @private
     */
    _armStartupWatchdog() {
        this._clearStartupWatchdog();

        log.info(`movi-player: Arming startup watchdog (${STARTUP_TIMEOUT_MS}ms)`);
        this._startupWatchdogTimer = setTimeout(() => {
            if (!this._started) {
                const errorMsg = 'Playback failed to start within timeout. Check media source or try HTML5 / Transcode.';
                log.error(`movi-player: Startup watchdog triggered — ${errorMsg}`);

                this.onEvent({
                    type: PlayerEvent.ERROR,
                    data: {
                        code: -1,
                        message: errorMsg
                    }
                });
            }
        }, STARTUP_TIMEOUT_MS);
    }

    /**
     * Clear and disarm the startup watchdog timer.
     *
     * @private
     */
    _clearStartupWatchdog() {
        if (this._startupWatchdogTimer) {
            clearTimeout(this._startupWatchdogTimer);
            this._startupWatchdogTimer = null;
        }
    }

    /**
     * Unbind all event listeners from the active element.
     *
     * @private
     */
    _unbindEvents() {
        if (!this._moviElement || !this._boundHandlers) {
            return;
        }

        // Iterate over and remove all active DOM event listeners
        for (const [eventName, handler] of Object.entries(this._boundHandlers)) {
            this._moviElement.removeEventListener(eventName, handler);
        }
        this._boundHandlers = {};

        // Reset inner player binding marker
        if (this._moviElement) {
            this._moviElement._innerPlayerErrorBound = false;
        }
    }

    // ========================================================================
    // Public Playback Lifecycle Methods
    // ========================================================================

    /**
     * Get the underlying visual element (for layout and positioning).
     *
     * @returns {HTMLElement} The <movi-player> element.
     */
    getVideoElement() {
        return this._ensurePlayerElement();
    }

    /**
     * Start video playback with given Jellyfin stream options.
     *
     * @param {Object} options - Playback options
     * @param {string} options.url - Direct stream URL
     * @param {number} [options.startPositionTicks=0] - Initial resume offset in ticks
     * @param {number} [options.audioStreamIndex] - Selected audio stream index
     * @param {number} [options.subtitleStreamIndex] - Selected subtitle stream index
     * @param {Object} [options.headers] - Authorization headers
     * @returns {Promise<void>}
     */
    async play(options) {
        log.info('MoviVideoPlayer.play() called with URL:', options?.url);
        this._currentPlayOptions = options;
        this._currentSrc = options.url;
        this._started = false;
        this._timeUpdated = false;
        this._startPositionTicks = options.startPositionTicks || 0;

        // Ensure custom element is registered
        await this._ensureMoviRegistered();

        const playerElement = this._ensurePlayerElement();

        // Connect error tracking directly to the inner engine if already instantiated
        this._attachInnerPlayerErrorListener(playerElement);

        // If the custom element is awaiting registration/upgrade, wait for it
        if (typeof window !== 'undefined' && window.customElements && typeof window.customElements.whenDefined === 'function') {
            try {
                await Promise.race([
                    window.customElements.whenDefined('movi-player'),
                    new Promise(resolve => setTimeout(resolve, 2000))
                ]);
            } catch (_) { }
        }

        // Verify that the element has been upgraded with the MoviPlayer API
        if (typeof playerElement.play !== 'function') {
            /*
             * -----------------------------------------------------------------
             * Missing Web Component Guard
             * -----------------------------------------------------------------
             * If the custom element was not upgraded (e.g. npm install has not
             * been executed in litefin to fetch movi-player), the HTML tag
             * exists in the DOM as an un-upgraded HTMLElement without methods.
             * -----------------------------------------------------------------
             */
            const errorMsg = 'MoviPlayer custom element is not registered or upgraded. Please run npm install in litefin.';
            log.error(`MoviVideoPlayer: ${errorMsg}`);

            // Dispatch error event to player subscribers
            this.onEvent({
                type: PlayerEvent.ERROR,
                data: { message: errorMsg }
            });

            /*
             * CRITICAL ARCHITECTURAL REQUIREMENT:
             * We must reject this promise by throwing an error. If play() resolves,
             * JellyfinPlayer and PlayerPage assume playback successfully started,
             * firing PLAYBACK_START and POST /Sessions/Playing to the Jellyfin server,
             * which subsequently overwrites the user's saved resume position with 0.
             */
            throw new Error(errorMsg);
        }

        // --------------------------------------------------------------------
        // Authentication & Custom Request Headers
        // --------------------------------------------------------------------
        // Forward Jellyfin authentication tokens to the player's network layer.
        // MoviPlayer sends these headers with all range requests and demuxer reads.
        // --------------------------------------------------------------------
        if (options.headers) {
            try {
                // Attach custom authorization and API key headers
                playerElement.headers = options.headers;
            } catch (e) {
                // Log warning if header attachment encounters a proxy error
                log.warn('Could not assign headers to movi-player:', e);
            }
        }

        /*
         * --------------------------------------------------------------------
         * Pre-configure Element Attributes Prior to Source Assignment
         * --------------------------------------------------------------------
         * MoviElement reads its attributes during the initial load() microtask.
         * Setting wasmurl, autoplay, and startat before setting .src guarantees
         * that the initial decoder pipeline starts at the resume position with
         * playback automatically engaged.
         * --------------------------------------------------------------------
         */
        const resumeSeconds = (options.startPositionTicks || 0) / 10000000;
        playerElement.setAttribute('wasmurl', 'wasm/movi.wasm');

        // Explicitly deactivate A/V binding to prevent deadlocks during high-bitrate audio priming
        playerElement.setAttribute('bindav', 'false');
        // Prevent MoviElement internal OPFS settings from hijacking audio language
        playerElement.setAttribute('persist', 'none');
        if (playerElement.player && typeof playerElement.player.setBindAV === 'function') {
            try {
                playerElement.player.setBindAV(false);
            } catch (_) {}
        }

        // Configure autoplay attribute and property
        if (options.autoPlay !== false) {
            playerElement.setAttribute('autoplay', '');
            playerElement.autoplay = true;
        } else {
            playerElement.removeAttribute('autoplay');
            playerElement.autoplay = false;
        }

        // Configure startat attribute and property for resume positioning
        if (resumeSeconds > 0) {
            log.info(`MoviVideoPlayer: Configuring initial resume startat to ${resumeSeconds.toFixed(2)}s`);
            playerElement.setAttribute('startat', resumeSeconds.toString());
            playerElement.startAt = resumeSeconds;
        } else {
            playerElement.removeAttribute('startat');
            playerElement.startAt = 0;
        }

        /*
         * --------------------------------------------------------------------
         * Initial Audio Track Index Resolution
         * --------------------------------------------------------------------
         * Cache the target 0-based audio track list index for metadata readiness.
         * Note: We prefer options.audioTrackListIndex (pre-computed by JellyfinPlayer
         * across audio-only streams). If omitted, we compute the list offset from
         * options.audioStreamIndex within the media source's audio streams.
         * --------------------------------------------------------------------
         */
        if (typeof options.audioTrackListIndex === 'number' && options.audioTrackListIndex >= 0) {
            this._currentAudioIndex = options.audioTrackListIndex;
        } else if (typeof options.audioStreamIndex === 'number' && options.mediaSource?.MediaStreams) {
            const audioStreams = options.mediaSource.MediaStreams.filter(s => s.Type === 'Audio');
            const foundIndex = audioStreams.findIndex(s => s.Index === options.audioStreamIndex);
            this._currentAudioIndex = foundIndex >= 0 ? foundIndex : 0;
        } else {
            // Default to track 0 (the primary audio stream in the container)
            this._currentAudioIndex = 0;
        }

        /*
         * --------------------------------------------------------------------
         * Arm Startup Deadlock Watchdog
         * --------------------------------------------------------------------
         * Because movi-player executes loading asynchronously and defers play()
         * during initial load, element.play() may resolve immediately while the
         * underlying pipeline attempts range requests and container parsing.
         * Arm a 15-second watchdog so if initial decoding fails to yield frames,
         * Litefin safely raises an error rather than spinning indefinitely.
         * --------------------------------------------------------------------
         */
        this._armStartupWatchdog();

        // Apply media source URL (triggers scheduleAttrLoad via microtask)
        playerElement.src = options.url;

        /*
         * --------------------------------------------------------------------
         * Begin Video Playback
         * --------------------------------------------------------------------
         * Trigger the custom element's play() promise. Rejections (autoplay policy
         * blocks, network aborts, or codec errors) are surfaced to JellyfinPlayer.
         * Resolving immediately allows PlayerPage to initialize the OSD and UI
         * without blocking the application thread.
         * --------------------------------------------------------------------
         */
        this._playInitiated = true;
        try {
            await playerElement.play();
            log.info('MoviVideoPlayer: play() resolved successfully');
        } catch (err) {
            // Cancel startup watchdog on immediate play rejection
            this._clearStartupWatchdog();

            // Check if play was aborted due to new load or user navigation
            if (err?.name === 'AbortError') {
                log.info('MoviVideoPlayer: play() promise aborted by new stream request:', err);
            } else {
                log.error('MoviVideoPlayer: play() promise rejected:', err);
            }

            // Re-emit error event if playback aborted completely
            if (err?.name !== 'AbortError') {
                const isNetworkError = /network|fetch|http|connection/i.test(err?.message || '');
                this.onEvent({
                    type: PlayerEvent.ERROR,
                    data: {
                        code: -1,
                        message: err?.message || 'Autoplay prevented or stream failed',
                        isNetworkError,
                        rawError: err
                    }
                });
            }

            // Propagate error upwards to prevent false playbackstart emission
            throw err;
        }
    }

    /**
     * Pause video playback.
     */
    pause() {
        if (!this._moviElement) return;
        log.debug('MoviVideoPlayer.pause()');
        if (typeof this._moviElement.pause === 'function') {
            this._moviElement.pause();
        }
    }

    /**
     * Unpause / resume video playback.
     */
    unpause() {
        if (!this._moviElement) return;
        log.debug('MoviVideoPlayer.unpause()');
        if (typeof this._moviElement.play === 'function') {
            this._moviElement.play().catch(err => {
                if (err?.name === 'AbortError') {
                    log.debug('MoviVideoPlayer.unpause() play aborted:', err);
                } else {
                    log.error('MoviVideoPlayer.unpause() play failed:', err);
                }
            });
        }
    }

    /**
     * Stop playback and release stream resources.
     *
     * @returns {Promise<void>}
     */
    async stop() {
        log.info('MoviVideoPlayer.stop() called');
        this._clearStartupWatchdog();
        this._unbindEvents();

        if (this._moviElement) {
            try {
                // Safely pause only if element has been upgraded
                if (typeof this._moviElement.pause === 'function') {
                    this._moviElement.pause();
                }
                // Clear source to cleanly abort active network streams
                this._moviElement.src = '';
                this._moviElement.removeAttribute('src');

                // If internal player destroy method is exposed, trigger it
                if (typeof this._moviElement.player?.destroy === 'function') {
                    this._moviElement.player.destroy();
                } else if (typeof this._moviElement.destroy === 'function') {
                    this._moviElement.destroy();
                }
            } catch (err) {
                log.error('MoviVideoPlayer: Error stopping movi-player element:', err);
            }
        }

        this._started = false;
        this._playInitiated = false;
        this._timeUpdated = false;
        this._currentSrc = null;
        this._currentPlayOptions = null;
    }

    /**
     * Seek to a specific timestamp in Jellyfin ticks (1 tick = 100ns).
     *
     * @param {number} positionTicks - Target position in ticks
     */
    seek(positionTicks) {
        if (!this._moviElement) return;

        const targetSeconds = positionTicks / 10000000;
        const currentSeconds = this._moviElement.currentTime || 0;
        const diffMs = Math.abs(targetSeconds - currentSeconds) * 1000;

        // Skip micro-seeks under threshold
        if (diffMs < SEEK_THRESHOLD_MS && this._started) {
            log.debug(`MoviVideoPlayer.seek: delta below threshold (${diffMs.toFixed(0)}ms) — skipping`);
            return;
        }

        log.info(`MoviVideoPlayer.seek to ${targetSeconds.toFixed(2)}s`);
        try {
            this._moviElement.currentTime = targetSeconds;
        } catch (err) {
            log.error('MoviVideoPlayer seek failed:', err);
        }
    }

    // ========================================================================
    // Audio and Volume Controls
    // ========================================================================

    /**
     * Set playback volume (0 to 100 scale).
     *
     * @param {number} volume - Volume level from 0 to 100
     */
    setVolume(volume) {
        if (!this._moviElement) return;
        const clamped = Math.max(0, Math.min(100, volume));
        this._moviElement.volume = clamped / 100;
        MediaHelper.saveVolume(clamped / 100);
    }

    /**
     * Retrieve current volume (0 to 100 scale).
     *
     * @returns {number} Current volume
     */
    getVolume() {
        if (!this._moviElement) return 100;
        return Math.round((this._moviElement.volume || 0) * 100);
    }

    /**
     * Set playback speed / rate.
     *
     * @param {number} speed - Playback rate (e.g. 1.0, 1.25, 1.5, 2.0)
     */
    setSpeed(speed) {
        if (!this._moviElement) return;
        log.info(`MoviVideoPlayer: Setting playback speed to ${speed}x`);
        this._moviElement.playbackRate = speed;
    }

    /**
     * Toggle mute state.
     */
    toggleMute() {
        if (!this._moviElement) return;
        this._moviElement.muted = !this._moviElement.muted;
    }

    /**
     * Set explicit mute state.
     *
     * @param {boolean} muted - True to mute, false to unmute
     */
    setMuted(muted) {
        if (!this._moviElement) return;
        this._moviElement.muted = Boolean(muted);
    }

    /**
     * Check if audio is currently muted.
     *
     * @returns {boolean} True if muted
     */
    isMuted() {
        return this._moviElement ? Boolean(this._moviElement.muted) : false;
    }

    /**
     * Signals to JellyfinPlayer whether this backend supports native multi-audio
     * track switching within a Direct Play container.
     *
     * movi-player demuxes container audio tracks in WebAssembly and plays them
     * via Web Audio, enabling native in-container audio switching without remuxing!
     *
     * @returns {boolean} True
     */
    supportsNativeAudioTracks() {
        return true;
    }

    /**
     * Switch active audio track list index.
     *
     * @param {number} listIndex - Target 0-based audio track index
     */
    setAudioStreamIndex(listIndex) {
        if (!this._moviElement) return;
        log.info(`MoviVideoPlayer: Switching audio track to list index ${listIndex}`);
        this._currentAudioIndex = listIndex;

        /*
         * --------------------------------------------------------------------
         * 1. DOM AudioTrackList Selection
         * --------------------------------------------------------------------
         * Setting .enabled = true triggers MoviElement's pickAudioTrack() helper,
         * which marks _audioRestored = true internally and prevents MoviElement
         * from falling back to any persisted audio preferences.
         * --------------------------------------------------------------------
         */
        let selectedViaAudioTracks = false;
        if (this._moviElement.audioTracks && this._moviElement.audioTracks[listIndex]) {
            try {
                this._moviElement.audioTracks[listIndex].enabled = true;
                selectedViaAudioTracks = true;
                log.info(`MoviVideoPlayer: Successfully selected audio track ${listIndex} via audioTracks property`);
            } catch (e) {
                log.warn(`MoviVideoPlayer: audioTracks property switch to index ${listIndex} failed:`, e);
            }
        }

        /*
         * --------------------------------------------------------------------
         * 2. Direct Core Engine TrackManager Selection
         * --------------------------------------------------------------------
         * Explicitly instruct MoviPlayer's internal TrackManager to activate the
         * underlying container track ID corresponding to listIndex. This ensures
         * immediate demuxer packet routing to the audio decoder.
         * --------------------------------------------------------------------
         */
        const innerPlayer = this._moviElement.player;
        if (innerPlayer && typeof innerPlayer.selectAudioTrack === 'function') {
            try {
                const tracks = innerPlayer.getAudioTracks ? innerPlayer.getAudioTracks() : [];
                const targetTrack = tracks[listIndex];
                const trackId = (targetTrack && typeof targetTrack.id !== 'undefined') ? targetTrack.id : listIndex;
                innerPlayer.selectAudioTrack(trackId);
                log.info(`MoviVideoPlayer: Selected audio track ID ${trackId} (list index ${listIndex}) via innerPlayer.selectAudioTrack`);
                return;
            } catch (e) {
                log.warn(`MoviVideoPlayer: innerPlayer.selectAudioTrack failed for index ${listIndex}:`, e);
            }
        }

        if (selectedViaAudioTracks) {
            return;
        }

        /*
         * --------------------------------------------------------------------
         * 3. Custom Element Method Fallback
         * --------------------------------------------------------------------
         */
        if (typeof this._moviElement.selectAudioTrack === 'function') {
            try {
                this._moviElement.selectAudioTrack(listIndex);
                log.info(`MoviVideoPlayer: Selected audio track ${listIndex} via element.selectAudioTrack`);
                return;
            } catch (e) {
                log.warn(`MoviVideoPlayer: element.selectAudioTrack failed for index ${listIndex}:`, e);
            }
        }

        log.info(`MoviVideoPlayer: Audio track selection staged for index ${listIndex} (awaiting container track readiness)`);
    }

    /**
     * Get available audio tracks from the active movi-player element.
     *
     * @returns {Array} List of audio tracks
     */
    getAudioTracks() {
        if (!this._moviElement) return [];
        if (this._moviElement.audioTracks) {
            return Array.from(this._moviElement.audioTracks);
        }
        if (this._moviElement.player?.getAudioTracks) {
            return this._moviElement.player.getAudioTracks();
        }
        return [];
    }

    // ========================================================================
    // Subtitle & Presentation Controls
    // ========================================================================

    /**
     * Configure active subtitle stream index.
     * Subtitles are predominantly handled by Litefin's SubtitleManager (rendering
     * styled ASS/SSA, PGS bitmaps, or WebVTT cues on dedicated overlays).
     *
     * @param {number} index - Stream index (-1 to disable)
     */
    setSubtitleStreamIndex(index) {
        this._currentSubtitleIndex = index;
        log.info(`MoviVideoPlayer.setSubtitleStreamIndex: ${index}`);
    }

    /**
     * Adjust subtitle timing offset.
     *
     * @param {number} seconds - Offset in seconds
     */
    setSubtitleOffset(seconds) {
        this._subtitleOffset = seconds;
    }

    /**
     * Set video presentation aspect ratio.
     *
     * @param {'contain'|'cover'|'fill'} mode - Aspect ratio mode
     */
    setAspectRatio(mode) {
        if (!this._moviElement) return;
        const fitMode = mode === 'cover' ? 'cover' : mode === 'fill' ? 'fill' : 'contain';
        this._moviElement.style.objectFit = fitMode;
        this._moviElement.setAttribute('objectfit', fitMode);
    }

    // ========================================================================
    // State Query Getters
    // ========================================================================

    /**
     * Get current playback position in seconds.
     *
     * @returns {number} Position in seconds
     */
    getCurrentTime() {
        return this._moviElement ? this._moviElement.currentTime || 0 : 0;
    }

    /**
     * Get total duration in seconds.
     *
     * @returns {number} Duration in seconds
     */
    getDuration() {
        return this._moviElement ? this._moviElement.duration || 0 : 0;
    }

    /**
     * Get duration estimated by manifest (same as getDuration for progressive streams).
     *
     * @returns {number} Duration in seconds
     */
    getHlsManifestDuration() {
        return this.getDuration();
    }

    /**
     * Retrieve the initial resume offset configured for this session in ticks.
     *
     * @returns {number} Start position ticks
     */
    getStartPositionTicks() {
        return this._startPositionTicks || 0;
    }

    /**
     * Check if playback is currently paused.
     *
     * @returns {boolean} True if paused
     */
    isPaused() {
        if (!this._moviElement) return true;
        return Boolean(this._moviElement.paused);
    }

    // ========================================================================
    // Teardown and Cleanup
    // ========================================================================

    /**
     * Completely destroy player instance and remove DOM nodes.
     */
    destroy() {
        log.info('MoviVideoPlayer.destroy() called');
        // Disarm any active startup timeout watchdog
        this._clearStartupWatchdog();

        try {
            this.stop();
        } catch (err) {
            log.error('MoviVideoPlayer: Error executing stop() during destroy:', err);
        }

        if (this._moviElement) {
            try {
                this._moviElement.remove();
            } catch (err) {
                log.error('MoviVideoPlayer: Error removing DOM element during destroy:', err);
            }
            this._moviElement = null;
            this._videoElement = null;
        }

        this.container = null;
        this.settings = null;
        this.onEvent = () => { };
    }
}
