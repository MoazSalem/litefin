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
         * Callback stored by _tryInitializeFocus() when a target row renders.
         * Step 7's rAF calls this after ALL rows are done to restore focus and
         * then hide the loading overlay. This ensures the page layout is stable
         * before scroll calculations and before the spinner disappears.
         * @type {Function|null}
         */
        this._pendingFocusRestore = null;

        // Mark as async page for Navigation State so scroll/focus restoration is deferred
        this._isAsyncPage = true;
    }

    render() {
        return `
            <div class="page home-page">
                <main class="page-content" id="home-content">
                    <div class="page-error" style="display: none;"></div>
                    <div id="home-hero-placeholder"></div>
                    <div class="home-rows" id="home-rows">
                        <!-- Rows are progressively injected here by _loadAndRenderRow() -->
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
            const settingVal = storage.getItem(settingKey) || (type === 'Movie' ? 'auto' : 'none');
            if (settingVal === 'none') return null;

            const storedName = storage.getItem(nameKey);
            // If user selected a specific collection and custom name is requested, use its stored name immediately
            let title =
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
                                const plRes = await api
                                    .getPlaylistItems(settingVal, { Limit: homeRowLimit })
                                    .catch(() => null);
                                items = plRes?.Items;
                            } catch (_) { }

                            if (!items || items.length === 0) {
                                const boxRes = await api.getItems({
                                    ParentId: settingVal,
                                    Limit: homeRowLimit,
                                    Fields: 'PrimaryImageAspectRatio,CanFilter,UserData',
                                    Recursive: true
                                });
                                items = boxRes?.Items;
                            }

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
                                    const plRes = await api.getPlaylistItems(smartCollection.Id, {
                                        Limit: homeRowLimit
                                    });
                                    items = plRes?.Items;
                                } else {
                                    const boxRes = await api.getItems({
                                        ParentId: smartCollection.Id,
                                        Limit: homeRowLimit,
                                        Fields: 'PrimaryImageAspectRatio,CanFilter,UserData',
                                        Recursive: true
                                    });
                                    items = boxRes?.Items;
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

        if (mergeResumeNextUp) {
            descriptors.push({
                id: 'resume',
                title: i18n.t('HeaderContinueWatching'),
                priority: 1,
                layout: 'landscape',
                cardType: 'resume',
                contextType: 'resume',
                fetchFn: async () => {
                    // Try to query the custom server-side merged endpoint first to speed up load times
                    try {
                        log.info('Attempting to fetch pre-merged continue/next-up rows from Litefin plugin');

                        // Request a combined list of items limited by user's homeRowLimit setting
                        const response = await api.getMergedRows({ limit: homeRowLimit });

                        // If we got valid items back, return them immediately
                        if (response && response.Items && response.Items.length > 0) {
                            log.info('Successfully fetched merged items from server-side Litefin plugin');
                            return response.Items;
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
                            // Extract maximum cutoff days limit for Next Up items from local storage.
                            const maxDays = parseInt(storage.getItem('pref:nextUpMaxDays'), 10);
                            const daysLimit = isNaN(maxDays) ? 365 : maxDays;
                            const params = { Limit: homeRowLimit };

                            // If a valid cutoff constraint is present, pass it along as an ISO date string.
                            if (daysLimit > 0) {
                                const cutoff = new Date();
                                cutoff.setDate(cutoff.getDate() - daysLimit);
                                params.NextUpDateCutoff = cutoff.toISOString();
                            }
                            return api.getNextUp(params);
                        })()
                    ]);

                    // Extract items list safely and tag them with a transient _isResume flag.
                    // This flag enables the sorting comparator to distinguish between resume items
                    // (which should sort by direct pause dates) and next-up items (which should
                    // sort by show activity dates).
                    const resumeItems = (resumeRes?.Items || []).map((item) => ({
                        ...item,
                        _isResume: true
                    }));

                    const nextUpItems = (nextUpRes?.Items || [])
                        .filter((item) => {
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
                    // STAGE 2: Batch Fetching of Parent Show Activity Dates
                    // ──────────────────────────────────────────────────────────
                    // Because next-up episodes are unplayed by definition, their own
                    // LastPlayedDate is null or undefined. To perform chronological
                    // Plex-style sorting, we need to know exactly when the parent series
                    // was last active. We resolve this by batch-fetching the most recent
                    // play activity of the corresponding shows in a single network request.
                    const nextUpSeriesIds = nextUpItems.map((item) => item.SeriesId).filter(Boolean);

                    // Initialize series activity timestamp lookup map.
                    const seriesLastPlayedMap = {};

                    if (nextUpSeriesIds.length > 0) {
                        try {
                            // De-duplicate the series IDs to avoid sending redundant entries in the query.
                            const uniqueSeriesIds = [...new Set(nextUpSeriesIds)];

                            // Query played and in-progress episodes belonging to these series IDs,
                            // ordered by play date descending (using the official 'DatePlayed' parameter).
                            const activeEpisodesRes = await api.getItems({
                                SeriesIds: uniqueSeriesIds.join(','),
                                IncludeItemTypes: 'Episode',
                                SortBy: 'DatePlayed',
                                SortOrder: 'Descending',
                                Fields: 'LastPlayedDate',
                                Recursive: true,
                                Limit: 100
                            });

                            // Process the returned episodes to construct the series activity map.
                            const activeEpisodes = activeEpisodesRes?.Items || [];
                            for (const ep of activeEpisodes) {
                                const seriesId = ep.SeriesId;
                                const lastPlayed = ep.UserData?.LastPlayedDate;

                                // Map each series to the newest played episode timestamp encountered.
                                if (seriesId && lastPlayed && !seriesLastPlayedMap[seriesId]) {
                                    seriesLastPlayedMap[seriesId] = new Date(lastPlayed).getTime();
                                }
                            }
                        } catch (err) {
                            // Log warning and degrade gracefully back to using DateCreated sorting.
                            console.warn('[HomePage] Failed to batch-fetch next-up parent activity dates:', err);
                        }
                    }

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
                            // If it's a next-up item, we prioritize its parent show's latest activity timestamp.
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
                            // If it's a next-up item, we prioritize its parent show's latest activity timestamp.
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
                    return res?.Items?.length > 0 ? res.Items : null;
                }
            });

            // Priority 1: Trending / Em Alta (Movies & Series)
            if (trendingMoviesDesc) {
                descriptors.push(trendingMoviesDesc);
            }
            if (trendingSeriesDesc) {
                descriptors.push(trendingSeriesDesc);
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
                    lib.CollectionType === 'music' ||
                    lib.CollectionType === 'livetv' ||
                    lib.CollectionType === 'homevideos' ||
                    lib.CollectionType === 'musicvideos'
                        ? 'square'
                        : 'portrait',
                cardType:
                    lib.CollectionType === 'music' ||
                    lib.CollectionType === 'livetv' ||
                    lib.CollectionType === 'homevideos' ||
                    lib.CollectionType === 'musicvideos'
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
        // Force Expandable Posters Layout Override
        // ====================================================================
        // If the user is running the Modern layout and has toggled on the force-poster
        // preference under settings, we dynamically coerce all horizontal track rows
        // to use standard portrait layouts ('portrait') with 'poster' cards.
        // This ensures the custom expanding-backdrops and visual transitions apply
        // universally, aligning with unified grids.
        // ====================================================================
        const isModern = layoutManager.getLayout() === 'modern';
        const forceExpandablePosters = isModern && storage.getItem('pref:homeForceExpandablePosters') === 'true';
        if (forceExpandablePosters) {
            for (const desc of descriptors) {
                // The "My Media" row uses library folder cards that must remain as static landscape cards
                if (desc.id !== 'my-media') {
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

            // ─── Step 4: Insert skeleton placeholders ─────────────────────────
            // Static dark card rectangles (no animated shimmer) give the row
            // correct visual sizing while data loads. BlurHash on live cards
            // provides the actual loading state once _renderRow() replaces them.
            this._insertSkeletonRows(descriptors);

            // ─── Step 5: Group descriptors by priority ────────────────────────
            // Rows within the same priority group run in parallel.
            // Priority 0 renders first and we await it before firing priority 1, etc.
            const priorityGroups = this._groupByPriority(descriptors);
            const priorities = Array.from(priorityGroups.keys()).sort((a, b) => a - b);

            // ─── Step 5.5: Batch pre-fetch latest library rows via plugin ────
            await this._preFetchLatestRows(descriptors);

            // Find target focus row if restoring back-navigation state
            const hasFocusTarget = this._pendingNavState || state.get('home:lastFocusedItem');
            const savedFocusObj =
                storage.getItem('pref:disableFocusRestore') !== 'true' ? state.get('home:lastFocusedItem') : null;
            const targetRowId = savedFocusObj ? savedFocusObj.rowId : null;
            const targetDescriptor = targetRowId ? descriptors.find((d) => d.id === targetRowId) : null;

            // ─── Step 6: Render priority 0 + 1 + hero + target focus row ──────
            // My Media (P0), Continue Watching/Next Up (P1), Hero Carousel, and
            // target focus row are rendered and awaited BEFORE revealing the page
            // so focus restoration succeeds without flashes or skeleton resets.
            const earlyPriorities = [0, 1];
            const earlyPromises = [];
            for (const p of earlyPriorities) {
                const group = priorityGroups.get(p);
                if (group) {
                    earlyPromises.push(...group.map((d) => this._loadAndRenderRow(d)));
                }
            }
            if (targetDescriptor && !earlyPriorities.includes(targetDescriptor.priority)) {
                earlyPromises.push(this._loadAndRenderRow(targetDescriptor));
            }
            if (heroPromise) {
                earlyPromises.push(heroPromise);
            }
            if (enrichPromise) {
                earlyPromises.push(enrichPromise);
            }
            await Promise.all(earlyPromises);
            if (!this._isMounted) return;

            // Dismiss the loading spinner now that critical content is rendered.
            // If there's a focus target, _hideSplash() in Step 8 handles it after
            // focus restoration — so we only dismiss here when there's no target.
            if (!hasFocusTarget) {
                this.setLoading(false);
            }

            // ─── Step 7: Hide splash early + restore focus ───────────────────
            // At this point My Media + content rows are visible. Reveal the page
            // so the user can start interacting while remaining rows load.
            requestAnimationFrame(() => {
                if (!this._isMounted) return;

                try {
                    // Safety net: if no row triggered _tryInitializeFocus during P0/P1
                    // (e.g. focus target is a background row), initialize on first row.
                    if (!this._focusInitialized) {
                        this._tryInitializeFocus(this.$('#home-rows'));
                    }

                    // Execute any pending focus restoration callback
                    if (typeof this._pendingFocusRestore === 'function') {
                        this._pendingFocusRestore();
                        this._pendingFocusRestore = null;
                    }

                    // Final fallback: if nothing focused yet, go to sidebar
                    if (!focusManager.getActiveSection() && !focusManager.getFocused()) {
                        this.setActiveSection('sidebar');
                    }
                } catch (err) {
                    log.error('Focus restoration failed, hiding splash anyway', err);
                }

                this._hideSplash();
            });

            // ─── Step 9: Render remaining priority groups in background ────
            // These rows are below the fold — non-critical for first interaction.
            // We load them sequentially (one priority group at a time) so the
            // HTTP connection pool isn't overwhelmed on slow TV processors.
            const remainingPriorities = priorities.filter((p) => p !== 0 && p !== 1);
            if (remainingPriorities.length > 0) {
                this._loadBackgroundRows(remainingPriorities, priorityGroups).catch((err) =>
                    log.error('Background row loading failed', err)
                );
            } else {
                // No background rows — do cleanup now
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
        const container = this.$('#home-rows');
        if (!container) return;

        const isLandscape = (descriptor) => descriptor.layout === 'landscape';
        const hideLibraryLabels = storage.getItem('pref:hideLibraryLabels') === 'true';

        for (const descriptor of descriptors) {
            const landscape = isLandscape(descriptor);
            const isLibrary = descriptor.id === 'my-media';
            const shouldHideLabels = isLibrary && hideLibraryLabels;

            // Build a skeleton section element
            const sectionEl = document.createElement('section');
            sectionEl.className = `media-row media-row--skeleton${shouldHideLabels ? ' library-no-labels' : ''}`;
            sectionEl.setAttribute('data-row-id', descriptor.id);

            // Set size variables for skeletons based on active card size scale
            const isModern = document.documentElement.getAttribute('data-layout-media-rows') === 'modern';
            if (isModern) {
                const scale = parseFloat(storage.getItem('pref:modernCardSizeScale')) || 1.3;
                const modernMultiplier = scale / 1.5;
                const itemMargin = Math.round(40 * modernMultiplier);
                sectionEl.style.setProperty('--card-width', `${Math.round(225 * modernMultiplier)}px`);
                sectionEl.style.setProperty('--card-height', `${Math.round(337.5 * modernMultiplier)}px`);
                sectionEl.style.setProperty('--card-margin', `${itemMargin}px`);
                sectionEl.style.setProperty('--card-expanded-width', `${Math.round(600 * modernMultiplier)}px`);
                sectionEl.style.setProperty('--card-square-width', `${Math.round(338 * modernMultiplier)}px`);
                sectionEl.style.setProperty('--card-expansion', `${Math.round(375 * modernMultiplier)}px`);
            } else {
                const scale = parseFloat(storage.getItem('pref:classicCardSizeScale')) || 1.0;
                const itemWidth = Math.round((landscape ? 400 : 240) * scale);
                const itemMargin = Math.round(24 * scale);
                sectionEl.style.setProperty('--skeleton-card-width', `${itemWidth}px`);
                sectionEl.style.setProperty('--skeleton-card-margin', `${itemMargin}px`);
            }

            // Build skeleton interior — title + static placeholder cards
            // The skeleton-shimmer class is stripped so these are just dark
            // rectangles — no animated shimmer. BlurHash provides the loading
            // state once live cards render.
            const skeletonCardCount = landscape ? 5 : 8;
            const rawHtml = CardRenderer.createSkeletonHtml(
                skeletonCardCount,
                landscape,
                descriptor.cardType || 'poster',
                shouldHideLabels
            );
            const staticHtml = rawHtml.replace(/\bskeleton-shimmer\b/g, '');

            sectionEl.innerHTML = `
                <h2 class="row-title">${descriptor.title}</h2>
                <div class="row-items">
                    <div class="row-items-track">
                        ${staticHtml}
                    </div>
                </div>
            `;

            // Override skeleton backgrounds with theme-following visible color.
            // The default rgba(..., 0.08) from .skeleton-image / .skeleton-line
            // is too subtle, and modern mode has an animated gradient on
            // .card-image. We suppress both with higher-opacity overrides.
            sectionEl.insertAdjacentHTML(
                'afterbegin',
                `
                <style>
                    .media-row--skeleton[data-row-id="${descriptor.id}"] .card-image,
                    .media-row--skeleton[data-row-id="${descriptor.id}"] .skeleton-image,
                    .media-row--skeleton[data-row-id="${descriptor.id}"] .skeleton-line {
                        background-color: rgba(var(--jf-primary-btn-color-rgb, 255, 255, 255), 0.6) !important;
                        background-image: none !important;
                        animation: none !important;
                    }
                </style>
            `
            );

            container.appendChild(sectionEl);
        }
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
     */
    async _loadAndRenderRow(descriptor) {
        if (!this._isMounted) return;

        try {
            // Fetch this row's data via its individual fetch function
            const items = await descriptor.fetchFn();

            if (!this._isMounted) return;

            // If the fetch returned no items, remove the skeleton placeholder
            if (!items || items.length === 0) {
                const placeholder = this.$(`[data-row-id="${descriptor.id}"]`);
                if (placeholder) {
                    placeholder.remove();
                }
                log.debug(`Row "${descriptor.id}" has no items, removed placeholder.`);
                this._checkFocusRestoration(descriptor.id, false);
                return;
            }

            // Find the placeholder and replace it with a live row
            this._renderRow(descriptor, items);

            // Pre-warm image cache AFTER the row DOM is built, so the visible
            // image loads from VirtualCardRow (lazyLoader.forceLoad) get HTTP
            // connection pool priority over speculative pre-warm requests.
            // This also prevents pre-warm from starving remaining API calls
            // (each row's fetchFn is still in-flight for unfinished rows).
            this._preWarmImagesForRow(descriptor, items);
            this._checkFocusRestoration(descriptor.id, true);
        } catch (error) {
            log.error(`Failed to load row "${descriptor.id}"`, error);

            // Remove the failed row's skeleton so we don't show an empty shimmer forever
            const placeholder = this.$(`[data-row-id="${descriptor.id}"]`);
            if (placeholder) {
                placeholder.remove();
            }
            this._checkFocusRestoration(descriptor.id, false);
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
        const homeRowLimit = parseInt(storage.getItem('pref:homeRowLimit') || '12', 10);

        try {
            const batchMap = await api.getBatchLatest(libraryIds, {
                limit: homeRowLimit,
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

        // Find the skeleton placeholder for this descriptor
        const sectionEl = container.querySelector(`[data-row-id="${descriptor.id}"]`);
        if (!sectionEl) {
            log.warn(`No placeholder found for row "${descriptor.id}" — skipping render`);
            return;
        }

        const isLandscape = descriptor.layout === 'landscape';
        const isLibrary = descriptor.id === 'my-media';
        const hideLibraryLabels = storage.getItem('pref:hideLibraryLabels') === 'true';
        const shouldHideLabels = isLibrary && hideLibraryLabels;

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
                const targetRowId = lastFocusedObj ? lastFocusedObj.rowId : null;

                let savedCard = null;

                // Try the specific row first (faster lookup)
                if (targetRowId) {
                    const rowEntry = this._rowRegistry.get(targetRowId);
                    if (rowEntry) {
                        savedCard = Array.from(rowEntry.sectionEl.querySelectorAll('.media-card')).find(
                            (card) =>
                                String(card.dataset.itemId || '')
                                    .replace(/-/g, '')
                                    .toLowerCase() === targetId
                        );
                    }
                }

                // Fall back to a global search
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
                    if (rowEntry) {
                        const itemIndex = rowEntry.virtualRow.items.findIndex(
                            (item) =>
                                String(item.Id || '')
                                    .replace(/-/g, '')
                                    .toLowerCase() === targetId
                        );
                        if (itemIndex !== -1) {
                            const node = rowEntry.virtualRow.focusByIndex(itemIndex);
                            if (node) {
                                this.setActiveSection(`home-row-${targetRowId}`, false);
                                focusManager.focusElement(node, { instantScroll: true });
                                restoredFocus = true;
                            }
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
                        this.setActiveSection(`home-row-${rowId}`, false);

                        if (!focusManager.getFocused()) {
                            const firstCard = firstSection.querySelector('.media-card');
                            if (firstCard) {
                                focusManager.focusElement(firstCard, { instantScroll: true });
                            } else {
                                this.setActiveSection('sidebar');
                            }
                        }
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
                } else {
                    router.navigate(`/details/${card.dataset.itemId}`);
                }
            }
        };

        // Bind both events for parity with Sidebar.js snappy behavior
        container.addEventListener('mousedown', handleActivate);
        container.addEventListener('click', handleActivate);

        // ── FocusIn → Sync VirtualCardRow index ──────────────────────────────
        // When focus jumps to a card via SpatialNavigator (bypassing onMove),
        // we must sync the VirtualCardRow's internal currentIndex to match.
        // Without this, the next onMove() call would start from the wrong index.
        container.addEventListener('focusin', (e) => {
            if (!e.target.classList.contains('media-card')) return;

            const sectionEl = e.target.closest('section[data-row-id]');
            if (!sectionEl) return;

            const rowId = sectionEl.getAttribute('data-row-id');
            const rowEntry = this._rowRegistry.get(rowId);
            if (rowEntry) {
                rowEntry.virtualRow.syncIndexFromNode(e.target);
            }
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
        const idx = liveSections.indexOf(sectionEl);
        if (idx === -1) return;

        // Helper to get the section ID string for FocusManager
        const sId = (el) => (el ? `home-row-${el.getAttribute('data-row-id')}` : null);

        const prevEl = idx > 0 ? liveSections[idx - 1] : null;
        const nextEl = idx < liveSections.length - 1 ? liveSections[idx + 1] : null;

        // Patch the new row
        const newConfig = focusManager.getSectionConfig(`home-row-${rowId}`);
        if (newConfig) {
            newConfig.leaveUp = sId(prevEl);
            newConfig.leaveDown = sId(nextEl);
        }

        // Patch the row above: its leaveDown should now point to this new row
        if (prevEl) {
            const prevConfig = focusManager.getSectionConfig(sId(prevEl));
            if (prevConfig) prevConfig.leaveDown = `home-row-${rowId}`;
        }

        // Patch the row below: its leaveUp should now point to this new row
        if (nextEl) {
            const nextConfig = focusManager.getSectionConfig(sId(nextEl));
            if (nextConfig) nextConfig.leaveUp = `home-row-${rowId}`;
        }

        // Special Case: If this is now the first row, link its leaveUp to the hero carousel.
        // Uses focusManager section existence rather than this._hero so the link is
        // established even during the skeleton phase (before hero data loads).
        if (idx === 0 && focusManager.getSectionConfig('home-hero')) {
            const firstRowConfig = focusManager.getSectionConfig(`home-row-${rowId}`);
            if (firstRowConfig) {
                firstRowConfig.leaveUp = 'home-hero';

                // Also link hero leaveDown to this row
                const heroConfig = focusManager.getSectionConfig('home-hero');
                if (heroConfig) {
                    heroConfig.leaveDown = `home-row-${rowId}`;
                }
            }
        }
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

        const carouselStyle = storage.getItem('pref:heroCarouselStyle') || 'immersive';
        const isCompact = storage.getItem('pref:heroCarouselCompact') !== 'false';

        placeholder.className = '';
        placeholder.classList.add(`style-${carouselStyle}`);
        if (isCompact) {
            placeholder.classList.add('style-compact');
        }

        // Read theme color for skeleton backgrounds
        const primaryRgb =
            getComputedStyle(document.documentElement).getPropertyValue('--jf-primary-btn-color-rgb').trim() ||
            '255, 255, 255';

        placeholder.innerHTML = `
            <div id="hero-carousel-container" 
                 class="hero-carousel-container ${carouselStyle} ${isCompact ? 'compact' : ''} skeleton" 
                 tabindex="-1">
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
            leaveDown: null,
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
                'Overview,ImageTags,ProductionYear,RunTimeTicks,OfficialRating,CommunityRating,ParentLogoImageTag,ParentLogoItemId,SeriesId,ProviderIds';
            const imageTypes = 'Primary,Backdrop,Logo';

            let items = [];

            // Try single-pass fetch via Litefin Plugin endpoint
            const pluginHero = await api.getHomeHero({ limit, ignoreWatched });
            if (pluginHero && Array.isArray(pluginHero.Items) && pluginHero.Items.length > 0) {
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
                // Fallback to immersive style by default for premium home screen aesthetics.
                const carouselStyle = storage.getItem('pref:heroCarouselStyle') || 'immersive';
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

                // Relink the first rendered row and the hero carousel now that the hero has initialized
                const container = this.$('#home-rows');
                if (container) {
                    const firstRow = container.querySelector('section[data-row-id]:not(.media-row--skeleton)');
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
        const isModern = document.documentElement.getAttribute('data-layout-media-rows') === 'modern';
        const VIEWPORT_WIDTH = window.innerWidth || 1920;
        const SIDE_PADDING = 60;
        const MAX_VISIBLE = Math.ceil(parseInt(storage.getItem('pref:homeRowsLimit') || 12, 10) * 0.8);

        let itemWidth, itemMargin;

        if (isModern) {
            const scale = parseFloat(storage.getItem('pref:modernCardSizeScale')) || 1.3;
            const m = scale / 1.5;

            if (isLandscape) {
                itemWidth = Math.round(600 * m);
            } else if (cardType === 'square' || cardType === 'artist') {
                itemWidth = Math.round(338 * m);
            } else {
                itemWidth = Math.round(225 * m);
            }
            itemMargin = Math.round(40 * m);
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
        const urls = [];
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

        const subset = items.slice(0, IMAGE_PREWARM_PER_ROW);

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

        // Insert overlay label if the card was rendered without it
        const imageDiv = lazyImg.closest('.card-image');
        if (imageDiv && name && !imageDiv.querySelector('.card-overlay-label')) {
            imageDiv.insertAdjacentHTML(
                'afterbegin',
                `<div class="card-overlay-tint"></div><div class="card-overlay-label">${i18n.ensureBiDi(name)}</div>`
            );
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
                const carouselStyle = storage.getItem('pref:heroCarouselStyle') || 'immersive';
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
     * Saves the current homepage data to the state cache,
     * so that back-navigation renders instantly without network calls.
     * Hero carousel items are also persisted so the carousel can be
     * re-initialized on restoration without any network calls.
     */
    _savePageCache() {
        // Respect user preference
        if (storage.getItem('pref:homeScreenCache') === 'false') return;

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

        state.set('home:pageCache', {
            libraries: this._libraries,
            thumbUrls,
            rows,
            heroItems,
            serverUrl: api._serverUrl,
            userId: api._userId,
            timestamp: Date.now()
        });

        log.info('Homepage data cached for instant back-navigation');
    }

    // =========================================================================
    // Back Button
    // =========================================================================

    onBack() {
        eventBus.emit('app:exitRequested');
    }
}

export default HomePage;
