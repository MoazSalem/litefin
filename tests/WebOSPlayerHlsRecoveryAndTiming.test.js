import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * ============================================================================
 * webOS Player Hls.js Recovery, Manifest Polling and Timeupdate Test Suite
 * ============================================================================
 *   - Hls.js fatal errors: bounded retries, then a reported failure (A5)
 *   - a media element error during Hls.js playback gets the same recovery (A5)
 *   - native HLS polls the manifest once and stops polling on stop() (A6)
 *   - timeupdate is throttled by elapsed time, not by media time (A7)
 * ============================================================================
 */

function createEventTarget(base) {
    const listeners = {};
    return Object.assign(base, {
        addEventListener: (type, fn) => (listeners[type] = listeners[type] || []).push(fn),
        removeEventListener: (type, fn) => (listeners[type] = (listeners[type] || []).filter((f) => f !== fn)),
        fire: (type) => (listeners[type] || []).slice().forEach((fn) => fn({ target: base }))
    });
}

function createVideo() {
    return createEventTarget({
        children: [],
        style: {},
        audioTracks: [],
        textTracks: [],
        readyState: 4,
        currentTime: 0,
        duration: 3600,
        paused: false,
        seekable: { length: 1 },
        buffered: { length: 0 },
        error: null,
        src: '',
        get firstChild() {
            return this.children[0] || null;
        },
        setAttribute() {},
        removeAttribute() {},
        appendChild(child) {
            this.children.push(child);
        },
        removeChild(child) {
            this.children = this.children.filter((c) => c !== child);
        },
        load() {},
        pause() {},
        play: () => Promise.resolve(),
        canPlayType: () => ''
    });
}

globalThis.window = { innerWidth: 1920, innerHeight: 1080, screen: { width: 1920, height: 1080 } };
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {}, key: () => null, length: 0 };
globalThis.document = createEventTarget({
    documentElement: { clientWidth: 1920, clientHeight: 1080 },
    body: { appendChild: () => {} },
    createElement: (tag) =>
        tag === 'video'
            ? createVideo()
            : createEventTarget({ classList: { add() {}, remove() {} }, style: {}, querySelectorAll: () => [], appendChild() {} })
});

let manifestReady = true;
let manifestFetches = 0;
globalThis.fetch = async () => {
    manifestFetches++;
    return { ok: true, text: async () => (manifestReady ? '#EXTM3U\n' : '') };
};

const { WebOSPlayer } = await import('../src/player/core/WebOSPlayer.js');
const { default: Hls } = await import('hls.js');

function createPlayer() {
    const events = [];
    const player = new WebOSPlayer({
        container: { clientWidth: 1920, clientHeight: 1080, style: {}, appendChild() {} },
        onEvent: (e) => events.push(e)
    });
    return { player, events };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function createFakeHls() {
    const calls = [];
    return {
        calls,
        startLoad: () => calls.push('startLoad'),
        recoverMediaError: () => calls.push('recoverMediaError'),
        swapAudioCodec: () => calls.push('swapAudioCodec')
    };
}

const fatal = (type, details, extra = {}) => ({ fatal: true, type, details, ...extra });

// ----------------------------------------------------------------------------
// A5 — Hls.js recovery
// ----------------------------------------------------------------------------

test('WebOSPlayer: fatal Hls.js network errors are retried with backoff, then reported', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { player } = createPlayer();
    const hls = createFakeHls();
    player._hlsPlayer = hls;
    const failures = [];
    const { onError } = player._createHlsErrorHandler(hls, (err) => failures.push(err));
    const networkError = fatal(Hls.ErrorTypes.NETWORK_ERROR, 'fragLoadError');

    for (const delay of [1000, 2000, 4000]) {
        onError('hlsError', networkError);
        const before = hls.calls.length;
        t.mock.timers.tick(delay - 1);
        assert.strictEqual(hls.calls.length, before, `startLoad() before ${delay} ms`);
        t.mock.timers.tick(1);
        assert.strictEqual(hls.calls.length, before + 1, `no startLoad() after ${delay} ms`);
    }
    assert.deepStrictEqual(hls.calls, ['startLoad', 'startLoad', 'startLoad']);

    onError('hlsError', networkError);
    assert.strictEqual(failures.length, 1);
    assert.strictEqual(failures[0].isNetworkError, true);
});

test('WebOSPlayer: an HTTP error response is not retried, and a loaded fragment resets the retry budget', () => {
    const { player } = createPlayer();
    const hls = createFakeHls();
    const failures = [];
    const handler = player._createHlsErrorHandler(hls, (err) => failures.push(err));

    handler.onError('hlsError', fatal(Hls.ErrorTypes.NETWORK_ERROR, 'manifestLoadError', { response: { code: 404 } }));
    assert.strictEqual(failures.length, 1);
    assert.match(failures[0].message, /HTTP 404/);

    const other = player._createHlsErrorHandler(hls, (err) => failures.push(err));
    for (let i = 0; i < 3; i++) other.onError('hlsError', fatal(Hls.ErrorTypes.NETWORK_ERROR, 'fragLoadError'));
    other.onFragLoaded();
    other.onError('hlsError', fatal(Hls.ErrorTypes.NETWORK_ERROR, 'fragLoadError'));
    assert.strictEqual(failures.length, 1, 'retry budget was not reset by a loaded fragment');
});

test('WebOSPlayer: fatal Hls.js media errors get a decoder reset, then a codec swap, then are reported', (t) => {
    t.mock.timers.enable({ apis: ['Date'] });
    const { player } = createPlayer();
    const hls = createFakeHls();
    const failures = [];
    const { onError } = player._createHlsErrorHandler(hls, (err) => failures.push(err));
    const mediaError = fatal(Hls.ErrorTypes.MEDIA_ERROR, 'bufferAppendError');

    t.mock.timers.tick(10000);
    onError('hlsError', mediaError);
    onError('hlsError', mediaError);
    assert.deepStrictEqual(hls.calls, ['recoverMediaError', 'swapAudioCodec', 'recoverMediaError']);
    onError('hlsError', mediaError);
    assert.strictEqual(failures.length, 1);

    // Spaced-out errors keep recovering
    t.mock.timers.tick(5000);
    onError('hlsError', mediaError);
    assert.strictEqual(hls.calls.at(-1), 'recoverMediaError');
    assert.strictEqual(failures.length, 1);
});

test('WebOSPlayer: non-fatal Hls.js errors trigger no recovery', () => {
    const { player } = createPlayer();
    const hls = createFakeHls();
    const failures = [];
    const { onError } = player._createHlsErrorHandler(hls, (err) => failures.push(err));
    onError('hlsError', { fatal: false, type: Hls.ErrorTypes.NETWORK_ERROR, details: 'fragLoadError' });
    onError('hlsError', { fatal: false, type: Hls.ErrorTypes.MEDIA_ERROR, details: 'bufferStalledError' });
    assert.deepStrictEqual(hls.calls, []);
    assert.deepStrictEqual(failures, []);
});

test('WebOSPlayer: a media element error during Hls.js playback gets the same bounded recovery', (t) => {
    // Hls.js only logs <video> errors, so the player must recover them itself
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    t.mock.timers.tick(10000);
    const { player, events } = createPlayer();
    const video = player._ensureVideoElement();
    const hls = createFakeHls();
    const failures = [];
    player._hlsPlayer = hls;
    const handling = player._createHlsErrorHandler(hls, (err) => failures.push(err));
    player._hlsElementErrorHandler = { hls, onError: handling.onError };
    video.src = 'blob:hls';
    video.error = { code: 3, message: 'PIPELINE_ERROR_DECODE' };

    video.fire('error');
    assert.deepStrictEqual(hls.calls, ['recoverMediaError'], 'decode error not recovered in place');
    video.fire('error');
    assert.deepStrictEqual(hls.calls, ['recoverMediaError', 'swapAudioCodec', 'recoverMediaError']);
    video.fire('error');
    assert.strictEqual(failures.length, 1, 'a decoder that keeps failing must be reported');
    assert.strictEqual(events.filter((e) => e.type === 'error').length, 0, 'reported twice');
});

// ----------------------------------------------------------------------------
// A6 — manifest polling
// ----------------------------------------------------------------------------

// Native-only HLS (HEVC HDR + E-AC-3): Hls.js cannot take over
const nativeOnlyHls = {
    MediaStreams: [
        { Index: 0, Type: 'Video', Codec: 'hevc', VideoRangeType: 'HDR10' },
        { Index: 1, Type: 'Audio', Codec: 'eac3', IsDefault: true }
    ]
};
const hlsOptions = { url: 'http://srv/videos/x/master.m3u8', isHls: true, mediaSource: nativeOnlyHls };

test('WebOSPlayer: native HLS start fetches the manifest once', async () => {
    manifestReady = true;
    manifestFetches = 0;
    const { player } = createPlayer();
    const playing = player.play(hlsOptions);
    playing.catch(() => {});
    await flush();
    await flush();
    assert.strictEqual(manifestFetches, 1);
    await player.stop();
});

test('WebOSPlayer: manifest polling stops when playback is stopped', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    manifestReady = false; // transcode not ready yet
    manifestFetches = 0;
    const { player } = createPlayer();
    const playing = player.play(hlsOptions);
    const outcome = playing.then(() => null, (err) => err);
    await flush();
    t.mock.timers.tick(500);
    await flush();
    assert.strictEqual(manifestFetches, 2);

    await player.stop();
    for (let i = 0; i < 10; i++) {
        t.mock.timers.tick(500);
        await flush();
    }
    assert.ok(manifestFetches <= 3, `kept polling after stop(): ${manifestFetches} fetches`);
    assert.strictEqual((await outcome)?.name, 'AbortError');
    manifestReady = true;
});

// ----------------------------------------------------------------------------
// A7 — timeupdate throttle
// ----------------------------------------------------------------------------

/** A controllable performance.now() for the throttle. */
function mockClock(t) {
    const clock = { now: 100000 };
    t.mock.method(performance, 'now', () => clock.now);
    return { tick: (ms) => (clock.now += ms) };
}

test('WebOSPlayer: every ~250 ms timeupdate is forwarded', (t) => {
    const clock = mockClock(t);
    const { player, events } = createPlayer();
    const video = player._ensureVideoElement();

    for (let i = 0; i < 8; i++) {
        video.currentTime = 10 + i * 0.25;
        video.fire('timeupdate');
        clock.tick(250);
    }
    assert.strictEqual(events.filter((e) => e.type === 'timeupdate').length, 8);
});

test('WebOSPlayer: every ~156 ms timeupdate (webOS WebAppMgr cadence) is forwarded', (t) => {
    // webOS 25 fires timeupdate every ~156 ms; a 200 ms throttle forwarded only every other one
    const clock = mockClock(t);
    const { player, events } = createPlayer();
    const video = player._ensureVideoElement();

    for (let i = 0; i < 10; i++) {
        video.currentTime = 10 + i * 0.156;
        video.fire('timeupdate');
        clock.tick(156);
    }
    assert.strictEqual(events.filter((e) => e.type === 'timeupdate').length, 10);
});

test('WebOSPlayer: bursts of timeupdate are still throttled, but a jump is forwarded at once', (t) => {
    const clock = mockClock(t);
    const { player, events } = createPlayer();
    const video = player._ensureVideoElement();
    const forwarded = () => events.filter((e) => e.type === 'timeupdate').length;

    video.currentTime = 10;
    video.fire('timeupdate');
    for (let i = 1; i <= 4; i++) {
        clock.tick(20);
        video.currentTime = 10 + i * 0.02;
        video.fire('timeupdate');
    }
    assert.strictEqual(forwarded(), 1);

    clock.tick(10);
    video.currentTime = 600; // seek landed
    video.fire('timeupdate');
    assert.strictEqual(forwarded(), 2);
});

test('WebOSPlayer: the timeupdate throttle ignores the TV clock stepping back', (t) => {
    const clock = mockClock(t);
    t.mock.timers.enable({ apis: ['Date'], now: 1000000 });
    const { player, events } = createPlayer();
    const video = player._ensureVideoElement();

    video.currentTime = 10;
    video.fire('timeupdate');
    t.mock.timers.setTime(1000000 - 60000); // time sync moves the clock back a minute
    for (let i = 1; i <= 4; i++) {
        clock.tick(250);
        video.currentTime = 10 + i * 0.25;
        video.fire('timeupdate');
    }
    assert.strictEqual(events.filter((e) => e.type === 'timeupdate').length, 5);
});
