/**
 * ============================================================================
 * Litefin Tizen - Application Entry Point
 * ============================================================================
 * Main entry point that bootstraps the application.
 * ============================================================================
 */

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
import './styles/discover.css';
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
