import Page from './Page.js';
import { api } from '../api/index.js';
import { router } from '../core/Router.js';
import { state } from '../core/StateManager.js';
import { focusManager } from '../ui/FocusManager.js';
import CardRenderer from '../utils/CardRenderer.js';
import { VirtualCardRow } from '../components/VirtualCardRow.js';
import { lazyLoader } from '../utils/LazyLoader.js';
import { logger } from '../utils/Logger.js';
import { i18n } from '../utils/i18n.js';
import { storage } from '../utils/StorageService.js';

const log = logger.create('FavoritesPage');

class FavoritesPage extends Page {
    constructor() {
        super();
        // Title translated in onInit

        // Mark as async page for Navigation State
        this._isAsyncPage = true;
    }

    render() {
        return `
            <div class="page favorites-page home-page">

                <main class="page-content" id="favorites-content">
                    <div id="favorites-rows" class="home-rows"></div>
                </main>
            </div>
        `;
    }

    async onInit() {
        this.title = i18n.t('Favorites');
        this._bindNavigation();
        await this._loadFavorites();

        // Mark the page as rendered, fulfilling the Promise for NavigationState
        // to restore scroll/focus
        this.markReady();
    }

    onDestroyed() {
        // if (this.header) {
        //     this.header.destroy();
        // }
    }

    _bindNavigation() {
        // Nav listeners handled by Sidebar now
        // We no longer register a 'header' focus section here because the Sidebar is global
    }

    async _loadFavorites() {
        this.setLoading(true);

        try {
            const userId = typeof api.userId === 'function' ? api.userId() : api._userId;
            if (!userId) throw new Error('User not authenticated');

            // Parallel fetch of all favorite types, including music and live tv, plus user library views
            const [movies, shows, seasons, episodes, channels, people, artists, albums, songs, viewsResponse] = await Promise.all([
                api.getItems({
                    Filters: 'IsFavorite',
                    IncludeItemTypes: 'Movie',
                    SortBy: 'SortName',
                    SortOrder: 'Ascending',
                    Limit: 50,
                    Fields: 'PrimaryImageAspectRatio,DateCreated,ProductionYear'
                }),
                api.getItems({
                    Filters: 'IsFavorite',
                    IncludeItemTypes: 'Series',
                    SortBy: 'SortName',
                    SortOrder: 'Ascending',
                    Limit: 50,
                    Fields: 'PrimaryImageAspectRatio,ProductionYear,UnplayedItemCount,UserData'
                }),
                api.getItems({
                    Filters: 'IsFavorite',
                    IncludeItemTypes: 'Season',
                    SortBy: 'SortName',
                    SortOrder: 'Ascending',
                    Limit: 50,
                    Fields: 'PrimaryImageAspectRatio,ParentTitle,ProductionYear,UnplayedItemCount,UserData'
                }),
                api.getItems({
                    Filters: 'IsFavorite',
                    IncludeItemTypes: 'Episode',
                    SortBy: 'DateCreated',
                    SortOrder: 'Descending',
                    Limit: 50,
                    Fields: 'PrimaryImageAspectRatio,ParentTitle,Overview,RunTimeTicks,IndexNumber,ParentIndexNumber'
                }),
                api.getItems({
                    Filters: 'IsFavorite',
                    IncludeItemTypes: 'TvChannel',
                    SortBy: 'SortName',
                    SortOrder: 'Ascending',
                    Limit: 50,
                    Fields: 'PrimaryImageAspectRatio'
                }),
                api.get('/Persons', {
                    Filters: 'IsFavorite',
                    UserId: userId,
                    SortBy: 'SortName',
                    SortOrder: 'Ascending',
                    Limit: 50,
                    Fields: 'PrimaryImageAspectRatio'
                }),
                // --- Music Types --- (Note: artists use the dedicated /Artists endpoint
                // because the /Items endpoint with IsFavorite + MusicArtist filtering
                // doesn't work properly — /Artists has explicit favorite support)
                api.getFavoriteArtists(),
                api.getItems({
                    Filters: 'IsFavorite',
                    IncludeItemTypes: 'MusicAlbum',
                    SortBy: 'SortName',
                    SortOrder: 'Ascending',
                    Limit: 50,
                    Fields: 'PrimaryImageAspectRatio,ProductionYear,AlbumArtist,Artists'
                }),
                api.getItems({
                    Filters: 'IsFavorite',
                    IncludeItemTypes: 'Audio',
                    SortBy: 'SortName',
                    SortOrder: 'Ascending',
                    Limit: 50,
                    Fields: 'PrimaryImageAspectRatio,ProductionYear,AlbumArtist,Artists,RunTimeTicks'
                }),
                api.getUserViews()
            ]);

            // =========================================================================
            // RESOLVE USER LIBRARIES FOR CLICKABLE HEADERS
            // =========================================================================
            // Parse through the user's active root libraries (views) returned by 
            // the server, mapping each CollectionType to its corresponding Library ID.
            // This mapping enables header buttons to route to the correct library view.
            // =========================================================================
            const views = viewsResponse?.Items || [];
            const libraryMap = {};
            for (const view of views) {
                if (view.CollectionType && !libraryMap[view.CollectionType]) {
                    libraryMap[view.CollectionType] = view.Id;
                }
            }
            this._libraryMap = libraryMap;

            this.setLoading(false);

            const container = this.$('#favorites-rows');
            if (!container) return;
            container.innerHTML = '';

            // Prepare sections data (video, people, then music)
            const sectionsData = [];
            if (movies.TotalRecordCount > 0)
                sectionsData.push({ id: 'fav-movie', title: i18n.t('Movies'), items: movies.Items, type: 'movie' });
            if (shows.TotalRecordCount > 0)
                sectionsData.push({
                    id: 'fav-series',
                    title: i18n.t('TypeOptionPluralSeries'),
                    items: shows.Items,
                    type: 'series'
                });
            if (seasons.TotalRecordCount > 0)
                sectionsData.push({
                    id: 'fav-season',
                    title: i18n.t('HeaderSeasons'),
                    items: seasons.Items,
                    type: 'season'
                });
            if (episodes.TotalRecordCount > 0)
                sectionsData.push({
                    id: 'fav-episode',
                    title: i18n.t('Episodes'),
                    items: episodes.Items,
                    type: 'episode'
                });
            if (channels.TotalRecordCount > 0)
                sectionsData.push({
                    id: 'fav-channel',
                    title: i18n.t('LiveTv'),
                    items: channels.Items,
                    type: 'square'
                });
            if (people.TotalRecordCount > 0)
                sectionsData.push({ id: 'fav-person', title: i18n.t('People'), items: people.Items, type: 'person' });
            // --- Music sections --- (type: 'artist' routes to PersonPage, 'square' for card shape)
            if (artists.TotalRecordCount > 0)
                sectionsData.push({ id: 'fav-artist', title: i18n.t('Artists'), items: artists.Items, type: 'artist' });
            if (albums.TotalRecordCount > 0)
                sectionsData.push({ id: 'fav-album', title: i18n.t('Albums'), items: albums.Items, type: 'square' });
            if (songs.TotalRecordCount > 0)
                sectionsData.push({ id: 'fav-song', title: i18n.t('Songs'), items: songs.Items, type: 'square' });

            if (sectionsData.length === 0) {
                container.innerHTML = `<div class="page-error" style="display:block; position:static; margin:40px;">${i18n.t('NoFavoritesFound')}</div>`;
                return;
            }

            // Render and Link Sections
            for (let i = 0; i < sectionsData.length; i++) {
                const current = sectionsData[i];
                const prevId = i > 0 ? sectionsData[i - 1].id : null;
                const nextId = i < sectionsData.length - 1 ? sectionsData[i + 1].id : null;

                this._renderSection(current.title, current.items, current.type, current.id, prevId, nextId);
            }

            // Start lazy loading to catch any immediately visible cover art
            lazyLoader.observe(container);

            // Notify base Page class that async content is ready for focus restoration
            this.restoreScrollFocusWhenReady();

            requestAnimationFrame(() => {
                const lastFocusedObj = state.get('favorites:lastFocusedItem');
                let restoredFocus = false;

                if (lastFocusedObj) {
                    const targetId = lastFocusedObj.itemId;
                    const sectionId = lastFocusedObj.sectionId;

                    const savedCard = container.querySelector(
                        `#${sectionId}-items .media-card[data-item-id="${targetId}"]`
                    );

                    if (savedCard) {
                        this.setActiveSection(sectionId, false);
                        focusManager.focusElement(savedCard, { instantScroll: true });
                        restoredFocus = true;
                    }

                    state.delete('favorites:lastFocusedItem');
                }

                // Set initial focus to first content row if nothing was restored
                if (!restoredFocus && sectionsData.length > 0) {
                    const firstSectionId = sectionsData[0].id;
                    this.setActiveSection(firstSectionId, false);

                    const firstCard = container.querySelector(`#${firstSectionId}-items .media-card`);
                    if (firstCard) {
                        focusManager.focusElement(firstCard, { instantScroll: true });
                    }
                } else if (!restoredFocus && sectionsData.length === 0) {
                    // If no favorites exist, just make sure sidebar has focus
                    if (!focusManager.getFocused()) {
                        this.setActiveSection('sidebar');
                    }
                }
            });
        } catch (e) {
            log.error('Failed to load favorites', e);
            this.setLoading(false);
            const container = this.$('#favorites-rows');
            if (container)
                container.innerHTML = `<div class="page-error" style="display:block; padding: 20px;">Failed to load favorites: ${e.message || e}</div>`;
        }
    }

    _renderSection(title, items, type, sectionId, prevId, nextId) {
        const container = this.$('#favorites-rows');

        // =====================================================================
        // HTML RENDERING WITH FOCUSABLE HEADER
        // =====================================================================
        // Renders the section header as a button with class 
        // 'favorites-header-focusable' to style it completely independently
        // of library page layouts.
        // =====================================================================
        const sectionHtml = `
             <div class="media-row" id="${sectionId}-row">
                 <div class="favorites-row-header">
                     <button class="favorites-header-focusable" tabindex="0" data-section-id="${sectionId}">
                         <span class="favorites-header-title">${title}</span>
                     </button>
                 </div>
                 <div class="row-items" id="${sectionId}-items">
                     <div class="row-items-track"></div>
                 </div>
             </div>
         `;

        // Append HTML row to the parent favorites rows container
        const temp = document.createElement('div');
        temp.innerHTML = sectionHtml;
        const rowEl = temp.firstElementChild;
        container.appendChild(rowEl);

        const itemsContainer = rowEl.querySelector('.row-items');
        const trackContainer = rowEl.querySelector('.row-items-track');

        let virtualRow = null;

        // =====================================================================
        // FORCE EXPANDABLE POSTERS COERCION
        // =====================================================================
        // Checks if the user is running the Modern layout and has toggled on
        // the "Force Expandable Posters" preference under display settings.
        // If active, we dynamically coerce all horizontal favorite tracks
        // to render as portrait posters that expand horizontally on focus.
        // =====================================================================
        const isModern = document.documentElement.getAttribute('data-layout-media-rows') === 'modern';
        const forceExpandablePosters = isModern && storage.getItem('pref:homeForceExpandablePosters') === 'true';

        // Coerce types to portrait/poster if preference is enabled
        const targetCardType = forceExpandablePosters ? 'poster' : type;
        const targetIsLandscape = forceExpandablePosters ? false : type === 'episode';

        // Initialize VirtualCardRow
        virtualRow = new VirtualCardRow(trackContainer, items, {
            isLandscape: targetIsLandscape,
            cardType: targetCardType, // Pass through for height calculation
            visibleCount: targetIsLandscape ? 8 : 12,
            focusSectionId: sectionId,
            renderCard: (item) =>
                CardRenderer.createCardHtml(item, {
                    isLandscape: targetIsLandscape,
                    type: targetCardType
                })
        });

        if (!this._virtualRows) this._virtualRows = {};
        this._virtualRows[sectionId] = virtualRow;

        // =====================================================================
        // ROW CLICK LISTENER (CARDS & HEADERS)
        // =====================================================================
        // Handle click/activation on both media cards and the row header button.
        // Header clicks navigate to the library view filtered by favorite status.
        // =====================================================================
        rowEl.onclick = (e) => {
            const headerBtn = e.target.closest('.favorites-header-focusable');
            if (headerBtn) {
                e.preventDefault();
                e.stopPropagation();

                // Get library ID mapping determined in loadFavorites
                const map = this._libraryMap || {};
                let targetPath = '/library/all';

                // Map row section to target library collection and item types
                if (sectionId === 'fav-movie') {
                    targetPath = `/library/${map['movies'] || 'all'}?includeItemTypes=Movie`;
                } else if (sectionId === 'fav-series') {
                    targetPath = `/library/${map['tvshows'] || 'all'}?includeItemTypes=Series`;
                } else if (sectionId === 'fav-season') {
                    targetPath = `/library/${map['tvshows'] || 'all'}?includeItemTypes=Season`;
                } else if (sectionId === 'fav-episode') {
                    targetPath = `/library/${map['tvshows'] || 'all'}?includeItemTypes=Episode`;
                } else if (sectionId === 'fav-channel') {
                    targetPath = `/library/all?includeItemTypes=TvChannel`;
                } else if (sectionId === 'fav-person') {
                    targetPath = `/library/all?includeItemTypes=Person`;
                } else if (sectionId === 'fav-artist') {
                    targetPath = `/library/${map['music'] || 'all'}?includeItemTypes=MusicArtist,Artist`;
                } else if (sectionId === 'fav-album') {
                    targetPath = `/library/${map['music'] || 'all'}?includeItemTypes=MusicAlbum`;
                } else if (sectionId === 'fav-song') {
                    targetPath = `/library/${map['music'] || 'all'}?includeItemTypes=Audio`;
                }

                // Build destination URL with IsFavorite query filter parameter
                const destination = `${targetPath}${targetPath.includes('?') ? '&' : '?'}IsFavorite=true`;
                log.info(`Row header clicked. Navigating to favorite-filtered library: ${destination}`);
                router.navigate(destination);
                return;
            }

            const card = e.target.closest('.media-card');
            if (card && card.dataset.itemId) {
                // Save clicked item for exact focus restoration
                state.set('favorites:lastFocusedItem', {
                    itemId: card.dataset.itemId,
                    sectionId: sectionId
                });

                if (type === 'person' || type === 'artist') {
                    // Both Persons and Music Artists navigate to the PersonPage
                    router.navigate(`/person/${card.dataset.itemId}`);
                } else {
                    router.navigate(`/details/${card.dataset.itemId}`);
                }
            }
        };

        // Focus index synchronization
        rowEl.addEventListener('focusin', (e) => {
            if (e.target.classList.contains('media-card') && virtualRow) {
                virtualRow.syncIndexFromNode(e.target);
            }
        });

        // =====================================================================
        // FOCUS SECTION REGISTRATION
        // =====================================================================
        // Register the focus section on the row wrapper (rowEl) using 'grid'
        // orientation. This tells FocusManager to use spatial navigation for
        // Up/Down keys (enabling moving between the header button and cards),
        // while we intercept Left/Right moves on cards to shift the sliding window.
        // =====================================================================
        this.registerFocusSection(sectionId, rowEl, {
            orientation: 'grid',
            leaveUp: prevId,
            leaveDown: nextId,
            leaveLeft: 'sidebar',
            selector: '.favorites-header-focusable, .media-card', // Allow focusing both header button and cards
            onMove: (direction, currentFocused) => {
                // If focus is currently on the header button, block horizontal navigation 
                // to the right (since nothing is there), but let vertical moves and left 
                // moves (exiting to the sidebar) flow spatially.
                if (currentFocused && currentFocused.classList.contains('favorites-header-focusable')) {
                    if (direction === 'right' || direction === 'Right') {
                        return true;
                    }
                    return false;
                }

                // For media cards, intercept horizontal navigation to slide the row track
                if (direction === 'left' || direction === 'right' || direction === 'Left' || direction === 'Right') {
                    const nextNode = virtualRow.handleMove(direction);
                    if (nextNode) {
                        focusManager.focusElement(nextNode);
                        return true;
                    }
                }

                // Let vertical movement (Up to header, Down to next row) fall back to spatial navigation
                return false;
            },
            onEnter: (fromElement, options) => {
                // Only intercept for vertical entry. Pre-render window to ensure elements exist.
                if (fromElement && options && (options.direction === 'up' || options.direction === 'down')) {
                    virtualRow._updateWindow(virtualRow.currentIndex);
                }
                return null; // Return null so FocusManager performs default spatial navigation
            },
            onRestoreIndex: (index) => {
                return virtualRow.focusByIndex(index);
            }
        });
    }
}

export default FavoritesPage;
