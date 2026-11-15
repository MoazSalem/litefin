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
    addEventListener: () => {},
    removeEventListener: () => {},
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

if (typeof globalThis.HTMLImageElement === 'undefined') {
    globalThis.HTMLImageElement = function () {};
    globalThis.HTMLImageElement.prototype = {
        decode: function () {
            return Promise.resolve();
        }
    };
}

globalThis.performance = globalThis.window.performance;
globalThis.__APP_VERSION__ = '2.0.350';

globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

// Dynamic module imports
const { storage } = await import('../src/utils/StorageService.js');
const { markPerfOperation } = await import('../src/utils/PerfMarker.js');
const { idleGate } = await import('../src/utils/IdleGate.js');
const { imageCache } = await import('../src/utils/ImageCache.js');
const { lazyLoader } = await import('../src/utils/LazyLoader.js');
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

test('PerformanceReportCollector: Longtask observer uses the type dictionary and captures route context', () => {
    const observeCalls = [];
    let observerCallback = null;

    class FakePerformanceObserver {
        static supportedEntryTypes = ['longtask'];

        constructor(cb) {
            observerCallback = cb;
        }

        observe(options) {
            // Mimic Chromium: the legacy `entryType` key must be rejected
            if (!options.type && !options.entryTypes) {
                throw new TypeError('An observe() call must include either entryTypes or type arguments.');
            }
            observeCalls.push(options);
        }

        disconnect() {}
    }

    const originalObserver = globalThis.PerformanceObserver;
    globalThis.PerformanceObserver = FakePerformanceObserver;

    const collector = new PerformanceReportCollector();
    collector.start();

    assert.deepEqual(
        observeCalls[0],
        { type: 'longtask', buffered: true },
        'Longtask observer must observe with { type, buffered }'
    );
    assert.equal(typeof observerCallback, 'function', 'Longtask entries must feed the collector');

    observerCallback({
        getEntries: () => [
            {
                startTime: collector._startTime + 500,
                duration: 90,
                attribution: [{ containerType: 'window', containerName: 'HomePage', containerSrc: 'HomePage.js' }]
            }
        ]
    });

    assert.equal(collector._longTasks.length, 1, 'Long task must be recorded');
    assert.equal(collector._longTasks[0].durationMs, 90, 'Duration preserved');
    assert.equal(collector._longTasks[0].route, '/home', 'Active route attached to the long task');
    assert.equal(collector._longTasks[0].containerName, 'HomePage', 'Attribution preserved');

    const report = collector.buildReport();
    assert.ok(report.text.includes('Route: /home'), 'Report renders route context');

    collector.stop();
    globalThis.PerformanceObserver = originalObserver;
});

test('PerformanceReportCollector: Longtask observer falls back to entryTypes on legacy engines', () => {
    const observeCalls = [];

    class LegacyPerformanceObserver {
        static supportedEntryTypes = ['longtask'];

        observe(options) {
            // Reject the modern dictionary form, accept the legacy entryTypes form
            if (options.type) {
                throw new TypeError('type is not supported');
            }
            observeCalls.push(options);
        }

        disconnect() {}
    }

    const originalObserver = globalThis.PerformanceObserver;
    globalThis.PerformanceObserver = LegacyPerformanceObserver;

    const collector = new PerformanceReportCollector();
    collector.start();

    assert.deepEqual(
        observeCalls[0],
        { entryTypes: ['longtask'] },
        'Legacy engines must fall back to the entryTypes form'
    );

    collector.stop();
    globalThis.PerformanceObserver = originalObserver;
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

test('PerformanceReportCollector: Separates pre-start long tasks from active blocking metrics', () => {
    const collector = new PerformanceReportCollector();
    collector.start();

    // Buffered cold-boot entry occurring before collector._startTime
    collector._recordLongTask({
        startTime: collector._startTime - 500,
        duration: 420,
        attribution: [{ containerType: 'window', containerName: 'boot' }]
    });

    // Normal post-start long task
    collector._recordLongTask({
        startTime: collector._startTime + 250,
        duration: 85,
        attribution: [{ containerType: 'window', containerName: 'runtime' }]
    });

    const report = collector.buildReport();

    assert.equal(report.json.longTasks.totalDetected, 1, 'Only post-start tasks count in longTasks.totalDetected');
    assert.equal(report.json.longTasks.totalBlockingTimeMs, 85, 'Pre-start freezes must not inflate totalBlockingTimeMs');
    assert.equal(report.json.longTasks.longestTaskMs, 85, 'Pre-start freezes must not inflate longestTaskMs');
    assert.equal(report.json.preStartLongTasks.totalDetected, 1, 'Pre-start freeze preserved in preStartLongTasks');
    assert.ok(report.text.includes('Pre-Start Tasks (Excluded):  1'), 'ASCII summary notes excluded pre-start count');

    collector.stop();
});

test('PerformanceReportCollector: markOperation ring buffer & time-window attribution via PerfMarker bridge', () => {
    const collector = new PerformanceReportCollector();
    collector.start();

    // Push 6 operations through the PerfMarker bridge to verify 5-entry cap
    const baseNow = collector._startTime + 1000;
    const origPerfNow = globalThis.performance?.now;
    let fakeNow = baseNow;

    if (!globalThis.performance) {
        globalThis.performance = { now: () => fakeNow };
    } else {
        globalThis.performance.now = () => fakeNow;
    }

    try {
        for (let i = 1; i <= 6; i++) {
            fakeNow = baseNow + i * 100; // 1100, 1200, ..., 1600
            markPerfOperation(`Op.${i}`);
        }

        assert.equal(collector._recentOperations.length, 5, 'Operation ring buffer capped at 5 entries');
        assert.equal(collector._recentOperations[0].name, 'Op.2', 'Oldest entry evicted from 5-slot ring buffer');

        // 1. Primary window [startTime - 50, startTime + duration] matches Op.6 (at 1600) cleanly
        collector._recordLongTask({
            startTime: baseNow + 640, // window [1590, 1720] includes Op.6 (1600) within 50ms lookback
            duration: 80,
            attribution: []
        });

        // 2. Fallback window: task starting 110ms after Op.6 -> 'Op.6 (+110ms)'
        collector._recordLongTask({
            startTime: baseNow + 710, // delta = 1710 - 1600 = 110ms (outside 50ms primary, inside 250ms fallback)
            duration: 65,
            attribution: []
        });

        // 3. Beyond 250ms fallback (delta = 260ms) -> no operation attribution
        collector._recordLongTask({
            startTime: baseNow + 860, // delta = 1860 - 1600 = 260ms > 250ms
            duration: 60,
            attribution: []
        });

        const report = collector.buildReport();
        assert.equal(report.json.longTasks.entries[0].operation, 'Op.6');
        assert.equal(report.json.longTasks.entries[1].operation, 'Op.6 (+110ms)');
        assert.equal(report.json.longTasks.entries[2].operation, '');
        assert.ok(report.text.includes('| Op: Op.6 |'), 'ASCII long task line must display matched Op label');
        assert.ok(
            report.text.includes('| Op: Op.6 (+110ms) |'),
            'ASCII long task line must display 250ms fallback delta format'
        );
        assert.ok(!report.text.includes('| Op:  |'), 'ASCII long task line must omit empty Op label');

        // Stop collector and confirm PerfMarker bridge unbinds cleanly
        collector.stop();
        markPerfOperation('Op.AfterStop');
        assert.equal(collector._recentOperations.length, 5, 'Stopped collector ignores PerfMarker broadcasts');
    } finally {
        if (origPerfNow) {
            globalThis.performance.now = origPerfNow;
        }
    }
});

test('PerformanceReportCollector: 200 long-task ring buffer capacity and pre/during/post playback telemetry split', async () => {
    const { eventBus } = await import('../src/core/EventBus.js');
    const collector = new PerformanceReportCollector();

    assert.equal(collector._maxLongTasks, 200, 'Long tasks capacity should be sized to 200 entries');

    collector.start();

    // 1. Verify 200-task ring buffer capacity
    for (let i = 0; i < 210; i++) {
        collector._recordLongTask({
            startTime: collector._startTime + (i * 10),
            duration: 55,
            attribution: []
        });
    }
    assert.equal(collector._longTasks.length, 200, 'Ring buffer must hold up to 200 long tasks');
    assert.equal(collector._longTasks[0].timeOffsetMs, 100, 'Oldest 10 tasks evicted when exceeding 200 capacity');

    // 2. Pre-playback UI frame simulation on /home
    collector._lastFrameTime = 1000;
    globalThis.window.location.hash = '#/home';
    collector._onFrame(1016); // 16ms -> <16.7ms
    collector._onFrame(1036); // 20ms -> 16.7-25ms
    collector._onFrame(1096); // 60ms -> >50ms

    assert.equal(collector._prePlaybackFrames.count, 3, 'Pre-playback frame count');
    assert.equal(collector._prePlaybackFrames.under16ms, 1, 'Pre-playback <16.7ms frame count');
    assert.equal(collector._prePlaybackFrames.under25ms, 1, 'Pre-playback 16.7-25ms frame count');
    assert.equal(collector._prePlaybackFrames.over50ms, 1, 'Pre-playback >50ms frame count');

    // 3. During playback frame simulation on /player
    eventBus.emit('router:navigate', { path: '/player/video123' });
    globalThis.window.location.hash = '#/player/video123';
    collector._onFrame(1112); // 16ms -> <16.7ms
    collector._onFrame(1132); // 20ms -> 16.7-25ms

    assert.equal(collector._duringPlaybackFrames.count, 2, 'During-playback frame count');
    assert.equal(collector._duringPlaybackFrames.under16ms, 1, 'During-playback <16.7ms frame count');
    assert.equal(collector._duringPlaybackFrames.under25ms, 1, 'During-playback 16.7-25ms frame count');

    // 4. Post-playback frame simulation on /details after player:stop
    eventBus.emit('player:stopped', { itemId: 'video123', reason: 'back' });
    eventBus.emit('router:navigate', { path: '/details/video123' });
    globalThis.window.location.hash = '#/details/video123';
    collector._onFrame(1148); // 16ms -> <16.7ms
    collector._onFrame(1210); // 62ms -> >50ms

    assert.equal(collector._postPlaybackFrames.count, 2, 'Post-playback frame count');
    assert.equal(collector._postPlaybackFrames.under16ms, 1, 'Post-playback <16.7ms frame count');
    assert.equal(collector._postPlaybackFrames.over50ms, 1, 'Post-playback >50ms frame count');

    // 5. Build report and verify Section 3 breakdown in ASCII text and structured JSON
    const report = collector.buildReport();

    // Verify structured JSON contains playback phase objects
    assert.ok(report.json.framerates.prePlayback, 'JSON contains prePlayback telemetry');
    assert.equal(report.json.framerates.prePlayback.totalFrames, 3);
    assert.ok(report.json.framerates.duringPlayback, 'JSON contains duringPlayback telemetry');
    assert.equal(report.json.framerates.duringPlayback.totalFrames, 2);
    assert.ok(report.json.framerates.postPlayback, 'JSON contains postPlayback telemetry');
    assert.equal(report.json.framerates.postPlayback.totalFrames, 2);

    // Verify ASCII report includes Section 3 playback phase breakdown
    assert.ok(report.text.includes('Playback Phase Breakdown:'), 'ASCII includes Playback Phase Breakdown header');
    assert.ok(report.text.includes('Pre-Playback UI Frames:'), 'ASCII includes Pre-Playback UI Frames');
    assert.ok(report.text.includes('During Playback Frames:'), 'ASCII includes During Playback Frames');
    assert.ok(report.text.includes('Post-Playback UI Frames:'), 'ASCII includes Post-Playback UI Frames');

    // Verify JSON bundle retains all 200 long tasks
    assert.equal(report.json.longTasks.entries.length, 200, 'JSON retains all 200 long tasks');

    collector.stop();
});

test('PerformanceReportCollector: Long tasks grouped by route and operation with duration aggregation', () => {
    // Instantiate clean collector instance
    const collector = new PerformanceReportCollector();

    // Prepare simulated long tasks across different pages and operations
    const simulatedTasks = [
        {
            route: '/home',
            operation: 'HeroCarousel.commitBackdrop',
            durationMs: 644
        },
        {
            route: '/home',
            operation: 'HeroCarousel.commitBackdrop (+45ms)',
            durationMs: 175
        },
        {
            route: '/home',
            operation: 'HeroCarousel.finalizeLogo',
            durationMs: 312
        },
        {
            route: '/library',
            operation: 'VirtualGrid.renderChunk',
            durationMs: 180
        },
        {
            route: '/library',
            operation: '', // Unattributed
            durationMs: 95
        }
    ];

    // Execute grouping logic
    const { byRoute, byOperation } = collector._groupLongTasks(simulatedTasks);

    // ========================================================================
    // Verify grouping by route
    // ========================================================================
    assert.ok(byRoute['/home'], 'Route /home exists');
    assert.equal(byRoute['/home'].count, 3, 'Route /home should have 3 tasks');
    assert.equal(byRoute['/home'].totalDurationMs, 644 + 175 + 312, 'Route /home total duration matches');
    assert.equal(byRoute['/home'].maxDurationMs, 644, 'Route /home max duration matches');
    assert.equal(byRoute['/home'].operations['HeroCarousel.commitBackdrop'].count, 2, 'Sub-operations aggregated');

    assert.ok(byRoute['/library'], 'Route /library exists');
    assert.equal(byRoute['/library'].count, 2, 'Route /library should have 2 tasks');
    assert.equal(byRoute['/library'].totalDurationMs, 275, 'Route /library total duration matches');

    // ========================================================================
    // Verify grouping by operation (timing offsets like +45ms stripped)
    // ========================================================================
    assert.ok(byOperation['HeroCarousel.commitBackdrop'], 'Base operation should exist');
    assert.equal(byOperation['HeroCarousel.commitBackdrop'].count, 2, 'Commit backdrop tasks consolidated');
    assert.equal(byOperation['HeroCarousel.commitBackdrop'].totalDurationMs, 819, 'Sum of commitBackdrop durations');
    assert.equal(byOperation['HeroCarousel.commitBackdrop'].maxDurationMs, 644, 'Max duration of commitBackdrop');
    assert.deepEqual(byOperation['HeroCarousel.commitBackdrop'].routes, ['/home'], 'Associated routes list');

    assert.ok(byOperation['(unattributed)'], 'Empty operation falls back to (unattributed)');
    assert.equal(byOperation['(unattributed)'].count, 1);
    assert.equal(byOperation['(unattributed)'].totalDurationMs, 95);
});

test('PerformanceReportCollector: requestIdleCallback & HTMLImageElement.decode execution tracking', async () => {
    // Preserve any existing globals
    const origRIC = globalThis.window.requestIdleCallback;
    const origDecode = globalThis.HTMLImageElement.prototype.decode;

    // Track simulated calls
    let rICCalled = 0;
    const testRIC = function (cb) {
        rICCalled++;
        return setTimeout(() => {
            cb({ timeRemaining: () => 15, didTimeout: false });
        }, 5);
    };
    globalThis.window.requestIdleCallback = testRIC;

    let decodeCalled = 0;
    const testDecode = function () {
        decodeCalled++;
        return new Promise((resolve) => {
            setTimeout(resolve, 12);
        });
    };
    globalThis.HTMLImageElement.prototype.decode = testDecode;

    const collector = new PerformanceReportCollector();
    collector.start();

    // Verify collector wrapped requestIdleCallback and HTMLImageElement.prototype.decode
    assert.notEqual(globalThis.window.requestIdleCallback, testRIC, 'requestIdleCallback wrapped');
    assert.notEqual(globalThis.HTMLImageElement.prototype.decode, testDecode, 'image decode wrapped');

    // Trigger wrapped requestIdleCallback
    await new Promise((resolve) => {
        globalThis.window.requestIdleCallback(() => {
            resolve();
        });
    });

    assert.equal(rICCalled, 1, 'Simulated RIC was invoked');
    assert.equal(collector._idleCallbacks.scheduledCount, 1, 'RIC scheduled count incremented');
    assert.equal(collector._idleCallbacks.executedCount, 1, 'RIC executed count incremented');
    assert.ok(collector._idleCallbacks.totalDurationMs >= 0, 'RIC execution duration recorded');

    // Trigger wrapped image decode
    const mockImg = new globalThis.HTMLImageElement();
    await mockImg.decode();

    assert.equal(decodeCalled, 1, 'Simulated decode was invoked');
    assert.equal(collector._imageDecodes.count, 1, 'Image decode count incremented');
    assert.ok(collector._imageDecodes.totalDurationMs >= 0, 'Image decode duration recorded');

    // Test record slow decode (> 50ms)
    collector._recordImageDecode(65);
    assert.equal(collector._imageDecodes.count, 2, 'Total decode count updated');
    assert.equal(collector._imageDecodes.slowDecodesCount, 1, 'Slow decode count detected (>50ms)');
    assert.equal(collector._imageDecodes.maxDurationMs, 65, 'Max decode duration updated');

    // Stop and verify restoration
    collector.stop();
    assert.equal(globalThis.HTMLImageElement.prototype.decode, testDecode, 'image decode restored to test function');
    assert.equal(globalThis.window.requestIdleCallback, testRIC, 'requestIdleCallback restored to test function');

    // Clean up globals back to originals
    globalThis.HTMLImageElement.prototype.decode = origDecode;
    globalThis.window.requestIdleCallback = origRIC;
});

test('PerformanceReportCollector: Image cache hit/miss ratio, pending image requests & background tasks', () => {
    // Reset ImageCache state
    imageCache.clear();

    // Pre-warm sample URL
    imageCache._warmedMap['http://localhost:8096/Images/1'] = true;
    imageCache._warmedList.push('http://localhost:8096/Images/1');

    // Simulate accesses
    imageCache.recordAccess('http://localhost:8096/Images/1'); // Hit
    imageCache.recordAccess('http://localhost:8096/Images/1'); // Hit
    imageCache.recordAccess('http://localhost:8096/Images/2'); // Miss

    const stats = imageCache.getStats();
    assert.equal(stats.hits, 2, 'Cache hit count');
    assert.equal(stats.misses, 1, 'Cache miss count');
    assert.equal(stats.hitRatio, 0.667, 'Hit ratio rounded to 3 decimal places');
    assert.equal(stats.hitPercentage, '66.7%', 'Hit percentage formatted string');

    // Verify IdleGate pending task count
    assert.equal(typeof idleGate.getPendingTaskCount(), 'number', 'IdleGate reports task count');

    // Verify LazyLoader pending count
    assert.equal(typeof lazyLoader.getPendingCount(), 'number', 'LazyLoader reports pending count');

    // Build report and verify runtimeMetrics section
    const collector = new PerformanceReportCollector();
    collector.start();

    const report = collector.buildReport();

    // Verify JSON payload structure
    assert.ok(report.json.runtimeMetrics, 'Report contains runtimeMetrics');
    assert.ok(report.json.runtimeMetrics.imageCache, 'Report contains imageCache stats');
    assert.equal(report.json.runtimeMetrics.imageCache.hits, 2);
    assert.equal(report.json.runtimeMetrics.imageCache.misses, 1);
    assert.ok(report.json.runtimeMetrics.imageRequests, 'Report contains imageRequests stats');
    assert.ok(report.json.runtimeMetrics.backgroundTasks, 'Report contains backgroundTasks stats');

    // Verify ASCII formatted report contains Section 8
    assert.ok(
        report.text.includes('8. RUNTIME BACKGROUND WORK, IMAGES & IDLE STATE'),
        'ASCII report contains Section 8'
    );
    assert.ok(report.text.includes('Image Cache Hit / Miss Performance:'), 'ASCII contains cache header');
    assert.ok(report.text.includes('Pre-warmed URLs in Memory: 1'), 'ASCII shows warmed URL count');

    collector.stop();
});

test('PerformanceReportCollector: performance.memory and user interaction elapsed time metrics', () => {
    // Set user activity baseline
    idleGate.markActivity();

    const collector = new PerformanceReportCollector();
    collector.start();

    // Add a test long task so grouped tasks format in text
    collector._recordLongTask({
        startTime: collector._startTime + 500,
        duration: 150,
        route: '/home',
        operation: 'HeroCarousel.commitBackdrop'
    });

    const report = collector.buildReport();

    // 1. Verify performance.memory metrics
    assert.ok(report.json.memory, 'Report contains memory object');
    assert.equal(report.json.memory.usedMb, '45.0', 'Used JS Heap formatted in MB');
    assert.equal(report.json.memory.totalMb, '80.0', 'Total JS Heap formatted in MB');
    assert.equal(report.json.memory.limitMb, '2048.0', 'JS Heap Limit formatted in MB');
    assert.ok(report.json.memory.utilizationPct.endsWith('%'), 'Heap utilization percentage present');

    // 2. Verify user activity metrics
    assert.ok(report.json.runtimeMetrics.userActivity, 'Runtime metrics contains userActivity');
    assert.ok(
        typeof report.json.runtimeMetrics.userActivity.timeSinceLastInteractionSec === 'number',
        'Time since last interaction is numeric'
    );

    // 3. Verify grouped long tasks in JSON
    assert.ok(report.json.longTasks.groupedByRoute, 'Long tasks grouped by route present');
    assert.ok(report.json.longTasks.groupedByOperation, 'Long tasks grouped by operation present');

    // 4. Verify ASCII report content
    assert.ok(report.text.includes('Time Since Last User Input:'), 'ASCII includes Time Since Last User Input');
    assert.ok(report.text.includes('Long Tasks Grouped by Route:'), 'ASCII includes Long Tasks Grouped by Route');
    assert.ok(report.text.includes('Long Tasks Grouped by Operation:'), 'ASCII includes Long Tasks Grouped by Operation');
    assert.ok(report.text.includes('Total JS Heap Allocated:'), 'ASCII includes Total JS Heap Allocated');
    assert.ok(report.text.includes('JS Heap Utilization:'), 'ASCII includes JS Heap Utilization');

    collector.stop();
});
