import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// ============================================================================
// Environment Mock for ES Module Imports in Node.js
// ============================================================================
// Initialize local storage and window mocks so PlayerSettings, storage,
// and LanguageManager can load cleanly in the Node test environment.
// ============================================================================
const storageMap = new Map();
globalThis.localStorage = {
    getItem: (key) => storageMap.get(key) || null,
    setItem: (key, val) => storageMap.set(key, String(val)),
    removeItem: (key) => storageMap.delete(key),
    clear: () => storageMap.clear()
};

globalThis.document = {
    createElement: () => ({
        canPlayType: () => ''
    })
};

globalThis.screen = { width: 1920, height: 1080 };
globalThis.window = globalThis;

// Import LanguageManager, MediaHelper, and storage modules
const { languageManager } = await import('../src/utils/LanguageManager.js');
const { MediaHelper } = await import('../src/player/core/MediaHelper.js');
const { storage } = await import('../src/utils/StorageService.js');

// Read StreamUtils.js source to extract resolveSubtitleStream without loading
// CSS/DOM (the subtitle-mode helpers moved there from JellyfinPlayer.js in the
// DetailsPage decoupling refactor)
const playerSource = readFileSync(new URL('../src/player/core/StreamUtils.js', import.meta.url), 'utf8')
    .replace(/\r\n/g, '\n');

function setup(settings = {}, serverUser = null) {
    const currentSettings = {
        subtitleMode: 'Default',
        subtitleLanguage: 'eng',
        preferExternalSubtitles: false,
        ...settings
    };

    let currentUser = serverUser;

    const context = vm.createContext({
        PlayerSettings: {
            get: (key) => currentSettings[key],
            set: (key, val) => { currentSettings[key] = val; }
        },
        storage: {
            getItem: (key) => {
                if (key === 'pref:subtitleLang') return currentSettings.subtitleLanguage || 'none';
                return storageMap.get(key) || null;
            },
            setItem: (key, val) => storageMap.set(key, String(val)),
            removeItem: (key) => storageMap.delete(key)
        },
        auth: {
            getCurrentUser: () => currentUser
        },
        languageManager,
        log: {
            info() {},
            debug() {},
            warn() {},
            error() {}
        }
    });

    // Extract isLanguageMatch, getEffectiveSubtitleMode, isForcedStream, and resolveSubtitleStream
    const startMarker = 'export const isLanguageMatch = (trackOrLang, targetLanguage) => {';
    const endMarker = '/**\n * Automatically resolve the best audio track for a given media source.';

    const startIdx = playerSource.indexOf(startMarker);
    const endIdx = playerSource.indexOf(endMarker);

    if (startIdx === -1 || endIdx === -1) {
        throw new Error('Failed to locate resolveSubtitleStream source block in StreamUtils.js');
    }

    const codeToRun = playerSource.slice(startIdx, endIdx)
        .replace(/export function /g, 'function ')
        .replace(/export const /g, 'const ');
    const script = `
        ${codeToRun}
        ({ resolveSubtitleStream, isForcedStream, getEffectiveSubtitleMode, isLanguageMatch });
    `;

    const { resolveSubtitleStream, isForcedStream, getEffectiveSubtitleMode, isLanguageMatch } = vm.runInContext(script, context);
    return {
        resolveSubtitleStream,
        isForcedStream,
        getEffectiveSubtitleMode,
        isLanguageMatch,
        setServerUser: (u) => { currentUser = u; },
        setSetting: (key, val) => { currentSettings[key] = val; }
    };
}

// ============================================================================
// Subtitle Mode & Track Selection Test Suite
// ============================================================================

test('isForcedStream: Never treats tracks as forced merely because LocalizedForced is "Forced"', () => {
    const { isForcedStream } = setup();

    // Track matching the user log (Cat's in the Bag... episode)
    const track = {
        Codec: 'PGSSUB',
        Language: 'eng',
        DisplayTitle: 'English - PGSSUB',
        Title: '',
        IsDefault: false,
        IsForced: false,
        LocalizedForced: 'Forced'
    };

    assert.equal(
        isForcedStream(track),
        false,
        'Track with IsForced: false and LocalizedForced: "Forced" must NOT be considered forced'
    );
});

test('isForcedStream: Identifies forced tracks via boolean or title keywords', () => {
    const { isForcedStream } = setup();

    assert.equal(isForcedStream({ IsForced: true, Title: 'English' }), true);
    assert.equal(isForcedStream({ Forced: true, Title: 'English' }), true);
    assert.equal(isForcedStream({ IsForced: false, Title: 'English (Forced)' }), true);
    assert.equal(isForcedStream({ IsForced: false, DisplayTitle: 'English - Forced [SRT]' }), true);
    assert.equal(isForcedStream({ IsForced: false, Title: 'Reinforce' }), false);
    assert.equal(isForcedStream({ IsForced: false, Title: 'English' }), false);
});

test('resolveSubtitleStream: Subtitle mode "None" always returns -1 even if container has default subtitle', () => {
    const { resolveSubtitleStream } = setup({
        subtitleMode: 'None',
        subtitleLanguage: 'eng'
    });

    const mediaSource = {
        Id: 'test-source-none',
        DefaultSubtitleStreamIndex: 2,
        MediaStreams: [
            { Type: 'Audio', Index: 1, Language: 'eng', IsDefault: true },
            { Type: 'Subtitle', Index: 2, Language: 'eng', IsDefault: true, IsForced: false, Title: 'English' },
            { Type: 'Subtitle', Index: 3, Language: 'spa', IsDefault: false, IsForced: false, Title: 'Spanish' }
        ]
    };

    const result = resolveSubtitleStream(mediaSource, { audioStreamIndex: 1 });
    assert.equal(result, -1, 'Subtitle mode "None" must always resolve to -1 (disabled)');
});

test('resolveSubtitleStream: Subtitle mode "OnlyForced" returns -1 for track with LocalizedForced: "Forced"', () => {
    const { resolveSubtitleStream } = setup({
        subtitleMode: 'OnlyForced',
        subtitleLanguage: 'eng'
    });

    // Exact track structure from user's Breaking Bad episode log
    const mediaSource = {
        Id: 'test-source-breaking-bad',
        MediaStreams: [
            { Type: 'Audio', Index: 1, Language: 'eng', IsDefault: true },
            {
                Type: 'Subtitle',
                Index: 2,
                Language: 'eng',
                IsDefault: false,
                IsForced: false,
                DisplayTitle: 'English - PGSSUB',
                LocalizedForced: 'Forced'
            }
        ]
    };

    const result = resolveSubtitleStream(mediaSource, { audioStreamIndex: 1 });
    assert.equal(result, -1, 'Subtitle mode "OnlyForced" must resolve to -1 when track is not forced');
});

test('resolveSubtitleStream: Subtitle mode "OnlyForced" detects forced track via IsForced boolean', () => {
    const { resolveSubtitleStream } = setup({
        subtitleMode: 'OnlyForced',
        subtitleLanguage: 'eng'
    });

    const mediaSource = {
        Id: 'test-source-forced-bool',
        DefaultSubtitleStreamIndex: 2,
        MediaStreams: [
            { Type: 'Audio', Index: 1, Language: 'eng', IsDefault: true },
            { Type: 'Subtitle', Index: 2, Language: 'eng', IsDefault: true, IsForced: false, Title: 'Full Subtitles' },
            { Type: 'Subtitle', Index: 3, Language: 'eng', IsDefault: false, IsForced: true, Title: 'English Forced' }
        ]
    };

    const result = resolveSubtitleStream(mediaSource, { audioStreamIndex: 1 });
    assert.equal(result, 3, 'Subtitle mode "OnlyForced" must select track with IsForced: true');
});

test('resolveSubtitleStream: Subtitle mode "Default" defers to server preference "OnlyForced"', () => {
    // Client setting: 'Default' (Server Preference)
    // Server user profile: SubtitleMode = 'OnlyForced'
    const serverUser = {
        Configuration: {
            SubtitleMode: 'OnlyForced',
            SubtitleLanguagePreference: 'eng'
        }
    };

    const { resolveSubtitleStream } = setup({ subtitleMode: 'Default' }, serverUser);

    // Media source with non-forced container default track
    const mediaSource = {
        Id: 'test-source-server-forced',
        DefaultSubtitleStreamIndex: 2,
        MediaStreams: [
            { Type: 'Audio', Index: 1, Language: 'eng', IsDefault: true },
            { Type: 'Subtitle', Index: 2, Language: 'eng', IsDefault: true, IsForced: false, Title: 'SHD', DisplayTitle: 'SHD - English - Default - SUBRIP' }
        ]
    };

    const result = resolveSubtitleStream(mediaSource, { audioStreamIndex: 1 });
    assert.equal(result, -1, 'Client in Default mode with server set to OnlyForced must return -1 when no forced track exists');
});

test('resolveSubtitleStream: Subtitle mode "Default" selects forced track when server preference is "OnlyForced"', () => {
    const serverUser = {
        Configuration: {
            SubtitleMode: 'OnlyForced',
            SubtitleLanguagePreference: 'eng'
        }
    };

    const { resolveSubtitleStream } = setup({ subtitleMode: 'Default' }, serverUser);

    const mediaSource = {
        Id: 'test-source-server-forced-match',
        MediaStreams: [
            { Type: 'Audio', Index: 1, Language: 'eng', IsDefault: true },
            { Type: 'Subtitle', Index: 2, Language: 'eng', IsDefault: true, IsForced: false, Title: 'Full' },
            { Type: 'Subtitle', Index: 3, Language: 'eng', IsDefault: false, IsForced: true, Title: 'English (Forced)' }
        ]
    };

    const result = resolveSubtitleStream(mediaSource, { audioStreamIndex: 1 });
    assert.equal(result, 3, 'Client in Default mode with server set to OnlyForced must select forced track');
});

test('resolveSubtitleStream: Subtitle mode "Default" defers to server preference "None"', () => {
    const serverUser = {
        Configuration: {
            SubtitleMode: 'None'
        }
    };

    const { resolveSubtitleStream } = setup({ subtitleMode: 'Default' }, serverUser);

    const mediaSource = {
        Id: 'test-source-server-none',
        DefaultSubtitleStreamIndex: 2,
        MediaStreams: [
            { Type: 'Audio', Index: 1, Language: 'eng', IsDefault: true },
            { Type: 'Subtitle', Index: 2, Language: 'eng', IsDefault: true, IsForced: false, Title: 'English' }
        ]
    };

    const result = resolveSubtitleStream(mediaSource, { audioStreamIndex: 1 });
    assert.equal(result, -1, 'Client in Default mode with server set to None must return -1');
});

test('resolveSubtitleStream: Subtitle mode "Always" selects user preferred language track', () => {
    const { resolveSubtitleStream } = setup({
        subtitleMode: 'Always',
        subtitleLanguage: 'spa',
        preferExternalSubtitles: false
    });

    const mediaSource = {
        Id: 'test-source-always',
        MediaStreams: [
            { Type: 'Audio', Index: 1, Language: 'eng', IsDefault: true },
            { Type: 'Subtitle', Index: 2, Language: 'eng', IsDefault: true, IsForced: false },
            { Type: 'Subtitle', Index: 3, Language: 'spa', IsDefault: false, IsForced: false }
        ]
    };

    const result = resolveSubtitleStream(mediaSource, { audioStreamIndex: 1 });
    assert.equal(result, 3, 'Subtitle mode "Always" should pick track matching preferred language');
});

test('resolveSubtitleStream: Subtitle mode "Smart" shows subtitles when audio does not match preferred subtitle language', () => {
    const { resolveSubtitleStream } = setup({
        subtitleMode: 'Smart',
        subtitleLanguage: 'eng'
    });

    const mediaSource = {
        Id: 'test-source-smart-foreign',
        MediaStreams: [
            { Type: 'Audio', Index: 1, Language: 'jpn', IsDefault: true },
            { Type: 'Subtitle', Index: 2, Language: 'eng', IsDefault: true, IsForced: false }
        ]
    };

    const result = resolveSubtitleStream(mediaSource, { audioStreamIndex: 1 });
    assert.equal(result, 2, 'Subtitle mode "Smart" should enable English subtitles when audio is Japanese');
});

test('resolveSubtitleStream: Subtitle mode "Smart" shows preferred-language subtitles when the audio has no language tag', () => {
    const { resolveSubtitleStream } = setup({
        subtitleMode: 'Smart',
        subtitleLanguage: 'bul'
    });

    // A 4K movie as Jellyfin lists it: untagged AAC audio, an external Bulgarian
    // SRT and embedded English (default) and Spanish PGS tracks. For a user with
    // Bulgarian subtitles in Smart mode the server picks the Bulgarian SRT
    const mediaSource = {
        Id: 'test-source-smart-untagged-audio',
        MediaStreams: [
            {
                Type: 'Subtitle',
                Index: 0,
                Language: 'bul',
                Codec: 'subrip',
                IsExternal: true,
                IsDefault: false,
                IsForced: false
            },
            { Type: 'Video', Index: 1, Codec: 'hevc', IsDefault: true },
            { Type: 'Audio', Index: 2, Codec: 'aac', IsDefault: true },
            { Type: 'Subtitle', Index: 3, Language: 'eng', Codec: 'PGSSUB', IsDefault: true, IsForced: false },
            { Type: 'Subtitle', Index: 4, Language: 'spa', Codec: 'PGSSUB', IsDefault: false, IsForced: false }
        ]
    };

    assert.equal(resolveSubtitleStream(mediaSource, { audioStreamIndex: 2 }), 0, 'untagged audio: Bulgarian subtitles');

    mediaSource.MediaStreams[2].Language = 'und';
    assert.equal(
        resolveSubtitleStream(mediaSource, { audioStreamIndex: 2 }),
        0,
        'audio tagged "und": Bulgarian subtitles'
    );
});

test('resolveSubtitleStream: Subtitle mode "Smart" keeps subtitles off when the audio is in the preferred language (guard)', () => {
    const { resolveSubtitleStream } = setup({
        subtitleMode: 'Smart',
        subtitleLanguage: 'bul'
    });

    const mediaSource = {
        Id: 'test-source-smart-same-language',
        MediaStreams: [
            { Type: 'Audio', Index: 1, Language: 'bul', IsDefault: true },
            { Type: 'Subtitle', Index: 2, Language: 'bul', IsDefault: false, IsForced: false },
            { Type: 'Subtitle', Index: 3, Language: 'eng', IsDefault: true, IsForced: false }
        ]
    };

    assert.equal(resolveSubtitleStream(mediaSource, { audioStreamIndex: 1 }), -1);
});

test('Saved item subtitle guard discards previously saved non-forced track in "OnlyForced" mode', () => {
    const { isForcedStream, getEffectiveSubtitleMode } = setup({
        subtitleMode: 'OnlyForced'
    });

    const effectiveMode = getEffectiveSubtitleMode();
    assert.equal(effectiveMode, 'OnlyForced');

    const mediaSource = {
        Id: 'test-guard-source',
        MediaStreams: [
            { Type: 'Audio', Index: 1, Language: 'eng', IsDefault: true },
            { Type: 'Subtitle', Index: 2, Language: 'eng', IsDefault: false, IsForced: false, DisplayTitle: 'English - PGSSUB' }
        ]
    };

    // Simulate item previously saved track 2 (from before fix)
    let savedSubtitleIndex = 2;
    if (effectiveMode === 'OnlyForced') {
        const stream = mediaSource.MediaStreams.find((s) => s.Type === 'Subtitle' && s.Index === savedSubtitleIndex);
        if (stream && !isForcedStream(stream)) {
            savedSubtitleIndex = undefined;
        }
    }

    assert.equal(savedSubtitleIndex, undefined, 'Saved non-forced track must be cleared in OnlyForced mode');
});

test('isLanguageMatch: Matches Arabic across ISO codes, full names, and title metadata', () => {
    const { isLanguageMatch } = setup();

    // 1. ISO 639-2 ('ara') vs ISO 639-1 ('ar')
    assert.equal(isLanguageMatch('ara', 'ar'), true, 'ara matches ar');
    assert.equal(isLanguageMatch('ar', 'ara'), true, 'ar matches ara');

    // 2. Regional locale tag 'ar-SA' matching 'ara'
    assert.equal(isLanguageMatch('ar-SA', 'ara'), true, 'ar-SA matches ara');

    // 3. Full name 'Arabic' matching 'ara'
    assert.equal(isLanguageMatch('Arabic', 'ara'), true, 'Arabic matches ara');

    // 4. Stream object with Language 'und' and Title 'Arabic'
    const undTrackWithTitle = {
        Language: 'und',
        Title: 'Arabic',
        DisplayTitle: 'Arabic (SRT)'
    };
    assert.equal(isLanguageMatch(undTrackWithTitle, 'ara'), true, 'Title Arabic matches ara');

    // 5. Stream object with DisplayTitle 'العربية'
    const arabicNativeTrack = {
        Language: '',
        Title: '',
        DisplayTitle: 'العربية - Default'
    };
    assert.equal(isLanguageMatch(arabicNativeTrack, 'ara'), true, 'Native display title matches ara');

    // 6. Non-matching language
    assert.equal(isLanguageMatch('eng', 'ara'), false, 'eng does not match ara');
});

test('getEffectiveSubtitleMode: Normalizes casing and handles server preferences', () => {
    const { getEffectiveSubtitleMode } = setup({ subtitleMode: 'always' });
    assert.equal(getEffectiveSubtitleMode(), 'Always', 'Lowercase "always" normalizes to "Always"');

    const { getEffectiveSubtitleMode: getEffServer } = setup({ subtitleMode: 'Default' }, {
        Configuration: { SubtitleMode: 'always' }
    });
    assert.equal(getEffServer(), 'Always', 'Server SubtitleMode "always" normalizes to "Always"');
});

test('resolveSubtitleStream: Subtitle mode "Always" selects Arabic track', () => {
    const { resolveSubtitleStream } = setup({
        subtitleMode: 'Always',
        subtitleLanguage: 'ara'
    });

    const mediaSource = {
        Id: 'test-source-arabic',
        MediaStreams: [
            { Type: 'Audio', Index: 1, Language: 'eng', IsDefault: true },
            { Type: 'Subtitle', Index: 2, Language: 'eng', IsDefault: true, IsForced: false },
            { Type: 'Subtitle', Index: 3, Language: 'ara', IsDefault: false, IsForced: false, Title: 'Arabic' }
        ]
    };

    const result = resolveSubtitleStream(mediaSource, { audioStreamIndex: 1 });
    assert.equal(result, 3, 'Subtitle mode "Always" must pick Arabic subtitle track');
});

test('resolveSubtitleStream: Subtitle mode "Always" selects Arabic subtitle with Title "Arabic" when Language is "und"', () => {
    const { resolveSubtitleStream } = setup({
        subtitleMode: 'Always',
        subtitleLanguage: 'ara'
    });

    const mediaSource = {
        Id: 'test-source-arabic-und',
        MediaStreams: [
            { Type: 'Audio', Index: 1, Language: 'eng', IsDefault: true },
            { Type: 'Subtitle', Index: 2, Language: 'eng', IsDefault: true, IsForced: false },
            { Type: 'Subtitle', Index: 3, Language: 'und', IsDefault: false, IsForced: false, Title: 'Arabic', DisplayTitle: 'Arabic (SRT)' }
        ]
    };

    const result = resolveSubtitleStream(mediaSource, { audioStreamIndex: 1 });
    assert.equal(result, 3, 'Subtitle mode "Always" must match Arabic via track title when language tag is undetermined');
});

test('Saved subtitle guard: Subtitle mode "Always" discards stored -1 (Off) so subtitles always start enabled', () => {
    const { getEffectiveSubtitleMode } = setup({
        subtitleMode: 'Always'
    });

    const effectiveMode = getEffectiveSubtitleMode();
    assert.equal(effectiveMode, 'Always');

    // Simulate preselected -1 (Off) restored from previous playback
    let savedSubtitleIndex = -1;
    if (effectiveMode === 'Always' && savedSubtitleIndex === -1) {
        savedSubtitleIndex = undefined;
    }

    assert.equal(savedSubtitleIndex, undefined, 'Always mode must discard -1 so automatic track resolution activates');
});
