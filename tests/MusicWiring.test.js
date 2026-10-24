import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wireMusicSession, startMusicPlayback } from '../src/music/musicWiring.js';

const flush = () => new Promise((resolve) => globalThis.setImmediate(resolve));

function makeBus() {
    const handlers = new Map();
    const emitted = [];
    return {
        emitted,
        on(event, handler) {
            if (!handlers.has(event)) handlers.set(event, new Set());
            handlers.get(event).add(handler);
            return () => handlers.get(event).delete(handler);
        },
        emit(event, payload) {
            emitted.push({ event, payload });
            [...(handlers.get(event) || [])].forEach((handler) => handler(payload));
        },
        count: (event) => (handlers.get(event) ? handlers.get(event).size : 0),
        of: (event) => emitted.filter((e) => e.event === event).map((e) => e.payload)
    };
}

function makeSession() {
    const calls = [];
    return {
        calls,
        isActive: false,
        currentItem: null,
        resume: () => calls.push('resume'),
        pause: () => calls.push('pause'),
        togglePlayPause: () => calls.push('toggle'),
        next: async () => calls.push('next'),
        previous: async () => calls.push('previous'),
        stop: async (reason) => calls.push(`stop:${reason}`)
    };
}

function makeState() {
    const values = new Map();
    return { values, set: (key, value) => values.set(key, value), get: (key) => values.get(key) };
}

function wired() {
    const bus = makeBus();
    const session = makeSession();
    const state = makeState();
    const unwire = wireMusicSession({ session, bus, state });
    return { bus, session, state, unwire };
}

const song = { Id: 's1', Name: 'Song 1' };
const MEDIA_KEYS = ['key:play', 'key:pause', 'key:playPause', 'key:next', 'key:previous', 'key:stop'];

test('track start mirrors the current item id into state', () => {
    const { bus, state } = wired();
    bus.emit('music:track', { item: song, index: 0 });
    assert.equal(state.get('music:currentItemId'), 's1');
    bus.emit('music:stopped', { reason: 'ended' });
    assert.equal(state.get('music:currentItemId'), null);
});

test('media keys are bound only while music is active', async () => {
    const { bus, session } = wired();
    MEDIA_KEYS.forEach((key) => assert.equal(bus.count(key), 0));
    bus.emit('music:track', { item: song, index: 0 });
    bus.emit('music:track', { item: song, index: 0 });
    MEDIA_KEYS.forEach((key) => assert.equal(bus.count(key), 1));
    MEDIA_KEYS.forEach((key) => bus.emit(key));
    await flush();
    assert.deepEqual(session.calls, ['resume', 'pause', 'toggle', 'next', 'previous', 'stop:user']);
    bus.emit('music:stopped', { reason: 'user' });
    MEDIA_KEYS.forEach((key) => assert.equal(bus.count(key), 0));
});

test('navigating anywhere but now-playing stops the music', async () => {
    const { bus, session } = wired();
    bus.emit('music:track', { item: song, index: 0 });
    bus.emit('router:navigate', { path: '/now-playing' });
    bus.emit('router:navigate', { path: '/now-playing?x=1' });
    await flush();
    assert.deepEqual(session.calls, []);
    bus.emit('router:navigate', { path: '/details/alb' });
    await flush();
    assert.deepEqual(session.calls, ['stop:left-now-playing']);
});

test('navigation is ignored when music is not active', async () => {
    const { bus, session } = wired();
    bus.emit('router:navigate', { path: '/home' });
    bus.emit('music:track', { item: song, index: 0 });
    bus.emit('music:stopped', { reason: 'ended' });
    bus.emit('router:navigate', { path: '/home' });
    await flush();
    assert.deepEqual(session.calls, []);
});

test('stopping music releases the playback hold with player:stopped', () => {
    const { bus } = wired();
    bus.emit('music:track', { item: song, index: 0 });
    bus.emit('music:stopped', { reason: 'left-now-playing' });
    assert.deepEqual(bus.of('player:stopped'), [{ itemId: 's1', reason: 'left-now-playing' }]);
});

test('stopping music for a video does not release the video hold', () => {
    const { bus, state } = wired();
    bus.emit('music:track', { item: song, index: 0 });
    bus.emit('music:stopped', { reason: 'video' });
    assert.deepEqual(bus.of('player:stopped'), []);
    assert.equal(state.get('music:currentItemId'), null);
    assert.equal(bus.count('key:play'), 0);
});

test('play state maps to player:playing and player:paused while active', () => {
    const { bus } = wired();
    bus.emit('music:state', { isPlaying: true });
    assert.deepEqual(bus.of('player:playing'), []);
    bus.emit('music:track', { item: song, index: 0 });
    bus.emit('music:state', { isPlaying: true });
    bus.emit('music:state', { isPlaying: false });
    assert.deepEqual(bus.of('player:playing'), [{ item: song }]);
    assert.deepEqual(bus.of('player:paused'), [{ item: song }]);
});

test('unwire removes every listener', () => {
    const { bus, unwire } = wired();
    bus.emit('music:track', { item: song, index: 0 });
    unwire();
    ['music:track', 'music:state', 'music:stopped', 'router:navigate', ...MEDIA_KEYS].forEach((event) =>
        assert.equal(bus.count(event), 0, event)
    );
});

function starter({
    tracks = [song],
    startIndex = 0,
    resolveError = null,
    active = true,
    pathAfter = '/details/alb'
} = {}) {
    const bus = makeBus();
    const session = makeSession();
    const log = [];
    const notified = [];
    const navigated = [];
    const queue = { shuffle: [], setShuffleMode: (value) => queue.shuffle.push(value) };
    let path = '/details/alb';
    session.playItems = async (items, index) => {
        session.calls.push(['playItems', items.map((t) => t.Id), index]);
        session.isActive = active;
        path = pathAfter;
    };
    const deps = {
        session,
        bus,
        queue,
        resolve: async () => {
            if (resolveError) throw resolveError;
            return { tracks, startIndex };
        },
        getCurrentPath: () => path,
        navigate: (target) => navigated.push(target),
        notifyNothingPlayable: () => notified.push('nothing'),
        log: { warn: (...args) => log.push(['warn', ...args]), error: (...args) => log.push(['error', ...args]) },
        nowPlayingPath: '/now-playing'
    };
    return { deps, bus, session, notified, navigated, queue, log };
}

const albumRequest = { item: { Id: 'alb', Type: 'MusicAlbum' }, shuffle: true };

test('start plays the resolved queue with shuffle and opens now-playing', async () => {
    const { deps, session, navigated, queue, bus } = starter({ tracks: [song, { Id: 's2' }], startIndex: 1 });
    await startMusicPlayback(albumRequest, deps);
    assert.deepEqual(queue.shuffle, [true]);
    assert.deepEqual(session.calls, [['playItems', ['s1', 's2'], 1]]);
    assert.deepEqual(navigated, ['/now-playing']);
    assert.deepEqual(bus.of('player:stopped'), []);
});

test('start with nothing playable releases the hold and notifies', async () => {
    const { deps, session, navigated, notified, bus } = starter({ tracks: [] });
    await startMusicPlayback(albumRequest, deps);
    assert.deepEqual(session.calls, []);
    assert.deepEqual(navigated, []);
    assert.deepEqual(notified, ['nothing']);
    assert.deepEqual(bus.of('player:stopped'), [{ itemId: 'alb', reason: 'empty' }]);
});

test('start failure releases the hold and notifies', async () => {
    const { deps, navigated, notified, bus, log } = starter({ resolveError: new Error('offline') });
    await startMusicPlayback(albumRequest, deps);
    assert.deepEqual(navigated, []);
    assert.deepEqual(notified, ['nothing']);
    assert.deepEqual(bus.of('player:stopped'), [{ itemId: 'alb', reason: 'error' }]);
    assert.equal(log[0][0], 'error');
});

test('start does not navigate when every track failed', async () => {
    const { deps, navigated } = starter({ active: false });
    await startMusicPlayback(albumRequest, deps);
    assert.deepEqual(navigated, []);
});

test('start stops instead of navigating when the user left during loading', async () => {
    const { deps, navigated, session } = starter({ pathAfter: '/home' });
    await startMusicPlayback(albumRequest, deps);
    assert.deepEqual(navigated, []);
    assert.equal(session.calls.at(-1), 'stop:left-now-playing');
});
