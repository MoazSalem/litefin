/**
 * ============================================================================
 * Litefin Tizen - Profiles Page ("Who's Watching")
 * ============================================================================
 * Full-screen profile switcher page. Shown at startup when multiple sessions
 * are stored, or when the user clicks their name in the Sidebar.
 *
 * Design follows Apple Human Interface Guidelines:
 * - Large, generous avatar tiles spaced for easy TV navigation
 * - Muted accent-on-dark palette that lets avatars breathe
 * - Spring-style focus animations (cubic-bezier with overshoot)
 * - Confirmation dialog for destructive "Switch Server" action
 * - Graceful initial-letter fallback when no avatar image exists
 * ============================================================================
 */

import Page from './Page.js';
import { auth } from '../api/index.js';
import { api } from '../api/ApiClient.js';
import { router } from '../core/Router.js';
import { eventBus } from '../core/EventBus.js';
import { focusManager } from '../ui/FocusManager.js';
import { i18n } from '../utils/i18n.js';
import { logger } from '../utils/Logger.js';
import { imageService } from '../utils/ImageService.js';

const log = logger.create('ProfilesPage');

class ProfilesPage extends Page {
    constructor() {
        super();
        this.title = i18n.t('HeaderWhoIsWatching');

        // Whether a profile switch is in progress (prevents double-taps)
        this._isSwitching = false;

        // Whether the Switch Server dialog is visible
        this._dialogVisible = false;
    }

    render() {
        return `
            <div class="page profiles-page" id="profiles-page-root">

                <!-- Title -->
                <div class="profiles-header">
                    <h1 class="profiles-title" data-i18n="HeaderWhoIsWatching">
                        ${i18n.t('HeaderWhoIsWatching')}
                    </h1>
                </div>

                <!-- Profile grid — user cards + Add User card -->
                <div class="profiles-grid" id="profiles-grid" role="list">
                    <!-- Populated in onMounted -->
                </div>

                <!-- Bottom bar: Sign Out + Switch Server -->
                <div class="profiles-bottom">
                    <!-- Sign out the currently active user session only -->
                    <button
                        class="profiles-sign-out-btn focusable"
                        id="profiles-sign-out"
                        tabindex="0"
                        data-i18n="ButtonSignOut"
                    >
                        ${i18n.t('ButtonSignOut')}
                    </button>

                    <!-- Disconnect from the current server (sessions preserved) -->
                    <button
                        class="profiles-switch-server-btn focusable"
                        id="profiles-switch-server"
                        tabindex="0"
                        data-i18n="SwitchServer"
                    >
                        ${i18n.t('SwitchServer')}
                    </button>
                </div>

                <!-- Confirmation dialog overlay (hidden by default) -->
                <div class="modal-overlay profiles-dialog-overlay" id="profiles-dialog-overlay">
                    <div class="settings-modal profiles-dialog" id="profiles-dialog" role="dialog" aria-modal="true">
                        <div class="modal-header">
                            <h2 class="profiles-dialog-title" data-i18n="SignOutConfirmTitle">
                                ${i18n.t('SignOutConfirmTitle')}
                            </h2>
                        </div>
                        <div class="modal-options">
                            <p class="profiles-dialog-body" data-i18n="SignOutConfirmMessage">
                                ${i18n.t('SignOutConfirmMessage')}
                            </p>
                        </div>
                        <div class="modal-actions profiles-dialog-actions">
                            <button
                                class="profiles-dialog-btn profiles-dialog-cancel focusable"
                                id="profiles-dialog-cancel"
                                tabindex="0"
                                data-i18n="ButtonCancel"
                            >
                                ${i18n.t('ButtonCancel')}
                            </button>
                            <button
                                class="profiles-dialog-btn profiles-dialog-confirm focusable"
                                id="profiles-dialog-confirm"
                                tabindex="0"
                                data-i18n="ButtonYes"
                            >
                                ${i18n.t('ButtonYes')}
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    onMounted() {
        // Translate any i18n-tagged text nodes
        i18n.translateDOM(this.el);

        // Build the profile grid from current sessions
        this._renderGrid();

        // Wire up the bottom-bar and dialog buttons
        this._bindEvents();

        // Register focus sections for spatial navigation
        this._setupFocus();

        // Signal app to hide the splash screen
        eventBus.emit('app:hideSplash');
        log.info('ProfilesPage mounted');
    }

    /**
     * Build the grid of profile cards plus the "Add User" tile.
     * Called once on mount; re-called after a failed switch to refresh stale cards.
     */
    _renderGrid() {
        const grid = this.$('#profiles-grid');
        if (!grid) return;

        const sessions = auth.getSessions();

        // Build one card per stored session
        const cardsHtml = sessions.map((s) => this._renderProfileCard(s)).join('');

        // Append the fixed "Add User" card at the end
        const addUserHtml = `
            <div class="profiles-profile-item">
                <button
                    class="profiles-card profiles-add-card focusable"
                    id="profiles-add-user"
                    role="listitem"
                    tabindex="0"
                    data-i18n="AddUser"
                >
                    <div class="profiles-add-icon" aria-hidden="true">+</div>
                </button>
                <span class="profiles-card-name" data-i18n="AddUser">${i18n.t('AddUser')}</span>
            </div>
        `;

        grid.innerHTML = cardsHtml + addUserHtml;

        // Invalidate the focus cache so the new cards are picked up
        focusManager.invalidateCache('profiles-grid');
    }

    /**
     * Render a single profile card's HTML.
     * @param {{ userId, userName, primaryImageTag, accessToken }} session
     * @returns {string} HTML string
     */
    _renderProfileCard(session) {
        const initial = (session.userName || '?').charAt(0).toUpperCase();

        // Build avatar URL only if we have an image tag
        let avatarHtml;
        if (session.primaryImageTag) {
            const params = imageService.getParams('avatar');
            const imgUrl = api.getUserImageUrl(session.userId, { 
                maxWidth: params.maxWidth, 
                quality: params.quality 
            });
            avatarHtml = `
                <img
                    class="profiles-card-avatar"
                    src="${imgUrl}"
                    alt="${session.userName}"
                    onerror="this.classList.add('hidden'); this.nextElementSibling.classList.remove('hidden')"
                >
                <div class="profiles-card-initial hidden" aria-hidden="true">${initial}</div>
            `;
        } else {
            avatarHtml = `
                <img class="profiles-card-avatar hidden" src="" alt="">
                <div class="profiles-card-initial" aria-hidden="true">${initial}</div>
            `;
        }

        return `
            <div class="profiles-profile-item">
                <button
                    class="profiles-card focusable"
                    data-userid="${session.userId}"
                    role="listitem"
                    tabindex="0"
                    aria-label="${session.userName}"
                >
                    ${avatarHtml}
                </button>
                <span class="profiles-card-name">${session.userName || session.userId}</span>
            </div>
        `;
    }

    /**
     * Wire all click events — uses event delegation on the grid
     * so the handlers survive an innerHTML re-render.
     */
    _bindEvents() {
        const grid = this.$('#profiles-grid');
        if (grid) {
            /*
             * Delegated click: detect whether the clicked card is a profile
             * switch or the "Add User" button, and route accordingly.
             */
            grid.addEventListener('click', (e) => {
                // "Add User" tile
                if (e.target.closest('#profiles-add-user')) {
                    this._addUser();
                    return;
                }

                // Profile card — find the .profiles-card ancestor for the userId
                const card = e.target.closest('.profiles-card[data-userid]');
                if (card) {
                    this._switchToUser(card.dataset.userid);
                }
            });
        }

        // "Sign Out" button — opens confirmation dialog
        const signOutBtn = this.$('#profiles-sign-out');
        if (signOutBtn) {
            signOutBtn.addEventListener('click', () => this._showDialog());
        }

        // "Switch Server" button — disconnects immediately (sessions for ALL servers preserved)
        const switchServerBtn = this.$('#profiles-switch-server');
        if (switchServerBtn) {
            switchServerBtn.addEventListener('click', () => {
                auth.logoutAll();
            });
        }

        // Dialog: Cancel
        const cancelBtn = this.$('#profiles-dialog-cancel');
        if (cancelBtn) {
            cancelBtn.addEventListener('click', () => this._hideDialog());
        }

        // Dialog: Confirm → signs out ALL users on this server and forgets the server
        const confirmBtn = this.$('#profiles-dialog-confirm');
        if (confirmBtn) {
            confirmBtn.addEventListener('click', async () => {
                this._hideDialog();
                // This wipes all tokens for the active server and routes back to login (server selection)
                await auth.logoutAndForgetServer();
            });
        }
    }

    _setupFocus() {
        /*
         * The grid uses "grid" orientation so the spatial nav engine handles
         * both horizontal (between cards) and vertical (grid rows) movement.
         * leaveDown links to the bottom bar so D-pad Down from the last row
         * of cards lands on the "Switch Server" button.
         * The bottom bar uses leaveUp to return focus back to the grid.
         */
        this.registerFocusSection('profiles-grid', this.$('#profiles-grid'), {
            orientation: 'grid',
            leaveDown: 'profiles-bottom'
        });

        this.registerFocusSection('profiles-bottom', this.$('.profiles-bottom'), {
            orientation: 'horizontal',
            leaveUp: 'profiles-grid'
        });

        this.registerFocusSection('profiles-dialog', this.$('.profiles-dialog-actions'), {
            orientation: 'horizontal'
        });

        // Start focus on the first card in the grid
        this.setActiveSection('profiles-grid');
        setTimeout(() => {
            const firstCard = this.$('.profiles-card');
            if (firstCard) focusManager.focusElement(firstCard);
        }, 120); // Small delay to let the DOM settle after render
    }

    // ========================================================================
    // Actions
    // ========================================================================

    /**
     * Switch the active user session and navigate to Home.
     * If the token is expired, the bad session is pruned automatically by
     * AuthManager and we re-render the grid without it.
     *
     * @param {string} userId
     */
    async _switchToUser(userId) {
        if (this._isSwitching) return; // Debounce double-tap

        this._isSwitching = true;
        log.info('Switching to user:', userId);

        try {
            await auth.switchUser(userId);
            // AuthManager emits auth:login which initialises plugins.
            // Navigate to home without history so Back doesn't loop back here.
            router.navigate('/home', { replace: true });
        } catch (e) {
            log.error('Failed to switch user:', e);
            this._isSwitching = false;

            // Re-render — the expired session was already pruned by AuthManager,
            // so the grid will reflect the current (trimmed) sessions list.
            this._renderGrid();
            focusManager.invalidateCache('profiles-grid');

            // Re-focus the first remaining card
            setTimeout(() => {
                const firstCard = this.$('.profiles-card');
                if (firstCard) focusManager.focusElement(firstCard);
            }, 80);
        }
    }

    /**
     * Navigate to the Login page in "addUser" mode.
     * The Login page reads this flag to skip server selection and to redirect
     * back here (not to /home) after a successful login.
     */
    _addUser() {
        router.navigate('/login', {
            state: { addUser: true }
        });
    }

    // ========================================================================
    // Switch Server confirmation dialog
    // ========================================================================

    _showDialog() {
        const overlay = this.$('#profiles-dialog-overlay');
        if (!overlay) return;

        this._dialogVisible = true;
        overlay.classList.add('visible');

        // Move focus into the dialog — default to Cancel (safe option)
        this.setActiveSection('profiles-dialog');
        setTimeout(() => {
            const cancelBtn = this.$('#profiles-dialog-cancel');
            if (cancelBtn) focusManager.focusElement(cancelBtn);
        }, 60);
    }

    _hideDialog() {
        const overlay = this.$('#profiles-dialog-overlay');
        if (!overlay) return;

        this._dialogVisible = false;
        overlay.classList.remove('visible');

        // Return focus to the grid
        this.setActiveSection('profiles-grid');
        setTimeout(() => {
            const switchBtn = this.$('#profiles-switch-server');
            if (switchBtn) focusManager.focusElement(switchBtn);
        }, 60);
    }

    // ========================================================================
    // Back navigation
    // ========================================================================

    onBack() {
        // If the dialog is open, close it and absorb the back press
        if (this._dialogVisible) {
            this._hideDialog();
            return true;
        }

        /*
         * If no user is authenticated yet (app startup flow, no one selected),
         * Back should exit the app — there's nowhere to go back to.
         * If we got here from the Sidebar (user was already active), Back
         * should go back to the previous page via normal router history.
         */
        if (!auth.isAuthenticated()) {
            eventBus.emit('app:exitRequested');
            return true;
        }

        return false; // Let the router handle history
    }
}

export default ProfilesPage;
