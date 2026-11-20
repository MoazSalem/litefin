import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * ============================================================================
 * Media Card Preferences Test Suite
 * ============================================================================
 * A row or grid renders all its cards in one synchronous loop. Every storage
 * read parses the whole per-user settings object when settings are per user,
 * so the preferences that shape a card are read once per render pass instead
 * of once per card, and a changed setting still shows on the next render,
 * also on cards the HTML cache already holds.
 * ============================================================================
 */

const storageMap = new Map();
globalThis.localStorage = {
    getItem: (key) => (storageMap.has(key) ? storageMap.get(key) : null),
    setItem: (key, val) => storageMap.set(key, String(val)),
    removeItem: (key) => storageMap.delete(key),
    clear: () => storageMap.clear()
};
globalThis.document = {
    createElement: () => ({
        getContext: () => ({}),
        setAttribute: () => {},
        removeAttribute: () => {},
        classList: { add: () => {}, remove: () => {}, contains: () => false }
    }),
    documentElement: {
        setAttribute: () => {},
        removeAttribute: () => {},
        getAttribute: (name) => (name === 'data-layout-media-rows' ? 'expanding' : null),
        hasAttribute: () => false
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: () => null,
    querySelectorAll: () => []
};
globalThis.window = globalThis;
globalThis.__APP_VERSION__ = '1.0.0';

const { storage } = await import('../src/utils/StorageService.js');
const { default: CardRenderer } = await import('../src/utils/CardRenderer.js');

const favoriteMovie = (id) => ({
    Id: id,
    Name: `Movie ${id}`,
    Type: 'Movie',
    ProductionYear: 2024,
    MediaSourceCount: 2,
    ImageTags: { Primary: 'tag' },
    UserData: { IsFavorite: true, Played: true }
});

const CARD_PREF_KEYS = [
    'pref:libraryThumbMode',
    'pref:preferBackdropsOverThumbs',
    'litefin:disableBlurhash',
    'pref:disableLibraryBlurhash',
    'pref:hideLibraryLabels',
    'pref:cardLabelStyle',
    'pref:preferEpisodeImagesLocal',
    'pref:hideProgressBar',
    'pref:hideEpisodeCounts',
    'pref:showMediaSourceCounts',
    'pref:useEpisodeBadges',
    'pref:useSeasonBadges',
    'pref:swapEpisodeTitles',
    'pref:showFavoriteBadges',
    'pref:showQualityBadges'
];

function countCardPrefReads(fn) {
    const counts = new Map();
    const original = storage.getItem;
    storage.getItem = function (key) {
        if (CARD_PREF_KEYS.includes(key)) counts.set(key, (counts.get(key) || 0) + 1);
        return original.call(this, key);
    };
    try {
        fn();
    } finally {
        storage.getItem = original;
    }
    return counts;
}

const episode = (id) => ({
    Id: id,
    Name: `Episode ${id}`,
    Type: 'Episode',
    SeriesName: 'Series',
    SeriesId: 'series-1',
    ParentIndexNumber: 1,
    IndexNumber: 2,
    RunTimeTicks: 60000000000,
    ImageTags: { Primary: 'tag' },
    UserData: { IsFavorite: true, PlaybackPositionTicks: 20000000000 }
});

test('CardRenderer: card preferences are read once per render pass, not per card', async () => {
    await Promise.resolve(); // start from a fresh pass
    CardRenderer.clearCache();

    // A row of 12 posters, then a resume row of 12 episodes, in one pass (cache misses)
    const missReads = countCardPrefReads(() => {
        for (let i = 0; i < 12; i++) CardRenderer.createCardHtml(favoriteMovie(`m${i}`), { type: 'poster' });
        for (let i = 0; i < 12; i++) {
            CardRenderer.createCardHtml(episode(`e${i}`), { type: 'resume', contextType: 'resume', isLandscape: true });
        }
    });
    for (const [key, count] of missReads) assert.equal(count, 1, `${key} read ${count} times in one pass`);
    assert.ok(missReads.size > 0);

    // The same row again in a later pass: cache hits only
    await Promise.resolve();
    const hitReads = countCardPrefReads(() => {
        for (let i = 0; i < 12; i++) CardRenderer.createCardHtml(favoriteMovie(`m${i}`), { type: 'poster' });
    });
    for (const [key, count] of hitReads) assert.equal(count, 1, `${key} read ${count} times on cache hits`);
});

test('CardRenderer: a changed setting applies to the next render pass and after clearCache()', async () => {
    await Promise.resolve();
    storage.removeItem('pref:showFavoriteBadges');
    CardRenderer.clearCache();
    try {
        assert.doesNotMatch(CardRenderer.createCardHtml(favoriteMovie('p1'), { type: 'poster' }), /favorite-badge/);

        // Settings screen, later task: the next pass reads the new value
        storage.setItem('pref:showFavoriteBadges', 'true');
        await Promise.resolve();
        assert.match(CardRenderer.createCardHtml(favoriteMovie('p2'), { type: 'poster' }), /favorite-badge/);

        // Same task: clearCache(), which settings call when a card option changes, drops the snapshot
        storage.setItem('pref:showFavoriteBadges', 'false');
        CardRenderer.clearCache();
        assert.doesNotMatch(CardRenderer.createCardHtml(favoriteMovie('p3'), { type: 'poster' }), /favorite-badge/);
    } finally {
        storage.removeItem('pref:showFavoriteBadges');
        CardRenderer.clearCache();
    }
});

/** Counts the card builds (cache misses) during fn: only a build asks for the favorite badge. */
function countCardBuilds(fn) {
    const original = CardRenderer.getFavoriteBadgeHtml;
    let builds = 0;
    CardRenderer.getFavoriteBadgeHtml = function (item) {
        builds++;
        return original.call(this, item);
    };
    try {
        fn();
    } finally {
        CardRenderer.getFavoriteBadgeHtml = original;
    }
    return builds;
}

test('CardRenderer: a card already in the HTML cache gets the badges a changed setting turns on', async () => {
    await Promise.resolve();
    storage.removeItem('pref:showFavoriteBadges');
    storage.removeItem('pref:showQualityBadges');
    CardRenderer.clearCache();
    const movie = { ...favoriteMovie('c1'), Width: 3840, Height: 2160 };
    try {
        assert.doesNotMatch(CardRenderer.createCardHtml(movie, { type: 'poster' }), /favorite-badge/);

        // Settings screen, later task: the same card, rendered again from the cache
        storage.setItem('pref:showFavoriteBadges', 'true');
        await Promise.resolve();
        assert.match(CardRenderer.createCardHtml(movie, { type: 'poster' }), /favorite-badge/, 'stale cached card');

        storage.setItem('pref:showFavoriteBadges', 'false');
        await Promise.resolve();
        assert.doesNotMatch(
            CardRenderer.createCardHtml(movie, { type: 'poster' }),
            /favorite-badge/,
            'stale cached card'
        );

        const withoutQuality = CardRenderer.createCardHtml(movie, { type: 'poster' });
        storage.setItem('pref:showQualityBadges', 'true');
        await Promise.resolve();
        assert.notStrictEqual(
            CardRenderer.createCardHtml(movie, { type: 'poster' }),
            withoutQuality,
            'stale cached card'
        );
    } finally {
        storage.removeItem('pref:showFavoriteBadges');
        storage.removeItem('pref:showQualityBadges');
        CardRenderer.clearCache();
    }
});

test('CardRenderer: unchanged settings keep serving cards from the HTML cache (guard)', async () => {
    await Promise.resolve();
    storage.setItem('pref:showFavoriteBadges', 'true');
    CardRenderer.clearCache();
    try {
        const row = () => {
            for (let i = 0; i < 12; i++) CardRenderer.createCardHtml(favoriteMovie(`g${i}`), { type: 'poster' });
        };
        assert.equal(countCardBuilds(row), 12, 'first render');

        // Later passes with the same settings: every card from the cache
        for (let pass = 0; pass < 3; pass++) {
            await Promise.resolve();
            assert.equal(countCardBuilds(row), 0, `pass ${pass + 2} rebuilt cards`);
        }
    } finally {
        storage.removeItem('pref:showFavoriteBadges');
        CardRenderer.clearCache();
    }
});

test('CardRenderer: a changed card setting rebuilds each cached card once, then the cache serves them again', async () => {
    await Promise.resolve();
    CardRenderer.clearCache();
    try {
        const row = () => {
            for (let i = 0; i < 12; i++) CardRenderer.createCardHtml(favoriteMovie(`h${i}`), { type: 'poster' });
        };
        countCardBuilds(row);
        storage.setItem('pref:hideProgressBar', 'true');
        await Promise.resolve();
        assert.equal(countCardBuilds(row), 12, 'cards kept their markup from before the change');
        await Promise.resolve();
        assert.equal(countCardBuilds(row), 0, 'rebuilt again with the same settings');
    } finally {
        storage.removeItem('pref:hideProgressBar');
        CardRenderer.clearCache();
    }
});
