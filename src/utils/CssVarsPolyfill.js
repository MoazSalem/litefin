/**
 * ============================================================================
 * Litefin Tizen - CSS Variables Polyfill Wrapper
 * ============================================================================
 * Wraps css-vars-ponyfill to polyfill CSS custom properties on Tizen 3.0
 * (Chromium 47), where `var()` is not natively supported.
 *
 * IMPORTANT: This module is entirely gated behind the `layoutTier` check.
 * On Tizen 5+ and web (Chrome 49+), CSS vars are native — all calls here
 * return immediately as no-ops and the ponyfill is never executed.
 *
 * Usage:
 *   cssVarsPolyfill.init();    // call once after CSS is loaded
 *   cssVarsPolyfill.update();  // call after every theme change
 * ============================================================================
 */

import cssVars from 'css-vars-ponyfill';
import { logger } from './Logger.js';

const log = logger.create('CssVarsPolyfill');

/**
 * Shared ponyfill options.
 *
 * - `silent: true`      — suppress console noise in production
 * - `updateURLs: false` — don't rewrite relative URLs inside CSS (avoids
 *                         breaking font/image paths when injecting computed CSS)
 * - `watch: false`      — we call update() manually on theme/layout changes
 *                         rather than using MutationObserver (lighter, more
 *                         predictable on TV hardware)
 */
const PONYFILL_OPTIONS = {
    silent: true,
    updateURLs: false,
    watch: false
};

class CssVarsPolyfill {
    constructor() {
        /**
         * True if the ponyfill is active on this device.
         * Evaluated lazily in init() once platformInfo is initialized.
         * @type {boolean}
         */
        this._active = false;
    }

    /**
     * Initialize the polyfill.
     *
     * Call this once after all CSS stylesheets have been injected
     * (i.e. after layoutManager.init()). On Chrome 49+ this is a no-op.
     */
    init() {
        // ----------------------------------------------------------------
        // Use real CSS custom property feature detection instead of a
        // fragile UserAgent / Chrome-version heuristic.
        // window.CSS.supports is itself a CSS4 API — if it doesn't exist,
        // the browser definitely can't handle CSS custom properties natively.
        // Old WebOS / Tizen 2.x WebKit browsers fail this test correctly.
        // ----------------------------------------------------------------
        const nativeCSSVars =
            typeof window.CSS !== 'undefined' &&
            typeof window.CSS.supports === 'function' &&
            window.CSS.supports('--test', '0');

        if (nativeCSSVars) {
            log.debug('Native CSS vars supported — polyfill skipped');
            return;
        }

        this._active = true;
        log.info('CSS vars NOT natively supported — activating ponyfill');

        // ----------------------------------------------------------------
        // Defer the first pass with setTimeout(0).
        // style-loader injects <style> tags lazily as each JS chunk executes.
        // If we run cssVars() synchronously here, the injected stylesheets
        // may not yet be in the DOM so the ponyfill processes nothing.
        // A 0ms timeout defers to after all synchronous chunk evaluation.
        // ----------------------------------------------------------------
        const self = this;
        setTimeout(function() {
            log.debug('Running initial CSS vars ponyfill pass');
            const themeVars = self._extractThemeVariables();
            
            // Provide our scoped variables manually, otherwise the ponyfill
            // ignores our [data-theme-mode="..."] selectors since they aren't :root
            const options = Object.assign({}, PONYFILL_OPTIONS, {
                variables: themeVars
            });
            cssVars(options);
        }, 0);
    }

    /**
     * Re-apply the polyfill after a theme or layout change.
     *
     * LayoutManager.setTheme() calls this after updating the data-theme
     * attribute, so the ponyfill picks up the new [data-theme="..."] vars.
     * On Chrome 49+ this is a no-op.
     */
    update() {
        if (!this._active) return;

        log.debug('Re-applying CSS vars polyfill after theme change');

        const themeVars = this._extractThemeVariables();
        
        // Re-run with the preserved options + updated variables manually extracted
        // from the active theme class ([data-theme-mode="xyz"])
        const options = Object.assign({}, PONYFILL_OPTIONS, {
            variables: themeVars
        });
        cssVars(options);
    }

    /**
     * Extracts CSS variables from the currently active theme.
     * `css-vars-ponyfill` ONLY supports variables defined in `:root` or `:host`.
     * Since Litefin uses `[data-theme-mode="classic-dark"]` for dynamic themes, 
     * the ponyfill ignores our theme variables internally!
     * 
     * We manually extract them from the <style> tags text content and provide
     * them explicitly via the `variables: {}` option.
     * @returns {Object} Map of css variable names to values
     */
    _extractThemeVariables() {
        // Find the active theme explicitly set on HTML tag
        const root = document.documentElement;
        const themeMode = root.getAttribute('data-theme-mode') || 'classic-dark';
        const vars = {};

        // 1. Scan raw text content of injected <style> tags
        // This avoids missing vars that fail to parse into CSSOM on Chrome 32
        const styleTags = document.querySelectorAll('style');
        
        // Regex to capture the block containing the active theme rules
        const themeBlockRegex = new RegExp('\\[data-theme(?:-mode)?=["\']?' + themeMode + '["\']?\\][^{]*\\{([^}]+)\\}', 'g');
        const rootBlockRegex = /:root[^{]*\{([^}]+)\}/g;
        
        // Regex to capture variables inside the block
        const varRegex = /(--[^:]+):\s*([^;}]+)/g;

        for (let i = 0; i < styleTags.length; i++) {
            const cssText = styleTags[i].textContent;
            if (!cssText || cssText.indexOf('--jf-') === -1) continue;

            // Extract from targeted [data-theme-mode="..."]
            let match;
            while ((match = themeBlockRegex.exec(cssText)) !== null) {
                const blockContent = match[1];
                let varMatch;
                while ((varMatch = varRegex.exec(blockContent)) !== null) {
                    vars[varMatch[1].trim()] = varMatch[2].trim();
                }
            }

            // Also extract from any static :root definitions
            while ((match = rootBlockRegex.exec(cssText)) !== null) {
                const blockContent = match[1];
                let varMatch;
                while ((varMatch = varRegex.exec(blockContent)) !== null) {
                    vars[varMatch[1].trim()] = varMatch[2].trim();
                }
            }
        }

        // 2. Scan variables set directly on <html> inline style
        // (LayoutManager uses this to override the accent color dynamically)
        if (root.style) {
            for (let i = 0; i < root.style.length; i++) {
                const prop = root.style[i];
                if (prop && prop.indexOf('--') === 0) {
                    const value = root.style.getPropertyValue(prop);
                    if (value) vars[prop] = value.trim();
                }
            }
        }

        return vars;
    }
}

// Export singleton — one instance for the entire app lifecycle
export const cssVarsPolyfill = new CssVarsPolyfill();
export default CssVarsPolyfill;
