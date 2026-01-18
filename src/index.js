/**
 * ============================================================================
 * FastFin Tizen - Application Entry Point
 * ============================================================================
 * Main entry point that bootstraps the application.
 * ============================================================================
 */

// Import core modules
import { app } from './core/App.js';
import { tizenAdapter } from './tizen/TizenAdapter.js';
import { eventBus } from './core/EventBus.js';

// Import styles
import './styles/base.css';
import './themes/classic/dark.css';

/**
 * Bootstrap the application
 */
function bootstrap() {
    console.log('FastFin: Starting...');

    // Initialize Tizen adapter first
    tizenAdapter.init();

    // Setup exit handler
    eventBus.on('app:exitRequested', () => {
        // In a real app, show confirmation dialog first
        tizenAdapter.exit();
    });

    // Initialize the app
    app.init({
        container: '#app'
    });

    console.log('FastFin: Bootstrap complete');
}

// Wait for DOM ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
} else {
    bootstrap();
}
