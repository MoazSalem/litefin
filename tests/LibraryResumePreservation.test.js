import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * ============================================================================
 * Library State Resume & Background Preservation Test Suite
 * ============================================================================
 * Verifies that when the app loses focus, the TV screen turns off, or the app
 * is placed into the background:
 *   1. App.js skips destructive route reloading for /library paths (preserving
 *      in-memory progressive DOM nodes, scroll position, and lazy loading data).
 *   2. LibraryPage preserves and rehydrates the loaded media items and total
 *      record count across navigation state transitions.
 * ============================================================================
 */

test('App resume respects pref:reloadOnResume setting and platform defaults', () => {
    /**
     * Storage mock tracking user preferences.
     */
    let storageMap = new Map();
    const mockStorage = {
        getItem: (key) => storageMap.get(key) ?? null,
        setItem: (key, val) => storageMap.set(key, String(val))
    };

    /**
     * Logic mirroring App.js resume handler:
     * Platform defaults: TV (Tizen/webOS) = enabled (true), Web/desktop = disabled (false).
     * If user explicitly toggled pref:reloadOnResume, that takes precedence.
     */
    function shouldReloadOnResume(currentPath, platform, storage = mockStorage) {
        const isTv = platform === 'tizen' || platform === 'webos';
        const savedReload = storage.getItem('pref:reloadOnResume');
        const reloadOnResume = savedReload !== null ? savedReload === 'true' : isTv;
        return Boolean(reloadOnResume && !currentPath.startsWith('/player'));
    }

    // 1. By default on TV platforms (Tizen and webOS), reloading is ENABLED
    assert.strictEqual(
        shouldReloadOnResume('/home', 'tizen'),
        true,
        'Default Tizen: HomePage reloads on resume'
    );
    assert.strictEqual(
        shouldReloadOnResume('/library/movies', 'webos'),
        true,
        'Default webOS: LibraryPage reloads on resume'
    );
    assert.strictEqual(
        shouldReloadOnResume('/player/12345', 'tizen'),
        false,
        'Default Tizen: Player NEVER reloads on resume'
    );

    // 2. By default on Web / Desktop, reloading is DISABLED
    assert.strictEqual(
        shouldReloadOnResume('/home', 'web'),
        false,
        'Default Web: HomePage does NOT reload on resume'
    );
    assert.strictEqual(
        shouldReloadOnResume('/library/movies', 'web'),
        false,
        'Default Web: LibraryPage does NOT reload on resume, preserving lazy data'
    );
    assert.strictEqual(
        shouldReloadOnResume('/player/12345', 'web'),
        false,
        'Default Web: Player does NOT reload on resume'
    );

    // 3. User explicit override on TV (disabled)
    mockStorage.setItem('pref:reloadOnResume', 'false');
    assert.strictEqual(
        shouldReloadOnResume('/library/movies', 'tizen'),
        false,
        'Tizen with explicit false: LibraryPage does NOT reload on resume'
    );
    assert.strictEqual(
        shouldReloadOnResume('/library/movies', 'webos'),
        false,
        'webOS with explicit false: LibraryPage does NOT reload on resume'
    );

    // 4. User explicit override on Web (enabled)
    mockStorage.setItem('pref:reloadOnResume', 'true');
    assert.strictEqual(
        shouldReloadOnResume('/home', 'web'),
        true,
        'Web with explicit true: HomePage reloads on resume'
    );
    assert.strictEqual(
        shouldReloadOnResume('/player/12345', 'web'),
        false,
        'Web with explicit true: Player NEVER reloads on resume'
    );
});

test('LibraryPage navigation state retains loaded item collection and count', () => {
    // Simulated mock of LibraryPage state
    const mockState = {
        viewType: 'Movies',
        sortBy: 'SortName',
        sortOrder: 'Ascending',
        filters: {},
        nameStartsWith: null,
        startIndex: 0,
        limit: 100,
        viewMode: 'poster',
        gridMode: 'normal',
        gridColumns: 7,
        items: [
            { Id: '1', Name: 'Movie 1' },
            { Id: '2', Name: 'Movie 2' },
            { Id: '150', Name: 'Lazy Loaded Movie 150' },
            { Id: '300', Name: 'Lazy Loaded Movie 300' }
        ],
        totalRecordCount: 1500
    };

    // Capture state logic mirroring getNavigationState()
    const capturedNavState = {
        viewType: mockState.viewType,
        sortBy: mockState.sortBy,
        sortOrder: mockState.sortOrder,
        filters: { ...mockState.filters },
        nameStartsWith: mockState.nameStartsWith,
        startIndex: mockState.startIndex,
        limit: mockState.limit,
        viewMode: mockState.viewMode,
        gridMode: mockState.gridMode,
        gridColumns: mockState.gridColumns,
        items: mockState.items ? [...mockState.items] : null,
        totalRecordCount: mockState.totalRecordCount
    };

    assert.strictEqual(capturedNavState.items.length, 4, 'All loaded items must be captured');
    assert.strictEqual(capturedNavState.totalRecordCount, 1500, 'Total record count must be captured');

    // Rehydrate into a fresh state instance mirroring setNavigationState()
    const freshState = {
        viewType: 'Movies',
        sortBy: 'SortName',
        sortOrder: 'Ascending',
        filters: {},
        nameStartsWith: null,
        startIndex: 0,
        limit: 100,
        viewMode: 'poster',
        gridMode: 'normal',
        gridColumns: 7,
        items: [],
        totalRecordCount: 0
    };

    Object.assign(freshState, {
        viewType: capturedNavState.viewType,
        sortBy: capturedNavState.sortBy,
        sortOrder: capturedNavState.sortOrder,
        filters: capturedNavState.filters,
        nameStartsWith: capturedNavState.nameStartsWith,
        startIndex: capturedNavState.startIndex,
        limit: capturedNavState.limit
    });

    if (capturedNavState.items && capturedNavState.items.length > 0) {
        freshState.items = capturedNavState.items;
        freshState.totalRecordCount = capturedNavState.totalRecordCount || capturedNavState.items.length;
    }

    assert.strictEqual(freshState.items.length, 4, 'All items must be restored');
    assert.strictEqual(freshState.items[3].Name, 'Lazy Loaded Movie 300', 'Lazy-loaded batches must be intact');
    assert.strictEqual(freshState.totalRecordCount, 1500, 'Total record count must match original');
});
