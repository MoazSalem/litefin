import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * ============================================================================
 * webOS Player: fatal Hls.js media errors have a total cap
 * ============================================================================
 * The 3 s window alone reset a decoder that fails at the same spot forever
 * when each re-buffer took longer than 3 s. Resets are now capped per Hls.js
 * instance, and the count starts over once playback got well past the spot.
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

globalThis.window = { innerWidth: 1920, innerHeight: 1080, screen: { width: 1920, height: 1080 } };
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {}, key: () => null, length: 0 };
globalThis.document = createEventTarget({
    documentElement: { clientWidth: 1920, clientHeight: 1080 },
    body: { appendChild: () => {} },
    createElement: () => createEventTarget({ classList: { add() {}, remove() {} }, style: {}, appendChild() {} })
});

const { WebOSPlayer } = await import('../src/player/core/WebOSPlayer.js');
const { default: Hls } = await import('hls.js');

function createPlayer() {
    return new WebOSPlayer({
        container: { clientWidth: 1920, clientHeight: 1080, style: {}, appendChild() {} },
        onEvent: () => {}
    });
}

/** Hls.js stand-in attached to a media element at 20:00 */
function createFakeHls() {
    const calls = [];
    return {
        calls,
        media: { currentTime: 1200 },
        recoverMediaError: () => calls.push('recoverMediaError'),
        swapAudioCodec: () => calls.push('swapAudioCodec'),
        startLoad: () => calls.push('startLoad')
    };
}

const mediaError = { fatal: true, type: Hls.ErrorTypes.MEDIA_ERROR, details: 'bufferAppendError' };
const resets = (hls) => hls.calls.filter((c) => c === 'recoverMediaError').length;

test('WebOSPlayer: a decoder that fails at the same spot after every slow re-buffer is reset 3 times, then reported', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 100000 });
    const hls = createFakeHls();
    const failures = [];
    const { onError } = createPlayer()._createHlsErrorHandler(hls, (err) => failures.push(err));

    // Each re-buffer takes 5 s, longer than the 3 s window, and playback barely moves
    for (const position of [1200, 1201.5, 1199.8]) {
        hls.media.currentTime = position;
        onError('hlsError', mediaError);
        t.mock.timers.tick(5000);
    }
    assert.strictEqual(resets(hls), 3);
    assert.strictEqual(failures.length, 0);

    hls.media.currentTime = 1202;
    onError('hlsError', mediaError);
    assert.strictEqual(resets(hls), 3, 'decoder reset again');
    assert.strictEqual(failures.length, 1, 'a decoder that keeps failing must be reported');
    assert.strictEqual(failures[0].code, 3);
});

test('WebOSPlayer: decoder resets count again once playback got 30 s past every earlier one', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 100000 });
    const hls = createFakeHls();
    const failures = [];
    const { onError } = createPlayer()._createHlsErrorHandler(hls, (err) => failures.push(err));

    for (let i = 0; i < 3; i++) {
        onError('hlsError', mediaError);
        t.mock.timers.tick(5000);
    }
    // A minute of playback later, another fault further on
    t.mock.timers.tick(60000);
    hls.media.currentTime = 1260;
    onError('hlsError', mediaError);

    assert.strictEqual(resets(hls), 4);
    assert.strictEqual(failures.length, 0, 'a new fault after a minute of playback was not recovered');
});

test('WebOSPlayer: <video> errors during Hls.js playback count toward the same cap', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 100000 });
    const player = createPlayer();
    const hls = createFakeHls();
    const failures = [];
    const { onError } = player._createHlsErrorHandler(hls, (err) => failures.push(err));
    player._hlsPlayer = hls;
    player._hlsElementErrorHandler = { hls, onError };
    const video = createEventTarget({ src: 'blob:hls', error: { code: 3, message: 'PIPELINE_ERROR_DECODE' } });
    video.addEventListener('error', (e) => player._onError(e));

    for (let i = 0; i < 3; i++) {
        video.fire('error');
        t.mock.timers.tick(5000);
    }
    onError('hlsError', mediaError);

    assert.strictEqual(resets(hls), 3);
    assert.strictEqual(failures.length, 1);
});

test('WebOSPlayer: a media error while the element reloads does not renew the reset budget', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 100000 });
    const hls = createFakeHls();
    const failures = [];
    const { onError } = createPlayer()._createHlsErrorHandler(hls, (err) => failures.push(err));

    // The playhead is at 0 until Hls.js puts it back after a reset
    for (const position of [600, 603, 0, 604]) {
        hls.media.currentTime = position;
        onError('hlsError', mediaError);
        t.mock.timers.tick(3500);
    }
    assert.strictEqual(resets(hls), 3);
    assert.strictEqual(failures.length, 1, 'the same fault got three more resets');
});

test('WebOSPlayer: a fault at 20:00 that also fails during each reload is reported', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 100000 });
    const hls = createFakeHls();
    const failures = [];
    const { onError } = createPlayer()._createHlsErrorHandler(hls, (err) => failures.push(err));

    for (let cycle = 0; cycle < 10 && failures.length === 0; cycle++) {
        hls.media.currentTime = 1200; // the bad spot
        onError('hlsError', mediaError);
        t.mock.timers.tick(1000);
        hls.media.currentTime = 0; // the element reloading after the reset
        onError('hlsError', mediaError);
        t.mock.timers.tick(5000);
    }
    assert.strictEqual(failures.length, 1, `reset ${resets(hls)} times and never reported`);
});
