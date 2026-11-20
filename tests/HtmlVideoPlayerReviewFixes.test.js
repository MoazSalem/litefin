import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers';

/**
 * ============================================================================
 * HtmlVideoPlayer Playback Session Test Suite
 * ============================================================================
 * The HTML5 backend (LG "Retry with HTML5") reuses one <video> across items.
 * Seeks during direct play are verified, time updates reach the subtitle
 * renderer at the platform's cadence, and nothing of one item (a queued
 * Play, subtitle cue times) acts on the next.
 * ============================================================================
 */

function createEventTarget(base) {
    const listeners = {};
    return Object.assign(base, {
        addEventListener: (type, fn) => (listeners[type] = listeners[type] || []).push(fn),
        removeEventListener: (type, fn) => (listeners[type] = (listeners[type] || []).filter((f) => f !== fn)),
        listenerCount: (type) => (listeners[type] || []).length,
        fire: (type) => (listeners[type] || []).slice().forEach((fn) => fn({ target: base }))
    });
}

function createVideo() {
    return createEventTarget({
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
        error: null,
        src: '',
        playCalls: 0,
        firstChild: null,
        setAttribute() {},
        removeAttribute(name) {
            if (name === 'src') this.src = '';
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
        canPlayType: () => ''
    });
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

const mediaSource = {
    MediaStreams: [
        { Index: 0, Type: 'Video', Codec: 'h264' },
        { Index: 1, Type: 'Audio', Codec: 'aac', IsDefault: true }
    ]
};

function createPlayer() {
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
    return { player, events };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

async function playAndStart(player, options) {
    const playing = player.play(options);
    await flush();
    await flush();
    player._videoElement.fire('canplay');
    await playing;
}

const movie = { url: 'http://srv/Videos/a/stream.mkv', mediaSource, item: { Type: 'Movie' } };

const count = (events, type) => events.filter((e) => e === type).length;

// ----------------------------------------------------------------------------
// Direct-play seek verification
// ----------------------------------------------------------------------------

test('HtmlVideoPlayer: a direct-play seek backwards that does not land is reported', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { player, events } = createPlayer();
    await playAndStart(player, movie);
    const video = player._videoElement;

    video.currentTime = 3000;
    player.seek(60 * 10000000);
    video.currentTime = 3000; // the demuxer never moved
    t.mock.timers.tick(2500);
    assert.strictEqual(count(events, 'resumeseekfailed'), 1, 'no remux fallback for a stuck backward seek');
});

test('HtmlVideoPlayer: a direct-play seek that lands near its target either way is not reported', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { player, events } = createPlayer();
    await playAndStart(player, movie);
    const video = player._videoElement;

    video.currentTime = 3000;
    player.seek(60 * 10000000);
    video.currentTime = 52; // previous keyframe
    t.mock.timers.tick(2500);

    player.seek(1200 * 10000000);
    video.currentTime = 1202.5; // landed and played on
    t.mock.timers.tick(2500);
    assert.strictEqual(count(events, 'resumeseekfailed'), 0);
});

// ----------------------------------------------------------------------------
// timeupdate throttle
// ----------------------------------------------------------------------------

/** A controllable performance.now() for the throttle. */
function mockClock(t) {
    const clock = { now: 100000 };
    t.mock.method(performance, 'now', () => clock.now);
    return { tick: (ms) => (clock.now += ms) };
}

test('HtmlVideoPlayer: every ~156 ms timeupdate (webOS cadence) is forwarded', async (t) => {
    // SubtitleManager ticks external subtitles only from these events
    const clock = mockClock(t);
    const { player, events } = createPlayer();
    await playAndStart(player, movie);
    const video = player._videoElement;
    events.length = 0;

    for (let i = 1; i <= 20; i++) {
        clock.tick(156);
        video.currentTime = 100 + i * 0.156;
        video.fire('timeupdate');
    }
    assert.strictEqual(count(events, 'timeupdate'), 20);
});

test('HtmlVideoPlayer: bursts of timeupdate are throttled, but a jump is forwarded at once', async (t) => {
    const clock = mockClock(t);
    const { player, events } = createPlayer();
    await playAndStart(player, movie);
    const video = player._videoElement;

    clock.tick(1000);
    video.currentTime = 10;
    video.fire('timeupdate');
    events.length = 0;
    for (let i = 1; i <= 4; i++) {
        clock.tick(20);
        video.currentTime = 10 + i * 0.02;
        video.fire('timeupdate');
    }
    assert.strictEqual(count(events, 'timeupdate'), 0);

    clock.tick(10);
    video.currentTime = 600; // seek landed
    video.fire('timeupdate');
    assert.strictEqual(count(events, 'timeupdate'), 1);
});

// ----------------------------------------------------------------------------
// A Play queued behind a seek
// ----------------------------------------------------------------------------

test('HtmlVideoPlayer: stop() drops a Play queued behind a seek', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { player } = createPlayer();
    await playAndStart(player, { url: 'http://srv/Videos/a/stream.mp4', mediaSource });
    let video = player._videoElement;
    video.paused = true;
    video.seeking = true;
    player.unpause(); // queued behind the seek
    await player.stop(); // Back, or the next item, within 500 ms

    // The next item starts paused (SyncPlay starts items with autoPlay: false)
    await playAndStart(player, { url: 'http://srv/Videos/b/stream.mp4', mediaSource, autoPlay: false });
    video = player._videoElement;
    video.seeking = false;
    const plays = video.playCalls;
    video.fire('seeked'); // e.g. a group seek while paused
    t.mock.timers.tick(1000);
    assert.strictEqual(video.playCalls, plays, "the previous item's queued Play started this paused item");
});

// ----------------------------------------------------------------------------
// Audio normalization
// ----------------------------------------------------------------------------

class AudioContextStub {
    constructor() {
        this.state = 'running';
        this.destination = {};
    }
    createMediaElementSource(element) {
        this.capturedSrc = element.src;
        return { connect() {}, disconnect() {} };
    }
    createGain() {
        return { gain: { value: 1 }, connect() {}, disconnect() {} };
    }
    suspend() {
        return Promise.resolve();
    }
    resume() {
        return Promise.resolve();
    }
}

const track = (gainDb) => ({
    url: 'http://srv/Audio/1/stream.mp3',
    item: { MediaType: 'Audio', NormalizationGain: gainDb },
    mediaSource: {}
});

test('HtmlVideoPlayer: a normalized track plays through its gain from the start', async (t) => {
    window.AudioContext = AudioContextStub;
    t.after(() => delete window.AudioContext);
    const { player } = createPlayer();

    const first = player.play(track(-6));
    const graph = player._audioGraph;
    assert.ok(graph, 'track started at full level, normalization routed in after play()');
    assert.strictEqual(graph.element, player._videoElement);
    assert.strictEqual(graph.context.capturedSrc, '', 'element captured after its load started');
    assert.ok(Math.abs(graph.gain.gain.value - 0.501) < 0.001);
    await flush();
    player._videoElement.fire('canplay');
    await first;

    // The next track (play() without stop()) gets its gain before it loads as well
    const second = player.play(track(-12));
    assert.ok(Math.abs(player._audioGraph.gain.gain.value - 0.251) < 0.001, 'played at the previous gain');
    await flush();
    player._videoElement.fire('canplay');
    await second;
});

// ----------------------------------------------------------------------------
// Subtitle offset on native text tracks
// ----------------------------------------------------------------------------

test('HtmlVideoPlayer: subtitle cues added after an offset get the offset, not a delta', async () => {
    const { player } = createPlayer();
    await playAndStart(player, movie);
    const early = { startTime: 10, endTime: 12 };
    const tracks = [
        { mode: 'showing', cues: [early] },
        { mode: 'disabled', cues: [] }
    ];
    player._videoElement.textTracks = tracks;

    player.setSubtitleStreamIndex(0);
    player.setSubtitleOffset(2);
    const late = { startTime: 30, endTime: 32 }; // the next WebVTT segment, parsed by HLS.js
    tracks[0].cues.push(late);
    player.setSubtitleOffset(3);

    assert.deepStrictEqual([early.startTime, early.endTime], [13, 15]);
    assert.deepStrictEqual([late.startTime, late.endTime], [33, 35], 'late cue shifted by the change only');
});

test('HtmlVideoPlayer: subtitle cues added after an offset return to their time after a track switch', async () => {
    const { player } = createPlayer();
    await playAndStart(player, movie);
    const early = { startTime: 10, endTime: 12 };
    const tracks = [
        { mode: 'showing', cues: [early] },
        { mode: 'disabled', cues: [] }
    ];
    player._videoElement.textTracks = tracks;

    player.setSubtitleStreamIndex(0);
    player.setSubtitleOffset(2);
    const late = { startTime: 30, endTime: 32 };
    tracks[0].cues.push(late);

    // A track switch resets the offset
    player.setSubtitleStreamIndex(1);
    player.setSubtitleStreamIndex(0);
    assert.strictEqual(early.startTime, 10);
    assert.strictEqual(late.startTime, 30, 'late cue moved 2 s early');
});

// ----------------------------------------------------------------------------
// 'playing' after a seek
// ----------------------------------------------------------------------------

test('HtmlVideoPlayer: a seek during playback that rebuffers reports playing once, when it plays on', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { player, events } = createPlayer();
    await playAndStart(player, movie);
    const video = player._videoElement;
    video.fire('playing');
    events.length = 0;

    video.seeking = true;
    video.fire('seeking');
    video.readyState = 1; // the seek drops the readyState: the element reports 'waiting'
    video.fire('waiting');
    video.readyState = 2;
    video.seeking = false;
    video.fire('seeked');
    assert.strictEqual(count(events, 'playing'), 0, "'playing' at HAVE_CURRENT_DATA hides the spinner early");

    video.readyState = 4;
    video.fire('playing');
    assert.strictEqual(count(events, 'playing'), 1);
});

test('HtmlVideoPlayer: a seek inside the buffer during playback still ends the spinner', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { player, events } = createPlayer();
    await playAndStart(player, movie);
    const video = player._videoElement;
    video.fire('playing');
    events.length = 0;

    // The readyState never drops: the element fires neither 'waiting' nor 'playing'
    video.seeking = true;
    video.fire('seeking');
    video.seeking = false;
    video.fire('seeked');
    assert.deepStrictEqual(
        events.filter((e) => e === 'waiting' || e === 'playing'),
        ['waiting', 'playing']
    );
});

test('HtmlVideoPlayer: Play queued behind a paused seek reports playing once', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { player, events } = createPlayer();
    await playAndStart(player, movie);
    const video = player._videoElement;
    video.paused = true;
    events.length = 0;

    video.seeking = true;
    video.fire('seeking');
    player.unpause(); // queued behind the seek
    video.seeking = false;
    video.fire('seeked'); // runs the queued play()...
    video.fire('playing'); // ...which the element answers with 'playing'
    assert.strictEqual(count(events, 'playing'), 1);
});
