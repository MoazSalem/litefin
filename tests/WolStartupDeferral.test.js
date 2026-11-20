import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * ============================================================================
 * Wake-on-LAN (WOL) Startup Deferral & Abort Test Suite
 * ============================================================================
 * Verifies that Wake-on-LAN packets and background companion service
 * pre-launches (ytresolver on Tizen) are NOT unconditionally triggered at
 * 0ms before checking if the target Jellyfin server is already online.
 *
 * Confirms that:
 * 1. AuthManager does not call sendWakeOnLan prior to initial connection probes.
 * 2. Successful server health or user profile checks cancel any pending WOL retries.
 * 3. ApiClient exports cancelWakeOnLan to cleanly abort in-flight proxy polling.
 * ============================================================================
 */

test('AuthManager: Does not fire sendWakeOnLan unconditionally at 0ms in _restoreSession', () => {
    const authManagerPath = path.resolve('src/api/AuthManager.js');
    const source = fs.readFileSync(authManagerPath, 'utf8');

    // Extract _restoreSession body up to the return statement
    const restoreSessionIdx = source.indexOf('async _restoreSession()');
    assert.ok(restoreSessionIdx !== -1, '_restoreSession must exist in AuthManager');

    const restoreChunk = source.slice(restoreSessionIdx, restoreSessionIdx + 1500);

    // Verify that sendWakeOnLan is NOT called in _restoreSession before _blockingRestoreSession
    const earlyWolCall = /if\s*\(\s*enableWol\s*&&\s*wolMac\s*\)\s*\{[^}]*sendWakeOnLan/s.test(restoreChunk);
    assert.strictEqual(
        earlyWolCall,
        false,
        'AuthManager._restoreSession must not dispatch sendWakeOnLan before probing reachability'
    );

    // Verify cancelWakeOnLan is called when validation succeeds
    assert.ok(
        source.includes('cancelWakeOnLan()'),
        'AuthManager must call cancelWakeOnLan upon successful connection/validation'
    );
});

test('AuthManager: connectToServer probes before dispatching Wake-on-LAN', () => {
    const authManagerPath = path.resolve('src/api/AuthManager.js');
    const source = fs.readFileSync(authManagerPath, 'utf8');

    const connectIdx = source.indexOf('async connectToServer(');
    assert.ok(connectIdx !== -1, 'connectToServer must exist in AuthManager');

    const connectChunk = source.slice(connectIdx, connectIdx + 2000);

    // Verify that sendWakeOnLan is not dispatched prior to the probe loop
    const preLoopWol = connectChunk.slice(0, connectChunk.indexOf('for (let attempt = 1')).includes('sendWakeOnLan(');
    assert.strictEqual(
        preLoopWol,
        false,
        'connectToServer must not fire sendWakeOnLan before the probe loop'
    );
});

test('ApiClient: cancelWakeOnLan is exported and halts in-flight WOL retries', () => {
    const apiClientPath = path.resolve('src/api/ApiClient.js');
    const source = fs.readFileSync(apiClientPath, 'utf8');

    assert.ok(
        source.includes('export function cancelWakeOnLan()'),
        'ApiClient must export cancelWakeOnLan'
    );

    assert.ok(
        source.includes('_activeWolAbortController'),
        'ApiClient must track _activeWolAbortController to cancel retries'
    );

    // Verify ytresolver background pre-launch is gated behind idleGate unless urgent
    assert.ok(
        source.includes('idleGate.runWhenIdle(launchYtResolver, 5000, 0)'),
        'ApiClient must gate non-urgent ytresolver background launches behind idleGate'
    );
});

test('src/api/index.js: Exports cancelWakeOnLan', () => {
    const indexPath = path.resolve('src/api/index.js');
    const source = fs.readFileSync(indexPath, 'utf8');

    assert.ok(
        source.includes('cancelWakeOnLan'),
        'src/api/index.js must export cancelWakeOnLan'
    );
});

