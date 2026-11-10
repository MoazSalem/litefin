/**
 * ============================================================================
 * Performance Diagnostic Launcher
 * ============================================================================
 * Lightweight lazy-loading controller for the Performance Diagnostic HUD.
 * Ensures the overlay chunk is never parsed or fetched unless explicitly
 * enabled in preferences, and defers boot loading until browser idle.
 * ============================================================================
 */

import { storage } from '../../utils/StorageService.js';
import { logger } from '../../utils/Logger.js';

const log = logger.create('PerfDiagnostics');

/**
 * Returns true if the performance diagnostic overlay is configured active.
 * @returns {boolean}
 */
export function isPerformanceOverlayEnabled() {
    return storage.getItem('debug_perf_overlay_enabled') === 'true';
}

/**
 * Dynamically imports and initializes the PerformanceDiagnosticOverlay chunk.
 * @returns {Promise<Object|null>}
 */
export async function loadPerformanceOverlay() {
    try {
        const { performanceOverlay } = await import(
            /* webpackChunkName: "perf-overlay" */ './PerformanceDiagnosticOverlay.js'
        );
        performanceOverlay.init();
        performanceOverlay.show();
        return performanceOverlay;
    } catch (err) {
        log.error('Failed to dynamically load PerformanceDiagnosticOverlay:', err);
        return null;
    }
}

/**
 * Hides and cleans up the diagnostic overlay if currently loaded in memory.
 * @returns {Promise<void>}
 */
export async function unloadPerformanceOverlay() {
    try {
        const { performanceOverlay } = await import(
            /* webpackChunkName: "perf-overlay" */ './PerformanceDiagnosticOverlay.js'
        );
        performanceOverlay.hide();
        performanceOverlay.destroy();
    } catch (err) {
        log.warn('Failed to unload PerformanceDiagnosticOverlay:', err);
    }
}

/**
 * Toggles the diagnostic overlay state and persists the preference.
 * @param {boolean} [enable] Explicit target state
 * @returns {Promise<boolean>}
 */
export async function togglePerformanceOverlay(enable) {
    const currentState = isPerformanceOverlayEnabled();
    const targetState = enable !== undefined ? enable : !currentState;

    // Persist user preference
    storage.setItem('debug_perf_overlay_enabled', targetState);

    if (targetState) {
        await loadPerformanceOverlay();
    } else {
        await unloadPerformanceOverlay();
    }

    return targetState;
}

/**
 * Deferred startup hook. If enabled in storage, schedules the dynamic import
 * during browser idle time so initial app bootstrap, hydration, and LCP are unaffected.
 */
export function scheduleDeferredPerformanceOverlay() {
    if (!isPerformanceOverlayEnabled()) return;

    // Utilize requestIdleCallback when supported or defer via non-blocking timeout
    const schedule = typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function'
        ? window.requestIdleCallback
        : (cb) => setTimeout(cb, 1200);

    schedule(() => {
        if (isPerformanceOverlayEnabled()) {
            loadPerformanceOverlay();
        }
    });
}

/**
 * ============================================================================
 * Performance Telemetry Collector & Server Report Facades
 * ============================================================================
 */

/**
 * Returns true if the background performance report collector is enabled.
 * @returns {boolean}
 */
export function isPerformanceCollectorEnabled() {
    return storage.getItem('debug_perf_collector_enabled') === 'true';
}

/**
 * Dynamically imports and activates the PerformanceReportCollector chunk.
 * @returns {Promise<Object|null>}
 */
export async function loadPerformanceCollector() {
    try {
        const { performanceReportCollector } = await import(
            /* webpackChunkName: "perf-collector" */ './PerformanceReportCollector.js'
        );
        performanceReportCollector.start();
        return performanceReportCollector;
    } catch (err) {
        log.error('Failed to dynamically load PerformanceReportCollector:', err);
        return null;
    }
}

/**
 * Stops telemetry collection and disconnects active observers.
 * @returns {Promise<void>}
 */
export async function unloadPerformanceCollector() {
    try {
        const { performanceReportCollector } = await import(
            /* webpackChunkName: "perf-collector" */ './PerformanceReportCollector.js'
        );
        performanceReportCollector.stop();
    } catch (err) {
        log.warn('Failed to unload PerformanceReportCollector:', err);
    }
}

/**
 * Toggles the background performance telemetry collector.
 * @param {boolean} [enable] Explicit target state
 * @returns {Promise<boolean>} Resulting state
 */
export async function togglePerformanceCollector(enable) {
    const currentState = isPerformanceCollectorEnabled();
    const targetState = enable !== undefined ? enable : !currentState;

    // Persist user preference to local storage
    storage.setItem('debug_perf_collector_enabled', targetState);

    if (targetState) {
        await loadPerformanceCollector();
    } else {
        await unloadPerformanceCollector();
    }

    return targetState;
}

/**
 * Deferred startup hook for the background performance report collector.
 * If configured active in storage, starts collecting once browser is idle.
 */
export function scheduleDeferredPerformanceCollector() {
    if (!isPerformanceCollectorEnabled()) return;

    // Defer until browser finishes initial layout and hydration
    const schedule = typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function'
        ? window.requestIdleCallback
        : (cb) => setTimeout(cb, 1800);

    schedule(() => {
        if (isPerformanceCollectorEnabled()) {
            loadPerformanceCollector();
        }
    });
}

/**
 * Generates and uploads the performance diagnostic audit report to Jellyfin server.
 * @param {string} [customFilename] Optional filename override
 * @returns {Promise<{ success: boolean, filename: string, timestamp: string }>}
 */
export async function uploadPerformanceReport(customFilename) {
    const { performanceReportCollector } = await import(
        /* webpackChunkName: "perf-collector" */ './PerformanceReportCollector.js'
    );
    return performanceReportCollector.uploadReport(customFilename);
}

/**
 * Compiles and returns the formatted report text and JSON bundle.
 * @returns {Promise<{ text: string, json: Object }>}
 */
export async function generatePerformanceReport() {
    const { performanceReportCollector } = await import(
        /* webpackChunkName: "perf-collector" */ './PerformanceReportCollector.js'
    );
    return performanceReportCollector.buildReport();
}
