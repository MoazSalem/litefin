/**
 * ============================================================================
 * Litefin - SpringPhysics
 * ============================================================================
 * Scroll physics engines (pure, dependency-free functions only):
 *
 *   1. SPRING   — critically damped harmonic oscillator (Apple TV style)
 *                 x'' = ω²·(target − x) − 2ζω·x'
 *   2. CHASE    — first-order exponential follower (continuous camera)
 *                 x' = (target − x)/τ
 *   3. RAIL     — constant-velocity travel with a linear deceleration tail
 *   4. FLING    — momentum sweep: velocity-capped follower with ramp-up
 *
 * All engines are velocity/time-driven and frame-rate normalized, so a
 * 30fps webOS 3 panel gets the same trajectory shape as a 120Hz panel.
 * ============================================================================
 */

// ============================================================================
// Tunable constants — all tunable values in one place for easy TV tweaking
// ============================================================================

/**
 * Damping ratio (ζ). ζ = 1.0 is critically damped — the Apple TV (tvOS)
 * character: a fast glide toward the target and a smooth asymptotic stop
 * with **zero overshoot or bounce**.
 *
 * Numerically verified (tests/SpringScrollPhysics.test.js simulates the whole
 * trajectory space):
 *   - Single hops: monotonic approach, 0.00% overshoot across the entire hop grid.
 *   - Held D-pad key storms (press every 125ms) couple into a steady glide
 *     with a small trailing gap (≤~200px on huge rows), never pumping or
 *     diverging, landing exactly on the final target.
 */
export const SPRING_DAMPING_RATIO = 1.0;

/**
 * Natural frequency factor. ω = factor / (ζ·T) where T is the duration
 * preference budget. With critical damping the un-damped factor of 3 leaves
 * a dragging exponential tail, so the tuned value tightens the envelope
 * while keeping the glide Apple-TV smooth (verified settle times: 192-850ms
 * across the hop grid, always ≤ ~2.3× the duration budget).
 */
export const SPRING_FREQUENCY_FACTOR = 5.0;

/**
 * Chase (continuous follower) time constant factor. τ = T / factor where T
 * is the duration preference budget. The camera closes (target − x) with an
 * exponential envelope; settle needs ~ln(2·D/0.5px) · τ, so factor 3.2 puts
 * a 400px/180ms hop at ~380ms — same territory as the spring engine.
 */
export const CHASE_TAU_FACTOR = 3.2;

/**
 * Rail (constant velocity) deceleration zone as a fraction of the hop
 * distance. The camera holds a fixed px/ms speed for the first (1 − zone)
 * of the hop, then ramps speed linearly to zero across the last zone.
 */
export const RAIL_DECEL_ZONE_FRACTION = 0.35;

/**
 * Fling (momentum sweep) maximum camera velocity as a multiple of the launch
 * speed v0 = 2·D/T. During held navigation the camera ramps velocity up to
 * this ceiling (falling further behind the focus — the "frantic sweep" feel)
 * and decays back down exponentially after the last keypress.
 */
export const FLING_VELOCITY_MULTIPLIER = 1.45;

/**
 * Fling ramp-up time constant (ms): how quickly engine velocity chases the
 * desired velocity. Small values feel twitchy, large values feel floaty.
 */
export const FLING_RAMP_TAU_MS = 45;

/**
 * Fling braking deceleration (px/ms²). Constrains the desired velocity to
 * `sqrt(2·a·lag)` so the engine always carries enough stopping distance to
 * glide into the target with zero residual speed — friction-glide landing,
 * no hard stops, no crossing.
 */
export const FLING_BRAKE_DECEL_PX_MS2 = 0.04;

/**
 * Minimum duration (ms) used for deriving the spring's natural frequency.
 * Hops below this still feel like a spring, not a rubber-band snap.
 */
export const SPRING_MIN_DURATION_MS = 60;

/**
 * Initial velocity cap as a fraction of the natural impulse scale (ω·D).
 * Prevents large-hop overshoot spikes on TV compositors.
 */
export const SPRING_IMPETUS_CAP = 0.9;

/**
 * Hard velocity ceiling (px/ms) = 7000 px/s. Protects virtual row window
 * updates and TV compositors from extreme impulses.
 */
export const SPRING_VELOCITY_CEILING_PX_MS = 7;

/**
 * Integration substep (ms). The integrator is semi-implicit Euler, which is
 * stable for ω·dt ≪ 1. 8ms substeps guarantee stability and identical
 * trajectories at 30/60/120 Hz displays.
 */
export const SPRING_SUBSTEP_MS = 8;

/**
 * Settle thresholds: the spring is considered finished when the remaining
 * distance (px) and velocity magnitude (px/ms) both fall under these.
 */
export const SPRING_SETTLE_DISTANCE_PX = 0.3;
export const SPRING_SETTLE_VELOCITY_PX_MS = 0.015;

/**
 * Settle distance (px) shared by the CHASE / RAIL / FLING engines. These
 * engines have no velocity-based stop criterion to satisfy, so their settle
 * is distance-only (0.5px is far below any display's effective resolution).
 */
export const PHYSICS_SETTLE_DISTANCE_PX = 0.5;

/**
 * Absolute animation timeout (ms). Safety net for pathological retarget
 * storms and tiny residual demands that technically equal the thresholds.
 */
export const SPRING_MAX_DURATION_MS = 1200;

/**
 * Builds spring parameters for a hop of `distance` px within a `durationMs`
 * settle budget.
 *
 * The natural frequency is derived from the duration preference:
 * an underdamped decay envelope e^(−ζωt) reaches ~5% residual when ζωt ≈ 3,
 * so ω = 3 / (ζ·T). This adapts the spring to the user's scroll duration
 * preference ('current' → snappy, 'slower' → relaxed, cinematic glide).
 *
 * @param {number} distance - Signed travel distance (target − current), px
 * @param {number} durationMs - Settle budget from duration preference, ms
 * @returns {{omega: number, zeta: number, v0: number}} Spring parameters
 */
export function createSpring(distance, durationMs) {
    const dist = Math.abs(distance);
    const dur = Math.max(durationMs || 0, SPRING_MIN_DURATION_MS);
    const zeta = SPRING_DAMPING_RATIO;
    const omega = SPRING_FREQUENCY_FACTOR / (zeta * dur);

    // Match the outgoing velocity of the old easeOutQuad engine (initial
    // slope 2 → v0 = 2·D/T), capped as a fraction of the natural impulse
    // scale ω·D so far hops never spike past the compositor budget.
    const target = Math.min((2 * dist) / dur, SPRING_IMPETUS_CAP * omega * Math.max(dist, 1));
    let v0 = Math.sign(distance) * target;

    if (Math.abs(v0) > SPRING_VELOCITY_CEILING_PX_MS) {
        v0 = Math.sign(v0) * SPRING_VELOCITY_CEILING_PX_MS;
    }

    return { omega, zeta, v0 };
}

/**
 * One semi-implicit Euler integration step.
 *
 * @param {number} x - Current position, px
 * @param {number} v - Current velocity, px/ms
 * @param {number} target - Target position, px
 * @param {number} omega - Natural frequency, rad/ms
 * @param {number} zeta - Damping ratio
 * @param {number} dt - Timestep, ms (should be ≤ SPRING_SUBSTEP_MS)
 * @returns {[number, number]} New [x, v]
 */
export function springStep(x, v, target, omega, zeta, dt) {
    const springForce = omega * omega * (target - x);
    const dampingForce = 2 * zeta * omega * v;
    let nv = v + (springForce - dampingForce) * dt;
    if (nv > SPRING_VELOCITY_CEILING_PX_MS) nv = SPRING_VELOCITY_CEILING_PX_MS;
    else if (nv < -SPRING_VELOCITY_CEILING_PX_MS) nv = -SPRING_VELOCITY_CEILING_PX_MS;
    return [x + nv * dt, nv];
}

/**
 * Offline simulation of a full spring hop. Used by the test suite to verify
 * settle time, overshoot and termination without a browser RAF loop.
 *
 * @param {number} x0 - Start position, px
 * @param {number} target - Target position, px
 * @param {number} durationMs - Duration budget, ms
 * @param {number} [maxDurationMs=SPRING_MAX_DURATION_MS] - Hard timeout
 * @returns {{durationMs: number, overshootPx: number, overshootRatio: number, settled: boolean}}
 */
export function simulateSpring(x0, target, durationMs, maxDurationMs = SPRING_MAX_DURATION_MS) {
    const { omega, zeta, v0 } = createSpring(target - x0, durationMs);
    const dir = Math.sign(target - x0);
    let x = x0;
    let v = v0;
    let t = 0;
    let overPx = 0;
    let settled = false;

    while (t < maxDurationMs) {
        const step = Math.min(SPRING_SUBSTEP_MS, maxDurationMs - t);
        [x, v] = springStep(x, v, target, omega, zeta, step);
        t += step;

        // Only positions genuinely beyond the target (in the direction of
        // travel) count as overshoot; measure along the hop direction.
        const beyond = (x - target) * dir;
        if (beyond > overPx) {
            overPx = beyond;
        }

        if (Math.abs(target - x) < SPRING_SETTLE_DISTANCE_PX && Math.abs(v) < SPRING_SETTLE_VELOCITY_PX_MS) {
            settled = true;
            break;
        }
    }

    const hopDist = Math.abs(target - x0) || 1;
    return {
        durationMs: t,
        overshootPx: overPx,
        overshootRatio: overPx / hopDist,
        settled
    };
}

/**
 * ============================================================================
 * CHASE — first-order exponential follower (continuous camera)
 * ============================================================================
 * The camera continuously converges on the target: x' = (target − x)/τ.
 *
 * Properties that matter on weak hardware (webOS 3):
 *   - ONE exponential per frame — cheaper than every other non-trivial engine.
 *   - Frame-time normalized: identical trajectory shape at 30 or 120 Hz.
 *   - Frame-stall proof: (1 − e^(−dt/τ)) saturates at 1, so a dropped frame
 *     can never explode the position (it just lands exactly on target).
 *   - Retarget-free by construction: there is no "animation" to restart;
 *     smoothScrollTo simply re-aims the shared target.
 *
 * @param {number} x - Camera position, px
 * @param {number} target - Target position, px
 * @param {number} tau - Convergence time constant, ms
 * @param {number} dt - Timestep, ms (guarded against 0)
 * @returns {[number, number]} New [x, instantaneous velocity px/ms]
 */
export function chaseStep(x, target, tau, dt) {
    if (dt <= 0) return [x, 0];
    // Exponential smoothing factor saturates at 1: a huge dt (frame stall)
    // can place the camera AT the target, never past it — stall-safe.
    const k = 1 - Math.exp(-dt / Math.max(tau, 0.001));
    const nx = x + (target - x) * k;
    return [nx, (nx - x) / dt];
}

/**
 * ============================================================================
 * RAIL — constant-velocity travel with a linear deceleration tail
 * ============================================================================
 * The camera holds a fixed speed for the first (1 − zone) of the remaining
 * hop, then ramps speed linearly to zero across the final `decelZone` px.
 *
 * Properties that matter on weak hardware:
 *   - ~10 arithmetic ops per frame; no exponentials, no oscillators.
 *   - Trajectory is a fixed px/ms slope: every frame is congruent, so
 *     30fps devices read as "slightly slower", never as lurching.
 *   - Acceleration is piecewise constant → no inertial overshoot.
 *   - Crossing guard: speed·dt can never land past the target.
 *
 * @param {number} x - Camera position, px
 * @param {number} target - Target position, px
 * @param {number} speed - Full-travel speed, px/ms (= describedHop / T)
 * @param {number} decelZone - Linear ramp-down zone, px
 * @param {number} dt - Timestep, ms
 * @returns {[number, number]} New [x, current speed px/ms]
 */
export function railStep(x, target, speed, decelZone, dt) {
    const remaining = Math.abs(target - x);
    if (remaining < 0.01 || dt <= 0) return [target, 0];

    const zone = Math.max(decelZone, 0.001);
    const v = remaining > zone ? speed : (speed * remaining) / zone;
    const travel = v * dt;

    // Crossing guard — the camera can never shoot past the destination.
    if (travel >= remaining) return [target, 0];
    return [x + Math.sign(target - x) * travel, v];
}

/**
 * ============================================================================
 * FLING — momentum sweep: velocity-capped follower with ramp-up
 * ============================================================================
 * A chase variant where camera *velocity* is a state. Each frame the engine
 * ramps velocity toward a desired value (lag/τ) clamped to a momentum
 * ceiling:
 *
 *     v' → clamp((target − x)/τ, ±vCap),   x' → clamp(x + v·dt at target)
 *
 * During held key repeats the camera ramps to vCap and sweeps continuously
 * (falling behind focus — the fling feel); after release the lag — and thus
 * the desired velocity — decays and the camera glides into the target.
 * Crossing and ceiling clamps make overshoot impossible.
 *
 * @param {number} x - Camera position, px
 * @param {number} v - Camera velocity, px/ms
 * @param {number} target - Target position, px
 * @param {number} tau - Convergence time constant, ms
 * @param {number} vCap - Momentum velocity ceiling, px/ms
 * @param {number} dt - Timestep, ms
 * @returns {[number, number]} New [x, v]
 */
export function flingStep(x, v, target, tau, vCap, dt) {
    if (dt <= 0) return [x, v];
    // Landed: kill momentum instantly so the camera can never drift past.
    if (x === target) return [x, 0];

    const dir = Math.sign(target - x);
    const lag = Math.abs(target - x);

    // Desired velocity: chase lag/τ, then clamp by the momentum ceiling AND
    // by the braking distance sqrt(2·a·lag) — guarantees a friction glide
    // that lands exactly on the target with zero residual speed.
    let speed = Math.min(Math.abs(target - x) / Math.max(tau, 0.001), vCap);
    const brakeLimit = Math.sqrt(2 * FLING_BRAKE_DECEL_PX_MS2 * lag);
    speed = Math.min(speed, brakeLimit);
    const clampedDesired = dir * speed;

    // Velocity ramp (momentum retention): v drifts toward desired exp-slowly.
    const k = 1 - Math.exp(-dt / FLING_RAMP_TAU_MS);
    let nv = v + (clampedDesired - v) * k;
    nv = Math.max(-vCap, Math.min(vCap, nv));

    let nx = x + nv * dt;
    // Crossing guard: never land past the target with residual momentum.
    if (dir !== 0 && (nx - x) * dir > Math.abs(target - x)) {
        nx = target;
        nv = 0;
    }
    return [nx, nv];
}

/**
 * ============================================================================
 * PREFERENCE NORMALIZATION
 * ============================================================================
 * Single source of truth for which engine identifiers the scroll physics
 * setting accepts. Shared by ScrollController, TouchHorizontalScroller and
 * the settings UI so every surface resolves the stored preference the same
 * way (and unrecognized garbage always falls back to classic easing).
 */

/** All engine identifiers recognized by the pref:scrollPhysics setting. */
export const SCROLL_PHYSICS_ENGINES = ['easing', 'spring', 'chase', 'rail', 'fling'];

/**
 * Validates a stored scroll physics preference value.
 *
 * @param {string|null|undefined} value - Raw value from storage
 * @returns {'easing'|'spring'|'chase'|'rail'|'fling'} Resolved engine
 *   ('spring' for null, unknown, or the default physics mode)
 */
export function normalizeScrollPhysics(value) {
    /*
     * If an explicit supported engine preference exists in storage, honor it directly.
     * This preserves user selections including classic easing and secondary followers.
     */
    if (value && SCROLL_PHYSICS_ENGINES.includes(value)) {
        return value;
    }

    /*
     * Fresh or unconfigured environments default to critically-damped spring physics
     * to provide smooth and natural velocity-based scrolling transitions across UI rows.
     */
    return 'spring';
}
