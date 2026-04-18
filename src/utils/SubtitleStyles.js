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

    // Reset properties that might have been set by other modes (like 'border')
    styles.push({ name: 'webkitTextStroke', value: '' });
    styles.push({ name: 'paintOrder', value: '' });

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
        case 'custom': {
            const customSizeV = PlayerSettings.get('subtitleSizeCustomValue') ?? 5;
            styles.push({ name: 'fontSize', value: `${customSizeV}vh` });
            break;
        }
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
    // Options: uniform, dropshadow, raised, depressed, none
    // ========================================================================
    // ========================================================================
    // Text Opacity
    // ========================================================================
    const textOpacity = PlayerSettings.get('subtitleTextOpacity') ?? 100;

    // ========================================================================
    // Text Shadow / Drop Shadow
    // Options: dropshadow, heavy, raised, depressed, uniform, none
    // ========================================================================
    const shadow = PlayerSettings.get('subtitleDropShadow') || 'uniform';

    // Custom Shadow Settings
    const shadowOpacity = PlayerSettings.get('subtitleDropShadowOpacity') ?? 20;
    const shadowColorHex = PlayerSettings.get('subtitleDropShadowColor') || '#000000';
    const shadowBlur = PlayerSettings.get('subtitleDropShadowBlur') ?? 6;
    const blurPx = `${shadowBlur}px`;

    const borderWidth = PlayerSettings.get('subtitleBorderWidth') ?? 3;
    const borderPx = `${borderWidth}px`;

    // Generate valid RGBA for shadow and highlight (for 3D effects).
    // Special case: 'border' mode forces 100% opacity for the outline,
    // but we don't want to overwrite the user's stored 'subtitleDropShadowOpacity'
    // for when they switch back to other shadow modes.
    const effectiveOpacity = shadow === 'border' ? 100 : shadowOpacity;
    const shadowColor = _hexToRgba(shadowColorHex, effectiveOpacity);
    const highlightColor = _hexToRgba('#ffffff', effectiveOpacity); // Keep highlight white but respect opacity

    switch (shadow) {
        case 'heavy':
        case 'dropshadow':
            // "Heavy" and "Drop Shadow" are effectively custom shadows now
            styles.push({ name: 'textShadow', value: `${shadowColor} 0px 0px ${blurPx}` });
            break;
        case 'raised':
            styles.push({
                name: 'textShadow',
                value: `-1px -1px ${blurPx} ${highlightColor}, 0px -1px ${blurPx} ${highlightColor}, -1px 0px ${blurPx} ${highlightColor}, 1px 1px ${blurPx} ${shadowColor}, 0px 1px ${blurPx} ${shadowColor}, 1px 0px ${blurPx} ${shadowColor}`
            });
            break;
        case 'depressed':
            styles.push({
                name: 'textShadow',
                value: `1px 1px ${blurPx} ${highlightColor}, 0px 1px ${blurPx} ${highlightColor}, 1px 0px ${blurPx} ${highlightColor}, -1px -1px ${blurPx} ${shadowColor}, 0px -1px ${blurPx} ${shadowColor}, -1px 0px ${blurPx} ${shadowColor}`
            });
            break;
        case 'uniform':
            styles.push({
                name: 'textShadow',
                value: `${shadowColor} 0px 1px ${blurPx}, ${shadowColor} 0px -1px ${blurPx}, ${shadowColor} 1px 0px ${blurPx}, ${shadowColor} -1px 0px ${blurPx}, ${shadowColor} 1px 1px ${blurPx}, ${shadowColor} -1px 1px ${blurPx}, ${shadowColor} 1px -1px ${blurPx}, ${shadowColor} -1px -1px ${blurPx}`
            });
            break;
        case 'border':
            // Solid border logic using -webkit-text-stroke.
            // Using 'paint-order: stroke fill' ensures the border stays behind the text
            // so it doesn't thin out the glyphs even at high widths.
            styles.push({ name: 'webkitTextStroke', value: `${borderPx} ${shadowColor}` });
            styles.push({ name: 'paintOrder', value: 'stroke fill' });
            styles.push({ name: 'textShadow', value: 'none' });
            break;
        case 'none':
            styles.push({ name: 'textShadow', value: 'none' });
            break;
        default:
            styles.push({ name: 'textShadow', value: `${shadowColor} 0px 0px ${blurPx}` });
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
        case 'roboto':
            styles.push({ className: 'font-roboto' });
            break;
        case 'google':
            styles.push({ className: 'font-google' });
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
        let pos = parseFloat(posSetting);
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
        let pos = parseFloat(posSetting);
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

// ============================================================================
// Secondary Subtitle Style Generators
// Secondary subtitles inherit ALL primary appearance settings (color, shadow,
// font family, weight, opacity, background) but have their own independent
// size and position controls.
// ============================================================================

/**
 * Generate text styles for the secondary subtitle overlay.
 * Inherits all primary text styles, then overrides fontSize with the
 * secondary-specific size setting.
 *
 * @returns {Object[]} Array of {name, value} CSS properties
 */
export function getSecondaryTextStyles() {
    // Start with the full primary text style set as a base
    // (font family, color, shadow, weight, opacity, background all inherited)
    const styles = getTextStyles();

    // Override just the font size with the secondary-specific size preference
    const size = PlayerSettings.get('secondarySubtitleSize') || 'medium';
    const fontSizeMap = {
        extralarge: '8vh',
        larger: '7vh',
        large: '6vh',
        medium: '5vh',
        small: '4vh',
        smaller: '3vh'
    };
    const resolvedSize = fontSizeMap[size] || '5vh';

    // Patch the existing fontSize entry in-place (getTextStyles always adds one)
    const fontSizeIdx = styles.findIndex((s) => s.name === 'fontSize');
    if (fontSizeIdx !== -1) {
        styles[fontSizeIdx].value = resolvedSize;
    } else {
        // Safety fallback — should never happen, but just in case
        styles.unshift({ name: 'fontSize', value: resolvedSize });
    }

    // Also override the margin values — secondary position is fully managed
    // by getSecondaryWindowStyles() instead, so we clear any margin offsets
    // that the primary getTextStyles() may have injected based on primary position.
    const marginBottomIdx = styles.findIndex((s) => s.name === 'marginBottom');
    const marginTopIdx = styles.findIndex((s) => s.name === 'marginTop');
    if (marginBottomIdx !== -1) styles[marginBottomIdx].value = '';
    if (marginTopIdx !== -1) styles[marginTopIdx].value = '';

    return styles;
}

/**
 * Generate container/window CSS styles for the secondary subtitle overlay.
 * Uses secondary-specific position settings; logic mirrors getWindowStyles()
 * but reads secondarySubtitleVerticalPosition instead.
 *
 * @returns {Object[]} Array of {name, value} CSS properties
 */
export function getSecondaryWindowStyles() {
    const styles = [];
    const posSetting = PlayerSettings.get('secondarySubtitleVerticalPosition') || 'custom';

    if (posSetting === 'custom') {
        // Custom: absolute % from top of screen (Standard for secondary)
        const customPos = PlayerSettings.get('secondarySubtitleVerticalPositionCustom') ?? 10;
        styles.push({ name: 'top', value: `${customPos}%` });
        styles.push({ name: 'bottom', value: '' });
    } else {
        let pos = parseFloat(posSetting);
        // Fallback or legacy preset handling
        if (isNaN(pos)) pos = 1;

        if (pos >= 0) {
            // Top-anchored position
            styles.push({ name: 'top', value: '2vh' });
            styles.push({ name: 'bottom', value: '' });
        } else {
            // Bottom-anchored position
            styles.push({ name: 'top', value: '' });
            styles.push({ name: 'bottom', value: '2vh' });
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
    'font-roboto',
    'font-google',
    'font-pixelart',
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
    getSecondaryTextStyles,
    getSecondaryWindowStyles,
    applyStyles,
    getCurrentFontId,
    getFontClassName: (settingKey = 'subtitleFont') => {
        const font = PlayerSettings.get(settingKey) || '';
        switch (font) {
            case 'typewriter':
                return 'font-typewriter';
            case 'print':
                return 'font-print';
            case 'console':
                return 'font-console';
            case 'cursive':
                return 'font-cursive';
            case 'casual':
                return 'font-casual';
            case 'smallcaps':
                return 'font-smallcaps';
            case 'poppins':
                return 'font-poppins';
            case 'roboto':
                return 'font-roboto';
            case 'google':
                return 'font-google';
            case 'noto-arabic':
                return 'font-noto-arabic';
            case 'pixelart':
                return 'font-pixelart';
            default:
                return 'font-default';
        }
    },
    getFontFamily: (settingKey = 'subtitleFont') => {
        const font = PlayerSettings.get(settingKey) || '';
        switch (font) {
            case 'typewriter':
                return 'Courier Prime';
            case 'print':
                return 'Merriweather';
            case 'console':
                return 'Inconsolata';
            case 'cursive':
                return 'Dancing Script';
            case 'casual':
                return 'Patrick Hand';
            case 'smallcaps':
                return 'Cinzel';
            case 'poppins':
                return 'Poppins';
            case 'roboto':
                return 'Roboto';
            case 'google':
                return 'Google Sans';
            case 'noto-arabic':
                return 'Noto Sans Arabic';
            case 'pixelart':
                return 'Silkscreen';
            default:
                return 'TizenSans';
        }
    },
    getFontScale: (settingKey = 'subtitleFont') => {
        const font = PlayerSettings.get(settingKey) || '';
        const userScale = PlayerSettings.get('subtitleFontScale') ?? 1.0;

        let baseScale = 1.0;
        switch (font) {
            case 'noto-arabic':
                baseScale = 2.0; // Noto Arabic is visually much smaller/thinner
                break;
        }

        return baseScale * userScale;
    }
};
