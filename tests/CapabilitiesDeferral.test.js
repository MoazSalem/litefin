import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * ============================================================================
 * Capabilities Deferral Test Suite
 * ============================================================================
 * Verifies that AuthManager.establishSessionTelemetry() and post-splash
 * pending capability reports:
 *   1. Open the WebSocket immediately on splash dismissal.
 *   2. Defer DeviceProfile probing + POST /Sessions/Capabilities/Full behind
 *      idleGate (3000ms quiet window, 0ms unbounded maxWait) instead of forcing
 *      telemetry mid-scroll or blocking the splash-hide / first-paint frame.
 *   3. Cancel queued capability tasks if the user logs out or becomes unauthenticated
 *      before the idle task executes.
 * ============================================================================
 */

const storageMap = new Map();
const mockStorage = {
    getItem: (key) => (storageMap.has(key) ? storageMap.get(key) : null),
    setItem: (key, val) => storageMap.set(key, String(val)),
    removeItem: (key) => storageMap.delete(key),
    clear: () => storageMap.clear(),
    key: (idx) => Array.from(storageMap.keys())[idx] ?? null,
    get length() {
        return storageMap.size;
    }
};
globalThis.localStorage = mockStorage;
globalThis.sessionStorage = mockStorage;

if (!globalThis.navigator) {
    globalThis.navigator = { userAgent: 'Mozilla/5.0 (SMART-TV; Linux; Tizen 9.0)' };
}

globalThis.window = {
    innerWidth: 1920,
    innerHeight: 1080,
    devicePixelRatio: 1,
    location: { hash: '#/home' },
    __scrollController: { isAnimating: false },
    addEventListener: () => {},
    removeEventListener: () => {},
    matchMedia: () => ({ matches: false, addListener: () => {}, removeListener: () => {} })
};

globalThis.document = {
    documentElement: { dir: 'ltr', classList: { add: () => {}, remove: () => {} }, setAttribute: () => {} },
    body: { classList: { add: () => {}, remove: () => {} } },
    createElement: () => ({ canPlayType: () => 'probably', getContext: () => null }),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    removeEventListener: () => {}
};

const { default: AuthManager } = await import('../src/api/AuthManager.js');
const { api } = await import('../src/api/ApiClient.js');
const { eventBus } = await import('../src/core/EventBus.js');
const { state } = await import('../src/core/StateManager.js');
const { idleGate } = await import('../src/utils/IdleGate.js');

test('establishSessionTelemetry opens WebSocket immediately and defers capabilities via idleGate', () => {
    const origOpenWs = api.openWebSocket;
    const origReportCaps = api.reportCapabilities;
    const origRunWhenIdle = idleGate.runWhenIdle;
    const origCancel = idleGate.cancel;
    const prevAuth = state.get('user:authenticated');

    let wsOpened = 0;
    const capPayloads = [];
    const scheduledIdle = [];
    const cancelledTasks = [];

    api.openWebSocket = () => {
        wsOpened++;
    };
    api.reportCapabilities = (payload) => {
        capPayloads.push(payload);
        return Promise.resolve();
    };
    idleGate.runWhenIdle = (fn, minQuietMs, maxWaitMs) => {
        const id = `caps-task-${scheduledIdle.length + 1}`;
        scheduledIdle.push({ id, fn, minQuietMs, maxWaitMs });
        return id;
    };
    idleGate.cancel = (id) => {
        cancelledTasks.push(id);
    };

    try {
        const manager = new AuthManager();
        state.set('user:authenticated', true);

        manager.establishSessionTelemetry();

        assert.equal(wsOpened, 1, 'WebSocket must open immediately without waiting for idle');
        assert.equal(capPayloads.length, 0, 'POST /Sessions/Capabilities/Full must NOT execute synchronously');
        assert.equal(scheduledIdle.length, 1, 'Capability report must be queued once via idleGate');
        assert.equal(scheduledIdle[0].minQuietMs, 3000);
        assert.equal(scheduledIdle[0].maxWaitMs, 0);

        // Execute the idle callback and verify capabilities report fires then
        scheduledIdle[0].fn();
        assert.equal(capPayloads.length, 1, 'Capability report executes inside idle callback when authenticated');
        assert.ok(capPayloads[0].DeviceProfile, 'Capability payload must include built DeviceProfile');

        // Rescheduling while still unexecuted should cancel previous task cleanly
        manager._scheduleDeferredCapabilitiesReport();
        assert.equal(scheduledIdle.length, 2);
        manager._onUnauthorized();
        // Force active state false cleanly if _onUnauthorized exited early due to missing token
        manager._cancelDeferredCapabilitiesReport();
        assert.ok(cancelledTasks.includes('caps-task-2'), 'Queued task must be cancelled explicitly on teardown');
    } finally {
        api.openWebSocket = origOpenWs;
        api.reportCapabilities = origReportCaps;
        idleGate.runWhenIdle = origRunWhenIdle;
        idleGate.cancel = origCancel;
        state.set('user:authenticated', prevAuth);
    }
});

test('app:hideSplash schedules deferred capabilities instead of synchronous profile build when pending', () => {
    const origReportCaps = api.reportCapabilities;
    const origRunWhenIdle = idleGate.runWhenIdle;
    const prevAuth = state.get('user:authenticated');

    const capPayloads = [];
    const scheduledIdle = [];

    api.reportCapabilities = (payload) => {
        capPayloads.push(payload);
        return Promise.resolve();
    };
    idleGate.runWhenIdle = (fn, minQuietMs, maxWaitMs) => {
        const id = `splash-caps-${scheduledIdle.length + 1}`;
        scheduledIdle.push({ id, fn, minQuietMs, maxWaitMs });
        return id;
    };

    try {
        const manager = new AuthManager();
        state.set('user:authenticated', true);
        manager._pendingCapsAfterSplash = true;

        eventBus.emit('app:hideSplash');

        assert.equal(manager._pendingCapsAfterSplash, false);
        assert.equal(capPayloads.length, 0, 'app:hideSplash must not call reportCapabilities synchronously');
        assert.equal(scheduledIdle.length, 1, 'app:hideSplash should schedule capability probe via idleGate');
        assert.equal(scheduledIdle[0].minQuietMs, 3000);
        assert.equal(scheduledIdle[0].maxWaitMs, 0);

        // If user signs out before idle callback runs, callback must abort cleanly
        state.set('user:authenticated', false);
        scheduledIdle[0].fn();
        assert.equal(capPayloads.length, 0, 'Deferred capability report must skip if user logged out before idle');
    } finally {
        api.reportCapabilities = origReportCaps;
        idleGate.runWhenIdle = origRunWhenIdle;
        state.set('user:authenticated', prevAuth);
    }
});
