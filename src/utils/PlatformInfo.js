/**
 * ============================================================================
 * Litefin - Platform Info Utility
 * ============================================================================
 * Centralized platform detection. Instead of checking `window.tizen` across
 * the codebase, this utility evaluates the platform once and exposes strictly
 * typed boolean flags for feature detection and analytics.
 * ============================================================================
 */

import { storage } from './StorageService.js';
import { logger } from './Logger.js';

const log = logger.create('PlatformInfo');

class PlatformInfo {
    constructor() {
        this._platform = 'web'; // Default to web

        /*
         * Layout tier controls which CSS rendering path is used.
         *   'modern'       — Chrome 57+:  CSS Grid available (Tizen 5.0+)
         *   'legacy'       — Chrome 47–56: No CSS Grid but flexbox works fine (Tizen 3.0 / 4.0)
         *   'ultra-legacy' — Chrome <47:  Broken flex, no CSS vars, no Grid (Tizen 2.x / WebOS 1.x)
         * Stamped onto <html data-layout-tier> by LayoutManager.init().
         */
        this._layoutTier = 'modern'; // Safe default

        // Cache browser engine version to apply specific rendering patches on ancient devices
        // (specifically targeting Tizen 2.x and early webOS TV releases running Chrome < 32)
        this._chromeVersion = 999;
    }

    /**
     * Determine the current platform and cache it in storage.
     * Should be called exactly once during App init.
     */
    init() {
        log.info(`Initializing platform detection. UA: ${navigator.userAgent}`);
        // Force re-detection on every boot to ensure hardware changes/updates are caught
        // const savedPlatform = storage.getItem('app_platform');
        const savedPlatform = null;

        if (savedPlatform) {
            this._platform = savedPlatform;
            log.info(`Platform restored from cache: ${this._platform}`);
        } else {
            // 2. Perform fresh detection
            log.info('Detecting device platform...');

            // Tizen check
            if (typeof window.tizen !== 'undefined' || typeof window.webapis?.avplay !== 'undefined') {
                this._platform = 'tizen';
            }
            // WebOS check — handle both WebOS (letter O) and Web0S (zero) variants, and NetCast/LG Browser
            // NOTE: We don't check for window.webOS here because webOSTV.js is included in index.html
            // and defines the namespace even on standard browsers, causing false positives.
            // LG TVs reliably include WebOS/NetCast in their UA.
            else if (/Web[O0]S|NetCast|LG[ -]Browser/i.test(navigator.userAgent)) {
                this._platform = 'webos';
            }
            // Default
            else {
                this._platform = 'web';
            }

            log.info(`Detected platform: ${this._platform}`);

            // Cache the result
            storage.setItem('app_platform', this._platform);
        }

        // -------------------------------------------------------------------
        // Layout Tier Detection — based on Chrome version in the UA string.
        //   CSS Grid landed in Chrome 57. Tizen 3.0 ships Chrome 47,
        //   Tizen 4.0 ships Chrome 56 — both pre-Grid. We stamp this as a
        //   data attribute on <html> so CSS can switch rendering paths without
        //   any runtime JS branching in components.
        //
        // CRITICAL: This MUST run even if platform is cached, otherwise
        // layoutTier stays at default 'modern' on subsequent app launches
        // on legacy hardware.
        // -------------------------------------------------------------------
        const chromeMatch = navigator.userAgent.match(/Chrome\/(\d+)/);
        const altChromeMatch = navigator.userAgent.match(/like Gecko\)\s+(\d+)\.\d+\.\d+\.\d+/);

        let chromeVersion;
        if (chromeMatch) {
            chromeVersion = parseInt(chromeMatch[1], 10);
        } else if (altChromeMatch) {
            // Modern Tizen (e.g., Tizen 9.0) user agents omit the "Chrome/" string but keep the raw
            // Chromium version right after the Gecko token.
            // Example: ... (KHTML, like Gecko) 120.0.6099.5/9.0 TV Safari/...
            chromeVersion = parseInt(altChromeMatch[1], 10);
        } else if (/Tizen (\d+)\./i.test(navigator.userAgent)) {
            // Fallback: Infer from Tizen version if browser version is completely obscured.
            const tizenVer = parseInt(navigator.userAgent.match(/Tizen (\d+)\./i)[1], 10);
            if (tizenVer >= 5)
                chromeVersion = 69; // Tizen 5.0+ supports Grid
            else if (tizenVer >= 3)
                chromeVersion = 47; // Tizen 3/4 support Flexbox
            // Tizen 2.x (e.g. 2.4.0) runs an ancient pure WebKit engine (WebKit 538.1) without Chromium branding.
            // Setting chromeVersion to 26 ensures `isAncientChrome` (< 32) evaluates to true,
            // which in turn stamps `data-layout-quirks="c26"` onto <html> for layout rendering patches.
            else chromeVersion = 26; // Tizen 2.x (pure WebKit engine)
        } else if (/Tizen|Web[O0]?S|NetCast|LG[ -]?Browser/i.test(navigator.userAgent)) {
            // Ancient Tizen (2.4) and WebOS (1.x/2.x) use pure WebKit without Chrome branding.
            // Setting this to 26 ensures quirks mode (data-layout-quirks="c26") is enabled.
            chromeVersion = 26;
        } else {
            chromeVersion = 999; // Assume modern if totally unknown (e.g. Firefox/Safari Desktop)
        }

        // Three-tier CSS rendering path:
        //   Chrome 57+ → modern   (CSS Grid + native custom properties)
        //   Chrome 47–56 → legacy (flexbox only, no CSS Grid; Tizen 3.0 / 4.0)
        //   Chrome <47 → ultra-legacy (broken flex in many contexts, no CSS vars,
        //                              no CSS Grid; Tizen 2.x / WebOS 1.x / Chrome 32)
        if (chromeVersion >= 57) {
            this._layoutTier = 'modern';
        } else if (chromeVersion >= 47) {
            this._layoutTier = 'legacy';
        } else {
            this._layoutTier = 'ultra-legacy';
        }

        // Cache the parsed chrome version number to the instance variable
        // to enable custom engine quirk checks down the line
        this._chromeVersion = chromeVersion;

        log.info(`Layout tier: ${this._layoutTier} (Chrome ${chromeVersion === 999 ? 'unknown' : chromeVersion})`);
    }

    /** @returns {boolean} True if running on a Samsung Tizen TV */
    get isTizen() {
        return this._platform === 'tizen';
    }

    /**
     * =========================================================================
     * Tizen OS Version Getter
     * =========================================================================
     * Retrieves the decimal Tizen version directly from the platform User Agent.
     * Essential for handling legacy API differences (e.g., power controls on <4.0).
     * @returns {number|null} Parsed version float (e.g., 3.0, 4.0) or null if not Tizen.
     */
    get tizenVersion() {
        if (!this.isTizen) {
            return null;
        }

        const match = navigator.userAgent.match(/Tizen\s+(\d+(?:\.\d+)?)/i);
        if (match) {
            const version = parseFloat(match[1]);
            log.debug(`Parsed Tizen OS Version: ${version}`);
            return version;
        }

        return null;
    }

    /** @returns {boolean} True if running on an LG WebOS TV */
    get isWebOS() {
        return this._platform === 'webos';
    }

    /** @returns {boolean} True if running in a standard web browser */
    get isWeb() {
        return this._platform === 'web';
    }

    /** @returns {string} The raw platform string ('tizen', 'webos', 'web') */
    get platformString() {
        return this._platform;
    }

    /**
     * The CSS layout tier for this device.
     * @returns {'modern'|'legacy'|'ultra-legacy'}
     *   'modern'       — Chrome 57+, CSS Grid + native custom properties
     *   'legacy'       — Chrome 47–56, flexbox only (Tizen 3.0 / 4.0)
     *   'ultra-legacy' — Chrome <47, fallen-back rendering (Tizen 2.x / WebOS 1.x)
     */
    get layoutTier() {
        return this._layoutTier;
    }

    /**
     * Expose the detected Chrome browser version.
     * @returns {number} Chrome version number or 999 for modern browser environments.
     */
    get chromeVersion() {
        return this._chromeVersion;
    }

    /**
     * Checks if the device runs an ancient Chromium build (pre-Chrome 32).
     * This layout tier requires heavy fallback layouts, box-flex styling, 
     * and specific CSS overrides for WebOS 1.0 and Tizen 2.x platforms.
     * @returns {boolean} True if Chromium engine is < 32.
     */
    get isAncientChrome() {
        return this._chromeVersion < 32;
    }
}

export const platformInfo = new PlatformInfo();
