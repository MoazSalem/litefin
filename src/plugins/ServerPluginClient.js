/**
 * ============================================================================
 * Litefin Tizen - ServerPluginClient
 * ============================================================================
 * Detects and communicates with Jellyfin server-side plugins.
 *
 * Detection Strategy (hybrid):
 *   1. Admin users: GET /Plugins returns a full list of installed server plugins.
 *      We cache this for the entire session so we never hit the endpoint again.
 *   2. Non-admin users (403): We fall back to endpoint probing — each known
 *      server plugin registers a "probe" function that calls a characteristic
 *      endpoint for that plugin. A 200/non-404 response = plugin is present.
 *      Probe results are cached per-session once resolved.
 *
 * Usage:
 *   import { serverPluginClient } from './ServerPluginClient.js';
 *   const available = await serverPluginClient.isPluginAvailable('intro-skipper');
 *   const data = await serverPluginClient.call('/Episode/{id}/IntroSkipperSegments');
 * ============================================================================
 */

import { logger } from '../utils/Logger.js';

const log = logger.create('ServerPluginClient');

// ============================================================================
// Known Probe Registry
// ============================================================================
// Each entry maps a logical plugin ID to a probe function.
// The probe function receives the api client and an optional context object
// (e.g., the current media item for episode-specific probes).
// It should return a truthy value if the plugin is available.
//
// To add support for a new server plugin, just add an entry here.
const KNOWN_PROBES = {
    // Intro Skipper: https://github.com/ConfusedPolarBear/intro-skipper
    // Probe requires a real episode ID — we probe lazily on first playback.
    'intro-skipper': {
        // The endpoint that only exists when intro-skipper is installed.
        // Correct path confirmed from SkipIntroController.cs: [HttpGet("Episode/{Id}/Timestamps")]
        probeEndpoint: (item) => {
            // Intro Skipper only works for episodes. If this is a movie or a pre-roll intro,
            // we cannot probe the endpoint. Return null to defer.
            if (!item || item.Type !== 'Episode') return null;
            return `/Episode/${item.Id}/Timestamps`;
        },
        // Same endpoint used for actual data fetch
        dataEndpoint: (itemId) => `/Episode/${itemId}/Timestamps`
    },

    // Open Subtitles server plugin (subtitle download support)
    'open-subtitles': {
        probeEndpoint: () => `/Plugins`,
        // We detect by checking the full plugin list even for non-admin
        // (this is a fallback — we search for the name in the error body)
        dataEndpoint: (itemId) => `/Items/${itemId}/ExternalIdInfos`
    },

    // Local Intros (Pre-rolls): https://github.com/jellyfin/jellyfin-plugin-intros
    'local-intros': {
        // Core endpoint — exists if intros are supported (virtually always)
        probeEndpoint: (itemId) => `/Users/${serverPluginClient._api?._userId}/Items/${itemId}/Intros`,
        dataEndpoint: (itemId) => `/Users/${serverPluginClient._api?._userId}/Items/${itemId}/Intros`
    },

    // MDBList Ratings Plugin: https://github.com/jellyfin/jellyfin-plugin-mdblist-ratings
    'mdblist-ratings': {
        probeEndpoint: (itemId) => `/Plugins/MdbListRatings/CachedByItemId?itemId=${itemId}`,
        dataEndpoint: (itemId) => `/Plugins/MdbListRatings/CachedByItemId?itemId=${itemId}`
    }
};

// ============================================================================
// ServerPluginClient Class
// ============================================================================
class ServerPluginClient {
    constructor() {
        // Reference to the litefin ApiClient — set via init()
        this._api = null;

        // ---- Session caches ----

        // Full installed plugin list from GET /Plugins (admin-only).
        // null = not yet fetched or not available (non-admin).
        this._installedPlugins = null;

        // Whether we have already attempted the admin-level GET /Plugins call.
        // Avoids redundant requests once we know the user is not an admin.
        this._adminFetchAttempted = false;

        // Whether GET /Plugins succeeded (user is admin).
        this._isAdmin = false;

        // Per-plugin availability cache:
        // Map<pluginId, { available: boolean, data?: any }>
        this._availabilityCache = new Map();

        // Per-plugin probe promises (prevent duplicate concurrent probes):
        // Map<pluginId, Promise>
        this._pendingProbes = new Map();
    }

    // ========================================================================
    // Initialization
    // ========================================================================

    /**
     * Initialize the client with a reference to the app's ApiClient.
     * Must be called before any other method.
     * @param {Object} api - The litefin ApiClient singleton
     */
    init(api) {
        this._api = api;
        log.info('ServerPluginClient initialized');
    }

    // ========================================================================
    // Public API
    // ========================================================================

    /**
     * Get the full list of installed Jellyfin server plugins.
     * Only works for admin users — returns null for non-admins.
     * Result is cached for the session.
     *
     * @returns {Promise<Array|null>} Array of plugin objects or null if non-admin
     */
    async getInstalledPlugins() {
        // Return cached result if we have already fetched
        if (this._adminFetchAttempted) {
            return this._installedPlugins;
        }

        this._adminFetchAttempted = true;

        try {
            log.debug('Attempting GET /Plugins (admin check)...');
            const plugins = await this._api.get('/Plugins');

            // Success — user is admin, cache the full list
            this._installedPlugins = Array.isArray(plugins) ? plugins : [];
            this._isAdmin = true;

            log.info(`Admin plugin list fetched: ${this._installedPlugins.length} plugins installed`);
            return this._installedPlugins;
        } catch (err) {
            if (err.status === 403 || err.status === 401) {
                // Expected — user is not an admin, fall back to probing
                log.info('User is not admin (403/401). Will use endpoint probing for plugin detection.');
            } else {
                // Unexpected network/server error
                log.warn('GET /Plugins failed with unexpected error:', err.message);
            }

            this._installedPlugins = null;
            this._isAdmin = false;
            return null;
        }
    }

    /**
     * Check whether a specific server plugin is available.
     *
     * Strategy:
     *  1. If we have the admin plugin list, search it by name (case-insensitive).
     *  2. Otherwise, run the per-plugin probe and cache the result.
     *
     * @param {string} pluginId - Logical plugin ID (matches KNOWN_PROBES keys)
     * @param {Object} [item] - Optional media item for context-specific probes
     * @returns {Promise<{ available: boolean, data?: any }>}
     */
    async isPluginAvailable(pluginId, item = null) {
        // Return cached result if already resolved
        if (this._availabilityCache.has(pluginId)) {
            return this._availabilityCache.get(pluginId);
        }

        // Prevent duplicate concurrent probes for the same plugin
        if (this._pendingProbes.has(pluginId)) {
            return this._pendingProbes.get(pluginId);
        }

        const probePromise = this._resolvePluginAvailability(pluginId, item);
        this._pendingProbes.set(pluginId, probePromise);

        try {
            const result = await probePromise;
            this._availabilityCache.set(pluginId, result);
            return result;
        } finally {
            this._pendingProbes.delete(pluginId);
        }
    }

    /**
     * Make a direct call to a server plugin's API endpoint.
     * Thin wrapper around the standard ApiClient for convenience.
     *
     * @param {string} endpoint - Full endpoint path (e.g., '/Episode/{id}/IntroTimestamps/v1')
     * @param {'GET'|'POST'|'PUT'|'DELETE'} [method='GET'] - HTTP method
     * @param {Object} [body] - Request body for POST/PUT
     * @returns {Promise<any>} Response data
     */
    async call(endpoint, method = 'GET', body = null) {
        if (!this._api) {
            throw new Error('ServerPluginClient not initialized. Call init(api) first.');
        }

        switch (method.toUpperCase()) {
            case 'POST':
                return this._api.post(endpoint, body);
            case 'DELETE':
                return this._api.delete(endpoint);
            default:
                return this._api.get(endpoint);
        }
    }

    /**
     * Clear all cached results, forcing fresh probes on next check.
     * Useful when the user logs out or switches servers.
     */
    reset() {
        this._installedPlugins = null;
        this._adminFetchAttempted = false;
        this._isAdmin = false;
        this._availabilityCache.clear();
        this._pendingProbes.clear();
        log.debug('ServerPluginClient cache cleared');
    }

    // ========================================================================
    // Internal Helpers
    // ========================================================================

    /**
     * Resolve plugin availability using whichever strategy is appropriate.
     * @private
     */
    async _resolvePluginAvailability(pluginId, item) {
        // First, try the admin route (fetches once, caches for session)
        const adminList = await this.getInstalledPlugins();

        if (adminList !== null) {
            // We have the full list — do a name search
            return this._checkInAdminList(pluginId, adminList);
        }

        // Non-admin fallback: use endpoint probing
        return this._probeEndpoint(pluginId, item);
    }

    /**
     * Search the admin plugin list for a known plugin by ID mapping.
     * Maps logical plugin IDs (e.g., 'intro-skipper') to known plugin name fragments.
     * @private
     */
    _checkInAdminList(pluginId, adminList) {
        // Map from our logical IDs to the name strings Jellyfin uses for these plugins
        const NAME_MAP = {
            'intro-skipper': ['intro skipper', 'introskipper'],
            'open-subtitles': ['open subtitles', 'opensubtitles'],
            'local-intros': ['local intros', 'localintros'],
            'mdblist-ratings': ['mdblist', 'mdb list', 'mdblist ratings']
        };

        const namesToCheck = NAME_MAP[pluginId] || [pluginId.toLowerCase()];

        const match = adminList.find((plugin) => {
            const name = (plugin.Name || plugin.name || '').toLowerCase();
            return namesToCheck.some((n) => name.includes(n));
        });

        const result = { available: !!match, data: match || null };
        log.debug(`Plugin '${pluginId}' ${result.available ? 'FOUND' : 'NOT FOUND'} in admin list`);
        return result;
    }

    /**
     * Probe a plugin-specific endpoint to check if it exists.
     * A 200 = installed, 404 = not installed, 403 = installed but no access.
     * @private
     */
    async _probeEndpoint(pluginId, item) {
        const probe = KNOWN_PROBES[pluginId];

        if (!probe) {
            // No probe registered for this plugin — we can't detect it without admin access
            log.warn(`No probe registered for plugin '${pluginId}' and user is not admin. Cannot detect.`);
            return { available: false, data: null };
        }

        // Some probes need an item — if not provided, we can't probe yet.
        // Return deferred:true so PluginManager enables the plugin tentatively
        // and re-checks at playback time (when we have a real item).
        if (!item) {
            log.debug(`Plugin '${pluginId}' probe requires an item — deferring until playback`);
            return { available: false, deferred: true, data: null };
        }

        const endpoint = probe.probeEndpoint(item);
        if (!endpoint) {
            // Cannot probe with this item, defer
            return { available: false, deferred: true, data: null };
        }

        try {
            log.debug(`Probing endpoint for '${pluginId}': ${endpoint}`);
            const data = await this._api.get(endpoint);

            // 200 response — plugin is installed and accessible
            log.info(`Plugin '${pluginId}' is AVAILABLE (probe succeeded)`);
            return { available: true, data };
        } catch (err) {
            if (err.status === 404) {
                // Endpoint doesn't exist — plugin not installed
                log.info(`Plugin '${pluginId}' is NOT AVAILABLE (404 — not installed)`);
                return { available: false, data: null };
            } else if (err.status === 403 || err.status === 401) {
                // Endpoint exists but we don't have permission — plugin IS installed
                log.info(`Plugin '${pluginId}' is AVAILABLE but access is restricted (${err.status})`);
                return { available: true, data: null };
            } else {
                // Network error or unexpected status
                log.warn(`Plugin '${pluginId}' probe failed with unexpected error:`, err.message);
                return { available: false, data: null };
            }
        }
    }
}

// Export singleton instance
export const serverPluginClient = new ServerPluginClient();
export default ServerPluginClient;
