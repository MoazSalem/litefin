/**
 * ============================================================================
 * Litefin Tizen - Debug Overlay
 * ============================================================================
 * Global debug console overlay for Tizen TVs.
 * Intercepts console logs and displays them in an on-screen window.
 * ============================================================================
 */

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

        // Store original methods
        this._originalConsole = {
            log: console.log,
            error: console.error,
            warn: console.warn,
            info: console.info,
            debug: console.debug
        };

        // Known modules for filtering
        this._knownModules = [
            'Router',
            'FocusManager',
            'TizenAdapter',
            'AuthManager',
            'ApiClient',
            'DeviceProfile',
            'Player',
            'StateManager',
            'EventBus',
            'NavigationState'
        ];

        // Filter state (Map: ModuleName -> Boolean)
        this._moduleFilters = new Map();
        this._loadModulePreferences();
    }

    /**
     * Initialize the debug overlay
     * @param {boolean} [enableLogs=false]
     * @param {boolean} [enableOverlay=false]
     * @param {string} [width='small']
     * @param {string} [height='small']
     * @param {string} [position='bottom-right']
     */
    init(enableLogs = false, enableOverlay = false, width = 'small', height = 'small', position = 'bottom-right') {
        if (this._initialized) return;

        this._logsEnabled = enableLogs;
        this._overlayEnabled = enableOverlay;
        this._width = width;
        this._height = height;
        this._position = position;

        // Always intercept, but control output via flags
        this._interceptConsole();

        // Initialize UI if needed
        if (this._overlayEnabled) {
            this._createElements();
            this.show();
        }

        if (this._logsEnabled) {
            this._originalConsole.log('DebugOverlay: Initialized', {
                logs: enableLogs,
                overlay: enableOverlay,
                width,
                height,
                position
            });
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

    get Width() { return this._width; }
    get Height() { return this._height; }
    get Position() { return this._position; }

    /**
     * Enable or disable console logs
     * @param {boolean} enabled
     */
    setLogsEnabled(enabled) {
        this._logsEnabled = enabled;
        // Log status change using original console to ensure it's seen if enabling
        if (enabled) {
            this._originalConsole.log('DebugOverlay: Debug Mode ENABLED');
        }
    }

    /**
     * Enable or disable the visual overlay
     * @param {boolean} enabled 
     */
    setOverlayEnabled(enabled) {
        this._overlayEnabled = enabled;

        if (enabled) {
            if (!this._overlay) {
                this._createElements();
            }
            this.show();
            if (this._logsEnabled) {
                console.log('DebugOverlay: Overlay ENABLED');
            }
        } else {
            this.hide();
        }
    }

    get isLogsEnabled() { return this._logsEnabled; }
    get isOverlayEnabled() { return this._overlayEnabled; }

    /**
     * Create overlay DOM elements and append to body
     * @private
     */
    _createElements() {
        if (this._overlay) return;

        // Container
        this._overlay = document.createElement('div');
        this._overlay.id = 'debug-overlay';

        // Base styles
        this._overlay.style.cssText = `
            position: fixed;
            background: rgba(0,0,0,0.85);
            color: #0f0;
            font-family: 'Consolas', 'Monaco', monospace;
            font-size: 13px;
            overflow-y: auto;
            z-index: 99999;
            padding: 10px;
            pointer-events: none;
            border: 1px solid #0f0;
            display: none;
            text-align: left;
            line-height: 1.4;
            box-shadow: 0 0 10px rgba(0,0,0,0.5);
            border-radius: 4px;
        `;

        // Apply dynamic styles
        this._updateStyles();

        // Header
        const header = document.createElement('div');
        header.style.cssText = `
            border-bottom: 1px solid #333;
            margin-bottom: 5px;
            font-weight: bold;
            display: flex;
            justify-content: space-between;
            align-items: center;
        `;
        header.innerHTML = `<span>DEBUG CONSOLE</span><span style="font-size:0.8em;opacity:0.7">v${__APP_VERSION__}</span>`;
        this._overlay.appendChild(header);

        // Content area
        this._content = document.createElement('div');
        this._content.id = 'debug-content';
        this._overlay.appendChild(this._content);

        // Append to body (ensure it's on top)
        document.body.appendChild(this._overlay);
    }

    _updateStyles() {
        if (!this._overlay) return;

        // Width
        let widthStr;
        switch (this._width) {
            case 'full': widthStr = '100%'; break;
            case 'large': widthStr = '800px'; break;
            case 'medium': widthStr = '600px'; break;
            case 'small':
            default: widthStr = '450px'; break;
        }

        // Height
        let heightStr;
        switch (this._height) {
            case 'full': heightStr = '100%'; break;
            case 'large': heightStr = '600px'; break;
            case 'medium': heightStr = '400px'; break;
            case 'small':
            default: heightStr = '300px'; break;
        }

        this._overlay.style.width = widthStr;
        this._overlay.style.height = heightStr;

        // Font size adjustments based on size? 
        // Keep it simple for now, fixed font size or maybe slightly larger for 'large' config?
        // Let's stick to standard 13px unless user asks
        this._overlay.style.fontSize = '13px';

        // Position
        // Reset all positions first
        this._overlay.style.top = 'auto';
        this._overlay.style.bottom = 'auto';
        this._overlay.style.left = 'auto';
        this._overlay.style.right = 'auto';

        const margin = (this._width === 'full' || this._height === 'full') ? '0' : '20px';

        switch (this._position) {
            case 'top-left':
                this._overlay.style.top = margin;
                this._overlay.style.left = margin;
                break;
            case 'top-right':
                this._overlay.style.top = margin;
                this._overlay.style.right = margin;
                break;
            case 'bottom-left':
                this._overlay.style.bottom = margin;
                this._overlay.style.left = margin;
                break;
            case 'bottom-right':
            default:
                this._overlay.style.bottom = margin;
                this._overlay.style.right = margin;
                break;
        }
    }

    /**
     * Intercept console.log/error/warn
     * @private
     */
    /**
     * Intercept console.log/error/warn
     * @private
     */
    _interceptConsole() {
        const addLog = (type, args) => {
            if (!this._overlayEnabled || !this._content) return;

            // STRINGIFY FIRST to check for module prefixes
            const textArgs = args.map(arg => {
                if (typeof arg === 'object') {
                    try {
                        return JSON.stringify(arg);
                    } catch (e) {
                        return '[Object]';
                    }
                }
                return String(arg);
            });
            const fullText = textArgs.join(' ');

            // FILTERING LOGIC
            // Check for prefixes like "Router:", "[FocusManager]", "TizenAdapter:"
            const moduleMatch = fullText.match(/^(?:\[?(\w+)\]?:?)\s/);
            if (moduleMatch) {
                const moduleName = moduleMatch[1];
                // If this module is tracked AND disabled, skip logging
                if (this._moduleFilters.has(moduleName) && !this._moduleFilters.get(moduleName)) {
                    return;
                }
            }

            const line = document.createElement('div');
            line.style.borderBottom = '1px solid #333';
            line.style.padding = '2px 0';
            line.style.wordBreak = 'break-all';

            if (type === 'error') line.style.color = '#f55';
            else if (type === 'warn') line.style.color = '#fa0';

            line.textContent = `[${new Date().toLocaleTimeString()}] ${fullText}`;
            this._content.appendChild(line);

            if (this._content.children.length > 200) {
                this._content.removeChild(this._content.firstChild);
            }
            this._overlay.scrollTop = this._overlay.scrollHeight;
        };

        // Wrap methods
        console.log = (...args) => {
            if (this._logsEnabled) {
                // Check filter for console output too?
                // The user asked "work in both browser console and overlay"
                // So we should verify filter before calling original console.

                // We need to construct string to check filter
                const firstArg = args[0];
                if (typeof firstArg === 'string') {
                    const moduleMatch = firstArg.match(/^(?:\[?(\w+)\]?:?)\s/);
                    if (moduleMatch) {
                        const moduleName = moduleMatch[1];
                        if (this._moduleFilters.has(moduleName) && !this._moduleFilters.get(moduleName)) {
                            // Suppress completely
                            return;
                        }
                    }
                }

                this._originalConsole.log.apply(console, args);
                addLog('log', args);
            }
        };

        console.error = (...args) => {
            if (this._logsEnabled) {
                const firstArg = args[0];
                if (typeof firstArg === 'string') {
                    const moduleMatch = firstArg.match(/^(?:\[?(\w+)\]?:?)\s/);
                    if (moduleMatch) {
                        const moduleName = moduleMatch[1];
                        if (this._moduleFilters.has(moduleName) && !this._moduleFilters.get(moduleName)) {
                            return;
                        }
                    }
                }

                this._originalConsole.error.apply(console, args);
                addLog('error', args);
            }
        };

        console.warn = (...args) => {
            if (this._logsEnabled) {
                const firstArg = args[0];
                if (typeof firstArg === 'string') {
                    const moduleMatch = firstArg.match(/^(?:\[?(\w+)\]?:?)\s/);
                    if (moduleMatch) {
                        const moduleName = moduleMatch[1];
                        if (this._moduleFilters.has(moduleName) && !this._moduleFilters.get(moduleName)) {
                            return;
                        }
                    }
                }

                this._originalConsole.warn.apply(console, args);
                addLog('warn', args);
            }
        };

        // Suppress others if logs disabled
        console.info = (...args) => {
            if (this._logsEnabled) this._originalConsole.info.apply(console, args);
        };
        console.debug = (...args) => {
            if (this._logsEnabled) this._originalConsole.debug.apply(console, args);
        };
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

    toggle() {
        this._isVisible ? this.hide() : this.show();
    }

    /**
     * Load filter preferences from localStorage
     * @private
     */
    _loadModulePreferences() {
        this._knownModules.forEach(module => {
            const key = `debug_filter_${module}`;
            const stored = localStorage.getItem(key);
            // Default to TRUE (enabled) if not set
            const isEnabled = stored === null ? true : stored === 'true';
            this._moduleFilters.set(module, isEnabled);
        });
    }

    /**
     * Toggle visibility for a specific module
     * @param {string} moduleName 
     * @param {boolean} enabled 
     */
    toggleModule(moduleName, enabled) {
        if (!this._knownModules.includes(moduleName)) return;

        this._moduleFilters.set(moduleName, enabled);
        localStorage.setItem(`debug_filter_${moduleName}`, enabled);

        this._originalConsole.log(`DebugOverlay: Module filter '${moduleName}' set to ${enabled}`);
    }

    /**
     * Check if a module is enabled
     * @param {string} moduleName 
     */
    isModuleEnabled(moduleName) {
        if (!this._moduleFilters.has(moduleName)) return true;
        return this._moduleFilters.get(moduleName);
    }

    /**
     * Get list of known modules
     */
    getKnownModules() {
        return this._knownModules;
    }
}

export const debugOverlay = new DebugOverlay();
