/**
 * ============================================================================
 * Litefin Tizen - Search Page
 * ============================================================================
 * Search functionality with real-time results.
 * ============================================================================
 */

import Page from './Page.js';
import { api } from '../api/index.js';
import { seerr } from '../api/seerrClient.js';
import { focusManager } from '../ui/FocusManager.js';
import MediaGrid from '../components/MediaGrid.js';
import CardRenderer from '../utils/CardRenderer.js';
import { logger } from '../utils/Logger.js';
import { i18n } from '../utils/i18n.js';
import { storage } from '../utils/StorageService.js';
import { state } from '../core/StateManager.js';
import { router } from '../core/Router.js';

const log = logger.create('SearchPage');

class SearchPage extends Page {
    constructor() {
        super();
        // Flag page as async because onInit performs asynchronous status checks
        this._isAsyncPage = true;

        // Search query strings and results state
        this._query = '';
        this._lastSearchedQuery = ''; // Track to prevent redundant searches
        this._results = [];
        this._debounceTimer = null;
        // Provider state: 'jellyfin' (default) or 'seerr'
        this._provider = storage.getItem('search:provider') || 'jellyfin';
        this._seerrAvailable = false;
    }

    render() {
        return `
            <div class="page search-page">
                <!-- Results -->
                <main class="page-content search-content">
                    <!-- Header with search input & provider toggle -->
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
                        <div class="search-provider-toggle hidden" id="search-provider-toggle">
                            <button 
                                class="provider-btn focusable" 
                                id="provider-jellyfin" 
                                data-provider="jellyfin"
                                tabindex="0"
                            >Jellyfin</button>
                            <button 
                                class="provider-btn focusable" 
                                id="provider-seerr" 
                                data-provider="seerr"
                                tabindex="0"
                            >Seerr</button>
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

    async onInit() {
        this.title = i18n.t('Search');
        this._searchInput = this.$('#search-input');
        this._providerToggle = this.$('#search-provider-toggle');
        this._btnJellyfin = this.$('#provider-jellyfin');
        this._btnSeerr = this.$('#provider-seerr');

        // Check if Seerr plugin is configured and available
        try {
            const status = await seerr.status();
            if (status && status.available) {
                this._seerrAvailable = true;
                if (this._providerToggle) {
                    this._providerToggle.classList.remove('hidden');
                }
            } else {
                this._seerrAvailable = false;
                this._provider = 'jellyfin';
                if (this._providerToggle) {
                    this._providerToggle.classList.add('hidden');
                }
            }
        } catch (e) {
            log.debug('Seerr status check failed on search page', e);
            this._seerrAvailable = false;
            this._provider = 'jellyfin';
        }

        // Apply active class styling to provider buttons
        this._updateProviderUI();

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
            this._searchInput.removeAttribute('readonly');

            setTimeout(() => {
                this._searchInput.focus();
            }, 100);

            // Show empty state
            this.$('#search-empty')?.classList.remove('hidden');
        } else {
            // Rehydrate state
            this._query = searchState.query || '';
            this._results = searchState.results || [];
            this._lastSearchedQuery = searchState.query || '';
            if (searchState.provider && this._seerrAvailable) {
                this._provider = searchState.provider;
                this._updateProviderUI();
            }

            if (this._searchInput) {
                this._searchInput.value = this._query;
            }

            // Hide empty state immediately
            this.$('#search-empty')?.classList.add('hidden');

            if (this._results && this._results.length > 0) {
                if (this._provider === 'seerr') {
                    this._renderSeerrResults();
                } else {
                    this._renderResults();
                }

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

        // Mark page ready to dismiss app splash / loading screen on page refresh
        this.markReady();
        this.restoreScrollFocusWhenReady();
    }

    _updateProviderUI() {
        if (this._btnJellyfin) {
            this._btnJellyfin.classList.toggle('active', this._provider === 'jellyfin');
        }
        if (this._btnSeerr) {
            this._btnSeerr.classList.toggle('active', this._provider === 'seerr');
        }
    }

    _setProvider(provider) {
        if (this._provider === provider) return;
        this._provider = provider;
        storage.setItem('search:provider', provider);
        this._updateProviderUI();

        // Reset last query to force a fresh search with new provider
        this._lastSearchedQuery = '';

        if (this._query) {
            this._search();
        } else {
            this._clearResults();
            this.$('#search-empty')?.classList.remove('hidden');
        }
    }

    _bindEvents() {
        // Provider toggle button click/enter handlers
        if (this._btnJellyfin) {
            this._btnJellyfin.addEventListener('click', () => this._setProvider('jellyfin'));
            this._btnJellyfin.addEventListener('keydown', (e) => {
                if (e.keyCode === 13) this._setProvider('jellyfin');
            });
        }
        if (this._btnSeerr) {
            this._btnSeerr.addEventListener('click', () => this._setProvider('seerr'));
            this._btnSeerr.addEventListener('keydown', (e) => {
                if (e.keyCode === 13) this._setProvider('seerr');
            });
        }

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
                        const sectionOrder = this._provider === 'seerr'
                            ? ['seerr']
                            : [
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
            leaveDown: null,
            leaveLeft: 'sidebar'
        });

        this.setActiveSection('search-header');
    }

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
        this._debounceTimer = setTimeout(() => {
            this._search();
        }, 500);
    }

    async _search() {
        if (!this._query) return;

        // Skip if already searched for this exact query
        if (this._query === this._lastSearchedQuery) return;
        this._lastSearchedQuery = this._query;

        this.setLoading(true);

        try {
            if (this._provider === 'seerr') {
                await this._searchSeerr();
            } else {
                await this._searchJellyfin();
            }
        } catch (error) {
            log.error('Search failed', error);
        }

        this.setLoading(false);
    }

    async _searchSeerr() {
        log.info(`Searching Seerr for "${this._query}"`);
        try {
            const results = await seerr.search(this._query);
            this._results = results || [];

            if (this._results.length > 0) {
                this._renderSeerrResults();
            } else {
                this._clearResults();
                const noResultsEl = this.$('#no-results');
                const noResultsText = this.$('#no-results-text');
                if (noResultsEl && noResultsText) {
                    noResultsText.innerHTML = i18n.t('SearchResultsEmpty', [this._query]);
                    noResultsEl.classList.remove('hidden');
                }
            }
        } catch (err) {
            log.warn('Seerr search failed', err);
            this._clearResults();
            const noResultsEl = this.$('#no-results');
            const noResultsText = this.$('#no-results-text');
            if (noResultsEl && noResultsText) {
                noResultsText.innerHTML = err.message === 'SeerrUnauthorized'
                    ? i18n.t('SeerrSessionExpired')
                    : i18n.t('SeerrLoadFailed');
                noResultsEl.classList.remove('hidden');
            }
        }
    }

    _renderSeerrResults() {
        const container = this.$('#search-results');
        container.innerHTML = '';
        this._grids = {};

        CardRenderer.clearCache();

        this._grids.seerr = new MediaGrid({
            id: 'search-seerr',
            title: i18n.t('SearchResults'),
            items: this._results,
            type: 'poster',
            contextType: 'discover',
            limit: 30,
            allowSeeMore: false,
            onClick: (card) => this._saveStateAndNavigate('search-seerr-items', card)
        });
        this._grids.seerr.mount(container);

        this._registerSearchFocus();
    }

    async _searchJellyfin() {
        log.info(`Searching Jellyfin for "${this._query}"`);

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

        /*
         * Determine whether to search using the dedicated /Search/Hints endpoint (default)
         * or the general /Items endpoint (required by some custom server plugins).
         */
        const useItemsEndpoint = storage.getItem('pref:useItemsForSearch') === 'true';

        const limit = 12; // Fetch 12 so that with a grid limit of 11, the "See More" button appears
        const searchFn = useItemsEndpoint
            ? (type) => api.search(this._query, { IncludeItemTypes: type, Limit: limit })
            : (type) => api.searchHints(this._query, { IncludeItemTypes: type, Limit: limit });

        const requests = [
            ...searchTypes.map((t) => searchFn(t.type)),
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
        const sectionOrder = this._provider === 'seerr'
            ? ['seerr']
            : [
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

        // Register Header Focus Section (includes input and provider toggle buttons)
        this.registerFocusSection('search-header', this.$('#search-header'), {
            orientation: 'horizontal',
            leaveDown: activeTypes.length > 0 ? `${this._grids[activeTypes[0]].id}-items` : null,
            leaveLeft: 'sidebar'
        });

        if (activeTypes.length === 0) return;

        activeTypes.forEach((type, index) => {
            const gridComp = this._grids[type];
            const baseId = gridComp.id;
            const gridZone = `${baseId}-items`;
            const btnZone = `${baseId}-btn-zone`;
            const btnId = `${baseId}-btn`;

            const btn = this.$(`#${btnId}`);
            const isButtonVisible = btn && btn.offsetParent !== null;
            const btnContainer = this.$(`#${btnZone}`);

            const prevType = index > 0 ? activeTypes[index - 1] : null;
            const nextType = index < activeTypes.length - 1 ? activeTypes[index + 1] : null;

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

            // Button Zone
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
        this._destroyGrids();
        this._results = [];
        this._grids = {};
    }

    _destroyGrids() {
        if (!this._grids) return;
        Object.values(this._grids).forEach((grid) => {
            const baseId = grid.id;
            focusManager.unregister(`${baseId}-items`);
            focusManager.unregister(`${baseId}-btn-zone`);
            grid.destroy();
        });
    }

    destroy() {
        this._destroyGrids();
        super.destroy();
    }

    _saveStateAndNavigate(sectionId, card) {
        if (!card.dataset.itemId) return;

        if (storage.getItem('pref:disableFocusRestore') !== 'true') {
            state.set('search:state', {
                query: this._query,
                results: this._results,
                provider: this._provider,
                focusItemId: card.dataset.itemId,
                focusSectionId: sectionId
            });
        }

        // Seerr navigation logic
        if (this._provider === 'seerr' || card.dataset.contextType === 'discover') {
            const cardId = card.dataset.itemId || card.getAttribute('data-id');
            const found = this._results.find((i) => i.Id === cardId || String(i._tmdbId) === String(cardId));
            if (found) {
                const isPerson =
                    found.mediaType === 'person' ||
                    found._mediaType === 'person' ||
                    found.Type === 'Person' ||
                    card.dataset.type === 'Person' ||
                    (typeof cardId === 'string' && cardId.startsWith('tmdb-person-'));

                const cleanTmdbId =
                    found._tmdbId ||
                    found.id ||
                    (typeof cardId === 'string' ? cardId.replace(/^tmdb-(?:movie|tv|person)-/, '') : cardId);

                if (isPerson) {
                    router.navigate(`/seerr/person/${cleanTmdbId}`);
                    return;
                }

                const mediaType = found._mediaType || (found.Type === 'Series' ? 'tv' : 'movie');
                router.navigate(`/seerr/${mediaType}/${cleanTmdbId}`);
                return;
            }
        }

        // Jellyfin navigation logic
        const itemType = card.dataset.contextType || card.dataset.type || 'Movie';
        let route = `/details/${card.dataset.itemId}`;

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
