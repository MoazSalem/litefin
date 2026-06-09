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
import { tizenAdapter } from './TizenAdapter.js';
import { eventBus } from '../core/EventBus.js';
import { state } from '../core/StateManager.js';
import { router } from '../core/Router.js';
import { logger } from '../utils/Logger.js';

const log = logger.create('SmartHubManager');

// ============================================================================
// Constants
// ============================================================================

/* How often (after a completed update) to push a fresh preview. */
const REFRESH_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

/* Tile limits per section — Samsung recommends keeping this small. */
const NEXT_UP_LIMIT = 2;
const RESUME_LIMIT = 4;

/* Named local MessagePort that the ytresolver service sends its ACK to. */
const ACK_PORT_NAME = 'SmartHubAck';

/* Give up waiting for the service ACK after this many milliseconds. */
const SERVICE_TIMEOUT_MS = 15000;

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

        /** @type {Object|null} - Last successfully built preview JSON (in-memory cache). */
        this._cachedJson = null;
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
        // home screen is tapped. We also call it once synchronously in case
        // Litefin was cold-launched by a tile tap (no event fires for the
        // very first app load).
        window.addEventListener('appcontrol', () => this.handleDeepLink());
        this.handleDeepLink();

        // ── Session lifecycle hooks ───────────────────────────────────────
        // If a session was already restored at startup (auth.init() with
        // stored credentials), auth:login never fires — check now.
        if (state.get('user:authenticated')) {
            log.info('Session already active — starting refresh cycle immediately');
            this._startRefreshCycle();
        }

        // Wire into auth events for ongoing session management.
        eventBus.on('auth:login', () => this._startRefreshCycle());
        eventBus.on('auth:logout', () => this._stopRefreshCycle());
    }

    /**
     * Handle an incoming Samsung PAYLOAD deep link.
     *
     * Called on every 'appcontrol' event and once at boot in case Litefin was
     * cold-launched via a Smart Hub tile tap.
     *
     * The AppControl data contains a 'PAYLOAD' key whose first value is:
     *   JSON.stringify({ values: JSON.stringify({ id, type, serverid, seasonid?, seriesid? }) })
     *
     * Navigation strategy (satisfies Samsung's Return Key Policy):
     *   • We first navigate to /home with replace:true so it becomes the
     *     "base" of the browser history stack without loading then re-loading.
     *   • Then navigate to the target details page, which is pushed on top.
     *   • Pressing Back from the details page therefore returns to /home,
     *     keeping the user inside Litefin rather than exiting to the TV UI.
     *
     * @see https://developer.samsung.com/smarttv/develop/guides/smart-hub-preview/
     */
    handleDeepLink() {
        if (!this._ready) return;

        try {
            const reqControl = tizen.application.getCurrentApplication().getRequestedAppControl();
            if (!reqControl) return;

            const data = reqControl.appControl.data;

            for (let i = 0; i < data.length; i++) {
                if (data[i].key !== 'PAYLOAD') continue;

                /* The outer JSON wraps the action_data inside a 'values' string.
                 * We double-parse: outer wrapper → inner action data. */
                const outerPayload = JSON.parse(data[i].value[0]);
                const actionData = JSON.parse(outerPayload.values);

                log.info('Deep link payload received:', JSON.stringify(actionData));

                if (!actionData.id) {
                    log.warn('Deep link payload has no item ID — ignoring');
                    return;
                }

                /* Establish /home as the Back-key destination before navigating
                 * to the content. Use replace:true so the router doesn't record
                 * an empty "previous page" entry before home. */
                router.navigate('/home', { replace: true });

                if (actionData.type === 'episode') {
                    /* For episodes, push the parent series into history so the
                     * user can navigate back up the series → season → episode
                     * hierarchy naturally via the Back key. */
                    if (actionData.seriesid) {
                        router.navigate(`/details/${actionData.seriesid}`);
                    }
                    router.navigate(`/details/${actionData.id}`);
                } else {
                    /* Movies — navigate straight to the details page. */
                    router.navigate(`/details/${actionData.id}`);
                }

                return; // Payload consumed — stop searching data entries.
            }
        } catch (e) {
            log.error('Deep link handling threw an exception:', e);
        }
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
        if (this._updating) {
            log.debug('Update already running — debounced');
            return;
        }

        /* Skip if no active auth session exists yet. */
        if (!state.get('user:authenticated')) {
            log.debug('Not authenticated — skipping Smart Hub update');
            return;
        }

        this._updating = true;

        try {
            log.info('Starting Smart Hub data fetch...');

            /* Run both API calls concurrently — they are fully independent. */
            const [resumeResult, nextUpResult] = await Promise.all([
                api.getResumeItems({
                    Limit: RESUME_LIMIT,
                    ImageTypeLimit: 1,
                    EnableImageTypes: 'Primary,Backdrop,Thumb',
                    EnableTotalRecordCount: false
                }),
                api.getNextUp({
                    Limit: NEXT_UP_LIMIT,
                    ImageTypeLimit: 1,
                    EnableImageTypes: 'Primary,Backdrop,Thumb',
                    EnableTotalRecordCount: false
                })
            ]);

            /* Build the Samsung-schema JSON from the raw Jellyfin items. */
            const previewJson = this._buildPreviewJson(resumeResult?.Items || [], nextUpResult?.Items || []);

            /* Cache in memory so future callers can inspect last-known state. */
            this._cachedJson = previewJson;

            /* Log a human-readable summary at INFO level so the tile content is
             * always visible in device logs — no debug mode required. */
            const sectionSummary = previewJson.sections
                .map((s) => `"${s.title}" (${s.tiles.length} tile${s.tiles.length !== 1 ? 's' : ''})`)
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

        if (this._refreshTimer !== null) {
            clearTimeout(this._refreshTimer);
            this._refreshTimer = null;
            log.info('Refresh cycle stopped');
        }
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
     * @param {Object[]} resumeItems - Items from /Users/{id}/Items/Resume
     * @param {Object[]} nextUpItems - Items from /Shows/NextUp
     * @returns {{ sections: Object[] }}
     * @private
     */
    _buildPreviewJson(resumeItems, nextUpItems) {
        const sections = [];

        /* ── Next Up ──────────────────────────────────────────────────────
         * Shown first — upcoming episodes feel more timely and are the
         * most common entry point after a series marathon. */
        const nextUpTiles = nextUpItems
            .slice(0, NEXT_UP_LIMIT)
            .map((item) => this._buildTile(item))
            .filter(Boolean); /* _buildTile returns null for unsupported types. */

        if (nextUpTiles.length > 0) {
            sections.push({ title: 'Next Up', tiles: nextUpTiles });
        }

        /* ── Continue Watching ───────────────────────────────────────────
         * Mid-progress items go second — they are resumable movies and
         * partially-watched episodes. */
        const resumeTiles = resumeItems
            .slice(0, RESUME_LIMIT)
            .map((item) => this._buildTile(item))
            .filter(Boolean);

        if (resumeTiles.length > 0) {
            sections.push({ title: 'Continue Watching', tiles: resumeTiles });
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

        /* Pick the best 16:9-friendly image for this tile. */
        const imgUrl = this._getTileImageUrl(item);
        if (!imgUrl) return null;

        /* action_data is embdded in every tile. handleDeepLink() parses it when
         * the user taps the tile on the TV home screen. */
        const actionData = {
            id: item.Id,
            type: (item.Type || '').toLowerCase()
        };

        if (item.Type === 'Episode') {
            actionData.seasonid = item.SeasonId;
            actionData.seriesid = item.SeriesId;

            /* Episode label: "S2:E4 - Episode Title" */
            const epPrefix =
                item.ParentIndexNumber != null && item.IndexNumber != null
                    ? `S${item.ParentIndexNumber.toString().padStart(2, '0')}E${item.IndexNumber.toString().padStart(2, '0')} - `
                    : '';

            return {
                title: epPrefix + (item.Name || ''),
                subtitle: item.SeriesName || '',
                image_ratio: '16by9',
                image_url: imgUrl,
                action_data: JSON.stringify(actionData),
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
     *      and then calls exit() (Samsung requires the service to terminate for
     *      the preview to be committed to the Smart Hub display).
     *   4. Before exiting, the service sends an ACK to 'SmartHubAck'.
     *   5. Resolve on ACK or after SERVICE_TIMEOUT_MS — never block indefinitely.
     *
     * The HTTP proxy restarts automatically on the next app launch because
     * index.js calls tizen.application.launch for the ytresolver service on
     * every boot (see the Bootstrap section in index.js).
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

            /* ── Step 1: Open local MessagePort for ACK ──────────────────── */
            try {
                /*
                 * requestLocalMessagePort registers a named port ON THIS app.
                 * The service finds it by calling:
                 *   tizen.messageport.requestRemoteMessagePort(appId, ACK_PORT_NAME)
                 */
                localPort = tizen.messageport.requestLocalMessagePort(ACK_PORT_NAME);
                listenerId = localPort.addMessagePortListener((msgData) => {
                    const status = msgData?.[0]?.value || 'unknown';
                    log.info('Smart Hub service ACK:', status);
                    cleanup();
                    resolve();
                });
            } catch (e) {
                /* MessagePort unavailable (e.g. browser dev mode) — skip ACK
                 * and let the launch proceed without waiting for confirmation. */
                log.error('Could not open local MessagePort:', e.message);
                resolve();
                return;
            }

            /* Safety timeout — guards against the service crashing silently
             * or the ACK never arriving on misbehaving hardware. */
            timeoutHandle = setTimeout(() => {
                log.warn(`Smart Hub ACK timed out after ${SERVICE_TIMEOUT_MS / 1000}s — continuing`);
                cleanup();
                resolve();
            }, SERVICE_TIMEOUT_MS);

            /* ── Step 2: Launch the ytresolver service ────────────────────── */
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
                        cleanup();
                        resolve(); /* Don't block the refresh cycle on a failing service. */
                    }
                );
            } catch (e) {
                log.error('Exception during service launch:', e.message);
                cleanup();
                resolve();
            }
        });
    }
}

/* ============================================================================
 * Singleton export — the entire app accesses Smart Hub through one instance.
 * ============================================================================
 */
export const smartHubManager = new SmartHubManager();
export default SmartHubManager;
