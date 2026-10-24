import { test } from 'node:test';
import assert from 'node:assert/strict';
import HybridAudioEngine from '../src/music/HybridAudioEngine.js';

const flush = () => new Promise((resolve) => globalThis.setImmediate(resolve));

function makeInner(name, callbacks) {
    const inner = {
        name,
        callbacks,
        calls: [],
        loads: [],
        preloads: [],
        positionMs: 0,
        durationMs: 0,
        isPlaying: false,
        currentTrackId: null,
        failLoad: null,
        async load(track, startMs = 0) {
            inner.calls.push(`load:${track.id}`);
            inner.loads.push({ track, startMs });
            if (inner.failLoad) throw inner.failLoad;
            inner.currentTrackId = track.id;
        },
        async preloadNext(track) {
            inner.preloads.push(track);
        },
        play() {
            inner.isPlaying = true;
            inner.calls.push('play');
        },
        pause() {
            inner.isPlaying = false;
            inner.calls.push('pause');
        },
        async seek(ms) {
            inner.calls.push(`seek:${ms}`);
            inner.positionMs = ms;
        },
        stop() {
            inner.isPlaying = false;
            inner.currentTrackId = null;
            inner.calls.push('stop');
        },
        destroy() {
            inner.calls.push('destroy');
        }
    };
    return inner;
}

function setup() {
    const created = { gapless: [], native: [] };
    const events = [];
    const engine = new HybridAudioEngine({
        createGapless: (callbacks) => {
            const inner = makeInner('gapless', callbacks);
            created.gapless.push(inner);
            return inner;
        },
        createNative: (callbacks) => {
            const inner = makeInner('native', callbacks);
            created.native.push(inner);
            return inner;
        },
        onTrackStart: (id) => events.push(['trackStart', id]),
        onEnded: () => events.push(['ended']),
        onError: (id, err) => events.push(['error', id, err.message]),
        onTime: (pos, dur) => events.push(['time', pos, dur])
    });
    return { engine, created, events, gapless: () => created.gapless[0], native: () => created.native[0] };
}

const flac = (id) => ({ id, url: `u/${id}`, kind: 'flac', durationMs: 1000 });
const mp3 = (id) => ({ id, url: `u/${id}`, kind: 'native', durationMs: 1000 });

test('inner engines are created lazily on first use', async () => {
    const { engine, created } = setup();
    assert.equal(created.gapless.length, 0);
    assert.equal(created.native.length, 0);
    await engine.load(flac('a'));
    assert.equal(created.gapless.length, 1);
    assert.equal(created.native.length, 0);
});

test('FLAC to FLAC uses the gapless preload', async () => {
    const { engine, gapless, events } = setup();
    await engine.load(flac('a'));
    engine.play();
    await engine.preloadNext(flac('b'));
    assert.deepEqual(gapless().preloads, [flac('b')]);
    gapless().callbacks.onTrackStart('b');
    assert.deepEqual(events, [['trackStart', 'b']]);
});

test('MP3 to MP3 uses the native preload', async () => {
    const { engine, native, created } = setup();
    await engine.load(mp3('a'));
    await engine.preloadNext(mp3('b'));
    assert.deepEqual(native().preloads, [mp3('b')]);
    assert.equal(created.gapless.length, 0);
});

test('FLAC to MP3 hands over on ended and emits onTrackStart once', async () => {
    const { engine, gapless, native, events } = setup();
    await engine.load(flac('a'));
    engine.play();
    await engine.preloadNext(mp3('b'));
    assert.deepEqual(gapless().preloads, [null]);
    gapless().callbacks.onEnded();
    await flush();
    assert.deepEqual(native().loads, [{ track: mp3('b'), startMs: 0 }]);
    assert.deepEqual(native().calls, ['load:b', 'play']);
    assert.ok(gapless().calls.includes('destroy'));
    assert.deepEqual(events, [['trackStart', 'b']]);
    assert.equal(engine.currentTrackId, 'b');
    assert.equal(engine.isPlaying, true);
});

test('handover keeps a paused engine paused', async () => {
    const { engine, gapless, native } = setup();
    await engine.load(flac('a'));
    engine.play();
    await engine.preloadNext(mp3('b'));
    engine.pause();
    gapless().callbacks.onEnded();
    await flush();
    assert.deepEqual(native().calls, ['load:b']);
});

test('handover load failure reports the next track as started then failed', async () => {
    const { engine, gapless, native, events } = setup();
    await engine.load(mp3('z'));
    native().failLoad = new Error('boom');
    await engine.load(flac('a'));
    engine.play();
    await engine.preloadNext(mp3('b'));
    gapless().callbacks.onEnded();
    await flush();
    assert.deepEqual(events, [
        ['trackStart', 'b'],
        ['error', 'b', 'boom']
    ]);
});

test('ended with nothing pending is forwarded', async () => {
    const { engine, gapless, events } = setup();
    await engine.load(flac('a'));
    await engine.preloadNext(null);
    gapless().callbacks.onEnded();
    assert.deepEqual(events, [['ended']]);
});

test('a new load during a handover supersedes it', async () => {
    const { engine, gapless, native, events } = setup();
    await engine.load(flac('a'));
    engine.play();
    await engine.preloadNext(mp3('b'));
    gapless().callbacks.onEnded();
    await engine.load(flac('c'));
    await flush();
    assert.deepEqual(events, []);
    assert.equal(engine.currentTrackId, 'c');
    assert.ok(native().calls.includes('stop'));
});

test('callbacks from the inactive backend are ignored', async () => {
    const { engine, gapless, native, events } = setup();
    await engine.load(flac('a'));
    await engine.load(mp3('b'));
    gapless().callbacks.onTime(5, 10);
    gapless().callbacks.onEnded();
    gapless().callbacks.onError('a', new Error('late'));
    assert.deepEqual(events, []);
    native().callbacks.onTime(1, 2);
    assert.deepEqual(events, [['time', 1, 2]]);
});

test('switching to native destroys the gapless engine and recreates it lazily', async () => {
    const { engine, created } = setup();
    await engine.load(flac('a'));
    await engine.load(mp3('b'));
    assert.ok(created.gapless[0].calls.includes('destroy'));
    assert.equal(created.gapless.length, 1);
    await engine.load(flac('c'));
    assert.equal(created.gapless.length, 2);
    assert.deepEqual(created.gapless[1].calls, ['load:c']);
});

test('switching to gapless only stops the native backend', async () => {
    const { engine, native, created } = setup();
    await engine.load(mp3('a'));
    await engine.load(flac('b'));
    assert.ok(native().calls.includes('stop'));
    assert.ok(!native().calls.includes('destroy'));
    await engine.load(mp3('c'));
    assert.equal(created.native.length, 1);
});

test('callbacks from a destroyed gapless engine are ignored after it is recreated', async () => {
    const { engine, created, events } = setup();
    await engine.load(flac('a'));
    await engine.load(mp3('b'));
    await engine.load(flac('c'));
    created.gapless[0].callbacks.onTrackStart('zombie');
    created.gapless[0].callbacks.onEnded();
    assert.deepEqual(events, []);
    created.gapless[1].callbacks.onTrackStart('d');
    assert.deepEqual(events, [['trackStart', 'd']]);
});

test('pause, seek and getters delegate to the active backend', async () => {
    const { engine, native } = setup();
    await engine.load(mp3('a'));
    engine.play();
    native().positionMs = 1234;
    native().durationMs = 5000;
    assert.equal(engine.positionMs, 1234);
    assert.equal(engine.durationMs, 5000);
    assert.equal(engine.isPlaying, true);
    assert.equal(engine.currentTrackId, 'a');
    engine.pause();
    await engine.seek(42);
    assert.deepEqual(native().calls, ['load:a', 'play', 'pause', 'seek:42']);
    assert.equal(engine.isPlaying, false);
});

test('getters are empty before any load', () => {
    const { engine } = setup();
    assert.equal(engine.positionMs, 0);
    assert.equal(engine.durationMs, 0);
    assert.equal(engine.isPlaying, false);
    assert.equal(engine.currentTrackId, null);
});

test('stop stops both backends', async () => {
    const { engine, gapless, native } = setup();
    await engine.load(mp3('a'));
    await engine.load(flac('b'));
    gapless().calls.length = 0;
    native().calls.length = 0;
    engine.stop();
    assert.deepEqual(gapless().calls, ['stop']);
    assert.deepEqual(native().calls, ['stop']);
    assert.equal(engine.currentTrackId, null);
});

test('destroy destroys both backends', async () => {
    const { engine, gapless, native } = setup();
    await engine.load(mp3('a'));
    await engine.load(flac('b'));
    engine.destroy();
    assert.ok(gapless().calls.includes('destroy'));
    assert.ok(native().calls.includes('destroy'));
});

test('load failure propagates', async () => {
    const { engine, created } = setup();
    await engine.load(mp3('a'));
    created.native[0].failLoad = new Error('bad');
    await assert.rejects(engine.load(mp3('b')), /bad/);
});
