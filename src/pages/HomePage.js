/**
 * ============================================================================
 * Litefin Tizen - Home Page
 * ============================================================================
 * Main landing page after login showing:
 * - Continue watching row
 * - Next up episodes
 * - Latest items per library
 * ============================================================================
 */

import Page from './Page.js';
import { api, auth } from '../api/index.js';
import { state } from '../core/StateManager.js';
import { router } from '../core/Router.js';
import { eventBus } from '../core/EventBus.js';
import VirtualList from '../ui/VirtualList.js';
import { animationManager } from '../ui/AnimationManager.js';
import { focusManager } from '../ui/FocusManager.js';

class HomePage extends Page {
    constructor() {
        super();
        this.title = 'Home';

        this._libraries = [];
        this._rows = [];
    }

    render() {
        return `
            <div class="page home-page">
                <!-- Header -->
                <header class="page-header">
                    <div class="header-left">
                        <button class="nav-btn menu-btn icon-only" aria-label="Menu" tabindex="0">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <line x1="5" y1="7" x2="19" y2="7"></line>
                                <line x1="5" y1="12" x2="19" y2="12"></line>
                                <line x1="5" y1="17" x2="19" y2="17"></line>
                            </svg>
                        </button>
                        <div class="header-logo">
                            <span class="logo-text">LiteFin</span>
                        </div>
                    </div>
                    <nav class="header-mid">
                        <button class="nav-text-btn home-nav-btn active" tabindex="0">Home</button>
                        <button class="nav-text-btn favorites-nav-btn" tabindex="0">Favorites</button>
                    </nav>
                    <nav class="header-nav">
                        <button class="nav-btn search-btn icon-only" aria-label="Search" tabindex="0">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <circle cx="11" cy="11" r="8"></circle>
                                <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                            </svg>
                        </button>
                        <button class="nav-btn user-btn icon-only" aria-label="User Profile" tabindex="0">
                            ${this._renderUserAvatar()}
                        </button>
                        <button class="nav-btn settings-btn icon-only" aria-label="Settings" tabindex="0">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <circle cx="12" cy="12" r="3"></circle>
                                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
                            </svg>
                        </button>
                    </nav>
                </header>
                
                <!-- Content rows -->
                <main class="page-content" id="home-content">
                    <div class="page-error" style="display: none;"></div>
                    <div class="home-rows">
                        <!-- Rows will be rendered here -->
                    </div>
                    
                    <!-- Loading state -->
                    <div class="page-loading">
                        <div class="loading-spinner"></div>
                    </div>
                </main>
            </div>
        `;
    }

    async onInit() {
        // Safety check: Ensure we are authenticated
        if (!api.isAuthenticated) {
            console.warn('HomePage: Not authenticated, redirecting to login');
            router.navigate('/login', { replace: true });
            return;
        }

        // Setup navigation
        this._bindNavigation();

        // Setup focus
        this._setupFocus();

        // Load content
        await this._loadContent();
    }

    _bindNavigation() {
        // Menu button
        this.$('.menu-btn')?.addEventListener('click', () => {
            console.log('Menu clicked - TODO: Implement sidebar');
        });

        // Center Nav
        this.$('.home-nav-btn')?.addEventListener('click', () => {
            // Already on home, maybe scroll to top?
            document.querySelector('.page-content').scrollTo({ top: 0, behavior: 'smooth' });
        });
        this.$('.favorites-nav-btn')?.addEventListener('click', () => {
            router.navigate('/favorites');
        });

        // Search button
        this.$('.search-btn')?.addEventListener('click', () => {
            router.navigate('/search');
        });

        // User button (Placeholder for now)
        this.$('.user-btn')?.addEventListener('click', () => {
            console.log('User profile clicked - TODO: Implement profile page');
            // Placeholder: Maybe toast "Profile not implemented yet"
        });

        // Settings button
        this.$('.settings-btn')?.addEventListener('click', () => {
            router.navigate('/settings');
        });
    }

    _setupFocus() {
        // Register header as focus section
        this.registerFocusSection('home-header', this.$('.page-header'), {
            orientation: 'horizontal',
            leaveDown: 'home-row-0'
        });

        this.setActiveSection('home-header');
    }

    async _loadContent() {
        this.setLoading(true);
        this.hideError();

        // Capture state BEFORE request (in case 401 clears it)
        const preAuth = {
            uid: api._userId,
            dev: api._deviceId,
            hasTok: !!api._accessToken
        };

        try {
            console.log(`HomePage: Loading content for user ${preAuth.uid}`);

            // Test simple call first
            await api.getCurrentUser();

            // Get user libraries
            const viewsResponse = await api.getUserViews();
            this._libraries = viewsResponse.Items || [];

            // ========================================================
            // OPTIMIZATION: Fetch all data in PARALLEL instead of sequential
            // ========================================================
            const [resumeItems, nextUp, ...latestResults] = await Promise.all([
                api.getResumeItems(),
                api.getNextUp(),
                // Map libraries to fetch requests
                ...this._libraries.map(lib =>
                    api.getLatestItems(lib.Id, { Limit: 20 }).catch(e => {
                        console.warn(`Failed to load latest for ${lib.Name}`, e);
                        return null; // Return null on error, filter later
                    })
                )
            ]);

            // Build rows data from parallel results
            const rowsData = [];

            // 1. Continue watching
            if (resumeItems?.Items?.length > 0) {
                rowsData.push({
                    title: 'Continue Watching',
                    items: resumeItems.Items,
                    type: 'resume'
                });
            }

            // 2. Next up
            if (nextUp?.Items?.length > 0) {
                rowsData.push({
                    title: 'Next Up',
                    items: nextUp.Items,
                    type: 'episode'
                });
            }

            // 3. Latest per library (from parallel results)
            latestResults.forEach((latest, i) => {
                if (latest?.length > 0) {
                    rowsData.push({
                        title: `Recently Added In ${this._libraries[i].Name}`,
                        items: latest,
                        libraryId: this._libraries[i].Id,
                        type: 'latest'
                    });
                }
            });

            // Render rows
            this._renderRows(rowsData);

            if (rowsData.length === 0 && this._libraries.length === 0) {
                this.showError('No libraries found. Please check your Jellyfin user permissions.');
            }

        } catch (error) {
            console.error('HomePage: Failed to load content', error);

            // Use captured state for debug
            const debug = `UID:${preAuth.uid} Dev:${preAuth.dev} Tok:${preAuth.hasTok ? 'OK' : 'MISS'}`;
            const status = error.status ? `HTTP ${error.status}` : 'ERR';

            this.showError(`${status}: ${error.message} [${debug}]`);
        }

        this.setLoading(false);
    }

    _renderRows(rowsData) {
        const container = this.$('.home-rows');
        if (!container) return;

        // ========================================================
        // OPTIMIZATION: Build HTML using array push (faster than map().join())
        // ========================================================
        const htmlParts = [];

        for (let i = 0; i < rowsData.length; i++) {
            const row = rowsData[i];
            // Determine card style based on row type
            const isLandscape = row.type === 'resume' || row.type === 'episode';

            htmlParts.push(`<section class="media-row" data-row-index="${i}">`);
            htmlParts.push(`<h2 class="row-title">${row.title}</h2>`);
            htmlParts.push(`<div class="row-items" id="row-items-${i}">`);

            // Inline card rendering to avoid function call overhead per item
            for (const item of row.items) {
                htmlParts.push(this._renderMediaCard(item, isLandscape));
            }

            htmlParts.push('</div></section>');
        }

        container.innerHTML = htmlParts.join('');

        // Register focus sections for each row
        for (let i = 0; i < rowsData.length; i++) {
            const rowEl = container.querySelector(`[data-row-index="${i}"]`);
            this.registerFocusSection(`home-row-${i}`, rowEl, {
                orientation: 'horizontal',
                leaveUp: i === 0 ? 'home-header' : `home-row-${i - 1}`,
                leaveDown: i < rowsData.length - 1 ? `home-row-${i + 1}` : null
            });
        }

        // ========================================================
        // OPTIMIZATION: Event Delegation instead of per-card listeners
        // ========================================================
        container.addEventListener('click', (e) => {
            const card = e.target.closest('.media-card');
            if (card?.dataset?.itemId) {
                router.navigate(`/details/${card.dataset.itemId}`);
            }
        });

        // Focus/Blur delegation (these bubble)
        container.addEventListener('focusin', (e) => {
            if (e.target.classList.contains('media-card')) {
                animationManager.focusScale(e.target, true);
            }
        });
        container.addEventListener('focusout', (e) => {
            if (e.target.classList.contains('media-card')) {
                animationManager.focusScale(e.target, false);
            }
        });

        // Set first row as active if content loaded
        if (rowsData.length > 0) {
            // Use requestAnimationFrame to ensure DOM is painted and offsetParent is valid
            requestAnimationFrame(() => {
                // Invalidate cache for strict safety
                rowsData.forEach((_, i) => focusManager.invalidateCache(`home-row-${i}`));

                this.setActiveSection('home-row-0');

                // Fallback: If no element focused, try focusing first card manually
                if (!focusManager.getFocused()) {
                    const firstCard = container.querySelector('[data-row-index="0"] .media-card');
                    if (firstCard) {
                        focusManager.focusElement(firstCard);
                    } else {
                        // Worst case: back to header
                        this.setActiveSection('home-header');
                    }
                }
            });
        }
    }

    /**
     * Renders a single media card.
     * @param {Object} item - Jellyfin item data
     * @param {boolean} isLandscape - True for 16:9 cards (Resume/Next Up), false for 2:3 posters
     * @returns {string} HTML string
     */
    _renderMediaCard(item, isLandscape) {
        let imageUrl = '';

        if (isLandscape) {
            // Resume / Next Up (Landscape):

            if (item.Type === 'Episode') {
                // EPISODES (Next Up): 
                // Priority: Series Thumb (Logo) -> Series Backdrop -> Episode Screenshot

                if (item.SeriesThumbImageTag && item.SeriesId) {
                    // Best: Series Thumb (Logo/Card)
                    imageUrl = api.getImageUrl(item.SeriesId, 'Thumb', { maxWidth: 400, tag: item.SeriesThumbImageTag });
                } else if (item.ParentThumbItemId && item.ParentThumbImageTag) {
                    // Check Parent Thumb (usually same as Series Thumb)
                    imageUrl = api.getImageUrl(item.ParentThumbItemId, 'Thumb', { maxWidth: 400, tag: item.ParentThumbImageTag });
                } else if (item.ParentBackdropItemId) {
                    // Fallback: Series Backdrop
                    imageUrl = api.getImageUrl(item.ParentBackdropItemId, 'Backdrop', { maxWidth: 400 });
                } else if (item.SeriesId) {
                    // Fallback: Series Backdrop via ID (without tag, might not cache well but works)
                    imageUrl = api.getImageUrl(item.SeriesId, 'Backdrop', { maxWidth: 400 });
                }

                // Final fallback to episode screenshot if absolutely no show image found
                if (!imageUrl && item.ImageTags && item.ImageTags.Primary) {
                    imageUrl = api.getImageUrl(item.Id, 'Primary', { maxWidth: 400, tag: item.ImageTags.Primary });
                }
            }
            else {
                // MOVIES / SERIES: 'Primary' is a vertical poster. 
                // We prefer 'Thumb' (Landscape) -> 'Backdrop' (Landscape) -> 'Primary' (Fallback)
                if (item.ImageTags && item.ImageTags.Thumb) {
                    imageUrl = api.getImageUrl(item.Id, 'Thumb', { maxWidth: 400, tag: item.ImageTags.Thumb });
                } else if (item.BackdropImageTags && item.BackdropImageTags.length > 0) {
                    imageUrl = api.getImageUrl(item.Id, 'Backdrop', { maxWidth: 400 });
                } else {
                    imageUrl = api.getImageUrl(item.Id, 'Primary', { maxWidth: 300, tag: item.ImageTags?.Primary });
                }
            }

            // Final fallback if nothing found above
            if (!imageUrl) {
                imageUrl = api.getImageUrl(item.Id, 'Primary', { maxWidth: 300, tag: item.ImageTags?.Primary });
            }

        } else {
            // Latest / Poster Lists
            // User request: "If it's an episode, use the card shape with the SHOWS poster"
            if (item.Type === 'Episode' && item.SeriesId) {
                // Use Series Primary Image (Poster)
                imageUrl = api.getImageUrl(item.SeriesId, 'Primary', { maxWidth: 300 });
            } else {
                // Standard Poster
                imageUrl = api.getImageUrl(item.Id, 'Primary', { maxWidth: 300, tag: item.ImageTags?.Primary });
            }
        }

        // Progress bar for resume items
        let progressHtml = '';
        if (item.UserData?.PlaybackPositionTicks && item.RunTimeTicks) {
            const progress = (item.UserData.PlaybackPositionTicks / item.RunTimeTicks) * 100;
            console.log(`[PROGRESS DEBUG] ${item.Name}: Percent=${progress.toFixed(1)}%`);
            // Use linear-gradient for progress - more reliable than nested div width
            progressHtml = `<div class="progress-bar" style="background: linear-gradient(to right, var(--jf-accent) ${progress}%, rgba(0,0,0,0.6) ${progress}%);"></div>`;
        }

        // Text Content Logic
        let titleText = item.Name;
        let subtitleText = '';

        if (item.Type === 'Episode') {
            if (isLandscape) {
                // Next Up / Continue Watching:
                // Title: Show Name
                // Subtitle: Sxx:Exx - Episode Name
                titleText = item.SeriesName || item.Name;
                subtitleText = `S${item.ParentIndexNumber}:E${item.IndexNumber} - ${item.Name}`;
            } else {
                // Latest (Poster):
                // Title: Episode Name
                // Subtitle: Sxx:Exx
                subtitleText = `S${item.ParentIndexNumber}:E${item.IndexNumber}`;
            }
        } else if (item.ProductionYear) {
            subtitleText = item.ProductionYear;
        }

        return `
            <button class="media-card ${isLandscape ? 'landscape' : ''}" data-item-id="${item.Id}" tabindex="0">
                <div class="card-image">
                    <img 
                        src="${imageUrl}" 
                        alt="${titleText}"
                        onerror="this.style.visibility='hidden'"
                    >
                    ${progressHtml}
                </div>
                <div class="card-info">
                    <p class="card-title">${titleText}</p>
                    ${subtitleText ? `<p class="card-subtitle">${subtitleText}</p>` : ''}
                </div>
            </button>
        `;
    }

    onBack() {
        // Show exit confirmation or go to login
        eventBus.emit('app:exitRequested');
    }

    _renderUserAvatar() {
        const user = auth.getCurrentUser();
        if (!user) return '<span class="icon">👤</span>';

        // Use high-res avatar
        const imageUrl = user.PrimaryImageTag
            ? api.getUserImageUrl(user.Id, { maxWidth: 100 })
            : '';

        if (imageUrl) {
            return `<img src="${imageUrl}" class="header-avatar" alt="${user.Name}" onerror="this.style.display='none'">`;
        }

        return `<div class="header-avatar-placeholder">${user.Name.charAt(0).toUpperCase()}</div>`;
    }
}

export default HomePage;
