/**
 * ============================================================================
 * Litefin - Idle Gate
 * ============================================================================
 * Lightweight, ES5-safe "run this background task when the user is idle"
 * scheduler shared by boot-time chunk prewarming and Smart Hub service IPC.
 *
 * Why not requestIdleCallback:
 *   AppleWebKit/538.1 (Tizen 2.3/2.4, webOS 1–2) does not expose
 *   requestIdleCallback at all. A setTimeout poll against the last interaction
 *   timestamp and scrollController.isAnimating works on every supported engine.
 *
 * Activity sources:
 *   - keydown (D-pad / remote / keyboard), mousedown, wheel
 *   - 'scroll:finished' from ScrollController / TouchHorizontalScroller
 *
 * No Set/Map iterators, no for..of, no Object.values — only plain arrays and
 * null-prototype objects so WebKit 538.1 can execute this file directly.
 * ============================================================================
 */

import { eventBus } from '../core/EventBus.js';
import { scrollController } from '../ui/ScrollController.js';

/** Default quiet window (ms) before a background task may run. */
const DEFAULT_IDLE_THRESHOLD_MS = 4000;

/** Default upper bound (ms) for how long a task may wait for true idleness. */
const DEFAULT_MAX_WAIT_MS = 30000;

/** Poll cadence (ms) while a scroll animation is still in flight. */
const ANIMATION_POLL_MS = 50;

/** Timestamp of the last observed user interaction. */
let _lastActivityAt = Date.now();

/** Monotonic task id generator. */
let _nextTaskId = 0;

/** Active timers keyed by task id (null-prototype keeps this ES5-friendly). */
const _timers = Object.create(null);

/**
 * Records a user interaction. Resets the idle window for every pending task.
 * @public
 */
export function markActivity() {
    _lastActivityAt = Date.now();
}

/**
 * Timestamp of the last recorded interaction.
 * @returns {number}
 * @public
 */
export function getLastActivityTime() {
    return _lastActivityAt;
}

/**
 * True while any scroll animation (RAF, spring, or native smooth scroll) is
 * still running. CSS-composited row transitions finish within a few hundred
 * milliseconds, well inside the idle threshold, so the timestamp covers them.
 * @returns {boolean}
 * @private
 */
function _isScrollAnimating() {
    try {
        if (scrollController && scrollController.isAnimating) return true;

        // Fallback for test harnesses / early module evaluation where the
        // singleton may not have been imported yet (ScrollController exposes
        // itself on window explicitly for exactly this kind of late lookup).
        const exposed = typeof window !== 'undefined' ? window.__scrollController : null;
        return !!(exposed && exposed.isAnimating);
    } catch (_) {
        return false;
    }
}

/**
 * Normalises an optional positive millisecond value.
 * @param {number|undefined} value
 * @param {number} fallback
 * @returns {number}
 * @private
 */
function _resolveMs(value, fallback) {
    return typeof value === 'number' && value >= 0 ? value : fallback;
}

/**
 * True when the user interacted or scrolled within the last `thresholdMs`.
 * @param {number} [thresholdMs]
 * @returns {boolean}
 * @public
 */
export function isUserActive(thresholdMs) {
    const threshold = _resolveMs(thresholdMs, DEFAULT_IDLE_THRESHOLD_MS);
    if (_isScrollAnimating()) return true;
    return Date.now() - _lastActivityAt < threshold;
}

/**
 * True when the user has been quiet for `thresholdMs` and nothing is animating.
 * @param {number} [thresholdMs]
 * @returns {boolean}
 * @public
 */
export function isUserIdle(thresholdMs) {
    const threshold = _resolveMs(thresholdMs, DEFAULT_IDLE_THRESHOLD_MS);
    return !_isScrollAnimating() && Date.now() - _lastActivityAt >= threshold;
}

/**
 * Runs `callback` once the user has been idle for `idleThresholdMs`.
 *
 * The callback is deferred (never fired synchronously) so callers can safely
 * use this on a boot path. If the user keeps interacting, the task is
 * re-checked after the remaining idle window. `maxWaitMs` caps how long the
 * task may be postponed: once the cap is reached it runs at the first moment
 * no scroll animation is active. Pass `0` (or omit a finite cap) for
 * non-urgent work that should wait indefinitely for a quiet UI.
 *
 * @param {Function} callback - Work to run when idle
 * @param {number} [idleThresholdMs=4000] - Required quiet window
 * @param {number} [maxWaitMs=30000] - Optional max postponement (0 = unbounded)
 * @returns {number} Task id for cancelIdleTask()
 * @public
 */
export function runWhenIdle(callback, idleThresholdMs, maxWaitMs) {
    if (typeof callback !== 'function') return 0;

    const threshold = _resolveMs(idleThresholdMs, DEFAULT_IDLE_THRESHOLD_MS);
    const cap = _resolveMs(maxWaitMs, DEFAULT_MAX_WAIT_MS);
    const id = ++_nextTaskId;
    const startedAt = Date.now();

    const tick = () => {
        if (!_timers[id]) return; // cancelled
        clearTimeout(_timers[id]);

        const now = Date.now();
        const idleFor = now - _lastActivityAt;
        const waited = now - startedAt;
        const animating = _isScrollAnimating();
        const capReached = cap > 0 && waited >= cap;

        if (!animating && (idleFor >= threshold || capReached)) {
            delete _timers[id];
            callback();
            return;
        }

        let delay;
        if (animating) {
            // Animation owns the main thread; poll cheaply until it settles.
            delay = ANIMATION_POLL_MS;
        } else {
            const remainingIdle = threshold - idleFor;
            delay = remainingIdle > 0 ? remainingIdle : ANIMATION_POLL_MS;
        }

        // Never overshoot the max-wait cap by a whole idle window.
        if (cap > 0 && !animating) {
            const remainingCap = cap - waited;
            if (remainingCap > 0 && remainingCap < delay) delay = remainingCap;
        }

        if (delay < 16) delay = 16;
        _timers[id] = setTimeout(tick, delay);
    };

    let initialDelay = threshold - (Date.now() - _lastActivityAt);
    if (initialDelay < 0) initialDelay = 0;
    _timers[id] = setTimeout(tick, initialDelay);

    return id;
}

/**
 * Cancels a pending runWhenIdle() task. Safe to call with null/stale ids.
 * @param {number} id
 * @public
 */
export function cancelIdleTask(id) {
    if (id && _timers[id]) {
        clearTimeout(_timers[id]);
        delete _timers[id];
    }
}

// ============================================================================
// Activity listeners (installed once at module evaluation)
// ============================================================================
if (typeof document !== 'undefined' && document && typeof document.addEventListener === 'function') {
    // Capture phase sees remote/keyboard input before FocusManager handlers.
    document.addEventListener('keydown', markActivity, true);
    document.addEventListener('mousedown', markActivity, true);
    document.addEventListener('wheel', markActivity, true);
}

// Scroll completion is emitted by ScrollController and TouchHorizontalScroller.
eventBus.on('scroll:finished', markActivity);

// Returning from background / app resume is a fresh interaction context.
eventBus.on('app:visible', markActivity);

/**
 * Singleton facade used by App.js and SmartHubManager.js.
 * @public
 */
export const idleGate = {
    markActivity,
    getLastActivityTime,
    isUserActive,
    isUserIdle,
    runWhenIdle,
    cancel: cancelIdleTask
};

export default idleGate;
