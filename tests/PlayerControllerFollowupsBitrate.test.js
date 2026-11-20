/* eslint-env node */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

/**
 * ============================================================================
 * Player Controller Follow-up Test Suite: global bitrate limit
 * ============================================================================
 * JellyfinPlayer starts every item without a manual bitrate (only a quality
 * picked in the OSD forces a transcode). The global limit (maxBitrateInternet)
 * then reaches the server through the device profile's MaxStreamingBitrate:
 *   - the Android (ExoPlayer) profile applies it, like the TV profiles
 *   - the prewarm asks with the same profile as the player, so it is reused
 * ============================================================================
 */

const storage = new Map();
globalThis.localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
    clear: () => storage.clear(),
    key: (i) => [...storage.keys()][i] ?? null,
    get length() {
        return storage.size;
    }
};
globalThis.screen = { width: 1920, height: 1080 };
globalThis.window = globalThis;
globalThis.LitefinAndroid = { getSupportedVideoCodecs: () => JSON.stringify({ h264: true, hevc: true }) };

const { PlayerSettings } = await import('../src/utils/PlayerSettings.js');
const AndroidProfile = await import('../src/api/profiles/AndroidProfile.js');

/** The profile a new JellyfinPlayer item builds: no quality picked in the OSD. */
const playerProfile = () =>
    AndroidProfile.buildJellyfinProfile({ manualBitrate: null, playbackMode: 'auto', backend: 'exoplayer' });

test('AndroidProfile: the global bitrate limit is the MaxStreamingBitrate when no quality is picked', () => {
    PlayerSettings.set('maxBitrateInternet', 8000000);
    const profile = playerProfile();
    assert.strictEqual(profile.MaxStreamingBitrate, 8000000, 'the global limit is ignored on Android');
    assert.strictEqual(profile.MaxStaticBitrate, 8000000);
});

test('AndroidProfile: a quality picked in the OSD wins, and the limit stays at most 120 Mbps (guard)', () => {
    PlayerSettings.set('maxBitrateInternet', 8000000);
    const picked = AndroidProfile.buildJellyfinProfile({
        manualBitrate: 4000000,
        playbackMode: 'auto',
        backend: 'exoplayer'
    });
    assert.strictEqual(picked.MaxStreamingBitrate, 4000000);

    PlayerSettings.set('maxBitrateInternet', 200000000);
    assert.strictEqual(playerProfile().MaxStreamingBitrate, 120000000);
});

// ----------------------------------------------------------------------------
// PrewarmManager (imports and exports stripped, run in an isolated VM)
// ----------------------------------------------------------------------------

const prewarmSource = readFileSync(new URL('../src/player/core/PrewarmManager.js', import.meta.url), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/^import .*;\n/gm, '')
    .replace(/^export default .*;\n/gm, '')
    .replace(/^export const .*;\n/gm, '')
    .replace('export class PrewarmManager', 'class PrewarmManager');

test("PrewarmManager: on Android the prewarm asks for the player's bitrate limit and is reused by it", () => {
    PlayerSettings.set('maxBitrateInternet', 8000000);
    PlayerSettings.set('playerBackend', 'exoplayer');
    const posts = [];
    const quietLog = { info() {}, debug() {}, warn() {}, error() {} };
    const context = vm.createContext({
        logger: { create: () => quietLog },
        api: {
            userId: 'user',
            post(url, body) {
                posts.push(body);
                return Promise.resolve({ MediaSources: [{ Id: 'ms-1' }] });
            }
        },
        PlayerSettings,
        buildJellyfinProfile: AndroidProfile.buildJellyfinProfile,
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
    manager.prewarm({ Id: 'movie-1', Type: 'Movie', Name: 'Movie', MediaSources: [{ Id: 'ms-1', MediaStreams: [] }] });

    // JellyfinPlayer._getPlaybackInfo() sends its profile's MaxStreamingBitrate
    const playerLimit = playerProfile().MaxStreamingBitrate;
    assert.strictEqual(posts.length, 1);
    assert.strictEqual(posts[0].MaxStreamingBitrate, playerLimit);
    assert.strictEqual(posts[0].DeviceProfile.MaxStreamingBitrate, playerLimit);
    assert.ok(
        manager.consumePlaybackInfo('movie-1', {
            mediaSourceId: 'ms-1',
            audioStreamIndex: null,
            subtitleStreamIndex: -1,
            maxStreamingBitrate: playerLimit
        }),
        'the player discards the prewarm'
    );
});
