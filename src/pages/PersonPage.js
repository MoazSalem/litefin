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
import MediaGrid from '../components/MediaGrid.js';
import SimpleHeader from '../components/SimpleHeader.js';

class PersonPage extends Page {
    constructor() {
        super();
        this._personId = null;
        this._person = null;
        this._items = [];
        this._grids = {}; // Store component instances
        this._header = null;
    }

    onInit() {
        this._personId = this.params.id;

        if (!this._personId) {
            console.error('PersonPage: No person ID provided');
            router.back();
            return;
        }

        try {
            this._setupFocus();
            this._loadPersonDetails();
        } catch (err) {
            console.error('PersonPage: onInit critical failure', err);
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
                    <!-- Nav Header -->
                    <div id="person-header-container"></div>

                    <div class="details-main-split">
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
                            <div class="person-actions-row" id="person-fav-actions">
                                <button class="btn btn-icon favorite-btn" id="btn-person-favorite" tabindex="0" aria-label="Favorite">
                                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path>
                                    </svg>
                                </button>
                            </div>
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
            // Setup Nav Buttons
            const btnBack = this.$('#btn-back');
            const btnHome = this.$('#btn-home');

            if (btnBack) btnBack.onclick = () => router.back();
            if (btnHome) btnHome.onclick = () => router.navigate('/home');

            // Favorite Button
            const btnFav = this.$('#btn-person-favorite');
            if (btnFav) {
                btnFav.onclick = () => this._toggleFavorite();
            }

            // 1. Fetch Person Details
            this._person = await api.getPerson(this._personId);
            this._person = await api.getPerson(this._personId);
            this.title = this._person.Name;

            this._updateFavoriteState();

            this._renderPersonInfo();

            // 2. Fetch Works (fast - no People field)
            const result = await api.getPersonItems(this._personId);
            this._items = result.Items || [];

            // Debug log to verify data
            console.log('PersonPage: Loaded items', {
                total: this._items.length,
                movies: this._items.filter(i => i.Type === 'Movie').length,
                shows: this._items.filter(i => i.Type === 'Series').length,
                episodes: this._items.filter(i => i.Type === 'Episode').length
            });

            this._renderWorks();

            // Set background (Person's own, or fallback to best work)
            this._setSmartBackdrop();

            // 3. Background: Fetch role names and update UI when ready
            this._loadRolesInBackground();

        } catch (error) {
            console.error('PersonPage: Failed to load', error);
            this.showError('Failed to load person details');
        } finally {
            this.setLoading(false);

            // Focus Nav first
            this.setActiveSection('person-actions');
        }
    }

    _setSmartBackdrop() {
        const backdropEl = this.$('#person-backdrop');
        if (!backdropEl) return;

        let backdropUrl = null;

        // 1. Try Person's own backdrop
        if (this._person.BackdropImageTags && this._person.BackdropImageTags.length > 0) {
            backdropUrl = api.getImageUrl(this._person.Id, 'Backdrop', { maxWidth: 1920 });
        }

        // 2. Fallback: Try most recent Movie/Series with a backdrop
        if (!backdropUrl && this._items.length > 0) {
            const bestWork = this._items.find(i =>
                (i.Type === 'Movie' || i.Type === 'Series') &&
                i.BackdropImageTags &&
                i.BackdropImageTags.length > 0
            );

            if (bestWork) {
                backdropUrl = api.getImageUrl(bestWork.Id, 'Backdrop', { maxWidth: 1920 });
            }
        }

        if (backdropUrl) {
            backdropEl.style.backgroundImage = `url('${backdropUrl}')`;
            backdropEl.style.opacity = '1'; // Fade in
        }
    }

    async _toggleFavorite() {
        if (!this._person) return;

        try {
            const isFavorite = this._person.UserData?.IsFavorite;
            if (isFavorite) {
                await api.unmarkFavorite(this._personId);
                this._person.UserData.IsFavorite = false;
            } else {
                await api.markFavorite(this._personId);
                if (!this._person.UserData) this._person.UserData = {};
                this._person.UserData.IsFavorite = true;
            }
            this._updateFavoriteState();
        } catch (e) {
            console.error('PersonPage: Failed to toggle favorite', e);
        }
    }

    _updateFavoriteState() {
        const btn = this.$('#btn-person-favorite');
        if (!btn || !this._person) return;

        const isFavorite = this._person.UserData?.IsFavorite;
        if (isFavorite) {
            btn.classList.add('active');
            btn.innerHTML = `
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-red-500">
                        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path>
                    </svg>`;
        } else {
            btn.classList.remove('active');
            btn.innerHTML = `
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path>
                    </svg>`;

        }
    }

    /**
     * Load character roles in background and update cards when ready
     */
    async _loadRolesInBackground() {
        try {
            const result = await api.getPersonItemsWithRoles(this._personId);
            const itemsWithPeople = result.Items || [];

            // Build role lookup map: itemId -> role name (store on instance for reuse)
            this._roleMap = new Map();
            itemsWithPeople.forEach(item => {
                if (item.People) {
                    const person = item.People.find(p => p.Id === this._personId);
                    if (person?.Role) {
                        this._roleMap.set(item.Id, person.Role);
                    }
                }
            });

            // Apply roles to visible cards
            this._applyRolesToCards();

            console.log(`PersonPage: Added ${this._roleMap.size} character roles`);
        } catch (error) {
            // Silent fail - roles are optional enhancement
            console.warn('PersonPage: Could not load character roles', error);
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
                    if (!currentText.includes('as ')) {
                        subtitle.textContent = currentText ? `${currentText} · as ${role}` : `as ${role}`;
                    }
                } else {
                    // Create subtitle if it doesn't exist
                    const cardInfo = card.querySelector('.card-info');
                    if (cardInfo) {
                        const newSubtitle = document.createElement('div');
                        newSubtitle.className = 'card-subtitle';
                        newSubtitle.textContent = `as ${role}`;
                        cardInfo.appendChild(newSubtitle);
                    }
                }
            }
        });
    }

    _renderPersonInfo() {
        const p = this._person;

        // Name
        const nameEl = this.$('#person-name');
        if (nameEl) nameEl.textContent = p.Name;

        // Poster
        const posterContainer = this.$('#person-poster');
        let imgHtml = '';
        if (p.ImageTags?.Primary) {
            // Person POSTER
            const url = api.getImageUrl(p.Id, 'Primary', { maxWidth: 400 });
            imgHtml = `<img src="${url}" alt="${p.Name}" class="loaded" />`;
        } else {
            // SVG Fallback
            imgHtml = `
                <div class="person-fallback">
                     <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" />
                        <circle cx="12" cy="7" r="4" />
                    </svg>
                </div>
            `;
        }
        posterContainer.innerHTML = imgHtml;

        // Bio
        if (p.Overview) {
            this.$('#person-bio').textContent = p.Overview;
        } else {
            this.$('#person-bio').style.display = 'none';
        }

        // Meta (Born / Place)
        const metaContainer = this.$('#person-meta');
        let metaHtml = '';

        // Born
        if (p.PremiereDate) {
            const date = new Date(p.PremiereDate);
            const bornDate = date.toLocaleDateString();
            metaHtml += `<span class="meta-item">Born: ${bornDate}</span>`;
        }

        // ProductionLocations
        if (p.ProductionLocations && p.ProductionLocations.length > 0) {
            metaHtml += `<span class="meta-item">in ${p.ProductionLocations[0]}</span>`;
        }

        metaContainer.innerHTML = metaHtml;

        // Fade in
        this.$('#person-info-col').classList.add('visible');
    }

    _renderWorks() {
        const worksContainer = this.$('#person-works');
        worksContainer.innerHTML = ''; // Clear previous

        // Helper: Find character name for this person in an item
        const getRole = (item) => {
            if (!item.People) return null;
            const person = item.People.find(p => p.Id === this._personId);
            return person?.Role || null;
        };

        // Categories - get all movies/shows with roles, limit episodes to 100
        const movies = this._items
            .filter(i => i.Type === 'Movie')
            .map(item => ({ ...item, _roleName: getRole(item) }));

        const shows = this._items
            .filter(i => i.Type === 'Series')
            .map(item => ({ ...item, _roleName: getRole(item) }));

        const episodes = this._items
            .filter(i => i.Type === 'Episode')
            .slice(0, 100);

        // Create Components
        this._grids = {};

        // 1. Movies
        if (movies.length > 0) {
            this._grids.movies = new MediaGrid({
                id: 'person-movies',
                title: 'Movies',
                items: movies,
                type: 'poster',
                limit: 12,
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
                title: 'Shows',
                items: shows,
                type: 'poster',
                limit: 12,
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
                title: 'Episodes',
                items: episodes,
                type: 'episode-primary', // Use special type
                isLandscape: true, // Force landscape grid
                limit: 10,
                onSeeMore: () => this._registerWorkSections()
            });
            this._grids.episodes.mount(worksContainer);
        }

        // Register focus
        this._registerWorkSections();
    }

    _registerWorkSections() {
        // We iterate our created grids in order of appearance
        // Order: movies, shows, episodes
        const sectionOrder = ['movies', 'shows', 'episodes'];
        const activeTypes = sectionOrder.filter(type => this._grids[type]);

        if (activeTypes.length === 0) return;

        const firstType = activeTypes[0];

        // 1. Header Logic
        const headerEl = this.$('#person-actions');
        if (headerEl) {
            this.registerFocusSection('person-actions', headerEl, {
                orientation: 'horizontal',
                leaveDown: 'person-fav-actions'
            });

            // 1.5 Favorite Button Row
            const favActionsEl = this.$('#person-fav-actions');
            if (favActionsEl) {
                this.registerFocusSection('person-fav-actions', favActionsEl, {
                    orientation: 'horizontal',
                    leaveUp: 'person-actions',
                    leaveDown: `person-${firstType}-items`
                });
            }
        }

        // 2. Register Each Grid
        activeTypes.forEach((type, index) => {
            const gridComp = this._grids[type];
            const baseId = gridComp.id; // e.g. 'person-movies'

            // IDs defined in MediaGrid
            const gridZone = `${baseId}-items`; // The grid container
            const btnZone = `${baseId}-btn-zone`; // Wrapper around button (custom reg name)
            const btnId = `${baseId}-btn`;      // The actual button ID

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
                    leaveDown: gridLeaveDown
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
                    leaveDown: btnLeaveDown
                });
            }
        });
    }

    _setupFocus() {
        if (!this.container) return;

        // Initialize Header if not exists
        if (!this._header) {
            this._header = new SimpleHeader({
                this._header = new SimpleHeader({
                    id: 'person-actions',
                    parentId: 'person-page'
                });
                this._header.mount(this.$('#person-header-container'));
            }

        // 1. Top Buttons (Back/Home)
        this.registerFocusSection('person-actions', this._header.el, {
                orientation: 'horizontal',
                leaveDown: 'person-fav-actions'
            });

            // 2. Favorite Action Row
            this.registerFocusSection('person-fav-actions', this.$('#person-fav-actions'), {
                orientation: 'horizontal',
                leaveUp: 'person-actions',
                leaveDown: null // Updated by _registerWorkSections
            });
        }

        destroy() {
            if (this._header) {
                this._header.destroy();
                this._header = null;
            }

            // Destroy sub-components
            Object.values(this._grids).forEach(comp => comp.destroy());
            this._grids = {};
            super.destroy();
        }
    }

export default PersonPage;
