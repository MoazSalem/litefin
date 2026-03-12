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

        this.setLayout(savedLayout, false);
        this.setThemeMode(initialMode, false);
        this.setThemeColor(savedThemeColor, false);
        this.setUiFont(savedUiFont, false);
        this.setRoundedCorners(savedRoundedCorners, false);

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

    /**
     * Internal method to calculate and inject dynamic CSS variables
     */
    _applyDynamicTheme() {
        const root = document.documentElement;
        const accents = themeUtils.getAccentVariants(this._themeColor);
        
        // 1. Apply core accent variables directly to element style
        // This ensures they override any static CSS or index.html boot styles
        root.style.setProperty('--jf-accent', accents.accent);
        root.style.setProperty('--jf-accent-rgb', accents.accentRgb);
        root.style.setProperty('--jf-accent-hover', accents.accentHover);
        root.style.setProperty('--jf-accent-active', accents.accentActive);
        root.style.setProperty('--jf-accent-light', accents.accentLight);
        const contrastColor = themeUtils.getContrastColor(this._themeColor);
        root.style.setProperty('--jf-accent-content-color', contrastColor);
        root.style.setProperty('--jf-primary-btn-color', contrastColor);
        root.style.setProperty('--jf-switch-handle', contrastColor);
        root.style.setProperty('--jf-action-btn-active-border', contrastColor);
        root.style.setProperty('--jf-button-border-focus', contrastColor);
        root.style.setProperty('--jf-focus-border-color', accents.accent);

        // 2. Clear or apply tinted background variables
        if (this._themeMode === THEME_MODES.TINTED) {
            const tints = themeUtils.getTintedColors(this._themeColor);
            root.style.setProperty('--jf-background', tints.background);
            root.style.setProperty('--jf-background-alt', tints.backgroundAlt);
            root.style.setProperty('--jf-surface', tints.surface);
            root.style.setProperty('--jf-card-bg', tints.cardBg);
            root.style.setProperty('--jf-card-bg-hover', tints.cardBgHover);
            root.style.setProperty('--jf-divider', tints.divider);
            root.style.setProperty('--jf-navbar-bg', tints.background);
        } else {
            // Remove tinted variables so theme CSS can take over
            root.style.removeProperty('--jf-background');
            root.style.removeProperty('--jf-background-alt');
            root.style.removeProperty('--jf-surface');
            root.style.removeProperty('--jf-card-bg');
            root.style.removeProperty('--jf-card-bg-hover');
            root.style.removeProperty('--jf-divider');
            root.style.removeProperty('--jf-navbar-bg');
        }

        // Clean up legacy style element if it exists from previous versions
        if (this._dynamicStyleEl) {
            this._dynamicStyleEl.remove();
            this._dynamicStyleEl = null;
        }

        // Polyfill update for legacy Tizen
        cssVarsPolyfill.update();
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
