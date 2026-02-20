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

// ============================================================================
// Constants — all tunable values in one place for easy TV hardware tweaking
// ============================================================================

// Default animation duration (ms) for vertical smooth scrolling
const SCROLL_DURATION_VERTICAL = 200;

// Animation duration (ms) for horizontal card-centering scrolls
const SCROLL_DURATION_HORIZONTAL = 150;

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
// navigating horizontally within the same row or between tightly packed items
// (e.g. genre header → genre grid within the same .media-row).
const SCROLL_ALIGN_THRESHOLD = 30;

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
// elements taller are bottom-aligned.
const SMALL_ELEMENT_FRACTION = 1 / 3;

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
        // Cached reference to .page-content for fast lookups
        // ====================================================================
        this._pageContent = null;
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

        // Already at target — snap and bail
        if (Math.abs(targetScroll - currentScroll) < SCROLL_SNAP_THRESHOLD) {
            if (isVertical) container.scrollTop = targetScroll;
            else container.scrollLeft = targetScroll;
            return;
        }

        // Create or update animation state for retargeting
        this[stateKey] = {
            container,
            startScroll: currentScroll,
            target: targetScroll,
            startTime: null, // Initialized in first RAF frame
            duration
        };

        // If animation already running, it will pick up the new state
        if (this[animIdKey]) {
            return;
        }

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
        if (!element) return this._pageContent;

        // Check for specific scrollable containers used in modals/filters
        const container = element.closest('.modal-options, .filter-main, .page-content');

        // Cache the main page-content reference if we found it
        if (container && container.classList.contains('page-content')) {
            this._pageContent = container;
        }

        return container || this._pageContent;
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
        this._pageContent = pageContent;

        // Helper: compute element offset relative to a scroll container
        // using getBoundingClientRect for sub-pixel accuracy on Tizen
        const getCumulativeOffsetTop = (el, relativeTo) => {
            if (!el || !relativeTo) return 0;
            const elRect = el.getBoundingClientRect();
            const relRect = relativeTo.getBoundingClientRect();
            return elRect.top - relRect.top + relativeTo.scrollTop;
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

            // Safety: ensure the specific focused element is visible
            // at the computed scroll position (tall row edge case)
            const elTop = getCumulativeOffsetTop(element, pageContent);
            const elBottom = elTop + element.offsetHeight;

            if (elBottom > targetScroll + viewHeight) {
                // Element too far down — bottom-align instead
                targetScroll = elBottom - viewHeight + ROW_CUTOFF_BUFFER;
            }

            targetScroll = Math.max(0, targetScroll);

            // Only scroll if the delta exceeds the alignment threshold.
            // This prevents micro-jitter on horizontal nav within the same row,
            // and avoids unnecessary scrolls between tightly packed items
            // (e.g. genre header → genre grid within the same .media-row).
            if (Math.abs(targetScroll - currentScroll) > SCROLL_ALIGN_THRESHOLD) {
                this.smoothScrollTo(pageContent, targetScroll);
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
                        this.smoothScrollTo(pageContent, Math.max(0, targetScroll));
                    }
                }

                // Then: center the card horizontally within the row
                const elementLeft = element.offsetLeft;
                const elementWidth = element.offsetWidth;
                const containerWidth = rowItems.clientWidth;

                const targetScroll = elementLeft - containerWidth / 2 + elementWidth / 2;
                const finalScrollLeft = Math.max(0, targetScroll);

                // Always use smooth scroll for premium feel
                this.smoothScrollTo(rowItems, finalScrollLeft, SCROLL_DURATION_HORIZONTAL, 'horizontal');
            } else if (activePageContent) {
                // Generic vertical scroll-into-view (grids, lists, tall rows)
                const elementTop = getCumulativeOffsetTop(element, activePageContent);
                const elementHeight = element.offsetHeight;
                const viewHeight = activePageContent.clientHeight;
                const currentScroll = activePageContent.scrollTop;

                // Comfort margins for top and bottom visibility
                const topMargin = GENERIC_SCROLL_MARGIN;
                const bottomMargin = GENERIC_SCROLL_MARGIN;

                let finalScrollTop = currentScroll;

                // Apply custom scroll offset from section config
                const customOffset = config?.scrollOffsetTop || 0;
                const effectiveTopMargin = Math.max(topMargin, customOffset);

                // Element cut off at top
                if (elementTop < currentScroll + effectiveTopMargin) {
                    finalScrollTop = Math.max(0, elementTop - effectiveTopMargin);
                }
                // Element cut off at bottom
                else if (elementTop + elementHeight > currentScroll + viewHeight - bottomMargin) {
                    // Small elements: center them. Large elements: align to bottom.
                    if (elementHeight < viewHeight * SMALL_ELEMENT_FRACTION) {
                        finalScrollTop = elementTop - viewHeight / 2 + elementHeight / 2;
                    } else {
                        finalScrollTop = elementTop + elementHeight - viewHeight + bottomMargin;
                    }
                }

                // Apply vertical scroll with smooth easing
                if (finalScrollTop !== currentScroll) {
                    this.smoothScrollTo(activePageContent, finalScrollTop);
                }
            }
        }
    }

    /**
     * Reset cached DOM references.
     * Should be called when navigating between pages.
     */
    resetCache() {
        this._pageContent = null;
    }
}

// ============================================================================
// Singleton export — one controller shared across the app
// ============================================================================
export const scrollController = new ScrollController();
export default ScrollController;
