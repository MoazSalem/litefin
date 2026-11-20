/**
 * ============================================================================
 * Litefin Tizen - SpatialNavigator
 * ============================================================================
 * Stateless utility for directional spatial navigation math.
 * Given a currently-focused element and a list of candidates, determines
 * which element should receive focus next based on direction, distance,
 * and alignment scoring.
 *
 * This is a pure-math module — no DOM mutation, no side effects, no state.
 * Reads element positions via getBoundingClientRect() for sub-pixel accuracy.
 *
 * Extracted from FocusManager to separate navigation math from coordination.
 * ============================================================================
 */

// ============================================================================
// Constants
// ============================================================================

// Minimum pixel displacement in the primary axis before a candidate
// is considered "in the right direction". Prevents sub-pixel jitter
// from making up/down select elements in the same row.
const DIRECTION_THRESHOLD = 10;

// Cross-axis penalty multiplier.
// Higher values make the algorithm prefer candidates that are well-aligned
// (same column for up/down, same row for left/right) over closer but
// misaligned candidates.
const CROSS_AXIS_WEIGHT = 3.0;

// Minimum overlap (px) required on the cross-axis before elements are
// considered "aligned" (zeroing the cross-axis penalty).
// This prevents the 1.05x focus scale (which adds ~7.5px bleed) from
// tricking the navigator into thinking neighboring rows/columns are aligned.
const MIN_OVERLAP_THRESHOLD = 20;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * 💡 Focus Engine Row Analyzer Helper
 * ----------------------------------------------------------------------------
 * Counts the active focusable elements inside a settings container (.setting-item).
 *
 * Performance Check:
 * To avoid triggering forced layouts (layout thrashing) on TV hardware, this
 * helper relies strictly on DOM-tree lookups (querySelectorAll) and fast,
 * non-reflowing string checks (display properties, class list, and HTML attributes).
 *
 * @param {HTMLElement} row - The settings item parent container
 * @returns {number} The count of active, visible focusable controls
 */
const getFocusableCountInRow = (row) => {
    // Return early if row is invalid
    if (!row) return 0;

    // Leverage identical selector query used by main FocusManager architecture
    const selector = 'a, button, input, select, [tabindex]:not([tabindex="-1"])';
    const focusables = row.querySelectorAll(selector);

    let count = 0;
    for (let i = 0; i < focusables.length; i++) {
        const el = focusables[i];

        // Skip natively disabled elements (e.g. disabled buttons)
        if (el.disabled) continue;

        // Skip elements hidden via inline styles
        if (el.style.display === 'none') continue;

        // Skip elements marked hidden via common utility classes
        if (el.classList.contains('hidden')) continue;

        // Skip elements with structural HTML hidden attributes
        if (el.hasAttribute('hidden')) continue;

        count++;
    }

    return count;
};

class SpatialNavigator {
    constructor() {
        /**
         * Cached candidate geometry relative to section containers.
         * Maps container HTMLElement -> WeakMap<HTMLElement, { relLeft, relTop, width, height }>
         * @type {WeakMap<HTMLElement, WeakMap<HTMLElement, Object>>}
         * @private
         */
        this._cache = new WeakMap();
    }

    /**
     * Clears cached layout metrics for a specific container or all containers.
     * @param {HTMLElement} [container=null] Section container element to clear
     */
    clearCache(container = null) {
        if (container) {
            this._cache.delete(container);
        } else {
            this._cache = new WeakMap();
        }
    }

    /**
     * Computes or retrieves cached layout coordinates for the active/origin element.
     * When relative metrics are present in the container cache, uses container geometry
     * plus relative offsets to compute client bounding rect without triggering a layout reflow.
     * @private
     */
    _getCurrentRect(current, container) {
        // Fall back directly to native measurement if no valid container was passed
        if (!container || typeof container.getBoundingClientRect !== 'function') {
            return current.getBoundingClientRect();
        }

        // Cross-section origin elements (e.g. sidebar -> content via findClosest) do not
        // scroll with container.scrollTop, so never cache or project them relative to container.
        if (typeof container.contains === 'function' && !container.contains(current)) {
            return current.getBoundingClientRect();
        }

        // Check if layout metrics relative to container were previously cached
        let containerMap = this._cache.get(container);
        if (containerMap && containerMap.has(current)) {
            const metrics = containerMap.get(current);

            // Read container geometry once and offset by its current scroll position
            const cRect = container.getBoundingClientRect();
            const scrollLeft = container.scrollLeft || 0;
            const scrollTop = container.scrollTop || 0;

            // Derive actual client coordinates via invariant container-relative offsets
            const left = cRect.left + metrics.relLeft - scrollLeft;
            const top = cRect.top + metrics.relTop - scrollTop;

            return {
                left,
                top,
                right: left + metrics.width,
                bottom: top + metrics.height,
                width: metrics.width,
                height: metrics.height
            };
        }

        // Initialize the container map on first entry so initial origin elements
        // are cached right away instead of missing on the second D-pad step.
        if (!containerMap) {
            containerMap = new WeakMap();
            this._cache.set(container, containerMap);
        }

        // Measure directly on cache miss and record relative position
        const r = current.getBoundingClientRect();
        const cRect = container.getBoundingClientRect();
        const scrollLeft = container.scrollLeft || 0;
        const scrollTop = container.scrollTop || 0;

        // Cache position relative to container's scroll canvas
        containerMap.set(current, {
            relLeft: r.left - cRect.left + scrollLeft,
            relTop: r.top - cRect.top + scrollTop,
            width: r.width,
            height: r.height
        });
        return r;
    }

    /**
     * Gathers and converts candidate element positions using container-relative caching.
     * On initial entry into a section, records offsets relative to container; subsequent
     * D-pad steps perform pure offset calculations, eliminating dozens of getBoundingClientRect reflows.
     * @private
     */
    _getCandidateData(candidates, current, container) {
        // Fall back to synchronous getBoundingClientRect reads if container is unavailable
        if (!container || typeof container.getBoundingClientRect !== 'function') {
            const candidateData = [];
            for (let i = 0; i < candidates.length; i++) {
                const el = candidates[i];
                if (el === current) continue;

                // Synchronously read candidate bounds
                const r = el.getBoundingClientRect();
                candidateData.push({
                    el,
                    rect: r,
                    cx: r.left + r.width / 2,
                    cy: r.top + r.height / 2
                });
            }
            return candidateData;
        }

        // Locate or initialize the relative metrics cache for this container
        let containerMap = this._cache.get(container);
        if (!containerMap) {
            containerMap = new WeakMap();
            this._cache.set(container, containerMap);
        }

        // Measure container bounding rect once per navigation step
        const cRect = container.getBoundingClientRect();
        const scrollLeft = container.scrollLeft || 0;
        const scrollTop = container.scrollTop || 0;

        const candidateData = [];
        for (let i = 0; i < candidates.length; i++) {
            const el = candidates[i];
            if (el === current) continue;

            // Retrieve cached relative metrics or calculate them on first touch
            let metrics = containerMap.get(el);
            if (!metrics) {
                const r = el.getBoundingClientRect();

                // Compute relative offsets invariant to subsequent container scrolling
                metrics = {
                    relLeft: r.left - cRect.left + scrollLeft,
                    relTop: r.top - cRect.top + scrollTop,
                    width: r.width,
                    height: r.height
                };
                containerMap.set(el, metrics);
            }

            // Project relative coordinates to active viewport coordinates
            const left = cRect.left + metrics.relLeft - scrollLeft;
            const top = cRect.top + metrics.relTop - scrollTop;
            const rect = {
                left,
                top,
                right: left + metrics.width,
                bottom: top + metrics.height,
                width: metrics.width,
                height: metrics.height
            };

            // Calculate center points for directional distance calculations
            candidateData.push({
                el,
                rect,
                cx: left + metrics.width / 2,
                cy: top + metrics.height / 2
            });
        }

        return candidateData;
    }

    // ========================================================================
    // Public API
    // ========================================================================

    /**
     * Find the best candidate element in a given direction.
     *
     * Algorithm:
     *   1. For each candidate, compute center-to-center vector from `current`.
     *   2. Filter out candidates that aren't in the requested direction
     *      (using a threshold to ignore sub-pixel jitter).
     *   3. Score remaining candidates: distMain + distCross * 3.0
     *      If the candidate overlaps the current element on the cross-axis,
     *      the cross penalty is zeroed (they're "aligned").
     *   4. Return the candidate with the lowest score.
     *
     * @param {HTMLElement} current - Currently focused element
     * @param {HTMLElement[]} candidates - All focusable elements in the section
     * @param {'up'|'down'|'left'|'right'} direction - Navigation direction
     * @param {HTMLElement} [container=null] - Optional parent section container for relative rect caching
     * @returns {HTMLElement|null} Best candidate, or null if none found
     */
    findNext(current, candidates, direction, container = null) {
        // Compute reference coordinates for currently focused element
        const rect1 = this._getCurrentRect(current, container);
        const center1x = rect1.left + rect1.width / 2;
        const center1y = rect1.top + rect1.height / 2;

        // Batch-resolve candidate coordinates using cached container metrics where available
        const candidateData = this._getCandidateData(candidates, current, container);

        // Pre-compute focusable count for the current row once outside the candidate loop
        const row1 = current.closest ? current.closest('.setting-item') : null;
        const count1 = row1 ? getFocusableCountInRow(row1) : 0;
        const rowCountMap = new Map();

        // ====================================================================
        // Scoring loop — pure math on pre-read data, zero DOM access
        // ====================================================================
        let bestCandidate = null;
        let minScore = Infinity;

        for (let i = 0; i < candidateData.length; i++) {
            const { el, rect: rect2, cx: cx2, cy: cy2 } = candidateData[i];

            // Vector from current center to candidate center
            const dx = cx2 - center1x;
            const dy = cy2 - center1y;

            // ----------------------------------------------------------------
            // Step 1: Direction filtering
            // Only consider candidates that are meaningfully displaced in the
            // requested direction (above threshold to reject jitter)
            // ----------------------------------------------------------------
            let isValid = false;
            let distMain = 0; // Distance parallel to navigation direction
            let distCross = 0; // Distance perpendicular to navigation direction

            if (direction === 'right') {
                if (rect2.left > rect1.right - DIRECTION_THRESHOLD) {
                    isValid = true;
                    distMain = dx;
                    distCross = Math.abs(dy);
                }
            } else if (direction === 'left') {
                if (rect2.right < rect1.left + DIRECTION_THRESHOLD) {
                    isValid = true;
                    distMain = Math.abs(dx);
                    distCross = Math.abs(dy);
                }
            } else if (direction === 'down') {
                if (rect2.top > rect1.bottom - DIRECTION_THRESHOLD) {
                    isValid = true;
                    distMain = dy;
                    distCross = Math.abs(dx);
                }
            } else if (direction === 'up') {
                if (rect2.bottom < rect1.top + DIRECTION_THRESHOLD) {
                    isValid = true;
                    distMain = Math.abs(dy);
                    distCross = Math.abs(dx);
                }
            }

            if (!isValid) continue;

            // ----------------------------------------------------------------
            // Step 2: Alignment bonus via cross-axis overlap
            // If the candidate shares vertical (for left/right) or horizontal
            // (for up/down) overlap with the current element, they're "aligned"
            // and the cross-axis penalty is zeroed.
            // ----------------------------------------------------------------
            let overlap = 0;
            if (direction === 'left' || direction === 'right') {
                // Vertical overlap (shared Y range)
                const top = Math.max(rect1.top, rect2.top);
                const bottom = Math.min(rect1.bottom, rect2.bottom);
                overlap = Math.max(0, bottom - top);
            } else {
                // Horizontal overlap (shared X range)

                // ------------------------------------------------------------
                // Settings Navigation Optimization
                // ------------------------------------------------------------
                // If both current and candidate elements belong to settings items
                // in different rows, check if either row has <= 1 focusable item.
                // Row counts are cached in rowCountMap to avoid repeated querySelectorAll calls.
                // ------------------------------------------------------------
                const row2 = el.closest ? el.closest('.setting-item') : null;

                if (row1 && row2 && row1 !== row2) {
                    let count2 = rowCountMap.get(row2);
                    if (count2 === undefined) {
                        count2 = getFocusableCountInRow(row2);
                        rowCountMap.set(row2, count2);
                    }
                    if (count1 <= 1 || count2 <= 1) {
                        overlap = 9999; // Force a perfect alignment score
                    }
                }

                // Fall back to standard physical bounding box overlap calculation
                // if the settings item row rule did not apply.
                if (overlap === 0) {
                    const left = Math.max(rect1.left, rect2.left);
                    const right = Math.min(rect1.right, rect2.right);
                    overlap = Math.max(0, right - left);
                }
            }

            // Zero out cross penalty if elements are significantly aligned
            if (overlap > MIN_OVERLAP_THRESHOLD) {
                distCross = 0;
            }

            // ----------------------------------------------------------------
            // Step 3: Final scoring
            // Main-axis distance + weighted cross-axis penalty.
            // Lower score = better candidate.
            // ----------------------------------------------------------------
            const score = distMain + distCross * CROSS_AXIS_WEIGHT;

            if (score < minScore) {
                minScore = score;
                bestCandidate = el;
            }
        }

        return bestCandidate;
    }

    /**
     * Find the candidate closest to a target element (Euclidean distance).
     * Used for restoring focus when entering a section from a specific
     * spatial origin (e.g. navigating down from a button above a grid
     * should land on the nearest grid item, not the first one).
     *
     * @param {HTMLElement} target - Origin element to measure from
     * @param {HTMLElement[]} candidates - All focusable elements in the section
     * @param {HTMLElement} [container=null] - Optional parent section container for relative rect caching
     * @returns {HTMLElement|null} Closest candidate, or null if none
     */
    findClosest(target, candidates, container = null) {
        if (!target || !candidates.length) return null;

        // Compute reference coordinates for target element
        const rect1 = this._getCurrentRect(target, container);
        const center1x = rect1.left + rect1.width / 2;
        const center1y = rect1.top + rect1.height / 2;

        // Batch-resolve candidate coordinates using cached container metrics where available
        const candidateData = this._getCandidateData(candidates, target, container);

        // Pure math loop — zero DOM access
        let best = null;
        let minDist = Infinity;

        for (let i = 0; i < candidateData.length; i++) {
            const { el, cx, cy } = candidateData[i];

            // Standard Euclidean distance between centers
            const dx = cx - center1x;
            const dy = cy - center1y;
            const dist = dx * dx + dy * dy; // Skip sqrt — monotonic, same result

            if (dist < minDist) {
                minDist = dist;
                best = el;
            }
        }

        return best;
    }
}

// ============================================================================
// Singleton export — one navigator shared across the app
// ============================================================================
export const spatialNavigator = new SpatialNavigator();
export default SpatialNavigator;
