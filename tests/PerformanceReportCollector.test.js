/**
 * ============================================================================
 * Performance Report Collector - Test Suite
 * ============================================================================
 * Validates performance profiling lifecycle, main-thread long task collection,
 * frame time distribution buckets, 1% low percentiles, report generation,
 * and server upload interface.
 * ============================================================================
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

// Mock storage map
const storageMap = new Map();
globalThis.localStorage = {
    getItem: (key) => storageMap.get(key) || null,
    setItem: (key, val) => storageMap.set(key, String(val)),
    removeItem: (key) => storageMap.delete(key),
    clear: () => storageMap.clear()
};

// Polyfill minimal browser globals
function createMockElement(tagName = 'div') {
    return {
        tagName: tagName.toUpperCase(),
        style: {},
        classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
        setAttribute: () => {},
        getAttribute: () => null,
        addEventListener: () => {},
        removeEventListener: () => {}
    };
}

globalThis.document = {
    body: createMockElement('body'),
    documentElement: createMockElement('html'),
    addEventListener: () => {},
    removeEventListener: () => {},
    getElementsByTagName: () => [createMockElement('div'), createMockElement('span')]
};

globalThis.window = {
    innerWidth: 1920,
    innerHeight: 1080,
    screen: { width: 1920, height: 1080 },
    devicePixelRatio: 1.5,
    location: { hash: '#/home' },
    requestAnimationFrame: (cb) => setTimeout(() => cb(Date.now()), 16),
    cancelAnimationFrame: (id) => clearTimeout(id),
    requestIdleCallback: (cb) => setTimeout(cb, 10),
    performance: {
        now: () => Date.now(),
        getEntriesByType: () => [
            { name: 'http://localhost:8096/Items/123/Images/Primary', duration: 450 },
            { name: 'http://localhost:8096/Users/456/Items', duration: 320 }
        ],
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
const { PerformanceReportCollector } = await import('../src/ui/diagnostics/PerformanceReportCollector.js');
const {
    isPerformanceCollectorEnabled,
    togglePerformanceCollector,
    loadPerformanceCollector,
    unloadPerformanceCollector,
    scheduleDeferredPerformanceCollector,
    generatePerformanceReport,
    uploadPerformanceReport
} = await import('../src/ui/diagnostics/PerformanceDiagnosticLauncher.js');

test('PerformanceReportCollector: Constructs with default inactive state and clean buffers', () => {
    const collector = new PerformanceReportCollector();

    assert.equal(collector.isActive(), false, 'Collector should start inactive');
    assert.equal(collector._totalFrames, 0, 'Total frames should initialize to 0');
    assert.equal(collector._longTasks.length, 0, 'Long tasks list should start empty');
    assert.equal(collector._distribution.under16ms, 0, 'Distribution bucket should start empty');
});

test('PerformanceReportCollector: Start and stop lifecycle with observer setup and teardown', () => {
    const collector = new PerformanceReportCollector();

    // Start collection
    collector.start();
    assert.equal(collector.isActive(), true, 'Collector should be marked active');
    assert.ok(collector._rafId, 'RAF loop should be running');
    assert.ok(collector._startTime > 0, 'Start time should be recorded');

    // Stop collection
    collector.stop();
    assert.equal(collector.isActive(), false, 'Collector should be marked inactive');
    assert.equal(collector._rafId, null, 'RAF loop should be suspended');
});

test('PerformanceReportCollector: Long tasks capturing and duration tracking', () => {
    const collector = new PerformanceReportCollector();
    collector.start();

    // Simulate 3 long tasks (>50ms main-thread blockage)
    collector._recordLongTask({
        startTime: collector._startTime + 1000,
        duration: 75,
        attribution: [{ containerType: 'window', containerName: 'App', containerSrc: 'app.js' }]
    });

    collector._recordLongTask({
        startTime: collector._startTime + 2500,
        duration: 120,
        attribution: [{ containerType: 'iframe', containerName: 'Player', containerSrc: 'player.js' }]
    });

    collector._recordLongTask({
        startTime: collector._startTime + 4000,
        duration: 55,
        attribution: []
    });

    assert.equal(collector._longTasks.length, 3, 'Should record 3 long tasks');
    assert.equal(collector._totalLongTaskTimeMs, 250, 'Total blocking time should sum to 250ms');
    assert.equal(collector._maxLongTaskMs, 120, 'Max long task should be 120ms');

    collector.stop();
});

test('PerformanceReportCollector: Frame timing, distribution buckets, and jank event logging', () => {
    const collector = new PerformanceReportCollector();
    collector.start();

    // Simulate frame sequence with various frame times
    collector._lastFrameTime = 1000;
    collector._onFrame(1015); // 15ms -> < 16.7ms bucket
    collector._onFrame(1035); // 20ms -> 16.7 - 25ms bucket
    collector._onFrame(1065); // 30ms -> 25 - 33.3ms bucket (and > 26ms jank)
    collector._onFrame(1110); // 45ms -> 33.3 - 50ms bucket (and > 26ms jank)
    collector._onFrame(1180); // 70ms -> > 50ms bucket (severe stutter)

    assert.equal(collector._totalFrames, 5, 'Total frames recorded');
    assert.equal(collector._distribution.under16ms, 1, '15ms frame counted in < 16.7ms bucket');
    assert.equal(collector._distribution.under25ms, 1, '20ms frame counted in 16.7-25ms bucket');
    assert.equal(collector._distribution.under33ms, 1, '30ms frame counted in 25-33.3ms bucket');
    assert.equal(collector._distribution.under50ms, 1, '45ms frame counted in 33.3-50ms bucket');
    assert.equal(collector._distribution.over50ms, 1, '70ms frame counted in > 50ms bucket');
    assert.equal(collector._jankEvents.length, 3, 'Frames over 26ms logged as jank stutter events');

    collector.stop();
});

test('PerformanceReportCollector: Percentile calculation (1% low and 0.1% low)', () => {
    const collector = new PerformanceReportCollector();

    // Populate frame intervals buffer (mostly 16.6ms with a few 40ms and 80ms drops)
    for (let i = 0; i < 98; i++) {
        collector._frameIntervals.push(16.6); // ~60 FPS
    }
    collector._frameIntervals.push(40.0); // 25 FPS
    collector._frameIntervals.push(80.0); // 12.5 FPS (worst drop)

    const percentiles = collector._calculatePercentiles();

    assert.ok(percentiles.onePercentLow > 0, '1% low calculated');
    assert.ok(percentiles.pointOnePercentLow > 0, '0.1% low calculated');
    assert.ok(percentiles.onePercentLow <= 60, '1% low bounded below 60 FPS');
});

test('PerformanceReportCollector: Build formatted report output (ASCII text & JSON payload)', () => {
    const collector = new PerformanceReportCollector();
    collector.start();

    // Seed test telemetry
    collector._totalFrames = 120;
    collector._totalDurationMs = 2000;
    collector._distribution.under16ms = 110;
    collector._distribution.under25ms = 10;
    collector._recordLongTask({
        startTime: collector._startTime + 100,
        duration: 65,
        attribution: [{ containerType: 'window', containerName: 'App' }]
    });

    const report = collector.buildReport();

    assert.ok(report.text, 'Formatted text report generated');
    assert.ok(report.json, 'Structured JSON telemetry bundle generated');

    // Verify sections in text report
    assert.ok(report.text.includes('LITEFIN PERFORMANCE DIAGNOSTIC AUDIT REPORT'), 'Includes header title');
    assert.ok(report.text.includes('1. HARDWARE, DISPLAY & ENVIRONMENT'), 'Includes Section 1');
    assert.ok(report.text.includes('2. CORE WEB VITALS & LOAD TIMING'), 'Includes Section 2');
    assert.ok(report.text.includes('3. FRAMERATE & REFRESH PACING TELEMETRY'), 'Includes Section 3');
    assert.ok(report.text.includes('4. MAIN THREAD LONG TASKS'), 'Includes Section 4');
    assert.ok(report.text.includes('5. MEMORY CONSUMPTION & DOM COMPLEXITY'), 'Includes Section 5');
    assert.ok(report.text.includes('RAW JSON TELEMETRY BUNDLE'), 'Includes raw JSON segment');

    collector.stop();
});

test('PerformanceReportCollector: Route transitions capture accurate source/target pairs and quick jumps', async () => {
    // Import event bus to trigger navigation events
    const { eventBus } = await import('../src/core/EventBus.js');
    const collector = new PerformanceReportCollector();
    collector.start();

    // Trigger initial navigation to library
    eventBus.emit('router:navigate', { path: '/library/123' });

    // Verify first recorded navigation pair
    assert.equal(collector._routeNavigations.length, 1, 'First navigation registered');
    assert.equal(collector._routeNavigations[0].to, '/library/123', 'Target route captured');

    // Trigger immediate subsequent jump to details before settle window finishes
    eventBus.emit('router:navigate', { path: '/details/456' });

    // Ensure earlier route was resolved and from/to chain is preserved
    assert.equal(collector._routeNavigations.length, 2, 'Second navigation registered');
    assert.equal(collector._routeNavigations[1].from, '/library/123', 'Previous route tracked as source');
    assert.equal(collector._routeNavigations[1].to, '/details/456', 'New route tracked as target');

    collector.stop();
});

test('PerformanceDiagnosticLauncher: Performance collector state and facades', async () => {
    storage.removeItem('debug_perf_collector_enabled');

    assert.equal(isPerformanceCollectorEnabled(), false, 'Collector should be disabled by default');

    // Toggle on
    const enabled = await togglePerformanceCollector(true);
    assert.equal(enabled, true, 'Toggle on returns true');
    assert.equal(isPerformanceCollectorEnabled(), true, 'Query reports true');
    assert.equal(storage.getItem('debug_perf_collector_enabled'), 'true', 'Storage persisted true');

    // Load and unload facades
    const loaded = await loadPerformanceCollector();
    assert.ok(loaded, 'Collector loaded');
    await unloadPerformanceCollector();

    // Generate report facade
    const report = await generatePerformanceReport();
    assert.ok(report.text, 'Report facade compiles report text');

    // Mock upload interface
    const { api } = await import('../src/api/index.js');
    let uploadedFilename = null;
    let uploadedContent = null;
    api.uploadClientLog = async (name, content) => {
        uploadedFilename = name;
        uploadedContent = content;
        return { success: true };
    };

    const uploadRes = await uploadPerformanceReport('test_report.txt');
    assert.ok(uploadRes.success, 'Upload facade reports success');
    assert.equal(uploadedFilename, 'test_report.txt');
    assert.ok(uploadedContent.includes('LITEFIN PERFORMANCE DIAGNOSTIC AUDIT REPORT'));

    // Toggle off
    const disabled = await togglePerformanceCollector(false);
    assert.equal(disabled, false, 'Toggle off returns false');
    assert.equal(isPerformanceCollectorEnabled(), false, 'Query reports false');
    assert.equal(storage.getItem('debug_perf_collector_enabled'), 'false', 'Storage persisted false');

    // Deferred scheduling (safely skips when disabled)
    scheduleDeferredPerformanceCollector();
});

test('Localization: en-us.json and en-gb.json contain performance collector keys', () => {
    const enUs = JSON.parse(readFileSync('src/locales/en-us.json', 'utf8'));
    const enGb = JSON.parse(readFileSync('src/locales/en-gb.json', 'utf8'));

    const requiredKeys = [
        'EnablePerformanceCollector',
        'EnablePerformanceCollectorDescription',
        'UploadPerformanceReport',
        'UploadPerformanceReportDescription',
        'UploadReport'
    ];

    for (const key of requiredKeys) {
        assert.ok(enUs[key], `en-us.json must define key: ${key}`);
        assert.ok(enGb[key], `en-gb.json must define key: ${key}`);
    }
});
