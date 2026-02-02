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
                                    Shuffle
                                </button>
                                <button class="control-btn" id="btn-sort" tabindex="0">
                                    <span class="icon">
                                        <svg viewBox="0 0 24 24" fill="none" class="control-svg">
                                            <path d="M3 6H21" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                                            <path d="M7 12H17" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                                            <path d="M11 18H13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                                        </svg>
                                    </span> 
                                    Sort
                                </button>
                                <button class="control-btn" id="btn-filter" tabindex="0">
                                    <span class="icon">
                                        <svg viewBox="0 0 24 24" fill="none" class="control-svg">
                                            <path d="M21 4H3L10 12.42V19L14 21V12.42L21 4Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                        </svg>
                                    </span> 
                                    Filter
                                </button>
                                <button class="control-btn" id="btn-prev-top" tabindex="0">Prev</button>
                                <button class="control-btn" id="btn-next-top" tabindex="0">Next</button>
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
                        <button class="pagination-btn" id="btn-prev" tabindex="0">Previous</button>
                        <span class="pagination-info" id="pagination-info">Page 1</span>
                        <button class="pagination-btn" id="btn-next" tabindex="0">Next</button>
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

        // 4. Initial Data Load
        await this._loadItems();

        // 5. Register Focus
        this._setupFocus();
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

            } else if (viewType === 'Genres') {
                // TODO: Fetch Genres
                // result = await api.getGenres(...);
                result = { Items: [], TotalRecordCount: 0 };
            } else {
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
        }
    }

    _updatePaginationUI() {
        const { startIndex, limit, totalRecordCount } = this.state;
        const currentPage = Math.floor(startIndex / limit) + 1;
        const totalPages = Math.ceil(totalRecordCount / limit);

        this.$('#pagination-info').textContent = `Page ${currentPage} of ${totalPages || 1}`;

        // Disable/Enable buttons
        const isPrevDisabled = startIndex <= 0;
        const isNextDisabled = (startIndex + limit) >= totalRecordCount;

        this.$('#btn-prev').disabled = isPrevDisabled;
        this.$('#btn-next').disabled = isNextDisabled;

        const btnPrevTop = this.$('#btn-prev-top');
        const btnNextTop = this.$('#btn-next-top');
        if (btnPrevTop) btnPrevTop.disabled = isPrevDisabled;
        if (btnNextTop) btnNextTop.disabled = isNextDisabled;
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
        // Only show Alpha Picker for "Items" view (and maybe others later)
        const showPicker = this.state.viewType === 'Items' || this.state.viewType === 'Episodes';
        const container = this.$('#alpha-picker-container');

        if (container) {
            container.style.visibility = showPicker ? 'visible' : 'hidden';
            // Disable focus if hidden
            if (!showPicker) {
                // focusManager.unregister('alpha-picker'); // Optional if we want to be strict
            }
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

        // Re-register focus for grid items
        focusManager.register('library-grid', this.$('#library-grid'), {
            orientation: 'grid',
            leaveUp: 'alpha-picker',
            leaveDown: 'library-pagination',
            leaveLeft: 'sidebar',
            scrollOffsetTop: 60 // Header height buffer
        });
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
        // "Hidden for Shows"
        const type = this.state.libraryInfo?.CollectionType;
        const btnShuffle = this.$('#btn-shuffle');

        if (btnShuffle) {
            // Hide if TV Shows (or if logic demands it)
            if (type === 'tvshows') {
                btnShuffle.style.display = 'none';
            } else {
                btnShuffle.style.display = ''; // Restore default
            }
        }
    }

    _handleSort() {
        const currentSort = this.state.sortBy;
        const currentOrder = this.state.sortOrder;

        const options = [
            { label: 'Name (A-Z)', value: 'SortName,Ascending', selected: currentSort === 'SortName' && currentOrder === 'Ascending' },
            { label: 'Name (Z-A)', value: 'SortName,Descending', selected: currentSort === 'SortName' && currentOrder === 'Descending' },
            { label: 'Date Added (Newest)', value: 'DateCreated,Descending', selected: currentSort === 'DateCreated' && currentOrder === 'Descending' },
            { label: 'Date Added (Oldest)', value: 'DateCreated,Ascending', selected: currentSort === 'DateCreated' && currentOrder === 'Ascending' },
            { label: 'Release Date (Newest)', value: 'PremiereDate,Descending', selected: currentSort === 'PremiereDate' && currentOrder === 'Descending' },
            { label: 'Release Date (Oldest)', value: 'PremiereDate,Ascending', selected: currentSort === 'PremiereDate' && currentOrder === 'Ascending' },
            { label: 'Rating (High-Low)', value: 'CommunityRating,Descending', selected: currentSort === 'CommunityRating' && currentOrder === 'Descending' },
            { label: 'Play Count', value: 'PlayCount,Descending', selected: currentSort === 'PlayCount' },
            { label: 'Runtime', value: 'Runtime,Descending', selected: currentSort === 'Runtime' }
        ];

        this._renderModal('Sort By', options, async (value) => {
            const [sort, order] = value.split(',');
            this.state.sortBy = sort;
            this.state.sortOrder = order || 'Descending';
            this.state.startIndex = 0;
            await this._loadItems();
            this._closeModal();
            this.focus('btn-sort'); // Restore focus
        });
    }

    _handleFilter() {
        // Simple Filters for now
        const currentFilters = this.state.filters; // Array

        const options = [
            { label: 'Unplayed', value: 'IsUnplayed', selected: currentFilters.includes('IsUnplayed') },
            { label: 'Played', value: 'IsPlayed', selected: currentFilters.includes('IsPlayed') },
            { label: 'Favorites', value: 'IsFavorite', selected: currentFilters.includes('IsFavorite') },
            { label: 'Resumable', value: 'IsResumable', selected: currentFilters.includes('IsResumable') }
        ];

        this._renderModal('Filter', options, async (value) => {
            // Toggle Logic
            if (this.state.filters.includes(value)) {
                this.state.filters = this.state.filters.filter(f => f !== value);
            } else {
                // Exclusive logic for Played/Unplayed?
                if (value === 'IsUnplayed') this.state.filters = this.state.filters.filter(f => f !== 'IsPlayed');
                if (value === 'IsPlayed') this.state.filters = this.state.filters.filter(f => f !== 'IsUnplayed');

                this.state.filters.push(value);
            }

            this.state.startIndex = 0;
            await this._loadItems();
            this._closeModal();
            this.focus('btn-filter'); // Restore focus
        });
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

        focusManager.unregister('library-modal'); // Cleanup

        overlay.classList.remove('visible');
        overlay.setAttribute('aria-hidden', 'true');

        // Cleanup content after animation
        setTimeout(() => {
            overlay.innerHTML = '';
        }, 300);

        // Restore focus
        if (this._prevFocus && document.body.contains(this._prevFocus)) {
            focusManager.focusElement(this._prevFocus);
        } else if (this._prevSection) {
            focusManager.setActiveSection(this._prevSection);
        }
    }

    onBack() {
        const overlay = this.$('#modal-overlay');
        if (overlay && overlay.classList.contains('visible')) {
            this._closeModal();
            return true; // Handled
        }
        return false; // Propagate
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
