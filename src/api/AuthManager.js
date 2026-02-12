/**
 * ============================================================================
 * Litefin Tizen - Auth Manager
 * ============================================================================
 * Handles user authentication, session management, and credential storage.
 *
 * Features:
 * - Session persistence (auto-login on app restart)
 * - HasPassword detection (auto-login for passwordless users)
 * - Manual login with username/password
 * - Proper logout with server notification
 *
 * Based on jellyfin-web patterns for compatibility.
 * ============================================================================
 */

import { eventBus } from '../core/EventBus.js';
import { state } from '../core/StateManager.js';
import { api, ServerUnreachableError } from './ApiClient.js';
import { tizenAdapter } from '../tizen/TizenAdapter.js';
import { logger } from '../utils/Logger.js';

const log = logger.create('AuthManager');

// ============================================================================
// Storage Keys
// ============================================================================
const STORAGE_KEYS = {
    SERVER_URL: 'litefin:serverUrl',
    ACCESS_TOKEN: 'litefin:accessToken',
    USER_ID: 'litefin:userId',
    USER_DATA: 'litefin:userData',
    DEVICE_ID: 'litefin:deviceId'
};

// ============================================================================
// AuthManager Class
// ============================================================================
class AuthManager {
    constructor() {
        // Bind methods
        this._onUnauthorized = this._onUnauthorized.bind(this);

        // Listen for unauthorized events from API
        eventBus.on('api:unauthorized', this._onUnauthorized);
    }

    // ========================================================================
    // Initialization
    // ========================================================================

    /**
     * Initialize auth manager
     * - Ensures device ID exists
     * - Attempts to restore saved session
     * @returns {Promise<boolean>} True if session was restored
     */
    async init() {
        log.info('Initializing...');

        // Ensure we have a device ID
        this._ensureDeviceId();

        // Try to restore saved session
        const restored = await this._restoreSession();

        if (restored) {
            log.info('Session restored');
            eventBus.emit('auth:restored');
        }

        return restored;
    }

    /**
     * Ensure we have a unique device ID
     * @private
     */
    _ensureDeviceId() {
        let deviceId = localStorage.getItem(STORAGE_KEYS.DEVICE_ID);

        if (!deviceId) {
            // Generate UUID v4
            deviceId = this._generateUUID();
            localStorage.setItem(STORAGE_KEYS.DEVICE_ID, deviceId);
            log.info('Generated new device ID');
        }

        // Get device name - Encoded to handle spaces safely in headers
        const deviceName = encodeURIComponent(tizenAdapter.getDeviceName());

        api.setDevice(deviceId, deviceName);
    }

    /**
     * Restore session from localStorage
     * @private
     * @returns {Promise<boolean>} True if session was valid
     */
    async _restoreSession() {
        log.info('_restoreSession() called');

        const serverUrl = localStorage.getItem(STORAGE_KEYS.SERVER_URL);
        const accessToken = localStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN);
        const userId = localStorage.getItem(STORAGE_KEYS.USER_ID);

        log.debug('Stored credentials check:', {
            hasServerUrl: !!serverUrl,
            hasAccessToken: !!accessToken,
            hasUserId: !!userId
        });

        // Need all three to restore
        if (!serverUrl || !accessToken || !userId) {
            log.info('Missing credentials, cannot restore');
            return false;
        }

        // Configure API with saved values
        api.setServer(serverUrl);
        api.setAuth(accessToken, userId);
        log.info('API configured with saved credentials');

        // Validate token by fetching user info
        try {
            log.info('Validating token by fetching current user...');
            const user = await api.getCurrentUser();
            log.info('Token valid, user:', user?.Name);

            // Token is valid - restore state
            state.set('user:data', user);
            state.set('user:authenticated', true);
            state.set('server:connected', true);
            state.set('server:offline', false);

            // Report capabilities to establish session (make user appear online)
            // MUST await this on Tizen - fire-and-forget doesn't complete reliably
            log.info('Reporting capabilities to server...');
            try {
                await api.reportCapabilities({
                    PlayableMediaTypes: ['Video', 'Audio'],
                    SupportedCommands: ['PlayState', 'DisplayMessage', 'SetVolume', 'Mute', 'Unmute'],
                    SupportsMediaControl: true,
                    SupportsPersistentIdentifier: true
                });
                log.info('✓ Session capabilities reported on restore - user should be online');
            } catch (e) {
                log.error('✗ Failed to report capabilities on restore:', e);
            }

            // Open WebSocket for real-time online status tracking
            api.openWebSocket();

            return true;
        } catch (error) {
            // Check if it's a network/timeout error
            if (error instanceof ServerUnreachableError) {
                log.warn('Server unreachable during restore. Keeping credentials for later retry.');
                state.set('server:connected', false);
                state.set('server:offline', true);
                state.set('user:authenticated', false); // CRITICAL: Not authenticated until server responds
                return false; 
            }

            // Only clear storage for explicit "Unauthorized" or "Forbidden"
            // This prevents generic server errors (500) or parsing issues from nuking the session
            if (error.status === 401 || error.status === 403) {
                log.warn('Session expired or unauthorized. Clearing stored credentials.');
                this._clearStorage();
                api.clearAuth();
            } else {
                log.warn(`Unexpected error during restore (Status: ${error.status || '??'}). Preserving session.`, error);
                // Still return false to show Offline/Login page, but don't delete token
            }
            
            return false;
        }
    }

    // ========================================================================
    // Server Connection
    // ========================================================================

    /**
     * Connect to a Jellyfin server
     * @param {string} serverUrl - Server URL
     * @returns {Promise<Object>} Server info
     */
    async connectToServer(serverUrl) {
        log.info(`Connecting to ${serverUrl}`);

        api.setServer(serverUrl);

        try {
            const info = await api.getPublicInfo();

            // Save server URL
            localStorage.setItem(STORAGE_KEYS.SERVER_URL, serverUrl);

            state.set('server:connected', true);
            state.set('server:offline', false);
            state.set('server:info', info);

            eventBus.emit('auth:serverConnected', info);

            log.info(`Connected to ${info.ServerName} (v${info.Version})`);

            return info;
        } catch (error) {
            state.set('server:connected', false);
            throw new Error(`Failed to connect: ${error.message}`);
        }
    }

    /**
     * Lightweight check to see if the server is reachable
     * @returns {Promise<boolean>} True if reachable
     */
    async checkServerStatus() {
        const url = this.getSavedServerUrl();
        if (!url) return false;

        try {
            // Use the public info endpoint which requires no auth
            await api.getPublicInfo();
            return true;
        } catch (e) {
            return false;
        }
    }

    /**
     * Get saved server URL
     * @returns {string|null} Server URL if saved
     */
    getSavedServerUrl() {
        return localStorage.getItem(STORAGE_KEYS.SERVER_URL);
    }

    // ========================================================================
    // User Management
    // ========================================================================

    /**
     * Get list of public users
     * Each user has HasPassword field to determine if password is required
     * @returns {Promise<Array>} Public users
     */
    async getPublicUsers() {
        return api.getPublicUsers();
    }

    /**
     * Authenticate a user by name and password
     * This is the core authentication method
     * @param {string} username - Username (case-insensitive on most servers)
     * @param {string} password - Password (empty string for passwordless users)
     * @returns {Promise<Object>} Authentication result
     */
    async login(username, password = '') {
        log.info(`Logging in as "${username}"`);
        log.debug(`Password length: ${password ? password.length : 0}`);
        log.debug(`Current accessToken before login: ${api._accessToken ? 'SET' : 'NULL'}`);

        try {
            // Ensure no stale token is being sent - clear BOTH memory and storage
            this._clearStorage();
            api.clearAuth();
            log.info(`Cleared any stale auth before login request`);

            // Call Jellyfin authenticate endpoint
            const result = await api.post('/Users/AuthenticateByName', {
                Username: username,
                Pw: password
            });

            // Extract data (handle potential casing differences)
            const accessToken = result.AccessToken || result.accessToken;
            const user = result.User || result.user;
            const userId = user?.Id || user?.id;

            // Validate response
            if (!accessToken || !userId) {
                log.error('Invalid login response', result);
                throw new Error('Invalid server response');
            }

            // Store credentials
            localStorage.setItem(STORAGE_KEYS.ACCESS_TOKEN, accessToken);
            localStorage.setItem(STORAGE_KEYS.USER_ID, userId);
            localStorage.setItem(STORAGE_KEYS.USER_DATA, JSON.stringify(user));

            // Configure API with new credentials
            api.setAuth(accessToken, userId);

            // CRITICAL: Report device capabilities to establish session with server
            // Without this, the server won't track user as "online" or receive playback updates
            try {
                await api.reportCapabilities({
                    PlayableMediaTypes: ['Video', 'Audio'],
                    SupportedCommands: ['PlayState', 'DisplayMessage', 'SetVolume', 'Mute', 'Unmute'],
                    SupportsMediaControl: true,
                    SupportsPersistentIdentifier: true
                });
                log.info('Session capabilities reported to server');
            } catch (capError) {
                log.warn('Failed to report capabilities:', capError);
                // Don't fail login if this fails - user can still use the app
            }

            // Open WebSocket for real-time online status tracking
            api.openWebSocket();

            // Update state
            state.set('user:authenticated', true);
            state.set('user:data', user);

            eventBus.emit('auth:login', user);

            log.info(`Logged in as "${user.Name || user.name}"`);

            return result;
        } catch (error) {
            log.error('Login failed:', error);
            throw error;
        }
    }

    /**
     * Login with a public user
     * Checks HasPassword to determine if password prompt is needed
     * @param {Object} user - User object from getPublicUsers()
     * @param {string} [password] - Password (only needed if HasPassword is true)
     * @returns {Promise<Object>} Authentication result
     */
    async loginWithUser(user, password = '') {
        // If user has no password, always use empty string
        const pw = user.HasPassword ? password : '';
        return this.login(user.Name, pw);
    }

    // ========================================================================
    // Logout
    // ========================================================================

    /**
     * Logout current user
     * Clears local session and notifies server
     * NOTE: Local cleanup happens regardless of server response
     */
    async logout() {
        log.info('Logging out...');

        // Close WebSocket first (marks user offline immediately)
        api.closeWebSocket();

        // Get current credentials BEFORE clearing (needed for server notification)
        const accessToken = localStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN);
        const serverUrl = api._serverUrl;

        // Notify server FIRST (while we still have valid credentials)
        if (accessToken && serverUrl) {
            const url = `${serverUrl}/Sessions/Logout`;
            const authHeader = api.getAuthHeader(accessToken);

            log.info('Notifying server of logout...');
            try {
                await fetch(url, {
                    method: 'POST',
                    headers: {
                        'X-Emby-Authorization': authHeader,
                        'Content-Type': 'application/json'
                    }
                });
                log.info('Server notified of logout');
            } catch (e) {
                log.warn('Server logout request failed:', e.message);
            }
        }

        // THEN clear local state
        log.info('Clearing local credentials...');
        this._clearStorage();
        api.clearAuth();
        state.set('user:authenticated', false);
        state.set('user:data', null);

        eventBus.emit('auth:logout');
        log.info('Logout complete');
    }

    // ========================================================================
    // Event Handlers
    // ========================================================================

    /**
     * Handle unauthorized API response (401)
     * @private
     */
    _onUnauthorized() {
        log.warn('Unauthorized - clearing session');

        this._clearStorage();
        api.clearAuth();

        state.set('user:authenticated', false);
        state.set('user:data', null);

        eventBus.emit('auth:expired');
    }

    // ========================================================================
    // Storage Management
    // ========================================================================

    /**
     * Clear stored credentials
     * @private
     */
    _clearStorage() {
        localStorage.removeItem(STORAGE_KEYS.ACCESS_TOKEN);
        localStorage.removeItem(STORAGE_KEYS.USER_ID);
        localStorage.removeItem(STORAGE_KEYS.USER_DATA);
        // Keep server URL and device ID
    }

    // ========================================================================
    // Utilities
    // ========================================================================

    /**
     * Generate UUID v4
     * @private
     */
    _generateUUID() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = (Math.random() * 16) | 0;
            const v = c === 'x' ? r : (r & 0x3) | 0x8;
            return v.toString(16);
        });
    }

    // ========================================================================
    // Getters
    // ========================================================================

    /**
     * Get current user data
     * @returns {Object|null} User data
     */
    getCurrentUser() {
        return state.get('user:data');
    }

    /**
     * Check if user is authenticated
     * @returns {boolean} True if authenticated
     */
    isAuthenticated() {
        return state.get('user:authenticated', false);
    }
}

// Export singleton
export const auth = new AuthManager();

export default AuthManager;
