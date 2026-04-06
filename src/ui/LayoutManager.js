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
    TINTED: 'tinted'
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

        // Current theme mode
        this._themeMode = THEME_MODES.TINTED;

        // Current theme color (HEX)
        this._themeColor = DEFAULT_THEME_COLOR;

        // Current font
        this._uiFont = 'default';

        // Rounded corners setting
        this._roundedCorners = true;

        // Global text scale multiplier
        this._textScale = 1.0;

        // Internal style element for dynamic variables
        this._dynamicStyleEl = null;
    }

    /**
     * Initialize layout manager
     */
    init() {
        // Load saved preferences
        const savedLayout = storage.getItem('litefin:layout') || LAYOUT.CLASSIC;
        
        // Load saved theme mode
        const savedThemeMode = storage.getItem('litefin:themeMode');
        let initialMode = THEME_MODES.TINTED;

        if (savedThemeMode && Object.values(THEME_MODES).includes(savedThemeMode)) {
            initialMode = savedThemeMode;
        }

        log.info(`Loading theme: savedMode="${savedThemeMode}" -> initialMode="${initialMode}"`);
        
        const savedThemeColor = storage.getItem('litefin:themeColor') || this._themeColor;
        const savedUiFont = storage.getItem('litefin:uiFont') || 'default';
        const savedRoundedCorners = storage.getItem('litefin:roundedCorners') !== 'false';
        const savedTextScale = parseFloat(storage.getItem('litefin:textScale') || '1.0');

        this.setLayout(savedLayout, false);
        this.setThemeMode(initialMode, false);
        this.setThemeColor(savedThemeColor, false);
        this.setUiFont(savedUiFont, false);
        this.setRoundedCorners(savedRoundedCorners, false);
        this.setTextScale(savedTextScale, false);

        // Stamp the tier
        document.documentElement.setAttribute('data-layout-tier', platformInfo.layoutTier);

        log.info(
            `Initialized: layout="${this._layout}", mode="${this._themeMode}", color="${this._themeColor}", font="${this._uiFont}"`
        );
    }

    /**
     * Set the current layout
     */
    setLayout(layout, save = true) {
        if (layout !== LAYOUT.CLASSIC && layout !== LAYOUT.MODERN) {
            log.warn(`Invalid layout "${layout}"`);
            return;
        }

        const oldLayout = this._layout;
        this._layout = layout;

        document.documentElement.setAttribute('data-layout', layout);
        state.set('app:layout', layout, true);

        if (save) {
            storage.setItem('litefin:layout', layout);
        }

        if (oldLayout !== layout) {
            log.info(`Layout changed from "${oldLayout}" to "${layout}"`);
            eventBus.emit('layout:changed', { layout, previousLayout: oldLayout });
        }
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
        
        // 1. Build style rules for native and polyfill consumption
        let dynamicCss = `:root {
            --jf-accent: ${accents.accent};
            --jf-accent-rgb: ${accents.accentRgb};
            --jf-accent-hover: ${accents.accentHover};
            --jf-accent-active: ${accents.accentActive};
            --jf-accent-light: ${accents.accentLight};
            --jf-accent-content-color: ${contrastColor};
            --jf-primary-btn-color: ${contrastColor};
            --jf-switch-handle: ${contrastColor};
            --jf-action-btn-active-border: ${contrastColor};
            --jf-button-border-focus: ${contrastColor};
            --jf-focus-border-color: ${accents.accent};`;

        // 2. Clear or apply tinted background variables
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
        }

        dynamicCss += `\n        }`;

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
    getThemeMode() { return this._themeMode; }

    /**
     * Get current theme color
     */
    getThemeColor() { return this._themeColor; }

    // Font and Rounded Corners helpers (Existing logic maintained)
    getUiFont() { return this._uiFont; }
    setUiFont(font, save = true) {
        this._uiFont = font;
        if (font && font !== 'default') document.documentElement.setAttribute('data-ui-font', font);
        else document.documentElement.removeAttribute('data-ui-font');
        if (save) storage.setItem('litefin:uiFont', font);
    }

    getRoundedCorners() { return this._roundedCorners; }
    setRoundedCorners(enabled, save = true) {
        this._roundedCorners = enabled;
        document.documentElement.setAttribute('data-rounded-corners', enabled ? 'true' : 'false');
        if (save) storage.setItem('litefin:roundedCorners', enabled ? 'true' : 'false');
        eventBus.emit('roundedCorners:changed', { enabled });
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

    // Component registration (Existing logic maintained)
    registerComponent(name, ClassicComponent, ModernComponent = null) {
        this._components[LAYOUT.CLASSIC].set(name, ClassicComponent);
        this._components[LAYOUT.MODERN].set(name, ModernComponent || ClassicComponent);
    }

    getComponent(name) {
        const layoutComponents = this._components[this._layout];
        return layoutComponents.get(name) || this._components[LAYOUT.CLASSIC].get(name) || null;
    }

    isClassic() { return this._layout === LAYOUT.CLASSIC; }
    isModern() { return this._layout === LAYOUT.MODERN; }
    getClassPrefix() { return this._layout === LAYOUT.MODERN ? 'modern' : 'classic'; }
    applyLayoutClass(element, baseClass) {
        element.className = `${baseClass} ${this.getClassPrefix()}-${baseClass}`;
    }
}

export const layoutManager = new LayoutManager();
export { LAYOUT, THEME_MODES };
export default LayoutManager;
