import assert from 'node:assert/strict';
import test from 'node:test';

// clear() keeps _shuffleMode, so App.js resets it on every player:play that is not a shuffle play

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

const { readFile } = await import('node:fs/promises');
const { playQueue } = await import('../src/core/PlayQueue.js');
const { api } = await import('../src/api/index.js');

const episodes = Array.from({ length: 30 }, (_, i) => ({
    Id: `ep${i + 1}`,
    SeriesId: 'show',
    Type: 'Episode',
    ParentIndexNumber: Math.floor(i / 10) + 1,
    IndexNumber: (i % 10) + 1
}));

function mockEpisodes(t) {
    t.mock.method(api, 'getEpisodes', async (seriesId, params = {}) => {
        const start = params.StartIndex || 0;
        const items = params.Limit ? episodes.slice(start, start + params.Limit) : episodes.slice(start);
        return { Items: items.map((e) => ({ ...e })) };
    });
    t.mock.method(api, 'getItems', async (params = {}) => {
        const ids = String(params.Ids || '').split(',');
        return { Items: episodes.filter((e) => ids.includes(e.Id)).map((e) => ({ ...e })) };
    });
}

test.afterEach(() => {
    playQueue.setShuffleMode(false);
    playQueue.clear();
});

test('PlayQueue: shuffle survives clear() and shuffles the next series until it is reset', async (t) => {
    mockEpisodes(t);
    playQueue.setShuffleMode(true);
    await playQueue.init({ ...episodes[2] });
    const ids = playQueue.getQueue().map((i) => i.Id);
    assert.strictEqual(ids[0], 'ep3');
    assert.strictEqual(ids.length, 30);
    assert.notDeepStrictEqual(
        ids,
        episodes
            .map((e) => e.Id)
            .slice(2)
            .concat(episodes.slice(0, 2).map((e) => e.Id))
    );
    assert.ok(playQueue.getShuffleMode(), 'clear() must keep shuffle between queues');
});

test('PlayQueue: setShuffleMode(false) before init() gives the sequential episode order', async (t) => {
    mockEpisodes(t);
    playQueue.setShuffleMode(true);
    await playQueue.init({ ...episodes[0] });

    // Normal Play on another series: App.js resets shuffle, then PlayerPage calls init()
    playQueue.setShuffleMode(false);
    await playQueue.init({ ...episodes[5] });

    assert.strictEqual(playQueue.getShuffleMode(), false);
    assert.deepStrictEqual(
        playQueue.getQueue().map((i) => i.Id),
        episodes.map((e) => e.Id)
    );
    assert.strictEqual(playQueue.getCurrentItem().Id, 'ep6');
    assert.strictEqual(playQueue.getQueue()[playQueue.getCurrentIndex() + 1].Id, 'ep7');
});

test('PlayQueue: setShuffleMode(false) on an empty queue clears the flag and keeps repeat mode', () => {
    playQueue.setRepeatMode('RepeatAll');
    playQueue.setShuffleMode(true);
    playQueue.setShuffleMode(false);
    assert.strictEqual(playQueue.getShuffleMode(), false);
    assert.strictEqual(playQueue.getRepeatMode(), 'RepeatAll');
    assert.deepStrictEqual(playQueue.getQueue(), []);
    playQueue.setRepeatMode('RepeatNone');
});

test('player:play handler resets shuffle unless the request is a shuffle play', async () => {
    const app = await readFile(new URL('../src/core/App.js', import.meta.url), 'utf8');
    assert.match(app, /isShufflePlay\s*\n\s*\}\) => \{\s*\n\s*log\.info\('Playback requested/);
    assert.match(app, /if \(!isShufflePlay\) playQueue\.setShuffleMode\(false\);/);

    const details = await readFile(new URL('../src/pages/DetailsPage.js', import.meta.url), 'utf8');
    assert.match(details, /ghostMode,\s*\n\s*isShufflePlay\s*\n\s*\}\);\s*\n\s*\}/);
});
