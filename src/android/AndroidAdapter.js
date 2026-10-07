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
import { touchHorizontalScroller } from './TouchHorizontalScroller.js';

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

        // Finger-driven horizontal row scrolling (smooth, 1:1 with the
        // finger — matches the vertical scroll feel; Android only).
        touchHorizontalScroller.init();

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
     *
     * The same landscape-only block also raises the rem base font size
     * (16px -> 20px): the whole-app text enlargement for phones. Every text
     * element in the app is rem-based (LayoutManager.setTextScale uses the
     * same lever), so UI text, card labels, metadata and menus all grow
     * together while layout geometry, icons and images stay put. Portrait is
     * excluded by the media query and never changes.
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
                '    /* Landscape-only text enlargement: raise the rem base so ALL',
                '     * text renders ~37% larger on the down-scaled phone layout, and',
                '     * bump the card-label scale variable (card titles/subtitles are',
                '     * calc(rem * var(--card-title-font-scale)) so they need their own',
                '     * multiplier). !important beats the inline font-size / custom',
                '     * property LayoutManager writes to <html> at boot. Portrait never',
                '     * matches this media query and stays stock. */',
                '    html[data-litefin-scaled] {',
                '        font-size: 22px !important;',
                '        --card-title-font-scale: 1.3 !important;',
                '    }',
                '',
                '    /* ==========================================================',
                '     * LANDSCAPE-ONLY FULL-BLEED BACKDROP FIX',
                '     * Viewport units do not scale with CSS zoom, so the fixed',
                '     * details backdrop (100vw/100vh in details.css) resolves to',
                '     * the raw phone viewport (e.g. 915x412) while the app canvas',
                '     * is 1600x720 design px — it renders at ~57% width and leaves',
                '     * a black band. Pin it to the design canvas via the custom',
                '     * properties _applyDisplayScale exposes (same values as the',
                '     * #app pin). Landscape only — portrait stays stock.',
                '     * ========================================================== */',
                '    html[data-litefin-scaled] .details-backdrop {',
                '        width: var(--litefin-app-w, 100vw) !important;',
                '        height: var(--litefin-app-h, 100vh) !important;',
                '    }',
                '    /* ==========================================================',
                '     * LANDSCAPE-ONLY BOOT SPLASH FIX',
                '     * The index.html boot splash (#app-splash, z-index max) is the',
                '     * same over-constrained fixed 100vw/100vh cover as the page',
                '     * loading overlay: after display scaling applies, it covers',
                '     * only the top-left ~57% of the canvas and its spinner rides',
                '     * at ~29% width instead of center. Pin it to the design canvas',
                '     * too (at true first paint, before JS/zoom, the raw viewport',
                '     * sizing is already correct). Landscape only — portrait stays',
                '     * stock.',
                '     * ========================================================== */',
                '    html[data-litefin-scaled] .splash-content {',
                '        width: var(--litefin-app-w, 100vw) !important;',
                '        height: var(--litefin-app-h, 100vh) !important;',
                '    }',
                '    /* ==========================================================',
                '     * LANDSCAPE-ONLY TRANSITION LOADING OVERLAY FIX',
                '     * The per-page loading overlay (base.css .page-loading) is a',
                '     * fixed 100vw/100vh cover with z-index 9999 — same viewport-',
                '     * unit trap: it covered only the top-left ~57% of the screen,',
                '     * so its spinner sat off-center and the sidebar bled through.',
                '     * Pin it to the design canvas (insets stay 0; the explicit',
                '     * width/height then span the full 1600x720) so the screen goes',
                '     * fully black and the spinner centers. Landscape only.',
                '     * ========================================================== */',
                '    html[data-litefin-scaled] .page-loading {',
                '        width: var(--litefin-app-w, 100vw) !important;',
                '        height: var(--litefin-app-h, 100vh) !important;',
                '    }',
                '    /* ==========================================================',
                '     * LANDSCAPE-ONLY LIVE TV GUIDE GRID FIX',
                '     * The EPG grid is a fixed-height virtualized viewport sized',
                '     * with calc(100vh - 230px) in livetv.css — under zoom 100vh',
                '     * resolves against the raw 412px phone viewport, collapsing',
                '     * the grid to a 182px sliver (one header + one row). Size it',
                '     * from the design canvas instead. The offset is 359px, not',
                '     * the TV 230px: the landscape 22px text scale (1.375x) grows',
                '     * the h1 + tab header accordingly (measured live), and 720 -',
                '     * 359 fits the grid EXACTLY in the canvas with no page',
                '     * overflow. Also kill browser touch handling inside it so the',
                '     * touch panning added in EpgGrid owns every gesture (the',
                '     * browser must not scroll the page out from under the',
                '     * swipes). Landscape only — portrait keeps the stock',
                '     * collapsed grid untouched.',
                '     * ========================================================== */',
                '    html[data-litefin-scaled] .epg-grid-container {',
                '        height: calc(var(--litefin-app-h, 100vh) - 203px) !important;',
                '        touch-action: none;',
                '    }',
                '    /* The h1 + tab header eats ~359 of 720 design px in landscape',
                '     * (fonts grew 1.375x with the 22px root). Tighten it to ~185px',
                '     * so the guide gets the majority of the screen, and stop the',
                '     * page chrome from rubber-banding like a scroll target (the',
                '     * grid itself owns all scrolling; the header is static).',
                '     * Landscape only. */',
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
                '    /* ==========================================================',
                '     * LANDSCAPE-ONLY IMMERSIVE HOME BACKDROP FIX',
                '     * The immersive hero canvas IS the home screen background',
                '     * image. It is sized with vh units plus raw-px media queries',
                '     * (hero-carousel.css max-height 850px/700px blocks match the',
                '     * RAW phone viewport — 412px — not the 720px design canvas),',
                '     * so it capped at 420 of 720 design px: artwork stopped',
                '     * mid-screen and left a black band behind the content rows.',
                '     * Pin the canvas to the full design height so the artwork',
                '     * fills the screen with the rows floating over it, and drop',
                '     * the slide indicators to the fade zone (they are anchored',
                '     * from the bottom and would otherwise land on the title',
                '     * text in the taller canvas). Landscape only — portrait',
                '     * keeps the stock banner.',
                '     * ========================================================== */',
                '    html[data-litefin-scaled] .hero-carousel-container.immersive .hero-carousel {',
                '        height: var(--litefin-app-h, 90vh) !important;',
                '        min-height: var(--litefin-app-h, 650px) !important;',
                '    }',
                '    html[data-litefin-scaled] .hero-carousel-container.immersive .hero-indicators {',
                '        bottom: 400px !important;',
                '    }',
                '    /* Immersive-only content anchoring: with the full-canvas backdrop',
                '     * the title block, slide dots and My Media rows must sit at TV',
                '     * proportions (title block ends ~41% down the screen, dots in',
                '     * the gap below it, section rows floating over the lower',
                '     * backdrop) instead of cramming into the bottom quarter.',
                '     * Non-immersive banner modes keep the generic 180px/-160px',
                '     * pairing below. */',
                '    html[data-litefin-scaled] .hero-carousel-container.immersive .hero-item {',
                '        padding-bottom: 423px !important;',
                '    }',
                '    html[data-litefin-scaled] #home-hero-placeholder.style-immersive + .home-rows {',
                '        margin-top: -405px !important;',
                '    }',
                '    /* ==========================================================',
                '     * LANDSCAPE-ONLY SETTINGS SPACING PASS',
                '     * The TV-density settings grid reads as "squished" on a phone',
                '     * once text grows. Open up vertical rhythm and let the content',
                '     * panel scroll (it already overflows: auto). Portrait and TVs',
                '     * never match this media query.',
                '     * ========================================================== */',
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
                '    /* Sidebar: wider so grown menu labels stay on one line, plus',
                '     * phone-sized touch targets: bigger labels, taller rows and',
                '     * larger icons (dialed back ~12% from the first pass after',
                '     * on-device feedback — still ~68px design rows ≈ 39px physical',
                '     * after the landscape zoom). */',
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
                 * Viewport units do NOT scale with CSS zoom: 100vw/100vh
                 * resolve to the raw phone viewport (e.g. 915x412) while the
                 * rest of the document lays out on the design canvas — the
                 * trap that clips #app (styled 100vw/100vh in base.css) and
                 * the fixed details-page backdrop (100vw/100vh in
                 * details.css). Pin #app to the effective design-space
                 * dimensions and expose them as custom properties so
                 * landscape rescue CSS can pin other full-bleed elements to
                 * the same canvas.
                 */
                const designW = `${Math.round(window.innerWidth / scale)}px`;
                const designH = `${Math.round(window.innerHeight / scale)}px`;
                const root = document.documentElement;
                if (scale < 1) {
                    root.style.setProperty('--litefin-app-w', designW);
                    root.style.setProperty('--litefin-app-h', designH);
                } else {
                    root.style.removeProperty('--litefin-app-w');
                    root.style.removeProperty('--litefin-app-h');
                }
                const appEl = document.getElementById('app');
                if (appEl && scale < 1) {
                    appEl.style.width = designW;
                    appEl.style.height = designH;
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
