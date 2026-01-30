/**
 * ============================================================================
 * Litefin Tizen - MediaGrid Component
 * ============================================================================
 * Reusable grid component for displaying media items (Movies, Shows, Episodes).
 * Handles rendering, "See More" expansion, and basic focus rendering support.
 * ============================================================================
 */

import Component from '../core/Component.js';
import { api } from '../api/index.js';
import { focusManager } from '../ui/FocusManager.js';
import { router } from '../core/Router.js';
import CardRenderer from '../utils/CardRenderer.js';

class MediaGrid extends Component {
    constructor(config = {}) {
        super(config);

        this.id = config.id || `grid-${Math.random().toString(36).substr(2, 9)}`;
        this.title = config.title || '';
        this.items = config.items || [];
        this.limit = config.limit || 12;
        this.type = config.type || 'poster'; // 'poster', 'episode', 'episode-primary'
        this.isLandscape = config.isLandscape || false;

        // State
        this.expanded = false;

        // Callbacks
        this.onSeeMore = config.onSeeMore || null; // Optional override
    }

    render() {
        // If no items, return empty or hidden
        if (!this.items || this.items.length === 0) {
            return `<div id="${this.id}" class="media-row hidden"></div>`;
        }

        const gridId = `${this.id}-items`;
        const btnId = `${this.id}-btn`;

        // landscape-grid class?
        const gridClass = this.isLandscape ? 'person-grid landscape-grid' : 'person-grid';

        return `
            <div id="${this.id}" class="media-row">
                ${this.title ? `<h2 class="row-title">${this.title}</h2>` : ''}
                <div class="${gridClass}" id="${gridId}">
                    ${this._renderItems()}
                </div>
                
            <div class="see-more-container" id="${this.id}-btn-zone" style="display: ${this._shouldShowButton() ? 'flex' : 'none'}; justify-content: center;">
                <button class="btn see-more-btn" id="${btnId}" tabindex="0">
                    ${this.expanded ? 'See Less' : 'See More'}
                </button>
            </div>
        `;
    }

    /**
     * Re-render logic after mount/update
     */
    onMounted() {
        // console.log(`MediaGrid (${this.title}): Mounted with ${this.items.length} items.`);
        const btn = document.getElementById(`${this.id}-btn`);
        if (btn) {
            btn.onclick = () => this.toggleExpand();
            // CRITICAL: Add keyboard handler for "Enter" key (TV Remote/Keyboard)
            btn.onkeydown = (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    e.stopPropagation();
                    this.toggleExpand();
                }
            };
        }

        this._updateButtonVisibility();
        this._bindItemClicks();
    }

    /**
     * Render the grid items strings
     */
    _renderItems() {
        const displayItems = (this._shouldShowButton() && !this.expanded)
            ? this.items.slice(0, this.limit)
            : this.items;

        const html = [];
        for (let i = 0; i < displayItems.length; i++) {
            html.push(this._createCardHtml(displayItems[i]));
        }
        return html.join('');
    }

    /**
     * Toggle "See More" state
     */
    toggleExpand() {
        this.expanded = !this.expanded;

        // Re-render items container content ONLY to avoid destroying the parent (and focus)
        const grid = document.getElementById(`${this.id}-items`);
        if (grid) {
            grid.innerHTML = this._renderItems();
            this._bindItemClicks();
        }

        // Update button text
        const btn = document.getElementById(`${this.id}-btn`);
        if (btn) {
            btn.textContent = this.expanded ? 'See Less' : 'See More';
        }

        // Parent notification (optional) - allows PersonPage to re-register focus sections
        if (this.onSeeMore) this.onSeeMore(this.expanded);

        // Invalidate focus cache for the grid items section
        focusManager.invalidateCache(`${this.id}-items`);

        // Refocus button and scroll it into view after DOM update
        setTimeout(() => {
            if (btn) {
                btn.focus();
                // Scroll the button into view so it's visible after content expansion
                btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        }, 150);
    }

    _shouldShowButton() {
        return this.items.length > this.limit;
    }

    _updateButtonVisibility() {
        const btnContainer = document.getElementById(`${this.id}-btn-zone`);
        if (btnContainer) {
            if (this._shouldShowButton()) {
                btnContainer.style.setProperty('display', 'flex', 'important');
                btnContainer.style.justifyContent = 'center';
                // Also ensure inner button is visible
                const btn = btnContainer.querySelector('.see-more-btn');
                if (btn) btn.style.setProperty('display', 'inline-block', 'important');
            } else {
                btnContainer.style.display = 'none';
            }
        }
    }

    _bindItemClicks() {
        const grid = document.getElementById(`${this.id}-items`);
        if (!grid) return;

        grid.querySelectorAll('.media-card').forEach(card => {
            card.onclick = () => {
                router.navigate(`/details/${card.dataset.itemId}`);
            };
        });
    }

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
        return CardRenderer.createCardHtml(item, {
            isLandscape: this.isLandscape,
            type: this.type
        });
    }
}

export default MediaGrid;
