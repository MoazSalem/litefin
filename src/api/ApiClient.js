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
import { storage } from '../utils/StorageService.js';

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

        // ── ETag Response Cache ───────────────────────────────────────────
        // In-memory cache of { etag, body } keyed by full request URL.
        // Used to send If-None-Match on GET requests and short-circuit to 304
        // cached data when the server reports no change.
        this._etagCache = new Map();
        this._etagCacheMaxSize = 20;
    }

    // ========================================================================
    // Properties
    // ========================================================================
    get clientName() {
        return this._clientName;
    }
    get deviceName() {
        return this._deviceName;
    }
    get deviceId() {
        return this._deviceId;
    }
    get clientVersion() {
        return this._clientVersion;
    }
    get serverUrl() {
        return this._serverUrl;
    }
    get accessToken() {
        return this._accessToken;
    }
    get userId() {
        return this._userId;
    }

    /**
     * Check if the currently connected server is an Emby instance.
     * We determine this by checking the public product name returned
     * during the initial server discovery/handshake.
     *
     * @returns {boolean} True if the server identifies as Emby.
     */
    isEmby() {
        /*
         * Retrieve the server information stored in global application state.
         * Emby does not return a 'ProductName' in its public (unauthenticated)
         * System Info response, whereas Jellyfin does. We detect Emby by checking
         * if the server returns a ServerName but omits ProductName, or if the
         * ProductName explicitly contains 'emby'.
         */
        const info = state.get('server:info') || {};
        return !!(info.ServerName && (!info.ProductName || info.ProductName.toLowerCase().includes('emby')));
    }

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

        // Wipe ETag cache — cached responses are bound to the previous auth session
        this._etagCache.clear();

        // Wipe page caches — stale data bound to the previous auth session
        state.clearByPrefix('details:');
        state.clearByPrefix('home:');

        log.info('Authentication cleared');
    }

    /**
     * Clear the ETag response cache. Call after playback or server data mutations
     * to ensure the next request fetches fresh data instead of a 304-stale body.
     */
    clearEtagCache() {
        this._etagCache.clear();
        log.debug('ETag cache cleared');
    }

    // ========================================================================
    // Header Management
    // ========================================================================

    /**
     * Build the Authorization header value using the Jellyfin MediaBrowser scheme.
     * This is the current, non-deprecated way to authorize all authenticated requests.
     * Format: MediaBrowser Client="...", Device="...", DeviceId="...", Version="...[, Token="..."]
     * @returns {string} Authorization header value
     */
    getAuthHeader(tokenOverride = null) {
        /*
         * Check if we are connected to an Emby server instance.
         * Emby handles the Authorization header differently than Jellyfin.
         */
        if (this.isEmby()) {
            /*
             * Emby auth header format uses the 'Emby' scheme.
             * It requires 'UserId' (if authenticated) but does NOT carry the
             * 'Token' inside the Authorization header itself. Instead, the token
             * is transmitted in the separate 'X-Emby-Token' request header.
             */
            const parts = [
                `Client="${this._clientName}"`,
                `Device="${this._deviceName}"`,
                `DeviceId="${this._deviceId}"`,
                `Version="${this._clientVersion}"`
            ];

            // Append UserId only if the session is fully authenticated
            if (this._userId) {
                parts.unshift(`UserId="${this._userId}"`);
            }

            return `Emby ${parts.join(', ')}`;
        }

        /*
         * Standard Jellyfin MediaBrowser authorization header.
         * Formatted with the MediaBrowser scheme containing Client, Device,
         * DeviceId, Version, and optionally the Token parameter.
         */
        const parts = [
            `Client="${this._clientName}"`,
            `Device="${this._deviceName}"`,
            `DeviceId="${this._deviceId}"`,
            `Version="${this._clientVersion}"`
        ];

        /*
         * Retrieve the active authentication token from memory
         * or fallback to the provided token override.
         */
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

        // Conditionally request quality/resolution metadata if enabled
        if (storage.getItem('pref:showQualityBadges') === 'true' && options.params) {
            const fieldsKey = Object.keys(options.params).find((k) => k.toLowerCase() === 'fields');
            const isItemsEndpoint =
                endpoint.includes('/Items') ||
                endpoint.includes('/Latest') ||
                endpoint.includes('/Resume') ||
                endpoint.includes('/NextUp') ||
                endpoint.includes('/Upcoming') ||
                endpoint.includes('/Similar') ||
                endpoint.includes('/Episodes') ||
                endpoint.includes('/Search/Hints');

            if (isItemsEndpoint) {
                const targetKey = fieldsKey || 'Fields';
                const fieldsList = (options.params[targetKey] || '').split(',').filter(Boolean);
                ['Width', 'Height', 'VideoRange', 'MediaSources'].forEach((f) => {
                    if (!fieldsList.includes(f)) {
                        fieldsList.push(f);
                    }
                });
                options.params[targetKey] = fieldsList.join(',');
            }
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

        // ── ETag cache lookup ──────────────────────────────────────────────
        // For GET requests, check if we have a cached ETag and send
        // If-None-Match so the server can respond with 304 if unchanged.
        let etagEntry = null;
        if (method === 'GET') {
            etagEntry = this._etagCache.get(url) || null;
        }

        // Build headers
        const headers = {
            Accept: 'application/json', // Explicitly request JSON response
            ...options.headers
        };

        // Add If-None-Match header if we have a cached ETag for this URL
        if (etagEntry && etagEntry.etag) {
            headers['If-None-Match'] = etagEntry.etag;
        }

        if (!options.skipAuth) {
            /*
             * Fetch the formatted authorization header.
             * For Jellyfin, this contains client/device info plus the auth token.
             * For Emby, it contains client/device/user info, but NO token.
             */
            const authHeader = this.getAuthHeader();
            headers['Authorization'] = authHeader;

            /*
             * Emby servers require the token to be explicitly supplied via
             * the dedicated 'X-Emby-Token' request header on authenticated endpoints.
             */
            if (this.isEmby() && this._accessToken) {
                headers['X-Emby-Token'] = this._accessToken;
            }
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
            // IMPORTANT: keepalive requests (e.g. reportPlaybackStopped) must NOT
            // have an AbortSignal — the Fetch spec throws a TypeError when both
            // keepalive:true and signal are present. We skip the timeout entirely
            // for keepalive requests since they complete in the background anyway.
            const timeout = options.timeout || (options.keepalive ? 0 : REQUEST_TIMEOUT);
            const controller = new AbortController();
            const timeoutId = timeout ? setTimeout(() => controller.abort(), timeout) : null;
            if (timeout) {
                fetchOptions.signal = controller.signal;
            }

            log.debug(`Fetching ${url} (timeout: ${timeout || 'none'}ms)...`);
            const response = await fetch(url, fetchOptions);
            if (timeoutId) clearTimeout(timeoutId);

            // Handle 304 Not Modified — return cached response body
            if (response.status === 304 && etagEntry) {
                log.debug(`304 ${endpoint} — returning cached response`);
                return etagEntry.body;
            }

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
            let body;
            if (contentType && contentType.includes('application/json')) {
                body = await response.json();
            } else {
                body = await response.text();
            }

            // Cache ETag for GET requests so subsequent calls can use
            // If-None-Match / 304 short-circuit when data hasn't changed.
            if (method === 'GET') {
                const etag = response.headers.get('ETag');
                if (etag && body !== undefined && body !== null) {
                    if (this._etagCache.size >= this._etagCacheMaxSize) {
                        const firstKey = this._etagCache.keys().next().value;
                        this._etagCache.delete(firstKey);
                    }
                    this._etagCache.set(url, { etag, body });
                }
            }

            return body;
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

                // =============================================================
                // WAKE-ON-LAN ON REQUEST TIMEOUT / UNREACHABLE RETRY
                // =============================================================
                // If the user has enabled Wake-on-LAN on timeout and provided
                // a valid MAC address, send a magic packet and retry the probe.
                // =============================================================
                const wolTimeoutEnabled = storage.getItem('pref:enableWolOnTimeout') === 'true';
                const wolMac = storage.getItem('pref:wolMacAddress');

                if (wolTimeoutEnabled && wolMac && !options._isWolTimeoutRetry) {
                    log.info(`Request failed/timed out. Wake-on-LAN on timeout active. Broadcasting packet to ${wolMac}...`);

                    try {
                        // Send Wake-on-LAN Magic Packet
                        sendWakeOnLan(wolMac).catch((wolErr) => log.warn('Failed to send WOL packet on timeout:', wolErr));

                        // Retry loop: probe server status every 3s for up to 5 attempts (~15 seconds)
                        const maxAttempts = 5;
                        const retryDelayMs = 3000;

                        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                            log.info(`Probing server status post-WOL (attempt ${attempt}/${maxAttempts})...`);
                            await new Promise((resolve) => setTimeout(resolve, retryDelayMs));

                            try {
                                const testUrl = `${this._serverUrl}/System/Info/Public`;
                                const testRes = await fetch(testUrl, {
                                    method: 'GET',
                                    headers: { Accept: 'application/json' }
                                });

                                if (testRes.ok) {
                                    log.info('Server responded to status probe! Re-executing failed API request...');
                                    // Re-run original request with _isWolTimeoutRetry flag set to prevent recursion loops
                                    return await this.request(endpoint, { ...options, _isWolTimeoutRetry: true }, isRetry);
                                }
                            } catch (probeErr) {
                                log.debug(`Server status probe ${attempt}/${maxAttempts} failed — server still booting...`);
                            }
                        }
                    } catch (wolCycleErr) {
                        log.warn('Error during WOL timeout recovery cycle:', wolCycleErr);
                    }
                }

                const networkError = new ServerUnreachableError(`${msg}. Please check your network and server status.`);
                eventBus.emit('api:offline', { url: this._serverUrl, isTimeout });
                throw networkError;
            }

            if (options.warnOnError) {
                log.warn(`Request to ${endpoint} failed (suppressed):`, error.message || error);
            } else {
                log.error(`Request to ${endpoint} failed:`, error.message || error);
                eventBus.emit('api:error', { endpoint, error });
            }
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
            Fields: 'BackdropImageTags,ParentBackdropImageTags',
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
            Fields: 'BackdropImageTags,ParentBackdropImageTags',
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
            Fields: 'SeriesThumbImageTag,ParentThumbImageTag,BackdropImageTags,ParentBackdropImageTags',
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
            Limit: limit
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
            Limit: limit
        });
    }

    /**
     * Get next up episodes
     */
    async getNextUp(params = {}) {
        const defaults = {
            UserId: this._userId,
            Limit: 24,
            Fields: 'SeriesThumbImageTag,ParentThumbImageTag,BackdropImageTags,ParentBackdropImageTags',
            ImageTypeLimit: 1,
            EnableImageTypes: 'Primary,Backdrop,Thumb'
        };

        return this.get('/Shows/NextUp', { ...defaults, ...params });
    }

    /**
     * Get merged continue watching and next up items from the Litefin plugin on the server.
     * This calls the custom Litefin plugin controller to return a pre-merged deduplicated list.
     *
     * @param {Object} [params] - Query parameters such as limit
     * @returns {Promise<Object>} Object containing the merged items list
     */
    async getMergedRows(params = {}) {
        // Query the custom plugin controller route directly on the server
        return this.get('/Litefin/MergedRows/ContinueAndNextUp', params);
    }

    /**
     * Get upcoming episodes for a library
     */
    async getUpcoming(params = {}) {
        const defaults = {
            UserId: this._userId,
            Limit: 48,
            Fields: 'AirTime',
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
            Fields: 'DateCreated'
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
            Fields: 'UserData,RunTimeTicks',
            EnableImageTypes: 'Primary,Backdrop,Thumb',
            ...params
        });
    }

    /**
     * Create a new playlist and optionally add items to it.
     * POST /Playlists
     * @param {string} name     - Playlist name
     * @param {boolean} isPublic - Whether the playlist is publicly visible
     * @param {string[]} itemIds - Item IDs to add to the new playlist
     * @returns {Promise<Object>} Created playlist object with Id
     */
    async createPlaylist(name, isPublic, itemIds) {
        return this.post('/Playlists', {
            Name: name,
            IsPublic: isPublic,
            Ids: itemIds,
            UserId: this._userId
        });
    }

    /**
     * Add one or more items to an existing playlist.
     * POST /Playlists/{playlistId}/Items?ids=...
     * @param {string} playlistId - Target playlist ID
     * @param {string[]} itemIds  - Item IDs to add
     * @returns {Promise<void>}
     */
    async addToPlaylist(playlistId, itemIds) {
        const qs = itemIds.map((id) => `Ids=${encodeURIComponent(id)}`).join('&');
        return this.post(`/Playlists/${playlistId}/Items?${qs}&UserId=${encodeURIComponent(this._userId)}`);
    }

    /**
     * Create a new collection (BoxSet) and optionally add items to it.
     * POST /Collections?userId=...&name=...&ids=...
     * @param {string} name     - Collection name
     * @param {string[]} itemIds - Item IDs to add to the new collection
     * @returns {Promise<Object>} Created collection object with Id
     */
    async createCollection(name, itemIds) {
        const qs = itemIds.map((id) => `Ids=${encodeURIComponent(id)}`).join('&');
        return this.post(
            `/Collections?UserId=${encodeURIComponent(this._userId)}&Name=${encodeURIComponent(name)}&${qs}`
        );
    }

    /**
     * Add one or more items to an existing collection (BoxSet).
     * POST /Collections/{collectionId}/Items?ids=...
     * @param {string} collectionId - Target collection ID
     * @param {string[]} itemIds    - Item IDs to add
     * @returns {Promise<void>}
     */
    async addToCollection(collectionId, itemIds) {
        const qs = itemIds.map((id) => `Ids=${encodeURIComponent(id)}`).join('&');
        return this.post(`/Collections/${collectionId}/Items?${qs}&UserId=${encodeURIComponent(this._userId)}`);
    }

    /**
     * Gets the collections that include the specified item.
     * Tries the native Jellyfin endpoint (/Items/{itemId}/Collections) first.
     * If the server returns a 404 (meaning it's an older server like 10.11),
     * it falls back to the custom Litefin plugin endpoint (/Litefin/Items/{itemId}/Collections).
     *
     * @param {string} itemId - The target item ID
     * @param {Object} [params] - Query parameters such as Fields, StartIndex, Limit
     * @returns {Promise<Object>} collections query result
     */
    async getItemCollections(itemId, params = {}) {
        const defaults = {
            userId: this._userId
        };

        try {
            // Attempt to fetch from native Jellyfin endpoint (available in newer servers)
            return await this.get(`/Items/${itemId}/Collections`, { ...defaults, ...params }, { warnOnError: true });
        } catch (err) {
            // Fall back to the Litefin plugin endpoint if the native route is not found
            if (err.status === 404 || err.message?.includes('Not found')) {
                log.info(`Native Collections endpoint not found for item ${itemId}, attempting Litefin fallback`);
                return await this.get(
                    `/Litefin/Items/${itemId}/Collections`,
                    { ...defaults, ...params },
                    { warnOnError: true }
                );
            }
            throw err;
        }
    }

    async getSimilar(itemId, params = {}) {
        const defaults = {
            UserId: this._userId,
            Limit: 12
        };

        return this.get(`/Items/${itemId}/Similar`, { ...defaults, ...params });
    }

    async getSeasons(seriesId) {
        return this.get(`/Shows/${seriesId}/Seasons`, {
            UserId: this._userId
        });
    }

    async getEpisodes(seriesId, params = {}) {
        // Flexible params — pass SeasonId, StartItemId, Limit, etc.
        // Omit SeasonId to get episodes across all seasons (cross-season navigation)
        return this.get(`/Shows/${seriesId}/Episodes`, {
            UserId: this._userId,
            Fields: 'Overview,RunTimeTicks,Chapters',
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
            Fields: 'ProductionYear,ParentIndexNumber,IndexNumber,SeriesName',
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
            Fields: 'ItemCounts',
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
            Fields: 'ItemCounts',
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
            Fields: 'ParentThumbImageTag',
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
            Fields: 'ItemCounts',
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
            Fields: 'ItemCounts',
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
            Recursive: true
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
            Fields: 'ProductionYear'
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
            Fields: 'ProductionYear,AlbumArtist,Artists'
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
            Fields: 'ProductionYear,AlbumArtist,Artists,RunTimeTicks'
        };

        return this.get('/Items', { ...defaults, ...params });
    }

    async searchPeople(query, params = {}) {
        const defaults = {
            UserId: this._userId,
            SearchTerm: query,
            Limit: 24,
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
        // Create parameter builder for Jellyfin image query string
        const params = new URLSearchParams();

        // Map max constraints
        if (options.maxWidth) params.append('maxWidth', options.maxWidth);
        if (options.maxHeight) params.append('maxHeight', options.maxHeight);

        // Map fill constraints (contain style aspect preservation)
        if (options.fillWidth) params.append('fillWidth', options.fillWidth);
        if (options.fillHeight) params.append('fillHeight', options.fillHeight);

        // Map quality and unique content tags
        if (options.quality) params.append('quality', options.quality);
        if (options.tag) params.append('tag', options.tag);

        // Compile query string and final endpoint URL reference
        const queryString = params.toString();
        const path = `/Items/${itemId}/Images/${imageType}`;

        return this.buildUrl(queryString ? `${path}?${queryString}` : path);
    }

    getUserImageUrl(userId, options = {}) {
        // Create parameter builder for user profile image
        const params = new URLSearchParams();

        // Map max constraints
        if (options.maxWidth) params.append('maxWidth', options.maxWidth);
        if (options.maxHeight) params.append('maxHeight', options.maxHeight);

        // Map fill constraints (contain style aspect preservation)
        if (options.fillWidth) params.append('fillWidth', options.fillWidth);
        if (options.fillHeight) params.append('fillHeight', options.fillHeight);

        // Map quality settings
        if (options.quality) params.append('quality', options.quality);

        // Compile query string and final user endpoint URL reference
        const queryString = params.toString();
        const path = `/Users/${userId}/Images/Primary`;

        return this.buildUrl(queryString ? `${path}?${queryString}` : path);
    }

    /**
     * ========================================================================
     * Theme Media Queries
     * ========================================================================
     * Fetches background theme songs or theme videos configured for a given show,
     * season, or episode. Under the hood, this queries the Jellyfin server's
     * library controller endpoint.
     *
     * @param {string} itemId - The Jellyfin item ID (Movie, Series, Season, etc.)
     * @param {Object} [params] - Optional custom query parameters to override defaults
     * @returns {Promise<Object>} The AllThemeMediaResult object containing items
     */
    async getThemeMedia(itemId, params = {}) {
        // Build robust defaults matching standard web client configurations.
        // InheritFromParent=true guarantees that if we visit a Season or Episode
        // page, it falls back to the parent Show's theme song if defined.
        const defaults = {
            UserId: this._userId,
            InheritFromParent: true
        };

        // Dispatch the standard GET request to retrieve theme media lists
        return this.get(`/Items/${itemId}/ThemeMedia`, { ...defaults, ...params });
    }

    /**
     * ========================================================================
     * Authorized Audio Stream URL Generator
     * ========================================================================
     * Compiles a direct streaming URL for a specific audio item on the server.
     * Appends the active session token to the query parameters since the native
     * HTML5 Audio element cannot pass custom request authorization headers.
     *
     * @param {string} itemId - The target audio/song item ID
     * @returns {string} The fully compiled direct stream URL
     */
    getAudioStreamUrl(itemId) {
        // Capture active auth token from memory
        const token = this._accessToken;

        // Define direct media path on the server, asking for static playback
        // to bypass redundant transcoding whenever possible on the TV client.
        const path = `/Audio/${itemId}/stream?static=true`;

        /*
         * Select the query param authentication key dynamically based on server.
         * Emby does not recognize 'ApiKey' and requires the lowercase 'api_key'.
         * Jellyfin prefers the camelCase 'ApiKey' parameter name.
         */
        const authKey = this.isEmby() ? 'api_key' : 'ApiKey';

        // Use the selected parameter key to authorize native browser fetch
        return this.buildUrl(token ? `${path}&${authKey}=${token}` : path);
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
            Fields: 'CanSelfRecord',
            EnableTotalRecordCount: false
        };
        return this.get('/LiveTv/Channels', { ...defaults, ...params });
    }

    async getLiveTvPrograms(params = {}) {
        const defaults = {
            UserId: this._userId,
            EnableUserData: true,
            Fields: 'CanSelfRecord',
            EnableTotalRecordCount: false
        };
        return this.get('/LiveTv/Programs', { ...defaults, ...params });
    }

    async getLiveTvRecommendedPrograms(params = {}) {
        const defaults = {
            UserId: this._userId,
            IsAiring: true,
            EnableUserData: true,
            Fields: 'CanSelfRecord',
            EnableTotalRecordCount: false,
            Limit: 24
        };
        return this.get('/LiveTv/Programs/Recommended', { ...defaults, ...params });
    }

    async getLiveTvRecordings(params = {}) {
        const defaults = {
            UserId: this._userId,
            Fields: 'CanSelfRecord,Status',
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

        const url = options.ItemId ? `/LiveStreams/Open?ItemId=${options.ItemId}` : '/LiveStreams/Open';

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

        /*
         * Dynamically adapt WebSocket connection parameters for Emby.
         * Emby connects via the '/embywebsocket' path rather than '/socket'.
         * It also requires the lowercase query parameter 'api_key' instead of 'ApiKey'.
         */
        const isEmbyInstance = this.isEmby();
        const wsEndpointPath = isEmbyInstance ? '/embywebsocket' : '/socket';
        const authParamKey = isEmbyInstance ? 'api_key' : 'ApiKey';

        /*
         * Construct the complete WebSocket connection URL.
         * We pass authorization and device details via the query parameters.
         */
        const fullUrl = `${wsUrl}${wsEndpointPath}?${authParamKey}=${encodeURIComponent(this._accessToken)}&deviceId=${encodeURIComponent(this._deviceId)}`;

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
                        name: srv.Name,
                        id: srv.Id
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
 * Send Wake-on-LAN Magic Packet via background service
 * ============================================================================
 * Initiates a request to the local Node.js companion service to broadcast
 * a Wake-on-LAN magic packet targeting the specified server MAC address.
 * Pre-launches the Tizen background service if required to ensure the HTTP
 * proxy is active.
 * ============================================================================
 * @param {string} macAddress - Target server MAC address (e.g., '00:11:22:33:44:55')
 * @returns {Promise<boolean>} True if the magic packet was successfully dispatched
 */
export async function sendWakeOnLan(macAddress) {
    if (!macAddress) {
        log.warn('Wake-on-LAN requested, but no MAC address was provided');
        return false;
    }

    log.info(`Initiating Wake-on-LAN command for MAC: ${macAddress}`);

    // 1. WebOS implementation: dispatch Luna request to the background service
    if (typeof tizen === 'undefined' && typeof window.webOS !== 'undefined' && window.webOS.service) {
        log.info('Platform WebOS: Dispatching WOL request to Luna service org.litefin.app.service');

        const sendLunaRequest = () =>
            new Promise((resolve) => {
                try {
                    window.webOS.service.request('luna://org.litefin.app.service', {
                        method: 'wol',
                        parameters: { mac: macAddress },
                        onSuccess(response) {
                            log.info('Luna WOL request succeeded:', response);
                            resolve({ success: true, response });
                        },
                        onFailure(err) {
                            log.warn('Luna WOL request failed:', err);
                            resolve({ success: false, err });
                        }
                    });
                } catch (e) {
                    log.error('Exception during Luna WOL request dispatch:', e);
                    resolve({ success: false, err: e });
                }
            });

        // First attempt to invoke Luna method
        let res = await sendLunaRequest();

        // If service is cold-booting, WebOS returns "org.litefin.app.service is not running" while starting it.
        // Wait 600ms for the OS to initialize the Node.js background process and retry.
        if (!res.success && res.err) {
            const errStr = typeof res.err === 'string' ? res.err : res.err.errorText || JSON.stringify(res.err);
            if (errStr.includes('not running')) {
                log.info('Luna service process is cold-booting — waiting 600ms for startup retry...');
                await new Promise((resolve) => setTimeout(resolve, 600));
                res = await sendLunaRequest();
            }
        }

        if (res.success) {
            return true;
        }
    }

    // 2. Tizen/HTTP Proxy implementation: fetch localhost:8123/wol
    // We dynamically import PlayerSettings to prevent circular dependency cycles.
    const { PlayerSettings } = await import('../utils/PlayerSettings.js');
    const bgEnabled = PlayerSettings.get('enableBackgroundService') !== false;

    if (bgEnabled) {
        // Pre-launch ytresolver background service on Tizen if needed
        if (typeof tizen !== 'undefined') {
            try {
                const appId = tizen.application.getCurrentApplication().appInfo.id;
                const pkgId = appId.split('.')[0];
                log.info(`Platform Tizen: Pre-launching ytresolver background service: ${pkgId}.ytresolver`);
                tizen.application.launch(pkgId + '.ytresolver');
                
                // Allow a brief 500ms delay for the service to bind port and start listening
                await new Promise((resolve) => setTimeout(resolve, 500));
            } catch (preLaunchErr) {
                log.warn('Failed to pre-launch Tizen background service for WOL:', preLaunchErr);
            }
        }

        log.info('Dispatching WOL request to local HTTP proxy on port 8123');
        try {
            const url = `http://localhost:8123/wol?mac=${encodeURIComponent(macAddress)}`;
            const res = await fetch(url, {
                method: 'POST',
                // Keep-alive or short timeout since it is local loopback
                timeout: 3000
            });
            const data = await res.json();
            log.info('Local HTTP WOL response received:', data);
            return !!(data && data.success);
        } catch (fetchErr) {
            log.warn('Failed to dispatch WOL request to local HTTP proxy:', fetchErr);
            return false;
        }
    }

    log.warn('WOL command skipped: background service is disabled or platform is unsupported');
    return false;
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
        const CHUNK_SIZE = 15; // Reduced from 30 to prevent saturating network stack on older TVs
        for (let i = 0; i < batch.length; i += CHUNK_SIZE) {
            if (signal.aborted) return;

            const chunk = batch.slice(i, i + CHUNK_SIZE);
            const results = await Promise.all(chunk.map((addr) => testServer(addr, 400, signal)));

            // Exit immediately if aborted during the probes
            if (signal.aborted) return;

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
