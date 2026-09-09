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

import { eventBus } from '../core/EventBus.js';
import FavoriteButton from '../components/FavoriteButton.js';
import { seerr } from '../api/seerrClient.js';
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
        // Active filter state: 'all' | 'movie' | 'tv' (matching Seerr person details)
        this._selectedFilter = 'all';
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
            this._setupTooltipListener();
            this._loadPersonDetails();
        } catch (err) {
            log.error('onInit critical failure', err);
            this.showError('Critical Error: ' + err.message);
        }
    }

    render() {
        const showTooltips = storage.getItem('pref:showActionTooltips') !== 'false';
        const tooltipsClass = showTooltips ? '' : 'tooltips-disabled';

        return `
            <div class="page person-page ${tooltipsClass}" id="person-page">
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

                            <!-- Actions (Favorite, Seerr) -->
                            <div class="person-actions-row" id="person-fav-actions">
                                <div class="action-btn-tooltip-bar" id="action-tooltip-bar">
                                    <span class="action-btn-tooltip-text" id="action-tooltip-text"></span>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Center Tab Switcher Row (Below Details, Centered Above Grids) -->
                    <div class="person-tab-switcher-container" id="person-tab-switcher-container">
                        <div class="person-tab-switcher" id="person-tab-switcher">
                            <button class="person-tab-btn focusable active" data-filter="all" tabindex="0">${i18n.t('All') || 'All'}</button>
                            <button class="person-tab-btn focusable" data-filter="movie" tabindex="0">${i18n.t('Movies') || 'Movies'}</button>
                            <button class="person-tab-btn focusable" data-filter="tv" tabindex="0">${i18n.t('TypeOptionPluralSeries') || 'Series'}</button>
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
            // 3. Check if there is a saved focus state to restore
            // ────────────────────────────────────────────────────────────
            const focusStateKey = `person:lastFocusedItem:${this._personId}`;
            const savedFocusObj = state.get(focusStateKey);
            if (savedFocusObj?.filter) {
                // Restore the previously active tab filter
                this._selectedFilter = savedFocusObj.filter;
            }

            const hasFocusTarget =
                this._pendingNavState ||
                (storage.getItem('pref:disableFocusRestore') !== 'true' && savedFocusObj);

            // ────────────────────────────────────────────────────────────
            // 4. Load works in visual order
            // ────────────────────────────────────────────────────────────
            const isArtist = this._person.Type === 'MusicArtist' || this._person.Type === 'Artist';

            // Hide tab switcher for music artists (they use Albums / Songs sections)
            const switcherContainer = this.$('#person-tab-switcher-container');
            if (switcherContainer) {
                switcherContainer.style.display = isArtist ? 'none' : 'flex';
            }

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

                // Dismiss loading after artist works are mounted
                this._finishLoading(hasFocusTarget, focusStateKey, savedFocusObj);
            } else {
                // 4b. Movies/Shows/Episodes — fetch all items first
                const result = await api.getPersonItems(this._personId);
                this._items = result.Items || [];
                log.debug('Loaded items', {
                    total: this._items.length,
                    movies: this._items.filter((i) => i.Type === 'Movie').length,
                    shows: this._items.filter((i) => i.Type === 'Series').length,
                    episodes: this._items.filter((i) => i.Type === 'Episode').length
                });

                // Sync button active classes with restored filter
                const switcher = this.$('#person-tab-switcher');
                if (switcher) {
                    switcher.querySelectorAll('.person-tab-btn').forEach((b) => {
                        b.classList.toggle('active', b.dataset.filter === this._selectedFilter);
                    });
                }

                // ── Phase 1: Mount appearances grid first, then release loading ──
                // This lets the user interact immediately without waiting for episodes.
                this._renderAppearances();

                // Bind tab switcher events (All / Movies / Series)
                this._bindSwitcherEvents();

                // Re-apply backdrop now that _items is populated (for work-based fallback)
                this._setSmartBackdrop();

                // Dismiss loading / restore focus now that appearances are visible
                this._finishLoading(hasFocusTarget, focusStateKey, savedFocusObj);

                // ── Phase 2: Mount episodes grid in the next event loop tick ──
                // This ensures the browser paints + yields focus before we do more DOM work.
                setTimeout(() => {
                    this._renderEpisodes();
                    // Re-link focus chain to include the newly added episodes section
                    this._registerWorkSections();
                    // Background: fetch and apply character role names once episodes are in DOM too
                    this._loadRolesInBackground();
                }, 0);
            }
        } catch (error) {
            log.error('Failed to load', error);
            this.showError('Failed to load person details');
            this.setLoading(false);
        }
    }

    /**
     * Finalizes page load: places focus (restoring saved state if available) and
     * dismisses the loading overlay. Called after the primary appearances grid is
     * mounted so the user can interact without waiting for the episodes grid.
     *
     * @param {boolean} hasFocusTarget - Whether a saved focus target exists to restore.
     * @param {string}  focusStateKey  - State key used to look up the saved focus object.
     * @param {object}  savedFocusObj  - The previously saved focus state object (may be null).
     */
    _finishLoading(hasFocusTarget, focusStateKey, savedFocusObj) {
        requestAnimationFrame(() => {
            let lastFocusedObj = null;

            if (storage.getItem('pref:disableFocusRestore') !== 'true') {
                lastFocusedObj = savedFocusObj;
            } else {
                state.delete(focusStateKey);
            }

            let restoredFocus = false;

            if (lastFocusedObj) {
                const targetId = lastFocusedObj.itemId;
                const sectionId = lastFocusedObj.sectionId;

                const sectionConfig = focusManager.getSectionConfig(sectionId);
                const sectionContainer = sectionConfig ? sectionConfig.container : this.el;

                const savedCard = sectionContainer?.querySelector(
                    `[data-item-id="${targetId}"], [data-id="${targetId}"]`
                );

                if (savedCard) {
                    const actualSectionId = sectionConfig ? sectionId : 'person-appearances-items';
                    this.setActiveSection(actualSectionId, false);
                    focusManager.focusElement(savedCard, { instantScroll: true });
                    restoredFocus = true;
                }

                state.delete(focusStateKey);
            }

            if (!restoredFocus) {
                // Default: land focus on the action bar (favorite button, etc.)
                this.setActiveSection('person-fav-actions');
            }

            // Page is now interactive — hide the loading overlay
            this.setLoading(false);
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
            if (this._favBtn.el) {
                this._favBtn.el.setAttribute('data-tooltip', i18n.t('Favorite') || 'Favorite');
            }

            // Append tooltip bar to favContainer synchronously before any async operations
            let tooltipBar = favContainer.querySelector('#action-tooltip-bar');
            if (!tooltipBar) {
                tooltipBar = document.createElement('div');
                tooltipBar.className = 'action-btn-tooltip-bar';
                tooltipBar.id = 'action-tooltip-bar';
                tooltipBar.innerHTML = `<span class="action-btn-tooltip-text" id="action-tooltip-text"></span>`;
                favContainer.appendChild(tooltipBar);
            }

            // Trigger immediate tooltip evaluation for the mounted buttons
            this._onFocusChangedForTooltip?.(document.activeElement);

            // Mount Seerr rounded button beside the favorite button if Seerr is configured and TMDB ID is present
            const tmdbPersonId = p.ProviderIds?.Tmdb || p.ProviderIds?.tmdb || p.ProviderIds?.TMDB;
            const isSeerrAvailable = await seerr.isAvailable();
            if (isSeerrAvailable && tmdbPersonId) {
                const seerrBtn = document.createElement('button');
                seerrBtn.className = 'btn btn-icon btn-seerr focusable';
                seerrBtn.id = 'btn-person-seerr';
                seerrBtn.setAttribute('title', i18n.t('SeerrDetails') || 'Seerr Details');
                seerrBtn.setAttribute('aria-label', i18n.t('SeerrDetails') || 'Seerr Details');
                seerrBtn.setAttribute('data-tooltip', i18n.t('SeerrDetails') || 'Seerr Details');
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

                // Insert seerrBtn BEFORE tooltipBar so tooltipBar stays at the end of the container
                if (tooltipBar && tooltipBar.parentNode === favContainer) {
                    favContainer.insertBefore(seerrBtn, tooltipBar);
                } else {
                    favContainer.appendChild(seerrBtn);
                }
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

    /**
     * Binds click and remote activation handlers to the Tab Switcher buttons (All / Movies / Series).
     * Follows Apple Human Interface Guidelines for responsive, tactile segmented controls.
     */
    _bindSwitcherEvents() {
        const switcher = this.$('#person-tab-switcher');
        if (!switcher) return;

        const buttons = switcher.querySelectorAll('.person-tab-btn');
        buttons.forEach((btn) => {
            const filterType = btn.dataset.filter;

            // Handle selection event for both click and keydown
            const handleSwitch = (e) => {
                e.preventDefault();
                e.stopPropagation();

                if (this._selectedFilter === filterType) return;
                this._selectedFilter = filterType;

                // Update active highlight on buttons with spring-like transition
                buttons.forEach((b) => {
                    b.classList.toggle('active', b.dataset.filter === filterType);
                });

                // Re-render works with active filter applied
                this._renderWorks();
            };

            btn.onclick = handleSwitch;
            btn.onkeydown = (e) => {
                if (e.keyCode === 13 || e.key === 'Enter') {
                    handleSwitch(e);
                }
            };
        });
    }

    /**
     * Builds a filtered+sorted appearances list from this._items.
     * Shared between the initial render and tab switcher re-renders.
     *
     * @returns {{ appearances: object[], includeTypes: string }}
     */
    _buildAppearancesList() {
        const filter = this._selectedFilter; // 'all' | 'movie' | 'tv'

        // Helper: find character role for this person inside an item's People array
        const getRole = (item) => {
            if (this._roleMap && this._roleMap.has(item.Id)) {
                return this._roleMap.get(item.Id);
            }
            if (!item.People) return null;
            const person = item.People.find((p) => p.Id === this._personId);
            return person?.Role || null;
        };

        // Filter predicate matching active tab selection
        const matchesFilter = (item) => {
            if (!item) return false;
            if (filter === 'all') return item.Type === 'Movie' || item.Type === 'Series';
            if (filter === 'movie') return item.Type === 'Movie';
            if (filter === 'tv') return item.Type === 'Series';
            return false;
        };

        // Extract a sortable timestamp from available date fields
        const getItemDateScore = (item) => {
            const rawDate = item.PremiereDate || item.ReleaseDate;
            if (rawDate) {
                const parsed = new Date(rawDate).getTime();
                if (!isNaN(parsed)) return parsed;
            }
            // Fallback to ProductionYear if no precise date is present
            if (item.ProductionYear) {
                const yearParsed = new Date(`${item.ProductionYear}-01-01`).getTime();
                if (!isNaN(yearParsed)) return yearParsed;
            }
            return 0;
        };

        // Newest-first comparator with alphabetical tie-breaker
        const sortByDateDesc = (a, b) => {
            const diff = getItemDateScore(b) - getItemDateScore(a);
            return diff !== 0 ? diff : (a.Name || '').localeCompare(b.Name || '');
        };

        // Build the final list: filter → sort → annotate with role + media type badge
        const appearances = this._items
            .filter(matchesFilter)
            .sort(sortByDateDesc)
            .map((item) => ({
                ...item,
                _roleName: getRole(item),
                // Badge tag drives the 'MOVIE' / 'SERIES' pill rendered by CardRenderer
                _mediaType: item.Type === 'Series' ? 'tv' : 'movie'
            }));

        let includeTypes = 'Movie,Series';
        if (filter === 'movie') includeTypes = 'Movie';
        if (filter === 'tv') includeTypes = 'Series';

        return { appearances, includeTypes };
    }

    /**
     * Phase 1 render — mounts the Appearances grid only.
     * Called immediately after items are fetched so the user can interact
     * while the (heavier) episodes grid is still pending.
     *
     * NOTE: Does NOT touch the episodes grid.  Episodes are mounted separately
     *       in _renderEpisodes() which is deferred to the next event loop tick.
     */
    _renderAppearances() {
        const worksContainer = this.$('#person-works');
        if (!worksContainer) return;

        // Destroy existing grid instances to prevent memory leaks on filter change
        Object.values(this._grids).forEach((comp) => comp.destroy());
        this._grids = {};
        worksContainer.innerHTML = '';

        // Invalidate card HTML cache so fresh media-type badges are generated
        CardRenderer.clearCache();

        const { appearances, includeTypes } = this._buildAppearancesList();

        // Mount Appearances grid (7 per row, up to 100 items)
        if (appearances.length > 0) {
            this._grids.appearances = new MediaGrid({
                id: 'person-appearances',
                title: i18n.t('HeaderAppearances') || i18n.t('Appearances') || 'Appearances',
                items: appearances,
                type: 'poster',
                gridClass: 'person-grid person-appearances-grid',
                limit: 100,
                showSeeMoreIfFull: true,
                moreUrl: `/library/all?personId=${this._personId}&personName=${encodeURIComponent(this._person?.Name || '')}&includeItemTypes=${includeTypes}`,
                onClick: (card) => this._saveStateAndNavigate('person-appearances-items', card)
            });
            this._grids.appearances.mount(worksContainer);
        }

        // Register focus chain for the appearances grid only (episodes not yet in DOM)
        this._registerWorkSections();
    }

    /**
     * Phase 2 render — mounts the Episodes grid.
     * Deferred to run after the loading overlay is dismissed and the appearances
     * grid is interactive, so the user is never blocked waiting for this.
     */
    _renderEpisodes() {
        const worksContainer = this.$('#person-works');
        if (!worksContainer) return;

        // Episodes are always shown regardless of the tab switcher filter
        const episodes = this._items.filter((i) => i.Type === 'Episode').slice(0, 100);

        if (episodes.length === 0) return;

        // Guard: avoid double-mounting if called again (e.g. from tab switcher)
        if (this._grids.episodes) {
            this._grids.episodes.destroy();
            delete this._grids.episodes;
        }

        // Mount Episodes grid (landscape, 5 per row, 10 shown with see-more)
        this._grids.episodes = new MediaGrid({
            id: 'person-episodes',
            title: i18n.t('Episodes'),
            items: episodes,
            type: 'episode-primary',
            isLandscape: true,
            gridClass: 'person-grid landscape-grid person-episodes-grid',
            limit: 10,
            showSeeMoreIfFull: true,
            moreUrl: `/library/all?personId=${this._personId}&personName=${encodeURIComponent(this._person?.Name || '')}&includeItemTypes=Episode&viewModeIndex=2`,
            onClick: (card) => this._saveStateAndNavigate('person-episodes-items', card)
        });
        this._grids.episodes.mount(worksContainer);
    }

    /**
     * Full re-render triggered by the tab switcher (All / Movies / Series).
     * Re-builds appearances only (episodes grid is not affected by the filter)
     * then re-links the focus chain to reflect the new DOM state.
     */
    _renderWorks() {
        // Destroy and re-mount appearances; preserve episodes grid instance
        const episodesGrid = this._grids.episodes || null;

        const worksContainer = this.$('#person-works');
        if (!worksContainer) return;

        // Destroy appearances (and any other non-episode grids)
        Object.entries(this._grids).forEach(([key, comp]) => {
            if (key !== 'episodes') comp.destroy();
        });
        this._grids = episodesGrid ? { episodes: episodesGrid } : {};

        // Clear only the DOM nodes that belong to appearances
        // (remove everything then re-append episodes node if it exists)
        const episodesEl = episodesGrid?.el || worksContainer.querySelector('.person-episodes-grid')?.closest('.media-row-section');
        worksContainer.innerHTML = '';
        if (episodesEl && episodesEl.parentNode !== worksContainer) {
            // Re-attach episodes after clearing (it was detached by innerHTML reset)
            worksContainer.appendChild(episodesEl);
        }

        // Invalidate cache so badge labels reflect the current filter
        CardRenderer.clearCache();

        const { appearances, includeTypes } = this._buildAppearancesList();

        // Mount fresh appearances grid before the episodes section in the DOM
        if (appearances.length > 0) {
            this._grids.appearances = new MediaGrid({
                id: 'person-appearances',
                title: i18n.t('HeaderAppearances') || i18n.t('Appearances') || 'Appearances',
                items: appearances,
                type: 'poster',
                gridClass: 'person-grid person-appearances-grid',
                limit: 100,
                showSeeMoreIfFull: true,
                moreUrl: `/library/all?personId=${this._personId}&personName=${encodeURIComponent(this._person?.Name || '')}&includeItemTypes=${includeTypes}`,
                onClick: (card) => this._saveStateAndNavigate('person-appearances-items', card)
            });

            // Always mount into the live container so that onMounted() can use
            // getElementById correctly (requires the element to be in the document).
            // If episodes are already present we then reorder the appended node to
            // sit before them, preserving the appearances → episodes visual order.
            this._grids.appearances.mount(worksContainer);
            if (episodesEl && worksContainer.contains(episodesEl)) {
                // Move the newly appended appearances el to just before episodes
                worksContainer.insertBefore(this._grids.appearances.el, episodesEl);
            }
        }

        // Re-link the full focus navigation chain (appearances + episodes if present)
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

    /**
     * Registers vertical spatial navigation sections connecting the header action bar,
     * the Apple-style segmented Tab Switcher, and the filmography works grids.
     */
    _registerWorkSections() {
        const sectionOrder = ['appearances', 'episodes'];
        const activeTypes = sectionOrder.filter((type) => this._grids[type]);

        // 1. Favorite Button Row
        const favActionsEl = this.$('#person-fav-actions');
        if (favActionsEl) {
            const seeMoreEl = this.$('.see-more-btn');
            const leaveUpTarget = seeMoreEl && seeMoreEl.style.display !== 'none' ? 'person-see-more' : null;

            this.registerFocusSection('person-fav-actions', favActionsEl, {
                orientation: 'horizontal',
                leaveUp: leaveUpTarget,
                leaveDown: 'person-tab-switcher',
                leaveLeft: 'sidebar',
                scrollOffsetTop: 50
            });
        }

        // 2. Tab Switcher Section
        const switcherEl = this.$('#person-tab-switcher');
        const firstGridZone = activeTypes.length > 0 ? `person-${activeTypes[0]}-items` : null;
        if (switcherEl) {
            this.registerFocusSection('person-tab-switcher', switcherEl, {
                orientation: 'horizontal',
                leaveUp: 'person-fav-actions',
                leaveDown: firstGridZone,
                leaveLeft: 'sidebar'
            });
        }

        if (activeTypes.length === 0) return;

        // 3. Register Each Grid
        activeTypes.forEach((type, index) => {
            const gridComp = this._grids[type];
            const baseId = gridComp.id; // e.g. 'person-appearances' or 'person-episodes'

            const gridZone = `${baseId}-items`;
            const btnZone = `${baseId}-btn-zone`;
            const btnId = `${baseId}-btn`;

            const gridContainer = this.$(`#${gridZone}`);
            const btn = this.$(`#${btnId}`);
            const btnContainer = btn?.parentElement;

            const isButtonVisible = btn && btn.offsetParent !== null;

            const prevType = index > 0 ? activeTypes[index - 1] : null;
            const nextType = index < activeTypes.length - 1 ? activeTypes[index + 1] : null;

            // UP target: previous grid's button or items, or tab switcher if first
            let gridLeaveUp = 'person-tab-switcher';
            if (prevType) {
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

            // DOWN target: own see more button, or next grid, or null
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

            // Button Zone
            if (isButtonVisible && btnContainer) {
                const btnLeaveUp = gridZone;
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
                sectionId: sectionId,
                filter: this._selectedFilter
            });
        }

        router.navigate(`/details/${card.dataset.itemId}`);
    }

    _setupFocus() {
        // Initial registration for state consistency
        this.registerFocusSection('person-fav-actions', this.$('#person-fav-actions'), {
            orientation: 'horizontal',
            leaveUp: null,
            leaveDown: 'person-tab-switcher',
            leaveLeft: 'sidebar',
            scrollOffsetTop: 50
        });

        const switcherEl = this.$('#person-tab-switcher');
        if (switcherEl) {
            this.registerFocusSection('person-tab-switcher', switcherEl, {
                orientation: 'horizontal',
                leaveUp: 'person-fav-actions',
                leaveDown: null,
                leaveLeft: 'sidebar'
            });
        }
    }

    _setupTooltipListener() {
        this._onFocusChangedForTooltip = (focusedEl) => {
            const isEnabled = storage.getItem('pref:showActionTooltips') !== 'false';
            const targetEl = focusedEl || document.activeElement;
            const bar = this.$('#action-tooltip-bar');
            const txt = this.$('#action-tooltip-text');

            if (!isEnabled || !targetEl || !bar || !txt) {
                if (bar) bar.classList.remove('visible');
                return;
            }

            const actionsContainer = this.$('#person-fav-actions');
            if (actionsContainer && actionsContainer.contains(targetEl)) {
                let text = targetEl.getAttribute('data-tooltip') || targetEl.getAttribute('aria-label') || targetEl.getAttribute('title');
                if (!text) {
                    const span = targetEl.querySelector('span[data-i18n], span');
                    if (span) text = span.textContent?.trim();
                }

                if (text) {
                    const btnCenterX = targetEl.offsetLeft + (targetEl.offsetWidth / 2);
                    const btnBottomY = targetEl.offsetTop + targetEl.offsetHeight;

                    bar.style.left = `${btnCenterX}px`;
                    bar.style.top = `${btnBottomY}px`;
                    txt.textContent = text;
                    bar.classList.add('visible');
                    return;
                }
            }

            if (bar) bar.classList.remove('visible');
        };

        eventBus.on('focus:changed', this._onFocusChangedForTooltip);

        const actionsContainer = this.$('#person-fav-actions');
        if (actionsContainer) {
            actionsContainer.addEventListener('mouseover', (e) => {
                const btn = e.target.closest('.btn, button');
                if (btn) this._onFocusChangedForTooltip(btn);
            });

            actionsContainer.addEventListener('mouseout', (e) => {
                const bar = this.$('#action-tooltip-bar');
                const related = e.relatedTarget;
                if (!related || !actionsContainer.contains(related)) {
                    const activeInActions = document.activeElement && actionsContainer.contains(document.activeElement);
                    if (activeInActions) {
                        this._onFocusChangedForTooltip(document.activeElement);
                    } else if (bar) {
                        bar.classList.remove('visible');
                    }
                } else {
                    const newBtn = related.closest('.btn, button');
                    if (newBtn) {
                        this._onFocusChangedForTooltip(newBtn);
                    }
                }
            });
        }

        // Initial evaluation for already focused button on page load
        const updateInitial = () => {
            const actionsContainer = this.$('#person-fav-actions');
            const favBtn = this._favBtn?.el || this.$('.favorite-btn');
            const targetEl = (document.activeElement && actionsContainer && actionsContainer.contains(document.activeElement))
                ? document.activeElement
                : favBtn;
            if (targetEl) {
                this._onFocusChangedForTooltip(targetEl);
            }
        };
        updateInitial();
        requestAnimationFrame(updateInitial);
        setTimeout(updateInitial, 150);
        setTimeout(updateInitial, 400);
    }

    destroy() {
        if (this._onFocusChangedForTooltip) {
            eventBus.off('focus:changed', this._onFocusChangedForTooltip);
            this._onFocusChangedForTooltip = null;
        }

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
