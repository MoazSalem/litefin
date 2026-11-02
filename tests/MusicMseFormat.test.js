import assert from 'node:assert/strict';
import test from 'node:test';
import { mseSourceFor, supportsMse } from '../src/music/mseFormat.js';

const withCodec = (Codec) => ({
    MediaStreams: [
        { Type: 'Video', Codec: 'h264' },
        { Type: 'Audio', Codec }
    ]
});
const FLAC = { audioCodec: 'flac', sampleRate: 48000, mime: 'audio/mp4; codecs="flac"' };

test('mseSourceFor copies eac3, ac3 and aac', () => {
    assert.deepEqual(mseSourceFor(withCodec('eac3')), {
        audioCodec: 'copy',
        sampleRate: null,
        mime: 'audio/mp4; codecs="ec-3"'
    });
    assert.deepEqual(mseSourceFor(withCodec('AC3')), {
        audioCodec: 'copy',
        sampleRate: null,
        mime: 'audio/mp4; codecs="ac-3"'
    });
    assert.deepEqual(mseSourceFor(withCodec('aac')), {
        audioCodec: 'copy',
        sampleRate: null,
        mime: 'audio/mp4; codecs="mp4a.40.2"'
    });
});

test('mseSourceFor falls back to flac for everything else', () => {
    for (const codec of ['flac', 'mp3', 'truehd', 'opus', 'weird']) {
        assert.deepEqual(mseSourceFor(withCodec(codec)), FLAC);
    }
    assert.deepEqual(mseSourceFor({}), FLAC);
    assert.deepEqual(mseSourceFor({ MediaStreams: [] }), FLAC);
    assert.deepEqual(mseSourceFor(undefined), FLAC);
});

test('supportsMse', () => {
    assert.equal(supportsMse(undefined, 'm'), false);
    assert.equal(supportsMse({}, 'm'), false);
    assert.equal(supportsMse({ MediaSource: { isTypeSupported: () => false } }, 'm'), false);
    assert.equal(supportsMse({ MediaSource: { isTypeSupported: (m) => m === 'm' } }, 'm'), true);
});
