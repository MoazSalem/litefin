import assert from 'node:assert/strict';
import test from 'node:test';

// Polyfill window and global objects for tests
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
        documentElement: { style: {} },
        head: { appendChild: () => {} },
        addEventListener: () => {},
        removeEventListener: () => {}
    };
}
if (typeof globalThis.__APP_VERSION__ === 'undefined') {
    globalThis.__APP_VERSION__ = '1.0.0';
}

const { animeMarkerService } = await import('../src/utils/AnimeMarkerService.js');
const { api } = await import('../src/api/index.js');

test('AnimeMarkerService: normalizes ID formats properly', () => {
    assert.equal(animeMarkerService.normalizeId('3A5B-4C9D-11EF'), '3a5b4c9d11ef');
    assert.equal(animeMarkerService.normalizeId(null), '');
    assert.equal(animeMarkerService.normalizeId(undefined), '');
});

test('AnimeMarkerService: getEpisodePills generates correct badge combinations for anime items', () => {
    // 1. Episode with Japanese audio only and Anime genre
    const subbedEp = {
        Id: 'ep1',
        Genres: ['Anime', 'Action'],
        MediaStreams: [{ Type: 'Audio', Language: 'jpn' }]
    };
    const subbedPills = animeMarkerService.getEpisodePills(subbedEp);
    assert.equal(subbedPills.length, 1);
    assert.equal(subbedPills[0].id, 'subbed');
    assert.equal(subbedPills[0].label, 'Subbed');

    // 2. Episode with Dubbed audio only and Anime tag
    const dubbedEp = {
        Id: 'ep2',
        Tags: ['anime'],
        MediaStreams: [{ Type: 'Audio', Language: 'eng' }]
    };
    const dubbedPills = animeMarkerService.getEpisodePills(dubbedEp);
    assert.equal(dubbedPills.length, 1);
    assert.equal(dubbedPills[0].id, 'dubbed');

    // 3. Episode with Dual audio and AniList provider
    const dualEp = {
        Id: 'ep3',
        ProviderIds: { AniList: '16498' },
        MediaStreams: [
            { Type: 'Audio', Language: 'jpn' },
            { Type: 'Audio', Language: 'eng' }
        ]
    };
    const dualPills = animeMarkerService.getEpisodePills(dualEp);
    assert.equal(dualPills.length, 1);
    assert.equal(dualPills[0].id, 'dual');
    assert.equal(dualPills[0].label, 'Subbed/Dubbed');

    // 4. Combined with Filler content marker
    const markers = {
        matched: true,
        episodes: {
            ep3: { kind: 'Filler', recap: false }
        }
    };
    const combinedPills = animeMarkerService.getEpisodePills(dualEp, markers);
    assert.equal(combinedPills.length, 2);
    assert.equal(combinedPills[0].id, 'filler');
    assert.equal(combinedPills[1].id, 'dual');

    // 5. Mixed Canon/Filler and Recap markers on anime with lowercase and string recap
    const markersMixedRecap = {
        matched: true,
        episodes: {
            ep4: { kind: 'mixed', recap: 'true' }
        }
    };
    const mixedRecapEp = {
        Id: 'ep4',
        Genres: ['Animation'],
        MediaStreams: [{ Type: 'Audio', Language: 'jpn' }]
    };
    const mixedRecapPills = animeMarkerService.getEpisodePills(mixedRecapEp, markersMixedRecap);
    assert.equal(mixedRecapPills.length, 3);
    assert.equal(mixedRecapPills[0].id, 'mixed');
    assert.equal(mixedRecapPills[1].id, 'recap');
    assert.equal(mixedRecapPills[2].id, 'subbed');

    // 5b. Numeric enum support (3 = Filler, 2 = Mixed, 1 = Anime Canon, 0 = Manga Canon)
    const markersNumeric = {
        matched: true,
        episodes: {
            ep5: { kind: 3, recap: 1 },
            [animeMarkerService.normalizeId('epAnimeCanon')]: { kind: 1, recap: false },
            [animeMarkerService.normalizeId('epMangaCanon')]: { kind: 0, recap: false }
        }
    };
    const numericEp = {
        Id: 'ep5',
        Genres: ['Anime'],
        MediaStreams: [{ Type: 'Audio', Language: 'jpn' }]
    };
    const numericPills = animeMarkerService.getEpisodePills(numericEp, markersNumeric);
    assert.equal(numericPills.length, 3);
    assert.equal(numericPills[0].id, 'filler');
    assert.equal(numericPills[1].id, 'recap');
    assert.equal(numericPills[2].id, 'subbed');

    // Anime Canon verification
    const animeCanonEp = {
        Id: 'epAnimeCanon',
        Genres: ['Anime'],
        MediaStreams: [{ Type: 'Audio', Language: 'jpn' }]
    };
    const animeCanonPills = animeMarkerService.getEpisodePills(animeCanonEp, markersNumeric);
    assert.equal(animeCanonPills.length, 2);
    assert.equal(animeCanonPills[0].id, 'anime-canon');
    assert.equal(animeCanonPills[0].label, 'Anime Canon');
    assert.equal(animeCanonPills[1].id, 'subbed');

    // Manga Canon verification
    const mangaCanonEp = {
        Id: 'epMangaCanon',
        Genres: ['Anime'],
        MediaStreams: [{ Type: 'Audio', Language: 'jpn' }]
    };
    const mangaCanonPills = animeMarkerService.getEpisodePills(mangaCanonEp, markersNumeric);
    assert.equal(mangaCanonPills.length, 2);
    assert.equal(mangaCanonPills[0].id, 'canon');
    assert.equal(mangaCanonPills[0].label, 'Canon');
    assert.equal(mangaCanonPills[1].id, 'subbed');

    // 5c. Automatically resolves from cache if seriesMarkers is omitted
    animeMarkerService._seriesCache.set('seriesnaruto', {
        fetchedAt: Date.now(),
        data: {
            matched: true,
            episodes: {
                ep6: { kind: 'Filler', recap: false }
            }
        }
    });
    const cachedEp = {
        Id: 'ep6',
        SeriesId: 'series-naruto',
        Genres: ['Anime'],
        MediaStreams: [{ Type: 'Audio', Language: 'jpn' }]
    };
    const autoCachedPills = animeMarkerService.getEpisodePills(cachedEp);
    assert.equal(autoCachedPills.length, 2);
    assert.equal(autoCachedPills[0].id, 'filler');
    assert.equal(autoCachedPills[1].id, 'subbed');

    // 6. Non-anime TV show (e.g. The Office) must NEVER receive anime badges
    const nonAnimeEp = {
        Id: 'ep-office-1',
        Name: 'The Dundies',
        Genres: ['Comedy'],
        Tags: ['sitcom'],
        MediaStreams: [{ Type: 'Audio', Language: 'eng' }]
    };
    const nonAnimePills = animeMarkerService.getEpisodePills(nonAnimeEp);
    assert.equal(nonAnimePills.length, 0, 'Non-anime item must receive 0 badges');

    // 7. Non-anime movie (e.g. Inception) must NEVER receive anime badges
    const nonAnimeMovie = {
        Id: 'movie-inception',
        Type: 'Movie',
        Name: 'Inception',
        Genres: ['Action', 'Sci-Fi'],
        MediaStreams: [{ Type: 'Audio', Language: 'eng' }]
    };
    const nonAnimeMoviePills = animeMarkerService.getEpisodePills(nonAnimeMovie);
    assert.equal(nonAnimeMoviePills.length, 0, 'Non-anime movie must receive 0 badges');
});

test('AnimeMarkerService: renderPillsHtml produces lightweight HTML without shadows or blur', () => {
    const pills = [
        { id: 'filler', type: 'filler', label: 'Filler' },
        { id: 'dual', type: 'dual', label: 'Subbed/Dubbed' }
    ];

    const html = animeMarkerService.renderPillsHtml(pills);
    assert.ok(html.includes('anime-pills-row'));
    assert.ok(html.includes('anime-pill-filler'));
    assert.ok(html.includes('anime-pill-dual'));
    assert.ok(html.includes('Filler'));
    assert.ok(html.includes('Subbed/Dubbed'));

    // Empty pills should render nothing
    assert.equal(animeMarkerService.renderPillsHtml([]), '');
    assert.equal(animeMarkerService.renderPillsHtml(null), '');
});

test('AnimeMarkerService: caches series responses and suppresses redundant network calls', async () => {
    animeMarkerService.clearCache();

    Object.defineProperty(api, 'serverUrl', { value: 'http://127.0.0.1:8096', configurable: true });
    let requestCount = 0;

    api.get = async (url, params) => {
        requestCount++;
        return {
            enabled: true,
            episodes: {
                'ep-101': { kind: 'Filler', recap: false }
            }
        };
    };

    // First fetch
    const firstResult = await animeMarkerService.fetchSeriesMarkers('series-1');
    assert.ok(firstResult);
    assert.equal(requestCount, 1);
    assert.equal(firstResult.episodes['ep101'].kind, 'Filler');

    // Second fetch should hit memory cache immediately
    const secondResult = await animeMarkerService.fetchSeriesMarkers('series-1');
    assert.ok(secondResult);
    assert.equal(requestCount, 1);
});

test('AnimeMarkerService: non-anime show with cached episodes and no anime markers is NEVER classified as anime', () => {
    animeMarkerService.clearCache();

    // Mock non-anime show response where episodes exist but matched is false, slug is null, and no filler/mixed kinds exist
    const breakingBadSeriesId = 'breaking-bad-series-id';
    animeMarkerService._seriesCache.set(animeMarkerService.normalizeId(breakingBadSeriesId), {
        fetchedAt: Date.now(),
        data: {
            episodes: {
                'bbep1': { kind: 'Canon', recap: false },
                'bbep2': { kind: null, recap: false }
            },
            seasons: { 'season1': 'Dubbed' },
            matched: false,
            isAnime: false,
            slug: null,
            title: 'Breaking Bad'
        }
    });

    const ep = {
        Id: 'bbep1',
        SeriesId: breakingBadSeriesId,
        Name: 'Pilot',
        Genres: ['Crime', 'Drama'],
        MediaStreams: [{ Type: 'Audio', Language: 'eng' }]
    };

    // Fast check: isAnime must return false
    const isAnimeResult = animeMarkerService.isAnime(ep);
    assert.equal(isAnimeResult, false, 'Breaking Bad must never be classified as anime');

    // Badges check: getEpisodePills must return empty array
    const pills = animeMarkerService.getEpisodePills(ep);
    assert.equal(pills.length, 0, 'Breaking Bad must never receive Dubbed or content pills');
});

test('AnimeMarkerService: One Piece anime series correctly resolves filler and subbed pills even with missing episode SeriesId', () => {
    animeMarkerService.clearCache();

    const onePieceSeriesId = '13f1dbb9fe027e935a468e184e1d52bf';
    const fillerEpisodeId = 'op-ep-100';
    const canonEpisodeId = 'op-ep-101';

    // Populate cache with One Piece markers containing verified filler content
    animeMarkerService._seriesCache.set(animeMarkerService.normalizeId(onePieceSeriesId), {
        fetchedAt: Date.now(),
        data: {
            episodes: {
                [animeMarkerService.normalizeId(fillerEpisodeId)]: { kind: 'Filler', recap: false },
                [animeMarkerService.normalizeId(canonEpisodeId)]: { kind: 'Canon', recap: false }
            },
            seasons: { 'season1': 'Subbed' },
            matched: true,
            isAnime: true,
            slug: 'one-piece',
            title: 'One Piece'
        }
    });

    // Episode where ep.SeriesId is undefined (as returned by Jellyfin when SeriesId is omitted from Fields)
    // but options.series passes the parent Season object with SeriesId
    const fillerEpWithoutSeriesId = {
        Id: fillerEpisodeId,
        Name: 'Filler Episode',
        MediaStreams: [{ Type: 'Audio', Language: 'jpn' }]
    };

    const seasonContext = {
        Type: 'Season',
        Id: 'season-1-id',
        SeriesId: onePieceSeriesId
    };

    const pills = animeMarkerService.getEpisodePills(fillerEpWithoutSeriesId, null, { series: seasonContext });
    assert.equal(pills.length, 2, 'One Piece filler episode must receive 2 pills');
    assert.equal(pills[0].id, 'filler');
    assert.equal(pills[0].label, 'Filler');
    assert.equal(pills[1].id, 'subbed');
    assert.equal(pills[1].label, 'Subbed');

    // Canon episode receives both Canon content pill and audio pill
    const canonEpWithoutSeriesId = {
        Id: canonEpisodeId,
        Name: 'Canon Episode',
        MediaStreams: [{ Type: 'Audio', Language: 'jpn' }]
    };

    const canonPills = animeMarkerService.getEpisodePills(canonEpWithoutSeriesId, null, { series: seasonContext });
    assert.equal(canonPills.length, 2, 'One Piece canon episode must receive Canon pill and subbed pill');
    assert.equal(canonPills[0].id, 'canon');
    assert.equal(canonPills[0].label, 'Canon');
    assert.equal(canonPills[1].id, 'subbed');
    assert.equal(canonPills[1].label, 'Subbed');
});

test('AnimeMarkerService: inherits season audio verdict when individual episode streams are omitted', () => {
    const seriesId = 'one-piece-series-id';
    const seasonId = 'season-wano-id';
    const epId = 'ep-1089-guid';

    // Mock series markers with 1105 episodes and aggregated season audio
    animeMarkerService._seriesCache.set(animeMarkerService.normalizeId(seriesId), {
        fetchedAt: Date.now(),
        data: {
            episodes: {
                [animeMarkerService.normalizeId(epId)]: { kind: 'MangaCanon', recap: false, audio: null }
            },
            seasons: {
                [animeMarkerService.normalizeId(seasonId)]: 'Subbed'
            },
            matched: true,
            isAnime: true,
            slug: 'one-piece'
        }
    });

    // Episode with no MediaStreams (common in minimal API queries)
    const ep = {
        Id: epId,
        SeriesId: seriesId,
        SeasonId: seasonId,
        IndexNumber: 1089
    };

    const pills = animeMarkerService.getEpisodePills(ep);
    assert.equal(pills.length, 2, 'Episode must receive Canon pill and inherit Subbed pill from season verdict');
    assert.equal(pills[0].id, 'canon');
    assert.equal(pills[0].label, 'Canon');
    assert.equal(pills[1].id, 'subbed');
    assert.equal(pills[1].label, 'Subbed');
});

test('AnimeMarkerService: getEpisodeMarker resolves markers by IndexNumber when GUID lookup fails', () => {
    const seriesMarkers = {
        episodes: {
            '54': { kind: 'Filler', recap: false, audio: 'Subbed' }
        }
    };

    // Episode with arbitrary GUID not present in dictionary, but with IndexNumber = 54
    const ep = {
        Id: 'unknown-guid-1234',
        IndexNumber: 54
    };

    const marker = animeMarkerService.getEpisodeMarker(seriesMarkers, ep.Id, ep);
    assert.ok(marker, 'Marker should be matched via IndexNumber fallback');
    assert.equal(marker.kind, 'Filler');
    assert.equal(marker.audio, 'Subbed');
});

test('ApiClient: getResumeItems and getNextUp default fields include SeriesId', async () => {
    // Verify getResumeItems default fields include SeriesId
    const resumeClient = Object.create(api);
    let capturedResumeParams = null;
    resumeClient.get = (url, params) => {
        capturedResumeParams = params;
        return Promise.resolve({ Items: [] });
    };
    resumeClient.isJF12Plus = () => true;

    await resumeClient.getResumeItems();
    assert.ok(capturedResumeParams, 'getResumeItems must invoke GET');
    assert.ok(capturedResumeParams.Fields.includes('SeriesId'), 'getResumeItems Fields must contain SeriesId');

    // Verify getNextUp default fields include SeriesId
    let capturedNextUpParams = null;
    const nextUpClient = Object.create(api);
    nextUpClient.get = (url, params) => {
        capturedNextUpParams = params;
        return Promise.resolve({ Items: [] });
    };

    await nextUpClient.getNextUp();
    assert.ok(capturedNextUpParams, 'getNextUp must invoke GET');
    assert.ok(capturedNextUpParams.Fields.includes('SeriesId'), 'getNextUp Fields must contain SeriesId');
});

test('AnimeMarkerService: onMarkersLoaded broadcasts updates to subscribers and cleanly unsubscribes', () => {
    let callCount = 0;
    let receivedSeriesId = null;

    const unsub = animeMarkerService.onMarkersLoaded((id, data) => {
        callCount++;
        receivedSeriesId = id;
    });

    animeMarkerService._notifyMarkersLoaded('test-series-id', { matched: true });
    assert.equal(callCount, 1);
    assert.equal(receivedSeriesId, 'test-series-id');

    // Unsubscribe should remove callback
    unsub();
    animeMarkerService._notifyMarkersLoaded('test-series-id', { matched: true });
    assert.equal(callCount, 1, 'Callback must not be invoked after unsubscribe');
});
