/**
 * ============================================================================
 * Litefin Tizen - Utils extensions for screensaver
 * ============================================================================
 */

export function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Escapes a value for safe interpolation into HTML text content or
 * double-quoted attribute values.
 *
 * The app renders many server-supplied strings (item names, EPG data,
 * subtitle cues, discovery replies, backup labels) through innerHTML
 * template literals. This is the single escaper for all such sinks.
 * Note: i18n.ensureBiDi() is a BiDi layout helper only — it returns the
 * input unchanged in LTR mode and must never be treated as an escaper.
 *
 * @param {*} value - Value to escape (coerced to string; null/undefined -> '')
 * @returns {string} HTML-escaped string
 */
export function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
