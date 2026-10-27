import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { AUDIO_FALLBACK_STORAGE_KEYS } from '../src/utils/AudioFallbackConfig.js';

// Extract the relevant functions directly from StreamUtils.js source without
// pulling in the browser/CSS DOM tree. These helpers moved out of
// JellyfinPlayer.js into StreamUtils.js so DetailsPage and PrewarmManager can
// evaluate streams without bundling the player engine; the raw-source-slice
// strategy avoids executing their module graph (PlayerSettings/DeviceProfile/
// StorageService hit browser APIs on import), so the sliced code runs on
// plain VM stubs instead.
const source = readFileSync(new URL('../src/player/core/StreamUtils.js', import.meta.url), 'utf8');

function setup(settings = {}, caps = {}, initialStorage = {}) {
    const defaultCaps = {
        dts: false,
        truehd: false,
        ac3: true,
        eac3: true,
        opus: true,
        mp2: false,
        maxAudioChannels: 8,
        ...caps
    };

    const currentSettings = {
        preferDirectPlayAudio: true,
        enableTrueHd: 'auto',
        enableDts: 'auto',
        enableEac3: 'auto',
        enableMp2: 'auto',
        enableFlacInVideo: false,
        ...settings
    };

    const storageMap = new Map(Object.entries(initialStorage));

    const context = vm.createContext({
        PlayerSettings: {
            get: (key) => currentSettings[key],
            set: (key, val) => { currentSettings[key] = val; }
        },
        getDeviceCapabilities: () => defaultCaps,
        platformInfo: { isTizen: true, isWebOS: false },
        AUDIO_FALLBACK_STORAGE_KEYS,
        storage: {
            getItem: (key) => storageMap.get(key) || null,
            setItem: (key, val) => storageMap.set(key, val),
            removeItem: (key) => storageMap.delete(key)
        },
        // StreamUtils guards these behind runtime conditions that never fire
        // in this suite (MediaHelper only runs with a TranscodingUrl present;
        // languageManager checks typeof at each call site), but stubs keep
        // the extracted source runnable without their module imports.
        MediaHelper: { getTranscodeStatus: () => ({ isVideoDirect: true, isAudioDirect: true }) },
        languageManager: { normalizeLanguage: (lang) => lang },
        log: {
            info() {},
            debug() {},
            warn() {},
            error() {}
        }
    });

    // Run the exported functions in the VM context
    const normalizedSource = source.replace(/\r\n/g, '\n');
    const code = `
        // isTrueHdSupported and doesAudioTrackRequireDirectStream are the first
        // and last exports of StreamUtils.js - slice from the capability
        // helper to EOF (everything in between is side-effect-free function
        // source; the module-level log singleton lives before the slice and
        // the context provides a stub of the same name).
        ${normalizedSource.slice(
            normalizedSource.indexOf('export const isTrueHdSupported =')
        ).replace(/export /g, '')}

        ({ isTrueHdSupported, isDtsSupported, isAudioTrackNativelyPlayable, resolveBestAudioStream, doesAudioTrackRequireDirectStream });
    `;

    return vm.runInContext(code, context);
}

test('isAudioTrackNativelyPlayable correctly identifies codec capabilities', () => {
    const { isAudioTrackNativelyPlayable } = setup({
        enableTrueHd: 'disable',
        enableDts: 'disable',
        enableFlacInVideo: false
    });

    assert.strictEqual(isAudioTrackNativelyPlayable({ Codec: 'truehd' }), false);
    assert.strictEqual(isAudioTrackNativelyPlayable({ Codec: 'dts' }), false);
    assert.strictEqual(isAudioTrackNativelyPlayable({ Codec: 'dca' }), false);
    assert.strictEqual(isAudioTrackNativelyPlayable({ Codec: 'flac' }), false);
    assert.strictEqual(isAudioTrackNativelyPlayable({ Codec: 'aac' }), true);
    assert.strictEqual(isAudioTrackNativelyPlayable({ Codec: 'ac3' }), true);
    assert.strictEqual(isAudioTrackNativelyPlayable({ Codec: 'eac3' }), true);
});

test('resolveBestAudioStream selects AC3 5.1 when default is TrueHD 7.1', () => {
    const { resolveBestAudioStream } = setup({
        preferDirectPlayAudio: true,
        enableTrueHd: 'disable'
    });

    const mediaSource = {
        Id: 'ms1',
        DefaultAudioStreamIndex: 0,
        MediaStreams: [
            { Index: 0, Type: 'Audio', Codec: 'truehd', Channels: 8, Language: 'eng', IsDefault: true },
            { Index: 1, Type: 'Audio', Codec: 'ac3', Channels: 6, Language: 'eng', IsDefault: false },
            { Index: 2, Type: 'Audio', Codec: 'aac', Channels: 2, Language: 'spa', IsDefault: false }
        ]
    };

    const best = resolveBestAudioStream(mediaSource);
    assert.ok(best, 'Best audio stream should be resolved');
    assert.strictEqual(best.Index, 1, 'Should select English AC3 5.1 instead of TrueHD 7.1');
    assert.strictEqual(best.Codec, 'ac3');
});

test('resolveBestAudioStream avoids commentary track in same language', () => {
    const { resolveBestAudioStream } = setup({
        preferDirectPlayAudio: true,
        enableDts: 'disable'
    });

    const mediaSource = {
        Id: 'ms2',
        DefaultAudioStreamIndex: 0,
        MediaStreams: [
            { Index: 0, Type: 'Audio', Codec: 'dts', Channels: 6, Language: 'eng', IsDefault: true },
            { Index: 1, Type: 'Audio', Codec: 'aac', Channels: 2, Language: 'eng', Title: 'Director Commentary', IsDefault: false },
            { Index: 2, Type: 'Audio', Codec: 'eac3', Channels: 6, Language: 'eng', Title: 'Surround 5.1', IsDefault: false }
        ]
    };

    const best = resolveBestAudioStream(mediaSource);
    assert.strictEqual(best.Index, 2, 'Should prefer EAC3 5.1 over AAC Commentary');
});

test('resolveBestAudioStream keeps default track if already natively playable', () => {
    const { resolveBestAudioStream } = setup({
        preferDirectPlayAudio: true
    }, { maxAudioChannels: 2 });

    const mediaSource = {
        Id: 'ms3',
        DefaultAudioStreamIndex: 0,
        MediaStreams: [
            { Index: 0, Type: 'Audio', Codec: 'aac', Channels: 2, Language: 'eng', IsDefault: true },
            { Index: 1, Type: 'Audio', Codec: 'ac3', Channels: 6, Language: 'eng', IsDefault: false }
        ]
    };

    const best = resolveBestAudioStream(mediaSource);
    assert.strictEqual(best.Index, 0, 'Should keep standard default track when it is already playable');
});

test('resolveBestAudioStream respects preferDirectPlayAudio=false', () => {
    const { resolveBestAudioStream } = setup({
        preferDirectPlayAudio: false,
        enableTrueHd: 'disable'
    });

    const mediaSource = {
        Id: 'ms4',
        DefaultAudioStreamIndex: 0,
        MediaStreams: [
            { Index: 0, Type: 'Audio', Codec: 'truehd', Channels: 8, Language: 'eng', IsDefault: true },
            { Index: 1, Type: 'Audio', Codec: 'ac3', Channels: 6, Language: 'eng', IsDefault: false }
        ]
    };

    const best = resolveBestAudioStream(mediaSource);
    assert.strictEqual(best.Index, 0, 'Should return default TrueHD track when setting is disabled');
});

test('resolveBestAudioStream selects DTS-HD MA over AC3 backup when TrueHD default is disabled and DTS is enabled', () => {
    const { resolveBestAudioStream } = setup({
        preferDirectPlayAudio: true,
        enableTrueHd: 'disable',
        enableDts: 'enable'
    });

    const mediaSource = {
        Id: 'ms-truehd-dts-ac3',
        DefaultAudioStreamIndex: 0,
        MediaStreams: [
            { Index: 0, Type: 'Audio', Codec: 'truehd', Channels: 8, Language: 'eng', IsDefault: true },
            { Index: 1, Type: 'Audio', Codec: 'dts-hd ma', Channels: 8, Language: 'eng', IsDefault: false },
            { Index: 2, Type: 'Audio', Codec: 'ac3', Channels: 6, Language: 'eng', IsDefault: false }
        ]
    };

    const best = resolveBestAudioStream(mediaSource);
    assert.ok(best, 'Best audio stream should be resolved');
    assert.strictEqual(best.Index, 1, 'Should select DTS-HD MA (Index 1) instead of AC3 backup (Index 2)');
    assert.strictEqual(best.Codec, 'dts-hd ma');
});

test('resolveBestAudioStream upgrades from AC3 compatibility track to DTS-HD MA in same language when DTS is enabled', () => {
    const { resolveBestAudioStream } = setup({
        preferDirectPlayAudio: true,
        enableDts: 'enable'
    });

    const mediaSource = {
        Id: 'ms-dts-ac3-default',
        DefaultAudioStreamIndex: 1,
        MediaStreams: [
            { Index: 0, Type: 'Audio', Codec: 'dts-hd ma', Channels: 8, Language: 'eng', IsDefault: false },
            { Index: 1, Type: 'Audio', Codec: 'ac3', Channels: 6, Language: 'eng', IsDefault: true } // Compatibility track flagged default by encoder
        ]
    };

    const best = resolveBestAudioStream(mediaSource);
    assert.ok(best, 'Best audio stream should be resolved');
    assert.strictEqual(best.Index, 0, 'Should upgrade to DTS-HD MA (Index 0) instead of settling for default AC3 (Index 1)');
});

test('resolveBestAudioStream falls back to AC3 when DTS is disabled and default is DTS', () => {
    const { resolveBestAudioStream } = setup({
        preferDirectPlayAudio: true,
        enableDts: 'disable'
    });

    const mediaSource = {
        Id: 'ms-dts-disabled',
        DefaultAudioStreamIndex: 0,
        MediaStreams: [
            { Index: 0, Type: 'Audio', Codec: 'dts', Channels: 6, Language: 'eng', IsDefault: true },
            { Index: 1, Type: 'Audio', Codec: 'ac3', Channels: 6, Language: 'eng', IsDefault: false }
        ]
    };

    const best = resolveBestAudioStream(mediaSource);
    assert.ok(best, 'Best audio stream should be resolved');
    assert.strictEqual(best.Index, 1, 'Should fall back to AC3 (Index 1) when DTS is disabled');
});

test('doesAudioTrackRequireDirectStream: Avatar (DTS default track) plays DirectPlay without remux', () => {
    const { doesAudioTrackRequireDirectStream } = setup({
        enableDts: 'enable',
        enableTrueHd: 'disable'
    });

    const mediaSource = {
        Id: 'avatar-source',
        MediaStreams: [
            { Index: 2, Type: 'Audio', Codec: 'dts', Channels: 6, Language: 'eng', IsDefault: false },
            { Index: 3, Type: 'Audio', Codec: 'ac3', Channels: 6, Language: 'eng', IsDefault: false }
        ]
    };

    // Requested track is Index 2 (DTS), which is container track 0 (physical default)
    const requiresRemux = doesAudioTrackRequireDirectStream(mediaSource, 2, 'webos');
    assert.strictEqual(requiresRemux, false, 'Default DTS track should play DirectPlay natively without remuxing');
});

test('doesAudioTrackRequireDirectStream: Edge of Tomorrow (non-default DTS track) requires DirectStream remux on WebOS', () => {
    const { doesAudioTrackRequireDirectStream } = setup({
        enableDts: 'enable',
        enableTrueHd: 'disable'
    });

    const mediaSource = {
        Id: 'edge-of-tomorrow-source',
        MediaStreams: [
            { Index: 2, Type: 'Audio', Codec: 'truehd', Channels: 8, Language: 'eng', IsDefault: false },
            { Index: 3, Type: 'Audio', Codec: 'ac3', Channels: 6, Language: 'eng', IsDefault: false },
            { Index: 4, Type: 'Audio', Codec: 'ac3', Channels: 6, Language: 'eng', IsDefault: false },
            { Index: 5, Type: 'Audio', Codec: 'dts', Channels: 8, Language: 'eng', IsDefault: false }
        ]
    };

    // Requested track is Index 5 (DTS).
    // Physical container default is Index 3 (first playable track since TrueHD is disabled).
    // Because DTS is dropped from Chromium audioTracks, WebOS cannot switch in DirectPlay!
    const requiresRemux = doesAudioTrackRequireDirectStream(mediaSource, 5, 'webos');
    assert.strictEqual(requiresRemux, true, 'Non-default DTS track must require DirectStream remux to prevent AC3 downgrade');
});

test('doesAudioTrackRequireDirectStream: Multi-audio AC3 tracks do NOT require remux (native audioTracks supported)', () => {
    const { doesAudioTrackRequireDirectStream } = setup();

    const mediaSource = {
        Id: 'multi-ac3-source',
        MediaStreams: [
            { Index: 2, Type: 'Audio', Codec: 'ac3', Channels: 6, Language: 'eng', IsDefault: true },
            { Index: 3, Type: 'Audio', Codec: 'ac3', Channels: 6, Language: 'spa', IsDefault: false }
        ]
    };

    // Requested track is Spanish AC3 (Index 3). AC3 is supported in Chromium audioTracks.
    const requiresRemux = doesAudioTrackRequireDirectStream(mediaSource, 3, 'webos');
    assert.strictEqual(requiresRemux, false, 'Standard AC3 tracks switch natively via HTML5 audioTracks without remuxing');
});

test('doesAudioTrackRequireDirectStream: Tizen AVPlay does NOT require remux (hardware demuxing)', () => {
    const { doesAudioTrackRequireDirectStream } = setup({
        enableDts: 'enable'
    });

    const mediaSource = {
        Id: 'tizen-source',
        MediaStreams: [
            { Index: 2, Type: 'Audio', Codec: 'truehd', Channels: 8, Language: 'eng', IsDefault: false },
            { Index: 3, Type: 'Audio', Codec: 'ac3', Channels: 6, Language: 'eng', IsDefault: false },
            { Index: 5, Type: 'Audio', Codec: 'dts', Channels: 8, Language: 'eng', IsDefault: false }
        ]
    };

    const requiresRemux = doesAudioTrackRequireDirectStream(mediaSource, 5, 'avplay');
    assert.strictEqual(requiresRemux, false, 'Tizen AVPlay uses native hardware demuxing and does not need remuxing');
});

test('doesAudioTrackRequireDirectStream: Movi backend does NOT require remux (WASM demuxing)', () => {
    const { doesAudioTrackRequireDirectStream } = setup({
        enableDts: 'enable'
    });

    const mediaSource = {
        Id: 'movi-source',
        MediaStreams: [
            { Index: 2, Type: 'Audio', Codec: 'truehd', Channels: 8, Language: 'eng', IsDefault: false },
            { Index: 3, Type: 'Audio', Codec: 'ac3', Channels: 6, Language: 'eng', IsDefault: false },
            { Index: 5, Type: 'Audio', Codec: 'dts', Channels: 8, Language: 'eng', IsDefault: false }
        ]
    };

    const requiresRemux = doesAudioTrackRequireDirectStream(mediaSource, 5, 'movi');
    assert.strictEqual(requiresRemux, false, 'Movi backend uses internal WASM demuxing and does not need remuxing');
});

test('isAudioTrackNativelyPlayable respects allowedAudioChannels setting', () => {
    // -------------------------------------------------------------------------
    // User configured max channels to 6 (5.1 surround)
    // -------------------------------------------------------------------------
    const { isAudioTrackNativelyPlayable } = setup({
        allowedAudioChannels: 6
    });

    // 8 channels (7.1) should not be considered natively playable without transcode
    assert.strictEqual(isAudioTrackNativelyPlayable({ Codec: 'eac3', Channels: 8 }), false);
    assert.strictEqual(isAudioTrackNativelyPlayable({ Codec: 'aac', Channels: 8 }), false);

    // 6 channels (5.1) and 2 channels (stereo) are within limits and natively playable
    assert.strictEqual(isAudioTrackNativelyPlayable({ Codec: 'eac3', Channels: 6 }), true);
    assert.strictEqual(isAudioTrackNativelyPlayable({ Codec: 'aac', Channels: 2 }), true);
});

test('resolveBestAudioStream selects 5.1 track when default track is 7.1 and max channels is 5.1', () => {
    // -------------------------------------------------------------------------
    // When allowedAudioChannels is 6, resolveBestAudioStream should avoid the
    // 7.1 track and auto-select the 5.1 track in the matching language
    // -------------------------------------------------------------------------
    const { resolveBestAudioStream } = setup({
        preferDirectPlayAudio: true,
        allowedAudioChannels: 6
    });

    const mediaSource = {
        Id: 'source-71',
        DefaultAudioStreamIndex: 0,
        MediaStreams: [
            { Index: 0, Type: 'Audio', Codec: 'eac3', Channels: 8, Language: 'eng', IsDefault: true },
            { Index: 1, Type: 'Audio', Codec: 'ac3', Channels: 6, Language: 'eng', IsDefault: false }
        ]
    };

    const best = resolveBestAudioStream(mediaSource);
    assert.ok(best, 'Best audio stream should be resolved');
    assert.strictEqual(best.Index, 1, 'Should select English AC3 5.1 instead of EAC3 7.1');
});

// ============================================================================
// ExoPlayer Multi-Audio & DirectPlay Track Tests
// ============================================================================

test('doesAudioTrackRequireDirectStream returns false for exoplayer backend across all codecs', () => {
    // -------------------------------------------------------------------------
    // ExoPlayer runs natively via Android Media3 and demuxes multi-channel /
    // multi-track MKV/MP4 containers in hardware. It never requires server remuxing
    // to toggle audio tracks.
    // -------------------------------------------------------------------------
    const { doesAudioTrackRequireDirectStream } = setup();

    const mediaSource = {
        Id: 'mkv-multi-audio',
        MediaStreams: [
            { Index: 0, Type: 'Video', Codec: 'h264' },
            { Index: 1, Type: 'Audio', Codec: 'dts', Language: 'eng', IsDefault: true },
            { Index: 2, Type: 'Audio', Codec: 'truehd', Language: 'jpn', IsDefault: false },
            { Index: 3, Type: 'Audio', Codec: 'flac', Language: 'fra', IsDefault: false }
        ]
    };

    // All tracks should return false (no server direct-stream remux required)
    assert.strictEqual(
        doesAudioTrackRequireDirectStream(mediaSource, 1, 'exoplayer'),
        false,
        'ExoPlayer backend must not require direct stream for default DTS track'
    );
    assert.strictEqual(
        doesAudioTrackRequireDirectStream(mediaSource, 2, 'exoplayer'),
        false,
        'ExoPlayer backend must not require direct stream for secondary TrueHD track'
    );
    assert.strictEqual(
        doesAudioTrackRequireDirectStream(mediaSource, 3, 'exoplayer'),
        false,
        'ExoPlayer backend must not require direct stream for FLAC track'
    );
});

test('isAudioTrackNativelyPlayable treats advanced audio tracks as playable on exoplayer', () => {
    // -------------------------------------------------------------------------
    // Advanced backends like ExoPlayer have full hardware and software decoding
    // for rich codecs without browser-level Chromium audio pipeline constraints.
    // -------------------------------------------------------------------------
    const { isAudioTrackNativelyPlayable } = setup();

    assert.strictEqual(
        isAudioTrackNativelyPlayable({ Codec: 'truehd' }, null, 'exoplayer'),
        true,
        'ExoPlayer backend should treat TrueHD as playable'
    );
    assert.strictEqual(
        isAudioTrackNativelyPlayable({ Codec: 'dts' }, null, 'exoplayer'),
        true,
        'ExoPlayer backend should treat DTS as playable'
    );
    assert.strictEqual(
        isAudioTrackNativelyPlayable({ Codec: 'flac' }, null, 'exoplayer'),
        true,
        'ExoPlayer backend should treat FLAC as playable'
    );
});

// ============================================================================
// Fallback Audio Language Tests (ordered priority chain: primary -> fallback 1..3)
// ============================================================================

test('C1: uses first matching fallback when the preferred language is absent from the media', () => {
    // Preferred = fra (absent). Fallbacks: eng (present), deu (present, lower priority).
    const { resolveBestAudioStream } = setup(
        { preferDirectPlayAudio: true },
        {},
        { 'pref:audioLang': 'fra', 'pref:audioLangFallback1': 'eng', 'pref:audioLangFallback2': 'deu' }
    );

    const mediaSource = {
        Id: 'ms-fallback-1',
        DefaultAudioStreamIndex: 0,
        MediaStreams: [
            { Index: 0, Type: 'Audio', Codec: 'ac3', Channels: 6, Language: 'eng', IsDefault: true },
            { Index: 1, Type: 'Audio', Codec: 'aac', Channels: 2, Language: 'eng', IsDefault: false },
            { Index: 2, Type: 'Audio', Codec: 'ac3', Channels: 6, Language: 'deu', IsDefault: false }
        ]
    };

    const best = resolveBestAudioStream(mediaSource);
    assert.ok(best, 'Best audio stream should be resolved');
    // Preferred (fra) is absent -> fall to fallback1 (eng). Higher-priority eng must beat deu.
    assert.strictEqual(best.Language, 'eng', 'Should select the first matching fallback language (eng)');
    // Within the eng pool, prefer the higher-fidelity AC3 5.1 track over AAC stereo.
    assert.strictEqual(best.Index, 0, 'Should pick the best-quality track within the fallback language');
});

test('C2: primary preferred language present => unchanged behavior (fallback not consulted)', () => {
    // Preferred = fra (present). Fallback eng (also present) must be ignored.
    const { resolveBestAudioStream } = setup(
        { preferDirectPlayAudio: true },
        {},
        { 'pref:audioLang': 'fra', 'pref:audioLangFallback1': 'eng' }
    );

    const mediaSource = {
        Id: 'ms-fallback-2',
        DefaultAudioStreamIndex: 0,
        MediaStreams: [
            { Index: 0, Type: 'Audio', Codec: 'ac3', Channels: 6, Language: 'fra', IsDefault: true },
            { Index: 1, Type: 'Audio', Codec: 'aac', Channels: 2, Language: 'eng', IsDefault: false }
        ]
    };

    const best = resolveBestAudioStream(mediaSource);
    assert.ok(best, 'Best audio stream should be resolved');
    assert.strictEqual(best.Language, 'fra', 'Should keep the preferred language when it is present');
    assert.strictEqual(best.Index, 0, 'Fallback languages must not alter the selection when the primary matches');
});

test('C3: no primary nor any fallback match => existing default (Branch B) behavior preserved', () => {
    // Preferred = fra, fallback = deu. Media has only eng/spa -> none match -> Branch B.
    // Default TrueHD 7.1 is disabled/unplayable; Branch B should upgrade to the same-language AC3.
    const { resolveBestAudioStream } = setup(
        { preferDirectPlayAudio: true, enableTrueHd: 'disable' },
        {},
        { 'pref:audioLang': 'fra', 'pref:audioLangFallback1': 'deu' }
    );

    const mediaSource = {
        Id: 'ms-fallback-3',
        DefaultAudioStreamIndex: 0,
        MediaStreams: [
            { Index: 0, Type: 'Audio', Codec: 'truehd', Channels: 8, Language: 'eng', IsDefault: true },
            { Index: 1, Type: 'Audio', Codec: 'ac3', Channels: 6, Language: 'eng', IsDefault: false }
        ]
    };

    const best = resolveBestAudioStream(mediaSource);
    assert.ok(best, 'Best audio stream should be resolved');
    // Matches neither fra nor deu -> Branch B same-language upgrade picks the playable AC3.
    assert.strictEqual(best.Index, 1, 'Should fall through to the default/branch-B selection when nothing matches');
    assert.strictEqual(best.Language, 'eng', 'Branch B keeps the container default language');
});

test('C4: an explicit targetLang overrides and bypasses the global preferred/fallback chain', () => {
    // Global prefs point at deu (present) with fallback fra (present). Explicitly request eng.
    const { resolveBestAudioStream } = setup(
        { preferDirectPlayAudio: true },
        {},
        { 'pref:audioLang': 'deu', 'pref:audioLangFallback1': 'fra' }
    );

    const mediaSource = {
        Id: 'ms-fallback-4',
        DefaultAudioStreamIndex: 0,
        MediaStreams: [
            { Index: 0, Type: 'Audio', Codec: 'ac3', Channels: 6, Language: 'eng', IsDefault: true },
            { Index: 1, Type: 'Audio', Codec: 'aac', Channels: 2, Language: 'deu', IsDefault: false },
            { Index: 2, Type: 'Audio', Codec: 'aac', Channels: 2, Language: 'fra', IsDefault: false }
        ]
    };

    const best = resolveBestAudioStream(mediaSource, 'eng');
    assert.ok(best, 'Best audio stream should be resolved');
    assert.strictEqual(best.Language, 'eng', 'Explicit target must win over the configured preferred language');
    assert.strictEqual(best.Index, 0, 'Global preferences/fallbacks must not alter an explicit override');
});

test('C4: explicit targetLang with no matching track falls through to default behavior', () => {
    const { resolveBestAudioStream } = setup(
        { preferDirectPlayAudio: true },
        {},
        { 'pref:audioLang': 'deu' }
    );

    // Media has no eng track; explicitly requesting eng should not force fra/deu fallbacks.
    const mediaSource = {
        Id: 'ms-fallback-4b',
        DefaultAudioStreamIndex: 0,
        MediaStreams: [
            { Index: 0, Type: 'Audio', Codec: 'ac3', Channels: 6, Language: 'spa', IsDefault: true },
            { Index: 1, Type: 'Audio', Codec: 'aac', Channels: 2, Language: 'deu', IsDefault: false }
        ]
    };

    const best = resolveBestAudioStream(mediaSource, 'eng');
    assert.ok(best, 'Best audio stream should be resolved');
    // No eng track + explicit override => Branch B default (container default spa).
    assert.strictEqual(best.Index, 0, 'Explicit miss must fall back to the container default, not global prefs');
});

test('C5: unconfigured fallback slots (none or Default) are cleanly bypassed in priority chain', () => {
    // Primary preferred is absent (fra). Slot 1 is unconfigured ('none'), Slot 2 has a match ('eng').
    // The resolver must seamlessly bypass unconfigured/none slots and advance to the next valid fallback.
    const { resolveBestAudioStream } = setup(
        { preferDirectPlayAudio: true },
        {},
        { 'pref:audioLang': 'fra', 'pref:audioLangFallback1': 'none', 'pref:audioLangFallback2': 'eng' }
    );

    const mediaSource = {
        Id: 'ms-fallback-5',
        DefaultAudioStreamIndex: 0,
        MediaStreams: [
            { Index: 0, Type: 'Audio', Codec: 'ac3', Channels: 6, Language: 'spa', IsDefault: true },
            { Index: 1, Type: 'Audio', Codec: 'aac', Channels: 2, Language: 'eng', IsDefault: false }
        ]
    };

    const best = resolveBestAudioStream(mediaSource);
    assert.ok(best, 'Best audio stream should be resolved');
    // Slot 1 ('none') must be ignored; Slot 2 ('eng') matches track Index 1
    assert.strictEqual(best.Language, 'eng', 'Should skip unconfigured none slot and resolve next valid fallback (eng)');
    assert.strictEqual(best.Index, 1, 'Should select correct track from the active fallback slot');
});

// ============================================================================
// TrueHD Remux & DirectStream Tests
// ============================================================================

test('doesAudioTrackRequireDirectStream: Single TrueHD track requires DirectStream remux on WebOS', () => {
    // WebOS devices do not decode TrueHD in internal web apps.
    // When a media file contains only a single TrueHD audio stream, it CANNOT DirectPlay
    // and must be remuxed (DirectStream) so the server transcodes audio while copying video.
    const { doesAudioTrackRequireDirectStream } = setup({
        enableTrueHd: 'disable'
    }, {
        truehd: false
    });

    const mediaSource = {
        Id: 'single-truehd-source',
        MediaStreams: [
            { Index: 1, Type: 'Audio', Codec: 'truehd', Channels: 8, Language: 'eng', IsDefault: true }
        ]
    };

    const requiresRemux = doesAudioTrackRequireDirectStream(mediaSource, 1, 'webos');
    assert.strictEqual(requiresRemux, true, 'Single TrueHD track must require DirectStream remux on WebOS');
});

test('doesAudioTrackRequireDirectStream: TrueHD default track requires DirectStream remux even if secondary track is AC3', () => {
    // If the physical default track in the container file is TrueHD (unsupported on WebOS),
    // progressive DirectPlay will cause WebOS hardware demuxer to choke on opening the file.
    // Both TrueHD and AC3 track requests must return true to force DirectStream.
    const { doesAudioTrackRequireDirectStream } = setup({
        enableTrueHd: 'disable'
    }, {
        truehd: false
    });

    const mediaSource = {
        Id: 'truehd-default-with-ac3-source',
        MediaStreams: [
            { Index: 1, Type: 'Audio', Codec: 'truehd', Channels: 8, Language: 'eng', IsDefault: true },
            { Index: 2, Type: 'Audio', Codec: 'ac3', Channels: 6, Language: 'eng', IsDefault: false }
        ]
    };

    // Selecting TrueHD track (Index 1) requires remux because TrueHD cannot be decoded natively
    const requiresRemuxForTrueHd = doesAudioTrackRequireDirectStream(mediaSource, 1, 'webos');
    assert.strictEqual(requiresRemuxForTrueHd, true, 'TrueHD track must require DirectStream remux');

    // Selecting AC3 track (Index 2) also requires remux because container default is unplayable TrueHD
    const requiresRemuxForAc3 = doesAudioTrackRequireDirectStream(mediaSource, 2, 'webos');
    assert.strictEqual(requiresRemuxForAc3, true, 'AC3 track must require remux when container default track is unplayable TrueHD');
});

test('doesAudioTrackRequireDirectStream: TrueHD track requires DirectStream on Tizen when TrueHD is unsupported', () => {
    // On Tizen AVPlay, if TrueHD is not supported by the TV, playing TrueHD via DirectPlay fails.
    // The engine must signal DirectStream so audio is transcoded.
    const { doesAudioTrackRequireDirectStream } = setup({
        enableTrueHd: 'disable'
    }, {
        truehd: false
    });

    const mediaSource = {
        Id: 'tizen-truehd-source',
        MediaStreams: [
            { Index: 1, Type: 'Audio', Codec: 'truehd', Channels: 8, Language: 'eng', IsDefault: true },
            { Index: 2, Type: 'Audio', Codec: 'ac3', Channels: 6, Language: 'eng', IsDefault: false }
        ]
    };

    const requiresRemux = doesAudioTrackRequireDirectStream(mediaSource, 1, 'avplay');
    assert.strictEqual(requiresRemux, true, 'TrueHD track on Tizen without TrueHD capability must require DirectStream');
});

test('doesAudioTrackRequireDirectStream: TrueHD track does NOT require remux on ExoPlayer or Movi when TrueHD is supported', () => {
    // Advanced media backends (ExoPlayer on Android, MoviPlayer via FFmpeg WASM) decode TrueHD natively.
    // They demux and decode multi-channel lossless audio without needing server-side remux.
    const { doesAudioTrackRequireDirectStream } = setup({
        enableTrueHd: 'auto'
    }, {
        truehd: true
    });

    const mediaSource = {
        Id: 'advanced-truehd-source',
        MediaStreams: [
            { Index: 1, Type: 'Audio', Codec: 'truehd', Channels: 8, Language: 'eng', IsDefault: true },
            { Index: 2, Type: 'Audio', Codec: 'ac3', Channels: 6, Language: 'eng', IsDefault: false }
        ]
    };

    const exoRemux = doesAudioTrackRequireDirectStream(mediaSource, 1, 'exoplayer');
    assert.strictEqual(exoRemux, false, 'ExoPlayer must not require remux for TrueHD when enabled');

    const moviRemux = doesAudioTrackRequireDirectStream(mediaSource, 1, 'movi');
    assert.strictEqual(moviRemux, false, 'Movi backend must not require remux for TrueHD when enabled');
});
