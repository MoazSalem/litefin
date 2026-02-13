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
        this._isLogging = false; // Flag to prevent infinite loops/duplicates

        // Modules that are specifically filtered OUT
        this._disabledModules = new Set();
        // Track all registered modules dynamically
        this._registeredModules = new Set();

        // Cache enabled state from localStorage
        this._loadSettings();

        // Start capturing console immediately
        this._captureConsole();
    }

    _loadSettings() {
        try {
            // NOTE: We use localStorage directly here because Logger initializes BEFORE StorageService.
            // Using StorageService here would cause a circular dependency.
            this._enabled = localStorage.getItem('debug_logs_enabled') === 'true';
            this._level = this._enabled ? LogLevel.DEBUG : LogLevel.INFO;

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
        this._registeredModules.add(moduleName);
        return {
            error: (...args) => this._log(LogLevel.ERROR, moduleName, args),
            warn: (...args) => this._log(LogLevel.WARN, moduleName, args),
            info: (...args) => this._log(LogLevel.INFO, moduleName, args),
            debug: (...args) => this._log(LogLevel.DEBUG, moduleName, args),
            verbose: (...args) => this._log(LogLevel.VERBOSE, moduleName, args)
        };
    }

    /**
     * Get all registered modules
     * @returns {string[]}
     */
    getRegisteredModules() {
        return Array.from(this._registeredModules).sort();
    }

    /**
     * Intercept native console methods to capture logs from 3rd party libs (like the player)
     * @private
     */
    _captureConsole() {
        const methods = ['log', 'info', 'warn', 'error', 'debug'];
        const originalConsole = { ...console };

        methods.forEach((method) => {
            console[method] = (...args) => {
                // 1. Call original method (so DevTools still see it)
                originalConsole[method].apply(console, args);

                // 2. If this log came from us (Logger._log), ignore it to prevent duplicates
                // The _isLogging flag is set during our own _log calls
                if (this._isLogging) return;

                // 3. Emit to EventBus for DebugOverlay
                // Map console methods to LogLevels
                let level = LogLevel.INFO;
                if (method === 'error') level = LogLevel.ERROR;
                else if (method === 'warn') level = LogLevel.WARN;
                else if (method === 'debug') level = LogLevel.DEBUG;

                eventBus.emit('logger:log', {
                    level,
                    module: 'System', // Generic module for external logs
                    timestamp: Date.now(),
                    args
                });
            };
        });
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
            this._isLogging = true; // Set flag to warn interceptor to ignore this
            try {
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
            } finally {
                this._isLogging = false; // Reset flag
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
        // When enabled via UI, we want to see everything including DEBUG
        this._level = enabled ? LogLevel.DEBUG : LogLevel.INFO;
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
