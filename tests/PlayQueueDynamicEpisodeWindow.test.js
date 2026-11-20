import assert from 'node:assert/strict';
import test from 'node:test';

// Polyfill minimal browser DOM globals
const storageMap = new Map();
globalThis.localStorage = {
    getItem: (key) => storageMap.get(key) || null,
    setItem: (key, val) => storageMap.set(key, String(val)),
    removeItem: (key) => storageMap.delete(key),
    clear: () => storageMap.clear()
};
globalThis.window = globalThis;
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

const { PlayerSettings } = await import('../src/utils/PlayerSettings.js');
const { playQueue } = await import('../src/core/PlayQueue.js');
const { api } = await import('../src/api/index.js');

test('PlayerSettings: playQueueEpisodeLimit defaults to 50 and persists changes', () => {
    storageMap.clear();
    assert.equal(PlayerSettings.get('playQueueEpisodeLimit'), 50);

    PlayerSettings.set('playQueueEpisodeLimit', 25);
    assert.equal(PlayerSettings.get('playQueueEpisodeLimit'), 25);

    PlayerSettings.set('playQueueEpisodeLimit', 75);
    assert.equal(PlayerSettings.get('playQueueEpisodeLimit'), 75);

    // Reset
    PlayerSettings.reset('playQueueEpisodeLimit');
    assert.equal(PlayerSettings.get('playQueueEpisodeLimit'), 50);
});

test('PlayQueue: dynamic sliding window for a 1,000-episode TV show', async () => {
    storageMap.clear();
    PlayerSettings.set('playQueueEpisodeLimit', 50);

    // Generate mock series of 1,000 episodes
    const TOTAL_EPISODES = 1000;
    const mockEpisodes = Array.from({ length: TOTAL_EPISODES }, (_, i) => ({
        Id: `ep_${i + 1}`,
        SeriesId: 'series_1000',
        Name: `Episode ${i + 1}`,
        IndexNumber: i + 1,
        Type: 'Episode'
    }));

    // Mock API getEpisodes implementation
    const originalGetEpisodes = api.getEpisodes;
    api.getEpisodes = async (seriesId, params = {}) => {
        // Manifest call (no StartIndex passed)
        if (params.StartIndex === undefined) {
            return {
                Items: mockEpisodes.map((e) => ({
                    Id: e.Id,
                    SeriesId: e.SeriesId,
                    IndexNumber: e.IndexNumber,
                    Name: e.Name
                })),
                TotalRecordCount: TOTAL_EPISODES
            };
        }

        // Windowed call with StartIndex and Limit
        const start = params.StartIndex || 0;
        const limit = params.Limit || 100;
        return {
            Items: mockEpisodes.slice(start, start + limit).map((e) => ({
                ...e,
                Overview: `Overview for ${e.Name}`,
                RunTimeTicks: 14400000000
            })),
            TotalRecordCount: TOTAL_EPISODES
        };
    };

    try {
        // Simulate playing Episode 750 (index 749 in zero-indexed array)
        const targetEpisode = mockEpisodes[749]; // ep_750
        await playQueue.init(targetEpisode);

        const queue = playQueue.getQueue();
        const activeIdx = playQueue.getCurrentIndex();
        const currentItem = playQueue.getCurrentItem();

        // 50 previous (ep_700 to ep_749) + ep_750 + 50 next (ep_751 to ep_800) = 101 items
        assert.equal(queue.length, 101, 'Queue should contain exactly 101 items (50 before, current, 50 after)');
        assert.equal(activeIdx, 50, 'Current index should be centered at index 50 of the window');
        assert.equal(currentItem.Id, 'ep_750', 'Current item should be Episode 750');
        assert.equal(queue[0].Id, 'ep_700', 'Window start should be Episode 700');
        assert.equal(queue[100].Id, 'ep_800', 'Window end should be Episode 800');

        // Navigation state checks
        assert.equal(playQueue.hasPrevious(), true, 'Should have previous episodes');
        assert.equal(playQueue.hasNext(), true, 'Should have next episodes');

        // Peek next
        const peekedNext = playQueue.peekNext();
        assert.equal(peekedNext.Id, 'ep_751', 'Peeked next should be Episode 751');

        // Advance to next
        const advancedItem = playQueue.advance();
        assert.equal(advancedItem.Id, 'ep_751', 'Advance should move to Episode 751');
        assert.equal(playQueue.getCurrentIndex(), 51, 'Current index should increment to 51');

        // Go back
        const wentBackItem = playQueue.goBack();
        assert.equal(wentBackItem.Id, 'ep_750', 'goBack should return to Episode 750');
        assert.equal(playQueue.getCurrentIndex(), 50, 'Current index should be back to 50');
    } finally {
        api.getEpisodes = originalGetEpisodes;
    }
});

test('PlayQueue: dynamic sliding window respects customized window limit (e.g. 25 items)', async () => {
    storageMap.clear();
    PlayerSettings.set('playQueueEpisodeLimit', 25);

    const TOTAL_EPISODES = 1000;
    const mockEpisodes = Array.from({ length: TOTAL_EPISODES }, (_, i) => ({
        Id: `ep_${i + 1}`,
        SeriesId: 'series_1000',
        Name: `Episode ${i + 1}`,
        Type: 'Episode'
    }));

    const originalGetEpisodes = api.getEpisodes;
    api.getEpisodes = async (seriesId, params = {}) => {
        if (params.StartIndex === undefined) {
            return {
                Items: mockEpisodes.map((e) => ({ Id: e.Id, SeriesId: e.SeriesId })),
                TotalRecordCount: TOTAL_EPISODES
            };
        }

        const start = params.StartIndex || 0;
        const limit = params.Limit || 100;
        return {
            Items: mockEpisodes.slice(start, start + limit),
            TotalRecordCount: TOTAL_EPISODES
        };
    };

    try {
        // Play episode 100 with window limit 25
        const targetEpisode = mockEpisodes[99]; // ep_100
        await playQueue.init(targetEpisode);

        const queue = playQueue.getQueue();
        const activeIdx = playQueue.getCurrentIndex();

        // 25 before + 1 current + 25 after = 51 items
        assert.equal(queue.length, 51, 'Queue should contain 51 items with limit 25');
        assert.equal(activeIdx, 25, 'Current index should be 25');
        assert.equal(queue[0].Id, 'ep_75', 'Window start should be Episode 75');
        assert.equal(queue[50].Id, 'ep_125', 'Window end should be Episode 125');
    } finally {
        api.getEpisodes = originalGetEpisodes;
    }
});

test('PlayQueue: dynamic background expansion appends subsequent episodes when nearing end', async () => {
    storageMap.clear();
    PlayerSettings.set('playQueueEpisodeLimit', 50);

    const TOTAL_EPISODES = 1000;
    const mockEpisodes = Array.from({ length: TOTAL_EPISODES }, (_, i) => ({
        Id: `ep_${i + 1}`,
        SeriesId: 'series_1000',
        Name: `Episode ${i + 1}`,
        Type: 'Episode'
    }));

    const originalGetEpisodes = api.getEpisodes;
    api.getEpisodes = async (seriesId, params = {}) => {
        if (params.StartIndex === undefined) {
            return {
                Items: mockEpisodes.map((e) => ({ Id: e.Id, SeriesId: e.SeriesId })),
                TotalRecordCount: TOTAL_EPISODES
            };
        }

        const start = params.StartIndex || 0;
        const limit = params.Limit || 100;
        return {
            Items: mockEpisodes.slice(start, start + limit),
            TotalRecordCount: TOTAL_EPISODES
        };
    };

    try {
        const targetEpisode = mockEpisodes[749]; // ep_750
        await playQueue.init(targetEpisode);

        assert.equal(playQueue.getQueue().length, 101);

        // Manually move index near the end of loaded window (e.g. index 98 out of 101)
        playQueue._currentIndex = 98;

        // peekNext() triggers dynamic preload of next 50 episodes
        playQueue.peekNext();

        // Wait a tick for async preload
        await new Promise((r) => setTimeout(r, 50));

        // Queue should now be expanded by 50 episodes (101 + 50 = 151 items)
        assert.equal(playQueue.getQueue().length, 151, 'Queue should dynamically expand when approaching the window end');
        assert.equal(playQueue.getQueue()[150].Id, 'ep_850', 'Queue end should now reach Episode 850');
    } finally {
        api.getEpisodes = originalGetEpisodes;
    }
});

test('SettingsPage: includes play-queue-episode-limit-select in Performance tab, settingsMap, and intKeys', async () => {
    const { readFileSync } = await import('node:fs');
    const settingsSource = readFileSync(new URL('../src/pages/settings/SettingsPage.js', import.meta.url), 'utf8');

    // Verify UI dropdown rendered in Performance tab
    assert.ok(
        settingsSource.includes("'play-queue-episode-limit-select'"),
        'SettingsPage must render play-queue-episode-limit-select dropdown'
    );
    assert.ok(
        settingsSource.includes("LabelPlayQueueEpisodeLimit"),
        'SettingsPage must provide label for episode queue window size'
    );

    // Verify settingsMap entry
    assert.ok(
        settingsSource.includes("'play-queue-episode-limit-select': { type: 'player', key: 'playQueueEpisodeLimit' }"),
        'SettingsPage must map play-queue-episode-limit-select to PlayerSettings playQueueEpisodeLimit'
    );

    // Verify integer parsing configuration
    assert.ok(
        settingsSource.includes("'playQueueEpisodeLimit'"),
        'SettingsPage intKeys must include playQueueEpisodeLimit'
    );
});

