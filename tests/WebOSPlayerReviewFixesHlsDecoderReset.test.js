import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * ============================================================================
 * webOS Player: a decoder reset during an Hls.js start
 * ============================================================================
 * A fatal Hls.js media error while the start's video.play() is pending gets
 * a decoder reset. In hls.js 1.7 recoverMediaError() reloads the element,
 * which rejects that play() with a DOM AbortError: JellyfinPlayer took that
 * for a cancel. The start now waits for Hls.js to buffer again, and fails
 * with a decode error when playback does not follow.
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

const abortError = () =>
    Object.assign(new Error('The play() request was interrupted by a new load request.'), { name: 'AbortError' });

/** <video> stand-in whose play() stays pending until startPlaying(), and whose load() aborts it */
function createVideo() {
    const pendingPlays = [];
    return createEventTarget({
        children: [],
        style: {},
        audioTracks: [],
        textTracks: [],
        readyState: 0,
        currentTime: 0,
        duration: 3600,
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
            this.children.push(child);
        },
        removeChild(child) {
            this.children = this.children.filter((c) => c !== child);
        },
        load() {
            this.paused = true;
            pendingPlays.splice(0).forEach(({ reject }) => reject(abortError()));
        },
        pause() {
            this.paused = true;
        },
        play() {
            this.playCalls++;
            this.paused = false;
            return new Promise((resolve, reject) => pendingPlays.push({ resolve, reject }));
        },
        startPlaying() {
            pendingPlays.splice(0).forEach(({ resolve }) => resolve());
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
const { default: Hls } = await import('hls.js');

const flush = () => new Promise((resolve) => globalThis.setImmediate(resolve));

const hlsOptions = {
    url: 'http://srv/videos/x/master.m3u8',
    isHls: true,
    mediaSource: {
        MediaStreams: [
            { Index: 0, Type: 'Video', Codec: 'h264' },
            { Index: 1, Type: 'Audio', Codec: 'aac', IsDefault: true }
        ]
    }
};
const mediaError = { fatal: true, type: Hls.ErrorTypes.MEDIA_ERROR, details: 'bufferAppendError' };

/**
 * The real Hls.js class with loading stubbed out; the player's own listeners
 * are kept apart (hls.js registers its controllers with a context), and
 * recoverMediaError() detaches and reloads the element as hls.js 1.7 does.
 */
function stubHls(t) {
    const proto = Hls.prototype;
    const original = { on: proto.on, once: proto.once, off: proto.off };
    const playerListeners = {};
    const calls = [];
    let media = null;
    const fire = (event, data = {}) => (playerListeners[event] || []).slice().forEach((l) => l(event, data));
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
        loadSource() {},
        attachMedia(element) {
            media = element;
        },
        recoverMediaError() {
            calls.push('recoverMediaError');
            fire(Hls.Events.MEDIA_DETACHING);
            media.removeAttribute('src');
            media.load();
        },
        destroy() {
            calls.push('destroy');
        }
    };
    for (const [name, stub] of Object.entries(stubs)) t.mock.method(proto, name, stub);
    return { calls, fire };
}

/** An Hls.js start whose first segment is buffered and whose play() is pending */
function startPending(t) {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const hls = stubHls(t);
    const player = new WebOSPlayer({
        container: { clientWidth: 1920, clientHeight: 1080, style: {}, appendChild() {} },
        onEvent: () => {}
    });
    const video = player._ensureVideoElement();
    const result = { outcome: 'pending' };
    player._playWithHlsJs(video, hlsOptions).then(
        () => (result.outcome = 'resolved'),
        (err) => (result.outcome = err)
    );
    hls.fire(Hls.Events.MANIFEST_PARSED);
    hls.fire(Hls.Events.BUFFER_APPENDED);
    assert.strictEqual(video.playCalls, 1, 'sanity: the buffer gate started playback');
    return { hls, player, video, result };
}

test('WebOSPlayer: a decoder reset during an Hls.js start does not end it; playback starts once Hls.js buffered again', async (t) => {
    const { hls, video, result } = startPending(t);

    hls.fire(Hls.Events.ERROR, mediaError); // the player resets the decoder
    await flush();
    assert.deepStrictEqual(hls.calls, ['recoverMediaError']);
    assert.strictEqual(result.outcome, 'pending', `the start ended: ${result.outcome?.name}`);

    hls.fire(Hls.Events.BUFFER_APPENDED);
    assert.strictEqual(video.playCalls, 2, 'not started again after the reset');
    video.startPlaying();
    await flush();
    assert.strictEqual(result.outcome, 'resolved');
});

test('WebOSPlayer: no playback 10 s after a decoder reset during the start fails as a decode error', async (t) => {
    const { hls, result } = startPending(t);
    hls.fire(Hls.Events.ERROR, mediaError);
    await flush();

    t.mock.timers.tick(9999);
    await flush();
    assert.strictEqual(result.outcome, 'pending');
    t.mock.timers.tick(1);
    await flush();
    assert.ok(result.outcome instanceof Error);
    assert.notStrictEqual(result.outcome.name, 'AbortError', 'JellyfinPlayer takes an AbortError for a cancel');
    assert.strictEqual(result.outcome.code, 3);
    assert.ok(hls.calls.includes('destroy'));
});

test('WebOSPlayer: an AbortError without a decoder reset still ends the Hls.js start', async (t) => {
    const { video, result } = startPending(t);
    video.load(); // a reload that is not Hls.js's

    await flush();
    assert.strictEqual(result.outcome?.name, 'AbortError');
});
