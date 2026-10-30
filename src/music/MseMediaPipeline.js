import SourceBufferQueue from './sourceBufferQueue.js';

const OPEN_TIMEOUT_MS = 10000;

export default class MseMediaPipeline {
    constructor({ media, timers, log, onEnded, onError, allowChangeType = true }) {
        this._allowChangeType = allowChangeType;
        this._media = media;
        this._timers = timers;
        this._log = log;
        this._listeners = [
            ['ended', onEnded],
            ['error', onError]
        ];
        this._audio = null;
        this._mediaSource = null;
        this._sourceBuffer = null;
        this._queue = null;
        this._mime = null;
        this._objectUrl = null;
        this._opened = false;
        this._broken = false;
        this._cancelOpenWait = null;
    }

    get audio() {
        return this._audio;
    }

    get mediaSource() {
        return this._mediaSource;
    }

    get sourceBuffer() {
        return this._sourceBuffer;
    }

    get queue() {
        return this._queue;
    }

    /* webOS accepts changeType() but its audio pipeline stays locked to the first codec */
    canAppend(mime) {
        if (!this._sourceBuffer || mime === this._mime) return true;
        return this._allowChangeType && typeof this._sourceBuffer.changeType === 'function';
    }

    ensure(mime) {
        if (!this._audio) {
            this._audio = this._media.createAudio();
            this._listeners.forEach(([event, handler]) => this._audio.addEventListener(event, handler));
        }
        if (!this._needsRebuild(mime)) return;
        this._detach();
        this._broken = false;
        this._mediaSource = this._media.createMediaSource();
        this._objectUrl = this._media.createObjectUrl(this._mediaSource);
        this._audio.src = this._objectUrl;
    }

    whenOpen() {
        const mediaSource = this._mediaSource;
        if (mediaSource.readyState !== 'closed') {
            this._opened = true;
            return Promise.resolve();
        }
        const { setTimeoutFn, clearTimeoutFn } = this._timers;
        return new Promise((resolve, reject) => {
            const finish = (opened, err) => {
                mediaSource.removeEventListener('sourceopen', onOpen);
                clearTimeoutFn(timer);
                this._cancelOpenWait = null;
                if (opened) this._opened = true;
                if (err) reject(err);
                else resolve();
            };
            const onOpen = () => finish(true);
            const timer = setTimeoutFn(() => {
                this._broken = true;
                finish(false, new Error('MediaSource did not open'));
            }, OPEN_TIMEOUT_MS);
            mediaSource.addEventListener('sourceopen', onOpen);
            this._cancelOpenWait = () => finish(false);
        });
    }

    cancelOpenWait() {
        if (this._cancelOpenWait) this._cancelOpenWait();
    }

    ensureSourceBuffer(mime) {
        if (this._sourceBuffer) return;
        this._sourceBuffer = this._mediaSource.addSourceBuffer(mime);
        this._sourceBuffer.mode = 'sequence';
        this._mime = mime;
        this._queue = new SourceBufferQueue(this._sourceBuffer);
    }

    /* only inside a queued operation, before the init segment of `mime` */
    switchType(sourceBuffer, mime) {
        if (mime === this._mime) return;
        sourceBuffer.changeType(mime);
        this._mime = mime;
    }

    markBroken() {
        this._broken = true;
    }

    clear() {
        return this._queue.run((sb) => {
            if (sb.buffered.length > 0) sb.remove(0, Infinity);
        });
    }

    removeBefore(end, isCurrent) {
        return this._queue.run((sb) => {
            if (isCurrent() && sb.buffered.length > 0 && sb.buffered.start(0) < end) sb.remove(0, end);
        });
    }

    /* sequence mode continues after the removed media, so timestampOffset is rewound to where removal began */
    truncateFrom(origin, isCurrent) {
        const removing = this._queue.run((sb) => {
            const edges = this.bufferedEdges();
            if (isCurrent() && edges && edges.end > origin) sb.remove(origin, Infinity);
        });
        const rewinding = this._queue.run((sb) => {
            if (isCurrent()) sb.timestampOffset = origin;
        });
        return Promise.all([removing, rewinding]);
    }

    /* queued so it never runs while an append is updating, which would make endOfStream() throw */
    endOfStream(shouldEnd) {
        const mediaSource = this._mediaSource;
        return this._queue.run(() => {
            if (shouldEnd() && mediaSource.readyState === 'open') mediaSource.endOfStream();
        });
    }

    bufferedEdges() {
        const ranges = this._sourceBuffer ? this._sourceBuffer.buffered : null;
        if (!ranges || ranges.length === 0) return null;
        return { start: ranges.start(0), end: ranges.end(ranges.length - 1) };
    }

    isBuffered(time) {
        const ranges = this._sourceBuffer ? this._sourceBuffer.buffered : null;
        if (!ranges) return false;
        for (let i = 0; i < ranges.length; i++) {
            if (ranges.start(i) <= time && time < ranges.end(i)) return true;
        }
        return false;
    }

    destroy() {
        if (!this._audio) return;
        this._listeners.forEach(([event, handler]) => this._audio.removeEventListener(event, handler));
        this._detach();
        try {
            this._audio.removeAttribute('src');
            this._audio.load();
        } catch (err) {
            this._log.warn('Audio element cleanup failed', err);
        }
        this._audio = null;
    }

    /* an element error survives stop(), and a MediaSource closed after opening never reopens */
    _needsRebuild(mime) {
        if (!this._mediaSource || this._broken || this._audio.error) return true;
        if (this._opened && this._mediaSource.readyState === 'closed') return true;
        return !this.canAppend(mime);
    }

    _detach() {
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
        this._mime = null;
        this._mediaSource = null;
        this._objectUrl = null;
        this._opened = false;
    }
}
