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

// Import core modules
import { app } from './core/App.js';
import { logger } from './utils/Logger.js';

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
import './styles/syncplay-menu.css';  /* SyncPlay group-selection overlay */
import './styles/settings.css';
import './styles/season.css';
import './styles/offline.css';
import './styles/screensaver.css';
import './styles/rtl.css'; // Directional overrides
import './themes/classic/index.js'; // All classic themes

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
