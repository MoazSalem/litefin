/**
 * ============================================================================
 * Litefin Tizen - LayoutManager
 * ============================================================================
 * Manages dual-layout support for Classic and Modern UI modes.
 * Provides component factories and layout-specific configuration.
 *
 * Usage:
 *   layoutManager.setLayout('modern');
 *   const Card = layoutManager.getComponent('Card');
 * ============================================================================
 */

import { eventBus } from '../core/EventBus.js';
import { state } from '../core/StateManager.js';
import { storage } from '../utils/StorageService.js';
import { logger } from '../utils/Logger.js';
import { platformInfo } from '../utils/PlatformInfo.js';
import { cssVarsPolyfill } from '../utils/CssVarsPolyfill.js';
import { themeUtils } from '../utils/ThemeUtils.js';
import { getFallbackFontFamily, isFallbackFont } from '../utils/FallbackFonts.js';

import { debugOverlay } from './DebugOverlay.js';
import CardRenderer from '../utils/CardRenderer.js';

const log = logger.create('LayoutManager');

// Layout constants
const LAYOUT = {
    CLASSIC: 'classic',
    MODERN: 'modern'
};

// Theme Mode constants
const THEME_MODES = {
    CLASSIC_DARK: 'classic-dark',
    CLASSIC_LIGHT: 'classic-light',
    BLACK: 'black',
    TINTED: 'tinted',
    TINTED_LIGHT: 'tinted-light',
    AMBIENT: 'ambient',
    EMBER: 'ember',
    SUNSET: 'sunset',
    FROST: 'frost',
    PAPER: 'paper',
    NOCTURNE: 'nocturne',
    ABYSS: 'abyss',
    CYBERPUNK: 'cyberpunk'
};

// Default Theme Color (Litefin Purple Blue)
const DEFAULT_THEME_COLOR = '#6b6ede';

/*
 * Unique default accent color per artistic theme mode.
 * Applied automatically when the user selects the mode, unless they have
 * manually customized the theme color themselves.
 */
const DEFAULT_MODE_COLORS = {
    [THEME_MODES.EMBER]: '#e8853c', // burnt amber — candlelit flame
    [THEME_MODES.SUNSET]: '#ff7a54', // sunset coral — low sun bloom
    [THEME_MODES.FROST]: '#3d9be9', // glacial blue — icy daylight
    [THEME_MODES.PAPER]: '#8a5a33', // sepia ink — old print
    [THEME_MODES.NOCTURNE]: '#d8b25c', // projector tungsten — booth keylight
    [THEME_MODES.ABYSS]: '#35d0cc', // bioluminescent teal — deep-sea lure
    [THEME_MODES.CYBERPUNK]: '#ff2d78' // neon hot magenta — night-city sign
};

// ============================================================================
// LAZY THEME STYLESHEETS
// ============================================================================
// The 12 static theme palettes no longer ride the boot bundle (~125KB of CSS
// for a palette the user will never select). Only the active mode's palette
// is fetched as an async CSS chunk the first time its mode is applied (boot
// init or a settings switch); already-fetched palettes stay resident and the
// CssVarsPolyfill re-resolves them on later switches via its per-tag
// template cache.
//
// On legacy engines (Chromium 38-47) this is visually lossless: the full
// derived --jf-* palette is generated per mode into
// #litefin-dynamic-theme-vars by _applyDynamicTheme(), and the polyfill
// resolves the newly injected theme tag against it via
// ensureStylesResolved(). 'tinted-light' shares tinted.css - its light
// surface deltas are generated dynamically, and unused dark.css (the only
// theme file with :root rules) is not part of this map.
const THEME_STYLE_IMPORTS = {
    [THEME_MODES.CLASSIC_DARK]: () => import(/* webpackChunkName: "theme-classic-dark" */ '../themes/classic-dark.css'),
    [THEME_MODES.CLASSIC_LIGHT]: () =>
        import(/* webpackChunkName: "theme-classic-light" */ '../themes/classic-light.css'),
    [THEME_MODES.BLACK]: () => import(/* webpackChunkName: "theme-black" */ '../themes/black.css'),
    [THEME_MODES.TINTED]: () => import(/* webpackChunkName: "theme-tinted" */ '../themes/tinted.css'),
    [THEME_MODES.TINTED_LIGHT]: () => import(/* webpackChunkName: "theme-tinted" */ '../themes/tinted.css'),
    [THEME_MODES.AMBIENT]: () => import(/* webpackChunkName: "theme-ambient" */ '../themes/ambient.css'),
    [THEME_MODES.EMBER]: () => import(/* webpackChunkName: "theme-ember" */ '../themes/ember.css'),
    [THEME_MODES.SUNSET]: () => import(/* webpackChunkName: "theme-sunset" */ '../themes/sunset.css'),
    [THEME_MODES.FROST]: () => import(/* webpackChunkName: "theme-frost" */ '../themes/frost.css'),
    [THEME_MODES.PAPER]: () => import(/* webpackChunkName: "theme-paper" */ '../themes/paper.css'),
    [THEME_MODES.NOCTURNE]: () => import(/* webpackChunkName: "theme-nocturne" */ '../themes/nocturne.css'),
    [THEME_MODES.ABYSS]: () => import(/* webpackChunkName: "theme-abyss" */ '../themes/abyss.css'),
    [THEME_MODES.CYBERPUNK]: () => import(/* webpackChunkName: "theme-cyberpunk" */ '../themes/cyberpunk.css')
};

class LayoutManager {
    constructor() {
        // Component registries per layout
        this._components = {
            [LAYOUT.CLASSIC]: new Map(),
            [LAYOUT.MODERN]: new Map()
        };

        // Current layout
        this._layout = LAYOUT.CLASSIC;

        // Granular layout settings
        /*
         * Active media rows presentation layout.
         * Sets default horizontal card row arrangement to 'modern'.
         * Provides sleek translucent styling and optimized card proportions by default.
         * Can be overridden by persistent user preference or legacy migration flags.
         */
        this._mediaRowsLayout = 'modern';
        this._loginPageLayout = 'classic';
        /*
         * Active sidebar layout configuration (e.g., 'modern-collapsed').
         * Controls structural presentation and styling of the primary navigation bar.
         */
        this._sidebarLayout = 'modern-collapsed';

        /*
         * Active Alphabet Selector Position ('top' or 'right').
         * Configures placement and orientation of the library alphabet quick-jump index:
         * - 'top': Classic horizontal ribbon placed inside the library header row.
         * - 'right': Sleek vertical floating pill docked to the right edge.
         */
        this._alphaPickerPosition = 'top';

        // Current theme mode
        // Black (OLED) is the default — zero compositing, pure black pixels, maximum performance.
        this._themeMode = THEME_MODES.BLACK;

        // In-flight/resolved palette chunk imports, keyed by theme mode.
        // Guarantees a single fetch per palette across repeated setThemeMode
        // calls (boot init always runs one; settings switches run more).
        this._themeStylePromises = {};

        // In-flight/resolved modern interface layer chunk (modern/bundle.css).
        // Single fetch across the three layout setters that may require it.
        this._modernStylesPromise = null;

        // Current theme color (HEX)
        this._themeColor = DEFAULT_THEME_COLOR;

        /*
         * Lighter background mode for Tinted and Classic themes.
         * When enabled, swaps the primary canvas background with the alternate
         * background shade for an elevated, higher-contrast luminous aesthetic.
         */
        this._lighterBackground = false;

        /*
         * Signature Accent override for the artistic theme modes.
         * When enabled on a supported mode (ember, sunset, frost, paper),
         * the active accent is replaced with that mode's unique signature color.
         * Defaults to false (off).
         */
        this._signatureAccent = false;

        // Current font
        this._uiFont = 'default';

        // Rounded corners setting
        this._roundedCorners = true;

        // Global text scale multiplier
        this._textScale = 1.0;

        // Card label text scale multiplier
        this._cardLabelScale = 1.0;

        // Low VRAM Mode: Disables GPU transitions/animations for legacy hardware
        this._lowVramMode = false;

        // Disable Card Scaling: Specifically prevents posters/thumbs from scaling on focus
        this._disableCardScaling = false;

        // Simple Loader: Lightweight rotating ring instead of pulsing dots
        this._simpleLoader = false;

        /*
         * Loading Indicator Visual Style
         * Controls the visual presentation of loading spinners and activity indicators.
         * Default: 'ring' (Rotating Ring) — lightest possible option for CPU/GPU overhead.
         * Supported: 'dots', 'ring', 'dual-ring', 'orbit', 'satellite', etc.
         */
        this._loaderStyle = 'ring';

        // Disable BlurHash: Disables color-accurate blurred canvas rendering during image load
        this._disableBlurhash = false;

        // Disable Library BlurHash: Specifically disables BlurHash DCT canvas decodes in library grids
        // Defaults to true (disabled) to maximize navigation and scrolling performance on weak TV chipsets.
        this._disableLibraryBlurhash = true;

        // Only BlurHash Backdrop: Uses only decoded blurhash for details backdrop background without loading image
        this._onlyBlurHashBackdrop = false;

        // Light Music Player: Removes blur and shadows from the music player for older TV performance
        this._lightMusicPlayer = false;

        // Badge style: 'auto', 'tinted', 'dark'
        this._badgeStyle = 'auto';

        // Button style options: 'theme-default', 'theme-inverted', 'monochrome-bw', 'monochrome-wb'
        this._buttonStyle = 'theme-default';

        // Hide unfocused borders: true, false
        this._hideUnfocusedBorders = false;

        // Focus border style: 'follow-theme', 'inverted', 'white', 'black', 'hidden'
        this._focusBorderStyle = 'hidden';

        // Hover border style: 'follow-theme', 'inverted', 'white', 'black', 'hidden'
        this._hoverBorderStyle = 'white';

        // Sidebar unselected icon color: 'grey', 'white', 'black', 'accent'
        this._sidebarUnselectedColor = 'grey';

        // Sidebar selected icon color: 'grey', 'white', 'black', 'accent'
        this._sidebarSelectedColor = 'white';

        // Sidebar logo icon color: 'icon-colors', 'follow-theme', 'white', 'black'
        this._sidebarLogoColor = 'icon-colors';

        // Sidebar icon shadows: true / false (default: false for flat, unified look)
        this._sidebarIconShadows = false;

        // OSD Custom Button & Focus Border styles (overrides global)
        this._osdButtonStyle = 'follow-global';
        this._osdFocusBorderStyle = 'follow-global';
        this._osdButtonShape = 'circle';
        this._osdUnfocusedButtonStyle = 'icon-only';

        /*
         * Customized color scheme for the OSD seek bar thumb.
         * Defaults to 'white'. Supports: 'white', 'black', 'theme-accent', 'theme-inverted'.
         */
        this._osdSeekBarThumbColor = 'white';

        /*
         * Customized color scheme for the OSD seek bar progress.
         * Defaults to 'theme-accent'. Supports: 'white', 'black', 'theme-accent', 'theme-inverted'.
         */
        this._osdSeekBarProgressColor = 'theme-accent';

        /*
         * Customized contrast level for the hero carousel text vignette gradient.
         * Controls dark shadow intensity behind titles from 'transparent' (0%) to '90%' (deep dark).
         * Defaults to '50' (50% opacity) to provide optimal default text readability while revealing artwork.
         */
        this._heroVignette = '50';

        // Internal style element for dynamic variables
        this._dynamicStyleEl = null;

        /*
         * Global interface display scaling factor.
         * Supports 'auto' (dynamically fits viewport to 1080p proportions) or manual float strings ('0.8', '0.9', etc.)
         * Loaded eagerly from storage to be available immediately during early platform initialization.
         */
        this._displayScale = storage.getItem('pref:displayScale') || 'auto';
    }

    /**
     * Initialize layout manager
     */
    init() {
        /*
         * ---------------------------------------------------------------------
         * Horizontal Media Rows Layout Configuration
         * ---------------------------------------------------------------------
         * Load user preference for media rows display styling from storage.
         * If no explicit preference exists under 'pref:mediaRowsLayout', check
         * backward-compatibility keys ('pref:modernMediaRows' or 'litefin:layout').
         * When neither key specifies an explicit legacy classic preference ('false'/'classic'),
         * default all fresh installs and unconfigured profiles to 'modern'.
         */
        let savedMediaRowsLayout = storage.getItem('pref:mediaRowsLayout');
        if (!savedMediaRowsLayout) {
            const legacy = storage.getItem('pref:modernMediaRows') || storage.getItem('litefin:layout');
            // Preserve explicit classic preference if legacy flag was false or classic; otherwise modern
            savedMediaRowsLayout = legacy === 'false' || legacy === 'classic' ? 'classic' : 'modern';
        }

        let savedLoginPageLayout = storage.getItem('pref:loginPageLayout');
        if (!savedLoginPageLayout) {
            const legacy = storage.getItem('pref:modernLoginPage') || storage.getItem('litefin:layout');
            // Hardware with c26 quirks (Chrome <32 / Tizen 2.4 ancient WebKit) defaults to classic login layout.
            if (platformInfo.isAncientChrome) {
                savedLoginPageLayout = 'classic';
            } else {
                savedLoginPageLayout = legacy === 'false' ? 'classic' : 'modern';
            }
        }

        /*
         * ---------------------------------------------------------------------
         * SIDEBAR LAYOUT CONFIGURATION & DEFAULT SELECTION
         * ---------------------------------------------------------------------
         * Load saved sidebar navigation layout preference from persistent storage.
         * Ultra-legacy hardware (Chrome <47 / Tizen 2.x / c26 quirks) defaults
         * gracefully to the lightweight 'classic' sidebar layout for maximum
         * performance and compatibility, but users can freely select other
         * modern or floating layout modes in Settings.
         * Modern and legacy tiers default to 'modern-collapsed'.
         * ---------------------------------------------------------------------
         */
        const isUltraLegacy = platformInfo.layoutTier === 'ultra-legacy';
        const defaultSidebarLayout = isUltraLegacy ? 'classic' : 'modern-collapsed';
        const savedSidebarLayout = storage.getItem('pref:sidebarLayoutMode') || defaultSidebarLayout;

        // Load saved theme mode
        const savedThemeMode = storage.getItem('litefin:themeMode');
        // Default to Black (OLED) theme mode — zero compositing overhead, best for performance.
        let initialMode = THEME_MODES.BLACK;

        if (savedThemeMode && Object.values(THEME_MODES).includes(savedThemeMode)) {
            initialMode = savedThemeMode;
        }

        log.info(`Loading theme: savedMode="${savedThemeMode}" -> initialMode="${initialMode}"`);

        /*
         * Fallback chain for the saved theme color: user-picked color, then
         * the global default.
         */
        const savedThemeColor = storage.getItem('litefin:themeColor') || this._themeColor;
        /*
         * Load saved lighter background preference (only applies to tinted and classic modes).
         * Defaults to false (standard deep canvas background).
         */
        const savedLighterBackground = storage.getItem('litefin:lighterBackground') === 'true';
        const savedUiFont = storage.getItem('litefin:uiFont') || 'default';
        const savedRoundedCorners = storage.getItem('litefin:roundedCorners') !== 'false';
        const savedTextScale = parseFloat(storage.getItem('litefin:textScale') || '1.0');

        const savedLowVram = storage.getItem('litefin:lowVramMode') === 'true';
        const savedDisableScaling = storage.getItem('litefin:disableCardScaling') === 'true';
        /*
         * Retrieve user preference for loading indicator animation aesthetic.
         * Default is 'ring' (Rotating Ring) — the most CPU/GPU-efficient option.
         */
        const savedLoaderStyle = storage.getItem('litefin:loaderStyle') || 'ring';
        const savedDisableBlurhash = storage.getItem('litefin:disableBlurhash') === 'true';
        /*
         * Disable BlurHash in Library preference.
         * Default is true (enabled toggle = disabled blurhash in library grids)
         * to eliminate DCT canvas decoding overhead during fast scrolling on low-power TV processors.
         * Only evaluates to false if explicitly saved as 'false'.
         */
        const savedDisableLibraryBlurhash = storage.getItem('pref:disableLibraryBlurhash') !== 'false';
        const savedOnlyBlurHashBackdrop = storage.getItem('litefin:onlyBlurHashBackdrop') === 'true';
        const savedLightMusicPlayer = storage.getItem('pref:lightMusicPlayer') === 'true';
        const savedBadgeStyle = storage.getItem('litefin:badgeStyle') || 'auto';
        const savedCardLabelScale = parseFloat(storage.getItem('pref:cardLabelScale') || '1.0');
        /*
         * Load saved interface display scale preference.
         * Defaults to 'auto', which dynamically scales non-TV and browser viewports to 1080p canvas proportions.
         */
        const savedDisplayScale = storage.getItem('pref:displayScale') || 'auto';

        // Load user preferred button customization style
        const savedButtonStyle = storage.getItem('litefin:buttonStyle') || 'theme-default';
        const savedHideUnfocusedBorders = storage.getItem('litefin:hideUnfocusedBorders') === 'true';
        const savedFocusBorderStyle = storage.getItem('litefin:focusBorderStyle') || 'hidden';
        const savedHoverBorderStyle = storage.getItem('litefin:hoverBorderStyle') || 'white';
        const savedSidebarUnselectedColor = storage.getItem('litefin:sidebarUnselectedColor') || 'grey';
        const savedSidebarSelectedColor = storage.getItem('litefin:sidebarSelectedColor') || 'white';
        const savedSidebarLogoColor = storage.getItem('litefin:sidebarLogoColor') || 'icon-colors';
        const savedSidebarIconShadows =
            storage.getItem('litefin:sidebarIconShadows') === 'true' ||
            storage.getItem('pref:sidebarIconShadows') === 'true' ||
            storage.getItem('litefin:sidebarIconShadows') === 'shadow' ||
            storage.getItem('pref:sidebarIconShadows') === 'shadow';
        const savedOsdButtonStyle = storage.getItem('litefin:osdButtonStyle') || 'follow-global';
        const savedOsdFocusBorderStyle = storage.getItem('litefin:osdFocusBorderStyle') || 'follow-global';
        const savedOsdButtonShape = storage.getItem('litefin:osdButtonShape') || 'circle';
        const savedOsdUnfocusedButtonStyle = storage.getItem('litefin:osdUnfocusedButtonStyle') || 'icon-only';
        const savedOsdSeekBarThumbColor = storage.getItem('litefin:osdSeekBarThumbColor') || 'white';
        const savedOsdSeekBarProgressColor = storage.getItem('litefin:osdSeekBarProgressColor') || 'theme-accent';
        const savedHeroVignette = storage.getItem('pref:heroCarouselVignette') || '70';

        this.setMediaRowsLayout(savedMediaRowsLayout, false);
        this.setLoginPageLayout(savedLoginPageLayout, false);
        // Initialize sidebar layout without triggering duplicate persistence
        // Load user-selected alphabet quick-jump position ('top' or 'right')
        const savedAlphaPickerPosition = storage.getItem('pref:alphaPickerPosition') || 'top';

        this.setSidebarLayout(savedSidebarLayout, false);
        // Initialize alphabet selector position without re-persisting
        this.setAlphaPickerPosition(savedAlphaPickerPosition, false);
        this.setThemeMode(initialMode, false);
        this.setThemeColor(savedThemeColor, false);
        // Apply lighter background configuration without extra persistence cycle
        this.setLighterBackground(savedLighterBackground, false);

        // Load saved signature accent override preference
        const savedSignatureAccent = storage.getItem('litefin:signatureAccent') === 'true';
        this.setSignatureAccent(savedSignatureAccent, false);
        this.setUiFont(savedUiFont, false);
        this.setRoundedCorners(savedRoundedCorners, false);
        this.setTextScale(savedTextScale, false);
        this.setCardLabelScale(savedCardLabelScale, false);
        // Apply saved display scale factor immediately without duplicate persistence write
        this.setDisplayScale(savedDisplayScale, false);

        this.setLowVramMode(savedLowVram, false);
        this.setDisableCardScaling(savedDisableScaling, false);

        // Apply loading indicator style and sync legacy simple loader flag
        this.setLoaderStyle(savedLoaderStyle, false);
        this.setDisableBlurhash(savedDisableBlurhash, false);
        // Apply saved disable library blurhash state to DOM attributes and runtime tracking
        this.setDisableLibraryBlurhash(savedDisableLibraryBlurhash, false);
        this.setOnlyBlurHashBackdrop(savedOnlyBlurHashBackdrop, false);
        this.setLightMusicPlayer(savedLightMusicPlayer, false);
        this.setBadgeStyle(savedBadgeStyle, false);

        // Initial setup for the button styling scheme
        this.setButtonStyle(savedButtonStyle, false);
        this.setHideUnfocusedBorders(savedHideUnfocusedBorders, false);
        this.setFocusBorderStyle(savedFocusBorderStyle, false);
        this.setHoverBorderStyle(savedHoverBorderStyle, false);
        this.setSidebarUnselectedColor(savedSidebarUnselectedColor, false);
        this.setSidebarSelectedColor(savedSidebarSelectedColor, false);
        this.setSidebarLogoColor(savedSidebarLogoColor, false);
        this.setSidebarIconShadows(savedSidebarIconShadows, false);
        this.setOsdButtonStyle(savedOsdButtonStyle, false);
        this.setOsdFocusBorderStyle(savedOsdFocusBorderStyle, false);
        this.setOsdButtonShape(savedOsdButtonShape, false);
        this.setOsdUnfocusedButtonStyle(savedOsdUnfocusedButtonStyle, false);
        this.setOsdSeekBarThumbColor(savedOsdSeekBarThumbColor, false);
        this.setOsdSeekBarProgressColor(savedOsdSeekBarProgressColor, false);
        this.setHeroVignette(savedHeroVignette, false);

        // Load saved card label style and stamp it on the root HTML element
        const savedCardLabelStyle = storage.getItem('pref:cardLabelStyle') || 'default';
        document.documentElement.setAttribute('data-card-label-style', savedCardLabelStyle);

        // Load saved card label alignment and stamp it on the root HTML element
        // Alignment defaults to 'start' now for cleaner card typography alignment.
        const savedCardLabelAlign = storage.getItem('pref:cardLabelAlign') || 'start';
        document.documentElement.setAttribute('data-card-label-align', savedCardLabelAlign);

        // Stamp the tier and platform for CSS targeting
        document.documentElement.setAttribute('data-layout-tier', platformInfo.layoutTier);
        document.documentElement.setAttribute('data-platform', platformInfo.platformString);

        // Dedicated television identification for styling and layout separation.
        // Stamping data-device-type allows CSS rules to definitively distinguish
        // 1080p television panels from mobile/tablet touch canvases.
        if (platformInfo.isTv) {
            document.documentElement.setAttribute('data-device-type', 'tv');
        }

        // Apply dedicated rendering quirk class/attribute for devices on ancient layout engines
        // (Chrome < 32) such as early LG WebOS 1.x and ancient Samsung Tizen 2.x firmware.
        // This isolates structural layout workarounds (e.g. table-layout / floats / ancient display-box)
        // from the standard ultra-legacy styling layers.
        if (platformInfo.isAncientChrome) {
            document.documentElement.setAttribute('data-layout-quirks', 'c26');
        }

        /*
         * Setup dynamic resize & orientation change observers for display scaling.
         * Recalculates viewport zoom factor whenever the window is resized or rotated
         * to preserve layout proportions and responsive mobile UI across desktop, web, and mobile.
         */
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
            const handleViewportChange = () => {
                this._applyDisplayScale();
            };
            window.addEventListener('resize', handleViewportChange, { passive: true });
            window.addEventListener('orientationchange', handleViewportChange, { passive: true });
            if (window.screen?.orientation?.addEventListener) {
                window.screen.orientation.addEventListener('change', handleViewportChange);
            }
        }

        /*
         * ====================================================================
         * SETTINGS RESTORATION COMPLETION
         * ====================================================================
         * Mark settings as loaded on both the documentElement and body.
         * This unblocks the startup splash loading spinner, ensuring it only
         * becomes visible once the user's chosen animation style (e.g., ring,
         * orbit, dots) and active theme tokens have taken effect.
         * ====================================================================
         */
        if (typeof document !== 'undefined' && document.documentElement) {
            document.documentElement.setAttribute('data-settings-loaded', 'true');
            if (document.body) {
                document.body.classList.add('settings-loaded');
            }
        }

        log.info(
            `Initialized: layout="${this._layout}", mode="${this._themeMode}", color="${this._themeColor}", font="${this._uiFont}", tier="${platformInfo.layoutTier}", platform="${platformInfo.platformString}", quirks="${platformInfo.isAncientChrome ? 'c26' : 'none'}"`
        );
    }

    /**
     * Set the current layout (compatibility wrapper)
     */
    setLayout(layout, save = true) {
        if (layout !== LAYOUT.CLASSIC && layout !== LAYOUT.MODERN) {
            log.warn(`Invalid layout "${layout}"`);
            return;
        }

        const oldLayout = this._mediaRowsLayout;
        this._layout = layout;

        this.setMediaRowsLayout(layout, save);
        this.setLoginPageLayout(layout, save);

        if (oldLayout !== layout) {
            log.info(`Layout changed from "${oldLayout}" to "${layout}"`);
            eventBus.emit('layout:changed', { layout, previousLayout: oldLayout });
        }
    }

    /**
     * Get the current layout (compatibility wrapper)
     */
    getLayout() {
        return this._mediaRowsLayout;
    }

    getMediaRowsLayout() {
        return this._mediaRowsLayout;
    }

    setMediaRowsLayout(layout, save = true) {
        this._mediaRowsLayout = layout;
        document.documentElement.setAttribute('data-layout-media-rows', layout);
        /*
         * Stamp the coarse disjoint "family" attributes used by CSS variant
         * guards (identical specificity to the variant guards they replace):
         *   family  = {modern, expanded, modern-posters, expanding} (non-classic)
         *   cards   = {modern, modern-posters}
         *   wide    = {expanded, expanding}
         *   posters = {modern-posters, expanding}
         * Removed outside the respective family so no rule can over-match.
         */
        const rootEl = document.documentElement;
        rootEl.setAttribute('data-media-rows-family', layout === 'classic' ? 'classic' : 'modern');
        const stampIf = (cond, attr) => {
            if (cond) rootEl.setAttribute(attr, 'modern');
            else rootEl.removeAttribute(attr);
        };
        stampIf(layout === 'modern' || layout === 'modern-posters', 'data-media-rows-cards');
        stampIf(layout === 'expanded' || layout === 'expanding', 'data-media-rows-wide');
        stampIf(layout === 'modern-posters' || layout === 'expanding', 'data-media-rows-posters');
        state.set('app:layout', layout, true);
        if (save) {
            storage.setItem('pref:mediaRowsLayout', layout);
        }
        // Update badge style dynamically if set to auto
        // Both 'modern' (expanding), 'expanded' (static widescreen), and 'modern-posters' media rows utilize
        // dark translucent card backgrounds and bottom overlay labels, requiring the dark badge style.
        if (this._badgeStyle === 'auto') {
            const resolvedStyle =
                layout === 'modern' || layout === 'expanded' || layout === 'modern-posters' || layout === 'expanding'
                    ? 'dark'
                    : 'tinted';
            document.documentElement.setAttribute('data-badge-style', resolvedStyle);
        }
        CardRenderer.clearCache();
        // Modern row variants are styled by the lazy modern layer chunk
        this.ensureModernStyles();
        eventBus.emit('mediaRowsLayout:changed', { layout });
    }

    getLoginPageLayout() {
        return this._loginPageLayout;
    }

    setLoginPageLayout(layout, save = true) {
        this._loginPageLayout = layout;
        document.documentElement.setAttribute('data-layout-login', layout);
        if (save) {
            storage.setItem('pref:loginPageLayout', layout);
        }
        // Modern login variants are styled by the lazy modern layer chunk
        this.ensureModernStyles();
        eventBus.emit('loginPageLayout:changed', { layout });
    }

    /**
     * Get Alphabet Selector Position preference.
     * Indicates whether the library quick-jump index renders horizontally
     * in the header or vertically on the right edge.
     *
     * @returns {string} 'top' or 'right'
     * @public
     */
    getAlphaPickerPosition() {
        return this._alphaPickerPosition;
    }

    /**
     * Set Alphabet Selector Position preference.
     * Updates root HTML attribute and state to toggle between top horizontal
     * and right vertical layouts.
     *
     * @param {string} position - 'top' or 'right'
     * @param {boolean} [save=true] - Whether to persist to storage
     * @public
     */
    setAlphaPickerPosition(position, save = true) {
        // Enforce valid setting values with fallback to default 'top'
        const validPosition = position === 'right' ? 'right' : 'top';
        this._alphaPickerPosition = validPosition;

        // Apply attribute on root html element for instant global CSS styling
        document.documentElement.setAttribute('data-alpha-picker-position', validPosition);

        // Update state manager for reactive components
        state.set('pref:alphaPickerPosition', validPosition, true);

        // Persist preference to local storage when requested
        if (save) {
            storage.setItem('pref:alphaPickerPosition', validPosition);
        }

        // Broadcast change event for active views like LibraryPage
        log.info(`Alphabet Selector Position set to: ${validPosition}`);
        eventBus.emit('alphaPickerPosition:changed', { position: validPosition });
    }

    /**
     * Retrieve the configured global default library view mode.
     * When no individual library preference exists, libraries default
     * to this presentation style (e.g. 'poster', 'small-poster', 'thumb', 'banner', 'list').
     *
     * @returns {string} The active default view mode identifier.
     * @public
     */
    getDefaultLibraryViewMode() {
        // Supported layout view modes in Litefin
        const validModes = ['poster', 'small-poster', 'thumb', 'banner', 'list'];

        // Retrieve stored user preference with fallback to standard 'poster'
        const saved = storage.getItem('pref:defaultLibraryViewMode');
        return validModes.includes(saved) ? saved : 'poster';
    }

    /**
     * Persist the user-selected global default library view mode.
     * Updates reactive app state and emits change events across EventBus.
     *
     * @param {string} mode - Selected view mode ('poster', 'small-poster', 'thumb', etc.)
     * @param {boolean} [save=true] - Whether to write the value to persistent storage
     * @public
     */
    setDefaultLibraryViewMode(mode, save = true) {
        // Validate against known layout identifiers
        const validModes = ['poster', 'small-poster', 'thumb', 'banner', 'list'];
        const targetMode = validModes.includes(mode) ? mode : 'poster';

        // Persist preference to local storage when requested
        if (save) {
            storage.setItem('pref:defaultLibraryViewMode', targetMode);
        }

        // Update state manager for real-time reactivity
        state.set('pref:defaultLibraryViewMode', targetMode, true);

        // Notify active subscribers and listeners
        log.info(`Default library view mode updated to: ${targetMode}`);
        eventBus.emit('pref:defaultLibraryViewMode:changed', targetMode);
    }

    /**
     * Retrieve the configured default column count (items per row) for a specific view mode.
     *
     * @param {string} [mode] - Layout mode to inspect (defaults to current default view mode)
     * @returns {number} Default number of grid columns for the mode
     * @public
     */
    getDefaultLibraryGridColumns(mode) {
        // Resolve target view mode
        const effectiveMode = mode || this.getDefaultLibraryViewMode();

        // Standard column options map matching LibraryPage capabilities
        const colOptionsMap = {
            poster: [4, 5, 6, 7],
            'small-poster': [8, 9, 10, 12],
            thumb: [3, 4, 5, 6],
            banner: [2, 3, 4, 5],
            list: [1]
        };

        // Check if mode has custom default columns configured
        const savedModeCols = parseInt(storage.getItem(`pref:defaultLibraryGridColumns:${effectiveMode}`), 10);
        const validOpts = colOptionsMap[effectiveMode] || [];
        if (validOpts.includes(savedModeCols)) {
            return savedModeCols;
        }

        // Check generic setting fallback if matching default view mode
        const genericCols = parseInt(storage.getItem('pref:defaultLibraryGridColumns'), 10);
        if (validOpts.includes(genericCols)) {
            return genericCols;
        }

        // Fall back to Litefin standard defaults per mode
        switch (effectiveMode) {
            case 'small-poster':
                return 9;
            case 'thumb':
                return 4;
            case 'banner':
                return 3;
            case 'list':
                return 1;
            case 'poster':
            default:
                return 7;
        }
    }

    /**
     * Persist user-selected default column count for a view mode.
     *
     * @param {number|string} columns - Desired column count
     * @param {string} [mode] - Mode identifier to save for (defaults to current default mode)
     * @param {boolean} [save=true] - Whether to persist to storage
     * @public
     */
    setDefaultLibraryGridColumns(columns, mode, save = true) {
        // Normalize column count to integer
        const count = parseInt(columns, 10);
        if (isNaN(count)) return;

        // Resolve mode
        const effectiveMode = mode || this.getDefaultLibraryViewMode();

        // Write to storage keys
        if (save) {
            storage.setItem(`pref:defaultLibraryGridColumns:${effectiveMode}`, count);
            storage.setItem('pref:defaultLibraryGridColumns', count);
        }

        // Emit change event
        log.info(`Default columns for ${effectiveMode} updated to: ${count}`);
        eventBus.emit('pref:defaultLibraryGridColumns:changed', { mode: effectiveMode, columns: count });
    }

    /**
     * Returns the currently active sidebar navigation layout mode.
     * @returns {string} The active sidebar layout identifier (e.g. 'classic').
     */
    getSidebarLayout() {
        return this._sidebarLayout;
    }

    /**
     * Sets and activates the sidebar layout mode across the entire UI.
     * Stamped onto <html> as data-layout-sidebar to power layout-scoped styling.
     *
     * @param {string} layout - The target sidebar layout identifier ('classic', 'modern', etc.)
     * @param {boolean} [save=true] - Whether to persist this preference in storage
     */
    setSidebarLayout(layout, save = true) {
        // Record new layout state in memory
        this._sidebarLayout = layout;

        // Stamp root element attribute for pure CSS layout branching
        document.documentElement.setAttribute('data-layout-sidebar', layout);

        /*
         * Stamp the coarse disjoint "family" attributes used by CSS variant
         * guards. These duplicate an entire variant UNION in one short selector
         * (html[data-sidebar-family="modern"] == the union of the
         * modern / modern-collapsed / floating-buttons / floating-island
         * guards) with identical specificity. Classic keeps outputting
         * 'classic' so partial guards such as ^="modern" stay unambiguous.
         * 'expandable' = {modern, modern-collapsed}, 'floating' = the two
         * floating modes; absent (removed) outside the family.
         */
        const rootEl = document.documentElement;
        rootEl.setAttribute('data-sidebar-family', layout === 'classic' ? 'classic' : 'modern');
        if (layout === 'modern' || layout === 'modern-collapsed') {
            rootEl.setAttribute('data-sidebar-expandable', 'modern');
        } else {
            rootEl.removeAttribute('data-sidebar-expandable');
        }
        if (layout === 'floating-buttons' || layout === 'floating-island') {
            rootEl.setAttribute('data-sidebar-floating', 'modern');
        } else {
            rootEl.removeAttribute('data-sidebar-floating');
        }

        // Persist preference to storage if enabled
        if (save) {
            storage.setItem('pref:sidebarLayoutMode', layout);
        }

        // Modern sidebar variants are styled by the lazy modern layer chunk
        this.ensureModernStyles();

        // Notify navigation components of layout modification
        eventBus.emit('sidebarLayout:changed', { layout });
    }

    /**
     * Checks if the sidebar is currently configured with the classic layout.
     *
     * @returns {boolean} True if sidebar layout is 'classic'.
     */
    isClassicSidebarLayout() {
        return this._sidebarLayout === 'classic';
    }

    /**
     * Checks if the sidebar is currently configured with the modern-collapsed, floating-buttons, or floating-island layout.
     * In these modes, the sidebar never expands its rail and displays tooltips on focus.
     * @returns {boolean} True if sidebar layout is collapsed/floating mode.
     */
    isModernCollapsedSidebarLayout() {
        return (
            this._sidebarLayout === 'modern-collapsed' ||
            this._sidebarLayout === 'floating-buttons' ||
            this._sidebarLayout === 'floating-island'
        );
    }

    /**
     * Checks if the sidebar is currently configured with the floating-buttons layout.
     * In this mode, each sidebar button renders as an individual floating island.
     * @returns {boolean} True if sidebar layout is 'floating-buttons'.
     */
    isFloatingButtonsSidebarLayout() {
        return this._sidebarLayout === 'floating-buttons';
    }

    /**
     * Checks if the sidebar is currently configured with the floating-island layout.
     * In this mode, middle buttons are grouped inside one continuous floating island capsule.
     * @returns {boolean} True if sidebar layout is 'floating-island'.
     */
    isFloatingIslandSidebarLayout() {
        return this._sidebarLayout === 'floating-island';
    }

    /**
     * Set the Theme Mode
     * @param {string} mode Theme mode constant
     * @param {boolean} [save=true]
     */
    setThemeMode(mode, save = true) {
        if (!Object.values(THEME_MODES).includes(mode)) {
            log.warn(`Invalid theme mode "${mode}"`);
            return;
        }

        const oldMode = this._themeMode;
        this._themeMode = mode;

        document.documentElement.setAttribute('data-theme-mode', mode);

        // Fetch the static palette for this mode (async chunk; no-op when
        // already fetched). The dynamic derived variables below apply
        // immediately regardless - the palette chunk only adds the mode's
        // static --jf-* declarations and selector-specific styling.
        this.loadThemeStyles(mode);

        // Apply dynamic styles
        this._applyDynamicTheme();

        state.set('app:themeMode', mode, true);

        if (save) {
            storage.setItem('litefin:themeMode', mode);
            // Legacy theme key update for compatibility where needed
            storage.setItem('litefin:theme', mode);
        }

        if (oldMode !== mode) {
            log.info(`Theme mode changed to "${mode}"`);
            eventBus.emit('themeMode:changed', { mode, previousMode: oldMode });
        }
    }

    /**
     * Ensure the static palette stylesheet for a theme mode is loaded.
     *
     * Kicks the async CSS chunk import for the mode's theme file exactly once
     * (repeated calls return the same promise). When the chunk resolves, the
     * newly injected <style> tag is adopted by the CssVarsPolyfill so its
     * var() references resolve on legacy engines before the next repaint.
     * No-op for modes without a palette file.
     * @param {string} mode Theme mode constant
     * @returns {Promise<void>|undefined}
     */
    loadThemeStyles(mode) {
        const importer = THEME_STYLE_IMPORTS[mode];
        if (!importer) return undefined;

        if (!this._themeStylePromises[mode]) {
            this._themeStylePromises[mode] = importer()
                .then(() => {
                    // Adopt the freshly injected palette tag (legacy engines
                    // only; no-op when native CSS custom properties exist).
                    cssVarsPolyfill.ensureStylesResolved();
                    log.debug(`Theme palette loaded: "${mode}"`);
                })
                .catch((err) => {
                    // Allow retry on a later setThemeMode call
                    this._themeStylePromises[mode] = null;
                    log.warn(`Theme palette chunk failed for "${mode}":`, err);
                });
        }

        return this._themeStylePromises[mode];
    }

    /**
     * Ensure the modern interface layer stylesheet is loaded.
     *
     * The six modern/*.css layers (~204KB source) are attribute-gated by three
     * independent layout dimensions (sidebar family, media-rows family, login
     * page layout). When every dimension is 'classic' the rules could never
     * match, so the chunk is not fetched at all; otherwise it loads once as an
     * async CSS chunk instead of riding the boot bundle. Classic->modern
     * runtime switches trigger the fetch; the styles stay resident after.
     * @returns {Promise<void>|undefined}
     */
    ensureModernStyles() {
        const needsModern =
            this._sidebarLayout !== 'classic' ||
            this._mediaRowsLayout !== 'classic' ||
            this._loginPageLayout !== 'classic';

        if (!needsModern) return undefined;

        if (!this._modernStylesPromise) {
            this._modernStylesPromise = import(/* webpackChunkName: "modern-css" */ '../styles/modern/bundle.css')
                .then(() => {
                    // Adopt the freshly injected layer tags (legacy engines
                    // only; no-op when native CSS custom properties exist).
                    cssVarsPolyfill.ensureStylesResolved();
                    log.debug('Modern interface styles loaded');
                })
                .catch((err) => {
                    // Allow retry on a later layout change
                    this._modernStylesPromise = null;
                    log.warn('Modern styles chunk failed:', err);
                });
        }

        return this._modernStylesPromise;
    }

    /**
     * Set the Theme Color
     * @param {string} color Hex color string
     * @param {boolean} [save=true]
     */
    setThemeColor(color, save = true) {
        if (!color.startsWith('#')) {
            log.warn(`Invalid hex color "${color}"`);
            return;
        }

        const oldColor = this._themeColor;
        this._themeColor = color;

        // Apply dynamic styles
        this._applyDynamicTheme();

        state.set('app:themeColor', color, true);

        if (save) {
            storage.setItem('litefin:themeColor', color);
        }

        if (oldColor !== color) {
            log.info(`Theme color changed to "${color}"`);
            eventBus.emit('themeColor:changed', { color, previousColor: oldColor });
        }
    }

    _applyDynamicTheme() {
        /*
         * Resolve the effective accent color.
         * When the Signature Accent override is enabled and the active theme
         * mode has a dedicated signature color, it replaces the user theme
         * color for all dynamically derived accent variables.
         */
        let effectiveColor = this._themeColor;
        if (this._signatureAccent && DEFAULT_MODE_COLORS[this._themeMode]) {
            effectiveColor = DEFAULT_MODE_COLORS[this._themeMode];
        }

        const accents = themeUtils.getAccentVariants(effectiveColor);
        const contrastColor = themeUtils.getContrastColor(effectiveColor);
        const contrastRgb = themeUtils.hexToRgb(contrastColor);
        const contrastRgbStr = contrastRgb ? `${contrastRgb.r}, ${contrastRgb.g}, ${contrastRgb.b}` : '255, 255, 255';

        // Focus Indicator Logic:
        // If the accent color is "bright" (Luminance > 0.4), the calculated contrast color
        // (normally for text) is very dark. Since most themes are dark, a dark focus border
        // would be invisible. We use a soft light variant for focus borders in these cases.
        const isBrightAccent = themeUtils.isBright(effectiveColor);
        const focusBorderColor = isBrightAccent ? themeUtils.getSoftLight(effectiveColor) : contrastColor;

        // Remove any inline flash-prevention variables injected by index.html
        // so that our dynamic stylesheet (which has lower specificity than inline style)
        // can successfully cascade and take full control.
        const rootStyle = document.documentElement.style;
        rootStyle.removeProperty('--jf-accent');
        rootStyle.removeProperty('--jf-background');
        rootStyle.removeProperty('--jf-text-primary');
        rootStyle.removeProperty('--jf-text-secondary');

        // 1. Build style rules for native and polyfill consumption
        // Use html[data-theme-mode="..."] to ensure 0,1,1 specificity, which beats
        // lazily loaded :root chunks and regular [data-theme-mode] (0,1,0) rules.
        let dynamicCss = `html[data-theme-mode="${this._themeMode}"] {
            --jf-accent: ${accents.accent};
            --jf-accent-rgb: ${accents.accentRgb};
            --jf-accent-dark-rgb: ${accents.accentDarkRgb};
            --jf-accent-hover: ${accents.accentHover};
            --jf-accent-active: ${accents.accentActive};
            --jf-accent-light: ${accents.accentLight};
            --jf-accent-content-color: ${contrastColor};
            --jf-accent-content-color-rgb: ${contrastRgbStr};
            --jf-primary-btn-color: ${contrastColor};
            --jf-primary-btn-color-rgb: ${contrastRgbStr};
            --jf-switch-handle: ${contrastColor};
            --jf-action-btn-active-border: ${focusBorderColor};
            --jf-button-border-focus: ${focusBorderColor};
            --jf-focus-border-color: ${accents.accent};`;

        // 1.25. Set Semantic Button & Control Defaults per Theme Mode
        // Ensures that CssVarsPolyfill captures the active mode's exact button and control styling.
        const isLightMode =
            this._themeMode === THEME_MODES.CLASSIC_LIGHT ||
            this._themeMode === THEME_MODES.FROST ||
            this._themeMode === THEME_MODES.PAPER ||
            this._themeMode === THEME_MODES.TINTED_LIGHT;
        const buttonBg = isLightMode
            ? this._themeMode === THEME_MODES.FROST
                ? 'rgba(27, 44, 56, 0.09)'
                : this._themeMode === THEME_MODES.PAPER
                  ? 'rgba(51, 42, 31, 0.07)'
                  : '#eeeeee'
            : this._themeMode === THEME_MODES.BLACK
              ? '#222222'
              : 'rgba(255, 255, 255, 0.10)';
        const buttonHover = isLightMode
            ? this._themeMode === THEME_MODES.FROST
                ? 'rgba(27, 44, 56, 0.16)'
                : this._themeMode === THEME_MODES.PAPER
                  ? 'rgba(51, 42, 31, 0.14)'
                  : '#e0e0e0'
            : this._themeMode === THEME_MODES.BLACK
              ? '#2a2a2a'
              : 'rgba(255, 255, 255, 0.20)';
        const inputBg = isLightMode
            ? this._themeMode === THEME_MODES.FROST
                ? 'rgba(27, 44, 56, 0.06)'
                : this._themeMode === THEME_MODES.PAPER
                  ? 'rgba(51, 42, 31, 0.05)'
                  : '#f0f0f0'
            : this._themeMode === THEME_MODES.BLACK
              ? '#181818'
              : 'rgba(255, 255, 255, 0.08)';
        const inputBorder = isLightMode
            ? this._themeMode === THEME_MODES.FROST
                ? 'rgba(27, 44, 56, 0.16)'
                : this._themeMode === THEME_MODES.PAPER
                  ? 'rgba(51, 42, 31, 0.16)'
                  : '#dddddd'
            : this._themeMode === THEME_MODES.BLACK
              ? '#222222'
              : 'rgba(255, 255, 255, 0.15)';
        const errorColor = isLightMode
            ? this._themeMode === THEME_MODES.FROST
                ? '#e25746'
                : this._themeMode === THEME_MODES.PAPER
                  ? '#bf5040'
                  : '#d32f2f'
            : '#f44336';

        dynamicCss += `
            --jf-button-bg: ${buttonBg};
            --jf-button-hover: ${buttonHover};
            --jf-input-bg: ${inputBg};
            --jf-input-border: ${inputBorder};
            --jf-error: ${errorColor};`;

        // 1.5. Set Text Colors (Ensures ultra-legacy build always has stable text vars)
        if (this._themeMode === THEME_MODES.TINTED_LIGHT) {
            /*
             * Light Tinted mode applies warm cream / champagne typography tailored
             * to harmonize with the elevated tinted background shade.
             */
            const tints = themeUtils.getTintedLightColors(effectiveColor);
            dynamicCss += `
            --jf-text-primary: ${tints.textPrimary};
            --jf-text-secondary: ${tints.textSecondary};
            --jf-text-tertiary: ${tints.textTertiary};
            
            --text-primary: var(--jf-text-primary);
            --text-secondary: var(--jf-text-secondary);
            --text-muted: var(--jf-text-secondary);`;
        } else if (this._themeMode !== THEME_MODES.TINTED) {
            const isLight = this._themeMode === THEME_MODES.CLASSIC_LIGHT;
            // Per-mode text palettes; defaults cover neutral dark canvas modes.
            let textPrimary = '#ffffff';
            let textSecondary = 'rgba(255, 255, 255, 0.8)';
            let textTertiary = '#666666';

            if (isLight) {
                textPrimary = '#101010';
                textSecondary = '#666666';
                textTertiary = '#888888';
            } else if (this._themeMode === THEME_MODES.EMBER) {
                // Warm firelight-white typography for the candlelit canvas.
                textPrimary = '#fff4ea';
                textSecondary = 'rgba(255, 235, 214, 0.78)';
                textTertiary = 'rgba(255, 220, 190, 0.55)';
            } else if (this._themeMode === THEME_MODES.SUNSET) {
                // Rosy dusk-white typography for the sunset gradient canvas.
                textPrimary = '#ffffff';
                textSecondary = 'rgba(255, 228, 220, 0.8)';
                textTertiary = 'rgba(255, 228, 220, 0.55)';
            } else if (this._themeMode === THEME_MODES.FROST) {
                // Dark slate typography on the glacier light canvas.
                textPrimary = '#1b2c38';
                textSecondary = '#466171';
                textTertiary = '#7d96a6';
            } else if (this._themeMode === THEME_MODES.PAPER) {
                // Warm ink typography on the parchment canvas.
                textPrimary = '#332a1f';
                textSecondary = '#5d5245';
                textTertiary = '#8a7d6a';
            } else if (this._themeMode === THEME_MODES.NOCTURNE) {
                // Celluloid white typography, warm silver secondaries.
                textPrimary = '#f6f2ea';
                textSecondary = 'rgba(230, 224, 210, 0.76)';
                textTertiary = 'rgba(214, 210, 196, 0.54)';
            } else if (this._themeMode === THEME_MODES.ABYSS) {
                // Brine-white typography with cold-sea secondaries.
                textPrimary = '#eff7f6';
                textSecondary = 'rgba(218, 240, 238, 0.74)';
                textTertiary = 'rgba(196, 224, 224, 0.52)';
            } else if (this._themeMode === THEME_MODES.CYBERPUNK) {
                // Neon-lit white typography, violet-cool secondaries.
                textPrimary = '#f2f4ff';
                textSecondary = 'rgba(228, 222, 245, 0.76)';
                textTertiary = 'rgba(206, 202, 228, 0.52)';
            }

            dynamicCss += `
            --jf-text-primary: ${textPrimary};
            --jf-text-secondary: ${textSecondary};
            --jf-text-tertiary: ${textTertiary};
            
            --text-primary: var(--jf-text-primary);
            --text-secondary: var(--jf-text-secondary);
            --text-muted: var(--jf-text-secondary);`;
        } else {
            // For dark tinted mode, just pass through the custom aliases
            dynamicCss += `
            --text-primary: var(--jf-text-primary);
            --text-secondary: var(--jf-text-secondary);
            --text-muted: var(--jf-text-secondary);`;
        }

        // 2. Apply background variables based on theme mode
        if (this._themeMode === THEME_MODES.TINTED_LIGHT) {
            const tints = themeUtils.getTintedLightColors(effectiveColor);
            /*
             * Light Tinted theme provides an elevated, luminous background (~26% lightness)
             * with crisp card elevation and rich tint characteristics (e.g., mocha/brown).
             */
            const bg = this._lighterBackground ? tints.backgroundAlt : tints.background;
            const bgAlt = this._lighterBackground ? tints.background : tints.backgroundAlt;
            const bgRgb = themeUtils.hexToRgb(bg);
            const bgRgbStr = bgRgb ? `${bgRgb.r}, ${bgRgb.g}, ${bgRgb.b}` : '245, 245, 245';

            /*
             * Assign dedicated background tokens and explicitly bind --sidebar-bg
             * so navigation and settings-sidebar surfaces cleanly reflect tinted tones.
             */
            dynamicCss += `
            --jf-background: ${bg};
            --jf-background-rgb: ${bgRgbStr};
            --jf-background-alt: ${bgAlt};
            --sidebar-bg: ${bgAlt};
            --jf-surface: ${tints.surface};
            --jf-card-bg: ${tints.cardBg};
            --jf-card-bg-hover: ${tints.cardBgHover};
            --jf-divider: ${tints.divider};
            --jf-navbar-bg: ${bg};`;
        } else if (this._themeMode === THEME_MODES.TINTED) {
            const tints = themeUtils.getTintedColors(effectiveColor);
            /*
             * In Tinted mode, swapping background and background-alt provides
             * a noticeably lighter canvas while keeping the deeper tint on complementary bars.
             */
            const bg = this._lighterBackground ? tints.backgroundAlt : tints.background;
            const bgAlt = this._lighterBackground ? tints.background : tints.backgroundAlt;
            const bgRgb = themeUtils.hexToRgb(bg);
            const bgRgbStr = bgRgb ? `${bgRgb.r}, ${bgRgb.g}, ${bgRgb.b}` : '16, 16, 16';

            /*
             * Bind --sidebar-bg directly to ${bgAlt} to guarantee that settings split-view
             * and settings-mode navigation rails take on the calculated chromatic shade.
             */
            dynamicCss += `
            --jf-background: ${bg};
            --jf-background-rgb: ${bgRgbStr};
            --jf-background-alt: ${bgAlt};
            --sidebar-bg: ${bgAlt};
            --jf-surface: ${tints.surface};
            --jf-card-bg: ${tints.cardBg};
            --jf-card-bg-hover: ${tints.cardBgHover};
            --jf-divider: ${tints.divider};
            --jf-navbar-bg: ${bg};`;
        } else if (this._themeMode === THEME_MODES.AMBIENT) {
            // Elegant, matte ultra-dark background.
            // A deeply saturated charcoal canvas serves as the foundation.
            // Translucent material cards absorb the dynamically-cast ambient gradients.
            // Set sidebar background to transparent to ensure ambient glow bleeds through cleanly.
            dynamicCss += `
            --jf-background: #0a0b0c;
            --jf-background-rgb: 10, 11, 12;
            --jf-background-alt: #070809;
            --sidebar-bg: transparent;
            --jf-surface: rgba(255, 255, 255, 0.035);
            --jf-card-bg: rgba(255, 255, 255, 0.045);
            --jf-card-bg-hover: rgba(255, 255, 255, 0.1);
            --jf-divider: rgba(255, 255, 255, 0.06);
            --jf-navbar-bg: rgba(7, 8, 9, 0.85);`;
        } else if (this._themeMode === THEME_MODES.EMBER) {
            // Candlelit warm night: roasted brown-black canvas with
            // firelight-tinted glass surfaces that let the ember glow bleed.
            dynamicCss += `
            --jf-background: #0d0906;
            --jf-background-rgb: 13, 9, 6;
            --jf-background-alt: #150d07;
            --sidebar-bg: transparent;
            --jf-surface: rgba(255, 158, 84, 0.05);
            --jf-card-bg: rgba(255, 158, 84, 0.08);
            --jf-card-bg-hover: rgba(255, 158, 84, 0.17);
            --jf-divider: rgba(255, 158, 84, 0.13);
            --jf-navbar-bg: rgba(10, 7, 5, 0.85);`;
        } else if (this._themeMode === THEME_MODES.SUNSET) {
            // Gradient dusk: twilight plum canvas with rose-tinted glass
            // surfaces layered over the sunset sweep.
            dynamicCss += `
            --jf-background: #1c142e;
            --jf-background-rgb: 28, 20, 46;
            --jf-background-alt: #241938;
            --sidebar-bg: transparent;
            --jf-surface: rgba(255, 148, 108, 0.06);
            --jf-card-bg: rgba(255, 148, 108, 0.09);
            --jf-card-bg-hover: rgba(255, 148, 108, 0.18);
            --jf-divider: rgba(255, 148, 108, 0.14);
            --jf-navbar-bg: rgba(18, 12, 34, 0.78);`;
        } else if (this._themeMode === THEME_MODES.FROST) {
            // Icy light mode: glacier white-to-pale-ice gradient canvas
            // with cool translucent frost surfaces.
            dynamicCss += `
            --jf-background: #e8f1f6;
            --jf-background-rgb: 232, 241, 246;
            --jf-background-alt: #dde9f1;
            --sidebar-bg: transparent;
            --jf-surface: rgba(255, 255, 255, 0.72);
            --jf-card-bg: #ffffff;
            --jf-card-bg-hover: #f0f7fb;
            --jf-divider: rgba(100, 140, 165, 0.18);
            --jf-navbar-bg: rgba(248, 252, 254, 0.82);`;
        } else if (this._themeMode === THEME_MODES.PAPER) {
            // Warm sepia reading mode: parchment canvas with soft paper tones.
            dynamicCss += `
            --jf-background: #f2ead9;
            --jf-background-rgb: 242, 234, 217;
            --jf-background-alt: #e9dfca;
            --sidebar-bg: transparent;
            --jf-surface: #faf5ea;
            --jf-card-bg: #f9f3e6;
            --jf-card-bg-hover: #fdf9f0;
            --jf-divider: rgba(122, 100, 70, 0.2);
            --jf-navbar-bg: rgba(246, 240, 228, 0.88);`;
        } else if (this._themeMode === THEME_MODES.NOCTURNE) {
            // Projection booth: steel-to-ink canvas with silver-film glass
            // surfaces and splice hairlines so the beam light bleeds.
            dynamicCss += `
            --jf-background: #0c0e13;
            --jf-background-rgb: 12, 14, 19;
            --jf-background-alt: #12151d;
            --sidebar-bg: transparent;
            --jf-surface: rgba(214, 224, 240, 0.045);
            --jf-card-bg: rgba(214, 224, 240, 0.07);
            --jf-card-bg-hover: rgba(214, 224, 240, 0.16);
            --jf-divider: rgba(214, 224, 240, 0.14);
            --jf-navbar-bg: rgba(9, 11, 16, 0.85);`;
        } else if (this._themeMode === THEME_MODES.ABYSS) {
            // Deep sea: pressure canvas with current-blur glass surfaces
            // layered over the lure glow.
            dynamicCss += `
            --jf-background: #06111c;
            --jf-background-rgb: 6, 17, 28;
            --jf-background-alt: #03101a;
            --sidebar-bg: transparent;
            --jf-surface: rgba(140, 220, 215, 0.04);
            --jf-card-bg: rgba(140, 220, 215, 0.07);
            --jf-card-bg-hover: rgba(140, 220, 215, 0.15);
            --jf-divider: rgba(140, 220, 215, 0.13);
            --jf-navbar-bg: rgba(4, 10, 16, 0.82);`;
        } else if (this._themeMode === THEME_MODES.CYBERPUNK) {
            // Night city: violet-ink canvas with neon-tinted glass surfaces
            // layered under the sign blooms and scanline raster.
            dynamicCss += `
            --jf-background: #0a0713;
            --jf-background-rgb: 10, 7, 19;
            --jf-background-alt: #100b1e;
            --sidebar-bg: transparent;
            --jf-surface: rgba(150, 120, 255, 0.045);
            --jf-card-bg: rgba(150, 120, 255, 0.07);
            --jf-card-bg-hover: rgba(150, 120, 255, 0.16);
            --jf-divider: rgba(150, 120, 255, 0.13);
            --jf-navbar-bg: rgba(7, 5, 14, 0.86);`;
        } else if (this._themeMode === THEME_MODES.BLACK) {
            /*
             * True Pitch Black canvas for OLED displays.
             * Eliminates backlighting bleed while setting sidebar-bg to pure black.
             */
            dynamicCss += `
            --jf-background: #000000;
            --jf-background-rgb: 0, 0, 0;
            --jf-background-alt: #000000;
            --sidebar-bg: #000000;
            --jf-surface: #0a0a0a;
            --jf-card-bg: #080808;
            --jf-card-bg-hover: #121212;
            --jf-divider: rgba(255, 255, 255, 0.05);
            --jf-navbar-bg: #000000;`;
        } else if (this._themeMode === THEME_MODES.CLASSIC_DARK) {
            /*
             * In Classic Dark mode, swaps #101010 and #151515 for a lighter charcoal base.
             */
            const bg = this._lighterBackground ? '#151515' : '#101010';
            const bgAlt = this._lighterBackground ? '#101010' : '#151515';
            const bgRgb = themeUtils.hexToRgb(bg);
            const bgRgbStr = bgRgb ? `${bgRgb.r}, ${bgRgb.g}, ${bgRgb.b}` : '16, 16, 16';

            /*
             * Expose --sidebar-bg mapped to the secondary charcoal surface shade.
             */
            dynamicCss += `
            --jf-background: ${bg};
            --jf-background-rgb: ${bgRgbStr};
            --jf-background-alt: ${bgAlt};
            --sidebar-bg: ${bgAlt};
            --jf-surface: #1a1a1a;
            --jf-card-bg: #151515;
            --jf-card-bg-hover: #252525;
            --jf-divider: rgba(255, 255, 255, 0.08);
            --jf-navbar-bg: ${this._lighterBackground ? '#101010' : '#151515'};`;
        } else if (this._themeMode === THEME_MODES.CLASSIC_LIGHT) {
            /*
             * In Classic Light mode, swaps #fdfdfd and #f5f5f5 for softer contrast balance.
             */
            const bg = this._lighterBackground ? '#f5f5f5' : '#fdfdfd';
            const bgAlt = this._lighterBackground ? '#fdfdfd' : '#f5f5f5';
            const bgRgb = themeUtils.hexToRgb(bg);
            const bgRgbStr = bgRgb ? `${bgRgb.r}, ${bgRgb.g}, ${bgRgb.b}` : '253, 253, 253';

            /*
             * Expose --sidebar-bg mapped to the softer light neutral background tone.
             */
            dynamicCss += `
            --jf-background: ${bg};
            --jf-background-rgb: ${bgRgbStr};
            --jf-background-alt: ${bgAlt};
            --sidebar-bg: ${bgAlt};
            --jf-surface: #ffffff;
            --jf-card-bg: #ffffff;
            --jf-card-bg-hover: #fcfcfc;
            --jf-divider: #eeeeee;
            --jf-navbar-bg: ${this._lighterBackground ? '#fdfdfd' : 'rgba(255, 255, 255, 0.95)'};`;
        }

        dynamicCss += `\n        }`;

        // ====================================================================
        // ANCIENT WEBVIEW GRADIENT & COLOR OVERRIDES (CHROME < 32 / TIZEN 2.x)
        // ====================================================================
        // css-vars-ponyfill has severe performance and parsing limitations
        // on ancient WebKit/Chromium engines when dealing with nested values,
        // complex radial-gradients, and background-image assignments.
        // We write static values and prefixed gradients directly to bypass it.
        // ====================================================================
        if (platformInfo.isAncientChrome) {
            // Resolve the exact background color for the current theme mode
            let resolvedBg = '#101010';
            if (this._themeMode === THEME_MODES.TINTED_LIGHT) {
                const tints = themeUtils.getTintedLightColors(effectiveColor);
                resolvedBg = this._lighterBackground ? tints.backgroundAlt : tints.background;
            } else if (this._themeMode === THEME_MODES.TINTED) {
                const tints = themeUtils.getTintedColors(effectiveColor);
                resolvedBg = this._lighterBackground ? tints.backgroundAlt : tints.background;
            } else if (this._themeMode === THEME_MODES.AMBIENT) {
                resolvedBg = '#0a0b0c';
            } else if (this._themeMode === THEME_MODES.EMBER) {
                resolvedBg = '#0d0906';
            } else if (this._themeMode === THEME_MODES.SUNSET) {
                resolvedBg = '#1c142e';
            } else if (this._themeMode === THEME_MODES.FROST) {
                resolvedBg = '#e8f1f6';
            } else if (this._themeMode === THEME_MODES.PAPER) {
                resolvedBg = '#f2ead9';
            } else if (this._themeMode === THEME_MODES.NOCTURNE) {
                resolvedBg = '#0c0e13';
            } else if (this._themeMode === THEME_MODES.ABYSS) {
                resolvedBg = '#06111c';
            } else if (this._themeMode === THEME_MODES.CYBERPUNK) {
                resolvedBg = '#0a0713';
            } else if (this._themeMode === THEME_MODES.BLACK) {
                resolvedBg = '#000000';
            } else if (this._themeMode === THEME_MODES.CLASSIC_LIGHT) {
                resolvedBg = this._lighterBackground ? '#f5f5f5' : '#fdfdfd';
            } else if (this._themeMode === THEME_MODES.CLASSIC_DARK) {
                resolvedBg = this._lighterBackground ? '#151515' : '#101010';
            }

            // Write static background-color rule directly to body, preserving player transparency
            dynamicCss += `\n/* Direct theme overrides for Chrome < 32 */\n`;
            dynamicCss += `html[data-layout-quirks="c26"] body:not(.player-active) {
                background-color: ${resolvedBg} !important;
            }\n`;

            // Ensure focused setting item row background updates cleanly with active accent on ancient engines
            dynamicCss += `html[data-layout-quirks="c26"] .setting-item.focused-row {
                background-color: rgba(${accents.accentRgb}, 0.15) !important;
            }\n`;

            if (this._themeMode === THEME_MODES.AMBIENT) {
                // Apply vendor-prefixed -webkit-radial-gradient using calculated accent RGB values.
                // Map coordinates directly to match modern CSS radial-gradient positions.
                // Hardware optimization: isolate on a fixed body::before layer with transform: translateZ(0)
                // to eliminate full-screen rasterization overhead during scrolling on older TV chipsets.
                dynamicCss += `html[data-layout-quirks="c26"][data-theme-mode="ambient"] body::before {
                    content: '' !important;
                    position: fixed !important;
                    top: 0 !important;
                    left: 0 !important;
                    right: 0 !important;
                    bottom: 0 !important;
                    width: 100% !important;
                    height: 100% !important;
                    z-index: -1 !important;
                    pointer-events: none !important;
                    background-color: ${resolvedBg} !important;
                    background-image: 
                        -webkit-radial-gradient(85% 15%, circle, rgba(${accents.accentRgb}, 0.30) 0%, rgba(${accents.accentRgb}, 0.10) 35%, transparent 70%),
                        -webkit-radial-gradient(15% 85%, circle, rgba(${accents.accentRgb}, 0.30) 0%, rgba(${accents.accentRgb}, 0.10) 35%, transparent 70%) !important;
                    background-size: cover !important;
                    background-repeat: no-repeat !important;
                    -webkit-transform: translateZ(0) !important;
                    transform: translateZ(0) !important;
                }
                html[data-layout-quirks="c26"][data-theme-mode="ambient"] body {
                    background-color: transparent !important;
                    background-image: none !important;
                }
                html[data-layout-quirks="c26"][data-theme-mode="ambient"] body.player-active::before,
                html[data-layout-quirks="c26"].player-active[data-theme-mode="ambient"] body::before {
                    display: none !important;
                }
                html[data-layout-quirks="c26"][data-theme-mode="ambient"] .page {
                    background: transparent !important;
                }\n`;
            } else {
                // Ensure dynamic gradients and pseudo-elements from other sessions are cleared
                dynamicCss += `html[data-layout-quirks="c26"] body {
                    background-image: none !important;
                }
                html[data-layout-quirks="c26"] body::before {
                    display: none !important;
                }\n`;
            }
        }

        // Create or update the dynamic style element
        if (!this._dynamicStyleEl) {
            this._dynamicStyleEl = document.createElement('style');
            this._dynamicStyleEl.id = 'litefin-dynamic-theme-vars';
            document.head.appendChild(this._dynamicStyleEl);
        }
        this._dynamicStyleEl.textContent = dynamicCss;

        // Polyfill update for legacy Tizen
        cssVarsPolyfill.update();

        // Sync Debug Overlay colors
        if (debugOverlay) {
            debugOverlay.refreshTheme();
        }
    }

    /**
     * Get current theme mode (for UI display etc)
     */
    getThemeMode() {
        return this._themeMode;
    }

    /**
     * Get current theme color
     */
    getThemeColor() {
        return this._themeColor;
    }

    /**
     * Returns whether the lighter background mode is active.
     * @returns {boolean} True if lighter background swap is enabled.
     */
    getLighterBackground() {
        return this._lighterBackground;
    }

    /**
     * Sets and activates the lighter background mode across supported themes.
     * Swaps the primary background with the alternate background and re-applies CSS vars.
     *
     * @param {boolean} enabled - Whether lighter background mode is active
     * @param {boolean} [save=true] - Whether to persist this preference in storage
     */
    setLighterBackground(enabled, save = true) {
        // Update in-memory state
        this._lighterBackground = !!enabled;

        // Stamp data attribute for optional CSS scoping
        document.documentElement.setAttribute('data-lighter-background', this._lighterBackground ? 'true' : 'false');

        // Persist preference to storage if requested
        if (save) {
            storage.setItem('litefin:lighterBackground', this._lighterBackground ? 'true' : 'false');
        }

        // Re-calculate and inject active theme stylesheet variables
        this._applyDynamicTheme();

        log.info(`Lighter background preference updated: ${this._lighterBackground}`);

        // Notify UI listeners of state alteration
        eventBus.emit('lighterBackground:changed', { enabled: this._lighterBackground });
    }

    /**
     * Returns whether the signature accent override is active.
     * @returns {boolean} True when the active mode's signature color replaces the user theme color.
     */
    getSignatureAccent() {
        return this._signatureAccent;
    }

    /**
     * Returns the unique signature color of a theme mode or null.
     *
     * @param {string} [mode] - Theme mode to inspect (defaults to the active mode)
     * @returns {string|null} Signature hex color, or null when the mode has none
     * @public
     */
    getSignatureColor(mode) {
        const targetMode = mode || this._themeMode;
        return DEFAULT_MODE_COLORS[targetMode] || null;
    }

    /**
     * Sets and activates the signature accent override for the artistic theme modes.
     * When enabled on a supported mode, the active accent color is replaced with
     * that mode's unique signature color while rendering.
     *
     * @param {boolean} enabled - Whether the signature accent override is active
     * @param {boolean} [save=true] - Whether to persist this preference in storage
     */
    setSignatureAccent(enabled, save = true) {
        // Update in-memory state
        this._signatureAccent = !!enabled;

        // Stamp data attribute for optional CSS scoping
        document.documentElement.setAttribute('data-signature-accent', this._signatureAccent ? 'true' : 'false');

        // Persist preference to storage if requested
        if (save) {
            storage.setItem('litefin:signatureAccent', this._signatureAccent ? 'true' : 'false');
        }

        // Re-calculate and inject active theme stylesheet variables
        this._applyDynamicTheme();

        log.info(`Signature accent override updated: ${this._signatureAccent}`);

        // Notify UI listeners of state alteration
        eventBus.emit('signatureAccent:changed', { enabled: this._signatureAccent });
    }

    // Font and Rounded Corners helpers (Existing logic maintained)
    getUiFont() {
        return this._uiFont;
    }
    setUiFont(font, save = true) {
        this._uiFont = font;
        if (font && font !== 'default') document.documentElement.setAttribute('data-ui-font', font);
        else document.documentElement.removeAttribute('data-ui-font');
        if (save) {
            storage.setItem('litefin:uiFont', font);
            storage.flush();
        }

        // Load the fallback font dynamically if selected
        document.documentElement.style.removeProperty('--ui-fallback-font-family');
        if (isFallbackFont(font)) {
            document.documentElement.style.setProperty('--ui-fallback-font-family', `"${getFallbackFontFamily(font)}"`);
            if (state.get('user:authenticated')) {
                import('../utils/FontLoader.js').then((module) => {
                    module.default.loadFont(font);
                });
            }
        }
    }

    getRoundedCorners() {
        return this._roundedCorners;
    }
    setRoundedCorners(enabled, save = true) {
        this._roundedCorners = enabled;
        document.documentElement.setAttribute('data-rounded-corners', enabled ? 'true' : 'false');
        if (save) storage.setItem('litefin:roundedCorners', enabled ? 'true' : 'false');
        eventBus.emit('roundedCorners:changed', { enabled });
        // Re-apply ponyfill so Chromium 47 legacy engines pick up updated border-radius variables
        if (cssVarsPolyfill && typeof cssVarsPolyfill.update === 'function') {
            cssVarsPolyfill.update();
        }
    }

    getBadgeStyle() {
        return this._badgeStyle;
    }
    setBadgeStyle(style, save = true) {
        this._badgeStyle = style;
        let resolvedStyle = style;
        if (style === 'auto') {
            resolvedStyle = this._layout === 'modern' ? 'dark' : 'tinted';
        }
        document.documentElement.setAttribute('data-badge-style', resolvedStyle);
        if (save) storage.setItem('litefin:badgeStyle', style);
        log.info(`Badge style set to: ${style} (resolved: ${resolvedStyle})`);
        eventBus.emit('badgeStyle:changed', { style, resolvedStyle });
    }

    /**
    /**
     * ========================================================================
     * Global Typography & Text Scaling Engine
     * ========================================================================
     * Adjusts the foundational root font sizing and propagates the scale factor
     * across all adaptive stylesheets via the `--litefin-text-scale` CSS variable.
     *
     * In standard desktop/TV viewport profiles, scaling the document root font size
     * dynamically recalculates all relative rem-based layout tokens.
     * In mobile portrait and landscape viewports, stylesheets consume the
     * `--litefin-text-scale` variable within calc() expressions to maintain calibrated
     * touch proportions and legibility without hardcoded layout breakage.
     *
     * @param {number} scale Multiplier for base typography (e.g. 1.2 for 120%)
     * @param {boolean} [save=true] Whether to persist the scale preference
     * ========================================================================
     */
    setTextScale(scale, save = true) {
        // Update internal text scale tracker
        this._textScale = scale;

        // Propagate custom CSS property to document root so all responsive rules
        // and platform-specific stylesheets (including Android mobile & TV) can scale typography
        document.documentElement.style.setProperty('--litefin-text-scale', String(scale));

        // Calculate and apply base font size directly to root element with priority flag.
        // Standard base is 16px. Scaling this scales all 'rem' units across the UI canvas.
        const pixelSize = 16 * scale;
        document.documentElement.style.setProperty('font-size', `${pixelSize}px`, 'important');

        // Persist preference to local storage when requested
        if (save) {
            storage.setItem('litefin:textScale', scale.toString());
        }

        // Emit change event to allow listening components to update if necessary
        log.info(`Text scale updated: ${scale} (${pixelSize}px)`);
        eventBus.emit('textScale:changed', { scale });
    }

    getTextScale() {
        return this._textScale;
    }

    setCardLabelScale(scale, save = true) {
        this._cardLabelScale = scale;
        document.documentElement.style.setProperty('--card-title-font-scale', scale.toString());
        if (save) {
            storage.setItem('pref:cardLabelScale', scale.toString());
        }
        eventBus.emit('cardLabelScale:changed', { scale });
    }

    getCardLabelScale() {
        return this._cardLabelScale;
    }

    /**
     * ========================================================================
     * Display Scaling Engine
     * ========================================================================
     * Manages global viewport zoom scaling across web, desktop, and TV targets.
     * Provides a hybrid mechanism:
     * - 'auto': Dynamically fits canvas to standard 1080p (1920x1080) dimensions,
     *   ensuring TV-grade proportions on smaller or desktop browser viewports.
     * - manual: Explicit zoom factor (e.g. 0.75, 0.8, 0.9, 1.0, 1.1).
     * ========================================================================
     */

    /**
     * Retrieves the configured display scale mode ('auto', '0.75', '0.8', etc.)
     * @returns {string} Configured display scale value
     */
    getDisplayScale() {
        return this._displayScale;
    }

    /**
     * Configures global interface display scaling and applies CSS zoom.
     * @param {string|number} scale - Scale factor or 'auto' for responsive 1080p fit
     * @param {boolean} [save=true] - Persist preference to persistent storage
     */
    setDisplayScale(scale, save = true) {
        this._displayScale = String(scale);

        if (save) {
            storage.setItem('pref:displayScale', this._displayScale);
        }

        this._applyDisplayScale();
        eventBus.emit('displayScale:changed', { scale: this._displayScale });
    }

    /**
     * ========================================================================
     * Display Scaling Engine (Unified Across Desktop, Mobile & TV)
     * ========================================================================
     * Computes and applies full-bleed CSS zoom scaling to the application canvas.
     * Supports:
     * 1. Mobile Portrait: 750px base design width scaled proportionally down to MIN_SCALE (0.15)
     *    and multiplied by the user's Display Scale option. Stamping data-litefin-portrait
     *    and data-litefin-scaled for mobile navigation and layout adaptations.
     * 2. Mobile Landscape: 1600px base design width scaled proportionally and multiplied
     *    by the user's Display Scale option.
     * 3. Desktop / Web Wide: Fits 1080p canvas with auto scale or user manual scale factor.
     * 4. Dedicated TV: 1:1 unscaled framebuffer by default or user manual scale factor.
     *
     * Counter-expands root and container bounds (--litefin-app-w and --litefin-app-h)
     * so that fixed and backdrop elements span 100% of the viewport with zero letterboxing.
     * @private
     */
    _applyDisplayScale() {
        if (typeof document === 'undefined' || typeof window === 'undefined') return;

        const root = document.documentElement;
        const appEl = document.getElementById('app');
        if (!root) return;

        // Dedicated television environments run at fixed 1080p framebuffer.
        // platformInfo.isTv comprehensively evaluates Samsung Tizen, LG webOS,
        // and Android TV / Google TV runtimes (native bridge isTv calls and UA tokens).
        const isNativeTv = platformInfo.isTv;

        // Resolve user display scale multiplier from settings ('auto' => 1.0, '0.8' => 0.8, etc.)
        const userMultiplier = this._displayScale === 'auto' ? 1.0 : parseFloat(this._displayScale) || 1.0;

        if (isNativeTv) {
            // Television panels run natively at 1:1 scale unless user sets manual factor
            const tvScale = userMultiplier;
            if (Math.abs(tvScale - 1.0) < 0.02) {
                // Return to natural unzoomed 1:1 pixel grid
                root.style.removeProperty('zoom');
                root.removeAttribute('data-display-scale');
            } else {
                // Apply user-selected television display zoom factor
                root.style.setProperty('zoom', String(tvScale));
                root.setAttribute('data-display-scale', '1');
            }
            // Strip mobile-specific responsive attributes on television hardware
            root.removeAttribute('data-litefin-portrait');
            root.removeAttribute('data-litefin-scaled');
            root.removeAttribute('data-litefin-touch');
            root.style.removeProperty('--litefin-app-w');
            root.style.removeProperty('--litefin-app-h');
            if (appEl) {
                appEl.style.removeProperty('width');
                appEl.style.removeProperty('height');
            }
            return;
        }

        // Detect touch capability to stamp touch indicators across platforms
        const hasTouch =
            platformInfo.isAndroid ||
            'ontouchstart' in window ||
            (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0);
        if (hasTouch) {
            root.setAttribute('data-litefin-touch', '1');
        }

        const winW = window.innerWidth || 1920;
        const winH = window.innerHeight || 1080;
        const isPortrait = winH > winW;
        const isAndroidMobile = platformInfo.isAndroid && !platformInfo.isAndroidTv;
        const isNarrowViewport = winW <= 1000;
        const isMobileMode = isAndroidMobile || isPortrait || isNarrowViewport;

        const MIN_SCALE = 0.15;
        const MAX_SCALE = 2.0;

        if (isPortrait) {
            // ================================================================
            // 1. Mobile Portrait UI Scaling Mode
            // ================================================================
            // Stamp portrait marker attributes for mobile nav and vertical CSS layouts
            const hadPortrait = root.hasAttribute('data-litefin-portrait');
            root.setAttribute('data-litefin-portrait', '1');
            root.setAttribute('data-litefin-scaled', '1');
            if (!hadPortrait) {
                eventBus.emit('viewport:orientationChange', { isPortrait: true });
            }

            const PORTRAIT_DESIGN_WIDTH = 750;
            // Proportional base scale to fit 750px portrait layout into current window width
            const baseScale = Math.min(1.0, Math.max(MIN_SCALE, winW / PORTRAIT_DESIGN_WIDTH));
            // Apply user display scale multiplier from settings
            const finalScale = Math.min(
                MAX_SCALE,
                Math.max(MIN_SCALE, Math.round(baseScale * userMultiplier * 1000) / 1000)
            );

            // Compute counter-expanded virtual bounds for full-bleed mobile display
            const designW = `${Math.round(winW / finalScale)}px`;
            const designH = `${Math.round(winH / finalScale)}px`;

            root.style.setProperty('zoom', String(finalScale));
            root.setAttribute('data-display-scale', '1');
            root.style.setProperty('--litefin-app-w', designW);
            root.style.setProperty('--litefin-app-h', designH);

            if (appEl) {
                appEl.style.width = designW;
                appEl.style.height = designH;
            }

            log.debug(
                `Portrait scale applied: final=${finalScale.toFixed(3)} (base=${baseScale.toFixed(3)} x user=${userMultiplier}) [${winW}x${winH}]`
            );
            return;
        }

        // Viewport is landscape: remove portrait marker if previously set
        if (root.hasAttribute('data-litefin-portrait')) {
            root.removeAttribute('data-litefin-portrait');
            eventBus.emit('viewport:orientationChange', { isPortrait: false });
        }

        if (isMobileMode) {
            // ================================================================
            // 2. Mobile / Tablet Landscape UI Scaling Mode
            // ================================================================
            const LANDSCAPE_DESIGN_WIDTH = 1600;
            // Base scale to fit landscape mobile canvas into physical width
            const baseScale = Math.min(1.0, Math.max(MIN_SCALE, winW / LANDSCAPE_DESIGN_WIDTH));
            // Multiply by user display scale preference
            const finalScale = Math.min(
                MAX_SCALE,
                Math.max(MIN_SCALE, Math.round(baseScale * userMultiplier * 1000) / 1000)
            );

            if (finalScale >= 1.0 && this._displayScale === 'auto' && !isAndroidMobile) {
                // Wide landscape screen at 100% scale
                root.style.removeProperty('zoom');
                root.removeAttribute('data-litefin-scaled');
                root.removeAttribute('data-display-scale');
                root.style.removeProperty('--litefin-app-w');
                root.style.removeProperty('--litefin-app-h');
                if (appEl) {
                    appEl.style.removeProperty('width');
                    appEl.style.removeProperty('height');
                }
            } else {
                const designW = `${Math.round(winW / finalScale)}px`;
                const designH = `${Math.round(winH / finalScale)}px`;

                root.style.setProperty('zoom', String(finalScale));
                root.setAttribute('data-litefin-scaled', '1');
                root.setAttribute('data-display-scale', '1');
                root.style.setProperty('--litefin-app-w', designW);
                root.style.setProperty('--litefin-app-h', designH);

                if (appEl) {
                    appEl.style.width = designW;
                    appEl.style.height = designH;
                }
            }

            log.debug(
                `Landscape mobile scale applied: final=${finalScale.toFixed(3)} (base=${baseScale.toFixed(3)} x user=${userMultiplier}) [${winW}x${winH}]`
            );
            return;
        }

        // ====================================================================
        // 3. Desktop / Web Wide Layout Scaling Mode
        // ====================================================================
        root.removeAttribute('data-litefin-scaled');
        root.style.removeProperty('--litefin-app-w');
        root.style.removeProperty('--litefin-app-h');
        if (appEl) {
            appEl.style.removeProperty('width');
            appEl.style.removeProperty('height');
        }

        let desktopEffectiveScale = 1.0;
        if (this._displayScale === 'auto') {
            const widthScale = winW / 1920;
            const heightScale = winH / 1080;
            const autoScale = Math.min(widthScale, heightScale);
            desktopEffectiveScale = Math.min(1.0, Math.max(0.6, Math.round(autoScale * 100) / 100));
        } else {
            desktopEffectiveScale = userMultiplier;
        }

        if (Math.abs(desktopEffectiveScale - 1.0) < 0.02) {
            root.style.removeProperty('zoom');
            root.removeAttribute('data-display-scale');
        } else {
            root.style.setProperty('zoom', String(desktopEffectiveScale));
            root.setAttribute('data-display-scale', '1');
        }

        log.info(`Desktop display scale applied: mode=${this._displayScale}, effective=${desktopEffectiveScale}`);
    }

    /**
     * Get the active button style configuration
     * @returns {string} One of: 'theme-default', 'theme-inverted', 'monochrome-bw', 'monochrome-wb'
     */
    getButtonStyle() {
        return this._buttonStyle;
    }

    /**
     * Sets the active button style theme and updates HTML attributes immediately.
     * @param {string} style - Selected button style
     * @param {boolean} [save=true] - If true, persist value to localStorage
     */
    setButtonStyle(style, save = true) {
        // Validation check for allowed styles to avoid any UI/rendering inconsistencies
        if (
            ![
                'theme-default',
                'theme-inverted',
                'monochrome-bw',
                'monochrome-wb',
                'white-accent',
                'black-accent',
                'accent-white',
                'accent-black'
            ].includes(style)
        ) {
            log.warn(`Invalid button style type specified: "${style}"`);
            return;
        }

        this._buttonStyle = style;

        // Stamp style attribute on documentElement so CSS engines can adapt immediately
        document.documentElement.setAttribute('data-button-style', style);

        // Store preferred settings value
        if (save) {
            storage.setItem('litefin:buttonStyle', style);
        }

        log.info(`Button style configuration successfully updated to: ${style}`);

        // Notify any active UI observers that button style changed
        eventBus.emit('buttonStyle:changed', { style });
    }

    getHideUnfocusedBorders() {
        return this._hideUnfocusedBorders;
    }

    setHideUnfocusedBorders(hide, save = true) {
        this._hideUnfocusedBorders = hide;
        document.documentElement.setAttribute('data-hide-unfocused-borders', hide ? 'true' : 'false');
        if (save) {
            storage.setItem('litefin:hideUnfocusedBorders', hide ? 'true' : 'false');
        }
        log.info(`Hide unfocused borders updated: ${hide}`);
        eventBus.emit('hideUnfocusedBorders:changed', { hide });
    }

    getFocusBorderStyle() {
        return this._focusBorderStyle;
    }

    setFocusBorderStyle(style, save = true) {
        if (!['follow-theme', 'inverted', 'white', 'black', 'hidden'].includes(style)) {
            log.warn(`Invalid focus border style specified: "${style}"`);
            return;
        }
        this._focusBorderStyle = style;
        document.documentElement.setAttribute('data-focus-border-style', style);
        if (save) {
            storage.setItem('litefin:focusBorderStyle', style);
        }
        log.info(`Focus border style updated: ${style}`);
        eventBus.emit('focusBorderStyle:changed', { style });
    }

    getHoverBorderStyle() {
        return this._hoverBorderStyle;
    }

    setHoverBorderStyle(style, save = true) {
        if (!['follow-theme', 'inverted', 'white', 'black', 'hidden'].includes(style)) {
            log.warn(`Invalid hover border style specified: "${style}"`);
            return;
        }
        this._hoverBorderStyle = style;
        document.documentElement.setAttribute('data-hover-border-style', style);
        if (save) {
            storage.setItem('litefin:hoverBorderStyle', style);
        }
        log.info(`Hover border style updated: ${style}`);
        eventBus.emit('hoverBorderStyle:changed', { style });
    }

    getSidebarUnselectedColor() {
        return this._sidebarUnselectedColor;
    }

    setSidebarUnselectedColor(color, save = true) {
        if (!['grey', 'white', 'black', 'accent'].includes(color)) {
            log.warn(`Invalid sidebar unselected color specified: "${color}"`);
            return;
        }
        this._sidebarUnselectedColor = color;
        document.documentElement.setAttribute('data-sidebar-unselected-color', color);
        if (save) {
            storage.setItem('litefin:sidebarUnselectedColor', color);
        }
        log.info(`Sidebar unselected color updated: ${color}`);
        eventBus.emit('sidebarUnselectedColor:changed', { color });
    }

    getSidebarSelectedColor() {
        return this._sidebarSelectedColor;
    }

    setSidebarSelectedColor(color, save = true) {
        if (!['grey', 'white', 'black', 'accent'].includes(color)) {
            log.warn(`Invalid sidebar selected color specified: "${color}"`);
            return;
        }
        this._sidebarSelectedColor = color;
        document.documentElement.setAttribute('data-sidebar-selected-color', color);
        if (save) {
            storage.setItem('litefin:sidebarSelectedColor', color);
        }
        log.info(`Sidebar selected color updated: ${color}`);
        eventBus.emit('sidebarSelectedColor:changed', { color });
    }

    getSidebarLogoColor() {
        return this._sidebarLogoColor;
    }

    setSidebarLogoColor(color, save = true) {
        if (!['icon-colors', 'follow-theme', 'white', 'black'].includes(color)) {
            log.warn(`Invalid sidebar logo color specified: "${color}"`);
            return;
        }
        this._sidebarLogoColor = color;
        document.documentElement.setAttribute('data-sidebar-logo-color', color);
        if (save) {
            storage.setItem('litefin:sidebarLogoColor', color);
        }
        log.info(`Sidebar logo color updated: ${color}`);
        eventBus.emit('sidebarLogoColor:changed', { color });
    }

    /**
     * =========================================================================
     * SIDEBAR ICON SHADOWS CONFIGURATION
     * =========================================================================
     * Retrieves whether drop shadows are currently enabled for all icons
     * rendered inside the primary sidebar navigation container.
     *
     * @returns {boolean} True if icon shadows are enabled, false if flat.
     * =========================================================================
     */
    getSidebarIconShadows() {
        return Boolean(this._sidebarIconShadows);
    }

    /**
     * =========================================================================
     * Set Sidebar Icon Shadows
     * =========================================================================
     * Configures whether drop shadows should be displayed across all sidebar
     * icons including navigation buttons, brand header logo, back button capsule,
     * and user profile avatar.
     *
     * @param {boolean|string} enabled - Desired shadow state ('true'/'shadow'/boolean)
     * @param {boolean} [save=true] - Whether to persist choice to local storage
     * =========================================================================
     */
    setSidebarIconShadows(enabled, save = true) {
        // Resolve boolean state from boolean or string value
        const isEnabled = enabled === true || enabled === 'true' || enabled === 'shadow';
        this._sidebarIconShadows = isEnabled;

        // Apply attribute to root document element for reactive CSS rules
        document.documentElement.setAttribute('data-sidebar-icon-shadows', isEnabled ? 'true' : 'false');

        // Persist preference to persistent local storage when requested
        if (save) {
            storage.setItem('litefin:sidebarIconShadows', isEnabled ? 'true' : 'false');
            storage.setItem('pref:sidebarIconShadows', isEnabled ? 'true' : 'false');
            storage.flush();
        }

        log.info(`Sidebar icon shadows set to: ${isEnabled}`);

        // Broadcast notifications across event bus for live reactive components
        eventBus.emit('sidebarIconShadows:changed', { enabled: isEnabled });
        eventBus.emit('pref:sidebarIconShadows', isEnabled);
    }

    getOsdButtonStyle() {
        return this._osdButtonStyle;
    }

    setOsdButtonStyle(style, save = true) {
        if (
            ![
                'follow-global',
                'theme-default',
                'theme-inverted',
                'monochrome-bw',
                'monochrome-wb',
                'white-accent',
                'black-accent',
                'accent-white',
                'accent-black'
            ].includes(style)
        ) {
            log.warn(`Invalid OSD button style specified: "${style}"`);
            return;
        }
        this._osdButtonStyle = style;
        document.documentElement.setAttribute('data-osd-button-style', style);
        if (save) {
            storage.setItem('litefin:osdButtonStyle', style);
        }
        log.info(`OSD button style updated: ${style}`);
        eventBus.emit('osdButtonStyle:changed', { style });
    }

    getOsdFocusBorderStyle() {
        return this._osdFocusBorderStyle;
    }

    setOsdFocusBorderStyle(style, save = true) {
        if (!['follow-global', 'follow-theme', 'inverted', 'white', 'black', 'hidden'].includes(style)) {
            log.warn(`Invalid OSD focus border style specified: "${style}"`);
            return;
        }
        this._osdFocusBorderStyle = style;
        document.documentElement.setAttribute('data-osd-focus-border-style', style);
        if (save) {
            storage.setItem('litefin:osdFocusBorderStyle', style);
        }
        log.info(`OSD focus border style updated: ${style}`);
        eventBus.emit('osdFocusBorderStyle:changed', { style });
    }

    getOsdButtonShape() {
        return this._osdButtonShape;
    }

    setOsdButtonShape(shape, save = true) {
        if (
            !['circle', 'rounded-square', 'squircle', 'organic-leaf', 'hexagon', 'outline', 'icon-only'].includes(shape)
        ) {
            log.warn(`Invalid OSD button shape specified: "${shape}"`);
            return;
        }
        this._osdButtonShape = shape;
        document.documentElement.setAttribute('data-osd-button-shape', shape);
        if (save) {
            storage.setItem('litefin:osdButtonShape', shape);
        }
        log.info(`OSD button shape updated: ${shape}`);
        eventBus.emit('osdButtonShape:changed', { shape });
    }

    getOsdUnfocusedButtonStyle() {
        return this._osdUnfocusedButtonStyle;
    }

    setOsdUnfocusedButtonStyle(style, save = true) {
        if (!['icon-only', 'outline', 'semi-transparent'].includes(style)) {
            log.warn(`Invalid OSD unfocused button style specified: "${style}"`);
            return;
        }
        this._osdUnfocusedButtonStyle = style;
        document.documentElement.setAttribute('data-osd-unfocused-button-style', style);
        if (save) {
            storage.setItem('litefin:osdUnfocusedButtonStyle', style);
        }
        log.info(`OSD unfocused button style updated: ${style}`);
        eventBus.emit('osdUnfocusedButtonStyle:changed', { style });
    }

    /*
     * Retrieves the current customized color scheme of the OSD seek bar thumb.
     */
    getOsdSeekBarThumbColor() {
        return this._osdSeekBarThumbColor;
    }

    /*
     * Sets the customized color scheme of the OSD seek bar thumb.
     * Stamps documentElement with data-osd-thumb-color so that player-osd.css can adapt.
     */
    setOsdSeekBarThumbColor(color, save = true) {
        if (!['white', 'black', 'theme-accent', 'theme-inverted'].includes(color)) {
            log.warn(`Invalid OSD seek bar thumb color specified: "${color}"`);
            return;
        }
        this._osdSeekBarThumbColor = color;
        document.documentElement.setAttribute('data-osd-thumb-color', color);
        if (save) {
            storage.setItem('litefin:osdSeekBarThumbColor', color);
        }
        log.info(`OSD seek bar thumb color updated: ${color}`);
        eventBus.emit('osdSeekBarThumbColor:changed', { color });
    }

    /*
     * Retrieves the current customized color scheme of the OSD seek bar progress.
     */
    getOsdSeekBarProgressColor() {
        return this._osdSeekBarProgressColor;
    }

    /*
     * Sets the customized color scheme of the OSD seek bar progress.
     * Stamps documentElement with data-osd-progress-color so that player-osd.css can adapt.
     */
    setOsdSeekBarProgressColor(color, save = true) {
        if (!['white', 'black', 'theme-accent', 'theme-inverted'].includes(color)) {
            log.warn(`Invalid OSD seek bar progress color specified: "${color}"`);
            return;
        }
        this._osdSeekBarProgressColor = color;
        document.documentElement.setAttribute('data-osd-progress-color', color);
        if (save) {
            storage.setItem('litefin:osdSeekBarProgressColor', color);
        }
        log.info(`OSD seek bar progress color updated: ${color}`);
        eventBus.emit('osdSeekBarProgressColor:changed', { color });
    }

    /**
     * Enable or disable Low VRAM Mode
     * @param {boolean} enabled
     * @param {boolean} [save=true]
     */
    setLowVramMode(enabled, save = true) {
        this._lowVramMode = enabled;

        if (enabled) {
            document.documentElement.setAttribute('data-low-vram', 'true');
        } else {
            document.documentElement.removeAttribute('data-low-vram');
        }

        if (save) {
            storage.setItem('litefin:lowVramMode', enabled ? 'true' : 'false');
        }

        log.info(`Low VRAM Mode set to: ${enabled}`);
        eventBus.emit('lowVramMode:changed', { enabled });
    }

    getLowVramMode() {
        return this._lowVramMode;
    }

    /**
     * Enable or disable Card Scaling
     * @param {boolean} enabled
     * @param {boolean} [save=true]
     */
    setDisableCardScaling(enabled, save = true) {
        this._disableCardScaling = enabled;

        if (enabled) {
            document.documentElement.setAttribute('data-disable-card-scaling', 'true');
        } else {
            document.documentElement.removeAttribute('data-disable-card-scaling');
        }

        if (save) {
            storage.setItem('litefin:disableCardScaling', enabled ? 'true' : 'false');
        }

        log.info(`Disable Card Scaling set to: ${enabled}`);
        eventBus.emit('disableCardScaling:changed', { enabled });
    }

    getDisableCardScaling() {
        return this._disableCardScaling;
    }

    /**
     * Enable or disable Simple Loader (Legacy compatibility wrapper).
     * Maps boolean state to loader visual style ('ring' vs 'dots').
     *
     * @param {boolean} enabled
     * @param {boolean} [save=true]
     */
    setSimpleLoader(enabled, save = true) {
        // Delegate directly to setLoaderStyle to preserve single source of truth
        this.setLoaderStyle(enabled ? 'ring' : 'dots', save);
    }

    /**
     * Retrieve simple loader boolean status for legacy consumers.
     * @returns {boolean}
     */
    getSimpleLoader() {
        return this._loaderStyle === 'ring';
    }

    /**
     * Set loading indicator visual presentation style.
     *
     * @param {string} style - The identifier of the loader style ('dots' | 'ring')
     * @param {boolean} [save=true] - Whether to persist choice to storage
     */
    setLoaderStyle(style, save = true) {
        // Validate input against supported styles list with safe fallback to 'dots'
        // Supported styles:
        // - 'dots': Original dual pulsing dots
        // - 'ring': Minimal rotating circular track
        // - 'dual-ring': Concentric ring with accent outer arc
        // - 'orbit': Translucent ring with traveling accent satellite bead
        // - 'satellite': Inner accent ring with orbiting secondary ring
        // - 'triple-ring': Multi-tiered concentric counter-rotating ring arcs
        // - 'dotted-ring': Dual-tone alternating dashed/dotted spinning ring
        // - 'eclipse-sweep': Inset crescent shadow sweep animation
        // - 'sonar-ring': Rotating framed disc with opposing aperture arcs
        // - 'push-pulse': Concentric dual-phase pulsing spheres
        // - 'horizontal-dots': Trio of fading inline dots with wave progression
        // - 'pulsing-grid': Dynamic 4-point rotating and morphing quadrant grid
        const validStyle = [
            'dots',
            'ring',
            'dual-ring',
            'orbit',
            'satellite',
            'triple-ring',
            'dotted-ring',
            'eclipse-sweep',
            'sonar-ring',
            'push-pulse',
            'horizontal-dots',
            'pulsing-grid'
        ].includes(style)
            ? style
            : 'dots';
        this._loaderStyle = validStyle;

        // Stamp active loader style attribute onto root element for scoped CSS targeting
        document.documentElement.setAttribute('data-loader-style', validStyle);

        // Keep backwards compatibility with legacy simpleLoader attribute & internal state
        const isLegacyRing = validStyle === 'ring';
        this._simpleLoader = isLegacyRing;
        if (isLegacyRing) {
            document.documentElement.setAttribute('data-simple-loader', 'true');
        } else {
            document.documentElement.removeAttribute('data-simple-loader');
        }

        // Persist preferences if save is requested
        if (save) {
            storage.setItem('litefin:loaderStyle', validStyle);
            storage.setItem('litefin:simpleLoader', isLegacyRing ? 'true' : 'false');
        }

        log.info(`Loading indicator style set to: ${validStyle}`);

        // Broadcast change events to subscribers
        eventBus.emit('loaderStyle:changed', { style: validStyle });
        eventBus.emit('simpleLoader:changed', { enabled: isLegacyRing });
    }

    /**
     * Retrieve the current loading indicator visual style.
     * @returns {string}
     */
    getLoaderStyle() {
        return this._loaderStyle;
    }

    /**
     * Disable or enable BlurHash Placeholders
     * Toggles whether color-accurate blurred canvases are initialized on lazy media cards.
     *
     * @param {boolean} disabled - True to disable canvases; false to enable them.
     * @param {boolean} [save=true] - Persist the preference locally.
     * @public
     */
    setDisableBlurhash(disabled, save = true) {
        // Update local property tracking
        this._disableBlurhash = disabled;

        // Write the HTML attribute flag so that stylesheets and card rendering can adapt
        if (disabled) {
            document.documentElement.setAttribute('data-disable-blurhash', 'true');
        } else {
            document.documentElement.removeAttribute('data-disable-blurhash');
        }

        // Persist setting inside the StorageService database
        if (save) {
            storage.setItem('litefin:disableBlurhash', disabled ? 'true' : 'false');
        }

        // Dispatch status updates to observers and listeners
        log.info(`Disable BlurHash set to: ${disabled}`);
        eventBus.emit('disableBlurhash:changed', { disabled });
    }

    /**
     * Check if BlurHash placeholders are globally disabled.
     * Used by card renderers to determine element injection.
     *
     * @returns {boolean} True if disabled; false otherwise.
     * @public
     */
    getDisableBlurhash() {
        return this._disableBlurhash;
    }

    /**
     * Disable or enable BlurHash placeholder rendering specifically in library grids.
     * When disabled (true), cards in the library skip canvas generation and DCT decoding,
     * relying on lightweight CSS background skeletons to ensure maximum framerate and fluidity.
     *
     * @param {boolean} disabled - True to disable library BlurHash; false to enable.
     * @param {boolean} [save=true] - Whether to persist the setting to storage.
     * @public
     */
    setDisableLibraryBlurhash(disabled, save = true) {
        // Track the updated preference state in memory
        this._disableLibraryBlurhash = disabled;

        // Apply HTML attribute flag to document root for stylesheet selector optimization
        if (disabled) {
            document.documentElement.setAttribute('data-disable-library-blurhash', 'true');
        } else {
            document.documentElement.removeAttribute('data-disable-library-blurhash');
        }

        // Persist setting inside the StorageService database
        if (save) {
            storage.setItem('pref:disableLibraryBlurhash', disabled ? 'true' : 'false');
        }

        // Invalidate card HTML cache so cards refresh instantly on navigation or re-render
        CardRenderer.clearCache();

        // Dispatch status update event to notify any interested subscribers
        log.info(`Disable Library BlurHash set to: ${disabled}`);
        eventBus.emit('disableLibraryBlurhash:changed', { disabled });
    }

    /**
     * Retrieve the current preference state for disabling BlurHash in library grids.
     * Defaults to true unless explicitly toggled off by the user.
     *
     * @returns {boolean} True if BlurHash is disabled in library grids; false otherwise.
     * @public
     */
    getDisableLibraryBlurhash() {
        return this._disableLibraryBlurhash;
    }

    /**
     * Set onlyBlurHashBackdrop setting
     *
     * @param {boolean} only - True to use only BlurHash for Details Backdrop; false to load backdrop image too.
     * @param {boolean} [save=true] - Persist the preference locally.
     * @public
     */
    setOnlyBlurHashBackdrop(only, save = true) {
        this._onlyBlurHashBackdrop = only;

        if (only) {
            document.documentElement.setAttribute('data-only-blurhash-backdrop', 'true');
        } else {
            document.documentElement.removeAttribute('data-only-blurhash-backdrop');
        }

        if (save) {
            storage.setItem('litefin:onlyBlurHashBackdrop', only ? 'true' : 'false');
        }

        log.info(`Only BlurHash Backdrop set to: ${only}`);
        eventBus.emit('onlyBlurHashBackdrop:changed', { only });
    }

    /**
     * Get onlyBlurHashBackdrop setting value
     *
     * @returns {boolean}
     * @public
     */
    getOnlyBlurHashBackdrop() {
        return this._onlyBlurHashBackdrop;
    }

    /**
     * Set lightMusicPlayer setting.
     * When enabled, disables blur and shadows in the music player for enhanced performance on older TVs.
     *
     * @param {boolean} enabled - True to disable blur and shadows in music player; false for full visuals.
     * @param {boolean} [save=true] - Persist the preference locally.
     * @public
     */
    setLightMusicPlayer(enabled, save = true) {
        this._lightMusicPlayer = !!enabled;

        // Apply attribute on root html element for instant global CSS styling
        if (this._lightMusicPlayer) {
            document.documentElement.setAttribute('data-light-music-player', 'true');
        } else {
            document.documentElement.removeAttribute('data-light-music-player');
        }

        // Persist preference in storage
        if (save) {
            storage.setItem('pref:lightMusicPlayer', this._lightMusicPlayer ? 'true' : 'false');
        }

        log.info(`Light Music Player set to: ${this._lightMusicPlayer}`);
        eventBus.emit('lightMusicPlayer:changed', { enabled: this._lightMusicPlayer });
    }

    /**
     * Get lightMusicPlayer setting value
     *
     * @returns {boolean}
     * @public
     */
    getLightMusicPlayer() {
        return this._lightMusicPlayer;
    }

    /**
     * Get the current hero carousel text vignette contrast level
     *
     * @returns {string} e.g. 'transparent', '10', '20', ... '90'
     * @public
     */
    getHeroVignette() {
        return this._heroVignette;
    }

    /**
     * Set and apply the hero carousel text vignette contrast level
     *
     * @param {string} value - 'transparent' or opacity percentage string ('10' - '90')
     * @param {boolean} [save=true] - Persist the preference locally
     * @public
     */
    setHeroVignette(value, save = true) {
        /*
         * Fallback to default '70' if value is missing or invalid.
         * Default level 70 provides clean text contrast without overly dimming backdrop artwork.
         */
        this._heroVignette = value || '70';
        document.documentElement.setAttribute('data-hero-vignette', this._heroVignette);

        /*
         * Trigger calculation of actual CSS variables on root style sheet
         * so both standard and immersive theme variants receive immediate visual updates.
         */
        this._applyHeroVignetteVariables();

        /*
         * Persist preference locally if save flag is enabled
         */
        if (save) {
            storage.setItem('pref:heroCarouselVignette', this._heroVignette);
        }

        /*
         * Log state change and emit global event to notify active listeners
         */
        log.info(`Hero Carousel Vignette set to: ${this._heroVignette}`);
        eventBus.emit('heroVignette:changed', { value: this._heroVignette });
    }

    /**
     * Calculates and updates the CSS custom properties for the hero vignette gradient
     * on the root element style sheet.
     * @private
     */
    _applyHeroVignetteVariables() {
        /*
         * Default alpha values for level 70
         * Produces a clean ~0.72 start alpha and 0.40 mid-curve.
         */
        let startAlpha = 0.72;
        let midAlpha = 0.4;
        let endAlpha = 0.0;

        /*
         * Handle transparent / 0% explicit override case
         */
        if (this._heroVignette === 'transparent' || this._heroVignette === '0') {
            startAlpha = 0;
            midAlpha = 0;
            endAlpha = 0;
        } else {
            /*
             * Parse user configured percentage string (e.g. '10' through '90')
             */
            const parsed = parseFloat(this._heroVignette);
            if (!isNaN(parsed)) {
                /*
                 * Calibrated perceptual curve:
                 * On TV screens with bright HDR backdrops, linear 0.90 often looks washed out (like ~70%).
                 * When set to 90%, we scale up to 0.96 for a rich, deep cinematic dark shadow behind titles.
                 * When set to 70% (default), we map to 0.72 for clean text contrast without overpowering artwork.
                 */
                if (parsed >= 90) {
                    startAlpha = 0.96;
                    midAlpha = 0.65;
                } else if (parsed >= 80) {
                    startAlpha = 0.84;
                    midAlpha = 0.52;
                } else if (parsed >= 70) {
                    startAlpha = 0.72;
                    midAlpha = 0.4;
                } else {
                    /*
                     * Proportional linear scaling for lower ranges (10% - 60%)
                     */
                    startAlpha = Math.min(Math.max(parsed / 100, 0), 0.7);
                    midAlpha = parseFloat((startAlpha * 0.5).toFixed(3));
                }
                endAlpha = 0.0;
            }
        }

        /*
         * Format RGBA color values for CSS gradient custom properties
         */
        const startRgba = `rgba(0, 0, 0, ${startAlpha})`;
        const midRgba = `rgba(0, 0, 0, ${midAlpha})`;
        const endRgba = `rgba(0, 0, 0, ${endAlpha})`;

        /*
         * Apply custom properties directly on document element for immediate cascade
         */
        document.documentElement.style.setProperty('--hero-vignette-start', startRgba);
        document.documentElement.style.setProperty('--hero-vignette-mid', midRgba);
        document.documentElement.style.setProperty('--hero-vignette-end', endRgba);

        // Notify polyfill for ultra-legacy webviews
        if (cssVarsPolyfill && typeof cssVarsPolyfill.update === 'function') {
            cssVarsPolyfill.update();
        }
    }

    // Component registration (Existing logic maintained)
    registerComponent(name, ClassicComponent, ModernComponent = null) {
        this._components[LAYOUT.CLASSIC].set(name, ClassicComponent);
        this._components[LAYOUT.MODERN].set(name, ModernComponent || ClassicComponent);
    }

    getComponent(name) {
        const layoutComponents = this._components[this._layout];
        return layoutComponents.get(name) || this._components[LAYOUT.CLASSIC].get(name) || null;
    }

    isClassic() {
        return this._loginPageLayout === 'classic';
    }
    isModern() {
        return this._loginPageLayout === 'modern';
    }
    getClassPrefix() {
        return this._loginPageLayout === 'modern' ? 'modern' : 'classic';
    }
    applyLayoutClass(element, baseClass) {
        element.className = `${baseClass} ${this.getClassPrefix()}-${baseClass}`;
    }
}

export const layoutManager = new LayoutManager();
export { LAYOUT, THEME_MODES };
export default LayoutManager;
