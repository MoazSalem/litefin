import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

/**
 * ============================================================================
 * Library Row Recycling & Image Pre-warming Optimization Test Suite
 * ============================================================================
 * Verifies that:
 * 1. LazyLoader rootMargin uses a wide fixed-pixel vertical lookahead.
 * 2. IntersectionObserver callback loads the intersecting image directly without
 *    cascading _batchPreloadImages on every intersecting card.
 * 3. _hookGridCards accepts an eagerLoad flag (defaulting to false) to register
 *    recycled cards with IntersectionObserver instead of synchronously force-loading.
 * 4. _syncVirtualGrid separates critical DOM recycling and immediate focus cache
 *    invalidation from speculative image work.
 * 5. _schedulePreWarm debounces image pre-warming by 150ms and cancels during rapid motion.
 * 6. _preWarmUpcomingRows lookahead is reduced to 1 row and deduplicates URLs.
 * ============================================================================
 */

test('LazyLoader: rootMargin calibrated and redundant batch preloading removed from observer', () => {
    // Read LazyLoader source code
    const lazySource = readFileSync(new URL('../src/utils/LazyLoader.js', import.meta.url), 'utf8');

    // 1. Verify rootMargin keeps a wide fixed-pixel vertical lookahead
    assert.strictEqual(
        lazySource.includes("const IO_ROOT_MARGIN = '1200px 200px';") &&
            lazySource.includes('rootMargin: IO_ROOT_MARGIN,'),
        true,
        'LazyLoader IntersectionObserver rootMargin must use the 1200px vertical lookahead constant'
    );

    // 2. Verify _batchPreloadImages is NOT called inside the IntersectionObserver callback
    // (IntersectionObserver should only call _loadImage, not cascade multi-row preloads on each card)
    const observerCallbackMatch = lazySource.match(/if\s*\(entry\.isIntersecting\)\s*\{([\s\S]*?)\}\s*\}\);/);
    assert.ok(observerCallbackMatch, 'IntersectionObserver callback block must exist');
    const observerBody = observerCallbackMatch[1];
    assert.strictEqual(
        observerBody.includes('this._batchPreloadImages'),
        false,
        'IntersectionObserver callback must not invoke _batchPreloadImages'
    );
    assert.strictEqual(
        observerBody.includes('this._loadImage(target)'),
        true,
        'IntersectionObserver callback must invoke _loadImage(target)'
    );
});

test('LibraryPage: _hookGridCards registers cards with observers without synchronous forceLoad during recycling', () => {
    // Read LibraryPage source code
    const librarySource = readFileSync(new URL('../src/pages/LibraryPage.js', import.meta.url), 'utf8');

    // Verify _hookGridCards signature accepts eagerLoad = false
    assert.strictEqual(
        librarySource.includes('_hookGridCards(newCards, eagerLoad = false)'),
        true,
        '_hookGridCards must accept eagerLoad flag defaulting to false'
    );

    // Verify eagerLoad guards forceLoad and non-eager paths observe via IntersectionObserver
    assert.strictEqual(
        librarySource.includes('if (eagerLoad) {'),
        true,
        '_hookGridCards must conditionally check eagerLoad'
    );
    assert.strictEqual(
        librarySource.includes('lazyLoader.observer.observe(img)'),
        true,
        '_hookGridCards must register images with lazyLoader.observer when eagerLoad is false'
    );

    // Verify initial viewport render passes eagerLoad = true
    assert.strictEqual(
        librarySource.includes("this._hookGridCards(grid.querySelectorAll('.virtual-grid-row:not([data-skeleton=\"true\"]) .media-card'), true)"),
        true,
        'Initial viewport cards must pass eagerLoad = true'
    );

    // Verify row recycling paths pass eagerLoad = false
    assert.strictEqual(
        librarySource.includes("this._hookGridCards(topRow.querySelectorAll('.media-card'), false)"),
        true,
        'Downward row recycling must pass eagerLoad = false'
    );
    assert.strictEqual(
        librarySource.includes("this._hookGridCards(bottomRow.querySelectorAll('.media-card'), false)"),
        true,
        'Upward row recycling must pass eagerLoad = false'
    );
});

test('LibraryPage: _syncVirtualGrid restores focus cache immediately and delegates pre-warming to _schedulePreWarm', () => {
    // Read LibraryPage source code
    const librarySource = readFileSync(new URL('../src/pages/LibraryPage.js', import.meta.url), 'utf8')
        .replace(/\r\n/g, '\n');

    // Verify focus cache invalidation runs once when domChanged is true
    assert.strictEqual(
        librarySource.includes("focusManager.invalidateCache('library-grid');\n            // Schedule speculative lookahead image pre-warming after the navigation frame\n            this._schedulePreWarm(endRow + 1, 1);"),
        true,
        '_syncVirtualGrid must invalidate focus cache immediately and schedule pre-warming for 1 row'
    );

    // Verify large jump branch also uses _schedulePreWarm with 1 row
    assert.strictEqual(
        librarySource.includes('this._schedulePreWarm(this._currentEndRow + 1, 1);'),
        true,
        '_syncVirtualGrid large jump branch must schedule pre-warming with lookahead 1'
    );
});

test('LibraryPage: _schedulePreWarm and _preWarmUpcomingRows deduplicate work and reduce lookahead', () => {
    // Read LibraryPage source code
    const librarySource = readFileSync(new URL('../src/pages/LibraryPage.js', import.meta.url), 'utf8');

    // 1. Verify _schedulePreWarm definition exists
    assert.strictEqual(
        librarySource.includes('_schedulePreWarm(targetRow, rowCount = 1)'),
        true,
        '_schedulePreWarm must be defined with default rowCount = 1'
    );

    // 2. Verify debounce timer logic
    assert.strictEqual(
        librarySource.includes('this._preWarmTimer = setTimeout('),
        true,
        '_schedulePreWarm must use setTimeout to debounce pre-warming'
    );
    assert.strictEqual(
        librarySource.includes('performance.now() - (this._lastGridNavTime || 0) < 140'),
        true,
        '_schedulePreWarm must bail if user is moving rapidly'
    );

    // 3. Verify _preWarmUpcomingRows defaults to 1 row lookahead
    assert.strictEqual(
        librarySource.includes('_preWarmUpcomingRows(targetRow, rowCount = 1)'),
        true,
        '_preWarmUpcomingRows must default to 1 row lookahead'
    );

    // 4. Verify _preWarmedUrls Set deduplication
    assert.strictEqual(
        librarySource.includes('this._preWarmedUrls.has(url)'),
        true,
        '_preWarmUpcomingRows must check _preWarmedUrls to prevent duplicate requests'
    );
    assert.strictEqual(
        librarySource.includes('this._preWarmedUrls.add(url)'),
        true,
        '_preWarmUpcomingRows must record pre-warmed URLs in _preWarmedUrls'
    );

    // 5. Verify onDestroyed cleans up timers and image preloads
    assert.strictEqual(
        librarySource.includes('imageCache.cancel()'),
        true,
        'onDestroyed must cancel in-flight imageCache requests'
    );
    assert.strictEqual(
        librarySource.includes('clearTimeout(this._preWarmTimer)'),
        true,
        'onDestroyed must clear pending _preWarmTimer'
    );
});
