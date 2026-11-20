import assert from 'node:assert/strict';
import test from 'node:test';

// ============================================================================
// PlayQueue Shuffle Reset & Synchronization Test Suite
// ============================================================================
// PlayQueue is an application-lifetime singleton. Shuffle mode persists across
// clear() within a playback session, but must be synchronized whenever a new
// playback request arrives:
//   - An explicit shuffle play (isShufflePlay: true) activates shuffle mode.
//   - A standard sequential play (isShufflePlay: false / omitted) resets shuffle
//     mode to false so subsequent episodes play in proper chronological order.
//   - DetailsPage._shufflePlay() delegates directly to _play({ isShufflePlay: true })
//     without prematurely mutating the PlayQueue singleton before validation.
// ============================================================================

// Mock environment storage to satisfy core module singletons
const storageMap = new Map();
globalThis.localStorage = {
    getItem: (key) => storageMap.get(key) || null,
    setItem: (key, val) => storageMap.set(key, String(val)),
    removeItem: (key) => storageMap.delete(key),
    clear: () => storageMap.clear()
};

// Minimal DOM mocks required by PlayQueue dependencies
globalThis.document = {
    createElement: () => ({ canPlayType: () => '' }),
    addEventListener: () => {},
    removeEventListener: () => {},
    documentElement: { setAttribute: () => {}, style: {} },
    body: { appendChild: () => {}, style: {} }
};

// Window context mock
globalThis.window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    localStorage: globalThis.localStorage
};
globalThis.__APP_VERSION__ = '1.0.0';

const { readFile } = await import('node:fs/promises');
const { playQueue } = await import('../src/core/PlayQueue.js');
const { api } = await import('../src/api/index.js');

// Fixture of 30 sequential episodes across 3 seasons
const episodes = Array.from({ length: 30 }, (_, i) => ({
    Id: `ep${i + 1}`,
    SeriesId: 'show',
    Type: 'Episode',
    ParentIndexNumber: Math.floor(i / 10) + 1,
    IndexNumber: (i % 10) + 1
}));

/**
 * Configure API mocks for series episode retrieval
 * @param {Object} t - Test context with mock utilities
 */
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
    // Reset queue state completely between test runs
    playQueue.setShuffleMode(false);
    playQueue.clear();
});

test('PlayQueue: shuffle survives clear() and shuffles the next series until it is reset', async (t) => {
    mockEpisodes(t);

    // Explicitly activate shuffle mode for first series
    playQueue.setShuffleMode(true);
    await playQueue.init({ ...episodes[2] });

    const ids = playQueue.getQueue().map((i) => i.Id);

    // Active item stays at head of queue
    assert.strictEqual(ids[0], 'ep3');
    assert.strictEqual(ids.length, 30);

    // Remaining items should not match natural sequential order
    assert.notDeepStrictEqual(
        ids,
        episodes
            .map((e) => e.Id)
            .slice(2)
            .concat(episodes.slice(0, 2).map((e) => e.Id))
    );
    assert.ok(playQueue.getShuffleMode(), 'clear() must keep shuffle between queues in same session');
});

test('PlayQueue: setShuffleMode(false) before init() gives the sequential episode order', async (t) => {
    mockEpisodes(t);

    // First playback was shuffled
    playQueue.setShuffleMode(true);
    await playQueue.init({ ...episodes[0] });

    // Normal play on subsequent show: launcher synchronizes shuffle to false
    playQueue.setShuffleMode(false);
    await playQueue.init({ ...episodes[5] });

    // Verify sequential playback order restored
    assert.strictEqual(playQueue.getShuffleMode(), false);
    assert.deepStrictEqual(
        playQueue.getQueue().map((i) => i.Id),
        episodes.map((e) => e.Id)
    );
    assert.strictEqual(playQueue.getCurrentItem().Id, 'ep6');
    assert.strictEqual(playQueue.getQueue()[playQueue.getCurrentIndex() + 1].Id, 'ep7');
});

test('PlayQueue: setShuffleMode(false) on an empty queue clears the flag and keeps repeat mode', () => {
    // Configure initial modes
    playQueue.setRepeatMode('RepeatAll');
    playQueue.setShuffleMode(true);

    // Reset shuffle mode on empty queue
    playQueue.setShuffleMode(false);

    assert.strictEqual(playQueue.getShuffleMode(), false);
    assert.strictEqual(playQueue.getRepeatMode(), 'RepeatAll');
    assert.deepStrictEqual(playQueue.getQueue(), []);

    // Clean up repeat mode
    playQueue.setRepeatMode('RepeatNone');
});

test('PlayQueue: synchronization with isShufflePlay flag properly activates and resets queue order', async (t) => {
    mockEpisodes(t);

    // Helper simulating the synchronization done in App.js player:play handler
    const syncPlayQueue = (isShufflePlay) => {
        playQueue.setShuffleMode(Boolean(isShufflePlay));
    };

    // 1. Simulate incoming shuffle playback request
    syncPlayQueue(true);
    assert.strictEqual(playQueue.getShuffleMode(), true, 'Shuffle flag should be enabled on shuffle play');
    await playQueue.init({ ...episodes[0] });
    assert.strictEqual(playQueue.getQueue().length, 30);

    // 2. Simulate subsequent standard play (e.g. Next Up or normal card selection)
    syncPlayQueue(false);
    assert.strictEqual(playQueue.getShuffleMode(), false, 'Shuffle flag must reset on standard play');
    await playQueue.init({ ...episodes[10] });

    // Verify all episodes are in chronological sequence
    const currentQueueIds = playQueue.getQueue().map((i) => i.Id);
    assert.deepStrictEqual(currentQueueIds, episodes.map((e) => e.Id));
    assert.strictEqual(playQueue.getCurrentItem().Id, 'ep11');
});

test('DetailsPage: _shufflePlay delegates cleanly without premature singleton mutation', async () => {
    const details = await readFile(new URL('../src/pages/DetailsPage.js', import.meta.url), 'utf8');

    // Verify DetailsPage does not import PlayQueue directly anymore
    assert.doesNotMatch(
        details,
        /import\s*\{\s*playQueue\s*\}\s*from\s*['"]\.\.\/core\/PlayQueue\.js['"]/,
        'DetailsPage should not import playQueue singleton directly'
    );

    // Verify _shufflePlay delegates directly to _play({ isShufflePlay: true })
    assert.match(
        details,
        /_shufflePlay\(\)\s*\{[\s\S]*?this\._play\(\{\s*isShufflePlay:\s*true\s*\}\);/,
        '_shufflePlay must delegate to _play with isShufflePlay: true'
    );

    // Verify DetailsPage forwards isShufflePlay in player:play payload
    assert.match(
        details,
        /eventBus\.emit\(['"]player:play['"],\s*\{[\s\S]*?\bisShufflePlay\b/,
        'DetailsPage._play must include isShufflePlay in eventBus player:play payload'
    );
});

test('App: player:play handler synchronizes playQueue shuffle mode with isShufflePlay', async () => {
    const app = await readFile(new URL('../src/core/App.js', import.meta.url), 'utf8');

    // Verify App.js player:play event parameter destructs isShufflePlay
    assert.match(
        app,
        /eventBus\.on\(\s*['"]player:play['"],[\s\S]*?\bisShufflePlay\b/,
        'App.js player:play handler must accept isShufflePlay parameter'
    );

    // Verify App.js synchronizes playQueue shuffle state with isShufflePlay
    assert.match(
        app,
        /playQueue\.setShuffleMode\(\s*Boolean\(isShufflePlay\)\s*\)/,
        'App.js must synchronize playQueue shuffle mode using Boolean(isShufflePlay)'
    );
});
