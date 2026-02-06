/**
 * SubtitleAppearanceHelper - Subtitle Style Utilities
 * 
 * Generates CSS styles from subtitle appearance settings.
 * Ported from jellyfin-web's subtitleappearancehelper.js
 * 
 * @module subtitles/SubtitleAppearanceHelper
 */

// ============================================================================
// Text Styles Generator
// ============================================================================

/**
 * Generate text CSS styles from appearance settings
 * @param {Object} settings - Subtitle appearance settings
 * @param {boolean} preview - Whether this is for preview mode (skips positioning)
 * @returns {Object[]} Array of {name, value} CSS properties
 */
export function getTextStyles(settings, preview = false) {
    const styles = [];

    // ========================================================================
    // Font Size
    // Options: smaller, small, medium, large, larger, extralarge
    // ========================================================================
    switch (settings.subtitleSize || 'medium') {
        case 'extralarge':
            styles.push({ name: 'fontSize', value: '7.0em' });
            break;
        case 'larger':
            styles.push({ name: 'fontSize', value: '5.2em' });
            break;
        case 'large':
            styles.push({ name: 'fontSize', value: '4.5em' });
            break;
        case 'small':
            styles.push({ name: 'fontSize', value: '3.0em' });
            break;
        case 'smaller':
            styles.push({ name: 'fontSize', value: '2.2em' });
            break;
        case 'medium':
        default:
            styles.push({ name: 'fontSize', value: '3.8em' });
            break;
    }

    // ========================================================================
    // Font Weight
    // Options: normal, bold
    // ========================================================================
    switch (settings.subtitleWeight || 'normal') {
        case 'bold':
            styles.push({ name: 'fontWeight', value: 'bold' });
            break;
        case 'normal':
        default:
            styles.push({ name: 'fontWeight', value: 'normal' });
            break;
    }

    // ========================================================================
    // Text Shadow / Drop Shadow
    // Options: dropshadow, raised, depressed, uniform, none
    // ========================================================================
    switch (settings.subtitleDropShadow || 'dropshadow') {
        case 'heavy':
            styles.push({ name: 'textShadow', value: '#000000 0px 0px 0.3em' });
            break;
        case 'raised':
            styles.push({
                name: 'textShadow',
                value: '-0.04em -0.04em #fff, 0px -0.04em #fff, -0.04em 0px #fff, 0.04em 0.04em #000, 0px 0.04em #000, 0.04em 0px #000'
            });
            break;
        case 'depressed':
            styles.push({
                name: 'textShadow',
                value: '0.04em 0.04em #fff, 0px 0.04em #fff, 0.04em 0px #fff, -0.04em -0.04em #000, 0px -0.04em #000, -0.04em 0px #000'
            });
            break;
        case 'uniform':
            styles.push({
                name: 'textShadow',
                value: '#000 0px 0.03em, #000 0px -0.03em, #000 0.03em 0px, #000 -0.03em 0px, #000 0.03em 0.03em, #000 -0.03em 0.03em, #000 0.03em -0.03em, #000 -0.03em -0.03em'
            });
            break;
        case 'none':
            styles.push({ name: 'textShadow', value: 'none' });
            break;
        case 'dropshadow':
        default:
            styles.push({ name: 'textShadow', value: '#000000 0px 0px 0.15em' });
            break;
    }

    // ========================================================================
    // Text Color
    // ========================================================================
    const textColor = settings.subtitleTextColor || '#ffffff';
    styles.push({ name: 'color', value: textColor });

    // ========================================================================
    // Background Color
    // ========================================================================
    const background = settings.subtitleTextBackground || 'transparent';
    styles.push({ name: 'backgroundColor', value: background });

    // ========================================================================
    // Font Family
    // Options: default, typewriter, print, console, cursive, casual, smallcaps
    // ========================================================================
    switch (settings.subtitleFont || '') {
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
    if (!preview) {
        const pos = parseInt(settings.subtitleVerticalPosition, 10) || -3;
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
    }

    return styles;
}

// ============================================================================
// Window/Container Styles Generator
// ============================================================================

/**
 * Generate container/window CSS styles from appearance settings
 * @param {Object} settings - Subtitle appearance settings
 * @param {boolean} preview - Whether this is for preview mode
 * @returns {Object[]} Array of {name, value} CSS properties
 */
export function getWindowStyles(settings, preview = false) {
    const styles = [];

    if (!preview) {
        const pos = parseInt(settings.subtitleVerticalPosition, 10) || -3;

        if (pos < 0) {
            // Position at bottom
            styles.push({ name: 'top', value: '' });
            styles.push({ name: 'bottom', value: '0' });
        } else {
            // Position at top
            styles.push({ name: 'top', value: '0' });
            styles.push({ name: 'bottom', value: '' });
        }
    }

    return styles;
}

// ============================================================================
// Apply Styles to Elements
// ============================================================================

/**
 * Apply style list to a DOM element
 * @param {Object[]} styles - Array of {name, value} CSS properties
 * @param {HTMLElement} element - Target element
 */
function applyStyleList(styles, element) {
    if (!element) return;

    for (const style of styles) {
        if (style.value !== undefined && style.value !== '') {
            element.style[style.name] = style.value;
        }
    }
}

/**
 * Apply subtitle appearance settings to elements
 * @param {Object} elements - { text: HTMLElement, window: HTMLElement, preview?: boolean }
 * @param {Object} settings - Subtitle appearance settings
 */
export function applyStyles(elements, settings) {
    const textStyles = getTextStyles(settings, !!elements.preview);
    const windowStyles = getWindowStyles(settings, !!elements.preview);

    if (elements.text) {
        applyStyleList(textStyles, elements.text);
    }
    if (elements.window) {
        applyStyleList(windowStyles, elements.window);
    }
}

/**
 * Get all styles as an object (useful for inline style generation)
 * @param {Object} settings - Subtitle appearance settings
 * @param {boolean} preview - Whether this is for preview mode
 * @returns {Object} { text: Object[], window: Object[] }
 */
export function getStyles(settings, preview = false) {
    return {
        text: getTextStyles(settings, preview),
        window: getWindowStyles(settings, preview)
    };
}

// ============================================================================
// CSS String Generator (for style elements)
// ============================================================================

/**
 * Generate CSS string for VTT/WebVTT cue styling
 * @param {Object} settings - Subtitle appearance settings
 * @param {string} selector - CSS selector for the video element
 * @returns {string} CSS rule string
 */
export function getCueCss(settings, selector = 'video') {
    const styles = getTextStyles(settings);
    const cssProperties = styles
        .filter(s => s.value !== undefined && s.value !== '')
        .map(s => `${toKebabCase(s.name)}: ${s.value} !important;`)
        .join(' ');

    return `${selector}::cue { ${cssProperties} }`;
}

/**
 * Convert camelCase to kebab-case
 * @param {string} str - camelCase string
 * @returns {string} kebab-case string
 */
function toKebabCase(str) {
    return str.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

// Default export with all functions
export default {
    getTextStyles,
    getWindowStyles,
    applyStyles,
    getStyles,
    getCueCss
};
