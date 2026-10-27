import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

/**
 * ============================================================================
 * JellyfinPlayer Restart & Escalation Test Suite
 * ============================================================================
 * Restart flows (quality change, track switch, resume fallback, error
 * escalation) share the _isRestarting flag and the DirectPlay → Remux →
 * Transcode ladder. The JellyfinPlayer methods under test are taken from the
 * source and run on a stub player (the module itself needs a full DOM).
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

const playerEventSource = source.slice(
    source.indexOf('export const PlayerEvent = {'),
    source.indexOf('};', source.indexOf('export const PlayerEvent = {')) + 2
).replace('export const', 'const');

const quietLog = { info() {}, debug() {}, warn() {}, error() {} };

/**
 * A stub JellyfinPlayer with the given real methods.
 * play() / stop() are recorded unless 'async play(options) {' is loaded.
 */
function createPlayer(signatures, { settings = {}, globals = {} } = {}) {
    const context = vm.createContext({
        // Restart flows wait 300–500 ms between stop() and play(); skip that here
        setTimeout: (fn) => setTimeout(fn, 0),
        clearTimeout,
        Promise,
        log: quietLog,
        PlayerSettings: { get: (key) => settings[key] },
        ...globals
    });
    // Restart flows start their play() through this helper
    const loaded = signatures.concat('async _playAfterRestartPause(options, pauseMs) {', '_clearResumeAdvanceWait() {');
    const methods = vm.runInContext(
        `${playerEventSource}\n({ PlayerEvent, methods: {\n${loaded.map(extractMethod).join(',\n')}\n} })`,
        context
    );

    const player = Object.assign(Object.create(methods.methods), {
        PlayerEvent: methods.PlayerEvent,
        events: [],
        playCalls: [],
        _isRestarting: false,
        _audioRestartInProgress: false,
        _isSeeking: false,
        _pendingStartPositionTicks: null,
        _remuxWatchdogActive: false,
        _directPlayEscalated: false,
        _backendType: 'webos',
        _backend: { stop: async () => {} },
        _currentPlayMethod: 'DirectPlay',
        _playbackMode: 'auto',
        _currentPlayOptions: { itemId: 'item1', startPositionTicks: 0 },
        _lastPlayOptions: null,
        armedWatchdogs: [],
        emit(type, data) {
            this.events.push(type);
        },
        async stop() {},
        getCurrentPositionTicks: () => 6000000000,
        _armRemuxStuckWatchdog(ticks) {
            this.armedWatchdogs.push(ticks);
        },
        _clearRemuxStuckWatchdog() {}
    });
    if (!signatures.includes('async play(options) {')) {
        player.play = async function (options) {
            this.playCalls.push(options);
        };
    }
    return player;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

// ----------------------------------------------------------------------------
// C1 — quality change
// ----------------------------------------------------------------------------

test('JellyfinPlayer: a quality change does not leave the player in the restarting state', async () => {
    const player = createPlayer(['async setMaxBitrate(bitrate) {', '_handleBackendEvent(event) {']);
    player._currentItem = { Id: 'item1' };

    await player.setMaxBitrate(8000000);
    assert.strictEqual(player._isRestarting, false);
    assert.strictEqual(player.playCalls.length, 1);

    // A later direct-play error still escalates to a transcode
    player._handleBackendEvent({ type: 'error', data: { code: 3, message: 'MEDIA_ERR_DECODE' } });
    await settle();
    assert.strictEqual(player.playCalls.length, 2, 'error after a quality change was not escalated');
    assert.strictEqual(player.playCalls[1].playbackMode, 'transcode');
});

test('JellyfinPlayer: a failed quality change also clears the restarting state', async () => {
    const player = createPlayer(['async setMaxBitrate(bitrate) {']);
    player._currentItem = { Id: 'item1' };
    player.play = async () => {
        throw new Error('PlaybackInfo failed: 500');
    };

    await player.setMaxBitrate(8000000);
    assert.strictEqual(player._isRestarting, false);
});

// ----------------------------------------------------------------------------
// C2 — resume failure ladder
// ----------------------------------------------------------------------------

function resumeFailed(player) {
    player._handleBackendEvent({ type: 'resumeseekfailed', data: { targetPositionTicks: 6000000000 } });
}

test('JellyfinPlayer: a failed direct-play resume restarts as a remux and arms the watchdog', async () => {
    const player = createPlayer(['_handleBackendEvent(event) {']);
    resumeFailed(player);
    await settle();
    assert.strictEqual(player.playCalls[0].playbackMode, 'remux');
    assert.deepStrictEqual(player.armedWatchdogs, [6000000000]);
});

test('JellyfinPlayer: a failed remux resume escalates to a transcode', async () => {
    const player = createPlayer(['_handleBackendEvent(event) {']);
    player._currentPlayMethod = 'Remux';
    resumeFailed(player);
    await settle();
    assert.strictEqual(player.playCalls[0].playbackMode, 'transcode');
    assert.deepStrictEqual(player.armedWatchdogs, []);
});

test('JellyfinPlayer: the one-retry limit of a transcoded resume does not leak into later restarts', async () => {
    const player = createPlayer(['_handleBackendEvent(event) {']);
    player._currentPlayMethod = 'Transcode';
    resumeFailed(player);
    await settle();
    assert.strictEqual(player.playCalls.length, 1);

    // A later restart of the item (e.g. a quality change) builds new options from the retried ones
    player._currentPlayOptions = { ...player.playCalls[0], startPositionTicks: 9000000000 };
    resumeFailed(player);
    await settle();
    assert.strictEqual(player.playCalls.length, 2, 'the retry limit blocked a later restart for good');
});

test('JellyfinPlayer: a failed transcode resume never restarts as a remux, and retries only once', async () => {
    const player = createPlayer(['_handleBackendEvent(event) {']);
    player._currentPlayMethod = 'Transcode';
    resumeFailed(player);
    await settle();
    assert.strictEqual(player.playCalls.length, 1);
    assert.strictEqual(player.playCalls[0].playbackMode, 'transcode');
    assert.deepStrictEqual(player.armedWatchdogs, []);

    // The retried transcode fails to land as well: keep playing, no loop
    player._currentPlayOptions = player.playCalls[0];
    resumeFailed(player);
    await settle();
    assert.strictEqual(player.playCalls.length, 1);
});

// ----------------------------------------------------------------------------
// C3 — errors during restarts
// ----------------------------------------------------------------------------

/** A stub player running the real play() up to a failing PlaybackInfo request. */
function createPlayingPlayer(failure) {
    const player = createPlayer(['async play(options) {', '_handleBackendEvent(event) {'], {
        globals: {
            TizenAVPlayer: class {},
            HtmlVideoPlayer: class {},
            platformInfo: {},
            webCodecsProbe: {},
            buildJellyfinProfile: () => ({ Name: 'stub', DirectPlayProfiles: [] })
        }
    });
    player._getPlaybackInfo = async () => {
        throw failure;
    };
    player.stopCalls = 0;
    player.stop = async function () {
        this.stopCalls++;
    };
    return player;
}

test('JellyfinPlayer: a failed subtitle burn-in restart clears the restarting state', async () => {
    const player = createPlayer(['async setSubtitleStreamIndex(index) {'], {
        settings: { subtitleBurnIn: 'all' },
        globals: { prewarmManager: { invalidateCache() {} } }
    });
    player._currentSubtitleStreamIndex = -1;
    player.getSubtitleTracks = () => [{ Index: 3, Codec: 'srt' }];
    player.play = async () => {
        throw new Error('Failed to get playback info: 500');
    };

    await player.setSubtitleStreamIndex(3);
    assert.strictEqual(player._isRestarting, false, 'restarting flag stuck: later errors are swallowed');
    assert.strictEqual(player._burnInRestartInProgress, false);
});

test('JellyfinPlayer: a failure while restarting is reported instead of swallowed', async () => {
    const player = createPlayingPlayer(new Error('Failed to get playback info: 500'));
    player._isRestarting = true;
    player._audioRestartInProgress = true;

    await assert.rejects(player.play({ itemId: 'item1', playbackMode: 'remux' }), /500/);
    assert.deepStrictEqual(player.events.filter((e) => e === 'error'), ['error']);
});

test('JellyfinPlayer: an interrupted play() is still a silent cancel, even after the backend is gone', async () => {
    const abort = new Error('The play() request was interrupted by a new load request');
    abort.name = 'AbortError';
    const player = createPlayingPlayer(abort);
    player._backend = null;

    await player.play({ itemId: 'item1' });
    assert.deepStrictEqual(player.events.filter((e) => e === 'error'), []);
    assert.strictEqual(player.stopCalls, 0, 'a cancelled load was escalated to a transcode restart');
});

test('JellyfinPlayer: a failed transcode escalation is reported exactly once', async () => {
    const player = createPlayingPlayer(new Error('Failed to get playback info: 500'));

    // Direct play fails at runtime → escalation restarts in transcode → that fails too
    player._handleBackendEvent({ type: 'error', data: { code: 3, message: 'MEDIA_ERR_DECODE' } });
    await settle();
    await settle();

    assert.strictEqual(player.events.filter((e) => e === 'error').length, 1);
    assert.strictEqual(player._isRestarting, false);
});

// ----------------------------------------------------------------------------
// C4 — forced remux labelling and escalation
// ----------------------------------------------------------------------------

// MediaHelper.getTranscodeStatus, taken from the source like the player methods
const mediaHelperSource = readFileSync(new URL('../src/player/core/MediaHelper.js', import.meta.url), 'utf8').replace(
    /\r\n/g,
    '\n'
);
function extractHelperMethod(signature) {
    const start = mediaHelperSource.indexOf(`\n    ${signature}`);
    assert.ok(start !== -1, `method not found: ${signature}`);
    return mediaHelperSource.slice(start + 1, mediaHelperSource.indexOf('\n    },\n', start) + 6);
}
const MediaHelper = vm.runInNewContext(
    `({${['getTranscodeStatus(mediaSource) {', 'isVideoOverTranscodeLimits(mediaSource) {'].map(extractHelperMethod).join(',\n')}})`
);

const hevcEac3 = [
    { Index: 0, Type: 'Video', Codec: 'hevc' },
    { Index: 1, Type: 'Audio', Codec: 'eac3', IsDefault: true }
];
const remuxSource = (query) => ({ MediaStreams: hevcEac3, TranscodingUrl: `/videos/x/master.m3u8?${query}` });

function resolveRemux(mediaSource) {
    const player = createPlayer(['_resolveForcedRemuxPlayMethod(mediaSource, playMethod) {'], { globals: { MediaHelper } });
    return player._resolveForcedRemuxPlayMethod(mediaSource, 'Transcode');
}

test('JellyfinPlayer: a forced remux without a target video codec is a remux, not a transcode', () => {
    assert.strictEqual(
        resolveRemux(remuxSource('AudioCodec=eac3,aac&AudioStreamIndex=1&TranscodeReasons=ContainerNotSupported,VideoCodecNotSupported')),
        'Remux'
    );
    assert.strictEqual(
        resolveRemux(remuxSource('VideoCodec=&AudioCodec=aac&AudioStreamIndex=1&TranscodeReasons=ContainerNotSupported,VideoCodecNotSupported,AudioCodecNotSupported')),
        'DirectStream'
    );
    assert.strictEqual(resolveRemux(remuxSource('VideoCodec=copy&AudioCodec=eac3&TranscodeReasons=VideoCodecNotSupported')), 'Remux');
    assert.strictEqual(resolveRemux(remuxSource('TranscodeReasons=DirectPlayError')), 'Remux');
});

test('JellyfinPlayer: a forced remux the server re-encodes stays a transcode', () => {
    assert.strictEqual(
        resolveRemux(remuxSource('VideoCodec=h264&AudioCodec=aac&TranscodeReasons=VideoCodecNotSupported')),
        'Transcode'
    );
});

test('JellyfinPlayer: an error in a forced remux escalates to a transcode', async () => {
    const player = createPlayer(['_handleBackendEvent(event) {']);
    player._playbackMode = 'remux';
    player._currentPlayMethod = 'Transcode';

    player._handleBackendEvent({ type: 'error', data: { code: 3, message: 'MEDIA_ERR_DECODE' } });
    await settle();
    assert.strictEqual(player.playCalls[0]?.playbackMode, 'transcode');
});

// ----------------------------------------------------------------------------
// D11 — a seek the backend's pipeline never completes
// ----------------------------------------------------------------------------

function seekStuck(player, ticks = 600000000) {
    player._handleBackendEvent({ type: 'seekstuck', data: { targetPositionTicks: ticks } });
}

test('JellyfinPlayer: a stuck seek reloads the stream at its target in the same mode', async () => {
    const player = createPlayer(['_handleBackendEvent(event) {']);
    player._currentPlayMethod = 'Remux';
    player._playbackMode = 'remux';
    player._currentAudioStreamIndex = 1;
    seekStuck(player);
    await settle();

    assert.strictEqual(player.playCalls.length, 1);
    assert.strictEqual(player.playCalls[0].startPositionTicks, 600000000);
    assert.strictEqual(player.playCalls[0].playbackMode, 'remux');
    assert.strictEqual(player.playCalls[0].audioStreamIndex, 1);
    assert.ok(player.events.includes('restarting'));
    assert.strictEqual(player._isRestarting, false);
    // A reloaded remux that does not start is escalated by the watchdog
    assert.deepStrictEqual(player.armedWatchdogs, [600000000]);
});

test('JellyfinPlayer: a stuck seek in direct play reloads without the remux watchdog', async () => {
    const player = createPlayer(['_handleBackendEvent(event) {']);
    seekStuck(player);
    await settle();
    assert.strictEqual(player.playCalls.length, 1);
    assert.strictEqual(player.playCalls[0].playbackMode, 'auto');
    assert.deepStrictEqual(player.armedWatchdogs, []);
});

test('JellyfinPlayer: a reloaded stream that gets stuck again escalates like a failed resume', async () => {
    const player = createPlayer(['_handleBackendEvent(event) {']);
    player._currentPlayMethod = 'Remux';
    player._playbackMode = 'remux';
    seekStuck(player);
    await settle();
    // play() keeps its options as the current ones
    player._currentPlayOptions = player.playCalls[0];

    seekStuck(player, 900000000);
    await settle();
    assert.strictEqual(player.playCalls.length, 2);
    assert.strictEqual(player.playCalls[1].playbackMode, 'transcode');
    assert.strictEqual(player.playCalls[1].startPositionTicks, 900000000);
});

test('JellyfinPlayer: a stuck seek during a restart or after stop() is ignored', async () => {
    const player = createPlayer(['_handleBackendEvent(event) {']);
    player._isRestarting = true;
    seekStuck(player);
    player._isRestarting = false;
    player._currentPlayOptions = null;
    seekStuck(player);
    await settle();
    assert.strictEqual(player.playCalls.length, 0);
});
