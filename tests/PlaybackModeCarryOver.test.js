import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

/**
 * ============================================================================
 * Playback Mode Carry-Over Test Suite
 * ============================================================================
 * When the selected audio track can't be played directly (e.g. DTS:X 7.1),
 * play() switches that item to remux. PlayerPage passes
 * getPlaybackMode() to every next item so that a mode the user picked
 * carries over, and that also carried the automatic remux: after one such
 * item, every later item in the session was remuxed by the server (on an
 * LG C4, an MP4 the TV plays directly went through a server remux). The
 * automatic remux must stay with its item; a mode the user picks must
 * still carry over.
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
    '_abandonSupersededPlay(stage) {',
    '_clearResumeAdvanceWait() {',
    'getPlaybackMode() {',
    'async setPlaybackMode(mode) {'
];

/** Items whose audio track the stub reports as needing a server remux. */
const NEEDS_REMUX = new Set(['dtsx']);

function createPlayer() {
    // Playback mode of each device profile play() built
    const profileModes = [];
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
        buildJellyfinProfile: ({ playbackMode }) => {
            profileModes.push(playbackMode);
            return { Name: 'stub', DirectPlayProfiles: [] };
        },
        resolveBestAudioStream: () => null,
        isAudioTrackNativelyPlayable: () => true,
        doesAudioTrackRequireDirectStream: (mediaSource) => NEEDS_REMUX.has(mediaSource.Id),
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

    return Object.assign(Object.create(methods), {
        profileModes,
        _playRequestId: 0,
        _isRestarting: false,
        _audioRestartInProgress: false,
        _directPlayEscalated: false,
        _backendType: 'webos',
        _backend: {
            async play() {},
            async stop() {}
        },
        _subtitleManager: { setMediaContext() {} },
        _currentPlayMethod: null,
        _playbackMode: 'auto',
        _userPlaybackMode: 'auto',
        _currentItem: null,
        _currentMediaSource: null,
        _currentPlayOptions: null,
        _isPlaying: false,
        emit() {},
        async _getPlaybackInfo(options) {
            return {
                PlaySessionId: `session-${options.itemId}`,
                MediaSources: [{ Id: options.itemId, RunTimeTicks: 600000000, MediaStreams: [], SupportsDirectPlay: true }]
            };
        },
        _resolveForcedRemuxPlayMethod: (ms, method) => method,
        isCurrentMediaHDR: () => false,
        _getBackendAudioTrackListIndex: () => 0,
        async setSubtitleStreamIndex() {},
        _armRemuxStuckWatchdog() {},
        _clearRemuxStuckWatchdog() {},
        getCurrentPositionTicks: () => 0
    });
}

/** Play options as PlayerPage._startPlayback() builds them for a new item. */
function pageOptions(player, itemId) {
    const options = {
        itemId,
        mediaSourceId: itemId,
        audioStreamIndex: 1,
        item: {
            Id: itemId,
            Chapters: [{}],
            MediaSources: [{ Id: itemId, MediaStreams: [{ Index: 1, Type: 'Audio', Codec: 'dts', IsDefault: true }] }]
        }
    };
    const storedMode = player.getPlaybackMode();
    if (storedMode && storedMode !== 'auto') {
        options.playbackMode = storedMode;
    }
    return options;
}

test('JellyfinPlayer: an item remuxed for its audio track does not remux the next item', async () => {
    const player = createPlayer();

    await player.play(pageOptions(player, 'dtsx'));
    assert.strictEqual(player._playbackMode, 'remux', 'the item itself is remuxed for its audio');
    assert.strictEqual(player.getPlaybackMode(), 'auto');

    await player.play(pageOptions(player, 'mp4'));
    assert.strictEqual(player._playbackMode, 'auto', 'the next item inherited the automatic remux');
    assert.deepStrictEqual(player.profileModes, ['remux', 'auto']);
});

test('JellyfinPlayer: a remux picked by the user carries over to the next item (guard)', async () => {
    const player = createPlayer();
    await player.setPlaybackMode('remux');

    await player.play(pageOptions(player, 'mp4'));
    await player.play(pageOptions(player, 'mp4-2'));
    assert.strictEqual(player.getPlaybackMode(), 'remux');
    assert.deepStrictEqual(player.profileModes, ['remux', 'remux']);
});

test('JellyfinPlayer: picking Remux on an item already remuxed for its audio keeps it for the next item', async () => {
    const player = createPlayer();
    await player.play(pageOptions(player, 'dtsx'));

    // The Playback Mode menu showed Auto; the user picks Remux
    await player.setPlaybackMode('remux');
    assert.strictEqual(player.getPlaybackMode(), 'remux');

    await player.play(pageOptions(player, 'mp4'));
    assert.strictEqual(player._playbackMode, 'remux');
});

test('JellyfinPlayer: a restart of the remuxed item still reports the user mode', async () => {
    const player = createPlayer();
    await player.play(pageOptions(player, 'dtsx'));

    // Restarts (bitrate, burn-in, ...) pass the item's current mode
    player._isRestarting = true;
    await player.play({ ...pageOptions(player, 'dtsx'), playbackMode: player._playbackMode });
    player._isRestarting = false;

    assert.strictEqual(player._playbackMode, 'remux');
    assert.strictEqual(player.getPlaybackMode(), 'auto');
});
