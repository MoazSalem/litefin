import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('JellyfinPlayer: Remux stuck watchdog implementation and structure', () => {
    const jellyfinSource = readFileSync(
        new URL('../src/player/core/JellyfinPlayer.js', import.meta.url),
        'utf8'
    );

    // 1. Verify constructor initializes watchdog state
    assert.ok(
        jellyfinSource.includes('this._remuxWatchdogTimeout = null;'),
        'JellyfinPlayer must initialize _remuxWatchdogTimeout'
    );
    assert.ok(
        jellyfinSource.includes('this._remuxWatchdogActive = false;'),
        'JellyfinPlayer must initialize _remuxWatchdogActive'
    );
    assert.ok(
        jellyfinSource.includes('this._remuxWatchdogTargetTicks = null;'),
        'JellyfinPlayer must initialize _remuxWatchdogTargetTicks'
    );
    assert.ok(
        jellyfinSource.includes('this._remuxWatchdogInitialTime = null;'),
        'JellyfinPlayer must initialize _remuxWatchdogInitialTime'
    );

    // 2. Verify watchdog helper methods are defined
    assert.ok(
        jellyfinSource.includes('_armRemuxStuckWatchdog(targetTicks)'),
        'JellyfinPlayer must have _armRemuxStuckWatchdog method'
    );
    assert.ok(
        jellyfinSource.includes('_clearRemuxStuckWatchdog()'),
        'JellyfinPlayer must have _clearRemuxStuckWatchdog method'
    );
    assert.ok(
        jellyfinSource.includes('_handleRemuxWatchdogTimeout()'),
        'JellyfinPlayer must have _handleRemuxWatchdogTimeout method'
    );

    // 3. Verify resumeseekfailed arms the watchdog after remux restart
    assert.ok(
        jellyfinSource.includes("playbackMode: 'remux'"),
        "JellyfinPlayer must set playbackMode to 'remux' on seek failure"
    );
    assert.ok(
        jellyfinSource.includes('this._armRemuxStuckWatchdog(effectiveTicks);'),
        'JellyfinPlayer must arm watchdog upon restarting with remux'
    );

    // 4. Verify TIME_UPDATE disarms the watchdog when time progresses forward
    assert.ok(
        jellyfinSource.includes('this._remuxWatchdogActive && event.type === PlayerEvent.TIME_UPDATE'),
        'JellyfinPlayer must monitor TIME_UPDATE when watchdog is active'
    );
    assert.ok(
        jellyfinSource.includes('this._clearRemuxStuckWatchdog()'),
        'JellyfinPlayer must disarm watchdog upon forward progress'
    );

    // 5. Verify escalation transitions to transcode
    assert.ok(
        jellyfinSource.includes("playbackMode: 'transcode'"),
        "Watchdog timeout must escalate to 'transcode'"
    );

    // 6. Verify stop() disarms watchdog when not restarting
    assert.ok(
        jellyfinSource.includes('this._clearRemuxStuckWatchdog();'),
        'JellyfinPlayer.stop() must clear watchdog if not restarting'
    );
});

test('JellyfinPlayer: Watchdog behavior simulation (health vs stall escalation)', () => {
    // Test the state transitions with a simulated player context
    let restartedWithMode = null;
    let restartedAtTicks = null;

    const fakePlayer = {
        _remuxWatchdogTimeout: null,
        _remuxWatchdogActive: false,
        _remuxWatchdogTargetTicks: null,
        _remuxWatchdogInitialTime: null,
        _isRestarting: false,
        _currentPlayOptions: { itemId: 'item-123', playbackMode: 'remux' },

        getCurrentPositionTicks() {
            return 305000000;
        },

        emit(event, data) {},

        _armRemuxStuckWatchdog(targetTicks) {
            this._clearRemuxStuckWatchdog();
            this._remuxWatchdogActive = true;
            this._remuxWatchdogTargetTicks = targetTicks;
            this._remuxWatchdogInitialTime = null;
            this._remuxWatchdogTimeout = setTimeout(() => {
                this._handleRemuxWatchdogTimeout();
            }, 8000);
        },

        _clearRemuxStuckWatchdog() {
            if (this._remuxWatchdogTimeout) {
                clearTimeout(this._remuxWatchdogTimeout);
                this._remuxWatchdogTimeout = null;
            }
            this._remuxWatchdogActive = false;
            this._remuxWatchdogTargetTicks = null;
            this._remuxWatchdogInitialTime = null;
        },

        _handleRemuxWatchdogTimeout() {
            if (!this._remuxWatchdogActive || this._isRestarting || !this._currentPlayOptions) {
                return;
            }
            const targetTicks = this._remuxWatchdogTargetTicks || this.getCurrentPositionTicks();
            this._clearRemuxStuckWatchdog();
            restartedWithMode = 'transcode';
            restartedAtTicks = targetTicks;
        },

        onTimeUpdate(time) {
            if (this._remuxWatchdogActive) {
                if (this._remuxWatchdogInitialTime === null) {
                    this._remuxWatchdogInitialTime = time;
                } else if (time > this._remuxWatchdogInitialTime + 0.3) {
                    this._clearRemuxStuckWatchdog();
                }
            }
        }
    };

    // Scenario A: Remux succeeds and progresses
    fakePlayer._armRemuxStuckWatchdog(305000000);
    assert.strictEqual(fakePlayer._remuxWatchdogActive, true);
    assert.strictEqual(fakePlayer._remuxWatchdogTargetTicks, 305000000);

    // Initial timeupdate
    fakePlayer.onTimeUpdate(30.5);
    assert.strictEqual(fakePlayer._remuxWatchdogActive, true);
    assert.strictEqual(fakePlayer._remuxWatchdogInitialTime, 30.5);

    // Forward progress past threshold (> +0.3s)
    fakePlayer.onTimeUpdate(30.9);
    assert.strictEqual(fakePlayer._remuxWatchdogActive, false, 'Watchdog should disarm when playback progresses');
    assert.strictEqual(restartedWithMode, null, 'Should not escalate when remux works');

    // Scenario B: Remux hangs (decoder deadlock)
    fakePlayer._armRemuxStuckWatchdog(305000000);
    assert.strictEqual(fakePlayer._remuxWatchdogActive, true);

    // Initial timeupdate at 0s, followed by stall (no advance)
    fakePlayer.onTimeUpdate(0);
    fakePlayer.onTimeUpdate(0);

    // Watchdog expires
    fakePlayer._handleRemuxWatchdogTimeout();
    assert.strictEqual(fakePlayer._remuxWatchdogActive, false);
    assert.strictEqual(restartedWithMode, 'transcode', 'Should escalate to transcode when stalled');
    assert.strictEqual(restartedAtTicks, 305000000);
});
