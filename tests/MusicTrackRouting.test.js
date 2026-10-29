import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeTrack } from '../src/music/trackKind.js';

const FLAC = { Container: 'flac' };
const EAC3 = { Container: 'm4a', MediaStreams: [{ Type: 'Audio', Codec: 'eac3' }] };
const base = { isWebOS: true, isEmby: false, gaplessAvailable: true, mseAvailable: true };

test('a soundbar on webOS routes FLAC and E-AC-3 through MSE', () => {
    assert.equal(routeTrack({ ...base, soundOutput: 'external_arc', mediaSource: FLAC }), 'mse');
    assert.equal(routeTrack({ ...base, soundOutput: 'external_arc', mediaSource: EAC3 }), 'mse');
});

test('TV speakers keep FLAC on the gapless engine and everything else native', () => {
    assert.equal(routeTrack({ ...base, soundOutput: 'tv_speaker', mediaSource: FLAC }), 'flac');
    assert.equal(routeTrack({ ...base, soundOutput: 'tv_speaker', mediaSource: EAC3 }), 'native');
});

test('an unknown output on webOS routes to MSE when supported', () => {
    assert.equal(routeTrack({ ...base, soundOutput: null, mediaSource: FLAC }), 'mse');
    assert.equal(routeTrack({ ...base, soundOutput: null, mseAvailable: false, mediaSource: FLAC }), 'flac');
});

test('an unknown output off webOS keeps the Web Audio route', () => {
    assert.equal(routeTrack({ ...base, isWebOS: false, soundOutput: null, mediaSource: FLAC }), 'flac');
});

test('Emby servers never use MSE', () => {
    assert.equal(routeTrack({ ...base, isEmby: true, soundOutput: 'external_arc', mediaSource: FLAC }), 'native');
});

test('without MSE support or off webOS a soundbar falls back to native', () => {
    assert.equal(
        routeTrack({ ...base, mseAvailable: false, soundOutput: 'external_arc', mediaSource: FLAC }),
        'native'
    );
    assert.equal(routeTrack({ ...base, isWebOS: false, soundOutput: 'external_arc', mediaSource: FLAC }), 'native');
});
