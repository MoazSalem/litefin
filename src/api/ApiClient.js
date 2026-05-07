/**
 * ============================================================================
 * Litefin Tizen - API Client
 * ============================================================================
 * HTTP client wrapper for Jellyfin server API communication.
 * Handles authentication headers, error handling, and request management.
 *
 * Based on jellyfin-web patterns for compatibility.
 * ============================================================================
 */

import { eventBus } from '../core/EventBus.js';
import { state } from '../core/StateManager.js';
import { tizenAdapter } from '../tizen/TizenAdapter.js';
import { logger } from '../utils/Logger.js';

const log = logger.create('ApiClient');

/**
 * Custom error for when the server is physically unreachable
 */
export class ServerUnreachableError extends Error {
    constructor(message = 'Server unreachable') {
        super(message);
        this.name = 'ServerUnreachableError';
        this.isNetworkError = true;
    }
}

// API request timeout (ms)
const REQUEST_TIMEOUT = 30000; // Increased from 10s to 30s for weaker hardware (Tizen/WebOS)

// ============================================================================
// ApiClient Class
// ============================================================================
export class ApiClient {
    constructor() {
        // Server configuration
        this._serverUrl = null;
        this._accessToken = null;
        this._userId = null;

        // Device identification - NO SPACES in any of these values
        this._deviceId = null;
        this._deviceName = 'Litefin'; // Default, will be updated by AuthManager.init()
        this._clientName = 'Litefin';
        this._clientVersion = __APP_VERSION__;

        // Track retries to prevent infinite loops on 401
        this._retryingRequests = new Set();
    }

    // ========================================================================
    // Properties
    // ========================================================================
    get clientName() { return this._clientName; }
    get deviceName() { return this._deviceName; }
    get deviceId() { return this._deviceId; }
    get clientVersion() { return this._clientVersion; }
    get serverUrl() { return this._serverUrl; }
    get accessToken() { return this._accessToken; }
    get userId() { return this._userId; }

    // ========================================================================
    // Configuration Methods
    // ========================================================================

    /**
     * Set the server URL
     * @param {string} serverUrl - Jellyfin server URL
     */
    setServer(serverUrl) {
        // Normalize URL (remove trailing slash)
        this._serverUrl = serverUrl.replace(/\/+$/, '');
        state.set('server:url', this._serverUrl);
        log.info(`Server set to ${this._serverUrl}`);
    }

    /**
     * Set authentication credentials
     * @param {string} accessToken - Access token from login
     * @param {string} userId - User ID
     */
    setAuth(accessToken, userId) {
        this._accessToken = accessToken;
        this._userId = userId;
        state.set('user:authenticated', !!accessToken);
        log.info(`Authenticated as user ${userId}`);
    }

    /**
     * Set device identification
     * Device name is sanitized to remove spaces and special characters
     * @param {string} deviceId - Unique device ID
     * @param {string} [deviceName] - Device name (will be sanitized)
     */
    setDevice(deviceId, deviceName = null) {
        this._deviceId = deviceId;
        if (deviceName) {
            // Allow alphanumeric, spaces, hyphens, underscores, dots, and percent encoding
            this._deviceName = deviceName.replace(/[^a-zA-Z0-9 \-_.%]/g, '');
        }
    }

    /**
     * Clear authentication credentials
     */
    clearAuth() {
        this._accessToken = null;
        this._userId = null;
        state.set('user:authenticated', false);
        state.set('user:data', null);
        log.info('Authentication cleared');
    }

    // ========================================================================
    // Header Management
    // ========================================================================

    /**
     * Build the X-Emby-Authorization header
     * This header format is required by Jellyfin for all authenticated requests
     * @returns {string} Authorization header value
     */
    getAuthHeader(tokenOverride = null) {
        // Build MediaBrowser authorization header
        // Format: MediaBrowser Client="...", Device="...", DeviceId="...", Version="..."[, Token="..."]
        const parts = [
            `Client="${this._clientName}"`,
            `Device="${this._deviceName}"`,
            `DeviceId="${this._deviceId}"`,
            `Version="${this._clientVersion}"`
        ];

        // Add token if authenticated or overridden
        const token = tokenOverride || this._accessToken;
        if (token) {
            parts.push(`Token="${token}"`);
        }

        return `MediaBrowser ${parts.join(', ')}`;
    }

    /**
     * Build full URL for an endpoint
     * @param {string} endpoint - API endpoint path
     * @returns {string} Full URL
     */
    buildUrl(endpoint) {
        const path = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
        return `${this._serverUrl}${path}`;
    }

    // ========================================================================
    // Request Methods
    // ========================================================================

    /**
     * Make an API request
     * @param {string} endpoint - API endpoint
     * @param {Object} [options] - Fetch options
     * @returns {Promise<any>} Response data
     */
    async request(endpoint, options = {}, isRetry = false) {
        if (!this._serverUrl) {
            throw new Error('Server URL not configured');
        }

        let url = this.buildUrl(endpoint);

        // Append query parameters if provided
        if (options.params) {
            const searchParams = new URLSearchParams();
            for (const [key, value] of Object.entries(options.params)) {
                if (value !== undefined && value !== null) {
                    searchParams.append(key, value);
                }
            }
            const queryString = searchParams.toString();
            if (queryString) {
                url += (url.includes('?') ? '&' : '?') + queryString;
            }
        }

        const method = options.method || 'GET';

        // DEBUG: Store last requested URL
        this.lastUrl = url;

        // Build headers
        const headers = {
            'Accept': 'application/json',     // Explicitly request JSON response
            ...options.headers
        };

        if (!options.skipAuth) {
            const authHeader = this.getAuthHeader();
            headers['X-Emby-Authorization'] = authHeader;
            headers['Authorization'] = authHeader;      // Standard header for modern servers/proxies
        }

        if (!options.body || !(options.body instanceof FormData)) {
            headers['Content-Type'] = 'application/json';
        }

        // Build fetch options
        const fetchOptions = {
            method,
            headers,
            keepalive: options.keepalive
        };

        // Add body for POST/PUT requests
        if (options.body) {
            if (options.body instanceof FormData) {
                fetchOptions.body = options.body;
                // Let browser set Content-Type for FormData
                delete headers['Content-Type'];
            } else if (typeof options.body === 'object') {
                fetchOptions.body = JSON.stringify(options.body);
            } else {
                fetchOptions.body = options.body;
            }
        }

        log.debug(`${method} ${endpoint}`);

        try {
            // Create abort controller for timeout
            // Support per-request timeout override via options.timeout
            const timeout = options.timeout || REQUEST_TIMEOUT;
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeout);
            fetchOptions.signal = controller.signal;

            log.debug(`Fetching ${url} (timeout: ${timeout}ms)...`);
            const response = await fetch(url, fetchOptions);
            clearTimeout(timeoutId);

            // Handle error responses
            if (!response.ok) {
                // If 401 Unauthorized and not already a retry, try one more time
                // This handles transient session blips on some servers after sleep
                if (response.status === 401 && !isRetry && this._accessToken) {
                    log.warn(`Unauthorized (401) for ${endpoint}. Attempting one-time silent retry...`);
                    return this.request(endpoint, options, true);
                }

                const error = await this._handleError(response);
                throw error;
            }

            // Handle 204 No Content (common for session reporting endpoints)
            if (response.status === 204) {
                return null;
            }

            // Parse response based on content type
            const contentType = response.headers.get('content-type');
            if (contentType && contentType.includes('application/json')) {
                return await response.json();
            }

            return await response.text();
        } catch (error) {
            // Handle Network Errors (DNS, Connection Refused, Offline) or Timeout
            const isTimeout = error.name === 'AbortError';
            const isNetworkError = error instanceof TypeError;

            if (isTimeout || isNetworkError) {
                const timeout = options.timeout || REQUEST_TIMEOUT;
                const msg = isTimeout
                    ? `Connection timed out after ${timeout / 1000}s`
                    : `Server unreachable at ${this._serverUrl}`;

                log.error(`${msg}:`, error.message);

                const networkError = new ServerUnreachableError(`${msg}. Please check your network and server status.`);
                eventBus.emit('api:offline', { url: this._serverUrl, isTimeout });
                throw networkError;
            }

            log.error(`Request to ${endpoint} failed:`, error.message || error);
            eventBus.emit('api:error', { endpoint, error });
            throw error;
        }
    }

    /**
     * Handle error responses
     * @private
     */
    async _handleError(response) {
        let message = `HTTP ${response.status}`;

        // Try to parse the server's error description from the response body.
        // Jellyfin returns JSON on most errors, but schema-validation 400s can
        // return plain text. We try JSON first and fall back to raw text so the
        // actual server reason (e.g. "MaxAudioChannels must be an integer") is
        // visible in the debug overlay instead of being silently discarded.
        try {
            const bodyText = await response.text();
            if (bodyText) {
                try {
                    const data = JSON.parse(bodyText);
                    message = data.message || data.Message || message;
                } catch {
                    // Not JSON — use raw text as the error message (trim to 200 chars max)
                    const trimmed = bodyText.trim();
                    if (trimmed) {
                        message = trimmed.length > 200 ? trimmed.slice(0, 200) + '…' : trimmed;
                    }
                }
            }
        } catch {
            // Could not read body at all — keep the "HTTP N" default
        }

        // Log 400s at error level so they are always visible in the debug overlay
        // even when general logging is disabled. The server reason is included so
        // the developer can diagnose schema issues without needing DevTools.
        if (response.status === 400) {
            log.error(`Server rejected request (400 Bad Request): ${message}`);
        }

        // Handle specific status codes
        switch (response.status) {
            case 401:
                eventBus.emit('api:unauthorized');
                message = 'Authentication required';
                break;
            case 403:
                message = 'Access denied';
                break;
            case 404:
                message = 'Not found';
                break;
            case 500:
                message = 'Server error';
                break;
        }

        const error = new Error(message);
        error.status = response.status;
        return error;
    }

    /**
     * GET request helper
     */
    async get(endpoint, params = null, options = {}) {
        return this.request(endpoint, { method: 'GET', params, ...options });
    }

    /**
     * POST request helper
     */
    async post(endpoint, body = null, options = {}) {
        return this.request(endpoint, { method: 'POST', body, ...options });
    }

    /**
     * DELETE request helper
     */
    async delete(endpoint, options = {}) {
        return this.request(endpoint, { method: 'DELETE', ...options });
    }

    // ========================================================================
    // Server Endpoints (Public - No auth required)
    // ========================================================================

    /**
     * Get server public info
     */
    async getPublicInfo(options = {}) {
        return this.get('/System/Info/Public', null, { skipAuth: true, ...options });
    }

    /**
     * Get server branding configuration
     */
    async getBranding() {
        return this.get('/Branding/Configuration');
    }

    // ========================================================================
    // Localization Endpoints
    // ========================================================================

    /**
     * Get list of cultures (languages) supported by the server
     * @returns {Promise<Array>} List of culture objects
     */
    async getCultures() {
        return this.get('/Localization/Cultures');
    }

    // ========================================================================
    // User Endpoints
    // ========================================================================

    /**
     * Get list of public users (for login screen)
     * Returns users with HasPassword field
     */
    async getPublicUsers() {
        return this.get('Users/Public');
    }

    // ========================================================================
    // Quick Connect Endpoints
    // ========================================================================

    /**
     * Check if Quick Connect is enabled on the server.
     * Returns true/false — no auth required.
     * Call this before initiating to avoid showing QC option on servers that have it off.
     */
    async isQuickConnectEnabled() {
        return this.get('/QuickConnect/Enabled');
    }

    /**
     * Initiate a new Quick Connect session.
     * Returns { Secret, Code, Authenticated: false }.
     * Display `Code` (6 digits) to the user on screen.
     * Hold onto `Secret` for polling.
     *
     * No user credentials needed — only the device authorization header.
     */
    async initiateQuickConnect() {
        return this.post('/QuickConnect/Initiate');
    }

    /**
     * Poll for Quick Connect authorization status.
     * Returns the updated QuickConnectResult: { Secret, Code, Authenticated }.
     * When Authenticated === true, use the Secret to authenticate.
     *
     * @param {string} secret - The Secret returned from initiateQuickConnect
     */
    async checkQuickConnectStatus(secret) {
        return this.get('/QuickConnect/Connect', { secret });
    }

    /**
     * Exchange an authorized Quick Connect secret for a full auth token.
     * This is called after checkQuickConnectStatus returns Authenticated: true.
     * Returns the same shape as /Users/AuthenticateByName (AccessToken, User, etc.)
     *
     * @param {string} secret - The authorized Secret from the Quick Connect flow
     */
    async authenticateWithQuickConnect(secret) {
        return this.post('/Users/AuthenticateWithQuickConnect', {
            Secret: secret,
            App: this.clientName,
            Device: this.deviceName,
            DeviceId: this.deviceId,
            Version: this.clientVersion
        });
    }

    /**
     * Get current user info
     */
    async getCurrentUser(options = {}) {
        return this.get(`/Users/${this._userId}`, null, options);
    }

    /**
     * Update user configuration
     */
    async updateUserConfiguration(configuration) {
        return this.post(`/Users/${this._userId}/Configuration`, configuration);
    }

    /**
     * Get user's library views
     */
    async getUserViews() {
        return this.get(`/Users/${this._userId}/Views`);
    }

    // ========================================================================
    // Library Endpoints
    // ========================================================================

    /**
     * Get items from library
     */
    async getItems(params = {}) {
        const defaults = {
            UserId: this._userId,
            SortBy: 'SortName',
            SortOrder: 'Ascending',
            IncludeItemTypes: '',
            Recursive: true,
            Fields: 'PrimaryImageAspectRatio,BasicSyncInfo',
            ImageTypeLimit: 1,
            EnableImageTypes: 'Primary,Backdrop,Thumb',
            Limit: 100
        };

        return this.get('/Items', { ...defaults, ...params });
    }

    /**
     * Get a single random item (Movie or Series) from the user's library.
     * @returns {Promise<Object|null>} A random item object or null if none found.
     */
    async getRandomItem() {
        const result = await this.getItems({
            IncludeItemTypes: 'Movie,Series',
            SortBy: 'Random',
            Limit: 1,
            Recursive: true
        });
        return result && result.Items && result.Items.length > 0 ? result.Items[0] : null;
    }

    /**
     * Get latest items in a library
     */
    async getLatestItems(parentId, params = {}) {
        const defaults = {
            // 20 items gives a comfortable scrollable collection per library row
            Limit: 20,
            Fields: 'PrimaryImageAspectRatio,BasicSyncInfo',
            ImageTypeLimit: 1,
            EnableImageTypes: 'Primary,Backdrop,Thumb',
            ParentId: parentId
        };

        return this.get(`/Users/${this._userId}/Items/Latest`, { ...defaults, ...params });
    }

    /**
     * Get resume items (continue watching)
     */
    async getResumeItems(params = {}) {
        const defaults = {
            // Fetch enough items to fill the horizontal row generously —
            // users can scroll through up to 20 continue-watching entries
            Limit: 20,
            Recursive: true,
            Fields: 'PrimaryImageAspectRatio,BasicSyncInfo,SeriesThumbImageTag,ParentThumbImageTag',
            ImageTypeLimit: 1,
            EnableImageTypes: 'Primary,Backdrop,Thumb',
            EnableTotalRecordCount: false,
            MediaTypes: 'Video'
        };

        return this.get(`/Users/${this._userId}/Items/Resume`, { ...defaults, ...params });
    }

    /**
     * Get recently played audio items
     */
    async getRecentlyPlayedAudio(parentId, limit = 15) {
        return this.get(`/Users/${this._userId}/Items`, {
            ParentId: parentId,
            IncludeItemTypes: 'Audio',
            Recursive: true,
            Filters: 'IsPlayed',
            SortBy: 'DatePlayed',
            SortOrder: 'Descending',
            Limit: limit,
            Fields: 'PrimaryImageAspectRatio,BasicSyncInfo'
        });
    }

    /**
     * Get frequently played audio items
     */
    async getFrequentlyPlayedAudio(parentId, limit = 15) {
        return this.get(`/Users/${this._userId}/Items`, {
            ParentId: parentId,
            IncludeItemTypes: 'Audio',
            Recursive: true,
            Filters: 'IsPlayed',
            SortBy: 'PlayCount',
            SortOrder: 'Descending',
            Limit: limit,
            Fields: 'PrimaryImageAspectRatio,BasicSyncInfo'
        });
    }

    /**
     * Get next up episodes
     */
    async getNextUp(params = {}) {
        const defaults = {
            UserId: this._userId,
            Limit: 24,
            Fields: 'PrimaryImageAspectRatio,BasicSyncInfo,SeriesThumbImageTag,ParentThumbImageTag',
            ImageTypeLimit: 1,
            EnableImageTypes: 'Primary,Backdrop,Thumb'
        };

        return this.get('/Shows/NextUp', { ...defaults, ...params });
    }

    /**
     * Get upcoming episodes for a library
     */
    async getUpcoming(params = {}) {
        const defaults = {
            UserId: this._userId,
            Limit: 48,
            Fields: 'AirTime,PrimaryImageAspectRatio',
            ImageTypeLimit: 1,
            EnableImageTypes: 'Primary,Backdrop,Banner,Thumb',
            EnableTotalRecordCount: false
        };

        return this.get('/Shows/Upcoming', { ...defaults, ...params });
    }

    /**
     * Get studios/networks for a library
     */
    async getStudios(params = {}) {
        const defaults = {
            UserId: this._userId,
            IncludeItemTypes: 'Series',
            Recursive: true,
            Fields: 'DateCreated,PrimaryImageAspectRatio'
        };

        return this.get(`/Studios`, { ...defaults, ...params });
    }

    // ========================================================================
    // Item Endpoints
    // ========================================================================

    async getItem(itemId, params = {}) {
        return this.get(`/Users/${this._userId}/Items/${itemId}`, params);
    }

    /**
     * Update item metadata
     * @param {Object} item - Item object containing the Id and fields to update
     * @returns {Promise<any>} Result of the update
     */
    async updateItem(item) {
        // Jellyfin metadata update endpoint is POST /Items/{Id}
        return this.post(`/Items/${item.Id}`, item);
    }

    /**
     * Get pre-roll intro items for a given media item.
     * @param {string} itemId - The target media item ID
     * @returns {Promise<Object>} Object containing Items array and TotalRecordCount
     */
    async getIntros(itemId) {
        return this.get(`/Users/${this._userId}/Items/${itemId}/Intros`);
    }

    /**
     * Get local trailers for an item.
     *
     * Jellyfin stores locally-managed trailers as full BaseItemDto objects,
     * each with their own Id — so they can be played directly through the
     * normal JellyfinPlayer.play({ itemId }) pipeline without any special casing.
     *
     * @param {string} itemId - The parent item's ID
     * @returns {Promise<BaseItemDto[]>} Array of trailer items (may be empty)
     */
    async getLocalTrailers(itemId) {
        return this.get(`/Users/${this._userId}/Items/${itemId}/LocalTrailers`);
    }

    /**
     * Get special features (extras) for an item.
     * Includes trailers, featurettes, behind the scenes, etc.
     *
     * @param {string} itemId - The parent item's ID
     * @returns {Promise<BaseItemDto[]>} Array of special feature items
     */
    async getSpecialFeatures(itemId) {
        return this.get(`/Users/${this._userId}/Items/${itemId}/SpecialFeatures`);
    }

    /**
     * Get items inside a server-managed Playlist.
     *
     * We use the dedicated /Playlists/{id}/Items endpoint rather than the
     * generic /Items endpoint because:
     *   - It preserves the user-defined server ordering of playlist items.
     *   - It returns a PlaylistItemId on each entry, required by SyncPlay's
     *     stamping mechanism to identify queue slots across sessions.
     *
     * @param {string} playlistId - Playlist container item ID
     * @param {Object} [params]   - Extra query params (e.g. Limit, Fields)
     * @returns {Promise<Object>} Standard paginated Items response { Items, TotalRecordCount }
     */
    async getPlaylistItems(playlistId, params = {}) {
        return this.get(`/Playlists/${playlistId}/Items`, {
            UserId: this._userId,
            Fields: 'PrimaryImageAspectRatio,UserData,RunTimeTicks,BasicSyncInfo',
            EnableImageTypes: 'Primary,Backdrop,Thumb',
            ...params
        });
    }

    async getSimilar(itemId, params = {}) {
        const defaults = {
            UserId: this._userId,
            Limit: 12,
            Fields: 'PrimaryImageAspectRatio'
        };

        return this.get(`/Items/${itemId}/Similar`, { ...defaults, ...params });
    }

    async getSeasons(seriesId) {
        return this.get(`/Shows/${seriesId}/Seasons`, {
            UserId: this._userId,
            Fields: 'PrimaryImageAspectRatio,BasicSyncInfo'
        });
    }

    async getEpisodes(seriesId, params = {}) {
        // Flexible params — pass SeasonId, StartItemId, Limit, etc.
        // Omit SeasonId to get episodes across all seasons (cross-season navigation)
        return this.get(`/Shows/${seriesId}/Episodes`, {
            UserId: this._userId,
            Fields: 'PrimaryImageAspectRatio,BasicSyncInfo,Overview,RunTimeTicks,Chapters',
            IsVirtualUnaired: false,
            IsMissing: false,
            ...params
        });
    }

    async getPeople(itemId) {
        return this.get(`/Items/${itemId}/People`, {
            UserId: this._userId,
            Limit: 24
        });
    }

    async getPerson(personId) {
        return this.getItem(personId);
    }

    async getPersonItems(personId) {
        // Fetch items for this person - Movies, Series, Episodes only
        // High limit to capture full filmography (some people have many appearances)
        // Note: People field loaded separately via getPersonItemsWithRoles for performance
        return this.get(`/Users/${this._userId}/Items`, {
            PersonIds: personId,
            IncludeItemTypes: 'Movie,Series,Episode',
            Recursive: true,
            Limit: 500,
            Fields: 'PrimaryImageAspectRatio,ProductionYear,ParentIndexNumber,IndexNumber,SeriesName',
            SortBy: 'PremiereDate',
            SortOrder: 'Descending'
        });
    }

    // Separate call to get items with People field (for character roles)
    async getPersonItemsWithRoles(personId) {
        return this.get(`/Users/${this._userId}/Items`, {
            PersonIds: personId,
            IncludeItemTypes: 'Movie,Series',
            Recursive: true,
            Limit: 200,
            Fields: 'People'
        });
    }

    // ========================================================================
    // Music Endpoints
    // ========================================================================

    /**
     * Get lyrics for an audio item.
     * @param {string} itemId - The audio item ID
     * @returns {Promise<any>} Lyrics data
     */
    async getLyrics(itemId) {
        return this.get(`/Audio/${itemId}/Lyrics`);
    }

    async getAlbumArtists(params = {}) {
        const defaults = {
            UserId: this._userId,
            Recursive: true,
            Fields: 'PrimaryImageAspectRatio,ItemCounts',
            SortBy: 'SortName',
            SortOrder: 'Ascending',
            EnableTotalRecordCount: true
        };

        return this.get('/Artists/AlbumArtists', { ...defaults, ...params });
    }

    async getMusicArtists(params = {}) {
        const defaults = {
            UserId: this._userId,
            Recursive: true,
            Fields: 'PrimaryImageAspectRatio,ItemCounts',
            SortBy: 'SortName',
            SortOrder: 'Ascending',
            EnableTotalRecordCount: true
        };

        return this.get('/Artists', { ...defaults, ...params });
    }

    async getResumeAudio(params = {}) {
        const defaults = {
            Limit: 20,
            Recursive: true,
            Fields: 'PrimaryImageAspectRatio,BasicSyncInfo,ParentThumbImageTag',
            ImageTypeLimit: 1,
            EnableImageTypes: 'Primary,Backdrop,Thumb',
            EnableTotalRecordCount: false,
            MediaTypes: 'Audio' // Only fetch Audio items
        };

        return this.get(`/Users/${this._userId}/Items/Resume`, { ...defaults, ...params });
    }

    // ========================================================================
    // Genre Endpoints
    // ========================================================================

    async getGenres(params = {}) {
        const defaults = {
            UserId: this._userId,
            Recursive: true,
            Fields: 'PrimaryImageAspectRatio,ItemCounts',
            SortBy: 'SortName',
            SortOrder: 'Ascending',
            EnableTotalRecordCount: false
        };

        return this.get('/Genres', { ...defaults, ...params });
    }

    async getMusicGenres(params = {}) {
        const defaults = {
            UserId: this._userId,
            Recursive: true,
            Fields: 'PrimaryImageAspectRatio,ItemCounts',
            SortBy: 'SortName',
            SortOrder: 'Ascending',
            EnableTotalRecordCount: false
        };

        return this.get('/MusicGenres', { ...defaults, ...params });
    }

    async getItemFilters(params = {}) {
        const defaults = {
            UserId: this._userId,
            Recursive: true
        };
        return this.get('/Items/Filters', { ...defaults, ...params });
    }

    // ========================================================================
    // Search Endpoints
    // ========================================================================

    async search(query, params = {}) {
        const defaults = {
            UserId: this._userId,
            SearchTerm: query,
            IncludeItemTypes: 'Movie,Series,Episode,BoxSet',
            Limit: 24,
            Fields: 'PrimaryImageAspectRatio',
            Recursive: true,
            EnableTotalRecordCount: false,
            MediaTypes: null
        };

        return this.get('/Items', { ...defaults, ...params });
    }

    /**
     * Global search using the specialized Search Hints endpoint.
     * This matches Jellyfin-web behavior and finds Artists more accurately.
     * @param {string} query
     * @param {Object} [params]
     * @returns {Promise<any>}
     */
    async searchHints(query, params = {}) {
        const defaults = {
            UserId: this._userId,
            searchTerm: query,
            IncludeItemTypes: 'Movie,Series,Episode,BoxSet,MusicArtist,Artist,MusicAlbum,Audio',
            Limit: 50,
            Recursive: true,
            Fields: 'PrimaryImageAspectRatio'
        };

        return this.get('/Search/Hints', { ...defaults, ...params });
    }

    /**
     * Get favorite artists using the dedicated /Artists endpoint.
     * The /Items endpoint with IncludeItemTypes=MusicArtist doesn't properly
     * support the IsFavorite filter. /Artists does.
     * @param {Object} [params] - Additional query params
     * @returns {Promise<any>}
     */
    async getFavoriteArtists(params = {}) {
        const defaults = {
            UserId: this._userId,
            Filters: 'IsFavorite',
            SortBy: 'SortName',
            SortOrder: 'Ascending',
            Limit: 50,
            Fields: 'PrimaryImageAspectRatio,ProductionYear'
        };

        return this.get('/Artists', { ...defaults, ...params });
    }

    /**
     * Get all albums for an artist by their ID.
     * @param {string} artistId - The artist item ID
     * @param {Object} [params] - Additional query params
     * @returns {Promise<any>}
     */
    async getArtistAlbums(artistId, params = {}) {
        const defaults = {
            UserId: this._userId,
            ArtistIds: artistId,
            IncludeItemTypes: 'MusicAlbum',
            SortBy: 'ProductionYear,SortName',
            SortOrder: 'Descending',
            Recursive: true,
            Limit: 100,
            Fields: 'PrimaryImageAspectRatio,ProductionYear,AlbumArtist,Artists'
        };

        return this.get('/Items', { ...defaults, ...params });
    }

    /**
     * Get all songs for an artist by their ID.
     * @param {string} artistId - The artist item ID
     * @param {Object} [params] - Additional query params
     * @returns {Promise<any>}
     */
    async getArtistSongs(artistId, params = {}) {
        const defaults = {
            UserId: this._userId,
            ArtistIds: artistId,
            IncludeItemTypes: 'Audio',
            SortBy: 'SortName',
            SortOrder: 'Ascending',
            Recursive: true,
            Limit: 200,
            Fields: 'PrimaryImageAspectRatio,ProductionYear,AlbumArtist,Artists,RunTimeTicks'
        };

        return this.get('/Items', { ...defaults, ...params });
    }

    async searchPeople(query, params = {}) {
        const defaults = {
            UserId: this._userId,
            searchTerm: query,
            Limit: 24,
            Fields: 'PrimaryImageAspectRatio',
            Recursive: true,
            EnableTotalRecordCount: false
        };

        return this.get('/Persons', { ...defaults, ...params });
    }

    /**
     * Refresh metadata for an item
     * @param {string} itemId - Item ID
     * @param {Object} [options] - Refresh options
     * @returns {Promise<any>} Response
     */
    async refreshItem(itemId, options = {}) {
        const defaults = {
            Recursive: true,
            MetadataRefreshMode: 'Default',
            ImageRefreshMode: 'Default',
            ReplaceAllMetadata: false,
            ReplaceAllImages: false
        };

        return this.post(`/Items/${itemId}/Refresh`, null, {
            params: { ...defaults, ...options }
        });
    }

    // ========================================================================
    // Subtitle Endpoints
    // ========================================================================

    /**
     * Search for remote subtitles on the server's installed provider plugins.
     * The server aggregates results from all installed subtitle plugins (e.g. OpenSubtitles)
     * and returns them — the client needs no awareness of which providers are installed.
     *
     * GET /Items/{itemId}/RemoteSearch/Subtitles/{language}
     *
     * @param {string} itemId   - The Jellyfin item ID
     * @param {string} language - Three-letter ISO 639-2 language code (e.g. "eng", "fre")
     * @returns {Promise<Array>} Array of remote subtitle result objects
     */
    async searchSubtitles(itemId, language) {
        return this.get(`/Items/${itemId}/RemoteSearch/Subtitles/${language}`);
    }

    /**
     * Trigger a server-side download of a remote subtitle result.
     * The server downloads the file from the provider and attaches it to the item.
     *
     * POST /Items/{itemId}/RemoteSearch/Subtitles/{subtitleId}
     *
     * @param {string} itemId      - The Jellyfin item ID
     * @param {string} subtitleId  - The provider result ID (from searchSubtitles response)
     * @returns {Promise<null>}
     */
    async downloadSubtitle(itemId, subtitleId) {
        return this.post(`/Items/${itemId}/RemoteSearch/Subtitles/${subtitleId}`);
    }

    /**
     * Delete a local subtitle track (external .srt/.ass/etc. files only —
     * embedded internal subtitle streams cannot be deleted via this endpoint).
     *
     * DELETE /Videos/{itemId}/Subtitles/{index}
     *
     * @param {string} itemId - The Jellyfin item ID
     * @param {number} index  - The MediaStream index of the subtitle track
     * @returns {Promise<null>}
     */
    async deleteSubtitle(itemId, index) {
        return this.delete(`/Videos/${itemId}/Subtitles/${index}`);
    }

    // ========================================================================
    // Image URLs
    // ========================================================================

    getImageUrl(itemId, imageType = 'Primary', options = {}) {
        const params = new URLSearchParams();

        if (options.maxWidth) params.append('maxWidth', options.maxWidth);
        if (options.maxHeight) params.append('maxHeight', options.maxHeight);
        if (options.quality) params.append('quality', options.quality);
        if (options.tag) params.append('tag', options.tag);

        const queryString = params.toString();
        const path = `/Items/${itemId}/Images/${imageType}`;

        return this.buildUrl(queryString ? `${path}?${queryString}` : path);
    }

    getUserImageUrl(userId, options = {}) {
        const params = new URLSearchParams();

        if (options.maxWidth) params.append('maxWidth', options.maxWidth);
        if (options.maxHeight) params.append('maxHeight', options.maxHeight);
        if (options.quality) params.append('quality', options.quality);

        const queryString = params.toString();
        const path = `/Users/${userId}/Images/Primary`;

        return this.buildUrl(queryString ? `${path}?${queryString}` : path);
    }

    // ========================================================================
    // Playback Endpoints
    // ========================================================================

    async getPlaybackInfo(itemId, deviceProfile, options = {}) {
        const defaults = {
            UserId: this._userId,
            DeviceProfile: deviceProfile,
            AutoOpenLiveStream: true
        };
        return this.post(`/Items/${itemId}/PlaybackInfo`, { ...defaults, ...options });
    }

    // ========================================================================
    // Live TV Endpoints
    // ========================================================================

    async getLiveTvChannels(params = {}) {
        const defaults = {
            UserId: this._userId,
            EnableUserData: true,
            Fields: 'PrimaryImageAspectRatio,CanSelfRecord',
            EnableTotalRecordCount: false
        };
        return this.get('/LiveTv/Channels', { ...defaults, ...params });
    }

    async getLiveTvPrograms(params = {}) {
        const defaults = {
            UserId: this._userId,
            EnableUserData: true,
            Fields: 'PrimaryImageAspectRatio,CanSelfRecord',
            EnableTotalRecordCount: false
        };
        return this.get('/LiveTv/Programs', { ...defaults, ...params });
    }

    async getLiveTvRecommendedPrograms(params = {}) {
        const defaults = {
            UserId: this._userId,
            IsAiring: true,
            EnableUserData: true,
            Fields: 'PrimaryImageAspectRatio,CanSelfRecord',
            EnableTotalRecordCount: false,
            Limit: 24
        };
        return this.get('/LiveTv/Programs/Recommended', { ...defaults, ...params });
    }

    async getLiveTvRecordings(params = {}) {
        const defaults = {
            UserId: this._userId,
            Fields: 'PrimaryImageAspectRatio,CanSelfRecord,Status',
            EnableTotalRecordCount: false
        };
        return this.get('/LiveTv/Recordings', { ...defaults, ...params });
    }

    async getLiveTvRecording(recordingId) {
        return this.get(`/LiveTv/Recordings/${recordingId}`, { UserId: this._userId });
    }

    async getNewTimerDefaults(params = {}) {
        return this.get('/LiveTv/Timers/Defaults', params);
    }

    async createTimer(timer) {
        return this.post('/LiveTv/Timers', timer);
    }

    async cancelTimer(timerId) {
        return this.delete(`/LiveTv/Timers/${timerId}`);
    }

    async getSeriesTimers(params = {}) {
        return this.get('/LiveTv/SeriesTimers', params);
    }

    async getSeriesTimer(timerId) {
        return this.get(`/LiveTv/SeriesTimers/${timerId}`);
    }

    async createSeriesTimer(timer) {
        return this.post('/LiveTv/SeriesTimers', timer);
    }

    async cancelSeriesTimer(timerId) {
        return this.delete(`/LiveTv/SeriesTimers/${timerId}`);
    }

    /**
     * Open a live stream for a channel.
     * This is required before playback of any Live TV channel.
     * @param {Object} options - Playback options
     * @returns {Promise<Object>} Live stream result with MediaSource
     */
    async openLiveStream(options) {
        const body = {
            DeviceProfile: options.DeviceProfile,
            UserId: this._userId,
            OpenToken: options.OpenToken,
            PlaySessionId: options.PlaySessionId || Math.random().toString(36).substring(2, 15),
            MaxStreamingBitrate: options.MaxStreamingBitrate,
            StartTimeTicks: options.StartTimeTicks,
            AudioStreamIndex: options.AudioStreamIndex,
            SubtitleStreamIndex: options.SubtitleStreamIndex,
            DirectPlayProtocols: options.DirectPlayProtocols,
            EnableDirectPlay: options.EnableDirectPlay,
            EnableDirectStream: options.EnableDirectStream,
            ItemId: options.ItemId
        };

        const url = options.ItemId 
            ? `/LiveStreams/Open?ItemId=${options.ItemId}` 
            : '/LiveStreams/Open';

        return this.post(url, body);
    }

    /**
     * Close an active live stream.
     * @param {string} liveStreamId - The ID returned by openLiveStream
     */
    async closeLiveStream(liveStreamId) {
        return this.post('/LiveStreams/Close', null, { params: { liveStreamId } });
    }

    /**
     * Report device capabilities to the server
     * CRITICAL: Must be called after login to establish session
     * Without this, the server won't track playback status
     * @param {Object} capabilities - Device/app capabilities
     */
    async reportCapabilities(capabilities) {
        return this.post('/Sessions/Capabilities/Full', capabilities);
    }

    /**
     * Upload client logs to server
     * Endpoint: POST /ClientLog/Document
     */
    async uploadClientLog(name, data) {
        // Send raw text body, filename in query string
        const url = `/ClientLog/Document?name=${encodeURIComponent(name)}`;
        return this.post(url, data, {
            headers: {
                'Content-Type': 'text/plain'
            }
        });
    }

    async reportPlaybackStart(info) {
        return this.post('/Sessions/Playing', info);
    }

    async reportPlaybackProgress(info) {
        return this.post('/Sessions/Playing/Progress', info);
    }

    async reportPlaybackStopped(info) {
        // Use keepalive to ensure request completes even if app is closing
        return this.post('/Sessions/Playing/Stopped', info, { keepalive: true });
    }

    async deletePlaybackProgress(itemId) {
        return this.delete(`/Users/${this._userId}/Items/${itemId}/Resume`);
    }

    // ========================================================================
    // SyncPlay Endpoints
    // ========================================================================
    //
    // SyncPlay allows multiple clients to synchronize playback in a group.
    // The server acts as the clock authority — clients ping it for time offsets
    // and receive commands over WebSocket (SyncPlayCommand / SyncPlayGroupUpdate).
    //
    // Endpoint reference: /SyncPlay/* (Jellyfin API v10.8+)
    // ========================================================================

    /**
     * Fetch the server's current UTC time for SyncPlay clock synchronisation.
     *
     * Endpoint: GET /GetUTCTime
     * Returns a UtcTimeResponse body with:
     *   - RequestReceptionTime  : ISO8601 timestamp of when the server received our request
     *   - ResponseTransmissionTime : ISO8601 timestamp of when the server sent its response
     *
     * Confirmed from the official jellyfin-apiclient-python source:
     *   SyncPlayAPIMixin.utc_time() calls send_request(server_address, "GetUTCTime")
     * and reads response_obj["RequestReceptionTime"] / response_obj["ResponseTransmissionTime"].
     *
     * @returns {Promise<{RequestReceptionTime: string, ResponseTransmissionTime: string}>}
     */
    async getServerTime() {
        return this.get('/GetUTCTime');
    }

    /**
     * Create a new SyncPlay group.
     * POST /SyncPlay/New
     * @param {Object} [body] - Optional group creation parameters
     */
    async syncPlayNew(body = {}) {
        return this.post('/SyncPlay/New', body);
    }

    /**
     * Join an existing SyncPlay group.
     * POST /SyncPlay/Join
     * @param {Object} body - Must include { GroupId: string }
     */
    async syncPlayJoin(body) {
        return this.post('/SyncPlay/Join', body);
    }

    /**
     * Leave the current SyncPlay group.
     * POST /SyncPlay/Leave
     */
    async syncPlayLeave() {
        return this.post('/SyncPlay/Leave', {});
    }

    /**
     * Get a list of all available SyncPlay groups on the server.
     * GET /SyncPlay/List
     * @returns {Promise<Array>} Array of group info objects
     */
    async syncPlayList() {
        return this.get('/SyncPlay/List');
    }

    /**
     * Send a time-sync ping to the server.
     * The server echoes back with RequestReceptionTime and ResponseTransmissionTime
     * so the client can compute its clock offset.
     *
     * POST /SyncPlay/Ping
     * @param {string} pingTime - ISO8601 timestamp of when the ping was sent
     */
    async syncPlayPing(pingTime) {
        return this.post('/SyncPlay/Ping', { When: pingTime });
    }

    /**
     * Notify the server that this client is buffering (not yet ready to play).
     * Other group members will be asked to wait.
     *
     * POST /SyncPlay/Buffering
     * @param {Object} body - { When, PositionTicks, IsPlaying, PlaylistItemId }
     */
    async syncPlayBuffering(body) {
        return this.post('/SyncPlay/Buffering', body);
    }

    /**
     * Notify the server that this client is ready to play after buffering.
     *
     * POST /SyncPlay/Ready
     * @param {Object} body - { When, PositionTicks, IsPlaying, PlaylistItemId }
     */
    async syncPlayReady(body) {
        return this.post('/SyncPlay/Ready', body);
    }

    // ========================================================================
    // SyncPlay Host Controls
    // ========================================================================

    async syncPlayPlay(options = {}) {
        return this.post('/SyncPlay/Play', { body: JSON.stringify(options) });
    }

    async syncPlayUnpause(options = {}) {
        // In fully conforming 10.7+ servers, Unpause is preferred for resuming from Pause
        return this.post('/SyncPlay/Unpause', options);
    }

    async syncPlayPause(options = {}) {
        return this.post('/SyncPlay/Pause', options);
    }

    async syncPlaySeek(positionTicks) {
        return this.post('/SyncPlay/Seek', { PositionTicks: positionTicks });
    }

    async syncPlayStop(options = {}) {
        return this.post('/SyncPlay/Stop', options);
    }

    async syncPlayNext() {
        return this.post('/SyncPlay/NextItem');
    }

    async syncPlayPrevious() {
        return this.post('/SyncPlay/PreviousItem');
    }

    /**
     * Skip waiting for buffering clients (group leader action).
     * Tells the server to proceed with playback even if some clients are still
     * buffering — useful when a slow client is holding up the whole group.
     *
     * POST /SyncPlay/IgnoreWait
     * @param {Object} body - { IgnoreWait: boolean }
     */
    async syncPlayIgnoreWait(body) {
        return this.post('/SyncPlay/IgnoreWait', body);
    }

    // ========================================================================
    // Favorites Endpoints
    // ========================================================================

    async markFavorite(itemId) {
        return this.post(`/Users/${this._userId}/FavoriteItems/${itemId}`);
    }

    async unmarkFavorite(itemId) {
        return this.delete(`/Users/${this._userId}/FavoriteItems/${itemId}`);
    }

    async markPlayed(itemId) {
        return this.post(`/Users/${this._userId}/PlayedItems/${itemId}`);
    }

    async unmarkPlayed(itemId) {
        return this.delete(`/Users/${this._userId}/PlayedItems/${itemId}`);
    }

    // ========================================================================
    // WebSocket Connection (for online/offline status)
    // ========================================================================

    /**
     * Open WebSocket connection to server
     * This maintains the "online" status on the Jellyfin dashboard
     * When WebSocket connects, server marks user online
     * When WebSocket disconnects, server marks user offline
     */
    openWebSocket() {
        // Must have server URL and access token
        if (!this._serverUrl || !this._accessToken) {
            log.warn('Cannot open WebSocket - not authenticated');
            return;
        }

        // Already connected
        if (this._webSocket && this._webSocket.readyState === WebSocket.OPEN) {
            log.info('WebSocket already connected');
            return;
        }

        // Close any existing connection
        this.closeWebSocket();

        // Convert http(s) to ws(s)
        const wsUrl = this._serverUrl.replace('https://', 'wss://').replace('http://', 'ws://');

        // Build WebSocket URL with auth
        const fullUrl = `${wsUrl}/socket?api_key=${encodeURIComponent(this._accessToken)}&deviceId=${encodeURIComponent(this._deviceId)}`;

        log.info('Opening WebSocket connection...');

        try {
            this._webSocket = new WebSocket(fullUrl);

            // Connection opened
            this._webSocket.onopen = () => {
                log.info('WebSocket connected - user is now online');
                eventBus.emit('websocket:connected');

                // Start keepalive ping interval (every 30 seconds)
                this._startWebSocketKeepalive();
            };

            // Message received (for remote control commands, etc.)
            this._webSocket.onmessage = (event) => {
                try {
                    const message = JSON.parse(event.data);
                    // Emit message for other parts of app to handle if needed
                    eventBus.emit('websocket:message', message);
                } catch (e) {
                    // Ignore non-JSON messages (keepalive responses, etc.)
                }
            };

            // Connection closed
            this._webSocket.onclose = (event) => {
                log.info('WebSocket disconnected - user appears offline');
                this._stopWebSocketKeepalive();
                eventBus.emit('websocket:disconnected');

                // Attempt to reconnect if we still have credentials and the app is visible
                if (this._serverUrl && this._accessToken && !document.hidden) {
                    log.info('Scheduling WebSocket reconnect in 5 seconds...');
                    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
                    this._reconnectTimer = setTimeout(() => {
                        if (!this.isWebSocketConnected) {
                            log.info('Attempting to reconnect WebSocket...');
                            this.openWebSocket();
                        }
                    }, 5000);
                }
            };

            // Connection error
            this._webSocket.onerror = (error) => {
                log.warn('WebSocket error:', error);
                this._stopWebSocketKeepalive();
            };
        } catch (e) {
            log.error('Failed to create WebSocket:', e);
        }
    }

    /**
     * Close WebSocket connection
     * This will cause the server to mark the user as offline
     */
    closeWebSocket() {
        this._stopWebSocketKeepalive();

        if (this._webSocket) {
            log.info('Closing WebSocket connection');
            this._webSocket.onclose = null; // Prevent event handler from firing
            this._webSocket.close();
            this._webSocket = null;
        }
    }

    /**
     * Start keepalive ping to maintain connection
     * Sends a KeepAlive message every 30 seconds
     * @private
     */
    _startWebSocketKeepalive() {
        this._stopWebSocketKeepalive(); // Clear any existing interval

        this._keepaliveInterval = setInterval(() => {
            if (this._webSocket && this._webSocket.readyState === WebSocket.OPEN) {
                // Send Jellyfin-style keepalive message
                this._webSocket.send(JSON.stringify({ MessageType: 'KeepAlive' }));
            }
        }, 30000); // 30 seconds
    }

    /**
     * Stop keepalive ping
     * @private
     */
    _stopWebSocketKeepalive() {
        if (this._keepaliveInterval) {
            clearInterval(this._keepaliveInterval);
            this._keepaliveInterval = null;
        }
    }

    /**
     * Check if WebSocket is connected
     * @returns {boolean} True if connected
     */
    get isWebSocketConnected() {
        return this._webSocket && this._webSocket.readyState === WebSocket.OPEN;
    }

    // ========================================================================
    // Getters
    // ========================================================================

    get isAuthenticated() {
        return !!this._accessToken;
    }
}

// ============================================================================
// Server Discovery
// ============================================================================

/**
 * Test if an address is a valid Jellyfin server.
 *
 * Uses XMLHttpRequest instead of fetch() + AbortController because:
 *   - AbortController requires Chrome 66+
 *   - WebOS 4 ships Chromium 53, Tizen 3.0 ships Chromium 47
 *   - Without a working abort, fetch() hangs until OS TCP timeout (~60-120s)
 *     which makes subnet scanning unbearably slow on older platforms
 *   - XHR.timeout is a native hard-kill supported since Chrome 29
 */
export function testServer(address, timeout = 1000, parentSignal = null) {
    return new Promise((resolve) => {
        const xhr = new XMLHttpRequest();

        // Hard-kill the request at the OS level after `timeout` ms.
        // This is the key fix — unlike AbortController, xhr.timeout works on
        // Chromium 29+ and actually terminates the underlying TCP connection.
        xhr.timeout = timeout;

        function done(result) {
            // Cleanup the parent signal listener before resolving
            if (parentSignal && onParentAbort) {
                parentSignal.removeEventListener('abort', onParentAbort);
            }
            resolve(result);
        }

        // If the parent discovery scan was cancelled, abort this probe too
        const onParentAbort = () => {
            xhr.abort();
            done(null);
        };

        if (parentSignal) {
            // Already cancelled before we even started
            if (parentSignal.aborted) {
                resolve(null);
                return;
            }
            parentSignal.addEventListener('abort', onParentAbort, { once: true });
        }

        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) return;

            if (xhr.status !== 200) {
                done(null);
                return;
            }

            try {
                const info = JSON.parse(xhr.responseText);

                let serverName = info.ServerName;
                if (!serverName || serverName.trim() === '') {
                    // Fall back to hostname extracted from the address URL
                    try {
                        serverName = new URL(address).hostname;
                    } catch (_) {
                        serverName = 'Jellyfin Server';
                    }
                }

                done({
                    address: address,
                    name: serverName,
                    id: info.Id,
                    version: info.Version,
                    operatingSystem: info.OperatingSystem
                });
            } catch (_) {
                // Malformed JSON from the server — not a Jellyfin instance
                done(null);
            }
        };

        // Both timeout and network errors resolve to null (not found)
        xhr.ontimeout = () => done(null);
        xhr.onerror = () => done(null);

        xhr.open('GET', `${address}/System/Info/Public`, /* async */ true);
        xhr.send();
    });
}

let activeDiscoveryController = null;

/**
 * Cancel any active discovery process
 */
export function cancelDiscovery() {
    if (activeDiscoveryController) {
        log.info('Cancelling discovery scan...');
        activeDiscoveryController.abort();
        activeDiscoveryController = null;
    }
}

/**
 * Attempt Jellyfin server discovery via the WebOS Luna background service.
 *
 * The service performs a native UDP broadcast on port 7359 and pushes
 * discovered servers to us in real time via a Luna subscription.
 *
 * @param {Function|null} onServerFound  Called immediately each time a server
 *                                        is discovered (same API as discoverServers).
 * @returns {Promise<Array|null>}  Resolves with an array of found servers if
 *                                  the Luna service is reachable (may be empty),
 *                                  or null if the service could not be contacted
 *                                  (caller should fall back to HTTP scan).
 */
/**
 * Attempt Jellyfin server discovery via the Tizen background service HTTP endpoint.
 *
 * The Tizen service doesn't have a push bus like WebOS Luna, so instead we
 * expose a simple GET /discover endpoint on the local HTTP proxy.  The service
 * creates a one-shot UDP socket, broadcasts the autodiscovery probe, waits 3
 * seconds for responses, then returns the found servers as JSON.
 *
 * This avoids the ~10 second HTTP subnet scan for users who have the background
 * service enabled.
 *
 * @param {Function|null} onServerFound  Called immediately for each discovered server.
 * @returns {Promise<Array|null>}  Array of found servers, or null if the service
 *                                  is unreachable (fall through to HTTP scan).
 */
async function _discoverViaTizenService(onServerFound) {
    return new Promise(function (resolve) {
        let settled = false;
        const foundServers = [];
        let es = null;

        // Fallback timeout in case the service hangs or never boots
        const timeout = setTimeout(function () {
            if (settled) return;
            settled = true;
            if (es) es.close();
            log.warn('Tizen /discover: request timed out — falling back to HTTP scan');
            resolve(foundServers.length > 0 ? foundServers : null);
        }, 4200);

        function connect() {
            if (settled) return;

            /*
             * Tizen /discover endpoint returns a text/event-stream (SSE).
             * This allows servers to be pushed to the UI instantly.
             */
            es = new EventSource('http://localhost:8123/discover');

            es.onmessage = function (event) {
                try {
                    const srv = JSON.parse(event.data);
                    const serverInfo = {
                        address: srv.Address,
                        name:    srv.Name,
                        id:      srv.Id
                    };
                    log.info('Tizen /discover: found "' + srv.Name + '" at ' + srv.Address);
                    foundServers.push(serverInfo);
                    if (onServerFound) onServerFound(serverInfo);
                } catch (err) {
                    log.warn('Tizen /discover: parse error ' + err.message);
                }
            };

            es.onerror = function () {
                if (settled) return;
                es.close(); // Prevent slow native auto-reconnect

                if (foundServers.length > 0) {
                    // Stream successfully completed its 3-second cycle
                    settled = true;
                    clearTimeout(timeout);
                    log.info('Tizen /discover: stream complete — ' + foundServers.length + ' server(s) found');
                    resolve(foundServers);
                } else {
                    // Connection refused — service is likely still booting.
                    // Retry rapidly until the 4.2s global timeout hits.
                    setTimeout(connect, 200);
                }
            };
        }

        connect();
    });
}

async function _discoverViaLunaService(onServerFound) {
    return new Promise((resolve) => {
        const foundServers = [];
        let settled = false;

        /*
         * Two-phase timeout strategy:
         *
         * Phase 1 — SERVICE_ALIVE_TIMEOUT_MS (1 second)
         *   If onSuccess hasn't fired at all within 1s, the background service
         *   is not running (emulator, service not installed, etc.).
         *   Resolve null immediately → HTTP scan fallback kicks in within ~1s.
         *   On real hardware the service responds in <100ms, so 1s is generous.
         *
         * Phase 2 — DISCOVERY_WINDOW_MS (3 seconds)
         *   Once onSuccess fires (service confirmed alive), start a 3s window
         *   to collect UDP server responses before resolving with the results.
         */
        const SERVICE_ALIVE_TIMEOUT_MS = 1000;
        const DISCOVERY_WINDOW_MS = 3000;

        // Phase 1: fast-fail if the service never responds
        const serviceAliveTimeout = setTimeout(() => {
            if (!settled) {
                log.warn('Luna service timed out — no response received');
                settled = true;
                resolve(null);
            }
        }, SERVICE_ALIVE_TIMEOUT_MS);

        let request;
        try {
            request = window.webOS.service.request('luna://org.litefin.app.service', {
                method: 'discover',
                parameters: { subscribe: true },

                onSuccess(response) {
                    if (settled) return;

                    // First success response = service is alive; cancel the phase-1 timer
                    // and start the 3s collection window to gather UDP server responses.
                    if (!settled && foundServers.length === 0) {
                        clearTimeout(serviceAliveTimeout);
                        setTimeout(() => {
                            if (!settled) {
                                settled = true;
                                try {
                                    request && request.cancel();
                                } catch (_) {}
                                resolve(foundServers);
                            }
                        }, DISCOVERY_WINDOW_MS);
                    }

                    // Parse servers from the response map ({ [serverId]: serverInfo })
                    if (response && response.results) {
                        Object.values(response.results).forEach((srv) => {
                            if (!foundServers.find((s) => s.id === srv.Id)) {
                                const serverInfo = {
                                    address: srv.Address,
                                    name: srv.Name,
                                    id: srv.Id
                                };
                                log.info(`Luna: discovered "${srv.Name}" at ${srv.Address}`);
                                foundServers.push(serverInfo);
                                if (onServerFound) onServerFound(serverInfo);
                            }
                        });
                    }
                },

                onFailure(err) {
                    if (settled) return;
                    settled = true;
                    clearTimeout(serviceAliveTimeout);
                    log.warn(`Luna service request failed: ${err.errorText || JSON.stringify(err)}`);
                    // null signals "service unavailable, try HTTP scan"
                    resolve(null);
                }
            });
        } catch (err) {
            // webOS.service.request itself threw — service API not available
            log.warn(`Luna service API not available: ${err}`);
            clearTimeout(serviceAliveTimeout);
            resolve(null);
        }
    });
}

/**
 * Discover Jellyfin servers on local network
 */
export async function discoverServers(onProgress = null, onServerFound = null) {
    // Cancel any existing scan first
    cancelDiscovery();

    log.info('Starting server discovery...');

    /*
     * =========================================================================
     * WebOS Fast Path: Native UDP Discovery via Luna Service
     * =========================================================================
     * WebOS background services run in Node.js and have access to raw UDP
     * sockets. Our `org.litefin.app.service/discover` service broadcasts the
     * Jellyfin autodiscovery probe on UDP port 7359 and pushes results
     * instantly via the Luna bus.
     *
     * This yields results in <1 second vs the ~10s HTTP subnet scan on WebOS.
     * If the service isn't available (emulators, older WebOS) we fall through
     * to the standard HTTP scan below.
     * =========================================================================
     */
    if (typeof tizen === 'undefined' && typeof window.webOS !== 'undefined' && window.webOS.service) {
        log.info('WebOS detected — trying Luna discovery service first...');

        const lunaServers = await _discoverViaLunaService(onServerFound);

        if (lunaServers !== null) {
            // Luna service responded — skip the HTTP scan entirely
            log.info(`Luna discovery complete: ${lunaServers.length} server(s) found`);
            return lunaServers;
        }

        log.warn('Luna service unavailable — falling back to HTTP scan');
    }

    /*
     * =========================================================================
     * Tizen Fast Path: Native UDP Discovery via HTTP Proxy Service
     * =========================================================================
     * The Tizen background service (service.js) exposes a GET /discover
     * endpoint on localhost:8123.  It fires the same UDP broadcast as the
     * WebOS service and returns discovered servers as JSON after a 3-second
     * collection window.
     *
     * Only attempt this when:
     *   a) Running on Tizen (the `tizen` global is defined), AND
     *   b) The background service is enabled in PlayerSettings
     *      (it is on by default — checking the setting avoids a hanging
     *       XHR in the off chance the user has disabled it in settings).
     *
     * If the endpoint does not respond within its timeout (service not running,
     * WGT not repackaged yet, etc.) we fall through to the HTTP scan below so
     * the user still gets discovery — just slower.
     * =========================================================================
     */
    if (typeof tizen !== 'undefined') {
        const { PlayerSettings } = await import('../utils/PlayerSettings.js');
        const bgEnabled = PlayerSettings.get('enableBackgroundService') !== false;

        if (bgEnabled) {
            log.info('Tizen detected — trying /discover service endpoint...');

            const tizenServers = await _discoverViaTizenService(onServerFound);

            if (tizenServers !== null) {
                log.info(`Tizen /discover complete: ${tizenServers.length} server(s) found`);
                return tizenServers;
            }

            log.warn('Tizen /discover unavailable — falling back to HTTP scan');
        } else {
            log.info('Background service disabled — skipping Tizen /discover, using HTTP scan');
        }
    }

    // =========================================================================
    // Standard HTTP scan (Tizen, web browsers, WebOS emulators)
    // =========================================================================
    activeDiscoveryController = new AbortController();
    const signal = activeDiscoveryController.signal;

    const foundServers = [];
    const scannedIps = new Set();

    // 1. Identify unique subnets to scan
    const subnets = new Set();

    // Local subnet
    const localIP = await tizenAdapter.getIPAddress();
    if (localIP) {
        const parts = localIP.split('.');
        if (parts.length === 4) {
            subnets.add(`${parts[0]}.${parts[1]}.${parts[2]}.`);
        }
    }

    // Common subnets
    ['192.168.1.', '192.168.0.', '10.0.0.'].forEach((s) => subnets.add(s));

    const uniqueSubnets = Array.from(subnets);
    const totalIPs = uniqueSubnets.length * 254;
    let globalScannedCount = 0;

    log.debug(`Scanning ${uniqueSubnets.length} subnets (${totalIPs} IPs total)`);

    const scanSubnet = async (prefix) => {
        const batch = [];
        for (let i = 1; i < 255; i++) {
            const ip = `http://${prefix}${i}:8096`;
            if (!scannedIps.has(ip)) {
                batch.push(ip);
                scannedIps.add(ip);
            }
        }

        /*
         * CHUNK_SIZE controls how many IPs are probed in parallel per round.
         * Higher = faster scan but more concurrent connections.
         * 30 is a safe ceiling for WebOS/Tizen embedded browsers.
         *
         * Timeout is 400ms — a real LAN server answers in <50ms,
         * so this is generous while cutting worst-case scan time roughly in half
         * vs the previous 800ms.
         */
        const CHUNK_SIZE = 30;
        for (let i = 0; i < batch.length; i += CHUNK_SIZE) {
            if (signal.aborted) return;

            const chunk = batch.slice(i, i + CHUNK_SIZE);
            const results = await Promise.all(chunk.map((addr) => testServer(addr, 400, signal)));

            results
                .filter((s) => s)
                .forEach((s) => {
                    if (!foundServers.find((existing) => existing.address === s.address)) {
                        log.info(`Found server at ${s.address}`);
                        foundServers.push(s);
                        if (onServerFound) onServerFound(s);
                    }
                });

            globalScannedCount += chunk.length;
            if (onProgress) onProgress(globalScannedCount, totalIPs);

            // Small yield to let UI breathe
            await new Promise((r) => setTimeout(r, 10));
        }
    };

    // Execute scans sequentially to avoid flooding network on weak TV hardware
    for (const subnet of uniqueSubnets) {
        if (signal.aborted) break;
        log.debug(`Scanning subnet ${subnet}x`);
        await scanSubnet(subnet);
    }

    if (signal.aborted) {
        log.info('Discovery cancelled');
    } else {
        log.info(`Discovery complete. Found ${foundServers.length} server(s)`);
    }

    if (activeDiscoveryController?.signal === signal) {
        activeDiscoveryController = null;
    }

    return foundServers;
}

// Create singleton instance
export const api = new ApiClient();

// Default export is the api instance for convenience
export default api;
