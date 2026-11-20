import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

/**
 * ============================================================================
 * Prewarm Reuse & Media Position Test Suite
 * ============================================================================
 * - A prewarmed PlaybackInfo is reused only for the bitrate limit it was
 *   negotiated with: a quality lowered in the OSD gets a fresh request. The
 *   prewarm asks for the same limit JellyfinPlayer would (the profile's).
 * - A prewarmed progressive (non-HLS) transcode starts at the position in its
 *   URL, so it is not reused for another start position. HLS ignores it.
 * - seekRelative() works from the media position, including the offset of a
 *   progressive transcode that started mid-file.
 * ============================================================================
 */

globalThis.window = globalThis.window || { innerWidth: 1920, innerHeight: 1080, screen: { width: 1920, height: 1080 } };
globalThis.localStorage = globalThis.localStorage || {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    key: () => null,
    length: 0
};

const { MediaHelper } = await import('../src/player/core/MediaHelper.js');

const quietLog = { info() {}, debug() {}, warn() {}, error() {} };

// ----------------------------------------------------------------------------
// PrewarmManager (imports and exports stripped, run in an isolated VM)
// ----------------------------------------------------------------------------

const prewarmSource = readFileSync(new URL('../src/player/core/PrewarmManager.js', import.meta.url), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/^import .*;\n/gm, '')
    .replace(/^export default .*;\n/gm, '')
    .replace(/^export const .*;\n/gm, '')
    .replace('export class PrewarmManager', 'class PrewarmManager');

/** A PrewarmManager on a non-UHD TV (profile limit 40 Mbps) with no user bitrate limit. */
function createPrewarmManager(settings = {}) {
    const posts = [];
    const context = vm.createContext({
        logger: { create: () => quietLog },
        api: {
            userId: 'user',
            post(url, body) {
                posts.push(body);
                return Promise.resolve({ MediaSources: [{ Id: 'ms-1' }] });
            }
        },
        PlayerSettings: { get: (key) => settings[key] },
        buildJellyfinProfile: ({ manualBitrate }) => ({
            MaxStreamingBitrate: Math.min(manualBitrate || 40000000, 40000000),
            DirectPlayProfiles: []
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
    return { manager, posts };
}

const movie = { Id: 'movie-1', Type: 'Movie', Name: 'Movie', MediaSources: [{ Id: 'ms-1', MediaStreams: [] }] };

test('PrewarmManager: the prewarm asks for the bitrate limit the player would use', () => {
    const { manager, posts } = createPrewarmManager({ playerBackend: 'webos' });
    manager.prewarm(movie);

    assert.strictEqual(posts.length, 1);
    // A fresh request from JellyfinPlayer sends the profile's limit (40 Mbps here), not 120 Mbps
    assert.strictEqual(posts[0].MaxStreamingBitrate, 40000000);
});

test('PrewarmManager: a prewarm is reused for the same bitrate limit and discarded after a quality change', () => {
    const { manager } = createPrewarmManager({ playerBackend: 'webos' });
    manager.prewarm(movie);
    const consume = (maxStreamingBitrate) =>
        manager.consumePlaybackInfo('movie-1', {
            mediaSourceId: 'ms-1',
            audioStreamIndex: null,
            subtitleStreamIndex: -1,
            maxStreamingBitrate
        });

    assert.strictEqual(consume(8000000), null, 'PlaybackInfo negotiated for 40 Mbps reused at 8 Mbps');

    manager.prewarm(movie);
    assert.ok(consume(40000000), 'matching prewarm not reused');
});

// ----------------------------------------------------------------------------
// JellyfinPlayer (methods taken from the source; the module needs a full DOM)
// ----------------------------------------------------------------------------

const jellyfinSource = readFileSync(new URL('../src/player/core/JellyfinPlayer.js', import.meta.url), 'utf8').replace(
    /\r\n/g,
    '\n'
);

function extractMethod(signature) {
    const start = jellyfinSource.indexOf(`\n    ${signature}`);
    assert.ok(start !== -1, `method not found: ${signature}`);
    const end = jellyfinSource.indexOf('\n    }\n', start);
    return jellyfinSource.slice(start + 1, end + 6);
}

function createPlaybackInfoPlayer(prewarmedSource) {
    const consumed = [];
    const fetches = [];
    const timeoutConstant = jellyfinSource.match(/\nconst PLAYBACK_INFO_TIMEOUT_MS = [^;]+;/);
    // MediaHelper.fetchWithTimeout() uses the global fetch (each test file runs in its own process)
    globalThis.fetch = async (url, init) => {
        fetches.push(JSON.parse(init.body));
        return { ok: true, json: async () => ({ PlaySessionId: 'fresh', MediaSources: [{ Id: 'fresh' }] }) };
    };
    const context = vm.createContext({
        JSON,
        Promise,
        log: quietLog,
        MediaHelper,
        PlayerSettings: { get: () => undefined },
        isAudioTrackNativelyPlayable: () => true,
        isTrueHdSupported: () => false,
        isDtsSupported: () => false,
        doesAudioTrackRequireDirectStream: () => false,
        prewarmManager: {
            consumePlaybackInfo(itemId, options) {
                consumed.push(options);
                return Promise.resolve({ PlaySessionId: 'prewarmed', MediaSources: [prewarmedSource] });
            }
        },
        buildJellyfinProfile: () => ({}),
        api: { isEmby: () => false, getAuthHeader: () => 'MediaBrowser Token="t"' }
    });
    const methods = vm.runInContext(
        `${timeoutConstant ? timeoutConstant[0] : ''}\n({\n${extractMethod('async _getPlaybackInfo(options, deviceProfile, manualBitrate = null) {')}\n})`,
        context
    );
    const player = Object.assign(Object.create(methods), {
        serverUrl: 'http://srv',
        authToken: 't',
        _playbackMode: 'auto',
        _backendType: 'webos'
    });
    return { player, consumed, fetches };
}

const playOptions = (startPositionTicks) => ({
    itemId: 'item',
    userId: 'user',
    startPositionTicks,
    item: { Type: 'Movie' }
});

test('JellyfinPlayer: the prewarm check gets the bitrate limit of this request', async () => {
    const { player, consumed } = createPlaybackInfoPlayer({ Id: 'ms', SupportsDirectPlay: true, MediaStreams: [] });
    await player._getPlaybackInfo(playOptions(0), { MaxStreamingBitrate: 8000000, DirectPlayProfiles: [{}] }, 8000000);
    assert.strictEqual(consumed[0].maxStreamingBitrate, 8000000);
});

test('JellyfinPlayer: a prewarmed progressive transcode is not reused for another start position', async () => {
    const progressive = {
        Id: 'ms',
        MediaStreams: [],
        TranscodingSubProtocol: 'http',
        TranscodingUrl: '/videos/item/stream.mkv?MediaSourceId=ms&VideoCodec=h264&StartTimeTicks=36000000000&PlaySessionId=p'
    };

    // "Start from beginning" after a prewarm built for the resume point
    let run = createPlaybackInfoPlayer(progressive);
    let info = await run.player._getPlaybackInfo(playOptions(0), { DirectPlayProfiles: [{}] });
    assert.strictEqual(info.PlaySessionId, 'fresh', 'transcode would start at the old resume point');
    assert.strictEqual(run.fetches[0].StartTimeTicks, 0);

    // Same start: reused
    run = createPlaybackInfoPlayer(progressive);
    info = await run.player._getPlaybackInfo(playOptions(36000000000), { DirectPlayProfiles: [{}] });
    assert.strictEqual(info.PlaySessionId, 'prewarmed');
});

test('JellyfinPlayer: a prewarmed HLS transcode is reused for any start position (guard)', async () => {
    const hls = {
        Id: 'ms',
        MediaStreams: [],
        TranscodingSubProtocol: 'hls',
        TranscodingUrl: '/videos/item/master.m3u8?MediaSourceId=ms&VideoCodec=h264&PlaySessionId=p'
    };
    const { player, fetches } = createPlaybackInfoPlayer(hls);
    const info = await player._getPlaybackInfo(playOptions(0), { DirectPlayProfiles: [{}] });
    assert.strictEqual(info.PlaySessionId, 'prewarmed');
    assert.strictEqual(fetches.length, 0);
});

test('JellyfinPlayer: seekRelative counts from the media position of a progressive transcode', () => {
    const context = vm.createContext({ Math });
    const methods = vm.runInContext(
        `({\n${['seekRelative(offsetMs) {', 'getCurrentPositionMs() {'].map(extractMethod).join(',\n')}\n})`,
        context
    );
    const seeks = [];
    const player = Object.assign(Object.create(methods), {
        // Transcode started at 10:00; the element reports 30 s into it
        _transcodingOffsetTicks: 6000000000,
        _backend: { getCurrentTime: () => 30 },
        seek(ticks) {
            seeks.push(ticks);
        }
    });

    player.seekRelative(10000);
    assert.deepStrictEqual(seeks, [(600 + 30 + 10) * 10000000], 'skip forward jumped back to the start of the file');
});
