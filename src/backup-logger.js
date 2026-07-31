/**
 * ============================================================================
 * Backup Logger — Zero-Dependency Early Boot Diagnostic
 * ============================================================================
 * Loaded as the FIRST script in index.html. Runs before any ES module,
 * polyfill, or framework code. Compatible with Chromium 32 (Tizen 2.x).
 *
 * What it does:
 *   1. Monkeypatches console.log/info/warn/error immediately with safe wrappers
 *   2. Creates a raw <div id="bl"> fixed to the top of the screen
 *   3. Persists every log line to localStorage["bl_log"] (circular buffer)
 *      — so logs survive crashes, reboots, or the app being killed by the TV
 *
 * WHY THIS FIXES THE BOOT HANG:
 *   On Chromium 32 (Tizen 2.x), somewhere in the app startup a raw console.*
 *   call is made with a complex object or in a context where the native console
 *   throws. This wrapper catches those errors silently, allowing initialization
 *   to continue. The DebugOverlay (once loaded) calls window.__hideBackupLogger()
 *   to get this panel out of the way.
 * ============================================================================
 */
(function () {
    /* ---------------------------------------------------------------------- */
    /* CONFIG                                                                   */
    /* ---------------------------------------------------------------------- */
    // eslint-disable-next-line no-var -- ES5-only: file runs raw (never Babel-transpiled)
    var BL_MAX_LINES = 300;
    // eslint-disable-next-line no-var -- ES5-only: file runs raw (never Babel-transpiled)
    var BL_MAX_STORE = 6000;

    /* ---------------------------------------------------------------------- */
    /* CREATE THE RAW DOM PANEL                                                 */
    /* ---------------------------------------------------------------------- */
    // eslint-disable-next-line no-var -- ES5-only: file runs raw (never Babel-transpiled)
    var panel = document.createElement('div');
    panel.id = 'bl';

    /* Individual property assignments — no cssText with CSS vars */
    // eslint-disable-next-line no-var -- ES5-only: file runs raw (never Babel-transpiled)
    var ps = panel.style;
    ps.position = 'fixed';
    ps.top = '0';
    ps.left = '0';
    ps.width = '100%';
    ps.height = '40%';
    ps.background = 'rgba(0,0,0,0.92)';
    ps.color = '#0f0';
    ps.fontFamily = 'monospace';
    ps.fontSize = '12px';
    ps.overflowY = 'auto';
    ps.zIndex = '2147483647';
    ps.padding = '6px';
    ps.pointerEvents = 'none';
    ps.whiteSpace = 'pre-wrap';
    ps.wordBreak = 'break-all';
    ps.boxSizing = 'border-box';

    /*
     * The panel is HIDDEN by default. Its job is purely to wrap console.*
     * before the webpack bundle runs — making them safe for Chrome 38 / WebOS.
     * We only show the panel when debug_overlay_enabled is set, so normal
     * users never see it.
     */
    // eslint-disable-next-line no-var -- ES5-only: file runs raw (never Babel-transpiled)
    var _debugActive = false;
    try {
        _debugActive = localStorage.getItem('debug_overlay_enabled') === 'true';
    } catch (e) {}
    ps.display = _debugActive ? 'block' : 'none';

    /* Append to <html> — <body> may not exist yet at this point */
    (document.head || document.documentElement).appendChild(panel);

    // eslint-disable-next-line no-var -- ES5-only: file runs raw (never Babel-transpiled)
    var lineCount = 0;

    /* ---------------------------------------------------------------------- */
    /* _write(level, args)                                                      */
    /* ---------------------------------------------------------------------- */
    function _write(level, args) {
        // eslint-disable-next-line no-var -- ES5-only: file runs raw (never Babel-transpiled)
        var msg = '';
        // eslint-disable-next-line no-var -- ES5-only: file runs raw (never Babel-transpiled)
        for (var i = 0; i < args.length; i++) {
            // eslint-disable-next-line no-var -- ES5-only: file runs raw (never Babel-transpiled)
            var a = args[i];
            if (a === null) {
                msg += 'null ';
                continue;
            }
            if (a === undefined) {
                msg += 'undefined ';
                continue;
            }
            if (typeof a === 'object') {
                try {
                    msg += JSON.stringify(a) + ' ';
                } catch (e) {
                    msg += '[Object] ';
                }
            } else {
                msg += String(a) + ' ';
            }
        }

        /* Persist to localStorage — survives crashes/reboots */
        try {
            // eslint-disable-next-line no-var -- ES5-only: file runs raw (never Babel-transpiled)
            var stored = localStorage.getItem('bl_log') || '';
            stored += new Date().toLocaleTimeString() + ' [' + level + '] ' + msg + '\n';
            if (stored.length > BL_MAX_STORE) {
                stored = stored.slice(stored.length - BL_MAX_STORE);
            }
            localStorage.setItem('bl_log', stored);
        } catch (e) {}

        /* Render a row to the DOM panel */
        // eslint-disable-next-line no-var -- ES5-only: file runs raw (never Babel-transpiled)
        var row = document.createElement('div');
        row.style.borderBottom = '1px solid #1a1a1a';
        row.style.padding = '1px 0';

        if (level === 'ERR') row.style.color = '#f55';
        else if (level === 'WARN') row.style.color = '#fe0';
        else if (level === 'INF') row.style.color = '#aaf';

        row.textContent = '[' + level + '] ' + msg;
        panel.appendChild(row);

        lineCount++;
        if (lineCount > BL_MAX_LINES && panel.firstChild) {
            panel.removeChild(panel.firstChild);
            lineCount--;
        }
        panel.scrollTop = panel.scrollHeight;
    }

    /* ---------------------------------------------------------------------- */
    /* MONKEYPATCH console.* — safe wrappers that never throw                  */
    /* ---------------------------------------------------------------------- */
    // eslint-disable-next-line no-var -- ES5-only: file runs raw (never Babel-transpiled)
    var _origLog = console.log;
    // eslint-disable-next-line no-var -- ES5-only: file runs raw (never Babel-transpiled)
    var _origInfo = console.info;
    // eslint-disable-next-line no-var -- ES5-only: file runs raw (never Babel-transpiled)
    var _origWarn = console.warn;
    // eslint-disable-next-line no-var -- ES5-only: file runs raw (never Babel-transpiled)
    var _origError = console.error;

    console.log = function () {
        _write('LOG', arguments);
        try {
            if (_origLog) _origLog.apply(console, arguments);
        } catch (e) {}
    };
    console.info = function () {
        _write('INF', arguments);
        try {
            if (_origInfo) _origInfo.apply(console, arguments);
        } catch (e) {}
    };
    console.warn = function () {
        _write('WARN', arguments);
        try {
            if (_origWarn) _origWarn.apply(console, arguments);
        } catch (e) {}
    };
    console.error = function () {
        _write('ERR', arguments);
        try {
            if (_origError) _origError.apply(console, arguments);
        } catch (e) {}
    };

    _write('INF', ['[BackupLogger] Active. UA=' + navigator.userAgent]);

    /* ---------------------------------------------------------------------- */
    /* GLOBAL API                                                               */
    /* ---------------------------------------------------------------------- */
    window.__hideBackupLogger = function () {
        panel.style.display = 'none';
    };
    window.__showBackupLogger = function () {
        panel.style.display = 'block';
    };
})();
