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

                <!-- User Profile -->
                <button class="sidebar-item user-profile-btn" id="sidebar-user" tabindex="0">
                    <div class="item-icon user-avatar-container">
                        ${this._renderUserAvatar()}
                    </div>
                    <span class="item-text">${this._getUserName()}</span>
                </button>

                <!-- Navigation Items -->
                <div class="sidebar-nav">
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
                    
                    <button class="sidebar-item" id="sidebar-logout" tabindex="0">
                        <div class="item-icon">
                            <svg class="icon-outline" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
                                <polyline points="16 17 21 12 16 7"></polyline>
                                <line x1="21" y1="12" x2="9" y2="12"></line>
                            </svg>
                            <svg class="icon-filled" width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z"/>
                            </svg>
                        </div>
                        <span class="item-text" data-i18n="ButtonSignOut">Logout</span>
                    </button>
                </div>
                
                <!-- Sliding Focus Indicator -->
                <div class="sidebar-focus-indicator"></div>

                <!-- Libraries Section (Dynamic) -->
                <div class="sidebar-libraries-wrapper">
                    <div class="sidebar-divider"></div>
                    <div class="sidebar-libraries" id="sidebar-libraries">
                        <!-- Filled dynamically -->
                    </div>
                </div>
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

        // Register focus
        focusManager.register('sidebar', this.el, {
            orientation: 'vertical',
            selector: '.sidebar-item',
            // Always land on the Home button when entering the sidebar
            defaultFocusSelector: '#sidebar-home',
            onMove: (direction, focusedEl) => {
                if (direction === 'right') {
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
            if (container) container.innerHTML = '';
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

                // Update indicator FIRST while transition is still disabled (collapsed state)
                // to ensure it snaps to the correct position before we expand.
                this._updateIndicator(focusedItem);

                // Then handle expansion
                if (hasFocus) {
                    this._expand(true);
                } else if (!this.el.matches(':hover')) {
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
                    router.navigate(path);
                } else if (item.id === 'sidebar-logout') {
                    auth.logout();
                }
            };
        });
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
        try {
            const views = await api.getUserViews();
            const items = views.Items || [];

            const container = this.el.querySelector('#sidebar-libraries');
            if (!container) return;
            container.innerHTML = '';

            // Add Segment Header
            const header = document.createElement('div');
            header.className = 'sidebar-section-header';
            header.dataset.i18n = 'MediaLibraries';
            header.textContent = i18n.t('MediaLibraries');
            container.appendChild(header);

            items.forEach((lib) => {
                const btn = document.createElement('button');
                btn.className = 'sidebar-item library-item';
                btn.tabIndex = 0;
                btn.dataset.path = `/library/${lib.Id}`;
                // No Icon, just text
                btn.innerHTML = `
                    <span class="item-text">${lib.Name}</span>
                `;

                btn.onclick = () => router.navigate(`/library/${lib.Id}`);

                container.appendChild(btn);
            });
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
     */
    _updateIndicator(focusedItem) {
        const indicator = this.el.querySelector('.sidebar-focus-indicator');
        if (!indicator) return;

        const target = focusedItem || this.el.querySelector('.sidebar-item.focused');

        if (target) {
            // If we are currently NOT expanded, we want to snap instantly
            const isExpanding = !this.el.classList.contains('expanded');

            const sidebarRect = this.el.getBoundingClientRect();
            const targetRect = target.getBoundingClientRect();
            const y = targetRect.top - sidebarRect.top;

            if (isExpanding) {
                // Force an instant snap while closed
                indicator.style.transition = 'none';
                indicator.style.transform = `translate3d(0, ${y}px, 0)`;
                // Force reflow to ensure the style is applied before transition is re-enabled
                indicator.offsetHeight;
                indicator.style.transition = '';
            } else {
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
}

export default Sidebar;
