/**
 * ============================================================================
 * Litefin Tizen - Logger
 * ============================================================================
 * Centralized logging utility to replace direct console usage.
 * Features:
 * - Module-based filtering (tagging)
 * - Log levels (ERROR, WARN, INFO, DEBUG, VERBOSE)
 * - Zero-overhead when disabled (mostly)
 * - Event-based output (DebugOverlay subscribes to this)
 * ============================================================================
 */

import { eventBus } from '../core/EventBus.js';

export const LogLevel = {
    ERROR: 0,
    WARN: 1,
    INFO: 2,
    DEBUG: 3,
    VERBOSE: 4
};

class Logger {
    constructor() {
        this._level = LogLevel.INFO; // Default level
        this._enabled = false;

        // Modules that are specifically filtered OUT
        this._disabledModules = new Set();

        // Cache enabled state from localStorage
        this._loadSettings();
    }

    _loadSettings() {
        try {
            this._enabled = localStorage.getItem('debug_logs_enabled') === 'true';

            // Load module filters (we store what is ENABLED, so we inverse for _disabledModules)
            // Ideally DebugOverlay syncs this, but we load here for startup
            // Iterate all localStorage keys starting with 'debug_filter_'
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key.startsWith('debug_filter_')) {
                    const moduleName = key.replace('debug_filter_', '');
                    const isEnabled = localStorage.getItem(key) === 'true';
                    if (!isEnabled) {
                        this._disabledModules.add(moduleName);
                    }
                }
            }
        } catch (e) {
            console.warn('Logger: Failed to load settings', e);
        }
    }

    /**
     * Create a logger instance for a specific module
     * @param {string} moduleName
     */
    create(moduleName) {
        return {
            error: (...args) => this._log(LogLevel.ERROR, moduleName, args),
            warn: (...args) => this._log(LogLevel.WARN, moduleName, args),
            info: (...args) => this._log(LogLevel.INFO, moduleName, args),
            debug: (...args) => this._log(LogLevel.DEBUG, moduleName, args),
            verbose: (...args) => this._log(LogLevel.VERBOSE, moduleName, args)
        };
    }

    /**
     * Core logging function
     * @private
     */
    _log(level, moduleName, args) {
        // 1. Global On/Off Check (Fastest)
        if (!this._enabled && level > LogLevel.ERROR) return;

        // 2. Level Check
        if (level > this._level) return;

        // 3. Module Filter Check
        if (this._disabledModules.has(moduleName)) return;

        // 4. Emit to EventBus (for DebugOverlay or other listeners)
        // We do NOT stringify here. Let the consumer decide if they need to pay that cost.
        eventBus.emit('logger:log', {
            level,
            module: moduleName,
            timestamp: Date.now(),
            args
        });

        // 5. Output to native console (if enabled)
        // We format it nicely for the browser console
        if (this._enabled) {
            const prefix = `[${moduleName}]`;
            const css = this._getLevelColor(level);

            switch (level) {
                case LogLevel.ERROR:
                    console.error(`%c${prefix}`, css, ...args);
                    break;
                case LogLevel.WARN:
                    console.warn(`%c${prefix}`, css, ...args);
                    break;
                case LogLevel.INFO:
                    console.info(`%c${prefix}`, css, ...args);
                    break;
                default:
                    console.log(`%c${prefix}`, css, ...args);
            }
        }
    }

    _getLevelColor(level) {
        switch (level) {
            case LogLevel.ERROR:
                return 'color: #ff5555; font-weight: bold;';
            case LogLevel.WARN:
                return 'color: #ffaa00; font-weight: bold;';
            case LogLevel.INFO:
                return 'color: #55aaff; font-weight: bold;';
            case LogLevel.DEBUG:
                return 'color: #aa55ff;';
            default:
                return 'color: #888888;';
        }
    }

    setEnabled(enabled) {
        this._enabled = enabled;
        localStorage.setItem('debug_logs_enabled', enabled);
    }

    setModuleEnabled(moduleName, enabled) {
        if (enabled) {
            this._disabledModules.delete(moduleName);
        } else {
            this._disabledModules.add(moduleName);
        }
        localStorage.setItem(`debug_filter_${moduleName}`, enabled);
    }
}

export const logger = new Logger();

// Expose globally for non-ESM scripts (e.g. jellyfin-player-osd.js)
window.logger = logger;
