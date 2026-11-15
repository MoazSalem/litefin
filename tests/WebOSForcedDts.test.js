import assert from 'node:assert/strict';
import test from 'node:test';

// Minimal browser globals so the capability helpers load in Node.
const storageMap = new Map();
globalThis.localStorage = {
    getItem: (key) => storageMap.get(key) || null,
    setItem: (key, val) => storageMap.set(String(key), String(val)),
    removeItem: (key) => storageMap.delete(key),
    clear: () => storageMap.clear()
};
globalThis.document = {
    createElement: () => ({ canPlayType: () => '' }),
    addEventListener: () => {},
    removeEventListener: () => {}
};
globalThis.screen = { width: 1920, height: 1080 };
globalThis.window = globalThis;
if (typeof globalThis.navigator !== 'undefined') {
    Object.defineProperty(globalThis.navigator, 'userAgent', {
        value: 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36 WebAppManager',
        configurable: true
    });
} else {
    Object.defineProperty(globalThis, 'navigator', {
        value: { userAgent: 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36 WebAppManager' },
        configurable: true
    });
}

const { PlayerSettings } = await import('../src/utils/PlayerSettings.js');
const { doesAudioTrackRequireDirectStream, isAudioTrackNativelyPlayable } = await import('../src/player/core/StreamUtils.js');
const { mapDefaultFirstAudioIndex } = await import('../src/player/core/AudioTrackMap.js');
const { platformInfo } = await import('../src/utils/PlatformInfo.js');

// Default is AAC stereo (natively playable here); DTS 5.1 and DTS-HD MA 7.1 are non-default alternatives.
const mediaSource = {
    Container: 'mkv',
    MediaStreams: [
        { Index: 1, Type: 'Audio', Codec: 'aac', Channels: 2, IsDefault: true, Language: 'eng' },
        { Index: 2, Type: 'Audio', Codec: 'dts', Channels: 6, IsDefault: false, Language: 'eng' },
        { Index: 3, Type: 'Audio', Codec: 'dts', Channels: 8, IsDefault: false, Language: 'eng' }
    ]
};

test('forced DTS on webOS: DTS stays in DirectPlay, no remux', () => {
    PlayerSettings.set('enableDts', 'enable');
    assert.equal(doesAudioTrackRequireDirectStream(mediaSource, 2, 'webos'), false);
    assert.equal(doesAudioTrackRequireDirectStream(mediaSource, 3, 'webos'), false);
});

test('forced DTS on webOS: 7.1 DTS-HD is natively playable (8-channel allowance)', () => {
    PlayerSettings.set('enableDts', 'enable');
    assert.equal(isAudioTrackNativelyPlayable(mediaSource.MediaStreams[2], mediaSource, 'webos'), true);
});

test('Auto DTS on webOS: still remuxes and 7.1 stays capped', () => {
    PlayerSettings.set('enableDts', 'auto');
    assert.equal(doesAudioTrackRequireDirectStream(mediaSource, 2, 'webos'), true);
    assert.equal(isAudioTrackNativelyPlayable(mediaSource.MediaStreams[2], mediaSource, 'webos'), false);
});

test('Disabled DTS on webOS: remuxes', () => {
    PlayerSettings.set('enableDts', 'disable');
    assert.equal(doesAudioTrackRequireDirectStream(mediaSource, 2, 'webos'), true);
});

test('forced DTS on webOS: a TrueHD default track does not force a remux of DTS', () => {
    const truehdDefault = {
        Container: 'mkv',
        MediaStreams: [
            { Index: 1, Type: 'Audio', Codec: 'truehd', Channels: 8, IsDefault: true, Language: 'eng' },
            { Index: 2, Type: 'Audio', Codec: 'dts', Channels: 6, IsDefault: false, Language: 'eng' },
            { Index: 3, Type: 'Audio', Codec: 'ac3', Channels: 6, IsDefault: false, Language: 'eng' }
        ]
    };
    PlayerSettings.set('enableTrueHd', 'auto');
    PlayerSettings.set('enableDts', 'enable');
    assert.equal(doesAudioTrackRequireDirectStream(truehdDefault, 2, 'webos'), false, 'forced DTS: DirectPlay');
    assert.equal(doesAudioTrackRequireDirectStream(truehdDefault, 3, 'webos'), true, 'AC-3 still remuxes past an unplayable default');
    PlayerSettings.set('enableDts', 'auto');
    assert.equal(doesAudioTrackRequireDirectStream(truehdDefault, 2, 'webos'), true, 'Auto DTS still remuxes');
});

test('forced DTS on webOS: delegates to platformInfo.isWebOS when backendType is omitted', () => {
    // Ensure platformInfo reflects the active webOS environment
    platformInfo.reset();
    assert.equal(platformInfo.isWebOS, true, 'environment must be detected as webOS');

    PlayerSettings.set('enableDts', 'enable');
    // Calling doesAudioTrackRequireDirectStream without backendType argument
    assert.equal(doesAudioTrackRequireDirectStream(mediaSource, 2), false, 'omitted backendType resolves via platformInfo.isWebOS');
});

test('raw container streams mapping: default-first maps DTS correctly when TrueHD is on Auto', () => {
    // Media with physical tracks: TrueHD (dropped by TV), DTS (non-default), AAC (default), AC-3
    const containerStreams = [
        { Index: 1, Type: 'Audio', Codec: 'truehd', Channels: 8, IsDefault: true },
        { Index: 2, Type: 'Audio', Codec: 'dts', Channels: 6, IsDefault: false },
        { Index: 3, Type: 'Audio', Codec: 'aac', Channels: 2, IsDefault: true },
        { Index: 4, Type: 'Audio', Codec: 'ac3', Channels: 6, IsDefault: false }
    ];

    // TV native list has 3 tracks (TrueHD omitted: AAC default first, followed by DTS and AC-3)
    const nativeTrackCount = 3;

    // Passing unfiltered containerStreams ensures mapDefaultFirstAudioIndex sees TrueHD at index 0
    // and maps target stream 2 (DTS) to native index 1 (behind the default AAC track at 0)
    const nativeIndex = mapDefaultFirstAudioIndex(containerStreams, nativeTrackCount, 2);
    assert.equal(nativeIndex, 1, 'DTS maps to native index 1 in the reordered list');

    // Dropped TrueHD track reports -1
    const trueHdNativeIndex = mapDefaultFirstAudioIndex(containerStreams, nativeTrackCount, 1);
    assert.equal(trueHdNativeIndex, -1, 'dropped TrueHD returns -1');
});
