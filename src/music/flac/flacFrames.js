export const STREAMINFO_BYTES = 34;
export const MAX_FRAME_HEADER_BYTES = 16;

const FLAC_MARKER = [0x66, 0x4c, 0x61, 0x43];
const LAST_STREAMINFO_BLOCK_HEADER = [0x80, 0x00, 0x00, STREAMINFO_BYTES];
const MINI_HEADER_BYTES = FLAC_MARKER.length + LAST_STREAMINFO_BLOCK_HEADER.length + STREAMINFO_BYTES;
const TWO_POW_32 = 4294967296;
const FIXED_SAMPLE_RATES = [0, 88200, 176400, 192000, 8000, 16000, 22050, 24000, 32000, 44100, 48000, 96000];
const SAMPLE_SIZES = [0, 8, 12, -1, 16, 20, 24, 32];
const STEREO_DECORRELATION_MAX_CODE = 10;

export function parseStreamInfo(si) {
    return {
        sampleRate: (si[10] << 12) | (si[11] << 4) | (si[12] >> 4),
        channels: ((si[12] >> 1) & 7) + 1,
        bitsPerSample: (((si[12] & 1) << 4) | (si[13] >> 4)) + 1,
        totalSamples: (si[13] & 0x0f) * TWO_POW_32 + (((si[14] << 24) | (si[15] << 16) | (si[16] << 8) | si[17]) >>> 0),
        minBlockSize: (si[0] << 8) | si[1],
        maxBlockSize: (si[2] << 8) | si[3]
    };
}

export function crc8(bytes, start, end) {
    let crc = 0;
    for (let i = start; i < end; i++) {
        crc ^= bytes[i];
        for (let bit = 0; bit < 8; bit++) crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
    return crc;
}

function codedNumberExtraBytes(first) {
    if (first < 0x80) return 0;
    if (first >= 0xc0 && first < 0xe0) return 1;
    if (first >= 0xe0 && first < 0xf0) return 2;
    if (first >= 0xf0 && first < 0xf8) return 3;
    if (first >= 0xf8 && first < 0xfc) return 4;
    if (first >= 0xfc && first < 0xfe) return 5;
    if (first === 0xfe) return 6;
    return -1;
}

function blockSizeFor(code, bytes, at) {
    if (code === 1) return 192;
    if (code <= 5) return 576 << (code - 2);
    if (code === 6) return bytes[at] + 1;
    if (code === 7) return ((bytes[at] << 8) | bytes[at + 1]) + 1;
    return 256 << (code - 8);
}

function sampleRateFor(code, bytes, at) {
    if (code < FIXED_SAMPLE_RATES.length) return FIXED_SAMPLE_RATES[code];
    if (code === 12) return bytes[at] * 1000;
    if (code === 13) return (bytes[at] << 8) | bytes[at + 1];
    return ((bytes[at] << 8) | bytes[at + 1]) * 10;
}

function channelsFor(code) {
    return code < 8 ? code + 1 : 2;
}

function matchesStream(info, { channelCode, sizeCode, rate, blockSize }) {
    if (channelsFor(channelCode) !== info.channels) return false;
    if (sizeCode !== 0 && SAMPLE_SIZES[sizeCode] !== info.bitsPerSample) return false;
    if (rate !== 0 && rate !== info.sampleRate) return false;
    return !(info.maxBlockSize > 0 && blockSize > info.maxBlockSize);
}

export function parseFrameHeader(bytes, offset, streamInfo) {
    if (offset + 5 > bytes.length) return null;
    if (bytes[offset] !== 0xff || (bytes[offset + 1] & 0xfe) !== 0xf8) return null;
    const variableBlockSize = (bytes[offset + 1] & 1) === 1;
    const blockCode = bytes[offset + 2] >> 4;
    const rateCode = bytes[offset + 2] & 0x0f;
    const channelCode = bytes[offset + 3] >> 4;
    const sizeCode = (bytes[offset + 3] >> 1) & 7;
    const reservedInvalid =
        (bytes[offset + 3] & 1) === 1 || blockCode === 0 || rateCode === 15 || SAMPLE_SIZES[sizeCode] < 0;
    if (reservedInvalid || channelCode > STEREO_DECORRELATION_MAX_CODE) return null;

    let at = offset + 4;
    const first = bytes[at];
    const extra = codedNumberExtraBytes(first);
    if (extra < 0 || at + 1 + extra > bytes.length) return null;
    let number = extra === 0 ? first : first & ((1 << (6 - extra)) - 1);
    for (let k = 1; k <= extra; k++) {
        if ((bytes[at + k] & 0xc0) !== 0x80) return null;
        number = number * 64 + (bytes[at + k] & 0x3f);
    }
    at += 1 + extra;

    const blockExtra = blockCode === 6 ? 1 : blockCode === 7 ? 2 : 0;
    const rateExtra = rateCode === 12 ? 1 : rateCode >= 13 ? 2 : 0;
    const crcAt = at + blockExtra + rateExtra;
    if (crcAt >= bytes.length) return null;
    const blockSize = blockSizeFor(blockCode, bytes, at);
    const rate = sampleRateFor(rateCode, bytes, at + blockExtra);
    if (!matchesStream(streamInfo, { channelCode, sizeCode, rate, blockSize })) return null;
    if (crc8(bytes, offset, crcAt) !== bytes[crcAt]) return null;
    return { blockSize, frameOrSampleNumber: number, headerLength: crcAt + 1 - offset, variableBlockSize };
}

export function nextFrameNumber(header) {
    return header.variableBlockSize ? header.frameOrSampleNumber + header.blockSize : header.frameOrSampleNumber + 1;
}

export function findFrameStart(bytes, from, streamInfo, expectedNumber, final = false) {
    const last = final ? bytes.length - 2 : bytes.length - MAX_FRAME_HEADER_BYTES;
    for (let i = from; i <= last; i++) {
        if (bytes[i] !== 0xff || (bytes[i + 1] & 0xfe) !== 0xf8) continue;
        const header = parseFrameHeader(bytes, i, streamInfo);
        if (header && (expectedNumber === undefined || header.frameOrSampleNumber === expectedNumber)) return i;
    }
    return -1;
}

export function buildMiniFlac(streamInfoBlock, frames, totalSamples = 0) {
    const si = streamInfoBlock.slice(0, STREAMINFO_BYTES);
    si.fill(0, 4, 10);
    si.fill(0, 18, STREAMINFO_BYTES);
    si[13] = (si[13] & 0xf0) | (Math.floor(totalSamples / TWO_POW_32) & 0x0f);
    si[14] = (totalSamples >>> 24) & 0xff;
    si[15] = (totalSamples >>> 16) & 0xff;
    si[16] = (totalSamples >>> 8) & 0xff;
    si[17] = totalSamples & 0xff;
    const framesBytes = frames.reduce((n, f) => n + f.byteLength, 0);
    const out = new Uint8Array(MINI_HEADER_BYTES + framesBytes);
    out.set(FLAC_MARKER, 0);
    out.set(LAST_STREAMINFO_BLOCK_HEADER, FLAC_MARKER.length);
    out.set(si, FLAC_MARKER.length + LAST_STREAMINFO_BLOCK_HEADER.length);
    let at = MINI_HEADER_BYTES;
    for (const f of frames) {
        out.set(f, at);
        at += f.byteLength;
    }
    return out;
}
