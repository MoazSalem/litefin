import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/**
 * ============================================================================
 * Home Screen Sections Plugin Detection Test Suite
 * ============================================================================
 * The Settings → Plugins entry depends on the Home Screen Sections server
 * plugin. Non-admin users cannot list server plugins, so detection probes
 * /HomeScreen/Meta, which needs no media item. Probes that need an item
 * (Intro Skipper) must keep deferring.
 * ============================================================================
 */

// Browser shims, same as LitefinServerPluginDetection.test.js
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

const { serverPluginClient } = await import('../src/plugins/ServerPluginClient.js');
const { state } = await import('../src/core/StateManager.js');
const { isHomeScreenSectionsEnabled, HSS_PLUGIN_ID } = await import('../src/utils/HomeScreenSections.js');

const notFound = () => Object.assign(new Error('Not found'), { status: 404 });

function setupNonAdmin(handler) {
    serverPluginClient.reset();
    state.set('user:data', { Policy: { IsAdministrator: false } });
    const calls = [];
    serverPluginClient.init({
        get: async (endpoint) => {
            calls.push(endpoint);
            return handler(endpoint);
        }
    });
    return calls;
}

test('non-admin: Home Screen Sections is detected without a media item', async () => {
    const calls = setupNonAdmin((endpoint) => {
        if (endpoint === '/HomeScreen/Meta') return { Enabled: true };
        throw notFound();
    });
    const result = await serverPluginClient.isPluginAvailable('home-screen-sections');
    assert.equal(result.available, true);
    assert.equal(!!result.deferred, false);
    assert.deepEqual(calls, ['/HomeScreen/Meta']);
});

test('non-admin: missing Home Screen Sections plugin is reported as unavailable', async () => {
    setupNonAdmin(() => {
        throw notFound();
    });
    const result = await serverPluginClient.isPluginAvailable('home-screen-sections');
    assert.equal(result.available, false);
    assert.equal(!!result.deferred, false);
});

test('non-admin: probes that need an item still defer (Intro Skipper)', async () => {
    const calls = setupNonAdmin(() => ({}));
    const result = await serverPluginClient.isPluginAvailable('intro-skipper');
    assert.equal(result.deferred, true);
    assert.deepEqual(calls, []);
});

test('admin: Home Screen Sections is matched by name in the plugin list', async () => {
    serverPluginClient.reset();
    state.set('user:data', { Policy: { IsAdministrator: true } });
    serverPluginClient.init({
        get: async (endpoint) => {
            if (endpoint === '/Plugins') return [{ Name: 'Home Screen Sections', Id: 'b8298e01', Status: 'Active' }];
            throw notFound();
        }
    });
    const result = await serverPluginClient.isPluginAvailable('home-screen-sections');
    assert.equal(result.available, true);
});

test('isHomeScreenSectionsEnabled reads the preference PluginManager persists', () => {
    const store = new Map();
    const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null) };
    assert.equal(isHomeScreenSectionsEnabled(storage), false);
    store.set(`plugin:enabled:${HSS_PLUGIN_ID}`, 'true');
    assert.equal(isHomeScreenSectionsEnabled(storage), true);
    store.set(`plugin:enabled:${HSS_PLUGIN_ID}`, 'false');
    assert.equal(isHomeScreenSectionsEnabled(storage), false);
});

test('PluginManager registers the Home Screen Sections plugin, off by default', () => {
    const manager = readFileSync(path.resolve('src/plugins/PluginManager.js'), 'utf8');
    assert.match(
        manager,
        /id: 'home-screen-sections',\s*load: \(\) => import\('\.\/installed\/home-screen-sections\/index\.js'\)/
    );

    const plugin = readFileSync(path.resolve('src/plugins/installed/home-screen-sections/index.js'), 'utf8');
    assert.match(plugin, /serverDependency: 'home-screen-sections'/);
    assert.match(plugin, /defaultEnabled: false/);
});
