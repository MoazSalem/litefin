import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * ============================================================================
 * HomePage Deferred Row Batching & VersionChecker Idle Gating Test Suite
 * ============================================================================
 * Verifies that HomePage deferred batch mounting and VersionChecker startup
 * update checks are routed through idleGate to prevent DOM insertions, network
 * calls, and toast overlays from colliding with initial D-pad navigation or
 * smooth scrolling animations.
 * ============================================================================
 */

test('VersionChecker: checkAtStartup routes through idleGate.runWhenIdle', () => {
    const vcPath = path.resolve('src/utils/VersionChecker.js');
    const source = fs.readFileSync(vcPath, 'utf8');

    // Confirm idleGate is imported
    assert.ok(
        source.includes("import { idleGate } from './IdleGate.js';"),
        'VersionChecker must import idleGate'
    );

    // Locate checkAtStartup definition
    const methodIdx = source.indexOf('checkAtStartup()');
    assert.ok(methodIdx !== -1, 'checkAtStartup must exist');

    const methodBody = source.slice(methodIdx, methodIdx + 1200);

    // Verify setTimeout is NOT used and runWhenIdle is used
    assert.strictEqual(
        methodBody.includes('setTimeout('),
        false,
        'checkAtStartup must not use unconditional setTimeout'
    );
    assert.ok(
        methodBody.includes('idleGate.runWhenIdle('),
        'checkAtStartup must route check through idleGate.runWhenIdle'
    );
    assert.ok(
        methodBody.includes('5000'),
        'checkAtStartup should require a 5000ms idle threshold'
    );
});

test('HomePage: Deferred batch prefetch is gated behind idleGate', () => {
    const homePath = path.resolve('src/pages/HomePage.js');
    const source = fs.readFileSync(homePath, 'utf8');

    // Confirm idleGate is imported
    assert.ok(
        source.includes("import { idleGate } from '../utils/IdleGate.js';"),
        'HomePage must import idleGate'
    );

    // Verify _scheduleHomeIdlePrefetch method definition uses idleGate.runWhenIdle
    const prefetchIdx = source.indexOf('_scheduleHomeIdlePrefetch(delay');
    assert.ok(prefetchIdx !== -1, '_scheduleHomeIdlePrefetch definition must exist');

    const prefetchBody = source.slice(prefetchIdx, prefetchIdx + 1200);
    assert.ok(
        prefetchBody.includes('idleGate.runWhenIdle('),
        '_scheduleHomeIdlePrefetch must use idleGate.runWhenIdle'
    );

    // Verify _loadNextDeferredBatch checks isScrollAnimating and isUserActive
    const loadIdx = source.indexOf('async _loadNextDeferredBatch(');
    assert.ok(loadIdx !== -1, '_loadNextDeferredBatch must exist');

    const loadBody = source.slice(loadIdx, loadIdx + 1200);
    assert.ok(
        loadBody.includes('idleGate.isUserActive('),
        '_loadNextDeferredBatch must check idleGate.isUserActive'
    );
    assert.ok(
        loadBody.includes('scrollController.isAnimating'),
        '_loadNextDeferredBatch must check scrollController.isAnimating'
    );

    // Verify destroy cancels idle prefetch task
    const destroyIdx = source.indexOf('destroy()');
    assert.ok(destroyIdx !== -1, 'destroy must exist');

    const destroyBody = source.slice(destroyIdx, destroyIdx + 600);
    assert.ok(
        destroyBody.includes('idleGate.cancel(this._homeIdlePrefetchTask)'),
        'destroy must cancel any pending _homeIdlePrefetchTask'
    );
});

test('HomePage: consecutive deferred batches are spaced by a real-time gap', () => {
    const homePath = path.resolve('src/pages/HomePage.js');
    const source = fs.readFileSync(homePath, 'utf8');

    assert.ok(
        source.includes('const DEFERRED_BATCH_MIN_SPACING_MS = 800;'),
        'A minimum 800ms spacing constant must exist'
    );

    // The follow-up scheduler must wait via setTimeout BEFORE registering the
    // next idleGate task, instead of registering it immediately.
    const followupIdx = source.indexOf('_scheduleDeferredBatchFollowup() {');
    assert.ok(followupIdx !== -1, '_scheduleDeferredBatchFollowup definition must exist');

    const followupBody = source.slice(followupIdx, followupIdx + 1600);
    assert.ok(
        followupBody.includes('setTimeout(registerNext, wait)'),
        'Follow-up must wait via setTimeout before registering the next idle task'
    );
    assert.ok(
        followupBody.includes('_scheduleHomeIdlePrefetch(2500)'),
        'Follow-up must register the next idle prefetch with a 2500ms quiet window'
    );

    // A finished batch must record its completion time and use the follow-up
    const loadIdx = source.indexOf('async _loadNextDeferredBatch(');
    const loadBody = source.slice(loadIdx, source.indexOf('_setupHomeScrollObserver() {'));
    assert.ok(
        loadBody.includes('this._lastDeferredBatchAt = Date.now()'),
        'Completed batches must record their finish timestamp'
    );
    assert.ok(
        loadBody.includes('this._scheduleDeferredBatchFollowup()'),
        'Completed batches must schedule the next batch with the spacing helper'
    );
});

test('HomePage: eagerly mounts contiguous pre-fetched core rows up to cap while preserving layout order', async () => {
    const vm = await import('node:vm');
    const homePath = path.resolve('src/pages/HomePage.js');
    const source = fs.readFileSync(homePath, 'utf8');

    // Extract the helper methods and constants into an isolated sandbox to verify behavior directly.
    const eagerConstMatch = source.match(/const EAGER_ROW_COUNT = \d+;/);
    const capConstMatch = source.match(/const EAGER_PREFETCH_CAP = \d+;/);
    assert.ok(eagerConstMatch && capConstMatch, 'EAGER_ROW_COUNT and EAGER_PREFETCH_CAP must be defined');

    const cacheStart = source.indexOf('_applyCachedRowData(descriptors, rowCache, rowTitles) {');
    const cacheEnd = source.indexOf('_reconcileItemPlaybackState(item) {');
    assert.ok(cacheStart !== -1 && cacheEnd !== -1, 'Helper block must exist in HomePage.js');
    const helperMethods = source.slice(cacheStart, cacheEnd);

    const sandbox = vm.createContext({});
    const HelperClass = vm.runInContext(
        `${eagerConstMatch[0]}\n${capConstMatch[0]}\n(class HomePartitionTest {\n${helperMethods}\n})`,
        sandbox
    );
    const page = new HelperClass();

    // 1. Default layout with 4 pre-fetched Latest rows mounts all 7 core rows before splash dismissal
    const defaultDescriptors = [
        { id: 'my-media' },
        { id: 'resume' },
        { id: 'next-up' },
        { id: 'latest-1', _preFetchedItems: [{ Id: 'a' }] },
        { id: 'latest-2', _preFetchedItems: [{ Id: 'b' }] },
        { id: 'latest-3', _preFetchedItems: [{ Id: 'c' }] },
        { id: 'latest-4', _preFetchedItems: [] },
        { id: 'latest-5', _preFetchedItems: [{ Id: 'e' }] },
        { id: 'trending' }
    ];
    assert.equal(
        page._resolveEagerRowCount(defaultDescriptors, -1),
        7,
        'All pre-fetched Latest rows up to EAGER_PREFETCH_CAP (7) must mount before splash dismissal'
    );

    // 2. Un-fetched slow row stops contiguous expansion so custom DOM order is never reordered
    const customOrderDescriptors = [
        { id: 'my-media' },
        { id: 'resume' },
        { id: 'next-up' },
        { id: 'hss-slow-plugin' },
        { id: 'latest-1', _preFetchedItems: [{ Id: 'a' }] }
    ];
    assert.equal(
        page._resolveEagerRowCount(customOrderDescriptors, -1),
        3,
        'Un-fetched slow row must stop contiguous eager expansion so visual order stays exact'
    );

    // 3. Fallback when /Litefin/Items/Latest fails (no _preFetchedItems): stays at EAGER_ROW_COUNT = 3
    const failedPrefetchDescriptors = [
        { id: 'my-media' },
        { id: 'resume' },
        { id: 'next-up' },
        { id: 'latest-1' },
        { id: 'latest-2' }
    ];
    assert.equal(
        page._resolveEagerRowCount(failedPrefetchDescriptors, -1),
        3,
        'Un-fetched fallback Latest rows must remain deferred rather than blocking splash dismissal'
    );

    // 4. Cached home screen rows get _hasCachedData stamped and mount eagerly up to cap
    const cachedDescriptors = [
        { id: 'my-media' },
        { id: 'resume' },
        { id: 'next-up' },
        { id: 'trending' },
        { id: 'trending-series' }
    ];
    page._applyCachedRowData(
        cachedDescriptors,
        { trending: [{ Id: 't1' }], 'trending-series': [{ Id: 'ts1' }] },
        {}
    );
    assert.equal(
        page._resolveEagerRowCount(cachedDescriptors, -1),
        5,
        'Cached rows populated via _applyCachedRowData must mount eagerly'
    );

    // 5. Saved focus restoration target beyond cap widens eager batch cleanly
    assert.equal(
        page._resolveEagerRowCount(defaultDescriptors, 8),
        9,
        'Focus restoration target beyond cap must extend eager batch up to targetIndex + 1'
    );
});
