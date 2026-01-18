/**
 * ============================================================================
 * FastFin Tizen - Details Page
 * ============================================================================
 * Item details with metadata, play button, and related content.
 * Handles movies, series, seasons, and episodes.
 * ============================================================================
 */

import Page from './Page.js';
import { api } from '../api/index.js';
import { router } from '../core/Router.js';
import { eventBus } from '../core/EventBus.js';
import { animationManager } from '../ui/AnimationManager.js';

class DetailsPage extends Page {
    constructor() {
        super();

        this._itemId = null;
        this._item = null;
        this._seasons = null;
        this._episodes = null;
        this._similar = null;
    }

    render() {
        return `
            <div class="page details-page">
                <!-- Backdrop -->
                <div class="details-backdrop" id="backdrop">
                    <div class="backdrop-gradient"></div>
                </div>
                
                <!-- Content -->
                <div class="details-content">
                    <!-- Hero section -->
                    <section class="details-hero">
                        <div class="hero-poster" id="poster"></div>
                        <div class="hero-info" id="hero-info">
                            <!-- Info rendered here -->
                        </div>
                    </section>
                    
                    <!-- Actions -->
                    <section class="details-actions" id="actions">
                        <button class="btn btn-primary play-btn" tabindex="0">
                            ▶ Play
                        </button>
                        <button class="btn btn-secondary resume-btn hidden" tabindex="0">
                            ▶ Resume
                        </button>
                        <button class="btn btn-icon favorite-btn" tabindex="0">
                            ♡
                        </button>
                        <button class="btn btn-icon watched-btn" tabindex="0">
                            ✓
                        </button>
                    </section>
                    
                    <!-- Overview -->
                    <section class="details-overview" id="overview">
                        <p class="overview-text"></p>
                    </section>
                    
                    <!-- Seasons (for series) -->
                    <section class="details-seasons hidden" id="seasons-section">
                        <h2>Seasons</h2>
                        <div class="seasons-row" id="seasons-row"></div>
                    </section>
                    
                    <!-- Episodes (for season/series) -->
                    <section class="details-episodes hidden" id="episodes-section">
                        <h2>Episodes</h2>
                        <div class="episodes-list" id="episodes-list"></div>
                    </section>
                    
                    <!-- Similar items -->
                    <section class="details-similar hidden" id="similar-section">
                        <h2>More Like This</h2>
                        <div class="similar-row" id="similar-row"></div>
                    </section>
                </div>
                
                <!-- Loading -->
                <div class="page-loading">
                    <div class="loading-spinner"></div>
                </div>
            </div>
        `;
    }

    async onInit() {
        this._itemId = this.params.id;

        // Setup focus
        this._setupFocus();

        // Bind actions
        this._bindActions();

        // Load item details
        await this._loadDetails();
    }

    _setupFocus() {
        this.registerFocusSection('details-actions', this.$('#actions'), {
            orientation: 'horizontal',
            leaveDown: 'details-content'
        });

        this.setActiveSection('details-actions');
    }

    _bindActions() {
        // Play button
        this.$('.play-btn')?.addEventListener('click', () => {
            this._play();
        });

        // Resume button
        this.$('.resume-btn')?.addEventListener('click', () => {
            this._play(true);
        });

        // Favorite button
        this.$('.favorite-btn')?.addEventListener('click', () => {
            this._toggleFavorite();
        });

        // Watched button
        this.$('.watched-btn')?.addEventListener('click', () => {
            this._toggleWatched();
        });
    }

    async _loadDetails() {
        this.setLoading(true);

        try {
            // Get item details
            this._item = await api.getItem(this._itemId);
            this.title = this._item.Name;

            // Render item info
            this._renderDetails();

            // Load additional data based on type
            if (this._item.Type === 'Series') {
                await this._loadSeasons();
            } else if (this._item.Type === 'Season') {
                await this._loadEpisodes(this._item.SeriesId, this._itemId);
            }

            // Load similar items
            await this._loadSimilar();

        } catch (error) {
            console.error('DetailsPage: Failed to load', error);
            this.showError('Failed to load details');
        }

        this.setLoading(false);
    }

    _renderDetails() {
        const item = this._item;

        // Set backdrop
        const backdropId = item.BackdropImageTags?.length > 0 ? item.Id : item.ParentBackdropItemId;
        if (backdropId) {
            const backdropUrl = api.getImageUrl(backdropId, 'Backdrop', { maxWidth: 1920 });
            this.$('#backdrop').style.backgroundImage = `url(${backdropUrl})`;
        }

        // Set poster
        const posterUrl = api.getImageUrl(item.Id, 'Primary', { maxWidth: 400 });
        this.$('#poster').innerHTML = `<img src="${posterUrl}" alt="${item.Name}">`;

        // Build meta info
        const meta = [];
        if (item.ProductionYear) meta.push(item.ProductionYear);
        if (item.OfficialRating) meta.push(item.OfficialRating);
        if (item.CommunityRating) meta.push(`★ ${item.CommunityRating.toFixed(1)}`);
        if (item.RunTimeTicks) {
            const minutes = Math.round(item.RunTimeTicks / 600000000);
            meta.push(`${minutes} min`);
        }

        // Genres
        const genres = item.Genres?.slice(0, 3).join(', ') || '';

        // Render hero info
        this.$('#hero-info').innerHTML = `
            <h1 class="details-title">${item.Name}</h1>
            ${item.Type === 'Episode' ? `<p class="details-episode-info">S${item.ParentIndexNumber}:E${item.IndexNumber} - ${item.SeriesName}</p>` : ''}
            <p class="details-meta">${meta.join(' • ')}</p>
            <p class="details-genres">${genres}</p>
        `;

        // Overview
        this.$('.overview-text').textContent = item.Overview || '';

        // Update buttons based on state
        this._updateButtons();
    }

    _updateButtons() {
        const item = this._item;
        const userData = item.UserData || {};

        // Resume button
        if (userData.PlaybackPositionTicks > 0) {
            this.$('.resume-btn')?.classList.remove('hidden');
            const resumeTime = Math.round(userData.PlaybackPositionTicks / 600000000);
            this.$('.resume-btn').textContent = `▶ Resume (${resumeTime}m)`;
        }

        // Favorite button
        if (userData.IsFavorite) {
            this.$('.favorite-btn').textContent = '♥';
            this.$('.favorite-btn').classList.add('active');
        }

        // Watched button
        if (userData.Played) {
            this.$('.watched-btn').classList.add('active');
        }
    }

    async _loadSeasons() {
        try {
            const response = await api.getSeasons(this._itemId);
            this._seasons = response.Items || [];

            if (this._seasons.length > 0) {
                this._renderSeasons();
            }
        } catch (error) {
            console.warn('Failed to load seasons', error);
        }
    }

    _renderSeasons() {
        const container = this.$('#seasons-row');
        const section = this.$('#seasons-section');

        section.classList.remove('hidden');

        container.innerHTML = this._seasons.map(season => `
            <button class="season-card" data-season-id="${season.Id}" tabindex="0">
                <img src="${api.getImageUrl(season.Id, 'Primary', { maxWidth: 200 })}" alt="${season.Name}">
                <span>${season.Name}</span>
            </button>
        `).join('');

        // Click handlers
        container.querySelectorAll('.season-card').forEach(card => {
            card.addEventListener('click', () => {
                const seasonId = card.dataset.seasonId;
                this._loadEpisodes(this._itemId, seasonId);
            });
        });

        // Register focus section
        this.registerFocusSection('details-seasons', container, {
            orientation: 'horizontal',
            leaveUp: 'details-actions',
            leaveDown: 'details-episodes'
        });
    }

    async _loadEpisodes(seriesId, seasonId) {
        try {
            const response = await api.getEpisodes(seriesId, seasonId);
            this._episodes = response.Items || [];

            if (this._episodes.length > 0) {
                this._renderEpisodes();
            }
        } catch (error) {
            console.warn('Failed to load episodes', error);
        }
    }

    _renderEpisodes() {
        const container = this.$('#episodes-list');
        const section = this.$('#episodes-section');

        section.classList.remove('hidden');

        container.innerHTML = this._episodes.map(ep => {
            const progress = ep.UserData?.PlaybackPositionTicks && ep.RunTimeTicks
                ? (ep.UserData.PlaybackPositionTicks / ep.RunTimeTicks) * 100
                : 0;

            return `
                <button class="episode-card" data-episode-id="${ep.Id}" tabindex="0">
                    <div class="episode-thumb">
                        <img src="${api.getImageUrl(ep.Id, 'Primary', { maxWidth: 300 })}" alt="">
                        ${progress > 0 ? `<div class="progress-bar"><div class="progress" style="width: ${progress}%"></div></div>` : ''}
                    </div>
                    <div class="episode-info">
                        <span class="episode-number">E${ep.IndexNumber}</span>
                        <span class="episode-title">${ep.Name}</span>
                        <p class="episode-overview">${ep.Overview?.substring(0, 100) || ''}...</p>
                    </div>
                </button>
            `;
        }).join('');

        // Click handlers
        container.querySelectorAll('.episode-card').forEach(card => {
            card.addEventListener('click', () => {
                router.navigate(`/details/${card.dataset.episodeId}`);
            });
        });

        // Register focus section
        this.registerFocusSection('details-episodes', container, {
            orientation: 'vertical',
            leaveUp: 'details-seasons'
        });
    }

    async _loadSimilar() {
        try {
            const response = await api.getSimilar(this._itemId);
            this._similar = response.Items || [];

            if (this._similar.length > 0) {
                this._renderSimilar();
            }
        } catch (error) {
            console.warn('Failed to load similar', error);
        }
    }

    _renderSimilar() {
        const container = this.$('#similar-row');
        const section = this.$('#similar-section');

        section.classList.remove('hidden');

        container.innerHTML = this._similar.map(item => `
            <button class="media-card small" data-item-id="${item.Id}" tabindex="0">
                <img src="${api.getImageUrl(item.Id, 'Primary', { maxWidth: 150 })}" alt="${item.Name}">
                <span>${item.Name}</span>
            </button>
        `).join('');

        // Click handlers
        container.querySelectorAll('.media-card').forEach(card => {
            card.addEventListener('click', () => {
                router.navigate(`/details/${card.dataset.itemId}`);
            });
        });
    }

    _play(resume = false) {
        let itemToPlay = this._item;

        // For series, play first unwatched episode
        if (this._item.Type === 'Series' && this._episodes?.length > 0) {
            itemToPlay = this._episodes.find(ep => !ep.UserData?.Played) || this._episodes[0];
        }

        // Emit play event (player integration will handle this)
        eventBus.emit('player:play', {
            item: itemToPlay,
            resume
        });
    }

    async _toggleFavorite() {
        const isFavorite = this._item.UserData?.IsFavorite;

        try {
            if (isFavorite) {
                await api.unmarkFavorite(this._itemId);
                this.$('.favorite-btn').textContent = '♡';
                this.$('.favorite-btn').classList.remove('active');
            } else {
                await api.markFavorite(this._itemId);
                this.$('.favorite-btn').textContent = '♥';
                this.$('.favorite-btn').classList.add('active');
            }

            this._item.UserData = this._item.UserData || {};
            this._item.UserData.IsFavorite = !isFavorite;
        } catch (error) {
            console.error('Failed to toggle favorite', error);
        }
    }

    async _toggleWatched() {
        const isPlayed = this._item.UserData?.Played;

        try {
            if (isPlayed) {
                await api.unmarkPlayed(this._itemId);
                this.$('.watched-btn').classList.remove('active');
            } else {
                await api.markPlayed(this._itemId);
                this.$('.watched-btn').classList.add('active');
            }

            this._item.UserData = this._item.UserData || {};
            this._item.UserData.Played = !isPlayed;
        } catch (error) {
            console.error('Failed to toggle watched', error);
        }
    }

    onBack() {
        router.back();
    }
}

export default DetailsPage;
