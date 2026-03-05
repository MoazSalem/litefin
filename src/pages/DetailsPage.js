/**
 * ============================================================================
 * Litefin Tizen - Details Page
 * ============================================================================
 * Item details with metadata, play button, and related content.
 * Handles movies, series, seasons, and episodes.
 * ============================================================================
 */

import Page from './Page.js';
import { api } from '../api/index.js';
import { router } from '../core/Router.js';
import { eventBus } from '../core/EventBus.js';
import { state } from '../core/StateManager.js';
import { focusManager } from '../ui/FocusManager.js';
import { playQueue } from '../core/PlayQueue.js';
import { imageService } from '../utils/ImageService.js';

import FavoriteButton from '../components/FavoriteButton.js';
import SubtitleEditorModal from '../components/SubtitleEditorModal.js';
import MediaGrid from '../components/MediaGrid.js';

import BackdropManager from '../utils/BackdropManager.js';
import { lazyLoader } from '../utils/LazyLoader.js';
import { VirtualCardRow } from '../components/VirtualCardRow.js';
import { logger } from '../utils/Logger.js';
import { toast } from '../ui/Toast.js';
import { i18n } from '../utils/i18n.js';
import CardRenderer from '../utils/CardRenderer.js';

const log = logger.create('DetailsPage');

class DetailsPage extends Page {
    constructor() {
        super();

        this._itemId = null;
        this._item = null;
        this._nextUp = null;
        this._seasons = null;
        this._episodes = null;
        this._people = null;

        this._similar = null;

        // Components

        // Mark as async page for Navigation State
        this._isAsyncPage = true;
    }

    render() {
        return `
            <div class="page details-page">
                <!-- Backdrop -->
                <div class="details-backdrop" id="backdrop">
                    <div class="backdrop-gradient"></div>
                </div>
                
                <!-- Scrollable Content -->
                <div class="details-content page-content">



                    <!-- Main Split Layout (Marked as media-row for focus scrolling) -->
                    <div class="details-main-split media-row">
                        <!-- Left: Poster -->
                        <div class="hero-poster" id="poster"></div>
                        
                        <!-- Right: Info column -->
                        <div class="details-info-col">
                            <div class="hero-info" id="hero-info">
                                <!-- Info rendered here -->
                            </div>

                            <!-- Actions -->
                            <section class="details-actions" id="actions">
                                <button class="btn btn-primary play-btn" tabindex="0">
                                    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                                    <span data-i18n="Play">Play</span>
                                </button>
                                <button class="btn btn-secondary resume-btn hidden" tabindex="-1">
                                    <span data-i18n="ButtonResume">Resume</span>
                                </button>
                                <button class="btn btn-icon reset-btn hidden" tabindex="-1" aria-label="${i18n.t('ResetProgress')}">
                                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                                        <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
                                        <path d="M3 3v5h5"/>
                                    </svg>
                                </button>
                                <button class="btn btn-icon shuffle-btn hidden" tabindex="-1" aria-label="${i18n.t('Shuffle')}">
                                    <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor">
                                        <path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/>
                                    </svg>
                                </button>
                                <button class="btn btn-icon watched-btn" tabindex="0" aria-label="${i18n.t('MarkWatched')}">
                                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                                </button>
                                <!-- Favorite Button Injected Here -->
                                <button class="btn btn-icon audio-btn" tabindex="0" aria-label="${i18n.t('AudioTracks')}">
                                    <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v9.28c-.47-.17-.97-.28-1.5-.28C8.01 12 6 14.01 6 16.5S8.01 21 10.5 21c2.31 0 4.2-1.75 4.45-4H15V6h4V3h-7z"/></svg>
                                </button>
                                <button class="btn btn-icon subtitle-btn" tabindex="0" aria-label="${i18n.t('SubtitleTracks')}">
                                    <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor"><path d="M19 4H5c-1.11 0-2 .9-2 2v12c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm-8 7H9.5v-.5h-2v3h2V13H11v1c0 .55-.45 1-1 1H7c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1zm7 0h-1.5v-.5h-2v3h2V13H18v1c0 .55-.45 1-1 1h-3c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1z"/></svg>
                                </button>
                                <button class="btn btn-icon more-btn" tabindex="0" aria-label="${i18n.t('MoreOptions')}">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                                        <circle cx="12" cy="12" r="1"></circle>
                                        <circle cx="12" cy="5" r="1"></circle>
                                        <circle cx="12" cy="19" r="1"></circle>
                                    </svg>
                                </button>
                            </section>

                            <!-- Overview -->
                            <div class="details-overview">
                                <p class="overview-text line-clamp-6"></p>
                                <button class="see-more-btn" tabindex="0" data-i18n="ShowMore">${i18n.t('ShowMore')}</button>
                            </div>

                        </div>
                    </div>
                    
                    <!-- Rich Metadata (Genres, People, Studios, Tags) -->
                    <div id="rich-meta-container" class="media-row">
                        <div class="details-rich-meta" id="rich-meta" tabindex="0"></div>
                    </div>

                    <!-- Collection Movies (BoxSet) -->
                    <section class="details-collection-movies media-row hidden" id="collection-movies-section">
                        <h2 class="row-title" data-i18n="Movies">Movies in Collection</h2>
                        <div class="collection-row row-items" id="collection-movies-row"></div>
                    </section>

                    <!-- Collection Shows (BoxSet) -->
                    <section class="details-collection-shows media-row hidden" id="collection-shows-section">
                        <h2 class="row-title" data-i18n="ShowsInCollection">Shows in Collection</h2>
                        <div class="collection-row row-items" id="collection-shows-row"></div>
                    </section>
                    
                    <!-- Next Up (for series) -->
                    <section class="details-next-up media-row hidden" id="next-up-section">
                        <h2 class="row-title" data-i18n="NextUp">Next Up</h2>
                        <div class="next-up-row row-items" id="next-up-row"></div>
                    </section>
                    
                    <!-- Seasons (for series) -->
                    <section class="details-seasons media-row hidden" id="seasons-section">
                        <h2 class="row-title" data-i18n="HeaderSeasons">Seasons</h2>
                        <div class="seasons-row" id="seasons-row"></div>
                    </section>
                    
                    <!-- Episodes (for season/series) -->
                    <section class="details-episodes media-row hidden" id="episodes-section">
                        <h2 class="row-title" data-i18n="Episodes">Episodes</h2>
                        <div class="episodes-list" id="episodes-list"></div>
                    </section>

                    <!-- More from Season (for episodes) -->
                    <section class="details-season-episodes media-row hidden" id="more-from-season-section">
                        <h2 class="row-title" id="more-from-season-title" data-i18n="HeaderMoreFromSeason">More from Season</h2>
                        <div class="season-episodes-row row-items" id="more-from-season-row"></div>
                    </section>

                    <!-- Cast & Crew -->
                    <section class="details-people media-row hidden" id="people-section">
                        <h2 class="row-title" data-i18n="HeaderCastAndCrew">Cast & Crew</h2>
                        <div class="people-row row-items" id="people-row"></div>
                    </section>

                    <!-- Artists (for music/albums) -->
                    <section class="details-artists media-row hidden" id="artists-section">
                        <h2 class="row-title" data-i18n="Artists">Artists</h2>
                        <div class="artists-row row-items" id="artists-row"></div>
                    </section>

                    <!-- Guest Stars (for episodes) -->
                    <section class="details-guest-stars media-row hidden" id="guest-stars-section">
                        <h2 class="row-title" data-i18n="HeaderGuestCast">Guest Stars</h2>
                        <div class="guest-stars-row row-items" id="guest-stars-row"></div>
                    </section>
                    
                    <!-- Similar items -->
                    <section class="details-similar media-row hidden" id="similar-section">
                        <h2 class="row-title" data-i18n="HeaderMoreLikeThis">More Like This</h2>
                        <div class="similar-row" id="similar-row"></div>
                    </section>
                </div>
                

            </div>
        `;
    }

    async onInit() {
        this._itemId = this.params.id;

        try {
            // Setup focus
            this._setupFocus();

            // Bind actions
            this._bindActions();

            // Translate static UI labels
            i18n.translateDOM(this.el);

            // Load item details
            await this._loadDetails();

            // Mark the page as rendered, fulfilling the Promise for NavigationState
            // to restore scroll/focus natively
            this.markReady();
        } catch (err) {
            log.error('onInit failed', err);
        }
    }

    _setupFocus() {
        // Register Action Buttons
        this.registerFocusSection('details-actions', this.$('#actions'), {
            orientation: 'horizontal',
            leaveUp: null, // Top of page
            leaveDown: null, // Will be updated dynamically
            leaveLeft: 'sidebar',
            // PRIORITIZE: Always land on Resume (if visible) or Play when entering this row
            // This prevents "random" landing on Favorite/Subtitle buttons when coming from below
            defaultFocusSelector: '.resume-btn:not(.hidden), .play-btn'
        });

        // Default to actions row (will be overridden in _loadDetails for Season items)
        this.setActiveSection('details-actions');
    }

    _bindActions() {
        // Play button
        this.$('.play-btn')?.addEventListener('click', () => {
            this._play();
        });

        // Resume button
        this.$('.resume-btn')?.addEventListener('click', () => {
            this._play({ resume: true });
        });

        // Watched button
        this.$('.watched-btn')?.addEventListener('click', () => {
            this._toggleWatched();
        });

        // Reset button
        this.$('.reset-btn')?.addEventListener('click', () => {
            this._resetProgress();
        });

        // Shuffle button
        this.$('.shuffle-btn')?.addEventListener('click', () => {
            this._shufflePlay();
        });

        // Subtitle button
        this.$('.subtitle-btn')?.addEventListener('click', () => {
            this._showSubtitleTrackMenu();
        });

        // Audio button
        this.$('.audio-btn')?.addEventListener('click', () => {
            this._showAudioTrackMenu();
        });

        // More button
        this.$('.more-btn')?.addEventListener('click', () => {
            this._showMoreOptionsModal(this._itemId);
        });
    }

    async _loadDetails() {
        this.setLoading(true);
        this._hasEnteredEpisodesGrid = false;

        try {
            // 1. Fetch Item (with detailed metadata fields)
            this._item = await api.getItem(this._itemId, {
                Fields: 'People,Genres,GenreItems,ArtistItems,Studios,Tags,MediaStreams,Overview,LibraryId'
            });
            this.title = this._item.Name;

            // Fetch current user policy for permission checks (like subtitle editing)
            try {
                this._currentUser = await api.getCurrentUser();
            } catch (err) {
                log.warn('Failed to load current user for permissions', err);
            }

            // 2. Render all text content immediately (Metadata, Hero Info)
            this._renderHeroText();
            this._setupFavoriteButton();
            this._renderRichMetadata();

            // 3. Fire image loading in the background (fire-and-forget).
            // The poster and backdrop are not used for layout — they are decorative
            // overlays. We do NOT await them so the content rows are never held up
            // by a slow image download or the 800ms safety timeout.
            this._loadImages(); // non-blocking

            // 4. Parallelize loading of all major content (rows, similar items)
            const loadTasks = [this._loadSecondaryContent()];

            if (this._item.Type !== 'Season') {
                loadTasks.push(this._loadSimilar());
            }

            await Promise.all(loadTasks);

            // 4. Rebuild navigation chain after everything is in the DOM
            // We use requestAnimationFrame to ensure the browser has parsed the new HTML
            await new Promise((resolve) => {
                requestAnimationFrame(() => {
                    this._rebuildNavigationChain();
                    resolve();
                });
            });

            // FIX: Ensure Focus Manager knows about the Resume button if it appeared
            focusManager.invalidateCache('details-actions');

            // 5. Restore custom scroll/focus FIRST before hiding the loading overlay
            // If we have a pending navigation state, it will be handled by restoreScrollFocusWhenReady()
            // which was called in onInit. If not, we handle initial landing here.
            requestAnimationFrame(() => {
                const stateKey = `details:lastFocusedItem:${this._itemId}`;
                const lastFocusedObj = state.get(stateKey);
                let restoredFocus = false;

                if (lastFocusedObj) {
                    const targetId = lastFocusedObj.itemId;
                    const sectionId = lastFocusedObj.sectionId;

                    // Support virtual rows (where elements might not be in DOM yet) by finding index
                    const virtualRow = this._virtualRows ? this._virtualRows[sectionId] : null;

                    if (virtualRow) {
                        const index = virtualRow.items.findIndex(
                            (i) => i.Id === targetId || i.Id?.toString() === targetId
                        );
                        if (index !== -1) {
                            this.setActiveSection(sectionId, false);
                            const node = virtualRow.focusByIndex(index);
                            if (node) {
                                focusManager.focusElement(node, { instantScroll: true });
                                restoredFocus = true;
                            }
                        }
                    } else {
                        // Standard fallback for non-virtual row sections (like similar items if they aren't virtual)
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
                    }

                    state.delete(stateKey);
                }

                if (!restoredFocus && !this._pendingNavState) {
                    if (this._item.UserData?.PlaybackPositionTicks > 0) {
                        // If we have resume progress (Movie/Episode), FORCE focus to the resume button
                        const resumeBtn = this.$('.resume-btn');
                        if (resumeBtn && !resumeBtn.classList.contains('hidden')) {
                            log.info('Forcing focus to Resume button');
                            focusManager.focusElement(resumeBtn);
                        }
                    }
                }

                // 6. NOW hide loading - page is scrolled and focused correctly
                requestAnimationFrame(() => {
                    this.setLoading(false);
                });
            });
        } catch (error) {
            log.error('Failed to load', error);
            this.showError(i18n.t('FailedToLoadDetails'));
            this.setLoading(false);
        }
    }

    _loadImages() {
        return new Promise((resolve) => {
            const item = this._item;

            // Guard: Promise.resolve() is idempotent, but we track this
            // to avoid logging a spurious "timed out" warning after the
            // image has already loaded and resolved the promise.
            let resolved = false;

            // Safety timeout: don't block page interaction forever if the
            // poster is slow. 800ms is sufficient — poster loading is fire-and-forget
            // now, so we can be more aggressive without impacting page readiness.
            const timeout = setTimeout(() => {
                if (!resolved) {
                    log.warn('Poster load timed out, showing content');
                    resolved = true;
                    resolve();
                }
            }, 800);

            const onPosterReady = () => {
                if (!resolved) {
                    resolved = true;
                    clearTimeout(timeout);
                    resolve();
                }
            };

            // Poster
            const posterContainer = this.$('#poster');
            posterContainer.innerHTML = '';

            // Determine Aspect Ratio Type
            let posterType = 'poster';
            if (item.Type === 'Episode') posterType = 'landscape';
            if (item.Type === 'MusicAlbum' || item.Type === 'MusicArtist' || item.Type === 'Audio')
                posterType = 'square';

            // Apply class for CSS aspect ratio
            posterContainer.classList.remove('landscape', 'square');
            if (posterType !== 'poster') {
                posterContainer.classList.add(posterType);
            }

            if (item.ImageTags && item.ImageTags.Primary) {
                // FORCE HIGH QUALITY for Details Page
                // const params = imageService.getParams('poster');
                const posterUrl = api.getImageUrl(item.Id, 'Primary', {
                    maxWidth: 600,
                    quality: 90
                });
                const img = new Image();
                img.onload = () => {
                    img.classList.add('loaded');
                    onPosterReady();
                };
                img.onerror = () => {
                    // If it fails, we still want to resolve to show the page
                    onPosterReady();
                };
                img.src = posterUrl;
                img.alt = item.Name;
                posterContainer.appendChild(img);
            } else {
                // No primary image, show gradient fallback
                const isLandscape = posterType === 'landscape';
                posterContainer.innerHTML = CardRenderer.getFallbackHtml(item, isLandscape);
                onPosterReady();
            }

            // Backdrop (Fire and forget, via Manager)
            // FORCE HIGH QUALITY for Details Page
            const backdropUrl = BackdropManager.getBackdropUrl(item, {
                maxWidth: 3840,
                quality: 90
            });
            if (backdropUrl) {
                BackdropManager.applyBackdrop(this.$('#backdrop'), backdropUrl);
            }
        });
    }

    async _loadSecondaryContent() {
        // Load additional data based on type
        if (this._item.Type === 'Series') {
            await Promise.all([this._loadNextUp(), this._loadSeasons()]);
        } else if (this._item.Type === 'Season') {
            await this._loadEpisodes(this._item.SeriesId, this._itemId);
        } else if (this._item.Type === 'Episode') {
            await Promise.all([this._loadMoreFromSeason(), this._loadGuestStars()]);
        } else if (this._item.Type === 'BoxSet') {
            await this._loadCollectionItems();
        }

        // Render people if available
        this._people = this._item.People || [];
        if (this._people.length > 0) {
            this._renderPeople();
        }

        // Load Artists (Music/Albums)
        await this._loadArtists();

        // Load Logo (non-blocking, fire and forget)
        this._loadLogo();
    }

    async _loadArtists() {
        if (!['Audio', 'MusicAlbum', 'MusicArtist'].includes(this._item.Type)) return;

        // Combine ArtistItems and Featured Artists from People
        const artists = [];
        const seenIds = new Set();

        // 1. Add Main Artists from ArtistItems (these have IDs and Name)
        if (this._item.ArtistItems) {
            for (const artist of this._item.ArtistItems) {
                if (artist.Id && !seenIds.has(artist.Id)) {
                    artists.push({
                        ...artist,
                        Type: 'MusicArtist'
                    });
                    seenIds.add(artist.Id);
                }
            }
        }

        // 2. Add Featured Artists from People
        if (this._item.People) {
            const featured = this._item.People.filter((p) => p.Role === 'Featured Artist' || p.Type === 'GuestArtist');
            for (const p of featured) {
                if (p.Id && !seenIds.has(p.Id)) {
                    artists.push({
                        ...p,
                        Type: 'MusicArtist'
                    });
                    seenIds.add(p.Id);
                }
            }
        }

        if (artists.length > 0) {
            this._renderArtists(artists);
        }
    }

    _renderArtists(artists) {
        if (!artists || artists.length === 0) return;

        const isMusic = this._item.Type === 'MusicAlbum' || this._item.Type === 'Audio';

        this._renderVirtualRow({
            sectionId: 'artists-section',
            listId: 'artists-row',
            items: artists,
            isLandscape: false,
            renderCard: (artist) => {
                return this._renderMediaCard(artist, false, isMusic ? 'square' : 'person');
            },
            focusSectionName: 'artists-section',
            cardType: isMusic ? 'square' : 'person',
            onClick: (card) => {
                if (card.dataset.itemId) router.navigate(`/person/${card.dataset.itemId}`);
            }
        });
    }

    /**
     * Rebuilds the entire navigation chain after all sections have been rendered.
     * This ensures visibility checks are accurate since DOM is fully updated.
     */
    _rebuildNavigationChain() {
        // Get all registered sections and rebuild their leaveUp/leaveDown links
        const sectionOrder = [
            'details-actions',
            'details-see-more',
            'details-rich-meta',
            'collection-movies-section',
            'collection-shows-section',
            'details-next-up',
            'details-seasons',
            'details-episodes',
            'more-from-season-section',
            'details-people',
            'artists-section',
            'guest-stars-section',
            'details-similar'
        ];

        // For each section that exists, update its links
        for (const sectionName of sectionOrder) {
            const config = focusManager.getSectionConfig(sectionName);
            if (!config) continue;

            // Calculate correct up/down links based on current DOM state
            const prev = this._getPreviousVisibleSection(sectionName);
            const next = this._getNextVisibleSection(sectionName);

            config.leaveUp = prev ? prev.targetName : null;
            config.leaveDown = next ? next.targetName : null;

            // Re-register with updated links
            focusManager.register(sectionName, config.container, config);
        }

        log.debug('Navigation chain rebuilt after DOM ready');
    }

    async _loadCollectionItems() {
        try {
            const [movies, shows] = await Promise.all([
                api.getItems({
                    ParentId: this._itemId,
                    IncludeItemTypes: 'Movie',
                    Recursive: true,
                    Fields: 'PrimaryImageAspectRatio,ProductionYear',
                    Limit: 50 // Rational limit
                }),
                api.getItems({
                    ParentId: this._itemId,
                    IncludeItemTypes: 'Series',
                    Recursive: true,
                    Fields: 'PrimaryImageAspectRatio,ProductionYear',
                    Limit: 50
                })
            ]);

            const hasMovies = movies.Items && movies.Items.length > 0;
            const hasShows = shows.Items && shows.Items.length > 0;

            // Determine what is ABOVE the collection rows (use dynamic helper)
            const aboveCollection =
                this._getPreviousVisibleSection('collection-movies-section')?.targetName || 'details-rich-meta';

            // Render Rows with correct UP linking
            if (hasMovies) {
                this._renderCollectionRow(
                    'collection-movies-section',
                    'collection-movies-row',
                    movies.Items,
                    aboveCollection
                );
            }
            if (hasShows) {
                // Shows row's UP goes to Movies (if exists) or to whatever is above collection
                const showsUpTarget = hasMovies ? 'collection-movies-section' : aboveCollection;
                this._renderCollectionRow(
                    'collection-shows-section',
                    'collection-shows-row',
                    shows.Items,
                    showsUpTarget
                );
            }

            // Link Focus chain (DOWN direction)
            // Whatever is above -> Movies -> Shows -> Next section
            let lastSection = aboveCollection;

            if (hasMovies) {
                this._updateLeaveDown(lastSection, 'collection-movies-section');
                lastSection = 'collection-movies-section';
            }

            if (hasShows) {
                this._updateLeaveDown(lastSection, 'collection-shows-section');
                lastSection = 'collection-shows-section';
            }

            // Link last collection row to whatever is next (People, Similar, etc.)
            const nextSection = this._getNextVisibleSection(lastSection);
            if (nextSection) {
                this._updateLeaveDown(lastSection, nextSection.targetName);
            }
        } catch (e) {
            log.warn('Failed to load collection items', e);
        }
    }

    _renderVirtualRow(options) {
        const {
            sectionId,
            listId,
            items,
            isLandscape,
            renderCard,
            leaveUpTarget,
            focusSectionName,
            titleElText,
            cardType,
            onClick
        } = options;

        const section = this.$(`#${sectionId}`);
        const list = this.$(`#${listId}`);
        if (!section || !list || !items || items.length === 0) return;

        section.classList.remove('hidden');
        list.classList.add('row-items');

        if (titleElText) {
            const titleEl = section.querySelector('.row-title');
            if (titleEl) titleEl.textContent = titleElText;
        }

        list.innerHTML = `<div class="row-items-track"></div>`;
        const trackContainer = list.querySelector('.row-items-track');

        const virtualRow = new VirtualCardRow(trackContainer, items, {
            isLandscape: isLandscape,
            visibleCount: isLandscape ? 8 : 12,
            // For portrait rows, eagerly render up to 7 cards on initial load to prevent
            // the blank-then-pop effect when the user first navigates down to the row.
            // We cap portrait at 7 instead of items.length to keep construction time low.
            initialWindow: isLandscape ? 5 : Math.min(7, items.length),
            focusSectionId: focusSectionName,
            cardType: cardType,
            renderCard: renderCard
        });

        if (!this._virtualRows) this._virtualRows = {};
        this._virtualRows[focusSectionName] = virtualRow;

        lazyLoader.observe(list);

        list.addEventListener('focusin', (e) => {
            if (e.target.classList.contains('media-card')) {
                virtualRow.syncIndexFromNode(e.target);
            }
        });

        list.onclick = (e) => {
            const card = e.target.closest('.media-card');
            if (card) {
                // Save clicked item for exact focus restoration, scoped by current page item ID
                // to prevent child DetailsPages from consuming parent state
                const stateKey = `details:lastFocusedItem:${this._itemId}`;
                if (card.dataset.itemId) {
                    state.set(stateKey, {
                        itemId: card.dataset.itemId,
                        sectionId: focusSectionName
                    });
                } else if (card.dataset.id) {
                    // Fallback for some cards that might use data-id
                    state.set(stateKey, {
                        itemId: card.dataset.id,
                        sectionId: focusSectionName
                    });
                }

                if (onClick) {
                    onClick(card);
                } else if (card.dataset.itemId) {
                    router.navigate(`/details/${card.dataset.itemId}`);
                }
            }
        };

        const upwardLink =
            leaveUpTarget || this._getPreviousVisibleSection(focusSectionName)?.targetName || 'details-actions';
        const nextSection = this._getNextVisibleSection(focusSectionName);
        const leaveDownTarget = nextSection ? nextSection.targetName : null;

        this.registerFocusSection(focusSectionName, list, {
            orientation: 'horizontal',
            leaveUp: upwardLink,
            leaveDown: leaveDownTarget,
            leaveLeft: 'sidebar',
            onMove: (direction, currentElement) => {
                if (!currentElement || currentElement.dataset.virtualIndex === undefined) {
                    return false;
                }

                const currentIndex = parseInt(currentElement.dataset.virtualIndex, 10);
                const nextNode = virtualRow.handleMove(direction, currentIndex);

                if (nextNode) {
                    // Manually sync the index immediately to prevent race conditions on rapid key presses.
                    // This ensures the next 'handleMove' call uses the correct 'currentIndex' before focusin bubbles.
                    virtualRow.syncIndexFromNode(nextNode);

                    focusManager.focusElement(nextNode);
                    return true;
                }
                return false;
            },
            onEnter: (fromElement, options) => {
                // Only intercept for vertical entry.
                // Instead of spatial X alignment, we restore the row's last focused index.
                // This prevents rows from shifting and acting like grids.
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

        this._updateLeaveDown(upwardLink, focusSectionName);
    }

    _renderCollectionRow(sectionId, listId, items, leaveUpTarget) {
        this._renderVirtualRow({
            sectionId: sectionId,
            listId: listId,
            items: items,
            isLandscape: false,
            renderCard: (item) => this._renderMediaCard(item, false, 'poster'),
            focusSectionName: sectionId,
            leaveUpTarget: leaveUpTarget || 'details-rich-meta'
        });
    }

    _renderRichMetadata() {
        const item = this._item;
        const htmlParts = [];

        // Helper to create row
        const createRow = (key, items) => {
            if (!items || items.length === 0) return '';
            const translatedLabel = i18n.t(key);
            const valuesHtml = items
                .map((i) => {
                    const name = i.Name || i; // Handle object or string
                    const id = i.Id || '';
                    const type = key.toLowerCase(); // 'genres', 'studios', 'directors', 'writers', 'tags'

                    return `<button class="meta-chip" tabindex="-1" data-id="${id}" data-type="${type}" data-name="${name}">${name}</button>`;
                })
                .join('');

            return `
                <div class="rich-meta-row">
                    <div class="meta-label">${translatedLabel}</div>
                    <div class="meta-value-list">${valuesHtml}</div>
                </div>
            `;
        };

        // Genres (Prefer GenreItems for IDs, but fallback to Name strings)
        const genres = item.GenreItems && item.GenreItems.length > 0 ? item.GenreItems : item.Genres;

        // Fallback to Album Genres for Audio items if they have none
        if ((!genres || genres.length === 0) && item.Type === 'Audio' && item.AlbumId) {
            // Check if we already faked/cached album genres to prevent infinite loop
            if (!item._hasAlbumGenresFetched) {
                // Fire and forget fetch
                api.getItem(item.AlbumId)
                    .then((album) => {
                        item._hasAlbumGenresFetched = true;
                        if (album.GenreItems?.length > 0 || album.Genres?.length > 0) {
                            log.info('Inheriting Genres from Album metadata...');
                            item.GenreItems = album.GenreItems;
                            item.Genres = album.Genres;
                            // Re-render metadata section
                            this._renderRichMetadata();
                        }
                    })
                    .catch((err) => log.warn('Failed to fetch album genres for fallback', err));
            }
        }

        if (genres && genres.length > 0) {
            htmlParts.push(createRow('Genres', genres));
        }

        // Directors
        const directors = (item.People || []).filter((p) => p.Type === 'Director');
        if (directors.length > 0) {
            htmlParts.push(createRow('Directors', directors));
        }

        // Writers
        const writers = (item.People || []).filter((p) => p.Type === 'Writer');
        if (writers.length > 0) {
            htmlParts.push(createRow('Writers', writers));
        }

        // Studios
        if (item.Studios && item.Studios.length > 0) {
            htmlParts.push(createRow('Studios', item.Studios));
        }

        // Tags (No limit as requested)
        if (item.Tags && item.Tags.length > 0) {
            htmlParts.push(createRow('Tags', item.Tags));
        }

        const container = this.$('#rich-meta');
        if (container) {
            container.innerHTML = htmlParts.join('');

            // Make container focusable as a single unit
            if (htmlParts.length > 0) {
                container.setAttribute('tabindex', '0');
                container.classList.add('focusable');

                // Bind Click AND Keydown (Enter) to activate "Trap Mode"
                const activateHandler = (e) => {
                    // Only Enter (13) if key event
                    if (e.type === 'keydown' && e.keyCode !== 13) return;

                    // Prevent bubbling if clicking internal chips already valid
                    if (e.target.classList.contains('meta-chip') && this._isRichMetaActive) {
                        return;
                    }

                    e.preventDefault();
                    e.stopPropagation();
                    this._activateRichMeta();
                };

                // Both click and Enter key activate the trap mode
                container.onclick = activateHandler;
                container.onkeydown = activateHandler;

                // Register Focus Section
                const upwardLink =
                    this._getPreviousVisibleSection('details-rich-meta')?.targetName || 'details-actions';
                const nextSection = this._getNextVisibleSection('details-rich-meta');
                const leaveDownTarget = nextSection ? nextSection.targetName : null;

                this.registerFocusSection('details-rich-meta', this.$('#rich-meta-container'), {
                    orientation: 'vertical',
                    leaveUp: upwardLink,
                    leaveDown: leaveDownTarget,
                    leaveLeft: 'sidebar',
                    enterTo: 'first'
                });

                // Update upward link
                this._updateLeaveDown(upwardLink, 'details-rich-meta');
            }
        }
    }

    _activateRichMeta() {
        if (this._isRichMetaActive) return;

        const container = this.$('#rich-meta'); // The Table
        if (!container) return;

        this._isRichMetaActive = true;
        container.classList.add('active-table');

        // Enable chips
        const chips = container.querySelectorAll('.meta-chip');
        chips.forEach((chip) => chip.setAttribute('tabindex', '0'));

        // Disable container from auto-focus
        container.setAttribute('tabindex', '-1');

        // Async focus shift to ensure attributes apply
        requestAnimationFrame(() => {
            // Re-query chips to be sure
            const validChips = container.querySelectorAll('.meta-chip');
            if (validChips.length === 0) {
                log.error('RichMeta: No chips found after render, reverting');
                this._deactivateRichMeta();
                return;
            }

            // Bind navigation handlers to each chip
            validChips.forEach((chip) => {
                // Click handler
                chip.onclick = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this._handleMetaClick(chip);
                };

                // Enter key handler
                chip.onkeydown = (e) => {
                    if (e.keyCode === 13) {
                        // Enter
                        e.preventDefault();
                        e.stopPropagation();
                        this._handleMetaClick(chip);
                    }
                };
            });

            // Push focus trap with specific chip selector
            focusManager.pushTrap(container, {
                selector: '.meta-chip',
                orientation: 'grid'
            });

            // Force focus
            focusManager.focusElement(validChips[0]);
        });
    }

    _deactivateRichMeta() {
        if (!this._isRichMetaActive) return;

        const container = this.$('#rich-meta');
        if (!container) return;

        this._isRichMetaActive = false;
        container.classList.remove('active-table');

        // Disable chips
        const chips = container.querySelectorAll('.meta-chip');
        chips.forEach((chip) => chip.setAttribute('tabindex', '-1'));

        // Pop trap (Restores focus to previous element = container)
        focusManager.popTrap();

        // Restore container visibility
        container.setAttribute('tabindex', '0');

        // Ensure focus is on container (redundant but safe)
        focusManager.focusElement(container);
    }

    onBack() {
        // 1. Track Menu (Higher priority if overlay)
        if (this._isTrackMenuOpen) {
            this._closeTrackMenu();
            return true;
        }

        // 2. Rich Meta Trap
        if (this._isRichMetaActive) {
            log.debug('RichMeta: Back pressed, exiting trap');
            this._deactivateRichMeta();
            return true;
        }
        return super.onBack();
    }

    _loadLogo() {
        const item = this._item;
        // Check for Logo using ImageTags.Logo or ParentLogoImageTag
        const logoTag = item.ImageTags?.Logo || item.ParentLogoImageTag;
        const logoItemId = item.ImageTags?.Logo ? item.Id : item.ParentLogoItemId || item.SeriesId;

        if (logoItemId && logoTag) {
            const params = imageService.getParams('thumb'); // Logo usually similar resolution needs as thumb
            // Bump logo quality slightly as it is text
            const logoUrl = api.getImageUrl(logoItemId, 'Logo', {
                maxWidth: params.maxWidth * 2,
                quality: 70,
                tag: logoTag
            });
            const img = new Image();
            img.onload = () => {
                const logoContainer = this.$('#details-logo');
                if (logoContainer) {
                    logoContainer.innerHTML = '';
                    logoContainer.appendChild(img);
                    img.classList.add('loaded');
                }
            };
            img.src = logoUrl;
            // img.alt = item.Name + " Logo"; // Alt might show if transparent PNG fails?
        }
    }

    _renderHeroText() {
        const item = this._item;

        // Build meta items (Year, Runtime, Ratings)
        const year = item.ProductionYear || '';

        let runtimeText = '';
        let endsAtText = '';
        if (item.RunTimeTicks) {
            const totalMinutes = Math.round(item.RunTimeTicks / 600000000);
            const hours = Math.floor(totalMinutes / 60);
            const minutes = totalMinutes % 60;
            runtimeText = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

            // Ends At
            const endTime = new Date(Date.now() + item.RunTimeTicks / 10000);
            const timeString = i18n.formatLocalTime(endTime);
            endsAtText = i18n.t('EndsAtValue', [timeString]);
        }

        const rating = item.OfficialRating;
        const starRating = item.CommunityRating ? `★ ${item.CommunityRating.toFixed(1)}` : '';
        const criticRating = item.CriticRating ? `🍅 ${item.CriticRating}` : '';

        let metaHtml = '';
        if (year) metaHtml += `<span class="meta-item">${year}</span>`;
        if (runtimeText) metaHtml += `<span class="meta-item">${runtimeText}</span>`;
        if (rating) metaHtml += `<span class="meta-item meta-badge">${rating}</span>`;
        if (starRating) metaHtml += `<span class="meta-item meta-star">${starRating}</span>`;
        if (criticRating) metaHtml += `<span class="meta-item meta-tomato">${criticRating}</span>`;
        if (endsAtText) metaHtml += `<span class="meta-item meta-ends-at">${endsAtText}</span>`;

        const isSeason = item.Type === 'Season';
        const displayTitle = i18n.ensureBiDi(isSeason ? item.SeriesName || item.Name : item.Name);
        const displaySubtitle = i18n.ensureBiDi(
            isSeason ? item.Name : item.OriginalTitle && item.OriginalTitle !== item.Name ? item.OriginalTitle : ''
        );

        this.$('#hero-info').innerHTML = `
            <div id="details-logo" class="details-logo"></div>
            <h1 class="details-title">${displayTitle}</h1>
            ${displaySubtitle && displaySubtitle !== displayTitle ? `<h2 class="details-original-title">${displaySubtitle}</h2>` : ''}
            ${item.Type === 'Episode' ? `<p class="details-episode-info">${i18n.ensureBiDi(`S${(item.ParentIndexNumber || 0).toString().padStart(2, '0')}E${(item.IndexNumber || 0).toString().padStart(2, '0')} - ${item.SeriesName}`)}</p>` : ''}
            
            <div class="details-meta-row">
                ${metaHtml}
            </div>
        `;

        // Overview
        const overviewEl = this.$('.overview-text');

        // Tagline
        const tagline = item.Taglines && item.Taglines.length > 0 ? item.Taglines[0] : '';

        // Find or create tagline element
        let taglineEl = this.$('.details-tagline');
        if (!taglineEl && tagline) {
            taglineEl = document.createElement('p');
            taglineEl.className = 'details-tagline';
            // Insert before the overview text
            const overviewContainer = this.$('.details-overview');
            overviewContainer.insertBefore(taglineEl, overviewEl);
        }

        if (taglineEl) {
            taglineEl.textContent = tagline;
            taglineEl.style.display = tagline ? 'block' : 'none';
        }

        overviewEl.textContent = item.Overview || '';

        // Reset state
        overviewEl.classList.add('line-clamp-6');
        this.$('.see-more-btn').style.display = 'none';

        // Reveal columns
        requestAnimationFrame(() => {
            this.$('.details-info-col').classList.add('visible');
            this._checkOverviewTruncation();
        });

        // Update buttons based on state
        this._updateButtons();
    }

    async _handleMetaClick(element) {
        const type = element.dataset.type;
        const id = element.dataset.id;
        const name = element.dataset.name || element.dataset.value;

        let libraryId = this._item.LibraryId || state.get('activeLibraryId');

        if (!libraryId) {
            // For items opened from the Home screen or via deep links, LibraryId might be missing.
            // The most robust way to find the true root library is to check the user's views.
            try {
                log.info(`Resolving true Library ID for Type="${this._item.Type}" via getUserViews...`);
                const views = await api.getUserViews();
                const items = views?.Items || [];

                let targetCollectionType = null;
                const type = this._item.Type;

                if (['Audio', 'MusicAlbum', 'MusicArtist', 'MusicGenre'].includes(type) || this._item.AlbumId) {
                    targetCollectionType = 'music';
                } else if (['Series', 'Season', 'Episode', 'TvChannel'].includes(type) || this._item.SeriesId) {
                    targetCollectionType = 'tvshows';
                } else if (['Movie', 'BoxSet', 'Video'].includes(type)) {
                    targetCollectionType = 'movies';
                }

                if (targetCollectionType) {
                    const view = items.find((v) => v.CollectionType === targetCollectionType);
                    if (view) {
                        libraryId = view.Id;
                        log.info(`Resolved ${targetCollectionType} Library correctly: ${libraryId} (${view.Name})`);
                    }
                }

                // If still not found, fallback to ParentId
                libraryId = libraryId || this._item.ParentId;

                // Cache it
                this._item.LibraryId = libraryId;
            } catch (err) {
                log.error('Failed to resolve LibraryId via views', err);
                libraryId = this._item.ParentId;
            }
        }

        // Fallback to ParentId for top-level items like Movies or standalone Series
        // (where ParentId IS the LibraryId).
        libraryId = libraryId || this._item.ParentId;

        if (!libraryId) {
            log.warn('Could not determine LibraryId for item', this._item);
            return;
        }

        log.info(`Navigating to ${type} -> ${name} (${id})`);

        switch (type) {
            case 'year':
                router.navigate(`/library/${libraryId}/year/${encodeURIComponent(name)}`);
                break;
            case 'genres':
                router.navigate(`/library/${libraryId}/genre/${id}`);
                break;
            case 'studios':
                router.navigate(`/library/${libraryId}/studio/${id}`);
                break;
            case 'directors':
            case 'writers':
                // Search by PersonId
                router.navigate(`/library/${libraryId}/person/${id}`);
                break;
            case 'tags':
                router.navigate(`/library/${libraryId}/tag/${encodeURIComponent(name)}`);
                break;
            default:
                log.warn(`Unhandled metadata type "${type}"`);
                return;
        }
    }

    _updateButtons() {
        const item = this._item;
        const userData = item.UserData || {};

        const playBtn = this.$('.play-btn');
        const resumeBtn = this.$('.resume-btn');
        const watchedBtn = this.$('.watched-btn');

        // Reset state first
        if (playBtn) {
            playBtn.classList.remove('hidden');
            playBtn.setAttribute('tabindex', '0'); // Make focusable
        }
        if (resumeBtn) {
            resumeBtn.classList.add('hidden');
            resumeBtn.setAttribute('tabindex', '-1'); // Remove from focus order when hidden
            resumeBtn.classList.remove('btn-primary');
            resumeBtn.classList.add('btn-secondary');
        }

        // Resume Logic
        if (userData.PlaybackPositionTicks > 0) {
            // If resume point exists: Hide Play, Show Resume as Primary
            if (playBtn) {
                playBtn.classList.add('hidden');
                playBtn.setAttribute('tabindex', '-1'); // Remove from focus order when hidden
            }

            if (resumeBtn) {
                resumeBtn.classList.remove('hidden');
                resumeBtn.setAttribute('tabindex', '0'); // Make focusable when visible
            }

            // Show Reset Button when Resume is active
            const resetBtn = this.$('.reset-btn');
            if (resetBtn) {
                resetBtn.classList.remove('hidden');
                resetBtn.setAttribute('tabindex', '0');
            }
        } else {
            // No resume point: Show Play, Hide Resume & Reset
            if (playBtn) {
                playBtn.classList.remove('hidden');
                playBtn.setAttribute('tabindex', '0');
            }

            if (resumeBtn) {
                resumeBtn.classList.add('hidden');
                resumeBtn.setAttribute('tabindex', '-1');
            }

            const resetBtn = this.$('.reset-btn');
            if (resetBtn) {
                resetBtn.classList.add('hidden');
                resetBtn.setAttribute('tabindex', '-1');
            }
        } // Upgrade to primary style
        resumeBtn.classList.remove('btn-secondary');
        resumeBtn.classList.add('btn-primary');

        const resumeTime = Math.round(userData.PlaybackPositionTicks / 600000000);
        const resumeLabel = i18n.t('ResumeAt', [resumeTime + 'm']);
        resumeBtn.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> <span>${resumeLabel}</span>`;

        // CRITICAL: If we hid the Play button (which probably had focus or would get it),
        // we must manually force focus to the Resume button so focus isn't lost.
        requestAnimationFrame(() => {});

        // Watched button
        if (userData.Played) {
            if (watchedBtn) watchedBtn.classList.add('active');
        }

        // Shuffle Button Visibility
        const shuffleBtn = this.$('.shuffle-btn');
        if (shuffleBtn) {
            const isShuffleable = ['Series', 'Season', 'BoxSet'].includes(item.Type);
            if (isShuffleable) {
                shuffleBtn.classList.remove('hidden');
                shuffleBtn.setAttribute('tabindex', '0');
            } else {
                shuffleBtn.classList.add('hidden');
                shuffleBtn.setAttribute('tabindex', '-1');
            }
        }
    }

    async _loadNextUp() {
        try {
            const response = await api.getNextUp({ SeriesId: this._itemId, Limit: 1 });
            this._nextUp = response.Items || [];

            if (this._nextUp.length > 0) {
                this._renderNextUp();
            }
        } catch (error) {
            log.warn('Failed to load next up', error);
            if (this.$('#next-up-section')) {
                this.$('#next-up-section').classList.add('hidden');
            }
        }
    }

    _renderNextUp() {
        this._renderVirtualRow({
            sectionId: 'next-up-section',
            listId: 'next-up-row',
            items: this._nextUp,
            isLandscape: true,
            renderCard: (item) => this._renderMediaCard(item, true, 'episode'),
            focusSectionName: 'details-next-up'
        });
    }

    async _loadSeasons() {
        try {
            const response = await api.getSeasons(this._itemId);
            this._seasons = response.Items || [];

            if (this._seasons.length > 0) {
                this._renderSeasons();
            }
        } catch (error) {
            log.warn('Failed to load seasons', error);
            if (this.$('#seasons-section')) {
                this.$('#seasons-section').classList.add('hidden');
            }
        }
    }

    _renderSeasons() {
        this._renderVirtualRow({
            sectionId: 'seasons-section',
            listId: 'seasons-row',
            items: this._seasons,
            isLandscape: false,
            renderCard: (season) => this._renderMediaCard(season, false, 'season'),
            focusSectionName: 'details-seasons'
        });
    }

    async _loadEpisodes(seriesId, seasonId) {
        try {
            const response = await api.getEpisodes(seriesId, { SeasonId: seasonId });
            this._episodes = response.Items || [];

            if (this._episodes.length > 0) {
                this._renderEpisodes();
            }
        } catch (error) {
            log.warn('Failed to load episodes', error);
            if (this.$('#episodes-section')) {
                this.$('#episodes-section').classList.add('hidden');
            }
        }
    }

    _renderEpisodes() {
        const container = this.$('#episodes-list');
        const section = this.$('#episodes-section');

        section.classList.remove('hidden');

        if (this._item.Type === 'Season') {
            // Remove 'media-row' to prevent ScrollController from aggressively top-snapping this entire deep grid
            section.classList.remove('media-row');
            // Use MediaGrid for a clean, generic 2D landscape episode layout
            this._episodeGrid = new MediaGrid({
                id: 'season-episodes-grid',
                items: this._episodes,
                type: 'episode',
                contextType: 'season-grid',
                limit: 1000,
                isLandscape: true,
                onClick: (card) => {
                    const stateKey = `details:lastFocusedItem:${this._itemId}`;
                    if (card.dataset.itemId) {
                        state.set(stateKey, {
                            itemId: card.dataset.itemId,
                            sectionId: 'details-episodes'
                        });
                        router.navigate(`/details/${card.dataset.itemId}`);
                    }
                }
            });

            container.innerHTML = this._episodeGrid.render();
            this._episodeGrid.onMounted(); // Wire up generic grid router links

            // Register focus section for grid
            const upwardLink = this._getPreviousVisibleSection('details-episodes')?.targetName || 'details-actions';
            const nextSection = this._getNextVisibleSection('details-episodes');
            const leaveDownTarget = nextSection ? nextSection.targetName : null;

            this.registerFocusSection('details-episodes', container, {
                orientation: 'grid',
                leaveUp: upwardLink,
                leaveDown: leaveDownTarget,
                leaveLeft: 'sidebar',
                onEnter: (fromElement, options) => {
                    // Only assert focus on the first item for the very first entry.
                    // Afterwards, let FocusManager use standard spatial/memory routing.
                    if (!this._hasEnteredEpisodesGrid) {
                        this._hasEnteredEpisodesGrid = true;
                        return container.querySelector('.media-card');
                    }
                    return null;
                }
            });

            this._updateLeaveDown(upwardLink, 'details-episodes');
        } else {
            // Horizontal episode cards (for Series NextUp, etc.) require 'media-row' for correct horizontal snap scrolling
            section.classList.add('media-row');
            this._renderVirtualRow({
                sectionId: 'episodes-section',
                listId: 'episodes-list',
                items: this._episodes,
                isLandscape: true,
                focusSectionName: 'details-episodes',
                renderCard: (ep) => {
                    const progress =
                        ep.UserData?.PlaybackPositionTicks && ep.RunTimeTicks
                            ? (ep.UserData.PlaybackPositionTicks / ep.RunTimeTicks) * 100
                            : 0;
                    return `
                        <button class="episode-card media-card" data-episode-id="${ep.Id}" data-item-id="${ep.Id}" tabindex="0">
                            <div class="episode-thumb">
                                <img src="${api.getImageUrl(ep.Id, 'Primary', { maxWidth: imageService.getParams('thumb').maxWidth, quality: imageService.getParams('thumb').quality })}" alt="" class="lazy">
                                ${progress > 0 ? `<div style="position: absolute; bottom: 0; left: 0; width: 100%; height: 6px; background-color: rgba(0,0,0,0.7); z-index: 100;"><div style="width: ${progress}%; height: 100%; background-color: var(--jf-accent, #00a4dc);"></div></div>` : ''}
                            </div>
                            <div class="episode-info">
                                <span class="episode-number">${i18n.ensureBiDi(`S${(ep.ParentIndexNumber || 0).toString().padStart(2, '0')}E${(ep.IndexNumber || 0).toString().padStart(2, '0')}`)}</span>
                                <span class="episode-title">${i18n.ensureBiDi(ep.Name)}</span>
                                <p class="episode-overview">${ep.Overview?.substring(0, 100) || ''}...</p>
                            </div>
                        </button>
                    `;
                }
            });
        }
    }

    _renderPeople() {
        this._renderVirtualRow({
            sectionId: 'people-section',
            listId: 'people-row',
            items: this._people,
            isLandscape: false,
            renderCard: (person) => this._renderMediaCard(person, false, 'person'),
            focusSectionName: 'details-people',
            onClick: (card) => {
                if (card.dataset.itemId) router.navigate(`/person/${card.dataset.itemId}`);
            }
        });
    }

    _checkOverviewTruncation() {
        const overviewEl = this.$('.overview-text');
        const seeMoreBtn = this.$('.see-more-btn');

        if (overviewEl.scrollHeight > overviewEl.clientHeight) {
            seeMoreBtn.style.display = 'block';

            // 1. Determine what is below the See More button
            const nextSection = this._getNextVisibleSection('details-see-more');
            const downTarget = nextSection ? nextSection.targetName : null;

            // 2. Register See More Section
            this.registerFocusSection('details-see-more', this.$('.details-overview'), {
                orientation: 'vertical',
                leaveUp: 'details-actions',
                leaveDown: downTarget
            });

            // 3. Link Actions -> See More
            this._updateLeaveDown('details-actions', 'details-see-more');

            // Handle Click (Toggle)
            seeMoreBtn.onclick = () => {
                const isExpanded = !overviewEl.classList.contains('line-clamp-6');

                if (isExpanded) {
                    // Collapse
                    overviewEl.classList.add('line-clamp-6');
                    seeMoreBtn.textContent = i18n.t('ShowMore');
                    this.el.scrollTop = 0; // Optional: Reset scroll
                } else {
                    // Expand
                    overviewEl.classList.remove('line-clamp-6');
                    seeMoreBtn.textContent = i18n.t('ShowLess');
                }

                // Keep focus on the button using precision scroll
                focusManager.focusElement(seeMoreBtn);
            };
        }
    }

    _getNextVisibleSection(currentSectionName) {
        // Helper to check if a section exists and is not hidden
        const isNotHidden = (id) => {
            const el = this.$(id);
            return el && !el.classList.contains('hidden');
        };

        const sections = [
            // Actions is always first and visible - needed so we can find what's after it
            { name: 'details-actions', elementId: '#actions', isVisible: () => true },
            {
                name: 'details-see-more',
                elementId: '#details-overview',
                isVisible: () => this.$('.see-more-btn')?.style?.display !== 'none'
            },
            { name: 'details-rich-meta', elementId: '#rich-meta', isVisible: () => !!this.$('#rich-meta')?.innerHTML },
            // Collection rows (BoxSet contents)
            {
                name: 'collection-movies-section',
                elementId: '#collection-movies-row',
                isVisible: () => isNotHidden('#collection-movies-section')
            },
            {
                name: 'collection-shows-section',
                elementId: '#collection-shows-row',
                isVisible: () => isNotHidden('#collection-shows-section')
            },
            // Standard content rows
            { name: 'details-next-up', elementId: '#next-up-row', isVisible: () => isNotHidden('#next-up-section') },
            { name: 'details-seasons', elementId: '#seasons-row', isVisible: () => isNotHidden('#seasons-section') },
            {
                name: 'details-episodes',
                elementId: '#episodes-list',
                isVisible: () => isNotHidden('#episodes-section')
            },
            {
                name: 'more-from-season-section',
                elementId: '#more-from-season-row',
                isVisible: () => isNotHidden('#more-from-season-section')
            },
            { name: 'details-people', elementId: '#people-row', isVisible: () => isNotHidden('#people-section') },
            {
                name: 'artists-section',
                elementId: '#artists-row',
                isVisible: () => isNotHidden('#artists-section')
            },
            {
                name: 'guest-stars-section',
                elementId: '#guest-stars-row',
                isVisible: () => isNotHidden('#guest-stars-section')
            },
            { name: 'details-similar', elementId: '#similar-row', isVisible: () => isNotHidden('#similar-section') }
        ];

        let foundCurrent = false;
        for (const section of sections) {
            if (section.name === currentSectionName) {
                foundCurrent = true;
                continue;
            }
            if (foundCurrent && section.isVisible()) {
                return { targetName: section.name, elementId: section.elementId };
            }
        }
        return null;
    }

    _getPreviousVisibleSection(currentSectionName) {
        // Helper to check if a section exists and is not hidden
        const isNotHidden = (id) => {
            const el = this.$(id);
            return el && !el.classList.contains('hidden');
        };

        const sections = [
            { name: 'details-similar', elementId: '#similar-row', isVisible: () => isNotHidden('#similar-section') },
            {
                name: 'guest-stars-section',
                elementId: '#guest-stars-row',
                isVisible: () => isNotHidden('#guest-stars-section')
            },
            {
                name: 'artists-section',
                elementId: '#artists-row',
                isVisible: () => isNotHidden('#artists-section')
            },
            { name: 'details-people', elementId: '#people-row', isVisible: () => isNotHidden('#people-section') },
            {
                name: 'more-from-season-section',
                elementId: '#more-from-season-row',
                isVisible: () => isNotHidden('#more-from-season-section')
            },
            {
                name: 'details-episodes',
                elementId: '#episodes-list',
                isVisible: () => isNotHidden('#episodes-section')
            },
            { name: 'details-seasons', elementId: '#seasons-row', isVisible: () => isNotHidden('#seasons-section') },
            { name: 'details-next-up', elementId: '#next-up-row', isVisible: () => isNotHidden('#next-up-section') },
            // Collection rows (BoxSet contents) - in reverse order
            {
                name: 'collection-shows-section',
                elementId: '#collection-shows-row',
                isVisible: () => isNotHidden('#collection-shows-section')
            },
            {
                name: 'collection-movies-section',
                elementId: '#collection-movies-row',
                isVisible: () => isNotHidden('#collection-movies-section')
            },
            // Standard
            { name: 'details-rich-meta', elementId: '#rich-meta', isVisible: () => !!this.$('#rich-meta')?.innerHTML },
            {
                name: 'details-see-more',
                elementId: '#details-overview',
                isVisible: () => this.$('.see-more-btn')?.style?.display !== 'none'
            },
            { name: 'details-actions', elementId: '#actions', isVisible: () => true } // Actions are always visible
        ];

        let foundCurrent = false;
        for (const section of sections) {
            if (section.name === currentSectionName) {
                foundCurrent = true;
                continue;
            }
            if (foundCurrent && section.isVisible()) {
                return { targetName: section.name, elementId: section.elementId };
            }
        }
        return null;
    }

    async _loadMoreFromSeason() {
        if (!this._item.SeasonId || !this._item.SeriesId) return;

        try {
            const response = await api.getEpisodes(this._item.SeriesId, {
                SeasonId: this._item.SeasonId
            });
            // Filter out current episode and limit to 24 for row
            const siblings = (response.Items || []).filter((ep) => ep.Id !== this._itemId).slice(0, 24);

            if (siblings.length > 0) {
                this._renderMoreFromSeason(siblings);
            }
        } catch (error) {
            log.warn('Failed to load season episodes', error);
        }
    }

    _renderMoreFromSeason(episodes) {
        this._renderVirtualRow({
            sectionId: 'more-from-season-section',
            listId: 'more-from-season-row',
            items: episodes,
            isLandscape: true,
            titleElText: this._item.SeasonName
                ? i18n.t('MoreFromValue', [
                      this._item.SeasonName.toLowerCase().startsWith('season ')
                          ? this._item.SeasonName.replace(/season\s+/i, i18n.t('Season') + ' ')
                          : /^\d+$/.test(this._item.SeasonName)
                            ? i18n.t('Season') + ' ' + this._item.SeasonName
                            : this._item.SeasonName
                  ])
                : null,
            renderCard: (ep) => this._renderMediaCard(ep, true, 'episode'),
            focusSectionName: 'more-from-season-section'
        });
    }

    async _loadGuestStars() {
        // Guest stars are usually included in the episode's People array with Type 'GuestStar' or 'Guest'
        // or just 'Actor' but specific to the episode.
        // In many setups, if they aren't 'Director' or 'Writer' or 'Producer', they are actors.
        const guestStars = (this._item.People || []).filter((p) => p.Type === 'GuestStar' || p.Role === 'Guest Star');

        if (guestStars.length > 0) {
            this._renderGuestStars(guestStars);
        }
    }

    _renderGuestStars(people) {
        this._renderVirtualRow({
            sectionId: 'guest-stars-section',
            listId: 'guest-stars-row',
            items: people,
            isLandscape: false,
            renderCard: (p) => this._renderMediaCard(p, false, 'person'),
            focusSectionName: 'guest-stars-section',
            onClick: (card) => {
                if (card.dataset.itemId) router.navigate(`/person/${card.dataset.itemId}`);
            }
        });
    }

    _updateLeaveDown(sectionName, targetName) {
        const config = focusManager.getSectionConfig(sectionName);
        if (!config) return;

        // ONLY update leaveDown - do NOT touch leaveUp!
        // leaveUp is set correctly during initial section registration.
        // This function is specifically for linking DOWN direction.
        const next = this._getNextVisibleSection(sectionName);
        config.leaveDown = targetName || (next ? next.targetName : null);

        // Re-register to apply changes (preserves existing leaveUp)
        focusManager.register(sectionName, config.container, config);
    }

    async _loadSimilar() {
        try {
            const cacheKey = `details:similar:${this._itemId}`;
            const cachedSimilar = state.get(cacheKey);

            if (cachedSimilar) {
                this._similar = cachedSimilar;
            } else {
                const response = await api.getSimilar(this._itemId);
                this._similar = response.Items || [];
                // Cache the randomized result for the duration of the session
                // so Back navigation restores the exact same row.
                if (this._similar.length > 0) {
                    state.set(cacheKey, this._similar);
                }
            }

            if (this._similar.length > 0) {
                this._renderSimilar();
            }
        } catch (error) {
            log.warn('Failed to load similar', error);
            if (this.$('#similar-section')) {
                this.$('#similar-section').classList.add('hidden');
            }
        }
    }

    _renderSimilar() {
        if (!this._similar || this._similar.length === 0) return;

        const isMusic = this._item.Type === 'MusicAlbum' || this._item.Type === 'Audio';

        this._renderVirtualRow({
            sectionId: 'similar-section',
            listId: 'similar-row',
            items: this._similar,
            isLandscape: false,
            renderCard: (item) => {
                return this._renderMediaCard(item, false, isMusic ? 'square' : 'poster');
            },
            focusSectionName: 'details-similar',
            cardType: isMusic ? 'square' : 'poster'
        });
    }

    async _play({ resume = false, isShufflePlay = false } = {}) {
        let itemToPlay = this._item;

        if (this._item.Type === 'BoxSet') {
            try {
                // Fetch first item in collection (recursive)
                // We prefer Movies over Episodes to match the visual row priority
                const sortParams = isShufflePlay
                    ? { SortBy: 'Random' }
                    : { SortBy: 'SortName', SortOrder: 'Ascending' };
                const [movies, episodes, audio] = await Promise.all([
                    api.getItems({
                        ParentId: this._item.Id,
                        Recursive: true,
                        IncludeItemTypes: 'Movie',
                        Limit: 1,
                        ...sortParams
                    }),
                    api.getItems({
                        ParentId: this._item.Id,
                        Recursive: true,
                        IncludeItemTypes: 'Episode',
                        Limit: 1,
                        ...sortParams
                    }),
                    api.getItems({
                        ParentId: this._item.Id,
                        Recursive: true,
                        IncludeItemTypes: 'Audio',
                        Limit: 1,
                        ...sortParams
                    })
                ]);

                if (isShufflePlay) {
                    const allItems = [...(movies.Items || []), ...(episodes.Items || []), ...(audio.Items || [])];
                    if (allItems.length > 0) {
                        itemToPlay = allItems[Math.floor(Math.random() * allItems.length)];
                    } else {
                        return; // Empty collection
                    }
                } else {
                    if (movies.Items && movies.Items.length > 0) {
                        itemToPlay = movies.Items[0];
                    } else if (episodes.Items && episodes.Items.length > 0) {
                        itemToPlay = episodes.Items[0];
                    } else if (audio.Items && audio.Items.length > 0) {
                        itemToPlay = audio.Items[0];
                    } else {
                        return; // Empty collection
                    }
                }
                // If the item doesn't have a CollectionType, try to infer it from its Type
                if (!itemToPlay.CollectionType) {
                    if (['MusicAlbum', 'MusicArtist', 'Audio', 'MusicGenre'].includes(itemToPlay.Type)) {
                        itemToPlay.CollectionType = 'music';
                    } else if (['Series', 'Season', 'Episode', 'TvChannel'].includes(itemToPlay.Type)) {
                        itemToPlay.CollectionType = 'tvshows';
                    } else if (['Movie', 'BoxSet'].includes(itemToPlay.Type)) {
                        itemToPlay.CollectionType = 'movies';
                    }
                }

                // Attach context so PlayQueue knows this is a collection play
                itemToPlay.contextType = 'boxset';
                itemToPlay.contextId = this._item.Id;
            } catch (e) {
                log.error('Failed to play collection', e);
                return;
            }
        } else if (this._item.Type === 'Season') {
            if (this._episodes?.length > 0) {
                let target;
                if (isShufflePlay) {
                    target = this._episodes[Math.floor(Math.random() * this._episodes.length)];
                } else {
                    target = this._episodes.find((ep) => !ep.UserData?.Played) || this._episodes[0];
                }
                itemToPlay = { ...target };
            }
            // Attach context so PlayQueue knows this is a season play
            itemToPlay.contextType = 'season';
            itemToPlay.contextId = this._item.Id;
        } else if (this._item.Type === 'Series') {
            if (this._episodes?.length > 0) {
                if (isShufflePlay) {
                    itemToPlay = this._episodes[Math.floor(Math.random() * this._episodes.length)];
                } else {
                    itemToPlay = this._episodes.find((ep) => !ep.UserData?.Played) || this._episodes[0];
                }
            } else {
                try {
                    if (isShufflePlay) {
                        const randomEp = await api.getItems({
                            ParentId: this._item.Id,
                            Recursive: true,
                            IncludeItemTypes: 'Episode',
                            Limit: 1,
                            SortBy: 'Random'
                        });
                        if (randomEp && randomEp.Items && randomEp.Items.length > 0) {
                            itemToPlay = randomEp.Items[0];
                        } else {
                            return;
                        }
                    } else {
                        // 1. Try to get "Next Up" for this series
                        const nextUp = await api.getNextUp({ SeriesId: this._item.Id, Limit: 1 });
                        if (nextUp && nextUp.Items && nextUp.Items.length > 0) {
                            itemToPlay = nextUp.Items[0];
                            // Auto-resume if it has progress
                            if (itemToPlay.UserData?.PlaybackPositionTicks > 0) {
                                resume = true;
                            }
                        } else {
                            // 2. Fallback to first episode ever (e.g. S1E1)
                            const firstEp = await api.getItems({
                                ParentId: this._item.Id,
                                Recursive: true,
                                IncludeItemTypes: 'Episode',
                                Limit: 1,
                                SortBy: 'SortName'
                            });
                            if (firstEp && firstEp.Items && firstEp.Items.length > 0) {
                                itemToPlay = firstEp.Items[0];
                            }
                        }
                    }
                } catch (e) {
                    log.error('Failed to resolve series playback', e);
                    return;
                }
            }
        }

        // FORCE HIGH QUALITY for Player transition (must match _loadImages params)
        const backdropUrl = BackdropManager.getBackdropUrl(this._item, {
            maxWidth: 3840,
            quality: 90
        });

        eventBus.emit('player:play', {
            item: itemToPlay,
            resume,
            audioStreamIndex: this._selectedAudioIndex,
            subtitleStreamIndex: this._selectedSubtitleIndex,
            backdropUrl
        });
    }

    _shufflePlay() {
        playQueue.setShuffleMode(true);
        this._play({ isShufflePlay: true });
    }

    _showAudioTrackMenu() {
        if (!this._item?.MediaSources?.[0]?.MediaStreams) return;

        const key = 'Audio';
        const tracks = this._item.MediaSources[0].MediaStreams.filter((s) => s.Type === key);

        // Find current selection (or default)
        let currentIndex = this._selectedAudioIndex;
        if (currentIndex === undefined) {
            const defaultStream = tracks.find((s) => s.Index === this._item.MediaSources[0].DefaultAudioStreamIndex);
            currentIndex = defaultStream ? defaultStream.Index : tracks[0]?.Index || 0;
        }

        this._renderTrackSelectionMenu(i18n.t('Audio'), tracks, currentIndex, (index) => {
            if (this._selectedAudioIndex === index) return;

            this._selectedAudioIndex = index;
            log.info('Selected Audio Index:', index);
        });
    }

    _showSubtitleTrackMenu() {
        if (!this._item?.MediaSources?.[0]?.MediaStreams) return;

        const key = 'Subtitle';
        const tracks = this._item.MediaSources[0].MediaStreams.filter((s) => s.Type === key);

        let currentIndex = this._selectedSubtitleIndex;
        if (currentIndex === undefined) {
            currentIndex = this._item.MediaSources[0].DefaultSubtitleStreamIndex; // Can be -1/null
        }

        // Add "Off" option
        const displayTracks = [{ Index: -1, DisplayTitle: i18n.t('Off'), Title: i18n.t('Off') }, ...tracks];

        this._renderTrackSelectionMenu(i18n.t('Subtitles'), displayTracks, currentIndex, (index) => {
            if (this._selectedSubtitleIndex === index) return;

            this._selectedSubtitleIndex = index;
            log.info('Selected Subtitle Index:', index);
        });
    }

    _renderTrackSelectionMenu(title, tracks, currentIndex, onSelect) {
        // Store focus context for restoration
        this._prevFocus = focusManager.getFocused();
        this._prevSection = focusManager.getActiveSection();

        // Reuse or create overlay
        let overlay = document.getElementById('details-track-menu');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'details-track-menu';
            overlay.className = 'modal-overlay visible';
            document.body.appendChild(overlay);
        } else {
            overlay.classList.add('visible');
        }

        // Generate HTML - Using settings-modal structure
        const optionsHtml = tracks
            .map((track, i) => {
                const isSelected = track.Index === currentIndex;
                const label =
                    track.DisplayTitle || track.Title || track.Language || i18n.t('TrackIndex', [track.Index]);
                let metadataHtml = '';

                // For subtitles, add Type and Location metadata
                if (title.toLowerCase().includes('subtitle') && track.Index !== -1) {
                    const type = (track.Codec || '').toUpperCase();
                    const location = track.IsExternal ? 'EXT' : 'INT';
                    metadataHtml = `
                        <span class="track-badge">${type}</span>
                        <span class="track-badge">${location}</span>
                    `;
                }

                return `
                <button class="modal-option-btn ${isSelected ? 'selected' : ''}" data-index="${track.Index}" tabindex="0">
                    <span class="track-option-label">
                        <span class="track-label-text">${label}</span>
                        ${metadataHtml}
                    </span>
                    <div class="check-icon"></div>
                </button>
            `;
            })
            .join('');

        overlay.innerHTML = `
            <div class="settings-modal" role="dialog" aria-modal="true">
                <div class="modal-header">
                    <h2>${title}</h2>
                </div>
                <div class="modal-options">
                    ${optionsHtml}
                </div>
                <div class="modal-actions">
                    <button class="modal-action-btn" id="btn-modal-cancel" tabindex="0">${i18n.t('ButtonCancel')}</button>
                </div>
            </div>
        `;

        // Focus management - Register as a new section
        const optionsContainer = overlay.querySelector('.modal-options');
        const actionsContainer = overlay.querySelector('.modal-actions');
        const optionsSection = 'details-track-menu';
        const actionsSection = 'details-track-menu-actions';

        this._isTrackMenuOpen = true;

        // Register the options section
        focusManager.register(optionsSection, optionsContainer, {
            orientation: 'vertical',
            leaveDown: actionsSection,
            leaveUp: actionsSection,
            enterTo: 'active-element',
            defaultElement:
                overlay.querySelector('.modal-option-btn.selected') || overlay.querySelector('.modal-option-btn')
        });

        // Register the actions section (Cancel button)
        focusManager.register(actionsSection, actionsContainer, {
            orientation: 'horizontal',
            leaveUp: optionsSection,
            onMove: (direction) => {
                if (direction === 'down') {
                    focusManager.setActiveSection(optionsSection, true, null, { enterTo: 'first' });
                    return true;
                }
                return false;
            }
        });

        // Set active immediately
        focusManager.setActiveSection(optionsSection);

        // Helper to close menu
        this._closeTrackMenu = () => {
            if (!this._isTrackMenuOpen) return;

            this._isTrackMenuOpen = false;
            overlay.classList.remove('visible');

            // Unregister focus sections
            focusManager.unregister(optionsSection);
            focusManager.unregister(actionsSection);

            // Clean up DOM after animation
            setTimeout(() => {
                if (!this._isTrackMenuOpen) overlay.remove();
            }, 300);

            // Restore focus to previous element specifically
            if (this._prevSection) {
                focusManager.setActiveSection(this._prevSection, false);
            }
            if (this._prevFocus) {
                focusManager.focusElement(this._prevFocus);
            } else {
                focusManager.setActiveSection('details-actions');
            }
        };

        // Click outside to close
        overlay.onclick = (e) => {
            if (e.target === overlay) this._closeTrackMenu();
        };

        // Bind click events for options
        overlay.querySelectorAll('.modal-option-btn').forEach((btn) => {
            btn.onclick = (e) => {
                e.stopPropagation();
                const index = parseInt(btn.dataset.index);
                onSelect(index);
                this._closeTrackMenu();
            };
        });

        // Bind cancel button
        overlay.querySelector('#btn-modal-cancel').onclick = (e) => {
            e.stopPropagation();
            this._closeTrackMenu();
        };
    }

    _showMoreOptionsModal(itemId) {
        const oldOnBack = this.onBack;
        // Store focus context for restoration (only if not already stored by a previous modal layer)
        if (!this._prevFocus) {
            this._prevFocus = focusManager.getFocused();
            this._prevSection = focusManager.getActiveSection();
        }

        // Use standard track menu style modal (list of options)
        let overlay = document.getElementById('details-more-menu');
        if (overlay) {
            // If already exists (possibly from a race or sub-modal return), remove it immediately
            // to cancel any pending exit timeouts.
            overlay.remove();
        }

        overlay = document.createElement('div');
        overlay.id = 'details-more-menu';
        overlay.className = 'modal-overlay visible';
        document.body.appendChild(overlay);

        const options = [{ id: 'refresh', label: i18n.t('RefreshMetadata') }];

        // ── Subtitle Editing Permission Check ────────────────────────────────
        // Based on jellyfin-web canEditSubtitles logic
        if (this._item && this._currentUser) {
            const i = this._item;
            const p = this._currentUser.Policy || {};
            const isLocal = i.LocationType === 'Offline';
            const isVirtual = i.LocationType === 'Virtual';
            const invalidTypes = ['TvChannel', 'Program', 'Timer', 'SeriesTimer', 'UserRootFolder', 'UserView'];

            if (i.MediaType === 'Video' && !isLocal && !isVirtual && !invalidTypes.includes(i.Type)) {
                if (p.EnableSubtitleManagement || p.IsAdministrator) {
                    options.push({ id: 'edit-subtitles', label: i18n.t('EditSubtitles') || 'Edit Subtitles' });
                }
            }
        }

        const optionsHtml = options
            .map((opt, i) => {
                return `
                <button class="modal-option-btn" data-id="${opt.id}" tabindex="0">
                    <span>${opt.label}</span>
                </button>
            `;
            })
            .join('');

        overlay.innerHTML = `
            <div class="settings-modal" role="dialog" aria-modal="true">
                <div class="modal-header">
                    <h2>${i18n.t('MoreOptions')}</h2>
                </div>
                <div class="modal-options">
                    ${optionsHtml}
                </div>
                <div class="modal-actions">
                    <button class="modal-action-btn" id="btn-modal-cancel" tabindex="0">${i18n.t('ButtonCancel')}</button>
                </div>
            </div>
        `;

        const onSelect = (id) => {
            if (id === 'refresh') {
                // Close current modal without restoring focus (since we are opening another)
                _close(false);

                // Transfer context but flag that we want to return to this menu on back
                const context = {
                    prevFocus: this._prevFocus,
                    prevSection: this._prevSection,
                    fromMoreOptions: true,
                    oldOnBack: oldOnBack // Pass the parent handler down
                };
                this._showRefreshMetadataModal(itemId, context);
            } else if (id === 'edit-subtitles') {
                // Close the More Options menu without restoring focus yet —
                // the subtitle editor will take ownership of the focus context.
                _close(false);

                // Pass full transition context so the subtitle editor can chain
                // Back navigation back to this menu and ultimately the details page.
                const context = {
                    prevFocus: this._prevFocus,
                    prevSection: this._prevSection,
                    fromMoreOptions: true,
                    oldOnBack: oldOnBack
                };
                SubtitleEditorModal.show(itemId, this, context);
            }
        };

        const _close = (restoreFocus = true) => {
            // Restore handler if we are still the active one
            if (this.onBack === myOnBack) {
                this.onBack = oldOnBack;
            }

            overlay.classList.remove('visible');
            setTimeout(() => overlay.remove(), 300);

            if (restoreFocus) {
                // Restore focus
                if (this._prevFocus) {
                    focusManager.focusElement(this._prevFocus);
                }
                if (this._prevSection) {
                    focusManager.setActiveSection(this._prevSection, false);
                }
                // Clear context for next session
                this._prevFocus = null;
                this._prevSection = null;
            }
        };

        // Trap focus
        focusManager.register('details-more-actions', overlay.querySelector('.modal-options'), {
            orientation: 'vertical',
            circular: true,
            leaveLeft: null,
            leaveRight: null
        });

        // Register cancel button area
        focusManager.register('details-more-footer', overlay.querySelector('.modal-actions'), {
            orientation: 'horizontal',
            leaveLeft: null,
            leaveRight: null,
            leaveUp: 'details-more-actions',
            leaveDown: null
        });

        // Link actions up to footer
        const actionsConfig = focusManager.getSectionConfig('details-more-actions');
        if (actionsConfig) {
            actionsConfig.leaveDown = 'details-more-footer';
            focusManager.register('details-more-actions', actionsConfig.container, actionsConfig);
        }

        focusManager.setActiveSection('details-more-actions');

        // Bind clicks
        overlay.querySelectorAll('.modal-option-btn').forEach((btn) => {
            btn.onclick = (e) => {
                e.stopPropagation();
                onSelect(btn.dataset.id);
                // Don't call _close() here, onSelect handles it
            };
        });

        overlay.querySelector('#btn-modal-cancel').onclick = (e) => {
            e.stopPropagation();
            _close();
        };

        overlay.onclick = (e) => {
            if (e.target === overlay) _close();
        };

        // Back button
        const myOnBack = () => {
            _close();
            return true;
        };
        this.onBack = myOnBack;
    }

    _showRefreshMetadataModal(itemId, transitionContext = null) {
        const oldOnBack = transitionContext?.oldOnBack || this.onBack;

        // Store focus context for restoration
        const prevFocus = transitionContext?.prevFocus || focusManager.getFocused();
        const prevSection = transitionContext?.prevSection || focusManager.getActiveSection();

        let overlay = document.getElementById('details-refresh-menu');
        if (overlay) {
            overlay.remove();
        }
        overlay = document.createElement('div');
        overlay.id = 'details-refresh-menu';
        overlay.className = 'modal-overlay visible';
        document.body.appendChild(overlay);

        const options = [
            { id: 'scan', label: i18n.t('ScanForNewAndUpdatedFiles'), mode: 'Default', replace: false },
            { id: 'missing', label: i18n.t('SearchForMissingMetadata'), mode: 'FullRefresh', replace: false },
            { id: 'all', label: i18n.t('ReplaceAllMetadata'), mode: 'FullRefresh', replace: true }
        ];

        const optionsHtml = options
            .map((opt) => {
                return `
                <button class="modal-option-btn" data-id="${opt.id}" tabindex="0">
                    <span>${opt.label}</span>
                </button>
            `;
            })
            .join('');

        overlay.innerHTML = `
            <div class="settings-modal" role="dialog" aria-modal="true">
                <div class="modal-header">
                    <h2>${i18n.t('RefreshMetadata')}</h2>
                </div>
                <div class="modal-options">
                    ${optionsHtml}
                </div>
                <div class="modal-actions">
                    <button class="modal-action-btn" id="btn-refresh-cancel" tabindex="0">${i18n.t('ButtonCancel')}</button>
                </div>
            </div>
        `;

        const _close = (restoreFocus = true) => {
            // Restore handler if we are still active
            if (this.onBack === myOnBack) {
                this.onBack = oldOnBack;
            }

            overlay.classList.remove('visible');
            setTimeout(() => overlay.remove(), 300);

            if (restoreFocus) {
                if (prevFocus) {
                    focusManager.focusElement(prevFocus);
                }
                if (prevSection) {
                    focusManager.setActiveSection(prevSection, false);
                }

                // Clear instance context if this was the last modal in the chain
                this._prevFocus = null;
                this._prevSection = null;
            }
        };

        const onSelect = async (optId) => {
            const opt = options.find((o) => o.id === optId);
            if (!opt) return;

            try {
                await api.refreshItem(itemId, {
                    MetadataRefreshMode: opt.mode,
                    ImageRefreshMode: opt.mode,
                    ReplaceAllMetadata: opt.replace,
                    ReplaceAllImages: opt.replace
                });
                toast.show(i18n.t('MessageRefreshQueued'));
            } catch (e) {
                log.error('Failed to queue metadata refresh', e);
                toast.show(i18n.t('MessageRefreshFailed'));
            }
        };

        // Trap focus
        const actionsId = 'refresh-modal-actions';
        const footerId = 'refresh-modal-footer';

        focusManager.register(actionsId, overlay.querySelector('.modal-options'), {
            orientation: 'vertical',
            circular: true,
            leaveDown: footerId
        });

        focusManager.register(footerId, overlay.querySelector('.modal-actions'), {
            orientation: 'horizontal',
            leaveUp: actionsId
        });

        focusManager.setActiveSection(actionsId);

        overlay.querySelectorAll('.modal-option-btn').forEach((btn) => {
            btn.onclick = (e) => {
                e.stopPropagation();
                onSelect(btn.dataset.id);
                _close();
            };
        });

        overlay.querySelector('#btn-refresh-cancel').onclick = (e) => {
            e.stopPropagation();
            _close();
        };

        overlay.onclick = (e) => {
            if (e.target === overlay) _close();
        };

        // Back button handler
        const myOnBack = () => {
            // Check if we need to go back to More Options
            if (transitionContext?.fromMoreOptions) {
                // Before closing, ensure onBack is restored so More Options captures the correct parent again
                this.onBack = oldOnBack;
                _close(false);
                this._showMoreOptionsModal(itemId);
            } else {
                _close();
            }
            return true;
        };
        this.onBack = myOnBack;
    }

    // ============================================================================

    _setupFavoriteButton() {
        const actionsContainer = this.$('#actions');
        if (actionsContainer) {
            if (this._favBtn) this._favBtn.destroy();

            this._favBtn = new FavoriteButton({
                itemId: this._item.Id,
                initialState: this._item.UserData?.IsFavorite,
                className: 'btn btn-icon favorite-btn',
                onChange: (isFav) => {
                    if (!this._item.UserData) this._item.UserData = {};
                    this._item.UserData.IsFavorite = isFav;
                }
            });

            // Remove any existing Favorite Button (if re-rendering)
            const old = actionsContainer.querySelector('.favorite-btn');
            if (old) old.remove();

            this._favBtn.mount(actionsContainer);

            // Move Favorite Button BEFORE Audio/Subtitle buttons if they exist
            const audioBtn = actionsContainer.querySelector('.audio-btn');
            if (audioBtn && this._favBtn.el) {
                actionsContainer.insertBefore(this._favBtn.el, audioBtn);
            }

            // Refresh focus cache so FocusManager sees the new button
            focusManager.invalidateCache('details-actions');
        }
    }

    async _toggleWatched() {
        const isPlayed = this._item.UserData?.Played;
        const btn = this.$('.watched-btn');

        // Add pulse animation trigger
        if (btn) {
            btn.classList.remove('pulse-trigger');
            void btn.offsetWidth; // Force reflow
            btn.classList.add('pulse-trigger');

            // Remove after animation finishes (0.4s in CSS)
            setTimeout(() => btn.classList.remove('pulse-trigger'), 500);
        }

        try {
            if (isPlayed) {
                await api.unmarkPlayed(this._itemId);
                btn?.classList.remove('active');
            } else {
                await api.markPlayed(this._itemId);
                btn?.classList.add('active');
            }

            this._item.UserData = this._item.UserData || {};
            this._item.UserData.Played = !isPlayed;
        } catch (error) {
            log.error('Failed to toggle watched', error);
        }
    }

    async _resetProgress() {
        try {
            // Use unmarkPlayed API - this clears PlaybackPositionTicks AND marks as unwatched.
            // Jellyfin doesn't have a dedicated "reset progress" endpoint.
            // DELETE /Users/{userId}/PlayedItems/{itemId} does both.
            await api.unmarkPlayed(this._itemId);

            // Update local state to reflect changes
            if (this._item.UserData) {
                this._item.UserData.PlaybackPositionTicks = 0;
                this._item.UserData.Played = false;
            }

            // Refresh button visibility
            this._updateButtons();

            // CRITICAL: Invalidate focus cache so FocusManager knows Resume/Reset are gone
            // and Play button is now the primary focusable in this section.
            focusManager.invalidateCache('details-actions');

            // Force focus to Play button since Reset/Resume are now hidden
            const playBtn = this.$('.play-btn');
            if (playBtn) {
                requestAnimationFrame(() => {
                    focusManager.focusElement(playBtn);
                });
            }
        } catch (error) {
            log.error('Failed to reset progress', error);
        }
    }

    destroy() {
        if (this._header) {
            this._header.destroy();
            this._header = null;
        }
        if (this._favBtn) {
            this._favBtn.destroy();
            this._favBtn = null;
        }

        if (this._isRichMetaActive) {
            this._deactivateRichMeta();
        }
        super.destroy();
    }
}

export default DetailsPage;
