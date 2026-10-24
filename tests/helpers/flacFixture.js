import { crc8 } from '../../src/music/flac/flacFrames.js';

export const SAMPLE_RATE = 44100;
export const CHANNELS = 2;
export const BITS = 16;
export const BLOCK = 4096;

export function streamInfoBody({
    sampleRate = SAMPLE_RATE,
    channels = CHANNELS,
    bitsPerSample = BITS,
    totalSamples = 0,
    minBlockSize = BLOCK,
    maxBlockSize = BLOCK
} = {}) {
    const si = new Uint8Array(34);
    si[0] = minBlockSize >> 8;
    si[1] = minBlockSize & 0xff;
    si[2] = maxBlockSize >> 8;
    si[3] = maxBlockSize & 0xff;
    si[4] = 0x01;
    si[9] = 0x02;
    si[10] = (sampleRate >> 12) & 0xff;
    si[11] = (sampleRate >> 4) & 0xff;
    si[12] = ((sampleRate & 0x0f) << 4) | ((channels - 1) << 1) | ((bitsPerSample - 1) >> 4);
    si[13] = (((bitsPerSample - 1) & 0x0f) << 4) | (Math.floor(totalSamples / 4294967296) & 0x0f);
    si[14] = (totalSamples >>> 24) & 0xff;
    si[15] = (totalSamples >>> 16) & 0xff;
    si[16] = (totalSamples >>> 8) & 0xff;
    si[17] = totalSamples & 0xff;
    si.fill(0xab, 18, 34);
    return si;
}

export function codedNumber(n) {
    if (n < 0x80) return [n];
    if (n < 0x800) return [0xc0 | (n >> 6), 0x80 | (n & 0x3f)];
    if (n < 0x10000) return [0xe0 | (n >> 12), 0x80 | ((n >> 6) & 0x3f), 0x80 | (n & 0x3f)];
    return [0xf0 | (n >> 18), 0x80 | ((n >> 12) & 0x3f), 0x80 | ((n >> 6) & 0x3f), 0x80 | (n & 0x3f)];
}

export function frameHeader(number, blockSize = BLOCK) {
    const fixed = blockSize === BLOCK;
    const blockCode = fixed ? 12 : 7;
    const bytes = [0xff, 0xf8, (blockCode << 4) | 9, ((CHANNELS - 1) << 4) | (4 << 1), ...codedNumber(number)];
    if (!fixed) bytes.push((blockSize - 1) >> 8, (blockSize - 1) & 0xff);
    const header = new Uint8Array(bytes.length + 1);
    header.set(bytes);
    header[bytes.length] = crc8(header, 0, bytes.length);
    return header;
}

export function frame(number, { blockSize = BLOCK, payload = new Uint8Array(64) } = {}) {
    const header = frameHeader(number, blockSize);
    const out = new Uint8Array(header.length + payload.length + 2);
    out.set(header);
    out.set(payload, header.length);
    return out;
}

export function concat(parts) {
    const size = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(size);
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return out;
}

export function metadataBlock(type, body, last) {
    const head = new Uint8Array([
        (last ? 0x80 : 0) | type,
        body.length >> 16,
        (body.length >> 8) & 0xff,
        body.length & 0xff
    ]);
    return concat([head, body]);
}

export function id3Tag(bodyLength) {
    const head = new Uint8Array(10);
    head.set([0x49, 0x44, 0x33, 4, 0, 0]);
    head[6] = (bodyLength >> 21) & 0x7f;
    head[7] = (bodyLength >> 14) & 0x7f;
    head[8] = (bodyLength >> 7) & 0x7f;
    head[9] = bodyLength & 0x7f;
    return concat([head, new Uint8Array(bodyLength).fill(0xff)]);
}

export function flacFile({ frames, totalSamples, extraBlocks = [], id3 = 0 }) {
    const blocks = [metadataBlock(0, streamInfoBody({ totalSamples }), extraBlocks.length === 0)];
    extraBlocks.forEach((b, i) => blocks.push(metadataBlock(b.type, b.body, i === extraBlocks.length - 1)));
    const prefix = id3 > 0 ? [id3Tag(id3)] : [];
    return concat([...prefix, new Uint8Array([0x66, 0x4c, 0x61, 0x43]), ...blocks, ...frames]);
}

export function standardFrames(fullFrames, lastBlockSize, payloadFor = () => new Uint8Array(64)) {
    const frames = [];
    for (let i = 0; i < fullFrames; i++) frames.push(frame(i, { payload: payloadFor(i) }));
    if (lastBlockSize > 0) frames.push(frame(fullFrames, { blockSize: lastBlockSize }));
    return frames;
}
