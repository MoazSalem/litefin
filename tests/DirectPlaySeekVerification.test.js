import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('TizenAVPlayer: DirectPlay seek verification guard structure and integration', () => {
    const tizenSource = readFileSync(
        new URL('../src/player/core/TizenAVPlayer.js', import.meta.url),
        'utf8'
    );

    // 1. Verify constructor initializes all guard tracking state
    assert.ok(
        tizenSource.includes('this._directSeekVerifyTimeout = null;'),
        'TizenAVPlayer must initialize _directSeekVerifyTimeout'
    );
    assert.ok(
        tizenSource.includes('this._directSeekTargetSec = null;'),
        'TizenAVPlayer must initialize _directSeekTargetSec'
    );
    assert.ok(
        tizenSource.includes('this._directSeekPositionTicks = null;'),
        'TizenAVPlayer must initialize _directSeekPositionTicks'
    );
    assert.ok(
        tizenSource.includes('this._directSeekStartTime = 0;'),
        'TizenAVPlayer must initialize _directSeekStartTime'
    );

    // 2. Verify helper methods are defined
    assert.ok(
        tizenSource.includes('_verifyDirectPlaySeek(positionTicks)'),
        'TizenAVPlayer must define _verifyDirectPlaySeek'
    );
    assert.ok(
        tizenSource.includes('_clearDirectSeekVerification()'),
        'TizenAVPlayer must define _clearDirectSeekVerification'
    );
    assert.ok(
        tizenSource.includes('_scheduleDirectSeekCheck('),
        'TizenAVPlayer must define _scheduleDirectSeekCheck'
    );
    assert.ok(
        tizenSource.includes('_runDirectSeekCheck()'),
        'TizenAVPlayer must define _runDirectSeekCheck'
    );

    // 3. Verify oncurrentplaytime disarms the verification guard
    assert.ok(
        tizenSource.includes('this._directSeekTargetSec !== null'),
        'oncurrentplaytime must check if a DirectPlay seek verification guard is active'
    );

    // 4. Verify _safeSeekTo tracks seekInProgress and updates presentation time
    assert.ok(
        tizenSource.includes('this._seekInProgress = true;'),
        '_safeSeekTo must assert _seekInProgress = true during hardware execution'
    );
});
// ============================================================================
// Watchdog behaviour on the real TizenAVPlayer
// ============================================================================
// The player is constructed with a stub AVPlay object; timers and Date.now()
// are mocked so the 1.5s first check, the 1s re-checks and the 3.5s settle
// time can be stepped through.
// ============================================================================
globalThis.window = globalThis.window || { innerWidth: 1920, innerHeight: 1080 };
globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.document = globalThis.document || {
    documentElement: {},
    createElement: () => ({}),
    body: { appendChild() {} }
};

const { TizenAVPlayer } = await import('../src/player/core/TizenAVPlayer.js');

const TICKS_PER_SECOND = 10000000;

/**
 * DirectPlay TizenAVPlayer with two clocks the test controls:
 * the presentation clock (_currentTimeSec, returned by getCurrentTime() while
 * playing) and the decoder clock (webapis.avplay.getCurrentTime()).
 */
function createPlayer(t, { presentationSec, decoderSec }) {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000000 });

    const events = [];
    const clocks = { decoderMs: decoderSec * 1000 };
    let listener = null;
    const player = new TizenAVPlayer({ container: {}, onEvent: (event) => events.push(event) });
    player._avplay = {
        getCurrentTime: () => clocks.decoderMs,
        getState: () => 'PLAYING',
        seekTo: () => {}, // never calls back: a hung seek unless the test settles it
        setListener: (value) => {
            listener = value;
        }
    };
    player._isPrepared = true;
    player._isTizenPlaying = true;
    player._currentTimeSec = presentationSec;
    player._currentPlayOptions = { playMethod: 'DirectPlay', item: { Type: 'Movie' }, mediaSource: {} };

    return {
        player,
        clocks,
        seekFailures: () => events.filter((event) => event.type === 'resumeseekfailed'),
        getListener: () => {
            player._setupListeners();
            return listener;
        }
    };
}

/** Seek and buffering are over and the 3.5s settle time has passed. */
function settle(t, player) {
    player._seekInProgress = false;
    player._isNativeBuffering = false;
    t.mock.timers.tick(1500); // first check
    t.mock.timers.tick(1000);
    t.mock.timers.tick(1000); // 3.5s after arming
    t.mock.timers.tick(1000);
}

test('TizenAVPlayer: a slow forward seek is waited for, then confirmed', (t) => {
    const { player, clocks, seekFailures } = createPlayer(t, { presentationSec: 2.51, decoderSec: 2.51 });

    player._seekInProgress = true; // a slow 4K seek still in the hardware
    player._verifyDirectPlaySeek(115.965 * TICKS_PER_SECOND);
    assert.equal(player._directSeekTargetSec, 115.965);

    t.mock.timers.tick(1500);
    assert.equal(seekFailures().length, 0, 'no failure while seekTo is still in flight');
    assert.notEqual(player._directSeekVerifyTimeout, null, 'the check is rescheduled');

    player._seekInProgress = false;
    player._currentTimeSec = 116.0;
    clocks.decoderMs = 116000;
    t.mock.timers.tick(1000);

    assert.equal(seekFailures().length, 0);
    assert.equal(player._directSeekTargetSec, null, 'guard disarmed once the playhead is near the target');
    assert.equal(player._directSeekVerifyTimeout, null);
});

test('TizenAVPlayer: a forward seek stuck near the start asks for a remux', (t) => {
    const { player, seekFailures } = createPlayer(t, { presentationSec: 0.5, decoderSec: 0.5 });

    player._verifyDirectPlaySeek(115.965 * TICKS_PER_SECOND);
    settle(t, player);

    assert.equal(seekFailures().length, 1);
    assert.equal(seekFailures()[0].data.targetPositionTicks, 115.965 * TICKS_PER_SECOND);
    assert.equal(player._directSeekTargetSec, null);
});

test('TizenAVPlayer: a backward seek that stays at the later position asks for a remux', (t) => {
    // At 300s, seek back to 60s; the demuxer ignores it and both clocks stay at 300s.
    // 300s is past "target - 15s", which the old one-sided check took for a landed seek.
    const { player, seekFailures } = createPlayer(t, { presentationSec: 300, decoderSec: 300 });

    player._verifyDirectPlaySeek(60 * TICKS_PER_SECOND);
    settle(t, player);

    assert.equal(seekFailures().length, 1, 'a backward seek that did not move must be reported');
    assert.equal(seekFailures()[0].data.targetPositionTicks, 60 * TICKS_PER_SECOND);
});

test('TizenAVPlayer: a backward seek that landed is confirmed when one clock still shows the old position', (t) => {
    // The decoder is at the target, the presentation clock has not caught up yet
    const stalePresentation = createPlayer(t, { presentationSec: 300, decoderSec: 58.5 });
    stalePresentation.player._verifyDirectPlaySeek(60 * TICKS_PER_SECOND);
    settle(t, stalePresentation.player);

    assert.equal(stalePresentation.seekFailures().length, 0, 'decoder clock at the target: the seek landed');
    assert.equal(stalePresentation.player._directSeekTargetSec, null);
    t.mock.timers.reset();

    // The presentation clock is at the landing point, the decoder still reports the old position
    const staleDecoder = createPlayer(t, { presentationSec: 58.5, decoderSec: 300 });
    staleDecoder.player._verifyDirectPlaySeek(60 * TICKS_PER_SECOND);
    settle(t, staleDecoder.player);

    assert.equal(staleDecoder.seekFailures().length, 0, 'presentation clock at the target: the seek landed');
    assert.equal(staleDecoder.player._directSeekTargetSec, null);
});

test('TizenAVPlayer: a hung backward seek is not confirmed by a decoder clock showing the target', (t) => {
    // Some firmware reports the requested position while seekTo() is still pending.
    // At 300s, seek back to 60s; the seek never calls back and nothing moves.
    const { player, seekFailures } = createPlayer(t, { presentationSec: 300, decoderSec: 60 });

    player._verifyDirectPlaySeek(60 * TICKS_PER_SECOND);
    player._safeSeekTo(60000, null, null);

    t.mock.timers.tick(1500); // first check, seekTo() still in flight
    assert.equal(player._directSeekTargetSec, 60, 'one clock alone does not confirm a seek in flight');
    assert.equal(seekFailures().length, 0);

    for (let i = 0; i < 4; i++) t.mock.timers.tick(1000); // checks at 2.5s to 5.5s
    assert.equal(seekFailures().length, 0, 'still waiting while seekTo() is in flight');
    t.mock.timers.tick(500); // 6s: the seekTo() failsafe gives up on the callback
    assert.equal(player._seekInProgress, false);
    t.mock.timers.tick(500); // next check

    assert.equal(seekFailures().length, 1, 'a seek that never called back is reported for a remux');
    assert.equal(seekFailures()[0].data.targetPositionTicks, 60 * TICKS_PER_SECOND);
});

test('TizenAVPlayer: rendered frames disarm the guard only near the target', (t) => {
    const { player, getListener, seekFailures } = createPlayer(t, { presentationSec: 300, decoderSec: 300 });
    const listener = getListener();
    // Playback is running and has no pending tracks
    player._firstFrameRendered = true;
    player._firstFrameTimeMs = Date.now();
    player._playbackStabilized = true;
    player._pendingSeekMs = null;
    player._delayedSubtitleIndex = null;

    player._verifyDirectPlaySeek(60 * TICKS_PER_SECOND);

    listener.oncurrentplaytime(300000);
    assert.equal(player._directSeekTargetSec, 60, 'a frame at the old, later position keeps the guard armed');

    listener.oncurrentplaytime(59000);
    assert.equal(player._directSeekTargetSec, null, 'a frame near the target disarms the guard');
    assert.equal(player._directSeekVerifyTimeout, null);

    t.mock.timers.tick(5000);
    assert.equal(seekFailures().length, 0);
});
