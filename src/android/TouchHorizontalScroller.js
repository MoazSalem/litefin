/**
 * ============================================================================
 * Litefin Android - Native Touch Horizontal Row Scroller
 * ============================================================================
 * On Android (touch phones/tablets), horizontal media rows scroll NATIVELY:
 *   - `.row-items` becomes `overflow-x: auto` (see _injectStyles) so the
 *     browser's compositor owns the drag tracking and fling inertia — exactly
 *     the same physics as the vertical page scroll. JS never moves a pixel
 *     during a drag, so the row cannot lag the finger and release velocity
 *     is never capped.
 *
 * What JS still owns here:
 *   1. settleToCardCenter()  — after the browser fling ends, ease the row the
 *      remaining distance onto the exact ScrollController card-center geometry
 *      so D-pad focus resumes seamlessly from the card the user stopped on.
 *   2. Click suppression     — a drag must not activate the card under the
 *      finger when it lifts.
 *   3. Virtual-window sync   — VirtualCardRow renders a sliding window of
 *      cards; keep it covering the viewport as scrollLeft changes.
 *   4. Scrollbar hiding + overscroll glow suppression (cosmetic).
 *
 * This mirrors the architecture of the official Jellyfin clients, which let
 * the native scroller handle touch physics and only animate programmatic
 * scrolls (focus moves) on top of it.
 * ============================================================================
 */

import { platformInfo } from '../utils/PlatformInfo.js';
import { eventBus } from '../core/EventBus.js';
import { logger } from '../utils/Logger.js';

const log = logger.create('TouchHorizontalScroller');

// ============================================================================
// Tunables
// ============================================================================

/** Max ms the settle animation may run before snapping to target. */
const MAX_SETTLE_MS = 600;
/** Radius (px) around the current card center that counts as "already settled". */
const SETTLE_TOLERANCE_PX = 12;
/** Movement (px) beyond which a touch counts as a drag (not a tap). */
const DRAG_SLOP_PX = 8;
/** Minimum ms after pointerup before a settle may begin. */
const SETTLE_MIN_WAIT_MS = 300;
/** Consecutive still frames required before the fling counts as ended. */
const SETTLE_STILL_FRAMES = 3;
/** Hard cap: settle regardless if the fling watcher runs this long (ms). */
const SETTLE_MAX_WAIT_MS = 2500;
/** Scroll delta (px) below which the fling counts as momentarily still. */
const SETTLE_STILL_PX = 0.5;
/** Window after a drag during which card clicks are suppressed (ms). */
const CLICK_SUPPRESS_MS = 400;

/**
 * ============================================================================
 * TouchHorizontalScroller
 * ============================================================================
 */
export class TouchHorizontalScroller {
    constructor() {
        this._initialized = false;
        this._stylesInjected = false;
        /** @type {Array<Function>} */
        this._unsubscribers = [];
        /** @type {Map<HTMLElement, {raf: number}>} per-row settle animation */
        this._settleAnims = new Map();
        /** @type {HTMLElement|null} row most recently touch-scrolled */
        this._lastTouchedRow = null;
        /** @type {{raf: number, rowItems: HTMLElement}|null} pending post-fling settle watcher */
        this._flingWatcher = null;

        // Drag detection (pointerdown → pointermove), document-level capture.
        this._activePointerId = null;
        this._downX = 0;
        this._downY = 0;
        this._moved = false;
        this._blockClickUntil = 0;

        /** @type {Function|null} */
        this._grabListener = null;
        this._clickCaptureListener = null;
        this._keyListener = null;
    }

    /**
     * Initialize. Called from AndroidAdapter.init() (Android only).
     * @returns {void}
     */
    init() {
        if (this._initialized || !platformInfo.isAndroid) return;
        this._initialized = true;

        this._injectStyles();
        this._installListeners();

        // D-pad can take over mid-settle: finish instantly at the current
        // settle target so focus never fights a running animation. (Capture
        // keydown works for both the hardware keyboard and the WebView input
        // bridge, regardless of which eventBus key events they produce.)
        this._keyListener = (e) => {
            const KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', ' '];
            if (KEYS.indexOf(e.key) !== -1) this._handleDpad();
        };
        document.addEventListener('keydown', this._keyListener, { capture: true });
    }

    /**
     * Tear down all listeners/animations.
     * @returns {void}
     */
    destroy() {
        this._unsubscribers.forEach((fn) => {
            try {
                fn();
            } catch (err) {
                log.warn('unsubscriber failed:', err);
            }
        });
        this._unsubscribers = [];

        this._settleAnims.forEach((state) => cancelAnimationFrame(state.raf));
        this._settleAnims.clear();
        this._cancelFlingWatcher();

        if (this._grabListener) {
            document.removeEventListener('pointerdown', this._grabListener, { capture: true });
            this._grabListener = null;
        }
        if (this._clickCaptureListener) {
            document.removeEventListener('click', this._clickCaptureListener, { capture: true });
            this._clickCaptureListener = null;
        }
        if (this._keyListener) {
            document.removeEventListener('keydown', this._keyListener, { capture: true });
            this._keyListener = null;
        }
        clearTimeout(this._scrollIdleTimer);
        this._initialized = false;
    }

    // ========================================================================
    // Styles: convert .row-items into a native horizontal scroller
    // ========================================================================

    _injectStyles() {
        if (this._stylesInjected) return;
        this._stylesInjected = true;

        const style = document.createElement('style');
        style.id = 'litefin-native-hscroll';
        style.textContent = `
/* Android: rows become real horizontal scrollers — the browser compositor
   owns drag + fling inertia, identical to vertical page scrolling. */
[data-platform="android"] .row-items {
    overflow-x: auto !important;
    overflow-y: hidden !important;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior-x: contain;
    scrollbar-width: none;
    -ms-overflow-style: none;
    /* Allow BOTH axes: horizontal pans scroll THIS row natively (browser
       inertia), vertical pans bubble to .page-content. pan-y alone would
       disable native horizontal scrolling entirely. */
    touch-action: pan-x pan-y;
}
[data-platform="android"] .row-items::-webkit-scrollbar {
    display: none;
}
/* The track must not GPU-clip inside the scroller. */
[data-platform="android"] .row-items-track {
    will-change: auto;
}`;
        document.head.appendChild(style);
        log.debug('Native horizontal row scrolling styles injected');
    }

    // ========================================================================
    // Listeners
    // ========================================================================

    _installListeners() {
        // Capture-phase pointerdown: detect horizontal drags for click
        // suppression (the browser handles the actual scrolling).
        this._grabListener = (e) => {
            if (e.pointerType !== 'touch' && e.pointerType !== 'mouse') return;
            const track = this._resolveTrack(e.target);
            if (!track) return;

            // Catch-the-fling: a fresh press takes over the row immediately.
            this._cancelFlingWatcher();

            this._activePointerId = e.pointerId;
            this._downX = e.clientX;
            this._downY = e.clientY;
            this._moved = false;
        };
        document.addEventListener('pointerdown', this._grabListener, { capture: true });

        this._moveListener = (e) => {
            if (this._activePointerId === null || e.pointerId !== this._activePointerId) return;
            if (!this._moved) {
                const dx = e.clientX - this._downX;
                const dy = e.clientY - this._downY;
                if (Math.hypot(dx, dy) >= DRAG_SLOP_PX) {
                    this._moved = true;
                    this._cancelSettleForDrag();
                }
            }
        };
        document.addEventListener('pointermove', this._moveListener, { capture: true });

        this._upListener = (e) => {
            if (e.pointerId !== this._activePointerId) return;
            this._activePointerId = null;
            if (this._moved) {
                this._blockClickUntil = Date.now() + CLICK_SUPPRESS_MS;
                this._scheduleSettle(e.target);
            }
        };
        document.addEventListener('pointerup', this._upListener, { capture: true });
        document.addEventListener('pointercancel', this._upListener, { capture: true });

        // Click suppression: swallow card clicks right after a drag.
        this._clickCaptureListener = (e) => {
            if (Date.now() < this._blockClickUntil && this._resolveTrack(e.target)) {
                e.stopPropagation();
                e.preventDefault();
                log.debug('Suppressed click after touch drag');
            }
        };
        document.addEventListener('click', this._clickCaptureListener, { capture: true });

        // Keep the virtual window synced while any row scrolls natively.
        this._scrollListener = (e) => {
            const target = e.target;
            if (!(target instanceof Element)) return;
            const rowItems = target.closest('.row-items');
            if (!rowItems) return;

            this._lastTouchedRow = rowItems;
            const track = rowItems.querySelector(':scope > .row-items-track');
            const row = track && track.__virtualRow;
            if (row) row.syncScrollToPosition(this._readScrollX(rowItems));

            // Debounced "scroll finished" for LazyLoader resume.
            clearTimeout(this._scrollIdleTimer);
            this._scrollIdleTimer = setTimeout(() => {
                eventBus.emit('scroll:finished');
            }, 250);
        };
        document.addEventListener('scroll', this._scrollListener, { capture: true, passive: true });
    }

    // ========================================================================
    // Settle: ease from fling-rest position onto card-center geometry
    // ========================================================================

    /**
     * After the browser fling ends, align the row to the nearest card center
     * using the exact ScrollController geometry (elementPos - containerWidth/2
     * + elementWidth/2, clamped). Scheduled on pointerup; waits for inertia.
     * @private
     */
    _scheduleSettle(target) {
        const el = target instanceof Element ? target : null;
        const rowItems = el ? el.closest('.row-items') : null;
        if (!rowItems) return;

        const track = rowItems.querySelector(':scope > .row-items-track');
        if (!track) return;

        this._cancelFlingWatcher();

        // =================================================================
        // FLING WATCHER — never fight the browser's native momentum.
        // =================================================================
        // A fast fling can coast for well over a second. Settling on a fixed
        // timer while the compositor is still applying fling velocity makes
        // two writers fight over scrollLeft (row stops → eases back → fling
        // reasserts → jitter). Instead, poll until the row has genuinely
        // stopped moving, THEN ease onto the card-center geometry.
        // =================================================================
        const startTime = performance.now();
        let lastScroll = rowItems.scrollLeft || 0;
        let stillFrames = 0;

        const poll = () => {
            this._flingWatcher = null;

            // A fresh finger press = catch-the-fling; never settle under it.
            if (this._activePointerId !== null) return;

            const cur = rowItems.scrollLeft || 0;
            if (Math.abs(cur - lastScroll) < SETTLE_STILL_PX) {
                stillFrames++;
            } else {
                stillFrames = 0;
                lastScroll = cur;
            }
            const elapsed = performance.now() - startTime;

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

    /** Cancel a pending fling watcher (catch-the-fling, D-pad, destroy). */
    _cancelFlingWatcher() {
        if (this._flingWatcher) {
            cancelAnimationFrame(this._flingWatcher.raf);
            this._flingWatcher = null;
        }
    }

    /**
     * Ease the row onto the nearest card-center scroll position.
     * Public: also usable after programmatic scrolls.
     * @param {HTMLElement} rowItems
     * @returns {void}
     */
    settleToCardCenter(rowItems) {
        const track = rowItems.querySelector(':scope > .row-items-track');
        if (!track) return;

        const row = track.__virtualRow;
        const containerWidth = rowItems.clientWidth;
        const isRtl = document.documentElement.dir === 'rtl';
        const maxScroll = Math.max(0, (row ? row.getTrackWidth() : track.scrollWidth) - containerWidth);

        let current;
        let target;
        if (row) {
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
            // Non-virtual row: center the card nearest the viewport center.
            const cards = track.querySelectorAll('.media-card');
            if (!cards.length) return;
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
            if (!best) return;
            target = Math.max(0, Math.min(best.pos - containerWidth / 2 + best.width / 2, maxScroll));
        }

        if (Math.abs(target - current) <= SETTLE_TOLERANCE_PX) {
            this._finalizeSettle(rowItems, row, target);
            return;
        }

        this._animateSettle(rowItems, row, current, target, isRtl);
    }

    /**
     * RAF ease (easeOutQuad) from `from` to `to`, mirroring ScrollController's
     * vertical glide. Writes go through the native scroller; the browser's
     * fling has already ended by the time this runs.
     * @private
     */
    _animateSettle(rowItems, row, from, to, isRtl) {
        this._cancelSettle(rowItems);
        const duration = Math.min(MAX_SETTLE_MS, Math.max(120, Math.abs(to - from) * 0.5));
        const startTime = performance.now();

        const tick = (now) => {
            // A new finger on the row cancels the settle.
            if (this._activePointerId !== null) {
                this._cancelSettle(rowItems);
                return;
            }
            const progress = Math.min((now - startTime) / duration, 1);
            const eased = progress * (2 - progress); // easeOutQuad
            const value = from + (to - from) * eased;

            this._writeScroll(rowItems, value, isRtl);
            if (row) row.syncScrollToPosition(value);

            if (progress < 1) {
                const state = this._settleAnims.get(rowItems);
                if (state) state.raf = requestAnimationFrame(tick);
            } else {
                this._finalizeSettle(rowItems, row, to);
            }
        };

        this._settleAnims.set(rowItems, { raf: requestAnimationFrame(tick), target: to });
    }

    /**
     * Persist the final position: save the centered card index on the virtual
     * row so the next D-pad press continues from exactly where the finger
     * stopped, and release LazyLoader.
     * @private
     */
    _finalizeSettle(rowItems, row, finalX) {
        this._settleAnims.delete(rowItems);
        if (row) {
            row.endTouchScroll(finalX);
        }
        eventBus.emit('scroll:finished');
    }

    /** Cancel a running settle animation on one row. @private */
    _cancelSettle(rowItems) {
        const state = this._settleAnims.get(rowItems);
        if (state) {
            cancelAnimationFrame(state.raf);
            this._settleAnims.delete(rowItems);
        }
    }

    /** Called when a fresh drag starts on a row that is settling. @private */
    _cancelSettleForDrag() {
        const el = document.elementFromPoint(this._downX, this._downY);
        if (!el) return;
        const rowItems = el.closest('.row-items');
        if (rowItems) this._cancelSettle(rowItems);
        else this._settleAnims.forEach((state) => cancelAnimationFrame(state.raf));
    }

    // ========================================================================
    // D-pad interop
    // ========================================================================

    /**
     * D-pad presses must always win over touch settling: snap any in-flight
     * settle to its target instantly, then let FocusManager's normal centering
     * (which now writes scrollLeft on Android) take over.
     */
    _handleDpad() {
        // D-pad always wins: drop any pending settle watcher, then snap the
        // in-flight settle to its target so focus centering starts clean.
        this._cancelFlingWatcher();
        if (this._settleAnims.size === 0) return;
        this._settleAnims.forEach((state, rowItems) => {
            cancelAnimationFrame(state.raf);
            this._settleAnims.delete(rowItems);
            const track = rowItems.querySelector(':scope > .row-items-track');
            const row = track && track.__virtualRow;
            const isRtl = document.documentElement.dir === 'rtl';
            // Jump to the settle target so D-pad centering starts from a
            // deterministic position.
            this._writeScroll(rowItems, state.target, isRtl);
            if (row) {
                row.endTouchScroll(state.target);
            }
        });
    }

    // ========================================================================
    // Helpers
    // ========================================================================

    /**
     * Read the row's scroll position in "video space" (positive = revealing
     * content to the right in LTR), matching the ScrollController convention.
     * @private
     */
    _readScrollX(rowItems) {
        const raw = rowItems.scrollLeft || 0;
        const isRtl = document.documentElement.dir === 'rtl';
        if (!isRtl) return raw;
        // RTL Chromium: scrollLeft is 0 at the visual start (right) and goes
        // negative toward the visual end. Normalize to positive video space.
        return -raw;
    }

    /**
     * Write a scroll position in video space to the native scroller.
     * @private
     */
    _writeScroll(rowItems, x, isRtl) {
        rowItems.scrollLeft = isRtl ? -x : x;
    }

    /** Mathematically derived expanded-card width for expanding-mode rows. */
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
            /* fall through */
        }
        return null;
    }

    /**
     * Resolve the .row-items a touch landed on, skipping rows that must not be
     * touch-scrolled (hero carousel, sidebar, modals).
     * @param {EventTarget} target
     * @returns {HTMLElement|null}
     * @private
     */
    _resolveTrack(target) {
        if (!target || !target.closest) return null;
        const el = /** @type {Element} */ (target);
        if (el.closest('#hero-carousel-container') || el.closest('aside') || el.closest('.modal-overlay')) {
            return null;
        }
        const rowItems = el.closest('.row-items');
        if (!rowItems) return null;
        return /** @type {HTMLElement} */ (rowItems);
    }
}

export const touchHorizontalScroller = new TouchHorizontalScroller();
