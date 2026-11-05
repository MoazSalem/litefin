import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webAudioAudibleOn, watchSoundOutput } from '../src/music/soundOutput.js';

test('web audio is audible on the TV speakers', () => {
    assert.equal(webAudioAudibleOn('tv_speaker'), true);
});

test('web audio is not audible over ARC/eARC or optical', () => {
    assert.equal(webAudioAudibleOn('external_arc'), false);
    assert.equal(webAudioAudibleOn('external_optical'), false);
    assert.equal(webAudioAudibleOn('bt_soundbar'), false);
});

test('unknown output keeps web audio', () => {
    assert.equal(webAudioAudibleOn(null), true);
    assert.equal(webAudioAudibleOn(undefined), true);
});

function fakeBridge() {
    const bridge = { calls: [] };
    bridge.call = (uri, params) => bridge.calls.push({ uri, params: JSON.parse(params) });
    return bridge;
}

test('subscribes to the sound output setting', () => {
    const bridge = fakeBridge();
    watchSoundOutput(
        () => bridge,
        () => {}
    );
    assert.deepEqual(bridge.calls, [
        {
            uri: 'luna://com.webos.settingsservice/getSystemSettings',
            params: { category: 'sound', keys: ['soundOutput'], subscribe: true }
        }
    ]);
});

test('reports the initial value and later changes', () => {
    const bridge = fakeBridge();
    const seen = [];
    watchSoundOutput(
        () => bridge,
        (value) => seen.push(value)
    );
    bridge.onservicecallback('{"returnValue":true,"settings":{"soundOutput":"tv_speaker"}}');
    bridge.onservicecallback('{"returnValue":true,"settings":{"soundOutput":"external_arc"}}');
    assert.deepEqual(seen, ['tv_speaker', 'external_arc']);
});

test('ignores failed replies, replies without the key and malformed JSON', () => {
    const bridge = fakeBridge();
    const seen = [];
    watchSoundOutput(
        () => bridge,
        (value) => seen.push(value)
    );
    bridge.onservicecallback('{"returnValue":false,"errorText":"denied"}');
    bridge.onservicecallback('{"returnValue":true,"settings":{}}');
    bridge.onservicecallback('not json');
    assert.deepEqual(seen, []);
});
