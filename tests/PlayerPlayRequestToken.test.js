import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

/**
 * ============================================================================
 * JellyfinPlayer Play-Request Token Test Suite
 * ============================================================================
 * play() awaits PlaybackInfo (up to 30 s), chapters, subtitle pre-flight and
 * the backend. stop() (Back, next item), destroy() or a newer play() during
 * one of those awaits replaces the request: it must then stop without
 * touching the player state, loading the backend, reporting a start or an
 * error, or escalating. Restart flows pause between their stop() and play();
 * a stop() during that pause cancels the restart.
 * The JellyfinPlayer methods under test are taken from the source and run on
 * a stub player (the module itself needs a full DOM).
 * ============================================================================
 */

const source = readFileSync(new URL('../src/player/core/JellyfinPlayer.js', import.meta.url), 'utf8').replace(
    /\r\n/g,
    '\n'
);

/** Source of one class method, from its signature to the closing brace at method indentation. */
function extractMethod(signature) {
    const start = source.indexOf(`\n    ${signature}`);
    assert.ok(start !== -1, `method not found: ${signature}`);
    const end = source.indexOf('\n    }\n', start);
    return source.slice(start + 1, end + 6);
}

const playerEventSource = source
    .slice(source.indexOf('export const PlayerEvent = {'), source.indexOf('};', source.indexOf('export const PlayerEvent = {')) + 2)
    .replace('export const', 'const');

const METHODS = [
    'async play(options) {',
    'async stop(options = {}) {',
    'async setMaxBitrate(bitrate) {',
    '_abandonSupersededPlay(stage) {',
    '_clearResumeAdvanceWait() {',
    'async _playAfterRestartPause(options, pauseMs) {'
];

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function playbackInfoFor(itemId) {
    return {
        PlaySessionId: `session-${itemId}`,
        MediaSources: [{ Id: itemId, RunTimeTicks: 72000000000, MediaStreams: [], SupportsDirectPlay: true }]
    };
}

/**
 * A stub player running the real play()/stop(). PlaybackInfo requests wait on
 * `infoRequests[i]` until the test resolves them.
 */
function createPlayer({ backendPlay } = {}) {
    const context = vm.createContext({
        setTimeout,
        clearTimeout,
        Promise,
        Object,
        Number,
        log: { info() {}, debug() {}, warn() {}, error() {} },
        PlayerSettings: { get: () => undefined },
        TizenAVPlayer: class {},
        HtmlVideoPlayer: class {},
        platformInfo: {},
        webCodecsProbe: {},
        buildJellyfinProfile: () => ({ Name: 'stub', DirectPlayProfiles: [] }),
        resolveBestAudioStream: () => null,
        isAudioTrackNativelyPlayable: () => true,
        doesAudioTrackRequireDirectStream: () => false,
        resolveSubtitleStream: () => -1,
        MediaHelper: {
            getPlayMethod: () => 'DirectPlay',
            buildStreamUrl: ({ itemId }) => ({ url: `http://srv/${itemId}`, transcodingOffsetTicks: 0, playerStartPositionTicks: 0 })
        },
        api: { getItem: async () => ({}) }
    });
    const methods = vm.runInContext(
        `${playerEventSource}\n({\n${METHODS.map(extractMethod).join(',\n')}\n})`,
        context
    );

    const infoRequests = [];
    const backendLoads = [];
    const player = Object.assign(Object.create(methods), {
        events: [],
        infoRequests,
        backendLoads,
        _playRequestId: 0,
        _isRestarting: false,
        _audioRestartInProgress: false,
        _directPlayEscalated: false,
        _backendType: 'webos',
        _backend: {
            async play(options) {
                backendLoads.push(options.item.Id);
                if (backendPlay) return backendPlay(options);
            },
            async stop() {}
        },
        _subtitleManager: { setMediaContext() {} },
        _currentPlayMethod: null,
        _playbackMode: 'auto',
        _currentItem: null,
        _currentMediaSource: null,
        _currentPlayOptions: null,
        _isPlaying: false,
        emit(type) {
            this.events.push(type);
        },
        _getPlaybackInfo(options) {
            const request = deferred();
            infoRequests.push({ itemId: options.itemId, ...request });
            return request.promise;
        },
        _resolveForcedRemuxPlayMethod: (ms, method) => method,
        isCurrentMediaHDR: () => false,
        _getBackendAudioTrackListIndex: () => 0,
        async setSubtitleStreamIndex() {},
        _armRemuxStuckWatchdog() {},
        _clearRemuxStuckWatchdog() {},
        getCurrentPositionTicks: () => 0
    });
    return player;
}

function playOptions(itemId) {
    return { itemId, mediaSourceId: itemId, item: { Id: itemId, Chapters: [{}] } };
}

test('JellyfinPlayer: Back while PlaybackInfo loads abandons the request without loading or reporting it', async () => {
    const player = createPlayer();
    const playing = player.play(playOptions('a'));
    await flush();

    await player.stop();
    player.events.length = 0;
    player.infoRequests[0].resolve(playbackInfoFor('a'));

    assert.strictEqual(await playing, false);
    assert.deepStrictEqual(player.backendLoads, [], 'stopped item loaded into the player after Back');
    assert.deepStrictEqual(player.events, [], 'stopped item reported events (chapters, start)');
    assert.strictEqual(player._currentItem, null);
    assert.strictEqual(player._isPlaying, false);
});

test('JellyfinPlayer: a slow PlaybackInfo of a replaced item does not override the newer item', async () => {
    const player = createPlayer();
    const first = player.play(playOptions('a'));
    await flush();
    const second = player.play(playOptions('b'));
    await flush();

    // The newer item's PlaybackInfo answers first
    player.infoRequests[1].resolve(playbackInfoFor('b'));
    assert.notStrictEqual(await second, false);
    player.infoRequests[0].resolve(playbackInfoFor('a'));
    assert.strictEqual(await first, false);

    assert.deepStrictEqual(player.backendLoads, ['b'], 'the replaced item was loaded over the newer one');
    assert.strictEqual(player._currentItem.Id, 'b');
    assert.strictEqual(player._currentMediaSource.Id, 'b');
    assert.deepStrictEqual(player.events.filter((e) => e === 'playbackstart').length, 1);
});

test('JellyfinPlayer: a replaced request that then fails reports no error and is not escalated', async () => {
    const player = createPlayer();
    let stops = 0;
    const realStop = player.stop;
    player.stop = function () {
        stops++;
        return realStop.call(this);
    };
    player._currentPlayOptions = playOptions('a');
    const playing = player.play(playOptions('a'));
    await flush();

    await player.stop();
    player.infoRequests[0].reject(Object.assign(new Error('PlaybackInfo timed out after 30 s'), { name: 'TimeoutError' }));

    assert.strictEqual(await playing, false);
    assert.ok(!player.events.includes('error'), 'error dialog for playback the user already left');
    assert.strictEqual(stops, 1, 'a transcode restart was started after Back');
});

test('JellyfinPlayer: a backend that settles after stop() does not mark the stopped request as playing', async () => {
    // Tizen AVPlay has no load sessions: its play() resolves even after stop()
    const load = deferred();
    const player = createPlayer({ backendPlay: () => load.promise });
    const playing = player.play(playOptions('a'));
    await flush();
    player.infoRequests[0].resolve(playbackInfoFor('a'));
    await flush();
    assert.deepStrictEqual(player.backendLoads, ['a']);

    await player.stop();
    player.events.length = 0;
    load.resolve();

    assert.strictEqual(await playing, false);
    assert.strictEqual(player._isPlaying, false);
    assert.ok(!player.events.includes('playbackstart'), 'start reported for stopped playback');
});

test('JellyfinPlayer: Back during the pause of a restart cancels the restart', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const player = createPlayer();
    player._currentItem = { Id: 'a' };
    player._currentPlayOptions = playOptions('a');

    const restarting = player.setMaxBitrate(8000000);
    await flush();
    await player.stop();
    t.mock.timers.tick(500);
    await restarting;

    assert.deepStrictEqual(player.infoRequests, [], 'restart loaded the old item after Back');
    assert.strictEqual(player._isRestarting, false);
});

test('JellyfinPlayer: a restart without interruption still plays (guard)', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const player = createPlayer();
    player._currentItem = { Id: 'a' };
    player._currentPlayOptions = playOptions('a');

    const restarting = player.setMaxBitrate(8000000);
    await flush();
    t.mock.timers.tick(500);
    await flush();
    assert.strictEqual(player.infoRequests.length, 1);
    player.infoRequests[0].resolve(playbackInfoFor('a'));
    await restarting;

    assert.deepStrictEqual(player.backendLoads, ['a']);
    assert.ok(player.events.includes('playbackstart'));
});
