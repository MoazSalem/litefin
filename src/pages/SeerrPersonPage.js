/**
 * ============================================================================
 * Litefin Tizen - Seerr Person Details Page
 * ============================================================================
 * Displays person biography, metadata, and filmography works from Seerr.
 * Features a tab switcher to filter between All, Movies, and Series across
 * Appearances (Cast) and Crew grids.
 * ============================================================================
 */

import Page from './Page.js';
import { router } from '../core/Router.js';
import { focusManager } from '../ui/FocusManager.js';
import { storage } from '../utils/StorageService.js';
import MediaGrid from '../components/MediaGrid.js';
import { i18n } from '../utils/i18n.js';
import { state } from '../core/StateManager.js';
import { seerr } from '../api/JellyseerrClient.js';
import DescriptionModal from '../components/DescriptionModal.js';
import BackdropManager from '../utils/BackdropManager.js';
import CardRenderer from '../utils/CardRenderer.js';
import { logger } from '../utils/Logger.js';

const log = logger.create('SeerrPersonPage');

class SeerrPersonPage extends Page {
    constructor() {
        super();
        // The TMDB person identifier passed in route
        this._personId = null;
        // The normalized person entity returned by Seerr
        this._person = null;
        // Raw combined credits storage
        this._allCast = [];
        this._allCrew = [];
        // Active filter state: 'all' | 'movie' | 'tv'
        this._selectedFilter = 'all';
        // Sub-component instances for appearances and crew grids
        this._grids = {};
    }

    onInit() {
        this._personId = this.params.id;

        // Verify valid person ID parameter
        if (!this._personId) {
            log.error('No person ID provided in route params');
            router.back();
            return;
        }

        try {
            // Setup initial base focus section before fetching
            this._setupFocus();
            // Fetch person details and combined credits from Seerr
            this._loadPersonDetails();
        } catch (err) {
            log.error('SeerrPersonPage onInit failure', err);
            this.showError('Critical Error: ' + err.message);
        }
    }

    render() {
        return `
            <div class="page person-page" id="person-page">
                <!-- Backdrop layer with dark gradient overlay -->
                <div class="details-backdrop" id="person-backdrop">
                    <div class="backdrop-gradient"></div>
                </div>

                <div class="page-content">
                    <div class="page-error" style="display:none; padding: 20px; color: #ff6b6b; text-align: center;"></div>

                    <!-- Split container: Profile Poster on Left, Details on Right -->
                    <div class="details-main-split media-row">
                        <!-- Left: Person Profile Photo -->
                        <div class="hero-poster" id="person-poster">
                            <!-- Image injected dynamically -->
                        </div>

                        <!-- Right: Info column -->
                        <div class="details-info-col" id="person-info-col">
                            <h1 class="details-title" id="person-name"></h1>

                            <!-- Metadata row: Born / Died / Place / Known For -->
                            <div class="details-meta-row" id="person-meta"></div>

                            <!-- Biography overview -->
                            <div class="details-overview">
                                <div class="overview-text line-clamp-6" id="person-bio" tabindex="-1"></div>
                                <button class="see-more-btn" tabindex="0" data-i18n="ShowMore" style="display: none;">${i18n.t('ShowMore')}</button>
                            </div>
                        </div>
                    </div>

                    <!-- Center Tab Switcher Row (Below Details, Centered Above Grids) -->
                    <div class="person-tab-switcher-container">
                        <div class="person-tab-switcher" id="person-tab-switcher">
                            <button class="person-tab-btn focusable active" data-filter="all" tabindex="0">${i18n.t('All') || 'All'}</button>
                            <button class="person-tab-btn focusable" data-filter="movie" tabindex="0">${i18n.t('Movies') || 'Movies'}</button>
                            <button class="person-tab-btn focusable" data-filter="tv" tabindex="0">${i18n.t('TypeOptionPluralSeries') || 'Series'}</button>
                        </div>
                    </div>

                    <!-- Works Section: Appearances and Crew grids -->
                    <div class="person-works" id="person-works">
                        <!-- MediaGrids injected here -->
                    </div>
                </div>
            </div>
        `;
    }

    /**
     * Loads the person details, biography, and filmography credits from Seerr.
     */
    async _loadPersonDetails() {
        this.setLoading(true);

        try {
            // ────────────────────────────────────────────────────────────
            // 1. Fetch person data from Seerr plugin endpoint
            // ────────────────────────────────────────────────────────────
            this._person = await seerr.person(this._personId);
            this.title = this._person.name || this._person.Name || 'Person';

            // Store raw cast and crew lists for interactive filtering with fallbacks
            const raw = this._person.raw || this._person;
            const rawCredits = this._person.combinedCredits || raw.combinedCredits || raw.combined_credits || raw.credits || {};

            this._allCast =
                rawCredits.cast ||
                rawCredits.Cast ||
                raw.cast ||
                raw.Cast ||
                this._person.appearances ||
                [];

            this._allCrew =
                rawCredits.crew ||
                rawCredits.Crew ||
                raw.crew ||
                raw.Crew ||
                [];

            // ────────────────────────────────────────────────────────────
            // 2. Render header info and profile poster
            // ────────────────────────────────────────────────────────────
            this._renderPersonInfo();

            // Set dynamic background backdrop using popular work or profile
            this._setSmartBackdrop();

            // ────────────────────────────────────────────────────────────
            // 3. Render Works grids (Appearances & Crew) for initial filter
            // ────────────────────────────────────────────────────────────
            this._renderFilteredGrids();

            // ────────────────────────────────────────────────────────────
            // 4. Bind interactive events to Tab Switcher buttons
            // ────────────────────────────────────────────────────────────
            this._bindSwitcherEvents();

            this.setLoading(false);
        } catch (error) {
            log.error('Failed to load Seerr person details', error);
            this.showError('Failed to load person details');
            this.setLoading(false);
        }

        // ────────────────────────────────────────────────────────────
        // 5. Restore previous focus position on back navigation
        // ────────────────────────────────────────────────────────────
        requestAnimationFrame(() => {
            const stateKey = `seerr:person:lastFocusedItem:${this._personId}`;
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

                const savedCard = sectionContainer?.querySelector(
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
                // Default initial focus to the Tab Switcher
                this.setActiveSection('person-tab-switcher');
            }
        });
    }

    /**
     * Applies a high-resolution backdrop from the person's most popular title.
     */
    _setSmartBackdrop() {
        const backdropEl = this.$('#person-backdrop');
        if (!backdropEl) return;

        // Find the first valid backdrop from popular filmography
        const firstWithBackdrop = [...this._allCast, ...this._allCrew].find(
            (c) => c && (c.backdropPath || c.backdrop_path)
        );

        const backdropPath = firstWithBackdrop
            ? firstWithBackdrop.backdropPath || firstWithBackdrop.backdrop_path
            : null;

        const backdropUrl = backdropPath
            ? `https://image.tmdb.org/t/p/w1280${backdropPath}`
            : this._person?._imageUrl || '';

        if (backdropUrl) {
            BackdropManager.applyBackdrop(backdropEl, backdropUrl, '');
        }
    }

    /**
     * Populates name, dates, place of birth, biography, and profile poster.
     */
    _renderPersonInfo() {
        const p = this._person;
        if (!p) return;

        // Set person full name header
        const nameEl = this.$('#person-name');
        if (nameEl) nameEl.textContent = p.name || p.Name || '';

        // Render profile poster image
        const posterContainer = this.$('#person-poster');
        if (posterContainer) {
            posterContainer.classList.remove('square');
            const fallbackHtml = CardRenderer.getFallbackHtml({ Name: p.name || p.Name, Type: 'Person' }, false);

            const profile = p.profilePath || p.profile_path || p.ProfilePath;
            if (profile) {
                const posterUrl = `https://image.tmdb.org/t/p/w500${profile}`;
                posterContainer.innerHTML = '';

                const img = new Image();
                img.onload = () => {
                    img.classList.add('loaded');
                };
                img.onerror = () => {
                    img.style.display = 'none';
                    posterContainer.insertAdjacentHTML('afterbegin', fallbackHtml);
                };
                img.src = posterUrl;
                img.alt = p.name || p.Name || '';
                posterContainer.appendChild(img);
            } else {
                posterContainer.innerHTML = fallbackHtml;
            }
        }

        // Build metadata parts: Born, Died, Place of Birth, Known For
        const metaEl = this.$('#person-meta');
        if (metaEl) {
            const parts = [];

            const bday = p.birthday || p.Birthday;
            if (bday) {
                try {
                    const born = new Date(bday).getFullYear();
                    if (!isNaN(born)) {
                        parts.push(i18n.t('BirthDateValue', [born]) || `Born ${born}`);
                    }
                } catch (e) {}
            }

            const dday = p.deathday || p.Deathday;
            if (dday) {
                try {
                    const died = new Date(dday).getFullYear();
                    if (!isNaN(died)) {
                        parts.push(i18n.t('DeathDateValue', [died]) || `Died ${died}`);
                    }
                } catch (e) {}
            }

            const pob = p.placeOfBirth || p.place_of_birth || p.PlaceOfBirth;
            if (pob) {
                parts.push(pob);
            }

            const kfd = p.knownForDepartment || p.known_for_department || p.KnownForDepartment;
            if (kfd) {
                parts.push(kfd);
            }

            metaEl.textContent = parts.join(' • ');
        }

        // Biography overview text rendering
        const bioEl = this.$('#person-bio');
        if (bioEl) {
            bioEl.textContent = p.biography || p.Biography || p.overview || p.Overview || '';
            bioEl.classList.add('line-clamp-6');
        }

        // Reset and hide "See More" button initially
        const seeMoreBtn = this.$('.see-more-btn');
        if (seeMoreBtn) {
            seeMoreBtn.style.display = 'none';
            seeMoreBtn.textContent = i18n.t('ShowMore');
        }

        // Reveal info column
        const infoCol = this.$('#person-info-col');
        if (infoCol) {
            infoCol.style.opacity = '1';
            infoCol.classList.add('visible');
        }

        // Check for text truncation after DOM has completed rendering
        requestAnimationFrame(() => {
            this._checkOverviewTruncation();
        });
    }

    /**
     * Checks if the biography text exceeds the line-clamp boundary and reveals modal trigger.
     */
    _checkOverviewTruncation() {
        const bioEl = this.$('#person-bio');
        const seeMoreBtn = this.$('.see-more-btn');

        if (!bioEl || !seeMoreBtn) return;

        // Check whether content is truncated by scroll height comparison
        if (bioEl.scrollHeight > bioEl.clientHeight) {
            seeMoreBtn.style.display = 'block';

            // Register dedicated focus section for the See More button
            this.registerFocusSection('person-see-more', this.$('.details-overview'), {
                orientation: 'vertical',
                leaveUp: null,
                leaveDown: 'person-tab-switcher',
                leaveLeft: 'sidebar'
            });

            // Update Tab Switcher upward boundary to point to See More button
            const switcherConfig = focusManager.getSectionConfig('person-tab-switcher');
            if (switcherConfig) {
                switcherConfig.leaveUp = 'person-see-more';
                focusManager.register('person-tab-switcher', switcherConfig.container, switcherConfig);
            }

            // Bind click to open description modal
            seeMoreBtn.onclick = () => {
                if (!this._person) return;
                DescriptionModal.show(
                    {
                        title: this._person.name || this._person.Name,
                        overview: this._person.biography || this._person.Biography || this._person.overview || this._person.Overview
                    },
                    this
                );
            };
        } else {
            seeMoreBtn.style.display = 'none';
        }
    }

    /**
     * Binds click and keydown handlers on the Tab Switcher buttons (All / Movies / Series).
     */
    _bindSwitcherEvents() {
        const switcher = this.$('#person-tab-switcher');
        if (!switcher) return;

        const buttons = switcher.querySelectorAll('.person-tab-btn');
        buttons.forEach((btn) => {
            const filterType = btn.dataset.filter;

            const handleSwitch = (e) => {
                e.preventDefault();
                e.stopPropagation();

                if (this._selectedFilter === filterType) return;
                this._selectedFilter = filterType;

                // Update active highlight on buttons
                buttons.forEach((b) => {
                    b.classList.toggle('active', b.dataset.filter === filterType);
                });

                // Re-render both grids with active filter applied
                this._renderFilteredGrids();
            };

            btn.onclick = handleSwitch;
            btn.onkeydown = (e) => {
                if (e.keyCode === 13) {
                    handleSwitch(e);
                }
            };
        });
    }

    /**
     * Filters cast and crew data based on the active tab and mounts MediaGrid components.
     */
    _renderFilteredGrids() {
        const worksContainer = this.$('#person-works');
        if (!worksContainer) return;

        // Clear previous grid components
        Object.values(this._grids).forEach((comp) => comp.destroy());
        this._grids = {};
        worksContainer.innerHTML = '';

        const filter = this._selectedFilter; // 'all' | 'movie' | 'tv'

        // Helper filter to match media types
        const matchesFilter = (item) => {
            if (!item) return false;
            if (filter === 'all') return true;
            const itemType =
                item.mediaType ||
                item.media_type ||
                item._mediaType ||
                (item.Type === 'Series' ? 'tv' : (item.Type === 'Movie' ? 'movie' : '')) ||
                (item.title || item.releaseDate || item.release_date ? 'movie' : 'tv');
            return itemType === filter;
        };

        // Helper to extract timestamp score from various date properties
        const getItemDateScore = (item) => {
            const rawDate =
                item.releaseDate ||
                item.release_date ||
                item.firstAirDate ||
                item.first_air_date ||
                item.ReleaseDate ||
                item.PremiereDate ||
                '';
            if (!rawDate) return 0;
            const parsed = new Date(rawDate).getTime();
            return isNaN(parsed) ? 0 : parsed;
        };

        // Date descending comparator with popularity tie-breaker
        const sortByDateDesc = (a, b) => {
            const dateA = getItemDateScore(a);
            const dateB = getItemDateScore(b);
            if (dateA !== dateB) {
                return dateB - dateA; // Newest first
            }
            return (b.popularity || b.voteAverage || 0) - (a.popularity || a.voteAverage || 0);
        };

        // ────────────────────────────────────────────────────────────
        // 1. Process Appearances (Cast)
        // ────────────────────────────────────────────────────────────
        const filteredCast = this._allCast
            .filter(matchesFilter)
            .sort(sortByDateDesc)
            .map((item) => {
                const itemMediaType =
                    item.mediaType ||
                    item.media_type ||
                    item._mediaType ||
                    (item.Type === 'Series' ? 'tv' : (item.Type === 'Movie' ? 'movie' : '')) ||
                    (item.title || item.releaseDate || item.release_date ? 'movie' : 'tv');

                const releaseDateStr =
                    item.releaseDate ||
                    item.release_date ||
                    item.firstAirDate ||
                    item.first_air_date ||
                    item.ReleaseDate ||
                    '';
                const releaseYear = releaseDateStr ? releaseDateStr.substring(0, 4) : '';
                const role = item.character || item.Role || item._role || '';
                const poster =
                    item.posterPath ||
                    item.poster_path ||
                    item.PosterPath ||
                    (item._imageUrl ? item._imageUrl.replace(/^https:\/\/image\.tmdb\.org\/t\/p\/[^\/]+/, '') : '');

                return {
                    Id: item.id || item.Id || `tmdb-${itemMediaType}-${item.id || item._tmdbId}`,
                    Name: item.title || item.name || item.Name || '',
                    Type: itemMediaType === 'tv' ? 'Series' : 'Movie',
                    ProductionYear: releaseYear || null,
                    _mediaType: itemMediaType,
                    _tmdbId: item.id || item._tmdbId || item.Id,
                    Role: role,
                    _roleName: role,
                    _imageUrl: poster ? `https://image.tmdb.org/t/p/w342${poster}` : (item._imageUrl || ''),
                    _detailImageUrl: poster ? `https://image.tmdb.org/t/p/w500${poster}` : (item._detailImageUrl || ''),
                    _seerrStatus: item.mediaInfo?.status || item._seerrStatus || 0,
                    _rating: item.voteAverage || item.vote_average || item.CommunityRating || 0
                };
            });

        // ────────────────────────────────────────────────────────────
        // 2. Process Crew Credits
        // ────────────────────────────────────────────────────────────
        const filteredCrew = this._allCrew
            .filter(matchesFilter)
            .sort(sortByDateDesc)
            .map((item) => {
                const itemMediaType =
                    item.mediaType ||
                    item.media_type ||
                    item._mediaType ||
                    (item.Type === 'Series' ? 'tv' : (item.Type === 'Movie' ? 'movie' : '')) ||
                    (item.title || item.releaseDate || item.release_date ? 'movie' : 'tv');

                const releaseDateStr =
                    item.releaseDate ||
                    item.release_date ||
                    item.firstAirDate ||
                    item.first_air_date ||
                    item.ReleaseDate ||
                    '';
                const releaseYear = releaseDateStr ? releaseDateStr.substring(0, 4) : '';
                const job = item.job || item.department || item.Role || item._role || '';
                const poster =
                    item.posterPath ||
                    item.poster_path ||
                    item.PosterPath ||
                    (item._imageUrl ? item._imageUrl.replace(/^https:\/\/image\.tmdb\.org\/t\/p\/[^\/]+/, '') : '');

                return {
                    Id: item.id || item.Id || `tmdb-${itemMediaType}-${item.id || item._tmdbId}`,
                    Name: item.title || item.name || item.Name || '',
                    Type: itemMediaType === 'tv' ? 'Series' : 'Movie',
                    ProductionYear: releaseYear || null,
                    _mediaType: itemMediaType,
                    _tmdbId: item.id || item._tmdbId || item.Id,
                    _isCrew: true,
                    Role: job,
                    _roleName: job,
                    _imageUrl: poster ? `https://image.tmdb.org/t/p/w342${poster}` : (item._imageUrl || ''),
                    _detailImageUrl: poster ? `https://image.tmdb.org/t/p/w500${poster}` : (item._detailImageUrl || ''),
                    _seerrStatus: item.mediaInfo?.status || item._seerrStatus || 0,
                    _rating: item.voteAverage || item.vote_average || item.CommunityRating || 0
                };
            });

        // Mount Appearances Grid if items are present
        if (filteredCast.length > 0) {
            this._grids.appearances = new MediaGrid({
                id: 'person-appearances',
                title: i18n.t('HeaderAppearances') || i18n.t('Appearances') || 'Appearances',
                items: filteredCast,
                type: 'poster',
                gridClass: 'person-grid seerr-person-grid',
                contextType: 'discover',
                limit: 200,
                allowSeeMore: false,
                onClick: (card) => this._saveStateAndNavigate('person-appearances-items', card)
            });
            this._grids.appearances.mount(worksContainer);
        }

        // Mount Crew Grid if items are present
        if (filteredCrew.length > 0) {
            this._grids.crew = new MediaGrid({
                id: 'person-crew',
                title: i18n.t('HeaderCrew') || i18n.t('Crew') || 'Crew',
                items: filteredCrew,
                type: 'poster',
                gridClass: 'person-grid seerr-person-grid',
                contextType: 'discover',
                limit: 200,
                allowSeeMore: false,
                onClick: (card) => this._saveStateAndNavigate('person-crew-items', card)
            });
            this._grids.crew.mount(worksContainer);
        }

        // Re-link focus chain for newly mounted grids
        this._registerWorkSections();
    }

    /**
     * Registers vertical spatial navigation sections between Tab Switcher and Works Grids.
     */
    _registerWorkSections() {
        const sectionOrder = ['appearances', 'crew'];
        const activeTypes = sectionOrder.filter((type) => this._grids[type]);

        // Register Tab Switcher Section
        const switcherEl = this.$('#person-tab-switcher');
        const seeMoreEl = this.$('.see-more-btn');
        const leaveUpTarget = seeMoreEl && seeMoreEl.style.display !== 'none' ? 'person-see-more' : null;
        const firstGridZone = activeTypes.length > 0 ? `person-${activeTypes[0]}-items` : null;

        if (switcherEl) {
            this.registerFocusSection('person-tab-switcher', switcherEl, {
                orientation: 'horizontal',
                leaveUp: leaveUpTarget,
                leaveDown: firstGridZone,
                leaveLeft: 'sidebar'
            });
        }

        if (activeTypes.length === 0) return;

        // Register spatial navigation for each active grid
        activeTypes.forEach((type, index) => {
            const gridComp = this._grids[type];
            const baseId = gridComp.id; // 'person-appearances' or 'person-crew'
            const gridZone = `${baseId}-items`;

            const prevType = index > 0 ? activeTypes[index - 1] : null;
            const nextType = index < activeTypes.length - 1 ? activeTypes[index + 1] : null;

            // Upward boundary: previous grid or Tab Switcher
            const gridLeaveUp = prevType ? `person-${prevType}-items` : 'person-tab-switcher';
            // Downward boundary: next grid or null
            const gridLeaveDown = nextType ? `person-${nextType}-items` : null;

            const gridContainer = this.$(`#${gridZone}`);
            if (gridContainer) {
                this.registerFocusSection(gridZone, gridContainer, {
                    orientation: 'grid',
                    leaveUp: gridLeaveUp,
                    leaveDown: gridLeaveDown,
                    leaveLeft: 'sidebar'
                });
            }
        });
    }

    /**
     * Handles card click by saving focus state and navigating to SeerrDetailsPage.
     */
    _saveStateAndNavigate(sectionId, card) {
        const cardId = card.dataset.itemId || card.getAttribute('data-id');
        if (!cardId) return;

        const stateKey = `seerr:person:lastFocusedItem:${this._personId}`;
        if (storage.getItem('pref:disableFocusRestore') !== 'true') {
            state.set(stateKey, {
                itemId: cardId,
                sectionId: sectionId
            });
        }

        // Search stored credits for the source item model
        const cleanCardTmdbId = card.dataset.tmdbId || (typeof cardId === 'string' ? cardId.replace(/^tmdb-(?:movie|tv|person)-/, '') : cardId);
        const found =
            [...this._allCast, ...this._allCrew].find(
                (i) =>
                    String(i.id || i.Id || i._tmdbId) === String(cleanCardTmdbId) ||
                    String(i.Id) === String(cardId) ||
                    String(i.id) === String(cardId)
            ) || {};

        // Resolve clean media type: 'movie' | 'tv'
        let mediaType =
            card.dataset.mediaType ||
            found._mediaType ||
            found.mediaType ||
            found.media_type ||
            ((card.dataset.type === 'Series' || found.Type === 'Series') ? 'tv' : 'movie');

        if (mediaType !== 'tv' && mediaType !== 'movie') {
            mediaType = (card.dataset.type === 'Series' || found.Type === 'Series') ? 'tv' : 'movie';
        }

        // Resolve clean TMDB numeric ID
        const tmdbId =
            card.dataset.tmdbId ||
            found._tmdbId ||
            found.id ||
            found.Id ||
            cleanCardTmdbId;

        router.navigate(`/seerr/${mediaType}/${tmdbId}`);
    }

    /**
     * Initial focus section registration setup.
     */
    _setupFocus() {
        const switcherEl = this.$('#person-tab-switcher');
        if (switcherEl) {
            this.registerFocusSection('person-tab-switcher', switcherEl, {
                orientation: 'horizontal',
                leaveUp: null,
                leaveDown: null,
                leaveLeft: 'sidebar'
            });
        }
    }

    destroy() {
        // Destroy all mounted grid components
        Object.values(this._grids).forEach((comp) => comp.destroy());
        this._grids = {};
        super.destroy();
    }
}

export default SeerrPersonPage;
