import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

/**
 * ============================================================================
 * Audio Track Switch Restart Test Suite
 * ============================================================================
 * webOS does not fill video.audioTracks for progressive MKV/MP4 direct play.
 * A non-default track then fails to switch (audiotrackswitchfailed) and
 * playback restarts as a remux. Once that happened for a container, later
 * non-default tracks of that container go to the remux directly, and the
 * restart itself starts without a fixed pause (the stopped direct-play
 * session has no server transcode to wind down, and the backends' stop() is
 * synchronous).
 * The functions under test are taken from the source and run on stubs (the
 * module itself needs a full DOM).
 * ============================================================================
 */

const source = readFileSync(new URL('../src/player/core/JellyfinPlayer.js', import.meta.url), 'utf8').replace(
    /\r\n/g,
    '\n'
);

// The DirectPlay container helpers moved to StreamUtils.js in the
// DetailsPage decoupling refactor, so their declarations are sliced from there.
const streamUtilsSource = readFileSync(new URL('../src/player/core/StreamUtils.js', import.meta.url), 'utf8').replace(
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

/** Source of one module-level declaration in StreamUtils.js, up to its closing brace at column 0. */
function extractTopLevel(signature) {
    const start = streamUtilsSource.indexOf(`\n${signature}`);
    assert.ok(start !== -1, `declaration not found: ${signature}`);
    const end = streamUtilsSource.indexOf('\n}\n', start);
    return streamUtilsSource.slice(start + 1, end + 3).replace(/^export /, '');
}

const playerEventSource = source
    .slice(source.indexOf('export const PlayerEvent = {'), source.indexOf('};', source.indexOf('export const PlayerEvent = {')) + 2)
    .replace('export const', 'const');

const flush = () => new Promise((resolve) => setImmediate(resolve));

function createContext() {
    const context = vm.createContext({
        setTimeout,
        clearTimeout,
        Promise,
        log: { info() {}, debug() {}, warn() {}, error() {} },
        PlayerSettings: { get: () => undefined },
        isAudioTrackNativelyPlayable: () => true
    });
    const storeMatch = streamUtilsSource.match(/\nconst containersWithoutAudioTracks = [^;]+;/);
    assert.ok(storeMatch, 'container memory not found');
    return vm.runInContext(
        `${playerEventSource}
${storeMatch[0]}
${extractTopLevel('function audioTrackContainerKey(')}
${extractTopLevel('export function rememberContainerWithoutAudioTracks(')}
${extractTopLevel('export function hasContainerWithoutAudioTracks(')}
${extractTopLevel('export function doesAudioTrackRequireDirectStream(')}
({
    doesAudioTrackRequireDirectStream,
    methods: {
${['_handleBackendEvent(event) {', 'async _playAfterRestartPause(options, pauseMs) {'].map(extractMethod).join(',\n')}
    }
})`,
        context
    );
}

function mediaSource(container) {
    return {
        Id: 'source',
        Container: container,
        MediaStreams: [
            { Type: 'Video', Index: 0, Codec: 'hevc' },
            { Type: 'Audio', Index: 1, Codec: 'eac3', IsDefault: true },
            { Type: 'Audio', Index: 2, Codec: 'ac3', IsDefault: false }
        ]
    };
}

function createPlayer(methods, ms) {
    return Object.assign(Object.create(methods), {
        events: [],
        playCalls: [],
        _isRestarting: false,
        _audioRestartInProgress: false,
        _backendType: 'webos',
        _currentPlayMethod: 'DirectPlay',
        _playbackMode: 'auto',
        _currentMediaSource: ms,
        _currentAudioStreamIndex: 2,
        _currentPlayOptions: { itemId: 'item1', mediaSourceId: 'source', startPositionTicks: 0 },
        emit(type) {
            this.events.push(type);
        },
        async stop() {},
        async play(options) {
            this.playCalls.push(options);
        },
        getCurrentPositionTicks: () => 6000000000
    });
}

test('JellyfinPlayer: after a failed native track switch, later non-default tracks of that container go to the remux directly', async () => {
    const { doesAudioTrackRequireDirectStream, methods } = createContext();
    const mkv = mediaSource('mkv');

    assert.strictEqual(doesAudioTrackRequireDirectStream(mkv, 2, 'webos'), false);

    const player = createPlayer(methods, mkv);
    player._handleBackendEvent({ type: 'audiotrackswitchfailed', data: { listIndex: 1 } });
    await flush();

    assert.strictEqual(doesAudioTrackRequireDirectStream(mediaSource('mkv'), 2, 'webos'), true, 'direct play loaded again first');
    assert.strictEqual(doesAudioTrackRequireDirectStream(mediaSource('mkv'), 1, 'webos'), false, 'the default track still direct plays');
    assert.strictEqual(doesAudioTrackRequireDirectStream(mediaSource('mp4'), 2, 'webos'), false, 'other containers unaffected');
    assert.strictEqual(doesAudioTrackRequireDirectStream(mediaSource('mkv'), 2, 'html5'), false, 'other backends unaffected');
});

test('JellyfinPlayer: a failed track switch in a remux session is not remembered for direct play', async () => {
    const { doesAudioTrackRequireDirectStream, methods } = createContext();
    const player = createPlayer(methods, mediaSource('mkv'));
    player._currentPlayMethod = 'Remux';

    player._handleBackendEvent({ type: 'audiotrackswitchfailed', data: { listIndex: 1 } });
    await flush();
    assert.strictEqual(doesAudioTrackRequireDirectStream(mediaSource('mkv'), 2, 'webos'), false);
});

test('JellyfinPlayer: the restart after a failed native track switch starts without a fixed pause', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { methods } = createContext();
    const player = createPlayer(methods, mediaSource('mkv'));

    player._handleBackendEvent({ type: 'audiotrackswitchfailed', data: { listIndex: 1 } });
    await flush();

    assert.strictEqual(player.playCalls.length, 1, 'restart waited on a timer');
    assert.strictEqual(player.playCalls[0].playbackMode, 'remux');
    assert.strictEqual(player.playCalls[0].audioStreamIndex, 2);
    await flush();
    assert.strictEqual(player._isRestarting, false);
});
