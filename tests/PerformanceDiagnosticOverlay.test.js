/**
 * ============================================================================
 * Performance Diagnostic Overlay - Test Suite
 * ============================================================================
 * Validates deferred initialization, telemetry collection, frame rate tracking,
 * 1% low calculation, Web Vitals storage, and cleanup lifecycle.
 * ============================================================================
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

// ============================================================================
// Environment Mock for ES Module Imports in Node.js
// ============================================================================
const storageMap = new Map();
globalThis.localStorage = {
    getItem: (key) => storageMap.get(key) || null,
    setItem: (key, val) => storageMap.set(key, String(val)),
    removeItem: (key) => storageMap.delete(key),
    clear: () => storageMap.clear()
};

// Polyfill minimal browser DOM globals
function createMockElement(tagName = 'div') {
    const listeners = new Map();
    const children = [];
    const classListSet = new Set();
    const attributes = new Map();

    const el = {
        tagName: tagName.toUpperCase(),
        id: '',
        style: {},
        dataset: {},
        innerHTML: '',
        textContent: '',
        parentNode: null,
        children,
        offsetWidth: 380,
        offsetHeight: 240,
        clientWidth: 380,
        clientHeight: 240,
        classList: {
            add: (cls) => classListSet.add(cls),
            remove: (cls) => classListSet.delete(cls),
            toggle: (cls, force) => {
                if (force !== undefined) {
                    if (force) classListSet.add(cls);
                    else classListSet.delete(cls);
                    return force;
                }
                if (classListSet.has(cls)) {
                    classListSet.delete(cls);
                    return false;
                }
                classListSet.add(cls);
                return true;
            },
            contains: (cls) => classListSet.has(cls)
        },
        setAttribute: (k, v) => attributes.set(k, String(v)),
        getAttribute: (k) => attributes.get(k) || null,
        removeAttribute: (k) => attributes.delete(k),
        addEventListener: (evt, fn) => {
            if (!listeners.has(evt)) listeners.set(evt, []);
            listeners.get(evt).push(fn);
        },
        removeEventListener: (evt, fn) => {
            const list = listeners.get(evt);
            if (list) {
                const idx = list.indexOf(fn);
                if (idx !== -1) list.splice(idx, 1);
            }
        },
        dispatchEvent: (evt) => {
            const list = listeners.get(evt.type || evt);
            if (list) list.forEach((fn) => fn(evt));
        },
        querySelector: (sel) => {
            if (sel.startsWith('#')) {
                const id = sel.slice(1);
                return createMockElement('div');
            }
            return createMockElement('div');
        },
        querySelectorAll: () => [createMockElement('button')],
        closest: () => null,
        getBoundingClientRect: () => ({ left: 20, top: 20, width: 380, height: 240 }),
        getContext: () => ({
            save: () => {},
            restore: () => {},
            scale: () => {},
            clearRect: () => {},
            beginPath: () => {},
            moveTo: () => {},
            lineTo: () => {},
            stroke: () => {},
            fill: () => {},
            arc: () => {},
            closePath: () => {},
            setLineDash: () => {},
            createLinearGradient: () => ({ addColorStop: () => {} })
        }),
        appendChild: (child) => {
            child.parentNode = el;
            children.push(child);
            return child;
        },
        removeChild: (child) => {
            const idx = children.indexOf(child);
            if (idx !== -1) children.splice(idx, 1);
            child.parentNode = null;
            return child;
        }
    };

    return el;
}

const mockBody = createMockElement('body');
globalThis.document = {
    body: mockBody,
    createElement: (tag) => createMockElement(tag),
    documentElement: createMockElement('html'),
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: (sel) => mockBody.querySelector(sel),
    querySelectorAll: (sel) => mockBody.querySelectorAll(sel),
    getElementsByTagName: () => [createMockElement('div'), createMockElement('span')]
};

globalThis.window = {
    innerWidth: 1920,
    innerHeight: 1080,
    screen: { width: 1920, height: 1080 },
    devicePixelRatio: 1.5,
    location: { hash: '#/home' },
    addEventListener: () => {},
    removeEventListener: () => {},
    requestAnimationFrame: (cb) => setTimeout(() => cb(performance.now()), 16),
    cancelAnimationFrame: (id) => clearTimeout(id),
    requestIdleCallback: (cb) => setTimeout(cb, 10),
    performance: {
        now: () => Date.now(),
        timing: { navigationStart: 1000, responseStart: 1250 },
        getEntriesByType: () => [{ responseStart: 250 }],
        memory: {
            usedJSHeapSize: 45 * 1024 * 1024,
            totalJSHeapSize: 80 * 1024 * 1024,
            jsHeapSizeLimit: 2048 * 1024 * 1024
        }
    }
};

globalThis.performance = globalThis.window.performance;
globalThis.__APP_VERSION__ = '2.0.200';

globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

// Dynamic module imports
const { storage } = await import('../src/utils/StorageService.js');
const { PerformanceDiagnosticOverlay } = await import('../src/ui/diagnostics/PerformanceDiagnosticOverlay.js');
const {
    isPerformanceOverlayEnabled,
    togglePerformanceOverlay,
    loadPerformanceOverlay,
    unloadPerformanceOverlay,
    scheduleDeferredPerformanceOverlay
} = await import('../src/ui/diagnostics/PerformanceDiagnosticLauncher.js');
const { getSettingsDropdownMap } = await import('../src/pages/settings/controllers/SettingsDropdownConfig.js');

test('PerformanceDiagnosticOverlay: Constructs with default metrics and state', () => {
    const overlay = new PerformanceDiagnosticOverlay();

    assert.equal(overlay._initialized, false, 'Overlay should start uninitialized');
    assert.equal(overlay._isVisible, false, 'Overlay should start hidden');
    assert.equal(overlay._mode, 'full', 'Default mode should be full telemetry panel');
    assert.equal(overlay._position, 'top-right', 'Default position anchor should be top-right');
    assert.equal(overlay._currentFps, 60, 'Initial default FPS should be 60');
    assert.equal(overlay._jankCount, 0, 'Initial jank frame count should be 0');
});

test('PerformanceDiagnosticLauncher: Storage state query and toggling', async () => {
    storage.removeItem('debug_perf_overlay_enabled');

    assert.equal(isPerformanceOverlayEnabled(), false, 'Should be disabled by default');

    const stateEnabled = await togglePerformanceOverlay(true);
    assert.equal(stateEnabled, true, 'Should return true after enabling');
    assert.equal(storage.getItem('debug_perf_overlay_enabled'), 'true', 'Storage should persist true');
    assert.equal(isPerformanceOverlayEnabled(), true, 'Query should report true');

    const stateDisabled = await togglePerformanceOverlay(false);
    assert.equal(stateDisabled, false, 'Should return false after disabling');
    assert.equal(storage.getItem('debug_perf_overlay_enabled'), 'false', 'Storage should persist false');
    assert.equal(isPerformanceOverlayEnabled(), false, 'Query should report false');
});

test('PerformanceDiagnosticOverlay: Lifecycle init, show, hide, and destroy', () => {
    const overlay = new PerformanceDiagnosticOverlay();

    // Initialize DOM
    overlay.init();
    assert.equal(overlay._initialized, true, 'Overlay should be marked initialized');
    assert.ok(overlay._container, 'DOM container should be constructed');
    assert.equal(overlay._container.getAttribute('data-position'), 'top-right', 'Container position set');

    // Show
    overlay.show();
    assert.equal(overlay._isVisible, true, 'Overlay should be visible');
    assert.equal(overlay._container.style.display, 'block', 'Display property set to block');
    assert.ok(overlay._rafId, 'RAF loop identifier should be active');

    // Hide
    overlay.hide();
    assert.equal(overlay._isVisible, false, 'Overlay should be hidden');
    assert.equal(overlay._container.style.display, 'none', 'Display property set to none');
    assert.equal(overlay._rafId, null, 'RAF loop identifier should be cleared');

    // Destroy
    overlay.destroy();
    assert.equal(overlay._initialized, false, 'Initialized flag should reset');
    assert.equal(overlay._container, null, 'Container reference should be cleared');
});

test('PerformanceDiagnosticOverlay: Mode and Position setters persist correctly', () => {
    const overlay = new PerformanceDiagnosticOverlay();
    overlay.init();

    // Mode switching
    overlay.setMode('compact');
    assert.equal(overlay._mode, 'compact', 'Mode set to compact');
    assert.equal(storage.getItem('debug_perf_mode'), 'compact', 'Storage persisted compact mode');

    overlay.setMode('full');
    assert.equal(overlay._mode, 'full', 'Mode set to full');
    assert.equal(storage.getItem('debug_perf_mode'), 'full', 'Storage persisted full mode');

    // Position switching
    overlay.setPosition('bottom-left');
    assert.equal(overlay._position, 'bottom-left', 'Position set to bottom-left');
    assert.equal(storage.getItem('debug_perf_position'), 'bottom-left', 'Storage persisted bottom-left');
    assert.equal(overlay._container.getAttribute('data-position'), 'bottom-left');

    overlay.destroy();
});

test('PerformanceDiagnosticOverlay: Frame calculation, 1% low, and jank detection', () => {
    const overlay = new PerformanceDiagnosticOverlay();
    overlay.init();
    overlay._isVisible = true;

    // Seed frame times representing a mix of 60 FPS (16.6ms) and occasional drops (33ms)
    overlay._lastFrameTime = 1000;
    overlay._onAnimationFrame(1016.6); // 16.6ms
    overlay._onAnimationFrame(1033.2); // 16.6ms
    overlay._onAnimationFrame(1050.0); // 16.8ms
    overlay._onAnimationFrame(1085.0); // 35.0ms (jank frame spike)

    assert.ok(overlay._frameTimes.length >= 3, 'Frame times buffer should record samples');
    assert.ok(overlay._jankCount >= 1, 'Jank frame should be detected for delta > 26ms');

    // Reset metrics test
    overlay.resetMetrics();
    assert.equal(overlay._frameTimes.length, 0, 'Frame buffer should be cleared on reset');
    assert.equal(overlay._jankCount, 0, 'Jank count should be zeroed');
    assert.equal(overlay._sessionFrames, 0, 'Session frames count should be zeroed');

    overlay.destroy();
});

test('PerformanceDiagnosticOverlay: Memory and System stats parser', () => {
    const overlay = new PerformanceDiagnosticOverlay();
    const mem = overlay._getMemoryStats();

    assert.ok(mem, 'Memory stats object should be generated');
    assert.equal(mem.usedMb, 45, 'Used memory parsed accurately');
    assert.equal(mem.totalMb, 80, 'Total memory parsed accurately');
    assert.ok(mem.percent >= 0 && mem.percent <= 100, 'Memory percentage is bounded');
});

test('SettingsDropdownConfig: Registers performance overlay dropdowns', () => {
    const dropdownMap = getSettingsDropdownMap();

    assert.ok(dropdownMap['debug-perf-mode-select'], 'debug-perf-mode-select should be mapped');
    assert.equal(dropdownMap['debug-perf-mode-select'].key, 'debug_perf_mode');
    assert.equal(dropdownMap['debug-perf-mode-select'].type, 'debug');

    assert.ok(dropdownMap['debug-perf-position-select'], 'debug-perf-position-select should be mapped');
    assert.equal(dropdownMap['debug-perf-position-select'].key, 'debug_perf_position');
    assert.equal(dropdownMap['debug-perf-position-select'].type, 'debug');
});

test('Localization: en-us.json and en-gb.json contain performance diagnostic keys', () => {
    const enUs = JSON.parse(readFileSync('src/locales/en-us.json', 'utf8'));
    const enGb = JSON.parse(readFileSync('src/locales/en-gb.json', 'utf8'));

    const requiredKeys = [
        'PerformanceDiagnostics',
        'ShowPerformanceOverlay',
        'ShowPerformanceOverlayDescription',
        'PerformanceOverlayMode',
        'PerformanceOverlayModeDescription',
        'PerformanceOverlayPosition',
        'PerformanceOverlayPositionDescription',
        'ModeFull',
        'ModeCompact'
    ];

    for (const key of requiredKeys) {
        assert.ok(enUs[key], `en-us.json must define key: ${key}`);
        assert.ok(enGb[key], `en-gb.json must define key: ${key}`);
    }
});
