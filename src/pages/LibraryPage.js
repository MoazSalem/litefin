/**
 * ============================================================================
 * Litefin Tizen - Library Page
 * ============================================================================
 * Advanced grid view with tabs, sorting, filtering, and alpha-picker.
 * ============================================================================
 */

// Page-scoped styles - loads with this module's chunk instead of the boot bundle
import '../styles/library.css';
import '../styles/library_rows.css';

import Page from './Page.js';
import { api } from '../api/index.js';
import { router } from '../core/Router.js';
import { focusManager } from '../ui/FocusManager.js';
import { layoutManager } from '../ui/LayoutManager.js';
import { scrollController } from '../ui/ScrollController.js';
import CardRenderer from '../utils/CardRenderer.js';
import { imageService } from '../utils/ImageService.js';
import { imageCache } from '../utils/ImageCache.js';
import { VirtualCardRow } from '../components/VirtualCardRow.js';
import { lazyLoader } from '../utils/LazyLoader.js';
import { logger } from '../utils/Logger.js';
import { i18n } from '../utils/i18n.js';
import { state } from '../core/StateManager.js';
import { storage } from '../utils/StorageService.js';
import { eventBus } from '../core/EventBus.js';
import { seerr } from '../api/seerrClient.js';
import {
    getGenreNameById,
    getStudioNameById,
    getNetworkNameById,
    MOVIE_GENRES_FALLBACK,
    TV_GENRES_FALLBACK,
    SEERR_LANGUAGES,
    SEERR_MOVIE_CERTIFICATIONS,
    SEERR_TV_CERTIFICATIONS
} from '../utils/seerrGenres.js';

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
            isInfinite: storage.getItem('pref:libraryPageSize') === 'unlimited',
            limit:
                storage.getItem('pref:libraryPageSize') === 'unlimited'
                    ? 100
                    : parseInt(storage.getItem('pref:libraryPageSize') || 50, 10),
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
            // Initialize view mode with user-configured global default (fallback to 'poster')
            viewMode: storage.getItem('pref:defaultLibraryViewMode') || 'poster',
            gridMode: 'dynamic',
            // Default column count resolved dynamically from configured default
            gridColumns: 7
        };

        // Bindings
        this._onTabClick = this._handleTabClick.bind(this);
        this._onAlphaClick = this._handleAlphaClick.bind(this);
        this._onPageChange = this._handlePageChange.bind(this);
        this._onGridClick = this._handleGridClick.bind(this);

        // Alphabet quick-jump sequence token and offset cache (Unlimited Scroll Mode)
        this._scrollLetterSeq = 0;
        this._letterOffsetCache = new Map();

        // Mark as async page for Navigation State
        // (Page.init won't restore scroll/focus until we call restoreScrollFocusWhenReady)
        this._isAsyncPage = true;

        // Restoration guard flag: suppresses reactive grid eviction and scroll calculations
        // while the saved focus position and DOM window boundaries are settling
        this._isRestoringFocus = false;

        // Lifecycle destruction tracking flag
        this._isDestroyed = false;

        // Progressive image chunk loading state for low-limit grids (< 60 items)
        this._idleChunkId = null;
        this._idleChunkType = null;

        // Debounce timer and navigation timestamp for decoupled image pre-warming
        this._preWarmTimer = null;
        this._lastGridNavTime = 0;

        // In-memory set of pre-warmed image URLs to prevent duplicate in-flight network requests
        this._preWarmedUrls = new Set();
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
                        
                        <!-- Infinite Scroll Loader -->
                        <div class="infinite-scroll-loader hidden" id="infinite-scroll-loader">
                            <div class="infinite-spinner"></div>
                            <span class="infinite-loader-text" data-i18n="LoadingMore">${i18n.t('LoadingMore') || 'Loading more items...'}</span>
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
        // Supported grid column options map for each distinct layout mode
        const colOptionsMap = {
            poster: [4, 5, 6, 7],
            'small-poster': [8, 9, 10, 12],
            thumb: [3, 4, 5, 6],
            banner: [2, 3, 4, 5],
            list: [1]
        };

        // Check if user has explicitly saved a default column preference for this layout mode
        const savedModeCols = parseInt(storage.getItem(`pref:defaultLibraryGridColumns:${mode}`), 10);
        const validOpts = colOptionsMap[mode] || [];
        if (validOpts.includes(savedModeCols)) {
            return savedModeCols;
        }

        // Check generic global default column setting if the target mode matches the active default view mode
        const defaultViewMode = storage.getItem('pref:defaultLibraryViewMode') || 'poster';
        if (mode === defaultViewMode) {
            const genericSavedCols = parseInt(storage.getItem('pref:defaultLibraryGridColumns'), 10);
            if (validOpts.includes(genericSavedCols)) {
                return genericSavedCols;
            }
        }

        // Fall back to native Litefin standard static column counts
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
                return 7;
        }
    }

    /**
     * ANDROID PORTRAIT column override (portrait-only; landscape/TV untouched).
     * On a scaled Android portrait viewport the 750px design canvas is far too
     * narrow for the TV column counts (7 poster columns => ~61px cards with
     * unreadable titles). Return phone-appropriate column counts so posters
     * render large and the page scrolls vertically instead. Returns null on
     * every other platform and on landscape viewports, so callers keep the
     * stock values and landscape rendering is byte-identical.
     * @param {string} mode - Grid view mode ('poster', 'thumb', ...)
     * @returns {number|null} Portrait column count, or null to keep stock.
     * @private
     */
    /**
     * Single source of truth for the effective dynamic-grid column count.
     * Used by _renderGrid, the chunk-size computation, AND the Android
     * portrait rotation handler, so every consumer always agrees.
     * Reproduces the stock resolution (user preference > forced-landscape
     * thumb > default-per-mode) and then applies the ANDROID PORTRAIT
     * override, which returns null for landscape viewports so stock values
     * pass through untouched.
     * @param {string} viewMode - Current grid view mode
     * @returns {number} Effective column count for the current viewport.
     * @private
     */
    _resolveDynamicGridColumns(viewMode) {
        const isForcedLandscape =
            this.state.viewType === 'Episodes' ||
            this.state.viewType === 'Upcoming' ||
            this.state.viewType === 'Networks' ||
            this.params.includeItemTypes === 'Episode';
        const effectiveMode = isForcedLandscape ? 'thumb' : viewMode;
        let columns = this.state.gridColumns;
        if (isForcedLandscape && viewMode !== 'thumb') {
            const isSeerr = this.state.libraryId === 'seerr' || this.state.libraryInfo?.CollectionType === 'seerr';
            const savedThumbCols = parseInt(
                storage.getItem(
                    isSeerr ? 'pref:seerr:gridColumns:thumb' : `pref:library:gridColumns:${this.state.libraryId}:thumb`
                ),
                10
            );
            columns = !isNaN(savedThumbCols) ? savedThumbCols : this._getDefaultColumnsForMode('thumb');
        } else if (!columns) {
            columns = this._getDefaultColumnsForMode(effectiveMode);
        }
        // ANDROID PORTRAIT: phone column counts on the scaled portrait canvas
        // (bigger posters, vertical scrolling). Landscape viewports return
        // null here — every stock value passes through unchanged.
        const portraitCols = this._getPortraitColumnOverride(effectiveMode);
        if (portraitCols) columns = portraitCols;
        return columns;
    }

    /**
     * ANDROID PORTRAIT rotation handler. The --grid-columns custom property
     * is computed once at render time, so rotating the device would leave
     * the grid sized for the previous orientation. Re-renders the grid from
     * cached items (no refetch) — but ONLY when the effective column count
     * for the current viewport actually differs. TVs never fire resize
     * events and unscaled viewports resolve stock counts, so this is a
     * no-op everywhere except a scaled Android viewport that rotated.
     * @private
     */
    _onViewportColumnsChanged() {
        try {
            const grid = this.$('#library-grid');
            if (!grid || !grid.classList.contains('mode-dynamic')) return;
            if (!this.state.items || this.state.items.length === 0) return;
            const expected = this._resolveDynamicGridColumns(this.state.viewMode);
            const current = parseInt(grid.style.getPropertyValue('--grid-columns'), 10);
            if (!isNaN(current) && expected && expected !== current) {
                this._renderGrid(this.state.items);
            }
        } catch (e) {
            log.warn('Grid rotation re-render failed:', e);
        }
    }

    _getPortraitColumnOverride(mode) {
        try {
            // Only the Android shell sets data-litefin-scaled (display scaling)
            if (!document.documentElement.hasAttribute('data-litefin-scaled')) return null;
            // Landscape viewports keep stock column counts
            if (window.innerWidth >= window.innerHeight) return null;
            switch (mode) {
                case 'poster':
                    return 3;
                case 'small-poster':
                    return 4;
                case 'thumb':
                    return 2;
                case 'banner':
                    return 2;
                default:
                    return null; // 'list' and unknown modes untouched
            }
        } catch (_) {
            return null;
        }
    }

    // ========================================================================
    // Lifecycle
    // ========================================================================

    async onInit() {
        this._navigatedPath = router.getCurrentPath();
        this.setLoading(true);

        // ANDROID PORTRAIT: re-resolve grid columns when the viewport rotates.
        // Self-limiting — a no-op on TVs/unscaled viewports (see handler).
        this._boundViewportColumnsChanged = this._onViewportColumnsChanged.bind(this);
        window.addEventListener('resize', this._boundViewportColumnsChanged, { passive: true });

        // Reset alphabet quick-jump offset cache on fresh library load
        this._scrollLetterSeq = 0;
        this._letterOffsetCache = new Map();
        this._letterOffsetCache.set('#', 0);
        this.state.libraryId = this.params.id;

        // Special handling for 'virtual' library IDs (e.g. 'all' for search expansion, 'seerr' for Seerr discovery)
        const isVirtualLibrary = this.state.libraryId === 'all';
        const isSeerrLibrary = this.state.libraryId === 'seerr';

        if (this.params.char) {
            this.state.nameStartsWith = decodeURIComponent(this.params.char);
        }

        if (this.params.page) {
            const pageNum = parseInt(this.params.page, 10);
            if (!isNaN(pageNum) && pageNum > 0) {
                const pageLimit = isSeerrLibrary ? 100 : this.state.limit;
                this.state.startIndex = (pageNum - 1) * pageLimit;
            }
        }

        if (isSeerrLibrary) {
            const rawMediaType = this.params.mediaType || (this.params.seerrType === 'network' ? 'tv' : 'movie');
            const mediaType =
                rawMediaType === 'tv' || rawMediaType === 'series' || rawMediaType === 'tvshows' ? 'tv' : 'movie';
            let seerrTitle = this.params.name ? decodeURIComponent(this.params.name) : '';
            const gId = this.params.genreId || this.params.genre;
            if (!seerrTitle) {
                const sId = this.params.studioId || this.params.studio;
                const nId = this.params.networkId || this.params.network;
                if (gId) seerrTitle = getGenreNameById(gId, mediaType) || i18n.t('HeaderGenre') || 'Genre';
                else if (sId) seerrTitle = getStudioNameById(sId) || i18n.t('HeaderStudio') || 'Studio';
                else if (nId) seerrTitle = getNetworkNameById(nId) || i18n.t('Network') || 'Network';
                else seerrTitle = i18n.t('Discover') || 'Discover';
            }
            if (gId && !this.state.filters.genre) {
                this.state.filters.genre = gId.toString();
            }
            this.state.libraryInfo = {
                Name: seerrTitle,
                CollectionType: 'seerr'
            };
            this.$('#library-title').textContent = seerrTitle;
            this.title = seerrTitle;
        } else if (!isVirtualLibrary) {
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

        // --------------------------------------------------------------------
        // ACTIVE PAGE SIZE SETTING VALIDATION
        // Resolve the active page limit and infinite pagination settings from
        // storage so we can detect configuration changes made in Settings.
        // --------------------------------------------------------------------
        const activePageSize = storage.getItem('pref:libraryPageSize');
        const activeIsInfinite = activePageSize === 'unlimited';
        const activeLimit = activeIsInfinite ? 100 : parseInt(activePageSize, 10) || 50;

        // State Rehydration Check
        // Priority 1: Check memory state cache for full rehydration
        let savedState = state.get(cacheKey);

        // Invalidate stale memory cache if limit or infinite pagination mode has changed
        if (savedState && savedState.stateData) {
            const cachedLimit = savedState.stateData.limit;
            const cachedIsInfinite = savedState.stateData.isInfinite;
            // Detect if limit or mode was modified while away from this page
            if (cachedLimit !== activeLimit || cachedIsInfinite !== activeIsInfinite) {
                log.info(
                    `Invalidating cached library state due to limit mismatch: cached=${cachedLimit} (infinite=${cachedIsInfinite}) vs active=${activeLimit} (infinite=${activeIsInfinite})`
                );
                state.delete(cacheKey);
                savedState = null;
            }
        }

        // Priority 2: Fallback to items restored via navigation history
        // If the route was restored or re-entered and items were preserved in state,
        // construct a synthetic savedState so the page rehydrates instead of dropping lazy-loaded items
        if (!savedState && this.state.items && this.state.items.length > 0) {
            // Verify navigation items match current page size configuration
            if (this.state.limit === activeLimit && this.state.isInfinite === activeIsInfinite) {
                // Extract target item ID from CSS selector if present (e.g. data-item-id="...")
                let fallbackItemId = null;
                if (this._pendingNavState?.focusElementSelector) {
                    const match = this._pendingNavState.focusElementSelector.match(/data-(?:item-)?id="([^"]+)"/);
                    fallbackItemId = match ? match[1] : this._pendingNavState.focusElementSelector.replace(/^#/, '');
                }

                savedState = {
                    stateData: this.state,
                    focusSectionId: this._pendingNavState?.focusSectionName || 'library-grid',
                    focusItemId: fallbackItemId
                };
            } else {
                // Discard stale item collection if page limit setting changed
                log.info(
                    `Discarding navigation-restored items due to limit mismatch: restored=${this.state.limit} vs active=${activeLimit}`
                );
                this.state.items = [];
                this.state.totalRecordCount = 0;
                this.state.limit = activeLimit;
                this.state.isInfinite = activeIsInfinite;
            }
        }

        if (savedState) {
            // Merge cached state properties
            Object.assign(this.state, savedState.stateData);
            this._reportMusicContext();

            // Restore the server query context. This path bypasses _loadItems(),
            // which is the only place it is built, and letter jumps / infinite
            // batch fetching both depend on it.
            if (savedState.lastFetchContext) {
                this._lastFetchContext = savedState.lastFetchContext;
            }

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

            // Alphabet selector position updates are bound centrally in _bindEvents()

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

            // ------------------------------------------------------------------
            // Keep loading overlay active during focus restoration so the user
            // does not see an intermediate focus snap or jump from page top.
            // ------------------------------------------------------------------

            // 3. Restore Focus
            // Mark restoration active so intermediate scroll events and layout shifts
            // do not trigger eviction or window sync before focus has landed
            this._isRestoringFocus = true;

            requestAnimationFrame(() => {
                let restoredFocus = false;
                const targetId = storage.getItem('pref:disableFocusRestore') === 'true' ? null : savedState.focusItemId;
                const sectionId =
                    storage.getItem('pref:disableFocusRestore') === 'true' ? null : savedState.focusSectionId;

                if (targetId && sectionId) {
                    const sectionConfig = focusManager.getSectionConfig(sectionId);
                    const sectionContainer = sectionConfig ? sectionConfig.container : this.el;

                    // Ensure the target item AND forward buffer rows ahead of it
                    // are fully rendered into the DOM so the screen below the focused
                    // card is populated rather than blank.
                    const itemIndex = this._ensureGridWindowEncompassesItem(targetId);

                    // For horizontal media rows (Suggestions / Upcoming), ensure target item and forward buffer are rendered
                    const virtualTrack = sectionContainer ? sectionContainer.querySelector('.row-items-track') : null;
                    if (virtualTrack && virtualTrack.__virtualRow) {
                        virtualTrack.__virtualRow.ensureItemRendered(targetId);
                    }

                    // =========================================================================
                    // TWO-PHASE LAYOUT FLUSH (TIZEN / WEBKIT DOM SETTLE)
                    // =========================================================================
                    // When cards are injected via insertAdjacentHTML, WebKit has not calculated
                    // their layout geometries (offsetParent, offsetTop, and bounding rects).
                    // Calling focusElement in the same tick causes ScrollController to read an
                    // offsetTop of 0, instantly snapping scrollTop to 0 and triggering bottom
                    // eviction in _syncGridWindow, destroying the target card.
                    // A second requestAnimationFrame flushes layout so geometry is 100% stable.
                    // =========================================================================
                    requestAnimationFrame(() => {
                        const savedElement = sectionContainer.querySelector(
                            `[data-item-id="${targetId}"], [data-id="${targetId}"], [id="${targetId}"]`
                        );

                        if (savedElement) {
                            this.setActiveSection(sectionId, false);
                            focusManager.focusElement(savedElement, { instantScroll: true });
                            restoredFocus = true;
                        }

                        // If element was not found in DOM, fallback to standard section setup
                        if (!restoredFocus) {
                            this._setupFocus();
                        }

                        // Evict state entry once consumed to prevent stale reapplications
                        state.delete(cacheKey);
                        this._pendingNavState = null;

                        // Reveal page and remove loading overlay once focus has securely landed
                        this.setLoading(false);
                        this.markReady();

                        // Release restoration guard on the following frame once layout has stabilized
                        requestAnimationFrame(() => {
                            this._isRestoringFocus = false;
                            // Synchronize sliding window and alphabet position to newly focused item
                            if (itemIndex >= 0) {
                                const grid = this.$('#library-grid');
                                const columns = this.state._gridColumns || 7;
                                const currentRow = Math.floor(itemIndex / columns);
                                this._syncGridWindow(grid, this.state.items, columns, currentRow, itemIndex);
                            }
                        });
                    });
                    return;
                }

                if (!restoredFocus) {
                    this._setupFocus();
                }

                state.delete(cacheKey);
                this._pendingNavState = null;
                this.setLoading(false);
                this.markReady();
                this._isRestoringFocus = false;
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
            // Seerr virtual libraries resolve titles locally and must not call api.getItem()
            if (this.state.libraryId === 'seerr' || this.state.libraryInfo?.CollectionType === 'seerr') {
                return;
            }

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
            } else if (this.params.parentId && this.state.libraryId === 'all') {
                try {
                    // Resolve parent item title (e.g. Season 1 or Album) for deep-linked virtual library views
                    const parentItem = await api.getItem(this.params.parentId);
                    if (parentItem && parentItem.Name) {
                        const fullTitle = parentItem.SeriesName
                            ? `${parentItem.SeriesName} - ${parentItem.Name}`
                            : parentItem.Name;
                        this.$('#library-title').textContent = fullTitle;
                        this.title = fullTitle;
                        if (this.state.libraryInfo) {
                            this.state.libraryInfo.Name = fullTitle;
                        }
                    }
                } catch (e) {
                    log.warn('Failed to fetch parent info for virtual library title', e);
                }
            }
        })();

        // Run title resolution and item loading simultaneously. viewType is already set
        // above synchronously, so _loadItems() is guaranteed to see the correct value.
        await Promise.all([infoFetchPromise, this._loadItems()]);
        this._reportMusicContext();

        // If router provided pending navigation state (cache miss or fallback),
        // restore scroll/focus via NavigationState instead of blindly resetting to top.
        if (this._pendingNavState) {
            // Expand grid window to include target item and forward buffer rows
            const pending = this._pendingNavState;
            let targetId = null;
            if (pending.focusElementSelector) {
                const match = pending.focusElementSelector.match(/data-(?:item-)?id="([^"]+)"/);
                targetId = match ? match[1] : pending.focusElementSelector.replace(/^#/, '');
            }
            if (targetId && (pending.focusSectionName === 'library-grid' || !pending.focusSectionName)) {
                this._ensureGridWindowEncompassesItem(targetId, pending.focusElementIndex);
            } else if (targetId && pending.focusSectionName) {
                // Check if target section is a horizontal virtual row
                const sectionConfig = focusManager.getSectionConfig(pending.focusSectionName);
                const sectionContainer = sectionConfig ? sectionConfig.container : this.el;
                const virtualTrack = sectionContainer ? sectionContainer.querySelector('.row-items-track') : null;
                if (virtualTrack && virtualTrack.__virtualRow) {
                    virtualTrack.__virtualRow.ensureItemRendered(targetId);
                }
            }

            this.restoreScrollFocusWhenReady();
            // Safety fallback timer: guarantees loading overlay is unhidden if restoration
            // is skipped or takes unexpectedly long on slow network/hardware
            this._focusRestoreSafetyTimeout = setTimeout(() => {
                this.setLoading(false);
            }, 1000);
        } else {
            this._setupFocus();
            this.setLoading(false);
        }

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

        // Listen for dynamic alphabet selector position updates from settings
        if (!this._onAlphaPickerPositionChanged) {
            this._onAlphaPickerPositionChanged = () => {
                this._renderAlphaPicker();
                this._updateNavigation();
            };
            eventBus.on('alphaPickerPosition:changed', this._onAlphaPickerPositionChanged);
        }

        // Listen for dynamic library page size / unlimited infinite pagination changes
        if (!this._onLibraryPageSizeChanged) {
            this._onLibraryPageSizeChanged = (newSize) => {
                log.info(`Dynamic library page size update received: ${newSize}`);
                const isInfinite = newSize === 'unlimited';
                this.state.isInfinite = isInfinite;
                this.state.limit = isInfinite ? 100 : parseInt(newSize, 10) || 50;
                this.state.startIndex = 0;
                this.state.items = [];
                // Clear cached snapshot for this specific library view
                state.delete(this._getCacheKey());
                this._loadItems();
            };
            eventBus.on('pref:libraryPageSize', this._onLibraryPageSizeChanged);
            eventBus.on('pref:libraryPageSize:changed', this._onLibraryPageSizeChanged);
        }

        // Listen for dynamic alphabet quick-jump scroll mode toggles
        if (!this._onAlphaPickerScrollModeChanged) {
            this._onAlphaPickerScrollModeChanged = () => {
                this.state.scrollAlphaChar = null;
                this._renderAlphaPicker();
            };
            eventBus.on('pref:alphaPickerScrollMode:changed', this._onAlphaPickerScrollModeChanged);
        }

        // ---------------------------------------------------------------------
        // Dynamic Global Default Library View Mode & Columns Preference Listener
        // ---------------------------------------------------------------------
        // When user modifies default view mode or default items per row in Settings,
        // re-evaluate the active library layout ONLY if this library does not have
        // a custom view mode explicitly configured by the user.
        // ---------------------------------------------------------------------
        if (!this._onDefaultLibraryViewModeChanged) {
            this._onDefaultLibraryViewModeChanged = () => {
                log.info('Default library view layout preference changed in settings');

                // Determine whether current library or tab has an explicit custom preference
                const isTabSpecific = Boolean(this.state.viewType && this.state.viewType !== 'Items');
                const isSeerr = this.state.libraryId === 'seerr' || this.state.libraryInfo?.CollectionType === 'seerr';
                const tabStorageKey = isTabSpecific
                    ? `pref:library:viewMode:${this.state.libraryId}:${this.state.viewType}`
                    : null;
                const libStorageKey = isSeerr ? 'pref:seerr:viewMode' : `pref:library:viewMode:${this.state.libraryId}`;
                const hasCustomViewMode = Boolean(
                    (tabStorageKey && storage.getItem(tabStorageKey)) || storage.getItem(libStorageKey)
                );

                // If no custom view mode is set for this library, rehydrate and re-render grid
                if (!hasCustomViewMode) {
                    this._loadPersistedViewMode();
                    if (this.state.items && this.state.items.length > 0) {
                        this._renderGrid(this.state.items);
                    }
                }
            };
            eventBus.on('pref:defaultLibraryViewMode:changed', this._onDefaultLibraryViewModeChanged);
            eventBus.on('pref:defaultLibraryGridColumns:changed', this._onDefaultLibraryViewModeChanged);
        }

        // =========================================================================
        // BACKGROUND AND SCREEN SLEEP LIFECYCLE HANDLERS
        // =========================================================================
        // When the TV turns off the screen or the app is sent to the background,
        // save the full library state (including all lazy-loaded batches and active focus)
        // so that returning does not leave the collection incomplete.
        if (!this._onAppHidden) {
            this._onAppHidden = () => {
                const focused = focusManager.getFocused();
                const sectionId = focusManager.getSectionForElement(focused);
                const focusItemId = focused?.dataset?.itemId || focused?.id || null;
                this._saveState(sectionId, focusItemId);
            };
            eventBus.on('app:hidden', this._onAppHidden);
        }

        // Re-affirm active focus when returning to foreground / waking from sleep
        if (!this._onAppVisible) {
            this._onAppVisible = () => {
                const current = focusManager.getFocused();
                if (!current || !document.contains(current)) {
                    this._setupFocus();
                }
            };
            eventBus.on('app:visible', this._onAppVisible);
        }

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
        if (this.params.parentId) parts.push(`parent:${this.params.parentId}`);
        if (this.params.includeItemTypes) parts.push(`types:${this.params.includeItemTypes}`);
        if (this.params.genreId) parts.push(`genre:${this.params.genreId}`);
        if (this.params.studioId) parts.push(`studio:${this.params.studioId}`);
        if (this.params.networkId) parts.push(`network:${this.params.networkId}`);
        if (this.params.year) parts.push(`year:${this.params.year}`);
        if (this.params.personId) parts.push(`person:${this.params.personId}`);
        if (this.params.tagName) parts.push(`tag:${this.params.tagName}`);
        if (this.params.searchTerm) parts.push(`search:${this.params.searchTerm}`);
        if (this.params.viewModeIndex !== undefined) parts.push(`vmIdx:${this.params.viewModeIndex}`);
        if (this.params.viewMode) parts.push(`vm:${this.params.viewMode}`);
        // Fall back to state.nameStartsWith if route params have not been synced yet
        const char = this.params.char || this.state?.nameStartsWith;
        if (char) parts.push(`char:${char}`);
        if (this.params.page) parts.push(`page:${this.params.page}`);
        return parts.join(':');
    }

    _saveState(focusSectionId, focusItemId) {
        if (storage.getItem('pref:disableLibraryCache') === 'true') return;
        state.set(this._getCacheKey(), {
            stateData: this.state,
            focusSectionId: storage.getItem('pref:disableFocusRestore') === 'true' ? null : focusSectionId,
            focusItemId: storage.getItem('pref:disableFocusRestore') === 'true' ? null : focusItemId,
            lastFetchContext: this._lastFetchContext
        });
    }

    // ========================================================================
    // Navigation State (for back navigation restoration)
    // ========================================================================

    /**
     * Get page state for navigation history.
     * Saves filters, sort, pagination, tab selection, view mode, grid sizing config,
     * and loaded items for seamless infinite scroll restoration.
     */
    getNavigationState() {
        // Persist full library state into state manager cache prior to navigation
        const focused = focusManager.getFocused();
        const sectionId = focusManager.getSectionForElement(focused);
        const focusItemId = focused?.dataset?.itemId || focused?.id || null;
        this._saveState(sectionId, focusItemId);

        return {
            viewType: this.state.viewType,
            sortBy: this.state.sortBy,
            sortOrder: this.state.sortOrder,
            filters: { ...this.state.filters }, // Clone object
            nameStartsWith: this.state.nameStartsWith,
            startIndex: this.state.startIndex,
            limit: this.state.limit,
            isInfinite: this.state.isInfinite,
            viewMode: this.state.viewMode,
            gridMode: this.state.gridMode,
            gridColumns: this.state.gridColumns,
            // Preserve loaded media items and total count across router navigation
            items: this.state.items ? [...this.state.items] : null,
            totalRecordCount: this.state.totalRecordCount,
            // Keep the active server query so letter jumps keep working after back navigation
            lastFetchContext: this._lastFetchContext
        };
    }

    /**
     * Restore page state from navigation history.
     * Applied BEFORE content loads, so _loadItems uses these values.
     */
    setNavigationState(savedState) {
        if (!savedState) return;

        // --------------------------------------------------------------------
        // ACTIVE SETTING MISMATCH CHECK
        // If the user modified the library items limit in Settings while away,
        // we must not restore stale item arrays or obsolete page limits.
        // --------------------------------------------------------------------
        const activePageSize = storage.getItem('pref:libraryPageSize');
        const activeIsInfinite = activePageSize === 'unlimited';
        const activeLimit = activeIsInfinite ? 100 : parseInt(activePageSize, 10) || 50;

        const limitMismatch =
            savedState.limit != null &&
            (savedState.limit !== activeLimit || savedState.isInfinite !== activeIsInfinite);

        // Merge saved state into current state
        // This will be used when _loadItems() is called in onInit()
        Object.assign(this.state, {
            viewType: savedState.viewType || this.state.viewType,
            sortBy: savedState.sortBy || this.state.sortBy,
            sortOrder: savedState.sortOrder || this.state.sortOrder,
            filters: savedState.filters || {},
            nameStartsWith: savedState.nameStartsWith || null,
            startIndex: limitMismatch ? 0 : savedState.startIndex || 0,
            limit: activeLimit,
            isInfinite: activeIsInfinite,
            // Restore view mode and column layouts from nav state
            viewMode: savedState.viewMode || this.state.viewMode,
            gridMode: savedState.gridMode || this.state.gridMode,
            gridColumns: savedState.gridColumns || this.state.gridColumns
        });

        // Restore loaded item collection ONLY if limit configuration has not changed
        if (!limitMismatch && savedState.items && savedState.items.length > 0) {
            this.state.items = savedState.items;
            this.state.totalRecordCount = savedState.totalRecordCount || savedState.items.length;
        } else if (limitMismatch) {
            log.info(
                `Discarding restored items in setNavigationState due to limit mismatch (${savedState.limit} vs ${activeLimit})`
            );
            this.state.items = [];
            this.state.totalRecordCount = 0;
        }

        // Restore query context for infinite scrolling and letter jump calculation
        if (!limitMismatch && savedState.lastFetchContext) {
            this._lastFetchContext = savedState.lastFetchContext;
        }

        log.info('Navigation state restored:', savedState);
    }

    /**
     * =========================================================================
     * SCROLL / FOCUS RESTORATION COMPLETION HOOK
     * =========================================================================
     * Invoked by NavigationState after scroll offset has been synchronized and
     * focus has landed securely on the restored target item.
     *
     * By releasing the loading overlay here instead of at the end of data fetch,
     * the intermediate state (where focus temporarily rests at the top of the
     * page before snapping to the restored item) remains completely hidden.
     * =========================================================================
     */
    onScrollFocusRestored() {
        // Clear safety fallback timer since restoration completed normally
        if (this._focusRestoreSafetyTimeout) {
            clearTimeout(this._focusRestoreSafetyTimeout);
            this._focusRestoreSafetyTimeout = null;
        }

        // Release pending navigation state reference
        this._pendingNavState = null;

        // Reveal page layout now that focus has securely landed on target item
        this.setLoading(false);
    }

    destroy() {
        super.destroy();

        // ANDROID PORTRAIT: viewport rotation handler
        if (this._boundViewportColumnsChanged) {
            window.removeEventListener('resize', this._boundViewportColumnsChanged);
            this._boundViewportColumnsChanged = null;
        }
        // Clear focus restoration safety fallback timer (upstream)
        if (this._focusRestoreSafetyTimeout) {
            clearTimeout(this._focusRestoreSafetyTimeout);
            this._focusRestoreSafetyTimeout = null;
        }

        // Cancel any pending progressive image idle chunk queue
        this._cancelIdleChunkQueue();

        // Clean up alphabet selector position listener
        if (this._onAlphaPickerPositionChanged) {
            eventBus.off('alphaPickerPosition:changed', this._onAlphaPickerPositionChanged);
            this._onAlphaPickerPositionChanged = null;
        }
        if (this._onLibraryPageSizeChanged) {
            eventBus.off('pref:libraryPageSize', this._onLibraryPageSizeChanged);
            eventBus.off('pref:libraryPageSize:changed', this._onLibraryPageSizeChanged);
            this._onLibraryPageSizeChanged = null;
        }

        if (this._onAlphaPickerScrollModeChanged) {
            eventBus.off('pref:alphaPickerScrollMode:changed', this._onAlphaPickerScrollModeChanged);
            this._onAlphaPickerScrollModeChanged = null;
        }

        // Clean up global default library view mode and column change listeners
        if (this._onDefaultLibraryViewModeChanged) {
            eventBus.off('pref:defaultLibraryViewMode:changed', this._onDefaultLibraryViewModeChanged);
            eventBus.off('pref:defaultLibraryGridColumns:changed', this._onDefaultLibraryViewModeChanged);
            this._onDefaultLibraryViewModeChanged = null;
        }

        // Clean up background and sleep listeners
        if (this._onAppHidden) {
            eventBus.off('app:hidden', this._onAppHidden);
            this._onAppHidden = null;
        }
        if (this._onAppVisible) {
            eventBus.off('app:visible', this._onAppVisible);
            this._onAppVisible = null;
        }

        this.$('#library-tabs')?.removeEventListener('click', this._onTabClick);
        this.$('#alpha-picker')?.removeEventListener('click', this._onAlphaClick);

        // Clean up the merged grid evaluation listeners
        if (this._onGridFocusChanged) {
            eventBus.off('focus:changed', this._onGridFocusChanged);
            this._onGridFocusChanged = null;
        }
        if (this._onGridScroll) {
            const scrollContainer = this.$('#library-scroll-container') || this.el?.querySelector('.page-content');
            scrollContainer?.removeEventListener('scroll', this._onGridScroll);
            scrollContainer?.removeEventListener('wheel', this._onGridWheel);
            scrollContainer?.removeEventListener('touchmove', this._onGridTouch);
            window.removeEventListener('scroll', this._onGridScroll);
            this._onGridScroll = null;
            this._onGridWheel = null;
            this._onGridTouch = null;
        }
        if (this._gridEvalFrameId) {
            cancelAnimationFrame(this._gridEvalFrameId);
            this._gridEvalFrameId = null;
        }

        // Cancel background idle prefetch timer so pending fetches do not fire after page unmount
        if (this._libraryIdlePrefetchTimer) {
            clearTimeout(this._libraryIdlePrefetchTimer);
            this._libraryIdlePrefetchTimer = null;
        }

        // Cancel scheduled progressive row hydration frame
        if (this._progressiveHydrationFrameId) {
            cancelAnimationFrame(this._progressiveHydrationFrameId);
            this._progressiveHydrationFrameId = null;
        }

        this._gridEvalPending = false;
        this._gridFocusElement = null;
        this._gridScrollTop = null;
        this._pendingFocusEval = false;
        this._pendingScrollEval = false;
        this._isRestoringFocus = false;
    }

    // ========================================================================
    // Data Fetching
    // ========================================================================

    _reportMusicContext() {
        if (!this.state.libraryInfo) return;
        eventBus.emit('music:context', {
            path: this._navigatedPath,
            isMusic: this.state.libraryInfo.CollectionType === 'music'
        });
    }

    async _fetchLibraryInfo() {
        if (this.state.libraryId === 'all') {
            return;
        }

        try {
            let item = null;

            // Check if library metadata is already available from in-memory user views
            const cachedLibraries = state.get('home:libraries');
            if (Array.isArray(cachedLibraries)) {
                const found = cachedLibraries.find((lib) => lib && lib.Id === this.state.libraryId);
                if (found) {
                    item = { ...found };
                }
            }

            // Fallback to server query if library was not found in local memory cache
            if (!item) {
                item = await api.getItem(this.state.libraryId);
            }

            // If the libraryId is a deep link to an Album/Artist/Series, it won't have a CollectionType.
            // Fake it so the LibraryPage behaves like it's inside that specific library type.
            if (!item.CollectionType) {
                // Inherit parent collectionType from route parameter if available
                if (this.params.collectionType) {
                    item.CollectionType = this.params.collectionType;
                } else if (['MusicAlbum', 'MusicArtist', 'Audio', 'MusicGenre', 'Artist'].includes(item.Type)) {
                    item.CollectionType = 'music';
                } else if (['Series', 'Season', 'Episode', 'TvChannel', 'TvProgram'].includes(item.Type)) {
                    item.CollectionType = 'tvshows';
                } else if (item.Type === 'MusicVideo') {
                    item.CollectionType = 'musicvideos';
                } else if (['Movie', 'BoxSet', 'Video'].includes(item.Type)) {
                    item.CollectionType = 'movies';
                } else if (['Photo', 'PhotoAlbum'].includes(item.Type)) {
                    item.CollectionType = 'photos';
                } else if (item.Type === 'Book') {
                    item.CollectionType = 'books';
                }
            }

            // Identify media collections that must NEVER be misidentified as game libraries
            const isMediaCol =
                item.CollectionType === 'homevideos' ||
                item.CollectionType === 'photos' ||
                item.CollectionType === 'movies' ||
                item.CollectionType === 'tvshows' ||
                item.CollectionType === 'music' ||
                item.CollectionType === 'musicvideos' ||
                item.CollectionType === 'playlists' ||
                item.CollectionType === 'boxsets';

            // Detect Game libraries (JellyEmu collections or libraries specifically named after games/roms using word boundaries)
            const libNameLower = (item.Name || '').toLowerCase();
            const isGameKeyword = /\b(games?|roms?|emulators?|emulation|jellyemu|retroarch|retrogames?)\b/i.test(
                libNameLower
            );

            if (
                !isMediaCol &&
                (item.CollectionType === 'games' ||
                    (isGameKeyword && item.CollectionType !== 'books') ||
                    this.params.isGame === 'true')
            ) {
                this.state.isGameLibrary = true;
            } else {
                this.state.isGameLibrary = false;
            }

            // If the item fetched is a Folder, we are in a sub-folder view.
            this.state.isSubFolder =
                item.Type === 'Folder' || (item.Type === 'CollectionFolder' && !item.CollectionType && item.ParentId);

            // Inherit isGameLibrary if we are inside a verified games library
            // or if the console folder explicitly matches a gaming console name under an existing game context.
            if (!isMediaCol && !this.state.isGameLibrary && this.state.isSubFolder && this.params.isGame === 'true') {
                const isConsoleName =
                    /\b(nintendo|sega|sony|atari|game boy|gameboy|gba|gbc|snes|nes|n64|playstation|psx|ps1|ps2|genesis|megadrive|game gear|dreamcast|mame|arcade|neogeo)\b/i.test(
                        libNameLower
                    );
                if (isConsoleName) {
                    this.state.isGameLibrary = true;
                }
            }

            // Flag this as a folder-based library if it matches 'folders' type,
            // or is a generic collection without a specific media type.
            // For game libraries: ONLY the root library is treated as folders (to list console folders).
            // Once inside a console folder, isFolderLibrary is false so all games are loaded directly/recursively.
            this.state.isFolderLibrary =
                (this.state.isGameLibrary && !this.state.isSubFolder) ||
                (!this.state.isGameLibrary &&
                    (item.CollectionType === 'folders' ||
                        item.CollectionType === 'homevideos' ||
                        item.CollectionType === 'photos' ||
                        (!item.CollectionType &&
                            (item.Type === 'CollectionFolder' || item.Type === 'UserView' || item.Type === 'Folder'))));

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
            // Ensure libraryInfo is never null or undefined on failure
            if (!this.state.libraryInfo) {
                this.state.libraryInfo = {
                    Id: this.state.libraryId,
                    Name: this.params.name || this.params.title || i18n.t('Library') || 'Library',
                    CollectionType: this.params.collectionType || null
                };
            }
        }
    }

    async _loadItems() {
        this.setLoading(true);

        // Special handling for Seerr discovery library
        if (this.state.libraryId === 'seerr') {
            const seerrType = this.params.seerrType;
            const rawMediaType = this.params.mediaType || (seerrType === 'network' ? 'tv' : 'movie');
            const mediaType =
                rawMediaType === 'tv' || rawMediaType === 'series' || rawMediaType === 'tvshows' ? 'tv' : 'movie';
            const selectedGenre =
                this.state.filters.genre !== undefined
                    ? this.state.filters.genre
                    : this.params.genreId || this.params.genre;
            const genreId = selectedGenre;
            const language =
                this.state.filters.language !== undefined ? this.state.filters.language : this.params.language;
            const certification =
                this.state.filters.certification !== undefined
                    ? this.state.filters.certification
                    : this.params.certification;
            const studioId = this.params.studioId || this.params.studio;
            const networkId = this.params.networkId || this.params.network;
            const keywordId = this.params.keywordId || this.params.keywords || this.params.keyword;

            // Dynamically update title if genre filter changed
            if (selectedGenre) {
                const genreIds = selectedGenre.split(',').filter(Boolean);
                if (genreIds.length === 1) {
                    const gName = getGenreNameById(genreIds[0], mediaType);
                    if (gName) {
                        this.$('#library-title').textContent = gName;
                        this.title = gName;
                    }
                } else if (genreIds.length > 1) {
                    const names = genreIds.map((id) => getGenreNameById(id, mediaType)).filter(Boolean);
                    const titleStr = names.join(' & ');
                    this.$('#library-title').textContent = titleStr || i18n.t('Genres') || 'Genres';
                    this.title = titleStr || i18n.t('Genres') || 'Genres';
                }
            }

            // Calculate active page for Seerr request (each page contains 100 items merged from 5 upstream pages)
            const seerrPage = Math.floor(this.state.startIndex / 100) + 1;
            const sortField = this.state.sortBy || 'popularity';
            const sortDir = (this.state.sortOrder || 'Descending').toLowerCase().startsWith('asc') ? 'asc' : 'desc';
            // Only send sortBy parameter if it differs from the upstream default (popularity.desc)
            const seerrSortBy = sortField === 'popularity' && sortDir === 'desc' ? null : `${sortField}.${sortDir}`;

            let items = [];
            try {
                if (seerrType === 'keyword' || seerrType === 'tag' || keywordId) {
                    if (mediaType === 'tv') {
                        items = await seerr.discoverTv(seerrPage, {
                            keywords: keywordId,
                            genre: genreId,
                            language,
                            certification,
                            sortBy: seerrSortBy
                        });
                    } else {
                        items = await seerr.discoverMovies(seerrPage, {
                            keywords: keywordId,
                            genre: genreId,
                            language,
                            certification,
                            sortBy: seerrSortBy
                        });
                    }
                } else if (genreId || language || certification || seerrType === 'genre') {
                    if (mediaType === 'tv') {
                        items = await seerr.discoverTv(seerrPage, {
                            genre: genreId,
                            language,
                            certification,
                            sortBy: seerrSortBy
                        });
                    } else {
                        items = await seerr.discoverMovies(seerrPage, {
                            genre: genreId,
                            language,
                            certification,
                            sortBy: seerrSortBy
                        });
                    }
                } else if (seerrType === 'studio' || studioId) {
                    items = await seerr.moviesByStudio(studioId, seerrPage);
                } else if (seerrType === 'network' || networkId) {
                    items = await seerr.tvByNetwork(networkId, seerrPage);
                } else {
                    if (mediaType === 'tv') {
                        items = await seerr.discoverTv(seerrPage, { language, certification, sortBy: seerrSortBy });
                    } else {
                        items = await seerr.discoverMovies(seerrPage, { language, certification, sortBy: seerrSortBy });
                    }
                }
            } catch (err) {
                log.error('Failed to load Seerr category items', err);
                items = [];
            }

            this._lastFetchContext = {
                viewType: 'seerr',
                isSeerr: true,
                seerrType,
                mediaType,
                keywordId,
                genreId,
                language,
                certification,
                studioId,
                networkId,
                seerrSortBy
            };
            this.state.items = items || [];
            this.state.limit = 100;
            this.state.totalRecordCount =
                items.totalResults ||
                (items.totalPages ? items.totalPages * 100 : items.length ? (seerrPage + 1) * 100 : 0);

            const grid = this.$('#library-grid');
            if (grid) {
                grid.style.display = '';
                this._renderGrid(this.state.items);
            }
            this._updatePaginationUI();
            if (!this._pendingNavState) {
                this.setLoading(false);
            }
            return;
        }

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
            /*
             * ================================================================
             * Skeleton Layout Resolution
             * ================================================================
             * Render skeleton placeholders matching the active layout mode.
             * Defaults to 'thumb' for landscape collections when not set.
             * ================================================================
             */
            const skeletonMode = this.state.viewMode || (isLandscape ? 'thumb' : 'poster');
            const hideLibraryLabels = storage.getItem('pref:hideLibraryLabels') === 'true';
            const isModern = document.documentElement.getAttribute('data-layout-media-rows') === 'modern';
            const isLibraryView =
                this.state.viewMode === 'library' || this.state.libraryInfo?.CollectionType === 'folders';
            const shouldHideLabels = (isLibraryView && hideLibraryLabels) || (isLibraryView && isModern);

            // Pass landscape boolean only if the active mode is thumb layout
            grid.innerHTML = CardRenderer.createSkeletonHtml(
                12,
                skeletonMode === 'thumb' && isLandscape,
                skeletonMode,
                shouldHideLabels
            );
        }

        // --------------------------------------------------------------------
        // DYNAMIC PAGE SIZE AND INFINITE PAGINATION RESOLUTION
        // Always resolve the active limit directly from StorageService so setting
        // changes apply immediately to subsequent loads and refreshes.
        // --------------------------------------------------------------------
        const isInfinite = storage.getItem('pref:libraryPageSize') === 'unlimited';
        this.state.isInfinite = isInfinite;
        if (isInfinite) {
            this.state.limit = 100;
        } else {
            this.state.limit = parseInt(storage.getItem('pref:libraryPageSize') || 50, 10);
        }

        // Align limit to grid columns so the last rendered row is always full.
        // For list view, column count is always 1 (upstream fix).
        const effectiveLimitCols =
            this.state.viewMode === 'list'
                ? 1
                : isLandscape && this.state.viewMode !== 'thumb'
                  ? this._getDefaultColumnsForMode('thumb')
                  : this.state.gridColumns || this._getDefaultColumnsForMode(this.state.viewMode);
        // ANDROID PORTRAIT: apply the portrait column override AFTER the stock
        // resolution above, so landscape and TV behavior are untouched.
        const portraitLimitCols =
            this.state.gridMode === 'dynamic' ? this._getPortraitColumnOverride(this.state.viewMode) : null;
        const alignCols = this.state.gridMode === 'dynamic' ? portraitLimitCols || effectiveLimitCols : 0;
        if (alignCols > 0) {
            this.state.limit = Math.ceil(this.state.limit / alignCols) * alignCols;
        }

        // Keep startIndex aligned with the effective limit if a specific page was requested
        if (this.params.page) {
            const pageNum = parseInt(this.params.page, 10);
            if (!isNaN(pageNum) && pageNum > 0) {
                this.state.startIndex = (pageNum - 1) * this.state.limit;
            }
        }

        try {
            const params = {
                SortBy: this.state.sortBy,
                SortOrder: this.state.sortOrder,
                StartIndex: this.state.startIndex,
                Limit: this.state.limit,
                Recursive: true,
                Fields: 'DateCreated,ProductionYear,CommunityRating,OfficialRating,MediaSourceCount,Tags,ProviderIds,SortName',
                ImageTypeLimit: 1,
                EnableImageTypes: 'Primary,Backdrop,Thumb',
                EnableTotalRecordCount: true
            };

            // Store active query context for infinite scroll batch fetching
            this._lastFetchContext = {
                viewType: capturedViewType,
                params,
                isSeerr: false
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
            // When inside a Game console subfolder, ensure Recursive is true so all games within are loaded.
            if (this.state.isFolderLibrary || this.state.viewType === 'Folders') {
                params.Recursive = false;
            } else if (this.state.isGameLibrary && this.state.isSubFolder) {
                params.Recursive = true;
            }

            // Apply Filters
            /* -------------------------------------------------------------
             * Alphabet Filter vs Scroll Mode:
             * In unlimited scroll mode, the full library is loaded without
             * single-letter NameStartsWith filtering so users can scroll
             * seamlessly across the entire collection.
             * ------------------------------------------------------------- */
            const isScrollToLetterMode = isInfinite && storage.getItem('pref:alphaPickerScrollMode') !== 'false';
            if (this.state.nameStartsWith && !isScrollToLetterMode) {
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
            const isGame =
                this.state.isGameLibrary ||
                (info?.CollectionType === 'games' &&
                    info?.CollectionType !== 'homevideos' &&
                    info?.CollectionType !== 'photos');

            if (isGame || info?.CollectionType === 'books') {
                subViewItemTypes = 'Book';
            } else if (isMusic) {
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

                // ------------------------------------------------------------------
                // Multi-Value Query Filters (Genres, Years, Ratings, Tags, Languages)
                // ------------------------------------------------------------------
                if (f.Genres) {
                    // Pipe-delimited genre names are accepted universally across Jellyfin 10.x - 12.0+
                    // (bound via PipeDelimitedCollectionModelBinder directly to InternalItemsQuery.Genres).
                    // Split on either pipe or legacy comma to handle current and previously stored filters.
                    const genreList = (f.Genres.includes('|') ? f.Genres.split('|') : f.Genres.split(','))
                        .map((g) => g.trim())
                        .filter(Boolean);

                    // Filter out any stale raw GUIDs that were stored during early JF12 test sessions
                    const validGenres = genreList.filter(
                        (g) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(g)
                    );

                    // Only attach parameter if valid genre names remain after sanitization
                    if (validGenres.length > 0) {
                        params.Genres = validGenres.join('|');
                    }
                }
                if (f.Years) params.Years = f.Years;
                if (f.OfficialRatings) {
                    // Pipe-delimited parental ratings as expected by Jellyfin's PipeDelimitedCollectionModelBinder
                    const ratingsList = (
                        f.OfficialRatings.includes('|') ? f.OfficialRatings.split('|') : f.OfficialRatings.split(',')
                    )
                        .map((r) => r.trim())
                        .filter(Boolean);
                    if (ratingsList.length > 0) {
                        params.OfficialRatings = ratingsList.join('|');
                    }
                }
                if (f.Tags) {
                    // Pipe-delimited tag names as expected by Jellyfin's PipeDelimitedCollectionModelBinder
                    const tagsList = (f.Tags.includes('|') ? f.Tags.split('|') : f.Tags.split(','))
                        .map((t) => t.trim())
                        .filter(Boolean);
                    if (tagsList.length > 0) {
                        params.Tags = tagsList.join('|');
                    }
                }
                if (f.Studios) params.StudioIds = f.Studios;

                // Jellyfin 12+ Audio & Subtitle Language track filters (Comma-delimited collection binder)
                if (f.AudioLanguages) params.AudioLanguages = f.AudioLanguages;
                if (f.SubtitleLanguages) params.SubtitleLanguages = f.SubtitleLanguages;
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
                if (this.state.isGameLibrary || this.state.libraryInfo?.CollectionType === 'games') {
                    // When browsing a Game library at root as folders, do not restrict to 'Book'
                    // so that Jellyfin returns top-level console Folders.
                    // Inside subfolders, query 'Book' items (game ROMs).
                    if (this.state.isSubFolder) {
                        params.IncludeItemTypes = 'Book';
                    } else {
                        // At root folder level: leave IncludeItemTypes empty to return console Folders
                        params.IncludeItemTypes = '';
                    }
                } else if (this.state.libraryInfo?.CollectionType === 'books') {
                    params.IncludeItemTypes = 'Book';
                } else if (this.state.libraryInfo?.CollectionType === 'tvshows') {
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
            // Clear pending navigation state so the spinner is never trapped waiting for focus
            this._pendingNavState = null;
            const gridEl = this.$('#library-grid');
            if (gridEl) {
                gridEl.innerHTML = `<p class="error-msg">${i18n.t('FailedToLoadContent')}</p>`;
            }
        } finally {
            // Keep loading active if focus restoration is pending;
            // onScrollFocusRestored or the safety timer will release it once focus settles.
            if (!this._pendingNavState) {
                this.setLoading(false);
            }
            // Apply Header visibility and specialization AFTER content is loaded
            this._updateControlsVisibility();
            this._updateHeaderVisibility();

            // Force Focus Check - Ensure we don't drop focus after load
            // Especially for BoxSets where tabs are hidden and initial focus might be lost.
            // Check focusManager.getFocused() as native focus is disabled across the app.
            const currentFocused = focusManager.getFocused();
            if (!currentFocused || !document.contains(currentFocused)) {
                const collectionType = this.state.libraryInfo?.CollectionType;
                if (collectionType === 'boxsets' || collectionType === 'playlists') {
                    // Force controls or grid
                    if (this.$('#library-controls')?.style.display !== 'none') {
                        this.setActiveSection('library-controls');
                    } else {
                        this.setActiveSection('library-grid');
                    }
                }
            }
        }
    }

    _updatePaginationUI() {
        const grid = this.$('#library-grid');
        if (this.state.isInfinite) {
            if (grid) grid.style.paddingBottom = 'calc(100vh - 250px)';
            const footer = this.$('#library-pagination');
            if (footer) footer.style.display = 'none';

            const btnPrevTop = this.$('#btn-prev-top');
            const btnNextTop = this.$('#btn-next-top');
            if (btnPrevTop) btnPrevTop.style.display = 'none';
            if (btnNextTop) btnNextTop.style.display = 'none';

            const countIndicator = this.$('#count-indicator');
            if (countIndicator) {
                const total = this.state.totalRecordCount || this.state.items.length;
                countIndicator.textContent = i18n.t('ListPaging', [1, this.state.items.length, total]);
            }
            return;
        }

        const { startIndex, limit, totalRecordCount } = this.state;
        const pageParam = this.params.page ? parseInt(this.params.page, 10) : null;
        const currentPage = !isNaN(pageParam) && pageParam > 0 ? pageParam : Math.floor(startIndex / (limit || 1)) + 1;
        const totalPages = Math.ceil(totalRecordCount / (limit || 1));

        this.$('#pagination-info').textContent = i18n.t('PageNumberXOfY', [currentPage, totalPages || 1]);

        // Hide/Show logic for single page or horizontal row views (Genres/Suggestions)
        if (grid) grid.style.paddingBottom = '';

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

        // Determine if the current tab/collection defaults to 16:9 landscape orientation
        const isLandscape =
            this.state.viewType === 'Episodes' ||
            this.state.viewType === 'Upcoming' ||
            this.state.viewType === 'Networks' ||
            this.state.libraryInfo?.CollectionType === 'musicvideos' ||
            this.state.libraryInfo?.CollectionType === 'homevideos' ||
            this.state.libraryInfo?.CollectionType === 'photos' ||
            (this.params.includeItemTypes && this.params.includeItemTypes.includes('Episode'));

        const isSeerr = this.state.libraryId === 'seerr' || this.state.libraryInfo?.CollectionType === 'seerr';

        /*
         * =====================================================================
         * Tab-Specific & Sub-View Storage Key Resolution
         * =====================================================================
         * Preserve separate view mode preferences for non-default tabs
         * (e.g., Episodes tab in TV Shows, Photos/Videos in Home Videos).
         * =====================================================================
         */
        const isTabSpecific = Boolean(this.state.viewType && this.state.viewType !== 'Items');
        const tabStorageKey = isTabSpecific
            ? `pref:library:viewMode:${this.state.libraryId}:${this.state.viewType}`
            : null;
        const libStorageKey = isSeerr ? 'pref:seerr:viewMode' : `pref:library:viewMode:${this.state.libraryId}`;

        // ---------------------------------------------------------------------
        // 1. Resolve Active View Mode
        // ---------------------------------------------------------------------
        // Priority order:
        //  a) Explicit URL numerical index (?viewModeIndex=2 -> 'thumb')
        //  b) Explicit URL string (?viewMode=thumb)
        //  c) Saved local storage preference for this tab / library
        //  d) Standard fallback: 'thumb' for landscape collections, 'poster' otherwise
        // ---------------------------------------------------------------------
        if (this.params.viewModeIndex !== undefined) {
            const index = parseInt(this.params.viewModeIndex, 10);
            if (!isNaN(index) && validModes[index]) {
                this.state.viewMode = validModes[index];
                log.info(`[ViewMode] Loaded view mode index from URL: ${index} -> ${this.state.viewMode}`);
            }
        } else if (this.params.viewMode && validModes.includes(this.params.viewMode)) {
            this.state.viewMode = this.params.viewMode;
            log.info(`[ViewMode] Loaded view mode string from URL: ${this.state.viewMode}`);
        } else {
            // Retrieve saved preference (checking tab-specific key before library-level key)
            const saved = (tabStorageKey && storage.getItem(tabStorageKey)) || storage.getItem(libStorageKey);

            // Resolve fallback default layout mode from global settings
            const configuredDefault = storage.getItem('pref:defaultLibraryViewMode');
            const defaultMode =
                configuredDefault && validModes.includes(configuredDefault) ? configuredDefault : 'poster';

            if (saved) {
                // Validate that the persisted library-specific value is still an allowed option
                const allowedModes = isSeerr ? ['poster', 'small-poster'] : validModes;
                this.state.viewMode = allowedModes.includes(saved) ? saved : isLandscape ? 'thumb' : defaultMode;
            } else {
                // Universal default is 'thumb' for landscape collections/tabs, user-configured default otherwise
                this.state.viewMode = isLandscape ? 'thumb' : defaultMode;
            }
        }

        log.info(
            `[ViewMode] Active view mode: ${this.state.viewMode} for library ${this.state.libraryId} (tab: ${this.state.viewType || 'Items'})`
        );

        /*
         * =========================================================================
         * REHYDRATE GRID CONFIGURATIONS
         * =========================================================================
         * Loads whether we are using Static or Dynamic sizing modes, and the specific
         * custom column counts selected for this viewMode.
         * =========================================================================
         */
        const tabModeKey = isTabSpecific
            ? `pref:library:gridMode:${this.state.libraryId}:${this.state.viewType}`
            : null;
        const libModeKey = isSeerr ? 'pref:seerr:gridMode' : `pref:library:gridMode:${this.state.libraryId}`;
        const savedMode = (tabModeKey && storage.getItem(tabModeKey)) || storage.getItem(libModeKey);
        this.state.gridMode = savedMode === 'static' ? 'static' : 'dynamic';

        const effectiveMode = this.state.viewMode;
        const tabColsKey = isTabSpecific
            ? `pref:library:gridColumns:${this.state.libraryId}:${this.state.viewType}:${effectiveMode}`
            : null;
        const colsKey = isSeerr
            ? `pref:seerr:gridColumns:${effectiveMode}`
            : `pref:library:gridColumns:${this.state.libraryId}:${effectiveMode}`;
        const savedCols = parseInt((tabColsKey && storage.getItem(tabColsKey)) || storage.getItem(colsKey), 10);
        this.state.gridColumns = !isNaN(savedCols) ? savedCols : this._getDefaultColumnsForMode(effectiveMode);
    }

    _loadPersistedSortMode() {
        if (this._isSubView()) {
            return; // Sub-views should fallback to defaults
        }

        const isSeerr = this.state.libraryId === 'seerr' || this.state.libraryInfo?.CollectionType === 'seerr';
        const sortByKey = `pref:library:sortBy:${this.state.libraryId}`;
        const sortOrderKey = `pref:library:sortOrder:${this.state.libraryId}`;

        const savedSortBy = storage.getItem(sortByKey);
        const savedSortOrder = storage.getItem(sortOrderKey);

        if (isSeerr) {
            const validSeerrSorts = ['popularity', 'release_date', 'first_air_date', 'vote_average', 'original_title'];
            this.state.sortBy = savedSortBy && validSeerrSorts.includes(savedSortBy) ? savedSortBy : 'popularity';
            this.state.sortOrder = savedSortOrder || 'Descending';
            return;
        }

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
                const parsed = JSON.parse(savedFilters);

                // Sanitize any stale GUID-based genre strings stored from previous test sessions
                if (parsed.Genres) {
                    const firstGenre = parsed.Genres.split(/[,|]/)[0]?.trim();
                    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(firstGenre)) {
                        delete parsed.Genres;
                    }
                }

                this.state.filters = parsed;
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
            this.state.libraryInfo?.CollectionType === 'musicvideos' ||
            this.state.libraryInfo?.CollectionType === 'homevideos'
        ) {
            return 'backdrop';
        }
        if (
            this.state.libraryInfo?.CollectionType === 'music' ||
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

        if (this.state.isGameLibrary || collectionType === 'games') {
            tabs = [
                { id: 'Items', label: 'Games' },
                { id: 'Suggestions', label: 'Suggestions' },
                { id: 'Genres', label: 'Genres' }
            ];
        } else if (collectionType === 'books') {
            tabs = [
                { id: 'Items', label: 'Books' },
                { id: 'Suggestions', label: 'Suggestions' },
                { id: 'Genres', label: 'Genres' }
            ];
        } else if (collectionType === 'tvshows') {
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
        } else if (collectionType === 'homevideos' || collectionType === 'photos') {
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
        const isRightPos = layoutManager.getAlphaPickerPosition() === 'right';

        if (container) {
            container.style.visibility = 'visible';

            // Docking hierarchy management:
            // When right-docked, reparent container directly to this.el (.library-page)
            // outside .library-scroll-container (.page-content). This completely detaches
            // it from the scroll container and any contain/transform stacking contexts,
            // locking the vertical rail fixed to the screen while the library scrolls underneath.
            // When top-positioned, return it to .library-header so it flows in normal document order.
            if (isRightPos) {
                if (this.el && container.parentElement !== this.el) {
                    this.el.appendChild(container);
                }
            } else {
                const header = this.$('#library-header');
                if (header && container.parentElement !== header) {
                    header.appendChild(container);
                }
            }
        }

        if (!showPicker) return;

        const picker = this.$('#alpha-picker');
        if (!picker) return;

        /* -----------------------------------------------------------------
         * Active Alphabet Highlight:
         * Uses scrollAlphaChar in unlimited scroll mode, or nameStartsWith in
         * standard filtering mode, providing immediate visual feedback.
         * ----------------------------------------------------------------- */
        const isScrollModeActive = this.state.isInfinite && storage.getItem('pref:alphaPickerScrollMode') !== 'false';
        const activeChar = isScrollModeActive
            ? this.state.scrollAlphaChar || this.state.nameStartsWith
            : this.state.nameStartsWith;

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

        // Configure focus registration depending on user-configured position
        if (isRightPos) {
            // Vertical orientation on the right edge: Up/Down traverses letters, Left jumps back to grid
            focusManager.register('alpha-picker', this.$('#alpha-picker'), {
                orientation: 'vertical',
                leaveUp: 'library-controls',
                leaveDown: null,
                leaveLeft: 'library-grid',
                leaveRight: null,
                enterTo: 'active-element'
            });
        } else {
            // Traditional horizontal orientation in the header: Left/Right traverses letters, Down jumps to grid
            focusManager.register('alpha-picker', this.$('#alpha-picker'), {
                orientation: 'horizontal',
                leaveUp: 'library-controls',
                leaveDown: 'library-grid',
                leaveLeft: 'sidebar',
                leaveRight: null,
                enterTo: 'active-element' // Focus the selected char
            });
        }
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

        // Invalidate the CardRenderer HTML cache — items or view options may
        // have changed since the last render (new data, view mode switch, etc.)
        CardRenderer.clearCache();

        // Cleanup: Hide horizontal rows if they exist and restore grid
        const rowsContainer = this.$('#library-rows');
        if (rowsContainer) {
            rowsContainer.style.display = 'none';
        }
        grid.style.display = ''; // Restore grid display

        const pagination = this.$('#library-pagination');
        if (pagination) pagination.style.display = ''; // Restore pagination

        // Use landscape cards via CSS class if needed (e.g. for Episodes, Upcoming, Networks, Music Videos, Home Videos, Photos)
        // These viewTypes/collections default to landscape (thumb) mode when no preference is saved.
        const isLandscape =
            this.state.viewType === 'Episodes' ||
            this.state.viewType === 'Upcoming' ||
            this.state.viewType === 'Networks' ||
            this.state.libraryInfo?.CollectionType === 'musicvideos' ||
            this.state.libraryInfo?.CollectionType === 'homevideos' ||
            this.state.libraryInfo?.CollectionType === 'photos' ||
            (this.params.includeItemTypes && this.params.includeItemTypes.includes('Episode'));

        /*
         * --------------------------------------------------------------------
         * Apply View Mode CSS Modifier Class to Grid Container
         * --------------------------------------------------------------------
         * Cleanly toggle modifier classes matching the selected view mode.
         * 'poster' uses base styles (no class). 'small-poster', 'thumb',
         * 'banner', and 'list' each apply their specific CSS layout rule.
         * --------------------------------------------------------------------
         */
        const viewModeClasses = ['view-small-poster', 'view-thumb', 'view-banner', 'view-list'];
        viewModeClasses.forEach((cls) => grid.classList.remove(cls));
        grid.classList.remove('landscape');

        const nonDefaultModes = ['small-poster', 'thumb', 'banner', 'list'];
        if (nonDefaultModes.includes(this.state.viewMode)) {
            grid.classList.add(`view-${this.state.viewMode}`);
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

            // Effective columns must reflect forced-landscape tabs (e.g. Episodes = 4 cols, not poster's 7).
            // Single source of truth: _resolveDynamicGridColumns (also used by
            // the chunk sizer and the Android portrait rotation handler).
            const effectiveMode = isLandscape ? 'thumb' : this.state.viewMode;
            const effectiveColumns = this._resolveDynamicGridColumns(effectiveMode);

            grid.style.setProperty('--grid-columns', effectiveColumns);

            // Compute card width minus margins to feed ImageService parameters
            const containerWidth = grid.clientWidth || 1720;
            const columns = effectiveColumns || 7;
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
                // Register Empty State Button for focus with position awareness
                const isRightPosEmpty = layoutManager.getAlphaPickerPosition() === 'right';
                focusManager.register('empty-state-btn', this.$('#empty-state'), {
                    leaveUp: isRightPosEmpty ? 'library-controls' : 'alpha-picker',
                    leaveLeft: 'sidebar',
                    leaveRight: isRightPosEmpty && shouldShowControls ? 'alpha-picker' : null,
                    selector: '#btn-reset-filters'
                });

                // Link Alpha Picker/Controls to Empty State Button
                const alphaConfig = focusManager.getSectionConfig('alpha-picker');
                if (alphaConfig) {
                    focusManager.register('alpha-picker', this.$('#alpha-picker'), {
                        ...alphaConfig,
                        leaveDown: isRightPosEmpty ? null : 'empty-state-btn',
                        leaveLeft: isRightPosEmpty ? 'empty-state-btn' : 'sidebar'
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
        const start = this.state.isInfinite ? 1 : this.state.startIndex + 1;
        const end = this.state.isInfinite
            ? this.state.items.length
            : Math.min(this.state.startIndex + this.state.limit, this.state.totalRecordCount);
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
        const effectiveMode = isLandscape ? 'thumb' : this.state.viewMode;
        let columns = this._resolveDynamicGridColumns(effectiveMode);

        // In List view, there is strictly 1 card per row regardless of gridColumns settings
        if (this.state.viewMode === 'list') {
            columns = 1;
        }

        // Store rendering context + column count on state so _appendGridChunk
        // and _prependGridChunk can access them without re-deriving
        this.state._gridRenderContext = {
            isLandscape,
            resolvedCardType,
            cardWidth
        };
        this.state._gridColumns = columns;
        grid.dataset.gridColumns = columns;

        /*
         * =====================================================================
         * VIRTUAL ROW POOL INITIALIZATION
         * =====================================================================
         * Instead of relying on a destructive DOM sliding window that repeatedly
         * tears down nodes and grows flex spacers, we initialize a fixed pool
         * of absolutely-positioned row tracks (.virtual-grid-row).
         *
         * The container has its full pixel height defined upfront, completely
         * eliminating spacer resizing and preventing synchronous flexbox layout
         * reflows across the entire grid during navigation.
         * =====================================================================
         */
        grid.classList.add('virtual-active');
        grid.style.position = 'relative';

        // Determine total mathematical rows and capacity for the active layout
        const totalRows = Math.ceil(items.length / columns);
        const isListView = this.state.viewMode === 'list';
        /*
         * DIRECT RENDERING & SKIP LAZY LOADING MODE
         * If the page limit is below 60 items (accommodating last-row alignment for 50 items),
         * we bypass standard IntersectionObserver lazy loading and sliding row recycling.
         * All rows are placed into the DOM upfront, allowing instant D-pad navigation
         * and native GPU scrolling without continuous main-thread layout thrashing.
         */
        const isSkipLazy = !this.state.isInfinite && this.state.limit < 60;
        // prettier-ignore
        const POOL_ROWS = isSkipLazy ? totalRows : (isListView ? 22 : 10);
        const poolRows = Math.min(totalRows, POOL_ROWS);

        // Reset virtual window and row tracking cursors
        this._currentStartRow = 0;
        this._currentEndRow = Math.max(0, poolRows - 1);
        this.state.gridWindowStart = 0;
        this.state.gridWindowEnd = Math.min(items.length, poolRows * columns);
        this.state._hasMoreInfinite = true;
        this.state.gridCardRowHeight = null; // Invalidate cached row height for fresh layout

        // Reset direction cursors so previous scroll state does not misfire
        this._lastFocusItemIndex = 0;
        this._lastGridScrollTop = 0;

        // Reserve viewport clearance at bottom in unlimited mode so last row can center
        grid.style.paddingBottom = this.state.isInfinite ? 'calc(100vh - 250px)' : '';

        /*
         * =====================================================================
         * EAGER VIEWPORT INITIALIZATION + PROGRESSIVE BUFFER HYDRATION
         * =====================================================================
         * Spreading card DOM construction across animation frames completely
         * eliminates the synchronous main-thread freeze on low-power TV chipsets.
         *
         * The visible viewport rows (EAGER_ROWS) are populated with real media cards
         * immediately so the initial frame paints in < 16ms and visible posters
         * start loading without socket contention.
         *
         * Deferred buffer rows in the pool are initially seeded with lightweight
         * skeleton tracks (preserving layout geometry) and hydrated frame-by-frame
         * via requestAnimationFrame before the user can scroll to them.
         * =====================================================================
         */
        const EAGER_ROWS = isListView ? 6 : 3;
        const eagerRowsCount = Math.min(poolRows, EAGER_ROWS);
        const viewMode = this.state.viewMode || 'poster';
        const cardLabelStyle = storage.getItem('pref:cardLabelStyle') || 'default';
        const skeletonHideLabels = cardLabelStyle === 'hidden';

        // Build initial pool: in skip-lazy mode (< 60 items), render all rows with media cards upfront
        let rowsHtml = '';
        for (let r = 0; r < poolRows; r++) {
            const rowStart = r * columns;
            const rowEnd = Math.min(items.length, (r + 1) * columns);
            const rowItems = items.slice(rowStart, rowEnd);

            if (isSkipLazy || r < eagerRowsCount) {
                rowsHtml += `<div class="virtual-grid-row" data-row-index="${r}">${this._buildGridChunkHtml(rowItems)}</div>`;
            } else {
                rowsHtml += `<div class="virtual-grid-row" data-row-index="${r}" data-skeleton="true">${CardRenderer.createSkeletonHtml(rowItems.length, isLandscape, viewMode, skeletonHideLabels)}</div>`;
            }
        }
        grid.innerHTML = rowsHtml;

        // Eagerly measure row step geometry while initial DOM elements are fresh
        const rowHeight = this._measureGridRowHeight(grid, columns) || (isListView ? 132 : 380);

        // Assign explicit absolute top positions to all pool rows
        const rowElements = grid.querySelectorAll('.virtual-grid-row');
        for (let r = 0; r < rowElements.length; r++) {
            rowElements[r].style.top = `${r * rowHeight}px`;
        }

        // Fix container height upfront to reflect total library geometry
        grid.style.height = `${totalRows * rowHeight}px`;

        // Cancel any pending progressive hydration from a previous render
        if (this._progressiveHydrationFrameId) {
            cancelAnimationFrame(this._progressiveHydrationFrameId);
            this._progressiveHydrationFrameId = null;
        }

        // Cancel any pending idle chunk queue from a previous render
        this._cancelIdleChunkQueue();

        if (isSkipLazy) {
            /*
             * =================================================================
             * SKIP LAZY LOADING PIPELINE (LOW PAGE LIMIT < 60 ITEMS)
             * =================================================================
             * For small paginated batches (e.g. 50 items):
             * 1. All cards exist in the DOM from Frame 1 for instant D-pad navigation.
             * 2. Instead of dumping all 50 src attributes simultaneously (which would
             *    flood sockets and cause a decoding freeze), load the first 14 items
             *    (the visible screen) immediately on Frame 1.
             * 3. Progressively load the remaining 36 items in chunks of 10 using
             *    requestIdleCallback (or a 50ms setTimeout chain).
             * 4. By the time the user scrolls down two rows, the rest of the page
             *    is already loaded and decoded in GPU memory.
             * 5. LazyLoader.observer is completely bypassed for the grid, allowing
             *    butter-smooth native GPU scrolling with 0ms JavaScript overhead.
             * =================================================================
             */
            const allCards = grid.querySelectorAll('.media-card');

            // Hook shimmer observer for off-screen cards while bypassing LazyLoader.observer
            this._hookGridCards(allCards, false);

            // Immediately load visible viewport items (first 14 cards)
            const initialCount = Math.min(14, allCards.length);
            for (let i = 0; i < initialCount; i++) {
                const img = allCards[i].querySelector('img[data-src]');
                if (img) {
                    lazyLoader.forceLoad(img, true);
                }
            }

            // Schedule remaining cards in background idle chunks of 10
            if (allCards.length > initialCount) {
                this._scheduleIdleImageChunks(allCards, initialCount);
            }
        } else {
            // Register initial eager cards with image observer and lazy loader (eagerLoad = true for viewport)
            // prettier-ignore
            this._hookGridCards(grid.querySelectorAll('.virtual-grid-row:not([data-skeleton="true"]) .media-card'), true);

            // Progressively hydrate remaining buffer rows frame-by-frame
            let nextHydrateRow = eagerRowsCount;
            const hydrateNextChunk = () => {
                if (this._isDestroyed || nextHydrateRow >= poolRows) return;
                const rowsToHydrate = Math.min(2, poolRows - nextHydrateRow);
                for (let i = 0; i < rowsToHydrate; i++) {
                    const r = nextHydrateRow + i;
                    const rowEl = grid.querySelector(`.virtual-grid-row[data-row-index="${r}"]`);
                    if (rowEl && rowEl.dataset.skeleton === 'true') {
                        const rowStart = r * columns;
                        const rowEnd = Math.min(items.length, (r + 1) * columns);
                        const chunkItems = items.slice(rowStart, rowEnd);
                        rowEl.innerHTML = this._buildGridChunkHtml(chunkItems);
                        delete rowEl.dataset.skeleton;
                        rowEl.removeAttribute('data-skeleton');
                        this._hookGridCards(rowEl.querySelectorAll('.media-card'), false);
                    }
                }
                nextHydrateRow += rowsToHydrate;
                if (nextHydrateRow < poolRows) {
                    this._progressiveHydrationFrameId = requestAnimationFrame(hydrateNextChunk);
                } else {
                    this._progressiveHydrationFrameId = null;
                    focusManager.invalidateCache('library-grid');
                    // Pool is fully hydrated: schedule lookahead image pre-warm & idle prefetch
                    this._schedulePreWarm(poolRows, 1);
                    if (this.state.isInfinite && this.state.items.length < (this.state.totalRecordCount || 0)) {
                        this._scheduleLibraryIdlePrefetch(400);
                    }
                }
            };

            if (nextHydrateRow < poolRows) {
                this._progressiveHydrationFrameId = requestAnimationFrame(hydrateNextChunk);
            } else {
                this._schedulePreWarm(poolRows, 1);
                if (this.state.isInfinite && this.state.items.length < (this.state.totalRecordCount || 0)) {
                    this._scheduleLibraryIdlePrefetch(400);
                }
            }
        }

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

        // Update Alpha Picker navigation to point to grid based on current orientation
        const isRightPosNav = layoutManager.getAlphaPickerPosition() === 'right';
        if (isAlphaVisible) {
            if (isRightPosNav) {
                focusManager.register('alpha-picker', this.$('#alpha-picker'), {
                    orientation: 'vertical',
                    leaveUp: 'library-controls',
                    leaveDown: null,
                    leaveLeft: 'library-grid',
                    leaveRight: null,
                    enterTo: 'active-element'
                });
            } else {
                focusManager.register('alpha-picker', this.$('#alpha-picker'), {
                    orientation: 'horizontal',
                    leaveUp: 'library-controls',
                    leaveDown: 'library-grid',
                    leaveLeft: 'sidebar',
                    leaveRight: null,
                    enterTo: 'active-element'
                });
            }
        }

        // Re-register focus for grid items
        const currentColumns = this.state.viewMode === 'list' ? 1 : columns;

        // When alpha selector is on the right, pressing UP goes straight to controls
        let gridLeaveUp = 'library-controls';
        if (!isRightPosNav && isAlphaVisible) {
            gridLeaveUp = 'alpha-picker';
        }

        focusManager.register('library-grid', grid, {
            orientation: 'grid',
            columns: currentColumns,
            leaveUp: gridLeaveUp,
            leaveDown:
                this.state.isInfinite && this.state.items.length < this.state.totalRecordCount
                    ? null
                    : this.state.isInfinite
                      ? null
                      : 'library-pagination',
            leaveLeft: 'sidebar',
            leaveRight: isRightPosNav && isAlphaVisible ? 'alpha-picker' : null,
            selector: '.media-card',
            scrollOffsetTop: 100,

            // =================================================================
            // VIRTUAL GRID EDGE GUARD
            // =================================================================
            // When the user presses UP on the first rendered DOM row, FocusManager
            // would normally fire leaveUp because no card exists above in the DOM.
            // But if gridWindowStart > 0 there ARE real items above — they were
            // just evicted from the DOM to keep the node count small.
            //
            // We intercept the UP move here (before FocusManager acts on it),
            // prepend the missing rows back into the DOM, and return false.
            // FocusManager then re-queries the grid (cache was invalidated by
            // _hookGridCards) and finds the card directly above — allowing it
            // to move focus there naturally, just as if the rows had always been
            // in the DOM. The result: no accidental focus jumps to tabs/controls
            // while holding UP through a windowed grid.
            // =================================================================
            // =================================================================
            // VIRTUAL GRID EDGE GUARDS (Up & Down)
            // =================================================================
            // When the user navigates across window boundaries, FocusManager
            // may not find the adjacent card because it was either evicted
            // or hasn't yet been appended to the DOM.
            //
            // We intercept the directional move here BEFORE FocusManager queries
            // focusables:
            //   - For UP moves on the first row: prepend evicted rows.
            //   - For DOWN moves on the last row: append the next chunk.
            //
            // Prepending/appending invalidates the FocusManager cache synchronously.
            // Returning false lets FocusManager proceed with its move, re-querying
            // the fresh DOM and landing on the new card naturally without sticking
            // or jumping out of section.
            // =================================================================
            onMove: (direction, focusedElement) => {
                if (!focusedElement) return false;

                const columns = currentColumns || 1;
                const allCards = grid.querySelectorAll('.media-card');
                let domIndex = -1;
                for (let i = 0; i < allCards.length; i++) {
                    if (allCards[i] === focusedElement) {
                        domIndex = i;
                        break;
                    }
                }
                if (domIndex < 0) return false;

                // Intercept UP navigation when on the first rendered row in the pool
                if (direction === 'up') {
                    if (domIndex < columns && (this._currentStartRow || 0) > 0) {
                        this._syncVirtualGrid(Math.max(0, (this._currentStartRow || 0) - 1));
                        return false;
                    }
                }

                // Intercept DOWN navigation when on the last rendered row in the pool
                if (direction === 'down') {
                    const totalRows = Math.ceil(this.state.items.length / columns);
                    if (domIndex + columns >= allCards.length) {
                        if ((this._currentEndRow || 0) < totalRows - 1) {
                            this._syncVirtualGrid(Math.min(totalRows - 1, (this._currentEndRow || 0) + 1));
                        } else if (this.state.isInfinite) {
                            const hasMore =
                                this.state._hasMoreInfinite !== false &&
                                (!this.state.totalRecordCount || this.state.items.length < this.state.totalRecordCount);
                            if (hasMore) {
                                this._loadNextInfiniteBatch();
                            }
                        }
                    }
                }

                return false;
            }
        });

        // ====================================================================
        // MERGED PROGRESSIVE DOM TRIGGER — shared evaluation engine
        // ====================================================================
        // Combines the two former evaluation paths (focus:changed for D-pad,
        // native scroll for mouse/magic remote) into a SINGLE rAF-backed
        // evaluation point. Both paths write their latest input to shared
        // state and call _scheduleGridEval(), which guarantees at most one
        // evaluation per frame regardless of how many input events fire.
        //
        // This eliminates:
        //   1. Double append/prepend when both scroll and focus fire in
        //      the same frame (e.g. scroll ends → focus settles on a card)
        //   2. Duplicate _syncGridWindow calls operating on stale DOM
        //   3. Separate rAF IDs competing for the same work
        // ====================================================================
        this._gridEvalPending = false;
        this._gridEvalFrameId = null;
        this._gridFocusElement = null;
        this._gridScrollTop = null;
        this._pendingFocusEval = false;
        this._pendingScrollEval = false;

        if (this._onGridFocusChanged) {
            eventBus.off('focus:changed', this._onGridFocusChanged);
        }
        this._onGridFocusChanged = (element) => {
            if (!element || !grid.contains(element)) return;
            if (!element.classList.contains('media-card')) return;

            // Direct D-pad focus takes precedence over manual scroll tracking
            this._isManualScroll = false;
            this._lastFocusTime = Date.now();

            this._gridFocusElement = element;
            this._pendingFocusEval = true;
            this._scheduleGridEval();
        };
        eventBus.on('focus:changed', this._onGridFocusChanged);

        const scrollContainer = this.$('#library-scroll-container') || this.el.querySelector('.page-content');
        if (scrollContainer) {
            // Clean up any previously attached scroll/wheel/touch handlers
            if (this._onGridScroll) {
                scrollContainer.removeEventListener('scroll', this._onGridScroll);
                window.removeEventListener('scroll', this._onGridScroll);
                scrollContainer.removeEventListener('wheel', this._onGridWheel);
                scrollContainer.removeEventListener('touchmove', this._onGridTouch);
            }
            this._lastGridScrollTop = 0;
            this._onGridScroll = () => {
                // Determine current scroll position from container or window (for TV webOS pointer/wheel scrolling)
                this._gridScrollTop =
                    scrollContainer.scrollTop || window.pageYOffset || document.documentElement.scrollTop || 0;
                this._pendingScrollEval = true;
                this._scheduleGridEval();
            };
            this._onGridWheel = () => {
                // Mark manual scroll active when user spins wheel or magic remote
                this._isManualScroll = true;
                this._lastManualScrollTime = Date.now();
                this._gridScrollTop =
                    scrollContainer.scrollTop || window.pageYOffset || document.documentElement.scrollTop || 0;
                this._pendingScrollEval = true;
                this._scheduleGridEval();
            };
            this._onGridTouch = () => {
                // Mark manual scroll active when user touch-flings or drags
                this._isManualScroll = true;
                this._lastManualScrollTime = Date.now();
            };
            scrollContainer.addEventListener('scroll', this._onGridScroll, { passive: true });
            window.addEventListener('scroll', this._onGridScroll, { passive: true });
            scrollContainer.addEventListener('wheel', this._onGridWheel, { passive: true });
            scrollContainer.addEventListener('touchmove', this._onGridTouch, { passive: true });
        }

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
        // When alpha selector is on the right, controls point DOWN to grid and RIGHT to alpha-picker
        let controlsLeaveDownNav = 'library-grid';
        if (!isRightPosNav && isAlphaVisible) {
            controlsLeaveDownNav = 'alpha-picker';
        }

        this.registerFocusSection('library-controls', this.$('#library-controls'), {
            orientation: 'horizontal',
            leaveUp: hasTabs ? 'library-tabs' : null,
            leaveDown: controlsLeaveDownNav,
            leaveLeft: 'sidebar',
            leaveRight: isRightPosNav && isAlphaVisible ? 'alpha-picker' : null,
            selector: 'button'
        });

        // Ensure focus goes to first element in grid if subview and NOT restoring focus and user hasn't moved
        if (this._isSubView() && !this._pendingNavState && !state.has(this._getCacheKey())) {
            requestAnimationFrame(() => {
                // If user already moved focus via D-pad while loading, do not override their cursor
                if (this._initTimestamp && focusManager.getLastMoveTime() > this._initTimestamp) {
                    return;
                }
                const currentFocus = focusManager.getFocused();
                if (!currentFocus || !document.contains(currentFocus)) {
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

        /*
         * ====================================================================
         * Card Orientation & Metarow Configuration
         * ====================================================================
         * Card renders in landscape orientation when in thumb or banner mode,
         * or when in a landscape collection unless in list or portrait mode.
         * List mode cards display rich metadata on the right edge.
         * ====================================================================
         */
        const isCardLandscape =
            this.state.viewMode === 'thumb' ||
            this.state.viewMode === 'banner' ||
            (isLandscape &&
                this.state.viewMode !== 'list' &&
                this.state.viewMode !== 'poster' &&
                this.state.viewMode !== 'small-poster');

        return items
            .map((item) =>
                CardRenderer.createCardHtml(item, {
                    isLandscape: isCardLandscape,
                    type: this.state.viewMode === 'banner' ? 'banner' : resolvedCardType,
                    contextType:
                        this.state.libraryId === 'seerr' || this.state.libraryInfo?.CollectionType === 'seerr'
                            ? 'discover'
                            : this.state.viewType === 'Upcoming'
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

        const firstCard = grid.querySelector('.media-card');
        if (!firstCard) return null;

        // Calculate exact vertical footprint: card height plus row margin
        const cardHeight = firstCard.offsetHeight;
        let marginBottom = 0;
        try {
            const style = window.getComputedStyle(firstCard);
            marginBottom = parseFloat(style.marginBottom) || 0;
        } catch (_) {
            marginBottom = 0;
        }

        const calculatedHeight = cardHeight + marginBottom;
        if (calculatedHeight > 0) {
            this.state.gridCardRowHeight = calculatedHeight;
            return calculatedHeight;
        }

        // Fallback default estimates per view mode if layout has not yet painted
        const isListView = this.state.viewMode === 'list';
        const fallback = isListView ? 132 : this.state.viewMode === 'banner' ? 180 : 380;
        return fallback;
    }

    /**
     * =========================================================================
     * REGISTER GRID CARDS WITH OBSERVERS & NAVIGATION
     * =========================================================================
     * After inserting DOM nodes, registers their skeleton shimmer elements with
     * the shimmer pause observer and connects images to the lazy loader.
     *
     * To prevent main-thread freezing and connection saturation during row recycling,
     * noncritical image loading is delegated to IntersectionObserver or scheduled
     * pre-warming rather than synchronously calling forceLoad() during navigation.
     *
     * @param {NodeList|HTMLElement[]} newCards - Array or NodeList of .media-card elements
     * @param {boolean} [eagerLoad=false] - If true, immediately triggers image fetch
     * =========================================================================
     */
    _hookGridCards(newCards, eagerLoad = false) {
        if (!newCards || !newCards.length) return;

        // Skip lazy loading when in direct/paginated mode (< 60 items)
        const skipLazy = !this.state.isInfinite && this.state.limit < 60;

        /*
         * Iterate through all newly inserted card elements and connect them
         * to the lightweight observers without blocking critical navigation.
         */
        for (let i = 0; i < newCards.length; i++) {
            const card = newCards[i];
            const img = card.querySelector('img[data-src]');
            if (img) {
                if (eagerLoad) {
                    // Eagerly force-load initial visible cards on initial render
                    lazyLoader.forceLoad(img, true);
                } else if (!skipLazy && lazyLoader && lazyLoader.observer) {
                    // Observe through IntersectionObserver for smooth lookahead loading
                    lazyLoader.observer.observe(img);
                }
            }
            // Register shimmer skeleton with pause observer to conserve TV GPU layers
            const shimmer = card.querySelector('.card-image.skeleton-shimmer');
            if (shimmer && lazyLoader && lazyLoader._shimmerObserver) {
                lazyLoader._shimmerObserver.observe(shimmer);
            }
        }
    }

    /**
     * =========================================================================
     * GRID CHUNK FORWARDER (backward compatibility)
     * =========================================================================
     * Delegates directly to _syncVirtualGrid to maintain compatibility with any
     * legacy callers without mutating the DOM destructively or forcing reflows.
     * =========================================================================
     */
    _appendGridChunk(grid, items, columns) {
        if (!grid || !items || !items.length) return false;

        // Keep container height strictly synchronized with newly available total records
        const rowHeight = this.state.gridCardRowHeight || this._measureGridRowHeight(grid, columns) || 350;
        const totalRows = Math.ceil(items.length / (columns || 1));
        grid.style.height = `${totalRows * rowHeight}px`;

        const currentRow = this._currentEndRow != null ? this._currentEndRow + 1 : 0;
        this._syncVirtualGrid(currentRow);
        return (this._currentEndRow || 0) < totalRows - 1;
    }

    /**
     * =========================================================================
     * GRID CHUNK PREPENDER (backward compatibility)
     * =========================================================================
     * Delegates directly to _syncVirtualGrid to maintain compatibility with any
     * legacy callers without mutating the DOM destructively or forcing reflows.
     * =========================================================================
     */
    _prependGridChunk(grid, items, columns) {
        if (!grid || !items || !items.length) return false;

        // Keep container height strictly synchronized with newly available total records
        const rowHeight = this.state.gridCardRowHeight || this._measureGridRowHeight(grid, columns) || 350;
        const totalRows = Math.ceil(items.length / (columns || 1));
        grid.style.height = `${totalRows * rowHeight}px`;

        const currentRow = this._currentStartRow != null ? Math.max(0, this._currentStartRow - 1) : 0;
        this._syncVirtualGrid(currentRow);
        return (this._currentStartRow || 0) > 0;
    }

    /**
     * =========================================================================
     * SCHEDULE GRID EVALUATION (shared by focus:changed + scroll)
     * =========================================================================
     * Single rAF-backed evaluation point that handles both D-pad navigation
     * (via _gridFocusElement) and mouse/magic remote scrolling (via
     * _gridScrollTop). Uses one pending flag + one rAF ID so at most one
     * evaluation executes per frame, regardless of how many input events fire.
     *
     * Both focus:changed and scroll handlers delegate to this method, storing
     * their latest input on shared state before scheduling. The downstream
     * _evaluateGrid() reads the most current values from both sources.
     * =========================================================================
     */
    _scheduleGridEval() {
        if (this._gridEvalPending) return;
        this._gridEvalPending = true;
        this._gridEvalFrameId = requestAnimationFrame(() => {
            this._gridEvalFrameId = null;
            this._gridEvalPending = false;
            this._evaluateGrid();
        });
    }

    /**
     * =========================================================================
     * GRID WINDOW EXPANSION FOR TARGET FOCUS ITEM
     * =========================================================================
     * Ensures that the target focus item AND a healthy forward buffer of rows
     * ahead of it (below it in the viewport) are rendered in the DOM.
     *
     * Without appending forward buffer rows, focus lands on the very last card
     * in the rendered window, leaving the rest of the screen below it completely
     * blank and empty until the user scrolls or moves.
     *
     * @param {string|null} targetId - Item ID to locate
     * @param {number} [targetIndex=-1] - Optional fallback index
     * @returns {number} The resolved itemIndex, or -1 if not found
     * =========================================================================
     */
    _ensureGridWindowEncompassesItem(targetId, targetIndex = -1) {
        // Guard: Verify grid and item collection exist
        const grid = this.$('#library-grid');
        if (!grid || !this.state.items || !this.state.items.length) {
            return -1;
        }

        const columns = this.state._gridColumns || 7;
        let itemIndex = -1;

        // Locate item index by unique ID
        if (targetId) {
            const targetStr = String(targetId);
            itemIndex = this.state.items.findIndex(
                (item) => String(item.Id) === targetStr || String(item.id) === targetStr
            );
        }

        // Fallback to numeric index if ID match failed
        if (itemIndex < 0 && targetIndex >= 0 && targetIndex < this.state.items.length) {
            itemIndex = targetIndex;
        }

        // Item could not be located in current items array
        if (itemIndex < 0) {
            return -1;
        }

        // Synchronize virtual row pool directly to encompass the target card
        const currentRow = Math.floor(itemIndex / columns);
        this._syncVirtualGrid(currentRow, itemIndex);

        // Pre-emptively record target item index so the focus direction evaluator starts from this card
        this._lastFocusItemIndex = itemIndex;

        // Proactively stream next batch if approaching end of loaded array in infinite mode
        const prefetchThreshold = this.state.items.length - columns * 4;
        const hasMore =
            this.state._hasMoreInfinite !== false &&
            (!this.state.totalRecordCount || this.state.items.length < this.state.totalRecordCount);
        if (this.state.isInfinite && itemIndex >= prefetchThreshold && hasMore) {
            this._loadNextInfiniteBatch();
        }

        return itemIndex;
    }

    /**
     * =========================================================================
     * EVALUATE GRID BOUNDARIES (merged focus + scroll evaluation)
     * =========================================================================
     * Runs at most once per frame via _scheduleGridEval(). Evaluates grid
     * append/prepend boundaries based on the user's current position.
     *
     * CRITICAL PRIORITY: If a scroll event is pending (_gridScrollTop is not
     * null), the SCROLL-based evaluation runs. This is the correct priority
     * for webOS magic-remote / mouse-wheel users who scroll WITHOUT changing
     * focus: focus:changed never fires during their scrolling, so focus-based
     * evaluation alone would never append rows and the grid would appear
     * stuck at its initial chunk (the reported "only 5 rows" bug).
     *
     * When no scroll input is pending, focus-based evaluation (D-pad)
     * determines the position instead.
     * =========================================================================
     */
    _evaluateGrid() {
        const grid = this.$('#library-grid');
        if (!grid || !document.contains(grid)) return;

        const currentColumns = this.state._gridColumns;
        if (!currentColumns) return;

        const scrollContainer = this.$('#library-scroll-container') || this.el?.querySelector('.page-content');
        const focusedElement = this._gridFocusElement;

        // Guard against grid window eviction and recalculation while focus restoration is in progress
        if (this._isRestoringFocus) {
            return;
        }

        // ------------------------------------------------------------------
        // PRIORITY 1: Focus-based evaluation (D-pad navigation)
        // ------------------------------------------------------------------
        // When navigation is driven by D-pad, the user's active focus element
        // is the single source of truth for viewport positioning.
        // Intermediate scroll events fired by smooth scrolling during D-pad
        // moves represent mid-flight animations, NOT the user's intended position.
        // Deriving grid boundaries from mid-flight scrollTop during smooth scroll
        // would evict the very rows the user is scrolling towards!
        // ------------------------------------------------------------------
        if (this._pendingFocusEval && focusedElement && grid.contains(focusedElement)) {
            this._pendingFocusEval = false;
            this._gridScrollTop = null; // Consume scroll input so mid-flight animation doesn't desync window
            this._pendingScrollEval = false;

            const allCards = grid.querySelectorAll('.media-card');
            let domIndex = -1;
            for (let i = 0; i < allCards.length; i++) {
                if (allCards[i] === focusedElement) {
                    domIndex = i;
                    break;
                }
            }
            if (domIndex >= 0) {
                const itemIndex = this.state.gridWindowStart + domIndex;

                // Direction isolation: only append when moving down,
                // only prepend when moving up (prevents oscillation)
                this._lastFocusItemIndex = itemIndex;

                // Proactively stream next batch silently when within 10 rows of end of loaded array
                const prefetchThreshold = this.state.items.length - currentColumns * 10;
                const hasMore =
                    this.state._hasMoreInfinite !== false &&
                    (!this.state.totalRecordCount || this.state.items.length < this.state.totalRecordCount);
                if (this.state.isInfinite && itemIndex >= prefetchThreshold && hasMore) {
                    this._loadNextInfiniteBatch(true);
                } else if (this.state.isInfinite && hasMore) {
                    // Reschedule background idle prefetch so pipeline stays ahead
                    this._scheduleLibraryIdlePrefetch(500);
                }

                const currentRow = Math.floor(itemIndex / currentColumns);
                // Synchronize virtual row pool directly to active row and card
                this._syncVirtualGrid(currentRow, itemIndex);
                return;
            }
        }

        // ------------------------------------------------------------------
        // PRIORITY 2: Scroll-based evaluation (mouse wheel / magic remote / touch)
        // ------------------------------------------------------------------
        // Runs when scrolling without changing D-pad focus (webOS magic remote,
        // mouse wheel, or touch fling). Focus:changed does not fire during wheel
        // scrolling, so scroll position determines grid window bounds and chunk loading.
        // ------------------------------------------------------------------
        if (scrollContainer && this._gridScrollTop !== null) {
            // Guard: If programmatic vertical scroll animation is actively in flight,
            // ignore intermediate scroll events so we do not evict cards based on transient coordinates.
            if (scrollController.isVerticalAnimating && focusedElement && grid.contains(focusedElement)) {
                this._gridScrollTop = null;
                this._pendingScrollEval = false;
                return;
            }

            const scrollTop = this._gridScrollTop;
            this._gridScrollTop = null; // Consume the scroll input
            this._pendingScrollEval = false;

            const rowHeight = this.state.gridCardRowHeight || this._measureGridRowHeight(grid, currentColumns) || 350;

            // Direction tracking
            this._lastGridScrollTop = scrollTop;

            // Calculate grid container top offset relative to scrollContainer
            let gridTop = 0;
            let el = grid;
            while (el && el !== scrollContainer && el !== document.body) {
                gridTop += el.offsetTop || 0;
                el = el.offsetParent;
            }

            const scrolledPastGridTop = Math.max(0, scrollTop - gridTop);
            const totalRows = Math.ceil(this.state.items.length / currentColumns);
            const derivedRow = Math.min(totalRows - 1, Math.floor(scrolledPastGridTop / rowHeight));

            // Keep the focus-based direction cursor in sync if a card is currently focused
            let focusedIndex = null;
            if (focusedElement && grid.contains(focusedElement)) {
                const allCards = grid.querySelectorAll('.media-card');
                for (let i = 0; i < allCards.length; i++) {
                    if (allCards[i] === focusedElement) {
                        focusedIndex = this.state.gridWindowStart + i;
                        this._lastFocusItemIndex = focusedIndex;
                        break;
                    }
                }
            }

            // Proactively stream next batch silently when within 10 rows of end of loaded array
            const hasMoreToFetch =
                this.state._hasMoreInfinite !== false &&
                (!this.state.totalRecordCount || this.state.items.length < this.state.totalRecordCount);
            if (this.state.isInfinite && totalRows - derivedRow <= 10 && hasMoreToFetch) {
                this._loadNextInfiniteBatch(true);
            } else if (this.state.isInfinite && hasMoreToFetch) {
                // Reschedule background idle prefetch while scrolling
                this._scheduleLibraryIdlePrefetch(500);
            }

            if (derivedRow >= 0 && derivedRow < totalRows) {
                const targetIndexForSync = !this._isManualScroll && focusedIndex !== null ? focusedIndex : null;
                this._syncVirtualGrid(derivedRow, targetIndexForSync);
            }
        }
    }

    /**
     * =========================================================================
     * O(1) NODE RECYCLING VIRTUAL GRID SYNCHRONIZER
     * =========================================================================
     * Synchronizes the fixed DOM row pool (.virtual-grid-row) with the active
     * viewport position. Instead of allocating/destroying DOM cards or adjusting
     * flex spacer heights, off-screen row elements are detached and repositioned
     * to the opposite boundary using pure CSS position: absolute.
     *
     * • Downward navigation: The top off-screen row is detached, re-pointed to
     *   the new bottom row, populated with new cards, and appended to the grid.
     * • Upward navigation: The bottom off-screen row is detached, re-pointed to
     *   the new top row, populated with new cards, and prepended before row 0.
     * • Batch jumps (alphabet rail / fast page navigation): Pool rows are
     *   re-indexed in a single linear pass around the target row without
     *   intermediate layout thrashing.
     *
     * Because DOM rows are moved in and out of the grid element in strict
     * sequential order, FocusManager's querySelectorAll('.media-card') remains
     * perfectly sorted in row-major order across the entire rendered window.
     *
     * @param {number} currentRow - The active row index (0-based)
     * @param {number|null} [targetItemIndex=null] - Specific focused item index
     * =========================================================================
     */
    _syncVirtualGrid(currentRow, targetItemIndex = null) {
        const grid = this.$('#library-grid');
        const items = this.state.items;
        const columns = this.state._gridColumns;
        if (!grid || !items || !items.length || !columns) return;

        // Synchronize real-time Alphabet Rail button indicator
        this._updateAlphaPickerActiveLetter(currentRow, items, columns, targetItemIndex);

        const totalRows = Math.ceil(items.length / columns);
        const isListView = this.state.viewMode === 'list';
        const isSkipLazy = !this.state.isInfinite && this.state.limit < 60;
        const POOL_ROWS = isSkipLazy ? totalRows : isListView ? 22 : 10;

        // If total rows fit entirely within the pool (or skip lazy mode is active),
        // all cards exist in the DOM and no row recycling is needed.
        if (isSkipLazy || totalRows <= POOL_ROWS) {
            return;
        }

        const BUFFER_ABOVE = isListView ? 6 : 3;
        const poolRows = Math.min(totalRows, POOL_ROWS);
        const rowHeight = this.state.gridCardRowHeight || this._measureGridRowHeight(grid, columns) || 350;

        // Compute ideal start and end row indices bounded within valid library range
        let idealStartRow = Math.max(0, currentRow - BUFFER_ABOVE);
        let idealEndRow = idealStartRow + poolRows - 1;
        if (idealEndRow >= totalRows) {
            idealEndRow = totalRows - 1;
            idealStartRow = Math.max(0, idealEndRow - poolRows + 1);
        }

        let startRow = this._currentStartRow != null ? this._currentStartRow : 0;
        let endRow = this._currentEndRow != null ? this._currentEndRow : startRow + poolRows - 1;

        // Guard: If the pool already encompasses the ideal window, no DOM mutation needed
        if (startRow === idealStartRow && endRow === idealEndRow) {
            return;
        }

        const rowNodes = grid.querySelectorAll('.virtual-grid-row');
        if (!rowNodes.length) return;

        // Detect large jumps (e.g. alphabet letter jump or fast page scroll)
        // If the jump delta exceeds half the pool, perform an O(N) full re-index
        if (Math.abs(idealStartRow - startRow) >= Math.floor(poolRows / 2)) {
            const rowsArray = Array.from(rowNodes);
            for (let i = 0; i < rowsArray.length; i++) {
                const targetRowIndex = idealStartRow + i;
                const rowEl = rowsArray[i];
                const rowStart = targetRowIndex * columns;
                const rowEnd = Math.min(items.length, (targetRowIndex + 1) * columns);
                const chunkItems = items.slice(rowStart, rowEnd);

                rowEl.dataset.rowIndex = targetRowIndex;
                rowEl.style.top = `${targetRowIndex * rowHeight}px`;
                rowEl.innerHTML = this._buildGridChunkHtml(chunkItems);
                delete rowEl.dataset.skeleton;
                rowEl.removeAttribute('data-skeleton');
            }

            this._currentStartRow = idealStartRow;
            this._currentEndRow = idealStartRow + rowsArray.length - 1;
            this.state.gridWindowStart = idealStartRow * columns;
            this.state.gridWindowEnd = Math.min(items.length, (this._currentEndRow + 1) * columns);

            this._hookGridCards(grid.querySelectorAll('.media-card'), false);
            // Restore focus/navigation state immediately across the re-indexed grid
            focusManager.invalidateCache('library-grid');
            // Schedule speculative lookahead image pre-warm after the navigation frame settles
            this._schedulePreWarm(this._currentEndRow + 1, 1);
            return;
        }

        // Incremental recycling for continuous scrolling and step-by-step D-pad navigation
        let domChanged = false;

        // Navigate DOWN: recycle top rows to the bottom
        while (startRow < idealStartRow && endRow < totalRows - 1) {
            const topRow = grid.firstElementChild;
            if (!topRow || !topRow.classList.contains('virtual-grid-row')) break;

            const nextRowIndex = endRow + 1;
            const rowStart = nextRowIndex * columns;
            const rowEnd = Math.min(items.length, (nextRowIndex + 1) * columns);
            const chunkItems = items.slice(rowStart, rowEnd);

            topRow.dataset.rowIndex = nextRowIndex;
            topRow.style.top = `${nextRowIndex * rowHeight}px`;
            topRow.innerHTML = this._buildGridChunkHtml(chunkItems);
            delete topRow.dataset.skeleton;
            topRow.removeAttribute('data-skeleton');

            // Detach and append to the bottom to maintain ascending row-major order
            grid.appendChild(topRow);

            startRow++;
            endRow++;
            domChanged = true;

            // Register cards with observers without synchronous image force-load
            this._hookGridCards(topRow.querySelectorAll('.media-card'), false);
        }

        // Navigate UP: recycle bottom rows to the top
        while (startRow > idealStartRow && startRow > 0) {
            const bottomRow = grid.lastElementChild;
            if (!bottomRow || !bottomRow.classList.contains('virtual-grid-row')) break;

            const prevRowIndex = startRow - 1;
            const rowStart = prevRowIndex * columns;
            const rowEnd = Math.min(items.length, (prevRowIndex + 1) * columns);
            const chunkItems = items.slice(rowStart, rowEnd);

            bottomRow.dataset.rowIndex = prevRowIndex;
            bottomRow.style.top = `${prevRowIndex * rowHeight}px`;
            bottomRow.innerHTML = this._buildGridChunkHtml(chunkItems);
            delete bottomRow.dataset.skeleton;
            bottomRow.removeAttribute('data-skeleton');

            // Detach and prepend before the first row to maintain ascending order
            grid.insertBefore(bottomRow, grid.firstElementChild);

            startRow--;
            endRow--;
            domChanged = true;

            // Register cards with observers without synchronous image force-load
            this._hookGridCards(bottomRow.querySelectorAll('.media-card'), false);
        }

        this._currentStartRow = startRow;
        this._currentEndRow = endRow;
        this.state.gridWindowStart = startRow * columns;
        this.state.gridWindowEnd = Math.min(items.length, (endRow + 1) * columns);

        if (domChanged) {
            // Restore focus/navigation state immediately across the recycled grid
            focusManager.invalidateCache('library-grid');
            // Schedule speculative lookahead image pre-warming after the navigation frame
            this._schedulePreWarm(endRow + 1, 1);
        }
    }

    /**
     * Backward-compatible alias for legacy callers
     */
    _syncGridWindow(grid, items, columns, currentRow, targetItemIndex = null) {
        this._syncVirtualGrid(currentRow, targetItemIndex);
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

        // Update Alpha Picker for rows layout
        if (rows.length > 0) {
            const isRightPosRows = layoutManager.getAlphaPickerPosition() === 'right';
            if (isRightPosRows) {
                this.registerFocusSection('alpha-picker', this.$('#alpha-picker'), {
                    orientation: 'vertical',
                    leaveUp: this._isSubView() ? null : 'library-controls',
                    leaveDown: null,
                    leaveLeft: 'row-0',
                    leaveRight: null,
                    enterTo: 'active-element'
                });
            } else {
                this.registerFocusSection('alpha-picker', this.$('#alpha-picker'), {
                    orientation: 'horizontal',
                    leaveUp: this._isSubView() ? null : 'library-controls',
                    leaveDown: 'row-0',
                    leaveLeft: 'sidebar',
                    leaveRight: null,
                    enterTo: 'active-element'
                });
            }

            // Update library-controls to point to first row
            this.registerFocusSection('library-controls', this.$('#library-controls'), {
                orientation: 'horizontal',
                leaveUp: this._isSubView() ? null : 'library-tabs',
                leaveDown: 'row-0', // Direct to first row for Genres view
                leaveLeft: 'sidebar',
                leaveRight: isRightPosRows ? 'alpha-picker' : null,
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

        // Rehydrate view mode and grid column preferences for the selected tab
        this._loadPersistedViewMode();

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

        /* -----------------------------------------------------------------
         * UNLIMITED SCROLL MODE QUICK-JUMP
         * In unlimited mode, instead of wiping out the library to request only
         * items starting with the selected letter, we scroll smoothly to that
         * letter's section in the full library.
         * ----------------------------------------------------------------- */
        const isScrollMode = this.state.isInfinite && storage.getItem('pref:alphaPickerScrollMode') !== 'false';
        if (isScrollMode) {
            await this._scrollToLetter(char);
            return;
        }

        if (this.state.nameStartsWith === char) {
            // Toggle off
            this.state.nameStartsWith = null;
        } else {
            this.state.nameStartsWith = char; // Store literal char ('#', 'A', etc.)
        }

        this.state.startIndex = 0;

        // Keep URL parameters in sync so pagination and state preserve the selected letter
        if (this.params.page) {
            delete this.params.page;
        }
        if (this.state.nameStartsWith) {
            this.params.char = this.state.nameStartsWith;
        } else {
            delete this.params.char;
        }

        // Update UI
        this._renderAlphaPicker();

        // Restore focus to the selected char
        const newBtn = this.$(`.alpha-btn[data-char="${char}"]`);
        if (newBtn) {
            focusManager.focusElement(newBtn);
        }

        await this._loadItems();

        // Scroll to top of content
        const scrollContainer = this.$('#library-scroll-container');
        if (scrollContainer) scrollContainer.scrollTop = 0;

        // Automatically transfer focus to the first card matching this letter
        const firstCard = this.$('#library-grid .media-card');
        if (firstCard) {
            focusManager.focusElement(firstCard);
        }
    }

    /**
     * =========================================================================
     * SCROLL TO LETTER (Alphabet Quick-Jump in Unlimited Scroll Mode)
     * =========================================================================
     * In unlimited mode, smoothly glides the viewport directly to the exact
     * letter section using mathematically precise server offsets and real DOM
     * geometry. Retargets seamlessly if the user rapidly scrubs across letters,
     *
     * Eliminates "letter above" issues by aligning to the exact DOM card rect
     * and guarantees no dropped clicks via sequence tokens.
     *
     * @param {string} char - Target character ('#' or 'A'-'Z')
     * =========================================================================
     */
    async _scrollToLetter(char) {
        if (!char || this._isDestroyed) return;

        // Sequence token to handle rapid user clicks without dropping or racing
        const currentSeq = ++this._scrollLetterSeq;

        // Visual feedback on the alphabet picker buttons immediately
        this.state.scrollAlphaChar = char;
        const allBtns = this.$('#alpha-picker')?.querySelectorAll('.alpha-btn');
        allBtns?.forEach((b) => b.classList.toggle('active', b.dataset.char === char));

        // Set target scroll letter lock so intermediate scroll events don't flicker the highlight
        this._targetScrollLetter = char;

        const grid = this.$('#library-grid');
        const scrollContainer = this.$('#library-scroll-container') || this.el?.querySelector('.page-content');
        if (!grid || !scrollContainer) return;

        const columns = this.state._gridColumns || 7;
        const isListView = this.state.viewMode === 'list';
        const ROWS_BELOW = isListView ? 20 : 10;

        // ---------------------------------------------------------------------
        // STEP 1: Determine exact 0-based target index in the full library
        // ---------------------------------------------------------------------
        let targetIndex = -1;

        if (char === '#') {
            targetIndex = 0;
        } else if (this._letterOffsetCache && this._letterOffsetCache.has(char)) {
            targetIndex = this._letterOffsetCache.get(char);
        } else if (this._lastFetchContext?.params) {
            try {
                this._showInfiniteLoading(true);

                const countParams = {
                    ...this._lastFetchContext.params,
                    SortBy: 'SortName',
                    SortOrder: 'Ascending',
                    NameLessThan: char,
                    Limit: 0,
                    EnableTotalRecordCount: true
                };
                delete countParams.StartIndex;
                delete countParams.NameStartsWith;

                let countRes = null;
                if (this._lastFetchContext.viewType === 'AlbumArtists') {
                    countRes = await api.getAlbumArtists(countParams);
                } else if (this._lastFetchContext.viewType === 'Artists') {
                    countRes = await api.getMusicArtists(countParams);
                } else {
                    countRes = await api.getItems(countParams);
                }

                if (countRes && typeof countRes.TotalRecordCount === 'number') {
                    targetIndex = countRes.TotalRecordCount;
                    if (!this._letterOffsetCache) this._letterOffsetCache = new Map();
                    this._letterOffsetCache.set(char, targetIndex);
                }
            } catch (err) {
                log.warn('Failed to query letter offset from server:', err);
            } finally {
                this._showInfiniteLoading(false);
            }
        }

        // Check if a newer letter click arrived while we were querying the server
        if (currentSeq !== this._scrollLetterSeq || this._isDestroyed) return;

        // Fallback: If server offset query failed, scan currently loaded items using normalized characters
        if (targetIndex < 0) {
            targetIndex = this._findTargetCharIndex(this.state.items, char);
        }

        // ---------------------------------------------------------------------
        // STEP 2: Fetch missing items up to targetIndex + healthy forward buffer
        // ---------------------------------------------------------------------
        // When jumping to a letter, ensure we have at least 6-8 full rows loaded
        // AFTER the target card so the viewport below it is fully populated with media.
        const forwardBuffer = (ROWS_BELOW + 4) * columns;
        const minItemsNeeded = targetIndex + forwardBuffer;

        if (
            targetIndex >= 0 &&
            this.state.items.length < minItemsNeeded &&
            this.state.items.length < (this.state.totalRecordCount || 0)
        ) {
            this._showInfiniteLoading(true);
            try {
                const batchSize = this.state.limit || 100;
                const needed = Math.max(batchSize, minItemsNeeded - this.state.items.length + batchSize);
                const fetchedItems = await this._fetchItemsBatch(this.state.items.length, needed);

                // Check again for newer letter request before modifying state
                if (currentSeq !== this._scrollLetterSeq || this._isDestroyed) return;

                if (fetchedItems && fetchedItems.length > 0) {
                    this.state.items = this.state.items.concat(fetchedItems);
                    const collectionType = this.state.libraryInfo?.CollectionType;
                    if ((collectionType === 'playlists' || collectionType === 'boxsets') && fetchedItems.length > 0) {
                        await this._enrichCollectionItems(fetchedItems, collectionType);
                    }
                }

                const countIndicator = this.$('#count-indicator');
                if (countIndicator) {
                    const total = this.state.totalRecordCount || this.state.items.length;
                    countIndicator.textContent = i18n.t('ListPaging', [1, this.state.items.length, total]);
                }
            } catch (err) {
                log.warn('Error fetching items for letter jump:', err);
            } finally {
                this._showInfiniteLoading(false);
            }
        }

        // Final cancellation check before DOM reconstruction
        if (currentSeq !== this._scrollLetterSeq || this._isDestroyed) return;

        // Clamp targetIndex within loaded bounds
        if (targetIndex < 0 || targetIndex >= this.state.items.length) {
            targetIndex = Math.max(0, Math.min(targetIndex, this.state.items.length - 1));
        }

        // ---------------------------------------------------------------------
        // STEP 3: Reposition recycled virtual row pool around target row
        // ---------------------------------------------------------------------
        // Calculate the target row coordinate and compute the total required
        // pixel height for the entire collection geometry upfront.
        const targetRow = Math.floor(targetIndex / columns);
        const rowHeight = this.state.gridCardRowHeight || this._measureGridRowHeight(grid, columns) || 350;
        const totalRows = Math.ceil(this.state.items.length / columns);

        // Keep container height strictly synchronized with total items
        grid.style.height = `${totalRows * rowHeight}px`;

        /*
         * Recycle and populate virtual rows to position targetRow firmly
         * within the active rendered window. For jumps across distant letter
         * boundaries, _syncVirtualGrid detects the large row delta and executes
         * a clean single-pass batch re-index without destroying or recreating
         * DOM row nodes.
         */
        this._syncVirtualGrid(targetRow, targetIndex);

        // Invalidate spatial navigation cache so FocusManager recognizes newly mapped cards
        focusManager.invalidateCache('library-grid');

        // ---------------------------------------------------------------------
        // STEP 4: Smoothly glide viewport to target position using exact DOM coordinates
        // ---------------------------------------------------------------------
        let targetScrollTop = 0;

        // Ensure bottom scroll clearance is active so any row can scroll fully to the top
        if (this.state.isInfinite && grid.style.paddingBottom !== 'calc(100vh - 250px)') {
            grid.style.paddingBottom = 'calc(100vh - 250px)';
        }

        // Query active cards rendered in the virtualized grid viewport
        const allCards = grid.querySelectorAll('.media-card');
        const cardDomIndex = targetIndex - this.state.gridWindowStart;

        // Eagerly force-load posters for visible and upcoming cards (target row + forward buffer)
        // so media appears instantly without waiting on IntersectionObserver
        const visibleEnd = Math.min(allCards.length, Math.max(0, cardDomIndex) + columns * 4);
        for (let i = Math.max(0, cardDomIndex); i < visibleEnd; i++) {
            const img = allCards[i].querySelector('img[data-src]');
            if (img) lazyLoader.forceLoad(img);
        }
        if (this.state.isInfinite || this.state.limit >= 60) {
            lazyLoader.observe(grid);
        }

        // Resolve target card either by computed index offset or unique item identifier
        let targetCard =
            cardDomIndex >= 0 && cardDomIndex < allCards.length
                ? allCards[cardDomIndex]
                : grid.querySelector(`.media-card[data-item-id="${this.state.items[targetIndex]?.Id}"]`);

        // Millimeter-precise alignment: anchor the target card's row firmly at the top of the viewport
        if (targetCard) {
            const cardRect = targetCard.getBoundingClientRect();
            const containerRect = scrollContainer.getBoundingClientRect();
            // Position card top 20px below container top (clean margin for poster glow/shadow)
            targetScrollTop = Math.max(
                0,
                Math.round(scrollContainer.scrollTop + (cardRect.top - containerRect.top) - 20)
            );
        } else {
            // Robust fallback: traverse parent hierarchy to calculate exact grid top relative to scrollContainer
            let gridTop = 0;
            let el = grid;
            while (el && el !== scrollContainer) {
                gridTop += el.offsetTop || 0;
                el = el.offsetParent;
            }
            targetScrollTop = Math.max(0, Math.round(gridTop + targetRow * rowHeight - 20));
            if (allCards.length > 0) {
                targetCard = allCards[0];
            }
        }

        // Cache last known positions for spatial focus tracking
        this._lastGridScrollTop = targetScrollTop;
        this._lastFocusItemIndex = targetIndex;

        // Execute smooth fluid scroll animation to target offset
        scrollController.smoothScrollTo(scrollContainer, targetScrollTop, 250, 'vertical');

        /* -----------------------------------------------------------------
         * Direct Focus Hand-off:
         * Immediately focuses the target card with skipScroll: true so the
         * fluid scroll animation glides seamlessly while giving the
         * user immediate D-pad and action control over the item.
         * ----------------------------------------------------------------- */
        if (targetCard) {
            focusManager.focusElement(targetCard, { skipScroll: true });
        }
    }

    /**
     * =========================================================================
     * UPDATE ALPHA PICKER ACTIVE LETTER ON SCROLL
     * =========================================================================
     * Dynamically synchronizes the active highlighted letter button on the
     * alphabet selector rail as the user scrolls through the full library in
     * unlimited mode for real-time positional scrubbing.
     *
     * @param {number} currentRow - 0-based row index currently at viewport top
     * @param {Array} items - Full items array
     * @param {number} columns - Grid column count
     * =========================================================================
     */
    _updateAlphaPickerActiveLetter(currentRow, items, columns, targetItemIndex = null) {
        // Only active in unlimited mode with alpha scroll mode enabled
        const isScrollMode = this.state.isInfinite && storage.getItem('pref:alphaPickerScrollMode') !== 'false';
        if (!isScrollMode || !items || !items.length) return;

        // If a programmatic smooth scroll jump is currently in flight, keep the targeted letter locked
        if (scrollController.isVerticalAnimating && this._targetScrollLetter) {
            return;
        }
        this._targetScrollLetter = null;

        // Resolve item: prefer explicit item index if provided (e.g. active D-pad focus cursor)
        let item = null;
        if (targetItemIndex !== null && targetItemIndex >= 0 && targetItemIndex < items.length) {
            item = items[targetItemIndex];
        } else {
            // Check if user is navigating with D-pad and currently has a card focused
            const focused = focusManager.getFocused() || this._gridFocusElement;
            const grid = this.$('#library-grid');
            if (
                !this._isManualScroll &&
                focused &&
                grid &&
                grid.contains(focused) &&
                focused.classList.contains('media-card')
            ) {
                // Determine item from focused card
                if (
                    this._lastFocusItemIndex !== null &&
                    this._lastFocusItemIndex >= 0 &&
                    this._lastFocusItemIndex < items.length
                ) {
                    item = items[this._lastFocusItemIndex];
                } else {
                    const itemId = focused.dataset?.itemId;
                    if (itemId) {
                        item = items.find((it) => it.Id === itemId);
                    }
                }
            }

            // Fallback for manual scrolling (mouse wheel, magic remote, touch fling, or focus outside grid):
            // resolve first item on or near current visible row
            if (!item) {
                const itemIndex = Math.min(items.length - 1, Math.max(0, currentRow * columns));
                item = items[itemIndex];
            }
        }
        if (!item) return;

        // Extract normalized letter
        let char = this._getItemSortChar(item);
        if (!char || char < 'A' || char > 'Z') {
            char = '#';
        }

        // Only update DOM when the active letter actually changes
        if (this.state.scrollAlphaChar !== char) {
            this.state.scrollAlphaChar = char;
            const picker = this.$('#alpha-picker');
            if (picker) {
                const allBtns = picker.querySelectorAll('.alpha-btn');
                allBtns.forEach((b) => b.classList.toggle('active', b.dataset.char === char));
            }
        }
    }

    /**
     * =========================================================================
     * GET ITEM SORT CHAR
     * =========================================================================
     * Extracts the normalized first comparison character from an item for alphabet
     * rail indexing and quick-jump positioning.
     *
     * Jellyfin Server Collation Rules:
     * - Uses server-calculated SortName first (which preserves special characters
     *   such as brackets, parentheses, and punctuation at the start of titles).
     * - If SortName was not returned, strips common leading articles ("The ", "A ", "An ")
     *   from Name as a client-side fallback.
     * - Leading non-alphabetic characters (e.g. parentheses "(T)Raumschiff", brackets
     *   "[REC]", punctuation, numbers) are NOT stripped: in Jellyfin's ascending collation
     *   they sort before 'A' and belong to the '#' bucket.
     *
     * @param {Object} item - Media item object
     * @returns {string} Normalized uppercase character ('A'-'Z' or '#')
     * =========================================================================
     */
    _getItemSortChar(item) {
        if (!item) return '';

        // Prioritize server-calculated SortName, falling back to Name
        let name = (item.SortName || item.Name || '').trim();

        // If SortName was not provided by the API, strip common English leading articles
        if (!item.SortName && name) {
            const match = name.match(/^(the|a|an)\s+/i);
            if (match) {
                name = name.slice(match[0].length).trim();
            }
        }

        if (!name) return '#';

        // Extract first character and strip combining diacritics/accents (e.g., 'É' -> 'E')
        const firstChar = name
            .charAt(0)
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toUpperCase();

        // Any non-alphabetic character (numbers, brackets, punctuation, symbols) belongs to '#'
        if (firstChar < 'A' || firstChar > 'Z') {
            return '#';
        }

        return firstChar;
    }

    /**
     * =========================================================================
     * FIND TARGET CHAR INDEX
     * =========================================================================
     * Fallback scanner that locates the first item matching or following the
     * target letter in the currently loaded items array.
     *
     * @param {Array} items - Array of loaded library items
     * @param {string} char - Target character ('#' or 'A'-'Z')
     * @returns {number} 0-based index in items, or -1 if not found
     * =========================================================================
     */
    _findTargetCharIndex(items, char) {
        if (!items || !items.length) return -1;

        if (char === '#') {
            // Locate the first item categorized under '#' (numbers, symbols, brackets)
            const idx = items.findIndex((item) => {
                const firstChar = this._getItemSortChar(item);
                return firstChar === '#' || (firstChar && (firstChar < 'A' || firstChar > 'Z'));
            });
            return idx !== -1 ? idx : 0;
        }

        const targetChar = char.toUpperCase();

        // 1. Direct match: first item starting with this letter
        const exactIdx = items.findIndex((item) => {
            return this._getItemSortChar(item) === targetChar;
        });
        if (exactIdx !== -1) return exactIdx;

        // 2. Nearest successor match: first item starting with a letter greater than target
        const nextIdx = items.findIndex((item) => {
            const firstChar = this._getItemSortChar(item);
            return firstChar >= 'A' && firstChar <= 'Z' && firstChar > targetChar;
        });

        return nextIdx;
    }

    /**
     * =========================================================================
     * INFINITE SCROLL BATCH FETCHER
     * =========================================================================
     * Requests the subsequent slice of items from the server using the identical
     * active query parameters (filters, sorting, parent collection) as the initial load.
     * @param {number} startIndex - Starting offset
     * @param {number} limit - Number of items to fetch
     * @returns {Promise<Array>} Array of item objects
     * =========================================================================
     */
    async _fetchItemsBatch(startIndex, limit) {
        if (!this._lastFetchContext) return [];
        const ctx = this._lastFetchContext;

        if (ctx.isSeerr) {
            const seerrPage = Math.floor(startIndex / 100) + 1;
            let items = [];
            try {
                if (ctx.seerrType === 'keyword' || ctx.seerrType === 'tag' || ctx.keywordId) {
                    items =
                        ctx.mediaType === 'tv'
                            ? await seerr.discoverTv(seerrPage, {
                                  keywords: ctx.keywordId,
                                  genre: ctx.genreId,
                                  language: ctx.language,
                                  certification: ctx.certification,
                                  sortBy: ctx.seerrSortBy
                              })
                            : await seerr.discoverMovies(seerrPage, {
                                  keywords: ctx.keywordId,
                                  genre: ctx.genreId,
                                  language: ctx.language,
                                  certification: ctx.certification,
                                  sortBy: ctx.seerrSortBy
                              });
                } else if (ctx.genreId || ctx.language || ctx.certification || ctx.seerrType === 'genre') {
                    items =
                        ctx.mediaType === 'tv'
                            ? await seerr.discoverTv(seerrPage, {
                                  genre: ctx.genreId,
                                  language: ctx.language,
                                  certification: ctx.certification,
                                  sortBy: ctx.seerrSortBy
                              })
                            : await seerr.discoverMovies(seerrPage, {
                                  genre: ctx.genreId,
                                  language: ctx.language,
                                  certification: ctx.certification,
                                  sortBy: ctx.seerrSortBy
                              });
                } else if (ctx.seerrType === 'studio' || ctx.studioId) {
                    items = await seerr.moviesByStudio(ctx.studioId, seerrPage);
                } else if (ctx.seerrType === 'network' || ctx.networkId) {
                    items = await seerr.tvByNetwork(ctx.networkId, seerrPage);
                } else {
                    items =
                        ctx.mediaType === 'tv'
                            ? await seerr.discoverTv(seerrPage, {
                                  language: ctx.language,
                                  certification: ctx.certification,
                                  sortBy: ctx.seerrSortBy
                              })
                            : await seerr.discoverMovies(seerrPage, {
                                  language: ctx.language,
                                  certification: ctx.certification,
                                  sortBy: ctx.seerrSortBy
                              });
                }
            } catch (err) {
                log.warn('Failed to load Seerr batch', err);
                items = [];
            }
            return items || [];
        }

        const batchParams = {
            ...ctx.params,
            StartIndex: startIndex,
            Limit: limit,
            EnableTotalRecordCount: true
        };

        let result = null;
        try {
            if (ctx.viewType === 'AlbumArtists') {
                result = await api.getAlbumArtists(batchParams);
            } else if (ctx.viewType === 'Artists') {
                result = await api.getMusicArtists(batchParams);
            } else {
                result = await api.getItems(batchParams);
            }

            if (result && typeof result.TotalRecordCount === 'number' && result.TotalRecordCount > 0) {
                this.state.totalRecordCount = result.TotalRecordCount;
            }
        } catch (err) {
            log.warn('Failed to load next items batch', err);
            return [];
        }

        return result?.Items || [];
    }

    /**
     * =========================================================================
     * LOAD NEXT INFINITE SCROLL BATCH
     * =========================================================================
     * Triggered proactively when the user scrolls near the end of the currently
     * loaded media items or via background idle prefetching. Streams the next
     * chunk, enriches metadata if needed, expands container geometry, and
     * synchronizes the virtual row pool.
     *
     * @param {boolean} [silent=false] - When true, background prefetch runs without
     * displaying the bottom activity indicator to keep scrolling uninterrupted.
     * =========================================================================
     */
    async _loadNextInfiniteBatch(silent = false) {
        if (this._isLoadingMore || this._isDestroyed) return;
        if (!this.state.isInfinite) return;
        if (this.state._hasMoreInfinite === false) return;
        if (this.state.totalRecordCount > 0 && this.state.items.length >= this.state.totalRecordCount) return;

        // If viewport is running an active scroll animation and this is a background prefetch,
        // defer the fetch until scrolling settles to keep compositor frame rates steady at 60fps.
        if (
            silent &&
            (scrollController.isVerticalAnimating ||
                (window.__scrollController && window.__scrollController.isAnimating))
        ) {
            const onScrollFinish = () => {
                eventBus.off('scroll:finished', onScrollFinish);
                if (!this._isDestroyed && !this._isLoadingMore) {
                    this._loadNextInfiniteBatch(true);
                }
            };
            eventBus.on('scroll:finished', onScrollFinish);
            return;
        }

        this._isLoadingMore = true;

        // Only display visible loading indicator when the user explicitly reaches the edge
        if (!silent) {
            this._showInfiniteLoading(true);
        }

        try {
            const startIndex = this.state.items.length;
            const batchSize = this.state.limit || 100;
            const nextItems = await this._fetchItemsBatch(startIndex, batchSize);

            if (!this._isDestroyed) {
                // If fewer items than batchSize returned, we have reached the end of the collection
                if (!nextItems || nextItems.length < batchSize) {
                    this.state._hasMoreInfinite = false;
                }

                if (nextItems && nextItems.length > 0) {
                    this.state.items = this.state.items.concat(nextItems);

                    const collectionType = this.state.libraryInfo?.CollectionType;
                    if ((collectionType === 'playlists' || collectionType === 'boxsets') && nextItems.length > 0) {
                        await this._enrichCollectionItems(nextItems, collectionType);
                    }

                    const grid = this.$('#library-grid');
                    if (grid) {
                        const columns = this.state._gridColumns || 7;
                        const rowHeight =
                            this.state.gridCardRowHeight || this._measureGridRowHeight(grid, columns) || 350;
                        const totalRows = Math.ceil(this.state.items.length / columns);

                        // Expand container height to fit the full item count geometry
                        grid.style.height = `${totalRows * rowHeight}px`;

                        // Re-sync virtual row pool to ensure the forward buffer is loaded
                        const currentRow =
                            this._lastFocusItemIndex != null
                                ? Math.floor(this._lastFocusItemIndex / columns)
                                : this._currentStartRow || 0;
                        this._syncVirtualGrid(currentRow, this._lastFocusItemIndex);

                        // Invalidate spatial navigation cache
                        focusManager.invalidateCache('library-grid');
                    }

                    const countIndicator = this.$('#count-indicator');
                    if (countIndicator) {
                        const total = this.state.totalRecordCount || this.state.items.length;
                        countIndicator.textContent = i18n.t('ListPaging', [1, this.state.items.length, total]);
                    }

                    // Pre-warm upcoming images into browser HTTP cache (scheduled after navigation frame)
                    const currentEnd = this._currentEndRow || 0;
                    this._schedulePreWarm(currentEnd + 1, 1);

                    // If collection still contains further unloaded items, schedule continuous background prefetch
                    if (
                        this.state._hasMoreInfinite &&
                        (!this.state.totalRecordCount || this.state.items.length < this.state.totalRecordCount)
                    ) {
                        this._scheduleLibraryIdlePrefetch(300);
                    }
                }
            }
        } catch (err) {
            log.warn('Error loading next infinite batch', err);
        } finally {
            this._isLoadingMore = false;
            this._showInfiniteLoading(false);
        }
    }

    /**
     * =========================================================================
     * SCHEDULE LIBRARY IDLE PREFETCH
     * =========================================================================
     * Schedules a low-priority background idle prefetch. Silently streams the
     * subsequent slice of items ahead of time so media is already decoded and
     * resident in memory before the user navigates or scrolls down to it.
     *
     * @param {number} [delay=400] - Inactivity delay in milliseconds before triggering
     * =========================================================================
     */
    _scheduleLibraryIdlePrefetch(delay = 400) {
        if (this._libraryIdlePrefetchTimer) clearTimeout(this._libraryIdlePrefetchTimer);
        this._libraryIdlePrefetchTimer = setTimeout(() => {
            this._libraryIdlePrefetchTimer = null;
            if (this._isDestroyed || !this.state.isInfinite || this.state._hasMoreInfinite === false) return;
            if (this.state.totalRecordCount > 0 && this.state.items.length >= this.state.totalRecordCount) return;

            // Defer if scroll animation is actively in flight
            if (
                scrollController.isVerticalAnimating ||
                (window.__scrollController && window.__scrollController.isAnimating)
            ) {
                const onScrollFinish = () => {
                    eventBus.off('scroll:finished', onScrollFinish);
                    if (!this._isDestroyed) {
                        this._scheduleLibraryIdlePrefetch(200);
                    }
                };
                eventBus.on('scroll:finished', onScrollFinish);
                return;
            }

            this._loadNextInfiniteBatch(true);
        }, delay);
    }

    /**
     * =========================================================================
     * SCHEDULE PROGRESSIVE IDLE IMAGE CHUNK LOADING
     * =========================================================================
     * When lazy loading is bypassed for low-page-size library grids (< 60 items),
     * we avoid flooding the network socket pool and GPU texture decoder on Frame 1
     * by loading the visible screen (first 14 cards) immediately and scheduling the
     * remaining cards in progressive batches of 10 during idle browser intervals.
     *
     * Falls back to a 50ms timer chain on older smart TV engines lacking
     * native window.requestIdleCallback support.
     *
     * @param {NodeList|HTMLElement[]} allCards - Array or NodeList of .media-card nodes
     * @param {number} startIndex - Card index to begin progressive chunk loading from
     * @private
     * =========================================================================
     */
    _scheduleIdleImageChunks(allCards, startIndex = 14) {
        if (!allCards || !allCards.length || this._isDestroyed) return;

        // Cancel any existing chunk processing loop before scheduling a new one
        this._cancelIdleChunkQueue();

        const chunkSize = 10;
        let currentIndex = startIndex;
        const totalCards = allCards.length;

        /*
         * Recursive step function executing one chunk of 10 card images
         * per idle slice or timer tick until the entire page is decoded.
         */
        const processNextChunk = () => {
            // Guard against unmounted page or completed card processing
            if (this._isDestroyed || currentIndex >= totalCards) {
                this._idleChunkId = null;
                this._idleChunkType = null;
                return;
            }

            // Slice out the current chunk window (up to 10 cards)
            const chunkEnd = Math.min(currentIndex + chunkSize, totalCards);
            for (let i = currentIndex; i < chunkEnd; i++) {
                const img = allCards[i].querySelector('img[data-src]');
                if (img) {
                    lazyLoader.forceLoad(img);
                }
            }
            currentIndex = chunkEnd;

            // If additional cards remain, schedule the next chunk
            if (currentIndex < totalCards) {
                if (typeof window.requestIdleCallback === 'function') {
                    this._idleChunkType = 'idle';
                    this._idleChunkId = window.requestIdleCallback(() => processNextChunk(), { timeout: 100 });
                } else {
                    this._idleChunkType = 'timer';
                    this._idleChunkId = setTimeout(processNextChunk, 50);
                }
            } else {
                this._idleChunkId = null;
                this._idleChunkType = null;
            }
        };

        // Dispatch the initial deferred chunk right after initial render frame
        if (typeof window.requestIdleCallback === 'function') {
            this._idleChunkType = 'idle';
            this._idleChunkId = window.requestIdleCallback(() => processNextChunk(), { timeout: 100 });
        } else {
            this._idleChunkType = 'timer';
            this._idleChunkId = setTimeout(processNextChunk, 50);
        }
    }

    /**
     * =========================================================================
     * CANCEL IDLE IMAGE CHUNK QUEUE
     * =========================================================================
     * Cancels any active idle callback or timer chain for progressive image loading.
     * Prevents memory leaks or orphaned async operations on navigation.
     * @private
     * =========================================================================
     */
    _cancelIdleChunkQueue() {
        if (this._idleChunkId !== null && this._idleChunkId !== undefined) {
            if (this._idleChunkType === 'idle' && typeof window.cancelIdleCallback === 'function') {
                window.cancelIdleCallback(this._idleChunkId);
            } else {
                clearTimeout(this._idleChunkId);
            }
            this._idleChunkId = null;
            this._idleChunkType = null;
        }
    }

    /**
     * =========================================================================
     * SCHEDULE IMAGE PRE-WARM (AFTER NAVIGATION FRAME)
     * =========================================================================
     * Separates critical navigation/DOM recycling work from noncritical image
     * fetches. Defers image pre-warming until after the navigation frame has painted
     * and only executes if the user is not continuing to navigate or scroll rapidly.
     *
     * @param {number} targetRow - The starting row index to pre-warm
     * @param {number} [rowCount=1] - Number of forward rows to pre-warm (defaults to 1)
     * @private
     * =========================================================================
     */
    _schedulePreWarm(targetRow, rowCount = 1) {
        if (!imageCache || this._isDestroyed) return;

        // Record timestamp of navigation step to detect continuous rapid motion
        this._lastGridNavTime = performance.now();

        // Cancel any pending pre-warm timer so rapid key repeats don't accumulate
        if (this._preWarmTimer) {
            clearTimeout(this._preWarmTimer);
            this._preWarmTimer = null;
        }

        // Schedule pre-warming after the navigation frame settles (150ms debounce)
        this._preWarmTimer = setTimeout(() => {
            this._preWarmTimer = null;
            if (this._isDestroyed) return;

            // If another navigation step occurred within 140ms, user is still moving rapidly
            if (performance.now() - (this._lastGridNavTime || 0) < 140) {
                return;
            }

            // If smooth scrolling animation is active, defer until transition settles
            if (lazyLoader && typeof lazyLoader._isScrolling === 'function' && lazyLoader._isScrolling()) {
                this._schedulePreWarm(targetRow, rowCount);
                return;
            }

            // Run pre-warm on the next idle animation frame
            requestAnimationFrame(() => {
                if (!this._isDestroyed) {
                    this._preWarmUpcomingRows(targetRow, rowCount);
                }
            });
        }, 150);
    }

    /**
     * =========================================================================
     * PRE-WARM UPCOMING ROW POSTERS
     * =========================================================================
     * Resolves poster/backdrop URLs for media items in upcoming rows and feeds
     * them into imageCache.preload(). Pre-loaded images hit the browser's native
     * memory cache on arrival, providing instant, pop-in-free card rendering
     * when the rows cycle into the active DOM window.
     *
     * Work is deduplicated through an in-memory set to prevent redundant URL
     * resolution and duplicate in-flight requests.
     *
     * @param {number} targetRow - The starting row index to pre-warm
     * @param {number} [rowCount=1] - Number of forward rows to pre-warm (defaults to 1)
     * =========================================================================
     */
    _preWarmUpcomingRows(targetRow, rowCount = 1) {
        if (!imageCache || this._isDestroyed) return;
        const items = this.state.items;
        const columns = this.state._gridColumns;
        if (!items || !items.length || !columns) return;

        const totalRows = Math.ceil(items.length / columns);
        const startR = Math.max(0, targetRow);
        const endR = Math.min(totalRows, startR + rowCount);

        const startIdx = startR * columns;
        const endIdx = Math.min(items.length, endR * columns);
        if (startIdx >= endIdx) return;

        const slice = items.slice(startIdx, endIdx);
        const ctx = this.state._gridRenderContext || {};
        const isLandscape = ctx.isLandscape || false;
        const isSquare = this.state.viewMode === 'square' || this.state.viewMode === 'artist';
        const sizeType = isLandscape ? 'card-backdrop' : isSquare ? 'square' : 'poster';
        const { maxWidth, quality } = imageService.getParams(sizeType, 'library');

        // Track pre-warmed image URLs in an instance Set to avoid repeating work
        if (!this._preWarmedUrls) {
            this._preWarmedUrls = new Set();
        }

        const urls = [];
        for (let i = 0; i < slice.length; i++) {
            const item = slice[i];
            const itemId = item.Id;
            let url = null;
            if (isLandscape) {
                if (item.ImageTags?.Thumb) {
                    url = api.getImageUrl(itemId, 'Thumb', { maxWidth, quality, tag: item.ImageTags.Thumb });
                } else if (item.BackdropImageTags?.length > 0) {
                    url = api.getImageUrl(itemId, 'Backdrop', { maxWidth, quality });
                } else if (item.SeriesId && item.SeriesThumbImageTag) {
                    url = api.getImageUrl(item.SeriesId, 'Thumb', { maxWidth, quality, tag: item.SeriesThumbImageTag });
                } else if (item.ImageTags?.Primary) {
                    url = api.getImageUrl(itemId, 'Primary', { maxWidth, quality, tag: item.ImageTags.Primary });
                }
            } else {
                if (item.ImageTags?.Primary) {
                    url = api.getImageUrl(itemId, 'Primary', { maxWidth, quality, tag: item.ImageTags.Primary });
                } else if (item.SeriesId) {
                    url = api.getImageUrl(item.SeriesId, 'Primary', { maxWidth, quality });
                }
            }
            if (url && !this._preWarmedUrls.has(url)) {
                this._preWarmedUrls.add(url);
                urls.push(url);
            }
        }

        // Bound memory usage of pre-warm tracking registry
        if (this._preWarmedUrls.size > 800) {
            this._preWarmedUrls.clear();
        }

        if (urls.length > 0) {
            imageCache.preload(urls);
        }
    }

    /**
     * Toggles visibility of the subtle activity indicator at the bottom of the grid.
     * @param {boolean} show
     */
    _showInfiniteLoading(show) {
        const loader = this.$('#infinite-scroll-loader');
        if (loader) {
            if (show) {
                loader.classList.remove('hidden');
            } else {
                loader.classList.add('hidden');
            }
        }
    }

    _handleGridClick(e, cardElement) {
        const card = cardElement || e.target.closest('.media-card');
        if (!card) return;

        const itemId = card.dataset.itemId;
        if (!itemId) return;

        // Special handling for Seerr items: navigate to SeerrDetailsPage
        if (card.dataset.mediaType && card.dataset.tmdbId) {
            log.info('Navigating to Seerr details:', card.dataset.mediaType, card.dataset.tmdbId);
            router.navigate(`/seerr/${card.dataset.mediaType}/${card.dataset.tmdbId}`);
            return;
        }

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
            router.navigate(`/library/${itemId}?collectionType=photos`);
            return;
        }

        // Special handling for Folders: navigate to sub-library
        if (card.dataset.type === 'Folder' || card.dataset.type === 'CollectionFolder') {
            log.info('Navigating into folder:', itemId);
            const parentColType = this.state.libraryInfo?.CollectionType || this.params.collectionType || '';
            const isGame = this.state.isGameLibrary;
            const q = new URLSearchParams();
            if (parentColType) q.set('collectionType', parentColType);
            if (isGame) q.set('isGame', 'true');
            const qStr = q.toString();
            router.navigate(`/library/${itemId}${qStr ? `?${qStr}` : ''}`);
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
        if (this.state.isInfinite) return;
        // ====================================================================
        // RELIABLE PAGE-BASED PAGINATION
        // ====================================================================
        // Derive targetPage directly from the current page number rather than
        // raw byte/item offsets, which eliminates rounding mismatches caused by
        // dynamic column limit alignment (e.g., 100 aligned to 105).
        // ====================================================================
        const isSeerr = this.state.libraryId === 'seerr';
        const pageLimit = isSeerr ? 100 : this.state.limit || 100;
        const currentPage = Math.floor(this.state.startIndex / pageLimit) + 1;
        const totalPages = Math.ceil(this.state.totalRecordCount / pageLimit) || 1;
        const targetPage = currentPage + direction;

        // Bounds check: ensure target page stays within valid [1, totalPages] range
        if (targetPage < 1 || targetPage > totalPages) return;

        if (isSeerr) {
            const currentParams = new URLSearchParams();
            if (this.params.seerrType) currentParams.set('seerrType', this.params.seerrType);
            if (this.params.mediaType) currentParams.set('mediaType', this.params.mediaType);
            if (this.params.genreId || this.params.genre)
                currentParams.set('genreId', this.params.genreId || this.params.genre);
            if (this.params.studioId || this.params.studio)
                currentParams.set('studioId', this.params.studioId || this.params.studio);
            if (this.params.networkId || this.params.network)
                currentParams.set('networkId', this.params.networkId || this.params.network);
            if (this.params.keywordId || this.params.keywords || this.params.keyword)
                currentParams.set('keywordId', this.params.keywordId || this.params.keywords || this.params.keyword);
            if (this.params.name) currentParams.set('name', this.params.name);
            currentParams.set('page', targetPage);

            router.navigate(`/library/seerr?${currentParams.toString()}`);
            return;
        }

        // ====================================================================
        // PRESERVE ROUTE QUERY PARAMETERS ACROSS PAGE CHANGES
        // ====================================================================
        // Start from existing route parameters so deep links (e.g. season details
        // "See More" with parentId, includeItemTypes, viewModeIndex), custom search,
        // or favorite subsets don't lose their context when the user navigates pages.
        // ====================================================================
        const currentParams = new URLSearchParams();

        // Copy over all existing parameters from this.params except route path 'id' and 'page'
        if (this.params && typeof this.params === 'object') {
            for (const [key, value] of Object.entries(this.params)) {
                if (key !== 'id' && key !== 'page' && value !== undefined && value !== null && value !== '') {
                    currentParams.set(key, value);
                }
            }
        }

        // Active alphabet picker / character filter override
        const selectedChar = this.state.nameStartsWith || this.params.char;
        if (selectedChar) {
            currentParams.set('char', selectedChar);
        } else {
            currentParams.delete('char');
        }

        // Apply updated target page
        currentParams.set('page', targetPage);

        router.navigate(`/library/${this.state.libraryId}?${currentParams.toString()}`);
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
        const isSeerr = this.state.libraryId === 'seerr' || this.state.libraryInfo?.CollectionType === 'seerr';

        if (isSeerr) {
            const rawMediaType = this.params.mediaType || (this.params.seerrType === 'network' ? 'tv' : 'movie');
            const isTv = rawMediaType === 'tv' || rawMediaType === 'series' || rawMediaType === 'tvshows';

            const sortOptions = isTv
                ? [
                      { label: 'OptionPopularity', fallback: 'Popularity', value: 'popularity' },
                      { label: 'OptionFirstAirDate', fallback: 'First Air Date', value: 'first_air_date' },
                      { label: 'OptionTmdbRating', fallback: 'TMDB Rating', value: 'vote_average' },
                      { label: 'OptionTitle', fallback: 'Title (A-Z)', value: 'original_title' }
                  ]
                : [
                      { label: 'OptionPopularity', fallback: 'Popularity', value: 'popularity' },
                      { label: 'OptionReleaseDate', fallback: 'Release Date', value: 'release_date' },
                      { label: 'OptionTmdbRating', fallback: 'TMDB Rating', value: 'vote_average' },
                      { label: 'OptionTitle', fallback: 'Title (A-Z)', value: 'original_title' }
                  ];

            const orderOptions = [
                { label: 'Descending', fallback: 'Descending', value: 'Descending' },
                { label: 'Ascending', fallback: 'Ascending', value: 'Ascending' }
            ];

            this._renderSortModal(sortOptions, orderOptions);
            return;
        }

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

        // Check if current tab defaults to landscape layout (Episodes, Home Videos, Photos, etc.)
        const isLandscape =
            this.state.viewType === 'Episodes' ||
            this.state.viewType === 'Upcoming' ||
            this.state.viewType === 'Networks' ||
            this.state.libraryInfo?.CollectionType === 'musicvideos' ||
            this.state.libraryInfo?.CollectionType === 'homevideos' ||
            this.state.libraryInfo?.CollectionType === 'photos';

        const isSeerr = this.state.libraryId === 'seerr' || this.state.libraryInfo?.CollectionType === 'seerr';

        // Pre-select the currently active view mode
        const current = this.state.viewMode || (isLandscape ? 'thumb' : 'poster');
        let tempMode = current;
        let tempGridMode = this.state.gridMode;

        // Grid column options available for each view mode layout
        const colOptionsMap = {
            poster: [4, 5, 6, 7],
            // Small poster density: 8, 9 (default), 10, or 12 cards per row
            'small-poster': [8, 9, 10, 12],
            thumb: [3, 4, 5, 6],
            banner: [2, 3, 4, 5]
        };

        // Determine initial column count: check saved preference for this specific mode first,
        // otherwise default to standard column count for this mode.
        const defaultInitialCols = this._getDefaultColumnsForMode(tempMode);
        const isTabSpecific = Boolean(this.state.viewType && this.state.viewType !== 'Items');
        const initialTabColsKey = isTabSpecific
            ? `pref:library:gridColumns:${this.state.libraryId}:${this.state.viewType}:${tempMode}`
            : null;
        const initialColsKey = isSeerr
            ? `pref:seerr:gridColumns:${tempMode}`
            : `pref:library:gridColumns:${this.state.libraryId}:${tempMode}`;
        const initialSavedCols = parseInt(
            (initialTabColsKey && storage.getItem(initialTabColsKey)) || storage.getItem(initialColsKey),
            10
        );
        const validInitialOpts = colOptionsMap[tempMode] || [];

        let tempColumns;
        if (validInitialOpts.includes(initialSavedCols)) {
            tempColumns = initialSavedCols;
        } else if (
            validInitialOpts.includes(this.state.gridColumns) &&
            this.state.viewMode === tempMode &&
            !isLandscape
        ) {
            tempColumns = this.state.gridColumns;
        } else {
            tempColumns = defaultInitialCols;
        }

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

        const allModes = [
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

        // For Seerr discovery, limit view mode options to Poster and Small Poster
        const modes = isSeerr ? allModes.filter((m) => m.value === 'poster' || m.value === 'small-poster') : allModes;

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

                // When switching layout styles, load this mode's saved column preference
                // if valid, or fall back to the exact default column count for this mode.
                const defaultCols = this._getDefaultColumnsForMode(tempMode);
                const colsKey = isSeerr
                    ? `pref:seerr:gridColumns:${tempMode}`
                    : `pref:library:gridColumns:${this.state.libraryId}:${tempMode}`;
                const savedCols = parseInt(storage.getItem(colsKey), 10);
                const validOpts = colOptionsMap[tempMode] || [];

                if (validOpts.includes(savedCols)) {
                    tempColumns = savedCols;
                } else {
                    tempColumns = defaultCols;
                }

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
            if (isSeerr) {
                storage.setItem('pref:seerr:viewMode', tempMode);
                storage.setItem('pref:seerr:gridMode', tempGridMode);
                storage.setItem(`pref:seerr:gridColumns:${tempMode}`, tempColumns);
            } else {
                /*
                 * ============================================================
                 * Scoped Preference Persistence
                 * ============================================================
                 * Store tab-specific layout preferences when on dedicated sub-tabs
                 * (e.g. Episodes, Photos, Videos) so top-level tabs retain their mode.
                 * ============================================================
                 */
                const isTabSpecific = Boolean(this.state.viewType && this.state.viewType !== 'Items');
                const viewModeKey = isTabSpecific
                    ? `pref:library:viewMode:${this.state.libraryId}:${this.state.viewType}`
                    : `pref:library:viewMode:${this.state.libraryId}`;
                const gridModeKey = isTabSpecific
                    ? `pref:library:gridMode:${this.state.libraryId}:${this.state.viewType}`
                    : `pref:library:gridMode:${this.state.libraryId}`;
                const colsKey = isTabSpecific
                    ? `pref:library:gridColumns:${this.state.libraryId}:${this.state.viewType}:${tempMode}`
                    : `pref:library:gridColumns:${this.state.libraryId}:${tempMode}`;

                storage.setItem(viewModeKey, tempMode);
                storage.setItem(gridModeKey, tempGridMode);
                storage.setItem(colsKey, tempColumns);
            }

            // Re-fetch items with the aligned limit for the new column count,
            // so every row renders full (no partial last row).
            this.state.startIndex = 0;
            this._closeModal();
            this._loadItems();

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
                                    <span data-i18n="${opt.label}">${i18n.t(opt.label) || opt.fallback || opt.label}</span>
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
                                    <span data-i18n="${opt.label}">${i18n.t(opt.label) || opt.fallback || opt.label}</span>
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
        const isSeerr = this.state.libraryId === 'seerr' || this.state.libraryInfo?.CollectionType === 'seerr';

        if (isSeerr) {
            const rawMediaType = this.params.mediaType || (this.params.seerrType === 'network' ? 'tv' : 'movie');
            const mediaType =
                rawMediaType === 'tv' || rawMediaType === 'series' || rawMediaType === 'tvshows' ? 'tv' : 'movie';
            const isTv = mediaType === 'tv';
            // Strictly show movie genres for movies, and TV genres for series
            const genreList = isTv ? TV_GENRES_FALLBACK : MOVIE_GENRES_FALLBACK;
            const certList = isTv ? SEERR_TV_CERTIFICATIONS : SEERR_MOVIE_CERTIFICATIONS;

            const currentGenre =
                this.state.filters.genre !== undefined
                    ? this.state.filters.genre
                    : this.params.genreId || this.params.genre;

            // Ensure current selected genre(s) from params or state are recognized
            if (this.state.filters.genre === undefined && currentGenre) {
                this.state.filters.genre = currentGenre.toString();
            }

            const currentLanguage =
                this.state.filters.language !== undefined ? this.state.filters.language : this.params.language;

            if (this.state.filters.language === undefined && currentLanguage) {
                this.state.filters.language = currentLanguage.toString();
            }

            const currentCertification =
                this.state.filters.certification !== undefined
                    ? this.state.filters.certification
                    : this.params.certification;

            if (this.state.filters.certification === undefined && currentCertification) {
                this.state.filters.certification = currentCertification.toString();
            }

            const filtersData = {
                Genres: genreList.map((g) => ({
                    label: g.name,
                    value: g.id.toString(),
                    type: 'multi'
                })),
                Languages: SEERR_LANGUAGES.map((l) => ({
                    label: l.name,
                    value: l.id,
                    type: 'multi'
                })),
                Certifications: certList.map((c) => ({
                    label: c.name,
                    value: c.id,
                    type: 'multi'
                }))
            };

            this._renderFilterModal(filtersData);
            return;
        }

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
            filtersData = {
                Genres: [],
                OfficialRatings: [],
                Tags: [],
                Years: [],
                AudioLanguages: [],
                SubtitleLanguages: []
            };
        }

        this._renderFilterModal(filtersData);
    }

    _renderFilterModal(data) {
        const overlay = this.$('#modal-overlay');
        if (!overlay) return;

        // Store focus context
        this._prevFocus = focusManager.getFocused();
        this._prevSection = focusManager.getActiveSection();

        const isSeerr = this.state.libraryId === 'seerr' || this.state.libraryInfo?.CollectionType === 'seerr';
        const isMusic = this.state.libraryInfo?.CollectionType === 'music';

        // ------------------------------------------------------------------
        // Parse Genres: Supports both plain string arrays and modern Name/Id objects
        // In all cases, map value to the Genre Name string for library queries
        // ------------------------------------------------------------------
        const genreItems = Array.isArray(data?.Genres)
            ? data.Genres.map((g) => {
                  if (typeof g === 'object' && g !== null) {
                      // Extract name string, accommodating both PascalCase and camelCase keys
                      const name = g.Name || g.name || g.label || g.value || '';
                      return {
                          label: name,
                          value: name,
                          type: g.type || 'multi'
                      };
                  }
                  return { label: g, value: g, type: 'multi' };
              }).filter((item) => Boolean(item.label && item.value))
            : [];

        // ------------------------------------------------------------------
        // Parse Jellyfin 12+ Audio & Subtitle Languages
        // ------------------------------------------------------------------
        const audioLanguageItems = Array.isArray(data?.AudioLanguages)
            ? data.AudioLanguages.map((l) => ({
                  label: l.Name || l.label || l.Value || l,
                  value: l.Value || l.value || l,
                  type: 'multi'
              }))
            : [];

        const subtitleLanguageItems = Array.isArray(data?.SubtitleLanguages)
            ? data.SubtitleLanguages.map((l) => ({
                  label: l.Name || l.label || l.Value || l,
                  value: l.Value || l.value || l,
                  type: 'multi'
              }))
            : [];

        const languageItems = Array.isArray(data?.Languages)
            ? data.Languages.map((l) => (typeof l === 'object' ? l : { label: l, value: l, type: 'multi' }))
            : [];

        const certificationItems = Array.isArray(data?.Certifications)
            ? data.Certifications.map((c) => (typeof c === 'object' ? c : { label: c, value: c, type: 'multi' }))
            : [];

        // Sections Definition
        const sections = isSeerr
            ? [
                  {
                      title: 'Genres',
                      id: 'sec-genres',
                      itemKey: 'genre', // Key in state.filters for Seerr
                      separator: ',',
                      items: genreItems
                  },
                  {
                      title: 'OriginalLanguage',
                      id: 'sec-languages',
                      itemKey: 'language', // Key in state.filters for Seerr
                      separator: '|', // Pipe-separated ISO codes for Seerr/TMDB e.g. ar|zh
                      items: languageItems
                  },
                  {
                      title: 'ContentRating',
                      id: 'sec-certifications',
                      itemKey: 'certification', // Key in state.filters for Seerr
                      separator: '|', // Pipe-separated certification values e.g. NR|G|PG-13
                      items: certificationItems
                  }
              ]
            : [
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
                      separator: '|', // Pipe-delimited collection required by Jellyfin backend
                      items: genreItems
                  },
                  {
                      title: 'HeaderParentalRatings',
                      id: 'sec-ratings',
                      itemKey: 'OfficialRatings',
                      separator: '|', // Pipe-delimited collection required by Jellyfin backend
                      items: (data?.OfficialRatings || []).map((r) => ({ label: r, value: r, type: 'multi' }))
                  },
                  {
                      title: 'Tags',
                      id: 'sec-tags',
                      itemKey: 'Tags',
                      separator: '|', // Pipe-delimited collection required by Jellyfin backend
                      items: (data?.Tags || []).map((t) => ({ label: t, value: t, type: 'multi' }))
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
                      title: 'AudioTracks',
                      id: 'sec-audio-languages',
                      hidden: isMusic, // Hide audio track filter for music
                      itemKey: 'AudioLanguages',
                      items: audioLanguageItems
                  },
                  {
                      title: 'SubtitleTracks',
                      id: 'sec-subtitle-languages',
                      hidden: isMusic, // Hide subtitle track filter for music
                      itemKey: 'SubtitleLanguages',
                      items: subtitleLanguageItems
                  },
                  {
                      title: 'HeaderYears',
                      id: 'sec-years',
                      itemKey: 'Years',
                      items: (data?.Years || []).map((y) => ({
                          label: y.toString(),
                          value: y.toString(),
                          type: 'multi'
                      }))
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
                                // Match against both pipe and legacy comma delimiters for backwards compatibility
                                const arr = stored.split(/[|,]/).map((s) => s.trim());
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
                const section = validSections.find((s) => s.itemKey === key || s.id === this.state.activeFilterSection);
                const sep = section?.separator || (key === 'language' || key === 'certification' ? '|' : ',');
                // Split existing stored selections handling either pipe or comma delimiters
                let current = this.state.filters[key]
                    ? this.state.filters[key]
                          .split(/[|,]/)
                          .map((s) => s.trim())
                          .filter(Boolean)
                    : [];
                if (!isSelected) current.push(val);
                else current = current.filter((v) => v !== val);

                if (current.length > 0) this.state.filters[key] = current.join(sep);
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

        const isSeerr = collectionType === 'seerr' || this.state.libraryId === 'seerr';

        // Condition: only show for Movies (Items), TV Shows (Items), Episodes, music grid views, and Seerr
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
            isSeerr ||
            isMovieMain ||
            isTVMain ||
            isEpisodes ||
            isMusicMain ||
            isCollections ||
            isFolderMain ||
            isFolderLikeMain;

        const isSubView = this._isSubView();
        const isSubFolder = this.state.isSubFolder;

        // Controls should be visible in main views, sub-views (Genre/Person), Seerr, or sub-folders
        const isControlsVisible = shouldShow || isSubView || isSubFolder;
        // Alpha Picker is hidden for Seerr
        const isAlphaVisible = !isSeerr && (shouldShow || isSubView || isSubFolder);

        const isCollectionsLike = collectionType === 'boxsets' || collectionType === 'playlists';
        const isTabsVisible = !isSeerr && !isCollectionsLike && !isSubView;

        const controls = this.$('#library-controls');
        const controlsRow = this.$('.library-controls-row');
        const alphaPicker = this.$('#alpha-picker-container');
        const tabsContainer = this.$('#library-tabs');
        const shuffleBtn = this.$('#btn-shuffle');
        const filterBtn = this.$('#btn-filter');
        const sortBtn = this.$('#btn-sort');
        const isStudioOrNetwork =
            this.params.seerrType === 'studio' ||
            this.params.seerrType === 'network' ||
            !!this.params.studioId ||
            !!this.params.networkId;

        if (controlsRow) controlsRow.style.display = isControlsVisible ? 'flex' : 'none';
        if (controls) controls.style.display = isControlsVisible ? 'flex' : 'none';
        if (alphaPicker) alphaPicker.style.display = isAlphaVisible ? 'flex' : 'none';
        if (tabsContainer) tabsContainer.style.display = isTabsVisible ? 'flex' : 'none';
        if (shuffleBtn) shuffleBtn.style.display = isSeerr ? 'none' : '';
        if (filterBtn) filterBtn.style.display = isSeerr && isStudioOrNetwork ? 'none' : '';
        if (sortBtn) sortBtn.style.display = isSeerr && isStudioOrNetwork ? 'none' : '';

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

        // Check active alphabet selector layout placement
        const isRightPosHeader = layoutManager.getAlphaPickerPosition() === 'right';

        // 2. Configure Controls (if visible)
        if (controls && isControlsVisible) {
            const controlsConfig = focusManager.getSectionConfig('library-controls');
            if (controlsConfig) {
                // When alpha is on the right, controls jump directly DOWN to grid/rows
                let controlsLeaveDown = 'library-grid';
                if (!isRightPosHeader && isAlphaVisible) {
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
                    leaveDown: controlsLeaveDown,
                    leaveRight: isRightPosHeader && isAlphaVisible ? 'alpha-picker' : null
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

                if (isRightPosHeader) {
                    // Vertical right side configuration: Left jumps to grid, Up jumps to controls
                    this.registerFocusSection('alpha-picker', alphaPicker, {
                        ...alphaConfig,
                        orientation: 'vertical',
                        leaveUp: isControlsVisible ? 'library-controls' : isTabsVisible ? 'library-tabs' : 'sidebar',
                        leaveDown: null,
                        leaveLeft: alphaLeaveDown,
                        leaveRight: null
                    });
                } else {
                    // Standard horizontal header configuration
                    this.registerFocusSection('alpha-picker', alphaPicker, {
                        ...alphaConfig,
                        orientation: 'horizontal',
                        leaveUp: isControlsVisible ? 'library-controls' : isTabsVisible ? 'library-tabs' : 'sidebar',
                        leaveDown: alphaLeaveDown,
                        leaveLeft: 'sidebar',
                        leaveRight: null
                    });
                }
            }
        }

        // 4. Configure Grid (always present, but visibility varies)
        const gridConfig = focusManager.getSectionConfig('library-grid');
        if (gridConfig) {
            let gridLeaveUp = 'sidebar'; // Fallback to sidebar if isolated
            if (!isRightPosHeader && isAlphaVisible) gridLeaveUp = 'alpha-picker';
            else if (isControlsVisible) gridLeaveUp = 'library-controls';
            else if (isTabsVisible) gridLeaveUp = 'library-tabs';

            this.registerFocusSection('library-grid', this.$('#library-grid'), {
                ...gridConfig,
                leaveUp: gridLeaveUp,
                leaveDown:
                    this.state.isInfinite && this.state.items.length < this.state.totalRecordCount
                        ? null
                        : this.state.isInfinite
                          ? null
                          : gridConfig.leaveDown || 'library-pagination',
                leaveRight: isRightPosHeader && isAlphaVisible ? 'alpha-picker' : null
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

    /**
     * Clean up timers, animation frames, and background preloads when page unmounts.
     */
    onDestroyed() {
        this._isDestroyed = true;

        // Cancel any pending progressive image idle chunk queue
        this._cancelIdleChunkQueue();

        // Cancel any pending scheduled pre-warm timers
        if (this._preWarmTimer) {
            clearTimeout(this._preWarmTimer);
            this._preWarmTimer = null;
        }

        // Cancel pending background prefetch timeouts
        if (this._libraryIdlePrefetchTimer) {
            clearTimeout(this._libraryIdlePrefetchTimer);
            this._libraryIdlePrefetchTimer = null;
        }

        // Cancel progressive hydration animation frame
        if (this._progressiveHydrationFrameId) {
            cancelAnimationFrame(this._progressiveHydrationFrameId);
            this._progressiveHydrationFrameId = null;
        }

        // Immediately abort any in-flight speculative preloads so connection pool is freed
        if (imageCache && typeof imageCache.cancel === 'function') {
            imageCache.cancel();
        }

        // Clear pre-warmed URL registry
        if (this._preWarmedUrls) {
            this._preWarmedUrls.clear();
            this._preWarmedUrls = null;
        }

        super.onDestroyed?.();
    }
}

export default LibraryPage;
