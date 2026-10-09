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
        // Landscape rescue is the released, frozen stylesheet; portrait rescue
        // is a separate <style> gated to @media (orientation: portrait) — the
        // two can never activate on the same viewport.
        this._injectLandscapeRescueCSS();
        this._injectPortraitRescueCSS();
        this._applyDisplayScale();

        // Signal touch-primary input to CSS (sidebar tooltips and other
        // hover/focus reveals behave as press-and-hold on touch).
        document.documentElement.setAttribute('data-litefin-touch', '1');

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
                '/*',
                ' * ========================================================================',
                ' * ANDROID TOUCH-PRIMARY TOOLTIP OVERHAUL (orientation-independent)',
                ' * ========================================================================',
                ' * The sidebar labels ("HOME", "Favorites", "Settings", ...) reveal via',
                ' * :focus / .focused / :hover CSS. Touch taps leave those states stuck',
                ' * on the button (emulated hover + tap focus), so after tapping HOME the',
                ' * label latches open indefinitely. TVs legitimately use focus/hover',
                ' * reveal (D-pad + mouse), so this block is gated on an Android-only',
                ' * attribute instead of a media query:',
                ' *  - suppress the stuck focus/hover reveal paths,',
                ' *  - reveal ONLY while the finger is genuinely down (:active),',
                ' *  - hide again on release.',
                ' * The labels stay in the DOM (same element, zero JS churn) — pure CSS',
                ' * press-and-hold behavior. Focus-visible adds keyboard/remote reveal',
                ' * (programmatic focus() from CDP does not match it — spec-correct).',
                ' * ========================================================================',
                ' */',
                '/* ==== D-pad focus reveal (keyboard-driven remote) ====',
                ' * A physical keyboard/remote sends trusted focus with NO pointer:',
                ' * :active is never true, so the press-and-hold rules below would',
                ' * leave the label hidden forever. Detect real keyboard focus via',
                ' * the FocusManager convention (:focus-visible only matches keyboard',
                ' * focus; .focused is stamped app-wide for any focus incl. taps, so',
                ' * it is NOT enough). focus-visible only: labels reveal and fold away',
                ' * when focus moves on. */',
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
                '/* Hide in every non-pressed state. The :not(#nonexistent) raises',
                ' * specificity to the ID level so these rules beat the stock',
                ' * :focus/.focused/:hover reveal chains no matter what. Sub-',
                ' * libraries popover labels are excluded — they must always render. */',
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
                '/* Press-and-hold reveal: :active is true only while the finger is',
                ' * down; lifting it ends the state and the label folds away. Extra',
                ' * :not(#nonexistent) outranks the hide rule above on equal-later',
                ' * cascade order within this block. */',
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
                ' */',
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
                '/* Landscape disabled variant of the touch gate (the block below is',
                ' * orientation-gated; the tooltip rules above are not). */',
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
                '',
                '    /* ==========================================================',
                '     * LANDSCAPE LIBRARIES POPOVER GAP (landscape-only)',
                '     * The stock popover overlaps the 100px dock edge by 8px',
                '     * (left: 342px = 250 hidden + 100 visible). Phone feedback:',
                '     * the panel merges into the dock — flip to a visible 8px',
                '     * breathing gap: 250 + 100 + 8 = 358px. Portrait has its own',
                '     * separate rule (322px for the 64px rail) behind the portrait',
                '     * media query — the two never share a selector.',
                '     * ========================================================== */',
                '    html[data-litefin-scaled] #sidebar-sub-libraries {',
                '        left: 358px !important;',
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
                '',
                '    /* ==========================================================',
                '     * LANDSCAPE LOGIN / CONNECT SCREEN — MOBILE MOCK DESIGN',
                '     * Recreates the approved landscape mock-up (landscape-only):',
                '     *   • Two panes: left branding column (logo + wordmark +',
                '     *     tagline, vertically centered), right content column',
                '     *   • Right pane: big two-line gradient headline, muted',
                '     *     subtitle, rounded form card with labeled input and',
                '     *     gradient pill Connect button',
                '     *   • DISCOVERED SERVERS header with trailing rule + icon,',
                '     *     carded server rows / muted empty state',
                '     * Portrait never matches this query — the portrait mobile',
                '     * login redesign in the portrait rescue CSS is untouched.',
                '     * ========================================================== */',
                '    html[data-litefin-scaled] .login-page .login-container {',
                '        align-items: stretch !important;',
                '        max-width: none !important;',
                '        padding: 0 !important;',
                '        gap: 0 !important;',
                '    }',
                '    /* Left pane: centered branding column */',
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
                '    /* Right pane: vertically CENTERED column that fits the 720px',
                '     * canvas with NO scrolling (user regression report) — every',
                '     * block scaled down until total stack <= 720. */',
                '    html[data-litefin-scaled] .login-page .login-section {',
                '        flex: 1 1 auto !important;',
                '        width: auto !important;',
                '        height: 100% !important;',
                '        justify-content: center !important;',
                '        align-items: stretch !important;',
                '        padding: 24px 72px 24px 64px !important;',
                '        overflow-y: hidden !important;',
                '    }',
                '    /* Gradient headline, two lines, left-aligned */',
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
                '    /* Muted subtitle line under the headline */',
                '    html[data-litefin-scaled] .login-page .input-label {',
                '        font-size: 1.3rem !important;',
                '        font-weight: 400 !important;',
                '        line-height: 1.4 !important;',
                '        color: rgba(255, 255, 255, 0.62) !important;',
                '        text-align: left !important;',
                '        margin: 0 0 20px !important;',
                '        max-width: 100% !important;',
                '    }',
                '    /* Form card: rounded panel with labeled input + pill button */',
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
                '    /* DISCOVERED SERVERS: label + trailing rule + icon at right */',
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
                '    /* Server rows as cards; empty state as a muted card */',
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
                '',
                '    /* ==========================================================',
                '     * LANDSCAPE-ONLY PROFILES SIGN-OUT DIALOG FIX',
                '     * The sign-out confirm dialog (.profiles-dialog) is authored',
                '     * at a fixed 650px for the 750px portrait canvas (~87%',
                '     * width) and inherits .settings-modal max-height: 80vh —',
                '     * but vh does NOT scale with CSS zoom (documented',
                '     * viewport-units-under-zoom trap), so in landscape 80vh',
                '     * resolves against the RAW phone viewport (412px) instead',
                '     * of the 720px design canvas. Result: a shrunken 650px-wide',
                '     * dialog clamped to ~46% of screen height with the body',
                '     * message clipped mid-sentence. Match the portrait',
                '     * proportions: 87% canvas width and 80% of the design',
                '     * canvas height via the --litefin-app-h pin, and uncap the',
                '     * inner scroll area. Portrait never matches this query —',
                '     * its 650px dialog is untouched.',
                '     * ========================================================== */',
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
     * PORTRAIT RESCUE CSS (portrait-only; landscape untouched)
     * =========================================================================
     * Portrait port of the landscape rescue PATTERNS, in a separate <style>
     * element (litefin-portrait-rescue) gated to @media (orientation:
     * portrait) + html[data-litefin-scaled]. The landscape stylesheet's
     * layout-affecting rules all live inside @media (orientation: landscape),
     * so exactly one rescue stylesheet can ever be active per viewport.
     *
     * Contents (750px design canvas):
     *  - Text bump via the same lever landscape uses (root rem base + card
     *    title scale) — beats the inline font-size LayoutManager writes.
     *  - #app scrolls vertically like a phone page (horizontal locked).
     *  - Full-bleed fixed covers (details backdrop, boot splash, page
     *    loading) pinned to the design canvas via --litefin-app-w/h — same
     *    zoom + viewport-units trap landscape fixed, same mechanism.
     * @private
     */
    _injectPortraitRescueCSS() {
        try {
            const style = document.createElement('style');
            style.id = 'litefin-portrait-rescue';
            style.textContent = [
                '@media (orientation: portrait) {',
                '    /* Text bump: same lever as landscape, sized for the 750px',
                '     * canvas so physical text size matches the landscape feel. Also',
                '     * tighten the collapsed sidebar rail: on the 750px canvas the',
                '     * stock 100px rail leaves a dead strip next to the icons — 64px',
                '     * keeps the icon glyphs clear and gives library cards the width.',
                '     * Drives #page-container left offset AND the dock width; portrait',
                '     * only — landscape keeps the stock 100px. */',
                '    html[data-litefin-scaled] {',
                '        font-size: 20px !important;',
                '        --card-title-font-scale: 1.15 !important;',
                '        --sidebar-width-collapsed: 64px;',
                '    }',
                '',
                '    /* Phone-page scrolling: the TV layout is authored as a',
                '     * fixed-viewport app; in portrait the canvas is tall, so let',
                '     * pages overflow and scroll vertically. */',
                '    html[data-litefin-scaled] #app {',
                '        overflow-x: hidden !important;',
                '        overflow-y: auto !important;',
                '    }',
                '',
                '    /* Full-bleed pins (zoom + viewport-units trap, same as',
                '     * landscape): fixed 100vw/100vh covers resolve against the RAW',
                '     * phone viewport, not the design canvas. Pin them to the',
                '     * canvas via the --litefin-app-w/h custom properties. */',
                '    html[data-litefin-scaled] .details-backdrop,',
                '    html[data-litefin-scaled] .splash-content,',
                '    html[data-litefin-scaled] .page-loading {',
                '        width: var(--litefin-app-w, 100vw) !important;',
                '        height: var(--litefin-app-h, 100vh) !important;',
                '    }',
                '',
                '    /* Library pages (Movies, Shows, ...): reclaim the TV-sized side',
                '     * padding (50px each side on top of the 100px sidebar offset) so',
                '     * cards fill the phone width edge to edge with just a small gap.',
                '     * Portrait only — landscape keeps the stock 50px padding. */',
                '    html[data-litefin-scaled] .library-content {',
                '        padding-left: 16px !important;',
                '        padding-right: 16px !important;',
                '    }',
                '',
                '    /* Details page: stack the poster ABOVE the info column (phone',
                '     * layout). The stock TV layout is a flex ROW — poster 420px',
                '     * fixed + info column squeezed into the remaining ~106px on the',
                '     * 750px canvas, which squashes every text element. Poster uses a',
                '     * FIXED px padding-bottom ratio in stock CSS, so it is re-based',
                '     * to percentage ratios that scale with the new width. Portrait',
                '     * only — landscape keeps the side-by-side TV split. */',
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
                '    /* The item logo image floats beside the title in the TV row',
                '     * layout; stacked full-width it collides with the title text.',
                '     * The text title already names the item — hide the logo. */',
                '    html[data-litefin-scaled] .details-logo {',
                '        display: none !important;',
                '    }',
                '',
                '    /* ==========================================================',
                '     * PORTRAIT IMMERSIVE HOME HERO (ported from landscape math)',
                '     * Stock TV hero paddings (570px item / -550px rows) are tuned',
                '     * for 1080p TV heights — on the 1666px portrait canvas the',
                '     * title block overflows the top (cut logo) and My Media lands',
                '     * at ~274px with zero breathing room. Mirror the landscape',
                '     * immersive proportions on the taller canvas: full-canvas',
                '     * backdrop, title block anchored with room, dots below it,',
                '     * rows floating over the lower backdrop. Landscape values are',
                '     * NOT touched — these rules live behind the portrait query.',
                '     * Tuned: title block ends ~36% down, My Media starts ~33%',
                '     * (was ~49% — half the screen — on the first pass). */',
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
                '',
                '    /* ==========================================================',
                '     * PORTRAIT LIVE TV TAB BAR FIT',
                '     * The four Live TV tabs (Suggestions/Guide/Channels/',
                '     * Recordings) are width:fit-content + margin auto at TV',
                '     * sizes — at the 20px portrait root the row is wider than',
                '     * the 750px canvas, so Recordings clips off-screen to the',
                '     * right. Tighten padding + font inside the portrait query',
                '     * so all four fit; landscape keeps the frozen 30px/22px',
                '     * rules in the landscape stylesheet untouched.',
                '     * ========================================================== */',
                '    html[data-litefin-scaled] .livetv-page .ltv-tab-header {',
                '        padding: 4px;',
                '        max-width: calc(100% - 24px);',
                '        /* Left-align under the page title instead of the stock',
                '         * centering — the .page-header is a column flex with',
                '         * align-items:center, which ignores margins and leaves a',
                '         * dead gap on the left while parking Recordings on the',
                '         * right edge. align-self wins over the parent centering. */',
                '        align-self: flex-start !important;',
                '        margin: 0 !important;',
                '    }',
                '    /* The stock 60px page-header side padding pushed the',
                '     * left-aligned tab bar far from the screen edge. Trim it in',
                '     * portrait so the tabs hug the left like the content below;',
                '     * the centered h1 is unaffected (align-items:center). */',
                '    html[data-litefin-scaled] .livetv-page .page-header {',
                '        padding-left: 16px !important;',
                '        padding-right: 16px !important;',
                '    }',
                '    html[data-litefin-scaled] .livetv-page .ltv-tab-btn {',
                '        padding: 10px 18px !important;',
                '        font-size: 1.05rem !important;',
                '        white-space: nowrap;',
                '    }',
                '',
                '    /* ==========================================================',
                '     * PORTRAIT LIVE TV CONTENT GUTTERS (portrait-only)',
                '     * The stock .page-content uses 40px side padding at TV sizes.',
                '     * On the 750px portrait canvas that leaves a ~104px black',
                '     * gutter on each side of every Live TV tab (Suggestions rows,',
                '     * Guide grid, Channels cards, Recordings empty state) — dead',
                '     * space when screen width is at a premium. Pull the content',
                '     * edges in to 12px so rows/cards/grid fill the width; the',
                '     * vertical rhythm (20px top / 20px bottom) is unchanged.',
                '     * Landscape keeps the frozen .page-content rules in the',
                '     * landscape stylesheet untouched.',
                '     * ========================================================== */',
                '    html[data-litefin-scaled] .livetv-page .page-content {',
                '        padding-left: 12px !important;',
                '        padding-right: 12px !important;',
                '    }',
                '    /* The Channels tab grid also keeps the stock 60px person-grid',
                '     * side padding under .page-content — collapse it so the card',
                '     * columns span the new 12px content edges (the card width',
                '     * rules below already re-base to 3-across). */',
                '    html[data-litefin-scaled] .livetv-page .page-content .person-grid {',
                '        padding-left: 0 !important;',
                '        padding-right: 0 !important;',
                '    }',
                '',
                '    /* ==========================================================',
                '     * PORTRAIT LIVE TV CHANNELS GRID (portrait-only)',
                '     * The Channels tab renders a MediaGrid with the stock',
                '     * person-grid class: flex-wrap at calc(20% - 26px) per card',
                '     * with 60px grid side padding — five tiny columns and big',
                '     * black gutters on the 750px portrait canvas. Re-base to 3',
                '     * cards per row (matching the portrait library grid) with a',
                '     * 12px page edge and 6px card gutters so the grid fills the',
                '     * width edge to edge. Landscape keeps the frozen 5-across TV',
                '     * rules untouched.',
                '     * ========================================================== */',
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
                '',
                '    /* ==========================================================',
                '     * PORTRAIT SIDEBAR DOCK SIZING (portrait-only)',
                '     * Stock dock: 72px rows at zero pitch (bunched) with 28px',
                '     * glyph SVGs — at the 0.549 portrait zoom that is a ~40px',
                '     * physical target and a ~15px glyph: far too small for a',
                '     * finger. Raise rows to 96px pitch (a ~53px physical target,',
                '     * above the 48px finger guideline, with inherent breathing',
                '     * room between glyphs) and grow the glyph to 44px design',
                '     * (~24px physical). Containment: 44px glyphs sit inside the',
                '     * 64px collapsed icon column and the 96px row — they cannot',
                '     * escape their touch target. The focus indicator computes',
                '     * its position from offsetTop at runtime (Sidebar._updateIndicator),',
                '     * so row pitch changes need no JS. The sidebar has large free',
                '     * vertical space in portrait (nav band occupies ~620-1055 of',
                '     * the 1666px canvas), so the taller stack cannot overflow.',
                '     * Landscape keeps the stock 72px/28px rules untouched.',
                '     * ========================================================== */',
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
                '    }',
                '',
                '    /* ==========================================================',
                '     * PORTRAIT LIVE TV GUIDE GRID HEIGHT (portrait-only)',
                '     * The EPG grid is a fixed-height virtualized viewport sized',
                '     * with calc(100vh - 230px) in livetv.css — under zoom 100vh',
                '     * resolves against the RAW phone viewport (~915px tall in',
                '     * portrait), not the 1666px design canvas, so the guide',
                '     * renders a ~685px sliver and the virtualizer draws only ~6',
                '     * rows, leaving a black void below. Size it from the design',
                '     * canvas via the custom properties _applyPortraitScale',
                '     * exposes: the measured header stack is 327px (h1 + tabs) on',
                '     * the portrait canvas and .page-content has 20px bottom',
                '     * padding, so canvas-h - 347 fills the screen exactly. The',
                '     * virtualizer derives visibleHeight from this element',
                '     * dynamically (EpgGrid._updateVisibleDimensions) — no row',
                '     * count is hardcoded, and swiping inside the grid is handled',
                '     * by EpgGrid touch panning (now active in both orientations).',
                '     * Landscape never matches this query — the landscape',
                '     * stylesheet keeps its own frozen 203px rule untouched.',
                '     * ========================================================== */',
                '    html[data-litefin-scaled] .epg-grid-container {',
                '        height: calc(var(--litefin-app-h, 100vh) - 347px) !important;',
                '        touch-action: none;',
                '    }',
                '',
                '    /* ==========================================================',
                '     * PORTRAIT LIBRARIES POPOVER ALIGNMENT (portrait-only)',
                '     * The floating #sidebar-sub-libraries popover anchors with a',
                '     * hard-coded left: 342px in modern/sidebar.css — tuned for',
                '     * the 100px landscape rail (250 hidden + 100 visible − 8px',
                '     * overlap). Portrait shrinks the visible rail to 64px, so',
                '     * 342px left the popover floating 28px away from the dock.',
                '     * Re-anchor to 250 + 64 + 8 = 322px — an 8px breathing gap',
                '     * right of the dock edge (user feedback: the 8px overlap',
                '     * made the panel merge into the dock button). Vertical placement is unaffected: Sidebar.js',
                '     * computes top from the libraries button rect at open time.',
                '     * Landscape never matches this query — keeps stock 342px.',
                '     * ========================================================== */',
                '    html[data-litefin-scaled] #sidebar-sub-libraries {',
                '        left: 322px !important;',
                '    }',
                '',
                '    /* ==========================================================',
                '     * PORTRAIT SETTINGS LAYOUT (portrait-only)',
                '     * The settings split view is authored for a 1600px landscape',
                '     * canvas: 350px sidebar + a wide content panel with each',
                '     * .setting-item as a horizontal label/control row. On the',
                '     * 750px portrait canvas the panel shrinks to ~336px while',
                '     * rows keep landscape sizing — controls get crushed into',
                '     * 216px columns and force horizontal scrolling. Portrait',
                '     * re-balance: sidebar takes a fixed 260px (bigger menu text',
                '     * per user request), the panel goes single-column full-width,',
                '     * and each setting row stacks label above control so every',
                '     * value fits without horizontal scroll. Landscape never',
                '     * matches this query — its frozen 350px/430px rules stay.',
                '     * ========================================================== */',
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
                '    /* Bigger, finger-friendly settings menu (user request) */',
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
                '    /* Content panel: single column, full remaining width */',
                '    html[data-litefin-scaled] .settings-page .settings-content-panel.page-content {',
                '        flex: 1 1 auto !important;',
                '        width: auto !important;',
                '        min-width: 0 !important;',
                '        max-width: none !important;',
                '        padding: 24px 16px !important;',
                '        overflow-x: hidden !important;',
                '    }',
                '    /* Stack every setting row: name+description above, control below */',
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
                '    /* Controls wrap left-aligned and never force the row wider */',
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
                '',
                '    /* ==========================================================',
                '     * PORTRAIT DETAILS TITLE OVERFLOW (portrait-only)',
                '     * Long machine-style titles (e.g. "The.Matrix.4.Resurrections")',
                '     * contain no spaces, so the .details-title h1 renders as one',
                '     * unbreakable word: at the stock 3.5rem it measures ~898px on',
                '     * the 750px canvas, bursting out of .details-info-col and',
                '     * widening .details-main-split to 914px — the page then needs',
                '     * horizontal scrolling. Portrait fix: full-width title, break',
                '     * anywhere (dots included), slightly smaller size, and clamp',
                '     * the split container so nothing can push the canvas wider.',
                '     * Landscape never matches this query — the stock 60% max-width',
                '     * hero layout is untouched.',
                '     * ========================================================== */',
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
                '',
                '    /* ==========================================================',
                '     * PORTRAIT LOGIN / LOCK SCREEN — MOBILE MOCK DESIGN',
                '     * Recreates the approved mobile mock-up (portrait-only):',
                '     *   • Column layout — branding top, form below, all centered',
                '     *   • Big gradient headline (white → accent gradient second',
                '     *     line), left-aligned inside a centered content column',
                '     *   • Form inside a rounded “card” panel; pill gradient',
                '     *     Connect button (purple→blue) with white text',
                '     *   • “DISCOVERED SERVERS” flanked by horizontal rules with',
                '     *     the search/refresh icon on the right',
                '     *   • Server rows as cards; the empty state as a muted card',
                '     * Landscape never matches this query — TV login untouched.',
                '     * ========================================================== */',
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
                '    /* Branding: centered logo row + tagline */',
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
                '    /* Headline: left-aligned, two lines, gradient second line.',
                '     * The h2 section-title reads "Connect to Server"; split the',
                '     * gradient across the whole headline like the mock (white to',
                '     * accent on the tail words) via a background-clip gradient. */',
                '    /* Section: kill the inherited full-height centering so the',
                '     * form content hugs the branding instead of floating mid-page */',
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
                '    /* Muted supporting line under the headline (the input-label',
                '     * duplicates the h2 text; restyle it as the subtitle). */',
                '    html[data-litefin-scaled] .login-page .input-label {',
                '        font-size: 1.5rem !important;',
                '        font-weight: 400 !important;',
                '        line-height: 1.45 !important;',
                '        color: rgba(255, 255, 255, 0.62) !important;',
                '        text-align: left !important;',
                '        margin: 0 0 28px !important;',
                '        max-width: 100% !important;',
                '    }',
                '    /* Form card: soft rounded panel holding input + button */',
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
                '    /* Pill gradient Connect button (purple → blue) */',
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
                '    /* “DISCOVERED SERVERS” — letterspaced, rules on both sides,',
                '     * refresh icon at the right edge (mock: search glass). */',
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
                '    /* Server rows as cards; empty state as a muted card */',
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
                '',
                '    /* ==========================================================',
                '     * PORTRAIT LOGIN PAGES — NO SCROLLING GUARANTEE',
                '     * The manual sign-in / password / quick-connect steps share',
                '     * a 3-button action row authored nowrap for TV; on the 750px',
                '     * canvas three 250px buttons = 826px in a 710px column, which',
                '     * forced horizontal scrolling. Fix: wrap the row (2+1), full-',
                '     * width clamps on every form element, and hard overflow-x',
                '     * clamps on all login sections + the page itself. Portrait',
                '     * only — the landscape login row layout is untouched.',
                '     * ========================================================== */',
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
                '    /* Breathing room between the input edges and the screen edge */',
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
     * PORTRAIT DISPLAY SCALE (portrait-only; landscape never runs this)
     * =========================================================================
     * Portrait port of the landscape display-scale pattern: fit a fixed
     * design WIDTH with CSS zoom so the TV layout renders at a chosen
     * size, and pin #app + the --litefin-app-w/h custom properties to the
     * effective design canvas (the zoom + viewport-units trap).
     *
     * Differences from landscape, all deliberate:
     *  - Design width 750 instead of 1600: the TV layout renders ~2.1x
     *    larger physically in portrait and the page scrolls vertically
     *    like a phone app (portrait rescue CSS unlocks #app scrolling).
     *  - Everything (orientation check, scale, vars, #app pin) is computed
     *    FRESH inside this method on every call — never captured at init —
     *    so rotation always re-evaluates with current viewport values.
     *  - Returns true only for portrait viewports; landscape viewports
     *    return false immediately and _applyDisplayScale's untouched
     *    landscape math takes over.
     * @private
     * @returns {boolean} true when this call was a portrait viewport that
     *   this method fully handled.
     */
    _applyPortraitScale() {
        /* Fresh per call — the whole point of the separation fix. */
        const isPortrait = window.innerHeight > window.innerWidth;
        if (!isPortrait) return false;

        try {
            const PORTRAIT_DESIGN_WIDTH = 750;
            const MIN_SCALE = 0.15;

            const scale = Math.min(1, Math.max(MIN_SCALE, window.innerWidth / PORTRAIT_DESIGN_WIDTH));
            const root = document.documentElement;
            const appEl = document.getElementById('app');

            if (scale >= 1) {
                /* Desktop-sized portrait viewport: stock layout, unscaled. */
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
                /* data-litefin-scaled gates BOTH rescue stylesheets, but the
                 * landscape one is additionally wrapped in
                 * @media (orientation: landscape), so setting it in portrait
                 * can never activate a landscape rule. */
                root.setAttribute('data-litefin-scaled', '1');
                root.style.setProperty('--litefin-app-w', designW);
                root.style.setProperty('--litefin-app-h', designH);
                if (appEl) {
                    appEl.style.width = designW;
                    appEl.style.height = designH;
                }
            }

            log.debug(
                `Portrait display scale: ${scale.toFixed(3)} (viewport ${window.innerWidth}x${window.innerHeight})`
            );
        } catch (e) {
            log.warn('Failed to apply portrait display scale:', e);
        }
        return true;
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
            /*
             * PORTRAIT HANDOFF: portrait owns its own scaling path entirely
             * (separate method, separate CSS — see _applyPortraitScale). It
             * re-evaluates orientation FRESH on every resize call, so no
             * stale orientation state can leak into this landscape math.
             * When it returns true, portrait fully handled zoom/vars/#app
             * and the landscape code below must not run; when false, this
             * is a landscape viewport and the original math runs unchanged.
             */
            if (this._applyPortraitScale()) return;
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
