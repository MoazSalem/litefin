import assert from 'node:assert/strict';
import test from 'node:test';

// Setup mock window and localStorage for headless Node environment
const storageMap = new Map();
globalThis.localStorage = {
    getItem: (k) => storageMap.get(k) || null,
    setItem: (k, v) => storageMap.set(k, String(v)),
    removeItem: (k) => storageMap.delete(k),
    clear: () => storageMap.clear()
};
globalThis.window = globalThis;

// Dynamically import CustomHeaders after global mocks are installed
const { customHeaders, HEADER_PRESETS } = await import('../src/utils/CustomHeaders.js');

/**
 * ============================================================================
 * Custom HTTP Headers Test Suite
 * ============================================================================
 * Verifies that:
 *   1. Presets (Cloudflare Zero Trust, Pangolin) are correctly defined.
 *   2. RFC 7230 character validation and control-character filtering work.
 *   3. Reserved Jellyfin/Emby authentication headers are blocked.
 *   4. URL origin/subpath isolation prevents leaking proxy credentials to 3rd parties.
 * ============================================================================
 */

test('CustomHeaders: presets structure and integrity', () => {
    assert.strictEqual(Array.isArray(HEADER_PRESETS), true);
    assert.strictEqual(HEADER_PRESETS.length >= 2, true);

    const cf = HEADER_PRESETS.find((p) => p.id === 'cloudflare');
    assert.ok(cf);
    assert.strictEqual(cf.headers.some((h) => h.key === 'CF-Access-Client-Id'), true);
    assert.strictEqual(cf.headers.some((h) => h.key === 'CF-Access-Client-Secret'), true);

    const pangolin = HEADER_PRESETS.find((p) => p.id === 'pangolin');
    assert.ok(pangolin);
    assert.strictEqual(pangolin.headers.some((h) => h.key === 'P-Access-Token-Id'), true);
    assert.strictEqual(pangolin.headers.some((h) => h.key === 'P-Access-Token'), true);
});

test('CustomHeaders: normalizeHeaders enforces RFC 7230 and drops disabled/empty rows', () => {
    const raw = [
        { key: 'CF-Access-Client-Id', value: 'my-client-id-123', enabled: true },
        { key: 'CF-Access-Client-Secret', value: 'my-secret-456', enabled: true },
        { key: 'X-Disabled-Header', value: 'skip-me', enabled: false },
        { key: '', value: 'empty-key', enabled: true },
        { key: 'Invalid Header Name!', value: 'bad', enabled: true },
        { key: 'Invalid:Colon', value: 'bad', enabled: true },
        { key: 'Clean-Header', value: 'valid-val', enabled: true }
    ];

    const normalized = customHeaders.normalizeHeaders(raw);

    assert.strictEqual(normalized['CF-Access-Client-Id'], 'my-client-id-123');
    assert.strictEqual(normalized['CF-Access-Client-Secret'], 'my-secret-456');
    assert.strictEqual(normalized['Clean-Header'], 'valid-val');
    assert.strictEqual(normalized['X-Disabled-Header'], undefined);
    assert.strictEqual(normalized[''], undefined);
    assert.strictEqual(normalized['Invalid Header Name!'], undefined);
    assert.strictEqual(normalized['Invalid:Colon'], undefined);
});

test('CustomHeaders: normalizeHeaders drops reserved auth headers and blocks control characters', () => {
    const raw = [
        { key: 'Authorization', value: 'Bearer token', enabled: true },
        { key: 'authorization', value: 'Bearer token', enabled: true },
        { key: 'X-Emby-Token', value: 'emby-secret', enabled: true },
        { key: 'x-emby-authorization', value: 'emby-auth', enabled: true },
        { key: 'X-Injection-Attempt', value: "bad\r\nInjected-Header: evil", enabled: true },
        { key: 'Valid-Key', value: 'CleanValue', enabled: true }
    ];

    const normalized = customHeaders.normalizeHeaders(raw);

    assert.strictEqual(normalized['Authorization'], undefined);
    assert.strictEqual(normalized['authorization'], undefined);
    assert.strictEqual(normalized['X-Emby-Token'], undefined);
    assert.strictEqual(normalized['x-emby-authorization'], undefined);
    assert.strictEqual(normalized['X-Injection-Attempt'], undefined);
    assert.strictEqual(normalized['Valid-Key'], 'CleanValue');
});

test('CustomHeaders: deduplicates header names case-insensitively', () => {
    const raw = [
        { key: 'X-Custom-Proxy', value: 'FirstValue', enabled: true },
        { key: 'x-custom-proxy', value: 'SecondValue', enabled: true }
    ];

    const normalized = customHeaders.normalizeHeaders(raw);
    assert.strictEqual(normalized['X-Custom-Proxy'], 'FirstValue');
    assert.strictEqual(Object.keys(normalized).length, 1);
});

test('CustomHeaders: isUrlForServer prevents leaking proxy credentials to 3rd-party hosts', () => {
    const server = 'https://jellyfin.example.com/subpath';

    // Same server origin and path matching
    assert.strictEqual(customHeaders.isUrlForServer('https://jellyfin.example.com/subpath/Items', server), true);
    assert.strictEqual(customHeaders.isUrlForServer('https://jellyfin.example.com/subpath/System/Info/Public', server), true);

    // Outside subpath on same host
    assert.strictEqual(customHeaders.isUrlForServer('https://jellyfin.example.com/otherapp/api', server), false);

    // External third-party domains (TMDB, OpenSubtitles, YouTube) must be rejected
    assert.strictEqual(customHeaders.isUrlForServer('https://api.themoviedb.org/3/movie/550', server), false);
    assert.strictEqual(customHeaders.isUrlForServer('https://image.tmdb.org/t/p/original/poster.jpg', server), false);
    assert.strictEqual(customHeaders.isUrlForServer('https://fanart.tv/fanart/movie/poster.jpg', server), false);
    assert.strictEqual(customHeaders.isUrlForServer('http://localhost:8123/trailer?url=test', server), false);

    // Standard root server
    const rootServer = 'https://jellyfin.local:8096';
    assert.strictEqual(customHeaders.isUrlForServer('https://jellyfin.local:8096/Items/123/Images/Primary', rootServer), true);
    assert.strictEqual(customHeaders.isUrlForServer('https://evil-spoof.com/jellyfin.local:8096/Items', rootServer), false);
});

test('CustomHeaders: getHeadersForUrl returns headers only when URL belongs to server', () => {
    const serverUrl = 'https://media.proxy.net';
    const testHeaders = [
        { key: 'CF-Access-Client-Id', value: 'id-abc', enabled: true },
        { key: 'CF-Access-Client-Secret', value: 'secret-xyz', enabled: true }
    ];

    customHeaders.setServerHeaders(serverUrl, testHeaders);

    // Matching request URL
    const match = customHeaders.getHeadersForUrl('https://media.proxy.net/System/Info', serverUrl);
    assert.strictEqual(match['CF-Access-Client-Id'], 'id-abc');
    assert.strictEqual(match['CF-Access-Client-Secret'], 'secret-xyz');

    // Non-matching third-party URL
    const noMatch = customHeaders.getHeadersForUrl('https://image.tmdb.org/poster.jpg', serverUrl);
    assert.deepStrictEqual(noMatch, {});
});

test('CustomHeaders: getServerHeaders supports protocol-agnostic lookup fallback', () => {
    const bareHost = 'jellyfin.myproxy.org';
    const testHeaders = [
        { key: 'CF-Access-Client-Id', value: 'token-999', enabled: true }
    ];

    customHeaders.setServerHeaders(bareHost, testHeaders);

    // Should resolve when queried with full https:// URL
    const retrievedWithHttps = customHeaders.getServerHeaders(`https://${bareHost}`);
    assert.strictEqual(retrievedWithHttps.length, 1);
    assert.strictEqual(retrievedWithHttps[0].key, 'CF-Access-Client-Id');
    assert.strictEqual(retrievedWithHttps[0].value, 'token-999');

    // And vice-versa: headers saved with full https:// URL can be queried with bare host
    const fullUrl = 'https://emby.myproxy.org';
    customHeaders.setServerHeaders(fullUrl, testHeaders);
    const retrievedWithBare = customHeaders.getServerHeaders('emby.myproxy.org');
    assert.strictEqual(retrievedWithBare.length, 1);
    assert.strictEqual(retrievedWithBare[0].key, 'CF-Access-Client-Id');
});

test('CustomHeaders: media streaming and playback URLs receive custom headers', () => {
    // -------------------------------------------------------------------------
    // Setup reverse proxy endpoint with Zero Trust service token credentials
    // -------------------------------------------------------------------------
    const serverUrl = 'https://ma.eatingheads.com';
    const credentials = [
        { key: 'CF-Access-Client-Id', value: 'client-id-xyz.access', enabled: true },
        { key: 'CF-Access-Client-Secret', value: 'secret-hash-789', enabled: true }
    ];

    // Persist headers for this server domain
    customHeaders.setServerHeaders(serverUrl, credentials);

    // -------------------------------------------------------------------------
    // 1. DirectPlay video stream URL (e.g. MKV/MP4 stream request for ExoPlayer)
    // -------------------------------------------------------------------------
    const directPlayStreamUrl = 'https://ma.eatingheads.com/Videos/ea295f86b273eb12b7588fc88f1a8a9d/stream.mkv?Static=true&mediaSourceId=ea295f86b273eb12b7588fc88f1a8a9d&PlaySessionId=123';
    const streamHeaders = customHeaders.getHeadersForUrl(directPlayStreamUrl, serverUrl);

    assert.strictEqual(streamHeaders['CF-Access-Client-Id'], 'client-id-xyz.access');
    assert.strictEqual(streamHeaders['CF-Access-Client-Secret'], 'secret-hash-789');

    // -------------------------------------------------------------------------
    // 2. Transcoding HLS master playlist URL (for Hls.js / HtmlVideoPlayer)
    // -------------------------------------------------------------------------
    const transcodePlaylistUrl = 'https://ma.eatingheads.com/videos/ea295f86-b273-eb12-b758-8fc88f1a8a9d/master.m3u8?DeviceId=dev1&MediaSourceId=ea29';
    const transcodeHeaders = customHeaders.getHeadersForUrl(transcodePlaylistUrl, serverUrl);

    assert.strictEqual(transcodeHeaders['CF-Access-Client-Id'], 'client-id-xyz.access');
    assert.strictEqual(transcodeHeaders['CF-Access-Client-Secret'], 'secret-hash-789');

    // -------------------------------------------------------------------------
    // 3. Subtitle cue stream URL (for SubtitleManager external text subtitles)
    // -------------------------------------------------------------------------
    const subtitleStreamUrl = 'https://ma.eatingheads.com/Videos/ea295f86b273eb12b7588fc88f1a8a9d/Subtitles/2/0/Stream.vtt?ApiKey=abc';
    const subtitleHeaders = customHeaders.getHeadersForUrl(subtitleStreamUrl, serverUrl);

    assert.strictEqual(subtitleHeaders['CF-Access-Client-Id'], 'client-id-xyz.access');
    assert.strictEqual(subtitleHeaders['CF-Access-Client-Secret'], 'secret-hash-789');
});

test('CustomHeaders: authenticated image resolution, caching, and cleanup', async () => {
    // -------------------------------------------------------------------------
    // Setup test server with Cloudflare Access headers
    // -------------------------------------------------------------------------
    const serverUrl = 'https://ma.eatingheads.com';
    const credentials = [
        { key: 'CF-Access-Client-Id', value: 'client-id-123', enabled: true },
        { key: 'CF-Access-Client-Secret', value: 'secret-key-456', enabled: true }
    ];

    // Configure headers for this server
    customHeaders.setServerHeaders(serverUrl, credentials);
    customHeaders.setActiveServer(serverUrl);

    // Verify hasCustomHeaders returns true for protected server
    assert.strictEqual(customHeaders.hasCustomHeaders(serverUrl), true);
    assert.strictEqual(customHeaders.hasCustomHeaders('https://other-unprotected.local'), false);

    // -------------------------------------------------------------------------
    // 1. Unprotected / third-party URLs must return unchanged without fetch
    // -------------------------------------------------------------------------
    const thirdPartyUrl = 'https://image.tmdb.org/t/p/w500/poster.jpg';
    const resolvedThirdParty = await customHeaders.resolveImageUrl(thirdPartyUrl);
    assert.strictEqual(resolvedThirdParty, thirdPartyUrl);

    // Data URLs must also pass through untouched
    const dataUrl = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    const resolvedDataUrl = await customHeaders.resolveImageUrl(dataUrl);
    assert.strictEqual(resolvedDataUrl, dataUrl);

    // -------------------------------------------------------------------------
    // 2. Protected server artwork URL should fetch with headers and return Blob URL
    // -------------------------------------------------------------------------
    const imageUrl = 'https://ma.eatingheads.com/Items/ea295f86/Images/Primary?maxWidth=400';

    // Mock global fetch and URL.createObjectURL if needed in test environment
    const originalFetch = global.fetch;
    const originalCreateObjectURL = URL.createObjectURL;
    let fetchCalledWithHeaders = false;

    try {
        global.fetch = async (reqUrl, init) => {
            if (reqUrl === imageUrl) {
                // Verify custom headers were attached to fetch request
                if (init?.headers?.['CF-Access-Client-Id'] === 'client-id-123' &&
                    init?.headers?.['CF-Access-Client-Secret'] === 'secret-key-456') {
                    fetchCalledWithHeaders = true;
                }
                return {
                    ok: true,
                    status: 200,
                    blob: async () => new Blob(['fake-image-bytes'], { type: 'image/jpeg' })
                };
            }
            return { ok: false, status: 404 };
        };

        if (typeof URL.createObjectURL !== 'function') {
            URL.createObjectURL = (blob) => `blob:https://ma.eatingheads.com/mock-blob-${Date.now()}`;
        }

        // Execute image resolution
        const blobUrl = await customHeaders.resolveImageUrl(imageUrl, serverUrl);

        // Verify request received headers and returned blob URL
        assert.strictEqual(fetchCalledWithHeaders, true);
        assert.strictEqual(blobUrl.startsWith('blob:'), true);

        // Verify synchronous cache returns the same blob URL
        const cachedUrl = customHeaders.getCachedBlobUrl(imageUrl);
        assert.strictEqual(cachedUrl, blobUrl);

        // ---------------------------------------------------------------------
        // 3. Cache Purge & Cleanup
        // ---------------------------------------------------------------------
        customHeaders.clearBlobCache();
        assert.strictEqual(customHeaders.getCachedBlobUrl(imageUrl), null);
    } finally {
        // Restore globals
        global.fetch = originalFetch;
        URL.createObjectURL = originalCreateObjectURL;
        customHeaders.clearCache();
    }
});

test('CustomHeaders: server ping URLs (/System/Ping) receive custom proxy headers', () => {
    const serverUrl = 'https://ma.eatingheads.com';
    const testHeaders = [
        { key: 'CF-Access-Client-Id', value: 'client-id-watchdog', enabled: true },
        { key: 'CF-Access-Client-Secret', value: 'secret-key-watchdog', enabled: true }
    ];

    customHeaders.setServerHeaders(serverUrl, testHeaders);

    // System ping endpoint used by playback watchdog and auto-recovery
    const pingUrl = serverUrl + '/System/Ping';
    const headers = customHeaders.getHeadersForUrl(pingUrl, serverUrl);

    assert.strictEqual(headers['CF-Access-Client-Id'], 'client-id-watchdog');
    assert.strictEqual(headers['CF-Access-Client-Secret'], 'secret-key-watchdog');
});