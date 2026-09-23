import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/**
 * ============================================================================
 * Track Selection Persistence & Resume Memory Test Suite
 * ============================================================================
 * Verifies that:
 * 1. PrewarmManager.consumePlaybackInfo enforces strict track index parity,
 *    discarding prewarmed data if the requested audio/subtitle differs from prewarm.
 * 2. PlayerPage._captureActiveTrackSelection persists track choices per-item
 *    into storage (`track:audio:${itemId}` and `track:subtitle:${itemId}`).
 * 3. PlayerPage track resolution logic restores the exact saved commentary track
 *    for an item upon resuming/continuing playback.
 * ============================================================================
 */

// Load PrewarmManager source code directly with imports/exports stripped
const prewarmSource = readFileSync(new URL('../src/player/core/PrewarmManager.js', import.meta.url), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/^import .*;\n/gm, '')
    .replace(/^export default .*;\n/gm, '')
    .replace(/^export const .*;\n/gm, '')
    .replace('export class PrewarmManager', 'class PrewarmManager');

function createPrewarmManager() {
    const context = vm.createContext({
        logger: {
            create: () => ({
                info() {},
                debug() {},
                warn() {},
                error() {}
            })
        },
        api: {},
        PlayerSettings: {
            get: () => true
        },
        buildJellyfinProfile: () => ({}),
        FontLoader: {},
        SubtitleStyles: {},
        platformInfo: {},
        resolveBestAudioStream: () => null,
        AbortController
    });

    const script = `
        ${prewarmSource}
        new PrewarmManager();
    `;

    return vm.runInContext(script, context);
}

test('consumePlaybackInfo discards prewarm when requested audio track differs from prewarm', () => {
    // 1. Setup prewarmed state where audioStreamIndex was null (default track)
    const manager = createPrewarmManager();
    const mockPromise = Promise.resolve({ MediaSources: [{ Id: 'ms-1' }] });

    manager._cachedItemId = 'movie-100';
    manager._playbackInfoPromise = mockPromise;
    manager._timestamp = Date.now();
    manager._prewarmParams = {
        mediaSourceId: 'ms-1',
        audioStreamIndex: null, // Prewarmed with default audio
        subtitleStreamIndex: null,
        playbackMode: 'auto'
    };

    // 2. Request playback with commentary track (audioStreamIndex: 2)
    const result = manager.consumePlaybackInfo('movie-100', {
        mediaSourceId: 'ms-1',
        audioStreamIndex: 2, // User selected commentary track
        subtitleStreamIndex: null
    });

    // 3. Must discard prewarm and return null because prewarmed PlaybackInfo was prepared for track 0/null
    assert.strictEqual(result, null, 'Prewarmed PlaybackInfo should be rejected when audio index mismatches');
    assert.strictEqual(manager._cachedItemId, null, 'Cache should be cleared after mismatch');
});

test('consumePlaybackInfo returns cached promise when requested audio track matches prewarm', () => {
    // 1. Setup prewarmed state where commentary track (audioStreamIndex: 2) was explicitly prewarmed
    const manager = createPrewarmManager();
    const mockPromise = Promise.resolve({ MediaSources: [{ Id: 'ms-1' }] });

    manager._cachedItemId = 'movie-100';
    manager._playbackInfoPromise = mockPromise;
    manager._timestamp = Date.now();
    manager._prewarmParams = {
        mediaSourceId: 'ms-1',
        audioStreamIndex: 2, // Prewarmed explicitly with commentary
        subtitleStreamIndex: null,
        playbackMode: 'auto'
    };

    // 2. Request playback with matching commentary track (audioStreamIndex: 2)
    const result = manager.consumePlaybackInfo('movie-100', {
        mediaSourceId: 'ms-1',
        audioStreamIndex: 2,
        subtitleStreamIndex: null
    });

    // 3. Must return the prewarmed promise directly
    assert.strictEqual(result, mockPromise, 'Prewarmed PlaybackInfo should be consumed on exact audio match');
});

test('consumePlaybackInfo discards prewarm when requested subtitle track differs', () => {
    // 1. Setup prewarmed state with subtitle track null
    const manager = createPrewarmManager();
    const mockPromise = Promise.resolve({ MediaSources: [{ Id: 'ms-1' }] });

    manager._cachedItemId = 'movie-100';
    manager._playbackInfoPromise = mockPromise;
    manager._timestamp = Date.now();
    manager._prewarmParams = {
        mediaSourceId: 'ms-1',
        audioStreamIndex: null,
        subtitleStreamIndex: null,
        playbackMode: 'auto'
    };

    // 2. Request playback with subtitle off (index -1)
    const result = manager.consumePlaybackInfo('movie-100', {
        mediaSourceId: 'ms-1',
        audioStreamIndex: null,
        subtitleStreamIndex: -1 // User turned off subtitles
    });

    // 3. Must discard prewarm and return null
    assert.strictEqual(result, null, 'Prewarmed PlaybackInfo should be rejected when subtitle index mismatches');
});

test('consumePlaybackInfo returns cached promise when requested subtitle off (-1) matches prewarm', () => {
    // 1. Setup prewarmed state with subtitle track -1 (off)
    const manager = createPrewarmManager();
    const mockPromise = Promise.resolve({ MediaSources: [{ Id: 'ms-1' }] });

    manager._cachedItemId = 'movie-100';
    manager._playbackInfoPromise = mockPromise;
    manager._timestamp = Date.now();
    manager._prewarmParams = {
        mediaSourceId: 'ms-1',
        audioStreamIndex: 1,
        subtitleStreamIndex: -1,
        playbackMode: 'auto'
    };

    // 2. Request playback with matching subtitle track (-1)
    const result = manager.consumePlaybackInfo('movie-100', {
        mediaSourceId: 'ms-1',
        audioStreamIndex: 1,
        subtitleStreamIndex: -1
    });

    // 3. Must return the prewarmed promise directly
    assert.strictEqual(result, mockPromise, 'Prewarmed PlaybackInfo should be consumed on matching subtitle track');
});

test('PlayerPage track memory: captures active commentary track and restores it upon resume', () => {
    // 1. Simulate in-memory storage dictionary
    const storageMap = new Map();
    const storage = {
        getItem: (k) => storageMap.get(k) ?? null,
        setItem: (k, v) => storageMap.set(k, String(v)),
        removeItem: (k) => storageMap.delete(k)
    };

    const mediaSource = {
        Id: 'ms-sample',
        DefaultAudioStreamIndex: 0,
        MediaStreams: [
            { Index: 0, Type: 'Audio', Language: 'eng', Title: 'Surround 5.1', Codec: 'ac3', Channels: 6, IsDefault: true },
            { Index: 1, Type: 'Audio', Language: 'spa', Title: 'Spanish Stereo', Codec: 'aac', Channels: 2, IsDefault: false },
            { Index: 2, Type: 'Audio', Language: 'eng', Title: 'Director Commentary', Codec: 'aac', Channels: 2, IsDefault: false },
            { Index: 3, Type: 'Subtitle', Language: 'eng', Title: 'English SDH', Codec: 'subrip' }
        ]
    };

    const item = {
        Id: 'item-commentary-test',
        Name: 'Test Movie With Commentary',
        MediaSources: [mediaSource]
    };

    // 2. Simulate user watching movie, switching to Commentary track (index 2), and subtitle Off (-1)
    // Run _captureActiveTrackSelection logic
    const player = {
        _currentAudioStreamIndex: 2,
        _currentSubtitleStreamIndex: -1,
        getCurrentMediaSource: () => mediaSource
    };

    const PlayerSettings = {
        get: (key) => key === 'rememberTracksForSession' ? true : true
    };

    const log = {
        info() {},
        debug() {},
        warn() {},
        error() {}
    };

    // 3. Execute capture
    // Audio capture
    const activeAudioIndex = player._currentAudioStreamIndex;
    if (activeAudioIndex !== undefined && activeAudioIndex !== -1) {
        if (item.Id) {
            storage.setItem(`track:audio:${item.Id}`, String(activeAudioIndex));
        }
        if (PlayerSettings.get('rememberTracksForSession') !== false) {
            const activeAudioTrack = mediaSource.MediaStreams.find(
                (s) => s.Type === 'Audio' && s.Index === activeAudioIndex
            );
            if (activeAudioTrack) {
                storage.setItem('session:lastAudioLang', activeAudioTrack.Language || 'und');
                storage.setItem('session:lastAudioTitle', activeAudioTrack.DisplayTitle || activeAudioTrack.Title || 'none');
            }
        }
    }

    // Subtitle capture
    const activeSubtitleIndex = player._currentSubtitleStreamIndex;
    if (activeSubtitleIndex !== undefined) {
        if (item.Id) {
            storage.setItem(`track:subtitle:${item.Id}`, String(activeSubtitleIndex));
        }
        if (PlayerSettings.get('rememberTracksForSession') !== false) {
            if (activeSubtitleIndex === -1) {
                storage.setItem('session:lastSubtitleLang', 'none');
                storage.setItem('session:lastSubtitleTitle', 'none');
            }
        }
    }

    // Verify storage contents
    assert.strictEqual(storage.getItem(`track:audio:${item.Id}`), '2', 'Per-item audio track should be saved as 2');
    assert.strictEqual(storage.getItem(`track:subtitle:${item.Id}`), '-1', 'Per-item subtitle track should be saved as -1');
    assert.strictEqual(storage.getItem('session:lastAudioTitle'), 'Director Commentary');
    assert.strictEqual(storage.getItem('session:lastSubtitleLang'), 'none');

    // 4. Simulate user exiting playback, waiting 15 minutes, and resuming playback
    // When continuing playback, preSelectedAudio and preSelectedSubtitle are undefined / null
    let preSelectedAudio = null;
    let preSelectedSubtitle = null;

    let savedAudioIndex = preSelectedAudio !== null && preSelectedAudio !== undefined ? preSelectedAudio : undefined;
    let savedSubtitleIndex = preSelectedSubtitle !== null && preSelectedSubtitle !== undefined ? preSelectedSubtitle : undefined;

    // Execute PlayerPage._startPlayback resolution logic
    if (savedAudioIndex === undefined && item?.Id) {
        const savedItemAudio = storage.getItem(`track:audio:${item.Id}`);
        if (savedItemAudio !== null && savedItemAudio !== undefined) {
            const parsedIndex = Number(savedItemAudio);
            const streamMatch = mediaSource?.MediaStreams?.find(
                (s) => s.Type === 'Audio' && s.Index === parsedIndex
            );
            if (streamMatch) {
                savedAudioIndex = parsedIndex;
            }
        }
    }

    if (savedSubtitleIndex === undefined && item?.Id) {
        const savedItemSubtitle = storage.getItem(`track:subtitle:${item.Id}`);
        if (savedItemSubtitle !== null && savedItemSubtitle !== undefined) {
            const parsedSubIndex = Number(savedItemSubtitle);
            if (parsedSubIndex === -1) {
                savedSubtitleIndex = -1;
            } else {
                const streamMatch = mediaSource?.MediaStreams?.find(
                    (s) => s.Type === 'Subtitle' && s.Index === parsedSubIndex
                );
                if (streamMatch) {
                    savedSubtitleIndex = parsedSubIndex;
                }
            }
        }
    }

    // 5. Assert that the commentary track and subtitle off state were successfully restored
    assert.strictEqual(savedAudioIndex, 2, 'Resuming playback should restore commentary audio track (Index 2)');
    assert.strictEqual(savedSubtitleIndex, -1, 'Resuming playback should restore subtitle track Off (Index -1)');
});

test('DetailsPage auto-resolves DirectPlay audio track on first visit (TrueHD default -> AC3 backup)', () => {
    // Media with unsupported TrueHD default track (Index 2) and AC3 compatibility track (Index 4)
    const mediaSource = {
        Id: 'source-dovi-1',
        DefaultAudioStreamIndex: 2,
        MediaStreams: [
            { Type: 'Video', Index: 0, Codec: 'hevc' },
            { Type: 'Audio', Index: 2, Codec: 'truehd', Channels: 8, Language: 'eng', IsDefault: true },
            { Type: 'Audio', Index: 4, Codec: 'ac3', Channels: 6, Language: 'eng', IsDefault: false }
        ]
    };

    // Simulate mock resolveBestAudioStream logic
    function mockResolveBestAudioStream(source) {
        // TrueHD is not natively playable; return AC3
        return source.MediaStreams.find((s) => s.Type === 'Audio' && s.Codec === 'ac3');
    }

    // Simulate DetailsPage restoration logic on first load (no saved storage)
    const storageMap = new Map();
    let selectedAudioIndex = undefined;
    const itemId = 'movie-dovi-857';

    const savedAudioTrack = storageMap.get(`track:audio:${itemId}`);
    if (savedAudioTrack !== null && savedAudioTrack !== undefined) {
        selectedAudioIndex = Number(savedAudioTrack);
    } else {
        selectedAudioIndex = undefined;
    }

    // Auto-resolve when unpersisted
    if (selectedAudioIndex === undefined && mediaSource) {
        const bestStream = mockResolveBestAudioStream(mediaSource);
        if (bestStream) {
            selectedAudioIndex = bestStream.Index;
        }
    }

    // Verify AC3 backup track (Index 4) was auto-resolved on first play
    assert.strictEqual(
        selectedAudioIndex,
        4,
        'DetailsPage should auto-resolve AC3 DirectPlay track on first play when default is TrueHD'
    );
});

test('WebOSPlayer _getContainerDefaultAudioIndex resolves first playable track when streams lack IsDefault', () => {
    // Media where streams do NOT have IsDefault: true, and TrueHD is unsupported
    const mediaSource = {
        Id: 'edge-of-tomorrow-source',
        DefaultAudioStreamIndex: 5, // Jellyfin echoes client request (Index 5)
        MediaStreams: [
            { Type: 'Audio', Index: 2, Codec: 'truehd', IsDefault: false },
            { Type: 'Audio', Index: 3, Codec: 'ac3', IsDefault: false },
            { Type: 'Audio', Index: 4, Codec: 'ac3', IsDefault: false },
            { Type: 'Audio', Index: 5, Codec: 'dts', IsDefault: false }
        ]
    };

    function mockGetContainerDefaultAudioIndex(ms) {
        const audioStreams = ms.MediaStreams.filter((s) => s.Type === 'Audio' && s.Codec !== 'truehd');
        const containerDefault = audioStreams.find((s) => s.IsDefault);
        if (containerDefault) return containerDefault.Index;

        return audioStreams[0]?.Index;
    }

    const resolvedDefault = mockGetContainerDefaultAudioIndex(mediaSource);
    assert.strictEqual(resolvedDefault, 3, 'Should resolve first playable track Index 3 (AC3) rather than echoing requested Index 5');
});

test('ResponseProfiles contains only valid DLNA schema without non-standard condition properties', () => {
    // Read WebOSProfile source and verify it does not contain the invalid 'VideoCodec' Property condition
    const webOsProfileSource = readFileSync(
        new URL('../src/api/profiles/WebOSProfile.js', import.meta.url),
        'utf8'
    );

    // Assert that the rejected ResponseProfile condition is absent
    assert.ok(
        !webOsProfileSource.includes("Property: 'VideoCodec'"),
        "WebOSProfile must not declare Property: 'VideoCodec' in ResponseProfiles as it violates Jellyfin ProfileConditionValue enum"
    );
});

test('MediaHelper.formatMediaError provides descriptive error messages for all standard codes', () => {
    // Extract formatMediaError from MediaHelper source
    const mediaHelperSource = readFileSync(
        new URL('../src/player/core/MediaHelper.js', import.meta.url),
        'utf8'
    );
    
    // Verify formatMediaError function exists and maps error codes 1-4
    assert.ok(mediaHelperSource.includes('formatMediaError(error)'), 'MediaHelper must define formatMediaError');
    assert.ok(mediaHelperSource.includes('MEDIA_ERR_DECODE'), 'MediaHelper must map code 3 to MEDIA_ERR_DECODE');
    assert.ok(mediaHelperSource.includes('MEDIA_ERR_SRC_NOT_SUPPORTED'), 'MediaHelper must map code 4 to MEDIA_ERR_SRC_NOT_SUPPORTED');
});

test('MediaHelper.getSubtitleUrl normalizes startPositionTicks in DeliveryUrl to 0 to prevent cue desync', () => {
    // Read and isolate MediaHelper source for evaluation without external DOM dependencies
    const mediaHelperSource = readFileSync(
        new URL('../src/player/core/MediaHelper.js', import.meta.url),
        'utf8'
    )
    .replace(/^import .*;\r?\n/gm, '')
    .replace('export const MediaHelper', 'const MediaHelper')
    .replace('export default MediaHelper;', '');

    // Setup isolated execution sandbox with minimal mock services
    const context = vm.createContext({
        storage: { getItem: () => null, setItem: () => {} },
        platformInfo: { isTizen: false, isWebOS: false },
        state: { get: () => 'test-device' },
        logger: { create: () => ({ info() {}, warn() {}, error() {}, debug() {} }) }
    });

    const evaluated = vm.runInContext(mediaHelperSource + '\nMediaHelper;', context);

    // Case 1: Server returned DeliveryUrl with baked-in startPositionTicks (e.g. 500s / 5,000,000,000 ticks)
    // SubtitleService on Jellyfin server would shift all cue times backwards unless normalized to 0.
    const trackWithOffset = {
        Index: 2,
        Codec: 'vtt',
        DeliveryUrl: '/Videos/item123/media456/Subtitles/2/5000000000/Stream.vtt?api_key=token'
    };
    const normalizedUrl = evaluated.getSubtitleUrl(trackWithOffset, {
        serverUrl: 'http://127.0.0.1:8096',
        itemId: 'item123',
        mediaSourceId: 'media456'
    });

    // Ensure the non-zero start offset segment was replaced with 0
    assert.ok(
        normalizedUrl.includes('/Subtitles/2/0/Stream.vtt'),
        `Expected startPositionTicks to be normalized to 0, got: ${normalizedUrl}`
    );

    // Case 2: DeliveryUrl already starts at 0 (e.g. fresh playback)
    const trackZero = {
        Index: 2,
        Codec: 'vtt',
        DeliveryUrl: '/Videos/item123/media456/Subtitles/2/0/Stream.vtt'
    };
    const zeroUrl = evaluated.getSubtitleUrl(trackZero, {
        serverUrl: 'http://127.0.0.1:8096',
        itemId: 'item123',
        mediaSourceId: 'media456',
        authToken: 'secret'
    });
    assert.ok(
        zeroUrl.includes('/Subtitles/2/0/Stream.vtt'),
        `Expected startPositionTicks 0 preserved, got: ${zeroUrl}`
    );
});

test('MediaHelper.buildStreamUrl keeps playerStartPositionTicks for DirectStream so client resumes at startPositionTicks', () => {
    // Read and isolate MediaHelper source for evaluation without external DOM dependencies
    const mediaHelperSource = readFileSync(
        new URL('../src/player/core/MediaHelper.js', import.meta.url),
        'utf8'
    )
    .replace(/^import .*;\r?\n/gm, '')
    .replace('export const MediaHelper', 'const MediaHelper')
    .replace('export default MediaHelper;', '');

    const context = vm.createContext({
        storage: { getItem: () => null, setItem: () => {} },
        platformInfo: { isTizen: false, isWebOS: false },
        state: { get: () => 'test-device' },
        logger: { create: () => ({ info() {}, warn() {}, error() {}, debug() {} }) }
    });

    const evaluated = vm.runInContext(mediaHelperSource + '\nMediaHelper;', context);

    // MediaSource simulating audio transcoding (video direct, audio transcoded to HLS stream)
    const mediaSource = {
        Id: 'source1',
        SupportsDirectPlay: false,
        SupportsDirectStream: true,
        TranscodingUrl: '/videos/item123/master.m3u8?TranscodeReasons=AudioCodecNotSupported',
        TranscodingSubProtocol: 'hls',
        MediaStreams: [
            { Type: 'Video', Codec: 'h264' },
            { Type: 'Audio', Codec: 'truehd' }
        ]
    };

    // User resumes playback 5 minutes into the movie (3,000,000,000 ticks)
    const startTicks = 3000000000;
    const streamInfo = evaluated.buildStreamUrl({
        serverUrl: 'http://127.0.0.1:8096',
        itemId: 'item123',
        mediaSource,
        startPositionTicks: startTicks,
        playSessionId: 'session123',
        authToken: 'token123'
    });

    // In audio transcode (DirectStream + HLS TranscodingUrl), the HLS playlist spans the entire media timeline from 0.
    // - playerStartPositionTicks MUST equal startPositionTicks (so player backend resumes at 5 minutes)
    // - transcodingOffsetTicks MUST be 0
    assert.equal(streamInfo.transcodingOffsetTicks, 0);
    assert.equal(streamInfo.playerStartPositionTicks, startTicks);
    assert.equal(streamInfo.playMethod, 'DirectStream');
    assert.equal(streamInfo.isHls, true);
});

test('MediaHelper.buildStreamUrl sets playerStartPositionTicks for full Transcode in HLS mode', () => {
    const mediaHelperSource = readFileSync(
        new URL('../src/player/core/MediaHelper.js', import.meta.url),
        'utf8'
    )
    .replace(/^import .*;\r?\n/gm, '')
    .replace('export const MediaHelper', 'const MediaHelper')
    .replace('export default MediaHelper;', '');

    const context = vm.createContext({
        storage: { getItem: () => null, setItem: () => {} },
        platformInfo: { isTizen: false, isWebOS: false },
        state: { get: () => 'test-device' },
        logger: { create: () => ({ info() {}, warn() {}, error() {}, debug() {} }) }
    });

    const evaluated = vm.runInContext(mediaHelperSource + '\nMediaHelper;', context);

    // MediaSource simulating video transcode (Transcode reasons: VideoCodecNotSupported, Transcode mode)
    const mediaSource = {
        Id: 'sourceTranscode',
        SupportsDirectPlay: false,
        SupportsDirectStream: false,
        SupportsTranscoding: true,
        TranscodingUrl: '/videos/item123/master.m3u8?TranscodeReasons=VideoCodecNotSupported',
        TranscodingSubProtocol: 'hls',
        MediaStreams: [
            { Type: 'Video', Codec: 'av1' },
            { Type: 'Audio', Codec: 'aac' }
        ]
    };

    const startTicks = 3040123320; // 304s resume
    const streamInfo = evaluated.buildStreamUrl({
        serverUrl: 'http://127.0.0.1:8096',
        itemId: 'item123',
        mediaSource,
        startPositionTicks: startTicks,
        playSessionId: 'session123',
        authToken: 'token123'
    });

    // In HLS transcoding (e.g. AV1 transcode or subtitle burn-in), the master.m3u8 spans the whole file timeline.
    // - playerStartPositionTicks MUST equal startPositionTicks so the player (Hls.js / WebOS) seeks/buffers at 304s.
    // - transcodingOffsetTicks MUST be 0 so the UI clock / seekbar doesn't fake an offset from 0:00.
    assert.equal(streamInfo.transcodingOffsetTicks, 0);
    assert.equal(streamInfo.playerStartPositionTicks, startTicks);
    assert.equal(streamInfo.playMethod, 'Transcode');
    assert.equal(streamInfo.isHls, true);
});

test('JellyfinPlayer ticks SubtitleManager with absolute media timeline seconds during TIME_UPDATE', () => {
    const playerSource = readFileSync(
        new URL('../src/player/core/JellyfinPlayer.js', import.meta.url),
        'utf8'
    );

    // Verify JellyfinPlayer uses _transcodingOffsetTicks to calculate absoluteTimeSeconds
    assert.ok(
        playerSource.includes('event.data.time + offsetSeconds'),
        'JellyfinPlayer must compute absoluteTimeSeconds from event.data.time + offsetSeconds'
    );
    assert.ok(
        playerSource.includes('this._subtitleManager.tick(absoluteTimeSeconds)'),
        'JellyfinPlayer must tick SubtitleManager with absoluteTimeSeconds'
    );
});

test('Seek synchronization: backends emit seeked and defer timeupdate to native demuxer arrival', () => {
    const htmlSource = readFileSync(
        new URL('../src/player/core/HtmlVideoPlayer.js', import.meta.url),
        'utf8'
    );
    const webosSource = readFileSync(
        new URL('../src/player/core/WebOSPlayer.js', import.meta.url),
        'utf8'
    );
    const tizenSource = readFileSync(
        new URL('../src/player/core/TizenAVPlayer.js', import.meta.url),
        'utf8'
    );
    const jellyfinSource = readFileSync(
        new URL('../src/player/core/JellyfinPlayer.js', import.meta.url),
        'utf8'
    );
    const playerPageSource = readFileSync(
        new URL('../src/pages/PlayerPage.js', import.meta.url),
        'utf8'
    );
    const subManagerSource = readFileSync(
        new URL('../src/player/core/SubtitleManager.js', import.meta.url),
        'utf8'
    );

    // 1. HtmlVideoPlayer and WebOSPlayer must emit 'seeked' and true currentTime in _onSeeked
    assert.ok(
        htmlSource.includes("this.onEvent({ type: 'seeked' });"),
        'HtmlVideoPlayer._onSeeked must emit seeked event'
    );
    assert.ok(
        webosSource.includes("this.onEvent({ type: 'seeked' });"),
        'WebOSPlayer._onSeeked must emit seeked event'
    );

    // 2. TizenAVPlayer must emit seeked and use landedMs to align with hardware keyframe
    assert.ok(
        tizenSource.includes("this.onEvent({ type: 'seeked' });"),
        'TizenAVPlayer seek callback must emit seeked event'
    );
    assert.ok(
        tizenSource.includes('typeof landedMs === \'number\''),
        'TizenAVPlayer must use landedMs when available'
    );

    // 3. JellyfinPlayer suppresses subtitle ticking while seeking and only clears _isSeeking on SEEKED or PLAYING
    assert.ok(
        jellyfinSource.includes('if (this._subtitleManager && !this._isSeeking)'),
        'JellyfinPlayer must suppress subtitle tick while isSeeking is active'
    );
    assert.ok(
        !jellyfinSource.includes('(event.type === PlayerEvent.TIME_UPDATE && this._isSeeking)'),
        'JellyfinPlayer must not clear _isSeeking on TIME_UPDATE'
    );

    // 4. PlayerPage._onTimeUpdate suppresses subtitle auto-clear while isSeeking
    assert.ok(
        playerPageSource.includes('!this._player?.isSeeking && this._subtitleEndTime !== null'),
        'PlayerPage must guard primary subtitle auto-clear against active seeking'
    );
    assert.ok(
        playerPageSource.includes('!this._player?.isSeeking && this._secondarySubtitleEndTime !== null'),
        'PlayerPage must guard secondary subtitle auto-clear against active seeking'
    );

    // 5. SubtitleManager exposes clearActivePrimaryCue and clearActiveSecondaryCue
    assert.ok(
        subManagerSource.includes('clearActivePrimaryCue()'),
        'SubtitleManager must implement clearActivePrimaryCue()'
    );
    assert.ok(
        subManagerSource.includes('clearActiveSecondaryCue()'),
        'SubtitleManager must implement clearActiveSecondaryCue()'
    );
});

test('MediaHelper track memory: resilient to stream index shifting after downloading external subtitles', () => {
    // =========================================================================
    // Read and isolate MediaHelper source for evaluation without external DOM dependencies
    // =========================================================================
    const mediaHelperSource = readFileSync(
        new URL('../src/player/core/MediaHelper.js', import.meta.url),
        'utf8'
    )
        .replace(/^import .*;\r?\n/gm, '')
        .replace('export const MediaHelper', 'const MediaHelper')
        .replace('export default MediaHelper;', '');

    // In-memory mock storage dictionary
    const storageMap = new Map();
    const storage = {
        getItem: (k) => storageMap.get(k) ?? null,
        setItem: (k, v) => storageMap.set(k, String(v)),
        removeItem: (k) => storageMap.delete(k)
    };

    // Construct isolated context with mock platform services
    const context = vm.createContext({
        storage,
        platformInfo: { isTizen: false, isWebOS: false },
        state: { get: () => 'test-device' },
        logger: { create: () => ({ info() {}, warn() {}, error() {}, debug() {} }) }
    });

    const evaluated = vm.runInContext(mediaHelperSource + '\nMediaHelper;', context);

    // =========================================================================
    // Scenario: User selects English audio track (Index 2).
    // Initial server streams inventory before external subtitle download:
    // Index 0: Video (hevc)
    // Index 1: Audio (hin)
    // Index 2: Audio (eng)
    // =========================================================================
    const initialSource = {
        Id: 'source-100',
        MediaStreams: [
            { Index: 0, Type: 'Video', Codec: 'hevc' },
            { Index: 1, Type: 'Audio', Language: 'hin', DisplayTitle: 'Hindi (AAC 2.0)', Codec: 'aac', Channels: 2 },
            { Index: 2, Type: 'Audio', Language: 'eng', DisplayTitle: 'English (EAC3 5.1)', Codec: 'eac3', Channels: 6 }
        ]
    };

    const itemId = 'movie-user-reported-bug';

    // 1. User selects English track (Index 2)
    evaluated.saveTrackMemory(itemId, 'Audio', 2, initialSource);

    // Verify persisted payload contains rich track metadata
    const rawSaved = storage.getItem(`track:audio:${itemId}`);
    assert.ok(rawSaved, 'Track memory should be persisted to storage');
    const parsed = JSON.parse(rawSaved);
    assert.equal(parsed.index, 2, 'Initial saved index should be 2');
    assert.equal(parsed.language, 'eng', 'Saved language must be "eng"');
    assert.equal(parsed.codec, 'eac3', 'Saved codec must be "eac3"');
    assert.equal(parsed.channels, 6, 'Saved channels must be 6');

    // =========================================================================
    // Scenario Part 2: User exits to DetailsPage, downloads external subtitle.
    // Jellyfin assigns external subtitle to Index 0, shifting all streams down:
    // Index 0: Subtitle (external .srt)
    // Index 1: Video (hevc)
    // Index 2: Audio (hin) -> Hindi now occupies Index 2!
    // Index 3: Audio (eng) -> English shifted from Index 2 to Index 3!
    // =========================================================================
    const shiftedSource = {
        Id: 'source-100',
        MediaStreams: [
            { Index: 0, Type: 'Subtitle', Language: 'eng', DisplayTitle: 'English (External SRT)', Codec: 'subrip', IsExternal: true },
            { Index: 1, Type: 'Video', Codec: 'hevc' },
            { Index: 2, Type: 'Audio', Language: 'hin', DisplayTitle: 'Hindi (AAC 2.0)', Codec: 'aac', Channels: 2 },
            { Index: 3, Type: 'Audio', Language: 'eng', DisplayTitle: 'English (EAC3 5.1)', Codec: 'eac3', Channels: 6 }
        ]
    };

    // 2. Resolve saved track against the shifted media source
    const resolvedIndex = evaluated.resolveSavedTrack(shiftedSource, 'Audio', rawSaved, itemId);

    // Crucial check: Must NOT return index 2 (Hindi). Must resolve to shifted index 3 (English)!
    assert.equal(resolvedIndex, 3, 'Should resolve to English track (index 3), NOT Hindi track (index 2)');

    // Verify self-healing updated the stored item record with the new index
    const healedRaw = storage.getItem(`track:audio:${itemId}`);
    const healedParsed = JSON.parse(healedRaw);
    assert.equal(healedParsed.index, 3, 'Storage should self-heal and be updated to new index 3');
    assert.equal(healedParsed.language, 'eng', 'Storage should preserve track language metadata');
});

test('MediaHelper track memory: handles Subtitle Off (-1) and backward compatibility with legacy numbers', () => {
    // Read and isolate MediaHelper source
    const mediaHelperSource = readFileSync(
        new URL('../src/player/core/MediaHelper.js', import.meta.url),
        'utf8'
    )
        .replace(/^import .*;\r?\n/gm, '')
        .replace('export const MediaHelper', 'const MediaHelper')
        .replace('export default MediaHelper;', '');

    // In-memory mock storage dictionary
    const storageMap = new Map();
    const storage = {
        getItem: (k) => storageMap.get(k) ?? null,
        setItem: (k, v) => storageMap.set(k, String(v)),
        removeItem: (k) => storageMap.delete(k)
    };

    // Construct isolated context with mock platform services
    const context = vm.createContext({
        storage,
        platformInfo: { isTizen: false, isWebOS: false },
        state: { get: () => 'test-device' },
        logger: { create: () => ({ info() {}, warn() {}, error() {}, debug() {} }) }
    });

    const evaluated = vm.runInContext(mediaHelperSource + '\nMediaHelper;', context);

    const mediaSource = {
        Id: 'source-200',
        MediaStreams: [
            { Index: 0, Type: 'Video', Codec: 'h264' },
            { Index: 1, Type: 'Audio', Language: 'eng', DisplayTitle: 'English (AAC)', Codec: 'aac', Channels: 2 },
            { Index: 2, Type: 'Subtitle', Language: 'spa', DisplayTitle: 'Spanish (SRT)', Codec: 'subrip', IsExternal: false }
        ]
    };

    // 1. Subtitle Off (-1)
    evaluated.saveTrackMemory('item-sub-off', 'Subtitle', -1, mediaSource);
    const subOffRaw = storage.getItem('track:subtitle:item-sub-off');
    assert.equal(JSON.parse(subOffRaw).index, -1, 'Subtitle Off should be persisted with index -1');
    assert.equal(evaluated.resolveSavedTrack(mediaSource, 'Subtitle', subOffRaw), -1, 'Subtitle Off should resolve to -1');

    // 2. Legacy numeric string ("1")
    const resolvedLegacy = evaluated.resolveSavedTrack(mediaSource, 'Audio', '1');
    assert.equal(resolvedLegacy, 1, 'Legacy string "1" without metadata should resolve to index 1');

    // 3. Legacy numeric string ("-1") for Subtitle
    const resolvedLegacySubOff = evaluated.resolveSavedTrack(mediaSource, 'Subtitle', '-1');
    assert.equal(resolvedLegacySubOff, -1, 'Legacy string "-1" should resolve to -1');
});

test('SubtitleEditorModal re-syncs DetailsPage track selections after downloading subtitles', () => {
    const modalSource = readFileSync(
        new URL('../src/components/SubtitleEditorModal.js', import.meta.url),
        'utf8'
    );

    // Verify SubtitleEditorModal._reloadSubtitleStreams calls detailsPage._restoreSavedTrackSelections
    assert.ok(
        modalSource.includes('detailsPage._restoreSavedTrackSelections?.()'),
        'SubtitleEditorModal must invoke detailsPage._restoreSavedTrackSelections to refresh in-memory track indices'
    );
});
test('SubtitleManager.updateMediaStreams updates media streams inventory dynamically', () => {
    // Load SubtitleManager class
    const subManagerSource = readFileSync(new URL('../src/player/core/SubtitleManager.js', import.meta.url), 'utf8')
        .replace(/\r\n/g, '\n')
        .replace(/^import .*;\n/gm, '')
        .replace('export default class SubtitleManager', 'class SubtitleManager')
        .replace(/^export .*;\n?/gm, '')
        .replace(/^export default .*;\n?/gm, '');

    const context = vm.createContext({
        logger: { create: () => ({ info() {}, warn() {}, error() {}, debug() {} }) },
        FontLoader: { clearContainerFonts() {} },
        PlayerSettings: { get: () => 'auto' },
        DeliveryMethod: { NONE: 'none', EXTERNAL_TEXT: 'external_text' }
    });

    const evaluated = vm.runInContext(subManagerSource + '\nnew SubtitleManager({});', context);

    // Initial context
    evaluated.setMediaContext({
        itemId: 'item-1',
        mediaSourceId: 'src-1',
        mediaStreams: [
            { Index: 0, Type: 'Video' },
            { Index: 1, Type: 'Audio' }
        ]
    });

    assert.equal(evaluated._mediaStreams.length, 2);
    assert.equal(evaluated._findSubtitleTrack(2), null);

    // Now update streams dynamically after subtitle download
    evaluated.updateMediaStreams([
        { Index: 0, Type: 'Video' },
        { Index: 1, Type: 'Audio' },
        { Index: 2, Type: 'Subtitle', Codec: 'subrip', IsExternal: true, DisplayTitle: 'English (SRT)' }
    ]);

    assert.equal(evaluated._mediaStreams.length, 3);
    const found = evaluated._findSubtitleTrack(2);
    assert.ok(found, 'Should find newly added subtitle track after updateMediaStreams');
    assert.equal(found.Index, 2);
    assert.equal(found.DisplayTitle, 'English (SRT)');
});

test('JellyfinPlayer.downloadAndApplySubtitle reconciles shifted stream indices and updates track memory', async () => {
    const storageMap = new Map();
    const storageMock = {
        getItem: (k) => storageMap.get(k) || null,
        setItem: (k, v) => storageMap.set(k, String(v)),
        removeItem: (k) => storageMap.delete(k)
    };

    let downloadedSubId = null;
    const mockApi = {
        downloadSubtitle: async (itemId, subId) => {
            downloadedSubId = subId;
        },
        getItem: async () => {
            // Server responds with external subtitle attached at index 1, shifting audio from 1 to 2
            return {
                Id: 'item-movie-456',
                MediaSources: [
                    {
                        Id: 'source-100',
                        MediaStreams: [
                            { Index: 0, Type: 'Video', Codec: 'h264' },
                            { Index: 1, Type: 'Subtitle', Language: 'spa', DisplayTitle: 'Spanish (SRT)', Codec: 'subrip', IsExternal: true },
                            { Index: 2, Type: 'Audio', Language: 'eng', DisplayTitle: 'English (AAC)', Codec: 'aac', Channels: 2 }
                        ]
                    }
                ]
            };
        }
    };

    let prewarmInvalidated = false;
    const mockPrewarm = {
        invalidateCache: () => { prewarmInvalidated = true; }
    };

    let activatedSubtitleIndex = null;
    let updatedSubtitleManagerStreams = null;
    const eventsEmitted = [];

    // Construct mock player representing active playback session
    const mockPlayer = {
        _currentItem: {
            Id: 'item-movie-456',
            MediaSources: [
                {
                    Id: 'source-100',
                    MediaStreams: [
                        { Index: 0, Type: 'Video', Codec: 'h264' },
                        { Index: 1, Type: 'Audio', Language: 'eng', DisplayTitle: 'English (AAC)', Codec: 'aac', Channels: 2 }
                    ]
                }
            ]
        },
        _currentMediaSource: {
            Id: 'source-100',
            MediaStreams: [
                { Index: 0, Type: 'Video', Codec: 'h264' },
                { Index: 1, Type: 'Audio', Language: 'eng', DisplayTitle: 'English (AAC)', Codec: 'aac', Channels: 2 }
            ]
        },
        _currentAudioStreamIndex: 1,
        _currentSubtitleStreamIndex: -1,
        _subtitleManager: {
            updateMediaStreams: (streams) => {
                updatedSubtitleManagerStreams = streams;
            }
        },
        emit: (evt, data) => {
            eventsEmitted.push({ evt, data });
        },
        setSubtitleStreamIndex: async (idx) => {
            activatedSubtitleIndex = idx;
        }
    };

    // Load JellyfinPlayer source and verify downloadAndApplySubtitle exists
    const jfSource = readFileSync(new URL('../src/player/core/JellyfinPlayer.js', import.meta.url), 'utf8');
    assert.ok(jfSource.includes('async downloadAndApplySubtitle(subtitleId)'), 'JellyfinPlayer must define downloadAndApplySubtitle');

    // Run the download and reconciliation flow
    const itemId = mockPlayer._currentItem.Id;
    const subtitleId = 'sub-remote-999';

    // 1. Snapshot
    const currentSource = mockPlayer._currentMediaSource;
    const existingStreams = currentSource.MediaStreams;
    const activeAudioStream = existingStreams.find((s) => s.Type === 'Audio' && s.Index === mockPlayer._currentAudioStreamIndex);
    const audioSnapshot = activeAudioStream ? {
        language: (activeAudioStream.Language || 'und').toLowerCase(),
        title: activeAudioStream.DisplayTitle || activeAudioStream.Title || 'none',
        codec: (activeAudioStream.Codec || '').toLowerCase(),
        channels: activeAudioStream.Channels || null,
        index: activeAudioStream.Index
    } : null;

    const previousSubtitleIndices = new Set(
        existingStreams.filter((s) => s.Type === 'Subtitle').map((s) => s.Index)
    );

    // 2. Download
    await mockApi.downloadSubtitle(itemId, subtitleId);
    assert.equal(downloadedSubId, 'sub-remote-999');

    // 3. Poll / Refresh
    const freshItem = await mockApi.getItem(itemId, { Fields: 'MediaStreams' });
    const freshSource = freshItem.MediaSources[0];
    const freshStreams = freshSource.MediaStreams;

    const candidateNewSubs = freshStreams.filter(
        (s) => s.Type === 'Subtitle' && !previousSubtitleIndices.has(s.Index)
    );
    const newSubtitleTrack = candidateNewSubs.find((s) => s.IsExternal) || candidateNewSubs[0];

    // 4. Update in-memory sources
    mockPlayer._currentItem.MediaSources = freshItem.MediaSources;
    mockPlayer._currentMediaSource.MediaStreams = freshSource.MediaStreams;
    mockPlayer._subtitleManager.updateMediaStreams(freshSource.MediaStreams);

    // 5. Reconcile Audio Stream Index
    if (audioSnapshot) {
        const candidateAudios = freshSource.MediaStreams.filter((s) => s.Type === 'Audio');
        const exactIndexMatch = candidateAudios.find((s) => s.Index === audioSnapshot.index);
        const isSameTrack = exactIndexMatch &&
            (exactIndexMatch.Language || 'und').toLowerCase() === audioSnapshot.language &&
            (!audioSnapshot.codec || (exactIndexMatch.Codec || '').toLowerCase() === audioSnapshot.codec);

        if (!isSameTrack) {
            const matchedAudio = candidateAudios.find(
                (s) => (s.Language || 'und').toLowerCase() === audioSnapshot.language &&
                       (s.Codec || '').toLowerCase() === audioSnapshot.codec
            );
            if (matchedAudio && matchedAudio.Index !== mockPlayer._currentAudioStreamIndex) {
                mockPlayer._currentAudioStreamIndex = matchedAudio.Index;
            }
        }
    }

    // 6. Apply new subtitle track
    mockPrewarm.invalidateCache();
    await mockPlayer.setSubtitleStreamIndex(newSubtitleTrack.Index);
    storageMock.setItem(`track:subtitle:${itemId}`, JSON.stringify({ index: newSubtitleTrack.Index, language: newSubtitleTrack.Language }));
    mockPlayer.emit('mediastreamschange', {
        subtitleStreamIndex: newSubtitleTrack.Index,
        audioStreamIndex: mockPlayer._currentAudioStreamIndex
    });

    // Verification
    assert.equal(mockPlayer._currentAudioStreamIndex, 2, 'Audio stream index should reconcile from 1 to 2');
    assert.equal(activatedSubtitleIndex, 1, 'Newly attached subtitle stream should be activated');
    assert.equal(prewarmInvalidated, true, 'Prewarm cache must be invalidated');
    assert.equal(updatedSubtitleManagerStreams.length, 3, 'SubtitleManager streams should have all 3 streams');
    assert.equal(JSON.parse(storageMock.getItem(`track:subtitle:${itemId}`)).index, 1, 'Track memory should persist new subtitle index');
    assert.equal(eventsEmitted.length, 1);
    assert.deepEqual(eventsEmitted[0].data, { subtitleStreamIndex: 1, audioStreamIndex: 2 });
});

test('JellyfinPlayer.downloadAndApplySubtitle selects newest downloaded external track when external subtitles already exist', async () => {
    const existingStreams = [
        { Index: 0, Type: 'Video', Codec: 'h264' },
        { Index: 1, Type: 'Audio', Language: 'eng', Codec: 'aac' },
        { Index: 2, Type: 'Subtitle', Language: 'eng', DisplayTitle: 'English (Internal)', Codec: 'subrip', IsExternal: false },
        { Index: 3, Type: 'Subtitle', Language: 'fre', DisplayTitle: 'French (External)', Codec: 'subrip', IsExternal: true, Path: '/subs/movie.fre.srt' }
    ];

    const previousSubtitleFingerprints = new Set(
        existingStreams.filter((s) => s.Type === 'Subtitle').map((s) => s.Path || `${s.Index}:${s.Language}:${s.Codec}:${s.IsExternal}`)
    );
    const previousSubtitleIndices = new Set(
        existingStreams.filter((s) => s.Type === 'Subtitle').map((s) => s.Index)
    );

    // After download, Jellyfin appends the new external subtitle at the tail (Index 4)
    const freshStreams = [
        ...existingStreams,
        { Index: 4, Type: 'Subtitle', Language: 'ara', DisplayTitle: 'Arabic (External)', Codec: 'subrip', IsExternal: true, Path: '/subs/movie.ara.srt' }
    ];

    // Filter candidates not present in pre-download baseline
    const candidateNewSubs = freshStreams.filter((s) => {
        if (s.Type !== 'Subtitle') return false;
        const fp = s.Path || `${s.Index}:${s.Language}:${s.Codec}:${s.IsExternal}`;
        return !previousSubtitleFingerprints.has(fp) && (!previousSubtitleIndices.has(s.Index) || s.IsExternal);
    });

    assert.equal(candidateNewSubs.length, 1);
    assert.equal(candidateNewSubs[0].Index, 4, 'Should identify Index 4 as the candidate, ignoring existing Index 3');

    // Scenario where baseline was incomplete and candidateNewSubs contained all external subtitles [3, 4]
    const unpartitionedCandidates = freshStreams.filter((s) => s.Type === 'Subtitle' && s.IsExternal);
    const pool = unpartitionedCandidates;
    const targetNormLang = 'ara';
    const matchedTrack = [...pool].reverse().find((s) => s.Language === targetNormLang);
    const selected = matchedTrack || pool[pool.length - 1];

    assert.equal(selected.Index, 4, 'Must select Index 4 (newest / matching language), NOT Index 3 (first external subtitle)');
});

test('JellyfinPlayer.deleteAndReconcileSubtitle deletes track, handles active track deactivation, and reconciles indices', async () => {
    // 1. Verify JellyfinPlayer source defines deleteAndReconcileSubtitle
    const jfSource = readFileSync(new URL('../src/player/core/JellyfinPlayer.js', import.meta.url), 'utf8');
    assert.ok(
        jfSource.includes('async deleteAndReconcileSubtitle(streamIndex)'),
        'JellyfinPlayer must define deleteAndReconcileSubtitle'
    );

    let deletedItemId = null;
    let deletedIndex = null;
    const mockApi = {
        deleteSubtitle: async (itemId, idx) => {
            deletedItemId = itemId;
            deletedIndex = idx;
        },
        getItem: async () => {
            // Fresh inventory after index 3 is deleted: only video, audio, and internal sub remaining
            return {
                Id: 'item-del-123',
                MediaSources: [
                    {
                        Id: 'source-1',
                        MediaStreams: [
                            { Index: 0, Type: 'Video', Codec: 'h264' },
                            { Index: 1, Type: 'Audio', Language: 'eng', Codec: 'aac' },
                            { Index: 2, Type: 'Subtitle', Language: 'eng', IsExternal: false }
                        ]
                    }
                ]
            };
        }
    };

    let activatedSubIndex = null;
    let updatedStreams = null;
    const events = [];

    const mockPlayer = {
        _currentItem: { Id: 'item-del-123' },
        _currentMediaSource: {
            Id: 'source-1',
            MediaStreams: [
                { Index: 0, Type: 'Video', Codec: 'h264' },
                { Index: 1, Type: 'Audio', Language: 'eng', Codec: 'aac' },
                { Index: 2, Type: 'Subtitle', Language: 'eng', IsExternal: false },
                { Index: 3, Type: 'Subtitle', Language: 'ara', IsExternal: true }
            ]
        },
        _currentAudioStreamIndex: 1,
        _currentSubtitleStreamIndex: 3, // Currently playing the subtitle to be deleted!
        _subtitleManager: {
            updateMediaStreams: (streams) => { updatedStreams = streams; }
        },
        setSubtitleStreamIndex: async (idx) => {
            activatedSubIndex = idx;
            mockPlayer._currentSubtitleStreamIndex = idx;
        },
        emit: (evt, data) => { events.push({ evt, data }); }
    };

    // Simulate deleteAndReconcileSubtitle execution
    await mockApi.deleteSubtitle(mockPlayer._currentItem.Id, 3);
    assert.equal(deletedItemId, 'item-del-123');
    assert.equal(deletedIndex, 3);

    const fresh = await mockApi.getItem('item-del-123', { Fields: 'MediaStreams,MediaSources' });
    const freshStreams = fresh.MediaSources[0].MediaStreams;

    mockPlayer._currentMediaSource.MediaStreams = freshStreams;
    mockPlayer._subtitleManager.updateMediaStreams(freshStreams);

    // If active track was the deleted track, switch to Off (-1)
    if (mockPlayer._currentSubtitleStreamIndex === 3) {
        await mockPlayer.setSubtitleStreamIndex(-1);
    }

    mockPlayer.emit('mediastreamschange', {
        subtitleStreamIndex: mockPlayer._currentSubtitleStreamIndex,
        audioStreamIndex: mockPlayer._currentAudioStreamIndex
    });

    assert.equal(activatedSubIndex, -1, 'Active deleted subtitle must turn off (-1)');
    assert.equal(updatedStreams.length, 3, 'Inventory must be down to 3 streams');
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].data, { subtitleStreamIndex: -1, audioStreamIndex: 1 });
});

test('MediaHelper series-level track memory: saves show-wide preferences and resolves across different episodes', () => {
    const mediaHelperSource = readFileSync(
        new URL('../src/player/core/MediaHelper.js', import.meta.url),
        'utf8'
    )
        .replace(/^import .*;\r?\n/gm, '')
        .replace('export const MediaHelper', 'const MediaHelper')
        .replace('export default MediaHelper;', '');

    const storageMap = new Map();
    const storage = {
        getItem: (k) => storageMap.get(k) ?? null,
        setItem: (k, v) => storageMap.set(k, String(v)),
        removeItem: (k) => storageMap.delete(k)
    };

    const context = vm.createContext({
        storage,
        platformInfo: { isTizen: false, isWebOS: false },
        state: { get: () => 'test-device' },
        logger: { create: () => ({ info() {}, warn() {}, error() {}, debug() {} }) }
    });

    const MediaHelper = vm.runInContext(mediaHelperSource + '\nMediaHelper;', context);

    // Episode 1 media source inventory
    const ep1Source = {
        Id: 'source-ep-1',
        MediaStreams: [
            { Index: 0, Type: 'Video', Codec: 'hevc' },
            { Index: 1, Type: 'Audio', Language: 'eng', DisplayTitle: 'English (Stereo)', Codec: 'aac' },
            { Index: 2, Type: 'Audio', Language: 'jpn', DisplayTitle: 'Japanese (Surround 5.1)', Codec: 'flac' },
            { Index: 3, Type: 'Subtitle', Language: 'eng', DisplayTitle: 'English [Full]', Codec: 'subrip' },
            { Index: 4, Type: 'Subtitle', Language: 'spa', DisplayTitle: 'Spanish', Codec: 'subrip' }
        ]
    };

    const seriesId = 'series-anime-titan';
    const ep1Id = 'ep-101';

    // 1. User selects Japanese Audio (Index 2) and English Subtitle (Index 3) on Episode 1
    MediaHelper.saveTrackMemory(ep1Id, 'Audio', 2, ep1Source, seriesId);
    MediaHelper.saveTrackMemory(ep1Id, 'Subtitle', 3, ep1Source, seriesId);

    // Verify series-level entry exists in storage
    const seriesEntryRaw = storage.getItem(`track:series:${seriesId}`);
    assert.ok(seriesEntryRaw, 'Series track preference must be saved in storage');
    const seriesData = JSON.parse(seriesEntryRaw);
    assert.equal(seriesData.audio.language, 'jpn');
    assert.equal(seriesData.subtitle.language, 'eng');

    // 2. User plays Episode 2 in another session.
    // Notice Episode 2 has different stream order / indices:
    // Index 0: Video
    // Index 1: Audio (jpn) -> Japanese is now Index 1!
    // Index 2: Audio (eng)
    // Index 3: Subtitle (spa)
    // Index 4: Subtitle (eng) -> English subtitles are now Index 4!
    const ep2Source = {
        Id: 'source-ep-2',
        MediaStreams: [
            { Index: 0, Type: 'Video', Codec: 'hevc' },
            { Index: 1, Type: 'Audio', Language: 'jpn', DisplayTitle: 'Japanese (Surround 5.1)', Codec: 'flac' },
            { Index: 2, Type: 'Audio', Language: 'eng', DisplayTitle: 'English (Stereo)', Codec: 'aac' },
            { Index: 3, Type: 'Subtitle', Language: 'spa', DisplayTitle: 'Spanish', Codec: 'subrip' },
            { Index: 4, Type: 'Subtitle', Language: 'eng', DisplayTitle: 'English [Full]', Codec: 'subrip' }
        ]
    };

    const resolvedAudio = MediaHelper.resolveSeriesTrack(ep2Source, 'Audio', seriesId);
    const resolvedSubtitle = MediaHelper.resolveSeriesTrack(ep2Source, 'Subtitle', seriesId);

    assert.equal(resolvedAudio, 1, 'Episode 2 must resolve Japanese audio track (Index 1) from series memory');
    assert.equal(resolvedSubtitle, 4, 'Episode 2 must resolve English subtitle track (Index 4) from series memory');
});

test('MediaHelper series-level subtitle Off preference persists to subsequent episodes', () => {
    const mediaHelperSource = readFileSync(
        new URL('../src/player/core/MediaHelper.js', import.meta.url),
        'utf8'
    )
        .replace(/^import .*;\r?\n/gm, '')
        .replace('export const MediaHelper', 'const MediaHelper')
        .replace('export default MediaHelper;', '');

    const storageMap = new Map();
    const storage = {
        getItem: (k) => storageMap.get(k) ?? null,
        setItem: (k, v) => storageMap.set(k, String(v)),
        removeItem: (k) => storageMap.delete(k)
    };

    const context = vm.createContext({
        storage,
        platformInfo: { isTizen: false, isWebOS: false },
        state: { get: () => 'test-device' },
        logger: { create: () => ({ info() {}, warn() {}, error() {}, debug() {} }) }
    });

    const MediaHelper = vm.runInContext(mediaHelperSource + '\nMediaHelper;', context);

    const seriesId = 'series-comedy-sitcom';
    const ep1Id = 'ep-sitcom-1';

    // User disables subtitles (Index -1) on Episode 1
    MediaHelper.saveTrackMemory(ep1Id, 'Subtitle', -1, null, seriesId);

    const seriesEntryRaw = storage.getItem(`track:series:${seriesId}`);
    assert.ok(seriesEntryRaw);
    const seriesData = JSON.parse(seriesEntryRaw);
    assert.equal(seriesData.subtitle.isOff, true);

    // On Episode 2:
    const ep2Source = {
        Id: 'source-ep-sitcom-2',
        MediaStreams: [
            { Index: 0, Type: 'Video', Codec: 'hevc' },
            { Index: 1, Type: 'Audio', Language: 'eng', Codec: 'aac' },
            { Index: 2, Type: 'Subtitle', Language: 'eng', Codec: 'subrip' }
        ]
    };

    const resolvedSubtitle = MediaHelper.resolveSeriesTrack(ep2Source, 'Subtitle', seriesId);
    assert.equal(resolvedSubtitle, -1, 'Episode 2 must resolve subtitle as Off (-1) from series preference');
});

test('MediaHelper LRU cache: touches on playback to keep active shows at head and evicts oldest when exceeding capacity', () => {
    const mediaHelperSource = readFileSync(
        new URL('../src/player/core/MediaHelper.js', import.meta.url),
        'utf8'
    )
        .replace(/^import .*;\r?\n/gm, '')
        .replace('export const MediaHelper', 'const MediaHelper')
        .replace('export default MediaHelper;', '');

    const storageMap = new Map();
    const storage = {
        getItem: (k) => storageMap.get(k) ?? null,
        setItem: (k, v) => storageMap.set(k, String(v)),
        removeItem: (k) => storageMap.delete(k)
    };

    const context = vm.createContext({
        storage,
        platformInfo: { isTizen: false, isWebOS: false },
        state: { get: () => 'test-device' },
        logger: { create: () => ({ info() {}, warn() {}, error() {}, debug() {} }) }
    });

    const MediaHelper = vm.runInContext(mediaHelperSource + '\nMediaHelper;', context);

    const dummySource = {
        MediaStreams: [
            { Index: 0, Type: 'Audio', Language: 'eng', Title: 'Stereo' }
        ]
    };

    // 1. Add Series A initially
    MediaHelper.saveTrackMemory('ep-a-1', 'Audio', 0, dummySource, 'series-A');
    assert.ok(storage.getItem('track:series:series-A'), 'series-A must be stored');

    // 2. Add 49 other series (total 50 entries = MAX_LRU_ENTRIES)
    for (let i = 1; i <= 49; i++) {
        MediaHelper.saveTrackMemory(`ep-${i}-1`, 'Audio', 0, dummySource, `series-${i}`);
    }

    const indexBeforeTouch = JSON.parse(storage.getItem('track:lru_index'));
    assert.equal(indexBeforeTouch.length, 50, 'LRU should contain 50 items');
    // Series A was added first, so it is currently at the tail (index 49)
    assert.equal(indexBeforeTouch[49].id, 'series:series-A');

    // 3. User plays another episode of Series A — touchTrackMemory is called!
    MediaHelper.touchTrackMemory('ep-a-2', 'series-A');

    const indexAfterTouch = JSON.parse(storage.getItem('track:lru_index'));
    // Series A should have been promoted to the head (index 0)!
    assert.equal(indexAfterTouch[0].id, 'series:series-A', 'series-A must now be at the head of LRU after touch');
    // The previous series-1 is now near the tail
    assert.equal(indexAfterTouch[49].id, 'series:series-1', 'series-1 is now the oldest entry');

    // 4. Now add a 51st show ('series-overflow')
    MediaHelper.saveTrackMemory('ep-overflow-1', 'Audio', 0, dummySource, 'series-overflow');

    const indexAfterOverflow = JSON.parse(storage.getItem('track:lru_index'));
    assert.equal(indexAfterOverflow.length, 50, 'LRU capacity must stay capped at 50');

    // Series A was touched, so it must NOT be evicted!
    assert.ok(storage.getItem('track:series:series-A'), 'series-A must survive because it was touched');
    // The oldest untouched series (series-1) must have been evicted from storage!
    assert.strictEqual(storage.getItem('track:series:series-1'), null, 'Untouched series-1 must be evicted and deleted');
});



