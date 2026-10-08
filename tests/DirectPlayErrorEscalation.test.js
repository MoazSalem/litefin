import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('JellyfinPlayer: DirectPlay failure transcode escalation structure and integration', () => {
    const jellyfinSource = readFileSync(
        new URL('../src/player/core/JellyfinPlayer.js', import.meta.url),
        'utf8'
    );
    const settingsSource = readFileSync(
        new URL('../src/utils/PlayerSettings.js', import.meta.url),
        'utf8'
    );
    const settingsPageSource = readFileSync(
        new URL('../src/pages/SettingsPage.js', import.meta.url),
        'utf8'
    );

    // 1. Verify PlayerSettings defaults autoTranscodeOnError to true
    assert.ok(
        settingsSource.includes('autoTranscodeOnError: true'),
        'PlayerSettings must define autoTranscodeOnError defaulting to true'
    );

    // 2. Verify SettingsPage includes autoTranscodeOnError toggle switch
    assert.ok(
        settingsPageSource.includes('data-setting="autoTranscodeOnError"'),
        'SettingsPage must render autoTranscodeOnError toggle switch'
    );

    // 3. Verify constructor initializes _directPlayEscalated guard
    assert.ok(
        jellyfinSource.includes('this._directPlayEscalated = false;'),
        'JellyfinPlayer must initialize this._directPlayEscalated to false'
    );

    // 4. Verify _handleBackendEvent checks autoTranscodeOnError setting
    assert.ok(
        jellyfinSource.includes("PlayerSettings.get('autoTranscodeOnError') !== false"),
        'JellyfinPlayer must check autoTranscodeOnError setting before escalating'
    );

    // 5. Verify _handleBackendEvent intercepts PlayerEvent.ERROR for DirectPlay
    assert.ok(
        jellyfinSource.includes("this._currentPlayMethod !== 'Transcode'"),
        'JellyfinPlayer must verify current play method is not already transcode'
    );
    assert.ok(
        jellyfinSource.includes("this._playbackMode !== 'transcode'"),
        'JellyfinPlayer must verify playbackMode is not already transcode'
    );
    assert.ok(
        jellyfinSource.includes('!this._directPlayEscalated'),
        'JellyfinPlayer must guard against recursive escalation with _directPlayEscalated'
    );

    // 6. Verify escalation sets playbackMode to transcode
    assert.ok(
        jellyfinSource.includes("playbackMode: 'transcode'"),
        "JellyfinPlayer must restart with playbackMode: 'transcode'"
    );

    // 7. Verify fresh play requests reset the escalation flag
    assert.ok(
        jellyfinSource.includes('this._directPlayEscalated = false;'),
        'JellyfinPlayer must reset _directPlayEscalated on fresh playback or stop'
    );

    // 8. Verify prewarm cache is discarded when active mode is transcode
    assert.ok(
        jellyfinSource.includes("this._playbackMode === 'transcode' && (firstSource.SupportsDirectPlay || firstSource.SupportsDirectStream)"),
        'JellyfinPlayer must discard cached DirectPlay prewarm data when transcode is active'
    );
});

test('JellyfinPlayer: DirectPlay error transcode escalation simulation (enabled vs disabled)', async () => {
    let playCallCount = 0;
    let stopCallCount = 0;
    let restartOptionsCaptured = null;
    let emittedEvents = [];
    let autoTranscodeSetting = true;

    const fakePlayer = {
        _backendType: 'exoplayer',
        _currentPlayMethod: 'DirectPlay',
        _playbackMode: 'auto',
        _isRestarting: false,
        _directPlayEscalated: false,
        _currentAudioStreamIndex: 1,
        _currentSubtitleStreamIndex: 6,
        _currentSecondarySubtitleStreamIndex: -1,
        _currentPlayOptions: {
            itemId: '1331df963ac439061940622826ea0fe2',
            startPositionTicks: 0,
            playbackMode: 'auto'
        },

        getCurrentPositionTicks() {
            return 5000000;
        },

        emit(event, data) {
            emittedEvents.push({ event, data });
        },

        async stop() {
            stopCallCount++;
        },

        async play(options) {
            playCallCount++;
            restartOptionsCaptured = options;
            this._playbackMode = options.playbackMode;
            this._currentPlayMethod = 'Transcode';
        },

        handleBackendError(errorData) {
            const isAutoTranscodeEnabled = autoTranscodeSetting !== false;
            const canEscalate =
                isAutoTranscodeEnabled &&
                !this._isRestarting &&
                !this._directPlayEscalated &&
                this._currentPlayOptions &&
                this._currentPlayMethod !== 'Transcode' &&
                this._playbackMode !== 'transcode';

            if (canEscalate) {
                this._directPlayEscalated = true;
                const currentTicks = this.getCurrentPositionTicks() || this._currentPlayOptions.startPositionTicks || 0;
                const restartOptions = {
                    ...this._currentPlayOptions,
                    audioStreamIndex: this._currentAudioStreamIndex,
                    subtitleStreamIndex: this._currentSubtitleStreamIndex,
                    secondarySubtitleStreamIndex: this._currentSecondarySubtitleStreamIndex,
                    startPositionTicks: currentTicks,
                    playbackMode: 'transcode'
                };

                this._currentPlayOptions = restartOptions;
                this._isRestarting = true;
                this.emit('restarting');

                return (async () => {
                    try {
                        await this.stop();
                        await this.play(restartOptions);
                    } finally {
                        this._isRestarting = false;
                    }
                })();
            }

            this.emit('error', errorData);
            return Promise.resolve();
        }
    };

    // First error trigger with setting ENABLED: DirectPlay failure (should escalate to transcode)
    await fakePlayer.handleBackendError({ error: 'Source error', code: 2000 });

    assert.equal(playCallCount, 1, 'play() should be called once with escalated options');
    assert.equal(stopCallCount, 1, 'stop() should be called once before restart');
    assert.equal(fakePlayer._directPlayEscalated, true, '_directPlayEscalated should be true');
    assert.equal(restartOptionsCaptured.playbackMode, 'transcode', 'Should restart with transcode mode');
    assert.equal(restartOptionsCaptured.startPositionTicks, 5000000, 'Should preserve playback position');
    assert.equal(restartOptionsCaptured.audioStreamIndex, 1, 'Should preserve selected audio stream index');
    assert.equal(restartOptionsCaptured.subtitleStreamIndex, 6, 'Should preserve selected subtitle stream index');

    // Second error trigger: If transcoding also fails, it must emit error to UI instead of re-escalating
    await fakePlayer.handleBackendError({ error: 'Transcode failed', code: 2001 });

    assert.equal(playCallCount, 1, 'play() should NOT be called again after transcode failure');
    const errorEvent = emittedEvents.find(e => e.event === 'error');
    assert.ok(errorEvent, 'Should emit error event to UI when transcode fails');
    assert.equal(errorEvent.data.code, 2001);

    // Test with setting DISABLED:
    autoTranscodeSetting = false;
    fakePlayer._directPlayEscalated = false;
    fakePlayer._playbackMode = 'auto';
    fakePlayer._currentPlayMethod = 'DirectPlay';
    emittedEvents = [];
    playCallCount = 0;

    await fakePlayer.handleBackendError({ error: 'Source error disabled', code: 2000 });
    assert.equal(playCallCount, 0, 'play() should NOT be called when autoTranscodeOnError is disabled');
    const disabledError = emittedEvents.find(e => e.event === 'error');
    assert.ok(disabledError, 'Should emit error event immediately when setting is disabled');
    assert.equal(disabledError.data.error, 'Source error disabled');
});
