/**
 * ============================================================================
 * Litefin Tizen - Home Page (v2 Rewrite)
 * ============================================================================
 *
 * Architecture: Row Descriptor System
 * ------------------------------------
 * Each visual row is described by a lightweight RowDescriptor object.
 * This completely decouples data fetching from rendering, enabling:
 *   - Progressive rendering: rows appear as data arrives, not all-at-once.
 *   - Skeleton-first UX: placeholder shimmer rows appear instantly on load.
 *   - Phase 2 extensibility: row order/visibility comes from a single
 *     `_getRowDescriptors()` method — settings just mutates this array.
 *
 * Why the rewrite?
 * -----------------
 * The v1 code had a render-blocking waterfall:
 *   1. Fetch ALL data (resume + nextUp + all library latest) first.
 *   2. Then render ALL rows in one giant synchronous DOM mutation.
 *   3. Then register ALL focus sections.
 *
 * On Tizen's slow CPU, bunching that many DOM writes + focus registrations
 * into a single frame caused a multi-frame compositor blockage. Users
 * perceived this as the page being "frozen" during initial load.
 *
 * The fix: rows render independently, one by one, as their data arrives.
 * ============================================================================
 */

// Page-scoped styles - loads with this module's chunk instead of the boot bundle
import '../styles/home.css';
import '../styles/hero-carousel.css';

import Page from './Page.js';
import { api } from '../api/index.js';
import { VirtualCardRow } from '../components/VirtualCardRow.js';
import { state } from '../core/StateManager.js';
import { router } from '../core/Router.js';
import { eventBus } from '../core/EventBus.js';
import { focusManager } from '../ui/FocusManager.js';
import { layoutManager } from '../ui/LayoutManager.js';
import { scrollController } from '../ui/ScrollController.js';
import { lazyLoader } from '../utils/LazyLoader.js';
import { storage } from '../utils/StorageService.js';
import { logger } from '../utils/Logger.js';
import { i18n } from '../utils/i18n.js';
import { imageCache } from '../utils/ImageCache.js';
import { imageService } from '../utils/ImageService.js';
import CardRenderer from '../utils/CardRenderer.js';
import { quickPlayItem } from '../utils/QuickPlay.js';
import { homeLayoutManager } from '../utils/HomeLayoutManager.js';
import { pluginManager } from '../plugins/PluginManager.js';
import HeroCarousel from '../ui/HeroCarousel.js';
import { getSeriesLastWatchedDates } from '../utils/NextUpActivity.js';
import { PlayerSettings } from '../utils/PlayerSettings.js';

const log = logger.create('HomePage');

// ============================================================================
// Constants
// ============================================================================

/**
 * Maximum number of images to preload per row.
 * Keeps memory usage bounded to roughly one screen-worth.
 */
const IMAGE_PREWARM_PER_ROW = 10;

/**
 * How long (in ms) to cache homepage data for instant back-navigation.
 * 24 hours — cache lives in-memory (StateManager) so it's automatically
 * cleared on app restart/refresh. Explicitly cleared on metadata refresh
 * calls and settings changes that affect homepage display.
 */
const PAGE_CACHE_TTL = 24 * 60 * 60 * 1000;

/**
 * Number of initial rows to load eagerly on first render before deferring the rest
 * to scroll/idle. Sliced directly from descriptors in the user's custom layout order.
 * 3 rows covers the immediately visible viewport on a 1080p/4K TV without over-fetching.
 */
const EAGER_ROW_COUNT = 3;

/**
 * Number of deferred rows to fetch per lazy-load batch.
 *
 * DEFERRED_BATCH_SIZE (1) applies to explicit user requests (D-pad boundary
 * trigger) so the focus lands on the very first new row without waiting for
 * extra work. DEFERRED_BATCH_SIZE_BACKGROUND (2) applies to background
 * prefetch while no scroll animation/render is in flight — fetching two rows
 * ahead keeps the queue permanently ahead of the user's D-pad navigation,
 * so a boundary keypress almost always finds its row already fetched.
 */
const DEFERRED_BATCH_SIZE = 1;
const DEFERRED_BATCH_SIZE_BACKGROUND = 2;

/**
 * Card width definitions (matching home.css) — used by VirtualCardRow internally.
 * Landscape: 400px, Portrait: 240px, gap: 24px.
 * Kept here for reference; VirtualCardRow reads these from its own constructor options.
 */

// ============================================================================
// Row Descriptor Schema (for documentation / IDE autocomplete)
// ============================================================================

/**
 * @typedef {Object} RowDescriptor
 * @property {string}   id          - Stable unique ID (used for focus sections + Phase 2 settings)
 * @property {string}   title       - Localized display title for the section header
 * @property {number}   priority    - Render order. Lower = renders first. Tied priorities render in parallel.
 * @property {Function} fetchFn     - async () => Array of Jellyfin items (or null if empty/skipped)
 * @property {'landscape'|'portrait'|'square'} layout - Card layout mode
 * @property {string}   [cardType]  - Passed to CardRenderer ('poster', 'square', etc.)
 * @property {string}   [contextType] - Spoiler/display context passed to CardRenderer
 */

class HomePage extends Page {
    constructor() {
        super();
        this.title = 'Home';

        /**
         * Tracks whether the page is still mounted.
         * All async callbacks guard against stale updates after navigation.
         * @type {boolean}
         */
        this._isMounted = false;

        /**
         * Ordered list of VirtualCardRow instances, indexed by render order.
         * Used for focus restoration and scroll pre-warming.
         * @type {VirtualCardRow[]}
         */
        this._virtualRows = [];

        /**
         * Mapping: rowId -> { descriptor, sectionEl, virtualRow }
         * Allows us to find a row by its stable ID for focus/state operations.
         * @type {Map<string, Object>}
         */
        this._rowRegistry = new Map();

        /**
         * Count of rows that have been fully rendered (data loaded + DOM updated).
         * Used to detect when the first row is ready to receive focus.
         * @type {number}
         */
        this._renderedRowCount = 0;

        /**
         * Whether the initial focus has been set for this page load.
         * @type {boolean}
         */
        this._focusInitialized = false;

        /**
         * Whether the app:hideSplash event has already been emitted.
         * Used to ensure we only reveal the screen once focus is on the
         * correct row, not as soon as the skeleton rows are painted.
         * @type {boolean}
         */
        this._splashHidden = false;

        /**
         * Holds fetched libraries — shared across multiple descriptor fetchFns.
         * @type {Array}
         */
        this._libraries = [];

        /**
         * Hero Carousel instance
         * @type {HeroCarousel}
         */
        this._hero = null;

        /**
         * Flat ordered array of deferred RowDescriptors waiting to be loaded on demand.
         * Populated in _startRenderPipeline() in exact user-configured layout sequence.
         * @type {RowDescriptor[]}
         */
        this._deferredDescriptors = [];

        /**
         * Index into _deferredDescriptors of the next descriptor to load.
         * Incremented each time _loadNextDeferredBatch() consumes a batch.
         * @type {number}
         */
        this._nextDeferredDescIndex = 0;

        /**
         * Mutex: true while a deferred batch is in-flight.
         * Prevents the sentinel observer and D-pad hook from firing overlapping fetches.
         * @type {boolean}
         */
        this._isDeferredLoading = false;

        /**
         * IntersectionObserver watching the #home-rows-sentinel element.
         * Fires _loadNextDeferredBatch() as the user scrolls near the bottom.
         * @type {IntersectionObserver|null}
         */
        this._homeSentinelObserver = null;

        /**
         * setTimeout handle for the post-initial idle prefetch.
         * Cleared on destroy to prevent callbacks on a dead page instance.
         * @type {number|null}
         */
        this._homeIdlePrefetchTimer = null;

        /**
         * Callback stored by _tryInitializeFocus() when a target row renders.
         * Step 7's rAF calls this after ALL rows are done to restore focus and
         * then hide the loading overlay. This ensures the page layout is stable
         * before scroll calculations and before the spinner disappears.
         * @type {Function|null}
         */
        this._pendingFocusRestore = null;

        // Mark as async page for Navigation State so scroll/focus restoration is deferred
        this._isAsyncPage = true;

        /**
         * Listen for modal focus trap dismissals (e.g. ExitDialog closed).
         * If homepage focus restoration was deferred because ExitDialog was visible,
         * run the deferred restoration once the modal is dismissed.
         * @type {Function|null}
         */
        this._onTrapPopped = () => {
            if (!this._isMounted) return;

            // First priority: run deferred focus restoration if it was blocked during page load
            if (typeof this._pendingFocusRestore === 'function') {
                log.info('Focus trap popped - executing deferred homepage focus restoration');
                this._pendingFocusRestore();
                this._pendingFocusRestore = null;
            } else {
                // Safety net: check if focus was stranded or lost when the modal was popped
                const currentFocused = focusManager.getFocused();
                if (!currentFocused || !document.contains(currentFocused)) {
                    log.warn('Focus lost after modal dismissal, executing homepage focus fallback');
                    this._restoreHomepageFocusFallback();
                }
            }
        };
        eventBus.on('focus:trapPopped', this._onTrapPopped);
    }

    render() {
        return `
            <div class="page home-page">
                <main class="page-content" id="home-content">
                    <div class="page-error" style="display: none;"></div>
                    <div id="home-hero-placeholder"></div>
                    <div class="home-rows" id="home-rows">
                        <!-- Rows are progressively injected here by _loadAndRenderRow() -->

                        <!-- Sentinel element watched by IntersectionObserver.
                             Moved below each batch of newly inserted skeleton rows
                             so it always trails the last visible P2 batch. -->
                        <div class="home-rows-sentinel" id="home-rows-sentinel" style="height:20px;width:100%;"></div>
                    </div>
                </main>
            </div>
        `;
    }

    onInit() {
        this._isMounted = true;

        // Guard: must be authenticated to show home
        if (!api.isAuthenticated) {
            log.warn('Not authenticated, redirecting to login');
            router.navigate('/login', { replace: true });
            return;
        }

        // Attach delegated event listeners once on the stable container
        this._attachDelegatedListeners();

        // Kick off the progressive render pipeline
        this._startRenderPipeline();
    }

    onDestroyed() {
        this._isMounted = false;

        /*
         * CRITICAL: Cancel all pending background image preloads immediately.
         *
         * The home page queues dozens of `new Image()` preload requests. Each
         * one holds an HTTP connection slot. Chromium's per-host connection pool
         * is only 6 slots — if these preloads are still in-flight when the user
         * navigates to the next page, every API XHR/fetch call blocks for up to
         * 30s waiting for a free slot. cancel() sets img.src = '' on every
         * in-flight Image, which causes the browser to abort the TCP request
         * synchronously and return the slot to the pool.
         */
        imageCache.cancel();

        if (this._hero) {
            this._hero.destroy();
            this._hero = null;
        }

        // Disconnect the scroll sentinel observer and clear any pending idle-prefetch timer
        if (this._homeSentinelObserver) {
            this._homeSentinelObserver.disconnect();
            this._homeSentinelObserver = null;
        }
        if (this._homeIdlePrefetchTimer) {
            clearTimeout(this._homeIdlePrefetchTimer);
            this._homeIdlePrefetchTimer = null;
        }

        // Clean up modal trap popped listener
        if (this._onTrapPopped) {
            eventBus.off('focus:trapPopped', this._onTrapPopped);
            this._onTrapPopped = null;
        }
    }

    /**
     * Override Page.setLoading to suppress the premature app:hideSplash
     * that the base implementation emits when hiding the spinner.
     *
     * On the home page, the loading screen must stay visible until focus
     * has been placed on the correct row (handled in _tryInitializeFocus).
     * Revealing the UI before that causes a visible jump: the screen shows
     * with focus on row 1, then snaps to the restored row a frame later.
     *
     * The base setLoading(false) still removes the 'loading' CSS class so
     * the skeleton rows become interactive, but we swallow the hideSplash
     * event here and re-emit it ourselves at the end of _tryInitializeFocus.
     */
    setLoading(show) {
        if (!this.el) return;

        const isCurrentlyLoading = this.el.classList.contains('loading');

        if (show) {
            let loader = this.el.querySelector('.page-loading');
            if (!loader) {
                loader = document.createElement('div');
                loader.className = 'page-loading';
                loader.innerHTML = '<div class="loading-spinner"></div>';
                this.el.appendChild(loader);
            }
            if (!isCurrentlyLoading) {
                this.el.classList.add('loading');
            }
        } else if (isCurrentlyLoading) {
            // Remove loading class so the skeletons become interactive,
            // but do NOT emit app:hideSplash yet — that happens in
            // _tryInitializeFocus after the correct row is focused.
            this.el.classList.remove('loading');
        }
    }

    /**
     * Emit app:hideSplash exactly once.
     * Called either from _tryInitializeFocus (normal path, after focus is set)
     * or from error paths in the pipeline where no rows will ever render.
     */
    _hideSplash() {
        if (!this._splashHidden) {
            this._splashHidden = true;
            this.setLoading(false);
            eventBus.emit('app:hideSplash');
        }
    }

    // =========================================================================
    // Row Descriptor System
    // =========================================================================

    /**
     * Returns the ordered list of row descriptors for the home page.
     *
     * This is the SINGLE insertion point for Phase 2 settings.
     * Phase 2 will read user preferences and reorder/filter this array:
     *
     *   const savedOrder = storage.getItem('home:rowOrder');
     *   if (savedOrder) descriptors = applyUserOrder(descriptors, JSON.parse(savedOrder));
     *
     * Each descriptor is self-contained: it knows how to fetch its own data,
     * what layout to use, and how to render its cards. HomePage just orchestrates.
     *
     * @returns {RowDescriptor[]}
     */
    _getRowDescriptors() {
        /**
         * Descriptor array — sorted by `priority` below.
         * Priority 0 = first to render, higher numbers render after.
         * Equal priorities render in parallel within the same batch.
         */
        const descriptors = [];

        // Read user preference for homepage row items limit (defaults to 12)
        const homeRowLimit = parseInt(storage.getItem('pref:homeRowsLimit') || 12, 10);

        // ── Priority 0: My Media (Libraries) ──────────────────────────────────
        // Libraries are already fetched at pipeline start and stored in
        // this._libraries — the fetchFn just resolves from memory.
        const hideMyMedia = storage.getItem('pref:hideMyMedia') === 'true';
        if (!hideMyMedia) {
            descriptors.push({
                id: 'my-media',
                title: i18n.t('HeaderMyMedia'),
                priority: 0,
                layout: 'landscape',
                cardType: 'library',
                contextType: 'library',
                // Libraries are loaded upfront; fetchFn is a synchronous-style wrapper
                fetchFn: async () => {
                    if (this._libraries.length === 0) return null;

                    // Filter out Live TV if the user has disabled it in settings
                    const hideLiveTv = storage.getItem('pref:hideLiveTvInMyMedia') === 'true';
                    if (hideLiveTv) {
                        return this._libraries.filter((lib) => lib.CollectionType !== 'livetv');
                    }

                    return this._libraries;
                }
            });
        }

        // ── Priority 1: Continue Watching & Next Up ──────────────────────────
        const mergeResumeNextUp = storage.getItem('pref:mergeResumeNextUp') === 'true';

        // ── Priority 1: Trending / Em Alta (Movies & Series custom slots) ───
        // Shared memoized promise to avoid duplicate recursive collections queries
        // across concurrent Movie & Series trending descriptors.
        let sharedCollectionsPromise = null;
        const getSharedCollections = () => {
            if (!sharedCollectionsPromise) {
                // Fetch BoxSets and Playlists recursively once and share among descriptors
                sharedCollectionsPromise = api
                    .getItems({
                        IncludeItemTypes: 'BoxSet,Playlist',
                        Recursive: true,
                        EnableTotalRecordCount: false
                    })
                    .then((res) => res?.Items || [])
                    .catch((err) => {
                        log.warn('Failed to query smart collections for trending rows:', err);
                        return [];
                    });
            }
            return sharedCollectionsPromise;
        };

        // Check if user enabled custom collection name headers
        const useTrendingColName = storage.getItem('pref:useTrendingCollectionName') === 'true';

        const createTrendingDescriptor = (id, type, settingKey, nameKey, defaultTitleKey) => {
            if (storage.getItem('pref:enableCollectionRows') !== 'true') return null;
            const settingVal = storage.getItem(settingKey) || 'none';
            if (settingVal === 'none') return null;

            const storedName = storage.getItem(nameKey);
            // If user selected a specific collection and custom name is requested, use its stored name immediately
            const title =
                useTrendingColName && settingVal !== 'auto' && settingVal !== 'top-rated' && storedName
                    ? storedName
                    : i18n.t(defaultTitleKey);

            const descriptor = {
                id,
                title,
                priority: 1,
                layout: 'portrait',
                cardType: 'poster',
                contextType: 'trending',
                fetchFn: async () => {
                    try {
                        // 1. If a specific collection or playlist ID is chosen, fetch directly from it
                        if (settingVal !== 'auto' && settingVal !== 'top-rated') {
                            let items = null;

                            try {
                                // Attempt fetching playlist items first; suppress unauthorized eviction if inaccessible
                                const plRes = await api
                                    .getPlaylistItems(
                                        settingVal,
                                        { Limit: homeRowLimit },
                                        { suppressUnauthorized: true, warnOnError: true }
                                    )
                                    .catch(() => null);
                                items = plRes?.Items;
                            } catch (_) {}

                            // If not a playlist or empty, query as collection/folder BoxSet
                            if (!items || items.length === 0) {
                                let boxRes = await api
                                    .getItems(
                                        {
                                            ParentId: settingVal,
                                            Limit: homeRowLimit,
                                            IncludeItemTypes: type,
                                            Fields: 'PrimaryImageAspectRatio,CanFilter,UserData',
                                            Recursive: true
                                        },
                                        { suppressUnauthorized: true, warnOnError: true }
                                    )
                                    .catch(() => null);
                                items = boxRes?.Items;

                                // Fallback without item type restriction if initial query was empty
                                if (!items || items.length === 0) {
                                    boxRes = await api
                                        .getItems(
                                            {
                                                ParentId: settingVal,
                                                Limit: homeRowLimit,
                                                Fields: 'PrimaryImageAspectRatio,CanFilter,UserData',
                                                Recursive: true
                                            },
                                            { suppressUnauthorized: true, warnOnError: true }
                                        )
                                        .catch(() => null);
                                    items = boxRes?.Items;
                                }
                            }

                            // If items were retrieved from the specified collection, return them
                            if (items && items.length > 0) {
                                return items;
                            }
                        }

                        // 2. If 'auto', search for matching SmartLists or Jellyfin collections
                        if (settingVal === 'auto') {
                            // Await the shared collections promise so only 1 network request is made
                            const collections = await getSharedCollections();
                            const keywords =
                                type === 'Movie'
                                    ? [/filmes?\s*em\s*alta/i, /em\s*alta/i, /trending.*movies?/i, /trending/i]
                                    : [
                                          /s[eé]ries?\s*em\s*alta/i,
                                          /tv.*trending/i,
                                          /trending.*shows?/i,
                                          /trending.*series/i
                                      ];

                            let smartCollection = null;
                            for (const pattern of keywords) {
                                smartCollection = collections.find((c) => pattern.test(c.Name || ''));
                                if (smartCollection) break;
                            }

                            if (smartCollection) {
                                log.info(`Found smart trending collection for ${type}: "${smartCollection.Name}"`);
                                // If preference is active, dynamically use the detected smart collection's name
                                if (useTrendingColName && smartCollection.Name) {
                                    descriptor.title = smartCollection.Name;
                                }

                                let items = null;
                                if (smartCollection.Type === 'Playlist') {
                                    // Query smart playlist items with unauthorized suppression
                                    const plRes = await api
                                        .getPlaylistItems(
                                            smartCollection.Id,
                                            {
                                                Limit: homeRowLimit
                                            },
                                            { suppressUnauthorized: true, warnOnError: true }
                                        )
                                        .catch(() => null);
                                    items = plRes?.Items;
                                } else {
                                    // Query collection items with unauthorized suppression
                                    let boxRes = await api
                                        .getItems(
                                            {
                                                ParentId: smartCollection.Id,
                                                Limit: homeRowLimit,
                                                IncludeItemTypes: type,
                                                Fields: 'PrimaryImageAspectRatio,CanFilter,UserData',
                                                Recursive: true
                                            },
                                            { suppressUnauthorized: true, warnOnError: true }
                                        )
                                        .catch(() => null);
                                    items = boxRes?.Items;

                                    // Secondary query without type filter if initially empty
                                    if (!items || items.length === 0) {
                                        boxRes = await api
                                            .getItems(
                                                {
                                                    ParentId: smartCollection.Id,
                                                    Limit: homeRowLimit,
                                                    Fields: 'PrimaryImageAspectRatio,CanFilter,UserData',
                                                    Recursive: true
                                                },
                                                { suppressUnauthorized: true, warnOnError: true }
                                            )
                                            .catch(() => null);
                                        items = boxRes?.Items;
                                    }
                                }

                                if (items && items.length > 0) {
                                    return items;
                                }
                            }
                        }

                        // 3. Fallback: Query top rated & popular items of the respective type
                        log.info(`Querying top rated ${type} for trending fallback`);
                        // In Jellyfin, Series items are folders (IsFolder: true).
                        // Applying Filters: 'IsNotFolder' would completely wipe out TV series results.
                        const queryParams = {
                            IncludeItemTypes: type,
                            SortBy: 'CommunityRating,PremiereDate',
                            SortOrder: 'Descending',
                            Recursive: true,
                            Limit: homeRowLimit
                        };
                        if (type !== 'Series') {
                            queryParams.Filters = 'IsNotFolder';
                        }

                        const fallbackRes = await api.getItems(queryParams);

                        return fallbackRes?.Items?.length > 0 ? fallbackRes.Items : null;
                    } catch (err) {
                        log.warn(`Failed to fetch trending ${type}:`, err);
                        return null;
                    }
                }
            };

            return descriptor;
        };

        const trendingMoviesDesc = createTrendingDescriptor(
            'trending',
            'Movie',
            'pref:trendingMoviesCollection',
            'pref:trendingMoviesCollectionName',
            'HeaderTrendingMovies'
        );

        const trendingSeriesDesc = createTrendingDescriptor(
            'trending-series',
            'Series',
            'pref:trendingSeriesCollection',
            'pref:trendingSeriesCollectionName',
            'HeaderTrendingSeries'
        );

        // ── Additional Custom Collection Rows ─────────────────────────────
        const customColRaw = storage.getItem('pref:customCollectionRows');
        let customCollections = [];
        if (customColRaw && storage.getItem('pref:enableCollectionRows') === 'true') {
            try {
                customCollections = JSON.parse(customColRaw);
                if (!Array.isArray(customCollections)) customCollections = [];
            } catch (_) {
                customCollections = [];
            }
        }

        const customCollectionDescriptors = customCollections.map((col) => {
            return {
                id: `collection-${col.id}`,
                title: col.name,
                priority: 1,
                layout: 'portrait',
                cardType: 'poster',
                contextType: 'collection',
                fetchFn: async () => {
                    try {
                        let items = null;

                        try {
                            // Query custom playlist items safely
                            const plRes = await api
                                .getPlaylistItems(
                                    col.id,
                                    { Limit: homeRowLimit },
                                    { suppressUnauthorized: true, warnOnError: true }
                                )
                                .catch(() => null);
                            items = plRes?.Items;
                        } catch (_) {}

                        // If not a playlist, query as a collection/library container
                        if (!items || items.length === 0) {
                            const boxRes = await api
                                .getItems(
                                    {
                                        ParentId: col.id,
                                        Limit: homeRowLimit,
                                        IncludeItemTypes: 'Movie,Series',
                                        Fields: 'PrimaryImageAspectRatio,CanFilter,UserData',
                                        Recursive: true
                                    },
                                    { suppressUnauthorized: true, warnOnError: true }
                                )
                                .catch(() => null);
                            items = boxRes?.Items;

                            // Secondary fallback query without type filters
                            if (!items || items.length === 0) {
                                const fallbackRes = await api
                                    .getItems(
                                        {
                                            ParentId: col.id,
                                            Limit: homeRowLimit,
                                            Fields: 'PrimaryImageAspectRatio,CanFilter,UserData',
                                            Recursive: true
                                        },
                                        { suppressUnauthorized: true, warnOnError: true }
                                    )
                                    .catch(() => null);
                                items = fallbackRes?.Items;
                            }
                        }

                        return items?.length > 0 ? items : null;
                    } catch (err) {
                        log.warn(`Failed to fetch custom collection ${col.name}:`, err);
                        return null;
                    }
                }
            };
        });

        if (mergeResumeNextUp) {
            descriptors.push({
                id: 'resume',
                title: i18n.t('HeaderContinueWatching'),
                priority: 1,
                layout: 'landscape',
                cardType: 'resume',
                contextType: 'resume',
                fetchFn: async () => {
                    // ──────────────────────────────────────────────────────────
                    // STAGE 0: Preference Parsing & Cutoff Computation
                    // ──────────────────────────────────────────────────────────
                    // Retrieve configured maximum inactivity cutoff limit for Next Up items.
                    // If configured, shows whose parent series have been inactive longer than
                    // this period must not be surfaced in the merged dashboard row.
                    const maxDays = parseInt(storage.getItem('pref:nextUpMaxDays'), 10);
                    const daysLimit = isNaN(maxDays) ? 365 : maxDays;
                    const mergedParams = { limit: homeRowLimit };

                    // Retrieve configured mark as watched threshold fraction and percentage
                    const thresholdFraction = PlayerSettings.getWatchedThresholdFraction();
                    const watchedThresholdPct = Math.round(thresholdFraction * 100);

                    // Pass watched threshold percentage to server companion plugin query parameters
                    mergedParams.watchedThreshold = watchedThresholdPct;

                    // Calculate cutoff threshold timestamp if a positive limit is enforced
                    let cutoffIso = null;
                    if (daysLimit > 0) {
                        const cutoff = new Date();
                        cutoff.setDate(cutoff.getDate() - daysLimit);
                        cutoffIso = cutoff.toISOString();
                        // Provide both casing formats to support Jellyfin and companion plugin routing conventions
                        mergedParams.nextUpDateCutoff = cutoffIso;
                        mergedParams.NextUpDateCutoff = cutoffIso;
                    }

                    // Try to query the custom server-side merged endpoint first to speed up load times
                    try {
                        log.info('Attempting to fetch pre-merged continue/next-up rows from Litefin plugin');

                        // Request a combined list of items limited by user's homeRowLimit setting and date cutoff
                        const response = await api.getMergedRows(mergedParams);

                        // Verify that response contains valid items and no corrupted zero IDs
                        // Older or misconfigured server plugins can return Id: "0", which causes broken routes.
                        const hasCorruptIds = response?.Items?.some((i) => !i.Id || i.Id === '0');
                        if (response && response.Items && response.Items.length > 0 && !hasCorruptIds) {
                            // Defensively filter items to ensure finished items and items exceeding watched threshold are excluded
                            const filteredPluginItems = response.Items.filter((item) => {
                                // Exclude invalid items and container folders
                                if (!item || item.Type === 'Season' || item.Type === 'Series' || item.IsFolder) {
                                    return false;
                                }

                                // Reconcile against recent authoritative playback stop state
                                this._reconcileItemPlaybackState(item);

                                // Exclude items already marked as watched/played
                                if (item.UserData?.Played) {
                                    return false;
                                }

                                // Exclude items that have reached or exceeded the configured watched threshold percentage
                                const positionTicks = item.UserData?.PlaybackPositionTicks || 0;
                                const runTimeTicks = item.RunTimeTicks || 0;
                                if (positionTicks > 0 && runTimeTicks > 0) {
                                    const progress = positionTicks / runTimeTicks;
                                    if (progress >= thresholdFraction) {
                                        return false;
                                    }
                                }

                                return true;
                            });

                            if (filteredPluginItems.length > 0) {
                                log.info(
                                    'Successfully fetched and verified merged items from server-side Litefin plugin'
                                );
                                return filteredPluginItems;
                            }
                        }

                        if (hasCorruptIds) {
                            log.warn(
                                'Litefin plugin returned items with zero or missing IDs; falling back to client merge.'
                            );
                        }
                    } catch (err) {
                        // Fall back to client-side merge if the plugin is not installed or returns an error
                        log.warn(
                            'Litefin plugin endpoint failed or not installed. Falling back to client-side merge:',
                            err
                        );
                    }

                    // ──────────────────────────────────────────────────────────
                    // FALLBACK: Parallel Fetching of Base Data Lists
                    // ──────────────────────────────────────────────────────────
                    // We initiate simultaneous network requests for both in-progress items
                    // and next-up show items to optimize load times and keep the UI highly
                    // responsive under typical domestic network latency.
                    const [resumeRes, nextUpRes] = await Promise.all([
                        api.getResumeItems({ Limit: homeRowLimit }),
                        (async () => {
                            const params = { Limit: homeRowLimit };

                            // If a valid cutoff constraint is present, pass it along as an ISO date string.
                            if (cutoffIso) {
                                params.NextUpDateCutoff = cutoffIso;
                            }
                            return api.getNextUp(params);
                        })()
                    ]);

                    // Extract items list safely and tag them with a transient _isResume flag.
                    // Filter out finished items and items that have reached the configured watched threshold.
                    const resumeItems = (resumeRes?.Items || [])
                        .filter((item) => {
                            // Defensive guard: Drop non-playable container folders
                            if (!item || item.Type === 'Season' || item.Type === 'Series' || item.IsFolder) {
                                return false;
                            }

                            // Reconcile against recent authoritative playback stop state
                            this._reconcileItemPlaybackState(item);

                            // Exclude items already marked as watched/played
                            if (item.UserData?.Played) {
                                return false;
                            }

                            // Exclude items that have reached or passed the configured watched threshold
                            const positionTicks = item.UserData?.PlaybackPositionTicks || 0;
                            const runTimeTicks = item.RunTimeTicks || 0;
                            if (positionTicks > 0 && runTimeTicks > 0) {
                                const progress = positionTicks / runTimeTicks;
                                if (progress >= thresholdFraction) {
                                    return false;
                                }
                            }

                            return true;
                        })
                        .map((item) => ({
                            ...item,
                            _isResume: true
                        }));

                    const nextUpItems = (nextUpRes?.Items || [])
                        .filter((item) => {
                            // Defensive guard: Drop non-playable container folders (e.g. Season/Series)
                            if (!item || item.Type === 'Season' || item.Type === 'Series' || item.IsFolder)
                                return false;

                            // Reconcile against recent authoritative playback stop state
                            this._reconcileItemPlaybackState(item);

                            // Drop items already watched or completed
                            if (item.UserData?.Played) return false;

                            // Filter out next-up items that have already been partially played,
                            // as those are already accounted for in the continue watching row list.
                            const position = item.UserData?.PlaybackPositionTicks || 0;
                            return position === 0;
                        })
                        .map((item) => ({
                            ...item,
                            _isResume: false
                        }));

                    // ──────────────────────────────────────────────────────────
                    // STAGE 2: Fetching of Parent Show Activity Dates
                    // ──────────────────────────────────────────────────────────
                    // Because next-up episodes are unplayed by definition, their own
                    // LastPlayedDate is null or undefined. To perform chronological
                    // Plex-style sorting, we rank each series the way Jellyfin's own
                    // Next Up (and the Litefin plugin) does: by when its furthest-watched
                    // episode was played, so rewatching an earlier episode does not move
                    // the series up. Series without a date fall back to DateCreated below.
                    const seriesLastPlayedMap = await getSeriesLastWatchedDates(
                        nextUpItems.map((item) => item.SeriesId)
                    );

                    // ──────────────────────────────────────────────────────────
                    // STAGE 3: Merge, Deduplicate, and Interweave
                    // ──────────────────────────────────────────────────────────
                    // Combine the lists and de-duplicate by database Item ID.
                    const combined = [...resumeItems, ...nextUpItems];

                    const seen = new Set();
                    const deduplicated = combined.filter((item) => {
                        if (seen.has(item.Id)) return false;
                        seen.add(item.Id);
                        return true;
                    });

                    // ==========================================================
                    // PLEX-STYLE CHRONOLOGICAL SORTING
                    // ==========================================================
                    //
                    // Replicates Plex's signature dashboard logic by sorting the merged
                    // array descending based on when the show/movie was last interacted with.
                    // Instead of a rigid "all resume items first" block layout, this interweaves
                    // your partially played movies/episodes with the next upcoming episodes in
                    // the exact order they were last watched.
                    //
                    // Falls back to DateCreated (indexing date) or 0 (epoch) for safety.
                    deduplicated.sort((a, b) => {
                        // Retrieve or compute the most accurate activity timestamp available for item A.
                        let timeA = 0;
                        if (a._isResume && a.UserData?.LastPlayedDate) {
                            // If it's a resume item, we prioritize its direct, precise pause timestamp.
                            timeA = new Date(a.UserData.LastPlayedDate).getTime();
                        } else if (a.SeriesId && seriesLastPlayedMap[a.SeriesId]) {
                            // If it's a next-up item, we prioritize its series' furthest-watched episode play date.
                            timeA = seriesLastPlayedMap[a.SeriesId];
                        } else if (a.UserData?.LastPlayedDate) {
                            // Fallback to the item's own LastPlayedDate if available.
                            timeA = new Date(a.UserData.LastPlayedDate).getTime();
                        } else {
                            // Fallback to the media creation/indexing timestamp.
                            timeA = new Date(a.DateCreated || 0).getTime();
                        }

                        // Retrieve or compute the most accurate activity timestamp available for item B.
                        let timeB = 0;
                        if (b._isResume && b.UserData?.LastPlayedDate) {
                            // If it's a resume item, we prioritize its direct, precise pause timestamp.
                            timeB = new Date(b.UserData.LastPlayedDate).getTime();
                        } else if (b.SeriesId && seriesLastPlayedMap[b.SeriesId]) {
                            // If it's a next-up item, we prioritize its series' furthest-watched episode play date.
                            timeB = seriesLastPlayedMap[b.SeriesId];
                        } else if (b.UserData?.LastPlayedDate) {
                            // Fallback to the item's own LastPlayedDate if available.
                            timeB = new Date(b.UserData.LastPlayedDate).getTime();
                        } else {
                            // Fallback to the media creation/indexing timestamp.
                            timeB = new Date(b.DateCreated || 0).getTime();
                        }

                        // Sort descending: most recently active media at the start of the row.
                        return timeB - timeA;
                    });

                    // Return deduplicated results trimmed to homeRowLimit
                    const sliced = deduplicated.slice(0, homeRowLimit);
                    return sliced.length > 0 ? sliced : null;
                }
            });
            if (trendingMoviesDesc) {
                descriptors.push(trendingMoviesDesc);
            }
            if (trendingSeriesDesc) {
                descriptors.push(trendingSeriesDesc);
            }
            if (customCollectionDescriptors.length > 0) {
                descriptors.push(...customCollectionDescriptors);
            }
        } else {
            // Priority 1: Continue Watching (Separate)
            descriptors.push({
                id: 'resume',
                title: i18n.t('HeaderContinueWatching'),
                priority: 1,
                layout: 'landscape',
                cardType: 'resume',
                contextType: 'resume',
                fetchFn: async () => {
                    const res = await api.getResumeItems({ Limit: homeRowLimit });
                    if (!res?.Items?.length) return null;

                    // Defensively filter items using configured watched threshold
                    const thresholdFraction = PlayerSettings.getWatchedThresholdFraction();
                    const filtered = res.Items.filter((item) => {
                        // Drop invalid items and container folders
                        if (!item || item.IsFolder) return false;

                        // Reconcile against recent authoritative playback stop state
                        this._reconcileItemPlaybackState(item);

                        // Exclude items already marked as watched/played
                        if (item.UserData?.Played) return false;

                        // Exclude items that have reached or passed the watched threshold
                        const positionTicks = item.UserData?.PlaybackPositionTicks || 0;
                        const runTimeTicks = item.RunTimeTicks || 0;
                        if (positionTicks > 0 && runTimeTicks > 0) {
                            const progress = positionTicks / runTimeTicks;
                            if (progress >= thresholdFraction) return false;
                        }

                        return true;
                    });

                    return filtered.length > 0 ? filtered : null;
                }
            });

            // Priority 1: Trending / Em Alta (Movies & Series)
            if (trendingMoviesDesc) {
                descriptors.push(trendingMoviesDesc);
            }
            if (trendingSeriesDesc) {
                descriptors.push(trendingSeriesDesc);
            }
            if (customCollectionDescriptors.length > 0) {
                descriptors.push(...customCollectionDescriptors);
            }

            // Priority 1: Next Up (Separate)
            descriptors.push({
                id: 'next-up',
                title: i18n.t('NextUp'),
                priority: 1,
                layout: 'landscape',
                cardType: 'episode',
                contextType: 'nextUp',
                fetchFn: async () => {
                    const maxDays = parseInt(storage.getItem('pref:nextUpMaxDays'), 10);
                    const daysLimit = isNaN(maxDays) ? 365 : maxDays;

                    const params = { Limit: homeRowLimit };
                    if (daysLimit > 0) {
                        const cutoff = new Date();
                        cutoff.setDate(cutoff.getDate() - daysLimit);
                        params.NextUpDateCutoff = cutoff.toISOString();
                    }

                    const res = await api.getNextUp(params);
                    if (!res?.Items?.length) return null;

                    const filtered = res.Items.filter((item) => {
                        // Defensive guard: Drop non-playable container folders (e.g. Season/Series)
                        if (!item || item.Type === 'Season' || item.Type === 'Series' || item.IsFolder) return false;

                        // Reconcile against recent authoritative playback stop state
                        this._reconcileItemPlaybackState(item);

                        // Drop items already watched or completed
                        if (item.UserData?.Played) return false;

                        const position = item.UserData?.PlaybackPositionTicks || 0;
                        return position === 0;
                    });

                    return filtered.length > 0 ? filtered : null;
                }
            });
        }

        // ── Priority 2: Latest per library ───────────────────────────────────
        // Each library gets its own descriptor so they can render independently
        // as they resolve, rather than waiting for all libraries to finish.
        const hidePlayedInLatest = storage.getItem('pref:hidePlayedInLatest') === 'true';

        for (const lib of this._libraries) {
            descriptors.push({
                id: `latest-${lib.Id}`,
                title: i18n.t('LatestFromLibrary', [lib.Name]),
                priority: 2,
                // Music, Live TV, Home Video, and Music Video libraries use square cards, everything else uses portrait
                /*
                 * ============================================================
                 * UI Layout Aspect Determination
                 * ============================================================
                 *
                 * should display items in card aspect ratios that match their
                 * media type semantics.
                 *
                 *   - Audio/Music albums, live tuner sources, personal/home
                 *     recordings, and music videos require a symmetrical
                 *     1:1 aspect ratio ("square") for ideal presentation.
                 *
                 *   - Movies and TV Shows align beautifully to a 2:3 aspect
                 *     ratio ("portrait" or "poster" card type).
                 */
                layout:
                    lib.CollectionType === 'musicvideos' || lib.CollectionType === 'homevideos'
                        ? 'landscape'
                        : lib.CollectionType === 'music' || lib.CollectionType === 'livetv'
                          ? 'square'
                          : 'portrait',
                cardType:
                    lib.CollectionType === 'musicvideos' || lib.CollectionType === 'homevideos'
                        ? 'thumb'
                        : lib.CollectionType === 'music' || lib.CollectionType === 'livetv'
                          ? 'square'
                          : 'poster',
                contextType: 'latest',
                fetchFn: async function () {
                    if (this._preFetchedItems) {
                        return this._preFetchedItems.length > 0 ? this._preFetchedItems : null;
                    }
                    try {
                        const params = hidePlayedInLatest ? { Filters: 'IsUnplayed' } : {};
                        params.Limit = homeRowLimit;
                        const items = await api.getLatestItems(lib.Id, params);
                        return items?.length > 0 ? items : null;
                    } catch (e) {
                        log.warn(`Failed to load latest for ${lib.Name}`, e);
                        return null;
                    }
                }
            });
        }

        // Sort by ascending priority so we render in order
        descriptors.sort((a, b) => a.priority - b.priority);

        // ====================================================================
        // Layout Overrides for Modern Posters & Force Expandable Posters
        // ====================================================================
        // In Modern Posters layout or if Force Expandable Posters is active in Modern mode,
        // all horizontal rows (except My Media library row and Square rows) render as portrait posters.
        // ====================================================================
        const isModern = layoutManager.getLayout() === 'modern';
        const isModernPosters = layoutManager.getLayout() === 'modern-posters';
        const forceExpandablePosters = isModern && storage.getItem('pref:homeForceExpandablePosters') === 'true';
        if (forceExpandablePosters || isModernPosters) {
            for (const desc of descriptors) {
                // The "My Media" row uses library folder cards that must remain as static landscape cards
                // Square rows (music, livetv, etc.) remain square
                if (
                    desc.id !== 'my-media' &&
                    desc.layout !== 'square' &&
                    desc.cardType !== 'library' &&
                    desc.cardType !== 'square'
                ) {
                    desc.layout = 'portrait';
                    desc.cardType = 'poster';
                }
            }
        }

        // Apply dynamic user layout sorting and visibility filtering
        return homeLayoutManager.applyLayout(descriptors);
    }

    // =========================================================================
    // Render Pipeline
    // =========================================================================

    /**
     * Entry point for the progressive render pipeline.
     *
     * Flow:
     *   1. Fetch core dependencies (user views / libraries).
     *   2. Insert skeleton rows immediately for a fast visual response.
     *   3. Build descriptors and group by priority.
     *   4. Render priority-0 group first, await, then fire the rest.
     *
     * This means the "My Media" row appears almost instantly, then
     * Continue Watching + Next Up appear together, then library rows
     * trickle in one by one as their API calls resolve.
     */
    async _startRenderPipeline() {
        this.setLoading(true);
        this.hideError();

        // Capture auth snapshot before any requests (useful for error messages)
        const preAuth = {
            uid: api._userId,
            dev: api._deviceId,
            hasTok: !!api._accessToken
        };

        try {
            log.info(`Starting progressive render pipeline for user ${preAuth.uid}`);

            // ─── Step 0: Try to restore from cached data ────────────────────
            // On back-navigation, avoid all network calls and render from cache.
            const cache = this._getValidCache();
            this._wasPageCached = !!cache;

            // Track promises for hero carousel and library thumb enrichment
            // so we can await them alongside P0/P1 rows in Step 6.
            let heroPromise = null;
            let enrichPromise = null;

            if (cache) {
                log.info('Restoring homepage from cache');
                this._restoreFromCache(cache);

                // Re-initialize the hero carousel from cached items — no API call needed.
                // The enableHero preference is re-checked so the user's current setting
                // is always honoured even after a settings change between navigations.
                const enableHero = storage.getItem('pref:heroCarousel') !== 'false';
                if (enableHero && cache.heroItems && cache.heroItems.length > 0) {
                    this._initHeroCarouselFromItems(cache.heroItems);
                }
            } else {
                // ─── Step 1: Load core dependencies ──────────────────────────────
                // Libraries are shared across multiple descriptors.
                // Check in-memory state cache first to avoid redundant network calls
                // within the same app session.
                const cachedLibs = state.get('home:libraries');
                if (cachedLibs && cachedLibs.length > 0) {
                    this._libraries = cachedLibs;
                } else {
                    const viewsResponse = await api.getUserViews();
                    this._libraries = viewsResponse.Items || [];
                    if (this._libraries.length > 0) {
                        state.set('home:libraries', this._libraries);
                    }
                }

                if (!this._isMounted) return;

                // ─── Step 1b: Prune stale libThumb:* cache keys ──────────────────
                // If a library was removed from Jellyfin, its cached thumbnail URL
                // stays in localStorage forever. We run a quick Set-lookup against
                // the IDs we just fetched and evict any orphaned keys via StorageService
                // (which correctly updates the in-memory cache, not just disk).
                const currentLibraryIds = new Set(this._libraries.map((l) => l.Id));
                storage
                    .keys()
                    .filter((k) => k.startsWith('libThumb:'))
                    .forEach((k) => {
                        const id = k.replace('libThumb:', '');
                        if (!currentLibraryIds.has(id)) {
                            log.info(`Pruning stale libThumb for removed library: ${id}`);
                            storage.removeItem(k);
                        }
                    });

                // ─── Step 2: Hero Carousel (fire in background) ──────────────────
                // Hero does not depend on libraries — fetch it in parallel but do NOT
                // await it here so row rendering starts immediately. It populates the
                // hero placeholder when its data arrives.
                // Insert a static placeholder so the hero area is sized correctly
                // while data loads (no animated shimmer — just dark rectangles).
                const enableHero = storage.getItem('pref:heroCarousel') !== 'false';
                if (enableHero) {
                    this._insertHeroSkeleton();
                    heroPromise = this._loadHeroCarousel().catch((err) => log.error('Hero carousel failed', err));
                }

                // ─── Step 2b: Fire library thumb enrichment (parallel) ──────────
                // Libraries are available — start enrichment immediately so the
                // dynamic thumb URLs resolve before the library row renders below.
                const thumbMode = storage.getItem('pref:libraryThumbMode') || 'off';
                if ((thumbMode === 'static' || thumbMode === 'dynamic') && this._libraries.length > 0) {
                    enrichPromise = this._enrichLibrariesWithDynamicThumbs(this._libraries, thumbMode).catch((err) =>
                        log.warn('Background thumb enrichment failed', err)
                    );
                }
            }

            // ─── Step 3: Build descriptors ────────────────────────────────────
            const descriptors = this._getRowDescriptors();

            // If restored from cache, replace fetchFns with cached item arrays
            if (cache) {
                this._applyCachedRowData(descriptors, cache.rows);
            }

            // Validate focus target exists in the generated descriptors
            const lastFocusedObj = state.get('home:lastFocusedItem');
            if (lastFocusedObj && lastFocusedObj.rowId) {
                const rowExists = descriptors.some((d) => d.id === lastFocusedObj.rowId);
                if (!rowExists) {
                    state.delete('home:lastFocusedItem');
                }
            }

            if (descriptors.length === 0) {
                this.showError(i18n.t('NoLibraries'));
                this._hideSplash();
                return;
            }

            // ─── Step 4: Batch pre-fetch latest library rows via plugin ──────────
            // Pre-loads all latest rows across libraries in one round-trip.
            // Executed early so network latency overlaps with initial setup.
            //
            // If the homepage was restored from in-memory cache, all descriptors
            // already have their items populated via _applyCachedRowData().
            // Bypassing this network request during cache restoration ensures that
            // returning to the home screen is instantaneous and never stalled by
            // server delays, socket saturation, or network timeouts.
            if (!cache) {
                await this._preFetchLatestRows(descriptors);
            }

            // ─── Step 5: Partition eager vs deferred rows in natural user order ─
            // The `descriptors` array is already ordered by homeLayoutManager.applyLayout()
            // according to the user's custom configuration.
            //
            // To ensure the visual row order in the DOM strictly mirrors the user's
            // preference (e.g. moving "My Media" or any library to the very bottom),
            // we partition rows strictly along their sequence in `descriptors` rather than
            // segregating by static priority numbers.
            const hasFocusTarget = this._pendingNavState || state.get('home:lastFocusedItem');
            const savedFocusObj =
                storage.getItem('pref:disableFocusRestore') !== 'true' ? state.get('home:lastFocusedItem') : null;
            const targetRowId = savedFocusObj ? savedFocusObj.rowId : null;
            const targetIndex = targetRowId ? descriptors.findIndex((d) => d.id === targetRowId) : -1;

            // Determine how many rows to mount eagerly at page startup.
            // EAGER_ROW_COUNT covers the top visible viewport (e.g. 3 rows).
            // If restoring focus to a row beyond the initial count, we extend the eager
            // slice up to and including that target row so its DOM position and focus
            // target are fully prepared before the splash overlay is dismissed.
            let eagerCount = Math.min(EAGER_ROW_COUNT, descriptors.length);
            if (targetIndex !== -1 && targetIndex >= eagerCount) {
                // Ensure target row is included in the eagerly mounted batch
                eagerCount = targetIndex + 1;
            }

            // Slice out the eager descriptors and queue the remaining for deferred loading.
            // Filter out any descriptor the registry already rendered (e.g. rows
            // restored from the page cache) — leaving them in the queue creates
            // dead duplicates that waste batch cycles and poison autofocus.
            const eagerDescriptors = descriptors.slice(0, eagerCount);
            this._deferredDescriptors = descriptors.slice(eagerCount).filter((d) => !this._rowRegistry.has(d.id));
            this._nextDeferredDescIndex = 0;

            // ─── Step 5.5: Insert skeletons in exact natural order ───────────
            // Skeletons for all eager rows are inserted in exact sequence into #home-rows.
            // Because each row replaces its own placeholder via data-row-id, DOM ordering
            // remains 100% stable regardless of which network request finishes first.
            this._insertSkeletonRows(eagerDescriptors);

            // ─── Step 6: Render eager rows + hero carousel in parallel ───────
            // All eager rows (and hero carousel) are kicked off and awaited BEFORE
            // revealing the page so the initial screen paints cleanly without flash.
            const eagerPromises = eagerDescriptors.map((d) => this._loadAndRenderRow(d));
            if (heroPromise) {
                eagerPromises.push(heroPromise);
            }
            if (enrichPromise) {
                eagerPromises.push(enrichPromise);
            }
            await Promise.all(eagerPromises);
            if (!this._isMounted) return;

            // Dismiss the loading spinner now that critical content is rendered.
            // If there's a focus target, _hideSplash() in Step 7 handles it after
            // focus restoration — so we only dismiss here when there's no target.
            if (!hasFocusTarget) {
                this.setLoading(false);
            }

            // ─── Step 7: Hide splash early + restore focus ───────────────────
            // At this point the eager rows are visible. Reveal the page
            // so the user can start interacting while remaining rows load.
            requestAnimationFrame(() => {
                if (!this._isMounted) return;

                try {
                    // Safety net: if no row triggered _tryInitializeFocus during eager render,
                    // initialize on first available row.
                    if (!this._focusInitialized) {
                        this._tryInitializeFocus(this.$('#home-rows'));
                    }

                    // ============================================================
                    // Focus Trap Awareness
                    // ============================================================
                    // If a modal or focus trap (such as the ExitDialog) is currently
                    // active on screen because the user rapidly pressed Back upon
                    // returning to HomePage, do NOT steal focus or change sections.
                    // Keep _pendingFocusRestore intact so that it executes cleanly
                    // if/when the user dismisses the dialog via 'focus:trapPopped'.
                    // ============================================================
                    if (!focusManager.isTrapped()) {
                        // Execute any pending focus restoration callback
                        if (typeof this._pendingFocusRestore === 'function') {
                            this._pendingFocusRestore();
                            this._pendingFocusRestore = null;
                        }

                        // Final fallback: if nothing focused yet, go to sidebar
                        if (!focusManager.getActiveSection() && !focusManager.getFocused()) {
                            this.setActiveSection('sidebar');
                        }
                    } else {
                        log.info('Modal trap active during Step 7 - deferring homepage focus restoration');
                    }
                } catch (err) {
                    log.error('Focus restoration failed, hiding splash anyway', err);
                }

                this._hideSplash();
            });

            // ─── Step 9: Setup lazy-loading for remaining deferred rows ──────
            // If deferred descriptors remain, attach the IntersectionObserver and idle
            // prefetcher to progressively mount them as the user scrolls down.
            if (this._deferredDescriptors.length > 0) {
                this._setupHomeScrollObserver();
                this._scheduleHomeIdlePrefetch(400);
            } else {
                // All rows were rendered eagerly (short page or target near bottom)
                this._prewarmScrollCache();
                this.restoreScrollFocusWhenReady();
                this.markReady();
                if (!cache) {
                    this._savePageCache();
                }
            }
        } catch (error) {
            log.error('Pipeline failed', error);

            // Check for network/server-offline errors
            if (error.name === 'ServerUnreachableError' || error.isNetworkError) {
                log.warn('Server unreachable. Redirecting to OfflinePage.');
                state.set('server:offline', true);
                state.set('user:authenticated', false);
                router.navigate('/offline', { replace: true });
                return;
            }

            // Show error with auth debug info
            const debug = `UID:${preAuth.uid} Dev:${preAuth.dev} Tok:${preAuth.hasTok ? 'OK' : 'MISS'}`;
            const status = error.status ? `HTTP ${error.status}` : 'ERR';
            this.showError(`${status}: ${error.message} [${debug}]`);
            this._hideSplash();
        }
    }

    /**
     * Inserts a skeleton placeholder `<section>` for each descriptor into the
     * home-rows container. Cards are rendered as static dark rectangles (no
     * animated shimmer) to give the row correct visual sizing while data loads.
     * The placeholders are replaced in-place via _renderRow() once data arrives.
     *
     * Each skeleton uses `data-row-id` to allow `_loadAndRenderRow` to find
     * its placeholder and populate it without shifting other rows.
     *
     * @param {RowDescriptor[]} descriptors
     */
    _insertSkeletonRows(descriptors) {
        // Container element holding all homepage row sections
        const container = this.$('#home-rows');
        if (!container) return;

        // Sentinel element watched by IntersectionObserver to trigger deferred loading
        const sentinel = container.querySelector('#home-rows-sentinel');
        // Layout helper to determine aspect ratio per row
        const isLandscape = (descriptor) => descriptor.layout === 'landscape';
        // User preference to suppress labels on library tiles
        const hideLibraryLabels = storage.getItem('pref:hideLibraryLabels') === 'true';

        for (const descriptor of descriptors) {
            // Defensive guard: never add a skeleton if this row already exists in the container
            // This prevents duplicate skeleton rows when resuming or switching views
            if (container.querySelector(`[data-row-id="${descriptor.id}"]`)) {
                continue;
            }

            const landscape = isLandscape(descriptor);
            const isLibrary = descriptor.id === 'my-media';
            const thumbMode = storage.getItem('pref:libraryThumbMode') || 'off';
            const isDynamicThumbMode = thumbMode !== 'off';
            const shouldHideLabels = isLibrary && (hideLibraryLabels || isDynamicThumbMode);

            // Build a skeleton section element
            const sectionEl = document.createElement('section');
            sectionEl.className = `media-row media-row--skeleton${shouldHideLabels ? ' library-no-labels' : ''}`;
            sectionEl.setAttribute('data-row-id', descriptor.id);

            // Set size variables for skeletons based on active card size scale
            const mediaLayout = document.documentElement.getAttribute('data-layout-media-rows');
            const isModern = mediaLayout === 'modern';
            const isExpanded = mediaLayout === 'expanded';
            const isModernPosters = mediaLayout === 'modern-posters';
            if (isExpanded) {
                const scale = parseFloat(storage.getItem('pref:expandedCardSizeScale')) || 1.2;
                const itemMargin = Math.round(26 * scale);
                sectionEl.style.setProperty('--card-width', `${Math.round(396 * scale)}px`);
                sectionEl.style.setProperty('--card-height', `${Math.round(222.75 * scale)}px`);
                sectionEl.style.setProperty('--card-margin', `${itemMargin}px`);
                sectionEl.style.setProperty('--card-expanded-width', `${Math.round(396 * scale)}px`);
                sectionEl.style.setProperty('--card-square-width', `${Math.round(223 * scale)}px`);
                sectionEl.style.setProperty('--card-expansion', '0px');
            } else if (isModernPosters) {
                const scale = parseFloat(storage.getItem('pref:modernPostersCardSizeScale')) || 1.2;
                const itemMargin = Math.round(26 * scale);
                sectionEl.style.setProperty('--card-width', `${Math.round(212 * scale)}px`);
                sectionEl.style.setProperty('--card-height', `${Math.round(318 * scale)}px`);
                sectionEl.style.setProperty('--card-margin', `${itemMargin}px`);
                sectionEl.style.setProperty('--card-expanded-width', `${Math.round(396 * scale)}px`);
                sectionEl.style.setProperty('--card-landscape-width', `${Math.round(396 * scale)}px`);
                sectionEl.style.setProperty('--card-landscape-height', `${Math.round(222.75 * scale)}px`);
                sectionEl.style.setProperty('--card-square-width', `${Math.round(223 * scale)}px`);
                sectionEl.style.setProperty('--card-square-height', `${Math.round(223 * scale)}px`);
                sectionEl.style.setProperty('--card-expansion', '0px');
            } else if (isModern) {
                const scale = parseFloat(storage.getItem('pref:modernCardSizeScale')) || 1.0;
                const itemMargin = Math.round(31 * scale);
                sectionEl.style.setProperty('--card-width', `${Math.round(175.5 * scale)}px`);
                sectionEl.style.setProperty('--card-height', `${Math.round(263.25 * scale)}px`);
                sectionEl.style.setProperty('--card-margin', `${itemMargin}px`);
                sectionEl.style.setProperty('--card-expanded-width', `${Math.round(468 * scale)}px`);
                sectionEl.style.setProperty('--card-square-width', `${Math.round(264 * scale)}px`);
                sectionEl.style.setProperty('--card-expansion', `${Math.round(292.5 * scale)}px`);
            } else {
                const scale = parseFloat(storage.getItem('pref:classicCardSizeScale')) || 1.0;
                const itemWidth = Math.round((landscape ? 400 : 240) * scale);
                const itemMargin = Math.round(24 * scale);
                sectionEl.style.setProperty('--skeleton-card-width', `${itemWidth}px`);
                sectionEl.style.setProperty('--skeleton-card-margin', `${itemMargin}px`);
            }

            // Build skeleton interior — title + static placeholder cards
            // If items for this descriptor are already prefetched in memory,
            // we don't need to generate heavy skeleton HTML with multiple cards.
            // A clean lightweight placeholder ensures the section exists in the DOM
            // without layout thrashing right before real cards are mounted.
            const hasPrefetched = Boolean(descriptor._preFetchedItems && descriptor._preFetchedItems.length > 0);
            let staticHtml = '';
            if (!hasPrefetched) {
                const skeletonCardCount = landscape || isExpanded ? 5 : 8;
                const rawHtml = CardRenderer.createSkeletonHtml(
                    skeletonCardCount,
                    landscape,
                    descriptor.cardType || 'poster',
                    shouldHideLabels
                );
                staticHtml = rawHtml.replace(/\bskeleton-shimmer\b/g, '');
            }

            sectionEl.innerHTML = `
                <h2 class="row-title">${descriptor.title}</h2>
                <div class="row-items">
                    <div class="row-items-track">
                        ${staticHtml}
                    </div>
                </div>
            `;

            // Always insert before the scroll sentinel so the sentinel remains
            // trailing at the very end of the row stream
            if (sentinel) {
                container.insertBefore(sectionEl, sentinel);
            } else {
                container.appendChild(sectionEl);
            }

            // ── Make the skeleton an instant D-pad navigation target ─────────
            // While this descriptor's data is loading, the placeholder cards are
            // focusable so pressing Down at the row boundary moves focus into
            // this section immediately instead of waiting for the network round
            // trip to finish. _renderRow() replaces the interior and re-registers
            // the same section name with the real VirtualCardRow config.
            // Prefetched descriptors (data already in memory) skip skeleton cards
            // entirely — their section stays empty and the skip loop jumps past;
            // their real row renders almost immediately after.
            if (!hasPrefetched) {
                const cards = sectionEl.querySelectorAll('.media-card');
                cards.forEach((card, i) => {
                    card.setAttribute('tabindex', '0');
                    // Keep the focus position across the skeleton → live swap
                    card.dataset.skeletonIndex = String(i);
                });
            }
            this._registerSkeletonSection(descriptor, sectionEl);
        }
    }

    /**
     * Registers a FocusManager section for a loading row's skeleton placeholder.
     *
     * This gives the D-pad an instant target when the user navigates down past
     * the last rendered row while data is still loading: focus hops into the
     * skeleton's placeholder card right away, and when the real row content
     * arrives, _renderRow() transfers focus onto the first real card at the
     * remembered skeleton index.
     *
     * @param {RowDescriptor} descriptor - Row descriptor being loaded
     * @param {HTMLElement} sectionEl - The skeleton section element
     * @private
     */
    _registerSkeletonSection(descriptor, sectionEl) {
        const itemsContainer = sectionEl.querySelector('.row-items');
        if (!itemsContainer) return;

        this.registerFocusSection(`home-row-${descriptor.id}`, itemsContainer, {
            orientation: 'horizontal',
            leaveUp: null, // Patched by _relinkAdjacentSections()
            leaveDown: null, // Patched by _relinkAdjacentSections()
            leaveLeft: 'sidebar',
            onMove: (direction, currentElement) => {
                const cards = Array.from(itemsContainer.querySelectorAll('.media-card'));
                const idx = cards.indexOf(currentElement);
                if (idx === -1) return false;
                const next = idx + (direction === 'left' ? -1 : 1);
                if (next < 0 || next >= cards.length) return false;
                focusManager.focusElement(cards[next]);
                return true;
            },
            onEnter: (fromElement, options) => {
                if (fromElement && options && options.direction === 'up') {
                    // Entering from below: land on the LAST skeleton card so the
                    // cursor position matches its source position mirrored
                    const cards = itemsContainer.querySelectorAll('.media-card');
                    return cards.length ? cards[cards.length - 1] : null;
                }
                return null;
            }
        });
    }

    /**
     * Loads data for a single row descriptor, then replaces its skeleton
     * placeholder with the fully rendered VirtualCardRow.
     *
     * This is the core of the progressive render pattern. Each row is
     * completely independent — a slow network request for one row does NOT
     * block other rows from appearing.
     *
     * @param {RowDescriptor} descriptor
     * @returns {Promise<boolean>} true when the row was actually rebuilt from
     *   fresh data this call; false when it was skipped (duplicate, empty, or failed)
     */
    async _loadAndRenderRow(descriptor) {
        if (!this._isMounted) return false;

        // Defensive guard: if row is already fully rendered in the registry, avoid duplicate load
        if (this._rowRegistry.has(descriptor.id)) {
            return false;
        }

        try {
            // Fetch this row's data via its individual fetch function.
            // A background prefetch (see _prefetchRow) may already have the request
            // in flight — reuse that promise so the network round-trip overlaps
            // with whatever triggered this load instead of restarting from zero.
            const items = await (descriptor._prefetchPromise || descriptor.fetchFn());

            if (!this._isMounted) return false;

            // If the fetch returned no items, remove the skeleton placeholder
            if (!items || items.length === 0) {
                // Drop the skeleton's FocusManager registration before removing
                // its DOM container (skeleton sections are real nav targets now)
                focusManager.unregister(`home-row-${descriptor.id}`);
                const placeholder = this.$(`[data-row-id="${descriptor.id}"]`);
                if (placeholder) {
                    placeholder.remove();
                }
                log.debug(`Row "${descriptor.id}" has no items, removed placeholder.`);
                this._checkFocusRestoration(descriptor.id, false);

                // Relink remaining rows so the new top row connects to home-hero
                const container = this.$('#home-rows');
                if (container) {
                    const firstRow =
                        container.querySelector('section[data-row-id]:not(.media-row--skeleton)') ||
                        container.querySelector('section[data-row-id]');
                    if (firstRow) {
                        const firstRowId = firstRow.getAttribute('data-row-id');
                        this._relinkAdjacentSections(container, firstRow, firstRowId);
                    }
                }
                return false;
            }

            // Find the placeholder and replace it with a live row
            this._renderRow(descriptor, items);

            // Speculative image pre-warming is deferred to an idle period or timer
            // so critical DOM construction and visible image decodes get full bandwidth.
            if (typeof requestIdleCallback !== 'undefined') {
                requestIdleCallback(() => {
                    if (this._isMounted) this._preWarmImagesForRow(descriptor, items);
                });
            } else {
                setTimeout(() => {
                    if (this._isMounted) this._preWarmImagesForRow(descriptor, items);
                }, 200);
            }
            this._checkFocusRestoration(descriptor.id, true);
            return true;
        } catch (error) {
            log.error(`Failed to load row "${descriptor.id}"`, error);

            // Remove the failed row's skeleton so we don't show an empty shimmer forever
            focusManager.unregister(`home-row-${descriptor.id}`);
            const placeholder = this.$(`[data-row-id="${descriptor.id}"]`);
            if (placeholder) {
                placeholder.remove();
            }
            this._checkFocusRestoration(descriptor.id, false);
            return false;
        }
    }

    /**
     * Starts a single row's network fetch in the background WITHOUT touching the
     * DOM or consuming the deferred queue. The resulting promise is cached on the
     * descriptor so the later real load (_loadAndRenderRow) reuses it.
     *
     * This lets the network round-trip overlap with an in-flight scroll animation:
     * the data can be fully received by the time the scroll settles, so the
     * boundary keypress (D-pad past the last rendered row) no longer waits for a
     * network request before focus can move.
     *
     * @param {RowDescriptor} descriptor
     */
    _prefetchRow(descriptor) {
        if (descriptor._prefetchPromise) return descriptor._prefetchPromise;
        descriptor._prefetchPromise = descriptor.fetchFn().catch((err) => {
            log.warn(`Prefetch failed for row "${descriptor.id}"`, err);
            return null;
        });
        return descriptor._prefetchPromise;
    }

    /**
     * Loads remaining priority groups in the background after the splash overlay
     * has been hidden. Rows within each priority group fire in parallel, but groups
     * run sequentially to avoid overwhelming the TV's limited HTTP connection pool.
     *
     * Once all background rows complete, runs post-render cleanup (prewarm scroll
     * cache, markReady, save page cache, library thumb enrichment).
     *
     * @param {number[]} remainingPriorities - Priority values to load
     * @param {Map<number, RowDescriptor[]>} priorityGroups
     */
    /**
     * Pre-fetches all visible latest library rows in 1 single HTTP request via Litefin plugin.
     * @param {RowDescriptor[]} descriptors
     */
    async _preFetchLatestRows(descriptors) {
        const useBatchPlugin = storage.getItem('pref:useBatchLatestPlugin') !== 'false';
        if (!useBatchPlugin) return;

        const latestDescriptors = (descriptors || []).filter((d) => d.id?.startsWith('latest-'));
        if (latestDescriptors.length === 0) return;

        const libraryIds = latestDescriptors.map((d) => d.id.replace('latest-', ''));
        const hidePlayed = storage.getItem('pref:hidePlayedInLatest') === 'true';
        // Ensure we read the canonical pref:homeRowsLimit user preference (defaulting to 12)
        const homeRowLimit = parseInt(storage.getItem('pref:homeRowsLimit') || '12', 10);

        try {
            const batchMap = await api.getBatchLatest(libraryIds, {
                limit: homeRowLimit,
                fields: 'BackdropImageTags,ParentBackdropImageTags,Tags,Status,EndDate,SeriesPrimaryImageTag',
                ...(hidePlayed ? { isPlayed: false } : {})
            });

            if (batchMap) {
                const normalizedMap = {};
                for (const [key, val] of Object.entries(batchMap)) {
                    normalizedMap[key.replace(/-/g, '').toLowerCase()] = val;
                }

                latestDescriptors.forEach((d) => {
                    const libId = d.id.replace('latest-', '').replace(/-/g, '').toLowerCase();
                    if (normalizedMap[libId]) {
                        const items = normalizedMap[libId];
                        items.forEach((item) => {
                            if (item.Id) item.Id = String(item.Id).replace(/-/g, '').toLowerCase();
                            if (item.ServerId) item.ServerId = String(item.ServerId).replace(/-/g, '').toLowerCase();
                        });
                        d._preFetchedItems = items;
                    }
                });
            }
        } catch (err) {
            log.debug('Batch latest pre-fetch skipped or unavailable', err);
        }
    }

    /**
     * Loads remaining priority groups in the background after the splash overlay
     * has been hidden. Rows within each priority group fire in parallel, but groups
     * run sequentially to avoid overwhelming the TV's limited HTTP connection pool.
     *
     * Once all background rows complete, runs post-render cleanup (prewarm scroll
     * cache, markReady, save page cache, library thumb enrichment).
     *
     * @param {number[]} remainingPriorities - Priority values to load
     * @param {Map<number, RowDescriptor[]>} priorityGroups
     */
    async _loadBackgroundRows(remainingPriorities, priorityGroups) {
        for (const p of remainingPriorities) {
            if (!this._isMounted) return;
            const group = priorityGroups.get(p);
            if (group) {
                await Promise.all(group.map((d) => this._loadAndRenderRow(d)));
            }
        }

        // ─── Post-background cleanup ──────────────────────────────────────
        if (!this._isMounted) return;

        this._prewarmScrollCache();
        this.restoreScrollFocusWhenReady();
        this.markReady();

        // Save page cache for instant back-navigation (skip if restoring from cache)
        if (!this._wasPageCached) {
            this._savePageCache();
        }
    }

    // =========================================================================
    // Scroll-Triggered Lazy Row Loading (Priority-2 / Library Rows)
    // =========================================================================

    /**
     * Fetches and renders the next batch of deferred P2 descriptors.
     *
     * Called by:
     *   - The IntersectionObserver sentinel when the user scrolls near the bottom.
     *   - The D-pad leaveDown hook on the last rendered live row.
     *   - The idle prefetch timer (1.2 s after initial rows are painted).
     *
     * @param {boolean} [autoFocus=false] - Whether to move D-pad focus to the
     *   first newly rendered row (true when triggered by D-pad leaveDown).
     */
    async _loadNextDeferredBatch(autoFocus = false) {
        // Guard against concurrent fetches and stale callbacks after navigation
        if (this._isDeferredLoading || !this._isMounted) return;
        if (this._nextDeferredDescIndex >= this._deferredDescriptors.length) return;

        // If viewport is actively running a scroll animation and this isn't an explicit
        // user navigation request (autoFocus), DEFER THE RENDER — but still start the
        // network fetch for the next batch right now so the slow HTTP round-trip
        // overlaps with the scroll animation instead of delaying the boundary
        // keypress that follows it. Rendering stays paused to keep the compositor
        // frame budget clean at 60fps.
        if (!autoFocus && window.__scrollController && window.__scrollController.isAnimating) {
            const peekStart = this._nextDeferredDescIndex;
            const peekEnd = Math.min(peekStart + DEFERRED_BATCH_SIZE_BACKGROUND, this._deferredDescriptors.length);
            const peekBatch = this._deferredDescriptors.slice(peekStart, peekEnd);
            for (const d of peekBatch) {
                this._prefetchRow(d);
            }
            const onScrollFinish = () => {
                eventBus.off('scroll:finished', onScrollFinish);
                if (
                    this._isMounted &&
                    !this._isDeferredLoading &&
                    this._nextDeferredDescIndex < this._deferredDescriptors.length
                ) {
                    this._loadNextDeferredBatch(false);
                }
            };
            eventBus.on('scroll:finished', onScrollFinish);
            return;
        }

        this._isDeferredLoading = true;

        // Slice out the next batch from the deferred descriptor queue.
        // Explicit user triggers (autoFocus) consume a small batch so the cursor
        // lands on the first new row with minimal work; background prefetch
        // consumes a larger lookahead batch to stay ahead of ongoing navigation.
        const batchSize = autoFocus ? DEFERRED_BATCH_SIZE : DEFERRED_BATCH_SIZE_BACKGROUND;
        const startIdx = this._nextDeferredDescIndex;
        const endIdx = Math.min(startIdx + batchSize, this._deferredDescriptors.length);
        const batch = this._deferredDescriptors.slice(startIdx, endIdx);
        this._nextDeferredDescIndex = endIdx;

        log.debug(`Loading deferred batch [${startIdx}–${endIdx - 1}] (${batch.length} rows)`);

        // Insert placeholder sections for all batch rows up-front so
        // layout doesn't jump when each row resolves independently
        this._insertSkeletonRows(batch);

        // Move the sentinel below the newly inserted skeletons so the observer
        // fires at the correct position for the NEXT batch
        const sentinel = this.$('#home-rows-sentinel');
        const container = this.$('#home-rows');
        if (sentinel && container) {
            container.appendChild(sentinel);
        }

        // Track the first descriptor key that successfully renders for autofocus
        let firstRenderedDescId = null;

        // Progressive frame-by-frame rendering:
        // Instead of executing all 3 batch rows synchronously in a single turn of the
        // event loop, we render one row per animation frame. This spreads DOM element
        // creation, virtual window sizing, and initial image loads across frames,
        // eliminating the multi-frame main thread freeze.
        for (const descriptor of batch) {
            if (!this._isMounted) break;
            try {
                await this._loadAndRenderRow(descriptor).then((rendered) => {
                    // Only autofocus to rows that were actually rendered in THIS
                    // batch. Skipped duplicates (already in the registry), empty
                    // rows, and failures must not steal the D-pad focus — that
                    // previously caused pressing Down at the boundary to teleport
                    // focus UP into an already-rendered row.
                    if (rendered && !firstRenderedDescId) firstRenderedDescId = descriptor.id;
                });

                // Yield to the browser between row renders
                await new Promise((resolve) => requestAnimationFrame(resolve));
            } catch (err) {
                log.warn(`Deferred row "${descriptor.id}" failed`, err);
            }
        }

        if (!this._isMounted) {
            this._isDeferredLoading = false;
            return;
        }

        // Optionally move D-pad focus to the first newly rendered row
        // Do NOT autofocus if a modal focus trap (e.g. ExitDialog) is open
        if (autoFocus && firstRenderedDescId && !focusManager.isTrapped()) {
            const entry = this._rowRegistry.get(firstRenderedDescId);
            if (entry && entry.sectionEl) {
                const rowId = firstRenderedDescId;
                this.setActiveSection(`home-row-${rowId}`);
                const firstCard = entry.sectionEl.querySelector('.media-card');
                if (firstCard) {
                    focusManager.focusElement(firstCard);
                }
            }
        }

        // Persist newly rendered rows into the page cache
        if (!this._wasPageCached) {
            this._savePageCache();
        }

        this._isDeferredLoading = false;

        // If there are still rows left, schedule the next idle row prefetch
        // so deferred content loads progressively ahead of time in small 1-row chunks.
        if (this._nextDeferredDescIndex < this._deferredDescriptors.length) {
            this._scheduleHomeIdlePrefetch(300);
        } else {
            // All deferred rows are loaded — run final cleanup
            this._prewarmScrollCache();
            this.restoreScrollFocusWhenReady();
            this.markReady();
        }
    }

    /**
     * Sets up the IntersectionObserver on #home-rows-sentinel.
     * Triggers _loadNextDeferredBatch() as the user scrolls near the bottom
     * of the last rendered P2 batch. Mirrors DiscoverPage._setupScrollObserver().
     * @private
     */
    _setupHomeScrollObserver() {
        const sentinel = this.$('#home-rows-sentinel');
        if (!sentinel || typeof IntersectionObserver === 'undefined') return;

        // Disconnect any previously-attached observer before creating a new one
        if (this._homeSentinelObserver) {
            this._homeSentinelObserver.disconnect();
        }

        // rootMargin '1200px 0px' triggers loading 3 full row heights before the sentinel
        // enters the viewport, giving ample lookahead before the user scrolls near the bottom.
        this._homeSentinelObserver = new IntersectionObserver(
            (entries) => {
                const entry = entries[0];
                if (
                    entry &&
                    entry.isIntersecting &&
                    !this._isDeferredLoading &&
                    this._nextDeferredDescIndex < this._deferredDescriptors.length
                ) {
                    this._loadNextDeferredBatch(false);
                }
            },
            { rootMargin: '1200px 0px', threshold: 0.01 }
        );

        this._homeSentinelObserver.observe(sentinel);
        log.debug('Home scroll sentinel observer attached');
    }

    /**
     * Schedules a low-priority idle background prefetch.
     * Silently loads deferred rows in small 1-row batches so content is ready
     * before the user scrolls or navigates down to it.
     *
     * @param {number} [delay=400] - Delay in ms before triggering prefetch
     * @private
     */
    _scheduleHomeIdlePrefetch(delay = 400) {
        if (this._homeIdlePrefetchTimer) clearTimeout(this._homeIdlePrefetchTimer);
        this._homeIdlePrefetchTimer = setTimeout(() => {
            if (this._isMounted && this._nextDeferredDescIndex < this._deferredDescriptors.length) {
                log.debug('Home idle prefetch triggered');
                this._loadNextDeferredBatch(false);
            }
        }, delay);
    }

    /**
     * Replaces a skeleton placeholder with a fully functional VirtualCardRow section.
     *
     * Mutates the DOM in the most minimal way possible:
     * - Finds the existing skeleton `<section>` by `data-row-id`
     * - Rebuilds its interior (title + VirtualCardRow track)
     * - Registers a FocusManager section for the new row
     * - Tracks the VirtualCardRow in `_virtualRows` and `_rowRegistry`
     *
     * @param {RowDescriptor} descriptor
     * @param {Array} items - Fetched media items
     */
    _renderRow(descriptor, items) {
        const container = this.$('#home-rows');
        if (!container) return;

        // Find the placeholder element for this descriptor, preferring unrendered skeleton
        let sectionEl = container.querySelector(`.media-row--skeleton[data-row-id="${descriptor.id}"]`);
        if (!sectionEl) {
            sectionEl = container.querySelector(`[data-row-id="${descriptor.id}"]`);
        }
        if (!sectionEl) {
            log.warn(`No placeholder found for row "${descriptor.id}" — skipping render`);
            return;
        }

        // Clean up any extraneous duplicate skeleton elements with this row ID
        const allMatching = Array.from(container.querySelectorAll(`[data-row-id="${descriptor.id}"]`));
        if (allMatching.length > 1) {
            allMatching.forEach((el) => {
                if (el !== sectionEl && el.classList.contains('media-row--skeleton')) {
                    el.remove();
                }
            });
        }

        const isLandscape = descriptor.layout === 'landscape';
        const isLibrary = descriptor.id === 'my-media';
        const hideLibraryLabels = storage.getItem('pref:hideLibraryLabels') === 'true';
        const thumbMode = storage.getItem('pref:libraryThumbMode') || 'off';
        const isDynamicThumbMode = thumbMode !== 'off';
        const shouldHideLabels = isLibrary && (hideLibraryLabels || isDynamicThumbMode);

        // Assign the final row index based on DOM order (used for focus linking)
        // We read the position NOW because the skeleton is already in the DOM in
        // the correct final order, so the index is stable.
        const allSections = Array.from(container.querySelectorAll('section[data-row-id]'));
        const rowIndex = allSections.indexOf(sectionEl);

        // ── Update the section element in-place ───────────────────────────────
        // Update class list: remove skeleton state, keep label-hiding modifier
        sectionEl.className = `media-row${shouldHideLabels ? ' library-no-labels' : ''}`;
        sectionEl.setAttribute('data-row-index', rowIndex);

        // Replace interior with real structure (title + VirtualCardRow scaffold)
        sectionEl.innerHTML = `
            <h2 class="row-title">${descriptor.title}</h2>
            <div class="row-items" id="row-items-${descriptor.id}">
                <div class="row-items-track"></div>
            </div>
        `;

        // ── Instantiate VirtualCardRow ────────────────────────────────────────
        const trackEl = sectionEl.querySelector('.row-items-track');

        const cardType = descriptor.cardType || 'poster';
        const { visibleCount, initialWindow } = this._computeRowSizing(isLandscape, cardType);

        const virtualRow = new VirtualCardRow(trackEl, items, {
            isLandscape,
            cardType,
            hideLabels: shouldHideLabels,
            visibleCount,
            initialWindow,
            focusSectionId: `home-row-${descriptor.id}`,
            // Card render function — delegates to CardRenderer via Page._renderMediaCard
            renderCard: (item) =>
                this._renderMediaCard(
                    item,
                    isLandscape,
                    descriptor.cardType || descriptor.contextType || 'poster',
                    descriptor.contextType
                )
        });

        // ── Register FocusManager section for this row ────────────────────────
        // We register on .row-items (not .media-row) to get CSS containment benefits.
        // Note: leaveUp and leaveDown start as null and are patched by
        // _relinkAdjacentSections() after each row renders, so that progressively
        // appearing rows always have correct D-pad navigation links.
        const itemsContainer = sectionEl.querySelector('.row-items');

        this.registerFocusSection(`home-row-${descriptor.id}`, itemsContainer, {
            orientation: 'horizontal',
            leaveUp: null, // Patched post-render by _relinkAdjacentSections()
            leaveDown: null, // Patched post-render by _relinkAdjacentSections()
            leaveLeft: 'sidebar',

            // Handle horizontal navigation within the virtual row
            onMove: (direction, currentElement) => {
                if (!currentElement || currentElement.dataset.virtualIndex === undefined) {
                    return false; // Let spatial nav take over
                }
                const idx = parseInt(currentElement.dataset.virtualIndex, 10);
                const nextNode = virtualRow.handleMove(direction, idx);
                if (nextNode) {
                    focusManager.focusElement(nextNode);
                    return true;
                }
                return false;
            },

            // Restore last-focused position in this row when entering from another row
            onEnter: (fromElement, options) => {
                if (fromElement && options && (options.direction === 'up' || options.direction === 'down')) {
                    // Return the remembered card index, mounting it if needed
                    const existingNode = virtualRow.domNodes.get(virtualRow.currentIndex);
                    if (existingNode && existingNode.isConnected) {
                        return existingNode;
                    }
                    // Node was evicted (user had scrolled far); remount and return it
                    virtualRow._updateWindow(virtualRow.currentIndex);
                    return virtualRow.domNodes.get(virtualRow.currentIndex);
                }
                return null;
            },

            // Restore specific virtual index (used by back-navigation state)
            onRestoreIndex: (index) => virtualRow.focusByIndex(index)
        });

        // ── Transfer focus that landed on this row's skeleton ─────────────────
        // If the D-pad hopped into the skeleton placeholder while data was still
        // loading, its focus element was just destroyed by the innerHTML swap
        // above. Restore focus onto the real card at the remembered skeleton
        // position so the cursor neither freezes nor jumps to the row start.
        const prevFocused = focusManager.getFocused();
        const activeSection = focusManager.getActiveSection();
        if (activeSection === `home-row-${descriptor.id}` && (!prevFocused || !document.contains(prevFocused))) {
            const skeletonIndex = parseInt(
                (prevFocused && prevFocused.dataset && prevFocused.dataset.skeletonIndex) || '0',
                10
            );
            const focusNode = virtualRow.focusByIndex(isNaN(skeletonIndex) ? 0 : skeletonIndex);
            if (focusNode) {
                focusManager.focusElement(focusNode, { instantScroll: true });
            }
        }

        // ── Track row state ───────────────────────────────────────────────────
        this._rowRegistry.set(descriptor.id, { descriptor, sectionEl, virtualRow });
        this._virtualRows.push(virtualRow); // Ordered list for offset cache pre-warming

        // Start lazy loader for any images in this newly added row
        lazyLoader.observe(sectionEl);

        // ── Patch D-pad Up/Down links for this row and its neighbours ─────────
        // Since rows render progressively, we re-link surrounding sections after
        // each row appears so navigation is always correct and up-to-date.
        this._relinkAdjacentSections(container, sectionEl, descriptor.id);

        // ── First row focus initialization ────────────────────────────────────
        // The very first row to finish rendering should receive focus
        // (unless we're restoring a back-navigation state).
        this._renderedRowCount++;
        this._checkFocusRestoration(descriptor.id, true);

        log.debug(`Row "${descriptor.id}" rendered at index ${rowIndex} (${items.length} items)`);
    }

    // =========================================================================
    // Focus Initialization (called after first row renders)
    // =========================================================================

    /**
     * Checks if it's safe to initialize focus based on whether the target row
     * has finished loading. This solves the race condition where the first rendered
     * row consumes the back-navigation state before the actual target row has loaded.
     */
    _checkFocusRestoration(rowId, success) {
        if (this._focusInitialized) return;

        const container = this.$('#home-rows');
        if (!container) return;

        const lastFocusedObj = state.get('home:lastFocusedItem');
        const legacyLastFocusedId = state.get('home:lastFocusedItemId');
        const targetRowId = lastFocusedObj ? lastFocusedObj.rowId : null;

        if (targetRowId || legacyLastFocusedId) {
            // If legacy ID is used without rowId, fallback to any success
            if (!targetRowId && success) {
                this._tryInitializeFocus(container);
                return;
            }

            if (rowId === targetRowId) {
                if (success) {
                    // Our target row just finished rendering!
                    this._tryInitializeFocus(container);
                } else {
                    // Target row failed or was empty. We can't restore to it.
                    // Clear the state so we fallback to the "first successful row" logic.
                    state.delete('home:lastFocusedItem');

                    // If any OTHER rows have already rendered successfully, focus one of them now.
                    const firstSection = container.querySelector('section[data-row-id]:not(.media-row--skeleton)');
                    if (firstSection) {
                        this._tryInitializeFocus(container);
                    }
                }
            }
        } else {
            // No target row, we just want to focus the top of the page.
            // Check if the physical top row in the DOM has finished loading.
            // (Empty/failed rows are removed, so firstElementChild is always the true top row).
            const firstRowNode = container.firstElementChild;
            if (firstRowNode && !firstRowNode.classList.contains('media-row--skeleton')) {
                this._tryInitializeFocus(container);
            }
        }
    }

    /**
     * Called after each row renders. On the FIRST successful render, this sets
     * up the initial focus state and handles back-navigation restoration.
     *
     * Using requestAnimationFrame ensures the DOM has been painted and
     * offsetParent is valid before we try to focus anything.
     *
     * @param {HTMLElement} container - The #home-rows container
     */
    _tryInitializeFocus(container) {
        this._focusInitialized = true; // Prevent double-initialization

        // [RACE CONDITION FIX] Capture and clear _pendingNavState synchronously!
        // The render pipeline yields via Promise (microtasks), so if data is cached,
        // the pipeline reaches Step 7 and calls NavigationState BEFORE this requestAnimationFrame
        // can clear the state. That leads to NavigationState firing a 50ms fallback timeout
        // which clobbers our correct focus back to "sidebar" or whatever just as the user
        // starts navigating.
        const pendingNav = this._pendingNavState;
        this._pendingNavState = null;

        // ── Store focus-restoration logic as a callback ────────────────────────
        // We do NOT set focus or hide the splash here. Instead we store a callback
        // that Step 7 will call from inside a rAF, AFTER all rows have finished
        // rendering. This guarantees the full page layout is stable before scroll
        // calculations are made and before the loading overlay is removed.
        this._pendingFocusRestore = () => {
            if (!this._isMounted) return;

            // ─── Try restoring focus from back-navigation ─────────────────────
            let lastFocusedObj = null;
            let legacyLastFocusedId = null;

            if (storage.getItem('pref:disableFocusRestore') !== 'true') {
                lastFocusedObj = state.get('home:lastFocusedItem');
                legacyLastFocusedId = state.get('home:lastFocusedItemId');
            }

            let restoredFocus = false;

            if (lastFocusedObj || legacyLastFocusedId) {
                const rawTargetId = lastFocusedObj ? lastFocusedObj.itemId : legacyLastFocusedId;
                const targetId = rawTargetId ? String(rawTargetId).replace(/-/g, '').toLowerCase() : null;
                // Mutable row identifier: reassigned if card is located in a different virtual row
                let targetRowId = lastFocusedObj ? lastFocusedObj.rowId : null;

                let savedCard = null;

                // Try the specific row first (faster lookup)
                if (targetRowId) {
                    const rowEntry = this._rowRegistry.get(targetRowId);
                    if (rowEntry && rowEntry.virtualRow) {
                        savedCard = rowEntry.virtualRow.ensureItemRendered(targetId);
                    }
                }

                // Fall back to a search across all registered virtual rows
                if (!savedCard) {
                    for (const [rowId, rowEntry] of this._rowRegistry.entries()) {
                        if (rowEntry.virtualRow) {
                            const node = rowEntry.virtualRow.ensureItemRendered(targetId);
                            if (node) {
                                savedCard = node;
                                targetRowId = rowId;
                                break;
                            }
                        }
                    }
                }

                // Fall back to a global DOM query for non-virtual cards
                if (!savedCard) {
                    savedCard = Array.from(container.querySelectorAll('.media-card')).find(
                        (card) =>
                            String(card.dataset.itemId || '')
                                .replace(/-/g, '')
                                .toLowerCase() === targetId
                    );
                }

                if (savedCard) {
                    // Card is in the DOM — focus it directly
                    const rowEntry = this._getRowEntryForCard(savedCard);
                    if (rowEntry) {
                        this.setActiveSection(`home-row-${rowEntry.descriptor.id}`, false);
                        focusManager.focusElement(savedCard, { instantScroll: true });
                        restoredFocus = true;
                    }
                } else if (targetRowId) {
                    // Card was virtualized out — restore via index lookup
                    const rowEntry = this._rowRegistry.get(targetRowId);
                    if (rowEntry && rowEntry.virtualRow) {
                        const node = rowEntry.virtualRow.ensureItemRendered(targetId);
                        if (node) {
                            this.setActiveSection(`home-row-${targetRowId}`, false);
                            focusManager.focusElement(node, { instantScroll: true });
                            restoredFocus = true;
                        }
                    }
                }

                // Always clear the saved state after consuming it
                state.delete('home:lastFocusedItem');
                state.delete('home:lastFocusedItemId');

                // ====================================================================
                // Restore any captured scroll offset from NavigationState.
                // ====================================================================
                // Since we nullified this._pendingNavState synchronously above,
                // restoreScrollFocusWhenReady() at the end of the pipeline is safely a no-op.
                //
                // We delegate this scroll positioning to ScrollController.smoothScrollTo
                // with duration 0. This guarantees that if the user has GPU scroll mode
                // enabled, we snap the translate3d transform of .vertical-scroll-track
                // instead of corrupting the layout by writing to scrollTop directly.
                // ====================================================================
                if (restoredFocus && pendingNav) {
                    const scrollContainer = this.$('.page-content');
                    if (scrollContainer && pendingNav.scrollTop > 0) {
                        scrollController.smoothScrollTo(scrollContainer, pendingNav.scrollTop, 0, 'vertical');
                    }
                }
            } else if (storage.getItem('pref:disableFocusRestore') === 'true') {
                // Clean up any stale saved state from before the toggle was turned on
                state.delete('home:lastFocusedItem');
                state.delete('home:lastFocusedItemId');
            }

            // ─── Default: focus the first card in the first rendered row ──────
            if (!restoredFocus) {
                // Prioritize the hero carousel if a home-hero section exists
                // (registered during skeleton insertion or by the real carousel).
                if (focusManager.getSectionConfig('home-hero') && this.$('#hero-carousel-container')) {
                    this.setActiveSection('home-hero', false);
                    focusManager.focusElement(this.$('#hero-carousel-container'), { instantScroll: true });
                } else {
                    // Find the first non-skeleton section that has a card
                    const firstSection = container.querySelector('section[data-row-id]:not(.media-row--skeleton)');
                    if (firstSection) {
                        const rowId = firstSection.getAttribute('data-row-id');
                        const firstCard = firstSection.querySelector('.media-card');

                        // Always ensure activeSection and focusedElement point to the same row item.
                        // Previously, if focus was set to the sidebar as a trap fallback, this check
                        // was bypassed, leaving activeSection and focusedElement out of sync.
                        if (firstCard) {
                            this.setActiveSection(`home-row-${rowId}`, false);
                            focusManager.focusElement(firstCard, { instantScroll: true });
                        } else {
                            this.setActiveSection('sidebar');
                        }
                    } else {
                        this.setActiveSection('sidebar');
                    }
                }
            }
        };
    }

    // =========================================================================
    // Delegated Event Listeners
    // =========================================================================

    /**
     * Attaches delegated event listeners to the stable #home-rows container.
     *
     * Using event delegation means we only have TWO listeners total for the
     * entire page, regardless of how many rows or cards exist. This avoids
     * the memory/performance overhead of per-card listeners.
     */
    _attachDelegatedListeners() {
        const container = this.$('#home-rows');
        if (!container) return;

        // ── Click / Mousedown → Navigate ──────────────────────────────────────
        // We handle both mousedown (fast/snappy) and click (standard/fallback).
        // This parity with Sidebar.js ensures a responsive "snap" when selecting cards.
        let lastActivateTime = 0;

        const handleActivate = (e) => {
            const card = e.target.closest('.media-card');
            if (!card?.dataset?.itemId) return;

            const now = Date.now();
            // Debounce to prevent double-navigation on hardware that fires both events
            if (now - lastActivateTime < 400) return;
            lastActivateTime = now;

            // Stop propagation to avoid bubbling to unwanted handlers
            e.stopPropagation();

            // Save focused item + its row ID for exact focus restoration on back-nav
            if (storage.getItem('pref:disableFocusRestore') !== 'true') {
                const sectionEl = card.closest('section[data-row-id]');
                const rowId = sectionEl ? sectionEl.getAttribute('data-row-id') : null;

                state.set('home:lastFocusedItem', {
                    itemId: card.dataset.itemId,
                    rowId
                });
            }

            // Navigate based on context type
            const ctxType = card.dataset.contextType;
            if (ctxType === 'library') {
                if (card.dataset.collectionType === 'livetv') {
                    router.navigate('/livetv');
                } else {
                    router.navigate(`/library/${card.dataset.itemId}`);
                }
            } else {
                const itemType = card.dataset.type;
                if (
                    itemType === 'Person' ||
                    itemType === 'MusicArtist' ||
                    itemType === 'Artist' ||
                    itemType === 'AlbumArtist'
                ) {
                    router.navigate(`/person/${card.dataset.itemId}`);
                } else if (itemType === 'Season' && card.dataset.seriesId) {
                    router.navigate(`/details/${card.dataset.seriesId}`);
                } else {
                    router.navigate(`/details/${card.dataset.itemId}`);
                }
            }
        };

        // Bind both events for parity with Sidebar.js snappy behavior
        container.addEventListener('mousedown', handleActivate);
        container.addEventListener('click', handleActivate);

        // ── FocusIn → Sync VirtualCardRow index & lookahead prefetch ──────────
        // When focus jumps to a card via SpatialNavigator (bypassing onMove),
        // we must sync the VirtualCardRow's internal currentIndex to match.
        // We also check if the user is nearing the bottom of loaded rows so we
        // can mount the next deferred row in advance before they reach it.
        container.addEventListener('focusin', (e) => {
            if (!e.target.classList.contains('media-card')) return;

            const sectionEl = e.target.closest('section[data-row-id]');
            if (!sectionEl) return;

            const rowId = sectionEl.getAttribute('data-row-id');
            const rowEntry = this._rowRegistry.get(rowId);
            if (rowEntry) {
                rowEntry.virtualRow.syncIndexFromNode(e.target);
            }

            // Proactive lookahead: mount the next row early before user presses Down
            this._checkNearbyRowPrefetch(sectionEl);
        });

        // ── Remote Play key → play the focused card directly ─────────────────
        // Mirrors the official Jellyfin app: pressing the dedicated Play (or
        // Play/Pause) key on a focused show/episode card starts playback without
        // first opening its details page. Both events are bound because remotes
        // expose either a discrete Play key (key:play) or a combined toggle
        // (key:playPause). Page._subscriptions auto-unbinds these on destroy.
        this.on('key:play', () => this._playFocusedCard());
        this.on('key:playPause', () => this._playFocusedCard());
    }

    /**
     * Proactive lookahead prefetch: triggers loading of the next deferred row
     * whenever the user focuses a row within 2 rows of the last rendered section.
     * This ensures the row below is always mounted and ready before navigation occurs.
     *
     * @param {HTMLElement} sectionEl
     * @private
     */
    _checkNearbyRowPrefetch(sectionEl) {
        if (this._isDeferredLoading || this._nextDeferredDescIndex >= this._deferredDescriptors.length) {
            return;
        }

        const container = this.$('#home-rows');
        if (!container) return;

        const liveSections = Array.from(container.querySelectorAll('section[data-row-id]:not(.media-row--skeleton)'));
        const currentIndex = liveSections.indexOf(sectionEl);
        if (currentIndex === -1) return;

        // If the focused section is near the bottom (within 2 rows of the end),
        // proactively mount the next deferred row in the background ahead of time.
        if (currentIndex >= liveSections.length - 2) {
            this._loadNextDeferredBatch(false);
        }
    }

    /**
     * Launch playback of the currently focused media card (remote Play key).
     * Skips cards that aren't directly playable (library folders, people).
     */
    _playFocusedCard() {
        const card = this.$('.media-card.focused');
        if (!card?.dataset?.itemId) {
            log.debug('Play key pressed but no focused media card');
            return;
        }

        const { itemId, type, contextType } = card.dataset;

        // Library/collection cards open a library view; people open a person
        // page — neither is directly playable, so let the Play key fall through.
        if (contextType === 'library') return;
        if (['Person', 'MusicArtist', 'Artist', 'AlbumArtist'].includes(type)) return;

        // Persist focus for back-nav restoration, mirroring handleActivate().
        if (storage.getItem('pref:disableFocusRestore') !== 'true') {
            const sectionEl = card.closest('section[data-row-id]');
            state.set('home:lastFocusedItem', {
                itemId,
                rowId: sectionEl ? sectionEl.getAttribute('data-row-id') : null
            });
        }

        log.info(`Play key: quick-playing focused card ${itemId} (${type || 'unknown'})`);
        quickPlayItem(itemId);
    }

    // =========================================================================
    // Focus Section Linking Helpers
    // =========================================================================

    /**
     * Patches the leaveUp/leaveDown FocusManager links for a newly rendered row
     * and its immediate neighbours.
     *
     * Because rows appear progressively, a previously-rendered row may not yet
     * know about its new neighbour below it. This method fixes that by:
     *   1. Setting leaveUp/leaveDown for the new row itself.
     *   2. Updating the leaveDown of the row ABOVE the new row to point at it.
     *   3. Updating the leaveUp of the row BELOW the new row to point at it.
     *
     * Only operates on sections that exist in the FocusManager registry
     * (i.e. live rows, not skeleton placeholders).
     *
     * @param {HTMLElement} container - The #home-rows container
     * @param {HTMLElement} sectionEl - The section element of the new row
     * @param {string} rowId - The descriptor.id of the new row
     */
    _relinkAdjacentSections(container, sectionEl, rowId) {
        // Collect only fully-rendered sections (not skeletons) in DOM order
        const liveSections = Array.from(container.querySelectorAll('section[data-row-id]:not(.media-row--skeleton)'));

        // Chain of ALL visible rows INCLUDING loading skeleton placeholders.
        // Skeletons are real navigation targets now: the D-pad hops into them
        // instantly while their data loads, so the Up/Down chain must link
        // through them too.
        const chainSections = Array.from(container.querySelectorAll('section[data-row-id]'));

        // Helper to get the section ID string for FocusManager
        const sId = (el) => (el ? `home-row-${el.getAttribute('data-row-id')}` : null);

        const idx = chainSections.indexOf(sectionEl);
        if (idx === -1) return;

        // ── Sweep the whole visible chain ─────────────────────────────────────
        // Rows appear progressively and in batches, so relinking only the
        // immediate neighbours of one row leaves silent gaps further down
        // (batch skeletons). A sweep keeps every registered section connected.
        const hasDeferredRows = this._nextDeferredDescIndex < this._deferredDescriptors.length;
        for (let i = 0; i < chainSections.length; i++) {
            const chainId = chainSections[i].getAttribute('data-row-id');
            const config = focusManager.getSectionConfig(`home-row-${chainId}`);
            if (!config) continue;

            const prevEl = i > 0 ? chainSections[i - 1] : null;
            const nextEl = i < chainSections.length - 1 ? chainSections[i + 1] : null;

            config.leaveUp = prevEl ? sId(prevEl) : null;

            if (nextEl) {
                config.leaveDown = sId(nextEl);
            } else if (hasDeferredRows) {
                // Last visible row but the deferred queue still has content —
                // hook Down to pull (and auto-focus) the next lazy batch.
                config.leaveDown = () => {
                    // Load the next batch and auto-focus its first row so the cursor
                    // lands naturally on new content instead of staying frozen.
                    this._loadNextDeferredBatch(true);
                    return false; // Tell FocusManager we handled navigation ourselves
                };
            } else {
                // All deferred rows exhausted — no more to load
                config.leaveDown = null;
            }
        }

        // =====================================================================
        // Bidirectional Section Linking: Top Content Row ↔ Hero Carousel
        // =====================================================================
        // vertical transitions between the hero carousel and content rows must never be severed.
        // Even if the row just rendered is not at idx 0 (e.g. out-of-order network
        // completion or prior row removal), we inspect liveSections[0] to guarantee
        // that the true topmost content row's leaveUp and the hero's leaveDown
        // always reference each other correctly.
        // =====================================================================
        const topRow = liveSections[0];
        if (topRow) {
            const topRowId = topRow.getAttribute('data-row-id');
            const topRowConfig = focusManager.getSectionConfig(`home-row-${topRowId}`);
            const hasHero =
                storage.getItem('pref:heroCarousel') !== 'false' && focusManager.getSectionConfig('home-hero');

            // Wire the topmost row to navigate Up into the hero section
            if (topRowConfig) {
                topRowConfig.leaveUp = hasHero ? 'home-hero' : null;
            }

            // Wire the hero carousel to navigate Down into this topmost row
            if (hasHero) {
                const heroConfig = focusManager.getSectionConfig('home-hero');
                if (heroConfig) {
                    heroConfig.leaveDown = `home-row-${topRowId}`;
                }
            }
        }
    }

    /**
     * Resolves the FocusManager section name for the topmost live content row.
     * Dynamic fallback used for home-hero leaveDown and bidirectional navigation.
     * @private
     * @returns {string|null}
     */
    _getFirstLiveRowSectionName() {
        // Container element holding all progressive homepage rows
        const container = this.$('#home-rows') || document.getElementById('home-rows');
        if (!container) return null;

        // Prioritize the first live, non-skeleton content row
        const firstLive = container.querySelector('section[data-row-id]:not(.media-row--skeleton)');
        if (firstLive) {
            const rowId = firstLive.getAttribute('data-row-id');
            const sName = `home-row-${rowId}`;
            if (focusManager.getSectionConfig(sName)) return sName;
        }

        // Fallback: search all section elements with data-row-id in DOM order
        const allSections = container.querySelectorAll('section[data-row-id]');
        for (let i = 0; i < allSections.length; i++) {
            const rowId = allSections[i].getAttribute('data-row-id');
            const sName = `home-row-${rowId}`;
            if (focusManager.getSectionConfig(sName)) return sName;
        }

        return null;
    }

    /**
     * Inserts a static placeholder inside the hero carousel container while
     * carousel data loads. Keeps the hero area sized correctly — no animated
     * shimmer, just dark rectangles that prevent layout shift.
     * @private
     */
    _insertHeroSkeleton() {
        const placeholder = this.$('#home-hero-placeholder');
        if (!placeholder) return;

        // Fallback to high-performance immersive style by default for fluid TV navigation
        const carouselStyle = storage.getItem('pref:heroCarouselStyle') || 'immersive-performance';
        const isCompact = storage.getItem('pref:heroCarouselCompact') !== 'false';

        placeholder.className = '';
        placeholder.classList.add(`style-${carouselStyle}`);
        if (isCompact) {
            placeholder.classList.add('style-compact');
        }

        // -------------------------------------------------------------------------
        // Safe Theme Color Retrieval for Legacy Environments
        // -------------------------------------------------------------------------
        // On ultra-legacy webviews (such as Tizen 3.0 or legacy WebOS WebKit engines),
        // CSSStyleDeclaration.getPropertyValue() returns null when custom CSS properties
        // are not natively resolved or prior to polyfill injection. Calling .trim()
        // directly on null triggers a fatal startup exception:
        // "ERR: Cannot read property 'trim' of null".
        // -------------------------------------------------------------------------
        const rawPrimaryRgb = getComputedStyle(document.documentElement).getPropertyValue('--jf-primary-btn-color-rgb');
        const primaryRgb = (rawPrimaryRgb ? rawPrimaryRgb.trim() : '') || '255, 255, 255';

        placeholder.innerHTML = `
            <div id="hero-carousel-container" 
                 class="hero-carousel-container ${carouselStyle} ${isCompact ? 'compact' : ''} skeleton focusable" 
                 tabindex="0">
                <div class="hero-carousel">
                    <div class="hero-carousel-track">
                        <div class="hero-item active">
                            <div class="hero-backdrop" style="background: rgba(${primaryRgb}, 0.6);"></div>
                            <div class="hero-content">
                                <div class="hero-logo-skeleton" style="background: rgba(${primaryRgb}, 0.6); border-radius: 8px;"></div>
                                <div class="hero-meta-row-skeleton" style="background: rgba(${primaryRgb}, 0.6); border-radius: 8px;"></div>
                                <div class="hero-description-skeleton" style="background: rgba(${primaryRgb}, 0.6); border-radius: 8px;"></div>
                                <div class="hero-description-skeleton-2" style="background: rgba(${primaryRgb}, 0.6); border-radius: 8px;"></div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;

        focusManager.register('home-hero', placeholder, {
            orientation: 'horizontal',
            selector: '#hero-carousel-container',
            defaultFocusSelector: '#hero-carousel-container',
            leaveDown: () => this._getFirstLiveRowSectionName(),
            leaveLeft: 'sidebar'
        });
    }

    /**
     * Loads items for the hero carousel and initializes the component.
     * Picks 5 random items from the user's libraries.
     */
    async _loadHeroCarousel() {
        try {
            log.info('Loading Hero Carousel items...');
            const heroCount = storage.getItem('pref:heroCarouselCount');
            const limit = heroCount ? parseInt(heroCount, 10) : 5;

            // =================================================================
            // HERO CAROUSEL DATA FILTERS RESOLUTION
            // =================================================================
            // Check if the user has enabled the "Ignore Watched Content" preference.
            // The Jellyfin 'IsUnplayed' server-side filter works for Movies but not
            // for Series (where play state is tracked per-episode). When the filter
            // is active we make separate requests: Movies with the server-side
            // 'IsUnplayed' filter, and Series fetched normally then filtered
            // client-side by checking UserData.Played.
            const ignoreWatched = storage.getItem('pref:heroCarouselIgnoreWatched') === 'true';
            const fields =
                'Overview,ImageTags,ProductionYear,RunTimeTicks,OfficialRating,CommunityRating,ParentLogoImageTag,ParentLogoItemId,SeriesId,ProviderIds,MediaSourceCount';
            const imageTypes = 'Primary,Backdrop,Logo';

            let items = [];

            // Try single-pass fetch via Litefin Plugin endpoint
            const pluginHero = await api.getHomeHero({ limit, ignoreWatched });

            // Validate that the plugin response is non-empty and does not contain invalid zero IDs
            // If the server-side plugin returns Id: "0", fall back immediately to native item queries.
            const hasInvalidIds = pluginHero?.Items?.some((item) => !item.Id || item.Id === '0');
            if (pluginHero && Array.isArray(pluginHero.Items) && pluginHero.Items.length > 0 && !hasInvalidIds) {
                items = pluginHero.Items;
            } else if (ignoreWatched) {
                // Fallback: Fetch unplayed movies (IsUnplayed works correctly for Movies)
                const moviesResponse = await api.getItems({
                    SortBy: 'Random',
                    Recursive: true,
                    Limit: limit,
                    Fields: fields,
                    EnableImageTypes: imageTypes,
                    IncludeItemTypes: 'Movie',
                    Filters: 'HasBackdrop,IsUnplayed'
                });

                if (!this._isMounted) return;

                const movies = moviesResponse.Items || [];

                // Fetch series and filter client-side (IsUnplayed doesn't work for Series)
                const seriesResponse = await api.getItems({
                    SortBy: 'Random',
                    Recursive: true,
                    Limit: limit,
                    Fields: `${fields},UserData`,
                    EnableImageTypes: imageTypes,
                    IncludeItemTypes: 'Series',
                    Filters: 'HasBackdrop'
                });

                if (!this._isMounted) return;

                const series = (seriesResponse.Items || []).filter(
                    (item) => !item.UserData || item.UserData.Played !== true
                );

                // Combine and randomly pick 'limit' items
                const combined = [...movies, ...series];
                items = combined.sort(() => Math.random() - 0.5).slice(0, limit);
            } else {
                // Fallback: No filter — single fetch for both types
                const response = await api.getItems({
                    SortBy: 'Random',
                    Recursive: true,
                    Limit: limit,
                    Fields: fields,
                    EnableImageTypes: imageTypes,
                    IncludeItemTypes: 'Movie,Series',
                    Filters: 'HasBackdrop'
                });

                if (!this._isMounted) return;

                items = response.Items || [];
            }
            if (items.length === 0) {
                log.info('No hero items found, skipping carousel.');
                return;
            }

            // 1. Enrich with MDBList Metadata if enabled
            if (storage.getItem('pref:heroCarouselMdbList') !== 'false' && pluginManager.isEnabled('mdblist-ratings')) {
                const mdblist = pluginManager.getPlugin('mdblist-ratings');
                if (mdblist && mdblist.plugin) {
                    log.info('Enriching hero items with MDBList data...');
                    try {
                        await Promise.all(
                            items.map(async (item) => {
                                // Fetch and attach to the item object
                                // Note: We prioritize item.ProviderIds.Imdb if present to avoid extra API calls.
                                // We pass false for includeAwards to optimize for carousel performance.
                                const imdbId = item.ProviderIds?.Imdb || item.ProviderIds?.imdb;
                                item._mdbMetadata = await mdblist.plugin.getItemMetadata(item.Id, imdbId, false);
                            })
                        );
                    } catch (err) {
                        log.warn('Enriching hero items failed, continuing with partial data', err);
                    }
                }
            }

            // 2. Initialize the carousel component
            this._hero = new HeroCarousel({ items });

            const placeholder = this.$('#home-hero-placeholder');
            if (placeholder) {
                // Determine current carousel style and compact settings
                // Fallback to high-performance immersive style by default for fluid TV navigation.
                const carouselStyle = storage.getItem('pref:heroCarouselStyle') || 'immersive-performance';
                const isCompact = storage.getItem('pref:heroCarouselCompact') !== 'false';

                // Reset existing classes to prevent state leaking when settings change
                placeholder.className = '';

                // Apply style-specific and layout-specific classes to the wrapper
                placeholder.classList.add(`style-${carouselStyle}`);
                if (isCompact) {
                    placeholder.classList.add('style-compact');
                }

                // Render the hero carousel and initialize its event listeners
                placeholder.innerHTML = this._hero.render();
                this._hero.init(placeholder.firstElementChild);

                // Seamless focus re-establishment: if the hero was the active focus target,
                // re-establish focus on the newly rendered live carousel container.
                const activeSec = focusManager.getActiveSection();
                const curFocused = focusManager.getFocused();
                if (
                    activeSec === 'home-hero' ||
                    !curFocused ||
                    !document.contains(curFocused) ||
                    placeholder.contains(curFocused)
                ) {
                    if (!focusManager.isTrapped()) {
                        this.setActiveSection('home-hero', false);
                        focusManager.focusElement(placeholder.firstElementChild, {
                            instantScroll: true,
                            skipScroll: true
                        });
                    }
                }

                // Relink the first rendered row and the hero carousel now that the hero has initialized
                const container = this.$('#home-rows');
                if (container) {
                    const firstRow =
                        container.querySelector('section[data-row-id]:not(.media-row--skeleton)') ||
                        container.querySelector('section[data-row-id]');
                    if (firstRow) {
                        const firstRowId = firstRow.getAttribute('data-row-id');
                        this._relinkAdjacentSections(container, firstRow, firstRowId);
                    }
                }
            }
        } catch (e) {
            log.error('Failed to load Hero Carousel', e);
        }
    }

    /**
     * Finds the registry entry for the row that contains a given card element.
     *
     * @param {HTMLElement} cardEl
     * @returns {{ descriptor: RowDescriptor, sectionEl: HTMLElement, virtualRow: VirtualCardRow }|null}
     */
    _getRowEntryForCard(cardEl) {
        const sectionEl = cardEl.closest('section[data-row-id]');
        if (!sectionEl) return null;
        const rowId = sectionEl.getAttribute('data-row-id');
        return this._rowRegistry.get(rowId) || null;
    }

    // =========================================================================
    // Performance Helpers
    // =========================================================================

    /**
     * Groups an array of RowDescriptors by their `priority` value.
     * Returns a Map<number, RowDescriptor[]> in insertion order (already sorted).
     *
     * @param {RowDescriptor[]} descriptors - Pre-sorted by priority
     * @returns {Map<number, RowDescriptor[]>}
     */
    _groupByPriority(descriptors) {
        const groups = new Map();
        for (const descriptor of descriptors) {
            if (!groups.has(descriptor.priority)) {
                groups.set(descriptor.priority, []);
            }
            groups.get(descriptor.priority).push(descriptor);
        }
        return groups;
    }

    /**
     * Pre-warms the ScrollController offset cache for all rendered rows.
     * Called once after all rows are done rendering.
     *
     * This batches ALL offsetTop reads into a single layout flush, making
     * every subsequent D-pad Down press a pure O(1) WeakMap lookup.
     */
    _prewarmScrollCache() {
        const pageContent = this.$('.page-content');
        if (!pageContent) return;

        const mediaRows = this.$('#home-rows').querySelectorAll('.media-row');
        scrollController.prewarmOffsetCache(mediaRows, pageContent);
        log.debug(`Pre-warmed scroll cache for ${mediaRows.length} rows`);
    }

    /**
     * Compute optimal VirtualCardRow sizing (visibleCount / initialWindow)
     * based on actual card dimensions and viewport width.
     *
     * Card widths mirror the constants in VirtualCardRow constructor:
     *   Classic: landscape=400, portrait=240, margin=24
     *   Modern:  landscape=600, portrait=225, square=338, margin=40
     *   Scale factor from user preference (pref:classicCardSizeScale or
     *   pref:modernCardSizeScale).
     *
     * visibleCount = viewport + 2 (small buffer for smooth scrolling),
     * clamped to [6, 10]. This keeps DOM/GPU memory light on TV hardware
     * while giving enough lookahead for comfortable right-scrolling.
     *
     * initialWindow matches visibleCount so boot render and the first
     * interaction window are identical — no sudden DOM expansion on
     * the first right-press.
     *
     * @param {boolean} isLandscape
     * @param {string} cardType
     * @returns {{ visibleCount: number, initialWindow: number }}
     */
    _computeRowSizing(isLandscape, cardType) {
        const mediaLayout = document.documentElement.getAttribute('data-layout-media-rows');
        const isModern = mediaLayout === 'modern';
        const isExpanded = mediaLayout === 'expanded';
        const isModernPosters = mediaLayout === 'modern-posters';
        const isExpanding = mediaLayout === 'expanding';
        const VIEWPORT_WIDTH = window.innerWidth || 1920;
        const SIDE_PADDING = 60;
        const MAX_VISIBLE = Math.ceil(parseInt(storage.getItem('pref:homeRowsLimit') || 12, 10) * 0.8);

        let itemWidth, itemMargin;

        if (isExpanded) {
            const scale = parseFloat(storage.getItem('pref:expandedCardSizeScale')) || 1.2;

            if (cardType === 'square' || cardType === 'artist' || (isExpanded && cardType === 'person')) {
                itemWidth = Math.round(223 * scale);
            } else {
                itemWidth = Math.round(396 * scale);
            }
            itemMargin = Math.round(26 * scale);
        } else if (isModern || isModernPosters) {
            const scale = isModernPosters
                ? parseFloat(storage.getItem('pref:modernPostersCardSizeScale')) || 1.2
                : parseFloat(storage.getItem('pref:modernCardSizeScale')) || 1.2;

            if (cardType === 'square' || cardType === 'artist') {
                itemWidth = Math.round(223 * scale);
                itemMargin = Math.round(26 * scale);
            } else if (isLandscape) {
                itemWidth = Math.round(396 * scale);
                itemMargin = Math.round(26 * scale);
            } else {
                itemWidth = Math.round(212 * scale);
                itemMargin = Math.round(26 * scale);
            }
        } else if (isExpanding) {
            const scale = parseFloat(storage.getItem('pref:expandingCardSizeScale')) || 1.0;

            if (isLandscape) {
                itemWidth = Math.round(468 * scale);
            } else if (cardType === 'square' || cardType === 'artist') {
                itemWidth = Math.round(264 * scale);
            } else {
                itemWidth = Math.round(175.5 * scale);
            }
            itemMargin = Math.round(31 * scale);
        } else {
            const scale = parseFloat(storage.getItem('pref:classicCardSizeScale')) || 1.0;
            itemWidth = Math.round((isLandscape ? 400 : 240) * scale);
            itemMargin = Math.round(24 * scale);
        }

        const totalItemWidth = itemWidth + itemMargin;
        const usableWidth = VIEWPORT_WIDTH - SIDE_PADDING * 2;
        const visibleInViewport = Math.max(1, Math.floor(usableWidth / totalItemWidth));

        // Viewport + 2 small buffer, clamped [6, 10]. initialWindow matches visibleCount
        // so the first right-press doesn't trigger a sudden DOM expansion.
        const visibleCount = Math.max(6, Math.min(MAX_VISIBLE, visibleInViewport + 2));
        const initialWindow = visibleCount;

        return { visibleCount, initialWindow };
    }

    /**
     * Pre-warms the image cache for the first N items in a row.
     * Fires asynchronously in the background without blocking rendering.
     *
     * @param {RowDescriptor} descriptor
     * @param {Array} items
     */
    _preWarmImagesForRow(descriptor, items) {
        if (!items || items.length === 0) return;

        const isLandscape = descriptor.layout === 'landscape';
        let sizeType;
        if (descriptor.layout === 'landscape') {
            sizeType = 'card-backdrop';
        } else if (descriptor.layout === 'square') {
            sizeType = 'square';
        } else {
            sizeType = 'poster';
        }
        const { maxWidth, quality } = imageService.getParams(sizeType, descriptor.contextType);

        // VirtualCardRow already eagerly initiates loads for the first visibleCount cards.
        // To avoid duplicate network requests and connection pool starvation on Tizen,
        // pre-warm only the items beyond the visible window (horizontal scroll lookahead).
        const { visibleCount } = this._computeRowSizing(isLandscape, descriptor.cardType || 'poster');
        const subset = items.slice(visibleCount, visibleCount + IMAGE_PREWARM_PER_ROW);
        if (subset.length === 0) return;

        const urls = [];

        for (const item of subset) {
            const itemId = item.Id;
            let url = null;

            if (isLandscape) {
                // Landscape priority: Thumb → Backdrop → SeriesThumb → Primary
                if (item.ImageTags?.Thumb) {
                    url = api.getImageUrl(itemId, 'Thumb', { maxWidth, quality, tag: item.ImageTags.Thumb });
                } else if (item.BackdropImageTags?.length > 0) {
                    url = api.getImageUrl(itemId, 'Backdrop', { maxWidth, quality });
                } else if (item.SeriesId && item.SeriesThumbImageTag) {
                    url = api.getImageUrl(item.SeriesId, 'Thumb', { maxWidth, quality, tag: item.SeriesThumbImageTag });
                } else if (item.ImageTags?.Primary) {
                    url = api.getImageUrl(itemId, 'Primary', { maxWidth, quality, tag: item.ImageTags.Primary });
                }
            } else {
                // Portrait priority: Item Primary → Series Primary
                if (item.ImageTags?.Primary) {
                    url = api.getImageUrl(itemId, 'Primary', { maxWidth, quality, tag: item.ImageTags.Primary });
                } else if (item.SeriesId) {
                    url = api.getImageUrl(item.SeriesId, 'Primary', { maxWidth, quality });
                }
            }

            if (url) urls.push(url);
        }

        if (urls.length > 0) {
            // Non-blocking background preload
            imageCache.preload(urls);
        }
    }

    // =========================================================================
    // Library Dynamic Thumbnails (preserved from v1, unchanged)
    // =========================================================================

    /**
     * Resolves and attaches dynamic backdrop URLs to library objects.
     * Overrides the default folder image in CardRenderer.
     *
     * Fetches random items from each library and picks a usable artwork URL.
     * In 'static' mode, resolved URLs are cached in localStorage to avoid
     * repeated API calls across sessions.
     *
     * @param {Array} libraries
     * @param {'static'|'dynamic'} mode
     */
    async _enrichLibrariesWithDynamicThumbs(libraries, mode) {
        if (!libraries || libraries.length === 0) return;

        // Try single-pass batch fetch for all uncached libraries via Litefin plugin
        const uncachedLibs = libraries.filter((lib) => {
            if (mode === 'static') {
                const cacheKey = `libThumb:${lib.Id}`;
                const cachedUrl = storage.getItem(cacheKey);
                if (cachedUrl) {
                    lib._dynamicThumbUrl = cachedUrl;
                    this._applyDynamicThumbToCard(lib.Id, cachedUrl, lib.Name);
                    return false;
                }
            }
            return true;
        });

        let batchMap = null;
        if (uncachedLibs.length > 0) {
            const libIds = uncachedLibs.map((lib) => lib.Id);
            const rawBatch = await api.getLibraryThumbnails(libIds);
            if (rawBatch) {
                batchMap = {};
                for (const [key, val] of Object.entries(rawBatch)) {
                    batchMap[key.replace(/-/g, '').toLowerCase()] = val;
                }
            }
        }

        // Process libraries using batched candidates or fallback queries
        await Promise.all(
            libraries.map(async (lib) => {
                try {
                    const cacheKey = `libThumb:${lib.Id}`;

                    if (mode === 'static') {
                        const cachedUrl = storage.getItem(cacheKey);
                        if (cachedUrl) {
                            lib._dynamicThumbUrl = cachedUrl;
                            this._applyDynamicThumbToCard(lib.Id, cachedUrl, lib.Name);
                            return;
                        }
                    }

                    const normalizedId = String(lib.Id || '')
                        .replace(/-/g, '')
                        .toLowerCase();
                    const batchEntry = batchMap ? batchMap[normalizedId] : undefined;

                    // New plugin format: {Items: [...], ResolvedUrl: "..."}
                    // Old format: flat array [{...}, ...] (backwards compat)
                    const preResolvedUrl = batchEntry && !Array.isArray(batchEntry) ? batchEntry.ResolvedUrl : null;
                    let items = batchEntry ? (Array.isArray(batchEntry) ? batchEntry : batchEntry.Items || []) : [];

                    // Short-circuit: use pre-resolved URL from plugin directly
                    if (preResolvedUrl) {
                        lib._dynamicThumbUrl = preResolvedUrl;
                        this._applyDynamicThumbToCard(lib.Id, preResolvedUrl, lib.Name);
                        if (mode === 'static') {
                            storage.setItem(cacheKey, preResolvedUrl);
                        }
                        return;
                    }

                    // Fallback to individual API call if batch map didn't contain this library
                    if (!batchMap || batchEntry === undefined) {
                        const includeItemTypes = (() => {
                            switch (lib.CollectionType) {
                                case 'music':
                                    return 'MusicAlbum';
                                case 'musicvideos':
                                    return 'MusicVideo';
                                case 'livetv':
                                    return 'TvChannel';
                                case 'boxsets':
                                    return 'BoxSet';
                                case 'photos':
                                case 'homevideos':
                                    return 'Photo,Video';
                                case 'playlists':
                                    return 'Playlist';
                                default:
                                    return 'Movie,Series';
                            }
                        })();

                        if (lib.CollectionType === 'livetv') {
                            const ltvResponse = await api.getLiveTvChannels({
                                Limit: 50,
                                EnableImageTypes: 'Primary,Thumb,Backdrop',
                                Fields: 'ImageTags,BackdropImageTags'
                            });
                            const ltvItems = ltvResponse?.Items || [];
                            const validLtvItems = ltvItems.filter(
                                (item) =>
                                    item.ImageTags?.Primary ||
                                    item.ImageTags?.Thumb ||
                                    item.BackdropImageTags?.length > 0
                            );
                            items = validLtvItems.sort(() => 0.5 - Math.random()).slice(0, 5);
                        } else {
                            const response = await api.getItems({
                                ParentId: lib.Id,
                                SortBy: 'Random',
                                Recursive: true,
                                Limit: 5,
                                Fields: 'BackdropImageTags,ImageTags',
                                ImageTypeLimit: 1,
                                IncludeItemTypes: includeItemTypes,
                                EnableImageTypes: 'Backdrop,Thumb,Primary',
                                Filters: 'HasImage'
                            });
                            items = response?.Items || [];
                        }
                    }

                    if (items && items.length > 0) {
                        const { maxWidth, quality } = imageService.getParams('card-backdrop');
                        let resolvedUrl = null;

                        // Iterate candidates until we find a usable image URL
                        for (const item of items) {
                            if (lib.CollectionType === 'music') {
                                // Music: album art (Primary) → Thumb → Backdrop
                                if (item.ImageTags?.Primary) {
                                    resolvedUrl = api.getImageUrl(item.Id, 'Primary', {
                                        maxWidth,
                                        quality,
                                        tag: item.ImageTags.Primary
                                    });
                                } else if (item.ImageTags?.Thumb) {
                                    resolvedUrl = api.getImageUrl(item.Id, 'Thumb', {
                                        maxWidth,
                                        quality,
                                        tag: item.ImageTags.Thumb
                                    });
                                } else if (item.BackdropImageTags?.length > 0) {
                                    resolvedUrl = api.getImageUrl(item.Id, 'Backdrop', {
                                        maxWidth,
                                        quality,
                                        tag: item.BackdropImageTags[0]
                                    });
                                }
                            } else if (lib.CollectionType === 'playlists') {
                                // Playlists: item's own Primary → Thumb → Backdrop
                                if (item.ImageTags?.Primary) {
                                    resolvedUrl = api.getImageUrl(item.Id, 'Primary', {
                                        maxWidth,
                                        quality,
                                        tag: item.ImageTags.Primary
                                    });
                                } else if (item.ImageTags?.Thumb) {
                                    resolvedUrl = api.getImageUrl(item.Id, 'Thumb', {
                                        maxWidth,
                                        quality,
                                        tag: item.ImageTags.Thumb
                                    });
                                } else if (item.BackdropImageTags?.length > 0) {
                                    resolvedUrl = api.getImageUrl(item.Id, 'Backdrop', {
                                        maxWidth,
                                        quality,
                                        tag: item.BackdropImageTags[0]
                                    });
                                }
                            } else if (lib.CollectionType === 'boxsets') {
                                // Boxsets: item's own Primary → Thumb → Backdrop
                                if (item.ImageTags?.Primary) {
                                    resolvedUrl = api.getImageUrl(item.Id, 'Primary', {
                                        maxWidth,
                                        quality,
                                        tag: item.ImageTags.Primary
                                    });
                                } else if (item.ImageTags?.Thumb) {
                                    resolvedUrl = api.getImageUrl(item.Id, 'Thumb', {
                                        maxWidth,
                                        quality,
                                        tag: item.ImageTags.Thumb
                                    });
                                } else if (item.BackdropImageTags?.length > 0) {
                                    resolvedUrl = api.getImageUrl(item.Id, 'Backdrop', {
                                        maxWidth,
                                        quality,
                                        tag: item.BackdropImageTags[0]
                                    });
                                }
                            } else if (
                                lib.CollectionType === 'photos' ||
                                lib.CollectionType === 'homevideos' ||
                                lib.CollectionType === 'musicvideos' ||
                                lib.CollectionType === 'livetv'
                            ) {
                                if (item.ImageTags?.Primary) {
                                    resolvedUrl = api.getImageUrl(item.Id, 'Primary', {
                                        maxWidth,
                                        quality,
                                        tag: item.ImageTags.Primary
                                    });
                                } else if (item.ImageTags?.Thumb) {
                                    resolvedUrl = api.getImageUrl(item.Id, 'Thumb', {
                                        maxWidth,
                                        quality,
                                        tag: item.ImageTags.Thumb
                                    });
                                }
                            } else {
                                // Standard: Backdrop → Thumb → Primary
                                if (item.BackdropImageTags?.length > 0) {
                                    resolvedUrl = api.getImageUrl(item.Id, 'Backdrop', {
                                        maxWidth,
                                        quality,
                                        tag: item.BackdropImageTags[0]
                                    });
                                } else if (item.ImageTags?.Thumb) {
                                    resolvedUrl = api.getImageUrl(item.Id, 'Thumb', {
                                        maxWidth,
                                        quality,
                                        tag: item.ImageTags.Thumb
                                    });
                                } else if (item.ImageTags?.Primary) {
                                    resolvedUrl = api.getImageUrl(item.Id, 'Primary', {
                                        maxWidth,
                                        quality,
                                        tag: item.ImageTags.Primary
                                    });
                                }
                            }

                            if (resolvedUrl) break; // Stop at first valid result
                        }

                        // Broad fallback: if typed candidates had no usable image,
                        // cast a wider net without IncludeItemTypes restriction.
                        if (!resolvedUrl) {
                            log.debug(
                                `[DynamicThumb] ${lib.Name}: typed candidates had no image, trying broad fallback`
                            );

                            let fallbackResponse;
                            if (lib.CollectionType === 'livetv') {
                                // -----------------------------------------------------
                                // Live TV Fallback Thumbnail Randomization
                                // -----------------------------------------------------
                                // Query a wider set of 50 channels with image types enabled.
                                // We filter to channels with valid images and shuffle them locally
                                // to guarantee a working fallback thumbnail.
                                // -----------------------------------------------------
                                const ltvFallback = await api.getLiveTvChannels({
                                    Limit: 50,
                                    EnableImageTypes: 'Primary,Thumb,Backdrop',
                                    Fields: 'ImageTags,BackdropImageTags'
                                });

                                // Extract items safely
                                const ltvFallbackItems = ltvFallback?.Items || [];

                                // Keep only channels that have valid visual assets
                                const validFallbackItems = ltvFallbackItems.filter(
                                    (item) =>
                                        item.ImageTags?.Primary ||
                                        item.ImageTags?.Thumb ||
                                        item.BackdropImageTags?.length > 0
                                );

                                // Randomize the list of candidate fallback cards
                                const shuffledFallback = validFallbackItems.sort(() => 0.5 - Math.random());
                                fallbackResponse = { Items: shuffledFallback.slice(0, 10) };
                            } else {
                                fallbackResponse = await api.getItems({
                                    ParentId: lib.Id,
                                    SortBy: 'Random',
                                    Recursive: true,
                                    Limit: 10,
                                    Fields: 'BackdropImageTags,ImageTags',
                                    ImageTypeLimit: 1,
                                    EnableImageTypes: 'Backdrop,Thumb,Primary',
                                    Filters: 'HasImage'
                                });
                            }

                            for (const item of fallbackResponse?.Items ?? []) {
                                if (item.BackdropImageTags?.length > 0) {
                                    resolvedUrl = api.getImageUrl(item.Id, 'Backdrop', {
                                        maxWidth,
                                        quality,
                                        tag: item.BackdropImageTags[0]
                                    });
                                } else if (item.ImageTags?.Primary) {
                                    resolvedUrl = api.getImageUrl(item.Id, 'Primary', {
                                        maxWidth,
                                        quality,
                                        tag: item.ImageTags.Primary
                                    });
                                } else if (item.ImageTags?.Thumb) {
                                    resolvedUrl = api.getImageUrl(item.Id, 'Thumb', {
                                        maxWidth,
                                        quality,
                                        tag: item.ImageTags.Thumb
                                    });
                                }
                                if (resolvedUrl) break;
                            }
                        }

                        if (resolvedUrl) {
                            lib._dynamicThumbUrl = resolvedUrl;
                            this._applyDynamicThumbToCard(lib.Id, resolvedUrl, lib.Name);
                            // Persist the resolved URL via StorageService in static mode so
                            // subsequent home page loads skip the API call entirely.
                            // Using storage.setItem() (not localStorage directly) keeps the
                            // in-memory cache consistent — the quota guard in flush() will
                            // auto-evict these keys if storage fills up.
                            if (mode === 'static') {
                                storage.setItem(cacheKey, resolvedUrl);
                            }
                        }
                    }
                } catch (e) {
                    log.warn(`Failed to fetch dynamic thumb for library ${lib.Name}`, e);
                }
            })
        );
    }

    /**
     * Updates the rendered library card's image to reflect the dynamic thumb URL,
     * and adds the overlay label if missing. The overlay is normally baked into the
     * card HTML at render time only when _dynamicThumbUrl was already set — since
     * enrichment runs after render, we inject it here.
     * @param {string} libId - Library ID
     * @param {string} url - New dynamic thumbnail URL
     * @param {string} [name] - Library display name (for overlay label)
     */
    _applyDynamicThumbToCard(libId, url, name) {
        const lazyImg = document.querySelector(`.media-card[data-item-id="${libId}"] .lazy`);
        if (!lazyImg) return;
        if (lazyImg.dataset.src === url) return;

        lazyImg.dataset.src = url;

        if (!lazyImg.classList.contains('loaded') && !lazyImg.hasAttribute('data-lazy-loading')) {
            lazyLoader.forceLoad(lazyImg);
        } else if (lazyImg.classList.contains('loaded')) {
            lazyImg.src = url;
        }

        // Insert overlay label when a dynamic thumbnail is applied and remove outside label
        const imageDiv = lazyImg.closest('.card-image');
        if (imageDiv && name && !imageDiv.querySelector('.card-overlay-label')) {
            imageDiv.insertAdjacentHTML(
                'afterbegin',
                `<div class="card-overlay-tint"></div><div class="card-overlay-label">${i18n.ensureBiDi(name)}</div>`
            );
            const card = lazyImg.closest('.media-card');
            const outsideInfo = card?.querySelector('.card-info:not(.inside)');
            if (outsideInfo) {
                outsideInfo.remove();
            }
        }
    }

    // =========================================================================
    // Page Data Cache (instant back-navigation)
    // =========================================================================

    /**
     * Returns the cached homepage data if it exists and hasn't expired.
     * @returns {Object|null} Cache object or null
     */
    _getValidCache() {
        // Respect user preference — caching can be disabled via settings
        if (storage.getItem('pref:homeScreenCache') === 'false') {
            state.delete('home:pageCache');
            return null;
        }

        const cache = state.get('home:pageCache');
        if (!cache || !cache.rows || !cache.libraries) return null;

        // Never serve cache from a different user or server
        if (cache.serverUrl !== api._serverUrl || cache.userId !== api._userId) {
            state.delete('home:pageCache');
            return null;
        }

        // Invalidate if the user changed the row items limit while the cache was active
        const currentHomeRowLimit = parseInt(storage.getItem('pref:homeRowsLimit') || 12, 10);
        if (cache.homeRowLimit !== undefined && cache.homeRowLimit !== currentHomeRowLimit) {
            state.delete('home:pageCache');
            return null;
        }

        if (Date.now() - cache.timestamp > PAGE_CACHE_TTL) {
            state.delete('home:pageCache');
            return null;
        }

        return cache;
    }

    /**
     * Restores libraries and thumbnails from cache, skipping network calls.
     * @param {Object} cache
     */
    _restoreFromCache(cache) {
        this._libraries = cache.libraries;

        // Only restore cached thumb URLs when in static mode — dynamic mode
        // should show fresh images each load, and off mode should show none.
        const thumbMode = storage.getItem('pref:libraryThumbMode') || 'off';
        if (thumbMode === 'static' && cache.thumbUrls) {
            for (const lib of this._libraries) {
                const url = cache.thumbUrls[lib.Id];
                if (url) lib._dynamicThumbUrl = url;
            }
        }
    }

    /**
     * Initializes the HeroCarousel component from a pre-fetched items array.
     * Extracted from _loadHeroCarousel() so it can be reused during cache restoration
     * without making any network calls — the items are already in memory.
     *
     * @param {Array} items - Previously fetched hero carousel items
     */
    _initHeroCarouselFromItems(items) {
        try {
            // Build the carousel instance from the cached items list
            this._hero = new HeroCarousel({ items });

            const placeholder = this.$('#home-hero-placeholder');
            if (placeholder) {
                // Read style prefs fresh — user may have changed them since the cache was written
                // Fallback to high-performance immersive style by default for fluid TV navigation.
                const carouselStyle = storage.getItem('pref:heroCarouselStyle') || 'immersive-performance';
                const isCompact = storage.getItem('pref:heroCarouselCompact') !== 'false';

                // Reset any stale classes before applying current style
                placeholder.className = '';
                placeholder.classList.add(`style-${carouselStyle}`);
                if (isCompact) {
                    placeholder.classList.add('style-compact');
                }

                // Inject the carousel markup and wire up its event listeners
                placeholder.innerHTML = this._hero.render();
                this._hero.init(placeholder.firstElementChild);

                // Seamless focus re-establishment: if the hero was the active focus target,
                // re-establish focus on the newly rendered live carousel container.
                const activeSecFromCache = focusManager.getActiveSection();
                const curFocusedFromCache = focusManager.getFocused();
                if (
                    activeSecFromCache === 'home-hero' ||
                    !curFocusedFromCache ||
                    !document.contains(curFocusedFromCache) ||
                    placeholder.contains(curFocusedFromCache)
                ) {
                    if (!focusManager.isTrapped()) {
                        this.setActiveSection('home-hero', false);
                        focusManager.focusElement(placeholder.firstElementChild, {
                            instantScroll: true,
                            skipScroll: true
                        });
                    }
                }

                // Relink the first rendered row and the hero carousel after cache restoration
                const container = this.$('#home-rows');
                if (container) {
                    const firstRow =
                        container.querySelector('section[data-row-id]:not(.media-row--skeleton)') ||
                        container.querySelector('section[data-row-id]');
                    if (firstRow) {
                        const firstRowId = firstRow.getAttribute('data-row-id');
                        this._relinkAdjacentSections(container, firstRow, firstRowId);
                    }
                }

                log.info('Hero carousel restored from cache.');
            }
        } catch (e) {
            log.error('Failed to initialize Hero Carousel from cache', e);
        }
    }

    /**
     * Replaces each descriptor's fetchFn to return cached items instantly.
     * @param {RowDescriptor[]} descriptors
     * @param {Object<string, Array>} rowCache - Row ID -> items map
     */
    _applyCachedRowData(descriptors, rowCache) {
        for (const desc of descriptors) {
            const cachedItems = rowCache[desc.id];
            if (cachedItems) {
                desc.fetchFn = () => Promise.resolve(cachedItems);
            }
        }
    }

    /**
     * Reconciles an item's UserData against authoritative client playback state
     * captured when the player stopped. Prevents read-after-write race conditions
     * where the server's SQLite database has not finished committing the stop report.
     *
     * @param {Object} item - Media item with UserData
     * @private
     */
    _reconcileItemPlaybackState(item) {
        if (!item) return;

        // Retrieve last stopped snapshot from in-memory state
        const lastStopped = state.get('playback:lastStopped');
        if (!lastStopped || lastStopped.itemId !== item.Id) return;

        // Only reconcile if stop was recent (within 60 seconds)
        if (Date.now() - lastStopped.timestamp > 60000) return;

        item.UserData = item.UserData || {};
        if (lastStopped.isNearComplete) {
            item.UserData.Played = true;
            item.UserData.PlaybackPositionTicks = 0;
            item.UserData.UnplayedItemCount = 0;
        } else if (lastStopped.positionTicks > 0) {
            item.UserData.PlaybackPositionTicks = lastStopped.positionTicks;
        }
    }

    /**
     * Saves the current homepage data to the state cache,
     * so that back-navigation renders instantly without network calls.
     * Hero carousel items are also persisted so the carousel can be
     * re-initialized on restoration without any network calls.
     */
    _savePageCache() {
        // Respect user preference
        if (storage.getItem('pref:homeScreenCache') === 'false') return;

        // If playback stopped within the last few seconds, avoid storing transitional
        // row data in the 24-hour page cache before the server fully settles.
        const lastStopped = state.get('playback:lastStopped');
        if (lastStopped && Date.now() - lastStopped.timestamp < 4000) {
            log.info('Skipping _savePageCache immediately after playback stop');
            return;
        }

        const rows = {};
        for (const [id, entry] of this._rowRegistry) {
            if (entry.virtualRow && entry.virtualRow.items && entry.virtualRow.items.length > 0) {
                rows[id] = entry.virtualRow.items;
            }
        }

        const thumbUrls = {};
        for (const lib of this._libraries) {
            if (lib._dynamicThumbUrl) {
                thumbUrls[lib.Id] = lib._dynamicThumbUrl;
            }
        }

        // Snapshot the hero carousel items so restoration skips the API call entirely.
        // HeroCarousel stores its items array on the instance as ._items.
        const heroItems = this._hero ? this._hero._items : [];

        // Track active homeRowLimit in snapshot so any future change automatically triggers invalidation
        const homeRowLimit = parseInt(storage.getItem('pref:homeRowsLimit') || 12, 10);

        state.set('home:pageCache', {
            libraries: this._libraries,
            thumbUrls,
            rows,
            heroItems,
            homeRowLimit,
            serverUrl: api._serverUrl,
            userId: api._userId,
            timestamp: Date.now()
        });

        log.info('Homepage data cached for instant back-navigation');
    }

    // =========================================================================
    // Focus Recovery & Back Button
    // =========================================================================

    /**
     * Fallback to recover homepage focus if a modal dialog was closed and left
     * the homepage with no valid or attached focused element.
     * @private
     */
    _restoreHomepageFocusFallback() {
        if (!this._isMounted) return;

        // 1. Try restoring to the hero carousel if present
        if (focusManager.getSectionConfig('home-hero') && this.$('#hero-carousel-container')) {
            this.setActiveSection('home-hero', false);
            focusManager.focusElement(this.$('#hero-carousel-container'), { instantScroll: true });
            return;
        }

        // 2. Try the first rendered row that contains media cards
        const container = this.$('#home-rows');
        if (container) {
            const firstSection = container.querySelector('section[data-row-id]:not(.media-row--skeleton)');
            if (firstSection) {
                const rowId = firstSection.getAttribute('data-row-id');
                const firstCard = firstSection.querySelector('.media-card');
                if (firstCard) {
                    this.setActiveSection(`home-row-${rowId}`, false);
                    focusManager.focusElement(firstCard, { instantScroll: true });
                    return;
                }
            }
        }

        // 3. Fall back to the navigation sidebar
        this.setActiveSection('sidebar');
    }

    onBack() {
        // Emit exit request to display the ExitDialog (or exit immediately if confirmation is disabled)
        eventBus.emit('app:exitRequested');

        // CRUCIAL: Return true to indicate to App.js that the back button was fully handled.
        // Returning undefined or false causes App.js to execute router.back(), which either pops
        // history incorrectly or emits a duplicate app:exitRequested event.
        return true;
    }
}

export default HomePage;
