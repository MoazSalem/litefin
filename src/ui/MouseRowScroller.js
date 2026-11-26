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
import { eventBus } from '../core/EventBus.js';
import { storage } from '../utils/StorageService.js';
import { logger } from '../utils/Logger.js';
import { getHorizontalDurationMs } from './SpringPhysics.js';
import { touchHorizontalScroller } from '../android/TouchHorizontalScroller.js';

const log = logger.create('MouseRowScroller');

// ============================================================================
// Timing & Threshold Constants
// ============================================================================

/** Ignore sub-pixel trackpad jitter below this horizontal delta (px) */
const MIN_DELTA_PX = 2;

/** Idle time after the last wheel event before the row settles (ms) */
const SETTLE_IDLE_MS = 200;

/** Cap for distance-scaled programmatic scroll animations (ms) */
const MAX_ANIM_MS = 700;

/** Minimum pointer displacement in px required to register a drag */
const DRAG_SLOP_PX = 8;

/** Stationary press duration in ms required to trigger a card hold/long-press */
const HOLD_DURATION_MS = 500;

/** Window after drag or hold release during which synthetic clicks are blocked (ms) */
const CLICK_SUPPRESS_MS = 400;

/** Minimum mouse release velocity (px/ms) to trigger a momentum glide */
const FLING_MIN_VELOCITY = 0.18;

/** Velocity projection horizon (ms) for mouse-drag release momentum */
const FLING_PROJECTION_MS = 180;

/** Grace period after touch pointerup before checking native fling halt (ms) */
const TOUCH_SETTLE_MIN_WAIT_MS = 220;

/** Consecutive stationary frames needed to confirm native touch fling ended */
const TOUCH_SETTLE_STILL_FRAMES = 3;

/** Maximum wait before forcing card-center settle after touch fling (ms) */
const TOUCH_SETTLE_MAX_WAIT_MS = 2500;

/** Sub-pixel threshold treated as stationary between touch fling frames */
const TOUCH_SETTLE_STILL_PX = 0.5;

/**
 * ============================================================================
 * MouseRowScroller Class
 * ============================================================================
 */
export class MouseRowScroller {
    constructor() {
        // Lifecycle flag
        this._initialized = false;

        // Bound event listeners for teardown
        this._wheelListener = null;
        this._pointerDownListener = null;
        this._pointerMoveListener = null;
        this._pointerUpListener = null;
        this._clickCaptureListener = null;
        this._dragStartListener = null;
        this._contextMenuListener = null;
        this._scrollListener = null;

        // Per-row settle debounce timers
        this._settleTimers = new Map();

        // Per-row programmatic (arrow/button) animation frame references
        this._animFrames = new Map();

        // Active touch fling observer state
        this._flingWatcher = null;
        this._scrollIdleTimer = null;

        // Active pointer gesture state (distinguishes drag vs hold vs click)
        this._activePointerId = null;
        this._activeRowItems = null;
        this._pointerType = null;
        this._downX = 0;
        this._downY = 0;
        this._lastDragX = 0;
        this._lastDragTime = 0;
        this._velocityX = 0;
        this._startScrollX = 0;
        this._moved = false;
        this._held = false;
        this._dragAxis = null;
        this._holdCard = null;
        this._holdTimer = null;
        this._blockClickUntil = 0;
        this._blockContextMenuUntil = 0;
    }

    /**
     * Initializes mouse/trackpad, mouse-drag, and touch row scrolling on web
     * and desktop platforms. Safe to call from both adapters — self-guards on
     * duplicate init and unsupported platforms.
     */
    init() {
        if (this._initialized || !(platformInfo.isWeb || platformInfo.isDesktop)) {
            return;
        }
        this._initialized = true;

        log.info('Initializing MouseRowScroller for web/desktop pointer & touch input...');

        // Capture phase so row scrolling wins over the page before native
        // horizontal scroll handling fires; non-passive because we may
        // preventDefault to stop the page from reacting to the gesture.
        this._wheelListener = (e) => this._handleWheel(e);
        document.addEventListener('wheel', this._wheelListener, { capture: true, passive: false });

        // Install pointer drag, touch scroll sync, and hold/click discrimination
        this._installPointerListeners();
    }

    /**
     * Performs complete cleanup of listeners and pending settle timers.
     */
    destroy() {
        if (this._wheelListener) {
            document.removeEventListener('wheel', this._wheelListener, { capture: true });
            this._wheelListener = null;
        }
        this._removePointerListeners();
        this._settleTimers.forEach((timer) => clearTimeout(timer));
        this._settleTimers.clear();
        this._animFrames.forEach((raf) => cancelAnimationFrame(raf));
        this._animFrames.clear();
        this._cancelFlingWatcher();
        clearTimeout(this._scrollIdleTimer);
        this._initialized = false;
        log.info('MouseRowScroller destroyed');
    }

    /**
     * ========================================================================
     * Programmatic Smooth Scroll API
     * ========================================================================
     */

    /**
     * Smoothly scrolls a media row to an absolute target offset (px, video
     * space) with easeOutQuad timing. Shared by the row scroll-arrow buttons
     * so every pointer-driven row writer (wheel, arrows) uses one animation
     * path that honors the horizontal scroll position exclusively — no
     * transform/scrollLeft stacking.
     *
     * Duration follows the same pref:scrollSmoothingDuration budget as all
     * other horizontal scrolls, distance-scaled and capped for long hops.
     *
     * @param {HTMLElement} rowItems - Media row container (`.row-items`)
     * @param {number} targetX - Absolute target offset in video space (px)
     */
    scrollRowTo(rowItems, targetX) {
        const track = rowItems.querySelector(':scope > .row-items-track');
        const row = track && track.__virtualRow;
        const isRtl = document.documentElement.dir === 'rtl';

        // Cancel any pending wheel settle and in-flight animation on this row
        clearTimeout(this._settleTimers.get(rowItems));
        this._settleTimers.delete(rowItems);
        this._cancelAnim(rowItems);
        touchHorizontalScroller.cancelRowSettle(rowItems);

        const maxScroll = Math.max(
            0,
            (row ? row.getTrackWidth() : track ? track.scrollWidth : 0) - rowItems.clientWidth
        );
        const to = Math.max(0, Math.min(targetX, maxScroll));

        // Normalize current position to video space (RTL reports negatives)
        const raw = rowItems.scrollLeft || 0;
        const from = isRtl ? -raw : raw;

        // Instant preference ('scrollSmoothingDuration: instant') snaps directly
        const pref = storage.getItem('pref:scrollSmoothingDuration') || 'smooth';
        const base = getHorizontalDurationMs(pref, platformInfo.isDesktop || platformInfo.isWeb);
        const distance = Math.abs(to - from);

        if (distance < 1 || base <= 0) {
            this._writeRowX(rowItems, row, to, isRtl);
            if (row) {
                row.endTouchScroll(to);
            }
            eventBus.emit('scroll:finished');
            return;
        }

        const duration = Math.min(MAX_ANIM_MS, Math.max(base, Math.round(distance * 0.4)));
        const startTime = performance.now();

        const tick = (now) => {
            const progress = Math.min(1, (now - startTime) / duration);
            // easeOutQuad — the same classic curve the touch settle uses
            const eased = 1 - (1 - progress) * (1 - progress);
            const x = from + (to - from) * eased;
            this._writeRowX(rowItems, row, x, isRtl);
            if (row) {
                row.syncScrollToPosition(x);
            }

            if (progress < 1) {
                this._animFrames.set(rowItems, requestAnimationFrame(tick));
            } else {
                this._animFrames.delete(rowItems);
                if (row) {
                    row.endTouchScroll(to);
                }
                eventBus.emit('scroll:finished');
            }
        };

        this._animFrames.set(rowItems, requestAnimationFrame(tick));
    }

    /**
     * Cancels a running programmatic scroll animation on a row.
     * @param {HTMLElement} rowItems - Media row container
     * @private
     */
    _cancelAnim(rowItems) {
        const raf = this._animFrames.get(rowItems);
        if (raf) {
            cancelAnimationFrame(raf);
            this._animFrames.delete(rowItems);
        }
    }

    /**
     * Shared position writer: drives the native scrollLeft AND keeps
     * VirtualCardRow's virtual window synchronized.
     * @param {HTMLElement} rowItems
     * @param {Object|null} row - VirtualCardRow instance (or null)
     * @param {number} x - Target offset in video space (px)
     * @param {boolean} isRtl
     * @private
     */
    _writeRowX(rowItems, row, x, isRtl) {
        rowItems.scrollLeft = isRtl ? -x : x;
        if (row) {
            row.syncScrollToPosition(x);
        }
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

        // Cancel any in-flight programmatic or touch settle on this row
        touchHorizontalScroller.cancelRowSettle(rowItems);
        this._cancelAnim(rowItems);

        const maxScroll = Math.max(
            0,
            (row ? row.getTrackWidth() : track ? track.scrollWidth : 0) - rowItems.clientWidth
        );

        // Normalize scroll position to video space (RTL Chromium reports negatives)
        const raw = rowItems.scrollLeft || 0;
        const current = isRtl ? -raw : raw;
        const target = Math.max(0, Math.min(current + dx, maxScroll));

        this._writeRowX(rowItems, row, target, isRtl);
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
     * ========================================================================
     * Pointer Drag, Touch Sync & Card Hold/Click Discrimination
     * ========================================================================
     */

    /**
     * Installs document-level pointer, scroll, dragstart, and click-capture
     * listeners so mouse drag, touch pan, card hold, and card click coexist
     * cleanly without triggering unintended navigation.
     * @private
     */
    _installPointerListeners() {
        // Capture-phase pointerdown: begin tracking a potential click, hold, or drag
        this._pointerDownListener = (e) => {
            if (e.pointerType !== 'mouse' && e.pointerType !== 'touch' && e.pointerType !== 'pen') {
                return;
            }
            // Only primary mouse button initiates row drag or card hold
            if (e.pointerType === 'mouse' && e.button !== 0) {
                return;
            }
            const targetEl = e.target instanceof Element ? e.target : null;
            if (!targetEl || targetEl.closest('.row-scroll-arrows')) {
                return;
            }
            const rowItems = this._resolveRowItems(targetEl);
            if (!rowItems) {
                return;
            }

            // Halt any active settle, fling watcher, or arrow animation on contact
            this._cancelFlingWatcher();
            clearTimeout(this._settleTimers.get(rowItems));
            this._settleTimers.delete(rowItems);
            this._cancelAnim(rowItems);
            touchHorizontalScroller.cancelRowSettle(rowItems);
            this._clearHoldTimer();

            // Snapshot gesture origin and target card for hold/drag discrimination
            this._activePointerId = e.pointerId;
            this._activeRowItems = rowItems;
            this._pointerType = e.pointerType;
            this._downX = e.clientX;
            this._downY = e.clientY;
            this._lastDragX = e.clientX;
            this._lastDragTime = performance.now();
            this._velocityX = 0;
            this._startScrollX = this._readRowX(rowItems);
            this._moved = false;
            this._held = false;
            this._dragAxis = null;
            this._holdCard = targetEl.closest('.media-card');

            // Start long-press timer when pressing down on a media card
            if (this._holdCard) {
                this._holdTimer = setTimeout(() => {
                    this._triggerHold();
                }, HOLD_DURATION_MS);
            }
        };
        document.addEventListener('pointerdown', this._pointerDownListener, { capture: true });

        // Capture-phase pointermove: classify axis, cancel pending hold, or drive mouse drag
        this._pointerMoveListener = (e) => {
            if (e.pointerId !== this._activePointerId || !this._activeRowItems) {
                return;
            }
            // Once a hold has fired, ignore subsequent jitter for this gesture
            if (this._held) {
                return;
            }

            const dx = Math.abs(e.clientX - this._downX);
            const dy = Math.abs(e.clientY - this._downY);

            // Any movement past slop cancels the pending hold timer immediately
            if (dx > DRAG_SLOP_PX || dy > DRAG_SLOP_PX) {
                this._clearHoldTimer();
            }

            // Lock gesture axis once pointer clears slop threshold
            if (!this._dragAxis) {
                if (dx > DRAG_SLOP_PX && dx >= dy) {
                    this._dragAxis = 'x';
                    this._moved = true;
                    if (this._pointerType === 'mouse') {
                        this._activeRowItems.classList.add('is-dragging');
                    }
                } else if (dy > DRAG_SLOP_PX && dy > dx) {
                    // Vertical movement belongs to page scroll; release row tracking
                    this._dragAxis = 'y';
                    this._resetPointerState();
                    return;
                }
            }

            // Drive horizontal scroll 1:1 for mouse drags (touch uses native compositor)
            if (this._dragAxis === 'x' && this._pointerType === 'mouse') {
                const rowItems = this._activeRowItems;
                const track = rowItems.querySelector(':scope > .row-items-track');
                const row = track && track.__virtualRow;
                const isRtl = document.documentElement.dir === 'rtl';
                const maxScroll = Math.max(
                    0,
                    (row ? row.getTrackWidth() : track ? track.scrollWidth : 0) - rowItems.clientWidth
                );

                // Translate pointer displacement into video-space scroll offset
                const deltaFromStart = isRtl ? e.clientX - this._downX : this._downX - e.clientX;
                const targetX = Math.max(0, Math.min(this._startScrollX + deltaFromStart, maxScroll));
                this._writeRowX(rowItems, row, targetX, isRtl);

                // Track smoothed release velocity (px/ms in video space) for flick glide
                const now = performance.now();
                const dt = now - this._lastDragTime;
                if (dt > 0) {
                    const stepDx = isRtl ? e.clientX - this._lastDragX : this._lastDragX - e.clientX;
                    const instantV = stepDx / dt;
                    this._velocityX = this._velocityX * 0.4 + instantV * 0.6;
                    this._lastDragX = e.clientX;
                    this._lastDragTime = now;
                }
            }
        };
        document.addEventListener('pointermove', this._pointerMoveListener, { capture: true });

        // Capture-phase pointerup / pointercancel: finalize drag, hold, or click
        this._pointerUpListener = (e) => {
            if (e.pointerId !== this._activePointerId) {
                return;
            }
            const rowItems = this._activeRowItems;
            const wasMoved = this._moved;
            const wasHeld = this._held;
            const pointerType = this._pointerType;
            const vx = this._velocityX;

            if (rowItems) {
                rowItems.classList.remove('is-dragging');
            }
            this._resetPointerState();

            if (wasHeld) {
                // Block synthetic click/contextmenu fired on release after a hold
                this._blockClickUntil = Date.now() + CLICK_SUPPRESS_MS;
                this._blockContextMenuUntil = Date.now() + CLICK_SUPPRESS_MS;
                return;
            }

            if (wasMoved && rowItems) {
                // Suppress accidental card navigation immediately following a drag
                this._blockClickUntil = Date.now() + CLICK_SUPPRESS_MS;

                if (pointerType === 'mouse') {
                    this._settleAfterMouseDrag(rowItems, vx);
                } else {
                    // Touch/pen uses native compositor fling; wait for inertia to settle
                    this._scheduleTouchSettle(rowItems);
                }
            }
        };
        document.addEventListener('pointerup', this._pointerUpListener, { capture: true });
        document.addEventListener('pointercancel', this._pointerUpListener, { capture: true });

        // Suppress synthetic card clicks immediately following a drag or hold
        this._clickCaptureListener = (e) => {
            if (Date.now() < this._blockClickUntil && this._resolveRowItems(e.target)) {
                e.stopPropagation();
                e.preventDefault();
            }
        };
        document.addEventListener('click', this._clickCaptureListener, { capture: true });

        // Prevent native HTML5 ghost-image dragging on media cards during mouse drag
        this._dragStartListener = (e) => {
            if (this._resolveRowItems(e.target)) {
                e.preventDefault();
            }
        };
        document.addEventListener('dragstart', this._dragStartListener, { capture: true });

        // Suppress browser native touch context menu when our custom hold gesture fired
        this._contextMenuListener = (e) => {
            if (Date.now() < this._blockContextMenuUntil && this._resolveRowItems(e.target)) {
                e.preventDefault();
            }
        };
        document.addEventListener('contextmenu', this._contextMenuListener, { capture: true });

        // Keep VirtualCardRow window synced during native touch/trackpad scroll
        this._scrollListener = (e) => {
            const target = e.target;
            if (!(target instanceof Element)) {
                return;
            }
            const rowItems = target.closest('.row-items');
            if (!rowItems) {
                return;
            }
            const track = rowItems.querySelector(':scope > .row-items-track');
            const row = track && track.__virtualRow;
            if (row) {
                row.syncScrollToPosition(this._readRowX(rowItems));
            }

            // Emit debounced scroll:finished so lazy-loaded card artwork resumes
            clearTimeout(this._scrollIdleTimer);
            this._scrollIdleTimer = setTimeout(() => {
                eventBus.emit('scroll:finished');
            }, 250);
        };
        document.addEventListener('scroll', this._scrollListener, { capture: true, passive: true });
    }

    /**
     * Tears down all pointer, drag, click-capture, and scroll listeners.
     * @private
     */
    _removePointerListeners() {
        this._clearHoldTimer();
        if (this._activeRowItems) {
            this._activeRowItems.classList.remove('is-dragging');
        }
        this._resetPointerState();

        if (this._pointerDownListener) {
            document.removeEventListener('pointerdown', this._pointerDownListener, { capture: true });
            this._pointerDownListener = null;
        }
        if (this._pointerMoveListener) {
            document.removeEventListener('pointermove', this._pointerMoveListener, { capture: true });
            this._pointerMoveListener = null;
        }
        if (this._pointerUpListener) {
            document.removeEventListener('pointerup', this._pointerUpListener, { capture: true });
            document.removeEventListener('pointercancel', this._pointerUpListener, { capture: true });
            this._pointerUpListener = null;
        }
        if (this._clickCaptureListener) {
            document.removeEventListener('click', this._clickCaptureListener, { capture: true });
            this._clickCaptureListener = null;
        }
        if (this._dragStartListener) {
            document.removeEventListener('dragstart', this._dragStartListener, { capture: true });
            this._dragStartListener = null;
        }
        if (this._contextMenuListener) {
            document.removeEventListener('contextmenu', this._contextMenuListener, { capture: true });
            this._contextMenuListener = null;
        }
        if (this._scrollListener) {
            document.removeEventListener('scroll', this._scrollListener, { capture: true });
            this._scrollListener = null;
        }
    }

    /**
     * Fires the `card:longpress` event when a pointer stays stationary on a
     * media card for HOLD_DURATION_MS, preparing the card for a context menu.
     * @private
     */
    _triggerHold() {
        this._holdTimer = null;
        const card = this._holdCard;
        if (!card || this._moved) {
            return;
        }

        // Mark gesture as held so subsequent release suppresses click & native contextmenu
        this._held = true;
        this._blockClickUntil = Date.now() + CLICK_SUPPRESS_MS;
        this._blockContextMenuUntil = Date.now() + CLICK_SUPPRESS_MS;

        // Dispatch bubbling CustomEvent for future context menu handlers
        const event = new CustomEvent('card:longpress', {
            bubbles: true,
            cancelable: true,
            detail: {
                card,
                itemId: card.dataset?.itemId || null,
                pointerType: this._pointerType,
                clientX: this._downX,
                clientY: this._downY
            }
        });
        card.dispatchEvent(event);
    }

    /**
     * Clears any pending long-press hold timer.
     * @private
     */
    _clearHoldTimer() {
        if (this._holdTimer) {
            clearTimeout(this._holdTimer);
            this._holdTimer = null;
        }
    }

    /**
     * Resets transient pointer tracking fields between gestures.
     * @private
     */
    _resetPointerState() {
        this._clearHoldTimer();
        this._activePointerId = null;
        this._activeRowItems = null;
        this._pointerType = null;
        this._holdCard = null;
        this._moved = false;
        this._held = false;
        this._dragAxis = null;
        this._velocityX = 0;
    }

    /**
     * Reads the current horizontal scroll offset in video space (positive LTR/RTL).
     * @param {HTMLElement} rowItems
     * @returns {number}
     * @private
     */
    _readRowX(rowItems) {
        const raw = rowItems.scrollLeft || 0;
        const isRtl = document.documentElement.dir === 'rtl';
        return isRtl ? -raw : raw;
    }

    /**
     * Settles a row after mouse-drag release, projecting a momentum glide
     * when released with velocity or snapping to the nearest card center.
     * @param {HTMLElement} rowItems
     * @param {number} velocityX - Release velocity in px/ms (video space)
     * @private
     */
    _settleAfterMouseDrag(rowItems, velocityX) {
        if (Math.abs(velocityX) > FLING_MIN_VELOCITY) {
            const track = rowItems.querySelector(':scope > .row-items-track');
            const row = track && track.__virtualRow;
            const containerWidth = rowItems.clientWidth;
            const currentX = this._readRowX(rowItems);
            const maxScroll = Math.max(
                0,
                (row ? row.getTrackWidth() : track ? track.scrollWidth : 0) - containerWidth
            );
            const projectedX = Math.max(0, Math.min(currentX + velocityX * FLING_PROJECTION_MS, maxScroll));

            // Snap projected position to nearest card center when virtualized
            if (row && row.totalItems > 0) {
                const centerPos = projectedX + containerWidth / 2;
                const centerIndex = Math.max(
                    0,
                    Math.min(
                        row.totalItems - 1,
                        Math.round((centerPos - row.sidePadding - row.itemWidth / 2) / row.totalItemWidth)
                    )
                );
                const target = Math.max(
                    0,
                    Math.min(row.getItemPosition(centerIndex) - containerWidth / 2 + row.itemWidth / 2, maxScroll)
                );
                this.scrollRowTo(rowItems, target);
                return;
            }
            this.scrollRowTo(rowItems, projectedX);
            return;
        }

        touchHorizontalScroller.settleToCardCenter(rowItems);
    }

    /**
     * Polls native touch fling inertia on web/desktop until stationary, then
     * glides the row to align with the nearest card center.
     * @param {HTMLElement} rowItems
     * @private
     */
    _scheduleTouchSettle(rowItems) {
        this._cancelFlingWatcher();
        const startTime = performance.now();
        let lastScroll = rowItems.scrollLeft || 0;
        let stillFrames = 0;

        const poll = () => {
            this._flingWatcher = null;
            if (this._activePointerId !== null) {
                return;
            }

            const currentScroll = rowItems.scrollLeft || 0;
            if (Math.abs(currentScroll - lastScroll) < TOUCH_SETTLE_STILL_PX) {
                stillFrames++;
            } else {
                stillFrames = 0;
                lastScroll = currentScroll;
            }

            const elapsed = performance.now() - startTime;
            if (
                (stillFrames >= TOUCH_SETTLE_STILL_FRAMES && elapsed >= TOUCH_SETTLE_MIN_WAIT_MS) ||
                elapsed >= TOUCH_SETTLE_MAX_WAIT_MS
            ) {
                touchHorizontalScroller.settleToCardCenter(rowItems);
                return;
            }

            this._flingWatcher = requestAnimationFrame(poll);
        };

        this._flingWatcher = requestAnimationFrame(poll);
    }

    /**
     * Cancels any active touch fling watcher frame.
     * @private
     */
    _cancelFlingWatcher() {
        if (this._flingWatcher) {
            cancelAnimationFrame(this._flingWatcher);
            this._flingWatcher = null;
        }
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
