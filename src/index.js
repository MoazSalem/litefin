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
import './styles/settings.css';
import './styles/season.css';
import './styles/offline.css';
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

    log.info('Bootstrap entry complete');
}

// Wait for DOM ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
} else {
    bootstrap();
}
