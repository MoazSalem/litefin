/**
 * ============================================================================
 * Litefin - Android Touch Horizontal Scroller
 * ============================================================================
 * Converts media rows into silky, native touch scrollers under Android while
 * seamlessly preserving D-pad / spatial navigation centering geometry.
 *
 * Architecture & Physics:
 *   - The container element `.row-items` receives `overflow-x: auto` via
 *     injected CSS so the browser engine compositor directly handles touch
 *     tracking, momentum decay, and fling inertia.
 *   - JavaScript does NOT manipulate pixel positions during active touch drag,
 *     guaranteeing zero touch lag and maintaining native compositor frame rates.
 *
 * Responsibilities Managed Here:
 *   1. settleToCardCenter()  — After compositor fling inertia completes, glides
 *      the row smoothly to align with the nearest card center according to
 *      ScrollController's geometric specs, allowing TV D-pad navigation to resume
 *      instantly from that precise card. The glide honors the opt-in
 *      pref:scrollPhysics engine setting (spring / chase / rail / fling via
 *      the shared SpringPhysics integrators), falling back to the classic
 *      easeOutQuad settle when physics is disabled.
 *   2. Click suppression     — Prevents accidental selection/activation of cards
 *      upon lifting the finger after a horizontal pan or fling gesture.
 *   3. Virtual window sync   — Keeps VirtualCardRow's dynamic DOM card window
 *      properly populated and aligned with current viewport bounds during scroll.
 *   4. Scrollbar and overscroll glow suppression for clean native TV/mobile look.
 * ============================================================================
 */

import { platformInfo } from '../utils/PlatformInfo.js';
import { eventBus } from '../core/EventBus.js';
import { logger } from '../utils/Logger.js';
import { storage } from '../utils/StorageService.js';
import {
    createSpring,
    springStep,
    chaseStep,
    railStep,
    flingStep,
    normalizeScrollPhysics,
    SPRING_SUBSTEP_MS,
    SPRING_SETTLE_DISTANCE_PX,
    SPRING_SETTLE_VELOCITY_PX_MS,
    SPRING_MAX_DURATION_MS,
    NOMINAL_FRAME_MS,
    stableFrameDelta,
    CHASE_TAU_FACTOR,
    RAIL_DECEL_ZONE_FRACTION,
    FLING_VELOCITY_MULTIPLIER,
    PHYSICS_SETTLE_DISTANCE_PX,
    getHorizontalDurationMs
} from '../ui/SpringPhysics.js';

const log = logger.create('TouchHorizontalScroller');

// ============================================================================
// Timing & Kinematic Configuration Constants
// ============================================================================

/** Maximum duration in milliseconds for the post-fling settle animation */
const MAX_SETTLE_MS = 600;

/** Pixel boundary threshold to consider a card already centered */
const SETTLE_TOLERANCE_PX = 12;

/** Minimum pointer displacement in pixels required to register as a drag */
const DRAG_SLOP_PX = 8;

/** Grace period after pointerup before starting alignment check (ms) */
const SETTLE_MIN_WAIT_MS = 300;

/** Consecutive frames of stationary scroll needed to detect fling halt */
const SETTLE_STILL_FRAMES = 3;

/** Absolute timeout for fling stabilization before forcing settle (ms) */
const SETTLE_MAX_WAIT_MS = 2500;

/** Displacement delta threshold in pixels to count as stationary */
const SETTLE_STILL_PX = 0.5;

/** Time window following drag completion where card clicks are blocked (ms) */
const CLICK_SUPPRESS_MS = 400;

/**
 * ============================================================================
 * TouchHorizontalScroller Class
 * ============================================================================
 */
export class TouchHorizontalScroller {
    constructor() {
        // Lifecycle and state flags
        this._initialized = false;

        // Registered cleanup handlers
        this._unsubscribers = [];

        // Active per-row settle animation frame references
        this._settleAnims = new Map();

        // Reference to the most recently touched row element
        this._lastTouchedRow = null;

        // Pending post-fling settle watcher state tracker
        this._flingWatcher = null;

        // Drag gesture coordinates and pointer tracking
        this._activePointerId = null;
        this._downX = 0;
        this._downY = 0;
        this._moved = false;
        this._blockClickUntil = 0;

        // Bound event listener references for clean teardown
        this._grabListener = null;
        this._moveListener = null;
        this._upListener = null;
        this._clickCaptureListener = null;
        this._scrollListener = null;
        this._keyListener = null;
        this._scrollIdleTimer = null;
    }

    /**
     * Initializes touch scrolling capabilities on Android platforms.
     * Invoked automatically by AndroidAdapter.init().
     */
    init() {
        // Guard against duplicate initialization or non-Android runtimes
        if (this._initialized || !platformInfo.isAndroid) {
            return;
        }
        this._initialized = true;

        log.info('Initializing TouchHorizontalScroller for Android touch devices...');

        // Attach global pointer and scroll monitoring listeners
        this._installListeners();

        // Enable D-pad override: if remote key is pressed during settling,
        // snap instantly to current settle target to avoid input conflicts
        this._keyListener = (e) => {
            const NAV_KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', ' '];
            if (NAV_KEYS.includes(e.key)) {
                this._handleDpad();
            }
        };
        document.addEventListener('keydown', this._keyListener, { capture: true });
    }

    /**
     * Performs complete cleanup of all event listeners, animations, and timers.
     */
    destroy() {
        // Execute all registered teardown callbacks
        this._unsubscribers.forEach((fn) => {
            try {
                fn();
            } catch (err) {
                log.warn('Unsubscriber callback failed:', err);
            }
        });
        this._unsubscribers = [];

        // Cancel running animation frames on all rows
        this._settleAnims.forEach((state) => cancelAnimationFrame(state.raf));
        this._settleAnims.clear();

        // Stop any running fling observer
        this._cancelFlingWatcher();

        // Remove document-level pointer listeners
        if (this._grabListener) {
            document.removeEventListener('pointerdown', this._grabListener, { capture: true });
            this._grabListener = null;
        }
        if (this._moveListener) {
            document.removeEventListener('pointermove', this._moveListener, { capture: true });
            this._moveListener = null;
        }
        if (this._upListener) {
            document.removeEventListener('pointerup', this._upListener, { capture: true });
            document.removeEventListener('pointercancel', this._upListener, { capture: true });
            this._upListener = null;
        }
        if (this._clickCaptureListener) {
            document.removeEventListener('click', this._clickCaptureListener, { capture: true });
            this._clickCaptureListener = null;
        }
        if (this._scrollListener) {
            document.removeEventListener('scroll', this._scrollListener, { capture: true });
            this._scrollListener = null;
        }
        if (this._keyListener) {
            document.removeEventListener('keydown', this._keyListener, { capture: true });
            this._keyListener = null;
        }

        // Clear debounce timer
        clearTimeout(this._scrollIdleTimer);
        this._initialized = false;
        log.info('TouchHorizontalScroller destroyed');
    }

    /**
     * Cancels any in-flight settle animation on a specific row.
     * Public bridge for the web/desktop MouseRowScroller so wheel input can
     * preempt a pending settle without touching private animation state.
     * @param {HTMLElement} rowItems - Media row container
     */
    cancelRowSettle(rowItems) {
        this._cancelSettle(rowItems);
    }

    /**
     * ========================================================================
     * Global Listener Setup
     * ========================================================================
     * Registers gesture detection, click suppression, and scroll synchronizers.
     * @private
     */
    _installListeners() {
        // Capture-phase pointerdown: Detect initial touch contact on media rows
        this._grabListener = (e) => {
            if (e.pointerType !== 'touch' && e.pointerType !== 'mouse') {
                return;
            }
            const track = this._resolveTrack(e.target);
            if (!track) {
                return;
            }

            // Immediately halt any existing momentum watcher on new finger touch
            this._cancelFlingWatcher();

            this._activePointerId = e.pointerId;
            this._downX = e.clientX;
            this._downY = e.clientY;
            this._moved = false;
        };
        document.addEventListener('pointerdown', this._grabListener, { capture: true });

        // Pointer move detection: calculate displacement beyond drag threshold
        this._moveListener = (e) => {
            if (e.pointerId !== this._activePointerId) {
                return;
            }
            const dx = Math.abs(e.clientX - this._downX);
            const dy = Math.abs(e.clientY - this._downY);

            // Flag as intentional drag if horizontal motion exceeds slop
            if (dx > DRAG_SLOP_PX && dx > dy) {
                this._moved = true;
                this._cancelSettleForDrag();
            }
        };
        document.addEventListener('pointermove', this._moveListener, { capture: true });

        // Pointer release handler: schedule settle after finger lifts
        this._upListener = (e) => {
            if (e.pointerId !== this._activePointerId) {
                return;
            }
            this._activePointerId = null;

            if (this._moved) {
                // Prevent synthetic clicks on cards immediately following gesture
                this._blockClickUntil = Date.now() + CLICK_SUPPRESS_MS;
                this._scheduleSettle(e.target);
            }
        };
        document.addEventListener('pointerup', this._upListener, { capture: true });
        document.addEventListener('pointercancel', this._upListener, { capture: true });

        // Click suppression filter: blocks accidental media card selection
        this._clickCaptureListener = (e) => {
            if (Date.now() < this._blockClickUntil && this._resolveTrack(e.target)) {
                e.stopPropagation();
                e.preventDefault();
                log.debug('Suppressed accidental card click following touch swipe');
            }
        };
        document.addEventListener('click', this._clickCaptureListener, { capture: true });

        // Scroll synchronization: update VirtualCardRow rendering as content scrolls
        this._scrollListener = (e) => {
            const target = e.target;
            if (!(target instanceof Element)) {
                return;
            }
            const rowItems = target.closest('.row-items');
            if (!rowItems) {
                return;
            }

            this._lastTouchedRow = rowItems;
            const track = rowItems.querySelector(':scope > .row-items-track');
            const row = track && track.__virtualRow;

            // Synchronize virtual card window with current scroll position
            if (row) {
                row.syncScrollToPosition(this._readScrollX(rowItems));
            }

            // Emit debounced event to allow lazy-loading images to resume
            clearTimeout(this._scrollIdleTimer);
            this._scrollIdleTimer = setTimeout(() => {
                eventBus.emit('scroll:finished');
            }, 250);
        };
        document.addEventListener('scroll', this._scrollListener, { capture: true, passive: true });
    }

    /**
     * ========================================================================
     * Settle Orchestration & Momentum Monitoring
     * ========================================================================
     * Observes the native fling until velocity dies out, then gently eases
     * the row to align the nearest card center with the viewport center.
     * @param {EventTarget} target - Target element from pointerup event
     * @private
     */
    _scheduleSettle(target) {
        const el = target instanceof Element ? target : null;
        const rowItems = el ? el.closest('.row-items') : null;
        if (!rowItems) {
            return;
        }

        const track = rowItems.querySelector(':scope > .row-items-track');
        if (!track) {
            return;
        }

        this._cancelFlingWatcher();

        // -----------------------------------------------------------------
        // Momentum Fling Observer
        // Continuously inspects scrollLeft until consecutive frames indicate
        // that kinetic scrolling has finished, avoiding conflicts with inertia.
        // -----------------------------------------------------------------
        const startTime = performance.now();
        let lastScroll = rowItems.scrollLeft || 0;
        let stillFrames = 0;

        const poll = () => {
            this._flingWatcher = null;

            // Abort settle if user placed another finger on the display
            if (this._activePointerId !== null) {
                return;
            }

            const currentScroll = rowItems.scrollLeft || 0;
            if (Math.abs(currentScroll - lastScroll) < SETTLE_STILL_PX) {
                stillFrames++;
            } else {
                stillFrames = 0;
                lastScroll = currentScroll;
            }

            const elapsed = performance.now() - startTime;

            // Once inertia halts or max wait expires, execute centering ease
            if (
                (stillFrames >= SETTLE_STILL_FRAMES && elapsed >= SETTLE_MIN_WAIT_MS) ||
                elapsed >= SETTLE_MAX_WAIT_MS
            ) {
                this.settleToCardCenter(rowItems);
                return;
            }

            const rafId = requestAnimationFrame(poll);
            this._flingWatcher = { raf: rafId, rowItems };
        };

        const rafId = requestAnimationFrame(poll);
        this._flingWatcher = { raf: rafId, rowItems };
    }

    /**
     * Cancels any pending fling watcher loop.
     * @private
     */
    _cancelFlingWatcher() {
        if (this._flingWatcher) {
            cancelAnimationFrame(this._flingWatcher.raf);
            this._flingWatcher = null;
        }
    }

    /**
     * Aligns row smoothly to the nearest card center position.
     * @param {HTMLElement} rowItems - Media row container
     */
    settleToCardCenter(rowItems) {
        const track = rowItems.querySelector(':scope > .row-items-track');
        if (!track) {
            return;
        }

        const row = track.__virtualRow;
        const containerWidth = rowItems.clientWidth;
        const isRtl = document.documentElement.dir === 'rtl';
        const maxScroll = Math.max(0, (row ? row.getTrackWidth() : track.scrollWidth) - containerWidth);

        let current;
        let target;

        if (row) {
            // Virtualized row layout calculation
            current = this._readScrollX(rowItems);
            const centerPos = current + containerWidth / 2;
            const centerIndex = Math.max(
                0,
                Math.min(
                    row.totalItems - 1,
                    Math.round((centerPos - row.sidePadding - row.itemWidth / 2) / row.totalItemWidth)
                )
            );
            const elementPos = row.getItemPosition(centerIndex);
            const elementWidth = this._expandedWidth(row) || row.itemWidth;
            target = Math.max(0, Math.min(elementPos - containerWidth / 2 + elementWidth / 2, maxScroll));
        } else {
            // Standard non-virtual card row centering
            const cards = track.querySelectorAll('.media-card');
            if (!cards.length) {
                return;
            }
            current = isRtl ? -rowItems.scrollLeft : rowItems.scrollLeft;
            const centerPos = current + containerWidth / 2;
            let best = null;
            let bestDist = Infinity;

            cards.forEach((card) => {
                const pos = isRtl ? -card.offsetLeft : card.offsetLeft;
                const cardCenter = pos + card.offsetWidth / 2;
                const dist = Math.abs(cardCenter - centerPos);
                if (dist < bestDist) {
                    bestDist = dist;
                    best = { pos, width: card.offsetWidth };
                }
            });

            if (!best) {
                return;
            }
            target = Math.max(0, Math.min(best.pos - containerWidth / 2 + best.width / 2, maxScroll));
        }

        // If card is already sufficiently centered within tolerance, finalize immediately
        if (Math.abs(target - current) <= SETTLE_TOLERANCE_PX) {
            this._finalizeSettle(rowItems, row, target);
            return;
        }

        // Animate smooth settle transition to exact target
        this._animateSettle(rowItems, row, current, target, isRtl);
    }

    /**
     * Executes the card-center glide. Honors the opt-in scroll physics
     * engines (pref:scrollPhysics) through the shared SpringPhysics
     * integrators; the classic easeOutQuad curve remains the default path.
     *
     * Engine state lives in the `_settleAnims` map keyed by the row element,
     * so `_handleDpad`, `_cancelSettle` and `destroy` keep working unchanged
     * (they only touch `state.raf` / `state.target`).
     * @private
     */
    _animateSettle(rowItems, row, from, to, isRtl) {
        this._cancelSettle(rowItems);
        const engine = this._getEngine();
        const distance = Math.abs(to - from);
        // Settle budget follows the same 4-value scrollSmoothingDuration
        // preference as everything else ('instant' | 'current' | 'smooth' |
        // 'slower'), scaled up for larger post-fling residuals so big
        // catch-ups still sweep instead of lurching.
        const pref = storage.getItem('pref:scrollSmoothingDuration') || 'smooth';
        const base = getHorizontalDurationMs(pref, platformInfo.isDesktop || platformInfo.isWeb);
        if (base <= 0) {
            // Instant preference: snap onto the card directly.
            this._writeScroll(rowItems, to, isRtl);
            if (row) {
                row.syncScrollToPosition(to);
                row.endTouchScroll(to);
            }
            eventBus.emit('scroll:finished');
            return;
        }
        const duration = Math.min(MAX_SETTLE_MS, Math.max(base, Math.round(distance * 0.5)));

        // Shared position writer: drives the native scrollLeft AND keeps
        // VirtualCardRow's virtual window synchronized mid-animation.
        const write = (value) => {
            this._writeScroll(rowItems, value, isRtl);
            if (row) {
                row.syncScrollToPosition(value);
            }
        };

        if (engine === 'easing') {
            // ----------------------------------------------------------------
            // Classic path (default): time-based easeOutQuad, unchanged.
            // ----------------------------------------------------------------
            const startTime = performance.now();

            const tick = (now) => {
                // A new touch gesture cancels running settle animation
                if (this._activePointerId !== null) {
                    this._cancelSettle(rowItems);
                    return;
                }

                const progress = Math.min((now - startTime) / duration, 1);
                // Ease out quad equation
                const eased = progress * (2 - progress);
                const value = from + (to - from) * eased;

                write(value);

                if (progress < 1) {
                    const state = this._settleAnims.get(rowItems);
                    if (state) {
                        state.raf = requestAnimationFrame(tick);
                    }
                } else {
                    this._finalizeSettle(rowItems, row, to);
                }
            };

            this._settleAnims.set(rowItems, { raf: requestAnimationFrame(tick), target: to });
            return;
        }

        // ====================================================================
        // SCROLL PHYSICS ENGINES (OPT-IN)
        // ====================================================================
        // Velocity-driven integrators from SpringPhysics, identical to the
        // ones ScrollController drives: spring (critically damped Apple TV
        // glide), chase (exponential follower), rail (constant velocity with
        // linear decel tail) and fling (momentum sweep). All are
        // frame-rate normalized, so low-fps Android panels get the same
        // trajectory shape. Substeps: 8ms for the spring's second-order
        // integrator, 16ms for the follower engines.
        // ====================================================================
        const state = {
            engine,
            physics: true,
            target: to,
            x: from,
            v: 0,
            elapsed: 0,
            lastFrameTime: null,
            samples: [],
            raf: 0,
            write
        };

        if (engine === 'chase') {
            state.tau = duration / CHASE_TAU_FACTOR;
        } else if (engine === 'rail') {
            // Constant slope matched to the classic curve's departure speed
            // (2·D/T), with a linear deceleration tail.
            state.speed = (2 * distance) / duration;
            state.decelZone = RAIL_DECEL_ZONE_FRACTION * distance;
        } else if (engine === 'fling') {
            state.tau = duration / CHASE_TAU_FACTOR;
            state.vCap = Math.max((FLING_VELOCITY_MULTIPLIER * (2 * distance)) / duration, 0.3);
        } else {
            // Spring: derive ω/ζ from the duration budget and launch with the
            // same initial impulse the classic curve departs with (v0 = 2·D/T).
            const { omega, zeta, v0 } = createSpring(to - from, duration);
            state.omega = omega;
            state.zeta = zeta;
            state.v = v0;
        }

        const advance = (h) => {
            switch (engine) {
                case 'chase':
                    return chaseStep(state.x, state.target, state.tau, h);
                case 'rail':
                    return railStep(state.x, state.target, state.speed, state.decelZone, h);
                case 'fling':
                    return flingStep(state.x, state.v, state.target, state.tau, state.vCap, h);
                default:
                    return springStep(state.x, state.v, state.target, state.omega, state.zeta, h);
            }
        };

        const settled = () => {
            const dx = Math.abs(state.target - state.x);
            if (engine === 'spring') {
                return dx < SPRING_SETTLE_DISTANCE_PX && Math.abs(state.v) < SPRING_SETTLE_VELOCITY_PX_MS;
            }
            if (engine === 'fling') {
                return dx < PHYSICS_SETTLE_DISTANCE_PX && Math.abs(state.v) < SPRING_SETTLE_VELOCITY_PX_MS;
            }
            return dx < PHYSICS_SETTLE_DISTANCE_PX;
        };

        const tick = (now) => {
            // A new touch gesture cancels running settle animation
            if (this._activePointerId !== null) {
                this._cancelSettle(rowItems);
                return;
            }

            // Identity guard: only the state currently registered for this
            // row may drive it (protects against stale frames after a swap).
            if (this._settleAnims.get(rowItems) !== state) {
                return;
            }

            if (state.lastFrameTime === null) {
                state.lastFrameTime = now;
            }
            // FIXED CADENCE STEP (matches ScrollController): every paint
            // advances the same simulated time, so deliveries with late
            // frames do not dent or teleport mid-sweep.
            const rawDelta = now - state.lastFrameTime;
            state.lastFrameTime = now;
            state.samples.push(rawDelta);
            if (state.samples.length > 16) state.samples.shift();
            let dt = stableFrameDelta(state.samples, NOMINAL_FRAME_MS);
            state.elapsed += dt;

            while (dt > 0) {
                const h = Math.min(dt, engine === 'spring' ? SPRING_SUBSTEP_MS : 16);
                const [nx, nv] = advance(h);
                state.x = nx;
                state.v = nv;
                dt -= h;
            }

            write(state.x);

            const timedOut = state.elapsed >= SPRING_MAX_DURATION_MS;
            if (settled() || timedOut) {
                // Snap exactly onto the centering target, then finalize
                // (endTouchScroll + scroll:finished) — identical semantics
                // to the classic path.
                write(state.target);
                this._finalizeSettle(rowItems, row, state.target);
                return;
            }

            state.raf = requestAnimationFrame(tick);
        };

        state.raf = requestAnimationFrame(tick);
        this._settleAnims.set(rowItems, state);
    }

    /**
     * Finalizes settle operation, records index on VirtualCardRow, and emits completion.
     * @private
     */
    _finalizeSettle(rowItems, row, finalX) {
        this._settleAnims.delete(rowItems);
        if (row) {
            row.endTouchScroll(finalX);
        }
        eventBus.emit('scroll:finished');
    }

    /**
     * Cancels running settle animation on a specific row.
     * @private
     */
    _cancelSettle(rowItems) {
        const state = this._settleAnims.get(rowItems);
        if (state) {
            cancelAnimationFrame(state.raf);
            this._settleAnims.delete(rowItems);
        }
    }

    /**
     * Cancels any settle in progress when a new drag gesture initiates.
     * @private
     */
    _cancelSettleForDrag() {
        const el = document.elementFromPoint(this._downX, this._downY);
        if (!el) {
            return;
        }
        const rowItems = el.closest('.row-items');
        if (rowItems) {
            this._cancelSettle(rowItems);
        } else {
            this._settleAnims.forEach((state) => cancelAnimationFrame(state.raf));
        }
    }

    /**
     * ========================================================================
     * D-Pad Spatial Navigation Interoperability
     * ========================================================================
     * Snaps any active settle animation immediately so remote navigation
     * seamlessly takes control without fighting in-flight touch animations.
     * @private
     */
    _handleDpad() {
        this._cancelFlingWatcher();
        if (this._settleAnims.size === 0) {
            return;
        }

        this._settleAnims.forEach((state, rowItems) => {
            cancelAnimationFrame(state.raf);
            this._settleAnims.delete(rowItems);
            const track = rowItems.querySelector(':scope > .row-items-track');
            const row = track && track.__virtualRow;
            const isRtl = document.documentElement.dir === 'rtl';

            // Snap directly to settle target for consistent focus position
            this._writeScroll(rowItems, state.target, isRtl);
            if (row) {
                row.endTouchScroll(state.target);
            }
        });
    }

    /**
     * ========================================================================
     * Helpers & Coordinate Normalization
     * ========================================================================
     */

    /**
     * Resolves the scroll physics engine from the shared pref:scrollPhysics
     * setting (Performance tab). Uses the SpringPhysics normalizer so the
     * valid set and fallback behavior match ScrollController exactly, without
     * importing the ScrollController singleton (avoids cross-module coupling).
     * @returns {'easing'|'spring'|'chase'|'rail'|'fling'}
     * @private
     */
    _getEngine() {
        return normalizeScrollPhysics(storage.getItem('pref:scrollPhysics'));
    }

    /**
     * Reads current horizontal scroll position normalized to video space.
     * @param {HTMLElement} rowItems
     * @returns {number}
     * @private
     */
    _readScrollX(rowItems) {
        const raw = rowItems.scrollLeft || 0;
        const isRtl = document.documentElement.dir === 'rtl';
        if (!isRtl) {
            return raw;
        }
        // RTL Chromium normalizes scrollLeft to negative values; invert to positive
        return -raw;
    }

    /**
     * Writes normalized scroll position to element scrollLeft.
     * @param {HTMLElement} rowItems
     * @param {number} x
     * @param {boolean} isRtl
     * @private
     */
    _writeScroll(rowItems, x, isRtl) {
        rowItems.scrollLeft = isRtl ? -x : x;
    }

    /**
     * Computes expanded card width for modern expanding card rows.
     * @param {Object} row
     * @returns {number|null}
     * @private
     */
    _expandedWidth(row) {
        try {
            const layout = document.documentElement.getAttribute('data-layout-media-rows');
            if (
                layout === 'expanding' &&
                row.isLandscape === false &&
                row.cardType !== 'square' &&
                row.cardType !== 'artist' &&
                row.cardType !== 'person'
            ) {
                return Math.round(600 * (row.modernMultiplier || 1.0));
            }
        } catch (err) {
            // Layout query fallback
        }
        return null;
    }

    /**
     * Resolves matching row-items element for touch event target,
     * skipping hero carousels, sidebar navigation, and open modal overlays.
     * @param {EventTarget} target
     * @returns {HTMLElement|null}
     * @private
     */
    _resolveTrack(target) {
        if (!target || !target.closest) {
            return null;
        }
        const el = /** @type {Element} */ (target);
        if (el.closest('#hero-carousel-container') || el.closest('aside') || el.closest('.modal-overlay')) {
            return null;
        }
        const rowItems = el.closest('.row-items');
        if (!rowItems) {
            return null;
        }
        return /** @type {HTMLElement} */ (rowItems);
    }
}

// Export singleton instance and class definition
export const touchHorizontalScroller = new TouchHorizontalScroller();
export default touchHorizontalScroller;
