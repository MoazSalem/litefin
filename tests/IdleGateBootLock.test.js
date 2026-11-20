import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Ensure browser globals exist before modules that reference window/document load
if (!globalThis.window) {
    globalThis.window = {
        innerWidth: 1920,
        innerHeight: 1080,
        __scrollController: { isAnimating: false },
        addEventListener: () => {},
        removeEventListener: () => {}
    };
}
if (!globalThis.document) {
    globalThis.document = {
        addEventListener: () => {},
        removeEventListener: () => {}
    };
}

/**
 * Helper that waits a fixed millisecond duration.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

test('IdleGate: Boot lock blocks isUserIdle and defers runWhenIdle until setBootComplete()', async () => {
    // Load a fresh IdleGate module instance isolated via query string
    const mod = await import(`../src/utils/IdleGate.js?case=bootlock-${Date.now()}`);
    const { idleGate } = mod;

    assert.equal(idleGate.isBootLocked(), true, 'Boot lock must start engaged during cold start');
    assert.equal(idleGate.isUserActive(0), true, 'isUserActive must return true while splash is up');
    assert.equal(idleGate.isUserIdle(0), false, 'isUserIdle must return false while splash is up');

    let fired = false;
    let firedAt = 0;
    // Queue a task with tiny idle & maxWait caps; it must STILL stay parked while boot is locked
    const taskId = idleGate.runWhenIdle(() => {
        fired = true;
        firedAt = Date.now();
    }, 80, 120);

    // Wait past the maxWait cap while still locked behind splash screen
    await sleep(160);
    assert.equal(fired, false, 'runWhenIdle must stay deferred while _bootLocked is true');

    // Dismiss splash screen and record unlock timestamp
    const unlockedAt = Date.now();
    idleGate.setBootComplete();
    assert.equal(idleGate.isBootLocked(), false, 'setBootComplete() must release boot lock');

    // Immediately after unlock, the full post-splash 80ms quiet window must still be respected
    await sleep(30);
    assert.equal(fired, false, 'runWhenIdle must wait full post-splash quiet window after setBootComplete()');

    // Wait past the 80ms post-splash threshold + polling margin
    await sleep(90);
    assert.equal(fired, true, 'Queued idle task must execute after post-splash quiet window');
    assert.ok(
        firedAt - unlockedAt >= 70,
        `Task fired too early post-splash (${firedAt - unlockedAt}ms after setBootComplete)`
    );

    idleGate.cancel(taskId);
});

test('IdleGate: eventBus app:hideSplash event unlocks boot gate automatically', async () => {
    const { eventBus } = await import('../src/core/EventBus.js');
    const mod = await import(`../src/utils/IdleGate.js?case=hidesplash-${Date.now()}`);
    const { idleGate } = mod;

    assert.equal(idleGate.isBootLocked(), true, 'Boot gate should start locked');

    eventBus.emit('app:hideSplash');
    assert.equal(idleGate.isBootLocked(), false, 'app:hideSplash must unlock IdleGate');
});

test('IdleGate: Safety timeout arms at 15000ms and auto-unlocks if splash event never arrives', async () => {
    const origSetTimeout = globalThis.setTimeout;
    const origClearTimeout = globalThis.clearTimeout;
    const capturedTimers = [];

    // Intercept timers around fresh module evaluation to capture the 15s safety fallback
    globalThis.setTimeout = (fn, delay, ...args) => {
        const handle = { fn, delay, args, unrefCalled: false, cleared: false, unref() { this.unrefCalled = true; } };
        capturedTimers.push(handle);
        return handle;
    };
    globalThis.clearTimeout = (handle) => {
        if (handle && typeof handle === 'object') handle.cleared = true;
    };

    try {
        const mod = await import(`../src/utils/IdleGate.js?case=safety-${Date.now()}`);
        const { idleGate, BOOT_LOCK_SAFETY_MS } = mod;

        assert.equal(BOOT_LOCK_SAFETY_MS, 15000, 'Safety deadline must be 15000ms');

        const safetyTimer = capturedTimers.find((t) => t.delay === 15000);
        assert.ok(safetyTimer, 'Module load must register the 15000ms boot safety timer');
        assert.equal(safetyTimer.unrefCalled, true, 'Boot safety timer must call unref() when available');
        assert.equal(idleGate.isBootLocked(), true, 'Boot lock stays engaged prior to safety callback');

        // Simulate 15s deadline firing cleanly
        safetyTimer.fn();
        assert.equal(idleGate.isBootLocked(), false, 'Safety callback must unlock boot gate after 15s');
    } finally {
        globalThis.setTimeout = origSetTimeout;
        globalThis.clearTimeout = origClearTimeout;
    }
});

test('App.js: Unlocks IdleGate immediately when handling app:hideSplash', () => {
    const appSource = readFileSync(new URL('../src/core/App.js', import.meta.url), 'utf8');
    const handlerStart = appSource.indexOf("eventBus.on('app:hideSplash', () => {");
    assert.notEqual(handlerStart, -1, 'App.js must register app:hideSplash listener');

    const handlerSlice = appSource.slice(handlerStart, handlerStart + 500);
    assert.ok(
        handlerSlice.includes('idleGate.setBootComplete()'),
        'App.js app:hideSplash handler must invoke idleGate.setBootComplete()'
    );
});

