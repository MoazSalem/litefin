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

import { debugOverlay } from './DebugOverlay.js';

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
    AMBIENT: 'ambient'
};

// Default Theme Color (Lavender)
const DEFAULT_THEME_COLOR = '#af52de';

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
        this._mediaRowsLayout = 'classic';
        this._loginPageLayout = 'classic';

        // Current theme mode
        // Ambient Glow is now the default theme mode for a premium glassmorphic look.
        this._themeMode = THEME_MODES.AMBIENT;

        // Current theme color (HEX)
        this._themeColor = DEFAULT_THEME_COLOR;

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

        // Disable BlurHash: Disables color-accurate blurred canvas rendering during image load
        this._disableBlurhash = false;

        // Only BlurHash Backdrop: Uses only decoded blurhash for details backdrop background without loading image
        this._onlyBlurHashBackdrop = false;

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
        this._sidebarSelectedColor = 'accent';

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

        // Internal style element for dynamic variables
        this._dynamicStyleEl = null;
    }

    /**
     * Initialize layout manager
     */
    init() {
        // Load saved preferences
        let savedMediaRowsLayout = storage.getItem('pref:mediaRowsLayout');
        if (!savedMediaRowsLayout) {
            const legacy = storage.getItem('pref:modernMediaRows') || storage.getItem('litefin:layout');
            savedMediaRowsLayout = legacy === 'true' || legacy === 'modern' ? 'modern' : 'classic';
        }

        let savedLoginPageLayout = storage.getItem('pref:loginPageLayout');
        if (!savedLoginPageLayout) {
            const legacy = storage.getItem('pref:modernLoginPage') || storage.getItem('litefin:layout');
            savedLoginPageLayout = legacy === 'true' || legacy === 'modern' ? 'modern' : 'classic';
        }

        // Load saved theme mode
        const savedThemeMode = storage.getItem('litefin:themeMode');
        // Default to Ambient theme mode if no user preference is stored.
        let initialMode = THEME_MODES.AMBIENT;

        if (savedThemeMode && Object.values(THEME_MODES).includes(savedThemeMode)) {
            initialMode = savedThemeMode;
        }

        log.info(`Loading theme: savedMode="${savedThemeMode}" -> initialMode="${initialMode}"`);

        const savedThemeColor = storage.getItem('litefin:themeColor') || this._themeColor;
        const savedUiFont = storage.getItem('litefin:uiFont') || 'default';
        const savedRoundedCorners = storage.getItem('litefin:roundedCorners') !== 'false';
        const savedTextScale = parseFloat(storage.getItem('litefin:textScale') || '1.0');

        const savedLowVram = storage.getItem('litefin:lowVramMode') === 'true';
        const savedDisableScaling = storage.getItem('litefin:disableCardScaling') === 'true';
        const savedSimpleLoader = storage.getItem('litefin:simpleLoader') === 'true';
        const savedDisableBlurhash = storage.getItem('litefin:disableBlurhash') === 'true';
        const savedOnlyBlurHashBackdrop = storage.getItem('litefin:onlyBlurHashBackdrop') === 'true';
        const savedBadgeStyle = storage.getItem('litefin:badgeStyle') || 'auto';
        const savedCardLabelScale = parseFloat(storage.getItem('pref:cardLabelScale') || '1.0');

        // Load user preferred button customization style
        const savedButtonStyle = storage.getItem('litefin:buttonStyle') || 'theme-default';
        const savedHideUnfocusedBorders = storage.getItem('litefin:hideUnfocusedBorders') === 'true';
        const savedFocusBorderStyle = storage.getItem('litefin:focusBorderStyle') || 'hidden';
        const savedHoverBorderStyle = storage.getItem('litefin:hoverBorderStyle') || 'white';
        const savedSidebarUnselectedColor = storage.getItem('litefin:sidebarUnselectedColor') || 'grey';
        const savedSidebarSelectedColor = storage.getItem('litefin:sidebarSelectedColor') || 'accent';
        const savedOsdButtonStyle = storage.getItem('litefin:osdButtonStyle') || 'follow-global';
        const savedOsdFocusBorderStyle = storage.getItem('litefin:osdFocusBorderStyle') || 'follow-global';
        const savedOsdButtonShape = storage.getItem('litefin:osdButtonShape') || 'circle';
        const savedOsdUnfocusedButtonStyle = storage.getItem('litefin:osdUnfocusedButtonStyle') || 'icon-only';
        const savedOsdSeekBarThumbColor = storage.getItem('litefin:osdSeekBarThumbColor') || 'white';
        const savedOsdSeekBarProgressColor = storage.getItem('litefin:osdSeekBarProgressColor') || 'theme-accent';

        this.setMediaRowsLayout(savedMediaRowsLayout, false);
        this.setLoginPageLayout(savedLoginPageLayout, false);
        this.setThemeMode(initialMode, false);
        this.setThemeColor(savedThemeColor, false);
        this.setUiFont(savedUiFont, false);
        this.setRoundedCorners(savedRoundedCorners, false);
        this.setTextScale(savedTextScale, false);
        this.setCardLabelScale(savedCardLabelScale, false);

        this.setLowVramMode(savedLowVram, false);
        this.setDisableCardScaling(savedDisableScaling, false);
        this.setSimpleLoader(savedSimpleLoader, false);
        this.setDisableBlurhash(savedDisableBlurhash, false);
        this.setOnlyBlurHashBackdrop(savedOnlyBlurHashBackdrop, false);
        this.setBadgeStyle(savedBadgeStyle, false);

        // Initial setup for the button styling scheme
        this.setButtonStyle(savedButtonStyle, false);
        this.setHideUnfocusedBorders(savedHideUnfocusedBorders, false);
        this.setFocusBorderStyle(savedFocusBorderStyle, false);
        this.setHoverBorderStyle(savedHoverBorderStyle, false);
        this.setSidebarUnselectedColor(savedSidebarUnselectedColor, false);
        this.setSidebarSelectedColor(savedSidebarSelectedColor, false);
        this.setOsdButtonStyle(savedOsdButtonStyle, false);
        this.setOsdFocusBorderStyle(savedOsdFocusBorderStyle, false);
        this.setOsdButtonShape(savedOsdButtonShape, false);
        this.setOsdUnfocusedButtonStyle(savedOsdUnfocusedButtonStyle, false);
        this.setOsdSeekBarThumbColor(savedOsdSeekBarThumbColor, false);
        this.setOsdSeekBarProgressColor(savedOsdSeekBarProgressColor, false);

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

        // Apply dedicated rendering quirk class/attribute for devices on ancient layout engines
        // (Chrome < 32) such as early LG WebOS 1.x and ancient Samsung Tizen 2.x firmware.
        // This isolates structural layout workarounds (e.g. table-layout / floats / ancient display-box)
        // from the standard ultra-legacy styling layers.
        if (platformInfo.isAncientChrome) {
            document.documentElement.setAttribute('data-layout-quirks', 'c26');
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
        state.set('app:layout', layout, true);
        if (save) {
            storage.setItem('pref:mediaRowsLayout', layout);
        }
        // Update badge style if it is auto
        if (this._badgeStyle === 'auto') {
            const resolvedStyle = layout === 'modern' ? 'dark' : 'tinted';
            document.documentElement.setAttribute('data-badge-style', resolvedStyle);
        }
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
        eventBus.emit('loginPageLayout:changed', { layout });
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
        const accents = themeUtils.getAccentVariants(this._themeColor);
        const contrastColor = themeUtils.getContrastColor(this._themeColor);
        const contrastRgb = themeUtils.hexToRgb(contrastColor);
        const contrastRgbStr = contrastRgb ? `${contrastRgb.r}, ${contrastRgb.g}, ${contrastRgb.b}` : '255, 255, 255';

        // Focus Indicator Logic:
        // If the accent color is "bright" (Luminance > 0.4), the calculated contrast color
        // (normally for text) is very dark. Since most themes are dark, a dark focus border
        // would be invisible. We use a soft light variant for focus borders in these cases.
        const isBrightAccent = themeUtils.isBright(this._themeColor);
        const focusBorderColor = isBrightAccent ? themeUtils.getSoftLight(this._themeColor) : contrastColor;

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

        // 1.5. Set Text Colors (Ensures ultra-legacy build always has stable text vars)
        // Only inject base text colors if NOT tinted. Tinted mode handles its own
        // transparent text colors in tinted.css, which we shouldn't override globally.
        if (this._themeMode !== THEME_MODES.TINTED) {
            const isLight = this._themeMode === THEME_MODES.CLASSIC_LIGHT;
            dynamicCss += `
            --jf-text-primary: ${isLight ? '#101010' : '#ffffff'};
            --jf-text-secondary: ${isLight ? '#666666' : 'rgba(255, 255, 255, 0.8)'};
            --jf-text-tertiary: ${isLight ? '#888888' : '#666666'};
            
            --text-primary: var(--jf-text-primary);
            --text-secondary: var(--jf-text-secondary);
            --text-muted: var(--jf-text-secondary);`;
        } else {
            // For tinted mode, just pass through the custom aliases
            dynamicCss += `
            --text-primary: var(--jf-text-primary);
            --text-secondary: var(--jf-text-secondary);
            --text-muted: var(--jf-text-secondary);`;
        }

        // 2. Apply background variables based on theme mode
        if (this._themeMode === THEME_MODES.TINTED) {
            const tints = themeUtils.getTintedColors(this._themeColor);
            dynamicCss += `
            --jf-background: ${tints.background};
            --jf-background-alt: ${tints.backgroundAlt};
            --jf-surface: ${tints.surface};
            --jf-card-bg: ${tints.cardBg};
            --jf-card-bg-hover: ${tints.cardBgHover};
            --jf-divider: ${tints.divider};
            --jf-navbar-bg: ${tints.background};`;
        } else if (this._themeMode === THEME_MODES.AMBIENT) {
            // Elegant, matte ultra-dark background.
            // A deeply saturated charcoal canvas serves as the foundation.
            // Translucent material cards absorb the dynamically-cast ambient gradients.
            dynamicCss += `
            --jf-background: #0a0b0c;
            --jf-background-alt: #070809;
            --jf-surface: rgba(255, 255, 255, 0.035);
            --jf-card-bg: rgba(255, 255, 255, 0.045);
            --jf-card-bg-hover: rgba(255, 255, 255, 0.1);
            --jf-divider: rgba(255, 255, 255, 0.06);
            --jf-navbar-bg: rgba(7, 8, 9, 0.85);`;
        } else if (this._themeMode === THEME_MODES.BLACK) {
            dynamicCss += `
            --jf-background: #000000;
            --jf-background-alt: #000000;
            --jf-surface: #0a0a0a;
            --jf-card-bg: #080808;
            --jf-card-bg-hover: #121212;
            --jf-divider: rgba(255, 255, 255, 0.05);
            --jf-navbar-bg: #000000;`;
        } else if (this._themeMode === THEME_MODES.CLASSIC_DARK) {
            dynamicCss += `
            --jf-background: #101010;
            --jf-background-alt: #151515;
            --jf-surface: #1a1a1a;
            --jf-card-bg: #151515;
            --jf-card-bg-hover: #252525;
            --jf-divider: rgba(255, 255, 255, 0.08);
            --jf-navbar-bg: #151515;`;
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
            const resolvedBg = this._themeMode === THEME_MODES.TINTED 
                ? themeUtils.getTintedColors(this._themeColor).background 
                : (this._themeMode === THEME_MODES.AMBIENT ? '#0a0b0c' 
                : (this._themeMode === THEME_MODES.BLACK ? '#000000' 
                : (this._themeMode === THEME_MODES.CLASSIC_LIGHT ? '#f5f5f5' : '#101010')));

            // Write static background-color rule directly to body
            dynamicCss += `\n/* Direct theme overrides for Chrome < 32 */\n`;
            dynamicCss += `html[data-layout-quirks="c26"] body {
                background-color: ${resolvedBg} !important;
            }\n`;

            if (this._themeMode === THEME_MODES.AMBIENT) {
                // Apply vendor-prefixed -webkit-radial-gradient using the calculated accent RGB values
                // coordinates are mapped directly to match the modern CSS radial-gradient spots.
                dynamicCss += `html[data-layout-quirks="c26"][data-theme-mode="ambient"] body {
                    background-image: 
                        -webkit-radial-gradient(85% 15%, circle, rgba(${accents.accentRgb}, 0.30) 0%, rgba(${accents.accentRgb}, 0.10) 35%, transparent 70%),
                        -webkit-radial-gradient(15% 85%, circle, rgba(${accents.accentRgb}, 0.30) 0%, rgba(${accents.accentRgb}, 0.10) 35%, transparent 70%) !important;
                    background-attachment: fixed !important;
                    background-size: cover !important;
                }
                html[data-layout-quirks="c26"][data-theme-mode="ambient"] .page {
                    background: transparent !important;
                }\n`;
            } else {
                // Ensure dynamic gradients from other sessions are cleared
                dynamicCss += `html[data-layout-quirks="c26"] body {
                    background-image: none !important;
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

    // Font and Rounded Corners helpers (Existing logic maintained)
    getUiFont() {
        return this._uiFont;
    }
    setUiFont(font, save = true) {
        this._uiFont = font;
        if (font && font !== 'default') document.documentElement.setAttribute('data-ui-font', font);
        else document.documentElement.removeAttribute('data-ui-font');
        if (save) storage.setItem('litefin:uiFont', font);

        // Load the fallback font dynamically if selected
        if (font === 'fallback-font') {
            import('../utils/FontLoader.js').then((module) => {
                module.default.loadFont('fallback-font');
            });
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
     * Set the global text scale multiplier
     * @param {number} scale Multiplier for the base font size (e.g. 1.2 for 120%)
     * @param {boolean} [save=true]
     */
    setTextScale(scale, save = true) {
        this._textScale = scale;

        // Calculate and apply base font size directly to the root element.
        // Standard base is 16px. Scaling this scales all 'rem' units.
        const pixelSize = 16 * scale;
        document.documentElement.style.fontSize = `${pixelSize}px`;

        if (save) {
            storage.setItem('litefin:textScale', scale.toString());
        }

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
     * Enable or disable Simple Loader
     * @param {boolean} enabled
     * @param {boolean} [save=true]
     */
    setSimpleLoader(enabled, save = true) {
        this._simpleLoader = enabled;

        if (enabled) {
            document.documentElement.setAttribute('data-simple-loader', 'true');
        } else {
            document.documentElement.removeAttribute('data-simple-loader');
        }

        if (save) {
            storage.setItem('litefin:simpleLoader', enabled ? 'true' : 'false');
        }

        log.info(`Simple Loader set to: ${enabled}`);
        eventBus.emit('simpleLoader:changed', { enabled });
    }

    getSimpleLoader() {
        return this._simpleLoader;
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
