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
import MediaInfoModal from '../components/MediaInfoModal.js';
import TrailerDialog from '../components/TrailerDialog.js';
import { TrailerPlayer } from '../components/TrailerPlayer.js';
import AddToTargetModal from '../components/AddToTargetModal.js';

import BackdropManager from '../utils/BackdropManager.js';
import { PlayerSettings } from '../utils/PlayerSettings.js';
import { lazyLoader } from '../utils/LazyLoader.js';
import { VirtualCardRow } from '../components/VirtualCardRow.js';
import { logger } from '../utils/Logger.js';
import { toast } from '../ui/Toast.js';
import { i18n } from '../utils/i18n.js';
import CardRenderer from '../utils/CardRenderer.js';
import { shouldShowScore } from '../utils/visibility.js';
import { storage } from '../utils/StorageService.js';
import { formatDate } from '../utils/TimeUtils.js';
import { themeSongPlayer } from '../utils/ThemeSongPlayer.js';
import { detailsIcons, settingsIcons } from '../utils/Icons.js';

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

        // Track/Version selection state
        this._selectedMediaSourceId = null;
        this._selectedAudioIndex = undefined;
        this._selectedSubtitleIndex = undefined;

        // Mark as async page for Navigation State
        this._isAsyncPage = true;
    }

    /**
     * Override _renderMediaCard to provide a default context for all
     * related content rows (Similar, Next Up, Cast).
     */
    _renderMediaCard(item, isLandscape, type, options = {}) {
        // Default to 'details-row' which maps to the 'home' preset (228px posters, 388px thumbs)
        // rather than the massive 'details' primary image presets.
        options.contextType = options.contextType || 'details-row';
        return super._renderMediaCard(item, isLandscape, type, options);
    }

    render() {
        const detailsLayout = storage.getItem('pref:detailsLayout') || 'posterLeft';
        let layoutClass = 'layout-poster-left';
        if (detailsLayout === 'posterRight') {
            layoutClass = 'layout-poster-right';
        } else if (detailsLayout === 'backdropMinimal') {
            layoutClass = 'layout-backdrop-minimal';
        } else if (detailsLayout === 'backdropLeft') {
            layoutClass = 'layout-backdrop-left';
        }

        return `
            <div class="page details-page ${layoutClass}">
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
                                    ${detailsIcons.play}
                                    <span data-i18n="Play">Play</span>
                                </button>
                                <button class="btn btn-secondary resume-btn hidden" tabindex="-1">
                                    <span data-i18n="ButtonResume">Resume</span>
                                </button>
                                <button class="btn btn-icon reset-btn hidden" tabindex="-1" aria-label="${i18n.t('ResetProgress')}">
                                    ${detailsIcons.reset}
                                </button>
                                <button class="btn btn-icon ghost-btn hidden" tabindex="-1" aria-label="${i18n.t('GhostMode') || 'Ghost Mode'}">
                                    ${detailsIcons.ghost}
                                </button>
                                <!-- Trailer button — shown only when item has local or remote trailers.
                                     Visibility is set dynamically by _updateTrailerButton() after load. -->
                                <button class="btn btn-icon trailer-btn hidden" tabindex="-1" aria-label="${i18n.t('WatchTrailer') || 'Watch Trailer'}">
                                    ${detailsIcons.trailer}
                                </button>
                                <button class="btn btn-icon shuffle-btn hidden" tabindex="-1" aria-label="${i18n.t('Shuffle')}">
                                    ${detailsIcons.shuffle}
                                </button>
                                <button class="btn btn-icon watched-btn" tabindex="0" aria-label="${i18n.t('MarkWatched')}">
                                    ${detailsIcons.watchedOutline}
                                </button>
                                <!-- Favorite Button Injected Here -->
                                <button class="btn btn-icon audio-btn" tabindex="0" aria-label="${i18n.t('AudioTracks')}">
                                    ${detailsIcons.audio}
                                </button>
                                <button class="btn btn-icon subtitle-btn" tabindex="0" aria-label="${i18n.t('SubtitleTracks')}">
                                    ${detailsIcons.subtitle}
                                </button>
                                <button class="btn btn-icon more-btn" tabindex="0" aria-label="${i18n.t('MoreOptions')}">
                                    ${detailsIcons.more}
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

                    <!-- Playlist Items — shown when viewing a Playlist type item.
                         Uses a landscape MediaGrid to handle the mixed content (movies,
                         episodes, music videos) that playlists can contain. -->
                    <section class="details-playlist-items media-row hidden" id="playlist-items-section">
                        <h2 class="row-title" id="playlist-items-title" data-i18n="PlaylistItems">Items</h2>
                        <div class="playlist-items-list" id="playlist-items-list"></div>
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

                    <!-- Special Features -->
                    <section class="details-special-features media-row hidden" id="special-features-section">
                        <h2 class="row-title" data-i18n="SpecialFeatures">Special Features</h2>
                        <div class="special-features-row row-items" id="special-features-row"></div>
                    </section>

                    <!-- Songs (for albums) -->
                    <section class="details-songs media-row hidden" id="songs-section">
                        <h2 class="row-title songs-title" data-i18n="Songs">Songs</h2>
                        <div class="songs-list" id="songs-list"></div>
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
                    
                    <!-- Collections this item belongs to -->
                    <section class="details-item-collections media-row hidden" id="item-collections-section">
                        <h2 class="row-title" data-i18n="Collections">Collections</h2>
                        <div class="item-collections-row row-items" id="item-collections-row"></div>
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

            // ----------------------------------------------------------------
            // Auto-chain check: did we just return from a local trailer that
            // was launched as part of an auto-chain sequence?
            //
            // _playLocalTrailerThenChain() writes 'details:autoChainRemote'
            // to state (an in-memory singleton that outlives page instances)
            // before navigating to the player. When the player finishes and
            // router.back() brings us back here as a fresh DetailsPage, we
            // check for that flag and open the remote trailer automatically.
            //
            // We only consume the flag if the item ID matches — in case the
            // user somehow navigated to a different details page in between.
            // ----------------------------------------------------------------
            const pendingChain = state.get('details:autoChainRemote');
            if (pendingChain && pendingChain === this._itemId) {
                // Consume the flag immediately so it won't re-fire on next visit
                state.delete('details:autoChainRemote');
                log.info(
                    '[AutoChain] Detected pending remote chain for item',
                    this._itemId,
                    '— opening remote trailer'
                );

                // Short delay: let the page settle visually before slamming the
                // overlay on top. Prevents a jarring instant transition.
                setTimeout(() => this._showRemoteTrailerPlayer(), 300);
            }
        } catch (err) {
            log.error('onInit failed', err);
        }
    }

    _setupFocus() {
        // ====================================================================
        // Details Page Primary Actions Focus Registration
        // ====================================================================
        // We register the actions section using a 'grid' orientation,
        // On smaller displays or layouts with wrapped buttons, a strict horizontal
        // orientation forces users to navigate linearly and skips wrapped elements
        // when pressing vertical keys (UP/DOWN).
        // Using 'grid' delegates movement to the SpatialNavigator, allowing the D-pad
        // to move naturally between wrapped rows of action buttons.
        // ====================================================================
        this.registerFocusSection('details-actions', this.$('#actions'), {
            orientation: 'grid',
            leaveUp: null, // Boundary at the top of the page
            leaveDown: null, // Dynamically chained based on sibling visibility
            leaveLeft: 'sidebar',
            // Landing priority: always favor primary action (Play or Resume)
            // when entering this section to keep interaction flow consistent.
            defaultFocusSelector: '.resume-btn:not(.hidden), .play-btn'
        });

        // Set the primary actions row as the initial active focus section
        this.setActiveSection('details-actions');
    }

    _bindActions() {
        let lastActivateTime = 0;
        const handleActivate = (e, callback) => {
            const now = Date.now();
            if (now - lastActivateTime < 400) return;
            lastActivateTime = now;
            e.preventDefault();
            e.stopPropagation();
            callback();
        };

        // Play button
        const playBtn = this.$('.play-btn');
        if (playBtn) {
            playBtn.addEventListener('mousedown', (e) => handleActivate(e, () => this._play()));
            playBtn.addEventListener('click', (e) => handleActivate(e, () => this._play()));
        }

        // Resume button
        const resumeBtn = this.$('.resume-btn');
        if (resumeBtn) {
            resumeBtn.addEventListener('mousedown', (e) => handleActivate(e, () => this._play({ resume: true })));
            resumeBtn.addEventListener('click', (e) => handleActivate(e, () => this._play({ resume: true })));
        }

        // Watched button
        const watchedBtn = this.$('.watched-btn');
        if (watchedBtn) {
            watchedBtn.addEventListener('mousedown', (e) => handleActivate(e, () => this._toggleWatched()));
            watchedBtn.addEventListener('click', (e) => handleActivate(e, () => this._toggleWatched()));
        }

        // Reset button
        const resetBtn = this.$('.reset-btn');
        if (resetBtn) {
            resetBtn.addEventListener('mousedown', (e) => handleActivate(e, () => this._resetProgress()));
            resetBtn.addEventListener('click', (e) => handleActivate(e, () => this._resetProgress()));
        }

        // Ghost button
        const ghostBtn = this.$('.ghost-btn');
        if (ghostBtn) {
            ghostBtn.addEventListener('mousedown', (e) => handleActivate(e, () => this._play({ ghostMode: true })));
            ghostBtn.addEventListener('click', (e) => handleActivate(e, () => this._play({ ghostMode: true })));
        }

        // Trailer button
        const trailerBtn = this.$('.trailer-btn');
        if (trailerBtn) {
            trailerBtn.addEventListener('mousedown', (e) => handleActivate(e, () => this._onTrailerClick()));
            trailerBtn.addEventListener('click', (e) => handleActivate(e, () => this._onTrailerClick()));
        }

        // Shuffle button
        const shuffleBtn = this.$('.shuffle-btn');
        if (shuffleBtn) {
            shuffleBtn.addEventListener('mousedown', (e) => handleActivate(e, () => this._shufflePlay()));
            shuffleBtn.addEventListener('click', (e) => handleActivate(e, () => this._shufflePlay()));
        }

        // Subtitle button
        const subtitleBtn = this.$('.subtitle-btn');
        if (subtitleBtn) {
            subtitleBtn.addEventListener('mousedown', (e) => handleActivate(e, () => this._showSubtitleTrackMenu()));
            subtitleBtn.addEventListener('click', (e) => handleActivate(e, () => this._showSubtitleTrackMenu()));
        }

        // Audio button
        const audioBtn = this.$('.audio-btn');
        if (audioBtn) {
            audioBtn.addEventListener('mousedown', (e) => handleActivate(e, () => this._showAudioTrackMenu()));
            audioBtn.addEventListener('click', (e) => handleActivate(e, () => this._showAudioTrackMenu()));
        }

        // More button
        const moreBtn = this.$('.more-btn');
        if (moreBtn) {
            moreBtn.addEventListener('mousedown', (e) =>
                handleActivate(e, () => this._showMoreOptionsModal(this._itemId))
            );
            moreBtn.addEventListener('click', (e) => handleActivate(e, () => this._showMoreOptionsModal(this._itemId)));
        }

        // See more button
        const seeMoreBtn = this.$('.see-more-btn');
        if (seeMoreBtn) {
            // Route events through the central handler to manage activation limits.
            seeMoreBtn.addEventListener('mousedown', (e) => handleActivate(e, () => this._showFullOverview()));
            seeMoreBtn.addEventListener('click', (e) => handleActivate(e, () => this._showFullOverview()));
        }
    }

    async _loadDetails() {
        this.setLoading(true);
        this._hasEnteredEpisodesGrid = false;

        try {
            // ────────────────────────────────────────────────────────────────────────
            // 2. Fetch Base Item Details
            // ────────────────────────────────────────────────────────────────────────
            // Backward-compatible custom metadata selector options.
            // Check the new pref:richMetadataStyle select preference, fallback cleanly to standard hideRichMetadata.
            // Under HIG Guidelines, this guarantees lightweight layouts on spatial networks.
            const richMetadataStyle =
                storage.getItem('pref:richMetadataStyle') ||
                (storage.getItem('pref:hideRichMetadata') === 'true' ? 'none' : 'all');
            const hideRich = richMetadataStyle === 'none';
            const hideCast = storage.getItem('pref:hideCastSection') === 'true';

            // Build dynamic fields list based on user preferences to save bandwidth/CPU
            const requestedFields = [
                'MediaStreams',
                'MediaSources',
                'Overview',
                'LibraryId',
                'CanDelete',
                'Width',
                'Height',
                'CameraMake',
                'CameraModel',
                'ExposureTime',
                'FocalLength',
                'Aperture',
                'Altitude',
                'DateCreated',
                'PremiereDate'
            ];

            if (!hideRich) {
                // Genres are always loaded if not hidden.
                requestedFields.push('Genres', 'GenreItems');

                // Studios are required for 'all' or 'genres-studios-writers'.
                if (richMetadataStyle === 'all' || richMetadataStyle === 'genres-studios-writers') {
                    requestedFields.push('Studios');
                }

                // Tags are only required when showing full metadata.
                if (richMetadataStyle === 'all') {
                    requestedFields.push('Tags');
                }

                // Directors and Writers come from the 'People' collection in Jellyfin.
                // If they are requested via the rich metadata dropdown, ensure we include 'People' even if the cast section is hidden.
                if (
                    richMetadataStyle === 'all' ||
                    richMetadataStyle === 'genres-studios-writers' ||
                    richMetadataStyle === 'genres-writers'
                ) {
                    requestedFields.push('People');
                }
            }

            if (!hideCast) {
                // Ensure People is loaded for cast display (avoid duplicates using unique tracking or simple array inclusion check)
                if (!requestedFields.includes('People')) {
                    requestedFields.push('People');
                }
            }

            // Fire user fetch in parallel with item fetch — they're independent.
            // The user object is only needed for the context menu (admin checks),
            // not for the initial render, so it does not block text/poster display.
            const userPromise = state.get('user:data') ? Promise.resolve(state.get('user:data')) : api.getCurrentUser();

            const item = await api.getItem(this._itemId, {
                // We request comprehensive fields to avoid redundant refetching.
                // CanDelete is essential for implementing the 'Delete Media' feature.
                // MediaSources must be explicitly requested to guarantee MediaStreams logic works reliably.
                // We also request Photo EXIF fields so they are available immediately.
                Fields: requestedFields.join(',')
            });
            this._item = item;

            // 2. Render all text content immediately — only needs this._item
            this._renderHeroText();
            this._setupFavoriteButton();
            this._renderRichMetadata();
            this._updateTrailerButton();

            // ── Restore persisted version selection ─────────────────────────────────
            const savedSourceId = storage.getItem(`mediaSource:${this._itemId}`);
            if (savedSourceId && item.MediaSources?.some((m) => m.Id === savedSourceId)) {
                this._selectedMediaSourceId = savedSourceId;
            } else {
                this._selectedMediaSourceId = null;
            }

            this._selectedAudioIndex = undefined;
            this._selectedSubtitleIndex = undefined;

            // Await user data (likely already resolved from state cache)
            this._currentUser = await userPromise;

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

            if (this._item.Type === 'Movie' || this._item.Type === 'Series') {
                loadTasks.push(this._loadItemCollections());
            }

            await Promise.all(loadTasks);

            // Trigger theme song background audio if user has activated it in display settings
            if (storage.getItem('pref:playThemeSongs') === 'true') {
                void this._playThemeSong();
            }

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

                // 6. NOW hide loading — page is scrolled and focused correctly
                this.setLoading(false);
            });
        } catch (error) {
            log.error('Failed to load', error);
            this.showError(i18n.t('FailedToLoadDetails'));
            this.setLoading(false);
        }
    }

    _showVersionSelectionMenu() {
        if (!this._item?.MediaSources || this._item.MediaSources.length <= 1) return;

        // Map MediaSources to a format compatible with _renderTrackSelectionMenu
        const sources = this._item.MediaSources.map((s) => ({
            ...s,
            Index: s.Id, // We use the ID as the index for selection
            DisplayTitle: s.Name || i18n.t('Version') || 'Version'
        }));

        const currentId = this._selectedMediaSourceId || this._item.MediaSources[0].Id;

        this._renderTrackSelectionMenu(i18n.t('SelectVersion'), sources, currentId, (id) => {
            if (this._selectedMediaSourceId === id) return;

            this._selectedMediaSourceId = id;
            log.info('Selected Media Source ID:', id);

            // Persist the selection so it survives back-navigation and re-visits
            storage.setItem(`mediaSource:${this._itemId}`, id);

            // Reset track selections when version changes as they are source-specific
            this._selectedAudioIndex = undefined;
            this._selectedSubtitleIndex = undefined;
        });
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
            if (
                item.Type === 'MusicAlbum' ||
                item.Type === 'MusicArtist' ||
                item.Type === 'Audio' ||
                item.Type === 'TvChannel'
            )
                posterType = 'square';

            // Apply class for CSS aspect ratio
            posterContainer.classList.remove('landscape', 'square');
            if (posterType !== 'poster') {
                posterContainer.classList.add(posterType);
            }

            if (item.ImageTags && item.ImageTags.Primary) {
                const params = imageService.getParams('details-poster');
                const posterUrl = api.getImageUrl(item.Id, 'Primary', {
                    maxWidth: params.maxWidth,
                    quality: params.quality
                });

                // Resolve Poster BlurHash
                const isBlurHashDisabled = storage.getItem('litefin:disableBlurhash') === 'true';
                let posterBlurHash = '';
                if (!isBlurHashDisabled && item.ImageBlurHashes?.Primary) {
                    const keys = Object.keys(item.ImageBlurHashes.Primary);
                    if (keys.length > 0) {
                        posterBlurHash = item.ImageBlurHashes.Primary[keys[0]];
                    }
                }

                // Render dynamic BlurHash canvas placeholder
                let posterCanvas = null;
                if (posterBlurHash) {
                    posterCanvas = document.createElement('canvas');
                    posterCanvas.className = 'blurhash-canvas poster-blurhash';
                    posterCanvas.style.position = 'absolute';
                    posterCanvas.style.top = '0';
                    posterCanvas.style.left = '0';
                    posterCanvas.style.width = '100%';
                    posterCanvas.style.height = '100%';
                    posterCanvas.style.objectFit = 'cover';
                    posterCanvas.style.zIndex = '0';
                    posterCanvas.style.transition = 'opacity 250ms ease-out';
                    posterCanvas.style.pointerEvents = 'none';
                    posterCanvas.style.opacity = '1';

                    posterContainer.appendChild(posterCanvas);

                    // Decode at a lightweight size asynchronously
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
                    // Fade out and remove canvas when image loads
                    if (posterCanvas) {
                        posterCanvas.style.opacity = '0';
                        setTimeout(() => {
                            if (posterCanvas && posterCanvas.parentNode) {
                                posterCanvas.parentNode.removeChild(posterCanvas);
                            }
                        }, 250);
                    }
                    onPosterReady();
                };
                img.onerror = () => {
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
            const params = imageService.getParams('details-backdrop');
            const backdropUrl = BackdropManager.getBackdropUrl(item, {
                maxWidth: params.maxWidth,
                quality: params.quality
            });

            // Resolve Backdrop BlurHash
            let backdropBlurHash = '';
            if (item.ImageBlurHashes?.Backdrop) {
                const keys = Object.keys(item.ImageBlurHashes.Backdrop);
                if (keys.length > 0) {
                    backdropBlurHash = item.ImageBlurHashes.Backdrop[keys[0]];
                }
            }

            if (backdropUrl) {
                BackdropManager.applyBackdrop(this.$('#backdrop'), backdropUrl, backdropBlurHash);
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
            const hideCast = storage.getItem('pref:hideCastSection') === 'true';
            const loads = [this._loadMoreFromSeason()];
            if (!hideCast) {
                loads.push(this._loadGuestStars());
            } else {
                // Ensure section is hidden if guest stars are skipped
                const guestStarsSection = this.$('#guest-stars-section');
                if (guestStarsSection) guestStarsSection.classList.add('hidden');
            }
            await Promise.all(loads);
        } else if (this._item.Type === 'BoxSet') {
            await this._loadCollectionItems();
        } else if (this._item.Type === 'MusicAlbum') {
            await this._loadAlbumSongs();
        } else if (this._item.Type === 'Playlist') {
            // Playlist: load the server-ordered item list using the dedicated endpoint
            await this._loadPlaylistItems();
        }

        // Render people if available
        this._people = this._item.People || [];
        const hideCast = storage.getItem('pref:hideCastSection') === 'true';
        if (this._people.length > 0 && !hideCast) {
            this._renderPeople();
        } else if (hideCast) {
            const peopleSection = this.$('#people-section');
            if (peopleSection) peopleSection.classList.add('hidden');
        }

        // Special Features
        if (['Movie', 'Series', 'Season', 'Episode', 'Trailer', 'MusicVideo'].includes(this._item.Type)) {
            await this._loadSpecialFeatures();
        }

        // Load Artists (Music/Albums)
        await this._loadArtists();

        // Already loaded via conditional above if MusicAlbum,
        // but this ensures fallback or shared logic consistency
        // await this._loadAlbumSongs();

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

    async _loadAlbumSongs() {
        if (this._item.Type !== 'MusicAlbum') return;

        try {
            const response = await api.getItems({
                ParentId: this._itemId,
                IncludeItemTypes: 'Audio',
                Recursive: true,
                Fields: 'PrimaryImageAspectRatio,UserData,RunTimeTicks',
                SortBy: 'ParentIndexNumber,IndexNumber,SortName'
            });

            const songs = response.Items || [];
            if (songs.length > 0) {
                this._renderAlbumSongs(songs);
            }
        } catch (error) {
            log.warn('Failed to load album songs', error);
        }
    }

    /**
     * Fetch all items inside a Jellyfin Playlist using the dedicated endpoint.
     * Unlike generic getItems(), /Playlists/{id}/Items respects the user's
     * defined ordering and returns PlaylistItemId per entry for SyncPlay.
     */
    async _loadPlaylistItems() {
        try {
            const response = await api.getPlaylistItems(this._itemId);
            this._playlistItems = response?.Items || [];

            if (this._playlistItems.length > 0) {
                this._renderPlaylistItems();
            }
        } catch (error) {
            log.warn('Failed to load playlist items', error);
        }
    }

    /**
     * Render playlist items using a landscape MediaGrid.
     *
     * Playlists can contain mixed media (movies, episodes, music videos,
     * audio) so we use 'thumb' landscape cards — they work uniformly
     * regardless of what content type each item is, mirroring how
     * jellyfin-web renders playlists as a vertical thumb list.
     *
     * The section title is updated with the item count so users know
     * how long the playlist is at a glance.
     */
    _renderPlaylistItems() {
        const container = this.$('#playlist-items-list');
        const section = this.$('#playlist-items-section');
        if (!section || !container || !this._playlistItems?.length) return;

        // Reveal the section
        section.classList.remove('hidden');

        // Update the section header with item count so the user can see
        // how many entries are in the playlist without scrolling
        const titleEl = this.$('#playlist-items-title');
        if (titleEl) {
            const count = this._playlistItems.length;
            titleEl.textContent =
                count === 1
                    ? i18n.t('ItemCountSingle') || '1 Item'
                    : i18n.t('ItemCountValue', [count]) || `${count} Items`;
        }

        // Build the landscape grid — each card navigates to its own details page
        this._playlistGrid = new MediaGrid({
            id: 'playlist-items-grid',
            items: this._playlistItems,
            type: 'thumb', // Landscape thumb aspect ratio
            contextType: 'library',
            limit: 1000,
            isLandscape: true, // Landscape layout for mixed content
            onClick: (card) => {
                // Save focus context so Back navigation returns to the same card
                const stateKey = `details:lastFocusedItem:${this._itemId}`;
                if (card.dataset.itemId) {
                    if (storage.getItem('pref:disableFocusRestore') !== 'true') {
                        state.set(stateKey, {
                            itemId: card.dataset.itemId,
                            sectionId: 'details-playlist-items'
                        });
                    }
                    router.navigate(`/details/${card.dataset.itemId}`);
                }
            }
        });

        container.innerHTML = this._playlistGrid.render();
        this._playlistGrid.onMounted();

        // Register focus section using the same grid pattern as the Season episode grid
        const upwardLink = this._getPreviousVisibleSection('details-playlist-items')?.targetName || 'details-actions';
        const nextSection = this._getNextVisibleSection('details-playlist-items');
        const leaveDownTarget = nextSection ? nextSection.targetName : null;

        this.registerFocusSection('details-playlist-items', container, {
            orientation: 'grid',
            leaveUp: upwardLink,
            leaveDown: leaveDownTarget,
            leaveLeft: 'sidebar',
            onEnter: () => {
                // First entry only: land on the very first card.
                // After that, FocusManager uses spatial memory.
                if (!this._hasEnteredPlaylistGrid) {
                    this._hasEnteredPlaylistGrid = true;
                    return container.querySelector('.media-card');
                }
                return null;
            }
        });

        this._updateLeaveDown(upwardLink, 'details-playlist-items');
    }

    _renderAlbumSongs(songs) {
        const container = this.$('#songs-list');
        const section = this.$('#songs-section');
        if (!section || !container) return;

        section.classList.remove('hidden');

        this._songsGrid = new MediaGrid({
            id: 'album-songs-grid',
            items: songs,
            type: 'square', // Square posters as requested
            contextType: 'library',
            limit: 60,
            moreUrl: `/library/all?parentId=${this._itemId}&includeItemTypes=Audio`,
            isLandscape: false, // Not landscape
            onClick: (card) => {
                const stateKey = `details:lastFocusedItem:${this._itemId}`;
                if (card.dataset.itemId) {
                    if (storage.getItem('pref:disableFocusRestore') !== 'true') {
                        state.set(stateKey, {
                            itemId: card.dataset.itemId,
                            sectionId: 'details-songs'
                        });
                    }
                    // Start playback directly for songs?
                    // Or navigate to song details?
                    // Jellyfin usually plays. Litefin usually navigates.
                    router.navigate(`/details/${card.dataset.itemId}`);
                }
            }
        });

        container.innerHTML = this._songsGrid.render();
        this._songsGrid.onMounted();

        // Register focus section
        const upwardLink = this._getPreviousVisibleSection('details-songs')?.targetName || 'details-actions';
        const nextSection = this._getNextVisibleSection('details-songs');
        const leaveDownTarget = nextSection ? nextSection.targetName : null;

        this.registerFocusSection('details-songs', container, {
            orientation: 'grid',
            leaveUp: upwardLink,
            leaveDown: leaveDownTarget,
            leaveLeft: 'sidebar'
        });

        this._updateLeaveDown(upwardLink, 'details-songs');
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
            'details-playlist-items', // Playlist items grid (Playlist type)
            'details-next-up',
            'details-seasons',
            'details-episodes',
            'details-songs',
            'more-from-season-section',
            'details-people',
            'details-special-features',
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
        log.info('Loading collection items for:', this._itemId);

        // Determine sort order
        // Jellyfin DisplayOrder settings: Default, SortName, PremiereDate
        // User wants default for collections in Litefin to be PremiereDate (Release Date)
        let sortBy = 'PremiereDate';
        if (this._item?.DisplayOrder === 'SortName') {
            sortBy = 'SortName';
        } else if (this._item?.DisplayOrder === 'Default') {
            sortBy = 'DateModified';
        } else if (this._item?.DisplayOrder === 'PremiereDate') {
            sortBy = 'PremiereDate';
        }

        try {
            const [movies, shows] = await Promise.all([
                api.getItems({
                    ParentId: this._itemId,
                    IncludeItemTypes: 'Movie',
                    Recursive: true,
                    Fields: 'PrimaryImageAspectRatio,ProductionYear',
                    SortBy: sortBy,
                    SortOrder: 'Ascending',
                    Limit: 100 // Increased limit to capture larger collections
                }),
                api.getItems({
                    ParentId: this._itemId,
                    IncludeItemTypes: 'Series',
                    Recursive: true,
                    Fields: 'PrimaryImageAspectRatio,ProductionYear',
                    SortBy: sortBy,
                    SortOrder: 'Ascending',
                    Limit: 100
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
            onClick,
            currentIndex
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
            renderCard: renderCard,
            currentIndex: currentIndex
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
                // -------------------------------------------------------------
                // Block navigation events if the clicked card is unpressable
                // (e.g. the active current episode card in siblings row).
                // -------------------------------------------------------------
                if (card.classList.contains('unpressable')) {
                    e.preventDefault();
                    e.stopPropagation();
                    return;
                }

                // Save clicked item for exact focus restoration, scoped by current page item ID
                // to prevent child DetailsPages from consuming parent state
                const stateKey = `details:lastFocusedItem:${this._itemId}`;
                if (card.dataset.itemId) {
                    if (storage.getItem('pref:disableFocusRestore') !== 'true') {
                        state.set(stateKey, {
                            itemId: card.dataset.itemId,
                            sectionId: focusSectionName
                        });
                    }
                } else if (card.dataset.id) {
                    // Fallback for some cards that might use data-id
                    if (storage.getItem('pref:disableFocusRestore') !== 'true') {
                        state.set(stateKey, {
                            itemId: card.dataset.id,
                            sectionId: focusSectionName
                        });
                    }
                }

                if (onClick) {
                    onClick(card);
                } else if (card.dataset.itemId) {
                    // Special handling for Persons and Artists: navigate to the unified PersonPage
                    const itemType = card.dataset.type;
                    if (
                        itemType === 'Person' ||
                        itemType === 'MusicArtist' ||
                        itemType === 'Artist' ||
                        itemType === 'AlbumArtist'
                    ) {
                        log.info('Navigating to PersonPage:', card.dataset.itemId);
                        router.navigate(`/person/${card.dataset.itemId}`);
                    } else {
                        log.info('Navigating to item details:', card.dataset.itemId);
                        router.navigate(`/details/${card.dataset.itemId}`);
                    }
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
        // Retrieve setting to customize rich metadata fields display.
        // Falls back to backward-compatible hideRichMetadata if new setting is not set.
        const richMetadataStyle =
            storage.getItem('pref:richMetadataStyle') ||
            (storage.getItem('pref:hideRichMetadata') === 'true' ? 'none' : 'all');
        const isHidden = richMetadataStyle === 'none';
        let container = this.$('#rich-meta');
        const containerWrapper = this.$('#rich-meta-container');

        if (isHidden) {
            if (container) container.innerHTML = '';
            if (containerWrapper) containerWrapper.classList.add('hidden');
            return;
        }

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

        // Directors (only shown in 'all')
        if (richMetadataStyle === 'all') {
            const directors = (item.People || []).filter((p) => p.Type === 'Director');
            if (directors.length > 0) {
                htmlParts.push(createRow('Directors', directors));
            }
        }

        // Writers (shown in 'all', 'genres-studios-writers', or 'genres-writers')
        if (
            richMetadataStyle === 'all' ||
            richMetadataStyle === 'genres-studios-writers' ||
            richMetadataStyle === 'genres-writers'
        ) {
            const writers = (item.People || []).filter((p) => p.Type === 'Writer');
            if (writers.length > 0) {
                htmlParts.push(createRow('Writers', writers));
            }
        }

        // Studios (shown in 'all' or 'genres-studios-writers')
        if (richMetadataStyle === 'all' || richMetadataStyle === 'genres-studios-writers') {
            if (item.Studios && item.Studios.length > 0) {
                htmlParts.push(createRow('Studios', item.Studios));
            }
        }

        // Tags (only shown in 'all')
        if (richMetadataStyle === 'all') {
            if (item.Tags && item.Tags.length > 0) {
                htmlParts.push(createRow('Tags', item.Tags));
            }
        }

        // Photo EXIF Data (only shown in 'all')
        if (item.Type === 'Photo' && richMetadataStyle === 'all') {
            const createTextRow = (label, value) => {
                if (!value) return '';
                return `
                    <div class="rich-meta-row">
                        <div class="meta-label">${label}</div>
                        <div class="meta-value-text">${value}</div>
                    </div>
                `;
            };

            const esc = (str) =>
                String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

            let dateStr = '';
            if (item.DateCreated) {
                try {
                    dateStr = new Date(item.DateCreated).toLocaleDateString();
                } catch (_) {
                    dateStr = item.DateCreated;
                }
            } else if (item.ProductionYear) {
                dateStr = String(item.ProductionYear);
            }

            const camera = [item.CameraMake, item.CameraModel].filter(Boolean).join(' ');
            const aperture = item.Aperture ? `f/${item.Aperture}` : null;
            let exposure = null;
            if (item.ExposureTime) {
                exposure =
                    item.ExposureTime < 1 ? `1/${Math.round(1 / item.ExposureTime)} s` : `${item.ExposureTime} s`;
            }
            const focal = item.FocalLength ? `${item.FocalLength} mm` : null;
            const altitude = item.Altitude != null ? `${Math.round(item.Altitude)} m` : null;

            htmlParts.push(createTextRow(i18n.t('ExifDate') || 'Date', esc(dateStr)));
            htmlParts.push(createTextRow(i18n.t('ExifCamera') || 'Camera', esc(camera)));
            htmlParts.push(createTextRow(i18n.t('ExifAperture') || 'Aperture', aperture));
            htmlParts.push(createTextRow(i18n.t('ExifExposure') || 'Exposure', exposure));
            htmlParts.push(createTextRow(i18n.t('ExifFocalLength') || 'Focal Length', focal));
            htmlParts.push(createTextRow(i18n.t('ExifAltitude') || 'Altitude', altitude));
        }

        container = this.$('#rich-meta');
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
            const params = imageService.getParams('details-logo');
            let titleStyle = storage.getItem('pref:detailsTitleStyle') || 'both';
            const detailsLayout = storage.getItem('pref:detailsLayout') || 'posterLeft';
            if (detailsLayout === 'backdropMinimal' || detailsLayout === 'backdropLeft') {
                titleStyle = 'logo-only';
            }
            const isLogoOnly = titleStyle === 'logo-only';
            let baseWidth = isLogoOnly ? 360 : 280;
            let baseHeight = isLogoOnly ? 140 : 100;
            if (detailsLayout === 'backdropMinimal' || detailsLayout === 'backdropLeft') {
                baseWidth = 540;
                baseHeight = 220;
            }
            const dpr = window.devicePixelRatio || 1;

            const logoUrl = api.getImageUrl(logoItemId, 'Logo', {
                fillWidth: Math.round(baseWidth * dpr),
                fillHeight: Math.round(baseHeight * dpr),
                quality: params.quality,
                tag: logoTag
            });
            const img = new Image();
            if (item.Type === 'Season' || item.Type === 'Episode') {
                const targetId = item.SeriesId;
                if (targetId) {
                    img.classList.add('clickable-logo');
                    img.onclick = (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        log.info('Logo clicked, navigating to series details:', targetId);
                        router.navigate(`/details/${targetId}`);
                    };
                }
            }

            img.onload = () => {
                const logoContainer = this.$('#details-logo');
                if (logoContainer) {
                    // =========================================================================
                    // Dynamic Visual Weight Adaptation (Sleek Proportional Spacing)
                    // =========================================================================
                    // Calculate the natural aspect ratio of the loaded logo image.
                    // By dividing the max width by the aspect ratio, we find the target height.
                    // We cap the height dynamically to keep the layout visually balanced:
                    // - Tall/square logos get more height (up to 140px) to remain legible.
                    // - Wide/short logos shrink in container height to eliminate top whitespace.
                    // =========================================================================
                    const aspect = img.naturalWidth / img.naturalHeight || 1;
                    let maxW = isLogoOnly ? 360 : 280;
                    let minHeight = isLogoOnly ? 60 : 50;
                    let maxHeight = isLogoOnly ? 140 : 100;
                    if (detailsLayout === 'backdropMinimal' || detailsLayout === 'backdropLeft') {
                        maxW = 540;
                        minHeight = 100;
                        maxHeight = 220;
                    }
                    const targetHeight = maxW / aspect;
                    const containerHeight = Math.min(maxHeight, Math.max(minHeight, Math.round(targetHeight)));

                    // Apply the computed height dynamically
                    logoContainer.style.height = `${containerHeight}px`;

                    logoContainer.innerHTML = '';
                    logoContainer.appendChild(img);
                    img.classList.add('loaded');
                }
            };
            img.src = logoUrl;
            // img.alt = item.Name + " Logo"; // Alt might show if transparent PNG fails?
        }
    }

    /**
     * ========================================================================
     * Background Theme Song Loader and Player
     * ========================================================================
     * Dynamically queries the theme media associated with the active item.
     * If a theme song is available, compiles the stream source URL and initiates
     * background score looping via ThemeSongPlayer.
     */
    async _playThemeSong() {
        // Assert that the loaded item supports theme media playback
        if (!['Series', 'Season', 'Episode'].includes(this._item.Type)) {
            return;
        }

        try {
            log.info('Fetching theme media details for item ID', this._itemId);
            // Fetch list of theme media options from Jellyfin
            const themeMedia = await api.getThemeMedia(this._itemId);

            // ----------------------------------------------------------------
            // Safety Guard: Avoid async race conditions.
            // If the user navigated away from the details page before the
            // network fetch returned, playing the audio now would create a
            // "ghost" track playing forever. Abort immediately.
            // ----------------------------------------------------------------
            if (this._isDestroyed) {
                log.warn('Theme media API request resolved after page destroy; aborting playback');
                return;
            }

            // Check if any theme songs were successfully retrieved
            if (themeMedia && themeMedia.ThemeSongsResult?.Items?.length > 0) {
                const song = themeMedia.ThemeSongsResult.Items[0];

                // Compile authenticated direct stream URL
                const streamUrl = api.getAudioStreamUrl(song.Id);

                // Leverage the show owner ID to sustain music across dynamic parent navigations
                const ownerId = themeMedia.ThemeSongsResult.OwnerId;

                log.debug('Initiating background theme playback:', song.Name);
                // Dispatch play command to the global background manager
                themeSongPlayer.play(streamUrl, ownerId);
            }
        } catch (error) {
            log.error('Failed to query or play theme media score:', error);
        }
    }

    _renderHeroText() {
        const item = this._item;

        // Build meta items (Year, Runtime, Ratings)
        const year = item.ProductionYear || '';

        let runtimeText = '';
        let endsAtText = '';

        if (item.Type === 'Photo') {
            if (item.Width && item.Height) {
                runtimeText = `${item.Width} × ${item.Height}`;
            }
        } else if (item.RunTimeTicks) {
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
        const starRating =
            item.CommunityRating && shouldShowScore(item)
                ? `${detailsIcons.ratingStar}${item.CommunityRating.toFixed(1)}`
                : '';
        const criticRating = item.CriticRating && shouldShowScore(item) ? `🍅 ${item.CriticRating}` : '';

        let metaHtml = '';
        if (year) metaHtml += `<span class="meta-item">${year}</span>`;
        if (runtimeText) metaHtml += `<span class="meta-item">${runtimeText}</span>`;
        if (rating) metaHtml += `<span class="meta-item meta-badge">${rating}</span>`;
        if (starRating) metaHtml += `<span class="meta-item meta-star">${starRating}</span>`;
        if (criticRating) metaHtml += `<span class="meta-item meta-tomato">${criticRating}</span>`;
        if (endsAtText) metaHtml += `<span class="meta-item meta-ends-at">${endsAtText}</span>`;

        // --- Added & Aired Dates ---
        // Conditionally render library metadata based on global user preferences.
        let addedHtml = '';
        if (storage.getItem('pref:showAddedDate') === 'true' && item.DateCreated) {
            addedHtml = `<span class="meta-item meta-item-dates">${i18n.t('Added')}: ${formatDate(item.DateCreated)}</span>`;
        }

        let airedHtml = '';
        if (storage.getItem('pref:showDateAired') === 'true' && item.PremiereDate) {
            airedHtml = `<span class="meta-item meta-item-dates">${i18n.t('Aired')}: ${formatDate(item.PremiereDate)}</span>`;
        }

        // Logic: If both are enabled and present, move them to a new row for better clarity.
        // Otherwise, append to the main row if only one exists.
        const bothEnabled =
            storage.getItem('pref:showAddedDate') === 'true' &&
            item.DateCreated &&
            storage.getItem('pref:showDateAired') === 'true' &&
            item.PremiereDate;

        let secondaryMetaRow = '';
        if (bothEnabled) {
            secondaryMetaRow = `<div class="details-meta-row">${addedHtml}${airedHtml}</div>`;
        } else {
            metaHtml += addedHtml + airedHtml;
        }
        let titleStyle = storage.getItem('pref:detailsTitleStyle') || 'both';
        const detailsLayout = storage.getItem('pref:detailsLayout') || 'posterLeft';
        if (detailsLayout === 'backdropMinimal' || detailsLayout === 'backdropLeft') {
            titleStyle = 'logo-only';
        }

        // Retrieve and check for logo references using Jellyfin image tags.
        // Determines if a localized image tag or series/parent image tag is available.
        const logoTag = item.ImageTags?.Logo || item.ParentLogoImageTag;
        const logoItemId = item.ImageTags?.Logo ? item.Id : item.ParentLogoItemId || item.SeriesId;
        const hasLogo = !!(logoItemId && logoTag);

        // Control flags for rendering logo and text title dynamically.
        let showLogo = false;
        let showTitle = true;
        let logoClass = 'details-logo';

        // Apply chosen Title Display Style preference with elegant fallbacks.
        if (titleStyle === 'text-only') {
            // Completely hide the logo and force text title display.
            showLogo = false;
            showTitle = true;
        } else if (titleStyle === 'logo-only' && hasLogo) {
            // Display only the logo icon and hide the text title.
            // Assign a completely separate details-title-logo CSS class.
            // This prevents inheriting any absolute alignment styling from details-logo.
            showLogo = true;
            showTitle = false;
            logoClass = 'details-title-logo';
        } else {
            // Default option ('both'): render both if a logo exists.
            // Fall back to this mode if 'logo-only' was chosen but no logo image exists for this item.
            showLogo = hasLogo;
            showTitle = true;
            logoClass = 'details-logo';
        }

        // Retrieve setting to hide the original language title on the details page.
        // It defaults to 'false' (off), so it's shown unless explicitly toggled to 'true'.
        const hideOriginalTitle = storage.getItem('pref:hideOriginalTitle') === 'true';

        const isSeason = item.Type === 'Season';
        const displayTitle = i18n.ensureBiDi(isSeason ? item.SeriesName || item.Name : item.Name);

        // Define display subtitle (original title) based on settings.
        // Season titles are unaffected; we only hide original titles for movies/shows when configured.
        const displaySubtitle = i18n.ensureBiDi(
            isSeason
                ? item.Name
                : !hideOriginalTitle && item.OriginalTitle && item.OriginalTitle !== item.Name
                  ? item.OriginalTitle
                  : ''
        );

        // Build the dynamic inner HTML for the hero-info block.
        let heroHtml = '';

        // If enabled, prepend the logo container div at the top of the header info.
        if (showLogo) {
            heroHtml += `<div id="details-logo" class="${logoClass}"></div>`;
        }

        // If enabled, append the h1 details title.
        if (showTitle) {
            // If there is no logo displayed, style the title to span the full width of the container.
            const titleStyleAttr = !showLogo ? 'style="max-width: 100%;"' : '';
            heroHtml += `<h1 class="details-title" ${titleStyleAttr}>${displayTitle}</h1>`;
        }

        // Add the subtitle element underneath if present.
        if (displaySubtitle && displaySubtitle !== displayTitle) {
            heroHtml += `<h2 class="details-original-title">${displaySubtitle}</h2>`;
        }

        // Render episode season/number details for TV episodes.
        if (item.Type === 'Episode') {
            // When in 'logo-only' mode with a logo, the main header visual is the Series Logo.
            // Since the text title (Episode Name) is hidden, we dynamically swap the subtitle
            // text from showing the Series Name to showing the Episode Name (item.Name).
            // Under any other mode (where text title is shown as the header), we keep
            // the classic 'SxxExx - Series Name' pattern.
            const showLogoAsTitle = titleStyle === 'logo-only' && hasLogo;

            // Format the episode identification string (SxxExx)
            const seasonPrefix = `S${(item.ParentIndexNumber || 0).toString().padStart(2, '0')}`;
            const episodePrefix = `E${(item.IndexNumber || 0).toString().padStart(2, '0')}`;

            // Construct the final display string based on layout preferences
            const subtitleText = showLogoAsTitle
                ? `${seasonPrefix}${episodePrefix} - ${item.Name}`
                : `${seasonPrefix}${episodePrefix} - ${item.SeriesName}`;

            const useSecondaryColor = storage.getItem('pref:secondaryTitleSecondaryColor') !== 'false';
            const colorClass = useSecondaryColor ? 'secondary-color' : '';

            heroHtml += `<p class="details-episode-info clickable-subtitle ${colorClass}" id="episode-subtitle-link">${i18n.ensureBiDi(subtitleText)}</p>`;
        }

        // Finish appending standard metadata row and secondary date labels.
        heroHtml += `
            <div class="details-meta-row">
                ${metaHtml}
            </div>
            ${secondaryMetaRow}
        `;

        this.$('#hero-info').innerHTML = heroHtml;

        // Bind clickable subtitle if present
        const subtitleLink = this.$('#episode-subtitle-link');
        if (subtitleLink && item.SeriesId) {
            subtitleLink.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                log.info('Navigating to series via subtitle link:', item.SeriesId);
                router.navigate(`/details/${item.SeriesId}`);
            };
        }

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
        }

        // Ghost Mode button visibility
        const ghostBtn = this.$('.ghost-btn');
        if (ghostBtn) {
            // Check if SyncPlay is currently active.
            const isSyncPlayActive = window.__syncPlayManager && window.__syncPlayManager.isEnabled;

            // Check if user has toggled the preference option to hide the button entirely.
            const isHiddenByPref = storage.getItem('pref:hideGhostMode') === 'true';

            // Determine playability (non-photos and not in sync play, and not hidden by user preference).
            const isPlayable = item.Type !== 'Photo' && !isSyncPlayActive && !isHiddenByPref;

            // Toggle visibility classes and keyboard accessibility index dynamically.
            if (isPlayable) {
                ghostBtn.classList.remove('hidden');
                ghostBtn.setAttribute('tabindex', '0');
            } else {
                ghostBtn.classList.add('hidden');
                ghostBtn.setAttribute('tabindex', '-1');
            }
        }

        // Photo overrides for Action Buttons
        if (item.Type === 'Photo') {
            if (playBtn) {
                const playIcon = detailsIcons.photo;
                playBtn.innerHTML = `${playIcon} <span>${i18n.t('ViewPhoto') || 'View Photo'}</span>`;
                playBtn.onclick = () => {
                    const parentId = this._item.LibraryId || this._item.ParentId || state.get('activeLibraryId') || '';
                    router.navigate(`/slideshow/${this._itemId}?parentId=${parentId}`);
                };
            }

            const audioBtn = this.$('.audio-btn');
            if (audioBtn) {
                audioBtn.classList.add('hidden');
                audioBtn.setAttribute('tabindex', '-1');
            }
            const subBtn = this.$('.subtitle-btn');
            if (subBtn) {
                subBtn.classList.add('hidden');
                subBtn.setAttribute('tabindex', '-1');
            }
        }

        // Upgrade to primary style
        resumeBtn.classList.remove('btn-secondary');
        resumeBtn.classList.add('btn-primary');

        // Retrieve the resume position from UserData playback position.
        // Convert playback ticks to total minutes. Note that 1 minute is equivalent to 600,000,000 ticks.
        const resumeTime = Math.round(userData.PlaybackPositionTicks / 600000000);

        // Define a variable to store our sleekly formatted timestamp string.
        let timeString = '';

        // Check if the user has watched past 59 minutes (i.e. at least 60 minutes).
        // If so, we format the time using a premium hour-and-minute pattern (e.g., "1h 15m").
        if (resumeTime >= 60) {
            // Compute the absolute number of whole hours.
            const hours = Math.floor(resumeTime / 60);
            // Calculate the remaining minutes left over.
            const minutes = resumeTime % 60;

            // Format the string elegantly. If there are no remaining minutes (e.g. exactly 1 hour),
            // show only the hour to maintain a clean and beautiful minimal aesthetic.
            timeString = minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
        } else {
            // Under 60 minutes, display in simple minute format (e.g., "45m").
            timeString = `${resumeTime}m`;
        }

        // Apply localization to the formatted time label to construct the full button label text.
        const resumeLabel = i18n.t('ResumeAt', [timeString]);

        // Update the inner HTML of the resume button with a play icon and the formatted label.
        resumeBtn.innerHTML = `${detailsIcons.play} <span>${resumeLabel}</span>`;

        // CRITICAL: If we hid the Play button (which probably had focus or would get it),
        // we must manually force focus to the Resume button so focus isn't lost.
        requestAnimationFrame(() => {});

        // Watched button
        if (watchedBtn) {
            if (userData.Played) {
                watchedBtn.classList.add('active');
                watchedBtn.innerHTML = detailsIcons.watchedFilled;
            } else {
                watchedBtn.classList.remove('active');
                watchedBtn.innerHTML = detailsIcons.watchedOutline;
            }
        }

        // Shuffle Button Visibility
        const shuffleBtn = this.$('.shuffle-btn');
        if (shuffleBtn) {
            // Playlists get shuffle too — they are inherently sequential,
            // and shuffle is a natural interaction users expect.
            const isShuffleable = ['Series', 'Season', 'BoxSet', 'Playlist'].includes(item.Type);
            if (item.Type === 'Photo') {
                shuffleBtn.classList.remove('hidden');
                shuffleBtn.setAttribute('tabindex', '0');
                shuffleBtn.setAttribute('aria-label', i18n.t('Slideshow') || 'Slideshow');
                const playIcon = detailsIcons.playLarge;
                shuffleBtn.innerHTML = playIcon;
                shuffleBtn.onclick = () => {
                    // Slideshow auto-starts via query param if we wanted, but right now SlideshowPage
                    // doesn't have an auto start param, user can press play themselves. Thus we just open it.
                    // Wait, we can pass autoPlay=true!
                    const parentId = this._item.LibraryId || this._item.ParentId || state.get('activeLibraryId') || '';
                    router.navigate(`/slideshow/${this._itemId}?parentId=${parentId}&autoPlay=true`);
                };
            } else if (isShuffleable) {
                shuffleBtn.classList.remove('hidden');
                shuffleBtn.setAttribute('tabindex', '0');
            } else {
                shuffleBtn.classList.add('hidden');
                shuffleBtn.setAttribute('tabindex', '-1');
            }
        }

        // Subtitles & Audio Track Button Visibility
        const audioBtn = this.$('.audio-btn');
        const subtitleBtn = this.$('.subtitle-btn');
        const mediaStreams = item.MediaSources?.[0]?.MediaStreams || [];

        if (audioBtn) {
            // Only show audio tracks if there's at least one available to select
            if (mediaStreams.some((s) => s.Type === 'Audio')) {
                audioBtn.classList.remove('hidden');
                audioBtn.setAttribute('tabindex', '0');
            } else {
                audioBtn.classList.add('hidden');
                audioBtn.setAttribute('tabindex', '-1');
            }
        }

        if (subtitleBtn) {
            // =========================================================================
            // PGS Subtitle Filter Guard for Button Visibility
            //
            // We check if there are any available subtitle streams that are NOT disabled
            // PGS tracks. If PGS rendering is disabled completely in settings, PGS streams
            // should not count towards whether the subtitle button is visible. This avoids
            // showing an active subtitle button when the only subtitle tracks are PGS tracks
            // that the user has chosen to hide/disable completely.
            // =========================================================================
            const disablePgs = PlayerSettings.get('pgsPlaybackMode') === 'disable';
            const hasSelectableSubtitles = mediaStreams.some((s) => {
                // We only look at subtitle streams
                if (s.Type !== 'Subtitle') return false;

                // If PGS is disabled, skip PGS/PGSSUB codecs
                if (disablePgs) {
                    const codec = (s.Codec || '').toLowerCase();
                    if (codec === 'pgs' || codec === 'pgssub') {
                        return false;
                    }
                }
                return true;
            });

            // If there's at least one renderable subtitle stream, make the button visible
            if (hasSelectableSubtitles) {
                subtitleBtn.classList.remove('hidden');
                subtitleBtn.setAttribute('tabindex', '0');
            } else {
                // Otherwise, completely hide the subtitle button and remove from focus order
                subtitleBtn.classList.add('hidden');
                subtitleBtn.setAttribute('tabindex', '-1');
            }
        }

        // ── Playlist-specific overrides ──────────────────────────────────────────
        // A Playlist has no single MediaSource — audio stream and subtitle track
        // info live on each individual item, not on the container. Showing these
        // buttons would just open an empty menu, so we hide them.
        if (item.Type === 'Playlist') {
            if (audioBtn) {
                audioBtn.classList.add('hidden');
                audioBtn.setAttribute('tabindex', '-1');
            }
            if (subtitleBtn) {
                subtitleBtn.classList.add('hidden');
                subtitleBtn.setAttribute('tabindex', '-1');
            }
        }
    }

    async _loadNextUp() {
        try {
            let response;

            // Check if the current server is Emby. Emby ignores the SeriesId parameter
            // on the /Shows/NextUp endpoint, so we fall back to querying the first
            // unplayed episode of the series via /Items, which matches NextUp logic.
            if (api.isEmby()) {
                // Fetch the oldest unplayed episode of this series.
                response = await api.getItems({
                    ParentId: this._itemId,
                    Recursive: true,
                    IncludeItemTypes: 'Episode',
                    Limit: 1,
                    Filters: 'IsUnplayed',
                    SortBy: 'ParentIndexNumber,IndexNumber',
                    // Request all necessary fields for rendering the next up card.
                    Fields: 'PrimaryImageAspectRatio,BasicSyncInfo,SeriesThumbImageTag,ParentThumbImageTag,BackdropImageTags,ParentBackdropImageTags'
                });
            } else {
                // For Jellyfin, use the standard NextUp endpoint which filters by SeriesId correctly.
                response = await api.getNextUp({ SeriesId: this._itemId, Limit: 1 });
            }

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
            // Remove 'media-row' to prevent ScrollController from aggressively top-snapping this entire deep layout
            section.classList.remove('media-row');

            const episodeLayout = storage.getItem('pref:episodeLayout') || 'list';

            if (episodeLayout === 'list') {
                container.classList.add('vertical-list');

                // ====================================================================
                // Premium List with Details Layout
                // ====================================================================
                // Render episode cards in a clean, vertical scrollable column:
                // - Thumbnail on the left with a subtle rounded cover design and progress indicators.
                // - High-contrast text stack on the right: SxxExx index code, clear title,
                //   ratings & duration metadata row, and overview line clamping.
                // ====================================================================
                const limit = 30;
                const episodesToShow = this._episodes.slice(0, limit);
                const hasMore = this._episodes.length > limit;

                let html = '<div class="episode-list-container">';
                episodesToShow.forEach((ep) => {
                    const progress =
                        ep.UserData?.PlaybackPositionTicks && ep.RunTimeTicks
                            ? (ep.UserData.PlaybackPositionTicks / ep.RunTimeTicks) * 100
                            : 0;
                    const progressHtml =
                        progress > 0
                            ? `<div style="position: absolute; bottom: 0; left: 0; width: 100%; height: 6px; background-color: rgba(0,0,0,0.7); z-index: 100;"><div style="width: ${progress}%; height: 100%; background-color: var(--jf-accent);"></div></div>`
                            : '';

                    const imgUrl = api.getImageUrl(ep.Id, 'Primary', {
                        maxWidth: imageService.getParams('thumb').maxWidth,
                        quality: imageService.getParams('thumb').quality
                    });
                    const episodeCode = i18n.ensureBiDi(
                        `S${(ep.ParentIndexNumber || 0).toString().padStart(2, '0')}E${(ep.IndexNumber || 0).toString().padStart(2, '0')}`
                    );
                    const episodeTitle = i18n.ensureBiDi(ep.Name);

                    const rating = ep.CommunityRating ? `⭐ ${ep.CommunityRating.toFixed(1)}` : '';
                    let runtimeText = '';
                    if (ep.RunTimeTicks) {
                        const mins = Math.round(ep.RunTimeTicks / 600000000);
                        runtimeText = `${mins}m`;
                    }
                    let endsAtText = '';
                    if (ep.RunTimeTicks) {
                        const endTime = new Date(Date.now() + ep.RunTimeTicks / 10000);
                        const timeString = i18n.formatLocalTime(endTime);
                        endsAtText = i18n.t('EndsAtValue', [timeString]);
                    }

                    html += `
                        <div class="episode-row">
                            <button class="episode-row-card media-card" data-episode-id="${ep.Id}" data-item-id="${ep.Id}" tabindex="0">
                                <div class="episode-row-thumb">
                                    <img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" data-src="${imgUrl}" alt="" class="lazy">
                                    ${progressHtml}
                                </div>
                                <div class="episode-row-info">
                                    <div class="episode-row-title">${ep.IndexNumber || 0}. ${episodeTitle}</div>
                                    <div class="episode-row-meta">
                                        ${rating ? `<span class="episode-row-rating">${detailsIcons.ratingStar}${ep.CommunityRating.toFixed(1)}</span>` : ''}
                                        ${runtimeText ? `<span>${runtimeText}</span>` : ''}
                                        ${endsAtText ? `<span>${endsAtText}</span>` : ''}
                                    </div>
                                    <p class="episode-row-overview">${ep.Overview || ''}</p>
                                </div>
                            </button>
                        </div>
                    `;
                });

                if (hasMore) {
                    const moreUrl = `/library/all?parentId=${this._itemId}&includeItemTypes=Episode&viewModeIndex=2`;
                    html += `
                        <div class="episode-row">
                            <button class="episode-row-card media-card see-more-card" data-more-url="${moreUrl}" tabindex="0" style="justify-content: center; align-items: center; background: rgba(0, 0, 0, 0.5); border: 2px dashed rgba(255, 255, 255, 0.15);">
                                <span style="font-size: 1.4rem; font-weight: 600; color: var(--jf-text-secondary);">${i18n.t('ShowMore') || 'See More'}</span>
                            </button>
                        </div>
                    `;
                }

                html += '</div>';
                container.innerHTML = html;

                // Wire up click event delegation for navigating to details
                container.onclick = (e) => {
                    const card = e.target.closest('.media-card');
                    if (card) {
                        if (card.classList.contains('see-more-card')) {
                            router.navigate(card.dataset.moreUrl);
                            return;
                        }
                        const stateKey = `details:lastFocusedItem:${this._itemId}`;
                        if (card.dataset.itemId) {
                            if (storage.getItem('pref:disableFocusRestore') !== 'true') {
                                state.set(stateKey, {
                                    itemId: card.dataset.itemId,
                                    sectionId: 'details-episodes'
                                });
                            }
                            router.navigate(`/details/${card.dataset.itemId}`);
                        }
                    }
                };

                lazyLoader.observe(container);

                // Register vertical list navigation constraints
                const upwardLink = this._getPreviousVisibleSection('details-episodes')?.targetName || 'details-actions';
                const nextSection = this._getNextVisibleSection('details-episodes');
                const leaveDownTarget = nextSection ? nextSection.targetName : null;

                this.registerFocusSection('details-episodes', container, {
                    orientation: 'vertical',
                    leaveUp: upwardLink,
                    leaveDown: leaveDownTarget,
                    leaveLeft: 'sidebar',
                    onEnter: (fromElement, options) => {
                        if (!this._hasEnteredEpisodesGrid) {
                            this._hasEnteredEpisodesGrid = true;
                            return container.querySelector('.media-card');
                        }
                        return null;
                    }
                });

                this._updateLeaveDown(upwardLink, 'details-episodes');
            } else {
                container.classList.remove('vertical-list');
                // Use MediaGrid for a clean, generic 2D landscape episode layout
                this._episodeGrid = new MediaGrid({
                    id: 'season-episodes-grid',
                    items: this._episodes,
                    type: 'episode',
                    contextType: 'details',
                    limit: 60,
                    moreUrl: `/library/all?parentId=${this._itemId}&includeItemTypes=Episode&viewModeIndex=2`,
                    isLandscape: true,
                    onClick: (card) => {
                        const stateKey = `details:lastFocusedItem:${this._itemId}`;
                        if (card.dataset.itemId) {
                            if (storage.getItem('pref:disableFocusRestore') !== 'true') {
                                state.set(stateKey, {
                                    itemId: card.dataset.itemId,
                                    sectionId: 'details-episodes'
                                });
                            }
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
                        if (!this._hasEnteredEpisodesGrid) {
                            this._hasEnteredEpisodesGrid = true;
                            return container.querySelector('.media-card');
                        }
                        return null;
                    }
                });

                this._updateLeaveDown(upwardLink, 'details-episodes');
            }
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
                                ${progress > 0 ? `<div style="position: absolute; bottom: 0; left: 0; width: 100%; height: 6px; background-color: rgba(0,0,0,0.7); z-index: 100;"><div style="width: ${progress}%; height: 100%; background-color: var(--jf-accent);"></div></div>` : ''}
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

    async _loadSpecialFeatures() {
        try {
            const features = await api.getSpecialFeatures(this._itemId);
            this._specialFeatures = features || [];

            if (this._specialFeatures.length > 0) {
                this._renderSpecialFeatures();
            }
        } catch (error) {
            log.warn('Failed to load special features', error);
            const section = this.$('#special-features-section');
            if (section) section.classList.add('hidden');
        }
    }

    _renderSpecialFeatures() {
        if (!this._specialFeatures || this._specialFeatures.length === 0) return;

        this._renderVirtualRow({
            sectionId: 'special-features-section',
            listId: 'special-features-row',
            items: this._specialFeatures,
            isLandscape: true,
            renderCard: (item) => this._renderMediaCard(item, true, 'thumb'),
            focusSectionName: 'details-special-features'
        });
    }

    /**
     * Toggles the overview description layout between truncated and expanded states.
     */
    _showFullOverview() {
        // Fetch references to structural elements
        const overviewEl = this.$('.overview-text');
        const seeMoreBtn = this.$('.see-more-btn');
        if (!overviewEl || !seeMoreBtn) return;

        // Toggle lines clamp styling
        const isExpanded = !overviewEl.classList.contains('line-clamp-6');

        if (isExpanded) {
            // Apply line clamping to keep layout neat and clean
            overviewEl.classList.add('line-clamp-6');
            seeMoreBtn.textContent = i18n.t('ShowMore');
            this.el.scrollTop = 0; // Reset scroll view hierarchy
        } else {
            // Remove line clamping limits to reveal full description block
            overviewEl.classList.remove('line-clamp-6');
            seeMoreBtn.textContent = i18n.t('ShowLess');
        }

        // Direct focus manager to maintain focus on action button
        focusManager.focusElement(seeMoreBtn);
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
            // Playlist items — shown when the item is of Type 'Playlist'
            {
                name: 'details-playlist-items',
                elementId: '#playlist-items-list',
                isVisible: () => isNotHidden('#playlist-items-section')
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
                name: 'details-songs',
                elementId: '#songs-list',
                isVisible: () => isNotHidden('#songs-section')
            },
            {
                name: 'more-from-season-section',
                elementId: '#more-from-season-row',
                isVisible: () => isNotHidden('#more-from-season-section')
            },
            { name: 'details-people', elementId: '#people-row', isVisible: () => isNotHidden('#people-section') },
            {
                name: 'details-special-features',
                elementId: '#special-features-row',
                isVisible: () => isNotHidden('#special-features-section')
            },
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
            {
                name: 'details-item-collections',
                elementId: '#item-collections-row',
                isVisible: () => isNotHidden('#item-collections-section')
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
                name: 'details-item-collections',
                elementId: '#item-collections-row',
                isVisible: () => isNotHidden('#item-collections-section')
            },
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
            {
                name: 'details-special-features',
                elementId: '#special-features-row',
                isVisible: () => isNotHidden('#special-features-section')
            },
            { name: 'details-people', elementId: '#people-row', isVisible: () => isNotHidden('#people-section') },
            {
                name: 'more-from-season-section',
                elementId: '#more-from-season-row',
                isVisible: () => isNotHidden('#more-from-season-section')
            },
            {
                name: 'details-songs',
                elementId: '#songs-list',
                isVisible: () => isNotHidden('#songs-section')
            },
            {
                name: 'details-episodes',
                elementId: '#episodes-list',
                isVisible: () => isNotHidden('#episodes-section')
            },
            { name: 'details-seasons', elementId: '#seasons-row', isVisible: () => isNotHidden('#seasons-section') },
            { name: 'details-next-up', elementId: '#next-up-row', isVisible: () => isNotHidden('#next-up-section') },
            // Playlist items — reverse position mirrors _getNextVisibleSection
            {
                name: 'details-playlist-items',
                elementId: '#playlist-items-list',
                isVisible: () => isNotHidden('#playlist-items-section')
            },
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

            // -------------------------------------------------------------
            // Retrieve preference to determine if we include current episode.
            // Defaults to false.
            // -------------------------------------------------------------
            const includeCurrent = storage.getItem('pref:includeCurrentEpisodeInMoreFromSeason') === 'true';
            const allItems = response.Items || [];

            // Filter out current episode if preference is disabled, and slice limits to 24 for the row.
            const siblings = allItems.filter((ep) => includeCurrent || ep.Id !== this._itemId).slice(0, 24);

            if (siblings.length > 0) {
                // Find index of the current active episode in the siblings list
                const currentEpisodeIndex = siblings.findIndex((ep) => ep.Id === this._itemId);

                // Pass siblings and focused index down to renderer
                this._renderMoreFromSeason(siblings, currentEpisodeIndex !== -1 ? currentEpisodeIndex : 0);
            }
        } catch (error) {
            log.warn('Failed to load season episodes', error);
        }
    }

    _renderMoreFromSeason(episodes, currentEpisodeIndex = 0) {
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
            // -------------------------------------------------------------
            // Pass option down to CardRenderer indicating if this is the active episode details page
            // -------------------------------------------------------------
            renderCard: (ep) =>
                this._renderMediaCard(ep, true, 'episode', {
                    isCurrentEpisode: ep.Id === this._itemId
                }),
            focusSectionName: 'more-from-season-section',
            currentIndex: currentEpisodeIndex
        });
    }

    async _loadGuestStars() {
        // Guest stars are usually included in the episode's People array with Type 'GuestStar' or 'Guest'
        // or just 'Actor' but specific to the episode.
        // In many setups, if they aren't 'Director' or 'Writer' or 'Producer', they are actors.
        const guestStars = (this._item.People || []).filter((p) => p.Type === 'GuestStar' || p.Role === 'Guest Star');
        const hideCast = storage.getItem('pref:hideCastSection') === 'true';

        if (guestStars.length > 0 && !hideCast) {
            this._renderGuestStars(guestStars);
        } else if (hideCast) {
            const guestStarsSection = this.$('#guest-stars-section');
            if (guestStarsSection) guestStarsSection.classList.add('hidden');
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
        // -------------------------------------------------------------------------
        // Performance & Visibility Control Check
        // -------------------------------------------------------------------------
        // Check if the user has enabled the "Hide More Like This" appearance option.
        // By handling this check first, we can short-circuit the entire block,
        // preventing unnecessary network requests and API server load.
        const hideSimilar = storage.getItem('pref:hideSimilarSection') === 'true';

        if (hideSimilar) {
            // Find the container section in the DOM
            const similarSection = this.$('#similar-section');
            if (similarSection) {
                // Keep the section hidden to prevent empty layout gaps
                similarSection.classList.add('hidden');
            }
            // Exit early to completely avoid fetching metadata from the server
            return;
        }

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

        const useSquare =
            this._item.Type === 'MusicAlbum' || this._item.Type === 'Audio' || this._item.Type === 'TvChannel';

        this._renderVirtualRow({
            sectionId: 'similar-section',
            listId: 'similar-row',
            items: this._similar,
            isLandscape: false,
            renderCard: (item) => {
                return this._renderMediaCard(item, false, useSquare ? 'square' : 'poster');
            },
            focusSectionName: 'details-similar',
            cardType: useSquare ? 'square' : 'poster'
        });
    }

    async _loadItemCollections() {
        try {
            const cacheKey = `details:collections:${this._itemId}`;
            let collections = state.get(cacheKey);

            if (!collections) {
                const response = await api.getItemCollections(this._itemId, {
                    fields: 'PrimaryImageAspectRatio'
                });
                collections = response.Items || [];
                if (collections.length > 0) {
                    state.set(cacheKey, collections);
                }
            }

            this._itemCollections = collections;

            if (this._itemCollections.length > 0) {
                this._renderItemCollections();
            } else {
                const section = this.$('#item-collections-section');
                if (section) {
                    section.classList.add('hidden');
                }
            }
        } catch (error) {
            log.warn('Failed to load item collections', error);
            const section = this.$('#item-collections-section');
            if (section) {
                section.classList.add('hidden');
            }
        }
    }

    _renderItemCollections() {
        if (!this._itemCollections || this._itemCollections.length === 0) return;

        this._renderVirtualRow({
            sectionId: 'item-collections-section',
            listId: 'item-collections-row',
            items: this._itemCollections,
            isLandscape: false,
            renderCard: (item) => {
                return this._renderMediaCard(item, false, 'poster');
            },
            focusSectionName: 'details-item-collections',
            cardType: 'poster'
        });
    }

    async _play({ resume = false, isShufflePlay = false, ghostMode = false } = {}) {
        let itemToPlay = this._item;

        // If it's a Live TV Program, play the parent Channel instead
        if (this._item.Type === 'Program' && this._item.ChannelId) {
            log.info('Live TV Program detected. Playing parent Channel instead.');
            itemToPlay = {
                Id: this._item.ChannelId,
                Type: 'TvChannel',
                Name: this._item.ChannelName || this._item.Name
                // Pass along other context if needed, but Id and Type are the critical ones for PlayQueue
            };
        } else if (this._item.Type === 'BoxSet') {
            try {
                // Fetch first item in collection (recursive)
                // We prefer Movies over Episodes to match the visual row priority
                let sortBy = 'PremiereDate';
                if (this._item?.DisplayOrder === 'SortName') {
                    sortBy = 'SortName';
                } else if (this._item?.DisplayOrder === 'Default') {
                    sortBy = 'DateModified';
                } else if (this._item?.DisplayOrder === 'PremiereDate') {
                    sortBy = 'PremiereDate';
                }

                const sortParams = isShufflePlay ? { SortBy: 'Random' } : { SortBy: sortBy, SortOrder: 'Ascending' };
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

                // Attach context so PlayQueue knows this is a collection play.
                // We also pass the resolved sortBy so _initBoxSetQueue can order
                // the full queue the same way the display grid is ordered.
                itemToPlay.contextType = 'boxset';
                itemToPlay.contextId = this._item.Id;
                itemToPlay.boxsetSortBy = sortBy;
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
            } else {
                try {
                    const fields = 'PrimaryImageAspectRatio,BasicSyncInfo,Overview,RunTimeTicks,Chapters';
                    if (isShufflePlay) {
                        const randomEp = await api.getItems({
                            ParentId: this._item.Id,
                            Recursive: true,
                            IncludeItemTypes: 'Episode',
                            Limit: 1,
                            SortBy: 'Random',
                            Fields: fields
                        });
                        if (randomEp && randomEp.Items && randomEp.Items.length > 0) {
                            itemToPlay = randomEp.Items[0];
                        } else {
                            return;
                        }
                    } else {
                        const firstEp = await api.getItems({
                            ParentId: this._item.Id,
                            Recursive: true,
                            IncludeItemTypes: 'Episode',
                            Limit: 1,
                            SortBy: 'ParentIndexNumber,IndexNumber',
                            Fields: fields
                        });
                        if (firstEp && firstEp.Items && firstEp.Items.length > 0) {
                            itemToPlay = firstEp.Items[0];
                        } else {
                            return;
                        }
                    }
                } catch (e) {
                    log.error('Failed to resolve season fallback playback', e);
                    return;
                }
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
                        let nextUp;
                        if (api.isEmby()) {
                            // On Emby, /Shows/NextUp does not filter by SeriesId.
                            // We fetch the oldest unplayed episode of the series via /Items instead.
                            nextUp = await api.getItems({
                                ParentId: this._item.Id,
                                Recursive: true,
                                IncludeItemTypes: 'Episode',
                                Limit: 1,
                                Filters: 'IsUnplayed',
                                SortBy: 'ParentIndexNumber,IndexNumber',
                                Fields: 'PrimaryImageAspectRatio,BasicSyncInfo,SeriesThumbImageTag,ParentThumbImageTag,BackdropImageTags,ParentBackdropImageTags'
                            });
                        } else {
                            // On Jellyfin, query next up directly using SeriesId parameter.
                            nextUp = await api.getNextUp({ SeriesId: this._item.Id, Limit: 1 });
                        }

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

        // ── Playlist playback ────────────────────────────────────────────────
        // Playlists have no direct MediaSource, so we resolve the first item
        // (or a random one for shuffle) and hand contextType:'playlist' to the
        // PlayQueue so it fetches and sequences the entire list for auto-advance.
        if (this._item.Type === 'Playlist') {
            if (this._playlistItems?.length > 0) {
                // Use the already-fetched items (instant, no extra network round-trip)
                itemToPlay = isShufflePlay
                    ? this._playlistItems[Math.floor(Math.random() * this._playlistItems.length)]
                    : this._playlistItems[0];
            } else {
                // Items not yet loaded (user pressed Play before the grid rendered)
                try {
                    const result = await api.getPlaylistItems(this._item.Id, { Limit: 1 });
                    if (result?.Items?.length > 0) {
                        itemToPlay = result.Items[0];
                    } else {
                        log.warn('Playlist is empty, nothing to play');
                        return;
                    }
                } catch (e) {
                    log.error('Failed to resolve playlist playback item', e);
                    return;
                }
            }
            // Tag context so PlayQueue._initPlaylistQueue() builds the full ordered list
            itemToPlay.contextType = 'playlist';
            itemToPlay.contextId = this._item.Id;
        }

        // FORCE HIGH QUALITY for Player transition (must match _loadImages params)
        const backdropUrl = BackdropManager.getBackdropUrl(this._item, {
            maxWidth: 3840,
            quality: 90
        });

        eventBus.emit('player:play', {
            item: itemToPlay,
            resume: ghostMode ? false : resume,
            mediaSourceId: this._selectedMediaSourceId,
            audioStreamIndex: this._selectedAudioIndex,
            subtitleStreamIndex: this._selectedSubtitleIndex,
            backdropUrl,
            ghostMode
        });
    }

    _shufflePlay() {
        playQueue.setShuffleMode(true);
        this._play({ isShufflePlay: true });
    }

    _showAudioTrackMenu() {
        const mediaSource =
            this._item?.MediaSources?.find((m) => m.Id === this._selectedMediaSourceId) ||
            this._item?.MediaSources?.[0];
        if (!mediaSource?.MediaStreams) return;

        const key = 'Audio';
        const tracks = mediaSource.MediaStreams.filter((s) => s.Type === key);

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
        // Find the selected media source (or default to the first one)
        const mediaSource =
            this._item?.MediaSources?.find((m) => m.Id === this._selectedMediaSourceId) ||
            this._item?.MediaSources?.[0];
        // Guard check: Ensure media source streams exist
        if (!mediaSource?.MediaStreams) return;

        const key = 'Subtitle';

        // =========================================================================
        // PGS Subtitle Filter Guard
        //
        // If the user has disabled PGS rendering completely in settings ('disable'),
        // we want to exclude PGS tracks from the list of subtitle tracks that the
        // user can manually select in the details page subtitle menu.
        // =========================================================================
        const disablePgs = PlayerSettings.get('pgsPlaybackMode') === 'disable';
        const tracks = mediaSource.MediaStreams.filter((s) => {
            // Match subtitle type
            if (s.Type !== key) return false;

            // Skip disabled PGS tracks
            if (disablePgs) {
                const codec = (s.Codec || '').toLowerCase();
                if (codec === 'pgs' || codec === 'pgssub') {
                    return false;
                }
            }
            return true;
        });

        // Determine current track selection index
        let currentIndex = this._selectedSubtitleIndex;
        if (currentIndex === undefined) {
            // Fallback to server default track index
            currentIndex = mediaSource.DefaultSubtitleStreamIndex; // Can be -1/null
        }

        // Add "Off" option to the selection track list
        const displayTracks = [{ Index: -1, DisplayTitle: i18n.t('Off'), Title: i18n.t('Off') }, ...tracks];

        // Render the track selection menu modal on screen
        this._renderTrackSelectionMenu(i18n.t('Subtitles'), displayTracks, currentIndex, (index) => {
            // Guard check: If selection did not change, skip update
            if (this._selectedSubtitleIndex === index) return;

            // Update local selected index and log the choice
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

                // For version selection, add resolution metadata
                if (title === i18n.t('SelectVersion') && track.Id) {
                    const resolution = track.Height ? `${track.Height}p` : '';

                    if (resolution) {
                        metadataHtml = `
                            <span class="track-badge">${resolution}</span>
                        `;
                    }
                }

                return `
                <button class="modal-option-btn ${isSelected ? 'selected' : ''}" data-index="${track.Index}" tabindex="0">
                    <div class="check-icon">
                        ${detailsIcons.check}
                    </div>
                    <span class="track-option-label">
                        <span class="track-label-text">${label}</span>
                        ${metadataHtml}
                    </span>
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
                // data-index may be a numeric stream index OR a MediaSource GUID string.
                // parseInt on a GUID always returns NaN, so we use the raw string value
                // and only coerce to a number when it is actually numeric.
                const rawIndex = btn.dataset.index;
                const index = /^-?\d+$/.test(rawIndex) ? parseInt(rawIndex, 10) : rawIndex;
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

        const options = [];

        // Episode/Song Shortcuts: Parent Navigation (Should be the first option)
        if (this._item?.Type === 'Episode' && this._item.SeriesId) {
            options.push({ id: 'go-to-series', label: i18n.t('GoToSeries') });
        } else if (this._item?.Type === 'Audio' && this._item.AlbumId) {
            options.push({ id: 'go-to-album', label: i18n.t('GoToAlbum') });
        }

        if (this._item?.MediaSources?.length > 1) {
            options.push({ id: 'select-version', label: i18n.t('SelectVersion') });
        }

        if (this._item?.Type === 'BoxSet') {
            options.push({ id: 'display-order', label: i18n.t('LabelDisplayOrder') || 'Display order' });
        }

        if (this._item?.MediaSources?.length > 0) {
            options.push({ id: 'media-info', label: i18n.t('MoreMediaInfo') || 'Media Info' });
        }

        // ── Refresh Metadata Permission Check ────────────────────────────────
        // Following jellyfin-web logic: only administrators can refresh metadata
        if (this._currentUser?.Policy?.IsAdministrator) {
            const i = this._item;
            const invalidRefreshTypes = ['Timer', 'SeriesTimer', 'Program', 'TvChannel'];
            const isLiveTv = i.CollectionType === 'livetv';
            const isIncompleteRecording = i.Type === 'Recording' && i.Status !== 'Completed';

            if (!invalidRefreshTypes.includes(i.Type) && !isLiveTv && !isIncompleteRecording) {
                options.push({ id: 'refresh', label: i18n.t('RefreshMetadata') });
            }
        }

        // ── Subtitle Editing Permission Check ────────────────────────────────
        // Based on jellyfin-web canEditSubtitles logic
        if (this._item && this._currentUser) {
            const i = this._item;
            const p = this._currentUser.Policy || {};
            const isOffline = i.LocationType === 'Offline';
            const isVirtual = i.LocationType === 'Virtual';
            const invalidSubtitleTypes = ['TvChannel', 'Program', 'Timer', 'SeriesTimer', 'UserRootFolder', 'UserView'];

            if (i.MediaType === 'Video' && !isOffline && !isVirtual && !invalidSubtitleTypes.includes(i.Type)) {
                if (p.EnableSubtitleManagement || p.IsAdministrator) {
                    options.push({ id: 'edit-subtitles', label: i18n.t('EditSubtitles') || 'Edit Subtitles' });
                }
            }

            // ── Add to Playlist / Collection ────────────────────────────────────
            // Show for any media item that can be added to a group
            const nonPlayableTypes = ['Person', 'CollectionFolder', 'UserView', 'Folder', 'Genre', 'Studio', 'Year'];
            if (this._item?.Id && !nonPlayableTypes.includes(this._item.Type)) {
                options.push({ id: 'add-to-playlist', label: i18n.t('AddToPlaylist') });
                options.push({ id: 'add-to-collection', label: i18n.t('AddToCollection') || 'Add to Collection' });
            }

            // ── Delete Media Permission Check ────────────────────────────────────
            // Only show delete option if the item explicitly reports CanDelete=true
            if (this._item.CanDelete) {
                options.push({ id: 'delete', label: i18n.t('DeleteMedia') || 'Delete media' });
            }
        }

        const optionsHtml =
            options.length === 0
                ? `
            <div class="modal-empty-placeholder" style="padding: 24px 16px; text-align: center; opacity: 0.7; font-size: 1.1rem; pointer-events: none;" data-i18n="NoOptionsAvailable">
                ${i18n.t('NoOptionsAvailable') || 'No options available'}
            </div>
        `
                : options
                      .map((opt, i) => {
                          return `
                <button class="modal-option-btn ${opt.id === 'delete' ? 'danger-action' : ''}" data-id="${opt.id}" tabindex="0">
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

        // Focus management - Register as a new section
        const optionsContainer = overlay.querySelector('.modal-options');
        const actionsContainer = overlay.querySelector('.modal-actions');
        const optionsSection = 'details-more-menu';
        const actionsSection = 'details-more-menu-actions';

        this._isMoreMenuOpen = true;

        // Register the options section
        focusManager.register(optionsSection, optionsContainer, {
            orientation: 'vertical',
            leaveDown: actionsSection,
            leaveUp: actionsSection,
            enterTo: 'last'
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
        if (options.length === 0) {
            focusManager.setActiveSection(actionsSection);
            setTimeout(() => {
                const cancelBtn = overlay.querySelector('#btn-modal-cancel');
                if (cancelBtn) focusManager.focusElement(cancelBtn);
            }, 50);
        } else {
            focusManager.setActiveSection(optionsSection);
        }

        // Helper to close menu
        this._closeMoreMenu = () => {
            if (!this._isMoreMenuOpen) return;

            this._isMoreMenuOpen = false;
            overlay.classList.remove('visible');

            // Unregister focus sections
            focusManager.unregister(optionsSection);
            focusManager.unregister(actionsSection);

            // Clean up DOM after animation
            setTimeout(() => {
                if (!this._isMoreMenuOpen) overlay.remove();
            }, 300);

            // Restore focus to previous element
            if (this._prevSection) {
                focusManager.setActiveSection(this._prevSection, false);
            }
            if (this._prevFocus) {
                focusManager.focusElement(this._prevFocus);
            } else {
                focusManager.setActiveSection('details-actions');
            }

            // Restore state
            this._prevFocus = null;
            this._prevSection = null;
            this.onBack = oldOnBack;
        };

        this.onBack = () => {
            this._closeMoreMenu();
            return true;
        };

        // Click outside to close
        overlay.onclick = (e) => {
            if (e.target === overlay) this._closeMoreMenu();
        };

        // Bind click events for options
        overlay.querySelectorAll('.modal-option-btn').forEach((btn) => {
            btn.onclick = (e) => {
                e.stopPropagation();
                const id = btn.dataset.id;
                log.debug(`Selected more-option: ${id}`);

                if (id === 'go-to-series') {
                    this._closeMoreMenu(); // Close FIRST to restore focus/handler
                    router.navigate(`/details/${this._item.SeriesId}`);
                } else if (id === 'go-to-album') {
                    this._closeMoreMenu();
                    router.navigate(`/details/${this._item.AlbumId}`);
                } else if (id === 'select-version') {
                    // Snapshot focus state BEFORE closing the more-menu, because
                    // _closeMoreMenu() nulls out _prevFocus / _prevSection, which
                    // _renderTrackSelectionMenu would then capture as null — causing
                    // focus to be lost when the version menu closes.
                    const versionPrevFocus = this._prevFocus;
                    const versionPrevSection = this._prevSection;

                    // Tear down the more-menu without the normal focus-restore path
                    this._isMoreMenuOpen = false;
                    overlay.classList.remove('visible');
                    focusManager.unregister(optionsSection);
                    focusManager.unregister(actionsSection);
                    setTimeout(() => overlay.remove(), 300);
                    this._prevFocus = null;
                    this._prevSection = null;
                    this.onBack = oldOnBack;

                    // Re-seed focus state so the version menu restores correctly
                    this._prevFocus = versionPrevFocus;
                    this._prevSection = versionPrevSection;

                    this._showVersionSelectionMenu();
                } else if (id === 'display-order') {
                    // Similar to select-version, we close this menu but keep focus state
                    const versionPrevFocus = this._prevFocus;
                    const versionPrevSection = this._prevSection;

                    this._isMoreMenuOpen = false;
                    overlay.classList.remove('visible');
                    focusManager.unregister(optionsSection);
                    focusManager.unregister(actionsSection);
                    setTimeout(() => overlay.remove(), 300);
                    this._prevFocus = null;
                    this._prevSection = null;
                    this.onBack = oldOnBack;

                    this._prevFocus = versionPrevFocus;
                    this._prevSection = versionPrevSection;

                    this._showDisplayOrderMenu();
                } else if (id === 'media-info') {
                    // Close menu but DON'T restore focus yet (MediaInfo will take it)
                    this._isMoreMenuOpen = false;
                    overlay.classList.remove('visible');
                    focusManager.unregister('details-more-menu');
                    focusManager.unregister('details-more-menu-actions');
                    setTimeout(() => overlay.remove(), 300);

                    // Chain to Media Info with full context
                    MediaInfoModal.show(itemId, this, {
                        prevFocus: this._prevFocus,
                        prevSection: this._prevSection,
                        fromMoreOptions: true,
                        oldOnBack: oldOnBack
                    });
                } else if (id === 'refresh') {
                    this._isMoreMenuOpen = false;
                    overlay.classList.remove('visible');
                    focusManager.unregister('details-more-menu');
                    focusManager.unregister('details-more-menu-actions');
                    setTimeout(() => overlay.remove(), 300);

                    this._showRefreshMetadataModal(itemId, {
                        prevFocus: this._prevFocus,
                        prevSection: this._prevSection,
                        fromMoreOptions: true,
                        oldOnBack: oldOnBack
                    });
                } else if (id === 'edit-subtitles') {
                    this._isMoreMenuOpen = false;
                    overlay.classList.remove('visible');
                    focusManager.unregister('details-more-menu');
                    focusManager.unregister('details-more-menu-actions');
                    setTimeout(() => overlay.remove(), 300);

                    SubtitleEditorModal.show(itemId, this, {
                        prevFocus: this._prevFocus,
                        prevSection: this._prevSection,
                        fromMoreOptions: true,
                        oldOnBack: oldOnBack
                    });
                } else if (id === 'add-to-playlist' || id === 'add-to-collection') {
                    this._isMoreMenuOpen = false;
                    overlay.classList.remove('visible');
                    focusManager.unregister('details-more-menu');
                    focusManager.unregister('details-more-menu-actions');
                    setTimeout(() => overlay.remove(), 300);

                    const mode = id === 'add-to-collection' ? 'collection' : 'playlist';
                    AddToTargetModal.show(this, itemId, mode, {
                        prevFocus: this._prevFocus,
                        prevSection: this._prevSection,
                        fromMoreOptions: true,
                        oldOnBack: oldOnBack
                    });
                } else if (id === 'delete') {
                    // Transition to confirmation dialog
                    this._showDeleteConfirmation(itemId);
                }
            };
        });

        // Bind cancel button
        overlay.querySelector('#btn-modal-cancel').onclick = (e) => {
            e.stopPropagation();
            this._closeMoreMenu();
        };
    }

    /**
     * Show Refresh Metadata Modal
     */
    _showRefreshMetadataModal(itemId, transitionContext = null) {
        const oldOnBack = transitionContext?.oldOnBack || this.onBack;
        const prevFocus = transitionContext?.prevFocus || focusManager.getFocused();
        const prevSection = transitionContext?.prevSection || focusManager.getActiveSection();

        let overlay = document.getElementById('details-refresh-menu');
        if (overlay) overlay.remove();

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
            .map(
                (opt) => `
                <button class="modal-option-btn" data-id="${opt.id}" tabindex="0">
                    <span>${opt.label}</span>
                </button>
            `
            )
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
            this.onBack = oldOnBack;
            overlay.classList.remove('visible');
            setTimeout(() => overlay.remove(), 300);

            if (restoreFocus) {
                if (prevFocus) focusManager.focusElement(prevFocus);
                if (prevSection) focusManager.setActiveSection(prevSection, false);
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

                // Invalidate homepage page cache so the next home visit
                // fetches fresh data reflecting the updated metadata.
                state.delete('home:pageCache');

                toast.show(i18n.t('MessageRefreshQueued'));
            } catch (e) {
                log.error('Failed to queue metadata refresh', e);
                toast.show(i18n.t('MessageRefreshFailed'));
            }
        };

        const section = 'details-refresh-menu';
        const actionsSection = 'details-refresh-actions';

        focusManager.register(section, overlay.querySelector('.modal-options'), {
            orientation: 'vertical',
            circular: false,
            leaveDown: actionsSection
        });

        focusManager.register(actionsSection, overlay.querySelector('.modal-actions'), {
            orientation: 'horizontal',
            leaveUp: section
        });

        focusManager.setActiveSection(section);

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

        this.onBack = () => {
            if (transitionContext?.fromMoreOptions) {
                _close(false);
                this._showMoreOptionsModal(itemId);
            } else {
                _close();
            }
            return true;
        };
    }

    /**
     * Show a confirmation dialog before deleting media
     * @param {string} itemId - ID of the item to delete
     */
    _showDeleteConfirmation(itemId) {
        log.info('Showing delete confirmation for:', itemId);

        // Reuse standard modal styles but with danger branding
        let overlay = document.getElementById('details-delete-confirm');
        if (overlay) overlay.remove();

        overlay = document.createElement('div');
        overlay.id = 'details-delete-confirm';
        overlay.className = 'modal-overlay visible delete-modal';
        document.body.appendChild(overlay);

        overlay.innerHTML = `
            <div class="settings-modal confirm-modal danger" role="dialog" aria-modal="true">
                <div class="modal-header">
                    <h2 class="danger-title">${i18n.t('DeleteMediaConfirmTitle')}</h2>
                </div>
                <div class="modal-body" style="padding: 0 40px 20px 40px;">
                    <p class="confirm-message" style="margin-bottom: 16px; font-size: 1.3rem;">${i18n.t('DeleteMediaConfirmMessage')}</p>
                    <p class="confirm-item-name" style="font-weight: 700; color: var(--jf-accent); font-size: 1.4rem;">${i18n.ensureBiDi(this._item?.Name || '')}</p>
                </div>
                <div class="modal-actions horizontal" style="justify-content: center; padding-bottom: 30px;">
                    <button class="modal-action-btn focusable danger" id="btn-delete-confirm" tabindex="0" style="margin-right: 20px;">${i18n.t('Delete')}</button>
                    <button class="modal-action-btn focusable" id="btn-delete-cancel" tabindex="0">${i18n.t('ButtonCancel')}</button>
                </div>
            </div>
        `;

        const section = 'details-delete-confirm';
        focusManager.register(section, overlay.querySelector('.modal-actions'), {
            orientation: 'horizontal',
            defaultElement: '#btn-delete-cancel' // Default to Cancel for safety
        });

        focusManager.setActiveSection(section);

        const oldOnBack = this.onBack;

        const close = () => {
            overlay.classList.remove('visible');
            focusManager.unregister(section);
            setTimeout(() => overlay.remove(), 300);

            // Restore previous back handler
            this.onBack = oldOnBack;

            // Bring focus back to the "Delete" option in the more menu if it's still open
            if (this._isMoreMenuOpen) {
                focusManager.setActiveSection('details-more-menu');
                const deleteBtn = document.querySelector('.modal-option-btn[data-id="delete"]');
                if (deleteBtn) focusManager.focusElement(deleteBtn);
            }
        };

        // Bind back button
        this.onBack = () => {
            close();
            return true; // Stop propagation
        };

        overlay.querySelector('#btn-delete-confirm').onclick = async (e) => {
            e.stopPropagation();
            await this._handleDelete(itemId);
            overlay.remove(); // Remove immediately on success to avoid double clicks
        };

        overlay.querySelector('#btn-delete-cancel').onclick = (e) => {
            e.stopPropagation();
            close();
        };

        overlay.onclick = (e) => {
            if (e.target === overlay) close();
        };
    }

    /**
     * Execute the item deletion API call
     * @param {string} itemId - ID of the item to delete
     */
    async _handleDelete(itemId) {
        log.info('Deleting item:', itemId);

        try {
            // Show loading state if we have a way, or just proceed
            await api.delete(`/Items/${itemId}`);
            log.info('Item deleted successfully');

            // Success feedback
            eventBus.emit('notify', {
                text: i18n.t('Success'),
                type: 'success'
            });

            // If we are on the details page for this item, we must leave
            // Close all modals first
            if (this._closeMoreMenu) this._closeMoreMenu();

            // Navigate back to parent or home
            setTimeout(() => {
                router.back();
            }, 100);
        } catch (error) {
            log.error('Failed to delete item:', error);
            eventBus.emit('notify', {
                text: i18n.t('LabelFailed'),
                type: 'error'
            });
        }
    }

    /**
     * Show Display Order selection menu
     */
    _showDisplayOrderMenu() {
        const oldOnBack = this.onBack;
        const prevFocus = this._prevFocus;
        const prevSection = this._prevSection;

        let overlay = document.getElementById('details-display-order-menu');
        if (overlay) overlay.remove();

        overlay = document.createElement('div');
        overlay.id = 'details-display-order-menu';
        overlay.className = 'modal-overlay visible';
        document.body.appendChild(overlay);

        // Options according to jellyfin-web: Default (DateModified), SortName, PremiereDate
        const options = [
            { id: 'Default', label: i18n.t('OptionDateModified') || 'Date Modified' },
            { id: 'SortName', label: i18n.t('OptionSortName') || 'Sort Name' },
            { id: 'PremiereDate', label: i18n.t('OptionReleaseDate') || 'Release Date' }
        ];

        const optionsHtml = options
            .map(
                (opt) => `
                <button class="modal-option-btn" data-id="${opt.id}" tabindex="0">
                    <span>${opt.label}</span>
                </button>
            `
            )
            .join('');

        overlay.innerHTML = `
            <div class="settings-modal" role="dialog" aria-modal="true">
                <div class="modal-header">
                    <h2>${i18n.t('LabelDisplayOrder') || 'Display Order'}</h2>
                </div>
                <div class="modal-options">
                    ${optionsHtml}
                </div>
                <div class="modal-actions">
                    <button class="modal-action-btn" id="btn-display-order-cancel" tabindex="0">${i18n.t('ButtonCancel')}</button>
                </div>
            </div>
        `;

        const optionsSection = 'display-order-options';
        const actionsSection = 'display-order-actions';

        focusManager.register(optionsSection, overlay.querySelector('.modal-options'), {
            orientation: 'vertical',
            leaveDown: actionsSection,
            enterTo: 'last'
        });

        focusManager.register(actionsSection, overlay.querySelector('.modal-actions'), {
            orientation: 'horizontal',
            leaveUp: optionsSection
        });

        focusManager.setActiveSection(optionsSection);

        const closeMenu = () => {
            overlay.classList.remove('visible');
            focusManager.unregister(optionsSection);
            focusManager.unregister(actionsSection);
            setTimeout(() => overlay.remove(), 300);

            this.onBack = oldOnBack;
            if (prevSection) focusManager.setActiveSection(prevSection, false);
            if (prevFocus) focusManager.focusElement(prevFocus);
        };

        this.onBack = () => {
            closeMenu();
            return true;
        };

        overlay.querySelectorAll('.modal-option-btn').forEach((btn) => {
            btn.onclick = async (e) => {
                e.stopPropagation();
                const value = btn.dataset.id;
                closeMenu();
                await this._updateDisplayOrder(value);
            };
        });

        overlay.querySelector('#btn-display-order-cancel').onclick = (e) => {
            e.stopPropagation();
            closeMenu();
        };

        overlay.onclick = (e) => {
            if (e.target === overlay) closeMenu();
        };
    }

    /**
     * Update the display order via API and refresh content
     */
    async _updateDisplayOrder(value) {
        log.info('Updating display order to:', value);

        try {
            // Update the local state first so the reload uses it immediately
            this._item.DisplayOrder = value;

            // Construct a clean metadata object to avoid corruption.
            // We only send the fields that are intended for metadata updates,
            // avoiding large, read-only data like MediaSources and MediaStreams.
            const updateObj = {
                Id: this._item.Id,
                Name: this._item.Name,
                OriginalTitle: this._item.OriginalTitle,
                ForcedSortName: this._item.ForcedSortName,
                DisplayOrder: value,
                Overview: this._item.Overview,
                PremiereDate: this._item.PremiereDate,
                ProductionYear: this._item.ProductionYear,
                Genres: this._item.Genres || [],
                Tags: this._item.Tags || [],
                Studios: (this._item.Studios || []).map((s) => ({ Name: s.Name || s })),
                People: (this._item.People || []).map((p) => ({
                    Name: p.Name,
                    Id: p.Id,
                    Role: p.Role,
                    Type: p.Type,
                    PrimaryImageTag: p.PrimaryImageTag
                })),
                LockData: this._item.LockData || false,
                LockedFields: this._item.LockedFields || [],
                ProviderIds: this._item.ProviderIds || {},
                Taglines: this._item.Taglines || [],
                DateCreated: this._item.DateCreated,
                Status: this._item.Status
            };

            await api.updateItem(updateObj);

            log.info('Display order updated on server');

            eventBus.emit('notify', {
                text: i18n.t('Success'),
                type: 'success'
            });

            // Reload the collection items to reflect the new order
            this._loadCollectionItems();
        } catch (error) {
            log.error('Failed to update display order:', error);
            eventBus.emit('notify', {
                text: i18n.t('LabelFailed'),
                type: 'error'
            });
        }
    }
    // ── Trailer Playback ──────────────────────────────────────────────────────
    // Phase 1: button visibility, selection dialog, local trailer playback.
    // Phase 2: remote trailer via iframe (stub in _showRemoteTrailerPlayer).
    // ============================================================================

    /**
     * Evaluate whether the current item has any trailers and show/hide
     * the trailer button accordingly.
     *
     * Called immediately after the item is fetched, so no extra API round-trip
     * is needed — both `LocalTrailerCount` and `RemoteTrailers` are included
     * in the standard getItem response.
     */
    _updateTrailerButton() {
        const item = this._item;

        this._hasLocalTrailers = (item.LocalTrailerCount || 0) > 0;
        this._hasRemoteTrailers = !!(item.RemoteTrailers && item.RemoteTrailers.length > 0);

        // Fallback Crawler Activation: Force remote trailers flag for standard media
        // if the node proxy is enabled, since the crawler can fetch them dynamically.
        const isStandardMedia = ['Movie', 'Series', 'Season'].includes(item.Type);
        const mode = PlayerSettings.get('trailerPlaybackMode') || 'internal_proxy';
        const isProxyEnabled = mode === 'internal_proxy' && PlayerSettings.get('enableBackgroundService') !== false;

        if (!this._hasRemoteTrailers && isStandardMedia && isProxyEnabled) {
            this._hasRemoteTrailers = true;
            this._isProxyFallback = true;
        } else {
            this._isProxyFallback = false;
        }

        const btn = this.$('.trailer-btn');
        if (!btn) return;

        if (this._hasLocalTrailers || this._hasRemoteTrailers) {
            // Reveal the button and make it focusable
            btn.classList.remove('hidden');
            btn.setAttribute('tabindex', '0');

            // Let FocusManager know there is a new element in this section
            focusManager.invalidateCache('details-actions');

            log.debug(
                `Trailer button visible — local: ${this._hasLocalTrailers}, remote: ${this._hasRemoteTrailers} (Fallback: ${this._isProxyFallback})`
            );
        }
    }

    /**
     * Called when the trailer button is pressed.
     *
     * Decision tree:
     *   - Both local AND remote trailers exist → show TrailerDialog selection
     *   - Only local  → play immediately via native player
     *   - Only remote → open inline iframe player (Phase 2)
     */
    _onTrailerClick() {
        const hasLocal = this._hasLocalTrailers;
        const hasRemote = this._hasRemoteTrailers;

        if (hasLocal && hasRemote) {
            // ----------------------------------------------------------------
            // Auto-chain mode: skip the dialog entirely and play the local
            // trailer immediately via the native player. When it ends (or the
            // user presses Next on the OSD), the remote player opens instead.
            // ----------------------------------------------------------------
            if (PlayerSettings.get('trailerAutoChain')) {
                this._playLocalTrailerThenChain();
                return;
            }

            // Both available and auto-chain is OFF — let the user choose
            TrailerDialog.show(
                { hasLocal, hasRemote },
                this,
                () => this._playLocalTrailer(),
                () => this._showRemoteTrailerPlayer()
            );
            return;
        }

        // Only one type available — skip the dialog entirely
        if (hasLocal) {
            this._playLocalTrailer();
            return;
        }
        if (hasRemote) {
            this._showRemoteTrailerPlayer();
            return;
        }
    }

    /**
     * Fetch local trailers from the server and route the first one
     * into the native player via the standard eventBus player:play event.
     *
     * Local trailers are proper Jellyfin items with their own Ids,
     * so the existing player pipeline handles them without any modifications.
     */
    async _playLocalTrailer() {
        try {
            const trailers = await api.getLocalTrailers(this._itemId);

            if (!trailers || trailers.length === 0) {
                // Shouldn't normally happen (button is gated on LocalTrailerCount > 0),
                // but guard against stale data anyway.
                log.warn('getLocalTrailers returned empty for item', this._itemId);
                toast.show(i18n.t('NoLocalTrailersFound') || 'No local trailers found.');
                return;
            }

            const trailerItem = trailers[0];
            const parentName = this._item?.Name || this._item?.OriginalTitle || 'Video';

            // Jellyfin often names local trailers generically (e.g. "Trailer" or "Trailers").
            // Prefix it with the parent item's name so it looks good in the OSD title.
            // e.g. "Inception - Trailer (2010)" instead of "Trailers (2010)".
            if (trailerItem.Name) {
                // If it's just "trailer" or "trailers", or starts with the parent name, clean it up.
                if (/^(trailer|trailers|official trailer)s?$/i.test(trailerItem.Name.trim())) {
                    trailerItem.Name = `${parentName} - Trailer`;
                } else if (!trailerItem.Name.toLowerCase().startsWith(parentName.toLowerCase())) {
                    // Capitalize 'trailers' if it's oddly lowercased by the backend
                    let tName = trailerItem.Name;
                    if (tName === 'trailers') tName = 'Trailer';
                    trailerItem.Name = `${parentName} - ${tName}`;
                }
            } else {
                trailerItem.Name = `${parentName} - Trailer`;
            }

            // Sync the year so the OSD displays the Movie's year, not the trailer file's metadata year
            if (this._item && this._item.ProductionYear) {
                trailerItem.ProductionYear = this._item.ProductionYear;
            } else {
                delete trailerItem.ProductionYear;
            }

            log.info(`Playing local trailer "${trailerItem.Name}" (${trailerItem.Id})`);

            // Reuse the backdrop from the parent item for a smooth visual transition
            const backdropUrl = BackdropManager.getBackdropUrl(this._item, {
                maxWidth: 3840,
                quality: 90
            });

            // Emit the standard player:play event — same path as normal item playback.
            // No resume position, no audio/subtitle override.
            eventBus.emit('player:play', {
                item: trailerItem,
                resume: false,
                backdropUrl
            });
        } catch (err) {
            log.error('Failed to load local trailers', err);
            toast.show(i18n.t('ErrorFetchingTrailers') || 'Could not load trailers.');
        }
    }

    /**
     * Auto-chain mode entry point.
     *
     * Writes a pending-chain intent to StateManager (a global in-memory
     * singleton that persists across page instances), then launches the local
     * trailer via the standard native player pipeline.
     *
     * When the local trailer finishes, the router calls router.back() which
     * destroys PlayerPage and creates a fresh DetailsPage instance. onInit()
     * on that fresh instance reads and clears the state flag, then calls
     * _showRemoteTrailerPlayer() automatically.
     *
     * Navigation stack:
     *   Details page (at rest)
     *     → PlayerPage  (/player/<localTrailerId>/false)
     *       → router.back() destroys PlayerPage, creates DetailsPage
     *     ← DetailsPage.onInit() detects flag → _showRemoteTrailerPlayer()
     *       → user presses Back in remote player → overlay closes
     *       → Details page (at rest) ✅
     */
    async _playLocalTrailerThenChain() {
        try {
            const trailers = await api.getLocalTrailers(this._itemId);

            if (!trailers || trailers.length === 0) {
                log.warn('getLocalTrailers returned empty for item', this._itemId);
                toast.show(i18n.t('NoLocalTrailersFound') || 'No local trailers found.');
                return;
            }

            const trailerItem = trailers[0];
            const parentName = this._item?.Name || this._item?.OriginalTitle || 'Video';

            // Override generic local trailer names with the parent item's name
            // so it reads cleanly in the player OSD.
            if (trailerItem.Name) {
                // If it's just "trailer" or "trailers", or starts with the parent name, clean it up.
                if (/^(trailer|trailers|official trailer)s?$/i.test(trailerItem.Name.trim())) {
                    trailerItem.Name = `${parentName} - Trailer`;
                } else if (!trailerItem.Name.toLowerCase().startsWith(parentName.toLowerCase())) {
                    // Capitalize 'trailers' if it's oddly lowercased by the backend
                    let tName = trailerItem.Name;
                    if (tName === 'trailers') tName = 'Trailer';
                    trailerItem.Name = `${parentName} - ${tName}`;
                }
            } else {
                trailerItem.Name = `${parentName} - Trailer`;
            }

            // Sync the year so the OSD displays the Movie's year, not the trailer file's metadata year
            if (this._item && this._item.ProductionYear) {
                trailerItem.ProductionYear = this._item.ProductionYear;
            } else {
                delete trailerItem.ProductionYear;
            }

            log.info(`[AutoChain] Playing local trailer "${trailerItem.Name}" (${trailerItem.Id}), remote will follow`);

            const backdropUrl = BackdropManager.getBackdropUrl(this._item, {
                maxWidth: 3840,
                quality: 90
            });

            // ----------------------------------------------------------------
            // Write the chain intent to persistent in-memory state BEFORE
            // navigating. The router will destroy this DetailsPage instance
            // during navigation, so we cannot use an instance-level flag or
            // EventBus listener. StateManager is a global singleton that
            // outlives any individual page, making it the correct tool here.
            // ----------------------------------------------------------------
            state.set('details:autoChainRemote', this._itemId);
            log.info('[AutoChain] Wrote state flag for item', this._itemId);

            // Kick off the native player via the standard pipeline
            eventBus.emit('player:play', {
                item: trailerItem,
                resume: false,
                backdropUrl
            });
        } catch (err) {
            log.error('[AutoChain] Failed to load local trailer for chain', err);
            toast.show(i18n.t('ErrorFetchingTrailers') || 'Could not load trailers.');
        }
    }

    _showRemoteTrailerPlayer() {
        // --------------------------------------------------------------------
        // Stop background ambient theme music instantly when starting a
        // remote trailer. This prevents audio overlap since remote trailers
        // are loaded inside a custom iframe overlay rather than navigating
        // away to the dedicated native player page.
        // --------------------------------------------------------------------
        themeSongPlayer.stopInstant();

        const mode = PlayerSettings.get('trailerPlaybackMode') || 'internal_proxy';

        let trailers = this._item.RemoteTrailers || [];
        if (this._isProxyFallback && trailers.length === 0) {
            trailers = [
                {
                    Name: (this._item.Name || this._item.OriginalTitle || 'Video') + ' Trailer',
                    Url: '',
                    IsProxyFallback: true,
                    TmdbId: this._item.ProviderIds?.Tmdb,
                    ItemName: this._item.OriginalTitle || this._item.Name,
                    ItemYear: this._item.ProductionYear,
                    ItemType: this._item.Type
                }
            ];
        }

        if (mode === 'external') {
            TrailerPlayer.launchExternal(trailers, this);
        } else if (mode === 'internal_iframe') {
            TrailerPlayer.showLegacy(trailers, this);
        } else {
            TrailerPlayer.show(trailers, this);
        }
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
                if (btn) {
                    btn.classList.remove('active');
                    btn.innerHTML = detailsIcons.watchedOutline;
                }
            } else {
                await api.markPlayed(this._itemId);
                if (btn) {
                    btn.classList.add('active');
                    btn.innerHTML = detailsIcons.watchedFilled;
                }
            }

            this._item.UserData = this._item.UserData || {};
            this._item.UserData.Played = !isPlayed;

            this._updateCachedPlayedStatus();
        } catch (error) {
            log.error('Failed to toggle watched', error);
        }
    }

    _updateCachedPlayedStatus() {
        const cachedItem = Object.entries(state.getAll())
            .filter(([key, cached]) => key.startsWith('library:state:') && cached?.stateData?.items)
            .flatMap(([, cached]) => cached.stateData.items)
            .find(({ Id }) => Id === this._itemId);

        if (cachedItem) cachedItem.UserData = { ...cachedItem.UserData, ...this._item.UserData };
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
        // --------------------------------------------------------------------
        // Flag this instance as destroyed.
        // This acts as a circuit breaker for any pending, asynchronous API calls
        // (such as getThemeMedia) resolving after page exit, preventing audio
        // race conditions from launching theme playback in the background.
        // --------------------------------------------------------------------
        this._isDestroyed = true;

        // --------------------------------------------------------------------
        // Stop background ambient theme score loop playback.
        // Elegant Sustain Logic: If the next destination is also a DetailsPage
        // (e.g. going from a Series details to a Season/Episode details, or back),
        // we defer stopping by a 2.0-second grace period. If the new page shares
        // the same theme song (common parent owner), the play command cancels
        // this deferred stop and playback continues seamlessly without a single
        // audio hiccup! Otherwise, if we are leaving details entirely, stop and
        // fade out immediately.
        // --------------------------------------------------------------------
        const nextPath = router.getCurrentPath?.() || '';
        const isNextDetails = nextPath.startsWith('/details/');

        if (isNextDetails) {
            themeSongPlayer.stopDeferred(2000);
        } else {
            themeSongPlayer.stop();
        }

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
