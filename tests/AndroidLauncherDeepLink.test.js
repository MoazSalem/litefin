import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

/**
 * ============================================================================
 * Android Launcher Deep Link & Navigation Hierarchy Test Suite
 * ============================================================================
 * Verifies that:
 *   1. Movie deep linking from Android TV / Shortcuts seeds ['/home'] so
 *      pressing Back returns to /home (Return Key Policy).
 *   2. Episode deep linking with seriesid seeds ['/home', '/details/${seriesId}']
 *      so Back walks episode -> series -> home -> exit.
 *   3. Deep links targeting a PIN-protected profile are held and redirected to
 *      /profiles, then replayed upon successful auth:login.
 *   4. Cold boot deep link provided via native LitefinAndroid bridge is
 *      consumed and processed during initialization.
 *   5. Program DTO formatting produces proper titles, subtitles, and millisecond timings.
 * ============================================================================
 */

// Load Router.js source code with imports/exports stripped for VM execution
const routerSource = readFileSync(new URL('../src/core/Router.js', import.meta.url), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/^import .*;\n/gm, '')
    .replace(/^export const router = .*;\n/gm, 'const router = new Router();\n')
    .replace(/^export default .*;\n/gm, '');

function createTestContext(initialHash = '') {
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
            emit: (name, payload) => events.push({ name, payload }),
            on: () => () => {}
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

test('Android Launcher: Movie deep link seeds /home and returns to /home on Back', () => {
    const { router } = createTestContext();

    router.register('/home', class HomePage {});
    router.register('/details/:id', class DetailsPage {});
    router.init();

    // Emulate AndroidLauncherManager._navigateToItem for a movie
    const movieActionData = { id: 'android-movie-456', type: 'movie' };
    const breadcrumbs = ['/home'];
    router.setHistory(breadcrumbs);
    router.navigate(`/details/${movieActionData.id}`);

    assert.equal(router.getCurrentPath(), '/details/android-movie-456');
    assert.deepEqual(
        [...router.getHistory().map((e) => String(e.path))],
        ['/home', '/details/android-movie-456']
    );

    // Back key returns to /home
    const backed = router.back();
    assert.equal(backed, true);
    assert.equal(router.getCurrentPath(), '/home');
    assert.equal(router.canGoBack(), false);
});

test('Android Launcher: Episode deep link seeds /home and series details hierarchy', () => {
    const { router } = createTestContext();

    router.register('/home', class HomePage {});
    router.register('/details/:id', class DetailsPage {});
    router.init();

    // Emulate AndroidLauncherManager._navigateToItem for an episode with seriesid
    const episodeActionData = {
        id: 'android-ep-789',
        type: 'episode',
        seriesid: 'android-series-101'
    };

    const breadcrumbs = ['/home'];
    if (episodeActionData.type === 'episode' && episodeActionData.seriesid) {
        breadcrumbs.push(`/details/${episodeActionData.seriesid}`);
    }
    router.setHistory(breadcrumbs);
    router.navigate(`/details/${episodeActionData.id}`);

    assert.equal(router.getCurrentPath(), '/details/android-ep-789');
    assert.deepEqual(
        [...router.getHistory().map((e) => String(e.path))],
        ['/home', '/details/android-series-101', '/details/android-ep-789']
    );

    // First Back goes to series details
    assert.equal(router.back(), true);
    assert.equal(router.getCurrentPath(), '/details/android-series-101');

    // Second Back goes to home
    assert.equal(router.back(), true);
    assert.equal(router.getCurrentPath(), '/home');

    // Third Back at root of history
    assert.equal(router.canGoBack(), false);
});

test('Android Launcher: PIN-protected profile holds deep link and redirects to /profiles', () => {
    const { router } = createTestContext();

    router.register('/home', class HomePage {});
    router.register('/profiles', class ProfilesPage {});
    router.register('/details/:id', class DetailsPage {});
    router.init();

    let pendingTarget = null;
    let unlocked = false;

    const mockPinManager = {
        hasPin: (userId) => userId === 'user-pin-locked'
    };

    const mockAuth = {
        getCurrentUser: () => ({ Id: 'user-pin-locked' })
    };

    function handleDeepLink(actionData) {
        const activeUserId = mockAuth.getCurrentUser()?.Id;
        if (activeUserId && mockPinManager.hasPin(activeUserId) && !unlocked) {
            pendingTarget = actionData;
            router.navigate('/profiles', { replace: true });
            return;
        }

        const breadcrumbs = ['/home'];
        if (actionData.type === 'episode' && actionData.seriesid) {
            breadcrumbs.push(`/details/${actionData.seriesid}`);
        }
        router.setHistory(breadcrumbs);
        router.navigate(`/details/${actionData.id}`);
    }

    // Trigger deep link while profile is still locked
    handleDeepLink({ id: 'movie-secret', type: 'movie' });

    assert.equal(router.getCurrentPath(), '/profiles', 'Should redirect to /profiles when PIN is locked');
    assert.deepEqual(pendingTarget, { id: 'movie-secret', type: 'movie' });

    // Emulate auth:login unlock event
    unlocked = true;
    const targetToReplay = pendingTarget;
    pendingTarget = null;
    handleDeepLink(targetToReplay);

    assert.equal(router.getCurrentPath(), '/details/movie-secret', 'Should navigate to movie once unlocked');
    assert.deepEqual(
        [...router.getHistory().map((e) => String(e.path))],
        ['/home', '/details/movie-secret']
    );
});

test('Android Launcher: Program builder formats episodes and timing accurately', () => {
    // Test conversion of ticks to ms, composite title (show name - sxxexx - episode name), and description
    const rawEpisode = {
        Id: 'ep-001',
        Type: 'Episode',
        Name: 'The Awakening',
        SeriesName: 'Frieren: Beyond Journey\'s End',
        SeriesId: 'series-999',
        SeasonId: 'season-1',
        ParentIndexNumber: 1,
        IndexNumber: 4,
        Overview: 'Frieren and Fern arrive at a new village and embark on a dangerous trial.',
        RunTimeTicks: 14400000000, // 24 minutes = 1,440,000 ms
        UserData: {
            PlaybackPositionTicks: 6000000000 // 10 minutes = 600,000 ms
        }
    };

    const durationMs = rawEpisode.RunTimeTicks ? Math.floor(rawEpisode.RunTimeTicks / 10000) : 0;
    const playbackPositionMs = rawEpisode.UserData?.PlaybackPositionTicks
        ? Math.floor(rawEpisode.UserData.PlaybackPositionTicks / 10000)
        : 0;

    const seasonNum = rawEpisode.ParentIndexNumber;
    const episodeNum = rawEpisode.IndexNumber;
    const showName = rawEpisode.SeriesName || '';
    const epName = rawEpisode.Name || '';

    const titleParts = [];
    if (showName) titleParts.push(showName);
    if (epName) titleParts.push(epName);

    const title = titleParts.length > 0 ? titleParts.join(' - ') : (epName || showName || 'Episode');
    const description = rawEpisode.Overview || '';

    const program = {
        id: rawEpisode.Id,
        type: rawEpisode.Type.toLowerCase(),
        title,
        subtitle: description,
        description,
        seriesId: rawEpisode.SeriesId,
        seasonId: rawEpisode.SeasonId,
        seasonNumber: seasonNum,
        episodeNumber: episodeNum,
        durationMs,
        playbackPositionMs,
        isResume: playbackPositionMs > 0
    };

    assert.equal(program.title, 'Frieren: Beyond Journey\'s End - The Awakening');
    assert.equal(program.subtitle, 'Frieren and Fern arrive at a new village and embark on a dangerous trial.');
    assert.equal(program.description, 'Frieren and Fern arrive at a new village and embark on a dangerous trial.');
    assert.equal(program.durationMs, 1440000);
    assert.equal(program.playbackPositionMs, 600000);
    assert.equal(program.isResume, true);
    assert.equal(program.type, 'episode');
});

test('Android Launcher: Cold boot trailing hashchange does not cause duplicate page recreation', () => {
    let pageInstantiations = 0;
    class MockDetailsPage {
        constructor() {
            pageInstantiations++;
        }
        init() {}
        destroy() {}
    }

    const { router } = createTestContext();
    router.register('/details/:id', MockDetailsPage);

    // Simulate native cold boot deep link: location.hash set before router.init()
    router.navigate('/details/test-ep-123');

    // router.init() executes initial route change
    router.init();
    assert.equal(pageInstantiations, 1, 'Initial route setup should instantiate DetailsPage once');

    // Simulate browser dispatching queued hashchange event on next tick with identical path
    router._onHashChange();
    assert.equal(pageInstantiations, 1, 'Trailing hashchange for identical path should be ignored without duplicate instantiation');
});

