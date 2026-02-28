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
}

export const platformInfo = new PlatformInfo();
