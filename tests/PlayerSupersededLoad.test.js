import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

/**
 * ============================================================================
 * Superseded Playback Load Test Suite
 * ============================================================================
 * When stop() (Back, next item) or a newer play() supersedes a load, the
 * backend rejects with a `superseded` error and JellyfinPlayer.play()
 * resolves false. Callers must then drop the request: a restart flow must not
 * arm the remux watchdog for playback the user already stopped, or it
 * restarts a transcode on the stopped player 8 s later. A load that failed
 * because the server sent nothing is not escalated to a transcode either.
 * The JellyfinPlayer methods under test are taken from the source and run on a
 * stub player (the module itself needs a full DOM).
 * ============================================================================
 */

const source = readFileSync(new URL('../src/player/core/JellyfinPlayer.js', import.meta.url), 'utf8').replace(
    /\r\n/g,
    '\n'
);

function extractMethod(signature) {
    const start = source.indexOf(`\n    ${signature}`);
    assert.ok(start !== -1, `method not found: ${signature}`);
    const end = source.indexOf('\n    }\n', start);
    return source.slice(start + 1, end + 6);
}

const playerEventSource = source
    .slice(source.indexOf('export const PlayerEvent = {'), source.indexOf('};', source.indexOf('export const PlayerEvent = {')) + 2)
    .replace('export const', 'const');

function createPlayer({ playResult }) {
    const context = vm.createContext({
        setTimeout: (fn) => setTimeout(fn, 0),
        clearTimeout,
        Promise,
        log: { info() {}, debug() {}, warn() {}, error() {} },
        PlayerSettings: { get: () => undefined }
    });
    const methods = vm.runInContext(
        `${playerEventSource}\n({\n${['_handleBackendEvent(event) {', 'async _playAfterRestartPause(options, pauseMs) {', '_clearResumeAdvanceWait() {']
            .map(extractMethod)
            .join(',\n')}\n})`,
        context
    );
    return Object.assign(Object.create(methods), {
        events: [],
        armedWatchdogs: [],
        _isRestarting: false,
        _isSeeking: false,
        _pendingStartPositionTicks: null,
        _remuxWatchdogActive: false,
        _backendType: 'webos',
        _backend: { stop: async () => {} },
        _currentPlayMethod: 'DirectPlay',
        _playbackMode: 'auto',
        _currentPlayOptions: { itemId: 'item1', startPositionTicks: 0 },
        emit(type) {
            this.events.push(type);
        },
        async stop() {},
        async play() {
            return playResult;
        },
        getCurrentPositionTicks: () => 6000000000,
        _armRemuxStuckWatchdog(ticks) {
            this.armedWatchdogs.push(ticks);
        },
        _clearRemuxStuckWatchdog() {}
    });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test('JellyfinPlayer: a resume restart the user stopped while it loaded arms no remux watchdog', async () => {
    const player = createPlayer({ playResult: false });
    player._handleBackendEvent({ type: 'resumeseekfailed', data: { targetPositionTicks: 6000000000 } });
    await settle();
    assert.deepStrictEqual(player.armedWatchdogs, [], 'watchdog would restart a transcode on the stopped player');
    assert.strictEqual(player._isRestarting, false);
});

test('JellyfinPlayer: a resume restart that starts still arms the remux watchdog', async () => {
    const player = createPlayer({ playResult: undefined });
    player._handleBackendEvent({ type: 'resumeseekfailed', data: { targetPositionTicks: 6000000000 } });
    await settle();
    assert.deepStrictEqual(player.armedWatchdogs, [6000000000]);
});

// ----------------------------------------------------------------------------
// No escalation for a server that sends nothing
// ----------------------------------------------------------------------------

/** A stub player running the real play() up to a failing step. */
function createFailingPlay(failure) {
    const context = vm.createContext({
        setTimeout: (fn) => setTimeout(fn, 0),
        clearTimeout,
        Promise,
        log: { info() {}, debug() {}, warn() {}, error() {} },
        PlayerSettings: { get: () => undefined },
        TizenAVPlayer: class {},
        HtmlVideoPlayer: class {},
        platformInfo: {},
        webCodecsProbe: {},
        buildJellyfinProfile: () => ({ Name: 'stub', DirectPlayProfiles: [] })
    });
    const methods = vm.runInContext(`${playerEventSource}\n({\n${extractMethod('async play(options) {')}\n})`, context);
    const player = Object.assign(Object.create(methods), {
        events: [],
        stopCalls: 0,
        _isRestarting: false,
        _audioRestartInProgress: false,
        _directPlayEscalated: false,
        _backendType: 'webos',
        _backend: { stop: async () => {} },
        _currentPlayMethod: 'DirectPlay',
        _playbackMode: 'auto',
        emit(type) {
            this.events.push(type);
        },
        async stop() {
            this.stopCalls++;
        },
        async _getPlaybackInfo() {
            throw failure;
        }
    });
    return player;
}

test('JellyfinPlayer: a load that received no data is reported, not escalated to a transcode', async () => {
    const noData = Object.assign(new Error('No media data arrived from the server for 30 s'), {
        name: 'PlaybackLoadTimeoutError',
        isNetworkError: true
    });
    const player = createFailingPlay(noData);
    player._currentPlayOptions = { itemId: 'item1' };

    await player.play({ itemId: 'item1' }).catch(() => {});
    await settle();
    assert.strictEqual(player.stopCalls, 0, 'escalated to a transcode the stalled server cannot deliver either');
    assert.ok(player.events.includes('error'));
});
