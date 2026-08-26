/**
 * ============================================================================
 * Litefin Tizen - ThemeUtils
 * ============================================================================
 * Helper functions for color manipulation and dynamic theme calculation.
 * ============================================================================
 */

export const themeUtils = {
    /**
     * Convert HEX to RGB
     * @param {string} hex
     * @returns {object|null} {r, g, b}
     */
    hexToRgb(hex) {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return result
            ? {
                  r: parseInt(result[1], 16),
                  g: parseInt(result[2], 16),
                  b: parseInt(result[3], 16)
              }
            : null;
    },

    /**
     * Convert RGB to HEX
     * @param {number} r
     * @param {number} g
     * @param {number} b
     * @returns {string}
     */
    rgbToHex(r, g, b) {
        return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
    },

    /**
     * Convert HEX to HSL
     * @param {string} hex
     * @returns {object} {h, s, l}
     */
    hexToHsl(hex) {
        let { r, g, b } = this.hexToRgb(hex);
        r /= 255;
        g /= 255;
        b /= 255;

        const max = Math.max(r, g, b),
            min = Math.min(r, g, b);
        let h, s;
        const l = (max + min) / 2;

        if (max === min) {
            h = s = 0; // achromatic
        } else {
            const d = max - min;
            s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
            switch (max) {
                case r:
                    h = (g - b) / d + (g < b ? 6 : 0);
                    break;
                case g:
                    h = (b - r) / d + 2;
                    break;
                case b:
                    h = (r - g) / d + 4;
                    break;
            }
            h /= 6;
        }

        return { h: h * 360, s: s * 100, l: l * 100 };
    },

    /**
     * Convert HSL to HEX
     * @param {number} h
     * @param {number} s
     * @param {number} l
     * @returns {string}
     */
    hslToHex(h, s, l) {
        h /= 360;
        s /= 100;
        l /= 100;
        let r, g, b;

        if (s === 0) {
            r = g = b = l; // achromatic
        } else {
            const hue2rgb = (p, q, t) => {
                if (t < 0) t += 1;
                if (t > 1) t -= 1;
                if (t < 1 / 6) return p + (q - p) * 6 * t;
                if (t < 1 / 2) return q;
                if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
                return p;
            };
            const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
            const p = 2 * l - q;
            r = hue2rgb(p, q, h + 1 / 3);
            g = hue2rgb(p, q, h);
            b = hue2rgb(p, q, h - 1 / 3);
        }

        return this.rgbToHex(Math.round(r * 255), Math.round(g * 255), Math.round(b * 255));
    },

    /**
     * Create accent color variants based on a base hex color
     * @param {string} hex
     * @returns {object}
     */
    getAccentVariants(hex) {
        const rgb = this.hexToRgb(hex);
        const hsl = this.hexToHsl(hex);
        const darkRgbObj = this.hexToRgb(this.hslToHex(hsl.h, Math.max(15, Math.min(hsl.s * 0.5, 40)), 10));
        const darkRgb = darkRgbObj ? `${darkRgbObj.r}, ${darkRgbObj.g}, ${darkRgbObj.b}` : '15, 15, 20';

        return {
            accent: hex,
            accentRgb: `${rgb.r}, ${rgb.g}, ${rgb.b}`,
            accentDarkRgb: darkRgb,
            accentHover: this.hslToHex(hsl.h, hsl.s, Math.min(hsl.l + 10, 100)),
            accentActive: this.hslToHex(hsl.h, hsl.s, Math.max(hsl.l - 10, 0)),
            accentLight: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.2)`
        };
    },

    /**
     * Generate complementary background colors for a tinted theme
     * @param {string} hex
     * @returns {object}
     */
    getTintedColors(hex) {
        const hsl = this.hexToHsl(hex);

        // Improved tinted background heuristic based on original Purple Haze/Blue Radiance
        // We allow more saturation (up to 45% of accent's saturation) and slightly higher lightness
        const bgH = hsl.h;
        const bgS = Math.max(20, Math.min(hsl.s * 0.45, 45));

        return {
            background: this.hslToHex(bgH, bgS, 7), // Base background
            backgroundAlt: this.hslToHex(bgH, bgS, 11), // Sidebar/Navbar
            surface: this.hslToHex(bgH, bgS, 15), // Surface elements
            cardBg: this.hslToHex(bgH, bgS, 19), // Cards
            cardBgHover: this.hslToHex(bgH, bgS, 26), // Hover states
            divider: this.hslToHex(bgH, bgS, 22) // Borders
        };
    },

    /**
     * Determine best contrast color (black or white) for a given background hex
     * @param {string} hex
     * @returns {string} #ffffff or #000000
     */
    getContrastColor(hex) {
        const luminance = this.getLuminance(hex);
        const hsl = this.hexToHsl(hex);

        // Threshold adjusted from 0.179 to 0.4 to be less "aggressive".
        if (luminance > 0.4) {
            // Background is bright - need dark text
            return this.hslToHex(hsl.h, Math.min(hsl.s * 1.4, 90), 12);
        } else {
            // Background is dark - need light text
            return this.hslToHex(hsl.h, Math.min(hsl.s * 1.1, 80), 90);
        }
    },

    /**
     * Get relative luminance of a color
     * @param {string} hex
     * @returns {number} 0-1
     */
    getLuminance(hex) {
        const rgb = this.hexToRgb(hex);
        if (!rgb) return 0;

        const normalize = (val) => {
            const s = val / 255;
            return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
        };

        const r = normalize(rgb.r);
        const g = normalize(rgb.g);
        const b = normalize(rgb.b);

        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    },

    /**
     * Check if a color is "bright" (requires dark text contrast)
     * @param {string} hex
     * @returns {boolean}
     */
    isBright(hex) {
        return this.getLuminance(hex) > 0.4;
    },

    /**
     * Generate a soft light version of a color for focus indicators
     * @param {string} hex
     * @returns {string}
     */
    getSoftLight(hex) {
        const hsl = this.hexToHsl(hex);
        // Desaturate slightly and set to high lightness for a clean focus look
        return this.hslToHex(hsl.h, Math.min(hsl.s, 15), 82);
    }
};
