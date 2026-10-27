import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * ============================================================================
 * webOS Player: the Hls.js fallback after a native HLS error mid-playback
 * ============================================================================
 *   - it continues at the current position, not at the item's start position
 *     (a live channel starts at the live edge)
 *   - cancelled by stop() or a newer play(), it reports no error
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

const { WebOSPlayer } = await import('../src/player/core/WebOSPlayer.js');

const flush = () => new Promise((resolve) => globalThis.setImmediate(resolve));

const mediaSource = {
    MediaStreams: [
        { Index: 0, Type: 'Video', Codec: 'h264' },
        { Index: 1, Type: 'Audio', Codec: 'aac', IsDefault: true }
    ]
};

/**
 * A native HLS item resumed at 5:00 that has been playing, with the Hls.js
 * start stubbed: like the real one, it is rejected when the session ends.
 */
function playingNativeHls(extraOptions = {}) {
    const events = [];
    const player = new WebOSPlayer({
        container: { clientWidth: 1920, clientHeight: 1080, style: {}, appendChild() {} },
        onEvent: (e) => events.push(e.type)
    });
    const video = player._ensureVideoElement();
    const options = {
        url: 'http://srv/videos/x/master.m3u8',
        isHls: true,
        mediaSource,
        playerStartPositionTicks: 3000000000,
        ...extraOptions
    };
    player._currentPlayOptions = options;
    player._isHls = true;
    player._started = true;
    player._canUseHlsJs = () => true; // as on a TV with MSE
    const fallbacks = [];
    player._playWithHlsJs = (v, opts) => {
        fallbacks.push(opts);
        return player._sessionPromise(() => {});
    };
    const source = document.createElement('source');
    source.src = options.url;
    video.appendChild(source);
    return { player, events, video, options, fallbacks };
}

function decodeError(video) {
    video.error = { code: 3, message: 'PIPELINE_ERROR_DECODE' };
    video.fire('error');
}

test('WebOSPlayer: the Hls.js fallback after a decode error at 40:00 continues at 40:00', () => {
    const { video, options, fallbacks } = playingNativeHls();
    video.currentTime = 2400;
    decodeError(video);

    assert.strictEqual(fallbacks.length, 1);
    assert.strictEqual(fallbacks[0].playerStartPositionTicks, 24000000000, 'jumped back to the resume point');
    assert.strictEqual(fallbacks[0].url, options.url);
    assert.strictEqual(options.playerStartPositionTicks, 3000000000, 'the item options were changed');
});

test('WebOSPlayer: the Hls.js fallback keeps the transcoding offset the options carry', () => {
    const { video, fallbacks } = playingNativeHls({ transcodingOffsetTicks: 6000000000 });
    video.currentTime = 100; // stream time: 100 s after the 10:00 offset
    decodeError(video);

    assert.strictEqual(fallbacks[0].playerStartPositionTicks, 1000000000);
    assert.strictEqual(fallbacks[0].transcodingOffsetTicks, 6000000000);
});

test('WebOSPlayer: before the first frame, the Hls.js fallback keeps the start position', () => {
    const { player, video, fallbacks } = playingNativeHls();
    player._started = false;
    video.currentTime = 0; // the resume seek has not landed yet
    decodeError(video);

    assert.strictEqual(fallbacks[0].playerStartPositionTicks, 3000000000);
});

test('WebOSPlayer: the Hls.js fallback of a live channel starts at the live edge', () => {
    for (const live of [{ item: { Type: 'TvChannel' } }, { mediaSource: { ...mediaSource, LiveStreamId: 'abc' } }]) {
        const { video, options, fallbacks } = playingNativeHls({ playerStartPositionTicks: 0, ...live });
        video.currentTime = 600; // ten minutes into the channel
        decodeError(video);

        assert.ok(!fallbacks[0].playerStartPositionTicks, 'started at the elapsed time instead of the live edge');
        assert.strictEqual(fallbacks[0], options);
    }
});

test('WebOSPlayer: an Hls.js fallback cancelled by stop() reports no error', async () => {
    const { player, events, video } = playingNativeHls();
    video.currentTime = 2400;
    decodeError(video);

    const before = events.length;
    await player.stop();
    await flush();
    assert.deepStrictEqual(events.slice(before), [], 'an error after stop() makes JellyfinPlayer escalate the item');
});

test('WebOSPlayer: a failed Hls.js fallback is still reported', async () => {
    const { player, events, video } = playingNativeHls();
    player._playWithHlsJs = () => Promise.reject(Object.assign(new Error('Hls.js media error'), { code: 3 }));
    video.currentTime = 2400;
    decodeError(video);
    await flush();

    assert.deepStrictEqual(events, ['error']);
});
