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
import { api } from '../api/index.js';
import { VirtualCardRow } from '../components/VirtualCardRow.js';
import { state } from '../core/StateManager.js';
import { router } from '../core/Router.js';
import { eventBus } from '../core/EventBus.js';
import { animationManager } from '../ui/AnimationManager.js';

import { focusManager } from '../ui/FocusManager.js';
import { lazyLoader } from '../utils/LazyLoader.js';
import { storage } from '../utils/StorageService.js';
import { logger } from '../utils/Logger.js';

const log = logger.create('HomePage');

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

                
                <!-- Content rows -->
                <main class="page-content" id="home-content">
                    <div class="page-error" style="display: none;"></div>
                    <div class="home-rows">
                        <!-- Rows will be rendered here -->
                    </div>
                </main>
                

            </div>
        `;
    }

    onInit() {
        // Safety check: Ensure we are authenticated
        if (!api.isAuthenticated) {
            log.warn('Not authenticated, redirecting to login');
            router.navigate('/login', { replace: true });
            return;
        }

        // Setup focus
        this._setupFocus();

        // Load content
        this._loadContent();
    }

    onDestroyed() {
        if (this._clockInterval) {
            clearInterval(this._clockInterval);
        }
    }

    _setupFocus() {
        // NOTE: We do NOT set active section here anymore.
        // We wait for content to load.
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
            log.info(`Loading content for user ${preAuth.uid}`);

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
                ...this._libraries.map((lib) =>
                    api.getLatestItems(lib.Id, { Limit: 20 }).catch((e) => {
                        log.warn(`Failed to load latest for ${lib.Name}`, e);
                        return null; // Return null on error, filter later
                    })
                )
            ]);

            // Build rows data from parallel results
            const rowsData = [];

            // 0. My Media (Libraries)

            // Check user preference
            const hideMyMedia = storage.getItem('pref:hideMyMedia') === 'true';

            if (!hideMyMedia && this._libraries.length > 0) {
                rowsData.push({
                    title: 'My Media',
                    items: this._libraries,
                    type: 'library'
                });
            }

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
                    type: 'episode',
                    contextType: 'nextUp' // Trigger spoiler prevention
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
            log.error('Failed to load content', error);

            // Check if it's a network/timeout error
            // Import api here if needed, but we check name or property
            if (error.name === 'ServerUnreachableError' || error.isNetworkError) {
                log.warn('Server became unreachable during browsing. Redirecting to OfflinePage.');
                state.set('server:offline', true);
                state.set('user:authenticated', false); // Pause auth
                router.navigate('/offline', { replace: true });
                return;
            }

            // Use captured state for debug
            const debug = `UID:${preAuth.uid} Dev:${preAuth.dev} Tok:${preAuth.hasTok ? 'OK' : 'MISS'}`;
            const status = error.status ? `HTTP ${error.status}` : 'ERR';

            this.showError(`${status}: ${error.message} [${debug}]`);
        }

        this.setLoading(false);

        // Final Focus Check: If nothing is focused yet (e.g. empty results or error),
        // focus the header so navigation is possible.
        if (!focusManager.getActiveSection()) {
            this.setActiveSection('sidebar');
        }
    }

    _renderRows(rowsData) {
        const container = this.$('.home-rows');
        if (!container) return;

        // Clear existing rows
        container.innerHTML = '';

        // Track virtual row instances for index synchronization
        this._virtualRows = [];

        // Build HTML sections and instantiate VirtualCardRows
        for (let i = 0; i < rowsData.length; i++) {
            const row = rowsData[i];
            const isLandscape = row.type === 'resume' || row.type === 'episode' || row.type === 'library';

            // Create section wrapper
            const sectionDoc = document.createElement('div');
            sectionDoc.innerHTML = `
                <section class="media-row" data-row-index="${i}" data-lazy-row="true">
                    <h2 class="row-title">${row.title}</h2>
                    <div class="row-items" id="row-items-${i}">
                        <div class="row-items-track"></div>
                    </div>
                </section>
            `;
            const sectionEl = sectionDoc.firstElementChild;
            container.appendChild(sectionEl);

            // Initialize VirtualCardRow
            const trackContainer = sectionEl.querySelector('.row-items-track');
            const virtualRow = new VirtualCardRow(trackContainer, row.items, {
                isLandscape: isLandscape,
                visibleCount: isLandscape ? 8 : 12, // Load slightly more standard poster cards
                focusSectionId: `home-row-${i}`,
                renderCard: (item) => this._renderMediaCard(item, isLandscape, row.type, row.contextType || row.type)
            });
            this._virtualRows.push(virtualRow);

            // Register Focus section with VirtualCardRow hook interception
            this.registerFocusSection(`home-row-${i}`, sectionEl, {
                orientation: 'horizontal',
                leaveUp: i === 0 ? null : `home-row-${i - 1}`, // Top row leaves up to nothing (or header)
                leaveDown: i < rowsData.length - 1 ? `home-row-${i + 1}` : null,
                leaveLeft: 'sidebar', // Navigate to Sidebar on left
                onMove: (direction) => {
                    const nextNode = virtualRow.handleMove(direction);
                    if (nextNode) {
                        focusManager.focusElement(nextNode);
                        return true; // VirtualCardRow handled it
                    }
                    return false; // Reached bounds, let spatial exit section
                },
                onEnter: (fromElement, options) => {
                    // Only intercept for vertical entry.
                    // Instead of spatial X alignment, we restore the row's last focused index.
                    // This prevents rows from shifting and acting like grids.
                    if (fromElement && options && (options.direction === 'up' || options.direction === 'down')) {
                        // Ensure window is updated for current index before accessing DOM node
                        virtualRow._updateWindow(virtualRow.currentIndex);
                        return virtualRow.domNodes.get(virtualRow.currentIndex);
                    }
                    return null;
                },
                onRestoreIndex: (index) => {
                    return virtualRow.focusByIndex(index);
                }
            });
        }

        // Start lazy loading to catch any immediately visible cover art
        lazyLoader.observe(container);

        // ========================================================
        // OPTIMIZATION: Event Delegation instead of per-card listeners
        // ========================================================
        container.addEventListener('click', (e) => {
            const card = e.target.closest('.media-card');
            if (card?.dataset?.itemId) {
                // Save clicked item for focus restoration on back navigation
                state.set('home:lastFocusedItemId', card.dataset.itemId);

                const type = card.dataset.contextType;
                if (type === 'library') {
                    router.navigate(`/library/${card.dataset.itemId}`);
                } else {
                    router.navigate(`/details/${card.dataset.itemId}`);
                }
            }
        });

        // Focus/Blur delegation (these bubble)
        container.addEventListener('focusin', (e) => {
            if (e.target.classList.contains('media-card')) {
                // Sync VirtualCardRow internal index when focus jumps via Spatial Navigator
                const row = e.target.closest('.media-row');
                if (row && row.dataset.rowIndex !== undefined) {
                    const rowIndex = parseInt(row.dataset.rowIndex, 10);
                    if (this._virtualRows[rowIndex]) {
                        this._virtualRows[rowIndex].syncIndexFromNode(e.target);
                    }
                }
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

                // Check for saved focus to restore (from back navigation)
                const lastFocusedId = state.get('home:lastFocusedItemId');
                let restoredFocus = false;

                if (lastFocusedId) {
                    // Find the card with that item ID
                    const savedCard = container.querySelector(`.media-card[data-item-id="${lastFocusedId}"]`);
                    if (savedCard) {
                        // Find which row it's in and set that section active
                        const row = savedCard.closest('.media-row');
                        if (row) {
                            const rowIndex = row.dataset.rowIndex;
                            this.setActiveSection(`home-row-${rowIndex}`);
                            focusManager.focusElement(savedCard);
                            restoredFocus = true;
                        }
                    }
                    // Clear the saved state after use
                    state.delete('home:lastFocusedItemId');
                }

                // Default: focus first row if no restoration happened
                if (!restoredFocus) {
                    this.setActiveSection('home-row-0');

                    // Fallback: If no element focused, try focusing first card manually
                    if (!focusManager.getFocused()) {
                        const firstCard = container.querySelector('[data-row-index="0"] .media-card');
                        if (firstCard) {
                            focusManager.focusElement(firstCard);
                        } else {
                            // Worst case: back to header
                            this.setActiveSection('sidebar');
                        }
                    }
                }
            });
        }
    }

    onBack() {
        // Show exit confirmation or go to login
        eventBus.emit('app:exitRequested');
    }
}

export default HomePage;
