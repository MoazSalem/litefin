/**
 * ============================================================================
 * Litefin Tizen - ScrollController
 * ============================================================================
 * Handles all scroll animation and element-into-view positioning for the
 * FocusManager. Owns animation frame state and easing logic.
 *
 * Supports:
 *   - Smooth scrolling with easeOutQuad easing (vertical + horizontal)
 *   - Animation retargeting (updating target mid-animation)
 *   - Row-based vertical alignment (media rows snap to top)
 *   - Horizontal card centering within row-items containers
 *   - Hero section special-case (always scroll to 0)
 *   - Tall-row fallback (element-level scroll-into-view)
 *   - Generic vertical scroll-into-view for grids/lists
 *   - Scroll container discovery (modals, filters, page-content)
 *
 * Extracted from FocusManager to separate animation/positioning from
 * focus coordination.
 * ============================================================================
 */

import { storage } from '../utils/StorageService.js';

// ============================================================================
// Constants — all tunable values in one place for easy TV hardware tweaking
// ============================================================================

// Default animation duration (ms) for vertical smooth scrolling
const SCROLL_DURATION_VERTICAL = 150;

// Animation duration (ms) for horizontal card-centering scrolls
const SCROLL_DURATION_HORIZONTAL = 120;

// Minimum pixel difference to consider "not at target" (avoids sub-pixel jitter)
const SCROLL_SNAP_THRESHOLD = 1;

// Buffer (px) around viewport edges for row visibility cutoff detection.
// Used as a safety margin when bottom-aligning elements in tall rows.
const ROW_CUTOFF_BUFFER = 40;

// Default top offset (px) when aligning a row to the top of the viewport.
// Creates breathing room above the focused row for a premium TV feel.
const DEFAULT_SCROLL_OFFSET_TOP = 50;

// Threshold (px) — if the row's top is already within this distance of
// the ideal scroll position, skip scrolling. Prevents micro-jitter when
// navigating horizontally within the same row, but keep it small so
// vertical transitions always trigger a smooth scroll.
const SCROLL_ALIGN_THRESHOLD = 5;

// Buffer (px) around viewport edges for horizontal row visibility detection.
// Used when scrolling a parent row into view before centering a card.
const HORIZONTAL_ROW_VISIBILITY_BUFFER = 80;

// Comfort margins (px) for generic "scroll into view" in grids and lists.
// Ensures the focused element isn't flush against the viewport edge.
const GENERIC_SCROLL_MARGIN = 100;

// Height multiplier threshold: if a row is taller than viewport * this value,
// row-based alignment is disabled to prevent jarring jumps.
const TALL_ROW_MULTIPLIER = 2.0;

// Fraction of viewport height: elements shorter than this are centered,
// elements taller are bottom-aligned. (Increased to 0.9 so large grid cards center properly)
const SMALL_ELEMENT_FRACTION = 0.9;

// Fraction of viewport height: if a single scroll delta exceeds this fraction,
// snap instantly instead of animating. Hero carousel ↔ row transitions on
// the home page produce 500-750px deltas that exceed the Tizen GPU's compositing
// budget — each intermediate frame must repaint the hero (Ken Burns animation,
// gradient overlays, backdrop layer) AND the content rows (per-row translateZ(0)
// compositor layers), causing visible frame drops. Instant-snapping large deltas
// matches Apple TV's behavior for hero-to-content transitions.
const LARGE_SCROLL_SNAP_FRACTION = 0.45;

class ScrollController {
    constructor() {
        // ====================================================================
        // Animation state — separate for vertical and horizontal
        // Each stores { container, startScroll, target, startTime, duration }
        // ====================================================================
        this._verticalScrollState = null;
        this._horizontalScrollState = null;
        this._verticalScrollAnimationId = null;
        this._horizontalScrollAnimationId = null;

        // ====================================================================
        // PERFORMANCE: offsetTop cache to prevent DOM reflows on every keypress.
        //
        // getCumulativeOffsetTop() walks the offsetParent chain — each step
        // reads .offsetTop and .offsetParent, both of which force a synchronous
        // layout recalculation (reflow) on Tizen's slow CPU.
        //
        // Since media rows don't move within the page, their offsetTop relative
        // to .page-content is stable between keypresses. We cache each row's
        // computed offset in a WeakMap keyed by the row element itself.
        //
        // The cache is cleared on page navigation (resetCache) or when the
        // scroll container changes.
        // ====================================================================
        this._offsetCache = new WeakMap();
    }

    // ========================================================================
    // Public API
    // ========================================================================

    /**
     * Smooth scroll with easeOutQuad easing and retarget support.
     *
     * Uses a time-based animation with proper easing curve.
     * If called again while an animation is in progress for the same
     * direction, the target is updated and timing resets from the
     * current position (retargeting), avoiding jarring jumps.
     *
     * @param {HTMLElement} container - The scrollable container element
     * @param {number} targetScroll - Target scroll position in px
     * @param {number} [duration=200] - Animation duration in ms
     * @param {'vertical'|'horizontal'} [direction='vertical'] - Scroll axis
     */
    smoothScrollTo(container, targetScroll, duration = SCROLL_DURATION_VERTICAL, direction = 'vertical') {
        const isVertical = direction === 'vertical';
        const stateKey = isVertical ? '_verticalScrollState' : '_horizontalScrollState';
        const animIdKey = isVertical ? '_verticalScrollAnimationId' : '_horizontalScrollAnimationId';

        const currentScroll = isVertical ? container.scrollTop : container.scrollLeft;

        // Already at target or instant scroll requested — snap and bail.
        // CRITICAL: Cancel any running animation in this axis BEFORE snapping.
        // If we don't, the RAF loop from a previous smooth scroll fires again
        // on the very next frame and sets scrollTop back to its old in-progress
        // target, causing a single-frame jump (the jitter the user sees).
        if (duration <= 0 || Math.abs(targetScroll - currentScroll) < SCROLL_SNAP_THRESHOLD) {
            if (this[animIdKey]) {
                cancelAnimationFrame(this[animIdKey]);
                this[animIdKey] = null;
                this[stateKey] = null;
            }
            if (isVertical) {
                container.scrollTop = targetScroll;
                // STABILIZATION: Force reset of horizontal drift on vertical containers.
                // Browsers may auto-scroll the page container
                // horizontally if a focused element is centered via justify-content but
                // perceived as overflowing. Forcing scrollLeft=0 here ensures the UI
                // remains perfectly pinned to the left edge.
                if (container.scrollLeft !== 0) {
                    container.scrollLeft = 0;
                }
            } else {
                container.scrollLeft = targetScroll;
            }
            return;
        }

        // ----------------------------------------------------------------
        // RETARGETING LOGIC (The "Zeno's Paradox" Fix)
        // ----------------------------------------------------------------
        // If an animation is already running for this axis, check if the
        // new target is exactly the same as the current target.
        // If it's the same, DO NOT touch the startTime or startScroll. Just
        // return early and let the existing animation finish organically.
        // Re-assigning startScroll to the current mid-animation position and
        // resetting startTime to 'now' causes the velocity to drop to 0 and
        // the remaining distance to stretch out, creating a slow crawl if
        // the user rapidly taps keys (e.g. moving horizontally along a row).
        if (this[stateKey] && this[animIdKey]) {
            if (Math.abs(this[stateKey].target - targetScroll) < SCROLL_SNAP_THRESHOLD) {
                // Target is unchanged, do nothing, let existing animation complete
                return;
            } else {
                // The target HAS changed (e.g. the user pressed Down while mid-scroll).
                // Scale the duration proportionally to the *remaining* distance — otherwise
                // redirecting to a target that's only 50px away from the current position
                // would still take the full 200ms, making it feel sluggish.
                const remainingDistance = Math.abs(targetScroll - currentScroll);
                const originalDistance = Math.abs(targetScroll - this[stateKey].startScroll) || 1;
                const scaledDuration = Math.round(duration * Math.min(remainingDistance / originalDistance, 1));

                this[stateKey].startScroll = currentScroll;
                this[stateKey].target = targetScroll;
                this[stateKey].startTime = null; // Will reset on next RAF
                this[stateKey].duration = Math.max(50, scaledDuration); // Enforce 50ms minimum
                return;
            }
        }

        // Create new animation state
        this[stateKey] = {
            container,
            startScroll: currentScroll,
            target: targetScroll,
            startTime: null, // Initialized in first RAF frame
            duration
        };

        // easeOutQuad: fast start, smooth deceleration (t * (2 - t))
        const easeOutQuad = (t) => t * (2 - t);

        // Animation loop
        const animate = (time) => {
            const state = this[stateKey];
            if (!state) return;

            // Initialize startTime on the first actual frame if not set
            if (!state.startTime) {
                state.startTime = time;
            }

            const elapsed = time - state.startTime;
            const progress = Math.min(elapsed / state.duration, 1);
            const eased = easeOutQuad(progress);

            // Interpolate between start and target
            const distance = state.target - state.startScroll;
            const newScroll = state.startScroll + distance * eased;

            // Apply scroll position (Layout-triggering, but unavoidable without transform scroll)
            if (isVertical) {
                state.container.scrollTop = newScroll;
                // STABILIZATION: Prevent horizontal drift on vertical containers.
                // Ensures the page doesn't accidentally scroll horizontally during vertical animation.
                if (state.container.scrollLeft !== 0) {
                    state.container.scrollLeft = 0;
                }
            } else {
                state.container.scrollLeft = newScroll;
            }

            if (progress < 1) {
                // Continue animation
                this[animIdKey] = requestAnimationFrame(animate);
            } else {
                // Snap to exact target and clean up
                if (isVertical) {
                    state.container.scrollTop = state.target;
                } else {
                    state.container.scrollLeft = state.target;
                }
                this[animIdKey] = null;
                this[stateKey] = null;
            }
        };

        // Note: For the very first frame, we don't have a 'time' yet,
        // so we let the animate function initialize it.
        this[animIdKey] = requestAnimationFrame(animate);
    }

    /**
     * Cancel an active scroll animation.
     * @param {'vertical'|'horizontal'} [direction='vertical'] - Which axis to cancel
     */
    cancelAnimation(direction = 'vertical') {
        if (direction === 'vertical') {
            if (this._verticalScrollAnimationId) {
                cancelAnimationFrame(this._verticalScrollAnimationId);
                this._verticalScrollAnimationId = null;
            }
            this._verticalScrollState = null;
        } else {
            if (this._horizontalScrollAnimationId) {
                cancelAnimationFrame(this._horizontalScrollAnimationId);
                this._horizontalScrollAnimationId = null;
            }
            this._horizontalScrollState = null;
        }
    }

    /**
     * Find the nearest scrollable parent for an element.
     * Searches for known scroll containers (.modal-options, .filter-main,
     * .page-content) and caches the .page-content reference for performance.
     *
     * @param {HTMLElement} element - Element to find scroll container for
     * @returns {HTMLElement|null} The scrollable container, or null
     */
    getScrollContainer(element) {
        if (!element) return null;

        // Check for specific scrollable containers used in modals/filters
        const container = element.closest(
            '.modal-options, .filter-main, .page-content, .settings-sidebar, .sidebar-libraries-wrapper'
        );

        return container;
    }

    /**
     * Scroll an element into view with intelligent positioning.
     *
     * Handles multiple scroll strategies:
     *   - Row-based vertical: ALWAYS aligns the parent .media-row to the
     *     top with a configurable offset (default 50px), guarded by a
     *     threshold to prevent jitter on horizontal nav within the same row.
     *   - Hero section: Always scrolls to absolute 0.
     *   - Horizontal: Centers the element within its .row-items container.
     *   - Generic vertical: Simple scroll-into-view with margins for
     *     grids, lists, or containers without .media-row structure.
     *
     * @param {HTMLElement} element - The element to scroll into view
     * @param {Object} [config] - Section config from FocusManager
     * @param {number} [config.scrollOffsetTop=0] - Custom top offset
     * @param {Object} [options] - Scroll options
     * @param {boolean} [options.scroll=true] - Whether to scroll at all
     * @param {boolean} [options.skipScroll=false] - Skip scroll entirely
     */
    scrollIntoView(element, config = {}, options = {}) {
        // Resolve the scroll container for this element
        const pageContent = this.getScrollContainer(element);

        // Helper: compute element offset relative to a scroll container
        // using offsetTop to remain immune to actively animating scroll positions.
        //
        // PERFORMANCE RULES FOR CACHING:
        //
        //   ✓ CACHE stable elements (e.g. .media-row): their offsetTop within
        //     .page-content is fixed for the page lifetime — safe to cache.
        //
        //   ✗ DO NOT cache card elements inside .row-items-track:
        //     - The track uses CSS transform: translate3d(), which breaks the
        //       offsetParent chain before reaching .page-content.
        //     - The fallback path uses getBoundingClientRect(), which is
        //       scroll-relative — its value changes as the page scrolls.
        //     - Caching a scroll-relative BoundingRect value poisons the cache
        //       with a stale number that causes wrong scroll targets on the next keypress.
        //     - VirtualCardRow also reuses/repositions DOM nodes, so the same
        //       element key can represent a different card on the next window update.
        const getCumulativeOffsetTop = (el, relativeTo) => {
            if (!el || !relativeTo) return 0;

            // Check cache first — avoid reflow if already computed for this element
            const cached = this._offsetCache.get(el);
            if (cached !== undefined && cached.container === relativeTo) {
                return cached.value;
            }

            let top = 0;
            let current = el;

            while (current && current !== relativeTo && current !== document.body) {
                top += current.offsetTop || 0;
                current = current.offsetParent;
            }

            if (current === relativeTo) {
                this._offsetCache.set(el, { container: relativeTo, value: top });
            } else {
                // Fallback: the chain broke early (e.g. CSS transform on an ancestor
                // or a fixed-position portal). Use getBoundingClientRect as a last resort.
                //
                // IMPORTANT: getBoundingClientRect() is SCROLL-RELATIVE — it includes
                // the container's current scrollTop in its result. This means the value
                // will be WRONG if the page scrolls between compute and use.
                // We compensate by adding scrollTop, but we CANNOT cache this result
                // because the effective scrollTop used at computation time won't match
                // the scrollTop at the next call site.
                const elRect = el.getBoundingClientRect();
                const relRect = relativeTo.getBoundingClientRect();
                top = elRect.top - relRect.top + relativeTo.scrollTop;
                // NOT cached — value is volatile
            }

            return top;
        };

        // ----------------------------------------------------------------
        // Determine if we should use row-based vertical scrolling
        // Row scroll aligns the entire .media-row to a top offset
        // ----------------------------------------------------------------
        const row = pageContent ? element.closest('.media-row') : null;
        let useRowScroll = !!row;
        let activePageContent = pageContent; // May be nulled for hero

        if (useRowScroll) {
            // HERO EXCEPTION: Hero sections always snap to scroll position 0
            const isHero = row.classList.contains('details-main-split');

            if (isHero) {
                // Force scroll to absolute top for hero sections
                if (pageContent.scrollTop > 0) {
                    this.smoothScrollTo(pageContent, 0);
                }
                // Disable further row logic and generic vertical scroll
                useRowScroll = false;
                activePageContent = null;
            }
            // TALL ROW EXCEPTION: If the row is much taller than the viewport,
            // disable row-alignment to prevent jarring jumps.
            else if (row.offsetHeight > pageContent.clientHeight * TALL_ROW_MULTIPLIER) {
                useRowScroll = false;
            }
            // GRID EXCEPTION: If the row contains a wrap-grid (like Season episodes),
            // row-based snapping will fail spectacularly on deep navigation.
            else if (row.querySelector('.person-grid')) {
                useRowScroll = false;
            }
        }

        // ----------------------------------------------------------------
        // Row-based vertical scrolling — ALWAYS ALIGN TO TOP
        // On every focus change, we target the ideal top-aligned position
        // for the parent .media-row. This produces many small, smooth
        // scrolls instead of rare, jarring large jumps — critical for
        // performance on slow Tizen hardware.
        //
        // A threshold (SCROLL_ALIGN_THRESHOLD) prevents micro-jitter when
        // navigating horizontally within the same row or between tightly
        // packed items (e.g. genre header → genre grid in the same row).
        // ----------------------------------------------------------------
        if (useRowScroll && row) {
            // Batch all DOM reads first (Samsung Tizen optimization)
            const rowTop = getCumulativeOffsetTop(row, pageContent);
            const padding = config.scrollOffsetTop || DEFAULT_SCROLL_OFFSET_TOP;
            const viewHeight = pageContent.clientHeight;
            const currentScroll = pageContent.scrollTop;

            // Ideal target: row top sits at the configured offset from viewport top
            let targetScroll = rowTop - padding;

            // Safety check: ensure the specific focused element is actually visible
            // at the computed scroll position. Handles tall-row edge cases where the
            // focused item might be below the visible area at the row-aligned position.
            //
            // OPTIMIZATION: Skip this check for VirtualCardRow items (detected via
            // data-virtual-index). Cards managed by VirtualCardRow are ALWAYS within
            // the visible window — the row guarantees this on every navigation.
            // The getCumulativeOffsetTop() for a card inside the track always falls
            // through to the getBoundingClientRect() fallback path (CSS transform on
            // the track breaks the offsetParent chain), which is scroll-relative and
            // forces a synchronous layout on every keypress. Skipping it for
            // virtual cards eliminates 2 forced layout flushes per navigation.
            const isVirtualCard = element.dataset && element.dataset.virtualIndex !== undefined;
            if (!isVirtualCard) {
                const elTop = getCumulativeOffsetTop(element, pageContent);
                const elBottom = elTop + element.offsetHeight;

                if (elBottom > targetScroll + viewHeight) {
                    // Element too far down — bottom-align instead
                    targetScroll = elBottom - viewHeight + ROW_CUTOFF_BUFFER;
                }
            }

            targetScroll = Math.max(0, targetScroll);

            // Only scroll if the delta exceeds the alignment threshold.
            // This prevents micro-jitter on horizontal nav within the same row,
            // and avoids unnecessary scrolls between tightly packed items
            // (e.g. genre header → genre grid within the same .media-row).
            const scrollDelta = Math.abs(targetScroll - currentScroll);
            if (scrollDelta > SCROLL_ALIGN_THRESHOLD) {
                // PERFORMANCE: For scroll distances exceeding ~45% of the viewport
                // (e.g. hero carousel ↔ first content row), snap instantly. The
                // Tizen compositor can't smoothly animate 500+ pixel scrolls without
                // dropping frames. Normal row-to-row deltas (~250px) remain smooth.
                // This is optional and controlled by pref:snapLargeScrolls.
                const snapEnabled = storage.getItem('pref:snapLargeScrolls') === 'true';
                const forceInstant = snapEnabled && scrollDelta > viewHeight * LARGE_SCROLL_SNAP_FRACTION;
                this.smoothScrollTo(
                    pageContent,
                    targetScroll,
                    options.instantScroll || forceInstant ? 0 : SCROLL_DURATION_VERTICAL
                );
            }
        }

        // ----------------------------------------------------------------
        // Horizontal card centering + fallback vertical scroll
        // Runs independently of row-based vertical alignment
        // ----------------------------------------------------------------
        if (options.scroll !== false) {
            const rowItems = element.closest('.row-items');

            if (rowItems) {
                // First: scroll the parent row into view vertically if needed
                // (only if not already handled by row-based scroll above)
                const parentRow = element.closest('.media-row');
                if (parentRow && pageContent && !useRowScroll) {
                    const rowTop = getCumulativeOffsetTop(parentRow, pageContent);
                    const rowHeight = parentRow.offsetHeight;
                    const rowBottom = rowTop + rowHeight;
                    const viewHeight = pageContent.clientHeight;
                    const currentScroll = pageContent.scrollTop;
                    const viewBottom = currentScroll + viewHeight;

                    // Check if row is outside viewport with buffers
                    if (
                        rowTop < currentScroll + HORIZONTAL_ROW_VISIBILITY_BUFFER ||
                        rowBottom > viewBottom - HORIZONTAL_ROW_VISIBILITY_BUFFER
                    ) {
                        // Center the row vertically
                        const targetScroll = rowTop - viewHeight / 2 + rowHeight / 2;
                        this.smoothScrollTo(
                            pageContent,
                            Math.max(0, targetScroll),
                            options.instantScroll ? 0 : SCROLL_DURATION_VERTICAL
                        );
                    }
                }

                // Then: center the card horizontally within the row
                const track = rowItems.querySelector('.row-items-track');

                if (track) {
                    const isRtl = document.documentElement.dir === 'rtl';

                    let elementPos;
                    let elementWidth;
                    const containerWidth = rowItems.clientWidth; // Read early before layout dirts
                    let trackWidth;

                    if (track.__virtualRow) {
                        const vIndex = parseInt(element.dataset.virtualIndex || '0', 10);
                        elementPos = track.__virtualRow.getItemPosition(vIndex);
                        
                        // -----------------------------------------------------------------
                        // Mathematical Centering Sync (Expanded Posters)
                        // -----------------------------------------------------------------
                        // Just like in VirtualCardRow.js scrollToIndex(), if we are in
                        // the modern layout and the card can expand, we center it based on
                        // its EXPANDED width (600px). This centers the active expanded poster
                        // cleanly inside the viewport, preventing the right edge from clipping.
                        // -----------------------------------------------------------------
                        const isModern = document.documentElement.getAttribute('data-layout') === 'modern';
                        const canExpand = isModern && !track.__virtualRow.isLandscape && track.__virtualRow.cardType !== 'square' && track.__virtualRow.cardType !== 'artist';
                        
                        elementWidth = canExpand ? 600 : track.__virtualRow.itemWidth;
                        trackWidth = track.__virtualRow.getTrackWidth();
                    } else {
                        if (isRtl) {
                            elementPos = parseInt(element.style.right || '0', 10);
                        } else {
                            elementPos = element.offsetLeft;
                        }
                        elementWidth = element.offsetWidth;
                        trackWidth = track.scrollWidth;
                    }

                    // Ideal scroll to center the card
                    const targetScroll = elementPos - containerWidth / 2 + elementWidth / 2;

                    // Clamp to the start and end bounds
                    const maxScroll = Math.max(0, trackWidth - containerWidth);

                    // STABILIZATION: Only trigger horizontal centering if the track is actually
                    // wider than the container. For short rows (e.g. Suggestions with 1-2 items)
                    // that already fit on screen, any translate3d shift is unnecessary and
                    // can cause visible jitter or sub-pixel blurring.
                    if (trackWidth > containerWidth) {
                        const finalScrollLeft = Math.max(0, Math.min(targetScroll, maxScroll));

                        // Use completely hardware-accelerated CSS transform!
                        if (options.instantScroll) {
                            // OPTIMIZATION: Parse the current transform to check if we're already
                            // at the target position. This skips the forced-layout reflow path
                            // entirely when navigating vertically (the card is already centered).
                            // track.offsetHeight is a synchronous layout and is expensive on Tizen.
                            const currentTransform = track.style.transform || track.style.webkitTransform || '';
                            const match = currentTransform.match(/translate3d\(\s*-?([\d.]+)px/);
                            const currentTransformX = match ? parseFloat(match[1]) : 0;
                            const alreadyCentered =
                                Math.abs(currentTransformX - finalScrollLeft) < SCROLL_SNAP_THRESHOLD;

                            if (!alreadyCentered) {
                                // Bypass CSS transitions for instant snap.
                                // IMPORTANT: We must NOT read track.offsetHeight here to force a reflow —
                                // that is a synchronous layout flush that stalls the Tizen compositor on
                                // every row entry. Instead, toggle transition off, write the transform,
                                // and restore transition asynchronously on the next frame once the
                                // browser has committed the no-transition paint.
                                track.style.transition = 'none';
                                track.style.webkitTransition = 'none';
                                if (isRtl) {
                                    track.style.webkitTransform = `translate3d(${finalScrollLeft}px, 0, 0)`;
                                    track.style.transform = `translate3d(${finalScrollLeft}px, 0, 0)`;
                                } else {
                                    track.style.webkitTransform = `translate3d(-${finalScrollLeft}px, 0, 0)`;
                                    track.style.transform = `translate3d(-${finalScrollLeft}px, 0, 0)`;
                                }
                                // Restore transition property on the next frame (after the browser
                                // has committed the transform snap) — zero layout reads needed.
                                requestAnimationFrame(() => {
                                    track.style.webkitTransition = '';
                                    track.style.transition = '';
                                });
                            }
                        } else {
                            // Same position check for the smooth (CSS transition) path.
                            // .row-items-track has a 150ms CSS transition on transform — writing
                            // the same value triggers a useless animated "wobble" on every vertical
                            // row-enter even though the horizontal position hasn't changed at all.
                            const currentTransform = track.style.transform || track.style.webkitTransform || '';
                            const match = currentTransform.match(/translate3d\(\s*-?([\d.]+)px/);
                            const currentTransformX = match ? parseFloat(match[1]) : 0;
                            if (Math.abs(currentTransformX - finalScrollLeft) >= SCROLL_SNAP_THRESHOLD) {
                                if (isRtl) {
                                    // In RTL, moving track right reveals further elements on the left
                                    track.style.webkitTransform = `translate3d(${finalScrollLeft}px, 0, 0)`;
                                    track.style.transform = `translate3d(${finalScrollLeft}px, 0, 0)`;
                                } else {
                                    track.style.webkitTransform = `translate3d(-${finalScrollLeft}px, 0, 0)`;
                                    track.style.transform = `translate3d(-${finalScrollLeft}px, 0, 0)`;
                                }
                            }
                        }
                    } else {
                        // For short rows, ensure the track is reset to 0 to prevent stale
                        // offsets if items were removed or the window was resized.
                        track.style.webkitTransform = 'translate3d(0, 0, 0)';
                        track.style.transform = 'translate3d(0, 0, 0)';
                    }
                } else {
                    // Fallback for native horizontal scrolls
                    const elementLeft = element.offsetLeft;
                    const elementWidth = element.offsetWidth;
                    const containerWidth = rowItems.clientWidth;

                    const targetScroll = elementLeft - containerWidth / 2 + elementWidth / 2;
                    const finalScrollLeft = Math.max(0, targetScroll);

                    this.smoothScrollTo(
                        rowItems,
                        finalScrollLeft,
                        options.instantScroll ? 0 : SCROLL_DURATION_HORIZONTAL,
                        'horizontal'
                    );
                }
            } else if (activePageContent) {
                // Generic vertical scroll-into-view (grids, lists, tall rows)
                const elementTop = getCumulativeOffsetTop(element, activePageContent);
                const elementHeight = element.offsetHeight;
                const viewHeight = activePageContent.clientHeight;
                const currentScroll = activePageContent.scrollTop;

                // Comfort margins for top and bottom visibility
                const topMargin = GENERIC_SCROLL_MARGIN;
                let bottomMargin = GENERIC_SCROLL_MARGIN;

                let finalScrollTop = currentScroll;

                // Apply custom scroll offset from section config
                const customOffset = config?.scrollOffsetTop || 0;
                let effectiveTopMargin = Math.max(topMargin, customOffset);

                // PREVENT JITTER: If the element and its margins don't completely fit in the viewport
                // together, the top and bottom edge guards will fight each other on every horizontal move.
                // We shrink the margins proportionally to fit.
                if (elementHeight + effectiveTopMargin + bottomMargin > viewHeight) {
                    const availableSpace = Math.max(0, viewHeight - elementHeight);
                    // Distribute available space evenly as maximum allowable margins
                    effectiveTopMargin = Math.min(effectiveTopMargin, availableSpace / 2);
                    bottomMargin = Math.min(bottomMargin, availableSpace / 2);
                }

                // Element cut off at top
                if (elementTop < currentScroll + effectiveTopMargin) {
                    finalScrollTop = Math.max(0, elementTop - effectiveTopMargin);
                }
                // Element cut off at bottom
                else if (elementTop + elementHeight > currentScroll + viewHeight - bottomMargin) {
                    // Small elements: center them nicely. Extremely huge elements: align to bottom edge.
                    if (elementHeight < viewHeight * SMALL_ELEMENT_FRACTION) {
                        finalScrollTop = elementTop - viewHeight / 2 + elementHeight / 2;
                    } else {
                        finalScrollTop = elementTop + elementHeight - viewHeight + bottomMargin;
                    }
                }

                // Apply vertical scroll with smooth easing
                const scrollDelta = Math.abs(finalScrollTop - currentScroll);
                if (scrollDelta > SCROLL_SNAP_THRESHOLD) {
                    // PERFORMANCE: Large vertical jumps (e.g. returning to the hero
                    // carousel from a scrolled position) snap instantly to avoid
                    // GPU-induced frame drops on Tizen hardware.
                    const snapEnabled = storage.getItem('pref:snapLargeScrolls') === 'true';
                    const forceInstant = snapEnabled && scrollDelta > viewHeight * LARGE_SCROLL_SNAP_FRACTION;
                    this.smoothScrollTo(
                        activePageContent,
                        finalScrollTop,
                        options.instantScroll || forceInstant ? 0 : SCROLL_DURATION_VERTICAL
                    );
                }
            }
        }
    }

    /**
     * Reset cached DOM references.
     * Should be called when navigating between pages.
     */
    resetCache() {
        // Clear the offsetTop cache so stale row positions don't persist
        // across page navigations (rows on the new page have different offsets).
        this._offsetCache = new WeakMap();
    }

    /**
     * Pre-populate the _offsetCache for a list of elements in a single pass.
     *
     * Call this once after the page DOM is stable (e.g. inside the initial
     * requestAnimationFrame after content is rendered). This batches all
     * offsetTop reads into the layout flush that is already required for
     * focus restoration, so the reads are essentially free. Every subsequent
     * keypress that queries getCumulativeOffsetTop for these elements will be
     * a pure O(1) WeakMap hit with no forced layout at all.
     *
     * @param {NodeList|Array} elements - Elements to pre-cache (e.g. all .media-row)
     * @param {HTMLElement} relativeTo - The scroll container (e.g. .page-content)
     */
    prewarmOffsetCache(elements, relativeTo) {
        if (!relativeTo) return;

        // Batch read all offsetTops — every read forces layout once (the browser
        // computes the entire layout tree in one shot for the first read, then
        // serves subsequent reads from the cached layout result).
        for (let i = 0; i < elements.length; i++) {
            const el = elements[i];
            if (!el || this._offsetCache.has(el)) continue; // Skip if already cached

            let top = 0;
            let current = el;

            while (current && current !== relativeTo && current !== document.body) {
                top += current.offsetTop || 0;
                current = current.offsetParent;
            }

            // Only cache if the chain successfully reached the scroll container
            if (current === relativeTo) {
                this._offsetCache.set(el, { container: relativeTo, value: top });
            }
        }
    }
}

// ============================================================================
// Singleton export — one controller shared across the app
// ============================================================================
export const scrollController = new ScrollController();
export default ScrollController;
