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

/**
 * Sanitizes subtitle cue text for the DOM subtitle overlay.
 *
 * SRT/WebVTT cues conventionally carry simple styling tags (<i>, <b>, <u>)
 * which SubtitleParser._cleanText deliberately preserves, so fully escaping
 * cue text (the XSS fix) also destroyed that legitimate formatting.
 * This restores it safely: the input is escaped FIRST, and only the exact
 * escaped spellings of whitelisted BARE tags are turned back into markup.
 * No attribute-bearing tag can match the pattern, so event handlers, URLs,
 * and any non-whitelisted tag (<img>, <script>, <font ...>) remain inert
 * text.
 *
 * @param {*} text - Raw cue text from the subtitle parser
 * @returns {string} HTML-safe string with basic i/b/u/em/strong styling intact
 */
export function sanitizeSubtitleText(text) {
    if (text === null || text === undefined) return '';
    return escapeHtml(text)
        .replace(/&lt;(\/?)(i|b|u|em|strong)&gt;/gi, '<$1$2>');
}
