/**
 * ============================================================================
 * LiteFin Tizen - Debug Overlay
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
    }

    /**
     * Initialize the debug overlay
     * @param {boolean} [enabled=false] - Whether debug mode is enabled
     */
    init(enabled = false) {
        if (this._initialized) return;

        if (enabled) {
            // Debug Mode ON: Create overlay and intercept logs
            this._createElements();
            this._interceptConsole();
            this.show();
            console.log('DebugOverlay: Debug Mode ENABLED');
        } else {
            // Debug Mode OFF: Suppress logs to clean up output
            // We replace console methods with empty functions
            // This prevents "spam" in the native console and any visible output
            console.log = () => { };
            console.warn = () => { };
            console.error = () => { };
            console.info = () => { };
            console.debug = () => { };
        }

        this._initialized = true;
    }

    /**
     * Create overlay DOM elements and append to body
     * @private
     */
    _createElements() {
        // Container
        this._overlay = document.createElement('div');
        this._overlay.id = 'debug-overlay';
        this._overlay.style.cssText = `
            position: fixed;
            bottom: 0;
            left: 0;
            right: 0;
            height: 200px;
            background: rgba(0,0,0,0.85);
            color: #0f0;
            font-family: monospace;
            font-size: 14px;
            overflow-y: auto;
            z-index: 99999;
            padding: 10px;
            pointer-events: none;
            border-top: 2px solid #0f0;
            display: none;
            text-align: left;
            line-height: 1.4;
        `;

        // Header
        const header = document.createElement('div');
        header.style.cssText = `
            border-bottom: 1px solid #333;
            margin-bottom: 5px;
            font-weight: bold;
            display: flex;
            justify-content: space-between;
        `;
        header.textContent = `DEBUG CONSOLE - v${new Date().toLocaleTimeString()}`;
        this._overlay.appendChild(header);

        // Content area
        this._content = document.createElement('div');
        this._content.id = 'debug-content';
        this._overlay.appendChild(this._content);

        // Append to body
        document.body.appendChild(this._overlay);
    }

    /**
     * Intercept console.log/error/warn
     * @private
     */
    _interceptConsole() {
        const originalLog = console.log;
        const originalError = console.error;
        const originalWarn = console.warn;

        const addLog = (type, args) => {
            if (!this._content) return;

            const line = document.createElement('div');
            line.style.borderBottom = '1px solid #333';
            line.style.padding = '2px 0';
            line.style.wordBreak = 'break-all';

            if (type === 'error') line.style.color = '#f55';
            else if (type === 'warn') line.style.color = '#fa0';

            const text = args.map(arg => {
                if (typeof arg === 'object') {
                    try {
                        return JSON.stringify(arg);
                    } catch (e) {
                        return '[Object]';
                    }
                }
                return String(arg);
            }).join(' ');

            line.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
            this._content.appendChild(line);

            // Limit log lines to prevent memory issues
            if (this._content.children.length > 200) {
                this._content.removeChild(this._content.firstChild);
            }

            // Auto-scroll
            this._overlay.scrollTop = this._overlay.scrollHeight;
        };

        console.log = (...args) => {
            originalLog.apply(console, args);
            addLog('log', args);
        };

        console.error = (...args) => {
            originalError.apply(console, args);
            addLog('error', args);
        };

        console.warn = (...args) => {
            originalWarn.apply(console, args);
            addLog('warn', args);
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
}

export const debugOverlay = new DebugOverlay();
