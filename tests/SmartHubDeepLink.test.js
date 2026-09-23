import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

/**
 * ============================================================================
 * Smart Hub Deep Link & Router History Stack Test Suite
 * ============================================================================
 * Verifies that:
 *   1. Router.setHistory seeds the navigation history stack properly.
 *   2. Router.getHistory returns a snapshot of the current history stack.
 *   3. Smart Hub deep linking into a Movie seeds ['/home'] so Back returns to /home.
 *   4. Smart Hub deep linking into an Episode with seriesId seeds
 *      ['/home', '/details/${seriesId}'] so Back walks episode -> series -> home.
 *   5. Router.navigate to identical path triggers re-route without loop.
 * ============================================================================
 */

// Load Router.js source code with imports/exports stripped for VM execution
const routerSource = readFileSync(new URL('../src/core/Router.js', import.meta.url), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/^import .*;\n/gm, '')
    .replace(/^export const router = .*;\n/gm, 'const router = new Router();\n')
    .replace(/^export default .*;\n/gm, '');

function createRouterInstance(initialHash = '') {
    let currentHash = initialHash;
    const hashChangeListeners = [];

    const fakeWindow = {
        location: {
            get hash() {
                return currentHash;
            },
            set hash(val) {
                const formatted = val.startsWith('#') ? val : `#${val}`;
                if (currentHash !== formatted) {
                    currentHash = formatted;
                    hashChangeListeners.forEach((fn) => fn());
                }
            },
            replace(val) {
                const formatted = val.startsWith('#') ? val : `#${val}`;
                currentHash = formatted;
                hashChangeListeners.forEach((fn) => fn());
            }
        },
        addEventListener(evt, fn) {
            if (evt === 'hashchange') {
                hashChangeListeners.push(fn);
            }
        },
        removeEventListener(evt, fn) {
            if (evt === 'hashchange') {
                const idx = hashChangeListeners.indexOf(fn);
                if (idx !== -1) hashChangeListeners.splice(idx, 1);
            }
        }
    };

    const logs = [];
    const events = [];
    const stateMap = new Map();

    const sandbox = {
        window: fakeWindow,
        document: {
            getElementById: () => null
        },
        eventBus: {
            emit: (name, payload) => events.push({ name, payload })
        },
        state: {
            set: (k, v) => stateMap.set(k, v),
            get: (k, def) => (stateMap.has(k) ? stateMap.get(k) : def)
        },
        navigationState: {
            captureState: () => ({ focus: 'mock-focus' })
        },
        logger: {
            create: () => ({
                info: (...args) => logs.push({ level: 'info', args }),
                debug: (...args) => logs.push({ level: 'debug', args }),
                warn: (...args) => logs.push({ level: 'warn', args }),
                error: (...args) => logs.push({ level: 'error', args })
            })
        },
        pluginManager: {
            notifyPageLoad: () => {},
            notifyPageUnload: () => {}
        },
        URLSearchParams,
        RegExp,
        Array,
        Object,
        Router: null
    };

    // Execute the class definition
    vm.runInNewContext(`${routerSource}\nsandbox.Router = Router;`, { ...sandbox, sandbox });

    const RouterClass = sandbox.Router;
    const router = new RouterClass();

    return {
        router,
        fakeWindow,
        events,
        getHash: () => currentHash
    };
}

test('Router.setHistory seeds history stack and getHistory returns entries', () => {
    const { router } = createRouterInstance();

    router.register('/home', class HomePage {});
    router.register('/details/:id', class DetailsPage {});
    router.init();

    // Seed history with /home
    router.setHistory(['/home']);
    assert.deepEqual(
        JSON.parse(JSON.stringify(router.getHistory())),
        [{ path: '/home', state: null }]
    );

    // Navigate to details page
    router.navigate('/details/movie-123');

    // History should now contain both /home and /details/movie-123
    const history = router.getHistory();
    assert.equal(history.length, 2);
    assert.equal(history[0].path, '/home');
    assert.equal(history[1].path, '/details/movie-123');
    assert.equal(router.canGoBack(), true);

    // Pressing back should return to /home
    const couldGoBack = router.back();
    assert.equal(couldGoBack, true);
    assert.equal(router.getCurrentPath(), '/home');
    assert.equal(router.getHistory().length, 1);
});

test('Smart Hub Movie deep link seeds /home and returns to /home on back', () => {
    const { router } = createRouterInstance();

    router.register('/home', class HomePage {});
    router.register('/details/:id', class DetailsPage {});
    router.init();

    // Emulate SmartHubManager._navigateToItem for a movie
    const movieActionData = { id: 'movie-abc', type: 'movie' };
    const breadcrumbs = ['/home'];
    router.setHistory(breadcrumbs);
    router.navigate(`/details/${movieActionData.id}`);

    assert.equal(router.getCurrentPath(), '/details/movie-abc');
    assert.deepEqual(
        [...router.getHistory().map((e) => String(e.path))],
        ['/home', '/details/movie-abc']
    );

    // First Back press returns to /home
    const backed = router.back();
    assert.equal(backed, true);
    assert.equal(router.getCurrentPath(), '/home');

    // Second Back press has nowhere left in history
    assert.equal(router.canGoBack(), false);
});

test('Smart Hub Episode deep link seeds /home and series details into history hierarchy', () => {
    const { router } = createRouterInstance();

    router.register('/home', class HomePage {});
    router.register('/details/:id', class DetailsPage {});
    router.init();

    // Emulate SmartHubManager._navigateToItem for an episode with seriesid
    const episodeActionData = {
        id: 'episode-999',
        type: 'episode',
        seriesid: 'series-888'
    };

    const breadcrumbs = ['/home'];
    if (episodeActionData.type === 'episode' && episodeActionData.seriesid) {
        breadcrumbs.push(`/details/${episodeActionData.seriesid}`);
    }
    router.setHistory(breadcrumbs);
    router.navigate(`/details/${episodeActionData.id}`);

    assert.equal(router.getCurrentPath(), '/details/episode-999');
    assert.deepEqual(
        [...router.getHistory().map((e) => String(e.path))],
        ['/home', '/details/series-888', '/details/episode-999']
    );

    // First Back: goes to series details
    assert.equal(router.back(), true);
    assert.equal(router.getCurrentPath(), '/details/series-888');

    // Second Back: goes to homepage
    assert.equal(router.back(), true);
    assert.equal(router.getCurrentPath(), '/home');

    // Third Back: at root of history
    assert.equal(router.canGoBack(), false);
});
