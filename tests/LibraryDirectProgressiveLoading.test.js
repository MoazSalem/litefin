/**
 * ============================================================================
 * Tests for Library Page Direct Progressive Loading & 50-Item Page Limit
 * ============================================================================
 * Validates:
 * 1. Default page size configuration in SettingsPage and LibraryPage (50 items).
 * 2. Bypass of LazyLoader.observer for grids with limit < 60 items.
 * 3. Immediate Frame 1 loading for the first 14 visible viewport items.
 * 4. Progressive idle chunk loading (10 items per chunk) for remaining items
 *    via requestIdleCallback with 50ms setTimeout fallback.
 * 5. Bypassing row recycling in _syncVirtualGrid when in skip-lazy mode.
 * 6. Clean lifecycle teardown of idle chunk queue on page unmount / destroy.
 * ============================================================================
 */

import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

test('LibraryPage & SettingsPage: Page size limit defaults to 50 items', () => {
    const settingsSource = readFileSync(new URL('../src/pages/settings/SettingsPage.js', import.meta.url), 'utf8');
    const librarySource = readFileSync(new URL('../src/pages/LibraryPage.js', import.meta.url), 'utf8');
    const liveTvSource = readFileSync(new URL('../src/pages/LiveTvPage.js', import.meta.url), 'utf8');

    // 1. SettingsPage dropdown default fallback
    assert.strictEqual(
        settingsSource.includes("storage.getItem('pref:libraryPageSize') || 50"),
        true,
        "SettingsPage must default libraryPageSize to 50"
    );

    // 2. SettingsPage dropdown option label
    assert.strictEqual(
        settingsSource.includes("{ value: 50, label: '50 (Default)' }"),
        true,
        "SettingsPage dropdown must label 50 as default"
    );

    // 3. LibraryPage initial constructor state fallback
    assert.strictEqual(
        librarySource.includes("parseInt(storage.getItem('pref:libraryPageSize') || 50, 10)"),
        true,
        "LibraryPage constructor must fallback to 50 for limit"
    );

    // 4. LibraryPage dynamic setting change fallback
    assert.strictEqual(
        librarySource.includes("this.state.limit = isInfinite ? 100 : parseInt(newSize, 10) || 50;"),
        true,
        "LibraryPage _onLibraryPageSizeChanged must default to 50 for non-infinite values"
    );

    // 5. LibraryPage _loadItems limit resolution fallback
    assert.strictEqual(
        librarySource.includes("this.state.limit = parseInt(storage.getItem('pref:libraryPageSize') || 50, 10);"),
        true,
        "LibraryPage _loadItems must default to 50 when limit is not set"
    );

    // 6. LiveTvPage pagination limit default
    assert.strictEqual(
        liveTvSource.includes("Number(storage.getItem('pref:libraryPageSize')) || 50"),
        true,
        "LiveTvPage must default pagination limit to 50"
    );
});

test('LibraryPage: Skip lazy loading and row recycling for grids with limit < 60', () => {
    const librarySource = readFileSync(new URL('../src/pages/LibraryPage.js', import.meta.url), 'utf8')
        .replace(/\r\n/g, '\n');

    // 1. Check skip-lazy condition in _renderGrid
    assert.strictEqual(
        librarySource.includes('const isSkipLazy = !this.state.isInfinite && this.state.limit < 60;'),
        true,
        "LibraryPage must calculate isSkipLazy when limit < 60 and not infinite"
    );

    // 2. Pool rows must match totalRows in skip-lazy mode
    assert.strictEqual(
        librarySource.includes('const POOL_ROWS = isSkipLazy ? totalRows : (isListView ? 22 : 10);'),
        true,
        "POOL_ROWS must expand to totalRows in skip-lazy mode so all rows exist in DOM"
    );

    // 3. In _syncVirtualGrid, row recycling must be bypassed in skip-lazy mode
    assert.strictEqual(
        librarySource.includes('if (isSkipLazy || totalRows <= POOL_ROWS) {\n            return;\n        }'),
        true,
        "_syncVirtualGrid must bail out without recycling when isSkipLazy is true"
    );

    // 4. In _restoreGridFocus, lazyLoader.observe(grid) must be bypassed in skip-lazy mode
    assert.strictEqual(
        librarySource.includes('if (this.state.isInfinite || this.state.limit >= 60) {\n            lazyLoader.observe(grid);\n        }'),
        true,
        "_restoreGridFocus must only observe grid when limit >= 60 or infinite"
    );

    // 5. In _hookGridCards, lazyLoader.observer.observe must be skipped when limit < 60
    assert.strictEqual(
        librarySource.includes('const skipLazy = !this.state.isInfinite && this.state.limit < 60;'),
        true,
        "_hookGridCards must derive skipLazy based on limit < 60"
    );
    assert.strictEqual(
        librarySource.includes('else if (!skipLazy && lazyLoader && lazyLoader.observer) {'),
        true,
        "_hookGridCards must avoid registering images with lazyLoader.observer when skipLazy is true"
    );
});

test('LibraryPage: Immediate Frame 1 visible image load & progressive idle chunk queue', () => {
    const librarySource = readFileSync(new URL('../src/pages/LibraryPage.js', import.meta.url), 'utf8');

    // 1. Visible viewport items (first 14) loaded immediately on initial render
    assert.strictEqual(
        librarySource.includes('const initialCount = Math.min(14, allCards.length);'),
        true,
        "Initial immediate load must target the first 14 cards"
    );
    assert.strictEqual(
        librarySource.includes('lazyLoader.forceLoad(img, true);'),
        true,
        "Immediate cards must be loaded eagerly on Frame 1 via forceLoad"
    );

    // 2. Remaining cards scheduled in progressive idle chunks
    assert.strictEqual(
        librarySource.includes('this._scheduleIdleImageChunks(allCards, initialCount);'),
        true,
        "_scheduleIdleImageChunks must be called with remaining card start index"
    );

    // 3. Definition of _scheduleIdleImageChunks exists
    assert.strictEqual(
        librarySource.includes('_scheduleIdleImageChunks(allCards, startIndex = 14)'),
        true,
        "_scheduleIdleImageChunks definition must exist"
    );

    // 4. Chunk size is 10 items
    assert.strictEqual(
        librarySource.includes('const chunkSize = 10;'),
        true,
        "_scheduleIdleImageChunks must batch in chunks of 10 items"
    );

    // 5. Uses window.requestIdleCallback with fallback to 50ms setTimeout
    assert.strictEqual(
        librarySource.includes("typeof window.requestIdleCallback === 'function'"),
        true,
        "_scheduleIdleImageChunks must support window.requestIdleCallback"
    );
    assert.strictEqual(
        librarySource.includes('setTimeout(processNextChunk, 50);'),
        true,
        "_scheduleIdleImageChunks must fall back to 50ms setTimeout"
    );

    // 6. Cancellation helper cancels timers on unmount / destroy
    assert.strictEqual(
        librarySource.includes('_cancelIdleChunkQueue()'),
        true,
        "_cancelIdleChunkQueue method must exist"
    );
    assert.strictEqual(
        librarySource.includes('this._cancelIdleChunkQueue();'),
        true,
        "onDestroyed and destroy must invoke _cancelIdleChunkQueue"
    );
});
