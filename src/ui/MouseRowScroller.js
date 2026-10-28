/**
 * ============================================================================
 * Litefin — Mouse Row Scroller (Web & Desktop)
 * ============================================================================
 * Horizontal media-row scrolling for mouse wheels and trackpads on the Web
 * and Tauri Desktop platforms.
 *
 * Rows are native overflow containers (`.row-items`) driven by the same
 * virtualized window as Android's TouchHorizontalScroller. On touch devices
 * the browser compositor handles horizontal pan natively, but on mouse-driven
 * platforms the only horizontal gesture source is the wheel / trackpad:
 *   - Trackpad two-finger horizontal swipe  → `wheel` with dominant `deltaX`
 *   - Tilt wheels / shift+wheel             → same normalized horizontal delta
 *
 * Vertical wheel is deliberately NOT consumed: the page keeps its native
 * vertical scroll and FocusManager's optional hover-wheel navigation stays
 * unaffected.
 *
 * After scrolling stops, the row glides to the nearest card center using the
 * shared settle physics from TouchHorizontalScroller, so D-pad focus can
 * resume from a precise card afterwards.
 * ============================================================================
 */

import { platformInfo } from '../utils/PlatformInfo.js';
import { logger } from '../utils/Logger.js';
import { touchHorizontalScroller } from '../android/TouchHorizontalScroller.js';

const log = logger.create('MouseRowScroller');

// ============================================================================
// Timing & Threshold Constants
// ============================================================================

/** Ignore sub-pixel trackpad jitter below this horizontal delta (px) */
const MIN_DELTA_PX = 2;

/** Idle time after the last wheel event before the row settles (ms) */
const SETTLE_IDLE_MS = 200;

/**
 * ============================================================================
 * MouseRowScroller Class
 * ============================================================================
 */
export class MouseRowScroller {
    constructor() {
        // Lifecycle flag
        this._initialized = false;

        // Bound wheel listener for teardown
        this._wheelListener = null;

        // Per-row settle debounce timers
        this._settleTimers = new Map();
    }

    /**
     * Initializes mouse/trackpad row scrolling on web and desktop platforms.
     * Safe to call from both adapters — it self-guards on duplicate init and
     * unsupported platforms (touch-only devices keep native pan behavior).
     */
    init() {
        if (this._initialized || !(platformInfo.isWeb || platformInfo.isDesktop)) {
            return;
        }
        this._initialized = true;

        log.info('Initializing MouseRowScroller for web/desktop pointer input...');

        // Capture phase so row scrolling wins over the page before native
        // horizontal scroll handling fires; non-passive because we may
        // preventDefault to stop the page from reacting to the gesture.
        this._wheelListener = (e) => this._handleWheel(e);
        document.addEventListener('wheel', this._wheelListener, { capture: true, passive: false });
    }

    /**
     * Performs complete cleanup of listeners and pending settle timers.
     */
    destroy() {
        if (this._wheelListener) {
            document.removeEventListener('wheel', this._wheelListener, { capture: true });
            this._wheelListener = null;
        }
        this._settleTimers.forEach((timer) => clearTimeout(timer));
        this._settleTimers.clear();
        this._initialized = false;
        log.info('MouseRowScroller destroyed');
    }

    /**
     * ========================================================================
     * Wheel Handling
     * ========================================================================
     */

    /**
     * Routes horizontal wheel gestures over media rows into row scrolling.
     * @param {WheelEvent} e
     * @private
     */
    _handleWheel(e) {
        // Horizontal gestures only: vertical wheel keeps native page scrolling
        // (and FocusManager's optional hover-wheel focus navigation).
        // Skip ambiguous/tiny horizontal deltas (trackpad palm noise).
        if (!e.deltaX || Math.abs(e.deltaY) >= Math.abs(e.deltaX)) {
            return;
        }

        // Never intercept while the player, OSD, or sidebar owns the UI
        if (document.body.classList.contains('player-active')) {
            return;
        }
        if (document.querySelector('.sidebar.expanded') || document.querySelector('.sidebar:hover')) {
            return;
        }

        const rowItems = this._resolveRowItems(e.target);
        if (!rowItems) {
            return;
        }

        // Normalize to pixels (line/page modes come from niche mice and TV remotes)
        let dx = e.deltaX;
        const dm = e.deltaMode || 0;
        if (dm === 1) dx *= 20;
        else if (dm === 2) dx *= window.innerWidth;

        if (Math.abs(dx) < MIN_DELTA_PX) {
            return;
        }

        // We own this gesture — stop the page from horizontally scrolling
        // ancestors or triggering browser back/forward swipe navigation.
        e.preventDefault();

        this._scrollRowBy(rowItems, dx);
        this._scheduleSettle(rowItems);
    }

    /**
     * Scrolls a media row horizontally by the given delta and keeps the
     * virtualized card window synchronized.
     * @param {HTMLElement} rowItems - Media row container
     * @param {number} dx - Horizontal delta in px (positive = content leftwards)
     * @private
     */
    _scrollRowBy(rowItems, dx) {
        const track = rowItems.querySelector(':scope > .row-items-track');
        const row = track && track.__virtualRow;
        const isRtl = document.documentElement.dir === 'rtl';

        // Cancel any in-flight touch/wheel settle so both writers don't fight
        touchHorizontalScroller.cancelRowSettle(rowItems);

        const maxScroll = Math.max(
            0,
            (row ? row.getTrackWidth() : track ? track.scrollWidth : 0) - rowItems.clientWidth
        );

        // Normalize scrollLeft to video space (RTL Chromium reports negatives)
        const raw = rowItems.scrollLeft || 0;
        const current = isRtl ? -raw : raw;
        const target = Math.max(0, Math.min(current + dx, maxScroll));

        rowItems.scrollLeft = isRtl ? -target : target;
        if (row) {
            row.syncScrollToPosition(target);
        }
    }

    /**
     * Debounced settle: once the wheel stops, glide the row to the nearest
     * card center using the shared touch-settle physics.
     * @param {HTMLElement} rowItems - Media row container
     * @private
     */
    _scheduleSettle(rowItems) {
        clearTimeout(this._settleTimers.get(rowItems));
        this._settleTimers.set(
            rowItems,
            setTimeout(() => {
                this._settleTimers.delete(rowItems);
                touchHorizontalScroller.settleToCardCenter(rowItems);
            }, SETTLE_IDLE_MS)
        );
    }

    /**
     * Resolves the `.row-items` container for a wheel event target,
     * excluding hero carousel, sidebars, and modal overlays.
     * @param {EventTarget} target
     * @returns {HTMLElement|null}
     * @private
     */
    _resolveRowItems(target) {
        if (!target || !target.closest) {
            return null;
        }
        const el = /** @type {Element} */ (target);
        if (el.closest('#hero-carousel-container') || el.closest('aside') || el.closest('.modal-overlay')) {
            return null;
        }
        const rowItems = el.closest('.row-items');
        return /** @type {HTMLElement} */ (rowItems || null);
    }
}

// Export singleton instance and class definition
export const mouseRowScroller = new MouseRowScroller();
export default mouseRowScroller;
