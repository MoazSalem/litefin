import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import SpatialNavigator from '../src/ui/SpatialNavigator.js';

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
        !goToBody.includes('style.visibility') && !goToBody.includes('willChange'),
        'goTo() must strictly toggle classes without visibility or willChange style mutations'
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

    const sweepBody = sliceBetween(source, '_scheduleIdlePreload(delay = 800) {', 'next() {');
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

test('HomePage: deferred batch follow-up uses a 2500ms idle threshold', () => {
    const source = read('src/pages/HomePage.js');
    const followupBody = sliceBetween(
        source,
        '_scheduleDeferredBatchFollowup() {',
        '_relinkAdjacentSections('
    );

    assert.ok(
        followupBody.includes('_scheduleHomeIdlePrefetch(2500)'),
        'Follow-up prefetch must require 2500ms of quiet'
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

// ============================================================================
// Cluster 5 — Shared D-pad style invalidations & layout caching
// ============================================================================

/**
 * Builds a minimal mock element inside a container whose screen-space
 * `getBoundingClientRect()` reacts live to `container.scrollTop` while
 * incrementing counters so tests can verify layout reads are cached.
 *
 * @param {Object} opts Mock geometry and row ownership options
 * @returns {Object} Mock focusable DOM node
 */
function createSpatialMockButton({ contentX, contentY, width = 180, height = 48, container, row = null, onRectRead }) {
    return {
        row,
        // Returns screen-space bounds adjusted for container origin and current scroll offsets
        getBoundingClientRect() {
            if (typeof onRectRead === 'function') onRectRead();
            const cRect = container.getBoundingClientRect(true);
            const top = cRect.top + contentY - (container.scrollTop || 0);
            const left = cRect.left + contentX - (container.scrollLeft || 0);
            return {
                left,
                top,
                right: left + width,
                bottom: top + height,
                width,
                height
            };
        },
        // Supports .setting-item row lookup for vertical settings alignment heuristics
        closest(selector) {
            if (selector === '.setting-item') return row;
            return null;
        }
    };
}

test('SpatialNavigator: caches container-relative bounds across D-pad moves and scroll offsets', () => {
    const nav = new SpatialNavigator();
    let containerRectReads = 0;
    let elementRectReads = 0;

    // Simulate a scrollable section container whose viewport stays fixed at (100, 50)
    const container = {
        scrollLeft: 0,
        scrollTop: 0,
        getBoundingClientRect(internal = false) {
            // Do not double-count internal helper calls from createSpatialMockButton
            if (!internal) containerRectReads++;
            return { left: 100, top: 50, right: 1100, bottom: 850, width: 1000, height: 800 };
        }
    };

    const countElementRead = () => {
        elementRectReads++;
    };

    // Vertically stacked buttons inside the scrollable container
    const btn1 = createSpatialMockButton({ contentX: 40, contentY: 40, container, onRectRead: countElementRead });
    const btn2 = createSpatialMockButton({ contentX: 40, contentY: 140, container, onRectRead: countElementRead });
    const btn3 = createSpatialMockButton({ contentX: 40, contentY: 240, container, onRectRead: countElementRead });
    const candidates = [btn1, btn2, btn3];

    // Step 1: First navigation warms the container-relative cache for all candidates
    const firstNext = nav.findNext(btn1, candidates, 'down', container);
    assert.equal(firstNext, btn2, 'Initial Down move should advance from btn1 to btn2');
    assert.ok(elementRectReads > 0, 'Initial uncached step must measure elements once');

    // Reset read counters and simulate smooth vertical container scrolling
    elementRectReads = 0;
    containerRectReads = 0;
    container.scrollTop = 100;

    // Step 2: Subsequent navigation after scroll must derive bounds purely from container rect
    const secondNext = nav.findNext(btn2, candidates, 'down', container);
    assert.equal(secondNext, btn3, 'Cached Down move after scrollTop change must advance to btn3');
    assert.equal(elementRectReads, 0, 'Subsequent D-pad steps must trigger zero per-element layout reads');
    assert.ok(
        containerRectReads <= 2,
        `Expected at most 2 container rect reads per step, got ${containerRectReads}`
    );

    // Step 3: findClosest must also hit the populated container cache without measuring candidates
    elementRectReads = 0;
    const closest = nav.findClosest(btn1, [btn2, btn3], container);
    assert.equal(closest, btn2, 'findClosest should resolve nearest candidate using cached offsets');
    assert.equal(elementRectReads, 0, 'findClosest must incur zero element reflows when cache is warm');

    // Step 3b: Cross-section origin outside container must measure directly (not scroll with container)
    const originContainer = {
        scrollLeft: 0,
        scrollTop: 0,
        contains(el) {
            return el === btn1 || el === btn2 || el === btn3;
        },
        getBoundingClientRect(internal = false) {
            if (!internal) containerRectReads++;
            return container.getBoundingClientRect(true);
        }
    };
    const sidebarBtn = {
        getBoundingClientRect() {
            elementRectReads++;
            return { left: 10, top: 190, right: 90, bottom: 230, width: 80, height: 40 };
        }
    };
    // Warm originContainer cache at scrollTop=0, then scroll container to y=100 (btn3 moves to screen y=190!)
    nav.findNext(btn1, candidates, 'down', originContainer);
    originContainer.scrollTop = 100;
    elementRectReads = 0;
    const crossClosest = nav.findClosest(sidebarBtn, candidates, originContainer);
    assert.equal(
        crossClosest,
        btn3,
        'Cross-section findClosest must measure external origin live while using scrolled container cache'
    );
    assert.equal(elementRectReads, 1, 'Only external origin outside container should be measured directly');

    // Step 4: Clearing container cache forces fresh layout reads on the next move
    nav.clearCache(container);
    elementRectReads = 0;
    const backUp = nav.findNext(btn2, candidates, 'up', container);
    assert.equal(backUp, btn1, 'Up move after cache invalidation must still resolve btn1');
    assert.ok(elementRectReads > 0, 'clearCache(container) must force fresh element measurements');
});

test('SpatialNavigator: memoizes setting-item row focusable counts per findNext pass', () => {
    const nav = new SpatialNavigator();
    const container = {
        scrollLeft: 0,
        scrollTop: 0,
        getBoundingClientRect() {
            return { left: 0, top: 0, right: 1200, bottom: 900, width: 1200, height: 900 };
        }
    };

    // Track how many times row.querySelectorAll is invoked for row1 and row2
    let row1Queries = 0;
    let row2Queries = 0;

    // Row 1 holds 2 focusables (>1), forcing row2 counts to be evaluated for alignment
    const row1Focusable = { disabled: false, style: {}, classList: { contains: () => false }, hasAttribute: () => false };
    const row1 = {
        querySelectorAll() {
            row1Queries++;
            return [row1Focusable, row1Focusable];
        }
    };

    // Row 2 holds 3 candidate buttons sharing the same row container
    const row2Focusable = { disabled: false, style: {}, classList: { contains: () => false }, hasAttribute: () => false };
    const row2 = {
        querySelectorAll() {
            row2Queries++;
            return [row2Focusable, row2Focusable, row2Focusable];
        }
    };

    const current = createSpatialMockButton({ contentX: 20, contentY: 20, width: 100, container, row: row1 });
    const row1Sibling = createSpatialMockButton({ contentX: 160, contentY: 20, width: 100, container, row: row1 });
    const r2a = createSpatialMockButton({ contentX: 20, contentY: 140, width: 100, container, row: row2 });
    const r2b = createSpatialMockButton({ contentX: 160, contentY: 140, width: 100, container, row: row2 });
    const r2c = createSpatialMockButton({ contentX: 300, contentY: 140, width: 100, container, row: row2 });

    // Down navigation evaluates all three row2 candidates in a single pass
    const target = nav.findNext(current, [current, row1Sibling, r2a, r2b, r2c], 'down', container);
    assert.equal(target, r2a, 'Aligned first item in row2 should be selected');
    assert.equal(row1Queries, 1, 'Current row focusable count must be hoisted once outside loop');
    assert.equal(row2Queries, 1, 'Shared candidate row count must be memoized across all 3 candidates');
});

test('ScrollController: skips redundant <html> attribute writes across D-pad keypresses', () => {
    const source = read('src/ui/ScrollController.js');

    // Verify horizontal scroll mode checks current attribute value before mutating <html>
    const horizBody = sliceBetween(source, '_applyHorizontalScrollMode(mode) {', 'getScrollPhysics() {');
    assert.ok(
        horizBody.includes("document.documentElement.getAttribute('data-horizontal-scroll') === mode"),
        '_applyHorizontalScrollMode must short-circuit when data-horizontal-scroll already matches'
    );

    // Verify scroll physics mode checks current attribute value before mutating <html>
    const physicsBody = sliceBetween(source, '_applyScrollPhysics(physics) {', '_recordFrameDelta(deltaMs) {');
    assert.ok(
        physicsBody.includes("document.documentElement.getAttribute('data-scroll-physics') === physics"),
        '_applyScrollPhysics must short-circuit when data-scroll-physics already matches'
    );
});

test('FocusManager: eliminates getComputedStyle reflows, guards blur(), and forwards container cache', () => {
    const source = read('src/ui/FocusManager.js');

    // 1. Global focusin handler must check loading status via fast class/ancestor presence
    const initBody = sliceBetween(source, '_init() {', '_handleFocusChange(');
    const focusinHandlerStart = initBody.indexOf("document.addEventListener('focusin'");
    assert.ok(focusinHandlerStart !== -1, 'Global focusin listener must exist');
    const focusinHandlerCodeOnly = initBody
        .slice(focusinHandlerStart, focusinHandlerStart + 900)
        .replace(/\/\/.*$/gm, '');
    assert.ok(
        !focusinHandlerCodeOnly.includes('getComputedStyle'),
        'Global focusin handler must not call getComputedStyle() on keypress focus changes'
    );
    assert.ok(
        focusinHandlerCodeOnly.includes("pageLoadingEl.closest('.page.loading') !== null"),
        'Global focusin handler must check ancestor .page.loading presence without layout read'
    );

    // 2. Range slider RTL check must read dir attributes instead of window.getComputedStyle
    const sliderBody = sliceBetween(source, '_handleKey(direction) {', 'register(name, container, options = {}) {');
    assert.ok(
        !sliderBody.includes('getComputedStyle'),
        'Range slider RTL detection must not force style recalc via getComputedStyle'
    );
    assert.ok(
        sliderBody.includes("el.dir === 'rtl'"),
        'Range slider RTL detection must inspect fast el.dir / documentElement.dir attributes'
    );

    // 3. focusElement must only blur() when native activeElement sits on the old control
    const focusBody = sliceBetween(source, 'focusElement(element, options = {}) {', '_scheduleMemoryUpdate() {');
    assert.ok(
        focusBody.includes('document.activeElement === this._focusedElement'),
        'focusElement must guard blur() behind an activeElement equality check'
    );

    // 4. Spatial navigation and cache invalidation must pass section container and guard clearCache
    const moveBody = sliceBetween(source, '_move(direction) {', '_leaveSection(direction) {');
    assert.ok(
        moveBody.includes('this._spatial.findNext(this._focusedElement, focusables, direction, config.container)'),
        '_move() must pass config.container into SpatialNavigator.findNext'
    );

    const restoreBody = sliceBetween(source, '_restoreFocus(sectionName, fromElement = null, options = {}) {', '_activate() {');
    assert.ok(
        restoreBody.includes('this._spatial.findClosest(fromElement, focusables, config.container)'),
        '_restoreFocus() must pass config.container into SpatialNavigator.findClosest'
    );

    const unregisterBody = sliceBetween(source, 'unregister(name) {', 'clearFocus(force = false) {');
    assert.ok(
        unregisterBody.includes("typeof this._spatial?.clearCache === 'function'"),
        'unregister() must safely clear cached geometry for the removed container'
    );

    const invalidateBody = sliceBetween(source, 'invalidateCache(sectionName) {', 'clearMemory(sectionName) {');
    assert.ok(
        invalidateBody.includes('this._spatial.clearCache(cfg.container)') &&
            invalidateBody.includes('this._spatial.clearCache()'),
        'invalidateCache() must forward section container invalidation to SpatialNavigator'
    );
});

// ============================================================================
// Cluster 6 — Bootstrap vs SmartHubManager ytresolver collision
// ============================================================================

test('SmartHubManager & Bootstrap: delegates ytresolver launch when SmartHub owns lifecycle', () => {
    const smartHubSource = read('src/tizen/SmartHubManager.js');
    const bootstrapSource = read('src/index.js');

    // SmartHubManager must expose read-only getters used by bootstrap to detect active ownership
    assert.ok(smartHubSource.includes('get isReady()'), 'SmartHubManager must expose isReady getter');
    assert.ok(smartHubSource.includes('get isSupported()'), 'SmartHubManager must expose isSupported getter');
    assert.ok(
        smartHubSource.includes('get ownsServiceLifecycle()'),
        'SmartHubManager must expose ownsServiceLifecycle getter'
    );

    // Bootstrap must import smartHubManager and defer ytresolver launching when SmartHub is active
    assert.ok(
        bootstrapSource.includes("import { smartHubManager } from './tizen/SmartHubManager.js';"),
        'src/index.js must import smartHubManager'
    );

    const gateIdx = bootstrapSource.indexOf('idleGate.runWhenIdle(');
    assert.ok(gateIdx !== -1, 'Bootstrap idleGate block must exist');
    const gateBody = bootstrapSource.slice(gateIdx, gateIdx + 3500);

    const delegateMarker = 'if (smartHubManager && (smartHubManager.isReady || smartHubManager.isSupported))';
    const delegateIdx = gateBody.indexOf(delegateMarker);
    const launchIdx = gateBody.indexOf('tizen.application.launch(');

    assert.ok(delegateIdx !== -1, 'Bootstrap must check smartHubManager readiness before launching ytresolver');
    assert.ok(launchIdx !== -1, 'Fallback tizen.application.launch must remain for Tizen < 4.0');
    assert.ok(
        delegateIdx < launchIdx,
        'SmartHubManager delegation guard must execute strictly before tizen.application.launch'
    );
    const delegateGuardBody = sliceBetween(gateBody, delegateMarker, '}');
    assert.ok(
        delegateGuardBody.includes('return;'),
        'SmartHubManager guard must return early to skip independent service launch'
    );
});

// ============================================================================
// Cluster 7 — HomePage final-batch cache serialization
// ============================================================================

test('HomePage: schedules _scheduleDeferredBatchCacheRefresh once on final batch only', () => {
    const source = read('src/pages/HomePage.js');
    const loadBody = sliceBetween(source, 'async _loadNextDeferredBatch(', '_scheduleDeferredBatchCacheRefresh() {');

    const branchMarker = 'if (this._nextDeferredDescIndex < this._deferredDescriptors.length)';
    const branchIdx = loadBody.indexOf(branchMarker);
    assert.ok(branchIdx !== -1, 'Deferred batch cursor branch must exist inside _loadNextDeferredBatch');

    // No intermediate batch may queue _scheduleDeferredBatchCacheRefresh before checking remaining rows
    const beforeBranch = loadBody.slice(0, branchIdx);
    assert.ok(
        !beforeBranch.includes('this._scheduleDeferredBatchCacheRefresh()'),
        'Intermediate deferred batches must not queue cache serialization or scroll prewarming'
    );

    // Final branch (when no more deferred descriptors remain) queues cache refresh once
    const afterBranch = loadBody.slice(branchIdx);
    const elseIdx = afterBranch.indexOf('} else {');
    assert.ok(elseIdx !== -1, 'Final completion else-branch must exist');
    const finalBranch = afterBranch.slice(elseIdx);

    assert.ok(
        finalBranch.includes('this._scheduleDeferredBatchCacheRefresh();'),
        'Final batch completion must queue _scheduleDeferredBatchCacheRefresh() once'
    );
    assert.ok(
        finalBranch.includes('this.restoreScrollFocusWhenReady();') && finalBranch.includes('this.markReady();'),
        'Final batch completion must preserve focus restoration and markReady()'
    );
});

// ============================================================================
// Cluster 8 — Settings progressive Appearance mount & deferred font query
// ============================================================================

/**
 * Instantiates SettingsPage in an isolated VM sandbox with instrumented mocks
 * for IdleGate, EventBus, FontLoader, and local storage so we can exercise
 * background font scheduling, subscription deduplication, and chunked bindings.
 */
function createSettingsPerfHarness() {
    const source = read('src/pages/settings/SettingsPage.js')
        .replace(/import\s+[\s\S]*?;/g, '')
        .replace('export default SettingsPage;', 'SettingsPage;');

    const saved = new Map();
    const idleTasks = [];
    const cancelledTasks = [];
    const loaderStyleHandlers = [];
    let loaderUnsubCalls = 0;
    let fontFetchCalls = 0;
    let openedThemeModal = 0;
    let openedLoaderModal = 0;
    let flushCalls = 0;

    // Provide minimal DOM and module globals matching SettingsFallbackFonts harness
    const context = vm.createContext({
        Page: class {
            markReady() {
                this._readyMarked = true;
            }
        },
        platformInfo: { isAndroid: false, isTizen: false, isWebOS: false, isDesktop: false, isWeb: true },
        webosAdapter: { isWebOS: false, updateScreensaverSuppressionPreference() {} },
        availableLanguages: [],
        logger: { create: () => ({ warn() {}, debug() {}, info() {}, error() {} }) },
        i18n: { t: (key) => key, ensureBiDi: (val) => val },
        FontLoader: {
            getFallbackFonts: async () => {
                fontFetchCalls++;
                return [];
            }
        },
        loadCultureOptions: async () => [],
        storage: {
            getItem: (key) => saved.get(key) ?? null,
            setItem: (key, val) => saved.set(key, String(val)),
            flush: () => {
                flushCalls++;
            }
        },
        layoutManager: {
            getMediaRowsLayout: () => 'modern'
        },
        PlayerSettings: {
            get: () => undefined,
            set() {}
        },
        document: { getElementById: () => null },
        window: { removeEventListener() {} },
        focusManager: { invalidateCache() {} },
        // Capture EventBus subscriptions and provide trackable unsubscribe callbacks
        eventBus: {
            on(eventName, handler) {
                if (eventName === 'loaderStyle:changed') {
                    loaderStyleHandlers.push(handler);
                }
                return () => {
                    loaderUnsubCalls++;
                };
            },
            emit() {}
        },
        // Capture IdleGate registrations without executing callbacks prematurely
        idleGate: {
            runWhenIdle(fn, delay, maxWait) {
                const token = { id: idleTasks.length + 1, fn, delay, maxWait };
                idleTasks.push(token);
                return token;
            },
            cancel(token) {
                cancelledTasks.push(token);
            }
        },
        setTimeout,
        clearTimeout
    });

    const SettingsPageClass = vm.runInContext(source, context);
    const createInstance = () => {
        const page = new SettingsPageClass();
        page.$ = () => null;
        page.$$ = () => [];
        page.appearanceTab = { mount() {}, destroy() {} };
        page.dropdownDispatcher = { bindDropdownEvents() {} };
        page.sliderComponent = { bindEvents() {} };
        page._openThemeColorModal = () => {
            openedThemeModal++;
        };
        page._openLoaderStyleModal = () => {
            openedLoaderModal++;
        };
        return page;
    };

    return {
        createInstance,
        saved,
        idleTasks,
        cancelledTasks,
        loaderStyleHandlers,
        getLoaderUnsubCalls: () => loaderUnsubCalls,
        getFontFetchCalls: () => fontFetchCalls,
        getOpenedThemeModal: () => openedThemeModal,
        getOpenedLoaderModal: () => openedLoaderModal,
        getFlushCalls: () => flushCalls
    };
}

test('SettingsPage: defers fallback fonts to IdleGate, cancels on destroy, and deduplicates listener', async () => {
    const harness = createSettingsPerfHarness();

    // 1. Page teardown before idle fires must cancel task and block font XHR
    const destroyedEarlyPage = harness.createInstance();
    await destroyedEarlyPage.onInit();
    assert.equal(destroyedEarlyPage._readyMarked, true, 'onInit must markReady without blocking on fonts');
    assert.equal(harness.getFontFetchCalls(), 0, 'onInit must not fetch fallback fonts synchronously');
    assert.equal(harness.idleTasks.length, 1, 'onInit must schedule one IdleGate font discovery task');
    assert.equal(harness.idleTasks[0].delay, 500);
    assert.equal(harness.idleTasks[0].maxWait, 150);

    destroyedEarlyPage.onBeforeDestroy();
    assert.equal(destroyedEarlyPage._destroyed, true, 'onBeforeDestroy must flag _destroyed');
    assert.equal(harness.cancelledTasks.length, 1, 'onBeforeDestroy must cancel queued font task');
    harness.idleTasks[0].fn();
    assert.equal(harness.getFontFetchCalls(), 0, 'Torn-down page callback must ignore late idle firing');

    // 2. Active page executes deferred font query cleanly once IdleGate fires
    const activePage = harness.createInstance();
    await activePage.onInit();
    assert.equal(harness.idleTasks.length, 2);
    harness.idleTasks[1].fn();
    assert.equal(harness.getFontFetchCalls(), 1, 'Idle callback must trigger fallback font discovery');

    // 3. Switching tabs / re-running _bindContentEvents must attach loaderStyle listener once
    activePage._bindContentEvents();
    activePage._bindContentEvents();
    assert.equal(
        harness.loaderStyleHandlers.length,
        1,
        'loaderStyle:changed EventBus listener must be registered at most once'
    );

    activePage.onBeforeDestroy();
    assert.equal(harness.getLoaderUnsubCalls(), 1, 'onBeforeDestroy must unsubscribe loaderStyle listener');

    // 4. Scoped _bindAppearanceDeferredControls wires WOL input & pickers idempotently
    const handlers = {};
    const wolInput = {
        value: 'aabbccddeeff',
        dataset: {},
        addEventListener(ev, fn) {
            handlers[`wol:${ev}`] = (handlers[`wol:${ev}`] || 0) + 1;
            handlers[`wolFn:${ev}`] = fn;
        }
    };
    const themeBtn = {
        dataset: {},
        addEventListener(ev, fn) {
            handlers[`theme:${ev}`] = (handlers[`theme:${ev}`] || 0) + 1;
            handlers[`themeFn:${ev}`] = fn;
        }
    };
    const loaderBtn = {
        dataset: {},
        addEventListener(ev, fn) {
            handlers[`loader:${ev}`] = (handlers[`loader:${ev}`] || 0) + 1;
            handlers[`loaderFn:${ev}`] = fn;
        }
    };
    const chunkScope = {
        querySelector(sel) {
            if (sel === '#input-wol-mac-address') return wolInput;
            if (sel === '#btn-theme-color-picker') return themeBtn;
            if (sel === '#btn-loader-style-picker') return loaderBtn;
            return null;
        }
    };

    // Call twice on the same mounted chunk and verify listeners bind only once
    activePage._bindAppearanceDeferredControls(chunkScope);
    activePage._bindAppearanceDeferredControls(chunkScope);
    assert.equal(handlers['wol:input'], 1, 'WOL input listener must not bind twice');
    assert.equal(handlers['theme:click'], 1, 'Theme color button listener must not bind twice');
    assert.equal(handlers['loader:click'], 1, 'Loader style button listener must not bind twice');

    // Triggering handlers must format the 12-hex MAC and invoke modal triggers
    handlers['wolFn:change']();
    assert.equal(wolInput.value, 'AA:BB:CC:DD:EE:FF');
    assert.equal(harness.saved.get('pref:wolMacAddress'), 'AA:BB:CC:DD:EE:FF');
    assert.equal(harness.getFlushCalls(), 1);
    handlers['themeFn:click']();
    handlers['loaderFn:click']();
    assert.equal(harness.getOpenedThemeModal(), 1);
    assert.equal(harness.getOpenedLoaderModal(), 1);
});

test('AppearanceTab, DropdownDispatcher & Slider: progressively mount deferred sections in scoped chunks', () => {
    const appearanceSource = read('src/pages/settings/tabs/AppearanceTab.js');

    // Initial synchronous render() holds only primary sections + deferred placeholder container
    const renderBody = sliceBetween(appearanceSource, 'render() {', '_renderTimeAndScreensaverSections() {');
    assert.ok(
        renderBody.includes('<div id="appearance-deferred-sections"></div>'),
        'AppearanceTab.render() must leave below-the-fold placeholder container'
    );
    assert.ok(
        !renderBody.includes('input-wol-mac-address') && !renderBody.includes('btn-theme-color-picker'),
        'AppearanceTab.render() must exclude deferred sections from initial innerHTML parse'
    );

    // All four progressive chunk renderers + combined helper must be present
    for (const methodName of [
        '_renderTimeAndScreensaverSections()',
        '_renderThemeSection()',
        '_renderOsdSection()',
        '_renderExtraAndWolSections()',
        '_renderDeferredSections()'
    ]) {
        assert.ok(appearanceSource.includes(methodName), `AppearanceTab must define ${methodName}`);
    }

    // mount() appends .appearance-deferred-chunk across frames, binds scoped controls, invalidates focus
    const mountBody = sliceBetween(appearanceSource, 'mount(root) {', '_bindListeners(scope, rootContainer) {');
    assert.ok(mountBody.includes('appearance-deferred-chunk'), 'mount() must isolate chunks inside wrapper nodes');
    assert.ok(
        mountBody.includes('this.page._bindAppearanceDeferredControls(chunkEl)') &&
            mountBody.includes('this.page.dropdownDispatcher.bindDropdownEvents(chunkEl)') &&
            mountBody.includes('this.page.sliderComponent.bindEvents(chunkEl)'),
        'Each mounted chunk must scope-bind deferred pickers, dropdowns, and sliders'
    );
    assert.ok(
        mountBody.includes("focusManager.invalidateCache('settings-content')"),
        'Each mounted chunk must invalidate settings-content focus cache'
    );

    const destroyBody = sliceBetween(appearanceSource, 'destroy() {', 'export default AppearanceTab;');
    assert.ok(
        destroyBody.includes('clearTimeout(this._deferredTimer)') &&
            destroyBody.includes('cancelAnimationFrame(this._deferredRaf)'),
        'AppearanceTab.destroy() must cancel any pending deferred timer or rAF'
    );

    // DropdownDispatcher & SettingsSlider must accept optional chunk scope and guard against double-binding
    const dropdownSource = read('src/pages/settings/controllers/SettingsDropdownDispatcher.js');
    const dropdownBody = sliceBetween(dropdownSource, 'bindDropdownEvents(root = null) {', '_applySettingValue(');
    assert.ok(
        dropdownBody.includes("root ? Array.from(root.querySelectorAll('.select-btn'))"),
        'DropdownDispatcher.bindDropdownEvents must restrict queries to chunk root when provided'
    );
    assert.ok(
        dropdownBody.includes("btn.dataset?.dropdownBound === 'true'") &&
            dropdownBody.includes("btn.dataset.dropdownBound = 'true'"),
        'DropdownDispatcher must guard against double-binding across progressive mounts'
    );

    const sliderSource = read('src/pages/settings/components/SettingsSlider.js');
    const sliderBody = sliceBetween(sliderSource, 'bindEvents(root = null) {', '_updateVisualFill(slider, value) {');
    assert.ok(
        sliderBody.includes("root ? Array.from(root.querySelectorAll('.setting-slider'))"),
        'SettingsSlider.bindEvents must restrict queries to chunk root when provided'
    );
    assert.ok(
        sliderBody.includes("slider.dataset?.sliderBound === 'true'") &&
            sliderBody.includes("slider.dataset.sliderBound = 'true'"),
        'SettingsSlider must guard against double-binding across progressive mounts'
    );
});

test('ScrollController: avoids post-scrollTop scrollLeft reflows and unnecessary GPU track queries', () => {
    const source = read('src/ui/ScrollController.js');

    // Guarded WeakSet prevents full-tree .vertical-scroll-track querySelector on native pages.
    assert.ok(
        source.includes('this._gpuTrackedContainers = typeof WeakSet ==='),
        'ScrollController must track containers wrapped with GPU tracks'
    );

    const smoothBody = sliceBetween(
        source,
        "smoothScrollTo(container, targetScroll, duration = null, direction = 'vertical') {",
        '    _springScrollTo({'
    );
    assert.ok(
        smoothBody.includes('!this._gpuTrackedContainers || this._gpuTrackedContainers.has(container)'),
        'Non-GPU mode switch reset must skip DOM query when container was never GPU-tracked'
    );

    // Neither instant snap nor easing completion may read scrollLeft right after scrollTop write.
    assert.ok(
        !smoothBody.includes('if (container.scrollLeft !== 0)') &&
            !smoothBody.includes('if (state.container.scrollLeft !== 0)'),
        'Snap and easing completion must not read scrollLeft after writing scrollTop (pre-clamped at entry)'
    );

    const springBody = sliceBetween(source, '    _springScrollTo({', '_springTrackHorizontal(');
    assert.ok(
        !springBody.includes('container.scrollLeft !== 0'),
        'Spring finalize must not force synchronous layout by reading scrollLeft after scrollTop'
    );
});

test('LazyLoader: moves post-scroll marquee/BlurHash work out of 50ms finish window and guards active scroll', () => {
    const source = read('src/utils/LazyLoader.js');
    const initBody = sliceBetween(source, '_init() {', "if ('IntersectionObserver' in window)");

    // Native scroll listener must not allocate debounce timers every rAF step during ScrollController motion.
    assert.ok(
        initBody.includes('if (sc && sc.isAnimating) {'),
        'Native scroll listener must short-circuit while ScrollController owns an active animation'
    );

    // scroll:finished must use the cancellable 220ms settle scheduler rather than an uncancelled 50ms timer.
    assert.ok(
        initBody.includes('this._schedulePostScrollSettleWork(220,'),
        'scroll:finished must delegate BlurHash/marquee work to cancellable 220ms settle scheduler'
    );
    assert.ok(
        !initBody.includes('}, 50);'),
        'scroll:finished must not spawn an uncancelled 50ms timer inside ScrollController.finish attribution window'
    );
    assert.ok(
        initBody.includes('this._cancelPostScrollSettleWork();'),
        'scroll:started and native scroll must cancel pending post-scroll settle work'
    );

    // focus:changed must guard .marquee-active probe and skip _batchPreloadImages while scrolling.
    assert.ok(
        initBody.includes('if (this._hasActiveMarquee) {'),
        'focus:changed must short-circuit .marquee-active DOM queries when no marquee is active'
    );
    assert.ok(
        initBody.includes('if (!this._isScrolling()) {\n                            this._batchPreloadImages(preloadTarget);') ||
            initBody.includes('if (!this._isScrolling()) {\r\n                            this._batchPreloadImages(preloadTarget);'),
        'focus:changed rAF preload must skip sibling DOM walks while scrolling is active'
    );
});
