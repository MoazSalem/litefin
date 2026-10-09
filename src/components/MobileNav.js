/**
 * ============================================================================
 * Litefin - Mobile Navigation Component
 * ============================================================================
 * Responsive navigation system specifically engineered for mobile portrait
 * viewports on Android and touch-enabled devices.
 *
 * Provides:
 * - Dedicated Top Bar: Brand branding, search launcher, and quick user switch
 * - Dedicated Bottom Navigation Bar: Core high-frequency navigation destinations
 *   (Home, Discover [conditional], Favorites, Libraries, Settings, and More)
 * - Modal Action Dialogs: Lightweight flat overlays for secondary destinations
 *   and quick-access library selection without relying on desktop sidebars.
 *
 * Design constraints:
 * - Pure flat aesthetic: Zero blur filters, zero box-shadows, crisp contrast
 * - High accessibility: Large responsive touch targets and clear active states
 * - Robust hardware navigation: Intercepts back keys to dismiss overlays cleanly
 * ============================================================================
 */

import Component from '../core/Component.js';
import { api, auth } from '../api/index.js';
import { router } from '../core/Router.js';
import { eventBus } from '../core/EventBus.js';
import { logger } from '../utils/Logger.js';
import { i18n } from '../utils/i18n.js';
import { syncPlayGroupMenu } from '../core/syncplay/SyncPlayGroupMenu.js';
import { sidebarIcons, getLibraryIcon } from '../utils/Icons.js';
import { seerr } from '../api/seerrClient.js';

const log = logger.create('MobileNav');

export class MobileNav extends Component {
    /**
     * Initializes the mobile navigation component instance.
     * Sets up internal tracking for route, dialog state, libraries, and auth.
     * @param {Object} [options] - Component mounting options
     */
    constructor(options = {}) {
        super(options);

        // Active navigation route path cache
        this._currentPath = '';

        // Tracks Seerr backend integration availability
        this._seerrAvailable = false;

        // Tracks active SyncPlay session state
        this._syncPlayActive = false;

        // Cached list of user media libraries loaded from server
        this._libraries = [];

        // Visibility states for modal dialog sheets
        this._moreDialogOpen = false;
        this._librariesDialogOpen = false;

        // Track whether overall navigation should be hidden (fullscreen routes)
        this._isFullScreen = false;

        // Bound event handler references for clean removal
        this._boundHandlers = {};
    }

    /**
     * Evaluates whether the current viewport orientation and device profile
     * matches the mobile portrait layout criteria.
     * @returns {boolean} True if running in mobile portrait mode
     */
    isPortraitMode() {
        if (typeof document === 'undefined') return false;
        
        // Priority 1: Direct portrait marker attribute applied by display scaler
        const hasPortraitAttr = document.documentElement.hasAttribute('data-litefin-portrait');
        if (hasPortraitAttr) return true;

        // Priority 2: Mobile/Android touch devices in vertical orientation
        const isVertical = window.innerHeight > window.innerWidth;
        const isTouchOrAndroid =
            document.documentElement.hasAttribute('data-litefin-touch') ||
            document.documentElement.hasAttribute('data-litefin-scaled') ||
            document.documentElement.getAttribute('data-platform') === 'android';

        return isVertical && isTouchOrAndroid;
    }

    /**
     * Generates HTML markup for the mobile top bar, bottom navbar, and overlay sheets.
     * @returns {string} Rendered markup
     */
    render() {
        return `
            <div class="mobile-nav-root" id="mobile-nav-root">
                <!-- ========================================================= -->
                <!-- Mobile Top Navigation Bar                                 -->
                <!-- ========================================================= -->
                <header class="mobile-topbar" id="mobile-topbar">
                    <div class="mobile-topbar-left" id="mobile-topbar-logo" role="button" tabindex="0">
                        <div class="mobile-topbar-logo-icon">
                            <img src="assets/icon-130.png" class="mobile-topbar-logo-img" alt="Litefin" />
                        </div>
                        <span class="mobile-topbar-brand">Litefin</span>
                    </div>

                    <div class="mobile-topbar-right">
                        <!-- Live Digital Clock directly to the left of the search icon -->
                        <div class="mobile-topbar-clock" id="mobile-topbar-clock">
                            ${this._getFormattedTime()}
                        </div>

                        <!-- Search Shortcut Launcher -->
                        <button class="mobile-topbar-btn" id="mobile-topbar-search" aria-label="Search" tabindex="0">
                            <div class="mobile-topbar-icon-wrap">
                                ${sidebarIcons.search}
                            </div>
                        </button>

                        <!-- User Profile & Account Switcher -->
                        <button class="mobile-topbar-btn mobile-topbar-user" id="mobile-topbar-user" aria-label="Switch User" tabindex="0">
                            <div class="mobile-topbar-avatar" id="mobile-topbar-avatar-container">
                                ${this._renderUserAvatar()}
                            </div>
                        </button>
                    </div>
                </header>

                <!-- ========================================================= -->
                <!-- Mobile Bottom Navigation Bar                              -->
                <!-- ========================================================= -->
                <nav class="mobile-navbar" id="mobile-navbar">
                    <!-- Home Tab -->
                    <button class="mobile-nav-item active" id="mobile-nav-home" data-path="/home" tabindex="0">
                        <div class="mobile-nav-icon">
                            ${sidebarIcons.home}
                        </div>
                        <span class="mobile-nav-label" data-i18n="Home">${i18n.t('Home') || 'Home'}</span>
                    </button>

                    <!-- Discover Tab (Conditionally shown if Seerr is detected) -->
                    <button class="mobile-nav-item" id="mobile-nav-discover" data-path="/discover" style="display: none;" tabindex="0">
                        <div class="mobile-nav-icon">
                            ${sidebarIcons.discover}
                        </div>
                        <span class="mobile-nav-label" data-i18n="SeerrDiscover">${i18n.t('SeerrDiscover') || 'Discover'}</span>
                    </button>

                    <!-- Favorites Tab -->
                    <button class="mobile-nav-item" id="mobile-nav-favorites" data-path="/favorites" tabindex="0">
                        <div class="mobile-nav-icon">
                            ${sidebarIcons.favorites}
                        </div>
                        <span class="mobile-nav-label" data-i18n="Favorites">${i18n.t('Favorites') || 'Favorites'}</span>
                    </button>

                    <!-- Libraries Quick Picker Tab -->
                    <button class="mobile-nav-item" id="mobile-nav-libraries" tabindex="0">
                        <div class="mobile-nav-icon">
                            ${sidebarIcons.libraries}
                        </div>
                        <span class="mobile-nav-label" data-i18n="Libraries">${i18n.t('Libraries') || 'Libraries'}</span>
                    </button>

                    <!-- Settings Tab -->
                    <button class="mobile-nav-item" id="mobile-nav-settings" data-path="/settings" tabindex="0">
                        <div class="mobile-nav-icon">
                            ${sidebarIcons.settings}
                        </div>
                        <span class="mobile-nav-label" data-i18n="Settings">${i18n.t('Settings') || 'Settings'}</span>
                    </button>

                    <!-- More Action Menu Tab (3 Dots) -->
                    <button class="mobile-nav-item" id="mobile-nav-more" tabindex="0">
                        <div class="mobile-nav-icon">
                            <svg width="42" height="42" viewBox="0 0 24 24" fill="currentColor">
                                <circle cx="5" cy="12" r="2.2" />
                                <circle cx="12" cy="12" r="2.2" />
                                <circle cx="19" cy="12" r="2.2" />
                            </svg>
                        </div>
                        <span class="mobile-nav-label">More</span>
                    </button>
                </nav>

                <!-- ========================================================= -->
                <!-- Secondary Actions Sheet Dialog (More Menu)                -->
                <!-- ========================================================= -->
                <div class="mobile-sheet-overlay hidden" id="mobile-more-overlay">
                    <div class="mobile-sheet-backdrop" id="mobile-more-backdrop"></div>
                    <div class="mobile-sheet-panel" id="mobile-more-panel" role="dialog" aria-modal="true" aria-label="More Options">
                        <div class="mobile-sheet-handle"></div>
                        <div class="mobile-sheet-header">
                            <h3 class="mobile-sheet-title">More Options</h3>
                        </div>
                        <div class="mobile-sheet-content">
                            <!-- Random Item Launcher -->
                            <button class="mobile-sheet-item" id="mobile-more-random" tabindex="0">
                                <div class="mobile-sheet-item-icon">
                                    ${sidebarIcons.random}
                                </div>
                                <div class="mobile-sheet-item-info">
                                    <span class="mobile-sheet-item-title" data-i18n="Random">${i18n.t('Random') || 'Random'}</span>
                                    <span class="mobile-sheet-item-desc">Pick and play a surprise title</span>
                                </div>
                            </button>

                            <!-- SyncPlay Group Controls Launcher -->
                            <button class="mobile-sheet-item" id="mobile-more-syncplay" tabindex="0">
                                <div class="mobile-sheet-item-icon mobile-syncplay-icon-wrap">
                                    ${sidebarIcons.syncplay}
                                    <span class="mobile-syncplay-dot ${this._syncPlayActive ? 'active' : ''}" id="mobile-syncplay-dot"></span>
                                </div>
                                <div class="mobile-sheet-item-info">
                                    <span class="mobile-sheet-item-title">SyncPlay</span>
                                    <span class="mobile-sheet-item-desc">Watch in synchronized playback</span>
                                </div>
                            </button>

                            <!-- Live TV Launcher -->
                            <button class="mobile-sheet-item" id="mobile-more-livetv" tabindex="0">
                                <div class="mobile-sheet-item-icon">
                                    ${sidebarIcons.livetv}
                                </div>
                                <div class="mobile-sheet-item-info">
                                    <span class="mobile-sheet-item-title" data-i18n="LiveTV">${i18n.t('LiveTV') || 'Live TV'}</span>
                                    <span class="mobile-sheet-item-desc">Television guide and broadcast channels</span>
                                </div>
                            </button>
                        </div>
                        <div class="mobile-sheet-footer">
                            <button class="mobile-sheet-cancel-btn" id="mobile-more-close" tabindex="0">
                                ${i18n.t('ButtonCancel') || 'Close'}
                            </button>
                        </div>
                    </div>
                </div>

                <!-- ========================================================= -->
                <!-- Media Libraries Quick Picker Sheet Dialog                 -->
                <!-- ========================================================= -->
                <div class="mobile-sheet-overlay hidden" id="mobile-libraries-overlay">
                    <div class="mobile-sheet-backdrop" id="mobile-libraries-backdrop"></div>
                    <div class="mobile-sheet-panel" id="mobile-libraries-panel" role="dialog" aria-modal="true" aria-label="Libraries">
                        <div class="mobile-sheet-handle"></div>
                        <div class="mobile-sheet-header">
                            <h3 class="mobile-sheet-title" data-i18n="Libraries">${i18n.t('Libraries') || 'Libraries'}</h3>
                        </div>
                        <div class="mobile-sheet-content">
                            <div class="mobile-libraries-grid" id="mobile-libraries-grid">
                                <!-- Dynamically populated by _renderLibrariesList() -->
                            </div>
                        </div>
                        <div class="mobile-sheet-footer">
                            <button class="mobile-sheet-cancel-btn" id="mobile-libraries-close" tabindex="0">
                                ${i18n.t('ButtonCancel') || 'Close'}
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    /**
     * Lifecycle callback invoked after DOM elements are attached.
     * Registers user interaction listeners and begins asynchronous data hydration.
     */
    onMounted() {
        this._bindEvents();
        this._bindGlobalEvents();
        
        // Initial path inspection
        this._currentPath = router.getCurrentPath?.() || '';
        this._updateActiveTabs();
        this._updateVisibility();

        // Hydrate asynchronous data
        this._loadLibraries();
        this._probeSeerr();
        this._updateUserAvatar();
        this._startClockTimer();

        // Translate localized elements
        i18n.translateDOM(this.el);
    }

    /**
     * Binds click and touch event listeners on interactive navbar and top bar items.
     * @private
     */
    _bindEvents() {
        // ── Top Bar Handlers ────────────────────────────────────────────────
        const logoBtn = this.$('#mobile-topbar-logo');
        if (logoBtn) {
            logoBtn.addEventListener('click', (e) => {
                e.preventDefault();
                // If already on homepage, perform smooth scroll to top of viewport
                if (this._currentPath === '/home' || this._currentPath === '/') {
                    const appEl = document.getElementById('app');
                    if (appEl) appEl.scrollTo({ top: 0, behavior: 'smooth' });
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                } else {
                    router.reset('/home');
                }
            });
        }

        const searchBtn = this.$('#mobile-topbar-search');
        if (searchBtn) {
            searchBtn.addEventListener('click', (e) => {
                e.preventDefault();
                router.navigate('/search');
            });
        }

        const userBtn = this.$('#mobile-topbar-user');
        if (userBtn) {
            userBtn.addEventListener('click', (e) => {
                e.preventDefault();
                // Route to Who's Watching user selection screen
                router.navigate('/profiles');
            });
        }

        // ── Bottom Navbar Navigation Tabs ───────────────────────────────────
        const homeTab = this.$('#mobile-nav-home');
        if (homeTab) {
            homeTab.addEventListener('click', (e) => {
                e.preventDefault();
                router.reset('/home');
            });
        }

        const discoverTab = this.$('#mobile-nav-discover');
        if (discoverTab) {
            discoverTab.addEventListener('click', (e) => {
                e.preventDefault();
                router.navigate('/discover');
            });
        }

        const favoritesTab = this.$('#mobile-nav-favorites');
        if (favoritesTab) {
            favoritesTab.addEventListener('click', (e) => {
                e.preventDefault();
                router.navigate('/favorites');
            });
        }

        const settingsTab = this.$('#mobile-nav-settings');
        if (settingsTab) {
            settingsTab.addEventListener('click', (e) => {
                e.preventDefault();
                router.navigate('/settings');
            });
        }

        // ── Libraries Sheet Trigger ─────────────────────────────────────────
        const librariesTab = this.$('#mobile-nav-libraries');
        if (librariesTab) {
            librariesTab.addEventListener('click', (e) => {
                e.preventDefault();
                this.toggleLibrariesDialog();
            });
        }

        // ── More Menu Sheet Trigger ─────────────────────────────────────────
        const moreTab = this.$('#mobile-nav-more');
        if (moreTab) {
            moreTab.addEventListener('click', (e) => {
                e.preventDefault();
                this.toggleMoreDialog();
            });
        }

        // ── More Sheet Inner Actions ────────────────────────────────────────
        const randomBtn = this.$('#mobile-more-random');
        if (randomBtn) {
            randomBtn.addEventListener('click', async (e) => {
                e.preventDefault();
                this.toggleMoreDialog(false);
                await this._triggerRandomItem();
            });
        }

        const syncplayBtn = this.$('#mobile-more-syncplay');
        if (syncplayBtn) {
            syncplayBtn.addEventListener('click', (e) => {
                e.preventDefault();
                this.toggleMoreDialog(false);
                syncPlayGroupMenu.open();
            });
        }

        const livetvBtn = this.$('#mobile-more-livetv');
        if (livetvBtn) {
            livetvBtn.addEventListener('click', (e) => {
                e.preventDefault();
                this.toggleMoreDialog(false);
                router.navigate('/livetv');
            });
        }

        // ── Sheet Dismissal Handlers (Backdrops & Cancel Buttons) ───────────
        const moreClose = this.$('#mobile-more-close');
        const moreBackdrop = this.$('#mobile-more-backdrop');
        if (moreClose) moreClose.addEventListener('click', () => this.toggleMoreDialog(false));
        if (moreBackdrop) moreBackdrop.addEventListener('click', () => this.toggleMoreDialog(false));

        const libsClose = this.$('#mobile-libraries-close');
        const libsBackdrop = this.$('#mobile-libraries-backdrop');
        if (libsClose) libsClose.addEventListener('click', () => this.toggleLibrariesDialog(false));
        if (libsBackdrop) libsBackdrop.addEventListener('click', () => this.toggleLibrariesDialog(false));
    }

    /**
     * Binds application-level event bus subscriptions to keep the navigation state
     * aligned with router transitions, auth state, and runtime events.
     * @private
     */
    _bindGlobalEvents() {
        // Route changes trigger active tab highlights and header visibility updates
        this._boundHandlers.onNavigate = ({ path }) => {
            this._currentPath = path || '';
            // Close any open overlays on route transition
            this.toggleMoreDialog(false);
            this.toggleLibrariesDialog(false);
            this._updateActiveTabs();
            this._updateVisibility();
        };
        eventBus.on('router:navigate', this._boundHandlers.onNavigate);

        // Viewport orientation changes from AndroidAdapter
        this._boundHandlers.onOrientationChange = () => {
            this._updateVisibility();
        };
        eventBus.on('viewport:orientationChange', this._boundHandlers.onOrientationChange);

        // Window resize listener as fallback for browser orientation shifts
        this._boundHandlers.onResize = () => {
            this._updateVisibility();
        };
        window.addEventListener('resize', this._boundHandlers.onResize, { passive: true });

        // Hardware back button interception for modal dismissals
        this._boundHandlers.onKeyBack = () => {
            if (this._moreDialogOpen) {
                this.toggleMoreDialog(false);
                return true;
            }
            if (this._librariesDialogOpen) {
                this.toggleLibrariesDialog(false);
                return true;
            }
            return false;
        };
        eventBus.on('key:back', this._boundHandlers.onKeyBack);

        // Escape key handling for external physical keyboards
        this._boundHandlers.onKeyDown = (e) => {
            if (e.key === 'Escape' || e.keyCode === 27) {
                if (this._moreDialogOpen || this._librariesDialogOpen) {
                    this.toggleMoreDialog(false);
                    this.toggleLibrariesDialog(false);
                    e.stopPropagation();
                }
            }
        };
        document.addEventListener('keydown', this._boundHandlers.onKeyDown);

        // Auth change listeners to update user avatar and refresh library items
        this._boundHandlers.onAuthChange = () => {
            this._updateUserAvatar();
            this._loadLibraries();
            this._probeSeerr();
        };
        eventBus.on('auth:login', this._boundHandlers.onAuthChange);
        eventBus.on('auth:logout', this._boundHandlers.onAuthChange);
        eventBus.on('auth:restored', this._boundHandlers.onAuthChange);

        // SyncPlay state monitoring to update live indicator dot
        this._boundHandlers.onSyncPlayEnabled = () => this._setSyncPlayActive(true);
        this._boundHandlers.onSyncPlayDisabled = () => this._setSyncPlayActive(false);
        eventBus.on('syncplay:enabled', this._boundHandlers.onSyncPlayEnabled);
        eventBus.on('syncplay:disabled', this._boundHandlers.onSyncPlayDisabled);

        // Seerr status resolution listener
        this._boundHandlers.onSeerrResolved = (status) => {
            const available = !!(status && status.configured && status.available);
            this._setSeerrAvailable(available);
        };
        eventBus.on('seerr:statusResolved', this._boundHandlers.onSeerrResolved);

        // Preference change listener for clock 12h/24h time format updates
        this._boundHandlers.onTimeFormat = () => {
            const clockEl = this.$('#mobile-topbar-clock');
            if (clockEl) clockEl.textContent = this._getFormattedTime();
        };
        eventBus.on('pref:timeFormat', this._boundHandlers.onTimeFormat);
    }

    /**
     * Unregisters all bound global listeners and tears down DOM elements.
     */
    onDestroyed() {
        if (this._boundHandlers.onNavigate) eventBus.off('router:navigate', this._boundHandlers.onNavigate);
        if (this._boundHandlers.onOrientationChange) eventBus.off('viewport:orientationChange', this._boundHandlers.onOrientationChange);
        if (this._boundHandlers.onKeyBack) eventBus.off('key:back', this._boundHandlers.onKeyBack);
        if (this._boundHandlers.onAuthChange) {
            eventBus.off('auth:login', this._boundHandlers.onAuthChange);
            eventBus.off('auth:logout', this._boundHandlers.onAuthChange);
            eventBus.off('auth:restored', this._boundHandlers.onAuthChange);
        }
        if (this._boundHandlers.onSyncPlayEnabled) eventBus.off('syncplay:enabled', this._boundHandlers.onSyncPlayEnabled);
        if (this._boundHandlers.onSyncPlayDisabled) eventBus.off('syncplay:disabled', this._boundHandlers.onSyncPlayDisabled);
        if (this._boundHandlers.onSeerrResolved) eventBus.off('seerr:statusResolved', this._boundHandlers.onSeerrResolved);
        if (this._boundHandlers.onTimeFormat) eventBus.off('pref:timeFormat', this._boundHandlers.onTimeFormat);

        if (this._clockInterval) clearInterval(this._clockInterval);
        if (this._boundHandlers.onResize) window.removeEventListener('resize', this._boundHandlers.onResize);
        if (this._boundHandlers.onKeyDown) document.removeEventListener('keydown', this._boundHandlers.onKeyDown);

        document.body.classList.remove('mobile-topbar-visible', 'mobile-navbar-visible');
    }

    /**
     * Updates visibility for the mobile top bar and bottom navbar based on
     * current routing, viewport orientation, and full-screen state.
     *
     * Visibility rules:
     * - Only active in mobile portrait mode.
     * - Bottom Navbar: Visible on all standard routes; hidden on fullscreen routes
     *   (such as video playback, slideshows, emulator, login, and profiles).
     * - Top Bar: Visible on main pages; explicitly hidden on Settings, Details,
     *   and all fullscreen routes.
     *
     * @param {string} [path] - Optional route path override
     * @param {boolean} [isFullScreen] - Optional fullscreen flag override
     */
    updateVisibility(path, isFullScreen) {
        if (path !== undefined) this._currentPath = path;
        if (isFullScreen !== undefined) this._isFullScreen = isFullScreen;
        this._updateVisibility();
    }

    /**
     * Internal implementation of visibility state updates.
     * @private
     */
    _updateVisibility() {
        const topbar = this.$('#mobile-topbar');
        const navbar = this.$('#mobile-navbar');
        if (!topbar || !navbar) return;

        const isPortrait = this.isPortraitMode();

        // Non-portrait viewports (landscape, TV, desktop) hide mobile bars entirely
        if (!isPortrait) {
            topbar.classList.add('hidden');
            navbar.classList.add('hidden');
            document.body.classList.remove('mobile-topbar-visible', 'mobile-navbar-visible');
            return;
        }

        const path = this._currentPath || '';

        // Check if current page is full-screen
        const fullScreenRoutes = ['/login', '/offline', '/profiles'];
        const isFullScreenRoute =
            this._isFullScreen ||
            fullScreenRoutes.includes(path) ||
            path.startsWith('/player') ||
            path.startsWith('/slideshow') ||
            path.startsWith('/emulator');

        // Bottom navbar is visible on all portrait pages except full-screen routes
        const showNavbar = !isFullScreenRoute;
        navbar.classList.toggle('hidden', !showNavbar);
        document.body.classList.toggle('mobile-navbar-visible', showNavbar);

        // Top bar is explicitly hidden on Settings and Details pages, as well as fullscreen routes
        const isSettings = path.startsWith('/settings');
        const isDetails = path.startsWith('/details') || path.startsWith('/seerr/');
        const showTopbar = !isFullScreenRoute && !isSettings && !isDetails;

        topbar.classList.toggle('hidden', !showTopbar);
        document.body.classList.toggle('mobile-topbar-visible', showTopbar);
    }

    /**
     * Updates active tab state highlighting based on current route.
     * @private
     */
    _updateActiveTabs() {
        const path = this._currentPath || '';
        const items = this.el.querySelectorAll('.mobile-nav-item');

        items.forEach((item) => {
            const itemPath = item.dataset.path;
            let isActive = false;

            if (item.id === 'mobile-nav-home') {
                isActive = (path === '/home' || path === '/' || path === '') && !this._moreDialogOpen && !this._librariesDialogOpen;
            } else if (item.id === 'mobile-nav-libraries') {
                isActive = path.startsWith('/library/') || this._librariesDialogOpen;
            } else if (item.id === 'mobile-nav-more') {
                isActive = this._moreDialogOpen;
            } else if (itemPath) {
                isActive = path.startsWith(itemPath) && !this._moreDialogOpen && !this._librariesDialogOpen;
            }

            item.classList.toggle('active', isActive);
        });

        // Sync active state for top bar search shortcut
        const searchBtn = this.$('#mobile-topbar-search');
        if (searchBtn) {
            searchBtn.classList.toggle('active', path === '/search');
        }
    }

    /**
     * Toggles visibility of the secondary actions "More" bottom sheet dialog.
     * @param {boolean|null} [forceState] - Optional boolean to force open/close
     */
    toggleMoreDialog(forceState = null) {
        const overlay = this.$('#mobile-more-overlay');
        if (!overlay) return;

        this._moreDialogOpen = forceState !== null ? forceState : !this._moreDialogOpen;
        overlay.classList.toggle('hidden', !this._moreDialogOpen);

        // Dismiss other open sheets if this one opens
        if (this._moreDialogOpen && this._librariesDialogOpen) {
            this.toggleLibrariesDialog(false);
        }

        this._updateActiveTabs();
    }

    /**
     * Toggles visibility of the Media Libraries quick picker bottom sheet dialog.
     * @param {boolean|null} [forceState] - Optional boolean to force open/close
     */
    toggleLibrariesDialog(forceState = null) {
        const overlay = this.$('#mobile-libraries-overlay');
        if (!overlay) return;

        this._librariesDialogOpen = forceState !== null ? forceState : !this._librariesDialogOpen;
        overlay.classList.toggle('hidden', !this._librariesDialogOpen);

        if (this._librariesDialogOpen) {
            // Re-render latest libraries in case user views changed
            this._renderLibrariesList();
            // Dismiss more dialog if active
            if (this._moreDialogOpen) {
                this.toggleMoreDialog(false);
            }
        }

        this._updateActiveTabs();
    }

    /**
     * Queries the server API for user media libraries and updates the cached list.
     * @private
     */
    async _loadLibraries() {
        if (!auth.isAuthenticated()) return;

        try {
            const views = await api.getUserViews();
            this._libraries = views.Items || [];
            this._renderLibrariesList();
        } catch (err) {
            log.warn('Failed retrieving user views for mobile navigation:', err);
        }
    }

    /**
     * Renders media library shortcut tiles into the libraries sheet modal dialog.
     * @private
     */
    _renderLibrariesList() {
        const container = this.$('#mobile-libraries-grid');
        if (!container) return;

        if (!this._libraries || this._libraries.length === 0) {
            container.innerHTML = `
                <div class="mobile-libraries-empty">
                    <span>No libraries found</span>
                </div>
            `;
            return;
        }

        let html = '';
        this._libraries.forEach((lib) => {
            const isLiveTv = lib.CollectionType === 'livetv';
            const navPath = isLiveTv ? '/livetv' : `/library/${lib.Id}`;

            // Resolve proper library iconography
            let iconCol = lib.CollectionType;
            const libNameLower = (lib.Name || '').toLowerCase();
            const isMediaCol =
                lib.CollectionType === 'homevideos' ||
                lib.CollectionType === 'photos' ||
                lib.CollectionType === 'movies' ||
                lib.CollectionType === 'tvshows' ||
                lib.CollectionType === 'music' ||
                lib.CollectionType === 'musicvideos';

            if (!isMediaCol && (lib.CollectionType === 'games' || /\b(games?|roms?|emulators?)\b/i.test(libNameLower))) {
                iconCol = 'games';
            }

            const iconSvg = getLibraryIcon(iconCol);

            html += `
                <button class="mobile-library-tile" data-path="${navPath}" tabindex="0">
                    <div class="mobile-library-tile-icon">
                        ${iconSvg}
                    </div>
                    <span class="mobile-library-tile-title">${lib.Name}</span>
                </button>
            `;
        });

        container.innerHTML = html;

        // Bind navigation clicks on library tiles
        container.querySelectorAll('.mobile-library-tile').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                const path = btn.dataset.path;
                this.toggleLibrariesDialog(false);
                if (path) router.navigate(path);
            });
        });
    }

    /**
     * Checks if Seerr media discovery backend is reachable and updates Discover tab.
     * @private
     */
    async _probeSeerr() {
        if (!auth.isAuthenticated()) return;

        try {
            const available = await seerr.isAvailable();
            this._setSeerrAvailable(available);
        } catch (e) {
            this._setSeerrAvailable(false);
        }
    }

    /**
     * Updates visibility of the Discover navigation tab.
     * @param {boolean} available
     * @private
     */
    _setSeerrAvailable(available) {
        this._seerrAvailable = !!available;
        const discoverBtn = this.$('#mobile-nav-discover');
        if (discoverBtn) {
            discoverBtn.style.display = this._seerrAvailable ? '' : 'none';
        }
    }

    /**
     * Updates visual active state for SyncPlay indicator dots.
     * @param {boolean} active
     * @private
     */
    _setSyncPlayActive(active) {
        this._syncPlayActive = !!active;
        const dot = this.$('#mobile-syncplay-dot');
        if (dot) {
            dot.classList.toggle('active', this._syncPlayActive);
        }
    }

    /**
     * Fetches a random media item from server and opens its details page.
     * @private
     */
    async _triggerRandomItem() {
        try {
            log.info('Fetching random item for mobile playback...');
            const item = await api.getRandomItem();
            if (item && item.Id) {
                router.navigate(`/details/${item.Id}`);
            }
        } catch (err) {
            log.error('Failed fetching random item:', err);
        }
    }

    /**
     * Generates avatar image markup or default icon fallback for current user.
     * @returns {string} HTML markup
     * @private
     */
    _renderUserAvatar() {
        const user = auth.getCurrentUser();
        if (user && user.PrimaryImageTag) {
            const url = api.getUserImageUrl(user.Id, { maxWidth: 64 });
            return `<img src="${url}" class="mobile-avatar-img" alt="${user.Name || 'User'}" />`;
        }
        return sidebarIcons.userDefault;
    }

    /**
     * Updates avatar DOM container when user or authentication changes.
     * @private
     */
    _updateUserAvatar() {
        const container = this.$('#mobile-topbar-avatar-container');
        if (container) {
            container.innerHTML = this._renderUserAvatar();
        }
    }

    /**
     * Callback invoked once initial splash screen is dismissed.
     */
    onSplashHidden() {
        this._updateVisibility();
    }

    /**
     * Formats current time string matching localized application settings.
     * @returns {string} Formatted local time string
     * @private
     */
    _getFormattedTime() {
        try {
            return i18n.formatLocalTime(new Date());
        } catch (_) {
            const now = new Date();
            return now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        }
    }

    /**
     * Starts interval to periodically update digital clock display in top bar.
     * @private
     */
    _startClockTimer() {
        if (this._clockInterval) clearInterval(this._clockInterval);
        this._clockInterval = setInterval(() => {
            const clockEl = this.$('#mobile-topbar-clock');
            if (clockEl) {
                clockEl.textContent = this._getFormattedTime();
            }
        }, 15000);
    }
}

export default MobileNav;
