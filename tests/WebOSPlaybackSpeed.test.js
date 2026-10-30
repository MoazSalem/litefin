import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers';

const documentTarget = { addEventListener() {}, removeEventListener() {} };

globalThis.window = { innerWidth: 1920, innerHeight: 1080, screen: { width: 1920, height: 1080 } };
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {}, key: () => null, length: 0 };
globalThis.document = Object.assign(documentTarget, {
    documentElement: { clientWidth: 1920, clientHeight: 1080 },
    body: { appendChild: () => {} },
    createElement: () => ({ classList: { add() {}, remove() {}, toggle() {} }, style: {}, canPlayType: () => '' })
});

const { WebOSPlayer } = await import('../src/player/core/WebOSPlayer.js');

const flush = () => new Promise((resolve) => setImmediate(resolve));

function createPlayer(t) {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    globalThis.window.PalmServiceBridge = class {};
    t.after(() => delete globalThis.window.PalmServiceBridge);

    const events = [];
    const player = new WebOSPlayer({ container: { style: {} }, onEvent: (e) => events.push(e) });
    const video = { playbackRate: 1, mediaId: undefined };
    player._videoElement = video;

    const calls = [];
    let reply = { returnValue: true };
    player._callLuna = async (uri, params) => {
        calls.push({ uri, params });
        return reply;
    };

    const tick = async (times = 1) => {
        for (let i = 0; i < times; i++) {
            t.mock.timers.tick(500);
            await flush();
        }
    };
    return { player, video, events, calls, tick, setReply: (r) => (reply = r) };
}

test('WebOSPlayer: the rate goes to the media service and the element stays at 1x', async (t) => {
    const { player, video, events, calls } = createPlayer(t);
    video.mediaId = 'media1';

    player.setSpeed(1.5);
    await flush();

    assert.deepEqual(calls, [
        { uri: 'luna://com.webos.media/setPlayRate', params: { mediaId: 'media1', playRate: 1.5, audioOutput: true } }
    ]);
    assert.equal(video.playbackRate, 1);
    assert.deepEqual(events, []);

    player.setSpeed(1);
    await flush();
    assert.equal(calls[1].params.playRate, 1);
    assert.equal(video.playbackRate, 1);
});

test('WebOSPlayer: a missing mediaId is retried until it appears', async (t) => {
    const { player, video, calls, tick } = createPlayer(t);

    player.setSpeed(2);
    await flush();
    await tick(5);
    assert.equal(calls.length, 0);

    video.mediaId = 'media2';
    await tick();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].params.playRate, 2);
    assert.equal(video.playbackRate, 1);
});

test('WebOSPlayer: a late mediaId keeps its rejection retries', async (t) => {
    const { player, video, events, calls, tick, setReply } = createPlayer(t);

    player.setSpeed(2);
    await flush();
    await tick(18);
    assert.equal(calls.length, 0);

    video.mediaId = 'late';
    setReply({ returnValue: false });
    await tick();
    assert.equal(calls.length, 1);
    assert.equal(video.playbackRate, 1, 'one rejection already fell back to the element rate');

    setReply({ returnValue: true });
    await tick();
    assert.equal(calls.length, 2);
    assert.equal(video.playbackRate, 1);
    assert.deepEqual(events, []);
});

test('WebOSPlayer: a TV that keeps rejecting the call plays on the element rate and says so', async (t) => {
    const { player, video, events, calls, tick, setReply } = createPlayer(t);
    video.mediaId = 'media3';
    setReply({ returnValue: false });

    player.setSpeed(2);
    await flush();
    await tick(3);

    assert.equal(calls.length, 4);
    assert.equal(video.playbackRate, 2);
    assert.deepEqual(events, [{ type: 'playratefallback', data: { speed: 2 } }]);
});

test('WebOSPlayer: a rate that snaps back to 1x on the element is not reported as silent', async (t) => {
    const { player, video, events, tick, setReply } = createPlayer(t);
    video.mediaId = 'media4';
    setReply({ returnValue: false });

    player.setSpeed(1.25);
    await flush();
    await tick(3);

    assert.equal(video.playbackRate, 1);
    assert.deepEqual(events, []);
});

test('WebOSPlayer: without the Luna bridge the element rate is used directly', async (t) => {
    const { player, video, events, calls } = createPlayer(t);
    delete globalThis.window.PalmServiceBridge;

    player.setSpeed(2);
    await flush();

    assert.equal(calls.length, 0);
    assert.equal(video.playbackRate, 2);
    assert.deepEqual(events, []);
});

test('PlaybackSpeedMenu: the webOS fallback list matches JellyfinPlayer', async () => {
    const { default: PlaybackSpeedMenu } = await import('../src/player/osd/PlaybackSpeedMenu.js');
    const supported = (speed) =>
        PlaybackSpeedMenu.prototype._isSpeedSupportedFallback.call(
            { osd: { player: { getBackendType: () => 'webos' } } },
            speed
        );
    assert.deepEqual([0.25, 0.5, 0.75, 1, 1.5, 2, 2.5, 4].filter(supported), [0.5, 0.75, 1, 1.5, 2]);
});
