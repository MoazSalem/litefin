/**
 * ============================================================================
 * Litefin - webOS Launch Target Manager
 * ============================================================================
 * Opens a title when another app launches Litefin on LG webOS with params:
 *
 *   luna://com.webos.applicationManager/launch
 *   { id: 'org.litefin.app', params: { tmdbId: 603, mediaType: 'movie', title?: 'The Matrix' } }
 *
 * mediaType is 'movie' or 'tv'. The title opens on the Jellyfin details page of
 * the library item with that TMDB provider id, otherwise on the Seerr details
 * page (/seerr/:mediaType/:tmdbId) so it can be requested. Without a match and
 * without Seerr, Litefin opens as usual.
 *
 * Mirrors SmartHubManager: a cold start is resolved before the router starts
 * and opened by the default route (openStartupTarget), a relaunch while Litefin
 * runs opens it directly, and both wait for the profile picker when it shows.
 * ============================================================================
 */

import { api } from '../api/ApiClient.js';
import { auth } from '../api/index.js';
import { seerr } from '../api/seerrClient.js';
import { webosAdapter } from './WebOSAdapter.js';
import { eventBus } from '../core/EventBus.js';
import { state } from '../core/StateManager.js';
import { router } from '../core/Router.js';
import { logger } from '../utils/Logger.js';
import { pinManager } from '../utils/PinManager.js';
import { storage } from '../utils/StorageService.js';

const log = logger.create('LaunchTargetManager');

// ============================================================================
// Constants
// ============================================================================

/* Longest a launch waits for its title to be looked up before opening Seerr's page. */
const RESOLVE_TIMEOUT_MS = 3000;

/* Longest a relaunch waits for the app to become visible again. */
const VISIBLE_WAIT_MS = 1000;

/* sessionStorage keys: they survive Litefin's own reloads but not a new launch. */
const BOOT_MARKER_KEY = 'litefin:launch_booted';
const RELOAD_TARGET_KEY = 'litefin:launch_reload_target';

// ============================================================================
// LaunchTargetManager Class
// ============================================================================

class LaunchTargetManager {
    constructor() {
        /** @type {boolean} - True once init() ran on webOS. */
        this._ready = false;

        /**
         * @type {{ params: Object, path: string|null, resolvedFor: string|null }|null}
         * A launch target not opened yet: at cold start until the default route
         * opens it, or held until a profile is chosen. path is the lookup result
         * for profile resolvedFor and is looked up again for any other profile.
         */
        this._pending = null;

        /** @type {boolean} - True once a profile was chosen or unlocked this run. */
        this._unlocked = false;
    }

    // ========================================================================
    // Public API
    // ========================================================================

    /**
     * Initialise on webOS. Call once from App.init() after auth.init().
     *
     * @returns {Promise<void>} Resolves once a cold-start target is looked up
     *   (immediately when Litefin was launched without one)
     */
    init() {
        if (this._ready) return Promise.resolve();
        this._ready = true;

        webosAdapter.onRelaunch((params) => this.handleRelaunch(params));

        eventBus.on('auth:login', (user) => {
            this._unlocked = true;
            if (!this._pending) return;
            const pending = this._pending;
            this._pending = null;

            // With per-user settings ProfilesPage reloads the app right after this
            // event; the default route opens the target after the reload.
            if (router.getCurrentPath() === '/profiles' && storage.getItem('litefin:settings_per_user') === 'true') {
                try {
                    sessionStorage.setItem(RELOAD_TARGET_KEY, JSON.stringify(pending.params));
                } catch (_) {}
                return;
            }

            // Deferred so it runs after ProfilesPage._switchToUser's own reset to /home.
            log.info('Opening held launch target after profile selection');
            setTimeout(() => this._openPending(pending), 0);
        });
        eventBus.on('auth:logout', () => {
            this._unlocked = false;
            this._pending = null;
        });

        return this._prepareStartupTarget();
    }

    /**
     * Open the cold-start target. Called by the default route in place of its
     * /home navigation once no profile picker is needed.
     *
     * @returns {boolean} True when the launch target took over the initial navigation
     */
    openStartupTarget() {
        if (!this._pending || !this._pending.path) return false;
        const pending = this._pending;
        this._pending = null;
        log.info('Initial route: opening launch target');
        this._openPending(pending);
        return true;
    }

    /**
     * Relaunch while running: open the target directly, unless a profile still
     * has to be chosen (profile picker open, or a PIN-locked profile not
     * unlocked this run); then hold it for the auth:login handler.
     *
     * @param {Object} rawParams - Relaunch params
     */
    handleRelaunch(rawParams) {
        const params = parseLaunchParams(rawParams);
        if (!params) return;
        log.info(`Relaunched for ${params.mediaType} ${params.tmdbId}`);

        /* webOS fires webOSRelaunch before the page is visible again. App's resume
         * handling (e.g. "show profiles when returning to app") runs on app:visible
         * and must come first, otherwise it replaces the target's page. */
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

        Promise.all([this._preparePending(params), appVisible]).then(([pending]) => {
            if (!state.get('user:authenticated')) return;
            const userId = auth.getCurrentUser()?.Id;
            const pinLocked = userId && pinManager.hasPin(userId) && !this._unlocked;
            const onPicker = router.getCurrentPath() === '/profiles';

            if (pinLocked || onPicker) {
                log.info('Launch target held until a profile is chosen');
                this._pending = pending;
                if (!onPicker) router.navigate('/profiles', { replace: true });
                return;
            }
            this._openPending(pending);
        });
    }

    // ========================================================================
    // Internals
    // ========================================================================

    /**
     * Cold start: look up the launch target before the router starts, so the
     * default route can open it instead of /home (no Home flash).
     *
     * @returns {Promise<void>}
     * @private
     */
    async _prepareStartupTarget() {
        /* PalmSystem.launchParams stays the same for every page load of one app
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
            log.warn('sessionStorage unavailable — cannot tell reloads from launches:', e?.message || e);
        }
        let raw = null;
        if (reloaded) {
            try {
                raw = reloadTarget ? JSON.parse(reloadTarget) : null;
            } catch (_) {}
        } else {
            raw = webosAdapter.getLaunchParams();
        }
        const params = parseLaunchParams(raw);
        if (!params) return;
        log.info(`Launched for ${params.mediaType} ${params.tmdbId}`);
        this._pending = await this._preparePending(params);
    }

    /**
     * Build a pending target, looked up for the active profile when signed in.
     *
     * @param {{ tmdbId: number, mediaType: string, title: string }} params
     * @returns {Promise<Object>} Pending target (see _pending)
     * @private
     */
    async _preparePending(params) {
        if (!state.get('user:authenticated') || state.get('server:offline')) {
            return { params, path: null, resolvedFor: null };
        }
        return { params, path: await this._resolvePath(params), resolvedFor: auth.getCurrentUser()?.Id || null };
    }

    /**
     * Open a pending target, looking it up again when it was resolved for another
     * profile than the active one. /home is the only Back step.
     *
     * @param {Object} pending - Pending target (see _pending)
     * @returns {Promise<void>}
     * @private
     */
    async _openPending(pending) {
        let path = pending.path;
        if (!path || pending.resolvedFor !== auth.getCurrentUser()?.Id) {
            path = await this._resolvePath(pending.params);
        }
        if (!path) {
            log.info('Launch target is neither in the library nor requestable — staying put');
            return;
        }
        router.setHistory(['/home']);
        router.navigate(path);
    }

    /**
     * The page to open: the library item's details, else Seerr's details page.
     * Never rejects; a slow lookup falls back to Seerr's page, which offers
     * "Play" when Seerr knows the library item.
     *
     * @param {{ tmdbId: number, mediaType: string, title: string }} params
     * @returns {Promise<string|null>} Route path, or null when there is nothing to open
     * @private
     */
    async _resolvePath(params) {
        const timeout = () => new Promise((resolve) => setTimeout(resolve, RESOLVE_TIMEOUT_MS, null));
        // Probed alongside the lookup (cached once per session)
        const seerrAvailable = seerr.isAvailable().catch(() => false);

        let itemId = null;
        try {
            itemId = await Promise.race([this._findLibraryItem(params), timeout()]);
        } catch (e) {
            log.warn('Library lookup for launch target failed:', e?.message || e);
        }
        if (itemId) {
            log.info(`Launch target found in library: ${itemId}`);
            return `/details/${itemId}`;
        }
        if (await Promise.race([seerrAvailable, timeout()])) return `/seerr/${params.mediaType}/${params.tmdbId}`;
        return null;
    }

    /**
     * Find the library item with the target's TMDB id. Every candidate is checked
     * against its ProviderIds, since servers that don't know a filter ignore it.
     *
     * @param {{ tmdbId: number, mediaType: string, title: string }} params
     * @returns {Promise<string|null>} Jellyfin item id
     * @private
     */
    async _findLibraryItem({ tmdbId, mediaType, title }) {
        const query = {
            Recursive: true,
            IncludeItemTypes: mediaType === 'tv' ? 'Series' : 'Movie',
            Fields: 'ProviderIds',
            EnableImages: false,
            EnableUserData: false,
            Limit: 20
        };
        const match = (result) => {
            const items = (result && result.Items) || [];
            const item = items.find((it) => {
                const id = it.ProviderIds && (it.ProviderIds.Tmdb || it.ProviderIds.tmdb);
                return id && String(id) === String(tmdbId);
            });
            return item ? item.Id : null;
        };

        // 1. Provider id filter (Emby-style; checked below either way)
        let itemId = match(await api.getItems({ ...query, AnyProviderIdEquals: `tmdb.${tmdbId}` }));
        if (itemId) return itemId;

        // 2. Title search, when the launching app sent the title
        if (title) {
            itemId = match(await api.getItems({ ...query, SearchTerm: title }));
            if (itemId) return itemId;
        }

        // 3. Seerr knows the Jellyfin id of what it has seen in the library
        if (!(await seerr.isAvailable())) return null;
        const details = await seerr.details(mediaType, tmdbId);
        return (details && details._jellyfinMediaId) || null;
    }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * ============================================================================
 * Launch Parameters Validation & Normalization
 * ============================================================================
 * Validates and extracts launch parameters:
 *   { tmdbId: number|string, mediaType: 'movie'|'tv'|'series', title?: string }
 *
 * Supports parameters provided directly at top-level or encapsulated within a
 * nested `params` wrapper object (standard format used by webOS applicationManager
 * launch service requests).
 *
 * @param {Object|null} raw - Raw launch parameters object
 * @returns {{ tmdbId: number, mediaType: string, title: string }|null} Normalized parameters or null
 */
export function parseLaunchParams(raw) {
    // Reject null or non-object arguments
    if (!raw || typeof raw !== 'object') return null;

    // Support both direct payloads ({ tmdbId, ... }) and nested parameters wrappers
    // ({ params: { tmdbId, ... } }) as dispatched by webOS applicationManager launch calls
    const payload = raw.params && typeof raw.params === 'object' ? raw.params : raw;

    // Parse numeric TMDB ID ensuring positive integer value
    const tmdbId = parseInt(payload.tmdbId, 10);
    if (!(tmdbId > 0)) return null;

    // Normalize media category identifier
    const type = String(payload.mediaType || '').toLowerCase();
    if (type !== 'movie' && type !== 'tv' && type !== 'series') {
        log.warn(`Launch params ignored — unknown mediaType "${payload.mediaType}"`);
        return null;
    }

    return {
        tmdbId,
        mediaType: type === 'movie' ? 'movie' : 'tv',
        title: typeof payload.title === 'string' ? payload.title : ''
    };
}

export const launchTargetManager = new LaunchTargetManager();
export default launchTargetManager;
