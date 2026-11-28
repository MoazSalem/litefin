import assert from 'node:assert/strict';
import test from 'node:test';
import { initFormat } from '../src/music/mseInitFormat.js';

const ascii = (text) => [...text].map((c) => c.charCodeAt(0));
const box = (type, ...children) => {
    const body = children.flat();
    const size = 8 + body.length;
    return [size >>> 24, (size >>> 16) & 255, (size >>> 8) & 255, size & 255, ...ascii(type), ...body];
};
const init = (...stsdChildren) =>
    new Uint8Array([
        ...box('ftyp', [0, 0, 0, 0]),
        ...box('moov', box('trak', box('stsd', [0, 0, 0, 1], ...stsdChildren)))
    ]);

test('initFormat is equal for inits whose sample description matches', () => {
    const a = init(box('fLaC', [0, 2, 0, 24], box('dfLa', [1, 2, 3])));
    const b = init(box('fLaC', [0, 2, 0, 24], box('dfLa', [1, 2, 3])));
    assert.equal(initFormat(a), initFormat(b));
});

test('initFormat differs when channels, bit depth or codec config differ', () => {
    const stereo24 = initFormat(init(box('fLaC', [0, 2, 0, 24], box('dfLa', [1, 2, 3]))));
    assert.notEqual(stereo24, initFormat(init(box('fLaC', [0, 6, 0, 24], box('dfLa', [1, 2, 3])))));
    assert.notEqual(stereo24, initFormat(init(box('fLaC', [0, 2, 0, 16], box('dfLa', [1, 2, 3])))));
    assert.notEqual(stereo24, initFormat(init(box('ec-3', [0, 6, 0, 16], box('dec3', [9])))));
});

test('initFormat ignores the bitrate box, which varies per file without changing the decoder', () => {
    const a = init(box('mp4a', [0, 2, 0, 16], box('esds', [5]), box('btrt', [0, 0, 1, 244])));
    const b = init(box('mp4a', [0, 2, 0, 16], box('esds', [5]), box('btrt', [0, 0, 3, 32])));
    assert.equal(initFormat(a), initFormat(b));
});

test('initFormat returns null without a sample description', () => {
    assert.equal(initFormat(new Uint8Array([1, 2, 3])), null);
    assert.equal(initFormat(new Uint8Array(box('moov', [0]))), null);
});
