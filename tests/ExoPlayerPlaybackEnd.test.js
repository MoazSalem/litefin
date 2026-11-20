import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/**
 * ============================================================================
 * ExoPlayer Playback End & Completion Event Test Suite
 * ============================================================================
 * Validates that Media3 ExoPlayer playback completion correctly notifies
 * the Jellyfin player event pipeline with 'ended' rather than stalling in a
 * false 'pause' state.
 *
 * Verifies:
 * 1. PlayerEvent enum exports ENDED = 'ended'
 * 2. ExoVideoPlayer transitions cleanly on state === 'ended'
 * 3. isPlaying = false on end-of-stream does not emit a false PAUSE event
 * 4. Polling loop and time updates are halted once playback ends
 * 5. Native Android ExoPlayerPlugin sends state with onIsPlayingChanged
 * ============================================================================
 */

test('PlayerEvent: exports ENDED and lifecycle event constants', () => {
    // Read JellyfinPlayer.js source directly
    const jfSource = readFileSync(
        new URL('../src/player/core/JellyfinPlayer.js', import.meta.url),
        'utf8'
    );

    // Verify ENDED constant definition
    assert.ok(
        jfSource.includes("ENDED: 'ended'"),
        "PlayerEvent must define ENDED: 'ended'"
    );

    // Verify CAN_PLAY constant definition
    assert.ok(
        jfSource.includes("CAN_PLAY: 'canplay'"),
        "PlayerEvent must define CAN_PLAY: 'canplay'"
    );

    // Verify LOAD_START constant definition
    assert.ok(
        jfSource.includes("LOAD_START: 'loadstart'"),
        "PlayerEvent must define LOAD_START: 'loadstart'"
    );

    // Verify LOADED_METADATA constant definition
    assert.ok(
        jfSource.includes("LOADED_METADATA: 'loadedmetadata'"),
        "PlayerEvent must define LOADED_METADATA: 'loadedmetadata'"
    );
});

test('ExoVideoPlayer: Static source verification for ended event dispatch and pause suppression', () => {
    // Read ExoVideoPlayer.js source directly
    const exoSource = readFileSync(
        new URL('../src/player/core/ExoVideoPlayer.js', import.meta.url),
        'utf8'
    );

    // 1. Verify constructor initializes _isEnded flag
    assert.ok(
        exoSource.includes('this._isEnded = false;'),
        'ExoVideoPlayer constructor must initialize this._isEnded flag'
    );

    // 2. Verify state === "ended" sets _isEnded and stops polling
    assert.ok(
        exoSource.includes("data.state === 'ended'"),
        'ExoVideoPlayer must inspect data.state === "ended"'
    );
    assert.ok(
        exoSource.includes('this._isEnded = true;'),
        'ExoVideoPlayer must set this._isEnded = true on ended state'
    );
    assert.ok(
        exoSource.includes('this._stopPollingLoop();'),
        'ExoVideoPlayer must halt the polling loop when ended'
    );
    assert.ok(
        exoSource.includes('this.onEvent({ type: PlayerEvent.ENDED });'),
        'ExoVideoPlayer must emit PlayerEvent.ENDED'
    );

    // 3. Verify false pause suppression when media has ended
    assert.ok(
        exoSource.includes("!this._isEnded && data.state !== 'ended'"),
        'ExoVideoPlayer must guard PAUSE dispatch so ended media is never reported as paused'
    );

    // 4. Verify timeupdate suppression when media has ended
    assert.ok(
        exoSource.includes('!this._started || this._isBuffering || this._isEnded'),
        'ExoVideoPlayer must suppress timeupdate when _isEnded is true'
    );

    // 5. Verify polling loop checks _isEnded
    assert.ok(
        exoSource.includes('!this._isEnded && this._started'),
        'ExoVideoPlayer polling loop must verify !this._isEnded before emitting timeupdate'
    );
});

test('ExoPlayerPlugin.kt: Native Android listener sends state with isPlaying and ended state', () => {
    // Read ExoPlayerPlugin.kt Kotlin source
    const ktSource = readFileSync(
        new URL('../src-tauri/gen/android/app/src/main/java/org/litefin/app/ExoPlayerPlugin.kt', import.meta.url),
        'utf8'
    );

    // 1. Verify onPlaybackStateChanged sends isPlaying
    assert.ok(
        ktSource.includes('put("isPlaying", newPlayer.isPlaying)'),
        'onPlaybackStateChanged must include isPlaying in payload'
    );

    // 2. Verify onIsPlayingChanged resolves stateName
    assert.ok(
        ktSource.includes('Player.STATE_ENDED -> "ended"'),
        'ExoPlayerPlugin must map STATE_ENDED to "ended"'
    );
    assert.ok(
        ktSource.includes('put("state", stateName)'),
        'onIsPlayingChanged must include current state in payload'
    );
});

test('ExoVideoPlayer: Simulation of playback completion state machine', () => {
    // Replicate ExoVideoPlayer event listener logic
    const PlayerEvent = {
        PLAY: 'play',
        PAUSE: 'pause',
        STOP: 'stop',
        WAITING: 'waiting',
        PLAYING: 'playing',
        ENDED: 'ended',
        CAN_PLAY: 'canplay'
    };

    const emittedEvents = [];
    const playerState = {
        _started: true,
        _isPaused: false,
        _isBuffering: false,
        _isEnded: false,
        onEvent(ev) {
            emittedEvents.push(ev);
        }
    };

    function handlePlaybackState(data) {
        if (data.state === 'buffering') {
            playerState._isBuffering = true;
            playerState.onEvent({ type: PlayerEvent.WAITING });
        } else if (data.state === 'ready') {
            playerState._isBuffering = false;
            playerState._isEnded = false;
            if (!playerState._started) {
                playerState._started = true;
                playerState.onEvent({ type: PlayerEvent.CAN_PLAY });
                playerState.onEvent({ type: PlayerEvent.PLAY });
                playerState.onEvent({ type: PlayerEvent.PLAYING });
            } else if (!playerState._isPaused) {
                playerState.onEvent({ type: PlayerEvent.PLAYING });
            }
        } else if (data.state === 'ended') {
            if (!playerState._isEnded) {
                playerState._isBuffering = false;
                playerState._isEnded = true;
                playerState._isPaused = false;
                playerState.onEvent({ type: PlayerEvent.ENDED });
            }
        }

        if (typeof data.isPlaying === 'boolean') {
            if (data.isPlaying) {
                playerState._isEnded = false;
                if (playerState._isPaused) {
                    playerState._isPaused = false;
                    playerState.onEvent({ type: PlayerEvent.PLAYING });
                }
            } else if (!playerState._isPaused && !playerState._isBuffering && !playerState._isEnded && data.state !== 'ended') {
                playerState._isPaused = true;
                playerState.onEvent({ type: PlayerEvent.PAUSE });
            }
        }
    }

    // Step 1: Media completes playback naturally (onPlaybackStateChanged fires with STATE_ENDED)
    handlePlaybackState({ state: 'ended', playWhenReady: true, isPlaying: false });

    // Assert that 'ended' was emitted and 'pause' was NOT emitted
    assert.equal(emittedEvents.length, 1);
    assert.equal(emittedEvents[0].type, 'ended');
    assert.equal(playerState._isEnded, true);
    assert.equal(playerState._isPaused, false);

    // Step 2: onIsPlayingChanged(false) follows immediately with state='ended'
    handlePlaybackState({ isPlaying: false, positionMs: 50000, state: 'ended' });

    // Assert that no spurious 'pause' was emitted
    assert.equal(emittedEvents.length, 1);
    assert.equal(playerState._isPaused, false);
    assert.equal(playerState._isEnded, true);

    // Step 3: Now simulate a user seeking or resuming new content
    playerState._isEnded = false;
    playerState._started = false;
    handlePlaybackState({ state: 'ready', isPlaying: true });

    assert.equal(playerState._isEnded, false);
    assert.equal(emittedEvents.some(e => e.type === 'playing'), true);
});
