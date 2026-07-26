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
import { imageService } from '../utils/ImageService.js';
import { VirtualCardRow } from '../components/VirtualCardRow.js';
import { lazyLoader } from '../utils/LazyLoader.js';
import { logger } from '../utils/Logger.js';
import { i18n } from '../utils/i18n.js';
import { state } from '../core/StateManager.js';
import { storage } from '../utils/StorageService.js';
import { eventBus } from '../core/EventBus.js';

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
            filters: {}, // E.g. { IsUnplayed: true, Genres: 'Action,Comedy' }
            nameStartsWith: null, // For Alpha Picker

            // Pagination
            startIndex: 0,
            limit: parseInt(storage.getItem('pref:libraryPageSize') || 100, 10),
            totalRecordCount: 0,

            // Data Cache
            items: [],

            /*
             * ---------------------------------------------------------------
             * VIRTUAL GRID WINDOW STATE
             * ---------------------------------------------------------------
             * Instead of rendering all N items at once, we maintain a sliding
             * "window" of DOM nodes. Only items[gridWindowStart..gridWindowEnd-1]
             * exist in the DOM at any time. A spacer <div> at the top of the
             * grid holds the height of the removed top rows so scroll position
             * is not disturbed when items are evicted.
             *
             *   gridWindowStart  — first item index currently in DOM
             *   gridWindowEnd    — one past the last item index currently in DOM
             *   gridCardRowHeight — measured height of one card row (px), cached
             * ---------------------------------------------------------------
             */
            gridWindowStart: 0,
            gridWindowEnd: 0,
            gridCardRowHeight: null,

            alphaPickerChars: '#ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''),

            /*
             * View Mode: controls how the main grid renders cards.
             * Persisted per-library via StorageService key:
             *   pref:library:viewMode:<libraryId>
             *
             * Valid values:
             *   'poster'       — 2:3 portrait card (default for most libraries)
             *   'small-poster' — tighter portrait card (~150px wide, ~10 per row)
             *   'thumb'        — 16:9 landscape card (~330px, ~5 per row)
             *   'banner'       — full-width horizontal strip with small thumbnail
             *   'list'         — full-width row with thumb + title + meta on right
             *
             * Music libraries default to 'square' (album-cover style), which maps to
             * CardRenderer type 'square' rather than adding a 6th viewMode constant.
             */
            viewMode: 'poster',
            gridMode: 'dynamic',
            gridColumns: 5
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
                            <h1 class="library-title" id="library-title">${i18n.t('Library')}</h1>
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
                                    <span class="control-btn-text" data-i18n="Shuffle">Shuffle</span>
                                </button>
                                <button class="control-btn" id="btn-sort" tabindex="0">
                                    <span class="icon">
                                        <svg viewBox="0 0 24 24" fill="none" class="control-svg">
                                            <path d="M3 6H21" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                                            <path d="M7 12H17" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                                            <path d="M11 18H13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                                        </svg>
                                    </span> 
                                    <span class="control-btn-text" data-i18n="Sort">Sort</span>
                                </button>
                                <button class="control-btn" id="btn-filter" tabindex="0">
                                    <span class="icon">
                                        <svg viewBox="0 0 24 24" fill="none" class="control-svg">
                                            <path d="M21 4H3L10 12.42V19L14 21V12.42L21 4Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                        </svg>
                                    </span> 
                                    <span class="control-btn-text" data-i18n="Filter">Filter</span>
                                </button>
                                <!-- View Mode Toggle -->
                                <button class="control-btn btn-view-mode" id="btn-view-mode" tabindex="0">
                                    <span class="icon">
                                        <svg viewBox="0 0 24 24" fill="none" class="control-svg">
                                            <rect x="3" y="3" width="7" height="7" rx="1" stroke="currentColor" stroke-width="2"/>
                                            <rect x="14" y="3" width="7" height="7" rx="1" stroke="currentColor" stroke-width="2"/>
                                            <rect x="3" y="14" width="7" height="7" rx="1" stroke="currentColor" stroke-width="2"/>
                                            <rect x="14" y="14" width="7" height="7" rx="1" stroke="currentColor" stroke-width="2"/>
                                        </svg>
                                    </span>
                                    <span class="control-btn-text" data-i18n="ViewMode">View</span>
                                </button>
                                <button class="control-btn" id="btn-quick-reset" tabindex="0" style="display: none;">
                                    <span class="icon">
                                        <svg viewBox="0 0 24 24" fill="none" class="control-svg">
                                            <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                        </svg>
                                    </span> 
                                    <span class="control-btn-text" data-i18n="Reset">Reset</span>
                                </button>
                                <button class="control-btn" id="btn-prev-top" tabindex="0">
                                    <span class="icon">
                                        <svg viewBox="0 0 24 24" fill="none" class="control-svg">
                                            <path d="M15 18L9 12L15 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                        </svg>
                                    </span>
                                    <span class="control-btn-text" data-i18n="Previous">Prev</span>
                                </button>
                                <button class="control-btn" id="btn-next-top" tabindex="0">
                                    <span class="control-btn-text" data-i18n="Next">Next</span>
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
                                <h2 class="empty-state-title" data-i18n="NoItemsFound">${i18n.t('NoItemsFound')}</h2>
                                <p class="empty-state-text" data-i18n="NoItemsFoundDescription">${i18n.t('NoItemsFoundDescription')}</p>
                                <button class="empty-state-btn focusable" id="btn-reset-filters" tabindex="0" data-i18n="ClearAllFilters">
                                    ${i18n.t('ClearAllFilters')}
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
                            <span class="control-btn-text" data-i18n="Previous">Previous</span>
                        </button>
                        <span class="pagination-info" id="pagination-info">Page 1</span>
                        <button class="pagination-btn" id="btn-next" tabindex="0">
                            <span class="control-btn-text" data-i18n="Next">Next</span>
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

    /*
     * =========================================================================
     * GRID COLUMNS DEFAULT CONFIGURATION
     * =========================================================================
     * Retrieves the default static column counts based on the active view mode
     * for standard TV displays.
     * =========================================================================
     */
    _getDefaultColumnsForMode(mode) {
        switch (mode) {
            case 'small-poster':
                return 9;
            case 'thumb':
                return 4;
            case 'banner':
                return 3;
            case 'list':
                return 1;
            case 'poster':
            default:
                return 5;
        }
    }

    // ========================================================================
    // Lifecycle
    // ========================================================================

    async onInit() {
        this.setLoading(true);
        this.state.libraryId = this.params.id;

        // Special handling for 'virtual' library IDs (e.g. 'all' for search expansion)
        const isVirtualLibrary = this.state.libraryId === 'all';

        if (!isVirtualLibrary) {
            await this._fetchLibraryInfo();
        } else {
            // Setup default state for virtual library
            let virtualTitle = i18n.t('SearchResults');

            if (this.params.personName) {
                virtualTitle = decodeURIComponent(this.params.personName);
            } else if (this.params.searchTerm) {
                virtualTitle = `${i18n.t('Search')}: ${decodeURIComponent(this.params.searchTerm)}`;
            } else if (this.params.IsFavorite === 'true') {
                // =============================================================
                // TRANSLATABLE TYPE-SPECIFIC FAVORITE HEADERS
                // =============================================================
                // Maps the includeItemTypes query filter parameters to localized
                // singular or plural display values (e.g. Movies, TV Shows, etc.).
                // =============================================================
                let typeLabel = '';
                if (this.params.includeItemTypes) {
                    if (this.params.includeItemTypes.includes('Movie')) {
                        typeLabel = i18n.t('Movies') || 'Movies';
                    } else if (this.params.includeItemTypes.includes('Series')) {
                        typeLabel = i18n.t('TypeOptionPluralSeries') || 'TV Shows';
                    } else if (this.params.includeItemTypes.includes('Season')) {
                        typeLabel = i18n.t('HeaderSeasons') || 'Seasons';
                    } else if (this.params.includeItemTypes.includes('Episode')) {
                        typeLabel = i18n.t('Episodes') || 'Episodes';
                    } else if (this.params.includeItemTypes.includes('TvChannel')) {
                        typeLabel = i18n.t('LiveTv') || 'Live TV';
                    } else if (this.params.includeItemTypes.includes('Person')) {
                        typeLabel = i18n.t('People') || 'People';
                    } else if (this.params.includeItemTypes.includes('MusicArtist')) {
                        typeLabel = i18n.t('Artists') || 'Artists';
                    } else if (this.params.includeItemTypes.includes('MusicAlbum')) {
                        typeLabel = i18n.t('Albums') || 'Albums';
                    } else if (this.params.includeItemTypes.includes('Audio')) {
                        typeLabel = i18n.t('Songs') || 'Songs';
                    }
                }

                // Format title as e.g. "Favorites - Movies" or just fallback to "Favorites"
                virtualTitle = `${i18n.t('Favorites') || 'Favorites'}${typeLabel ? ' - ' + typeLabel : ''}`;
            }

            this.state.libraryInfo = {
                Name: virtualTitle,
                CollectionType: 'all',
                // Propagate personId to libraryInfo so filters know the context if needed
                PersonId: this.params.personId
            };

            this.$('#library-title').textContent = virtualTitle;
            this.title = virtualTitle;
        }

        const cacheKey = this._getCacheKey();

        // State Rehydration Check
        const savedState = state.get(cacheKey);

        if (savedState) {
            // Merge cached state properties
            Object.assign(this.state, savedState.stateData);

            // ------------------------------------------------------------------
            // Load persisted view mode, sort configurations, and active filters.
            // We do this AFTER the Object.assign so the cache doesn't overwrite
            // a preference the user changed while browsing back and forth.
            // ------------------------------------------------------------------
            this._loadPersistedViewMode();
            this._loadPersistedSortMode();
            this._loadPersistedFilters();

            // =========================================================================
            // QUERY PARAMETER FILTER OVERRIDES (CACHE)
            // =========================================================================
            // If the route contains an explicit 'IsFavorite=true' query parameter,
            // we override the loaded library filters to enforce favorite filtering.
            // This allows linking directly to a favorite-filtered subset of any library.
            // =========================================================================
            if (this.params.IsFavorite === 'true') {
                this.state.filters = this.state.filters || {};
                this.state.filters.IsFavorite = true;
            }

            // 1. Setup UI Components
            this._renderTabs();
            this._renderAlphaPicker();
            this._updateControlsVisibility();
            this._updateHeaderVisibility();
            i18n.translateDOM(this.el);
            this._bindEvents();

            // =========================================================================
            // FAVORITES TITLE DECORATION (CACHE)
            // =========================================================================
            // If we are displaying favorite-filtered items, prepend "Favorites"
            // to the page title to provide clear contextual feedback.
            // =========================================================================
            let title = this.state.libraryInfo?.Name || this.title;
            if (this.params.IsFavorite === 'true') {
                title = `${i18n.t('Favorites') || 'Favorites'} - ${title}`;
            }

            this.$('#library-title').textContent = title;
            this.title = title;

            // 2. Hide loading skeleton, show correct container
            const isHorizontalLayout =
                this.state.viewType === 'Genres' ||
                this.state.viewType === 'MusicGenres' ||
                this.state.viewType === 'Suggestions' ||
                this.state.viewType === 'Upcoming';

            const rowsContainer = this.$('#library-rows');
            const grid = this.$('#library-grid');

            if (!isHorizontalLayout) {
                if (rowsContainer) rowsContainer.style.display = 'none';
                if (grid) grid.style.display = '';
                this._renderGrid(this.state.items);
            } else {
                if (rowsContainer) rowsContainer.style.display = '';
                if (grid) grid.style.display = 'none';
                this._renderHorizontalRows(this.state.items);
            }

            this._updatePaginationUI();
            this.setLoading(false);

            // 3. Restore Focus
            requestAnimationFrame(() => {
                let restoredFocus = false;
                const targetId = storage.getItem('pref:disableFocusRestore') === 'true' ? null : savedState.focusItemId;
                const sectionId =
                    storage.getItem('pref:disableFocusRestore') === 'true' ? null : savedState.focusSectionId;

                if (targetId && sectionId) {
                    const sectionConfig = focusManager.getSectionConfig(sectionId);
                    const sectionContainer = sectionConfig ? sectionConfig.container : this.el;

                    const savedElement = sectionContainer.querySelector(
                        `[data-item-id="${targetId}"], [data-id="${targetId}"], [id="${targetId}"]`
                    );

                    if (savedElement) {
                        this.setActiveSection(sectionId, false);
                        focusManager.focusElement(savedElement, { instantScroll: true });
                        restoredFocus = true;
                    }
                }

                if (!restoredFocus) {
                    this._setupFocus();
                }

                state.delete(cacheKey);
                this.markReady();
            });

            return;
        }

        // Library info was already fetched at the top (shared with cache-hit path).
        // Load persisted view mode, sort configurations, and filters now that we know
        // the libraryId and collectionType. This happens before _renderGrid() so the correct
        // display modes and subsets are active from the very beginning.
        this._loadPersistedViewMode();
        this._loadPersistedSortMode();
        this._loadPersistedFilters();

        // =========================================================================
        // QUERY PARAMETER FILTER OVERRIDES (FRESH)
        // =========================================================================
        // If the route contains an explicit 'IsFavorite=true' query parameter,
        // we override the loaded library filters to enforce favorite filtering.
        // This allows linking directly to a favorite-filtered subset of any library.
        // =========================================================================
        if (this.params.IsFavorite === 'true') {
            this.state.filters = this.state.filters || {};
            this.state.filters.IsFavorite = true;
        }

        // 2. Setup UI Components
        this._renderTabs();
        this._renderAlphaPicker();
        this._updateControlsVisibility();
        this._updateHeaderVisibility(); // Ensure initial visibility is correct

        // Translate static UI labels
        i18n.translateDOM(this.el);

        // 2.5 Hydrate fixed UI strings
        i18n.translateDOM(this.el);

        // 3. Bind Events
        this._bindEvents();

        // 4. Handle Genre/Studio/Person Mode — set viewType synchronously FIRST so
        // _loadItems() (running in parallel below) sees the correct value immediately.
        // The API calls for the display title run concurrently with the items fetch.
        if (
            this.params.genreId ||
            this.params.studioId ||
            this.params.year ||
            this.params.personId ||
            this.params.tagName
        ) {
            this.state.viewType = 'Items';
        }

        // Build an async task that resolves the human-readable title from the server.
        // Year and tag don't need a network call and resolve synchronously.
        const infoFetchPromise = (async () => {
            if (this.params.genreId) {
                try {
                    // Fetch basic item and fail gracefully (MusicGenres often 404 on raw getItem)
                    const genre = await api.getItem(this.params.genreId);
                    if (genre && genre.Name) {
                        this.$('#library-title').textContent = genre.Name;
                        this.title = genre.Name;
                    }
                } catch (e) {
                    log.warn('Failed to fetch genre info, checking if name is set in URL or using default', e);
                    this.$('#library-title').textContent = i18n.t('Genres'); // Fallback
                }
            } else if (this.params.studioId) {
                try {
                    const studio = await api.getItem(this.params.studioId);
                    if (studio) {
                        this.$('#library-title').textContent = studio.Name;
                        this.title = studio.Name;
                    }
                } catch (e) {
                    log.error('Failed to fetch studio info', e);
                }
            } else if (this.params.year) {
                const year = decodeURIComponent(this.params.year);
                this.$('#library-title').textContent = i18n.t('YearLabel', [year]);
                this.title = year;
            } else if (this.params.personId) {
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
                const tagName = decodeURIComponent(this.params.tagName);
                this.$('#library-title').textContent = i18n.t('TagLabel', [tagName]);
                this.title = tagName;
            } else if (this.params.searchTerm) {
                const query = decodeURIComponent(this.params.searchTerm);
                const title = i18n.t('SearchResultsFor', [query]);
                this.$('#library-title').textContent = title;
                this.title = title;
            }
        })();

        // Run title resolution and item loading simultaneously. viewType is already set
        // above synchronously, so _loadItems() is guaranteed to see the correct value.
        await Promise.all([infoFetchPromise, this._loadItems()]);

        this._setupFocus();

        // Mark the page as rendered, fulfilling the Promise for NavigationState
        // to restore scroll/focus
        this.markReady();
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
        // Clear stale focus memory from previously viewed libraries since all
        // library instances share section names like 'library-grid'
        focusManager.clearMemory('library-grid');
        focusManager.clearMemory('row-0');
        focusManager.clearMemory('library-tabs');
        focusManager.clearMemory('library-controls');
        focusManager.clearMemory('empty-state-btn');

        const collectionType = this.state.libraryInfo?.CollectionType;
        const autoFocusFirstItem = storage.getItem('pref:focusFirstItemLibrary') !== 'false';

        // If we have items loaded, default focus to the grid (first item) or first horizontal row
        if (autoFocusFirstItem && this.state.items && this.state.items.length > 0) {
            const isHorizontalLayout =
                this.state.viewType === 'Genres' ||
                this.state.viewType === 'MusicGenres' ||
                this.state.viewType === 'Suggestions' ||
                this.state.viewType === 'Upcoming';

            if (isHorizontalLayout) {
                this.setActiveSection('row-0');
            } else {
                this.setActiveSection('library-grid');
            }
            return;
        }

        // Determine start section fallback
        // For BoxSets, tabs are hidden, so start at Controls or Grid
        if (collectionType === 'boxsets' || collectionType === 'playlists') {
            // Try controls first (Sort/Filter), else Grid
            if (this.$('#library-controls')?.style.display !== 'none') {
                this.setActiveSection('library-controls');
            } else {
                this.setActiveSection('library-grid');
            }
        } else {
            // Standard views have tabs
            // Ensure tabs are actually visible?
            if (this.$('#library-tabs')?.style.display !== 'none') {
                this.setActiveSection('library-tabs');
            } else if (this._isSubView()) {
                this.setActiveSection('library-grid'); // Default subview focus
            } else if (this.$('#library-controls')?.style.display !== 'none') {
                // Fallback (e.g. if tabs hidden for some reason, but controls are present)
                this.setActiveSection('library-controls');
            } else {
                // Sub-views have both tabs and controls hidden
                this.setActiveSection('library-grid');
            }
        }
    }

    _bindEvents() {
        this.$('#library-tabs')?.addEventListener('click', this._handleTabClick.bind(this));
        this.$('#btn-shuffle')?.addEventListener('click', this._handleShuffle.bind(this));
        this.$('#btn-sort')?.addEventListener('click', this._handleSort.bind(this));
        this.$('#btn-filter')?.addEventListener('click', this._handleFilter.bind(this));
        this.$('#btn-view-mode')?.addEventListener('click', this._handleViewMode.bind(this));
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

        // Horizontal Rows / Grid Content Selection
        // We handle both mousedown and click for snappy "instant-response" feel on Magic Remote.
        const content = this.$('#library-content');
        if (content) {
            let lastActivateTime = 0;
            const handleActivate = (e) => {
                const card = e.target.closest('.media-card');
                if (!card) {
                    // Check for genre header clicks
                    const headerBtn = e.target.closest('.header-focusable');
                    if (headerBtn) {
                        e.stopPropagation();
                        const genreId =
                            headerBtn.dataset.genreId || headerBtn.closest('.library-row')?.dataset?.genreId;
                        if (genreId) {
                            const now = Date.now();
                            if (now - lastActivateTime < 400) return;
                            lastActivateTime = now;

                            log.info('Navigating to Genre:', genreId);
                            let sectionId = null;
                            const rowAncestor = headerBtn.closest('.library-row');
                            if (rowAncestor && rowAncestor.id) {
                                sectionId = rowAncestor.id;
                            }
                            this._saveState(sectionId, headerBtn.id || headerBtn.dataset.id || genreId);
                            router.navigate(`/library/${this.state.libraryId}/genre/${genreId}`);
                        }
                    }
                    return;
                }

                if (card.dataset.itemId) {
                    const now = Date.now();
                    if (now - lastActivateTime < 400) return;
                    lastActivateTime = now;

                    e.stopPropagation();
                    const itemId = card.dataset.itemId;

                    let sectionId = null;
                    const gridAncestor = card.closest('#library-grid');
                    if (gridAncestor) {
                        sectionId = 'library-grid';
                    } else {
                        const rowAncestor = card.closest('.library-row');
                        if (rowAncestor && rowAncestor.id) {
                            sectionId = rowAncestor.id;
                        }
                    }

                    this._saveState(sectionId, itemId);

                    // Re-use logic from _handleGridClick or centralize it
                    this._handleGridClick(e, card);
                }
            };

            content.addEventListener('mousedown', handleActivate);
            content.addEventListener('click', handleActivate);
        }
    }

    _getCacheKey() {
        const parts = [`library:state:${this.params.id}`];
        if (this.params.genreId) parts.push(`genre:${this.params.genreId}`);
        if (this.params.studioId) parts.push(`studio:${this.params.studioId}`);
        if (this.params.year) parts.push(`year:${this.params.year}`);
        if (this.params.personId) parts.push(`person:${this.params.personId}`);
        if (this.params.tagName) parts.push(`tag:${this.params.tagName}`);
        return parts.join(':');
    }

    _saveState(focusSectionId, focusItemId) {
        if (storage.getItem('pref:disableLibraryCache') === 'true') return;
        state.set(this._getCacheKey(), {
            stateData: this.state,
            focusSectionId: storage.getItem('pref:disableFocusRestore') === 'true' ? null : focusSectionId,
            focusItemId: storage.getItem('pref:disableFocusRestore') === 'true' ? null : focusItemId
        });
    }

    // ========================================================================
    // Navigation State (for back navigation restoration)
    // ========================================================================

    /**
     * Get page state for navigation history.
     * Saves filters, sort, pagination, tab selection, AND view mode.
     */
    getNavigationState() {
        return {
            viewType: this.state.viewType,
            sortBy: this.state.sortBy,
            sortOrder: this.state.sortOrder,
            filters: { ...this.state.filters }, // Clone object
            nameStartsWith: this.state.nameStartsWith,
            startIndex: this.state.startIndex,
            limit: this.state.limit,
            viewMode: this.state.viewMode
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
            filters: savedState.filters || {},
            nameStartsWith: savedState.nameStartsWith || null,
            startIndex: savedState.startIndex || 0,
            limit: savedState.limit || this.state.limit,
            // Restore view mode from nav state (set before _renderGrid runs)
            viewMode: savedState.viewMode || this.state.viewMode
        });

        log.info('Navigation state restored:', savedState);
    }

    destroy() {
        super.destroy();
        this.$('#library-tabs')?.removeEventListener('click', this._onTabClick);
        this.$('#alpha-picker')?.removeEventListener('click', this._onAlphaClick);

        // Clean up the progressive grid DOM trigger listener to prevent leaks
        if (this._onGridFocusChanged) {
            eventBus.off('focus:changed', this._onGridFocusChanged);
            this._onGridFocusChanged = null;
        }
    }

    // ========================================================================
    // Data Fetching
    // ========================================================================

    async _fetchLibraryInfo() {
        if (this.state.libraryId === 'all') {
            return;
        }

        try {
            const item = await api.getItem(this.state.libraryId);

            // If the libraryId is a deep link to an Album/Artist/Series, it won't have a CollectionType.
            // Fake it so the LibraryPage behaves like it's inside that specific library type.
            if (!item.CollectionType) {
                // Expanded list of types that imply a specific collection context
                if (['MusicAlbum', 'MusicArtist', 'Audio', 'MusicGenre', 'Artist'].includes(item.Type)) {
                    item.CollectionType = 'music';
                } else if (['Series', 'Season', 'Episode', 'TvChannel', 'TvProgram'].includes(item.Type)) {
                    item.CollectionType = 'tvshows';
                } else if (item.Type === 'MusicVideo') {
                    item.CollectionType = 'musicvideos';
                } else if (['Movie', 'BoxSet', 'Video'].includes(item.Type)) {
                    item.CollectionType = 'movies';
                }
            }

            // Flag this as a folder-based library if it matches 'folders' type
            // or is a generic collection without a specific media type.
            this.state.isFolderLibrary =
                item.CollectionType === 'folders' ||
                (!item.CollectionType &&
                    (item.Type === 'CollectionFolder' || item.Type === 'UserView' || item.Type === 'Folder'));

            // If the item fetched is a Folder, we are in a sub-folder view.
            this.state.isSubFolder =
                item.Type === 'Folder' || (item.Type === 'CollectionFolder' && !item.CollectionType && item.ParentId);

            this.state.libraryInfo = item;
            let title = item.Name;

            // =========================================================================
            // FAVORITES TITLE DECORATION (FETCH)
            // =========================================================================
            // If the route contains an explicit 'IsFavorite=true' query parameter,
            // we prepend the localized 'Favorites' string to the library page title.
            // =========================================================================
            if (this.params.IsFavorite === 'true') {
                title = `${i18n.t('Favorites') || 'Favorites'} - ${title}`;
            }

            this.$('#library-title').textContent = title;
            this.title = title; // Update Page title
        } catch (e) {
            log.error('Failed to fetch info', e);
        }
    }

    async _loadItems() {
        this.setLoading(true);

        // Capture starting viewType to prevent race conditions
        const capturedViewType = this.state.viewType;

        // Show Skeleton instead of spinner
        // Pre-emptive Cleanup: Hide horizontal rows early if switching to grid
        const isHorizontalLayout =
            this.state.viewType === 'Genres' ||
            this.state.viewType === 'MusicGenres' ||
            this.state.viewType === 'Suggestions' ||
            this.state.viewType === 'Upcoming';
        const rowsContainer = this.$('#library-rows');
        const grid = this.$('#library-grid');

        const isLandscape =
            this.state.viewType === 'Episodes' ||
            this.state.viewType === 'Upcoming' ||
            this.state.viewType === 'Networks' ||
            this.params.includeItemTypes === 'Episode';

        const contentContainer = this.$('.library-content');

        if (!isHorizontalLayout) {
            if (rowsContainer) {
                rowsContainer.style.display = 'none';
                rowsContainer.innerHTML = ''; // Clear stale horizontal rows immediately
            }
            if (grid) {
                grid.style.display = '';
                grid.innerHTML = ''; // Clear stale grid content
            }
        } else {
            if (rowsContainer) {
                rowsContainer.style.display = '';
                rowsContainer.innerHTML = ''; // Clear for new horizontal load
            }
            if (grid) {
                grid.style.display = 'none';
                grid.innerHTML = ''; // Clear grid content
            }
        }

        if (contentContainer) {
            if (this.state.viewType === 'Suggestions' || this.state.viewType === 'Upcoming') {
                contentContainer.classList.add('horizontal-rows');
            } else {
                contentContainer.classList.remove('horizontal-rows');
            }
        }

        if (grid && !isHorizontalLayout) {
            // Show a skeleton whose shape matches the active view mode.
            // For forced landscape tab types, ignore viewMode and show landscape skeletons.
            const skeletonMode = isLandscape ? 'thumb' : this.state.viewMode;
            const hideLibraryLabels = storage.getItem('pref:hideLibraryLabels') === 'true';
            const isModern = document.documentElement.getAttribute('data-layout-media-rows') === 'modern';
            const isLibraryView =
                this.state.viewMode === 'library' || this.state.libraryInfo?.CollectionType === 'folders';
            const shouldHideLabels = (isLibraryView && hideLibraryLabels) || (isLibraryView && isModern);

            grid.innerHTML = CardRenderer.createSkeletonHtml(12, isLandscape, skeletonMode, shouldHideLabels);
        }

        try {
            const params = {
                SortBy: this.state.sortBy,
                SortOrder: this.state.sortOrder,
                StartIndex: this.state.startIndex,
                Limit: this.state.limit,
                Recursive: true,
                Fields: 'DateCreated,ProductionYear,CommunityRating,OfficialRating',
                ImageTypeLimit: 1,
                EnableImageTypes: 'Primary,Backdrop,Thumb'
            };

            // Only set ParentId if it's not the virtual 'all' library
            if (this.state.libraryId && this.state.libraryId !== 'all') {
                params.ParentId = this.state.libraryId;
            } else if (this.params.parentId) {
                params.ParentId = this.params.parentId;
            }

            // Apply Search Term if expanding search results
            if (this.params.searchTerm) {
                params.SearchTerm = decodeURIComponent(this.params.searchTerm);
                params.Recursive = true; // Always recursive for search
            }

            // Apply explicit item types from route (used for search/person expansion)
            if (this.params.includeItemTypes) {
                params.IncludeItemTypes = this.params.includeItemTypes;
            }

            // If it's a folder-based library (generic/Home Videos) or we are explicitly
            // in a "Folders" tab, disable recursion so we can browse the hierarchy.
            if (this.state.isFolderLibrary || this.state.viewType === 'Folders') {
                params.Recursive = false;
            }

            // Apply Filters
            if (this.state.nameStartsWith) {
                if (this.state.nameStartsWith === '#') {
                    params.NameLessThan = 'A';
                } else {
                    params.NameStartsWith = this.state.nameStartsWith;
                }
            }

            let subViewItemTypes = 'Movie,Series'; // Exclude Episode by default for all genre/studio/tag views
            const info = this.state.libraryInfo;
            // Infer music collection if Type is MusicAlbum, MusicArtist, MusicGenre, or CollectionType is music
            const isMusic =
                info?.CollectionType === 'music' ||
                ['MusicAlbum', 'MusicArtist', 'Audio', 'MusicGenre'].includes(info?.Type);
            const isTv =
                info?.CollectionType === 'tvshows' ||
                ['Series', 'Season', 'Episode', 'TvChannel', 'TvProgram'].includes(info?.Type);

            if (isMusic) {
                subViewItemTypes = 'MusicAlbum,Audio';
            } else if (isTv) {
                subViewItemTypes = 'Series';
            } else if (info?.CollectionType === 'movies') {
                subViewItemTypes = 'Movie';
            } else if (info?.CollectionType === 'musicvideos') {
                subViewItemTypes = 'MusicVideo';
            } else {
                log.info(
                    'Defaulting to Movie/TV subview types for unknown collection:',
                    info?.Type,
                    info?.CollectionType
                );
            }

            // Apply Genre Filter (From Route)
            if (this.params.genreId) {
                params.GenreIds = this.params.genreId;
                params.Recursive = true;
                params.IncludeItemTypes = this.params.includeItemTypes || subViewItemTypes; // Adapt to library type
            }

            // Apply Studio Filter (From Route)
            if (this.params.studioId) {
                params.StudioIds = this.params.studioId;
                params.IncludeItemTypes = this.params.includeItemTypes || subViewItemTypes;
            }

            // Apply Year Filter (From Route)
            if (this.params.year) {
                params.Years = decodeURIComponent(this.params.year);
                params.IncludeItemTypes = this.params.includeItemTypes || subViewItemTypes;
            }

            // Apply Person Filter (From Route)
            if (this.params.personId) {
                const itemTypes = this.params.includeItemTypes || subViewItemTypes;
                params.IncludeItemTypes = itemTypes;

                // Jellyfin uses ArtistIds instead of PersonIds for music tracks and albums
                if (itemTypes.includes('Audio') || itemTypes.includes('MusicAlbum')) {
                    params.ArtistIds = this.params.personId;
                } else {
                    params.PersonIds = this.params.personId;
                }
            }

            // Apply Tag Filter (From Route)
            if (this.params.tagName) {
                params.Tags = decodeURIComponent(this.params.tagName);
                params.IncludeItemTypes = this.params.includeItemTypes || subViewItemTypes;
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

            if (this.params.includeItemTypes === 'Person') {
                result = await api.searchPeople(params.SearchTerm || '', {
                    StartIndex: params.StartIndex,
                    Limit: params.Limit
                });
            } else if (viewType === 'Items' || viewType === 'Movies' || viewType === 'Shows') {
                // Standard Item Fetch
                // For TV Shows library, 'Shows' -> IncludeItemTypes: 'Series'
                if (this.state.libraryInfo?.CollectionType === 'tvshows') {
                    params.IncludeItemTypes = 'Series';
                } else if (this.state.libraryInfo?.CollectionType === 'movies') {
                    params.IncludeItemTypes = 'Movie';
                } else if (
                    this.state.libraryInfo?.CollectionType === 'boxsets' ||
                    this.state.libraryInfo?.CollectionType === 'playlists'
                ) {
                    params.IncludeItemTypes =
                        this.state.libraryInfo.CollectionType === 'boxsets' ? 'BoxSet' : 'Playlist';
                    params.Recursive = true;
                } else if (this.state.libraryInfo?.CollectionType === 'music' && !this.params.genreId) {
                    // For standard Item fetches in Music libraries without specific subview filters like genre
                    params.IncludeItemTypes = 'MusicAlbum';
                } else if (this.state.libraryInfo?.CollectionType === 'musicvideos') {
                    params.IncludeItemTypes = 'MusicVideo';
                }
                result = await api.getItems(params);
            } else if (viewType === 'Suggestions') {
                // Fetch multiple rows for Suggestions with Recommendations.
                // Each source is individually try/catched so one failing API call
                // doesn't kill the entire Suggestions page — we render what we get.
                const rows = [];

                const collectionType = this.state.libraryInfo?.CollectionType;

                if (collectionType === 'music') {
                    // ------------------------------------------------------------------
                    // Music Suggestions — Recently Added Albums, Recently Played, Favorite Artists
                    // ------------------------------------------------------------------
                    const [latest, resume, favorites, recentlyPlayed, frequentlyPlayed] = await Promise.all([
                        api
                            .getLatestItems(this.state.libraryId, { Limit: 12, IncludeItemTypes: 'MusicAlbum' })
                            .catch(() => []),
                        api.getResumeAudio({ Limit: 12 }).catch(() => ({ Items: [] })),
                        api
                            .getItems({
                                ParentId: this.state.libraryId,
                                IsFavorite: true,
                                SortBy: 'Random',
                                Limit: 12,
                                Recursive: true,
                                IncludeItemTypes: 'MusicArtist,Artist'
                            })
                            .catch(() => ({ Items: [] })),
                        api.getRecentlyPlayedAudio(this.state.libraryId, 12).catch(() => ({ Items: [] })),
                        api.getFrequentlyPlayedAudio(this.state.libraryId, 12).catch(() => ({ Items: [] }))
                    ]);

                    if (latest && latest.length > 0) {
                        rows.push({
                            title: i18n.t('HeaderRecentlyAdded'),
                            items: latest,
                            cardType: 'square',
                            contextType: 'music'
                        });
                    }
                    if (recentlyPlayed.Items && recentlyPlayed.Items.length > 0) {
                        rows.push({
                            title: i18n.t('HeaderRecentlyPlayed'),
                            items: recentlyPlayed.Items,
                            cardType: 'square',
                            contextType: 'music'
                        });
                    }
                    if (frequentlyPlayed.Items && frequentlyPlayed.Items.length > 0) {
                        rows.push({
                            title: i18n.t('HeaderFrequentlyPlayed'),
                            items: frequentlyPlayed.Items,
                            cardType: 'square',
                            contextType: 'music'
                        });
                    }
                    if (resume.Items && resume.Items.length > 0) {
                        rows.push({
                            title: i18n.t('HeaderResume'),
                            items: resume.Items,
                            isLandscape: true, // Show audio items similarly to resume
                            cardType: 'backdrop',
                            contextType: 'resume'
                        });
                    }
                    if (favorites.Items && favorites.Items.length > 0) {
                        rows.push({
                            title: i18n.t('Artists'),
                            items: favorites.Items,
                            cardType: 'square',
                            contextType: 'library'
                        });
                    }

                    // Guard: Check if we are still on the same tab
                    if (this.state.viewType !== capturedViewType) {
                        log.info('Suggestions fetch finished but user switched tabs. Aborting render.');
                        return;
                    }

                    this.state.items = rows;
                    this._renderHorizontalRows(this.state.items);
                    this._updatePaginationUI();
                    return; // Skip grid render
                }

                if (collectionType === 'musicvideos') {
                    // ------------------------------------------------------------------
                    // Music Video Suggestions
                    // ------------------------------------------------------------------
                    const [latest, recentlyPlayed, frequentlyPlayed] = await Promise.all([
                        api
                            .getLatestItems(this.state.libraryId, { Limit: 12, IncludeItemTypes: 'MusicVideo' })
                            .catch(() => []),
                        api
                            .getItems({
                                ParentId: this.state.libraryId,
                                SortBy: 'DatePlayed',
                                SortOrder: 'Descending',
                                Limit: 12,
                                Recursive: true,
                                IncludeItemTypes: 'MusicVideo',
                                Filters: 'IsPlayed'
                            })
                            .catch(() => ({ Items: [] })),
                        api
                            .getItems({
                                ParentId: this.state.libraryId,
                                SortBy: 'PlayCount',
                                SortOrder: 'Descending',
                                Limit: 12,
                                Recursive: true,
                                IncludeItemTypes: 'MusicVideo',
                                Filters: 'IsPlayed'
                            })
                            .catch(() => ({ Items: [] }))
                    ]);

                    if (latest && latest.length > 0) {
                        rows.push({
                            title: i18n.t('HeaderRecentlyAdded'),
                            items: latest,
                            isLandscape: true,
                            cardType: 'backdrop',
                            contextType: 'library'
                        });
                    }
                    if (recentlyPlayed.Items && recentlyPlayed.Items.length > 0) {
                        rows.push({
                            title: i18n.t('HeaderRecentlyPlayed'),
                            items: recentlyPlayed.Items,
                            isLandscape: true,
                            cardType: 'backdrop',
                            contextType: 'library'
                        });
                    }
                    if (frequentlyPlayed.Items && frequentlyPlayed.Items.length > 0) {
                        rows.push({
                            title: i18n.t('HeaderFrequentlyPlayed'),
                            items: frequentlyPlayed.Items,
                            isLandscape: true,
                            cardType: 'backdrop',
                            contextType: 'library'
                        });
                    }

                    // Guard: Check if we are still on the same tab
                    if (this.state.viewType !== capturedViewType) {
                        return;
                    }

                    this.state.items = rows;
                    this._renderHorizontalRows(this.state.items);
                    this._updatePaginationUI();
                    return;
                }

                const suggestionTypes = collectionType === 'tvshows' ? 'Series' : 'Movie,Series';

                // ------------------------------------------------------------------
                // 1. Continue Watching, Next Up, and Latest — parallel fetch
                //    Each is wrapped independently so a 404/400 on one still renders the others.
                // NOTE: getNextUp uses /Shows/NextUp which does NOT accept ParentId —
                //       it's a global TV endpoint. We omit ParentId to avoid 400 errors
                //       on Jellyfin servers that validate parameter compatibility.
                // ------------------------------------------------------------------
                const [resume, nextUp, latest] = await Promise.all([
                    // Intentionally no ParentId here — resume items are user-global and
                    // scoping by library forces the server to cross-reference all episodes
                    // in the library, which is very slow on large TV libraries.
                    api.getResumeItems({ Limit: 8 }).catch((e) => {
                        log.warn('Failed to fetch resume items for Suggestions', e);
                        return { Items: [] };
                    }),
                    api.getNextUp({ Limit: 8 }).catch((e) => {
                        log.warn('Failed to fetch nextUp for Suggestions', e);
                        return { Items: [] };
                    }),
                    api
                        .getLatestItems(this.state.libraryId, { Limit: 8, IncludeItemTypes: suggestionTypes })
                        .catch((e) => {
                            log.warn('Failed to fetch latest items for Suggestions', e);
                            return [];
                        })
                ]);

                if (resume.Items && resume.Items.length > 0) {
                    rows.push({
                        title: i18n.t('HeaderContinueWatching'),
                        items: resume.Items,
                        isLandscape: true,
                        cardType: 'backdrop',
                        contextType: 'resume'
                    });
                }
                if (nextUp.Items && nextUp.Items.length > 0) {
                    rows.push({
                        title: i18n.t('NextUp'),
                        items: nextUp.Items,
                        isLandscape: true,
                        cardType: 'backdrop',
                        contextType: 'nextUp'
                    });
                }
                if (latest && latest.length > 0) {
                    let header = 'HeaderRecentlyAdded';
                    if (collectionType === 'tvshows') {
                        header = 'HeaderLatestEpisodes';
                    } else if (collectionType === 'movies') {
                        header = 'HeaderLatestMovies';
                    } else if (collectionType === 'music') {
                        header = 'HeaderLatestMusic';
                    }
                    rows.push({ title: i18n.t(header), items: latest, contextType: 'suggestion' });
                }

                // ------------------------------------------------------------------
                // 2. "Because You Watch..." — based on active resume items
                // ------------------------------------------------------------------
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
                            rows.push({
                                title: i18n.t('SimilarTo', [targetName]),
                                items: similar.Items,
                                contextType: 'suggestion'
                            });
                        }
                    } catch (e) {
                        log.warn('Failed to load similar suggestions', e);
                    }
                }

                // ------------------------------------------------------------------
                // 3. "Because You Like..." — based on random Favorite in this library
                // ------------------------------------------------------------------
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
                            rows.push({
                                title: i18n.t('RecommendationBecauseYouLike', [favItem.Name]),
                                items: similarFav.Items,
                                contextType: 'suggestion'
                            });
                        }
                    }
                } catch (e) {
                    log.warn('Failed to load favorite suggestions', e);
                }

                // Guard: Check if we are still on the same tab
                if (this.state.viewType !== capturedViewType) {
                    log.info('Suggestions fetch finished but user switched tabs. Aborting render.');
                    return;
                }

                this.state.items = rows; // Store rows for caching/restoration
                this._renderHorizontalRows(this.state.items);
                this._updatePaginationUI();
                return; // Skip grid render
            } else if (viewType === 'Genres' || viewType === 'MusicGenres') {
                // Fetch Genres List
                const genreFetchMethod = viewType === 'MusicGenres' ? 'getMusicGenres' : 'getGenres';
                result = await api[genreFetchMethod]({
                    ParentId: this.state.libraryId,
                    SortBy: 'SortName',
                    SortOrder: 'Ascending',
                    Limit: 50 // Fetch top 50 genres max to keep requests reasonable
                });

                if (this.state.viewType !== capturedViewType) return;

                const allGenres = result.Items || [];

                // Fetch items for ALL genres in parallel (Limit 12 per genre)
                // We pre-load data so we don't need row-intersections
                const collectionType = this.state.libraryInfo?.CollectionType;
                const includeItemTypes =
                    collectionType === 'tvshows'
                        ? 'Series'
                        : collectionType === 'movies'
                          ? 'Movie'
                          : collectionType === 'music'
                            ? 'MusicAlbum'
                            : 'Movie,Series';

                const rowPromises = allGenres.map(async (genre) => {
                    const params = {
                        ParentId: this.state.libraryId,
                        GenreIds: genre.Id,
                        StartIndex: 0,
                        Limit: 12, // Max 12 items as requested
                        Recursive: true,
                        IncludeItemTypes: includeItemTypes,
                        Fields: 'ProductionYear,CommunityRating',
                        ImageTypeLimit: 1,
                        EnableImageTypes: 'Primary,Backdrop,Thumb'
                    };

                    try {
                        const itemsResult = await api.getItems(params);
                        return {
                            title: genre.Name,
                            genreId: genre.Id,
                            isLazy: false, // Data is fully loaded
                            items: itemsResult.Items || [],
                            contextType: 'genre'
                        };
                    } catch (err) {
                        log.warn(`Failed to load items for genre ${genre.Name}`, err);
                        return null;
                    }
                });

                const loadedRows = (await Promise.all(rowPromises)).filter((r) => r && r.items.length > 0);

                // Guard: Check if we are still on the same tab
                if (this.state.viewType !== capturedViewType) {
                    log.info('Genre rows fetch finished but user switched tabs. Aborting render.');
                    return;
                }

                this.state.items = loadedRows; // Store rows for caching/restoration
                this._renderHorizontalRows(this.state.items);
                this._updatePaginationUI();
                return;
            } else if (viewType === 'Upcoming') {
                // Fetch upcoming items
                result = await api.getUpcoming({ ParentId: this.state.libraryId, Limit: 60 });

                if (this.state.viewType !== capturedViewType) return;

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

                    if (dZero.getTime() === today.getTime()) title = i18n.t('Today');
                    else if (dZero.getTime() === tomorrow.getTime()) title = i18n.t('Tomorrow');

                    return {
                        title: title,
                        items: group.items,
                        genreId: null // Static header
                    };
                });

                this.state.items = displayRows; // Store rows for caching/restoration
                // CRITICAL: Reset totalRecordCount to prevent stale pagination footer
                this.state.totalRecordCount = 0;

                // Guard: Check if we are still on the same tab
                if (this.state.viewType !== capturedViewType) return;

                this._renderHorizontalRows(this.state.items);
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
            } else if (viewType === 'Albums') {
                params.IncludeItemTypes = 'MusicAlbum';
                params.Recursive = true;
                result = await api.getItems(params);
            } else if (viewType === 'AlbumArtists') {
                result = await api.getAlbumArtists({
                    ParentId: this.state.libraryId,
                    StartIndex: params.StartIndex,
                    Limit: params.Limit,
                    NameStartsWith: params.NameStartsWith,
                    NameLessThan: params.NameLessThan
                });
            } else if (viewType === 'Artists') {
                result = await api.getMusicArtists({
                    ParentId: this.state.libraryId,
                    StartIndex: params.StartIndex,
                    Limit: params.Limit,
                    NameStartsWith: params.NameStartsWith,
                    NameLessThan: params.NameLessThan
                });
            } else if (viewType === 'Songs') {
                params.IncludeItemTypes = 'Audio';
                params.Recursive = true;
                params.SortBy = 'Album,SortName';
                result = await api.getItems(params);
            } else if (viewType === 'Playlists') {
                params.IncludeItemTypes = 'Playlist';
                params.Recursive = true;
                result = await api.getItems(params);
            } else if (viewType === 'Folders') {
                // Explicitly handled Folders tab – always non-recursive
                params.Recursive = false;
                result = await api.getItems(params);
            } else if (viewType === 'Photos') {
                params.IncludeItemTypes = 'Photo,Video';
                params.Recursive = true;
                result = await api.getItems(params);
            } else if (viewType === 'PhotoAlbums') {
                params.IncludeItemTypes = 'PhotoAlbum';
                params.Recursive = true;
                result = await api.getItems(params);
            } else if (viewType === 'Videos') {
                params.IncludeItemTypes = 'Video';
                params.Recursive = true;
                result = await api.getItems(params);
            }

            // Guard: Check if we are still on the same tab before rendering grid
            if (this.state.viewType === capturedViewType) {
                this.state.items = result?.Items || [];
                this.state.totalRecordCount = result?.TotalRecordCount || 0;

                // Enrich individual playlist/collection items with Primary images from their contents
                const collectionType = this.state.libraryInfo?.CollectionType;
                if ((collectionType === 'playlists' || collectionType === 'boxsets') && this.state.items.length > 0) {
                    await this._enrichCollectionItems(this.state.items, collectionType);
                }

                this._renderGrid(this.state.items);
                this._updatePaginationUI();
            } else {
                log.info(`Stale grid load for ${capturedViewType} discarded (current: ${this.state.viewType})`);
            }
        } catch (e) {
            log.error('Failed to load items', e);
            this.$('#library-grid').innerHTML = `<p class="error-msg">${i18n.t('FailedToLoadContent')}</p>`;
        } finally {
            this.setLoading(false);
            // Apply Header visibility and specialization AFTER content is loaded
            this._updateControlsVisibility();
            this._updateHeaderVisibility();

            // Force Focus Check - Ensure we don't drop focus after load
            // Especially for BoxSets where tabs are hidden and initial focus might be lost
            if (!document.activeElement || document.activeElement === document.body) {
                const collectionType = this.state.libraryInfo?.CollectionType;
                if (collectionType === 'boxsets' || collectionType === 'playlists') {
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

        this.$('#pagination-info').textContent = i18n.t('PageNumberXOfY', [currentPage, totalPages || 1]);

        // Hide/Show logic for single page or horizontal row views (Genres/Suggestions)
        const isHorizontalView =
            this.state.viewType === 'Genres' ||
            this.state.viewType === 'MusicGenres' ||
            this.state.viewType === 'Suggestions';
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
    // View Mode Helpers
    // ========================================================================

    /**
     * Load the persisted view mode for the current library from StorageService.
     *
     * Rules:
     *  - Sub-views (genre/studio/person/tag/year filters) always reset to 'poster'
     *    so Browse paths never inherit a list or thumb preference.
     *  - All libraries default to 'poster' when no saved preference exists.
     *
     * IMPORTANT: 'viewMode' is a layout concept (grid width, orientation).
     * The card image type (poster vs square vs backdrop) is resolved separately
     * in _resolveCardType() so that viewMode always maps to one of the 5 picker
     * options regardless of library type.
     */
    _loadPersistedViewMode() {
        const validModes = ['poster', 'small-poster', 'thumb', 'banner', 'list'];

        // If an initial viewing mode index is provided in the URL, use it and don't persist it.
        if (this.params.viewModeIndex !== undefined) {
            const index = parseInt(this.params.viewModeIndex, 10);
            if (!isNaN(index) && validModes[index]) {
                this.state.viewMode = validModes[index];
                log.info(`[ViewMode] Loaded view mode index from URL: ${index} -> ${this.state.viewMode}`);
                return;
            }
        }

        if (this._isSubView()) {
            // Sub-views always reset to the poster default rather than inheriting
            // whatever the parent library is configured to — avoids confusing layouts
            // when drilling into genres/studios/persons.
            this.state.viewMode = 'poster';
            return;
        }

        const storageKey = `pref:library:viewMode:${this.state.libraryId}`;
        const saved = storage.getItem(storageKey);

        if (saved) {
            // Validate the value is still a known picker option (guards against stale data)
            const validModes = ['poster', 'small-poster', 'thumb', 'banner', 'list'];
            this.state.viewMode = validModes.includes(saved) ? saved : 'poster';
        } else {
            // No preference saved — universal default is 'poster'.
            // Music albums show as square cards via _resolveCardType(), not via viewMode.
            this.state.viewMode = 'poster';
        }

        log.info(`[ViewMode] Loaded view mode: ${this.state.viewMode} for library ${this.state.libraryId}`);

        /*
         * =========================================================================
         * REHYDRATE GRID CONFIGURATIONS
         * =========================================================================
         * Loads whether we are using Static or Dynamic sizing modes, and the specific
         * custom column counts selected for this viewMode.
         * =========================================================================
         */
        const modeKey = `pref:library:gridMode:${this.state.libraryId}`;
        const savedMode = storage.getItem(modeKey);
        this.state.gridMode = savedMode === 'static' ? 'static' : 'dynamic';

        const colsKey = `pref:library:gridColumns:${this.state.libraryId}:${this.state.viewMode}`;
        const savedCols = parseInt(storage.getItem(colsKey), 10);
        this.state.gridColumns = !isNaN(savedCols) ? savedCols : this._getDefaultColumnsForMode(this.state.viewMode);
    }

    _loadPersistedSortMode() {
        if (this._isSubView()) {
            return; // Sub-views should fallback to defaults
        }

        const sortByKey = `pref:library:sortBy:${this.state.libraryId}`;
        const sortOrderKey = `pref:library:sortOrder:${this.state.libraryId}`;

        const savedSortBy = storage.getItem(sortByKey);
        const savedSortOrder = storage.getItem(sortOrderKey);

        if (savedSortBy) {
            this.state.sortBy = savedSortBy;
        }
        if (savedSortOrder) {
            this.state.sortOrder = savedSortOrder;
        }
    }

    /**
     * ========================================================================
     * Filter State Preservation and Rehydration
     * ========================================================================
     * Load the user's previously applied filters for this specific library.
     * Preserving filter preferences ensures a personalized and streamlined
     * navigation experience across sessions, conforming to state-preservation
     */
    _loadPersistedFilters() {
        // Skip sub-views (genre, studio, tag pages, etc.) to prevent overriding
        // their specific query parameters with the general library filters.
        if (this._isSubView()) {
            return;
        }

        // Retrieve saved filters for this library from local storage
        const filtersKey = `pref:library:filters:${this.state.libraryId}`;
        const savedFilters = storage.getItem(filtersKey);

        if (savedFilters) {
            try {
                // Parse the JSON string back into a filters object
                this.state.filters = JSON.parse(savedFilters);
                log.info(
                    `[Filters] Rehydrated persisted filters for library ${this.state.libraryId}:`,
                    this.state.filters
                );
            } catch (e) {
                // Fallback gracefully on parsing errors to keep the application stable
                log.error('Failed to parse persisted filters, falling back to empty state', e);
                this.state.filters = {};
            }
        }
    }

    /**
     * Resolve the CardRenderer card type string based on the active viewMode,
     * viewType override (Episodes, Networks), and library collection type.
     *
     * Priority: forced landscape tab types > music library > user view mode
     *
     * @param {boolean} isLandscape - Whether the current tab forces landscape
     * @returns {string} Card type string for CardRenderer.createCardHtml()
     */
    _resolveCardType(isLandscape) {
        // Forced tab-type overrides: always resolve before checking user preference
        if (
            this.state.viewType === 'Episodes' ||
            this.state.viewType === 'Upcoming' ||
            this.params.includeItemTypes === 'Episode'
        ) {
            return 'episode';
        }
        if (this.state.viewType === 'Networks') {
            return 'backdrop';
        }

        // Custom layout requests from deep links (Music, TV Channels, Artists, People)
        const squareTypes = ['TvChannel', 'MusicAlbum', 'MusicArtist,Artist', 'MusicArtist', 'Audio'];
        if (
            this.state.libraryInfo?.CollectionType === 'music' ||
            this.state.libraryInfo?.CollectionType === 'homevideos' ||
            this.state.libraryInfo?.CollectionType === 'musicvideos' ||
            (this.params.includeItemTypes && squareTypes.includes(this.params.includeItemTypes))
        ) {
            // For thumb/banner, use backdrop if available; fall back gracefully
            if (this.state.viewMode === 'thumb' || this.state.viewMode === 'banner') {
                return 'backdrop';
            }
            return 'square';
        }

        if (this.params.includeItemTypes === 'Person') {
            return 'person';
        }

        // Map user view mode to card type
        // - poster, small-poster, list: portrait primary image
        // - thumb, banner: landscape backdrop/thumb image
        switch (this.state.viewMode) {
            case 'thumb':
            case 'banner':
                return 'backdrop';
            case 'poster':
                return 'poster';
            case 'small-poster':
                return 'small-poster';
            case 'list':
            default:
                return 'poster';
        }
    }

    _isSubView() {
        return !!(
            this.params.genreId ||
            this.params.studioId ||
            this.params.year ||
            this.params.personId ||
            this.params.tagName ||
            this.params.searchTerm ||
            this.params.includeItemTypes
        );
    }

    _renderTabs() {
        const collectionType = this.state.libraryInfo?.CollectionType || 'movies';
        const tabsContainer = this.$('#library-tabs');

        // Hide tabs for BoxSets (Collections), Playlists, Folder libraries, or if we are deep linking into a subview
        if (
            collectionType === 'boxsets' ||
            collectionType === 'playlists' ||
            this.state.isFolderLibrary ||
            this._isSubView()
        ) {
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
                { id: 'Items', label: 'TypeOptionPluralSeries' },
                { id: 'Suggestions', label: 'Suggestions' },
                { id: 'Upcoming', label: 'TabUpcoming' },
                { id: 'Genres', label: 'Genres' },
                { id: 'Networks', label: 'TabNetworks' },
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
        } else if (collectionType === 'music') {
            tabs = [
                { id: 'Albums', label: 'Albums' },
                { id: 'Suggestions', label: 'Suggestions' },
                { id: 'AlbumArtists', label: 'AlbumArtists' },
                { id: 'Artists', label: 'Artists' },
                { id: 'Playlists', label: 'Playlists' },
                { id: 'Songs', label: 'Songs' },
                { id: 'MusicGenres', label: 'Genres' }
            ];
        } else if (collectionType === 'homevideos') {
            tabs = [
                { id: 'Folders', label: 'Folders' },
                { id: 'Photos', label: 'Photos' },
                { id: 'PhotoAlbums', label: 'PhotoAlbums' },
                { id: 'Videos', label: 'Videos' }
            ];
        } else if (collectionType === 'musicvideos') {
            tabs = [
                { id: 'Items', label: 'MusicVideos' },
                { id: 'Suggestions', label: 'Suggestions' },
                { id: 'Genres', label: 'Genres' },
                { id: 'Folders', label: 'Folders' }
            ];
        } else {
            // Generic fallback (Generic Folders, Music Videos, etc.)
            tabs = [
                { id: 'Items', label: 'Folders' },
                { id: 'Suggestions', label: 'Suggestions' },
                { id: 'Genres', label: 'Genres' }
            ];
        }

        // If the current viewType is not in the generated tabs, and we are not in a subview,
        // default to the first tab to ensure correct rendering and API calls.
        if (!tabs.some((t) => t.id === this.state.viewType) && !this._isSubView()) {
            this.state.viewType = tabs[0].id;
        }

        if (!tabsContainer) return;

        tabsContainer.innerHTML = tabs
            .map(
                (tab) => `
            <button class="tab-btn ${this.state.viewType === tab.id ? 'active' : ''}" 
                    data-type="${tab.id}" 
                    tabindex="0"
                    data-i18n="${tab.label}">${i18n.t(tab.label)}</button>
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
                const isActive = char === activeChar; // Simplified # logic
                return `
                <button class="alpha-btn ${isActive ? 'active' : ''}" 
                        data-char="${char}" 
                        tabindex="0">${char}</button>
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

    async _enrichCollectionItems(items, collectionType) {
        const isPlaylist = collectionType === 'playlists';
        await Promise.all(
            items.map(async (item) => {
                try {
                    let innerItems;
                    if (isPlaylist) {
                        const resp = await api.getPlaylistItems(item.Id, {
                            Limit: 20,
                            Fields: 'ImageTags'
                        });
                        innerItems = resp?.Items || [];
                    } else {
                        const resp = await api.getItems({
                            ParentId: item.Id,
                            SortBy: 'Random',
                            Recursive: true,
                            Limit: 20,
                            Fields: 'ImageTags',
                            ImageTypeLimit: 1,
                            EnableImageTypes: 'Primary'
                        });
                        innerItems = resp?.Items || [];
                    }

                    const shuffled = innerItems.sort(() => 0.5 - Math.random());
                    const { maxWidth, quality } = imageService.getParams('card-backdrop');

                    for (const inner of shuffled) {
                        if (inner.ImageTags?.Primary) {
                            item._dynamicThumbUrl = api.getImageUrl(inner.Id, 'Primary', {
                                maxWidth,
                                quality,
                                tag: inner.ImageTags.Primary
                            });
                            break;
                        }
                    }
                } catch (e) {
                    log.warn(`Failed to fetch dynamic thumb for ${item.Name}`, e);
                }
            })
        );
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
        // These viewTypes always force landscape regardless of user view mode preference.
        const isLandscape =
            this.state.viewType === 'Episodes' ||
            this.state.viewType === 'Upcoming' ||
            this.state.viewType === 'Networks';

        // --------------------------------------------------------------------
        // Apply the view mode CSS modifier class to the grid container.
        // Special viewTypes (Episodes, Networks) are always landscape and ignore
        // the user's viewMode preference. For everything else we apply the mode.
        //
        // IMPORTANT: only apply classes for the 5 known picker modes. 'poster'
        // uses the base style (no extra class). Any unexpected value is silently
        // treated as 'poster' to avoid broken layouts from stale storage data.
        // --------------------------------------------------------------------
        const viewModeClasses = ['view-small-poster', 'view-thumb', 'view-banner', 'view-list'];
        viewModeClasses.forEach((cls) => grid.classList.remove(cls));
        grid.classList.remove('landscape');

        if (isLandscape) {
            // Force landscape display for tab types that mandate it
            grid.classList.add('view-thumb');
        } else {
            // The 4 non-default modes each get a CSS class; 'poster' uses base styles
            const nonDefaultModes = ['small-poster', 'thumb', 'banner', 'list'];
            if (nonDefaultModes.includes(this.state.viewMode)) {
                grid.classList.add(`view-${this.state.viewMode}`);
            }
            // Any unknown mode (e.g. stale 'square' from old storage) falls through to poster
        }

        /*
         * =========================================================================
         * DYNAMIC LAYOUT ENGINE RESOLUTION
         * =========================================================================
         * When Dynamic columns mode is enabled (and we are not in single-column List
         * view), we dynamically inject the CSS variables onto the grid node and
         * calculate the exact pixel width of each card.
         * =========================================================================
         */
        let cardWidth = null;
        if (this.state.gridMode === 'dynamic' && this.state.viewMode !== 'list') {
            grid.classList.add('mode-dynamic');
            grid.style.setProperty('--grid-columns', this.state.gridColumns);

            // Compute card width minus margins to feed ImageService parameters
            const containerWidth = grid.clientWidth || 1720;
            const columns = this.state.gridColumns || 5;
            const margin = 20; // Must align with --grid-card-margin in library.css
            cardWidth = Math.round((containerWidth - (columns - 1) * margin) / columns);
        } else {
            grid.classList.remove('mode-dynamic');
            grid.style.removeProperty('--grid-columns');
        }

        if (!items || items.length === 0) {
            grid.innerHTML = '';
            this.$('#empty-state').classList.remove('hidden');
            this.$('#count-indicator').textContent = i18n.t('ItemCount', [0]);
            this.$('#pagination-info').textContent = '';

            // Check if controls should be visible (logic matched with _updateHeaderVisibility)
            const collectionType = this.state.libraryInfo?.CollectionType;
            const viewType = this.state.viewType;
            const isMovieMain = collectionType === 'movies' && viewType === 'Items';
            const isTVMain = collectionType === 'tvshows' && viewType === 'Items';
            const isMusicMain =
                collectionType === 'music' &&
                (viewType === 'Albums' ||
                    viewType === 'Artists' ||
                    viewType === 'AlbumArtists' ||
                    viewType === 'Songs');
            const isCollections =
                (collectionType === 'boxsets' || collectionType === 'playlists') && viewType === 'Items';
            const isFolderMain = this.state.isFolderLibrary && viewType === 'Items';
            const isEpisodes = viewType === 'Episodes';
            // Do not show any header controls if we are deep linking to a specific genre/studio
            const shouldShowControls =
                isMovieMain ||
                isTVMain ||
                isMusicMain ||
                isEpisodes ||
                isCollections ||
                isFolderMain ||
                this._isSubView();

            const btnReset = this.$('#btn-reset-filters');
            if (btnReset) {
                btnReset.style.display = shouldShowControls ? '' : 'none';
            }

            const btnShuffle = this.$('#btn-shuffle');
            if (btnShuffle) {
                btnShuffle.style.display = shouldShowControls && !this._isSubView() ? '' : 'none';
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
                            !shouldShowControls || this.$('#alpha-picker-container')?.style.display === 'none'
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
                    if (
                        activeTabBtn &&
                        !this._isSubView() &&
                        (isTabsActive || !currentFocus || currentFocus === document.body)
                    ) {
                        log.info('Restoring focus to active tab:', this.state.viewType);
                        focusManager.setActiveSection('library-tabs');
                        activeTabBtn.focus();
                    } else if (this._isSubView() && (!currentFocus || currentFocus === document.body)) {
                        log.info('Sub-view empty loaded, focusing controls');
                        if (this.$('#library-controls')?.style.display !== 'none') {
                            focusManager.setActiveSection('library-controls');
                        } else {
                            focusManager.setActiveSection('sidebar');
                        }
                    } else if (!this._isSubView()) {
                        // Fallback to Sidebar if we really lost context and not in a sub-view
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
        this.$('#count-indicator').textContent = i18n.t('ListPaging', [start, end, this.state.totalRecordCount]);

        // Resolve card type based on the active view mode and library/tab context.
        // Special viewTypes (Episodes, Networks) always override the user preference.
        const resolvedCardType = this._resolveCardType(isLandscape);

        // ====================================================================
        // PROGRESSIVE DOM INSERTION
        // ====================================================================
        // PROBLEM: Rendering all 100 items at once puts 100 flex nodes into the
        // layout engine simultaneously. Even with lazy IMAGE loading, every
        // D-pad keypress forces a flexbox layout pass, style recalculation, and
        // compositor evaluation over all 100 nodes — this is what makes 100-item
        // libraries noticeably laggier than 25-item ones.
        //
        // SOLUTION: Render only the first visible chunk immediately, then append
        // more rows as the user navigates toward the bottom. The DOM stays at
        // ~25-35 items at any given time regardless of total library size.
        //
        // Chunk sizing: (columns × 5 rows) gives ~2 visible screens worth of content.
        // ====================================================================
        const columns = this.state.gridColumns || this._getDefaultColumnsForMode(
            isLandscape ? 'thumb' : this.state.viewMode
        );

        // Store rendering context + column count on state so _appendGridChunk
        // and _prependGridChunk can access them without re-deriving
        this.state._gridRenderContext = {
            isLandscape,
            resolvedCardType,
            cardWidth
        };
        this.state._gridColumns = columns;

        // Reset the sliding window — a fresh _renderGrid always starts from zero
        this.state.gridWindowStart = 0;
        this.state.gridWindowEnd = 0;
        this.state.gridCardRowHeight = null; // Force re-measure on next append

        // Clear the grid and inject the spacer that maintains scroll position
        // when top rows are evicted from the DOM. Height starts at 0px.
        grid.innerHTML = '<div id="grid-top-spacer" style="height:0;width:100%;flex:0 0 100%"></div>';

        // Render the first chunk immediately — this is what the user sees on load
        this._appendGridChunk(grid, items, columns);

        // Lazy Load Images (observe the initial chunk)
        lazyLoader.observe(grid);

        // Calculate expected alpha visibility (avoids DOM race conditions with _updateHeaderVisibility)
        const collectionType = this.state.libraryInfo?.CollectionType;
        const viewType = this.state.viewType;
        const isMovieMain = collectionType === 'movies' && viewType === 'Items';
        const isTVMain = collectionType === 'tvshows' && viewType === 'Items';
        const isMusicMain =
            collectionType === 'music' &&
            (viewType === 'Albums' || viewType === 'Artists' || viewType === 'AlbumArtists' || viewType === 'Songs');
        const isCollections = (collectionType === 'boxsets' || collectionType === 'playlists') && viewType === 'Items';
        const isFolderMain = this.state.isFolderLibrary && viewType === 'Items';
        const isEpisodes = viewType === 'Episodes';
        const isAlphaVisible =
            isMovieMain || isTVMain || isMusicMain || isEpisodes || isCollections || isFolderMain || this._isSubView();

        // Update Alpha Picker navigation to point to grid
        if (isAlphaVisible) {
            focusManager.register('alpha-picker', this.$('#alpha-picker'), {
                orientation: 'horizontal',
                leaveUp: 'library-controls',
                leaveDown: 'library-grid',
                leaveLeft: 'sidebar',
                enterTo: 'active-element'
            });
        }

        // Re-register focus for grid items
        const currentColumns =
            this.state.gridMode === 'dynamic' && this.state.viewMode !== 'list'
                ? this.state.gridColumns
                : this._getDefaultColumnsForMode(isLandscape ? 'thumb' : this.state.viewMode);

        focusManager.register('library-grid', grid, {
            orientation: 'grid',
            columns: currentColumns,
            leaveUp: isAlphaVisible ? 'alpha-picker' : 'library-controls',
            leaveDown: 'library-pagination',
            leaveLeft: 'sidebar',
            selector: '.media-card',
            scrollOffsetTop: 100
        });

        // ====================================================================
        // PROGRESSIVE DOM TRIGGER — focus:changed listener
        // ====================================================================
        // Fires after every focus change anywhere in the page. We filter to
        // cards inside the library-grid and check if we are close enough to
        // the bottom of the rendered DOM to warrant adding the next chunk.
        //
        // We replace any previous listener stored on the instance so that
        // re-renders (sort / filter change) don't accumulate duplicate handlers.
        // ====================================================================
        if (this._onGridFocusChanged) {
            eventBus.off('focus:changed', this._onGridFocusChanged);
        }
        this._onGridFocusChanged = (element) => {
            // Only act on media-cards inside this grid
            if (!element || !grid.contains(element)) return;
            if (!element.classList.contains('media-card')) return;

            // Find DOM index of the focused card (fast linear scan — window is small)
            const allCards = grid.querySelectorAll('.media-card');
            let domIndex = -1;
            for (let i = 0; i < allCards.length; i++) {
                if (allCards[i] === element) { domIndex = i; break; }
            }
            if (domIndex === -1) return;

            // The card's index in the full items array
            const itemIndex = this.state.gridWindowStart + domIndex;

            // -----------------------------------------------------------------------
            // DOWNWARD TRIGGER: within 2 rows of the bottom rendered boundary
            // -----------------------------------------------------------------------
            const appendThreshold = this.state.gridWindowEnd - (currentColumns * 2);
            if (itemIndex >= appendThreshold && this.state.gridWindowEnd < this.state.items.length) {
                this._appendGridChunk(grid, this.state.items, currentColumns);
            }

            // -----------------------------------------------------------------------
            // UPWARD TRIGGER: within 2 rows of the top rendered boundary
            // -----------------------------------------------------------------------
            const prependThreshold = this.state.gridWindowStart + (currentColumns * 2);
            if (itemIndex <= prependThreshold && this.state.gridWindowStart > 0) {
                this._prependGridChunk(grid, this.state.items, currentColumns);
            }
        };
        eventBus.on('focus:changed', this._onGridFocusChanged);

        // Register pagination footer — the grid's leaveDown points here.
        // Without this registration the section is a ghost and focus is silently
        // dropped when the user presses DOWN from the last grid row.
        focusManager.register('library-pagination', this.$('#library-pagination'), {
            orientation: 'horizontal',
            leaveUp: 'library-grid',
            leaveLeft: 'sidebar',
            selector: 'button:not(:disabled)',
            enterTo: 'default-element' // Land on first enabled (Prev or Next)
        });

        const hasTabs = this.$('#library-tabs')?.style.display !== 'none';
        this.registerFocusSection('library-controls', this.$('#library-controls'), {
            orientation: 'horizontal',
            leaveUp: hasTabs ? 'library-tabs' : null,
            leaveDown: isAlphaVisible ? 'alpha-picker' : 'library-grid',
            leaveLeft: 'sidebar',
            selector: 'button'
        });

        // Ensure focus goes to first element in grid if subview
        if (this._isSubView()) {
            requestAnimationFrame(() => {
                const currentFocus = document.activeElement;
                if (!currentFocus || currentFocus === document.body) {
                    const firstItem = grid.querySelector('.media-card');
                    if (firstItem) {
                        focusManager.setActiveSection('library-grid', false);
                        focusManager.focusElement(firstItem, { instantScroll: true });
                    }
                }
            });
        }
    }

    /**
     * =========================================================================
     * GRID CARD HTML GENERATOR (shared by append and prepend)
     * =========================================================================
     * Produces the HTML string for a slice of items[], using the render context
     * stored by _renderGrid so we don't re-derive card type / width / orientation.
     * @param {Array} items - Subset of the full items array to render
     * @returns {string} HTML string
     * =========================================================================
     */
    _buildGridChunkHtml(items) {
        const ctx = this.state._gridRenderContext || {};
        const isLandscape = ctx.isLandscape || false;
        const resolvedCardType = ctx.resolvedCardType || 'poster';
        const cardWidth = ctx.cardWidth || null;

        return items
            .map((item) =>
                CardRenderer.createCardHtml(item, {
                    isLandscape: isLandscape || this.state.viewMode === 'thumb' || this.state.viewMode === 'banner',
                    type: this.state.viewMode === 'banner' ? 'banner' : resolvedCardType,
                    contextType:
                        this.state.viewType === 'Upcoming'
                            ? 'upcoming'
                            : this.state.viewType === 'Albums'
                              ? 'music'
                              : 'library',
                    showMeta: !isLandscape && this.state.viewMode === 'list',
                    isGrid: true,
                    cardWidth: cardWidth
                })
            )
            .join('');
    }

    /**
     * =========================================================================
     * MEASURE GRID ROW HEIGHT (cached)
     * =========================================================================
     * Reads the vertical distance between the first and second card row by
     * comparing offsetTop values. Includes any CSS gap/margin automatically.
     * Result is cached in state.gridCardRowHeight so we only force layout once.
     * @param {HTMLElement} grid
     * @param {number} columns
     * @returns {number|null} Row height in px, or null if not yet measurable
     * =========================================================================
     */
    _measureGridRowHeight(grid, columns) {
        if (this.state.gridCardRowHeight) return this.state.gridCardRowHeight;

        const cards = grid.querySelectorAll('.media-card');
        // Need at least 2 full rows to calculate the difference
        if (cards.length < columns + 1) return null;

        // Row height = offsetTop delta between row 0 card 0 and row 1 card 0.
        // This naturally captures the card height + any CSS gap between rows.
        const rowHeight = cards[columns].offsetTop - cards[0].offsetTop;
        if (rowHeight > 0) {
            this.state.gridCardRowHeight = rowHeight;
        }
        return rowHeight || null;
    }

    /**
     * =========================================================================
     * HOOK NEW CARDS INTO LAZY LOADERS + FOCUS CACHE
     * =========================================================================
     * After inserting DOM nodes, register their images with the lazy image
     * observer and their shimmer wrappers with the shimmer pause observer.
     * Then invalidate the FocusManager cache so new cards become navigable.
     * @param {HTMLElement[]} newCards - Array of newly-inserted .media-card elements
     * =========================================================================
     */
    _hookGridCards(newCards) {
        if (!newCards || !newCards.length) return;

        newCards.forEach((card) => {
            const img = card.querySelector('img[data-src]');
            if (img) {
                lazyLoader.observeElement(img);
            }
            const shimmer = card.querySelector('.card-image.skeleton-shimmer');
            if (shimmer && lazyLoader._shimmerObserver) {
                lazyLoader._shimmerObserver.observe(shimmer);
            }
        });

        // Tell FocusManager about the new focusable nodes
        focusManager.invalidateCache('library-grid');

        // Prewarm ScrollController offset cache in the next idle frame
        requestAnimationFrame(() => {
            const pageContent = document.querySelector('.page-content');
            if (pageContent) {
                scrollController.prewarmOffsetCache(newCards, pageContent);
            }
        });
    }

    /**
     * =========================================================================
     * PROGRESSIVE GRID CHUNK APPENDER — with sliding window eviction
     * =========================================================================
     * Appends the next batch of cards at the BOTTOM of the rendered window.
     *
     * Window cap: when the DOM count exceeds MAX_WINDOW_ROWS, the oldest rows
     * at the top are removed and the top spacer div is grown by the same
     * pixel amount. Since the spacer occupies the same space in the flex layout
     * as the evicted cards, the scroll position stays perfectly stable.
     *
     * @param {HTMLElement} grid    - The #library-grid container element
     * @param {Array}       items   - Full items array
     * @param {number}      columns - Grid column count
     * @returns {boolean}           - true if more items remain after this chunk
     * =========================================================================
     */
    _appendGridChunk(grid, items, columns) {
        if (!grid || !items || !items.length) return false;

        const windowEnd = this.state.gridWindowEnd;

        // All items already rendered — nothing to do
        if (windowEnd >= items.length) return false;

        // -----------------------------------------------------------------------
        // CHUNK SIZE
        // -----------------------------------------------------------------------
        // First render: 5 rows — fills ~1.5 TV screens immediately.
        // Incremental: 3 rows — small enough not to spike layout, large enough
        // that the user can scroll a full screen before triggering another append.
        // -----------------------------------------------------------------------
        const INITIAL_ROWS = 5;
        const INCREMENTAL_ROWS = 3;
        // Maximum rows to keep in the DOM at once (8 rows = comfortable window)
        const MAX_WINDOW_ROWS = 8;

        const isFirstChunk = windowEnd === 0;
        const chunkSize = isFirstChunk ? columns * INITIAL_ROWS : columns * INCREMENTAL_ROWS;

        const chunkItems = items.slice(windowEnd, windowEnd + chunkSize);
        if (!chunkItems.length) return false;

        // Generate and append HTML for this chunk
        grid.insertAdjacentHTML('beforeend', this._buildGridChunkHtml(chunkItems));
        this.state.gridWindowEnd = windowEnd + chunkItems.length;

        // Hook new cards into observers and focus cache (skip for first chunk —
        // _renderGrid calls lazyLoader.observe(grid) separately for that case)
        if (!isFirstChunk) {
            const allCards = grid.querySelectorAll('.media-card');
            // The new cards are the last chunkItems.length entries
            const newCards = Array.from(allCards).slice(allCards.length - chunkItems.length);
            this._hookGridCards(newCards);
        }

        // -----------------------------------------------------------------------
        // WINDOW EVICTION — remove rows from the top once we exceed the cap
        // -----------------------------------------------------------------------
        const windowRows = Math.ceil((this.state.gridWindowEnd - this.state.gridWindowStart) / columns);

        if (windowRows > MAX_WINDOW_ROWS) {
            // Measure row height before evicting (cached after first call)
            const rowHeight = this._measureGridRowHeight(grid, columns);
            if (rowHeight) {
                // How many rows we are over the cap
                const rowsToEvict = windowRows - MAX_WINDOW_ROWS;
                const cardsToEvict = rowsToEvict * columns;

                // Remove the top N cards (they are directly after the spacer)
                const allCards = grid.querySelectorAll('.media-card');
                for (let i = 0; i < Math.min(cardsToEvict, allCards.length); i++) {
                    allCards[i].remove();
                }

                // Grow the spacer by exactly the height of the evicted rows.
                // This keeps the total scroll height and viewport position stable.
                this.state.gridWindowStart += cardsToEvict;
                const spacer = grid.querySelector('#grid-top-spacer');
                if (spacer) {
                    const newSpacerHeight = Math.floor(this.state.gridWindowStart / columns) * rowHeight;
                    spacer.style.height = `${newSpacerHeight}px`;
                }
            }
        }

        return this.state.gridWindowEnd < items.length;
    }

    /**
     * =========================================================================
     * PROGRESSIVE GRID CHUNK PREPENDER — for navigating back upward
     * =========================================================================
     * Adds rows at the TOP of the rendered window when the user navigates back
     * toward cards that were previously evicted from the DOM.
     *
     * Inserts new cards AFTER the spacer div so they appear visually above the
     * existing rendered cards. Shrinks the spacer by the same amount so scroll
     * position stays stable. Evicts rows from the bottom if the window cap is
     * exceeded.
     *
     * @param {HTMLElement} grid    - The #library-grid container element
     * @param {Array}       items   - Full items array
     * @param {number}      columns - Grid column count
     * @returns {boolean}           - true if more items remain above this chunk
     * =========================================================================
     */
    _prependGridChunk(grid, items, columns) {
        if (!grid || !items || !items.length) return false;

        const windowStart = this.state.gridWindowStart;

        // Nothing above the current window — already at the very top
        if (windowStart <= 0) return false;

        const INCREMENTAL_ROWS = 3;
        const MAX_WINDOW_ROWS = 8;

        const chunkSize = Math.min(columns * INCREMENTAL_ROWS, windowStart);
        const newStart = windowStart - chunkSize;

        const chunkItems = items.slice(newStart, windowStart);
        if (!chunkItems.length) return false;

        // Measure row height BEFORE modifying the DOM (cards are still in place)
        const rowHeight = this._measureGridRowHeight(grid, columns);

        // Insert the new cards after the spacer, before the first existing card
        const spacer = grid.querySelector('#grid-top-spacer');
        if (spacer) {
            spacer.insertAdjacentHTML('afterend', this._buildGridChunkHtml(chunkItems));
        }

        // Update window boundary
        this.state.gridWindowStart = newStart;

        // Shrink the spacer by exactly the height of the newly added rows.
        // This keeps the cards below the insertion point at the same pixel
        // offset from the top, so scrollTop doesn't need any adjustment.
        if (rowHeight && spacer) {
            const rowsAdded = Math.ceil(chunkSize / columns);
            const currentSpacerHeight = parseInt(spacer.style.height, 10) || 0;
            const newSpacerHeight = Math.max(0, currentSpacerHeight - rowsAdded * rowHeight);
            spacer.style.height = `${newSpacerHeight}px`;
        }

        // Register the new cards with observers
        const allCards = grid.querySelectorAll('.media-card');
        const newCards = Array.from(allCards).slice(0, chunkSize);
        this._hookGridCards(newCards);

        // -----------------------------------------------------------------------
        // WINDOW EVICTION from the bottom to maintain the cap
        // -----------------------------------------------------------------------
        const windowRows = Math.ceil((this.state.gridWindowEnd - this.state.gridWindowStart) / columns);
        if (windowRows > MAX_WINDOW_ROWS) {
            const rowsToEvict = windowRows - MAX_WINDOW_ROWS;
            const cardsToEvict = rowsToEvict * columns;

            // Remove the last N cards in the grid
            const updatedCards = grid.querySelectorAll('.media-card');
            const totalCards = updatedCards.length;
            for (let i = totalCards - 1; i >= totalCards - cardsToEvict && i >= 0; i--) {
                updatedCards[i].remove();
            }
            this.state.gridWindowEnd -= cardsToEvict;
        }

        return this.state.gridWindowStart > 0;
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
            container.style.flexDirection = 'column';
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
                        this.$('#count-indicator').textContent = i18n.t('NoItemsFound'); // Better message
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
        const isGenresView = this.state.viewType === 'Genres' || this.state.viewType === 'MusicGenres';
        const nextUpTarget = this._isSubView()
            ? null
            : isHorizontalLayout || isGenresView
              ? 'library-tabs'
              : 'library-controls';

        rows.forEach((row, rowIndex) => {
            const headerId = `header-${rowIndex}`;
            const listId = `list-${rowIndex}`;
            const rowId = `row-${rowIndex}`;

            const section = document.createElement('div');
            section.className = 'library-row media-row'; // media-row for FocusManager scroll detection
            section.id = rowId; // Ensure DOM carries the focus section ID
            section.dataset.index = rowIndex;
            section.dataset.genreId = row.genreId || '';

            // Focusable Header (clickable to navigate to genre page)
            // Only make focusable if it's actionable (has genreId)
            const isActionable = !!row.genreId;
            const headerHtml = isActionable
                ? `
                <div class="library-row-header" id="${headerId}">
                    <button class="header-focusable" tabindex="0" id="${row.genreId}" data-genre-id="${row.genreId}">
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

            // Use row-items (horizontal scroll) for Upcoming/Suggestions, genre-grid-items (grid) for Genres
            const isHorizontalRow = this.state.viewType === 'Upcoming' || this.state.viewType === 'Suggestions';

            // Grid Items (Max 12)
            const displayItems = (row.items || []).slice(0, 12);
            let contentHtml = '';

            if (displayItems.length > 0) {
                contentHtml = displayItems
                    .map((item) =>
                        // -----------------------------------------------------
                        // Static/Grid Card Rendering
                        // -----------------------------------------------------
                        // If this is a static vertical sub-grid (like a Genre list
                        // under the Genres tab), we set 'isGrid: true' (which is
                        // !isHorizontalRow) so cards render safely without
                        // expanding transitions. For horizontal slider rows
                        // (Upcoming/Suggestions), we leave 'isGrid: false' so they
                        // can expand beautifully.
                        // -----------------------------------------------------
                        CardRenderer.createCardHtml(item, {
                            isLandscape: row.isLandscape || false,
                            type: row.cardType || 'poster',
                            contextType: row.contextType || null,
                            isGrid: !isHorizontalRow
                        })
                    )
                    .join('');
            } else {
                contentHtml = '<div class="empty-msg">No items</div>';
            }

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
                    cardType: row.cardType || 'poster',
                    visibleCount: row.isLandscape ? 8 : 12,
                    // Eagerly render the first several cards so the row is navigable
                    // immediately when focused rather than building nodes on first keypress.
                    // 5 for landscape (wider cards), 7 for portrait.
                    initialWindow: row.isLandscape ? 5 : Math.min(7, displayItems.length),
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

            this.registerFocusSection(rowId, section, {
                orientation: orientation,
                columns: 6, // Only used for grid orientation
                // Navigation between rows
                leaveUp: rowIndex === 0 ? nextUpTarget : `row-${rowIndex - 1}`,
                leaveDown: rowIndex < rows.length - 1 ? `row-${rowIndex + 1}` : 'library-pagination',
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
            this.registerFocusSection('alpha-picker', this.$('#alpha-picker'), {
                orientation: 'horizontal',
                leaveUp: this._isSubView() ? null : 'library-controls',
                leaveDown: 'row-0',
                leaveLeft: 'sidebar',
                enterTo: 'active-element'
            });

            // Update library-controls to point to first row
            this.registerFocusSection('library-controls', this.$('#library-controls'), {
                orientation: 'horizontal',
                leaveUp: this._isSubView() ? null : 'library-tabs',
                leaveDown: 'row-0', // Direct to first row for Genres view
                leaveLeft: 'sidebar',
                selector: 'button'
            });

            // Update library-tabs to point to first row directly when controls hidden
            this.registerFocusSection('library-tabs', this.$('#library-tabs'), {
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
            } else if (collectionType === 'musicvideos') {
                includeItemTypes = 'MusicVideo';
            }

            const result = await api.getItems({
                ParentId: this.state.libraryId,
                GenreIds: genreId,
                Limit: 10,
                Fields: 'ProductionYear',
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
                    // ==========================================================
                    // Sub-Grid Item Rendering
                    // ==========================================================
                    // These genre category row items are rendered as a vertical grid
                    // (.genre-grid-items), so they must use isGrid: true to avoid
                    // horizontal expansions that would overlap column siblings.
                    // ==========================================================
                    CardRenderer.createCardHtml(item, {
                        isLandscape: false, // Genres usually mix, but mostly posters
                        type: 'poster',
                        isGrid: true
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

        // CRITICAL: Clear sub-view parameters when switching top-level tabs
        // This prevents _isSubView() from erroneously hiding tabs or filtering results
        const subViewParams = ['genreId', 'studioId', 'personId', 'tagName', 'year'];
        let hasChanges = false;

        subViewParams.forEach((p) => {
            if (this.params[p]) {
                delete this.params[p];
                hasChanges = true;
            }
        });

        // Sync URL to new top-level tab state if we escaped a sub-view
        if (hasChanges) {
            log.info(`Cleared sub-view parameters for tab switch: ${newType}`);
            router.navigate(`/library/${this.state.libraryId}`, { silent: true, replace: true });
        }

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
            this.state.nameStartsWith = char; // Store literal char ('#', 'A', etc.)
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

    _handleGridClick(e, cardElement) {
        const card = cardElement || e.target.closest('.media-card');
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

        // Special handling for Photos: open Slideshow
        if (card.dataset.type === 'Photo') {
            log.info('Navigating to Slideshow:', itemId);
            const parentArg = this.params.id || this.state.libraryId;
            router.navigate(
                `/slideshow/${itemId}?parentId=${parentArg}&sortBy=${this.state.sortBy}&sortOrder=${this.state.sortOrder}`
            );
            return;
        }

        // Special handling for PhotoAlbums: navigate to standard LibraryPage
        if (card.dataset.type === 'PhotoAlbum') {
            log.info('Navigating into PhotoAlbum:', itemId);
            router.navigate(`/library/${itemId}`);
            return;
        }

        // Special handling for Folders: navigate to sub-library
        if (card.dataset.type === 'Folder' || card.dataset.type === 'CollectionFolder') {
            log.info('Navigating into folder:', itemId);
            router.navigate(`/library/${itemId}`);
            return;
        }

        // Special handling for Persons and Artists: navigate to the unified PersonPage
        const itemType = card.dataset.type;
        if (
            itemType === 'Person' ||
            itemType === 'MusicArtist' ||
            itemType === 'Artist' ||
            itemType === 'AlbumArtist'
        ) {
            log.debug('Navigating to PersonPage:', itemId);
            router.navigate(`/person/${itemId}`);
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
            // Fallback if empty, check if controls are visible
            if (this.$('#library-controls')?.style.display !== 'none') {
                this.setActiveSection('library-controls');
            } else {
                this.setActiveSection('library-grid');
            }
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
            } else if (collectionType === 'music') {
                const viewType = this.state.viewType;
                if (viewType === 'Artists' || viewType === 'AlbumArtists') {
                    includeItemTypes = 'MusicArtist';
                } else if (viewType === 'Albums') {
                    includeItemTypes = 'MusicAlbum';
                } else if (viewType === 'Songs') {
                    includeItemTypes = 'Audio';
                } else {
                    includeItemTypes = 'Audio,MusicAlbum';
                }
            } else if (collectionType === 'musicvideos') {
                includeItemTypes = 'MusicVideo';
            }

            const params = {
                ParentId: this.state.libraryId,
                Limit: 1,
                SortBy: 'Random',
                Recursive: true,
                IncludeItemTypes: includeItemTypes,
                ExcludeLocationTypes: 'Virtual'
            };

            // Apply active filters to shuffle (fixes shuffle "ignoring" current view/alpha filter)
            if (this.state.nameStartsWith) {
                params.NameStartsWith = this.state.nameStartsWith;
            }

            const result = await api.getItems(params);

            if (result.Items && result.Items.length > 0) {
                const item = result.Items[0];
                this._saveState('library-controls', 'btn-shuffle');
                router.navigate(`/details/${item.Id}`);
            } else {
                log.warn('No items found for shuffle');
            }
        } catch (e) {
            log.error('Failed to fetch random item', e);
        }
    }

    _updateControlsVisibility() {
        // Shuffle button is available except for Episodes view or when in a sub-view
        const btnShuffle = this.$('#btn-shuffle');
        if (btnShuffle) {
            const isEpisodes = this.state.viewType === 'Episodes';
            btnShuffle.style.display = isEpisodes || this._isSubView() ? 'none' : '';
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

        // ------------------------------------------------------------------
        // Persist the clean state to local storage.
        // Clearing persisted filters prevents old selections from lingering.
        // ------------------------------------------------------------------
        if (!this._isSubView()) {
            const filtersKey = `pref:library:filters:${this.state.libraryId}`;
            storage.removeItem(filtersKey);
        }

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
                { label: 'OptionRandom', value: 'Random' },
                { label: 'CommunityRating', value: 'CommunityRating,SortName' },
                { label: 'OptionDateShowAdded', value: 'DateCreated,SortName' },
                { label: 'OptionDateEpisodeAdded', value: 'DateLastContentAdded,SortName' },
                { label: 'OptionDatePlayed', value: 'SeriesDatePlayed,SortName' },
                { label: 'OptionParentalRating', value: 'OfficialRating,SortName' },
                { label: 'OptionReleaseDate', value: 'PremiereDate,SortName' }
            ];
        } else if (this.state.libraryInfo?.CollectionType === 'music') {
            // Music Specific Options
            sortOptions = [
                { label: 'Name', value: 'SortName' },
                { label: 'OptionRandom', value: 'Random' },
                { label: 'Artist', value: 'Artist,SortName' },
                { label: 'Album', value: 'Album,SortName' },
                { label: 'OptionPlayCount', value: 'PlayCount,SortName' },
                { label: 'CommunityRating', value: 'CommunityRating,SortName' },
                { label: 'OptionDateAdded', value: 'DateCreated,SortName' },
                { label: 'OptionDatePlayed', value: 'DatePlayed,SortName' },
                { label: 'OptionReleaseDate', value: 'ProductionYear,PremiereDate,SortName' },
                { label: 'Runtime', value: 'Runtime,SortName' }
            ];
        } else {
            // Standard / Movie Options
            sortOptions = [
                { label: 'Name', value: 'SortName' },
                { label: 'OptionRandom', value: 'Random' },
                { label: 'CommunityRating', value: 'CommunityRating,SortName' },
                { label: 'CriticRating', value: 'OptionCriticRating,SortName' },
                { label: 'OptionDateAdded', value: 'DateCreated,SortName' },
                { label: 'OptionDatePlayed', value: 'DatePlayed,SortName' },
                { label: 'OptionParentalRating', value: 'OfficialRating,SortName' },
                { label: 'OptionPlayCount', value: 'PlayCount,SortName' },
                { label: 'OptionReleaseDate', value: 'ProductionYear,PremiereDate,SortName' },
                { label: 'Runtime', value: 'Runtime,SortName' }
            ];
        }

        this._renderSortModal(sortOptions, orderOptions);
    }

    // ========================================================================
    // View Mode Picker
    // ========================================================================

    /**
     * Open the view mode picker modal.
     * Not available for subviews or forced-landscape viewTypes.
     */
    _handleViewMode() {
        // View mode picker has no meaning for horizontal row layouts or special tabs
        const isHorizontalLayout =
            this.state.viewType === 'Genres' ||
            this.state.viewType === 'MusicGenres' ||
            this.state.viewType === 'Suggestions' ||
            this.state.viewType === 'Upcoming';

        if (isHorizontalLayout) return;
        this._renderViewModeModal();
    }

    _renderViewModeModal() {
        const overlay = this.$('#modal-overlay');
        if (!overlay) return;

        // Save focus context so we can restore it on close
        this._prevFocus = focusManager.getFocused();
        this._prevSection = focusManager.getActiveSection();

        const current = this.state.viewMode;
        let tempMode = current;
        let tempGridMode = this.state.gridMode;
        let tempColumns = this.state.gridColumns;

        const colOptionsMap = {
            poster: [4, 5, 6, 7],
            'small-poster': [6, 8, 10, 12],
            thumb: [3, 4, 5, 6],
            banner: [2, 3, 4, 5]
        };

        const getColumnsHtml = (mode, currentVal) => {
            const opts = colOptionsMap[mode] || [];
            return opts
                .map(
                    (c) => `
                <button class="tab-btn column-option-btn ${c === currentVal ? 'active' : ''}" data-cols="${c}" tabindex="0">
                    ${c} ${i18n.t('Items') || 'Items'}
                </button>
            `
                )
                .join('');
        };

        const modes = [
            {
                value: 'poster',
                label: 'ViewModePoster',
                fallback: 'Poster',
                icon: `<svg viewBox="0 0 24 24" fill="none" class="vm-icon" stroke="currentColor" stroke-width="1.8">
                    <rect x="2" y="2" width="9" height="12" rx="1"/>
                    <rect x="13" y="2" width="9" height="12" rx="1"/>
                    <rect x="2" y="16" width="9" height="6" rx="1" opacity="0.4"/>
                    <rect x="13" y="16" width="9" height="6" rx="1" opacity="0.4"/>
                </svg>`
            },
            {
                value: 'small-poster',
                label: 'ViewModeSmallPoster',
                fallback: 'Small',
                icon: `<svg viewBox="0 0 24 24" fill="none" class="vm-icon" stroke="currentColor" stroke-width="1.8">
                    <rect x="3" y="4" width="5" height="7" rx="1"/>
                    <rect x="9.5" y="4" width="5" height="7" rx="1"/>
                    <rect x="16" y="4" width="5" height="7" rx="1"/>
                    <rect x="3" y="13" width="5" height="7" rx="1"/>
                    <rect x="9.5" y="13" width="5" height="7" rx="1"/>
                    <rect x="16" y="13" width="5" height="7" rx="1"/>
                </svg>`
            },
            {
                value: 'thumb',
                label: 'ViewModeThumb',
                fallback: 'Thumbs',
                icon: `<svg viewBox="0 0 24 24" fill="none" class="vm-icon" stroke="currentColor" stroke-width="1.8">
                    <rect x="2" y="3" width="20" height="11" rx="1"/>
                    <rect x="2" y="16" width="20" height="6" rx="1" opacity="0.4"/>
                </svg>`
            },
            {
                value: 'banner',
                label: 'ViewModeBanner',
                fallback: 'Banner',
                icon: `<svg viewBox="0 0 24 24" fill="none" class="vm-icon" stroke="currentColor" stroke-width="1.8">
                    <rect x="2" y="3" width="20" height="5" rx="1"/>
                    <rect x="2" y="10" width="20" height="5" rx="1"/>
                    <rect x="2" y="17" width="20" height="5" rx="1"/>
                </svg>`
            },
            {
                value: 'list',
                label: 'ViewModeList',
                fallback: 'List',
                icon: `<svg viewBox="0 0 24 24" fill="none" class="vm-icon" stroke="currentColor" stroke-width="1.8">
                    <rect x="7" y="3" width="15" height="4" rx="1"/>
                    <rect x="7" y="10" width="15" height="4" rx="1"/>
                    <rect x="7" y="17" width="15" height="4" rx="1"/>
                    <rect x="2" y="3" width="3.5" height="4" rx="0.5"/>
                    <rect x="2" y="10" width="3.5" height="4" rx="0.5"/>
                    <rect x="2" y="17" width="3.5" height="4" rx="0.5"/>
                </svg>`
            }
        ];

        const updateModalUI = () => {
            const hasGridOptions = tempMode !== 'list';
            const secGridMode = overlay.querySelector('#section-grid-mode');
            const secCols = overlay.querySelector('#section-columns');

            if (secGridMode) secGridMode.style.display = hasGridOptions ? 'block' : 'none';

            if (secCols) {
                if (hasGridOptions && tempGridMode === 'dynamic') {
                    secCols.style.display = 'block';
                    const colsContainer = overlay.querySelector('#columns-options');
                    if (colsContainer) {
                        colsContainer.innerHTML = getColumnsHtml(tempMode, tempColumns);

                        // Bind events on new column buttons
                        colsContainer.querySelectorAll('.column-option-btn').forEach((btn) => {
                            btn.addEventListener('click', () => {
                                tempColumns = parseInt(btn.dataset.cols, 10);
                                colsContainer.querySelectorAll('.column-option-btn').forEach((b) => {
                                    b.classList.toggle('active', parseInt(b.dataset.cols, 10) === tempColumns);
                                });
                            });
                        });
                    }
                } else {
                    secCols.style.display = 'none';
                }
            }

            // Re-register focus sections as size/visibility changed
            registerFocusSections();
        };

        const registerFocusSections = () => {
            this.registerFocusSection('view-mode-options', overlay.querySelector('#view-mode-options'), {
                orientation: 'horizontal',
                leaveDown: tempMode !== 'list' ? 'grid-mode-options' : 'vm-actions',
                leaveUp: 'vm-actions',
                selector: '.view-mode-option-btn',
                enterTo: 'active-element'
            });

            if (tempMode !== 'list') {
                this.registerFocusSection('grid-mode-options', overlay.querySelector('#grid-mode-options'), {
                    orientation: 'horizontal',
                    leaveUp: 'view-mode-options',
                    leaveDown: tempGridMode === 'dynamic' ? 'columns-options' : 'vm-actions',
                    selector: '.grid-mode-btn',
                    enterTo: 'active-element'
                });

                if (tempGridMode === 'dynamic') {
                    this.registerFocusSection('columns-options', overlay.querySelector('#columns-options'), {
                        orientation: 'horizontal',
                        leaveUp: 'grid-mode-options',
                        leaveDown: 'vm-actions',
                        selector: '.column-option-btn',
                        enterTo: 'active-element'
                    });
                }
            }

            this.registerFocusSection('vm-actions', overlay.querySelector('#vm-actions'), {
                orientation: 'horizontal',
                leaveUp:
                    tempMode === 'list'
                        ? 'view-mode-options'
                        : tempGridMode === 'dynamic'
                          ? 'columns-options'
                          : 'grid-mode-options',
                selector: 'button'
            });
        };

        overlay.innerHTML = `
            <div class="library-modal view-mode-modal" style="width: 800px; max-width: 90%; max-height: 85vh; padding: 30px;">
                <h2 class="modal-title" style="margin-bottom: 20px;">${i18n.t('ViewMode')}</h2>
                
                <!-- Layout Style Category Section -->
                <div class="view-mode-section" style="margin-bottom: 25px;">
                    <h3 class="section-subtitle" style="font-size: 1.2rem; opacity: 0.7; margin-bottom: 12px;">Layout Style</h3>
                    <div class="view-mode-options" id="view-mode-options" style="display: flex; gap: 10px; margin-bottom: 10px;">
                        ${modes
                            .map(
                                (m) => `
                            <button class="view-mode-option-btn ${m.value === tempMode ? 'selected' : ''}"
                                    data-mode="${m.value}"
                                    tabindex="0">
                                <span class="vm-icon-wrap">${m.icon}</span>
                                <span class="vm-label">${i18n.t(m.label)}</span>
                            </button>
                        `
                            )
                            .join('')}
                    </div>
                </div>

                <!-- Grid Mode Toggle (Static vs Dynamic) -->
                <div class="view-mode-section" id="section-grid-mode" style="margin-bottom: 25px; display: ${tempMode !== 'list' ? 'block' : 'none'};">
                    <h3 class="section-subtitle" style="font-size: 1.2rem; opacity: 0.7; margin-bottom: 12px;">Sizing Mode</h3>
                    <div class="grid-mode-options" id="grid-mode-options" style="display: flex; gap: 10px; margin-bottom: 10px;">
                        <button class="tab-btn grid-mode-btn ${tempGridMode === 'static' ? 'active' : ''}" data-gmode="static" tabindex="0">Static Columns</button>
                        <button class="tab-btn grid-mode-btn ${tempGridMode === 'dynamic' ? 'active' : ''}" data-gmode="dynamic" tabindex="0">Dynamic Columns</button>
                    </div>
                </div>

                <!-- Dynamic Columns Options Selector -->
                <div class="view-mode-section" id="section-columns" style="margin-bottom: 25px; display: ${tempMode !== 'list' && tempGridMode === 'dynamic' ? 'block' : 'none'};">
                    <h3 class="section-subtitle" style="font-size: 1.2rem; opacity: 0.7; margin-bottom: 12px;">Items Per Row</h3>
                    <div class="columns-options" id="columns-options" style="display: flex; gap: 10px; margin-bottom: 10px;">
                        <!-- Generated Dynamically -->
                    </div>
                </div>

                <div class="modal-actions-library" id="vm-actions" style="margin-top: 30px; display: flex; justify-content: flex-end; gap: 15px;">
                    <button class="modal-action-btn close" id="btn-vm-close">${i18n.t('ButtonClose')}</button>
                    <button class="modal-action-btn apply" id="btn-vm-apply" !important;">${i18n.t('ButtonApply') || 'Apply'}</button>
                </div>
            </div>
        `;

        overlay.classList.remove('hidden');
        overlay.classList.add('visible');
        overlay.setAttribute('aria-hidden', 'false');

        // Style/Mode Button Listeners
        overlay.querySelectorAll('.view-mode-option-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                tempMode = btn.dataset.mode;
                overlay.querySelectorAll('.view-mode-option-btn').forEach((b) => {
                    b.classList.toggle('selected', b.dataset.mode === tempMode);
                });

                // When switching modes, check if we need to load columns default value
                const defaultCols = this._getDefaultColumnsForMode(tempMode);
                const colsKey = `pref:library:gridColumns:${this.state.libraryId}:${tempMode}`;
                const savedCols = parseInt(storage.getItem(colsKey), 10);
                tempColumns = !isNaN(savedCols) ? savedCols : defaultCols;

                updateModalUI();
            });
        });

        overlay.querySelectorAll('.grid-mode-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                tempGridMode = btn.dataset.gmode;
                overlay.querySelectorAll('.grid-mode-btn').forEach((b) => {
                    b.classList.toggle('active', b.dataset.gmode === tempGridMode);
                });
                updateModalUI();
            });
        });

        // Initialize UI
        updateModalUI();

        // Close / Apply Buttons
        this.$('#btn-vm-close')?.addEventListener('click', () => this._closeModal());

        this.$('#btn-vm-apply')?.addEventListener('click', () => {
            // Apply all states
            this.state.viewMode = tempMode;
            this.state.gridMode = tempGridMode;
            this.state.gridColumns = tempColumns;

            // Persist to local storage
            storage.setItem(`pref:library:viewMode:${this.state.libraryId}`, tempMode);
            storage.setItem(`pref:library:gridMode:${this.state.libraryId}`, tempGridMode);
            storage.setItem(`pref:library:gridColumns:${this.state.libraryId}:${tempMode}`, tempColumns);

            // Re-render and reload grid content
            this._renderGrid(this.state.items);
            this._closeModal();

            log.info(
                `[ViewMode] Applied configuration: Mode=${tempMode}, Grid=${tempGridMode}, Columns=${tempColumns}`
            );
        });

        // Set initial focus to Style Row
        setTimeout(() => {
            const selected =
                overlay.querySelector('.view-mode-option-btn.selected') ||
                overlay.querySelector('.view-mode-option-btn');
            if (selected) focusManager.focusElement(selected);
        }, 50);
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
                        <h2 class="modal-title" data-i18n="HeaderSortBy">${i18n.t('HeaderSortBy')}</h2>
                        <div class="modal-options">
                            ${sortOptions
                                .map(
                                    (opt) => `
                                <button class="modal-option-btn radio-btn ${opt.value === currentSort ? 'selected' : ''}" 
                                        data-type="sort" 
                                        data-value="${opt.value}"
                                        tabindex="0">
                                    <div class="radio-icon"></div>
                                    <span data-i18n="${opt.label}">${i18n.t(opt.label)}</span>
                                </button>
                            `
                                )
                                .join('')}
                        </div>
                    </div>

                    <!-- Sort Order Column -->
                    <div class="sort-column" id="sort-order-col">
                        <h2 class="modal-title" data-i18n="HeaderSortOrder">${i18n.t('HeaderSortOrder')}</h2>
                        <div class="modal-options">
                            ${orderOptions
                                .map(
                                    (opt) => `
                                <button class="modal-option-btn radio-btn ${opt.value === currentOrder ? 'selected' : ''}" 
                                        data-type="order" 
                                        data-value="${opt.value}"
                                        tabindex="0">
                                    <div class="radio-icon"></div>
                                    <span data-i18n="${opt.label}">${i18n.t(opt.label)}</span>
                                </button>
                            `
                                )
                                .join('')}
                        </div>
                    </div>
                </div>

                <div class="modal-actions-library">
                    <button class="modal-action-btn close" id="btn-sort-close" data-i18n="ButtonClose">${i18n.t('ButtonClose')}</button>
                    <button class="modal-action-btn apply" id="btn-sort-apply" data-i18n="ButtonApply">${i18n.t('ButtonApply')}</button>
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

            if (!this._isSubView()) {
                storage.setItem(`pref:library:sortBy:${this.state.libraryId}`, tempSortBy);
                storage.setItem(`pref:library:sortOrder:${this.state.libraryId}`, tempSortOrder);
            }

            // Explicitly trigger reload
            await this._loadItems();

            this._closeModal();
        });

        this.$('#btn-sort-close')?.addEventListener('click', () => {
            this._closeModal();
        });

        // Register Sections
        this.registerFocusSection('sort-by-col', overlay.querySelector('#sort-by-col'), {
            orientation: 'vertical',
            leaveUp: 'sort-actions',
            leaveLeft: 'sort-actions',
            leaveRight: 'sort-order-col',
            leaveDown: 'sort-actions'
        });

        this.registerFocusSection('sort-order-col', overlay.querySelector('#sort-order-col'), {
            orientation: 'vertical',
            leaveUp: 'sort-actions',
            leaveLeft: 'sort-by-col',
            leaveRight: 'sort-actions',
            leaveDown: 'sort-actions'
        });

        this.registerFocusSection('sort-actions', overlay.querySelector('.modal-actions-library'), {
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
            else if (type === 'tvshows') includeItemTypes = 'Series';
            else if (type === 'music') includeItemTypes = 'MusicArtist,MusicAlbum,Audio';
        }

        const params = {
            ParentId: this.state.parentId ? this.state.parentId : this.state.libraryId,
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

        const isMusic = this.state.libraryInfo?.CollectionType === 'music';

        // Sections Definition
        const sections = [
            {
                title: 'Filters',
                id: 'sec-filters',
                items: [
                    { label: 'Played', key: 'IsPlayed', type: 'boolean' },
                    { label: 'Unplayed', key: 'IsUnplayed', type: 'boolean' },
                    { label: 'OptionResumable', key: 'IsResumable', type: 'boolean' },
                    { label: 'Favorites', key: 'IsFavorite', type: 'boolean' }
                ]
            },
            {
                title: 'Features',
                id: 'sec-features',
                hidden: isMusic, // Hide video features for music
                items: [
                    { label: 'Subtitles', key: 'HasSubtitles', type: 'boolean' },
                    { label: 'Trailer', key: 'HasTrailer', type: 'boolean' },
                    { label: 'SpecialFeatures', key: 'HasSpecialFeature', type: 'boolean' },
                    { label: 'ThemeSong', key: 'HasThemeSong', type: 'boolean' },
                    { label: 'ThemeVideo', key: 'HasThemeVideo', type: 'boolean' }
                ]
            },
            {
                title: 'Genres',
                id: 'sec-genres',
                itemKey: 'Genres', // Key in state
                items: data.Genres.map((g) => ({ label: g, value: g, type: 'multi' }))
            },
            {
                title: 'HeaderParentalRatings',
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
                title: 'HeaderVideoTypes',
                id: 'sec-videotypes',
                hidden: isMusic, // Hide video types for music
                itemKey: 'VideoTypes', // Comma list
                items: [
                    { label: 'OptionBluray', value: 'Bluray', type: 'multi' },
                    { label: 'OptionDvd', value: 'Dvd', type: 'multi' },
                    { label: 'Option4K', key: 'Is4K', type: 'boolean' },
                    { label: 'OptionIsHD', key: 'IsHD', type: 'boolean' },
                    { label: 'OptionIsSD', key: 'IsSD', type: 'boolean' },
                    { label: 'Option3D', key: 'Is3D', type: 'boolean' }
                ]
            },
            {
                title: 'HeaderYears',
                id: 'sec-years',
                itemKey: 'Years',
                items: data.Years.map((y) => ({ label: y.toString(), value: y.toString(), type: 'multi' }))
            }
        ];

        // Filter out empty and hidden sections
        const validSections = sections.filter((s) => s.items.length > 0 && !s.hidden);

        // Active Category State (Default to first)
        let activeSectionId = this.state.activeFilterSection || validSections[0].id;
        // Ensure active section is valid
        if (!validSections.find((s) => s.id === activeSectionId)) {
            activeSectionId = validSections[0].id;
        }

        // Render HTML Structure
        const html = `
            <div class="library-modal filter-modal split-view">
                <h2 class="modal-title" data-i18n="Filters">${i18n.t('Filters')}</h2>
                <div class="filter-split-container">
                    <!-- Left Sidebar -->
                    <div class="filter-sidebar" id="filter-sidebar">
                        ${validSections
                            .map(
                                (s) => `
                            <button class="filter-category-btn ${s.id === activeSectionId ? 'active' : ''}" 
                                    data-id="${s.id}" tabindex="0"
                                    data-i18n="${s.title}">
                                ${i18n.t(s.title)}
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

                <div class="modal-actions-library">
                    <button class="modal-action-btn clear" id="btn-filter-clear" data-i18n="ButtonClear">${i18n.t('ButtonClear')}</button>
                    <button class="modal-action-btn close" id="btn-filter-close" data-i18n="ButtonClose">${i18n.t('ButtonClose')}</button>
                    <button class="modal-action-btn apply" id="btn-filter-apply" data-i18n="ButtonApply">${i18n.t('ButtonApply')}</button>
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
                                <span class="btn-label" data-i18n="${item.label}">${i18n.t(item.label)}</span>
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
                this.registerFocusSection('filter-items', container, {
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
            this.registerFocusSection('filter-items', container, {
                orientation: 'grid', // Switch to grid for side-by-side items
                leaveLeft: 'filter-sidebar',
                leaveRight: 'filter-actions', // Restore Right -> Apply jump
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

            // ------------------------------------------------------------------
            // Remove the persisted filter configuration since user cleared all.
            // ------------------------------------------------------------------
            if (!this._isSubView()) {
                const filtersKey = `pref:library:filters:${this.state.libraryId}`;
                storage.removeItem(filtersKey);
            }

            renderItems(this.state.activeFilterSection);
        });

        this.$('#btn-filter-apply').addEventListener('click', async () => {
            this.state.startIndex = 0;

            // ------------------------------------------------------------------
            // Persist the newly selected filters.
            // We stringify the filters object and store it locally so the active
            // filters are remembered across reloads and pages.
            // ------------------------------------------------------------------
            if (!this._isSubView()) {
                const filtersKey = `pref:library:filters:${this.state.libraryId}`;
                storage.setItem(filtersKey, JSON.stringify(this.state.filters));
            }

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
        this.registerFocusSection('filter-sidebar', overlay.querySelector('.filter-sidebar'), {
            orientation: 'vertical',
            leaveUp: 'filter-actions',
            leaveRight: 'filter-items',
            leaveLeft: 'filter-actions',
            leaveDown: 'filter-actions',
            selector: '.filter-category-btn',
            scroll: true // Enable automatic scrolling for TV navigation
        });

        this.registerFocusSection('filter-actions', overlay.querySelector('.modal-actions-library'), {
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
                <button class="modal-close-btn" id="modal-close" data-i18n="ButtonClose">${i18n.t('ButtonClose')}</button>
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
        this.registerFocusSection('library-modal', this.$('.library-modal'), {
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

        // Unregister all specific modal sections (sort AND view mode picker)
        focusManager.unregister('library-modal');
        focusManager.unregister('sort-by-col');
        focusManager.unregister('sort-order-col');
        focusManager.unregister('sort-actions');
        focusManager.unregister('modal-close-btn');
        focusManager.unregister('view-mode-options');
        focusManager.unregister('vm-actions');
        focusManager.unregister('filter-col');
        focusManager.unregister('filter-actions');
        focusManager.unregister('filter-close-btn');

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

        // Condition: only show for Movies (Items), TV Shows (Items), Episodes, and music grid views
        const isMovieMain = collectionType === 'movies' && viewType === 'Items';
        const isTVMain = collectionType === 'tvshows' && viewType === 'Items';
        const isEpisodes = viewType === 'Episodes';
        const isMusicMain =
            collectionType === 'music' &&
            (viewType === 'Albums' ||
                viewType === 'Artists' ||
                viewType === 'AlbumArtists' ||
                viewType === 'Songs' ||
                viewType === 'Playlists');

        const isCollections = (collectionType === 'boxsets' || collectionType === 'playlists') && viewType === 'Items';

        // Home Videos, Music Videos, and Photos often use 'Folders' or 'Videos' or 'Photos' viewType
        const isFolderLikeMain =
            (collectionType === 'homevideos' || collectionType === 'musicvideos' || collectionType === 'photos') &&
            (viewType === 'Folders' || viewType === 'Videos' || viewType === 'Photos' || viewType === 'Items');

        const isFolderMain =
            (this.state.isFolderLibrary || collectionType === 'folders') &&
            (viewType === 'Items' || viewType === 'Folders');

        const shouldShow =
            isMovieMain || isTVMain || isEpisodes || isMusicMain || isCollections || isFolderMain || isFolderLikeMain;

        const isSubView = this._isSubView();
        const isSubFolder = this.state.isSubFolder;

        // Controls and Alpha Picker should be visible in main views, sub-views (Genre/Person),
        // or when navigating into sub-folders.
        const isControlsVisible = shouldShow || isSubView || isSubFolder;
        const isAlphaVisible = shouldShow || isSubView || isSubFolder;

        const isCollectionsLike = collectionType === 'boxsets' || collectionType === 'playlists';
        const isTabsVisible = !isCollectionsLike && !isSubView;

        const controls = this.$('#library-controls');
        const controlsRow = this.$('.library-controls-row');
        const alphaPicker = this.$('#alpha-picker-container');
        const tabsContainer = this.$('#library-tabs');

        if (controlsRow) controlsRow.style.display = isControlsVisible ? 'flex' : 'none';
        if (alphaPicker) alphaPicker.style.display = isAlphaVisible ? 'flex' : 'none';

        // 1. Configure Tabs (if visible)
        if (tabsContainer && isTabsVisible) {
            let nextTarget = 'library-grid';
            if (isControlsVisible) nextTarget = 'library-controls';
            else if (
                viewType === 'Genres' ||
                viewType === 'MusicGenres' ||
                viewType === 'Suggestions' ||
                viewType === 'Upcoming'
            )
                nextTarget = 'row-0';

            const tabsConfig = focusManager.getSectionConfig('library-tabs');
            if (tabsConfig) {
                this.registerFocusSection('library-tabs', tabsContainer, {
                    ...tabsConfig,
                    leaveDown: nextTarget
                });
            }
        }

        // 2. Configure Controls (if visible)
        if (controls && isControlsVisible) {
            const controlsConfig = focusManager.getSectionConfig('library-controls');
            if (controlsConfig) {
                // Determine what's below controls... if alpha isn't there, are we on a horizontal row page or a grid page?
                let controlsLeaveDown = 'library-grid';
                if (isAlphaVisible) {
                    controlsLeaveDown = 'alpha-picker';
                } else if (
                    viewType === 'Genres' ||
                    viewType === 'MusicGenres' ||
                    viewType === 'Suggestions' ||
                    viewType === 'Upcoming'
                ) {
                    controlsLeaveDown = 'row-0';
                }

                this.registerFocusSection('library-controls', controls, {
                    ...controlsConfig,
                    leaveUp: isTabsVisible ? 'library-tabs' : 'sidebar', // sidebar if top
                    leaveDown: controlsLeaveDown
                });
            }
        }

        // 3. Configure Alpha Picker (if visible)
        if (alphaPicker && isAlphaVisible) {
            const alphaConfig = focusManager.getSectionConfig('alpha-picker');
            if (alphaConfig) {
                let alphaLeaveDown = 'library-grid';
                if (
                    viewType === 'Genres' ||
                    viewType === 'MusicGenres' ||
                    viewType === 'Suggestions' ||
                    viewType === 'Upcoming'
                ) {
                    alphaLeaveDown = 'row-0';
                }

                this.registerFocusSection('alpha-picker', alphaPicker, {
                    ...alphaConfig,
                    leaveUp: isControlsVisible ? 'library-controls' : isTabsVisible ? 'library-tabs' : 'sidebar',
                    leaveDown: alphaLeaveDown
                });
            }
        }

        // 4. Configure Grid (always present, but visibility varies)
        const gridConfig = focusManager.getSectionConfig('library-grid');
        if (gridConfig) {
            let gridLeaveUp = 'sidebar'; // Fallback to sidebar if isolated
            if (isAlphaVisible) gridLeaveUp = 'alpha-picker';
            else if (isControlsVisible) gridLeaveUp = 'library-controls';
            else if (isTabsVisible) gridLeaveUp = 'library-tabs';

            this.registerFocusSection('library-grid', this.$('#library-grid'), {
                ...gridConfig,
                leaveUp: gridLeaveUp,
                leaveDown: gridConfig.leaveDown || 'library-pagination'
            });

            // Re-register pagination here too — ensures it's always wired
            // in case the state-restore path runs without a full _renderGrid call.
            this.registerFocusSection('library-pagination', this.$('#library-pagination'), {
                orientation: 'horizontal',
                leaveUp: 'library-grid',
                leaveLeft: 'sidebar',
                selector: 'button:not(:disabled)',
                enterTo: 'default-element'
            });
        }
    }
}

export default LibraryPage;
