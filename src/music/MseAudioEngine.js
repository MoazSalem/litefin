import { logger } from '../utils/Logger.js';
import { parseHlsPlaylist, segmentIndexAt } from './hlsPlaylist.js';
import { addTrack, closeTrack, emptyTimeline, entryAt, evictionEnd, positionMs } from './mseTimeline.js';

export const AHEAD_SECONDS = 20;
export const BEHIND_SECONDS = 4;
export const TICK_MS = 250;
const QUOTA_KEEP_BEHIND = 1;

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
        log = logger.create('MseAudioEngine')
    } = {}) {
        this._callbacks = { onTrackStart, onEnded, onError, onTime };
        this._media = { createAudio, createMediaSource, createObjectUrl, revokeObjectUrl };
        this._fetchText = fetchText;
        this._fetchBytes = fetchBytes;
        this._setInterval = setIntervalFn;
        this._clearInterval = clearIntervalFn;
        this._log = log;
        this._audio = null;
        this._mediaSource = null;
        this._sourceBuffer = null;
        this._objectUrl = null;
        this._audioListeners = [];
        this._generation = 0;
        this._appendSeq = 0;
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
        const fresh = () => gen === this._generation;
        this._ensureMedia();
        await this._whenOpen();
        if (!fresh()) return;
        const sourceBuffer = this._ensureSourceBuffer(track.mime);
        await this._clearBuffer();
        if (!fresh()) return;
        const text = await this._fetchText(track.url);
        if (!fresh()) return;
        const playlist = parseHlsPlaylist(text, track.url);
        if (playlist.segments.length === 0) throw new Error(`HLS playlist for ${track.id} has no segments`);
        const item = this._enqueue(track, playlist, segmentIndexAt(playlist.segments, startMs / 1000), 0);
        const init = await this._fetchBytes(playlist.initUrl);
        if (!fresh()) return;
        await this._update((sb) => sb.appendBuffer(init));
        if (!fresh()) return;
        sourceBuffer.timestampOffset = playlist.segments[item.index].start;
        await this._appendSegment(gen, item);
        if (!fresh()) return;
        this._audio.currentTime = startMs / 1000;
        this._startTimer();
        this._pump(gen);
    }

    async preloadNext(track) {
        this._nextTrack = track || null;
    }

    play() {
        this._playing = true;
        if (!this._audio) return;
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
        if (this._sourceBuffer) {
            this._clearBuffer().catch((err) => this._log.warn('Clearing the SourceBuffer failed', err));
        }
    }

    destroy() {
        this.stop();
        if (!this._audio) return;
        this._audioListeners.forEach(([event, handler]) => this._audio.removeEventListener(event, handler));
        this._audioListeners = [];
        try {
            this._media.revokeObjectUrl(this._objectUrl);
            this._audio.removeAttribute('src');
            this._audio.load();
        } catch (err) {
            this._log.warn('Audio element cleanup failed', err);
        }
        this._audio = null;
        this._mediaSource = null;
        this._sourceBuffer = null;
        this._objectUrl = null;
    }

    // ========================================================================
    // Media element & SourceBuffer
    // ========================================================================

    _ensureMedia() {
        if (this._audio) return;
        this._audio = this._media.createAudio();
        this._mediaSource = this._media.createMediaSource();
        this._objectUrl = this._media.createObjectUrl(this._mediaSource);
        this._audio.src = this._objectUrl;
        this._listen('ended', () => this._handleEnded());
        this._listen('error', () => this._handleAudioError());
    }

    _listen(event, handler) {
        this._audio.addEventListener(event, handler);
        this._audioListeners.push([event, handler]);
    }

    _whenOpen() {
        const mediaSource = this._mediaSource;
        if (mediaSource.readyState !== 'closed') return Promise.resolve();
        return new Promise((resolve) => {
            const onOpen = () => {
                mediaSource.removeEventListener('sourceopen', onOpen);
                resolve();
            };
            mediaSource.addEventListener('sourceopen', onOpen);
        });
    }

    _ensureSourceBuffer(mime) {
        if (!this._sourceBuffer) {
            this._sourceBuffer = this._mediaSource.addSourceBuffer(mime);
            this._sourceBuffer.mode = 'sequence';
        }
        return this._sourceBuffer;
    }

    _update(run) {
        const sourceBuffer = this._sourceBuffer;
        return new Promise((resolve, reject) => {
            const cleanup = () => {
                sourceBuffer.removeEventListener('updateend', onEnd);
                sourceBuffer.removeEventListener('error', onError);
            };
            const onEnd = () => {
                cleanup();
                resolve();
            };
            const onError = () => {
                cleanup();
                reject(new Error('SourceBuffer update failed'));
            };
            sourceBuffer.addEventListener('updateend', onEnd);
            sourceBuffer.addEventListener('error', onError);
            try {
                run(sourceBuffer);
            } catch (err) {
                cleanup();
                reject(err);
            }
        });
    }

    /* abort() throws while a remove() is running; either way the pending update ends with updateend */
    async _clearBuffer() {
        if (this._sourceBuffer.updating) {
            await this._update((sb) => {
                try {
                    sb.abort();
                } catch (err) {
                    this._log.debug('SourceBuffer abort() refused, waiting for the update', err);
                }
            });
        }
        if (this._sourceBuffer.buffered.length > 0) await this._update((sb) => sb.remove(0, Infinity));
    }

    _bufferedEdges() {
        const ranges = this._sourceBuffer.buffered;
        if (ranges.length === 0) return null;
        return { start: ranges.start(0), end: ranges.end(ranges.length - 1) };
    }

    async _evict(keepBehind) {
        const edges = this._bufferedEdges();
        const end = evictionEnd(this._audio.currentTime, keepBehind);
        if (!edges || edges.start >= end) return;
        await this._update((sb) => sb.remove(0, end));
    }

    // ========================================================================
    // Feeder
    // ========================================================================

    _begin() {
        this._generation++;
        this._stopTimer();
        this._reset();
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
        const item = { key, track, playlist, index };
        this._tracksByKey.set(key, track);
        this._timeline = addTrack(this._timeline, key, origin);
        this._feedQueue = [...this._feedQueue, item];
        return item;
    }

    async _appendSegment(gen, item) {
        const bytes = await this._fetchBytes(item.playlist.segments[item.index].url);
        if (gen !== this._generation) return false;
        await this._update((sb) => sb.appendBuffer(bytes));
        if (gen !== this._generation) return false;
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
        if (gen === this._generation && !this._streamEnded) await this._evict(BEHIND_SECONDS);
    }

    async _appendOrEvict(gen, item) {
        try {
            return await this._appendSegment(gen, item);
        } catch (err) {
            if (!isQuotaError(err)) throw err;
            this._log.debug('SourceBuffer full, evicting and retrying on the next tick');
            await this._evict(QUOTA_KEEP_BEHIND);
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
        this._callbacks.onError(this.currentTrackId, err);
    }

    // ========================================================================
    // Playback state
    // ========================================================================

    _currentTrack() {
        const entry = this._audio ? entryAt(this._timeline, this._audio.currentTime) : null;
        return entry ? this._tracksByKey.get(entry.trackId) : this._loadedTrack;
    }

    _handleEnded() {
        if (this._endedFired || !this._loadedTrack) return;
        this._endedFired = true;
        this._playing = false;
        this._stopTimer();
        this._callbacks.onEnded();
    }

    _handleAudioError() {
        if (!this._loadedTrack) return;
        const code = this._audio.error ? this._audio.error.code : 'unknown';
        this._callbacks.onError(this.currentTrackId, new Error(`Audio element error (code ${code})`));
    }

    _startTimer() {
        if (this._timer !== null) return;
        this._timer = this._setInterval(() => this._tick(), TICK_MS);
    }

    _stopTimer() {
        if (this._timer === null) return;
        this._clearInterval(this._timer);
        this._timer = null;
    }

    _tick() {
        this._pump(this._generation);
        if (this._playing) this._callbacks.onTime(this.positionMs, this.durationMs);
    }
}
