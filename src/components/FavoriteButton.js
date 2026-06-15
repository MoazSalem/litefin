/**
 * ============================================================================
 * Litefin Tizen - Favorite Button Component
 * ============================================================================
 * Reusable favorite toggle button.
 * Handles API calls and state updates internally.
 * ============================================================================
 */

import Component from '../core/Component.js';
import { api } from '../api/index.js';
import { logger } from '../utils/Logger.js';
import { detailsIcons } from '../utils/Icons.js';

const log = logger.create('FavoriteButton');

class FavoriteButton extends Component {
    constructor(config = {}) {
        super(config);

        this.itemId = config.itemId;
        this.isFavorite = !!config.initialState;
        this.onChange = config.onChange || (() => {});
        this.className = config.className || 'btn btn-icon favorite-btn';
        this.id = config.id || `fav-${this.itemId}`;
    }

    render() {
        const activeClass = this.isFavorite ? 'active' : '';
        const iconInfo = this._getIcon();

        return `
            <button class="${this.className} ${activeClass}" id="${this.id}" tabindex="0" aria-label="Favorite">
                ${iconInfo}
            </button>
        `;
    }

    _getIcon() {
        // Return active/filled or inactive/outlined favorite heart SVG from detailsIcons helper
        return this.isFavorite ? detailsIcons.favoriteFilled : detailsIcons.favoriteOutline;
    }

    onMounted() {
        if (this.el) {
            this.el.onclick = (e) => {
                e.stopPropagation(); // Prevent bubbling if needed
                this.toggle();
            };
        }
    }

    async toggle() {
        try {
            if (this.isFavorite) {
                await api.unmarkFavorite(this.itemId);
                this.isFavorite = false;
            } else {
                await api.markFavorite(this.itemId);
                this.isFavorite = true;
            }

            // Update UI properly (without nesting buttons)
            if (this.el) {
                // Add pulse animation trigger
                this.el.classList.remove('pulse-trigger');
                void this.el.offsetWidth; // Force reflow
                this.el.classList.add('pulse-trigger');
                setTimeout(() => this.el.classList.remove('pulse-trigger'), 500);

                // Update class
                if (this.isFavorite) {
                    this.el.classList.add('active');
                } else {
                    this.el.classList.remove('active');
                }
                // Update icon
                this.el.innerHTML = this._getIcon();
            }

            // Notify parent
            this.onChange(this.isFavorite);
        } catch (error) {
            log.error('Failed to toggle', error);
        }
    }
}

export default FavoriteButton;
