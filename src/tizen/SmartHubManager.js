/**
 * ============================================================================
 * Litefin Tizen - Smart Hub Preview Manager
 * ============================================================================
 * Manages Samsung Smart Hub Preview integration for the Litefin Tizen app.
 *
 * Smart Hub Preview surfaces personalised content tiles on the Samsung TV
 * home screen, visible when the user highlights the Litefin app icon. This
 * module owns the full lifecycle:
 *
 *   1. DATA FETCHING — "Continue Watching" and "Next Up" are pulled from the
 *      Jellyfin server using the existing ApiClient singleton. All auth,
 *      timeout, and retry logic is inherited at no extra cost.
 *
 *   2. TILE BUILDING — Jellyfin BaseItemDto objects are mapped to the Samsung
 *      Preview JSON schema. The best available image (Thumb → Backdrop →
 *      Primary) is chosen per tile, keeping them in the 16:9 ratio Samsung
 *      recommends. The item ID and type are serialised into action_data so
 *      the deep link handler knows exactly where to navigate.
 *
 *   3. SERVICE DISPATCH — The built JSON is forwarded to the background
 *      ytresolver service (already registered in config.xml) via
 *      ApplicationControl. The service calls webapis.preview.setPreviewData()
 *      and sends an ACK back through a named MessagePort.
 *
 *   4. DEEP LINK HANDLING — When the user taps a tile on the TV home screen,
 *      Samsung re-launches Litefin with a PAYLOAD AppControl key. This module
 *      parses the payload and navigates to the correct details page, pushing
 *      a home page breadcrumb first so the Back key stays inside Litefin
 *      (Samsung's Return Key Policy requirement).
 *
 *   5. REFRESH CYCLE — A cooperative setTimeout chain (not setInterval) runs
 *      a full update every 10 minutes from the end of the previous cycle,
 *      so slow hardware never stacks back-to-back updates. The cycle starts
 *      on auth:login and stops on auth:logout.
 *
 * Requires Tizen 4.0+. Version-gated silently in init().
 * ============================================================================
 */

import { api } from '../api/ApiClient.js';
import { auth } from '../api/index.js';
import { tizenAdapter } from './TizenAdapter.js';
import { eventBus } from '../core/EventBus.js';
import { state } from '../core/StateManager.js';
import { router } from '../core/Router.js';
import { logger } from '../utils/Logger.js';
import { pinManager } from '../utils/PinManager.js';
import { storage } from '../utils/StorageService.js';
import { getSeriesLastWatchedDates } from '../utils/NextUpActivity.js';
import { PlayerSettings } from '../utils/PlayerSettings.js';
import { idleGate } from '../utils/IdleGate.js';

const log = logger.create('SmartHubManager');

// ============================================================================
// Constants
// ============================================================================

/* How often (after a completed update) to push a fresh preview. */
const REFRESH_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

/* Maximum number of Smart Hub tiles (one per series or movie). */
const MAX_TILES = 10;

/* Longest a tile launch waits for its series episode before opening the series page. */
const RESOLVE_TIMEOUT_MS = 3000;

/* sessionStorage keys: they survive Litefin's own reloads but not a new launch. */
const BOOT_MARKER_KEY = 'litefin:smarthub_booted';
const RELOAD_TARGET_KEY = 'litefin:smarthub_reload_target';

/* Longest a warm tile click waits for the app to become visible again. */
const VISIBLE_WAIT_MS = 1000;

/* Named local MessagePort that the ytresolver service sends its ACK to. */
const ACK_PORT_NAME = 'SmartHubAck';

/* Give up waiting for the service ACK after this many milliseconds. */
const SERVICE_TIMEOUT_MS = 15000;

/* Quiet window (ms) required before background sync / process creation. */
const USER_ACTIVITY_IDLE_MS = 5000;

/* Wait for the previous ytresolver process to exit after a preview commit. */
const SERVICE_RELAUNCH_DELAY_MS = 3000;

// ============================================================================
// SmartHubManager Class
// ============================================================================

class SmartHubManager {
    constructor() {
        /** @type {boolean} - True once init() passes the version gate. */
        this._ready = false;

        /** @type {boolean} - Debounce guard for concurrent update calls. */
        this._updating = false;

        /** @type {boolean} - True while the refresh cycle should keep running. */
        this._cycleActive = false;

        /** @type {number|null} - setTimeout handle for the next scheduled refresh. */
        this._refreshTimer = null;

        /** @type {number} - IdleGate task waiting to run the deferred update. */
        this._deferredUpdateTask = null;

        /** @type {number|null} - Delay before relaunching the ytresolver service. */
        this._serviceRelaunchTimer = null;

        /** @type {number} - IdleGate task waiting to relaunch the service. */
        this._serviceRelaunchTask = null;

        /** @type {number|null} - 2s post-playback refresh delay. */
        this._playbackRefreshTimer = null;

        /** @type {number} - IdleGate task waiting to spawn the resolver service. */
        this._serviceDispatchTask = null;

        /** @type {Function|null} - Resolver for the in-flight _sendToService promise. */
        this._serviceDispatchResolve = null;

        /** @type {Object|null} - Last successfully built preview JSON (in-memory cache). */
        this._cachedJson = null;

        /**
         * @type {{ actionData: Object, owner: string, target: Object|null, resolvedFor: string|null }|null}
         * A tile not opened yet: at cold start until the default route opens it,
         * or held until a profile is chosen on the profile picker. Only opened for
         * its owner (the profile whose row it is); target is the lookup result
         * for profile resolvedFor and is looked up again for any other profile.
         */
        this._pendingDeepLink = null;

        /**
         * @type {boolean} - True once the active profile has been unlocked this
         * run (a real auth:login fired). Restoring a session at startup does NOT
         * set this, so a PIN-locked profile stays gated until the user enters it.
         */
        /**
         * @type {boolean} - True when media playback is actively running.
         * Used to suspend background updates and IPC to prevent socket / CPU contention.
         */
        this._isPlaying = false;
    }

    // ========================================================================
    // Public API
    // ========================================================================

    /**
     * Initialise the manager. Call once from App.init() after platformInfo.init()
     * and auth.init() have already run.
     *
     * - Version-gates at Tizen > 3.0 (Smart Hub Preview API introduced in 4.0).
     * - Registers the 'appcontrol' listener for home-screen deep links.
     * - Starts the 10-min refresh cycle if a session is already active.
     *
     * @returns {Promise<void>} Resolves once a cold-start tile target is resolved
     *   (immediately when Litefin was not launched from a tile)
     */
    init() {
        /* Version check — read version from TizenAdapter so all Tizen API
         * surface stays encapsulated inside the adapter layer. */
        const tizenVer = tizenAdapter.getTizenVersion();
        if (tizenVer <= 3) {
            log.info(`Smart Hub Preview not enabled (Tizen ${tizenVer} ≤ 3.0, requires 4.0+)`);
            return;
        }

        this._ready = true;
        log.info(`Smart Hub Preview initialised (Tizen ${tizenVer})`);

        // ── Deep link handler ─────────────────────────────────────────────
        // Samsung fires 'appcontrol' on the main window when any tile on the
        // home screen is tapped while Litefin runs. A cold launch by a tile tap
        // fires no event; that target is resolved now and opened by the
        // default route (openStartupTarget) or after the profile picker.
        window.addEventListener('appcontrol', () => this.handleDeepLink());
        const startupDeepLink = this._prepareStartupDeepLink();

        // ── Session lifecycle hooks ───────────────────────────────────────
        // If a session was already restored at startup (auth.init() with
        // stored credentials), auth:login never fires — check now.
        if (state.get('user:authenticated')) {
            log.info('Session already active — starting refresh cycle immediately');
            this._startRefreshCycle();
        }

        // Wire into auth events for ongoing session management.
        eventBus.on('auth:login', (user) => {
            // A real login/switch means the active profile is now unlocked.
            this._unlocked = true;
            this._startRefreshCycle();

            if (!this._pendingDeepLink) return;
            const pending = this._pendingDeepLink;
            this._pendingDeepLink = null;

            // The tile belongs to the profile whose row it is.
            if (user?.Id !== pending.owner) {
                log.info('Held deep link dropped — another profile was chosen');
                return;
            }

            // With per-user settings ProfilesPage reloads the app right after this
            // event; the tile is looked up and opened by the default route after the reload.
            if (router.getCurrentPath() === '/profiles' && storage.getItem('litefin:settings_per_user') === 'true') {
                try {
                    sessionStorage.setItem(
                        RELOAD_TARGET_KEY,
                        JSON.stringify({ ...pending.actionData, uid: pending.owner })
                    );
                } catch (_) {}
                return;
            }

            // Deferred so it runs AFTER ProfilesPage._switchToUser's own reset to
            // /home, otherwise that would clobber our details navigation.
            log.info('Opening held deep link after profile selection');
            setTimeout(() => this._openPending(pending), 0);
        });
        eventBus.on('auth:logout', () => {
            // Re-lock: the next entry into a PIN profile must re-prompt.
            this._unlocked = false;
            this._pendingDeepLink = null;
            // Cancel the refresh chain plus any deferred update/service launch
            // that was waiting for the UI to go idle.
            this.stop();
        });

        // ── Playback lifecycle — suspend background sync during playback ─
        eventBus.on('player:play', () => {
            this._isPlaying = true;
        });
        eventBus.on('player:playing', () => {
            this._isPlaying = true;
        });

        // ── Playback end / stop — refresh tiles ─────────────────────────
        // When the user finishes watching or stops an item, the Continue Watching
        // and Next Up data may have changed. We listen to both 'player:ended' (natural completion)
        // and 'player:stopped' (user backing out or manually stopping) to cover all exit paths.
        //
        // We introduce a 2-second delay before calling update() to ensure the Jellyfin
        // server has fully received, processed, and committed the playback stop report
        // before we query the fresh lists. This avoids fetching stale data due to network race conditions.
        const handlePlaybackFinished = () => {
            this._isPlaying = false;
            if (this._cycleActive) {
                log.info('Playback finished or stopped — scheduling Smart Hub preview refresh in 2s');
                if (this._playbackRefreshTimer !== null) {
                    clearTimeout(this._playbackRefreshTimer);
                }
                this._playbackRefreshTimer = setTimeout(() => {
                    this._playbackRefreshTimer = null;
                    if (this._cycleActive && !this._isPlaying) {
                        this.update();
                    }
                }, 2000);
            }
        };

        eventBus.on('player:ended', handlePlaybackFinished);
        eventBus.on('player:stopped', handlePlaybackFinished);

        return startupDeepLink;
    }

    /**
     * Read the action_data of the Smart Hub tile that launched or resumed Litefin.
     *
     * The AppControl data contains a 'PAYLOAD' key whose first value is:
     *   JSON.stringify({ values: JSON.stringify({ id, type, seriesid? }) })
     *
     * @returns {Object|null} Parsed action_data, or null when not launched by a tile
     * @private
     */
    _readPayload() {
        try {
            const reqControl = tizen.application.getCurrentApplication().getRequestedAppControl();
            const entry = reqControl?.appControl.data.find((item) => item.key === 'PAYLOAD');
            if (!entry) return null;

            /* The outer JSON wraps the action_data inside a 'values' string. */
            const actionData = JSON.parse(JSON.parse(entry.value[0]).values);
            log.info('Deep link payload received:', JSON.stringify(actionData));

            if (!actionData.id) {
                log.warn('Deep link payload has no item ID — ignoring');
                return null;
            }
            return actionData;
        } catch (e) {
            log.error('Deep link payload could not be read:', e);
            return null;
        }
    }

    /**
     * Cold start: resolve the tile that launched Litefin before the router
     * starts, so the default route can open it instead of /home (no Home flash)
     * or hold it while the profile picker is shown.
     *
     * @returns {Promise<void>}
     * @private
     */
    async _prepareStartupDeepLink() {
        /* Samsung hands the launching tile to every page load of the same app
         * instance, so Litefin's own reloads (settings changes, a profile switch
         * with per-user settings) would replay it. sessionStorage survives those
         * reloads but not a new launch; only a target stored for the reload counts. */
        let reloaded = false;
        let reloadTarget = null;
        try {
            reloaded = sessionStorage.getItem(BOOT_MARKER_KEY) === '1';
            sessionStorage.setItem(BOOT_MARKER_KEY, '1');
            reloadTarget = sessionStorage.getItem(RELOAD_TARGET_KEY);
            sessionStorage.removeItem(RELOAD_TARGET_KEY);
        } catch (e) {
            log.warn('sessionStorage unavailable — cannot tell reloads from tile launches:', e?.message || e);
        }
        let actionData = null;
        if (reloaded) {
            try {
                actionData = reloadTarget ? JSON.parse(reloadTarget) : null;
            } catch (_) {}
        } else {
            actionData = this._readPayload();
        }
        if (!actionData) return;
        this._pendingDeepLink = await this._preparePending(actionData);
    }

    /**
     * Open the cold-start tile. Called by the default route in place of its
     * /home navigation once no profile picker is needed. A tile from another
     * profile's row shows the profile picker instead (held until a choice).
     *
     * @returns {boolean} True when the tile took over the initial navigation
     */
    openStartupTarget() {
        if (!this._pendingDeepLink) return false;
        if (this._pendingDeepLink.owner !== auth.getCurrentUser()?.Id) {
            log.info('Initial route: Smart Hub tile belongs to another profile — showing profile picker');
            router.navigate('/profiles', { replace: true });
            return true;
        }
        const pending = this._pendingDeepLink;
        this._pendingDeepLink = null;
        log.info('Initial route: opening Smart Hub tile target');
        this._openPending(pending);
        return true;
    }

    /**
     * Warm start: a tile was clicked while Litefin was running.
     *
     * The target is opened directly, unless a profile still has to be chosen
     * (profile picker open, a PIN-locked profile not unlocked this run, or the
     * tile belongs to another profile's row); then it is held and opened by the
     * auth:login handler.
     *
     * @see https://developer.samsung.com/smarttv/develop/guides/smart-hub-preview/
     */
    handleDeepLink() {
        if (!this._ready) return;
        const actionData = this._readPayload();
        if (!actionData) return;

        /* Samsung delivers the tile before the app is visible again. App's resume
         * handling (e.g. "show profiles when returning to app") runs on app:visible
         * and must come first, otherwise it replaces the tile's page. */
        const appVisible = new Promise((resolve) => {
            if (!document.hidden) return resolve();
            const timer = setTimeout(() => {
                unsubscribe();
                resolve();
            }, VISIBLE_WAIT_MS);
            const unsubscribe = eventBus.once('app:visible', () => {
                clearTimeout(timer);
                // Next tick: the resume handler navigates synchronously after emitting
                setTimeout(resolve, 0);
            });
        });

        Promise.all([this._preparePending(actionData), appVisible]).then(([pending]) => {
            const userId = auth.getCurrentUser()?.Id;
            const pinLocked = userId && pinManager.hasPin(userId) && !this._unlocked;
            const onPicker = router.getCurrentPath() === '/profiles';

            if (pinLocked || onPicker || pending.owner !== userId) {
                log.info('Deep link held until a profile is chosen');
                this._pendingDeepLink = pending;
                if (!onPicker) router.navigate('/profiles', { replace: true });
                return;
            }
            this._openPending(pending);
        });
    }

    /**
     * Build a pending tile. Tiles carry the profile that owns the row (older
     * tiles fall back to the active profile). The episode is only looked up
     * for the owner; another active profile has to choose a profile first.
     *
     * @param {Object} actionData - Tile action_data
     * @returns {Promise<Object>} Pending tile (see _pendingDeepLink)
     * @private
     */
    async _preparePending(actionData) {
        const activeUserId = auth.getCurrentUser()?.Id;
        const owner = actionData.uid || activeUserId;
        if (owner !== activeUserId) {
            return { actionData, owner, target: null, resolvedFor: null };
        }
        return { actionData, owner, target: await this._resolveTarget(actionData), resolvedFor: activeUserId };
    }

    /**
     * Open a pending tile's details page, looking it up again when it was
     * resolved for another profile than the active one (e.g. before the profile
     * choice). /home is the only Back step (Samsung Return Key Policy: Back
     * stays inside Litefin).
     *
     * @param {Object} pending - Pending tile (see _pendingDeepLink)
     * @returns {Promise<void>}
     * @private
     */
    async _openPending(pending) {
        let target = pending.target;
        if (!target || pending.resolvedFor !== auth.getCurrentUser()?.Id) {
            target = await this._resolveTarget(pending.actionData);
        }
        router.setHistory(['/home']);
        router.navigate(`/details/${target.id}`);
    }

    /**
     * Turn tile action_data into the details page to open. Series tiles (and
     * episode tiles still cached by the TV) resolve to the series' current
     * Continue Watching / Next Up episode, so a stale Smart Hub row never opens
     * an outdated episode. Movies are returned unchanged.
     *
     * @param {{ id: string, type?: string, seriesid?: string }} actionData
     * @returns {Promise<{ id: string, type?: string }>} Never rejects
     * @private
     */
    async _resolveTarget(actionData) {
        const seriesId = actionData.type === 'series' ? actionData.id : actionData.seriesid;
        if (!seriesId || (actionData.type !== 'series' && actionData.type !== 'episode')) return actionData;
        if (state.get('server:offline') || !state.get('user:authenticated')) return actionData;

        try {
            const episode = await Promise.race([
                this._resolveSeriesEpisode(seriesId),
                new Promise((resolve, reject) => setTimeout(() => reject(new Error('timeout')), RESOLVE_TIMEOUT_MS))
            ]);
            // Nothing left to watch — open the series itself
            const target = episode ? { id: episode.Id, type: 'episode' } : { id: seriesId, type: 'series' };
            log.info(`Series deep link resolved to ${target.type} ${target.id}`);
            return target;
        } catch (e) {
            // Keep the tile's own target (series page, or the cached tile's episode)
            log.warn('Could not resolve series deep link — opening tile target:', e?.message || e);
            return actionData;
        }
    }

    /**
     * Find the episode a series tile should open now: the series' Continue
     * Watching episode or its Next Up episode, whichever was active most
     * recently — the same rule the merged row is ordered by.
     *
     * @param {string} seriesId
     * @returns {Promise<Object|null>} Episode item, or null when neither exists
     * @private
     */
    async _resolveSeriesEpisode(seriesId) {
        const [resumeRes, nextUpRes] = await Promise.all([
            api.getResumeItems({ ParentId: seriesId, Limit: 1 }),
            // Emby's /Shows/NextUp ignores SeriesId
            api.isEmby() ? null : api.getNextUp({ SeriesId: seriesId, Limit: 1 })
        ]);

        const resume = resumeRes?.Items?.[0];
        const nextUp = nextUpRes?.Items?.[0];
        if (resume && nextUp && resume.Id !== nextUp.Id) {
            const lastWatched = await getSeriesLastWatchedDates([seriesId]);
            const resumePlayed = new Date(resume.UserData?.LastPlayedDate || 0).getTime();
            return resumePlayed >= (lastWatched[seriesId] || 0) ? resume : nextUp;
        }
        return resume || nextUp || null;
    }

    /**
     * Fetch fresh Jellyfin data and push it to the Samsung Smart Hub.
     *
     * Concurrent calls are debounced — if an update is already in progress,
     * the new call returns immediately without starting a duplicate fetch.
     *
     * @returns {Promise<void>}
     */
    async update() {
        /* Guard against concurrent runs (exit-time race with the timer). */
        // If an update process is already active, ignore this request to avoid
        // concurrent overlapping fetches on slow hardware.
        if (this._updating) {
            log.debug('Update already running — debounced');
            return;
        }

        /* Skip if no active auth session exists yet. */
        // Smart Hub updates require access token and user credentials to query the server
        if (!state.get('user:authenticated')) {
            log.debug('Not authenticated — skipping Smart Hub update');
            return;
        }

        /* Skip if video playback is actively running to prevent network/IPC contention on TV NIC */
        if (this._isPlaying) {
            log.info('Video playback is actively running — deferring Smart Hub update');
            return;
        }

        /* Never run while the user is navigating or scrolling. The service
         * spawn (tizen.application.launchAppControl) plus JSON fetch decoding
         * can preempt the WebKit main thread for over a second on legacy TVs. */
        if (idleGate.isUserActive(USER_ACTIVITY_IDLE_MS)) {
            log.info('User is active — deferring Smart Hub update until idle');
            this._scheduleIdleUpdate();
            return;
        }

        // Lock the updating process
        this._updating = true;

        try {
            log.info('Starting Smart Hub data fetch...');
            let mergedItems = [];

            // ─── Phase 1: Try server-side Litefin plugin first ─────────────────
            // ─── Phase 1: Server-side pre-merged row fetching ──────────────────
            // Parse configured Next Up max days filter from preferences, defaulting to 365
            const maxDays = parseInt(storage.getItem('pref:nextUpMaxDays'), 10);
            const daysLimit = isNaN(maxDays) ? 365 : maxDays;
            // Ask the plugin for the same number of items as the merged home row so it
            // selects the same candidates; the Smart Hub then shows the first 10 series/movies.
            const homeRowLimit = parseInt(storage.getItem('pref:homeRowsLimit') || 12, 10);
            const mergedParams = { limit: Math.max(10, homeRowLimit) };

            // Retrieve configured mark as watched threshold fraction and percentage
            const thresholdFraction = PlayerSettings.getWatchedThresholdFraction();
            const watchedThresholdPct = Math.round(thresholdFraction * 100);

            // Pass watched threshold percentage to server companion plugin query parameters
            mergedParams.watchedThreshold = watchedThresholdPct;

            // Compute cutoff timestamp if a positive days limit constraint is defined
            let cutoffIso = null;
            if (daysLimit > 0) {
                const cutoff = new Date();
                cutoff.setDate(cutoff.getDate() - daysLimit);
                cutoffIso = cutoff.toISOString();
                // Supply cutoff to server companion plugin query parameters
                mergedParams.nextUpDateCutoff = cutoffIso;
                mergedParams.NextUpDateCutoff = cutoffIso;
            }

            // Query the custom endpoint provided by our Litefin plugin.
            // When using the plugin, we fetch the home row's number of pre-merged,
            // deduplicated, and chronologically sorted items; _buildPreviewJson keeps the first 10.
            try {
                log.info('Attempting to fetch pre-merged continue/next-up items from Litefin plugin');
                const response = await api.getMergedRows(mergedParams);
                if (response && response.Items && response.Items.length > 0) {
                    // Filter out container items and finished/watched items defensively
                    const validPluginItems = response.Items.filter((item) => {
                        // Exclude invalid items and container folders
                        if (!item || item.Type === 'Season' || item.Type === 'Series' || item.IsFolder) {
                            return false;
                        }

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
                    });

                    if (validPluginItems.length > 0) {
                        log.info('Successfully fetched merged items from server-side Litefin plugin');
                        mergedItems = validPluginItems;
                    }
                }
            } catch (err) {
                // Plugin is not installed or returned an error; fallback to client-side logic
                log.warn('Litefin plugin endpoint failed or not installed. Falling back to client-side merge:', err);
            }

            // ─── Phase 2: Fallback to client-side merging (10 and 10) ───────────
            // If the server-side plugin didn't return any items, we perform
            // a client-side merge by fetching 10 resume items and 10 next-up items,
            // then keep the 10 most recent series/movies — same approach as the home row merge,
            // so an uneven split (e.g. 7 resume, 3 next-up) is still accurate.
            if (mergedItems.length === 0) {
                log.info('Falling back to client-side merge (10 and 10 items)');

                // Fetch both lists in parallel to minimize network roundtrips
                const [resumeRes, nextUpRes] = await Promise.all([
                    api.getResumeItems({
                        Limit: 10,
                        ImageTypeLimit: 1,
                        EnableImageTypes: 'Primary,Backdrop,Thumb',
                        EnableTotalRecordCount: false
                    }),
                    (async () => {
                        const params = {
                            Limit: 10,
                            ImageTypeLimit: 1,
                            EnableImageTypes: 'Primary,Backdrop,Thumb',
                            EnableTotalRecordCount: false
                        };

                        // Apply the cutoff date constraint if configured
                        if (cutoffIso) {
                            params.NextUpDateCutoff = cutoffIso;
                        }
                        return api.getNextUp(params);
                    })()
                ]);

                // Map items and tag them so we can distinguish them during sorting.
                // Filter out container items and finished/watched items defensively.
                const resumeItems = (resumeRes?.Items || [])
                    .filter((item) => {
                        // Drop invalid items and container folders
                        if (!item || item.Type === 'Season' || item.Type === 'Series' || item.IsFolder) {
                            return false;
                        }

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
                        if (!item || item.Type === 'Season' || item.Type === 'Series' || item.IsFolder) return false;

                        // Filter out next-up items that have already been partially played,
                        // as they will already be included in the continue watching list.
                        const position = item.UserData?.PlaybackPositionTicks || 0;
                        return position === 0;
                    })
                    .map((item) => ({
                        ...item,
                        _isResume: false
                    }));

                // Rank next-up items the way Jellyfin's own Next Up (and the Litefin plugin)
                // does: by when the furthest-watched episode was played, so rewatching an
                // earlier episode does not move the series up.
                const seriesLastPlayedMap = await getSeriesLastWatchedDates(nextUpItems.map((item) => item.SeriesId));

                // Combine both lists and remove duplicate entries by ID
                const combined = [...resumeItems, ...nextUpItems];
                const seen = new Set();
                const deduplicated = combined.filter((item) => {
                    if (seen.has(item.Id)) return false;
                    seen.add(item.Id);
                    return true;
                });

                // Chronologically sort the merged items to match Plex-style layout
                deduplicated.sort((a, b) => {
                    let timeA = 0;
                    if (a._isResume && a.UserData?.LastPlayedDate) {
                        timeA = new Date(a.UserData.LastPlayedDate).getTime();
                    } else if (a.SeriesId && seriesLastPlayedMap[a.SeriesId]) {
                        timeA = seriesLastPlayedMap[a.SeriesId];
                    } else if (a.UserData?.LastPlayedDate) {
                        timeA = new Date(a.UserData.LastPlayedDate).getTime();
                    } else {
                        timeA = new Date(a.DateCreated || 0).getTime();
                    }

                    let timeB = 0;
                    if (b._isResume && b.UserData?.LastPlayedDate) {
                        timeB = new Date(b.UserData.LastPlayedDate).getTime();
                    } else if (b.SeriesId && seriesLastPlayedMap[b.SeriesId]) {
                        timeB = seriesLastPlayedMap[b.SeriesId];
                    } else if (b.UserData?.LastPlayedDate) {
                        timeB = new Date(b.UserData.LastPlayedDate).getTime();
                    } else {
                        timeB = new Date(b.DateCreated || 0).getTime();
                    }

                    return timeB - timeA;
                });

                mergedItems = deduplicated;
            }

            /* Build the Samsung-schema JSON from the merged items list. */
            const previewJson = this._buildPreviewJson(mergedItems);

            /* Cache in memory so future callers can inspect last-known state. */
            this._cachedJson = previewJson;

            /* Log a human-readable summary at INFO level so the tile content is
             * always visible in device logs — no debug mode required. */
            const sectionSummary = previewJson.sections
                .map((s) => `"${s.title}" #${s.position} (${s.tiles.length} tile${s.tiles.length !== 1 ? 's' : ''})`)
                .join(', ');
            log.info(`Preview JSON built — sections: [${sectionSummary || 'EMPTY — nothing to show'}]`);

            /* Dispatch the JSON to the ytresolver background service and
             * wait for its ACK before releasing the updating guard. */
            await this._sendToService(previewJson);

            log.info('Smart Hub update complete');
        } catch (e) {
            log.error('Smart Hub update failed:', e.message || e);
        } finally {
            /* Always release the guard — never leave the manager in a stuck state. */
            this._updating = false;
        }
    }

    // ========================================================================
    // Private — Refresh Cycle
    // ========================================================================

    /**
     * Arms a single idle-gated retry for update(). Called when update() is
     * invoked during active navigation; the retry waits for the full 5s quiet
     * window before spawning the resolver service. Repeated update() calls
     * while active reuse the same pending task instead of stacking timers.
     * @private
     */
    _scheduleIdleUpdate() {
        if (this._deferredUpdateTask !== null) return;

        this._deferredUpdateTask = idleGate.runWhenIdle(
            () => {
                this._deferredUpdateTask = null;
                if (this._ready) this.update();
            },
            USER_ACTIVITY_IDLE_MS,
            0
        );
    }

    /**
     * Start the periodic update cycle.
     *
     * Uses a cooperative setTimeout chain rather than setInterval so each
     * update waits for the previous one to fully complete before the next
     * is scheduled. On slow hardware this prevents back-to-back stacking.
     *
     * @private
     */
    _startRefreshCycle() {
        /* Cancel any previous cycle before starting fresh — prevents duplicate
         * timers if auth:login fires while a cycle is already running. */
        this._stopRefreshCycle();

        if (!this._ready) return;

        this._cycleActive = true;
        log.info('Refresh cycle started (10-min interval)');

        /*
         * The runCycle function calls update(), then schedules itself again
         * only if the cycle is still active (_cycleActive not cleared by logout).
         * The REFRESH_INTERVAL_MS wait starts from when the update FINISHED,
         * which is the correct behaviour — we don't want to under-count time
         * on slow hardware.
         */
        const runCycle = async () => {
            await this.update();

            /* Do NOT re-schedule if auth:logout cleared the flag mid-update. */
            if (this._cycleActive) {
                this._refreshTimer = setTimeout(runCycle, REFRESH_INTERVAL_MS);
            }
        };

        /* Fire the first update immediately (delay=0 schedules it after the
         * current call stack unwinds, avoiding blocking the init path). */
        this._refreshTimer = setTimeout(runCycle, 0);
    }

    /**
     * Stop the periodic update cycle and cancel any pending timer.
     * Safe to call when no cycle is running (idempotent).
     * @private
     */
    _stopRefreshCycle() {
        this._cycleActive = false;

        let stopped = false;

        if (this._refreshTimer !== null) {
            clearTimeout(this._refreshTimer);
            this._refreshTimer = null;
            stopped = true;
        }

        // A deferred update may be parked waiting for the UI to go idle.
        if (this._deferredUpdateTask !== null) {
            idleGate.cancel(this._deferredUpdateTask);
            this._deferredUpdateTask = null;
            stopped = true;
        }

        if (stopped) {
            log.info('Refresh cycle stopped');
        }
    }

    /**
     * Stop all background activity and cancel every pending timer. Used on
     * logout and by destroy(); safe to call repeatedly. Does not clear the
     * deep-link state or the version-gate flag.
     * @public
     */
    stop() {
        this._stopRefreshCycle();

        if (this._playbackRefreshTimer !== null) {
            clearTimeout(this._playbackRefreshTimer);
            this._playbackRefreshTimer = null;
        }

        if (this._serviceRelaunchTimer !== null) {
            clearTimeout(this._serviceRelaunchTimer);
            this._serviceRelaunchTimer = null;
        }

        if (this._serviceRelaunchTask !== null) {
            idleGate.cancel(this._serviceRelaunchTask);
            this._serviceRelaunchTask = null;
        }

        // An update may be parked waiting to spawn the resolver service, or
        // already waiting on its ACK. Cancel the task and settle the promise
        // so a stopped manager can never leave update() awaiting forever.
        if (this._serviceDispatchTask !== null) {
            idleGate.cancel(this._serviceDispatchTask);
            this._serviceDispatchTask = null;
        }
        if (this._serviceDispatchResolve) {
            this._serviceDispatchResolve();
        }

        log.info('Smart Hub background activity stopped');
    }

    /**
     * Full teardown. Cancels pending work and prevents future idle-gated
     * updates from running.
     * @public
     */
    destroy() {
        this.stop();
        this._ready = false;
    }

    // ========================================================================
    // Private — Data Building
    // ========================================================================

    /**
     * Build the full Samsung Smart Hub Preview JSON from raw Jellyfin items.
     *
     * Output schema: { sections: [{ title: string, tiles: TileObject[] }] }
     * Sections with zero valid tiles are omitted entirely.
     *
     * @param {Object[]} mergedItems - List of merged Continue Watching and Next Up items
     * @returns {{ sections: Object[] }}
     * @private
     */
    _buildPreviewJson(mergedItems) {
        // Prepare list of sections to return to Samsung Smart Hub
        const sections = [];

        /* ── Dedicated Section per Item ──────────────────────────────────
         * Create an individual section for each item in the chronologically
         * sorted list. For TV episodes, the section title is set to the SeriesName
         * (e.g. "Hell's Paradise"), and for movies it is set to the Movie Name
         * (e.g. "Ex Machina"). This guarantees that the items appear in their exact
         * sorted section order on the TV home screen UI.
         * A series gets one section: its first (most recent) item. */
        const seenSeries = new Set();
        for (const item of mergedItems) {
            if (sections.length >= MAX_TILES) break;
            if (item.Type === 'Episode' && seenSeries.has(item.SeriesId)) continue;

            // Build the Samsung tile object for the item
            const tile = this._buildTile(item);

            // Skip items that cannot be represented cleanly (e.g., missing thumbnail)
            if (!tile) continue;
            if (item.Type === 'Episode') seenSeries.add(item.SeriesId);

            // Determine the section title based on media semantics
            // TV episodes use the parent series name; Movies use their own title
            const sectionTitle =
                item.Type === 'Episode' && item.SeriesName ? item.SeriesName : item.Name || 'Continue Watching';

            // Add a dedicated section containing this item's tile.
            // Samsung only guarantees section order when 'position' is set
            // ("sections are shown in ascending position order"); without it
            // the home screen applies its own, cache-dependent ordering.
            sections.push({
                title: sectionTitle,
                position: sections.length + 1,
                tiles: [{ ...tile, position: 1 }]
            });
        }

        return { sections };
    }

    /**
     * Convert a single Jellyfin BaseItemDto to a Samsung tile object.
     *
     * Returns null for items we cannot represent cleanly (missing image,
     * unsupported type). Null entries are filtered by _buildPreviewJson.
     *
     * @param {Object} item - Jellyfin BaseItemDto
     * @returns {Object|null} Samsung tile object
     * @private
     */
    _buildTile(item) {
        if (!item?.Id) return null;

        /* Pick the best 16:9-friendly image for this tile (series artwork for episodes). */
        const imgUrl = (item.Type === 'Episode' && this._getSeriesImageUrl(item)) || this._getTileImageUrl(item);
        if (!imgUrl) return null;

        /* action_data is embdded in every tile. handleDeepLink() parses it when
         * the user taps the tile on the TV home screen. */
        const actionData = {
            id: item.Id,
            type: (item.Type || '').toLowerCase(),
            // Owner of the row: after a profile choice the tile only opens for this profile
            uid: api.userId
        };

        if (item.Type === 'Episode') {
            if (!item.SeriesId) return null;

            /* Series tile: the episode is resolved when the tile is opened
             * (_resolveTarget), so a stale row never points at an old episode. */
            return {
                title: item.SeriesName || '',
                image_ratio: '16by9',
                image_url: imgUrl,
                action_data: JSON.stringify({ id: item.SeriesId, type: 'series', uid: actionData.uid }),
                is_playable: true
            };
        }

        if (item.Type === 'Movie') {
            return {
                title: item.Name || '',
                image_ratio: '16by9',
                image_url: imgUrl,
                action_data: JSON.stringify(actionData),
                is_playable: true
            };
        }

        /* Skip anything else (Seasons, BoxSets, etc.) */
        log.debug(`Skipping unsupported type for Smart Hub tile: ${item.Type}`);
        return null;
    }

    /**
     * 16:9 series artwork for a series tile built from an episode: the series
     * Thumb (own field on Emby, inherited parent Thumb on Jellyfin), else the
     * series Backdrop. Null when the series has neither, so the
     * caller falls back to _getTileImageUrl().
     *
     * @param {Object} item - Episode BaseItemDto
     * @returns {string|null} Fully qualified image URL or null
     * @private
     */
    _getSeriesImageUrl(item) {
        const options = { maxWidth: 480, quality: 90 };
        if (item.SeriesId && item.SeriesThumbImageTag) {
            return api.getImageUrl(item.SeriesId, 'Thumb', { ...options, tag: item.SeriesThumbImageTag });
        }
        // Jellyfin sends the series Thumb as the inherited parent Thumb
        if (item.ParentThumbItemId && item.ParentThumbImageTag) {
            return api.getImageUrl(item.ParentThumbItemId, 'Thumb', { ...options, tag: item.ParentThumbImageTag });
        }
        if (item.ParentBackdropItemId && item.ParentBackdropImageTags?.length) {
            return api.getImageUrl(item.ParentBackdropItemId, 'Backdrop', {
                ...options,
                tag: item.ParentBackdropImageTags[0]
            });
        }
        return null;
    }

    /**
     * Pick the best available image for a Smart Hub tile and return its URL.
     *
     * Priority (16:9 aspect ratio preferred since Samsung tiles are 16:9):
     *   Thumb (own) → Thumb (series) → Thumb (parent)
     *   → Backdrop (own) → Backdrop (parent)
     *   → Primary (own) → Primary (series) → Primary (parent/album)
     *
     * Falls back to null if no image can be found — the tile is then skipped.
     *
     * @param {Object} item - Jellyfin BaseItemDto
     * @returns {string|null} Fully qualified image URL or null
     * @private
     */
    _getTileImageUrl(item) {
        /* Unwrap Live TV programme info wrapper if present. */
        const src = item.ProgramInfo || item;

        let imgType = null;
        let imgTag = null;
        let itemId = src.Id;

        /* ── 16:9 candidates ─────────────────────────────────────────────── */
        if (src.ImageTags?.Thumb) {
            imgType = 'Thumb';
            imgTag = src.ImageTags.Thumb;
        } else if (src.SeriesThumbImageTag) {
            imgType = 'Thumb';
            imgTag = src.SeriesThumbImageTag;
            itemId = src.SeriesId;
        } else if (src.ParentThumbItemId && src.ParentThumbImageTag) {
            imgType = 'Thumb';
            imgTag = src.ParentThumbImageTag;
            itemId = src.ParentThumbItemId;
        } else if (src.BackdropImageTags?.length) {
            imgType = 'Backdrop';
            imgTag = src.BackdropImageTags[0];
        } else if (src.ParentBackdropItemId && src.ParentBackdropImageTags?.length) {
            imgType = 'Backdrop';
            imgTag = src.ParentBackdropImageTags[0];
            itemId = src.ParentBackdropItemId;

            /* ── Portrait fallback ───────────────────────────────────────────── */
        } else if (src.ImageTags?.Primary) {
            imgType = 'Primary';
            imgTag = src.ImageTags.Primary;
        } else if (src.SeriesPrimaryImageTag) {
            imgType = 'Primary';
            imgTag = src.SeriesPrimaryImageTag;
            itemId = src.SeriesId;
        } else if (src.PrimaryImageTag) {
            imgType = 'Primary';
            imgTag = src.PrimaryImageTag;
            itemId = src.PrimaryImageItemId || src.Id;
        } else if (src.ParentPrimaryImageTag) {
            imgType = 'Primary';
            imgTag = src.ParentPrimaryImageTag;
            itemId = src.ParentPrimaryImageItemId || src.Id;
        } else if (src.AlbumId && src.AlbumPrimaryImageTag) {
            imgType = 'Primary';
            imgTag = src.AlbumPrimaryImageTag;
            itemId = src.AlbumId;
        }

        if (!imgType || !imgTag || !itemId) return null;

        /* Delegate URL construction to ApiClient.getImageUrl() — this keeps
         * server base URL handling, auth token embedding, and query building
         * consistent with the rest of the app. 480px wide at q90 is plenty
         * for TV home screen thumbnails without inflating tile load time. */
        return api.getImageUrl(itemId, imgType, {
            maxWidth: 480,
            quality: 90,
            tag: imgTag
        });
    }

    // ========================================================================
    // Private — Service Communication
    // ========================================================================

    /**
     * Send the Smart Hub JSON to the ytresolver background service and wait
     * for its acknowledgement.
     *
     * Flow:
     *   1. Register a named MessagePort ('SmartHubAck') on this application.
     *   2. Launch the ytresolver service via ApplicationControl, passing the
     *      JSON as 'SmartHubPreview' AppControl data.
     *   3. The service's onRequest handler calls webapis.preview.setPreviewData()
     *      and, on success, exits ~0.5 s later (Samsung only commits preview
     *      tiles once the service process terminates).
     *   4. Before exiting, the service sends an ACK to 'SmartHubAck'.
     *   5. Resolve on ACK or after SERVICE_TIMEOUT_MS — never block indefinitely.
     *      Either way, _relaunchService() restarts the service 3 s later so the
     *      trailer/discovery HTTP proxy keeps working.
     *
     * The actual launchAppControl() is idle-gated: on legacy Tizen panels the
     * service process spawn can stall the WebKit main thread for over a second,
     * so it must never preempt a D-pad scroll. The ACK timeout starts only once
     * the launch has been attempted, not while the request is parked.
     *
     * @param {Object} json - Samsung Preview JSON
     * @returns {Promise<void>}
     * @private
     */
    _sendToService(json) {
        return new Promise((resolve) => {
            const packageId = tizen.application.getCurrentApplication().appInfo.packageId;
            const serviceId = packageId + '.ytresolver';

            /* Shared state for the cleanup function below. */
            let localPort = null;
            let listenerId = null;
            let timeoutHandle = null;
            let settled = false;

            /*
             * Cleanup is idempotent — safe to call from multiple paths
             * (timeout, ACK received, service launch failure).
             * Removes the port listener and clears the safety timeout.
             */
            const cleanup = () => {
                if (timeoutHandle !== null) {
                    clearTimeout(timeoutHandle);
                    timeoutHandle = null;
                }
                if (localPort !== null && listenerId !== null) {
                    try {
                        localPort.removeMessagePortListener(listenerId);
                    } catch (_) {}
                    listenerId = null;
                }
            };

            /*
             * Idempotent completion. Every exit path (ACK, timeout, launch
             * failure, stop()) funnels through here so the promise can only be
             * resolved once and the pending-dispatch guard is always cleared.
             */
            const finish = () => {
                if (settled) return;
                settled = true;
                this._serviceDispatchResolve = null;
                cleanup();
                resolve();
            };

            /* Allows stop()/destroy() to settle an in-flight dispatch. */
            this._serviceDispatchResolve = finish;

            /* ── Step 1: Open local MessagePort for ACK ──────────────────── */
            try {
                /*
                 * requestLocalMessagePort registers a named port ON THIS app.
                 * The service finds it by calling:
                 *   tizen.messageport.requestRemoteMessagePort(appId, ACK_PORT_NAME)
                 */
                localPort = tizen.messageport.requestLocalMessagePort(ACK_PORT_NAME);
                listenerId = localPort.addMessagePortListener((msgData) => {
                    if (settled) return;
                    const status = msgData?.[0]?.value || 'unknown';
                    log.info('Smart Hub service ACK:', status);
                    finish();
                    this._relaunchService(serviceId);
                });
            } catch (e) {
                /* MessagePort unavailable (e.g. browser dev mode) — skip ACK
                 * and let the launch proceed without waiting for confirmation. */
                log.error('Could not open local MessagePort:', e.message);
                finish();
                return;
            }

            /* ── Step 2: Launch the ytresolver service when the UI is idle ─ */
            this._serviceDispatchTask = idleGate.runWhenIdle(
                () => {
                    this._serviceDispatchTask = null;
                    if (settled) return;

                    /* Safety timeout — guards against the service crashing
                     * silently or the ACK never arriving on misbehaving
                     * hardware. Armed here so idle deferral does not consume
                     * the ACK window. */
                    timeoutHandle = setTimeout(() => {
                        if (settled) return;
                        log.warn(`Smart Hub ACK timed out after ${SERVICE_TIMEOUT_MS / 1000}s — continuing`);
                        finish();
                        this._relaunchService(serviceId);
                    }, SERVICE_TIMEOUT_MS);

                    try {
                        tizen.application.launchAppControl(
                            new tizen.ApplicationControl(
                                'http://tizen.org/appcontrol/operation/pick',
                                null,
                                'image/jpeg',
                                null,
                                /* Embed the preview JSON as a single ApplicationControlData entry.
                                 * The service reads this key inside its onRequest handler. */
                                [new tizen.ApplicationControlData('SmartHubPreview', [JSON.stringify(json)])]
                            ),
                            serviceId,
                            () => log.info('Smart Hub data dispatched to ytresolver service'),
                            (err) => {
                                log.error('Service launch failed:', err?.message || err);
                                finish(); /* Don't block the refresh cycle on a failing service. */
                            }
                        );
                    } catch (e) {
                        log.error('Exception during service launch:', e.message);
                        finish();
                    }
                },
                USER_ACTIVITY_IDLE_MS,
                0
            );
        });
    }

    /**
     * Relaunch the ytresolver service after it exits to commit preview data,
     * so the trailer/discovery HTTP proxy on localhost:8123 comes back.
     * Launching an already-running service is harmless — but process creation
     * is expensive on legacy Tizen panels, so it is deferred until the user
     * has stopped interacting or scrolling.
     *
     * @param {string} serviceId - Full service application ID
     * @private
     */
    _relaunchService(serviceId) {
        /* Drop a previous request: another ACK already superseded it. */
        if (this._serviceRelaunchTimer !== null) {
            clearTimeout(this._serviceRelaunchTimer);
            this._serviceRelaunchTimer = null;
        }
        if (this._serviceRelaunchTask !== null) {
            idleGate.cancel(this._serviceRelaunchTask);
            this._serviceRelaunchTask = null;
        }

        /* 3 s comfortably covers the service's 500 ms exit delay plus process
         * teardown; relaunching while it is still alive would be a no-op and
         * leave the proxy down once it exits. */
        this._serviceRelaunchTimer = setTimeout(() => {
            this._serviceRelaunchTimer = null;

            if (!this._ready) return;

            this._serviceRelaunchTask = idleGate.runWhenIdle(
                () => {
                    this._serviceRelaunchTask = null;
                    if (!this._ready) return;
                    this._launchResolverService(serviceId);
                },
                USER_ACTIVITY_IDLE_MS,
                0
            );
        }, SERVICE_RELAUNCH_DELAY_MS);
    }

    /**
     * Performs the actual tizen.application.launch() for the resolver service.
     * Split out so the idle gate owns all scheduling and cancellation.
     * @param {string} serviceId - Full service application ID
     * @private
     */
    _launchResolverService(serviceId) {
        try {
            tizen.application.launch(
                serviceId,
                () => log.info('ytresolver service relaunched after preview commit'),
                (e) => log.warn('Service relaunch failed:', e?.message || e)
            );
        } catch (e) {
            log.warn('Service relaunch threw:', e.message);
        }
    }
}

/* ============================================================================
 * Singleton export — the entire app accesses Smart Hub through one instance.
 * ============================================================================
 */
export const smartHubManager = new SmartHubManager();
export default SmartHubManager;
