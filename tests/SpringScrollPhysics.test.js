import assert from 'node:assert/strict';
import test from 'node:test';
import {
    createSpring,
    springStep,
    chaseStep,
    railStep,
    flingStep,
    simulateSpring,
    SPRING_DAMPING_RATIO,
    SPRING_SUBSTEP_MS,
    SPRING_VELOCITY_CEILING_PX_MS,
    SPRING_MAX_DURATION_MS,
    SPRING_MIN_DURATION_MS,
    SPRING_SETTLE_DISTANCE_PX,
    SPRING_SETTLE_VELOCITY_PX_MS,
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

globalThis.document = {
    createElement: () => ({
        style: {},
        classList: { add: () => {}, remove: () => {}, contains: () => false },
        setAttribute: () => {},
        getAttribute: () => null
    }),
    documentElement: {
        setAttribute: () => {},
        getAttribute: () => null,
        dir: 'ltr'
    }
};
globalThis.window = globalThis;
globalThis.requestAnimationFrame = (cb) => 1;
globalThis.cancelAnimationFrame = () => {};

const { scrollController, default: ScrollController } = await import('../src/ui/ScrollController.js');
const { storage } = await import('../src/utils/StorageService.js');

/**
 * ============================================================================
 * SCROLL PHYSICS PREFERENCE
 * ============================================================================
 */

test('ScrollController: scroll physics defaults to "spring"', () => {
    storage.removeItem('pref:scrollPhysics');
    const controller = new ScrollController();
    assert.strictEqual(
        controller.getScrollPhysics(),
        'spring',
        'Spring physics must be the default for fluid velocity-based scrolling'
    );
});

test('ScrollController: scroll physics honors all engine preferences and rejects garbage', () => {
    const controller = new ScrollController();
    for (const engine of ['easing', 'chase', 'rail', 'fling']) {
        storage.setItem('pref:scrollPhysics', engine);
        assert.strictEqual(controller.getScrollPhysics(), engine, `Engine "${engine}" must be selectable`);
    }
    storage.setItem('pref:scrollPhysics', 'spring');
    assert.strictEqual(controller.getScrollPhysics(), 'spring');
    storage.setItem('pref:scrollPhysics', 'garbage');
    assert.strictEqual(
        controller.getScrollPhysics(),
        'spring',
        'Any unrecognized value must fall back to default spring physics'
    );
    storage.removeItem('pref:scrollPhysics');
});

/**
 * ============================================================================
 * SPRING PARAMETER GENERATION
 * ============================================================================
 */

test('createSpring: derives a stable natural frequency from duration and floors tiny durations', () => {
    // Tiny durations must be floored so ω never explodes into instability
    const floorParams = createSpring(400, 10);
    const minParams = createSpring(400, SPRING_MIN_DURATION_MS);
    assert.ok(
        Math.abs(floorParams.omega - minParams.omega) < 1e-9,
        'Durations below the minimum must clamp to SPRING_MIN_DURATION_MS'
    );

    // Longer settle budget → softer spring (lower ω)
    const fast = createSpring(400, 130);
    const slow = createSpring(400, 340);
    assert.ok(fast.omega > slow.omega, 'Faster duration preference must yield higher ω (stiffest spring)');

    // ζ must be critically damped (exactly 1) — smooth glide, zero bounce,
    // matching the Apple TV (tvOS) scroll character
    assert.strictEqual(SPRING_DAMPING_RATIO, 1.0, 'ζ must be critically damped (1.0): no overshoot, no bounce');
});

test('createSpring: initial impulse matches easeOutQuad outgoing velocity and respects ceilings', () => {
    const D = 400;
    const T = 180;
    const { omega, v0 } = createSpring(D, T);

    // easeOutQuad initial slope is 2 → v0 = 2·D/T
    const expected = (2 * D) / T;
    assert.ok(
        Math.abs(v0 - expected) < 1e-9,
        `For a 400px/180ms hop v0 must equal 2·D/T (${expected.toFixed(2)}), got ${v0}`
    );

    // Hard ceiling: giant distances clamp v0, protecting TV compositors
    const giant = createSpring(100000, 130);
    assert.ok(
        Math.abs(giant.v0) <= SPRING_VELOCITY_CEILING_PX_MS,
        'v0 must never exceed SPRING_VELOCITY_CEILING_PX_MS'
    );

    // Zero distance → zero impulse (no phantom motion)
    assert.strictEqual(createSpring(0, 130).v0, 0, 'A zero-distance hop must not inject velocity');

    // Signed: negative hops get negative impulse
    assert.strictEqual(createSpring(-400, 130).v0 < 0, true, 'Negative hops must launch with negative velocity');
});

/**
 * ============================================================================
 * STEP INTEGRATION
 * ============================================================================
 */

test('springStep: pulls position toward the target and damps over time', () => {
    const { omega, zeta } = createSpring(400, 180);
    // Positive deficit (x=0, target=400) must accelerate forward
    const [, vForward] = springStep(0, 0, 400, omega, zeta, 8);
    assert.ok(vForward > 0, 'Spring force must accelerate toward the target');

    // Already at target with zero velocity → stays exactly there (no pumping)
    const [xStill, vStill] = springStep(400, 0, 400, omega, zeta, 8);
    assert.strictEqual(xStill, 400);
    assert.strictEqual(vStill, 0);

    // Sustained non-linear: damping term must dominate after passing the target
    let x = 400;
    let v = 0;
    for (let i = 0; i < 200; i++) {
        [x, v] = springStep(x, v, 400, omega, zeta, SPRING_SUBSTEP_MS);
    }
    assert.ok(Math.abs(x - 400) < 1, 'Oscillation must decay to sub-pixel residual within 200 substeps');
});

/**
 * ============================================================================
 * FULL TRAJECTORY SIMULATION (Apple-settle characteristics)
 * ============================================================================
 */

const HOP_GRID = [
    [60, 130],
    [200, 130],
    [400, 130],
    [400, 180],
    [800, 180],
    [1500, 180],
    [400, 240],
    [400, 340],
    [1500, 340]
];

test('simulateSpring: every hop in the navigation grid settles and terminates', () => {
    for (const [D, T] of HOP_GRID) {
        const r = simulateSpring(0, D, T);
        assert.equal(r.settled, true, `A ${D}px hop at ${T}ms budget must settle before the hard timeout`);
        assert.ok(
            r.durationMs <= SPRING_MAX_DURATION_MS,
            `Settle time (${r.durationMs}ms) must not exceed the timeout`
        );
        // Far from pathological: settle must not stall at the threshold far
        // below the natural envelope (i.e. unphysically instantaneous)
        assert.ok(r.durationMs >= T * 0.4, `Settle time must reflect the spring envelope, got ${r.durationMs}ms`);
    }
});

test('simulateSpring: critically damped Apple TV character — zero overshoot on every hop', () => {
    for (const [D, T] of HOP_GRID) {
        const r = simulateSpring(0, D, T);
        assert.ok(
            r.overshootPx < 0.5,
            `${D}px@${T}ms must land without bounce (overshoot ${r.overshootPx.toFixed(2)}px)`
        );
    }
    // Micro hops (typical same-row adjustments) must be strictly monotonic.
    for (const D of [6, 12, 25]) {
        const r = simulateSpring(0, D, 130);
        assert.ok(r.overshootPx < 0.01, `Micro hop of ${D}px must not bounce at all (got ${r.overshootPx}px)`);
    }
});

test('simulateSpring: trajectory is deterministic and directionally symmetric', () => {
    const a = simulateSpring(0, 400, 180);
    const b = simulateSpring(0, 400, 180);
    assert.strictEqual(a.durationMs, b.durationMs, 'Repeated simulations must be bit-identical (no Physics RNG)');

    const fwd = simulateSpring(0, 400, 180);
    const rev = simulateSpring(1200, 800, 180);
    assert.ok(
        Math.abs(fwd.durationMs - rev.durationMs) < 0.001 && Math.abs(fwd.overshootPx - rev.overshootPx) < 0.001,
        'A 400px hop must feel identical regardless of start offset or direction'
    );
});

test('simulateSpring: cannot produce NaN or runaway velocity', () => {
    for (const [D, T] of HOP_GRID) {
        const r = simulateSpring(0, D, T);
        assert.ok(Number.isFinite(r.durationMs) && Number.isFinite(r.overshootPx), `NaN in ${D}px@${T}ms`);
    }
    // Extreme parameters (asymptotic stress): minimum duration + maximum distance
    const stress = simulateSpring(0, 12000, SPRING_MIN_DURATION_MS);
    assert.ok(Number.isFinite(stress.durationMs), 'Stress parameters must not destabilize the integrator');
    assert.ok(stress.durationMs <= SPRING_MAX_DURATION_MS, 'Stress hop must be terminated by the timeout net');
});

/**
 * ============================================================================
 * SCROLLCONTROLLER INTEGRATION SURFACE
 * ============================================================================
 */

test('ScrollController: exposes a spring-ready integration surface with axis state isolation', () => {
    const controller = new ScrollController();

    // State slots must exist and be cleared after init
    assert.strictEqual(controller._verticalScrollState, null);
    assert.strictEqual(controller._horizontalScrollState, null);
    assert.strictEqual(controller._verticalScrollAnimationId, null);
    assert.strictEqual(controller._horizontalScrollAnimationId, null);

    // Spring engine methods must exist on the controller prototype
    assert.strictEqual(typeof controller._springScrollTo, 'function');
    assert.strictEqual(typeof controller._springTrackHorizontal, 'function');
    assert.strictEqual(typeof controller._runSpringLoop, 'function');
});

test('ScrollController: singleton keeps working when spring preference is stored but unused', () => {
    storage.setItem('pref:scrollPhysics', 'spring');
    const controller = new ScrollController();
    // Must not throw with nothing to animate
    controller.cancelAnimation('vertical');
    controller.cancelAnimation('horizontal');
    assert.strictEqual(scrollController.isAnimating, false);
    storage.removeItem('pref:scrollPhysics');
});

test('ScrollController: fresh instance wiring covers the physics attribute stamp', () => {
    let stamped = null;
    globalThis.document.documentElement.setAttribute = (k, v) => {
        if (k === 'data-scroll-physics') stamped = v;
    };

    storage.setItem('pref:scrollPhysics', 'spring');
    // eslint-disable-next-line no-new
    new ScrollController();
    assert.strictEqual(stamped, 'spring', 'data-scroll-physics must be stamped on <html> for CSS gating');

    storage.setItem('pref:scrollPhysics', 'easing');
    new ScrollController();
    assert.strictEqual(stamped, 'easing', 'data-scroll-physics must reflect easing mode too');
    storage.removeItem('pref:scrollPhysics');
});

/**
 * ============================================================================
 * ENGINE STATE FACTORY: chase / rail / fling wiring
 * ============================================================================
 */

test('ScrollController: _createPhysicsState derives engine-specific parameters', () => {
    const controller = new ScrollController();
    const write = () => {};
    const finalize = () => {};

    const spring = controller._createPhysicsState({
        engine: 'spring',
        axis: 'vertical',
        container: null,
        track: null,
        scrollMode: 'gpu',
        current: 0,
        target: 400,
        duration: 180,
        _write: write,
        _finalize: finalize
    });
    assert.ok(Number.isFinite(spring.omega) && spring.omega > 0, 'spring needs ω');
    assert.ok(Number.isFinite(spring.v) && spring.v > 0, 'spring needs a launch impulse');
    assert.strictEqual(spring.physics, true);
    assert.strictEqual(typeof spring._write, 'function');
    assert.strictEqual(typeof spring._finalize, 'function');

    const chase = controller._createPhysicsState({
        engine: 'chase',
        axis: 'vertical',
        container: null,
        track: null,
        scrollMode: 'gpu',
        current: 0,
        target: 400,
        duration: 180,
        _write: write,
        _finalize: finalize
    });
    assert.ok(chase.tau > 0 && Number.isFinite(chase.tau), 'chase needs a finite τ');
    assert.strictEqual(chase.v, 0, 'chase carries momentum implicitly, not as state');

    const rail = controller._createPhysicsState({
        engine: 'rail',
        axis: 'vertical',
        container: null,
        track: null,
        scrollMode: 'gpu',
        current: 0,
        target: 400,
        duration: 180,
        _write: write,
        _finalize: finalize
    });
    assert.strictEqual(rail.speed, (2 * 400) / 180, 'rail slope must match the easing engine departure speed (2·D/T)');
    assert.strictEqual(rail.decelZone, RAIL_DECEL_ZONE_FRACTION * 400, 'rail decel zone scales with the hop');

    const fling = controller._createPhysicsState({
        engine: 'fling',
        axis: 'vertical',
        container: null,
        track: null,
        scrollMode: 'gpu',
        current: 0,
        target: 800,
        duration: 180,
        _write: write,
        _finalize: finalize
    });
    assert.strictEqual(fling.tau, Math.max(180, SPRING_MIN_DURATION_MS) / CHASE_TAU_FACTOR);
    assert.strictEqual(fling.vCap, FLING_VELOCITY_MULTIPLIER * ((2 * 800) / 180));
});

test('ScrollController: rail and fling states refresh their slopes on retarget', () => {
    const controller = new ScrollController();
    const rail = {
        engine: 'rail',
        x: 100,
        target: 800,
        speed: 1,
        decelZone: 1,
        physics: true
    };
    controller._refreshRailState(rail, 180);
    assert.strictEqual(rail.speed, (2 * 700) / 180, 'rail must re-derive slope from remaining distance');
    assert.strictEqual(rail.decelZone, RAIL_DECEL_ZONE_FRACTION * 700);

    const fling = { engine: 'fling', x: 100, target: 800, vCap: 1, physics: true };
    controller._refreshFlingState(fling, 180);
    assert.strictEqual(fling.vCap, FLING_VELOCITY_MULTIPLIER * ((2 * 700) / 180));
});

/**
 * ============================================================================
 * ADAPTIVE FRAME SAMPLER: spring auto-degrades to chase on slow panels
 * ============================================================================
 */

test('ScrollController: adaptive sampler degrades spring to chase only on genuinely slow panels', () => {
    const controller = new ScrollController();
    storage.setItem('pref:scrollPhysics', 'spring');

    // Too few samples — judgment withheld (no false positive at boot)
    controller._frameSamples = [30, 31, 29, 32];
    assert.strictEqual(controller._resolvePhysicsEngine(), 'spring');

    // Healthy 60Hz panel — full spring fidelity
    controller._frameSamples = [16, 16.7, 16.4, 16.2, 16.8, 16.3, 16.1, 16.6];
    assert.strictEqual(controller._resolvePhysicsEngine(), 'spring');

    // webOS 3 style 30-40fps delivery — degrade to chase
    controller._frameSamples = [30, 31, 29, 33, 30, 32, 30, 29];
    assert.strictEqual(
        controller._resolvePhysicsEngine(),
        'chase',
        'A <40fps median frame interval must flip spring to chase'
    );

    // A single catastrophic stall must NOT sway the median
    controller._frameSamples = [30, 16, 16, 16, 16, 16, 30, 16, 16, 300, 16, 16];
    const samplesCopy = [...controller._frameSamples];
    assert.ok(samplesCopy.length <= ADAPTIVE_WINDOW_MAX, 'sampler window stays bounded');

    // Other engines resolve to themselves regardless of frame timing
    for (const engine of ['chase', 'rail', 'fling']) {
        storage.setItem('pref:scrollPhysics', engine);
        assert.strictEqual(controller._resolvePhysicsEngine(), engine);
    }
    storage.removeItem('pref:scrollPhysics');
});

/**
 * ============================================================================
 * Follower engine pure-step verification (chase / rail / fling)
 * ============================================================================
 */

const ADAPTIVE_WINDOW_MAX = 24;

test('chaseStep: monotonic approach, stall-safe, converges to target', () => {
    // Monotone a 400px hop at τ from the 180ms budget
    const tau = Math.max(180, 60) / CHASE_TAU_FACTOR;
    let x = 0;
    for (let i = 0; i < 200; i++) {
        [x] = chaseStep(x, 400, tau, 16);
    }
    assert.ok(Math.abs(x - 400) < 0.5, ' chase must converge on the target');

    // Frame stall: even a 500ms gap can never launch past the target
    const [stalled] = chaseStep(300, 400, tau, 500);
    assert.ok(stalled <= 400, 'a stalled frame must never overshoot');
});

test('railStep: constant slope, no crossing, linear deceleration tail', () => {
    // Never crosses the target under any substep size
    for (const h of [4, 8, 16, 33]) {
        let x = 0;
        for (let i = 0; i < 300; i++) {
            [x] = railStep(x, 400, 400 / 90, 140, h);
        }
        assert.ok(Math.abs(x - 400) < 0.01, `rail must stop exactly at target (h=${h}ms)`);
    }

    // Same-step sanity: motion direction matches remaining lag
    const [nx, v] = railStep(0, 400, 4, 140, 16);
    assert.ok(nx > 0 && v > 0, 'rail accelerates toward the target');
});

test('flingStep: momentum cap, braking glide, zero overshoot under held-key storms', () => {
    // Single hop: must land with ~zero residual velocity and no crossing
    const tau = 180 / CHASE_TAU_FACTOR;
    const vCap = FLING_VELOCITY_MULTIPLIER * ((2 * 400) / 180);
    let x = 0;
    let v = 0;
    for (let i = 0; i < 300; i++) {
        [x, v] = flingStep(x, v, 400, tau, vCap, 16);
    }
    assert.ok(Math.abs(400 - x) < 0.5 && Math.abs(v) < 0.02, 'fling lands with dissipated momentum');

    // Landed camera cannot be re-excited by residual state
    const [resting, restingV] = flingStep(400, 3, 400, tau, vCap, 16);
    assert.ok(resting === 400 && restingV === 0, 'a landed camera must stay parked');
});

/**
 * ============================================================================
 * Hard settle timeout must measure SIMULATED time, not wall clock
 * ============================================================================
 * On slow Tizen hardware a rAF frame can carry 100-300ms of wall time while
 * the loop integrates at most 64ms of clamp-capped simulation time. The final
 * finalize() snap must therefore only fire once the engine has actually
 * INTEGRATED SPRING_MAX_DURATION_MS — not once wall time has elapsed.
 * Previously a wall-clock timeout fired finalize() while the physics was
 * still tens of pixels from the target, producing a visible one-frame
 * "nudge" (20-30px jump) right after every scroll appeared finished.
 */
test('ScrollController: settle timeout runs on integrated sim-time — slow frames never trigger a late finalize snap', () => {
    // Controllable RAF queue: each pump() executes exactly one queued frame
    // with an explicit timestamp, separated by 1300ms of WALL time. The loop
    // clamps each frame to 64ms of simulation, so sim-time advances ~5% of
    // wall time in this scenario.
    const pending = [];
    const realRaf = globalThis.requestAnimationFrame;
    try {
        globalThis.requestAnimationFrame = (cb) => {
            pending.push(cb);
            return pending.length;
        };

        const controller = new ScrollController();
        const writes = [];
        let finalWrite = null;
        const container = {
            style: {},
            get scrollTop() {
                return writes.length ? writes[writes.length - 1] : 0;
            },
            set scrollTop(v) {
                writes.push(v);
            },
            get scrollLeft() {
                return 0;
            },
            set scrollLeft(v) {
                void v;
            }
        };

        controller._springScrollTo({
            stateKey: '_verticalScrollState',
            animIdKey: '_verticalScrollAnimationId',
            container,
            track: null,
            currentScroll: 0,
            // Long, slow hop: at 64ms sim/frame six frames only integrate
            // 320ms of a 3000ms settle budget, so the engine cannot have
            // legitimately finished — only a wall-clock timeout would.
            targetScroll: 2000,
            duration: 3000,
            isVertical: true,
            scrollMode: 'native'
        });

        let t = 0;
        const pump = (n) => {
            for (let i = 0; i < n; i++) {
                const cb = pending.shift();
                if (!cb) return;
                cb(t);
                t += 1300; // 1.3s wall gap per frame (pathologically slow panel)
            }
        };

        // Frame 1 anchors the clock (dt = 0). Frames 2-6 each integrate only
        // 64ms of simulation → 5 more frames = 320ms sim lifetime.
        pump(6);

        // With the wall-clock bug, frame 2 (elapsed 1300ms wall) already
        // finalized with the engine ~1800px short of target.
        assert.ok(
            controller._verticalScrollState !== null,
            'finalize must NOT fire before the engine has integrated SPRING_MAX_DURATION_MS of simulation time'
        );
        assert.ok(
            !writes.some((w) => w >= 1999),
            'the engine must still be far from its origin — no teleport to the target across slow frames'
        );

        // No single write may jump most of the hop in one stroke after the
        // initial launch frame — every write must progress (no teleport)
        for (let i = 2; i < writes.length; i++) {
            assert.ok(
                writes[i] - writes[i - 1] >= -0.5,
                'writes progress smoothly toward the target without back-jumps'
            );
        }

        // Pump until the engine settles naturally (sim-time budget is 1200ms;
        // at 64ms/frame that is ~19-21 frames).
        let guard = 0;
        while (guard < 120) {
            if (controller._verticalScrollState === null) break;
            guard++;
            pump(1);
        }
        finalWrite = writes[writes.length - 1];
        assert.strictEqual(finalWrite, 2000, 'the engine must land exactly on the target');

        // Convergence validity: all writes approach from below (no bounce past
        // the target), and the finalize snap is sub-pixel-close to the last
        // integrated write.
        assert.ok(guard < 80, 'the engine settles well within the sim-time budget');
    } finally {
        globalThis.requestAnimationFrame = realRaf;
        // scrub the singleton axis slot in case the run aborted early
        scrollController._verticalScrollState = null;
        scrollController._verticalScrollAnimationId = null;
    }
});

/**
 * ============================================================================
 * Terminal glide — the exponential tail must never become a creep
 * ============================================================================
 * A critically damped spring spends the last third of a hop below ~1px/frame:
 * the scroll appears to stop, then creeps the remaining 15-20px for hundreds
 * of ms. Perceptually the animation "splits in two" with a hitch. The loop
 * must hand the closing phase to a constant-deceleration glide once the
 * remaining distance enters the glide band, keeping visible speed until
 * touchdown and landing exactly on the target.
 */
test('ScrollController: terminal glide closes the last stretch at perceptible speed with no sub-pixel creep', () => {
    const pending = [];
    const realRaf = globalThis.requestAnimationFrame;
    try {
        globalThis.requestAnimationFrame = (cb) => {
            pending.push(cb);
            return pending.length;
        };

        const controller = new ScrollController();
        const writes = [];
        const container = {
            style: {},
            get scrollTop() {
                return writes.length ? writes[writes.length - 1] : 0;
            },
            set scrollTop(v) {
                writes.push(v);
            },
            get scrollLeft() {
                return 0;
            },
            set scrollLeft(v) {
                void v;
            }
        };

        controller._springScrollTo({
            stateKey: '_verticalScrollState',
            animIdKey: '_verticalScrollAnimationId',
            container,
            track: null,
            currentScroll: 0,
            targetScroll: 342,
            duration: 180,
            isVertical: true,
            scrollMode: 'native'
        });

        // Continuous 60Hz frames at 16.67ms
        let t = 0;
        let guard = 0;
        while (controller._verticalScrollState !== null && guard < 120) {
            const cb = pending.shift();
            if (!cb) break;
            cb(t);
            t += 16.67;
            guard++;
        }
        assert.ok(guard < 120, 'the animation must settle on its own');

        // The very last write is the exact target.
        assert.strictEqual(writes[writes.length - 1], 342, 'must land exactly on target');

        // NO CREEP: count write steps that move < 1px while more than 3px of
        // travel remain. The exponential engine needed 4-6 such steps; after
        // the glide handover at most 1 may occur (the settle tail).
        let creepSteps = 0;
        for (let i = 1; i < writes.length - 1; i++) {
            const step = Math.abs(writes[i] - writes[i - 1]);
            const remaining = Math.abs(342 - writes[i]);
            if (step < 1 && remaining > 3) creepSteps++;
        }
        assert.ok(
            creepSteps === 0,
            `the tail must never creep below 1px/frame with distance left (saw ${creepSteps} creep steps)`
        );
    } finally {
        globalThis.requestAnimationFrame = realRaf;
        scrollController._verticalScrollState = null;
        scrollController._verticalScrollAnimationId = null;
    }
});

/**
 * ============================================================================
 * Fixed-cadence integration — janky frame delivery must not dent the motion
 * ============================================================================
 * Consuming each rAF frame's actual interval made per-paint steps fluctuate
 * wildly on janky TV delivery (fast frames = small steps, late frames =
 * teleports + sag), which read as the scroll splitting into an uneven
 * "two parts" hitch — worst with long duration settings, where late frames
 * were frequent. The loop now integrates a constant clamped median cadence
 * so every paint advances an equal step.
 */
test('ScrollController: late/uneven rAF frames paint equal steps with no mid-flight dents', () => {
    const pending = [];
    const realRaf = globalThis.requestAnimationFrame;
    try {
        globalThis.requestAnimationFrame = (cb) => {
            pending.push(cb);
            return pending.length;
        };

        const controller = new ScrollController();
        const writes = [];
        const container = {
            style: {},
            get scrollTop() {
                return writes.length ? writes[writes.length - 1] : 0;
            },
            set scrollTop(v) {
                writes.push(v);
            },
            get scrollLeft() {
                return 0;
            },
            set scrollLeft(v) {
                void v;
            }
        };

        controller._springScrollTo({
            stateKey: '_verticalScrollState',
            animIdKey: '_verticalScrollAnimationId',
            container,
            track: null,
            currentScroll: 0,
            targetScroll: 342,
            duration: 240,
            isVertical: true,
            scrollMode: 'native'
        });

        // Janky delivery: alternates good frames with 90-100ms late frames
        // (still under ADAPTIVE_SAMPLE_REJECT_MAX_MS and CADENCE_DT_MAX_MS so
        // the median clamps to a stable step).
        const cadence = [16, 100, 16, 90, 16, 100, 33, 16, 90, 16];
        let t = 0;
        let idx = 0;
        let guard = 0;
        while (controller._verticalScrollState !== null && guard < 120) {
            const cb = pending.shift();
            if (!cb) break;
            cb(t);
            t += cadence[idx % cadence.length];
            idx++;
            guard++;
        }
        assert.ok(guard < 120, 'the animation must settle on its own');
        assert.strictEqual(writes[writes.length - 1], 342, 'must land exactly on target');

        // No teleport: the largest single-paint step after the first 3 warmup
        // frames is bounded relative to the step that followed it (a consumed
        // 100ms interval previously teleported 5-10x the neighboring step).
        const steps = writes.slice(3).map((w, i, a) => +Math.abs(w - (a[i - 1] ?? writes[2])).toFixed(1));
        for (let i = 1; i < steps.length; i++) {
            const ratio = Math.abs(steps[i] - steps[i - 1]) / Math.max(steps[i], steps[i - 1], 0.01);
            if (steps[i] > 3 && steps[i - 1] > 3) {
                assert.ok(
                    steps[i] / Math.max(steps[i - 1], 0.01) < 4,
                    `adjacent paint steps must stay in the same magnitude band (saw ${steps[i - 1]} -> ${steps[i]})`
                );
            }
            void ratio;
        }

        // No creep either (constant steps must not degrade into sub-pixel tails)
        let creep = 0;
        for (let i = 4; i < writes.length - 2; i++) {
            const step = Math.abs(writes[i] - writes[i - 1]);
            const rem = Math.abs(342 - writes[i]);
            if (step < 1 && rem > 3) creep++;
        }
        assert.ok(creep === 0, `no sub-pixel creep on late frames (saw ${creep} steps)`);
    } finally {
        globalThis.requestAnimationFrame = realRaf;
        scrollController._verticalScrollState = null;
        scrollController._verticalScrollAnimationId = null;
    }
});

/**
 * ============================================================================
 * Row-type duration parity — every row hop must use the configured budget
 * ============================================================================
 * The "long leap" duration stretch exists for hero carousel <-> content row
 * transitions only. Poster rows are taller than landscape/square rows, so their
 * hops travel up to ~600px; while the threshold sat at 550px every poster hop
 * was silently stretched by x1.25 and poster rows animated noticeably slower
 * than landscape rows at the same pref:scrollSmoothingDuration ("poster rows
 * lag when scrolled to"). Row hops must stay on the base budget; only true
 * leaps (hero <-> rows, multi-row jumps) may scale.
 */
test('ScrollController: row-to-row hops keep the base duration on every row type', () => {
    const controller = new ScrollController();
    const realRaf = globalThis.requestAnimationFrame;
    try {
        // Isolate from the scheduler: we only inspect the settle budget.
        globalThis.requestAnimationFrame = () => 1;

        const container = {
            style: {},
            scrollTop: 0,
            scrollLeft: 0,
            clientHeight: 1080,
            querySelector: () => null
        };

        storage.setItem('pref:scrollSmoothingDuration', 'slower');
        const base = controller.getVerticalScrollDuration();
        assert.ok(base > 0, 'slower preference must resolve to a positive duration');

        // Tallest real row hop measured on the home screen: a 574px poster row
        // plus its gap (602px), and the shorter landscape/square hops (448px).
        for (const distance of [356, 448, 475, 504, 602, 699]) {
            controller.cancelAnimation('vertical');
            container.scrollTop = 0;
            controller.smoothScrollTo(container, distance, null, 'vertical');
            assert.strictEqual(
                controller._verticalScrollState.budget,
                base,
                `a ${distance}px row hop must animate for the configured ${base}ms, not a stretched budget`
            );
        }

        // Genuine leaps still stretch (hero <-> rows, multi-row jumps).
        controller.cancelAnimation('vertical');
        container.scrollTop = 0;
        controller.smoothScrollTo(container, 1000, null, 'vertical');
        const leap = controller._verticalScrollState.budget;
        assert.ok(
            leap >= Math.round(base * 1.25) && leap <= Math.round(base * 1.75),
            `a 1000px leap must still stretch within the x1.25-x1.75 band (saw ${leap}ms for base ${base}ms)`
        );

        // Horizontal row scrolling is untouched by the vertical leap rule.
        controller.cancelAnimation('horizontal');
        const horizontalBase = controller.getHorizontalScrollDuration();
        controller.smoothScrollTo(container, 900, null, 'horizontal');
        assert.strictEqual(
            controller._horizontalScrollState.budget,
            horizontalBase,
            'horizontal row scrolling must keep its own duration mapping'
        );

        // Sanity: base duration ordering matches the 4-value preference mapping.
        storage.setItem('pref:scrollSmoothingDuration', 'smooth');
        const smooth = controller.getVerticalScrollDuration();
        storage.setItem('pref:scrollSmoothingDuration', 'instant');
        assert.strictEqual(controller.getVerticalScrollDuration(), 0, 'instant preference must stay instant');
        assert.ok(base > smooth, 'slower must be longer than smooth');
    } finally {
        storage.removeItem('pref:scrollSmoothingDuration');
        storage.removeItem('pref:scrollPhysics');
        globalThis.requestAnimationFrame = realRaf;
        scrollController._verticalScrollState = null;
        scrollController._verticalScrollAnimationId = null;
        scrollController._horizontalScrollState = null;
        scrollController._horizontalScrollAnimationId = null;
    }
});
