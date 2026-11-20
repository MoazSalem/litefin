import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

/**
 * ============================================================================
 * HomeRowPrefetch MergedRows & Companion Plugin Persistence Test Suite
 * ============================================================================
 * Verifies that:
 *   1. ApiClient persists companion plugin availability per server under
 *      `serverPlugin:available:litefin:<serverUrl>` and exposes it synchronously
 *      via `hasKnownLitefinPlugin()`.
 *   2. HomeRowPrefetch uses `api.getMergedRows()` (/Litefin/MergedRows/ContinueAndNextUp)
 *      whenever the companion plugin is known to be installed (unless the user
 *      explicitly opted out with `pref:mergeResumeNextUp = 'false'`), including
 *      when returning to /home after draining an earlier prefetch.
 *   3. HomePage.js shares `shouldMergeResumeNextUp()` and does not fall back
 *      to legacy /Items/Resume + /Shows/NextUp when the healthy plugin returns
 *      an empty Items array.
 * ============================================================================
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const readSrc = (relPath) => readFileSync(resolve(__dirname, '..', relPath), 'utf8');

const storageMap = new Map();
const mockStorage = {
    getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
    setItem: (k, v) => storageMap.set(k, String(v)),
    removeItem: (k) => storageMap.delete(k),
    clear: () => storageMap.clear(),
    key: (i) => Array.from(storageMap.keys())[i] ?? null,
    get length() {
        return storageMap.size;
    }
};
globalThis.localStorage = mockStorage;
globalThis.sessionStorage = mockStorage;

if (typeof globalThis.window === 'undefined') {
    globalThis.window = {
        location: { hash: '#/home', origin: 'http://localhost' },
        addEventListener: () => {},
        removeEventListener: () => {}
    };
}
if (typeof globalThis.document === 'undefined') {
    globalThis.document = {
        addEventListener: () => {},
        removeEventListener: () => {}
    };
}
if (typeof globalThis.__APP_VERSION__ === 'undefined') {
    globalThis.__APP_VERSION__ = '1.0.0';
}

const { ApiClient, api } = await import('../src/api/ApiClient.js');
const { storage } = await import('../src/utils/StorageService.js');
const { fireHomeRowPrefetch, consumeHomeRowPrefetch, shouldMergeResumeNextUp } = await import(
    '../src/utils/HomeRowPrefetch.js'
);

test('ApiClient persists companion plugin flag per server and exposes synchronous hasKnownLitefinPlugin()', async () => {
    storageMap.clear();
    storage.init();

    const serverA = 'http://192.168.1.56:8096';
    const serverB = 'http://192.168.1.99:8096';

    const client1 = new ApiClient();
    client1.setServer(serverA);
    client1.setAuth('tok-1', 'user-1');
    client1.get = async (endpoint) => {
        if (endpoint === '/Litefin/Hero') {
            return { Items: [{ Id: 'h1' }] };
        }
        return { Items: [] };
    };

    assert.equal(client1.hasKnownLitefinPlugin(), false, 'Unknown before first probe or persisted hint');
    assert.equal(await client1.isLitefinPluginAvailable(), true);
    assert.equal(client1.hasKnownLitefinPlugin(), true);
    assert.equal(storage.getItem(`serverPlugin:available:litefin:${serverA}`), 'true');

    // Fresh ApiClient instance (cold boot simulation) sees persisted hint synchronously
    const client2 = new ApiClient();
    client2.setServer(serverA);
    assert.equal(client2.hasKnownLitefinPlugin(), true, 'Cold-boot client must see persisted plugin availability');

    // Switching to another server must NOT inherit serverA's persisted flag
    client2.setServer(serverB);
    assert.equal(client2.hasKnownLitefinPlugin(), false, 'Plugin availability hint must be scoped per serverUrl');
});

test('HomeRowPrefetch fires /Litefin/MergedRows/ContinueAndNextUp when companion plugin is known installed', async () => {
    storageMap.clear();
    storage.init();

    const origGet = api.get.bind(api);
    const calls = [];

    try {
        api.setServer('http://192.168.1.56:8096');
        api.setAuth('tok-1', 'user-1');
        // Simulate earlier session confirmation of companion plugin (without explicit pref:mergeResumeNextUp)
        api._hasLitefinServerPlugin = true;

        api.get = async (endpoint) => {
            calls.push(endpoint);
            return { Items: [{ Id: 'ep-1', Name: 'Episode 1' }] };
        };

        assert.equal(shouldMergeResumeNextUp(), true);
        fireHomeRowPrefetch('user-1');

        const mergedPromise = consumeHomeRowPrefetch('merged', 'user-1');
        assert.ok(mergedPromise, 'Merged prefetch promise must be armed');
        await mergedPromise;

        assert.deepEqual(
            calls,
            ['/Litefin/MergedRows/ContinueAndNextUp'],
            'First prefetch must use /Litefin/MergedRows/ContinueAndNextUp instead of Resume + NextUp'
        );

        // Simulate returning from /details to /home after marking an item played (re-arms prefetch)
        calls.length = 0;
        fireHomeRowPrefetch('user-1');
        const secondMerged = consumeHomeRowPrefetch('merged', 'user-1');
        assert.ok(secondMerged, 'Returning to /home must re-arm merged prefetch');
        await secondMerged;

        assert.deepEqual(
            calls,
            ['/Litefin/MergedRows/ContinueAndNextUp'],
            'Return-to-home prefetch must continue using /Litefin/MergedRows/ContinueAndNextUp'
        );

        // Explicit user opt-out ('false') must still honor separate Resume + NextUp rows
        calls.length = 0;
        storage.setItem('pref:mergeResumeNextUp', 'false');
        assert.equal(shouldMergeResumeNextUp(), false);
        fireHomeRowPrefetch('user-1');

        const resumeP = consumeHomeRowPrefetch('resume', 'user-1');
        const nextUpP = consumeHomeRowPrefetch('nextUp', 'user-1');
        assert.ok(resumeP && nextUpP, 'Explicit opt-out must arm separate resume and nextUp promises');
        await Promise.all([resumeP, nextUpP]);

        assert.ok(calls.some((u) => u.includes('/Items/Resume')), 'Opt-out must fetch /Items/Resume');
        assert.ok(calls.includes('/Shows/NextUp'), 'Opt-out must fetch /Shows/NextUp');
        assert.ok(!calls.includes('/Litefin/MergedRows/ContinueAndNextUp'), 'Opt-out must not call MergedRows');
    } finally {
        api.get = origGet;
        api._hasLitefinServerPlugin = null;
        storageMap.clear();
    }
});

test('HomePage.js & HomeTab.js share shouldMergeResumeNextUp() and HomePage avoids legacy fallback on empty healthy plugin response', () => {
    const homePageSrc = readSrc('src/pages/HomePage.js');
    const homeTabSrc = readSrc('src/pages/settings/tabs/HomeTab.js');

    assert.match(homePageSrc, /const mergeResumeNextUp = shouldMergeResumeNextUp\(\);/);
    assert.match(homeTabSrc, /shouldMergeResumeNextUp\(\)/);
    assert.match(
        homePageSrc,
        /if \(response && Array\.isArray\(response\.Items\) && !hasCorruptIds\)[\s\S]*?return filteredPluginItems\.length > 0 \? filteredPluginItems : null;/,
        'Healthy empty plugin response must return null without falling back to /Items/Resume + /Shows/NextUp'
    );
});

