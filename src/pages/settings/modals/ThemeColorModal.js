/**
 * ============================================================================
 * Litefin Tizen - Theme Color Palette Selection Modal Dialog Controller
 * ============================================================================
 * Manages the accent color picker dialog featuring 50 curated theme swatches:
 * - Dynamic live-preview swatch and title in the modal header
 * - 10-column spatial navigation grid optimized for TV remotes and D-pads
 * - Synchronous state updates with LayoutManager and live page trigger indicators
 * - Graceful focus management and restoration upon modal dismissal
 * ============================================================================
 */

import { focusManager } from '../../../ui/FocusManager.js';
import { layoutManager } from '../../../ui/LayoutManager.js';
import { eventBus } from '../../../core/EventBus.js';
import { i18n } from '../../../utils/i18n.js';
import { escapeHtml } from '../../../utils/Utils.js';
import { logger } from '../../../utils/Logger.js';

const log = logger.create('ThemeColorModal');

/**
 * Returns the complete curated catalog of 50 theme accent swatches.
 * Organized across 5 distinct tonal tiers: Primary, Vibrant, Classic, Pastel, and Earthy.
 *
 * @returns {Array<{ name: string, hex: string }>} List of theme colors
 */
export function getThemeColors() {
    return [
        // Row 1: Primary Swatches
        { name: 'Litefin Purple Blue', hex: '#6b6ede' },
        { name: 'Jellyfin Blue', hex: '#00a4dc' },
        { name: 'Litefin Blue', hex: '#007aff' },
        { name: 'Royal Blue', hex: '#2962ff' },
        { name: 'Deep Purple', hex: '#6200ea' },
        { name: 'Lavender', hex: '#af52de' },
        { name: 'Purple Haze', hex: '#9d50bb' },
        { name: 'Magenta', hex: '#d500f9' },
        { name: 'Pink', hex: '#ff2d55' },
        { name: 'Rose', hex: '#ff007f' },

        // Row 2: Vibrant Palette
        { name: 'Red', hex: '#f44336' },
        { name: 'Orange', hex: '#ff9800' },
        { name: 'Amber', hex: '#ffc107' },
        { name: 'Yellow', hex: '#ffeb3b' },
        { name: 'Lime', hex: '#c6ff00' },
        { name: 'Green', hex: '#4caf50' },
        { name: 'Emerald', hex: '#00c853' },
        { name: 'Mint', hex: '#00c7be' },
        { name: 'Teal', hex: '#009688' },
        { name: 'Cyan', hex: '#00bcd4' },

        // Row 3: Sophisticated & Classic
        { name: 'Sky', hex: '#03a9f4' },
        { name: 'Ocean', hex: '#0077be' },
        { name: 'Slate', hex: '#607d8b' },
        { name: 'Graphite', hex: '#3a3a3c' },
        { name: 'Silver', hex: '#9e9e9e' },
        { name: 'Coffee', hex: '#795548' },
        { name: 'Brown', hex: '#a2845e' },
        { name: 'Copper', hex: '#b87333' },
        { name: 'Gold', hex: '#d4af37' },
        { name: 'White', hex: '#ffffff' },

        // Row 4: Pastel & Nuance
        { name: 'Periwinkle', hex: '#8F9FFF' },
        { name: 'Emerald Green', hex: '#00A86B' },
        { name: 'Turquoise', hex: '#40E0D0' },
        { name: 'Warm Amber', hex: '#FFBF00' },
        { name: 'Rose Gold', hex: '#B76E79' },
        { name: 'Midnight Indigo', hex: '#4B0082' },
        { name: 'Coral', hex: '#FF6F61' },
        { name: 'Aqua Marine', hex: '#7FFFD4' },
        { name: 'Fresh Mint', hex: '#3EB489' },
        { name: 'Electric Lime', hex: '#7FFF00' },

        // Row 5: Deep & Earthy
        { name: 'Indigo', hex: '#5856d6' },
        { name: 'Sea Green', hex: '#2E8B57' },
        { name: 'Cadet Blue', hex: '#5F9EA0' },
        { name: 'Burnt Orange', hex: '#CC5500' },
        { name: 'Dark Turquoise', hex: '#00CED1' },
        { name: 'Firebrick', hex: '#B22222' },
        { name: 'Olive', hex: '#708238' },
        { name: 'Plum', hex: '#8E4585' },
        { name: 'Deep Sky', hex: '#00BFFF' },
        { name: 'Royal Purple', hex: '#7851A9' }
    ];
}

/**
 * Modal controller managing user interaction with the theme color palette dialog.
 */
export class ThemeColorModal {
    /**
     * Initializes a new instance of ThemeColorModal.
     * @param {Object} page Host SettingsPage instance
     */
    constructor(page) {
        this.page = page;
        this._modalFocusChangedHandler = null;
    }

    /**
     * Retrieves the theme colors list.
     * @returns {Array<{ name: string, hex: string }>} List of theme colors
     */
    getThemeColors() {
        return getThemeColors();
    }

    /**
     * Opens the theme color modal dialog.
     */
    open() {
        log.debug('Opening ThemeColorModal');
        const overlay = this.page ? this.page.$('#modal-overlay') : document.getElementById('modal-overlay');
        if (!overlay) return;

        // Save current focus and active section for seamless restoration upon dismissal
        this.page._prevFocus = focusManager.getFocused();
        this.page._prevSection = focusManager.getActiveSection();

        const colors = getThemeColors();
        const currentColor = (layoutManager.getThemeColor() || '#00a4dc').toLowerCase();
        const activeObj = colors.find((c) => c.hex.toLowerCase() === currentColor) || {
            name: 'Jellyfin Blue',
            hex: currentColor
        };

        // Render modal markup
        overlay.innerHTML = `
            <div class="settings-modal theme-color-modal" role="dialog" aria-modal="true">
                <div class="modal-header theme-color-modal-header">
                    <h2 data-i18n="ThemeColor">${i18n.t('ThemeColor') || 'Theme Color'}</h2>
                    <div class="theme-color-modal-header-preview" id="theme-color-modal-live-preview">
                        <span class="preview-dot" id="theme-color-preview-dot" style="background-color: ${activeObj.hex};"></span>
                        <span class="preview-name" id="theme-color-preview-name">${escapeHtml(activeObj.name)}</span>
                    </div>
                </div>
                <div class="modal-options theme-color-modal-grid-container">
                    <div class="theme-color-modal-grid" id="theme-color-modal-grid">
                        ${colors
                            .map(
                                (c) => `
                            <button class="color-option ${currentColor === c.hex.toLowerCase() ? 'active' : ''}" 
                                    data-color="${c.hex}"
                                    data-name="${escapeHtml(c.name)}"
                                    title="${escapeHtml(c.name)}"
                                    tabindex="0"
                                    data-focusable="true">
                                <div class="color-option-fill" style="background-color: ${c.hex};"></div>
                            </button>
                        `
                            )
                            .join('')}
                    </div>
                </div>
                <div class="modal-actions">
                    <button class="modal-action-btn" id="btn-modal-cancel" tabindex="0" data-i18n="ButtonCancel">${i18n.t('ButtonCancel') || 'Cancel'}</button>
                </div>
            </div>
        `;

        // Make modal overlay visible
        overlay.classList.add('visible');
        overlay.setAttribute('aria-hidden', 'false');

        const previewDot = overlay.querySelector('#theme-color-preview-dot');
        const previewName = overlay.querySelector('#theme-color-preview-name');

        // Centralized routine to update header live preview swatch and label
        const updatePreviewForColor = (color, name) => {
            if (previewDot && color) previewDot.style.backgroundColor = color;
            if (previewName && name) previewName.textContent = name;
        };

        // Bind interactive color swatch click, focus, and hover events
        overlay.querySelectorAll('.color-option').forEach((btn) => {
            const color = btn.dataset.color;
            const name = btn.dataset.name;

            const updatePreview = () => {
                updatePreviewForColor(color, name);
            };

            btn.addEventListener('focus', updatePreview);
            btn.addEventListener('mouseenter', updatePreview);

            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                layoutManager.setThemeColor(color);

                // Synchronize trigger button badge and label in main settings view
                if (this.page) {
                    const triggerBadge = this.page.$('#btn-theme-color-picker .theme-color-swatch-badge');
                    const triggerLabel = this.page.$('#theme-color-btn-label');
                    if (triggerBadge) triggerBadge.style.backgroundColor = color;
                    if (triggerLabel) triggerLabel.textContent = name;
                }

                this.close();
            });
        });

        // Listen for spatial navigation focus updates across color swatches
        if (this._modalFocusChangedHandler) {
            eventBus.off('focus:changed', this._modalFocusChangedHandler);
        }
        this._modalFocusChangedHandler = (focusedEl) => {
            if (!focusedEl) return;
            const optionBtn = focusedEl.closest ? focusedEl.closest('.color-option') : null;
            if (optionBtn && optionBtn.dataset) {
                updatePreviewForColor(optionBtn.dataset.color, optionBtn.dataset.name);
            }
        };
        eventBus.on('focus:changed', this._modalFocusChangedHandler);

        // Cancel button dismisses modal
        overlay.querySelector('#btn-modal-cancel').addEventListener('click', (e) => {
            e.stopPropagation();
            this.close();
        });

        // Register Focus Section for grid swatches (10 columns)
        this.page.registerFocusSection('modal-color-grid', overlay.querySelector('#theme-color-modal-grid'), {
            orientation: 'grid',
            columns: 10,
            leaveDown: 'modal-actions',
            enterTo: 'last-focused'
        });

        // Register Focus Section for action buttons (Cancel)
        this.page.registerFocusSection('modal-actions', overlay.querySelector('.modal-actions'), {
            orientation: 'horizontal',
            leaveUp: 'modal-color-grid',
            onMove: (direction) => {
                if (direction === 'down') {
                    focusManager.setActiveSection('modal-color-grid', true, null, { enterTo: 'first' });
                    return true;
                }
                return false;
            }
        });

        // Activate grid section and focus currently selected color
        focusManager.setActiveSection('modal-color-grid');
        setTimeout(() => {
            const activeSwatch =
                overlay.querySelector('.color-option.active') || overlay.querySelector('.color-option');
            if (activeSwatch) {
                focusManager.focusElement(activeSwatch);
            }
        }, 50);
    }

    /**
     * Closes the theme color modal and restores previous focus.
     */
    close() {
        if (this._modalFocusChangedHandler) {
            eventBus.off('focus:changed', this._modalFocusChangedHandler);
            this._modalFocusChangedHandler = null;
        }

        if (this.page && typeof this.page._closeSelectionModal === 'function') {
            this.page._closeSelectionModal();
        }
    }

    /**
     * Cleans up all event listeners and state.
     */
    destroy() {
        if (this._modalFocusChangedHandler) {
            eventBus.off('focus:changed', this._modalFocusChangedHandler);
            this._modalFocusChangedHandler = null;
        }
    }
}

export default ThemeColorModal;
