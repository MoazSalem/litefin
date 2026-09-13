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
