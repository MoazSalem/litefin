const TIME_INTERVAL_MS = 250;

const noop = () => {};

function mediaError(el) {
    const code = el.error ? el.error.code : 'unknown';
    return new Error(`Audio element error (code ${code})`);
}

export default class NativeAudioBackend {
    constructor({
        onTrackStart = noop,
        onEnded = noop,
        onError = noop,
        onTime = noop,
        createAudio = () => document.createElement('audio'),
        log = { warn: noop },
        setInterval: setIntervalFn = (fn, ms) => globalThis.setInterval(fn, ms),
        clearInterval: clearIntervalFn = (handle) => globalThis.clearInterval(handle)
    } = {}) {
        this._callbacks = { onTrackStart, onEnded, onError, onTime };
        this._createAudio = createAudio;
        this._log = log;
        this._setInterval = setIntervalFn;
        this._clearInterval = clearIntervalFn;
        this._current = null;
        this._next = null;
        this._playing = false;
        this._timer = null;
    }

    get positionMs() {
        return this._current ? this._current.el.currentTime * 1000 : 0;
    }

    get durationMs() {
        const slot = this._current;
        if (!slot) return 0;
        if (slot.track.durationMs > 0) return slot.track.durationMs;
        const seconds = slot.el.duration;
        return Number.isFinite(seconds) ? seconds * 1000 : 0;
    }

    get isPlaying() {
        return this._playing;
    }

    get currentTrackId() {
        return this._current ? this._current.track.id : null;
    }

    load(track, startMs = 0) {
        this._release(this._next);
        this._next = null;
        this._release(this._current);
        const slot = this._createSlot(track);
        this._current = slot;
        return new Promise((resolve, reject) => {
            const settle = (fn, value) => {
                slot.settle = null;
                fn(value);
            };
            slot.settle = { resolve: () => settle(resolve), reject: (err) => settle(reject, err) };
            slot.supersede = () => settle(resolve);
            this._listen(slot, 'loadedmetadata', () => {
                if (startMs > 0) slot.el.currentTime = startMs / 1000;
            });
            this._listen(slot, 'canplay', () => {
                if (slot.settle) slot.settle.resolve();
            });
            slot.el.src = track.url;
            slot.el.load();
        });
    }

    async preloadNext(track) {
        this._release(this._next);
        this._next = null;
        if (!track) return;
        const slot = this._createSlot(track);
        this._next = slot;
        slot.el.src = track.url;
        slot.el.load();
    }

    play() {
        this._playing = true;
        if (this._current) this._startElement(this._current);
        this._startTimer();
    }

    pause() {
        this._playing = false;
        this._stopTimer();
        if (this._current) this._current.el.pause();
    }

    async seek(ms) {
        if (this._current) this._current.el.currentTime = Math.max(0, ms) / 1000;
    }

    stop() {
        this._playing = false;
        this._stopTimer();
        this._release(this._next);
        this._release(this._current);
        this._next = null;
        this._current = null;
    }

    destroy() {
        this.stop();
    }

    _createSlot(track) {
        const el = this._createAudio();
        el.preload = 'auto';
        const slot = { el, track, listeners: [], settle: null, supersede: null };
        this._listen(slot, 'ended', () => this._handleEnded(slot));
        this._listen(slot, 'error', () => this._handleError(slot));
        return slot;
    }

    _listen(slot, event, handler) {
        slot.el.addEventListener(event, handler);
        slot.listeners.push([event, handler]);
    }

    _release(slot) {
        if (!slot) return;
        if (slot.supersede && slot.settle) slot.supersede();
        slot.listeners.forEach(([event, handler]) => slot.el.removeEventListener(event, handler));
        slot.listeners = [];
        try {
            slot.el.pause();
            slot.el.removeAttribute('src');
            slot.el.load();
        } catch (err) {
            this._log.warn('Audio element cleanup failed', err);
        }
    }

    _startElement(slot) {
        const result = slot.el.play();
        if (result && typeof result.catch === 'function') {
            result.catch((err) => this._log.warn(`Audio play() rejected for ${slot.track.id}`, err));
        }
    }

    _handleEnded(slot) {
        if (slot !== this._current) return;
        const next = this._next;
        if (!next) {
            this._stopTimer();
            this._playing = false;
            this._callbacks.onEnded();
            return;
        }
        this._next = null;
        this._release(slot);
        this._current = next;
        this._listenOnce(next, 'playing', () => this._callbacks.onTrackStart(next.track.id));
        if (this._playing) this._startElement(next);
    }

    _listenOnce(slot, event, handler) {
        const once = () => {
            slot.el.removeEventListener(event, once);
            slot.listeners = slot.listeners.filter(([, h]) => h !== once);
            handler();
        };
        this._listen(slot, event, once);
    }

    _handleError(slot) {
        const err = mediaError(slot.el);
        if (slot.settle) {
            slot.settle.reject(err);
            return;
        }
        if (slot === this._next) {
            this._release(slot);
            this._next = null;
        } else if (slot !== this._current) {
            return;
        }
        this._callbacks.onError(slot.track.id, err);
    }

    _startTimer() {
        if (this._timer !== null) return;
        this._timer = this._setInterval(() => {
            if (this._current) this._callbacks.onTime(this.positionMs, this.durationMs);
        }, TIME_INTERVAL_MS);
    }

    _stopTimer() {
        if (this._timer === null) return;
        this._clearInterval(this._timer);
        this._timer = null;
    }
}
