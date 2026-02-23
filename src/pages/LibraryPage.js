/**
 * ============================================================================
 * Litefin Tizen - Library Page
 * ============================================================================
 * Advanced grid view with tabs, sorting, filtering, and alpha-picker.
 * ============================================================================
 */

import Page from './Page.js';
import { api } from '../api/index.js';
import { router } from '../core/Router.js';
import { focusManager } from '../ui/FocusManager.js';
import CardRenderer from '../utils/CardRenderer.js';
import { VirtualCardRow } from '../components/VirtualCardRow.js';
import { lazyLoader } from '../utils/LazyLoader.js';
import { logger } from '../utils/Logger.js';

const log = logger.create('Library');

class LibraryPage extends Page {
    constructor() {
        super();

        // --- State Management ---
        this.state = {
            libraryId: null,
            libraryInfo: null,
            viewType: 'Items', // 'Items', 'Suggestions', 'Favorites', 'Trailers', etc.

            // Query Params
            sortBy: 'SortName',
            sortOrder: 'Ascending',
            filters: [], // ['IsUnplayed', 'IsFavorite', etc.]
            nameStartsWith: null, // For Alpha Picker

            // Pagination
            startIndex: 0,
            limit: 100, // Per user requirement
            totalRecordCount: 0,

            // Data Cache
            items: [],
            alphaPickerChars: '#ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
        };

        // Bindings
        this._onTabClick = this._handleTabClick.bind(this);
        this._onAlphaClick = this._handleAlphaClick.bind(this);
        this._onPageChange = this._handlePageChange.bind(this);
        this._onGridClick = this._handleGridClick.bind(this);

        // Mark as async page for Navigation State
        // (Page.init won't restore scroll/focus until we call restoreScrollFocusWhenReady)
        this._isAsyncPage = true;
    }

    render() {
        return `
            <div class="page library-page">
                <!-- Scrollable Content Wrapper -->
                <div class="library-scroll-container page-content" id="library-scroll-container">
                    <!-- Header Section -->
                    <header class="library-header" id="library-header">
                        <div class="library-title-row">
                            <h1 class="library-title" id="library-title">Library</h1>
                        </div>

                        <!-- Dynamic Tabs -->
                        <div class="library-tabs" id="library-tabs">
                            <!-- Rendered via JS -->
                        </div>

                        <!-- Controls Row (Moved Below Tabs) -->
                        <div class="library-controls-row">
                            <div class="library-controls" id="library-controls">
                                <!-- Count Indicator (Moved here) -->
                                <span class="count-indicator" id="count-indicator"></span>

                                <!-- Control Buttons -->
                                <button class="control-btn" id="btn-shuffle" tabindex="0">
                                    <span class="icon">
                                        <svg viewBox="0 0 24 24" fill="none" class="control-svg">
                                            <path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                        </svg>
                                    </span>
                                    <span class="control-btn-text">  
                                    Shuffle
                                    </span>
                                </button>
                                <button class="control-btn" id="btn-sort" tabindex="0">
                                    <span class="icon">
                                        <svg viewBox="0 0 24 24" fill="none" class="control-svg">
                                            <path d="M3 6H21" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                                            <path d="M7 12H17" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                                            <path d="M11 18H13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                                        </svg>
                                    </span> 
                                    <span class="control-btn-text">
                                    Sort
                                    </span>
                                </button>
                                <button class="control-btn" id="btn-filter" tabindex="0">
                                    <span class="icon">
                                        <svg viewBox="0 0 24 24" fill="none" class="control-svg">
                                            <path d="M21 4H3L10 12.42V19L14 21V12.42L21 4Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                        </svg>
                                    </span> 
                                    <span class="control-btn-text">
                                    Filter
                                    </span>
                                </button>
                                <button class="control-btn" id="btn-quick-reset" tabindex="0" style="display: none;">
                                    <span class="icon">
                                        <svg viewBox="0 0 24 24" fill="none" class="control-svg">
                                            <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                        </svg>
                                    </span> 
                                    <span class="control-btn-text">
                                    Reset
                                    </span>
                                </button>
                                <button class="control-btn" id="btn-prev-top" tabindex="0">
                                    <span class="icon">
                                        <svg viewBox="0 0 24 24" fill="none" class="control-svg">
                                            <path d="M15 18L9 12L15 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                        </svg>
                                    </span>
                                    <span class="control-btn-text">
                                    Prev
                                    </span>
                                </button>
                                <button class="control-btn" id="btn-next-top" tabindex="0">
                                    <span class="control-btn-text">
                                    Next
                                    </span>
                                    <span class="icon">
                                        <svg viewBox="0 0 24 24" fill="none" class="control-svg" style="margin-right: 0;">
                                            <path d="M9 18L15 12L9 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                        </svg>
                                    </span>
                                </button>
                            </div>
                        </div>

                        <!-- Alpha Picker (Moved inside header as a row) -->
                        <aside class="alpha-picker-container" id="alpha-picker-container">
                            <div class="alpha-picker" id="alpha-picker">
                                <!-- Rendered via JS -->
                            </div>
                        </aside>
                    </header>

                    <!-- Main Content Grid -->
                    <main class="library-content" id="library-content">
                        <div class="library-grid" id="library-grid">
                            <!-- VirtualGrid / CardRenderer items here -->
                        </div>
                        
                        <!-- Empty State -->
                        <div class="empty-state hidden" id="empty-state">
                            <div class="empty-state-content">
                                <div class="empty-state-icon">
                                    <svg viewBox="0 0 24 24" fill="none">
                                        <path d="M21 21L15 15M17 10C17 13.866 13.866 17 10 17C6.13401 17 3 13.866 3 10C3 6.13401 6.13401 3 10 3C13.866 3 17 6.13401 17 10Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                    </svg>
                                </div>
                                <h2 class="empty-state-title">No items found</h2>
                                <p class="empty-state-text">Try adjusting your filters or search to find what you're looking for.</p>
                                <button class="empty-state-btn focusable" id="btn-reset-filters" tabindex="0">
                                    Clear All Filters
                                </button>
                            </div>
                        </div>
                    </main>

                     <!-- Footer Pagination -->
                    <footer class="library-pagination" id="library-pagination">
                        <button class="pagination-btn" id="btn-prev" tabindex="0">
                            <span class="icon">
                                <svg viewBox="0 0 24 24" fill="none" class="control-svg">
                                    <path d="M15 18L9 12L15 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </span>
                            <span class="control-btn-text">
                            Previous
                            </span>
                        </button>
                        <span class="pagination-info" id="pagination-info">Page 1</span>
                        <button class="pagination-btn" id="btn-next" tabindex="0">
                            <span class="control-btn-text">
                            Next
                            </span>
                            <span class="icon">
                                <svg viewBox="0 0 24 24" fill="none" class="control-svg" style="margin-right: 0;">
                                    <path d="M9 18L15 12L9 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </span>
                        </button>
                    </footer>
                </div>

                <!-- Modal Overlay -->
                <div class="modal-overlay" id="modal-overlay" aria-hidden="true">
                    <!-- Dynamic Content -->
                </div>
            </div>
        `;
    }

    // ========================================================================
    // Lifecycle
    // ========================================================================

    async onInit() {
        this.setLoading(true);
        this.state.libraryId = this.params.id;

        // 1. Fetch Library Info
        await this._fetchLibraryInfo();

        // 2. Setup UI Components
        this._renderTabs();
        this._renderAlphaPicker();
        this._updateControlsVisibility();

        // 3. Bind Events
        this._bindEvents();

        // 5. Register Focus
        this._setupFocus();

        // 4. Handle Genre/Studio Mode or Initial Data
        if (this.params.genreId) {
            this.state.viewType = 'Items'; // Force Items view for Genre
            // Fetch Genre Info for Title
            try {
                const genre = await api.getItem(this.params.genreId);
                if (genre) {
                    this.$('#library-title').textContent = genre.Name; // Show Genre Name
                    this.title = genre.Name;
                }
            } catch (e) {
                log.error('Failed to fetch genre info', e);
            }
        } else if (this.params.studioId) {
            this.state.viewType = 'Items'; // Force Items view for Studio
            // Fetch Studio Info for Title
            try {
                const studio = await api.getItem(this.params.studioId);
                if (studio) {
                    this.$('#library-title').textContent = studio.Name; // Show Studio Name
                    this.title = studio.Name;
                }
            } catch (e) {
                log.error('Failed to fetch studio info', e);
            }
        } else if (this.params.year) {
            this.state.viewType = 'Items';
            const year = decodeURIComponent(this.params.year);
            this.$('#library-title').textContent = `Year: ${year}`;
            this.title = year;
        } else if (this.params.personId) {
            this.state.viewType = 'Items';
            try {
                const person = await api.getItem(this.params.personId);
                if (person) {
                    this.$('#library-title').textContent = person.Name;
                    this.title = person.Name;
                }
            } catch (e) {
                log.error('Failed to fetch person info', e);
            }
        } else if (this.params.tagName) {
            this.state.viewType = 'Items';
            const tagName = decodeURIComponent(this.params.tagName);
            this.$('#library-title').textContent = `Tag: ${tagName}`;
            this.title = tagName;
        }

        await this._loadItems();

        // Trigger deferred scroll/focus restoration now that content is loaded
        this.restoreScrollFocusWhenReady();
    }

    /**
     * Handle back navigation
     * @returns {boolean} True if handled
     */
    onBack() {
        // Check if modal is open
        const overlay = this.$('#modal-overlay');
        if (overlay && overlay.classList.contains('visible')) {
            if (overlay.querySelector('.filter-modal')) {
                this._closeFilterModal();
            } else {
                this._closeModal();
            }
            return true;
        }
        return false;
    }

    _setupFocus() {
        // Determine start section
        // For BoxSets, tabs are hidden, so start at Controls or Grid
        const collectionType = this.state.libraryInfo?.CollectionType;

        if (collectionType === 'boxsets') {
            // Try controls first (Sort/Filter), else Grid
            // But controls are usually enabled for BoxSets now.
            this.setActiveSection('library-controls');
        } else {
            // Standard views have tabs
            // Ensure tabs are actually visible?
            if (this.$('#library-tabs')?.style.display !== 'none') {
                this.setActiveSection('library-tabs');
            } else {
                // Fallback (e.g. if tabs hidden for some reason)
                this.setActiveSection('library-controls');
            }
        }
    }

    _bindEvents() {
        this.$('#library-tabs')?.addEventListener('click', this._handleTabClick.bind(this));
        this.$('#btn-shuffle')?.addEventListener('click', this._handleShuffle.bind(this));
        this.$('#btn-sort')?.addEventListener('click', this._handleSort.bind(this));
        this.$('#btn-filter')?.addEventListener('click', this._handleFilter.bind(this));
        this.$('#btn-quick-reset')?.addEventListener('click', this._handleResetFilters.bind(this));
        this.$('#alpha-picker')?.addEventListener('click', this._handleAlphaClick.bind(this));
        this.$('#btn-prev')?.addEventListener('click', () => this._handlePageChange(-1));
        this.$('#btn-next')?.addEventListener('click', () => this._handlePageChange(1));
        this.$('#btn-prev-top')?.addEventListener('click', () => this._handlePageChange(-1));
        this.$('#btn-next-top')?.addEventListener('click', () => this._handlePageChange(1));
        this.$('#btn-reset-filters')?.addEventListener('click', this._handleResetFilters.bind(this));

        // Modal Overlay Close
        this.$('#modal-overlay')?.addEventListener('click', (e) => {
            if (e.target.id === 'modal-overlay') this._closeModal();
        });

        // Horizontal Rows Header Click
        // Attach to #library-content (stable parent)
        this.$('#library-content')?.addEventListener('click', (e) => {
            // Handle genre header clicks
            const headerBtn = e.target.closest('.header-focusable');
            if (headerBtn) {
                const rowHeader = headerBtn.closest('.library-row-header');
                if (!rowHeader) return;

                const rowEl = rowHeader.parentElement; // .library-row
                if (!rowEl) return;

                const genreId = rowEl.dataset.genreId;

                if (genreId) {
                    log.info('Navigating to Genre:', genreId);
                    // Navigate to Genre Filtered Page
                    router.navigate(`/library/${this.state.libraryId}/genre/${genreId}`);
                }
                return;
            }

            // Handle media card clicks in horizontal rows AND grid
            const mediaCard = e.target.closest('.media-card');
            if (mediaCard?.dataset?.itemId) {
                const itemId = mediaCard.dataset.itemId;

                // Special handling for Networks view: navigate to studio-filtered library
                if (this.state.viewType === 'Networks') {
                    log.info('Navigating to Studio:', itemId);
                    router.navigate(`/library/${this.state.libraryId}/studio/${itemId}`);
                    return;
                }

                // Default: navigate to item details
                log.info('Navigating to item details:', itemId);
                router.navigate(`/details/${itemId}`);
            }
        });
    }

    // ========================================================================
    // Navigation State (for back navigation restoration)
    // ========================================================================

    /**
     * Get page state for navigation history.
     * Saves filters, sort, pagination, and tab selection.
     */
    getNavigationState() {
        return {
            viewType: this.state.viewType,
            sortBy: this.state.sortBy,
            sortOrder: this.state.sortOrder,
            filters: [...this.state.filters], // Clone array
            nameStartsWith: this.state.nameStartsWith,
            startIndex: this.state.startIndex,
            limit: this.state.limit
        };
    }

    /**
     * Restore page state from navigation history.
     * Applied BEFORE content loads, so _loadItems uses these values.
     */
    setNavigationState(savedState) {
        if (!savedState) return;

        // Merge saved state into current state
        // This will be used when _loadItems() is called in onInit()
        Object.assign(this.state, {
            viewType: savedState.viewType || this.state.viewType,
            sortBy: savedState.sortBy || this.state.sortBy,
            sortOrder: savedState.sortOrder || this.state.sortOrder,
            filters: savedState.filters || [],
            nameStartsWith: savedState.nameStartsWith || null,
            startIndex: savedState.startIndex || 0,
            limit: savedState.limit || this.state.limit
        });

        log.info('Navigation state restored:', savedState);
    }

    destroy() {
        super.destroy();
        this.$('#library-tabs')?.removeEventListener('click', this._onTabClick);
        this.$('#alpha-picker')?.removeEventListener('click', this._onAlphaClick);
    }

    // ========================================================================
    // Data Fetching
    // ========================================================================

    async _fetchLibraryInfo() {
        try {
            const item = await api.getItem(this.state.libraryId);
            this.state.libraryInfo = item;
            this.$('#library-title').textContent = item.Name;
            this.title = item.Name; // Update Page title
        } catch (e) {
            log.error('Failed to fetch info', e);
        }
    }

    async _loadItems() {
        this.setLoading(true);

        // Show Skeleton instead of spinner
        // Pre-emptive Cleanup: Hide horizontal rows early if switching to grid
        const isHorizontalLayout =
            this.state.viewType === 'Genres' ||
            this.state.viewType === 'Suggestions' ||
            this.state.viewType === 'Upcoming';
        const rowsContainer = this.$('#library-rows');
        const grid = this.$('#library-grid');

        const isLandscape =
            this.state.viewType === 'Episodes' ||
            this.state.viewType === 'Upcoming' ||
            this.state.viewType === 'Networks';
        if (!isHorizontalLayout) {
            if (rowsContainer) rowsContainer.style.display = 'none';
            if (grid) grid.style.display = '';
        } else {
            if (rowsContainer) rowsContainer.style.display = '';
            if (grid) grid.style.display = 'none';
        }

        if (grid && !isHorizontalLayout) {
            grid.innerHTML = CardRenderer.createSkeletonHtml(12, isLandscape);
        }

        try {
            const params = {
                ParentId: this.state.libraryId,
                SortBy: this.state.sortBy,
                SortOrder: this.state.sortOrder,
                StartIndex: this.state.startIndex,
                Limit: this.state.limit,
                Recursive: true,
                Fields: 'PrimaryImageAspectRatio,BasicSyncInfo,DateCreated,ProductionYear,CommunityRating,OfficialRating',
                ImageTypeLimit: 1,
                EnableImageTypes: 'Primary,Backdrop,Thumb'
            };

            // Apply Filters
            if (this.state.nameStartsWith) {
                params.NameStartsWith = this.state.nameStartsWith;
            }

            // Apply Genre Filter (From Route)
            if (this.params.genreId) {
                params.GenreIds = this.params.genreId;
                params.Recursive = true;
                params.IncludeItemTypes = 'Movie,Series,Episode'; // Broaden search for Genre view
            }

            // Apply Studio Filter (From Route)
            if (this.params.studioId) {
                params.StudioIds = this.params.studioId;
                params.IncludeItemTypes = 'Movie,Series,Episode';
            }

            // Apply Year Filter (From Route)
            if (this.params.year) {
                params.Years = decodeURIComponent(this.params.year);
                params.IncludeItemTypes = 'Movie,Series,Episode';
            }

            // Apply Person Filter (From Route)
            if (this.params.personId) {
                params.PersonIds = this.params.personId;
                params.IncludeItemTypes = 'Movie,Series,Episode';
            }

            // Apply Tag Filter (From Route)
            if (this.params.tagName) {
                params.Tags = decodeURIComponent(this.params.tagName);
                params.IncludeItemTypes = 'Movie,Series,Episode';
            }

            // Apply Advanced Filters
            if (this.state.filters) {
                const f = this.state.filters;
                const filtersParam = [];

                // Boolean Filters that map to 'Filters' param
                if (f.IsPlayed) filtersParam.push('IsPlayed');
                if (f.IsUnplayed) filtersParam.push('IsUnplayed');
                if (f.IsResumable) filtersParam.push('IsResumable');
                if (f.IsFavorite) filtersParam.push('IsFavorite');

                if (filtersParam.length > 0) {
                    if (params.Filters) {
                        params.Filters = params.Filters + ',' + filtersParam.join(',');
                    } else {
                        params.Filters = filtersParam.join(',');
                    }
                }

                // Boolean params
                if (f.HasSubtitles) params.HasSubtitles = true;
                if (f.HasTrailer) params.HasTrailer = true;
                if (f.HasSpecialFeature) params.HasSpecialFeature = true;
                if (f.HasThemeSong) params.HasThemeSong = true;
                if (f.HasThemeVideo) params.HasThemeVideo = true;

                // Video Type booleans
                if (f.IsHD !== undefined) params.IsHD = f.IsHD;
                if (f.Is4K) params.Is4K = true;
                if (f.Is3D) params.Is3D = true;

                // Multi-value params
                if (f.Genres) params.Genres = f.Genres.replace(/,/g, '|');
                if (f.OfficialRatings) params.OfficialRatings = f.OfficialRatings.replace(/,/g, '|');
                if (f.Tags) params.Tags = f.Tags.replace(/,/g, '|');
                if (f.Years) params.Years = f.Years;
                if (f.VideoTypes) params.VideoTypes = f.VideoTypes;
            }

            // Handle View Types
            let result;
            const viewType = this.state.viewType;

            if (viewType === 'Items' || viewType === 'Movies' || viewType === 'Shows') {
                // Standard Item Fetch
                // For TV Shows library, 'Shows' -> IncludeItemTypes: 'Series'
                if (this.state.libraryInfo?.CollectionType === 'tvshows') {
                    params.IncludeItemTypes = 'Series';
                } else if (this.state.libraryInfo?.CollectionType === 'movies') {
                    params.IncludeItemTypes = 'Movie';
                } else if (this.state.libraryInfo?.CollectionType === 'boxsets') {
                    params.IncludeItemTypes = 'BoxSet';
                    params.Recursive = true;
                }
                result = await api.getItems(params);
            } else if (viewType === 'Suggestions') {
                // Fetch multiple rows for Suggestions with Recommendations
                const rows = [];

                const collectionType = this.state.libraryInfo?.CollectionType;
                const suggestionTypes = collectionType === 'tvshows' ? 'Series' : 'Movie,Series';

                // 1. Continue Watching & Next Up & Latest (Parallel Fetch)
                const [resume, nextUp, latest] = await Promise.all([
                    api.getResumeItems({ Limit: 12, ParentId: this.state.libraryId }),
                    api.getNextUp({ Limit: 12, ParentId: this.state.libraryId }),
                    api.getLatestItems(this.state.libraryId, { Limit: 12, IncludeItemTypes: suggestionTypes })
                ]);

                if (resume.Items && resume.Items.length > 0) {
                    rows.push({
                        title: 'Continue Watching',
                        items: resume.Items,
                        isLandscape: true,
                        cardType: 'backdrop',
                        contextType: 'resume'
                    });
                }
                if (nextUp.Items && nextUp.Items.length > 0) {
                    rows.push({
                        title: 'Next Up',
                        items: nextUp.Items,
                        isLandscape: true,
                        cardType: 'backdrop',
                        contextType: 'nextUp'
                    });
                }
                if (latest && latest.length > 0) {
                    rows.push({ title: 'Latest Added', items: latest });
                }

                // 2. "Because You Watch..." (Based on active resume items)
                if (resume.Items && resume.Items.length > 0) {
                    // Pick a random item from likely candidates
                    const candidates = resume.Items.slice(0, 3);
                    const sourceItem = candidates[Math.floor(Math.random() * candidates.length)];

                    // If it's an episode, use the Series ID for better suggestions
                    const targetId =
                        sourceItem.Type === 'Episode' && sourceItem.SeriesId ? sourceItem.SeriesId : sourceItem.Id;
                    const targetName =
                        sourceItem.Type === 'Episode' && sourceItem.SeriesName
                            ? sourceItem.SeriesName
                            : sourceItem.Name;

                    try {
                        const similar = await api.getSimilar(targetId, {
                            Limit: 12,
                            IncludeItemTypes: suggestionTypes
                        });
                        if (similar.Items && similar.Items.length > 0) {
                            rows.push({ title: `Because you watch ${targetName}`, items: similar.Items });
                        }
                    } catch (e) {
                        log.warn('Failed to load similar suggestions', e);
                    }
                }

                // 3. "Because You Like..." (Based on random Favorite in this library)
                try {
                    const favorites = await api.getItems({
                        ParentId: this.state.libraryId,
                        IsFavorite: true,
                        SortBy: 'Random',
                        Limit: 1,
                        Recursive: true,
                        IncludeItemTypes: 'Movie,Series'
                    });

                    if (favorites.Items && favorites.Items.length > 0) {
                        const favItem = favorites.Items[0];
                        const similarFav = await api.getSimilar(favItem.Id, {
                            Limit: 12,
                            IncludeItemTypes: suggestionTypes
                        });
                        if (similarFav.Items && similarFav.Items.length > 0) {
                            rows.push({ title: `Because you like ${favItem.Name}`, items: similarFav.Items });
                        }
                    }
                } catch (e) {
                    log.warn('Failed to load favorite suggestions', e);
                }

                this.state.items = []; // Clear grid items
                this._renderHorizontalRows(rows);
                this._updatePaginationUI();
                return; // Skip grid render
            } else if (viewType === 'Genres') {
                // Fetch Genres List
                result = await api.getGenres({
                    ParentId: this.state.libraryId,
                    SortBy: 'SortName',
                    SortOrder: 'Ascending',
                    Limit: 50 // Fetch top 50 genres max to keep requests reasonable
                });

                const allGenres = result.Items || [];

                // Fetch items for ALL genres in parallel (Limit 12 per genre)
                // We pre-load data so we don't need row-intersections
                const collectionType = this.state.libraryInfo?.CollectionType;
                const includeItemTypes =
                    collectionType === 'tvshows' ? 'Series' : collectionType === 'movies' ? 'Movie' : 'Movie,Series';

                const rowPromises = allGenres.map(async (genre) => {
                    const params = {
                        ParentId: this.state.libraryId,
                        GenreIds: genre.Id,
                        StartIndex: 0,
                        Limit: 12, // Max 12 items as requested
                        Recursive: true,
                        IncludeItemTypes: includeItemTypes,
                        Fields: 'PrimaryImageAspectRatio,ProductionYear,CommunityRating',
                        ImageTypeLimit: 1,
                        EnableImageTypes: 'Primary,Backdrop,Thumb'
                    };

                    try {
                        const itemsResult = await api.getItems(params);
                        return {
                            title: genre.Name,
                            genreId: genre.Id,
                            isLazy: false, // Data is fully loaded
                            items: itemsResult.Items || []
                        };
                    } catch (err) {
                        log.warn(`Failed to load items for genre ${genre.Name}`, err);
                        return null;
                    }
                });

                const loadedRows = (await Promise.all(rowPromises)).filter((r) => r && r.items.length > 0);

                this.state.items = [];
                this._renderHorizontalRows(loadedRows);
                this._updatePaginationUI();
                return;
            } else if (viewType === 'Upcoming') {
                // Fetch upcoming items
                result = await api.getUpcoming({ ParentId: this.state.libraryId, Limit: 60 });
                const items = result.Items || [];

                // Sort by date first to ensure correct grouping order
                items.sort((a, b) => new Date(a.PremiereDate || a.AirTime) - new Date(b.PremiereDate || b.AirTime));

                const rows = [];
                let currentBatch = null;
                let currentKey = '';

                items.forEach((item) => {
                    const dateStr = item.PremiereDate || item.AirTime;
                    if (!dateStr) return;

                    const date = new Date(dateStr);
                    const key = date.toDateString(); // Groups by day

                    if (key !== currentKey) {
                        if (currentBatch) rows.push(currentBatch);
                        currentKey = key;
                        currentBatch = {
                            date: date,
                            items: []
                        };
                    }
                    currentBatch.items.push(item);
                });
                if (currentBatch) rows.push(currentBatch);

                // Format Rows
                const today = new Date();
                today.setHours(0, 0, 0, 0);
                const tomorrow = new Date(today);
                tomorrow.setDate(tomorrow.getDate() + 1);

                const displayRows = rows.map((group) => {
                    const d = group.date;
                    // Reset time for strictly date comparison
                    const dZero = new Date(d);
                    dZero.setHours(0, 0, 0, 0);

                    let title = d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });

                    if (dZero.getTime() === today.getTime()) title = 'Today';
                    else if (dZero.getTime() === tomorrow.getTime()) title = 'Tomorrow';

                    return {
                        title: title,
                        items: group.items,
                        genreId: null // Static header
                    };
                });

                this.state.items = [];
                // CRITICAL: Reset totalRecordCount to prevent stale pagination footer
                this.state.totalRecordCount = 0;

                this._renderHorizontalRows(displayRows);
                this._updatePaginationUI();
                return;
            } else if (viewType === 'Episodes') {
                // Flattened episodes view
                params.IncludeItemTypes = 'Episode';
                result = await api.getItems(params);
            } else if (viewType === 'Favorites') {
                params.Filters = 'IsFavorite';
                result = await api.getItems(params);
            } else if (viewType === 'Networks') {
                // Fetch studios/networks for this library
                result = await api.getStudios({ ParentId: this.state.libraryId });
            } else if (viewType === 'Collections') {
                params.IncludeItemTypes = 'BoxSet';
                params.Recursive = true;
                result = await api.getItems(params);
            }

            this.state.items = result.Items || [];
            this.state.totalRecordCount = result.TotalRecordCount || 0;

            this._renderGrid(this.state.items);
            this._updatePaginationUI();
        } catch (e) {
            log.error('Failed to load items', e);
            this.$('#library-grid').innerHTML = `<p class="error-msg">Failed to load content</p>`;
        } finally {
            this.setLoading(false);
            // Apply Header visibility and specialization AFTER content is loaded
            this._updateControlsVisibility();
            this._updateHeaderVisibility();

            // Force Focus Check - Ensure we don't drop focus after load
            // Especially for BoxSets where tabs are hidden and initial focus might be lost
            if (!document.activeElement || document.activeElement === document.body) {
                const collectionType = this.state.libraryInfo?.CollectionType;
                if (collectionType === 'boxsets') {
                    // Force controls or grid
                    if (this.$('#library-controls')?.style.display !== 'none') {
                        this.setActiveSection('library-controls');
                    } else {
                        this.setActiveSection('library-grid');
                    }
                } else {
                    // Try to restore valid focus or default
                    if (this.$('#library-tabs')?.style.display !== 'none') {
                        // Don't force tabs if we are deep in pagination, but on loadItems usually tabs or grid
                    }
                }
            }
        }
    }

    _updatePaginationUI() {
        const { startIndex, limit, totalRecordCount } = this.state;
        const currentPage = Math.floor(startIndex / limit) + 1;
        const totalPages = Math.ceil(totalRecordCount / limit);

        this.$('#pagination-info').textContent = `Page ${currentPage} of ${totalPages || 1}`;

        // Hide/Show logic for single page or horizontal row views (Genres/Suggestions)
        const isHorizontalView = this.state.viewType === 'Genres' || this.state.viewType === 'Suggestions';
        const isSinglePage = totalPages <= 1 || isHorizontalView;

        // Hide bottom footer entirely if single page or horizontal view
        const footer = this.$('#library-pagination');
        if (footer) footer.style.display = isSinglePage ? 'none' : 'flex';

        // Disable/Enable buttons
        const isPrevDisabled = startIndex <= 0;
        const isNextDisabled = startIndex + limit >= totalRecordCount;

        this.$('#btn-prev').disabled = isPrevDisabled;
        this.$('#btn-next').disabled = isNextDisabled;

        const btnPrevTop = this.$('#btn-prev-top');
        const btnNextTop = this.$('#btn-next-top');

        if (btnPrevTop) {
            btnPrevTop.disabled = isPrevDisabled;
            btnPrevTop.style.display = isSinglePage ? 'none' : '';
        }
        if (btnNextTop) {
            btnNextTop.disabled = isNextDisabled;
            btnNextTop.style.display = isSinglePage ? 'none' : '';
        }

        // Ensure we invalidate focus cache if we hide elements
        if (isSinglePage) {
            focusManager.invalidateCache('library-controls');
        }
    }

    // ========================================================================
    // Rendering Logic
    // ========================================================================

    _renderTabs() {
        const collectionType = this.state.libraryInfo?.CollectionType || 'movies';
        const tabsContainer = this.$('#library-tabs');

        // Hide tabs for BoxSets (Collections) library
        if (collectionType === 'boxsets') {
            if (tabsContainer) {
                tabsContainer.style.display = 'none';
                tabsContainer.innerHTML = '';
            }
            focusManager.unregister('library-tabs');
            return;
        }

        if (tabsContainer) tabsContainer.style.display = '';

        // Define tabs based on collection type
        let tabs = [];

        if (collectionType === 'tvshows') {
            tabs = [
                { id: 'Items', label: 'Shows' },
                { id: 'Suggestions', label: 'Suggestions' },
                { id: 'Upcoming', label: 'Upcoming' },
                { id: 'Genres', label: 'Genres' },
                { id: 'Networks', label: 'Networks' },
                { id: 'Episodes', label: 'Episodes' }
            ];
        } else if (collectionType === 'movies') {
            tabs = [
                { id: 'Items', label: 'Movies' },
                { id: 'Suggestions', label: 'Suggestions' },
                { id: 'Favorites', label: 'Favorites' }, // TODO: Filter logic?
                { id: 'Collections', label: 'Collections' },
                { id: 'Genres', label: 'Genres' }
            ];
        } else {
            // Generic fallback
            tabs = [
                { id: 'Items', label: 'Items' },
                { id: 'Suggestions', label: 'Suggestions' },
                { id: 'Genres', label: 'Genres' },
                { id: 'Folders', label: 'Folders' }
            ];
        }

        if (!tabsContainer) return;

        tabsContainer.innerHTML = tabs
            .map(
                (tab) => `
            <button class="tab-btn ${this.state.viewType === tab.id ? 'active' : ''}" 
                    data-type="${tab.id}" 
                    tabindex="0">
                ${tab.label}
            </button>
        `
            )
            .join('');

        // Re-register focus to capture new buttons
        focusManager.register('library-tabs', this.$('#library-tabs'), {
            orientation: 'horizontal',
            leaveUp: null, // Top of content
            leaveDown: 'library-controls',
            leaveLeft: 'sidebar',
            enterTo: 'active-element', // Focus active tab
            scrollOffsetTop: 400 // Large offset to ensure full top visibility
        });
    }

    _renderAlphaPicker() {
        // Always show Alpha Picker as requested
        const showPicker = true;
        const container = this.$('#alpha-picker-container');

        if (container) {
            container.style.visibility = 'visible';
        }

        if (!showPicker) return;

        const picker = this.$('#alpha-picker');
        if (!picker) return;

        const activeChar = this.state.nameStartsWith;

        picker.innerHTML = this.state.alphaPickerChars
            .map((char) => {
                const isActive = char === activeChar || (char === '#' && activeChar === '0-9'); // Simplify # logic
                return `
                <button class="alpha-btn ${isActive ? 'active' : ''}" 
                        data-char="${char}" 
                        tabindex="0">
                    ${char}
                </button>
            `;
            })
            .join('');

        focusManager.register('alpha-picker', this.$('#alpha-picker'), {
            orientation: 'horizontal',
            leaveUp: 'library-controls',
            leaveDown: 'library-grid',
            leaveLeft: 'sidebar',
            enterTo: 'active-element' // Focus the selected char
        });
    }

    _renderGrid(items) {
        const grid = this.$('#library-grid');
        if (!grid) return;

        // Cleanup: Hide horizontal rows if they exist and restore grid
        const rowsContainer = this.$('#library-rows');
        if (rowsContainer) {
            rowsContainer.style.display = 'none';
        }
        grid.style.display = ''; // Restore grid display

        const pagination = this.$('#library-pagination');
        if (pagination) pagination.style.display = ''; // Restore pagination

        // Use landscape cards via CSS class if needed (e.g. for Episodes, Upcoming, Networks)
        const isLandscape =
            this.state.viewType === 'Episodes' ||
            this.state.viewType === 'Upcoming' ||
            this.state.viewType === 'Networks';

        if (isLandscape) {
            grid.classList.add('landscape');
        } else {
            grid.classList.remove('landscape');
        }

        if (!items || items.length === 0) {
            grid.innerHTML = '';
            this.$('#empty-state').classList.remove('hidden');
            this.$('#count-indicator').textContent = '0 items';
            this.$('#pagination-info').textContent = '';

            // Check if controls should be visible (logic matched with _updateHeaderVisibility)
            const collectionType = this.state.libraryInfo?.CollectionType;
            const viewType = this.state.viewType;
            const isMovieMain = collectionType === 'movies' && viewType === 'Items';
            const isTVMain = collectionType === 'tvshows' && viewType === 'Items';
            const isEpisodes = viewType === 'Episodes';
            const shouldShowControls = isMovieMain || isTVMain || isEpisodes;

            const btnReset = this.$('#btn-reset-filters');
            if (btnReset) {
                btnReset.style.display = shouldShowControls ? '' : 'none';
            }

            if (shouldShowControls) {
                // Register Empty State Button for focus
                focusManager.register('empty-state-btn', this.$('#empty-state'), {
                    leaveUp: 'alpha-picker', // Default to alpha picker
                    leaveLeft: 'sidebar',
                    selector: '#btn-reset-filters'
                });

                // Link Alpha Picker/Controls DOWN to Empty State Button
                const alphaConfig = focusManager.getSectionConfig('alpha-picker');
                if (alphaConfig) {
                    focusManager.register('alpha-picker', this.$('#alpha-picker'), {
                        ...alphaConfig,
                        leaveDown: 'empty-state-btn'
                    });
                }

                // Also update controls
                const controlsConfig = focusManager.getSectionConfig('library-controls');
                if (controlsConfig) {
                    focusManager.register('library-controls', this.$('#library-controls'), {
                        ...controlsConfig,
                        leaveDown:
                            this.$('#alpha-picker-container').style.display === 'none'
                                ? 'empty-state-btn'
                                : 'alpha-picker'
                    });
                }

                // Check if we lost focus (e.g. was in grid)
                const currentFocus = document.activeElement;
                const focusesTabs = currentFocus && this.$('#library-tabs')?.contains(currentFocus);
                const focusesSidebar = currentFocus && document.getElementById('sidebar')?.contains(currentFocus);
                const hasValidFocus = focusesTabs || focusesSidebar;

                if (!hasValidFocus) {
                    focusManager.setActiveSection('empty-state-btn');
                }
            } else {
                // Check if we lost focus (e.g. was in grid)
                const currentFocus = document.activeElement;
                const focusesTabs = currentFocus && this.$('#library-tabs')?.contains(currentFocus);
                const focusesSidebar = currentFocus && document.getElementById('sidebar')?.contains(currentFocus);
                // Also check if focusManager thinks we are in tabs (state persistence)
                const activeSection = focusManager.getActionSection();
                const isTabsActive = activeSection === 'library-tabs';

                const hasValidFocus = focusesTabs || focusesSidebar;

                if (!hasValidFocus) {
                    // Try to restore focus to the active tab button
                    const activeTabBtn = this.$(`.tab-btn[data-type="${this.state.viewType}"]`);
                    if (activeTabBtn && (isTabsActive || !currentFocus || currentFocus === document.body)) {
                        log.info('Restoring focus to active tab:', this.state.viewType);
                        focusManager.setActiveSection('library-tabs');
                        activeTabBtn.focus();
                    } else {
                        // Fallback to Sidebar if we really lost context
                        log.info('Lost focus context, defaulting to sidebar');
                        focusManager.setActiveSection('sidebar');
                    }
                }
            }
            return;
        }

        this.$('#empty-state').classList.add('hidden');

        // Update Count
        const start = this.state.startIndex + 1;
        const end = Math.min(this.state.startIndex + this.state.limit, this.state.totalRecordCount);
        this.$('#count-indicator').textContent = `${start}-${end} of ${this.state.totalRecordCount}`;

        // Generate HTML
        const html = items
            .map((item) =>
                CardRenderer.createCardHtml(item, {
                    isLandscape: isLandscape,
                    type:
                        this.state.viewType === 'Episodes' || this.state.viewType === 'Upcoming'
                            ? 'episode'
                            : this.state.viewType === 'Networks'
                              ? 'backdrop'
                              : 'poster',
                    contextType: this.state.viewType === 'Upcoming' ? 'upcoming' : null // Handle special contexts
                })
            )
            .join('');

        grid.innerHTML = html;

        // Lazy Load Images
        lazyLoader.observe(grid);

        // Update Alpha Picker navigation to point to grid
        focusManager.register('alpha-picker', this.$('#alpha-picker'), {
            orientation: 'horizontal',
            leaveUp: 'library-controls',
            leaveDown: 'library-grid',
            leaveLeft: 'sidebar',
            enterTo: 'active-element'
        });

        // Re-register focus for grid items
        focusManager.register('library-grid', grid, {
            orientation: 'grid',
            leaveUp: 'library-controls', // or alpha picker
            leaveDown: 'library-pagination',
            leaveLeft: 'sidebar',
            selector: '.media-card',
            scrollOffsetTop: 100
        });

        // Ensure library-controls points correctly to alpha-picker (fix for switching from Suggestions)
        // Check if alpha picker is actually visible
        const alphaContainer = this.$('#alpha-picker-container');
        const isAlphaVisible = alphaContainer && alphaContainer.style.display !== 'none';

        focusManager.register('library-controls', this.$('#library-controls'), {
            orientation: 'horizontal',
            leaveUp: 'library-tabs',
            leaveDown: isAlphaVisible ? 'alpha-picker' : 'library-grid',
            leaveLeft: 'sidebar',
            selector: 'button'
        });
    }
    _renderHorizontalRows(rows) {
        const grid = this.$('#library-grid');
        const pagination = this.$('#library-pagination');
        const emptyState = this.$('#empty-state');

        // Hide standard grid/pagination for horizontal row views
        if (grid) grid.style.display = 'none';
        if (pagination) pagination.style.display = 'none';
        if (emptyState) emptyState.classList.add('hidden');

        // Check/Create rows container
        let container = this.$('#library-rows');
        if (!container) {
            container = document.createElement('div');
            container.id = 'library-rows';
            container.className = 'library-rows-container';
            // Insert before grid
            if (grid && grid.parentNode) {
                grid.parentNode.insertBefore(container, grid);
            }
        } else {
            container.innerHTML = '';
            container.style.display = 'flex';
        }

        if (!container) return;

        // Handle empty state
        if (!rows || rows.length === 0) {
            if (emptyState) {
                emptyState.classList.remove('hidden');

                const btnReset = this.$('#btn-reset-filters');
                const isUpcoming = this.state.viewType === 'Upcoming';
                const isSuggestions = this.state.viewType === 'Suggestions';

                // Hide reset button for views where standard filters don't apply
                if (btnReset) {
                    if (isUpcoming || isSuggestions) {
                        btnReset.style.display = 'none';
                        this.$('#count-indicator').textContent = 'No items found'; // Better message
                    } else {
                        btnReset.style.display = '';
                        // Only register focus if the button is visible
                        focusManager.register('empty-state-btn', btnReset, {
                            leaveUp: 'library-tabs',
                            leaveLeft: 'sidebar'
                        });
                        focusManager.setActiveSection('empty-state-btn');
                        return;
                    }
                }

                // If button is hidden (Upcoming/Suggestions), we need to set focus somewhere valid
                // Try focusing the active tab
                const activeTab = this.$(`.tab-btn[data-type="${this.state.viewType}"]`);
                if (activeTab) {
                    focusManager.setActiveSection('library-tabs');
                    activeTab.focus();
                } else {
                    focusManager.setActiveSection('sidebar');
                }
            }
            return;
        }

        // Determine navigation target for the first row
        // For horizontal views like Suggestions/Upcoming, controls/picker are hidden,
        // so we navigate straight back to the tabs.
        // NOTE: Genres uses grid layout with focusable headers, so it goes through controls.
        const isHorizontalLayout = this.state.viewType === 'Suggestions' || this.state.viewType === 'Upcoming';
        const nextUpTarget =
            isHorizontalLayout || this.state.viewType === 'Genres' ? 'library-tabs' : 'library-controls';

        rows.forEach((row, rowIndex) => {
            const headerId = `header-${rowIndex}`;
            const listId = `list-${rowIndex}`;

            const section = document.createElement('div');
            section.className = 'library-row media-row'; // media-row for FocusManager scroll detection
            section.dataset.index = rowIndex;
            section.dataset.genreId = row.genreId || '';

            // Focusable Header (clickable to navigate to genre page)
            // Only make focusable if it's actionable (has genreId)
            const isActionable = !!row.genreId;
            const headerHtml = isActionable
                ? `
                <div class="library-row-header" id="${headerId}">
                    <button class="header-focusable" tabindex="0" data-genre-id="${row.genreId}">
                        <span class="header-title">${row.title}</span>
                        <i class="fa-solid fa-chevron-right header-arrow"></i>
                    </button>
                </div>
            `
                : `
                 <div class="library-row-header" id="${headerId}">
                    <div class="header-static">
                        <span class="header-title">${row.title}</span>
                    </div>
                </div>
            `;

            // Grid Items (Max 12)
            const displayItems = (row.items || []).slice(0, 12);
            let contentHtml = '';

            if (displayItems.length > 0) {
                contentHtml = displayItems
                    .map((item) =>
                        CardRenderer.createCardHtml(item, {
                            isLandscape: row.isLandscape || false,
                            type: row.cardType || 'poster',
                            contextType: row.contextType || null
                        })
                    )
                    .join('');
            } else {
                contentHtml = '<div class="empty-msg">No items</div>';
            }

            // Use row-items (horizontal scroll) for Upcoming/Suggestions, genre-grid-items (grid) for Genres
            const isHorizontalRow = this.state.viewType === 'Upcoming' || this.state.viewType === 'Suggestions';

            let virtualRow = null;

            if (isHorizontalRow) {
                section.innerHTML = `
                    ${headerHtml}
                    <div class="row-items" id="${listId}">
                        <div class="row-items-track"></div>
                    </div>
                `;
            } else {
                section.innerHTML = `
                    ${headerHtml}
                    <div class="genre-grid-items" id="${listId}">
                        ${contentHtml}
                    </div>
                `;
            }

            container.appendChild(section);

            if (isHorizontalRow) {
                const trackContainer = section.querySelector('.row-items-track');
                virtualRow = new VirtualCardRow(trackContainer, displayItems, {
                    isLandscape: row.isLandscape || false,
                    visibleCount: row.isLandscape || false ? 8 : 12,
                    focusSectionId: `library-row-${rowIndex}`,
                    renderCard: (item) =>
                        CardRenderer.createCardHtml(item, {
                            isLandscape: row.isLandscape || false,
                            type: row.cardType || 'poster',
                            contextType: row.contextType || null
                        })
                });

                if (!this._virtualRows) this._virtualRows = [];
                this._virtualRows[rowIndex] = virtualRow;

                // Track focus sync for the instance
                section.addEventListener('focusin', (e) => {
                    if (e.target.classList.contains('media-card') && virtualRow) {
                        virtualRow.syncIndexFromNode(e.target);
                    }
                });
            }

            // Lazy Load Images
            lazyLoader.observe(section);

            // Register SINGLE section for entire row (header + grid)
            // This prevents section-change scroll logic from causing inconsistencies
            const rowId = `row-${rowIndex}`;
            // Simplify selector for Upcoming which has no headers
            const selector = this.state.viewType === 'Upcoming' ? '.media-card' : '.header-focusable, .media-card';
            // Use horizontal orientation for Upcoming/Suggestions, grid for Genres
            const orientation = isHorizontalRow ? 'horizontal' : 'grid';

            // Custom onMove handler for grid rows to ensure UP navigates to header, and VirtualCardRow delegates Left/Right
            const onMoveHandler = (direction, currentElement) => {
                if (isHorizontalRow && virtualRow) {
                    const nextNode = virtualRow.handleMove(direction);
                    if (nextNode) {
                        focusManager.focusElement(nextNode);
                        return true;
                    }
                    // For Up/Down we fallback to FocusManager defaults to allow leaveUp/leaveDown to trigger
                    if (direction === 'left' || direction === 'right') return false;
                } else if (!isHorizontalRow) {
                    if (direction === 'up' && currentElement?.classList.contains('media-card')) {
                        // Check if there's ANY card above this one (spatially)
                        const currentRect = currentElement.getBoundingClientRect();
                        const cards = Array.from(section.querySelectorAll('.media-card'));
                        const hasCardAbove = cards.some((card) => {
                            if (card === currentElement) return false;
                            const cardRect = card.getBoundingClientRect();
                            // Card is above if its center Y is at least 10px higher
                            return cardRect.top + cardRect.height / 2 < currentRect.top + currentRect.height / 2 - 10;
                        });

                        // If no card above, navigate to header
                        if (!hasCardAbove) {
                            const headerBtn = section.querySelector('.header-focusable');
                            if (headerBtn) {
                                focusManager.focusElement(headerBtn);
                                return true; // Handled
                            }
                        }
                    }
                }
                return false; // Let default handling proceed
            };

            focusManager.register(rowId, section, {
                orientation: orientation,
                columns: 6, // Only used for grid orientation
                // Navigation between rows
                leaveUp: rowIndex === 0 ? nextUpTarget : `row-${rowIndex - 1}`,
                leaveDown: rowIndex < rows.length - 1 ? `row-${rowIndex + 1}` : null,
                leaveLeft: 'sidebar',
                // Select both header button and media cards as focusable
                selector: selector,
                scrollOffsetTop: 50, // Ultra-tight top alignment
                enterTo: null, // Allow spatial entry (don't force header)
                onMove: onMoveHandler,
                onEnter:
                    isHorizontalRow && virtualRow
                        ? (fromElement, options) => {
                              if (
                                  fromElement &&
                                  options &&
                                  (options.direction === 'up' || options.direction === 'down')
                              ) {
                                  virtualRow._updateWindow(virtualRow.currentIndex);
                                  return virtualRow.domNodes.get(virtualRow.currentIndex);
                              }
                              return null;
                          }
                        : null,
                onRestoreIndex:
                    isHorizontalRow && virtualRow
                        ? (index) => {
                              return virtualRow.focusByIndex(index);
                          }
                        : null
            });
        });

        // Update Alpha Picker
        if (rows.length > 0) {
            focusManager.register('alpha-picker', this.$('#alpha-picker'), {
                orientation: 'horizontal',
                leaveUp: 'library-controls',
                leaveDown: 'row-0',
                leaveLeft: 'sidebar',
                enterTo: 'active-element'
            });

            // Update library-controls to point to first row
            focusManager.register('library-controls', this.$('#library-controls'), {
                orientation: 'horizontal',
                leaveUp: 'library-tabs',
                leaveDown: 'row-0', // Direct to first row for Genres view
                leaveLeft: 'sidebar',
                selector: 'button'
            });

            // Update library-tabs to point to first row directly when controls hidden
            focusManager.register('library-tabs', this.$('#library-tabs'), {
                orientation: 'horizontal',
                leaveUp: null,
                leaveDown: 'row-0', // Direct to first row
                leaveLeft: 'sidebar',
                enterTo: 'active-element',
                selector: '.tab-btn'
            });
        }

        // Finalize Lazy Loading
        lazyLoader.observe(container);

        // CRITICAL: Use requestAnimationFrame to ensure DOM is painted before focus cache is built
        // This fixes issues where offsetParent is null because the browser hasn't painted yet
        requestAnimationFrame(() => {
            rows.forEach((_, rowIndex) => {
                focusManager.invalidateCache(`row-${rowIndex}`);
            });
        });
    }

    async _fetchGenreItems(genreId, listId) {
        const listContainer = this.$(`#${listId}`);
        if (!listContainer) return;

        try {
            // Determine item types based on library collection type
            const collectionType = this.state.libraryInfo?.CollectionType;
            let includeItemTypes = 'Movie,Series'; // Default

            if (collectionType === 'tvshows') {
                includeItemTypes = 'Series'; // Only show series, not seasons or episodes
            } else if (collectionType === 'movies') {
                includeItemTypes = 'Movie'; // Only movies
            }

            const result = await api.getItems({
                ParentId: this.state.libraryId,
                GenreIds: genreId,
                Limit: 10,
                Fields: 'PrimaryImageAspectRatio,ProductionYear',
                IncludeItemTypes: includeItemTypes,
                Recursive: true,
                SortBy: 'Random' // Randomize to make it look interesting?
            });

            const items = result.Items || [];

            if (items.length === 0) {
                log.info(`Row "${listId}" is empty, hiding row...`);

                // HIDE the entire row completely
                const rowSection = listContainer.closest('.media-row');
                if (rowSection) {
                    rowSection.style.display = 'none';
                }

                // Clear the list container (removes skeleton loaders)
                listContainer.innerHTML = '';

                // Note: We no longer need to manually patch navigation!
                // FocusManager._leaveSection now auto-skips sections with no focusables
                // Note: We no longer need to manually patch navigation!
                // FocusManager._leaveSection now auto-skips sections with no focusables

                return;
            }

            const html = items
                .map((item) =>
                    CardRenderer.createCardHtml(item, {
                        isLandscape: false, // Genres usually mix, but mostly posters
                        type: 'poster'
                    })
                )
                .join('');

            listContainer.innerHTML = html;

            // Lazy Load Images for this new row
            lazyLoader.observe(listContainer);

            // Trigger fade-in animation by adding 'loaded' class
            // NOTE: Removed per-card staggered animation delays (index * 50ms)
            // which caused significant rendering lag on TV devices
            const rowSection = listContainer.closest('.media-row');
            if (rowSection) {
                rowSection.classList.add('loaded');
            }

            // Invalidate FocusManager cache so it re-queries the new elements
            focusManager.invalidateCache(listId);
        } catch (e) {
            log.error('Failed to load genre items', e);
            // Hide row on error too
            const rowSection = listContainer?.closest('.media-row');
            if (rowSection) {
                rowSection.style.display = 'none';
            }
        }
    }

    // ========================================================================
    // Interaction Handlers
    // ========================================================================

    async _handleTabClick(e) {
        const btn = e.target.closest('.tab-btn');
        if (!btn) return;

        const newType = btn.dataset.type;
        if (newType === this.state.viewType) return;

        this.state.viewType = newType;
        this.state.startIndex = 0; // Reset pagination
        this.state.nameStartsWith = null; // Reset Alpha Picker

        // Update UI Tabs
        this.$('.tab-btn.active')?.classList.remove('active');
        btn.classList.add('active');

        // Render Alpha Picker state (show/hide)
        this._renderAlphaPicker();
        // Bridge focus chain immediately (before loading) to prevent lost focus
        this._updateHeaderVisibility();

        // Reload Items
        await this._loadItems();
    }

    async _handleAlphaClick(e) {
        const btn = e.target.closest('.alpha-btn');
        if (!btn) return;

        const char = btn.dataset.char;

        if (this.state.nameStartsWith === char) {
            // Toggle off? Maybe not standard behavior, but useful
            this.state.nameStartsWith = null;
        } else {
            this.state.nameStartsWith = char === '#' ? '0-9' : char; // API usually expects 0-9 or specific chars
        }

        this.state.startIndex = 0;

        // Update UI
        this._renderAlphaPicker();

        // Restore focus to the selected char
        // We need to wait for render, then find the button for 'char'
        const newBtn = this.$(`.alpha-btn[data-char="${char}"]`);
        if (newBtn) {
            // Use FocusManager to properly set active element
            focusManager.focusElement(newBtn);
        }

        await this._loadItems();

        // Scroll to top of content (important when changing filters)
        const scrollContainer = this.$('#library-scroll-container');
        if (scrollContainer) scrollContainer.scrollTop = 0;
    }

    _handleGridClick(e) {
        const card = e.target.closest('.media-card');
        if (!card) return;

        const itemId = card.dataset.itemId;
        if (!itemId) return;

        // Special handling for Networks view: navigate to studio-filtered library
        if (this.state.viewType === 'Networks') {
            log.debug('Navigating to Studio:', itemId);
            // Navigate to library filtered by this studio
            router.navigate(`/library/${this.state.libraryId}/studio/${itemId}`);
            return;
        }

        // Default: navigate to details page
        router.navigate(`/details/${itemId}`);
    }

    async _handlePageChange(direction) {
        const newIndex = this.state.startIndex + direction * this.state.limit;

        // Bounds check
        if (newIndex < 0 || newIndex >= this.state.totalRecordCount) return;

        this.state.startIndex = newIndex;

        await this._loadItems();

        // Scroll to top of grid
        const scrollContainer = this.$('#library-scroll-container');
        if (scrollContainer) scrollContainer.scrollTop = 0;

        // Force focus to first item in grid
        const grid = this.$('#library-grid');
        const firstItem = grid ? grid.querySelector('.media-card') : null;
        if (firstItem) {
            focusManager.focusElement(firstItem);
        } else {
            // Fallback if empty, maybe focus controls?
            this.setActiveSection('library-controls');
        }
    }

    // ========================================================================
    // Advanced Controls (Sort/Filter/Shuffle)
    // ========================================================================

    async _handleShuffle() {
        // "Open a random movie/show"
        try {
            // Determine item types based on library type
            const collectionType = this.state.libraryInfo?.CollectionType;
            let includeItemTypes = 'Movie,Episode'; // Default fallback

            if (collectionType === 'tvshows') {
                includeItemTypes = 'Series'; // "Only Shows" -> Random Series
            } else if (collectionType === 'movies') {
                includeItemTypes = 'Movie';
            }

            const params = {
                ParentId: this.state.libraryId,
                SortBy: 'Random',
                Limit: 1,
                Recursive: true,
                IncludeItemTypes: includeItemTypes,
                ExcludeLocationTypes: 'Virtual' // Filter out missing files
            };

            // Respect current filters if any? Usually shuffle ignores view filters for global "Shuffle"
            // But maybe we should respect "Unplayed"? Let's keep it simple first.

            const result = await api.getItems(params);

            if (result.Items && result.Items.length > 0) {
                const randomItem = result.Items[0];
                router.navigate(`/details/${randomItem.Id}`);
            } else {
                log.warn('No items found');
            }
        } catch (e) {
            log.error('Failed to fetch random item', e);
        }
    }

    _updateControlsVisibility() {
        // Shuffle button is available except for Episodes view
        const btnShuffle = this.$('#btn-shuffle');
        if (btnShuffle) {
            btnShuffle.style.display = this.state.viewType === 'Episodes' ? 'none' : '';
        }

        // Quick Reset button visibility based on filters
        const btnReset = this.$('#btn-quick-reset');
        if (btnReset) {
            const hasFilters = this.state.filters && Object.keys(this.state.filters).length > 0;
            btnReset.style.display = hasFilters ? '' : 'none';
        }

        // Invalidate FocusManager cache so it re-queries the visible elements in the section
        focusManager.invalidateCache('library-controls');
    }

    _handleResetFilters() {
        log.info('Resetting all filters...');
        this.state.filters = {};
        this.state.nameStartsWith = null;
        this.state.startIndex = 0;

        // Update UI components that reflect these states
        this._renderAlphaPicker();
        this._updateControlsVisibility();

        // Reload items
        this._loadItems();
    }

    _handleSort() {
        // Define Order Options (Common)
        const orderOptions = [
            { label: 'Ascending', value: 'Ascending' },
            { label: 'Descending', value: 'Descending' }
        ];

        let sortOptions = [];
        const isTv = this.state.libraryInfo?.CollectionType === 'tvshows';

        if (isTv) {
            // TV Show Specific Options
            sortOptions = [
                { label: 'Name', value: 'SortName' },
                { label: 'Random', value: 'Random' },
                { label: 'Community Rating', value: 'CommunityRating,SortName' },
                { label: 'Date Show Added', value: 'DateCreated,SortName' },
                { label: 'Date Episode Added', value: 'DateLastContentAdded,SortName' },
                { label: 'Date Played', value: 'SeriesDatePlayed,SortName' },
                { label: 'Parental Rating', value: 'OfficialRating,SortName' },
                { label: 'Release Date', value: 'PremiereDate,SortName' }
            ];
        } else {
            // Standard / Movie Options
            sortOptions = [
                { label: 'Name', value: 'SortName' },
                { label: 'Random', value: 'Random' },
                { label: 'Community Rating', value: 'CommunityRating,SortName' },
                { label: 'Critics Rating', value: 'CriticRating,SortName' },
                { label: 'Date Added', value: 'DateCreated,SortName' },
                { label: 'Date Played', value: 'DatePlayed,SortName' },
                { label: 'Parental Rating', value: 'OfficialRating,SortName' },
                { label: 'Play Count', value: 'PlayCount,SortName' },
                { label: 'Release Date', value: 'ProductionYear,PremiereDate,SortName' },
                { label: 'Runtime', value: 'Runtime,SortName' }
            ];
        }

        this._renderSortModal(sortOptions, orderOptions);
    }

    _renderSortModal(sortOptions, orderOptions) {
        const overlay = this.$('#modal-overlay');
        if (!overlay) return;

        // Store focus context
        this._prevFocus = focusManager.getFocused();
        this._prevSection = focusManager.getActiveSection();

        // Current state
        const currentSort = this.state.sortBy;
        const currentOrder = this.state.sortOrder;

        overlay.innerHTML = `
            <div class="library-modal sort-modal">
                <div class="sort-columns">
                    <!-- Sort By Column -->
                    <div class="sort-column" id="sort-by-col">
                        <h2 class="modal-title">Sort By</h2>
                        <div class="modal-options">
                            ${sortOptions
                                .map(
                                    (opt) => `
                                <button class="modal-option-btn radio-btn ${opt.value === currentSort ? 'selected' : ''}" 
                                        data-type="sort" 
                                        data-value="${opt.value}"
                                        tabindex="0">
                                    <div class="radio-icon"></div>
                                    <span>${opt.label}</span>
                                </button>
                            `
                                )
                                .join('')}
                        </div>
                    </div>

                    <!-- Sort Order Column -->
                    <div class="sort-column" id="sort-order-col">
                        <h2 class="modal-title">Order</h2>
                        <div class="modal-options">
                            ${orderOptions
                                .map(
                                    (opt) => `
                                <button class="modal-option-btn radio-btn ${opt.value === currentOrder ? 'selected' : ''}" 
                                        data-type="order" 
                                        data-value="${opt.value}"
                                        tabindex="0">
                                    <div class="radio-icon"></div>
                                    <span>${opt.label}</span>
                                </button>
                            `
                                )
                                .join('')}
                        </div>
                    </div>
                </div>

                <div class="modal-actions">
                    <button class="modal-action-btn close" id="btn-sort-close">Close</button>
                    <button class="modal-action-btn apply" id="btn-sort-apply">Apply</button>
                </div>
            </div>
        `;

        overlay.classList.remove('hidden'); // Ensure it's not display:none
        overlay.classList.add('visible');
        overlay.setAttribute('aria-hidden', 'false');

        // Trap focus
        this._prevFocus = focusManager.getFocused();
        this._prevSection = focusManager.getActiveSection();

        // Local temporary state for the modal
        let tempSortBy = currentSort;
        let tempSortOrder = currentOrder;

        // Event Handling
        const handleSelection = (type, value) => {
            if (type === 'sort') {
                tempSortBy = value;
            } else if (type === 'order') {
                tempSortOrder = value;
            }

            // Update UI classes manually to show selection
            const colId = type === 'sort' ? '#sort-by-col' : '#sort-order-col';
            const col = overlay.querySelector(colId);
            col.querySelectorAll('.modal-option-btn').forEach((btn) => {
                if (btn.dataset.value === value) btn.classList.add('selected');
                else btn.classList.remove('selected');
            });
        };

        // Bind Clicks
        overlay.querySelectorAll('.modal-option-btn').forEach((btn) => {
            btn.addEventListener('click', () => handleSelection(btn.dataset.type, btn.dataset.value));
        });

        this.$('#btn-sort-apply')?.addEventListener('click', async () => {
            // Commit the temporary state to the page state
            this.state.sortBy = tempSortBy;
            this.state.sortOrder = tempSortOrder;
            this.state.startIndex = 0;

            // Explicitly trigger reload
            await this._loadItems();

            this._closeModal();
        });

        this.$('#btn-sort-close')?.addEventListener('click', () => {
            this._closeModal();
        });

        // Register Sections
        focusManager.register('sort-by-col', overlay.querySelector('#sort-by-col'), {
            orientation: 'vertical',
            leaveUp: 'sort-actions',
            leaveLeft: 'sort-actions',
            leaveRight: 'sort-order-col',
            leaveDown: 'sort-actions'
        });

        focusManager.register('sort-order-col', overlay.querySelector('#sort-order-col'), {
            orientation: 'vertical',
            leaveUp: 'sort-actions',
            leaveLeft: 'sort-by-col',
            leaveRight: 'sort-actions',
            leaveDown: 'sort-actions'
        });

        focusManager.register('sort-actions', overlay.querySelector('.modal-actions'), {
            orientation: 'horizontal',
            onMove: (direction) => {
                if (direction === 'up') {
                    // Return to the previous section using MEMORY (not spatial)
                    const prev = focusManager.getPreviousSection();
                    if (prev && ['sort-by-col', 'sort-order-col'].includes(prev)) {
                        focusManager.setActiveSection(prev, true); // No fromElement = use memory
                        return true;
                    }
                } else if (direction === 'down') {
                    // Wrap to the top of the sort-by column
                    focusManager.setActiveSection('sort-by-col', true, null, { enterTo: 'first' });
                    return true;
                }
                return false;
            }
        });

        // Set initial focus
        setTimeout(() => {
            const selected =
                overlay.querySelector('#sort-by-col .selected') ||
                overlay.querySelector('#sort-by-col .modal-option-btn');
            if (selected) focusManager.focusElement(selected);
        }, 50);
    }

    async _handleFilter() {
        // 1. Fetch Dynamic Filters
        // We need ParentId and IncludeItemTypes from current params/state
        // Fix: Use libraryInfo or derive types.
        let includeItemTypes = 'Movie,Series,Episode'; // Default broad

        if (this.state.libraryInfo) {
            const type = this.state.libraryInfo.CollectionType;
            if (type === 'movies') includeItemTypes = 'Movie';
            else if (type === 'tvshows') includeItemTypes = 'Series,Episode';
            else if (type === 'music') includeItemTypes = 'MusicArtist,MusicAlbum,Audio';
        }

        const params = {
            ParentId: this.state.parentId,
            IncludeItemTypes: includeItemTypes,
            Recursive: true
        };

        // If we are in a specific view, we might need to adjust params
        // For now, let's just pass what we have.
        let filtersData = null;
        try {
            filtersData = await api.getItemFilters(params);
        } catch (e) {
            log.error('Failed to fetch filters', e);
            // We can still show static filters
            filtersData = { Genres: [], OfficialRatings: [], Tags: [], Years: [] };
        }

        this._renderFilterModal(filtersData);
    }

    _renderFilterModal(data) {
        const overlay = this.$('#modal-overlay');
        if (!overlay) return;

        // Store focus context
        this._prevFocus = focusManager.getFocused();
        this._prevSection = focusManager.getActiveSection();

        // Sections Definition
        const sections = [
            {
                title: 'Filters',
                id: 'sec-filters',
                items: [
                    { label: 'Played', key: 'IsPlayed', type: 'boolean' },
                    { label: 'Unplayed', key: 'IsUnplayed', type: 'boolean' },
                    { label: 'Resumable', key: 'IsResumable', type: 'boolean' },
                    { label: 'Favorites', key: 'IsFavorite', type: 'boolean' }
                ]
            },
            {
                title: 'Features',
                id: 'sec-features',
                items: [
                    { label: 'Subtitles', key: 'HasSubtitles', type: 'boolean' },
                    { label: 'Trailer', key: 'HasTrailer', type: 'boolean' },
                    { label: 'Special Features', key: 'HasSpecialFeature', type: 'boolean' },
                    { label: 'Theme Song', key: 'HasThemeSong', type: 'boolean' },
                    { label: 'Theme Video', key: 'HasThemeVideo', type: 'boolean' }
                ]
            },
            {
                title: 'Genres',
                id: 'sec-genres',
                itemKey: 'Genres', // Key in state
                items: data.Genres.map((g) => ({ label: g, value: g, type: 'multi' }))
            },
            {
                title: 'Parental Ratings',
                id: 'sec-ratings',
                itemKey: 'OfficialRatings',
                items: data.OfficialRatings.map((r) => ({ label: r, value: r, type: 'multi' }))
            },
            {
                title: 'Tags',
                id: 'sec-tags',
                itemKey: 'Tags',
                items: data.Tags.map((t) => ({ label: t, value: t, type: 'multi' }))
            },
            {
                title: 'Video Types',
                id: 'sec-videotypes',
                itemKey: 'VideoTypes', // Comma list
                items: [
                    { label: 'Bluray', value: 'Bluray', type: 'multi' },
                    { label: 'DVD', value: 'Dvd', type: 'multi' },
                    { label: '4K', key: 'Is4K', type: 'boolean' }, // Is4K is a separate bool usually
                    { label: 'HD', key: 'IsHD', type: 'boolean' },
                    { label: 'SD', key: 'IsSD', type: 'boolean' }, // Logic: IsHD=false usually
                    { label: '3D', key: 'Is3D', type: 'boolean' }
                ]
            },
            {
                title: 'Years',
                id: 'sec-years',
                itemKey: 'Years',
                items: data.Years.map((y) => ({ label: y.toString(), value: y.toString(), type: 'multi' }))
            }
        ];

        // Filter out empty sections
        const validSections = sections.filter((s) => s.items.length > 0);

        // Active Category State (Default to first)
        let activeSectionId = this.state.activeFilterSection || validSections[0].id;
        // Ensure active section is valid
        if (!validSections.find((s) => s.id === activeSectionId)) {
            activeSectionId = validSections[0].id;
        }

        // Render HTML Structure
        const html = `
            <div class="library-modal filter-modal split-view">
                <h2 class="modal-title">Filters</h2>
                <div class="filter-split-container">
                    <!-- Left Sidebar -->
                    <div class="filter-sidebar" id="filter-sidebar">
                        ${validSections
                            .map(
                                (s) => `
                            <button class="filter-category-btn ${s.id === activeSectionId ? 'active' : ''}" 
                                    data-id="${s.id}" tabindex="0">
                                ${s.title}
                            </button>
                        `
                            )
                            .join('')}
                    </div>

                    <!-- Right Main Content -->
                    <div class="filter-main" id="filter-main">
                        <!-- Items rendered dynamically -->
                    </div>
                </div>

                <div class="modal-actions">
                    <button class="modal-action-btn clear" id="btn-filter-clear">Clear</button>
                    <button class="modal-action-btn close" id="btn-filter-close">Close</button>
                    <button class="modal-action-btn apply" id="btn-filter-apply">Apply</button>
                </div>
            </div>
        `;

        overlay.innerHTML = html;
        overlay.classList.remove('hidden');
        overlay.classList.add('visible');
        overlay.setAttribute('aria-hidden', 'false');

        // Local observer for lazy loading filter items
        let filterObserver = null;
        const BATCH_SIZE = 50;

        // Logic to Render Items for Active Section
        const renderItems = (sectionId, options = {}) => {
            const section = validSections.find((s) => s.id === sectionId);
            const container = overlay.querySelector('#filter-main');
            if (!section || !container) return;

            // Highlight active category in sidebar
            overlay.querySelectorAll('.filter-category-btn').forEach((btn) => {
                if (btn.dataset.id === sectionId) btn.classList.add('active');
                else btn.classList.remove('active');
            });

            this.state.activeFilterSection = sectionId;

            // --- Lazy Loading Setup ---
            // Disconnect previous observer
            if (filterObserver) {
                filterObserver.disconnect();
                filterObserver = null;
            }

            // Determine initial batch size
            // If we need to restore focus to a deep item, load enough to reach it
            let initialCount = BATCH_SIZE;
            if (options.restoreFocus) {
                const { key, value } = options.restoreFocus;
                // Find index of target item
                const targetIndex = section.items.findIndex((item) => {
                    const itemKey = item.key || section.itemKey;
                    const itemValue = item.value || '';
                    return itemKey === key && itemValue === value;
                });

                if (targetIndex !== -1) {
                    // Load up to target + buffer
                    initialCount = Math.max(BATCH_SIZE, targetIndex + 20);
                }
            }

            const totalItems = section.items.length;
            let loadedCount = 0;

            // Helper to render a chunk of items
            const appendItems = (startIndex, count) => {
                const chunk = section.items.slice(startIndex, startIndex + count);
                const html = chunk
                    .map((item) => {
                        // Determine checked state
                        let checked = false;
                        if (item.type === 'boolean') {
                            checked = !!this.state.filters[item.key];
                            if (item.key === 'IsSD') checked = this.state.filters['IsHD'] === false;
                        } else {
                            const stored = this.state.filters[section.itemKey];
                            if (stored) {
                                const arr = stored.split(',');
                                checked = arr.includes(item.value);
                            }
                        }

                        return `
                        <button class="modal-option-btn check-btn ${checked ? 'selected' : ''}"
                                data-type="${item.type}"
                                data-key="${item.key || section.itemKey}"
                                data-value="${item.value || ''}"
                                tabindex="0">
                            <div class="checkbox-box">
                                <span class="check-mark">✔</span>
                            </div>
                            <span class="btn-label">${item.label}</span>
                        </button>
                    `;
                    })
                    .join('');

                // If starting from 0, replace content, otherwise append
                if (startIndex === 0) {
                    container.innerHTML = html;
                } else {
                    // Remove old sentinel if exists
                    const oldSentinel = container.querySelector('.filter-sentinel');
                    if (oldSentinel) oldSentinel.remove();

                    container.insertAdjacentHTML('beforeend', html);
                }

                loadedCount += chunk.length;

                // Add Sentinel if more items exist
                if (loadedCount < totalItems) {
                    const sentinelHtml = `<div class="filter-sentinel" style="height: 20px; width: 100%;"></div>`;
                    container.insertAdjacentHTML('beforeend', sentinelHtml);

                    const sentinel = container.querySelector('.filter-sentinel');
                    if (sentinel && filterObserver) {
                        filterObserver.observe(sentinel);
                    }
                }

                // Update FocusManager registry and cache
                // Note: Invalidate cache is crucial as DOM size changes
                focusManager.register('filter-items', container, {
                    orientation: 'grid',
                    leaveLeft: 'filter-sidebar',
                    leaveRight: 'filter-actions', // Note: Spatial logic will handle this mostly
                    leaveDown: 'filter-actions',
                    selector: '.modal-option-btn'
                });
                focusManager.invalidateCache('filter-items');
            };

            // Start Observer
            if ('IntersectionObserver' in window) {
                filterObserver = new IntersectionObserver(
                    (entries) => {
                        entries.forEach((entry) => {
                            if (entry.isIntersecting) {
                                // Load next batch
                                appendItems(loadedCount, BATCH_SIZE);
                            }
                        });
                    },
                    { root: container, rootMargin: '200px' }
                );
            }

            // Render Initial Batch
            appendItems(0, initialCount);

            // Register filter-items section (Dynamic)
            focusManager.register('filter-items', container, {
                orientation: 'grid', // Switch to grid for side-by-side items
                leaveLeft: 'filter-sidebar',
                leaveUp: 'filter-actions',
                leaveDown: 'filter-actions',
                selector: '.modal-option-btn'
            });

            // --- Focus Restoration ---
            if (options.restoreFocus) {
                const { key, value } = options.restoreFocus;

                // Allow DOM to settle
                setTimeout(() => {
                    const selector = `.modal-option-btn[data-key="${key}"][data-value="${value || ''}"]`;
                    const nextBtn = container.querySelector(selector);
                    if (nextBtn) {
                        focusManager.focusElement(nextBtn, { scroll: true }); // Ensure we scroll to it
                    }
                }, 0);
            }
        };

        // item toggle logic
        const handleItemToggle = (btn) => {
            const key = btn.dataset.key;
            const val = btn.dataset.value;
            const type = btn.dataset.type;
            const isSelected = btn.classList.contains('selected');

            if (isSelected) btn.classList.remove('selected');
            else btn.classList.add('selected');

            // State Updates (Same as before)
            if (type === 'boolean') {
                if (key === 'IsSD') {
                    if (!isSelected) this.state.filters['IsHD'] = false;
                    else delete this.state.filters['IsHD'];
                } else {
                    if (!isSelected) this.state.filters[key] = true;
                    else delete this.state.filters[key];
                    if (key === 'IsPlayed' && !isSelected) delete this.state.filters['IsUnplayed'];
                    if (key === 'IsUnplayed' && !isSelected) delete this.state.filters['IsPlayed'];
                }
            } else {
                let current = this.state.filters[key] ? this.state.filters[key].split(',') : [];
                if (!isSelected) current.push(val);
                else current = current.filter((v) => v !== val);

                if (current.length > 0) this.state.filters[key] = current.join(',');
                else delete this.state.filters[key];
            }

            // Refresh checks if needed (mutually exclusive)
            if (key === 'IsPlayed' || key === 'IsUnplayed') {
                renderItems(this.state.activeFilterSection, {
                    restoreFocus: { key, value: val }
                });
            }
        };

        // Verify initial render
        renderItems(activeSectionId);

        // Events: Sidebar Focus/Click
        overlay.querySelectorAll('.filter-category-btn').forEach((btn) => {
            const selectCategory = () => {
                const id = btn.dataset.id;
                if (this.state.activeFilterSection !== id) {
                    renderItems(id);
                }
            };
            btn.addEventListener('focus', selectCategory);
            btn.addEventListener('click', selectCategory); // Click also selects
        });

        // Events: Main Content Delegation
        overlay.querySelector('#filter-main').addEventListener('click', (e) => {
            const btn = e.target.closest('.modal-option-btn');
            if (btn) handleItemToggle(btn);
        });

        // Actions
        this.$('#btn-filter-clear').addEventListener('click', () => {
            this.state.filters = {};
            renderItems(this.state.activeFilterSection);
        });

        this.$('#btn-filter-apply').addEventListener('click', async () => {
            this.state.startIndex = 0;
            await this._loadItems();
            this._closeFilterModal();

            // Restore Focus safely
            const btn = this.$('#btn-filter');
            if (btn) focusManager.focusElement(btn);
        });

        this.$('#btn-filter-close').addEventListener('click', () => {
            this._closeFilterModal();
            const btn = this.$('#btn-filter');
            if (btn) focusManager.focusElement(btn);
        });

        // Focus Management Registration
        focusManager.register('filter-sidebar', overlay.querySelector('.filter-sidebar'), {
            orientation: 'vertical',
            leaveUp: 'filter-actions',
            leaveRight: 'filter-items',
            leaveLeft: 'filter-actions',
            leaveDown: 'filter-actions',
            selector: '.filter-category-btn'
        });

        focusManager.register('filter-actions', overlay.querySelector('.modal-actions'), {
            orientation: 'horizontal',
            onMove: (direction) => {
                if (direction === 'up') {
                    // Return to the previous section using MEMORY (not spatial)
                    const prev = focusManager.getPreviousSection();
                    if (prev && ['filter-sidebar', 'filter-items'].includes(prev)) {
                        focusManager.setActiveSection(prev, true); // No fromElement = use memory
                        return true;
                    }
                } else if (direction === 'down') {
                    // Wrap to the top category in the sidebar
                    focusManager.setActiveSection('filter-sidebar', true, null, { enterTo: 'first' });
                    return true;
                }
                return false;
            },
            leaveLeft: 'filter-sidebar', // Return to sidebar
            selector: '.modal-action-btn'
        });

        // Initial Focus
        focusManager.setActiveSection('filter-sidebar');
        const firstCat = overlay.querySelector('.filter-category-btn');
        if (firstCat) firstCat.focus();
    }

    _refreshFilterChecks(overlay) {
        // No longer used, we re-render or handle manually
    }

    _closeFilterModal() {
        const overlay = this.$('#modal-overlay');
        if (!overlay) return;

        focusManager.unregister('filter-sidebar');
        focusManager.unregister('filter-items');
        focusManager.unregister('filter-actions');
        focusManager.unregister('filter-modal'); // Cleanup old name just in case

        overlay.classList.remove('visible');
        overlay.setAttribute('aria-hidden', 'true');

        // Cleanup content after animation
        setTimeout(() => {
            overlay.classList.add('hidden');
            overlay.innerHTML = '';
        }, 300);

        // Restore focus
        if (this._prevFocus && document.body.contains(this._prevFocus)) {
            focusManager.focusElement(this._prevFocus);
        } else if (this._prevSection) {
            focusManager.setActiveSection(this._prevSection);
        }
        this._prevFocus = null;
        this._prevSection = null;
    }

    _renderModal(title, options, onSelect) {
        const overlay = this.$('#modal-overlay');
        if (!overlay) return;

        overlay.innerHTML = `
            <div class="library-modal">
                <div class="modal-header">
                    <h2>${title}</h2>
                </div>
                <div class="modal-options page-content" id="modal-options">
                    ${options
                        .map(
                            (opt) => `
                        <button class="modal-option-btn ${opt.selected ? 'selected' : ''}" 
                                data-value="${opt.value}" 
                                tabindex="0">
                            <span>${opt.label}</span>
                            <span class="check-icon">✓</span>
                        </button>
                    `
                        )
                        .join('')}
                </div>
                <button class="modal-close-btn" id="modal-close">Close</button>
            </div>
        `;

        overlay.classList.remove('hidden');
        overlay.classList.add('visible');
        overlay.setAttribute('aria-hidden', 'false');

        // Bind clicks
        const optionBtns = overlay.querySelectorAll('.modal-option-btn');
        optionBtns.forEach((btn) => {
            btn.addEventListener('click', () => onSelect(btn.dataset.value));
        });

        this.$('#modal-close').addEventListener('click', () => this._closeModal());

        // Trap Focus
        this._prevSection = focusManager.getActiveSection();
        this._prevFocus = focusManager.getFocused();

        // Single section for the whole modal handles navigation naturally
        // (options -> close button)
        focusManager.register('library-modal', this.$('.library-modal'), {
            orientation: 'vertical',
            enterTo: 'first'
        });

        // Force focus to first option
        setTimeout(() => {
            // "focusSection" didn't exist. Use setActiveSection with restoreFocus=true
            // OR find the first button manually for stricter control.
            const firstBtn = this.$('.modal-option-btn');
            if (firstBtn) {
                focusManager.focusElement(firstBtn);
            }
        }, 100);
    }

    _closeModal() {
        const overlay = this.$('#modal-overlay');
        if (!overlay || !overlay.classList.contains('visible')) return;

        // Unregister all specific modal sections
        focusManager.unregister('library-modal');
        focusManager.unregister('sort-by-col');
        focusManager.unregister('sort-order-col');
        focusManager.unregister('sort-actions'); // Updated name
        focusManager.unregister('modal-close-btn');

        overlay.classList.remove('visible');
        overlay.setAttribute('aria-hidden', 'true');

        // Cleanup content after animation
        setTimeout(() => {
            overlay.classList.add('hidden');
            overlay.innerHTML = '';
        }, 300);

        // Restore focus
        if (this._prevFocus && document.body.contains(this._prevFocus)) {
            focusManager.focusElement(this._prevFocus);
        } else if (this._prevSection) {
            focusManager.setActiveSection(this._prevSection);
        }
        this._prevFocus = null;
        this._prevSection = null;
    }

    /**
     * Update visibility of header elements (controls, alpha picker)
     * and patch the focus chain to bridge the gaps.
     */
    _updateHeaderVisibility() {
        const collectionType = this.state.libraryInfo?.CollectionType;
        const viewType = this.state.viewType;

        // Condition: only show for Movies (Items), TV Shows (Items), and Episodes
        const isMovieMain = collectionType === 'movies' && viewType === 'Items';
        const isTVMain = collectionType === 'tvshows' && viewType === 'Items';
        const isEpisodes = viewType === 'Episodes';
        const shouldShow = isMovieMain || isTVMain || isEpisodes;

        const controls = this.$('#library-controls');
        const alphaPicker = this.$('#alpha-picker-container');

        if (controls) controls.style.display = shouldShow ? 'flex' : 'none';
        if (alphaPicker) alphaPicker.style.display = shouldShow ? 'block' : 'none';

        // Bridge focus chain: library-tabs -> (controls -> alpha ->) content
        const tabsContainer = this.$('#library-tabs');

        // Special Case: BoxSets (Collections) have NO tabs, but HAVE controls
        // We need to bridge Sidebar -> Controls directly, and Controls -> Up (Sidebar?)
        if (collectionType === 'boxsets' && shouldShow) {
            // 1. Controls configuration
            const controlsConfig = focusManager.getSectionConfig('library-controls');
            if (controlsConfig) {
                focusManager.register('library-controls', this.$('#library-controls'), {
                    ...controlsConfig,
                    leaveUp: 'sidebar', // No tabs above, go back to sidebar
                    leaveDown: 'alpha-picker',
                    leaveLeft: 'sidebar'
                });
            }

            // 2. Alpha Picker configuration
            const alphaConfig = focusManager.getSectionConfig('alpha-picker');
            if (alphaConfig) {
                focusManager.register('alpha-picker', this.$('#alpha-picker'), {
                    ...alphaConfig,
                    leaveUp: 'library-controls',
                    leaveDown: 'library-grid',
                    leaveLeft: 'sidebar'
                });
            }

            // 3. Grid configuration
            const gridConfig = focusManager.getSectionConfig('library-grid');
            if (gridConfig) {
                focusManager.register('library-grid', this.$('#library-grid'), {
                    ...gridConfig,
                    leaveUp: 'alpha-picker',
                    leaveDown: gridConfig.leaveDown || 'library-pagination'
                });
            }
            // Skip standard tab logic
            return;
        }

        if (tabsContainer) {
            let nextTarget = 'library-controls';

            if (!shouldShow) {
                if (viewType === 'Genres' || viewType === 'Suggestions' || viewType === 'Upcoming') {
                    nextTarget = 'row-0'; // Match the horizontal row ID
                } else {
                    nextTarget = 'library-grid';
                }
            }

            const tabsConfig = focusManager.getSectionConfig('library-tabs');
            if (tabsConfig) {
                focusManager.register('library-tabs', tabsContainer, {
                    ...tabsConfig,
                    leaveDown: nextTarget
                });
            }
        }

        // Ensure intermediate sections point to the right place too
        if (shouldShow) {
            const controlsConfig = focusManager.getSectionConfig('library-controls');
            if (controlsConfig) {
                focusManager.register('library-controls', this.$('#library-controls'), {
                    ...controlsConfig,
                    leaveDown: 'alpha-picker'
                });
            }

            const alphaConfig = focusManager.getSectionConfig('alpha-picker');
            if (alphaConfig) {
                focusManager.register('alpha-picker', this.$('#alpha-picker'), {
                    ...alphaConfig,
                    leaveDown: 'library-grid'
                });
            }
        }

        // Update Grid leaveUp
        const gridConfig = focusManager.getSectionConfig('library-grid');
        if (gridConfig) {
            focusManager.register('library-grid', this.$('#library-grid'), {
                ...gridConfig,
                leaveUp: shouldShow ? 'alpha-picker' : 'library-tabs',
                leaveDown: gridConfig.leaveDown || 'library-pagination'
            });
        }
    }
}

export default LibraryPage;
