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
        if (this.isFavorite) {
            // Filled Heart (Active)
            return `
                <svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path>
                </svg>
            `;
        } else {
            // Outline Heart (Inactive)
            return `
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path>
                </svg>
            `;
        }
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
