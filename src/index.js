/**
 * ============================================================================
 * Litefin Tizen - Application Entry Point
 * ============================================================================
 * Main entry point that bootstraps the application.
 * ============================================================================
 */

// Import core modules
import { app } from './core/App.js';
import { tizenAdapter } from './tizen/TizenAdapter.js';
import { eventBus } from './core/EventBus.js';
import { auth } from './api/index.js';
import { layoutManager } from './ui/LayoutManager.js';
import { debugOverlay } from './ui/DebugOverlay.js';
import { logger } from './utils/Logger.js';

const log = logger.create('Bootstrap');

// Import styles
import './styles/base.css';
import './styles/layout.css';
import './styles/components.css';
import './styles/library.css';
import './styles/sidebar.css';
import './styles/login.css';
import './styles/home.css';
import './styles/details.css';
import './styles/search.css';
import './styles/player-osd.css';
import './styles/settings.css';
import './styles/season.css';
import './themes/classic/index.js'; // All classic themes

import HomePage from './pages/HomePage.js';
import LoginPage from './pages/LoginPage.js';
import LibraryPage from './pages/LibraryPage.js';
import DetailsPage from './pages/DetailsPage.js';
import PersonPage from './pages/PersonPage.js'; // Import
import SearchPage from './pages/SearchPage.js';
import SettingsPage from './pages/SettingsPage.js';
import FavoritesPage from './pages/FavoritesPage.js';
// import SeasonPage from './pages/SeasonPage.js'; // Deprecated

import { router } from './core/Router.js';

// Register Routes
router.register('/login', LoginPage);
router.register('/home', HomePage);
router.register('/library/:id', LibraryPage);
router.register('/details/:id', DetailsPage);
router.register('/person/:id', PersonPage); // Register
router.register('/search', SearchPage);
router.register('/settings', SettingsPage);
router.register('/favorites', FavoritesPage);
// Seasons now reuse DetailsPage
router.register('/series/:id/season/:seasonId', {
    init: (params) => {
        router.navigate(`/details/${params.seasonId}`, { replace: true });
    }
});
router.register('/', {
    init: () => {
        // Redirect logic handled in Auth check usually, or here
        router.navigate('/home', { replace: true });
    }
});

/**
 * Bootstrap the application
 */
async function bootstrap() {
    // Init Debug Mode
    // Read settings from storage (set by SettingsPage)
    // Default to false if not set
    const DEBUG_LOGS = localStorage.getItem('debug_logs_enabled') === 'true';
    const DEBUG_OVERLAY = localStorage.getItem('debug_overlay_enabled') === 'true';
    const DEBUG_WIDTH = localStorage.getItem('debug_width') || 'small';
    const DEBUG_HEIGHT = localStorage.getItem('debug_height') || 'small';
    const DEBUG_POSITION = localStorage.getItem('debug_position') || 'bottom-right';

    debugOverlay.init(DEBUG_LOGS, DEBUG_OVERLAY, DEBUG_WIDTH, DEBUG_HEIGHT, DEBUG_POSITION);

    log.info('Starting...');

    // Initialize Tizen adapter first
    tizenAdapter.init();

    // Initialize layout manager
    layoutManager.init();

    // Try to restore auth session
    await auth.init();

    // Setup exit handler
    eventBus.on('app:exitRequested', () => {
        // In a real app, show confirmation dialog first
        tizenAdapter.exit();
    });

    // Initialize the app
    app.init({
        container: '#app'
    });

    log.info('Bootstrap complete');
}

// Wait for DOM ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
} else {
    bootstrap();
}
