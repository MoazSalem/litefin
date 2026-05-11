/**
 * ============================================================================
 * Litefin Tizen - Auth Manager
 * ============================================================================
 * Handles user authentication, session management, and credential storage.
 *
 * Multi-User Architecture:
 * ------------------------
 * All sessions are stored in a single JSON array under `litefin:sessions`.
 * The currently active user is tracked by `litefin:activeUserId`.
 * ApiClient remains a thin transport layer — AuthManager orchestrates which
 * user's credentials are fed to it at any given time.
 *
 * Session Object Shape:
 *   {
 *     userId: string,
 *     accessToken: string,
 *     userName: string,
 *     primaryImageTag: string|null
 *   }
 *
 * Backward Compatibility:
 * When old single-user keys (litefin:accessToken, litefin:userId, etc.) are
 * detected on first launch, they are automatically migrated to the new sessions
 * array and the old keys are pruned.
 * ============================================================================
 */

import { eventBus } from '../core/EventBus.js';
import { state } from '../core/StateManager.js';
import { api, ServerUnreachableError } from './ApiClient.js';
import { tizenAdapter } from '../tizen/TizenAdapter.js';
import { webosAdapter } from '../webos/WebOSAdapter.js';
import { platformInfo } from '../utils/PlatformInfo.js';
import { storage } from '../utils/StorageService.js';
import { buildJellyfinProfile } from './DeviceProfile.js';
import { logger } from '../utils/Logger.js';

const log = logger.create('AuthManager');

// ============================================================================
// Storage Keys
// ============================================================================
const STORAGE_KEYS = {
    SERVER_URL:      'litefin:serverUrl',
    DEVICE_ID:       'litefin:deviceId',

    // --- Active user marker ---
    /** userId string of the currently active session */
    ACTIVE_USER:     'litefin:activeUserId',

    // --- Per-server session map ---
    /**
     * JSON object mapping server URL → array of session objects.
     * Shape: { "https://server.com": [{userId, accessToken, userName, primaryImageTag}] }
     * This replaces the old flat litefin:sessions array.
     */
    SERVER_SESSIONS: 'litefin:serverSessions',

    // --- Legacy flat sessions (migration reference only — do not write to this after migration) ---
    SESSIONS:        'litefin:sessions'
};

/**
 * Maximum number of user sessions stored simultaneously.
 * A TV is a shared device, but we keep this sane.
 */
const MAX_SESSIONS = 8;

/**
 * Shared capabilities block sent to the server after every login / session
 * restore. Extracted as a constant to avoid copy-pasting the same array
 * in four places throughout this file.
 */
const SUPPORTED_CAPABILITIES = {
    DeviceProfile: null, // Filled in at call time via buildJellyfinProfile()
    PlayableMediaTypes: ['Video', 'Audio'],
    SupportedCommands: [
        'MoveUp', 'MoveDown', 'MoveLeft', 'MoveRight',
        'ToggleOsd',
        'Select', 'Back', 'SendKey', 'SendString',
        'GoHome', 'GoToSettings',
        'VolumeUp', 'VolumeDown', 'Mute', 'Unmute', 'ToggleMute', 'SetVolume',
        'SetAudioStreamIndex', 'SetSubtitleStreamIndex',
        'DisplayContent', 'GoToSearch', 'DisplayMessage',
        'SetRepeatMode', 'SetShuffleQueue',
        'ChannelUp', 'ChannelDown',
        'PlayMediaSource'
    ],
    SupportsMediaControl: true,
    SupportsPersistentIdentifier: true
};

// ============================================================================
// AuthManager Class
// ============================================================================
class AuthManager {
    constructor() {
        // Bind methods that are wired to external event sources
        this._onUnauthorized    = this._onUnauthorized.bind(this);
        this._onWebosDeviceInfo = this._onWebosDeviceInfo.bind(this);

        // Listen for unauthorized events from API
        eventBus.on('api:unauthorized', this._onUnauthorized);
        eventBus.on('webos:deviceInfoReady', this._onWebosDeviceInfo);
    }

    // ========================================================================
    // Initialization
    // ========================================================================

    /**
     * Initialize auth manager.
     * - Ensures device ID exists
     * - Migrates flat litefin:sessions → per-server litefin:serverSessions (one-time)
     * - Attempts to restore the last active session
     *
     * @returns {Promise<boolean>} True if a session was successfully restored
     */
    async init() {
        log.info('Initializing...');

        // Ensure a unique device ID is registered with the API
        this._ensureDeviceId();

        // One-time migration: lift flat sessions array → per-server keyed map
        this._migrateServerSessions();

        // Restore the last active session from the per-server sessions map
        const restored = await this._restoreSession();

        if (restored) {
            log.info('Session restored');
            eventBus.emit('auth:restored');
        }

        return restored;
    }

    /**
     * Ensure we have a unique device ID registered with ApiClient.
     * @private
     */
    _ensureDeviceId() {
        let deviceId = storage.getItem(STORAGE_KEYS.DEVICE_ID);

        if (!deviceId) {
            // Generate UUID v4 for first launch
            deviceId = this._generateUUID();
            storage.setItem(STORAGE_KEYS.DEVICE_ID, deviceId);
            log.info('Generated new device ID');
        }

        // Resolve device name from the platform adapter
        let deviceName;
        if (platformInfo.isWebOS) {
            deviceName = webosAdapter.getDeviceName();
        } else {
            deviceName = tizenAdapter.getDeviceName();
        }

        log.info(`Identification check: platform=${platformInfo.platformString}, deviceName="${deviceName}"`);
        api.setDevice(deviceId, deviceName);
    }

    /**
     * One-time migration: lift the old flat litefin:sessions array into the
     * new per-server keyed map (litefin:serverSessions).
     *
     * Old format: litefin:sessions = [{userId, accessToken, ...}]
     * New format: litefin:serverSessions = { "https://server.com": [{...}] }
     *
     * This runs once on the first launch with the new code. After that,
     * SERVER_SESSIONS already exists and this is a no-op on subsequent boots.
     * The old litefin:sessions key is cleaned up after migration.
     * @private
     */
    _migrateServerSessions() {
        // Already on the new format — nothing to do
        if (storage.getItem(STORAGE_KEYS.SERVER_SESSIONS) !== null) return;

        const serverUrl      = storage.getItem(STORAGE_KEYS.SERVER_URL);
        const flatSessionRaw = storage.getItem(STORAGE_KEYS.SESSIONS);

        let initialMap = {};

        if (flatSessionRaw && serverUrl) {
            // Existing users: lift the flat sessions array into the server's slot
            try {
                const flatSessions = JSON.parse(flatSessionRaw);
                if (Array.isArray(flatSessions) && flatSessions.length > 0) {
                    log.info(`Migrating ${flatSessions.length} session(s) for ${serverUrl} to per-server format`);
                    initialMap[serverUrl] = flatSessions;
                }
            } catch (e) {
                log.error('Failed to parse legacy sessions during migration:', e);
            }
        }

        // Write the new keyed map (may be empty on fresh installs)
        storage.setItem(STORAGE_KEYS.SERVER_SESSIONS, JSON.stringify(initialMap));

        // Remove the old flat key — it is superseded by SERVER_SESSIONS
        storage.removeItem(STORAGE_KEYS.SESSIONS);

        log.info('Per-server session migration complete');
    }

    /**
     * Attempt to restore the last active session from the sessions array.
     * Validates the token by calling the server; clears the specific session
     * on 401/403 so stale entries don't accumulate.
     *
     * @returns {Promise<boolean>} True if the session was valid and restored
     * @private
     */
    async _restoreSession() {
        log.info('_restoreSession() called');

        const serverUrl    = storage.getItem(STORAGE_KEYS.SERVER_URL);
        const sessions     = this._loadSessions();
        const activeUserId = storage.getItem(STORAGE_KEYS.ACTIVE_USER);

        log.debug('Restore check:', {
            hasServerUrl:    !!serverUrl,
            sessionCount:    sessions.length,
            hasActiveUserId: !!activeUserId
        });

        if (!serverUrl || sessions.length === 0 || !activeUserId) {
            log.info('Missing credentials — cannot restore');
            // Publish session count so App.js routing can make decisions
            state.set('user:sessionCount', sessions.length);
            return false;
        }

        // Find the session that was active when we last quit
        const session = sessions.find((s) => s.userId === activeUserId);
        if (!session) {
            log.warn('Active user ID not found in sessions array — clearing activeUserId');
            storage.removeItem(STORAGE_KEYS.ACTIVE_USER);
            state.set('user:sessionCount', sessions.length);
            return false;
        }

        // Arm ApiClient with the saved credentials
        api.setServer(serverUrl);
        api.setAuth(session.accessToken, session.userId);
        log.info('API configured with saved credentials');

        // Validate token with a server round-trip
        try {
            log.info('Validating token by fetching current user...');
            // Use a 5s timeout instead of 30s to quickly detect offline hosts on boot
            const user = await api.getCurrentUser({ timeout: 5000 });
            log.info('Token valid, user:', user?.Name);

            // Sync the stored session with fresh user data from the server
            this._saveSession({
                userId:          user.Id,
                accessToken:     session.accessToken,
                userName:        user.Name || '',
                primaryImageTag: user.PrimaryImageTag || null
            });

            // Publish authenticated state
            state.set('user:data',        user);
            state.set('user:authenticated', true);
            state.set('server:connected', true);
            state.set('server:offline',   false);
            state.set('user:sessionCount', this._loadSessions().length);

            // Report capabilities to make this user visible as "online" in the dashboard
            log.info('Reporting capabilities to server...');
            try {
                await api.reportCapabilities({
                    ...SUPPORTED_CAPABILITIES,
                    DeviceProfile: buildJellyfinProfile()
                });
                log.info('✓ Capabilities reported on restore — user is online');
            } catch (e) {
                log.error('✗ Failed to report capabilities on restore:', e);
            }

            // Open WebSocket for real-time dashboard presence
            api.openWebSocket();

            return true;
        } catch (error) {
            if (error instanceof ServerUnreachableError) {
                // Server unreachable — keep credentials for when it comes back
                log.warn('Server unreachable during restore. Preserving credentials for retry.');
                state.set('server:connected', false);
                state.set('server:offline',   true);
                state.set('user:authenticated', false);
                state.set('user:sessionCount', sessions.length);
                return false;
            }

            if (error.status === 401 || error.status === 403) {
                // Token explicitly rejected by server — prune this specific session
                log.warn('Session expired or unauthorized. Removing this session from storage.');
                this._removeSession(activeUserId);
                storage.removeItem(STORAGE_KEYS.ACTIVE_USER);
                api.clearAuth();
            } else {
                // Unexpected error (500, parse failure) — don't nuke the session
                log.warn(`Unexpected restore error (status ${error.status ?? '??'}) — preserving session.`, error);
            }

            state.set('user:sessionCount', this._loadSessions().length);
            return false;
        }
    }

    // ========================================================================
    // Server Connection
    // ========================================================================

    /**
     * Connect to a Jellyfin server.
     * @param {string} serverUrl - Server URL
     * @returns {Promise<Object>} Server public info
     */
    async connectToServer(serverUrl) {
        log.info(`Connecting to ${serverUrl}`);

        api.setServer(serverUrl);

        try {
            // Short timeout so the UI doesn't hang if the user types a dead IP
            const info = await api.getPublicInfo({ timeout: 5000 });

            // Persist the server URL
            storage.setItem(STORAGE_KEYS.SERVER_URL, serverUrl);

            state.set('server:connected', true);
            state.set('server:offline',   false);
            state.set('server:info',      info);

            eventBus.emit('auth:serverConnected', info);

            log.info(`Connected to ${info.ServerName} (v${info.Version})`);
            return info;
        } catch (error) {
            state.set('server:connected', false);
            throw new Error(`Failed to connect: ${error.message}`);
        }
    }

    /**
     * Lightweight check to see if the server is reachable.
     * @returns {Promise<boolean>} True if reachable
     */
    async checkServerStatus() {
        const url = this.getSavedServerUrl();
        if (!url) return false;

        try {
            // Very short timeout for background polling
            await api.getPublicInfo({ timeout: 3000 });
            return true;
        } catch (e) {
            return false;
        }
    }

    /**
     * Get the saved server URL.
     * @returns {string|null} Server URL or null
     */
    getSavedServerUrl() {
        return storage.getItem(STORAGE_KEYS.SERVER_URL);
    }

    // ========================================================================
    // User Management
    // ========================================================================

    /**
     * Get list of public users from the server.
     * @returns {Promise<Array>} Public users array
     */
    async getPublicUsers() {
        return api.getPublicUsers();
    }

    /**
     * Authenticate a user by username and password.
     * On success the session is *added* to the sessions array (not overwritten),
     * and the new user is set as the active session.
     *
     * @param {string} username - Jellyfin username (case-insensitive on most servers)
     * @param {string} [password=''] - Password; empty string for passwordless users
     * @returns {Promise<Object>} Authentication result from the server
     */
    async login(username, password = '') {
        log.info(`Logging in as "${username}"`);

        // Save in-memory credentials so we can restore them if this login fails
        // (prevents the app from being half-logged-out on a wrong password)
        const prevToken  = api.accessToken;
        const prevUserId = api.userId;

        try {
            // Clear in-memory token so ApiClient doesn't send a stale one in the header
            api.setAuth(null, null);

            // Call the Jellyfin authenticate endpoint
            const result = await api.post('/Users/AuthenticateByName', {
                Username: username,
                Pw: password,
                // Newer Jellyfin versions (10.9+) strictly validate IAuthenticationRequest
                // parameters in the POST body rather than relying on the Auth header
                App: api.clientName,
                Device: api.deviceName,
                DeviceId: api.deviceId,
                Version: api.clientVersion
            });

            // Unpack response
            const accessToken = result.AccessToken || result.accessToken;
            const user        = result.User        || result.user;
            const userId      = user?.Id           || user?.id;

            if (!accessToken || !userId) {
                log.error('Invalid login response structure', result);
                throw new Error('Invalid server response');
            }

            // --- Persist the new session ---
            // We add-or-update so the same user can upgrade their token
            // (e.g., they were added before and are logging in again)
            this._saveSession({
                userId,
                accessToken,
                userName:        user.Name             || '',
                primaryImageTag: user.PrimaryImageTag  || null
            });
            storage.setItem(STORAGE_KEYS.ACTIVE_USER, userId);

            // Arm the API client
            api.setAuth(accessToken, userId);

            // Establish session capabilities
            try {
                await api.reportCapabilities({
                    ...SUPPORTED_CAPABILITIES,
                    DeviceProfile: buildJellyfinProfile()
                });
            } catch (capError) {
                log.warn('Non-fatal: Failed to report capabilities after login:', capError);
            }

            api.openWebSocket();

            // Update app state
            state.set('user:authenticated', true);
            state.set('user:data',          user);
            state.set('user:sessionCount',  this._loadSessions().length);

            eventBus.emit('auth:login', user);
            log.info(`Login successful for "${user.Name || username}"`);

            return result;
        } catch (error) {
            log.error('Login request failed:', error);

            // Restore previous in-memory credentials on failure
            if (prevToken && prevUserId) {
                log.info('Restoring previous in-memory credentials after failed login attempt');
                api.setAuth(prevToken, prevUserId);
            }

            throw error;
        }
    }

    /**
     * Login with a public user object.
     * Checks HasPassword to determine whether a password prompt is needed.
     *
     * @param {Object} user - User object from getPublicUsers()
     * @param {string} [password=''] - Password (only meaningful when HasPassword)
     * @returns {Promise<Object>} Authentication result
     */
    async loginWithUser(user, password = '') {
        const pw = user.HasPassword ? password : '';
        return this.login(user.Name, pw);
    }

    /**
     * Complete login using an authorized Quick Connect secret.
     * Follows the exact same session-persistence path as login().
     *
     * @param {string} secret - Authorized Quick Connect secret
     * @returns {Promise<Object>} Authentication result (same shape as login())
     */
    async loginWithQuickConnect(secret) {
        log.info('Completing login via Quick Connect...');

        try {
            // Exchange the authorized secret for a real access token
            const result = await api.authenticateWithQuickConnect(secret);

            const accessToken = result.AccessToken || result.accessToken;
            const user        = result.User        || result.user;
            const userId      = user?.Id           || user?.id;

            if (!accessToken || !userId) {
                log.error('Invalid Quick Connect auth response structure', result);
                throw new Error('Invalid server response from Quick Connect');
            }

            // Persist — same add-or-update path as manual login
            this._saveSession({
                userId,
                accessToken,
                userName:        user.Name             || '',
                primaryImageTag: user.PrimaryImageTag  || null
            });
            storage.setItem(STORAGE_KEYS.ACTIVE_USER, userId);

            // Arm ApiClient
            api.setAuth(accessToken, userId);

            // Report capabilities
            try {
                await api.reportCapabilities({
                    ...SUPPORTED_CAPABILITIES,
                    DeviceProfile: buildJellyfinProfile()
                });
            } catch (capError) {
                log.warn('Non-fatal: Failed to report capabilities after Quick Connect login:', capError);
            }

            // Establish WebSocket presence
            api.openWebSocket();

            // Update app state
            state.set('user:authenticated', true);
            state.set('user:data',          user);
            state.set('user:sessionCount',  this._loadSessions().length);

            eventBus.emit('auth:login', user);

            log.info(`Quick Connect login successful for "${user.Name}"`);
            return result;
        } catch (error) {
            log.error('Quick Connect login failed:', error);
            throw error;
        }
    }

    // ========================================================================
    // Session Switching
    // ========================================================================

    /**
     * Switch the active user to another stored session without requiring
     * a password. The ApiClient credentials are swapped, capabilities are
     * re-reported, and the WebSocket is reset to the new user's token.
     *
     * If the token for the target session has expired, the error is surfaced
     * to the caller and the bad session is pruned automatically.
     *
     * @param {string} userId - The userId of the session to switch to
     * @returns {Promise<Object>} The user's current profile from the server
     */
    async switchUser(userId) {
        log.info(`Switching to user ${userId}...`);

        const sessions = this._loadSessions();
        const session  = sessions.find((s) => s.userId === userId);

        if (!session) {
            throw new Error(`No stored session found for user ${userId}`);
        }

        // Close the previous user's WebSocket (marks old user offline on server)
        api.closeWebSocket();

        // Swap ApiClient to the new user's credentials
        api.setAuth(session.accessToken, session.userId);

        try {
            // Validate and fetch fresh profile data in one call
            const user = await api.getCurrentUser();

            // Update the session with fresher data (image tag may have changed)
            this._saveSession({
                userId:          user.Id,
                accessToken:     session.accessToken,
                userName:        user.Name             || '',
                primaryImageTag: user.PrimaryImageTag  || null
            });
            storage.setItem(STORAGE_KEYS.ACTIVE_USER, userId);

            // Report capabilities for the new session
            try {
                await api.reportCapabilities({
                    ...SUPPORTED_CAPABILITIES,
                    DeviceProfile: buildJellyfinProfile()
                });
                log.info('✓ Capabilities reported for switched user');
            } catch (e) {
                log.warn('Non-fatal: Failed to report capabilities on user switch:', e);
            }

            // Establish new WebSocket for the switched-to user
            api.openWebSocket();

            // Update global state to reflect the new active user
            state.set('user:authenticated', true);
            state.set('user:data',          user);
            state.set('user:sessionCount',  sessions.length);

            eventBus.emit('auth:login', user);
            log.info(`Switched to user "${user.Name}"`);

            return user;
        } catch (error) {
            if (error.status === 401 || error.status === 403) {
                // Token is dead — remove the stale session from storage
                log.warn(`Token for user ${userId} is expired. Pruning session.`);
                this._removeSession(userId);
                state.set('user:sessionCount', this._loadSessions().length);
            }
            throw error;
        }
    }

    // ========================================================================
    // Logout
    // ========================================================================

    /**
     * Log out the current active user.
     *
     * If other sessions remain, the app emits `auth:switchToProfiles` so the
     * caller (App.js) can navigate to the "Who's Watching" screen instead of
     * the login page. If this was the last session, `auth:logout` is emitted
     * and the app resets to the login page.
     *
     * The server is always notified via /Sessions/Logout (best-effort).
     */
    async logout() {
        log.info('Logging out current user...');

        const activeUserId = storage.getItem(STORAGE_KEYS.ACTIVE_USER);
        const sessions     = this._loadSessions();
        const session      = sessions.find((s) => s.userId === activeUserId);

        // Close WebSocket immediately (marks this user offline on the dashboard)
        api.closeWebSocket();

        // Notify the server while we still have valid credentials (best-effort)
        if (session && api._serverUrl) {
            const url        = `${api._serverUrl}/Sessions/Logout`;
            const authHeader = api.getAuthHeader(session.accessToken);

            log.info('Notifying server of logout...');
            try {
                await fetch(url, {
                    method:  'POST',
                    headers: {
                        'X-Emby-Authorization': authHeader,
                        'Content-Type': 'application/json'
                    }
                });
                log.info('Server notified of logout');
            } catch (e) {
                log.warn('Server logout request failed (best-effort):', e.message);
            }
        }

        // Remove only this user's session from storage
        if (activeUserId) {
            this._removeSession(activeUserId);
            storage.removeItem(STORAGE_KEYS.ACTIVE_USER);
        }

        // Clear ApiClient credentials for this user
        api.clearAuth();
        state.set('user:authenticated', false);
        state.set('user:data',          null);

        const remaining = this._loadSessions();
        state.set('user:sessionCount', remaining.length);

        if (remaining.length > 0) {
            /*
             * Other users are still logged in — go to the profiles screen
             * instead of the login page. App.js listens for this event.
             */
            log.info(`Logout complete. ${remaining.length} session(s) remain — routing to profiles.`);
            eventBus.emit('auth:switchToProfiles');
        } else {
            // This was the last session — fall back to the login page
            log.info('Logout complete. No remaining sessions — routing to login.');
            eventBus.emit('auth:logout');
        }
    }

    /**
     * Disconnect from the current server without wiping stored credentials.
     *
     * Used by "Switch Server" on the profiles screen. Sessions for ALL servers
     * (including the current one) are intentionally preserved in
     * litefin:serverSessions so the user can return later without re-login.
     *
     * Only the active server pointer and active user marker are cleared.
     */
    async logoutAll() {
        log.info('Disconnecting from current server (all server sessions preserved)...');

        // Close WebSocket cleanly before dropping credentials
        api.closeWebSocket();

        // Clear the active server + user pointers — sessions themselves are kept
        // intact inside litefin:serverSessions for future reconnection.
        storage.removeItem(STORAGE_KEYS.ACTIVE_USER);
        storage.removeItem(STORAGE_KEYS.SERVER_URL);

        // Detach the API client so it doesn't auto-reconnect with stale credentials
        api.clearAuth();
        api.setServer('');

        // Reset application state
        state.set('user:authenticated', false);
        state.set('user:data',          null);
        state.set('user:sessionCount',  0);
        state.set('server:connected',   false);

        // Route to login page
        eventBus.emit('auth:logout');
        log.info('Disconnected from server. Saved sessions for all servers are intact.');
    }

    // ========================================================================
    // Session Accessors
    // ========================================================================

    /**
     * Return all stored sessions as an array.
     * Callers should treat this as read-only; use _saveSession/_removeSession
     * to mutate.
     *
     * @returns {Array<{userId, accessToken, userName, primaryImageTag}>}
     */
    getSessions() {
        return this._loadSessions();
    }

    /**
     * Return the session object for the currently active user, or null if none.
     * @returns {{userId, accessToken, userName, primaryImageTag}|null}
     */
    getActiveSession() {
        const activeUserId = storage.getItem(STORAGE_KEYS.ACTIVE_USER);
        if (!activeUserId) return null;
        const sessions = this._loadSessions();
        return sessions.find((s) => s.userId === activeUserId) || null;
    }

    /**
     * Return the number of stored sessions for the current server.
     * @returns {number}
     */
    getSessionCount() {
        return this._loadSessions().length;
    }

    /**
     * Return all servers that have at least one stored session.
     * Useful for building a server-picker UI in a future iteration.
     *
     * @returns {Array<{serverUrl: string, sessions: Array}>}
     */
    getSavedServers() {
        const map = this._loadAllServerSessions();
        return Object.entries(map)
            .filter(([, sessions]) => Array.isArray(sessions) && sessions.length > 0)
            .map(([serverUrl, sessions]) => ({ serverUrl, sessions }));
    }

    // ========================================================================
    // Event Handlers
    // ========================================================================

    /**
     * Handle 401 Unauthorized from ApiClient.
     * Clears only the current session (not all sessions) so the user is
     * routed to the profiles screen to pick a different, still-valid one.
     * @private
     */
    _onUnauthorized() {
        log.warn('Unauthorized — session expired');

        const activeUserId = storage.getItem(STORAGE_KEYS.ACTIVE_USER);

        // Prune the dead session
        if (activeUserId) {
            this._removeSession(activeUserId);
            storage.removeItem(STORAGE_KEYS.ACTIVE_USER);
        }

        api.clearAuth();
        state.set('user:authenticated', false);
        state.set('user:data',          null);

        const remaining = this._loadSessions();
        state.set('user:sessionCount', remaining.length);

        // Route back to profiles if other sessions remain, otherwise login page
        if (remaining.length > 0) {
            eventBus.emit('auth:switchToProfiles');
        } else {
            eventBus.emit('auth:expired');
        }
    }

    /**
     * Dynamically update device name when WebOS hardware capability detection
     * completes after initial startup. Fixes "LG WebOS TV" generic names.
     * @param {Object} info - Device info from webOS adapter
     * @private
     */
    _onWebosDeviceInfo(info) {
        if (!info || !info.modelName || !platformInfo.isWebOS) return;

        const deviceId = storage.getItem(STORAGE_KEYS.DEVICE_ID);
        if (deviceId) {
            log.info(`Updating API device name to WebOS model: ${info.modelName}`);
            api.setDevice(deviceId, info.modelName);

            // Re-report capabilities so the dashboard shows the correct device name
            if (this.isAuthenticated()) {
                api.reportCapabilities({
                    ...SUPPORTED_CAPABILITIES,
                    DeviceProfile: buildJellyfinProfile()
                }).catch((e) => log.warn('Failed to report capabilities for late device name update:', e));
            }
        }
    }

    // ========================================================================
    // Private — Per-Server Sessions CRUD
    // ========================================================================

    /**
     * Load the full per-server session map from storage.
     * Always returns a plain object — never throws.
     *
     * @returns {{ [serverUrl: string]: Array }} The full keyed map
     * @private
     */
    _loadAllServerSessions() {
        try {
            const raw = storage.getItem(STORAGE_KEYS.SERVER_SESSIONS);
            if (!raw) return {};
            const parsed = JSON.parse(raw);
            // Guard against corrupt / unexpected data shapes
            return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
        } catch (e) {
            log.error('Failed to parse serverSessions from storage — returning empty map:', e);
            return {};
        }
    }

    /**
     * Load sessions for the currently active server.
     * Safe: always returns an array even if storage is empty or corrupted.
     *
     * @returns {Array<{userId, accessToken, userName, primaryImageTag}>}
     * @private
     */
    _loadSessions() {
        const serverUrl = storage.getItem(STORAGE_KEYS.SERVER_URL);
        // Cannot scope sessions without a server URL
        if (!serverUrl) return [];

        const map      = this._loadAllServerSessions();
        const sessions = map[serverUrl];
        return Array.isArray(sessions) ? sessions : [];
    }

    /**
     * Persist the sessions array for the currently active server.
     * Other servers' sessions remain untouched.
     *
     * @param {Array} sessions - Updated sessions for the active server
     * @private
     */
    _writeSessions(sessions) {
        const serverUrl = storage.getItem(STORAGE_KEYS.SERVER_URL);
        if (!serverUrl) {
            log.warn('_writeSessions: no active server URL — sessions not saved');
            return;
        }

        // Read the full map, update only the active server's slot, then write back
        const map    = this._loadAllServerSessions();
        map[serverUrl] = sessions;
        storage.setItem(STORAGE_KEYS.SERVER_SESSIONS, JSON.stringify(map));
    }

    /**
     * Add a new session or update an existing one (matched by userId).
     * Enforces the MAX_SESSIONS cap by removing the oldest entry when full.
     *
     * @param {{userId, accessToken, userName, primaryImageTag}} session
     * @private
     */
    _saveSession(session) {
        const sessions = this._loadSessions();

        // Find and replace an existing entry for the same user
        const existingIdx = sessions.findIndex((s) => s.userId === session.userId);

        if (existingIdx !== -1) {
            sessions[existingIdx] = session;
        } else {
            // Enforce cap before adding a brand-new entry
            if (sessions.length >= MAX_SESSIONS) {
                const removed = sessions.shift(); // Remove oldest (front of array)
                log.warn(`Session cap (${MAX_SESSIONS}) reached — evicted oldest session for ${removed.userName}`);
            }
            sessions.push(session);
        }

        this._writeSessions(sessions);
    }

    /**
     * Remove a session by userId.
     * @param {string} userId
     * @private
     */
    _removeSession(userId) {
        const sessions = this._loadSessions();
        const filtered = sessions.filter((s) => s.userId !== userId);
        this._writeSessions(filtered);
        log.debug(`Session removed for user ${userId}. Remaining: ${filtered.length}`);
    }

    // ========================================================================
    // Utilities
    // ========================================================================

    /**
     * Generate UUID v4
     * @returns {string}
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
     * Get the current active user's profile data from app state.
     * @returns {Object|null} User data
     */
    getCurrentUser() {
        return state.get('user:data');
    }

    /**
     * Check if there is an active authenticated session.
     * @returns {boolean}
     */
    isAuthenticated() {
        return state.get('user:authenticated', false);
    }
}

// Export singleton
export const auth = new AuthManager();

export default AuthManager;
