import assert from 'node:assert/strict';
import test from 'node:test';
import FlacChunker from '../src/music/flac/FlacChunker.js';
import { parseFrameHeader, parseStreamInfo } from '../src/music/flac/flacFrames.js';
import { SAMPLE_RATE, concat, flacFile, frame, frameHeader, standardFrames } from './helpers/flacFixture.js';

const MB = 1024 * 1024;
const MINI_HEADER_BYTES = 42;

function drain(chunker, bytes, pieceSize) {
    const chunks = [];
    const collect = () => {
        for (let c = chunker.take(); c; c = chunker.take()) chunks.push(c);
    };
    for (let at = 0; at < bytes.length; at += pieceSize) {
        chunker.push(bytes.subarray(at, at + pieceSize));
        collect();
    }
    chunker.end();
    collect();
    return chunks;
}

function assertChunksAreFrameAligned(chunks, totalSamples) {
    let expectedFirst = 0;
    for (const chunk of chunks) {
        const info = parseStreamInfo(chunk.bytes.subarray(8, MINI_HEADER_BYTES));
        assert.equal(info.totalSamples, chunk.samples);
        assert.equal(chunk.firstSample, expectedFirst);
        const header = parseFrameHeader(chunk.bytes, MINI_HEADER_BYTES, info);
        assert.ok(header, 'chunk must start on a frame header');
        assert.equal(header.frameOrSampleNumber * 4096, chunk.firstSample);
        expectedFirst += chunk.samples;
    }
    assert.equal(expectedFirst, totalSamples);
}

test('chunks land on frame starts, reach the target size and sum to the total samples', () => {
    const total = 20 * 4096 + 1000;
    const bytes = flacFile({ frames: standardFrames(20, 1000), totalSamples: total });
    const chunker = new FlacChunker({ targetSeconds: 0.5 });
    const chunks = drain(chunker, bytes, 7);
    assert.deepEqual(
        chunks.map((c) => c.samples),
        [6 * 4096, 6 * 4096, 6 * 4096, 2 * 4096 + 1000]
    );
    assertChunksAreFrameAligned(chunks, total);
    assert.equal(chunker.streamInfo.sampleRate, SAMPLE_RATE);
    assert.equal(chunker.done, true);
    assert.equal(chunker.take(), null);
});

test('a frame payload containing a false sync is not split', () => {
    const badCrc = frameHeader(3);
    badCrc[badCrc.length - 1] ^= 0xff;
    const fake = concat([frameHeader(2), new Uint8Array(4), badCrc, new Uint8Array(4), frameHeader(42)]);
    const frames = standardFrames(8, 0, (i) =>
        i === 2 ? concat([new Uint8Array(8), fake, new Uint8Array(8)]) : new Uint8Array(64)
    );
    const bytes = flacFile({ frames, totalSamples: 8 * 4096 });
    const chunks = drain(new FlacChunker({ targetSeconds: 0.2 }), bytes, 1000);
    assert.deepEqual(
        chunks.map((c) => c.samples),
        [3 * 4096, 3 * 4096, 2 * 4096]
    );
    assertChunksAreFrameAligned(chunks, 8 * 4096);
    assert.equal(chunks[0].bytes.length, MINI_HEADER_BYTES + frames[0].length + frames[1].length + frames[2].length);
});

test('ID3 prefix and non-STREAMINFO metadata blocks are skipped', () => {
    const total = 10 * 4096;
    const bytes = flacFile({
        frames: standardFrames(10, 0),
        totalSamples: total,
        id3: 3000,
        extraBlocks: [
            { type: 4, body: new Uint8Array(40).fill(0x41) },
            { type: 6, body: new Uint8Array(5000).fill(0xff) }
        ]
    });
    const chunks = drain(new FlacChunker({ targetSeconds: 0.5 }), bytes, 333);
    assertChunksAreFrameAligned(chunks, total);
    assert.deepEqual(
        chunks.map((c) => c.samples),
        [6 * 4096, 4 * 4096]
    );
});

test('a stream shorter than one target chunk yields a single final chunk', () => {
    const total = 2 * 4096 + 17;
    const chunks = drain(new FlacChunker(), flacFile({ frames: standardFrames(2, 17), totalSamples: total }), 64);
    assert.equal(chunks.length, 1);
    assertChunksAreFrameAligned(chunks, total);
});

test('take returns null until enough frames have arrived', () => {
    const bytes = flacFile({ frames: standardFrames(12, 0), totalSamples: 12 * 4096 });
    const chunker = new FlacChunker({ targetSeconds: 0.5 });
    chunker.push(bytes.subarray(0, 200));
    assert.equal(chunker.take(), null);
    chunker.push(bytes.subarray(200));
    assert.equal(chunker.take().samples, 6 * 4096);
    assert.equal(chunker.take(), null);
    chunker.end();
    assert.equal(chunker.take().samples, 6 * 4096);
    assert.equal(chunker.take(), null);
});

test('missing fLaC marker throws', () => {
    const chunker = new FlacChunker();
    chunker.push(new Uint8Array(64).fill(0x20));
    assert.throws(() => chunker.take(), /fLaC/);
});

test('no frame boundary within 4 MB throws', () => {
    const chunker = new FlacChunker();
    chunker.push(flacFile({ frames: [frameHeader(0)], totalSamples: 4096 }));
    assert.throws(() => {
        for (let i = 0; i < 5; i++) {
            chunker.push(new Uint8Array(MB));
            chunker.take();
        }
    }, /4 MB/);
});

test('a chunk larger than 8 MB throws', () => {
    const big = () => new Uint8Array(3 * MB);
    const frames = [0, 1, 2, 3].map((n) => frame(n, { payload: big() }));
    const chunker = new FlacChunker();
    assert.throws(() => drain(chunker, flacFile({ frames, totalSamples: 4 * 4096 }), MB), /8 MB/);
});
