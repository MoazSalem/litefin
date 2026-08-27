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
 * Named/numeric HTML entities that legitimately appear in subtitle files.
 * Decoded BEFORE escaping so pre-encoded files don't render as literal text
 * ("AT&amp;T" -> "AT&T"). Single-pass replace: substituted text is never
 * re-scanned, so "&amp;lt;" correctly becomes literal "&lt;" text.
 * @private
 */
const SUBTITLE_ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00A0'
};

/**
 * Sanitizes subtitle cue text for the DOM subtitle overlay.
 *
 * SRT/WebVTT cues legitimately carry simple markup: styling tags (<i>, <b>,
 * <u>) preserved by SubtitleParser._cleanText, multi-line cues joined with
 * <br> by the parser itself, and some releases (e.g. anime fansubs) use
 * <font face/size/color>. Fully escaping cue text (the XSS fix) turned all
 * of that into visible literal tags.
 *
 * This restores formatting safely, in three provably closed steps:
 * 1. Decode pre-encoded HTML entities (bounded, single pass).
 * 2. Escape EVERYTHING — the string is now inert.
 * 3. Re-allow only the exact escaped spellings of whitelisted bare tags
 *    (i/b/u/em/strong/br, incl. <br/> and <BR> forms) and font tags whose
 *    face/size/color attributes are strictly double-quoted with values that
 *    contain no entities (values therefore cannot break out of the quotes
 *    or introduce new attributes — event handlers stay impossible).
 * Anything else (<img>, <script>, attribute-carrying styling tags, unknown
 * tags) remains escaped, inert text.
 *
 * @param {*} text - Raw cue text from the subtitle parser
 * @returns {string} HTML-safe string with cue styling and line breaks intact
 */
export function sanitizeSubtitleText(text) {
    if (text === null || text === undefined) return '';
    const decoded = String(text).replace(
        /&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos|nbsp);/gi,
        (match, entity) => {
            if (entity[0] === '#') {
                const code = entity[1] === 'x' || entity[1] === 'X'
                    ? parseInt(entity.slice(2), 16)
                    : parseInt(entity.slice(1), 10);
                return Number.isInteger(code) && code > 0 && code <= 0x10ffff
                    ? String.fromCodePoint(code)
                    : match;
            }
            return SUBTITLE_ENTITIES[entity.toLowerCase()] ?? match;
        }
    );
    return escapeHtml(decoded)
        // HTML tag/attribute whitespace is [ \t\n\r\f] only — JS \s also
        // matches NBSP/\u2028/\ufeff etc., which browsers treat as attribute
        // NAME characters, so allowing \s would emit renamed/junk attributes.
        .replace(/&lt;(\/?)(i|b|u|em|strong|br|font)[ \t\n\r\f]*\/?&gt;/gi, '<$1$2>')
        .replace(/&lt;font((?:[ \t\n\r\f]+(?:face|size|color)=&quot;[^&]*&quot;)+[ \t\n\r\f]*)&gt;/gi,
            (match, attrs) => '<font' + attrs.replace(/&quot;/g, '"') + '>');
}
