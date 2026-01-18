/**
 * ============================================================================
 * FastFin Tizen - App Controller
 * ============================================================================
 * Main application controller that bootstraps the app, manages global state,
 * and coordinates between core systems (Router, State, Events).
 * ============================================================================
 */

import { eventBus } from './EventBus.js';
import { state } from './StateManager.js';
import { router } from './Router.js';

class App {
    constructor() {
        // App initialization state
        this._initialized = false;

        // Reference to main content container
        this.container = null;
    }

    /**
     * Initialize the application
     * @param {Object} options - Initialization options
     * @param {HTMLElement|string} options.container - Main content container
     */
    async init(options = {}) {
        if (this._initialized) {
            console.warn('App: Already initialized');
            return;
        }

        console.log('App: Initializing FastFin...');

        // Get container element
        if (typeof options.container === 'string') {
            this.container = document.querySelector(options.container);
        } else {
            this.container = options.container || document.getElementById('app');
        }

        if (!this.container) {
            console.error('App: Container element not found');
            return;
        }

        // Initialize state with defaults
        this._initializeState();

        // Setup global event handlers
        this._setupEventHandlers();

        // Register routes
        this._registerRoutes();

        // Initialize router (will navigate to current hash or default)
        router.init();

        this._initialized = true;

        console.log('App: Initialized successfully');
        eventBus.emit('app:ready');
    }

    /**
     * Initialize default application state
     * @private
     */
    _initializeState() {
        // App settings
        state.set('app:layout', 'classic');  // 'classic' or 'modern'
        state.set('app:theme', 'dark');

        // User state
        state.set('user:authenticated', false);
        state.set('user:data', null);

        // Server state
        state.set('server:url', null);
        state.set('server:connected', false);

        console.log('App: State initialized');
    }

    /**
     * Setup global event handlers
     * @private
     */
    _setupEventHandlers() {
        // Handle back button / return key
        eventBus.on('key:back', () => {
            if (!router.back()) {
                // No history - show exit confirmation or exit app
                eventBus.emit('app:exitRequested');
            }
        });

        // Handle app visibility changes
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                eventBus.emit('app:hidden');
            } else {
                eventBus.emit('app:visible');
            }
        });

        console.log('App: Event handlers setup');
    }

    /**
     * Register application routes
     * @private
     */
    _registerRoutes() {
        // Import pages dynamically to avoid circular deps
        import('../pages/LoginPage.js').then(m => router.register('/login', m.default));
        import('../pages/HomePage.js').then(m => router.register('/home', m.default));
        import('../pages/LibraryPage.js').then(m => router.register('/library/:id', m.default));
        import('../pages/DetailsPage.js').then(m => router.register('/details/:id', m.default));
        import('../pages/SearchPage.js').then(m => router.register('/search', m.default));
        import('../pages/SettingsPage.js').then(m => router.register('/settings', m.default));

        // Default route - check auth and redirect appropriately
        router.register('/', {
            init: () => {
                if (state.get('user:authenticated')) {
                    router.navigate('/home', { replace: true });
                } else {
                    router.navigate('/login', { replace: true });
                }
            }
        });

        console.log('App: Routes registered');
    }

    /**
     * Get current layout mode
     * @returns {string} 'classic' or 'modern'
     */
    getLayout() {
        return state.get('app:layout', 'classic');
    }

    /**
     * Set layout mode
     * @param {string} layout - 'classic' or 'modern'
     */
    setLayout(layout) {
        if (layout === 'classic' || layout === 'modern') {
            state.set('app:layout', layout);
            document.documentElement.setAttribute('data-layout', layout);
            eventBus.emit('app:layoutChanged', layout);
        }
    }

    /**
     * Get current theme
     * @returns {string} Theme name
     */
    getTheme() {
        return state.get('app:theme', 'dark');
    }

    /**
     * Set theme
     * @param {string} theme - Theme name
     */
    setTheme(theme) {
        state.set('app:theme', theme);
        document.documentElement.setAttribute('data-theme', theme);
        eventBus.emit('app:themeChanged', theme);
    }
}

// Export singleton instance
export const app = new App();

// Also export class for testing
export default App;
