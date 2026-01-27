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

// API request timeout (ms)
const REQUEST_TIMEOUT = 30000;

// ============================================================================
// ApiClient Class
// ============================================================================
class ApiClient {
    constructor() {
        // Server configuration
        this._serverUrl = null;
        this._accessToken = null;
        this._userId = null;

        // Device identification - NO SPACES in any of these values
        this._deviceId = null;
        this._deviceName = 'LitefinTizenTv';
        this._clientName = 'Litefin';
        this._clientVersion = '0.1.0';
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
     * Device name is sanitized to remove spaces and special characters
     * @param {string} deviceId - Unique device ID
     * @param {string} [deviceName] - Device name (will be sanitized)
     */
    setDevice(deviceId, deviceName = null) {
        this._deviceId = deviceId;
        if (deviceName) {
            // Remove ALL spaces and special characters - critical for header safety
            this._deviceName = deviceName.replace(/[^a-zA-Z0-9]/g, '');
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
        console.log('ApiClient: Authentication cleared');
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
    async request(endpoint, options = {}) {
        if (!this._serverUrl) {
            throw new Error('Server URL not configured');
        }

        const url = this.buildUrl(endpoint);
        const method = options.method || 'GET';

        // DEBUG: Store last requested URL
        this.lastUrl = url;
        // Note: URL doesn't include params if they were passed within options, 
        // but 'get' helper appends them to 'endpoint' string passed here.
        // So 'url' here is the FULL URL with query string.


        // Build headers
        const headers = {
            'X-Emby-Authorization': this.getAuthHeader(),
            'Content-Type': 'application/json',
            ...options.headers
        };

        // Build fetch options
        const fetchOptions = {
            method,
            headers
        };

        // Add body for POST/PUT requests
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

            // Handle error responses
            if (!response.ok) {
                const error = await this._handleError(response);
                throw error;
            }

            // Parse response based on content type
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

        // Try to parse error message from response
        try {
            const data = await response.json();
            message = data.message || data.Message || message;
        } catch {
            // Response wasn't JSON, use status code
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
     */
    async post(endpoint, body = null) {
        return this.request(endpoint, { method: 'POST', body });
    }

    /**
     * DELETE request helper
     */
    async delete(endpoint) {
        return this.request(endpoint, { method: 'DELETE' });
    }

    // ========================================================================
    // Server Endpoints (Public - No auth required)
    // ========================================================================

    /**
     * Get server public info
     */
    async getPublicInfo() {
        return this.get('/System/Info/Public');
    }

    /**
     * Get server branding configuration
     */
    async getBranding() {
        return this.get('/Branding/Configuration');
    }

    // ========================================================================
    // User Endpoints
    // ========================================================================

    /**
     * Get list of public users (for login screen)
     * Returns users with HasPassword field
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
     * Get user profile image URL
     */
    getUserImageUrl(userId, options = {}) {
        if (!this._serverUrl) return '';

        const type = options.type || 'Primary';
        const url = `${this._serverUrl}/Users/${userId}/Images/${type}`;
        const query = [];

        if (options.maxWidth) query.push(`maxWidth=${options.maxWidth}`);
        if (options.maxHeight) query.push(`maxHeight=${options.maxHeight}`);
        if (options.tag) query.push(`tag=${options.tag}`);
        if (options.quality) query.push(`quality=${options.quality}`);

        return query.length > 0 ? `${url}?${query.join('&')}` : url;
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
     * Get latest items in a library
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
     */
    async getResumeItems(params = {}) {
        const defaults = {
            Limit: 12,
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

    // ========================================================================
    // Item Endpoints
    // ========================================================================

    async getItem(itemId, params = {}) {
        return this.get(`/Users/${this._userId}/Items/${itemId}`, params);
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

    async getEpisodes(seriesId, seasonId) {
        return this.get(`/Shows/${seriesId}/Episodes`, {
            UserId: this._userId,
            SeasonId: seasonId,
            Fields: 'PrimaryImageAspectRatio,BasicSyncInfo,Overview'
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
    // Search Endpoints
    // ========================================================================

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

    async getPlaybackInfo(itemId, deviceProfile) {
        return this.post(`/Items/${itemId}/PlaybackInfo`, {
            UserId: this._userId,
            DeviceProfile: deviceProfile,
            AutoOpenLiveStream: true
        });
    }

    async reportPlaybackStart(info) {
        return this.post('/Sessions/Playing', info);
    }

    async reportPlaybackProgress(info) {
        return this.post('/Sessions/Playing/Progress', info);
    }

    async reportPlaybackStopped(info) {
        return this.post('/Sessions/Playing/Stopped', info);
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
    // Getters
    // ========================================================================

    get serverUrl() { return this._serverUrl; }
    get userId() { return this._userId; }
    get isAuthenticated() { return !!this._accessToken; }
}

// ============================================================================
// Server Discovery
// ============================================================================

/**
 * Test if an address is a valid Jellyfin server
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
 * Discover Jellyfin servers on local network
 */
async function discoverServers(onProgress = null, onServerFound = null) {
    console.log('ApiClient: Starting server discovery...');
    const foundServers = [];
    const scannedIps = new Set();

    const scanSubnet = async (prefix) => {
        const batch = [];
        for (let i = 1; i < 255; i++) {
            const ip = `http://${prefix}${i}:8096`;
            if (!scannedIps.has(ip)) {
                batch.push(ip);
                scannedIps.add(ip);
            }
        }

        const CHUNK_SIZE = 60;
        for (let i = 0; i < batch.length; i += CHUNK_SIZE) {
            const chunk = batch.slice(i, i + CHUNK_SIZE);
            const results = await Promise.all(
                chunk.map(addr => testServer(addr, 500))
            );

            results.filter(s => s).forEach(s => {
                if (!foundServers.find(existing => existing.address === s.address)) {
                    console.log(`ApiClient: Found server at ${s.address}`);
                    foundServers.push(s);
                    if (onServerFound) onServerFound(s);
                }
            });

            if (onProgress) onProgress(scannedIps.size, 600);
        }
    };

    // Scan local subnet first
    const localIP = await tizenAdapter.getIPAddress();
    if (localIP) {
        const parts = localIP.split('.');
        if (parts.length === 4) {
            const subnet = `${parts[0]}.${parts[1]}.${parts[2]}.`;
            console.log(`ApiClient: Scanning local subnet ${subnet}x`);
            await scanSubnet(subnet);
        }
    }

    // Scan common subnets
    const standardSubnets = ['192.168.0.', '192.168.1.', '10.0.0.'];
    await Promise.all(standardSubnets.map(subnet => scanSubnet(subnet)));

    console.log(`ApiClient: Discovery complete. Found ${foundServers.length} server(s)`);
    return foundServers;
}

// Export singleton
export const api = new ApiClient();

// Export discovery functions
export { discoverServers, testServer };

export default ApiClient;
