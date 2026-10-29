const TICKS_PER_MS = 10000;
const PROGRESS_INTERVAL_MS = 10000;
const TIME_EVENT_INTERVAL_MS = 250;
const RESTART_THRESHOLD_MS = 3000;
const MAX_PREPARE_SKIPS = 5;

const noop = () => {};

export default class MusicSession {
    constructor({
        engineFactory,
        api,
        queue,
        bus,
        describeTrack,
        notify,
        now = Date.now,
        getDeviceProfile = () => undefined,
        log = { warn: noop },
        setInterval: setIntervalFn = (fn, ms) => globalThis.setInterval(fn, ms),
        clearInterval: clearIntervalFn = (handle) => globalThis.clearInterval(handle)
    }) {
        this._engineFactory = engineFactory;
        this._api = api;
        this._queue = queue;
        this._bus = bus;
        this._describeTrack = describeTrack;
        this._notify = notify;
        this._now = now;
        this._getDeviceProfile = getDeviceProfile;
        this._log = log;
        this._setInterval = setIntervalFn;
        this._clearInterval = clearIntervalFn;

        this._engine = null;
        this._active = false;
        this._generation = 0;
        this._prefetchToken = 0;
        this._open = false;
        this._current = null;
        this._preloaded = null;
        this._skippedAhead = 0;
        this._progressTimer = null;
        this._lastTimeEmit = -Infinity;
    }

    get isActive() {
        return this._active;
    }

    get isPlaying() {
        return this._active && Boolean(this._engine?.isPlaying);
    }

    get currentItem() {
        return this._current ? this._current.item : null;
    }

    get positionMs() {
        return this._engine ? this._engine.positionMs : 0;
    }

    get durationMs() {
        return this._engine ? this._engine.durationMs : 0;
    }

    async playItems(items, startIndex = 0) {
        const generation = this._beginTransition();
        this._reportStopped();
        this._ensureEngine();
        this._open = true;
        this._queue.setQueue(items, startIndex);
        this._skippedAhead = 0;

        const item = this._queue.getCurrentItem();
        if (!item) {
            await this.stop('empty');
            return;
        }
        await this._loadFrom(item, generation, 1);
    }

    togglePlayPause() {
        if (!this._active) return;
        if (this._engine.isPlaying) this.pause();
        else this.resume();
    }

    pause() {
        if (!this._active || !this._engine.isPlaying) return;
        this._engine.pause();
        this._afterPlayStateChange();
    }

    resume() {
        if (!this._active || this._engine.isPlaying) return;
        this._engine.play();
        this._afterPlayStateChange();
    }

    async next() {
        if (!this._active) return;
        this._rewindSkipped();
        const target = this._queue.advance();
        if (!target) {
            await this.stop('ended');
            return;
        }
        await this._switchTo(target, 1);
    }

    async previous() {
        if (!this._active) return;
        if (this.positionMs > RESTART_THRESHOLD_MS) {
            await this.seekTo(0);
            return;
        }
        this._rewindSkipped();
        const target = this._queue.goBack();
        if (!target) {
            this._fireAndForget(this._prefetch());
            await this.seekTo(0);
            return;
        }
        await this._switchTo(target, -1);
    }

    async seekTo(ms) {
        if (!this._active) return;
        await this._engine.seek(ms);
    }

    async stop(reason) {
        if (!this._open) return;
        this._beginTransition();
        this._reportStopped();
        this._open = false;
        this._active = false;
        this._engine.stop();
        this._bus.emit('music:stopped', { reason });
    }

    _ensureEngine() {
        if (this._engine) return;
        this._engine = this._engineFactory({
            onTrackStart: (trackId) => this._handleTrackStart(trackId),
            onEnded: () => this._handleEnded(),
            onError: (trackId, err) => this._handleError(trackId, err),
            onTime: (positionMs, durationMs) => this._handleTime(positionMs, durationMs)
        });
    }

    _beginTransition() {
        this._clearProgressTimer();
        this._prefetchToken++;
        this._preloaded = null;
        return ++this._generation;
    }

    _rewindSkipped() {
        while (this._skippedAhead > 0) {
            this._queue.goBack();
            this._skippedAhead--;
        }
    }

    async _switchTo(item, direction) {
        const generation = this._beginTransition();
        this._reportStopped();
        await this._loadFrom(item, generation, direction);
    }

    async _loadFrom(firstItem, generation, direction) {
        let item = firstItem;
        for (let attempt = 0; attempt <= MAX_PREPARE_SKIPS; attempt++) {
            try {
                const prepared = await this._prepare(item);
                if (generation !== this._generation) return;
                await this._engine.load(prepared.track);
                if (generation !== this._generation) return;
                this._engine.play();
                this._active = true;
                this._startTrack(prepared);
                return;
            } catch (err) {
                if (generation !== this._generation) return;
                this._log.warn('Music track failed to load', err);
                this._notify(item.Name);
                const following = direction > 0 ? this._queue.advance() : this._queue.goBack();
                if (!following) break;
                item = following;
            }
        }
        await this.stop('error');
    }

    async _prepare(item) {
        const response = await this._api.getPlaybackInfo(item.Id, this._getDeviceProfile());
        const mediaSource = response?.MediaSources?.[0];
        if (!mediaSource) throw new Error(`No media source for ${item.Id}`);
        const runtimeTicks = mediaSource.RunTimeTicks ?? item.RunTimeTicks ?? 0;
        const descriptor = this._describeTrack(item, mediaSource);
        return {
            item,
            mediaSource,
            playSessionId: response.PlaySessionId,
            track: { id: item.Id, ...descriptor, durationMs: runtimeTicks / TICKS_PER_MS }
        };
    }

    _startTrack(prepared) {
        this._current = prepared;
        this._skippedAhead = 0;
        this._bus.emit('music:track', { item: prepared.item, index: this._queue.getCurrentIndex() });
        this._bus.emit('music:state', { isPlaying: this._engine.isPlaying });
        this._fireAndForget(this._api.reportPlaybackStart(this._payload(prepared, 0, false)));
        this._startProgressTimer();
        this._fireAndForget(this._prefetch());
    }

    _handleTrackStart(trackId) {
        const next = this._preloaded;
        if (!this._active) return;
        if (!next || next.item.Id !== trackId) {
            this._log.warn(`Music engine started unexpected track ${trackId}`);
            return;
        }
        this._reportStopped(this._current.track.durationMs);
        if (this._queue.getRepeatMode() !== 'RepeatOne') {
            this._queue.advance();
        }
        this._clearProgressTimer();
        this._preloaded = null;
        this._startTrack(next);
    }

    _handleEnded() {
        if (!this._active) return;
        if (this._queue.getRepeatMode() === 'RepeatOne') {
            this._fireAndForget(this._switchTo(this._current.item, 1));
        } else if (this._queue.hasNext()) {
            this._fireAndForget(this.next());
        } else {
            this._fireAndForget(this.stop('ended'));
        }
    }

    _handleError(trackId, err) {
        if (!this._active) return;
        this._log.warn('Music engine error', err);
        if (this._current && this._current.item.Id === trackId) {
            this._notify(this._current.item.Name);
            this._fireAndForget(this._queue.hasNext() ? this.next() : this.stop('error'));
            return;
        }
        if (this._preloaded && this._preloaded.item.Id === trackId) {
            const failed = this._preloaded.item;
            this._preloaded = null;
            this._fireAndForget(this._engine.preloadNext(null));
            this._fireAndForget(this._skipFailedNext(failed, this._prefetchToken, 1));
        }
    }

    _handleTime(positionMs, durationMs) {
        const current = this._now();
        if (current - this._lastTimeEmit < TIME_EVENT_INTERVAL_MS) return;
        this._lastTimeEmit = current;
        this._bus.emit('music:time', { positionMs, durationMs });
    }

    _nextCandidate() {
        if (this._queue.getRepeatMode() === 'RepeatOne') return this._current.item;
        return this._queue.peekNext();
    }

    async _prefetch() {
        const token = ++this._prefetchToken;
        const candidate = this._nextCandidate();
        if (!candidate) {
            this._fireAndForget(this._engine.preloadNext(null));
            return;
        }
        await this._preload(candidate, token, 0);
    }

    async _preload(item, token, skips) {
        try {
            const prepared = await this._prepare(item);
            if (token !== this._prefetchToken) return;
            await this._engine.preloadNext(prepared.track);
            if (token !== this._prefetchToken) return;
            this._preloaded = prepared;
        } catch (err) {
            if (token !== this._prefetchToken) return;
            this._log.warn('Music next track failed to prepare', err);
            await this._skipFailedNext(item, token, skips + 1);
        }
    }

    async _skipFailedNext(failed, token, skips) {
        this._notify(failed.Name);
        if (this._queue.getRepeatMode() === 'RepeatOne' || skips > MAX_PREPARE_SKIPS) {
            this._fireAndForget(this._engine.preloadNext(null));
            return;
        }
        this._queue.advance();
        this._skippedAhead++;
        const following = this._queue.peekNext();
        if (!following) {
            this._fireAndForget(this._engine.preloadNext(null));
            return;
        }
        await this._preload(following, token, skips);
    }

    _payload(prepared, positionMs, isPaused) {
        return {
            ItemId: prepared.item.Id,
            MediaSourceId: prepared.mediaSource.Id,
            PlaySessionId: prepared.playSessionId,
            PositionTicks: Math.round(positionMs * TICKS_PER_MS),
            IsPaused: isPaused,
            PlayMethod: 'DirectPlay'
        };
    }

    _reportStopped(positionMs = this.positionMs) {
        const outgoing = this._current;
        if (!outgoing) return;
        this._current = null;
        this._fireAndForget(this._api.reportPlaybackStopped(this._payload(outgoing, positionMs, false)));
    }

    _reportProgress() {
        if (!this._current) return;
        const payload = this._payload(this._current, this.positionMs, !this._engine.isPlaying);
        this._fireAndForget(this._api.reportPlaybackProgress(payload));
    }

    _afterPlayStateChange() {
        this._bus.emit('music:state', { isPlaying: this._engine.isPlaying });
        this._reportProgress();
    }

    _startProgressTimer() {
        this._clearProgressTimer();
        this._progressTimer = this._setInterval(() => this._reportProgress(), PROGRESS_INTERVAL_MS);
    }

    _clearProgressTimer() {
        if (this._progressTimer === null) return;
        this._clearInterval(this._progressTimer);
        this._progressTimer = null;
    }

    _fireAndForget(promise) {
        Promise.resolve(promise).catch((err) => this._log.warn('Music report failed', err));
    }
}
