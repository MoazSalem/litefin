/**
 * ============================================================================
 * Litefin Tizen - App Controller
 * ============================================================================
 * Main application controller that bootstraps the app, manages global state,
 * and coordinates between core systems (Router, State, Events).
 * ============================================================================
 */

import { eventBus } from './EventBus.js';
import { state } from './StateManager.js';
import { router } from './Router.js';

// Page imports (static to support Tizen 4's Chromium 56)
import LoginPage from '../pages/LoginPage.js';
import HomePage from '../pages/HomePage.js';
import LibraryPage from '../pages/LibraryPage.js';
import DetailsPage from '../pages/DetailsPage.js';
import SearchPage from '../pages/SearchPage.js';
import SettingsPage from '../pages/SettingsPage.js';
import FavoritesPage from '../pages/FavoritesPage.js';

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

        console.log('App: Initializing Litefin...');

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

        // Register routes (must await to ensure all pages are loaded)
        this._registerRoutes();

        // Initialize router (will navigate to current hash or default)
        router.init();

        this._initialized = true;

        console.log('App: Initialized successfully');
        eventBus.emit('app:ready');
    }

    /**
     * Initialize default application state
     * NOTE: Does NOT overwrite auth state - that's handled by auth.init() before this runs
     * @private
     */
    _initializeState() {
        // App settings
        state.set('app:layout', 'classic');  // 'classic' or 'modern'
        state.set('app:theme', 'dark');

        // User state - only set defaults if not already set by auth.init()
        if (!state.has('user:authenticated')) {
            state.set('user:authenticated', false);
        }
        if (!state.has('user:data')) {
            state.set('user:data', null);
        }

        // Server state - only set defaults if not already set
        if (!state.has('server:url')) {
            state.set('server:url', null);
        }
        if (!state.has('server:connected')) {
            state.set('server:connected', false);
        }

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
        // NOTE: Using synchronous registration to avoid dynamic import() 
        // which is not supported in Tizen 4's Chromium 56 engine

        // Import pages at top of file (see imports above)
        // Register all routes
        router.register('/login', LoginPage);
        router.register('/home', HomePage);
        router.register('/library/:id', LibraryPage);
        router.register('/details/:id', DetailsPage);
        router.register('/search', SearchPage);
        router.register('/favorites', FavoritesPage);
        router.register('/settings', SettingsPage);

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
