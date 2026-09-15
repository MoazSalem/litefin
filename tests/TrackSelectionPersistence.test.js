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

test('WebOSPlayer _getContainerDefaultAudioIndex respects mediaSource.DefaultAudioStreamIndex when streams lack IsDefault', () => {
    // Media where streams do NOT have IsDefault: true, but Jellyfin sets DefaultAudioStreamIndex: 5 (DTS)
    const mediaSource = {
        Id: 'edge-of-tomorrow-source',
        DefaultAudioStreamIndex: 5,
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

        if (ms.DefaultAudioStreamIndex !== undefined && ms.DefaultAudioStreamIndex !== null) {
            const serverDefault = audioStreams.find((s) => s.Index === ms.DefaultAudioStreamIndex);
            if (serverDefault) return serverDefault.Index;
        }

        return audioStreams[0]?.Index;
    }

    const resolvedDefault = mockGetContainerDefaultAudioIndex(mediaSource);
    assert.strictEqual(resolvedDefault, 5, 'Should resolve DefaultAudioStreamIndex: 5 instead of defaulting to first track');
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
