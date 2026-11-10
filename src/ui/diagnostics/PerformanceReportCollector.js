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
import { logger } from '../../utils/Logger.js';

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

        // Ring buffer of worst frame drop events (duration > 26ms)
        this._jankEvents = [];
        this._maxJankEvents = 30;

        // Main thread long tasks (> 50ms)
        this._longTasks = [];
        this._maxLongTasks = 50;
        this._totalLongTaskTimeMs = 0;
        this._maxLongTaskMs = 0;

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
        this._totalLongTaskTimeMs = 0;
        this._maxLongTaskMs = 0;
        this._routeNavigations = [];

        this._distribution = {
            under16ms: 0,
            under25ms: 0,
            under33ms: 0,
            under50ms: 0,
            over50ms: 0
        };

        // Capture initial memory and DOM node baselines
        this._recordInitialBaselines();

        // Register PerformanceObserver instances
        this._setupObservers();

        // Listen for route navigation events
        this._setupRouteListener();

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

        log.info('Performance telemetry collector suspended.');
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
        if (supported.includes('longtask')) {
            try {
                const longTaskObserver = new PerformanceObserver((entryList) => {
                    for (const entry of entryList.getEntries()) {
                        this._recordLongTask(entry);
                    }
                });
                longTaskObserver.observe({ entryType: 'longtask' });
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
     * Stores main-thread long task entries with attribution context.
     * @private
     * @param {PerformanceEntry} entry Long task entry
     */
    _recordLongTask(entry) {
        const duration = Math.round(entry.duration);
        this._totalLongTaskTimeMs += duration;

        if (duration > this._maxLongTaskMs) {
            this._maxLongTaskMs = duration;
        }

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

        const relativeTimeMs = Math.round(entry.startTime - this._startTime);
        const taskRecord = {
            timeOffsetMs: relativeTimeMs,
            durationMs: duration,
            containerType,
            containerName,
            containerSrc
        };

        this._longTasks.push(taskRecord);

        // Keep buffer bounded
        if (this._longTasks.length > this._maxLongTasks) {
            this._longTasks.shift();
        }
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

            // Record dropped frame / stutter (> 26ms represents drop below ~38 FPS)
            if (delta > 26) {
                const currentRoute = router && typeof router.getCurrentPath === 'function' ? router.getCurrentPath() : '/';
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
        const totalHeapLimit = (typeof performance !== 'undefined' && performance.memory)
            ? performance.memory.jsHeapSizeLimit
            : null;

        // Current live DOM nodes
        const currentDomNodes = (typeof document !== 'undefined' && typeof document.getElementsByTagName === 'function')
            ? document.getElementsByTagName('*').length
            : 0;

        // Active CSS Zoom and display scale
        const currentZoom = (typeof document !== 'undefined' && document.documentElement)
            ? parseFloat(document.documentElement.style.zoom) || 1.0
            : 1.0;
        const displayScalePref = storage.getItem('pref:displayScale') || 'auto';

        // Structured JSON telemetry dictionary
        const reportJson = {
            metadata: {
                reportId: `perf-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                generatedAt: new Date().toISOString(),
                sessionStartDate: this._startDate,
                sessionDurationSeconds: sessionDurationSec,
                appVersion: globalThis.__APP_VERSION__ || '2.0.200'
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
                recentJankSpikes: this._jankEvents
            },
            longTasks: {
                totalDetected: this._longTasks.length,
                totalBlockingTimeMs: this._totalLongTaskTimeMs,
                longestTaskMs: this._maxLongTaskMs,
                entries: this._longTasks
            },
            webVitals: this._vitals,
            memoryAndDom: {
                initialHeapMb: bytesToMb(this._initialHeapBytes),
                peakHeapMb: bytesToMb(this._peakHeapBytes),
                currentHeapMb: bytesToMb(curHeap),
                heapLimitMb: bytesToMb(totalHeapLimit),
                initialDomNodes: this._initialDomNodes,
                peakDomNodes: this._peakDomNodes,
                currentDomNodes
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
            `Screen Resolution:    ${e.screenResolution}`,
            `Viewport Resolution:  ${e.viewportResolution} (DPR: ${e.devicePixelRatio})`,
            `Display Scale Mode:   ${e.displayScalePreference} (Active Zoom: ${e.rootCssZoom.toFixed(2)}x)`,
            `CPU Cores (Logical):  ${e.cpuCores}`,
            `Device RAM (Est):     ${e.deviceMemoryGb !== 'N/A' ? `${e.deviceMemoryGb} GB` : 'N/A'}`,
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
            '--------------------------------------------------------------------------------',
            '4. MAIN THREAD LONG TASKS (> 50ms)',
            '--------------------------------------------------------------------------------',
            `Total Long Tasks Detected:   ${l.totalDetected}`,
            `Total Blocking Duration:     ${l.totalBlockingTimeMs} ms`,
            `Longest Main-Thread Freeze:  ${l.longestTaskMs} ms`,
            ''
        ];

        // Format recent long tasks
        if (l.entries.length > 0) {
            lines.push('Captured Long Tasks Log:');
            l.entries.slice(-15).forEach((task, idx) => {
                const sec = (task.timeOffsetMs / 1000).toFixed(1);
                lines.push(`  ${idx + 1}. [+${sec}s] ${task.durationMs}ms freeze | Container: ${task.containerType} ${task.containerName || ''}`);
            });
            lines.push('');
        }

        // Format Memory and DOM complexity
        lines.push(
            '--------------------------------------------------------------------------------',
            '5. MEMORY CONSUMPTION & DOM COMPLEXITY',
            '--------------------------------------------------------------------------------',
            `Initial JS Heap Allocated:   ${mem.initialHeapMb} MB`,
            `Peak JS Heap Allocated:      ${mem.peakHeapMb} MB`,
            `Current JS Heap Allocated:   ${mem.currentHeapMb} MB (Limit: ${mem.heapLimitMb} MB)`,
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
