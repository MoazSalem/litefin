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
