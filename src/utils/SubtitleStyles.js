/**
 * SubtitleStyles - Subtitle Style Generator
 *
 * Generates CSS styles from player subtitle settings.
 * Adapts logic from jellyfin-web's subtitleappearancehelper.js
 */

import { PlayerSettings } from './PlayerSettings.js';

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
    const shadow = PlayerSettings.get('subtitleDropShadow') || 'dropshadow';
    switch (shadow) {
        case 'heavy':
            styles.push({ name: 'textShadow', value: '#000000 0px 0px 4px' });
            break;
        case 'raised':
            styles.push({
                name: 'textShadow',
                value: '-1px -1px #fff, 0px -1px #fff, -1px 0px #fff, 1px 1px #000, 0px 1px #000, 1px 0px #000'
            });
            break;
        case 'depressed':
            styles.push({
                name: 'textShadow',
                value: '1px 1px #fff, 0px 1px #fff, 1px 0px #fff, -1px -1px #000, 0px -1px #000, -1px 0px #000'
            });
            break;
        case 'uniform':
            styles.push({
                name: 'textShadow',
                value: '#000 0px 1px, #000 0px -1px, #000 1px 0px, #000 -1px 0px, #000 1px 1px, #000 -1px 1px, #000 1px -1px, #000 -1px -1px'
            });
            break;
        case 'none':
            styles.push({ name: 'textShadow', value: 'none' });
            break;
        case 'dropshadow':
        default:
            styles.push({ name: 'textShadow', value: '#000000 0px 0px 2px' });
            break;
    }

    // ========================================================================
    // Text Color
    // ========================================================================
    const textColor = PlayerSettings.get('subtitleTextColor') || '#ffffff';
    styles.push({ name: 'color', value: textColor });

    // ========================================================================
    // Background Color
    // ========================================================================
    const background = PlayerSettings.get('subtitleTextBackground') || 'transparent';
    styles.push({ name: 'backgroundColor', value: background });

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

    // ========================================================================
    // Vertical Position (affects margin)
    // Negative = from bottom, Positive = from top
    // ========================================================================
    const pos = parseInt(PlayerSettings.get('subtitleVerticalPosition'), 10) || -3;
    const lineHeight = 1.35;

    if (pos < 0) {
        const margin = Math.abs(pos + 1) * lineHeight;
        styles.push({ name: 'marginBottom', value: `${margin}em` });
        styles.push({ name: 'marginTop', value: '' });
    } else {
        const margin = pos * lineHeight;
        styles.push({ name: 'marginBottom', value: '' });
        styles.push({ name: 'marginTop', value: `${margin}em` });
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
    const pos = parseInt(PlayerSettings.get('subtitleVerticalPosition'), 10) || -3;

    if (pos < 0) {
        // Position at bottom
        styles.push({ name: 'top', value: '' });
        styles.push({ name: 'bottom', value: '8vh' }); // Dynamic base constraint
    } else {
        // Position at top
        styles.push({ name: 'top', value: '8vh' }); // Dynamic base constraint
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
