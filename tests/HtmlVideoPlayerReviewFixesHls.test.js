import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers';

/**
 * ============================================================================
 * HtmlVideoPlayer HLS.js Start and Recovery Test Suite
 * ============================================================================
 * The HTML5 backend (LG "Retry with HTML5") plays HLS through HLS.js. Its
 * start gate, start watchdog and fatal-error recovery are driven here with a
 * stand-in for HLS.js that fires the events HLS.js 1.7.3 fires, on a <video>
 * whose play() settles like a real element's.
 * ============================================================================
 */

function createEventTarget(base) {
    const listeners = {};
    return Object.assign(base, {
        addEventListener: (type, fn) => (listeners[type] = listeners[type] || []).push(fn),
        removeEventListener: (type, fn) => (listeners[type] = (listeners[type] || []).filter((f) => f !== fn)),
        listenerCount: (type) => (listeners[type] || []).length,
        dispatchEvent: (event) => (listeners[event.type] || []).slice().forEach((fn) => fn({ target: base })),
        fire: (type) => (listeners[type] || []).slice().forEach((fn) => fn({ target: base }))
    });
}

const abortError = (message) => Object.assign(new Error(message), { name: 'AbortError' });

/**
 * A <video> whose play() settles on 'playing', and is rejected with a DOM
 * AbortError by pause() or load(), like a real element's.
 */
function createVideo() {
    const pendingPlays = [];
    const rejectPendingPlays = (message) => pendingPlays.splice(0).forEach(({ reject }) => reject(abortError(message)));
    const video = createEventTarget({
        style: {},
        children: [],
        parentNode: null,
        audioTracks: [],
        textTracks: [],
        readyState: 4,
        currentTime: 0,
        duration: 3600,
        muted: false,
        paused: true,
        seeking: false,
        autoplay: false,
        error: null,
        src: '',
        playCalls: 0,
        firstChild: null,
        buffered: { length: 0, start: () => 0, end: () => 0 },
        setAttribute() {},
        removeAttribute(name) {
            if (name === 'src') this.src = '';
        },
        load() {
            this.paused = true;
            this.error = null;
            rejectPendingPlays('The play() request was interrupted by a new load request.');
        },
        pause() {
            this.paused = true;
            rejectPendingPlays('The play() request was interrupted by a call to pause().');
        },
        play() {
            this.playCalls++;
            this.paused = false;
            return new Promise((resolve, reject) => pendingPlays.push({ resolve, reject }));
        },
        canPlayType: () => ''
    });
    const fire = video.fire;
    video.fire = (type) => {
        if (type === 'playing') pendingPlays.splice(0).forEach(({ resolve }) => resolve());
        fire(type);
    };
    return video;
}

globalThis.window = { innerWidth: 1920, innerHeight: 1080, screen: { width: 1920, height: 1080 } };
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {}, key: () => null, length: 0 };
globalThis.document = createEventTarget({
    documentElement: { clientWidth: 1920, clientHeight: 1080 },
    body: { appendChild: () => {} },
    createElement: (tag) => (tag === 'video' ? createVideo() : { style: {}, canPlayType: () => '', appendChild() {} })
});
globalThis.fetch = async () => ({ ok: true, text: async () => '#EXTM3U\n' });

const { HtmlVideoPlayer } = await import('../src/player/core/HtmlVideoPlayer.js');
const { default: Hls } = await import('hls.js');

/**
 * Stand-in for an HLS.js instance. recoverMediaError() mirrors HLS.js 1.7.3:
 * detachMedia() removes the element's src and calls load(), then the element
 * is attached again.
 */
class FakeHls {
    constructor(config) {
        this.config = config;
        this.handlers = {};
        this.audioTracks = [];
        this.subtitleTracks = [];
        this.levels = [];
        this.calls = [];
        this.loadedUrls = [];
        this.media = null;
    }
    on(event, fn) {
        (this.handlers[event] = this.handlers[event] || []).push(fn);
    }
    off(event, fn) {
        this.handlers[event] = (this.handlers[event] || []).filter((f) => f !== fn);
    }
    trigger(event, data = {}) {
        (this.handlers[event] || []).slice().forEach((fn) => fn(event, data));
    }
    loadSource(url) {
        this.url = url;
        this.loadedUrls.push(url);
    }
    attachMedia(media) {
        this.media = media;
        media.src = 'blob:hls';
    }
    detachMedia() {
        const media = this.media;
        if (!media) return;
        media.removeAttribute('src');
        media.load();
        this.trigger(Hls.Events.MEDIA_DETACHING, {});
        this.media = null;
        this.trigger(Hls.Events.MEDIA_DETACHED, {});
    }
    recoverMediaError() {
        this.calls.push('recoverMediaError');
        const media = this.media;
        this.detachMedia();
        if (media) this.attachMedia(media);
    }
    swapAudioCodec() {
        this.calls.push('swapAudioCodec');
    }
    startLoad() {
        this.calls.push('startLoad');
    }
    destroy() {
        this.calls.push('destroy');
        this.detachMedia();
    }
}

/** HLS.js appends a segment's video and audio separately, then reports it buffered. */
function bufferSegment(hls, sn) {
    const frag = { sn, type: 'main' };
    hls.trigger(Hls.Events.BUFFER_APPENDED, { type: 'video', frag, parent: 'main' });
    hls.trigger(Hls.Events.BUFFER_APPENDED, { type: 'audio', frag, parent: 'main' });
    hls.trigger(Hls.Events.FRAG_BUFFERED, { frag, id: 'main' });
}

const mediaSource = {
    MediaStreams: [
        { Index: 0, Type: 'Video', Codec: 'h264' },
        { Index: 1, Type: 'Audio', Codec: 'aac', IsDefault: true }
    ]
};

const hlsItem = (extra = {}) => ({
    url: 'http://srv/videos/a/master.m3u8',
    isHls: true,
    mediaSource,
    item: { Type: 'Movie' },
    ...extra
});

/** A player whose HLS loads run on FakeHls instances (collected in hlsInstances). */
function createPlayer(t) {
    t.mock.method(Hls, 'isSupported', () => true);
    const events = [];
    const container = {
        clientWidth: 1920,
        clientHeight: 1080,
        style: {},
        children: [],
        appendChild(child) {
            child.parentNode = this;
            this.children.push(child);
        },
        removeChild(child) {
            child.parentNode = null;
            this.children = this.children.filter((c) => c !== child);
        }
    };
    const player = new HtmlVideoPlayer({ container, onEvent: (e) => events.push(e.type) });
    const hlsInstances = [];
    player._createHlsPlayer = (config) => {
        const hls = new FakeHls(config);
        hlsInstances.push(hls);
        return hls;
    };
    return { player, events, hlsInstances };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Track how a load ended: 'pending', 'started' or the rejection. */
function watch(promise) {
    const state = { outcome: 'pending' };
    promise.then(
        () => (state.outcome = 'started'),
        (err) => (state.outcome = err)
    );
    return state;
}

const fatalMediaError = { fatal: true, type: Hls.ErrorTypes.MEDIA_ERROR, details: 'bufferAppendError' };

// ----------------------------------------------------------------------------
// A decoder reset while the start's play() is pending
// ----------------------------------------------------------------------------

test('HtmlVideoPlayer: playback starts after HLS.js resets the decoder during the start', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { player, hlsInstances } = createPlayer(t);
    const video = player._ensureVideoElement();
    const load = watch(player.play(hlsItem({ playMethod: 'DirectStream' })));
    const hls = hlsInstances[0];
    hls.trigger(Hls.Events.MANIFEST_PARSED, {});
    bufferSegment(hls, 1);
    assert.strictEqual(video.playCalls, 1);

    // HLS.js gives up appending: recoverMediaError() reloads the element,
    // which aborts the pending play()
    hls.trigger(Hls.Events.ERROR, fatalMediaError);
    assert.deepStrictEqual(hls.calls, ['recoverMediaError']);
    await flush();
    assert.strictEqual(load.outcome, 'pending', `load ended with "${load.outcome.message}": no playback, no error`);

    // HLS.js buffers again
    bufferSegment(hls, 1);
    assert.strictEqual(video.playCalls, 2, 'playback not started again after the reset');
    video.fire('playing');
    await flush();
    assert.strictEqual(load.outcome, 'started');
});

test('HtmlVideoPlayer: a start that does not follow a decoder reset fails with a decode error', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { player, hlsInstances } = createPlayer(t);
    const load = watch(player.play(hlsItem({ playMethod: 'DirectStream' })));
    const hls = hlsInstances[0];
    hls.trigger(Hls.Events.MANIFEST_PARSED, {});
    bufferSegment(hls, 1);
    hls.trigger(Hls.Events.ERROR, fatalMediaError);
    await flush();

    t.mock.timers.tick(10000);
    await flush();
    // JellyfinPlayer drops an AbortError as a cancel: no error and no fallback
    assert.ok(load.outcome instanceof Error, 'load still pending');
    assert.notStrictEqual(load.outcome.name, 'AbortError');
    assert.strictEqual(load.outcome.code, 3);
});

// ----------------------------------------------------------------------------
// Start watchdog and resume gate: segments, not SourceBuffer appends
// ----------------------------------------------------------------------------

const resumeAt600 = (playMethod) => hlsItem({ playMethod, playerStartPositionTicks: 600 * 10000000 });

test('HtmlVideoPlayer: a resume stuck after its segments arrived is escalated after the 3 s fallback', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { player, events, hlsInstances } = createPlayer(t);
    player.play(resumeAt600('Transcode')).catch(() => {});
    const hls = hlsInstances[0];
    hls.trigger(Hls.Events.MANIFEST_PARSED, {});

    t.mock.timers.tick(3000); // slow transcode: the 3 s fallback starts play() with nothing buffered
    // The first segments arrive at ~4 s, but the decoder never starts
    bufferSegment(hls, 1);
    bufferSegment(hls, 2);
    t.mock.timers.tick(5000);

    assert.ok(events.includes('resumeseekfailed'), 'stuck start taken for a transcode still preparing');
});

test('HtmlVideoPlayer: a transcode that has delivered no segment by 8 s is still left to start', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { player, events, hlsInstances } = createPlayer(t);
    player.play(resumeAt600('Transcode')).catch(() => {});
    hlsInstances[0].trigger(Hls.Events.MANIFEST_PARSED, {});
    t.mock.timers.tick(8000);
    assert.ok(!events.includes('resumeseekfailed'));
});

test('HtmlVideoPlayer: a slow transcode whose first segment lands just before 8 s is given time to start', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { player, events, hlsInstances } = createPlayer(t);
    player.play(resumeAt600('Transcode')).catch(() => {});
    const hls = hlsInstances[0];
    hls.trigger(Hls.Events.MANIFEST_PARSED, {});

    t.mock.timers.tick(7500); // cold transcode: segment #1 arrives at 7.5 s
    bufferSegment(hls, 1);
    t.mock.timers.tick(500);
    assert.ok(!events.includes('resumeseekfailed'), 'restarted (a new cold transcode) 0.5 s after its first segment');

    // Still not started 5 s after its first segment: a stuck decoder
    t.mock.timers.tick(4500);
    assert.strictEqual(events.filter((e) => e === 'resumeseekfailed').length, 1);
});

test('HtmlVideoPlayer: a resume that starts within 5 s of its first late segment is left alone', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { player, events, hlsInstances } = createPlayer(t);
    const video = player._ensureVideoElement();
    player.play(resumeAt600('Transcode')).catch(() => {});
    const hls = hlsInstances[0];
    hls.trigger(Hls.Events.MANIFEST_PARSED, {});

    t.mock.timers.tick(7500);
    bufferSegment(hls, 1);
    t.mock.timers.tick(2000);
    video.fire('playing');
    t.mock.timers.tick(10000);
    assert.ok(!events.includes('resumeseekfailed'));
});

test('HtmlVideoPlayer: the resume gate waits for segment #2 when segment #1 leaves under 1 s', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { player, hlsInstances } = createPlayer(t);
    const video = player._ensureVideoElement();
    player.play(resumeAt600('Transcode')).catch(() => {});
    const hls = hlsInstances[0];
    hls.trigger(Hls.Events.MANIFEST_PARSED, {});

    // Segment #1 covers 594.2–600.2 s: 0.2 s ahead of the resume point
    video.buffered = { length: 1, start: () => 594.2, end: () => 600.2 };
    bufferSegment(hls, 1);
    assert.strictEqual(video.playCalls, 0, 'started with 0.2 s buffered (the audio append counted as segment #2)');

    video.buffered = { length: 1, start: () => 594.2, end: () => 606.2 };
    bufferSegment(hls, 2);
    assert.strictEqual(video.playCalls, 1);
});

// ----------------------------------------------------------------------------
// Fatal media errors: decoder resets per HLS.js instance
// ----------------------------------------------------------------------------

test('HtmlVideoPlayer: HLS.js media errors that recur every few seconds are reported after three resets', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1000000 });
    const { player } = createPlayer(t);
    const hls = new FakeHls({});
    const failures = [];
    const { onError } = player._createHlsErrorHandler(hls, (err) => failures.push(err));

    // A decoder that fails each time the re-buffer reaches the same spot, 3.5 s apart:
    // never twice inside the 3 s window
    for (let i = 0; i < 3; i++) {
        onError('hlsError', fatalMediaError);
        t.mock.timers.tick(3500);
    }
    assert.deepStrictEqual(hls.calls, ['recoverMediaError', 'recoverMediaError', 'recoverMediaError']);
    assert.strictEqual(failures.length, 0);

    onError('hlsError', fatalMediaError);
    assert.strictEqual(hls.calls.length, 3, 'decoder reset forever behind a spinner');
    assert.strictEqual(failures.length, 1);
    assert.strictEqual(failures[0].code, 3);
});

test('HtmlVideoPlayer: an HLS.js media error after sustained playback gets a fresh budget', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1000000 });
    const { player } = createPlayer(t);
    const video = player._ensureVideoElement();
    const hls = new FakeHls({});
    const failures = [];
    const { onError } = player._createHlsErrorHandler(hls, (err) => failures.push(err));

    // Three resets get past a bad spot at 10:00, then a new fault at 25:00
    for (const position of [600, 603, 606, 1500]) {
        video.currentTime = position;
        onError('hlsError', fatalMediaError);
        t.mock.timers.tick(3500);
    }
    assert.strictEqual(hls.calls.length, 4, 'a new fault 15 minutes later was reported');
    assert.strictEqual(failures.length, 0);
});

test('HtmlVideoPlayer: a media error while the element reloads does not renew the reset budget', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1000000 });
    const { player } = createPlayer(t);
    const video = player._ensureVideoElement();
    const hls = new FakeHls({});
    const failures = [];
    const { onError } = player._createHlsErrorHandler(hls, (err) => failures.push(err));

    // The playhead is at 0 until HLS.js puts it back after a reset
    for (const position of [600, 603, 0, 604]) {
        video.currentTime = position;
        onError('hlsError', fatalMediaError);
        t.mock.timers.tick(3500);
    }
    assert.strictEqual(hls.calls.length, 3);
    assert.strictEqual(failures.length, 1, 'the same fault got three more resets');
});

// ----------------------------------------------------------------------------
// autoplay across items
// ----------------------------------------------------------------------------

test('HtmlVideoPlayer: an HLS.js item after a native item does not inherit autoplay', async (t) => {
    const { player, hlsInstances } = createPlayer(t);
    // A native item (progressive direct play) turns autoplay on
    const native = player.play({ url: 'http://srv/Videos/a/stream.mp4', mediaSource });
    await flush();
    player._videoElement.fire('canplay');
    player._videoElement.fire('playing');
    await native;
    assert.strictEqual(player._videoElement.autoplay, true);
    await player.stop();

    // SyncPlay starts its items with autoPlay: false
    const load = player.play(hlsItem({ autoPlay: false }));
    hlsInstances[0].trigger(Hls.Events.MANIFEST_PARSED, {});
    await load;
    assert.strictEqual(player._videoElement.autoplay, false, 'the element starts the paused item by itself');
});

// ----------------------------------------------------------------------------
// HLS manifest duration across items
// ----------------------------------------------------------------------------

test("HtmlVideoPlayer: an HLS item's manifest duration does not carry over to the next item", async (t) => {
    const { player, hlsInstances } = createPlayer(t);
    const playHls = async () => {
        const load = player.play(hlsItem({ autoPlay: false }));
        const hls = hlsInstances.at(-1);
        hls.trigger(Hls.Events.MANIFEST_PARSED, {});
        await load;
        // The transcode finished: the playlist has its #EXT-X-ENDLIST
        hls.trigger(Hls.Events.LEVEL_UPDATED, { details: { live: false, totalduration: 5400 } });
        assert.strictEqual(player.getHlsManifestDuration(), 5400);
    };

    await playHls();
    await player.stop();
    assert.strictEqual(player.getHlsManifestDuration(), null, 'kept after stop()');

    // The next item plays natively, without stop() in between
    await playHls();
    const native = player.play({ url: 'http://srv/Videos/b/stream.mp4', mediaSource });
    assert.strictEqual(player.getHlsManifestDuration(), null, "taken as the native item's duration");
    await flush();
    player._videoElement.fire('canplay');
    player._videoElement.fire('playing');
    await native;
});

// ----------------------------------------------------------------------------
// A server that stops answering during the start
// ----------------------------------------------------------------------------

const networkError = (details) => ({ fatal: true, type: Hls.ErrorTypes.NETWORK_ERROR, details });

test('HtmlVideoPlayer: a fatal manifest error is retried by requesting the manifest again', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { player, hlsInstances } = createPlayer(t);
    const item = hlsItem({ playMethod: 'Transcode' });
    player.play(item).catch(() => {});
    const hls = hlsInstances[0];

    hls.trigger(Hls.Events.ERROR, networkError(Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT));
    t.mock.timers.tick(1000);
    // HLS.js 1.7: startLoad() with no levels only flags a start, no request and no event follow
    assert.deepStrictEqual(hls.loadedUrls, [item.url, item.url], 'retried with startLoad()');
    assert.deepStrictEqual(hls.calls, []);

    // A fragment is still retried with startLoad()
    hls.trigger(Hls.Events.ERROR, networkError(Hls.ErrorDetails.FRAG_LOAD_ERROR));
    t.mock.timers.tick(2000);
    assert.deepStrictEqual(hls.calls, ['startLoad']);
    assert.strictEqual(hls.loadedUrls.length, 2);
});

test('HtmlVideoPlayer: an HLS.js start that gets nothing from the server fails as a network error after 60 s', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { player, hlsInstances } = createPlayer(t);
    const load = watch(player.play(hlsItem({ playMethod: 'Transcode' })));
    const hls = hlsInstances[0];

    t.mock.timers.tick(59999);
    await flush();
    assert.strictEqual(load.outcome, 'pending');
    t.mock.timers.tick(1);
    await flush();
    assert.ok(load.outcome instanceof Error, 'spinner forever');
    assert.strictEqual(load.outcome.isNetworkError, true, 'a transcode would be tried against a silent server');
    assert.ok(hls.calls.includes('destroy'));
});

test('HtmlVideoPlayer: a slow cold transcode is not cut off while HLS.js requests its first segment', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { player, hlsInstances } = createPlayer(t);
    const load = watch(player.play(hlsItem({ playMethod: 'Transcode' })));
    const hls = hlsInstances[0];
    hls.trigger(Hls.Events.MANIFEST_LOADED, {});
    hls.trigger(Hls.Events.LEVEL_LOADED, {});
    hls.trigger(Hls.Events.MANIFEST_PARSED, {});

    // The server answers the segment request once it is transcoded; HLS.js
    // times each attempt out after 20 s and requests it again
    for (let i = 0; i < 5; i++) {
        hls.trigger(Hls.Events.FRAG_LOADING, { frag: { sn: 1, type: 'main' } });
        t.mock.timers.tick(20000);
    }
    await flush();
    assert.strictEqual(load.outcome, 'pending', 'start cut off while HLS.js was loading');

    hls.trigger(Hls.Events.FRAG_LOADED, {});
    bufferSegment(hls, 1);
    player._videoElement.fire('playing');
    await flush();
    assert.strictEqual(load.outcome, 'started');
});

test('HtmlVideoPlayer: an HLS.js start stuck after data arrived fails, but not as a network error', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { player, hlsInstances } = createPlayer(t);
    const load = watch(player.play(hlsItem({ playMethod: 'DirectStream' })));
    const hls = hlsInstances[0];
    hls.trigger(Hls.Events.MANIFEST_LOADED, {});
    hls.trigger(Hls.Events.MANIFEST_PARSED, {});
    hls.trigger(Hls.Events.FRAG_LOADING, { frag: { sn: 1, type: 'main' } });
    hls.trigger(Hls.Events.FRAG_LOADED, {});
    bufferSegment(hls, 1); // play() never settles: the decoder does not start

    t.mock.timers.tick(60000);
    await flush();
    assert.ok(load.outcome instanceof Error);
    assert.strictEqual(load.outcome.isNetworkError, false, 'the server delivered: a transcode may help');
});
