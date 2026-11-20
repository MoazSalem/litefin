import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

// ============================================================================
// Environment Mock for ES Module Imports in Node.js
// ============================================================================
// Polyfill minimal browser DOM globals so capability detection routines
// (document.documentElement, localStorage, window) initialize cleanly.
// ============================================================================
const storageMap = new Map();
globalThis.localStorage = {
    getItem: (key) => storageMap.get(key) || null,
    setItem: (key, val) => storageMap.set(key, String(val)),
    removeItem: (key) => storageMap.delete(key),
    clear: () => storageMap.clear()
};

globalThis.document = {
    createElement: () => ({
        getContext: () => ({}),
        setAttribute: () => {},
        removeAttribute: () => {},
        classList: { add: () => {}, remove: () => {}, contains: () => false }
    }),
    documentElement: {
        setAttribute: () => {},
        removeAttribute: () => {},
        getAttribute: () => null
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: () => null,
    querySelectorAll: () => []
};

globalThis.window = globalThis;
globalThis.__APP_VERSION__ = '1.0.0';

// Dynamic imports after environment globals are fully configured
const { storage } = await import('../src/utils/StorageService.js');
const { default: CardRenderer } = await import('../src/utils/CardRenderer.js');
const { layoutManager } = await import('../src/ui/LayoutManager.js');

/**
 * ============================================================================
 * Disable BlurHash in Library - Test Suite
 * ============================================================================
 * Tests that:
 * 1. LayoutManager initializes with Disable Library BlurHash = true by default.
 * 2. LayoutManager get/set methods update storage and notify subscribers.
 * 3. CardRenderer suppresses BlurHash canvas in library grids by default.
 * 4. CardRenderer includes BlurHash canvas in library grids when explicitly enabled.
 * 5. CardRenderer preserves BlurHash canvas in non-library views (e.g. Home rows).
 * 6. Global BlurHash disable takes precedence over library settings.
 * 7. SettingsPage includes the toggle control in the Performance tab.
 * ============================================================================
 */

test('Disable Library BlurHash: LayoutManager initial state and getter/setter', () => {
    // LayoutManager default state should be true (Disable Library BlurHash = ON)
    assert.strictEqual(
        layoutManager.getDisableLibraryBlurhash(),
        true,
        'LayoutManager must default to disabling BlurHash in library grids'
    );

    // Toggle off (enable BlurHash in library)
    layoutManager.setDisableLibraryBlurhash(false);
    assert.strictEqual(
        layoutManager.getDisableLibraryBlurhash(),
        false,
        'LayoutManager getDisableLibraryBlurhash must report false after toggling off'
    );
    assert.strictEqual(
        storage.getItem('pref:disableLibraryBlurhash'),
        'false',
        'Storage pref:disableLibraryBlurhash must be set to "false"'
    );

    // Toggle on (disable BlurHash in library)
    layoutManager.setDisableLibraryBlurhash(true);
    assert.strictEqual(
        layoutManager.getDisableLibraryBlurhash(),
        true,
        'LayoutManager getDisableLibraryBlurhash must report true after toggling on'
    );
    assert.strictEqual(
        storage.getItem('pref:disableLibraryBlurhash'),
        'true',
        'Storage pref:disableLibraryBlurhash must be set to "true"'
    );
});

test('Disable Library BlurHash: CardRenderer behavior under different preference states', () => {
    // Mock item with valid Primary BlurHash data
    const mockItem = {
        Id: 'media-item-12345',
        Name: 'Test Media Title',
        Type: 'Movie',
        ImageTags: { Primary: 'tag-abc-123' },
        ImageBlurHashes: {
            Primary: {
                'tag-abc-123': 'L6PZfSi_.AyE_3t7t7R**0o#DgR4'
            }
        }
    };

    // Ensure cache is pristine before running tests
    CardRenderer.clearCache();

    // ------------------------------------------------------------------------
    // CASE 1: Default state (pref:disableLibraryBlurhash is unset)
    // ------------------------------------------------------------------------
    // When unset, the preference defaults to true (BlurHash disabled in library).
    // Cards rendered with contextType: 'library' or isGrid: true MUST NOT
    // contain any .blurhash-canvas element.
    // ------------------------------------------------------------------------
    storage.removeItem('pref:disableLibraryBlurhash');
    storage.removeItem('litefin:disableBlurhash');

    const libraryHtmlDefault = CardRenderer.createCardHtml(mockItem, {
        contextType: 'library',
        isGrid: true
    });
    assert.strictEqual(
        libraryHtmlDefault.includes('blurhash-canvas'),
        false,
        'Library card with default settings must not render blurhash canvas'
    );

    // ------------------------------------------------------------------------
    // CASE 2: Non-library card with default settings (e.g. Home row)
    // ------------------------------------------------------------------------
    // Home screen rows (contextType: 'home', isGrid: false) should still render
    // the blurhash canvas when global blurhash is not disabled.
    // ------------------------------------------------------------------------
    CardRenderer.clearCache();
    const homeHtmlDefault = CardRenderer.createCardHtml(mockItem, {
        contextType: 'home',
        isGrid: false
    });
    assert.strictEqual(
        homeHtmlDefault.includes('blurhash-canvas'),
        true,
        'Home row card must still render blurhash canvas when library blurhash is disabled'
    );

    // ------------------------------------------------------------------------
    // CASE 3: Explicitly enabled BlurHash in library (pref:disableLibraryBlurhash = 'false')
    // ------------------------------------------------------------------------
    // User switched the toggle off, meaning BlurHash IS enabled in library grids.
    // ------------------------------------------------------------------------
    CardRenderer.clearCache();
    storage.setItem('pref:disableLibraryBlurhash', 'false');

    const libraryHtmlEnabled = CardRenderer.createCardHtml(mockItem, {
        contextType: 'library',
        isGrid: true
    });
    assert.strictEqual(
        libraryHtmlEnabled.includes('blurhash-canvas'),
        true,
        'Library card must render blurhash canvas when pref:disableLibraryBlurhash is false'
    );

    // ------------------------------------------------------------------------
    // CASE 4: Explicitly disabled BlurHash in library (pref:disableLibraryBlurhash = 'true')
    // ------------------------------------------------------------------------
    CardRenderer.clearCache();
    storage.setItem('pref:disableLibraryBlurhash', 'true');

    const libraryHtmlDisabled = CardRenderer.createCardHtml(mockItem, {
        contextType: 'library',
        isGrid: true
    });
    assert.strictEqual(
        libraryHtmlDisabled.includes('blurhash-canvas'),
        false,
        'Library card must not render blurhash canvas when pref:disableLibraryBlurhash is true'
    );

    // ------------------------------------------------------------------------
    // CASE 5: Global blurhash disabled (litefin:disableBlurhash = 'true')
    // ------------------------------------------------------------------------
    // Global disable takes precedence: neither home nor library should have canvas.
    // ------------------------------------------------------------------------
    CardRenderer.clearCache();
    storage.setItem('litefin:disableBlurhash', 'true');
    storage.setItem('pref:disableLibraryBlurhash', 'false');

    const globalDisabledHomeHtml = CardRenderer.createCardHtml(mockItem, {
        contextType: 'home',
        isGrid: false
    });
    assert.strictEqual(
        globalDisabledHomeHtml.includes('blurhash-canvas'),
        false,
        'Global blurhash disable must suppress canvas on home screen cards'
    );

    const globalDisabledLibraryHtml = CardRenderer.createCardHtml(mockItem, {
        contextType: 'library',
        isGrid: true
    });
    assert.strictEqual(
        globalDisabledLibraryHtml.includes('blurhash-canvas'),
        false,
        'Global blurhash disable must suppress canvas on library cards'
    );

    // Cleanup storage after test run
    storage.removeItem('litefin:disableBlurhash');
    storage.removeItem('pref:disableLibraryBlurhash');
    CardRenderer.clearCache();
});

test('Disable Library BlurHash: SettingsPage markup contains toggle in performance section', () => {
    // Read SettingsPage source code
    const settingsSource = readFileSync(new URL('../src/pages/settings/SettingsPage.js', import.meta.url), 'utf8');

    // Verify toggle button ID is declared in HTML template
    assert.strictEqual(
        settingsSource.includes('id="toggle-disable-library-blurhash"'),
        true,
        'SettingsPage template must contain #toggle-disable-library-blurhash button'
    );

    // Verify i18n label is bound in HTML template
    assert.strictEqual(
        settingsSource.includes('data-i18n="LabelDisableLibraryBlurHash"'),
        true,
        'SettingsPage template must bind LabelDisableLibraryBlurHash'
    );

    // Verify event listener is wired up
    assert.strictEqual(
        settingsSource.includes("this.$('#toggle-disable-library-blurhash')"),
        true,
        'SettingsPage must attach event listener to #toggle-disable-library-blurhash'
    );

    // Verify layoutManager setter is invoked in event listener
    assert.strictEqual(
        settingsSource.includes('layoutManager.setDisableLibraryBlurhash(newValue)'),
        true,
        'SettingsPage listener must call layoutManager.setDisableLibraryBlurhash'
    );
});

