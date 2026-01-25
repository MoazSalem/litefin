/**
 * ============================================================================
 * Litefin Tizen - Search Page
 * ============================================================================
 * Search functionality with real-time results.
 * ============================================================================
 */

import Page from './Page.js';
import { api } from '../api/index.js';
import { router } from '../core/Router.js';
import { eventBus } from '../core/EventBus.js';
import { animationManager } from '../ui/AnimationManager.js';

class SearchPage extends Page {
    constructor() {
        super();
        this.title = 'Search';

        this._query = '';
        this._results = [];
        this._debounceTimer = null;
    }

    render() {
        return `
            <div class="page search-page">
                <!-- Header with search input -->
                <header class="page-header">
                    <button class="back-btn" tabindex="0">←</button>
                    <div class="search-input-wrapper">
                        <input 
                            type="text" 
                            id="search-input" 
                            class="search-input"
                            placeholder="Search movies, shows, episodes..."
                            autocomplete="off"
                            tabindex="0"
                        >
                    </div>
                </header>
                
                <!-- Results -->
                <main class="page-content">
                    <!-- Results grid -->
                    <div class="search-results" id="search-results">
                        <!-- Results rendered here -->
                    </div>
                    
                    <!-- Empty state -->
                    <div class="search-empty hidden" id="search-empty">
                        <p class="empty-icon">
                            <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#666" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <circle cx="11" cy="11" r="8"></circle>
                                <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                            </svg>
                        </p>
                        <p>Start typing to search</p>
                    </div>
                    
                    <!-- No results -->
                    <div class="search-no-results hidden" id="no-results">
                        <p>No results found</p>
                    </div>
                    
                    <!-- Loading -->
                    <div class="page-loading hidden">
                        <div class="loading-spinner"></div>
                    </div>
                </main>
            </div>
        `;
    }

    onInit() {
        this._searchInput = this.$('#search-input');

        // Bind events
        this._bindEvents();

        // Setup focus
        this._setupFocus();

        // Focus search input
        setTimeout(() => this._searchInput.focus(), 100);

        // Show empty state
        this.$('#search-empty')?.classList.remove('hidden');
    }

    _bindEvents() {
        // Back button
        this.$('.back-btn')?.addEventListener('click', () => {
            router.back();
        });

        // Search input
        this._searchInput?.addEventListener('input', (e) => {
            this._onSearchInput(e.target.value);
        });

        this._searchInput?.addEventListener('keydown', (e) => {
            // Down arrow moves to results
            if (e.keyCode === 40 && this._results.length > 0) {
                e.preventDefault();
                this.setActiveSection('search-results');
            }
        });
    }

    _setupFocus() {
        this.registerFocusSection('search-header', this.$('.page-header'), {
            orientation: 'horizontal',
            leaveDown: 'search-results'
        });

        this.setActiveSection('search-header');
    }

    _onSearchInput(query) {
        this._query = query.trim();

        // Clear previous timer
        if (this._debounceTimer) {
            clearTimeout(this._debounceTimer);
        }

        // Hide states
        this.$('#search-empty')?.classList.add('hidden');
        this.$('#no-results')?.classList.add('hidden');

        if (!this._query) {
            this._clearResults();
            this.$('#search-empty')?.classList.remove('hidden');
            return;
        }

        // Debounce search
        this._debounceTimer = setTimeout(() => {
            this._search();
        }, 300);
    }

    async _search() {
        if (!this._query) return;

        this.setLoading(true);

        try {
            const response = await api.search(this._query, { Limit: 50 });
            this._results = response.Items || [];

            if (this._results.length > 0) {
                this._renderResults();
            } else {
                this._clearResults();
                this.$('#no-results')?.classList.remove('hidden');
            }
        } catch (error) {
            console.error('Search failed', error);
        }

        this.setLoading(false);
    }

    _renderResults() {
        const container = this.$('#search-results');

        // Group results by type
        const movies = this._results.filter(i => i.Type === 'Movie');
        const series = this._results.filter(i => i.Type === 'Series');
        const episodes = this._results.filter(i => i.Type === 'Episode');

        let html = '';

        if (movies.length > 0) {
            html += this._renderResultSection('Movies', movies);
        }
        if (series.length > 0) {
            html += this._renderResultSection('Series', series);
        }
        if (episodes.length > 0) {
            html += this._renderResultSection('Episodes', episodes);
        }

        container.innerHTML = html;

        // Add click handlers
        container.querySelectorAll('.result-card').forEach(card => {
            card.addEventListener('click', () => {
                router.navigate(`/details/${card.dataset.itemId}`);
            });

            // Focus animation
            card.addEventListener('focus', () => animationManager.focusScale(card, true));
            card.addEventListener('blur', () => animationManager.focusScale(card, false));
        });

        // Register focus section
        this.registerFocusSection('search-results', container, {
            orientation: 'grid',
            leaveUp: 'search-header'
        });
    }

    _renderResultSection(title, items) {
        return `
            <div class="result-section">
                <h3 class="result-section-title">${title}</h3>
                <div class="result-grid">
                    ${items.map(item => this._renderResultCard(item)).join('')}
                </div>
            </div>
        `;
    }

    _renderResultCard(item) {
        const imageUrl = api.getImageUrl(item.Id, 'Primary', { maxWidth: 200 });

        let subtitle = '';
        if (item.Type === 'Episode') {
            subtitle = `S${item.ParentIndexNumber}:E${item.IndexNumber} - ${item.SeriesName}`;
        } else if (item.ProductionYear) {
            subtitle = item.ProductionYear;
        }

        return `
            <button class="result-card" data-item-id="${item.Id}" tabindex="0">
                <div class="result-image">
                    <img src="${imageUrl}" alt="${item.Name}" loading="lazy">
                </div>
                <div class="result-info">
                    <p class="result-title">${item.Name}</p>
                    <p class="result-subtitle">${subtitle}</p>
                </div>
            </button>
        `;
    }

    _clearResults() {
        this.$('#search-results').innerHTML = '';
        this._results = [];
    }

    onBack() {
        if (this._query) {
            // Clear search first
            this._searchInput.value = '';
            this._onSearchInput('');
            this._searchInput.focus();
        } else {
            router.back();
        }
    }
}

export default SearchPage;
