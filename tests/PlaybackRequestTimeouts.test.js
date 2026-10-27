import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

/**
 * ============================================================================
 * Playback Request Timeout Test Suite
 * ============================================================================
 * A server that accepts the connection and then stalls (busy NAS, tunnel
 * hiccup) must not keep the loading spinner up until the TV's TCP timeout:
 *   - MediaHelper.fetchWithTimeout() gives up with a TimeoutError
 *   - HLS manifest polling keeps its 15 s budget even when requests stall
 *   - PlaybackInfo fails with an error instead of waiting forever
 * ============================================================================
 */

globalThis.window = { innerWidth: 1920, innerHeight: 1080, screen: { width: 1920, height: 1080 } };
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {}, key: () => null, length: 0 };

const { MediaHelper } = await import('../src/player/core/MediaHelper.js');

const realFetch = globalThis.fetch;
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** A fetch() whose requests never answer, but reject when their signal aborts. */
function stalledFetch() {
    const requests = [];
    const fetch = (url, init = {}) => {
        const request = { url, init, aborted: false };
        requests.push(request);
        return new Promise((resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
                request.aborted = true;
                const error = new Error('The operation was aborted.');
                error.name = 'AbortError';
                reject(error);
            });
        });
    };
    return { fetch, requests };
}

/** Advance mocked time in steps, letting promise chains run in between. */
async function advance(t, ms, step = 250) {
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
        t.mock.timers.tick(step);
        await flush();
    }
}

test('MediaHelper.fetchWithTimeout: a stalled request fails with a TimeoutError and is aborted', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const stalled = stalledFetch();
    globalThis.fetch = stalled.fetch;
    try {
        const outcome = MediaHelper.fetchWithTimeout('http://srv/x', { method: 'GET' }, 5000).then(
            () => null,
            (err) => err
        );
        await advance(t, 5000);
        const error = await outcome;
        assert.strictEqual(error?.name, 'TimeoutError', 'an AbortError would be swallowed as a user cancel');
        assert.strictEqual(stalled.requests[0].aborted, true);
    } finally {
        globalThis.fetch = realFetch;
    }
});

test('MediaHelper.fetchWithTimeout: a timely answer is returned through read()', async () => {
    globalThis.fetch = async () => ({ ok: true, text: async () => '#EXTM3U' });
    try {
        const text = await MediaHelper.fetchWithTimeout('http://srv/x', {}, 5000, (response) => response.text());
        assert.strictEqual(text, '#EXTM3U');
    } finally {
        globalThis.fetch = realFetch;
    }
});

test('MediaHelper.pollHlsManifest: stalled requests do not stretch the 15 s budget', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const stalled = stalledFetch();
    globalThis.fetch = stalled.fetch;
    try {
        let finished = false;
        MediaHelper.pollHlsManifest('http://srv/videos/x/master.m3u8').then(() => (finished = true));
        await advance(t, 15500);
        assert.ok(finished, 'polling still waiting on a stalled request');
        assert.ok(stalled.requests.length >= 3, `${stalled.requests.length} requests`);
        assert.ok(stalled.requests.every((r) => r.aborted));
    } finally {
        globalThis.fetch = realFetch;
    }
});

// ----------------------------------------------------------------------------
// JellyfinPlayer._getPlaybackInfo (taken from the source; the module needs a full DOM)
// ----------------------------------------------------------------------------

const jellyfinSource = readFileSync(new URL('../src/player/core/JellyfinPlayer.js', import.meta.url), 'utf8').replace(
    /\r\n/g,
    '\n'
);

function extractMethod(signature) {
    const start = jellyfinSource.indexOf(`\n    ${signature}`);
    assert.ok(start !== -1, `method not found: ${signature}`);
    const end = jellyfinSource.indexOf('\n    }\n', start);
    return jellyfinSource.slice(start + 1, end + 6);
}

function createPlaybackInfoPlayer() {
    const timeoutConstant = jellyfinSource.match(/\nconst PLAYBACK_INFO_TIMEOUT_MS = [^;]+;/);
    const context = vm.createContext({
        JSON,
        Promise,
        log: { info() {}, debug() {}, warn() {}, error() {} },
        fetch: (...args) => globalThis.fetch(...args),
        MediaHelper,
        PlayerSettings: { get: () => undefined },
        isTrueHdSupported: () => false,
        isDtsSupported: () => false,
        doesAudioTrackRequireDirectStream: () => false,
        prewarmManager: { consumePlaybackInfo: () => null },
        buildJellyfinProfile: () => ({}),
        api: { isEmby: () => false, getAuthHeader: () => 'MediaBrowser Token="t"' }
    });
    const methods = vm.runInContext(
        `${timeoutConstant ? timeoutConstant[0] : ''}\n({\n${extractMethod('async _getPlaybackInfo(options, deviceProfile, manualBitrate = null) {')}\n})`,
        context
    );
    return Object.assign(Object.create(methods), {
        serverUrl: 'http://srv',
        authToken: 't',
        _playbackMode: 'auto',
        _backendType: 'webos'
    });
}

test('JellyfinPlayer: a stalled PlaybackInfo request fails instead of spinning forever', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const stalled = stalledFetch();
    globalThis.fetch = stalled.fetch;
    try {
        const player = createPlaybackInfoPlayer();
        const outcome = player
            ._getPlaybackInfo({ itemId: 'item', userId: 'user', item: { Type: 'Movie' } }, {})
            .then(
                () => null,
                (err) => err
            );
        await advance(t, 30000, 1000);
        const error = await Promise.race([outcome, flush().then(() => 'pending')]);
        assert.notStrictEqual(error, 'pending', 'PlaybackInfo still waiting after 30 s');
        assert.match(error.message, /did not answer/);
        assert.notStrictEqual(error.name, 'AbortError', 'would be swallowed as a user cancel');
    } finally {
        globalThis.fetch = realFetch;
    }
});

test('JellyfinPlayer: PlaybackInfo still returns the server response and reports HTTP errors', async () => {
    const player = createPlaybackInfoPlayer();

    globalThis.fetch = async () => ({ ok: true, json: async () => ({ PlaySessionId: 'abc' }) });
    try {
        const info = await player._getPlaybackInfo({ itemId: 'item', userId: 'user', item: { Type: 'Movie' } }, {});
        assert.strictEqual(info.PlaySessionId, 'abc');

        globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => 'boom' });
        await assert.rejects(
            player._getPlaybackInfo({ itemId: 'item', userId: 'user', item: { Type: 'Movie' } }, {}),
            /Failed to get playback info: 500 - boom/
        );
    } finally {
        globalThis.fetch = realFetch;
    }
});
