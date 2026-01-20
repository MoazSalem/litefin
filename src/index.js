/**
 * ============================================================================
 * LiteFin Tizen - Application Entry Point
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

// Import styles
import './styles/base.css';
import './styles/pages.css';
import './themes/classic/index.js';  // All classic themes

/**
 * Bootstrap the application
 */
async function bootstrap() {
    // Init Debug Mode
    // Set to 'false' to suppress all logs and hide overlay
    // Set to 'true' to enable overlay and console logs
    const DEBUG_MODE = false;
    debugOverlay.init(DEBUG_MODE);

    console.log('LiteFin: Starting...');

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

    console.log('LiteFin: Bootstrap complete');
}

// Wait for DOM ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
} else {
    bootstrap();
}
