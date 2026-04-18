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

        // 1. Scan raw text content of injected <style> tags.
        // This avoids missing vars that fail to parse into CSSOM on Chrome 32.
        const styleTags = document.querySelectorAll('style');

        // Regex to capture variables inside any block
        const varRegex = /(--[^:]+):\s*([^;}]+)/g;

        // Regex for :root blocks
        const rootBlockRegex = /:root[^{]*\{([^}]+)\}/g;

        // Regex for the active [data-theme-mode="..."] block
        const themeBlockRegex = new RegExp('\\[data-theme(?:-mode)?=["\']?' + themeMode + '["\']?\\][^{]*\\{([^}]+)\\}', 'g');

        // ----------------------------------------------------------------
        // Build regexes for ALL other active html[data-*] attributes.
        // e.g. data-rounded-corners="true", data-ui-font="system", etc.
        // The ponyfill never sees these because they aren't :root, so we
        // manually scan their CSS blocks and inject the resolved values.
        // ----------------------------------------------------------------
        const activeAttrRegexes = [];
        const attrs = root.attributes;
        for (let a = 0; a < attrs.length; a++) {
            const attrName  = attrs[a].name;
            const attrValue = attrs[a].value;
            // Only process data-* attributes that have a value and aren't
            // the theme-mode one (already handled above)
            if (
                attrName.indexOf('data-') === 0 &&
                attrName !== 'data-theme-mode' &&
                attrName !== 'data-theme' &&
                attrValue
            ) {
                // Escape any special regex chars in the attribute value
                const escapedValue = attrValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                activeAttrRegexes.push(
                    new RegExp(
                        '\\[' + attrName + '=["\']?' + escapedValue + '["\']?\\][^{]*\\{([^}]+)\\}',
                        'g'
                    )
                );
            }
        }

        for (let i = 0; i < styleTags.length; i++) {
            const cssText = styleTags[i].textContent;
            if (!cssText || cssText.indexOf('--') === -1) continue;

            let match, varMatch;

            // Extract from :root blocks — these are the "global" defaults
            rootBlockRegex.lastIndex = 0;
            while ((match = rootBlockRegex.exec(cssText)) !== null) {
                const blockContent = match[1];
                varRegex.lastIndex = 0;
                while ((varMatch = varRegex.exec(blockContent)) !== null) {
                    vars[varMatch[1].trim()] = varMatch[2].trim();
                }
            }

            // Extract from the active [data-theme-mode="..."] block; these
            // override the :root defaults for theme colors.
            themeBlockRegex.lastIndex = 0;
            while ((match = themeBlockRegex.exec(cssText)) !== null) {
                const blockContent = match[1];
                varRegex.lastIndex = 0;
                while ((varMatch = varRegex.exec(blockContent)) !== null) {
                    vars[varMatch[1].trim()] = varMatch[2].trim();
                }
            }

            // Extract from all other active html[data-*="value"] blocks.
            // This covers data-rounded-corners, data-ui-font, data-layout-tier, etc.
            for (let r = 0; r < activeAttrRegexes.length; r++) {
                const attrRegex = activeAttrRegexes[r];
                attrRegex.lastIndex = 0;
                while ((match = attrRegex.exec(cssText)) !== null) {
                    const blockContent = match[1];
                    varRegex.lastIndex = 0;
                    while ((varMatch = varRegex.exec(blockContent)) !== null) {
                        // These vars win over :root but lose to inline style (step 2)
                        vars[varMatch[1].trim()] = varMatch[2].trim();
                    }
                }
            }
        }

        // 2. Scan variables set directly on <html> inline style.
        // These are written by LayoutManager._applyDynamicTheme() via a
        // <style id="litefin-dynamic-theme-vars"> tag injected into <head>.
        // We also read the root.style directly for any overrides set via JS.
        if (root.style) {
            for (let j = 0; j < root.style.length; j++) {
                const prop = root.style[j];
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
