import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * ============================================================================
 * PlayQueue Late Window Expansion Test Suite
 * ============================================================================
 * A series queue holds a window of episodes and loads more when the cursor
 * nears either end. When the queue was replaced while those episodes loaded
 * (a remote control's queue update, the next item's init()), they were added
 * to the new queue and the cursor moved. They are now dropped, and the old
 * request no longer clears the loading flag of the new queue's request.
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

const flush = async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};

const seriesEpisodes = (seriesId) =>
    Array.from({ length: 200 }, (_, i) => ({ Id: `${seriesId}-ep${i + 1}`, SeriesId: seriesId, Type: 'Episode' }));

/**
 * api.getEpisodes answering the manifest and each series' first window at
 * once, and holding every later window (the expansions) until the test answers
 */
function slowExpansions(t) {
    const expansions = [];
    const windowsServed = new Set();
    t.mock.method(api, 'getEpisodes', (seriesId, params = {}) => {
        const episodes = seriesEpisodes(seriesId);
        if (params.StartIndex === undefined) return Promise.resolve({ Items: episodes });
        const items = episodes.slice(params.StartIndex, params.StartIndex + params.Limit);
        if (!windowsServed.has(seriesId)) {
            windowsServed.add(seriesId);
            return Promise.resolve({ Items: items });
        }
        return new Promise((resolve) => expansions.push({ seriesId, answer: () => resolve({ Items: items }) }));
    });
    return expansions;
}

test('PlayQueue: episodes loaded after the queue was replaced are not added to the new queue', async (t) => {
    const expansions = slowExpansions(t);
    await playQueue.init(seriesEpisodes('show')[0]);

    // Playing towards the end of the loaded window loads the next episodes
    playQueue._currentIndex = playQueue.getQueue().length - 2;
    playQueue.getCurrentItem();
    assert.strictEqual(expansions.length, 1, 'no expansion requested');

    // A remote control replaces the queue (PlayerPage._handleRemoteQueueUpdate -> setQueue)
    playQueue.setQueue([{ Id: 'movieA' }, { Id: 'movieB' }], 0);

    expansions[0].answer();
    await flush();
    assert.deepStrictEqual(
        playQueue.getQueue().map((i) => i.Id),
        ['movieA', 'movieB'],
        'the old series was appended to the new queue'
    );
});

test('PlayQueue: earlier episodes loaded after the queue was replaced do not move the cursor', async (t) => {
    const expansions = slowExpansions(t);
    await playQueue.init(seriesEpisodes('show')[199]);

    // Going back towards the start of the loaded window loads the episodes before it
    playQueue._currentIndex = 3;
    playQueue.getCurrentItem();
    assert.strictEqual(expansions.length, 1, 'no expansion requested');

    playQueue.setQueue([{ Id: 'movieA' }, { Id: 'movieB' }], 1);

    expansions[0].answer();
    await flush();
    assert.deepStrictEqual(
        playQueue.getQueue().map((i) => i.Id),
        ['movieA', 'movieB']
    );
    assert.strictEqual(playQueue.getCurrentIndex(), 1, 'the cursor of the new queue moved');
    assert.strictEqual(playQueue.getCurrentItem().Id, 'movieB');
});

test("PlayQueue: a late expansion of the old queue does not clear the new queue's loading flag", async (t) => {
    const expansions = slowExpansions(t);
    await playQueue.init(seriesEpisodes('old')[0]);
    playQueue._currentIndex = playQueue.getQueue().length - 2;
    playQueue.getCurrentItem();

    // The next item belongs to another series: its queue loads more episodes as well
    await playQueue.init(seriesEpisodes('new')[0]);
    playQueue._currentIndex = playQueue.getQueue().length - 2;
    playQueue.getCurrentItem();
    assert.deepStrictEqual(
        expansions.map((e) => e.seriesId),
        ['old', 'new']
    );

    expansions[0].answer();
    await flush();
    playQueue.getCurrentItem();
    assert.deepStrictEqual(
        expansions.map((e) => e.seriesId),
        ['old', 'new'],
        'the same episodes were requested twice'
    );

    expansions[1].answer();
    await flush();
    assert.ok(playQueue.getQueue().every((i) => i.SeriesId === 'new'));
    assert.strictEqual(playQueue.getQueue().length, 101);
});
