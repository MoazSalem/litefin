import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

/**
 * ============================================================================
 * webOS Launch Target Test Suite
 * ============================================================================
 * Verifies that a launch with { tmdbId, mediaType } params (PalmSystem stand-in):
 *   1. Opens the library item's details page when its TMDB id is in the library.
 *   2. Opens Seerr's details page when it isn't, and stays put without Seerr.
 *   3. Ignores launches without valid params and Litefin's own reloads.
 *   4. Opens the target on webOSRelaunch while running, with /home as the Back step.
 *   5. Holds the target while the profile picker shows, until a profile is chosen.
 * ============================================================================
 */

const strip = (path) =>
    readFileSync(new URL(path, import.meta.url), 'utf8')
        .replace(/\r\n/g, '\n')
        .replace(/^import [\s\S]*?;\n/gm, '')
        .replace(/^export (const|function|class) /gm, '$1 ')
        .replace(/^export default .*;\n/gm, '');

const adapterSource = strip('../src/webos/WebOSAdapter.js');
const managerSource = strip('../src/webos/LaunchTargetManager.js');

function setup({ launchParams = '', library = [], seerrAvailable = true, seerrJellyfinId = null, path = '/' } = {}) {
    const docListeners = {};
    const busListeners = {};
    const navigations = [];
    const queries = [];
    const session = new Map();
    const stateMap = new Map([['user:authenticated', true]]);
    let currentPath = path;
    let history = [];

    const eventBus = {
        on(name, fn) {
            (busListeners[name] = busListeners[name] || []).push(fn);
            return () => {};
        },
        once(name, fn) {
            return this.on(name, fn);
        },
        emit(name, ...args) {
            (busListeners[name] || []).forEach((fn) => fn(...args));
        }
    };
    const sandbox = {
        navigator: { userAgent: 'Mozilla/5.0 (Web0S; Linux/SmartTV) Chrome/79.0 Safari/537.36 WebAppManager' },
        window: { PalmSystem: { launchParams } },
        document: {
            hidden: false,
            addEventListener: (name, fn) => (docListeners[name] = docListeners[name] || []).push(fn),
            removeEventListener: () => {}
        },
        sessionStorage: {
            getItem: (k) => (session.has(k) ? session.get(k) : null),
            setItem: (k, v) => session.set(k, String(v)),
            removeItem: (k) => session.delete(k)
        },
        logger: { create: () => ({ info() {}, debug() {}, warn() {}, error() {}, verbose() {} }) },
        eventBus,
        storage: { getItem: () => null },
        state: { get: (k, d) => (stateMap.has(k) ? stateMap.get(k) : d) },
        auth: { getCurrentUser: () => ({ Id: 'user1' }) },
        pinManager: { hasPin: () => false },
        router: {
            getCurrentPath: () => currentPath,
            setHistory: (entries) => (history = entries.slice()),
            navigate: (p) => {
                navigations.push({ path: p, history: history.slice() });
                currentPath = p;
            }
        },
        api: {
            getItems: async (q) => {
                // 'hang': a server that never answers
                if (library === 'hang') return new Promise(() => {});
                queries.push(q);
                // A server that ignores AnyProviderIdEquals still answers; only the ProviderIds count
                const items = library.filter(
                    (it) => !q.SearchTerm || it.Name.toLowerCase().includes(q.SearchTerm.toLowerCase())
                );
                return { Items: items.slice(0, q.Limit) };
            }
        },
        seerr: {
            isAvailable: async () => seerrAvailable,
            details: async () => ({ _jellyfinMediaId: seerrJellyfinId })
        },
        setTimeout,
        clearTimeout,
        Promise,
        Date,
        Math,
        JSON,
        String,
        parseInt,
        webosAdapter: null,
        result: null
    };
    // Each module in its own scope (both declare a module-level `log`)
    const context = vm.createContext(sandbox);
    vm.runInContext(`(() => {\n${adapterSource}\nglobalThis.webosAdapter = webosAdapter;\n})();`, context);
    vm.runInContext(`(() => {\n${managerSource}\nresult = { LaunchTargetManager, parseLaunchParams };\n})();`, context);
    const { LaunchTargetManager, parseLaunchParams } = sandbox.result;
    const manager = new LaunchTargetManager();

    return {
        manager,
        parseLaunchParams,
        navigations,
        queries,
        session,
        relaunch: (detail) => (docListeners.webOSRelaunch || []).forEach((fn) => fn({ detail })),
        emit: (name, ...args) => eventBus.emit(name, ...args),
        setPath: (p) => (currentPath = p),
        setLaunchParams: (p) => (sandbox.window.PalmSystem.launchParams = p)
    };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

const MATRIX = { Id: 'jf-matrix', Name: 'The Matrix', ProviderIds: { Tmdb: '603' } };
const OTHER = { Id: 'jf-other', Name: 'Another Film', ProviderIds: { Tmdb: '999' } };

test('parseLaunchParams accepts movie/tv/series, supports nested params wrapper, and rejects the rest', () => {
    const { parseLaunchParams } = setup();
    assert.deepEqual(JSON.parse(JSON.stringify(parseLaunchParams({ tmdbId: '603', mediaType: 'movie' }))), {
        tmdbId: 603,
        mediaType: 'movie',
        title: ''
    });
    // Supports nested params wrapper as sent by luna://com.webos.applicationManager/launch
    assert.deepEqual(
        JSON.parse(
            JSON.stringify(
                parseLaunchParams({
                    id: 'org.litefin.app',
                    params: { tmdbId: 603, mediaType: 'movie', title: 'The Matrix' }
                })
            )
        ),
        {
            tmdbId: 603,
            mediaType: 'movie',
            title: 'The Matrix'
        }
    );
    assert.equal(parseLaunchParams({ tmdbId: 1399, mediaType: 'series' }).mediaType, 'tv');
    assert.equal(parseLaunchParams({ tmdbId: 603, mediaType: 'person' }), null);
    assert.equal(parseLaunchParams({ mediaType: 'movie' }), null);
    assert.equal(parseLaunchParams({}), null);
    assert.equal(parseLaunchParams(null), null);
});

test('cold start: a launch with a nested params wrapper opens the title', async () => {
    const t = setup({
        launchParams: '{"id":"org.litefin.app","params":{"tmdbId":603,"mediaType":"movie"}}',
        library: [MATRIX]
    });
    await t.manager.init();
    assert.equal(t.manager.openStartupTarget(), true);
    await flush();
    assert.deepEqual(JSON.parse(JSON.stringify(t.navigations)), [{ path: '/details/jf-matrix', history: ['/home'] }]);
});

test('cold start: a title in the library opens its details page', async () => {
    const t = setup({ launchParams: '{"tmdbId":603,"mediaType":"movie"}', library: [OTHER, MATRIX] });
    await t.manager.init();
    assert.equal(t.manager.openStartupTarget(), true);
    await flush();
    assert.deepEqual(JSON.parse(JSON.stringify(t.navigations)), [{ path: '/details/jf-matrix', history: ['/home'] }]);
    assert.equal(t.queries[0].AnyProviderIdEquals, 'tmdb.603');
    assert.equal(t.queries[0].IncludeItemTypes, 'Movie');
});

test('cold start: the title search finds it when the id filter is ignored', async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
        Id: `x${i}`,
        Name: `Film ${i}`,
        ProviderIds: { Tmdb: `${i}` }
    }));
    const t = setup({
        launchParams: '{"tmdbId":603,"mediaType":"movie","title":"The Matrix"}',
        library: [...many, MATRIX]
    });
    await t.manager.init();
    t.manager.openStartupTarget();
    await flush();
    assert.equal(t.navigations[0].path, '/details/jf-matrix');
    assert.ok(t.queries.some((q) => q.SearchTerm === 'The Matrix'));
});

test('cold start: a title missing from the library opens Seerr', async () => {
    const t = setup({ launchParams: '{"tmdbId":1399,"mediaType":"tv"}', library: [OTHER] });
    await t.manager.init();
    assert.equal(t.manager.openStartupTarget(), true);
    await flush();
    assert.equal(t.navigations[0].path, '/seerr/tv/1399');
    assert.equal(t.queries[0].IncludeItemTypes, 'Series');
});

test('cold start: Seerr knowing the Jellyfin id opens the details page', async () => {
    const t = setup({ launchParams: '{"tmdbId":1399,"mediaType":"tv"}', seerrJellyfinId: 'jf-got' });
    await t.manager.init();
    t.manager.openStartupTarget();
    await flush();
    assert.equal(t.navigations[0].path, '/details/jf-got');
});

test('cold start: a library lookup that never answers still opens Seerr', async () => {
    const t = setup({ launchParams: '{"tmdbId":1399,"mediaType":"tv"}', library: 'hang' });
    await t.manager.init();
    assert.equal(t.manager.openStartupTarget(), true);
    await flush();
    assert.equal(t.navigations[0].path, '/seerr/tv/1399');
});

test('cold start: without Seerr and without a match Litefin opens as usual', async () => {
    const t = setup({ launchParams: '{"tmdbId":1399,"mediaType":"tv"}', seerrAvailable: false });
    await t.manager.init();
    assert.equal(t.manager.openStartupTarget(), false);
    assert.equal(t.navigations.length, 0);
});

test('a launch from the home screen or with bad params is ignored', async () => {
    for (const launchParams of ['', '{}', 'not json', '{"tmdbId":"abc","mediaType":"movie"}']) {
        const t = setup({ launchParams, library: [MATRIX] });
        await t.manager.init();
        assert.equal(t.manager.openStartupTarget(), false, launchParams);
        assert.equal(t.queries.length, 0, launchParams);
    }
});

test("Litefin's own reload does not replay the launch params", async () => {
    const t = setup({ launchParams: '{"tmdbId":603,"mediaType":"movie"}', library: [MATRIX] });
    t.session.set('litefin:launch_booted', '1');
    await t.manager.init();
    assert.equal(t.manager.openStartupTarget(), false);
});

test('relaunch while running opens the target with /home as the Back step', async () => {
    const t = setup({ library: [MATRIX], path: '/library/abc' });
    await t.manager.init();
    t.setLaunchParams('{"tmdbId":603,"mediaType":"movie"}');
    t.relaunch({ tmdbId: 603, mediaType: 'movie' });
    await flush();
    assert.deepEqual(JSON.parse(JSON.stringify(t.navigations)), [{ path: '/details/jf-matrix', history: ['/home'] }]);
});

test('relaunch from the app icon (empty params) changes nothing', async () => {
    const t = setup({ library: [MATRIX], path: '/library/abc' });
    await t.manager.init();
    t.relaunch({});
    await flush();
    assert.equal(t.navigations.length, 0);
});

test('relaunch on the profile picker holds the target until a profile is chosen', async () => {
    const t = setup({ library: [MATRIX], path: '/profiles' });
    await t.manager.init();
    t.relaunch({ tmdbId: 603, mediaType: 'movie' });
    await flush();
    assert.equal(t.navigations.length, 0);
    t.emit('auth:login', { Id: 'user1' });
    await flush();
    assert.equal(t.navigations[0].path, '/details/jf-matrix');
});
