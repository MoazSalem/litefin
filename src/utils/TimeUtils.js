/**
 * ============================================================================
 * Litefin Tizen - Time and Date Utilities
 * ============================================================================
 */

/**
 * Format a date string or Date object.
 * Supports short month representation (e.g. "Aug 28" or "Aug 28, 2026") as well
 * as classic numeric date formats ("dd/mm/yyyy").
 *
 * @param {string|Date} date - Date to format
 * @param {Object} [options={}] - Formatting configuration
 * @param {boolean} [options.includeYear=false] - Whether to append the full year
 * @param {string} [options.style='short'] - Style mode ('short' or 'numeric')
 * @returns {string} Formatted date string
 */
export function formatDate(date, options = {}) {
    // Return early if no valid date parameter was supplied
    if (!date) return '';

    try {
        // Instantiate Date object and validate validity
        const d = new Date(date);
        if (isNaN(d.getTime())) return '';

        const includeYear = options.includeYear ?? false;
        const style = options.style || 'short';

        // --------------------------------------------------------------------
        // 1. Short Month Format (e.g. "Aug 28" or "Aug 28, 2026")
        // --------------------------------------------------------------------
        if (style === 'short') {
            const months = [
                'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
            ];
            const monthName = months[d.getMonth()];
            const day = d.getDate();
            const year = d.getFullYear();

            // Include full four-digit year if specified by user settings
            if (includeYear) {
                return `${monthName} ${day}, ${year}`;
            }

            return `${monthName} ${day}`;
        }

        // --------------------------------------------------------------------
        // 2. Numeric Fallback Format ("dd/mm/yyyy")
        // --------------------------------------------------------------------
        const day = d.getDate().toString().padStart(2, '0');
        const month = (d.getMonth() + 1).toString().padStart(2, '0');
        const year = d.getFullYear();

        return `${day}/${month}/${year}`;
    } catch (e) {
        return '';
    }
}
