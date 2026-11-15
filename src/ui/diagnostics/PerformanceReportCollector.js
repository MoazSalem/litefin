/**
 * ============================================================================
 * Performance Report Collector & Profiling Subsystem
 * ============================================================================
 * Comprehensive background telemetry engine collecting frame pacing percentiles,
 * main-thread long tasks (>50ms), memory allocations, route transition latency,
 * Core Web Vitals, and resource bottlenecks.
 *
 * Lazy-loaded and completely dormant when disabled. When toggled on from
 * settings, it continuously records high-resolution diagnostics and packages
 * them into a formatted audit report uploadable to the Jellyfin server.
 * ============================================================================
 */

import { storage } from '../../utils/StorageService.js';
import { platformInfo } from '../../utils/PlatformInfo.js';
import { eventBus } from '../../core/EventBus.js';
import { router } from '../../core/Router.js';
import { setPerfOperationHandler } from '../../utils/PerfMarker.js';
import { logger } from '../../utils/Logger.js';
import { idleGate } from '../../utils/IdleGate.js';
import { imageCache } from '../../utils/ImageCache.js';
import { lazyLoader } from '../../utils/LazyLoader.js';

const log = logger.create('PerfCollector');

/**
 * Universal requestAnimationFrame provider supporting headless/test environments.
 * @param {Function} cb Frame callback
 * @returns {number} RAF or timer identifier
 */
function requestFrame(cb) {
    if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(cb);
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        return window.requestAnimationFrame(cb);
    }
    return setTimeout(() => cb(Date.now()), 16);
}

/**
 * Universal cancelAnimationFrame provider.
 * @param {number} id Identifier
 */
function cancelFrame(id) {
    if (typeof cancelAnimationFrame === 'function') return cancelAnimationFrame(id);
    if (typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
        return window.cancelAnimationFrame(id);
    }
    clearTimeout(id);
}

/**
 * Resolves the active Litefin application version from compile-time defines or runtime globals.
 * Fallback defaults to current package version if runtime environment lacks define injection.
 * @returns {string} Application version string
 */
function resolveAppVersion() {
    try {
        if (typeof __APP_VERSION__ !== 'undefined' && __APP_VERSION__) {
            return String(__APP_VERSION__);
        }
    } catch (_) {}
    if (typeof globalThis !== 'undefined' && globalThis.__APP_VERSION__) {
        return String(globalThis.__APP_VERSION__);
    }
    if (typeof window !== 'undefined' && window.__APP_VERSION__) {
        return String(window.__APP_VERSION__);
    }
    return '2.0.350';
}

/**
 * Diagnostics collector recording telemetry for server upload.
 */
export class PerformanceReportCollector {
    /**
     * Initializes internal data buffers and counters.
     */
    constructor() {
        // Activation state flag
        this._active = false;

        // Session timing markers
        this._startTime = 0;
        this._startDate = '';
        this._initialRoute = '/';

        // Frame rate monitoring state
        this._rafId = null;
        this._lastFrameTime = 0;
        this._totalFrames = 0;
        this._totalDurationMs = 0;
        this._minFps = Infinity;
        this._maxFps = 0;

        // Reservoir sampling of frame intervals (up to 2000 samples for percentile calculations)
        this._frameIntervals = [];
        this._maxIntervalSamples = 2000;

        // Frame time distribution histogram buckets
        this._distribution = {
            under16ms: 0, // < 16.7ms (>= 60 FPS)
            under25ms: 0, // 16.7ms - 25.0ms (40 - 60 FPS)
            under33ms: 0, // 25.0ms - 33.3ms (30 - 40 FPS)
            under50ms: 0, // 33.3ms - 50.0ms (20 - 30 FPS)
            over50ms: 0 // > 50.0ms (< 20 FPS - Severe Stutter)
        };

        /*
         * Playback lifecycle telemetry state.
         * Distinguishes whether the user has triggered media playback during the session,
         * segmenting framerate telemetry into pre-playback, active playback, and post-playback.
         */
        this._hasPlayedVideo = false;

        // Telemetry counters partitioned by playback lifecycle phase
        this._prePlaybackFrames = { count: 0, durationMs: 0, under16ms: 0, under25ms: 0, over50ms: 0 };
        this._duringPlaybackFrames = { count: 0, durationMs: 0, under16ms: 0, under25ms: 0, over50ms: 0 };
        this._postPlaybackFrames = { count: 0, durationMs: 0, under16ms: 0, under25ms: 0, over50ms: 0 };

        // Ring buffer of worst frame drop events (duration > 26ms)
        this._jankEvents = [];
        this._maxJankEvents = 30;

        /*
         * Main thread long tasks (> 50ms) recorded after collector start().
         * Sized to 200-task capacity so multi-minute profiling sessions retain early
         * boot and page-mount freezes alongside sustained navigation tasks.
         */
        this._longTasks = [];
        this._maxLongTasks = 200;
        this._totalLongTaskTimeMs = 0;
        this._maxLongTaskMs = 0;

        // Buffered long tasks whose startTime precedes this._startTime (cold boot eval)
        this._preStartLongTasks = [];
        this._maxPreStartLongTasks = 30;

        // Bounded ring buffer of recent JS operations (last 5 entries) used to
        // attribute captured long tasks back to the originating UI interaction.
        this._recentOperations = [];
        this._maxRecentOperations = 5;

        // Web Vitals metrics
        this._vitals = {
            lcp: null,
            lcpElement: 'N/A',
            fcp: null,
            cls: 0,
            inp: null,
            fid: null,
            ttfb: null
        };

        // Memory and DOM tracking metrics
        this._initialHeapBytes = null;
        this._peakHeapBytes = null;
        this._initialDomNodes = 0;
        this._peakDomNodes = 0;

        // Route transitions log
        this._routeNavigations = [];
        this._maxRouteNavigations = 25;
        this._activeNavigation = null;

        // PerformanceObserver instances
        this._observers = [];

        // Unsubscribe callbacks for eventBus listeners
        this._unsubscribers = [];

        // requestIdleCallback execution tracking
        this._idleCallbacks = {
            supported: false,
            scheduledCount: 0,
            executedCount: 0,
            totalDurationMs: 0,
            maxDurationMs: 0,
            avgDurationMs: 0
        };
        this._origRequestIdleCallback = null;

        // Image decode execution tracking
        this._imageDecodes = {
            supported: false,
            count: 0,
            totalDurationMs: 0,
            maxDurationMs: 0,
            avgDurationMs: 0,
            slowDecodesCount: 0
        };
        this._origImageDecode = null;
    }

    /**
     * Checks if the performance telemetry collector is actively running.
     * @returns {boolean}
     */
    isActive() {
        return this._active;
    }

    /**
     * Starts collecting performance telemetry.
     * Registers observers, binds route listeners, and begins RAF sampling.
     */
    start() {
        if (this._active) return;
        this._active = true;

        // Record session start timestamps
        this._startTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
        this._startDate = new Date().toISOString();
        this._initialRoute = router && typeof router.getCurrentPath === 'function'
            ? router.getCurrentPath()
            : (typeof window !== 'undefined' && window.location ? window.location.hash || '/' : '/');

        // Reset telemetry buffers
        this._totalFrames = 0;
        this._totalDurationMs = 0;
        this._minFps = Infinity;
        this._maxFps = 0;
        this._frameIntervals = [];
        this._jankEvents = [];
        this._longTasks = [];
        this._preStartLongTasks = [];
        this._recentOperations = [];
        this._totalLongTaskTimeMs = 0;
        this._maxLongTaskMs = 0;
        this._routeNavigations = [];

        // Bind lightweight operation marker bridge for task attribution
        setPerfOperationHandler((name) => this.markOperation(name));

        this._distribution = {
            under16ms: 0,
            under25ms: 0,
            under33ms: 0,
            under50ms: 0,
            over50ms: 0
        };

        // Reset video playback state and frame phase telemetry buckets
        this._hasPlayedVideo = false;
        this._prePlaybackFrames = { count: 0, durationMs: 0, under16ms: 0, under25ms: 0, over50ms: 0 };
        this._duringPlaybackFrames = { count: 0, durationMs: 0, under16ms: 0, under25ms: 0, over50ms: 0 };
        this._postPlaybackFrames = { count: 0, durationMs: 0, under16ms: 0, under25ms: 0, over50ms: 0 };

        // Capture initial memory and DOM node baselines
        this._recordInitialBaselines();

        // Register PerformanceObserver instances
        this._setupObservers();

        // Listen for route navigation events
        this._setupRouteListener();

        // --------------------------------------------------------------------
        // 1. requestIdleCallback execution tracking
        // --------------------------------------------------------------------
        this._idleCallbacks = {
            supported: typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function',
            scheduledCount: 0,
            executedCount: 0,
            totalDurationMs: 0,
            maxDurationMs: 0,
            avgDurationMs: 0
        };
        if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
            this._origRequestIdleCallback = window.requestIdleCallback;
            const self = this;
            window.requestIdleCallback = function (cb, options) {
                self._idleCallbacks.scheduledCount++;
                return self._origRequestIdleCallback.call(window, function (deadline) {
                    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
                    try {
                        return cb(deadline);
                    } finally {
                        const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
                        const dur = Math.max(0, t1 - t0);
                        self._idleCallbacks.executedCount++;
                        self._idleCallbacks.totalDurationMs += dur;
                        if (dur > self._idleCallbacks.maxDurationMs) {
                            self._idleCallbacks.maxDurationMs = Math.round(dur * 10) / 10;
                        }
                        self._idleCallbacks.avgDurationMs =
                            Math.round((self._idleCallbacks.totalDurationMs / self._idleCallbacks.executedCount) * 10) / 10;
                    }
                }, options);
            };
        }

        // --------------------------------------------------------------------
        // 2. Image decode duration instrumentation
        // --------------------------------------------------------------------
        this._imageDecodes = {
            supported:
                typeof HTMLImageElement !== 'undefined' &&
                HTMLImageElement.prototype &&
                typeof HTMLImageElement.prototype.decode === 'function',
            count: 0,
            totalDurationMs: 0,
            maxDurationMs: 0,
            avgDurationMs: 0,
            slowDecodesCount: 0
        };
        if (
            typeof HTMLImageElement !== 'undefined' &&
            HTMLImageElement.prototype &&
            typeof HTMLImageElement.prototype.decode === 'function'
        ) {
            this._origImageDecode = HTMLImageElement.prototype.decode;
            const self = this;
            HTMLImageElement.prototype.decode = function () {
                const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
                const promise = self._origImageDecode.call(this);
                if (promise && typeof promise.then === 'function') {
                    return promise.then(
                        (res) => {
                            const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
                            self._recordImageDecode(Math.max(0, t1 - t0));
                            return res;
                        },
                        (err) => {
                            const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
                            self._recordImageDecode(Math.max(0, t1 - t0));
                            throw err;
                        }
                    );
                }
                return promise;
            };
        }

        // Start requestAnimationFrame sampling loop
        this._lastFrameTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
        this._rafId = requestFrame((now) => this._onFrame(now));

        log.info('Performance telemetry collector activated.');
    }

    /**
     * Stops collecting telemetry, disconnects observers, and frees timers.
     */
    stop() {
        if (!this._active) return;
        this._active = false;

        // Stop animation frame monitoring loop
        if (this._rafId) {
            cancelFrame(this._rafId);
            this._rafId = null;
        }

        // Disconnect all performance observers
        for (let i = 0; i < this._observers.length; i++) {
            try {
                this._observers[i].disconnect();
            } catch (_) {}
        }
        this._observers = [];

        // Remove eventBus subscriptions
        for (let i = 0; i < this._unsubscribers.length; i++) {
            try {
                this._unsubscribers[i]();
            } catch (_) {}
        }
        this._unsubscribers = [];

        // Unbind operation marker bridge so normal runtime pays zero overhead
        setPerfOperationHandler(null);

        // Restore intercepted requestIdleCallback if previously active
        if (this._origRequestIdleCallback && typeof window !== 'undefined') {
            window.requestIdleCallback = this._origRequestIdleCallback;
            this._origRequestIdleCallback = null;
        }

        // Restore original HTMLImageElement.prototype.decode implementation
        if (
            this._origImageDecode &&
            typeof HTMLImageElement !== 'undefined' &&
            HTMLImageElement.prototype
        ) {
            HTMLImageElement.prototype.decode = this._origImageDecode;
            this._origImageDecode = null;
        }

        log.info('Performance telemetry collector suspended.');
    }

    /**
     * Records a recent UI/navigation operation timestamp into a bounded 5-entry
     * ring buffer on the same high-resolution performance timeline used by Long Tasks.
     *
     * @param {string} name - Operation label (e.g. 'HeroCarousel.goTo')
     */
    markOperation(name) {
        if (!this._active || !name) return;

        const timestamp =
            typeof performance !== 'undefined' && typeof performance.now === 'function'
                ? performance.now()
                : Date.now();

        this._recentOperations.push({ name, timestamp });
        if (this._recentOperations.length > this._maxRecentOperations) {
            this._recentOperations.shift();
        }
    }

    /**
     * Records image decode execution metrics (HTMLImageElement.prototype.decode).
     * Tracks execution frequency, cumulative duration, and max freeze latency
     * to detect image decoding pressure on low-power TV chipsets.
     *
     * @private
     * @param {number} dur - Image decode duration in milliseconds
     */
    _recordImageDecode(dur) {
        if (!this._active) return;
        const duration = Math.max(0, dur);

        // Increment execution counters and aggregate elapsed milliseconds
        this._imageDecodes.count++;
        this._imageDecodes.totalDurationMs += duration;

        // Track peak single-image decode latency
        if (duration > this._imageDecodes.maxDurationMs) {
            this._imageDecodes.maxDurationMs = Math.round(duration * 10) / 10;
        }

        // Maintain running arithmetic mean
        this._imageDecodes.avgDurationMs =
            Math.round((this._imageDecodes.totalDurationMs / this._imageDecodes.count) * 10) / 10;

        // Flag any decode exceeding one frame budget (50ms) as a slow decode
        if (duration > 50) {
            this._imageDecodes.slowDecodesCount++;
        }
    }

    /**
     * Captures initial memory allocation and live DOM complexity.
     * @private
     */
    _recordInitialBaselines() {
        // Record JS heap memory if provided by browser engine
        if (typeof performance !== 'undefined' && performance.memory) {
            this._initialHeapBytes = performance.memory.usedJSHeapSize || 0;
            this._peakHeapBytes = this._initialHeapBytes;
        }

        // Count initial DOM elements
        if (typeof document !== 'undefined' && typeof document.getElementsByTagName === 'function') {
            this._initialDomNodes = document.getElementsByTagName('*').length || 0;
            this._peakDomNodes = this._initialDomNodes;
        }
    }

    /**
     * Registers modern PerformanceObserver hooks for long tasks and Web Vitals.
     * @private
     */
    _setupObservers() {
        if (typeof PerformanceObserver === 'undefined') return;

        const supported = PerformanceObserver.supportedEntryTypes || [];

        // 1. Long Tasks Observer (> 50ms main-thread blockage)
        if (supported.indexOf('longtask') !== -1) {
            try {
                const longTaskObserver = new PerformanceObserver((entryList) => {
                    const entries = entryList.getEntries();
                    for (let i = 0; i < entries.length; i++) {
                        this._recordLongTask(entries[i]);
                    }
                });
                /*
                 * Chromium requires the `type` dictionary member when observing a
                 * single entry type. The legacy `entryType` key (used previously)
                 * throws "An observe() call must include either entryTypes or type
                 * arguments", which silently disabled long-task telemetry entirely.
                 * `buffered: true` also drains entries recorded before the collector
                 * was lazily loaded. Older engines that only implement the
                 * entryTypes form are covered by the fallback below.
                 */
                try {
                    longTaskObserver.observe({ type: 'longtask', buffered: true });
                } catch (typeErr) {
                    longTaskObserver.observe({ entryTypes: ['longtask'] });
                }
                this._observers.push(longTaskObserver);
            } catch (err) {
                log.debug('Longtask observer initialization skipped:', err);
            }
        }

        // 2. Largest Contentful Paint (LCP)
        if (supported.includes('largest-contentful-paint')) {
            try {
                const lcpObs = new PerformanceObserver((entryList) => {
                    const entries = entryList.getEntries();
                    const lastEntry = entries[entries.length - 1];
                    if (lastEntry) {
                        this._vitals.lcp = Math.round(lastEntry.startTime);
                        if (lastEntry.element) {
                            const tag = lastEntry.element.tagName ? lastEntry.element.tagName.toLowerCase() : 'element';
                            const id = lastEntry.element.id ? `#${lastEntry.element.id}` : '';
                            this._vitals.lcpElement = `${tag}${id}` || tag;
                        }
                    }
                });
                lcpObs.observe({ type: 'largest-contentful-paint', buffered: true });
                this._observers.push(lcpObs);
            } catch (_) {}
        }

        // 3. First Contentful Paint (FCP)
        if (supported.includes('paint')) {
            try {
                const paintObs = new PerformanceObserver((entryList) => {
                    for (const entry of entryList.getEntries()) {
                        if (entry.name === 'first-contentful-paint') {
                            this._vitals.fcp = Math.round(entry.startTime);
                        }
                    }
                });
                paintObs.observe({ type: 'paint', buffered: true });
                this._observers.push(paintObs);
            } catch (_) {}
        }

        // 4. Cumulative Layout Shift (CLS)
        if (supported.includes('layout-shift')) {
            try {
                let cumulativeScore = 0;
                const clsObs = new PerformanceObserver((entryList) => {
                    for (const entry of entryList.getEntries()) {
                        if (!entry.hadRecentInput) {
                            cumulativeScore += entry.value;
                            this._vitals.cls = Number(cumulativeScore.toFixed(3));
                        }
                    }
                });
                clsObs.observe({ type: 'layout-shift', buffered: true });
                this._observers.push(clsObs);
            } catch (_) {}
        }

        // 5. Interaction to Next Paint (INP) / First Input Delay (FID)
        if (supported.includes('first-input')) {
            try {
                const fidObs = new PerformanceObserver((entryList) => {
                    const firstInput = entryList.getEntries()[0];
                    if (firstInput) {
                        this._vitals.fid = Math.round(firstInput.processingStart - firstInput.startTime);
                    }
                });
                fidObs.observe({ type: 'first-input', buffered: true });
                this._observers.push(fidObs);
            } catch (_) {}
        }

        if (supported.includes('event')) {
            try {
                const inpObs = new PerformanceObserver((entryList) => {
                    for (const entry of entryList.getEntries()) {
                        if (entry.duration && entry.duration > (this._vitals.inp || 0)) {
                            this._vitals.inp = Math.round(entry.duration);
                        }
                    }
                });
                inpObs.observe({ type: 'event', buffered: true, durationThreshold: 16 });
                this._observers.push(inpObs);
            } catch (_) {}
        }
    }

    /**
     * Resolves the most recent marked UI operation overlapping `[entry.startTime - 50, entry.startTime + entry.duration]`.
     * When no synchronous overlap matches, falls back to the newest operation within `250ms` prior
     * so deferred callbacks (timer/rAF follow-ups) still carry timing attribution (e.g. `Op (+110ms)`).
     *
     * @param {Object} entry - LongTask performance entry
     * @returns {string} Matched operation label or empty string
     * @private
     */
    _resolveOperationForEntry(entry) {
        if (!this._recentOperations || this._recentOperations.length === 0) return '';

        const windowStart = entry.startTime - 50;
        const windowEnd = entry.startTime + (entry.duration || 0);

        // Pass 1: Direct overlap within [startTime - 50ms, startTime + duration]
        for (let i = this._recentOperations.length - 1; i >= 0; i--) {
            const op = this._recentOperations[i];
            if (op.timestamp >= windowStart && op.timestamp <= windowEnd) {
                return op.name;
            }
        }

        // Pass 2: Deferred callback correlation within 250ms prior to entry.startTime
        for (let i = this._recentOperations.length - 1; i >= 0; i--) {
            const op = this._recentOperations[i];
            const elapsedMs = entry.startTime - op.timestamp;
            if (elapsedMs >= 0 && elapsedMs <= 250) {
                return `${op.name} (+${Math.round(elapsedMs)}ms)`;
            }
        }

        return '';
    }

    /**
     * Stores main-thread long task entries with attribution context, correlating
     * recent JS operations and partitioning buffered pre-start entries.
     * @private
     * @param {PerformanceEntry} entry Long task entry
     */
    _recordLongTask(entry) {
        const duration = Math.round(entry.duration);

        // Extract script attribution if available
        let containerType = 'window';
        let containerName = '';
        let containerSrc = '';

        if (entry.attribution && entry.attribution.length > 0) {
            const attr = entry.attribution[0];
            containerType = attr.containerType || 'window';
            containerName = attr.containerName || '';
            containerSrc = attr.containerSrc || '';
        }

        // Snapshot the active route so freezes can be attributed to a page
        const route =
            router && typeof router.getCurrentPath === 'function'
                ? router.getCurrentPath()
                : typeof window !== 'undefined' && window.location
                  ? window.location.hash || '/'
                  : '/';

        const relativeTimeMs = Math.round(entry.startTime - this._startTime);
        const operation = this._resolveOperationForEntry(entry);

        const taskRecord = {
            timeOffsetMs: relativeTimeMs,
            durationMs: duration,
            route,
            operation,
            containerType,
            containerName,
            containerSrc
        };

        // Partition buffered entries predating collector activation so cold boot
        // script evaluation does not skew active session blocking metrics.
        if (relativeTimeMs < 0) {
            this._preStartLongTasks.push(taskRecord);
            if (this._preStartLongTasks.length > this._maxPreStartLongTasks) {
                this._preStartLongTasks.shift();
            }
            return;
        }

        this._totalLongTaskTimeMs += duration;
        if (duration > this._maxLongTaskMs) {
            this._maxLongTaskMs = duration;
        }

        this._longTasks.push(taskRecord);

        // Keep buffer bounded
        if (this._longTasks.length > this._maxLongTasks) {
            this._longTasks.shift();
        }
    }

    /**
     * Aggregates main-thread long tasks by route and by initiating operation.
     * Computes execution frequencies, total blocking durations, and maximum freeze times
     * for granular bottleneck attribution across view controllers and background queues.
     *
     * @private
     * @param {Array<Object>} tasks - List of captured long task records
     * @returns {{
     *   byRoute: Object.<string, { count: number, totalDurationMs: number, maxDurationMs: number, avgDurationMs: number, operations: Object }>,
     *   byOperation: Object.<string, { count: number, totalDurationMs: number, maxDurationMs: number, avgDurationMs: number, routes: Array<string> }>
     * }}
     */
    _groupLongTasks(tasks) {
        // Plain dictionaries avoid Map/Set prototype overhead on older WebKit cores
        const byRoute = Object.create(null);
        const byOperation = Object.create(null);

        // Guard against null, undefined, or empty long task buffers
        if (!tasks || !tasks.length) {
            return { byRoute, byOperation };
        }

        // Iterate through all captured long tasks
        for (let i = 0; i < tasks.length; i++) {
            const task = tasks[i];
            const routeKey = task.route || '/';

            // Clean operation name by stripping dynamic deferred timing suffixes (+123ms)
            const rawOp = task.operation || '';
            const baseOp = rawOp ? rawOp.replace(/\s*\(\+\d+ms\)$/, '') : '(unattributed)';
            const duration = typeof task.durationMs === 'number' ? task.durationMs : 0;

            // ----------------------------------------------------------------
            // 1. Group tasks by application route
            // ----------------------------------------------------------------
            if (!byRoute[routeKey]) {
                byRoute[routeKey] = {
                    count: 0,
                    totalDurationMs: 0,
                    maxDurationMs: 0,
                    avgDurationMs: 0,
                    operations: Object.create(null)
                };
            }
            const rEntry = byRoute[routeKey];
            rEntry.count++;
            rEntry.totalDurationMs += duration;
            if (duration > rEntry.maxDurationMs) {
                rEntry.maxDurationMs = duration;
            }
            rEntry.avgDurationMs = Math.round((rEntry.totalDurationMs / rEntry.count) * 10) / 10;

            // Sub-aggregate operations within each individual route
            if (!rEntry.operations[baseOp]) {
                rEntry.operations[baseOp] = {
                    count: 0,
                    totalDurationMs: 0,
                    maxDurationMs: 0
                };
            }
            const ropEntry = rEntry.operations[baseOp];
            ropEntry.count++;
            ropEntry.totalDurationMs += duration;
            if (duration > ropEntry.maxDurationMs) {
                ropEntry.maxDurationMs = duration;
            }

            // ----------------------------------------------------------------
            // 2. Group tasks globally by originating operation
            // ----------------------------------------------------------------
            if (!byOperation[baseOp]) {
                byOperation[baseOp] = {
                    count: 0,
                    totalDurationMs: 0,
                    maxDurationMs: 0,
                    avgDurationMs: 0,
                    routes: []
                };
            }
            const opEntry = byOperation[baseOp];
            opEntry.count++;
            opEntry.totalDurationMs += duration;
            if (duration > opEntry.maxDurationMs) {
                opEntry.maxDurationMs = duration;
            }
            opEntry.avgDurationMs = Math.round((opEntry.totalDurationMs / opEntry.count) * 10) / 10;

            // Associate unique routes where this operation caused blocking
            if (opEntry.routes.indexOf(routeKey) === -1) {
                opEntry.routes.push(routeKey);
            }
        }

        return { byRoute, byOperation };
    }

    /**
     * Subscribes to router navigation events to measure page transition durations.
     * Records route source/destination pairs and correlates frame drops during navigation.
     * @private
     */
    _setupRouteListener() {
        // Track the current active route path so source navigation can be attributed
        this._currentRoute = router && typeof router.getCurrentPath === 'function'
            ? router.getCurrentPath()
            : '/';

        const onNavigate = ({ path }) => {
            const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
            // Resolve source from previously tracked route
            const from = this._currentRoute || '/';
            const to = path || 'unknown';
            // Update current route tracker to destination path
            this._currentRoute = to;
            const relativeOffsetMs = Math.round(now - this._startTime);

            // Conclude preceding in-flight transition measurement immediately if still pending
            if (this._activeNavigation && this._activeNavigation.entry) {
                const elapsedPrior = Math.round(now - this._activeNavigation.startTime);
                this._activeNavigation.entry.durationMs = elapsedPrior;
                this._activeNavigation = null;
            }

            /*
             * Transition boundary: entering or exiting the player route indicates
             * that video playback has occurred, distinguishing subsequent UI ticks
             * as post-playback frames.
             */
            if (
                to.startsWith('/player') ||
                to.startsWith('#/player') ||
                from.startsWith('/player') ||
                from.startsWith('#/player')
            ) {
                this._hasPlayedVideo = true;
            }

            const navEntry = {
                timestampMs: relativeOffsetMs,
                from,
                to,
                durationMs: 0,
                jankCount: 0
            };

            this._routeNavigations.push(navEntry);
            if (this._routeNavigations.length > this._maxRouteNavigations) {
                this._routeNavigations.shift();
            }

            this._activeNavigation = {
                entry: navEntry,
                startTime: now,
                startFrames: this._totalFrames
            };

            // Conclude transition measurement after settling window
            setTimeout(() => {
                if (this._activeNavigation && this._activeNavigation.entry === navEntry) {
                    const elapsed = Math.round(performance.now() - this._activeNavigation.startTime);
                    navEntry.durationMs = elapsed;
                    this._activeNavigation = null;
                }
            }, 500);
        };

        eventBus.on('router:navigate', onNavigate);
        this._unsubscribers.push(() => eventBus.off('router:navigate', onNavigate));

        /*
         * Listen for playback termination events from the core playback subsystem.
         * Catches both 'player:stop' and 'player:stopped' signals to mark that video
         * playback has taken place even if navigation was triggered out-of-band.
         */
        const onPlaybackStop = () => {
            this._hasPlayedVideo = true;
        };

        eventBus.on('player:stop', onPlaybackStop);
        eventBus.on('player:stopped', onPlaybackStop);
        this._unsubscribers.push(() => {
            eventBus.off('player:stop', onPlaybackStop);
            eventBus.off('player:stopped', onPlaybackStop);
        });
    }

    /**
     * Continuous animation frame tick measuring frame durations and dropped frames.
     * @private
     * @param {number} now Timestamp
     */
    _onFrame(now) {
        if (!this._active) return;

        // Schedule subsequent tick
        this._rafId = requestFrame((timestamp) => this._onFrame(timestamp));

        const delta = now - this._lastFrameTime;
        this._lastFrameTime = now;

        // Discard dormant background intervals
        if (delta > 0 && delta < 500) {
            this._totalFrames++;
            this._totalDurationMs += delta;

            const instantFps = Math.round(1000 / delta);

            // Ignore early transient boot ticks when updating min/max bounds
            if (this._totalFrames > 10) {
                if (instantFps > this._maxFps) this._maxFps = Math.min(360, instantFps);
                if (instantFps < this._minFps) this._minFps = Math.max(1, instantFps);
            }

            // Categorize into distribution histogram
            if (delta <= 16.7) {
                this._distribution.under16ms++;
            } else if (delta <= 25.0) {
                this._distribution.under25ms++;
            } else if (delta <= 33.3) {
                this._distribution.under33ms++;
            } else if (delta <= 50.0) {
                this._distribution.under50ms++;
            } else {
                this._distribution.over50ms++;
            }

            /*
             * Snapshot the active route path to segregate UI rendering telemetry
             * based on playback lifecycle state (pre-playback vs during vs post).
             */
            const currentRoute =
                router && typeof router.getCurrentPath === 'function'
                    ? router.getCurrentPath()
                    : typeof window !== 'undefined' && window.location
                      ? window.location.hash || '/'
                      : '/';

            // Mark playback occurrence if currently within player route
            const isPlayer = currentRoute.startsWith('/player') || currentRoute.startsWith('#/player');
            if (isPlayer) {
                this._hasPlayedVideo = true;
            }

            // Route frame sample to the active lifecycle bucket
            let phaseBucket;
            if (isPlayer) {
                phaseBucket = this._duringPlaybackFrames;
            } else if (!this._hasPlayedVideo) {
                phaseBucket = this._prePlaybackFrames;
            } else {
                phaseBucket = this._postPlaybackFrames;
            }

            // Accumulate duration and framerate brackets for the active phase
            phaseBucket.count++;
            phaseBucket.durationMs += delta;
            if (delta <= 16.7) {
                phaseBucket.under16ms++;
            } else if (delta <= 25.0) {
                phaseBucket.under25ms++;
            } else if (delta > 50.0) {
                phaseBucket.over50ms++;
            }

            // Record dropped frame / stutter (> 26ms represents drop below ~38 FPS)
            if (delta > 26) {
                const relativeOffsetMs = Math.round(now - this._startTime);

                this._jankEvents.push({
                    offsetMs: relativeOffsetMs,
                    frameTimeMs: Math.round(delta * 10) / 10,
                    fps: Math.round(1000 / delta),
                    route: currentRoute
                });

                if (this._jankEvents.length > this._maxJankEvents) {
                    this._jankEvents.shift();
                }

                if (this._activeNavigation && this._activeNavigation.entry) {
                    this._activeNavigation.entry.jankCount++;
                }
            }

            // Reservoir sampling of frame times for statistical percentiles
            if (this._frameIntervals.length < this._maxIntervalSamples) {
                this._frameIntervals.push(delta);
            } else {
                const replaceIdx = Math.floor(Math.random() * this._totalFrames);
                if (replaceIdx < this._maxIntervalSamples) {
                    this._frameIntervals[replaceIdx] = delta;
                }
            }

            // Sample peak memory and DOM complexity periodically (~every 120 frames / 2s)
            if (this._totalFrames % 120 === 0) {
                this._updatePeakMetrics();
            }
        }
    }

    /**
     * Checks and updates peak JS heap allocations and live DOM elements.
     * @private
     */
    _updatePeakMetrics() {
        if (typeof performance !== 'undefined' && performance.memory) {
            const used = performance.memory.usedJSHeapSize || 0;
            if (used > (this._peakHeapBytes || 0)) {
                this._peakHeapBytes = used;
            }
        }

        if (typeof document !== 'undefined' && typeof document.getElementsByTagName === 'function') {
            const count = document.getElementsByTagName('*').length || 0;
            if (count > this._peakDomNodes) {
                this._peakDomNodes = count;
            }
        }
    }

    /**
     * Calculates 1% low and 0.1% low percentile framerates from sampled intervals.
     * @private
     * @returns {{ onePercentLow: number, pointOnePercentLow: number }}
     */
    _calculatePercentiles() {
        if (this._frameIntervals.length === 0) {
            return { onePercentLow: 60, pointOnePercentLow: 60 };
        }

        // Sort descending by frame duration (slowest first)
        const sorted = [...this._frameIntervals].sort((a, b) => b - a);

        // Calculate 1% slowest index
        const onePercentIdx = Math.max(0, Math.floor(sorted.length * 0.01));
        const onePercentMs = sorted[onePercentIdx] || 16.6;
        const onePercentLow = Math.max(1, Math.round(1000 / onePercentMs));

        // Calculate 0.1% slowest index
        const pointOneIdx = Math.max(0, Math.floor(sorted.length * 0.001));
        const pointOneMs = sorted[pointOneIdx] || onePercentMs;
        const pointOnePercentLow = Math.max(1, Math.round(1000 / pointOneMs));

        return { onePercentLow, pointOnePercentLow };
    }

    /**
     * Extracts slowest API and resource requests from Resource Timing API.
     * @private
     * @returns {{ slowApis: Array, slowImages: Array }}
     */
    _collectResourceTimings() {
        const slowApis = [];
        const slowImages = [];

        try {
            if (typeof performance === 'undefined' || typeof performance.getEntriesByType !== 'function') {
                return { slowApis, slowImages };
            }

            const resources = performance.getEntriesByType('resource') || [];
            const imageRegex = /\.(png|jpg|jpeg|webp|gif|svg)(\?.*)?$/i;

            for (let i = 0; i < resources.length; i++) {
                const r = resources[i];
                const duration = Math.round(r.duration);
                const name = r.name || '';

                if (name.includes('/Items/') || name.includes('/Users/') || name.includes('/System/')) {
                    if (imageRegex.test(name) || name.includes('/Images/')) {
                        slowImages.push({ name: name.split('?')[0], durationMs: duration });
                    } else {
                        slowApis.push({ name: name.split('?')[0], durationMs: duration });
                    }
                }
            }

            // Sort slowest first and retain top entries
            slowApis.sort((a, b) => b.durationMs - a.durationMs);
            slowImages.sort((a, b) => b.durationMs - a.durationMs);
        } catch (_) {}

        return {
            slowApis: slowApis.slice(0, 10),
            slowImages: slowImages.slice(0, 10)
        };
    }

    /**
     * Constructs a comprehensive formatted performance audit report.
     * Returns both human-readable ASCII layout and complete structured JSON payload.
     * @returns {{ text: string, json: Object }}
     */
    buildReport() {
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        const sessionDurationSec = Math.max(0.1, Math.round((now - this._startTime) / 100) / 10);
        const avgFps = this._totalDurationMs > 0
            ? Math.round((this._totalFrames / this._totalDurationMs) * 1000)
            : 60;

        const { onePercentLow, pointOnePercentLow } = this._calculatePercentiles();
        const { slowApis, slowImages } = this._collectResourceTimings();

        // Target platform string
        const platformStr = platformInfo.isTizen ? 'Samsung Tizen TV' :
            platformInfo.isWebOS ? 'LG webOS TV' :
            platformInfo.isAndroid ? (platformInfo.isAndroidTv ? 'Android TV' : 'Android Mobile') :
            platformInfo.isDesktop ? 'Tauri Desktop' : 'Web Browser';

        // Memory calculations
        const bytesToMb = (bytes) => bytes ? (bytes / (1024 * 1024)).toFixed(1) : 'N/A';
        const curHeap = (typeof performance !== 'undefined' && performance.memory)
            ? performance.memory.usedJSHeapSize
            : null;
        const totalHeap = (typeof performance !== 'undefined' && performance.memory)
            ? performance.memory.totalJSHeapSize
            : null;
        const totalHeapLimit = (typeof performance !== 'undefined' && performance.memory)
            ? performance.memory.jsHeapSizeLimit
            : null;
        const heapUtilPct = (curHeap && totalHeapLimit && totalHeapLimit > 0)
            ? `${((curHeap / totalHeapLimit) * 100).toFixed(1)}%`
            : 'N/A';

        // Current live DOM nodes
        const currentDomNodes = (typeof document !== 'undefined' && typeof document.getElementsByTagName === 'function')
            ? document.getElementsByTagName('*').length
            : 0;

        // Active CSS Zoom and display scale
        const currentZoom = (typeof document !== 'undefined' && document.documentElement)
            ? parseFloat(document.documentElement.style.zoom) || 1.0
            : 1.0;
        const displayScalePref = storage.getItem('pref:displayScale') || 'auto';

        // Group captured long tasks by route and by initiating operation
        const groupedTasks = this._groupLongTasks(this._longTasks);

        // Compute elapsed time since the user last pressed a remote key or mouse/touch input
        const lastInteractionTime = idleGate && typeof idleGate.getLastActivityTime === 'function'
            ? idleGate.getLastActivityTime()
            : Date.now();
        const timeSinceInteractionMs = Math.max(0, Date.now() - lastInteractionTime);
        const timeSinceInteractionSec = Math.round(timeSinceInteractionMs / 100) / 10;

        // Gather image cache telemetry (pre-warm count, hits, misses, hit ratio)
        const cacheStats = imageCache && typeof imageCache.getStats === 'function'
            ? imageCache.getStats()
            : {
                pendingRequests: 0,
                activeRequests: 0,
                queuedRequests: 0,
                hits: 0,
                misses: 0,
                hitRatio: 0,
                hitPercentage: 'N/A',
                warmedCount: 0
            };

        // Query LazyLoader queue and active image fetch/decode trackers
        const lazyPending = lazyLoader && typeof lazyLoader.getPendingCount === 'function'
            ? lazyLoader.getPendingCount()
            : 0;
        const totalPendingImageRequests = (cacheStats.pendingRequests || 0) + lazyPending;

        // Query pending background tasks parked in IdleGate
        const pendingIdleGateTasks = idleGate && typeof idleGate.getPendingTaskCount === 'function'
            ? idleGate.getPendingTaskCount()
            : 0;
        const totalBackgroundTasks = pendingIdleGateTasks + (cacheStats.pendingRequests || 0);

        // Structured JSON telemetry dictionary
        const reportJson = {
            metadata: {
                reportId: `perf-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                generatedAt: new Date().toISOString(),
                sessionStartDate: this._startDate,
                sessionDurationSeconds: sessionDurationSec,
                appVersion: resolveAppVersion()
            },
            environment: {
                platformTarget: platformStr,
                userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'Unknown',
                screenResolution: typeof window !== 'undefined' && window.screen
                    ? `${window.screen.width}x${window.screen.height}`
                    : 'Unknown',
                viewportResolution: typeof window !== 'undefined'
                    ? `${window.innerWidth}x${window.innerHeight}`
                    : 'Unknown',
                devicePixelRatio: typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1,
                rootCssZoom: currentZoom,
                displayScalePreference: displayScalePref,
                cpuCores: typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency || 'N/A') : 'N/A',
                deviceMemoryGb: typeof navigator !== 'undefined' ? (navigator.deviceMemory || 'N/A') : 'N/A',
                activeSettings: {
                    // Check canonical litefin settings and legacy preference keys
                    lowVram: storage.getItem('litefin:lowVramMode') === 'true' || storage.getItem('pref:lowVram') === 'true',
                    disableCardScaling: storage.getItem('litefin:disableCardScaling') === 'true' || storage.getItem('pref:disableCardScaling') === 'true',
                    disableBlurhash: storage.getItem('litefin:disableBlurhash') === 'true' || storage.getItem('pref:disableBlurhash') === 'true',
                    loaderStyle: storage.getItem('litefin:loaderStyle') || storage.getItem('pref:loaderStyle') || 'ring',
                    mediaRowsLayout: storage.getItem('pref:mediaRowsLayout') || 'modern'
                }
            },
            framerates: {
                totalFrames: this._totalFrames,
                averageFps: avgFps,
                minFps: this._minFps === Infinity ? avgFps : this._minFps,
                maxFps: this._maxFps,
                onePercentLowFps: onePercentLow,
                pointOnePercentLowFps: pointOnePercentLow,
                jankStuttersCount: this._jankEvents.length,
                distribution: this._distribution,
                recentJankSpikes: this._jankEvents,
                prePlayback: {
                    totalFrames: this._prePlaybackFrames.count,
                    averageFps: this._prePlaybackFrames.durationMs > 0
                        ? Math.round((this._prePlaybackFrames.count / this._prePlaybackFrames.durationMs) * 1000)
                        : 0,
                    under16ms: this._prePlaybackFrames.under16ms,
                    under25ms: this._prePlaybackFrames.under25ms,
                    over50ms: this._prePlaybackFrames.over50ms
                },
                duringPlayback: {
                    totalFrames: this._duringPlaybackFrames.count,
                    averageFps: this._duringPlaybackFrames.durationMs > 0
                        ? Math.round((this._duringPlaybackFrames.count / this._duringPlaybackFrames.durationMs) * 1000)
                        : 0,
                    under16ms: this._duringPlaybackFrames.under16ms,
                    under25ms: this._duringPlaybackFrames.under25ms,
                    over50ms: this._duringPlaybackFrames.over50ms
                },
                postPlayback: {
                    totalFrames: this._postPlaybackFrames.count,
                    averageFps: this._postPlaybackFrames.durationMs > 0
                        ? Math.round((this._postPlaybackFrames.count / this._postPlaybackFrames.durationMs) * 1000)
                        : 0,
                    under16ms: this._postPlaybackFrames.under16ms,
                    under25ms: this._postPlaybackFrames.under25ms,
                    over50ms: this._postPlaybackFrames.over50ms
                }
            },
            longTasks: {
                totalDetected: this._longTasks.length,
                totalBlockingTimeMs: this._totalLongTaskTimeMs,
                longestTaskMs: this._maxLongTaskMs,
                groupedByRoute: groupedTasks.byRoute,
                groupedByOperation: groupedTasks.byOperation,
                entries: this._longTasks
            },
            preStartLongTasks: {
                totalDetected: this._preStartLongTasks.length,
                entries: this._preStartLongTasks
            },
            webVitals: this._vitals,
            memoryAndDom: {
                initialHeapMb: bytesToMb(this._initialHeapBytes),
                peakHeapMb: bytesToMb(this._peakHeapBytes),
                currentHeapMb: bytesToMb(curHeap),
                totalHeapMb: bytesToMb(totalHeap),
                heapLimitMb: bytesToMb(totalHeapLimit),
                heapUtilizationPct: heapUtilPct,
                raw: (typeof performance !== 'undefined' && performance.memory) ? {
                    usedJSHeapSize: curHeap,
                    totalJSHeapSize: totalHeap,
                    jsHeapSizeLimit: totalHeapLimit
                } : null,
                initialDomNodes: this._initialDomNodes,
                peakDomNodes: this._peakDomNodes,
                currentDomNodes
            },
            memory: (typeof performance !== 'undefined' && performance.memory) ? {
                usedJSHeapSize: curHeap,
                totalJSHeapSize: totalHeap,
                jsHeapSizeLimit: totalHeapLimit,
                usedMb: bytesToMb(curHeap),
                totalMb: bytesToMb(totalHeap),
                limitMb: bytesToMb(totalHeapLimit),
                utilizationPct: heapUtilPct
            } : null,
            runtimeMetrics: {
                idleCallbacks: {
                    supported: this._idleCallbacks.supported,
                    scheduledCount: this._idleCallbacks.scheduledCount,
                    executedCount: this._idleCallbacks.executedCount,
                    totalDurationMs: Math.round(this._idleCallbacks.totalDurationMs * 10) / 10,
                    maxDurationMs: this._idleCallbacks.maxDurationMs,
                    avgDurationMs: this._idleCallbacks.avgDurationMs
                },
                imageDecodes: {
                    supported: this._imageDecodes.supported,
                    count: this._imageDecodes.count,
                    totalDurationMs: Math.round(this._imageDecodes.totalDurationMs * 10) / 10,
                    maxDurationMs: this._imageDecodes.maxDurationMs,
                    avgDurationMs: this._imageDecodes.avgDurationMs,
                    slowDecodesCount: this._imageDecodes.slowDecodesCount
                },
                imageRequests: {
                    totalPending: totalPendingImageRequests,
                    activePreloadRequests: cacheStats.activeRequests,
                    queuedPreloadRequests: cacheStats.queuedRequests,
                    lazyLoaderPending: lazyPending
                },
                imageCache: {
                    hits: cacheStats.hits,
                    misses: cacheStats.misses,
                    hitRatio: cacheStats.hitRatio,
                    hitPercentage: cacheStats.hitPercentage,
                    warmedCount: cacheStats.warmedCount
                },
                backgroundTasks: {
                    idleGatePendingCount: pendingIdleGateTasks,
                    imageCachePendingCount: cacheStats.pendingRequests || 0,
                    totalPendingBackgroundTasks: totalBackgroundTasks
                },
                userActivity: {
                    lastInteractionTimestamp: lastInteractionTime,
                    timeSinceLastInteractionMs: timeSinceInteractionMs,
                    timeSinceLastInteractionSec: timeSinceInteractionSec
                }
            },
            routeNavigations: this._routeNavigations,
            networkBottlenecks: {
                slowApis,
                slowImages
            }
        };

        // Format human-readable ASCII layout
        const textReport = this._formatAsciiReport(reportJson);

        return {
            text: textReport,
            json: reportJson
        };
    }

    /**
     * Formats structured report into clean human-readable text document.
     * @private
     * @param {Object} data Report JSON data
     * @returns {string} Formatted report string
     */
    _formatAsciiReport(data) {
        const m = data.metadata;
        const e = data.environment;
        const f = data.framerates;
        const l = data.longTasks;
        const v = data.webVitals;
        const mem = data.memoryAndDom;

        const totalDist = Math.max(1, f.totalFrames);
        const pct = (count) => ((count / totalDist) * 100).toFixed(1);

        // Extract playback phase breakdowns with safe zero-division fallbacks
        const pre = f.prePlayback || { totalFrames: 0, averageFps: 0, under16ms: 0, under25ms: 0, over50ms: 0 };
        const during = f.duringPlayback || { totalFrames: 0, averageFps: 0, under16ms: 0, under25ms: 0, over50ms: 0 };
        const post = f.postPlayback || { totalFrames: 0, averageFps: 0, under16ms: 0, under25ms: 0, over50ms: 0 };
        const phasePct = (count, total) => (total > 0 ? ((count / total) * 100).toFixed(1) : '0.0');

        const lines = [
            '================================================================================',
            'LITEFIN PERFORMANCE DIAGNOSTIC AUDIT REPORT',
            '================================================================================',
            `Report ID:          ${m.reportId}`,
            `Generated At:       ${m.generatedAt}`,
            `Session Duration:   ${m.sessionDurationSeconds}s (${(m.sessionDurationSeconds / 60).toFixed(1)} minutes)`,
            `Litefin App Version:${m.appVersion}`,
            `Platform Target:    ${e.platformTarget}`,
            `User Agent:         ${e.userAgent}`,
            '',
            '--------------------------------------------------------------------------------',
            '1. HARDWARE, DISPLAY & ENVIRONMENT',
            '--------------------------------------------------------------------------------',
            `Screen Resolution:          ${e.screenResolution}`,
            `Viewport Resolution:        ${e.viewportResolution} (DPR: ${e.devicePixelRatio})`,
            `Display Scale Mode:         ${e.displayScalePreference} (Active Zoom: ${e.rootCssZoom.toFixed(2)}x)`,
            `CPU Cores (Logical):        ${e.cpuCores}`,
            `Device RAM (Est):           ${e.deviceMemoryGb !== 'N/A' ? `${e.deviceMemoryGb} GB` : 'N/A'}`,
            `Time Since Last User Input: ${data.runtimeMetrics && data.runtimeMetrics.userActivity ? `${data.runtimeMetrics.userActivity.timeSinceLastInteractionSec}s` : 'N/A'}`,
            `Active UI Settings:`,
            `  • Low VRAM Mode:         ${e.activeSettings.lowVram ? 'Enabled' : 'Disabled'}`,
            `  • Disable Card Scaling:  ${e.activeSettings.disableCardScaling ? 'Enabled' : 'Disabled'}`,
            `  • Disable Blurhash:      ${e.activeSettings.disableBlurhash ? 'Enabled' : 'Disabled'}`,
            `  • Loader Animation:      ${e.activeSettings.loaderStyle || 'ring'}`,
            `  • Media Rows Layout:     ${e.activeSettings.mediaRowsLayout || 'modern'}`,
            '',
            '--------------------------------------------------------------------------------',
            '2. CORE WEB VITALS & LOAD TIMING',
            '--------------------------------------------------------------------------------',
            `Largest Contentful Paint (LCP): ${v.lcp !== null ? `${v.lcp} ms` : 'Waiting'} [Target: < 2500ms]`,
            `  Candidate Element:            ${v.lcpElement || 'N/A'}`,
            `First Contentful Paint (FCP):   ${v.fcp !== null ? `${v.fcp} ms` : 'Waiting'} [Target: < 1800ms]`,
            `Cumulative Layout Shift (CLS):  ${v.cls.toFixed(3)} [Target: < 0.100]`,
            `Interaction Latency (INP/FID):  ${v.inp !== null ? `${v.inp} ms` : (v.fid !== null ? `${v.fid} ms` : 'N/A')} [Target: < 200ms]`,
            `Time to First Byte (TTFB):      ${v.ttfb !== null ? `${v.ttfb} ms` : 'N/A'} [Target: < 800ms]`,
            '',
            '--------------------------------------------------------------------------------',
            '3. FRAMERATE & REFRESH PACING TELEMETRY',
            '--------------------------------------------------------------------------------',
            `Total Sampled Frames:        ${f.totalFrames.toLocaleString()}`,
            `Average Framerate:           ${f.averageFps} FPS`,
            `1% Low Framerate:            ${f.onePercentLowFps} FPS`,
            `0.1% Low Framerate (Worst):  ${f.pointOnePercentLowFps} FPS`,
            `Minimum Instant FPS:         ${f.minFps} FPS`,
            `Maximum Instant FPS:         ${f.maxFps} FPS`,
            `Dropped Frame Stutters:      ${f.jankStuttersCount} events`,
            '',
            'Frame Time Distribution:',
            `  • < 16.7ms (>= 60 FPS):      ${f.distribution.under16ms.toLocaleString().padStart(6)} (${pct(f.distribution.under16ms)}%)`,
            `  • 16.7ms - 25.0ms (40-60):   ${f.distribution.under25ms.toLocaleString().padStart(6)} (${pct(f.distribution.under25ms)}%)`,
            `  • 25.0ms - 33.3ms (30-40):   ${f.distribution.under33ms.toLocaleString().padStart(6)} (${pct(f.distribution.under33ms)}%)`,
            `  • 33.3ms - 50.0ms (20-30):   ${f.distribution.under50ms.toLocaleString().padStart(6)} (${pct(f.distribution.under50ms)}%)`,
            `  • > 50.0ms (< 20 FPS):       ${f.distribution.over50ms.toLocaleString().padStart(6)} (${pct(f.distribution.over50ms)}%) [Severe Stutter]`,
            '',
            'Playback Phase Breakdown:',
            `  • Pre-Playback UI Frames:    ${pre.totalFrames.toLocaleString()} frames | ${pre.averageFps} FPS | <16.7ms: ${phasePct(pre.under16ms, pre.totalFrames)}% | 16.7-25ms: ${phasePct(pre.under25ms, pre.totalFrames)}% | >50ms: ${phasePct(pre.over50ms, pre.totalFrames)}%`,
            `  • During Playback Frames:    ${during.totalFrames.toLocaleString()} frames | ${during.averageFps} FPS | <16.7ms: ${phasePct(during.under16ms, during.totalFrames)}% | 16.7-25ms: ${phasePct(during.under25ms, during.totalFrames)}% | >50ms: ${phasePct(during.over50ms, during.totalFrames)}%`,
            `  • Post-Playback UI Frames:   ${post.totalFrames.toLocaleString()} frames | ${post.averageFps} FPS | <16.7ms: ${phasePct(post.under16ms, post.totalFrames)}% | 16.7-25ms: ${phasePct(post.under25ms, post.totalFrames)}% | >50ms: ${phasePct(post.over50ms, post.totalFrames)}%`,
            '',
            '--------------------------------------------------------------------------------',
            '4. MAIN THREAD LONG TASKS (> 50ms)',
            '--------------------------------------------------------------------------------',
            `Total Long Tasks Detected:   ${l.totalDetected}`,
            `Total Blocking Duration:     ${l.totalBlockingTimeMs} ms`,
            `Longest Main-Thread Freeze:  ${l.longestTaskMs} ms`,
            `Pre-Start Tasks (Excluded):  ${data.preStartLongTasks ? data.preStartLongTasks.totalDetected : 0}`,
            ''
        ];

        // Format recent long tasks with route, operation attribution, and container
        if (l.entries.length > 0) {
            lines.push('Captured Long Tasks Log:');
            l.entries.slice(-30).forEach((task, idx) => {
                const sec = (task.timeOffsetMs / 1000).toFixed(1);
                const src = task.containerSrc ? ` (${task.containerSrc})` : '';
                const op = task.operation ? ` | Op: ${task.operation}` : '';
                lines.push(
                    `  ${idx + 1}. [+${sec}s] ${task.durationMs}ms freeze | Route: ${task.route || '/'}${op} | Container: ${task.containerType} ${task.containerName || ''}${src}`
                );
            });
            lines.push('');
        }

        // Format grouped long tasks by route
        if (l.groupedByRoute && Object.keys(l.groupedByRoute).length > 0) {
            lines.push('Long Tasks Grouped by Route:');
            const routeKeys = Object.keys(l.groupedByRoute);
            for (let i = 0; i < routeKeys.length; i++) {
                const rKey = routeKeys[i];
                const rData = l.groupedByRoute[rKey];
                lines.push(
                    `  • ${rKey}: ${rData.count} tasks | Total: ${rData.totalDurationMs}ms | Max: ${rData.maxDurationMs}ms | Avg: ${rData.avgDurationMs}ms`
                );
                // Sub-breakdown of individual operations within this specific route
                if (rData.operations) {
                    const rOpKeys = Object.keys(rData.operations);
                    for (let j = 0; j < rOpKeys.length; j++) {
                        const rOp = rOpKeys[j];
                        const oData = rData.operations[rOp];
                        lines.push(
                            `      - ${rOp}: ${oData.count}x (${oData.totalDurationMs}ms total, max ${oData.maxDurationMs}ms)`
                        );
                    }
                }
            }
            lines.push('');
        }

        // Format grouped long tasks by initiating operation
        if (l.groupedByOperation && Object.keys(l.groupedByOperation).length > 0) {
            lines.push('Long Tasks Grouped by Operation:');
            const opKeys = Object.keys(l.groupedByOperation);
            for (let i = 0; i < opKeys.length; i++) {
                const opKey = opKeys[i];
                const opData = l.groupedByOperation[opKey];
                const routesSummary = opData.routes && opData.routes.length > 0 ? ` [${opData.routes.join(', ')}]` : '';
                lines.push(
                    `  • ${opKey}: ${opData.count} tasks | Total: ${opData.totalDurationMs}ms | Max: ${opData.maxDurationMs}ms | Avg: ${opData.avgDurationMs}ms${routesSummary}`
                );
            }
            lines.push('');
        }

        // Format Memory and DOM complexity
        lines.push(
            '--------------------------------------------------------------------------------',
            '5. MEMORY CONSUMPTION & DOM COMPLEXITY',
            '--------------------------------------------------------------------------------',
            `Initial JS Heap Allocated:   ${mem.initialHeapMb} MB`,
            `Peak JS Heap Allocated:      ${mem.peakHeapMb} MB`,
            `Current JS Heap Allocated:   ${mem.currentHeapMb} MB`,
            `Total JS Heap Allocated:     ${mem.totalHeapMb || 'N/A'} MB`,
            `JS Heap Utilization:         ${mem.heapUtilizationPct || 'N/A'} (Limit: ${mem.heapLimitMb} MB)`,
            `Initial Live DOM Nodes:      ${mem.initialDomNodes}`,
            `Peak Live DOM Nodes:         ${mem.peakDomNodes}`,
            `Current Live DOM Nodes:      ${mem.currentDomNodes}`,
            ''
        );

        // Format Route Navigations
        if (data.routeNavigations.length > 0) {
            lines.push(
                '--------------------------------------------------------------------------------',
                '6. ROUTE TRANSITIONS & NAVIGATION DELAYS',
                '--------------------------------------------------------------------------------'
            );
            data.routeNavigations.forEach((nav, idx) => {
                lines.push(`  ${idx + 1}. ${nav.from} -> ${nav.to} (${nav.durationMs}ms duration, ${nav.jankCount} dropped frames)`);
            });
            lines.push('');
        }

        // Format Slow Resources
        const slow = data.networkBottlenecks;
        if (slow.slowApis.length > 0 || slow.slowImages.length > 0) {
            lines.push(
                '--------------------------------------------------------------------------------',
                '7. NETWORK BOTTLENECKS & RESOURCE LATENCY',
                '--------------------------------------------------------------------------------'
            );
            if (slow.slowApis.length > 0) {
                lines.push('Slowest API Endpoints:');
                slow.slowApis.slice(0, 5).forEach((req, idx) => {
                    lines.push(`  ${idx + 1}. [${req.durationMs}ms] ${req.name}`);
                });
            }
            if (slow.slowImages.length > 0) {
                lines.push('Slowest Image Requests:');
                slow.slowImages.slice(0, 5).forEach((img, idx) => {
                    lines.push(`  ${idx + 1}. [${img.durationMs}ms] ${img.name}`);
                });
            }
            lines.push('');
        }

        // Format Section 8: Runtime background work, images, and idle state
        const rt = data.runtimeMetrics;
        if (rt) {
            lines.push(
                '--------------------------------------------------------------------------------',
                '8. RUNTIME BACKGROUND WORK, IMAGES & IDLE STATE',
                '--------------------------------------------------------------------------------'
            );

            // Print requestIdleCallback execution counters and aggregated timing
            if (rt.idleCallbacks) {
                lines.push(
                    'requestIdleCallback Telemetry:',
                    `  • Supported:                 ${rt.idleCallbacks.supported ? 'Yes' : 'No'}`,
                    `  • Scheduled / Executed:      ${rt.idleCallbacks.scheduledCount} / ${rt.idleCallbacks.executedCount}`,
                    `  • Total Duration:            ${rt.idleCallbacks.totalDurationMs} ms (Max: ${rt.idleCallbacks.maxDurationMs} ms, Avg: ${rt.idleCallbacks.avgDurationMs} ms)`,
                    ''
                );
            }

            // Print asynchronous image decode performance measurements
            if (rt.imageDecodes) {
                lines.push(
                    'Image Decode Telemetry (HTMLImageElement.decode):',
                    `  • Supported:                 ${rt.imageDecodes.supported ? 'Yes' : 'No'}`,
                    `  • Executed Decodes:          ${rt.imageDecodes.count} (${rt.imageDecodes.slowDecodesCount} slow > 50ms)`,
                    `  • Total Duration:            ${rt.imageDecodes.totalDurationMs} ms (Max: ${rt.imageDecodes.maxDurationMs} ms, Avg: ${rt.imageDecodes.avgDurationMs} ms)`,
                    ''
                );
            }

            // Print in-flight and deferred image pipeline requests
            if (rt.imageRequests) {
                lines.push(
                    'Image Pipeline & Pending Requests:',
                    `  • Total Pending Requests:    ${rt.imageRequests.totalPending}`,
                    `  • Active Preload Requests:   ${rt.imageRequests.activePreloadRequests}`,
                    `  • Queued Preload Requests:   ${rt.imageRequests.queuedPreloadRequests}`,
                    `  • LazyLoader In-Flight:      ${rt.imageRequests.lazyLoaderPending}`,
                    ''
                );
            }

            // Print pre-warmed image cache utilization and hit/miss ratios
            if (rt.imageCache) {
                lines.push(
                    'Image Cache Hit / Miss Performance:',
                    `  • Pre-warmed URLs in Memory: ${rt.imageCache.warmedCount}`,
                    `  • Cache Hits:                ${rt.imageCache.hits}`,
                    `  • Cache Misses:              ${rt.imageCache.misses}`,
                    `  • Hit Ratio:                 ${rt.imageCache.hitPercentage} (${rt.imageCache.hitRatio})`,
                    ''
                );
            }

            // Print background tasks queued across the IdleGate scheduler
            if (rt.backgroundTasks) {
                lines.push(
                    'Background Tasks & Queue Depth:',
                    `  • IdleGate Pending Tasks:    ${rt.backgroundTasks.idleGatePendingCount}`,
                    `  • ImageCache Pending Queue:  ${rt.backgroundTasks.imageCachePendingCount}`,
                    `  • Total Background Tasks:    ${rt.backgroundTasks.totalPendingBackgroundTasks}`,
                    ''
                );
            }

            // Print time elapsed since the user last interacted with the app
            if (rt.userActivity) {
                lines.push(
                    'User Activity State:',
                    `  • Time Since Last Input:     ${rt.userActivity.timeSinceLastInteractionSec}s (${rt.userActivity.timeSinceLastInteractionMs} ms)`,
                    ''
                );
            }
        }

        // Append Raw JSON payload at the end of the text file
        lines.push(
            '================================================================================',
            'RAW JSON TELEMETRY BUNDLE',
            '================================================================================',
            JSON.stringify(data, null, 2),
            ''
        );

        return lines.join('\n');
    }

    /**
     * Uploads the formatted performance audit report directly to the Jellyfin server.
     * Uses the standard ClientLog Document endpoint with dedicated 60s timeout budget.
     * @param {string} [customFilename] Optional custom log file name
     * @returns {Promise<{ success: boolean, filename: string, timestamp: string }>}
     */
    async uploadReport(customFilename) {
        // Build report text payload
        const report = this.buildReport();
        const dateStr = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = customFilename || `Litefin_PerfReport_${dateStr}.txt`;

        // Dynamically import ApiClient singleton
        const { api } = await import('../../api/index.js');
        if (!api || typeof api.uploadClientLog !== 'function') {
            throw new Error('ApiClient uploadClientLog interface is unavailable');
        }

        // Post report text to /ClientLog/Document?name=...
        await api.uploadClientLog(filename, report.text);

        log.info(`Performance audit report uploaded successfully: ${filename}`);
        return {
            success: true,
            filename,
            timestamp: report.json.metadata.generatedAt
        };
    }
}

// Singleton collector instance
export const performanceReportCollector = new PerformanceReportCollector();
