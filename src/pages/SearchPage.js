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
import { i18n } from '../utils/i18n.js';
import { storage } from '../utils/StorageService.js';
import { state } from '../core/StateManager.js';
import { router } from '../core/Router.js';

const log = logger.create('SearchPage');

class SearchPage extends Page {
    constructor() {
        super();
        // Title translated in onInit

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
                                data-i18n="SearchPlaceholder"
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
                        <p data-i18n="StartTypingToSearch">Start typing to search</p>
                    </div>
                    
                    <!-- No results -->
                    <div class="search-no-results hidden" id="no-results">
                        <p id="no-results-text"></p>
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
        this.title = i18n.t('Search');
        this._searchInput = this.$('#search-input');

        // Bind events
        this._bindEvents();

        // Hydrate DOM
        i18n.translateDOM(this.el);

        // Setup focus
        this._setupFocus();

        // State Rehydration Check
        let searchState = null;

        if (storage.getItem('pref:disableFocusRestore') !== 'true') {
            searchState = state.get('search:state');
        } else {
            state.delete('search:state');
        }

        if (!searchState) {
            // Initial Focus Sequence (Only if NOT restoring state)
            // 1. Remove readonly to allow KB to open initially
            this._searchInput.removeAttribute('readonly');

            setTimeout(() => {
                this._searchInput.focus();
                // Note: We leave it editable so usage works immediately.
                // It will become readonly only when user navigates AWAY (blur).
            }, 100);

            // Show empty state
            this.$('#search-empty')?.classList.remove('hidden');
        } else {
            // Rehydrate state
            this._query = searchState.query;
            this._results = searchState.results;
            this._lastSearchedQuery = searchState.query;

            if (this._searchInput) {
                this._searchInput.value = this._query;
            }

            // Hide empty state immediately
            this.$('#search-empty')?.classList.add('hidden');

            if (this._results && this._results.length > 0) {
                this._renderResults();

                // Restore Focus
                requestAnimationFrame(() => {
                    let restoredFocus = false;
                    const targetId = searchState.focusItemId;
                    const sectionId = searchState.focusSectionId;

                    if (targetId && sectionId) {
                        const sectionConfig = focusManager.getSectionConfig(sectionId);
                        const sectionContainer = sectionConfig ? sectionConfig.container : this.el;

                        const savedCard = sectionContainer.querySelector(
                            `[data-item-id="${targetId}"], [data-id="${targetId}"]`
                        );

                        if (savedCard) {
                            this.setActiveSection(sectionId, false);
                            focusManager.focusElement(savedCard, { instantScroll: true });
                            restoredFocus = true;
                        }
                    }

                    if (!restoredFocus) {
                        this.setActiveSection('search-header');
                    }

                    state.delete('search:state');
                });
            } else {
                state.delete('search:state');
            }
        }
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
                        const sectionOrder = [
                            'movies',
                            'series',
                            'episodes',
                            'people',
                            'artists',
                            'albums',
                            'songs',
                            'collections',
                            'channels'
                        ];
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

    /**
     * Overrides the default page-level loading state mechanism.
     *
     * By default, Page.js adds a 'loading' class to the page container, which
     * hides all other child elements (via opacity: 0) to prevent interaction.
     * For live search, this causes a jarring UI flash/pulse on every keystroke
     * because the input box itself disappears.
     *
     * Instead, we manually toggle the visibility of the search spinner element,
     * keeping the search input field and any existing results fully visible.
     *
     * @param {boolean} show - True to display the spinner, false to hide it.
     */
    setLoading(show) {
        const spinner = this.$('.page-loading');
        if (spinner) {
            if (show) {
                spinner.classList.remove('hidden');
            } else {
                spinner.classList.add('hidden');
            }
        }
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

        // Debounce search - set to 500ms to ensure snappier updates as the user types
        // while still grouping fast keystrokes to limit redundant API requests.
        this._debounceTimer = setTimeout(() => {
            this._search();
        }, 500);
    }

    async _search() {
        if (!this._query) return;

        // Skip if already searched for this exact query (prevents flicker on keyboard dismiss)
        if (this._query === this._lastSearchedQuery) return;
        this._lastSearchedQuery = this._query;

        this.setLoading(true);

        try {
            log.info(`Searching for "${this._query}"`);

            /*
             * To ensure perfect diversity and category parity, we perform individual
             * parallel requests for every media type, each limited to 11 items.
             * This matches the user's requested "get them all and limit each to 11" logic.
             */
            const searchTypes = [
                { type: 'Movie' },
                { type: 'Series' },
                { type: 'Episode' },
                { type: 'MusicArtist,Artist' },
                { type: 'MusicAlbum' },
                { type: 'Audio' },
                { type: 'BoxSet' },
                { type: 'TvChannel' }
            ];

            const limit = 12; // Fetch 12 so that with a grid limit of 11, the "See More" button appears
            const requests = [
                ...searchTypes.map((t) => api.searchHints(this._query, { IncludeItemTypes: t.type, Limit: limit })),
                api.searchPeople(this._query, { Limit: limit })
            ];

            const responses = await Promise.all(requests);

            // Helper to normalize various SearchHint response formats (Array vs Object)
            const normalize = (res, forcedType = null) => {
                // Jellyfin /Search/Hints can return a raw Array or an object with SearchHints/Items
                const rawItems = Array.isArray(res) ? res : res?.SearchHints || res?.Items || [];
                return rawItems.map((item) => ({
                    ...item,
                    Id: item.ItemId || item.Id, // Normalize search hint IDs
                    ImageTags: item.ImageTags || {
                        Primary: item.PrimaryImageTag
                    },
                    // Ensure Type is correctly set (SearchHints have Type property)
                    Type: forcedType || item.Type
                }));
            };

            const movies = normalize(responses[0]);
            const series = normalize(responses[1]);
            const episodes = normalize(responses[2]);
            const artists = normalize(responses[3]);
            const albums = normalize(responses[4]);
            const songs = normalize(responses[5]);
            const collections = normalize(responses[6]);
            const channels = normalize(responses[7]);
            const people = normalize(responses[8], 'Person');

            // Combine results into a single list for the grouping renderer
            this._results = [
                ...movies,
                ...series,
                ...episodes,
                ...people,
                ...artists,
                ...albums,
                ...songs,
                ...collections,
                ...channels
            ];

            log.debug(
                `Search returned: ${movies.length} movies, ${series.length} series, ${episodes.length} episodes, ${people.length} people`
            );

            if (this._results.length > 0) {
                this._renderResults();
            } else {
                this._clearResults();
                const noResultsEl = this.$('#no-results');
                const noResultsText = this.$('#no-results-text');
                if (noResultsEl && noResultsText) {
                    noResultsText.innerHTML = i18n.t('SearchResultsEmpty', [this._query]);
                    noResultsEl.classList.remove('hidden');
                }
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
        const series = this._results.filter((i) => i.Type === 'Series');
        const episodes = this._results.filter((i) => i.Type === 'Episode');
        const channels = this._results.filter((i) => i.Type === 'TvChannel');
        // Music types - merge MusicArtist and Artist for better coverage
        const artists = this._results.filter((i) => i.Type === 'MusicArtist' || i.Type === 'Artist');
        const albums = this._results.filter((i) => i.Type === 'MusicAlbum');
        const songs = this._results.filter((i) => i.Type === 'Audio');
        const people = this._results.filter((i) => i.Type === 'Person');
        const collections = this._results.filter((i) => i.Type === 'BoxSet');

        const queryParam = encodeURIComponent(this._query);

        // 1. Movies
        if (movies.length > 0) {
            this._grids.movies = new MediaGrid({
                id: 'search-movies',
                title: i18n.t('Movies'),
                items: movies,
                type: 'poster',
                contextType: 'search',
                limit: 10,
                moreUrl: `/library/all?searchTerm=${queryParam}&includeItemTypes=Movie`,
                onClick: (card) => this._saveStateAndNavigate('search-movies-items', card)
            });
            this._grids.movies.mount(container);
        }

        // 2. Series
        if (series.length > 0) {
            this._grids.series = new MediaGrid({
                id: 'search-series',
                title: i18n.t('TypeOptionPluralSeries'),
                items: series,
                type: 'poster',
                contextType: 'search',
                limit: 10,
                moreUrl: `/library/all?searchTerm=${queryParam}&includeItemTypes=Series`,
                onClick: (card) => this._saveStateAndNavigate('search-series-items', card)
            });
            this._grids.series.mount(container);
        }

        // 3. Episodes
        if (episodes.length > 0) {
            this._grids.episodes = new MediaGrid({
                id: 'search-episodes',
                title: i18n.t('Episodes'),
                items: episodes,
                type: 'episode',
                contextType: 'search',
                isLandscape: true,
                limit: 9,
                moreUrl: `/library/all?searchTerm=${queryParam}&includeItemTypes=Episode&viewModeIndex=2`,
                onClick: (card) => this._saveStateAndNavigate('search-episodes-items', card)
            });
            this._grids.episodes.mount(container);
        }

        // 4. People (Cast/Crew)
        if (people.length > 0) {
            this._grids.people = new MediaGrid({
                id: 'search-people',
                title: i18n.t('HeaderCastAndCrew'),
                items: people,
                type: 'person',
                contextType: 'search',
                limit: 10,
                moreUrl: `/library/all?searchTerm=${queryParam}&includeItemTypes=Person`,
                onClick: (card) => this._saveStateAndNavigate('search-people-items', card)
            });
            this._grids.people.mount(container);
        }

        // 5. Music Artists
        if (artists.length > 0) {
            this._grids.artists = new MediaGrid({
                id: 'search-artists',
                title: i18n.t('Artists'),
                items: artists,
                type: 'square',
                contextType: 'search',
                limit: 10,
                moreUrl: `/library/all?searchTerm=${queryParam}&includeItemTypes=MusicArtist,Artist`,
                onClick: (card) => this._saveStateAndNavigate('search-artists-items', card)
            });
            this._grids.artists.mount(container);
        }

        // 6. Music Albums
        if (albums.length > 0) {
            this._grids.albums = new MediaGrid({
                id: 'search-albums',
                title: i18n.t('Albums'),
                items: albums,
                type: 'square',
                contextType: 'search',
                limit: 10,
                moreUrl: `/library/all?searchTerm=${queryParam}&includeItemTypes=MusicAlbum`,
                onClick: (card) => this._saveStateAndNavigate('search-albums-items', card)
            });
            this._grids.albums.mount(container);
        }

        // 7. Songs (Audio)
        if (songs.length > 0) {
            this._grids.songs = new MediaGrid({
                id: 'search-songs',
                title: i18n.t('Songs'),
                items: songs,
                type: 'square',
                contextType: 'search',
                limit: 10,
                moreUrl: `/library/all?searchTerm=${queryParam}&includeItemTypes=Audio`,
                onClick: (card) => this._saveStateAndNavigate('search-songs-items', card)
            });
            this._grids.songs.mount(container);
        }

        // 8. Collections (BoxSets)
        if (collections.length > 0) {
            this._grids.collections = new MediaGrid({
                id: 'search-collections',
                title: i18n.t('Collections'),
                items: collections,
                type: 'poster',
                contextType: 'search',
                limit: 10,
                moreUrl: `/library/all?searchTerm=${queryParam}&includeItemTypes=BoxSet`,
                onClick: (card) => this._saveStateAndNavigate('search-collections-items', card)
            });
            this._grids.collections.mount(container);
        }

        // 9. Live TV Channels
        if (channels.length > 0) {
            this._grids.channels = new MediaGrid({
                id: 'search-channels',
                title: i18n.t('LiveTv'),
                items: channels,
                type: 'square',
                contextType: 'search',
                limit: 10,
                moreUrl: `/library/all?searchTerm=${queryParam}&includeItemTypes=TvChannel`,
                onClick: (card) => this._saveStateAndNavigate('search-channels-items', card)
            });
            this._grids.channels.mount(container);
        }

        // Register focus
        this._registerSearchFocus();
    }

    _registerSearchFocus() {
        // Must match all rendered grid keys so the focus chain is complete
        const sectionOrder = [
            'movies',
            'series',
            'episodes',
            'people',
            'artists',
            'albums',
            'songs',
            'collections',
            'channels'
        ];
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

    _saveStateAndNavigate(sectionId, card) {
        if (!card.dataset.itemId) return;

        if (storage.getItem('pref:disableFocusRestore') !== 'true') {
            state.set('search:state', {
                query: this._query,
                results: this._results,
                focusItemId: card.dataset.itemId,
                focusSectionId: sectionId
            });
        }

        const itemType = card.dataset.contextType || card.dataset.type || 'Movie';
        let route = `/details/${card.dataset.itemId}`;

        // Persons AND music artists both open the PersonPage
        // (PersonPage detects artist type and shows albums/songs instead)
        if (
            itemType === 'Person' ||
            itemType === 'MusicArtist' ||
            itemType === 'Artist' ||
            itemType === 'AlbumArtist'
        ) {
            route = `/person/${card.dataset.itemId}`;
        }

        router.navigate(route);
    }

    onBack() {
        // Just navigate back immediately, don't clear search first
        return false;
    }
}

export default SearchPage;
