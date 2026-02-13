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
import { storage } from '../utils/StorageService.js';
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
        let deviceId = storage.getItem(STORAGE_KEYS.DEVICE_ID);

        if (!deviceId) {
            // Generate UUID v4
            deviceId = this._generateUUID();
            storage.setItem(STORAGE_KEYS.DEVICE_ID, deviceId);
            log.info('Generated new device ID');
        }

        // Get device name - ApiClient handles quoting and sanitization for headers
        const deviceName = tizenAdapter.getDeviceName();

        api.setDevice(deviceId, deviceName);
    }

    /**
     * Restore session from localStorage
     * @private
     * @returns {Promise<boolean>} True if session was valid
     */
    async _restoreSession() {
        log.info('_restoreSession() called');

        const serverUrl = storage.getItem(STORAGE_KEYS.SERVER_URL);
        const accessToken = storage.getItem(STORAGE_KEYS.ACCESS_TOKEN);
        const userId = storage.getItem(STORAGE_KEYS.USER_ID);

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
                log.warn(
                    `Unexpected error during restore (Status: ${error.status || '??'}). Preserving session.`,
                    error
                );
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
            storage.setItem(STORAGE_KEYS.SERVER_URL, serverUrl);

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
        return storage.getItem(STORAGE_KEYS.SERVER_URL);
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
        
        // Capture existing memory state to restore on failure
        const prevToken = api.accessToken;
        const prevUserId = api.userId;

        try {
            // 1. Prepare for clean login request
            // We clear memory token so ApiClient doesn't send a stale one in the header.
            // We do NOT clear localStorage yet - we only do that on SUCCESS.
            api.setAuth(null, null);
            log.info(`Cleared in-memory auth for login request attempt`);

            // 2. Call Jellyfin authenticate endpoint
            const result = await api.post('/Users/AuthenticateByName', {
                Username: username,
                Pw: password
            });

            // 3. SUCCESS - Now we can safely overwrite the old session
            const accessToken = result.AccessToken || result.accessToken;
            const user = result.User || result.user;
            const userId = user?.Id || user?.id;

            if (!accessToken || !userId) {
                log.error('Invalid login response structure', result);
                throw new Error('Invalid server response');
            }

            // Clear old and save new to storage
            this._clearStorage();
            storage.setItem(STORAGE_KEYS.ACCESS_TOKEN, accessToken);
            storage.setItem(STORAGE_KEYS.USER_ID, userId);
            storage.setItem(STORAGE_KEYS.USER_DATA, JSON.stringify(user));

            // Configure API with new credentials
            api.setAuth(accessToken, userId);

            // Establish session capabilities
            try {
                await api.reportCapabilities({
                    PlayableMediaTypes: ['Video', 'Audio'],
                    SupportedCommands: ['PlayState', 'DisplayMessage', 'SetVolume', 'Mute', 'Unmute'],
                    SupportsMediaControl: true,
                    SupportsPersistentIdentifier: true
                });
            } catch (capError) {
                log.warn('Non-fatal: Failed to report capabilities after login:', capError);
            }

            api.openWebSocket();

            state.set('user:authenticated', true);
            state.set('user:data', user);

            eventBus.emit('auth:login', user);
            log.info(`Login successful for "${user.Name || username}"`);

            return result;
        } catch (error) {
            log.error('Login request failed:', error);
            
            // 4. FAILURE - Restore previous in-memory credentials 
            // This prevents the app from being "half-logged out" if the failure 
            // was just a wrong password or temporary network glitch.
            if (prevToken && prevUserId) {
                log.info('Restoring previous in-memory credentials after failed login attempt');
                api.setAuth(prevToken, prevUserId);
            }
            
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
        const accessToken = storage.getItem(STORAGE_KEYS.ACCESS_TOKEN);
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
        storage.removeItem(STORAGE_KEYS.ACCESS_TOKEN);
        storage.removeItem(STORAGE_KEYS.USER_ID);
        storage.removeItem(STORAGE_KEYS.USER_DATA);
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
