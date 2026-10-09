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

        // Inject responsive layout rescue stylesheets for mobile phones
        this._injectLandscapeRescueCSS();
        this._injectPortraitRescueCSS();

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
     * Landscape Hero & Layout Rescue CSS (Scaled Viewports Only)
     * =========================================================================
     * The home hero anchors text to the bottom of a 1080p TV canvas with fixed
     * 470px padding and pulls media rows with negative margins (-300px..-550px).
     * On landscape mobile phones, those offsets push headlines offscreen.
     *
     * This stylesheet adjusts spacing specifically when html[data-litefin-scaled]
     * is set and viewport orientation is landscape. It also enlarges the root
     * rem base to ensure comfortable typography on phone screens.
     * @private
     */
    _injectLandscapeRescueCSS() {
        try {
            const style = document.createElement('style');
            style.id = 'litefin-landscape-rescue';
            style.textContent = [
                '/*',
                ' * ========================================================================',
                ' * ANDROID TOUCH-PRIMARY TOOLTIP OVERHAUL (orientation-independent)',
                ' * ========================================================================',
                ' */',
                'html[data-litefin-touch] .sidebar:not(#nonexistent) .sidebar-item:not(#sidebar-sub-libraries *):focus-visible:not(#fv-item) .item-text,',
                'html[data-litefin-touch] .sidebar:not(#nonexistent) .sidebar-item:not(#sidebar-sub-libraries *):focus-visible:not(#fv-item) .sidebar-user-name,',
                'html[data-litefin-touch] .sidebar:not(#nonexistent) .sidebar-item:not(#sidebar-sub-libraries *):focus-visible:not(#fv-item) .sidebar-syncplay-label,',
                'html[data-litefin-touch] .sidebar:not(#nonexistent) #sidebar-logo-header:focus-visible:not(#fv-item) .logo-tooltip {',
                '    display: inline-block !important;',
                '    opacity: 1 !important;',
                '    visibility: visible !important;',
                '    -webkit-transform: translate3d(0, -50%, 0) scale(1) !important;',
                '    transform: translate3d(0, -50%, 0) scale(1) !important;',
                '}',
                'html[data-litefin-touch] .sidebar:not(#nonexistent) .sidebar-item:not(#sidebar-sub-libraries *):not(:active) .item-text,',
                'html[data-litefin-touch] .sidebar:not(#nonexistent) .sidebar-item:not(#sidebar-sub-libraries *):not(:active) .sidebar-user-name,',
                'html[data-litefin-touch] .sidebar:not(#nonexistent) .sidebar-item:not(#sidebar-sub-libraries *):not(:active) .sidebar-syncplay-label,',
                'html[data-litefin-touch] .sidebar:not(#nonexistent) #sidebar-logo-header:not(:active) .logo-tooltip {',
                '    display: none !important;',
                '    opacity: 0 !important;',
                '    visibility: hidden !important;',
                '    -webkit-transform: translate3d(0, -50%, 0) scale(0.9) !important;',
                '    transform: translate3d(0, -50%, 0) scale(0.9) !important;',
                '}',
                'html[data-litefin-touch] .sidebar:not(#nonexistent) .sidebar-item:not(#sidebar-sub-libraries *):active:not(#active-boost) .item-text,',
                'html[data-litefin-touch] .sidebar:not(#nonexistent) .sidebar-item:not(#sidebar-sub-libraries *):active:not(#active-boost) .sidebar-user-name,',
                'html[data-litefin-touch] .sidebar:not(#nonexistent) .sidebar-item:not(#sidebar-sub-libraries *):active:not(#active-boost) .sidebar-syncplay-label,',
                'html[data-litefin-touch] .sidebar:not(#nonexistent) #sidebar-logo-header:active:not(#active-boost) .logo-tooltip {',
                '    display: inline-block !important;',
                '    opacity: 1 !important;',
                '    visibility: visible !important;',
                '    -webkit-transform: translate3d(0, -50%, 0) scale(1) !important;',
                '    transform: translate3d(0, -50%, 0) scale(1) !important;',
                '}',
                'html[data-litefin-touch] .sidebar:not(#nonexistent) .sidebar-item.focused:not(#sidebar-sub-libraries *):not(:active) .item-text,',
                'html[data-litefin-touch] .sidebar:not(#nonexistent) #sidebar-logo-header.focused:not(:active) .logo-tooltip {',
                '    display: inline-block !important;',
                '    opacity: 1 !important;',
                '    visibility: visible !important;',
                '}',
                'html[data-litefin-touch] .sidebar:not(#nonexistent) .sidebar-item.focused:not(#sidebar-sub-libraries *):not(:active) .sidebar-user-name,',
                'html[data-litefin-touch] .sidebar:not(#nonexistent) .sidebar-item.focused:not(#sidebar-sub-libraries *):not(:active) .sidebar-syncplay-label {',
                '    display: none !important;',
                '    opacity: 0 !important;',
                '    visibility: hidden !important;',
                '}',
                '@media (orientation: landscape) {',
                '    html[data-litefin-scaled] .home-rows {',
                '        margin-top: -160px !important;',
                '    }',
                '    html[data-litefin-scaled] .hero-carousel-container .hero-item {',
                '        padding-bottom: 180px !important;',
                '    }',
                '    html[data-litefin-scaled] {',
                '        font-size: 22px !important;',
                '        --card-title-font-scale: 1.3 !important;',
                '    }',
                '    html[data-litefin-scaled] .details-backdrop {',
                '        width: var(--litefin-app-w, 100vw) !important;',
                '        height: var(--litefin-app-h, 100vh) !important;',
                '    }',
                '    html[data-litefin-scaled] .splash-content {',
                '        width: var(--litefin-app-w, 100vw) !important;',
                '        height: var(--litefin-app-h, 100vh) !important;',
                '    }',
                '    html[data-litefin-scaled] .page-loading {',
                '        width: var(--litefin-app-w, 100vw) !important;',
                '        height: var(--litefin-app-h, 100vh) !important;',
                '    }',
                '    html[data-litefin-scaled] .epg-grid-container {',
                '        height: calc(var(--litefin-app-h, 100vh) - 203px) !important;',
                '        touch-action: none;',
                '    }',
                '    html[data-litefin-scaled] #sidebar-sub-libraries {',
                '        left: 358px !important;',
                '    }',
                '    html[data-litefin-scaled] .livetv-page .page-content {',
                '        padding-top: 12px;',
                '        padding-bottom: 12px;',
                '        overscroll-behavior: none;',
                '    }',
                '    html[data-litefin-scaled] .livetv-page .page-header {',
                '        padding-top: 12px;',
                '        padding-bottom: 12px;',
                '        margin-bottom: 12px;',
                '    }',
                '    html[data-litefin-scaled] .livetv-page .page-header h1 {',
                '        font-size: 2.2rem;',
                '        line-height: 1.15;',
                '        margin-bottom: 14px;',
                '    }',
                '    html[data-litefin-scaled] .livetv-page .ltv-tab-header {',
                '        padding: 4px;',
                '    }',
                '    html[data-litefin-scaled] .livetv-page .ltv-tab-btn {',
                '        padding: 10px 30px !important;',
                '    }',
                '    html[data-litefin-scaled] .login-page .login-container {',
                '        align-items: stretch !important;',
                '        max-width: none !important;',
                '        padding: 0 !important;',
                '        gap: 0 !important;',
                '    }',
                '    html[data-litefin-scaled] .login-page .login-header {',
                '        flex: 0 0 420px !important;',
                '        width: 420px !important;',
                '        height: 100% !important;',
                '        margin: 0 !important;',
                '        padding: 0 44px !important;',
                '        justify-content: center !important;',
                '        align-items: flex-start !important;',
                '        gap: 0 !important;',
                '        border-right: 1px solid rgba(255, 255, 255, 0.08) !important;',
                '    }',
                '    html[data-litefin-scaled] .login-page .login-logo-container {',
                '        flex-direction: row !important;',
                '        justify-content: flex-start !important;',
                '        align-items: center !important;',
                '        gap: 18px !important;',
                '        margin-bottom: 14px !important;',
                '    }',
                '    html[data-litefin-scaled] .login-page .login-logo-container img,',
                '    html[data-litefin-scaled] .login-page .login-logo-container svg,',
                '    html[data-litefin-scaled] .login-page .login-logo-svg,',
                '    html[data-litefin-scaled] .login-page .login-logo-img {',
                '        width: 84px !important;',
                '        height: 84px !important;',
                '        max-height: 84px !important;',
                '    }',
                '    html[data-litefin-scaled] .login-page .login-logo {',
                '        font-size: 4.2rem !important;',
                '        font-weight: 600 !important;',
                '        letter-spacing: -0.5px !important;',
                '        text-align: left !important;',
                '    }',
                '    html[data-litefin-scaled] .login-page .login-tagline {',
                '        font-size: 1.35rem !important;',
                '        line-height: 1.5 !important;',
                '        text-align: left !important;',
                '        color: rgba(255, 255, 255, 0.6) !important;',
                '        max-width: 100% !important;',
                '        margin-top: 0 !important;',
                '        overflow-wrap: anywhere !important;',
                '    }',
                '    html[data-litefin-scaled] .login-page .login-section {',
                '        flex: 1 1 auto !important;',
                '        width: auto !important;',
                '        height: 100% !important;',
                '        justify-content: center !important;',
                '        align-items: stretch !important;',
                '        padding: 24px 72px 24px 64px !important;',
                '        overflow-y: hidden !important;',
                '    }',
                '    html[data-litefin-scaled] .login-page .section-title {',
                '        font-size: 3.4rem !important;',
                '        font-weight: 800 !important;',
                '        line-height: 1.08 !important;',
                '        letter-spacing: -1px !important;',
                '        text-align: left !important;',
                '        margin: 0 0 12px !important;',
                '        border: none !important;',
                '        background: linear-gradient(100deg, #ffffff 0%, #ffffff 34%, #a78bfa 58%, #60a5fa 82%) !important;',
                '        -webkit-background-clip: text !important;',
                '        background-clip: text !important;',
                '        -webkit-text-fill-color: transparent !important;',
                '        color: transparent !important;',
                '        max-width: 100% !important;',
                '        overflow-wrap: anywhere !important;',
                '    }',
                '    html[data-litefin-scaled] .login-page .input-label {',
                '        font-size: 1.3rem !important;',
                '        font-weight: 400 !important;',
                '        line-height: 1.4 !important;',
                '        color: rgba(255, 255, 255, 0.62) !important;',
                '        text-align: left !important;',
                '        margin: 0 0 20px !important;',
                '        max-width: 100% !important;',
                '    }',
                '    html[data-litefin-scaled] .login-page .server-input-container {',
                '        width: 100% !important;',
                '        max-width: 100% !important;',
                '        background: rgba(255, 255, 255, 0.045) !important;',
                '        border: 1px solid rgba(255, 255, 255, 0.09) !important;',
                '        border-radius: 24px !important;',
                '        padding: 20px !important;',
                '        box-sizing: border-box !important;',
                '    }',
                '    html[data-litefin-scaled] .login-page .server-url-input {',
                '        font-size: 1.4rem !important;',
                '        height: 72px !important;',
                '        width: 100% !important;',
                '        background: rgba(0, 0, 0, 0.35) !important;',
                '        border: 2px solid rgba(167, 139, 250, 0.55) !important;',
                '        border-radius: 18px !important;',
                '        padding: 0 24px !important;',
                '        box-sizing: border-box !important;',
                '        color: #fff !important;',
                '    }',
                '    html[data-litefin-scaled] .login-page .connect-btn {',
                '        font-size: 1.4rem !important;',
                '        font-weight: 700 !important;',
                '        height: 72px !important;',
                '        width: 100% !important;',
                '        margin-top: 18px !important;',
                '        border: none !important;',
                '        border-radius: 999px !important;',
                '        background: linear-gradient(90deg, #8b5cf6 0%, #6366f1 45%, #3b82f6 100%) !important;',
                '        color: #ffffff !important;',
                '        box-shadow: 0 10px 28px rgba(99, 102, 241, 0.38) !important;',
                '    }',
                '    html[data-litefin-scaled] .login-page .discovered-servers {',
                '        width: 100% !important;',
                '        max-width: 100% !important;',
                '        margin-top: 26px !important;',
                '        background: transparent !important;',
                '        border: none !important;',
                '        padding: 0 !important;',
                '    }',
                '    html[data-litefin-scaled] .login-page .discovered-header {',
                '        display: flex !important;',
                '        align-items: center !important;',
                '        gap: 16px !important;',
                '        margin-bottom: 14px !important;',
                '    }',
                '    html[data-litefin-scaled] .login-page .discovered-header h3 {',
                '        font-size: 1.15rem !important;',
                '        font-weight: 700 !important;',
                '        letter-spacing: 3px !important;',
                '        text-transform: uppercase !important;',
                '        color: rgba(255, 255, 255, 0.55) !important;',
                '        margin: 0 !important;',
                '        padding: 0 !important;',
                '    }',
                '    html[data-litefin-scaled] .login-page .discovered-header::after {',
                '        content: "" !important;',
                '        flex: 1 !important;',
                '        height: 2px !important;',
                '        background: rgba(255, 255, 255, 0.18) !important;',
                '        margin-right: 8px !important;',
                '    }',
                '    html[data-litefin-scaled] .login-page .refresh-btn {',
                '        color: rgba(255, 255, 255, 0.75) !important;',
                '        min-width: 52px !important;',
                '        min-height: 52px !important;',
                '        display: flex !important;',
                '        align-items: center !important;',
                '        justify-content: center !important;',
                '    }',
                '    html[data-litefin-scaled] .login-page .refresh-btn svg {',
                '        width: 26px !important;',
                '        height: 26px !important;',
                '    }',
                '    html[data-litefin-scaled] .login-page .server-list li,',
                '    html[data-litefin-scaled] .login-page .server-list .server-item {',
                '        font-size: 1.3rem !important;',
                '        min-height: 76px !important;',
                '        padding: 14px 24px !important;',
                '        background: rgba(255, 255, 255, 0.045) !important;',
                '        border: 1px solid rgba(255, 255, 255, 0.09) !important;',
                '        border-radius: 20px !important;',
                '        margin-bottom: 12px !important;',
                '    }',
                '    html[data-litefin-scaled] .login-page .server-item.empty {',
                '        color: rgba(255, 255, 255, 0.5) !important;',
                '        justify-content: center !important;',
                '        font-size: 1.25rem !important;',
                '    }',
                '    html[data-litefin-scaled] .hero-carousel-container.immersive .hero-carousel {',
                '        height: var(--litefin-app-h, 90vh) !important;',
                '        min-height: var(--litefin-app-h, 650px) !important;',
                '    }',
                '    html[data-litefin-scaled] .hero-carousel-container.immersive .hero-indicators {',
                '        bottom: 400px !important;',
                '    }',
                '    html[data-litefin-scaled] .hero-carousel-container.immersive .hero-item {',
                '        padding-bottom: 423px !important;',
                '    }',
                '    html[data-litefin-scaled] #home-hero-placeholder.style-immersive + .home-rows {',
                '        margin-top: -405px !important;',
                '    }',
                '    html[data-litefin-scaled] .settings-content-panel {',
                '        padding: 48px 72px;',
                '    }',
                '    html[data-litefin-scaled] .content-title {',
                '        padding-bottom: 28px;',
                '    }',
                '    html[data-litefin-scaled] .content-subtitle {',
                '        margin: -8px 0 18px 0;',
                '        padding-bottom: 16px;',
                '    }',
                '    html[data-litefin-scaled] .setting-section-title {',
                '        margin-top: 36px;',
                '        margin-bottom: 24px;',
                '        padding-bottom: 14px;',
                '    }',
                '    html[data-litefin-scaled] .setting-item {',
                '        padding: 28px 24px;',
                '        min-height: 96px;',
                '        margin: 14px 0;',
                '    }',
                '    html[data-litefin-scaled] .setting-name {',
                '        margin-bottom: 10px;',
                '    }',
                '    html[data-litefin-scaled] .settings-sidebar {',
                '        width: 430px;',
                '        padding: 44px 0;',
                '    }',
                '    html[data-litefin-scaled] .settings-sidebar-header {',
                '        padding: 0 44px;',
                '        margin-bottom: 28px;',
                '    }',
                '    html[data-litefin-scaled] .settings-sidebar-header h2 {',
                '        font-size: 2.4rem;',
                '    }',
                '    html[data-litefin-scaled] .settings-menu-btn {',
                '        font-size: 1.5rem !important;',
                '        padding: 16px 24px;',
                '        margin: 8px 18px;',
                '        min-height: 68px;',
                '    }',
                '    html[data-litefin-scaled] .settings-menu-btn .menu-icon {',
                '        width: 31px;',
                '        height: 31px;',
                '        margin-right: 17px;',
                '    }',
                '    html[data-litefin-scaled] .btn-option {',
                '        padding: 14px 26px;',
                '    }',
                '    html[data-litefin-scaled] .profiles-dialog {',
                '        width: 87% !important;',
                '        max-height: calc(var(--litefin-app-h, 100vh) * 0.8) !important;',
                '    }',
                '    html[data-litefin-scaled] .profiles-dialog .modal-options {',
                '        max-height: none !important;',
                '    }',
                '}'
            ].join('\n');
            document.head.appendChild(style);
        } catch (e) {
            log.warn('Failed to inject landscape rescue CSS:', e);
        }
    }

    /**
     * =========================================================================
     * Portrait Rescue CSS (Portrait Viewports Only)
     * =========================================================================
     * When the device is held vertically, this stylesheet:
     * - Adjusts the root font scaling and tightens the collapsed navigation bar
     * - Enables natural vertical scrolling on #app
     * - Stacks media details posters above metadata for responsive readability
     * - Restructures settings, login screens, and Live TV grids for portrait use
     * @private
     */
    _injectPortraitRescueCSS() {
        try {
            const style = document.createElement('style');
            style.id = 'litefin-portrait-rescue';
            style.textContent = [
                '@media (orientation: portrait) {',
                '    html[data-litefin-scaled] {',
                '        font-size: 20px !important;',
                '        --card-title-font-scale: 1.15 !important;',
                '        --sidebar-width-collapsed: 64px;',
                '    }',
                '    html[data-litefin-scaled] #app {',
                '        overflow-x: hidden !important;',
                '        overflow-y: auto !important;',
                '    }',
                '    html[data-litefin-scaled] .details-backdrop,',
                '    html[data-litefin-scaled] .splash-content,',
                '    html[data-litefin-scaled] .page-loading {',
                '        width: var(--litefin-app-w, 100vw) !important;',
                '        height: var(--litefin-app-h, 100vh) !important;',
                '    }',
                '    html[data-litefin-scaled] .library-content {',
                '        padding-left: 16px !important;',
                '        padding-right: 16px !important;',
                '    }',
                '    html[data-litefin-scaled] .details-main-split {',
                '        flex-direction: column !important;',
                '        align-items: center !important;',
                '        padding: 24px 16px 0 16px !important;',
                '    }',
                '    html[data-litefin-scaled] .hero-poster {',
                '        width: 100% !important;',
                '        max-width: 300px !important;',
                '        margin-right: 0 !important;',
                '        height: auto !important;',
                '        padding-bottom: 0 !important;',
                '        aspect-ratio: 2 / 3 !important;',
                '    }',
                '    html[data-litefin-scaled] .hero-poster.landscape {',
                '        aspect-ratio: 16 / 9 !important;',
                '    }',
                '    html[data-litefin-scaled] .hero-poster.square {',
                '        aspect-ratio: 1 / 1 !important;',
                '    }',
                '    html[data-litefin-scaled] .details-info-col {',
                '        width: 100% !important;',
                '    }',
                '    html[data-litefin-scaled] .details-logo {',
                '        display: none !important;',
                '    }',
                '    html[data-litefin-scaled] .hero-carousel-container.immersive .hero-carousel {',
                '        height: var(--litefin-app-h, 90vh) !important;',
                '        min-height: var(--litefin-app-h, 650px) !important;',
                '    }',
                '    html[data-litefin-scaled] .hero-carousel-container.immersive .hero-item {',
                '        padding-bottom: 1158px !important;',
                '    }',
                '    html[data-litefin-scaled] .hero-carousel-container.immersive .hero-indicators {',
                '        bottom: 1105px !important;',
                '    }',
                '    html[data-litefin-scaled] #home-hero-placeholder.style-immersive + .home-rows {',
                '        margin-top: -1117px !important;',
                '    }',
                '    html[data-litefin-scaled] .livetv-page .ltv-tab-header {',
                '        padding: 4px;',
                '        max-width: calc(100% - 24px);',
                '        align-self: flex-start !important;',
                '        margin: 0 !important;',
                '    }',
                '    html[data-litefin-scaled] .livetv-page .page-header {',
                '        padding-left: 16px !important;',
                '        padding-right: 16px !important;',
                '    }',
                '    html[data-litefin-scaled] .livetv-page .ltv-tab-btn {',
                '        padding: 10px 18px !important;',
                '        font-size: 1.05rem !important;',
                '        white-space: nowrap;',
                '    }',
                '    html[data-litefin-scaled] .livetv-page .page-content {',
                '        padding-left: 12px !important;',
                '        padding-right: 12px !important;',
                '    }',
                '    html[data-litefin-scaled] .livetv-page .page-content .person-grid {',
                '        padding-left: 0 !important;',
                '        padding-right: 0 !important;',
                '    }',
                '    html[data-litefin-scaled] .person-grid {',
                '        padding-left: 12px !important;',
                '        padding-right: 12px !important;',
                '    }',
                '    html[data-litefin-scaled] .person-grid .media-card {',
                '        width: calc(33.33% - 14px) !important;',
                '        margin-right: 6px !important;',
                '        margin-left: 6px !important;',
                '    }',
                '    html[data-litefin-scaled] .person-grid .card-image {',
                '        height: auto !important;',
                '        aspect-ratio: 1 / 1 !important;',
                '    }',
                '    html[data-litefin-scaled] .sidebar .sidebar-item {',
                '        height: 96px !important;',
                '        min-height: 96px !important;',
                '    }',
                '    html[data-litefin-scaled] .sidebar .item-icon {',
                '        height: 96px !important;',
                '    }',
                '    html[data-litefin-scaled] .sidebar .item-icon svg {',
                '        width: 44px !important;',
                '        height: 44px !important;',
                '        max-height: 44px !important;',
                '    }',
                '    html[data-litefin-scaled] .epg-grid-container {',
                '        height: calc(var(--litefin-app-h, 100vh) - 347px) !important;',
                '        touch-action: none;',
                '    }',
                '    html[data-litefin-scaled] #sidebar-sub-libraries {',
                '        left: 322px !important;',
                '    }',
                '    html[data-litefin-scaled] .settings-split-view {',
                '        overflow-x: hidden !important;',
                '    }',
                '    html[data-litefin-scaled] .settings-page .settings-sidebar {',
                '        width: 260px !important;',
                '        min-width: 260px !important;',
                '        max-width: 260px !important;',
                '        flex-shrink: 0 !important;',
                '        padding: 30px 0 !important;',
                '    }',
                '    html[data-litefin-scaled] .settings-page .settings-menu-btn {',
                '        font-size: 1.5rem !important;',
                '        padding: 16px 22px !important;',
                '        min-height: 64px !important;',
                '        margin: 6px 14px !important;',
                '    }',
                '    html[data-litefin-scaled] .settings-page .settings-menu-btn .menu-icon {',
                '        width: 30px !important;',
                '        height: 30px !important;',
                '        margin-right: 16px !important;',
                '    }',
                '    html[data-litefin-scaled] .settings-page .settings-sidebar-header {',
                '        padding: 0 22px !important;',
                '    }',
                '    html[data-litefin-scaled] .settings-page .settings-sidebar-header h2 {',
                '        font-size: 2.6rem !important;',
                '    }',
                '    html[data-litefin-scaled] .settings-page .settings-content-panel.page-content {',
                '        flex: 1 1 auto !important;',
                '        width: auto !important;',
                '        min-width: 0 !important;',
                '        max-width: none !important;',
                '        padding: 24px 16px !important;',
                '        overflow-x: hidden !important;',
                '    }',
                '    html[data-litefin-scaled] .settings-page .setting-item {',
                '        flex-direction: column !important;',
                '        align-items: stretch !important;',
                '        width: 100% !important;',
                '        min-width: 0 !important;',
                '        padding: 16px 14px !important;',
                '        margin: 10px 0 !important;',
                '        min-height: 0 !important;',
                '    }',
                '    html[data-litefin-scaled] .settings-page .setting-item .setting-label {',
                '        flex: none !important;',
                '        width: 100% !important;',
                '        padding-right: 0 !important;',
                '        margin-bottom: 10px !important;',
                '    }',
                '    html[data-litefin-scaled] .settings-page .setting-item .setting-control {',
                '        flex: none !important;',
                '        width: 100% !important;',
                '        min-width: 0 !important;',
                '        justify-content: flex-start !important;',
                '        flex-wrap: wrap !important;',
                '        gap: 8px !important;',
                '    }',
                '    html[data-litefin-scaled] .settings-page .setting-item .btn-option {',
                '        margin-left: 0 !important;',
                '        min-width: 0 !important;',
                '        max-width: 100% !important;',
                '        padding: 12px 18px !important;',
                '        font-size: 1.15rem !important;',
                '    }',
                '    html[data-litefin-scaled] .settings-page .setting-item input[type="range"],',
                '    html[data-litefin-scaled] .settings-page .setting-item select {',
                '        width: 100% !important;',
                '        max-width: 100% !important;',
                '        min-width: 0 !important;',
                '    }',
                '    html[data-litefin-scaled] .details-page .details-title {',
                '        max-width: 100% !important;',
                '        font-size: 2.6rem !important;',
                '        line-height: 1.15 !important;',
                '        overflow-wrap: anywhere !important;',
                '        word-break: break-word !important;',
                '    }',
                '    html[data-litefin-scaled] .details-page .details-original-title {',
                '        max-width: 100% !important;',
                '        overflow-wrap: anywhere !important;',
                '        word-break: break-word !important;',
                '    }',
                '    html[data-litefin-scaled] .details-page .details-main-split,',
                '    html[data-litefin-scaled] .details-page .details-content {',
                '        overflow-x: hidden !important;',
                '        max-width: 100% !important;',
                '    }',
                '    html[data-litefin-scaled] .details-page .details-info-col,',
                '    html[data-litefin-scaled] .details-page .hero-info {',
                '        max-width: 100% !important;',
                '        min-width: 0 !important;',
                '        overflow-x: hidden !important;',
                '    }',
                '    html[data-litefin-scaled] .login-page .login-container {',
                '        flex-direction: column !important;',
                '        align-items: stretch !important;',
                '        justify-content: flex-start !important;',
                '        width: 100% !important;',
                '        max-width: 100% !important;',
                '        margin: 0 auto !important;',
                '        padding: 96px 20px 32px !important;',
                '        gap: 0 !important;',
                '        overflow-y: auto !important;',
                '    }',
                '    html[data-litefin-scaled] .login-page .login-header {',
                '        flex: none !important;',
                '        width: 100% !important;',
                '        height: auto !important;',
                '        min-height: 0 !important;',
                '        margin: 0 0 36px !important;',
                '        padding: 0 !important;',
                '        justify-content: flex-start !important;',
                '        align-items: center !important;',
                '        gap: 6px !important;',
                '    }',
                '    html[data-litefin-scaled] .login-page .login-logo-container {',
                '        flex-direction: row !important;',
                '        justify-content: center !important;',
                '        align-items: center !important;',
                '        gap: 16px !important;',
                '        margin-bottom: 0 !important;',
                '    }',
                '    html[data-litefin-scaled] .login-page .login-logo-container img,',
                '    html[data-litefin-scaled] .login-page .login-logo-container svg,',
                '    html[data-litefin-scaled] .login-page .login-logo-svg,',
                '    html[data-litefin-scaled] .login-page .login-logo-img {',
                '        width: 72px !important;',
                '        height: 72px !important;',
                '        max-height: 72px !important;',
                '    }',
                '    html[data-litefin-scaled] .login-page .login-logo {',
                '        font-size: 4rem !important;',
                '        font-weight: 600 !important;',
                '        letter-spacing: -0.5px !important;',
                '    }',
                '    html[data-litefin-scaled] .login-page .login-tagline {',
                '        font-size: 1.25rem !important;',
                '        line-height: 1.4 !important;',
                '        text-align: center !important;',
                '        max-width: 100% !important;',
                '        margin-top: 10px !important;',
                '        color: rgba(255, 255, 255, 0.72) !important;',
                '    }',
                '    html[data-litefin-scaled] .login-page .login-section {',
                '        height: auto !important;',
                '        width: 100% !important;',
                '        max-width: 100% !important;',
                '        justify-content: flex-start !important;',
                '        padding-top: 0 !important;',
                '        padding-left: 0 !important;',
                '        padding-right: 0 !important;',
                '    }',
                '    html[data-litefin-scaled] .login-page .section-title {',
                '        font-size: 4.4rem !important;',
                '        font-weight: 800 !important;',
                '        line-height: 1.08 !important;',
                '        letter-spacing: -1px !important;',
                '        text-align: left !important;',
                '        margin: 0 0 18px !important;',
                '        padding: 0 !important;',
                '        border: none !important;',
                '        background: linear-gradient(100deg, #ffffff 0%, #ffffff 38%, #a78bfa 62%, #60a5fa 88%) !important;',
                '        -webkit-background-clip: text !important;',
                '        background-clip: text !important;',
                '        -webkit-text-fill-color: transparent !important;',
                '        color: transparent !important;',
                '        max-width: 100% !important;',
                '        overflow-wrap: anywhere !important;',
                '    }',
                '    html[data-litefin-scaled] .login-page .input-label {',
                '        font-size: 1.5rem !important;',
                '        font-weight: 400 !important;',
                '        line-height: 1.45 !important;',
                '        color: rgba(255, 255, 255, 0.62) !important;',
                '        text-align: left !important;',
                '        margin: 0 0 28px !important;',
                '        max-width: 100% !important;',
                '    }',
                '    html[data-litefin-scaled] .login-page .server-input-container {',
                '        width: 100% !important;',
                '        max-width: 100% !important;',
                '        background: rgba(255, 255, 255, 0.045) !important;',
                '        border: 1px solid rgba(255, 255, 255, 0.09) !important;',
                '        border-radius: 24px !important;',
                '        padding: 24px !important;',
                '        box-sizing: border-box !important;',
                '    }',
                '    html[data-litefin-scaled] .login-page .server-url-input {',
                '        font-size: 1.5rem !important;',
                '        height: 88px !important;',
                '        width: 100% !important;',
                '        background: rgba(0, 0, 0, 0.35) !important;',
                '        border: 2px solid rgba(167, 139, 250, 0.55) !important;',
                '        border-radius: 18px !important;',
                '        padding: 0 24px !important;',
                '        box-sizing: border-box !important;',
                '        color: #fff !important;',
                '    }',
                '    html[data-litefin-scaled] .login-page .connect-btn {',
                '        font-size: 1.5rem !important;',
                '        font-weight: 700 !important;',
                '        height: 84px !important;',
                '        width: 100% !important;',
                '        margin-top: 22px !important;',
                '        border: none !important;',
                '        border-radius: 999px !important;',
                '        background: linear-gradient(90deg, #8b5cf6 0%, #6366f1 45%, #3b82f6 100%) !important;',
                '        color: #ffffff !important;',
                '        box-shadow: 0 10px 28px rgba(99, 102, 241, 0.38) !important;',
                '    }',
                '    html[data-litefin-scaled] .login-page .connect-btn:active {',
                '        transform: scale(0.985) !important;',
                '    }',
                '    html[data-litefin-scaled] .login-page .discovered-servers {',
                '        width: 100% !important;',
                '        max-width: 100% !important;',
                '        margin-top: 40px !important;',
                '        background: transparent !important;',
                '        border: none !important;',
                '        padding: 0 !important;',
                '    }',
                '    html[data-litefin-scaled] .login-page .discovered-header {',
                '        display: flex !important;',
                '        align-items: center !important;',
                '        gap: 14px !important;',
                '        margin-bottom: 18px !important;',
                '    }',
                '    html[data-litefin-scaled] .login-page .discovered-header h3 {',
                '        font-size: 1.15rem !important;',
                '        font-weight: 700 !important;',
                '        letter-spacing: 3px !important;',
                '        text-transform: uppercase !important;',
                '        color: rgba(255, 255, 255, 0.55) !important;',
                '        margin: 0 auto !important;',
                '        position: relative !important;',
                '        padding: 0 18px !important;',
                '    }',
                '    html[data-litefin-scaled] .login-page .discovered-header h3::before,',
                '    html[data-litefin-scaled] .login-page .discovered-header h3::after {',
                '        content: "" !important;',
                '        position: absolute !important;',
                '        top: 50% !important;',
                '        width: 72px !important;',
                '        height: 2px !important;',
                '        background: rgba(255, 255, 255, 0.22) !important;',
                '    }',
                '    html[data-litefin-scaled] .login-page .discovered-header h3::before {',
                '        right: 100% !important;',
                '    }',
                '    html[data-litefin-scaled] .login-page .discovered-header h3::after {',
                '        left: 100% !important;',
                '    }',
                '    html[data-litefin-scaled] .login-page .refresh-btn {',
                '        color: rgba(255, 255, 255, 0.75) !important;',
                '        min-width: 52px !important;',
                '        min-height: 52px !important;',
                '        display: flex !important;',
                '        align-items: center !important;',
                '        justify-content: center !important;',
                '    }',
                '    html[data-litefin-scaled] .login-page .refresh-btn svg {',
                '        width: 26px !important;',
                '        height: 26px !important;',
                '    }',
                '    html[data-litefin-scaled] .login-page .server-list li,',
                '    html[data-litefin-scaled] .login-page .server-list .server-item {',
                '        font-size: 1.45rem !important;',
                '        min-height: 96px !important;',
                '        padding: 18px 24px !important;',
                '        background: rgba(255, 255, 255, 0.045) !important;',
                '        border: 1px solid rgba(255, 255, 255, 0.09) !important;',
                '        border-radius: 20px !important;',
                '        margin-bottom: 14px !important;',
                '    }',
                '    html[data-litefin-scaled] .login-page .server-item.empty {',
                '        color: rgba(255, 255, 255, 0.5) !important;',
                '        justify-content: center !important;',
                '        font-size: 1.35rem !important;',
                '    }',
                '    html[data-litefin-scaled] .login-page .login-actions,',
                '    html[data-litefin-scaled] .login-page .modern-button-row {',
                '        flex-wrap: wrap !important;',
                '        gap: 14px !important;',
                '        max-width: 100% !important;',
                '        overflow-x: hidden !important;',
                '    }',
                '    html[data-litefin-scaled] .login-page .login-actions .btn,',
                '    html[data-litefin-scaled] .login-page .modern-button-row .btn {',
                '        flex: 1 1 45% !important;',
                '        max-width: 100% !important;',
                '        min-width: 0 !important;',
                '        white-space: normal !important;',
                '    }',
                '    html[data-litefin-scaled] .login-page .login-section {',
                '        max-width: 100% !important;',
                '        overflow-x: hidden !important;',
                '    }',
                '    html[data-litefin-scaled] .login-page .login-section .text-input,',
                '    html[data-litefin-scaled] .login-page .login-section input {',
                '        max-width: 100% !important;',
                '        min-width: 0 !important;',
                '        width: calc(100% - 24px) !important;',
                '    }',
                '    html[data-litefin-scaled] .login-page .manual-form-container,',
                '    html[data-litefin-scaled] .login-page .input-group,',
                '    html[data-litefin-scaled] .login-page .input-container {',
                '        padding-left: 12px !important;',
                '        padding-right: 12px !important;',
                '        box-sizing: border-box !important;',
                '    }',
                '}'
            ].join('\n');
            document.head.appendChild(style);
        } catch (e) {
            log.warn('Failed to inject portrait rescue CSS:', e);
        }
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
