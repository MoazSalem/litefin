import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * ============================================================================
 * webOS Player: session cleanups do not pile up
 * ============================================================================
 *   - a session timer that fired, or a listener removed early, leaves no
 *     cleanup behind
 *   - a seek left pending by a pause is not checked every 2 s while paused
 *     (about 1,800 timers and cleanups an hour); it is watched again on play
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
        buffered: { length: 1, start: () => 0, end: () => 47 },
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
            : createEventTarget({ classList: { add() {}, remove() {} }, style: {}, appendChild() {} })
});

const { WebOSPlayer } = await import('../src/player/core/WebOSPlayer.js');

/** A started item whose element is seeking at 20:00, paused */
function pausedSeek() {
    const events = [];
    const player = new WebOSPlayer({
        container: { clientWidth: 1920, clientHeight: 1080, style: {}, appendChild() {} },
        onEvent: (e) => events.push(e)
    });
    const video = player._ensureVideoElement();
    player._currentPlayOptions = { url: 'http://srv/Videos/a/stream.mkv' };
    player._started = true;
    video.currentTime = 1200;
    video.seeking = true;
    video.fire('seeking');
    return { player, video, stuck: () => events.filter((e) => e.type === 'seekstuck') };
}

test('WebOSPlayer: a session timer that fired leaves no cleanup behind', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const player = new WebOSPlayer({ container: { style: {}, appendChild() {} }, onEvent: () => {} });
    const before = player._sessionCleanups.length;

    let fired = 0;
    for (let i = 0; i < 100; i++) player._timer(() => fired++, 1000);
    assert.strictEqual(player._sessionCleanups.length, before + 100);
    t.mock.timers.tick(1000);
    assert.strictEqual(fired, 100);
    assert.strictEqual(player._sessionCleanups.length, before);

    // A pending timer is still cleared when the session ends
    player._timer(() => fired++, 1000);
    player.stop();
    t.mock.timers.tick(1000);
    assert.strictEqual(fired, 100);
});

test('WebOSPlayer: a session listener removed early leaves no cleanup behind', () => {
    const player = new WebOSPlayer({ container: { style: {}, appendChild() {} }, onEvent: () => {} });
    const target = createEventTarget({});
    const before = player._sessionCleanups.length;
    let calls = 0;

    for (let i = 0; i < 100; i++) player._listen(target, 'play', () => calls++)();
    assert.strictEqual(player._sessionCleanups.length, before);
    target.fire('play');
    assert.strictEqual(calls, 0);
});

test('WebOSPlayer: an hour paused on a pending seek wakes nothing up and adds no cleanups', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { player, stuck } = pausedSeek();
    const before = player._sessionCleanups.length;
    let scheduled = 0;
    const timer = player._timer.bind(player);
    player._timer = (fn, ms) => {
        scheduled++;
        return timer(fn, ms);
    };

    for (let i = 0; i < 1800; i++) t.mock.timers.tick(2000);

    assert.strictEqual(scheduled, 0, 'the seek watch kept waking up while paused');
    assert.ok(player._sessionCleanups.length <= before, `grew by ${player._sessionCleanups.length - before}`);
    assert.strictEqual(stuck().length, 0, 'counted a paused seek');
});

test('WebOSPlayer: a seek left pending by a pause is watched again once playback starts', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { video, stuck } = pausedSeek();
    for (let i = 0; i < 30; i++) t.mock.timers.tick(2000);

    // Play: the seek still does not complete and no new data arrives
    video.paused = false;
    video.fire('play');
    for (let i = 0; i < 3; i++) t.mock.timers.tick(2000);
    assert.strictEqual(stuck().length, 0, 'gave up on a seek that may still land');
    t.mock.timers.tick(2000);
    assert.deepStrictEqual(
        stuck().map((e) => e.data.targetPositionTicks),
        [12000000000]
    );
});

test('WebOSPlayer: a seek that completes while paused is not watched again on play', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { player, video, stuck } = pausedSeek();
    t.mock.timers.tick(2000);
    video.seeking = false;
    video.fire('seeked');

    video.paused = false;
    video.fire('play');
    for (let i = 0; i < 30; i++) t.mock.timers.tick(2000);
    assert.strictEqual(player._seekWatch, null);
    assert.strictEqual(stuck().length, 0);
});
