import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

/**
 * ============================================================================
 * webOS Late Device Info Test Suite
 * ============================================================================
 * webOS.deviceInfo() answers asynchronously, after the first capability
 * report. Until it arrives a 4K panel looks like 1080p (40 Mbps cap, H.264
 * level 4.1) and Dolby Vision is off. When it arrives, the capability report
 * must carry a profile rebuilt from the real hardware, and a PlaybackInfo
 * prewarmed with the fallback profile must not be used for playback.
 * AuthManager / PrewarmManager code is taken from the source and run on stubs.
 * ============================================================================
 */

const quietLog = { info() {}, debug() {}, warn() {}, error() {} };

// A 4K LG TV whose web app reports a 1080p viewport (the usual case)
Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.270 Safari/537.36 WebAppManager' },
    configurable: true
});
globalThis.window = {
    innerWidth: 1920,
    innerHeight: 1080,
    screen: { width: 1920, height: 1080 },
    MediaSource: { isTypeSupported: () => true }
};
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {}, key: () => null, length: 0 };
globalThis.document = {
    documentElement: { clientWidth: 1920, clientHeight: 1080 },
    createElement: () => ({ canPlayType: () => 'probably', addEventListener() {}, style: {} }),
    body: { appendChild() {} }
};

const { webosAdapter } = await import('../src/webos/WebOSAdapter.js');
const WebOSProfile = await import('../src/api/profiles/WebOSProfile.js');

/** Source of one class method, from its signature to the closing brace at method indentation. */
function extractMethod(source, signature) {
    const start = source.indexOf(`\n    ${signature}`);
    assert.ok(start !== -1, `method not found: ${signature}`);
    const end = source.indexOf('\n    }\n', start);
    return source.slice(start + 1, end + 6);
}

const authSource = readFileSync(new URL('../src/api/AuthManager.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function createAuthManager(reports) {
    const context = vm.createContext({
        log: quietLog,
        platformInfo: { isWebOS: true },
        storage: { getItem: () => 'device-id' },
        STORAGE_KEYS: { DEVICE_ID: 'device_id' },
        SUPPORTED_CAPABILITIES: { PlayableMediaTypes: ['Video'] },
        api: {
            setDevice() {},
            reportCapabilities: (capabilities) => {
                reports.push(capabilities);
                return Promise.resolve();
            }
        },
        buildJellyfinProfile: WebOSProfile.buildJellyfinProfile,
        clearCapabilitiesCache: WebOSProfile.clearCapabilitiesCache
    });
    const methods = vm.runInContext(`({\n${extractMethod(authSource, '_onWebosDeviceInfo(info) {')}\n})`, context);
    return Object.assign(Object.create(methods), { isAuthenticated: () => true });
}

test('AuthManager: the capability report after webOS device info carries the real 4K / Dolby Vision profile', () => {
    webosAdapter._deviceInfo = null;
    WebOSProfile.clearCapabilitiesCache();

    // Startup: profile built (and cached) before deviceInfo arrived
    const startup = WebOSProfile.buildJellyfinProfile();
    assert.strictEqual(startup.MaxStreamingBitrate, 40000000);

    // webOS answers; the adapter stores the info, then emits webos:deviceInfoReady
    const info = { modelName: 'OLED42C41LA', uhd: true, dolbyVision: true };
    webosAdapter._deviceInfo = info;
    const reports = [];
    createAuthManager(reports)._onWebosDeviceInfo(info);

    assert.strictEqual(reports.length, 1);
    assert.strictEqual(
        reports[0].DeviceProfile.MaxStreamingBitrate,
        120000000,
        'the re-report sent the cached 1080p fallback profile again'
    );
    assert.strictEqual(WebOSProfile.getDeviceCapabilities().dolbyVision, true);
    webosAdapter._deviceInfo = null;
    WebOSProfile.clearCapabilitiesCache();
});

const prewarmSource = readFileSync(new URL('../src/player/core/PrewarmManager.js', import.meta.url), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/^import .*;\n/gm, '')
    .replace(/^export default .*;\n/gm, '')
    .replace(/^export const .*;\n/gm, '')
    .replace('export class PrewarmManager', 'class PrewarmManager');

/** The app's PrewarmManager singleton wiring, on a stub event bus. */
function createWiredPrewarmManager() {
    const handlers = {};
    const context = vm.createContext({
        logger: { create: () => quietLog },
        eventBus: { on: (name, fn) => (handlers[name] = fn) },
        api: {},
        PlayerSettings: { get: () => true },
        buildJellyfinProfile: () => ({}),
        platformInfo: {},
        AbortController
    });
    const appWiring = (readFileSync(new URL('../src/player/core/PrewarmManager.js', import.meta.url), 'utf8').match(
        /export const prewarmManager = (.*);/
    ) || [])[1];
    assert.ok(appWiring, 'prewarmManager singleton not found');
    const manager = vm.runInContext(`${prewarmSource}\n${appWiring};`, context);
    return { manager, emit: (name) => handlers[name]?.() };
}

function prewarmed(manager) {
    let aborted = false;
    manager._cachedItemId = 'item';
    manager._cachedItem = { Id: 'item' };
    manager._timestamp = Date.now();
    manager._prewarmParams = {};
    manager._abortController = { abort: () => (aborted = true) };
    manager._playbackInfoPromise = new Promise(() => {});
    return () => aborted;
}

test('PrewarmManager: a PlaybackInfo prewarmed before webOS device info is not used for playback', () => {
    const { manager, emit } = createWiredPrewarmManager();
    const wasAborted = prewarmed(manager);

    emit('webos:deviceInfoReady');

    assert.strictEqual(manager.consumePlaybackInfo('item', {}), null, 'playback used the fallback-profile PlaybackInfo');
    assert.ok(wasAborted(), 'the prewarm request was left running');
});

test('PrewarmManager: a PlaybackInfo the player already took over is not aborted by webOS device info', () => {
    const { manager, emit } = createWiredPrewarmManager();
    const wasAborted = prewarmed(manager);
    assert.ok(manager.consumePlaybackInfo('item', {}));

    emit('webos:deviceInfoReady');

    assert.strictEqual(wasAborted(), false, 'the request playback is waiting on was aborted');
});
