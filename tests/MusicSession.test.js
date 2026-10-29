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
        getCurrentIndex: () => queue.index,
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

function makeApi({ failIds = [], flacIds = [] } = {}) {
    const api = {
        failIds: new Set(failIds),
        flacIds: new Set(flacIds),
        infoCalls: [],
        started: [],
        progress: [],
        stopped: [],
        held: new Map(),
        hold(id) {
            let release;
            api.held.set(
                id,
                new Promise((resolve) => {
                    release = resolve;
                })
            );
            return release;
        },
        stoppedResult: () => Promise.resolve(),
        async getPlaybackInfo(itemId) {
            api.infoCalls.push(itemId);
            if (api.held.has(itemId)) await api.held.get(itemId);
            if (api.failIds.has(itemId)) throw new Error(`no info for ${itemId}`);
            return {
                PlaySessionId: `ps-${itemId}`,
                MediaSources: [
                    {
                        Id: `ms-${itemId}`,
                        Container: api.flacIds.has(itemId) ? 'flac' : 'mp3',
                        RunTimeTicks: 200000 * TICKS_PER_MS
                    }
                ]
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

const defaultDescribe = (item, mediaSource) => ({
    url: `http://srv/audio/${item.Id}`,
    kind: mediaSource.Container === 'flac' ? 'flac' : 'native',
    ...(mediaSource.Mime ? { mime: mediaSource.Mime } : {})
});

function setup({ ids = ['a', 'b', 'c', 'd'], failIds = [], flacIds = [], now, describeTrack = defaultDescribe } = {}) {
    const queue = makeQueue();
    const api = makeApi({ failIds, flacIds });
    const events = [];
    const bus = {
        emit: (event, payload) => events.push({ event, payload }),
        on: () => () => {}
    };
    const notified = [];
    const warnings = [];
    const log = { warn: (...args) => warnings.push(args) };
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
        describeTrack,
        notify: (name) => notified.push(name),
        log,
        now: now || (() => 0),
        setInterval: (fn, ms) => {
            timers.intervals.push({ fn, ms });
            return timers.intervals.length;
        },
        clearInterval: (handle) => timers.cleared.push(handle)
    });
    const items = makeItems(ids);
    return { session, queue, api, events, notified, warnings, timers, items, getEngine: () => engine };
}

const eventsOf = (events, name) => events.filter((e) => e.event === name).map((e) => e.payload);

test('the descriptor mime reaches the engine track', async () => {
    const { session, items, getEngine, api } = setup();
    api.getPlaybackInfo = async () => ({
        PlaySessionId: 'ps',
        MediaSources: [{ Id: 'ms', Container: 'm4a', Mime: 'audio/mp4; codecs="ec-3"', RunTimeTicks: 2000000000 }]
    });
    await session.playItems(items, 0);
    await flush();
    assert.equal(getEngine().loads[0].track.mime, 'audio/mp4; codecs="ec-3"');
});

test('playItems loads first and preloads second', async () => {
    const { session, items, getEngine, api } = setup();
    await session.playItems(items, 0);
    await flush();
    const engine = getEngine();
    assert.equal(engine.loads.length, 1);
    assert.deepEqual(engine.loads[0].track, { id: 'a', url: 'http://srv/audio/a', kind: 'native', durationMs: 200000 });
    assert.deepEqual(engine.calls, ['play']);
    assert.equal(engine.preloads.length, 1);
    assert.deepEqual(engine.preloads[0], { id: 'b', url: 'http://srv/audio/b', kind: 'native', durationMs: 200000 });
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

test('engine tracks carry the kind described for their media source', async () => {
    const { session, items, getEngine } = setup({ flacIds: ['a'] });
    await session.playItems(items, 0);
    await flush();
    const engine = getEngine();
    assert.equal(engine.loads[0].track.kind, 'flac');
    assert.equal(engine.preloads[0].kind, 'native');
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
    const { session, items, getEngine, notified, queue, events } = setup({ failIds: ['b'] });
    await session.playItems(items, 0);
    await flush();
    const engine = getEngine();
    assert.deepEqual(notified, ['Song b']);
    assert.equal(engine.preloads.at(-1).id, 'c');
    engine.fireTrackStart('c');
    assert.equal(queue.index, 2);
    assert.equal(session.currentItem.Id, 'c');
    assert.deepEqual(eventsOf(events, 'music:track').pop(), { item: items[2], index: 2 });
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
    const { session, items, getEngine, api, warnings } = setup();
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

test('ended with nothing preloaded but a next track continues with next()', async () => {
    const { session, items, getEngine, api, events } = setup({ ids: ['a', 'b', 'c'] });
    const release = api.hold('b');
    await session.playItems(items, 0);
    await flush();
    const engine = getEngine();
    assert.equal(engine.preloads.length, 0);
    engine.fireEnded();
    release();
    await flush();
    assert.equal(engine.loads.at(-1).track.id, 'b');
    assert.equal(session.isActive, true);
    assert.equal(eventsOf(events, 'music:stopped').length, 0);
});

test('every candidate failing stops once with error', async () => {
    const { session, items, getEngine, events, notified } = setup({ ids: ['a', 'b'], failIds: ['a', 'b'] });
    await session.playItems(items, 0);
    await flush();
    assert.deepEqual(eventsOf(events, 'music:stopped'), [{ reason: 'error' }]);
    assert.deepEqual(notified, ['Song a', 'Song b']);
    assert.ok(getEngine().calls.includes('stop'));
    assert.equal(session.isActive, false);
});

test('playItems with no items stops with empty', async () => {
    const { session, getEngine, events } = setup();
    await session.playItems([], 0);
    assert.deepEqual(eventsOf(events, 'music:stopped'), [{ reason: 'empty' }]);
    assert.ok(getEngine().calls.includes('stop'));
});

test('stop during the first load discards the load', async () => {
    const { session, items, getEngine, api, events } = setup();
    const release = api.hold('a');
    const starting = session.playItems(items, 0);
    await flush();
    await session.stop('user');
    release();
    await starting;
    await flush();
    assert.deepEqual(eventsOf(events, 'music:stopped'), [{ reason: 'user' }]);
    assert.equal(getEngine().loads.length, 0);
    assert.equal(session.isActive, false);
});

test('a prefetch finishing after a transition is discarded', async () => {
    const { session, items, getEngine, api } = setup({ ids: ['a', 'b', 'c'] });
    const release = api.hold('b');
    await session.playItems(items, 0);
    await flush();
    await session.playItems(items, 2);
    release();
    await flush();
    assert.equal(
        getEngine().preloads.some((track) => track && track.id === 'b'),
        false
    );
});

test('engine error on the current track notifies and moves on', async () => {
    const { session, items, getEngine, notified } = setup();
    await session.playItems(items, 0);
    await flush();
    getEngine().fireError('a', new Error('decode'));
    await flush();
    assert.deepEqual(notified, ['Song a']);
    assert.equal(getEngine().loads.at(-1).track.id, 'b');
});

test('engine error on the preloaded track skips to the one after', async () => {
    const { session, items, getEngine, notified } = setup();
    await session.playItems(items, 0);
    await flush();
    const engine = getEngine();
    engine.fireError('b', new Error('decode'));
    await flush();
    assert.deepEqual(notified, ['Song b']);
    assert.equal(engine.preloads.at(-1).id, 'c');
});

test('RepeatAll wraps to the first track', async () => {
    const { session, items, getEngine, queue, events } = setup({ ids: ['a', 'b'] });
    queue.repeat = 'RepeatAll';
    await session.playItems(items, 1);
    await flush();
    const engine = getEngine();
    assert.equal(engine.preloads.at(-1).id, 'a');
    engine.fireTrackStart('a');
    assert.deepEqual(eventsOf(events, 'music:track').pop(), { item: items[0], index: 0 });
});

test('previous after a prefetch skip goes back from the playing track', async () => {
    const { session, items, getEngine, queue } = setup({ failIds: ['c'] });
    await session.playItems(items, 1);
    await flush();
    assert.equal(queue.index, 2);
    getEngine().positionMs = 500;
    await session.previous();
    assert.equal(queue.index, 0);
    assert.equal(getEngine().loads.at(-1).track.id, 'a');
});

test('unexpected track start is logged and ignored', async () => {
    const { session, items, getEngine, warnings, queue } = setup();
    await session.playItems(items, 0);
    await flush();
    getEngine().fireTrackStart('zzz');
    assert.equal(warnings.length, 1);
    assert.equal(queue.index, 0);
});

function routedSetup() {
    const output = { value: 'tv_speaker' };
    const described = [];
    const h = setup({
        flacIds: ['a', 'b', 'c', 'd'],
        describeTrack: (item, mediaSource, playSessionId) => {
            described.push({ id: item.Id, playSessionId });
            const kind = output.value === 'tv_speaker' ? 'flac' : 'mse';
            return { url: `http://srv/${kind}/${item.Id}`, kind };
        }
    });
    return { ...h, output, described };
}

test('I3: an output change that reroutes the current track reloads it at its position and re-preloads the next', async () => {
    const h = routedSetup();
    await h.session.playItems(h.items, 0);
    await flush();
    const engine = h.getEngine();
    engine.positionMs = 42000;
    const infoCallsBefore = h.api.infoCalls.length;

    h.output.value = 'external_arc';
    await h.session.reroute();
    await flush();

    assert.equal(engine.loads.length, 2);
    assert.deepEqual(engine.loads[1], {
        track: { id: 'a', url: 'http://srv/mse/a', kind: 'mse', durationMs: 200000 },
        startMs: 42000
    });
    assert.equal(engine.isPlaying, true);
    assert.equal(engine.calls.filter((c) => c === 'play').length, 2);
    assert.deepEqual(h.api.infoCalls.slice(infoCallsBefore), ['b']);
    assert.equal(engine.preloads.at(-1).kind, 'mse');
    assert.equal(engine.preloads.at(-1).id, 'b');
    assert.equal(h.api.stopped.length, 0);
    assert.equal(h.api.started.length, 1);

    engine.fireTrackStart('b');
    assert.equal(h.session.currentItem.Id, 'b');
});

test('I3: a paused track stays paused after the reroute', async () => {
    const h = routedSetup();
    await h.session.playItems(h.items, 0);
    await flush();
    h.session.pause();

    h.output.value = 'external_arc';
    await h.session.reroute();

    const engine = h.getEngine();
    assert.equal(engine.loads.length, 2);
    assert.equal(engine.isPlaying, false);
    assert.equal(engine.calls.filter((c) => c === 'play').length, 1);
});

test('I3: an output change that keeps the current route reloads nothing', async () => {
    const h = routedSetup();
    h.output.value = 'external_arc';
    await h.session.playItems(h.items, 0);
    await flush();
    const engine = h.getEngine();
    const preloads = engine.preloads.length;

    h.output.value = 'bt_soundbar';
    await h.session.reroute();
    await flush();

    assert.equal(engine.loads.length, 1);
    assert.equal(engine.preloads.length, preloads);
});

test('I3: a reroute while idle does nothing', async () => {
    const h = routedSetup();
    await h.session.reroute();
    assert.equal(h.getEngine(), null);
});

test('I3: a reroute whose reload fails skips the track like an engine error', async () => {
    const h = routedSetup();
    await h.session.playItems(h.items, 0);
    await flush();
    const engine = h.getEngine();
    engine.load = async (track) => {
        engine.loads.push({ track });
        if (track.id === 'a') throw new Error('MSE unavailable');
    };

    h.output.value = 'external_arc';
    await h.session.reroute();
    await flush();

    assert.deepEqual(h.notified, ['Song a']);
    assert.equal(h.session.currentItem.Id, 'b');
});
