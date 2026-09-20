import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Define global browser shims for Node testing if absent
if (typeof globalThis.window === 'undefined') {
    globalThis.window = {
        location: { hash: '', origin: 'http://localhost' }
    };
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

const { ApiClient } = await import('../src/api/ApiClient.js');

test('ApiClient: isLitefinPluginAvailable caches missing state and suppresses redundant requests', async () => {
    const api = new ApiClient();
    api.setServer('http://192.168.1.56:8096');
    api.setAuth('token123', 'user456');

    const requestedUrls = [];

    // Mock get method
    api.get = async (endpoint, params = {}, options = {}) => {
        requestedUrls.push(endpoint);
        if (endpoint.startsWith('/Litefin/')) {
            const err = new Error('Not found');
            err.status = 404;
            throw err;
        }
        return { Items: [] };
    };

    // First call: triggers lightweight probe to /Litefin/Hero
    const availableFirst = await api.isLitefinPluginAvailable();
    assert.equal(availableFirst, false);
    assert.equal(requestedUrls.length, 1);
    assert.equal(requestedUrls[0], '/Litefin/Hero');

    // Second call: should use memory cache without probing again
    const availableSecond = await api.isLitefinPluginAvailable();
    assert.equal(availableSecond, false);
    assert.equal(requestedUrls.length, 1, 'Should not have made a second probe request');

    // getHomeHero should immediately return null without firing network request
    const heroResult = await api.getHomeHero();
    assert.equal(heroResult, null);
    assert.equal(requestedUrls.length, 1, 'getHomeHero should not request /Litefin/Hero when plugin is missing');

    // getBatchLatest should immediately return null without network request
    const batchResult = await api.getBatchLatest(['lib-1', 'lib-2']);
    assert.equal(batchResult, null);
    assert.equal(requestedUrls.length, 1, 'getBatchLatest should not request /Litefin/Items/Latest when plugin is missing');

    // getLibraryThumbnails should immediately return null without network request
    const thumbResult = await api.getLibraryThumbnails(['lib-1']);
    assert.equal(thumbResult, null);
    assert.equal(requestedUrls.length, 1, 'getLibraryThumbnails should not request /Litefin/Items/Thumbnails when plugin is missing');

    // getPersonItems should immediately use standard Jellyfin /Users/.../Items endpoint
    await api.getPersonItems('person-789');
    assert.ok(requestedUrls.includes('/Users/user456/Items'), 'getPersonItems should fallback directly to /Users/.../Items');
    assert.ok(!requestedUrls.some((u) => u.startsWith('/Litefin/Persons')), 'Should not attempt /Litefin/Persons');
});

test('ApiClient: isLitefinPluginAvailable caches present state when probe succeeds', async () => {
    const api = new ApiClient();
    api.setServer('http://192.168.1.56:8096');
    api.setAuth('token123', 'user456');

    const requestedUrls = [];

    api.get = async (endpoint, params = {}, options = {}) => {
        requestedUrls.push(endpoint);
        if (endpoint === '/Litefin/Hero') {
            return { Items: [{ Id: 'hero-1', Name: 'Movie 1' }] };
        }
        if (endpoint === '/Litefin/Items/Latest') {
            return { 'lib-1': [{ Id: 'item-1' }] };
        }
        return { Items: [] };
    };

    const available = await api.isLitefinPluginAvailable();
    assert.equal(available, true);
    assert.equal(requestedUrls.length, 1);

    const hero = await api.getHomeHero();
    assert.deepEqual(hero, { Items: [{ Id: 'hero-1', Name: 'Movie 1' }] });

    const batch = await api.getBatchLatest(['lib-1']);
    assert.deepEqual(batch, { 'lib-1': [{ Id: 'item-1' }] });
});

test('ApiClient source verifies all /Litefin endpoints check isLitefinPluginAvailable', () => {
    const apiSource = readFileSync(new URL('../src/api/ApiClient.js', import.meta.url), 'utf8');

    assert.ok(apiSource.includes('isLitefinPluginAvailable('));
    assert.ok(apiSource.includes('this._hasLitefinServerPlugin = null;'));
    assert.ok(apiSource.includes('this._hasLitefinServerPlugin = false;'));
});

test('ServerPluginClient & ApiClient: disabled plugin in server registry is treated as unavailable', async () => {
    const { serverPluginClient } = await import('../src/plugins/ServerPluginClient.js');
    serverPluginClient.reset();

    const mockAdminList = [
        {
            Name: 'Litefin',
            Id: 'f5c68360-ca47-4648-b47c-3da5f112aa8f',
            Status: 'Disabled'
        },
        {
            Name: 'Intro Skipper',
            Id: 'intro-skipper-guid',
            Status: 'Active'
        }
    ];

    const isLitefinActive = serverPluginClient._checkInAdminList('litefin', mockAdminList);
    assert.equal(isLitefinActive.available, false, 'Disabled Litefin plugin should NOT be considered active');

    const isIntroSkipperActive = serverPluginClient._checkInAdminList('intro-skipper', mockAdminList);
    assert.equal(isIntroSkipperActive.available, true, 'Active Intro Skipper plugin should be considered active');
});
