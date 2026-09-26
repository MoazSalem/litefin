import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { normalizeSeerrItem } from '../src/api/seerrNormalize.js';
import {
    providersForRegion,
    renderWatchProviders,
    watchProviderRegion,
    watchProviderRegionName,
    watchProviderTarget
} from '../src/utils/WatchProviders.js';

const translations = JSON.parse(readFileSync(new URL('../src/locales/it.json', import.meta.url)));
const t = (key) => translations[key];
const providers = [
    { iso_3166_1: 'US', flatrate: [{ id: 1, name: 'US only' }] },
    {
        iso_3166_1: 'IT',
        flatrate: [{ id: 2, name: 'Subscription service', logoPath: '/logo.jpg' }],
        buy: [{ id: 3, name: 'Store' }]
    }
];

test('movie and TV normalization retain provider details and tolerate absent data', () => {
    for (const mediaType of ['movie', 'tv']) {
        const item = normalizeSeerrItem({ id: 12, mediaType, watchProviders: providers });
        assert.deepEqual(item.WatchProviders, providers);
        assert.deepEqual(normalizeSeerrItem({ id: 12, mediaType }).WatchProviders, []);
        assert.deepEqual(normalizeSeerrItem({ id: 12, mediaType, watchProviders: {} }).WatchProviders, []);
    }
});

test('country selection defaults to Italy and never borrows providers from another market', () => {
    assert.equal(watchProviderRegion(null), 'IT');
    assert.equal(watchProviderRegion('de'), 'DE');
    assert.equal(watchProviderRegion('<IT>'), 'IT');
    assert.equal(watchProviderRegionName('IT', 'it'), 'Italia');
    assert.deepEqual(providersForRegion(providers, 'FR'), { flatrate: [], buy: [] });
    assert.deepEqual(providersForRegion(null, 'IT'), { flatrate: [], buy: [] });
    const html = renderWatchProviders(providers, 'FR', t, 'it');
    assert.match(html, /Disponibilità non indicata/);
    assert.doesNotMatch(html, /US only|Subscription service/);
});

test('providers are separated by purchase type, deduplicated and ordered by priority', () => {
    const data = [
        {
            iso_3166_1: 'IT',
            flatrate: [
                null,
                {},
                { id: 3, name: 'Third', displayPriority: 3 },
                { id: 2, name: 'First', displayPriority: 1 },
                { id: 2, name: 'Duplicate' }
            ],
            buy: [{ id: 2, name: 'First' }]
        }
    ];
    const result = providersForRegion(data, 'IT');
    assert.deepEqual(
        result.flatrate.map((entry) => entry.name),
        ['First', 'Third']
    );
    assert.equal(result.buy.length, 1);
    const html = renderWatchProviders(providers, 'IT', t, 'it');
    assert.match(html, /In abbonamento/);
    assert.match(html, /Acquistabile/);
    assert.match(html, /https:\/\/image.tmdb.org\/t\/p\/w92\/logo.jpg/);
    assert.doesNotMatch(html, /JustWatch|TMDB|watch-providers-attribution/);
    assert.doesNotMatch(html, /US only/);
});

test('server supplied names are escaped and arbitrary logo URLs are rejected', () => {
    const html = renderWatchProviders(
        [
            {
                iso_3166_1: 'IT',
                buy: [
                    { name: '<img src=x onerror="bad()">', logoPath: 'https://untrusted.example/image.jpg' },
                    { name: 'No logo' }
                ]
            }
        ],
        'IT',
        t,
        'it'
    );
    assert.match(html, /&lt;img/);
    assert.match(html, /No logo/);
    assert.doesNotMatch(html, /<img|untrusted.example/);
});

test('Jellyfin lookups use film/series TMDB IDs and skip unsupported or unidentified items', () => {
    for (const key of ['Tmdb', 'tmdb', 'TMDB']) {
        assert.deepEqual(watchProviderTarget({ Type: 'Movie', ProviderIds: { [key]: '603' } }), {
            mediaType: 'movie',
            tmdbId: '603'
        });
    }
    assert.deepEqual(watchProviderTarget({ Type: 'Series', ProviderIds: { Tmdb: 12 } }), {
        mediaType: 'tv',
        tmdbId: '12'
    });
    for (const item of [
        null,
        { Type: 'Movie' },
        { Type: 'Episode', ProviderIds: { Tmdb: 12 } },
        { Type: 'Movie', ProviderIds: { Tmdb: '12/evil' } }
    ]) {
        assert.equal(watchProviderTarget(item), null);
    }
});

// Exercise the actual page loader with isolated network and DOM dependencies.
const pageSource = readFileSync(new URL('../src/pages/DetailsPage.js', import.meta.url), 'utf8');
const loaderBody = pageSource.split('    async _loadWatchProviders() {')[1].split('\n    async _loadDetails() {')[0];
function pageWith(seerr, preference = 'true') {
    const classes = new Set();
    const container = {
        innerHTML: '',
        classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name) }
    };
    const load = new Function(
        'seerr',
        'watchProviderTarget',
        'renderWatchProviders',
        'watchProviderRegion',
        'storage',
        'i18n',
        'log',
        `return async function () {${loaderBody}`
    )(
        seerr,
        watchProviderTarget,
        renderWatchProviders,
        watchProviderRegion,
        { getItem: (key) => (key === 'pref:showWatchProviders' ? preference : 'IT') },
        { t, currentLang: 'it' },
        { warn() {} }
    );
    return {
        _item: { Type: 'Movie', ProviderIds: { Tmdb: '603' } },
        $: () => container,
        load,
        container,
        classes
    };
}

test('background loader shows availability and safely handles missing Seerr or failed requests', async () => {
    const page = pageWith({ isAvailable: async () => true, details: async () => ({ WatchProviders: providers }) });
    await page.load();
    assert.match(page.container.innerHTML, /Subscription service/);
    assert.equal(page.classes.has('hidden'), false);
    for (const service of [
        { isAvailable: async () => false, details: () => assert.fail('Must not query disabled Seerr') },
        {
            isAvailable: async () => true,
            details: async () => {
                throw new Error('offline');
            }
        }
    ]) {
        const unavailable = pageWith(service);
        await unavailable.load();
        assert.equal(unavailable.classes.has('hidden'), true);
        assert.equal(unavailable.container.innerHTML, '');
    }
});

test('late responses cannot render into a destroyed page or overwrite a newer title', async () => {
    for (const destroy of [true, false]) {
        let resolve;
        const pending = new Promise((done) => {
            resolve = done;
        });
        let calls = 0;
        const page = pageWith({
            isAvailable: async () => true,
            details: () => (++calls === 1 ? pending : Promise.resolve({ WatchProviders: [] }))
        });
        const first = page.load();
        await Promise.resolve();
        if (destroy) page._isDestroyed = true;
        else {
            page._item = { Type: 'Movie', ProviderIds: { Tmdb: '604' } };
            await page.load();
        }
        resolve({ WatchProviders: providers });
        await first;
        assert.doesNotMatch(page.container.innerHTML, /Subscription service/);
    }
});

test('older TVs display full country names in settings and title details without Intl.DisplayNames', () => {
    const original = Intl.DisplayNames;
    try {
        Intl.DisplayNames = undefined;
        assert.equal(watchProviderRegionName('IT', 'it-IT'), 'Italia');
        assert.equal(watchProviderRegionName('DE', 'it'), 'Germania');
        assert.equal(watchProviderRegionName('FR', 'en-us'), 'France');
        const html = renderWatchProviders(providers, 'IT', t, 'it');
        assert.match(html, /Dove guardarlo.*Italia/);
        assert.doesNotMatch(html, /Dati sulla disponibilità/);
        assert.doesNotMatch(html, /TMDB|JustWatch/);
        Intl.DisplayNames = function () {
            throw new Error('unsupported locale');
        };
        assert.equal(watchProviderRegionName('IT', 'it'), 'Italia');
    } finally {
        Intl.DisplayNames = original;
    }
});

test('Jellyfin streaming services stay hidden and do not query Seerr until explicitly enabled', async () => {
    for (const preference of [null, '', 'false', true]) {
        const page = pageWith(
            { isAvailable: () => assert.fail('Disabled preference must not query Seerr') },
            preference
        );
        await page.load();
        assert.equal(page.container.innerHTML, '');
        assert.equal(page.classes.has('hidden'), true);
    }
});

test('Seerr streaming services are hidden by default and can be enabled then disabled', () => {
    const source = readFileSync(new URL('../src/pages/SeerrDetailsPage.js', import.meta.url), 'utf8');
    const body = source.split('    _renderDetails() {')[1].split('        const item = this._item;')[0];
    let preference = null;
    const classes = new Set();
    const container = {
        innerHTML: '',
        classList: { toggle: (name, enabled) => (enabled ? classes.add(name) : classes.delete(name)) }
    };
    const render = new Function(
        'storage',
        'renderWatchProviders',
        'watchProviderRegion',
        'i18n',
        `return function () {${body}}`
    )(
        { getItem: (key) => (key === 'pref:showWatchProviders' ? preference : 'IT') },
        renderWatchProviders,
        watchProviderRegion,
        { t, currentLang: 'it' }
    );
    const page = { $: () => container, _item: { WatchProviders: providers } };
    for (const value of [null, 'true', 'false']) {
        preference = value;
        render.call(page);
        assert.equal(classes.has('hidden'), value !== 'true');
        assert.equal(container.innerHTML.includes('Subscription service'), value === 'true');
    }
});
