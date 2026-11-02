const CONTAINERS = ['moov', 'trak', 'mdia', 'minf', 'stbl'];

function readUint32(bytes, at) {
    return ((bytes[at] << 24) >>> 0) + (bytes[at + 1] << 16) + (bytes[at + 2] << 8) + bytes[at + 3];
}

function typeAt(bytes, at) {
    return String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
}

function findStsd(bytes, start, end) {
    let at = start;
    while (at + 8 <= end) {
        const size = readUint32(bytes, at);
        if (size < 8 || at + size > end) return null;
        const type = typeAt(bytes, at);
        if (type === 'stsd') return bytes.subarray(at, at + size);
        if (CONTAINERS.includes(type)) {
            const found = findStsd(bytes, at + 8, at + size);
            if (found) return found;
        }
        at += size;
    }
    return null;
}

function withoutBitrate(stsd) {
    for (let at = 0; at + 8 <= stsd.length; at++) {
        const size = readUint32(stsd, at);
        if (typeAt(stsd, at) === 'btrt' && size >= 8 && at + size <= stsd.length) {
            return [...stsd.subarray(0, at), ...stsd.subarray(at + size)];
        }
    }
    return [...stsd];
}

/* the sample description is what the decoder is configured from; the bitrate box varies per file and is ignored */
export function initFormat(init) {
    const stsd = findStsd(init, 0, init.length);
    if (!stsd) return null;
    return withoutBitrate(stsd)
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
}
