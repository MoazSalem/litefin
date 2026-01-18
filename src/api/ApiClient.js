/**
 * ============================================================================
 * LiteFin Tizen - API Client
 * ============================================================================
 * HTTP client wrapper for Jellyfin server API communication.
 * Handles authentication headers, error handling, and request queuing.
 * ============================================================================
 */

import { eventBus } from '../core/EventBus.js';
import { state } from '../core/StateManager.js';

// API request timeout (ms)
const REQUEST_TIMEOUT = 30000;

class ApiClient {
    constructor() {
        // Server configuration
        this._serverUrl = null;
        this._accessToken = null;
        this._userId = null;
        this._deviceId = null;
        this._deviceName = 'LiteFin Tizen';
        this._clientName = 'LiteFin';
        this._clientVersion = '0.1.0';

        // Request queue for rate limiting
        this._pendingRequests = new Map();
    }

    /**
     * Initialize API client with server URL
     * @param {string} serverUrl - Jellyfin server URL
     */
    setServer(serverUrl) {
        // Normalize URL (remove trailing slash)
        this._serverUrl = serverUrl.replace(/\/+$/, '');
        state.set('server:url', this._serverUrl);
        console.log(`ApiClient: Server set to ${this._serverUrl}`);
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
        console.log(`ApiClient: Authenticated as user ${userId}`);
    }

    /**
     * Set device identification
     * @param {string} deviceId - Unique device ID
     * @param {string} [deviceName] - Device name
     */
    setDevice(deviceId, deviceName = null) {
        this._deviceId = deviceId;
        if (deviceName) {
            this._deviceName = deviceName;
        }
    }

    /**
     * Clear authentication
     */
    clearAuth() {
        this._accessToken = null;
        this._userId = null;
        state.set('user:authenticated', false);
        state.set('user:data', null);
        console.log('ApiClient: Authentication cleared');
    }

    /**
     * Get authorization header value
     * @returns {string} Authorization header
     */
    getAuthHeader() {
        let header = `MediaBrowser Client="${this._clientName}", Device="${this._deviceName}", DeviceId="${this._deviceId}", Version="${this._clientVersion}"`;

        if (this._accessToken) {
            header += `, Token="${this._accessToken}"`;
        }

        return header;
    }

    /**
     * Build full URL for an endpoint
     * @param {string} endpoint - API endpoint path
     * @returns {string} Full URL
     */
    buildUrl(endpoint) {
        // Handle endpoints that already start with /
        const path = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
        return `${this._serverUrl}${path}`;
    }

    /**
     * Make an API request
     * @param {string} endpoint - API endpoint
     * @param {Object} [options] - Fetch options
     * @returns {Promise<any>} Response data
     */
    async request(endpoint, options = {}) {
        if (!this._serverUrl) {
            throw new Error('Server URL not configured');
        }

        const url = this.buildUrl(endpoint);
        const method = options.method || 'GET';

        // Build headers
        const headers = {
            'X-Emby-Authorization': this.getAuthHeader(),
            'Content-Type': 'application/json',
            ...options.headers
        };

        // Build fetch options
        const fetchOptions = {
            method,
            headers,
            ...options
        };

        // Add body for POST/PUT
        if (options.body && typeof options.body === 'object') {
            fetchOptions.body = JSON.stringify(options.body);
        }

        console.log(`ApiClient: ${method} ${endpoint}`);

        try {
            // Create abort controller for timeout
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

            fetchOptions.signal = controller.signal;

            const response = await fetch(url, fetchOptions);

            clearTimeout(timeoutId);

            // Handle response
            if (!response.ok) {
                const error = await this._handleError(response);
                throw error;
            }

            // Parse response
            const contentType = response.headers.get('content-type');
            if (contentType && contentType.includes('application/json')) {
                return await response.json();
            }

            return await response.text();

        } catch (error) {
            if (error.name === 'AbortError') {
                throw new Error('Request timeout');
            }

            console.error(`ApiClient: Request failed - ${error.message}`);
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

        try {
            const data = await response.json();
            message = data.message || data.Message || message;
        } catch {
            // Response wasn't JSON
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
     * @param {string} endpoint - API endpoint
     * @param {Object} [params] - Query parameters
     */
    async get(endpoint, params = null) {
        let url = endpoint;

        if (params) {
            const searchParams = new URLSearchParams();
            for (const [key, value] of Object.entries(params)) {
                if (value !== undefined && value !== null) {
                    searchParams.append(key, value);
                }
            }
            const queryString = searchParams.toString();
            if (queryString) {
                url += `?${queryString}`;
            }
        }

        return this.request(url, { method: 'GET' });
    }

    /**
     * POST request helper
     * @param {string} endpoint - API endpoint
     * @param {Object} [body] - Request body
     */
    async post(endpoint, body = null) {
        return this.request(endpoint, { method: 'POST', body });
    }

    /**
     * DELETE request helper
     * @param {string} endpoint - API endpoint
     */
    async delete(endpoint) {
        return this.request(endpoint, { method: 'DELETE' });
    }

    // ========================================================================
    // Server endpoints
    // ========================================================================

    /**
     * Get server public info (no auth required)
     */
    async getPublicInfo() {
        return this.get('/System/Info/Public');
    }

    /**
     * Get server branding
     */
    async getBranding() {
        return this.get('/Branding/Configuration');
    }

    // ========================================================================
    // User endpoints
    // ========================================================================

    /**
     * Get public users list
     */
    async getPublicUsers() {
        return this.get('/Users/Public');
    }

    /**
     * Get current user info
     */
    async getCurrentUser() {
        return this.get(`/Users/${this._userId}`);
    }

    /**
     * Get user views (libraries)
     */
    async getUserViews() {
        return this.get(`/Users/${this._userId}/Views`);
    }

    // ========================================================================
    // Library endpoints
    // ========================================================================

    /**
     * Get items from library
     * @param {Object} params - Query parameters
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
     * Get latest items in a library
     * @param {string} parentId - Library ID
     * @param {Object} params - Additional parameters
     */
    async getLatestItems(parentId, params = {}) {
        const defaults = {
            Limit: 16,
            Fields: 'PrimaryImageAspectRatio,BasicSyncInfo',
            ImageTypeLimit: 1,
            EnableImageTypes: 'Primary,Backdrop,Thumb',
            ParentId: parentId
        };

        return this.get(`/Users/${this._userId}/Items/Latest`, { ...defaults, ...params });
    }

    /**
     * Get resume items (continue watching)
     * @param {Object} params - Query parameters
     */
    async getResumeItems(params = {}) {
        const defaults = {
            Limit: 12,
            Recursive: true,
            Fields: 'PrimaryImageAspectRatio,BasicSyncInfo',
            ImageTypeLimit: 1,
            EnableImageTypes: 'Primary,Backdrop,Thumb',
            EnableTotalRecordCount: false,
            MediaTypes: 'Video'
        };

        return this.get(`/Users/${this._userId}/Items/Resume`, { ...defaults, ...params });
    }

    /**
     * Get next up episodes
     * @param {Object} params - Query parameters
     */
    async getNextUp(params = {}) {
        const defaults = {
            UserId: this._userId,
            Limit: 24,
            Fields: 'PrimaryImageAspectRatio,BasicSyncInfo',
            ImageTypeLimit: 1,
            EnableImageTypes: 'Primary,Backdrop,Thumb'
        };

        return this.get('/Shows/NextUp', { ...defaults, ...params });
    }

    // ========================================================================
    // Item endpoints
    // ========================================================================

    /**
     * Get single item details
     * @param {string} itemId - Item ID
     */
    async getItem(itemId) {
        return this.get(`/Users/${this._userId}/Items/${itemId}`);
    }

    /**
     * Get similar items
     * @param {string} itemId - Item ID
     * @param {Object} params - Query parameters
     */
    async getSimilar(itemId, params = {}) {
        const defaults = {
            UserId: this._userId,
            Limit: 12,
            Fields: 'PrimaryImageAspectRatio'
        };

        return this.get(`/Items/${itemId}/Similar`, { ...defaults, ...params });
    }

    /**
     * Get seasons for a series
     * @param {string} seriesId - Series ID
     */
    async getSeasons(seriesId) {
        return this.get(`/Shows/${seriesId}/Seasons`, {
            UserId: this._userId,
            Fields: 'PrimaryImageAspectRatio,BasicSyncInfo'
        });
    }

    /**
     * Get episodes for a season
     * @param {string} seriesId - Series ID
     * @param {string} seasonId - Season ID
     */
    async getEpisodes(seriesId, seasonId) {
        return this.get(`/Shows/${seriesId}/Episodes`, {
            UserId: this._userId,
            SeasonId: seasonId,
            Fields: 'PrimaryImageAspectRatio,BasicSyncInfo,Overview'
        });
    }

    // ========================================================================
    // Search endpoints
    // ========================================================================

    /**
     * Search for items
     * @param {string} query - Search query
     * @param {Object} params - Additional parameters
     */
    async search(query, params = {}) {
        const defaults = {
            UserId: this._userId,
            SearchTerm: query,
            IncludeItemTypes: 'Movie,Series,Episode',
            Limit: 24,
            Fields: 'PrimaryImageAspectRatio',
            Recursive: true,
            EnableTotalRecordCount: false
        };

        return this.get('/Items', { ...defaults, ...params });
    }

    // ========================================================================
    // Image endpoints
    // ========================================================================

    /**
     * Get image URL for an item
     * @param {string} itemId - Item ID
     * @param {string} [imageType='Primary'] - Image type
     * @param {Object} [options] - Image options
     * @returns {string} Image URL
     */
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

    /**
     * Get image URL for a user (avatar)
     * @param {string} userId - User ID
     * @param {Object} [options] - Image options
     * @returns {string} Image URL
     */
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
    // Playback endpoints
    // ========================================================================

    /**
     * Get playback info for an item
     * @param {string} itemId - Item ID
     * @param {Object} deviceProfile - Device profile
     */
    async getPlaybackInfo(itemId, deviceProfile) {
        return this.post(`/Items/${itemId}/PlaybackInfo`, {
            UserId: this._userId,
            DeviceProfile: deviceProfile,
            AutoOpenLiveStream: true
        });
    }

    /**
     * Report playback start
     * @param {Object} info - Playback info
     */
    async reportPlaybackStart(info) {
        return this.post('/Sessions/Playing', info);
    }

    /**
     * Report playback progress
     * @param {Object} info - Progress info
     */
    async reportPlaybackProgress(info) {
        return this.post('/Sessions/Playing/Progress', info);
    }

    /**
     * Report playback stopped
     * @param {Object} info - Stop info
     */
    async reportPlaybackStopped(info) {
        return this.post('/Sessions/Playing/Stopped', info);
    }

    // ========================================================================
    // Favorites endpoints
    // ========================================================================

    /**
     * Mark item as favorite
     * @param {string} itemId - Item ID
     */
    async markFavorite(itemId) {
        return this.post(`/Users/${this._userId}/FavoriteItems/${itemId}`);
    }

    /**
     * Unmark item as favorite
     * @param {string} itemId - Item ID
     */
    async unmarkFavorite(itemId) {
        return this.delete(`/Users/${this._userId}/FavoriteItems/${itemId}`);
    }

    /**
     * Mark item as played
     * @param {string} itemId - Item ID
     */
    async markPlayed(itemId) {
        return this.post(`/Users/${this._userId}/PlayedItems/${itemId}`);
    }

    /**
     * Unmark item as played
     * @param {string} itemId - Item ID
     */
    async unmarkPlayed(itemId) {
        return this.delete(`/Users/${this._userId}/PlayedItems/${itemId}`);
    }

    // ========================================================================
    // Getters
    // ========================================================================

    get serverUrl() { return this._serverUrl; }
    get userId() { return this._userId; }
    get isAuthenticated() { return !!this._accessToken; }
}

// ============================================================================
// Server Discovery - Static methods for finding Jellyfin servers on LAN
// ============================================================================

/**
 * Test if a server is a valid Jellyfin server
 * @param {string} address - Server address to test (e.g., "http://192.168.1.100:8096")
 * @param {number} timeout - Timeout in ms
 * @returns {Promise<Object|null>} Server info or null if not valid
 */
async function testServer(address, timeout = 1000) {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        const response = await fetch(`${address}/System/Info/Public`, {
            method: 'GET',
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) return null;

        const info = await response.json();

        // Extract server name from response or URL
        let serverName = info.ServerName;
        if (!serverName || serverName.trim() === '') {
            try {
                const url = new URL(address);
                serverName = url.hostname;
            } catch {
                serverName = 'Jellyfin Server';
            }
        }

        return {
            address: address,
            name: serverName,
            id: info.Id,
            version: info.Version,
            operatingSystem: info.OperatingSystem
        };
    } catch {
        return null;
    }
}

/**
 * Discover Jellyfin servers on the local network
 * Scans common LAN IP ranges on port 8096
 * @param {Function} onProgress - Optional callback for progress updates (checked, total)
 * @returns {Promise<Array>} Array of found servers
 */
async function discoverServers(onProgress = null) {
    console.log('ApiClient: Starting server discovery...');

    // Build list of addresses to scan
    const addressesToScan = [
        'http://localhost:8096',
        'http://127.0.0.1:8096',
        'http://jellyfin:8096'
    ];

    // Common LAN ranges
    const ranges = [
        { prefix: '192.168.1.', start: 1, end: 255 },
        { prefix: '192.168.0.', start: 1, end: 50 },
        { prefix: '10.0.0.', start: 1, end: 50 }
    ];

    for (const range of ranges) {
        for (let i = range.start; i <= range.end; i++) {
            addressesToScan.push(`http://${range.prefix}${i}:8096`);
        }
    }

    console.log(`ApiClient: Scanning ${addressesToScan.length} addresses...`);

    const foundServers = [];
    let checkedCount = 0;
    const totalToCheck = addressesToScan.length;

    // Scan in batches - larger batches for faster scanning
    const batchSize = 50;

    for (let i = 0; i < addressesToScan.length; i += batchSize) {
        const batch = addressesToScan.slice(i, i + batchSize);

        // Test all addresses in batch in parallel
        const results = await Promise.all(
            batch.map(address => testServer(address))
        );

        // Collect found servers
        for (const result of results) {
            if (result) {
                console.log(`ApiClient: Found server at ${result.address}`);
                foundServers.push(result);
            }
        }

        checkedCount += batch.length;

        // Report progress
        if (onProgress) {
            onProgress(checkedCount, totalToCheck);
        }
    }

    console.log(`ApiClient: Discovery complete. Found ${foundServers.length} server(s)`);
    return foundServers;
}

// Export singleton
export const api = new ApiClient();

// Export discovery functions
export { discoverServers, testServer };

export default ApiClient;

