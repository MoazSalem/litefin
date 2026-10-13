import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
    getFallbackFontFamily,
    getFallbackFontId,
    getFallbackFontName,
    isFallbackFont
} from '../src/utils/FallbackFonts.js';

/**
 * ============================================================================
 * FontLoader Fallback Font Test Suite
 * ============================================================================
 * Verifies that when a Jellyfin server does not have the fallback font folder
 * configured (returning empty list or error), FontLoader caches the failure,
 * deduplicates in-flight requests, and does NOT continuously query the server
 * during playback or subsequent font load attempts.
 * ============================================================================
 */

// Load FontLoader source code with imports and singleton export adapted for isolated VM testing
const fontLoaderSource = readFileSync(new URL('../src/utils/FontLoader.js', import.meta.url), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/^import .*;\n/gm, '')
    .replace(/^export default .*;\n/gm, '')
    .replace(/^export const .*;\n/gm, '');

function createFontLoaderContext(apiOverrides = {}, storageData = {}) {
    let busListeners = {};
    const requests = [];
    const fontFaces = new Set();
    const styles = new Set();
    const revokedUrls = [];
    let nextUrl = 0;

    const mockEventBus = {
        on(event, handler) {
            if (!busListeners[event]) busListeners[event] = [];
            busListeners[event].push(handler);
        },
        emit(event, data) {
            if (busListeners[event]) {
                for (const handler of busListeners[event]) {
                    handler(data);
                }
            }
        }
    };

    const mockStorage = {
        _data: { ...storageData },
        getItem(key) {
            return this._data[key] || null;
        },
        setItem(key, value) {
            this._data[key] = String(value);
        }
    };

    const mockApi = {
        accessToken: 'mock-token',
        serverUrl: 'http://jellyfin.local:8096',
        get: async (path, params) => {
            return [];
        },
        ...apiOverrides
    };

    class MockFontFace {
        constructor(name, url) {
            this.name = name;
            this.url = url;
        }
        async load() {
            return true;
        }
    }

    const context = vm.createContext({
        logger: {
            create: () => ({
                info() {},
                debug() {},
                warn() {},
                error() {}
            })
        },
        api: mockApi,
        state: {
            get: () => ({})
        },
        storage: mockStorage,
        eventBus: mockEventBus,
        getFallbackFontFamily,
        getFallbackFontName,
        isFallbackFont,
        URL: {
            createObjectURL: () => `blob:mock-url-${++nextUrl}`,
            revokeObjectURL: (url) => revokedUrls.push(url)
        },
        document: {
            fonts: {
                load: async () => true,
                ready: Promise.resolve(),
                add: (face) => fontFaces.add(face),
                delete: (face) => fontFaces.delete(face)
            },
            getElementById: () => null,
            createElement: () => ({ style: {}, appendChild: () => {} }),
            head: {
                appendChild(style) {
                    styles.add(style);
                    style.parentNode = this;
                },
                removeChild: (style) => styles.delete(style)
            },
            body: { appendChild: () => {}, removeChild: () => {} }
        },
        window: {
            FontFace: MockFontFace
        },
        FontFace: MockFontFace,
        Blob: class {
            constructor() {}
        },
        fetch: async (url) => {
            requests.push(url);
            return {
                ok: true,
                headers: { get: () => 'font/ttf' },
                arrayBuffer: async () => new ArrayBuffer(8)
            };
        }
    });

    const script = `
        ${fontLoaderSource}
        new FontLoader();
    `;

    const instance = vm.runInContext(script, context);
    return { instance, mockApi, mockEventBus, mockStorage, context, requests, fontFaces, styles, revokedUrls };
}

test('FontLoader caches empty fallback font response and does not query server again', async () => {
    let networkCalls = 0;
    const { instance } = createFontLoaderContext({
        get: async (path) => {
            if (path === '/FallbackFont/Fonts') {
                networkCalls++;
                // Server returns empty list because fallback font folder is not configured
                return [];
            }
            return [];
        }
    });

    // Initial load attempt fails because server returned []
    const firstResult = await instance.loadFont('fallback-font');
    assert.strictEqual(firstResult, false);
    assert.strictEqual(networkCalls, 1);
    assert.strictEqual(instance.hasFontFailed('fallback-font'), true);
    assert.strictEqual(instance.isFontLoaded('fallback-font'), false);

    // Subsequent calls (such as during playback on every cue) must immediately return false without querying network
    const secondResult = await instance.loadFont('fallback-font');
    assert.strictEqual(secondResult, false);
    assert.strictEqual(networkCalls, 1, 'Network must NOT be called again after caching failure');

    const thirdResult = await instance.loadFont('fallback-font');
    assert.strictEqual(thirdResult, false);
    assert.strictEqual(networkCalls, 1, 'Network must NOT be called on subsequent cues');
});

test('FontLoader deduplicates concurrent requests for fallback-font', async () => {
    let networkCalls = 0;
    const { instance } = createFontLoaderContext({
        get: async (path) => {
            if (path === '/FallbackFont/Fonts') {
                networkCalls++;
                // Add artificial latency to test concurrency
                await new Promise((r) => setTimeout(r, 10));
                return [];
            }
            return [];
        }
    });

    // Launch multiple concurrent load calls at the exact same moment
    const [res1, res2, res3] = await Promise.all([
        instance.loadFont('fallback-font'),
        instance.loadFont('fallback-font'),
        instance.loadFont('fallback-font')
    ]);

    assert.strictEqual(res1, false);
    assert.strictEqual(res2, false);
    assert.strictEqual(res3, false);
    assert.strictEqual(networkCalls, 1, 'Concurrent calls must be deduplicated into 1 request');
});

test('forceReload=true bypasses failure cache and retries fetching fallback font', async () => {
    let networkCalls = 0;
    let shouldSucceed = false;

    const { instance } = createFontLoaderContext({
        get: async (path) => {
            if (path === '/FallbackFont/Fonts') {
                networkCalls++;
                if (shouldSucceed) {
                    return [{ Name: 'CustomFallback.ttf', Size: 1024 }];
                }
                return [];
            }
            return [];
        }
    });

    // First attempt fails
    const res1 = await instance.loadFont('fallback-font');
    assert.strictEqual(res1, false);
    assert.strictEqual(networkCalls, 1);
    assert.strictEqual(instance.hasFontFailed('fallback-font'), true);

    // Normal loadFont respects failure cache
    const res2 = await instance.loadFont('fallback-font');
    assert.strictEqual(res2, false);
    assert.strictEqual(networkCalls, 1);

    // Admin now configured fallback fonts on server; user changes setting or clicks reload
    shouldSucceed = true;
    const res3 = await instance.loadFont('fallback-font', true);
    assert.strictEqual(res3, true);
    assert.strictEqual(networkCalls, 2, 'forceReload must bypass cached failure');
    assert.strictEqual(instance.hasFontFailed('fallback-font'), false);
    assert.strictEqual(instance.isFontLoaded('fallback-font'), true);
});

test('eventBus pref and auth events reset failure cache', async () => {
    let networkCalls = 0;

    const { instance, mockEventBus } = createFontLoaderContext({
        get: async (path) => {
            if (path === '/FallbackFont/Fonts') {
                networkCalls++;
                return [];
            }
            return [];
        }
    });

    // First attempt fails
    await instance.loadFont('fallback-font');
    assert.strictEqual(networkCalls, 1);
    assert.strictEqual(instance.hasFontFailed('fallback-font'), true);

    // User updates preference via eventBus
    mockEventBus.emit('pref:subtitleFont', 'fallback-font');
    assert.strictEqual(instance.hasFontFailed('fallback-font'), false, 'Setting change must clear failure cache');

    // Next loadFont triggers network check again
    await instance.loadFont('fallback-font');
    assert.strictEqual(networkCalls, 2);
});

test('fallback font waits for restored credentials without caching a failure', async () => {
    const { instance, mockApi, requests } = createFontLoaderContext(
        {
            serverUrl: null,
            accessToken: null,
            get: async () => [{ Name: 'First.ttf' }, { Name: 'Selected.ttf' }]
        },
        { 'pref:jellyfinFallbackFont': 'Selected.ttf' }
    );
    assert.equal(await instance.loadFont('fallback-font'), false);
    assert.equal(instance.hasFontFailed('fallback-font'), false);
    assert.equal(requests.length, 0);

    mockApi.serverUrl = 'http://jellyfin.local:8096';
    mockApi.accessToken = 'mock-token';
    assert.equal(await instance.loadFont('fallback-font'), true);
    assert.match(requests[0], /\/Selected\.ttf\?/);
});

test('server font list preserves all distinct filenames', async () => {
    const { instance } = createFontLoaderContext({
        get: async () => [{ Name: 'First.ttf' }, { Name: 'Second.otf' }, { Name: 'First.ttf' }, null, { Name: '' }]
    });
    assert.deepEqual(
        Array.from(await instance.getFallbackFonts(), (font) => font.Name),
        ['First.ttf', 'Second.otf']
    );
});

test('named fallback fonts load independently and restore the same file after restart', async () => {
    const firstId = getFallbackFontId('UI 字体.ttf');
    const secondId = getFallbackFontId("Subtitle (O'Brien).otf");
    const { instance, requests, fontFaces } = createFontLoaderContext();
    assert.deepEqual(await Promise.all([instance.loadFont(firstId), instance.loadFont(secondId)]), [true, true]);
    assert.notEqual(instance.getFontFamily(firstId), instance.getFontFamily(secondId));
    assert.notEqual(instance.getFallbackFontUrl(firstId), instance.getFallbackFontUrl(secondId));
    assert.equal(fontFaces.size, 2);
    assert.ok(requests.some((url) => url.includes(encodeURIComponent('UI 字体.ttf'))));

    const restarted = createFontLoaderContext({}, { 'pref:jellyfinFallbackFont': 'Different.ttf' });
    assert.equal(await restarted.instance.loadFont(secondId), true);
    assert.equal(restarted.instance.getFontFamily(secondId), instance.getFontFamily(secondId));
    assert.ok(restarted.requests[0].includes(encodeURIComponent("Subtitle (O'Brien).otf")));
    assert.equal(
        restarted.requests.some((url) => url.includes('Different.ttf')),
        false
    );
});

test('reloading the legacy fallback replaces its registered face and releases the previous URL', async () => {
    const { instance, mockStorage, fontFaces, requests, revokedUrls } = createFontLoaderContext({
        get: async () => [{ Name: 'First.ttf' }, { Name: 'Second.ttf' }]
    });
    assert.equal(await instance.loadFont('fallback-font'), true);
    const firstUrl = instance.getFallbackFontUrl();
    mockStorage.setItem('pref:jellyfinFallbackFont', 'Second.ttf');
    assert.equal(await instance.loadFont('fallback-font', true), true);
    assert.equal(fontFaces.size, 1);
    assert.match(requests[1], /\/Second\.ttf\?/);
    assert.ok(revokedUrls.includes(firstUrl));
});

test('older browsers replace the fallback style when selecting another file', async () => {
    const { instance, context, mockStorage, styles } = createFontLoaderContext({
        get: async () => [{ Name: 'First.ttf' }, { Name: 'Second.ttf' }]
    });
    context.window.FontFace = undefined;
    assert.equal(await instance.loadFont('fallback-font'), true);
    const firstStyle = [...styles][0];
    mockStorage.setItem('pref:jellyfinFallbackFont', 'Second.ttf');
    assert.equal(await instance.loadFont('fallback-font', true), true);
    assert.equal(styles.size, 1);
    assert.equal(styles.has(firstStyle), false);
    assert.ok([...styles][0].textContent.includes(instance.getFallbackFontUrl()));
});

test('a load started before a server reset cannot replace the new font state', async () => {
    let finishFirst;
    let calls = 0;
    const { instance } = createFontLoaderContext({
        get: async () => {
            if (++calls === 1)
                return new Promise((resolve) => {
                    finishFirst = resolve;
                });
            return [{ Name: 'New.ttf' }];
        }
    });
    const staleLoad = instance.loadFont('fallback-font');
    instance.resetFallbackFont();
    assert.equal(await instance.loadFont('fallback-font'), true);
    const currentUrl = instance.getFallbackFontUrl();
    finishFirst([{ Name: 'Old.ttf' }]);
    assert.equal(await staleLoad, false);
    assert.equal(instance.getFallbackFontUrl(), currentUrl);
    assert.equal(instance.isFontLoaded('fallback-font'), true);
    assert.equal(instance.hasFontFailed('fallback-font'), false);
});
