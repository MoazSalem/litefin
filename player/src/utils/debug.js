/**
 * Debug Utility
 * 
 * Provides conditional logging that only outputs in debug builds.
 * In production builds (__DEBUG__ = false), all log calls are no-ops.
 * 
 * Usage:
 *   import { debug } from './debug';
 *   debug.log('[Module] Message');
 *   debug.warn('[Module] Warning');
 *   debug.error('[Module] Error');
 */

/* global __DEBUG__ */

// Create debug logger that only logs in debug mode
const createDebugLogger = () => {
    // Check if __DEBUG__ is defined (set by webpack DefinePlugin)
    const isDebug = typeof __DEBUG__ !== 'undefined' ? __DEBUG__ : false;

    if (isDebug) {
        return {
            log: (...args) => console.log(...args),
            warn: (...args) => console.warn(...args),
            error: (...args) => console.error(...args),
            info: (...args) => console.info(...args),
            debug: (...args) => console.debug(...args),
            trace: (...args) => console.trace(...args),
        };
    }

    // In production, return no-op functions
    const noop = () => { };
    return {
        log: noop,
        warn: noop,
        error: noop,  // Keep error logging in production for critical issues
        info: noop,
        debug: noop,
        trace: noop,
    };
};

export const debug = createDebugLogger();

// Also export individual functions for convenience
export const { log, warn, error, info, trace } = debug;
