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
globalThis.navigator = {
    userAgent: 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36 WebAppManager'
};

const { PlayerSettings } = await import('../src/utils/PlayerSettings.js');
const { doesAudioTrackRequireDirectStream, isAudioTrackNativelyPlayable } = await import('../src/player/core/StreamUtils.js');

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
