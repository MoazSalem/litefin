/**
 * ============================================================================
 * Litefin Tizen - Settings Slider Component
 * ============================================================================
 * Reusable range slider component for the Settings interface. Handles HTML
 * markup generation, visual fill progress synchronization, real-time value
 * display label updates, and direct persistence to PlayerSettings.
 * ============================================================================
 */

import { PlayerSettings } from '../../../utils/PlayerSettings.js';

/**
 * Registry mapping DOM slider control element IDs to PlayerSettings storage keys.
 */
const SLIDER_SETTINGS_MAP = {
    'subtitle-text-opacity': 'subtitleTextOpacity',
    'subtitle-text-opacity-hdr': 'subtitleTextOpacityHdr',
    'subtitle-pgs-opacity': 'subtitlePgsOpacity',
    'subtitle-pgs-opacity-hdr': 'subtitlePgsOpacityHdr',
    'subtitle-bg-opacity': 'subtitleBackgroundOpacity',
    'subtitle-border-opacity': 'subtitleBorderOpacity',
    'subtitle-shadow-opacity': 'subtitleDropShadowOpacity',
    'subtitle-shadow-blur': 'subtitleDropShadowBlur',
    'subtitle-custom-pos': 'subtitleVerticalPositionCustom',
    'subtitle-font-scale': 'subtitleFontScale',
    'subtitle-outline-thickness': 'subtitleOutlineThickness',
    'subtitle-shadow-thickness': 'subtitleShadowThickness',
    'subtitle-line-height': 'subtitleLineHeight',
    'subtitle-letter-spacing': 'subtitleLetterSpacing',
    'subtitle-bottom-offset': 'subtitleBottomOffset',
    'subtitle-custom-size': 'subtitleSizeCustomValue',
    'osd-track-menu-bg-opacity': 'osdTrackMenuBgOpacity',
    'osd-gradient-opacity': 'osdGradientOpacity'
};

const FLOAT_SETTING_KEYS = new Set([
    'subtitleFontScale',
    'subtitleSizeCustomValue',
    'subtitleOutlineThickness',
    'subtitleShadowThickness',
    'subtitleLetterSpacing'
]);

/**
 * SettingsSlider manages rendering and interaction binding for range inputs.
 */
export class SettingsSlider {
    /**
     * Creates an instance of SettingsSlider.
     * @param {Object} page Host SettingsPage instance
     */
    constructor(page) {
        this.page = page;
    }

    /**
     * Renders markup for a range slider input with track, fill, and value indicator.
     *
     * @param {string} id Unique slider DOM element ID
     * @param {number|string} value Initial or saved value
     * @param {number|string} min Minimum allowed range value
     * @param {number|string} max Maximum allowed range value
     * @param {number|string} step Step granularity
     * @param {string} [unit='%'] Display suffix unit (e.g. '%', 'px', 'em')
     * @returns {string} Serialized HTML markup string
     */
    render(id, value, min, max, step, unit = '%') {
        // Calculate progress percentage for track fill width
        const minNum = parseFloat(min);
        const maxNum = parseFloat(max);
        const valNum = parseFloat(value);
        const percent = ((valNum - minNum) / (maxNum - minNum)) * 100;

        return `
            <div class="slider-wrapper">
                <div class="slider-container">
                    <div class="slider-track">
                        <div class="slider-fill" style="width: ${percent}%"></div>
                    </div>
                    <input type="range" 
                        id="${id}" 
                        class="setting-slider" 
                        min="${min}" 
                        max="${max}" 
                        step="${step}" 
                        value="${value}"
                        data-unit="${unit}"
                        tabindex="0"
                        data-focusable="true">
                </div>
                <span class="slider-value" id="${id}-value">${value}${unit}</span>
            </div>
        `;
    }

    /**
     * Binds real-time input event listeners and initializes visual progress on sliders.
     */
    bindEvents() {
        const sliders = this.page.$$('.setting-slider');
        if (!sliders || !sliders.length) return;

        // Attach input listener to each active range slider
        sliders.forEach((slider) => {
            slider.addEventListener('input', (e) => {
                const id = slider.id;
                const value = e.target.value;
                const key = SLIDER_SETTINGS_MAP[id];
                const unit = slider.dataset.unit || '%';

                // Synchronize dynamic text value readout
                const valueDisplay = this.page.$(`#${id}-value`);
                if (valueDisplay) {
                    valueDisplay.textContent = `${value}${unit}`;
                }

                // Update visual track progress and fill bar width
                this._updateVisualFill(slider, value);

                // Persist updated numeric value into PlayerSettings storage
                if (key) {
                    const parsedValue = FLOAT_SETTING_KEYS.has(key)
                        ? parseFloat(value)
                        : parseInt(value, 10);
                    PlayerSettings.set(key, parsedValue);
                }
            });

            // Force initial layout synchronization for hardware TV webviews
            this._updateVisualFill(slider, slider.value);
        });
    }

    /**
     * Updates CSS custom property progress and fill bar width.
     * @private
     * @param {HTMLInputElement} slider Target input slider
     * @param {number|string} value Active numeric value
     */
    _updateVisualFill(slider, value) {
        const min = parseFloat(slider.min);
        const max = parseFloat(slider.max);
        const current = parseFloat(value);
        const percent = ((current - min) / (max - min)) * 100;

        const container = slider.closest('.slider-container');
        if (container) {
            const track = container.querySelector('.slider-track');
            const fill = container.querySelector('.slider-fill');
            if (track) track.style.setProperty('--progress', `${percent}%`);
            if (fill) fill.style.width = `${percent}%`;
        }
    }
}

export default SettingsSlider;
