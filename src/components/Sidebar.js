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

const log = logger.create('Sidebar');

class Sidebar extends Component {
    constructor(options = {}) {
        super(options);

        this.expanded = false;
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
                    <!-- SyncPlay Section -->
                    <button class="sidebar-item sidebar-syncplay-btn" id="sidebar-syncplay" tabindex="0">
                        <div class="item-icon sidebar-syncplay-icon-wrap">
                            <!-- User Provided Icon (3 people) -->
                            ${sidebarIcons.syncplay}
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
                        <span class="item-text sidebar-user-name">${this._getUserName()}</span>
                    </button>

                    <button class="sidebar-item" id="sidebar-home" tabindex="0" data-path="/home">
                        <div class="item-icon">
                            ${sidebarIcons.home}
                        </div>
                        <span class="item-text" data-i18n="Home">Home</span>
                    </button>
                    
                    <button class="sidebar-item" id="sidebar-livetv" tabindex="0" data-path="/livetv">
                        <div class="item-icon">
                            ${sidebarIcons.livetv}
                        </div>
                        <span class="item-text" data-i18n="LiveTV">Live TV</span>
                    </button>

                    <button class="sidebar-item" id="sidebar-random" tabindex="0">
                        <div class="item-icon">
                            ${sidebarIcons.random}
                        </div>
                        <span class="item-text" data-i18n="Random">Random</span>
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

                    <button class="sidebar-item" id="sidebar-settings" tabindex="0" data-path="/settings">
                        <div class="item-icon">
                            ${sidebarIcons.settings}
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
        eventBus.on('prefChanged:logoSettings', this._onLogoSettingsChanged);

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
        // COLLAPSED SIDEBAR TRANSPARENT BACKGROUND CONFIGURATION
        // ---------------------------------------------------------------------
        this.activePath = router.getCurrentPath() || '';
        this._updateTransparentCollapsed();

        this._onTransparentCollapsedChanged = () => {
            this._updateTransparentCollapsed();
        };
        eventBus.on('prefChanged:transparentCollapsedSidebar', this._onTransparentCollapsedChanged);

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
        if (this._onSyncPlayEnabled) eventBus.off('syncplay:enabled', this._onSyncPlayEnabled);
        if (this._onSyncPlayDisabled) eventBus.off('syncplay:disabled', this._onSyncPlayDisabled);

        // Remove sidebar layout hot-reload listener
        if (this._onSidebarLayoutChanged) {
            eventBus.off('prefChanged:sidebarLayout', this._onSidebarLayoutChanged);
        }

        if (this._onLogoSettingsChanged) {
            eventBus.off('prefChanged:logoSettings', this._onLogoSettingsChanged);
        }

        if (this._onAnimationModeChanged) {
            eventBus.off('prefChanged:disableSidebarAnimation', this._onAnimationModeChanged);
        }

        // Unsubscribe from preference change events cleanly
        if (this._onShowLibIconsChanged) {
            eventBus.off('prefChanged:showCollapsedLibraryIcons', this._onShowLibIconsChanged);
        }

        if (this._onTransparentCollapsedChanged) {
            eventBus.off('prefChanged:transparentCollapsedSidebar', this._onTransparentCollapsedChanged);
        }

        if (this._onHideLibraryHeaderChanged) {
            eventBus.off('prefChanged:hideSidebarLibraryHeader', this._onHideLibraryHeaderChanged);
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
    }

    _updateLogoSettings() {
        // ---------------------------------------------------------------
        // Wrap entire function in try/catch — if ANY DOM call throws on
        // ultra-legacy WebKit (e.g. setAttribute with an unexpected type),
        // we must NOT silently swallow it and leave boot frozen.
        // ---------------------------------------------------------------
        try {
            const isEnabled = storage.getItem('pref:logoSettings') === 'true';
            const logoHeader = this.el.querySelector('#sidebar-logo-header');
            const settingsBtn = this.el.querySelector('#sidebar-settings');

            if (logoHeader) {
                // Toggle whether logo header acts as a focusable sidebar item
                logoHeader.classList.toggle('sidebar-item', isEnabled);
                logoHeader.setAttribute('data-focusable', isEnabled.toString());
                logoHeader.setAttribute('tabindex', isEnabled ? '0' : '-1');

                /*
                 * On older webOS web engines (like webOS 2.x), mutating or deleting
                 * properties on the dataset object directly can throw TypeErrors.
                 * We use standard setAttribute and removeAttribute calls instead.
                 */
                if (isEnabled) {
                    logoHeader.setAttribute('data-path', '/settings');
                    if (settingsBtn) settingsBtn.classList.add('hidden');
                } else {
                    logoHeader.removeAttribute('data-path');
                    if (settingsBtn) settingsBtn.classList.remove('hidden');
                }

                // Invalidate cache since focusability of a header element changed
                focusManager.invalidateCache('sidebar');
            }
        } catch (err) {
            log.error('Failed to update sidebar logo settings due to DOM error:', err);
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

            // Remove any previously rendered libraries and headers to allow clean reloading
            sidebarContent.querySelectorAll('.library-item, .sidebar-section-header').forEach((el) => el.remove());

            const hideHeader = storage.getItem('pref:hideSidebarLibraryHeader') === 'true';
            if (items.length > 0 && !hideHeader) {
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

                this._bindItem(btn, () => router.navigate(buttonPath));

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
    }

    _updateTransparentCollapsed() {
        const transparentCollapsed = storage.getItem('pref:transparentCollapsedSidebar') === 'true';
        const isSettings = (this.activePath || '').startsWith('/settings');
        this.el.classList.toggle('transparent-collapsed', transparentCollapsed && !isSettings);
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

            const contentContainer = this.el.querySelector('.sidebar-content');
            const scrollTop = contentContainer ? contentContainer.scrollTop : 0;

            // Compute offsetTop cumulatively relative to the main sidebar nav container.
            // Bypasses getBoundingClientRect() which yields unstable values during active CSS transform animations.
            let y = 0;
            let current = target;
            while (current && current !== this.el && current !== document.body) {
                y += current.offsetTop || 0;
                current = current.offsetParent;
            }

            // Compensate for the internal scroll position of the sidebar links list container
            if (contentContainer && contentContainer.contains(target)) {
                y -= scrollTop;
            }

            const targetHeight = target.offsetHeight || 72;

            if (forceInstant) {
                // Force an instant snap
                indicator.style.webkitTransition = 'none';
                indicator.style.transition = 'none';
                indicator.style.webkitTransform = `translate3d(0, ${y}px, 0)`;
                indicator.style.transform = `translate3d(0, ${y}px, 0)`;
                indicator.style.height = `${targetHeight}px`;
                // Force reflow to ensure the style is applied before transition is re-enabled
                indicator.offsetHeight;
                indicator.style.webkitTransition = '';
                indicator.style.transition = '';
            } else {
                indicator.style.webkitTransform = `translate3d(0, ${y}px, 0)`;
                indicator.style.transform = `translate3d(0, ${y}px, 0)`;
                indicator.style.height = `${targetHeight}px`;
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
        /*
         * Avoid using querySelectorAll with ':scope > ...' selector because the ':scope'
         * pseudo-class was introduced in Chrome 27. On Chromium 26 (webOS 1.x/2.x),
         * it throws a DOMException 12 (SyntaxError).
         * 
         * Instead, we manually iterate over the direct DOM children of sidebarContent
         * and filter by their classes ('sidebar-item' or 'sidebar-section-header').
         */
        const allItems = [];
        const children = sidebarContent.children;
        const len = children.length;

        /* Iterate over children elements using a safe traditional loop */
        for (let i = 0; i < len; i++) {
            const el = children[i];
            
            /* Verify if the element matches our target sidebar items */
            const isSidebarItem = el.classList.contains('sidebar-item');
            const isSectionHeader = el.classList.contains('sidebar-section-header');
            
            if (isSidebarItem || isSectionHeader) {
                if (el.classList.contains('library-item')) {
                    /* It's a dynamically injected library shortcut */
                    allItems.push({ id: el.dataset.layoutId, el: el });
                } else if (el.id === 'section-header') {
                    /* It's the library section header label */
                    allItems.push({ id: 'section-header', el: el });
                } else {
                    /* It's a static main navigation item (Home, Search, Settings, etc.) */
                    const rawId = el.id ? el.id.replace('sidebar-', '') : null;
                    if (rawId) {
                        allItems.push({ id: rawId, el: el });
                    }
                }
            }
        }

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
