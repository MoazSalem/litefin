/* eslint-disable */
// -*- coding: utf-8 -*-

var isWebOS = false;
try {
    require.resolve('webos-service');
    isWebOS = true;
} catch (e) {
    console.log('[Litefin Service] webos-service not found. Assuming Tizen environment.');
}

if (isWebOS) {
    
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
    
    udpClient.on('error', function (err) {
        console.log('[Litefin Discovery] UDP socket error: ' + err.message);
        try { udpClient.close(); } catch (_) {}
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
        }
    });

    /*
     * `luna://org.litefin.app.service/wol`
     *
     * Call with `{ mac: "00:11:22:33:44:55" }` to send a magic packet.
     */
    var wolMethod = service.register('wol');
    wolMethod.on('request', function (message) {
        var mac = message.payload && message.payload.mac;
        if (!mac) {
            console.log('[Litefin Service] Luna WOL request rejected: Missing MAC');
            message.respond({ returnValue: false, errorText: 'Missing MAC address' });
            return;
        }

        console.log('[Litefin Service] Luna processing WOL for MAC: ' + mac);

        sendWolPacket(mac)
            .then(function () {
                console.log('[Litefin Service] Luna WOL packet sent');
                message.respond({ returnValue: true });
            })
            .catch(function (err) {
                console.log('[Litefin Service] Luna WOL packet failed: ' + err.message);
                message.respond({ returnValue: false, errorText: err.message });
            });
    });
    
}

// ========================================================================
// YouTube Proxy & Trailer Fallback Server (Phase 1)
// ========================================================================

var http = require('http');
var urlMod = require('url');

var PORT = 8123;
var LISTEN_HOST = '0.0.0.0';

function writeResponse(res, code, contentType, body) {
    var headers = {
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Cache-Control': 'no-store'
    };
    res.writeHead(code, headers);
    res.end(body);
}

var PLAYER_HTML = `<!doctype html>
<html>
<head>
<style>html,body{margin:0;padding:0;background:#000;width:100%;height:100%;overflow:hidden;}</style>
</head>
<body>
<div id="player" style="width:100%;height:100%;"></div>
<script>
    var VID = new URLSearchParams(window.location.search).get('videoId');
    function post(type, data, t, d, s) {
        window.parent.postMessage({ __ytbridge: true, type: type, data: data, t: t||0, d: d||0, s: s||-1 }, '*');
    }
    var tag = document.createElement('script');
    tag.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(tag);

    var player;
    var autoplayAttempted = false;

    window.onYouTubeIframeAPIReady = function() {
        player = new YT.Player('player', {
            height: '100%', width: '100%', videoId: VID,
            playerVars: {
                'autoplay': 1,
                'controls': 0,
                'enablejsapi': 1,
                'origin': 'http://localhost:8123',
                'playsinline': 1,
                'mute': 0
            },
            events: {
                'onReady': function(ev) {
                    post('ready');

                    if (!autoplayAttempted) {
                        autoplayAttempted = true;
                        setTimeout(function() {
                            if (player && player.playVideo) {
                                player.playVideo();
                            }
                        }, 100);
                    }

                    setInterval(function(){
                        if(player && player.getCurrentTime) {
                            post('time', null, player.getCurrentTime()*1000, player.getDuration()*1000, player.getPlayerState());
                            try {
                                var d = player.getVideoData();
                                if (d && d.title) post('title', d.title);
                            } catch(e) {}
                        }
                    }, 500);
                },
                'onStateChange': function(ev) { post('state', ev.data); },
                'onError': function(ev) { post('error', ev.data); }
            }
        });
    };

    window.addEventListener('message', function(ev) {
        if (!ev.data || !ev.data.__ytbridge_cmd || !player) return;
        var m = ev.data;
        if (m.cmd === 'play') player.playVideo();
        else if (m.cmd === 'pause') player.pauseVideo();
        else if (m.cmd === 'stop') player.stopVideo();
        else if (m.cmd === 'seek') player.seekTo(m.val / 1000, true);
        else if (m.cmd === 'volume') player.setVolume(m.val);
        else if (m.cmd === 'mute') {
            if (m.val) player.mute();
            else player.unMute();
        }
    });
</script>
</body>
</html>`;

/**
 * Send a Wake-on-LAN (WOL) Magic Packet
 * ============================================================================
 * Creates a raw UDP broadcast socket, constructs a 102-byte Magic Packet
 * (6 bytes of 0xFF followed by 16 repetitions of the target MAC address),
 * and broadcasts it to 255.255.255.255 on UDP port 9.
 * 
 * Supports fallback allocation mechanisms to ensure compatibility with
 * older Tizen/Chromium Node.js versions (<= v5.x).
 * ============================================================================
 * @param {string} macAddress - Target machine's hardware MAC address
 * @returns {Promise<void>} Resolves when the packet has been sent
 */
function sendWolPacket(macAddress) {
    return new Promise(function (resolve, reject) {
        try {
            var dgram = require('dgram');

            // Strip everything except valid hexadecimal characters
            var cleanMac = macAddress.replace(/[^0-9a-fA-F]/g, '');
            if (cleanMac.length !== 12) {
                return reject(new Error('Invalid MAC address length (must be 12 hex characters)'));
            }

            // Allocate buffer: 6 bytes of 0xFF prefix + 16 * 6 bytes of MAC
            var buf = typeof Buffer.alloc === 'function' ? Buffer.alloc(102) : new Buffer(102);
            for (var i = 0; i < 6; i++) {
                buf[i] = 0xff;
            }

            // Populate the rest of the buffer with 16 copies of the target MAC address
            var macBuffer = typeof Buffer.from === 'function' ? Buffer.from(cleanMac, 'hex') : new Buffer(cleanMac, 'hex');
            for (var j = 0; j < 16; j++) {
                macBuffer.copy(buf, 6 + j * 6);
            }

            // Create temporary UDP socket
            var socket = dgram.createSocket('udp4');

            // Bind to dynamic port
            socket.bind(0, function () {
                try {
                    // Enable broadcast mode
                    socket.setBroadcast(true);
                    
                    // Broadcast magic packet to port 9
                    socket.send(buf, 0, buf.length, 9, '255.255.255.255', function (err) {
                        try { socket.close(); } catch (_) {}
                        if (err) {
                            reject(err);
                        } else {
                            resolve();
                        }
                    });
                } catch (sendErr) {
                    try { socket.close(); } catch (_) {}
                    reject(sendErr);
                }
            });

            socket.on('error', function (err) {
                try { socket.close(); } catch (_) {}
                reject(err);
            });
        } catch (e) {
            reject(e);
        }
    });
}

function handler(req, res) {
    var u = urlMod.parse(req.url, true);
    if (req.method === 'OPTIONS') return writeResponse(res, 204, 'text/plain', '');

    if (u.pathname === '/player.html') {
        return writeResponse(res, 200, 'text/html', PLAYER_HTML);
    }

    if (u.pathname === '/trailer') {
        var tmdbId = u.query.tmdbId;
        var title = u.query.title;
        var year = u.query.year;
        var lang = u.query.lang || 'en';
        var type = u.query.type || 'movie';

        fetchTmdbTrailer(tmdbId, type, lang).then(function(key) {
            if (key) return writeResponse(res, 200, 'application/json', JSON.stringify({ key: key, source: 'tmdb' }));
            
            return searchDdgLite(title, year, lang).then(function(ddgKey) {
                if (ddgKey) return writeResponse(res, 200, 'application/json', JSON.stringify({ key: ddgKey, source: 'ddg' }));
                
                // Fallbacks: TMDB en, then DDG en
                return fetchTmdbTrailer(tmdbId, type, 'en').then(function(enKey) {
                    if (enKey) return writeResponse(res, 200, 'application/json', JSON.stringify({ key: enKey, source: 'tmdb_en' }));
                    
                    return searchDdgLite(title, year, null).then(function(enDdgKey) {
                        if (enDdgKey) return writeResponse(res, 200, 'application/json', JSON.stringify({ key: enDdgKey, source: 'ddg_en' }));
                        return writeResponse(res, 404, 'application/json', JSON.stringify({ error: 'No trailer found' }));
                    });
                });
            });
        }).catch(function(err) {
            console.error('Trailer error', err);
            writeResponse(res, 500, 'application/json', JSON.stringify({ error: 'Internal Server Error' }));
        });
        return;
    }

    /*
     * =========================================================================
     * GET /discover
     * =========================================================================
     * Tizen equivalent of the WebOS Luna discover method.
     *
     * Creates a one-shot UDP socket, broadcasts the Jellyfin autodiscovery
     * probe to 255.255.255.255:7359, and returns results instantly via SSE
     * (Server-Sent Events) so the UI doesn't have to wait 3 seconds.
     *
     * Response: event-stream of { Id, Name, Address } JSON objects.
     * =========================================================================
     */
    if (u.pathname === '/discover') {
        console.log('[Litefin Discovery] /discover request received — starting UDP probe');

        var dgram = require('dgram');

        var DISC_PORT    = 7359;
        var DISC_MSG;
        try {
            DISC_MSG = Buffer.from('who is JellyfinServer?');
        } catch (_) {
            DISC_MSG = new Buffer('who is JellyfinServer?'); // Fallback for Tizen Node <= 5.x
        }
        var DISC_WAIT_MS = 3000; // Collect responses for 3 seconds

        var disc    = dgram.createSocket('udp4');
        var found   = {};   // keyed by Id for deduplication
        var settled = false;

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',
            // Optional: avoid Safari/proxy buffering
            'X-Accel-Buffering': 'no'
        });

        /* ── Helper: close socket, end stream ── */
        function finishDiscover() {
            if (settled) return;
            settled = true;

            try { disc.close(); } catch (_) {}

            var serversCount = Object.keys(found).length;
            console.log('[Litefin Discovery] /discover done — ' + serversCount + ' server(s) found');
            res.end();
        }

        /* ── Parse incoming UDP responses from Jellyfin servers ── */
        disc.on('message', function (message) {
            try {
                var msg = JSON.parse(message.toString('utf-8'));
                if (
                    typeof msg === 'object' &&
                    typeof msg.Id === 'string' &&
                    typeof msg.Name === 'string' &&
                    typeof msg.Address === 'string' &&
                    !found[msg.Id]
                ) {
                    console.log('[Litefin Discovery] Found: "' + msg.Name + '" at ' + msg.Address);
                    var payload = { Id: msg.Id, Name: msg.Name, Address: msg.Address };
                    found[msg.Id] = payload;
                    
                    // Immediately stream to client
                    res.write('data: ' + JSON.stringify(payload) + '\n\n');
                }
            } catch (_) {
                // Non-Jellyfin UDP traffic — ignore
            }
        });

        disc.on('error', function (err) {
            console.log('[Litefin Discovery] UDP socket error: ' + err.message);
            finishDiscover();
        });

        /* ── Once socket is bound, enable broadcast and send the probe ── */
        disc.bind(function () {
            try { disc.setBroadcast(true); } catch (_) {}

            disc.send(DISC_MSG, 0, DISC_MSG.length, DISC_PORT, '255.255.255.255', function (err) {
                if (err) {
                    console.log('[Litefin Discovery] Broadcast failed: ' + err.message);
                } else {
                    console.log('[Litefin Discovery] Broadcast probe sent');
                }
            });

            // Resolve after the collection window regardless of how many servers answered
            setTimeout(finishDiscover, DISC_WAIT_MS);
        });

        return;
    }

    /*
     * =========================================================================
     * POST/GET /wol
     * =========================================================================
     * Triggers sending a Wake-on-LAN magic packet to a specified target MAC
     * address parameter from the HTTP request query block.
     * =========================================================================
     */
    if (u.pathname === '/wol') {
        var mac = u.query.mac;
        if (!mac) {
            console.log('[Litefin Proxy] WOL request rejected: Missing MAC address');
            return writeResponse(res, 400, 'application/json', JSON.stringify({ error: 'Missing MAC address' }));
        }

        console.log('[Litefin Proxy] Processing WOL request for MAC: ' + mac);

        sendWolPacket(mac)
            .then(function () {
                console.log('[Litefin Proxy] WOL Magic Packet broadcasted successfully');
                writeResponse(res, 200, 'application/json', JSON.stringify({ success: true, message: 'WOL packet sent' }));
            })
            .catch(function (err) {
                console.log('[Litefin Proxy] WOL broadcast failed: ' + err.message);
                writeResponse(res, 500, 'application/json', JSON.stringify({ error: err.message }));
            });

        return;
    }

    return writeResponse(res, 404, 'text/plain', 'Not Found');
}

var https = require('https');
var TMDB_KEY = '4219e299c89411838049ab0dab19ebd5';
var __LANG_MAP__ = {
    ab:'Abkhaz Аԥсуа', af:'Afrikaans', ar:'Arabic العربية', as:'Assamese অসমীয়া', be:'Belarusian Беларуская', bg:'Bulgarian Български',
    bn:'Bengali বাংলা', ca:'Catalan Català', chr:'Cherokee ᏣᎳᎩ', cs:'Czech Český', cy:'Welsh Cymraeg', da:'Danish Dansk',
    de:'Deutsch German', el:'Greek Ελληνικά', en:'English', enm:'English', eo:'Esperanto', es:'Spanish Español', et:'Estonian Eesti',
    eu:'Basque Euskara', fa:'Persian Farsi فارسی', fi:'Finnish Suomi', fil:'Filipino Tagalog', fo:'Faroese Føroyskt',
    fr:'French Français', ga:'Irish Gaeilge', gl:'Galician Galego', gsw:'Swiss German Schweizerdeutsch', he:'Hebrew עברית',
    hi:'Hindi हिन्दी', hr:'Croatian Hrvatski', ht:'Haitian Creole Kreyòl', hu:'Hungarian Magyar', hy:'Armenian Հայերեն',
    id:'Indonesian Bahasa', is:'Icelandic Íslenska', it:'Italian Italiano', ja:'Japanese 日本語', jbo:'Lojban', ka:'Georgian ქართული',
    kab:'Kabyle Taqbaylit', kk:'Kazakh Қазақша', km:'Khmer ភាសាខ្មែរ', kn:'Kannada ಕನ್ನಡ', ko:'Korean 한국어', kw:'Cornish Kernewek',
    ky:'Kyrgyz Кыргызча', lb:'Luxembourgish Lëtzebuergesch', lt:'Lithuanian Lietuvių', lv:'Latvian Latviešu', lzh:'Chinese 中文',
    mi:'Maori Māori', mk:'Macedonian Македонски', ml:'Malayalam മലയാളം', mn:'Mongolian Монгол', mr:'Marathi मराठी', ms:'Malay Melayu',
    mt:'Maltese Malti', my:'Burmese Myanmar မြန်မာ', nb:'Norwegian Norsk', ne:'Nepali नेपाली', nl:'Dutch Nederlands', nn:'Norwegian Norsk',
    oc:'Occitan', or:'Odia ଓଡ଼ିଆ', pa:'Punjabi ਪੰਜਾਬੀ', pl:'Polish Polski', pr:'English', pt:'Portuguese Português', ro:'Romanian Română',
    ru:'Russian Русский', si:'Sinhala සිංහල', sk:'Slovak Slovenský', sl:'Slovenian Slovenščina', sn:'Shona', sq:'Albanian Shqip',
    sr:'Serbian Српски', sv:'Swedish Svenska', sw:'Swahili Kiswahili', ta:'Tamil தமிழ்', te:'Telugu తెలుగు', th:'Thai ไทย',
    tr:'Turkish Türkçe', ug:'Uyghur ئۇيغۇرچە', uk:'Ukrainian Українська', ur:'Urdu اردو', uz:'Uzbek Oʻzbekcha', vi:'Vietnamese Tiếng Việt',
    zh:'Chinese 中文', zu:'Zulu isiZulu'
};

function fetchJson(url) {
    return new Promise(function(resolve, reject) {
        https.get(url, function(res) {
            var data = '';
            res.on('data', function(chunk) { data += chunk; });
            res.on('end', function() {
                try { resolve(JSON.parse(data)); } catch(e) { resolve(null); }
            });
        }).on('error', function() { resolve(null); });
    });
}

function fetchText(url) {
    return new Promise(function(resolve, reject) {
        var opts = require('url').parse(url);
        opts.headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' };
        https.get(opts, function(res) {
            var data = '';
            res.on('data', function(chunk) { data += chunk; });
            res.on('end', function() { resolve(data); });
        }).on('error', function() { resolve(null); });
    });
}

function fetchTmdbTrailer(tmdbId, type, lang) {
    if (!tmdbId) return Promise.resolve(null);
    var url = 'https://api.themoviedb.org/3/' + type + '/' + tmdbId + '/videos?api_key=' + TMDB_KEY + (lang ? '&language=' + lang : '');
    return fetchJson(url).then(function(json) {
        if (!json || !json.results) return null;
        var r = json.results;
        for (var i = 0; i < r.length; i++) {
            if (r[i].site === 'YouTube' && r[i].type === 'Trailer') return r[i].key;
        }
        for (var i = 0; i < r.length; i++) {
            if (r[i].site === 'YouTube' && (r[i].type === 'Teaser' || r[i].type === 'Clip')) return r[i].key;
        }
        for (var i = 0; i < r.length; i++) {
            if (r[i].site === 'YouTube') return r[i].key;
        }
        return null;
    });
}

function searchDdgLite(title, year, langIso) {
    if (!title) return Promise.resolve(null);
    var langStr = langIso ? (__LANG_MAP__[langIso.split('-')[0].toLowerCase()] || '') : '';
    var q = encodeURIComponent(title + ' ' + (year || '') + ' ' + langStr + ' trailer site:youtube.com').replace(/%20/g, '+');
    var url = 'https://html.duckduckgo.com/html/?q=' + q;
    return fetchText(url).then(function(html) {
        if (!html) return null;
        var match = html.match(/v=([-_a-zA-Z0-9]{11})/);
        if (match) return match[1];
        match = html.match(/youtu\.be%2F([-_a-zA-Z0-9]{11})/);
        if (match) return match[1];
        return null;
    });
}

var proxyServer = http.createServer(handler);
proxyServer.on('error', function(err) {
    console.log('[Litefin Proxy] HTTP proxy server error: ' + err.message);
});
proxyServer.listen(PORT, LISTEN_HOST, function() { 
    console.log('[Litefin Proxy] Server listening on ' + LISTEN_HOST + ':' + PORT);
});

// ============================================================================
// Tizen Service Lifecycle Hooks — Smart Hub Preview
// ============================================================================
//
// These module.exports callbacks are called by the Tizen service framework
// when the ytresolver service receives an ApplicationControl request.
//
// The HTTP proxy started above continues running independently — we do NOT
// call tizen.application.getCurrentApplication().exit() here (unlike the
// jellyfin-tizen reference implementation) because the ytresolver service
// must remain alive to handle trailer and discovery HTTP requests.
//
// When SmartHubManager.js sends a 'SmartHubPreview' ApplicationControl:
//   1. Tizen calls module.exports.onRequest on this service.
//   2. handleTizenAppControl() reads the JSON from AppControl data.
//   3. webapis.preview.setPreviewData() registers the tiles with Samsung.
//   4. On completion, sendSmartHubAck() sends a status message back to the
//      main Litefin app's 'SmartHubAck' MessagePort so the Promise resolves.
// ============================================================================

if (!isWebOS) {

    /**
     * Read the package ID once and cache it — tizen.application is synchronous
     * but calling it repeatedly is wasteful in a hot callback path.
     * @type {string|null}
     */
    var _tizenPkgId = null;
    function getTizenPkgId() {
        if (!_tizenPkgId) {
            _tizenPkgId = tizen.application.getCurrentApplication().appInfo.packageId;
        }
        return _tizenPkgId;
    }

    /**
     * Send an ACK message back to the main Litefin app through the named
     * 'SmartHubAck' MessagePort registered by SmartHubManager._sendToService().
     *
     * The app's port listener resolves the pending Promise on receipt, which
     * releases the refresh cycle's updating guard.
     *
     * @param {string} status - Short status string to log on the app side.
     */
    function sendSmartHubAck(status) {
        try {
            var pkgId  = getTizenPkgId();
            /* Application ID format: packageId + '.Litefin' (matches config.xml) */
            var appId  = pkgId + '.Litefin';
            var port   = tizen.messageport.requestRemoteMessagePort(appId, 'SmartHubAck');
            port.sendMessage([{ key: 'status', value: status }]);
            console.log('[Litefin Service] SmartHub ACK sent: ' + status);
        } catch (e) {
            /* Non-fatal — the main app has a safety timeout that fires if the ACK
             * never arrives, so a failure here doesn't deadlock the refresh cycle. */
            console.log('[Litefin Service] Failed to send SmartHub ACK: ' + e.message);
        }
    }

    /**
     * Parse the incoming ApplicationControl data and dispatch to the correct
     * handler for each recognised key.
     *
     * Currently handles one key:
     *   'SmartHubPreview' — JSON string of the Samsung Preview schema sent
     *                       by SmartHubManager.js in the main app.
     */
    function handleTizenAppControl() {
        try {
            var app        = tizen.application.getCurrentApplication();
            var reqControl = app.getRequestedAppControl();

            if (!reqControl) {
                console.log('[Litefin Service] onRequest: no AppControl data');
                return;
            }

            var data = reqControl.appControl.data;

            for (var i = 0; i < data.length; i++) {
                var key   = data[i].key;
                var value = data[i].value;

                if (key === 'SmartHubPreview') {
                    /* Parse the Samsung Preview JSON forwarded by SmartHubManager. */
                    var previewJson;
                    try {
                        previewJson = JSON.parse(value[0]);
                    } catch (parseErr) {
                        console.log('[Litefin Service] Failed to parse SmartHubPreview JSON: ' + parseErr.message);
                        sendSmartHubAck('error:parse');
                        return;
                    }

                    console.log('[Litefin Service] Setting Smart Hub preview data...');

                    try {
                        webapis.preview.setPreviewData(
                            JSON.stringify(previewJson),
                            function () {
                                /* Success — Samsung accepted the preview tiles. */
                                console.log('[Litefin Service] Smart Hub preview set successfully');
                                sendSmartHubAck('success');
                            },
                            function (e) {
                                /* Samsung rejected the data (API error). */
                                console.log('[Litefin Service] setPreviewData error: ' + e.message);
                                sendSmartHubAck('error:' + e.message);
                            }
                        );
                    } catch (apiErr) {
                        console.log('[Litefin Service] setPreviewData threw: ' + apiErr.message);
                        sendSmartHubAck('exception:' + apiErr.message);
                    }

                    /* Stop scanning — only one preview key expected per request. */
                    return;
                }
            }

            /* No recognised key in this AppControl request — ignore silently. */
            console.log('[Litefin Service] onRequest: no handled key found');

        } catch (e) {
            console.log('[Litefin Service] handleTizenAppControl exception: ' + e.message);
        }
    }

    /* ── Tizen service lifecycle exports ─────────────────────────────────── */

    module.exports.onStart = function () {
        console.log('[Litefin Service] Tizen service started');
        /* The HTTP proxy is already listening (started above). Nothing extra needed. */
    };

    module.exports.onRequest = function () {
        /* Tizen calls this whenever an ApplicationControl is routed to this service. */
        console.log('[Litefin Service] Tizen onRequest received');
        handleTizenAppControl();
    };

    module.exports.onStop = function () {
        console.log('[Litefin Service] Tizen service stopping');
    };

    module.exports.onExit = function () {
        console.log('[Litefin Service] Tizen service exiting');
    };
}

