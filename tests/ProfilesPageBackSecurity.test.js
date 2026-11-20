import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/**
 * ============================================================================
 * Profile Switcher & Root Gateway Back Navigation Security Test Suite
 * ============================================================================
 * Validates that:
 * 1. `router.canGoBack()` returns false on root/gateway routes (/profiles,
 *    /login, /offline, /home) when history has only one entry (cold boot).
 * 2. `router.back()` refuses to fall back to /home when invoked on /profiles
 *    with an empty history stack, preventing PIN and auth bypass.
 * 3. `router.canGoBack()` and `router.back()` preserve normal back navigation
 *    when /profiles was opened from within an active session (history > 1).
 * 4. `ProfilesPage.onBack()` emits 'app:exitRequested' and returns true when
 *    it is the initial entry point, regardless of auth.isAuthenticated().
 * ============================================================================
 */

/**
 * Creates an isolated VM environment with Router.js loaded.
 * @param {string} initialHash
 * @returns {{ router: Object, mockWindow: Object, navigatedTarget: string|null }}
 */
function createRouterVm(initialHash = '#/home') {
    const routerSource = readFileSync('./src/core/Router.js', 'utf8');

    let navigatedTarget = null;
    const mockWindow = {
        location: {
            hash: initialHash,
            replace(newHash) {
                this.hash = newHash;
            }
        }
    };

    const mockState = {
        get() { return null; },
        set() {}
    };

    const mockEventBus = {
        emit() {},
        on() {},
        off() {}
    };

    const mockPluginManager = {
        notifyPageLoad() {},
        notifyPageUnload() {}
    };

    const mockNavigationState = {
        captureState() { return null; },
        restoreState() {}
    };

    const mockLogger = {
        create() {
            return {
                debug() {},
                info() {},
                warn() {},
                error() {}
            };
        }
    };

    const cleanedSource = routerSource
        .replace(/import\s+[\s\S]*?from\s+['"].*?['"];?/g, '')
        .replace(/export\s+default\s+Router;?/g, '')
        .replace(/export\s+/g, '');

    const context = {
        window: mockWindow,
        state: mockState,
        eventBus: mockEventBus,
        pluginManager: mockPluginManager,
        navigationState: mockNavigationState,
        logger: mockLogger,
        console,
        URLSearchParams,
        RegExp,
        Array,
        Object,
        Date
    };

    vm.createContext(context);
    vm.runInContext(cleanedSource + '\nthis.router = router; this.Router = Router;', context);

    const router = context.router;
    router.navigate = (target) => {
        navigatedTarget = target;
    };

    return { router, mockWindow, getNavigatedTarget: () => navigatedTarget };
}

test('Router.canGoBack: returns false on /profiles when history length is 1 (cold boot)', () => {
    const { router, mockWindow } = createRouterVm('#/profiles');

    // Cold boot into profile switcher
    router._history = [{ path: '/profiles', state: null }];
    mockWindow.location.hash = '#/profiles';

    // Must be false so back button and gesture know there is nowhere to go back to
    assert.equal(
        router.canGoBack(),
        false,
        'canGoBack must be false on /profiles when no prior history entry exists'
    );
});

test('Router.canGoBack: returns false on all gateway and root entry routes with 1 history entry', () => {
    const gatewayRoutes = ['/profiles', '/login', '/offline', '/home', '/', ''];

    for (const route of gatewayRoutes) {
        const { router, mockWindow } = createRouterVm(`#${route}`);
        router._history = [{ path: route, state: null }];
        mockWindow.location.hash = `#${route}`;

        assert.equal(
            router.canGoBack(),
            false,
            `canGoBack must be false on gateway route "${route}" with 1 history entry`
        );
    }
});

test('Router.back: does NOT fall back to /home from /profiles when history is empty', () => {
    const { router, mockWindow, getNavigatedTarget } = createRouterVm('#/profiles');

    // Simulate cold boot directly to /profiles
    router._history = [{ path: '/profiles', state: null }];
    mockWindow.location.hash = '#/profiles';

    // Attempting to go back without prior history
    const result = router.back();

    // router.back() must return false and NOT navigate to /home
    assert.equal(result, false, 'router.back() must return false on /profiles with 1 history entry');
    assert.equal(getNavigatedTarget(), null, 'router.back() must NOT trigger navigate("/home")');
    assert.equal(mockWindow.location.hash, '#/profiles', 'Hash must remain at #/profiles');
});

test('Router.back: preserves back navigation to /home when /profiles was opened from within the app', () => {
    const { router, mockWindow } = createRouterVm('#/home');

    // Active session at /home, user clicked profile switcher in Sidebar
    router._history = [
        { path: '/home', state: { focus: 'card-1' } },
        { path: '/profiles', state: null }
    ];
    mockWindow.location.hash = '#/profiles';

    // With 2 entries, canGoBack must be true
    assert.equal(router.canGoBack(), true, 'canGoBack must be true when ancestor route exists');

    // Trigger back
    const result = router.back();

    // Must pop down to /home
    assert.equal(result, true, 'router.back() must return true when history has prior entries');
    assert.equal(router._history.length, 1, 'History must be popped down to 1 entry');
    assert.equal(mockWindow.location.hash, '#/home', 'Window location must return to previous route');
    assert.equal(router.canGoBack(), false, 'canGoBack must become false back at root');
});

test('ProfilesPage.onBack: requests app exit when profile switcher is the first loaded page', () => {
    // Read source code of ProfilesPage.js
    const profilesSource = readFileSync('./src/pages/ProfilesPage.js', 'utf8');

    let exitRequested = false;
    const mockEventBus = {
        emit(event) {
            if (event === 'app:exitRequested') {
                exitRequested = true;
            }
        }
    };

    // Cold boot: router reports canGoBack = false
    const mockRouter = {
        canGoBack() {
            return false;
        }
    };

    // Even if auth.isAuthenticated() is true due to session restore from storage
    const mockAuth = {
        isAuthenticated() {
            return true;
        }
    };

    const mockLogger = {
        create() {
            return {
                debug() {},
                info() {},
                warn() {},
                error() {}
            };
        }
    };

    // Strip ES modules to evaluate in VM context
    const cleanedSource = profilesSource
        .replace(/import\s+[\s\S]*?from\s+['"].*?['"];?/g, '')
        .replace(/import\s+['"].*?['"];?/g, '')
        .replace(/export\s+default\s+ProfilesPage;?/g, '');

    const context = {
        Page: class MockPage {},
        auth: mockAuth,
        router: mockRouter,
        eventBus: mockEventBus,
        logger: mockLogger,
        pinManager: {},
        pinDialog: {},
        storage: {},
        focusManager: {},
        i18n: { t: (k) => k },
        imageService: {},
        state: {},
        api: {},
        console,
        setTimeout,
        clearTimeout
    };

    vm.createContext(context);
    vm.runInContext(cleanedSource + '\nthis.ProfilesPage = ProfilesPage;', context);

    const ProfilesPageClass = context.ProfilesPage;
    const instance = new ProfilesPageClass();

    // Execute onBack
    const handled = instance.onBack();

    // Must be handled and must trigger app exit
    assert.equal(handled, true, 'onBack must return true to absorb back press on entry route');
    assert.equal(exitRequested, true, 'onBack must emit app:exitRequested when no history exists');
});

test('ProfilesPage.onBack: allows router history back navigation when ancestor route exists', () => {
    const profilesSource = readFileSync('./src/pages/ProfilesPage.js', 'utf8');

    let exitRequested = false;
    const mockEventBus = {
        emit(event) {
            if (event === 'app:exitRequested') {
                exitRequested = true;
            }
        }
    };

    // Opened from within app (e.g. Sidebar): router reports canGoBack = true
    const mockRouter = {
        canGoBack() {
            return true;
        }
    };

    const mockAuth = {
        isAuthenticated() {
            return true;
        }
    };

    const mockLogger = {
        create() {
            return {
                debug() {},
                info() {},
                warn() {},
                error() {}
            };
        }
    };

    const cleanedSource = profilesSource
        .replace(/import\s+[\s\S]*?from\s+['"].*?['"];?/g, '')
        .replace(/import\s+['"].*?['"];?/g, '')
        .replace(/export\s+default\s+ProfilesPage;?/g, '');

    const context = {
        Page: class MockPage {},
        auth: mockAuth,
        router: mockRouter,
        eventBus: mockEventBus,
        logger: mockLogger,
        pinManager: {},
        pinDialog: {},
        storage: {},
        focusManager: {},
        i18n: { t: (k) => k },
        imageService: {},
        state: {},
        api: {},
        console,
        setTimeout,
        clearTimeout
    };

    vm.createContext(context);
    vm.runInContext(cleanedSource + '\nthis.ProfilesPage = ProfilesPage;', context);

    const ProfilesPageClass = context.ProfilesPage;
    const instance = new ProfilesPageClass();

    // Execute onBack
    const handled = instance.onBack();

    // Must return false so App.js proceeds to router.back()
    assert.equal(handled, false, 'onBack must return false when router.canGoBack() is true');
    assert.equal(exitRequested, false, 'app:exitRequested must not be emitted when history exists');
});

test('ProfilesPage.onBack: dismisses dialog if visible without exiting', () => {
    const profilesSource = readFileSync('./src/pages/ProfilesPage.js', 'utf8');

    let exitRequested = false;
    const mockEventBus = {
        emit(event) {
            if (event === 'app:exitRequested') {
                exitRequested = true;
            }
        }
    };

    const mockRouter = {
        canGoBack() {
            return false;
        }
    };

    const mockAuth = {
        isAuthenticated() {
            return true;
        }
    };

    const mockLogger = {
        create() {
            return {
                debug() {},
                info() {},
                warn() {},
                error() {}
            };
        }
    };

    const cleanedSource = profilesSource
        .replace(/import\s+[\s\S]*?from\s+['"].*?['"];?/g, '')
        .replace(/import\s+['"].*?['"];?/g, '')
        .replace(/export\s+default\s+ProfilesPage;?/g, '');

    const context = {
        Page: class MockPage {},
        auth: mockAuth,
        router: mockRouter,
        eventBus: mockEventBus,
        logger: mockLogger,
        pinManager: {},
        pinDialog: {},
        storage: {},
        focusManager: {},
        i18n: { t: (k) => k },
        imageService: {},
        state: {},
        api: {},
        console,
        setTimeout,
        clearTimeout
    };

    vm.createContext(context);
    vm.runInContext(cleanedSource + '\nthis.ProfilesPage = ProfilesPage;', context);

    const ProfilesPageClass = context.ProfilesPage;
    const instance = new ProfilesPageClass();

    // Open confirmation dialog
    instance._dialogVisible = true;
    instance._hideDialog = () => {
        instance._dialogVisible = false;
    };

    // Execute onBack
    const handled = instance.onBack();

    assert.equal(handled, true, 'onBack must return true when closing active dialog');
    assert.equal(instance._dialogVisible, false, 'Dialog must be hidden');
    assert.equal(exitRequested, false, 'app:exitRequested must not be emitted when closing dialog');
});

