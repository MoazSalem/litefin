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
     * @returns {HTMLElement|null} Best candidate, or null if none found
     */
    findNext(current, candidates, direction) {
        // ====================================================================
        // TIZEN OPTIMIZATION: Batch all DOM reads BEFORE the scoring loop.
        // getBoundingClientRect() forces synchronous layout calculation.
        // Calling it inside a loop causes "layout thrashing" — on TV hardware
        // this means 100ms+ stutters per keypress. Reading everything upfront
        // into plain objects lets the scoring loop run on pure cached data.
        // ====================================================================
        const rect1 = current.getBoundingClientRect();
        const center1x = rect1.left + rect1.width / 2;
        const center1y = rect1.top + rect1.height / 2;

        // Batch-read: one getBoundingClientRect() per candidate, all at once
        const candidateData = [];
        for (let i = 0; i < candidates.length; i++) {
            const el = candidates[i];
            if (el === current) continue;
            const r = el.getBoundingClientRect();
            candidateData.push({
                el,
                rect: r,
                cx: r.left + r.width / 2,
                cy: r.top + r.height / 2
            });
        }

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
                // 💎 Premium Settings Navigation Optimization
                // ------------------------------------------------------------
                // If both the current element and the candidate element belong to
                // settings items (.setting-item) and they reside in different rows,
                // we evaluate their respective focusable counts.
                //
                // If at least one of these settings rows contains exactly one (or zero)
                // focusable controls (e.g., a row containing only a single wide slider
                // or a narrow toggle switch), they do not represent a grid/column structure
                // that requires alignment preservation.
                //
                // In this case, we treat them as perfectly aligned horizontally (overlap = 9999)
                // to prevent narrow, right-aligned controls from being skipped when navigating
                // vertically (up/down).
                // ------------------------------------------------------------
                const row1 = current.closest('.setting-item');
                const row2 = el.closest('.setting-item');

                if (row1 && row2 && row1 !== row2) {
                    const count1 = getFocusableCountInRow(row1);
                    const count2 = getFocusableCountInRow(row2);

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
     * @returns {HTMLElement|null} Closest candidate, or null if none
     */
    findClosest(target, candidates) {
        if (!target || !candidates.length) return null;

        // TIZEN OPTIMIZATION: Batch all DOM reads before the scoring loop
        // to avoid layout thrashing (see findNext for full explanation)
        const rect1 = target.getBoundingClientRect();
        const center1x = rect1.left + rect1.width / 2;
        const center1y = rect1.top + rect1.height / 2;

        // Batch-read all candidate positions upfront
        const candidateData = [];
        for (let i = 0; i < candidates.length; i++) {
            const r = candidates[i].getBoundingClientRect();
            candidateData.push({
                el: candidates[i],
                cx: r.left + r.width / 2,
                cy: r.top + r.height / 2
            });
        }

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
