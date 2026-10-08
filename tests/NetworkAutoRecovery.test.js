import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Provide minimum browser environment globals for module importing
if (typeof globalThis.window === 'undefined') {
    globalThis.window = globalThis;
}
if (typeof globalThis.document === 'undefined') {
    globalThis.document = { hidden: false };
}
if (typeof globalThis.__APP_VERSION__ === 'undefined') {
    globalThis.__APP_VERSION__ = '1.9.20';
}
if (typeof globalThis.localStorage === 'undefined') {
    globalThis.localStorage = {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {}
    };
}

// Resolve current directory path in ES module environment
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('Network AutoRecovery: PlayerPage does not bind websocket:disconnected to offline recovery', () => {
    // Read the current PlayerPage source file directly from disk
    const playerPagePath = path.resolve(__dirname, '../src/pages/PlayerPage.js');
    const playerPageSrc = fs.readFileSync(playerPagePath, 'utf8');

    // =========================================================================
    // Verification 1: websocket:disconnected must not trigger network offline
    // =========================================================================
    // WebSocket disconnects frequently occur due to idle timeouts, proxies, or
    // transient keepalive misses while HTTP media streaming continues uninterrupted.
    // If PlayerPage listens to websocket:disconnected for _handleNetworkOffline,
    // active video playback gets prematurely killed and reloaded.
    assert.strictEqual(
        playerPageSrc.includes("eventBus.on('websocket:disconnected'"),
        false,
        'PlayerPage must not bind websocket:disconnected to network offline handlers'
    );

    // =========================================================================
    // Verification 2: Cleanup must not reference websocket:disconnected
    // =========================================================================
    assert.strictEqual(
        playerPageSrc.includes("eventBus.off('websocket:disconnected'"),
        false,
        'PlayerPage destroy must not reference websocket:disconnected'
    );

    // =========================================================================
    // Verification 3: Stall watchdog must not treat isWebSocketConnected as offline
    // =========================================================================
    // During a temporary buffer stall (3.5s), media fetch may still be working.
    // Checking api.isWebSocketConnected would falsely trigger recovery if the socket
    // happens to be reconnecting in the background.
    assert.strictEqual(
        playerPageSrc.includes('isWsDisconnected'),
        false,
        'PlayerPage stall watchdog must not trip auto-recovery based on WebSocket connection state'
    );
});

test('WebSocket KeepAlive: ApiClient exposes sendWebSocketKeepAlive and sends correct frame', async () => {
    // Dynamic import of ApiClient class
    const { ApiClient } = await import('../src/api/ApiClient.js');

    // Create a mock ApiClient instance with a simulated WebSocket connection
    const client = new ApiClient();
    let sentPayload = null;

    // Simulate an open WebSocket state
    client._webSocket = {
        readyState: 1, // WebSocket.OPEN
        send: (data) => {
            sentPayload = data;
        }
    };

    // Invoke the keepalive dispatch helper
    client.sendWebSocketKeepAlive();

    // Verify that the exact JSON structure expected by Jellyfin was transmitted
    assert.notStrictEqual(sentPayload, null, 'sendWebSocketKeepAlive must send a payload');
    const parsed = JSON.parse(sentPayload);
    assert.strictEqual(parsed.MessageType, 'KeepAlive', 'Sent payload MessageType must be KeepAlive');

    // Ensure it safely does not throw when socket is closed or null
    client._webSocket = null;
    assert.doesNotThrow(() => {
        client.sendWebSocketKeepAlive();
    });
});

test('WebSocket KeepAlive: WebSocketHandler responds to ForceKeepAlive by dispatching KeepAlive', () => {
    // Read the WebSocketHandler source code to verify message dispatch behavior
    const wsHandlerPath = path.resolve(__dirname, '../src/api/WebSocketHandler.js');
    const wsHandlerSrc = fs.readFileSync(wsHandlerPath, 'utf8');

    // Verify that ForceKeepAlive has an explicit handler routing to sendWebSocketKeepAlive
    assert.strictEqual(
        wsHandlerSrc.includes("case 'ForceKeepAlive':"),
        true,
        'WebSocketHandler must have an explicit case handling ForceKeepAlive'
    );

    assert.strictEqual(
        wsHandlerSrc.includes('api.sendWebSocketKeepAlive?.()'),
        true,
        'WebSocketHandler must call api.sendWebSocketKeepAlive() when ForceKeepAlive is received'
    );
});
