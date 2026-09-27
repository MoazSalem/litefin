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

test('TizenAVPlayer: DirectPlay seek verification watchdog simulation', () => {
    let failedEvent = null;
    let timeoutId = 1;
    const activeTimers = new Map();

    const fakePlayer = {
        _avplay: {
            getCurrentTime: () => 2510 // 2.51 seconds initially
        },
        _isPrepared: true,
        _isPlaying: true,
        _isTizenPlaying: true,
        _currentTimeSec: 2.51,
        _currentPlayOptions: { playMethod: 'DirectPlay' },
        _seekInProgress: true, // Seek is actively executing in hardware
        _deferredSeekTimerId: null,
        _isNativeBuffering: false,

        _directSeekVerifyTimeout: null,
        _directSeekTargetSec: null,
        _directSeekPositionTicks: null,
        _directSeekStartTime: 0,

        getCurrentTime() {
            return this._currentTimeSec;
        },

        onEvent(event) {
            if (event.type === 'resumeseekfailed') {
                failedEvent = event;
            }
        },

        _clearDirectSeekVerification() {
            if (this._directSeekVerifyTimeout !== null) {
                activeTimers.delete(this._directSeekVerifyTimeout);
                this._directSeekVerifyTimeout = null;
            }
            this._directSeekTargetSec = null;
            this._directSeekPositionTicks = null;
            this._directSeekStartTime = 0;
        },

        _scheduleDirectSeekCheck(delayMs = 1000) {
            if (this._directSeekVerifyTimeout !== null) {
                activeTimers.delete(this._directSeekVerifyTimeout);
            }
            const id = timeoutId++;
            this._directSeekVerifyTimeout = id;
            activeTimers.set(id, () => {
                this._directSeekVerifyTimeout = null;
                this._runDirectSeekCheck();
            });
        },

        _verifyDirectPlaySeek(positionTicks) {
            const isDirectPlay = this._currentPlayOptions?.playMethod === 'DirectPlay';
            const targetSeconds = positionTicks / 10000000;
            if (!isDirectPlay || targetSeconds < 5) return;

            this._clearDirectSeekVerification();
            this._directSeekTargetSec = targetSeconds;
            this._directSeekPositionTicks = positionTicks;
            this._directSeekStartTime = Date.now();
            this._scheduleDirectSeekCheck(1500);
        },

        _runDirectSeekCheck() {
            if (!this._avplay || !this._isPrepared || this._directSeekTargetSec === null) {
                this._clearDirectSeekVerification();
                return;
            }

            const targetSeconds = this._directSeekTargetSec;
            const positionTicks = this._directSeekPositionTicks;
            const elapsedMs = Date.now() - this._directSeekStartTime;
            const MAX_SEEK_WAIT_MS = 12000;

            const curSec = Math.max(
                this.getCurrentTime(),
                (Number(this._avplay?.getCurrentTime()) || 0) / 1000
            );
            const drift = Math.abs(curSec - targetSeconds);
            const isNear = drift < 15 || curSec >= (targetSeconds - 15);

            if (isNear) {
                this._clearDirectSeekVerification();
                return;
            }

            const isStillWorking = this._seekInProgress ||
                                   this._deferredSeekTimerId !== null ||
                                   this._isNativeBuffering;

            if (isStillWorking) {
                if (elapsedMs < MAX_SEEK_WAIT_MS) {
                    this._scheduleDirectSeekCheck(1000);
                    return;
                }
            } else {
                if (elapsedMs < 3500) {
                    this._scheduleDirectSeekCheck(1000);
                    return;
                }
            }

            this._clearDirectSeekVerification();
            this.onEvent({
                type: 'resumeseekfailed',
                data: { targetPositionTicks: positionTicks }
            });
        }
    };

    // 1. Arm verification for target 115.965s (1,159,650,000 ticks)
    fakePlayer._verifyDirectPlaySeek(1159650000);
    assert.equal(fakePlayer._directSeekTargetSec, 115.965);
    assert.ok(fakePlayer._directSeekVerifyTimeout !== null);

    // 2. Trigger check at 1.5s while seek is still in progress (simulating slow 4K seek)
    const runTimer1 = activeTimers.get(fakePlayer._directSeekVerifyTimeout);
    assert.ok(typeof runTimer1 === 'function');
    runTimer1();

    // Verification must NOT fail while _seekInProgress is true! It must reschedule.
    assert.equal(failedEvent, null, 'Must not emit resumeseekfailed while seek is in progress');
    assert.ok(fakePlayer._directSeekVerifyTimeout !== null, 'Must reschedule check');

    // 3. Now simulate hardware seek completion: landed at 116.0s
    fakePlayer._seekInProgress = false;
    fakePlayer._currentTimeSec = 116.0;
    fakePlayer._avplay.getCurrentTime = () => 116000;

    // Run rescheduled check
    const runTimer2 = activeTimers.get(fakePlayer._directSeekVerifyTimeout);
    assert.ok(typeof runTimer2 === 'function');
    runTimer2();

    // Guard should disarm successfully because curSec (116.0s) is near target (115.965s)
    assert.equal(failedEvent, null);
    assert.equal(fakePlayer._directSeekTargetSec, null, 'Guard must disarm upon landing');
    assert.equal(fakePlayer._directSeekVerifyTimeout, null, 'Timeout must be cleared');

    // 4. Now simulate a silent failure (corrupt container with no cues)
    fakePlayer._currentTimeSec = 0.5;
    fakePlayer._avplay.getCurrentTime = () => 500;
    fakePlayer._verifyDirectPlaySeek(1159650000);

    // Seek finishes and buffering finishes, but player is stuck at 0.5s
    fakePlayer._seekInProgress = false;
    fakePlayer._isNativeBuffering = false;
    // Fast-forward simulated start time past 3500ms settling time
    fakePlayer._directSeekStartTime = Date.now() - 4000;

    const runTimer3 = activeTimers.get(fakePlayer._directSeekVerifyTimeout);
    runTimer3();

    // Now it MUST fail and emit resumeseekfailed for Remux fallback
    assert.ok(failedEvent !== null, 'Must emit resumeseekfailed when position is confirmed stuck');
    assert.equal(failedEvent.data.targetPositionTicks, 1159650000);
});
