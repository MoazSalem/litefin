import { logger } from '../utils/Logger.js';
import FlacChunker from './flac/FlacChunker.js';
import { chunkTrimSeconds, hasLookaheadRoom, positionFromContext, resolveChunkStart } from './gaplessSchedule.js';

const log = logger.create('GaplessAudioEngine');

const TICK_MS = 100;
const LOOKAHEAD_POLL_MS = 250;
const KIND = { LOAD: 'load', SEEK: 'seek', NEXT: 'next' };

const noop = () => {};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function decode(ctx, bytes) {
    return new Promise((resolve, reject) => {
        const promise = ctx.decodeAudioData(bytes.buffer, resolve, reject);
        if (promise && typeof promise.catch === 'function') promise.catch(reject);
    });
}

function createAudioContext(sampleRate) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) throw new Error('Web Audio is not available');
    try {
        return new AudioCtx({ sampleRate });
    } catch (err) {
        log.warn(`AudioContext at ${sampleRate} Hz failed, using default rate`, err);
        return new AudioCtx();
    }
}

function createPipeline(track, kind, startMs) {
    const pipeline = {
        track,
        kind,
        seekMs: Math.max(0, startMs),
        abort: new AbortController(),
        reader: null,
        info: null,
        startSample: 0,
        nodes: new Set(),
        cancelled: false,
        started: false,
        fullyScheduled: false,
        failed: false,
        startWhen: null,
        offsetSec: Math.max(0, startMs) / 1000,
        clockEnd: null,
        resolveReady: noop,
        rejectReady: noop
    };
    pipeline.ready = new Promise((resolve, reject) => {
        pipeline.resolveReady = resolve;
        pipeline.rejectReady = reject;
    });
    return pipeline;
}

export default class GaplessAudioEngine {
    constructor({ onTrackStart = noop, onEnded = noop, onError = noop, onTime = noop } = {}) {
        this._callbacks = { onTrackStart, onEnded, onError, onTime };
        this._ctx = null;
        this._current = null;
        this._next = null;
        this._nextTrack = null;
        this._playing = false;
        this._endedFired = false;
        this._timer = null;
        this._ctxState = Promise.resolve();
    }

    get positionMs() {
        const p = this._current;
        if (!p) return 0;
        const position =
            p.started && this._ctx
                ? positionFromContext(this._ctx.currentTime, p.startWhen, p.offsetSec)
                : p.offsetSec * 1000;
        const duration = this.durationMs;
        return duration > 0 ? Math.min(position, duration) : position;
    }

    get durationMs() {
        const p = this._current;
        if (!p) return 0;
        if (p.track.durationMs > 0) return p.track.durationMs;
        return p.info ? (p.info.totalSamples / p.info.sampleRate) * 1000 : 0;
    }

    get isPlaying() {
        return this._playing;
    }

    get currentTrackId() {
        return this._current ? this._current.track.id : null;
    }

    async load(track, startMs = 0) {
        this._cancelAll();
        this._nextTrack = null;
        const p = createPipeline(track, KIND.LOAD, startMs);
        this._current = p;
        this._endedFired = false;
        this._startTimer();
        this._run(p);
        try {
            await p.ready;
        } catch (err) {
            if (this._current === p) {
                this._current = null;
                this._stopTimer();
            }
            throw err;
        }
    }

    async preloadNext(track) {
        this._promoteIfAudible();
        this._cancel(this._next);
        this._next = null;
        this._nextTrack = track || null;
        this._startNextIfReady();
    }

    play() {
        this._playing = true;
        if (this._current) this._startTimer();
        this._applyPlayState();
    }

    pause() {
        this._playing = false;
        this._applyPlayState();
    }

    async seek(ms) {
        this._promoteIfAudible();
        const current = this._current;
        if (!current) return;
        this._cancel(current);
        this._cancel(this._next);
        this._next = null;
        const p = createPipeline(current.track, KIND.SEEK, ms);
        this._current = p;
        this._endedFired = false;
        this._startTimer();
        this._run(p);
        await p.ready;
    }

    stop() {
        this._cancelAll();
        this._current = null;
        this._nextTrack = null;
        this._playing = false;
        this._stopTimer();
    }

    destroy() {
        this.stop();
        if (this._ctx) {
            this._ctx.close().catch((err) => log.warn('AudioContext close failed', err));
            this._ctx = null;
        }
    }

    _applyPlayState() {
        this._ctxState = this._ctxState
            .then(() => {
                const ctx = this._ctx;
                if (!ctx) return undefined;
                return this._playing ? ctx.resume() : ctx.suspend();
            })
            .catch((err) => log.warn('AudioContext play state change failed', err));
    }

    _run(p) {
        this._pump(p).catch((err) => this._fail(p, err));
    }

    async _pump(p) {
        await this._waitForRoom(p);
        if (p.cancelled) return;
        const response = await fetch(p.track.url, { signal: p.abort.signal });
        if (p.cancelled) return;
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        if (!response.body || typeof response.body.getReader !== 'function') {
            throw new Error('Streaming fetch is not supported');
        }
        p.reader = response.body.getReader();
        const chunker = new FlacChunker({ startMs: p.seekMs });
        for (;;) {
            const chunk = await this._readChunk(p, chunker);
            if (p.cancelled) return;
            if (!chunk) break;
            p.info = chunker.streamInfo;
            p.startSample = chunker.startSample;
            this._ensureContext(chunker.streamInfo);
            const buffer = await decode(this._ctx, chunk.bytes);
            if (p.cancelled) return;
            this._schedule(p, buffer, chunk);
            await this._waitForRoom(p);
            if (p.cancelled) return;
        }
        this._finish(p);
    }

    async _readChunk(p, chunker) {
        for (;;) {
            const chunk = chunker.take();
            if (chunk) return chunk;
            if (chunker.done) return null;
            const { done, value } = await p.reader.read();
            if (p.cancelled) return null;
            if (done) chunker.end();
            else chunker.push(value);
        }
    }

    _ensureContext(info) {
        if (!this._ctx) {
            this._ctx = createAudioContext(info.sampleRate);
            log.info(`AudioContext ${this._ctx.sampleRate} Hz for FLAC ${info.sampleRate} Hz ${info.channels}ch`);
            if (!this._playing) this._applyPlayState();
            return;
        }
        if (info.sampleRate !== this._ctx.sampleRate) {
            log.info(`Resampling FLAC ${info.sampleRate} Hz to ${this._ctx.sampleRate} Hz`);
        }
    }

    _clockBefore(p) {
        if (p.clockEnd !== null) return p.clockEnd;
        return p === this._next && this._current ? this._current.clockEnd : null;
    }

    async _waitForRoom(p) {
        while (!p.cancelled && this._ctx && !hasLookaheadRoom(this._clockBefore(p), this._ctx.currentTime)) {
            await sleep(LOOKAHEAD_POLL_MS);
        }
    }

    _schedule(p, buffer, chunk) {
        const ctx = this._ctx;
        const trim = p.started ? 0 : chunkTrimSeconds(p.startSample, chunk.firstSample, p.info.sampleRate);
        const { when, shift, starved } = resolveChunkStart(this._clockBefore(p), ctx.currentTime);
        if (starved) {
            log.warn(`Starved on ${p.track.id}: chunk at sample ${chunk.firstSample} late by ${shift.toFixed(3)} s`);
            if (p.started) p.startWhen += shift;
        }
        const node = ctx.createBufferSource();
        node.buffer = buffer;
        node.connect(ctx.destination);
        node.onended = () => {
            node.disconnect();
            node.buffer = null;
            p.nodes.delete(node);
        };
        node.start(when, trim);
        p.nodes.add(node);
        p.clockEnd = when + buffer.duration - trim;
        if (!p.started) {
            p.started = true;
            p.startWhen = when;
            p.offsetSec = p.startSample / p.info.sampleRate;
            p.resolveReady();
        }
    }

    _finish(p) {
        p.fullyScheduled = true;
        p.resolveReady();
        if (p === this._current) this._startNextIfReady();
    }

    _fail(p, err) {
        if (p.cancelled) return;
        p.failed = true;
        p.fullyScheduled = true;
        log.warn(`Track ${p.track.id} failed`, err);
        if (p.kind === KIND.LOAD && !p.started) {
            p.rejectReady(err);
            return;
        }
        p.resolveReady();
        if (p === this._next && this._current && p.track.id === this._current.track.id) {
            log.warn(`Preload of repeated track ${p.track.id} failed; dropping it so the current track ends normally`);
            this._next = null;
            this._nextTrack = null;
            return;
        }
        if (p === this._current || p === this._next) this._emit('onError', p.track.id, err);
    }

    _startNextIfReady() {
        const current = this._current;
        if (!this._nextTrack || this._next || !current || !current.fullyScheduled || current.failed) return;
        this._next = createPipeline(this._nextTrack, KIND.NEXT, 0);
        this._run(this._next);
    }

    _cancel(p) {
        if (!p) return;
        p.cancelled = true;
        p.abort.abort();
        if (p.reader) p.reader.cancel().catch((err) => log.debug('Reader cancel ignored', err));
        p.nodes.forEach((node) => {
            node.onended = null;
            try {
                node.stop();
            } catch (err) {
                log.debug('Node stop ignored', err);
            }
            node.disconnect();
            node.buffer = null;
        });
        p.nodes.clear();
        p.resolveReady();
    }

    _cancelAll() {
        this._cancel(this._current);
        this._cancel(this._next);
        this._next = null;
    }

    _startTimer() {
        if (this._timer !== null) return;
        this._timer = setInterval(() => this._tick(), TICK_MS);
    }

    _stopTimer() {
        if (this._timer === null) return;
        clearInterval(this._timer);
        this._timer = null;
    }

    _promoteIfAudible() {
        const next = this._next;
        if (!this._ctx || !next || !next.started || this._ctx.currentTime < next.startWhen) return false;
        this._current = next;
        this._next = null;
        this._nextTrack = null;
        this._endedFired = false;
        this._emit('onTrackStart', next.track.id);
        return true;
    }

    _tick() {
        const current = this._current;
        if (!this._ctx || !current) return;
        if (!this._promoteIfAudible() && this._hasEnded(current)) {
            this._endedFired = true;
            this._stopTimer();
            this._emit('onEnded');
            return;
        }
        if (this._playing && this._current) this._emit('onTime', this.positionMs, this.durationMs);
    }

    _hasEnded(current) {
        if (this._endedFired || this._nextTrack || !current.fullyScheduled || current.failed) return false;
        return current.clockEnd === null || this._ctx.currentTime >= current.clockEnd;
    }

    _emit(name, ...args) {
        try {
            this._callbacks[name](...args);
        } catch (err) {
            log.error(`${name} callback failed`, err);
        }
    }
}
