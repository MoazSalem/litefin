/**
 * ============================================================================
 * Litefin - Android TV Adapter
 * ============================================================================
 * Handles Android TV and mobile Android platform-specific functionality:
 * - Hardware remote control key registration and mapping (D-Pad, Media, Back)
 * - Hardware Back button interception to drive unified Litefin back navigation
 * - Native bridge integration for clean application exit and device identification
 * - Idle tracking for screensaver and sleep timers
 * ============================================================================
 */

import { eventBus } from '../core/EventBus.js';
import { storage } from '../utils/StorageService.js';
import { logger } from '../utils/Logger.js';

const log = logger.create('AndroidAdapter');

// ============================================================================
// Key code mappings for Android TV remote controls and keyboards
// ============================================================================
const ANDROID_KEYS = {
    // Standard directional D-pad controls
    LEFT: 37,
    UP: 38,
    RIGHT: 39,
    DOWN: 40,
    ENTER: 13,

    // Hardware Back & fallback keys
    BACK: 4,         // Android KeyEvent.KEYCODE_BACK in Chromium WebView
    ESCAPE: 27,      // Standard desktop Escape key
    BACKSPACE: 8,    // Backspace key on external physical keyboards

    // Media playback controls found on Android TV remotes
    PLAY: 250,
    PLAY_ALT: 126,
    PLAY_LEGACY: 415,
    PAUSE: 19,
    PAUSE_ALT: 127,
    PLAY_PAUSE: 179,
    PLAY_PAUSE_ALT: 85,
    PLAY_PAUSE_LEGACY: 10252,
    STOP: 178,
    STOP_LEGACY: 413,
    FAST_FORWARD: 228,
    FAST_FORWARD_ALT: 90,
    FAST_FORWARD_LEGACY: 417,
    REWIND: 227,
    REWIND_ALT: 89,
    REWIND_LEGACY: 412,
    NEXT: 87,
    PREV: 88
};

class AndroidAdapter {
    constructor() {
        // Tracks whether adapter has been initialized
        this._initialized = false;

        // Cached human-readable device name from native bridge
        this._deviceName = null;

        // Tracks timestamp of last user interaction for screensaver
        this._lastInputTime = Date.now();
    }

    /**
     * ========================================================================
     * Initialization & Global Listener Registration
     * ========================================================================
     * Call after DOM is ready during application startup.
     */
    init() {
        if (this._initialized) {
            return;
        }
        this._initialized = true;

        log.info('Initializing AndroidAdapter...');

        // Expose adapter reference on window so native MainActivity can route hardware back
        if (typeof window !== 'undefined') {
            window.androidAdapter = this;
        }

        // Initialize user interaction timestamp
        this._lastInputTime = Date.now();

        // Register hardware and keyboard listener
        this._setupKeyHandler();

        // Track touch and pointer interactions for mobile and air-mouse remotes
        document.addEventListener('mousemove', () => this.reportInput(), { passive: true });
        document.addEventListener('mousedown', () => this.reportInput(), { passive: true });
        document.addEventListener('touchstart', () => this.reportInput(), { passive: true });

        // Retrieve and log Android device details from native bridge
        this._loadDeviceInfo();

        log.info('AndroidAdapter initialized successfully');
    }

    /**
     * Retrieves idle duration in milliseconds since the last user action.
     * @returns {number} Idle time in milliseconds
     */
    get idleTime() {
        return Date.now() - (this._lastInputTime || Date.now());
    }

    /**
     * Reports user interaction to keep screensaver and power timers alive.
     */
    reportInput() {
        this._lastInputTime = Date.now();
    }

    /**
     * Returns true indicating this is an Android runtime environment.
     * @returns {boolean}
     */
    get isAndroid() {
        return true;
    }

    /**
     * ========================================================================
     * Centralized Hardware Back Dispatcher
     * ========================================================================
     * Invoked by MainActivity.kt when the user clicks the physical remote
     * Back button or triggers the system predictive back navigation gesture.
     * Dispatches `key:back` onto Litefin's eventBus so modals, menus, and
     * in-page back handlers are given priority before page navigation.
     */
    handleHardwareBack() {
        this.reportInput();
        log.info('Hardware Back event received from native Android layer');

        // Central eventBus emission matching Tizen and WebOS back handling
        eventBus.emit('key:back');
    }

    /**
     * ========================================================================
     * Key Event Setup & Spatial Navigation Controls
     * ========================================================================
     * Configures document-level keyboard listeners for Android TV remotes.
     * @private
     */
    _setupKeyHandler() {
        document.addEventListener('keydown', (e) => {
            this.reportInput();
            const keyCode = e.keyCode;

            // Determine if the user is currently editing a text input element
            const activeElem = document.activeElement;
            const isTextInput =
                activeElem &&
                ((activeElem.tagName === 'INPUT' && activeElem.type !== 'range') || activeElem.tagName === 'TEXTAREA');

            // Determine if player page is actively rendering in the DOM
            const isPlayerActive = window.location.hash.startsWith('#/player');

            // Prevent default spatial navigation jumps when browsing outside text fields
            if (!isTextInput) {
                const directionalKeys = [
                    ANDROID_KEYS.LEFT,
                    ANDROID_KEYS.RIGHT,
                    ANDROID_KEYS.UP,
                    ANDROID_KEYS.DOWN,
                    ANDROID_KEYS.ENTER
                ];

                // Prevent space bar page scroll when player is visible
                if (isPlayerActive && keyCode === 32) {
                    directionalKeys.push(32);
                }

                if (directionalKeys.includes(keyCode)) {
                    e.preventDefault();
                }
            }

            // Route key codes to internal events
            switch (keyCode) {
                // Space bar play/pause toggle for physical keyboards
                case 32:
                    if (!isTextInput && isPlayerActive) {
                        e.preventDefault();
                        eventBus.emit('key:playPause', e);
                    }
                    break;

                // D-Pad directional navigation
                case ANDROID_KEYS.LEFT:
                    eventBus.emit('key:left', e);
                    break;
                case ANDROID_KEYS.RIGHT:
                    eventBus.emit('key:right', e);
                    break;
                case ANDROID_KEYS.UP:
                    eventBus.emit('key:up', e);
                    break;
                case ANDROID_KEYS.DOWN:
                    eventBus.emit('key:down', e);
                    break;
                case ANDROID_KEYS.ENTER:
                    eventBus.emit('key:enter', e);
                    break;

                // Hardware Back and Escape keys
                case ANDROID_KEYS.BACK:
                case ANDROID_KEYS.ESCAPE:
                    e.preventDefault();
                    this.handleHardwareBack();
                    break;

                // Backspace acts as Back when outside text inputs
                case ANDROID_KEYS.BACKSPACE:
                    if (!isTextInput) {
                        e.preventDefault();
                        this.handleHardwareBack();
                    }
                    break;

                // Media Play / Pause keys
                case ANDROID_KEYS.PLAY:
                case ANDROID_KEYS.PLAY_ALT:
                case ANDROID_KEYS.PLAY_LEGACY:
                    e.preventDefault();
                    eventBus.emit('key:play', e);
                    break;

                case ANDROID_KEYS.PAUSE:
                case ANDROID_KEYS.PAUSE_ALT:
                    e.preventDefault();
                    eventBus.emit('key:pause', e);
                    break;

                case ANDROID_KEYS.PLAY_PAUSE:
                case ANDROID_KEYS.PLAY_PAUSE_ALT:
                case ANDROID_KEYS.PLAY_PAUSE_LEGACY:
                    e.preventDefault();
                    eventBus.emit('key:playPause', e);
                    break;

                // Media Stop key
                case ANDROID_KEYS.STOP:
                case ANDROID_KEYS.STOP_LEGACY:
                    e.preventDefault();
                    eventBus.emit('key:stop', e);
                    break;

                // Seek Rewind and Fast Forward keys
                case ANDROID_KEYS.REWIND:
                case ANDROID_KEYS.REWIND_ALT:
                case ANDROID_KEYS.REWIND_LEGACY:
                    e.preventDefault();
                    eventBus.emit('key:rewind', e);
                    break;

                case ANDROID_KEYS.FAST_FORWARD:
                case ANDROID_KEYS.FAST_FORWARD_ALT:
                case ANDROID_KEYS.FAST_FORWARD_LEGACY:
                    e.preventDefault();
                    eventBus.emit('key:fastForward', e);
                    break;

                default:
                    break;
            }
        });
    }

    /**
     * ========================================================================
     * Device Information Discovery
     * ========================================================================
     * Queries the native Android bridge for hardware model details.
     * @private
     */
    _loadDeviceInfo() {
        try {
            if (typeof window !== 'undefined' && window.LitefinAndroid?.getDeviceName) {
                this._deviceName = window.LitefinAndroid.getDeviceName();
                log.info(`Connected to Android device: ${this._deviceName}`);
            }
        } catch (err) {
            log.warn('Could not query device name from Android bridge:', err);
        }
    }

    /**
     * Returns the human-readable device model name.
     * @returns {string} Device name or fallback
     */
    getDeviceName() {
        if (this._deviceName) {
            return this._deviceName;
        }

        try {
            if (typeof window !== 'undefined' && window.LitefinAndroid?.getDeviceName) {
                this._deviceName = window.LitefinAndroid.getDeviceName();
                if (this._deviceName) {
                    return this._deviceName;
                }
            }
        } catch (err) {
            log.warn('Failed retrieving device name from LitefinAndroid:', err);
        }

        return 'Android TV';
    }

    /**
     * ========================================================================
     * Application Exit Handler
     * ========================================================================
     * Flushes pending storage cache to disk and terminates the host Android
     * activity via the native LitefinAndroid bridge.
     */
    exit() {
        log.info('Exiting Android application...');

        // Flush all pending storage state to disk before terminating the task
        storage.flush();

        try {
            // 1. Primary native bridge terminating the Android Task directly
            if (typeof window !== 'undefined' && window.LitefinAndroid?.exit) {
                log.info('Invoking native LitefinAndroid.exit() bridge');
                window.LitefinAndroid.exit();
                return;
            }

            // 2. Tauri v2 IPC bridge fallback if bridge is unavailable
            if (typeof window !== 'undefined' && window.__TAURI_INTERNALS__?.invoke) {
                log.info('Invoking Tauri internal exit command');
                window.__TAURI_INTERNALS__.invoke('plugin:app|exit').catch(() => {
                    window.close();
                });
                return;
            }

            // 3. Browser window close fallback
            log.info('Falling back to window.close()');
            window.close();
        } catch (err) {
            log.error('Failed to exit Android application cleanly:', err);
        }
    }
}

// Export singleton instance and class definition
export const androidAdapter = new AndroidAdapter();
export default androidAdapter;
