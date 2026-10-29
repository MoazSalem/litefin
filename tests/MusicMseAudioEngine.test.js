import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis.window || {};
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const { default: MseAudioEngine } = await import('../src/music/MseAudioEngine.js');
const { RETRY_BUDGET_MS, RETRY_MAX_DELAY_MS } = await import('../src/music/mseRetry.js');

const MIME = 'audio/mp4; codecs="ec-3"';
const FLAC = 'audio/mp4; codecs="flac"';
const noop = () => {};
const settle = async () => {
    for (let i = 0; i < 40; i++) await new Promise((resolve) => setImmediate(resolve));
};
const until = async (condition) => {
    for (let i = 0; i < 100 && !condition(); i++) await Promise.resolve();
    assert.ok(condition(), 'condition never became true');
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
    constructor(registry, parent) {
        Object.assign(this, emitter());
        this.registry = registry;
        this.parent = parent;
        this.log = [];
        this.mode = 'segments';
        this.updating = false;
        this.ranges = [];
        this.appended = [];
        this.removed = [];
        this.quota = new Map();
        this.errorUrls = new Set();
        this.held = new Map();
        this._timestampOffset = 0;
        this._op = null;
    }

    get timestampOffset() {
        return this._timestampOffset;
    }

    set timestampOffset(value) {
        if (this.updating) throw new DOMException('busy', 'InvalidStateError');
        this._reopen();
        this._timestampOffset = value;
    }

    get buffered() {
        const ranges = this.ranges;
        return { length: ranges.length, start: (i) => ranges[i][0], end: (i) => ranges[i][1] };
    }

    appendBuffer(bytes) {
        if (this.updating) throw new DOMException('busy', 'InvalidStateError');
        this._reopen();
        const { url, duration } = this.registry.get(bytes);
        const quotaLeft = this.quota.get(url) || 0;
        if (quotaLeft > 0) {
            this.quota.set(url, quotaLeft - 1);
            throw new DOMException('full', 'QuotaExceededError');
        }
        this.appended.push({ url, offset: this._timestampOffset });
        this.log.push(url);
        if (this.errorUrls.has(url)) {
            this._run(noop, true);
            return;
        }
        this._run(
            () => {
                if (duration > 0) {
                    this._addRange(this._timestampOffset, this._timestampOffset + duration);
                    this._timestampOffset += duration;
                }
            },
            false,
            this.held.get(url)
        );
    }

    /* the append of `url` stays updating until the returned release() runs */
    hold(url) {
        let release;
        this.held.set(
            `http://srv/${url}`,
            new Promise((resolve) => {
                release = resolve;
            })
        );
        return () => release();
    }

    remove(start, end) {
        if (this.updating) throw new DOMException('busy', 'InvalidStateError');
        this._reopen();
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
        setImmediate(() => {
            this.fire('abort');
            this.fire('updateend');
        });
    }

    changeType(mime) {
        if (this.updating) throw new DOMException('busy', 'InvalidStateError');
        this._reopen();
        this.log.push(`changeType:${mime}`);
    }

    /* MSE: appendBuffer, remove, changeType and timestampOffset on an ended MediaSource reopen it */
    _reopen() {
        if (this.parent.readyState !== 'ended') return;
        this.parent.readyState = 'open';
        this.parent.fire('sourceopen');
    }

    _run(apply, fail = false, heldUntil = Promise.resolve()) {
        this.updating = true;
        const op = {};
        this._op = op;
        heldUntil.then(() =>
            setImmediate(() => {
                if (this._op !== op) return;
                this._op = null;
                apply();
                this.updating = false;
                if (!fail) {
                    this.fire('updateend');
                    return;
                }
                this.fire('error');
                setImmediate(() => this.fire('updateend'));
            })
        );
    }

    _addRange(start, end) {
        const last = this.ranges[this.ranges.length - 1];
        if (last && Math.abs(last[1] - start) < 1e-9) last[1] = end;
        else this.ranges.push([start, end]);
    }
}

class LegacySourceBuffer extends FakeSourceBuffer {}
LegacySourceBuffer.prototype.changeType = undefined;

class FakeMediaSource {
    constructor(registry, SourceBufferClass = FakeSourceBuffer) {
        Object.assign(this, emitter());
        this.registry = registry;
        this.SourceBufferClass = SourceBufferClass;
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
        const sb = new this.SourceBufferClass(this.registry, this);
        this.sourceBuffers.push(sb);
        return sb;
    }

    endOfStream() {
        if (this.readyState !== 'open' || this.sourceBuffers.some((sb) => sb.updating)) {
            throw new DOMException('not open or updating', 'InvalidStateError');
        }
        this.endOfStreamCalls++;
        this.readyState = 'ended';
    }
}

function makeAudio() {
    let src = '';
    const el = {
        ...emitter(),
        error: null,
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
    /* assigning src runs the media element load algorithm, which clears error */
    Object.defineProperty(el, 'src', {
        get: () => src,
        set: (value) => {
            src = value;
            el.error = null;
        }
    });
    return el;
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function setup({ autoOpen = true, changeType = true, allowChangeType } = {}) {
    const media = { autoOpen };
    const fetchCounts = new Map();
    const textFetchCounts = new Map();
    const failures = new Map();
    const textFailures = new Map();
    const hooks = {};
    const timeouts = [];
    const registry = new Map();
    const playlists = new Map();
    const bytesByUrl = new Map();
    const gates = new Map();
    const signals = new Map();
    const clock = { now: 0 };
    const audios = [];
    const mediaSources = [];
    const timers = [];
    const events = [];
    const revoked = [];

    const register = (url, duration) => {
        const bytes = new Uint8Array(1);
        registry.set(bytes, { url, duration });
        bytesByUrl.set(url, bytes);
    };
    const playlistText = (base, durations, suffix) => {
        const lines = ['#EXTM3U', '#EXT-X-MAP:URI="init.mp4"'];
        register(`${base}init.mp4`, 0);
        durations.forEach((d, i) => {
            lines.push(`#EXTINF:${d},`, `seg${i}.mp4${suffix}`);
            register(`${base}seg${i}.mp4${suffix}`, d);
        });
        return lines.join('\n');
    };

    const addTrack = (id, durations, { mime = MIME } = {}) => {
        const base = `http://srv/${id}/`;
        playlists.set(`${base}main.m3u8`, [playlistText(base, durations, '')]);
        return {
            id,
            url: `${base}main.m3u8`,
            kind: 'mse',
            mime,
            durations,
            durationMs: 1000 * durations.reduce((a, b) => a + b, 0)
        };
    };
    /* the next playlist request answers with segments of a restarted transcode job */
    const restartTranscode = (track) => {
        const base = track.url.replace('main.m3u8', '');
        playlists.get(track.url).push(playlistText(base, track.durations, '?job=2'));
    };

    const engine = new MseAudioEngine({
        ...(allowChangeType === undefined ? {} : { allowChangeType }),
        onTrackStart: (id) => {
            events.push(['trackStart', id]);
            if (hooks.onTrackStart) hooks.onTrackStart(id);
        },
        onEnded: () => events.push(['ended']),
        onError: (id, err) => {
            events.push(['error', id, err.message]);
            if (hooks.onError) hooks.onError(id, err);
        },
        onTime: (pos, dur) => events.push(['time', pos, dur]),
        createAudio: () => {
            const el = makeAudio();
            audios.push(el);
            return el;
        },
        createMediaSource: () => {
            const ms = new FakeMediaSource(registry, changeType ? FakeSourceBuffer : LegacySourceBuffer);
            mediaSources.push(ms);
            return ms;
        },
        createObjectUrl: (ms) => {
            if (media.autoOpen) setImmediate(() => ms.open());
            return `blob:ms${mediaSources.length}`;
        },
        revokeObjectUrl: (url) => revoked.push(url),
        fetchText: async (url) => {
            const count = textFetchCounts.get(url) || 0;
            textFetchCounts.set(url, count + 1);
            if ((textFailures.get(url) || 0) > 0) {
                textFailures.set(url, textFailures.get(url) - 1);
                throw new Error('HTTP 500');
            }
            const versions = playlists.get(url);
            return versions[Math.min(count, versions.length - 1)];
        },
        fetchBytes: async (url, signal) => {
            fetchCounts.set(url, (fetchCounts.get(url) || 0) + 1);
            signals.set(url, signal);
            if (gates.has(url)) await gates.get(url).promise;
            const failuresLeft = failures.get(url) || 0;
            if (failuresLeft > 0) {
                failures.set(url, failuresLeft - 1);
                throw new Error('HTTP 503');
            }
            return bytesByUrl.get(url);
        },
        setInterval: (fn, ms) => {
            timers.push({ fn, ms, cleared: false });
            return timers.length;
        },
        clearInterval: (handle) => {
            timers[handle - 1].cleared = true;
        },
        setTimeout: (fn, ms) => {
            timeouts.push({ fn, ms, cleared: false });
            return timeouts.length;
        },
        clearTimeout: (handle) => {
            timeouts[handle - 1].cleared = true;
        },
        now: () => clock.now,
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

    const advance = async (ms) => {
        clock.now += ms;
        tick();
        await settle();
    };
    const exhaustRetries = async () => {
        for (let spent = 0; spent <= RETRY_BUDGET_MS; spent += RETRY_MAX_DELAY_MS) await advance(RETRY_MAX_DELAY_MS);
    };
    const fetchCount = (url) => fetchCounts.get(`http://srv/${url}`) || 0;
    const playlistFetches = (track) => textFetchCounts.get(track.url) || 0;
    const failFetch = (url, times) => failures.set(`http://srv/${url}`, times);
    const failPlaylist = (track, times) => textFailures.set(track.url, times);
    const errors = () => events.filter((e) => e[0] === 'error');
    const trackStarts = () => events.filter((e) => e[0] === 'trackStart').map((e) => e[1]);
    const endedCount = () => events.filter((e) => e[0] === 'ended').length;
    const sbLog = (index = 0) => mediaSources[index].sourceBuffers[0].log.map((x) => x.replace('http://srv/', ''));

    return {
        engine,
        addTrack,
        audios,
        mediaSources,
        timers,
        timeouts,
        events,
        revoked,
        media,
        sb,
        appendedUrls,
        tick,
        advance,
        exhaustRetries,
        gate,
        fetchCount,
        playlistFetches,
        failFetch,
        failPlaylist,
        signalOf: (url) => signals.get(`http://srv/${url}`),
        hooks,
        restartTranscode,
        errors,
        trackStarts,
        endedCount,
        sbLog
    };
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
    assert.equal(h.audios[0].src, 'blob:ms1');
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

test('I1: a new load or stop aborts the requests of the superseded generation', async () => {
    const h = setup();
    const a = h.addTrack('a', [4, 4, 4]);
    const b = h.addTrack('b', [4, 4]);
    h.gate('a/seg1.mp4');
    await h.engine.load(a);
    await settle();
    const hanging = h.signalOf('a/seg1.mp4');
    assert.equal(hanging.aborted, false);

    await h.engine.load(b);
    assert.equal(hanging.aborted, true);
    const current = h.signalOf('b/seg0.mp4');
    assert.equal(current.aborted, false);

    h.engine.stop();
    assert.equal(current.aborted, true);
});

test('QuotaExceededError evicts and retries on a later tick without surfacing an error', async () => {
    const h = setup();
    const a = h.addTrack('a', [6, 6, 6, 6, 6, 6]);
    await h.engine.load(a);
    h.sb().quota.set('http://srv/a/seg2.mp4', 1);
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

test('M1: a QuotaExceededError on the next track init append evicts and retries without reporting the track', async () => {
    const h = setup();
    const a = h.addTrack('a', [4, 4]);
    const b = h.addTrack('b', [3, 3]);
    await h.engine.load(a);
    h.engine.play();
    await settle();
    h.sb().quota.set('http://srv/b/init.mp4', 1);
    h.audios[0].currentTime = 3;
    await h.engine.preloadNext(b);
    await settle();

    assert.deepEqual(h.errors(), []);
    assert.ok(!h.appendedUrls().includes('b/init.mp4'));
    assert.deepEqual(h.sb().removed.at(-1), [0, 2]);
    assert.equal(h.fetchCount('b/init.mp4'), 1);

    h.tick();
    await settle();
    assert.deepEqual(h.appendedUrls().slice(-3), ['b/init.mp4', 'b/seg0.mp4', 'b/seg1.mp4']);
    assert.equal(h.fetchCount('b/init.mp4'), 1);
    assert.deepEqual(h.errors(), []);

    h.audios[0].currentTime = 8.5;
    h.tick();
    assert.deepEqual(h.trackStarts(), ['b']);
});

test('M1: any other error on the next track init append still reports that track once', async () => {
    const h = setup();
    const a = h.addTrack('a', [4, 4]);
    const b = h.addTrack('b', [3, 3]);
    await h.engine.load(a);
    h.engine.play();
    await settle();
    h.sb().errorUrls.add('http://srv/b/init.mp4');
    await h.engine.preloadNext(b);
    await settle();

    assert.deepEqual(h.errors(), [['error', 'b', 'SourceBuffer update failed']]);
    assert.ok(!h.appendedUrls().includes('b/seg0.mp4'));
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

    assert.deepEqual(h.revoked, ['blob:ms1']);
    assert.equal(h.audios[0].src, '');
    assert.ok(h.audios[0].calls.includes('remove:src'));
});

test('I1: stop() then load(b) during an in-flight append waits for it and loads b cleanly', async () => {
    const h = setup();
    const a = h.addTrack('a', [4, 4, 4]);
    const b = h.addTrack('b', [5, 5]);
    const gate = h.gate('a/seg1.mp4');
    await h.engine.load(a);
    gate.resolve();
    await until(() => h.sb().updating);

    h.engine.stop();
    await h.engine.load(b);
    await settle();

    assert.deepEqual(h.sb().ranges, [[0, 10]]);
    assert.equal(h.engine.currentTrackId, 'b');
    assert.deepEqual(h.errors(), []);
});

test('I2: a quota-rejected segment is fetched once and the same bytes are retried on later ticks', async () => {
    const h = setup();
    const a = h.addTrack('a', [6, 6, 6, 6, 6, 6]);
    const gate = h.gate('a/seg1.mp4');
    await h.engine.load(a);
    h.sb().quota.set('http://srv/a/seg2.mp4', 2);
    gate.resolve();
    await settle();
    h.tick();
    await settle();
    assert.ok(!h.appendedUrls().includes('a/seg2.mp4'));
    h.tick();
    await settle();

    assert.ok(h.appendedUrls().includes('a/seg2.mp4'));
    assert.equal(h.fetchCount('a/seg2.mp4'), 1);
    assert.deepEqual(h.errors(), []);
});

test('I3: destroy before sourceopen settles the pending load', async () => {
    const h = setup({ autoOpen: false });
    const a = h.addTrack('a', [4]);
    const loading = h.engine.load(a);
    await settle();
    h.engine.destroy();

    const outcome = await Promise.race([
        loading.then(
            () => 'settled',
            () => 'settled'
        ),
        settle().then(() => 'pending')
    ]);
    assert.equal(outcome, 'settled');
    assert.equal(h.engine.currentTrackId, null);
});

test('I3: a MediaSource that never opens rejects load after a timeout and the next load rebuilds it', async () => {
    const h = setup({ autoOpen: false });
    const a = h.addTrack('a', [4]);
    const loading = h.engine.load(a);
    await settle();
    h.timeouts.filter((t) => !t.cleared).forEach((t) => t.fn());
    await assert.rejects(loading, /did not open/);

    h.media.autoOpen = true;
    await h.engine.load(a);

    assert.equal(h.audios.length, 1);
    assert.equal(h.mediaSources.length, 2);
    assert.equal(h.audios[0].src, 'blob:ms2');
    assert.deepEqual(h.revoked, ['blob:ms1']);
});

test('I3: after a fatal element error the next load rebuilds the MediaSource on the same element', async () => {
    const h = setup();
    const a = h.addTrack('a', [4]);
    const b = h.addTrack('b', [5]);
    await h.engine.load(a);
    await settle();
    h.audios[0].error = { code: 3 };
    h.audios[0].fire('error');

    await h.engine.load(b);
    await settle();

    assert.equal(h.audios.length, 1);
    assert.equal(h.mediaSources.length, 2);
    assert.deepEqual(h.revoked, ['blob:ms1']);
    assert.equal(h.audios[0].src, 'blob:ms2');
    assert.deepEqual(h.mediaSources[1].sourceBuffers[0].ranges, [[0, 5]]);
    assert.equal(h.engine.currentTrackId, 'b');
});

test('I4: one failed append reports one error even when the element errors too', async () => {
    const h = setup();
    const a = h.addTrack('a', [4, 4, 4]);
    const gate = h.gate('a/seg1.mp4');
    await h.engine.load(a);
    h.sb().errorUrls.add('http://srv/a/seg1.mp4');
    gate.resolve();
    await settle();
    h.audios[0].error = { code: 3 };
    h.audios[0].fire('error');

    assert.deepEqual(h.errors(), [['error', 'a', 'SourceBuffer update failed']]);
});

test('M1: an ended event from the previous track during load(b) does not end b', async () => {
    const h = setup();
    const a = h.addTrack('a', [4]);
    const b = h.addTrack('b', [5]);
    await h.engine.load(a);
    await settle();
    const loading = h.engine.load(b);
    h.audios[0].fire('ended');
    await loading;

    assert.deepEqual(
        h.events.filter((e) => e[0] === 'ended'),
        []
    );
});

test('M2: a superseded load resolves even when its fetch fails afterwards', async () => {
    const h = setup();
    const a = h.addTrack('a', [4]);
    const b = h.addTrack('b', [5]);
    const gate = h.gate('a/seg0.mp4');
    const loadingA = h.engine.load(a);
    await settle();
    const loadingB = h.engine.load(b);
    gate.reject(new Error('network down'));

    await loadingA;
    await loadingB;
    assert.equal(h.engine.currentTrackId, 'b');
});

test('M3: play() after ended restarts the tick timer', async () => {
    const h = setup();
    const a = h.addTrack('a', [4]);
    await h.engine.load(a);
    await settle();
    h.engine.play();
    h.audios[0].fire('ended');
    assert.ok(h.timers.every((t) => t.cleared));

    h.engine.play();
    assert.equal(h.timers.filter((t) => !t.cleared).length, 1);
});

test('preloadNext appends the next track gapless and onTrackStart fires once when playback crosses into it', async () => {
    const h = setup();
    const a = h.addTrack('a', [4, 4]);
    const b = h.addTrack('b', [3, 3]);
    await h.engine.load(a);
    await h.engine.preloadNext(b);
    await settle();

    assert.deepEqual(h.appendedUrls(), [
        'a/init.mp4',
        'a/seg0.mp4',
        'a/seg1.mp4',
        'b/init.mp4',
        'b/seg0.mp4',
        'b/seg1.mp4'
    ]);
    assert.deepEqual(
        h
            .sb()
            .appended.slice(3)
            .map((x) => x.offset),
        [8, 8, 11]
    );
    assert.deepEqual(h.sb().ranges, [[0, 14]]);
    assert.equal(h.mediaSources[0].endOfStreamCalls, 0);

    h.engine.play();
    h.audios[0].currentTime = 7.9;
    h.tick();
    assert.equal(h.engine.currentTrackId, 'a');
    assert.deepEqual(h.trackStarts(), []);

    h.audios[0].currentTime = 8.5;
    h.tick();
    h.tick();
    assert.deepEqual(h.trackStarts(), ['b']);
    assert.equal(h.engine.currentTrackId, 'b');
    assert.equal(h.engine.positionMs, 500);
    assert.equal(h.engine.durationMs, 6000);
    assert.deepEqual(h.events.filter((e) => e[0] === 'time').at(-1), ['time', 500, 6000]);

    await settle();
    assert.equal(h.mediaSources[0].endOfStreamCalls, 1);
});

test('R6: preloadNext of the current track appends it again and announces the repeat', async () => {
    const h = setup();
    const a = h.addTrack('a', [4, 4]);
    await h.engine.load(a);
    await h.engine.preloadNext(a);
    await settle();

    assert.deepEqual(h.appendedUrls(), [
        'a/init.mp4',
        'a/seg0.mp4',
        'a/seg1.mp4',
        'a/init.mp4',
        'a/seg0.mp4',
        'a/seg1.mp4'
    ]);
    assert.deepEqual(
        h
            .sb()
            .appended.slice(4)
            .map((x) => x.offset),
        [8, 12]
    );

    h.audios[0].currentTime = 9;
    h.tick();
    h.tick();
    assert.deepEqual(h.trackStarts(), ['a']);
    assert.equal(h.engine.positionMs, 1000);
});

test('preloadNext after endOfStream reopens the stream, appends the next track and ends it again', async () => {
    const h = setup();
    const a = h.addTrack('a', [4]);
    const b = h.addTrack('b', [3]);
    await h.engine.load(a);
    await settle();
    assert.equal(h.mediaSources[0].endOfStreamCalls, 1);

    await h.engine.preloadNext(b);
    await settle();
    assert.deepEqual(h.appendedUrls().slice(2), ['b/init.mp4', 'b/seg0.mp4']);
    assert.equal(h.sb().appended[3].offset, 4);
    assert.equal(h.mediaSources[0].readyState, 'open');

    h.engine.play();
    h.audios[0].currentTime = 4.5;
    h.tick();
    await settle();
    assert.deepEqual(h.trackStarts(), ['b']);
    assert.equal(h.mediaSources[0].endOfStreamCalls, 2);

    h.audios[0].fire('ended');
    assert.equal(h.endedCount(), 1);
});

test('Review Focus 2: preloadNext(c) over a partly appended b removes b and appends c in its place', async () => {
    const h = setup();
    const a = h.addTrack('a', [4, 4]);
    const b = h.addTrack('b', [3, 3, 3]);
    const c = h.addTrack('c', [5]);
    const gate = h.gate('b/seg1.mp4');
    await h.engine.load(a);
    await h.engine.preloadNext(b);
    await settle();
    assert.ok(h.appendedUrls().includes('b/seg0.mp4'));

    await h.engine.preloadNext(c);
    gate.resolve();
    await settle();

    assert.deepEqual(h.sb().removed, [[8, Infinity]]);
    assert.ok(!h.appendedUrls().includes('b/seg1.mp4'));
    const cAppends = h.sb().appended.filter((x) => x.url.includes('/c/'));
    assert.deepEqual(
        cAppends.map((x) => [x.url.replace('http://srv/', ''), x.offset]),
        [
            ['c/init.mp4', 8],
            ['c/seg0.mp4', 8]
        ]
    );
    assert.deepEqual(h.sb().ranges, [[0, 13]]);

    h.engine.play();
    h.audios[0].currentTime = 8.5;
    h.tick();
    h.tick();
    assert.deepEqual(h.trackStarts(), ['c']);
    assert.equal(h.engine.currentTrackId, 'c');
});

test('Review Focus 2: preloadNext(null) after b was appended removes b and ends the stream after a', async () => {
    const h = setup();
    const a = h.addTrack('a', [4, 4]);
    const b = h.addTrack('b', [3]);
    await h.engine.load(a);
    await h.engine.preloadNext(b);
    await settle();
    assert.equal(h.mediaSources[0].endOfStreamCalls, 0);

    await h.engine.preloadNext(null);
    await settle();

    assert.deepEqual(h.sb().removed, [[8, Infinity]]);
    assert.deepEqual(h.sb().ranges, [[0, 8]]);
    assert.equal(h.mediaSources[0].endOfStreamCalls, 1);

    h.engine.play();
    h.audios[0].fire('ended');
    assert.deepEqual(h.trackStarts(), []);
    assert.equal(h.endedCount(), 1);
});

test('Review Focus 4: seek inside the buffered current track only moves currentTime', async () => {
    const h = setup();
    const a = h.addTrack('a', [4, 4, 4]);
    await h.engine.load(a);
    await settle();
    const appends = h.sb().appended.length;

    await h.engine.seek(6500);

    assert.equal(h.audios[0].currentTime, 6.5);
    assert.equal(h.sb().appended.length, appends);
    assert.deepEqual(h.sb().removed, []);
    assert.equal(h.playlistFetches(a), 1);
    assert.equal(h.engine.positionMs, 6500);
});

test('Review Focus 4: seek outside the buffer reloads the current track there, keeps playing and re-appends the next track', async () => {
    const h = setup();
    const a = h.addTrack('a', [6, 6, 6, 6, 6, 6, 6, 6, 6, 6]);
    const b = h.addTrack('b', [3]);
    await h.engine.load(a);
    await h.engine.preloadNext(b);
    h.engine.play();
    await settle();
    assert.deepEqual(h.sb().ranges, [[0, 24]]);
    const before = h.sb().appended.length;

    await h.engine.seek(40000);

    assert.equal(h.audios[0].currentTime, 40);
    assert.equal(h.engine.isPlaying, true);
    assert.deepEqual(h.appendedUrls().slice(before, before + 2), ['a/init.mp4', 'a/seg6.mp4']);
    assert.equal(h.sb().appended[before + 1].offset, 36);

    await settle();
    const after = h.appendedUrls().slice(before);
    assert.ok(after.indexOf('b/init.mp4') > after.indexOf('a/seg9.mp4'));
    assert.equal(h.sb().appended.find((x) => x.url.endsWith('b/init.mp4')).offset, 60);
    assert.equal(h.engine.currentTrackId, 'a');
    assert.equal(h.engine.positionMs, 40000);
    assert.equal(h.engine.isPlaying, true);
    assert.deepEqual(h.errors(), []);
});

test('Review Focus 4: seek past the current track end clamps to it instead of jumping into the buffered next track', async () => {
    const h = setup();
    const a = h.addTrack('a', [4, 4]);
    const b = h.addTrack('b', [3, 3]);
    await h.engine.load(a);
    await h.engine.preloadNext(b);
    await settle();

    await h.engine.seek(10000);

    assert.equal(h.audios[0].currentTime, 8);
    assert.equal(h.engine.currentTrackId, 'a');
    assert.deepEqual(h.trackStarts(), []);
});

test('Review Focus 3: a failed segment fetch refetches the playlist on the first retry and retries the same index', async () => {
    const h = setup();
    const a = h.addTrack('a', [4, 4, 4]);
    h.restartTranscode(a);
    h.failFetch('a/seg1.mp4', 1);
    await h.engine.load(a);
    await settle();
    assert.equal(h.playlistFetches(a), 1);
    await h.advance(500);

    assert.equal(h.playlistFetches(a), 2);
    assert.deepEqual(h.appendedUrls(), ['a/init.mp4', 'a/seg0.mp4', 'a/seg1.mp4?job=2', 'a/seg2.mp4?job=2']);
    assert.deepEqual(h.errors(), []);
});

test('Review Focus 3: a segment that keeps failing reports one error after the retries and stops feeding', async () => {
    const h = setup();
    const a = h.addTrack('a', [4, 4, 4]);
    h.failFetch('a/seg1.mp4', Infinity);
    await h.engine.load(a);
    await settle();
    await h.exhaustRetries();
    await h.exhaustRetries();

    assert.deepEqual(h.errors(), [['error', 'a', 'HTTP 503']]);
    assert.equal(h.playlistFetches(a), 2);
    assert.equal(h.fetchCount('a/seg2.mp4'), 0);
    assert.deepEqual(h.appendedUrls(), ['a/init.mp4', 'a/seg0.mp4']);
});

test('I2: a transient segment failure with buffer ahead recovers through backoff without onError', async () => {
    const h = setup();
    const a = h.addTrack('a', [4, 4, 4, 4, 4, 4]);
    h.failFetch('a/seg2.mp4', 3);
    await h.engine.load(a);
    h.engine.play();
    await settle();
    assert.deepEqual(h.appendedUrls(), ['a/init.mp4', 'a/seg0.mp4', 'a/seg1.mp4']);

    await h.advance(499);
    assert.equal(h.fetchCount('a/seg2.mp4'), 1);
    await h.advance(1);
    assert.equal(h.fetchCount('a/seg2.mp4'), 2);
    assert.equal(h.playlistFetches(a), 2);
    await h.advance(1000);
    assert.equal(h.fetchCount('a/seg2.mp4'), 3);
    await h.advance(1999);
    assert.equal(h.fetchCount('a/seg2.mp4'), 3);
    await h.advance(1);

    assert.deepEqual(h.appendedUrls().slice(3), ['a/seg2.mp4', 'a/seg3.mp4', 'a/seg4.mp4']);
    assert.deepEqual(h.errors(), []);
    assert.equal(h.playlistFetches(a), 2);
});

test('I2: a persistent segment failure reports once after the 30 s retry budget', async () => {
    const h = setup();
    const a = h.addTrack('a', [4, 4, 4, 4, 4, 4]);
    h.failFetch('a/seg2.mp4', Infinity);
    await h.engine.load(a);
    await settle();

    await h.advance(RETRY_BUDGET_MS - 1);
    assert.deepEqual(h.errors(), []);
    await h.exhaustRetries();

    assert.deepEqual(h.errors(), [['error', 'a', 'HTTP 503']]);
    assert.equal(h.playlistFetches(a), 2);
});

test('I2: a buffer that drains below 1 s while retrying reports at once', async () => {
    const h = setup();
    const a = h.addTrack('a', [4, 4, 4, 4, 4, 4]);
    h.failFetch('a/seg2.mp4', Infinity);
    await h.engine.load(a);
    await settle();
    await h.advance(500);
    assert.deepEqual(h.errors(), []);

    h.audios[0].currentTime = 7.5;
    await h.advance(1);
    assert.deepEqual(h.errors(), [['error', 'a', 'HTTP 503']]);
});

test('I2: a failure with 3 s or less buffered ahead reports without retrying', async () => {
    const h = setup();
    const a = h.addTrack('a', [3, 4, 4]);
    h.failFetch('a/seg1.mp4', Infinity);
    await h.engine.load(a);
    await settle();

    assert.deepEqual(h.errors(), [['error', 'a', 'HTTP 503']]);
    assert.equal(h.playlistFetches(a), 1);
});

test('Review Focus 5: a next track with another codec switches the SourceBuffer type before its init segment', async () => {
    const h = setup();
    const a = h.addTrack('a', [4]);
    const b = h.addTrack('b', [3], { mime: FLAC });
    await h.engine.load(a);
    await h.engine.preloadNext(b);
    await settle();

    assert.deepEqual(h.sbLog(), ['a/init.mp4', 'a/seg0.mp4', `changeType:${FLAC}`, 'b/init.mp4', 'b/seg0.mp4']);
    assert.equal(h.mediaSources.length, 1);
});

test('Review Focus 5: load of a track with another codec switches the type of the existing SourceBuffer', async () => {
    const h = setup();
    const a = h.addTrack('a', [4]);
    const b = h.addTrack('b', [3], { mime: FLAC });
    await h.engine.load(a);
    await settle();
    await h.engine.load(b);
    await settle();

    assert.deepEqual(h.sbLog().slice(2), [`changeType:${FLAC}`, 'b/init.mp4', 'b/seg0.mp4']);
    assert.equal(h.mediaSources.length, 1);
});

test('Review Focus 5: without changeType the next codec is not appended; ended loads it, keeps playing and starts it without onEnded', async () => {
    const h = setup({ changeType: false });
    const a = h.addTrack('a', [4]);
    const b = h.addTrack('b', [3], { mime: FLAC });
    await h.engine.load(a);
    await h.engine.preloadNext(b);
    h.engine.play();
    await settle();

    assert.ok(!h.appendedUrls().some((url) => url.startsWith('b/')));
    assert.equal(h.mediaSources[0].endOfStreamCalls, 1);

    h.audios[0].fire('ended');
    await settle();

    assert.deepEqual(h.trackStarts(), ['b']);
    assert.equal(h.endedCount(), 0);
    assert.equal(h.engine.currentTrackId, 'b');
    assert.equal(h.engine.isPlaying, true);
    assert.equal(h.audios.length, 1);
    assert.equal(h.audios[0].calls.filter((call) => call === 'play').length, 2);
    assert.equal(h.mediaSources.length, 2);
    assert.deepEqual(h.mediaSources[1].mimes, [FLAC]);
    assert.deepEqual(h.mediaSources[1].sourceBuffers[0].ranges, [[0, 3]]);
});

test('R7: load after stop() rebuilds the pipeline when the element errored while stopped', async () => {
    const h = setup();
    const a = h.addTrack('a', [4]);
    const b = h.addTrack('b', [5]);
    await h.engine.load(a);
    await settle();
    h.engine.stop();
    await settle();
    h.audios[0].error = { code: 4 };
    h.audios[0].fire('error');

    await h.engine.load(b);
    await settle();

    assert.equal(h.audios.length, 1);
    assert.equal(h.mediaSources.length, 2);
    assert.deepEqual(h.revoked, ['blob:ms1']);
    assert.deepEqual(h.mediaSources[1].sourceBuffers[0].ranges, [[0, 5]]);
    assert.deepEqual(h.errors(), []);
});

/* MusicSession._handleError on a preloaded track: preloadNext(null) at once, then preloadNext(next candidate) after it is prepared */
function failPreloadedLikeSession(h, failedId, replacement) {
    h.hooks.onError = (id) => {
        if (id !== failedId) return;
        h.engine.preloadNext(null);
        if (replacement) setImmediate(() => h.engine.preloadNext(replacement));
    };
}

test('C1: a next track that fails twice, then preloadNext(null), still ends the stream and fires onEnded once', async () => {
    const h = setup();
    const a = h.addTrack('a', [4, 4]);
    const b = h.addTrack('b', [3, 3, 3]);
    h.failFetch('b/seg1.mp4', Infinity);
    failPreloadedLikeSession(h, 'b', null);
    await h.engine.load(a);
    h.engine.play();
    await settle();
    assert.equal(h.mediaSources[0].endOfStreamCalls, 1);
    await h.engine.preloadNext(b);
    await settle();
    await h.exhaustRetries();

    assert.deepEqual(h.errors(), [['error', 'b', 'HTTP 503']]);
    assert.deepEqual(h.sb().removed, [[8, Infinity]]);
    assert.deepEqual(h.sb().ranges, [[0, 8]]);
    assert.equal(h.mediaSources[0].endOfStreamCalls, 2);

    h.audios[0].currentTime = 8;
    h.audios[0].fire('ended');
    assert.equal(h.endedCount(), 1);
    assert.deepEqual(h.trackStarts(), []);
});

test('C1: a next track that fails twice, then preloadNext(c), plays c gapless after the current track', async () => {
    const h = setup();
    const a = h.addTrack('a', [4, 4]);
    const b = h.addTrack('b', [3, 3, 3]);
    const c = h.addTrack('c', [5]);
    h.failFetch('b/seg1.mp4', Infinity);
    failPreloadedLikeSession(h, 'b', c);
    await h.engine.load(a);
    await h.engine.preloadNext(b);
    h.engine.play();
    await settle();
    await h.exhaustRetries();

    assert.deepEqual(h.errors(), [['error', 'b', 'HTTP 503']]);
    const cAppends = h.sb().appended.filter((x) => x.url.includes('/c/'));
    assert.deepEqual(
        cAppends.map((x) => [x.url.replace('http://srv/', ''), x.offset]),
        [
            ['c/init.mp4', 8],
            ['c/seg0.mp4', 8]
        ]
    );
    assert.deepEqual(h.sb().ranges, [[0, 13]]);

    h.audios[0].currentTime = 8.5;
    h.tick();
    assert.deepEqual(h.trackStarts(), ['c']);
    assert.equal(h.engine.currentTrackId, 'c');
});

test('I1: a failed reload of a blocked next track announces it before the error, and the session can load the following track', async () => {
    const h = setup({ changeType: false });
    const a = h.addTrack('a', [4]);
    const b = h.addTrack('b', [3], { mime: FLAC });
    const c = h.addTrack('c', [5]);
    await h.engine.load(a);
    await h.engine.preloadNext(b);
    h.engine.play();
    await settle();
    h.failPlaylist(b, 1);

    h.audios[0].fire('ended');
    await settle();

    assert.deepEqual(
        h.events.filter((e) => e[0] === 'trackStart' || e[0] === 'error'),
        [
            ['trackStart', 'b'],
            ['error', 'b', 'HTTP 500']
        ]
    );
    assert.equal(h.endedCount(), 0);

    await h.engine.preloadNext(c);
    await h.engine.load(c);
    h.engine.play();
    await settle();

    assert.equal(h.engine.currentTrackId, 'c');
    assert.equal(h.engine.isPlaying, true);
    assert.deepEqual(h.mediaSources.at(-1).sourceBuffers[0].ranges, [[0, 5]]);
    assert.equal(h.errors().length, 1);
});

test('I2: replacing the next track while its init append is still updating appends only the replacement', async () => {
    const h = setup();
    const a = h.addTrack('a', [4, 4]);
    const b = h.addTrack('b', [3, 3]);
    const c = h.addTrack('c', [5]);
    await h.engine.load(a);
    await settle();
    const release = h.sb().hold('b/init.mp4');
    await h.engine.preloadNext(b);
    await until(() => h.sb().updating);
    await settle();

    await h.engine.preloadNext(c);
    release();
    await settle();

    assert.ok(!h.appendedUrls().some((url) => url.startsWith('b/seg')));
    assert.deepEqual(
        h
            .sb()
            .appended.filter((x) => x.url.includes('/c/'))
            .map((x) => x.offset),
        [8, 8]
    );
    assert.deepEqual(h.sb().ranges, [[0, 13]]);
    assert.equal(h.mediaSources[0].endOfStreamCalls, 1);

    h.audios[0].currentTime = 8.5;
    h.tick();
    await settle();
    assert.deepEqual(h.trackStarts(), ['c']);
    assert.equal(h.mediaSources[0].endOfStreamCalls, 2);
});

test('I2: a seek racing an in-flight start of the next track re-appends it once after the reloaded tail', async () => {
    const h = setup();
    const a = h.addTrack('a', [6, 6, 6, 6, 6, 6, 6, 6, 6, 6]);
    const b = h.addTrack('b', [3]);
    await h.engine.load(a);
    await h.engine.preloadNext(b);
    h.audios[0].currentTime = 40;
    h.tick();
    const gate = h.gate('b/init.mp4');
    await settle();
    assert.equal(h.fetchCount('b/init.mp4'), 1);

    const seeking = h.engine.seek(5000);
    gate.resolve();
    await seeking;
    await settle();
    h.audios[0].currentTime = 59;
    for (let i = 0; i < 6; i++) {
        h.tick();
        await settle();
    }

    const bInits = h.sb().appended.filter((x) => x.url.endsWith('b/init.mp4'));
    assert.deepEqual(
        bInits.map((x) => x.offset),
        [60]
    );
    assert.equal(h.sb().appended.filter((x) => x.url.endsWith('b/seg0.mp4')).length, 1);
    assert.deepEqual(h.errors(), []);

    h.audios[0].currentTime = 60.5;
    h.tick();
    assert.deepEqual(h.trackStarts(), ['b']);
});

test('repeat-one: a failed repeated preload is dropped silently, the track ends normally and a later element error still reports once', async () => {
    const h = setup();
    const a = h.addTrack('a', [4, 4]);
    await h.engine.load(a);
    h.engine.play();
    await settle();
    assert.equal(h.mediaSources[0].endOfStreamCalls, 1);
    h.failFetch('a/seg1.mp4', Infinity);
    await h.engine.preloadNext(a);
    await settle();
    await h.exhaustRetries();

    assert.deepEqual(h.errors(), []);
    assert.deepEqual(h.sb().ranges, [[0, 8]]);
    assert.equal(h.mediaSources[0].endOfStreamCalls, 2);

    h.audios[0].error = { code: 3 };
    h.audios[0].fire('error');
    assert.deepEqual(h.errors(), [['error', 'a', 'Audio element error (code 3)']]);
});

test('repeat-one: a failed repeated preload lets the current track end with onEnded once', async () => {
    const h = setup();
    const a = h.addTrack('a', [4, 4]);
    await h.engine.load(a);
    h.engine.play();
    await settle();
    h.failFetch('a/seg1.mp4', Infinity);
    await h.engine.preloadNext(a);
    await settle();
    await h.exhaustRetries();

    h.audios[0].currentTime = 8;
    h.audios[0].fire('ended');
    assert.equal(h.endedCount(), 1);
    assert.deepEqual(h.trackStarts(), []);
    assert.deepEqual(h.errors(), []);
});

test('allowChangeType false: load of another codec rebuilds the MediaSource on the same element instead of changeType', async () => {
    const h = setup({ allowChangeType: false });
    const a = h.addTrack('a', [4]);
    const b = h.addTrack('b', [3], { mime: FLAC });
    await h.engine.load(a);
    await settle();
    await h.engine.load(b);
    await settle();

    assert.equal(h.audios.length, 1);
    assert.equal(h.mediaSources.length, 2);
    assert.deepEqual(h.revoked, ['blob:ms1']);
    assert.equal(h.audios[0].src, 'blob:ms2');
    assert.deepEqual(h.mediaSources[1].mimes, [FLAC]);
    assert.ok(!h.sbLog(0).some((x) => x.startsWith('changeType')));
    assert.ok(!h.sbLog(1).some((x) => x.startsWith('changeType')));
    assert.deepEqual(h.mediaSources[1].sourceBuffers[0].ranges, [[0, 3]]);
    assert.equal(h.engine.currentTrackId, 'b');
});

test('allowChangeType false: a same-codec load keeps the MediaSource', async () => {
    const h = setup({ allowChangeType: false });
    const a = h.addTrack('a', [4]);
    const b = h.addTrack('b', [5]);
    await h.engine.load(a);
    await settle();
    await h.engine.load(b);
    await settle();

    assert.equal(h.mediaSources.length, 1);
});

test('allowChangeType false: a cross-codec next track is not appended; ended reloads it and starts it without onEnded', async () => {
    const h = setup({ allowChangeType: false });
    const a = h.addTrack('a', [4]);
    const b = h.addTrack('b', [3], { mime: FLAC });
    await h.engine.load(a);
    await h.engine.preloadNext(b);
    h.engine.play();
    await settle();

    assert.ok(!h.appendedUrls().some((url) => url.startsWith('b/')));
    assert.ok(!h.sbLog().some((x) => x.startsWith('changeType')));
    assert.equal(h.mediaSources[0].endOfStreamCalls, 1);

    h.audios[0].fire('ended');
    await settle();

    assert.deepEqual(h.trackStarts(), ['b']);
    assert.equal(h.endedCount(), 0);
    assert.equal(h.engine.isPlaying, true);
    assert.equal(h.audios.length, 1);
    assert.equal(h.mediaSources.length, 2);
    assert.deepEqual(h.mediaSources[1].mimes, [FLAC]);
    assert.deepEqual(h.mediaSources[1].sourceBuffers[0].ranges, [[0, 3]]);
});

test('allowChangeType false: a same-codec next track is still appended gapless', async () => {
    const h = setup({ allowChangeType: false });
    const a = h.addTrack('a', [4]);
    const b = h.addTrack('b', [3]);
    await h.engine.load(a);
    await h.engine.preloadNext(b);
    await settle();

    assert.deepEqual(h.appendedUrls(), ['a/init.mp4', 'a/seg0.mp4', 'b/init.mp4', 'b/seg0.mp4']);
    assert.equal(h.mediaSources.length, 1);
});
