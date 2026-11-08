import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
    filterSections,
    assignSlotIds,
    viewModeToLayout,
    absoluteUrl,
    mapDiscoverItem,
    mapUpcomingItem,
    mapSectionItems,
    isHssPseudoId,
    isHssRowId
} from '../src/utils/HomeScreenSectionsMapper.js';
import { createHomeScreenSectionsProvider, saveSectionList, readSectionList } from '../src/utils/HomeScreenSections.js';

/**
 * ============================================================================
 * Home Screen Sections Test Suite
 * ============================================================================
 * Covers the mapping of the Home Screen Sections server plugin responses to
 * Home rows, the provider's failure handling (plugin missing, Seerr missing,
 * broken sections) and the HomePage guards for pseudo cards.
 * ============================================================================
 */

const SERVER = 'http://jf.local:8096';

const section = (Section, extra = {}) => ({ Section, DisplayText: Section, OrderIndex: 0, ...extra });

// ----------------------------------------------------------------------------
// Mapper
// ----------------------------------------------------------------------------

test('filterSections: drops native duplicates and keeps server order', () => {
    const result = filterSections(
        [
            section('Genre', { OrderIndex: 3 }),
            section('ContinueWatching', { OrderIndex: 0 }),
            section('TopTen', { OrderIndex: 1 }),
            section('NextUp', { OrderIndex: 2 }),
            section('MyMedia'),
            section('ContinueWatchingNextUp'),
            section('LiveTV', { OrderIndex: 4 }),
            section('RecentlyAddedMovies'),
            section('RecentlyAddedShows'),
            section('RecentlyAddedInLibrary', { AdditionalData: 'lib1' }),
            section('RecentlyAddedArtists', { OrderIndex: 5 }),
            section('LatestMovies', { OrderIndex: 6 }),
            { DisplayText: 'no type' }
        ],
        { seerrAvailable: true }
    );
    // Release-date "Latest" rows and artist rows are not duplicates of Litefin's rows
    assert.deepEqual(
        result.map((s) => s.Section),
        ['TopTen', 'Genre', 'RecentlyAddedArtists', 'LatestMovies']
    );
});

test('filterSections: removes Discover sections when Seerr is not available', () => {
    const items = [section('Discover'), section('DiscoverMovies'), section('DiscoverTV'), section('UpcomingShows')];
    assert.deepEqual(
        filterSections(items, { seerrAvailable: false }).map((s) => s.Section),
        ['UpcomingShows']
    );
    assert.equal(filterSections(items, { seerrAvailable: true }).length, 4);
});

test('filterSections: tolerates a missing or malformed response', () => {
    assert.deepEqual(filterSections(undefined, { seerrAvailable: true }), []);
    assert.deepEqual(filterSections(null, { seerrAvailable: true }), []);
});

test('assignSlotIds: numbers repeated section types instead of naming their content', () => {
    const slots = assignSlotIds([
        section('Genre', { AdditionalData: 'Action', DisplayText: 'Action' }),
        section('TopTen'),
        section('Genre', { AdditionalData: 'Drama', DisplayText: 'Drama', DisplayTitleText: false })
    ]);
    assert.deepEqual(
        slots.map((s) => s.id),
        ['hss-Genre-1', 'hss-TopTen-1', 'hss-Genre-2']
    );
    assert.equal(slots[0].additionalData, 'Action');
    assert.equal(slots[2].displayTitleText, false);
    assert.ok(slots.every((s) => isHssRowId(s.id)));
});

test('viewModeToLayout: maps every HSS view mode', () => {
    assert.deepEqual(viewModeToLayout('Portrait'), { layout: 'portrait', cardType: 'poster' });
    assert.deepEqual(viewModeToLayout('Landscape'), { layout: 'landscape', cardType: 'thumb' });
    assert.deepEqual(viewModeToLayout('Small'), { layout: 'landscape', cardType: 'thumb' });
    assert.deepEqual(viewModeToLayout('Square'), { layout: 'square', cardType: 'square' });
    assert.deepEqual(viewModeToLayout(null), { layout: 'portrait', cardType: 'poster' });
});

test('absoluteUrl: resolves plugin-relative image URLs', () => {
    assert.equal(absoluteUrl('/HomeScreen/CachedImage/abc', `${SERVER}/`), `${SERVER}/HomeScreen/CachedImage/abc`);
    assert.equal(absoluteUrl('HomeScreen/CachedImage/abc', SERVER), `${SERVER}/HomeScreen/CachedImage/abc`);
    assert.equal(absoluteUrl('https://image.tmdb.org/x.jpg', SERVER), 'https://image.tmdb.org/x.jpg');
    assert.equal(absoluteUrl('', SERVER), null);
});

test('mapDiscoverItem: builds a Seerr link card and skips entries without a TMDB id', () => {
    const card = mapDiscoverItem(
        {
            Name: 'Dune',
            SourceType: 'movie',
            CommunityRating: 8.1,
            PremiereDate: '2021-10-22T00:00:00Z',
            ProviderIds: { Jellyseerr: '438631', JellyseerrPoster: '/HomeScreen/CachedImage/k1' }
        },
        SERVER
    );
    assert.equal(card.Id, 'hss-seerr-movie-438631');
    assert.equal(card.Type, 'Movie');
    assert.equal(card.ProductionYear, 2021);
    assert.equal(card._imageUrl, `${SERVER}/HomeScreen/CachedImage/k1`);
    assert.deepEqual(card._hssSeerr, { mediaType: 'movie', tmdbId: '438631' });
    // _mediaType would trigger the Discover-page badges whose CSS is not loaded on Home
    assert.equal('_mediaType' in card, false);

    const tv = mapDiscoverItem({ Name: 'Show', SourceType: 'tv', ProviderIds: { Jellyseerr: 1 } }, SERVER);
    assert.equal(tv.Type, 'Series');
    assert.equal(tv._hssSeerr.mediaType, 'tv');

    assert.equal(mapDiscoverItem({ Name: 'x', ProviderIds: {} }, SERVER), null);
});

test('mapUpcomingItem: display-only card that never keeps the random server id', () => {
    const card = mapUpcomingItem(
        {
            Id: '6f1c0f4e-0000-4000-8000-000000000000',
            Type: 'Episode',
            Name: 'Pilot',
            SeriesName: 'New Show',
            ProviderIds: {
                SonarrSeriesId: '12',
                SonarrEpisodeId: '345',
                EpisodeInfo: 'S01E01',
                FormattedDate: 'in 2 days',
                SonarrPoster: '/HomeScreen/CachedImage/p'
            }
        },
        SERVER,
        0
    );
    assert.equal(card.Id, 'hss-upcoming-Series-345');
    assert.ok(isHssPseudoId(card.Id));
    assert.equal(card.Name, 'New Show');
    assert.equal(card._subtitleOverride, 'S01E01 · in 2 days');
    assert.equal(card._hssDisplayOnly, true);
    assert.equal(card._hssSeerr, null);

    const movie = mapUpcomingItem({ Type: 'Movie', Name: 'Film', ProviderIds: { RadarrMovieId: '9' } }, SERVER, 1);
    assert.equal(movie.Type, 'Movie');
    assert.equal(movie._imageUrl, null);
    assert.equal(movie._subtitleOverride, null);
});

test('pseudo cards share one object shape', () => {
    const discover = mapDiscoverItem({ Name: 'a', SourceType: 'movie', ProviderIds: { Jellyseerr: '1' } }, SERVER);
    const upcoming = mapUpcomingItem({ Type: 'Movie', Name: 'b', ProviderIds: {} }, SERVER, 0);
    assert.deepEqual(Object.keys(discover), Object.keys(upcoming));
});

test('mapSectionItems: ranks Top Ten, hides labels on request and applies the row limit', () => {
    const items = [{ Id: 'a' }, { Id: 'b' }, { Id: 'c' }, null, { Name: 'no id' }];
    const topTen = { section: 'TopTen', containerClass: 'top-ten', displayTitleText: true };
    const ranked = mapSectionItems(topTen, items, { serverUrl: SERVER, limit: 2 });
    assert.deepEqual(
        ranked.map((i) => [i.Id, i._rank]),
        [
            ['a', 1],
            ['b', 2]
        ]
    );
    // Source objects stay untouched
    assert.equal(items[0]._rank, undefined);

    const plain = { section: 'Genre', containerClass: null, displayTitleText: false };
    const hidden = mapSectionItems(plain, items, { serverUrl: SERVER, limit: 10 });
    assert.equal(hidden.length, 3);
    assert.ok(hidden.every((i) => i._hideCardLabels === true));

    assert.deepEqual(mapSectionItems(plain, undefined, { serverUrl: SERVER, limit: 10 }), []);
});

// ----------------------------------------------------------------------------
// Provider
// ----------------------------------------------------------------------------

const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

function makeProvider({ routes, seerr = true, seerrThrows = false }) {
    const calls = [];
    const errors = [];
    const provider = createHomeScreenSectionsProvider({
        getJson: async (endpoint, params) => {
            calls.push({ endpoint, params });
            const handler = routes[endpoint];
            if (!handler) throw httpError(404);
            return handler(params);
        },
        serverUrl: SERVER,
        userId: 'u1',
        language: 'de',
        isSeerrAvailable: async () => {
            if (seerrThrows) throw new Error('companion plugin missing');
            return seerr;
        },
        onError: (msg, err) => errors.push(msg)
    });
    return { provider, calls, errors };
}

test('provider: server plugin missing (404) yields no rows and no error', async () => {
    const { provider, errors } = makeProvider({ routes: {} });
    assert.deepEqual(await provider.loadSections(), []);
    assert.deepEqual(errors, []);
});

test('provider: plugin disabled on the server yields no rows', async () => {
    const { provider, calls } = makeProvider({ routes: { '/HomeScreen/Meta': () => ({ Enabled: false }) } });
    assert.deepEqual(await provider.loadSections(), []);
    assert.equal(
        calls.some((c) => c.endpoint === '/HomeScreen/Sections'),
        false
    );
});

test('provider: loads every section in one request with user and language', async () => {
    const { provider, calls } = makeProvider({
        routes: {
            '/HomeScreen/Meta': () => ({ Enabled: true }),
            '/HomeScreen/Sections': () => ({
                Items: [section('Genre', { AdditionalData: 'Action' }), section('NextUp')]
            })
        }
    });
    const sections = await provider.loadSections();
    assert.deepEqual(
        sections.map((s) => s.id),
        ['hss-Genre-1']
    );
    const req = calls.find((c) => c.endpoint === '/HomeScreen/Sections');
    assert.deepEqual(req.params, { UserId: 'u1', Language: 'de' });
});

test('provider: without Seerr, Discover sections are never requested', async () => {
    const routes = {
        '/HomeScreen/Meta': () => ({ Enabled: true }),
        '/HomeScreen/Sections': () => ({
            Items: [section('Discover'), section('TopTen', { ContainerClass: 'top-ten' })]
        }),
        '/HomeScreen/Section/TopTen': () => ({ Items: [{ Id: 'x' }] })
    };
    for (const opts of [{ seerr: false }, { seerrThrows: true }]) {
        const { provider, calls, errors } = makeProvider({ routes, ...opts });
        const sections = await provider.loadSections();
        assert.deepEqual(
            sections.map((s) => s.section),
            ['TopTen']
        );
        const descriptors = provider.buildDescriptors(sections, 12);
        await Promise.all(descriptors.map((d) => d.fetchFn()));
        assert.equal(
            calls.some((c) => c.endpoint.indexOf('/HomeScreen/Section/Discover') === 0),
            false
        );
        assert.deepEqual(errors, []);
    }
});

test('provider: a failing section resolves to null instead of throwing', async () => {
    const { provider } = makeProvider({
        routes: {
            '/HomeScreen/Meta': () => ({ Enabled: true }),
            '/HomeScreen/Sections': () => ({ Items: [section('Discover'), section('MyJellyseerrRequests')] }),
            '/HomeScreen/Section/Discover': () => {
                throw httpError(500);
            },
            '/HomeScreen/Section/MyJellyseerrRequests': () => ({ Items: [] })
        }
    });
    const descriptors = provider.buildDescriptors(await provider.loadSections(), 12);
    assert.equal(descriptors.length, 2);
    for (const d of descriptors) {
        assert.equal(await d.fetchFn(), null);
    }
});

test('provider: descriptors map Discover items and pass AdditionalData', async () => {
    const { provider, calls } = makeProvider({
        routes: {
            '/HomeScreen/Meta': () => ({ Enabled: true }),
            '/HomeScreen/Sections': () => ({
                Items: [
                    section('DiscoverMovies', { ViewMode: 'Portrait' }),
                    section('Genre', { AdditionalData: 'Sci-Fi', ViewMode: 'Landscape' })
                ]
            }),
            '/HomeScreen/Section/DiscoverMovies': () => ({
                Items: [{ Name: 'A', SourceType: 'movie', ProviderIds: { Jellyseerr: '5' } }]
            }),
            '/HomeScreen/Section/Genre': () => ({ Items: [{ Id: 'g1' }] })
        }
    });
    const [discover, genre] = provider.buildDescriptors(await provider.loadSections(), 12);
    assert.equal(discover.contextType, 'hss');
    assert.equal(discover.priority, 2);
    assert.equal(genre.layout, 'landscape');

    const discoverItems = await discover.fetchFn();
    assert.equal(discoverItems[0]._hssSeerr.tmdbId, '5');

    await genre.fetchFn();
    const req = calls.find((c) => c.endpoint === '/HomeScreen/Section/Genre');
    assert.deepEqual(req.params, { UserId: 'u1', AdditionalData: 'Sci-Fi', Language: 'de' });
});

test('provider: a failed load is retried on the next call', async () => {
    let fail = true;
    const { provider, errors } = makeProvider({
        routes: {
            '/HomeScreen/Meta': () => {
                if (fail) throw httpError(503);
                return { Enabled: true };
            },
            '/HomeScreen/Sections': () => ({ Items: [section('TopTen')] })
        }
    });
    assert.deepEqual(await provider.loadSections(), []);
    assert.equal(errors.length, 1);
    fail = false;
    assert.equal((await provider.loadSections()).length, 1);
});

test('saveSectionList / readSectionList: round-trip and survive bad data', () => {
    const store = new Map();
    const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) };
    saveSectionList(storage, [{ id: 'hss-TopTen-1', title: 'Top Ten', section: 'TopTen' }]);
    assert.deepEqual(readSectionList(storage), [{ id: 'hss-TopTen-1', title: 'Top Ten' }]);
    store.set('home:hssSections', '{broken');
    assert.deepEqual(readSectionList(storage), []);
});

// ----------------------------------------------------------------------------
// HomePage guards (source checks, same style as HomeInitialFocus.test.js)
// ----------------------------------------------------------------------------

test('HomePage: pseudo cards never reach details or playback', () => {
    const source = readFileSync(path.resolve('src/pages/HomePage.js'), 'utf8');
    assert.match(
        source,
        /if \(isHssPseudoId\(card\.dataset\.itemId\)\) \{\s*this\._activateHssCard\(card\);\s*return;/
    );
    assert.match(source, /if \(isHssPseudoId\(itemId\)\) return;/);
    assert.match(source, /if \(!\(await isSeerrAvailable\(\)\)\)/);
    assert.match(source, /router\.navigate\(`\/seerr\/\$\{link\.mediaType\}\/\$\{link\.tmdbId\}`\)/);
});

test('HomePage: Home Screen Sections rows follow the plugin switch and are cached with the page', () => {
    const source = readFileSync(path.resolve('src/pages/HomePage.js'), 'utf8');
    assert.match(source, /isHomeScreenSectionsEnabled\(storage\) && this\._hssSections\.length > 0/);
    assert.match(source, /hssSections: this\._hssSections/);
    assert.match(source, /this\._hssSections = cache\.hssSections \|\| \[\]/);
    // Switching the plugin on or off in Settings → Plugins invalidates the cached Home page
    assert.match(source, /hssEnabled: isHomeScreenSectionsEnabled\(storage\)/);
    assert.match(source, /if \(!!cache\.hssEnabled !== isHomeScreenSectionsEnabled\(storage\)\)/);
});

test('modern/home.css: card-rank-badge defines modern layout coordinates and hover scaling', () => {
    // Read stylesheet to ensure modern media row cards reflect updated rank styling
    const css = readFileSync(path.resolve('src/styles/modern/home.css'), 'utf8');

    // Confirm coordinates mirror standard modern badges (top/left 22px)
    assert.match(css, /html\[data-media-rows-family="modern"\]\s+\.card-rank-badge\s*\{[^}]*left:\s*22px/);

    // Confirm hover and focus transitions apply consistent 1.05 scale transform
    assert.match(css, /\.card-rank-badge[^}]*transform:\s*scale\(1\.05\)/);
});
