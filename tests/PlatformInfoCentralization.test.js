import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * ============================================================================
 * PlatformInfo Centralization Test Suite
 * ============================================================================
 * Verifies that:
 *   1. Platform detection and version parsing are centralized in PlatformInfo.
 *   2. Cached properties are evaluated eagerly without redundant regex execution.
 *   3. Tizen versions (via tizen.systeminfo and UA fallback) resolve accurately.
 *   4. webOS versions (via UA Chromium major versions and WebKit tokens) resolve accurately.
 *   5. Android and Android TV environments and OS versions resolve accurately.
 *   6. Desktop operating system labels (Windows, macOS, Linux) resolve accurately.
 *   7. Browser vendor brands (Edge, Chrome, Firefox, Safari) resolve accurately.
 * ============================================================================
 */

// Setup storage backing map and DOM globals for node test runner
const storageMap = new Map();
globalThis.localStorage = {
    getItem: (key) => storageMap.get(key) || null,
    setItem: (key, val) => storageMap.set(key, String(val)),
    removeItem: (key) => storageMap.delete(key),
    clear: () => storageMap.clear()
};
globalThis.window = globalThis;
globalThis.document = {
    createElement: () => ({ canPlayType: () => '' })
};

const { platformInfo } = await import('../src/utils/PlatformInfo.js');

test('PlatformInfo: Samsung Tizen TV environment and version detection', () => {
    // 1. Simulate Tizen via hardware systeminfo capability
    globalThis.window.tizen = {
        systeminfo: {
            getCapability: (uri) => {
                if (uri === 'http://tizen.org/feature/platform.version') return '9.0';
                return null;
            }
        }
    };
    Object.defineProperty(globalThis.navigator, 'userAgent', {
        value: 'Mozilla/5.0 (SMART-TV; Linux; Tizen 9.0) AppleWebKit/537.36 (KHTML, like Gecko) 120.0.6099.5/9.0 TV Safari/537.36',
        configurable: true
    });

    platformInfo.reset();

    assert.strictEqual(platformInfo.isTizen, true, 'isTizen must be true');
    assert.strictEqual(platformInfo.isWebOS, false, 'isWebOS must be false on Tizen');
    assert.strictEqual(platformInfo.isAndroid, false, 'isAndroid must be false on Tizen');
    assert.strictEqual(platformInfo.isTv, true, 'isTv must be true on Tizen');
    assert.strictEqual(platformInfo.isDesktop, false, 'isDesktop must be false on Tizen');
    assert.strictEqual(platformInfo.tizenVersion, 9.0, 'tizenVersion must resolve to 9.0 from systeminfo');
    assert.strictEqual(platformInfo.operatingSystem, 'Tizen', 'operatingSystem must be Tizen');

    // 2. Simulate Tizen 4.0 via UA fallback without systeminfo
    delete globalThis.window.tizen.systeminfo;
    Object.defineProperty(globalThis.navigator, 'userAgent', {
        value: 'Mozilla/5.0 (SMART-TV; Linux; Tizen 4.0) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/56.0.2924.0 TV Safari/537.36',
        configurable: true
    });

    platformInfo.reset();

    assert.strictEqual(platformInfo.isTizen, true);
    assert.strictEqual(platformInfo.tizenVersion, 4.0, 'tizenVersion must parse 4.0 from UA');

    // Cleanup globals
    delete globalThis.window.tizen;
});

test('PlatformInfo: LG webOS TV environment and version mapping', () => {
    // 1. Simulate webOS 24 (Chromium 108)
    Object.defineProperty(globalThis.navigator, 'userAgent', {
        value: 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.5359.215 Safari/537.36 WebAppManager',
        configurable: true
    });

    platformInfo.reset();

    assert.strictEqual(platformInfo.isWebOS, true, 'isWebOS must be true');
    assert.strictEqual(platformInfo.isTizen, false, 'isTizen must be false on webOS');
    assert.strictEqual(platformInfo.isTv, true, 'isTv must be true on webOS');
    assert.strictEqual(platformInfo.webosVersion, 24, 'webOS version must map to 24 for Chrome 108');
    assert.strictEqual(platformInfo.operatingSystem, 'webOS', 'operatingSystem must be webOS');

    // 2. Simulate ancient webOS 2.x (pure WebKit 538)
    Object.defineProperty(globalThis.navigator, 'userAgent', {
        value: 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/538.2 (KHTML, like Gecko) Large Screen WebAppManager',
        configurable: true
    });

    platformInfo.reset();

    assert.strictEqual(platformInfo.isWebOS, true);
    assert.strictEqual(platformInfo.webosVersion, 2, 'webOS version must map to 2 for WebKit 538');
});

test('PlatformInfo: Android and Android TV environment and version detection', () => {
    // 1. Simulate Android TV box (Xiaomi Mi Box with Android 9)
    Object.defineProperty(globalThis.navigator, 'userAgent', {
        value: 'Mozilla/5.0 (Linux; Android 9; MIBOX4 Build/PI; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.134 Mobile Safari/537.36',
        configurable: true
    });
    globalThis.LitefinAndroid = {
        isTv: () => true
    };

    platformInfo.reset();

    assert.strictEqual(platformInfo.isAndroid, true, 'isAndroid must be true');
    assert.strictEqual(platformInfo.isAndroidTv, true, 'isAndroidTv must be true');
    assert.strictEqual(platformInfo.isTv, true, 'isTv must be true for Android TV');
    assert.strictEqual(platformInfo.androidVersion, '9', 'androidVersion must parse 9');
    assert.strictEqual(platformInfo.operatingSystem, 'Android TV', 'operatingSystem must be Android TV');

    // 2. Simulate Android Mobile Phone without TV bridge
    delete globalThis.LitefinAndroid;
    Object.defineProperty(globalThis.navigator, 'userAgent', {
        value: 'Mozilla/5.0 (Linux; Android 14; SM-S928B Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.134 Mobile Safari/537.36',
        configurable: true
    });

    platformInfo.reset();

    assert.strictEqual(platformInfo.isAndroid, true);
    assert.strictEqual(platformInfo.isAndroidTv, false, 'isAndroidTv must be false for phone');
    assert.strictEqual(platformInfo.androidVersion, '14', 'androidVersion must parse 14');
    assert.strictEqual(platformInfo.operatingSystem, 'Android', 'operatingSystem must be Android for non-TV');
});

test('PlatformInfo: Desktop runtime operating system and vendor brand detection', () => {
    // 1. Simulate Windows desktop browser
    Object.defineProperty(globalThis.navigator, 'userAgent', {
        value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0',
        configurable: true
    });

    platformInfo.reset();

    assert.strictEqual(platformInfo.isWeb, true, 'Desktop browser without Tauri shell is web');
    assert.strictEqual(platformInfo.isDesktop, false, 'Standard browser is not packaged desktop shell');
    assert.strictEqual(platformInfo.operatingSystem, 'Windows', 'operatingSystem must be Windows');
    assert.strictEqual(platformInfo.browserName, 'Edge', 'browserName must detect Edge');

    // 2. Simulate packaged Tauri desktop shell on macOS
    globalThis.window.__TAURI__ = {};
    Object.defineProperty(globalThis.navigator, 'userAgent', {
        value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        configurable: true
    });

    platformInfo.reset();

    assert.strictEqual(platformInfo.isDesktop, true, 'isDesktop must be true inside Tauri');
    assert.strictEqual(platformInfo.isTauri, true, 'isTauri must be true');
    assert.strictEqual(platformInfo.operatingSystem, 'macOS', 'operatingSystem must be macOS');
    assert.strictEqual(platformInfo.browserName, 'Chrome', 'browserName must detect Chrome');

    // Cleanup globals
    delete globalThis.window.__TAURI__;
});

test('PlatformInfo: Legacy engine classification and ImageCache compatibility', () => {
    // 1. Modern Tizen 9.0 (Chromium 120) must be modern (isLegacyEngine = false)
    Object.defineProperty(globalThis.navigator, 'userAgent', {
        value: 'Mozilla/5.0 (SMART-TV; Linux; Tizen 9.0) AppleWebKit/537.36 (KHTML, like Gecko) 120.0.6099.5/9.0 TV Safari/537.36',
        configurable: true
    });
    platformInfo.refresh();
    assert.strictEqual(platformInfo.isLegacyEngine, false, 'Tizen 9.0 Chrome 120 must not be legacy');
    assert.strictEqual(platformInfo.isLegacyWebKit, false, 'isLegacyWebKit alias must be false');

    // 2. Desktop Chrome 120 must be modern
    Object.defineProperty(globalThis.navigator, 'userAgent', {
        value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        configurable: true
    });
    platformInfo.refresh();
    assert.strictEqual(platformInfo.isLegacyEngine, false, 'Desktop Chrome 120 must not be legacy');

    // 3. Tizen 3.0 (Chrome 47) must be legacy (< Chrome 50)
    Object.defineProperty(globalThis.navigator, 'userAgent', {
        value: 'Mozilla/5.0 (SMART-TV; Linux; Tizen 3.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/3.0 TV Safari/538.1 Chrome/47.0.2526.69',
        configurable: true
    });
    platformInfo.refresh();
    assert.strictEqual(platformInfo.isLegacyEngine, true, 'Chrome 47 on Tizen 3 must be legacy');

    // 4. Tizen 2.4 (pure WebKit 538.1) must be legacy
    Object.defineProperty(globalThis.navigator, 'userAgent', {
        value: 'Mozilla/5.0 (SMART-TV; Linux; Tizen 2.4.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/2.4.0 TV Safari/538.1',
        configurable: true
    });
    platformInfo.refresh();
    assert.strictEqual(platformInfo.isLegacyEngine, true, 'Tizen 2.4 pure WebKit must be legacy');

    // 5. webOS 1.2 must be legacy
    Object.defineProperty(globalThis.navigator, 'userAgent', {
        value: 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/538.2 (KHTML, like Gecko) Large Screen WebAppManager Safari/538.2',
        configurable: true
    });
    platformInfo.refresh();
    assert.strictEqual(platformInfo.isLegacyEngine, true, 'webOS 1.2 must be legacy');
});
