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
import { webosAdapter } from '../webos/WebOSAdapter.js';
import { platformInfo } from '../utils/PlatformInfo.js';
import { layoutManager } from '../ui/LayoutManager.js';
import { i18n } from '../utils/i18n.js';
import { syncPlayGroupMenu } from './syncplay/SyncPlayGroupMenu.js';
import { exitDialog } from '../ui/ExitDialog.js';
import { pinDialog } from '../ui/PinDialog.js';
import { pinManager } from '../utils/PinManager.js';

// Page imports (static to support Tizen 4's Chromium 56)
import LoginPage from '../pages/LoginPage.js';
import HomePage from '../pages/HomePage.js';
import LibraryPage from '../pages/LibraryPage.js';
import DetailsPage from '../pages/DetailsPage.js';
import PersonPage from '../pages/PersonPage.js';
import SearchPage from '../pages/SearchPage.js';
import DiscoverPage from '../pages/DiscoverPage.js';
import SeerrDetailsPage from '../pages/SeerrDetailsPage.js';
import SeerrPersonPage from '../pages/SeerrPersonPage.js';
import SettingsPage from '../pages/SettingsPage.js';
import FavoritesPage from '../pages/FavoritesPage.js';
import OfflinePage from '../pages/OfflinePage.js';
import PlayerPage from '../pages/PlayerPage.js';
import ProfilesPage from '../pages/ProfilesPage.js';
import LiveTvPage from '../pages/LiveTvPage.js';
import SlideshowPage from '../pages/SlideshowPage.js';
import Sidebar from '../components/Sidebar.js';

import { logger } from '../utils/Logger.js';
import { storage } from '../utils/StorageService.js';
import { PlayerSettings } from '../utils/PlayerSettings.js';
import { debugOverlay } from '../ui/DebugOverlay.js';
import { pluginManager } from '../plugins/PluginManager.js';
import { focusManager } from '../ui/FocusManager.js';
import { imageCache } from '../utils/ImageCache.js';
import { cssVarsPolyfill } from '../utils/CssVarsPolyfill.js';
import { versionChecker } from '../utils/VersionChecker.js';
import { globalClock } from '../ui/GlobalClock.js';
import { smartHubManager } from '../tizen/SmartHubManager.js';
import { remoteButtonManager } from './RemoteButtonManager.js';
import { screensaverManager } from './ScreensaverManager.js';

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

        // 1. Initialize StorageService — loads all localStorage into memory
        // This MUST happen before any other service reads from storage
        storage.init();

        // 1.1 Clear session-scoped memory
        // Ensures track memory doesn't leak across app restarts
        storage.removeItem('session:lastAudioLang');
        storage.removeItem('session:lastAudioTitle');
        storage.removeItem('session:lastSubtitleLang');
        storage.removeItem('session:lastSubtitleTitle');

        // 1.5. Initialize Platform Detection — saves OS type (Web, Tizen, WebOS)
        platformInfo.init();

        // 1.6. Initialize platform adapters (hardware/keys)
        if (platformInfo.isWebOS) {
            webosAdapter.init();
        } else {
            tizenAdapter.init();
        }

        // 1.7. Initialize Image Cache — opens IndexedDB for homepage blob caching
        // Non-blocking: runs in background, cache degrades gracefully if unavailable
        imageCache.init().catch((err) => log.warn('ImageCache init failed:', err));

        // 2. Initialize Debug Overlay (loads state from StorageService cache)
        const DEBUG_LOGS = storage.getItem('debug_logs_enabled') === 'true';
        const DEBUG_OVERLAY = storage.getItem('debug_overlay_enabled') === 'true';
        const DEBUG_WIDTH = storage.getItem('debug_width') || 'small';
        const DEBUG_HEIGHT = storage.getItem('debug_height') || 'small';
        const DEBUG_POSITION = storage.getItem('debug_position') || 'bottom-right';

        debugOverlay.init(DEBUG_LOGS, DEBUG_OVERLAY, DEBUG_WIDTH, DEBUG_HEIGHT, DEBUG_POSITION);

        log.info('Initializing Litefin...');

        // 3. Initialize layout manager
        layoutManager.init();

        // 3.0. Initialize OSD track menu bg opacity CSS variable
        const trackMenuBgOpacity = PlayerSettings.get('osdTrackMenuBgOpacity');
        document.documentElement.style.setProperty(
            '--osd-track-menu-bg-opacity',
            (trackMenuBgOpacity / 100).toFixed(2)
        );

        // Initialize OSD background gradient opacity CSS variable
        const osdGradientOpacity = PlayerSettings.get('osdGradientOpacity');
        document.documentElement.style.setProperty(
            '--osd-gradient-opacity',
            (osdGradientOpacity / 100).toFixed(2)
        );

        // 3.1. Initialize CSS vars polyfill (no-op on Chrome 49+, active on Tizen 3.0 / Chrome 47).
        //      Must run AFTER layoutManager.init() so the data-theme attribute and theme
        //      CSS variables are already present on <html> when the polyfill scans the DOM.
        cssVarsPolyfill.init();

        // 3.5. Initialize translations + auth session in parallel
        // i18n and auth are completely independent — overlapping them saves a round-trip
        const appLanguage = storage.getItem('app_language') || 'en-us';
        const i18nPromise = i18n.init(appLanguage);
        const authPromise = auth.init();

        // 3.6. Initialize Layout Direction (RTL/LTR) — only needs appLanguage string, not i18n data
        const layoutDirection = storage.getItem('layout_direction') || 'auto';
        let isRtl = false;

        if (layoutDirection === 'auto') {
            const rtlLangs = ['ar', 'he', 'fa', 'ur', 'ur_pk', 'yi', 'dv', 'ps', 'ckb', 'ug', 'syr'];
            const langBase = appLanguage.split('-')[0].toLowerCase();
            isRtl = rtlLangs.includes(langBase) || rtlLangs.includes(appLanguage.toLowerCase());
        } else {
            isRtl = layoutDirection === 'rtl';
        }

        document.documentElement.setAttribute('dir', isRtl ? 'rtl' : 'ltr');

        // Wait for both to complete — they've been running in parallel
        await Promise.all([i18nPromise, authPromise]);

        // Load UI font if it requires server fallback font
        if (state.get('user:authenticated') && layoutManager.getUiFont() === 'fallback-font') {
            import('../utils/FontLoader.js').then((module) => {
                module.default.loadFont('fallback-font');
            });
        }

        // 4.5. Initialize Smart Hub Preview (Tizen 4+ only — gracefully no-ops on older
        //      hardware or other platforms. Must run after auth.init() so the manager can
        //      read the restored auth state and start the refresh cycle immediately.)
        if (platformInfo.isTizen) {
            smartHubManager.init();
        }

        // ====================================================================
        // 4.6. Plugin Manager Initialization
        // ====================================================================
        // Initialize Plugin Manager if a user session was successfully restored.
        // However, if we have multiple cached user profiles or the active profile
        // is protected by a PIN, the app will route the user to the "Who's Watching"
        // selection screen. In that scenario, we must defer initialization until
        // a profile is explicitly selected and unlocked, preventing unauthorized
        // background API requests from firing on the selection screen.
        if (state.get('user:authenticated')) {
            // Count of saved user profiles on the server
            const sessionCount = state.get('user:sessionCount', 0);

            // Retrieve current active user profile ID
            const activeUserId = auth.getCurrentUser()?.Id;

            // Verify if the active user profile has a local PIN lock enabled
            const activeHasPin = activeUserId ? pinManager.hasPin(activeUserId) : false;

            // Defer if user needs to go through profiles selection or PIN verification
            if (sessionCount > 1 || activeHasPin) {
                log.info('Deferring plugin manager initialization: profiles screen or PIN gate is active');
            } else {
                log.info('No profile switcher active: initializing plugin manager immediately');
                pluginManager
                    .init({
                        api,
                        focusManager,
                        toast: null // Toast component reference wired up once UI is ready
                    })
                    .catch((err) => log.error('pluginManager.init failed:', err));
            }
        }

        // Initialize ScreensaverManager (runs on all pages, handles its own auth checks)
        // Must be initialized after StorageService so it can read delay preferences.
        screensaverManager.init();

        /*
         * ============================================================================
         * PHYSICAL REMOTE BUTTON ENGINE INITIALIZATION
         * ============================================================================
         * Initialize the RemoteButtonManager engine to begin capture of Red, Green,
         * Yellow, and Blue button events propagated from Samsung Tizen / LG WebOS
         * hardware remote adapters. Requires StorageService to be fully operational
         * to load custom button functions successfully.
         * ============================================================================
         */
        remoteButtonManager.init();

        // Initialize Global Clock — persistent time display above all UI
        globalClock.init();

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

        // 1. Setup DOM structure without destroying the initial static splash screen
        if (!document.getElementById('sidebar-container')) {
            this.container.insertAdjacentHTML(
                'afterbegin',
                `
                <div id="sidebar-container">
                    <!-- Order swapped: Sidebar first, then trigger to allow CSS + sibling selector -->
                </div>
                <div id="page-container" class="page-container"></div>
            `
            );
        }

        // 2. Initialize Sidebar (Static import used for Tizen 4 compatibility).
        // Mount the sidebar first, then hide it; we need the sidebar to exist
        // for focus registration, but we'll have it be invisible until the loading sequence completes.
        this.sidebar = new Sidebar();
        this.sidebar.mount(document.getElementById('sidebar-container'));

        // Append trigger AFTER sidebar so we can use sibling selectors in CSS
        document
            .getElementById('sidebar-container')
            .insertAdjacentHTML('beforeend', '<div class="sidebar-hover-trigger"></div>');

        // Hide the sidebar at the CSS level so the GPU layer doesn't render it over the splash screen.
        // We use visibility:hidden + pointer-events:none instead of display:none so the
        // sidebar still occupies its layout space (no flicker-reflow when revealed).
        const sidebarContainer = document.getElementById('sidebar-container');
        if (sidebarContainer) {
            sidebarContainer.style.opacity = '0';
            sidebarContainer.style.pointerEvents = 'none';
        }

        // Setup global splash removal handler - this fires exactly once when the initial page
        // (HomePage, LoginPage, or OfflinePage) finishes its data loading.
        let splashHidden = false;
        eventBus.on('app:hideSplash', () => {
            // Guard against duplicate calls
            if (splashHidden) return;
            splashHidden = true;

            // Reveal the sidebar now that the content beneath is ready
            const sidebar = document.getElementById('sidebar-container');
            if (sidebar) {
                sidebar.style.opacity = '';
                sidebar.style.pointerEvents = '';
            }

            // Remove the body class that blocks duplicate page-level spinners
            document.body.classList.remove('app-splash-active');

            const splash = document.getElementById('app-splash');
            if (splash) {
                log.info('Hiding initial splash screen');
                splash.classList.add('fade-out');
                setTimeout(() => {
                    if (splash.parentNode) splash.parentNode.removeChild(splash);
                }, 400); // Matches CSS transition duration
            }

            // Trigger auto-update check (respects user settings inside)
            versionChecker.checkAtStartup();
        });

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
        // ProfilesPage is intentionally fullscreen — it IS the user switcher, so
        // showing the sidebar (which contains the active user's name) would be inconsistent.
        const fullScreenRoutes = ['/login', '/offline', '/profiles'];
        const isFullScreen =
            fullScreenRoutes.includes(path) || path.startsWith('/player') || path.startsWith('/slideshow');

        if (isFullScreen) {
            document.body.classList.add('no-sidebar');
            this.sidebar.setMode('hidden');
        } else {
            document.body.classList.remove('no-sidebar');

            // Handle Sidebar Modes (Always Hidden or Mixed)
            const sidebarMode = storage.getItem('pref:sidebarMode') || 'shown';
            if (sidebarMode === 'hidden' || (sidebarMode === 'mixed' && path.startsWith('/details'))) {
                document.body.classList.add('sidebar-mode-hidden');
            } else {
                document.body.classList.remove('sidebar-mode-hidden');
            }

            if (sidebarMode === 'collapsed') {
                document.body.classList.add('sidebar-mode-collapsed');
            } else {
                document.body.classList.remove('sidebar-mode-collapsed');
            }

            this.sidebar.setMode('visible');
        }
    }

    /**
     * Initialize default application state
     * NOTE: Does NOT overwrite auth state - that's handled by auth.init() before this runs
     * @private
     */
    _initializeState() {
        // App settings - only set defaults if not already loaded by layoutManager.init()
        if (!state.has('app:layout')) {
            state.set('app:layout', 'classic'); // 'classic' or 'modern'
        }

        // User state - only set defaults if not already set by auth.init()
        if (!state.has('user:authenticated')) {
            state.set('user:authenticated', false);
        }
        if (!state.has('user:data')) {
            state.set('user:data', null);
        }
        // Safety default — auth.init() sets this before _initializeState() is called,
        // but we guard against the edge case where a restore error prevents it from being set.
        if (!state.has('user:sessionCount')) {
            state.set('user:sessionCount', 0);
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
        // Listen for OSD track menu bg opacity changes
        eventBus.on('pref:osdTrackMenuBgOpacity', (value) => {
            document.documentElement.style.setProperty('--osd-track-menu-bg-opacity', (value / 100).toFixed(2));
            cssVarsPolyfill.update();
        });

        // Listen for OSD background gradient opacity changes
        eventBus.on('pref:osdGradientOpacity', (value) => {
            document.documentElement.style.setProperty('--osd-gradient-opacity', (value / 100).toFixed(2));
            cssVarsPolyfill.update();
        });

        // Handle back button / return key
        eventBus.on('key:back', () => {
            // 1. Check for standalone global overlays
            if (syncPlayGroupMenu && syncPlayGroupMenu.isVisible) {
                syncPlayGroupMenu.close();
                return;
            }

            if (exitDialog && exitDialog.isVisible) {
                exitDialog.close();
                return;
            }

            // PIN entry dialog — Back cancels it (aborts the gated action).
            if (pinDialog && pinDialog.isVisible) {
                pinDialog.close(true);
                return;
            }

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
                // App going to background — pause playback and save state,
                // but do NOT stop the session or report stopped. The player
                // stays alive and the server-side session remains active so
                // the user can resume when they return.
                log.debug('App hidden (background)');
                eventBus.emit('app:hidden');
                // Close WebSocket — user appears offline on server dashboard
                api.closeWebSocket();
            } else {
                log.debug('App visible (foreground)');
                eventBus.emit('app:visible');
                // Reopen WebSocket when app becomes visible again
                // This makes user appear online again without re-login
                if (state.get('user:authenticated')) {
                    api.openWebSocket();
                }

                // Force a reload of the current view to fetch fresh data
                // e.g., when the Tizen TV turns on from suspended sleep state.
                // We skip reloading if the user is in the player to avoid interrupting playback.
                const currentPath = router.getCurrentPath?.() || '';
                if (!currentPath.startsWith('/player')) {
                    router.reload();
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
            // Clear server plugin detection cache on logout (new server/user after login may differ)
            pluginManager.destroy();
            router.reset('/login');
        });

        eventBus.on('auth:expired', () => {
            log.warn('Session expired - resetting to login page');
            pluginManager.destroy();
            router.reset('/login');
        });

        /*
         * auth:switchToProfiles fires when the active user logs out but other
         * sessions are still stored (multi-user scenario). Instead of going to
         * /login, we show the "Who's Watching" profiles screen so the next
         * user can pick their profile without having to re-enter credentials.
         */
        eventBus.on('auth:switchToProfiles', () => {
            log.info('Switching to profiles screen (other sessions remain)');

            // Wrecks active plugin instances and clears server plugin detection cache
            // before redirecting to the user selection view, ensuring no background
            // plugins continue fetching endpoints during the profile select flow.
            pluginManager.destroy();

            router.reset('/profiles');
        });

        // Initialize plugin manager when user successfully logs in
        // (covers fresh logins, not session restores which are handled in init())
        eventBus.on('auth:login', () => {
            log.info('User logged in - initializing plugin manager');

            // If the UI font is fallback-font, load it now that we are authenticated
            if (layoutManager.getUiFont() === 'fallback-font') {
                import('../utils/FontLoader.js').then((module) => {
                    module.default.loadFont('fallback-font');
                });
            }

            pluginManager
                .init({
                    api,
                    focusManager,
                    toast: null // Toast wired up once UI is ready
                })
                .catch((err) => log.error('pluginManager.init (post-login) failed:', err));
        });

        // Handle application exit
        eventBus.on('app:exitRequested', () => {
            log.info('Exit requested - checking settings');

            if (storage.getItem('pref:confirmExit') === 'true') {
                log.info('Confirm exit enabled - showing prompt');
                exitDialog.show();
            } else {
                log.info('Closing application immediately');
                // We DO NOT end the session on the server here.
                // Calling /Sessions/Logout actively revokes the authentication token.
                // The dashboard Offline status is handled automatically by the WebSocket dropping.
                if (platformInfo.isWebOS) {
                    webosAdapter.exit();
                } else {
                    tizenAdapter.exit();
                }
            }
        });

        // ================================================================
        // PLAYER EVENTS
        // ================================================================
        // Handle playback requests from any page (DetailsPage, HomePage, etc.)
        eventBus.on(
            'player:play',
            async ({
                item,
                resume,
                mediaSourceId,
                audioStreamIndex,
                subtitleStreamIndex,
                backdropUrl,
                fromSlideshow,
                fromBrowse,
                ghostMode
            }) => {
                log.info('Playback requested for item:', item?.Name, 'ID:', item?.Id);

                let itemToPlay = item;

                // If the requested item is a Folder/Container for audio (e.g., MusicAlbum, BoxSet without movies/episodes),
                // the API cannot play it directly. We must resolve it to the first playable audio track.
                if (item && ['MusicAlbum', 'MusicArtist', 'MusicGenre', 'Artist', 'Person'].includes(item.Type)) {
                    try {
                        const tracks = await api.getItems({
                            ParentId: item.Id,
                            Recursive: true,
                            IncludeItemTypes: 'Audio',
                            Limit: 1,
                            SortBy: 'SortName',
                            SortOrder: 'Ascending'
                        });
                        if (tracks.Items && tracks.Items.length > 0) {
                            itemToPlay = tracks.Items[0];
                            itemToPlay.contextType = 'music';
                            itemToPlay.contextId = item.Id;
                            log.info('Resolved music container to first track:', itemToPlay.Name);
                        } else {
                            log.warn('No playable audio tracks found in container:', item.Id);
                            return;
                        }
                    } catch (e) {
                        log.error('Failed to resolve audio container tracks:', e);
                        return;
                    }
                }

                // Playlist items are containers with no direct MediaSource.
                // Resolve to the first item and tag context so PlayQueue builds the full list.
                if (item && item.Type === 'Playlist' && itemToPlay === item) {
                    try {
                        const result = await api.getPlaylistItems(item.Id, { Limit: 1 });
                        if (result.Items && result.Items.length > 0) {
                            itemToPlay = result.Items[0];
                            itemToPlay.contextType = 'playlist';
                            itemToPlay.contextId = item.Id;
                            log.info('Resolved Playlist to first item:', itemToPlay.Name);
                        } else {
                            log.warn('Playlist is empty:', item.Id);
                            return;
                        }
                    } catch (e) {
                        log.error('Failed to resolve playlist:', e);
                        return;
                    }
                }

                // Store playback context for play queue building (e.g. 'boxset', 'music')
                // IMPORTANT: Always set these (even to null) to avoid context leaking from previous plays
                state.set('player:contextType', itemToPlay?.contextType || null);
                state.set('player:contextId', itemToPlay?.contextId || null);
                // For BoxSet playback, forward the sort order so PlayQueue builds the
                // full queue in the same order the collection grid is displayed.
                state.set('player:boxsetSortBy', itemToPlay?.boxsetSortBy || null);

                // Store explicit trailer metadata overrides since the player re-fetches the item
                // and loses the parent context injected by DetailsPage.
                if (itemToPlay && itemToPlay.Type === 'Trailer') {
                    state.set('player:overrideName', itemToPlay.Name || null);
                    state.set(
                        'player:overrideYear',
                        itemToPlay.ProductionYear !== undefined ? itemToPlay.ProductionYear : 'NONE'
                    );
                } else {
                    state.set('player:overrideName', null);
                    state.set('player:overrideYear', null);
                }

                // Store backdrop URL for loading screen transition
                state.set('player:backdropUrl', backdropUrl || null);

                if (!itemToPlay?.Id) {
                    log.error('Cannot play - no item ID provided for playback request');
                    return;
                }

                // Store track selection in state for PlayerPage to consume
                if (mediaSourceId !== undefined) {
                    state.set('player:initialMediaSourceId', mediaSourceId);
                    log.debug(`Setting initial media source ID: ${mediaSourceId}`);
                }
                if (audioStreamIndex !== undefined) {
                    state.set('player:initialAudioIndex', audioStreamIndex);
                    log.debug(`Setting initial audio stream index: ${audioStreamIndex}`);
                }
                if (subtitleStreamIndex !== undefined) {
                    state.set('player:initialSubtitleIndex', subtitleStreamIndex);
                    log.debug(`Setting initial subtitle stream index: ${subtitleStreamIndex}`);
                }

                // Navigate to player page with item ID and resume flag.
                // fromSlideshow and fromBrowse (the Home/Library Play key) both
                // mark launchers that should PUSH the player, so Back/Stop returns
                // to the originating page (see replace flag below).
                const resumeParam = resume ? 'true' : 'false';
                const queryParts = [];
                if (fromSlideshow) queryParts.push('fromSlideshow=true');
                if (fromBrowse) queryParts.push('fromBrowse=true');
                if (ghostMode) queryParts.push('ghostMode=true');

                // Determine referrer context to handle exit routing cleanly.
                // If we are playing from a details screen or the Live TV guide,
                // we want to ensure we navigate back to the correct view on exit.
                const currentPath = router.getCurrentPath?.() || '';
                if (currentPath.startsWith('/details/')) {
                    queryParts.push('fromDetails=true');
                } else if (currentPath.startsWith('/livetv')) {
                    queryParts.push('fromGuide=true');
                }

                const queryParam = queryParts.length > 0 ? `?${queryParts.join('&')}` : '';

                // SyncPlay Override: if we are in a SyncPlay group, we do NOT launch the player locally.
                // Instead, we command the server to start playback of the new item. The server
                // will broadcast a PlayQueue update to everyone (including us), which triggers the actual navigation.
                if (window.__syncPlayManager && window.__syncPlayManager.isEnabled) {
                    log.info('SyncPlay is active. Sending SetNewQueue command instead of local launch.');
                    try {
                        let startPosition = 0;
                        if (resume && itemToPlay.UserData?.PlaybackPositionTicks) {
                            startPosition = itemToPlay.UserData.PlaybackPositionTicks;
                        }
                        await api.post('/SyncPlay/SetNewQueue', {
                            PlayingQueue: [itemToPlay.Id],
                            PlayingItemPosition: 0,
                            StartPositionTicks: startPosition
                        });
                    } catch (err) {
                        log.error('Failed to send SetNewQueue to SyncPlay:', err);
                    }
                    return;
                }

                // If we came from a slideshow, a browse-page Play key, or the Live TV guide,
                // we PUSH the player so we can go BACK to the originating page exactly where
                // we left off. The Live TV case is critical: replacing /livetv in history
                // destroys the saved tab, EPG scroll position, and focused program, so
                // pressing Back from the player lands the user on a blank suggestions tab
                // with no focus (stuck). Pushing the player keeps /livetv alive in history.
                //
                // For DetailsPage launches we still REPLACE to prevent history bloat.
                //
                // Standard web exception:
                // We disable this optimization on standard web browsers to prevent breaking
                // the browser's native back button behavior and page reload flow.
                const isFromLiveTv = currentPath.startsWith('/livetv');
                const shouldReplace = !fromSlideshow && !fromBrowse && !isFromLiveTv && !platformInfo.isWeb;

                router.navigate(`/player/${itemToPlay.Id}/${resumeParam}${queryParam}`, {
                    replace: shouldReplace
                });
            }
        );

        // ================================================================
        // WebSocket Remote Control
        // ================================================================
        // Initialize handler for remote commands from Jellyfin dashboard
        webSocketHandler.init();
        log.debug('WebSocketHandler initialized for remote control');

        // Handle remote:playnow - start playback of item from server
        //
        // The Jellyfin server sends this for two distinct scenarios:
        //   1. Plain "start playing this item" — typical remote control play
        //   2. Queue manipulation (reorder / remove / jump-to-item) sent while
        //      we are already playing.  In that case the server sends the FULL
        //      new ordered item list plus StartIndex indicating the active slot.
        //
        // We route case (2) directly to PlayerPage via remote:queueupdate so it
        // can rebuild PlayQueue in-place without a full page navigation.
        eventBus.on('remote:playnow', async ({ itemIds, startIndex, startPositionTicks }) => {
            log.info(
                'Remote playnow:',
                itemIds?.length,
                'items, startIndex:',
                startIndex,
                'position:',
                startPositionTicks
            );

            if (!itemIds || itemIds.length === 0) {
                log.warn('Remote playnow received without item IDs — ignoring');
                return;
            }

            // ----------------------------------------------------------------
            // Case A: Player is already active → in-place queue update.
            // We can detect this by checking if the current route is /player/*.
            // PlayerPage will handle fetching items and rebuilding the queue.
            // ----------------------------------------------------------------
            const currentPath = router.getCurrentPath?.() || '';
            if (currentPath.startsWith('/player')) {
                log.info('Remote playnow: player active — emitting remote:queueupdate');
                eventBus.emit('remote:queueupdate', {
                    itemIds,
                    startIndex: startIndex || 0,
                    startPositionTicks: startPositionTicks || 0
                });
                return;
            }

            // ----------------------------------------------------------------
            // Case B: No player running — fetch the target item and navigate.
            // Use startIndex (default 0) to pick the correct starting item.
            // ----------------------------------------------------------------
            const targetId = itemIds[startIndex || 0] || itemIds[0];

            try {
                const item = await api.getItem(targetId);
                if (item) {
                    log.debug('Remote playnow: navigating to player for item', item.Name);
                    eventBus.emit('player:play', {
                        item,
                        resume: startPositionTicks > 0
                    });
                } else {
                    log.warn('Remote playnow: Item not found for ID:', targetId);
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
     * Obsolete: Do not call this method.
     * Ending the session via /Sessions/Logout permanently revokes the user's access token,
     * which causes a 401 Unauthorized error on the next launch.
     * @private
     */
    _endSessionOnServer() {
        // Obsolete - intentionally empty
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
        router.register('/profiles', ProfilesPage);
        router.register('/home', HomePage);
        router.register('/library/:id', LibraryPage);
        router.register('/library/:id/genre/:genreId', LibraryPage); // Filtered by Genre
        router.register('/library/:id/studio/:studioId', LibraryPage); // Filtered by Studio/Network
        router.register('/library/:id/year/:year', LibraryPage); // Filtered by Year
        router.register('/library/:id/person/:personId', LibraryPage); // Filtered by Person
        router.register('/library/:id/tag/:tagName', LibraryPage); // Filtered by Tag
        router.register('/details/:id', DetailsPage);
        router.register('/seerr/person/:id', SeerrPersonPage);
        router.register('/seerr/:mediaType/:tmdbId', SeerrDetailsPage);
        router.register('/person/:id', PersonPage);
        router.register('/search', SearchPage);
        router.register('/discover', DiscoverPage);
        router.register('/favorites', FavoritesPage);
        router.register('/settings', SettingsPage);
        router.register('/livetv', LiveTvPage);
        router.register('/offline', OfflinePage);
        router.register('/slideshow/:photoId', SlideshowPage);
        router.register('/player/:id/:resume', PlayerPage); // Video player page

        // Season redirect (for backward compatibility or deep links)
        router.register('/series/:id/season/:seasonId', {
            init: (params) => {
                router.navigate(`/details/${params.seasonId}`, { replace: true });
            }
        });

        // Default route — check auth and redirect appropriately.
        // With multi-user support we now consider the number of stored sessions:
        //   • Offline          → /offline
        //   • ≥2 sessions      → /profiles ("Who's Watching" prompt)
        //   • 1 session, valid → /home (same auto-login as before)
        //   • 0 sessions       → /login
        router.register('/', {
            init: () => {
                const isOffline = state.get('server:offline');
                const isAuthenticated = state.get('user:authenticated');
                const sessionCount = state.get('user:sessionCount', 0);
                // If the restored profile is PIN-locked, never silently auto-resume
                // it — force the profile picker so ProfilesPage._switchToUser runs
                // the PIN gate before any content is shown.
                const activeUserId = auth.getCurrentUser()?.Id;
                const activeHasPin = activeUserId ? pinManager.hasPin(activeUserId) : false;

                const skipProfilesOnce = storage.getItem('litefin:skip_profiles_once') === 'true';
                if (skipProfilesOnce) {
                    storage.removeItem('litefin:skip_profiles_once');
                    storage.flush();
                }

                /*
                 * Check user preference: "Remember Last Active User".
                 * When enabled, the app skips the profile picker on launch and boots directly
                 * into the last active session (unless protected by a local PIN).
                 * Default: disabled (false).
                 */
                const rememberLastUser = storage.getItem('pref:rememberLastActiveUser') === 'true';

                if (isOffline) {
                    // Saved session exists but server is unreachable
                    log.info('Initial route: Server is offline, navigating to OfflinePage');
                    router.navigate('/offline', { replace: true });
                } else if (isAuthenticated && ((sessionCount > 1 && !rememberLastUser) || activeHasPin) && !skipProfilesOnce) {
                    // Multiple users stored (and remember last user is disabled), or the restored profile is PIN-locked —
                    // make them pick a profile (which enforces any PIN).
                    log.info(
                        `Initial route: navigating to ProfilesPage (sessions=${sessionCount}, pinLocked=${activeHasPin}, rememberLastUser=${rememberLastUser})`
                    );
                    router.navigate('/profiles', { replace: true });
                } else if (isAuthenticated) {
                    // Single user, no PIN, rememberLastUser active, or skipped once — skip the profiles screen and go straight home
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
        return layoutManager.getLayout();
    }

    /**
     * Set layout mode
     * @param {string} layout - 'classic' or 'modern'
     */
    setLayout(layout) {
        layoutManager.setLayout(layout);
    }
}

// Export singleton instance
export const app = new App();

// Also export class for testing
export default App;
