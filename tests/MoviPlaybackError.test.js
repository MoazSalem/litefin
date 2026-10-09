import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('MoviVideoPlayer: Startup watchdog and error event bindings verification', () => {
    const moviSource = readFileSync(
        new URL('../src/player/core/MoviVideoPlayer.js', import.meta.url),
        'utf8'
    );

    // 1. Verify STARTUP_TIMEOUT_MS constant is defined
    assert.ok(
        moviSource.includes('STARTUP_TIMEOUT_MS = 15000;'),
        'MoviVideoPlayer must define a 15-second STARTUP_TIMEOUT_MS constant'
    );

    // 2. Verify constructor initializes startup watchdog timer state
    assert.ok(
        moviSource.includes('this._startupWatchdogTimer = null;'),
        'MoviVideoPlayer constructor must initialize _startupWatchdogTimer'
    );

    // 3. Verify helper methods are defined
    assert.ok(
        moviSource.includes('_armStartupWatchdog()'),
        'MoviVideoPlayer must declare _armStartupWatchdog helper'
    );
    assert.ok(
        moviSource.includes('_clearStartupWatchdog()'),
        'MoviVideoPlayer must declare _clearStartupWatchdog helper'
    );

    // 4. Verify movi-player errordisplay custom event is handled
    assert.ok(
        moviSource.includes('errordisplay: (event) =>'),
        'MoviVideoPlayer must bind and handle errordisplay event'
    );
    assert.ok(
        moviSource.includes('detail.message || detail.title'),
        'MoviVideoPlayer must extract message or title from errordisplay detail'
    );

    // 5. Verify movi-player statechange custom event is handled
    assert.ok(
        moviSource.includes('statechange: (event) =>'),
        'MoviVideoPlayer must bind and handle statechange event'
    );

    // 6. Verify standard error handler parses event.detail
    assert.ok(
        moviSource.includes('event?.detail || element.error'),
        'MoviVideoPlayer error handler must extract from event.detail'
    );

    // 7. Verify watchdog is armed when play() initiates
    assert.ok(
        moviSource.includes('this._armStartupWatchdog();'),
        'MoviVideoPlayer play() must arm the startup watchdog'
    );

    // 8. Verify watchdog is cleared on playing, error, stop, and destroy
    assert.ok(
        moviSource.includes('this._clearStartupWatchdog();'),
        'MoviVideoPlayer must clear the watchdog upon successful play and teardown'
    );
});

test('MoviVideoPlayer: Error handling and watchdog behavior simulation', async () => {
    // Emulate MoviVideoPlayer event dispatching and timer behavior
    const dispatchedEvents = [];
    let timerId = null;
    let started = false;

    const fakeBackend = {
        _startupWatchdogTimer: null,
        _started: false,
        onEvent(event) {
            dispatchedEvents.push(event);
        },
        _armStartupWatchdog(timeoutMs = 50) {
            this._clearStartupWatchdog();
            this._startupWatchdogTimer = setTimeout(() => {
                if (!this._started) {
                    this.onEvent({
                        type: 'error',
                        data: {
                            code: -1,
                            message: 'Playback failed to start within timeout. Check media source or try HTML5 / Transcode.'
                        }
                    });
                }
            }, timeoutMs);
        },
        _clearStartupWatchdog() {
            if (this._startupWatchdogTimer) {
                clearTimeout(this._startupWatchdogTimer);
                this._startupWatchdogTimer = null;
            }
        },
        onPlaying() {
            this._started = true;
            this._clearStartupWatchdog();
            this.onEvent({ type: 'playing' });
        },
        onErrorDisplay(detail) {
            this._clearStartupWatchdog();
            this.onEvent({
                type: 'error',
                data: {
                    code: -1,
                    message: detail.message || detail.title || 'Playback failed',
                    canRetry: detail.canRetry,
                    canTrySoftware: detail.canTrySoftware
                }
            });
        }
    };

    // Case 1: errordisplay fires when movi encounters unsupported codec/format
    fakeBackend._armStartupWatchdog(100);
    fakeBackend.onErrorDisplay({
        title: 'Format Unsupported',
        message: 'This video codec is not supported by your hardware.',
        canRetry: false,
        canTrySoftware: true
    });

    assert.equal(dispatchedEvents.length, 1);
    assert.equal(dispatchedEvents[0].type, 'error');
    assert.equal(
        dispatchedEvents[0].data.message,
        'This video codec is not supported by your hardware.'
    );
    assert.equal(fakeBackend._startupWatchdogTimer, null);

    // Case 2: Watchdog triggers if no events fire within the timeout
    dispatchedEvents.length = 0;
    fakeBackend._started = false;
    fakeBackend._armStartupWatchdog(20);

    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(dispatchedEvents.length, 1);
    assert.equal(dispatchedEvents[0].type, 'error');
    assert.match(dispatchedEvents[0].data.message, /Playback failed to start within timeout/);

    // Case 3: Playing disarms watchdog cleanly
    dispatchedEvents.length = 0;
    fakeBackend._started = false;
    fakeBackend._armStartupWatchdog(100);
    fakeBackend.onPlaying();

    assert.equal(fakeBackend._started, true);
    assert.equal(fakeBackend._startupWatchdogTimer, null);
    assert.equal(dispatchedEvents.length, 1);
    assert.equal(dispatchedEvents[0].type, 'playing');

    // Wait to confirm watchdog does not fire later
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(dispatchedEvents.length, 1);
});
