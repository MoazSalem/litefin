/**
 * ============================================================================
 * LiteFin Tizen - Auth Manager
 * ============================================================================
 * Handles user authentication, session management, and credential storage.
 * Supports both quick connect and password-based login.
 * ============================================================================
 */

import { eventBus } from '../core/EventBus.js';
import { state } from '../core/StateManager.js';
import { api } from './ApiClient.js';

// Storage keys
const STORAGE_KEYS = {
    SERVER_URL: 'litefin:serverUrl',
    ACCESS_TOKEN: 'litefin:accessToken',
    USER_ID: 'litefin:userId',
    USER_DATA: 'litefin:userData',
    DEVICE_ID: 'litefin:deviceId'
};

class AuthManager {
    constructor() {
        // Bound methods
        this._onUnauthorized = this._onUnauthorized.bind(this);

        // Listen for unauthorized events
        eventBus.on('api:unauthorized', this._onUnauthorized);
    }

    /**
     * Initialize auth manager - restore saved session
     * @returns {Promise<boolean>} True if restored session
     */
    async init() {
        console.log('AuthManager: Initializing...');

        // Ensure device ID exists
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
            // Generate UUID
            deviceId = this._generateUUID();
            localStorage.setItem(STORAGE_KEYS.DEVICE_ID, deviceId);
            console.log('AuthManager: Generated new device ID');
        }

        // Get device name from platform if available
        let deviceName = 'Samsung TV';
        if (typeof tizen !== 'undefined') {
            try {
                const model = webapis.productinfo.getModel();
                deviceName = `Samsung ${model}`;
            } catch (e) {
                // Use default
            }
        }

        api.setDevice(deviceId, deviceName);
    }

    /**
     * Restore session from local storage
     * @private
     */
    async _restoreSession() {
        const serverUrl = localStorage.getItem(STORAGE_KEYS.SERVER_URL);
        const accessToken = localStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN);
        const userId = localStorage.getItem(STORAGE_KEYS.USER_ID);

        if (!serverUrl || !accessToken || !userId) {
            return false;
        }

        // Configure API
        api.setServer(serverUrl);
        api.setAuth(accessToken, userId);

        // Validate token by fetching user info
        try {
            const user = await api.getCurrentUser();
            state.set('user:data', user);
            state.set('user:authenticated', true);
            state.set('server:connected', true);
            return true;
        } catch (error) {
            // Token invalid - clear credentials
            console.warn('AuthManager: Saved token is invalid');
            this._clearStorage();
            return false;
        }
    }

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
     * Get list of public users
     * @returns {Promise<Array>} Public users
     */
    async getPublicUsers() {
        return api.getPublicUsers();
    }

    /**
     * Authenticate with username and password
     * @param {string} username - Username
     * @param {string} password - Password (can be empty)
     * @returns {Promise<Object>} Authentication result
     */
    async login(username, password = '') {
        console.log(`AuthManager: Logging in as "${username}"`);

        try {
            const result = await api.post('/Users/AuthenticateByName', {
                Username: username,
                Pw: password
            });

            // Store credentials
            const accessToken = result.AccessToken;
            const userId = result.User.Id;

            localStorage.setItem(STORAGE_KEYS.ACCESS_TOKEN, accessToken);
            localStorage.setItem(STORAGE_KEYS.USER_ID, userId);
            localStorage.setItem(STORAGE_KEYS.USER_DATA, JSON.stringify(result.User));

            // Configure API
            api.setAuth(accessToken, userId);

            // Update state
            state.set('user:authenticated', true);
            state.set('user:data', result.User);

            eventBus.emit('auth:login', result.User);

            console.log(`AuthManager: Logged in as "${result.User.Name}"`);

            return result;
        } catch (error) {
            console.error('AuthManager: Login failed:', error);
            throw error;
        }
    }

    /**
     * Login with PIN (for Quick Connect)
     * @param {string} pin - Quick Connect PIN
     */
    async loginWithPin(pin) {
        // First initiate quick connect
        const initResult = await api.post('/QuickConnect/Initiate');
        const secret = initResult.Secret;

        // Then authorize with PIN
        await api.post('/QuickConnect/Authorize', {
            Code: pin
        });

        // Finally, authenticate with the secret
        const authResult = await api.post('/Users/AuthenticateWithQuickConnect', {
            Secret: secret
        });

        // Store and configure like normal login
        const accessToken = authResult.AccessToken;
        const userId = authResult.User.Id;

        localStorage.setItem(STORAGE_KEYS.ACCESS_TOKEN, accessToken);
        localStorage.setItem(STORAGE_KEYS.USER_ID, userId);
        localStorage.setItem(STORAGE_KEYS.USER_DATA, JSON.stringify(authResult.User));

        api.setAuth(accessToken, userId);

        state.set('user:authenticated', true);
        state.set('user:data', authResult.User);

        eventBus.emit('auth:login', authResult.User);

        return authResult;
    }

    /**
     * Logout current user
     */
    async logout() {
        console.log('AuthManager: Logging out');

        // Try to notify server (ignore errors)
        try {
            await api.post('/Sessions/Logout');
        } catch (e) {
            // Ignore
        }

        // Clear local state
        this._clearStorage();
        api.clearAuth();

        state.set('user:authenticated', false);
        state.set('user:data', null);

        eventBus.emit('auth:logout');
    }

    /**
     * Handle unauthorized API response
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

    /**
     * Get current user data
     * @returns {Object|null} User data
     */
    getCurrentUser() {
        return state.get('user:data');
    }

    /**
     * Check if authenticated
     * @returns {boolean} True if authenticated
     */
    isAuthenticated() {
        return state.get('user:authenticated', false);
    }

    /**
     * Get saved server URL
     * @returns {string|null} Server URL
     */
    getSavedServerUrl() {
        return localStorage.getItem(STORAGE_KEYS.SERVER_URL);
    }
}

// Export singleton
export const auth = new AuthManager();

export default AuthManager;
