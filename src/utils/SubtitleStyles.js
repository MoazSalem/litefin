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
            styles.push({ name: 'fontFamily', value: '"Courier New", monospace' });
            styles.push({ name: 'fontVariant', value: 'none' });
            break;
        case 'print':
            styles.push({ name: 'fontFamily', value: 'Georgia, "Times New Roman", serif' });
            styles.push({ name: 'fontVariant', value: 'none' });
            break;
        case 'console':
            styles.push({ name: 'fontFamily', value: 'Consolas, "Lucida Console", Monaco, monospace' });
            styles.push({ name: 'fontVariant', value: 'none' });
            break;
        case 'cursive':
            styles.push({ name: 'fontFamily', value: '"Lucida Handwriting", "Brush Script MT", cursive' });
            styles.push({ name: 'fontVariant', value: 'none' });
            break;
        case 'casual':
            styles.push({ name: 'fontFamily', value: '"Comic Sans MS", "Segoe Print", casual, sans-serif' });
            styles.push({ name: 'fontVariant', value: 'none' });
            break;
        case 'smallcaps':
            styles.push({ name: 'fontFamily', value: '"Copperplate", sans-serif' });
            styles.push({ name: 'fontVariant', value: 'small-caps' });
            break;
        default:
            // Default system fonts - good for readability on TVs
            styles.push({ name: 'fontFamily', value: 'Roboto, "Segoe UI", Helvetica, Arial, sans-serif' });
            styles.push({ name: 'fontVariant', value: 'none' });
            break;
    }

    // Vertical Position (affects margin)
    // Negative = from bottom, Positive = from top
    // ========================================================================
    let pos = parseInt(PlayerSettings.get('subtitleVerticalPosition'), 10);
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
    let pos = parseInt(PlayerSettings.get('subtitleVerticalPosition'), 10);
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

    return styles;
}

/**
 * Apply styles to an element
 * @param {HTMLElement} element
 * @param {Object[]} styles
 */
export function applyStyles(element, styles) {
    if (!element) return;
    for (const style of styles) {
        if (style.value !== undefined) {
            element.style[style.name] = style.value;
        }
    }
}

export default {
    getTextStyles,
    getWindowStyles,
    applyStyles
};
