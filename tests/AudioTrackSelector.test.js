import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

// Extract the relevant functions directly from JellyfinPlayer.js source without pulling in the browser/CSS DOM tree
const source = readFileSync(new URL('../src/player/core/JellyfinPlayer.js', import.meta.url), 'utf8');

function setup(settings = {}, caps = {}) {
    const defaultCaps = {
        dts: false,
        truehd: false,
        ac3: true,
        eac3: true,
        opus: true,
        mp2: false,
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

    const storageMap = new Map();

    const context = vm.createContext({
        PlayerSettings: {
            get: (key) => currentSettings[key],
            set: (key, val) => { currentSettings[key] = val; }
        },
        getDeviceCapabilities: () => defaultCaps,
        storage: {
            getItem: (key) => storageMap.get(key) || null,
            setItem: (key, val) => storageMap.set(key, val),
            removeItem: (key) => storageMap.delete(key)
        },
        log: {
            info() {},
            debug() {},
            warn() {},
            error() {}
        }
    });

    // Run the exported functions in the VM context
    const code = `
        ${source.slice(
            source.indexOf('export const isTrueHdSupported ='),
            source.indexOf('// ============================================================================\n// Minimal EventEmitter')
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
    });

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


