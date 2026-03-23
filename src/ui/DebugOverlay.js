/**
 * ============================================================================
 * Litefin Tizen - Debug Overlay
 * ============================================================================
 * Global debug console overlay for Tizen TVs.
 * Displays logs from the centralized Logger utility.
 * Optimized for performance with batched updates.
 * ============================================================================
 */

import { eventBus } from '../core/EventBus.js';
import { logger, LogLevel } from '../utils/Logger.js';
import { storage } from '../utils/StorageService.js';

class DebugOverlay {
    constructor() {
        this._initialized = false;
        this._overlay = null;
        this._content = null;
        this._isVisible = false;

        this._logsEnabled = false;
        this._overlayEnabled = false;

        // Default settings
        this._width = 'small';
        this._height = 'small';
        this._position = 'bottom-right';

        // Known modules for filtering (Initial list, will be augmented by Logger.create)
        this._knownModules = [
            'ApiClient',
            'App',
            'AuthManager',
            'BackdropManager',
            'Bootstrap',
            'Component',
            'DetailsPage',
            'DeviceProfile',
            'EpisodeList',
            'EventBus',
            'FavoriteButton',
            'FavoritesPage',
            'FocusManager',
            'FontLoader',
            'HomePage',
            'LayoutManager',
            'LazyLoader',
            'Library',
            'Login',
            'MediaGrid',
            'NavigationState',
            'OfflinePage',
            'OSD',
            'Page',
            'PersonPage',
            'Player',
            'PlayerSettings',
            'PlayQueue',
            'Router',
            'SearchPage',
            'SettingsPage',
            'Sidebar',
            'StateManager',
            'Storage',
            'TizenAdapter',
            'Toast',
            'WebSocketHandler'
        ];

        // Batching state
        this._logQueue = [];
        this._rafId = null;

        // Background buffer for log upload (always active)
        this._uploadBuffer = [];
        this._maxBufferLines = 10000;
    }

    /**
     * Initialize the debug overlay
     */
    init(enableLogs, enableOverlay, width, height, position) {
        if (this._initialized) return;

        // Load settings from storage if not explicitly provided
        if (enableLogs === undefined) {
            this._logsEnabled = storage.getItem('debug_logs_enabled') === 'true';
        } else {
            this._logsEnabled = enableLogs;
        }
        logger.setEnabled(this._logsEnabled);

        if (enableOverlay === undefined) {
            this._overlayEnabled = storage.getItem('debug_overlay_enabled') === 'true';
        } else {
            this._overlayEnabled = enableOverlay;
        }

        this._width = width || storage.getItem('debug_width') || 'small';
        this._height = height || storage.getItem('debug_height') || 'small';
        this._position = position || storage.getItem('debug_position') || 'bottom-right';

        // Sync Logger state
        if (this._logsEnabled) {
            logger.setEnabled(true);
        }

        // Subscribe to Logger events
        eventBus.on('logger:log', (logEntry) => this._queueLog(logEntry));

        // Initialize UI if needed
        if (this._overlayEnabled) {
            this._createElements();
            this.show();
        }

        this._initialized = true;
    }

    setWidth(width) {
        this._width = width;
        this._updateStyles();
    }

    setHeight(height) {
        this._height = height;
        this._updateStyles();
    }

    setPosition(position) {
        this._position = position;
        this._updateStyles();
    }

    get Width() {
        return this._width;
    }
    get Height() {
        return this._height;
    }
    get Position() {
        return this._position;
    }

    setLogsEnabled(enabled) {
        this._logsEnabled = enabled;
        logger.setEnabled(enabled);
    }

    setOverlayEnabled(enabled) {
        this._overlayEnabled = enabled;
        storage.setItem('debug_overlay_enabled', enabled);

        if (enabled) {
            if (!this._overlay) {
                this._createElements();
            }
            this.show();
            // Ensure theme is applied to new elements
            this.refreshTheme();
        } else {
            this.hide();
        }
    }

    get isLogsEnabled() {
        return this._logsEnabled;
    }
    get isOverlayEnabled() {
        return this._overlayEnabled;
    }

    _createElements() {
        if (this._overlay) return;

        this._overlay = document.createElement('div');
        this._overlay.id = 'debug-overlay';

        this._overlay.style.cssText = `
            position: fixed;
            background: rgba(0,0,0,0.85);
            color: #ccc;
            font-family: 'Consolas', 'Monaco', monospace;
            font-size: 13px;
            overflow-y: auto;
            z-index: 99999;
            padding: 10px;
            pointer-events: none;
            border: 1px solid var(--jf-accent, #444);
            display: none;
            text-align: left;
            line-height: 1.4;
            box-shadow: 0 0 10px rgba(0,0,0,0.5);
            border-radius: 4px;
        `;

        this._updateStyles();

        const header = document.createElement('div');
        header.style.cssText = `
            border-bottom: 1px solid var(--jf-accent, #444);
            margin-bottom: 5px;
            padding-bottom: 5px;
            font-weight: bold;
            display: flex;
            justify-content: space-between;
            align-items: center;
            color: var(--jf-accent, #fff);
        `;
        header.innerHTML = `<span>DEBUG CONSOLE</span><span style="font-size:0.8em;opacity:0.7">v${__APP_VERSION__}</span>`;
        this._overlay.appendChild(header);

        this._content = document.createElement('div');
        this._content.id = 'debug-content';
        this._overlay.appendChild(this._content);

        document.body.appendChild(this._overlay);
    }

    _updateStyles() {
        if (!this._overlay) return;

        let widthStr = '450px';
        if (this._width === 'full') widthStr = '100%';
        else if (this._width === 'large') widthStr = '800px';
        else if (this._width === 'medium') widthStr = '600px';

        let heightStr = '300px';
        if (this._height === 'full') heightStr = '100%';
        else if (this._height === 'large') heightStr = '600px';
        else if (this._height === 'medium') heightStr = '400px';

        this._overlay.style.width = widthStr;
        this._overlay.style.height = heightStr;

        // Reset positions
        this._overlay.style.top = 'auto';
        this._overlay.style.bottom = 'auto';
        this._overlay.style.left = 'auto';
        this._overlay.style.right = 'auto';

        const margin = this._width === 'full' || this._height === 'full' ? '0' : '20px';

        if (this._position.includes('top')) this._overlay.style.top = margin;
        else this._overlay.style.bottom = margin;

        if (this._position.includes('left')) this._overlay.style.left = margin;
        else this._overlay.style.right = margin;
    }

    /**
     * Refresh the theme-related styles of the overlay
     */
    refreshTheme() {
        if (!this._overlay) return;

        // Force colors from CSS variables
        this._overlay.style.borderColor = 'var(--jf-accent)';
        
        const header = this._overlay.querySelector('div');
        if (header) {
            header.style.color = 'var(--jf-accent)';
            header.style.borderBottomColor = 'var(--jf-accent)';
        }

        // We don't re-flush old logs just for the color change as that would be expensive,
        // but new logs will pick up the new theme color immediately.
    }

    /**
     * Queue a log entry to be rendered
     * @private
     */
    _queueLog(logEntry) {
        // 1. Always add to upload buffer
        this._addToUploadBuffer(logEntry);

        // 2. Only queue for rendering if overlay is enabled
        if (!this._overlayEnabled || !this._content) return;

        this._logQueue.push(logEntry);

        if (!this._rafId) {
            this._rafId = requestAnimationFrame(() => this._flushLogs());
        }
    }

    /**
     * Add log to background buffer
     * @private
     */
    /**
     * @private
     */
    _addToUploadBuffer(entry) {
        // Format simple string for text file
        const date = new Date(entry.timestamp);
        // Using local ISO-like format: YYYY-MM-DD HH:MM:SS.mmm
        const pad = (n) => String(n).padStart(2, '0');
        const pad3 = (n) => String(n).padStart(3, '0');
        const timeStr =
            `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
            `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad3(date.getMilliseconds())}`;

        const levelStr = Object.keys(LogLevel).find((key) => LogLevel[key] === entry.level) || 'UNKNOWN';

        const textArgs = entry.args.map((arg) => {
            if (typeof arg === 'object') {
                try {
                    return JSON.stringify(arg);
                } catch (e) {
                    return '[Object]';
                }
            }
            return String(arg);
        });

        const line = `[${timeStr}] [${levelStr}] [${entry.module}] ${textArgs.join(' ')}`;

        this._uploadBuffer.push(line);

        // Trim buffer if needed
        if (this._uploadBuffer.length > this._maxBufferLines) {
            this._uploadBuffer.shift(); // Remove oldest
        }
    }

    /**
     * Get all buffered logs as a single string
     */
    getLogDump() {
        const header = [
            '================================================================================',
            `Litefin Tizen Client Log`,
            `Version: ${__APP_VERSION__}`,
            `User Agent: ${navigator.userAgent}`,
            `Time: ${new Date().toLocaleString()}`,
            '================================================================================',
            ''
        ].join('\r\n');

        return header + this._uploadBuffer.join('\r\n');
    }

    /**
     * Flush queued logs to DOM in a single frame
     * @private
     */
    _flushLogs() {
        this._rafId = null;
        if (this._logQueue.length === 0) return;

        const fragment = document.createDocumentFragment();

        for (const entry of this._logQueue) {
            const line = document.createElement('div');
            line.style.borderBottom = '1px solid #222';
            line.style.padding = '2px 0';
            line.style.wordBreak = 'break-all';

            // Color coding
            if (entry.level === LogLevel.ERROR) line.style.color = '#ff5555';
            else if (entry.level === LogLevel.WARN) line.style.color = '#ffaa00';
            else if (entry.level === LogLevel.DEBUG) line.style.color = 'var(--jf-accent, #aa55ff)';

            // Stringify args carefully
            const textArgs = entry.args.map((arg) => {
                if (typeof arg === 'object') {
                    try {
                        return JSON.stringify(arg);
                    } catch (e) {
                        return '[Object]';
                    }
                }
                return String(arg);
            });

            // Format timestamp
            const time = new Date(entry.timestamp).toLocaleTimeString().split(' ')[0]; // HH:MM:SS
            line.textContent = `[${time}] [${entry.module}] ${textArgs.join(' ')}`;

            fragment.appendChild(line);
        }

        this._content.appendChild(fragment);

        // Prune old logs
        while (this._content.children.length > 200) {
            this._content.removeChild(this._content.firstChild);
        }

        // Scroll to bottom
        this._overlay.scrollTop = this._overlay.scrollHeight;

        // Clear queue
        this._logQueue = [];
    }

    show() {
        if (this._overlay) {
            this._overlay.style.display = 'block';
            this._isVisible = true;
        }
    }

    hide() {
        if (this._overlay) {
            this._overlay.style.display = 'none';
            this._isVisible = false;
        }
    }

    // Toggle module filter
    toggleModule(moduleName, enabled) {
        logger.setModuleEnabled(moduleName, enabled);
    }

    isModuleEnabled(moduleName) {
        // We rely on Logger for the truth, but since DebugOverlay is tracking
        // local storage in the Settings page, we can assume true if not explicitly disabled.
        // For UI purposes, let's peek at StorageService directly or assume true.
        const key = `debug_filter_${moduleName}`;
        const val = storage.getItem(key);
        return val !== 'false';
    }

    getKnownModules() {
        // Combine static known modules with dynamic ones registered at runtime
        const allModules = new Set([...this._knownModules, ...logger.getRegisteredModules()]);
        return Array.from(allModules).sort();
    }
}

export const debugOverlay = new DebugOverlay();
