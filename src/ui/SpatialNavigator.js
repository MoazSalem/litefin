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
        const rect1 = current.getBoundingClientRect();
        const center1 = {
            x: rect1.left + rect1.width / 2,
            y: rect1.top + rect1.height / 2
        };

        let bestCandidate = null;
        let minScore = Infinity;

        // Iterate all candidates and score those in the valid direction cone
        for (const candidate of candidates) {
            if (candidate === current) continue;

            const rect2 = candidate.getBoundingClientRect();
            const center2 = {
                x: rect2.left + rect2.width / 2,
                y: rect2.top + rect2.height / 2
            };

            // Vector from current center to candidate center
            const dx = center2.x - center1.x;
            const dy = center2.y - center1.y;

            // ----------------------------------------------------------------
            // Step 1: Direction filtering
            // Only consider candidates that are meaningfully displaced in the
            // requested direction (above threshold to reject jitter)
            // ----------------------------------------------------------------
            let isValid = false;
            let distMain = 0; // Distance parallel to navigation direction
            let distCross = 0; // Distance perpendicular to navigation direction

            if (direction === 'right') {
                if (dx > DIRECTION_THRESHOLD) {
                    isValid = true;
                    distMain = dx;
                    distCross = Math.abs(dy);
                }
            } else if (direction === 'left') {
                if (dx < -DIRECTION_THRESHOLD) {
                    isValid = true;
                    distMain = Math.abs(dx);
                    distCross = Math.abs(dy);
                }
            } else if (direction === 'down') {
                if (dy > DIRECTION_THRESHOLD) {
                    isValid = true;
                    distMain = dy;
                    distCross = Math.abs(dx);
                }
            } else if (direction === 'up') {
                if (dy < -DIRECTION_THRESHOLD) {
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
                const left = Math.max(rect1.left, rect2.left);
                const right = Math.min(rect1.right, rect2.right);
                overlap = Math.max(0, right - left);
            }

            // Zero out cross penalty if elements are aligned
            if (overlap > 0) {
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
                bestCandidate = candidate;
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

        const rect1 = target.getBoundingClientRect();
        const center1 = {
            x: rect1.left + rect1.width / 2,
            y: rect1.top + rect1.height / 2
        };

        let best = null;
        let minDist = Infinity;

        for (const c of candidates) {
            const rect2 = c.getBoundingClientRect();
            const center2 = {
                x: rect2.left + rect2.width / 2,
                y: rect2.top + rect2.height / 2
            };

            // Standard Euclidean distance between centers
            const dx = center2.x - center1.x;
            const dy = center2.y - center1.y;
            const dist = Math.sqrt(dx * dx + dy * dy);

            if (dist < minDist) {
                minDist = dist;
                best = c;
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
