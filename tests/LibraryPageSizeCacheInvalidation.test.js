import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

// ============================================================================
// Polyfill minimal browser DOM globals for Node test runner
// ============================================================================
globalThis.localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {}
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
globalThis.window = {
    location: { hash: '#/home', replace: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {}
};
globalThis.__APP_VERSION__ = '1.0.0';

/**
 * ============================================================================
 * Library Page Size Cache Invalidation Test Suite
 * ============================================================================
 * Verifies that when the library items limit setting (pref:libraryPageSize)
 * is changed:
 *   1. SettingsPage clears cached library page state snapshots in StateManager.
 *   2. SettingsPage clears captured page state in Router history for library routes.
 *   3. SettingsPage emits both raw and canonical change events on EventBus.
 *   4. Router provides clearHistoryState to purge snapshots matching a prefix.
 *   5. LibraryPage invalidates stale memory cache and navigation state if
 *      limit or infinite pagination mode has changed while on other pages.
 *   6. LibraryPage _loadItems resolves active limit directly from StorageService.
 *   7. LibraryPage dynamic event handler flushes cache and items immediately.
 * ============================================================================
 */

test('SettingsPage: libraryPageSize change invalidates StateManager caches and Router history', () => {
    const settingsSource = readFileSync(new URL('../src/pages/settings/SettingsPage.js', import.meta.url), 'utf8')
        .replace(/\r\n/g, '\n');

    // 1. Verify StateManager cache invalidation
    assert.strictEqual(
        settingsSource.includes("state.clearByPrefix('library:state');"),
        true,
        'SettingsPage must call state.clearByPrefix("library:state") when libraryPageSize changes'
    );

    // 2. Verify Router history state clearing
    assert.strictEqual(
        settingsSource.includes("router.clearHistoryState('/library');"),
        true,
        'SettingsPage must call router.clearHistoryState("/library") when libraryPageSize changes'
    );

    // 3. Verify canonical event emission
    assert.strictEqual(
        settingsSource.includes("eventBus.emit('pref:libraryPageSize:changed', newValue);"),
        true,
        'SettingsPage must emit pref:libraryPageSize:changed event on EventBus'
    );
});

test('Router: clearHistoryState purges captured page state for matching routes', async () => {
    const routerSource = readFileSync(new URL('../src/core/Router.js', import.meta.url), 'utf8');

    // 1. Verify method definition exists
    assert.strictEqual(
        routerSource.includes('clearHistoryState(pathPrefix) {'),
        true,
        'Router must define clearHistoryState method'
    );

    // 2. Behavioral verification of history state clearing
    const { default: Router } = await import('../src/core/Router.js');
    const mockRouter = new Router();
    mockRouter.setHistory([
        { path: '/home', state: { focusSection: 'hero' } },
        { path: '/library/movies', state: { pageState: { limit: 50, items: [1, 2] } } },
        { path: '/library/tv', state: { pageState: { limit: 50, items: [3, 4] } } },
        { path: '/settings', state: null }
    ]);

    mockRouter.clearHistoryState('/library');

    const history = mockRouter.getHistory();
    assert.notStrictEqual(history[0].state, null, 'Non-library history entry must retain its state');
    assert.strictEqual(history[1].state, null, 'First library entry state must be cleared');
    assert.strictEqual(history[2].state, null, 'Second library entry state must be cleared');
});

test('LibraryPage: Validates active page size limit on init and setNavigationState', () => {
    const librarySource = readFileSync(new URL('../src/pages/LibraryPage.js', import.meta.url), 'utf8')
        .replace(/\r\n/g, '\n');

    // 1. Verify onInit checks active limit and detects mismatch
    assert.strictEqual(
        librarySource.includes("const activePageSize = storage.getItem('pref:libraryPageSize');"),
        true,
        'LibraryPage onInit must query active pref:libraryPageSize setting'
    );
    assert.strictEqual(
        librarySource.includes('cachedLimit !== activeLimit || cachedIsInfinite !== activeIsInfinite'),
        true,
        'LibraryPage onInit must detect limit or infinite pagination mode mismatch'
    );
    assert.strictEqual(
        librarySource.includes('state.delete(cacheKey);\n                savedState = null;'),
        true,
        'LibraryPage onInit must delete stale cache entry when limit mismatch occurs'
    );

    // 2. Verify setNavigationState detects mismatch and discards stale items
    assert.strictEqual(
        librarySource.includes('savedState.limit !== activeLimit || savedState.isInfinite !== activeIsInfinite'),
        true,
        'setNavigationState must detect limit or isInfinite mismatch'
    );
    assert.strictEqual(
        librarySource.includes('this.state.items = [];\n            this.state.totalRecordCount = 0;'),
        true,
        'setNavigationState must discard cached item collection on limit mismatch'
    );

    // 3. Verify _loadItems always reads active setting
    assert.strictEqual(
        librarySource.includes("this.state.limit = parseInt(storage.getItem('pref:libraryPageSize') || 50, 10);"),
        true,
        '_loadItems must resolve limit directly from StorageService'
    );

    // 4. Verify dynamic listener handles both events and clears cache
    assert.strictEqual(
        librarySource.includes("eventBus.on('pref:libraryPageSize', this._onLibraryPageSizeChanged);"),
        true,
        'LibraryPage must listen to pref:libraryPageSize'
    );
    assert.strictEqual(
        librarySource.includes("eventBus.on('pref:libraryPageSize:changed', this._onLibraryPageSizeChanged);"),
        true,
        'LibraryPage must listen to pref:libraryPageSize:changed'
    );
    assert.strictEqual(
        librarySource.includes('state.delete(this._getCacheKey());\n                this._loadItems();'),
        true,
        '_onLibraryPageSizeChanged must delete cache key and invoke _loadItems'
    );
});
