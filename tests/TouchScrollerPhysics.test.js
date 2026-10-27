import assert from 'node:assert/strict';
import test from 'node:test';
import {
    chaseStep,
    railStep,
    flingStep,
    createSpring,
    normalizeScrollPhysics,
    CHASE_TAU_FACTOR,
    RAIL_DECEL_ZONE_FRACTION,
    FLING_VELOCITY_MULTIPLIER
} from '../src/ui/SpringPhysics.js';

/**
 * ============================================================================
 * Environment Mock Setup for Node.js Test Execution
 * ============================================================================
 */
const storageMap = new Map();
globalThis.localStorage = {
    getItem: (key) => storageMap.get(key) || null,
    setItem: (key, val) => storageMap.set(key, String(val)),
    removeItem: (key) => storageMap.delete(key),
    clear: () => storageMap.clear()
};

globalThis.window = globalThis;

globalThis.document = {
    documentElement: {
        setAttribute: () => {},
        getAttribute: () => null,
        dir: 'ltr'
    }
};

// Controllable fake rAF queue so physics settle loops can be pumped frame
// by frame with exact timestamps.
let nextRafId = 1;
const rafCallbacks = new Map();
globalThis.requestAnimationFrame = (cb) => {
    const id = nextRafId++;
    rafCallbacks.set(id, cb);
    return id;
};
globalThis.cancelAnimationFrame = (id) => {
    rafCallbacks.delete(id);
};

// Controllable clock backing performance.now()
let clock = 0;
globalThis.performance = { now: () => clock };

/**
 * Advances the fake rAF queue to the given timestamp.
 * @param {number} nowMs
 */
function pumpRaf(nowMs) {
    clock = nowMs;
    const cbs = [...rafCallbacks.values()];
    rafCallbacks.clear();
    cbs.forEach((cb) => cb(nowMs));
}

/**
 * Drives the settle animation loop until the settle finalizes or the
 * iteration guard trips.
 * @param {number} initialClock
 */
function runSettleToCompletion(initialClock = 0) {
    let guard = 0;
    clock = initialClock;
    while (rafCallbacks.size > 0 && guard < 600) {
        pumpRaf(clock + 16);
        guard++;
    }
    return guard >= 600;
}

const { TouchHorizontalScroller, default: touchScrollerSingleton } =
    await import('../src/android/TouchHorizontalScroller.js');
const { storage } = await import('../src/utils/StorageService.js');

/**
 * Builds a fake `.row-items` element with a virtualized row, sufficient for
 * _animateSettle / _handleDpad (settleToCardCenter's geometry math is covered
 * by ScrollAlignment tests and stays engine-agnostic).
 * @param {number} initialX - Initial normalized scroll position
 * @returns {{rowItems: Object, row: Object, calls: Object}}
 */
function makeFakeTouchRow(initialX = 0) {
    const calls = { sync: 0, endScroll: [] };
    const row = {
        totalItems: 50,
        sidePadding: 20,
        itemWidth: 160,
        totalItemWidth: 168,
        isLandscape: false,
        cardType: 'poster',
        modernMultiplier: 1,
        getTrackWidth: () => 50 * 168 + 40,
        getItemPosition: (i) => 20 + i * 168,
        syncScrollToPosition: () => {
            calls.sync++;
        },
        endTouchScroll: (x) => {
            calls.endScroll.push(x);
        }
    };
    const track = { __virtualRow: row };
    const rowItems = {
        clientWidth: 1000,
        scrollLeft: initialX,
        querySelector: (sel) => (sel === ':scope > .row-items-track' ? track : null)
    };
    return { rowItems, row, calls };
}

const ENGINE_TOLERANCE_PX = 0.06;

/**
 * ============================================================================
 * SCROLL PHYSICS PREFERENCE (SHARED NORMALIZER)
 * ============================================================================
 */

test('normalizeScrollPhysics: every engine selectable, garbage and null fall back to spring', () => {
    for (const engine of ['spring', 'chase', 'rail', 'fling']) {
        assert.strictEqual(normalizeScrollPhysics(engine), engine, `Engine "${engine}" must be selectable`);
    }
    assert.strictEqual(normalizeScrollPhysics('easing'), 'easing');
    assert.strictEqual(normalizeScrollPhysics(null), 'spring');
    assert.strictEqual(normalizeScrollPhysics(undefined), 'spring');
    assert.strictEqual(normalizeScrollPhysics('nonsense'), 'spring');
});

test('TouchHorizontalScroller: _getEngine reads the shared pref and falls back safely', () => {
    const scroller = new TouchHorizontalScroller();
    storage.removeItem('pref:scrollPhysics');
    assert.strictEqual(scroller._getEngine(), 'spring');

    for (const engine of ['easing', 'chase', 'rail', 'fling']) {
        storage.setItem('pref:scrollPhysics', engine);
        assert.strictEqual(scroller._getEngine(), engine);
    }
    storage.setItem('pref:scrollPhysics', 'spring');
    assert.strictEqual(scroller._getEngine(), 'spring');

    storage.setItem('pref:scrollPhysics', 'garbage');
    assert.strictEqual(scroller._getEngine(), 'spring');
    storage.removeItem('pref:scrollPhysics');
});

test('TouchHorizontalScroller: default settles via spring physics (allocates physics state)', () => {
    storage.removeItem('pref:scrollPhysics');
    const scroller = new TouchHorizontalScroller();
    const { rowItems, row, calls } = makeFakeTouchRow(100);

    scroller._animateSettle(rowItems, row, 100, 350, false);

    const state = scroller._settleAnims.get(rowItems);
    assert.ok(state, 'spring settle must register an animation state');
    assert.strictEqual(state.physics, true, 'spring path must create a physics state');
    assert.strictEqual(state.engine, 'spring');
    assert.strictEqual(state.target, 350);
});

test('TouchHorizontalScroller: settles via classic easeOutQuad when easing is configured', () => {
    storage.setItem('pref:scrollPhysics', 'easing');
    const scroller = new TouchHorizontalScroller();
    const { rowItems, row, calls } = makeFakeTouchRow(100);

    scroller._animateSettle(rowItems, row, 100, 350, false);

    const state = scroller._settleAnims.get(rowItems);
    assert.ok(state, 'classic settle must register an animation state');
    assert.strictEqual(state.physics, undefined, 'classic path must not create a physics state');
    assert.strictEqual(state.target, 350);

    const timedOut = runSettleToCompletion();
    assert.ok(!timedOut, 'classic settle must complete within the iteration guard');
    assert.ok(!scroller._settleAnims.has(rowItems), 'classic settle must clear its state on completion');
    assert.strictEqual(calls.endScroll[0], 350, 'classic settle must endTouchScroll exactly on target');
    assert.ok(calls.sync > 0, 'classic settle must keep VirtualCardRow synced');
    storage.removeItem('pref:scrollPhysics');
});

/**
 * ============================================================================
 * PHYSICS ENGINE SETTLES (spring / chase / rail / fling)
 * ============================================================================
 */

for (const engine of ['spring', 'chase', 'rail', 'fling']) {
    test(`TouchHorizontalScroller: ${engine} settle glides to card center with zero overshoot`, () => {
        storage.setItem('pref:scrollPhysics', engine);
        const scroller = new TouchHorizontalScroller();
        const { rowItems, row, calls } = makeFakeTouchRow(400);

        const writes = [];
        const originalWrite = scroller._writeScroll.bind(scroller);
        scroller._writeScroll = (el, x, isRtl) => {
            writes.push(x);
            el.scrollLeft = isRtl ? -x : x;
        };

        scroller._animateSettle(rowItems, row, 400, 620, false);

        const state = scroller._settleAnims.get(rowItems);
        assert.ok(state, `${engine} settle must register a physics state`);
        assert.strictEqual(state.physics, true, `${engine} must create a physics state`);
        assert.strictEqual(state.engine, engine);
        assert.strictEqual(state.target, 620);

        // Drive the RAF loop to completion
        let guard = 0;
        clock = 0;
        while (scroller._settleAnims.has(rowItems) && guard < 600) {
            pumpRaf(clock + 16);
            guard++;
        }

        assert.ok(!scroller._settleAnims.has(rowItems), `${engine} settle must finalize within the iteration guard`);
        assert.strictEqual(writes[writes.length - 1], 620, `${engine} must land exactly on target`);
        assert.strictEqual(calls.endScroll[0], 620, `${engine} must endTouchScroll exactly on target`);

        // Monotonic approach, no overshoot beyond the centering target
        for (const x of writes) {
            const overshoot = x - 620;
            assert.ok(
                overshoot <= ENGINE_TOLERANCE_PX,
                `${engine} must never overshoot the centering target (worst ${overshoot.toFixed(3)}px)`
            );
        }

        storage.removeItem('pref:scrollPhysics');
    });
}

test('TouchHorizontalScroller: engine parameter derivation matches ScrollController budgets', () => {
    storage.setItem('pref:scrollPhysics', 'chase');
    const scroller = new TouchHorizontalScroller();
    const { rowItems, row } = makeFakeTouchRow(0);

    // 400px hop → duration = min(600, max(120, 400*0.5)) = 200ms budget
    scroller._animateSettle(rowItems, row, 0, 400, false);
    let state = scroller._settleAnims.get(rowItems);
    tweenCleanup(state, scroller, rowItems, 'chase tau');
    assert.strictEqual(state.tau, 200 / CHASE_TAU_FACTOR, 'chase τ must derive from the settle budget');

    storage.setItem('pref:scrollPhysics', 'rail');
    scroller._animateSettle(rowItems, row, 0, 400, false);
    state = scroller._settleAnims.get(rowItems);
    tweenCleanup(state, scroller, rowItems, 'rail params');
    assert.strictEqual(state.speed, (2 * 400) / 200, 'rail slope must match classic departure speed (2·D/T)');
    assert.strictEqual(state.decelZone, RAIL_DECEL_ZONE_FRACTION * 400, 'rail decel zone scales with hop');

    storage.setItem('pref:scrollPhysics', 'fling');
    scroller._animateSettle(rowItems, row, 0, 400, false);
    state = scroller._settleAnims.get(rowItems);
    tweenCleanup(state, scroller, rowItems, 'fling params');
    assert.strictEqual(state.tau, 200 / CHASE_TAU_FACTOR);
    assert.strictEqual(state.vCap, FLING_VELOCITY_MULTIPLIER * ((2 * 400) / 200), 'fling ceiling from hop budget');

    storage.setItem('pref:scrollPhysics', 'spring');
    scroller._animateSettle(rowItems, row, 0, 400, false);
    state = scroller._settleAnims.get(rowItems);
    tweenCleanup(state, scroller, rowItems, 'spring params');
    const springRef = createSpring(400, 200);
    assert.strictEqual(state.omega, springRef.omega);
    assert.strictEqual(state.zeta, springRef.zeta);
    assert.strictEqual(state.v, springRef.v0);

    storage.removeItem('pref:scrollPhysics');
});

/**
 * Cancels a running settle safely (helper to keep the derivation test tidy).
 * @param {Object} state
 * @param {Object} scroller
 * @param {Object} rowItems
 * @param {string} label
 */
function tweenCleanup(state, scroller, rowItems, label) {
    assert.ok(state && state.physics === true, `${label}: physics state must be registered`);
    cancelAnimationFrame(state.raf);
    scroller._settleAnims.delete(rowItems);
}

test('TouchHorizontalScroller: _handleDpad snaps physics settles to their target', () => {
    storage.setItem('pref:scrollPhysics', 'rail');
    const scroller = new TouchHorizontalScroller();
    const { rowItems, row, calls } = makeFakeTouchRow(100);

    scroller._animateSettle(rowItems, row, 100, 500, false);
    assert.ok(scroller._settleAnims.has(rowItems), 'settle must be running before D-pad');

    scroller._handleDpad();

    assert.ok(!scroller._settleAnims.has(rowItems), 'D-pad must cancel the settle');
    assert.strictEqual(rowItems.scrollLeft, 500, 'D-pad must snap scrollLeft to the settle target');
    assert.strictEqual(calls.endScroll[0], 500, 'D-pad must finalize VirtualCardRow on the settle target');
    storage.removeItem('pref:scrollPhysics');
});

test('TouchHorizontalScroller: active pointer touch kills a physics settle immediately', () => {
    storage.setItem('pref:scrollPhysics', 'spring');
    const scroller = new TouchHorizontalScroller();
    const { rowItems, row } = makeFakeTouchRow(0);

    scroller._animateSettle(rowItems, row, 0, 300, false);
    scroller._activePointerId = 7;

    pumpRaf(16);

    assert.ok(!scroller._settleAnims.has(rowItems), 'an active touch gesture must cancel the settle');
    storage.removeItem('pref:scrollPhysics');
});

test('TouchHorizontalScroller: destroy() cancels a running physics settle frame', () => {
    storage.setItem('pref:scrollPhysics', 'fling');
    const scroller = new TouchHorizontalScroller();
    const { rowItems, row } = makeFakeTouchRow(0);

    scroller._animateSettle(rowItems, row, 0, 300, false);
    assert.ok(rafCallbacks.size > 0, 'settle must have a scheduled frame');

    scroller.destroy();

    assert.strictEqual(rafCallbacks.size, 0, 'destroy must cancel scheduled settle frames');
    assert.strictEqual(scroller._settleAnims.size, 0, 'destroy must clear all settle states');
    storage.removeItem('pref:scrollPhysics');
});

test('TouchHorizontalScroller: exports the singleton as default export', () => {
    assert.ok(touchScrollerSingleton instanceof TouchHorizontalScroller);
});

/**
 * Sanity: keep the pure integrator imports exercised so tree shakers and
 * linters never flag them as unused in this mock-heavy harness.
 */
test('SpringPhysics integrators remain directly callable from the touch harness', () => {
    const [cx] = chaseStep(0, 100, 50, 16);
    const [rx] = railStep(0, 100, 2, 35, 16);
    const [fx] = flingStep(0, 2, 100, 50, 5, 16);
    assert.ok(cx > 0 && rx > 0 && fx > 0);
});
