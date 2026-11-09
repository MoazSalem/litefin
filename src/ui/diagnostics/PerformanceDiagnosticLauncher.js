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
        loadPerformanceOverlay();
    });
}
