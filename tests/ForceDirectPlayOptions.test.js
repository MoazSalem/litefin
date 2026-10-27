import assert from 'node:assert/strict';
import test from 'node:test';

// Polyfill minimal browser DOM globals for Node test environment
const storageMap = new Map();
globalThis.localStorage = {
    getItem: (key) => storageMap.has(key) ? storageMap.get(key) : null,
    setItem: (key, val) => storageMap.set(key, String(val)),
    removeItem: (key) => storageMap.delete(key),
    clear: () => storageMap.clear(),
    key: (i) => Array.from(storageMap.keys())[i] ?? null,
    get length() { return storageMap.size; }
};

globalThis.document = {
    createElement: () => ({
        canPlayType: () => 'probably'
    }),
    addEventListener: () => {}
};

globalThis.screen = { width: 1920, height: 1080 };
globalThis.window = globalThis;
globalThis.addEventListener = () => {};

// Dynamic import after browser environment is polyfilled
const { storage } = await import('../src/utils/StorageService.js');
const { PlayerSettings } = await import('../src/utils/PlayerSettings.js');

/**
 * ============================================================================
 * Force Direct Play Granular Options Test Suite
 * ============================================================================
 * Tests the 3 dropdown modes (Video Only, Audio Only, Everything) plus Disabled,
 * verifying that the existing storage key 'forceDirectPlay' is preserved and
 * that legacy boolean preferences ('true' / 'false') resolve without modifying
 * or breaking user configurations.
 * ============================================================================
 */

test('PlayerSettings: forceDirectPlay defaults to off', () => {
    // Clear storage before checking default
    storage.removeItem('player:forceDirectPlay');
    // Ensure default returns 'off'
    const val = PlayerSettings.get('forceDirectPlay');
    assert.equal(val, 'off');
});

test('PlayerSettings: legacy boolean true migrates seamlessly to all', () => {
    // Directly simulate legacy stored 'true' flag in storage
    storage.setItem('player:forceDirectPlay', 'true');
    // Read through PlayerSettings.get
    const resolved = PlayerSettings.get('forceDirectPlay');
    // Existing users with toggle active must continue to direct play everything
    assert.equal(resolved, 'all');
});

test('PlayerSettings: legacy boolean false migrates seamlessly to off', () => {
    // Directly simulate legacy stored 'false' flag in storage
    storage.setItem('player:forceDirectPlay', 'false');
    // Read through PlayerSettings.get
    const resolved = PlayerSettings.get('forceDirectPlay');
    // Existing users with toggle disabled must continue to have it off
    assert.equal(resolved, 'off');
});

test('PlayerSettings: granular modes video, audio, and all are preserved', () => {
    // Test video mode
    PlayerSettings.set('forceDirectPlay', 'video');
    assert.equal(PlayerSettings.get('forceDirectPlay'), 'video');
    assert.equal(storage.getItem('player:forceDirectPlay'), 'video');

    // Test audio mode
    PlayerSettings.set('forceDirectPlay', 'audio');
    assert.equal(PlayerSettings.get('forceDirectPlay'), 'audio');
    assert.equal(storage.getItem('player:forceDirectPlay'), 'audio');

    // Test all mode
    PlayerSettings.set('forceDirectPlay', 'all');
    assert.equal(PlayerSettings.get('forceDirectPlay'), 'all');
    assert.equal(storage.getItem('player:forceDirectPlay'), 'all');

    // Test off mode
    PlayerSettings.set('forceDirectPlay', 'off');
    assert.equal(PlayerSettings.get('forceDirectPlay'), 'off');
    assert.equal(storage.getItem('player:forceDirectPlay'), 'off');

    // Test boolean setter compatibility
    PlayerSettings.set('forceDirectPlay', true);
    assert.equal(PlayerSettings.get('forceDirectPlay'), 'all');

    PlayerSettings.set('forceDirectPlay', false);
    assert.equal(PlayerSettings.get('forceDirectPlay'), 'off');
});

// ============================================================================
// PrewarmManager Force Direct Play Integration Tests
// ============================================================================

import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const prewarmSource = readFileSync(new URL('../src/player/core/PrewarmManager.js', import.meta.url), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/^import .*;\n/gm, '')
    .replace(/^export default .*;\n/gm, '')
    .replace(/^export const .*;\n/gm, '')
    .replace('export class PrewarmManager', 'class PrewarmManager');

function createPrewarmManagerWithSettings(settings = {}) {
    const posts = [];
    const context = vm.createContext({
        logger: { create: () => ({ info() {}, debug() {}, warn() {}, error() {} }) },
        api: {
            userId: 'user',
            post(url, body) {
                posts.push(body);
                return Promise.resolve({ MediaSources: [{ Id: 'ms-1' }] });
            }
        },
        PlayerSettings: { get: (key) => settings[key] },
        buildJellyfinProfile: () => ({
            MaxStreamingBitrate: 40000000,
            DirectPlayProfiles: [{ Type: 'Video', Container: 'mp4', VideoCodec: 'h264', AudioCodec: 'aac' }],
            TranscodingProfiles: [{ Container: 'ts', Type: 'Video' }],
            CodecProfiles: [{ Type: 'Video', Codec: 'h264' }]
        }),
        FontLoader: { loadFont: () => Promise.resolve() },
        SubtitleStyles: { getCurrentFontId: () => null },
        platformInfo: {},
        webCodecsProbe: {},
        resolveBestAudioStream: () => null,
        doesAudioTrackRequireDirectStream: () => false,
        resolveSubtitleStream: () => -1,
        getEffectiveSubtitleMode: () => 'Default',
        AbortController
    });
    const manager = vm.runInContext(`${prewarmSource}\nnew PrewarmManager();`, context);
    return { manager, posts, settings };
}

const testMovie = {
    Id: 'movie-force-dp',
    Type: 'Movie',
    Name: 'The Colors Within',
    MediaSources: [{ Id: 'ms-force-dp', MediaStreams: [] }]
};

test('PrewarmManager: prewarms with strict Direct Play overrides when forceDirectPlay is "all"', () => {
    const { manager, posts } = createPrewarmManagerWithSettings({
        forceDirectPlay: 'all'
    });

    manager.prewarm(testMovie);

    assert.equal(posts.length, 1);
    const payload = posts[0];

    // Transcoding must be disabled completely in the request payload
    assert.equal(payload.EnableDirectPlay, true);
    assert.equal(payload.EnableDirectStream, false);
    assert.equal(payload.EnableTranscoding, false);
    assert.equal(payload.AllowVideoStreamCopy, false);
    assert.equal(payload.AllowAudioStreamCopy, false);

    // TranscodingProfiles and CodecProfiles must be emptied
    assert.equal(payload.DeviceProfile.TranscodingProfiles.length, 0);
    assert.equal(payload.DeviceProfile.CodecProfiles.length, 0);

    // DirectPlayProfiles must include comprehensive codecs including AV1
    assert.ok(payload.DeviceProfile.DirectPlayProfiles.length > 0);
    const videoProfile = payload.DeviceProfile.DirectPlayProfiles.find((p) => p.Type === 'Video');
    assert.ok(videoProfile.VideoCodec.includes('av1'));
});

test('PrewarmManager: prewarms with video Direct Play overrides when forceDirectPlay is "video"', () => {
    const { manager, posts } = createPrewarmManagerWithSettings({
        forceDirectPlay: 'video'
    });

    manager.prewarm(testMovie);

    assert.equal(posts.length, 1);
    const payload = posts[0];

    assert.equal(payload.EnableDirectPlay, true);
    assert.equal(payload.EnableDirectStream, true);
    assert.equal(payload.EnableTranscoding, true);
    assert.equal(payload.AllowVideoStreamCopy, true);

    const videoProfile = payload.DeviceProfile.DirectPlayProfiles.find((p) => p.Type === 'Video');
    assert.ok(videoProfile.VideoCodec.includes('av1'));
    // Video CodecProfiles must be stripped
    assert.equal(payload.DeviceProfile.CodecProfiles.some((p) => p.Type === 'Video'), false);
});

test('PrewarmManager: invalidates prewarmed data if forceDirectPlay changes before consumption', () => {
    const settings = { forceDirectPlay: 'all' };
    const { manager } = createPrewarmManagerWithSettings(settings);

    manager.prewarm(testMovie);

    const consumeOptions = {
        mediaSourceId: 'ms-force-dp',
        audioStreamIndex: null,
        subtitleStreamIndex: -1,
        maxStreamingBitrate: 40000000
    };

    // Consume with same setting succeeds
    const cachedPromise = manager.consumePlaybackInfo('movie-force-dp', consumeOptions);
    assert.ok(cachedPromise);

    // Re-prewarm with 'all'
    manager.prewarm(testMovie);

    // User switches setting to 'off' in settings
    settings.forceDirectPlay = 'off';

    // Must be discarded due to setting mismatch
    const resultAfterChange = manager.consumePlaybackInfo('movie-force-dp', consumeOptions);
    assert.equal(resultAfterChange, null);
});

