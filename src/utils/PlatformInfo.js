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

        // Cache browser engine version eagerly to support capability detection at module import time
        // Defaults to detected Chromium version from User Agent, or 999 if unknown/modern browser
        this._chromeVersion = this._detectChromeVersion();
    }

    /**
     * =========================================================================
     * Chromium Engine Version Detection
     * =========================================================================
     * Parse the underlying Chromium engine version directly from user agent tokens.
     * Evaluated eagerly so capabilities (such as WebAssembly and CSS Grid) can be
     * reliably checked prior to or during module initialization.
     *
     * @private
     * @returns {number} Detected Chromium major version or 999 for modern environments.
     */
    _detectChromeVersion() {
        if (typeof navigator === 'undefined' || !navigator.userAgent) {
            return 999;
        }

        // Standard Chromium User Agent format: Chrome/<major>.<minor>...
        const chromeMatch = navigator.userAgent.match(/Chrome\/(\d+)/);
        // Modern Tizen User Agent format: (KHTML, like Gecko) <major>.<minor>...
        const altChromeMatch = navigator.userAgent.match(/like Gecko\)\s+(\d+)\.\d+\.\d+\.\d+/);

        if (chromeMatch) {
            return parseInt(chromeMatch[1], 10);
        } else if (altChromeMatch) {
            // Modern Tizen (e.g., Tizen 9.0) user agents omit the "Chrome/" string but keep the raw
            // Chromium version right after the Gecko token.
            // Example: ... (KHTML, like Gecko) 120.0.6099.5/9.0 TV Safari/...
            return parseInt(altChromeMatch[1], 10);
        } else if (/Tizen (\d+)\./i.test(navigator.userAgent)) {
            // Fallback: Infer Chromium baseline from Tizen OS version if browser tokens are obscured
            const tizenVer = parseInt(navigator.userAgent.match(/Tizen (\d+)\./i)[1], 10);
            if (tizenVer >= 5) {
                // Tizen 5.0+ runs Chromium 69+ (full CSS Grid and WebAssembly support)
                return 69;
            } else if (tizenVer >= 3) {
                // Tizen 3.0/4.0 run Chromium 47/56 (Flexbox only, no WebAssembly)
                return 47;
            } else {
                // Tizen 2.x runs an ancient pure WebKit engine (WebKit 538.1)
                return 26;
            }
        } else if (/Tizen|Web[O0]?S|NetCast|LG[ -]?Browser/i.test(navigator.userAgent)) {
            // Ancient Tizen (2.4) and early WebOS (1.x/2.x) use pure WebKit without Chrome branding
            return 26;
        }

        // Default to modern baseline for desktop browsers (Firefox, Safari, etc.)
        return 999;
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
        const chromeVersion = this._detectChromeVersion();
        this._chromeVersion = chromeVersion;

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

    /**
     * =========================================================================
     * WebAssembly (WASM) Capability Detection
     * =========================================================================
     * Runtime capability check for WebAssembly execution and module instantiation.
     * Evaluates whether the underlying browser engine supports WebAssembly.
     *
     * WebAssembly officially shipped and was enabled by default starting in
     * Chromium 57 (March 2017). On legacy TV platforms (such as Tizen 3.0/4.0
     * which run Chromium 47/56, or LG WebOS <= 4.0 which run Chromium <= 53),
     * WebAssembly is unsupported or disabled.
     *
     * Modern platforms (Tizen 5.0+, LG WebOS 4.5+, and modern desktop/mobile
     * browsers) fully support WebAssembly and can run high-fidelity WASM-based
     * renderers such as libass-wasm.
     *
     * @returns {boolean} True if WebAssembly execution and instantiation is supported.
     */
    get hasWasmSupport() {
        // Return cached evaluation if already executed
        if (this._hasWasmSupport !== undefined) {
            return this._hasWasmSupport;
        }

        try {
            // Guard: If the detected Chromium version is known and strictly below Chrome 57,
            // WebAssembly is guaranteed not to be supported natively
            if (this.chromeVersion < 57) {
                this._hasWasmSupport = false;
                return false;
            }

            // Verify existence of global WebAssembly object and instantiate function
            if (typeof WebAssembly === 'object' && typeof WebAssembly.instantiate === 'function') {
                // Compile and instantiate a minimal valid 8-byte WASM binary module (\0asm\1\0\0\0)
                // to verify that the runtime can actually compile and execute WebAssembly code
                const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
                if (module instanceof WebAssembly.Module) {
                    this._hasWasmSupport = new WebAssembly.Instance(module) instanceof WebAssembly.Instance;
                    return this._hasWasmSupport;
                }
            }
        } catch (e) {
            // Trapped compilation or execution failure indicates lack of WebAssembly support
        }

        this._hasWasmSupport = false;
        return false;
    }
}

export const platformInfo = new PlatformInfo();
