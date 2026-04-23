import { logger } from './Logger.js';

const log = logger.create('FontLoader');

/**
 * ============================================================================
 * FontLoader - Local Font Manager
 * ============================================================================
 * Manages bundled subtitle fonts. Fonts are loaded via @font-face rules
 * in fonts.css which reference local .ttf files in assets/fonts/.
 *
 * This utility provides the mapping between internal font IDs
 * (used by SubtitleStyles) and the actual font family names.
 * ============================================================================
 */
class FontLoader {
    constructor() {
        // Map internal font IDs to their CSS font-family names
        // These names match the @font-face declarations in fonts.css
        this._fontMap = {
            typewriter: 'Courier Prime',
            print: 'Merriweather',
            console: 'Inconsolata',
            cursive: 'Dancing Script',
            casual: 'Patrick Hand',
            smallcaps: 'Cinzel',
            poppins: 'Poppins',
            'noto-arabic': 'Noto Sans Arabic',
            silkscreen: 'Silkscreen',
            'space-grotesk': 'Space Grotesk'
        };
    }

    /**
     * Get the font family name for a given internal ID
     * @param {string} fontId - Internal font identifier (e.g., 'typewriter')
     * @returns {string|null} The font family name, or null if not mapped
     */
    getFontFamily(fontId) {
        if (!fontId || !this._fontMap[fontId]) return null;
        return this._fontMap[fontId];
    }

    /**
     * Force load a font to ensure it's ready before use.
     * Uses document.fonts.load() or a hidden DOM element to trigger download.
     * @param {string} fontId
     * @returns {Promise<boolean>}
     */
    async loadFont(fontId) {
        if (!fontId || !this._fontMap[fontId]) return false;

        const fontFamily = this._fontMap[fontId];
        log.debug(`[FontLoader] Preloading font: ${fontFamily}`);

        try {
            // Method 1: Font Loading API
            if (document.fonts && document.fonts.load) {
                await document.fonts.load(`16px "${fontFamily}"`);
                log.debug(`[FontLoader] Font loaded via API: ${fontFamily}`);
                return true;
            }
        } catch (e) {
            log.warn(`[FontLoader] Font API failed, trying DOM fallback: ${e}`);
        }

        // Method 2: Hidden DOM Element (Fallback)
        return new Promise((resolve) => {
            const span = document.createElement('span');
            span.style.fontFamily = `"${fontFamily}"`;
            span.style.opacity = '0';
            span.style.position = 'absolute';
            span.style.pointerEvents = 'none';
            span.textContent = 'FontTest';
            document.body.appendChild(span);

            // Give browser a moment to trigger download/render
            setTimeout(() => {
                document.body.removeChild(span);
                log.debug(`[FontLoader] Font loaded via DOM fallback: ${fontFamily}`);
                resolve(true);
            }, 100);
        });
    }
}

// Export as singleton
export default new FontLoader();
