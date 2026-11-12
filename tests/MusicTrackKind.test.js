import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audioKindOf, supportsGaplessEngine } from '../src/music/trackKind.js';

test('flac container is flac', () => {
    assert.equal(audioKindOf({ Container: 'flac' }), 'flac');
    assert.equal(audioKindOf({ Container: 'FLAC' }), 'flac');
});

test('lossy and surround containers stay native', () => {
    assert.equal(audioKindOf({ Container: 'mp3' }), 'native');
    assert.equal(audioKindOf({ Container: 'm4a', MediaStreams: [{ Type: 'Audio', Codec: 'eac3' }] }), 'native');
    assert.equal(audioKindOf({ Container: 'mp4', MediaStreams: [{ Type: 'Audio', Codec: 'truehd' }] }), 'native');
});

test('flac codec inside another container stays native (engine reads raw FLAC only)', () => {
    assert.equal(audioKindOf({ Container: 'ogg', MediaStreams: [{ Type: 'Audio', Codec: 'flac' }] }), 'native');
    assert.equal(audioKindOf({ Container: 'mka', MediaStreams: [{ Type: 'Audio', Codec: 'flac' }] }), 'native');
});

test('missing container falls back to the audio stream codec', () => {
    assert.equal(audioKindOf({ MediaStreams: [{ Type: 'Video' }, { Type: 'Audio', Codec: 'flac' }] }), 'flac');
    assert.equal(audioKindOf({ MediaStreams: [{ Type: 'Audio', Codec: 'aac' }] }), 'native');
    assert.equal(audioKindOf({}), 'native');
    assert.equal(audioKindOf(null), 'native');
});

test('gapless engine needs Web Audio, fetch and streams', () => {
    const fn = function () {};
    assert.equal(supportsGaplessEngine({ AudioContext: fn, fetch: fn, ReadableStream: fn }), true);
    assert.equal(supportsGaplessEngine({ webkitAudioContext: fn, fetch: fn, ReadableStream: fn }), true);
    assert.equal(supportsGaplessEngine({ fetch: fn, ReadableStream: fn }), false);
    assert.equal(supportsGaplessEngine({ AudioContext: fn, ReadableStream: fn }), false);
    assert.equal(supportsGaplessEngine({ AudioContext: fn, fetch: fn }), false);
    assert.equal(supportsGaplessEngine(undefined), false);
});
