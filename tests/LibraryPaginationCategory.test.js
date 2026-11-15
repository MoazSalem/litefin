import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/**
 * ============================================================================
 * Library Page Pagination Category & Tab Preservation Test Suite
 * ============================================================================
 * Verifies that:
 *   1. LibraryPage rehydrates the active viewType from 'tab' / 'viewType'
 *      query parameters during onInit so deep links and page changes do not
 *      revert back to the primary library default (e.g. Movies).
 *   2. _handlePageChange preserves the active category (Collections, Genres,
 *      Favorites, Episodes, etc.) in the URL navigation parameters.
 *   3. _handleTabClick properly updates in-memory route parameters and resets
 *      prior page and letter-jump query state.
 *   4. Cache keys in _getCacheKey are partitioned by tab to avoid cross-tab
 *      state collisions.
 * ============================================================================
 */

test('LibraryPage source integrity: category tab rehydration and pagination propagation', () => {
    // Resolve path to LibraryPage.js using import.meta.url for cwd portability
    const libraryPath = new URL('../src/pages/LibraryPage.js', import.meta.url);
    const source = readFileSync(libraryPath, 'utf8');

    // ------------------------------------------------------------------------
    // Check 1: onInit tab parameter rehydration
    // ------------------------------------------------------------------------
    // Ensure onInit extracts tab or viewType and sets this.state.viewType
    assert.match(
        source,
        /const\s+tabParam\s*=\s*this\.params\.tab\s*\|\|\s*this\.params\.viewType;[\s\S]*?this\.state\.viewType\s*=\s*decodeURIComponent\(tabParam\);/,
        'LibraryPage.onInit must restore viewType from tab or viewType query parameter'
    );

    // ------------------------------------------------------------------------
    // Check 2: _getCacheKey tab partitioning
    // ------------------------------------------------------------------------
    // Ensure cache key differentiates by tab so state data is cached per category
    assert.match(
        source,
        /const\s+tab\s*=\s*this\.params\.tab\s*\|\|\s*this\.params\.viewType[\s\S]*?parts\.push\(`tab:\$\{tab\}`\);/,
        'LibraryPage._getCacheKey must incorporate active tab into cache key'
    );

    // ------------------------------------------------------------------------
    // Check 3: _handleTabClick route parameter synchronization
    // ------------------------------------------------------------------------
    // Ensure switching tabs clears old page/char and saves the active tab
    assert.match(
        source,
        /delete\s+this\.params\.page;[\s\S]*?delete\s+this\.params\.char;[\s\S]*?this\.params\.tab\s*=\s*newType;/,
        'LibraryPage._handleTabClick must synchronize route parameters and clear page/char'
    );

    // ------------------------------------------------------------------------
    // Check 4: _handlePageChange category preservation
    // ------------------------------------------------------------------------
    // Ensure pagination sends active tab parameter along with target page
    assert.match(
        source,
        /const\s+activeTab\s*=\s*this\.state\.viewType\s*\|\|\s*this\.params\.tab;[\s\S]*?currentParams\.set\('tab',\s*activeTab\);/,
        'LibraryPage._handlePageChange must preserve activeTab in currentParams across page changes'
    );
});

test('LibraryPage functional simulation: Next Page preserves Collections category in web request', () => {
    // Mock simulation of LibraryPage pagination logic
    const state = {
        libraryId: 'movies-lib-123',
        viewType: 'Collections',
        startIndex: 0,
        limit: 100,
        totalRecordCount: 350,
        isInfinite: false,
        nameStartsWith: null
    };

    const params = {
        id: 'movies-lib-123',
        tab: 'Collections'
    };

    let navigatedRoute = null;
    const router = {
        navigate(url) {
            navigatedRoute = url;
        }
    };

    function simulatePageChange(direction) {
        if (state.isInfinite) return;

        const isSeerr = state.libraryId === 'seerr';
        const pageLimit = isSeerr ? 100 : state.limit || 100;
        const currentPage = Math.floor(state.startIndex / pageLimit) + 1;
        const totalPages = Math.ceil(state.totalRecordCount / pageLimit) || 1;
        const targetPage = currentPage + direction;

        if (targetPage < 1 || targetPage > totalPages) return;

        const currentParams = new URLSearchParams();

        if (params && typeof params === 'object') {
            for (const [key, value] of Object.entries(params)) {
                if (key !== 'id' && key !== 'page' && value !== undefined && value !== null && value !== '') {
                    currentParams.set(key, value);
                }
            }
        }

        const selectedChar = state.nameStartsWith || params.char;
        if (selectedChar) {
            currentParams.set('char', selectedChar);
        } else {
            currentParams.delete('char');
        }

        const activeTab = state.viewType || params.tab;
        if (activeTab && activeTab !== 'Items') {
            currentParams.set('tab', activeTab);
        } else {
            currentParams.delete('tab');
            currentParams.delete('viewType');
        }

        currentParams.set('page', targetPage);

        router.navigate(`/library/${state.libraryId}?${currentParams.toString()}`);
    }

    // Advance to Next Page
    simulatePageChange(1);

    // Verify destination route preserves Collections category and page 2
    assert.equal(
        navigatedRoute,
        '/library/movies-lib-123?tab=Collections&page=2',
        'Next Page navigation must preserve tab=Collections in URL query parameters'
    );

    // Simulate page 2 load via onInit rehydration
    const newParams = {
        id: 'movies-lib-123',
        tab: 'Collections',
        page: '2'
    };

    const page2State = {
        libraryId: newParams.id,
        viewType: 'Items', // default value in constructor
        startIndex: 0,
        limit: 100
    };

    // onInit category rehydration
    const tabParam = newParams.tab || newParams.viewType;
    if (tabParam) {
        page2State.viewType = decodeURIComponent(tabParam);
    }

    // onInit page calculation
    if (newParams.page) {
        const pageNum = parseInt(newParams.page, 10);
        if (!isNaN(pageNum) && pageNum > 0) {
            page2State.startIndex = (pageNum - 1) * page2State.limit;
        }
    }

    // Verify state after loading page 2
    assert.equal(page2State.viewType, 'Collections', 'viewType must be restored to Collections on page 2');
    assert.equal(page2State.startIndex, 100, 'startIndex must be 100 for page 2 with limit 100');

    // Simulate clicking Next Page again from page 2
    state.startIndex = page2State.startIndex;
    params.page = '2';
    simulatePageChange(1);

    assert.equal(
        navigatedRoute,
        '/library/movies-lib-123?tab=Collections&page=3',
        'Next Page navigation from page 2 must increment to page 3 while retaining tab=Collections'
    );
});

test('LibraryPage functional simulation: Items (default) category keeps clean URL without redundant tab parameter', () => {
    // Standard library view on Movies tab
    const state = {
        libraryId: 'movies-lib-456',
        viewType: 'Items',
        startIndex: 0,
        limit: 50,
        totalRecordCount: 200,
        isInfinite: false,
        nameStartsWith: null
    };

    const params = {
        id: 'movies-lib-456'
    };

    let navigatedRoute = null;
    const router = {
        navigate(url) {
            navigatedRoute = url;
        }
    };

    function simulatePageChange(direction) {
        const pageLimit = state.limit || 50;
        const currentPage = Math.floor(state.startIndex / pageLimit) + 1;
        const totalPages = Math.ceil(state.totalRecordCount / pageLimit) || 1;
        const targetPage = currentPage + direction;

        if (targetPage < 1 || targetPage > totalPages) return;

        const currentParams = new URLSearchParams();

        if (params && typeof params === 'object') {
            for (const [key, value] of Object.entries(params)) {
                if (key !== 'id' && key !== 'page' && value !== undefined && value !== null && value !== '') {
                    currentParams.set(key, value);
                }
            }
        }

        const activeTab = state.viewType || params.tab;
        if (activeTab && activeTab !== 'Items') {
            currentParams.set('tab', activeTab);
        } else {
            currentParams.delete('tab');
            currentParams.delete('viewType');
        }

        currentParams.set('page', targetPage);
        router.navigate(`/library/${state.libraryId}?${currentParams.toString()}`);
    }

    simulatePageChange(1);

    assert.equal(
        navigatedRoute,
        '/library/movies-lib-456?page=2',
        'Primary Items view must keep clean URL with page parameter only'
    );
});
