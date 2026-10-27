import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * ============================================================================
 * webOS Player: an Hls.js start that never settles
 * ============================================================================
 *   - a fatal manifest error is retried with loadSource(): in hls.js 1.7
 *     startLoad() does not request a manifest that never loaded
 *   - the Hls.js start has a load watchdog, so play() settles when the
 *     server stops answering (webOS 3/4 use Hls.js by default): 60 s for
 *     the playlists, then a slow first segment is up to hls.js's own policy
 *   - a native HLS load that got no data at all falls back to Hls.js only
 *     while the server still answers, also when the TV gives up on it by
 *     itself before the watchdog
 *   - once a fallen-back Hls.js start has failed, the element's teardown
 *     error does not replace that failure
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
        paused: true,
        seeking: false,
        seekable: { length: 1 },
        buffered: { length: 0 },
        error: null,
        src: '',
        get firstChild() {
            return this.children[0] || null;
        },
        setAttribute() {},
        removeAttribute(name) {
            if (name === 'src') this.src = '';
        },
        appendChild(child) {
            child.parentNode = this;
            this.children.push(child);
        },
        removeChild(child) {
            child.parentNode = null;
            this.children = this.children.filter((c) => c !== child);
        },
        load() {},
        pause() {
            this.paused = true;
        },
        play() {
            this.paused = false;
            return Promise.resolve();
        },
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
            : tag === 'source'
              ? createEventTarget({ tagName: 'SOURCE', src: '', type: '' })
              : createEventTarget({ classList: { add() {}, remove() {} }, style: {}, appendChild() {} })
});
/** Whether the server answers playlist requests (a stalled one accepts and never answers) */
let serverAnswers = true;
globalThis.fetch = () =>
    serverAnswers ? Promise.resolve({ ok: true, text: async () => '#EXTM3U\n' }) : new Promise(() => {});

const { WebOSPlayer, PlaybackLoadTimeoutError } = await import('../src/player/core/WebOSPlayer.js');
const { default: Hls } = await import('hls.js');

const flush = () => new Promise((resolve) => globalThis.setImmediate(resolve));

// SDR H.264 / AAC: a stream Hls.js can take
const mediaSource = {
    MediaStreams: [
        { Index: 0, Type: 'Video', Codec: 'h264' },
        { Index: 1, Type: 'Audio', Codec: 'aac', IsDefault: true }
    ]
};
const hlsOptions = { url: 'http://srv/videos/x/master.m3u8', isHls: true, mediaSource };

function createPlayer() {
    const events = [];
    const player = new WebOSPlayer({
        container: { clientWidth: 1920, clientHeight: 1080, style: {}, appendChild() {} },
        onEvent: (e) => events.push(e)
    });
    return { player, events };
}

/**
 * The real Hls.js class with its loading stubbed out. Listeners the player
 * registers (hls.js registers its own controllers with a context) are kept
 * apart, so a test can fire Hls.js events at the player alone.
 */
function stubHls(t) {
    const proto = Hls.prototype;
    const original = { on: proto.on, once: proto.once, off: proto.off };
    const playerListeners = {};
    const calls = [];
    const stubs = {
        on(event, listener, context) {
            if (context !== undefined) return original.on.call(this, event, listener, context);
            (playerListeners[event] = playerListeners[event] || []).push(listener);
        },
        once(event, listener, context) {
            if (context !== undefined) return original.once.call(this, event, listener, context);
            (playerListeners[event] = playerListeners[event] || []).push(listener);
        },
        off(event, listener, context) {
            if (context !== undefined) return original.off.call(this, event, listener, context);
            playerListeners[event] = (playerListeners[event] || []).filter((l) => l !== listener);
        },
        loadSource(url) {
            calls.push(`loadSource ${url}`);
        },
        attachMedia() {},
        startLoad() {
            calls.push('startLoad');
        },
        destroy() {
            calls.push('destroy');
        }
    };
    for (const [name, stub] of Object.entries(stubs)) t.mock.method(proto, name, stub);
    const fire = (event, data = {}) => (playerListeners[event] || []).slice().forEach((l) => l(event, data));
    return { calls, fire };
}

/** Advance the mocked clock in 1 s steps, letting promise callbacks run in between */
async function advance(t, ms) {
    for (let i = 0; i < ms / 1000; i++) {
        t.mock.timers.tick(1000);
        await flush();
    }
}

const manifestTimeout = {
    type: Hls.ErrorTypes.NETWORK_ERROR,
    details: Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT,
    fatal: true
};

test('WebOSPlayer: a fatal manifest error during an Hls.js start requests the manifest again', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const hls = stubHls(t);
    const { player } = createPlayer();
    const video = player._ensureVideoElement();
    player._playWithHlsJs(video, hlsOptions).catch(() => {});
    assert.deepStrictEqual(hls.calls, ['loadSource http://srv/videos/x/master.m3u8']);

    // hls.js has given up on the manifest after its own retries
    hls.fire(Hls.Events.ERROR, manifestTimeout);
    await advance(t, 1000);
    assert.deepStrictEqual(hls.calls, [
        'loadSource http://srv/videos/x/master.m3u8',
        'loadSource http://srv/videos/x/master.m3u8'
    ]);

    // A fragment error still resumes loading with startLoad()
    hls.fire(Hls.Events.ERROR, { type: Hls.ErrorTypes.NETWORK_ERROR, details: 'fragLoadError', fatal: true });
    await advance(t, 2000);
    assert.strictEqual(hls.calls.at(-1), 'startLoad');
    await player.stop();
});

test('WebOSPlayer: an Hls.js start that gets no data fails as a network error instead of spinning forever', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const hls = stubHls(t);
    const { player } = createPlayer();
    const video = player._ensureVideoElement();
    video.readyState = 0;
    video.play = () => new Promise(() => {}); // no media: Chromium keeps play() pending

    let outcome = null;
    player._playWithHlsJs(video, hlsOptions).then(
        () => (outcome = 'resolved'),
        (err) => (outcome = err)
    );
    hls.fire(Hls.Events.ERROR, manifestTimeout);

    await advance(t, 59000);
    assert.strictEqual(outcome, null);
    await advance(t, 1000);
    assert.ok(outcome instanceof PlaybackLoadTimeoutError, `play() did not settle: ${outcome}`);
    assert.strictEqual(outcome.isNetworkError, true, 'nothing arrived: a transcode would not help');
    assert.ok(hls.calls.includes('destroy'), 'the Hls.js instance keeps loading');
    assert.strictEqual(player._hlsPlayer, null);
});

test('WebOSPlayer: a slow first segment is left to hls.js; once fragments stop coming the start fails', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const hls = stubHls(t);
    const { player } = createPlayer();
    const video = player._ensureVideoElement();
    video.readyState = 0;
    video.play = () => new Promise(() => {});

    let outcome = null;
    player._playWithHlsJs(video, hlsOptions).then(
        () => (outcome = 'resolved'),
        (err) => (outcome = err)
    );
    // The playlists arrive at once; a cold transcode takes over a minute to its first segment
    hls.fire(Hls.Events.MANIFEST_LOADED);
    hls.fire(Hls.Events.LEVEL_LOADED);
    await advance(t, 70000);
    assert.strictEqual(outcome, null, 'failed a transcode that was still preparing');

    hls.fire(Hls.Events.FRAG_LOADING); // hls.js tries again
    await advance(t, 50000);
    hls.fire(Hls.Events.FRAG_LOADED);
    await advance(t, 59000);
    assert.strictEqual(outcome, null, 'timed out while data was arriving');

    await advance(t, 1000);
    assert.ok(outcome instanceof PlaybackLoadTimeoutError);
    assert.strictEqual(outcome.isNetworkError, false, 'data arrived: worth a transcode');
});

test('WebOSPlayer: an Hls.js start that never gets its media playlist times out', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const hls = stubHls(t);
    const { player } = createPlayer();
    const video = player._ensureVideoElement();
    video.readyState = 0;
    video.play = () => new Promise(() => {});

    let outcome = null;
    player._playWithHlsJs(video, hlsOptions).catch((err) => (outcome = err));
    hls.fire(Hls.Events.MANIFEST_LOADED); // the multivariant playlist only
    await advance(t, 60000);
    assert.ok(outcome instanceof PlaybackLoadTimeoutError);
    assert.strictEqual(outcome.isNetworkError, false);
});

test('WebOSPlayer: webOS 3 (play() without a promise): an Hls.js start resolves at playing and still times out', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const hls = stubHls(t);
    const { player } = createPlayer();
    const video = player._ensureVideoElement();
    video.readyState = 0;
    video.play = function () {
        this.paused = false;
        return undefined; // Chromium 38
    };

    // A server that never sends a segment: the 3 s fallback's play() must not end the watchdog
    let outcome = null;
    player._playWithHlsJs(video, hlsOptions).then(
        () => (outcome = 'resolved'),
        (err) => (outcome = err)
    );
    hls.fire(Hls.Events.MANIFEST_LOADED);
    hls.fire(Hls.Events.MANIFEST_PARSED);
    await advance(t, 60000);
    assert.ok(outcome instanceof PlaybackLoadTimeoutError, `start not reported: ${outcome}`);

    // A working one resolves once the element plays
    outcome = null;
    player._playWithHlsJs(video, hlsOptions).then(
        () => (outcome = 'resolved'),
        (err) => (outcome = err)
    );
    hls.fire(Hls.Events.BUFFER_APPENDED);
    await flush();
    assert.strictEqual(outcome, null, 'resolved before playback started');
    video.fire('playing');
    await flush();
    assert.strictEqual(outcome, 'resolved');
});

test('WebOSPlayer: the Hls.js start watchdog ends with the start', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const hls = stubHls(t);
    const { player, events } = createPlayer();
    const video = player._ensureVideoElement();

    const playing = player._playWithHlsJs(video, hlsOptions);
    hls.fire(Hls.Events.BUFFER_APPENDED);
    await playing;
    await advance(t, 120000);
    assert.ok(!hls.calls.includes('destroy'), 'a started Hls.js playback was torn down');
    assert.deepStrictEqual(
        events.filter((e) => e.type === 'error'),
        []
    );
});

/** A native HLS start whose load gets no data; the Hls.js fallback is counted */
async function nativeLoadWithoutData(t) {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { player } = createPlayer();
    player._shouldUseNativeHls = () => true;
    player._canUseHlsJs = () => true; // as on a TV with MSE
    const result = { hlsJsStarts: 0, outcome: null };
    player._playWithHlsJs = () => {
        result.hlsJsStarts++;
        return new Promise(() => {});
    };
    player.play(hlsOptions).catch((err) => (result.outcome = err));
    for (let i = 0; i < 5; i++) await flush();
    player._videoElement.readyState = 0;
    return result;
}

test('WebOSPlayer: a native HLS load that got no data from a silent server fails as a network error', async (t) => {
    const result = await nativeLoadWithoutData(t);
    serverAnswers = false; // the server stopped answering after the manifest poll
    try {
        t.mock.timers.tick(60000); // LOAD_WATCHDOG_HLS_MS, not a byte arrived
        await flush();
        t.mock.timers.tick(5000); // the playlist request gets no answer either
        for (let i = 0; i < 5; i++) await flush();
    } finally {
        serverAnswers = true;
    }

    assert.strictEqual(result.hlsJsStarts, 0, 'started Hls.js against a server that sent nothing');
    assert.ok(result.outcome instanceof PlaybackLoadTimeoutError);
    assert.strictEqual(result.outcome.isNetworkError, true);
});

test('WebOSPlayer: a native HLS load that got no data falls back to Hls.js while the server answers', async (t) => {
    // A cold transcode: the server answers, its first segment takes over a minute
    const result = await nativeLoadWithoutData(t);
    t.mock.timers.tick(60000);
    for (let i = 0; i < 5; i++) await flush();

    assert.strictEqual(result.hlsJsStarts, 1);
    assert.strictEqual(result.outcome, null);
});

/** A native HLS load that sends nothing; the test controls time (setTimeout and Date). */
async function nativeLoadTheTvGivesUpOn(t, { hlsJs = 'count', silent = false } = {}) {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const { player, events } = createPlayer();
    player._shouldUseNativeHls = () => true;
    player._canUseHlsJs = () => true; // as on a TV with MSE
    const result = { hlsJsStarts: 0, outcome: null, player, events };
    if (hlsJs === 'count') {
        player._playWithHlsJs = () => {
            result.hlsJsStarts++;
            return new Promise(() => {});
        };
    }
    player.play(hlsOptions).catch((err) => (result.outcome = err));
    for (let i = 0; i < 5; i++) await flush();
    player._videoElement.readyState = 0;
    // The server stops answering once the manifest poll is done
    if (silent) serverAnswers = false;
    // An LG C4 gives up on a silent server by itself after about 40 s:
    // MEDIA_ERR_SRC_NOT_SUPPORTED on the <source>, before the 60 s watchdog
    t.mock.timers.tick(40000);
    player._videoElement.children[0].fire('error');
    await flush();
    return result;
}

test('WebOSPlayer: when the TV itself gives up on a native HLS load that got no data, a silent server ends the start', async (t) => {
    let result;
    try {
        result = await nativeLoadTheTvGivesUpOn(t, { silent: true });
        t.mock.timers.tick(5000); // the playlist request gets no answer either
        for (let i = 0; i < 5; i++) await flush();
    } finally {
        serverAnswers = true;
    }

    assert.strictEqual(result.hlsJsStarts, 0, 'started Hls.js against a server that sent nothing');
    assert.ok(result.outcome instanceof PlaybackLoadTimeoutError, `not a load timeout: ${result.outcome}`);
    assert.strictEqual(result.outcome.isNetworkError, true, 'reported as an unsupported format');
    assert.match(result.outcome.message, /for 45 s/);
});

test('WebOSPlayer: when the TV itself gives up on a native HLS load that got no data, Hls.js still takes over while the server answers (guard)', async (t) => {
    const result = await nativeLoadTheTvGivesUpOn(t);
    for (let i = 0; i < 5; i++) await flush();

    assert.strictEqual(result.hlsJsStarts, 1);
    assert.strictEqual(result.outcome, null);
});

test('WebOSPlayer: the element error after a failed Hls.js fallback does not replace the start failure', async (t) => {
    stubHls(t);
    const result = await nativeLoadTheTvGivesUpOn(t, { hlsJs: 'real' });
    const { player, events } = result;
    const video = player._videoElement;
    video.play = () => new Promise(() => {}); // no media: Chromium keeps play() pending
    for (let i = 0; i < 5; i++) await flush();

    // Hls.js gets nothing either and gives up after its 60 s watchdog
    t.mock.timers.tick(60000);
    for (let i = 0; i < 5; i++) await flush();
    assert.ok(result.outcome instanceof PlaybackLoadTimeoutError, `the Hls.js start did not fail: ${result.outcome}`);

    // Hls.js detaches (src removed); the MediaSource it ended fires an error on the element
    video.src = '';
    video.error = {
        code: 4,
        message: 'DEMUXER_ERROR_COULD_NOT_OPEN: MediaSource endOfStream before demuxer initialization completes'
    };
    video.fire('error');
    await flush();
    assert.deepStrictEqual(
        events.filter((e) => e.type === 'error'),
        [],
        'the teardown error was reported as an unsupported format'
    );
});
