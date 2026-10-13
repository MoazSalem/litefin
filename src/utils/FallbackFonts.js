/** Stable font IDs shared by settings, UI styling, and subtitle renderers. */
const FONT_PREFIX = 'fallback-font:';

function encodeFontName(name) {
    return encodeURIComponent(name).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * @param {string} name Server font filename.
 * @returns {string} Stable, encoded ID for a named fallback font.
 */
export function getFallbackFontId(name) {
    return `${FONT_PREFIX}${encodeFontName(name)}`;
}

/**
 * @param {string} fontId Saved font preference.
 * @returns {string|null} Filename, or null for bundled/legacy/invalid IDs.
 */
export function getFallbackFontName(fontId) {
    if (typeof fontId !== 'string' || !fontId.startsWith(FONT_PREFIX)) return null;
    try {
        return decodeURIComponent(fontId.slice(FONT_PREFIX.length)) || null;
    } catch (_) {
        return null;
    }
}

/**
 * @param {string} fontId Saved font preference.
 * @returns {boolean} Whether the ID selects a legacy or named server font.
 */
export function isFallbackFont(fontId) {
    return fontId === 'fallback-font' || getFallbackFontName(fontId) !== null;
}

/**
 * @param {string} fontId Saved font preference.
 * @returns {string|null} CSS/ASS family shared by the font loader and renderers.
 */
export function getFallbackFontFamily(fontId) {
    if (fontId === 'fallback-font') return 'Jellyfin Fallback Font';
    const name = getFallbackFontName(fontId);
    if (!name) return null;
    // Keep quotes and ASS style delimiters out of the synthetic family name.
    return `Jellyfin Fallback Font ${encodeFontName(name)}`;
}
