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
import { sidebarIcons, getLibraryIcon } from '../utils/Icons.js';
import { seerr } from '../api/seerrClient.js';
import { layoutManager } from '../ui/LayoutManager.js';

const log = logger.create('Sidebar');

class Sidebar extends Component {
    constructor(options = {}) {
        super(options);

        this.expanded = false;
        this.librariesExpanded = false;
        this.floatingLibrariesOpen = false;
        this.libraries = [];
        this.activePath = '';

        /**
         * Tracks whether the current expansion was triggered by mouse hover.
         * This is the key to preventing the sidebar from getting stuck open:
         * when the mouse leaves, we collapse unconditionally if hover caused
         * the expansion — the .focused class from FocusManager is irrelevant
         * in that scenario and should NOT block the collapse.
         * @type {boolean}
         */
        this._expandedByMouse = false;
    }

    render() {
        return `
            <nav class="sidebar collapsed" id="main-sidebar">
                <!-- Logo Section -->
                <div class="sidebar-header" id="sidebar-logo-header">
                    <div class="logo-icon">
                        ${sidebarIcons.logo}
                    </div>
                    <span class="logo-text">Litefin</span>
                </div>

                <!-- Scrollable Sidebar Content -->
                <div class="sidebar-content">
                    <button class="sidebar-item" id="sidebar-home" tabindex="0" data-path="/home">
                        <div class="item-icon">
                            ${sidebarIcons.home}
                        </div>
                        <span class="item-text" data-i18n="Home">Home</span>
                    </button>

                    <button class="sidebar-item" id="sidebar-discover" tabindex="0" data-path="/discover" style="display: none;">
                        <div class="item-icon">
                            ${sidebarIcons.discover}
                        </div>
                        <span class="item-text" data-i18n="SeerrDiscover">Discover</span>
                    </button>

                    <button class="sidebar-item" id="sidebar-favorites" tabindex="0" data-path="/favorites">
                        <div class="item-icon">
                            ${sidebarIcons.favorites}
                        </div>
                        <span class="item-text" data-i18n="Favorites">Favorites</span>
                    </button>

                    <button class="sidebar-item" id="sidebar-search" tabindex="0" data-path="/search">
                        <div class="item-icon">
                            ${sidebarIcons.search}
                        </div>
                        <span class="item-text" data-i18n="Search">Search</span>
                    </button>

                    <button class="sidebar-item" id="sidebar-random" tabindex="0">
                        <div class="item-icon">
                            ${sidebarIcons.random}
                        </div>
                        <span class="item-text" data-i18n="Random">Random</span>
                    </button>

                    <!-- SyncPlay Section -->
                    <button class="sidebar-item sidebar-syncplay-btn" id="sidebar-syncplay" tabindex="0" style="display: none;">
                        <div class="item-icon sidebar-syncplay-icon-wrap">
                            <!-- User Provided Icon (3 people) -->
                            ${sidebarIcons.syncplay}
                            <!-- Pulsing dot — visible only when in a group -->
                            <span class="sidebar-syncplay-dot" id="sidebar-syncplay-dot"></span>
                        </div>
                        <span class="item-text sidebar-syncplay-label" id="sidebar-syncplay-label">SyncPlay</span>
                    </button>
                    
                    <button class="sidebar-item" id="sidebar-livetv" tabindex="0" data-path="/livetv" style="display: none;">
                        <div class="item-icon">
                            ${sidebarIcons.livetv}
                        </div>
                        <span class="item-text" data-i18n="LiveTV">Live TV</span>
                    </button>

                    <!-- Modern Libraries Accordion Toggle (Collections / Books Icon) -->
                    <button class="sidebar-item" id="sidebar-libraries" tabindex="0">
                        <div class="item-icon">
                            ${sidebarIcons.libraries}
                        </div>
                        <span class="item-text" data-i18n="Libraries">Libraries</span>
                        <span class="sidebar-chevron">${sidebarIcons.chevronDown}</span>
                    </button>

                    <!-- Modern Sub-Libraries Container (Hidden by default) -->
                    <div class="sidebar-sub-libraries hidden" id="sidebar-sub-libraries" style="display: none;" hidden></div>

                    <button class="sidebar-item" id="sidebar-settings" tabindex="0" data-path="/settings">
                        <div class="item-icon">
                            ${sidebarIcons.settings}
                        </div>
                        <span class="item-text" data-i18n="Settings">Settings</span>
                    </button>
                </div>

                <!-- Footer Section (User Profile pinned at the very bottom in Modern) -->
                <div class="sidebar-footer" id="sidebar-footer">
                    <!-- User Profile -->
                    <button class="sidebar-item user-profile-btn" id="sidebar-user" tabindex="0">
                        <div class="item-icon user-avatar-container">
                            ${this._renderUserAvatar()}
                        </div>
                        <span class="item-text sidebar-user-name">${this._getUserName()}</span>
                    </button>
                </div>

                <!-- Sliding Focus Indicator -->
                <div class="sidebar-focus-indicator"></div>
            </nav>
        `;
    }

    onMounted() {
        this._bindEvents();
        this._loadLibraries().then(() => this._updateSeerrVisibility());
        this._updateActiveState();

        // Hydrate DOM with translations
        i18n.translateDOM(this.el);

        // Listen for auth events to update user profile
        eventBus.on('auth:login', this._onAuthChange.bind(this));
        eventBus.on('auth:logout', this._onAuthChange.bind(this));
        eventBus.on('auth:restored', this._onAuthChange.bind(this));

        // Listen for SyncPlay state changes to update the sidebar button
        this._onSyncPlayEnabled = () => this._updateSyncPlayBtn(true);
        this._onSyncPlayDisabled = () => this._updateSyncPlayBtn(false);
        eventBus.on('syncplay:enabled', this._onSyncPlayEnabled);
        eventBus.on('syncplay:disabled', this._onSyncPlayDisabled);

        // Initialize visibility in case the plugin is disabled at startup
        // The default active state is retrieved dynamically from the Manager if it exists,
        //. but fallback to false if it hasn't started yet.
        this._updateSyncPlayBtn(window.__syncPlayManager?.isActive || false);

        // Sidebar Logo clickability configuration
        this._updateLogoSettings();
        this._onLogoSettingsChanged = () => this._updateLogoSettings();
        eventBus.on('pref:logoSettings', this._onLogoSettingsChanged);

        this._updateSidebarItemsAlign();
        this._onSidebarItemsAlignChanged = () => this._updateSidebarItemsAlign();
        eventBus.on('pref:sidebarItemsAlign', this._onSidebarItemsAlignChanged);

        this._updateAnimationMode();
        this._onAnimationModeChanged = () => this._updateAnimationMode();
        eventBus.on('prefChanged:disableSidebarAnimation', this._onAnimationModeChanged);

        // ---------------------------------------------------------------------
        // COLLAPSED SIDEBAR LIBRARY SHORTCUT ICONS CONFIGURATION
        // ---------------------------------------------------------------------
        // Read the user preference for collapsed library shortcuts. If enabled,
        // we append the reactive class 'show-lib-icons-collapsed' directly to the
        // root sidebar container. Register event bus subscription to listen for
        // user changes dynamically and perform clean layout hot-reloads.
        // ---------------------------------------------------------------------
        const showLibIcons = storage.getItem('pref:showCollapsedLibraryIcons') === 'true';
        this.el.classList.toggle('show-lib-icons-collapsed', showLibIcons);

        this._onShowLibIconsChanged = (newValue) => {
            const enabled = newValue === true || newValue === 'true';
            this.el.classList.toggle('show-lib-icons-collapsed', enabled);
            // Re-apply DOM layout to refresh cache
            this._applySidebarLayout();
        };
        eventBus.on('prefChanged:showCollapsedLibraryIcons', this._onShowLibIconsChanged);

        // ---------------------------------------------------------------------
        // COLLAPSED SIDEBAR BACKGROUND CONFIGURATION
        // ---------------------------------------------------------------------
        this.activePath = router.getCurrentPath() || '';
        this._updateTransparentCollapsed();

        this._onTransparentCollapsedChanged = () => {
            this._updateTransparentCollapsed();
        };
        eventBus.on('pref:collapsedSidebarColor', this._onTransparentCollapsedChanged);
        eventBus.on('pref:expandedSidebarColor', this._onTransparentCollapsedChanged);

        this._onHideLibraryHeaderChanged = () => {
            this._loadLibraries();
        };
        eventBus.on('prefChanged:hideSidebarLibraryHeader', this._onHideLibraryHeaderChanged);

        // ── Sidebar Layout customization ──────────────────────────────────────
        // Hot-reload the sidebar layout when the user saves changes in Settings.
        this._onSidebarLayoutChanged = () => {
            // Re-apply order/visibility and update the default focus target
            this._applySidebarLayout();
        };
        eventBus.on('prefChanged:sidebarLayout', this._onSidebarLayoutChanged);

        // Listen for layout mode switches (classic vs modern)
        this._onSidebarLayoutModeChanged = () => {
            this._loadLibraries();
        };
        eventBus.on('sidebarLayout:changed', this._onSidebarLayoutModeChanged);

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
                const backDirection = isRtl ? 'right' : 'left';

                // Handle D-pad navigation inside Modern Collapsed floating libraries popover
                if (layoutManager.isModernCollapsedSidebarLayout() && this.floatingLibrariesOpen) {
                    const subLibs = this.el.querySelector('#sidebar-sub-libraries');
                    if (subLibs && subLibs.contains(focusedEl)) {
                        // Pressing Left (or Right in RTL) returns to Libraries button and closes popover
                        if (direction === backDirection) {
                            this._toggleFloatingLibraries(false);
                            return true;
                        }
                        // Pressing Right (or Left in RTL) exits to page content and closes popover
                        if (direction === exitDirection) {
                            this._toggleFloatingLibraries(false);
                        }
                    }
                }

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

    async _updateSeerrVisibility() {
        const button = this.$('#sidebar-discover');
        if (!button) return;

        const isAvailable = await seerr.isAvailable();
        button.style.display = isAvailable ? '' : 'none';
        focusManager.invalidateCache('sidebar');
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
        if (this._onSyncPlayEnabled) eventBus.off('syncplay:enabled', this._onSyncPlayEnabled);
        if (this._onSyncPlayDisabled) eventBus.off('syncplay:disabled', this._onSyncPlayDisabled);

        // Remove sidebar layout hot-reload listener
        if (this._onSidebarLayoutChanged) {
            eventBus.off('prefChanged:sidebarLayout', this._onSidebarLayoutChanged);
        }

        if (this._onSidebarLayoutModeChanged) {
            eventBus.off('sidebarLayout:changed', this._onSidebarLayoutModeChanged);
        }

        if (this._onLogoSettingsChanged) {
            eventBus.off('pref:logoSettings', this._onLogoSettingsChanged);
        }

        if (this._onAnimationModeChanged) {
            eventBus.off('prefChanged:disableSidebarAnimation', this._onAnimationModeChanged);
        }

        // Unsubscribe from preference change events cleanly
        if (this._onShowLibIconsChanged) {
            eventBus.off('prefChanged:showCollapsedLibraryIcons', this._onShowLibIconsChanged);
        }

        if (this._onTransparentCollapsedChanged) {
            eventBus.off('pref:collapsedSidebarColor', this._onTransparentCollapsedChanged);
            eventBus.off('pref:expandedSidebarColor', this._onTransparentCollapsedChanged);
        }

        if (this._onHideLibraryHeaderChanged) {
            eventBus.off('prefChanged:hideSidebarLibraryHeader', this._onHideLibraryHeaderChanged);
        }

        if (this._onSidebarItemsAlignChanged) {
            eventBus.off('pref:sidebarItemsAlign', this._onSidebarItemsAlignChanged);
        }

        // Clean up floating popover event listeners
        if (this._onBackFloatingLibs) {
            eventBus.off('key:back', this._onBackFloatingLibs);
        }
        if (this._onDocKeyDown) {
            document.removeEventListener('keydown', this._onDocKeyDown, true);
        }
        if (this._onDocClickOutside) {
            document.removeEventListener('mousedown', this._onDocClickOutside, true);
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
            const nameSpan = userBtn.querySelector('.sidebar-user-name');
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
        // Re-evaluate alignment once visibility changes (resolving clientHeight 0 state)
        setTimeout(() => this._updateSidebarItemsAlign(), 0);
    }

    _updateLogoSettings() {
        let logoPref = storage.getItem('pref:logoSettings') || 'visible';
        // Migrate old boolean values
        if (logoPref === 'true') {
            logoPref = 'settings';
        } else if (logoPref === 'false') {
            logoPref = 'visible';
        }

        const logoHeader = this.el.querySelector('#sidebar-logo-header');
        const settingsBtn = this.el.querySelector('#sidebar-settings');
        const homeBtn = this.el.querySelector('#sidebar-home');

        if (logoHeader) {
            // Determine if logo is visible
            const isLogoVisible = logoPref !== 'hidden';
            logoHeader.style.display = isLogoVisible ? '' : 'none';

            // Clickable status for logo
            const isClickable = logoPref === 'settings' || logoPref === 'home';
            logoHeader.classList.toggle('sidebar-item', isClickable);
            logoHeader.setAttribute('data-focusable', isClickable.toString());
            logoHeader.setAttribute('tabindex', isClickable ? '0' : '-1');

            if (logoPref === 'settings') {
                logoHeader.dataset.path = '/settings';
            } else if (logoPref === 'home') {
                logoHeader.dataset.path = '/home';
            } else {
                delete logoHeader.dataset.path;
            }

            // Show/hide settings button
            if (settingsBtn) {
                settingsBtn.classList.toggle('hidden', logoPref === 'settings');
            }

            // Show/hide home button
            if (homeBtn) {
                homeBtn.classList.toggle('hidden', logoPref === 'home');
            }

            // Invalidate cache since focusability of a header element changed
            focusManager.invalidateCache('sidebar');
        }
    }

    /**
     * Update sidebar animation mode based on user preference
     * @private
     */
    _updateAnimationMode() {
        const disabled = storage.getItem('pref:disableSidebarAnimation') === 'true';
        this.el.classList.toggle('no-animation', disabled);
    }

    /**
     * Bind interaction handlers to a sidebar item.
     * Uses onmousedown for snappy mouse/pointer response and onclick for D-pad.
     * Includes a 400ms debounce to prevent double-activation on WebOS Magic Remote,
     * where a pointer click synthesizes a mousedown followed by a key:enter.
     * @param {HTMLElement} el - Item element
     * @param {Function} callback - Activation handler
     * @private
     */
    _bindItem(el, callback) {
        if (!el) return;

        let lastActiveTime = 0;
        const handleActivate = (e) => {
            const now = Date.now();
            if (now - lastActiveTime < 400) return;
            lastActiveTime = now;

            callback(e);
        };

        // Pointer/Magic Remote: snap to mousedown for zero lag
        el.onmousedown = (e) => {
            if (e.button === 0) {
                // Left click only
                handleActivate(e);
            }
        };

        // D-pad/Synthetic: fallback to onclick
        el.onclick = (e) => {
            handleActivate(e);
        };
    }

    _bindEvents() {
        if (!this.el) return;

        // MutationObserver to watch for focus changes (used to expand/collapse sidebar)
        if (!this._focusObserver) {
            this._focusObserver = new MutationObserver((mutations) => {
                // ── Feedback-loop guard ───────────────────────────────────────
                // The MutationObserver watches the entire sidebar subtree, which
                // includes this.el itself. When _expand() toggles 'expanded' /
                // 'collapsed' / 'has-focus' on the root nav element, that class
                // change fires this callback. If we don't bail here, the callback
                // sees a .focused child item and immediately re-expands, undoing
                // the collapse — the visible "fading then returning" bug.
                //
                // Rule: only react to class changes on *child* elements (the
                // sidebar items). Mutations on the root element are always caused
                // by _expand() itself and must be ignored to break the loop.
                const hasChildMutation = mutations.some((m) => m.target !== this.el);
                if (!hasChildMutation) return;

                const focusedItem = this.el.querySelector('.focused');
                const hasFocus = !!focusedItem;

                if (focusedItem) {
                    // Automatically scroll the sidebar container so the newly focused item is in view
                    focusedItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                }

                // Update indicator FIRST while transition is still disabled (collapsed state)
                // to ensure it snaps to the correct position before we expand.
                this._updateIndicator(focusedItem);

                // Then handle expansion — but ONLY via D-pad/keyboard focus paths.
                // When the mouse is hovering, hover already opened the sidebar and
                // we must NOT let the MutationObserver re-expand it on mouseleave
                // (which clears .focused). The _expandedByMouse flag separates
                // the two independent open mechanisms cleanly.
                if (!this._expandedByMouse) {
                    if (hasFocus) {
                        this._expand(true);
                    } else {
                        this._expand(false);
                    }
                }
            });

            this._focusObserver.observe(this.el, {
                attributes: true,
                subtree: true,
                attributeFilter: ['class']
            });
        }

        // ── Mouse hover expand/collapse ───────────────────────────────────
        // mouseenter always expands; mouseleave always collapses — no guards.
        //
        // Why no guards? The previous `.focused` check caused the sidebar to
        // get stuck open after any click (FocusManager stamps .focused on the
        // clicked item, leaving the check permanently true). The `_expandedByMouse`
        // flag was a better attempt but still fails on double-click: a spurious
        // mouseleave event (triggered mid-click by page transitions) clears the
        // flag, putting the MutationObserver back in control with .focused set.
        //
        // The correct mental model:
        //   • Mouse physically leaving the sidebar = always collapse. Period.
        //   • D-pad entering the sidebar = MutationObserver handles expand/collapse.
        //   • Both paths are mutually exclusive in practice (D-pad users don't hover).
        this.el.addEventListener('mouseenter', () => {
            this._expandedByMouse = true;
            this._expand(true);
        });
        this.el.addEventListener('mouseleave', () => {
            // Always collapse when the mouse leaves — no .focused guard, no flag check.
            // If the user is navigating via D-pad, this event never fires so D-pad
            // behaviour is completely unaffected.
            this._expandedByMouse = false;
            this._expand(false);
        });

        // Logo click handler
        this._bindItem(this.el.querySelector('#sidebar-logo-header'), () => {
            router.navigate('/settings');
        });

        // Navigation Clicks for other standard items
        const items = this.el.querySelectorAll('.sidebar-item');
        items.forEach((item) => {
            if (item.id === 'sidebar-logo-header') return; // Handled above
            if (item.id === 'sidebar-libraries') return; // Handled by accordion toggle

            this._bindItem(item, () => {
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
                } else if (item.id === 'sidebar-syncplay') {
                    // Open the SyncPlay group menu overlay (works from any screen)
                    syncPlayGroupMenu.open();
                } else if (item.id === 'sidebar-random') {
                    this._onRandomClick();
                } else if (item.id === 'sidebar-logout') {
                    // AuthManager.logout() handles the routing based on remaining sessions:
                    //   • Other sessions remain → auth:switchToProfiles → App.js routes to /profiles
                    //   • No sessions remain    → auth:logout           → App.js routes to /login
                    // auth.logout();
                }
            });
        });

        // Libraries accordion toggle button handler
        const librariesBtn = this.el.querySelector('#sidebar-libraries');
        if (librariesBtn) {
            this._bindItem(librariesBtn, () => {
                if (layoutManager.isModernCollapsedSidebarLayout()) {
                    this._toggleFloatingLibraries();
                    return;
                }
                if (!this.expanded) {
                    this._expandedByMouse = true;
                    this._expand(true);
                    this._toggleLibraries(true);
                } else {
                    this._toggleLibraries();
                }
            });
        }

        // Back key listener for floating libraries popover in modern-collapsed
        this._onBackFloatingLibs = () => {
            if (layoutManager.isModernCollapsedSidebarLayout() && this.floatingLibrariesOpen) {
                this._toggleFloatingLibraries(false);
                return true;
            }
            return false;
        };
        eventBus.on('key:back', this._onBackFloatingLibs);

        // Document keydown for Escape / Remote Back
        this._onDocKeyDown = (e) => {
            if (layoutManager.isModernCollapsedSidebarLayout() && this.floatingLibrariesOpen) {
                if (e.key === 'Escape' || e.keyCode === 10009 || e.keyCode === 27) {
                    this._toggleFloatingLibraries(false);
                    e.preventDefault();
                    e.stopPropagation();
                }
            }
        };
        document.addEventListener('keydown', this._onDocKeyDown, true);

        // Click outside floating popover to dismiss
        this._onDocClickOutside = (e) => {
            if (layoutManager.isModernCollapsedSidebarLayout() && this.floatingLibrariesOpen) {
                const subLibs = this.el.querySelector('#sidebar-sub-libraries');
                const libBtn = this.el.querySelector('#sidebar-libraries');
                if (subLibs && !subLibs.contains(e.target) && libBtn && !libBtn.contains(e.target)) {
                    this._toggleFloatingLibraries(false);
                }
            }
        };
        document.addEventListener('mousedown', this._onDocClickOutside, true);

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
        if (storage.getItem('pref:sidebarMode') === 'collapsed' || layoutManager.isModernCollapsedSidebarLayout()) {
            expanded = false;
        }
        if (this.expanded === expanded) return;
        this.expanded = expanded;

        this.el.classList.toggle('expanded', expanded);
        this.el.classList.toggle('collapsed', !expanded);

        // Recheck items alignment since library visibility changes between collapsed and expanded states
        this._updateSidebarItemsAlign();
        setTimeout(() => this._updateSidebarItemsAlign(), 0);

        // ====================================================================
        // COLLAPSE VISUAL RESET
        // ====================================================================
        // When collapsing, we must ensure all focus indicators and focus state
        // classes are immediately removed from the sidebar DOM elements.
        // --------------------------------------------------------------------
        if (!expanded) {
            // Hide the sliding focus indicator wrapper
            this.el.classList.remove('has-focus');

            // Strip the .focused class from all sidebar items (static and library ones).
            // This is critical when double-clicking or clicking the already-active
            // sidebar button: since the router doesn't navigate to a different hash,
            // the focus never shifts to a page element, leaving the sidebar item
            // permanently marked as focused. Removing it here restores the clean,
            // unselected collapsed state visually.
            this.el.querySelectorAll('.focused').forEach((el) => {
                el.classList.remove('focused');
            });

            // ====================================================================
            // NATIVE BROWSER FOCUS DEFEAT
            // ====================================================================
            // When mouse-clicking a sidebar item, the browser applies native focus
            // to the clicked button element. When the sidebar collapses, this native
            // focus remains, triggering theme selectors like `.sidebar-item:focus`
            // (often with !important). Blurring it removes the native :focus state.
            // --------------------------------------------------------------------
            if (this.el.contains(document.activeElement)) {
                document.activeElement.blur();
            }

            // If not active on a library page, auto-close the libraries accordion on sidebar collapse
            const isModern = !layoutManager.isClassicSidebarLayout();
            const isLibraryActive = this.activePath && (this.activePath.startsWith('/library/') || !!this.el.querySelector('.library-item.active'));
            if (isModern && !isLibraryActive && this.librariesExpanded) {
                this._toggleLibraries(false);
            }

            // In collapsed mode, child library items must never receive focus
            const subLibs = this.el.querySelector('#sidebar-sub-libraries');
            if (subLibs) {
                subLibs.style.display = 'none';
                subLibs.classList.add('hidden');
                subLibs.setAttribute('hidden', '');
                subLibs.querySelectorAll('.library-item').forEach((btn) => {
                    btn.classList.add('hidden');
                    btn.style.display = 'none';
                    btn.tabIndex = -1;
                    btn.classList.remove('focused');
                });
            }
            focusManager.invalidateCache('sidebar');
        } else {
            // When expanded, if libraries accordion is open (or if currently in a library route), restore focusability
            const isModern = !layoutManager.isClassicSidebarLayout();
            const isLibraryActive = this.activePath && (this.activePath.startsWith('/library/') || !!this.el.querySelector('.library-item.active'));
            if (isModern && isLibraryActive && !this.librariesExpanded) {
                this._toggleLibraries(true);
            } else if (this.librariesExpanded) {
                const subLibs = this.el.querySelector('#sidebar-sub-libraries');
                if (subLibs) {
                    subLibs.style.display = 'flex';
                    subLibs.classList.remove('hidden');
                    subLibs.removeAttribute('hidden');
                    subLibs.querySelectorAll('.library-item').forEach((btn) => {
                        btn.classList.remove('hidden');
                        btn.style.display = '';
                        btn.tabIndex = 0;
                    });
                }
                focusManager.invalidateCache('sidebar');
            }
        }

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

            const subContainer = this.el.querySelector('#sidebar-sub-libraries');
            if (subContainer) subContainer.innerHTML = '';

            // Remove any previously rendered libraries and headers to allow clean reloading
            sidebarContent.querySelectorAll('.library-item, .sidebar-section-header').forEach((el) => el.remove());

            const isModern = !layoutManager.isClassicSidebarLayout();
            const hideHeader = storage.getItem('pref:hideSidebarLibraryHeader') === 'true';

            if (!isModern && items.length > 0 && !hideHeader) {
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
                const canFocus = isModern ? (this.expanded && this.librariesExpanded) : true;
                btn.tabIndex = canFocus ? 0 : -1;

                if (isModern && !this.librariesExpanded) {
                    btn.classList.add('hidden');
                    btn.style.display = 'none';
                }

                // Route livetv to the unified Live TV page
                const isLiveTv = lib.CollectionType === 'livetv';
                const buttonPath = isLiveTv ? '/livetv' : `/library/${lib.Id}`;

                // Attach both the path (for nav) AND a layout-id so _applySidebarLayout
                // can match this button against the saved config (id: 'lib-{Id}')
                btn.dataset.path = buttonPath;
                btn.dataset.layoutId = `lib-${lib.Id}`;
                btn.innerHTML = `
                    <div class="item-icon">
                        ${getLibraryIcon(lib.CollectionType)}
                    </div>
                    <span class="item-text">${lib.Name}</span>
                `;

                this._bindItem(btn, () => {
                    if (layoutManager.isModernCollapsedSidebarLayout() && this.floatingLibrariesOpen) {
                        this._toggleFloatingLibraries(false);
                    }
                    router.navigate(buttonPath);
                });

                if (isModern && subContainer) {
                    subContainer.appendChild(btn);
                } else {
                    sidebarContent.appendChild(btn);
                }
            });

            /*
             * After building all library buttons, re-apply the sidebar layout so
             * newly loaded library items are placed in their saved position and
             * any that the user has hidden are correctly suppressed.
             */
            this._applySidebarLayout();
            this._updateActiveState();

            // Re-evaluate alignment now that libraries are loaded and overflow metrics are active
            setTimeout(() => this._updateSidebarItemsAlign(), 0);

            // Invalidate focus manager cache to discover dynamically added libraries
            focusManager.resetDOMCache();
        } catch (e) {
            log.warn('Failed to load libraries', e);
        }
    }

    /**
     * Toggles the floating libraries popover window in Modern Collapsed layout.
     * Follows Apple HIG popover presentation principles with instant feedback and focus trapping.
     * @param {boolean|null} forceState
     * @private
     */
    _toggleFloatingLibraries(forceState = null) {
        const subLibs = this.el.querySelector('#sidebar-sub-libraries');
        const libBtn = this.el.querySelector('#sidebar-libraries');
        if (!subLibs || !libBtn) return;

        // If parent button is hidden, force-close and prevent opening
        if (libBtn.style.display === 'none' || libBtn.hasAttribute('hidden')) {
            this.floatingLibrariesOpen = false;
            subLibs.classList.remove('open');
            subLibs.classList.add('hidden');
            subLibs.style.display = 'none';
            subLibs.setAttribute('hidden', '');
            return;
        }

        const next = forceState !== null ? forceState : !this.floatingLibrariesOpen;
        this.floatingLibrariesOpen = next;

        subLibs.classList.toggle('open', next);
        subLibs.classList.toggle('hidden', !next);
        libBtn.classList.toggle('open', next);

        const childBtns = subLibs.querySelectorAll('.library-item');

        if (next) {
            subLibs.removeAttribute('hidden');
            subLibs.style.display = 'flex';

            // Calculate vertical positioning beside the libraries button inside .sidebar-content
            const topOffset = typeof libBtn.offsetTop === 'number' ? libBtn.offsetTop : 150;
            subLibs.style.top = `${Math.max(10, topOffset - 6)}px`;

            childBtns.forEach((btn) => {
                btn.classList.remove('hidden');
                btn.style.display = 'flex';
                btn.tabIndex = 0;
            });

            // Refresh DOM focus cache
            focusManager.resetDOMCache();
            focusManager.invalidateCache('sidebar');

            // Set active focus inside floating window
            const activeLib = subLibs.querySelector('.library-item.active') || childBtns[0];
            if (activeLib) {
                activeLib.focus();
            }
        } else {
            const wasFocusInside = subLibs.contains(document.activeElement);

            subLibs.setAttribute('hidden', '');
            subLibs.style.display = 'none';
            childBtns.forEach((btn) => {
                btn.classList.add('hidden');
                btn.style.display = 'none';
                btn.tabIndex = -1;
                btn.classList.remove('focused');
            });

            // Clear inline style
            subLibs.style.top = '';

            focusManager.resetDOMCache();
            focusManager.invalidateCache('sidebar');

            // Only restore focus to libBtn if focus was actually inside the popover
            if (wasFocusInside) {
                libBtn.focus();
            }
        }
    }

    /**
     * Checks if the floating libraries window is currently open.
     * @returns {boolean}
     */
    isFloatingLibrariesOpen() {
        return !!this.floatingLibrariesOpen;
    }

    /**
     * Closes the floating libraries popover if open.
     */
    closeFloatingLibraries() {
        if (this.floatingLibrariesOpen) {
            this._toggleFloatingLibraries(false);
        }
    }

    /**
     * Toggles the open/collapsed state of the sub-libraries list in Modern layout.
     * @param {boolean|null} forceState
     * @private
     */
    _toggleLibraries(forceState = null) {
        const subLibs = this.el.querySelector('#sidebar-sub-libraries');
        const libBtn = this.el.querySelector('#sidebar-libraries');
        if (!subLibs || !libBtn) return;

        // If parent libraries button is hidden, force-close and prevent opening
        if (libBtn.style.display === 'none' || libBtn.hasAttribute('hidden')) {
            this.librariesExpanded = false;
            subLibs.classList.remove('open');
            subLibs.classList.add('hidden');
            subLibs.style.display = 'none';
            subLibs.setAttribute('hidden', '');
            return;
        }

        const next = forceState !== null ? forceState : !this.librariesExpanded;
        this.librariesExpanded = next;

        subLibs.classList.toggle('open', next);
        subLibs.classList.toggle('hidden', !next);
        libBtn.classList.toggle('open', next);

        // Update tabindex, visibility classes, and display on child library buttons
        const childBtns = subLibs.querySelectorAll('.library-item');
        if (next) {
            subLibs.removeAttribute('hidden');
            subLibs.style.display = 'flex';
            childBtns.forEach((btn) => {
                btn.classList.remove('hidden');
                btn.style.display = '';
                btn.tabIndex = this.expanded ? 0 : -1;
            });
        } else {
            subLibs.setAttribute('hidden', '');
            subLibs.style.display = 'none';
            childBtns.forEach((btn) => {
                btn.classList.add('hidden');
                btn.style.display = 'none';
                btn.tabIndex = -1;
                btn.classList.remove('focused');
            });
        }

        // Re-evaluate alignment metrics and refresh focus manager cache
        this._updateSidebarItemsAlign();
        focusManager.invalidateCache('sidebar');
    }

    _renderUserAvatar() {
        const user = auth.getCurrentUser();
        if (user && user.PrimaryImageTag) {
            const url = api.getUserImageUrl(user.Id, { maxWidth: 50 });
            return `<img src="${url}" class="sidebar-avatar" />`;
        }
        return sidebarIcons.userDefault;
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
        const btn = this.el.querySelector('#sidebar-syncplay');
        const dot = this.el.querySelector('#sidebar-syncplay-dot');
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
        this._updateTransparentCollapsed();
        setTimeout(() => this._updateSidebarItemsAlign(), 0);
    }

    _updateTransparentCollapsed() {
        const colorPref = storage.getItem('pref:collapsedSidebarColor') || 'theme';
        const expandedColorPref = storage.getItem('pref:expandedSidebarColor') || 'theme';
        this.el.classList.toggle('transparent-collapsed', colorPref === 'transparent');
        this.el.classList.toggle('semi-transparent-collapsed', colorPref === 'semi');
        this.el.classList.toggle('tinted-semi-collapsed', colorPref === 'tinted-semi');
        this.el.classList.toggle('black-collapsed', colorPref === 'black');
        this.el.classList.toggle('transparent-expanded', expandedColorPref === 'transparent');
        this.el.classList.toggle('semi-transparent-expanded', expandedColorPref === 'semi');
        this.el.classList.toggle('tinted-semi-expanded', expandedColorPref === 'tinted-semi');
        this.el.classList.toggle('black-expanded', expandedColorPref === 'black');
    }

    _updateSidebarItemsAlign() {
        const alignPref = storage.getItem('pref:sidebarItemsAlign') || 'center';
        const scrollContainer = this.el.querySelector('.sidebar-content');

        let shouldAlign = false;
        if (alignPref !== 'top' && scrollContainer) {
            // Check if all sidebar items fit inside the scrollable view without overflow
            const hasOverflow = scrollContainer.scrollHeight > scrollContainer.clientHeight;
            shouldAlign = !hasOverflow;
        }

        const prevCenter = this.el.classList.contains('align-center');
        const prevBottom = this.el.classList.contains('align-bottom');

        this.el.classList.toggle('align-center', alignPref === 'center' && shouldAlign);
        this.el.classList.toggle('align-bottom', alignPref === 'bottom' && shouldAlign);

        const focused = this.el.querySelector('.sidebar-item.focused');
        if (focused) {
            // Update immediately for engines that reflow synchronously
            this._updateIndicator(focused, { instant: true });
            // And defer a 50ms update to ensure the TV rendering layout paint has fully settled
            setTimeout(() => {
                this._updateIndicator(focused, { instant: true });
            }, 50);
        }
    }

    _updateActiveState() {
        const isModern = !layoutManager.isClassicSidebarLayout();
        const items = this.el.querySelectorAll('.sidebar-item');
        let hasActiveLibrary = false;

        items.forEach((item) => {
            if (item.id === 'sidebar-libraries') return; // Handled separately below
            const itemPath = item.dataset.path;
            if (itemPath && this.activePath.startsWith(itemPath)) {
                // Approximate match (e.g. /home matches /home)
                // Exception: /library/:id needs exact start logic
                item.classList.add('active');
                if (item.classList.contains('library-item')) {
                    hasActiveLibrary = true;
                }
            } else {
                item.classList.remove('active');
            }
        });

        // In Modern mode, if any library is active, highlight the parent Libraries toggle button as active too
        const libToggle = this.el.querySelector('#sidebar-libraries');
        if (libToggle) {
            libToggle.classList.toggle('active', isModern && hasActiveLibrary);
            if (isModern) {
                if (layoutManager.isModernCollapsedSidebarLayout()) {
                    if (this.floatingLibrariesOpen) {
                        this._toggleFloatingLibraries(false);
                    }
                } else if (hasActiveLibrary) {
                    // When in an active library route, keep libraries accordion open
                    this._toggleLibraries(true);
                } else if (this.librariesExpanded && !this.expanded) {
                    // If not on an active library route and sidebar is collapsed, close it
                    this._toggleLibraries(false);
                }
            }
        }
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
                indicator.style.height = `${targetRect.height}px`;
                // Force reflow to ensure the style is applied before transition is re-enabled
                indicator.offsetHeight;
                indicator.style.webkitTransition = '';
                indicator.style.transition = '';
            } else {
                indicator.style.webkitTransform = `translate3d(0, ${y}px, 0)`;
                indicator.style.transform = `translate3d(0, ${y}px, 0)`;
                indicator.style.height = `${targetRect.height}px`;
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

        const isModern = !layoutManager.isClassicSidebarLayout();
        const subLibrariesContainer = sidebarEl.querySelector('#sidebar-sub-libraries');
        const librariesToggleBtn = sidebarEl.querySelector('#sidebar-libraries');
        const sidebarFooter = sidebarEl.querySelector('#sidebar-footer');

        /* ── 1. Collect all sidebar items with their layout IDs ────────────── */
        const allItems = [];

        // Collect everything from .sidebar-content, #sidebar-sub-libraries, and #sidebar-footer
        const items = sidebarEl.querySelectorAll('.sidebar-item, .sidebar-section-header');
        items.forEach((el) => {
            if (el.id === 'sidebar-logo-header') return;

            if (el.classList.contains('library-item')) {
                // It's a dynamically injected library
                allItems.push({ id: el.dataset.layoutId, el: el });
            } else if (el.id === 'section-header') {
                // It's the classic library section header
                allItems.push({ id: 'section-header', el: el });
            } else if (el.id === 'sidebar-libraries') {
                // It's the modern libraries accordion toggle
                allItems.push({ id: 'librariesContainer', el: el });
            } else {
                // It's a static navigation item
                const rawId = el.id ? el.id.replace('sidebar-', '') : null;
                if (rawId) allItems.push({ id: rawId, el: el });
            }
        });

        /* ── 2. Ask the manager to order and annotate items ────────────────── */
        const ordered = sidebarLayoutManager.applyLayout(allItems);

        /* ── 3. Re-insert items and apply visibility ───────────────────────── */
        if (isModern) {
            // Modern Mode: Single expandable item + nested sub-libraries container + pinned footer
            if (librariesToggleBtn) {
                librariesToggleBtn.style.display = '';
            }

            ordered.forEach(({ id, el, hidden }) => {
                if (!el) return;

                if (id === 'section-header') {
                    el.style.display = 'none';
                    return;
                }

                if (id.startsWith('lib-')) {
                    // Place child library inside the sub-libraries container
                    const canFocus = this.expanded && this.librariesExpanded;
                    el.tabIndex = canFocus ? 0 : -1;
                    if (isModern && !this.librariesExpanded) {
                        el.classList.add('hidden');
                        el.style.display = 'none';
                    } else {
                        el.classList.toggle('hidden', !!hidden);
                        el.style.display = hidden ? 'none' : '';
                    }
                    if (subLibrariesContainer) {
                        subLibrariesContainer.appendChild(el);
                    }
                    return;
                }

                if (id === 'user') {
                    // In Modern mode, pin user profile in the dedicated sidebar-footer at the bottom
                    if (sidebarFooter) {
                        sidebarFooter.appendChild(el);
                    }
                    el.style.display = hidden ? 'none' : '';
                    return;
                }

                const isSyncPlay = id === 'syncplay';
                const pluginHidden = isSyncPlay && !pluginManager.isEnabled('syncplay');
                const shouldHide = hidden || pluginHidden;

                el.style.display = shouldHide ? 'none' : '';
                sidebarContent.appendChild(el);

                // If this is the modern libraries container, place sub-libraries container right after it
                if (id === 'librariesContainer' && subLibrariesContainer) {
                    if (shouldHide) {
                        subLibrariesContainer.style.display = 'none';
                        subLibrariesContainer.classList.add('hidden');
                        subLibrariesContainer.setAttribute('hidden', '');
                    }
                    sidebarContent.appendChild(subLibrariesContainer);
                }
            });
        } else {
            // Classic Mode: Flat list with section header
            if (librariesToggleBtn) librariesToggleBtn.style.display = 'none';
            if (subLibrariesContainer) subLibrariesContainer.style.display = 'none';

            ordered.forEach(({ id, el, hidden }) => {
                if (!el) return;

                if (id === 'librariesContainer') {
                    // Suppress modern toggle in classic mode
                    el.style.display = 'none';
                    return;
                }

                const isSyncPlay = id === 'syncplay';
                const pluginHidden = isSyncPlay && !pluginManager.isEnabled('syncplay');
                const shouldHide = hidden || pluginHidden;

                el.style.display = shouldHide ? 'none' : '';
                sidebarContent.appendChild(el);
            });
        }

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
