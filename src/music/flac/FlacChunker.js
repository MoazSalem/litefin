import {
    MAX_FRAME_HEADER_BYTES,
    STREAMINFO_BYTES,
    buildMiniFlac,
    findFrameStart,
    nextFrameNumber,
    parseFrameHeader,
    parseStreamInfo
} from './flacFrames.js';

const MB = 1024 * 1024;
export const MAX_SCAN_BYTES = 4 * MB;
export const MAX_CHUNK_BYTES = 8 * MB;
const INITIAL_STORE_BYTES = 256 * 1024;
const ID3_HEADER_BYTES = 10;
const METADATA_HEADER_BYTES = 4;
const STREAMINFO_TYPE = 0;

const PHASE = { ID3: 'id3', MARKER: 'marker', METADATA: 'metadata', FRAMES: 'frames', DONE: 'done' };

function id3Size(b) {
    return ID3_HEADER_BYTES + (((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f));
}

export default class FlacChunker {
    constructor({ targetSeconds = 5 } = {}) {
        this._targetSeconds = targetSeconds;
        this._store = new Uint8Array(INITIAL_STORE_BYTES);
        this._start = 0;
        this._end = 0;
        this._ended = false;
        this._phase = PHASE.ID3;
        this._pendingSkip = 0;
        this._streamInfoBlock = null;
        this._info = null;
        this._targetSamples = 0;
        this._frame = null;
        this._frameAt = 0;
        this._scanFrom = 0;
        this._chunkSamples = 0;
        this._nextFirstSample = 0;
    }

    get streamInfo() {
        return this._info;
    }

    get done() {
        return this._phase === PHASE.DONE;
    }

    push(bytes) {
        if (this._ended) throw new Error('FlacChunker: push after end');
        this._append(bytes);
    }

    end() {
        this._ended = true;
    }

    take() {
        const inPreamble = this._phase !== PHASE.FRAMES || this._pendingSkip > 0;
        if (inPreamble && !this._readPreamble()) return null;
        if (this._phase === PHASE.DONE) return null;
        return this._takeChunk();
    }

    get _available() {
        return this._end - this._start;
    }

    get _buf() {
        return this._store.subarray(this._start, this._end);
    }

    _append(bytes) {
        const live = this._available;
        if (this._end + bytes.byteLength > this._store.byteLength) {
            const needed = live + bytes.byteLength;
            if (needed <= this._store.byteLength) {
                this._store.copyWithin(0, this._start, this._end);
            } else {
                const grown = new Uint8Array(Math.max(this._store.byteLength * 2, needed));
                grown.set(this._buf, 0);
                this._store = grown;
            }
            this._start = 0;
            this._end = live;
        }
        this._store.set(bytes, this._end);
        this._end += bytes.byteLength;
    }

    _discard(n) {
        const take = Math.min(n, this._available);
        this._start += take;
        this._pendingSkip = n - take;
        if (this._start === this._end) {
            this._start = 0;
            this._end = 0;
        }
    }

    _has(n) {
        if (this._available >= n) return true;
        if (this._ended) throw new Error('FlacChunker: unexpected end of FLAC stream');
        return false;
    }

    _readPreamble() {
        for (;;) {
            if (this._pendingSkip > 0) {
                this._discard(this._pendingSkip);
                if (this._pendingSkip > 0 && !this._has(this._pendingSkip)) return false;
            }
            if (this._phase === PHASE.FRAMES || this._phase === PHASE.DONE) return true;
            if (!this._readPreambleStep()) return false;
        }
    }

    _readPreambleStep() {
        const b = this._buf;
        if (this._phase === PHASE.ID3) {
            if (!this._has(ID3_HEADER_BYTES)) return false;
            this._phase = PHASE.MARKER;
            if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) this._discard(id3Size(b));
            return true;
        }
        if (this._phase === PHASE.MARKER) {
            if (!this._has(4)) return false;
            if (b[0] !== 0x66 || b[1] !== 0x4c || b[2] !== 0x61 || b[3] !== 0x43) {
                throw new Error('FlacChunker: missing fLaC marker');
            }
            this._discard(4);
            this._phase = PHASE.METADATA;
            return true;
        }
        return this._readMetadataBlock();
    }

    _readMetadataBlock() {
        if (!this._has(METADATA_HEADER_BYTES)) return false;
        const b = this._buf;
        const last = (b[0] & 0x80) !== 0;
        const type = b[0] & 0x7f;
        const length = (b[1] << 16) | (b[2] << 8) | b[3];
        if (type === STREAMINFO_TYPE) {
            if (!this._has(METADATA_HEADER_BYTES + STREAMINFO_BYTES)) return false;
            this._streamInfoBlock = b.slice(METADATA_HEADER_BYTES, METADATA_HEADER_BYTES + STREAMINFO_BYTES);
            this._info = parseStreamInfo(this._streamInfoBlock);
            this._targetSamples = Math.max(1, Math.round(this._targetSeconds * this._info.sampleRate));
        }
        this._discard(METADATA_HEADER_BYTES + length);
        if (last) {
            if (!this._info) throw new Error('FlacChunker: no STREAMINFO block');
            this._phase = PHASE.FRAMES;
        }
        return true;
    }

    _readFirstFrame() {
        if (this._available === 0 && this._ended) {
            this._phase = PHASE.DONE;
            return false;
        }
        if (this._available < MAX_FRAME_HEADER_BYTES && !this._ended) return false;
        const header = parseFrameHeader(this._buf, 0, this._info);
        if (!header) throw new Error('FlacChunker: first FLAC frame header invalid');
        this._frame = header;
        this._frameAt = 0;
        this._scanFrom = header.headerLength;
        return true;
    }

    _takeChunk() {
        if (this._frame === null && !this._readFirstFrame()) return null;
        for (;;) {
            const buf = this._buf;
            const at = findFrameStart(buf, this._scanFrom, this._info, nextFrameNumber(this._frame), this._ended);
            if (at < 0) return this._ended ? this._finish(buf.byteLength) : this._waitForMore(buf.byteLength);
            if (at > MAX_CHUNK_BYTES) throw new Error('FlacChunker: chunk larger than 8 MB');
            this._chunkSamples += this._frame.blockSize;
            this._frame = parseFrameHeader(buf, at, this._info);
            this._frameAt = at;
            this._scanFrom = at + this._frame.headerLength;
            if (this._chunkSamples >= this._targetSamples) return this._emit(at);
        }
    }

    _waitForMore(available) {
        if (available - this._frameAt > MAX_SCAN_BYTES) throw new Error('FlacChunker: no frame boundary within 4 MB');
        this._scanFrom = Math.max(this._scanFrom, available - MAX_FRAME_HEADER_BYTES + 1);
        return null;
    }

    _finish(available) {
        if (available > MAX_CHUNK_BYTES) throw new Error('FlacChunker: chunk larger than 8 MB');
        this._chunkSamples += this._frame.blockSize;
        this._phase = PHASE.DONE;
        return this._emit(available);
    }

    _emit(length) {
        const samples = this._chunkSamples;
        const chunk = {
            bytes: buildMiniFlac(this._streamInfoBlock, [this._buf.subarray(0, length)], samples),
            samples,
            firstSample: this._nextFirstSample
        };
        this._nextFirstSample += samples;
        this._chunkSamples = 0;
        this._discard(length);
        this._frameAt = 0;
        this._scanFrom = Math.max(0, this._scanFrom - length);
        return chunk;
    }
}
