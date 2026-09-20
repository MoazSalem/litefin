import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// Load App.js source to extract the Plugin Manager initialization block
const appSource = readFileSync(new URL('../src/core/App.js', import.meta.url), 'utf8');

const initBlock = appSource.slice(
    appSource.indexOf("        if (state.get('user:authenticated')) {"),
    appSource.indexOf('        // Initialize ScreensaverManager')
);

function evaluateInitBlock({
    authenticated = true,
    sessionCount = 2,
    hasPin = false,
    rememberLastUser = false,
    skipProfilesOnce = false,
    isWeb = false,
    initialHash = '#/home'
} = {}) {
    const calls = [];
    const storageMap = new Map();

    storageMap.set('pref:rememberLastActiveUser', String(rememberLastUser));
    if (skipProfilesOnce) {
        storageMap.set('litefin:skip_profiles_once', 'true');
    }

    const context = {
        state: {
            get: (key, fallback) => {
                if (key === 'user:authenticated') return authenticated;
                if (key === 'user:sessionCount') return sessionCount;
                return fallback;
            }
        },
        auth: {
            getCurrentUser: () => ({ Id: 'user-123', Name: 'Alice' })
        },
        pinManager: {
            hasPin: () => hasPin
        },
        storage: {
            getItem: (key) => storageMap.get(key) ?? null
        },
        platformInfo: {
            isWeb
        },
        window: {
            location: {
                hash: initialHash
            }
        },
        log: {
            info: (...args) => calls.push({ type: 'info', msg: args.join(' ') }),
            error: (...args) => calls.push({ type: 'error', msg: args.join(' ') })
        },
        pluginManager: {
            init: (deps) => {
                calls.push({ type: 'init', deps });
                return Promise.resolve();
            }
        },
        api: { name: 'ApiClient' },
        focusManager: { name: 'FocusManager' }
    };

    vm.runInNewContext(`(function () {\n${initBlock}\n})();`, context);

    return calls;
}

test('Web: Re-initializes PluginManager on page refresh (e.g. /home) even with multiple sessions', () => {
    const calls = evaluateInitBlock({
        authenticated: true,
        sessionCount: 2,
        isWeb: true,
        initialHash: '#/home'
    });

    const initCall = calls.find((c) => c.type === 'init');
    assert.ok(initCall, 'PluginManager.init should be called on web refresh');
});

test('Web: Re-initializes PluginManager on details page refresh', () => {
    const calls = evaluateInitBlock({
        authenticated: true,
        sessionCount: 3,
        isWeb: true,
        initialHash: '#/details/movie-456'
    });

    const initCall = calls.find((c) => c.type === 'init');
    assert.ok(initCall, 'PluginManager.init should be called on details page refresh on web');
});

test('Web: Defers PluginManager if explicitly on /profiles with multiple sessions', () => {
    const calls = evaluateInitBlock({
        authenticated: true,
        sessionCount: 2,
        isWeb: true,
        initialHash: '#/profiles'
    });

    const initCall = calls.find((c) => c.type === 'init');
    assert.equal(initCall, undefined, 'PluginManager.init should be deferred when sitting on /profiles on web');
});

test('TV: Defers PluginManager on cold boot when multiple sessions exist and rememberLastUser is false', () => {
    const calls = evaluateInitBlock({
        authenticated: true,
        sessionCount: 2,
        isWeb: false,
        rememberLastUser: false,
        initialHash: ''
    });

    const initCall = calls.find((c) => c.type === 'init');
    assert.equal(initCall, undefined, 'PluginManager.init should be deferred on TV when multiple sessions exist');
});

test('TV: Initializes PluginManager immediately on single session boot', () => {
    const calls = evaluateInitBlock({
        authenticated: true,
        sessionCount: 1,
        isWeb: false,
        rememberLastUser: false,
        initialHash: ''
    });

    const initCall = calls.find((c) => c.type === 'init');
    assert.ok(initCall, 'PluginManager.init should be called on TV with single session');
});

test('TV: Initializes PluginManager immediately when rememberLastUser is true without PIN', () => {
    const calls = evaluateInitBlock({
        authenticated: true,
        sessionCount: 2,
        isWeb: false,
        rememberLastUser: true,
        hasPin: false,
        initialHash: ''
    });

    const initCall = calls.find((c) => c.type === 'init');
    assert.ok(initCall, 'PluginManager.init should be called on TV when rememberLastUser is active');
});
