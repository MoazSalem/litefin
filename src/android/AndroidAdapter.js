/**
 * ============================================================================
 * Litefin - Android Adapter
 * ============================================================================
 * Handles all Android-specific functionality when running inside the Android
 * WebView host application:
 * - Hardware/system Back gesture and Back button mapping
 * - App exit requests forwarded to the native shell
 * - Device identification for the Jellyfin dashboard (device name/model)
 *
 * Communication with the native shell happens over the injected
 * `window.AndroidBridge` JavascriptInterface (see LitefinBridge.java in the
 * android/ host project). Every bridge call is wrapped in try/catch because
 * the bridge is absent when this bundle runs in a plain desktop browser.
 * ============================================================================
 */

import { eventBus } from '../core/EventBus.js';
import { storage } from '../utils/StorageService.js';
import { logger } from '../utils/Logger.js';

const log = logger.create('AndroidAdapter');

class AndroidAdapter {
    constructor() {
        this._isAndroid = false;
        this._deviceInfo = null;

        // Immediate platform detection via the injected native bridge.
        this._detectPlatform();
    }

    /**
     * Get idle time in milliseconds
     * @returns {number} Idle time
     */
    get idleTime() {
        // The Android shell does not push idle events; report as always active.
        return 0;
    }

    /**
     * Report an input interaction (touch etc from outside). No-op on Android —
     * the OS handles screen-off/idle behavior natively.
     */
    reportInput() {
        /* Intentionally empty — parity with other adapters. */
    }

    /**
     * Detect if running on the Android WebView platform
     * @private
     */
    _detectPlatform() {
        if (typeof window !== 'undefined' && typeof window.AndroidBridge !== 'undefined') {
            this._isAndroid = true;
            log.info('Running on Android adapter mode (native bridge present)');
        } else {
            log.info('Not running on Android platform (bridge absent)');
        }
    }

    /**
     * Initialize Android-specific features.
     * Called from App.init() when platformInfo.isAndroid is true.
     */
    init() {
        if (!this._isAndroid) return;

        log.info('Initializing AndroidAdapter...');

        /*
         * Expose a global hook the native shell invokes when the hardware
         * Back button/gesture is used. The Activity calls
         * window.__litefinAndroidBack() via evaluateJavascript; we translate
         * it into the standard 'key:back' event so all existing TV back
         * handling (modals, router history, exit flow) works unchanged.
         */
        try {
            window.__litefinAndroidBack = () => this.handleBackButton();
        } catch (e) {
            log.warn('Failed to register back hook:', e);
        }

        // Physical-keyboard support (emulator, DeX, keyboards/remotes on phones).
        this._setupKeyboardHandler();

        // Scale the TV-sized UI down to phone screens (see _applyDisplayScale).
        this._injectLandscapeRescueCSS();
        this._applyDisplayScale();

        // Notify the shell that the web app finished booting (hides the
        // native splash window on devices where it is shown).
        this._notifyReady();

        log.info('AndroidAdapter initialized');
    }

    /**
     * =========================================================================
     * Landscape hero rescue (scaled devices only)
     * =========================================================================
     * The immersive home hero anchors its text to the bottom of a tall TV
     * canvas using fixed-pixel padding (470px) and pulls the home rows up with
     * fixed-pixel negative margins (-300px..-550px) — tuned for 1080p TV
     * heights. On a landscape phone the effective canvas is far shorter, so
     * those fixed offsets push the title/metadata ABOVE the top of the screen
     * (title measured at y=-82 in the field).
     *
     * Fix: when the adapter is actually down-scaling the document (zoom < 1,
     * signalled via html[data-litefin-scaled] in _applyDisplayScale), relax
     * those fixed offsets in LANDSCAPE only so the hero text block and rows sit
     * back in the visible area. Portrait is untouched (media query doesn't
     * match), and unscaled viewports (tablets/desktop-size, zoom = 1) keep the
     * stock layout because the attribute is only set while scaling.
     * @private
     */
    _injectLandscapeRescueCSS() {
        try {
            const style = document.createElement('style');
            style.id = 'litefin-landscape-rescue';
            style.textContent = [
                '@media (orientation: landscape) {',
                '    html[data-litefin-scaled] .home-rows {',
                '        margin-top: -160px !important;',
                '    }',
                '    html[data-litefin-scaled] .hero-carousel-container .hero-item {',
                '        padding-bottom: 180px !important;',
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
     * Display Scaling (Android phones/tablets)
     * =========================================================================
     * Litefin's layout is authored for a ~1600-1920px TV viewport. Phone
     * WebViews report the raw CSS viewport (e.g. 915px landscape on a
     * high-density panel), which makes the TV layout render enormous and
     * cropped.
     *
     * We scale the whole document with CSS `zoom` (NOT transform: scale,
     * which does not re-flow layout and leaves dead bands) so the app lays
     * out at its native 16:9 design width and the WebView scales it to fit.
     * Because zoom re-flows, 100vh/100% containers keep filling the screen
     * exactly and focus/scroll geometry stays consistent.
     *
     * - Design width 1600 so a landscape phone renders the full TV layout
     *   at a comfortable physical size on dense panels.
     * - Always fit the full design WIDTH (portrait included — the classic
     *   "desktop site on a phone" view). Never zoom IN beyond 1x (desktop-
     *   size viewports keep the stock layout). Physical size stays legible
     *   because phone panels are high-density (scale x DPR ~ 0.7+).
     * - Re-applied on resize so rotation re-fits automatically.
     * @private
     */
    _applyDisplayScale() {
        const DESIGN_WIDTH = 1600;
        const MIN_SCALE = 0.15; // Safety floor only; portrait lands ~0.26 on phones

        const apply = () => {
            try {
                const scale = Math.min(1, Math.max(MIN_SCALE, window.innerWidth / DESIGN_WIDTH));
                if (scale >= 1) {
                    document.documentElement.style.removeProperty('zoom');
                    // Unscaled viewport: keep the stock layout entirely,
                    // including the landscape hero rescue offsets.
                    document.documentElement.removeAttribute('data-litefin-scaled');
                } else {
                    document.documentElement.style.setProperty('zoom', String(scale));
                    // Signal the appended rescue CSS that we are actively
                    // down-scaling the TV layout (see _injectLandscapeRescueCSS).
                    document.documentElement.setAttribute('data-litefin-scaled', '1');
                }

                /*
                 * #app is styled `width: 100vw; height: 100vh` in base.css. Viewport
                 * units do NOT scale with CSS zoom, so #app (and anything sized with
                 * vw/vh) would stay at the raw viewport size while the rest of the
                 * document scales — clipping the layout. Pin #app to the effective
                 * design-space dimensions so the whole tree lays out consistently.
                 */
                const appEl = document.getElementById('app');
                if (appEl && scale < 1) {
                    appEl.style.width = `${Math.round(window.innerWidth / scale)}px`;
                    appEl.style.height = `${Math.round(window.innerHeight / scale)}px`;
                } else if (appEl) {
                    appEl.style.removeProperty('width');
                    appEl.style.removeProperty('height');
                }

                log.debug(`Display scale: ${scale.toFixed(3)} (viewport ${window.innerWidth}x${window.innerHeight})`);
            } catch (e) {
                log.warn('Failed to apply display scale:', e);
            }
        };

        apply();
        window.addEventListener('resize', apply, { passive: true });
    }

    /**
     * Tell the native shell the app is ready (hides native splash).
     * @private
     */
    _notifyReady() {
        try {
            if (typeof window.AndroidBridge?.notifyAppReady === 'function') {
                window.AndroidBridge.notifyAppReady();
            }
        } catch (e) {
            log.warn('notifyAppReady failed:', e);
        }
    }

    /**
     * Ask the native shell to finish the activity (app exit).
     * Mirrors tizenAdapter.exit() / webosAdapter.exit().
     */
    exit() {
        try {
            storage.flush();
        } catch (_) {
            /* storage may be unavailable very early — non-fatal */
        }
        try {
            if (typeof window.AndroidBridge?.exitApp === 'function') {
                log.info('Exiting application via AndroidBridge.exitApp()');
                window.AndroidBridge.exitApp();
            }
        } catch (e) {
            log.error('Failed to exit via Android bridge:', e);
        }
    }

    /**
     * Get device name for server identification.
     * The bridge exposes Build.MODEL from the native side; falls back to a
     * generic name when the property is missing.
     * @returns {string} Device name (e.g. "SM-S928B" for Galaxy S24 Ultra)
     */
    getDeviceName() {
        try {
            const model = window.AndroidBridge?.getDeviceModel?.();
            if (model) return String(model);
        } catch (e) {
            log.warn('getDeviceModel failed:', e);
        }
        return 'Android Device';
    }

    /**
     * Get device manufacturer
     * @returns {string} Manufacturer name (e.g. "samsung")
     */
    getManufacturer() {
        try {
            const brand = window.AndroidBridge?.getDeviceBrand?.();
            if (brand) return String(brand);
        } catch (e) {
            log.warn('getDeviceBrand failed:', e);
        }
        return 'Android';
    }

    /**
     * Handle the hardware/system Back button dispatched by the native shell.
     * The Android host forwards the back event into the web app; we translate
     * it into the same eventBus message the TV adapters use so every existing
     * back-handler (modals, router history, exit) works unchanged.
     * @param {Object} [payload] - Optional extra data from the shell
     */
    handleBackButton(payload = {}) {
        log.debug('Hardware back pressed');
        eventBus.emit('key:back', { source: 'android-bridge', ...payload });
    }

    /**
     * =========================================================================
     * Physical Keyboard Support
     * =========================================================================
     * Map a physical keyboard (emulator host keyboard, DeX, USB/Bluetooth
     * keyboards) onto the same eventBus key events the TV remotes produce so
     * Litefin is fully drivable without touch. Mirrors TizenAdapter's key
     * mapping, with desktop-browser fallback semantics for Back (Escape /
     * Backspace) so the emulator's keyboard behaves like the web build.
     *
     * Keys that arrive while typing in an input/textarea are left untouched
     * (except Escape, which always cancels via key:back).
     * @private
     */
    _setupKeyboardHandler() {
        // Web-standard keyCodes (KeyboardEvent.keyCode legacy values).
        const KEY = {
            ENTER: 13,
            ESCAPE: 27,
            BACKSPACE: 8,
            LEFT: 37,
            UP: 38,
            RIGHT: 39,
            DOWN: 40,
            SPACE: 32,
            PAGE_UP: 33,
            PAGE_DOWN: 34,
            MEDIA_PLAY: 179,
            MEDIA_PAUSE: 19,
            MEDIA_STOP: 178,
            MEDIA_REWIND: 227,
            MEDIA_FAST_FORWARD: 228
        };

        document.addEventListener(
            'keydown',
            (e) => {
                const keyCode = e.keyCode;

                // Never swallow keystrokes while the user is typing in a text
                // field — the app's own input handling must receive them.
                // (Escape still cancels dialogs via key:back, as on web.)
                const active = document.activeElement;
                const isTextInput =
                    active &&
                    ((active.tagName === 'INPUT' && active.type !== 'range') || active.tagName === 'TEXTAREA');

                switch (keyCode) {
                    case KEY.ENTER:
                        if (!isTextInput) e.preventDefault();
                        eventBus.emit('key:enter', e);
                        break;
                    case KEY.LEFT:
                        if (!isTextInput) e.preventDefault();
                        eventBus.emit('key:left', e);
                        break;
                    case KEY.UP:
                        if (!isTextInput) e.preventDefault();
                        eventBus.emit('key:up', e);
                        break;
                    case KEY.RIGHT:
                        if (!isTextInput) e.preventDefault();
                        eventBus.emit('key:right', e);
                        break;
                    case KEY.DOWN:
                        if (!isTextInput) e.preventDefault();
                        eventBus.emit('key:down', e);
                        break;
                    case KEY.SPACE:
                        // Player play/pause (TizenAdapter semantics) — only when
                        // a text field is not focused.
                        if (!isTextInput) {
                            if (window.location.hash.startsWith('#/player')) {
                                e.preventDefault();
                                eventBus.emit('key:playPause', e);
                            }
                        }
                        break;
                    case KEY.PAGE_UP:
                        eventBus.emit('key:channelUp', e);
                        break;
                    case KEY.PAGE_DOWN:
                        eventBus.emit('key:channelDown', e);
                        break;
                    case KEY.MEDIA_PLAY:
                        e.preventDefault();
                        eventBus.emit('key:play', e);
                        break;
                    case KEY.MEDIA_PAUSE:
                        e.preventDefault();
                        eventBus.emit('key:pause', e);
                        break;
                    case KEY.MEDIA_STOP:
                        e.preventDefault();
                        eventBus.emit('key:stop', e);
                        break;
                    case KEY.MEDIA_REWIND:
                        e.preventDefault();
                        eventBus.emit('key:rewind', e);
                        break;
                    case KEY.MEDIA_FAST_FORWARD:
                        e.preventDefault();
                        eventBus.emit('key:fastForward', e);
                        break;
                    case KEY.ESCAPE:
                    case KEY.BACKSPACE:
                        // Desktop-style Back: Escape always; Backspace only when
                        // not editing text (so text deletion still works).
                        if (keyCode === KEY.ESCAPE || !isTextInput) {
                            e.preventDefault();
                            this.handleBackButton();
                        }
                        break;
                    default:
                        break;
                }
            },
            { capture: true }
        );

        log.info('Physical keyboard handler active (arrows/Enter/Escape/media keys)');
    }

    get isAndroid() {
        return this._isAndroid;
    }
    get deviceInfo() {
        return this._deviceInfo;
    }
}

export const androidAdapter = new AndroidAdapter();
export default androidAdapter;
