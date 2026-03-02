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
         *   'modern' — Chrome 57+: CSS Grid is available (Tizen 5.0+)
         *   'legacy' — Chrome <57: CSS Grid is unsupported (Tizen 3.0 / 4.0)
         * Stamped onto <html data-layout-tier> by LayoutManager.init().
         */
        this._layoutTier = 'modern'; // Safe default
    }

    /**
     * Determine the current platform and cache it in storage.
     * Should be called exactly once during App init.
     */
    init() {
        // 1. Check existing cached platform
        const savedPlatform = storage.getItem('app_platform');

        if (savedPlatform) {
            this._platform = savedPlatform;
            log.info(`Platform restored from cache: ${this._platform}`);
            return;
        }

        // 2. Perform fresh detection
        log.info('Detecting device platform...');

        // Tizen check
        if (typeof window.tizen !== 'undefined' || typeof window.webapis?.avplay !== 'undefined') {
            this._platform = 'tizen';
        }
        // WebOS check
        else if (
            typeof window.webOS !== 'undefined' ||
            navigator.userAgent.includes('Web0S') ||
            navigator.userAgent.includes('NetCast')
        ) {
            this._platform = 'webos';
        }
        // Default
        else {
            this._platform = 'web';
        }

        log.info(`Detected platform: ${this._platform}`);

        // -------------------------------------------------------------------
        // Layout Tier Detection — based on Chrome version in the UA string.
        //   CSS Grid landed in Chrome 57. Tizen 3.0 ships Chrome 47,
        //   Tizen 4.0 ships Chrome 56 — both pre-Grid. We stamp this as a
        //   data attribute on <html> so CSS can switch rendering paths without
        //   any runtime JS branching in components.
        // -------------------------------------------------------------------
        const chromeMatch = navigator.userAgent.match(/Chrome\/(\d+)/);
        const chromeVersion = chromeMatch ? parseInt(chromeMatch[1], 10) : 999;

        // Chrome 57+ has CSS Grid support; anything below falls back to flex-wrap.
        this._layoutTier = chromeVersion >= 57 ? 'modern' : 'legacy';
        log.info(`Layout tier: ${this._layoutTier} (Chrome ${chromeVersion === 999 ? 'unknown' : chromeVersion})`);

        // Cache the result
        storage.setItem('app_platform', this._platform);
    }

    /** @returns {boolean} True if running on a Samsung Tizen TV */
    get isTizen() {
        return this._platform === 'tizen';
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
     * @returns {'modern'|'legacy'} 'modern' if CSS Grid is supported (Chrome 57+), 'legacy' otherwise.
     */
    get layoutTier() {
        return this._layoutTier;
    }
}

export const platformInfo = new PlatformInfo();
