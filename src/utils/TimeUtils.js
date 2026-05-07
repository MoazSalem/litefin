/**
 * ============================================================================
 * Litefin Tizen - Time and Date Utilities
 * ============================================================================
 */

/**
 * Format a date string or Date object into dd/mm/yyyy format
 * @param {string|Date} date - Date to format
 * @returns {string} Formatted date string
 */
export function formatDate(date) {
    if (!date) return '';
    try {
        const d = new Date(date);
        if (isNaN(d.getTime())) return '';
        
        const day = d.getDate().toString().padStart(2, '0');
        const month = (d.getMonth() + 1).toString().padStart(2, '0');
        const year = d.getFullYear();
        
        return `${day}/${month}/${year}`;
    } catch (e) {
        return '';
    }
}
