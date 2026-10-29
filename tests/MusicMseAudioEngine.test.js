import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis.window || {};
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const { default: MseAudioEngine } = await import('../src/music/MseAudioEngine.js');

const MIME = 'audio/mp4; codecs="ec-3"';
const noop = () => {};
const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};

function emitter() {
    const listeners = new Map();
    return {
        addEventListener(event, handler) {
            if (!listeners.has(event)) listeners.set(event, new Set());
            listeners.get(event).add(handler);
        },
        removeEventListener(event, handler) {
            listeners.get(event)?.delete(handler);
        },
        fire(event) {
            [...(listeners.get(event) || [])].forEach((handler) => handler());
        }
    };
}

class FakeSourceBuffer {
    constructor(registry) {
        Object.assign(this, emitter());
        this.registry = registry;
        this.mode = 'segments';
        this.timestampOffset = 0;
        this.updating = false;
        this.ranges = [];
        this.appended = [];
        this.removed = [];
        this.quotaUrls = new Set();
        this._op = null;
    }

    get buffered() {
        const ranges = this.ranges;
        return { length: ranges.length, start: (i) => ranges[i][0], end: (i) => ranges[i][1] };
    }

    appendBuffer(bytes) {
        if (this.updating) throw new DOMException('busy', 'InvalidStateError');
        const { url, duration } = this.registry.get(bytes);
        if (this.quotaUrls.delete(url)) throw new DOMException('full', 'QuotaExceededError');
        this.appended.push({ url, offset: this.timestampOffset });
        this._run(() => {
            if (duration > 0) {
                this._addRange(this.timestampOffset, this.timestampOffset + duration);
                this.timestampOffset += duration;
            }
        });
    }

    remove(start, end) {
        if (this.updating) throw new DOMException('busy', 'InvalidStateError');
        this.removed.push([start, end]);
        this._run(() => {
            this.ranges = this.ranges
                .flatMap(([s, e]) => [
                    [s, Math.min(e, start)],
                    [Math.max(s, end), e]
                ])
                .filter(([s, e]) => e > s);
        });
    }

    abort() {
        if (!this.updating) return;
        this._op = null;
        this.updating = false;
        queueMicrotask(() => {
            this.fire('abort');
            this.fire('updateend');
        });
    }

    changeType() {}

    _run(apply) {
        this.updating = true;
        const op = {};
        this._op = op;
        queueMicrotask(() => {
            if (this._op !== op) return;
            this._op = null;
            apply();
            this.updating = false;
            this.fire('updateend');
        });
    }

    _addRange(start, end) {
        const last = this.ranges[this.ranges.length - 1];
        if (last && Math.abs(last[1] - start) < 1e-9) last[1] = end;
        else this.ranges.push([start, end]);
    }
}

class FakeMediaSource {
    constructor(registry) {
        Object.assign(this, emitter());
        this.registry = registry;
        this.readyState = 'closed';
        this.sourceBuffers = [];
        this.mimes = [];
        this.endOfStreamCalls = 0;
    }

    static isTypeSupported() {
        return true;
    }

    open() {
        this.readyState = 'open';
        this.fire('sourceopen');
    }

    addSourceBuffer(mime) {
        this.mimes.push(mime);
        const sb = new FakeSourceBuffer(this.registry);
        this.sourceBuffers.push(sb);
        return sb;
    }

    endOfStream() {
        this.endOfStreamCalls++;
        this.readyState = 'ended';
    }
}

function makeAudio() {
    const el = {
        ...emitter(),
        src: '',
        currentTime: 0,
        paused: true,
        calls: [],
        play() {
            el.paused = false;
            el.calls.push('play');
            return Promise.resolve();
        },
        pause() {
            el.paused = true;
            el.calls.push('pause');
        },
        removeAttribute(name) {
            el.calls.push(`remove:${name}`);
            if (name === 'src') el.src = '';
        },
        load: () => el.calls.push('load')
    };
    return el;
}

function deferred() {
    let resolve;
    const promise = new Promise((r) => (resolve = r));
    return { promise, resolve };
}

function setup() {
    const registry = new Map();
    const playlists = new Map();
    const bytesByUrl = new Map();
    const gates = new Map();
    const audios = [];
    const mediaSources = [];
    const timers = [];
    const events = [];
    const revoked = [];

    const addTrack = (id, durations) => {
        const base = `http://srv/${id}/`;
        const lines = ['#EXTM3U', '#EXT-X-MAP:URI="init.mp4"'];
        const register = (url, duration) => {
            const bytes = new Uint8Array(1);
            registry.set(bytes, { url, duration });
            bytesByUrl.set(url, bytes);
        };
        register(`${base}init.mp4`, 0);
        durations.forEach((d, i) => {
            lines.push(`#EXTINF:${d},`, `seg${i}.mp4`);
            register(`${base}seg${i}.mp4`, d);
        });
        playlists.set(`${base}main.m3u8`, lines.join('\n'));
        return {
            id,
            url: `${base}main.m3u8`,
            kind: 'mse',
            mime: MIME,
            durationMs: 1000 * durations.reduce((a, b) => a + b, 0)
        };
    };

    const engine = new MseAudioEngine({
        onTrackStart: (id) => events.push(['trackStart', id]),
        onEnded: () => events.push(['ended']),
        onError: (id, err) => events.push(['error', id, err.message]),
        onTime: (pos, dur) => events.push(['time', pos, dur]),
        createAudio: () => {
            const el = makeAudio();
            audios.push(el);
            return el;
        },
        createMediaSource: () => {
            const ms = new FakeMediaSource(registry);
            mediaSources.push(ms);
            return ms;
        },
        createObjectUrl: (ms) => {
            queueMicrotask(() => ms.open());
            return 'blob:ms';
        },
        revokeObjectUrl: (url) => revoked.push(url),
        fetchText: async (url) => playlists.get(url),
        fetchBytes: async (url) => {
            if (gates.has(url)) await gates.get(url).promise;
            return bytesByUrl.get(url);
        },
        setInterval: (fn, ms) => {
            timers.push({ fn, ms, cleared: false });
            return timers.length;
        },
        clearInterval: (handle) => {
            timers[handle - 1].cleared = true;
        },
        log: { warn: noop, error: noop, info: noop, debug: noop }
    });

    const sb = () => mediaSources[0].sourceBuffers[0];
    const appendedUrls = () => sb().appended.map((a) => a.url.replace('http://srv/', ''));
    const tick = () => timers.filter((t) => !t.cleared).forEach((t) => t.fn());
    const gate = (url) => {
        const d = deferred();
        gates.set(`http://srv/${url}`, d);
        return d;
    };

    return { engine, addTrack, audios, mediaSources, timers, events, revoked, sb, appendedUrls, tick, gate };
}

test('load appends init then segments from the start index with timestampOffset at that segment start', async () => {
    const h = setup();
    const a = h.addTrack('a', [4, 4, 4, 4, 4]);
    await h.engine.load(a, 9000);

    assert.deepEqual(h.appendedUrls().slice(0, 2), ['a/init.mp4', 'a/seg2.mp4']);
    assert.equal(h.sb().appended[1].offset, 8);
    assert.equal(h.audios[0].currentTime, 9);
    assert.equal(h.engine.currentTrackId, 'a');
    assert.equal(h.engine.positionMs, 9000);
    assert.equal(h.engine.durationMs, 20000);

    await h.engine.load(a, 0);
    const reloadAt = h.appendedUrls().lastIndexOf('a/init.mp4');
    assert.equal(h.appendedUrls()[reloadAt + 1], 'a/seg0.mp4');
    assert.equal(h.sb().appended[reloadAt + 1].offset, 0);
    assert.equal(h.audios[0].currentTime, 0);
});

test('one audio element, one MediaSource and one sequence-mode SourceBuffer across loads', async () => {
    const h = setup();
    const a = h.addTrack('a', [4, 4]);
    const b = h.addTrack('b', [3, 3]);
    await h.engine.load(a);
    await settle();
    await h.engine.load(b);
    await settle();

    assert.equal(h.audios.length, 1);
    assert.equal(h.mediaSources.length, 1);
    assert.deepEqual(h.mediaSources[0].mimes, [MIME]);
    assert.equal(h.sb().mode, 'sequence');
    assert.equal(h.audios[0].src, 'blob:ms');
    assert.deepEqual(h.sb().ranges, [[0, 6]]);
    assert.equal(h.engine.currentTrackId, 'b');
});

test('feeder keeps 20 s ahead, resumes on tick and evicts more than 4 s behind', async () => {
    const h = setup();
    const a = h.addTrack('a', [6, 6, 6, 6, 6, 6, 6, 6, 6, 6]);
    await h.engine.load(a);
    await settle();

    assert.deepEqual(h.sb().ranges, [[0, 24]]);
    assert.deepEqual(h.sb().removed, []);
    assert.equal(h.timers.length, 1);
    assert.equal(h.timers[0].ms, 250);

    h.audios[0].currentTime = 10;
    h.tick();
    await settle();

    assert.equal(h.appendedUrls().at(-1), 'a/seg4.mp4');
    assert.deepEqual(h.sb().removed, [[0, 6]]);
    assert.deepEqual(h.sb().ranges, [[6, 30]]);
    assert.equal(h.mediaSources[0].endOfStreamCalls, 0);
});

test('onTime reports position and track duration on every tick while playing', async () => {
    const h = setup();
    const a = h.addTrack('a', [4, 4]);
    await h.engine.load(a);
    h.engine.play();
    h.audios[0].currentTime = 2.5;
    h.tick();
    h.tick();
    h.engine.pause();
    h.tick();

    assert.deepEqual(
        h.events.filter((e) => e[0] === 'time'),
        [
            ['time', 2500, 8000],
            ['time', 2500, 8000]
        ]
    );
    assert.equal(h.audios[0].paused, true);
});

test('last segment with no next track ends the stream; ended fires onEnded once', async () => {
    const h = setup();
    const a = h.addTrack('a', [4, 4]);
    await h.engine.load(a);
    await settle();
    assert.equal(h.mediaSources[0].endOfStreamCalls, 1);

    h.engine.play();
    assert.equal(h.engine.isPlaying, true);
    h.audios[0].fire('ended');
    h.audios[0].fire('ended');

    assert.deepEqual(
        h.events.filter((e) => e[0] === 'ended'),
        [['ended']]
    );
    assert.equal(h.engine.isPlaying, false);
});

test('preloadNext stores the next track and keeps the stream open', async () => {
    const h = setup();
    const a = h.addTrack('a', [4, 4]);
    const b = h.addTrack('b', [4]);
    const gate = h.gate('a/seg1.mp4');
    await h.engine.load(a);
    await h.engine.preloadNext(b);
    gate.resolve();
    await settle();
    assert.ok(h.appendedUrls().includes('a/seg1.mp4'));
    assert.equal(h.mediaSources[0].endOfStreamCalls, 0);
});

test('Review Focus 1: load(b) during a pending feeder fetch for a appends nothing from a', async () => {
    const h = setup();
    const a = h.addTrack('a', [4, 4, 4]);
    const b = h.addTrack('b', [5, 5]);
    const gate = h.gate('a/seg1.mp4');
    await h.engine.load(a);
    await settle();

    const loadingB = h.engine.load(b);
    gate.resolve();
    await loadingB;
    await settle();

    assert.ok(!h.appendedUrls().includes('a/seg1.mp4'));
    assert.ok(!h.appendedUrls().includes('a/seg2.mp4'));
    assert.equal(h.engine.currentTrackId, 'b');
    assert.deepEqual(h.sb().ranges, [[0, 10]]);
});

test('Review Focus 1: load(b) during a pending first-segment fetch of load(a) appends nothing from a', async () => {
    const h = setup();
    const a = h.addTrack('a', [4, 4]);
    const b = h.addTrack('b', [5]);
    const gate = h.gate('a/seg0.mp4');
    const loadingA = h.engine.load(a);
    await settle();

    const loadingB = h.engine.load(b);
    gate.resolve();
    await Promise.all([loadingA, loadingB]);
    await settle();

    assert.ok(!h.appendedUrls().some((url) => url.startsWith('a/seg')));
    assert.equal(h.engine.currentTrackId, 'b');
});

test('QuotaExceededError evicts and retries on a later tick without surfacing an error', async () => {
    const h = setup();
    const a = h.addTrack('a', [6, 6, 6, 6, 6, 6]);
    await h.engine.load(a);
    h.sb().quotaUrls.add('http://srv/a/seg2.mp4');
    h.audios[0].currentTime = 3;
    await settle();

    assert.ok(!h.appendedUrls().includes('a/seg2.mp4'));
    assert.deepEqual(h.sb().removed, [[0, 2]]);

    h.tick();
    await settle();
    assert.ok(h.appendedUrls().includes('a/seg2.mp4'));
    assert.deepEqual(
        h.events.filter((e) => e[0] === 'error'),
        []
    );
});

test('an empty playlist rejects load', async () => {
    const h = setup();
    const a = h.addTrack('a', []);
    await assert.rejects(h.engine.load(a), /no segments/);
});

test('stop aborts feeding, clears buffers, pauses and clears the timer', async () => {
    const h = setup();
    const a = h.addTrack('a', [4, 4, 4]);
    const gate = h.gate('a/seg1.mp4');
    await h.engine.load(a);
    h.engine.play();
    h.engine.stop();
    gate.resolve();
    await settle();

    assert.ok(!h.appendedUrls().includes('a/seg1.mp4'));
    assert.deepEqual(h.sb().ranges, []);
    assert.equal(h.audios[0].paused, true);
    assert.ok(h.timers.every((t) => t.cleared));
    assert.equal(h.engine.isPlaying, false);
    assert.equal(h.engine.currentTrackId, null);
});

test('destroy also revokes the object URL and drops the element src', async () => {
    const h = setup();
    const a = h.addTrack('a', [4]);
    await h.engine.load(a);
    h.engine.destroy();
    await settle();

    assert.deepEqual(h.revoked, ['blob:ms']);
    assert.equal(h.audios[0].src, '');
    assert.ok(h.audios[0].calls.includes('remove:src'));
});
