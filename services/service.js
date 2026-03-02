/* eslint-disable */
// -*- coding: utf-8 -*-

/*
 * ============================================================================
 * Litefin - WebOS Background Discovery Service
 * ============================================================================
 * This is a Node.js service that runs natively on WebOS (outside the browser
 * sandbox) and performs proper Jellyfin UDP autodiscovery on port 7359.
 *
 * Why a native service instead of doing this from the web page?
 *   Web pages cannot send raw UDP packets — the browser security model blocks
 *   all non-HTTP/WebSocket network access. A WebOS background service runs in
 *   Node.js and has full access to the OS networking stack via `dgram`.
 *
 * Protocol:
 *   1. Broadcast "who is JellyfinServer?" to 255.255.255.255:7359 (UDP)
 *   2. Jellyfin servers respond with JSON: { Id, Name, Address, EndpointAddress }
 *   3. Results are pushed to all subscribed web-page callers via Luna bus
 *
 * Luna service ID: org.litefin.app.service
 * Registered method: luna://org.litefin.app.service/discover
 * ============================================================================
 */

var pkgInfo = require('./package.json');
var Service = require('webos-service');

// Register the service on both the public and private Luna buses
var service = new Service(pkgInfo.name);

var dgram = require('dgram');

// UDP socket for Jellyfin broadcast/response
var udpClient = dgram.createSocket('udp4');

// Jellyfin autodiscovery constants (protocol is fixed — do not change)
const DISCOVERY_PORT = 7359;
const DISCOVERY_MESSAGE = 'who is JellyfinServer?';

/*
 * How often to re-broadcast the discovery probe while there are active
 * subscriptions. 15 seconds is what the official jellyfin-webos app uses.
 */
const RESCAN_INTERVAL_MS = 15 * 1000;

/*
 * Accumulated discovery results, keyed by server ID so duplicates are
 * naturally deduplicated on re-broadcast.
 */
var scanResults = {};

/*
 * Active Luna message subscriptions.
 * Keyed by message.uniqueToken so we can cancel them individually.
 */
var subscriptions = {};

var rescanInterval;

// ============================================================================
// UDP socket setup
// ============================================================================

udpClient.on('listening', function () {
    var addr = udpClient.address();
    console.log('[Litefin Discovery] UDP socket listening on ' + addr.address + ':' + addr.port);

    // Must enable broadcast before sending to 255.255.255.255
    udpClient.setBroadcast(true);
    udpClient.setMulticastTTL(128);
});

udpClient.on('message', function (message, remote) {
    try {
        var msg = JSON.parse(message.toString('utf-8'));

        // Validate the expected Jellyfin response shape
        if (
            typeof msg === 'object' &&
            typeof msg.Id === 'string' &&
            typeof msg.Name === 'string' &&
            typeof msg.Address === 'string'
        ) {
            // Store/update this server — keyed by Id for deduplication
            scanResults[msg.Id] = {
                Id: msg.Id,
                Name: msg.Name,
                Address: msg.Address,
                // Include the raw UDP source IP in case `Address` is wrong
                sourceAddress: remote.address,
                sourcePort: remote.port
            };

            console.log('[Litefin Discovery] Found server "' + msg.Name + '" at ' + msg.Address);

            // Push this individual result to all subscribers immediately
            pushToSubscribers(msg.Id);
        }
    } catch (err) {
        // Non-Jellyfin UDP traffic on port 7359 — ignore silently
        console.log('[Litefin Discovery] Ignoring non-Jellyfin UDP message: ' + err.message);
    }
});

// Bind the UDP socket — discovery probe is sent once the socket is ready
udpClient.bind({ port: DISCOVERY_PORT }, function () {
    sendDiscoveryProbe();
});

// ============================================================================
// Discovery helpers
// ============================================================================

/**
 * Broadcast the Jellyfin discovery probe to the entire local subnet.
 * Servers respond asynchronously via the `message` event above.
 */
function sendDiscoveryProbe() {
    var msg = Buffer.from(DISCOVERY_MESSAGE);
    udpClient.send(msg, 0, msg.length, DISCOVERY_PORT, '255.255.255.255', function (err) {
        if (err) {
            console.log('[Litefin Discovery] Failed to send probe: ' + err.message);
        } else {
            console.log('[Litefin Discovery] Broadcast probe sent');
        }
    });
}

/**
 * Push the current scan results (or a single server by ID) to all active
 * Luna subscriptions so the web page UI updates in real time.
 *
 * @param {string|null} serverId  If provided, only include that server in the
 *                                response payload (avoids re-sending everything
 *                                on every new discovery).
 */
function pushToSubscribers(serverId) {
    var keys = Object.keys(subscriptions);
    console.log('[Litefin Discovery] Pushing results to ' + keys.length + ' subscriber(s)');

    keys.forEach(function (token) {
        var sub = subscriptions[token];
        var payload;

        if (serverId) {
            // Send only the newly discovered server
            payload = {};
            payload[serverId] = scanResults[serverId];
        } else {
            // Full snapshot of everything found so far
            payload = scanResults;
        }

        sub.respond({ results: payload });
    });
}

/**
 * Start the periodic re-broadcast interval (created lazily when the first
 * subscriber connects, torn down when the last one disconnects).
 */
function startRescanInterval() {
    if (rescanInterval) return;

    console.log('[Litefin Discovery] Starting periodic rescan interval');
    rescanInterval = setInterval(sendDiscoveryProbe, RESCAN_INTERVAL_MS);
}

// ============================================================================
// Luna service registration
// ============================================================================

/*
 * `luna://org.litefin.app.service/discover`
 *
 * Call with `{ subscribe: true }` to receive ongoing push updates.
 * Call without subscribe for a one-shot snapshot of already-seen servers.
 *
 * Response schema:
 *   { results: { [serverId]: { Id, Name, Address, sourceAddress, sourcePort } } }
 */
var discoverMethod = service.register('discover');

discoverMethod.on('request', function (message) {
    // Immediately send any servers we already know about
    pushToSubscribers(null);

    // Always trigger a fresh probe so the caller gets fresh responses quickly
    sendDiscoveryProbe();

    // If the caller wants ongoing updates, register them as a subscriber
    if (message.isSubscription) {
        subscriptions[message.uniqueToken] = message;
        startRescanInterval();
        console.log('[Litefin Discovery] New subscriber: ' + message.uniqueToken);
    }
});

discoverMethod.on('cancel', function (message) {
    var token = message.uniqueToken;
    console.log('[Litefin Discovery] Subscriber cancelled: ' + token);

    delete subscriptions[token];

    // Tear down the interval when nobody is listening
    if (Object.keys(subscriptions).length === 0 && rescanInterval) {
        console.log('[Litefin Discovery] No more subscribers — stopping rescan interval');
        clearInterval(rescanInterval);
        rescanInterval = undefined;
    }
});
