import { test } from 'node:test';
import assert from 'node:assert/strict';
import NativeAudioBackend from '../src/music/NativeAudioBackend.js';

function makeAudio() {
    const listeners = new Map();
    const el = {
        src: '',
        preload: '',
        currentTime: 0,
        duration: NaN,
        error: null,
        calls: [],
        addEventListener(event, handler) {
            if (!listeners.has(event)) listeners.set(event, new Set());
            listeners.get(event).add(handler);
        },
        removeEventListener(event, handler) {
            listeners.get(event)?.delete(handler);
        },
        listenerCount: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
        fire(event) {
            [...(listeners.get(event) || [])].forEach((handler) => handler());
        },
        removeAttribute(name) {
            el.calls.push(`remove:${name}`);
            if (name === 'src') el.src = '';
        },
        load: () => el.calls.push('load'),
        play() {
            el.calls.push('play');
            return Promise.resolve();
        },
        pause: () => el.calls.push('pause')
    };
    return el;
}

function setup(options = {}) {
    const elements = [];
    const events = [];
    const timers = [];
    const backend = new NativeAudioBackend({
        onTrackStart: (id) => events.push(['trackStart', id]),
        onEnded: () => events.push(['ended']),
        onError: (id, err) => events.push(['error', id, err.message]),
        onTime: (pos, dur) => events.push(['time', pos, dur]),
        createAudio: () => {
            const el = makeAudio();
            elements.push(el);
            return el;
        },
        setInterval: (fn, ms) => {
            timers.push({ fn, ms, cleared: false });
            return timers.length;
        },
        clearInterval: (handle) => {
            timers[handle - 1].cleared = true;
        },
        ...options
    });
    return { backend, elements, events, timers };
}

const track = (id) => ({ id, url: `u/${id}`, kind: 'native', durationMs: 3000 });

async function loaded(backend, elements, t, startMs) {
    const pending = backend.load(t, startMs);
    const el = elements.at(-1);
    el.fire('loadedmetadata');
    el.fire('canplay');
    await pending;
    return el;
}

test('load resolves on canplay and applies the start offset', async () => {
    const { backend, elements } = setup();
    const el = await loaded(backend, elements, track('a'), 1500);
    assert.equal(el.src, 'u/a');
    assert.equal(el.preload, 'auto');
    assert.equal(el.currentTime, 1.5);
    assert.equal(backend.currentTrackId, 'a');
    assert.equal(backend.durationMs, 3000);
});

test('load rejects on a media error before it can play', async () => {
    const { backend, elements } = setup();
    const pending = backend.load(track('a'));
    elements[0].error = { code: 4 };
    elements[0].fire('error');
    await assert.rejects(pending, /code 4/);
});

test('ended swaps to the preloaded element and fires onTrackStart on playing', async () => {
    const { backend, elements, events } = setup();
    const first = await loaded(backend, elements, track('a'));
    backend.play();
    await backend.preloadNext(track('b'));
    const second = elements[1];
    assert.equal(second.src, 'u/b');
    first.fire('ended');
    assert.equal(first.src, '');
    assert.equal(first.listenerCount(), 0);
    assert.ok(second.calls.includes('play'));
    assert.deepEqual(events, []);
    second.fire('playing');
    second.fire('playing');
    assert.deepEqual(events, [['trackStart', 'b']]);
    assert.equal(backend.currentTrackId, 'b');
});

test('without element preload, the next track is not loaded while the current one plays', async () => {
    const { backend, elements } = setup({ preloadNextElement: false });
    await loaded(backend, elements, track('a'));
    backend.play();
    await backend.preloadNext(track('b'));
    assert.equal(elements.length, 1);
});

test('without element preload, ended releases the current element before loading the next', async () => {
    const order = [];
    const { backend, elements, events } = setup({
        preloadNextElement: false,
        createAudio: () => {
            const el = makeAudio();
            const id = `el${elements.length}`;
            let src = '';
            Object.defineProperty(el, 'src', {
                get: () => src,
                set: (value) => {
                    src = value;
                    if (value) order.push(`${id}:src`);
                }
            });
            ['pause', 'load', 'removeAttribute'].forEach((name) => {
                const original = el[name];
                el[name] = (...args) => {
                    order.push(name === 'removeAttribute' ? `${id}:remove:${args[0]}` : `${id}:${name}`);
                    return original(...args);
                };
            });
            elements.push(el);
            order.push(`${id}:created`);
            return el;
        }
    });
    const first = await loaded(backend, elements, track('a'));
    backend.play();
    await backend.preloadNext(track('b'));
    order.length = 0;
    first.fire('ended');
    const second = elements[1];
    const at = (entry) => order.indexOf(entry);
    assert.ok(at('el0:pause') >= 0 && at('el0:remove:src') >= 0);
    const released = Math.max(at('el0:pause'), at('el0:remove:src'));
    assert.ok(released < at('el1:created'), `release must precede next creation: ${order}`);
    assert.ok(released < at('el1:src'), `release must precede next src: ${order}`);
    assert.ok(released < at('el1:load'), `release must precede next load: ${order}`);
    assert.equal(first.src, '');
    assert.equal(first.listenerCount(), 0);
    assert.equal(second.src, 'u/b');
    assert.ok(second.calls.includes('play'));
    second.fire('playing');
    assert.deepEqual(events, [['trackStart', 'b']]);
    assert.equal(backend.currentTrackId, 'b');
});

test('without element preload, a cleared next track ends playback', async () => {
    const { backend, elements, events } = setup({ preloadNextElement: false });
    const el = await loaded(backend, elements, track('a'));
    backend.play();
    await backend.preloadNext(track('b'));
    await backend.preloadNext(null);
    el.fire('ended');
    assert.deepEqual(events, [['ended']]);
});

test('without element preload, an error on the next track reports it', async () => {
    const { backend, elements, events } = setup({ preloadNextElement: false });
    const first = await loaded(backend, elements, track('a'));
    backend.play();
    await backend.preloadNext(track('b'));
    first.fire('ended');
    const second = elements[1];
    second.error = { code: 4 };
    second.fire('error');
    assert.deepEqual(events, [['error', 'b', 'Audio element error (code 4)']]);
});

test('ended with nothing preloaded fires onEnded', async () => {
    const { backend, elements, events } = setup();
    const el = await loaded(backend, elements, track('a'));
    backend.play();
    el.fire('ended');
    assert.deepEqual(events, [['ended']]);
    assert.equal(backend.isPlaying, false);
});

test('replacing the preload releases the old element; never more than two live', async () => {
    const { backend, elements } = setup();
    await loaded(backend, elements, track('a'));
    await backend.preloadNext(track('b'));
    await backend.preloadNext(track('c'));
    assert.equal(elements[1].src, '');
    assert.equal(elements[1].listenerCount(), 0);
    const live = elements.filter((el) => el.src !== '');
    assert.equal(live.length, 2);
    await backend.preloadNext(null);
    assert.equal(elements[2].src, '');
});

test('preload error reports the next track and drops it', async () => {
    const { backend, elements, events } = setup();
    const first = await loaded(backend, elements, track('a'));
    await backend.preloadNext(track('b'));
    elements[1].fire('error');
    assert.deepEqual(events, [['error', 'b', 'Audio element error (code unknown)']]);
    first.fire('ended');
    assert.deepEqual(events.at(-1), ['ended']);
});

test('error on the playing element reports the current track', async () => {
    const { backend, elements, events } = setup();
    const el = await loaded(backend, elements, track('a'));
    el.fire('error');
    assert.deepEqual(events, [['error', 'a', 'Audio element error (code unknown)']]);
});

test('onTime ticks at 4 Hz while playing and stops on pause', async () => {
    const { backend, elements, events, timers } = setup();
    const el = await loaded(backend, elements, track('a'));
    backend.play();
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, 250);
    el.currentTime = 2;
    timers[0].fn();
    assert.deepEqual(events, [['time', 2000, 3000]]);
    backend.pause();
    assert.equal(timers[0].cleared, true);
    assert.ok(el.calls.includes('pause'));
});

test('seek sets currentTime', async () => {
    const { backend, elements } = setup();
    const el = await loaded(backend, elements, track('a'));
    await backend.seek(2500);
    assert.equal(el.currentTime, 2.5);
});

test('stop releases both elements and a superseded load resolves', async () => {
    const { backend, elements } = setup();
    const pending = backend.load(track('a'));
    backend.stop();
    await pending;
    assert.equal(elements[0].src, '');
    assert.equal(elements[0].listenerCount(), 0);
    assert.equal(backend.currentTrackId, null);
    assert.equal(backend.positionMs, 0);
});
