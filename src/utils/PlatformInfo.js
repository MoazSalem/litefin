/**
 * ============================================================================
 * Litefin - Platform Info Utility
 * ============================================================================
 * Centralized, single-source-of-truth platform detection for the Litefin client.
 *
 * All platform identifiers, operating system versions, and layout tiers are
 * evaluated strictly once upon startup and cached in memory. Component and
 * adapter consumers read pre-calculated boolean flags and version numbers
 * with zero regex execution or DOM overhead at runtime.
 *
 * Supported Runtime Platforms:
 *   - 'tizen'   : Samsung Smart TVs (Tizen OS 2.4 through 9.0+)
 *   - 'webos'   : LG Smart TVs (webOS 1.0 through 25+)
 *   - 'android' : Android TV / Google TV / Android Mobile & Tablet
 *   - 'desktop' : Packaged desktop application shells (Tauri, Electron)
 *   - 'web'     : Standard desktop & mobile web browsers (Chrome, Firefox, Safari, Edge)
 * ============================================================================
 */

import { storage } from './StorageService.js';
import { logger } from './Logger.js';

// Dedicated logger instance for platform detection and lifecycle events
const log = logger.create('PlatformInfo');

class PlatformInfo {
    constructor() {
        // Cached environment fingerprint to detect dynamic mocks in test harnesses
        this._cachedFingerprint = '';

        // Core platform identifier ('tizen', 'webos', 'android', 'desktop', 'web')
        this.__platform = 'web';

        // Underlying Chromium browser engine major version (default 999 for modern browsers)
        this.__chromeVersion = 999;

        // CSS rendering layout tier ('modern', 'legacy', 'ultra-legacy')
        this._layoutTier = 'modern';

        // Pre-calculated platform boolean flags (evaluated strictly once)
        this._isTizen = false;
        this._isWebOS = false;
        this._isAndroid = false;
        this._isAndroidTv = false;
        this._isTv = false;
        this._isDesktop = false;
        this._isWeb = true;
        this._isTauri = false;

        // Platform-specific operating system versions (evaluated strictly once)
        this._tizenVersion = null;
        this._webosVersion = null;
        this._androidVersion = null;

        // Host operating system and browser vendor descriptions
        this._operatingSystem = 'Unknown';
        this._browserName = 'Browser';

        // Eagerly perform comprehensive detection on instantiation
        this._detectAll();
    }

    /**
     * Build an environment fingerprint string from UA and hardware globals.
     * In production, this fingerprint is static across the lifetime of the application.
     * In unit testing environments, changes to globals (tizen, LitefinAndroid, UA) trigger re-detection.
     * @private
     * @returns {string}
     */
    _getEnvFingerprint() {
        const ua = typeof navigator !== 'undefined' && navigator.userAgent ? navigator.userAgent : '';
        const hasTizen = typeof window !== 'undefined' && Boolean(window.tizen);
        const hasAvPlay = typeof window !== 'undefined' && Boolean(window.webapis?.avplay);
        const isTvBridge =
            typeof window !== 'undefined'
                ? Boolean(window.LitefinAndroid?.isTv?.() || window.AndroidBridge?.isTv?.())
                : false;
        const hasLitefinAndroid = typeof window !== 'undefined' && Boolean(window.LitefinAndroid);
        const hasAndroidBridge = typeof window !== 'undefined' && Boolean(window.AndroidBridge);
        const hasTauri = typeof window !== 'undefined' && Boolean(window.__TAURI__);
        return `${ua}|${hasTizen}|${hasAvPlay}|${isTvBridge}|${hasLitefinAndroid}|${hasAndroidBridge}|${hasTauri}`;
    }

    /**
     * =========================================================================
     * Comprehensive Platform & Hardware Detection
     * =========================================================================
     * Evaluates hardware globals, browser engine tokens, operating system, and
     * runtime platform identifiers once at initialization. Results are cached
     * in private fields to guarantee zero regex overhead or redundant DOM access
     * during component lifecycle or UI render cycles.
     * =========================================================================
     * @private
     */
    _detectAll() {
        // Record current environment fingerprint for change-tracking in test environments
        this._cachedFingerprint = this._getEnvFingerprint();

        // Detect core runtime platform identifier
        this.__platform = this._detectPlatform();

        // Cached engine version from User Agent
        this.__chromeVersion = this._detectChromeVersion();

        // Detect layout rendering tier based on engine capabilities
        if (this.__chromeVersion >= 57) {
            this._layoutTier = 'modern';
        } else if (this.__chromeVersion >= 47) {
            this._layoutTier = 'legacy';
        } else {
            this._layoutTier = 'ultra-legacy';
        }

        // Cache primary platform flags strictly as booleans
        this._isTizen = this.__platform === 'tizen';
        this._isWebOS = this.__platform === 'webos';
        this._isAndroid = this.__platform === 'android';
        this._isDesktop = this._detectDesktop();
        this._isWeb = !this._isTizen && !this._isWebOS && !this._isAndroid && !this._isDesktop;

        // Detect TV-specific runtime sub-profiles and shell environments
        this._isAndroidTv = this._detectAndroidTv();
        this._isTv = Boolean(this._isTizen || this._isWebOS || this._isAndroidTv);
        this._isTauri = this._detectTauri();

        // Detect OS-specific release versions and underlying operating system names
        this._tizenVersion = this._detectTizenVersion();
        this._webosVersion = this._detectWebOSVersion();
        this._androidVersion = this._detectAndroidVersion();
        this._operatingSystem = this._detectOperatingSystem();
        this._browserName = this._detectBrowserName();
    }

    /**
     * Synchronize boolean convenience flags from the primary platform identifier.
     * Ensures all platform-related boolean properties match this.__platform.
     * @private
     */
    _syncPlatformFlags() {
        this._isTizen = this.__platform === 'tizen';
        this._isWebOS = this.__platform === 'webos';
        this._isAndroid = this.__platform === 'android';
        this._isDesktop = this._detectDesktop();
        this._isWeb = !this._isTizen && !this._isWebOS && !this._isAndroid && !this._isDesktop;
        this._isTv = Boolean(this._isTizen || this._isWebOS || this._isAndroidTv);
    }

    /**
     * Verifies whether runtime User Agent or global environment has changed.
     * In production, navigator.userAgent is static and this is a single string comparison.
     * In unit test environments, dynamic UA/window manipulation triggers re-detection.
     * @private
     */
    _ensureUpToDate() {
        if (this._getEnvFingerprint() !== this._cachedFingerprint) {
            this._detectAll();
        }
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
     * =========================================================================
     * Device Platform Detection
     * =========================================================================
     * Evaluates global hardware APIs and User Agent signatures to identify the
     * active runtime environment (Tizen, webOS, Android, Desktop, or Web).
     *
     * @private
     * @returns {'tizen'|'webos'|'android'|'desktop'|'web'}
     */
    _detectPlatform() {
        // Fall back safely if running in headless node / test environment
        if (typeof window === 'undefined' && typeof navigator === 'undefined') {
            return 'web';
        }

        // ---------------------------------------------------------------------
        // Samsung Smart TV (Tizen) Detection
        // ---------------------------------------------------------------------
        // Check hardware namespaces (window.tizen, window.webapis) or Tizen UA token
        if (
            (typeof window !== 'undefined' &&
                (typeof window.tizen !== 'undefined' || typeof window.webapis?.avplay !== 'undefined')) ||
            (typeof navigator !== 'undefined' && /Tizen/i.test(navigator.userAgent || ''))
        ) {
            return 'tizen';
        }

        // ---------------------------------------------------------------------
        // LG Smart TV (webOS) Detection
        // ---------------------------------------------------------------------
        // LG TVs reliably include WebOS/NetCast in their UA across all webOS versions
        if (typeof navigator !== 'undefined' && /Web[O0]S|NetCast|LG[ -]Browser/i.test(navigator.userAgent || '')) {
            return 'webos';
        }

        // ---------------------------------------------------------------------
        // Android / Android TV Detection
        // ---------------------------------------------------------------------
        // Checks UA tokens and native bridge injection objects
        if (
            (typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent || '')) ||
            (typeof window !== 'undefined' &&
                (typeof window.LitefinAndroid !== 'undefined' || typeof window.AndroidBridge !== 'undefined'))
        ) {
            return 'android';
        }

        // ---------------------------------------------------------------------
        // Desktop Shell (Tauri / Electron) Detection
        // ---------------------------------------------------------------------
        if (
            typeof window !== 'undefined' &&
            (window.__TAURI__ ||
                window.__TAURI_METADATA__ ||
                window.__TAURI_INTERNALS__ ||
                window.process?.versions?.electron ||
                (typeof navigator !== 'undefined' && /Electron/i.test(navigator.userAgent || '')))
        ) {
            return 'desktop';
        }

        // Default to standard web browser environment
        return 'web';
    }

    /**
     * =========================================================================
     * Desktop Environment Detection
     * =========================================================================
     * Identifies packaged desktop shells (Tauri or Electron).
     * @private
     * @returns {boolean}
     */
    _detectDesktop() {
        // Dedicated TV or mobile/Android platforms are never desktop runtimes
        if (this._isTizen || this._isWebOS || this._isAndroid) {
            return false;
        }

        // If explicitly detected as desktop application shell during platform scan
        if (this.__platform === 'desktop') {
            return true;
        }

        // Check for dedicated desktop application shell wrappers
        if (typeof window !== 'undefined') {
            if (window.__TAURI__ || window.__TAURI_METADATA__ || window.__TAURI_INTERNALS__) {
                return true;
            }
            if (
                window.process?.versions?.electron ||
                (typeof navigator !== 'undefined' && /Electron/i.test(navigator.userAgent || ''))
            ) {
                return true;
            }
        }

        return false;
    }

    /**
     * =========================================================================
     * Tauri Shell Runtime Detection
     * =========================================================================
     * @private
     * @returns {boolean} True if running inside a Tauri application shell.
     */
    _detectTauri() {
        if (typeof window === 'undefined') return false;
        return Boolean(window.__TAURI__ || window.__TAURI_METADATA__ || window.__TAURI_INTERNALS__);
    }

    /**
     * =========================================================================
     * Android TV Hardware Detection
     * =========================================================================
     * Distinguishes Android TV / Google TV boxes from mobile touchscreen devices.
     * @private
     * @returns {boolean}
     */
    _detectAndroidTv() {
        try {
            // Check native Android application bridge methods
            if (typeof window !== 'undefined') {
                if (typeof window.LitefinAndroid?.isTv === 'function') {
                    return Boolean(window.LitefinAndroid.isTv());
                }
                if (typeof window.AndroidBridge?.isTv === 'function') {
                    return Boolean(window.AndroidBridge.isTv());
                }
            }

            if (!this._isAndroid) return false;

            // Check User Agent tokens and input capabilities
            if (typeof navigator !== 'undefined' && navigator.userAgent) {
                const ua = navigator.userAgent;
                const hasTvToken =
                    /Android.*(TV|Television|GoogleTV|Large Screen|SmartTV|BRAVIA|AFT|Nexus Player|MIBOX|SHIELD)/i.test(
                        ua
                    );
                const isNonMobileWithoutTouch =
                    !/Mobile/i.test(ua) &&
                    (typeof window === 'undefined' || !('ontouchstart' in window) || navigator.maxTouchPoints === 0);
                return Boolean(hasTvToken || isNonMobileWithoutTouch);
            }
        } catch (_) {
            // Fall through safely
        }
        return false;
    }

    /**
     * =========================================================================
     * Tizen OS Version Detection
     * =========================================================================
     * Queries native Tizen systeminfo capability or User Agent token once.
     * @private
     * @returns {number|null} Tizen version float (e.g. 3.0, 4.0, 9.0) or null.
     */
    _detectTizenVersion() {
        if (!this._isTizen) {
            return null;
        }

        // 1. Query native Tizen platform capability if systeminfo namespace exists
        if (typeof window !== 'undefined' && window.tizen && window.tizen.systeminfo) {
            try {
                const platformVersion = window.tizen.systeminfo.getCapability(
                    'http://tizen.org/feature/platform.version'
                );
                if (platformVersion) {
                    const ver = parseFloat(platformVersion);
                    if (!isNaN(ver) && ver >= 2) {
                        return ver;
                    }
                }
            } catch (_) {
                // Capability probe failed or restricted in sandbox
            }
        }

        // 2. Query User Agent string for explicit Tizen version marker
        if (typeof navigator !== 'undefined' && navigator.userAgent) {
            const match = navigator.userAgent.match(/Tizen\s+(\d+(?:\.\d+)?)/i);
            if (match) {
                const ver = parseFloat(match[1]);
                if (!isNaN(ver) && ver >= 2) {
                    return ver;
                }
            }
        }

        // 3. Fallback safe default for Samsung Smart TV hardware
        return 4;
    }

    /**
     * =========================================================================
     * LG webOS Version Detection
     * =========================================================================
     * Resolves the LG webOS major release version from User Agent Chromium/WebKit
     * engine tokens once at startup.
     * @private
     * @returns {number|null} webOS major version (e.g. 1, 3, 5, 23, 24, 25) or null.
     */
    _detectWebOSVersion() {
        if (!this._isWebOS) {
            return null;
        }

        if (typeof navigator === 'undefined' || !navigator.userAgent) {
            return 1;
        }

        const userAgent = navigator.userAgent.toLowerCase();
        const match = /(?:chrome|crios|crmo)\/([0-9.]+)/.exec(userAgent);
        if (!match) {
            // Ancient WebOS 1.x/2.x platforms use pure WebKit without Chrome in UserAgent.
            // Fall back to parsing the AppleWebKit version number:
            //   AppleWebKit/538.2 -> WebOS 2.x
            //   AppleWebKit/537.41 -> WebOS 1.x
            const webkitMatch = /applewebkit\/([0-9.]+)/.exec(userAgent);
            if (webkitMatch) {
                const webkitVersion = parseFloat(webkitMatch[1]);
                if (webkitVersion >= 538) return 2;
                if (webkitVersion >= 537) return 1;
            }
            return 1; // Minimum safe fallback
        }

        const versionMajor = parseInt(match[1].split('.')[0], 10);

        if (versionMajor >= 120) return 25; // Estimate for WebOS 25
        if (versionMajor >= 108) return 24;
        if (versionMajor >= 94) return 23;
        if (versionMajor >= 87) return 22;
        if (versionMajor >= 79) return 6;
        if (versionMajor >= 68) return 5;
        if (versionMajor >= 53) return 4;
        if (versionMajor >= 38) return 3;
        if (versionMajor >= 34) return 2;
        if (versionMajor >= 26) return 1;

        return 1; // Fallback for very old versions
    }

    /**
     * =========================================================================
     * Android OS Version Detection
     * =========================================================================
     * Parses the Android OS release version string from User Agent once.
     * @private
     * @returns {string|null} Android OS version string (e.g. '9', '11', '14') or null.
     */
    _detectAndroidVersion() {
        if (!this._isAndroid) {
            return null;
        }

        if (typeof navigator !== 'undefined' && navigator.userAgent) {
            const match = navigator.userAgent.match(/Android\s+([0-9.]+)/i);
            if (match && match[1]) {
                return match[1].trim();
            }
        }

        return null;
    }

    /**
     * =========================================================================
     * Host Operating System Name Detection
     * =========================================================================
     * Resolves human-readable operating system name for logging, diagnostics,
     * and Jellyfin client device specification metadata.
     * @private
     * @returns {string} Operating system name (e.g. 'Tizen', 'webOS', 'Android', 'Windows', 'macOS', 'Linux')
     */
    _detectOperatingSystem() {
        if (this._isTizen) return 'Tizen';
        if (this._isWebOS) return 'webOS';
        if (this._isAndroid) return this._isAndroidTv ? 'Android TV' : 'Android';

        if (typeof navigator !== 'undefined' && navigator.userAgent) {
            const ua = navigator.userAgent;
            if (/Win32|Win64|Windows/i.test(ua)) return 'Windows';
            if (/Macintosh|Mac OS X/i.test(ua)) return 'macOS';
            if (/Linux/i.test(ua)) return 'Linux';
        }

        return 'Unknown';
    }

    /**
     * =========================================================================
     * Web Browser Brand Detection
     * =========================================================================
     * Detects major browser vendor name (Edge, Chrome, Firefox, Safari) once.
     * @private
     * @returns {string} Browser brand name
     */
    _detectBrowserName() {
        if (typeof navigator === 'undefined' || !navigator.userAgent) {
            return 'Browser';
        }
        const ua = navigator.userAgent;
        if (/Edg\//i.test(ua)) return 'Edge';
        if (/Chrome\//i.test(ua)) return 'Chrome';
        if (/Firefox\//i.test(ua)) return 'Firefox';
        if (/Safari\//i.test(ua) && !/Chrome/i.test(ua)) return 'Safari';
        return 'Browser';
    }

    /**
     * Determine the current platform and cache it in storage.
     * Should be called exactly once during App init.
     */
    init() {
        log.info(
            `Initializing platform detection. UA: ${typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown'}`
        );

        // Re-evaluate to capture hardware globals registered after module import
        this._detectAll();

        log.info(
            `Platform: ${this.__platform} (OS: ${this._operatingSystem}), ` +
                `Layout tier: ${this._layoutTier} (Chrome ${this.__chromeVersion === 999 ? 'unknown' : this.__chromeVersion})`
        );

        // Cache the result in storage
        storage.setItem('app_platform', this.__platform);
    }

    /**
     * Re-runs full detection. Useful for testing environments.
     */
    reset() {
        this._detectAll();
    }

    /**
     * Internal raw platform string getter.
     * @returns {'tizen'|'webos'|'android'|'desktop'|'web'}
     */
    get _platform() {
        this._ensureUpToDate();
        return this.__platform;
    }

    /**
     * Internal raw platform setter. Supports unit tests mutating platform state.
     * @param {'tizen'|'webos'|'android'|'desktop'|'web'} val
     */
    set _platform(val) {
        this.__platform = val;
        this._syncPlatformFlags();
    }

    /**
     * Internal chrome engine version getter.
     * @returns {number}
     */
    get _chromeVersion() {
        this._ensureUpToDate();
        return this.__chromeVersion;
    }

    /**
     * Internal chrome engine version setter. Supports unit tests mutating engine version.
     * @param {number} val
     */
    set _chromeVersion(val) {
        this.__chromeVersion = val;
    }

    /** @returns {boolean} True if running on a Samsung Tizen TV */
    get isTizen() {
        this._ensureUpToDate();
        return this._isTizen;
    }

    /**
     * =========================================================================
     * Tizen OS Version Getter
     * =========================================================================
     * Retrieves the numeric Tizen version directly from cached platform detection.
     * Essential for handling legacy API differences (e.g., power controls on <4.0).
     * @returns {number|null} Parsed version float (e.g., 3.0, 4.0) or null if not Tizen.
     */
    get tizenVersion() {
        this._ensureUpToDate();
        return this._tizenVersion;
    }

    /** @returns {boolean} True if running on an LG WebOS TV */
    get isWebOS() {
        this._ensureUpToDate();
        return this._isWebOS;
    }

    /**
     * =========================================================================
     * LG webOS Version Getter
     * =========================================================================
     * Retrieves the numeric webOS major release version from cached detection.
     * @returns {number|null} webOS major version (e.g., 1, 3, 5, 23, 24, 25) or null.
     */
    get webosVersion() {
        this._ensureUpToDate();
        return this._webosVersion;
    }

    /** @returns {boolean} True if running in a standard web browser (excluding Android TV, Smart TVs, and desktop app shells) */
    get isWeb() {
        this._ensureUpToDate();
        return this._isWeb;
    }

    /**
     * =========================================================================
     * Android Environment Detection
     * =========================================================================
     * Evaluates whether the application is currently running inside an Android
     * runtime environment (e.g. Android TV, Google TV, or mobile Android).
     * @returns {boolean} True if running on an Android platform.
     */
    get isAndroid() {
        this._ensureUpToDate();
        return this._isAndroid;
    }

    /**
     * Evaluates whether the application is running specifically on an Android TV
     * or Google TV runtime (excluding Android phones and touch tablets).
     * @returns {boolean} True if running on Android TV hardware
     */
    get isAndroidTv() {
        this._ensureUpToDate();
        return this._isAndroidTv;
    }

    /** @returns {boolean} True if running on any television runtime (Tizen, WebOS, or Android TV) */
    get isTv() {
        this._ensureUpToDate();
        return this._isTv;
    }

    /**
     * =========================================================================
     * Android OS Version Getter
     * =========================================================================
     * Retrieves the Android OS version (e.g. 9, 11, 14) from cached detection.
     * @returns {string|null} Parsed Android version string or null if not Android.
     */
    get androidVersion() {
        this._ensureUpToDate();
        return this._androidVersion;
    }

    /**
     * =========================================================================
     * Tauri Shell Runtime Detection
     * =========================================================================
     * Detects if Litefin is currently running inside a Tauri v2 native shell.
     * Evaluates true across all Tauri distribution targets:
     *  - Desktop targets (Windows, macOS, Linux)
     *  - Android TV & Amazon Fire TV targets
     * @returns {boolean} True if running under the Tauri application shell.
     */
    get isTauri() {
        this._ensureUpToDate();
        return this._isTauri;
    }

    /**
     * =========================================================================
     * Desktop Environment Detection
     * =========================================================================
     * Evaluates whether the application is currently running in a desktop
     * operating system environment (packaged via Tauri, Electron, or a
     * desktop browser on Windows, macOS, or Linux). Excludes TV runtimes
     * (Tizen, webOS, Android TV) and mobile devices.
     * @returns {boolean} True if running on a desktop platform.
     */
    get isDesktop() {
        this._ensureUpToDate();
        return this._isDesktop;
    }

    /**
     * =========================================================================
     * Host Operating System Identifier
     * =========================================================================
     * Retrieves human-readable operating system identifier.
     * @returns {string} Operating system name ('Tizen', 'webOS', 'Android TV', 'Android', 'Windows', 'macOS', 'Linux', 'Unknown')
     */
    get operatingSystem() {
        this._ensureUpToDate();
        return this._operatingSystem;
    }

    /**
     * =========================================================================
     * Web Browser Vendor Brand
     * =========================================================================
     * Retrieves detected browser brand.
     * @returns {'Edge'|'Chrome'|'Firefox'|'Safari'|'Browser'}
     */
    get browserName() {
        this._ensureUpToDate();
        return this._browserName;
    }

    /** @returns {string} The raw platform string ('tizen', 'webos', 'android', 'desktop', 'web') */
    get platformString() {
        this._ensureUpToDate();
        return this.__platform;
    }

    /**
     * Platform identifier accessor.
     * @returns {'tizen'|'webos'|'android'|'desktop'|'web'} The detected device platform identifier.
     */
    get platform() {
        this._ensureUpToDate();
        return this.__platform;
    }

    /**
     * The CSS layout tier for this device.
     * @returns {'modern'|'legacy'|'ultra-legacy'}
     *   'modern'       — Chrome 57+, CSS Grid + native custom properties
     *   'legacy'       — Chrome 47–56, flexbox only (Tizen 3.0 / 4.0)
     *   'ultra-legacy' — Chrome <47, fallen-back rendering (Tizen 2.x / WebOS 1.x)
     */
    get layoutTier() {
        this._ensureUpToDate();
        return this._layoutTier;
    }

    /**
     * Expose the detected Chrome browser version.
     * @returns {number} Chrome version number or 999 for modern browser environments.
     */
    get chromeVersion() {
        this._ensureUpToDate();
        return this.__chromeVersion;
    }

    /**
     * Checks if the device runs an ancient Chromium build (pre-Chrome 32).
     * This layout tier requires heavy fallback layouts, box-flex styling,
     * and specific CSS overrides for WebOS 1.0 and Tizen 2.x platforms.
     * @returns {boolean} True if Chromium engine is < 32.
     */
    get isAncientChrome() {
        this._ensureUpToDate();
        return this.__chromeVersion < 32;
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

    /**
     * =========================================================================
     * WebCodecs API Capability Detection
     * =========================================================================
     * Runtime capability check for the W3C WebCodecs API (VideoDecoder & VideoFrame).
     * MoviPlayer relies on WebCodecs for hardware-accelerated video frame decoding
     * and WASM demuxing.
     *
     * WebCodecs is available in modern Chromium (Chrome 94+) and modern Safari (15.4+),
     * but is unsupported on Smart TVs (Samsung Tizen / LG webOS) and older browsers.
     *
     * When WebCodecs is missing in web/desktop environments, playback gracefully
     * falls back to the native HTML5 player (HtmlVideoPlayer).
     *
     * @returns {boolean} True if WebCodecs VideoDecoder and VideoFrame are available.
     */
    get hasWebCodecsSupport() {
        // Return cached evaluation if already executed
        if (this._hasWebCodecsSupport !== undefined) {
            return this._hasWebCodecsSupport;
        }

        try {
            // WebCodecs requires both global VideoDecoder and VideoFrame constructors
            const hasVideoDecoder = typeof window !== 'undefined' && typeof window.VideoDecoder === 'function';
            const hasVideoFrame = typeof window !== 'undefined' && typeof window.VideoFrame === 'function';

            // Cache positive result only when both essential constructors exist
            this._hasWebCodecsSupport = Boolean(hasVideoDecoder && hasVideoFrame);
        } catch (_) {
            // Trapped evaluation failure indicates lack of WebCodecs support
            this._hasWebCodecsSupport = false;
        }

        return this._hasWebCodecsSupport;
    }
}

export const platformInfo = new PlatformInfo();
