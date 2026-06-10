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
                    // STAGE 1: Parallel Fetching of Base Data Lists
                    // ──────────────────────────────────────────────────────────
                    // We initiate simultaneous network requests for both in-progress items
                    // and next-up show items to optimize load times and keep the UI highly
                    // responsive under typical domestic network latency.
                    const [resumeRes, nextUpRes] = await Promise.all([
                        api.getResumeItems(),
                        (async () => {
                            // Extract maximum cutoff days limit for Next Up items from local storage.
                            const maxDays = parseInt(storage.getItem('pref:nextUpMaxDays'), 10);
                            const daysLimit = isNaN(maxDays) ? 365 : maxDays;
                            const params = {};

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

                    return deduplicated.length > 0 ? deduplicated : null;
                }
            });
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
                    const res = await api.getResumeItems();
                    return res?.Items?.length > 0 ? res.Items : null;
                }
            });

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

                    const params = {};
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
                 * UI Layout Aspect Determination (Apple HIG Compliance)
                 * ============================================================
                 *
                 * Following Apple's Human Interface Guidelines, grid systems
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
                fetchFn: async () => {
                    try {
                        const params = hidePlayedInLatest ? { Filters: 'IsUnplayed' } : {};
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
        // universally, aligning with unified grids (Apple HIG style).
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

            // ─── Step 1: Load core dependencies ──────────────────────────────
            // Libraries are shared across multiple descriptors, so we fetch them
            // once upfront before building the descriptor list.
            await api.getCurrentUser(); // Validate session
            const viewsResponse = await api.getUserViews();
            this._libraries = viewsResponse.Items || [];

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

            // ─── Step 2: Optional dynamic library thumbnails ──────────────────
            const thumbMode = storage.getItem('pref:libraryThumbMode') || 'off';
            if ((thumbMode === 'static' || thumbMode === 'dynamic') && this._libraries.length > 0) {
                await this._enrichLibrariesWithDynamicThumbs(this._libraries, thumbMode);
                if (!this._isMounted) return;
            }

            // ─── Step 2b: Hero Carousel ──────────────────────────────────────
            const enableHero = storage.getItem('pref:heroCarousel') !== 'false';
            if (enableHero) {
                await this._loadHeroCarousel();
                if (!this._isMounted) return;
            }

            // ─── Step 3: Build descriptors ────────────────────────────────────
            const descriptors = this._getRowDescriptors();

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

            // ─── Step 4: Insert skeleton placeholders instantly ───────────────
            // This gives the user immediate visual feedback while data loads.
            this._insertSkeletonRows(descriptors);

            // ─── Step 5: Group descriptors by priority ────────────────────────
            // Rows within the same priority group run in parallel.
            // Priority 0 renders first and we await it before firing priority 1, etc.
            const priorityGroups = this._groupByPriority(descriptors);
            const priorities = Array.from(priorityGroups.keys()).sort((a, b) => a - b);

            // Dismiss the spinner visually — skeletons are now visible.
            // NOTE: We suppress the app:hideSplash event here. The overridden
            // setLoading() below skips emitting it so the splash stays visible
            // until _tryInitializeFocus() has placed focus on the correct row.
            //
            // [FOCUS RESTORATION FIX]: Keep the loading spinner active whenever
            // we have a saved focus target to restore — either from a back-button
            // navigation (_pendingNavState) or from sidebar/forward navigation where
            // home:lastFocusedItem was stored. In both cases we must wait until
            // _tryInitializeFocus() has run inside its double rAF and set the correct
            // focus + scroll before revealing the page, to prevent the visible flash
            // of the page at scroll-top with no focused element.
            const hasFocusTarget = this._pendingNavState || state.get('home:lastFocusedItem');
            if (!hasFocusTarget) {
                this.setLoading(false);
            }

            // ─── Step 6: Render groups sequentially by priority ───────────────
            for (const priority of priorities) {
                const group = priorityGroups.get(priority);

                // Fire all rows in this priority group in parallel
                await Promise.all(group.map((descriptor) => this._loadAndRenderRow(descriptor)));

                if (!this._isMounted) return;
            }

            // ─── Step 7: Post-render cleanup ──────────────────────────────────
            // After all rows are rendered, pre-warm the ScrollController offset
            // cache in one batched layout read (much cheaper than per-row reads).
            this._prewarmScrollCache();

            // Notify base Page that async content is ready for scroll/focus restoration
            this.restoreScrollFocusWhenReady();

            // Mark the page as fully loaded and ready, resolving the ready Promise
            this.markReady();

            // Safety net: if no row triggered _tryInitializeFocus during rendering
            // (e.g. all rows failed or there was no target row), initialize now.
            if (!this._focusInitialized) {
                this._tryInitializeFocus(this.$('#home-rows'));
            }

            // ── Reveal page with focus already in place ───────────────────────
            // We wait until ALL rows have finished rendering before hiding the
            // loading overlay. We use a rAF so that the browser paints the final
            // fully-rendered row layout BEFORE we call _hideSplash(), and so that
            // any focus-restoring rAF queued by _tryInitializeFocus() (which runs
            // during Step 6) has already fired and placed focus correctly.
            requestAnimationFrame(() => {
                if (!this._isMounted) return;

                // Execute any pending focus restoration callback
                // (queued by _tryInitializeFocus when the target row rendered during Step 6)
                if (typeof this._pendingFocusRestore === 'function') {
                    this._pendingFocusRestore();
                    this._pendingFocusRestore = null;
                }

                // Final fallback: if nothing focused yet, go to sidebar
                if (!focusManager.getActiveSection() && !focusManager.getFocused()) {
                    this.setActiveSection('sidebar');
                }

                this._hideSplash();
            });
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
     * home-rows container. The placeholders are replaced in-place when the
     * actual data arrives, giving the user instant visual feedback.
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

            // Build skeleton interior — title + shimmer cards
            // Number of skeleton cards to show: landscape rows fit ~5, portrait ~8
            const skeletonCardCount = landscape ? 5 : 8;
            const skeletonHtml = CardRenderer.createSkeletonHtml(
                skeletonCardCount,
                landscape,
                descriptor.cardType || 'poster',
                shouldHideLabels
            );

            sectionEl.innerHTML = `
                <h2 class="row-title">${descriptor.title}</h2>
                <div class="row-items">
                    <div class="row-items-track">
                        ${skeletonHtml}
                    </div>
                </div>
            `;

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

            // Pre-warm image cache for this row's items (non-blocking)
            this._preWarmImagesForRow(descriptor, items);

            // Find the placeholder and replace it with a live row
            this._renderRow(descriptor, items);
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

        const virtualRow = new VirtualCardRow(trackEl, items, {
            isLandscape,
            cardType: descriptor.cardType || 'poster',
            hideLabels: shouldHideLabels,
            // Sliding window size after initial boot render.
            // Landscape rows: 6 cards in the window — ~4.5 fit in the TV viewport, so this gives
            // about 1 card of lookahead on each side without keeping 8 large decoded backdrop
            // images in GPU memory simultaneously.
            // Portrait rows: 12 — narrower cards (240px) pack more per screen, lookahead is cheap.
            visibleCount: isLandscape ? 6 : 12,
            // Boot render: pre-render first N items before the user scrolls,
            // so the row is ready to receive focus without on-demand DOM creation lag.
            // Landscape rows get 5 (they're wide, so ~5 fill the screen).
            // Portrait rows get all items (narrow, packs more per screen, worth the cost).
            initialWindow: isLandscape ? 5 : items.length,
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
            const lastFocusedObj = state.get('home:lastFocusedItem');
            const legacyLastFocusedId = state.get('home:lastFocusedItemId');

            let restoredFocus = false;

            if (lastFocusedObj || legacyLastFocusedId) {
                const targetId = lastFocusedObj ? lastFocusedObj.itemId : legacyLastFocusedId;
                const targetRowId = lastFocusedObj ? lastFocusedObj.rowId : null;

                let savedCard = null;

                // Try the specific row first (faster lookup)
                if (targetRowId) {
                    const rowEntry = this._rowRegistry.get(targetRowId);
                    if (rowEntry) {
                        savedCard = rowEntry.sectionEl.querySelector(`.media-card[data-item-id="${targetId}"]`);
                    }
                }

                // Fall back to a global search
                if (!savedCard) {
                    savedCard = container.querySelector(`.media-card[data-item-id="${targetId}"]`);
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
                            (item) => String(item.Id) === String(targetId)
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

                // Restore any captured scroll offset from NavigationState.
                // Since we nullified this._pendingNavState synchronously above,
                // restoreScrollFocusWhenReady() at the end of the pipeline is safely a no-op.
                if (restoredFocus && pendingNav) {
                    const scrollContainer = this.$('.page-content');
                    if (scrollContainer && pendingNav.scrollTop > 0) {
                        scrollContainer.scrollTop = pendingNav.scrollTop;
                    }
                }
            }

            // ─── Default: focus the first card in the first rendered row ──────
            if (!restoredFocus) {
                // Prioritize the hero carousel if it exists
                if (this._hero && this.$('#hero-carousel-container')) {
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
            const sectionEl = card.closest('section[data-row-id]');
            const rowId = sectionEl ? sectionEl.getAttribute('data-row-id') : null;

            state.set('home:lastFocusedItem', {
                itemId: card.dataset.itemId,
                rowId // Stable ID (not fragile DOM index)
            });

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

        // Special Case: If this is now the first row, link its leaveUp to the hero carousel
        if (idx === 0 && this._hero) {
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
            // If active, we append the 'IsUnplayed' item filter to the request so that
            // the Jellyfin backend returns only unplayed Movies and Series for the banner.
            const ignoreWatched = storage.getItem('pref:heroCarouselIgnoreWatched') === 'true';
            const filters = ignoreWatched ? 'HasBackdrop,IsUnplayed' : 'HasBackdrop';

            // Fetch random items with backdrops from user libraries.
            const response = await api.getItems({
                SortBy: 'Random',
                Recursive: true,
                Limit: limit,
                Fields: 'Overview,ImageTags,ProductionYear,RunTimeTicks,OfficialRating,CommunityRating,ParentLogoImageTag,ParentLogoItemId,SeriesId,ProviderIds',
                EnableImageTypes: 'Primary,Backdrop,Logo',
                IncludeItemTypes: 'Movie,Series',
                Filters: filters
            });

            if (!this._isMounted) return;

            const items = response.Items || [];
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
        // Process all libraries in parallel for maximum speed
        await Promise.all(
            libraries.map(async (lib) => {
                try {
                    const cacheKey = `libThumb:${lib.Id}`;

                    // Static mode: check StorageService cache first (in-memory, zero disk I/O).
                    // Using storage.getItem() instead of localStorage.getItem() so the read
                    // comes from the in-memory Map rather than hitting the disk synchronously.
                    if (mode === 'static') {
                        const cachedUrl = storage.getItem(cacheKey);
                        if (cachedUrl) {
                            lib._dynamicThumbUrl = cachedUrl;
                            return;
                        }
                    }

                    // ==========================================================
                    // Dynamic Thumbnail Candidate Typing
                    // ==========================================================
                    // Map the library collection type to the most appropriate
                    // Jellyfin item type that yields high-resolution artwork:
                    //
                    // - music: MusicAlbum works better than track/artist stubs.
                    // - musicvideos: Query MusicVideo items recursively.
                    // - livetv: Query TvChannel items to pull in channel logo artwork.
                    // - photos: Include both Photo and Video contents since camera
                    //   rolls naturally mix images and videos.
                    // - homevideos: Query Video items recursively since they
                    //   never have standard "Movie" or "Series" tags.
                    // ==========================================================
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
                                return 'Photo,Video';
                            case 'homevideos':
                                // Allow both photo and video items from home video libraries
                                // to act as candidates for dynamic fallback thumbnail generation.
                                return 'Photo,Video';
                            case 'playlists':
                                return 'Playlist';
                            default:
                                return 'Movie,Series';
                        }
                    })();

                    // ==========================================================
                    // Dynamic Thumbnail Library Query
                    // ==========================================================
                    // Live TV (livetv) libraries are not standard folder structures
                    // and do not have child items under a ParentId. Instead, they
                    // store global TV Channels, which we fetch using the specialized
                    // getLiveTvChannels API endpoint. Everything else uses standard
                    // child item queries.
                    // ==========================================================
                    let response;
                    if (lib.CollectionType === 'livetv') {
                        // -----------------------------------------------------
                        // Live TV Dynamic Thumbnail Randomization
                        // -----------------------------------------------------
                        // We query the first 50 channels with image types explicitly enabled
                        // to guarantee that the server delivers proper ImageTags and aspect ratios.
                        // Then we filter out any channels without valid images before shuffling
                        // to ensure a successful rotating thumbnail selection.
                        // -----------------------------------------------------
                        const ltvResponse = await api.getLiveTvChannels({
                            Limit: 50,
                            EnableImageTypes: 'Primary,Thumb,Backdrop',
                            Fields: 'PrimaryImageAspectRatio,ImageTags,BackdropImageTags'
                        });

                        // Extract channel items safely
                        const ltvItems = ltvResponse?.Items || [];

                        // Filter channels to only those with valid primary, thumb or backdrop artwork
                        const validLtvItems = ltvItems.filter(
                            (item) =>
                                item.ImageTags?.Primary || item.ImageTags?.Thumb || item.BackdropImageTags?.length > 0
                        );

                        // Local shuffle to randomize the logo across loads
                        const shuffledLtv = validLtvItems.sort(() => 0.5 - Math.random());
                        response = { Items: shuffledLtv.slice(0, 5) };
                    } else {
                        response = await api.getItems({
                            ParentId: lib.Id,
                            SortBy: 'Random',
                            Recursive: true,
                            Limit: 5,
                            Fields: 'BackdropImageTags,ImageTags',
                            ImageTypeLimit: 1,
                            IncludeItemTypes: includeItemTypes,
                            EnableImageTypes: 'Backdrop,Thumb,Primary',
                            Filters: 'HasImage' // Only items with guaranteed artwork
                        });
                    }

                    if (response?.Items?.length > 0) {
                        const { maxWidth, quality } = imageService.getParams('card-backdrop');
                        let resolvedUrl = null;

                        // Iterate candidates until we find a usable image URL
                        for (const item of response.Items) {
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
                                // Playlists themselves usually only have a 4-item grid (Primary) and no Backdrop.
                                // To get a true landscape backdrop for the home page, we fetch the items
                                // inside the playlist and grab a backdrop from one of them.
                                try {
                                    const pResponse = await api.getPlaylistItems(item.Id, {
                                        Limit: 20,
                                        Fields: 'BackdropImageTags'
                                    });

                                    const pItems = pResponse?.Items || [];
                                    // Shuffle locally so the backdrop changes across reloads
                                    const shuffled = pItems.sort(() => 0.5 - Math.random());

                                    for (const pItem of shuffled) {
                                        if (pItem.BackdropImageTags?.length > 0) {
                                            resolvedUrl = api.getImageUrl(pItem.Id, 'Backdrop', {
                                                maxWidth,
                                                quality,
                                                tag: pItem.BackdropImageTags[0]
                                            });
                                            break;
                                        }
                                    }
                                } catch (e) {
                                    log.warn(`Failed to fetch items for playlist ${item.Id} for dynamic thumb`, e);
                                }

                                // Fallback to the playlist's own primary/backdrop if we couldn't find one inside
                                if (!resolvedUrl) {
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
                                    }
                                }
                            } else if (lib.CollectionType === 'boxsets') {
                                // Collections: Backdrop → Primary
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
                                }
                            } else if (
                                lib.CollectionType === 'photos' ||
                                lib.CollectionType === 'homevideos' ||
                                lib.CollectionType === 'musicvideos' ||
                                lib.CollectionType === 'livetv'
                            ) {
                                // ==========================================================
                                // Photo, Home Videos, Music Videos & Live TV Fallbacks
                                // ==========================================================
                                // These libraries do not rely on standard theatrical backdrops.
                                // Instead, we prioritize the Primary tag (photos, channel logos,
                                // video snapshots) to immediately capture the authentic artwork.
                                // ==========================================================
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
                                // ==========================================================
                                // Standard Fallback Chain (Movies, Series, etc.)
                                // ==========================================================
                                // backdrop is always prioritized for library landscape cards
                                // to create a dramatic theatrical header feel.
                                // ==========================================================
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
                                    Fields: 'PrimaryImageAspectRatio,ImageTags,BackdropImageTags'
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

    // =========================================================================
    // Back Button
    // =========================================================================

    onBack() {
        eventBus.emit('app:exitRequested');
    }
}

export default HomePage;
