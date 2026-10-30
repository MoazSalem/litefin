import { test } from 'node:test';
import assert from 'node:assert/strict';
import MseMediaPipeline from '../src/music/MseMediaPipeline.js';

const MIME = 'audio/mp4; codecs="ec-3"';
const FLAC = 'audio/mp4; codecs="flac"';
const noop = () => {};

function setup({ changeType = true, allowChangeType } = {}) {
    const audios = [];
    const mediaSources = [];
    const revoked = [];
    const pipeline = new MseMediaPipeline({
        ...(allowChangeType === undefined ? {} : { allowChangeType }),
        media: {
            createAudio: () => {
                const el = { error: null, src: '', addEventListener: noop, removeEventListener: noop };
                audios.push(el);
                return el;
            },
            createMediaSource: () => {
                const ms = {
                    readyState: 'open',
                    mimes: [],
                    addSourceBuffer(mime) {
                        ms.mimes.push(mime);
                        const calls = [];
                        const sb = {
                            calls,
                            buffered: { length: 0 },
                            addEventListener: noop,
                            removeEventListener: noop
                        };
                        if (changeType) sb.changeType = (type) => calls.push(type);
                        return sb;
                    }
                };
                mediaSources.push(ms);
                return ms;
            },
            createObjectUrl: () => `blob:ms${mediaSources.length}`,
            revokeObjectUrl: (url) => revoked.push(url)
        },
        timers: { setTimeoutFn: () => 0, clearTimeoutFn: noop },
        log: { warn: noop, debug: noop },
        onEnded: noop,
        onError: noop
    });
    return { pipeline, audios, mediaSources, revoked };
}

test('ensure keeps one element and one MediaSource while nothing broke', () => {
    const h = setup();
    h.pipeline.ensure(MIME);
    h.pipeline.ensureSourceBuffer(MIME);
    h.pipeline.ensure(FLAC);

    assert.equal(h.audios.length, 1);
    assert.equal(h.mediaSources.length, 1);
    assert.equal(h.audios[0].src, 'blob:ms1');
});

test('ensure rebuilds the MediaSource on the same element when the element carries an error', () => {
    const h = setup();
    h.pipeline.ensure(MIME);
    h.audios[0].error = { code: 4 };
    h.pipeline.ensure(MIME);

    assert.equal(h.audios.length, 1);
    assert.equal(h.mediaSources.length, 2);
    assert.deepEqual(h.revoked, ['blob:ms1']);
});

test('without changeType another codec needs a rebuilt MediaSource', () => {
    const h = setup({ changeType: false });
    h.pipeline.ensure(MIME);
    h.pipeline.ensureSourceBuffer(MIME);

    assert.equal(h.pipeline.canAppend(FLAC), false);
    assert.equal(h.pipeline.canAppend(MIME), true);
    h.pipeline.ensure(FLAC);
    assert.equal(h.mediaSources.length, 2);
});

test('switchType changes the SourceBuffer type only when the codec differs', () => {
    const h = setup();
    h.pipeline.ensure(MIME);
    h.pipeline.ensureSourceBuffer(MIME);
    const sb = h.pipeline.sourceBuffer;

    h.pipeline.switchType(sb, MIME);
    h.pipeline.switchType(sb, FLAC);
    h.pipeline.switchType(sb, FLAC);

    assert.deepEqual(sb.calls, [FLAC]);
    assert.equal(h.pipeline.canAppend(MIME), true);
});

test('allowChangeType false treats another codec as unappendable even when changeType exists', () => {
    const h = setup({ allowChangeType: false });
    h.pipeline.ensure(MIME);
    h.pipeline.ensureSourceBuffer(MIME);

    assert.equal(h.pipeline.canAppend(FLAC), false);
    assert.equal(h.pipeline.canAppend(MIME), true);
    h.pipeline.ensure(FLAC);
    assert.equal(h.mediaSources.length, 2);
    assert.equal(h.audios.length, 1);
});
