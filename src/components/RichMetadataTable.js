import { i18n } from '../utils/i18n.js';
import { focusManager } from '../ui/FocusManager.js';
import { logger } from '../utils/Logger.js';

const log = logger.create('RichMetadataTable');

/**
 * Reusable Rich Metadata Table component for rendering interactive metadata chips
 * (Genres, Directors, Writers, Studios, Tags, EXIF data, etc.) with keyboard focus trapping.
 */
export class RichMetadataTable {
    /**
     * @param {Object} options
     * @param {HTMLElement} options.container - The element (#rich-meta) to render into
     * @param {HTMLElement} [options.containerWrapper] - The wrapper element (#rich-meta-container)
     * @param {Function} [options.onChipClick] - Callback when a metadata chip is clicked/selected
     */
    constructor({ container, containerWrapper = null, onChipClick = null }) {
        this._container = container;
        this._containerWrapper = containerWrapper;
        this._onChipClick = onChipClick;
        this._isActive = false;
    }

    /**
     * Helper to build HTML for a row of chips (Genres, Directors, etc.)
     * @param {string} labelKey - i18n key or direct label string
     * @param {Array<Object|string>} items - Items array
     * @returns {string} HTML string
     */
    static createChipRow(labelKey, items) {
        if (!items || items.length === 0) return '';
        const translatedLabel = i18n.t(labelKey) || labelKey;
        const valuesHtml = items
            .map((i) => {
                const name = typeof i === 'string' ? i : (i.Name || i);
                const id = typeof i === 'object' && i.Id ? i.Id : '';
                const type = labelKey.toLowerCase();

                return `<button class="meta-chip" tabindex="-1" data-id="${id}" data-type="${type}" data-name="${name}">${name}</button>`;
            })
            .join('');

        return `
            <div class="rich-meta-row">
                <div class="meta-label">${translatedLabel}</div>
                <div class="meta-value-list">${valuesHtml}</div>
            </div>
        `;
    }

    /**
     * Helper to build HTML for plain text metadata (EXIF info, etc.)
     * @param {string} label
     * @param {string} value
     * @returns {string} HTML string
     */
    static createTextRow(label, value) {
        if (!value) return '';
        return `
            <div class="rich-meta-row">
                <div class="meta-label">${label}</div>
                <div class="meta-value-text">${value}</div>
            </div>
        `;
    }

    /**
     * Renders rows HTML into container and sets up focus & activation handlers
     * @param {string} htmlContent
     */
    render(htmlContent) {
        if (!this._container) return;

        if (!htmlContent) {
            this._container.innerHTML = '';
            if (this._containerWrapper) this._containerWrapper.classList.add('hidden');
            return;
        }

        this._container.innerHTML = htmlContent;
        if (this._containerWrapper) this._containerWrapper.classList.remove('hidden');

        // Make container focusable as a single unit
        this._container.setAttribute('tabindex', '0');
        this._container.classList.add('focusable');

        const activateHandler = (e) => {
            if (e.type === 'keydown' && e.keyCode !== 13) return;
            if (e.target.classList.contains('meta-chip') && this._isActive) return;

            e.preventDefault();
            e.stopPropagation();
            this.activate();
        };

        this._container.onclick = activateHandler;
        this._container.onkeydown = activateHandler;
    }

    /**
     * Activates trap mode inside the rich meta container to focus individual chips
     */
    activate() {
        if (this._isActive || !this._container) return;

        this._isActive = true;
        this._container.classList.add('active-table');

        const chips = this._container.querySelectorAll('.meta-chip');
        chips.forEach((chip) => chip.setAttribute('tabindex', '0'));
        this._container.setAttribute('tabindex', '-1');

        requestAnimationFrame(() => {
            const validChips = this._container.querySelectorAll('.meta-chip');
            if (validChips.length === 0) {
                log.warn('RichMetadataTable: No chips found on activation, reverting');
                this.deactivate();
                return;
            }

            validChips.forEach((chip) => {
                chip.onclick = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (this._onChipClick) this._onChipClick(chip);
                };

                chip.onkeydown = (e) => {
                    if (e.keyCode === 13) {
                        e.preventDefault();
                        e.stopPropagation();
                        if (this._onChipClick) this._onChipClick(chip);
                    }
                };
            });

            focusManager.pushTrap(this._container, {
                selector: '.meta-chip',
                orientation: 'grid'
            });

            focusManager.focusElement(validChips[0]);
        });
    }

    /**
     * Deactivates trap mode and returns focus to the table container
     */
    deactivate() {
        if (!this._isActive || !this._container) return;

        this._isActive = false;
        this._container.classList.remove('active-table');

        const chips = this._container.querySelectorAll('.meta-chip');
        chips.forEach((chip) => chip.setAttribute('tabindex', '-1'));

        focusManager.popTrap();
        this._container.setAttribute('tabindex', '0');
        focusManager.focusElement(this._container);
    }

    /**
     * @returns {boolean} Whether trap mode is active
     */
    isActive() {
        return this._isActive;
    }
}
