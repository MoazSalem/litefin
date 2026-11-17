import assert from 'node:assert/strict';
import test from 'node:test';

// Polyfill window, document, and localStorage for Node testing
if (typeof globalThis.window === 'undefined') {
    globalThis.window = { location: { origin: 'http://localhost' } };
}
if (typeof globalThis.localStorage === 'undefined') {
    const store = new Map();
    globalThis.localStorage = {
        getItem: (k) => store.get(k) ?? null,
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
        clear: () => store.clear()
    };
}
if (typeof globalThis.document === 'undefined') {
    globalThis.document = {
        createElement: () => ({ canPlayType: () => '', setAttribute: () => {} }),
        querySelector: () => null,
        querySelectorAll: () => [],
        documentElement: {
            getAttribute: () => 'classic',
            setAttribute: () => {},
            style: {}
        },
        head: { appendChild: () => {} },
        addEventListener: () => {},
        removeEventListener: () => {}
    };
}
if (typeof globalThis.__APP_VERSION__ === 'undefined') {
    globalThis.__APP_VERSION__ = '1.0.0';
}

const { default: CardRenderer } = await import('../src/utils/CardRenderer.js');
const { storage } = await import('../src/utils/StorageService.js');

test('CardRenderer: getAnimeBadgeHtml renders audio pill for Japanese episode', () => {
    storage.setItem('pref:showAnimeMarkers', 'true');

    const episode = {
        Id: 'ep-sub',
        Type: 'Episode',
        Name: 'Pilot Episode',
        Genres: ['Anime'],
        MediaStreams: [
            { Type: 'Audio', Language: 'jpn' }
        ]
    };

    const badgeHtml = CardRenderer.getAnimeBadgeHtml(episode);
    assert.ok(badgeHtml.includes('card-anime-pills'));
    assert.ok(badgeHtml.includes('anime-pill-subbed'));
    assert.ok(badgeHtml.includes('Subbed'));
});

test('CardRenderer: getAnimeBadgeHtml renders filler and dual audio pills', () => {
    storage.setItem('pref:showAnimeMarkers', 'true');

    const episode = {
        Id: 'ep-filler-dual',
        Type: 'Episode',
        Name: 'A Special Filler',
        MediaStreams: [
            { Type: 'Audio', Language: 'jpn' },
            { Type: 'Audio', Language: 'eng' }
        ]
    };

    const seriesMarkers = {
        matched: true,
        episodes: {
            'epfillerdual': { kind: 'Filler', recap: false }
        }
    };

    const badgeHtml = CardRenderer.getAnimeBadgeHtml(episode, { seriesMarkers });
    assert.ok(badgeHtml.includes('anime-pill-filler'));
    assert.ok(badgeHtml.includes('Filler'));
    assert.ok(badgeHtml.includes('anime-pill-dual'));
    assert.ok(badgeHtml.includes('Subbed/Dubbed'));
});

test('CardRenderer: createCardHtml includes anime badges on episode cards', () => {
    storage.setItem('pref:showAnimeMarkers', 'true');

    const episode = {
        Id: 'ep-card-1',
        Type: 'Episode',
        Name: 'The Battle Begins',
        IndexNumber: 1,
        ParentIndexNumber: 1,
        Tags: ['anime'],
        MediaStreams: [
            { Type: 'Audio', Language: 'eng' }
        ]
    };

    const cardHtml = CardRenderer.createCardHtml(episode, { isLandscape: true });
    assert.ok(cardHtml.includes('card-anime-pills'));
    assert.ok(cardHtml.includes('anime-pill-dubbed'));
    assert.ok(cardHtml.includes('Dubbed'));
});

test('CardRenderer: getAnimeBadgeHtml suppresses badges for non-anime items', () => {
    storage.setItem('pref:showAnimeMarkers', 'true');

    // Non-anime Western TV show episode (e.g. Breaking Bad)
    const breakingBadEp = {
        Id: 'ep-bb-1',
        Type: 'Episode',
        Name: 'Ozymandias',
        Genres: ['Crime', 'Drama'],
        Tags: ['amc'],
        MediaStreams: [
            { Type: 'Audio', Language: 'eng' }
        ]
    };

    const badgeHtml = CardRenderer.getAnimeBadgeHtml(breakingBadEp);
    assert.equal(badgeHtml, '', 'Non-anime item must return empty badge HTML');

    // Non-anime movie (e.g. The Dark Knight)
    const movie = {
        Id: 'movie-tdk',
        Type: 'Movie',
        Name: 'The Dark Knight',
        Genres: ['Action', 'Thriller'],
        MediaStreams: [
            { Type: 'Audio', Language: 'eng' }
        ]
    };
    const movieBadgeHtml = CardRenderer.getAnimeBadgeHtml(movie);
    assert.equal(movieBadgeHtml, '', 'Non-anime movie must return empty badge HTML');
});

test('CardRenderer: getAnimeBadgeHtml defaults to disabled when setting is unset', () => {
    storage.removeItem('pref:showAnimeMarkers');

    const episode = {
        Id: 'ep-default-off',
        Type: 'Episode',
        Genres: ['Anime'],
        MediaStreams: [{ Type: 'Audio', Language: 'jpn' }]
    };

    const badgeHtml = CardRenderer.getAnimeBadgeHtml(episode);
    assert.equal(badgeHtml, '', 'Must be disabled by default when pref:showAnimeMarkers is not set');
});

test('CardRenderer: getAnimeBadgeHtml respects pref:showAnimeMarkers = false', () => {
    storage.setItem('pref:showAnimeMarkers', 'false');

    const episode = {
        Id: 'ep-off',
        Type: 'Episode',
        Genres: ['Anime'],
        MediaStreams: [{ Type: 'Audio', Language: 'jpn' }]
    };

    const badgeHtml = CardRenderer.getAnimeBadgeHtml(episode);
    assert.equal(badgeHtml, '');
});

test('CardRenderer: _updateRenderedCards patches active DOM cards with filler badge', () => {
    storage.setItem('pref:showAnimeMarkers', 'true');

    // Create a mock card element
    const insertedElements = [];
    const pillsRow = {
        querySelector: (sel) => null,
        insertBefore: (el) => insertedElements.push(el),
        appendChild: (el) => insertedElements.push(el)
    };
    const cardImage = {
        querySelector: (sel) => sel === '.card-anime-pills' ? pillsRow : null,
        appendChild: (el) => insertedElements.push(el)
    };
    const mockCard = {
        getAttribute: (attr) => {
            if (attr === 'data-item-id') return 'ep-patch-1';
            if (attr === 'data-type') return 'Episode';
            return null;
        },
        querySelector: (sel) => sel === '.card-image' ? cardImage : null
    };

    const originalQuerySelectorAll = globalThis.document.querySelectorAll;
    const originalCreateElement = globalThis.document.createElement;

    globalThis.document.querySelectorAll = (sel) => {
        if (sel.includes('series-patch')) return [mockCard];
        return [];
    };
    globalThis.document.createElement = (tag) => {
        const el = {
            tagName: tag.toUpperCase(),
            className: '',
            attributes: {},
            setAttribute: (k, v) => { el.attributes[k] = v; },
            textContent: ''
        };
        return el;
    };

    try {
        CardRenderer._updateRenderedCards('series-patch', {
            episodes: {
                'eppatch1': { kind: 'Filler', recap: false }
            }
        });

        assert.equal(insertedElements.length, 1);
        assert.equal(insertedElements[0].className, 'anime-pill anime-pill-filler');
        assert.equal(insertedElements[0].textContent, 'Filler');
    } finally {
        globalThis.document.querySelectorAll = originalQuerySelectorAll;
        globalThis.document.createElement = originalCreateElement;
    }
});

test('CardRenderer: _updateRenderedCards matches hyphenated series ID and patches audio badges without filler', () => {
    storage.setItem('pref:showAnimeMarkers', 'true');

    const rawSeriesId = 'c032be15-77cf-4b12-a123-123456789abc';
    const normalizedSeriesId = 'c032be1577cf4b12a123123456789abc';
    const episodeId = 'ep-audio-live-1';

    // 1. Initial card generation caches the item in CardRenderer._itemCache
    const episodeItem = {
        Id: episodeId,
        Type: 'Episode',
        SeriesId: rawSeriesId,
        Name: 'Clash of Swords',
        IndexNumber: 5,
        ParentIndexNumber: 1,
        MediaStreams: [
            { Type: 'Audio', Language: 'jpn' },
            { Type: 'Audio', Language: 'eng' }
        ]
    };
    CardRenderer.createCardHtml(episodeItem, { isLandscape: true });

    // 2. Setup mock DOM with hyphenated series ID attribute on the button card
    const insertedPills = [];
    const createdContainers = [];
    const cardImage = {
        querySelector: (sel) => null,
        appendChild: (el) => createdContainers.push(el)
    };
    const mockCard = {
        getAttribute: (attr) => {
            if (attr === 'data-item-id') return episodeId;
            if (attr === 'data-type') return 'Episode';
            if (attr === 'data-series-id') return rawSeriesId;
            return null;
        },
        querySelector: (sel) => sel === '.card-image' ? cardImage : null
    };

    const originalQuerySelectorAll = globalThis.document.querySelectorAll;
    const originalCreateElement = globalThis.document.createElement;

    globalThis.document.querySelectorAll = (sel) => {
        // Query selector matches candidate series ID or wildcard buttons
        if (sel.includes(normalizedSeriesId) || sel.includes(rawSeriesId) || sel === 'button[data-series-id]') {
            return [mockCard];
        }
        return [];
    };

    globalThis.document.createElement = (tag) => {
        const el = {
            tagName: tag.toUpperCase(),
            className: '',
            attributes: {},
            setAttribute: (k, v) => { el.attributes[k] = v; },
            textContent: '',
            appendChild: (child) => { insertedPills.push(child); }
        };
        return el;
    };

    try {
        // Asynchronous background response delivers normalized seriesId and empty filler map
        CardRenderer._updateRenderedCards(normalizedSeriesId, {
            matched: true,
            isAnime: true,
            episodes: {}
        });

        // Verify that container was mounted into cardImage
        assert.equal(createdContainers.length, 1);
        assert.equal(createdContainers[0].className, 'anime-pills-row card-anime-pills');

        // Verify that audio badge (Subbed/Dubbed) was resolved and injected into the container
        assert.equal(insertedPills.length, 1);
        assert.equal(insertedPills[0].className, 'anime-pill anime-pill-dual');
        assert.equal(insertedPills[0].textContent, 'Subbed/Dubbed');
    } finally {
        globalThis.document.querySelectorAll = originalQuerySelectorAll;
        globalThis.document.createElement = originalCreateElement;
    }
});

test('CardRenderer & Styles: CSS rules ensure badges are elevated above progress bar in modern and base layouts', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const __dirname = path.dirname(fileURLToPath(import.meta.url));

    // 1. Check modern/home.css elevates badges when card has progress
    const modernHomeCss = fs.readFileSync(path.resolve(__dirname, '../src/styles/modern/home.css'), 'utf-8');
    assert.ok(
        modernHomeCss.includes('.card-anime-pills') &&
        modernHomeCss.includes('.anime-pills-row.card-anime-pills') &&
        modernHomeCss.includes('bottom: 38px !important;'),
        'modern/home.css must elevate .card-anime-pills and .anime-pills-row.card-anime-pills with bottom: 38px !important;'
    );

    // 2. Check base.css elevates badges when card has progress
    const baseCss = fs.readFileSync(path.resolve(__dirname, '../src/styles/base.css'), 'utf-8');
    assert.ok(
        baseCss.includes('.card-anime-pills') &&
        baseCss.includes('.anime-pills-row.card-anime-pills') &&
        baseCss.includes('bottom: 18px !important;'),
        'base.css must elevate .card-anime-pills and .anime-pills-row.card-anime-pills with bottom: 18px !important;'
    );
});

test('ApiClient: getEpisodes default fields include SeriesId, Tags, and Genres', async () => {
    const { api } = await import('../src/api/index.js');
    let capturedParams = null;

    const originalGet = api.get;
    api.get = async (endpoint, params) => {
        capturedParams = params;
        return { Items: [] };
    };

    try {
        await api.getEpisodes('series-test-id');
        assert.ok(capturedParams, 'api.get must be called');
        assert.ok(capturedParams.Fields.includes('SeriesId'), 'getEpisodes must request SeriesId in Fields');
        assert.ok(capturedParams.Fields.includes('Tags'), 'getEpisodes must request Tags in Fields');
        assert.ok(capturedParams.Fields.includes('Genres'), 'getEpisodes must request Genres in Fields');
    } finally {
        api.get = originalGet;
    }
});

test('CardRenderer: split toggles independently enable/disable content vs audio badges', async () => {
    const { animeMarkerService } = await import('../src/utils/AnimeMarkerService.js');

    const episode = {
        Id: 'ep-split-test',
        Type: 'Episode',
        Genres: ['Anime'],
        MediaStreams: [
            { Type: 'Audio', Language: 'jpn' }
        ]
    };

    const seriesMarkers = {
        matched: true,
        episodes: {
            'epsplittest': { kind: 'Filler', recap: false }
        }
    };

    // Scenario 1: Only content badges enabled (Filler on, Subbed/Dubbed off)
    storage.setItem('pref:showAnimeContentBadges', 'true');
    storage.setItem('pref:showAudioBadges', 'false');
    storage.removeItem('pref:showAnimeMarkers');

    let badgeHtml = CardRenderer.getAnimeBadgeHtml(episode, { seriesMarkers });
    assert.ok(badgeHtml.includes('anime-pill-filler'), 'Filler pill must be present');
    assert.ok(!badgeHtml.includes('anime-pill-subbed'), 'Subbed pill must NOT be present when audio badges are off');

    // Scenario 2: Only audio badges enabled (Filler off, Subbed/Dubbed on)
    storage.setItem('pref:showAnimeContentBadges', 'false');
    storage.setItem('pref:showAudioBadges', 'true');

    badgeHtml = CardRenderer.getAnimeBadgeHtml(episode, { seriesMarkers });
    assert.ok(!badgeHtml.includes('anime-pill-filler'), 'Filler pill must NOT be present when content badges are off');
    assert.ok(badgeHtml.includes('anime-pill-subbed'), 'Subbed pill must be present');

    // Scenario 3: Both off
    storage.setItem('pref:showAnimeContentBadges', 'false');
    storage.setItem('pref:showAudioBadges', 'false');

    badgeHtml = CardRenderer.getAnimeBadgeHtml(episode, { seriesMarkers });
    assert.equal(badgeHtml, '', 'No badges when both are disabled');
});

test('AnimeMarkerService: getItemPills resolves appropriate pills for Details page items', async () => {
    const { animeMarkerService } = await import('../src/utils/AnimeMarkerService.js');

    // 1. Episode Details with canon inclusion
    const canonEp = {
        Id: 'ep-canon-1',
        Type: 'Episode',
        Genres: ['Anime'],
        MediaStreams: [{ Type: 'Audio', Language: 'jpn' }]
    };
    const markers = {
        matched: true,
        episodes: {
            'epcanon1': { kind: 'MangaCanon', recap: false }
        },
        seasons: {
            's1': 'Subbed'
        }
    };

    const epPills = animeMarkerService.getItemPills(canonEp, markers, {
        showContentBadges: true,
        showAudioBadges: true,
        includeCanon: true
    });
    assert.ok(epPills.some((p) => p.id === 'canon' && p.label === 'Canon'), 'Canon pill must be included for episode details');
    assert.ok(epPills.some((p) => p.id === 'subbed'), 'Subbed pill must be included');

    // 2. Series Details: resolves audio verdict
    const seriesItem = {
        Id: 'series-123',
        Type: 'Series',
        Genres: ['Anime']
    };
    const seriesPills = animeMarkerService.getItemPills(seriesItem, markers, {
        showContentBadges: true,
        showAudioBadges: true
    });
    assert.equal(seriesPills.length, 1);
    assert.equal(seriesPills[0].id, 'subbed');

    // 3. Movie Details: resolves audio verdict via media streams
    const animeMovie = {
        Id: 'movie-ghibli',
        Type: 'Movie',
        Genres: ['Anime'],
        MediaStreams: [
            { Type: 'Audio', Language: 'jpn' },
            { Type: 'Audio', Language: 'eng' }
        ]
    };
    const moviePills = animeMarkerService.getItemPills(animeMovie, null, {
        showContentBadges: true,
        showAudioBadges: true
    });
    assert.equal(moviePills.length, 1);
    assert.equal(moviePills[0].id, 'dual');
    assert.equal(moviePills[0].label, 'Subbed/Dubbed');
});
