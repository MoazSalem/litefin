import assert from 'node:assert/strict';
import test from 'node:test';

// Polyfill minimal browser DOM globals
globalThis.__APP_VERSION__ = '1.9.82';

const storageMap = new Map();
globalThis.localStorage = {
    getItem: (key) => storageMap.get(key) || null,
    setItem: (key, val) => storageMap.set(key, String(val)),
    removeItem: (key) => storageMap.delete(key),
    clear: () => storageMap.clear()
};

const attributes = {};
const styles = {};
const appStyles = {};

const mockRoot = {
    setAttribute(k, v) { attributes[k] = String(v); },
    removeAttribute(k) { delete attributes[k]; },
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(attributes, k); },
    getAttribute(k) { return attributes[k] || null; },
    style: {
        setProperty(k, v) { styles[k] = String(v); },
        removeProperty(k) { delete styles[k]; },
        getPropertyValue(k) { return styles[k] || ''; }
    }
};

const mockAppEl = {
    style: {
        width: '',
        height: '',
        removeProperty(k) { delete appStyles[k]; }
    }
};

globalThis.document = {
    documentElement: mockRoot,
    addEventListener: () => {},
    removeEventListener: () => {},
    body: {
        style: {
            removeProperty() {}
        }
    },
    getElementById(id) {
        if (id === 'app') return mockAppEl;
        return null;
    },
    createElement: () => ({ canPlayType: () => '', setAttribute: () => {}, style: {} })
};

globalThis.window = {
    innerWidth: 375,
    innerHeight: 812,
    addEventListener() {},
    removeEventListener() {}
};

const { layoutManager } = await import('../src/ui/LayoutManager.js');
const { storage } = await import('../src/utils/StorageService.js');
const { platformInfo } = await import('../src/utils/PlatformInfo.js');

/**
 * ============================================================================
 * Mobile UI & Display Scale Engine Test Suite
 * ============================================================================
 * Verifies that:
 *   1. Narrow / portrait viewports on web and mobile activate the mobile UI.
 *   2. Stamping data-litefin-portrait and data-litefin-scaled activates
 *      responsive styling and MobileNav.
 *   3. The Display Scale option scales BOTH portrait and landscape mobile UIs
 *      proportionally with the user's selected scale multiplier.
 * ============================================================================
 */

test('Mobile Scaling: Portrait viewport activates mobile portrait markers and calculates base scale', () => {
    // Simulate mobile phone in portrait (375x812)
    globalThis.window.innerWidth = 375;
    globalThis.window.innerHeight = 812;

    // Set display scale to auto
    layoutManager.setDisplayScale('auto', false);

    // Verify portrait markers are stamped
    assert.strictEqual(attributes['data-litefin-portrait'], '1', 'Must stamp data-litefin-portrait');
    assert.strictEqual(attributes['data-litefin-scaled'], '1', 'Must stamp data-litefin-scaled');

    // Base scale for 375px width against 750px portrait design width is 375 / 750 = 0.5
    const zoom = parseFloat(styles['zoom']);
    assert.ok(Math.abs(zoom - 0.5) < 0.01, `Zoom factor must be approximately 0.5 (actual: ${zoom})`);
    assert.strictEqual(styles['--litefin-app-w'], '750px', 'Counter-expanded width must be 750px');
});

test('Mobile Scaling: Display Scale option scales portrait mobile UI proportionally', () => {
    // Simulate mobile phone in portrait (375x812)
    globalThis.window.innerWidth = 375;
    globalThis.window.innerHeight = 812;

    // Set user display scale to 110% (1.1)
    layoutManager.setDisplayScale('1.1', false);

    // Expected scale: 0.5 base * 1.1 multiplier = 0.55
    const zoom = parseFloat(styles['zoom']);
    assert.ok(Math.abs(zoom - 0.55) < 0.01, `Portrait zoom must scale by 1.1x (actual: ${zoom})`);

    // Test scaling down to 80% (0.8)
    layoutManager.setDisplayScale('0.8', false);
    const zoom80 = parseFloat(styles['zoom']);
    assert.ok(Math.abs(zoom80 - 0.4) < 0.01, `Portrait zoom must scale by 0.8x (actual: ${zoom80})`);
});

test('Mobile Scaling: Display Scale option scales landscape mobile UI proportionally', () => {
    // Simulate mobile phone / tablet in landscape (800x375)
    globalThis.window.innerWidth = 800;
    globalThis.window.innerHeight = 375;

    // Base landscape scale for 800px against 1600px is 800 / 1600 = 0.5
    layoutManager.setDisplayScale('auto', false);

    assert.strictEqual(attributes['data-litefin-portrait'], undefined, 'Must not be portrait');
    assert.strictEqual(attributes['data-litefin-scaled'], '1', 'Must stamp data-litefin-scaled in landscape');

    const baseZoom = parseFloat(styles['zoom']);
    assert.ok(Math.abs(baseZoom - 0.5) < 0.01, `Landscape base zoom must be 0.5 (actual: ${baseZoom})`);

    // Apply 120% display scale
    layoutManager.setDisplayScale('1.2', false);
    const zoom120 = parseFloat(styles['zoom']);
    assert.ok(Math.abs(zoom120 - 0.6) < 0.01, `Landscape zoom must scale to 0.5 * 1.2 = 0.6 (actual: ${zoom120})`);
});

/**
 * ============================================================================
 * Text Scaling Engine & Custom Property Propagation Tests
 * ============================================================================
 * Confirms that setting text scale multiplier:
 *   1. Updates LayoutManager internal tracker.
 *   2. Sets the --litefin-text-scale CSS custom property on the document root,
 *      allowing all calc() expressions across mobile stylesheets to adapt.
 *   3. Sets the base root font-size with priority so that relative rem units
 *      scale proportionately across all layout components.
 *   4. Accurately persists the user's preference to local storage when saved.
 * ============================================================================
 */

test('Text Scaling: setTextScale updates text scale, sets --litefin-text-scale variable, and scales root font-size', () => {
    // Test scale up to 125% (1.25 multiplier)
    layoutManager.setTextScale(1.25, true);

    // Verify getter returns updated numerical scale factor
    assert.strictEqual(layoutManager.getTextScale(), 1.25, 'Text scale getter must return 1.25');

    // Verify --litefin-text-scale CSS variable is propagated to document root
    assert.strictEqual(styles['--litefin-text-scale'], '1.25', '--litefin-text-scale property must be set on document root');

    // Standard base 16px * 1.25 = 20px
    assert.strictEqual(styles['font-size'], '20px', 'Root font-size must be scaled to 20px for 125%');

    // Verify storage persistence key
    assert.strictEqual(storage.getItem('litefin:textScale'), '1.25', 'Must persist text scale to storage');

    // Test scaling down to 80% (0.8 multiplier)
    layoutManager.setTextScale(0.8, false);

    // Verify getter returns 0.8
    assert.strictEqual(layoutManager.getTextScale(), 0.8, 'Text scale getter must return 0.8');

    // Verify property propagation
    assert.strictEqual(styles['--litefin-text-scale'], '0.8', '--litefin-text-scale property must update to 0.8');

    // Standard base 16px * 0.8 = 12.8px
    assert.strictEqual(styles['font-size'], '12.8px', 'Root font-size must be scaled to 12.8px for 80%');

    // Preference was not saved when save=false, so storage remains previous value
    assert.strictEqual(storage.getItem('litefin:textScale'), '1.25', 'Storage must not be overwritten when save=false');

    // Reset back to baseline 1.0 (100%)
    layoutManager.setTextScale(1.0, true);
    assert.strictEqual(layoutManager.getTextScale(), 1.0, 'Reset to 1.0');
    assert.strictEqual(styles['--litefin-text-scale'], '1', '--litefin-text-scale must be 1');
    assert.strictEqual(styles['font-size'], '16px', 'Root font size must be 16px');
    assert.strictEqual(storage.getItem('litefin:textScale'), '1', 'Storage updated to 1');
});

/**
 * ============================================================================
 * Android TV & Landscape Login Layout Isolation Tests
 * ============================================================================
 * Confirms that:
 *   1. Android TV environments (recognized via platformInfo.isTv) never receive
 *      mobile responsive markers (data-litefin-scaled, data-litefin-portrait,
 *      data-litefin-touch) and run at 1:1 framebuffer scale.
 *   2. The mobile stylesheet (android-mobile.css) contains no rules forcing
 *      the login page into mobile/scaled layouts in landscape mode, allowing
 *      Android TV and wide displays to use the normal full-canvas login page.
 * ============================================================================
 */

test('TV Scaling: Android TV bypasses mobile markers and preserves normal login layout in landscape', () => {
    // Save previous platform getters
    const originalIsTv = platformInfo.isTv;
    const originalIsAndroid = platformInfo.isAndroid;
    const originalIsAndroidTv = platformInfo.isAndroidTv;

    try {
        // Mock Android TV platform flags
        Object.defineProperty(platformInfo, 'isTv', { value: true, configurable: true });
        Object.defineProperty(platformInfo, 'isAndroid', { value: true, configurable: true });
        Object.defineProperty(platformInfo, 'isAndroidTv', { value: true, configurable: true });

        // Simulate 1080p landscape TV display (1920x1080)
        globalThis.window.innerWidth = 1920;
        globalThis.window.innerHeight = 1080;

        // Apply display scale calculation
        layoutManager.setDisplayScale('auto', false);

        // Verify that mobile attributes are stripped on Android TV
        assert.strictEqual(attributes['data-litefin-portrait'], undefined, 'Must not stamp data-litefin-portrait on Android TV');
        assert.strictEqual(attributes['data-litefin-scaled'], undefined, 'Must not stamp data-litefin-scaled on Android TV');
        assert.strictEqual(attributes['data-litefin-touch'], undefined, 'Must not stamp data-litefin-touch on Android TV');

        // Verify 1:1 TV scale
        assert.strictEqual(styles['zoom'], undefined, 'Zoom should be removed at 1:1 on TV');
    } finally {
        // Restore platform getters
        Object.defineProperty(platformInfo, 'isTv', { value: originalIsTv, configurable: true });
        Object.defineProperty(platformInfo, 'isAndroid', { value: originalIsAndroid, configurable: true });
        Object.defineProperty(platformInfo, 'isAndroidTv', { value: originalIsAndroidTv, configurable: true });
    }
});

test('Login Layout: android-mobile.css contains no mobile login overrides for landscape or scaled mode', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    // Read active mobile stylesheet
    const cssPath = path.resolve(process.cwd(), 'src/styles/android-mobile.css');
    const cssContent = fs.readFileSync(cssPath, 'utf8');

    // Verify no mobile landscape login overrides targeting data-litefin-scaled exist
    const hasScaledLogin = /html\[data-litefin-scaled\]\s+\.login-page/.test(cssContent);
    assert.strictEqual(hasScaledLogin, false, 'android-mobile.css must not contain html[data-litefin-scaled] .login-page selectors');

    // Verify all mobile login layout overrides are strictly scoped to portrait mode
    const portraitLoginMatches = cssContent.match(/html\[data-litefin-portrait\]\s+\.login-page/g);
    assert.ok(portraitLoginMatches && portraitLoginMatches.length > 0, 'Mobile login overrides must be conditioned on data-litefin-portrait');
});

/**
 * ============================================================================
 * Android TV OSD Playback Info Overlay Isolation Test
 * ============================================================================
 * Confirms that:
 *   1. android-mobile.css does not target #osdPlaybackInfoOverlay with an
 *      unconditional html[data-platform="android"] selector, preventing Android TV
 *      from receiving mobile full-screen height rules.
 *   2. Television hardware retains the standard OSD panel height limits defined
 *      in player-osd.css instead of stretching to full viewport height.
 * ============================================================================
 */
test('OSD Playback Info: android-mobile.css excludes TV hardware and avoids unconditional android selector', async () => {
    // Dynamically load filesystem modules for test execution
    const fs = await import('node:fs');
    const path = await import('node:path');

    // Resolve absolute path to mobile stylesheet
    const cssPath = path.resolve(process.cwd(), 'src/styles/android-mobile.css');
    // Load stylesheet contents as utf-8 string
    const cssContent = fs.readFileSync(cssPath, 'utf8');

    // Check for any unconditional html[data-platform="android"] targeting #osdPlaybackInfoOverlay
    const hasUnconditionalAndroidOsd = /html\[data-platform=["']android["']\]\s+#osdPlaybackInfoOverlay/.test(cssContent);
    // Ensure unconditional targeting is absent to protect 1080p television panels
    assert.strictEqual(
        hasUnconditionalAndroidOsd,
        false,
        'android-mobile.css must not target #osdPlaybackInfoOverlay with unconditional html[data-platform="android"]'
    );

    // Ensure all mobile overrides for #osdPlaybackInfoOverlay explicitly exclude television hardware
    const osdRulesMatches = cssContent.match(/html\[[^\]]*\](?::not\(\[data-device-type="tv"\]\))?\s+#osdPlaybackInfoOverlay/g) || [];
    assert.ok(osdRulesMatches.length > 0, 'Expected mobile overrides for #osdPlaybackInfoOverlay to exist');

    // Validate that every matching selector enforces TV exclusion
    for (const rule of osdRulesMatches) {
        assert.ok(
            rule.includes(':not([data-device-type="tv"])'),
            `Selector "${rule}" must contain :not([data-device-type="tv"]) to safeguard television displays`
        );
    }
});

