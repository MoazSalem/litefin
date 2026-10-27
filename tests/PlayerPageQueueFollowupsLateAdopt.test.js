import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * ============================================================================
 * PlayQueue Late Queue Adoption Test Suite
 * ============================================================================
 * When the queue takes longer than 2 s to load, playback starts with the item
 * alone and the full queue is put in place when it arrives. Meanwhile Local
 * Intros may have injected a pre-roll in front of the item. The late queue
 * keeps those items and the cursor stays on the item that is playing, so the
 * movie or episode still plays after the intro.
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

function deferred() {
    let resolve;
    const promise = new Promise((res) => (resolve = res));
    return { promise, resolve };
}

const episodes = Array.from({ length: 10 }, (_, i) => ({ Id: `ep${i + 1}`, SeriesId: 'show', Type: 'Episode' }));
const intro = () => ({ Id: 'intro', Type: 'Video', isIntro: true });

/** init() that gives up waiting for the queue, as with a server slower than 2 s */
async function initWithSlowQueue(t, item) {
    const init = playQueue.init(item);
    await flush();
    t.mock.timers.tick(2000);
    await init;
    assert.deepStrictEqual(
        playQueue.getQueue().map((i) => i.Id),
        [item.Id]
    );
}

test('PlayQueue: a movie still plays after an intro injected while its queue was loading', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const parts = deferred();
    t.mock.method(api, 'getAdditionalParts', () => parts.promise);
    const movie = { Id: 'movie', Type: 'Movie' };

    await initWithSlowQueue(t, movie);
    // PlayerPage -> pluginManager.prepareItemPlayback -> Local Intros
    playQueue.injectPreRoll([intro()]);
    assert.strictEqual(playQueue.getCurrentItem().Id, 'intro');

    parts.resolve({ Items: [] });
    await flush();

    assert.strictEqual(playQueue.getCurrentItem().Id, 'intro', 'the late queue moved the cursor off the playing intro');
    assert.strictEqual(playQueue.advance()?.Id, 'movie', 'the movie is skipped after the intro');
    assert.strictEqual(playQueue.getCurrentItem(), movie);
});

test('PlayQueue: an episode still plays after an intro injected while the series queue was loading', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const pending = [];
    t.mock.method(api, 'getEpisodes', (seriesId, params = {}) => {
        const answer = deferred();
        pending.push({ params, answer });
        return answer.promise;
    });
    const ep5 = { ...episodes[4] };

    await initWithSlowQueue(t, ep5);
    playQueue.injectPreRoll([intro()]);

    // Manifest, then the window around ep5
    while (pending.length) {
        const { params, answer } = pending.shift();
        const items =
            params.StartIndex === undefined
                ? episodes
                : episodes.slice(params.StartIndex, params.StartIndex + params.Limit);
        answer.resolve({ Items: items.map((e) => ({ ...e })) });
        await flush();
    }

    assert.deepStrictEqual(
        playQueue.getQueue().map((i) => i.Id),
        ['ep1', 'ep2', 'ep3', 'ep4', 'intro', 'ep5', 'ep6', 'ep7', 'ep8', 'ep9', 'ep10']
    );
    assert.strictEqual(playQueue.getCurrentItem().Id, 'intro', 'the late queue moved the cursor off the playing intro');
    assert.strictEqual(playQueue.advance(), ep5, 'ep5 (the instance PlayerPage holds) is skipped after the intro');
    assert.strictEqual(playQueue.advance()?.Id, 'ep6');
});

test('PlayQueue: an item added as "play next" while the queue was loading is kept', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const parts = deferred();
    t.mock.method(api, 'getAdditionalParts', () => parts.promise);
    const movie = { Id: 'movie-part1', Type: 'Movie' };

    await initWithSlowQueue(t, movie);
    playQueue.insertNext({ Id: 'extra', Type: 'Movie' });

    parts.resolve({ Items: [{ Id: 'movie-part2', Type: 'Movie' }] });
    await flush();

    assert.deepStrictEqual(
        playQueue.getQueue().map((i) => i.Id),
        ['movie-part1', 'extra', 'movie-part2']
    );
    assert.strictEqual(playQueue.getCurrentItem(), movie);
});

test('PlayQueue: with shuffle on, turning it off after a late queue keeps the intro before the movie', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    t.after(() => {
        playQueue._shuffleMode = false;
    });
    playQueue._shuffleMode = true;
    const parts = deferred();
    t.mock.method(api, 'getAdditionalParts', () => parts.promise);
    const movie = { Id: 'movie-part1', Type: 'Movie' };

    await initWithSlowQueue(t, movie);
    playQueue.injectPreRoll([intro()]);

    parts.resolve({ Items: [{ Id: 'movie-part2', Type: 'Movie' }] });
    await flush();
    assert.strictEqual(playQueue.getCurrentItem().Id, 'intro');

    playQueue.setShuffleMode(false);
    assert.deepStrictEqual(
        playQueue.getQueue().map((i) => i.Id),
        ['intro', 'movie-part1', 'movie-part2']
    );
    assert.strictEqual(playQueue.getCurrentItem().Id, 'intro', 'the unshuffled queue lost the playing intro');
    assert.strictEqual(playQueue.advance(), movie);
});
