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
import { focusManager } from '../ui/FocusManager.js';
import { imageService } from '../utils/ImageService.js';

import FavoriteButton from '../components/FavoriteButton.js';
import EpisodeList from '../components/EpisodeList.js';

import BackdropManager from '../utils/BackdropManager.js';
import { lazyLoader } from '../utils/LazyLoader.js';
import { logger } from '../utils/Logger.js';
import { toast } from '../ui/Toast.js';

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
                                    <span>Play</span>
                                </button>
                                <button class="btn btn-secondary resume-btn hidden" tabindex="-1">
                                    <span>Resume</span>
                                </button>
                                <button class="btn btn-icon reset-btn hidden" tabindex="-1" aria-label="Reset Progress">
                                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                                        <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
                                        <path d="M3 3v5h5"/>
                                    </svg>
                                </button>
                                <button class="btn btn-icon watched-btn" tabindex="0" aria-label="Mark as watched">
                                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                                </button>
                                <!-- Favorite Button Injected Here -->
                                <button class="btn btn-icon audio-btn" tabindex="0" aria-label="Audio Tracks">
                                    <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v9.28c-.47-.17-.97-.28-1.5-.28C8.01 12 6 14.01 6 16.5S8.01 21 10.5 21c2.31 0 4.2-1.75 4.45-4H15V6h4V3h-7z"/></svg>
                                </button>
                                <button class="btn btn-icon subtitle-btn" tabindex="0" aria-label="Subtitle Tracks">
                                    <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor"><path d="M19 4H5c-1.11 0-2 .9-2 2v12c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm-8 7H9.5v-.5h-2v3h2V13H11v1c0 .55-.45 1-1 1H7c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1zm7 0h-1.5v-.5h-2v3h2V13H18v1c0 .55-.45 1-1 1h-3c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1z"/></svg>
                                </button>
                                <button class="btn btn-icon more-btn" tabindex="0" aria-label="More Options">
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
                                <button class="see-more-btn" tabindex="0">See More</button>
                            </div>

                        </div>
                    </div>
                    
                    <!-- Rich Metadata (Genres, People, Studios, Tags) -->
                    <div id="rich-meta-container" class="media-row">
                        <div class="details-rich-meta" id="rich-meta" tabindex="0"></div>
                    </div>

                    <!-- Collection Movies (BoxSet) -->
                    <section class="details-collection-movies media-row hidden" id="collection-movies-section">
                        <h2 class="row-title">Movies in Collection</h2>
                        <div class="collection-row row-items" id="collection-movies-row"></div>
                    </section>

                    <!-- Collection Shows (BoxSet) -->
                    <section class="details-collection-shows media-row hidden" id="collection-shows-section">
                        <h2 class="row-title">Shows in Collection</h2>
                        <div class="collection-row row-items" id="collection-shows-row"></div>
                    </section>
                    
                    <!-- Next Up (for series) -->
                    <section class="details-next-up media-row hidden" id="next-up-section">
                        <h2 class="row-title">Next Up</h2>
                        <div class="next-up-row row-items" id="next-up-row"></div>
                    </section>
                    
                    <!-- Seasons (for series) -->
                    <section class="details-seasons media-row hidden" id="seasons-section">
                        <h2 class="row-title">Seasons</h2>
                        <div class="seasons-row" id="seasons-row"></div>
                    </section>
                    
                    <!-- Episodes (for season/series) -->
                    <section class="details-episodes media-row hidden" id="episodes-section">
                        <h2 class="row-title">Episodes</h2>
                        <div class="episodes-list" id="episodes-list"></div>
                    </section>

                    <!-- More from Season (for episodes) -->
                    <section class="details-season-episodes media-row hidden" id="more-from-season-section">
                        <h2 class="row-title" id="more-from-season-title">More from Season</h2>
                        <div class="season-episodes-row row-items" id="more-from-season-row"></div>
                    </section>

                    <!-- Cast & Crew -->
                    <section class="details-people media-row hidden" id="people-section">
                        <h2 class="row-title">Cast & Crew</h2>
                        <div class="people-row row-items" id="people-row"></div>
                    </section>

                    <!-- Guest Stars (for episodes) -->
                    <section class="details-guest-stars media-row hidden" id="guest-stars-section">
                        <h2 class="row-title">Guest Stars</h2>
                        <div class="guest-stars-row row-items" id="guest-stars-row"></div>
                    </section>
                    
                    <!-- Similar items -->
                    <section class="details-similar media-row hidden" id="similar-section">
                        <h2 class="row-title">More Like This</h2>
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

            // Load item details
            await this._loadDetails();

            // Trigger deferred scroll/focus restoration
            this.restoreScrollFocusWhenReady();
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

        // Default to Play button (actions)
        this.setActiveSection('details-actions');
    }

    _bindActions() {
        // Play button
        this.$('.play-btn')?.addEventListener('click', () => {
            this._play();
        });

        // Resume button
        this.$('.resume-btn')?.addEventListener('click', () => {
            this._play(true);
        });

        // Watched button
        this.$('.watched-btn')?.addEventListener('click', () => {
            this._toggleWatched();
        });

        // Reset button
        this.$('.reset-btn')?.addEventListener('click', () => {
            this._resetProgress();
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

        try {
            // 1. Fetch Item (with People data)
            this._item = await api.getItem(this._itemId, { Fields: 'People' });
            this.title = this._item.Name;

            // 2. Render all text content immediately (Metadata, Hero Info)
            this._renderHeroText();
            this._setupFavoriteButton();
            this._renderRichMetadata();

            // 3. Parallelize loading of ALL major content (Images, Rows, Similar)
            // This ensures we aren't blocked by the 1.5s poster timeout while
            // the episode/season data is ready.
            const loadTasks = [this._loadImages(), this._loadSecondaryContent()];

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

            // 5. FINALLY dismiss loading - page is now 100% ready and navigable
            this.setLoading(false);

            // FIX: Ensure Focus Manager knows about the Resume button if it appeared
            focusManager.invalidateCache('details-actions');

            // If we have resume progress, FORCE focus to the resume button
            if (this._item.UserData?.PlaybackPositionTicks > 0) {
                const resumeBtn = this.$('.resume-btn');
                if (resumeBtn && !resumeBtn.classList.contains('hidden')) {
                    log.info('Forcing focus to Resume button');
                    this._pendingNavState = null;
                    focusManager.focusElement(resumeBtn);
                }
            }
        } catch (error) {
            log.error('Failed to load', error);
            this.showError('Failed to load details');
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
            // poster is slow. 1500ms is generous enough for TV network
            // latency + image decode, but still fast enough that users
            // won't stare at a blank poster area.
            const timeout = setTimeout(() => {
                if (!resolved) {
                    log.warn('Poster load timed out, showing content');
                    resolved = true;
                    resolve();
                }
            }, 1500);

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
                // No primary image, resolve immediately
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

        // Load Logo (non-blocking, fire and forget)
        this._loadLogo();
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

    _renderCollectionRow(sectionId, listId, items, leaveUpTarget) {
        const section = this.$(`#${sectionId}`);
        const list = this.$(`#${listId}`);
        if (!section || !list) return;

        section.classList.remove('hidden');

        list.innerHTML = items.map((item) => this._renderMediaCard(item, false, 'poster')).join('');

        // Delegated click handler
        list.onclick = (e) => {
            const card = e.target.closest('.media-card');
            if (card?.dataset?.itemId) {
                router.navigate(`/details/${card.dataset.itemId}`);
            }
        };

        // Register Focus with dynamic UP linking
        this.registerFocusSection(sectionId, section, {
            orientation: 'horizontal',
            leaveLeft: 'sidebar',
            leaveUp: leaveUpTarget || 'details-rich-meta',
            enterTo: 'last-focused'
        });

        lazyLoader.observe(list);
    }

    _renderRichMetadata() {
        const item = this._item;
        const htmlParts = [];

        // Helper to create row
        const createRow = (label, items) => {
            if (!items || items.length === 0) return '';
            const valuesHtml = items
                .map((i) => {
                    const name = i.Name || i; // Handle object or string
                    const id = i.Id || '';
                    const type = label.toLowerCase(); // 'genres', 'studios', 'directors', 'writers', 'tags'

                    return `<button class="meta-chip" tabindex="-1" data-id="${id}" data-type="${type}" data-name="${name}">${name}</button>`;
                })
                .join('');

            return `
                <div class="rich-meta-row">
                    <div class="meta-label">${label}</div>
                    <div class="meta-value-list">${valuesHtml}</div>
                </div>
            `;
        };

        // Genres (Prefer GenreItems for IDs)
        const genres = item.GenreItems || item.Genres;
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
            const timeString = endTime.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
            endsAtText = `Ends at ${timeString}`;
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
        const displayTitle = isSeason ? item.SeriesName || item.Name : item.Name;
        const displaySubtitle = isSeason
            ? item.Name
            : item.OriginalTitle && item.OriginalTitle !== item.Name
              ? item.OriginalTitle
              : '';

        this.$('#hero-info').innerHTML = `
            <div id="details-logo" class="details-logo"></div>
            <h1 class="details-title">${displayTitle}</h1>
            ${displaySubtitle && displaySubtitle !== displayTitle ? `<h2 class="details-original-title">${displaySubtitle}</h2>` : ''}
            ${item.Type === 'Episode' ? `<p class="details-episode-info">S${item.ParentIndexNumber}:E${item.IndexNumber} - ${item.SeriesName}</p>` : ''}
            
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

    /**
     * Handle navigation when a metadata item (Year, Genre, Studio, Person, etc.) is clicked
     * @param {HTMLElement} element - The clicked button or chip
     */
    _handleMetaClick(element) {
        const type = element.dataset.type;
        const id = element.dataset.id;
        const name = element.dataset.name || element.dataset.value;
        const libraryId = this._item.ParentId || this._item.LibraryId; // Fallback to LibraryId if ParentId missing

        if (!this.state.libraryId && !this._item.ParentId) {
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
        resumeBtn.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> <span>Resume (${resumeTime}m)</span>`;

        // CRITICAL: If we hid the Play button (which probably had focus or would get it),
        // we must manually force focus to the Resume button so focus isn't lost.
        requestAnimationFrame(() => {});

        // Watched button
        if (userData.Played) {
            if (watchedBtn) watchedBtn.classList.add('active');
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
        const container = this.$('#next-up-row');
        const section = this.$('#next-up-section');

        section.classList.remove('hidden');
        container.classList.add('row-items');

        const htmlParts = [];
        for (const item of this._nextUp) {
            // Force landscape for Next Up (Episode)
            htmlParts.push(this._renderMediaCard(item, true, 'episode'));
        }
        container.innerHTML = htmlParts.join('');

        // Lazy Load
        lazyLoader.observe(container);

        // Delegated click handler
        container.onclick = (e) => {
            const card = e.target.closest('.media-card');
            if (card?.dataset?.itemId) {
                // Navigate to episode details?? Or play?
                // Usually Next Up on details page -> Play or go to episode?
                // Jellyfin web goes to Episode Details.
                router.navigate(`/details/${card.dataset.itemId}`);
            }
        };

        // Determine upward link using helper
        const upwardLink = this._getPreviousVisibleSection('details-next-up')?.targetName || 'details-actions';
        const nextSection = this._getNextVisibleSection('details-next-up');
        const leaveDownTarget = nextSection ? nextSection.targetName : null;

        // Register focus section
        this.registerFocusSection('details-next-up', container, {
            orientation: 'horizontal',
            leaveUp: upwardLink,
            leaveDown: leaveDownTarget, // Ensure down navigation works
            leaveLeft: 'sidebar',
            enterTo: 'first'
        });

        // Update upward link
        this._updateLeaveDown(upwardLink, 'details-next-up');
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
        const container = this.$('#seasons-row');
        const section = this.$('#seasons-section');

        section.classList.remove('hidden');
        container.classList.add('row-items'); // Standard class

        const htmlParts = [];
        for (const season of this._seasons) {
            htmlParts.push(this._renderMediaCard(season, false, 'season'));
        }
        container.innerHTML = htmlParts.join('');

        // Lazy Load
        lazyLoader.observe(container);

        // Delegated click handler
        container.onclick = (e) => {
            const card = e.target.closest('.media-card');
            if (card?.dataset?.itemId) {
                // Navigate directly to DetailsPage with Season ID
                router.navigate(`/details/${card.dataset.itemId}`);
            }
        };

        const upwardLink = this._getPreviousVisibleSection('details-seasons')?.targetName || 'details-actions';
        const nextSection = this._getNextVisibleSection('details-seasons');
        const leaveDownTarget = nextSection ? nextSection.targetName : null;

        this.registerFocusSection('details-seasons', container, {
            orientation: 'horizontal',
            leaveUp: upwardLink,
            leaveDown: leaveDownTarget,
            leaveLeft: 'sidebar',
            enterTo: 'first'
        });

        // Update upward link
        this._updateLeaveDown(upwardLink, 'details-seasons');
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
            container.classList.add('vertical-list');
            // Use vertical EpisodeList component
            this._episodeList = new EpisodeList({
                episodes: this._episodes,
                seriesId: this._item.SeriesId,
                onPlay: (episodeId) => {
                    const episode = this._episodes.find((e) => e.Id === episodeId);
                    if (episode) {
                        eventBus.emit('player:play', {
                            item: episode,
                            resume: false // Or true if we want to prompt? Default false for now
                        });
                    }
                },
                onAction: (action, episodeId) => {
                    if (action === 'info') {
                        router.navigate(`/details/${episodeId}`);
                    } else if (action === 'menu') {
                        this._showMoreOptionsModal(episodeId);
                    }
                    log.debug(`Episode action: ${action} on ${episodeId}`);
                }
            });
            this._episodeList.mount(container);

            // Lazy Load Episode Images (if list renders them)
            lazyLoader.observe(container);
        } else {
            // Horizontal episode cards (for Series NextUp, etc.)
            const htmlParts = [];
            for (const ep of this._episodes) {
                const progress =
                    ep.UserData?.PlaybackPositionTicks && ep.RunTimeTicks
                        ? (ep.UserData.PlaybackPositionTicks / ep.RunTimeTicks) * 100
                        : 0;

                htmlParts.push(`
                    <button class="episode-card" data-episode-id="${ep.Id}" tabindex="0">
                        <div class="episode-thumb">
                            <img src="${api.getImageUrl(ep.Id, 'Primary', { maxWidth: imageService.getParams('thumb').maxWidth, quality: imageService.getParams('thumb').quality })}" alt="">
                            ${
                                progress > 0
                                    ? '<div style="position: absolute; bottom: 0; left: 0; width: 100%; height: 6px; background-color: rgba(0,0,0,0.7); z-index: 100;">' +
                                      '<div style="width: ' +
                                      progress +
                                      '%; height: 100%; background-color: #00a4dc;"></div></div>'
                                    : ''
                            }
                        </div>
                        <div class="episode-info">
                            <span class="episode-number">E${ep.IndexNumber}</span>
                            <span class="episode-title">${ep.Name}</span>
                            <p class="episode-overview">${ep.Overview?.substring(0, 100) || ''}...</p>
                        </div>
                    </button>
                `);
            }
            container.innerHTML = htmlParts.join('');

            // Click handlers
            container.querySelectorAll('.episode-card').forEach((card) => {
                card.addEventListener('click', () => {
                    router.navigate(`/details/${card.dataset.episodeId}`);
                });
            });
        }

        // Focus section registration
        const upwardLink = this._getPreviousVisibleSection('details-episodes')?.targetName || 'details-actions';
        const nextSection = this._getNextVisibleSection('details-episodes');
        const leaveDownTarget = nextSection ? nextSection.targetName : null;

        // Register focus section - use appropriate selector
        const selector = this._item.Type === 'Season' ? '.episode-row-card, .episode-action-btn' : '.episode-card';

        // Helper for custom navigation
        const onSeasonMove = (direction, focusedEl) => {
            const currentRow = focusedEl.closest('.episode-row');
            if (!currentRow) return false;

            // Get all rows to determine index
            const allRows = Array.from(container.querySelectorAll('.episode-row'));
            const rowIndex = allRows.indexOf(currentRow);

            if (direction === 'up') {
                if (rowIndex > 0) {
                    // Move to previous row's CARD (always reset to card for stability)
                    const prevRow = allRows[rowIndex - 1];
                    const target = prevRow.querySelector('.episode-row-card');
                    focusManager.focusElement(target);
                    return true;
                }
                // At top row - let it bubble to leaveUp
                return false;
            }

            if (direction === 'down') {
                if (rowIndex < allRows.length - 1) {
                    // Move to next row's CARD
                    const nextRow = allRows[rowIndex + 1];
                    const target = nextRow.querySelector('.episode-row-card');
                    focusManager.focusElement(target);
                    return true;
                }
                // At bottom row - let it bubble to leaveDown
                return false;
            }

            // Left/Right handled by 'horizontal' orientation (linear in DOM)
            // But we might want to ensure it doesn't wrap to next row?
            // Standard 'horizontal' in FocusManager checks index +/- 1.
            // Since our DOM order is Card -> Btn1 -> Btn2 -> NextCard...
            // "Right" from last Btn would go to NextCard. We probably DON'T want that?
            // Ideally Right on last button should do nothing (or leaveRight?)
            if (direction === 'right') {
                const rowItems = Array.from(currentRow.querySelectorAll(selector.split(', ').join(',')));
                const itemIndex = rowItems.indexOf(focusedEl);

                // If we are at the end of the row, BLOCK movement to next row
                if (itemIndex >= rowItems.length - 1) {
                    return true; // Handled (blocked)
                }
            }

            if (direction === 'left') {
                const rowItems = Array.from(currentRow.querySelectorAll(selector.split(', ').join(',')));
                const itemIndex = rowItems.indexOf(focusedEl);

                // If at start of row (Card), let it bubble to leaveLeft (if any) or Sidebar?
                // Standard horizontal will try index-1.
                // If index-1 is prev row's last button, that's bad.
                // So we must BLOCK if itemIndex is 0.
                if (itemIndex === 0) {
                    return false; // Allow bubble to leave section
                }
            }

            return false; // Fallback to standard local move
        };

        this.registerFocusSection('details-episodes', container, {
            orientation: 'horizontal', // Use horizontal to handle Left/Right linear
            leaveUp: upwardLink,
            leaveDown: leaveDownTarget,
            leaveLeft: 'sidebar',
            selector: selector,
            onMove: this._item.Type === 'Season' ? onSeasonMove : null
        });

        // Update upward link's leaveDown
        this._updateLeaveDown(upwardLink, 'details-episodes');
    }

    _renderPeople() {
        const container = this.$('#people-row');
        const section = this.$('#people-section');

        section.classList.remove('hidden');

        const htmlParts = [];
        for (const person of this._people) {
            htmlParts.push(this._renderMediaCard(person, false, 'person'));
        }
        container.innerHTML = htmlParts.join('');

        // Lazy Load
        lazyLoader.observe(container);

        // Delegated click handler - navigate to Person Details (if we had a page)
        // For now, maybe just focus? Or do nothing?
        // User didn't specify behavior, but usually it goes to person items.
        // Person Click Handler
        container.onclick = (e) => {
            const card = e.target.closest('.media-card');
            if (card && card.dataset.itemId) {
                const personId = card.dataset.itemId;
                router.navigate(`/person/${personId}`);
            }
        };

        const upwardLink = this._getPreviousVisibleSection('details-people')?.targetName || 'details-actions';
        const nextSection = this._getNextVisibleSection('details-people');
        const leaveDownTarget = nextSection ? nextSection.targetName : null;

        // Register focus section
        this.registerFocusSection('details-people', container, {
            orientation: 'horizontal',
            leaveUp: upwardLink,
            leaveDown: leaveDownTarget,
            leaveLeft: 'sidebar',
            enterTo: 'first'
        });

        // Update upward link's leaveDown
        this._updateLeaveDown(upwardLink, 'details-people');
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
                    seeMoreBtn.textContent = 'See More';
                    this.el.scrollTop = 0; // Optional: Reset scroll
                } else {
                    // Expand
                    overviewEl.classList.remove('line-clamp-6');
                    seeMoreBtn.textContent = 'See Less';
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
        const container = this.$('#more-from-season-row');
        const section = this.$('#more-from-season-section');
        const titleEl = this.$('#more-from-season-title');

        if (!container || !section) return;

        section.classList.remove('hidden');

        // Update title if we have the season name
        if (this._item.SeasonName) {
            titleEl.textContent = `More from ${this._item.SeasonName}`;
        }

        container.innerHTML = episodes.map((ep) => this._renderMediaCard(ep, true, 'episode')).join('');

        // Lazy Load
        lazyLoader.observe(container);

        container.onclick = (e) => {
            const card = e.target.closest('.media-card');
            if (card?.dataset?.itemId) {
                router.navigate(`/details/${card.dataset.itemId}`);
            }
        };

        const upwardLink = this._getPreviousVisibleSection('more-from-season-section')?.targetName || 'details-actions';
        const nextSection = this._getNextVisibleSection('more-from-season-section');
        const leaveDownTarget = nextSection ? nextSection.targetName : null;

        this.registerFocusSection('more-from-season-section', container, {
            orientation: 'horizontal',
            leaveUp: upwardLink,
            leaveDown: leaveDownTarget,
            leaveLeft: 'sidebar',
            enterTo: 'last-focused'
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
        const container = this.$('#guest-stars-row');
        const section = this.$('#guest-stars-section');

        if (!container || !section) return;

        section.classList.remove('hidden');

        container.innerHTML = people.map((p) => this._renderMediaCard(p, false, 'person')).join('');

        // Lazy Load
        lazyLoader.observe(container);

        container.onclick = (e) => {
            const card = e.target.closest('.media-card');
            if (card?.dataset?.itemId) {
                router.navigate(`/person/${card.dataset.itemId}`);
            }
        };

        const upwardLink = this._getPreviousVisibleSection('guest-stars-section')?.targetName || 'details-actions';
        const nextSection = this._getNextVisibleSection('guest-stars-section');
        const leaveDownTarget = nextSection ? nextSection.targetName : null;

        this.registerFocusSection('guest-stars-section', container, {
            orientation: 'horizontal',
            leaveUp: upwardLink,
            leaveDown: leaveDownTarget,
            leaveLeft: 'sidebar',
            enterTo: 'first'
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
            const response = await api.getSimilar(this._itemId);
            this._similar = response.Items || [];

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
        const container = this.$('#similar-row');
        const section = this.$('#similar-section');

        section.classList.remove('hidden');
        container.classList.add('row-items');

        const htmlParts = [];
        for (const item of this._similar) {
            htmlParts.push(this._renderMediaCard(item, false, 'poster'));
        }
        container.innerHTML = htmlParts.join('');

        // Lazy Load
        lazyLoader.observe(container);

        container.onclick = (e) => {
            const card = e.target.closest('.media-card');
            if (card?.dataset?.itemId) {
                router.navigate(`/details/${card.dataset.itemId}`);
            }
        };

        // Use dynamic helper to find the previous visible section (includes collection rows)
        const upwardLink = this._getPreviousVisibleSection('details-similar')?.targetName || 'details-actions';

        this.registerFocusSection('details-similar', container, {
            orientation: 'horizontal',
            leaveUp: upwardLink,
            leaveLeft: 'sidebar',
            enterTo: 'first'
        });

        this._updateLeaveDown(upwardLink, 'details-similar');
    }

    async _play(resume = false) {
        let itemToPlay = this._item;

        if (this._item.Type === 'BoxSet') {
            try {
                // Fetch first item in collection (recursive)
                // We prefer Movies over Episodes to match the visual row priority
                const [movies, episodes] = await Promise.all([
                    api.getItems({
                        ParentId: this._item.Id,
                        Recursive: true,
                        IncludeItemTypes: 'Movie',
                        Limit: 1,
                        SortBy: 'SortName'
                    }),
                    api.getItems({
                        ParentId: this._item.Id,
                        Recursive: true,
                        IncludeItemTypes: 'Episode',
                        Limit: 1,
                        SortBy: 'SortName'
                    })
                ]);

                if (movies.Items && movies.Items.length > 0) {
                    itemToPlay = movies.Items[0];
                } else if (episodes.Items && episodes.Items.length > 0) {
                    itemToPlay = episodes.Items[0];
                } else {
                    return; // Empty collection
                }

                // Attach context so PlayQueue knows this is a collection play
                itemToPlay.contextType = 'boxset';
                itemToPlay.contextId = this._item.Id;
            } catch (e) {
                log.error('Failed to play collection', e);
                return;
            }
        } else if (this._item.Type === 'Series') {
            if (this._episodes?.length > 0) {
                // If episodes are already loaded (e.g. we are on a Season page but Item is Series? Rare case)
                itemToPlay = this._episodes.find((ep) => !ep.UserData?.Played) || this._episodes[0];
            } else {
                try {
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

        this._renderTrackSelectionMenu('Audio', tracks, currentIndex, (index) => {
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
        const displayTracks = [{ Index: -1, DisplayTitle: 'Off', Title: 'Off' }, ...tracks];

        this._renderTrackSelectionMenu('Subtitles', displayTracks, currentIndex, (index) => {
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
                const label = track.DisplayTitle || track.Title || track.Language || `Track ${track.Index}`;
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
                    <button class="modal-action-btn" id="btn-modal-cancel" tabindex="0">Cancel</button>
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

        const options = [
            { id: 'refresh', label: 'Refresh Metadata' },
            { id: 'edit-subtitles', label: 'Edit Subtitles (not implemented yet)' }
        ];

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
                    <h2>Options</h2>
                </div>
                <div class="modal-options">
                    ${optionsHtml}
                </div>
                <div class="modal-actions">
                    <button class="modal-action-btn" id="btn-modal-cancel" tabindex="0">Cancel</button>
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
                toast.show('Subtitle editing coming soon!');
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
            { id: 'scan', label: 'Scan for new and updated files', mode: 'Default', replace: false },
            { id: 'missing', label: 'Search for missing metadata', mode: 'FullRefresh', replace: false },
            { id: 'all', label: 'Replace all metadata', mode: 'FullRefresh', replace: true }
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
                    <h2>Refresh Metadata</h2>
                </div>
                <div class="modal-options">
                    ${optionsHtml}
                </div>
                <div class="modal-actions">
                    <button class="modal-action-btn" id="btn-refresh-cancel" tabindex="0">Cancel</button>
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
                toast.show('Refresh Queued');
            } catch (e) {
                log.error('Failed to queue metadata refresh', e);
                toast.show('Failed to queue refresh');
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

        try {
            if (isPlayed) {
                await api.unmarkPlayed(this._itemId);
                this.$('.watched-btn').classList.remove('active');
            } else {
                await api.markPlayed(this._itemId);
                this.$('.watched-btn').classList.add('active');
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
