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
import { api } from './ApiClient.js';
import { tizenAdapter } from '../tizen/TizenAdapter.js';

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
        console.log('AuthManager: Initializing...');

        // Ensure we have a device ID
        this._ensureDeviceId();

        // Try to restore saved session
        const restored = await this._restoreSession();

        if (restored) {
            console.log('AuthManager: Session restored');
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
            console.log('AuthManager: Generated new device ID');
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
        console.log('AuthManager: _restoreSession() called');

        const serverUrl = localStorage.getItem(STORAGE_KEYS.SERVER_URL);
        const accessToken = localStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN);
        const userId = localStorage.getItem(STORAGE_KEYS.USER_ID);

        console.log('AuthManager: Stored credentials check:', {
            hasServerUrl: !!serverUrl,
            hasAccessToken: !!accessToken,
            hasUserId: !!userId
        });

        // Need all three to restore
        if (!serverUrl || !accessToken || !userId) {
            console.log('AuthManager: Missing credentials, cannot restore');
            return false;
        }

        // Configure API with saved values
        api.setServer(serverUrl);
        api.setAuth(accessToken, userId);
        console.log('AuthManager: API configured with saved credentials');

        // Validate token by fetching user info
        try {
            console.log('AuthManager: Validating token by fetching current user...');
            const user = await api.getCurrentUser();
            console.log('AuthManager: Token valid, user:', user?.Name);

            // Token is valid - restore state
            state.set('user:data', user);
            state.set('user:authenticated', true);
            state.set('server:connected', true);

            // Report capabilities to establish session (make user appear online)
            // MUST await this on Tizen - fire-and-forget doesn't complete reliably
            console.log('AuthManager: Reporting capabilities to server...');
            try {
                await api.reportCapabilities({
                    PlayableMediaTypes: ['Video', 'Audio'],
                    SupportedCommands: ['PlayState', 'DisplayMessage', 'SetVolume', 'Mute', 'Unmute'],
                    SupportsMediaControl: true,
                    SupportsPersistentIdentifier: true
                });
                console.log('AuthManager: ✓ Session capabilities reported on restore - user should be online');
            } catch (e) {
                console.error('AuthManager: ✗ Failed to report capabilities on restore:', e);
            }

            // Open WebSocket for real-time online status tracking
            api.openWebSocket();

            return true;
        } catch (error) {
            // Token is invalid - clear stored credentials
            console.warn('AuthManager: Token validation failed:', error);
            this._clearStorage();
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
        console.log(`AuthManager: Connecting to ${serverUrl}`);

        api.setServer(serverUrl);

        try {
            const info = await api.getPublicInfo();

            // Save server URL
            localStorage.setItem(STORAGE_KEYS.SERVER_URL, serverUrl);

            state.set('server:connected', true);
            state.set('server:info', info);

            eventBus.emit('auth:serverConnected', info);

            console.log(`AuthManager: Connected to ${info.ServerName} (v${info.Version})`);

            return info;
        } catch (error) {
            state.set('server:connected', false);
            throw new Error(`Failed to connect: ${error.message}`);
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
        console.log(`AuthManager: Logging in as "${username}"`);
        console.log(`AuthManager: Password length: ${password ? password.length : 0}`);
        console.log(`AuthManager: Current accessToken before login: ${api._accessToken ? 'SET' : 'NULL'}`);

        try {
            // Ensure no stale token is being sent - clear BOTH memory and storage
            this._clearStorage();
            api.clearAuth();
            console.log(`AuthManager: Cleared any stale auth before login request`);

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
                console.error('AuthManager: Invalid login response', result);
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
                    SupportedCommands: [
                        'PlayState',
                        'DisplayMessage',
                        'SetVolume',
                        'Mute',
                        'Unmute'
                    ],
                    SupportsMediaControl: true,
                    SupportsPersistentIdentifier: true
                });
                console.log('AuthManager: Session capabilities reported to server');
            } catch (capError) {
                console.warn('AuthManager: Failed to report capabilities:', capError);
                // Don't fail login if this fails - user can still use the app
            }

            // Open WebSocket for real-time online status tracking
            api.openWebSocket();

            // Update state
            state.set('user:authenticated', true);
            state.set('user:data', user);

            eventBus.emit('auth:login', user);

            console.log(`AuthManager: Logged in as "${user.Name || user.name}"`);

            return result;
        } catch (error) {
            console.error('AuthManager: Login failed:', error);
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
        console.log('AuthManager: Logging out...');

        // Close WebSocket first (marks user offline immediately)
        api.closeWebSocket();

        // Get current credentials BEFORE clearing (needed for server notification)
        const accessToken = localStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN);
        const serverUrl = api._serverUrl;

        // Notify server FIRST (while we still have valid credentials)
        if (accessToken && serverUrl) {
            const url = `${serverUrl}/Sessions/Logout`;
            const authHeader = api.getAuthHeader(accessToken);

            console.log('AuthManager: Notifying server of logout...');
            try {
                await fetch(url, {
                    method: 'POST',
                    headers: {
                        'X-Emby-Authorization': authHeader,
                        'Content-Type': 'application/json'
                    }
                });
                console.log('AuthManager: Server notified of logout');
            } catch (e) {
                console.warn('AuthManager: Server logout request failed:', e.message);
            }
        }

        // THEN clear local state
        console.log('AuthManager: Clearing local credentials...');
        this._clearStorage();
        api.clearAuth();
        state.set('user:authenticated', false);
        state.set('user:data', null);

        eventBus.emit('auth:logout');
        console.log('AuthManager: Logout complete');
    }



    // ========================================================================
    // Event Handlers
    // ========================================================================

    /**
     * Handle unauthorized API response (401)
     * @private
     */
    _onUnauthorized() {
        console.warn('AuthManager: Unauthorized - clearing session');

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
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
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
