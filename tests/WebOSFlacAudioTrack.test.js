import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

/**
 * ============================================================================
 * webOS FLAC Audio Track Test Suite
 * ============================================================================
 * webOS lists FLAC tracks in video.audioTracks and plays the container's default
 * track even when it is FLAC. enableFlacInVideo is a Tizen-only setting (off on
 * webOS), so the webOS track logic must not drop FLAC tracks: otherwise a FLAC
 * default looks like another track, and a request for that other track is
 * skipped as "already playing" while the TV keeps the FLAC default.
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

// Japanese FLAC (container default), English FLAC 5.1, Latin American Spanish AAC
const mediaSource = {
    Container: 'mkv',
    MediaStreams: [
        { Index: 0, Type: 'Video', Codec: 'hevc' },
        { Index: 1, Type: 'Audio', Codec: 'flac', Language: 'jpn', Channels: 2, IsDefault: true },
        { Index: 2, Type: 'Audio', Codec: 'flac', Language: 'eng', Channels: 6, IsDefault: false },
        { Index: 3, Type: 'Audio', Codec: 'aac', Language: 'spa', Channels: 2, IsDefault: false }
    ]
};

// video.audioTracks as webOS reports it for that file: the FLAC default is enabled
function createNativeTracks() {
    return [
        { id: '1', language: 'ja', label: '', enabled: true },
        { id: '2', language: 'en', label: '', enabled: false },
        { id: '3', language: 'es', label: '', enabled: false }
    ];
}

async function createWebOSPlayer() {
    const { WebOSPlayer } = await import('../src/player/core/WebOSPlayer.js');
    const player = new WebOSPlayer({ container: { clientWidth: 1920, clientHeight: 1080, appendChild: () => {} } });
    player.onEvent = () => {};
    return player;
}

test('WebOSPlayer: a FLAC container default is reported as the default track', async () => {
    const player = await createWebOSPlayer();

    assert.strictEqual(player._getContainerDefaultAudioIndex(mediaSource), 1);
});

test('WebOSPlayer: switches away from a FLAC default to the requested Spanish track', async () => {
    const player = await createWebOSPlayer();
    const audioTracks = createNativeTracks();
    const events = [];
    player.onEvent = (event) => events.push(event.type);
    player._videoElement = { audioTracks, readyState: 4, currentTime: 0 };

    const options = { mediaSource, audioStreamIndex: 3, audioTrackListIndex: 2 };
    player._currentPlayOptions = options;
    player._applyInitialTracks(options);

    assert.deepStrictEqual(
        audioTracks.map((t) => t.enabled),
        [false, false, true]
    );
    assert.deepStrictEqual(events, []);
});

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

test('WebOSPlayer: when resuming, switches away from a FLAC default once playback has moved', async () => {
    const player = await createWebOSPlayer();
    const audioTracks = createNativeTracks();
    // The #t= media fragment already placed the playhead at the resume position
    const video = createVideo(audioTracks, 678);
    player._videoElement = video;

    const options = { mediaSource, audioStreamIndex: 3, audioTrackListIndex: 2, playerStartPositionTicks: 6780000000 };
    player._currentPlayOptions = options;
    player._applyInitialTracks(options);
    const enabled = () => audioTracks.map((t) => t.enabled);

    assert.deepStrictEqual(enabled(), [true, false, false]);
    assert.strictEqual(video.currentTime, 678);

    video.fire('playing');
    video.currentTime = 678.1;
    video.fire('timeupdate');
    assert.deepStrictEqual(enabled(), [true, false, false]);

    video.currentTime = 678.4;
    video.fire('timeupdate');
    assert.deepStrictEqual(enabled(), [false, false, true]);
});

test('WebOSPlayer: requesting the FLAC default leaves the native tracks untouched', async () => {
    const player = await createWebOSPlayer();
    const audioTracks = createNativeTracks();
    player._videoElement = { audioTracks, readyState: 4, currentTime: 0 };

    const options = { mediaSource, audioStreamIndex: 1, audioTrackListIndex: 0 };
    player._currentPlayOptions = options;
    player._applyInitialTracks(options);

    assert.deepStrictEqual(
        audioTracks.map((t) => t.enabled),
        [true, false, false]
    );
});

// JellyfinPlayer._getBackendAudioTracks, run on its own with the settings and helpers it uses
function loadBackendAudioTracks(backendType) {
    const source = readFileSync(new URL('../src/player/core/JellyfinPlayer.js', import.meta.url), 'utf8').replace(
        /\r\n/g,
        '\n'
    );
    const start = source.indexOf('    _getBackendAudioTracks(mediaSource = this._currentMediaSource) {');
    const end = source.indexOf('    /**\n     * Convert a Jellyfin audio stream Index to the 0-based backend track index.');
    const context = vm.createContext({
        PlayerSettings: { get: (key) => (key === 'enableFlacInVideo' ? false : undefined) },
        isTrueHdSupported: () => false,
        isDtsSupported: () => false
    });
    const player = vm.runInContext(`({\n${source.slice(start, end)}\n})`, context);
    player._backendType = backendType;
    return (ms) => player._getBackendAudioTracks(ms).map((t) => t.Index);
}

test('JellyfinPlayer: keeps FLAC tracks in the webOS backend track list', () => {
    const backendTracks = loadBackendAudioTracks('webos');

    assert.deepStrictEqual(backendTracks(mediaSource), [1, 2, 3]);
});

test('JellyfinPlayer: still drops FLAC tracks on Tizen while enableFlacInVideo is off', () => {
    const backendTracks = loadBackendAudioTracks('tizen');

    assert.deepStrictEqual(backendTracks(mediaSource), [3]);
});

// isAudioTrackNativelyPlayable, extracted the same way as in AudioTrackSelector.test.js
// (from StreamUtils.js, where the dedicated Track-Resolution Engine now lives)
function loadPlayability(platform, settings = {}) {
    const source = readFileSync(new URL('../src/player/core/StreamUtils.js', import.meta.url), 'utf8').replace(
        /\r\n/g,
        '\n'
    );
    const currentSettings = { enableFlacInVideo: false, enableDts: 'auto', enableTrueHd: 'auto', ...settings };
    const context = vm.createContext({
        PlayerSettings: { get: (key) => currentSettings[key] },
        getDeviceCapabilities: () => ({ ac3: true, eac3: true, maxAudioChannels: 6 }),
        platformInfo: { isTizen: platform === 'tizen', isWebOS: platform === 'webos' },
        AUDIO_FALLBACK_STORAGE_KEYS: {},
        storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
        log: { info() {}, debug() {}, warn() {}, error() {} },
        MediaHelper: { getTranscodeStatus: () => ({ isVideoDirect: true, isAudioDirect: true }) },
        languageManager: { normalizeLanguage: (lang) => lang }
    });
    const code = `
        ${source
            .slice(
                source.indexOf('export const isTrueHdSupported =')
            )
            .replace(/export /g, '')}
        isAudioTrackNativelyPlayable;
    `;
    return vm.runInContext(code, context);
}

test('isAudioTrackNativelyPlayable: the native webOS player plays FLAC up to 2 channels', () => {
    const playable = loadPlayability('webos');

    assert.strictEqual(playable({ Codec: 'flac', Channels: 2 }, mediaSource, 'webos'), true);
    assert.strictEqual(playable({ Codec: 'flac', Channels: 6 }, mediaSource, 'webos'), false);
    assert.strictEqual(playable({ Codec: 'flac', Channels: 2 }, mediaSource), true);
});

test('isAudioTrackNativelyPlayable: the HTML5 player on webOS still follows enableFlacInVideo', () => {
    const playable = loadPlayability('webos', { playerBackend: 'html5' });

    assert.strictEqual(playable({ Codec: 'flac', Channels: 2 }, mediaSource), false);
    assert.strictEqual(playable({ Codec: 'flac', Channels: 2 }, mediaSource, 'html5'), false);
});

test('isAudioTrackNativelyPlayable: Tizen still needs enableFlacInVideo for FLAC', () => {
    assert.strictEqual(loadPlayability('tizen')({ Codec: 'flac', Channels: 2 }, mediaSource, 'tizen'), false);
    assert.strictEqual(
        loadPlayability('tizen', { enableFlacInVideo: true })({ Codec: 'flac', Channels: 2 }, mediaSource, 'tizen'),
        true
    );
});
