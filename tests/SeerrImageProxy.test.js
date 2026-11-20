import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

/**
 * ============================================================================
 * Unit Tests: Seerr Image Proxy
 * ============================================================================
 * TMDB image URLs are rewritten onto the Litefin server plugin's Seerr image
 * proxy only while the plugin advertises it for the current server, so
 * airgapped clients never reach out to image.tmdb.org.
 * ============================================================================
 */

// Browser shims so seerrClient (and ApiClient) load under node
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
if (typeof globalThis.sessionStorage === 'undefined') {
    const map = new Map();
    globalThis.sessionStorage = {
        getItem: (k) => map.get(k) ?? null,
        setItem: (k, v) => map.set(k, String(v)),
        removeItem: (k) => map.delete(k),
        clear: () => map.clear()
    };
}
if (typeof globalThis.__APP_VERSION__ === 'undefined') {
    globalThis.__APP_VERSION__ = '1.0.0';
}

const { normalizeSeerrItem, setTmdbImageResolver, tmdbImage, tmdbUrl } = await import('../src/api/seerrNormalize.js');
const { buildGenreSliderItems, buildStudioItems } = await import('../src/utils/seerrGenres.js');
const { renderWatchProviders } = await import('../src/utils/WatchProviders.js');
const { api } = await import('../src/api/ApiClient.js');
const { SeerrClient } = await import('../src/api/seerrClient.js');

const SERVER = 'http://jellyfin.local:8096';
const OTHER_SERVER = 'http://other.local:8096';
const PROXY = `${SERVER}/Litefin/Seerr/Image`;

const useProxy = () => setTmdbImageResolver(() => PROXY);

test.afterEach(() => {
    setTmdbImageResolver(null);
    sessionStorage.clear();
});

// ============================================================================
// URL helpers
// ============================================================================

test('tmdbImage leaves URLs untouched while no proxy is available', () => {
    assert.equal(tmdbImage('https://image.tmdb.org/t/p/w500/a.jpg'), 'https://image.tmdb.org/t/p/w500/a.jpg');
});

test('tmdbImage rewrites TMDB URLs onto the proxy base', () => {
    setTmdbImageResolver(() => `${PROXY}/`);
    assert.equal(tmdbImage('https://image.tmdb.org/t/p/w500/a.jpg'), `${PROXY}/t/p/w500/a.jpg`);
    assert.equal(
        tmdbImage('https://image.tmdb.org/t/p/w1280_filter(duotone,991B1B,FCA5A5)/b.jpg'),
        `${PROXY}/t/p/w1280_filter(duotone,991B1B,FCA5A5)/b.jpg`
    );
});

test('tmdbImage ignores non-TMDB values', () => {
    useProxy();
    assert.equal(tmdbImage(''), '');
    assert.equal(tmdbImage(null), null);
    assert.equal(tmdbImage(undefined), undefined);
    assert.equal(tmdbImage(`${SERVER}/Items/1/Images/Primary`), `${SERVER}/Items/1/Images/Primary`);
});

test('tmdbImage resolves the base each time a URL is built', () => {
    let base = null;
    setTmdbImageResolver(() => base);
    assert.equal(tmdbImage('https://image.tmdb.org/t/p/w300/a.jpg'), 'https://image.tmdb.org/t/p/w300/a.jpg');
    base = PROXY;
    assert.equal(tmdbImage('https://image.tmdb.org/t/p/w300/a.jpg'), `${PROXY}/t/p/w300/a.jpg`);
});

test('tmdbUrl builds TMDB or proxy URLs and returns empty for no path', () => {
    assert.equal(tmdbUrl('w300', '/p.jpg'), 'https://image.tmdb.org/t/p/w300/p.jpg');
    assert.equal(tmdbUrl('w780', 'logo.png'), 'https://image.tmdb.org/t/p/w780/logo.png');
    assert.equal(tmdbUrl('w300', ''), '');
    assert.equal(tmdbUrl('w300', null), '');
    useProxy();
    assert.equal(tmdbUrl('w300', '/p.jpg'), `${PROXY}/t/p/w300/p.jpg`);
});

test('normalized Seerr items, genre and studio cards use the proxy', () => {
    useProxy();
    const item = normalizeSeerrItem({
        id: 1,
        mediaType: 'movie',
        title: 'Movie',
        posterPath: '/p.jpg',
        backdropPath: '/b.jpg'
    });
    assert.equal(item._imageUrl, `${PROXY}/t/p/w300/p.jpg`);
    assert.equal(item._detailImageUrl, `${PROXY}/t/p/w500/p.jpg`);
    assert.equal(item._backdropUrl, `${PROXY}/t/p/w1280/b.jpg`);

    const [action] = buildGenreSliderItems([{ id: 28, name: 'Action' }], 'movie');
    assert.ok(action._imageUrl.startsWith(`${PROXY}/t/p/w1280_filter(duotone,`));

    for (const studio of buildStudioItems()) {
        assert.ok(studio._imageUrl.startsWith(`${PROXY}/t/p/w780_filter(duotone,ffffff,bababa)/`));
    }
});

test('watch provider logos use the proxy', () => {
    useProxy();
    const html = renderWatchProviders(
        [{ iso_3166_1: 'US', flatrate: [{ id: 8, name: 'Netflix', logoPath: '/logo.jpg' }] }],
        'US',
        (key) => key,
        'en'
    );
    assert.match(html, /src="http:\/\/jellyfin\.local:8096\/Litefin\/Seerr\/Image\/t\/p\/w92\/logo\.jpg"/);
    assert.doesNotMatch(html, /image\.tmdb\.org/);
});

test('no TMDB image URLs are hand-built outside the URL helpers', () => {
    // Full URLs in the genre image map are fine: they are passed through tmdbImage
    const allowed = new Set([join('src', 'api', 'seerrNormalize.js'), join('src', 'utils', 'seerrGenres.js')]);
    const offenders = [];
    const walk = (dir) => {
        for (const name of readdirSync(dir)) {
            const path = join(dir, name);
            if (statSync(path).isDirectory()) walk(path);
            else if (path.endsWith('.js') && !allowed.has(path)) {
                if (readFileSync(path, 'utf8').includes('image.tmdb.org/t/p/')) offenders.push(path);
            }
        }
    };
    walk('src');
    assert.deepEqual(offenders, []);
});

// ============================================================================
// SeerrClient status → image base
// ============================================================================

/**
 * Builds a client against a stubbed ApiClient whose Status payload is controlled.
 * @param {Object|Error} payload
 */
function makeClient(payload) {
    api.setServer(SERVER);
    api._hasLitefinServerPlugin = true;
    const calls = [];
    api.get = async (endpoint) => {
        calls.push(endpoint);
        if (endpoint === '/Litefin/Seerr/Status') {
            if (payload instanceof Error) throw payload;
            return payload;
        }
        return { id: 1, mediaType: 'movie', title: 'Movie', posterPath: '/p.jpg' };
    };
    return { client: new SeerrClient(), calls };
}

const POSTER = 'https://image.tmdb.org/t/p/w300/p.jpg';

test('proxy is used once the plugin advertises it', async () => {
    const { client } = makeClient({ configured: true, available: true, imageProxy: true });
    assert.equal(tmdbImage(POSTER), POSTER);
    await client.status();
    assert.equal(tmdbImage(POSTER), `${PROXY}/t/p/w300/p.jpg`);
});

test('proxy is not used when the plugin does not advertise it', async () => {
    const { client } = makeClient({ configured: true, available: true });
    await client.status();
    assert.equal(tmdbImage(POSTER), POSTER);
});

test('data requests probe status first so deep-linked pages get the proxy', async () => {
    const { client, calls } = makeClient({ configured: true, available: true, imageProxy: true });
    const item = await client.details('movie', 1);
    assert.equal(calls[0], '/Litefin/Seerr/Status');
    assert.equal(item._imageUrl, `${PROXY}/t/p/w300/p.jpg`);
});

test('clearResponseCache keeps the proxy, clearCache drops it until re-probed', async () => {
    const { client } = makeClient({ configured: true, available: true, imageProxy: true });
    await client.status();
    client.clearResponseCache();
    assert.equal(tmdbImage(POSTER), `${PROXY}/t/p/w300/p.jpg`);
    client.clearCache();
    assert.equal(tmdbImage(POSTER), POSTER);
    await client.details('movie', 1);
    assert.equal(tmdbImage(POSTER), `${PROXY}/t/p/w300/p.jpg`);
});

test('a failed forced re-probe falls back to TMDB', async () => {
    const payload = { configured: true, available: true, imageProxy: true };
    const { client } = makeClient(payload);
    await client.status();
    api.get = async () => {
        throw new Error('offline');
    };
    await client.status(true);
    assert.equal(tmdbImage(POSTER), POSTER);
});

test('the proxy follows the server URL at build time, not at probe time', async () => {
    api.setServer('');
    api._hasLitefinServerPlugin = true;
    api.get = async () => ({ configured: true, available: true, imageProxy: true });
    // Status restored from the session before the server URL is set
    sessionStorage.setItem(
        'seerr:session_status',
        JSON.stringify({ configured: true, available: true, imageProxy: true, serverUrl: SERVER })
    );
    const client = new SeerrClient();
    api.setServer(SERVER);
    await client.status();
    assert.equal(tmdbImage(POSTER), `${PROXY}/t/p/w300/p.jpg`);
});

test('a status cached for another server is ignored', async () => {
    const { client, calls } = makeClient({ configured: true, available: true, imageProxy: true });
    await client.status();
    api.setServer(OTHER_SERVER);
    // Never routes images to the previous server's proxy
    assert.equal(tmdbImage(POSTER), POSTER);

    api._hasLitefinServerPlugin = true;
    const before = calls.length;
    await client.status();
    assert.equal(calls.length, before + 1, 'status is re-probed on the new server');
    assert.equal(tmdbImage(POSTER), `${OTHER_SERVER}/Litefin/Seerr/Image/t/p/w300/p.jpg`);
});

test('a session-cached status from another server is not restored', async () => {
    sessionStorage.setItem(
        'seerr:session_status',
        JSON.stringify({ configured: true, available: true, imageProxy: true, serverUrl: OTHER_SERVER })
    );
    const { client, calls } = makeClient({ configured: true, available: true, imageProxy: false });
    await client.status();
    assert.equal(calls[0], '/Litefin/Seerr/Status');
    assert.equal(tmdbImage(POSTER), POSTER);
});
