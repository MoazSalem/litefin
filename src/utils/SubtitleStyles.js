/**
 * SubtitleStyles - Subtitle Style Generator
 *
 * Generates CSS styles from player subtitle settings.
 * Adapts logic from jellyfin-web's subtitleappearancehelper.js
 */

import { PlayerSettings } from './PlayerSettings.js';

/**
 * Convert HEX color to RGBA
 * @param {string} hex - Hex color code (e.g., #ffffff)
 * @param {number} opacity - Opacity percentage (0-100)
 * @returns {string} RGBA color string
 */
function _hexToRgba(hex, opacity) {
    if (!hex || hex === 'transparent') return 'transparent';

    // Remove hash
    hex = hex.replace('#', '');

    // Parse values
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    const a = (opacity / 100).toFixed(2);

    return `rgba(${r}, ${g}, ${b}, ${a})`;
}

// ============================================================================
// Text Styles Generator
// ============================================================================

/**
 * Generate text CSS styles from settings
 * @returns {Object[]} Array of {name, value} CSS properties
 */
export function getTextStyles() {
    const styles = [];

    // ========================================================================
    // Font Size
    // Options: small, medium, large, larger, extralarge
    // ========================================================================
    const size = PlayerSettings.get('subtitleSize') || 'medium';
    switch (size) {
        case 'extralarge':
            styles.push({ name: 'fontSize', value: '8vh' });
            break;
        case 'larger':
            styles.push({ name: 'fontSize', value: '7vh' });
            break;
        case 'large':
            styles.push({ name: 'fontSize', value: '6vh' });
            break;
        case 'small':
            styles.push({ name: 'fontSize', value: '4vh' });
            break;
        case 'smaller':
            styles.push({ name: 'fontSize', value: '3vh' });
            break;
        case 'medium':
        default:
            styles.push({ name: 'fontSize', value: '5vh' });
            break;
    }

    // ========================================================================
    // Font Weight
    // Options: normal, bold
    // ========================================================================
    const weight = PlayerSettings.get('subtitleWeight') || 'normal';
    styles.push({ name: 'fontWeight', value: weight });

    // ========================================================================
    // Text Shadow / Drop Shadow
    // Options: dropshadow, raised, depressed, uniform, none
    // ========================================================================
    // ========================================================================
    // Text Opacity (Get this early for shadows)
    // ========================================================================
    const textOpacity = PlayerSettings.get('subtitleTextOpacity') ?? 100;

    // ========================================================================
    // Text Shadow / Drop Shadow
    // Options: dropshadow, raised, depressed, uniform, none
    // ========================================================================
    const shadow = PlayerSettings.get('subtitleDropShadow') || 'dropshadow';

    // Helper to generate shadow color with opacity
    const shadowBlack = _hexToRgba('#000000', textOpacity);
    const shadowWhite = _hexToRgba('#ffffff', textOpacity);

    switch (shadow) {
        case 'heavy':
            styles.push({ name: 'textShadow', value: `${shadowBlack} 0px 0px 4px` });
            break;
        case 'raised':
            styles.push({
                name: 'textShadow',
                value: `-1px -1px ${shadowWhite}, 0px -1px ${shadowWhite}, -1px 0px ${shadowWhite}, 1px 1px ${shadowBlack}, 0px 1px ${shadowBlack}, 1px 0px ${shadowBlack}`
            });
            break;
        case 'depressed':
            styles.push({
                name: 'textShadow',
                value: `1px 1px ${shadowWhite}, 0px 1px ${shadowWhite}, 1px 0px ${shadowWhite}, -1px -1px ${shadowBlack}, 0px -1px ${shadowBlack}, -1px 0px ${shadowBlack}`
            });
            break;
        case 'uniform':
            styles.push({
                name: 'textShadow',
                value: `${shadowBlack} 0px 1px, ${shadowBlack} 0px -1px, ${shadowBlack} 1px 0px, ${shadowBlack} -1px 0px, ${shadowBlack} 1px 1px, ${shadowBlack} -1px 1px, ${shadowBlack} 1px -1px, ${shadowBlack} -1px -1px`
            });
            break;
        case 'none':
            styles.push({ name: 'textShadow', value: 'none' });
            break;
        case 'dropshadow':
        default:
            styles.push({ name: 'textShadow', value: `${shadowBlack} 0px 0px 2px` });
            break;
    }

    // ========================================================================
    // Text Color
    // ========================================================================
    const textColor = PlayerSettings.get('subtitleTextColor') || '#ffffff';
    // textOpacity is already defined above for shadows
    styles.push({ name: 'color', value: _hexToRgba(textColor, textOpacity) });

    // ========================================================================
    // Background Color
    // ========================================================================
    const background = PlayerSettings.get('subtitleTextBackground') || 'transparent';
    const bgOpacity = PlayerSettings.get('subtitleBackgroundOpacity') ?? 100;

    if (background === 'transparent' || background === 'none') {
        styles.push({ name: 'backgroundColor', value: 'transparent' });
    } else {
        styles.push({ name: 'backgroundColor', value: _hexToRgba(background, bgOpacity) });
    }

    // ========================================================================
    // Font Family
    // Options: default, typewriter, print, console, cursive, casual, smallcaps
    // ========================================================================
    const font = PlayerSettings.get('subtitleFont') || '';

    switch (font) {
        case 'typewriter':
            styles.push({ className: 'font-typewriter' });
            break;
        case 'print':
            styles.push({ className: 'font-print' });
            break;
        case 'console':
            styles.push({ className: 'font-console' });
            break;
        case 'cursive':
            styles.push({ className: 'font-cursive' });
            break;
        case 'casual':
            styles.push({ className: 'font-casual' });
            break;
        case 'smallcaps':
            styles.push({ className: 'font-smallcaps' });
            break;
        case 'poppins':
            styles.push({ className: 'font-poppins' });
            break;
        case 'noto-arabic':
            styles.push({ className: 'font-noto-arabic' });
            break;
        default:
            styles.push({ className: 'font-default' });
            break;
    }

    // Vertical Position (affects margin)
    // Negative = from bottom, Positive = from top
    // ========================================================================
    // Vertical Position (affects margin)
    // Negative = from bottom, Positive = from top
    // ========================================================================
    const posSetting = PlayerSettings.get('subtitleVerticalPosition');

    if (posSetting === 'custom') {
        // Custom positioning is handled by getWindowStyles (absolute positioning)
        // so we remove any text margins
        styles.push({ name: 'marginBottom', value: '' });
        styles.push({ name: 'marginTop', value: '' });
    } else {
        let pos = parseInt(posSetting, 10);
        if (isNaN(pos)) pos = -2; // Default to bottom standard
        const step = 5; // vh logic

        if (pos < 0) {
            // Bottom: pos is -1, -2, -5...
            const margin = Math.abs(pos + 1) * step;
            styles.push({ name: 'marginBottom', value: `${margin}vh` });
            styles.push({ name: 'marginTop', value: '' });
        } else {
            // Top: pos is 0, 2...
            const margin = pos * step;
            styles.push({ name: 'marginBottom', value: '' });
            styles.push({ name: 'marginTop', value: `${margin}vh` });
        }
    }

    return styles;
}

// ============================================================================
// Window/Container Styles Generator
// ============================================================================

/**
 * Generate container/window CSS styles from settings
 * @returns {Object[]} Array of {name, value} CSS properties
 */
export function getWindowStyles() {
    const styles = [];
    const posSetting = PlayerSettings.get('subtitleVerticalPosition');

    if (posSetting === 'custom') {
        const customPos = PlayerSettings.get('subtitleVerticalPositionCustom') ?? 10;
        styles.push({ name: 'top', value: '' });
        styles.push({ name: 'bottom', value: `${customPos}%` });
    } else {
        let pos = parseInt(posSetting, 10);
        if (isNaN(pos)) pos = -2; // Default to bottom standard

        if (pos < 0) {
            // Position at bottom
            styles.push({ name: 'top', value: '' });
            styles.push({ name: 'bottom', value: '2vh' }); // Lower base constraint
        } else {
            // Position at top
            styles.push({ name: 'top', value: '2vh' }); // Lower base constraint
            styles.push({ name: 'bottom', value: '' });
        }
    }

    return styles;
}

// List of all possible font classes for cleanup
const fontClasses = [
    'font-typewriter',
    'font-print',
    'font-console',
    'font-cursive',
    'font-casual',
    'font-smallcaps',
    'font-poppins',
    'font-noto-arabic',
    'font-default'
];

/**
 * Apply styles to an element
 * @param {HTMLElement} element
 * @param {Object[]} styles
 */
export function applyStyles(element, styles) {
    if (!element) return;

    // First, clear any existing font classes
    element.classList.remove(...fontClasses);

    for (const style of styles) {
        if (style.className) {
            element.classList.add(style.className);
        } else if (style.value !== undefined) {
            element.style[style.name] = style.value;
        }
    }
}

/**
 * Get the current subtitle font ID from settings
 * Used by PlayerPage to trigger font preloading
 * @returns {string|null} The font ID (e.g. 'typewriter', 'cursive') or null
 */
function getCurrentFontId() {
    const font = PlayerSettings.get('subtitleFont') || '';
    // Return null for 'default' or empty (no Google Font needed)
    return font && font !== 'default' ? font : null;
}

export default {
    getTextStyles,
    getWindowStyles,
    applyStyles,
    getCurrentFontId
};
