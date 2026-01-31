/**
 * ============================================================================
 * Litefin Tizen - Library Page
 * ============================================================================
 * Grid view of items in a library with sorting and filtering.
 * ============================================================================
 */

import Page from './Page.js';
import { api } from '../api/index.js';
import { router } from '../core/Router.js';
import VirtualGrid from '../ui/VirtualGrid.js';
import { animationManager } from '../ui/AnimationManager.js';

class LibraryPage extends Page {
    constructor() {
        super();

        this._libraryId = null;
        this._libraryInfo = null;
        this._items = [];
        this._grid = null;
        this._sortBy = 'SortName';
        this._sortOrder = 'Ascending';
    }

    render() {
        return `
            <div class="page library-page">
                <!-- Header -->
                <!-- Actions Row (Replaces legacy header) -->
                <div class="library-actions-row" id="library-actions">
                    <nav class="header-nav">
                        <button class="nav-btn sort-btn" tabindex="0">
                            Sort: A-Z
                        </button>
                        <button class="nav-btn filter-btn" tabindex="0">
                            Filter
                        </button>
                    </nav>
                </div>
                
                <!-- Grid container -->
                <main class="page-content">
                    <div class="library-grid" id="library-grid">
                        <!-- VirtualGrid renders here -->
                    </div>
                    
                    <!-- Loading state -->
                    <div class="page-loading">
                        <div class="loading-spinner"></div>
                    </div>
                    
                    <!-- Empty state -->
                    <div class="empty-state hidden">
                        <p>No items found</p>
                    </div>
                </main>
            </div>
        `;
    }

    async onInit() {
        this._libraryId = this.params.id;

        // Setup navigation
        this._bindNavigation();

        // Setup focus
        this._setupFocus();

        // Load library content
        await this._loadLibrary();
    }

    _bindNavigation() {


        // Sort button
        this.$('.sort-btn')?.addEventListener('click', () => {
            this._toggleSort();
        });
    }

    _setupFocus() {
        this.registerFocusSection('library-actions', this.$('#library-actions'), {
            orientation: 'horizontal',
            leaveDown: 'library-grid',
            leaveLeft: 'sidebar'
        });
    }

    async _loadLibrary() {
        this.setLoading(true);

        try {
            // Get library info
            this._libraryInfo = await api.getItem(this._libraryId);
            this.$('#library-title').textContent = this._libraryInfo.Name;
            this.title = this._libraryInfo.Name;

            // Get items
            const response = await api.getItems({
                ParentId: this._libraryId,
                SortBy: this._sortBy,
                SortOrder: this._sortOrder,
                Limit: 200,
                Fields: 'PrimaryImageAspectRatio,BasicSyncInfo,Overview',
                ImageTypeLimit: 1,
                EnableImageTypes: 'Primary,Backdrop,Thumb'
            });

            this._items = response.Items || [];

            if (this._items.length > 0) {
                this._initGrid();
            } else {
                this.$('.empty-state')?.classList.remove('hidden');
            }

        } catch (error) {
            console.error('LibraryPage: Failed to load', error);
            this.showError('Failed to load library');
        }

        this.setLoading(false);
    }

    _initGrid() {
        const container = this.$('#library-grid');

        // Destroy existing grid
        if (this._grid) {
            this._grid.destroy();
        }

        // Create virtual grid
        this._grid = new VirtualGrid({
            container,
            itemWidth: 180,
            itemHeight: 280,
            gap: 16,
            items: this._items,
            itemRenderer: (item) => this._renderGridItem(item)
        });

        // Handle selection
        this.on('grid:select', ({ item }) => {
            router.navigate(`/details/${item.Id}`);
        });

        // Register grid section
        this.registerFocusSection('library-grid', container, {
            orientation: 'grid',
            leaveUp: 'library-actions'
        });

        this.setActiveSection('library-grid');
    }

    _renderGridItem(item) {
        const imageUrl = api.getImageUrl(item.Id, 'Primary', {
            maxWidth: 200,
            tag: item.ImageTags?.Primary
        });

        // Get year
        const year = item.ProductionYear || '';

        // Watched indicator
        const watched = item.UserData?.Played;
        const watchedHtml = watched ? '<div class="watched-badge">✓</div>' : '';

        return `
            <div class="grid-card">
                <div class="card-image">
                    <img 
                        src="${imageUrl}" 
                        alt="${item.Name}"
                        loading="lazy"
                        onerror="this.style.visibility='hidden'"
                    >
                    ${watchedHtml}
                </div>
                <div class="card-info">
                    <p class="card-title">${item.Name}</p>
                    <p class="card-year">${year}</p>
                </div>
            </div>
        `;
    }

    _toggleSort() {
        // Cycle through sort options
        if (this._sortBy === 'SortName' && this._sortOrder === 'Ascending') {
            this._sortBy = 'SortName';
            this._sortOrder = 'Descending';
            this.$('.sort-btn').textContent = 'Sort: Z-A';
        } else if (this._sortBy === 'SortName' && this._sortOrder === 'Descending') {
            this._sortBy = 'DateCreated';
            this._sortOrder = 'Descending';
            this.$('.sort-btn').textContent = 'Sort: Newest';
        } else if (this._sortBy === 'DateCreated') {
            this._sortBy = 'CommunityRating';
            this._sortOrder = 'Descending';
            this.$('.sort-btn').textContent = 'Sort: Rating';
        } else {
            this._sortBy = 'SortName';
            this._sortOrder = 'Ascending';
            this.$('.sort-btn').textContent = 'Sort: A-Z';
        }

        // Reload with new sort
        this._loadLibrary();
    }

    onBack() {
        router.back();
    }

    destroy() {
        if (this._grid) {
            this._grid.destroy();
        }
        super.destroy();
    }
}

export default LibraryPage;
