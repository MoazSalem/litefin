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
            console.error('PersonPage: No person ID provided');
            router.back();
            return;
        }

        this._loadPersonDetails();
    }

    render() {
        return `
            <div class="page person-page" id="person-page">
                <!-- Backdrop -->
                <div class="details-backdrop" id="person-backdrop">
                    <div class="backdrop-gradient"></div>
                </div>

                <div class="page-content">
                    <!-- Nav Header -->
                    <div class="nav-header media-row" id="person-actions">
                        <button class="btn btn-icon" id="btn-back" tabindex="0">
                            <!-- Arrow Left SVG -->
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="32" height="32">
                                <line x1="19" y1="12" x2="5" y2="12"></line>
                                <polyline points="12 19 5 12 12 5"></polyline>
                            </svg>
                        </button>
                        <button class="btn btn-icon" id="btn-home" tabindex="0">
                            <!-- Home SVG -->
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="30" height="30">
                                <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
                                <polyline points="9 22 9 12 15 12 15 22"></polyline>
                            </svg>
                        </button>
                    </div>

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

            // 1. Fetch Person Details
            this._person = await api.getPerson(this._personId);
            this.title = this._person.Name;

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
            this._setupFocus();
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

        // 1. Header Logic
        const firstType = activeTypes[0];
        const headerEl = this.$('#person-actions');
        if (headerEl) {
            this.registerFocusSection('person-actions', headerEl, {
                orientation: 'horizontal',
                leaveDown: `person-${firstType}-items` // Link to first grid items
            });
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
            let gridLeaveUp = 'person-actions';
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
    }

    destroy() {
        // Destroy sub-components
        Object.values(this._grids).forEach(comp => comp.destroy());
        this._grids = {};
        super.destroy();
    }
}

export default PersonPage;
