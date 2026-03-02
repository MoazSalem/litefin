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

const log = logger.create('LayoutManager');

// Layout constants
const LAYOUT = {
    CLASSIC: 'classic',
    MODERN: 'modern'
};

// Theme constants per layout
const THEMES = {
    [LAYOUT.CLASSIC]: ['dark', 'light', 'blueradiance', 'purplehaze', 'wmc', 'appletv'],
    [LAYOUT.MODERN]: ['dark', 'light']
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

        // Current theme (initialized in init() or constructor fallback)
        this._theme = 'purplehaze';

        // Current font
        this._uiFont = 'default';
    }

    /**
     * Initialize layout manager
     */
    init() {
        // Load saved preferences
        const savedLayout = storage.getItem('litefin:layout') || LAYOUT.CLASSIC;
        const savedTheme = storage.getItem('litefin:theme') || 'purplehaze';
        const savedUiFont = storage.getItem('litefin:uiFont') || 'default';

        this.setLayout(savedLayout, false);
        this.setTheme(savedTheme, false);
        this.setUiFont(savedUiFont, false);

        /*
         * Stamp the CSS layout tier onto <html> so stylesheet rules can branch
         * between CSS Grid (modern) and flex-wrap (legacy) using attribute
         * selectors: html[data-layout-tier="legacy"] { ... }
         *
         * PlatformInfo must be initialized BEFORE LayoutManager.init() for
         * this to reflect the detected Chrome version; otherwise it defaults
         * to 'modern' (safe fallback — grid works on anything Chrome 57+).
         */
        document.documentElement.setAttribute('data-layout-tier', platformInfo.layoutTier);

        log.info(
            `Initialized with layout="${this._layout}", theme="${this._theme}", uiFont="${this._uiFont}", tier="${platformInfo.layoutTier}"`
        );
    }

    /**
     * Get current layout
     * @returns {string} 'classic' or 'modern'
     */
    getLayout() {
        return this._layout;
    }

    /**
     * Set the current layout
     * @param {string} layout - 'classic' or 'modern'
     * @param {boolean} [save=true] - Save to localStorage
     */
    setLayout(layout, save = true) {
        if (layout !== LAYOUT.CLASSIC && layout !== LAYOUT.MODERN) {
            log.warn(`Invalid layout "${layout}"`);
            return;
        }

        const oldLayout = this._layout;
        this._layout = layout;

        // Update HTML attribute for CSS
        document.documentElement.setAttribute('data-layout', layout);

        // Update state
        state.set('app:layout', layout, true);

        // Validate theme for new layout
        // Only validate if theme is already initialized to avoid reset during boot
        if (this._theme && !this.getAvailableThemes().includes(this._theme)) {
            // Reset to dark if current theme not available
            this.setTheme('dark', save);
        }

        // Save preference
        if (save) {
            storage.setItem('litefin:layout', layout);
        }

        // Emit event for components to update
        if (oldLayout !== layout) {
            log.info(`Layout changed from "${oldLayout}" to "${layout}"`);
            eventBus.emit('layout:changed', { layout, previousLayout: oldLayout });
        }
    }

    /**
     * Toggle between layouts
     */
    toggleLayout() {
        const newLayout = this._layout === LAYOUT.CLASSIC ? LAYOUT.MODERN : LAYOUT.CLASSIC;
        this.setLayout(newLayout);
    }

    /**
     * Get current theme
     * @returns {string} Theme name
     */
    getTheme() {
        return this._theme;
    }

    /**
     * Set the current theme
     * @param {string} theme - Theme name
     * @param {boolean} [save=true] - Save to localStorage
     */
    setTheme(theme, save = true) {
        const availableThemes = this.getAvailableThemes();

        if (!availableThemes.includes(theme)) {
            log.warn(`Theme "${theme}" not available for layout "${this._layout}"`);
            return;
        }

        const oldTheme = this._theme;
        this._theme = theme;

        // Update HTML attribute for CSS
        document.documentElement.setAttribute('data-theme', theme);

        /*
         * Re-apply the CSS vars polyfill so it picks up the new theme's
         * custom property values. On Chrome 49+ (Tizen 4.0+) this is a no-op
         * because platformInfo.layoutTier !== 'legacy'.
         */
        cssVarsPolyfill.update();

        // Update state
        state.set('app:theme', theme, true);

        // Save preference
        if (save) {
            storage.setItem('litefin:theme', theme);
        }

        if (oldTheme !== theme) {
            log.info(`Theme changed from "${oldTheme}" to "${theme}"`);
            eventBus.emit('theme:changed', { theme, previousTheme: oldTheme });
        }
    }

    /**
     * Get current UI font
     * @returns {string} Font name
     */
    getUiFont() {
        return this._uiFont;
    }

    /**
     * Set the current UI font
     * @param {string} font - Font name
     * @param {boolean} [save=true] - Save to localStorage
     */
    setUiFont(font, save = true) {
        this._uiFont = font;

        // Update HTML attribute for CSS
        if (font && font !== 'default') {
            document.documentElement.setAttribute('data-ui-font', font);
        } else {
            document.documentElement.removeAttribute('data-ui-font');
        }

        // Save preference
        if (save) {
            storage.setItem('litefin:uiFont', font);
        }

        log.info(`UI Font set to "${font}"`);
    }

    /**
     * Get available themes for current layout
     * @returns {string[]} Array of theme names
     */
    getAvailableThemes() {
        return THEMES[this._layout] || THEMES[LAYOUT.CLASSIC];
    }

    /**
     * Register a component for a specific layout
     * @param {string} name - Component name
     * @param {Function} ClassicComponent - Classic layout component class
     * @param {Function} [ModernComponent] - Modern layout component class (optional)
     */
    registerComponent(name, ClassicComponent, ModernComponent = null) {
        this._components[LAYOUT.CLASSIC].set(name, ClassicComponent);

        if (ModernComponent) {
            this._components[LAYOUT.MODERN].set(name, ModernComponent);
        } else {
            // Fall back to classic if modern not provided
            this._components[LAYOUT.MODERN].set(name, ClassicComponent);
        }

        log.debug(`Registered component "${name}"`);
    }

    /**
     * Get a component class for the current layout
     * @param {string} name - Component name
     * @returns {Function|null} Component class
     */
    getComponent(name) {
        const layoutComponents = this._components[this._layout];

        if (layoutComponents.has(name)) {
            return layoutComponents.get(name);
        }

        // Fallback to classic
        if (this._components[LAYOUT.CLASSIC].has(name)) {
            return this._components[LAYOUT.CLASSIC].get(name);
        }

        log.warn(`Component "${name}" not found`);
        return null;
    }

    /**
     * Check if current layout is classic
     * @returns {boolean} True if classic layout
     */
    isClassic() {
        return this._layout === LAYOUT.CLASSIC;
    }

    /**
     * Check if current layout is modern
     * @returns {boolean} True if modern layout
     */
    isModern() {
        return this._layout === LAYOUT.MODERN;
    }

    /**
     * Get layout-specific CSS class prefix
     * @returns {string} CSS class prefix
     */
    getClassPrefix() {
        return this._layout === LAYOUT.MODERN ? 'modern' : 'classic';
    }

    /**
     * Apply layout-specific class to element
     * @param {HTMLElement} element - Element to style
     * @param {string} baseClass - Base class name
     */
    applyLayoutClass(element, baseClass) {
        element.className = `${baseClass} ${this.getClassPrefix()}-${baseClass}`;
    }
}

// Export singleton instance
export const layoutManager = new LayoutManager();

// Export constants
export { LAYOUT, THEMES };

export default LayoutManager;
