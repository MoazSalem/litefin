import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * ============================================================================
 * webOS Player Session Lifecycle Test Suite
 * ============================================================================
 * The <video> element is reused across items, so every one-shot listener,
 * timer and pending load of a playback session must end with stop() or the
 * next play(). Covers:
 *   - a load abandoned before 'canplay' never acts on the next item (A1)
 *   - resume / seek retry loops end on a user seek, stop() and a new play() (A2)
 *   - load failures of <source> streams settle play(), plus a load watchdog (A3)
 *   - audio normalization keeps working across queued items (A4)
 * ============================================================================
 */

// ----------------------------------------------------------------------------
// Minimal DOM: <video>/<source> stand-ins that can fire events
// ----------------------------------------------------------------------------

function createEventTarget(base) {
    const listeners = {};
    return Object.assign(base, {
        addEventListener: (type, fn) => (listeners[type] = listeners[type] || []).push(fn),
        removeEventListener: (type, fn) => (listeners[type] = (listeners[type] || []).filter((f) => f !== fn)),
        listenerCount: (type) => (listeners[type] || []).length,
        fire: (type) => (listeners[type] || []).slice().forEach((fn) => fn({ target: base }))
    });
}

/** canPlayType() answer of every created <video> (a test can switch it) */
let canPlayAnswer = () => '';

function createVideo() {
    const video = createEventTarget({
        tagName: 'VIDEO',
        children: [],
        style: {},
        parentNode: null,
        audioTracks: [],
        textTracks: [],
        readyState: 4,
        currentTime: 0,
        duration: 3600,
        muted: false,
        paused: true,
        seeking: false,
        videoWidth: 1920,
        videoHeight: 1080,
        volume: 1,
        seekable: { length: 1 },
        buffered: { length: 0 },
        error: null,
        src: '',
        playCalls: 0,
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
            this.playCalls++;
            this.paused = false;
            return Promise.resolve();
        },
        canPlayType: (type) => canPlayAnswer(type)
    });
    return video;
}

const createdVideos = [];
const documentTarget = createEventTarget({});

globalThis.window = { innerWidth: 1920, innerHeight: 1080, screen: { width: 1920, height: 1080 } };
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {}, key: () => null, length: 0 };
globalThis.document = Object.assign(documentTarget, {
    documentElement: { clientWidth: 1920, clientHeight: 1080 },
    body: { appendChild: () => {} },
    createElement(tag) {
        if (tag === 'video') {
            const video = createVideo();
            createdVideos.push(video);
            return video;
        }
        if (tag === 'source') return createEventTarget({ tagName: 'SOURCE', src: '', type: '' });
        return {
            classList: { add() {}, remove() {}, toggle() {} },
            style: {},
            addEventListener() {},
            querySelectorAll: () => [],
            appendChild() {},
            canPlayType: () => '',
            innerHTML: ''
        };
    }
});
globalThis.fetch = async () => ({ ok: true, text: async () => '#EXTM3U\n' });

const { WebOSPlayer, PlaybackLoadTimeoutError } = await import('../src/player/core/WebOSPlayer.js');

const mediaSource = {
    Container: 'mkv',
    MediaStreams: [
        { Index: 0, Type: 'Video', Codec: 'h264' },
        { Index: 1, Type: 'Audio', Codec: 'aac', Language: 'eng', Channels: 2, IsDefault: true }
    ]
};
// Native-only HLS (HEVC HDR + E-AC-3): Hls.js cannot take over
const nativeOnlyHls = {
    MediaStreams: [
        { Index: 0, Type: 'Video', Codec: 'hevc', VideoRangeType: 'HDR10' },
        { Index: 1, Type: 'Audio', Codec: 'eac3', IsDefault: true }
    ]
};

function createPlayer() {
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
    const events = [];
    const player = new WebOSPlayer({ container, onEvent: (e) => events.push(e.type) });
    return { player, events, container };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** play() and let the load reach 'canplay' */
async function playAndStart(player, options) {
    const playing = player.play(options);
    await flush();
    player._videoElement.fire('canplay');
    await playing;
}

// ----------------------------------------------------------------------------
// A1 — abandoned loads
// ----------------------------------------------------------------------------

test('WebOSPlayer: a load abandoned by stop() rejects with AbortError and never acts on the next item', async () => {
    const { player } = createPlayer();
    const seen = [];
    const original = player._applyInitialTracks.bind(player);
    player._applyInitialTracks = (opts, hls) => {
        seen.push(opts.tag);
        return original(opts, hls);
    };

    // Item A never reaches 'canplay': the user backs out while it loads
    const playA = player.play({ tag: 'A', url: 'http://srv/Videos/a/stream.mkv', mediaSource });
    await flush();
    await player.stop();
    await assert.rejects(playA, (err) => err.name === 'AbortError' && err.superseded === true);

    // Item B on the same <video>
    await playAndStart(player, { tag: 'B', url: 'http://srv/Videos/b/stream.mkv', mediaSource });

    assert.deepStrictEqual(seen, ['B']);
    assert.strictEqual(player._videoElement.playCalls, 1);
    assert.strictEqual(player._videoElement.listenerCount('canplay'), 1, 'only the bound canplay handler remains');
});

test('WebOSPlayer: a newer play() supersedes a pending one', async () => {
    const { player } = createPlayer();
    const playA = player.play({ url: 'http://srv/Videos/a/stream.mkv', mediaSource });
    await flush();
    const playB = player.play({ url: 'http://srv/Videos/b/stream.mkv', mediaSource });
    await assert.rejects(playA, (err) => err.name === 'AbortError');
    await flush();
    player._videoElement.fire('canplay');
    await playB;
    assert.strictEqual(player._videoElement.playCalls, 1);
});

test('WebOSPlayer: the resume seek fallback of an abandoned item does not play the next item', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { player } = createPlayer();

    // Resume at 10:00: canplay → explicit seek → waits up to 3.5 s for 'seeked'
    const playA = player.play({ url: 'http://srv/Videos/a/stream.mkv', mediaSource, playerStartPositionTicks: 6000000000 });
    playA.catch(() => {});
    await flush();
    player._videoElement.fire('canplay');
    await flush();
    await player.stop();

    await playAndStart(player, { url: 'http://srv/Videos/b/stream.mkv', mediaSource });
    const video = player._videoElement;
    assert.strictEqual(video.playCalls, 1);

    t.mock.timers.tick(4000);
    await flush();
    assert.strictEqual(video.playCalls, 1, 'the 3.5 s fallback of item A called play() again');
});

test('WebOSPlayer: a native HLS start stopped while the manifest is fetched loads nothing', async () => {
    const { player } = createPlayer();
    let answerManifest;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => new Promise((resolve) => (answerManifest = resolve));

    const playing = player.play({ url: 'http://srv/videos/x/master.m3u8', isHls: true, mediaSource });
    await flush();
    await player.stop();
    answerManifest({ ok: true, text: async () => '#EXTM3U\n' });

    await assert.rejects(playing, (err) => err.name === 'AbortError');
    assert.strictEqual(player._videoElement.children.length, 0, 'the stopped item was loaded into the <video>');
    globalThis.fetch = originalFetch;
});

// ----------------------------------------------------------------------------
// A2 — resume / seek retry loops
// ----------------------------------------------------------------------------

function startRetryLoop(t) {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { player, events } = createPlayer();
    const video = player._ensureVideoElement();
    player._currentPlayOptions = { url: 'http://srv/master.m3u8', mediaSource, isHls: true };
    player._isHls = true;
    player._hlsFallbackAttempted = true;

    // The TV discarded the startup resume seek to 10:00
    player._seekWithRetry(600);
    assert.strictEqual(video.currentTime, 600);
    video.currentTime = 0;
    return { player, events, video };
}

test('WebOSPlayer: a user seek during the resume retry loop is not pulled back to the resume point', async (t) => {
    const { player, video } = startRetryLoop(t);

    t.mock.timers.tick(1000);
    player.seek(100 * 10000000); // skip to 1:40
    assert.strictEqual(video.currentTime, 100);

    t.mock.timers.tick(10000);
    assert.strictEqual(video.currentTime, 100);
});

test('WebOSPlayer: stop() ends a running resume retry loop', async (t) => {
    const { player, video, events } = startRetryLoop(t);

    await player.stop();
    t.mock.timers.tick(10000);

    assert.strictEqual(video.currentTime, 0);
    assert.ok(!events.includes('resumeseekfailed'));
});

test('WebOSPlayer: waiting for a seekable state gives up instead of polling forever', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { player } = createPlayer();
    const video = player._ensureVideoElement();
    video.readyState = 1; // never seekable
    player._robustSeekTarget = 600;
    let retryLoops = 0;
    player._seekWithRetry = () => retryLoops++;

    player._applyRobustResume(video, 6000000000);
    const advance = (ms) => {
        for (let i = 0; i < ms / 300; i++) t.mock.timers.tick(300);
    };
    advance(30000);
    const scheduledAfterGivingUp = player._sessionCleanups.length;
    advance(30000);

    assert.strictEqual(retryLoops, 0);
    assert.ok(scheduledAfterGivingUp < 50, `scheduled ${scheduledAfterGivingUp} polls`);
    assert.strictEqual(player._sessionCleanups.length, scheduledAfterGivingUp, 'still scheduling polls');
});

// ----------------------------------------------------------------------------
// A3 — load failures
// ----------------------------------------------------------------------------

test('WebOSPlayer: a failing native HLS <source> rejects play() instead of hanging', async () => {
    const { player, events } = createPlayer();
    const playing = player.play({ url: 'http://srv/videos/x/master.m3u8', isHls: true, mediaSource: nativeOnlyHls });
    await flush();
    await flush();

    const source = player._videoElement.firstChild;
    assert.strictEqual(source.tagName, 'SOURCE');
    assert.strictEqual(player._videoElement.error, null);
    source.fire('error'); // fires on the <source>, not on the <video>

    await assert.rejects(playing, /MEDIA_ERR_SRC_NOT_SUPPORTED/);
    assert.ok(!events.includes('error'), 'the load waiter owns load errors');
});

test('WebOSPlayer: a failing native HLS <source> falls back to Hls.js once when the stream allows it', async () => {
    const { player } = createPlayer();
    player._shouldUseNativeHls = () => true;
    player._canUseHlsJs = () => true;
    let hlsJsStarts = 0;
    player._playWithHlsJs = async () => {
        hlsJsStarts++;
    };

    const playing = player.play({ url: 'http://srv/videos/x/master.m3u8', isHls: true, mediaSource });
    await flush();
    await flush();
    player._videoElement.firstChild.fire('error');
    await playing;

    assert.strictEqual(hlsJsStarts, 1);
});

test('WebOSPlayer: a rejected Dolby Vision hint is retried with a raw src instead of failing play()', async () => {
    canPlayAnswer = (type) => (type.includes('dvh1') ? 'probably' : '');
    try {
        const { player, events } = createPlayer();
        const dovi = {
            Container: 'mp4',
            MediaStreams: [
                { Index: 0, Type: 'Video', Codec: 'hevc', VideoRangeType: 'DOVI' },
                { Index: 1, Type: 'Audio', Codec: 'eac3', IsDefault: true }
            ]
        };
        const playing = player.play({ url: 'http://srv/Videos/dv/stream.mp4', mediaSource: dovi });
        await flush();

        const video = player._videoElement;
        const source = video.firstChild;
        assert.strictEqual(source?.tagName, 'SOURCE', 'the Dolby Vision hint path was not taken');
        source.fire('error');
        assert.strictEqual(video.src, 'http://srv/Videos/dv/stream.mp4', 'no raw-src retry');

        video.fire('canplay');
        await playing;
        assert.ok(!events.includes('error'));
    } finally {
        canPlayAnswer = () => '';
    }
});

test('WebOSPlayer: a direct-play load with no progress times out', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { player } = createPlayer();
    const playing = player.play({ url: 'http://srv/Videos/a/stream.mkv', mediaSource });
    let failure = null;
    playing.catch((err) => (failure = err));
    await flush();

    // Data still arriving at 20 s re-arms the watchdog
    t.mock.timers.tick(20000);
    player._videoElement.fire('progress');
    t.mock.timers.tick(20000);
    await flush();
    assert.strictEqual(failure, null);

    t.mock.timers.tick(11000);
    await flush();
    assert.ok(failure instanceof PlaybackLoadTimeoutError);
    assert.strictEqual(failure.isNetworkError, false, 'data arrived: a decoder problem, worth a transcode');
});

test('WebOSPlayer: a load that receives no data at all fails as a network error', async (t) => {
    // A stalled server (accepts, never answers): a transcode would not help
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { player } = createPlayer();
    const playing = player.play({ url: 'http://srv/Videos/a/stream.mkv', mediaSource });
    let failure = null;
    playing.catch((err) => (failure = err));
    await flush();
    player._videoElement.readyState = 0;

    t.mock.timers.tick(30000);
    await flush();
    assert.ok(failure instanceof PlaybackLoadTimeoutError);
    assert.strictEqual(failure.isNetworkError, true);
    assert.match(failure.message, /No media data/);
});

test('WebOSPlayer: a timed-out load is abandoned, so the pipeline cannot report it again later', async (t) => {
    // LG C4: MEDIA_ERR_SRC_NOT_SUPPORTED arrived 10 s after the timeout and was escalated to a transcode
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { player } = createPlayer();
    const playing = player.play({ url: 'http://srv/Videos/a/stream.mkv', mediaSource });
    playing.catch(() => {});
    await flush();
    const video = player._videoElement;
    video.readyState = 0;
    let loads = 0;
    video.load = () => loads++;
    assert.strictEqual(video.src, 'http://srv/Videos/a/stream.mkv');

    t.mock.timers.tick(30000);
    await flush();
    assert.strictEqual(video.src, '', 'the request is still open');
    assert.strictEqual(loads, 1);
});

test('WebOSPlayer: a timed-out <source> load is abandoned too', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { player } = createPlayer();
    const playing = player.play({ url: 'http://srv/videos/a/master.m3u8', mediaSource: nativeOnlyHls });
    playing.catch(() => {});
    await flush();
    await flush();
    const video = player._videoElement;
    assert.strictEqual(video.children.length, 1);

    t.mock.timers.tick(60000);
    await flush();
    assert.strictEqual(video.children.length, 0, 'the <source> request is still open');
});

// ----------------------------------------------------------------------------
// A4 — audio normalization across items
// ----------------------------------------------------------------------------

class StrictAudioContext {
    static instances = [];
    constructor() {
        StrictAudioContext.instances.push(this);
        this.state = 'running';
        this.closed = false;
        this.destination = {};
    }
    createMediaElementSource(element) {
        if (element.webAudioSource) {
            throw new Error('InvalidStateError: element already connected to a MediaElementSourceNode');
        }
        element.webAudioSource = true;
        this.usedForMedia = true;
        return { connect() {}, disconnect() {} };
    }
    createGain() {
        return { gain: { value: 1 }, connect() {}, disconnect() {} };
    }
    close() {
        this.closed = true;
        return Promise.resolve();
    }
    suspend() {
        this.state = 'suspended';
        return Promise.resolve();
    }
    resume() {
        this.state = 'running';
        return Promise.resolve();
    }
}

// Contexts of the normalization graph (the codec capability probe creates and closes its own)
const mediaContexts = () => StrictAudioContext.instances.filter((c) => c.usedForMedia);

const track = (gainDb) => ({
    url: 'http://srv/Audio/1/stream.mp3',
    item: { MediaType: 'Audio', NormalizationGain: gainDb },
    mediaSource: {}
});
const movie = { url: 'http://srv/Videos/m/stream.mkv', item: { Type: 'Movie', MediaType: 'Video' }, mediaSource };

test('WebOSPlayer: normalization works for every queued track and the next movie keeps its audio path', async () => {
    window.AudioContext = StrictAudioContext;
    StrictAudioContext.instances = [];
    const { player, container } = createPlayer();

    await playAndStart(player, track(-6));
    const firstElement = player._videoElement;
    assert.ok(Math.abs(player._audioGraph.gain.gain.value - 0.501) < 0.001);
    await player.stop();

    // The captured element is released with its graph; the context is kept
    assert.ok(!container.children.includes(firstElement));
    assert.strictEqual(mediaContexts()[0].closed, false);

    await playAndStart(player, track(-12));
    assert.ok(Math.abs(player._audioGraph.gain.gain.value - 0.251) < 0.001);
    assert.notStrictEqual(player._videoElement, firstElement);
    await player.stop();

    await playAndStart(player, track(-3));
    await player.stop();

    // One context for the whole queue: Chromium 38 cannot close() contexts and
    // Chromium caps how many can exist
    assert.strictEqual(mediaContexts().length, 1, 'an AudioContext per track runs out on old TVs');
    assert.strictEqual(mediaContexts()[0].closed, false);

    await playAndStart(player, movie);
    assert.strictEqual(player._audioGraph, null);
    assert.ok(!player._videoElement.webAudioSource, 'movie element is routed into Web Audio');
    delete window.AudioContext;
});

test('WebOSPlayer: play() without stop() reuses the graph and plays a movie at unity gain', async () => {
    window.AudioContext = StrictAudioContext;
    StrictAudioContext.instances = [];
    const { player } = createPlayer();

    await playAndStart(player, track(-6));
    await playAndStart(player, movie);

    assert.strictEqual(mediaContexts().length, 1);
    assert.strictEqual(player._audioGraph.gain.gain.value, 1);
    delete window.AudioContext;
});

test('WebOSPlayer: the user mute state survives the element swap', async () => {
    window.AudioContext = StrictAudioContext;
    const { player } = createPlayer();

    await playAndStart(player, track(-6));
    player._videoElement.muted = true;
    await player.stop();

    assert.strictEqual(player._videoElement.muted, true);
    delete window.AudioContext;
});

test('WebOSPlayer: the shared AudioContext is resumed for the next track and closed on destroy()', async () => {
    window.AudioContext = StrictAudioContext;
    StrictAudioContext.instances = [];
    const { player } = createPlayer();

    await playAndStart(player, track(-6));
    await player.stop();
    assert.strictEqual(mediaContexts()[0].state, 'suspended');

    await playAndStart(player, track(-6));
    assert.strictEqual(mediaContexts()[0].state, 'running');

    player.destroy();
    assert.strictEqual(mediaContexts()[0].closed, true);
    delete window.AudioContext;
});
