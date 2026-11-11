/**
 * ============================================================================
 * Litefin Tizen - Performance Operation Marker Bridge
 * ============================================================================
 * Ultra-lightweight marker bridge invoked from hot UI/navigation entry points
 * so PerformanceReportCollector can attribute main-thread long tasks to the
 * JS operation that triggered them without pulling the lazily code-split
 * "perf-collector" chunk into the boot bundle.
 *
 * When telemetry is inactive, _operationHandler is null and markPerfOperation
 * short-circuits cleanly in constant time with zero allocations.
 * ============================================================================
 */

// Active handler registered by PerformanceReportCollector.start() and cleared on stop()
let _operationHandler = null;

/**
 * Binds or clears the active operation attribution sink.
 *
 * @param {Function|null} handler - Callback receiving operation names, or null to unbind
 */
export function setPerfOperationHandler(handler) {
    _operationHandler = typeof handler === 'function' ? handler : null;
}

/**
 * Records a lightweight operation breadcrumb if performance collection is active.
 * Never throws so instrumentation can safely wrap critical input paths.
 *
 * @param {string} name - Short identifier for the operation (e.g. 'FocusManager._leaveSection')
 */
export function markPerfOperation(name) {
    if (!_operationHandler || !name) return;

    try {
        _operationHandler(name);
    } catch (_) {
        // Diagnostics must never disrupt UI execution
    }
}

