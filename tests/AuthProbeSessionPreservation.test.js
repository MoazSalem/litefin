import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/**
 * ============================================================================
 * Auth Probe & Session Preservation Test Suite
 * ============================================================================
 * Verifies that:
 * 1. ApiClient._handleError suppresses `api:unauthorized` events for:
 *    - Authentication endpoints (/Users/AuthenticateByName, /Users/AuthenticateWithQuickConnect)
 *    - Requests with suppressUnauthorized or silent options
 *    - Unauthenticated requests (no active session token present)
 * 2. Authenticated requests with an active token continue to trigger `api:unauthorized`
 *    on genuine session expirations (e.g. 401 on /Items or /Users/{id}).
 * 3. AuthManager shields active stored sessions when candidate login probes fail.
 * 4. LoginPage._selectUser passes { silent: true } during the JF12+ passwordless probe.
 * ============================================================================
 */

test('ApiClient._handleError suppresses api:unauthorized for authentication endpoints and unauthenticated requests', async () => {
    // Read ApiClient source to exercise the exact _handleError logic
    const apiClientSource = readFileSync(new URL('../src/api/ApiClient.js', import.meta.url), 'utf8')
        .replace(/\r\n/g, '\n');

    // Extract the _handleError method implementation
    const methodMatch = apiClientSource.match(/async _handleError\(response, endpoint = '', options = \{\}\)\s*\{([\s\S]*?)\n {4}\}\n/);
    assert.ok(methodMatch, 'ApiClient._handleError should be defined');

    // Create test harness with event capturing
    const emittedEvents = [];
    const mockEventBus = {
        emit: (name, payload) => emittedEvents.push({ name, payload })
    };
    const mockLog = {
        error: () => {},
        warn: () => {},
        debug: () => {}
    };

    // Helper to run _handleError in a mock ApiClient context
    const runHandleError = async ({ status = 401, endpoint = '', options = {}, accessToken = null, bodyText = '' }) => {
        emittedEvents.length = 0;
        const mockResponse = {
            status,
            text: async () => bodyText,
            _suppressErrorLog: false
        };

        const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
        const context = {
            _accessToken: accessToken,
            _handleError: new AsyncFunction(
                'response',
                'endpoint = ""',
                'options = {}',
                'eventBus',
                'log',
                methodMatch[1]
            )
        };

        try {
            await context._handleError(mockResponse, endpoint, options, mockEventBus, mockLog);
        } catch (err) {
            return err;
        }
        return null;
    };

    // Scenario 1: Empty-password probe on /Users/AuthenticateByName (Jellyfin 12+ user selection)
    // Must NOT emit api:unauthorized even if a token was hypothetically present
    await runHandleError({
        status: 401,
        endpoint: '/Users/AuthenticateByName',
        options: { silent: true },
        accessToken: null
    });
    assert.equal(emittedEvents.length, 0, 'Must not emit api:unauthorized for /Users/AuthenticateByName probe');

    // Scenario 2: Interactive login failure on /Users/AuthenticateByName (wrong password typed)
    await runHandleError({
        status: 401,
        endpoint: '/Users/AuthenticateByName',
        options: { suppressUnauthorized: true },
        accessToken: null
    });
    assert.equal(emittedEvents.length, 0, 'Must not emit api:unauthorized on wrong password login failure');

    // Scenario 3: Quick Connect authentication failure
    await runHandleError({
        status: 401,
        endpoint: '/Users/AuthenticateWithQuickConnect',
        options: {},
        accessToken: null
    });
    assert.equal(emittedEvents.length, 0, 'Must not emit api:unauthorized for /Users/AuthenticateWithQuickConnect');

    // Scenario 4: Request without active token returning 401
    await runHandleError({
        status: 401,
        endpoint: '/System/Info',
        options: {},
        accessToken: null
    });
    assert.equal(emittedEvents.length, 0, 'Must not emit api:unauthorized when no active session token was attached');

    // Scenario 5: Genuine session expiry (authenticated request with valid token rejected by server)
    await runHandleError({
        status: 401,
        endpoint: '/Items',
        options: {},
        accessToken: 'active-session-token-abc'
    });
    assert.equal(emittedEvents.length, 1, 'Must emit api:unauthorized for genuine authenticated session expiry');
    assert.equal(emittedEvents[0].name, 'api:unauthorized');
});

test('AuthManager._onUnauthorized preserves active session during login attempts and probes', () => {
    // Read AuthManager source to inspect _onUnauthorized guards
    const authManagerSource = readFileSync(new URL('../src/api/AuthManager.js', import.meta.url), 'utf8')
        .replace(/\r\n/g, '\n');

    // Extract _onUnauthorized implementation
    const methodMatch = authManagerSource.match(/_onUnauthorized\(\)\s*\{([\s\S]*?)\n {4}\}\n/);
    assert.ok(methodMatch, 'AuthManager._onUnauthorized should be defined');

    const emittedEvents = [];
    const removedSessions = [];
    const mockStorage = {
        _map: new Map([['litefin:activeUser', 'user-a-uuid']]),
        getItem(key) { return this._map.get(key) ?? null; },
        removeItem(key) { this._map.delete(key); }
    };

    const createAuthContext = ({ isLoggingIn = false, apiToken = 'valid-token' }) => ({
        _isLoggingIn: isLoggingIn,
        _removeSession: (id) => removedSessions.push(id),
        _loadSessions: () => ['user-a-session'],
        _onUnauthorized: new Function(
            'storage',
            'api',
            'state',
            'eventBus',
            'log',
            'STORAGE_KEYS',
            methodMatch[1]
        )
    });

    const mockApi = (token) => ({
        accessToken: token,
        clearAuth: () => {}
    });

    const mockState = { set: () => {} };
    const mockEventBus = { emit: (name) => emittedEvents.push(name) };
    const mockLog = { warn: () => {}, debug: () => {} };
    const STORAGE_KEYS = { ACTIVE_USER: 'litefin:activeUser' };

    // Case 1: 401 arrives while _isLoggingIn guard is active (e.g. silent probe in flight)
    emittedEvents.length = 0;
    removedSessions.length = 0;
    mockStorage._map.set('litefin:activeUser', 'user-a-uuid');
    const ctxLoggingIn = createAuthContext({ isLoggingIn: true, apiToken: 'token' });
    ctxLoggingIn._onUnauthorized(mockStorage, mockApi('token'), mockState, mockEventBus, mockLog, STORAGE_KEYS);

    assert.equal(removedSessions.length, 0, 'Active user session must NOT be removed when _isLoggingIn is true');
    assert.equal(mockStorage.getItem('litefin:activeUser'), 'user-a-uuid', 'Active user key must remain intact');
    assert.equal(emittedEvents.length, 0, 'No expiry/switching events should be emitted');

    // Case 2: 401 arrives when api has no active token (unauthenticated state)
    emittedEvents.length = 0;
    removedSessions.length = 0;
    mockStorage._map.set('litefin:activeUser', 'user-a-uuid');
    const ctxNoToken = createAuthContext({ isLoggingIn: false, apiToken: null });
    ctxNoToken._onUnauthorized(mockStorage, mockApi(null), mockState, mockEventBus, mockLog, STORAGE_KEYS);

    assert.equal(removedSessions.length, 0, 'Active user session must NOT be removed when api.accessToken is null');
    assert.equal(mockStorage.getItem('litefin:activeUser'), 'user-a-uuid', 'Active user key must remain intact');

    // Case 3: 401 arrives during normal app usage with active token (genuine session expiry)
    emittedEvents.length = 0;
    removedSessions.length = 0;
    mockStorage._map.set('litefin:activeUser', 'user-a-uuid');
    const ctxExpired = createAuthContext({ isLoggingIn: false, apiToken: 'token' });
    ctxExpired._onUnauthorized(mockStorage, mockApi('token'), mockState, mockEventBus, mockLog, STORAGE_KEYS);

    assert.equal(removedSessions.length, 1, 'Active user session MUST be removed on genuine session expiry');
    assert.equal(removedSessions[0], 'user-a-uuid');
    assert.equal(emittedEvents.includes('auth:switchToProfiles'), true, 'Should switch profiles if remaining sessions exist');
});

test('LoginPage._selectUser invokes silent probe with silent: true option', () => {
    // Read LoginPage.js source
    const loginPageSource = readFileSync(new URL('../src/pages/LoginPage.js', import.meta.url), 'utf8')
        .replace(/\r\n/g, '\n');

    // Verify silent: true is explicitly passed to auth.login in the probe block
    assert.ok(
        loginPageSource.includes("await auth.login(user.Name, '', { silent: true });"),
        'LoginPage._selectUser must invoke auth.login with { silent: true }'
    );
});

test('LoginPage._selectUser executes direct login when user.HasPassword === false', () => {
    // Read LoginPage.js source
    const loginPageSource = readFileSync(new URL('../src/pages/LoginPage.js', import.meta.url), 'utf8')
        .replace(/\r\n/g, '\n');

    // Verify explicit HasPassword === false branch logs in directly
    assert.ok(
        loginPageSource.includes('if (user.HasPassword === false)'),
        'LoginPage._selectUser must check for explicit user.HasPassword === false'
    );
    assert.ok(
        loginPageSource.includes("await auth.login(user.Name, '');"),
        'LoginPage._selectUser must directly log in passwordless users'
    );
});
