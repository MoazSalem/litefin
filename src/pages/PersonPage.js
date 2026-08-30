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
import { storage } from '../utils/StorageService.js';
import MediaGrid from '../components/MediaGrid.js';
import { i18n } from '../utils/i18n.js';
import { state } from '../core/StateManager.js';

import FavoriteButton from '../components/FavoriteButton.js';
import { seerr } from '../api/JellyseerrClient.js';
import DescriptionModal from '../components/DescriptionModal.js';
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
                            <div class="details-overview">
                                <div class="overview-text line-clamp-6" id="person-bio" tabindex="-1"></div>
                                <button class="see-more-btn" tabindex="0" data-i18n="ShowMore" style="display: none;">${i18n.t('ShowMore')}</button>
                            </div>

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

        let hasFocusTarget = false;

        try {
            // ────────────────────────────────────────────────────────────
            // 1. Fetch person metadata + render text (blocking)
            // ────────────────────────────────────────────────────────────
            this._person = await api.getPerson(this._personId);
            this.title = this._person.Name;

            await this._renderPersonInfo();

            // ────────────────────────────────────────────────────────────
            // 2. Fire poster/backdrop (non-blocking, fire-and-forget)
            // ────────────────────────────────────────────────────────────
            this._setSmartBackdrop();

            // ────────────────────────────────────────────────────────────
            // 3. Check focus target — defer hiding loading until rows render
            // ────────────────────────────────────────────────────────────
            const focusStateKey = `person:lastFocusedItem:${this._personId}`;
            hasFocusTarget =
                this._pendingNavState ||
                (storage.getItem('pref:disableFocusRestore') !== 'true' && state.get(focusStateKey));

            if (!hasFocusTarget) {
                this.setLoading(false);
            }

            // ────────────────────────────────────────────────────────────
            // 4. Load works in visual order
            // ────────────────────────────────────────────────────────────
            const isArtist = this._person.Type === 'MusicArtist' || this._person.Type === 'Artist';

            if (isArtist) {
                // 4a. Try single-pass query first (Albums + Songs)
                const result = await api.getPersonItems(this._personId);
                const items = result.Items || [];

                let albums = items.filter((i) => i.Type === 'MusicAlbum');
                let songs = items.filter((i) => i.Type === 'Audio');

                // Fallback to separate endpoints if neither type was returned (e.g. legacy server without plugin)
                if (albums.length === 0 && songs.length === 0) {
                    log.debug('Single-pass query returned no music items, calling fallback endpoints');
                    const [albumsResult, songsResult] = await Promise.all([
                        api.getArtistAlbums(this._personId),
                        api.getArtistSongs(this._personId)
                    ]);
                    albums = albumsResult.Items || [];
                    songs = songsResult.Items || [];
                }

                log.debug('Loaded artist works', { albums: albums.length, songs: songs.length });
                this._renderArtistWorks(albums, songs);
            } else {
                // 4a. Movies/Shows/Episodes (renders in visual order: Movies → Shows → Episodes)
                const result = await api.getPersonItems(this._personId);
                this._items = result.Items || [];
                log.debug('Loaded items', {
                    total: this._items.length,
                    movies: this._items.filter((i) => i.Type === 'Movie').length,
                    shows: this._items.filter((i) => i.Type === 'Series').length,
                    episodes: this._items.filter((i) => i.Type === 'Episode').length
                });

                this._renderWorks();

                // Re-apply backdrop now that _items is populated (for work-based fallback)
                this._setSmartBackdrop();

                // 4b. Background: Fetch role names and update UI when ready
                this._loadRolesInBackground();
            }
        } catch (error) {
            log.error('Failed to load', error);
            this.showError('Failed to load person details');
            this.setLoading(false);
        }

        // ────────────────────────────────────────────────────────────
        // 5. Focus restoration (runs after works are in DOM)
        // ────────────────────────────────────────────────────────────
        requestAnimationFrame(() => {
            const stateKey = `person:lastFocusedItem:${this._personId}`;
            let lastFocusedObj = null;

            if (storage.getItem('pref:disableFocusRestore') !== 'true') {
                lastFocusedObj = state.get(stateKey);
            } else {
                state.delete(stateKey);
            }

            let restoredFocus = false;

            if (lastFocusedObj) {
                const targetId = lastFocusedObj.itemId;
                const sectionId = lastFocusedObj.sectionId;

                const sectionConfig = focusManager.getSectionConfig(sectionId);
                const sectionContainer = sectionConfig ? sectionConfig.container : this.el;

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

            // Reveal page now that focus has been placed (or attempted)
            if (hasFocusTarget) {
                this.setLoading(false);
            }
        });
    }

    _setSmartBackdrop() {
        const backdropEl = this.$('#person-backdrop');
        if (!backdropEl) return;

        // Use smart backdrop logic from manager.
        // In artist mode this._items is not populated, so we pass an empty array
        // for graceful degradation (the artist's own poster/backdrop will be used if available).
        const backdropUrl = BackdropManager.getPersonBackdropUrl(this._person, this._items || []);

        // Resolve backdrop blurhash from person object
        let backdropBlurHash = '';
        if (this._person.ImageBlurHashes?.Backdrop) {
            const keys = Object.keys(this._person.ImageBlurHashes.Backdrop);
            if (keys.length > 0) {
                backdropBlurHash = this._person.ImageBlurHashes.Backdrop[keys[0]];
            }
        }

        if (backdropUrl) {
            BackdropManager.applyBackdrop(backdropEl, backdropUrl, backdropBlurHash);
        }
    }

    async _renderPersonInfo() {
        const p = this._person;

        // Render Favorite Button
        const favContainer = this.$('#person-fav-actions');
        log.debug('Rendering Favorite Button', {
            containerFound: !!favContainer,
            personId: p.Id,
            isFavorite: p.UserData?.IsFavorite
        });

        if (favContainer) {
            // Destroy existing favorite button
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

            // Clear container and mount Favorite Button
            favContainer.innerHTML = '';
            favContainer.style.display = 'flex'; // FORCE display
            this._favBtn.mount(favContainer);

            // Mount Seerr rounded button beside the favorite button if Seerr is configured and TMDB ID is present
            const tmdbPersonId = p.ProviderIds?.Tmdb || p.ProviderIds?.tmdb || p.ProviderIds?.TMDB;
            const isSeerrAvailable = await seerr.isAvailable();
            if (isSeerrAvailable && tmdbPersonId) {
                const seerrBtn = document.createElement('button');
                seerrBtn.className = 'btn btn-icon btn-seerr focusable';
                seerrBtn.id = 'btn-person-seerr';
                seerrBtn.setAttribute('title', i18n.t('SeerrDetails') || 'Seerr Details');
                seerrBtn.setAttribute('aria-label', i18n.t('SeerrDetails') || 'Seerr Details');
                seerrBtn.setAttribute('tabindex', '0');
                seerrBtn.innerHTML = `
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="28" height="28">
                        <path fill="currentColor" fill-rule="evenodd" d="M256 0C114.6 0 0 114.6 0 256s114.6 256 256 256s256-114.6 256-256S397.4 0 256 0M64 256c0 11.8-9.6 21.3-21.3 21.3c-11.8 0-21.3-9.6-21.3-21.3c-.1-129.6 105-234.7 234.6-234.7c11.8 0 21.3 9.6 21.3 21.3c0 11.8-9.5 21.4-21.3 21.4c-106 0-192 86-192 192m224.1 191.9c-88.4 0-160-71.6-160-160c0-1.3 0-2.7.1-4c-.1-2.2-.2-4.4-.2-6.6c0-15.3 2.3-30.1 6.6-44c11.7 25.9 37.8 44 68.1 44c41.2 0 74.7-33.4 74.7-74.7c0-30.3-18-56.4-44-68.1c13.9-4.3 28.7-6.6 44-6.6c2.1 0 4.3.1 6.4.2c-.4 0-.7 0-1.1-.1c1.8-.1 3.6-.1 5.4-.1c88.4 0 160 71.6 160 160s-71.6 160-160 160"/>
                    </svg>
                `;

                seerrBtn.onclick = (e) => {
                    e.stopPropagation();
                    router.navigate(`/seerr/person/${tmdbPersonId}`);
                };

                favContainer.appendChild(seerrBtn);
            }

            // Wait for next frame to ensure DOM is ready
            requestAnimationFrame(() => {
                focusManager.invalidateCache('person-fav-actions');
                log.debug('Action buttons cache invalidated. Button offsetParent:', this._favBtn.el?.offsetParent);
            });
            log.debug('Action buttons mounted');
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
                const params = imageService.getParams('details-poster');
                const posterUrl = api.getImageUrl(p.Id, 'Primary', {
                    maxWidth: params.maxWidth,
                    quality: params.quality,
                    ...(p.ImageTags?.Primary ? { tag: p.ImageTags.Primary } : {})
                });

                // Poster BlurHash
                const isBlurHashDisabled = storage.getItem('litefin:disableBlurhash') === 'true';
                let posterBlurHash = '';
                if (!isBlurHashDisabled && p.ImageBlurHashes?.Primary) {
                    const keys = Object.keys(p.ImageBlurHashes.Primary);
                    if (keys.length > 0) {
                        posterBlurHash = p.ImageBlurHashes.Primary[keys[0]];
                    }
                }

                posterContainer.innerHTML = '';

                if (posterBlurHash) {
                    const posterCanvas = document.createElement('canvas');
                    posterCanvas.className = 'blurhash-canvas poster-blurhash';
                    posterCanvas.style.position = 'absolute';
                    posterCanvas.style.top = '0';
                    posterCanvas.style.left = '0';
                    posterCanvas.style.width = '100%';
                    posterContainer.appendChild(posterCanvas);

                    import('../utils/BlurHashDecoder.js')
                        .then(({ default: BlurHashDecoder }) => {
                            const pixels = BlurHashDecoder.decode(posterBlurHash, 32, 48);
                            if (pixels && posterCanvas) {
                                posterCanvas.width = 32;
                                posterCanvas.height = 48;
                                const ctx = posterCanvas.getContext('2d');
                                const imageData = ctx.createImageData(32, 48);
                                imageData.data.set(pixels);
                                ctx.putImageData(imageData, 0, 0);
                            }
                        })
                        .catch((err) => log.error('Failed to decode poster blurhash', err));
                }

                const img = new Image();
                img.onload = () => {
                    img.classList.add('loaded');
                    if (posterBlurHash) {
                        const canvas = posterContainer.querySelector('.poster-blurhash');
                        if (canvas) {
                            canvas.style.opacity = '0';
                            setTimeout(() => {
                                if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
                            }, 250);
                        }
                    }
                };
                img.onerror = () => {
                    img.style.display = 'none';
                    posterContainer.insertAdjacentHTML('afterbegin', fallbackHtml);
                };
                img.src = posterUrl;
                img.alt = p.Name;
                posterContainer.appendChild(img);
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

        // Bio Overview rendering
        const bioEl = this.$('#person-bio');
        if (bioEl) {
            // Assign biography overview content safely
            bioEl.innerHTML = p.Overview || '';
            bioEl.querySelectorAll('a').forEach((anchor) => anchor.setAttribute('tabindex', '-1'));
            // Initially ensure standard clamp class is applied
            bioEl.classList.add('line-clamp-6');
        }

        // Reset "See More" button state visually and structurally
        const seeMoreBtn = this.$('.see-more-btn');
        if (seeMoreBtn) {
            seeMoreBtn.style.display = 'none';
            seeMoreBtn.textContent = i18n.t('ShowMore');
        }

        // Force visibility immediately (bypass CSS transition issues)
        const infoCol = this.$('#person-info-col');
        if (infoCol) {
            infoCol.style.opacity = '1';
            infoCol.classList.add('visible');
        }

        // Check for overview text truncation inside requestAnimationFrame
        // to ensure DOM bounds are correctly computed after browser layout shifts
        requestAnimationFrame(() => {
            this._checkOverviewTruncation();
        });
    }

    /**
     * ============================================================================
     * Truncation Handling & See More Button Bindings
     * ============================================================================
     * Checks if the biography/overview text length exceeds the container bounds
     * (e.g., clientHeight is less than scrollHeight). If so, we reveal the "Show More"
     * button, register a focus zone, and bind an event listener to toggle expansion.
     * ============================================================================
     */
    _checkOverviewTruncation() {
        const bioEl = this.$('#person-bio');
        const seeMoreBtn = this.$('.see-more-btn');

        // Safety check to ensure elements exist in the DOM
        if (!bioEl || !seeMoreBtn) return;

        // Compare scroll height against client layout height to detect overflow
        if (bioEl.scrollHeight > bioEl.clientHeight) {
            // Show the "Show More" button to the user
            seeMoreBtn.style.display = 'block';

            // Register a dedicated vertical focus section for the see more button
            this.registerFocusSection('person-see-more', this.$('.details-overview'), {
                orientation: 'vertical',
                leaveUp: null, // Bounds at the top
                leaveDown: 'person-fav-actions', // Navigates down to favorite action bar
                leaveLeft: 'sidebar' // TV Sidebar navigation
            });

            // Dynamically update the leaveUp boundary of the favorite bar
            // so TV remote users can arrow-up to focus the See More button
            const favConfig = focusManager.getSectionConfig('person-fav-actions');
            if (favConfig) {
                favConfig.leaveUp = 'person-see-more';
                focusManager.register('person-fav-actions', favConfig.container, favConfig);
            }

            // Hook up clean click and touch activation behavior
            seeMoreBtn.onclick = () => {
                if (!this._person) return;

                DescriptionModal.show(
                    {
                        title: this._person.Name,
                        overview: this._person.Overview
                    },
                    this
                );
            };
        } else {
            // If the biography is short and does not overflow, hide the button completely
            seeMoreBtn.style.display = 'none';
        }
    }

    /**
     * Load character roles in background and update cards when ready
     */
    async _loadRolesInBackground() {
        try {
            // Check if items already have roles attached via Litefin plugin
            const hasPrePopulatedRoles = this._items?.some((item) => item.People && item.People.length > 0);

            if (hasPrePopulatedRoles) {
                this._roleMap = new Map();
                this._items.forEach((item) => {
                    if (item.People) {
                        const person = item.People.find((p) => p.Id === this._personId);
                        if (person?.Role) {
                            this._roleMap.set(item.Id, person.Role);
                        }
                    }
                });
                this._applyRolesToCards();
                log.debug(`Applied ${this._roleMap.size} character roles from plugin single-pass response`);
                return;
            }

            // Fallback: Fetch roles via secondary API request if plugin is not available
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

            log.debug(`Added ${this._roleMap.size} character roles via fallback request`);
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
                moreUrl: `/library/all?personId=${this._personId}&personName=${encodeURIComponent(this._item?.Name || '')}&includeItemTypes=Movie`,
                onClick: (card) => this._saveStateAndNavigate('person-movies-items', card)
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
                moreUrl: `/library/all?personId=${this._personId}&personName=${encodeURIComponent(this._item?.Name || '')}&includeItemTypes=Series`,
                onClick: (card) => this._saveStateAndNavigate('person-shows-items', card)
            });
            this._grids.shows.mount(worksContainer);
        }

        // 3. Episodes
        if (episodes.length > 0) {
            this._grids.episodes = new MediaGrid({
                id: 'person-episodes',
                title: i18n.t('Episodes'),
                items: episodes,
                type: 'episode-primary',
                isLandscape: true,
                limit: 9,
                moreUrl: `/library/all?personId=${this._personId}&personName=${encodeURIComponent(this._item?.Name || '')}&includeItemTypes=Episode&viewModeIndex=2`,
                onClick: (card) => this._saveStateAndNavigate('person-episodes-items', card)
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

        // 1. Albums grid
        if (albums.length > 0) {
            this._grids.albums = new MediaGrid({
                id: 'artist-albums',
                title: i18n.t('Albums'),
                items: albums,
                type: 'square',
                limit: 10,
                moreUrl: `/library/all?personId=${this._personId}&personName=${encodeURIComponent(this._item?.Name || '')}&includeItemTypes=MusicAlbum`,
                onClick: (card) => this._saveStateAndNavigate('artist-albums-items', card)
            });
            this._grids.albums.mount(worksContainer);
        }

        // 2. Songs grid
        if (songs.length > 0) {
            this._grids.songs = new MediaGrid({
                id: 'artist-songs',
                title: i18n.t('Songs'),
                items: songs,
                type: 'square',
                limit: 10,
                moreUrl: `/library/all?personId=${this._personId}&personName=${encodeURIComponent(this._item?.Name || '')}&includeItemTypes=Audio`,
                onClick: (card) => this._saveStateAndNavigate('artist-songs-items', card)
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
            // Dynamically check if the see more button is visible
            // to connect navigation properly and prevent focus trapping
            const seeMoreEl = this.$('.see-more-btn');
            const leaveUpTarget = seeMoreEl && seeMoreEl.style.display !== 'none' ? 'person-see-more' : null;

            this.registerFocusSection('person-fav-actions', favActionsEl, {
                orientation: 'horizontal',
                leaveUp: leaveUpTarget,
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
            // Dynamically check if the see more button is visible
            // to connect navigation properly and prevent focus trapping
            const seeMoreEl = this.$('.see-more-btn');
            const leaveUpTarget = seeMoreEl && seeMoreEl.style.display !== 'none' ? 'person-see-more' : null;

            this.registerFocusSection('person-fav-actions', favActionsEl, {
                orientation: 'horizontal',
                leaveUp: leaveUpTarget,
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
        if (storage.getItem('pref:disableFocusRestore') !== 'true') {
            state.set(stateKey, {
                itemId: card.dataset.itemId,
                sectionId: sectionId
            });
        }

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
