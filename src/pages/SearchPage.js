/**
 * ============================================================================
 * Litefin Tizen - Search Page
 * ============================================================================
 * Search functionality with real-time results.
 * ============================================================================
 */

import Page from './Page.js';
import { api } from '../api/index.js';
import { focusManager } from '../ui/FocusManager.js';
import MediaGrid from '../components/MediaGrid.js';
import { logger } from '../utils/Logger.js';

const log = logger.create('SearchPage');

class SearchPage extends Page {
    constructor() {
        super();
        this.title = 'Search';

        this._query = '';
        this._lastSearchedQuery = ''; // Track to prevent redundant searches
        this._results = [];
        this._debounceTimer = null;
    }

    render() {
        return `
            <div class="page search-page">
                <!-- Results -->
                <main class="page-content search-content">
                    <!-- Header with search input (Scrollable) -->
                    <div class="search-controls" id="search-header">
                        <div class="search-input-wrapper">
                            <input 
                                type="text" 
                                id="search-input" 
                                class="search-input"
                                placeholder="Search..."
                                autocomplete="off"
                                tabindex="0"
                            >
                        </div>
                    </div>
                    
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

        // Initial Focus Sequence
        // 1. Remove readonly to allow KB to open initially (user requested this "great" behavior)
        this._searchInput.removeAttribute('readonly');

        setTimeout(() => {
            this._searchInput.focus();
            // Note: We leave it editable so usage works immediately.
            // It will become readonly only when user navigates AWAY (blur).
        }, 100);

        // Show empty state
        this.$('#search-empty')?.classList.remove('hidden');
    }

    _bindEvents() {
        // Search input logic for specific Keyboard behavior
        if (this._searchInput) {
            // 1. On Input: Handle text changes
            this._searchInput.addEventListener('input', (e) => {
                this._onSearchInput(e.target.value);
            });

            // 2. On Blur: Make valid again but READONLY to prevent auto-popup on re-focus
            this._searchInput.addEventListener('blur', () => {
                this._searchInput.setAttribute('readonly', 'true');
            });

            // 3. On Click/Enter: Enable editing and trigger keyboard
            this._searchInput.addEventListener('click', () => {
                this._searchInput.removeAttribute('readonly');
                this._searchInput.focus();
            });

            // 4. Handle Key navigation
            this._searchInput.addEventListener('keydown', (e) => {
                // Return/Enter key (13) is standard click, but sometimes handled nicely strictly here too if needed
                if (e.keyCode === 13) {
                    this._searchInput.removeAttribute('readonly');
                    this._searchInput.focus();
                }

                if (e.keyCode === 40 && this._results.length > 0) {
                    e.preventDefault();
                    // Move focus to first row's items - use RAF to ensure DOM is ready
                    requestAnimationFrame(() => {
                        const sectionOrder = ['movies', 'series', 'episodes', 'people'];
                        const firstType = sectionOrder.find((type) => this._grids[type]);
                        if (firstType) {
                            const sectionId = `${this._grids[firstType].id}-items`;
                            const container = this.$(`#${sectionId}`);
                            if (container) {
                                const firstCard = container.querySelector('button, [tabindex="0"]');
                                if (firstCard) {
                                    this.setActiveSection(sectionId);
                                    focusManager.focusElement(firstCard);
                                }
                            }
                        }
                    });
                }
            });
        }
    }

    _setupFocus() {
        this.registerFocusSection('search-header', this.$('#search-header'), {
            orientation: 'horizontal',
            leaveDown: null, // Dynamically updated by _registerSearchFocus
            leaveLeft: 'sidebar'
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

        // Skip if already searched for this exact query (prevents flicker on keyboard dismiss)
        if (this._query === this._lastSearchedQuery) return;
        this._lastSearchedQuery = this._query;

        this.setLoading(true);

        try {
            const mediaParams = {
                Limit: 50,
                // Removed Person from here as we query it separately
                IncludeItemTypes: 'Movie,Series,Episode,BoxSet',
                MediaTypes: null
            };

            const peopleParams = {
                Limit: 20
            };

            log.info(`Searching for "${this._query}"`);

            const [mediaResponse, peopleResponse] = await Promise.all([
                api.search(this._query, mediaParams),
                api.searchPeople(this._query, peopleParams)
            ]);

            const mediaItems = mediaResponse.Items || [];
            const peopleItems = peopleResponse.Items || [];

            // Combine results
            this._results = [...mediaItems, ...peopleItems];

            log.debug(`Found ${mediaItems.length} media items and ${peopleItems.length} people`);

            if (this._results.length > 0) {
                this._renderResults();
            } else {
                this._clearResults();
                this.$('#no-results')?.classList.remove('hidden');
            }
        } catch (error) {
            log.error('Search failed', error);
        }

        this.setLoading(false);
    }

    _renderResults() {
        const container = this.$('#search-results');
        container.innerHTML = '';
        this._grids = {};

        // Group results by type
        const movies = this._results.filter((i) => i.Type === 'Movie');
        // Include both Series and BoxSets (Collections) as "Shows/Collections" or just Series
        const series = this._results.filter((i) => i.Type === 'Series');
        const episodes = this._results.filter((i) => i.Type === 'Episode');
        const people = this._results.filter((i) => i.Type === 'Person');

        // 1. Movies
        if (movies.length > 0) {
            this._grids.movies = new MediaGrid({
                id: 'search-movies',
                title: 'Movies',
                items: movies,
                type: 'poster',
                limit: 10,
                onSeeMore: () => this._registerSearchFocus()
            });
            this._grids.movies.mount(container);
        }

        // 2. Series
        if (series.length > 0) {
            this._grids.series = new MediaGrid({
                id: 'search-series',
                title: 'TV Shows',
                items: series,
                type: 'poster',
                limit: 10,
                onSeeMore: () => this._registerSearchFocus()
            });
            this._grids.series.mount(container);
        }

        // 3. Episodes
        if (episodes.length > 0) {
            this._grids.episodes = new MediaGrid({
                id: 'search-episodes',
                title: 'Episodes',
                items: episodes,
                type: 'episode', // 'episode' or 'episode-primary'
                isLandscape: true,
                limit: 8,
                onSeeMore: () => this._registerSearchFocus()
            });
            this._grids.episodes.mount(container);
        }

        // 4. People (Cast/Crew)
        if (people.length > 0) {
            this._grids.people = new MediaGrid({
                id: 'search-people',
                title: 'Cast & Crew',
                items: people,
                type: 'person', // Special card type? Or just poster.
                limit: 10,
                onSeeMore: () => this._registerSearchFocus()
            });
            this._grids.people.mount(container);
        }

        // Register focus
        this._registerSearchFocus();
    }

    _registerSearchFocus() {
        const sectionOrder = ['movies', 'series', 'episodes', 'people'];
        const activeTypes = sectionOrder.filter((type) => this._grids[type]);

        if (activeTypes.length === 0) return;

        // Register Header Focus Hook
        this.registerFocusSection('search-header', this.$('#search-header'), {
            orientation: 'horizontal',
            leaveDown: `${this._grids[activeTypes[0]].id}-items`,
            leaveLeft: 'sidebar'
        });

        // Loop through grids to chain them
        activeTypes.forEach((type, index) => {
            const gridComp = this._grids[type];
            const baseId = gridComp.id;
            const gridZone = `${baseId}-items`;
            const btnZone = `${baseId}-btn-zone`;
            const btnId = `${baseId}-btn`;

            const btn = this.$(`#${btnId}`);
            // Check visibility via offsetParent to avoid focus traps
            const isButtonVisible = btn && btn.offsetParent !== null;
            const btnContainer = this.$(`#${btnZone}`);

            const prevType = index > 0 ? activeTypes[index - 1] : null;
            const nextType = index < activeTypes.length - 1 ? activeTypes[index + 1] : null;

            // --- Grid Zone ---
            // UP
            let gridLeaveUp;
            if (prevType) {
                const prevComp = this._grids[prevType];
                const prevBtn = this.$(`#${prevComp.id}-btn`);
                const prevBtnVisible = prevBtn && prevBtn.offsetParent !== null;
                gridLeaveUp = prevBtnVisible ? `${prevComp.id}-btn-zone` : `${prevComp.id}-items`;
            } else {
                gridLeaveUp = 'search-header';
            }

            // DOWN
            let gridLeaveDown = null;
            if (isButtonVisible) {
                gridLeaveDown = btnZone;
            } else if (nextType) {
                gridLeaveDown = `${this._grids[nextType].id}-items`;
            }

            this.registerFocusSection(gridZone, this.$(`#${gridZone}`), {
                orientation: 'grid',
                leaveUp: gridLeaveUp,
                leaveDown: gridLeaveDown,
                leaveLeft: 'sidebar'
            });

            // --- Button Zone ---
            if (isButtonVisible && btnContainer) {
                this.registerFocusSection(btnZone, btnContainer, {
                    orientation: 'horizontal',
                    leaveUp: gridZone,
                    leaveDown: nextType ? `${this._grids[nextType].id}-items` : null
                });
            }
        });
    }

    _clearResults() {
        this.$('#search-results').innerHTML = '';

        // Unregister grid sections to prevent memory leaks and focus confusion
        if (this._grids) {
            Object.values(this._grids).forEach((grid) => {
                const baseId = grid.id;
                focusManager.unregister(`${baseId}-items`);
                focusManager.unregister(`${baseId}-btn-zone`);
            });
        }

        this._results = [];
        this._grids = {};
    }

    onBack() {
        // Just navigate back immediately, don't clear search first
        return false;
    }
}

export default SearchPage;
