import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildMiniFlac,
    crc8,
    findFrameStart,
    nextFrameNumber,
    parseFrameHeader,
    parseStreamInfo
} from '../src/music/flac/flacFrames.js';
import { concat, frame, frameHeader, streamInfoBody } from './helpers/flacFixture.js';

const ascii = (s) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));

test('parseStreamInfo reads rate, channels, depth, totals and block sizes', () => {
    const info = parseStreamInfo(
        streamInfoBody({ sampleRate: 88200, channels: 6, bitsPerSample: 24, totalSamples: 5000000000 })
    );
    assert.deepEqual(info, {
        sampleRate: 88200,
        channels: 6,
        bitsPerSample: 24,
        totalSamples: 5000000000,
        minBlockSize: 4096,
        maxBlockSize: 4096
    });
});

test('crc8 matches the CRC-8 (poly 0x07) check value', () => {
    assert.equal(crc8(ascii('123456789'), 0, 9), 0xf4);
    assert.equal(crc8(new Uint8Array(0), 0, 0), 0);
    assert.equal(crc8(ascii('xx123456789'), 2, 11), 0xf4);
});

test('parseFrameHeader decodes a valid fixed-block header', () => {
    const info = parseStreamInfo(streamInfoBody());
    const header = frameHeader(300);
    assert.deepEqual(parseFrameHeader(header, 0, info), {
        blockSize: 4096,
        frameOrSampleNumber: 300,
        headerLength: header.length,
        variableBlockSize: false
    });
});

test('parseFrameHeader reads an explicit 16-bit block size', () => {
    const info = parseStreamInfo(streamInfoBody());
    assert.equal(parseFrameHeader(frameHeader(7, 1000), 0, info).blockSize, 1000);
});

test('parseFrameHeader rejects bad sync, bad CRC, reserved bits and mismatched channels', () => {
    const info = parseStreamInfo(streamInfoBody());
    const good = frameHeader(5);
    const badCrc = good.slice();
    badCrc[good.length - 1] ^= 0x01;
    const reserved = good.slice();
    reserved[3] |= 0x01;
    const noSync = good.slice();
    noSync[1] = 0xf0;
    assert.equal(parseFrameHeader(badCrc, 0, info), null);
    assert.equal(parseFrameHeader(reserved, 0, info), null);
    assert.equal(parseFrameHeader(noSync, 0, info), null);
    assert.equal(parseFrameHeader(good, 0, parseStreamInfo(streamInfoBody({ channels: 1 }))), null);
    assert.equal(parseFrameHeader(good.subarray(0, 4), 0, info), null);
});

test('nextFrameNumber follows the blocking strategy', () => {
    assert.equal(nextFrameNumber({ frameOrSampleNumber: 4, blockSize: 4096, variableBlockSize: false }), 5);
    assert.equal(nextFrameNumber({ frameOrSampleNumber: 8192, blockSize: 4096, variableBlockSize: true }), 12288);
});

test('findFrameStart skips a false sync inside frame data', () => {
    const info = parseStreamInfo(streamInfoBody());
    const fakeWithWrongNumber = frameHeader(99);
    const fakeBadCrc = frameHeader(1);
    fakeBadCrc[fakeBadCrc.length - 1] ^= 0xff;
    const payload = concat([
        new Uint8Array(10),
        fakeWithWrongNumber,
        new Uint8Array(5),
        fakeBadCrc,
        new Uint8Array(10)
    ]);
    const first = frame(0, { payload });
    const bytes = concat([first, frame(1), new Uint8Array(32)]);
    assert.equal(findFrameStart(bytes, 1, info, 1), first.length);
    assert.equal(findFrameStart(bytes, first.length + 1, info, 2), -1);
});

test('findFrameStart only inspects positions with a full header window unless final', () => {
    const info = parseStreamInfo(streamInfoBody());
    const bytes = concat([frame(0), frame(1, { payload: new Uint8Array(2) })]);
    const at = frame(0).length;
    assert.equal(findFrameStart(bytes, 1, info, 1), -1);
    assert.equal(findFrameStart(bytes, 1, info, 1, true), at);
});

test('buildMiniFlac writes one STREAMINFO block with the chunk total and appends frames', () => {
    const si = streamInfoBody({ totalSamples: 123456 });
    const frames = [frame(0), frame(1)];
    const mini = buildMiniFlac(si, frames, 8192);
    assert.deepEqual([...mini.subarray(0, 8)], [0x66, 0x4c, 0x61, 0x43, 0x80, 0, 0, 34]);
    const info = parseStreamInfo(mini.subarray(8, 42));
    assert.equal(info.totalSamples, 8192);
    assert.equal(info.sampleRate, 44100);
    assert.equal(info.maxBlockSize, 4096);
    assert.ok(mini.subarray(12, 18).every((b) => b === 0));
    assert.ok(mini.subarray(26, 42).every((b) => b === 0));
    assert.deepEqual(mini.subarray(42), concat(frames));
    assert.equal(si[17], 123456 & 0xff);
});
