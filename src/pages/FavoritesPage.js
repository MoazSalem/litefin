import Page from './Page.js';
import { api } from '../api/index.js';
import { router } from '../core/Router.js';
import { imageService } from '../utils/ImageService.js';

class FavoritesPage extends Page {
    constructor() {
        super();
        this.title = 'Favorites';

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
        this._bindNavigation();
        await this._loadFavorites();

        // Trigger deferred scroll/focus restoration
        this.restoreScrollFocusWhenReady();
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

            // Parallel fetch of all favorite types
            const [movies, shows, seasons, episodes, people] = await Promise.all([
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
                api.get('/Persons', {
                    Filters: 'IsFavorite',
                    UserId: userId,
                    SortBy: 'SortName',
                    SortOrder: 'Ascending',
                    Limit: 50,
                    Fields: 'PrimaryImageAspectRatio'
                })
            ]);

            this.setLoading(false);

            const container = this.$('#favorites-rows');
            if (!container) return;
            container.innerHTML = '';

            // Prepare sections data
            const sectionsData = [];
            if (movies.TotalRecordCount > 0)
                sectionsData.push({ id: 'fav-movie', title: 'Movies', items: movies.Items, type: 'movie' });
            if (shows.TotalRecordCount > 0)
                sectionsData.push({ id: 'fav-series', title: 'Shows', items: shows.Items, type: 'series' });
            if (seasons.TotalRecordCount > 0)
                sectionsData.push({ id: 'fav-season', title: 'Seasons', items: seasons.Items, type: 'season' });
            if (episodes.TotalRecordCount > 0)
                sectionsData.push({ id: 'fav-episode', title: 'Episodes', items: episodes.Items, type: 'episode' });
            if (people.TotalRecordCount > 0)
                sectionsData.push({ id: 'fav-person', title: 'People', items: people.Items, type: 'person' });

            if (sectionsData.length === 0) {
                container.innerHTML =
                    '<div class="page-error" style="display:block; position:static; margin:40px;">No favorites found. Go add some!</div>';
                return;
            }

            // Render and Link Sections
            for (let i = 0; i < sectionsData.length; i++) {
                const current = sectionsData[i];
                const prevId = i > 0 ? sectionsData[i - 1].id : null;
                const nextId = i < sectionsData.length - 1 ? sectionsData[i + 1].id : null;

                this._renderSection(current.title, current.items, current.type, current.id, prevId, nextId);
            }

            // Set initial focus to first content row
            if (sectionsData.length > 0) {
                this.setActiveSection(sectionsData[0].id);
            }
        } catch (e) {
            console.error('Failed to load favorites', e);
            this.setLoading(false);
            const container = this.$('#favorites-rows');
            if (container)
                container.innerHTML = `<div class="page-error" style="display:block; padding: 20px;">Failed to load favorites: ${e.message || e}</div>`;
        }
    }

    _renderSection(title, items, type, sectionId, prevId, nextId) {
        const container = this.$('#favorites-rows');

        const itemsHtml = [];
        for (let i = 0; i < items.length; i++) {
            itemsHtml.push(this._renderCard(items[i], type));
        }

        const sectionHtml = `
             <div class="media-row" id="${sectionId}-row">
                 <h2 class="row-title">${title}</h2>
                 <div class="row-items" id="${sectionId}-items">
                     ${itemsHtml.join('')}
                 </div>
             </div>
         `;

        // Append HTML
        const temp = document.createElement('div');
        temp.innerHTML = sectionHtml;
        const rowEl = temp.firstElementChild;
        container.appendChild(rowEl);

        // Register Focus
        const itemsContainer = rowEl.querySelector('.row-items');

        // Click handling
        itemsContainer.onclick = (e) => {
            const card = e.target.closest('.media-card');
            if (card && card.dataset.id) {
                if (type === 'person') {
                    router.navigate(`/person/${card.dataset.id}`);
                } else {
                    router.navigate(`/details/${card.dataset.id}`);
                }
            }
        };

        this.registerFocusSection(sectionId, itemsContainer, {
            orientation: 'horizontal',
            leaveUp: prevId, // Remove header ref
            leaveDown: nextId,
            leaveLeft: 'sidebar'
        });
    }

    _renderCard(item, type) {
        const isEpisode = type === 'episode';
        const isPerson = type === 'person';

        const isSeason = type === 'season';

        // Image options
        const imageOpts = imageService.getParams('poster');
        const imageUrl = api.getImageUrl(item.Id, 'Primary', { ...imageOpts, tag: item.ImageTags.Primary });

        // Layout class
        // Episodes: Landscape (user requested Primary Image, which for episodes is landscape thumb usually)
        // Others: Portrait
        let cardClass = 'media-card';
        if (isEpisode) cardClass += ' landscape';

        let title = item.Name;
        let subtitle = '';

        if (isEpisode) {
            // For Episodes:
            // Title = Show Name (ParentTitle)
            // Subtitle = "SxxExx - Episode Name"
            title = item.ParentTitle || item.Name; // Default to Name if ParentTitle missing, but user wants Show Name

            const seasonIndex = item.ParentIndexNumber != null ? item.ParentIndexNumber : '?';
            const episodeIndex = item.IndexNumber != null ? item.IndexNumber : '?';
            const epName = item.Name;
            subtitle = `S${seasonIndex}E${episodeIndex} - ${epName}`;
        } else if (isSeason) {
            // For Seasons:
            // Title = Show Name (ParentTitle)
            // Subtitle = Season Name (item.Name)
            title = item.ParentTitle || item.Name;
            subtitle = item.Name; // e.g. "Season 1"
        } else if (item.ProductionYear && !isPerson) {
            subtitle = item.ProductionYear;
        }

        // Try getting count from root or UserData
        let count = item.UnplayedItemCount;
        if (count === undefined && item.UserData && item.UserData.UnplayedItemCount !== undefined) {
            count = item.UserData.UnplayedItemCount;
        }

        return `
            <button class="${cardClass}" data-id="${item.Id}" tabindex="0">
                <div class="card-image">
                    <img src="${imageUrl}" alt="${title}" loading="lazy" />
                    ${count ? `<div class="count-badge">${count}</div>` : ''}
                </div>
                <div class="card-info">
                    <div class="card-title">${title}</div>
                    ${!isPerson ? `<div class="card-subtitle">${subtitle}</div>` : ''}
                </div>
            </button>
        `;
    }
}

export default FavoritesPage;
