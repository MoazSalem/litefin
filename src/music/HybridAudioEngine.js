const noop = () => {};

const kindOf = (track) => (track && track.kind === 'flac' ? 'flac' : 'native');

export default class HybridAudioEngine {
    constructor({ createGapless, createNative, onTrackStart = noop, onEnded = noop, onError = noop, onTime = noop }) {
        this._factories = { flac: createGapless, native: createNative };
        this._callbacks = { onTrackStart, onEnded, onError, onTime };
        this._engines = { flac: null, native: null };
        this._activeKind = null;
        this._pendingNext = null;
        this._wantsPlay = false;
        this._generation = 0;
    }

    get positionMs() {
        return this._active ? this._active.positionMs : 0;
    }

    get durationMs() {
        return this._active ? this._active.durationMs : 0;
    }

    get isPlaying() {
        return this._active ? Boolean(this._active.isPlaying) : false;
    }

    get currentTrackId() {
        return this._active ? this._active.currentTrackId : null;
    }

    get _active() {
        return this._activeKind ? this._engines[this._activeKind] : null;
    }

    async load(track, startMs = 0) {
        this._generation++;
        this._pendingNext = null;
        await this._activate(kindOf(track)).load(track, startMs);
    }

    async preloadNext(track) {
        const active = this._active;
        if (!active) return;
        if (track && kindOf(track) !== this._activeKind) {
            this._pendingNext = track;
            await active.preloadNext(null);
            return;
        }
        this._pendingNext = null;
        await active.preloadNext(track || null);
    }

    play() {
        this._wantsPlay = true;
        if (this._active) this._active.play();
    }

    pause() {
        this._wantsPlay = false;
        if (this._active) this._active.pause();
    }

    async seek(ms) {
        if (this._active) await this._active.seek(ms);
    }

    stop() {
        this._generation++;
        this._pendingNext = null;
        this._wantsPlay = false;
        this._activeKind = null;
        if (this._engines.native) this._engines.native.stop();
        if (this._engines.flac) this._release('flac');
    }

    destroy() {
        this.stop();
        this._eachEngine((engine) => engine.destroy());
        this._engines = { flac: null, native: null };
    }

    _activate(kind) {
        if (this._activeKind && this._activeKind !== kind) this._release(this._activeKind);
        this._activeKind = kind;
        if (!this._engines[kind]) this._engines[kind] = this._create(kind);
        return this._engines[kind];
    }

    /* A live AudioContext can hold webOS audio output in PCM mode and block Atmos passthrough on native tracks. */
    _release(kind) {
        const engine = this._engines[kind];
        if (kind === 'flac') {
            this._engines.flac = null;
            engine.destroy();
        } else {
            engine.stop();
        }
    }

    _create(kind) {
        const holder = { engine: null };
        holder.engine = this._factories[kind](this._routedCallbacks(holder));
        return holder.engine;
    }

    _routedCallbacks(holder) {
        const whenActive =
            (fn) =>
            (...args) => {
                if (holder.engine && this._active === holder.engine) fn(...args);
            };
        return {
            onTrackStart: whenActive((id) => this._callbacks.onTrackStart(id)),
            onEnded: whenActive(() => this._handleEnded()),
            onError: whenActive((id, err) => this._callbacks.onError(id, err)),
            onTime: whenActive((positionMs, durationMs) => this._callbacks.onTime(positionMs, durationMs))
        };
    }

    _handleEnded() {
        const next = this._pendingNext;
        if (!next) {
            this._callbacks.onEnded();
            return;
        }
        this._pendingNext = null;
        this._handOver(next, ++this._generation);
    }

    async _handOver(track, generation) {
        const engine = this._activate(kindOf(track));
        try {
            await engine.load(track, 0);
        } catch (err) {
            if (generation !== this._generation) return;
            this._callbacks.onTrackStart(track.id);
            this._callbacks.onError(track.id, err);
            return;
        }
        if (generation !== this._generation) return;
        if (this._wantsPlay) engine.play();
        this._callbacks.onTrackStart(track.id);
    }

    _eachEngine(fn) {
        Object.values(this._engines).forEach((engine) => {
            if (engine) fn(engine);
        });
    }
}
