/**
 * ============================================================================
 * Litefin - WebOS Adapter
 * ============================================================================
 * Handles all LG WebOS-specific functionality including:
 * - Remote control key registration and mapping
 * - Magic Remote cursor visibility management
 * - Media Session integration for physical remote media keys
 * - Device info and platform detection
 * ============================================================================
 */

import 'webostvjs';
import { eventBus } from '../core/EventBus.js';
import { storage } from '../utils/StorageService.js';
import { logger } from '../utils/Logger.js';

const log = logger.create('WebOSAdapter');

// Minimum pixel movement to consider as an interaction.
// Filters out gyro noise from LG Magic Remotes.
const MOVEMENT_THRESHOLD = 5;

/**
 * Key code mappings for LG WebOS remotes
 * Based on LG Developer Documentation and Jellyfin's input mapping.
 */
const WEBOS_KEYS = {
    // Navigation
    LEFT: 37,
    UP: 38,
    RIGHT: 39,
    DOWN: 40,
    ENTER: 13,
    BACK: 461, // The critical "Return/Back" button on LG remotes

    // Media controls (Physical buttons on the bottom of many LG remotes)
    PLAY: 415,
    PAUSE: 19,
    STOP: 413,
    REWIND: 412,
    FAST_FORWARD: 417,

    // Channel / Track keys (effectively Skip Next/Previous)
    NEXT: 33, // PageUp / ChannelUp
    PREV: 34, // PageDown / ChannelDown

    // Color buttons (Red, Green, Yellow, Blue)
    RED: 403,
    GREEN: 404,
    YELLOW: 405,
    BLUE: 406
};

class WebOSAdapter {
    constructor() {
        this._isWebOS = false;
        this._deviceInfo = null;
        this._cursorActive = false;
        this._lastInteractionTime = Date.now();

        // Track mouse position to filter out minor gyro noise
        this._lastMouseX = -1;
        this._lastMouseY = -1;
        this._lastKeyTime = 0;

        /*
         * ====================================================================
         * System Screensaver & Power Keepalive Management
         * ====================================================================
         * LG webOS natively enforces a ~30-minute idle screensaver timeout
         * whenever video playback is not detected as exclusive full-screen
         * (such as letterboxed/pillarboxed video elements with custom bounds).
         * We track registration, subscription, and playback block states here.
         * ====================================================================
         */
        this._screenSaverBlocked = false;
        this._screenSaverSubscription = null;
        this._screenSaverRegistered = false;
        this._keepScreenActivityId = null;
        // A create request is in flight (its activityId is not known yet)
        this._keepScreenActivityPending = false;
        this._isPlaybackKeepOnRequested = false;
        // PalmServiceBridge objects waiting for their reply: a bridge nothing references
        // can be garbage-collected before its callback fires
        this._pendingBridges = [];

        // Immediate platform detection via User Agent or Global
        this._detectPlatform();
    }

    /**
     * Get idle time in milliseconds
     * @returns {number} Idle time
     */
    get idleTime() {
        return Date.now() - (this._lastInteractionTime || Date.now());
    }

    /**
     * Report an input interaction (mouse, touch etc from outside)
     */
    reportInput() {
        this._lastInteractionTime = Date.now();
    }

    /**
     * Detect if running on WebOS platform
     * @private
     */
    _detectPlatform() {
        const ua = navigator.userAgent;
        // Rely strictly on hardware UA strings. window.webOS is defined on all platforms via script tag.
        if (/Web[O0]S|NetCast|LG[ -]Browser/i.test(ua)) {
            this._isWebOS = true;
            log.info('Running on WebOS adapter mode');
        }
    }

    /**
     * Initialize WebOS-specific features
     */
    init() {
        if (!this._isWebOS) return;

        log.info('Initializing WebOSAdapter...');

        // 1. Register for remote buttons (Key Masking)
        // This ensures the OS delivers these physical keys to the web app
        this._registerRemoteKeys();

        // 2. Setup global key listener for Back button and Navigation
        this._setupKeyHandler();

        // 3. Setup Magic Remote cursor tracking
        this._setupCursorTracking();

        // 4. Load Device Info
        this._loadDeviceInfo();

        // 5. Setup wheel amplification for Magic Remote
        this._setupWheelHandler();

        // 6. Setup screensaver suppression and event bus hooks
        // Ensures native LG screensaver is suppressed during active video playback
        this._setupScreensaverGuard();

        log.info('WebOSAdapter initialized');
    }

    /**
     * WebOS Magic Remote scroll wheel is notoriously slow and "resistive".
     * This handler intercepts the native wheel event and amplifies the delta
     * to make vertical scrolling feel responsive and fluid.
     * @private
     */
    _setupWheelHandler() {
        window.addEventListener(
            'wheel',
            (e) => {
                // Only handle vertical scrolling
                if (Math.abs(e.deltaY) < 0.1) return;

                // Find the nearest scrollable container
                const container = e.target.closest(
                    '.page-content, .modal-options, .filter-main, .filter-sidebar, .sidebar-libraries-wrapper, .settings-content, .sidebar-content'
                );

                if (container) {
                    let delta = e.deltaY;

                    // Normalize delta based on deltaMode (0=pixels, 1=lines, 2=pages)
                    if (e.deltaMode === 1) {
                        delta *= 40; // Approx line height
                    } else if (e.deltaMode === 2) {
                        delta *= 800; // Approx page height
                    }

                    // Amplify the delta for WebOS responsiveness (reduced by 30%)
                    const multiplier = 2.0;
                    container.scrollTop += delta * multiplier;

                    // Prevent native slow scroll
                    e.preventDefault();
                }
            },
            { passive: false }
        );
    }

    /**
     * Register extended remote keys with the OS.
     * Some LG models require this "masking" to receive color and media keys.
     * @private
     */
    _registerRemoteKeys() {
        try {
            if (window.webOS && window.webOS.keyboard && typeof window.webOS.keyboard.setKeyMask === 'function') {
                const keys = [
                    'back',
                    'play',
                    'pause',
                    'stop',
                    'rewind',
                    'fastforward',
                    'red',
                    'green',
                    'yellow',
                    'blue'
                ];
                window.webOS.keyboard.setKeyMask(keys);
                log.info('Remote key mask set:', keys);
            }
        } catch (e) {
            log.warn('Failed to set WebOS key mask:', e);
        }
    }

    /**
     * Setup global key event handler
     * @private
     */
    _setupKeyHandler() {
        document.addEventListener('keydown', (e) => {
            this._lastInteractionTime = Date.now();
            this._lastKeyTime = Date.now();
            const keyCode = e.keyCode;

            // Hide the Magic Remote cursor as soon as a navigation key is pressed
            if (this._cursorActive) {
                this._setCursorActive(false);
            }

            // Block WebOS default spatial navigation/scrolling unless user is typing in an input field.
            const activeElem = document.activeElement;
            const isTextInput =
                activeElem &&
                !activeElem.readOnly &&
                ((activeElem.tagName === 'INPUT' && activeElem.type !== 'range') || activeElem.tagName === 'TEXTAREA');

            /*
             * Space bar control helper:
             * We only want to hijack the space bar if the player is actively rendering
             * on screen. This prevents breaking standard browser scroll functionality
             * on the settings, details, or library grid pages.
             */
            const isPlayerActive = window.location.hash.startsWith('#/player');

            // Physical keyboard shortcuts when video player is active (J/K/L/M)
            if (isPlayerActive && !isTextInput && !e.ctrlKey && !e.altKey && !e.metaKey) {
                switch (e.key) {
                    case 'k':
                    case 'K':
                        e.preventDefault();
                        eventBus.emit('key:playPause', e);
                        return;
                    case 'j':
                    case 'J':
                        e.preventDefault();
                        eventBus.emit('key:rewind', e);
                        return;
                    case 'l':
                    case 'L':
                        e.preventDefault();
                        eventBus.emit('key:fastForward', e);
                        return;
                    case 'm':
                    case 'M':
                        e.preventDefault();
                        eventBus.emit('remote:togglemute');
                        return;
                    default:
                        break;
                }
            }

            if (!isTextInput) {
                const keysToPrevent = [
                    WEBOS_KEYS.LEFT,
                    WEBOS_KEYS.RIGHT,
                    WEBOS_KEYS.UP,
                    WEBOS_KEYS.DOWN,
                    WEBOS_KEYS.ENTER
                ];
                if (isPlayerActive && keyCode === 32) {
                    keysToPrevent.push(32);
                }
                if (keysToPrevent.includes(keyCode)) {
                    e.preventDefault();
                }
            }

            // Map key codes to eventBus events
            switch (keyCode) {
                // Space bar mapping for web/desktop players
                case 32:
                    if (!isTextInput && isPlayerActive) {
                        e.preventDefault();
                        eventBus.emit('key:playPause', e);
                    }
                    break;
                // Navigation
                case WEBOS_KEYS.LEFT:
                    eventBus.emit('key:left', e);
                    break;
                case WEBOS_KEYS.RIGHT:
                    eventBus.emit('key:right', e);
                    break;
                case WEBOS_KEYS.UP:
                    eventBus.emit('key:up', e);
                    break;
                case WEBOS_KEYS.DOWN:
                    eventBus.emit('key:down', e);
                    break;
                case WEBOS_KEYS.ENTER:
                    eventBus.emit('key:enter', e);
                    break;
                case WEBOS_KEYS.BACK:
                    // LG requires preventDefault on 461 to prevent the app from closing immediately
                    e.preventDefault();
                    eventBus.emit('key:back', e);
                    break;
                case 27: // Escape
                case 8: // Backspace
                    if (!isTextInput) {
                        e.preventDefault();
                        eventBus.emit('key:back', e);
                    }
                    break;

                case WEBOS_KEYS.PLAY:
                    eventBus.emit('key:play', e);
                    break;
                case WEBOS_KEYS.PAUSE:
                    eventBus.emit('key:pause', e);
                    break;
                case WEBOS_KEYS.STOP:
                    eventBus.emit('key:stop', e);
                    break;
                case WEBOS_KEYS.REWIND:
                    eventBus.emit('key:rewind', e);
                    break;
                case WEBOS_KEYS.FAST_FORWARD:
                    eventBus.emit('key:fastForward', e);
                    break;
                case WEBOS_KEYS.NEXT:
                    eventBus.emit('key:next', e);
                    eventBus.emit('key:channelUp', e);
                    break;
                case WEBOS_KEYS.PREV:
                    eventBus.emit('key:previous', e);
                    eventBus.emit('key:channelDown', e);
                    break;

                case WEBOS_KEYS.RED:
                    eventBus.emit('key:red', e);
                    break;
                case WEBOS_KEYS.GREEN:
                    eventBus.emit('key:green', e);
                    break;
                case WEBOS_KEYS.YELLOW:
                    eventBus.emit('key:yellow', e);
                    break;
                case WEBOS_KEYS.BLUE:
                    eventBus.emit('key:blue', e);
                    break;
            }
        });
    }

    /**
     * Setup mousemove listener to detect Magic Remote pointer movement
     * @private
     */
    _setupCursorTracking() {
        document.addEventListener('mousemove', (e) => {
            // Check if movement is significant enough to count as interaction
            const deltaX = Math.abs(e.clientX - this._lastMouseX);
            const deltaY = Math.abs(e.clientY - this._lastMouseY);

            // When cursor is currently hidden (D-pad mode), require a deliberate,
            // intentional gesture (15px threshold) and ensure we are outside the
            // 500ms post-keypress settle window to avoid reactivating the cursor
            // from physical button clicks or hand tremors.
            const threshold = this._cursorActive ? MOVEMENT_THRESHOLD : 15;
            if (deltaX < threshold && deltaY < threshold) {
                return;
            }

            if (!this._cursorActive && Date.now() - this._lastKeyTime < 500) {
                return;
            }

            this._lastMouseX = e.clientX;
            this._lastMouseY = e.clientY;

            this._lastInteractionTime = Date.now();
            if (!this._cursorActive) {
                this._setCursorActive(true);
            }
        });

        // Also track mouse clicks (Magic Remote wheel click)
        document.addEventListener('mousedown', () => {
            this._lastInteractionTime = Date.now();
            if (!this._cursorActive) {
                this._setCursorActive(true);
            }
        });
    }

    /**
     * Update the cursor state and apply CSS classes to the body
     * @param {boolean} active
     * @private
     */
    _setCursorActive(active) {
        if (this._cursorActive === active) return;
        this._cursorActive = active;

        if (active) {
            document.body.classList.add('webos-cursor-active');
            log.debug('Magic Remote cursor activated');
        } else {
            document.body.classList.remove('webos-cursor-active');
            log.debug('Magic Remote cursor hidden (switching to D-pad mode)');
        }
    }

    /**
     * Load WebOS device information
     * @private
     */
    _loadDeviceInfo() {
        if (!this._isWebOS) return;
        // Guard against calling Luna services in headless unit tests or standard browsers
        // where native PalmServiceBridge or PalmSystem objects are not present
        if (typeof window.PalmServiceBridge === 'undefined' && typeof window.PalmSystem === 'undefined') {
            return;
        }

        try {
            if (window.webOS && typeof window.webOS.deviceInfo === 'function') {
                window.webOS.deviceInfo((info) => {
                    this._deviceInfo = info;
                    log.info('WebOS Device Info loaded:', info);
                    eventBus.emit('webos:deviceInfoReady', info);
                });
            }
        } catch (e) {
            log.error('Failed to load WebOS device info:', e);
        }
    }

    /**
     * Initialize/Update Media Session metadata and handlers.
     * This links the physical remote media buttons (Play/Pause/Skip) to the player.
     *
     * @param {Object} metadata - { title, artist, album, artworkUrl }
     * @param {Object} callbacks - { onPlay, onPause, onStop, onSeekForward, onSeekBackward }
     */
    updateMediaSession(metadata = {}, callbacks = {}) {
        if (!('mediaSession' in navigator)) return;

        log.info('Updating Media Session for WebOS remote support');

        // Set metadata
        try {
            if (typeof window.MediaMetadata !== 'undefined') {
                navigator.mediaSession.metadata = new window.MediaMetadata({
                    title: metadata.title || '',
                    artist: metadata.artist || '',
                    album: metadata.album || 'Litefin',
                    artwork: metadata.artworkUrl ? [{ src: metadata.artworkUrl }] : []
                });
            }
        } catch (e) {
            log.warn('Failed to set MediaSession metadata:', e);
        }

        // Set action handlers
        // These are triggered when the user presses buttons on the bottom of the LG remote
        const actions = {
            play: callbacks.onPlay,
            pause: callbacks.onPause,
            stop: callbacks.onStop,
            seekbackward: callbacks.onSeekBackward,
            seekforward: callbacks.onSeekForward,
            previoustrack: callbacks.onPrevious,
            nexttrack: callbacks.onNext
        };

        Object.keys(actions).forEach((action) => {
            try {
                if (typeof actions[action] === 'function') {
                    navigator.mediaSession.setActionHandler(action, actions[action]);
                } else {
                    navigator.mediaSession.setActionHandler(action, null);
                }
            } catch (e) {
                log.warn(`Failed to set MediaSession action handler for ${action}:`, e);
            }
        });
    }

    // ========================================================================
    // Screensaver Suppression & Power Keepalive API
    // ========================================================================

    /**
     * Client identifier for screensaver registration with the TV power service.
     * Matches the app ID configured in appinfo.json.
     * @private
     */
    static get SCREENSAVER_CLIENT() {
        return 'org.litefin.app';
    }

    /**
     * Wire event bus listeners for media playback to automatically
     * suppress the webOS screensaver while video is actively playing,
     * and allow standard screensaver behavior when paused or stopped.
     * @private
     */
    _setupScreensaverGuard() {
        if (!this._isWebOS) return;

        // Register guard subscription early so incoming screensaver requests
        // can be intercepted immediately even on long idle sessions.
        this._registerScreenSaverGuard();

        // Listen for playback events across the entire application
        if (typeof eventBus !== 'undefined' && typeof eventBus?.on === 'function') {
            eventBus.on('player:play', () => {
                this.setKeepScreenOn(true);
            });
            eventBus.on('player:playing', () => {
                this.setKeepScreenOn(true);
            });
            eventBus.on('player:paused', () => {
                this.setKeepScreenOn(false);
            });
            eventBus.on('player:stopped', () => {
                this.setKeepScreenOn(false);
            });
        }
    }

    /**
     * Register a persistent subscription with the LG webOS TV power service.
     * Intercepts native firmware screensaver trigger requests from the system.
     * When the TV is about to activate the system screensaver after idle timeout,
     * it pushes a request with a timestamp to all registered listeners.
     * @private
     */
    _registerScreenSaverGuard() {
        if (!this._isWebOS || this._screenSaverRegistered) return;

        log.info('Registering screensaver guard with TV power service');

        try {
            const clientName = WebOSAdapter.SCREENSAVER_CLIENT;

            if (window.webOS && window.webOS.service && typeof window.webOS.service.request === 'function') {
                this._screenSaverSubscription = window.webOS.service.request('luna://com.webos.service.tvpower', {
                    method: 'power/registerScreenSaverRequest',
                    parameters: { clientName, subscribe: true },
                    subscribe: true,
                    onSuccess: (res) => {
                        log.info('Screensaver request event received from tvpower service:', res);
                        if (res && res.timestamp) {
                            this._respondScreenSaver(res.timestamp);
                        }
                    },
                    onFailure: (err) => {
                        log.warn('Screensaver guard registration failed:', err);
                        this._screenSaverRegistered = false;
                    }
                });
                this._screenSaverRegistered = true;
            } else if (typeof window.PalmServiceBridge !== 'undefined') {
                const bridge = new window.PalmServiceBridge();
                bridge.onservicecallback = (msg) => {
                    try {
                        const res = JSON.parse(msg);
                        log.info('Screensaver request event received (via PalmServiceBridge):', res);
                        if (res && res.timestamp) {
                            this._respondScreenSaver(res.timestamp);
                        }
                    } catch (e) {
                        log.warn('Error parsing screensaver request message:', e);
                    }
                };
                bridge.call(
                    'luna://com.webos.service.tvpower/power/registerScreenSaverRequest',
                    JSON.stringify({ clientName, subscribe: true })
                );
                this._screenSaverSubscription = bridge;
                this._screenSaverRegistered = true;
            }
        } catch (e) {
            log.warn('Exception while registering screensaver guard:', e);
            this._screenSaverRegistered = false;
        }
    }

    /**
     * Respond to a pending screensaver activation request from webOS.
     * If video is actively playing (_screenSaverBlocked is true), we reply with
     * ack: false to deny/suppress screensaver activation and reset the idle timer.
     * If video is paused, stopped, or the user is in menus, we reply with ack: true
     * to allow normal system screensaver operation (protecting OLED screens).
     *
     * @param {string|number} timestamp - The timestamp token sent by tvpower service
     * @private
     */
    _respondScreenSaver(timestamp) {
        const ack = !this._screenSaverBlocked;
        log.info(`Responding to webOS screensaver request - timestamp: ${timestamp}, ack (allow screensaver): ${ack}`);

        const clientName = WebOSAdapter.SCREENSAVER_CLIENT;
        const parameters = {
            clientName,
            ack,
            timestamp
        };

        try {
            if (window.webOS && window.webOS.service && typeof window.webOS.service.request === 'function') {
                window.webOS.service.request('luna://com.webos.service.tvpower', {
                    method: 'power/responseScreenSaverRequest',
                    parameters,
                    onSuccess: () => {
                        log.debug('Screensaver response delivered successfully');
                    },
                    onFailure: (err) => {
                        log.warn('Failed to respond to screensaver request:', err);
                    }
                });
            } else if (typeof window.PalmServiceBridge !== 'undefined') {
                this._callPalmServiceBridge(
                    'luna://com.webos.service.tvpower/power/responseScreenSaverRequest',
                    parameters
                );
            }
        } catch (e) {
            log.warn('Exception sending screensaver response:', e);
        }
    }

    /**
     * Suppress or restore native webOS system screensaver and display sleep.
     * When keepOn is true:
     *   - Checks user preference pref:suppressScreensaverOnPlayback (defaults to false / disabled)
     *   - If explicitly enabled by user: flags screensaver as blocked so tvpower requests receive ack: false,
     *     ensures screensaver guard subscription is registered, and creates a continuous
     *     power keepalive activity via com.palm.activitymanager
     *   - If disabled by user (the default): leaves screensaver unblocked so tvpower requests receive ack: true
     * When keepOn is false:
     *   - Unblocks screensaver so tvpower requests receive ack: true
     *   - Cancels the power keepalive activity
     *
     * @param {boolean} keepOn - True to request screensaver suppression; false to restore normal behavior
     */
    setKeepScreenOn(keepOn = true) {
        // Exit early if not running in the webOS host environment
        if (!this._isWebOS) return;

        // Track whether playback is currently requesting display wakefulness
        this._isPlaybackKeepOnRequested = Boolean(keepOn);

        // Check if user explicitly enabled screensaver suppression in Settings (disabled by default)
        const isEnabledByUser = storage.getItem('pref:suppressScreensaverOnPlayback') === 'true';
        const shouldBlock = Boolean(keepOn && isEnabledByUser);

        // Update internal suppression flag for upcoming tvpower callbacks
        this._screenSaverBlocked = shouldBlock;
        log.info(
            `WebOSAdapter.setKeepScreenOn(${keepOn}) - enabledByUser: ${isEnabledByUser}, screensaverBlocked: ${this._screenSaverBlocked}`
        );

        if (shouldBlock) {
            // Ensure tvpower screensaver request guard is active
            this._registerScreenSaverGuard();
            // Create power keepalive activity via ActivityManager
            this._createKeepScreenActivity();
        } else {
            // Cancel power keepalive activity to prevent holding system resources
            this._cancelKeepScreenActivity();
        }
    }

    /**
     * Update screensaver suppression state when the user toggles the
     * preference under Litefin Screensaver settings.
     *
     * @param {boolean} enabled - New preference value
     */
    updateScreensaverSuppressionPreference(enabled) {
        if (!this._isWebOS) return;
        log.info(`WebOSAdapter.updateScreensaverSuppressionPreference(${enabled})`);

        if (this._isPlaybackKeepOnRequested) {
            this.setKeepScreenOn(this._isPlaybackKeepOnRequested);
        }
    }

    /**
     * Create a keepalive activity with com.palm.activitymanager to prevent
     * the system from going into sleep mode or suspending the web process.
     * @private
     */
    _createKeepScreenActivity() {
        if (!this._isWebOS || this._keepScreenActivityId || this._keepScreenActivityPending) return;

        try {
            const params = {
                activity: {
                    name: 'org.litefin.app-playback-keepalive',
                    description: 'Keep screen awake during active video playback',
                    type: {
                        foreground: true,
                        continuous: true,
                        power: true,
                        powerDebounce: true
                    }
                },
                start: true,
                replace: true,
                subscribe: false
            };

            /*
             * The activityId is only known in the reply. 'player:playing' fires after every
             * seek and rebuffer, so without the pending flag another create went out while
             * one was in flight. And a stop in that window found no id to cancel: the reply
             * then stored the id of a continuous power activity nothing would cancel, which
             * kept the screensaver off after playback.
             */
            this._keepScreenActivityPending = true;
            const onCreated = (res) => {
                this._keepScreenActivityPending = false;
                this._keepScreenActivityId = res?.activityId || null;
                log.info('Keep-screen activity registered, activityId:', this._keepScreenActivityId);
                // Playback stopped or paused (or the setting was turned off) while create was in flight
                if (!this._screenSaverBlocked) {
                    this._cancelKeepScreenActivity();
                }
            };
            const onFailed = (err) => {
                this._keepScreenActivityPending = false;
                log.warn('Failed to create keep-screen activity:', err);
            };

            if (window.webOS && window.webOS.service && typeof window.webOS.service.request === 'function') {
                window.webOS.service.request('luna://com.palm.activitymanager', {
                    method: 'create',
                    parameters: params,
                    onSuccess: onCreated,
                    onFailure: onFailed
                });
            } else if (typeof window.PalmServiceBridge !== 'undefined') {
                this._callPalmServiceBridge('luna://com.palm.activitymanager/create', params, (msg) => {
                    let res;
                    try {
                        res = JSON.parse(msg);
                    } catch (e) {
                        onFailed(e);
                        return;
                    }
                    if (res && res.returnValue === false) {
                        onFailed(res);
                    } else {
                        onCreated(res);
                    }
                });
            } else {
                this._keepScreenActivityPending = false;
            }
        } catch (e) {
            this._keepScreenActivityPending = false;
            log.warn('Exception creating keep-screen activity:', e);
        }
    }

    /**
     * Call a Luna service through PalmServiceBridge, keeping the bridge referenced
     * until its reply arrives.
     * @param {string} uri - Full Luna URI including the method
     * @param {Object} params - Call parameters
     * @param {Function} [onReply] - Receives the raw reply string
     * @private
     */
    _callPalmServiceBridge(uri, params, onReply) {
        const bridge = new window.PalmServiceBridge();
        const release = () => {
            const index = this._pendingBridges.indexOf(bridge);
            if (index !== -1) this._pendingBridges.splice(index, 1);
        };
        this._pendingBridges.push(bridge);
        bridge.onservicecallback = (msg) => {
            release();
            if (onReply) onReply(msg);
        };
        try {
            bridge.call(uri, JSON.stringify(params));
        } catch (e) {
            release();
            throw e;
        }
    }

    /**
     * Cancel active keepalive activity with com.palm.activitymanager.
     * @private
     */
    _cancelKeepScreenActivity() {
        if (!this._isWebOS || !this._keepScreenActivityId) return;

        const activityId = this._keepScreenActivityId;
        this._keepScreenActivityId = null;

        try {
            const params = { activityId };

            if (window.webOS && window.webOS.service && typeof window.webOS.service.request === 'function') {
                window.webOS.service.request('luna://com.palm.activitymanager', {
                    method: 'cancel',
                    parameters: params,
                    onSuccess: () => {
                        log.info('Keep-screen activity canceled successfully');
                    },
                    onFailure: (err) => {
                        log.warn('Failed to cancel keep-screen activity:', err);
                    }
                });
            } else if (typeof window.PalmServiceBridge !== 'undefined') {
                this._callPalmServiceBridge('luna://com.palm.activitymanager/cancel', params);
            }
        } catch (e) {
            log.warn('Exception canceling keep-screen activity:', e);
        }
    }

    /**
     * Perform exit action
     */
    exit() {
        if (this._isWebOS) {
            // Cancel any active keepalive activity and release screensaver suppression
            this.setKeepScreenOn(false);

            // Flush all pending storage writes to disk before exiting.
            storage.flush();
            log.info('Exiting application via webOS.platformBack()');
            if (window.webOS && typeof window.webOS.platformBack === 'function') {
                window.webOS.platformBack();
            } else {
                window.close();
            }
        }
    }

    /**
     * Get device name for server identification
     * @returns {string} Device name (e.g. "LG Smart TV" or specific model)
     */
    getDeviceName() {
        if (this._isWebOS && this._deviceInfo && this._deviceInfo.modelName) {
            return this._deviceInfo.modelName;
        }
        return this._isWebOS ? 'LG Smart TV' : 'Web Browser';
    }

    /**
     * Get device manufacturer
     * @returns {string} Manufacturer name
     */
    getManufacturer() {
        return this._isWebOS ? 'LG' : 'Generic';
    }

    // ========================================================================
    // Launch Parameters
    // ========================================================================

    /**
     * Read the params Litefin was launched with: the `params` another app passed to
     * luna://com.webos.applicationManager/launch (e.g. { tmdbId, mediaType }).
     * webOS hands them to the page as a JSON string in PalmSystem.launchParams.
     *
     * @returns {Object} Launch params (empty when launched from the home screen)
     */
    getLaunchParams() {
        if (!this._isWebOS) return {};
        try {
            const raw = window.PalmSystem && window.PalmSystem.launchParams;
            if (!raw) return {};
            const params = typeof raw === 'string' ? JSON.parse(raw) : raw;
            return params && typeof params === 'object' ? params : {};
        } catch (e) {
            log.warn('Launch params could not be read:', e?.message || e);
            return {};
        }
    }

    /**
     * Listen for relaunches while Litefin runs (its icon, or another app's launch call).
     *
     * @param {function(Object): void} callback - Receives the relaunch params ({} from the icon)
     * @returns {function(): void} Unsubscribe
     */
    onRelaunch(callback) {
        if (!this._isWebOS) return () => {};
        const handler = (e) => {
            /* event.detail carries the new params; PalmSystem.launchParams is updated
             * to the same JSON, which older firmware only offers. */
            const detail = e && e.detail;
            callback(detail && typeof detail === 'object' ? detail : this.getLaunchParams());
        };
        document.addEventListener('webOSRelaunch', handler);
        return () => document.removeEventListener('webOSRelaunch', handler);
    }

    get isWebOS() {
        return this._isWebOS;
    }
    get deviceInfo() {
        return this._deviceInfo;
    }

    /**
     * Launch the native YouTube application on LG WebOS TVs and navigate
     * directly to the specified video.
     *
     * Uses the WebOS Application Manager Luna service to launch the YouTube
     * Leanback app (`youtube.leanback.v4`) with the video ID passed as a
     * parameter. If the launch fails, falls back to opening a browser tab.
     *
     * @param {string} videoId - The YouTube video ID (e.g. "dQw4w9WgXcQ")
     */
    launchYouTube(videoId) {
        if (!videoId) return;

        /* ── Browser / dev fallback ─────────────────────────────────────── */
        if (!this._isWebOS) {
            log.info('launchYouTube: not on WebOS, opening browser tab');
            window.open(`https://www.youtube.com/watch?v=${videoId}`, '_blank');
            return;
        }

        try {
            log.info(`launchYouTube: launching YouTube app for videoId=${videoId}`);

            /* `com.webos.applicationManager/launch` is the standard Luna service
               used to start any installed app on WebOS. The YouTube Leanback app
               accepts a `videoId` param in its launch params object. */
            window.webOS.service.request('luna://com.webos.applicationManager', {
                method: 'launch',
                parameters: {
                    id: 'youtube.leanback.v4',
                    params: {
                        videoId: videoId,
                        contentId: videoId // Fallback for some YouTube TV app versions
                    }
                },
                onSuccess: () => log.info('launchYouTube: YouTube app launched successfully'),
                onFailure: (err) => {
                    /* App not installed or service call failed — open browser as
                       last-resort fallback so the user still sees the video. */
                    log.warn('launchYouTube: launch failed, falling back to browser', err);
                    window.open(`https://www.youtube.com/watch?v=${videoId}`, '_blank');
                }
            });
        } catch (e) {
            log.error('launchYouTube: unexpected error', e);
            window.open(`https://www.youtube.com/watch?v=${videoId}`, '_blank');
        }
    }
}

export const webosAdapter = new WebOSAdapter();
export default webosAdapter;
