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
                            <p>No items found</p>
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

        // 4. Handle Genre Mode or Initial Data
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
                console.error('Failed to fetch genre info', e);
            }
        }

        await this._loadItems();
    }

    /**
     * Handle back navigation
     * @returns {boolean} True if handled
     */
    onBack() {
        // Check if modal is open
        const overlay = this.$('#modal-overlay');
        if (overlay && overlay.classList.contains('visible')) {

            // Check WHICH modal is open (Filter or Sort) based on content or ID?
            // Current strict impl: We have Filter and Sort.
            // Sort uses _closeModal, Filter uses _closeFilterModal.
            // We can try closing both or checking content.

            if (overlay.querySelector('.filter-modal')) {
                this._closeFilterModal();
                const btn = this.$('#btn-filter');
                if (btn) focusManager.focusElement(btn);
                return true;
            } else {
                // Assume Sort or standard modal
                this._closeModal();
                // Restore focus for sort?
                const sortBtn = this.$('#btn-sort');
                if (sortBtn) focusManager.focusElement(sortBtn);
                return true;
            }
        }
        return false;
    }

    _bindEvents() {
        // Tabs Delegation
        this.$('#library-tabs')?.addEventListener('click', this._onTabClick);

        // Alpha Picker Delegation
        const alphaPicker = this.$('#alpha-picker');
        if (alphaPicker) {
            alphaPicker.addEventListener('click', this._onAlphaClick);
        }

        // Grid Click Delegation
        this.$('#library-grid')?.addEventListener('click', this._onGridClick);

        // Pagination
        this.$('#btn-prev')?.addEventListener('click', () => this._handlePageChange(-1));
        this.$('#btn-next')?.addEventListener('click', () => this._handlePageChange(1));
        this.$('#btn-prev-top')?.addEventListener('click', () => this._handlePageChange(-1));
        this.$('#btn-next-top')?.addEventListener('click', () => this._handlePageChange(1));

        // Controls
        this.$('#btn-shuffle')?.addEventListener('click', () => this._handleShuffle());
        this.$('#btn-sort')?.addEventListener('click', () => this._handleSort());
        this.$('#btn-filter')?.addEventListener('click', () => this._handleFilter());

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
                    console.log('Navigating to Genre:', genreId);
                    // Navigate to Genre Filtered Page
                    router.navigate(`/library/${this.state.libraryId}/genre/${genreId}`);
                }
                return;
            }

            // Handle media card clicks in horizontal rows
            const mediaCard = e.target.closest('.media-card');
            if (mediaCard?.dataset?.itemId) {
                const itemId = mediaCard.dataset.itemId;
                console.log('Navigating to item details:', itemId);
                router.navigate(`/details/${itemId}`);
            }
        });
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
            console.error('LibraryPage: Failed to fetch info', e);
        }
    }

    async _loadItems() {
        this.setLoading(true);

        // Show Skeleton instead of spinner
        const isLandscape = this.state.viewType === 'Episodes' || this.state.viewType === 'Upcoming';
        const grid = this.$('#library-grid');
        if (grid) {
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
                EnableImageTypes: 'Primary,Backdrop,Thumb',
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
                }
                result = await api.getItems(params);

            } else if (viewType === 'Suggestions') {
                // TODO: Special endpoint for suggestions?
                // For now, use Latest Items as a proxy or stick to standard
                delete params.Recursive;
                delete params.SortBy; // Latest usually implies specific sort
                result = await api.getLatestItems(this.state.libraryId, { Limit: 30 });
                // Latest items endpoint returns generic array usually, not Items wrapper
                if (Array.isArray(result)) {
                    result = { Items: result, TotalRecordCount: result.length };
                }

            } else if (viewType === 'Suggestions') {
                // Fetch multiple rows for Suggestions
                const [resume, nextUp, latest] = await Promise.all([
                    api.getResumeItems({ Limit: 12, ParentId: this.state.libraryId }),
                    api.getNextUp({ Limit: 12, ParentId: this.state.libraryId }),
                    api.getLatestItems(this.state.libraryId, { Limit: 12 })
                ]);

                const rows = [];
                if (resume.Items && resume.Items.length > 0) {
                    rows.push({ title: 'Continue Watching', items: resume.Items });
                }
                if (nextUp.Items && nextUp.Items.length > 0) {
                    rows.push({ title: 'Next Up', items: nextUp.Items });
                }
                if (latest && latest.length > 0) {
                    rows.push({ title: 'Latest Added', items: latest });
                }

                this.state.items = []; // Clear grid items
                this._renderHorizontalRows(rows);
                this._updatePaginationUI();
                return; // Skip grid render

            } else if (viewType === 'Genres') {
                // Fetch Genres List for Vertical Rows
                result = await api.getGenres({
                    ParentId: this.state.libraryId,
                    SortBy: 'SortName',
                    SortOrder: 'Ascending',
                    Limit: 100 // Fetch plenty of genres
                });

                const allGenres = result.Items || [];

                // create lazy rows
                const rows = allGenres.map(genre => ({
                    title: genre.Name,
                    genreId: genre.Id,
                    isLazy: true,
                    items: [] // Empty initially
                }));

                this.state.items = [];
                this._renderHorizontalRows(rows);
                this._updatePaginationUI();
                return;

            } else if (viewType === 'Upcoming') {
                result = await api.getNextUp({ Limit: 40 }); // This is global, might need filtering by library if possible (not standard in API)

            } else if (viewType === 'Episodes') {
                // Flattened episodes view
                params.IncludeItemTypes = 'Episode';
                result = await api.getItems(params);

            } else if (viewType === 'Favorites') {
                params.Filters = 'IsFavorite';
                result = await api.getItems(params);

            } else if (viewType === 'Collections') {
                params.IncludeItemTypes = 'BoxSet';
                params.Recursive = true;
                // Collections usually sit at root, need to check if we can filter by Lib?
                // Often Collections are their own Library. If this is a specific Movie lib, 
                // we might just want BoxSets that contain items from this lib? Hard to do via API.
                // Fallback: Just show all collections for now or remove if context invalid.
                result = await api.getItems(params);

                // Fallback
                result = await api.getItems(params);
            }

            this.state.items = result.Items || [];
            this.state.totalRecordCount = result.TotalRecordCount || 0;

            this._renderGrid(this.state.items);
            this._updatePaginationUI();

        } catch (e) {
            console.error('LibraryPage: Failed to load items', e);
            this.$('#library-grid').innerHTML = `<p class="error-msg">Failed to load content</p>`;
        } finally {
            this.setLoading(false);
            // Apply Header visibility and specialization AFTER content is loaded
            // This ensures target move sections (like header-0) exist.
            this._updateHeaderVisibility();
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
        const isNextDisabled = (startIndex + limit) >= totalRecordCount;

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

        // Define tabs based on collection type
        // TODO: Expand this based on real API capabilities/User requirements
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

        const tabsContainer = this.$('#library-tabs');
        if (!tabsContainer) return;

        tabsContainer.innerHTML = tabs.map(tab => `
            <button class="tab-btn ${this.state.viewType === tab.id ? 'active' : ''}" 
                    data-type="${tab.id}" 
                    tabindex="0">
                ${tab.label}
            </button>
        `).join('');

        // Re-register focus to capture new buttons
        focusManager.register('library-tabs', this.$('#library-tabs'), {
            orientation: 'horizontal',
            leaveUp: null, // Top of content
            leaveDown: 'library-controls',
            leaveLeft: 'sidebar',
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

        picker.innerHTML = this.state.alphaPickerChars.map(char => {
            const isActive = char === activeChar || (char === '#' && activeChar === '0-9'); // Simplify # logic
            return `
                <button class="alpha-btn ${isActive ? 'active' : ''}" 
                        data-char="${char}" 
                        tabindex="0">
                    ${char}
                </button>
            `;
        }).join('');

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

        // Use landscape cards via CSS class if needed (e.g. for Episodes)
        const isLandscape = this.state.viewType === 'Episodes' || this.state.viewType === 'Upcoming';
        const isThumb = this.state.viewType === 'Networks'; // TODO: Logic for simple thumbs

        if (isLandscape) {
            grid.classList.add('landscape');
        } else {
            grid.classList.remove('landscape');
        }

        if (!items || items.length === 0) {
            grid.innerHTML = '';
            this.$('#empty-state').classList.remove('hidden');
            this.$('#count-indicator').textContent = '0 items';
            return;
        }

        this.$('#empty-state').classList.add('hidden');

        // Update Count
        const start = this.state.startIndex + 1;
        const end = Math.min(this.state.startIndex + this.state.limit, this.state.totalRecordCount);
        this.$('#count-indicator').textContent = `${start}-${end} of ${this.state.totalRecordCount}`;

        // Generate HTML
        const html = items.map(item => CardRenderer.createCardHtml(item, {
            isLandscape: isLandscape,
            type: this.state.viewType === 'Episodes' ? 'episode' : 'poster',
            contextType: this.state.viewType === 'Upcoming' ? 'episode' : null // Handle special contexts
        })).join('');

        grid.innerHTML = html;

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
            leaveLeft: 'sidebar',
            selector: '.media-card',
            scrollOffsetTop: 100
        });
    }

    _renderHorizontalRows(rows) {
        const grid = this.$('#library-grid');
        const pagination = this.$('#library-pagination');
        const emptyState = this.$('#empty-state');

        // Hide standard grid/pagination
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
            grid.parentNode.insertBefore(container, grid);
        } else {
            container.innerHTML = '';
            container.style.display = 'flex';
        }

        if (!rows || rows.length === 0) {
            if (emptyState) emptyState.classList.remove('hidden');
            return;
        }

        // Initialize Observer if lazy rows exist
        if (rows.some(r => r.isLazy) && !this._genreObserver) {
            this._genreObserver = new IntersectionObserver(this._onGenreRowIntersect.bind(this), {
                root: null, // viewport
                rootMargin: '500px', // Optimal: loads 1-2 rows ahead without overwhelming API
                threshold: 0
            });
        }

        // Determine what row 0 should point UP to (tabs if header hidden, else controls)
        const collectionType = this.state.libraryInfo?.CollectionType;
        const viewType = this.state.viewType;
        const isMovieMain = (collectionType === 'movies' && viewType === 'Items');
        const isEpisodes = (viewType === 'Episodes');
        const nextUpTarget = (isMovieMain || isEpisodes) ? 'library-controls' : 'library-tabs';

        rows.forEach((row, rowIndex) => {
            const rowId = `row-${rowIndex}`;
            const headerId = `header-${rowIndex}`;
            const listId = `list-${rowIndex}`;

            // Determine item type for visual style
            let itemType = 'poster';
            if (row.title === 'Continue Watching' || row.title === 'Next Up') itemType = 'episode';

            const isLandscape = itemType === 'episode';

            const section = document.createElement('section');
            section.className = `library-row ${isLandscape ? 'landscape' : ''}`;
            section.id = rowId;
            section.dataset.genreId = row.genreId || '';
            section.dataset.listId = listId;
            section.dataset.isLazy = row.isLazy ? 'true' : 'false';

            const contentHtml = row.isLazy
                ? CardRenderer.createSkeletonHtml(9, isLandscape)
                : (row.items || []).map(item => CardRenderer.createCardHtml(item, {
                    isLandscape: isLandscape,
                    type: itemType,
                    contextType: null
                })).join('');

            section.innerHTML = `
                <div class="library-row-header" id="${headerId}">
                    <div class="header-focusable" tabindex="0" id="${headerId}-btn">
                        ${row.title}
                    </div>
                </div>
                <div class="library-horizontal-list row-items ${isLandscape ? 'landscape' : ''}" id="${listId}">
                    ${contentHtml}
                </div>
            `;

            container.appendChild(section);

            // Observe if lazy
            if (row.isLazy && this._genreObserver) {
                this._genreObserver.observe(section);
            }

            // Register Focus for Header
            focusManager.register(headerId, section.querySelector(`#${headerId}`), {
                orientation: 'horizontal',
                leaveUp: rowIndex === 0 ? nextUpTarget : `list-${rowIndex - 1}`,
                leaveDown: listId,
                leaveLeft: 'sidebar',
                selector: '.header-focusable'
            });

            // Register Focus for List (Horizontal)
            focusManager.register(listId, section.querySelector(`#${listId}`), {
                orientation: 'horizontal',
                leaveUp: headerId,
                leaveDown: rowIndex < rows.length - 1 ? `header-${rowIndex + 1}` : null,
                leaveLeft: 'sidebar',
                selector: '.media-card',
                scrollOffsetTop: 150 // Extra space to account for header
            });
        });

        // Update Alpha Picker to point to the first row header
        if (rows.length > 0) {
            focusManager.register('alpha-picker', this.$('#alpha-picker'), {
                orientation: 'horizontal',
                leaveUp: 'library-controls',
                leaveDown: 'header-0', // Point to first header
                leaveLeft: 'sidebar',
                enterTo: 'active-element'
            });
        }
    }

    _onGenreRowIntersect(entries) {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const row = entry.target;
                const genreId = row.dataset.genreId;
                const listId = row.dataset.listId;

                // Stop observing immediately
                this._genreObserver.unobserve(row);

                // Fetch Items for this row
                this._fetchGenreItems(genreId, listId);

                // PROACTIVE PRELOADING: Also load the next 3 rows for smoother scrolling
                // This ensures content is ready before the user scrolls to it
                const rowIndex = parseInt(listId.split('-')[1]);
                this._preloadNextRows(rowIndex + 1, 3);
            }
        });
    }

    /**
     * Preload the next N rows starting from a given index
     * @param {number} startIndex - Starting row index
     * @param {number} count - Number of rows to preload
     */
    _preloadNextRows(startIndex, count) {
        const rowsContainer = this.$('#library-rows');
        if (!rowsContainer) return;

        const allRows = rowsContainer.querySelectorAll('.library-row[data-is-lazy="true"]');

        for (let i = 0; i < allRows.length && count > 0; i++) {
            const row = allRows[i];
            const listEl = row.querySelector('[id^="list-"]');
            if (!listEl) continue;

            const rowIndex = parseInt(listEl.id.split('-')[1]);

            // Only preload rows at or after startIndex
            if (rowIndex >= startIndex) {
                const genreId = row.dataset.genreId;
                const listId = row.dataset.listId;

                // Check if already loaded (no skeleton loaders)
                const hasSkeleton = row.querySelector('.skeleton, .media-card-skeleton');
                if (hasSkeleton) {
                    // Stop observer for this row and load it
                    this._genreObserver?.unobserve(row);
                    this._fetchGenreItems(genreId, listId);
                    count--;
                }
            }
        }
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
                Limit: 9, // User asked for 9
                Fields: 'PrimaryImageAspectRatio,ProductionYear',
                IncludeItemTypes: includeItemTypes,
                Recursive: true,
                SortBy: 'Random' // Randomize to make it look interesting?
            });

            const items = result.Items || [];

            if (items.length === 0) {
                console.log(`[LibraryPage] Row "${listId}" is empty, hiding row...`);

                // HIDE the entire row completely
                const rowSection = listContainer.closest('.library-row');
                if (rowSection) {
                    rowSection.style.display = 'none';
                }

                // Clear the list container (removes skeleton loaders)
                listContainer.innerHTML = '';

                // Note: We no longer need to manually patch navigation!
                // FocusManager._leaveSection now auto-skips sections with no focusables

                return;
            }

            const html = items.map(item => CardRenderer.createCardHtml(item, {
                isLandscape: false, // Genres usually mix, but mostly posters
                type: 'poster'
            })).join('');

            listContainer.innerHTML = html;

            // Trigger fade-in animation by adding 'loaded' class
            const rowSection = listContainer.closest('.library-row');
            if (rowSection) {
                rowSection.classList.add('loaded');

                // Add staggered animation delay for premium cascading effect
                const cards = listContainer.querySelectorAll('.media-card');
                cards.forEach((card, index) => {
                    card.style.animationDelay = `${index * 50}ms`;
                });
            }

            // Invalidate FocusManager cache so it re-queries the new elements
            focusManager.invalidateCache(listId);

        } catch (e) {
            console.error('Failed to load genre items', e);
            // Hide row on error too
            const rowSection = listContainer?.closest('.library-row');
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
        if (itemId) {
            router.navigate(`/details/${itemId}`);
        }
    }

    async _handlePageChange(direction) {
        const newIndex = this.state.startIndex + (direction * this.state.limit);

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
        // "Open a random movie" -> Navigate to details of a random item
        try {
            const params = {
                ParentId: this.state.libraryId,
                SortBy: 'Random',
                Limit: 1,
                Recursive: true,
                IncludeItemTypes: 'Movie,Episode', // Safety net, usually context specific
                ExcludeLocationTypes: 'Virtual', // Filter out missing files if possible
            };

            // Respect current filters if any? Usually shuffle ignores view filters for global "Shuffle"
            // But maybe we should respect "Unplayed"? Let's keep it simple first.

            const result = await api.getItems(params);

            if (result.Items && result.Items.length > 0) {
                const randomItem = result.Items[0];
                router.navigate(`/details/${randomItem.Id}`);
            } else {
                console.warn('Shuffle: No items found');
            }
        } catch (e) {
            console.error('Shuffle: Failed to fetch random item', e);
        }
    }

    _updateControlsVisibility() {
        // Shuffle button is now always available for all
        const btnShuffle = this.$('#btn-shuffle');
        if (btnShuffle) {
            btnShuffle.style.display = '';
        }
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
                            ${sortOptions.map(opt => `
                                <button class="modal-option-btn radio-btn ${opt.value === currentSort ? 'selected' : ''}" 
                                        data-type="sort" 
                                        data-value="${opt.value}"
                                        tabindex="0">
                                    <div class="radio-icon"></div>
                                    <span>${opt.label}</span>
                                </button>
                            `).join('')}
                        </div>
                    </div>

                    <!-- Sort Order Column -->
                    <div class="sort-column" id="sort-order-col">
                        <h2 class="modal-title">Order</h2>
                        <div class="modal-options">
                            ${orderOptions.map(opt => `
                                <button class="modal-option-btn radio-btn ${opt.value === currentOrder ? 'selected' : ''}" 
                                        data-type="order" 
                                        data-value="${opt.value}"
                                        tabindex="0">
                                    <div class="radio-icon"></div>
                                    <span>${opt.label}</span>
                                </button>
                            `).join('')}
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
            col.querySelectorAll('.modal-option-btn').forEach(btn => {
                if (btn.dataset.value === value) btn.classList.add('selected');
                else btn.classList.remove('selected');
            });
        };

        // Bind Clicks
        overlay.querySelectorAll('.modal-option-btn').forEach(btn => {
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
            leaveLeft: 'sort-actions', // Shortcut to actions
            leaveRight: 'sort-order-col',
            leaveDown: 'sort-actions'
        });

        focusManager.register('sort-order-col', overlay.querySelector('#sort-order-col'), {
            orientation: 'vertical',
            leaveLeft: 'sort-by-col',
            leaveRight: 'sort-actions', // Shortcut to actions
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
                }
                return false;
            }
        });

        // Set initial focus
        setTimeout(() => {
            const selected = overlay.querySelector('#sort-by-col .selected') || overlay.querySelector('#sort-by-col .modal-option-btn');
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
            console.error('Filter: Failed to fetch filters', e);
            // We can still show static filters
            filtersData = { Genres: [], OfficialRatings: [], Tags: [], Years: [] };
        }

        this._renderFilterModal(filtersData);
    }

    _renderFilterModal(data) {
        const overlay = this.$('#modal-overlay');
        if (!overlay) return;

        // Current Filters State
        const currentFilters = this.state.filters || {};

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
                items: data.Genres.map(g => ({ label: g, value: g, type: 'multi' }))
            },
            {
                title: 'Parental Ratings',
                id: 'sec-ratings',
                itemKey: 'OfficialRatings',
                items: data.OfficialRatings.map(r => ({ label: r, value: r, type: 'multi' }))
            },
            {
                title: 'Tags',
                id: 'sec-tags',
                itemKey: 'Tags',
                items: data.Tags.map(t => ({ label: t, value: t, type: 'multi' }))
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
                items: data.Years.map(y => ({ label: y.toString(), value: y.toString(), type: 'multi' }))
            }
        ];

        // Filter out empty sections
        const validSections = sections.filter(s => s.items.length > 0);

        // Active Category State (Default to first)
        let activeSectionId = this.state.activeFilterSection || validSections[0].id;
        // Ensure active section is valid
        if (!validSections.find(s => s.id === activeSectionId)) {
            activeSectionId = validSections[0].id;
        }

        // Render HTML Structure
        let html = `
            <div class="library-modal filter-modal split-view">
                <h2 class="modal-title">Filters</h2>
                <div class="filter-split-container">
                    <!-- Left Sidebar -->
                    <div class="filter-sidebar" id="filter-sidebar">
                        ${validSections.map(s => `
                            <button class="filter-category-btn ${s.id === activeSectionId ? 'active' : ''}" 
                                    data-id="${s.id}" tabindex="0">
                                ${s.title}
                            </button>
                        `).join('')}
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

        // Logic to Render Items for Active Section
        const renderItems = (sectionId) => {
            const section = validSections.find(s => s.id === sectionId);
            const container = overlay.querySelector('#filter-main');
            if (!section || !container) return;

            // Highlight active category in sidebar
            overlay.querySelectorAll('.filter-category-btn').forEach(btn => {
                if (btn.dataset.id === sectionId) btn.classList.add('active');
                else btn.classList.remove('active');
            });

            this.state.activeFilterSection = sectionId;

            // Render Items
            container.innerHTML = section.items.map(item => {
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
            }).join('');

            // Clean up old focus section and re-register
            focusManager.unregister('filter-items');
            focusManager.register('filter-items', container, {
                orientation: 'grid', // Allow spatial nav (Left/Right/Up/Down)
                leaveLeft: 'filter-sidebar',
                leaveRight: 'filter-actions', // Shortcut to actions
                leaveDown: 'filter-actions', // Nav to buttons
                selector: '.modal-option-btn'
            });
            // Force cache invalidation just in case
            focusManager.invalidateCache('filter-items');
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
                else current = current.filter(v => v !== val);

                if (current.length > 0) this.state.filters[key] = current.join(',');
                else delete this.state.filters[key];
            }

            // Refresh checks if needed (mutually exclusive)
            if (key === 'IsPlayed' || key === 'IsUnplayed') {
                renderItems(this.state.activeFilterSection);
                // Note: re-rendering loses focus position inside list, 
                // but for mutual active buttons it's ok-ish or we can do manual DOM update.
                // Re-rendering is safest for consistency.
            }
        };

        // Verify initial render
        renderItems(activeSectionId);

        // Events: Sidebar Focus/Click
        overlay.querySelectorAll('.filter-category-btn').forEach(btn => {
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
            leaveRight: 'filter-items',
            leaveLeft: 'filter-actions', // Shortcut to actions
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
                    ${options.map(opt => `
                        <button class="modal-option-btn ${opt.selected ? 'selected' : ''}" 
                                data-value="${opt.value}" 
                                tabindex="0">
                            <span>${opt.label}</span>
                            <span class="check-icon">✓</span>
                        </button>
                    `).join('')}
                </div>
                <button class="modal-close-btn" id="modal-close">Close</button>
            </div>
        `;

        overlay.classList.remove('hidden');
        overlay.classList.add('visible');
        overlay.setAttribute('aria-hidden', 'false');

        // Bind clicks
        const optionBtns = overlay.querySelectorAll('.modal-option-btn');
        optionBtns.forEach(btn => {
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
    }

    /**
     * Update visibility of header elements (controls, alpha picker)
     * and patch the focus chain to bridge the gaps.
     */
    _updateHeaderVisibility() {
        const collectionType = this.state.libraryInfo?.CollectionType;
        const viewType = this.state.viewType;

        // Condition: only show for Movies (Items in movies lib) and Episodes
        const isMovieMain = (collectionType === 'movies' && viewType === 'Items');
        const isEpisodes = (viewType === 'Episodes');
        const shouldShow = isMovieMain || isEpisodes;

        const controls = this.$('#library-controls');
        const alphaPicker = this.$('#alpha-picker-container');

        if (controls) controls.style.display = shouldShow ? 'flex' : 'none';
        if (alphaPicker) alphaPicker.style.display = shouldShow ? 'block' : 'none';

        // Bridge focus chain: library-tabs -> (controls -> alpha ->) content
        const tabsContainer = this.$('#library-tabs');
        if (tabsContainer) {
            let nextTarget = 'library-controls';
            if (!shouldShow) {
                if (viewType === 'Genres' || viewType === 'Suggestions') {
                    nextTarget = 'header-0';
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

        // Update Grid leaveUp
        const gridConfig = focusManager.getSectionConfig('library-grid');
        if (gridConfig) {
            focusManager.register('library-grid', this.$('#library-grid'), {
                ...gridConfig,
                leaveUp: shouldShow ? 'alpha-picker' : 'library-tabs'
            });
        }
    }


    // ========================================================================
    // Focus Management
    // ========================================================================

    _setupFocus() {
        // Tabs (Top)
        focusManager.register('library-tabs', this.$('#library-tabs'), {
            orientation: 'horizontal',
            leaveUp: null,
            leaveDown: 'library-controls',
            leaveLeft: 'sidebar',
            scrollOffsetTop: 400
        });

        // Controls (Middle - Below Tabs)
        focusManager.register('library-controls', this.$('#library-controls'), {
            orientation: 'horizontal',
            leaveUp: 'library-tabs',
            leaveDown: 'alpha-picker',
            leaveLeft: 'sidebar'
        });

        // Alpha Picker
        focusManager.register('alpha-picker', this.$('#alpha-picker'), {
            orientation: 'horizontal',
            leaveUp: 'library-controls',
            leaveDown: 'library-grid',
            leaveLeft: 'sidebar',
            enterTo: 'active-element' // Focus the selected char
        });

        // Main Grid
        focusManager.register('library-grid', this.$('#library-grid'), {
            orientation: 'grid', // Assuming FocusManager supports grid or we trick it
            leaveUp: 'alpha-picker',
            leaveDown: 'library-pagination',
            leaveLeft: 'sidebar'
        });

        // Pagination
        focusManager.register('library-pagination', this.$('#library-pagination'), {
            orientation: 'horizontal',
            leaveUp: 'library-grid',
            leaveLeft: 'sidebar'
        });

        // Set initial focus
        this.setActiveSection('library-tabs');
    }
}

export default LibraryPage;
