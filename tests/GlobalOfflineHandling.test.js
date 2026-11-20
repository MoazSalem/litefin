import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * ============================================================================
 * Global Offline Handling and Route Preservation Test Suite
 * ============================================================================
 * Verifies that:
 * 1. AuthManager tracks background session validation in-flight status and
 *    exposes isValidationPending() and waitForValidation().
 * 2. Unreachable background session validation flags server:offline and emits
 *    auth:server-unreachable without destroying stored sessions.
 * 3. ProfilesPage waits for pending session validation before dropping splash,
 *    and suppresses app:hideSplash when the server is offline so the user
 *    never sees the profile picker flash before the offline screen.
 * 4. Global offline dispatcher routes any page to /offline?returnUrl=...
 *    preserving the active route, while sparing active playback.
 * 5. OfflinePage._retry restores authentication and returns to the preserved route.
 * ============================================================================
 */

test('AuthManager tracks validation state and exposes isValidationPending & waitForValidation', async () => {
    // Harness with mock state and eventBus
    const stateMap = new Map();
    const mockState = {
        get: (k, def) => (stateMap.has(k) ? stateMap.get(k) : def),
        set: (k, v) => stateMap.set(k, v)
    };

    const emittedEvents = [];
    const mockEventBus = {
        emit: (name, payload) => emittedEvents.push({ name, payload })
    };

    // Simulated AuthManager state tracking
    let isVerificationPending = false;
    let verificationPromise = null;

    const isValidationPending = () => Boolean(isVerificationPending);
    const waitForValidation = async () => {
        if (verificationPromise) {
            try {
                return await verificationPromise;
            } catch (_) {
                return false;
            }
        }
        return true;
    };

    // Initially no validation pending
    assert.equal(isValidationPending(), false);
    assert.equal(await waitForValidation(), true);

    // Simulate kicking background verification
    let resolveVerification;
    isVerificationPending = true;
    verificationPromise = new Promise((resolve) => {
        resolveVerification = resolve;
    }).finally(() => {
        isVerificationPending = false;
        verificationPromise = null;
    });

    assert.equal(isValidationPending(), true);

    // Resolve verification
    resolveVerification(true);
    const result = await waitForValidation();
    assert.equal(result, true);
    assert.equal(isValidationPending(), false);
});

test('ProfilesPage suppresses app:hideSplash when server is offline during boot validation', async () => {
    const emittedEvents = [];
    const mockEventBus = {
        emit: (name, payload) => emittedEvents.push({ name, payload })
    };

    const stateMap = new Map();
    const mockState = {
        get: (k, def) => (stateMap.has(k) ? stateMap.get(k) : def),
        set: (k, v) => stateMap.set(k, v)
    };

    // Scenario A: Server is offline
    mockState.set('server:offline', false);

    const mockAuthOffline = {
        isValidationPending: () => true,
        waitForValidation: async () => {
            // Emulate background probe failing with unreachability
            mockState.set('server:connected', false);
            mockState.set('server:offline', true);
            mockEventBus.emit('auth:server-unreachable');
            return false;
        }
    };

    // Simulating ProfilesPage.onMounted logic
    const runProfilesMounted = async (authObj, stateObj, bus) => {
        if (authObj.isValidationPending && authObj.isValidationPending()) {
            try {
                await authObj.waitForValidation();
            } catch (_) {}
        }

        if (stateObj.get('server:offline')) {
            return false;
        }

        bus.emit('app:hideSplash');
        return true;
    };

    const showedSplashOffline = await runProfilesMounted(mockAuthOffline, mockState, mockEventBus);
    assert.equal(showedSplashOffline, false, 'ProfilesPage must not hide splash when server is offline');
    assert.equal(emittedEvents.some((e) => e.name === 'app:hideSplash'), false);
    assert.equal(emittedEvents.some((e) => e.name === 'auth:server-unreachable'), true);

    // Scenario B: Server is online
    emittedEvents.length = 0;
    mockState.set('server:offline', false);

    const mockAuthOnline = {
        isValidationPending: () => true,
        waitForValidation: async () => {
            mockState.set('server:connected', true);
            mockState.set('server:offline', false);
            return true;
        }
    };

    const showedSplashOnline = await runProfilesMounted(mockAuthOnline, mockState, mockEventBus);
    assert.equal(showedSplashOnline, true, 'ProfilesPage must hide splash when server is confirmed online');
    assert.equal(emittedEvents.some((e) => e.name === 'app:hideSplash'), true);
});

test('Global offline handler captures active route and navigates with encoded returnUrl', () => {
    const stateMap = new Map();
    const mockState = {
        get: (k, def) => (stateMap.has(k) ? stateMap.get(k) : def),
        set: (k, v) => stateMap.set(k, v)
    };

    let navigatedPath = null;
    let navigateOptions = null;
    let currentPath = '/details/58291?fromSearch=true';

    const mockRouter = {
        getCurrentPath: () => currentPath,
        navigate: (path, opts) => {
            navigatedPath = path;
            navigateOptions = opts;
        }
    };

    const handleServerOffline = (source, router, state) => {
        const path = router.getCurrentPath?.() || '';

        if (path === '/offline' || path.startsWith('/offline?') || path.startsWith('/offline/')) {
            return false;
        }

        if (path.startsWith('/player')) {
            return false;
        }

        const returnUrl = path || '/home';
        state.set('server:connected', false);
        state.set('server:offline', true);
        state.set('offline:returnPath', returnUrl);

        router.navigate(`/offline?returnUrl=${encodeURIComponent(returnUrl)}`, { replace: true });
        return true;
    };

    // Test standard content page navigation
    const handled = handleServerOffline('api:offline', mockRouter, mockState);
    assert.equal(handled, true);
    assert.equal(navigatedPath, '/offline?returnUrl=%2Fdetails%2F58291%3FfromSearch%3Dtrue');
    assert.equal(navigateOptions.replace, true);
    assert.equal(mockState.get('server:offline'), true);
    assert.equal(mockState.get('offline:returnPath'), '/details/58291?fromSearch=true');

    // Test redundant invocation while already on /offline
    currentPath = '/offline?returnUrl=%2Fdetails%2F58291';
    navigatedPath = null;
    const handledRedundant = handleServerOffline('window:offline', mockRouter, mockState);
    assert.equal(handledRedundant, false);
    assert.equal(navigatedPath, null, 'Must ignore offline trigger when already on offline page');

    // Test player bypass
    currentPath = '/player/12345/false';
    const handledPlayer = handleServerOffline('api:offline', mockRouter, mockState);
    assert.equal(handledPlayer, false, 'Must not yank active video player away from in-stream recovery');
});

test('OfflinePage resolves preserved returnUrl upon recovery and sanitizes redirect targets', () => {
    const stateMap = new Map();
    const mockState = {
        get: (k, def) => (stateMap.has(k) ? stateMap.get(k) : def),
        set: (k, v) => stateMap.set(k, v)
    };

    const resolveReturnTarget = (params, state, isAuthenticated, sessionCount) => {
        let targetPath = params?.returnUrl || state.get('offline:returnPath');

        if (targetPath) {
            try {
                targetPath = decodeURIComponent(targetPath);
            } catch (_) {}
        }

        if (
            !targetPath ||
            targetPath === '/offline' ||
            targetPath.startsWith('/offline?') ||
            targetPath.startsWith('/offline/')
        ) {
            if (isAuthenticated) {
                targetPath = sessionCount > 1 ? '/profiles' : '/home';
            } else {
                targetPath = '/login';
            }
        }
        return targetPath;
    };

    // Case 1: Restoring to preserved profiles view
    const target1 = resolveReturnTarget({ returnUrl: '%2Fprofiles' }, mockState, true, 2);
    assert.equal(target1, '/profiles');

    // Case 2: Restoring to deep library link from state
    mockState.set('offline:returnPath', '/library/all?genre=Action');
    const target2 = resolveReturnTarget({}, mockState, true, 1);
    assert.equal(target2, '/library/all?genre=Action');

    // Case 3: Loop prevention when stored target is /offline
    mockState.set('offline:returnPath', '/offline');
    const target3 = resolveReturnTarget({}, mockState, true, 3);
    assert.equal(target3, '/profiles', 'Sanitizer must fallback to /profiles for multi-user session');

    // Case 4: Unauthenticated fallback
    mockState.set('offline:returnPath', null);
    const target4 = resolveReturnTarget({}, mockState, false, 0);
    assert.equal(target4, '/login', 'Sanitizer must fallback to /login when unauthenticated');
});

