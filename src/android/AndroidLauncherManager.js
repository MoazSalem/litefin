/**
 * ============================================================================
 * Litefin - Android Launcher & TV Home Screen Manager
 * ============================================================================
 * Manages native Android launcher integration for the Litefin Android app,
 * providing complete feature parity with Tizen's Smart Hub Preview system:
 *
 * 1. Android TV & Google TV "Play Next" (Watch Next) System Row:
 *    - Surfaces in-progress movies and unwatched TV episodes directly on the
 *      Android TV and Google TV home screen.
 *    - Updates progress indicators, engagement timestamps, and 16:9 backdrop
 *      artwork so content remains up to date.
 *
 * 2. Dedicated Android TV Preview Channels:
 *    - Automatically registers and populates Litefin's dedicated home screen
 *      channel row ("Litefin - Continue Watching").
 *    - Users can browse content tiles directly on the TV launcher without
 *      launching the app first.
 *
 * 3. Mobile & Tablet Dynamic App Shortcuts:
 *    - Surfaces dynamic launcher shortcuts on phones and tablets via Android's
 *      ShortcutManager, allowing quick resume from the home screen icon.
 *
 * 4. Deep Link Navigation & Return Key Policy:
 *    - Handles incoming deep-link intents (litefin://item/{id}).
 *    - Seeds navigation history breadcrumbs (['/home', '/details/{seriesId}'])
 *      so pressing Back returns gracefully to /home rather than exiting to OS.
 *    - Enforces profile PIN gating: prevents deep links from bypassing
 *      PIN-locked profiles until the user enters their security PIN.
 *
 * 5. Cooperative Refresh Cycle:
 *    - Runs every 10 minutes using a cooperative timeout chain.
 *    - Automatically suspends updates during active video playback to avoid
 *      CPU, memory, or network contention.
 *    - Refreshes launcher tiles 2 seconds after playback finishes.
 * ============================================================================
 */

import { api } from '../api/ApiClient.js';
import { auth } from '../api/index.js';
import { eventBus } from '../core/EventBus.js';
import { state } from '../core/StateManager.js';
import { router } from '../core/Router.js';
import { logger } from '../utils/Logger.js';
import { pinManager } from '../utils/PinManager.js';
import { storage } from '../utils/StorageService.js';
import { platformInfo } from '../utils/PlatformInfo.js';
import { getSeriesLastWatchedDates } from '../utils/NextUpActivity.js';

const log = logger.create('AndroidLauncherManager');

// ============================================================================
// Constants
// ============================================================================

/** How often (after a completed update cycle) to push fresh launcher tiles. */
const REFRESH_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

/** Grace period after playback ends before querying Jellyfin server. */
const PLAYBACK_SETTLE_DELAY_MS = 2000; // 2 seconds

// ============================================================================
// AndroidLauncherManager Class
// ============================================================================

class AndroidLauncherManager {
    constructor() {
        /** @type {boolean} - True once init() completes platform verification. */
        this._ready = false;

        /** @type {boolean} - Debounce guard preventing overlapping updates. */
        this._updating = false;

        /** @type {boolean} - True while the periodic refresh cycle is active. */
        this._cycleActive = false;

        /** @type {number|null} - setTimeout identifier for the next cycle. */
        this._refreshTimer = null;

        /**
         * @type {Object|null} - Target held back when active profile is PIN-locked.
         * Replayed immediately once the user unlocks their profile.
         */
        this._pendingDeepLink = null;

        /**
         * @type {boolean} - True once active profile has been unlocked this session.
         */
        this._unlocked = false;

        /**
         * @type {boolean} - True during active media playback to pause background sync.
         */
        this._isPlaying = false;
    }

    // ========================================================================
    // Public Lifecycle API
    // ========================================================================

    /**
     * Initialise the manager. Called from App.init() when running on Android.
     */
    init() {
        // Platform verification gate
        if (!platformInfo.isAndroid) {
            log.debug('Not running on Android platform — launcher manager inactive');
            return;
        }

        this._ready = true;
        log.info('AndroidLauncherManager initialised');

        // Expose instance globally for native bridge callbacks
        if (typeof window !== 'undefined') {
            window.androidLauncherManager = this;
        }

        // ── Cold-Boot Deep Link Inspection ──────────────────────────────────
        // Check if an initial deep-link payload was captured during native launch.
        this._consumeInitialDeepLink();

        // ── Session Lifecycle Hooks ─────────────────────────────────────────
        // If credentials were restored at startup, begin refresh cycle immediately.
        if (state.get('user:authenticated')) {
            log.info('Existing authenticated session found — starting launcher refresh cycle');
            this._startRefreshCycle();
        }

        // Listen for user login / profile switch
        eventBus.on('auth:login', () => {
            // Profile is now actively unlocked by user
            this._unlocked = true;
            this._startRefreshCycle();

            // Replay any held deep link waiting for PIN entry
            if (this._pendingDeepLink) {
                const target = this._pendingDeepLink;
                this._pendingDeepLink = null;
                log.info('Replaying held Android deep link after profile unlock');
                setTimeout(() => this._navigateToItem(target), 0);
            }
        });

        // Listen for user logout
        eventBus.on('auth:logout', () => {
            // Reset security unlock state
            this._unlocked = false;
            this._pendingDeepLink = null;
            this._stopRefreshCycle();

            // Wipe launcher recommendations from OS home screen
            this._clearNativeLauncher();
        });

        // ── Playback Lifecycle Hooks ────────────────────────────────────────
        // Suspend background launcher syncing during video playback to eliminate
        // network and CPU competition with hardware media decoders.
        eventBus.on('player:play', () => {
            this._isPlaying = true;
        });
        eventBus.on('player:playing', () => {
            this._isPlaying = true;
        });

        // When playback completes or stops, schedule a fresh launcher sync.
        const handlePlaybackFinished = () => {
            this._isPlaying = false;
            if (this._cycleActive) {
                log.info(`Playback ended/stopped — scheduling launcher update in ${PLAYBACK_SETTLE_DELAY_MS}ms`);
                setTimeout(() => {
                    if (this._cycleActive && !this._isPlaying) {
                        this.update();
                    }
                }, PLAYBACK_SETTLE_DELAY_MS);
            }
        };

        eventBus.on('player:ended', handlePlaybackFinished);
        eventBus.on('player:stopped', handlePlaybackFinished);
    }

    /**
     * Inspects native host for any pending cold-boot deep links.
     * @private
     */
    _consumeInitialDeepLink() {
        if (typeof window === 'undefined') return;

        let payload = null;

        // Check window temporary global first (set if intent arrived before manager init)
        if (window.__pendingAndroidDeepLink) {
            payload = window.__pendingAndroidDeepLink;
            delete window.__pendingAndroidDeepLink;
        } else if (typeof window.LitefinAndroid?.getInitialDeepLink === 'function') {
            // Query native AndroidBridge interface directly
            try {
                const rawJson = window.LitefinAndroid.getInitialDeepLink();
                if (rawJson) {
                    payload = JSON.parse(rawJson);
                }
            } catch (err) {
                log.warn('Failed parsing cold-launch deep link JSON from Android bridge:', err);
            }
        }

        if (payload && payload.id) {
            log.info('Consuming cold-boot Android deep link:', JSON.stringify(payload));
            this.handleDeepLink(payload);
        }
    }

    // ========================================================================
    // Deep Link Navigation & History Handling
    // ========================================================================

    /**
     * Handles an incoming deep link originating from an Android TV home screen
     * tile, Play Next card, or mobile launcher shortcut.
     *
     * @param {Object} actionData - Target coordinates { id, type, seriesid?, seasonid? }
     */
    handleDeepLink(actionData) {
        if (!this._ready) {
            log.warn('AndroidLauncherManager not ready — deferring deep link');
            if (typeof window !== 'undefined') {
                window.__pendingAndroidDeepLink = actionData;
            }
            return;
        }

        if (!actionData || !actionData.id) {
            log.warn('Deep link payload missing required item ID — skipping navigation');
            return;
        }

        log.info('Handling Android launcher deep link:', JSON.stringify(actionData));

        // ── PIN Security Gate ───────────────────────────────────────────────
        // Prevent home screen tile clicks from bypassing a PIN-protected profile.
        // If active profile has a PIN lock and has not yet been unlocked this run,
        // hold the target and direct the user to the profile selector.
        const activeUserId = auth.getCurrentUser()?.Id;
        if (activeUserId && pinManager.hasPin(activeUserId) && !this._unlocked) {
            log.info('Deep link held — active profile is PIN-locked; routing to profile picker');
            this._pendingDeepLink = actionData;
            router.navigate('/profiles', { replace: true });
            return;
        }

        // Proceed to content navigation
        this._navigateToItem(actionData);
    }

    /**
     * Seeds router navigation stack with home breadcrumbs and routes to details.
     * Follows TV Return Key Policy: Back button returns to /home instead of exiting.
     *
     * @param {{ id: string, type?: string, seriesid?: string }} actionData
     * @private
     */
    _navigateToItem(actionData) {
        // Base breadcrumb history trail starting from main homepage
        const breadcrumbHistory = ['/home'];

        // If deep-link target is an episode, push parent series so Back
        // navigation walks: episode -> series -> home -> exit.
        if (actionData.type === 'episode' && actionData.seriesid) {
            breadcrumbHistory.push(`/details/${actionData.seriesid}`);
        }

        // Seed router internal history stack
        router.setHistory(breadcrumbHistory);

        // Navigate directly to target media details screen
        router.navigate(`/details/${actionData.id}`);
    }

    // ========================================================================
    // Data Fetching & Launcher Updating
    // ========================================================================

    /**
     * Fetches current Continue Watching and Next Up items from Jellyfin and
     * publishes them to Android TV channels, Play Next, and mobile shortcuts.
     *
     * @returns {Promise<void>}
     */
    async update() {
        // Prevent concurrent overlapping updates
        if (this._updating) {
            log.debug('Launcher update currently running — debounced');
            return;
        }

        // Verify active authentication session exists
        if (!state.get('user:authenticated')) {
            log.debug('Not authenticated — skipping Android launcher update');
            return;
        }

        // Suspend updates during video playback
        if (this._isPlaying) {
            log.info('Video playback is actively running — deferring launcher sync');
            return;
        }

        this._updating = true;

        try {
            log.info('Starting Android launcher data fetch...');
            let mergedItems = [];

            // ── Phase 1: Query server-side Litefin companion plugin ─────────
            const maxDays = parseInt(storage.getItem('pref:nextUpMaxDays'), 10);
            const daysLimit = isNaN(maxDays) ? 365 : maxDays;
            const mergedParams = {
                limit: 10,
                fields: 'Overview,SeriesThumbImageTag,ParentThumbImageTag,BackdropImageTags,ParentBackdropImageTags'
            };

            let cutoffIso = null;
            if (daysLimit > 0) {
                const cutoff = new Date();
                cutoff.setDate(cutoff.getDate() - daysLimit);
                cutoffIso = cutoff.toISOString();
                mergedParams.nextUpDateCutoff = cutoffIso;
                mergedParams.NextUpDateCutoff = cutoffIso;
            }

            try {
                log.info('Attempting to fetch pre-merged continue/next-up items from Litefin plugin');
                const response = await api.getMergedRows(mergedParams);
                if (response && response.Items && response.Items.length > 0) {
                    const validPluginItems = response.Items.filter(
                        (item) => item && item.Type !== 'Season' && item.Type !== 'Series' && !item.IsFolder
                    );
                    if (validPluginItems.length > 0) {
                        log.info('Successfully fetched pre-merged items from server companion plugin');
                        mergedItems = validPluginItems.slice(0, 10);
                    }
                }
            } catch (err) {
                log.warn('Litefin companion plugin unavailable, using client-side fallback:', err);
            }

            // ── Phase 2: Client-side merging fallback (5 resume + 5 next up) ─
            if (mergedItems.length === 0) {
                log.info('Executing client-side Continue Watching & Next Up merge');

                // Query resume and next-up endpoints in parallel with Overview explicitly included
                const [resumeRes, nextUpRes] = await Promise.all([
                    api.getResumeItems({
                        Limit: 5,
                        Fields: 'Overview,SeriesThumbImageTag,ParentThumbImageTag,BackdropImageTags,ParentBackdropImageTags,Tags',
                        ImageTypeLimit: 1,
                        EnableImageTypes: 'Primary,Backdrop,Thumb',
                        EnableTotalRecordCount: false
                    }),
                    (async () => {
                        const params = {
                            Limit: 5,
                            Fields: 'Overview,RunTimeTicks,CommunityRating,PremiereDate,IndexNumber,ParentIndexNumber,SeriesThumbImageTag,ParentThumbImageTag,BackdropImageTags,ParentBackdropImageTags,MediaSources,MediaStreams,Width,Height,UserData',
                            ImageTypeLimit: 1,
                            EnableImageTypes: 'Primary,Backdrop,Thumb',
                            EnableTotalRecordCount: false
                        };
                        if (cutoffIso) {
                            params.NextUpDateCutoff = cutoffIso;
                        }
                        return api.getNextUp(params);
                    })()
                ]);

                // Filter and tag resume items
                const resumeItems = (resumeRes?.Items || [])
                    .filter((item) => item && item.Type !== 'Season' && item.Type !== 'Series' && !item.IsFolder)
                    .map((item) => ({ ...item, _isResume: true }));

                // Filter and tag next-up items
                const nextUpItems = (nextUpRes?.Items || [])
                    .filter((item) => {
                        if (!item || item.Type === 'Season' || item.Type === 'Series' || item.IsFolder) return false;
                        const position = item.UserData?.PlaybackPositionTicks || 0;
                        return position === 0;
                    })
                    .map((item) => ({ ...item, _isResume: false }));

                // Rank next-up items the way Jellyfin's own Next Up (and the Litefin plugin)
                // does: by when the furthest-watched episode was played, so rewatching an
                // earlier episode does not move the series up.
                const seriesLastPlayedMap = await getSeriesLastWatchedDates(nextUpItems.map((item) => item.SeriesId));

                // Attach sort timestamps
                const taggedResume = resumeItems.map((item) => ({
                    item,
                    sortTime: item.UserData?.LastPlayedDate ? new Date(item.UserData.LastPlayedDate).getTime() : 0
                }));

                const taggedNextUp = nextUpItems.map((item) => ({
                    item,
                    sortTime: seriesLastPlayedMap[item.SeriesId] || 0
                }));

                // Combine and sort chronologically descending
                const allTagged = [...taggedResume, ...taggedNextUp];
                allTagged.sort((a, b) => b.sortTime - a.sortTime);

                // Deduplicate and cap to 10 items
                const seenIds = new Set();
                for (const entry of allTagged) {
                    if (!seenIds.has(entry.item.Id)) {
                        seenIds.add(entry.item.Id);
                        mergedItems.push(entry.item);
                        if (mergedItems.length >= 10) break;
                    }
                }
            }

            // ── Phase 3: Construct Program DTOs & Dispatch to Native Shell ──
            const programs = [];
            for (const item of mergedItems) {
                const program = this._buildProgram(item);
                if (program) {
                    programs.push(program);
                }
            }

            log.info(`Built ${programs.length} launcher programs for Android native sync`);

            // Dispatch serialized programs to native Android bridge
            this._sendToNativeBridge(programs);

            log.info('Android launcher sync completed successfully');
        } catch (e) {
            log.error('Android launcher update failed:', e.message || e);
        } finally {
            this._updating = false;
        }
    }

    /**
     * Builds a strongly-typed launcher item representation for native consumption.
     *
     * @param {Object} item - Jellyfin BaseItemDto
     * @returns {Object|null}
     * @private
     */
    _buildProgram(item) {
        if (!item?.Id) return null;

        // Select optimal 16:9 thumbnail artwork
        const imgUrl = this._getTileImageUrl(item);
        if (!imgUrl) return null;

        const rawType = (item.Type || '').toLowerCase();

        // Convert Jellyfin ticks (1 tick = 100ns = 0.0001ms) to milliseconds
        const durationMs = item.RunTimeTicks ? Math.floor(item.RunTimeTicks / 10000) : 0;
        const playbackPositionMs = item.UserData?.PlaybackPositionTicks
            ? Math.floor(item.UserData.PlaybackPositionTicks / 10000)
            : 0;

        const isResume = Boolean(item._isResume || playbackPositionMs > 0);

        if (item.Type === 'Episode') {
            const seasonNum = item.ParentIndexNumber ?? item.ProgramInfo?.ParentIndexNumber ?? null;
            const episodeNum = item.IndexNumber ?? item.ProgramInfo?.IndexNumber ?? null;
            const showName = item.SeriesName || item.ProgramInfo?.SeriesName || item.SeriesTitle || '';
            const epName = item.Name || item.ProgramInfo?.Name || '';

            // Format composite title: series name - episode name
            // Season and episode numbering are rendered natively by Android TV from EPG columns
            const titleParts = [];
            if (showName) titleParts.push(showName);
            if (epName) titleParts.push(epName);

            const title = titleParts.length > 0 ? titleParts.join(' - ') : epName || showName || 'Episode';

            // Retrieve synopsis overview of the episode to display in description row
            const description = item.Overview || item.ProgramInfo?.Overview || '';

            return {
                id: item.Id,
                type: rawType,
                title,
                subtitle: description,
                description,
                seriesId: item.SeriesId || null,
                seasonId: item.SeasonId || null,
                seasonNumber: seasonNum,
                episodeNumber: episodeNum,
                imageUrl: imgUrl,
                durationMs,
                playbackPositionMs,
                isResume
            };
        }

        if (item.Type === 'Movie') {
            // Retrieve movie overview or release year fallback
            const description =
                item.Overview || item.ProgramInfo?.Overview || (item.ProductionYear ? String(item.ProductionYear) : '');

            return {
                id: item.Id,
                type: rawType,
                title: item.Name || 'Movie',
                subtitle: description,
                description,
                seriesId: null,
                seasonId: null,
                seasonNumber: null,
                episodeNumber: null,
                imageUrl: imgUrl,
                durationMs,
                playbackPositionMs,
                isResume
            };
        }

        log.debug(`Skipping unsupported media type for launcher program: ${item.Type}`);
        return null;
    }

    /**
     * Resolves the highest quality 16:9 artwork URL for a media item.
     * Follows established priority:
     *   Thumb (own) -> Thumb (series) -> Thumb (parent)
     *   -> Backdrop (own) -> Backdrop (parent)
     *   -> Primary (own) -> Primary (series) -> Primary (parent)
     *
     * @param {Object} item - Jellyfin BaseItemDto
     * @returns {string|null}
     * @private
     */
    _getTileImageUrl(item) {
        const src = item.ProgramInfo || item;

        let imgType = null;
        let imgTag = null;
        let itemId = src.Id;

        // 16:9 landscape options
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
            // Portrait fallbacks
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
        }

        if (!imgType || !imgTag || !itemId) return null;

        // Construct fully-qualified image URL via ApiClient (480px width at q90)
        return api.getImageUrl(itemId, imgType, {
            maxWidth: 480,
            quality: 90,
            tag: imgTag
        });
    }

    /**
     * Forwards serialized launcher programs to native Android bridge.
     * @param {Object[]} programs
     * @private
     */
    _sendToNativeBridge(programs) {
        try {
            if (typeof window !== 'undefined' && typeof window.LitefinAndroid?.updateLauncherPrograms === 'function') {
                const serialized = JSON.stringify(programs);
                window.LitefinAndroid.updateLauncherPrograms(serialized);
                log.info('Dispatched launcher programs to native LitefinAndroid bridge');
            } else {
                log.debug('Native LitefinAndroid.updateLauncherPrograms bridge unavailable in this environment');
            }
        } catch (err) {
            log.warn('Failed dispatching programs to native bridge:', err);
        }
    }

    /**
     * Clears published programs from native Android launcher.
     * @private
     */
    _clearNativeLauncher() {
        try {
            if (typeof window !== 'undefined' && typeof window.LitefinAndroid?.clearLauncherPrograms === 'function') {
                window.LitefinAndroid.clearLauncherPrograms();
                log.info('Invoked native clearLauncherPrograms bridge');
            }
        } catch (err) {
            log.warn('Failed clearing native launcher programs:', err);
        }
    }

    // ========================================================================
    // Cooperative Refresh Cycle
    // ========================================================================

    /**
     * Initiates the cooperative periodic refresh cycle.
     * @private
     */
    _startRefreshCycle() {
        this._stopRefreshCycle();

        if (!this._ready) return;

        this._cycleActive = true;
        log.info('Started cooperative 10-minute Android launcher refresh cycle');

        const runCycle = async () => {
            await this.update();

            // Re-schedule next update only if session remains active
            if (this._cycleActive) {
                this._refreshTimer = setTimeout(runCycle, REFRESH_INTERVAL_MS);
            }
        };

        // Fire first update immediately on next microtask
        this._refreshTimer = setTimeout(runCycle, 0);
    }

    /**
     * Terminates the periodic refresh cycle and cancels any pending timer.
     * @private
     */
    _stopRefreshCycle() {
        this._cycleActive = false;

        if (this._refreshTimer !== null) {
            clearTimeout(this._refreshTimer);
            this._refreshTimer = null;
            log.info('Stopped Android launcher refresh cycle');
        }
    }
}

// Export singleton instance for app-wide use
export const androidLauncherManager = new AndroidLauncherManager();
export default AndroidLauncherManager;
