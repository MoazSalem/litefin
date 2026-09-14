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

        ({ isTrueHdSupported, isDtsSupported, isAudioTrackNativelyPlayable, resolveBestAudioStream });
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
