/**
 * ============================================================================
 * Litefin Tizen - Application Entry Point
 * ============================================================================
 * Main entry point that bootstraps the application.
 * ============================================================================
 */

// ----------------------------------------------------------------------------
// AbortController polyfill — must run before any imports to ensure
// availability in ApiClient and server discovery on Tizen 5.0 (Chromium 63),
// which shipped without AbortController. Tizen 5.5+ (Chromium 69) has it
// natively, so the guard makes this a zero-cost no-op there.
// ----------------------------------------------------------------------------
if (typeof AbortController === 'undefined') {
    /**
     * Minimal AbortController polyfill.
     * Covers the abort() + signal.aborted + onabort callback surface
     * used by the fetch() timeout pattern in ApiClient.
     */
    window.AbortController = function AbortController() {
        /** @type {AbortSignal} */
        this.signal = Object.create(null);
        this.signal.aborted = false;
        this.signal.onabort = null;
        this.signal.addEventListener = function () {};
        this.signal.removeEventListener = function () {};
        this.signal.dispatchEvent = function () {};

        // Store a reference to signal on the controller so abort() can reach it
        const _signal = this.signal;

        /**
         * Abort the associated request.
         * Sets signal.aborted and fires the onabort callback if set.
         */
        this.abort = function () {
            if (_signal.aborted) return;
            _signal.aborted = true;
            if (typeof _signal.onabort === 'function') {
                // Dispatch a synthetic AbortError-like event
                _signal.onabort({ type: 'abort', target: _signal });
            }
        };
    };
}

// ----------------------------------------------------------------------------
// WeakSet + WeakMap polyfill — required by hls.js on ancient WebKit
// (e.g., WebOS WebKit/538.2, Tizen 3.0) that predates ES2015 WeakSet/WeakMap.
// Hls.js v1.x uses WeakSet internally for tracking buffered segments.
// Must run before hls.js is loaded (dynamically imported by WebOSPlayer).
// ----------------------------------------------------------------------------
if (typeof WeakSet === 'undefined') {
    /**
     * Minimal WeakSet polyfill.
     * Uses an array internally — weak-ref semantics are approximated since
     * true WeakRef is unavailable on these targets. The consumer (hls.js)
     * only calls add/has/delete during the playback session lifecycle.
     */
    window.WeakSet = function (iterable) {
        this._items = [];
        if (iterable && typeof iterable.forEach === 'function') {
            var self = this;
            iterable.forEach(function (v) {
                self.add(v);
            });
        }
    };
    window.WeakSet.prototype.add = function (value) {
        if (this._items.indexOf(value) === -1) {
            this._items.push(value);
        }
        return this;
    };
    window.WeakSet.prototype.has = function (value) {
        return this._items.indexOf(value) !== -1;
    };
    window.WeakSet.prototype.delete = function (value) {
        var idx = this._items.indexOf(value);
        if (idx !== -1) {
            this._items.splice(idx, 1);
            return true;
        }
        return false;
    };
}

if (typeof WeakMap === 'undefined') {
    /**
     * Minimal WeakMap polyfill.
     * Array-based key-value storage — get/set/has/delete surface used
     * by hls.js and other ES2015-era dependencies.
     */
    window.WeakMap = function (iterable) {
        this._keys = [];
        this._values = [];
        if (iterable && typeof iterable.forEach === 'function') {
            var self = this;
            iterable.forEach(function (pair) {
                self.set(pair[0], pair[1]);
            });
        }
    };
    window.WeakMap.prototype.set = function (key, value) {
        var idx = this._keys.indexOf(key);
        if (idx !== -1) {
            this._values[idx] = value;
        } else {
            this._keys.push(key);
            this._values.push(value);
        }
        return this;
    };
    window.WeakMap.prototype.get = function (key) {
        var idx = this._keys.indexOf(key);
        return idx !== -1 ? this._values[idx] : undefined;
    };
    window.WeakMap.prototype.has = function (key) {
        return this._keys.indexOf(key) !== -1;
    };
    window.WeakMap.prototype.delete = function (key) {
        var idx = this._keys.indexOf(key);
        if (idx !== -1) {
            this._keys.splice(idx, 1);
            this._values.splice(idx, 1);
            return true;
        }
        return false;
    };
}

// Import core modules
import { app } from './core/App.js';
import { logger } from './utils/Logger.js';
import { PlayerSettings } from './utils/PlayerSettings.js';

const log = logger.create('Bootstrap');

// Import styles
import './styles/base.css';
import './styles/fonts.css';
import './styles/layout.css';
import './styles/components.css';
import './styles/library.css';
import './styles/sidebar.css';
import './styles/login.css';
import './styles/home.css';
import './styles/details.css';
import './styles/search.css';
import './styles/player-osd.css';
import './styles/upnext.css';
import './styles/player-modals.css'; /* Chapters & Queue modal panels */
import './styles/syncplay-menu.css'; /* SyncPlay group-selection overlay */
import './styles/settings.css';
import './styles/lock-overlay.css';
import './styles/season.css';
import './styles/offline.css';
import './styles/profiles.css'; /* "Who's Watching" profile switcher */
import './styles/pin-dialog.css'; /* Per-profile PIN entry keypad */
import './styles/screensaver.css';
import './styles/hero-carousel.css';
import './styles/livetv.css';
import './styles/slideshow.css'; // Full-screen photo viewer
import './styles/rtl.css'; // Directional overrides
import './themes/index.js'; // All shared themes
import './styles/modern/core.css';
import './styles/modern/server.css';
import './styles/modern/manual.css';
import './styles/modern/users.css';
import './styles/modern/home.css';

/**
 * Bootstrap the application
 */
async function bootstrap() {
    log.info('Starting Bootstrap...');

    // Initialize the app
    // app.init() now owns the hardware, debug, layout, and auth sequence
    await app.init({
        container: '#app'
    });

    /*
     * Deferred housekeeping: prune stale debug_filter_* localStorage keys.
     *
     * By the time app.init() resolves, every module has been statically
     * imported and called logger.create(), so _registeredModules is complete.
     * We defer via setTimeout so the initial route render (home/login) is
     * not blocked by this housekeeping pass — it runs invisibly in the
     * background a few seconds after startup.
     */
    setTimeout(() => {
        logger.pruneOrphanFilters();
    }, 3000);

    /*
     * Wake up the Node.js background service early.
     * Tizen: AppSharedURI will silently wake up the companion web service.
     * WebOS: A dummy luna request will wake up the service context.
     */
    try {
        const isSvcEnabled = PlayerSettings.get('enableBackgroundService');
        if (isSvcEnabled !== false) {
            if (typeof tizen !== 'undefined') {
                try {
                    const appId = tizen.application.getCurrentApplication().appInfo.id;
                    const pkgId = appId.split('.')[0];
                    tizen.application.launch(
                        pkgId + '.ytresolver',
                        function () {
                            log.info('Tizen background service launched successfully');
                        },
                        function (err) {
                            log.error('Failed to launch Tizen background service: ' + err.message);
                        }
                    );
                } catch (e) {
                    log.error('Exception launching Tizen service: ' + e.message);
                }
            } else if (window.webOS && window.webOS.service) {
                window.webOS.service.request('luna://org.litefin.app.service', {
                    method: 'discover',
                    parameters: { subscribe: false },
                    onSuccess: function () {},
                    onFailure: function () {}
                });
            }
        } else {
            log.info('Background service launch skipped (disabled in settings)');
        }
    } catch (e) {
        log.warn('Failed to wake up background service:', e);
    }

    log.info('Bootstrap entry complete');
}

// Wait for DOM ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
} else {
    bootstrap();
}

// Signal to the startup error catcher in index.html that
// our bundle parsed and executed successfully. This disables
// the global error overlay for post-bootstrap errors (which
// the app handles internally).
if (typeof window.__litefin_mark_loaded === 'function') {
    window.__litefin_mark_loaded();
}
