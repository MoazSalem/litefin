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

            // Parallel fetch of all favorite types, including music and live tv
            const [movies, shows, seasons, episodes, channels, people, artists, albums, songs] = await Promise.all([
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
                })
            ]);

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

        const sectionHtml = `
             <div class="media-row" id="${sectionId}-row">
                 <h2 class="row-title">${title}</h2>
                 <div class="row-items" id="${sectionId}-items">
                     <div class="row-items-track"></div>
                 </div>
             </div>
         `;

        // Append HTML
        const temp = document.createElement('div');
        temp.innerHTML = sectionHtml;
        const rowEl = temp.firstElementChild;
        container.appendChild(rowEl);

        const itemsContainer = rowEl.querySelector('.row-items');
        const trackContainer = rowEl.querySelector('.row-items-track');

        let virtualRow = null;

        // ==========================================================
        // Force Expandable Posters Logic for Favorites
        // ==========================================================
        // Checks if the user is running the Modern layout and has toggled on
        // the "Force Expandable Posters" preference under display settings.
        // If active, we dynamically coerce all horizontal favorite tracks
        // to render as portrait posters that expand horizontally on focus.
        // This creates a gorgeous, unified visual aesthetic that matches
        // Apple HIG style and matches our homepage layout conversion.
        // ==========================================================
        const isModern = document.documentElement.getAttribute('data-layout') === 'modern';
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

        // Click handling
        itemsContainer.onclick = (e) => {
            const card = e.target.closest('.media-card');
            if (card && card.dataset.itemId) {
                // Save clicked item for exact focus restoration
                state.set('favorites:lastFocusedItem', {
                    itemId: card.dataset.itemId,
                    sectionId: sectionId
                });

                if (type === 'person' || type === 'artist') {
                    // Both Persons and Music Artists navigate to the PersonPage
                    // (artists have their albums/songs shown there)
                    router.navigate(`/person/${card.dataset.itemId}`);
                } else {
                    router.navigate(`/details/${card.dataset.itemId}`);
                }
            }
        };

        // Focus index synchronization
        itemsContainer.addEventListener('focusin', (e) => {
            if (e.target.classList.contains('media-card') && virtualRow) {
                virtualRow.syncIndexFromNode(e.target);
            }
        });

        this.registerFocusSection(sectionId, itemsContainer, {
            orientation: 'horizontal',
            leaveUp: prevId, // Remove header ref
            leaveDown: nextId,
            leaveLeft: 'sidebar',
            onMove: (direction) => {
                const nextNode = virtualRow.handleMove(direction);
                if (nextNode) {
                    focusManager.focusElement(nextNode);
                    return true;
                }
                return false;
            },
            onEnter: (fromElement, options) => {
                // Only intercept for vertical entry. Horizontal entry (e.g. from sidebar) should use memory.
                if (fromElement && options && (options.direction === 'up' || options.direction === 'down')) {
                    virtualRow._updateWindow(virtualRow.currentIndex);
                    return virtualRow.domNodes.get(virtualRow.currentIndex);
                }
                return null;
            },
            onRestoreIndex: (index) => {
                return virtualRow.focusByIndex(index);
            }
        });
    }
}

export default FavoritesPage;
