import assert from 'node:assert/strict';
import test from 'node:test';

import { mapDefaultFirstAudioIndex } from '../src/player/core/AudioTrackMap.js';

// 10 Cloverfield Lane: TrueHD (default), two DTS, AAC (also flagged default), two AC-3.
// The TV's list has 5 entries: no TrueHD, default (AAC) first.
const cloverfield = [
    { Index: 1, Codec: 'truehd', IsDefault: true },
    { Index: 2, Codec: 'dts', IsDefault: false },
    { Index: 3, Codec: 'dts', IsDefault: false },
    { Index: 4, Codec: 'aac', IsDefault: true },
    { Index: 5, Codec: 'ac3', IsDefault: false },
    { Index: 6, Codec: 'ac3', IsDefault: false }
];

test('default-first: the native order is AAC, DTS, DTS, AC-3, commentary', () => {
    assert.equal(mapDefaultFirstAudioIndex(cloverfield, 5, 4), 0, '#4 AAC is the TV default');
    assert.equal(mapDefaultFirstAudioIndex(cloverfield, 5, 2), 1, '#2 DTS');
    assert.equal(mapDefaultFirstAudioIndex(cloverfield, 5, 3), 2, '#3 DTS');
    assert.equal(mapDefaultFirstAudioIndex(cloverfield, 5, 5), 3, '#5 AC-3 (was wrongly mapped to the commentary)');
    assert.equal(mapDefaultFirstAudioIndex(cloverfield, 5, 6), 4, '#6 commentary');
});

test('default-first: the dropped TrueHD track is not natively selectable', () => {
    assert.equal(mapDefaultFirstAudioIndex(cloverfield, 5, 1), -1);
});

test('default-first: without a remaining default, the file order is kept', () => {
    const streams = [
        { Index: 1, Codec: 'truehd', IsDefault: true },
        { Index: 2, Codec: 'ac3', IsDefault: false },
        { Index: 3, Codec: 'ac3', IsDefault: false }
    ];
    assert.equal(mapDefaultFirstAudioIndex(streams, 2, 2), 0);
    assert.equal(mapDefaultFirstAudioIndex(streams, 2, 3), 1);
});

test('default-first: a default that is already first keeps the file order', () => {
    const streams = [
        { Index: 1, Codec: 'truehd', IsDefault: false },
        { Index: 2, Codec: 'dts', IsDefault: true },
        { Index: 3, Codec: 'ac3', IsDefault: false }
    ];
    assert.equal(mapDefaultFirstAudioIndex(streams, 2, 2), 0);
    assert.equal(mapDefaultFirstAudioIndex(streams, 2, 3), 1);
});

test('default-first: does not apply when the counts match', () => {
    assert.equal(mapDefaultFirstAudioIndex(cloverfield, 6, 5), null);
});

test('default-first: does not apply when the dropped first stream is not TrueHD', () => {
    const streams = [
        { Index: 1, Codec: 'dts', IsDefault: true },
        { Index: 2, Codec: 'ac3', IsDefault: false },
        { Index: 3, Codec: 'ac3', IsDefault: false }
    ];
    assert.equal(mapDefaultFirstAudioIndex(streams, 2, 2), null);
});

test('default-first: does not apply when more than one track is missing', () => {
    assert.equal(mapDefaultFirstAudioIndex(cloverfield, 3, 4), null);
});

test('default-first: unknown target or empty input returns null', () => {
    assert.equal(mapDefaultFirstAudioIndex(cloverfield, 5, 99), null);
    assert.equal(mapDefaultFirstAudioIndex([], 0, 1), null);
    assert.equal(mapDefaultFirstAudioIndex(undefined, 0, 1), null);
});
