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
import { platformInfo } from './PlatformInfo.js';
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
        // Only activate on legacy tier (Chrome < 49 / Tizen 3.0)
        if (platformInfo.layoutTier !== 'legacy') {
            log.debug('Native CSS vars supported — polyfill skipped');
            return;
        }

        this._active = true;
        log.info('CSS vars not natively supported — activating ponyfill');

        // Run initial pass to resolve all var() calls with the current
        // theme variable values. This typically takes < 10ms on TV hardware.
        cssVars(PONYFILL_OPTIONS);
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

        // Re-run with the preserved options — the ponyfill will re-scan the
        // stylesheets and update its injected <style> block with the new values.
        cssVars(PONYFILL_OPTIONS);
    }
}

// Export singleton — one instance for the entire app lifecycle
export const cssVarsPolyfill = new CssVarsPolyfill();
export default CssVarsPolyfill;
