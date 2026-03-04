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
// AnimationManager removed — CSS .focused class handles card scale via GPU compositor

import { focusManager } from '../ui/FocusManager.js';
import { lazyLoader } from '../utils/LazyLoader.js';
import { storage } from '../utils/StorageService.js';
import { logger } from '../utils/Logger.js';
import { i18n } from '../utils/i18n.js';
import { imageCache } from '../utils/ImageCache.js';
import { imageService } from '../utils/ImageService.js';

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
        this._isMounted = true;

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
        this._isMounted = false;
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
            // with a max-concurrency limiter to avoid blowing up the browser's
            // connection limit (typically 6 active connections).
            // ========================================================

            // 1. Fire critical top rows immediately — they take priority
            const [resumeItems, nextUp] = await Promise.all([api.getResumeItems(), api.getNextUp()]);

            if (!this._isMounted) return;

            // 2. Batch library requests with max concurrency of 4
            const libraryTasks = this._libraries.map((lib) => async () => {
                try {
                    return await api.getLatestItems(lib.Id);
                } catch (e) {
                    log.warn(`Failed to load latest for ${lib.Name}`, e);
                    return null;
                }
            });

            const latestResults = await this._fetchWithConcurrency(libraryTasks, 4);

            if (!this._isMounted) return;

            // Build rows data from parallel results
            const rowsData = [];

            // 0. My Media (Libraries)

            // Check user preference
            const hideMyMedia = storage.getItem('pref:hideMyMedia') === 'true';

            if (!hideMyMedia && this._libraries.length > 0) {
                rowsData.push({
                    title: i18n.t('HeaderMyMedia'),
                    items: this._libraries,
                    type: 'library'
                });
            }

            // 1. Continue watching
            if (resumeItems?.Items?.length > 0) {
                rowsData.push({
                    title: i18n.t('HeaderContinueWatching'),
                    items: resumeItems.Items,
                    type: 'resume'
                });
            }

            // 2. Next up
            if (nextUp?.Items?.length > 0) {
                rowsData.push({
                    title: i18n.t('NextUp'),
                    items: nextUp.Items,
                    type: 'episode',
                    contextType: 'nextUp' // Trigger spoiler prevention
                });
            }

            // 3. Latest per library (from parallel results)
            latestResults.forEach((latest, i) => {
                if (latest?.length > 0) {
                    rowsData.push({
                        title: i18n.t('LatestFromLibrary', [this._libraries[i].Name]),
                        items: latest,
                        libraryId: this._libraries[i].Id,
                        type: 'latest',
                        cardType: this._libraries[i].CollectionType === 'music' ? 'square' : 'poster'
                    });
                }
            });

            // ================================================================
            // IMAGE CACHE PRE-WARMING
            // Fire background fetches for all homepage image URLs before rendering.
            // By the time LazyLoader triggers each image, the blob will likely
            // already be in IndexedDB and the in-memory map — instant load.
            // ================================================================
            this._preWarmImageCache(rowsData);

            // Render rows (awaits focus restoration to prevent visual jumping)
            await this._renderRows(rowsData);

            if (rowsData.length === 0 && this._libraries.length === 0) {
                this.showError(i18n.t('NoLibraries'));
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

        // Notify base Page class that async content is ready for focus restoration
        this.restoreScrollFocusWhenReady();

        // Final Focus Check: If nothing is focused yet (e.g. empty results or error),
        // focus the header so navigation is possible.
        if (!focusManager.getActiveSection() && !focusManager.getFocused()) {
            this.setActiveSection('sidebar');
        }
    }

    /**
     * Executes an array of async functions with a maximum concurrency limit.
     */
    async _fetchWithConcurrency(tasks, concurrencyMax) {
        const results = new Array(tasks.length);
        let currentIndex = 0;

        const worker = async () => {
            while (currentIndex < tasks.length) {
                const i = currentIndex++;
                results[i] = await tasks[i]();
            }
        };

        const workers = Array.from({ length: Math.min(concurrencyMax, tasks.length) }, worker);
        await Promise.all(workers);
        return results;
    }

    /**
     * Collect all image URLs that will be needed for the homepage rows
     * and hand them to ImageCache for background pre-fetching.
     * Only covers the Jellyfin image types that CardRenderer uses on the
     * homepage: Primary, Thumb, and Backdrop — with the same size params
     * that ImageService would pick for each layout.
     *
     * @param {Array} rowsData - Array of row descriptor objects from _loadContent
     * @private
     */
    _preWarmImageCache(rowsData) {
        const urls = [];
        const MAX_PER_ROW = 10; // Only cache a screen-worth per row

        for (const row of rowsData) {
            if (!row.items || row.items.length === 0) continue;

            // Determine if this row uses landscape (thumb/backdrop) or poster sizing
            const isLandscape = row.type === 'resume' || row.type === 'episode' || row.type === 'library';
            const sizeType = isLandscape ? 'backdrop' : 'poster';
            const { maxWidth, quality } = imageService.getParams(sizeType);

            // Take at most MAX_PER_ROW items to keep pre-warming bounded
            const items = row.items.slice(0, MAX_PER_ROW);

            for (const item of items) {
                const itemId = item.Id;
                let url = null;

                if (isLandscape) {
                    // Prefer Thumb — fall through to Backdrop — then Primary
                    if (item.ImageTags?.Thumb) {
                        url = api.getImageUrl(itemId, 'Thumb', { maxWidth, quality, tag: item.ImageTags.Thumb });
                    } else if (item.BackdropImageTags?.length > 0) {
                        url = api.getImageUrl(itemId, 'Backdrop', { maxWidth, quality });
                    } else if (item.SeriesId && item.SeriesThumbImageTag) {
                        url = api.getImageUrl(item.SeriesId, 'Thumb', {
                            maxWidth,
                            quality,
                            tag: item.SeriesThumbImageTag
                        });
                    } else if (item.ImageTags?.Primary) {
                        url = api.getImageUrl(itemId, 'Primary', { maxWidth, quality, tag: item.ImageTags.Primary });
                    }
                } else {
                    // Poster mode — prefer item Primary, fall back to Series Primary
                    if (item.ImageTags?.Primary) {
                        url = api.getImageUrl(itemId, 'Primary', { maxWidth, quality, tag: item.ImageTags.Primary });
                    } else if (item.SeriesId) {
                        url = api.getImageUrl(item.SeriesId, 'Primary', { maxWidth, quality });
                    }
                }

                if (url) urls.push(url);
            }
        }

        if (urls.length > 0) {
            // Fire background pre-fetch — non-blocking
            imageCache.preload(urls);
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
                cardType: row.cardType || 'poster',
                visibleCount: isLandscape ? 8 : 12, // Sliding window size after initial load
                // Pre-render items at construction time so every row is ready before the
                // user scrolls to it, eliminating on-demand DOM creation lag.
                // Landscape rows only pre-render 5 cards — they are ~400px wide so ~4-5
                // fit on a 1920px screen, keeping memory usage tight. Portrait rows get
                // the full set since they're narrower and pack more cards per screen.
                // The sliding window takes over on first navigation and evicts stale nodes.
                initialWindow: isLandscape ? 5 : row.items.length,
                focusSectionId: `home-row-${i}`,
                renderCard: (item) =>
                    this._renderMediaCard(item, isLandscape, row.cardType || row.type, row.contextType || row.type)
            });
            this._virtualRows.push(virtualRow);

            // Register Focus section with VirtualCardRow hook interception
            // OPTIMIZATION: Register focus on .row-items (which has CSS containment) instead of .media-row.
            // This isolates layout recalculations during scroll, matching FavoritesPage performance.
            const itemsContainer = sectionEl.querySelector('.row-items');
            this.registerFocusSection(`home-row-${i}`, itemsContainer, {
                orientation: 'horizontal',
                leaveUp: i === 0 ? null : `home-row-${i - 1}`, // Top row leaves up to nothing (or header)
                leaveDown: i < rowsData.length - 1 ? `home-row-${i + 1}` : null,
                leaveLeft: 'sidebar', // Navigate to Sidebar on left
                onMove: (direction, currentElement) => {
                    // Failsafe: if we don't have a valid element, let spatial nav take over.
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
                        // OPTIMIZATION: Only update the window if the node isn't already in the DOM
                        // (i.e. the user has scrolled so far that the current index is unmounted).
                        // Flying past rows during fast vertical scroll should NOT trigger DOM mutations.
                        const existingNode = virtualRow.domNodes.get(virtualRow.currentIndex);
                        if (!existingNode || !existingNode.isConnected) {
                            virtualRow._updateWindow(virtualRow.currentIndex);
                        }
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
                // Save clicked item and its row index for exact focus restoration
                const row = card.closest('.media-row');
                const rowIndex = row ? row.dataset.rowIndex : '0';

                state.set('home:lastFocusedItem', {
                    itemId: card.dataset.itemId,
                    rowIndex: rowIndex
                });

                const type = card.dataset.contextType;
                if (type === 'library') {
                    router.navigate(`/library/${card.dataset.itemId}`);
                } else {
                    router.navigate(`/details/${card.dataset.itemId}`);
                }
            }
        });

        // Focus delegation (bubbles from all card descendants)
        // NOTE: We do NOT call animationManager.focusScale here because that writes
        // inline style.transition and style.transform synchronously on every keypress,
        // forcing costly style recalculations during the active rAF scroll loop on Tizen.
        // The CSS `.focused` class applied by FocusManager handles scale via the GPU
        // compositor without any layout invalidation — identical to FavoritesPage behavior.
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
            }
        });

        // Return a promise that resolves after the DOM is updated and focus is restored
        return new Promise((resolve) => {
            // Set first row as active if content loaded
            if (rowsData.length > 0) {
                // Use requestAnimationFrame to ensure DOM is painted and offsetParent is valid
                requestAnimationFrame(() => {
                    // Check for saved focus to restore (from back navigation)
                    // Fallback to legacy 'home:lastFocusedItemId' if 'home:lastFocusedItem' object doesn't exist yet
                    const lastFocusedObj = state.get('home:lastFocusedItem');
                    const legacyLastFocusedId = state.get('home:lastFocusedItemId');

                    let restoredFocus = false;

                    if (lastFocusedObj || legacyLastFocusedId) {
                        const targetId = lastFocusedObj ? lastFocusedObj.itemId : legacyLastFocusedId;
                        const targetRowIndex = lastFocusedObj ? lastFocusedObj.rowIndex : null;

                        let savedCard = null;

                        // First try to find it in the specific row
                        if (targetRowIndex !== null) {
                            const targetRow = container.querySelector(`.media-row[data-row-index="${targetRowIndex}"]`);
                            if (targetRow) {
                                savedCard = targetRow.querySelector(`.media-card[data-item-id="${targetId}"]`);
                            }
                        }

                        // Fallback to finding it anywhere if exact row match failed
                        if (!savedCard) {
                            savedCard = container.querySelector(`.media-card[data-item-id="${targetId}"]`);
                        }

                        if (savedCard) {
                            // Find which row it's in and set that section active
                            const row = savedCard.closest('.media-row');
                            if (row) {
                                const rowIndex = row.dataset.rowIndex;
                                // Set section active but DO NOT restore focus automatically,
                                // because we are about to instantly focus the specific card.
                                this.setActiveSection(`home-row-${rowIndex}`, false);
                                focusManager.focusElement(savedCard, { instantScroll: true });
                                restoredFocus = true;
                            }
                        } else if (targetRowIndex !== null && this._virtualRows[targetRowIndex]) {
                            // OPTIMIZATION: Item was virtualized out of the DOM — restore via index lookup in the data array
                            const vRow = this._virtualRows[targetRowIndex];
                            // Try matching by Id (string/number agnostic)
                            const itemIndex = vRow.items.findIndex((i) => String(i.Id) === String(targetId));

                            if (itemIndex !== -1) {
                                const node = vRow.focusByIndex(itemIndex);
                                if (node) {
                                    this.setActiveSection(`home-row-${targetRowIndex}`, false);
                                    focusManager.focusElement(node, { instantScroll: true });
                                    restoredFocus = true;
                                }
                            }
                        }

                        // Clear the saved state after use
                        state.delete('home:lastFocusedItem');
                        state.delete('home:lastFocusedItemId');
                    }

                    // Default: focus first row if no restoration happened
                    if (!restoredFocus) {
                        this.setActiveSection('home-row-0', false);

                        // Fallback: If no element focused, try focusing first card manually
                        if (!focusManager.getFocused()) {
                            const firstCard = container.querySelector('[data-row-index="0"] .media-card');
                            if (firstCard) {
                                focusManager.focusElement(firstCard, { instantScroll: true });
                            } else {
                                // Worst case: back to header
                                this.setActiveSection('sidebar');
                            }
                        }
                    }

                    resolve();
                });
            } else {
                resolve();
            }
        });
    }

    onBack() {
        // Show exit confirmation or go to login
        eventBus.emit('app:exitRequested');
    }
}

export default HomePage;
