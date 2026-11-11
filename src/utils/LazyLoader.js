/**
 * ============================================================================
 * Litefin Tizen - Lazy Loader
 * ============================================================================
 * Polyfill-like functionality for lazy loading images using IntersectionObserver.
 * Necessary because Tizen 4 (Chromium 56) ignores loading="lazy".
 * ============================================================================
 */

import { logger } from './Logger.js';
import { eventBus } from '../core/EventBus.js';
import BlurHashDecoder from './BlurHashDecoder.js';
import { storage } from './StorageService.js';
import { escapeHtml } from './Utils.js';
import { customHeaders } from './CustomHeaders.js';
import { markPerfOperation } from './PerfMarker.js';

const log = logger.create('LazyLoader');

/**
 * Quiet window (ms) required after the last user keypress / scroll before any
 * deferred LazyLoader work (image src churn, BlurHash decode, marquee layout
 * measure) may run.
 *
 * TV D-pad key repeats land every ~250-500ms. The previous 220ms settle window
 * fired deferred work in exactly that gap between two presses — telemetry
 * attributed it to `ScrollController.finish (+96-244ms)`. 800ms guarantees a
 * full rapid-scroll burst has drained before the main thread is touched again.
 */
const USER_ACTIVITY_QUIET_MS = 800;

/**
 * Deferred post-scroll settle / pending-element flush delay (ms). Both paths
 * re-arm themselves while the user is still active.
 */
const POST_SCROLL_SETTLE_MS = 800;

/**
 * IntersectionObserver lookahead cushion (top/bottom 1800px, sides 300px).
 * Extended vertical lookahead reaches below-the-fold home rows (rows 2-5 at
 * 1080p) right away so images start loading and decoding before the first
 * scroll instead of decoding mid-flight inside ScrollController._step.
 */
const IO_ROOT_MARGIN = '1800px 300px';

class LazyLoader {
    constructor() {
        this.observer = null;

        /* ----------------------------------------------------------------
         * SHIMMER OBSERVER
         * A separate IntersectionObserver (zero rootMargin) tracks every
         * .skeleton-shimmer element. Off-screen shimmers get the class
         * 'shimmer-hidden' which CSS maps to animation-play-state: paused.
         * A paused CSS animation requires ZERO compositor layers — this is
         * exactly what eliminates the 100+ GPU layers causing the Layerize
         * spike in Segment 1 of the profile.
         * ---------------------------------------------------------------- */
        this._shimmerObserver = null;

        /* ----------------------------------------------------------------
         * SCROLL ACTIVITY STATE, LAZY QUEUE & BLURHASH THROTTLING
         * Track scroll state for both BlurHash DCT decoding and intersection
         * image/row loading so D-pad scroll animations stay free of img.src
         * churn and synchronous style/decode spikes mid-flight.
         * ---------------------------------------------------------------- */
        this._scrollTimeout = null;

        // Monotonic timestamp (ms) of the last user interaction (D-pad keydown
        // or scroll event). Deferred work stays parked while the user is active.
        this._lastInteractionAt = 0;

        // Track cancellable post-scroll marquee/BlurHash settle work so rapid
        // consecutive key presses never collide with ScrollController.finish.
        this._postScrollSettleTimerId = null;
        this._postScrollSettleRafId = null;
        this._postScrollSettleRafUsesTimeout = false;

        // Fast flag tracking whether any .marquee-active element exists so
        // focus:changed skips full-document querySelector probes when idle.
        this._hasActiveMarquee = false;

        // ── Deferred marquee measurement ────────────────────────────────────
        // Holds the focused card element when its text-overflow measurement was
        // deferred because a scroll transition was in flight. Flushed when
        // scrolling settles (see _flushPendingMarquee).
        this._pendingMarqueeTarget = null;

        // ── BlurHash decode queue ───────────────────────────────────────────
        // Prevents micro-freeze storms on low-end TV CPUs by throttling
        // BlurHash DCT inversions to at most N per animation frame.
        this._blurHashQueue = [];
        this._blurHashProcessing = false;
        this._maxBlurhashPerFrame = 2;

        // ── Scroll-paused intersection queue ────────────────────────────────
        // Elements crossing the viewport rootMargin while a scroll animation
        // is active wait here until scroll settles, then drain in small rAF
        // batches (2 elements per frame).
        this._pendingElements = [];
        this._pendingFlushTimerId = null;
        this._pendingFlushRafId = null;
        this._maxPendingPerFrame = 2;

        // Coalesced visibility updates for .skeleton-shimmer cards whose view
        // intersections changed mid-scroll or inside the post-scroll settle window.
        this._pendingShimmerStates = new Map();

        // Tracks in-flight fetch + img.decode() settlement per image element so
        // pre-splash initial viewports can await off-screen decodes without expando fields.
        this._settleTrackers = new WeakMap();

        this._init();
    }

    _init() {
        // Capture native scroll events in the capture phase to track all scrollable nodes.
        // Marked passive so Chromium's compositor never stalls vertical scrolls waiting
        // on main-thread preventDefault() inspection.
        window.addEventListener(
            'scroll',
            () => {
                // Any scroll — native or ScrollController-driven — counts as user
                // activity, so deferred image/BlurHash work never runs between two
                // D-pad presses.
                this._lastInteractionAt = Date.now();

                // Skip per-frame timer churn while ScrollController owns an active
                // animation; scroll:started cancels pending work and scroll:finished
                // deterministically schedules the settle pass when motion completes.
                const sc = typeof window !== 'undefined' ? window.__scrollController : null;
                if (sc && sc.isAnimating) {
                    return;
                }

                // Cancel any pending flush work if native scrolling resumes
                this._cancelPendingElementsFlush();
                this._cancelPostScrollSettleWork();

                if (this._scrollTimeout) {
                    clearTimeout(this._scrollTimeout);
                }
                // Debounce check: scrolling is considered stopped after 150ms of silence
                this._scrollTimeout = setTimeout(() => {
                    this._scrollTimeout = null;
                    // Resume deferred work once viewport scrolling settles
                    if (!this._isScrolling()) {
                        this._schedulePostScrollSettleWork(POST_SCROLL_SETTLE_MS, () => {
                            this._flushPendingMarquee();
                        });
                        this._schedulePendingElementsFlush(POST_SCROLL_SETTLE_MS);
                    }
                }, 150);
            },
            { capture: true, passive: true }
        );

        // D-pad / keyboard activity extends the quiet window. Capture phase so a
        // handler that stops propagation cannot hide the press from us.
        window.addEventListener(
            'keydown',
            () => {
                this._lastInteractionAt = Date.now();
            },
            true
        );

        // Cancel any pending post-scroll flush and settle timers immediately when
        // a new scroll animation begins so rapid D-pad presses never hit stalls.
        eventBus.on('scroll:started', () => {
            this._lastInteractionAt = Date.now();
            if (this._scrollTimeout) {
                clearTimeout(this._scrollTimeout);
                this._scrollTimeout = null;
            }
            this._cancelPendingElementsFlush();
            this._cancelPostScrollSettleWork();
        });

        // Listen for ScrollController finishing its transitions
        eventBus.on('scroll:finished', () => {
            // Treat scroll finish as the start of the quiet cooldown window so
            // Chromium's post-rAF IntersectionObserver turn immediately following
            // Frame K queues intersecting targets instead of synchronously loading rows.
            this._lastInteractionAt = Date.now();

            // Defer BlurHash + marquee reflow past the 800ms quiet window so
            // post-scroll measurements never fire during ScrollController.finish
            // or between quick consecutive D-pad steps.
            this._schedulePostScrollSettleWork(POST_SCROLL_SETTLE_MS, () => {
                this._flushPendingMarquee();
            });

            // Schedule queued intersection elements 800ms after scroll settles so
            // rapid multi-row D-pad taps (~250-500ms spacing) cancel before flushing.
            this._schedulePendingElementsFlush(POST_SCROLL_SETTLE_MS);
        });

        // Legacy TV Focus-Driven Lazy Load
        // Since IntersectionObserver fails on Tizen/WebOS hardware layers (especially for grids),
        // we use D-Pad focus events to aggressively preload the grid as the user navigates.
        // NATIVE focus is disabled in this TV app, so we must hook EventBus.
        eventBus.on('focus:changed', (target) => {
            if (!target || !target.classList) return;

            // Drop any previously deferred marquee target if focus moved onward.
            if (this._pendingMarqueeTarget && this._pendingMarqueeTarget !== target) {
                this._pendingMarqueeTarget = null;
            }

            // Reset any previous active marquees
            // ----------------------------------------------------------------
            // MARQUEE CLEANUP: Ensure any previously animating text elements
            // are reset to their default static states. This drops animation
            // loops and releases Compositor layers when they are off focus.
            // PERFORMANCE: skip DOM probing completely unless a marquee was
            // actually activated, and probe with a single querySelector first.
            // ----------------------------------------------------------------
            if (this._hasActiveMarquee) {
                if (document.querySelector('.marquee-active')) {
                    document.querySelectorAll('.marquee-active').forEach((el) => {
                        el.classList.remove('marquee-active');
                        const span = el.querySelector('span');
                        if (span) {
                            span.style.removeProperty('transform');
                        }
                        el.style.removeProperty('--scroll-dist');
                        el.style.removeProperty('--marquee-duration');
                    });
                }
                this._hasActiveMarquee = false;
            }

            // If it's a media card
            if (target.classList.contains('media-card')) {
                const img = target.querySelector('img[data-src]');
                if (img) {
                    this.forceLoad(img);
                }
                // Batch preload ahead to prevent popping.
                // PERFORMANCE: Defer to the next animation frame so the sibling
                // DOM walk doesn't block the critical focus transition paint.
                // Skip if a scroll animation is running on that frame so sibling
                // img.src mutations never contend with Frame 1 scroll work.
                const isVirtualCard = target.dataset && target.dataset.virtualIndex !== undefined;
                if (!isVirtualCard) {
                    const preloadTarget = img || target;
                    requestAnimationFrame(() => {
                        if (!this._isScrolling()) {
                            this._batchPreloadImages(preloadTarget);
                        }
                    });
                }

                // ----------------------------------------------------------------
                // DYNAMIC TEXT MARQUEE SCROLL DETECTOR
                // ----------------------------------------------------------------
                // Calculates text overflow dynamically on card focus. If the inner
                // span's scrollWidth exceeds the parent clientWidth, a scrolling
                // keyframe animation is applied using HSL/CSS custom variables.
                //
                // PERFORMANCE NOTE:
                // Reading scrollWidth and clientWidth immediately after focus class
                // assignment forces an expensive synchronous layout reflow (50-100ms
                // on TV hardware) right as the viewport needs to begin its smooth
                // scroll. Deferring this check via requestAnimationFrame lets the layout
                // settle cleanly without dropping animation frames.
                // ----------------------------------------------------------------
                if (storage.getItem('pref:loopOverflowingText') !== 'false') {
                    requestAnimationFrame(() => {
                        // Guard against focus having already left the card
                        if (!target || !target.classList.contains('focused')) return;

                        // PERFORMANCE: Reading scrollWidth/clientWidth forces a synchronous
                        // layout reflow (50-100ms on TV hardware). If a scroll transition is
                        // in flight at this frame, defer the measurement until scrolling
                        // settles so frame 1 of the transition is never blocked. The pending
                        // target is flushed from the native-scroll debounce and the
                        // 'scroll:finished' listener above.
                        if (this._isScrolling()) {
                            this._pendingMarqueeTarget = target;
                            return;
                        }

                        this._checkTextMarquee(target);
                    });
                }
            }
        });

        // Tizen 4 (Chrome 56) supports IntersectionObserver
        if ('IntersectionObserver' in window) {
            this.observer = new IntersectionObserver(
                (entries, observer) => {
                    let markedIntersect = false;
                    entries.forEach((entry) => {
                        if (entry.isIntersecting) {
                            const target = entry.target;
                            if (!target || target.isConnected === false) return;

                            // Defer image/row loading while scrolling or within the active
                            // interaction cooldown window so post-rAF observer deliveries
                            // never stall final scroll frames with img.src / class mutations.
                            if (!this._canRunDeferredWork()) {
                                this._enqueuePendingElement(target);
                                return;
                            }

                            if (!markedIntersect) {
                                markedIntersect = true;
                                if (typeof markPerfOperation === 'function') {
                                    markPerfOperation('LazyLoader.intersect');
                                }
                            }

                            this._dequeuePendingElement(target);
                            if (typeof target.hasAttribute === 'function' && target.hasAttribute('data-lazy-row')) {
                                this._loadRow(target);
                            } else {
                                this._loadImage(target);
                            }
                        }
                    });
                },
                {
                    // Wide vertical lookahead keeps the next screens of artwork in
                    // flight before the user arrives, so the post-scroll settle pass
                    // has little left to load. Actual loads are still deferred to a
                    // quiet window (see USER_ACTIVITY_QUIET_MS), so the wider margin
                    // never puts img.src churn on a keypress frame.
                    rootMargin: IO_ROOT_MARGIN,
                    threshold: 0.01
                }
            );

            // ================================================================
            // SHIMMER ANIMATION OBSERVER
            // ================================================================
            // CSS @keyframes animations still maintain a compositor layer even
            // without will-change when the animation is actively running — the
            // browser promotes the element so it can drive the transform on the
            // GPU thread. With 100 off-screen skeletons all animating, that is
            // 100 compositor layers eating Tizen VRAM and causing Layerize spikes.
            //
            // This observer watches .card-image.skeleton-shimmer elements with a
            // ZERO rootMargin (strictly visible only). Off-screen shimmers get
            // the 'shimmer-hidden' class which CSS maps to:
            //   animation-play-state: paused
            //
            // A PAUSED animation requires NO compositor layer — the GPU is free.
            // ================================================================
            this._shimmerObserver = new IntersectionObserver(
                (entries) => {
                    const canApplyNow = this._canRunDeferredWork();
                    entries.forEach((entry) => {
                        if (!canApplyNow) {
                            // Defer shimmer layer wakeups/pauses until scrolling and keypress
                            // cooldown settle so finish frames never re-promote 30 shimmers at once.
                            this._pendingShimmerStates.set(entry.target, entry.isIntersecting);
                            return;
                        }
                        // Use classList directly — no touching other properties
                        if (entry.isIntersecting) {
                            // Back in view: resume shimmer animation
                            entry.target.classList.remove('shimmer-hidden');
                        } else {
                            // Out of view: pause shimmer animation to drop GPU layer
                            entry.target.classList.add('shimmer-hidden');
                        }
                    });
                    if (!canApplyNow && this._pendingShimmerStates.size > 0 && !this._postScrollSettleTimerId && !this._isScrolling()) {
                        this._schedulePostScrollSettleWork(POST_SCROLL_SETTLE_MS);
                    }
                },
                {
                    // Strict viewport — only truly visible elements animate.
                    // Small negative margin ensures elements partially off the
                    // top/bottom edge are also paused.
                    rootMargin: '0px',
                    threshold: 0.0
                }
            );
        } else {
            log.warn('IntersectionObserver not supported. Fallback to immediate load.');
        }
    }

    /**
     * Check if a scrolling action or transition is active on the screen
     * @returns {boolean}
     * @private
     */
    _isScrolling() {
        // Inspect exposed ScrollController state to see if active transitions exist
        if (window.__scrollController && window.__scrollController.isAnimating) {
            return true;
        }
        return this._scrollTimeout !== null;
    }

    /**
     * True while the user is still actively navigating (keypress or scroll
     * within the last 800ms). Deferred image/BlurHash/marquee work must never
     * run inside this window — on TV hardware it always lands between two
     * D-pad key repeats (~250-500ms apart).
     *
     * @returns {boolean}
     * @private
     */
    _isUserActive() {
        return Date.now() - this._lastInteractionAt < USER_ACTIVITY_QUIET_MS;
    }

    /**
     * True when deferred work may safely run: no scroll animation in flight and
     * the 800ms post-interaction quiet window has elapsed.
     *
     * @returns {boolean}
     * @private
     */
    _canRunDeferredWork() {
        return !this._isScrolling() && !this._isUserActive();
    }

    /**
     * Queue an intersecting element to load once active scroll motion settles.
     * Deduplicates linearly (queue depth during a single scroll is tiny).
     *
     * @param {HTMLElement} target - Row container or lazy image element
     * @private
     */
    _enqueuePendingElement(target) {
        if (!target) return;

        // Avoid pushing duplicate entries if the observer fires multiple times mid-scroll
        for (let i = 0; i < this._pendingElements.length; i++) {
            if (this._pendingElements[i] === target) {
                return;
            }
        }

        this._pendingElements.push(target);
    }

    /**
     * Removes a single target from the pending scroll queue if already present.
     *
     * @param {HTMLElement} target - Element to dequeue
     * @private
     */
    _dequeuePendingElement(target) {
        for (let i = this._pendingElements.length - 1; i >= 0; i--) {
            if (this._pendingElements[i] === target) {
                this._pendingElements.splice(i, 1);
            }
        }
    }

    /**
     * Trigger loading for a single intersecting row or image element and remove
     * it from any pending queue entry so it cannot load twice.
     *
     * @param {HTMLElement} target - Intersecting element
     * @private
     */
    _loadIntersectingTarget(target) {
        if (!target || target.isConnected === false) return;

        // Drop from the deferred queue if it loaded through an eager path
        this._dequeuePendingElement(target);

        if (typeof target.hasAttribute === 'function' && target.hasAttribute('data-lazy-row')) {
            this._loadRow(target);
        } else {
            this._loadImage(target);
        }
    }

    /**
     * Cancel any pending post-scroll flush timer and active rAF slice cleanly
     * when a new scroll transition begins or a page tears down.
     *
     * @private
     */
    _cancelPendingElementsFlush() {
        if (this._pendingFlushTimerId) {
            clearTimeout(this._pendingFlushTimerId);
            this._pendingFlushTimerId = null;
        }
        if (this._pendingFlushRafId) {
            cancelAnimationFrame(this._pendingFlushRafId);
            this._pendingFlushRafId = null;
        }
    }

    /**
     * Cancel any pending post-scroll BlurHash/marquee settle timer and its
     * deferred rAF callback when new scrolling starts or a view tears down.
     *
     * @private
     */
    _cancelPostScrollSettleWork() {
        if (this._postScrollSettleTimerId) {
            clearTimeout(this._postScrollSettleTimerId);
            this._postScrollSettleTimerId = null;
        }
        if (this._postScrollSettleRafId) {
            // Cancel via matching primitive when falling back to setTimeout.
            if (this._postScrollSettleRafUsesTimeout) {
                clearTimeout(this._postScrollSettleRafId);
            } else if (typeof cancelAnimationFrame === 'function') {
                cancelAnimationFrame(this._postScrollSettleRafId);
            }
            this._postScrollSettleRafId = null;
            this._postScrollSettleRafUsesTimeout = false;
        }
    }

    /**
     * Schedule deferred marquee overflow measurement on its own animation frame
     * once scrolling is idle so scrollWidth/clientWidth reads never share a frame
     * with ScrollController transitions.
     *
     * @param {Function|null} [onFlush=null] - Flush callback invoking _flushPendingMarquee
     * @private
     */
    _scheduleMarqueeFlushRaf(onFlush = null) {
        if (!this._pendingMarqueeTarget) return;
        if (this._postScrollSettleRafId) return;

        const hasRaf = typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function';
        this._postScrollSettleRafUsesTimeout = !hasRaf;
        const scheduleRaf = hasRaf ? window.requestAnimationFrame : (cb) => setTimeout(cb, 16);

        this._postScrollSettleRafId = scheduleRaf(() => {
            this._postScrollSettleRafId = null;
            this._postScrollSettleRafUsesTimeout = false;
            if (!this._canRunDeferredWork()) {
                // Re-arm until the 800ms quiet window elapses — never force a
                // layout read (scrollWidth) between two D-pad presses.
                this._schedulePostScrollSettleWork(POST_SCROLL_SETTLE_MS, onFlush);
                return;
            }
            if (typeof onFlush === 'function') {
                onFlush();
            } else {
                this._flushPendingMarquee();
            }
        });
    }

    /**
     * Schedule deferred BlurHash decoding and marquee layout checks after a
     * cancellable 800ms quiet window so rapid D-pad taps never pay
     * layout/decode costs between presses.
     *
     * @param {number} [delayMs=800] - Quiet window after scroll:finished
     * @param {Function|null} [onMarqueeFlush=null] - Flush callback for deferred marquee
     * @private
     */
    _schedulePostScrollSettleWork(delayMs = POST_SCROLL_SETTLE_MS, onMarqueeFlush = null) {
        this._cancelPostScrollSettleWork();

        this._postScrollSettleTimerId = setTimeout(() => {
            this._postScrollSettleTimerId = null;
            if (!this._canRunDeferredWork()) {
                // The user is still navigating — push the whole settle pass out
                // by another quiet window instead of running it in the keypress gap.
                this._schedulePostScrollSettleWork(POST_SCROLL_SETTLE_MS, onMarqueeFlush);
                return;
            }
            this._flushPendingShimmerStates();
            this._processBlurHashQueue();
            this._scheduleMarqueeFlushRaf(onMarqueeFlush);
        }, delayMs);
    }

    /**
     * Apply coalesced `.shimmer-hidden` visibility updates queued while scrolling
     * or navigating so compositor layer wakeups happen cleanly during quiet time.
     *
     * @private
     */
    _flushPendingShimmerStates() {
        if (!this._pendingShimmerStates || this._pendingShimmerStates.size === 0) return;
        this._pendingShimmerStates.forEach((isIntersecting, target) => {
            if (!target || target.isConnected === false || !target.classList) return;
            if (isIntersecting) {
                target.classList.remove('shimmer-hidden');
            } else {
                target.classList.add('shimmer-hidden');
            }
        });
        this._pendingShimmerStates.clear();
    }

    /**
     * Debounce and schedule flushing of elements queued during scroll.
     *
     * @param {number} [delayMs=800] - Settle delay after scroll:finished
     * @private
     */
    _schedulePendingElementsFlush(delayMs = POST_SCROLL_SETTLE_MS) {
        if (this._pendingFlushTimerId) {
            clearTimeout(this._pendingFlushTimerId);
            this._pendingFlushTimerId = null;
        }

        if (this._pendingElements.length === 0) return;

        this._pendingFlushTimerId = setTimeout(() => {
            this._pendingFlushTimerId = null;
            if (!this._canRunDeferredWork()) {
                // Re-arm while the user keeps pressing. Never flush img.src work
                // inside the 250-500ms gap between key repeats.
                this._schedulePendingElementsFlush(POST_SCROLL_SETTLE_MS);
                return;
            }
            this._flushPendingElements();
        }, delayMs);
    }

    /**
     * Drain elements queued while scrolling in small requestAnimationFrame slices
     * so resuming post-scroll image loads stays inside the 16ms frame budget.
     *
     * @private
     */
    _flushPendingElements() {
        if (this._pendingElements.length === 0) return;
        if (!this._canRunDeferredWork()) {
            // Still inside the user's active window — retry after quiet.
            this._schedulePendingElementsFlush(POST_SCROLL_SETTLE_MS);
            return;
        }
        if (this._pendingFlushRafId) return;

        const scheduleRaf =
            typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function'
                ? window.requestAnimationFrame
                : (cb) => setTimeout(cb, 16);

        const drainSlice = () => {
            this._pendingFlushRafId = null;

            // Pause immediately if the user started another scroll / keypress mid-flush
            if (!this._canRunDeferredWork() || this._pendingElements.length === 0) {
                if (this._pendingElements.length > 0) {
                    this._schedulePendingElementsFlush(POST_SCROLL_SETTLE_MS);
                }
                return;
            }

            if (typeof markPerfOperation === 'function') markPerfOperation('LazyLoader.flushPending');
            let processedCount = 0;
            while (this._pendingElements.length > 0 && processedCount < this._maxPendingPerFrame) {
                const target = this._pendingElements.shift();
                if (!target || target.isConnected === false) {
                    continue;
                }

                const isLazyRow = typeof target.hasAttribute === 'function' && target.hasAttribute('data-lazy-row');
                this._loadIntersectingTarget(target);
                processedCount++;

                // A single lazy row fans out to multiple card images, so yield after
                // loading one row to avoid bundling multiple rows in the same frame.
                if (isLazyRow) {
                    break;
                }
            }

            // Continue draining remaining targets on subsequent animation frames
            if (this._pendingElements.length > 0) {
                if (this._canRunDeferredWork()) {
                    this._pendingFlushRafId = scheduleRaf(drainSlice);
                } else {
                    this._schedulePendingElementsFlush(POST_SCROLL_SETTLE_MS);
                }
            }
        };

        this._pendingFlushRafId = scheduleRaf(drainSlice);
    }

    /**
     * Measure text overflow on the focused card and engage the CSS marquee
     * animation when the inner span overflows its container.
     *
     * PERFORMANCE NOTE: Reading scrollWidth/clientWidth forces a synchronous
     * layout reflow on low-end TV CPUs. Never call this while a scroll
     * transition is in flight — the focus:changed handler defers the call and
     * it is flushed from the scroll-settle paths instead.
     * @param {HTMLElement} target - The focused media card element
     * @private
     */
    _checkTextMarquee(target) {
        if (!target || !target.isConnected || !target.classList.contains('focused')) return;

        const textElements = target.querySelectorAll('.card-title, .card-subtitle');
        textElements.forEach((el) => {
            const span = el.querySelector('span');
            if (!span) return;

            const scrollW = span.scrollWidth;
            const clientW = el.clientWidth;

            // Check if text exceeds horizontal boundaries of the card
            if (scrollW > clientW) {
                const scrollDist = scrollW - clientW;
                const extraSpacing = 30; // 30px visual buffer/margin before looping back
                const totalScroll = scrollDist + extraSpacing;

                // Adjust scrolling duration dynamically based on length (30px/sec speed)
                const duration = Math.max(3, totalScroll / 30);

                el.style.setProperty('--scroll-dist', `-${totalScroll}px`);
                el.style.setProperty('--marquee-duration', `${duration}s`);
                el.classList.add('marquee-active');
                this._hasActiveMarquee = true;
            }
        });
    }

    /**
     * Flush a marquee overflow check that was deferred during active scrolling.
     * Invoked from the scroll-settle paths (native scroll debounce and the
     * 'scroll:finished' event) so the forced reflow only happens once motion
     * has ended.
     * @private
     */
    _flushPendingMarquee() {
        if (!this._pendingMarqueeTarget) return;

        const target = this._pendingMarqueeTarget;
        this._pendingMarqueeTarget = null;

        this._checkTextMarquee(target);
    }

    /**
     * Commits loaded card classes and transitions out BlurHash overlays once the
     * image bitmap has finished decoding off-thread.
     *
     * @param {HTMLImageElement} img
     * @private
     */
    _finalizeLoadedImage(img) {
        if (!img || img.classList.contains('loaded')) return;

        img.classList.add('loaded');
        img.removeAttribute('data-lazy-loading');

        const parent = img.parentElement;
        if (!parent) return;

        parent.classList.remove('skeleton-shimmer');
        if (this._shimmerObserver) {
            this._shimmerObserver.unobserve(parent);
        }

        if (parent.classList.contains('card-image')) {
            const canvas = parent.querySelector('.blurhash-canvas');
            if (canvas) {
                canvas.classList.add('fade-out');
                setTimeout(() => canvas.remove(), 160);
            }
        }
    }

    /**
     * Attaches unified onload/onerror lifecycle handlers and resolves the
     * settlement tracker once `img.decode()` completes off-thread. Calling
     * `img.decode()` forces Chromium to decode below-the-fold home cards into
     * GPU texture memory immediately rather than deferring until first scroll.
     *
     * @param {HTMLImageElement} img
     * @private
     */
    _bindImageHandlers(img) {
        let tracker = this._settleTrackers.get(img);
        if (!tracker || tracker.settled) {
            let resolveFn;
            const promise = new Promise((resolve) => {
                resolveFn = resolve;
            });
            tracker = { promise, resolve: resolveFn, settled: false };
            this._settleTrackers.set(img, tracker);
        }

        const markSettled = () => {
            if (!tracker.settled) {
                tracker.settled = true;
                tracker.resolve();
            }
        };

        const completeLoad = () => {
            this._finalizeLoadedImage(img);
            markSettled();
        };

        img.onload = () => {
            // Ignore load events fired by the initial transparent 1x1 GIF placeholder
            if (img.src && img.src.startsWith('data:image/gif')) return;

            // Force off-thread bitmap decoding before revealing or settling so
            // off-screen home rows do not stall ScrollController._step on first visit.
            if (typeof img.decode === 'function') {
                Promise.resolve(img.decode()).then(completeLoad, completeLoad);
            } else {
                completeLoad();
            }
        };

        img.onerror = () => {
            // Ignore error events fired while transitioning from placeholder
            if (img.src && img.src.startsWith('data:image/gif')) return;

            // When native request interception encounters a glitch, seamlessly retry
            // via the authenticated JavaScript fetch + Blob URL fallback pipeline.
            const targetSrc = img.dataset.src;
            if (!img.dataset.nativeFallbackTried && customHeaders?.hasCustomHeaders?.() && targetSrc) {
                img.dataset.nativeFallbackTried = 'true';
                customHeaders
                    .resolveImageUrl(targetSrc, null, { bypassNative: true })
                    .then((blobUrl) => {
                        if (blobUrl && blobUrl !== targetSrc && img.isConnected) {
                            img.removeAttribute('crossorigin');
                            img.src = blobUrl;
                            return;
                        }
                        img.removeAttribute('data-lazy-loading');
                        this._handleImageError(img);
                        markSettled();
                    })
                    .catch(() => {
                        img.removeAttribute('data-lazy-loading');
                        this._handleImageError(img);
                        markSettled();
                    });
                return;
            }

            img.removeAttribute('data-lazy-loading');
            this._handleImageError(img);
            markSettled();
        };
    }

    /**
     * Helper to load all images in a row container
     * @param {HTMLElement} row
     * @private
     */
    _loadRow(row) {
        if (!row) return;

        const images = row.querySelectorAll('img[data-src]');
        images.forEach((img) => {
            if (img.classList.contains('loaded')) return;
            if (img.hasAttribute('data-lazy-loading')) return;

            this._startImageLoad(img);
        });

        if (this.observer) {
            this.observer.unobserve(row);
        }
    }

    /**
     * Begins loading a single image before scheduling its BlurHash placeholder
     * so cached images never burn main-thread DCT cycles when the real bitmap
     * is already available.
     *
     * @param {HTMLImageElement} img - Image element to load
     * @private
     */
    _startImageLoad(img) {
        // Mark as lazy loading immediately to prevent duplicate triggers
        img.setAttribute('data-lazy-loading', '');

        // Bind shared decode-awaiting handlers and start fetch BEFORE BlurHash
        this._bindImageHandlers(img);
        this._assignImageSource(img, img.dataset.src);

        // Defer BlurHash decoding by one frame so memory/HTTP cache hits skip DCT work.
        // Skip scheduling an extra rAF entirely when the card has no BlurHash canvas.
        const canvas =
            img.parentElement && typeof img.parentElement.querySelector === 'function'
                ? img.parentElement.querySelector('.blurhash-canvas')
                : null;
        if (canvas && !canvas.classList.contains('blurhash-decoded')) {
            if (typeof requestAnimationFrame === 'function') {
                requestAnimationFrame(() => {
                    if (img.isConnected !== false) {
                        this._decodeAndDrawBlurhash(img);
                    }
                });
            } else {
                this._decodeAndDrawBlurhash(img);
            }
        }
    }

    /**
     * Assigns the final image source to an image element.
     * When custom reverse proxy headers are active, resolves the URL via
     * CustomHeadersManager (which fetches the image with headers and converts
     * to a local in-memory blob URL), falling back gracefully on failure.
     *
     * @param {HTMLImageElement} img - Image element to update
     * @param {string} targetSrc - Jellyfin image URL from dataset
     * @private
     */
    _assignImageSource(img, targetSrc) {
        // Hint off-thread image decode before assigning src so compositor frames stay smooth
        if (img && 'decoding' in img) {
            img.decoding = 'async';
        }

        // Fast path: if no custom headers configured, assign src directly with standard anonymous crossOrigin
        if (!customHeaders?.hasCustomHeaders?.()) {
            img.crossOrigin = 'anonymous';
            img.src = targetSrc;
            return;
        }

        // Fast path: if native platform request interception is active (Android TV AuthenticatedWebViewClient),
        // headers are attached at OS level. Assign URL directly without JS fetch or blob allocation.
        if (customHeaders?.hasNativeInterception?.(targetSrc)) {
            img.crossOrigin = 'anonymous';
            img.src = targetSrc;
            return;
        }

        // Check if Blob URL is already in cache for zero-latency synchronous hit
        const cached = customHeaders.getCachedBlobUrl(targetSrc);
        if (cached) {
            // Blob URLs are local memory pointers; avoid setting crossOrigin on them
            img.removeAttribute('crossorigin');
            img.src = cached;
            return;
        }

        // Mark as lazy loading so in-flight state is preserved across async fetch
        img.setAttribute('data-lazy-loading', '');

        // Asynchronously fetch with custom headers and convert to Blob URL
        customHeaders
            .resolveImageUrl(targetSrc)
            .then((resolvedUrl) => {
                // Ensure image element is still attached to the DOM and target URL hasn't changed
                if (img.isConnected && img.dataset.src === targetSrc) {
                    // Local blob URLs must not enforce CORS check in Chromium WebViews
                    if (resolvedUrl && resolvedUrl.startsWith('blob:')) {
                        img.removeAttribute('crossorigin');
                    } else {
                        img.crossOrigin = 'anonymous';
                    }
                    img.src = resolvedUrl;
                }
            })
            .catch(() => {
                // Fallback to original URL so browser error handler can render initials
                if (img.isConnected && img.dataset.src === targetSrc) {
                    img.crossOrigin = 'anonymous';
                    img.src = targetSrc;
                }
            });
    }

    _loadImage(img) {
        if (!img || !img.dataset.src || img.classList.contains('loaded')) return;
        // Prevent re-entering while a load is in-flight.
        // The IntersectionObserver may fire before onload completes on
        // eagerly loaded images; setting src again can abort the fetch
        // on older Chromium (Tizen 3/4), causing the image to never load.
        if (img.hasAttribute('data-lazy-loading')) return;

        this._startImageLoad(img);

        if (this.observer) {
            this.observer.unobserve(img);
        }
    }

    /**
     * Enqueue a BlurHash canvas for deferred, throttled decoding.
     * Instead of decoding every card's BlurHash immediately (which causes
     * micro-freeze storms on single-core TV CPUs when 30+ cards load at once),
     * we process at most `_maxBlurhashPerFrame` per animation frame.
     *
     * @param {HTMLImageElement} img - The image element being loaded
     * @private
     */
    _decodeAndDrawBlurhash(img) {
        // Ignore the initial 1x1 transparent GIF placeholder when checking img.complete
        const isPlaceholder = Boolean(img.src && img.src.startsWith('data:image/gif'));

        // Fast exit: if image is already cached, errored, or completed loading a real bitmap
        if (
            img.classList.contains('loaded') ||
            (img.style && img.style.display === 'none') ||
            (!isPlaceholder && img.complete && img.naturalWidth > 0)
        ) {
            return;
        }

        const parent = img.parentElement;
        if (!parent) return;

        const canvas = parent.querySelector('.blurhash-canvas');
        if (!canvas || canvas.classList.contains('blurhash-decoded')) return;

        const blurHashStr = canvas.dataset.blurhash;
        if (!blurHashStr) return;

        // Mark it decoded immediately to prevent duplicate decoding attempts
        canvas.classList.add('blurhash-decoded');

        // Enqueue for throttled batch processing instead of firing 30+
        // concurrent setTimeout(0) tasks that freeze the main thread.
        this._blurHashQueue.push({ canvas, blurHashStr });
        this._processBlurHashQueue();
    }

    /**
     * Process pending BlurHash decodes at a throttled rate.
     * Drains up to `_maxBlurhashPerFrame` items per rAF cycle.
     * @private
     */
    _processBlurHashQueue() {
        if (this._blurHashProcessing) return;
        if (this._blurHashQueue.length === 0) return;

        // Defer BlurHash DCT computations while viewport scroll animations are
        // active AND during the 800ms post-keypress quiet window. The old path
        // ran them 220ms after scroll:finished, which is exactly the gap between
        // two D-pad key repeats on Tizen.
        if (!this._canRunDeferredWork()) {
            this._schedulePostScrollSettleWork(POST_SCROLL_SETTLE_MS);
            return;
        }

        this._blurHashProcessing = true;

        const processBatch = () => {
            // Re-check scrolling/idle state before each animation frame batch
            if (!this._canRunDeferredWork()) {
                this._blurHashProcessing = false;
                this._schedulePostScrollSettleWork(POST_SCROLL_SETTLE_MS);
                return;
            }

            const batch = this._blurHashQueue.splice(0, this._maxBlurhashPerFrame);

            for (const { canvas, blurHashStr } of batch) {
                // Skip if canvas was detached or image has already arrived in the meantime
                if (!canvas || !canvas.isConnected || canvas.classList.contains('fade-out')) {
                    continue;
                }
                const parent = canvas.parentElement;
                if (parent && parent.querySelector('img.loaded')) {
                    continue;
                }

                // Decoded dimensions are kept extremely small (20x20)
                const width = 20;
                const height = 20;

                const pixels = BlurHashDecoder.decode(blurHashStr, width, height);
                if (!pixels) continue;

                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                if (ctx) {
                    const imgData = ctx.createImageData(width, height);
                    imgData.data.set(pixels);
                    ctx.putImageData(imgData, 0, 0);
                }
            }

            if (this._blurHashQueue.length > 0) {
                requestAnimationFrame(processBatch);
            } else {
                this._blurHashProcessing = false;
            }
        };

        requestAnimationFrame(processBatch);
    }

    /**
     * Handles image load failure by injecting lightweight gradient fallback
     * @param {HTMLElement} img
     */
    _handleImageError(img) {
        // Prevent browser from retrying the broken URL
        const placeholder = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
        img.src = placeholder;
        img.onerror = null;
        img.onload = null;
        img.removeAttribute('data-src');
        img.removeAttribute('data-lazy-loading');
        img.style.display = 'none';

        const parent = img.parentElement;

        // Hide chapter thumbnails completely if loading fails instead of injecting gradient fallback
        if (parent && parent.classList.contains('chapter-row__thumb-wrap')) {
            parent.classList.remove('skeleton-shimmer');
            parent.style.display = 'none';
            return;
        }

        const isSupportedParent =
            parent && (parent.classList.contains('card-image') || parent.classList.contains('queue-row__thumb-wrap'));

        if (isSupportedParent) {
            const mediaLayout = document.documentElement.getAttribute('data-layout-media-rows');
            const isModernOrExpanded =
                mediaLayout === 'modern' || mediaLayout === 'expanded' || mediaLayout === 'modern-posters';

            parent.classList.remove('skeleton-shimmer');

            const overlays = parent.querySelectorAll('.card-overlay-tint, .card-overlay-label, .blurhash-canvas');
            overlays.forEach((el) => el.remove());

            const gradNum = img.dataset.fbGrad;
            const initials = img.dataset.fbInit;
            const name = img.dataset.fbName;

            if (gradNum && initials && name && !parent.querySelector('.media-fallback')) {
                const hideInitials = img.dataset.fbHideInitials === 'true';
                const isLibrary =
                    parent.closest('.library-grid, .library-row, .library-content') !== null ||
                    parent.dataset?.contextType === 'library';
                const showName = isLibrary || hideInitials || !isModernOrExpanded;
                // dataset.* decodes the escaped attribute values back to raw
                // strings — escape again before insertAdjacentHTML.
                const fallbackHtml = `
                    <div class="media-fallback grad-${gradNum}">
                        ${!hideInitials ? `<div class="media-fallback-initials">${escapeHtml(initials)}</div>` : ''}
                        ${showName ? `<div class="media-fallback-name">${escapeHtml(name)}</div>` : ''}
                    </div>
                `;
                parent.insertAdjacentHTML('afterbegin', fallbackHtml);
            }
        }
    }

    /**
     * Forcibly load an image immediately, bypassing IntersectionObserver bounding box checks.
     * Required for GPU hardware-accelerated containers (`translate3d`) where older web engines
     * fail to intersect bounding rects reliably.
     * @param {HTMLElement} img - The image element to load
     * @param {boolean} [forceImmediate=false] - Retained for backward API compatibility
     */
    forceLoad(img, forceImmediate = false) {
        if (!img) return;

        // --------------------------------------------------------------------
        // DIRECT IMAGE PIPELINE
        // Hand off directly to image loader without artificial scroll holds.
        // --------------------------------------------------------------------
        this._loadImage(img);
    }

    /**
     * Helper to batch preload subsequent images in a grid.
     * Loads in staggered chunks to avoid flooding the compositor with
     * simultaneous opacity transitions (each one promotes a GPU layer).
     * @param {HTMLElement} startImg
     * @private
     */
    _batchPreloadImages(startImg) {
        if (!startImg) return;

        // Locate parent media card container for sibling traversal
        const currentCard = startImg.closest('.media-card');
        if (!currentCard) return;

        // ----------------------------------------------------------------
        // STAGGERED PRELOAD: current row, previous row, then next row
        // ----------------------------------------------------------------
        // Reads the grid column count from a data attribute set by
        // LibraryPage._renderGrid(). Falls back to 5 if not present.
        //
        // Phase 1 (immediate, this frame):
        //   columns forward + 1 backward — covers Right in current row
        //   and one Left press. Cost: columns + 1.
        //
        // Phase 2 (next rAF, deferred):
        //   columns - 1 more backward — completes a full previous row
        //   so pressing Up lands on fully-preloaded items.
        //
        // Phase 3 (next rAF after Phase 2, chained):
        //   columns forward — covers the row below for Down navigation.
        // ----------------------------------------------------------------
        const grid = currentCard.closest('#library-grid');
        const columns = parseInt(grid?.dataset.gridColumns, 10) || 7;

        // Phase 1: current row forward + 1 backward (immediate)
        let nextCard = currentCard.nextElementSibling;
        let count = 0;
        while (nextCard && count < columns) {
            const img = nextCard.querySelector('img[data-src]');
            if (img) this._loadImage(img);
            nextCard = nextCard.nextElementSibling;
            count++;
        }

        const prevCard = currentCard.previousElementSibling;
        if (prevCard) {
            const img = prevCard.querySelector('img[data-src]');
            if (img) this._loadImage(img);
        }

        // Helper to load images from a starting sibling, up to `limit` cards
        const loadSiblings = (start, limit, backwards) => {
            let card = start;
            let count = 0;
            while (card && count < limit) {
                const img = card.querySelector('img[data-src]');
                if (img) this._loadImage(img);
                card = backwards ? card.previousElementSibling : card.nextElementSibling;
                count++;
            }
        };

        // Cancel any pending deferred preload from a previous focus change
        // so stale rAFs don't pile up (e.g. rapid D-pad holding).
        if (this._deferredPreloadFrameId) {
            cancelAnimationFrame(this._deferredPreloadFrameId);
            this._deferredPreloadFrameId = null;
        }

        // Schedule deferred phases (chained: Phase 2 -> Phase 3)
        const schedulePhase3 = () => {
            if (nextCard) {
                this._deferredPreloadFrameId = requestAnimationFrame(() => {
                    this._deferredPreloadFrameId = null;
                    loadSiblings(nextCard, columns, false);
                });
            }
        };

        if (prevCard) {
            // Phase 2: complete the previous row
            this._deferredPreloadFrameId = requestAnimationFrame(() => {
                this._deferredPreloadFrameId = null;
                loadSiblings(prevCard.previousElementSibling, columns - 1, true);
                // Chain: Phase 3 runs after Phase 2
                schedulePhase3();
            });
        } else {
            // No previous row, skip straight to Phase 3
            schedulePhase3();
        }
    }

    /**
     * Start observing images in a container
     * @param {HTMLElement} container - functionality scoped to this container
     */
    observe(container) {
        if (!container) return;

        const images = container.querySelectorAll('img[data-src]');

        /*
         * ====================================================================
         * ROW-ALIGNED EAGER INITIAL LOAD
         * ====================================================================
         * Read explicit column count directly from the grid container dataset,
         * or derive safe defaults based on layout class modifiers.
         *
         * Always calculate eager image load counts in complete row multiples.
         * Hardcoded values (e.g. 25 or 27) slice across mid-row boundaries on
         * 4, 5, 7, or 8 column layouts, causing visible half-row loading states.
         * ====================================================================
         */
        const gridCols =
            parseInt(container.dataset.gridColumns, 10) ||
            (container.classList.contains('view-small-poster')
                ? 8
                : container.classList.contains('view-thumb') || container.classList.contains('landscape-grid')
                  ? 4
                  : container.classList.contains('view-list')
                    ? 1
                    : 7);

        // Preload 4 full rows to saturate the initial viewport and forward scroll cushion
        const eagerRows = container.classList.contains('view-list') ? 15 : 4;
        const eagerLoadCount = gridCols * eagerRows;

        for (let i = 0; i < Math.min(images.length, eagerLoadCount); i++) {
            // Force immediate network/cache load for initial visible rows
            this.forceLoad(images[i], true);
        }

        // If no observer (older browser?), we are done.
        // Focus-driven event handler will load the rest as the user navigates.
        if (!this.observer) {
            return;
        }

        images.forEach((img, index) => {
            // Skip eagerly loaded images to avoid observing + loading them twice
            if (index < eagerLoadCount) return;
            if (!img.closest('[data-lazy-row]')) {
                this.observer.observe(img);
            }
        });

        // Observe lazy rows (horizontal scrollers)
        const rows = container.querySelectorAll('[data-lazy-row]');
        rows.forEach((row) => this.observer.observe(row));

        // ====================================================================
        // SHIMMER OBSERVATION: Register all skeleton shimmer wrappers so
        // their CSS animations are paused when scrolled out of viewport.
        // ====================================================================
        if (this._shimmerObserver) {
            const shimmers = container.querySelectorAll('.card-image.skeleton-shimmer');
            shimmers.forEach((el) => this._shimmerObserver.observe(el));
        }
    }

    /**
     * Unobserve all lazy-load elements within a container and clear pending loads.
     * Call this when a component/page is destroyed to prevent stale observer entries.
     * @param {HTMLElement} container
     */
    clearContainer(container) {
        if (!container) return;

        // Cancel any pending deferred preload for the next row
        if (this._deferredPreloadFrameId) {
            cancelAnimationFrame(this._deferredPreloadFrameId);
            this._deferredPreloadFrameId = null;
        }

        // Drop pending marquee measurements targeting DOM inside the torn-down view.
        if (
            this._pendingMarqueeTarget &&
            (this._pendingMarqueeTarget === container ||
                (typeof container.contains === 'function' && container.contains(this._pendingMarqueeTarget)))
        ) {
            this._pendingMarqueeTarget = null;
            this._cancelPostScrollSettleWork();
        }

        // Prune queued elements belonging to the destroyed container so stale DOM
        // references are not retained or loaded after page navigation.
        if (this._pendingElements.length > 0) {
            this._pendingElements = this._pendingElements.filter(
                (el) => el && el !== container && (typeof container.contains !== 'function' || !container.contains(el))
            );
            if (this._pendingElements.length === 0) {
                if (this._pendingFlushTimerId) {
                    clearTimeout(this._pendingFlushTimerId);
                    this._pendingFlushTimerId = null;
                }
                if (this._pendingFlushRafId) {
                    cancelAnimationFrame(this._pendingFlushRafId);
                    this._pendingFlushRafId = null;
                }
            }
        }

        // Prune queued shimmer visibility entries targeting torn-down containers
        if (this._pendingShimmerStates && this._pendingShimmerStates.size > 0) {
            this._pendingShimmerStates.forEach((_, el) => {
                if (!el || el === container || (typeof container.contains === 'function' && container.contains(el))) {
                    this._pendingShimmerStates.delete(el);
                }
            });
        }

        // Resolve any in-flight decode/load settlement promises so navigation away
        // from a page unblocks waitForContainerDecode immediately.
        if (typeof container.querySelectorAll === 'function') {
            const images = container.querySelectorAll('img.lazy, img[data-src]');
            images.forEach((img) => {
                const tracker = this._settleTrackers.get(img);
                if (tracker && !tracker.settled) {
                    tracker.settled = true;
                    tracker.resolve();
                }
                if (this.observer) {
                    this.observer.unobserve(img);
                }
            });
            if (this.observer) {
                const rows = container.querySelectorAll('[data-lazy-row]');
                rows.forEach((row) => this.observer.unobserve(row));
            }
        }

        // Unobserve shimmers tracked by the shimmer observer
        if (this._shimmerObserver) {
            const shimmers = container.querySelectorAll('.card-image.skeleton-shimmer');
            shimmers.forEach((el) => this._shimmerObserver.unobserve(el));
        }
    }

    /**
     * Resolves once all currently initiated images inside a container finish
     * loading + `img.decode()` off-thread, or when `timeoutMs` expires.
     * Used during page boot to let initial below-the-fold rows finish GPU
     * texture upload behind the splash screen without risking startup stalls.
     *
     * @param {HTMLElement} container
     * @param {number} [timeoutMs=650]
     * @returns {Promise<void>}
     */
    waitForContainerDecode(container, timeoutMs = 650) {
        if (!container || typeof container.querySelectorAll !== 'function') {
            return Promise.resolve();
        }

        const images = container.querySelectorAll('img[data-src]');
        const pending = [];
        images.forEach((img) => {
            if (img.classList.contains('loaded')) return;
            const tracker = this._settleTrackers.get(img);
            if (tracker && !tracker.settled) {
                pending.push(tracker.promise);
            }
        });

        if (pending.length === 0) {
            return Promise.resolve();
        }

        const budget = Math.max(0, Number(timeoutMs) || 0);
        if (budget === 0) {
            return Promise.resolve();
        }

        return new Promise((resolve) => {
            let settled = false;
            let timerId = null;
            const finish = () => {
                if (settled) return;
                settled = true;
                if (timerId !== null) {
                    clearTimeout(timerId);
                    timerId = null;
                }
                resolve();
            };

            // Cap splash hold strictly so slow servers never delay interactive reveal
            timerId = setTimeout(finish, budget);
            Promise.all(pending).then(finish, finish);
        });
    }

    /**
     * Observe a specific single element
     * @param {HTMLElement} img
     * @private
     */
    observeElement(img) {
        if (!img || !img.dataset.src || img.classList.contains('loaded')) return;

        if (!this.observer) {
            this.forceLoad(img);
            return;
        }

        this.observer.observe(img);
    }
}

export const lazyLoader = new LazyLoader();
export default lazyLoader;
