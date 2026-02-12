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
import { api } from '../api/ApiClient.js';
import { auth } from '../api/index.js';
import { webSocketHandler } from '../api/WebSocketHandler.js';
import { tizenAdapter } from '../tizen/TizenAdapter.js';
import { layoutManager } from '../ui/LayoutManager.js';

// Page imports (static to support Tizen 4's Chromium 56)
import LoginPage from '../pages/LoginPage.js';
import HomePage from '../pages/HomePage.js';
import LibraryPage from '../pages/LibraryPage.js';
import DetailsPage from '../pages/DetailsPage.js';
import PersonPage from '../pages/PersonPage.js';
import SearchPage from '../pages/SearchPage.js';
import SettingsPage from '../pages/SettingsPage.js';
import FavoritesPage from '../pages/FavoritesPage.js';
import OfflinePage from '../pages/OfflinePage.js';
import PlayerPage from '../pages/PlayerPage.js';
import Sidebar from '../components/Sidebar.js';

import { logger } from '../utils/Logger.js';
import { debugOverlay } from '../ui/DebugOverlay.js';

const log = logger.create('App');

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
            log.warn('App already initialized');
            return;
        }

        // 1. Initialize Tizen adapter (hardware/keys)
        tizenAdapter.init();

        // 2. Initialize Debug Overlay (loads state from localStorage)
        const DEBUG_LOGS = localStorage.getItem('debug_logs_enabled') === 'true';
        const DEBUG_OVERLAY = localStorage.getItem('debug_overlay_enabled') === 'true';
        const DEBUG_WIDTH = localStorage.getItem('debug_width') || 'small';
        const DEBUG_HEIGHT = localStorage.getItem('debug_height') || 'small';
        const DEBUG_POSITION = localStorage.getItem('debug_position') || 'bottom-right';

        debugOverlay.init(DEBUG_LOGS, DEBUG_OVERLAY, DEBUG_WIDTH, DEBUG_HEIGHT, DEBUG_POSITION);

        log.info('Initializing Litefin...');

        // 3. Initialize layout manager
        layoutManager.init();

        // 4. Try to restore auth session
        await auth.init();

        // Get container element
        if (typeof options.container === 'string') {
            this.container = document.querySelector(options.container);
        } else {
            this.container = options.container || document.getElementById('app');
        }

        if (!this.container) {
            log.error('Container element not found');
            return;
        }

        // Initialize state with defaults
        this._initializeState();

        // Setup global event handlers
        this._setupEventHandlers();

        // ================================================================
        // LAYOUT SETUP
        // ================================================================
        // Create Sidebar Container and Page Container if they don't exist
        // This splits the view into [Sidebar | Page]

        // 1. Check if we need to restructure the DOM
        if (!document.getElementById('sidebar-container')) {
            this.container.innerHTML = `
                <div id="sidebar-container"></div>
                <div id="page-container" class="page-container"></div>
            `;
        }

        // 2. Initialize Sidebar (Static import used for Tizen 4 compatibility)
        this.sidebar = new Sidebar();
        this.sidebar.mount(document.getElementById('sidebar-container'));

        // Register routes
        this._registerRoutes();

        // Initialize router (will navigate to current hash or default)
        router.init();

        // 3. Initial Sidebar visibility check
        this._updateSidebarVisibility(router.getCurrentPath());

        this._initialized = true;

        log.info('App initialized successfully');
        eventBus.emit('app:ready');
    }

    /**
     * Update sidebar visibility based on current path
     * @param {string} path 
     * @private
     */
    _updateSidebarVisibility(path) {
        if (!this.sidebar) return;

        // Routes that should NOT show the sidebar
        const fullScreenRoutes = ['/login', '/offline'];
        const isFullScreen = fullScreenRoutes.includes(path) || path.startsWith('/player');

        if (isFullScreen) {
            document.body.classList.add('no-sidebar');
            this.sidebar.setMode('hidden');
        } else {
            document.body.classList.remove('no-sidebar');
            this.sidebar.setMode('visible');
        }
    }

    /**
     * Initialize default application state
     * NOTE: Does NOT overwrite auth state - that's handled by auth.init() before this runs
     * @private
     */
    _initializeState() {
        // App settings
        state.set('app:layout', 'classic'); // 'classic' or 'modern'
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

        log.debug('App state initialized');
    }

    /**
     * Setup global event handlers
     * @private
     */
    _setupEventHandlers() {
        // Handle back button / return key
        eventBus.on('key:back', () => {
            const currentPage = router.getCurrentPage();

            // 1. Try page-specific back handler
            if (currentPage && typeof currentPage.onBack === 'function') {
                const handled = currentPage.onBack();
                if (handled === true) {
                    log.debug('Back event handled by current page');
                    return;
                }
            }

            // 2. Fallback to router history
            if (!router.back()) {
                // No history - show exit confirmation or exit app
                eventBus.emit('app:exitRequested');
            }
        });

        // Handle app visibility changes
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                // App going to background - on Tizen this may mean app is closing
                log.debug('App hidden (background)');
                eventBus.emit('app:hidden');
                // Also emit beforeExit so active players can report stopped
                eventBus.emit('app:beforeExit');
                // Close WebSocket - user goes offline on server dashboard
                api.closeWebSocket();
            } else {
                log.debug('App visible (foreground)');
                eventBus.emit('app:visible');
                // Reopen WebSocket when app becomes visible again
                // This makes user appear online again without re-login
                if (state.get('user:authenticated')) {
                    api.openWebSocket();
                }
            }
        });

        // Handle app close (browser mode)
        window.addEventListener('beforeunload', () => {
            log.debug('App beforeunload event triggered');
            eventBus.emit('app:beforeExit');
            // Close WebSocket - user goes offline
            api.closeWebSocket();
        });

        // Toggle sidebar visibility based on route
        eventBus.on('router:navigate', ({ path }) => {
            log.debug(`Router navigated to: ${path}`);
            this._updateSidebarVisibility(path);
        });

        // Handle logout / Session Expiry
        eventBus.on('auth:logout', () => {
            log.info('User logged out - resetting to login page');
            router.reset('/login');
        });

        eventBus.on('auth:expired', () => {
            log.warn('Session expired - resetting to login page');
            router.reset('/login');
        });

        // Handle application exit
        eventBus.on('app:exitRequested', () => {
            log.info('Exit requested - closing application');
            // Ensure session is reported as ended if possible
            this._endSessionOnServer();
            tizenAdapter.exit();
        });

        // ================================================================
        // PLAYER EVENTS
        // ================================================================
        // Handle playback requests from any page (DetailsPage, HomePage, etc.)
        eventBus.on('player:play', ({ item, resume, audioStreamIndex, subtitleStreamIndex }) => {
            log.info('Playback requested for item:', item?.Name, 'ID:', item?.Id);

            if (!item?.Id) {
                log.error('Cannot play - no item ID provided for playback request');
                return;
            }

            // Store track selection in state for PlayerPage to consume
            if (audioStreamIndex !== undefined) {
                state.set('player:initialAudioIndex', audioStreamIndex);
                log.debug(`Setting initial audio stream index: ${audioStreamIndex}`);
            }
            if (subtitleStreamIndex !== undefined) {
                state.set('player:initialSubtitleIndex', subtitleStreamIndex);
                log.debug(`Setting initial subtitle stream index: ${subtitleStreamIndex}`);
            }

            // Navigate to player page with item ID and resume flag
            const resumeParam = resume ? 'true' : 'false';
            router.navigate(`/player/${item.Id}/${resumeParam}`);
        });

        // ================================================================
        // WebSocket Remote Control
        // ================================================================
        // Initialize handler for remote commands from Jellyfin dashboard
        webSocketHandler.init();
        log.debug('WebSocketHandler initialized for remote control');

        // Handle remote:playnow - start playback of item from server
        eventBus.on('remote:playnow', async ({ itemIds, startPositionTicks }) => {
            log.info('Remote playnow command received for item IDs:', itemIds, 'at position:', startPositionTicks);
            if (!itemIds || itemIds.length === 0) {
                log.warn('Remote playnow command received without item IDs');
                return;
            }

            try {
                // Get the first item to play
                const item = await api.getItem(itemIds[0]);
                if (item) {
                    log.debug('Remote playnow: emitting player:play event');
                    eventBus.emit('player:play', {
                        item,
                        resume: startPositionTicks > 0
                    });
                } else {
                    log.warn('Remote playnow: Item not found for ID:', itemIds[0]);
                }
            } catch (e) {
                log.error('Failed to handle remote:playnow command:', e.message || e);
            }
        });

        // Navigation commands - handle when not in player
        eventBus.on('remote:home', () => {
            log.info('Remote home command received');
            router.navigate('/home');
        });

        eventBus.on('remote:back', () => {
            router.back();
        });

        log.debug('Event handlers setup');
    }

    /**
     * End session on server when app is closing
     * Uses synchronous XHR because async may not complete before app closes
     * @private
     */
    _endSessionOnServer() {
        // Skip if not authenticated
        if (!state.get('user:authenticated')) {
            return;
        }

        const serverUrl = api._serverUrl;
        if (!serverUrl) return;

        const authHeader = api.getAuthHeader();
        if (!authHeader) return;

        log.info('Ending session on server...');

        try {
            // Use synchronous XHR - async won't complete before app exits
            const xhr = new XMLHttpRequest();
            xhr.open('POST', `${serverUrl}/Sessions/Logout`, false); // false = synchronous
            xhr.setRequestHeader('X-Emby-Authorization', authHeader);
            xhr.setRequestHeader('Content-Type', 'application/json');
            xhr.send();
            log.info('Session ended on server');
        } catch (e) {
            log.warn('Failed to end session on server:', e);
        }
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
        router.register('/library/:id/genre/:genreId', LibraryPage); // Filtered by Genre
        router.register('/library/:id/studio/:studioId', LibraryPage); // Filtered by Studio/Network
        router.register('/library/:id/year/:year', LibraryPage); // Filtered by Year
        router.register('/library/:id/person/:personId', LibraryPage); // Filtered by Person
        router.register('/library/:id/tag/:tagName', LibraryPage); // Filtered by Tag
        router.register('/details/:id', DetailsPage);
        router.register('/person/:id', PersonPage);
        router.register('/search', SearchPage);
        router.register('/favorites', FavoritesPage);
        router.register('/settings', SettingsPage);
        router.register('/offline', OfflinePage);
        router.register('/player/:id/:resume', PlayerPage); // Video player page

        // Season redirect (for backward compatibility or deep links)
        router.register('/series/:id/season/:seasonId', {
            init: (params) => {
                router.navigate(`/details/${params.seasonId}`, { replace: true });
            }
        });

        // Default route - check auth and redirect appropriately
        router.register('/', {
            init: () => {
                const isOffline = state.get('server:offline');
                const isAuthenticated = state.get('user:authenticated');

                if (isOffline) {
                    // Saved session exists but server is unreachable
                    log.info('Initial route: Server is offline, navigating to OfflinePage');
                    router.navigate('/offline', { replace: true });
                } else if (isAuthenticated) {
                    log.info('Initial route: Authenticated, navigating to HomePage');
                    router.navigate('/home', { replace: true });
                } else {
                    log.info('Initial route: No session, navigating to LoginPage');
                    router.navigate('/login', { replace: true });
                }
            }
        });

        log.debug('Routes registered');
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
