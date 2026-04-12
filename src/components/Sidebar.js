/**
 * ============================================================================
 * Litefin Tizen - Sidebar Component
 * ============================================================================
 * Global navigation sidebar that replaces the top header.
 * Supports collapsed (icon-only) and expanded (icon+text) states.
 * ============================================================================
 */

import Component from '../core/Component.js';
import { api, auth } from '../api/index.js';
import { router } from '../core/Router.js';
import { focusManager } from '../ui/FocusManager.js';
import { eventBus } from '../core/EventBus.js';
import { logger } from '../utils/Logger.js';
import { i18n } from '../utils/i18n.js';
import { syncPlayGroupMenu } from '../core/syncplay/SyncPlayGroupMenu.js';
import { pluginManager } from '../plugins/PluginManager.js';
import { storage } from '../utils/StorageService.js';
import { sidebarLayoutManager } from '../utils/SidebarLayoutManager.js';

const log = logger.create('Sidebar');

class Sidebar extends Component {
    constructor(options = {}) {
        super(options);

        this.expanded = false;
        this.libraries = [];
        this.activePath = '';
    }

    render() {
        return `
            <nav class="sidebar collapsed" id="main-sidebar">
                <!-- Logo Section -->
                <div class="sidebar-header">
                    <div class="logo-icon">
                        <svg viewBox="0 0 100 100" width="40" height="40" class="sidebar-logo-svg" preserveAspectRatio="xMidYMid meet">
                            <path class="logo-path-outer" d="M19.57,91c-2.24,0-4.73-0.44-6.87-2.02c-2.07-1.53-3.32-3.6-3.62-5.97
				c-0.51-4.01,1.81-7.59,3.24-9.37c4.82-5.97,9.41-12.5,10.36-19.76c0.8-6.13-1-12.33-2.9-18.9c-0.59-2.04-1.21-4.16-1.73-6.27
				c-0.8-3.17-1.42-6.59-0.53-10.08c1.8-7.06,9.11-10.26,21.74-9.53c10.63,0.62,21.35,5.21,30.19,12.91
				C82.12,33.08,93.56,53.11,90.5,72.93c-0.23,1.54-0.58,2.97-1.04,4.26c-1.28,3.66-3.47,6.32-6.34,7.68
				c-3.63,1.71-7.38,1.01-10.39,0.44c-2.45-0.46-5.35-0.99-8.34-1.37c-6.72-0.86-12.12-0.79-17.02,0.21
				c-3.5,0.71-6.9,1.8-10.49,2.95c-4.51,1.44-9.17,2.94-14.09,3.64C21.84,90.88,20.74,91,19.57,91z M35.69,16
				c-5.23,0-10.52,0.9-11.4,4.36c-0.5,1.98-0.04,4.37,0.53,6.65c0.5,1.99,1.09,4.04,1.67,6.02c2.02,6.97,4.11,14.17,3.12,21.75
				c-1.17,8.98-6.38,16.48-11.85,23.25c-1.19,1.47-1.87,3.08-1.75,4.08c0.04,0.31,0.17,0.73,0.85,1.23
				c0.89,0.66,2.51,0.81,4.95,0.46c4.34-0.62,8.53-1.96,12.95-3.38c3.61-1.16,7.35-2.35,11.22-3.14c5.67-1.16,11.81-1.26,19.31-0.3
				c3.17,0.41,6.2,0.95,8.74,1.43c2.32,0.44,4.52,0.85,6.1,0.11c1.15-0.54,2.07-1.78,2.72-3.66l0-0.01c0.31-0.87,0.55-1.88,0.72-3
				c2.65-17.2-7.5-34.78-18.74-44.57c-7.68-6.69-16.92-10.67-26-11.2C37.81,16.04,36.75,16,35.69,16z" />
                            <path class="logo-path-inner" d="M69.3,63.51c0.19-0.64,0.32-1.3,0.41-1.95
			c1.26-9.44-3.2-19.55-9.22-25.63c-3.64-3.67-8.19-6.14-13.02-6.47c-2.7-0.18-7.56-0.15-8.41,3.7c-0.32,1.47-0.07,3.03,0.25,4.49
			c1.01,4.7,2.72,9.41,2.18,14.21C41,56.22,38.72,60,36.34,63.41c-1.14,1.63-1.9,4.02-0.12,5.54c0.97,0.83,2.3,0.8,3.49,0.6
			c3.88-0.64,7.47-2.62,11.3-3.52c2.77-0.66,5.63-0.55,8.42-0.14c1.33,0.2,2.64,0.47,3.96,0.75c1.25,0.27,2.62,0.57,3.82-0.09
			C68.26,65.98,68.91,64.81,69.3,63.51z" />
                        </svg>
                    </div>
                    <span class="logo-text">Litefin</span>
                </div>

                <!-- Scrollable Sidebar Content -->
                <div class="sidebar-content">
                    <!-- SyncPlay Section -->
                    <button class="sidebar-item sidebar-syncplay-btn" id="sidebar-syncplay" tabindex="0">
                        <div class="item-icon sidebar-syncplay-icon-wrap">
                            <!-- User Provided Icon (3 people) -->
                            <svg class="icon-outline" width="24" height="24" viewBox="0 -960 960 960" fill="currentColor">
                                <path d="M0-240v-63q0-43 44-70t116-27q13 0 25 .5t23 2.5q-14 21-21 44t-7 48v65H0Zm240 0v-65q0-32 17.5-58.5T307-410q32-20 76.5-30t96.5-10q53 0 97.5 10t76.5 30q32 20 49 46.5t17 58.5v65H240Zm540 0v-65q0-26-6.5-49T754-397q11-2 22.5-2.5t23.5-.5q72 0 116 26.5t44 70.5v63H780Zm-455-80h311q-10-20-55.5-35T480-370q-55 0-100.5 15T325-320ZM160-440q-33 0-56.5-23.5T80-520q0-34 23.5-57t56.5-23q34 0 57 23t23 57q0 33-23 56.5T160-440Zm640 0q-33 0-56.5-23.5T720-520q0-34 23.5-57t56.5-23q34 0 57 23t23 57q0 33-23 56.5T800-440Zm-320-40q-50 0-85-35t-35-85q0-51 35-85.5t85-34.5q51 0 85.5 34.5T600-600q0 50-34.5 85T480-480Zm0-80q17 0 28.5-11.5T520-600q0-17-11.5-28.5T480-640q-17 0-28.5 11.5T440-640q-17 0-28.5 11.5T440-600q0 17 11.5 28.5T480-560Zm1 240Zm-1-280Z"/>
                            </svg>
                            <svg class="icon-filled" width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M12,12.75c1.63,0 3.07,0.39 4.24,0.9c1.08,0.48 1.76,1.56 1.76,2.73L18,18H6l0,-1.61c0,-1.18 0.68,-2.26 1.76,-2.73C8.93,13.14 10.37,12.75 12,12.75zM4,13c1.1,0 2,-0.9 2,-2c0,-1.1 -0.9,-2 -2,-2s-2,0.9 -2,2C2,12.1 2.9,13 4,13zM5.13,14.1C4.76,14.04 4.39,14 4,14c-0.99,0 -1.93,0.21 -2.78,0.58C0.48,14.9 0,15.62 0,16.43V18l4.5,0v-1.61C4.5,15.56 4.73,14.78 5.13,14.1zM20,13c1.1,0 2,-0.9 2,-2c0,-1.1 -0.9,-2 -2,-2s-2,0.9 -2,2C18,12.1 18.9,13 20,13zM24,16.43c0,-0.81 -0.48,-1.53 -1.22,-1.85C21.93,14.21 20.99,14 20,14c-0.39,0 -0.76,0.04 -1.13,0.1c0.4,0.68 0.63,1.46 0.63,2.29V18l4.5,0V16.43zM12,6c1.66,0 3,1.34 3,3c0,1.66 -1.34,3 -3,3s-3,-1.34 -3,-3C9,7.34 10.34,6 12,6z"/>
                            </svg>
                            <!-- Pulsing dot — visible only when in a group -->
                            <span class="sidebar-syncplay-dot" id="sidebar-syncplay-dot"></span>
                        </div>
                        <span class="item-text sidebar-syncplay-label" id="sidebar-syncplay-label">SyncPlay</span>
                    </button>

                    <!-- User Profile -->
                    <button class="sidebar-item user-profile-btn" id="sidebar-user" tabindex="0">
                        <div class="item-icon user-avatar-container">
                            ${this._renderUserAvatar()}
                        </div>
                        <span class="item-text user-name">${this._getUserName()}</span>
                    </button>

                    <button class="sidebar-item" id="sidebar-random" tabindex="0">
                        <div class="item-icon">
                            <svg class="icon-outline" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                                <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
                                <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
                                <circle cx="7.8" cy="7.8" r="1.6" fill="currentColor" stroke="none" />
                                <circle cx="16.2" cy="16.2" r="1.6" fill="currentColor" stroke="none" />
                                <circle cx="16.2" cy="7.8" r="1.6" fill="currentColor" stroke="none" />
                                <circle cx="7.8" cy="16.2" r="1.6" fill="currentColor" stroke="none" />
                            </svg>
                        </div>
                        <span class="item-text" data-i18n="Random">Random</span>
                    </button>

                    <button class="sidebar-item" id="sidebar-home" tabindex="0" data-path="/home">
                        <div class="item-icon">
                            <svg class="icon-outline" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
                                <polyline points="9 22 9 12 15 12 15 22"></polyline>
                            </svg>
                            <svg class="icon-filled" width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M12 2L3 9v11a2 2 0 0 0 2 2h4v-8h6v8h4a2 2 0 0 0 2-2V9L12 2z"/>
                            </svg>
                        </div>
                        <span class="item-text" data-i18n="Home">Home</span>
                    </button>

                    <button class="sidebar-item" id="sidebar-favorites" tabindex="0" data-path="/favorites">
                        <div class="item-icon">
                            <svg class="icon-outline" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path>
                            </svg>
                            <svg class="icon-filled" width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>
                            </svg>
                        </div>
                        <span class="item-text" data-i18n="Favorites">Favorites</span>
                    </button>

                    <button class="sidebar-item" id="sidebar-search" tabindex="0" data-path="/search">
                        <div class="item-icon">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                                <circle cx="11" cy="11" r="8"></circle>
                                <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                            </svg>
                        </div>
                        <span class="item-text" data-i18n="Search">Search</span>
                    </button>

                    <button class="sidebar-item" id="sidebar-settings" tabindex="0" data-path="/settings">
                        <div class="item-icon">
                            <svg class="icon-outline" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                                <circle cx="12" cy="12" r="3"></circle>
                                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
                            </svg>
                            <svg class="icon-filled" width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>
                            </svg>
                        </div>
                        <span class="item-text" data-i18n="Settings">Settings</span>
                    </button>
                </div>

                <!-- Sliding Focus Indicator -->
                <div class="sidebar-focus-indicator"></div>
            </nav>
        `;
    }

    onMounted() {
        this._bindEvents();
        this._loadLibraries();
        this._updateActiveState();

        // Hydrate DOM with translations
        i18n.translateDOM(this.el);

        // Listen for auth events to update user profile
        eventBus.on('auth:login', this._onAuthChange.bind(this));
        eventBus.on('auth:logout', this._onAuthChange.bind(this));
        eventBus.on('auth:restored', this._onAuthChange.bind(this));

        // Listen for SyncPlay state changes to update the sidebar button
        this._onSyncPlayEnabled  = () => this._updateSyncPlayBtn(true);
        this._onSyncPlayDisabled = () => this._updateSyncPlayBtn(false);
        eventBus.on('syncplay:enabled',  this._onSyncPlayEnabled);
        eventBus.on('syncplay:disabled', this._onSyncPlayDisabled);

        // Initialize visibility in case the plugin is disabled at startup
        // The default active state is retrieved dynamically from the Manager if it exists,
        //. but fallback to false if it hasn't started yet.
        this._updateSyncPlayBtn(window.__syncPlayManager?.isActive || false);

        // ── Sidebar Layout customization ──────────────────────────────────────
        // Hot-reload the sidebar layout when the user saves changes in Settings.
        this._onSidebarLayoutChanged = () => {
            // Re-apply order/visibility and update the default focus target
            this._applySidebarLayout();
        };
        eventBus.on('prefChanged:sidebarLayout', this._onSidebarLayoutChanged);

        // Resolve the default focus item from saved prefs (falls back to 'home')
        const defaultFocusId = sidebarLayoutManager.getDefaultFocus();

        // Register focus
        focusManager.register('sidebar', this.el, {
            orientation: 'vertical',
            selector: '.sidebar-item',
            /*
             * Use the saved default focus preference. The defaultFocusSelector is
             * stored on the section config and re-read each time focus enters the
             * sidebar, so updating it via _applySidebarLayout() also takes effect
             * immediately without re-registering the entire section.
             */
            defaultFocusSelector: `#sidebar-${defaultFocusId}`,
            onMove: (direction, focusedEl) => {
                const isRtl = document.documentElement.dir === 'rtl';
                const exitDirection = isRtl ? 'left' : 'right';

                if (direction === exitDirection) {
                    const pageContainer = document.getElementById('page-container');
                    if (!pageContainer) return false;

                    // 1. Try to resume previous section (Smart Resume)
                    const prevSection = focusManager.getPreviousSection();
                    if (prevSection) {
                        const config = focusManager.getSectionConfig(prevSection);
                        // Check if section still exists and is part of the current page structure
                        if (config && pageContainer.contains(config.container)) {
                            // Pass null as 3rd arg to force Memory restore instead of Spatial
                            focusManager.setActiveSection(prevSection, true, null);
                            return true;
                        }
                    }

                    // 2. Fallback: Find first visible focusable to identify valid section
                    const selector = 'button:not([disabled]), [tabindex]:not([tabindex="-1"])';
                    const candidates = pageContainer.querySelectorAll(selector);
                    const target = Array.from(candidates).find((el) => el.offsetParent !== null);

                    if (target) {
                        const section = focusManager.getSectionForElement(target);
                        if (section) {
                            focusManager.setActiveSection(section, true, null);
                            return true;
                        }
                    }
                }
                return false;
            }
        });

        // Apply the layout immediately after registration so the first render
        // already reflects the user's saved order and visibility prefs.
        this._applySidebarLayout();

        // Listen for route changes
        eventBus.on('router:navigate', this._onNavigate.bind(this));

        // Initial setup of indicator
        this._updateIndicator();
    }

    onDestroyed() {
        if (this._focusObserver) {
            this._focusObserver.disconnect();
            this._focusObserver = null;
        }
        focusManager.unregister('sidebar');
        eventBus.off('router:navigate', this._onNavigate.bind(this));

        // Remove auth listeners
        eventBus.off('auth:login', this._onAuthChange.bind(this));
        eventBus.off('auth:logout', this._onAuthChange.bind(this));
        eventBus.off('auth:restored', this._onAuthChange.bind(this));

        // Remove SyncPlay listeners
        if (this._onSyncPlayEnabled)  eventBus.off('syncplay:enabled',  this._onSyncPlayEnabled);
        if (this._onSyncPlayDisabled) eventBus.off('syncplay:disabled', this._onSyncPlayDisabled);

        // Remove sidebar layout hot-reload listener
        if (this._onSidebarLayoutChanged) {
            eventBus.off('prefChanged:sidebarLayout', this._onSidebarLayoutChanged);
        }
    }

    /**
     * Handle auth changes (login/logout)
     */
    _onAuthChange() {
        const userBtn = this.el.querySelector('#sidebar-user');
        if (userBtn) {
            // Update Avatar
            const avatarContainer = userBtn.querySelector('.user-avatar-container');
            if (avatarContainer) {
                avatarContainer.innerHTML = this._renderUserAvatar();
            }
            // Update Name
            const nameSpan = userBtn.querySelector('.user-name');
            if (nameSpan) {
                nameSpan.textContent = this._getUserName();
            }
        }

        // Reload libraries if logged in
        if (auth.isAuthenticated()) {
            this._loadLibraries();
        } else {
            // Clear libraries on logout
            const container = this.el.querySelector('#sidebar-libraries');
            if (container) {
                container.innerHTML = '';
                focusManager.resetDOMCache();
            }
        }
    }

    /**
     * Set visibility mode
     * @param {'visible'|'hidden'} mode
     */
    setMode(mode) {
        this.el.classList.toggle('hidden', mode === 'hidden');
    }

    _bindEvents() {
        // Expand on focus - Use MutationObserver since FocusManager disables native focus
        // and manages the .focused class manually.
        if (window.MutationObserver) {
            this._focusObserver = new MutationObserver(() => {
                const focusedItem = this.el.querySelector('.sidebar-item.focused');
                const hasFocus = !!focusedItem;

                if (focusedItem) {
                    // Automatically scroll the sidebar container so the newly focused item is in view
                    focusedItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                }

                // Update indicator FIRST while transition is still disabled (collapsed state)
                // to ensure it snaps to the correct position before we expand.
                this._updateIndicator(focusedItem);

                // Then handle expansion
                if (hasFocus) {
                    this._expand(true);
                } else {
                    this._expand(false);
                }
            });

            this._focusObserver.observe(this.el, {
                attributes: true,
                subtree: true,
                attributeFilter: ['class']
            });
        }

        // Toggle handling - Mouse
        this.el.addEventListener('mouseenter', () => this._expand(true));
        this.el.addEventListener('mouseleave', () => {
            // Only collapse if we don't have focus
            if (!this.el.querySelector('.focused')) {
                this._expand(false);
            }
        });

        // Navigation Clicks
        const items = this.el.querySelectorAll('.sidebar-item');
        items.forEach((item) => {
            item.onclick = () => {
                const path = item.dataset.path;
                if (path) {
                    if (path === '/home') {
                        router.reset(path);
                    } else {
                        router.navigate(path);
                    }
                } else if (item.id === 'sidebar-user') {
                    // Clicking the user profile tile opens the "Who's Watching" profiles screen.
                    // From there the user can switch profiles, add a user, or switch servers.
                    router.navigate('/profiles');
                } else if (item.id === 'sidebar-logout') {
                    // AuthManager.logout() handles the routing based on remaining sessions:
                    //   • Other sessions remain → auth:switchToProfiles → App.js routes to /profiles
                    //   • No sessions remain    → auth:logout           → App.js routes to /login
                    // auth.logout();
                } else if (item.id === 'sidebar-syncplay') {
                    // Open the SyncPlay group menu overlay (works from any screen)
                    syncPlayGroupMenu.open();
                } else if (item.id === 'sidebar-random') {
                    this._onRandomClick();
                }
            };
        });

        // Sync indicator during scrolling
        const contentContainer = this.el.querySelector('.sidebar-content');
        if (contentContainer) {
            contentContainer.addEventListener('scroll', () => {
                const focused = this.el.querySelector('.sidebar-item.focused');
                // Only sync if the focused element is actually INSIDE the scrolling container
                if (focused && contentContainer.contains(focused)) {
                    this._updateIndicator(focused, { instant: true });
                }
            });
        }
    }

    _expand(expanded) {
        if (this.expanded === expanded) return;
        this.expanded = expanded;

        this.el.classList.toggle('expanded', expanded);
        this.el.classList.toggle('collapsed', !expanded);

        // Notify layout manager or app to push content?
        // Actually CSS transitions on #page-container should handle it if we toggle a class on body
        // But for now, let's keep it overlapping or simple push.
        // User requested: "push page content to the right"

        const pageContainer = document.getElementById('page-container');
        if (pageContainer) {
            pageContainer.classList.toggle('sidebar-expanded', expanded);
        }
    }

    async _loadLibraries() {
        if (!auth.isAuthenticated()) return;

        try {
            const views = await api.getUserViews();
            const items = views.Items || [];

            const sidebarContent = this.el.querySelector('.sidebar-content');
            if (!sidebarContent) return;
            
            // Remove any previously rendered libraries and headers to allow clean reloading
            sidebarContent.querySelectorAll('.library-item, .sidebar-section-header').forEach(el => el.remove());

            if (items.length > 0) {
                // Determine header label based on layout block ('My Media')
                const header = document.createElement('div');
                header.className = 'sidebar-section-header';
                header.id = 'section-header';
                header.dataset.i18n = 'HeaderMyMedia';
                header.textContent = i18n.t('HeaderMyMedia');
                sidebarContent.appendChild(header);
            }

            items.forEach((lib) => {
                const btn = document.createElement('button');
                btn.className = 'sidebar-item library-item';
                btn.tabIndex = 0;
                // Attach both the path (for nav) AND a layout-id so _applySidebarLayout
                // can match this button against the saved config (id: 'lib-{Id}')
                btn.dataset.path = `/library/${lib.Id}`;
                btn.dataset.layoutId = `lib-${lib.Id}`;
                btn.innerHTML = `
                    <span class="item-text">${lib.Name}</span>
                `;

                btn.onclick = () => router.navigate(`/library/${lib.Id}`);

                sidebarContent.appendChild(btn);
            });

            /*
             * After building all library buttons, re-apply the sidebar layout so
             * newly loaded library items are placed in their saved position and
             * any that the user has hidden are correctly suppressed.
             */
            this._applySidebarLayout();

            // Invalidate focus manager cache to discover dynamically added libraries
            focusManager.resetDOMCache();
        } catch (e) {
            log.warn('Failed to load libraries', e);
        }
    }

    _renderUserAvatar() {
        const user = auth.getCurrentUser();
        if (user && user.PrimaryImageTag) {
            const url = api.getUserImageUrl(user.Id, { maxWidth: 50 });
            return `<img src="${url}" class="sidebar-avatar" />`;
        }
        return `
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
                <circle cx="12" cy="7" r="4"></circle>
            </svg>
        `;
    }

    _getUserName() {
        const user = auth.getCurrentUser();
        return user && user.Name ? user.Name : i18n.t('LabelUsername');
    }

    /**
     * Update the SyncPlay button's visual state.
     *
     * When `active` is true (we joined a group):
     *   - The button gets the CSS class `syncplay-active` for an accent glow.
     *   - A pulsing green dot appears inside the icon area.
     *   - The label changes to the current group name (or "In Group").
     *
     * When `active` is false (we left the group or are not in one):
     *   - All of the above are cleared back to the default "SyncPlay" state.
     *
     * @param {boolean} active - Whether SyncPlay is currently enabled
     * @private
     */
    _updateSyncPlayBtn(active) {
        const btn   = this.el.querySelector('#sidebar-syncplay');
        const dot   = this.el.querySelector('#sidebar-syncplay-dot');
        const label = this.el.querySelector('#sidebar-syncplay-label');
        if (!btn) return;

        // Hide completely if the plugin is disabled
        btn.style.display = pluginManager.isEnabled('syncplay') ? '' : 'none';

        btn.classList.toggle('syncplay-active', active);

        if (dot) {
            dot.classList.toggle('visible', active);
        }

        if (label) {
            if (active) {
                // Try to get the human-readable group name from SyncPlayManager
                const manager = window.__syncPlayManager;
                const groupName = manager?.groupName || 'In Group';
                label.textContent = groupName;
            } else {
                label.textContent = 'SyncPlay';
            }
        }
    }

    _onNavigate({ path }) {
        this.activePath = path;
        this._updateActiveState();
    }

    _updateActiveState() {
        const items = this.el.querySelectorAll('.sidebar-item');
        items.forEach((item) => {
            const itemPath = item.dataset.path;
            if (itemPath && this.activePath.startsWith(itemPath)) {
                // Approximate match (e.g. /home matches /home)
                // Exception: /library/:id needs exact start logic
                item.classList.add('active');
            } else {
                item.classList.remove('active');
            }
        });
    }

    /**
     * Update the sliding focus indicator position
     * @param {HTMLElement} [focusedItem] - Optionally pass the focused element
     * @param {Object} [options] - Update options
     * @param {boolean} [options.instant] - If true, disable transitions for this update
     */
    _updateIndicator(focusedItem, options = {}) {
        const indicator = this.el.querySelector('.sidebar-focus-indicator');
        if (!indicator) return;

        const target = focusedItem || this.el.querySelector('.sidebar-item.focused');

        if (target) {
            // If we are currently NOT expanded, we want to snap instantly
            const isExpanding = !this.el.classList.contains('expanded');
            const forceInstant = options.instant || isExpanding;

            const sidebarRect = this.el.getBoundingClientRect();
            const targetRect = target.getBoundingClientRect();
            const y = targetRect.top - sidebarRect.top;

            if (forceInstant) {
                // Force an instant snap
                indicator.style.webkitTransition = 'none';
                indicator.style.transition = 'none';
                indicator.style.webkitTransform = `translate3d(0, ${y}px, 0)`;
                indicator.style.transform = `translate3d(0, ${y}px, 0)`;
                // Force reflow to ensure the style is applied before transition is re-enabled
                indicator.offsetHeight;
                indicator.style.webkitTransition = '';
                indicator.style.transition = '';
            } else {
                indicator.style.webkitTransform = `translate3d(0, ${y}px, 0)`;
                indicator.style.transform = `translate3d(0, ${y}px, 0)`;
            }

            if (!this.el.classList.contains('has-focus')) {
                this.el.classList.add('has-focus');
            }
        } else {
            if (this.el.classList.contains('has-focus')) {
                this.el.classList.remove('has-focus');
            }
        }
    }

    /**
     * Apply the saved sidebar layout to the live DOM.
     *
     * This method:
     *   1. Collects all sidebar-item elements from within .sidebar-content
     *   2. Asks SidebarLayoutManager to order and annotate them.
     *   3. Re-inserts them into .sidebar-content in the new sequential order.
     *   4. Toggles visibility (display: none) based on the `hidden` flag.
     *   5. Updates the FocusManager's defaultFocusSelector for this section.
     *
     * It is safe to call at any time (mount, library load, hot-reload from settings).
     * @private
     */
    _applySidebarLayout() {
        const sidebarEl = this.el.id === 'main-sidebar' ? this.el : this.el.querySelector('#main-sidebar');
        if (!sidebarEl) return;

        const sidebarContent = sidebarEl.querySelector('.sidebar-content');
        if (!sidebarContent) return;

        /* ── 1. Collect all sidebar items with their layout IDs ────────────── */
        const allItems = [];

        // Collect everything flatly from .sidebar-content
        const items = sidebarContent.querySelectorAll(':scope > .sidebar-item, :scope > .sidebar-section-header');
        items.forEach((el) => {
            if (el.classList.contains('library-item')) {
                // It's a dynamically injected library
                allItems.push({ id: el.dataset.layoutId, el: el });
            } else if (el.id === 'section-header') {
                // It's the library section header
                allItems.push({ id: 'section-header', el: el });
            } else {
                // It's a static navigation item
                const rawId = el.id ? el.id.replace('sidebar-', '') : null;
                if (rawId) allItems.push({ id: rawId, el: el });
            }
        });

        /* ── 2. Ask the manager to order and annotate items ────────────────── */
        const ordered = sidebarLayoutManager.applyLayout(allItems);

        /* ── 3. Re-insert items and apply visibility ───────────────────────── */
        ordered.forEach(({ id, el, hidden }) => {
            const isSyncPlay = id === 'syncplay';
            const pluginHidden = isSyncPlay && !pluginManager.isEnabled('syncplay');
            const shouldHide = hidden || pluginHidden;

            // Apply visibility
            el.style.display = shouldHide ? 'none' : '';

            // Sequentially append back into the shared container
            sidebarContent.appendChild(el);
        });

        /* ── 4. Update the FocusManager's defaultFocusSelector ─────────────── */
        const defaultFocusId = sidebarLayoutManager.getDefaultFocus();
        const sectionConfig = focusManager.getSectionConfig('sidebar');
        if (sectionConfig) {
            sectionConfig.defaultFocusSelector = `#sidebar-${defaultFocusId}`;
        }

        // Invalidate the focus cache so the updated DOM structure is re-scanned
        focusManager.invalidateCache('sidebar');
    }

    /**
     * Handle the 'Random' button click.
     * Fetches a random item using the API and navigates to its details page.
     * @private
     */
    async _onRandomClick() {
        try {
            log.info('Fetching random item...');
            const item = await api.getRandomItem();
            if (item) {
                log.info(`Random item found: ${item.Name} (${item.Id})`);
                router.navigate(`/details/${item.Id}`);
            } else {
                log.warn('No random item found.');
                // Optional: Show a toast/notification if no items are found
            }
        } catch (e) {
            log.error('Failed to fetch random item', e);
        }
    }
}

export default Sidebar;
