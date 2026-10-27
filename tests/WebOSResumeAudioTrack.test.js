import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * ============================================================================
 * webOS Resume Audio Track Test Suite
 * ============================================================================
 * When direct play resumes from a #t= media fragment and a track other than the
 * container default is requested, the native audio track switch must wait until
 * playback has actually moved: switching at canplay or at 'playing' left the
 * webOS pipeline stalled with an empty buffer. The resume mute stays on until
 * the switch is done, so the default track is not heard meanwhile.
 * ============================================================================
 */

globalThis.window = {
    innerWidth: 1920,
    innerHeight: 1080
};
globalThis.localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {}
};
globalThis.document = {
    documentElement: { clientWidth: 1920, clientHeight: 1080 },
    createElement: () => ({
        classList: { add: () => {}, remove: () => {}, toggle: () => {} },
        addEventListener: () => {},
        querySelectorAll: () => [],
        appendChild: () => {},
        innerHTML: ''
    }),
    body: {
        appendChild: () => {}
    }
};

// Japanese AAC (container default) and Latin American Spanish AAC
const mediaSource = {
    Container: 'mkv',
    MediaStreams: [
        { Index: 0, Type: 'Video', Codec: 'hevc' },
        { Index: 1, Type: 'Audio', Codec: 'aac', Language: 'jpn', Channels: 2, IsDefault: true },
        { Index: 2, Type: 'Audio', Codec: 'aac', Language: 'spa', Channels: 2, IsDefault: false }
    ]
};
const resumeOptions = { mediaSource, audioStreamIndex: 2, audioTrackListIndex: 1, playerStartPositionTicks: 6780000000 };

function createNativeTracks() {
    return [
        { id: '1', language: 'ja', label: '', enabled: true },
        { id: '2', language: 'es', label: '', enabled: false }
    ];
}

// Minimal <video> stand-in that can fire events
function createVideo(audioTracks, currentTime) {
    const listeners = {};
    return {
        audioTracks,
        readyState: 4,
        currentTime,
        muted: false,
        paused: false,
        videoWidth: 1920,
        videoHeight: 1080,
        style: {},
        addEventListener: (type, fn) => (listeners[type] = listeners[type] || []).push(fn),
        removeEventListener: (type, fn) => (listeners[type] = (listeners[type] || []).filter((f) => f !== fn)),
        fire: (type) => (listeners[type] || []).slice().forEach((fn) => fn())
    };
}

async function createPlayer(video) {
    const { WebOSPlayer } = await import('../src/player/core/WebOSPlayer.js');
    const player = new WebOSPlayer({ container: { clientWidth: 1920, clientHeight: 1080, appendChild: () => {} } });
    player.onEvent = () => {};
    player._videoElement = video;
    return player;
}

const enabled = (audioTracks) => audioTracks.map((t) => t.enabled);

test('WebOSPlayer: when resuming direct play, switches the track only once playback has moved', async () => {
    const audioTracks = createNativeTracks();
    // The #t= media fragment already placed the playhead at the resume position
    const video = createVideo(audioTracks, 678);
    const player = await createPlayer(video);
    player._currentPlayOptions = resumeOptions;

    player._applyInitialTracks(resumeOptions);
    assert.deepStrictEqual(enabled(audioTracks), [true, false]);
    assert.strictEqual(video.currentTime, 678);

    video.fire('playing');
    video.currentTime = 678.1;
    video.fire('timeupdate');
    assert.deepStrictEqual(enabled(audioTracks), [true, false]);

    video.currentTime = 678.4;
    video.fire('timeupdate');
    assert.deepStrictEqual(enabled(audioTracks), [false, true]);
});

test('WebOSPlayer: keeps the resume mute on until the deferred track switch is done', async () => {
    const audioTracks = createNativeTracks();
    const video = createVideo(audioTracks, 678);
    const player = await createPlayer(video);
    // play() muted the video for the resume landing
    video.muted = true;
    player._resumeAudioSuppressed = true;
    player._currentPlayOptions = resumeOptions;

    player._applyInitialTracks(resumeOptions);

    // The resume landed: the playing handler would normally unmute here
    player._onPlaying();
    assert.strictEqual(video.muted, true);

    video.currentTime = 678.1;
    video.fire('timeupdate');
    assert.strictEqual(video.muted, true);
    video.currentTime = 678.4;
    video.fire('timeupdate');

    assert.deepStrictEqual(enabled(audioTracks), [false, true]);
    assert.strictEqual(video.muted, false);
});

test('WebOSPlayer: a seek jump does not count as played time for the resume switch', async () => {
    const audioTracks = createNativeTracks();
    const video = createVideo(audioTracks, 0);
    const player = await createPlayer(video);
    player._currentPlayOptions = resumeOptions;

    player._applyInitialTracks(resumeOptions);
    video.currentTime = 678;
    video.fire('timeupdate');

    assert.deepStrictEqual(enabled(audioTracks), [true, false]);
});

test('WebOSPlayer: a pending resume switch is dropped when another item starts', async () => {
    const audioTracks = createNativeTracks();
    const video = createVideo(audioTracks, 678);
    const player = await createPlayer(video);
    player._currentPlayOptions = resumeOptions;

    player._applyInitialTracks(resumeOptions);
    player._currentPlayOptions = { mediaSource };
    video.currentTime = 679;
    video.fire('timeupdate');

    assert.deepStrictEqual(enabled(audioTracks), [true, false]);
});

test('WebOSPlayer: starting from the beginning still switches the track right away', async () => {
    const audioTracks = createNativeTracks();
    const video = createVideo(audioTracks, 0);
    const player = await createPlayer(video);
    const options = { mediaSource, audioStreamIndex: 2, audioTrackListIndex: 1 };
    player._currentPlayOptions = options;

    player._applyInitialTracks(options);

    assert.deepStrictEqual(enabled(audioTracks), [false, true]);
});

test('WebOSPlayer: HLS resumes still switch the track right away', async () => {
    const audioTracks = createNativeTracks();
    const video = createVideo(audioTracks, 678);
    const player = await createPlayer(video);
    player._isHls = true;
    player._currentPlayOptions = resumeOptions;

    player._applyInitialTracks(resumeOptions);

    assert.deepStrictEqual(enabled(audioTracks), [false, true]);
});
