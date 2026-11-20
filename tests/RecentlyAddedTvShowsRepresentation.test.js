import test from 'node:test';
import assert from 'node:assert/strict';

// Setup environment mocks before importing modules
globalThis.__APP_VERSION__ = '1.9.82';
globalThis.window = {
    innerWidth: 1920,
    innerHeight: 1080,
    addEventListener: () => {},
    removeEventListener: () => {}
};
globalThis.localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {}
};
globalThis.document = {
    documentElement: {
        clientWidth: 1920,
        clientHeight: 1080,
        getAttribute: () => null,
        setAttribute: () => {}
    },
    createElement: () => ({
        classList: { add: () => {}, remove: () => {}, toggle: () => {} },
        addEventListener: () => {},
        removeEventListener: () => {},
        querySelectorAll: () => [],
        querySelector: () => null,
        appendChild: () => {},
        innerHTML: ''
    }),
    body: {
        appendChild: () => {}
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: () => null,
    querySelectorAll: () => []
};

const { default: CardRenderer } = await import('../src/utils/CardRenderer.js');

test('Recently Added TV Shows: Episode card renders parent series title and episode identifier subtitle', async (t) => {
    // Clear card renderer HTML cache
    CardRenderer.clearCache();

    // Mock episode data matching Marshals S2:E2
    const episodeItem = {
        Id: 'ep12345',
        Type: 'Episode',
        Name: 'End of Watch',
        SeriesName: 'Marshals',
        SeriesId: 'series987',
        ParentIndexNumber: 2,
        IndexNumber: 2,
        SeriesPrimaryImageTag: 'tag_series_marshals',
        UserData: {
            Played: false,
            PlaybackPositionTicks: 0
        }
    };

    // Render card in 'latest' context
    const html = CardRenderer.createCardHtml(episodeItem, {
        isLandscape: false,
        type: 'poster',
        contextType: 'latest'
    });

    // 1. Primary title must be the Series name
    assert.match(
        html,
        /<div class="card-title"><span>Marshals<\/span><\/div>/,
        'Primary title should be series name Marshals'
    );

    // 2. Subtitle must be the episode code and title
    assert.match(
        html,
        /<div class="card-subtitle"><span>S2:E2 - End of Watch<\/span><\/div>/,
        'Subtitle should be S2:E2 - End of Watch'
    );

    // 3. Overlaid episode badge S02E02 must NOT be rendered when subtitle already contains it
    assert.doesNotMatch(
        html,
        /class="episode-badge"/,
        'Episode badge overlay should be suppressed in latest context'
    );
});

test('Recently Added TV Shows: Continuing series card renders Year - Present', async (t) => {
    CardRenderer.clearCache();

    // Mock continuing series data matching Treasure Island
    const continuingSeries = {
        Id: 'series_ti',
        Type: 'Series',
        Name: 'Treasure Island (2026)',
        ProductionYear: 2026,
        Status: 'Continuing',
        UserData: {
            Played: true
        }
    };

    const html = CardRenderer.createCardHtml(continuingSeries, {
        isLandscape: false,
        type: 'poster',
        contextType: 'latest'
    });

    // Subtitle must contain 2026 - Present
    assert.match(
        html,
        /<div class="card-subtitle"><span>2026 - Present<\/span><\/div>/,
        'Subtitle should display 2026 - Present for continuing series'
    );
});

test('Recently Added TV Shows: Ended series card renders Year range', async (t) => {
    CardRenderer.clearCache();

    // Mock ended series data
    const endedSeries = {
        Id: 'series_ended',
        Type: 'Series',
        Name: 'Classic Show',
        ProductionYear: 2016,
        EndDate: '2021-04-15T00:00:00.0000000Z',
        Status: 'Ended',
        UserData: {
            Played: false
        }
    };

    const html = CardRenderer.createCardHtml(endedSeries, {
        isLandscape: false,
        type: 'poster',
        contextType: 'latest'
    });

    // Subtitle must contain 2016 - 2021
    assert.match(
        html,
        /<div class="card-subtitle"><span>2016 - 2021<\/span><\/div>/,
        'Subtitle should display 2016 - 2021 for ended series'
    );
});
