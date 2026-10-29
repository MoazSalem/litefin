import { logger } from '../utils/Logger.js';
import { parseHlsPlaylist, segmentIndexAt } from './hlsPlaylist.js';
import { addTrack, closeTrack, emptyTimeline, entryAt, evictionEnd, positionMs } from './mseTimeline.js';
import SourceBufferQueue from './sourceBufferQueue.js';

export const AHEAD_SECONDS = 20;
export const BEHIND_SECONDS = 4;
export const TICK_MS = 250;
const QUOTA_KEEP_BEHIND = 1;
const OPEN_TIMEOUT_MS = 10000;

const noop = () => {};

async function fetchOk(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response;
}

const defaultFetchText = async (url) => (await fetchOk(url)).text();
const defaultFetchBytes = async (url) => new Uint8Array(await (await fetchOk(url)).arrayBuffer());
const isQuotaError = (err) => Boolean(err) && err.name === 'QuotaExceededError';

export default class MseAudioEngine {
    constructor({
        onTrackStart = noop,
        onEnded = noop,
        onError = noop,
        onTime = noop,
        createAudio = () => document.createElement('audio'),
        createMediaSource = () => new globalThis.MediaSource(),
        createObjectUrl = (mediaSource) => URL.createObjectURL(mediaSource),
        revokeObjectUrl = (url) => URL.revokeObjectURL(url),
        fetchText = defaultFetchText,
        fetchBytes = defaultFetchBytes,
        setInterval: setIntervalFn = (fn, ms) => globalThis.setInterval(fn, ms),
        clearInterval: clearIntervalFn = (handle) => globalThis.clearInterval(handle),
        setTimeout: setTimeoutFn = (fn, ms) => globalThis.setTimeout(fn, ms),
        clearTimeout: clearTimeoutFn = (handle) => globalThis.clearTimeout(handle),
        log = logger.create('MseAudioEngine')
    } = {}) {
        this._callbacks = { onTrackStart, onEnded, onError, onTime };
        this._media = { createAudio, createMediaSource, createObjectUrl, revokeObjectUrl };
        this._fetchText = fetchText;
        this._fetchBytes = fetchBytes;
        this._timers = { setIntervalFn, clearIntervalFn, setTimeoutFn, clearTimeoutFn };
        this._log = log;
        this._audio = null;
        this._audioListeners = [];
        this._mediaSource = null;
        this._sourceBuffer = null;
        this._queue = null;
        this._objectUrl = null;
        this._sourceOpened = false;
        this._mediaBroken = false;
        this._cancelOpenWait = null;
        this._generation = 0;
        this._appendSeq = 0;
        this._errorReported = null;
        this._playing = false;
        this._timer = null;
        this._feeding = null;
        this._loadedTrack = null;
        this._nextTrack = null;
        this._reset();
    }

    get positionMs() {
        return this._audio ? positionMs(this._timeline, this._audio.currentTime) : 0;
    }

    get durationMs() {
        const track = this._currentTrack();
        return track && track.durationMs > 0 ? track.durationMs : 0;
    }

    get isPlaying() {
        return this._playing;
    }

    get currentTrackId() {
        const track = this._currentTrack();
        return track ? track.id : null;
    }

    async load(track, startMs = 0) {
        const gen = this._begin();
        this._loadedTrack = track;
        this._nextTrack = null;
        try {
            await this._loadInto(gen, track, startMs);
        } catch (err) {
            if (gen === this._generation) throw err;
        }
    }

    async preloadNext(track) {
        this._nextTrack = track || null;
    }

    play() {
        this._playing = true;
        if (!this._audio) return;
        if (this._loadedTrack) this._startTimer();
        const result = this._audio.play();
        if (result && typeof result.catch === 'function') {
            result.catch((err) => this._log.warn('Audio play() rejected', err));
        }
    }

    pause() {
        this._playing = false;
        if (this._audio) this._audio.pause();
    }

    async seek(ms) {
        if (!this._audio || !this._loadedTrack) return;
        const entry = entryAt(this._timeline, this._audio.currentTime);
        this._audio.currentTime = (entry ? entry.origin : 0) + Math.max(0, ms) / 1000;
    }

    stop() {
        this._begin();
        this._playing = false;
        this._loadedTrack = null;
        this._nextTrack = null;
        if (this._audio) this._audio.pause();
        if (this._queue) this._clearBuffer().catch((err) => this._log.debug('Clearing the SourceBuffer failed', err));
    }

    destroy() {
        this.stop();
        if (!this._audio) return;
        this._audioListeners.forEach(([event, handler]) => this._audio.removeEventListener(event, handler));
        this._audioListeners = [];
        this._detachMediaSource();
        try {
            this._audio.removeAttribute('src');
            this._audio.load();
        } catch (err) {
            this._log.warn('Audio element cleanup failed', err);
        }
        this._audio = null;
    }

    async _loadInto(gen, track, startMs) {
        const fresh = () => gen === this._generation;
        this._ensureMedia();
        await this._whenOpen();
        if (!fresh()) return;
        this._ensureSourceBuffer(track.mime);
        await this._clearBuffer();
        if (!fresh()) return;
        const text = await this._fetchText(track.url);
        if (!fresh()) return;
        const playlist = parseHlsPlaylist(text, track.url);
        if (playlist.segments.length === 0) throw new Error(`HLS playlist for ${track.id} has no segments`);
        const item = this._enqueue(track, playlist, segmentIndexAt(playlist.segments, startMs / 1000), 0);
        const init = await this._fetchBytes(playlist.initUrl);
        if (!fresh()) return;
        await this._queue.run((sb) => sb.appendBuffer(init));
        if (!fresh()) return;
        const offset = playlist.segments[item.index].start;
        await this._queue.run((sb) => {
            sb.timestampOffset = offset;
        });
        if (!fresh() || !(await this._appendSegment(gen, item))) return;
        this._audio.currentTime = startMs / 1000;
        this._startTimer();
        this._pump(gen);
    }

    // ========================================================================
    // Media element & SourceBuffer
    // ========================================================================

    _ensureMedia() {
        if (!this._audio) {
            this._audio = this._media.createAudio();
            this._listen('ended', () => this._handleEnded());
            this._listen('error', () => this._handleAudioError());
        }
        const closedAfterOpen = this._sourceOpened && this._mediaSource.readyState === 'closed';
        if (this._mediaSource && !this._mediaBroken && !closedAfterOpen) return;
        this._detachMediaSource();
        this._mediaBroken = false;
        this._mediaSource = this._media.createMediaSource();
        this._objectUrl = this._media.createObjectUrl(this._mediaSource);
        this._audio.src = this._objectUrl;
    }

    _detachMediaSource() {
        if (this._queue) this._queue.dispose();
        if (this._objectUrl) {
            try {
                this._media.revokeObjectUrl(this._objectUrl);
            } catch (err) {
                this._log.warn('Revoking the MediaSource URL failed', err);
            }
        }
        this._queue = null;
        this._sourceBuffer = null;
        this._mediaSource = null;
        this._objectUrl = null;
        this._sourceOpened = false;
    }

    _listen(event, handler) {
        this._audio.addEventListener(event, handler);
        this._audioListeners.push([event, handler]);
    }

    _whenOpen() {
        const mediaSource = this._mediaSource;
        if (mediaSource.readyState !== 'closed') {
            this._sourceOpened = true;
            return Promise.resolve();
        }
        const { setTimeoutFn, clearTimeoutFn } = this._timers;
        return new Promise((resolve, reject) => {
            const finish = (opened, err) => {
                mediaSource.removeEventListener('sourceopen', onOpen);
                clearTimeoutFn(timer);
                this._cancelOpenWait = null;
                if (opened) this._sourceOpened = true;
                if (err) reject(err);
                else resolve();
            };
            const onOpen = () => finish(true);
            const timer = setTimeoutFn(() => {
                this._mediaBroken = true;
                finish(false, new Error('MediaSource did not open'));
            }, OPEN_TIMEOUT_MS);
            mediaSource.addEventListener('sourceopen', onOpen);
            this._cancelOpenWait = () => finish(false);
        });
    }

    _ensureSourceBuffer(mime) {
        if (this._sourceBuffer) return;
        this._sourceBuffer = this._mediaSource.addSourceBuffer(mime);
        this._sourceBuffer.mode = 'sequence';
        this._queue = new SourceBufferQueue(this._sourceBuffer);
    }

    _clearBuffer() {
        return this._queue.run((sb) => {
            if (sb.buffered.length > 0) sb.remove(0, Infinity);
        });
    }

    _bufferedEdges() {
        const ranges = this._sourceBuffer.buffered;
        if (ranges.length === 0) return null;
        return { start: ranges.start(0), end: ranges.end(ranges.length - 1) };
    }

    _evict(gen, keepBehind) {
        const end = evictionEnd(this._audio.currentTime, keepBehind);
        return this._queue.run((sb) => {
            if (gen !== this._generation) return;
            if (sb.buffered.length > 0 && sb.buffered.start(0) < end) sb.remove(0, end);
        });
    }

    // ========================================================================
    // Feeder
    // ========================================================================

    _begin() {
        this._generation++;
        this._stopTimer();
        this._reset();
        if (this._cancelOpenWait) this._cancelOpenWait();
        return this._generation;
    }

    _reset() {
        this._timeline = emptyTimeline();
        this._tracksByKey = new Map();
        this._feedQueue = [];
        this._streamEnded = false;
        this._endedFired = false;
        this._feedHalted = false;
    }

    _enqueue(track, playlist, index, origin) {
        const key = `${track.id}#${++this._appendSeq}`;
        const item = { key, track, playlist, index, bytes: null };
        this._tracksByKey.set(key, track);
        this._timeline = addTrack(this._timeline, key, origin);
        this._feedQueue = [...this._feedQueue, item];
        return item;
    }

    /* bytes stay on the item until appended, so a quota retry never downloads the segment again */
    async _appendSegment(gen, item) {
        if (!item.bytes) {
            const bytes = await this._fetchBytes(item.playlist.segments[item.index].url);
            if (gen !== this._generation) return false;
            item.bytes = bytes;
        }
        await this._queue.run((sb) => sb.appendBuffer(item.bytes));
        if (gen !== this._generation) return false;
        item.bytes = null;
        item.index++;
        return true;
    }

    async _pump(gen) {
        if (this._feeding === gen || this._feedHalted) return;
        this._feeding = gen;
        try {
            await this._feed(gen);
        } catch (err) {
            if (gen === this._generation) this._failFeed(err);
        } finally {
            if (this._feeding === gen) this._feeding = null;
        }
    }

    async _feed(gen) {
        while (gen === this._generation) {
            const item = this._feedQueue[0];
            if (!item) {
                if (!this._nextTrack) this._endStream();
                break;
            }
            if (item.index >= item.playlist.segments.length) {
                this._closeItem(item);
                continue;
            }
            if (this._bufferedAhead() >= AHEAD_SECONDS) break;
            if (!(await this._appendOrEvict(gen, item))) return;
        }
        /* remove() on an ended MediaSource reopens it and the element would never fire `ended` */
        if (gen === this._generation && !this._streamEnded) await this._evict(gen, BEHIND_SECONDS);
    }

    async _appendOrEvict(gen, item) {
        try {
            return await this._appendSegment(gen, item);
        } catch (err) {
            if (!isQuotaError(err)) throw err;
            this._log.debug('SourceBuffer full, evicting and retrying on the next tick');
            await this._evict(gen, QUOTA_KEEP_BEHIND);
            return false;
        }
    }

    _bufferedAhead() {
        const edges = this._bufferedEdges();
        return edges ? edges.end - this._audio.currentTime : 0;
    }

    _closeItem(item) {
        const edges = this._bufferedEdges();
        this._timeline = closeTrack(this._timeline, item.key, edges ? edges.end : 0);
        this._feedQueue = this._feedQueue.slice(1);
    }

    _endStream() {
        if (this._streamEnded || this._mediaSource.readyState !== 'open') return;
        this._streamEnded = true;
        try {
            this._mediaSource.endOfStream();
        } catch (err) {
            this._log.warn('MediaSource endOfStream() failed', err);
        }
    }

    _failFeed(err) {
        this._feedHalted = true;
        this._log.error('MSE feeding failed', err);
        this._reportError(err);
    }

    /* a failed append also errors the element; report each failure once per track and load */
    _reportError(err) {
        const trackId = this.currentTrackId;
        const key = `${this._generation}:${trackId}`;
        if (this._errorReported === key) return;
        this._errorReported = key;
        this._callbacks.onError(trackId, err);
    }

    // ========================================================================
    // Playback state
    // ========================================================================

    _currentTrack() {
        const entry = this._audio ? entryAt(this._timeline, this._audio.currentTime) : null;
        return entry ? this._tracksByKey.get(entry.trackId) : this._loadedTrack;
    }

    /* an `ended` queued before a new load arrives while that load's stream is still open */
    _handleEnded() {
        if (this._endedFired || !this._loadedTrack || !this._streamEnded) return;
        this._endedFired = true;
        this._playing = false;
        this._stopTimer();
        this._callbacks.onEnded();
    }

    _handleAudioError() {
        if (!this._loadedTrack) return;
        this._mediaBroken = true;
        this._feedHalted = true;
        const code = this._audio.error ? this._audio.error.code : 'unknown';
        this._reportError(new Error(`Audio element error (code ${code})`));
    }

    _startTimer() {
        if (this._timer !== null) return;
        this._timer = this._timers.setIntervalFn(() => this._tick(), TICK_MS);
    }

    _stopTimer() {
        if (this._timer === null) return;
        this._timers.clearIntervalFn(this._timer);
        this._timer = null;
    }

    _tick() {
        this._pump(this._generation);
        if (this._playing) this._callbacks.onTime(this.positionMs, this.durationMs);
    }
}
