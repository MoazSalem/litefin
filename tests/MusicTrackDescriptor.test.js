import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeMusicTrack } from '../src/music/trackDescriptor.js';

const api = { serverUrl: 'http://srv', accessToken: 'tok en', deviceId: 'dev1' };
const platform = { isWebOS: true, isEmby: false, gaplessAvailable: true };
const EAC3 = { Id: 'ms1', Container: 'm4a', MediaStreams: [{ Type: 'Audio', Codec: 'eac3' }] };
const FLAC = { Id: 'ms2', Container: 'flac', MediaStreams: [{ Type: 'Audio', Codec: 'flac' }] };

const describe = (mediaSource, overrides = {}) =>
    describeMusicTrack({
        item: { Id: 'item9' },
        mediaSource,
        soundOutput: 'external_arc',
        platform,
        supportsMse: () => true,
        api,
        now: 1700,
        ...overrides
    });

test('an E-AC-3 soundbar track gets an HLS copy URL with the real credentials and session id', () => {
    const { url, kind, mime } = describe(EAC3);
    assert.equal(kind, 'mse');
    assert.equal(mime, 'audio/mp4; codecs="ec-3"');
    assert.ok(url.startsWith('http://srv/Audio/item9/main.m3u8?'));
    assert.match(url, /mediaSourceId=ms1/);
    assert.match(url, /deviceId=dev1/);
    assert.match(url, /ApiKey=tok%20en/);
    assert.match(url, /PlaySessionId=dev1-item9-1700/);
    assert.match(url, /audioCodec=copy/);
    assert.doesNotMatch(url, /audioSampleRate/);
});

test('a FLAC soundbar track is transcoded at 48000', () => {
    const { url, mime } = describe(FLAC);
    assert.equal(mime, 'audio/mp4; codecs="flac"');
    assert.match(url, /audioCodec=flac/);
    assert.match(url, /audioSampleRate=48000/);
});

test('TV speakers keep the static URL and carry no mime', () => {
    const descriptor = describe(FLAC, { soundOutput: 'tv_speaker' });
    assert.equal(descriptor.kind, 'flac');
    assert.equal(descriptor.mime, undefined);
    assert.ok(descriptor.url.startsWith('http://srv/Audio/item9/stream'));
});

test('MSE support is asked per track mime', () => {
    const asked = [];
    const descriptor = describe(EAC3, {
        supportsMse: (mime) => {
            asked.push(mime);
            return false;
        }
    });
    assert.deepEqual(asked, ['audio/mp4; codecs="ec-3"']);
    assert.equal(descriptor.kind, 'native');
});
