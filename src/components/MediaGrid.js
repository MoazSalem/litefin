/**
 * ============================================================================
 * Litefin Tizen - MediaGrid Component
 * ============================================================================
 * Reusable grid component for displaying media items (Movies, Shows, Episodes).
 * Handles rendering, "See More" expansion, and basic focus rendering support.
 * ============================================================================
 */

import Component from '../core/Component.js';
import { focusManager } from '../ui/FocusManager.js';
import { router } from '../core/Router.js';
import { i18n } from '../utils/i18n.js';

import CardRenderer from '../utils/CardRenderer.js';
import { lazyLoader } from '../utils/LazyLoader.js';
import { logger } from '../utils/Logger.js';

const log = logger.create('MediaGrid');

class MediaGrid extends Component {
    constructor(config = {}) {
        super(config);

        this.id = config.id || `grid-${Math.random().toString(36).substr(2, 9)}`;
        this.title = config.title || '';
        this.items = config.items || [];
        this.limit = config.limit || 12;
        this.type = config.type || 'poster'; // 'poster', 'episode', 'episode-primary'
        this.contextType = config.contextType || null;
        this.isLandscape = config.isLandscape || false;
        this.gridClass = config.gridClass || '';
        this.allowSeeMore = config.allowSeeMore !== undefined ? config.allowSeeMore : true;

        // Path for "See More" navigation (Standard pattern replacing in-place expansion)
        this.moreUrl = config.moreUrl || null;

        // Callbacks
        this.onSeeMore = config.onSeeMore || null; // Optional override
        this.onClick = config.onClick || null; // Optional override for click handling
    }

    render() {
        // If no items, return empty or hidden
        if (!this.items || this.items.length === 0) {
            return `<div id="${this.id}" class="media-row hidden"></div>`;
        }

        const gridId = `${this.id}-items`;
        const btnId = `${this.id}-btn`;

        // landscape-grid class?
        const gridClass = this.gridClass || (this.isLandscape ? 'person-grid landscape-grid' : 'person-grid');

        // Note: Standard See More buttons usually redirect to LibraryPage rather than expanding in-place
        // to handle thousands of items efficiently on TV hardware.
        return `
            <div id="${this.id}" class="media-row">
                ${this.title ? `<h2 class="row-title">${this.title}</h2>` : ''}
                <div class="${gridClass}" id="${gridId}">
                    ${this._renderItems()}
                </div>
                
                <div class="see-more-container" id="${this.id}-btn-zone" style="display: ${this._shouldShowButton() ? 'flex' : 'none'}; justify-content: center;">
                    <button class="btn see-more-btn" id="${btnId}" tabindex="0">
                        ${i18n.t('SeeMore')}
                    </button>
                </div>
            </div>
        `;
    }

    /**
     * Re-render logic after mount/update
     */
    onMounted() {
        log.debug(`Mounted with ${this.items.length} items.`);

        this._btn = document.getElementById(`${this.id}-btn`);
        if (this._btn) {
            this._btn.onclick = () => this.handleSeeMore();
            this._btn.onkeydown = (e) => {
                if (e.key === 'Enter' || e.key === ' ' || e.key === 'Space') {
                    this.handleSeeMore();
                }
            };
        }

        this._updateButtonVisibility();

        this._gridEl = document.getElementById(`${this.id}-items`);
        if (this._gridEl) {
            let lastActivateTime = 0;
            this._handleActivate = (e) => {
                const card = e.target.closest('.media-card');
                if (card) {
                    const now = Date.now();
                    if (now - lastActivateTime < 400) return;
                    lastActivateTime = now;

                    if (this.onClick) {
                        this.onClick(card);
                    } else if (card.dataset.itemId) {
                        const itemId = card.dataset.itemId;
                        const itemType = card.dataset.type;

                        if (
                            itemType === 'Person' ||
                            itemType === 'MusicArtist' ||
                            itemType === 'Artist' ||
                            itemType === 'AlbumArtist'
                        ) {
                            log.debug('Navigating to PersonPage:', itemId);
                            router.navigate(`/person/${itemId}`);
                        } else {
                            log.debug('Navigating to item details:', itemId);
                            router.navigate(`/details/${itemId}`);
                        }
                    }
                }
            };

            this._gridEl.addEventListener('mousedown', this._handleActivate);
            this._gridEl.addEventListener('click', this._handleActivate);

            lazyLoader.observe(this._gridEl);
        }
    }

    destroy() {
        if (this._btn) {
            this._btn.onclick = null;
            this._btn.onkeydown = null;
            this._btn = null;
        }
        if (this._gridEl) {
            this._gridEl.removeEventListener('mousedown', this._handleActivate);
            this._gridEl.removeEventListener('click', this._handleActivate);
            this._gridEl = null;
        }
        this._handleActivate = null;
        this.items = null;
        super.destroy();
    }

    /**
     * Render the grid items strings
     */
    _renderItems() {
        const items = this._shouldShowButton() ? this.items.slice(0, this.limit) : this.items;

        const html = [];
        for (let i = 0; i < items.length; i++) {
            html.push(this._createCardHtml(items[i]));
        }
        return html.join('');
    }

    /**
     * Handle "See More" action
     */
    handleSeeMore() {
        // Priority 1: Direct navigation (New standard)
        if (this.moreUrl) {
            log.info('Standardized See More: Navigating to', this.moreUrl);
            router.navigate(this.moreUrl);
            return;
        }

        // Priority 2: Custom callback
        if (this.onSeeMore) {
            this.onSeeMore();
            return;
        }

        // Fallback: In-place expansion (Deprecated for most grids)
        // We'll keep this simple for now but ideally all grids use moreUrl
        log.warn('MediaGrid: Using deprecated in-place expansion. Please provide moreUrl.');

        const grid = document.getElementById(`${this.id}-items`);
        if (grid) {
            // Render ALL items
            const html = [];
            for (let i = 0; i < this.items.length; i++) {
                html.push(this._createCardHtml(this.items[i]));
            }
            grid.innerHTML = html.join('');
            lazyLoader.observe(grid);

            // Hide the button since everything is shown
            this._hideButton();

            // Invalidate focus cache
            focusManager.invalidateCache(`${this.id}-items`);
        }
    }

    _hideButton() {
        const btnContainer = document.getElementById(`${this.id}-btn-zone`);
        if (btnContainer) btnContainer.style.display = 'none';
    }

    _shouldShowButton() {
        return this.allowSeeMore && this.items.length > this.limit;
    }

    _updateButtonVisibility() {
        const btnContainer = document.getElementById(`${this.id}-btn-zone`);
        if (btnContainer) {
            if (this._shouldShowButton()) {
                btnContainer.style.display = 'flex';
                btnContainer.style.justifyContent = 'center';
                const btn = btnContainer.querySelector('.see-more-btn');
                if (btn) btn.style.display = '';
            } else {
                btnContainer.style.display = 'none';
            }
        }
    }

    // NOTE: Card click handling is now done via event delegation in onMounted().
    // The single listener on the grid container uses e.target.closest('.media-card')
    // and survives innerHTML rebuilds in toggleExpand() automatically.

    /**
     * Helper to render card HTML (Copied/Adapted from Page.js)
     *Ideally this logic should be in a separate MediaCard component or helper,
     * but for now we duplicate the logic to keep this component meaningful self-contained
     * or accept a render callback.
     *
     * To properly "Extract", I should probably move the `_renderMediaCard` logic from Page.js
     * to a shared utility or keep using Page.js if this component is used inside a page.
     *
     * BUT: Since this is a standalone component, it doesn't extend Page.js.
     * I will create a static helper in a new file `src/utils/CardRenderer.js` OR
     * just implment it here. Implementing here for now to match `Page.js` exactly.
     */
    _createCardHtml(item) {
        // ==========================================================
        // Grid Card Rendering
        // ==========================================================
        // Passes 'isGrid: true' to the CardRenderer. This flags the renderer
        // that the cards are rendered inside a strict vertical grid column
        // layout (like libraries and search results), disabling expanding
        // animations to prevent cards from overlapping with their neighbors.
        // ==========================================================
        return CardRenderer.createCardHtml(item, {
            isLandscape: this.isLandscape,
            type: this.type,
            contextType: this.contextType,
            isGrid: true
        });
    }
}

export default MediaGrid;
