import { test } from 'node:test';
import assert from 'node:assert/strict';
import MusicSession from '../src/music/MusicSession.js';

const TICKS_PER_MS = 10000;
const flush = () => new Promise((resolve) => globalThis.setImmediate(resolve));

function makeItems(ids) {
    return ids.map((id) => ({ Id: id, Name: `Song ${id}`, RunTimeTicks: 200000 * TICKS_PER_MS }));
}

function makeQueue() {
    const queue = {
        items: [],
        index: -1,
        repeat: 'RepeatNone',
        goBackCalls: 0,
        setQueue(items, activeIndex = 0) {
            queue.items = items;
            queue.index = Math.max(0, Math.min(activeIndex, items.length - 1));
        },
        getCurrentItem: () => (queue.index === -1 ? null : queue.items[queue.index]),
        hasNext: () => queue.items.length > 0 && (queue.repeat === 'RepeatAll' || queue.index < queue.items.length - 1),
        hasPrevious: () => queue.items.length > 0 && (queue.repeat === 'RepeatAll' || queue.index > 0),
        peekNext() {
            if (!queue.hasNext()) return null;
            return queue.items[(queue.index + 1) % queue.items.length];
        },
        peekPrevious() {
            if (!queue.hasPrevious()) return null;
            return queue.items[(queue.index - 1 + queue.items.length) % queue.items.length];
        },
        advance() {
            if (!queue.hasNext()) return null;
            queue.index = (queue.index + 1) % queue.items.length;
            return queue.items[queue.index];
        },
        goBack() {
            queue.goBackCalls++;
            if (!queue.hasPrevious()) return null;
            queue.index = (queue.index - 1 + queue.items.length) % queue.items.length;
            return queue.items[queue.index];
        },
        getRepeatMode: () => queue.repeat,
        getShuffleMode: () => false
    };
    return queue;
}

function makeApi({ failIds = [] } = {}) {
    const api = {
        failIds: new Set(failIds),
        infoCalls: [],
        started: [],
        progress: [],
        stopped: [],
        stoppedResult: () => Promise.resolve(),
        async getPlaybackInfo(itemId) {
            api.infoCalls.push(itemId);
            if (api.failIds.has(itemId)) throw new Error(`no info for ${itemId}`);
            return {
                PlaySessionId: `ps-${itemId}`,
                MediaSources: [{ Id: `ms-${itemId}`, RunTimeTicks: 200000 * TICKS_PER_MS }]
            };
        },
        reportPlaybackStart(info) {
            api.started.push(info);
            return Promise.resolve();
        },
        reportPlaybackProgress(info) {
            api.progress.push(info);
            return Promise.resolve();
        },
        reportPlaybackStopped(info) {
            api.stopped.push(info);
            return api.stoppedResult();
        }
    };
    return api;
}

function makeEngine(callbacks) {
    const engine = {
        callbacks,
        loads: [],
        preloads: [],
        calls: [],
        positionMs: 0,
        durationMs: 200000,
        isPlaying: false,
        currentTrackId: null,
        async load(track, startMs = 0) {
            engine.loads.push({ track, startMs });
            engine.currentTrackId = track.id;
        },
        async preloadNext(track) {
            engine.preloads.push(track);
        },
        play() {
            engine.isPlaying = true;
            engine.calls.push('play');
        },
        pause() {
            engine.isPlaying = false;
            engine.calls.push('pause');
        },
        async seek(ms) {
            engine.calls.push(`seek:${ms}`);
            engine.positionMs = ms;
        },
        stop() {
            engine.isPlaying = false;
            engine.calls.push('stop');
        },
        destroy() {},
        fireTrackStart(id) {
            engine.currentTrackId = id;
            callbacks.onTrackStart(id);
        },
        fireEnded: () => callbacks.onEnded(),
        fireError: (id, err) => callbacks.onError(id, err),
        fireTime: (pos, dur) => callbacks.onTime(pos, dur)
    };
    return engine;
}

function setup({ ids = ['a', 'b', 'c', 'd'], failIds = [], now } = {}) {
    const queue = makeQueue();
    const api = makeApi({ failIds });
    const events = [];
    const bus = {
        emit: (event, payload) => events.push({ event, payload }),
        on: () => () => {}
    };
    const notified = [];
    const timers = { intervals: [], cleared: [] };
    let engine = null;
    const session = new MusicSession({
        engineFactory: (callbacks) => {
            engine = makeEngine(callbacks);
            return engine;
        },
        api,
        queue,
        bus,
        urlFor: (item) => `http://srv/audio/${item.Id}`,
        notify: (name) => notified.push(name),
        now: now || (() => 0),
        setInterval: (fn, ms) => {
            timers.intervals.push({ fn, ms });
            return timers.intervals.length;
        },
        clearInterval: (handle) => timers.cleared.push(handle)
    });
    const items = makeItems(ids);
    return { session, queue, api, events, notified, timers, items, getEngine: () => engine };
}

const eventsOf = (events, name) => events.filter((e) => e.event === name).map((e) => e.payload);

test('playItems loads first and preloads second', async () => {
    const { session, items, getEngine, api } = setup();
    await session.playItems(items, 0);
    await flush();
    const engine = getEngine();
    assert.equal(engine.loads.length, 1);
    assert.deepEqual(engine.loads[0].track, { id: 'a', url: 'http://srv/audio/a', durationMs: 200000 });
    assert.deepEqual(engine.calls, ['play']);
    assert.equal(engine.preloads.length, 1);
    assert.deepEqual(engine.preloads[0], { id: 'b', url: 'http://srv/audio/b', durationMs: 200000 });
    assert.equal(session.isActive, true);
    assert.equal(session.currentItem.Id, 'a');
    assert.deepEqual(api.started[0], {
        ItemId: 'a',
        MediaSourceId: 'ms-a',
        PlaySessionId: 'ps-a',
        PositionTicks: 0,
        IsPaused: false,
        PlayMethod: 'DirectPlay'
    });
});

test('track start emits music:track and reports start + stopped for outgoing', async () => {
    const { session, items, getEngine, api, events, queue } = setup();
    await session.playItems(items, 0);
    await flush();
    const engine = getEngine();
    engine.fireTrackStart('b');
    assert.deepEqual(eventsOf(events, 'music:track').pop(), { item: items[1], index: 1 });
    assert.equal(queue.index, 1);
    assert.equal(api.stopped.length, 1);
    assert.equal(api.stopped[0].ItemId, 'a');
    assert.equal(api.stopped[0].PlaySessionId, 'ps-a');
    assert.equal(api.stopped[0].PositionTicks, 200000 * TICKS_PER_MS);
    assert.equal(api.started.length, 2);
    assert.equal(api.started[1].ItemId, 'b');
    await flush();
    assert.equal(engine.preloads.at(-1).id, 'c');
});

test('queue end stops once and emits music:stopped', async () => {
    const { session, items, getEngine, api, events } = setup({ ids: ['a'] });
    await session.playItems(items, 0);
    await flush();
    assert.equal(getEngine().preloads.at(-1), null);
    getEngine().fireEnded();
    getEngine().fireEnded();
    await flush();
    assert.equal(api.stopped.length, 1);
    assert.deepEqual(eventsOf(events, 'music:stopped'), [{ reason: 'ended' }]);
    assert.equal(session.isActive, false);
});

test('next track prepare failure skips to the one after and notifies', async () => {
    const { session, items, getEngine, notified, queue } = setup({ failIds: ['b'] });
    await session.playItems(items, 0);
    await flush();
    const engine = getEngine();
    assert.deepEqual(notified, ['Song b']);
    assert.equal(engine.preloads.at(-1).id, 'c');
    engine.fireTrackStart('c');
    assert.equal(queue.index, 2);
    assert.equal(session.currentItem.Id, 'c');
});

test('rapid next() calls: only the last target is loaded', async () => {
    const { session, items, getEngine } = setup({ ids: ['a', 'b', 'c', 'd', 'e'] });
    await session.playItems(items, 0);
    await flush();
    const engine = getEngine();
    const before = engine.loads.length;
    const calls = [session.next(), session.next(), session.next()];
    await Promise.all(calls);
    await flush();
    const loaded = engine.loads.slice(before).map((l) => l.track.id);
    assert.deepEqual(loaded, ['d']);
    assert.equal(session.currentItem.Id, 'd');
});

test('previous restarts when past 3s', async () => {
    const { session, items, getEngine, queue } = setup();
    await session.playItems(items, 1);
    await flush();
    const engine = getEngine();
    engine.positionMs = 5000;
    await session.previous();
    assert.ok(engine.calls.includes('seek:0'));
    assert.equal(queue.goBackCalls, 0);
    assert.equal(engine.loads.length, 1);
});

test('previous goes back when within 3s', async () => {
    const { session, items, getEngine, queue } = setup();
    await session.playItems(items, 2);
    await flush();
    const engine = getEngine();
    engine.positionMs = 1000;
    await session.previous();
    assert.equal(queue.goBackCalls, 1);
    assert.equal(engine.loads.at(-1).track.id, 'b');
    assert.equal(session.currentItem.Id, 'b');
});

test('transition does not await reporting', async () => {
    const { session, items, getEngine, api, events } = setup();
    await session.playItems(items, 0);
    await flush();
    api.stoppedResult = () => new Promise(() => {});
    getEngine().fireTrackStart('b');
    assert.equal(eventsOf(events, 'music:track').pop().item.Id, 'b');
    assert.equal(api.stopped.length, 1);
});

test('report failures are logged, not thrown', async () => {
    const warnings = [];
    const { session, items, getEngine, api } = setup();
    session._log.warn = (...args) => warnings.push(args);
    api.stoppedResult = () => Promise.reject(new Error('offline'));
    await session.playItems(items, 0);
    await flush();
    getEngine().fireTrackStart('b');
    await flush();
    assert.equal(warnings.length, 1);
});

test('repeat-one preloads the same track and does not advance the queue', async () => {
    const { session, items, getEngine, queue } = setup();
    queue.repeat = 'RepeatOne';
    await session.playItems(items, 1);
    await flush();
    const engine = getEngine();
    assert.equal(engine.preloads.at(-1).id, 'b');
    engine.fireTrackStart('b');
    assert.equal(queue.index, 1);
    assert.equal(session.currentItem.Id, 'b');
});

test('progress is reported every 10s and on pause/resume', async () => {
    const { session, items, getEngine, api, timers, events } = setup();
    await session.playItems(items, 0);
    await flush();
    const engine = getEngine();
    assert.equal(timers.intervals[0].ms, 10000);
    engine.positionMs = 10000;
    timers.intervals[0].fn();
    assert.equal(api.progress.at(-1).PositionTicks, 10000 * TICKS_PER_MS);
    assert.equal(api.progress.at(-1).IsPaused, false);
    session.togglePlayPause();
    assert.equal(api.progress.at(-1).IsPaused, true);
    assert.deepEqual(eventsOf(events, 'music:state').at(-1), { isPlaying: false });
    session.togglePlayPause();
    assert.equal(api.progress.at(-1).IsPaused, false);
    assert.deepEqual(eventsOf(events, 'music:state').at(-1), { isPlaying: true });
});

test('music:time is throttled to 4 Hz', async () => {
    let clock = 1000;
    const { session, items, getEngine, events } = setup({ now: () => clock });
    await session.playItems(items, 0);
    await flush();
    const engine = getEngine();
    engine.fireTime(0, 200000);
    clock += 100;
    engine.fireTime(100, 200000);
    clock += 150;
    engine.fireTime(250, 200000);
    assert.deepEqual(eventsOf(events, 'music:time'), [
        { positionMs: 0, durationMs: 200000 },
        { positionMs: 250, durationMs: 200000 }
    ]);
});

test('stop reports stopped once, clears the progress timer and is idempotent', async () => {
    const { session, items, getEngine, api, events, timers } = setup();
    await session.playItems(items, 0);
    await flush();
    await session.stop('user');
    await session.stop('user');
    assert.equal(api.stopped.length, 1);
    assert.deepEqual(eventsOf(events, 'music:stopped'), [{ reason: 'user' }]);
    assert.ok(getEngine().calls.includes('stop'));
    assert.equal(timers.cleared.length >= 1, true);
    assert.equal(session.isActive, false);
});
