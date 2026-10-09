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
 *   1. settleToCardCenter()  — After compositor fling inertia completes, eases
 *      the row smoothly to align with the nearest card center according to
 *      ScrollController's geometric specs, allowing TV D-pad navigation to resume
 *      instantly from that precise card.
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
        this._stylesInjected = false;

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

        // Inject high-performance native scrolling CSS styles
        this._injectStyles();

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
     * ========================================================================
     * Native Horizontal Scroller Styles Injection
     * ========================================================================
     * Transforms .row-items into GPU-accelerated horizontal scrollers.
     * @private
     */
    _injectStyles() {
        if (this._stylesInjected) {
            return;
        }
        this._stylesInjected = true;

        const style = document.createElement('style');
        style.id = 'litefin-native-hscroll';
        style.textContent = `
/* -------------------------------------------------------------------------
   Android Native Touch Horizontal Scrolling
   Enables native overflow-x inertia managed directly by the WebView compositor
   ------------------------------------------------------------------------- */
[data-platform="android"] .row-items {
    overflow-x: auto !important;
    overflow-y: hidden !important;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior-x: contain;
    scrollbar-width: none;
    -ms-overflow-style: none;
    /* Permits horizontal row swipes while passing vertical drags to page scroll */
    touch-action: pan-x pan-y;
}
[data-platform="android"] .row-items::-webkit-scrollbar {
    display: none;
}
/* Ensure row track does not prematurely GPU-clip inner cards */
[data-platform="android"] .row-items-track {
    will-change: auto;
}`;
        document.head.appendChild(style);
        log.debug('Native horizontal row scrolling stylesheet injected');
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
     * Executes easeOutQuad animation to glide smoothly onto card center geometry.
     * @private
     */
    _animateSettle(rowItems, row, from, to, isRtl) {
        this._cancelSettle(rowItems);
        const duration = Math.min(MAX_SETTLE_MS, Math.max(120, Math.abs(to - from) * 0.5));
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

            this._writeScroll(rowItems, value, isRtl);
            if (row) {
                row.syncScrollToPosition(value);
            }

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
