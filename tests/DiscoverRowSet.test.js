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

const { resolveDiscoverRows } = await import('../src/pages/discover/DiscoverRowSet.js');

/**
 * ============================================================================
 * Unit Tests: Discover Row Set
 * ============================================================================
 * Verifies that:
 *   - Seerr slider order and enabled state decide the Discover rows
 *   - Built-in sliders keep their stable row keys
 *   - Custom sliders become rows with their Seerr title and catalog fetch
 *   - Missing/failed slider config falls back to the built-in row list
 *   - A cached row set rebuilds rows without any network request
 *   - row.load() never throws
 * ============================================================================
 */

const DEFAULT_KEYS = [
    'recentlyAdded',
    'requests',
    'watchlist',
    'trending',
    'movies',
    'genreMovies',
    'upcomingMovies',
    'studios',
    'series',
    'genreSeries',
    'upcomingSeries',
    'networks'
];

/** Fake Seerr client: every method records its call and returns one item. */
function fakeClient(sliders) {
    const calls = [];
    let settingsCalls = 0;
    const handler = {
        get(target, name) {
            if (name === 'calls') return calls;
            if (name === 'settingsCalls') return settingsCalls;
            if (name === 'discoverSettings') {
                return async () => {
                    settingsCalls++;
                    if (sliders instanceof Error) throw sliders;
                    return sliders;
                };
            }
            if (name in target) return target[name];
            return async (...args) => {
                calls.push([name, ...args]);
                return [{ Id: `${String(name)}-item` }];
            };
        }
    };
    return new Proxy({}, handler);
}

const slider = (id, type, order, extra = {}) => ({ id, type, order, enabled: true, isBuiltIn: type <= 12, ...extra });

test('falls back to the built-in rows when the plugin has no slider config', async () => {
    for (const sliders of [null, [], [{ id: 1, type: 99, order: 0, enabled: true }]]) {
        const client = fakeClient(sliders);
        const { rows, cacheEntry } = await resolveDiscoverRows({}, { client });
        assert.deepEqual(
            rows.map((r) => r.key),
            DEFAULT_KEYS,
            JSON.stringify(sliders)
        );
        assert.equal(client.settingsCalls, 1);
        assert.ok(cacheEntry && 'sliders' in cacheEntry);
    }
});

test('follows Seerr order and enabled state, keeping built-in keys', async () => {
    const client = fakeClient([
        slider(4, 4, 0),
        slider(1, 1, 1),
        slider(2, 2, 2, { enabled: false }),
        slider(8, 8, 3),
        slider(12, 12, 4)
    ]);
    const { rows } = await resolveDiscoverRows({}, { client });
    assert.deepEqual(
        rows.map((r) => r.key),
        ['trending', 'recentlyAdded', 'studios', 'networks']
    );
    assert.deepEqual(
        rows.map((r) => r.noCardLabels),
        [false, false, true, true]
    );
    assert.deepEqual(
        rows.map((r) => r.cardType),
        ['poster', 'poster', 'landscape', 'landscape']
    );
});

test('sorts by order even if Seerr returns sliders unsorted', async () => {
    const client = fakeClient([slider(9, 9, 5), slider(5, 5, 1), slider(4, 4, 3)]);
    const { rows } = await resolveDiscoverRows({}, { client });
    assert.deepEqual(
        rows.map((r) => r.key),
        ['movies', 'trending', 'series']
    );
});

test('custom sliders become rows with Seerr titles and catalog fetches', async () => {
    const client = fakeClient([
        slider(4, 4, 0),
        slider(21, 20, 1, { title: 'Netflix & Prime <DE>', data: 'DE,8|9' }),
        slider(22, 13, 2, { title: 'Superhelden', data: '9715' }),
        slider(23, 17, 3, { title: 'Star Wars', data: 'star wars' }),
        slider(24, 19, 4, { title: 'Broken', data: 'nope' })
    ]);
    const { rows } = await resolveDiscoverRows({}, { client });
    assert.deepEqual(
        rows.map((r) => [r.key, r.title, r.cardType]),
        [
            ['trending', rows[0].title, 'poster'],
            ['custom-21', 'Netflix & Prime <DE>', 'poster'],
            ['custom-22', 'Superhelden', 'poster'],
            ['custom-23', 'Star Wars', 'poster']
        ]
    );

    for (const row of rows) {
        const items = await row.load();
        assert.equal(items.length, 1, row.key);
    }
    assert.ok(client.calls.some((c) => c[0] === 'discoverTrending'));
    const streaming = client.calls.find((c) => c[0] === 'discoverMovies' && c[2] && c[2].watchProviders);
    assert.equal(streaming[2].watchRegion, 'DE');
    assert.equal(streaming[2].watchProviders, '8|9');
    const keyword = client.calls.find((c) => c[0] === 'discoverMovies' && c[2] && c[2].keywords);
    assert.equal(keyword[2].keywords, '9715');
    assert.ok(client.calls.some((c) => c[0] === 'search' && c[1] === 'star wars' && c[2] === 1));
});

test('a cached row set rebuilds the same rows without a network request', async () => {
    const sliders = [slider(4, 4, 0), slider(30, 14, 1, { title: 'Action', data: '28' })];
    const first = await resolveDiscoverRows({}, { client: fakeClient(sliders) });

    const offline = fakeClient(new Error('must not be called'));
    const second = await resolveDiscoverRows({ cached: first.cacheEntry }, { client: offline });
    assert.equal(offline.settingsCalls, 0);
    assert.deepEqual(
        second.rows.map((r) => r.key),
        first.rows.map((r) => r.key)
    );

    // Caches written before row sets existed (sliders: null) restore the built-in rows
    const legacy = await resolveDiscoverRows({ cached: { sliders: null } }, { client: offline });
    assert.equal(offline.settingsCalls, 0);
    assert.deepEqual(
        legacy.rows.map((r) => r.key),
        DEFAULT_KEYS
    );
});

test('row.load() never throws and returns an empty list on failure', async () => {
    const client = fakeClient([slider(4, 4, 0)]);
    const failing = new Proxy(client, {
        get(target, name) {
            if (name === 'discoverTrending') {
                return async () => {
                    throw new Error('upstream down');
                };
            }
            return target[name];
        }
    });
    const { rows } = await resolveDiscoverRows({}, { client: failing });
    assert.deepEqual(await rows[0].load(), []);
});
