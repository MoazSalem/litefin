/**
 * ============================================================================
 * Litefin Tizen - Discover Page (Jellyseerr)
 * ============================================================================
 * High-performance discovery view backed by Jellyseerr.
 *
 * Implements:
 * 1. Progressive, lazy-loading row architecture (top rows prioritized first).
 * 2. Instant-back caching tied to the 'Disable Home Screen Caching' user toggle.
 * 3. Bidirectional dynamic D-pad focus chain linking with VirtualCardRow.
 * ============================================================================
 */

import Page from './Page.js';
import { VirtualCardRow } from '../components/VirtualCardRow.js';
import CardRenderer from '../utils/CardRenderer.js';
import { seerr } from '../api/seerrClient.js';
import { api } from '../api/ApiClient.js';
import { focusManager } from '../ui/FocusManager.js';
import { router } from '../core/Router.js';
import { state } from '../core/StateManager.js';
import { storage } from '../utils/StorageService.js';
import { lazyLoader } from '../utils/LazyLoader.js';
import { logger } from '../utils/Logger.js';
import { i18n } from '../utils/i18n.js';

const log = logger.create('DiscoverPage');

/**
 * Cache TTL for discovery page data (10 minutes, matching HomePage).
 */
const PAGE_CACHE_TTL = 10 * 60 * 1000;

/**
 * Ordered descriptor list of all supported discovery rows.
 * Defines the canonical vertical sequence, localization keys, and fetch queries.
 */
const ROW_DEFINITIONS = [
    { key: 'recentlyAdded', titleKey: 'SeerrRecentlyAdded', defaultTitle: 'Recently Added', cardType: 'poster', fetch: () => seerr.recentlyAdded() },
    { key: 'requests', titleKey: 'SeerrMyRequests', defaultTitle: 'My Requests', cardType: 'poster', fetch: () => seerr.requests() },
    { key: 'watchlist', titleKey: 'SeerrWatchlist', defaultTitle: 'Watchlist', cardType: 'poster', fetch: () => seerr.watchlist() },
    { key: 'trending', titleKey: 'SeerrTrending', defaultTitle: 'Trending', cardType: 'poster', fetch: () => seerr.discoverTrending() },
    { key: 'movies', titleKey: 'SeerrPopularMovies', defaultTitle: 'Popular Movies', cardType: 'poster', fetch: () => seerr.discoverMovies() },
    { key: 'genreMovies', titleKey: 'SeerrMovieGenres', defaultTitle: 'Movie Genres', cardType: 'landscape', fetch: () => seerr.genreSliderMovies() },
    { key: 'upcomingMovies', titleKey: 'SeerrUpcomingMovies', defaultTitle: 'Upcoming Movies', cardType: 'poster', fetch: () => seerr.upcomingMovies() },
    { key: 'studios', titleKey: 'SeerrStudios', defaultTitle: 'Studios', cardType: 'landscape', fetch: () => seerr.studios() },
    { key: 'series', titleKey: 'SeerrPopularSeries', defaultTitle: 'Popular Series', cardType: 'poster', fetch: () => seerr.discoverTv() },
    { key: 'genreSeries', titleKey: 'SeerrSeriesGenres', defaultTitle: 'Series Genres', cardType: 'landscape', fetch: () => seerr.genreSliderTv() },
    { key: 'upcomingSeries', titleKey: 'SeerrUpcomingSeries', defaultTitle: 'Upcoming Series', cardType: 'poster', fetch: () => seerr.upcomingTv() },
    { key: 'networks', titleKey: 'SeerrNetworks', defaultTitle: 'Networks', cardType: 'landscape', fetch: () => seerr.networks() }
];

/**
 * Batching parameters for progressive row loading.
 */
const INITIAL_ROW_COUNT = 3;
const BATCH_ROW_COUNT = 3;

class DiscoverPage extends Page {
    constructor() {
        super();
        this._isAsyncPage = true;
        this._virtualRows = [];
        this._rowRegistry = new Map();
        this._orderedRowKeys = [];

        // Track index in ROW_DEFINITIONS of next batch to fetch
        this._nextRowIndexToLoad = 0;
        this._isLoadingMore = false;
        this._isDestroyed = false;

        // Intersection observer for scroll sentinel trigger
        this._sentinelObserver = null;
        this._idlePrefetchTimer = null;
    }

    render() {
        return `
            <div class="page discover-page">
                <main class="page-content discover-content">
                    <div class="discover-rows" id="discover-rows"></div>

                    <!-- Sentinel element observed by IntersectionObserver for smooth lazy loading on scroll -->
                    <div class="discover-sentinel" id="discover-sentinel" style="height: 20px; width: 100%;"></div>

                    <div class="discover-message hidden" id="discover-message"></div>
                </main>
            </div>
        `;
    }

    async onInit() {
        this.title = i18n.t('SeerrDiscover');

        // Show page loading indicator immediately to mask initial render and focus restoration
        this.setLoading(true);

        i18n.translateDOM(this.el);

        // Verify that the server-side Seerr integration is available before fetching
        const status = await seerr.status(true);
        if (!status.available) {
            this.setLoading(false);
            this._showMessage(i18n.t('SeerrNotConfigured'), true);
            this.markReady();
            return;
        }

        // Attach event delegation for clicks and focus tracking on cards
        this._attachDelegatedListeners();

        // Check if there is a pending focus restoration target (back navigation)
        const savedFocusObj = storage.getItem('pref:disableFocusRestore') !== 'true'
            ? state.get('discover:lastFocusedItem')
            : null;
        const targetRowKey = savedFocusObj ? savedFocusObj.rowId : (
            this._pendingNavState?.focusSectionName?.replace('discover-row-', '') || null
        );
        const hasFocusTarget = Boolean(targetRowKey || this._pendingNavState);

        // Check if a valid in-memory page cache exists for instant back-navigation
        const cache = this._getValidCache();
        if (cache) {
            log.info('Restoring Discover page from cache');
            this._restoreFromCache(cache, hasFocusTarget);

            // If target row wasn't in cache, fetch rows up to target row
            if (targetRowKey && !this._rowRegistry.has(targetRowKey) && this._hasMoreRows()) {
                const targetDefIndex = ROW_DEFINITIONS.findIndex((d) => d.key === targetRowKey);
                if (targetDefIndex !== -1) {
                    while (this._nextRowIndexToLoad <= targetDefIndex && this._hasMoreRows() && !this._isDestroyed) {
                        await this._loadNextBatch(false);
                    }
                }
            }
        } else {
            // Load the initial prioritized batch of rows (extended if target row is requested)
            await this._loadInitialRows(targetRowKey);
        }

        if (this._isDestroyed) return;

        // Restore focus smoothly before revealing the page to prevent jumping and flashing
        if (hasFocusTarget) {
            this._restoreFocusTarget(targetRowKey, savedFocusObj);
        } else {
            if (this._orderedRowKeys.length > 0) {
                this.setActiveSection(`discover-row-${this._orderedRowKeys[0]}`);
            }
            this.setLoading(false);
            this.markReady();
        }

        // Setup the intersection observer sentinel and background prefetch ONLY AFTER rows are mounted
        this._setupScrollObserver();
        this._scheduleIdlePrefetch();
    }

    // ========================================================================
    // Page Data Cache (instant back-navigation)
    // ========================================================================

    /**
     * Returns the cached discover page data if it exists and hasn't expired.
     * Respects user preference 'pref:homeScreenCache' === 'false'.
     * @returns {Object|null}
     * @private
     */
    _getValidCache() {
        // Respect user preference — caching can be disabled via settings toggle
        if (storage.getItem('pref:homeScreenCache') === 'false') {
            state.delete('discover:pageCache');
            return null;
        }

        const cache = state.get('discover:pageCache');
        if (!cache || !cache.rows || typeof cache.rows !== 'object') return null;

        // Never serve cache from a different user or server instance
        if (cache.serverUrl !== api._serverUrl || cache.userId !== api._userId) {
            state.delete('discover:pageCache');
            return null;
        }

        // Verify that cache hasn't expired past the TTL window
        if (Date.now() - cache.timestamp > PAGE_CACHE_TTL) {
            state.delete('discover:pageCache');
            return null;
        }

        return cache;
    }

    /**
     * Restores all previously rendered discovery rows from cache instantly without network calls.
     * @param {Object} cache - Serialized page cache object.
     * @param {boolean} [hasFocusTarget=false] - Whether a pending focus restoration target exists.
     * @private
     */
    _restoreFromCache(cache, hasFocusTarget = false) {
        this._hideMessage();

        const cachedRows = cache.rows || {};
        this._nextRowIndexToLoad = cache.nextRowIndexToLoad || INITIAL_ROW_COUNT;

        // Sort keys by their original defIndex so rows are mounted in exact sequence
        const sortedEntries = Object.entries(cachedRows).sort(
            (a, b) => (a[1].defIndex || 0) - (b[1].defIndex || 0)
        );

        // Mount each cached row into the DOM without making API requests
        for (const [key, data] of sortedEntries) {
            const def = ROW_DEFINITIONS.find((d) => d.key === key);
            if (def && data.items && data.items.length > 0) {
                this._renderAndMountRow(def, data.items, data.defIndex);
            }
        }

        // Rebuild the vertical D-pad navigation chain across all restored rows
        this._rebuildNavigationChain();

        // Only set active section to first row if not restoring a specific target
        if (!hasFocusTarget && this._orderedRowKeys.length > 0) {
            this.setActiveSection(`discover-row-${this._orderedRowKeys[0]}`);
        }
    }

    /**
     * Saves the current discovery page data to the state cache,
     * so that back-navigation renders instantly without network calls.
     * @private
     */
    _savePageCache() {
        // Respect user preference — abort if caching is disabled in settings
        if (storage.getItem('pref:homeScreenCache') === 'false') return;

        const rows = {};
        for (const [key, entry] of this._rowRegistry) {
            if (entry.virtualRow && entry.virtualRow.items && entry.virtualRow.items.length > 0) {
                rows[key] = {
                    defIndex: entry.defIndex,
                    items: entry.virtualRow.items
                };
            }
        }

        if (Object.keys(rows).length === 0) return;

        // Save serialized state in StateManager
        state.set('discover:pageCache', {
            rows,
            nextRowIndexToLoad: this._nextRowIndexToLoad,
            serverUrl: api._serverUrl,
            userId: api._userId,
            timestamp: Date.now()
        });

        log.info('Discover page data cached for instant back-navigation');
    }

    // ========================================================================
    // Progressive Loading & Data Fetching
    // ========================================================================

    /**
     * Loads the initial prioritized batch of discovery rows (Recently Added, My Requests, Watchlist).
     * If a target row key is specified for focus restoration, extends the initial batch to include that row.
     * @param {string|null} [targetRowKey=null] - Target row to prioritize if restoring focus.
     * @private
     */
    async _loadInitialRows(targetRowKey = null) {
        // Lock loading mutex to prevent any concurrent background/sentinel triggers
        this._isLoadingMore = true;
        this._hideMessage();

        // Determine how many initial rows to fetch (extend if focus restoration targets a deeper row)
        let initialTargetCount = INITIAL_ROW_COUNT;
        if (targetRowKey) {
            const targetDefIndex = ROW_DEFINITIONS.findIndex((d) => d.key === targetRowKey);
            if (targetDefIndex !== -1) {
                initialTargetCount = Math.min(ROW_DEFINITIONS.length, Math.max(INITIAL_ROW_COUNT, targetDefIndex + 1));
            }
        }

        let renderedCount = 0;

        // Helper to safely isolate row fetch errors so one failed endpoint does not break the page
        const safeFetch = async (def, index) => {
            try {
                const items = await def.fetch();
                return { def, items, index };
            } catch (err) {
                log.warn(`Discover row fetch failed for "${def.key}"`, err);
                return { def, items: null, index };
            }
        };

        // Fetch initial prioritized batch in parallel
        const initialBatch = ROW_DEFINITIONS.slice(0, initialTargetCount);
        this._nextRowIndexToLoad = initialTargetCount;

        const results = await Promise.all(
            initialBatch.map((def, idx) => safeFetch(def, idx))
        );

        if (this._isDestroyed) {
            this._isLoadingMore = false;
            return;
        }

        // Render each populated row in strict descriptor sequence
        for (const res of results) {
            if (res.items && res.items.length > 0) {
                this._renderAndMountRow(res.def, res.items, res.index);
                renderedCount++;
            }
        }

        // If the initial batch yielded fewer than 2 populated rows, fetch next rows progressively
        while (renderedCount < 2 && this._nextRowIndexToLoad < ROW_DEFINITIONS.length && !this._isDestroyed) {
            const nextIdx = this._nextRowIndexToLoad++;
            const def = ROW_DEFINITIONS[nextIdx];
            const res = await safeFetch(def, nextIdx);

            if (res.items && res.items.length > 0) {
                this._renderAndMountRow(res.def, res.items, res.index);
                renderedCount++;
            }
        }

        // If no items were found across all available rows, display a failure message
        if (renderedCount === 0 && this._nextRowIndexToLoad >= ROW_DEFINITIONS.length) {
            this._showMessage(i18n.t('SeerrLoadFailed'), false);
            this._isLoadingMore = false;
            return;
        }

        // Rebuild the vertical D-pad navigation chain across all mounted rows
        this._rebuildNavigationChain();

        // Snapshot loaded rows into in-memory page cache
        this._savePageCache();

        // Release the initial loading lock so subsequent scrolling can trigger next batches
        this._isLoadingMore = false;
    }

    /**
     * Smoothly restores focus and scroll position to the target row and card.
     * Keeps loading state active during alignment to prevent jumping/flashing.
     * @param {string|null} targetRowKey - The key of the row to focus (e.g. 'movies').
     * @param {Object|null} savedFocusObj - State containing rowId, itemId, and card index.
     * @private
     */
    _restoreFocusTarget(targetRowKey, savedFocusObj) {
        if (!targetRowKey || storage.getItem('pref:disableFocusRestore') === 'true') {
            if (this._orderedRowKeys.length > 0) {
                this.setActiveSection(`discover-row-${this._orderedRowKeys[0]}`);
            }
            this.setLoading(false);
            this.markReady();
            return;
        }

        const sectionName = `discover-row-${targetRowKey}`;
        const rowEntry = this._rowRegistry.get(targetRowKey);

        if (rowEntry && rowEntry.virtualRow) {
            // Determine target card index (from savedFocusObj, itemId, or pendingNavState)
            let targetIdx = savedFocusObj?.index;
            if (targetIdx == null && savedFocusObj?.itemId) {
                const foundIdx = rowEntry.virtualRow.items.findIndex(
                    (item) => String(item.Id) === String(savedFocusObj.itemId) || String(item._tmdbId) === String(savedFocusObj.itemId)
                );
                if (foundIdx !== -1) targetIdx = foundIdx;
            }
            if (targetIdx == null && this._pendingNavState?.focusElementIndex != null) {
                targetIdx = this._pendingNavState.focusElementIndex;
            }
            if (targetIdx == null || isNaN(targetIdx)) {
                targetIdx = 0;
            }

            // Ensure virtual card DOM node is created and mounted in track
            rowEntry.virtualRow._updateWindow(targetIdx);
            rowEntry.virtualRow.currentIndex = targetIdx;
            rowEntry.virtualRow._hasBeenFocused = true;

            // Set active section without triggering premature focus event
            this.setActiveSection(sectionName, false);

            // Directly focus target node with instantScroll
            const cardNode = rowEntry.virtualRow.domNodes.get(targetIdx) ||
                rowEntry.sectionEl.querySelector(`[data-virtual-index="${targetIdx}"]`);
            if (cardNode) {
                focusManager.focusElement(cardNode, { instantScroll: true });
            }

            // Clean up state key
            state.delete('discover:lastFocusedItem');
        } else if (this._orderedRowKeys.length > 0) {
            this.setActiveSection(`discover-row-${this._orderedRowKeys[0]}`);
        }

        // Apply scroll position from pending navigation state if available
        if (this._pendingNavState && this._pendingNavState.scrollTop > 0) {
            const scrollContainer = this.el.querySelector('.page-content') || this.el;
            if (scrollContainer) {
                scrollContainer.scrollTop = this._pendingNavState.scrollTop;
            }
            this._pendingNavState = null;
        }

        // Reveal the page now that focus and scroll are in place
        requestAnimationFrame(() => {
            if (this._isDestroyed) return;
            this.setLoading(false);
            this.markReady();
        });
    }

    /**
     * Lazily loads the next batch of discovery rows as the user scrolls or approaches the bottom.
     * @param {boolean} [autoFocus=false] - Whether to shift focus to the newly added row.
     * @private
     */
    async _loadNextBatch(autoFocus = false) {
        if (this._isLoadingMore || this._isDestroyed) return;
        if (this._nextRowIndexToLoad >= ROW_DEFINITIONS.length) return;

        this._isLoadingMore = true;

        const startIndex = this._nextRowIndexToLoad;
        const endIndex = Math.min(startIndex + BATCH_ROW_COUNT, ROW_DEFINITIONS.length);
        const batchDefs = ROW_DEFINITIONS.slice(startIndex, endIndex);
        this._nextRowIndexToLoad = endIndex;

        // Helper to safely fetch row data
        const safeFetch = async (def, idx) => {
            try {
                const items = await def.fetch();
                return { def, items, index: idx };
            } catch (err) {
                log.warn(`Discover row fetch failed for "${def.key}"`, err);
                return { def, items: null, index: idx };
            }
        };

        // Fetch the batch in parallel
        const results = await Promise.all(
            batchDefs.map((def, i) => safeFetch(def, startIndex + i))
        );

        if (this._isDestroyed) {
            this._isLoadingMore = false;
            return;
        }

        let addedFirstKey = null;

        // Mount all populated rows from this batch
        for (const res of results) {
            if (res.items && res.items.length > 0) {
                this._renderAndMountRow(res.def, res.items, res.index);
                if (!addedFirstKey) addedFirstKey = res.def.key;
            }
        }

        // Re-link the vertical navigation chain with the new rows
        this._rebuildNavigationChain();

        // Update in-memory cache with newly loaded rows
        this._savePageCache();

        // If requested, navigate to the first newly added row
        if (autoFocus && addedFirstKey) {
            this.setActiveSection(`discover-row-${addedFirstKey}`);
            const entry = this._rowRegistry.get(addedFirstKey);
            if (entry) {
                const initialNode = entry.virtualRow.domNodes.get(0) || entry.sectionEl.querySelector('.media-card');
                if (initialNode) focusManager.focusElement(initialNode);
            }
        }

        this._isLoadingMore = false;
    }

    /**
     * Checks if there are more row descriptors waiting to be fetched.
     * @returns {boolean}
     * @private
     */
    _hasMoreRows() {
        return this._nextRowIndexToLoad < ROW_DEFINITIONS.length;
    }

    /**
     * Schedules a low-priority background prefetch for the next row batch.
     * @private
     */
    _scheduleIdlePrefetch() {
        if (this._idlePrefetchTimer) clearTimeout(this._idlePrefetchTimer);
        this._idlePrefetchTimer = setTimeout(() => {
            if (!this._isDestroyed && this._hasMoreRows()) {
                this._loadNextBatch(false);
            }
        }, 1200);
    }

    // ========================================================================
    // Row Rendering & Focus Registration
    // ========================================================================

    /**
     * Renders a single row, mounts its VirtualCardRow instance, and inserts it
     * into the DOM in correct descriptor order.
     * 
     * @param {Object} def - The row descriptor definition.
     * @param {Array} items - The normalized item list.
     * @param {number} defIndex - The canonical descriptor sequence index.
     * @private
     */
    _renderAndMountRow(def, items, defIndex) {
        const container = this.$('#discover-rows');
        if (!container || !items || items.length === 0) return;
        if (this._rowRegistry.has(def.key)) return;

        const isLandscape = def.cardType === 'landscape';
        const hasNoCardLabels =
            def.key === 'genreMovies' ||
            def.key === 'studios' ||
            def.key === 'genreSeries' ||
            def.key === 'networks';

        // Create the section container for the row
        const sectionEl = document.createElement('section');
        sectionEl.className = hasNoCardLabels ? 'media-row media-row--no-card-labels' : 'media-row';
        sectionEl.setAttribute('data-row-id', def.key);
        sectionEl.setAttribute('data-def-index', defIndex);

        // Build inner HTML structure for title and horizontal scroll track
        const titleText = i18n.t(def.titleKey, [def.defaultTitle]);
        sectionEl.innerHTML = `
            <h2 class="row-title">${titleText}</h2>
            <div class="row-items" id="row-items-${def.key}">
                <div class="row-items-track"></div>
            </div>
        `;

        // Insert section into DOM in correct sequence order by finding the first following section
        const existingSections = Array.from(container.querySelectorAll('section[data-def-index]'));
        const nextSibling = existingSections.find(
            (el) => parseInt(el.getAttribute('data-def-index'), 10) > defIndex
        );

        if (nextSibling) {
            container.insertBefore(sectionEl, nextSibling);
        } else {
            container.appendChild(sectionEl);
        }

        // Initialize VirtualCardRow for high-performance windowed rendering
        const trackEl = sectionEl.querySelector('.row-items-track');
        const virtualRow = new VirtualCardRow(trackEl, items, {
            isLandscape,
            cardType: def.cardType || 'poster',
            visibleCount: 10,
            initialWindow: Math.min(items.length, 12),
            focusSectionId: `discover-row-${def.key}`,
            renderCard: (item) =>
                this._renderMediaCard(item, isLandscape, def.cardType || 'poster', 'discover')
        });

        // Register focus section for horizontal D-pad navigation within the row
        const itemsContainer = sectionEl.querySelector('.row-items');
        this.registerFocusSection(`discover-row-${def.key}`, itemsContainer, {
            orientation: 'horizontal',
            leaveUp: null, // Will be dynamically linked by _rebuildNavigationChain
            leaveDown: null, // Will be dynamically linked by _rebuildNavigationChain
            leaveLeft: 'sidebar',

            onMove: (direction, currentElement) => {
                if (!currentElement || currentElement.dataset.virtualIndex === undefined) {
                    return false;
                }
                const idx = parseInt(currentElement.dataset.virtualIndex, 10);
                const nextNode = virtualRow.handleMove(direction, idx);
                if (nextNode) {
                    focusManager.focusElement(nextNode);
                    return true;
                }
                return false;
            },

            onEnter: (fromElement, options) => {
                if (fromElement && options && (options.direction === 'up' || options.direction === 'down')) {
                    const existingNode = virtualRow.domNodes.get(virtualRow.currentIndex);
                    if (existingNode && existingNode.isConnected) {
                        return existingNode;
                    }
                    virtualRow._updateWindow(virtualRow.currentIndex);
                    return virtualRow.domNodes.get(virtualRow.currentIndex);
                }
                return null;
            }
        });

        // Store references in local registries
        this._rowRegistry.set(def.key, { def, defIndex, sectionEl, virtualRow });
        this._virtualRows.push(virtualRow);

        // Register with global image lazy loader
        lazyLoader.observe(sectionEl);
    }

    /**
     * Rebuilds the bidirectional vertical navigation chain across all mounted rows.
     * Ensures leaveUp and leaveDown seamlessly link adjacent visible sections.
     * @private
     */
    _rebuildNavigationChain() {
        const container = this.$('#discover-rows');
        if (!container) return;

        // Query the live DOM order of all mounted discovery rows
        const currentSections = Array.from(container.querySelectorAll('section[data-row-id]'));
        this._orderedRowKeys = currentSections
            .map((el) => el.getAttribute('data-row-id'))
            .filter(Boolean);

        const rowCount = this._orderedRowKeys.length;

        // Update each focus section configuration with its true adjacent neighbors
        this._orderedRowKeys.forEach((key, index) => {
            const sectionName = `discover-row-${key}`;
            const config = focusManager.getSectionConfig(sectionName);
            if (!config) return;

            const prevKey = index > 0 ? this._orderedRowKeys[index - 1] : null;
            const nextKey = index < rowCount - 1 ? this._orderedRowKeys[index + 1] : null;

            config.leaveUp = prevKey ? `discover-row-${prevKey}` : null;
            config.leaveDown = nextKey ? `discover-row-${nextKey}` : null;

            // If this is the last rendered row but more descriptors exist, trigger on-demand load when navigating down
            if (!nextKey && this._hasMoreRows()) {
                config.leaveDown = () => {
                    this._loadNextBatch(true);
                    return false;
                };
            }

            focusManager.register(sectionName, config.container, config);
        });

        // Invalidate FocusManager cache so updated leaveUp/leaveDown take effect immediately
        focusManager.invalidateCache();
    }

    // ========================================================================
    // Scroll Observation & Event Delegation
    // ========================================================================

    /**
     * Sets up the IntersectionObserver on the bottom sentinel element to trigger
     * lazy loading as the user scrolls down.
     * @private
     */
    _setupScrollObserver() {
        const sentinel = this.$('#discover-sentinel');
        if (!sentinel || typeof IntersectionObserver === 'undefined') return;

        if (this._sentinelObserver) {
            this._sentinelObserver.disconnect();
        }

        // Trigger loading when the sentinel is within 600px of entering the viewport
        this._sentinelObserver = new IntersectionObserver(
            (entries) => {
                const entry = entries[0];
                if (entry && entry.isIntersecting && !this._isLoadingMore && this._hasMoreRows()) {
                    this._loadNextBatch(false);
                }
            },
            { rootMargin: '600px 0px', threshold: 0.01 }
        );

        this._sentinelObserver.observe(sentinel);
    }

    /**
     * Attaches event delegation on #discover-rows for fast card activation and index syncing.
     * Also triggers prefetching when focus approaches the bottom of rendered rows.
     * @private
     */
    _attachDelegatedListeners() {
        const container = this.$('#discover-rows');
        if (!container) return;

        let lastActivateTime = 0;
        const handleActivate = (e) => {
            const card = e.target.closest('.media-card');
            if (!card) return;

            const now = Date.now();
            if (now - lastActivateTime < 400) return;
            lastActivateTime = now;

            e.stopPropagation();

            const itemId = card.dataset.itemId;
            if (!itemId) return;

            const sectionEl = card.closest('section[data-row-id]');
            const rowId = sectionEl ? sectionEl.getAttribute('data-row-id') : null;
            const rowEntry = rowId ? this._rowRegistry.get(rowId) : null;
            const cardVirtualIndex = rowEntry ? rowEntry.virtualRow.currentIndex : 0;

            // Persist focused item state for seamless back-navigation restoration
            if (rowId && storage.getItem('pref:disableFocusRestore') !== 'true') {
                state.set('discover:lastFocusedItem', {
                    rowId: rowId,
                    itemId: itemId,
                    index: cardVirtualIndex
                });
            }

            // Find item in registry across all virtual rows
            let found = null;
            for (const [, entry] of this._rowRegistry) {
                found = entry.virtualRow.items.find((i) => i.Id === itemId);
                if (found) break;
            }

            if (!found) return;

            // Route based on item entity type
            if (found._isGenreCard) {
                router.navigate(`/library/seerr?seerrType=genre&mediaType=${found._mediaType}&genreId=${found._genreId}&name=${encodeURIComponent(found.Name)}`);
            } else if (found._isStudioCard) {
                router.navigate(`/library/seerr?seerrType=studio&studioId=${found._studioId}&name=${encodeURIComponent(found.Name)}`);
            } else if (found._isNetworkCard) {
                router.navigate(`/library/seerr?seerrType=network&networkId=${found._networkId}&name=${encodeURIComponent(found.Name)}`);
            } else if (found._mediaType && found._tmdbId) {
                router.navigate(`/seerr/${found._mediaType}/${found._tmdbId}`);
            }
        };

        container.addEventListener('click', handleActivate);
        container.addEventListener('mousedown', handleActivate);

        // Track focus in events to sync virtual index and check proximity for prefetching
        container.addEventListener('focusin', (e) => {
            if (!e.target.classList.contains('media-card')) return;
            const sectionEl = e.target.closest('section[data-row-id]');
            if (!sectionEl) return;
            const rowId = sectionEl.getAttribute('data-row-id');
            const rowEntry = this._rowRegistry.get(rowId);
            if (rowEntry) {
                rowEntry.virtualRow.syncIndexFromNode(e.target);

                if (storage.getItem('pref:disableFocusRestore') !== 'true') {
                    state.set('discover:lastFocusedItem', {
                        rowId: rowId,
                        itemId: e.target.dataset.itemId,
                        index: rowEntry.virtualRow.currentIndex
                    });
                }
            }

            // If focus is near the bottom (within the last 2 mounted rows), trigger prefetching
            const rowIndex = this._orderedRowKeys.indexOf(rowId);
            if (rowIndex !== -1 && rowIndex >= this._orderedRowKeys.length - 2 && this._hasMoreRows()) {
                this._loadNextBatch(false);
            }
        });
    }

    /**
     * Serializes page navigation state for Router history snapshots.
     * @returns {Object}
     */
    getNavigationState() {
        return {
            nextRowIndexToLoad: this._nextRowIndexToLoad,
            lastFocusedItem: state.get('discover:lastFocusedItem')
        };
    }

    /**
     * Restores page navigation state on back-navigation.
     * @param {Object} pageState
     */
    setNavigationState(pageState) {
        if (pageState && pageState.lastFocusedItem) {
            state.set('discover:lastFocusedItem', pageState.lastFocusedItem);
        }
    }

    // ========================================================================
    // UI Helpers & Messaging
    // ========================================================================

    _showMessage(text, withSettingsButton) {
        const el = this.$('#discover-message');
        if (!el) return;
        el.innerHTML = `
            <p>${text}</p>
            ${withSettingsButton
                ? `<div class="discover-message-actions">
                           <button class="btn btn-secondary focusable" id="btn-discover-settings" tabindex="0">
                               ${i18n.t('SeerrOpenSettings')}
                           </button>
                       </div>`
                : ''
            }
        `;
        el.classList.remove('hidden');

        const btn = this.$('#btn-discover-settings');
        if (btn) {
            btn.addEventListener('click', () => router.navigate('/settings'));
            this.registerFocusSection('discover-message', el, {
                orientation: 'horizontal',
                leaveLeft: 'sidebar'
            });
            this.setActiveSection('discover-message');
        }
    }

    _hideMessage() {
        this.$('#discover-message')?.classList.add('hidden');
    }


    // ========================================================================
    // Lifecycle & Cleanup
    // ========================================================================

    _destroyVirtualRows() {
        for (const [key] of this._rowRegistry) {
            focusManager.unregister(`discover-row-${key}`);
        }
        this._virtualRows = [];
        this._rowRegistry.clear();
        this._orderedRowKeys = [];
    }

    destroy() {
        this._isDestroyed = true;
        if (this._idlePrefetchTimer) clearTimeout(this._idlePrefetchTimer);
        if (this._sentinelObserver) {
            this._sentinelObserver.disconnect();
            this._sentinelObserver = null;
        }
        this._savePageCache();
        this._destroyVirtualRows();
        super.destroy();
    }
}

export default DiscoverPage;
