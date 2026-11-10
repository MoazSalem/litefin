import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * ============================================================================
 * Main-Thread Long-Task Cluster Regression Suite
 * ============================================================================
 * Guards the four Tizen 9 telemetry long-task clusters:
 *
 *   1. HeroCarousel slide changes  — class-toggle only, idle preloading,
 *                                    decode() before paint, no sync BlurHash.
 *   2. D-pad row transitions       — no forced layout reads on the keypress
 *                                    path (FocusManager ordering + ScrollController
 *                                    metric caching + VirtualCardRow window no-op).
 *   3. HomePage deferred batches   — cache serialization/prewarm deferred to a
 *                                    deduplicated idle task, 600ms follow-up gap.
 *   4. Settings route/culture list — idempotent focus registration + in-place
 *                                    culture dropdown refresh instead of a tab
 *                                    re-render.
 *
 * Source-level assertions are used deliberately: these modules touch browser
 * layout APIs that have no meaningful Node polyfill, and the repo's existing
 * performance suites (e.g. LibraryRowRecyclingOptimization.test.js) follow the
 * same convention.
 * ============================================================================
 */

const read = (relativePath) => fs.readFileSync(path.resolve(relativePath), 'utf8');

const sliceBetween = (source, startMarker, endMarker) => {
    const startIdx = source.indexOf(startMarker);
    assert.ok(startIdx !== -1, `Expected marker "${startMarker}" to exist`);
    const endIdx = source.indexOf(endMarker, startIdx + startMarker.length);
    assert.ok(endIdx !== -1, `Expected end marker "${endMarker}" to exist after "${startMarker}"`);
    return source.slice(startIdx, endIdx);
};

// ============================================================================
// Cluster 1 — HeroCarousel slide transitions
// ============================================================================

test('HeroCarousel: goTo() is a pure class toggle (no preload / BlurHash work)', () => {
    const source = read('src/ui/HeroCarousel.js');
    const goToBody = sliceBetween(source, 'goTo(index) {', '_onItemClick() {');

    assert.ok(
        !goToBody.includes('_preloadSlide('),
        'goTo() must not start image preloads during the transition frame'
    );
    assert.ok(
        !goToBody.includes('_decodeBlurhashFill('),
        'goTo() must not synchronously decode BlurHash during the transition frame'
    );
    assert.ok(
        goToBody.includes('this._scheduleIdlePreload('),
        'goTo() must defer the next preload sweep to idle'
    );
    assert.ok(
        goToBody.includes('items[i].style.visibility !=='),
        'goTo() must guard visibility writes for already-hidden slides'
    );
});

test('HeroCarousel: slide preloads are deduplicated and idle-scheduled', () => {
    const source = read('src/ui/HeroCarousel.js');

    assert.ok(
        source.includes("import { idleGate } from '../utils/IdleGate.js';"),
        'HeroCarousel must import the idle gate'
    );

    const preloadBody = sliceBetween(source, '_preloadSlide(index) {', '_scheduleIdlePreload(delay');
    assert.ok(
        preloadBody.includes('if (this._preloadedSlides[index]) return;'),
        '_preloadSlide must deduplicate per slide index'
    );
    assert.ok(
        !preloadBody.includes('_decodeBlurhashFill('),
        '_preloadSlide must not decode BlurHash (idle sweep owns that work)'
    );
    assert.ok(
        preloadBody.includes('typeof img.decode ==='),
        'Backdrop commit must use img.decode() before painting'
    );

    const sweepBody = sliceBetween(source, '_scheduleIdlePreload(delay = 300) {', 'next() {');
    assert.ok(sweepBody.includes('idleGate.runWhenIdle('), 'Preload sweep must run through idleGate');
    assert.ok(
        sweepBody.includes('this._currentIndex - 1') && sweepBody.includes('this._currentIndex + 2'),
        'Preload sweep must cover the sliding previous/next window'
    );
    assert.ok(
        sweepBody.includes('this._preloadSlide(i)'),
        'Preload sweep must preload the window slides'
    );

    const destroyBody = sliceBetween(source, 'destroy() {', '_decodeBlurhashFill(itemElement)');
    assert.ok(
        destroyBody.includes('idleGate.cancel(this._idlePreloadTask)'),
        'destroy() must cancel the pending idle preload sweep'
    );
});

test('HeroCarousel: BlurHash fill decode is deferred during transitions/scroll', () => {
    const source = read('src/ui/HeroCarousel.js');
    const decodeBody = sliceBetween(source, '_decodeBlurhashFill(itemElement) {', '_handleBlur() {');

    assert.ok(
        decodeBody.includes('this._hideTimeoutId') && decodeBody.includes('isAnimating'),
        'BlurHash fill must detect active transitions and scroll animations'
    );
    assert.ok(
        decodeBody.includes("canvas.dataset.decodeDeferred = '1'"),
        'BlurHash fill must requeue instead of decoding mid-transition'
    );
    assert.ok(
        decodeBody.includes('idleGate.runWhenIdle('),
        'BlurHash fill requeue must go through the idle gate'
    );
});

// ============================================================================
// Cluster 2 — D-pad row transitions
// ============================================================================

test('FocusManager: focusElement measures before mutating focus classes', () => {
    const source = read('src/ui/FocusManager.js');
    const focusBody = sliceBetween(source, 'focusElement(element, options = {}) {', '_scheduleMemoryUpdate() {');

    const scrollIdx = focusBody.indexOf('this._scroll.scrollIntoView(');
    const cleanupIdx = focusBody.indexOf("this._focusedElement.classList.remove('focused')");

    assert.ok(scrollIdx !== -1, 'focusElement must delegate scrolling to ScrollController');
    assert.ok(cleanupIdx !== -1, 'focusElement must still clear the previous .focused class');
    assert.ok(
        scrollIdx < cleanupIdx,
        'Scroll target must be computed BEFORE clearing the old focus class (avoids forced reflow)'
    );
});

test('ScrollController: row/viewport metrics are cached, not read per keypress', () => {
    const source = read('src/ui/ScrollController.js');

    assert.ok(source.includes('this._rowMetrics = new WeakMap();'), 'Row metric cache must exist');
    assert.ok(source.includes('this._containerMetrics = new WeakMap();'), 'Container metric cache must exist');
    assert.ok(source.includes('_getRowMetrics(row, container) {'), '_getRowMetrics helper must exist');
    assert.ok(source.includes('_getContainerMetrics(container) {'), '_getContainerMetrics helper must exist');

    assert.ok(
        !source.includes('const viewHeight = pageContent.clientHeight'),
        'No direct pageContent.clientHeight reads may remain on the scroll path'
    );
    assert.ok(
        !source.includes('const rowHeight = row.offsetHeight'),
        'No direct row.offsetHeight reads may remain on the scroll path'
    );
    assert.ok(
        !source.includes('const rowHeight = parentRow.offsetHeight'),
        'Fallback row branch must use the cached row height'
    );

    assert.ok(
        source.includes("eventBus.on('layout:changed', () => this.invalidateMetrics());"),
        'Metric cache must invalidate on layout preference changes'
    );
    assert.ok(
        source.includes('window.addEventListener(\'resize\', () => this.invalidateMetrics());'),
        'Metric cache must invalidate on viewport resize'
    );

    const resetBody = sliceBetween(source, 'resetCache() {', '\n    }');
    assert.ok(
        resetBody.includes('this.invalidateMetrics();'),
        'resetCache() must drop row/container metrics on page navigation'
    );
});

test('VirtualCardRow: unchanged sliding windows short-circuit _updateWindow', () => {
    const source = read('src/components/VirtualCardRow.js');

    assert.ok(
        source.includes('this._renderedRange = null;'),
        'Rendered range must be tracked from the constructor'
    );

    const updateBody = sliceBetween(source, '_updateWindow(centerIndex) {', 'focusClosestToX(documentX) {');
    assert.ok(
        updateBody.includes('const prevRange = this._renderedRange;'),
        '_updateWindow must compare against the last rendered range'
    );
    assert.ok(
        updateBody.includes('this.domNodes.size === end - start + 1'),
        'Fast path must verify every index in the range is materialized'
    );
    assert.ok(
        updateBody.includes('this._renderedRange = { start, end };'),
        '_updateWindow must record the materialized range'
    );
});

test('LazyLoader: focus handling avoids redundant work on virtual cards', () => {
    const source = read('src/utils/LazyLoader.js');

    assert.ok(
        source.includes("if (document.querySelector('.marquee-active')) {"),
        'Marquee cleanup must short-circuit when nothing is animating'
    );

    const focusBody = sliceBetween(source, "eventBus.on('focus:changed', (target) => {", '_checkTextMarquee(');
    assert.ok(
        focusBody.includes('target.dataset.virtualIndex !== undefined'),
        'VirtualCardRow cards must be detected'
    );
    assert.ok(
        focusBody.includes('if (!isVirtualCard) {'),
        'Sibling batch preloading must be skipped for virtual cards'
    );
});

// ============================================================================
// Cluster 3 — HomePage deferred batches
// ============================================================================

test('HomePage: deferred batch cache work runs in one deduplicated idle task', () => {
    const source = read('src/pages/HomePage.js');

    const loadBody = sliceBetween(
        source,
        'async _loadNextDeferredBatch(',
        '_scheduleDeferredBatchCacheRefresh() {'
    );
    assert.ok(
        !loadBody.includes('this._savePageCache()'),
        '_loadNextDeferredBatch must not serialize the page cache synchronously'
    );
    assert.ok(
        !loadBody.includes('this._prewarmScrollCache()'),
        '_loadNextDeferredBatch must not prewarm the scroll cache synchronously'
    );
    assert.ok(
        loadBody.includes('this._scheduleDeferredBatchCacheRefresh()'),
        '_loadNextDeferredBatch must defer cache work'
    );

    const cacheBody = sliceBetween(
        source,
        '_scheduleDeferredBatchCacheRefresh() {',
        '_setupHomeScrollObserver() {'
    );
    assert.ok(
        cacheBody.includes('if (this._deferredCacheTask) return;'),
        'Cache refresh must be deduplicated'
    );
    assert.ok(cacheBody.includes('idleGate.runWhenIdle('), 'Cache refresh must run through idleGate');
    assert.ok(cacheBody.includes('2000'), 'Cache refresh must require a 2000ms quiet window');
    assert.ok(cacheBody.includes('this._prewarmScrollCache();'), 'Idle task must prewarm the scroll cache');
    assert.ok(cacheBody.includes('this._savePageCache();'), 'Idle task must serialize the page cache');

    const destroyBody = sliceBetween(source, 'onDestroyed() {', '_scheduleDeferredBatchCacheRefresh');
    assert.ok(
        destroyBody.includes('idleGate.cancel(this._deferredCacheTask)'),
        'destroy() must cancel the pending cache refresh task'
    );
});

test('HomePage: deferred batch follow-up uses a 600ms idle threshold', () => {
    const source = read('src/pages/HomePage.js');
    const followupBody = sliceBetween(
        source,
        '_scheduleDeferredBatchFollowup() {',
        '_relinkAdjacentSections('
    );

    assert.ok(
        followupBody.includes('_scheduleHomeIdlePrefetch(600)'),
        'Follow-up prefetch must require 600ms of quiet'
    );
    assert.ok(
        followupBody.includes('scrollController.isAnimating') ||
            followupBody.includes('DEFERRED_BATCH_MIN_SPACING_MS'),
        'Follow-up must keep the animation/spacing guard'
    );
});

// ============================================================================
// Cluster 4 — Settings route & culture list
// ============================================================================

test('SettingsPage: focus registration is idempotent and cultures update in place', () => {
    const source = read('src/pages/settings/SettingsPage.js');

    const setupBody = sliceBetween(source, '_setupFocus() {', 'registerFocusSection(');
    assert.ok(
        setupBody.includes('this._focusLayoutSignature === signature'),
        '_setupFocus must skip re-registration for an unchanged layout'
    );
    assert.ok(
        setupBody.includes("'settings:portrait'") && setupBody.includes("'settings:landscape'"),
        'Focus signature must distinguish portrait and landscape layouts'
    );

    const initBody = sliceBetween(source, 'async onInit(', 'onMounted() {');
    assert.ok(
        !initBody.includes('_switchTab(this.activeTab, true)'),
        'Culture resolution must not re-render the whole tab'
    );
    assert.ok(
        initBody.includes('this._refreshCultureOptions()'),
        'Culture resolution must refresh the dropdown in place'
    );

    const refreshBody = sliceBetween(source, '_refreshCultureOptions() {', '_getFontDropdownOptions(');
    assert.ok(refreshBody.includes("this.$('#subtitle-lang-select-btn')"), 'Refresh must target the language button');
    assert.ok(refreshBody.includes('btn.dataset.options = JSON.stringify(options)'), 'Options must be updated in place');
    assert.ok(refreshBody.includes('.btn-label'), 'Selected label must be updated in place');
});

test('Page: registerFocusSection tracks each section only once', () => {
    const source = read('src/pages/Page.js');
    const registerBody = sliceBetween(source, 'registerFocusSection(name, container, options = {}) {', 'unregisterFocusSection(name) {');

    assert.ok(
        registerBody.includes('this._focusSections.indexOf(name) === -1'),
        'Repeated registrations must not grow the teardown list'
    );
});
