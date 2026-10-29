import { logger } from '../utils/Logger.js';
import { segmentIndexAt } from './hlsPlaylist.js';
import { addTrack, closeTrack, dropFrom, emptyTimeline, entryAt, evictionEnd } from './mseTimeline.js';
import MseMediaPipeline from './MseMediaPipeline.js';
import { FEED_STEP, nextFeedStep, nextState } from './mseFeedPlan.js';
import { defaultFetchBytes, defaultFetchText, fetchSegment, fetchTrackStart } from './mseSegmentSource.js';

export const AHEAD_SECONDS = 20;
export const BEHIND_SECONDS = 4;
export const TICK_MS = 250;
const QUOTA_KEEP_BEHIND = 1;

const noop = () => {};
const isQuotaError = (err) => Boolean(err) && err.name === 'QuotaExceededError';
const sameTrack = (a, b) => a === b || (Boolean(a) && Boolean(b) && a.id === b.id && a.url === b.url);

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
        this._fetchText = fetchText;
        this._fetchBytes = fetchBytes;
        this._requests = new AbortController();
        this._timers = { setIntervalFn, clearIntervalFn };
        this._log = log;
        this._pipe = new MseMediaPipeline({
            media: { createAudio, createMediaSource, createObjectUrl, revokeObjectUrl },
            timers: { setTimeoutFn, clearTimeoutFn },
            log,
            onEnded: () => this._handleEnded(),
            onError: () => this._handleAudioError()
        });
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
        const entry = this._currentEntry();
        if (!this._audio || !entry) return 0;
        const position = Math.max(0, (this._audio.currentTime - entry.origin) * 1000);
        return this.durationMs > 0 ? Math.min(position, this.durationMs) : position;
    }

    get durationMs() {
        const track = this._loadedTrack;
        return track && track.durationMs > 0 ? track.durationMs : 0;
    }

    get isPlaying() {
        return this._playing;
    }

    get currentTrackId() {
        return this._loadedTrack ? this._loadedTrack.id : null;
    }

    get _audio() {
        return this._pipe.audio;
    }

    get _queue() {
        return this._pipe.queue;
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
        this._advanceTrack();
        const next = track || null;
        if (sameTrack(next, this._nextTrack)) return;
        this._dropNext();
        this._nextTrack = next;
        this._pump(this._generation);
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

    /* relative to the current track: the buffered next track is never a seek target */
    async seek(ms) {
        const track = this._loadedTrack;
        if (!this._audio || !track) return;
        const targetMs = Math.max(0, this.durationMs > 0 ? Math.min(ms, this.durationMs) : ms);
        const entry = this._currentEntry();
        const target = (entry ? entry.origin : 0) + targetMs / 1000;
        if (entry && (entry.end === null || target < entry.end) && this._pipe.isBuffered(target)) {
            this._audio.currentTime = target;
            return;
        }
        const { error } = await this._reload(track, targetMs, this._nextTrack);
        if (error) this._reportError(track.id, error);
    }

    stop() {
        this._begin();
        this._playing = false;
        this._loadedTrack = null;
        this._nextTrack = null;
        if (this._audio) this._audio.pause();
        if (this._queue) this._pipe.clear().catch((err) => this._log.debug('Clearing the SourceBuffer failed', err));
    }

    destroy() {
        this.stop();
        this._pipe.destroy();
    }

    async _loadInto(gen, track, startMs) {
        const fresh = () => gen === this._generation;
        this._pipe.ensure(track.mime);
        await this._pipe.whenOpen();
        if (!fresh()) return;
        this._pipe.ensureSourceBuffer(track.mime);
        await this._pipe.clear();
        if (!fresh()) return;
        const { playlist, init } = await fetchTrackStart(
            this._fetchText,
            this._fetchBytes,
            track,
            this._requests.signal
        );
        if (!fresh()) return;
        const item = this._enqueue(track, playlist, segmentIndexAt(playlist.segments, startMs / 1000), 0);
        this._currentKey = item.key;
        await this._queue.run((sb) => {
            this._pipe.switchType(sb, track.mime);
            sb.appendBuffer(init);
        });
        if (!fresh()) return;
        const offset = playlist.segments[item.index].start;
        await this._queue.run((sb) => {
            sb.timestampOffset = offset;
        });
        if (!fresh() || !(await this._appendSegment(gen, item.key))) return;
        this._audio.currentTime = startMs / 1000;
        this._ready = true;
        this._startTimer();
        this._pump(gen);
    }

    _evict(gen, keepBehind) {
        return this._pipe.removeBefore(
            evictionEnd(this._audio.currentTime, keepBehind),
            () => gen === this._generation
        );
    }

    // ========================================================================
    // Feeder
    // ========================================================================

    _begin() {
        this._generation++;
        this._requests.abort();
        this._requests = new AbortController();
        this._stopTimer();
        this._reset();
        this._pipe.cancelOpenWait();
        return this._generation;
    }

    _reset() {
        this._timeline = emptyTimeline();
        this._tracksByKey = new Map();
        this._feedQueue = [];
        this._currentKey = null;
        this._nextKey = null;
        this._nextBlocked = false;
        this._ready = false;
        this._repump = false;
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

    _queued(key) {
        return this._feedQueue.find((item) => item.key === key) || null;
    }

    _isLive(gen, key) {
        return gen === this._generation && this._queued(key) !== null;
    }

    _replaceItem(item) {
        this._feedQueue = this._feedQueue.map((queued) => (queued.key === item.key ? item : queued));
    }

    /* bytes stay on the item until appended, so a quota retry never downloads the segment again */
    async _appendSegment(gen, key) {
        let item = this._queued(key);
        if (!item.bytes) {
            const fetched = await fetchSegment({
                fetchText: this._fetchText,
                fetchBytes: this._fetchBytes,
                item,
                isLive: () => this._isLive(gen, key),
                log: this._log,
                signal: this._requests.signal
            });
            if (!this._isLive(gen, key)) return false;
            item = { ...item, ...fetched };
            this._replaceItem(item);
        }
        const { bytes } = item;
        await this._queue.run((sb) => sb.appendBuffer(bytes));
        if (!this._isLive(gen, key)) return false;
        this._replaceItem({ ...item, index: item.index + 1, bytes: null });
        return true;
    }

    async _pump(gen) {
        if (!this._ready || this._feedHalted || this._endedFired) return;
        if (this._feeding === gen) {
            this._repump = true;
            return;
        }
        this._feeding = gen;
        this._repump = false;
        try {
            await this._feed(gen);
        } catch (err) {
            if (gen === this._generation) this._failFeed(this.currentTrackId, err);
        } finally {
            if (this._feeding === gen) this._feeding = null;
        }
        if (this._repump && gen === this._generation) this._pump(gen);
    }

    async _feed(gen) {
        while (gen === this._generation) {
            const head = this._feedQueue[0];
            const step = nextFeedStep({
                head,
                bufferFull: this._bufferedAhead() >= AHEAD_SECONDS,
                next: nextState({ track: this._nextTrack, key: this._nextKey, blocked: this._nextBlocked })
            });
            if (step === FEED_STEP.CLOSE) this._closeItem(head);
            else if (step === FEED_STEP.START_NEXT) await this._startNext(gen);
            else if (step === FEED_STEP.APPEND) {
                if (!(await this._appendOrEvict(gen, head.key))) return;
            } else {
                if (step === FEED_STEP.END) this._endStream(gen);
                break;
            }
        }
        /* remove() on an ended MediaSource reopens it and the element would never fire `ended` */
        if (gen === this._generation && !this._streamEnded) await this._evict(gen, BEHIND_SECONDS);
    }

    async _appendOrEvict(gen, key) {
        try {
            return await this._appendSegment(gen, key);
        } catch (err) {
            if (!this._isLive(gen, key)) return false;
            if (!isQuotaError(err)) {
                const { track } = this._queued(key);
                if (key === this._nextKey) this._failNext(track, err);
                else this._failFeed(track.id, err);
                return false;
            }
            this._log.debug('SourceBuffer full, evicting and retrying on the next tick');
            await this._evict(gen, QUOTA_KEEP_BEHIND);
            return false;
        }
    }

    /* appended right after the current track with no timestampOffset change, so the junction is gapless */
    async _startNext(gen) {
        const next = this._nextTrack;
        const wanted = () => gen === this._generation && this._nextTrack === next;
        if (!this._pipe.canAppend(next.mime)) {
            this._nextBlocked = true;
            return;
        }
        let start;
        try {
            start = await fetchTrackStart(this._fetchText, this._fetchBytes, next, this._requests.signal);
        } catch (err) {
            if (!wanted()) return;
            this._log.warn(`Preparing ${next.id} failed, it starts after the current track ends`, err);
            this._nextBlocked = true;
            return;
        }
        if (!wanted()) return;
        const last = this._timeline.entries[this._timeline.entries.length - 1];
        const { key } = this._enqueue(next, start.playlist, 0, last.end);
        this._nextKey = key;
        this._streamEnded = false;
        try {
            await this._queue.run((sb) => {
                if (!this._isLive(gen, key)) return;
                this._pipe.switchType(sb, next.mime);
                sb.appendBuffer(start.init);
            });
        } catch (err) {
            if (this._isLive(gen, key)) this._failNext(next, err);
        }
    }

    /* the current track must still reach endOfStream, and the session may preload a replacement */
    _failNext(track, err) {
        this._log.warn(`Next track ${track.id} failed`, err);
        this._dropNext();
        this._nextTrack = null;
        this._repump = true;
        /* a repeat-one preload shares the playing track's id; reporting it would skip the healthy track */
        if (track.id !== this.currentTrackId) this._reportError(track.id, err);
    }

    _dropNext() {
        const key = this._nextKey;
        this._nextKey = null;
        this._nextBlocked = false;
        if (key === null) return;
        const { origin } = this._timeline.entries.find((entry) => entry.trackId === key);
        const gen = this._generation;
        this._timeline = dropFrom(this._timeline, key);
        this._feedQueue = this._feedQueue.filter((item) => item.key !== key);
        this._streamEnded = false;
        this._pipe
            .truncateFrom(origin, () => gen === this._generation)
            .catch((err) => this._log.warn('Dropping the next track failed', err));
    }

    _bufferedAhead() {
        const edges = this._pipe.bufferedEdges();
        return edges ? edges.end - this._audio.currentTime : 0;
    }

    _closeItem(item) {
        const edges = this._pipe.bufferedEdges();
        this._timeline = closeTrack(this._timeline, item.key, edges ? edges.end : 0);
        this._feedQueue = this._feedQueue.slice(1);
    }

    /* skipped when an append reopened the stream before the queued endOfStream() ran */
    _endStream(gen) {
        if (this._streamEnded) return;
        this._streamEnded = true;
        this._pipe
            .endOfStream(() => gen === this._generation && this._streamEnded)
            .catch((err) => this._log.warn('MediaSource endOfStream() failed', err));
    }

    _failFeed(trackId, err) {
        this._feedHalted = true;
        this._log.error('MSE feeding failed', err);
        this._reportError(trackId, err);
    }

    /* a failed append also errors the element; report each failure once per track and load */
    _reportError(trackId, err) {
        const key = `${this._generation}:${trackId}`;
        if (this._errorReported === key) return;
        this._errorReported = key;
        this._callbacks.onError(trackId, err);
    }

    // ========================================================================
    // Playback state
    // ========================================================================

    _currentEntry() {
        return this._timeline.entries.find((entry) => entry.trackId === this._currentKey) || null;
    }

    _advanceTrack() {
        if (this._nextKey === null || !this._audio) return;
        const entry = entryAt(this._timeline, this._audio.currentTime);
        if (!entry || entry.trackId !== this._nextKey) return;
        const track = this._tracksByKey.get(entry.trackId);
        this._currentKey = entry.trackId;
        this._loadedTrack = track;
        this._nextTrack = null;
        this._nextKey = null;
        this._callbacks.onTrackStart(track.id);
    }

    /* an `ended` queued before a new load arrives while that load's stream is still open */
    _handleEnded() {
        if (this._endedFired || !this._loadedTrack || !this._streamEnded) return;
        this._endedFired = true;
        this._stopTimer();
        this._advanceTrack();
        if (this._nextBlocked) {
            this._continueWith(this._nextTrack);
            return;
        }
        this._playing = false;
        this._callbacks.onEnded();
    }

    /* a next track the SourceBuffer could not take plays through a reload instead of a gapless append */
    /* announced even when the reload fails, so the session reads the error as the current track's */
    async _continueWith(track) {
        const { superseded, error } = await this._reload(track, 0, null);
        if (superseded) return;
        if (!error && this._playing) this.play();
        this._callbacks.onTrackStart(track.id);
        if (error) this._reportError(track.id, error);
    }

    async _reload(track, startMs, next) {
        const loading = this.load(track, startMs);
        const gen = this._generation;
        this._nextTrack = next;
        let error = null;
        try {
            await loading;
        } catch (err) {
            error = err;
        }
        if (gen !== this._generation) return { superseded: true, error: null };
        if (error) this._playing = false;
        return { superseded: false, error };
    }

    _handleAudioError() {
        if (!this._loadedTrack) return;
        this._pipe.markBroken();
        this._feedHalted = true;
        const code = this._audio.error ? this._audio.error.code : 'unknown';
        this._reportError(this.currentTrackId, new Error(`Audio element error (code ${code})`));
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
        this._advanceTrack();
        this._pump(this._generation);
        if (this._playing) this._callbacks.onTime(this.positionMs, this.durationMs);
    }
}
