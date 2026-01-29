/**
 * ============================================================================
 * Litefin Tizen - Episode List Component
 * ============================================================================
 * Renders a vertical list of episodes with thumbnails, metadata, and actions.
 * Extracted from SeasonPage for reuse in DetailsPage.
 * ============================================================================
 */

import Component from '../core/Component.js';
import { api } from '../api/index.js';
import { router } from '../core/Router.js';

class EpisodeList extends Component {
    /**
     * Create episode list component
     * @param {Object} config
     * @param {Episode[]} config.episodes - Array of episode objects
     * @param {string} config.seriesId - Parent series ID for fallback images
     * @param {Function} config.onPlay - Callback when episode is played
     * @param {Function} config.onAction - Callback for action buttons (action, episodeId)
     */
    constructor(config = {}) {
        super(config);

        this.episodes = config.episodes || [];
        this.seriesId = config.seriesId;
        this.onPlay = config.onPlay || ((id) => router.navigate(`/play/${id}`));
        this.onAction = config.onAction || (() => { });

        // Fallback image URL for missing episode thumbnails
        this._fallbackUrl = null;
    }

    render() {
        // Prepare fallback URL (Series Backdrop or Primary)
        this._fallbackUrl = api.getImageUrl(this.seriesId, 'Backdrop', { width: 400 }) ||
            api.getImageUrl(this.seriesId, 'Primary', { width: 400 });

        const htmlParts = this.episodes.map((ep, index) => this._renderEpisode(ep, index));

        return `
            <div class="episode-list-container">
                ${htmlParts.join('')}
            </div>
        `;
    }

    /**
     * Render a single episode row
     * @param {Object} ep - Episode object
     * @param {number} index - Episode index
     * @returns {string} HTML string
     */
    _renderEpisode(ep, index) {
        const thumbUrl = api.getImageUrl(ep.Id, 'Primary', { width: 400 });
        const runtime = ep.RunTimeTicks ? Math.round(ep.RunTimeTicks / 600000000) + 'm' : '';
        const rating = ep.CommunityRating ? ep.CommunityRating.toFixed(1) : '';
        const isPlayed = ep.UserData?.Played;
        const isFav = ep.UserData?.IsFavorite;

        // Action Buttons HTML
        const buttonsHtml = `
            <div class="episode-actions">
                <!-- Info -->
                <button class="episode-action-btn action-info" data-id="${ep.Id}" title="Info">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                       <circle cx="12" cy="12" r="10"></circle>
                       <line x1="12" y1="16" x2="12" y2="12"></line>
                       <line x1="12" y1="8" x2="12" y2="10"></line>
                    </svg>
                </button>
                <!-- Seen -->
                <button class="episode-action-btn action-seen ${isPlayed ? 'active' : ''}" data-id="${ep.Id}" title="Mark as Seen">
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
                </button>
                <!-- Favorite -->
                <button class="episode-action-btn action-fav ${isFav ? 'active' : ''}" data-id="${ep.Id}" title="Favorite">
                    <svg viewBox="0 0 24 24" fill="${isFav ? 'currentColor' : 'none'}" stroke="currentColor">
                       <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path>
                    </svg>
                </button>
                <!-- Menu -->
                <button class="episode-action-btn action-menu" data-id="${ep.Id}" title="Menu">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                       <circle cx="12" cy="12" r="1"></circle>
                       <circle cx="12" cy="5" r="1"></circle>
                       <circle cx="12" cy="19" r="1"></circle>
                    </svg>
                </button>
            </div>
        `;

        // Episode Card HTML
        return `
            <div class="episode-row">
                <div class="episode-row-card focusable" data-id="${ep.Id}" tabindex="0">
                    <div class="episode-row-thumb">
                        <img src="${thumbUrl}" loading="lazy" onerror="this.onerror=null;this.src='${this._fallbackUrl}'">
                    </div>
                    <div class="episode-row-info">
                        <div class="episode-row-index">${ep.IndexNumber ? ep.IndexNumber + '. ' : ''}${ep.Name}</div>
                        <div class="episode-row-meta">
                            <span>${runtime}</span>
                            ${rating ? `<div class="episode-row-rating">
                                <svg viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
                                ${rating}
                            </div>` : ''}
                        </div>
                        <div class="episode-row-overview">${ep.Overview || ''}</div>
                    </div>
                </div>
                ${buttonsHtml}
            </div>
        `;
    }

    onMounted() {
        // Attach click handlers
        this.el.addEventListener('click', (e) => this._handleClick(e));
    }

    /**
     * Handle clicks on episode cards and action buttons
     * @param {Event} e - Click event
     */
    _handleClick(e) {
        const card = e.target.closest('.episode-row-card');
        const btn = e.target.closest('.episode-action-btn');

        if (card) {
            // Play episode
            const id = card.dataset.id;
            this.onPlay(id);
        } else if (btn) {
            // Handle action button
            const id = btn.dataset.id;
            if (btn.classList.contains('action-info')) {
                this.onAction('info', id);
            } else if (btn.classList.contains('action-seen')) {
                this._toggleSeen(id, btn);
            } else if (btn.classList.contains('action-fav')) {
                this._toggleFav(id, btn);
            } else if (btn.classList.contains('action-menu')) {
                this.onAction('menu', id);
            }
        }
    }

    /**
     * Toggle seen/played status
     * @param {string} id - Episode ID
     * @param {HTMLElement} btn - Button element
     */
    async _toggleSeen(id, btn) {
        const isPlayed = btn.classList.contains('active');
        // Optimistic UI update
        btn.classList.toggle('active');
        try {
            if (isPlayed) {
                await api.unmarkPlayed(id);
            } else {
                await api.markPlayed(id);
            }
        } catch (e) {
            // Revert on error
            btn.classList.toggle('active');
            console.error('Failed to toggle seen', e);
        }
    }

    /**
     * Toggle favorite status
     * @param {string} id - Episode ID  
     * @param {HTMLElement} btn - Button element
     */
    async _toggleFav(id, btn) {
        const isFav = btn.classList.contains('active');
        // Optimistic UI update
        btn.classList.toggle('active');
        const svg = btn.querySelector('svg');
        svg.setAttribute('fill', isFav ? 'none' : 'currentColor');

        try {
            if (isFav) {
                await api.unmarkFavorite(id);
            } else {
                await api.markFavorite(id);
            }
        } catch (e) {
            // Revert on error
            btn.classList.toggle('active');
            svg.setAttribute('fill', isFav ? 'currentColor' : 'none');
            console.error('Failed to toggle fav', e);
        }
    }

    /**
     * Get the container element for focus registration
     * @returns {HTMLElement}
     */
    getContainer() {
        return this.el;
    }
}

export default EpisodeList;
