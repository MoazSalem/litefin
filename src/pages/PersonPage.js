/**
 * ============================================================================
 * Litefin Tizen - Person Page
 * ============================================================================
 * Display cast/crew details and their works (Movies -> Shows -> Episodes).
 * ============================================================================
 */

import Page from './Page.js';
import { api } from '../api/index.js';
import { router } from '../core/Router.js';
import { focusManager } from '../ui/FocusManager.js';
import { imageService } from '../utils/ImageService.js';
import MediaGrid from '../components/MediaGrid.js';
import { i18n } from '../utils/i18n.js';
import { state } from '../core/StateManager.js';
import { lazyLoader } from '../utils/LazyLoader.js';

import FavoriteButton from '../components/FavoriteButton.js';
import BackdropManager from '../utils/BackdropManager.js';
import CardRenderer from '../utils/CardRenderer.js';
import { logger } from '../utils/Logger.js';

const log = logger.create('PersonPage');

class PersonPage extends Page {
    constructor() {
        super();
        this._personId = null;
        this._person = null;
        this._items = [];
        this._grids = {}; // Store component instances
    }

    onInit() {
        this._personId = this.params.id;

        if (!this._personId) {
            log.error('No person ID provided');
            router.back();
            return;
        }

        try {
            this._setupFocus();
            this._loadPersonDetails();
        } catch (err) {
            log.error('onInit critical failure', err);
            this.showError('Critical Error: ' + err.message);
        }
    }

    render() {
        return `
            <div class="page person-page" id="person-page">
                <!-- Backdrop -->
                <div class="details-backdrop" id="person-backdrop">
                    <div class="backdrop-gradient"></div>
                </div>

                <div class="page-content">
                    <div class="page-error" style="display:none; padding: 20px; color: #ff6b6b; text-align: center;"></div>


                    <div class="details-main-split media-row">
                        <!-- Left: Poster -->
                        <div class="hero-poster" id="person-poster">
                            <!-- Img injected here -->
                        </div>

                        <!-- Right: Info -->
                        <div class="details-info-col" id="person-info-col">
                            <h1 class="details-title" id="person-name"></h1>
                            
                            <!-- Born / Place -->
                            <div class="details-meta-row" id="person-meta"></div>

                            <!-- Bio -->
                            <div class="details-overview overview-text line-clamp-6" id="person-bio"></div>

                            <!-- Actions (Favorite) -->
                            <div class="person-actions-row" id="person-fav-actions"></div>
                        </div>
                    </div>

                    <!-- Works Section -->
                    <div class="person-works" id="person-works">
                        <!-- MediaGrids injected here -->
                    </div>
                </div>
            </div>
        `;
    }

    async _loadPersonDetails() {
        this.setLoading(true);

        try {
            // 1. Fetch Person Details
            this._person = await api.getPerson(this._personId);
            this.title = this._person.Name;

            this._renderPersonInfo();

            // 2. Determine if this is a music artist or an actor/person
            const isArtist = this._person.Type === 'MusicArtist' || this._person.Type === 'Artist';

            if (isArtist) {
                // --- Music Artist Mode: load Albums and Songs ---
                const [albumsResult, songsResult] = await Promise.all([
                    api.getArtistAlbums(this._personId),
                    api.getArtistSongs(this._personId)
                ]);

                log.debug('Loaded artist content', {
                    albums: albumsResult.Items?.length ?? 0,
                    songs: songsResult.Items?.length ?? 0
                });

                this._renderArtistWorks(albumsResult.Items || [], songsResult.Items || []);
            } else {
                // --- Actor / Crew Mode: load Movies/Shows/Episodes ---
                const result = await api.getPersonItems(this._personId);
                this._items = result.Items || [];

                log.debug('Loaded items', {
                    total: this._items.length,
                    movies: this._items.filter((i) => i.Type === 'Movie').length,
                    shows: this._items.filter((i) => i.Type === 'Series').length,
                    episodes: this._items.filter((i) => i.Type === 'Episode').length
                });

                this._renderWorks();

                // Background: Fetch role names and update UI when ready
                this._loadRolesInBackground();
            }

            // Set background (Person's own, or fallback to best work for actors)
            this._setSmartBackdrop();
        } catch (error) {
            log.error('Failed to load', error);
            this.showError('Failed to load person details');
        } finally {
            this.setLoading(false);

            // Focus Nav restored or default
            requestAnimationFrame(() => {
                const stateKey = `person:lastFocusedItem:${this._personId}`;
                const lastFocusedObj = state.get(stateKey);
                let restoredFocus = false;

                if (lastFocusedObj) {
                    const targetId = lastFocusedObj.itemId;
                    const sectionId = lastFocusedObj.sectionId;

                    const sectionConfig = focusManager.getSectionConfig(sectionId);
                    const sectionContainer = sectionConfig ? sectionConfig.container : this.el;

                    // Ensure the grid is expanded if the item is beyond the limit
                    const gridKeyMap = {
                        'person-movies-items': 'movies',
                        'person-shows-items': 'shows',
                        'person-episodes-items': 'episodes'
                    };
                    const gridKey = gridKeyMap[sectionId];
                    if (gridKey && this._grids[gridKey]) {
                        const grid = this._grids[gridKey];
                        const index = grid.items.findIndex((i) => i.Id === targetId || i.Id?.toString() === targetId);
                        if (index >= grid.limit && !grid.expanded) {
                            grid.expanded = true;
                            // Re-render items synchronously so the DOM query below succeeds
                            const gridContainer = this.$(`#${grid.id}-items`);
                            if (gridContainer) {
                                gridContainer.innerHTML = grid._renderItems();
                                lazyLoader.observe(gridContainer);
                                focusManager.invalidateCache(`${grid.id}-items`);
                            }
                            // Update button visually
                            const btn = this.$(`#${grid.id}-btn`);
                            if (btn) btn.textContent = i18n.t('ShowLess');

                            // Re-apply roles if needed
                            if (gridKey !== 'episodes') {
                                this._applyRolesToCards();
                            }
                        }
                    }

                    const savedCard = sectionContainer.querySelector(
                        `[data-item-id="${targetId}"], [data-id="${targetId}"]`
                    );

                    if (savedCard) {
                        this.setActiveSection(sectionId, false);
                        focusManager.focusElement(savedCard, { instantScroll: true });
                        restoredFocus = true;
                    }

                    state.delete(stateKey);
                }

                if (!restoredFocus) {
                    this.setActiveSection('person-fav-actions');
                }
            });
        }
    }

    _setSmartBackdrop() {
        const backdropEl = this.$('#person-backdrop');
        if (!backdropEl) return;

        // Use smart backdrop logic from manager.
        // In artist mode this._items is not populated, so we pass an empty array
        // for graceful degradation (the artist's own poster/backdrop will be used if available).
        const backdropUrl = BackdropManager.getPersonBackdropUrl(this._person, this._items || []);

        if (backdropUrl) {
            BackdropManager.applyBackdrop(backdropEl, backdropUrl);
        }
    }

    _renderPersonInfo() {
        const p = this._person;

        // Render Favorite Button
        const favContainer = this.$('#person-fav-actions');
        log.debug('Rendering Favorite Button', {
            containerFound: !!favContainer,
            personId: p.Id,
            isFavorite: p.UserData?.IsFavorite
        });

        if (favContainer) {
            // Destroy existing
            if (this._favBtn) this._favBtn.destroy();

            this._favBtn = new FavoriteButton({
                itemId: p.Id,
                initialState: p.UserData?.IsFavorite,
                onChange: (isFav) => {
                    // Update local model
                    if (!p.UserData) p.UserData = {};
                    p.UserData.IsFavorite = isFav;
                }
            });

            // Clear and mount (force layout)
            favContainer.innerHTML = '';
            favContainer.style.display = 'flex'; // FORCE display
            this._favBtn.mount(favContainer);

            // Wait for next frame to ensure DOM is ready
            requestAnimationFrame(() => {
                focusManager.invalidateCache('person-fav-actions');
                log.debug('Favorite cache invalidated. Button offsetParent:', this._favBtn.el?.offsetParent);
            });
            log.debug('Favorite Button mounted');
        } else {
            log.error('Could not find #person-fav-actions container');
        }

        // Name
        const nameEl = this.$('#person-name');
        if (nameEl) nameEl.textContent = p.Name;

        // Poster
        const posterContainer = this.$('#person-poster');
        const isArtist = p.Type === 'MusicArtist' || p.Type === 'Artist';

        // Add square class if it's a music artist
        if (posterContainer) {
            if (isArtist) {
                posterContainer.classList.add('square');
            } else {
                posterContainer.classList.remove('square');
            }
        }

        const fallbackHtml = CardRenderer.getFallbackHtml(p, false);

        if (posterContainer) {
            if ((p.ImageTags && p.ImageTags.Primary) || isArtist) {
                const params = imageService.getParams('poster');
                const url = api.getImageUrl(p.Id, 'Primary', {
                    maxWidth: params.maxWidth,
                    quality: params.quality,
                    ...(p.ImageTags?.Primary ? { tag: p.ImageTags.Primary } : {})
                });

                posterContainer.innerHTML = `<img src="${url}" alt="${p.Name}" />`;
                const imgEl = posterContainer.querySelector('img');
                if (imgEl) {
                    imgEl.onload = () => imgEl.classList.add('loaded');
                    imgEl.onerror = () => {
                        imgEl.style.display = 'none';
                        posterContainer.insertAdjacentHTML('afterbegin', fallbackHtml);
                    };
                }
            } else {
                posterContainer.innerHTML = fallbackHtml;
            }
        }

        // Meta (Born / Death / Place)
        const metaEl = this.$('#person-meta');
        if (metaEl) {
            const parts = [];

            if (p.PremiereDate) {
                try {
                    const born = new Date(p.PremiereDate).getFullYear();
                    parts.push(i18n.t('BirthDateValue', [born]));
                } catch (e) {}
            }

            if (p.EndDate) {
                try {
                    const died = new Date(p.EndDate).getFullYear();
                    parts.push(i18n.t('DeathDateValue', [died]));
                } catch (e) {}
            }

            if (p.ProductionLocations && p.ProductionLocations.length > 0) {
                parts.push(i18n.t('BirthPlaceValue', [p.ProductionLocations[0]]));
            }

            metaEl.textContent = parts.join(' • ');
        }

        // Bio
        const bioEl = this.$('#person-bio');
        if (bioEl) {
            bioEl.textContent = p.Overview || '';
        }

        // Force visibility immediately (bypass CSS transition issues)
        const infoCol = this.$('#person-info-col');
        if (infoCol) {
            infoCol.style.opacity = '1';
            infoCol.classList.add('visible');
        }
    }

    /**
     * Load character roles in background and update cards when ready
     */
    async _loadRolesInBackground() {
        try {
            const result = await api.getPersonItemsWithRoles(this._personId);
            const itemsWithPeople = result.Items || [];

            // Build role lookup map
            this._roleMap = new Map();
            itemsWithPeople.forEach((item) => {
                if (item.People) {
                    const person = item.People.find((p) => p.Id === this._personId);
                    if (person?.Role) {
                        this._roleMap.set(item.Id, person.Role);
                    }
                }
            });

            // Apply roles to visible cards
            this._applyRolesToCards();

            log.debug(`Added ${this._roleMap.size} character roles`);
        } catch (error) {
            log.warn('Could not load character roles', error);
        }
    }

    /**
     * Apply stored roles to visible cards (called after initial load and after expansion)
     */
    _applyRolesToCards() {
        if (!this._roleMap || this._roleMap.size === 0) return;

        this._roleMap.forEach((role, itemId) => {
            const card = document.querySelector(`.media-card[data-item-id="${itemId}"]`);
            if (card) {
                const subtitle = card.querySelector('.card-subtitle');
                if (subtitle) {
                    const currentText = subtitle.textContent;
                    // Add role to existing subtitle (e.g., "2024 · as John Smith")
                    const asPrefix = i18n.t('LabelAsRole', ['']).trim();
                    if (!currentText.includes(asPrefix)) {
                        subtitle.textContent = currentText
                            ? `${currentText} · ${i18n.t('LabelAsRole', [role])}`
                            : i18n.t('LabelAsRole', [role]);
                    }
                } else {
                    // Create subtitle if it doesn't exist
                    const cardInfo = card.querySelector('.card-info');
                    if (cardInfo) {
                        const newSubtitle = document.createElement('div');
                        newSubtitle.className = 'card-subtitle';
                        newSubtitle.textContent = i18n.t('LabelAsRole', [role]);
                        cardInfo.appendChild(newSubtitle);
                    }
                }
            }
        });
    }

    _renderWorks() {
        const worksContainer = this.$('#person-works');
        worksContainer.innerHTML = ''; // Clear previous

        // Helper: Find character name for this person in an item
        const getRole = (item) => {
            if (!item.People) return null;
            const person = item.People.find((p) => p.Id === this._personId);
            return person?.Role || null;
        };

        // Categories - get all movies/shows with roles, limit episodes to 100
        const movies = this._items
            .filter((i) => i.Type === 'Movie')
            .map((item) => ({ ...item, _roleName: getRole(item) }));

        const shows = this._items
            .filter((i) => i.Type === 'Series')
            .map((item) => ({ ...item, _roleName: getRole(item) }));

        const episodes = this._items.filter((i) => i.Type === 'Episode').slice(0, 100);

        // Create Components
        this._grids = {};

        // 1. Movies
        if (movies.length > 0) {
            this._grids.movies = new MediaGrid({
                id: 'person-movies',
                title: i18n.t('Movies'),
                items: movies,
                type: 'poster',
                limit: 10,
                onClick: (card) => this._saveStateAndNavigate('person-movies-items', card),
                onSeeMore: () => {
                    this._registerWorkSections();
                    // Reapply character roles after grid re-renders
                    setTimeout(() => this._applyRolesToCards(), 200);
                }
            });
            this._grids.movies.mount(worksContainer);
        }

        // 2. Shows
        if (shows.length > 0) {
            this._grids.shows = new MediaGrid({
                id: 'person-shows',
                title: i18n.t('Series'),
                items: shows,
                type: 'poster',
                limit: 10,
                onClick: (card) => this._saveStateAndNavigate('person-shows-items', card),
                onSeeMore: () => {
                    this._registerWorkSections();
                    // Reapply character roles after grid re-renders
                    setTimeout(() => this._applyRolesToCards(), 200);
                }
            });
            this._grids.shows.mount(worksContainer);
        }

        // 3. Episodes
        if (episodes.length > 0) {
            this._grids.episodes = new MediaGrid({
                id: 'person-episodes',
                title: i18n.t('Episodes'),
                items: episodes,
                type: 'episode-primary', // Use special type
                isLandscape: true, // Force landscape grid
                limit: 9,
                onClick: (card) => this._saveStateAndNavigate('person-episodes-items', card),
                onSeeMore: () => this._registerWorkSections()
            });
            this._grids.episodes.mount(worksContainer);
        }

        // Register focus
        this._registerWorkSections();
    }

    /**
     * Render Albums and Songs grids for a music artist.
     * Replaces the Movies/Shows/Episodes layout used for actors.
     * @param {Object[]} albums - MusicAlbum items from the API
     * @param {Object[]} songs  - Audio items from the API
     */
    _renderArtistWorks(albums, songs) {
        const worksContainer = this.$('#person-works');
        worksContainer.innerHTML = '';
        this._grids = {};

        // 1. Albums grid (square cards — same aspect ratio as the rest of the music UI)
        if (albums.length > 0) {
            this._grids.albums = new MediaGrid({
                id: 'artist-albums',
                title: i18n.t('Albums'),
                items: albums,
                type: 'square',
                limit: 10,
                onClick: (card) => this._saveStateAndNavigate('artist-albums-items', card),
                onSeeMore: () => this._registerArtistSections()
            });
            this._grids.albums.mount(worksContainer);
        }

        // 2. Songs grid (square cards)
        if (songs.length > 0) {
            this._grids.songs = new MediaGrid({
                id: 'artist-songs',
                title: i18n.t('Songs'),
                items: songs,
                type: 'square',
                limit: 10,
                onClick: (card) => this._saveStateAndNavigate('artist-songs-items', card),
                onSeeMore: () => this._registerArtistSections()
            });
            this._grids.songs.mount(worksContainer);
        }

        // Register focus sections for the music grids
        this._registerArtistSections();
    }

    /**
     * Register focus sections for the artist's Albums and Songs grids.
     * Mirrors the pattern used by _registerWorkSections for actors.
     */
    _registerArtistSections() {
        const sectionOrder = ['albums', 'songs'];
        const activeTypes = sectionOrder.filter((type) => this._grids[type]);

        if (activeTypes.length === 0) return;

        const firstType = activeTypes[0];

        // Favorite button row — always at the top
        const favActionsEl = this.$('#person-fav-actions');
        if (favActionsEl) {
            this.registerFocusSection('person-fav-actions', favActionsEl, {
                orientation: 'horizontal',
                leaveUp: null,
                leaveDown: `artist-${firstType}-items`,
                leaveLeft: 'sidebar',
                scrollOffsetTop: 50
            });
        }

        // Chain each grid section together vertically
        activeTypes.forEach((type, index) => {
            const gridComp = this._grids[type];
            const baseId = gridComp.id; // e.g. 'artist-albums'
            const gridZone = `${baseId}-items`;
            const btnZone = `${baseId}-btn-zone`;
            const btnId = `${baseId}-btn`;

            const btn = this.$(`#${btnId}`);
            const isButtonVisible = btn && btn.offsetParent !== null;

            const prevType = index > 0 ? activeTypes[index - 1] : null;
            const nextType = index < activeTypes.length - 1 ? activeTypes[index + 1] : null;

            // UP target: previous grid's button zone or grid zone, or fav actions if first
            let gridLeaveUp = 'person-fav-actions';
            if (prevType) {
                const prevComp = this._grids[prevType];
                const prevBtn = this.$(`#${prevComp.id}-btn`);
                gridLeaveUp =
                    prevBtn && prevBtn.offsetParent !== null ? `${prevComp.id}-btn-zone` : `${prevComp.id}-items`;
            }

            // DOWN target
            let gridLeaveDown = null;
            if (isButtonVisible) {
                gridLeaveDown = btnZone;
            } else if (nextType) {
                gridLeaveDown = `${this._grids[nextType].id}-items`;
            }

            const gridContainer = this.$(`#${gridZone}`);
            if (gridContainer) {
                this.registerFocusSection(gridZone, gridContainer, {
                    orientation: 'grid',
                    leaveUp: gridLeaveUp,
                    leaveDown: gridLeaveDown,
                    leaveLeft: 'sidebar'
                });
            }

            // Register 'See More' button zone if visible
            const btnContainer = btn?.parentElement;
            if (isButtonVisible && btnContainer) {
                this.registerFocusSection(btnZone, btnContainer, {
                    orientation: 'horizontal',
                    leaveUp: gridZone,
                    leaveDown: nextType ? `${this._grids[nextType].id}-items` : null,
                    leaveLeft: 'sidebar'
                });
            }
        });
    }

    _registerWorkSections() {
        // We iterate our created grids in order of appearance
        // Order: movies, shows, episodes
        const sectionOrder = ['movies', 'shows', 'episodes'];
        const activeTypes = sectionOrder.filter((type) => this._grids[type]);

        if (activeTypes.length === 0) return;

        const firstType = activeTypes[0];

        // 1.5 Favorite Button Row
        const favActionsEl = this.$('#person-fav-actions');
        if (favActionsEl) {
            this.registerFocusSection('person-fav-actions', favActionsEl, {
                orientation: 'horizontal',
                leaveUp: null, // Top of page
                leaveDown: `person-${firstType}-items`,
                leaveLeft: 'sidebar',
                scrollOffsetTop: 50 // Match standardized top alignment
            });
        }

        // 2. Register Each Grid
        activeTypes.forEach((type, index) => {
            const gridComp = this._grids[type];
            const baseId = gridComp.id; // e.g. 'person-movies'

            // IDs defined in MediaGrid
            const gridZone = `${baseId}-items`; // The grid container
            const btnZone = `${baseId}-btn-zone`; // Wrapper around button (custom reg name)
            const btnId = `${baseId}-btn`; // The actual button ID

            const gridContainer = this.$(`#${gridZone}`);
            const btn = this.$(`#${btnId}`);
            const btnContainer = btn?.parentElement; // .see-more-container

            // CRITICAL FIX: Trust the DOM visibility over internal logic to avoid Focus Traps
            // If button is hidden (offsetParent is null), do NOT register it.
            const isButtonVisible = btn && btn.offsetParent !== null;

            // Determine Previous/Next Links
            const prevType = index > 0 ? activeTypes[index - 1] : null;
            const nextType = index < activeTypes.length - 1 ? activeTypes[index + 1] : null;

            // --- Grid Zone ---
            // UP
            let gridLeaveUp = 'person-fav-actions';
            if (prevType) {
                // Check if previous had a "See More" that was visible
                const prevComp = this._grids[prevType];
                const prevBaseId = prevComp.id;
                const prevBtn = this.$(`#${prevBaseId}-btn`);
                const prevBtnVisible = prevBtn && prevBtn.offsetParent !== null;

                if (prevBtnVisible) {
                    gridLeaveUp = `${prevBaseId}-btn-zone`;
                } else {
                    gridLeaveUp = `${prevBaseId}-items`;
                }
            }

            // DOWN
            let gridLeaveDown = null;
            if (isButtonVisible) {
                gridLeaveDown = btnZone;
            } else if (nextType) {
                gridLeaveDown = `${this._grids[nextType].id}-items`;
            }

            if (gridContainer) {
                this.registerFocusSection(gridZone, gridContainer, {
                    orientation: 'grid',
                    leaveUp: gridLeaveUp,
                    leaveDown: gridLeaveDown,
                    leaveLeft: 'sidebar'
                });
            }

            // --- Button Zone ---
            if (isButtonVisible && btnContainer) {
                // UP: Back to own grid
                const btnLeaveUp = gridZone;

                // DOWN: Next grid
                const btnLeaveDown = nextType ? `${this._grids[nextType].id}-items` : null;

                this.registerFocusSection(btnZone, btnContainer, {
                    orientation: 'horizontal',
                    leaveUp: btnLeaveUp,
                    leaveDown: btnLeaveDown,
                    leaveLeft: 'sidebar'
                });
            }
        });
    }

    _saveStateAndNavigate(sectionId, card) {
        if (!card.dataset.itemId) return;

        const stateKey = `person:lastFocusedItem:${this._personId}`;
        state.set(stateKey, {
            itemId: card.dataset.itemId,
            sectionId: sectionId
        });

        router.navigate(`/details/${card.dataset.itemId}`);
    }

    _setupFocus() {
        // Initial registration for state consistency
        this.registerFocusSection('person-fav-actions', this.$('#person-fav-actions'), {
            orientation: 'horizontal',
            leaveUp: null,
            leaveDown: null,
            leaveLeft: 'sidebar',
            scrollOffsetTop: 50
        });
    }

    destroy() {
        if (this._favBtn) {
            this._favBtn.destroy();
            this._favBtn = null;
        }

        // Destroy sub-components
        Object.values(this._grids).forEach((comp) => comp.destroy());
        this._grids = {};
        super.destroy();
    }
}

export default PersonPage;
