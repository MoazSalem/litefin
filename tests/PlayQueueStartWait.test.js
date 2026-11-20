import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * ============================================================================
 * PlayQueue Start Wait Test Suite
 * ============================================================================
 * Playback starts after PlayQueue.init(). A stalled server held the start
 * for ApiClient's 30 s timeout per queue request (two for an episode), so
 * init() now waits at most 2 s, starts with the item alone and puts the full
 * queue in place when it arrives. A build that finishes after a newer init()
 * is dropped instead of overwriting the newer queue.
 * ============================================================================
 */

const storageMap = new Map();
globalThis.localStorage = {
    getItem: (key) => storageMap.get(key) || null,
    setItem: (key, val) => storageMap.set(key, String(val)),
    removeItem: (key) => storageMap.delete(key),
    clear: () => storageMap.clear()
};
globalThis.document = {
    createElement: () => ({ canPlayType: () => '' }),
    addEventListener: () => {},
    removeEventListener: () => {},
    documentElement: { setAttribute: () => {}, style: {} },
    body: { appendChild: () => {}, style: {} }
};
globalThis.window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    localStorage: globalThis.localStorage
};
globalThis.__APP_VERSION__ = '1.0.0';

const { playQueue } = await import('../src/core/PlayQueue.js');
const { api } = await import('../src/api/index.js');
const { eventBus } = await import('../src/core/EventBus.js');

const flush = async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};

function deferred() {
    let resolve;
    const promise = new Promise((res) => (resolve = res));
    return { promise, resolve };
}

const episodes = Array.from({ length: 16 }, (_, i) => ({ Id: `ep${i + 1}`, SeriesId: 'show', Type: 'Episode', IndexNumber: i + 1 }));

/** api.getEpisodes answering only when the test says so */
function stalledEpisodes(t) {
    const pending = [];
    t.mock.method(api, 'getEpisodes', (seriesId, params = {}) => {
        const answer = deferred();
        pending.push({ params, answer });
        return answer.promise;
    });
    return {
        pending,
        async answerAll() {
            while (pending.length) {
                const { params, answer } = pending.shift();
                const items = params.StartIndex === undefined ? episodes : episodes.slice(params.StartIndex, params.StartIndex + params.Limit);
                answer.resolve({ Items: items.map((e) => ({ ...e })) });
                await flush();
            }
        }
    };
}

function queueUpdates(t) {
    const updates = [];
    const onUpdate = (data) => updates.push(data);
    eventBus.on('playqueue:updated', onUpdate);
    t.after(() => eventBus.off('playqueue:updated', onUpdate));
    return updates;
}

test('PlayQueue: a stalled server does not hold playback start for the episode queue', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const server = stalledEpisodes(t);
    const updates = queueUpdates(t);
    const item = { ...episodes[4] };

    let ready = false;
    const init = playQueue.init(item).then(() => (ready = true));
    await flush();
    t.mock.timers.tick(2000);
    await init;
    assert.ok(ready);
    assert.deepStrictEqual(playQueue.getQueue().map((i) => i.Id), ['ep5'], 'playback waits on the queue requests');
    assert.strictEqual(playQueue.getCurrentItem().Id, 'ep5');

    // The server answers later: the full queue is put in place around the current item
    await server.answerAll();
    await server.answerAll();
    assert.strictEqual(playQueue.getQueue().length, 16);
    assert.strictEqual(playQueue.getCurrentItem(), item, 'the playing item instance (with PlayerPage\'s details) was replaced');
    assert.strictEqual(playQueue.getQueue()[4], item);
    assert.strictEqual(updates.length, 1, 'the OSD queue is not told about the full queue');
});

test('PlayQueue: a queue build that finishes after a newer init() is dropped', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const server = stalledEpisodes(t);

    const first = playQueue.init({ ...episodes[0] });
    await flush();
    t.mock.timers.tick(2000);
    await first;
    const stale = server.pending.splice(0);

    // A movie starts next; its queue is ready at once
    t.mock.method(api, 'getAdditionalParts', async () => ({ Items: [] }));
    await playQueue.init({ Id: 'movie', Type: 'Movie' });
    assert.deepStrictEqual(playQueue.getQueue().map((i) => i.Id), ['movie']);

    // The episode request of the first item answers late
    stale.forEach(({ answer }) => answer.resolve({ Items: episodes.map((e) => ({ ...e })) }));
    await flush();
    await server.answerAll();
    assert.deepStrictEqual(playQueue.getQueue().map((i) => i.Id), ['movie'], 'an earlier item\'s queue replaced the current one');
});

test('PlayQueue: additional parts that arrive late are added after the playing part', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const parts = deferred();
    t.mock.method(api, 'getAdditionalParts', () => parts.promise);
    const updates = queueUpdates(t);

    const init = playQueue.init({ Id: 'movie-part1', Type: 'Movie' });
    await flush();
    t.mock.timers.tick(2000);
    await init;
    assert.deepStrictEqual(playQueue.getQueue().map((i) => i.Id), ['movie-part1']);

    parts.resolve({ Items: [{ Id: 'movie-part2', Type: 'Movie' }] });
    await flush();
    assert.deepStrictEqual(playQueue.getQueue().map((i) => i.Id), ['movie-part1', 'movie-part2']);
    assert.strictEqual(playQueue.getCurrentItem().Id, 'movie-part1');
    assert.strictEqual(updates.length, 1);
});

test('PlayQueue: with a responsive server the full queue is ready when init() returns', async (t) => {
    const server = stalledEpisodes(t);
    const init = playQueue.init({ ...episodes[2] });
    await flush();
    await server.answerAll();
    await server.answerAll();
    await init;
    assert.strictEqual(playQueue.getQueue().length, 16);
    assert.strictEqual(playQueue.getCurrentItem().Id, 'ep3');
});
