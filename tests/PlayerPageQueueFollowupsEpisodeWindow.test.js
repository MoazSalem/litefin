import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * ============================================================================
 * PlayQueue Episode Window With Inserted Items Test Suite
 * ============================================================================
 * A series queue holds a window of episodes and loads the next ones from the
 * series index after its end. That end was taken as window start + queue
 * length, so every item inserted into the queue (a Local Intros pre-roll,
 * "play next") moved the next window one episode on: an episode was skipped,
 * and at the end of the series the last one was never loaded.
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

/** api.getEpisodes for a series of `count` episodes; records the windows requested */
function series(t, count) {
    const episodes = Array.from({ length: count }, (_, i) => ({ Id: `ep${i + 1}`, SeriesId: 'show', Type: 'Episode' }));
    const windows = [];
    t.mock.method(api, 'getEpisodes', async (seriesId, params = {}) => {
        if (params.StartIndex === undefined) return { Items: episodes.map((e) => ({ ...e })) };
        windows.push([params.StartIndex, params.Limit]);
        return { Items: episodes.slice(params.StartIndex, params.StartIndex + params.Limit).map((e) => ({ ...e })) };
    });
    return { episodes, windows };
}

const intro = () => ({ Id: 'intro', Type: 'Video', isIntro: true });
const ids = () => playQueue.getQueue().map((i) => i.Id);

test('PlayQueue: an intro added to a series queue does not make the next window skip an episode', async (t) => {
    const { episodes, windows } = series(t, 200);
    await playQueue.init({ ...episodes[0] });
    assert.deepStrictEqual(windows, [[0, 51]]);

    // PlayerPage -> pluginManager.prepareItemPlayback -> Local Intros
    playQueue.injectPreRoll([intro()]);

    // Playing towards the end of the loaded window loads the next episodes
    playQueue._currentIndex = playQueue.getQueue().length - 2;
    playQueue.getCurrentItem();
    await flush();

    assert.deepStrictEqual(windows[1], [51, 50], 'the next window starts one episode too far');
    const queue = ids();
    assert.strictEqual(queue[queue.indexOf('ep51') + 1], 'ep52');
});

test('PlayQueue: the last episode of the series is still reached when an intro was added', async (t) => {
    const { episodes, windows } = series(t, 52);
    await playQueue.init({ ...episodes[0] });
    playQueue.injectPreRoll([intro()]);

    playQueue._currentIndex = ids().indexOf('ep51');
    assert.ok(playQueue.hasNext(), 'the series ends one episode early');
    playQueue.getCurrentItem();
    await flush();

    assert.deepStrictEqual(windows, [
        [0, 51],
        [51, 1]
    ]);
    assert.strictEqual(playQueue.advance()?.Id, 'ep52');
});
