/**
 * ============================================================================
 * Litefin - Android Platform & Mobile Touch Adapter
 * ============================================================================
 * Handles Android TV, mobile phones, tablets, and Tauri Android shells:
 * - Responsive display scaling via CSS zoom for phones & tablets (landscape & portrait)
 * - Native touch horizontal row scrolling via TouchHorizontalScroller
 * - Hardware remote control & physical keyboard key mappings (D-pad, Media, Back)
 * - Hardware Back button interception to drive unified Litefin back navigation
 * - Native bridge integration (AndroidBridge, LitefinAndroid, Tauri IPC exit)
 * - Idle tracking for screensavers and power management
 * ============================================================================
 */

import { eventBus } from '../core/EventBus.js';
import { storage } from '../utils/StorageService.js';
import { logger } from '../utils/Logger.js';
import { touchHorizontalScroller } from './TouchHorizontalScroller.js';

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
    PREV: 88,

    // Channel stepping
    PAGE_UP: 33,
    PAGE_DOWN: 34
};

class AndroidAdapter {
    constructor() {
        // Tracks whether adapter has been initialized
        this._initialized = false;

        // Cached human-readable device model and brand
        this._deviceName = null;
        this._manufacturer = null;

        // Tracks timestamp of last user interaction for screensaver
        this._lastInputTime = Date.now();
    }

    /**
     * ========================================================================
     * Initialization & Global Listener Registration
     * ========================================================================
     * Executed when DOM is ready during application startup.
     */
    init() {
        if (this._initialized) {
            return;
        }
        this._initialized = true;

        log.info('Initializing AndroidAdapter...');

        // Expose adapter reference on window for native activity routing
        if (typeof window !== 'undefined') {
            window.androidAdapter = this;
            try {
                // Hook invoked by native host when hardware back button or gesture is detected
                window.__litefinAndroidBack = () => this.handleHardwareBack();
            } catch (e) {
                log.warn('Failed registering __litefinAndroidBack global:', e);
            }
        }

        // Initialize user interaction timestamp
        this._lastInputTime = Date.now();

        // Register hardware remote and physical keyboard input listeners
        this._setupKeyHandler();

        // Track touch and pointer interactions to keep power timers alive
        document.addEventListener('mousemove', () => this.reportInput(), { passive: true });
        document.addEventListener('mousedown', () => this.reportInput(), { passive: true });
        document.addEventListener('touchstart', () => this.reportInput(), { passive: true });

        // Initialize native-feel touch scrolling for media rows
        if (typeof touchHorizontalScroller !== 'undefined' && touchHorizontalScroller?.init) {
            touchHorizontalScroller.init();
        }

        // Ensure viewport meta tag is properly configured:
        // - Android TV: locked to width=1920 for identical 1080p canvas proportions
        // - Mobile & Tablets: width=device-width for responsive layout & touch scaling
        if (typeof document !== 'undefined' && typeof document.querySelector === 'function') {
            const metaViewport = document.querySelector('meta[name="viewport"]');
            if (this.isAndroidTv) {
                if (metaViewport && metaViewport.getAttribute('content') !== 'width=1920, user-scalable=no') {
                    metaViewport.setAttribute('content', 'width=1920, user-scalable=no');
                }
            } else {
                if (metaViewport && metaViewport.getAttribute('content')?.includes('width=1920')) {
                    metaViewport.setAttribute('content', 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no');
                }
                // Stamp touch-primary input indicator onto root element for mobile phones and tablets
                document.documentElement?.setAttribute?.('data-litefin-touch', '1');
            }
        }

        // Display scaling: phone and tablet viewports use CSS zoom scaling.
        // Android TV runs at 1:1 scale on the 1920 canvas without zoom.
        if (!this.isAndroidTv) {
            this._applyDisplayScale();
        } else {
            document.documentElement?.style?.removeProperty('zoom');
            document.documentElement?.removeAttribute?.('data-litefin-scaled');
            document.documentElement?.style?.removeProperty('--litefin-app-w');
            document.documentElement?.style?.removeProperty('--litefin-app-h');
        }

        // Retrieve hardware details from native bridge
        this._loadDeviceInfo();

        // Signal native shell that bootstrap has finished
        this._notifyReady();

        log.info(`AndroidAdapter initialized successfully (isAndroidTv: ${this.isAndroidTv})`);
    }

    /**
     * Determines whether the current host device is an Android TV / Google TV.
     * Evaluates native bridge isTv() method or user agent / touch capabilities fallback.
     * @returns {boolean} True if running on Android TV
     */
    get isAndroidTv() {
        try {
            if (typeof window !== 'undefined') {
                if (typeof window.LitefinAndroid?.isTv === 'function') {
                    return !!window.LitefinAndroid.isTv();
                }
                if (typeof window.AndroidBridge?.isTv === 'function') {
                    return !!window.AndroidBridge.isTv();
                }
            }
            if (typeof navigator !== 'undefined' && navigator.userAgent) {
                const ua = navigator.userAgent;
                const hasTvToken = /Android.*(TV|Television|GoogleTV|Large Screen|SmartTV|BRAVIA|AFT|Nexus Player|MIBOX|SHIELD)/i.test(ua);
                const isNonMobileWithoutTouch = !/Mobile/i.test(ua) && (typeof window === 'undefined' || !('ontouchstart' in window) || navigator.maxTouchPoints === 0);
                return hasTvToken || isNonMobileWithoutTouch;
            }
        } catch (_) {}
        return false;
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
     * Enters or exits native OS fullscreen mode.
     * On Android mobile devices, hides the system status bar and navigation pill.
     * @param {boolean} fullscreen - True to enter fullscreen, false to exit
     */
    setFullscreen(fullscreen) {
        try {
            if (typeof window !== 'undefined') {
                if (typeof window.LitefinAndroid?.setFullscreen === 'function') {
                    window.LitefinAndroid.setFullscreen(fullscreen);
                    return;
                }
                if (typeof window.AndroidBridge?.setFullscreen === 'function') {
                    window.AndroidBridge.setFullscreen(fullscreen);
                    return;
                }
            }
            if (typeof document !== 'undefined') {
                if (fullscreen) {
                    if (document.documentElement.requestFullscreen) {
                        document.documentElement.requestFullscreen().catch(() => {});
                    } else if (document.documentElement.webkitRequestFullscreen) {
                        document.documentElement.webkitRequestFullscreen();
                    }
                } else {
                    if (document.exitFullscreen) {
                        document.exitFullscreen().catch(() => {});
                    } else if (document.webkitExitFullscreen) {
                        document.webkitExitFullscreen();
                    }
                }
            }
        } catch (e) {
            log.warn('Failed toggling fullscreen in AndroidAdapter:', e);
        }
    }

    /**
     * ========================================================================
     * Centralized Hardware Back Dispatcher
     * ========================================================================
     * Invoked when the user triggers the physical remote Back button or system
     * predictive back navigation gesture. Dispatches `key:back` onto Litefin's
     * eventBus so open dialogs, menus, and pages can handle navigation cleanly.
     * @param {Object} [payload] - Optional metadata from native shell
     */
    handleHardwareBack(payload = {}) {
        this.reportInput();
        log.info('Hardware Back event received from native Android layer');

        // Central eventBus emission matching Tizen and WebOS back handling
        eventBus.emit('key:back', { source: 'android-bridge', ...payload });
    }

    /**
     * Backwards-compatible alias for handleHardwareBack.
     * @param {Object} [payload]
     */
    handleBackButton(payload = {}) {
        this.handleHardwareBack(payload);
    }

    /**
     * ========================================================================
     * Key Event Setup & Spatial Navigation Controls
     * ========================================================================
     * Configures document-level keyboard listeners for Android TV remotes and
     * external Bluetooth/USB keyboards.
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

                // Channel stepping
                case ANDROID_KEYS.PAGE_UP:
                    eventBus.emit('key:channelUp', e);
                    break;
                case ANDROID_KEYS.PAGE_DOWN:
                    eventBus.emit('key:channelDown', e);
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
     * =========================================================================
     * Portrait Display Scale Calculation
     * =========================================================================
     * Fits a fixed design width (750px) using CSS zoom so the TV-authored layout
     * fills phone screens cleanly in portrait orientation.
     * @private
     * @returns {boolean} True if viewport was portrait and handled
     */
    _applyPortraitScale() {
        const isPortrait = window.innerHeight > window.innerWidth;
        if (!isPortrait) {
            return false;
        }

        try {
            const PORTRAIT_DESIGN_WIDTH = 750;
            const MIN_SCALE = 0.15;

            const scale = Math.min(1, Math.max(MIN_SCALE, window.innerWidth / PORTRAIT_DESIGN_WIDTH));
            const root = document.documentElement;
            const appEl = document.getElementById('app');

            if (scale >= 1) {
                // Desktop-sized portrait window
                root.style.removeProperty('zoom');
                root.removeAttribute('data-litefin-scaled');
                root.style.removeProperty('--litefin-app-w');
                root.style.removeProperty('--litefin-app-h');
                if (appEl) {
                    appEl.style.removeProperty('width');
                    appEl.style.removeProperty('height');
                }
            } else {
                const designW = `${Math.round(window.innerWidth / scale)}px`;
                const designH = `${Math.round(window.innerHeight / scale)}px`;

                root.style.setProperty('zoom', String(scale));
                root.setAttribute('data-litefin-scaled', '1');
                root.style.setProperty('--litefin-app-w', designW);
                root.style.setProperty('--litefin-app-h', designH);

                if (appEl) {
                    appEl.style.width = designW;
                    appEl.style.height = designH;
                }
            }

            log.debug(`Portrait scale applied: ${scale.toFixed(3)} (${window.innerWidth}x${window.innerHeight})`);
        } catch (e) {
            log.warn('Failed applying portrait display scale:', e);
        }
        return true;
    }

    /**
     * =========================================================================
     * Display Scaling Engine (Phones & Tablets)
     * =========================================================================
     * Scales the 1600px TV layout to fit physical screen dimensions via CSS zoom.
     * Re-evaluates continuously on resize and orientation change events.
     * @private
     */
    _applyDisplayScale() {
        const DESIGN_WIDTH = 1600;
        const MIN_SCALE = 0.15;

        const apply = () => {
            // Check portrait first: if handled, bypass landscape computation
            if (this._applyPortraitScale()) {
                return;
            }

            try {
                const scale = Math.min(1, Math.max(MIN_SCALE, window.innerWidth / DESIGN_WIDTH));
                const root = document.documentElement;
                const appEl = document.getElementById('app');

                if (scale >= 1) {
                    // Full TV/Desktop dimension screen
                    root.style.removeProperty('zoom');
                    root.removeAttribute('data-litefin-scaled');
                    root.style.removeProperty('--litefin-app-w');
                    root.style.removeProperty('--litefin-app-h');
                    if (appEl) {
                        appEl.style.removeProperty('width');
                        appEl.style.removeProperty('height');
                    }
                } else {
                    root.style.setProperty('zoom', String(scale));
                    root.setAttribute('data-litefin-scaled', '1');

                    const designW = `${Math.round(window.innerWidth / scale)}px`;
                    const designH = `${Math.round(window.innerHeight / scale)}px`;

                    root.style.setProperty('--litefin-app-w', designW);
                    root.style.setProperty('--litefin-app-h', designH);

                    if (appEl) {
                        appEl.style.width = designW;
                        appEl.style.height = designH;
                    }
                }

                log.debug(`Landscape scale applied: ${scale.toFixed(3)} (${window.innerWidth}x${window.innerHeight})`);
            } catch (e) {
                log.warn('Failed applying landscape display scale:', e);
            }
        };

        apply();
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
            window.addEventListener('resize', apply, { passive: true });
        }
    }

    /**
     * Notifies native shell that JavaScript application has finished bootstrapping.
     * @private
     */
    _notifyReady() {
        try {
            if (typeof window.AndroidBridge?.notifyAppReady === 'function') {
                window.AndroidBridge.notifyAppReady();
            }
        } catch (e) {
            log.warn('notifyAppReady invocation failed:', e);
        }
    }

    /**
     * ========================================================================
     * Device Information Discovery
     * ========================================================================
     * Queries native Android bridges for hardware details.
     * @private
     */
    _loadDeviceInfo() {
        try {
            if (typeof window !== 'undefined') {
                const model = window.AndroidBridge?.getDeviceModel?.() || window.LitefinAndroid?.getDeviceName?.();
                if (model) {
                    this._deviceName = String(model);
                    log.info(`Identified Android device model: ${this._deviceName}`);
                }
                const brand = window.AndroidBridge?.getDeviceBrand?.() || window.LitefinAndroid?.getDeviceBrand?.();
                if (brand) {
                    this._manufacturer = String(brand);
                }
            }
        } catch (err) {
            log.warn('Failed retrieving device info from native bridge:', err);
        }
    }

    /**
     * Returns human-readable device model name.
     * @returns {string}
     */
    getDeviceName() {
        if (this._deviceName) {
            return this._deviceName;
        }
        try {
            if (typeof window !== 'undefined') {
                const model = window.AndroidBridge?.getDeviceModel?.() || window.LitefinAndroid?.getDeviceName?.();
                if (model) {
                    this._deviceName = String(model);
                    return this._deviceName;
                }
            }
        } catch (err) {
            log.warn('Failed retrieving device name:', err);
        }
        return 'Android Device';
    }

    /**
     * Returns device manufacturer name.
     * @returns {string}
     */
    getManufacturer() {
        if (this._manufacturer) {
            return this._manufacturer;
        }
        try {
            if (typeof window !== 'undefined') {
                const brand = window.AndroidBridge?.getDeviceBrand?.() || window.LitefinAndroid?.getDeviceBrand?.();
                if (brand) {
                    this._manufacturer = String(brand);
                    return this._manufacturer;
                }
            }
        } catch (err) {
            log.warn('Failed retrieving manufacturer:', err);
        }
        return 'Android';
    }

    /**
     * ========================================================================
     * Application Exit Handler
     * ========================================================================
     * Flushes pending storage cache to disk and terminates the host Android
     * activity via native bridge or Tauri IPC.
     */
    exit() {
        log.info('Exiting Android application...');

        // Flush all pending storage state to disk
        try {
            storage.flush();
        } catch (err) {
            log.warn('Storage flush failed during exit:', err);
        }

        try {
            // 1. Check window.LitefinAndroid.exit() bridge
            if (typeof window !== 'undefined' && typeof window.LitefinAndroid?.exit === 'function') {
                log.info('Invoking native LitefinAndroid.exit() bridge');
                window.LitefinAndroid.exit();
                return;
            }

            // 2. Check window.AndroidBridge.exitApp() bridge
            if (typeof window !== 'undefined' && typeof window.AndroidBridge?.exitApp === 'function') {
                log.info('Invoking AndroidBridge.exitApp() bridge');
                window.AndroidBridge.exitApp();
                return;
            }

            // 3. Tauri v2 IPC bridge fallback
            if (typeof window !== 'undefined' && window.__TAURI_INTERNALS__?.invoke) {
                log.info('Invoking Tauri plugin:app|exit IPC command');
                window.__TAURI_INTERNALS__.invoke('plugin:app|exit').catch(() => {
                    window.close();
                });
                return;
            }

            // 4. Browser window close fallback
            log.info('Falling back to window.close()');
            window.close();
        } catch (err) {
            log.error('Failed exiting Android application cleanly:', err);
        }
    }
}

// Export singleton instance and class definition
export const androidAdapter = new AndroidAdapter();
export default androidAdapter;
