import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * ============================================================================
 * webOS Player: the Dolby Vision pause/play flush
 * ============================================================================
 * A Dolby Vision decoder stuck with a full buffer gets a 200 ms pause, then
 * play again. That flush:
 *   - resumes even when a 'waiting', 'stalled' or 'playing' comes meanwhile
 *   - does not undo a Pause of the user's within the 200 ms
 *   - is not reported to JellyfinPlayer as a pause and a play
 *   - does not end the watch of a pending seek
 *   - never resumes a later item
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

/** <video> stand-in whose pause() and play() fire their events, as Chromium does */
function createVideo() {
    return createEventTarget({
        children: [],
        style: {},
        audioTracks: [],
        textTracks: [],
        readyState: 4,
        currentTime: 0,
        duration: 3600,
        muted: false,
        paused: true,
        seeking: false,
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
            if (this.paused) return;
            this.paused = true;
            this.fire('pause');
        },
        play() {
            this.playCalls++;
            if (this.paused) {
                this.paused = false;
                this.fire('play');
            }
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
            : createEventTarget({ classList: { add() {}, remove() {} }, style: {}, appendChild() {} })
});

const { WebOSPlayer } = await import('../src/player/core/WebOSPlayer.js');

const flush = () => new Promise((resolve) => globalThis.setImmediate(resolve));

const doviOptions = {
    url: 'http://srv/Videos/dv/stream.mp4',
    mediaSource: {
        MediaStreams: [
            { Index: 0, Type: 'Video', Codec: 'hevc', VideoRangeType: 'DOVI' },
            { Index: 1, Type: 'Audio', Codec: 'eac3', IsDefault: true }
        ]
    }
};

/**
 * Dolby Vision playback at 10:00 whose decoder froze with 40 s buffered; the
 * stall check has run its 4 s and paused the element for the flush.
 */
function flushing(t) {
    const { player, video, events } = stuckDecoder(t);
    t.mock.timers.tick(4000);
    assert.strictEqual(video.paused, true, 'sanity: the flush paused the element');
    return { player, video, events };
}

/** The same playback, 4 s before the stall check flushes the decoder */
function stuckDecoder(t) {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const events = [];
    const player = new WebOSPlayer({
        container: { clientWidth: 1920, clientHeight: 1080, style: {}, appendChild() {} },
        onEvent: (e) => events.push(e.type)
    });
    const video = player._ensureVideoElement();
    player._currentPlayOptions = doviOptions;
    player._started = true;
    video.paused = false;
    video.src = doviOptions.url;
    video.currentTime = 600;
    video.buffered = { length: 1, start: () => 590, end: () => 640 };

    video.fire('waiting');
    return { player, video, events };
}

const pausePlay = (events) => events.filter((type) => type === 'pause' || type === 'play');

test('WebOSPlayer: the Dolby Vision flush is not reported as a pause and a play', (t) => {
    const { video, events } = flushing(t);
    t.mock.timers.tick(200);

    assert.strictEqual(video.paused, false, 'the flush did not resume playback');
    assert.deepStrictEqual(pausePlay(events), [], 'JellyfinPlayer showed playback paused');
    video.fire('pause'); // a later pause is reported again
    assert.deepStrictEqual(pausePlay(events), ['pause']);
});

test('WebOSPlayer: a stall event during the Dolby Vision flush does not leave playback paused', (t) => {
    const { video } = flushing(t);
    // Pausing a stuck decoder can bring these; each one cleared the resume timer
    video.fire('stalled');
    video.fire('waiting');
    video.fire('playing');
    t.mock.timers.tick(200);

    assert.strictEqual(video.paused, false, 'playback stayed paused');
    assert.strictEqual(video.playCalls, 1);
});

test('WebOSPlayer: a Pause during the Dolby Vision flush keeps playback paused', (t) => {
    const { player, video, events } = flushing(t);
    t.mock.timers.tick(100);
    player.pause();
    assert.deepStrictEqual(pausePlay(events), ['pause'], 'the pause was not reported');

    t.mock.timers.tick(1000);
    assert.strictEqual(video.paused, true, "the flush undid the user's pause");
    assert.strictEqual(video.playCalls, 0);

    // Play resumes as usual
    player.unpause();
    assert.strictEqual(video.paused, false);
    assert.deepStrictEqual(pausePlay(events), ['pause', 'play']);
});

test('WebOSPlayer: a seek pending across the Dolby Vision flush is still watched', (t) => {
    const { video, events } = stuckDecoder(t);
    t.mock.timers.tick(2100);
    video.seeking = true; // a seek the pipeline never completes
    video.fire('seeking');
    t.mock.timers.tick(1900); // the flush pauses the element
    t.mock.timers.tick(100); // the seek check runs during the pause
    t.mock.timers.tick(100); // the flush plays again

    for (let i = 0; i < 6; i++) t.mock.timers.tick(2000);
    assert.ok(events.includes('seekstuck'), 'a seek stuck after the flush was never reported');
});

test('WebOSPlayer: the Dolby Vision flush never resumes the next item', async (t) => {
    const { player, video } = flushing(t);
    const next = player.play({ url: 'http://srv/Videos/b/stream.mkv', mediaSource: doviOptions.mediaSource });
    next.catch(() => {});
    await flush();

    t.mock.timers.tick(200);
    assert.strictEqual(video.playCalls, 0, 'the next item started before it had loaded');
    await player.stop();
});
