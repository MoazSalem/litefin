import assert from 'node:assert/strict';
import test from 'node:test';

// Define global browser shims for Node testing environment
if (typeof globalThis.window === 'undefined') {
    globalThis.window = { location: { hash: '', origin: 'http://localhost' } };
}
if (typeof globalThis.localStorage === 'undefined') {
    const map = new Map();
    globalThis.localStorage = {
        getItem: (k) => map.get(k) ?? null,
        setItem: (k, v) => map.set(k, String(v)),
        removeItem: (k) => map.delete(k),
        clear: () => map.clear()
    };
}
if (typeof globalThis.__APP_VERSION__ === 'undefined') {
    globalThis.__APP_VERSION__ = '1.0.0';
}

const { catalogQueryFromLibraryParams, catalogQueryFromSlider, fetchCatalogPage, seerrSortParam, SEERR_SLIDER_TYPE } =
    await import('../src/api/SeerrCatalog.js');
const { SeerrClient } = await import('../src/api/seerrClient.js');

/**
 * ============================================================================
 * Unit Tests: Seerr Catalog Queries
 * ============================================================================
 * Verifies that:
 *   - Library route params produce exactly the Seerr calls the former
 *     LibraryPage dispatch made (characterization against a verbatim copy)
 *   - Custom Seerr discover sliders (types 13–21) map to the right calls
 *   - Single keyword ids stay on the legacy `keywords` parameter
 *   - Invalid sort fields (e.g. Jellyfin 'SortName') never reach Seerr
 *   - seerrClient appends the new plugin filter parameters
 * ============================================================================
 */

/** Fake Seerr client recording every call as [method, ...args] with undefined option keys dropped. */
function recordingClient() {
    const calls = [];
    const clean = (v) =>
        v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined)) : v;
    const record =
        (name) =>
        async (...args) => {
            calls.push([name, ...args.map(clean)]);
            return [];
        };
    return {
        calls,
        discoverMovies: record('discoverMovies'),
        discoverTv: record('discoverTv'),
        moviesByStudio: record('moviesByStudio'),
        tvByNetwork: record('tvByNetwork'),
        search: record('search')
    };
}

/** Verbatim copy of the former LibraryPage._loadItems Seerr dispatch (pre-SeerrCatalog). */
async function legacyDispatch(params, filters, seerrSortBy, seerrPage, seerr) {
    const seerrType = params.seerrType;
    const rawMediaType = params.mediaType || (seerrType === 'network' ? 'tv' : 'movie');
    const mediaType = rawMediaType === 'tv' || rawMediaType === 'series' || rawMediaType === 'tvshows' ? 'tv' : 'movie';
    const genreId = filters.genre !== undefined ? filters.genre : params.genreId || params.genre;
    const language = filters.language !== undefined ? filters.language : params.language;
    const certification = filters.certification !== undefined ? filters.certification : params.certification;
    const studioId = params.studioId || params.studio;
    const networkId = params.networkId || params.network;
    const keywordId = params.keywordId || params.keywords || params.keyword;

    if (seerrType === 'keyword' || seerrType === 'tag' || keywordId) {
        const o = { keywords: keywordId, genre: genreId, language, certification, sortBy: seerrSortBy };
        return mediaType === 'tv' ? seerr.discoverTv(seerrPage, o) : seerr.discoverMovies(seerrPage, o);
    } else if (genreId || language || certification || seerrType === 'genre') {
        const o = { genre: genreId, language, certification, sortBy: seerrSortBy };
        return mediaType === 'tv' ? seerr.discoverTv(seerrPage, o) : seerr.discoverMovies(seerrPage, o);
    } else if (seerrType === 'studio' || studioId) {
        return seerr.moviesByStudio(studioId, seerrPage);
    } else if (seerrType === 'network' || networkId) {
        return seerr.tvByNetwork(networkId, seerrPage);
    }
    const o = { language, certification, sortBy: seerrSortBy };
    return mediaType === 'tv' ? seerr.discoverTv(seerrPage, o) : seerr.discoverMovies(seerrPage, o);
}

/** Drops falsy option values: discoverMovies/discoverTv ignore them, so they are not observable. */
function observable(calls) {
    return calls.map(([name, ...args]) => [
        name,
        ...args.map((a) =>
            a && typeof a === 'object' ? Object.fromEntries(Object.entries(a).filter(([, v]) => v)) : a
        )
    ]);
}

const LIBRARY_CASES = [
    [{ seerrType: 'genre', mediaType: 'movie', genreId: '28' }, {}],
    [{ seerrType: 'genre', mediaType: 'tv', genreId: '18' }, {}],
    [{ seerrType: 'genre', mediaType: 'series', genre: '18' }, {}],
    [{ seerrType: 'genre', mediaType: 'movie', genreId: '28' }, { genre: '28,12' }],
    [{ seerrType: 'genre', mediaType: 'movie' }, {}],
    [{ seerrType: 'studio', studioId: '2' }, {}],
    [{ seerrType: 'studio', studio: '2' }, { genre: '16' }],
    [{ seerrType: 'network', networkId: '213' }, {}],
    [{ network: '213' }, {}],
    [{ seerrType: 'network', networkId: '213' }, { language: 'ja' }],
    [{ seerrType: 'keyword', mediaType: 'movie', keywordId: '9715' }, {}],
    [{ seerrType: 'tag', mediaType: 'tv', keywords: '210024' }, { genre: '16' }],
    [{ keyword: '9715' }, { certification: 'PG-13' }],
    [{ seerrType: 'keyword', mediaType: 'movie' }, {}],
    [{}, {}],
    [{ mediaType: 'tvshows' }, { language: 'de', certification: 'FSK 12' }]
];

test('catalogQueryFromLibraryParams + fetchCatalogPage reproduce the former library dispatch', async () => {
    for (const [params, filters] of LIBRARY_CASES) {
        for (const sortBy of [null, 'vote_average.desc']) {
            for (const page of [1, 3]) {
                const legacy = recordingClient();
                await legacyDispatch(params, filters, sortBy, page, legacy);
                const current = recordingClient();
                await fetchCatalogPage(catalogQueryFromLibraryParams(params, filters, sortBy), page, current);
                assert.deepEqual(
                    observable(current.calls),
                    observable(legacy.calls),
                    `params=${JSON.stringify(params)} filters=${JSON.stringify(filters)} sortBy=${sortBy} page=${page}`
                );
            }
        }
    }
});

test('fetchCatalogPage keeps single keyword ids on the legacy parameter and sends lists as keywordIds', async () => {
    const client = recordingClient();
    await fetchCatalogPage({ mediaType: 'movie', kind: 'discover', keywords: '9715' }, 1, client);
    await fetchCatalogPage({ mediaType: 'tv', kind: 'discover', keywords: 210024 }, 2, client);
    await fetchCatalogPage({ mediaType: 'movie', kind: 'discover', keywords: '9715,180547' }, 1, client);
    assert.deepEqual(client.calls, [
        ['discoverMovies', 1, { keywords: '9715' }],
        ['discoverTv', 2, { keywords: '210024' }],
        ['discoverMovies', 1, { keywordIds: '9715,180547' }]
    ]);
});

test('fetchCatalogPage returns an empty list for a missing query', async () => {
    assert.deepEqual(await fetchCatalogPage(null, 1, recordingClient()), []);
});

test('catalogQueryFromSlider maps every custom Seerr slider type', async () => {
    const T = SEERR_SLIDER_TYPE;
    const cases = [
        [{ type: T.TMDB_MOVIE_KEYWORD, data: '9715,180547' }, ['discoverMovies', 1, { keywordIds: '9715,180547' }]],
        [{ type: T.TMDB_TV_KEYWORD, data: '210024' }, ['discoverTv', 1, { keywords: '210024' }]],
        [{ type: T.TMDB_MOVIE_GENRE, data: '28' }, ['discoverMovies', 1, { genre: '28' }]],
        [{ type: T.TMDB_TV_GENRE, data: '16' }, ['discoverTv', 1, { genre: '16' }]],
        [{ type: T.TMDB_SEARCH, data: ' star wars ' }, ['search', 'star wars', 1]],
        [{ type: T.TMDB_STUDIO, data: '2' }, ['moviesByStudio', '2', 1]],
        [{ type: T.TMDB_NETWORK, data: '213' }, ['tvByNetwork', '213', 1]],
        [
            { type: T.TMDB_MOVIE_STREAMING_SERVICES, data: 'DE,8|337' },
            ['discoverMovies', 1, { watchRegion: 'DE', watchProviders: '8|337' }]
        ],
        [
            { type: T.TMDB_TV_STREAMING_SERVICES, data: 'US,8' },
            ['discoverTv', 1, { watchRegion: 'US', watchProviders: '8' }]
        ]
    ];
    for (const [slider, expected] of cases) {
        const client = recordingClient();
        await fetchCatalogPage(catalogQueryFromSlider(slider), 1, client);
        assert.deepEqual(client.calls, [expected], JSON.stringify(slider));
    }
});

test('catalogQueryFromSlider rejects built-in, unknown and malformed sliders', () => {
    const T = SEERR_SLIDER_TYPE;
    const rejected = [
        null,
        { type: T.TRENDING },
        { type: T.POPULAR_MOVIES, data: '1' },
        { type: 99, data: '1' },
        { type: T.TMDB_MOVIE_KEYWORD },
        { type: T.TMDB_MOVIE_KEYWORD, data: '' },
        { type: T.TMDB_MOVIE_KEYWORD, data: '12;DROP' },
        { type: T.TMDB_MOVIE_GENRE, data: 'action' },
        { type: T.TMDB_SEARCH, data: '   ' },
        { type: T.TMDB_STUDIO, data: '2,3' },
        { type: T.TMDB_NETWORK, data: 'x' },
        { type: T.TMDB_MOVIE_STREAMING_SERVICES, data: 'DE' },
        { type: T.TMDB_MOVIE_STREAMING_SERVICES, data: 'de,8' },
        { type: T.TMDB_TV_STREAMING_SERVICES, data: 'US,8,9' }
    ];
    for (const slider of rejected) {
        assert.equal(catalogQueryFromSlider(slider), null, JSON.stringify(slider));
    }
});

test('seerrSortParam drops the upstream default and fields TMDB does not understand', () => {
    assert.equal(seerrSortParam('popularity', 'Descending'), null);
    assert.equal(seerrSortParam(undefined, undefined), null);
    assert.equal(seerrSortParam('popularity', 'Ascending'), 'popularity.asc');
    assert.equal(seerrSortParam('vote_average', 'Descending'), 'vote_average.desc');
    assert.equal(seerrSortParam('original_title', 'Ascending'), 'original_title.asc');
    assert.equal(seerrSortParam('first_air_date', 'Descending'), 'first_air_date.desc');
    // Jellyfin sort fields restored from navigation state used to produce sortBy=SortName.asc (empty results)
    assert.equal(seerrSortParam('SortName', 'Ascending'), null);
    assert.equal(seerrSortParam('DateCreated', 'Descending'), null);
});

test('seerrClient discover calls append keywordIds and watch provider filters', async () => {
    const client = new SeerrClient();
    const paths = [];
    client._request = async (path) => {
        paths.push(path);
        return { results: [] };
    };
    await client.discoverMovies(1, { keywordIds: '1,2', watchRegion: 'DE', watchProviders: '8|337', language: 'en' });
    await client.discoverTv(2, { keywords: '210024', watchProviders: '8', language: 'en' });
    assert.equal(
        paths[0],
        '/Discover/Movies?page=1&language=en&keywordIds=1%2C2&watchRegion=DE&watchProviders=8%7C337'
    );
    // watchProviders without a region is dropped; legacy keywords unchanged
    assert.equal(paths[1], '/Discover/Tv?page=2&language=en&keywords=210024');
});

test('seerrClient.discoverSettings returns sliders, null on errors, and stops probing after a 404', async () => {
    const client = new SeerrClient();
    let calls = 0;
    client._request = async () => {
        calls++;
        return [{ id: 1, type: 4, order: 0, enabled: true }];
    };
    assert.deepEqual(await client.discoverSettings(), [{ id: 1, type: 4, order: 0, enabled: true }]);

    client._request = async () => {
        calls++;
        return { message: 'not a list' };
    };
    assert.equal(await client.discoverSettings(), null);

    client._request = async () => {
        calls++;
        const err = new Error('boom');
        err.status = 500;
        throw err;
    };
    assert.equal(await client.discoverSettings(), null);

    client._request = async () => {
        calls++;
        const err = new Error('Not found');
        err.status = 404;
        throw err;
    };
    assert.equal(await client.discoverSettings(), null);
    const before = calls;
    assert.equal(await client.discoverSettings(), null);
    assert.equal(calls, before, 'no further request after 404');
});
