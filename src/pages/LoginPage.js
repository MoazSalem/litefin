/**
 * ============================================================================
 * Litefin Tizen - Login Page
 * ============================================================================
 * Server connection and user authentication flow.
 * Steps: 1) Enter server URL -> 2) Select user -> 3) Enter password
 * ============================================================================
 */

import Page from './Page.js';
import { auth, api, discoverServers, cancelDiscovery, ServerUnreachableError, hasBackgroundDiscoveryService } from '../api/index.js';
import { state } from '../core/StateManager.js';
import { router } from '../core/Router.js';

import { focusManager } from '../ui/FocusManager.js';
import { storage } from '../utils/StorageService.js';
import { logger } from '../utils/Logger.js';
import { i18n } from '../utils/i18n.js';
import { eventBus } from '../core/EventBus.js';
import { layoutManager } from '../ui/LayoutManager.js';
import { imageService } from '../utils/ImageService.js';
import { pinManager } from '../utils/PinManager.js';
import { pinDialog } from '../ui/PinDialog.js';

const log = logger.create('Login');

// Default Jellyfin port when user omits one
const DEFAULT_PORT = 8096;

// Login states — each maps to a data-section attribute on its panel
const STATE = {
    SERVER: 'server',
    USERS: 'users',
    PASSWORD: 'password',
    MANUAL: 'manual',
    QUICK_CONNECT: 'quick-connect',
    LOADING: 'loading'
};

// How often (ms) to poll the Quick Connect status endpoint after initiating
const QUICK_CONNECT_POLL_INTERVAL = 5000;

// How many polls before giving up (5s × 36 = 3 minutes)
const QUICK_CONNECT_MAX_POLLS = 36;

class LoginPage extends Page {
    constructor() {
        super();
        this.title = i18n.t('ButtonSignIn');

        this._state = STATE.SERVER;
        this._users = [];
        this._selectedUser = null;
        this._serverUrl = '';
        this._discoveredServers = []; // Servers found via LAN discovery
        this._isDiscovering = false;
        this._hasSearchedManually = false; // Track if manual search fallback was triggered
        this._isLoggingIn = false;

        // Quick Connect polling state
        this._quickConnectSecret = null; // Secret returned by /QuickConnect/Initiate
        this._quickConnectPollTimer = null; // setInterval handle for status polling
        this._quickConnectPollCount = 0; // How many polls have been made so far

        this._isManualLoginAutoRedirect = false; // Whether we reached manual login because users were hidden

        /*
         * "Add User" mode: set to true when we arrive here from the ProfilesPage's
         * "Add User" tile. In this mode:
         *   - The server URL is already set; we skip server selection.
         *   - All "Change Server" / "Log out of server" buttons are hidden.
         *   - After a successful login we navigate to /profiles, not /home.
         *   - The Back button returns to /profiles rather than exiting.
         */
        this._isAddUserMode = false;
    }

    destroy() {
        // Stop any active discovery when leaving page
        cancelDiscovery();
        // Always cancel any in-flight Quick Connect poll on teardown
        this._cancelQuickConnect();
        super.destroy();
    }

    render() {
        /* Branch to layout-specific HTML — keeps classic DOM pristine */
        return layoutManager.isModern() ? this._renderModernHTML() : this._renderClassicHTML();
    }

    /**
     * Classic layout HTML — the original, untouched template.
     * No modern-specific classes or structures here.
     */
    _renderClassicHTML() {
        const logoSvg = this._logoSvg();
        return `
            <div class="page login-page">
                <div class="login-container">
                    <!-- Header -->
                    <div class="login-header">
                        <div class="login-logo-container">
                            ${logoSvg}
                            <h1 class="login-logo">Litefin</h1>
                        </div>
                        <p class="login-tagline" data-i18n="LitefinTagline">${i18n.t('LitefinTagline')}</p>
                    </div>

                    <!-- Server URL Form -->
                    <div class="login-section server-section" data-section="server">
                        <div class="server-input-container">
                            <input
                                type="url"
                                id="server-url"
                                class="text-input tv-input server-url-input"
                                placeholder="192.168.x.x"
                                autocomplete="off"
                                readonly
                                tabindex="0"
                            >
                            <button type="button" class="btn btn-primary connect-btn" tabindex="0">
                                <span data-i18n="Connect">Connect</span>
                            </button>
                        </div>
                        <p class="login-error" id="server-error"></p>

                        <!-- Discovered Servers -->
                        <div class="discovered-servers" id="discovered-servers">
                            <div class="discovered-header">
                                <h3 data-i18n="DiscoveredServers">Discovered Servers</h3>
                                <button class="btn-icon-small refresh-btn" id="refresh-discovery" title="Refresh">
                                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                        <path d="M23 4v6h-6"></path>
                                        <path d="M1 20v-6h6"></path>
                                        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
                                    </svg>
                                </button>
                            </div>
                            <ul class="server-list" id="saved-server-list"></ul>
                            <ul class="server-list" id="server-list"></ul>
                            <div class="discovery-status" id="discovery-status">
                                <div class="loading-spinner-small"></div>
                                <span data-i18n="ScanningNetwork">Scanning network...</span>
                            </div>
                        </div>
                    </div>

                    <!-- User Selection -->
                    <div class="login-section users-section hidden" data-section="users">
                        <h2 data-i18n="SelectUser">Select User</h2>
                        <div class="users-grid" id="users-grid"></div>
                        <p class="login-error" id="users-error"></p>
                        <div class="login-actions">
                            <button type="button" class="btn btn-secondary quick-connect-btn" tabindex="0">
                                <span data-i18n="QuickConnect">Quick Connect</span>
                            </button>
                            <button type="button" class="btn btn-secondary manual-login-btn" tabindex="0">
                                <span data-i18n="ButtonManualLogin">Manual Login</span>
                            </button>
                            <button type="button" class="btn btn-secondary change-server-btn" tabindex="0">
                                <span data-i18n="ButtonChangeServer">Log out of server</span>
                            </button>
                        </div>
                    </div>

                    <!-- Manual Login Form -->
                    <div class="login-section manual-section hidden" data-section="manual">
                        <h2 data-i18n="ButtonManualLogin">Manual Login</h2>
                        <div class="input-group">
                            <input
                                type="text"
                                id="manual-username"
                                class="text-input tv-input"
                                placeholder="${i18n.t('LabelUsername')}"
                                readonly
                                tabindex="0"
                            >
                        </div>
                        <div class="input-group">
                            <input
                                type="password"
                                id="manual-password"
                                class="text-input tv-input"
                                placeholder="${i18n.t('LabelPassword')}"
                                readonly
                                tabindex="0"
                            >
                        </div>
                        <div class="login-actions">
                            <button type="button" class="btn btn-primary manual-signin-btn" tabindex="0">
                                <span data-i18n="ButtonSignIn">Sign In</span>
                            </button>
                            <button type="button" class="btn btn-secondary quick-connect-btn" tabindex="0">
                                <span data-i18n="QuickConnect">Quick Connect</span>
                            </button>
                            <button type="button" class="btn btn-secondary back-btn" tabindex="0">
                                <span data-i18n="ButtonBack">Back</span>
                            </button>
                            <button type="button" class="btn btn-secondary change-server-btn" tabindex="0">
                                <span data-i18n="ButtonChangeServer">Change Server</span>
                            </button>
                        </div>
                        <p class="login-error" id="manual-error"></p>
                    </div>

                    <!-- Password Form -->
                    <div class="login-section password-section hidden" data-section="password">
                        <h2 data-i18n="EnterPassword">Enter Password</h2>
                        <div class="selected-user" id="selected-user">
                            <img class="user-avatar" src="" alt="" onerror="this.classList.add('hidden'); this.nextElementSibling.classList.remove('hidden')">
                            <div class="user-avatar-placeholder hidden">?</div>
                            <span class="user-name"></span>
                        </div>
                        <div class="input-group">
                            <input
                                type="password"
                                id="password-input"
                                class="text-input tv-input"
                                placeholder="${i18n.t('PasswordPlaceholder')}"
                                readonly
                                tabindex="0"
                            >
                        </div>
                        <div class="login-actions">
                            <button type="button" class="btn btn-primary login-btn" tabindex="0">
                                <span data-i18n="ButtonSignIn">Sign In</span>
                            </button>
                            <button type="button" class="btn btn-secondary back-btn" tabindex="0">
                                <span data-i18n="ButtonBack">Back</span>
                            </button>
                        </div>
                        <p class="login-error" id="password-error"></p>
                    </div>

                    <!-- Quick Connect -->
                    <div class="login-section quick-connect-section hidden" data-section="quick-connect">
                        <h2 data-i18n="QuickConnect">Quick Connect</h2>
                        <p class="quick-connect-instructions" data-i18n="QuickConnectDescription">
                            Open your Jellyfin app or web UI on another device, go to
                            Dashboard → Quick Connect, and enter this code:
                        </p>
                        <div class="quick-connect-code" id="quick-connect-code">------</div>
                        <p class="quick-connect-status" id="quick-connect-status" data-i18n="WaitingForAuthorization">Waiting for authorization…</p>
                        <p class="login-error" id="quick-connect-error"></p>
                        <div class="login-actions">
                            <button type="button" class="btn btn-secondary back-btn" tabindex="0">
                                <span data-i18n="ButtonCancel">Cancel</span>
                            </button>
                        </div>
                    </div>

                    <!-- Loading -->
                    <div class="login-section loading-section hidden" data-section="loading">
                        <div class="loading-spinner"></div>
                        <p class="login-error" id="server-error"></p>
                    </div>
                </div>
            </div>
        `;
    }

    /**
     * Modern layout HTML — clean split-screen DOM.
     * No classic hacks; every structural difference lives here.
     * CSS in modern.css handles colours / dimensions only.
     */
    _renderModernHTML() {
        const logoSvg = this._logoSvg();
        return `
            <div class="page login-page">
                <div class="login-container">

                    <!-- ── Left pane: branding ──────────────────────────── -->
                    <div class="login-header">
                        <div class="login-logo-container">
                            ${logoSvg}
                            <h1 class="login-logo">Litefin</h1>
                        </div>
                        <p class="login-tagline" data-i18n="LitefinTagline">${i18n.t('LitefinTagline')}</p>
                    </div>

                    <!-- ── Right pane: interactive sections ──────────────── -->

                    <!-- Server URL Form -->
                    <div class="login-section server-section" data-section="server">
                        <h2 class="section-title" data-i18n="HeaderConnectToServer">${i18n.t('HeaderConnectToServer')}</h2>
                        <label class="input-label" data-i18n="HeaderConnectToServer">${i18n.t('HeaderConnectToServer')}</label>
                        <div class="server-input-container">
                            <input
                                type="url"
                                id="server-url"
                                class="text-input tv-input server-url-input"
                                placeholder="192.168.x.x"
                                autocomplete="off"
                                readonly
                                tabindex="0"
                            >
                            <button type="button" class="btn btn-primary connect-btn" tabindex="0">
                                <span data-i18n="Connect">Connect</span>
                            </button>
                        </div>
                        <p class="login-error" id="server-error"></p>

                        <!-- Discovered Servers -->
                        <div class="discovered-servers" id="discovered-servers">
                            <div class="discovered-header">
                                <h3 data-i18n="DiscoveredServers">Discovered Servers</h3>
                                <button class="btn-icon-small refresh-btn" id="refresh-discovery" title="Refresh">
                                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                        <path d="M23 4v6h-6"></path>
                                        <path d="M1 20v-6h6"></path>
                                        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
                                    </svg>
                                </button>
                            </div>
                            <ul class="server-list hidden" id="saved-server-list" style="display: none !important;"></ul>
                            <ul class="server-list" id="server-list"></ul>
                            <div class="discovery-status" id="discovery-status">
                                <div class="loading-spinner-small"></div>
                                <span data-i18n="ScanningNetwork">Scanning network...</span>
                            </div>
                        </div>
                    </div>

                    <!-- User Selection -->
                    <div class="login-section users-section hidden" data-section="users">
                        <h2 class="section-title" data-i18n="SelectUser">${i18n.t('SelectUser')}</h2>
                        <div class="users-grid" id="users-grid"></div>
                        <p class="login-error" id="users-error"></p>
                        <div class="login-actions modern-button-row">
                            <button type="button" class="btn btn-primary quick-connect-btn" tabindex="0">
                                <span data-i18n="QuickConnect">Quick Connect</span>
                            </button>
                            <button type="button" class="btn btn-secondary manual-login-btn" tabindex="0">
                                <span data-i18n="ButtonManualLogin">Manual Login</span>
                            </button>
                            <button type="button" class="btn btn-secondary change-server-btn" tabindex="0">
                                <span data-i18n="ButtonChangeServer">Log out of server</span>
                            </button>
                        </div>
                    </div>

                    <!-- Manual Login Form -->
                    <div class="login-section manual-section hidden" data-section="manual">
                        <h2 class="section-title" data-i18n="ButtonSignIn">${i18n.t('ButtonSignIn')}</h2>
                        <div class="manual-form-container">
                            <div class="input-group">
                                <label class="input-label" data-i18n="LabelUsername">${i18n.t('LabelUsername')}</label>
                                <div class="input-container user-input-container">
                                    <input
                                        type="text"
                                        id="manual-username"
                                        class="text-input tv-input"
                                        placeholder="${i18n.t('LabelUsername')}"
                                        readonly
                                        tabindex="0"
                                    >
                                </div>
                            </div>
                            <div class="input-group">
                                <label class="input-label" data-i18n="LabelPassword">${i18n.t('LabelPassword')}</label>
                                <div class="input-container pass-input-container">
                                    <input
                                        type="password"
                                        id="manual-password"
                                        class="text-input tv-input"
                                        placeholder="${i18n.t('LabelPassword')}"
                                        readonly
                                        tabindex="0"
                                    >
                                </div>
                            </div>
                        </div>
                        <div class="login-actions modern-button-row">
                            <button type="button" class="btn btn-primary manual-signin-btn" tabindex="0">
                                <span data-i18n="ButtonSignIn">Sign In</span>
                            </button>
                            <button type="button" class="btn btn-secondary back-btn" tabindex="0">
                                <span data-i18n="ButtonBack">Back</span>
                            </button>
                        </div>
                        <p class="login-error" id="manual-error"></p>
                    </div>

                    <!-- Password Form -->
                    <div class="login-section password-section hidden" data-section="password">
                        <h2 class="section-title" data-i18n="EnterPassword">${i18n.t('EnterPassword')}</h2>
                        <div class="selected-user" id="selected-user">
                            <img class="login-user-avatar" src="" alt="" onerror="this.classList.add('hidden'); this.nextElementSibling.classList.remove('hidden')">
                            <div class="user-avatar-placeholder hidden">?</div>
                            <span class="login-user-name"></span>
                        </div>
                        <div class="input-group">
                            <input
                                type="password"
                                id="password-input"
                                class="text-input tv-input"
                                placeholder="${i18n.t('PasswordPlaceholder')}"
                                readonly
                                tabindex="0"
                            >
                        </div>
                        <div class="login-actions modern-button-row">
                            <button type="button" class="btn btn-primary login-btn" tabindex="0">
                                <span data-i18n="ButtonSignIn">Sign In</span>
                            </button>
                            <button type="button" class="btn btn-secondary back-btn" tabindex="0">
                                <span data-i18n="ButtonBack">Back</span>
                            </button>
                        </div>
                        <p class="login-error" id="password-error"></p>
                    </div>

                    <!-- Quick Connect -->
                    <div class="login-section quick-connect-section hidden" data-section="quick-connect">
                        <h2 class="section-title" data-i18n="QuickConnect">${i18n.t('QuickConnect')}</h2>
                        <p class="quick-connect-instructions" data-i18n="QuickConnectDescription">
                            Open your Jellyfin app or web UI on another device, go to
                            Dashboard → Quick Connect, and enter this code:
                        </p>
                        <div class="quick-connect-code" id="quick-connect-code">------</div>
                        <p class="quick-connect-status" id="quick-connect-status" data-i18n="WaitingForAuthorization">Waiting for authorization…</p>
                        <p class="login-error" id="quick-connect-error"></p>
                        <div class="login-actions modern-button-row">
                            <button type="button" class="btn btn-secondary back-btn" tabindex="0">
                                <span data-i18n="ButtonCancel">Cancel</span>
                            </button>
                        </div>
                    </div>

                    <!-- Loading -->
                    <div class="login-section loading-section hidden" data-section="loading">
                        <div class="loading-spinner"></div>
                        <p class="login-error" id="server-error"></p>
                    </div>

                </div>
            </div>
        `;
    }

    /**
     * Shared logo SVG markup — extracted so both layouts stay DRY.
     * Returns the raw SVG string for embedding in either template.
     */
    _logoSvg() {
        return `<svg viewBox="0 0 100 100" class="login-logo-svg" preserveAspectRatio="xMidYMid meet">
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
        </svg>`;
    }

    onMounted() {
        // Clear any previous errors
        this._hideError('server-error'); // Clear server errors
        this._hideError('manual-error'); // Clear manual login errors
        this._hideError('password-error'); // Clear password errors
        this._hideError('users-error'); // Clear user selection errors

        // Get element references
        this._serverInput = this.$('#server-url');
        this._passwordInput = this.$('#password-input');
        this._manualUsername = this.$('#manual-username');
        this._manualPassword = this.$('#manual-password');
        this._usersGrid = this.$('#users-grid');
        this._serverList = this.$('#server-list');
        this._savedServerList = this.$('#saved-server-list');
        this._discoveryStatus = this.$('#discovery-status');

        // Translate the page
        i18n.translateDOM(this.el);

        // Bind events
        this._bindEvents();

        // Update search / refresh button icon depending on discovery capabilities
        this._updateRefreshButtonIcon();

        // Setup focus sections
        this._setupFocus();

        // Check if we have a saved server - auto-connect if so
        const savedUrl = auth.getSavedServerUrl();
        const isKnownOffline = state.get('server:offline') === true;

        // Check if we arrived here from ProfilesPage's "Add User" flow.
        // The ProfilesPage calls router.navigate('/login', { state: { addUser: true } }),
        // which persists the flag via state.set('router:pageState', ...).
        const pageState = state.get('router:pageState');
        if (pageState && pageState.addUser) {
            this._isAddUserMode = true;
            // Consume the flag so re-mounts (e.g. back-nav) don't re-trigger it.
            state.set('router:pageState', null);
        } else {
            this._isAddUserMode = false;
        }

        if (savedUrl && !isKnownOffline) {
            // Server already saved and not known to be offline - skip server selection
            this._serverInput.value = savedUrl;

            /*
             * WebOS 4.0-4.4 freeze fix: the splash screen must be dismissed
             * as soon as the loading state is visible, NOT after the server
             * probe completes. On slow/offline servers the probe can take 6-20s,
             * during which the splash would otherwise remain up and the device
             * appears completely frozen to the user.
             *
             * We emit hideSplash here with a tiny delay so that:
             *   1. _autoConnectToSavedServer() has shown STATE.LOADING first
             *   2. The loading spinner is composited and visible to the user
             *   3. The splash fade-out transition runs over the spinner, not a black screen
             *
             * The redundant hideSplash calls inside _autoConnectToSavedServer's
             * success/error branches remain as a safety net for the final transition.
             */
            this._autoConnectToSavedServer(savedUrl);
            setTimeout(() => {
                eventBus.emit('app:hideSplash');
            }, 80);
        } else {
            // No saved server or known offline - show server selection immediately
            if (savedUrl) {
                this._serverInput.value = savedUrl;
                this._showError('server-error', i18n.t('ServerUnreachableMessage'));
            }

            this._startDiscovery();
            this._showState(STATE.SERVER);
            setTimeout(() => {
                this._serverInput.focus();
            }, 100);

            // Ensure splash hides after switching states (if it was up)
            setTimeout(() => {
                eventBus.emit('app:hideSplash');
            }, 10);
        }

        // Apply addUser UI restrictions AFTER the connection flow decision,
        // so we hide buttons regardless of which screen is shown first.
        if (this._isAddUserMode) {
            this._applyAddUserMode();
        }
    }

    _bindEvents() {
        // Connect button
        this.$('.connect-btn')?.addEventListener('click', () => this._connectToServer());

        // Refresh discovery button
        this.$('#refresh-discovery')?.addEventListener('click', () => {
            if (!this._isDiscovering) {
                this._startDiscovery({ isManual: true });
            }
        });

        // Login button
        this.$('.login-btn')?.addEventListener('click', () => this._login());

        // Quick Connect buttons (on users screen and manual screen)
        this.$$('.quick-connect-btn').forEach((btn) => {
            btn.addEventListener('click', () => this._startQuickConnect());
        });

        // Change Server buttons (on manual screen)
        this.$$('.change-server-btn').forEach((btn) => {
            btn.addEventListener('click', () => this._goToServerSelection());
        });

        // Manual Login buttons
        this.$('.manual-login-btn')?.addEventListener('click', () => this._goToManualLogin());
        this.$('.manual-signin-btn')?.addEventListener('click', () => this._handleManualLogin());

        // Back buttons (for password and manual screens)
        this.$$('.back-btn').forEach((btn) => {
            btn.addEventListener('click', () => this._goBack());
        });

        // Change Server button - goes back to server selection
        this.$('.change-server-btn')?.addEventListener('click', () => this._goToServerSelection());

        // --- Delegated Handlers ---
        // User card clicks — delegated on stable #users-grid container,
        // survives innerHTML rebuilds when user list is re-rendered
        if (this._usersGrid) {
            this._usersGrid.addEventListener('click', (e) => {
                const card = e.target.closest('.user-card, .login-user-card');
                if (card) {
                    const index = parseInt(card.dataset.userIndex);
                    log.debug(`User card clicked, index=${index}`);
                    if (this._users[index]) {
                        this._selectUser(this._users[index]);
                    } else {
                        log.error(`No user at index ${index}`);
                    }
                }
            });
        }

        // Server list clicks — delegated on stable #server-list container,
        // survives innerHTML rebuilds when discovered servers are re-rendered
        if (this._serverList) {
            this._serverList.addEventListener('click', (e) => {
                const item = e.target.closest('.server-item:not(.empty)');
                if (item) {
                    const index = parseInt(item.dataset.serverIndex);
                    this._selectDiscoveredServer(index);
                }
            });
        }

        // Add the same for the saved server list
        if (this._savedServerList) {
            this._savedServerList.addEventListener('click', (e) => {
                const item = e.target.closest('.server-item:not(.empty)');
                if (item) {
                    const index = parseInt(item.dataset.serverIndex);
                    this._selectDiscoveredServer(index);
                }
            });
        }

        // Enter key on inputs - just trigger click
        // On TV, Enter usually triggers click automatically on inputs/buttons
        // But we add specific click handler to unlock
        this._serverInput?.addEventListener('click', (e) => {
            if (this._serverInput.readOnly) {
                // First interaction: enable editing and open keyboard
                // e.preventDefault(); // Don't prevent default, let browser focus handle it if possible
                this._serverInput.readOnly = false;
                this._serverInput.focus();
            }
        });

        // Keydown for submitting only (Second Enter)
        this._serverInput?.addEventListener('keydown', (e) => {
            if (e.keyCode === 13) {
                if (!this._serverInput.readOnly) {
                    // Submit if already editable
                    this._serverInput.readOnly = true;
                    this._connectToServer();
                } else {
                    // If readonly, user pressed Enter.
                    // Explicitly trigger click logic if TV doesn't auto-click
                    this._serverInput.click();
                }
            }
        });

        // Restore readonly when input loses focus
        this._serverInput?.addEventListener('blur', () => {
            setTimeout(() => {
                // Only lock if we really lost focus (not just to keyboard)
                // but usually Tizen keyboard keeps focus on input
                this._serverInput.readOnly = true;
            }, 200);
        });

        // Password Input
        this._passwordInput?.addEventListener('click', (e) => {
            if (this._passwordInput.readOnly) {
                this._passwordInput.readOnly = false;
                this._passwordInput.focus();
            }
        });

        this._passwordInput?.addEventListener('keydown', (e) => {
            if (e.keyCode === 13) {
                if (!this._passwordInput.readOnly) {
                    this._passwordInput.readOnly = true;
                    this._login();
                } else {
                    this._passwordInput.click();
                }
            }
        });

        this._passwordInput?.addEventListener('blur', () => {
            setTimeout(() => {
                this._passwordInput.readOnly = true;
            }, 200);
        });

        // Enable arrow key cursor movement
        this._enableInputNavigation(this._serverInput);
        this._enableInputNavigation(this._passwordInput);
        this._enableInputNavigation(this._manualUsername);
        this._enableInputNavigation(this._manualPassword);

        // Manual Login inputs handling
        this._setupInputHandler(this._manualUsername, () => this._manualPassword.focus());
        this._setupInputHandler(this._manualPassword, () => this._handleManualLogin());
    }

    _setupInputHandler(input, onSubmit) {
        if (!input) return;

        input.addEventListener('click', () => {
            if (input.readOnly) {
                input.readOnly = false;
                input.focus();
            }
        });

        input.addEventListener('keydown', (e) => {
            if (e.keyCode === 13) {
                if (!input.readOnly) {
                    input.readOnly = true;
                    if (onSubmit) onSubmit();
                } else {
                    input.click();
                }
            }
        });

        input.addEventListener('blur', () => {
            setTimeout(() => {
                input.readOnly = true;
            }, 200);
        });
    }

    /**
     * Enable arrow keys to move cursor within input instead of changing focus
     */
    _enableInputNavigation(input) {
        if (!input) return;

        input.addEventListener('keydown', (e) => {
            // STOP propagation for Left/Right arrows ONLY when editing
            // This allows spatial nav to work when input is read-only (navigation mode)
            if (!input.readOnly && (e.keyCode === 37 || e.keyCode === 39)) {
                e.stopPropagation();
            }
        });
    }

    _setupFocus() {
        // Register server section - vertical for input + button + discovered servers
        // Register server section - use grid or visual to allow Right to Login button, Down to Servers
        this.registerFocusSection('login-server', this.$('[data-section="server"]'), {
            orientation: 'auto' // Allow spatial navigation (Left/Right for button, Down for servers)
        });

        // Register users section - grid allows 2D navigation
        this.registerFocusSection('login-users', this.$('[data-section="users"]'), {
            orientation: 'grid',
            leaveUp: 'login-server'
        });

        // Register password section - use grid for spatial navigation
        // so up/down and left/right can reach all elements
        this.registerFocusSection('login-password', this.$('[data-section="password"]'), {
            orientation: 'grid'
        });

        // Register manual login section
        this.registerFocusSection('login-manual', this.$('[data-section="manual"]'), {
            orientation: 'grid'
        });

        // Register quick connect section — just a code display + Cancel button
        this.registerFocusSection('login-quick-connect', this.$('[data-section="quick-connect"]'), {
            orientation: 'grid'
        });

        this.setActiveSection('login-server');
    }

    /**
     * Auto-connect to a saved server on app startup.
     * Skips server selection and goes straight to user list.
     *
     * IMPORTANT: The splash screen is dismissed by the caller (onMounted)
     * BEFORE this method's async work begins. Do NOT call hideSplash inside
     * this method's try-block opening — the caller has already done it at
     * the right moment (when the loading spinner is first visible).
     * The hideSplash calls at the end of the success/error paths are kept
     * as safety nets for the final UI state transitions only.
     *
     * @param {string} savedUrl - The saved server URL
     */
    async _autoConnectToSavedServer(savedUrl) {
        log.info(`Auto-connecting to saved server ${savedUrl}`);
        this._showState(STATE.LOADING);

        try {
            this._serverUrl = savedUrl;
            await auth.connectToServer(savedUrl);

            // If we already have saved sessions for this server, jump straight to the profiles picker
            const savedServers = auth.getSavedServers();
            const serverData = savedServers.find((s) => s.serverUrl === savedUrl);

            if (!this._isAddUserMode && serverData && serverData.sessions.length > 0) {
                log.info(`Server ${savedUrl} has saved sessions. Skipping login prompt.`);
                state.set('user:sessionCount', serverData.sessions.length);
                router.navigate('/profiles', { replace: true });
                return;
            }

            // Get public users
            this._users = await api.getPublicUsers();

            if (this._users.length > 0) {
                this._renderUsers();
                this._showState(STATE.USERS);
                this.setActiveSection('login-users');

                // Focus first user card
                setTimeout(() => {
                    const firstCard = this._usersGrid.querySelector('.user-card, .login-user-card');
                    if (firstCard) focusManager.focusElement(firstCard);
                }, 100);
            } else {
                // No public users - show manual login with auto-redirect flag
                this._goToManualLogin(true);
            }

            // Ensure splash screen hides when user selection or manual login is shown
            setTimeout(() => {
                eventBus.emit('app:hideSplash');
            }, 10);
        } catch (error) {
            // Connection failed - show server selection
            log.warn('Auto-connect failed, showing server selection', error);
            this._showState(STATE.SERVER);

            if (error instanceof ServerUnreachableError) {
                this._showError('server-error', i18n.t('ServerUnreachableMessage'));
            } else {
                this._showError('server-error', error.message || i18n.t('Error'));
            }

            this._startDiscovery();

            // Focus the Connect button so user can retry easily
            setTimeout(() => {
                const connectBtn = this.$('.connect-btn');
                if (connectBtn) connectBtn.focus();
                eventBus.emit('app:hideSplash');
            }, 100);
        }
    }

    /**
     * Apply visual restrictions for "Add User" mode.
     * Called once per mount when _isAddUserMode is true.
     * Hides every "Change Server" / "Log out of server" button on all sections,
     * since the server is already selected and should not be changeable.
     * @private
     */
    _applyAddUserMode() {
        log.info('LoginPage: Add User mode active — hiding server change buttons');
        // Hide Change Server buttons on both the users section and manual-login section
        this.$$('.change-server-btn').forEach((btn) => {
            btn.style.display = 'none';
        });
    }

    /**
     * Go to server selection screen (when Change Server button is clicked).
     * Uses logoutAll() to clear the active server pointer and route to /login.
     * Stored sessions for ALL servers are preserved in litefin:serverSessions
     * so users can reconnect to any previously-used server without re-logging in.
     */
    _goToServerSelection() {
        log.info('Going to server selection');

        // PREVENT GHOST FOCUS: The logout button receives native browser focus on click.
        // Even though FocusManager tracks its own .focused class, Tizen's native :focus
        // pseudo-class will persist on the element unless we explicitly call blur() on
        // document.activeElement before the section is hidden.
        if (document.activeElement && document.activeElement !== document.body) {
            document.activeElement.blur();
        }
        focusManager.clearFocus();

        // logoutAll() clears only the active server URL + active user pointer;
        // it does NOT wipe litefin:serverSessions — sessions for all servers are kept.
        // It emits auth:logout, which App.js catches and routes to /login.
        auth.logoutAll();

        // Reset state
        this._showState(STATE.SERVER);
        this.setActiveSection('login-server');

        // Clear visible errors
        this._hideError('server-error');
        this._hideError('manual-error');
        this._hideError('password-error');
        this._hideError('users-error');

        // Ensure input is editable
        if (this._serverInput) {
            this._serverInput.readOnly = true; // Keep readonly until user presses Enter
            this._serverInput.value = ''; // Clear input for fresh start
        }

        this._startDiscovery();

        // Force focus with a slight delay to allow visibility transition
        setTimeout(() => {
            if (this._serverInput) this._serverInput.focus();
        }, 150);
    }

    /**
     * Normalize a user-typed server address.
     * Rules:
     *   - Bare hostname/IP (no protocol) → prepend http://, append :8096
     *   - Full URL with protocol (http:// or https://) → use as-is, no port added
     *   - If user typed their own port, it is always respected
     * @param {string} input - Raw user input
     * @returns {string} Normalized server URL
     */
    _normalizeServerUrl(input) {
        let url = input.trim();
        if (!url) return '';

        const hasProtocol = url.includes('://');

        if (!hasProtocol) {
            // Bare hostname/IP — add default protocol and port
            url = `http://${url}`;
            try {
                const parsed = new URL(url);
                if (!parsed.port) {
                    parsed.port = String(DEFAULT_PORT);
                }
                let result = parsed.toString();
                if (result.endsWith('/')) {
                    result = result.slice(0, -1);
                }
                return result;
            } catch {
                return url;
            }
        }

        // User typed a full URL with protocol — respect their choice, no port added
        let result = url;
        if (result.endsWith('/')) {
            result = result.slice(0, -1);
        }
        return result;
    }

    async _connectToServer() {
        const url = this._serverInput.value.trim();

        if (!url) {
            this._showError('server-error', i18n.t('EnterServerURL'));
            return;
        }

        this._showState(STATE.LOADING);
        this._hideError('server-error');

        try {
            const serverUrl = this._normalizeServerUrl(url);
            this._serverUrl = serverUrl;

            // Connect to server
            // Stop scanning first
            cancelDiscovery();
            await auth.connectToServer(serverUrl);

            // If we already have saved sessions for this server, jump straight to the profiles picker
            // This prevents prompting the user to login again for a server they've already authenticated with.
            // We ignore this shortcut if we're in "Add User" mode (where they explicitly want to add a NEW token).
            const savedServers = auth.getSavedServers();
            const serverData = savedServers.find((s) => s.serverUrl === serverUrl);

            if (!this._isAddUserMode && serverData && serverData.sessions.length > 0) {
                log.info(`Found ${serverData.sessions.length} saved sessions for ${serverUrl}, routing to profiles`);
                // Update session count so App.js routing logic handles back-navigation correctly
                state.set('user:sessionCount', serverData.sessions.length);
                router.navigate('/profiles', { replace: true });
                return;
            }

            // Get public users
            this._users = await api.getPublicUsers();

            if (this._users.length > 0) {
                this._renderUsers();
                this._showState(STATE.USERS);
                this.setActiveSection('login-users');

                // Focus first user card
                setTimeout(() => {
                    const firstCard = this._usersGrid.querySelector('.user-card, .login-user-card');
                    if (firstCard) focusManager.focusElement(firstCard);
                }, 100);
            } else {
                // No public users - go straight to manual entry
                this._goToManualLogin(true);
            }
        } catch (error) {
            this._showState(STATE.SERVER);
            if (error instanceof ServerUnreachableError) {
                this._showError('server-error', i18n.t('ServerUnreachableMessage'));
            } else {
                this._showError('server-error', error.message || i18n.t('Error'));
            }
        }
    }

    _renderUsers() {
        const isModern = layoutManager.isModern();
        const html = this._users
            .map((user, index) => {
                if (isModern) {
                    return `
                        <div class="user-item">
                            <button class="login-user-card" data-user-index="${index}" tabindex="0">
                                    <img 
                                        class="login-user-avatar ${user.PrimaryImageTag ? '' : 'hidden'}" 
                                        src="${
                                            user.PrimaryImageTag
                                                ? api.getUserImageUrl(user.Id, {
                                                      maxWidth: imageService.getParams('avatar').maxWidth,
                                                      quality: imageService.getParams('avatar').quality
                                                  })
                                                : ''
                                        }"
                                        alt="${user.Name}"
                                        onerror="this.classList.add('hidden'); this.nextElementSibling.classList.remove('hidden')"
                                    >
                                    <div class="user-avatar-placeholder ${user.PrimaryImageTag ? 'hidden' : ''}">${user.Name.charAt(0).toUpperCase()}</div>
                            </button>
                            <div class="login-user-name">${user.Name}</div>
                        </div>
                    `;
                } else {
                    return `
                        <div class="user-item">
                            <button class="user-card" data-user-index="${index}" tabindex="0">
                                <img 
                                    class="user-avatar ${user.PrimaryImageTag ? '' : 'hidden'}" 
                                    src="${
                                        user.PrimaryImageTag
                                            ? api.getUserImageUrl(user.Id, {
                                                  maxWidth: imageService.getParams('avatar').maxWidth,
                                                  quality: imageService.getParams('avatar').quality
                                              })
                                            : ''
                                    }"
                                    alt="${user.Name}"
                                    onerror="this.classList.add('hidden'); this.nextElementSibling.classList.remove('hidden')"
                                >
                                <div class="user-avatar-placeholder ${user.PrimaryImageTag ? 'hidden' : ''}">${user.Name.charAt(0).toUpperCase()}</div>
                            </button>
                            <div class="user-name">${user.Name}</div>
                        </div>
                    `;
                }
            })
            .join('');

        this._usersGrid.innerHTML = html;

        // Invalidate focus cache so new items are found
        focusManager.invalidateCache('login-users');

        // Click handling is delegated on _usersGrid container in _bindEvents()
        // No per-card listeners needed — delegation survives innerHTML rebuilds
    }

    /**
     * Handle user card selection
     * If user has no password, login directly
     * If user has password, show password form
     * @param {Object} user - User object from getPublicUsers
     */
    async _selectUser(user, pinVerified = false) {
        log.info(`LoginPage: _selectUser called for "${user?.Name}"`);

        if (!user) {
            log.error('LoginPage: _selectUser called with null/undefined user');
            return;
        }

        // Per-profile PIN gate (opt-in, local). If this profile has a PIN
        // configured, require it before proceeding into the normal login flow.
        if (!pinVerified && pinManager.hasPin(user.Id)) {
            pinDialog.show({
                mode: 'verify',
                userId: user.Id,
                title: i18n.t('EnterPin') || 'Enter PIN',
                onSuccess: () => this._selectUser(user, true),
                onCancel: () => this._showState(STATE.USERS)
            });
            return;
        }

        try {
            this._selectedUser = user;

            // Check HasPassword field (key jellyfin-web pattern)
            if (user.HasPassword === false) {
                // No password required - login directly
                log.info(`User "${user.Name}" has no password, logging in directly`);
                this._showState(STATE.LOADING);

                // Stop any running discovery just in case
                cancelDiscovery();

                await auth.login(user.Name, '');
                // In addUser mode, return to the profiles screen instead of going home
                if (this._isAddUserMode) {
                    router.navigate('/profiles', { replace: true });
                } else {
                    router.navigate('/home', { replace: true });
                }
            } else {
                // Password required - show password form
                log.info(`LoginPage: User "${user.Name}" requires password`);

                // Update password section with user info
                const userEl = this.$('#selected-user');
                const nameEl = userEl?.querySelector('.login-user-name, .user-name');
                if (nameEl) {
                    nameEl.textContent = user.Name;
                }

                const img = userEl?.querySelector('.login-user-avatar, .user-avatar');
                const placeholder = userEl?.querySelector('.user-avatar-placeholder');

                if (placeholder) {
                    placeholder.textContent = user.Name.charAt(0).toUpperCase();
                }

                if (img) {
                    if (user.PrimaryImageTag) {
                        const params = imageService.getParams('avatar');
                        img.src = api.getUserImageUrl(user.Id, {
                            maxWidth: params.maxWidth,
                            quality: params.quality
                        });
                        img.classList.remove('hidden');
                        placeholder?.classList.add('hidden');
                    } else {
                        img.src = '';
                        img.classList.add('hidden');
                        placeholder?.classList.remove('hidden');
                    }
                }

                // Clear password input
                this._passwordInput.value = '';

                // Show password section
                this._showState(STATE.PASSWORD);
                this.setActiveSection('login-password');

                // Focus password input
                setTimeout(() => {
                    if (this._passwordInput) {
                        this._passwordInput.readOnly = true;
                        this._passwordInput.focus();
                    }
                }, 100);
            }
        } catch (error) {
            log.error('_selectUser error:', error);
            this._showState(STATE.USERS);
            this._showError('users-error', error.message || i18n.t('Error'));
        }
    }

    async _login() {
        this._hideError('password-error');

        const password = this._passwordInput.value;
        const username = this._selectedUser.Name;

        this._showState(STATE.LOADING);

        try {
            log.info('LoginPage: AuthManager.login calling...');
            await auth.login(username, password);
            log.info('AuthManager.login success. Navigating to home...');
            // Short delay to ensure state propagation
            await new Promise((resolve) => setTimeout(resolve, 50));

            // In addUser mode, return to the profiles screen so the user can pick a profile
            if (this._isAddUserMode) {
                router.navigate('/profiles', { replace: true });
            } else {
                router.navigate('/home', { replace: true });
            }
        } catch (error) {
            this._showState(STATE.PASSWORD);
            this._showError('password-error', error.message || i18n.t('Error'));
            this._passwordInput.focus();
        }
    }

    _goToManualLogin(isAutoRedirect = false) {
        log.info(`Going to Manual Login. AutoRedirect=${isAutoRedirect}`);
        this._isManualLoginAutoRedirect = isAutoRedirect;

        this._manualUsername.value = '';
        this._manualPassword.value = '';

        // Back button and Quick Connect button visibility based on auto-redirect (as requested)
        const backBtn = this.$('.manual-section .back-btn');
        if (backBtn) {
            backBtn.style.display = isAutoRedirect ? 'none' : '';
        }

        const qcBtn = this.$('.manual-section .quick-connect-btn');
        if (qcBtn) {
            qcBtn.style.display = isAutoRedirect ? '' : 'none';
        }

        const changeServerBtn = this.$('.manual-section .change-server-btn');
        if (changeServerBtn) {
            changeServerBtn.style.display = isAutoRedirect ? '' : 'none';
        }

        this._showState(STATE.MANUAL);
        this.setActiveSection('login-manual');
        focusManager.invalidateCache('login-manual');

        setTimeout(() => {
            if (this._manualUsername) {
                this._manualUsername.readOnly = true;
                this._manualUsername.focus();
            }
        }, 100);
    }

    async _handleManualLogin() {
        this._hideError('manual-error');

        // Read values from input fields (readonly removed so they work now)
        const username = this._manualUsername.value.trim();
        const password = this._manualPassword.value;

        log.info(`LoginPage: Manual Login. User="${username}" PassLength=${password ? password.length : 0}`);

        if (!username) {
            this._showError('manual-error', i18n.t('UsernameRequired'));
            return;
        }

        this._showState(STATE.LOADING);

        try {
            log.info('LoginPage: AuthManager.login calling...');
            await auth.login(username, password);
            log.info('AuthManager.login success. Navigating to home...');
            // Short delay to ensure state propagation
            await new Promise((resolve) => setTimeout(resolve, 50));

            // In addUser mode, return to the profiles screen so the user can pick a profile
            if (this._isAddUserMode) {
                router.navigate('/profiles', { replace: true });
            } else {
                router.navigate('/home', { replace: true });
            }
        } catch (error) {
            this._showState(STATE.MANUAL);
            this._showError('manual-error', error.message || i18n.t('Error'));
            this._manualUsername.focus();
        }
    }

    _goBack() {
        if (this._state === STATE.QUICK_CONNECT) {
            // Cancel the polling loop and return to the user list
            this._cancelQuickConnect();
            return true;
        } else if (this._state === STATE.PASSWORD) {
            if (this._users.length > 0) {
                this._showState(STATE.USERS);
                this.setActiveSection('login-users');

                // Focus first user card
                setTimeout(() => {
                    const firstCard = this._usersGrid.querySelector('.user-card, .login-user-card');
                    if (firstCard) firstCard.focus();
                }, 100);
            }
            return true;
        } else if (this._state === STATE.SERVER) {
            /*
             * Back on the server screen.
             * In addUser mode we came from ProfilesPage, so go back there.
             * In normal mode, exit the app — there's nowhere to go.
             */
            if (this._isAddUserMode) {
                router.navigate('/profiles', { replace: true });
            } else if (typeof tizen !== 'undefined') {
                try {
                    storage.flush();
                    tizen.application.getCurrentApplication().exit();
                } catch (e) {
                    log.error('App exit failed:', e);
                }
            } else {
                log.info('App exit (simulated)');
            }
            return true;
        } else if (this._state === STATE.USERS) {
            /*
             * Back on the user selection screen.
             * In addUser mode, go back to ProfilesPage.
             * In normal mode, go back to the server input screen.
             */
            if (this._isAddUserMode) {
                router.navigate('/profiles', { replace: true });
            } else {
                this._showState(STATE.SERVER);
                this.setActiveSection('login-server');
                this._serverInput.focus();
            }
            return true;
        } else if (this._state === STATE.MANUAL) {
            // Prevent going back if autoredirected (no users found)
            if (this._isManualLoginAutoRedirect) {
                log.info('Manual Login: Back suppressed (AutoRedirect mode)');
                return true;
            }

            this._showState(STATE.USERS);
            this.setActiveSection('login-users');
            setTimeout(() => {
                this.$('.manual-login-btn')?.focus();
            }, 100);
            return true;
        }
        return false;
    }

    _showState(newState) {
        this._state = newState;

        // Hide all sections
        this.$$('.login-section').forEach((section) => {
            section.classList.add('hidden');
        });

        // Show active section
        const activeSection = this.$(`[data-section="${newState}"]`);
        if (activeSection) {
            activeSection.classList.remove('hidden');

            if (newState !== STATE.LOADING) {
                // Ensure DOM has painted the new state before revealing it
                setTimeout(() => {
                    eventBus.emit('app:hideSplash');
                }, 10);
            }
        }
    }

    _showError(id, message) {
        const errorEl = this.$(`#${id}`);
        if (errorEl) {
            errorEl.textContent = message;
            errorEl.style.display = 'block';
        }
    }

    _hideError(id) {
        const errorEl = this.$(`#${id}`);
        if (errorEl) {
            errorEl.style.display = 'none';
        }
    }

    onBack() {
        return this._goBack();
    }

    // ========================================================================
    // Server Discovery
    // ========================================================================

    /**
     * Start LAN server discovery in the background.
     * If device has no background UDP discovery service and this is an automatic startup call
     * (isManual = false), we skip the heavy HTTP subnet scan to prevent older TV hardware lag.
     * @param {Object} [options={}] - Discovery options
     * @param {boolean} [options.isManual=false] - Whether discovery was manually requested by clicking search/refresh button
     */
    async _startDiscovery(options = {}) {
        const isManual = options.isManual === true;
        if (isManual) {
            this._hasSearchedManually = true;
        }

        const hasBgService = hasBackgroundDiscoveryService();

        // If automatic startup discovery is requested on a device WITHOUT background UDP service,
        // skip the automatic HTTP scan to prevent TV slowdown / UI lag.
        if (!isManual && !hasBgService) {
            log.info('LoginPage: No background discovery service available — skipping auto HTTP scan to prevent TV slowdown.');
            this._isDiscovering = false;

            // Load and render saved servers if available
            this._discoveredServers = [];
            const savedServers = auth.getSavedServers();
            if (savedServers && savedServers.length > 0) {
                savedServers.forEach((saved) => {
                    const fallbackName = saved.serverUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
                    this._discoveredServers.push({
                        name: saved.serverName || fallbackName,
                        address: saved.serverUrl,
                        version: null,
                        isSaved: true
                    });
                });
            }
            this._renderDiscoveredServers();
            this._updateRefreshButtonIcon();
            return;
        }

        if (this._isDiscovering) return;
        this._isDiscovering = true;
        this._updateRefreshButtonIcon();

        log.info(`LoginPage: Starting server discovery (isManual=${isManual})...`);

        // Initialize with saved servers first
        this._discoveredServers = [];
        const savedServers = auth.getSavedServers();
        if (savedServers && savedServers.length > 0) {
            savedServers.forEach((saved) => {
                // Use the domain/IP as the name if we don't have a specific friendly name saved
                const fallbackName = saved.serverUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
                this._discoveredServers.push({
                    name: saved.serverName || fallbackName,
                    address: saved.serverUrl,
                    version: null,
                    isSaved: true
                });
            });
        }
        this._renderDiscoveredServers();

        try {
            // Run discovery
            const servers = await discoverServers(
                (checked, total) => {
                    // Update progress if desired
                    const percent = Math.round((checked / total) * 100);
                    log.info(`LoginPage: Discovery ${percent}%`);
                },
                (server) => {
                    // Check if already in list (could be from saved servers)
                    const existing = this._discoveredServers.find(
                        (s) => s.address.replace(/\/$/, '') === server.address.replace(/\/$/, '')
                    );

                    if (!existing) {
                        // Server found! Add and render immediately
                        log.info(`LoginPage: Found server ${server.name} (${server.address})`);
                        this._discoveredServers.push(server);
                        this._renderDiscoveredServers();
                    } else {
                        // Update existing with better discovery info
                        if (existing.isSaved) {
                            existing.name = server.name || existing.name;
                            existing.version = server.version || existing.version;
                            this._renderDiscoveredServers();
                        }
                    }
                },
                { isManual, allowHttpFallback: isManual }
            );

            // Ensure final list is synced, but preserve our saved servers
            if (servers && servers.length > 0) {
                servers.forEach((server) => {
                    const exists = this._discoveredServers.find(
                        (s) => s.address.replace(/\/$/, '') === server.address.replace(/\/$/, '')
                    );
                    if (!exists) {
                        this._discoveredServers.push(server);
                    }
                });
            }
            this._renderDiscoveredServers();
        } catch (error) {
            // Log any unexpected error during LAN discovery
            log.error('LoginPage: Discovery failed', error);

            // Display error visual state if DOM is bound
            if (this._discoveryStatus) {
                this._discoveryStatus.innerHTML = `<span>${i18n.t('Error')}</span>`;
            }
        } finally {
            // Always set active discovery state to false upon finalization
            this._isDiscovering = false;

            // Trigger a re-render of servers to immediately hide the scan progress indicator
            this._renderDiscoveredServers();
            this._updateRefreshButtonIcon();
        }
    }

    /**
     * Update the refresh/search button icon based on background service availability
     * and manual search state.
     * If the platform lacks a background UDP discovery service AND manual search has
     * not been triggered yet, display the Search icon. Otherwise, display Refresh icon.
     * @private
     */
    _updateRefreshButtonIcon() {
        const btn = this.$('#refresh-discovery');
        if (!btn) return;

        const hasBgService = hasBackgroundDiscoveryService();
        // If device has no background UDP service and manual search has not been run yet, show search icon
        const showSearchIcon = !hasBgService && !this._hasSearchedManually;

        const searchSvg = `
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="11" cy="11" r="8"></circle>
                <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
            </svg>
        `;

        const refreshSvg = `
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M23 4v6h-6"></path>
                <path d="M1 20v-6h6"></path>
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
            </svg>
        `;

        if (showSearchIcon) {
            btn.innerHTML = searchSvg;
            btn.title = i18n.t('Search') || 'Search';
            btn.setAttribute('aria-label', i18n.t('Search') || 'Search');
        } else {
            btn.innerHTML = refreshSvg;
            btn.title = i18n.t('Refresh') || 'Refresh';
            btn.setAttribute('aria-label', i18n.t('Refresh') || 'Refresh');
        }
    }

    _renderDiscoveredServers() {
        // Layout-aware checks: in modern layout, we only need _serverList. In classic layout, we need both.
        const isModern = layoutManager.isModern();
        if (!this._serverList || (!isModern && !this._savedServerList)) return;

        // Remember current focus before destroying DOM to restore it smoothly afterwards
        const activeElement = document.activeElement;
        const isFocusInSavedList = this._savedServerList && this._savedServerList.contains(activeElement);
        const isFocusInDiscoveredList = this._serverList.contains(activeElement);
        const isFocusInList = isFocusInSavedList || isFocusInDiscoveredList;

        let focusedIndex = -1;
        let isFocusPreserved = false;

        // Retrieve index of currently focused server item to restore focus later
        if (isFocusInList && activeElement && activeElement.classList.contains('server-item')) {
            focusedIndex = parseInt(activeElement.getAttribute('data-server-index'), 10);
        } else if (activeElement && document.body.contains(activeElement)) {
            isFocusPreserved = true;
        }

        // Separate servers into saved and discovered categories for traditional classic rendering
        const savedServers = this._discoveredServers.filter((s) => s.isSaved);
        const otherServers = this._discoveredServers.filter((s) => !s.isSaved);

        // Update discovery status indicator visibility based on discovery state
        if (this._discoveryStatus) {
            // Only show scanning spinner/status if LAN discovery is active
            this._discoveryStatus.style.display = this._isDiscovering ? 'flex' : 'none';
        }

        if (isModern) {
            // ========================================================================
            // MODERN LAYOUT: Render both Saved and Discovered servers side-by-side
            // ========================================================================
            // We unify saved and discovered servers into a single responsive grid
            // to fulfill the user's preference of keeping them inline beside each other.

            // Handle the case where no servers at all have been found yet
            if (this._discoveredServers.length === 0) {
                // If LAN discovery has finished and there are zero servers, show a clean fallback
                if (!this._isDiscovering) {
                    this._serverList.innerHTML = `<li class="server-item empty">${i18n.t('NoItemsFound')}</li>`;
                } else {
                    // Empty list while the background discovery scan is actively searching
                    this._serverList.innerHTML = '';
                }
            } else {
                // Map the full collection into beautiful glassmorphic modern UI cards
                this._serverList.innerHTML = this._discoveredServers
                    .map((server) => {
                        // Retrieve the accurate index in the shared servers list for focus tracking
                        const index = this._discoveredServers.indexOf(server);

                        // If the server was already saved, render it with special badges and indicators
                        if (server.isSaved) {
                            return `
                                <li class="server-item saved" data-server-index="${index}" tabindex="0">
                                    <div class="server-icon-box">
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                            <rect x="2" y="2" width="20" height="8" rx="2" ry="2"></rect>
                                            <rect x="2" y="14" width="20" height="8" rx="2" ry="2"></rect>
                                            <line x1="6" y1="6" x2="6.01" y2="6"></line>
                                            <line x1="6" y1="18" x2="6.01" y2="18"></line>
                                        </svg>
                                        <!-- Active status dot indicating a fully saved/trusted server session -->
                                        <div class="status-dot"></div>
                                    </div>
                                    <div class="server-info">
                                        <div class="name-row">
                                            <span class="server-name">${server.name}</span>
                                            <span class="server-badge" data-i18n="SavedBadge">${i18n.t('SavedBadge') || 'Saved'}</span>
                                            ${server.version ? `<span class="server-version">v${server.version}</span>` : ''}
                                        </div>
                                        <span class="server-address">${server.address}</span>
                                    </div>
                                </li>
                            `;
                        } else {
                            // Standard discovered server card without extra saved badge
                            return `
                                <li class="server-item" data-server-index="${index}" tabindex="0">
                                    <div class="server-icon-box">
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                            <rect x="2" y="2" width="20" height="8" rx="2" ry="2"></rect>
                                            <rect x="2" y="14" width="20" height="8" rx="2" ry="2"></rect>
                                            <line x1="6" y1="6" x2="6.01" y2="6"></line>
                                            <line x1="6" y1="18" x2="6.01" y2="18"></line>
                                        </svg>
                                    </div>
                                    <div class="server-info">
                                        <div class="name-row">
                                            <span class="server-name">${server.name}</span>
                                            ${server.version ? `<span class="server-version">v${server.version}</span>` : ''}
                                        </div>
                                        <span class="server-address">${server.address}</span>
                                    </div>
                                </li>
                            `;
                        }
                    })
                    .join('');
            }
        } else {
            // ================================================================
            // CLASSIC LAYOUT: Traditional separate saved and discovered lists
            // ================================================================
            this._savedServerList.innerHTML = savedServers
                .map((server) => {
                    const index = this._discoveredServers.indexOf(server);
                    return `
                    <li class="server-item" data-server-index="${index}" tabindex="0">
                        <span class="server-name">${server.name}</span>
                        <span class="server-badge" data-i18n="SavedBadge">Saved</span>
                        <span class="server-address">${server.address}</span>
                        ${server.version ? `<span class="server-version">v${server.version}</span>` : ''}
                    </li>
                `;
                })
                .join('');

            // Render newly discovered LAN servers
            if (otherServers.length === 0) {
                // Show empty indicator only if scanning has stopped and no saved servers either
                if (!this._isDiscovering && savedServers.length === 0) {
                    this._serverList.innerHTML = `<li class="server-item empty">${i18n.t('NoItemsFound')}</li>`;
                } else {
                    this._serverList.innerHTML = '';
                }
            } else {
                this._serverList.innerHTML = otherServers
                    .map((server) => {
                        const index = this._discoveredServers.indexOf(server);
                        return `
                        <li class="server-item" data-server-index="${index}" tabindex="0">
                            <span class="server-name">${server.name}</span>
                            <span class="server-address">${server.address}</span>
                            ${server.version ? `<span class="server-version">v${server.version}</span>` : ''}
                        </li>
                    `;
                    })
                    .join('');
            }
        }

        // Invalidate spatial navigation focus cache to register the new list items
        focusManager.invalidateCache('login-server');

        // Restore focus to the previously focused item or keep the selection state
        if (isFocusInList && focusedIndex >= 0) {
            const selector = `.server-item[data-server-index="${focusedIndex}"]`;
            let item =
                (this._savedServerList && this._savedServerList.querySelector(selector)) ||
                this._serverList.querySelector(selector);

            if (!item) {
                // Nearest element index fallback if original item was removed
                const allItems = [
                    ...(this._savedServerList
                        ? this._savedServerList.querySelectorAll('.server-item:not(.empty)')
                        : []),
                    ...this._serverList.querySelectorAll('.server-item:not(.empty)')
                ];
                if (allItems.length > 0) {
                    item = allItems[Math.min(focusedIndex, allItems.length - 1)];
                }
            }

            if (item) {
                focusManager.focusElement(item);
            }
        } else if (isFocusPreserved) {
            // Fallback: restore active element focus in case focus was dropped on TV
            if (document.activeElement !== activeElement && document.body.contains(activeElement)) {
                focusManager.focusElement(activeElement);
            }
        }

        // Click handling is delegated on _serverList container in _bindEvents()
        // No per-item listeners needed — delegation survives innerHTML rebuilds
    }

    /**
     * Select a discovered server and populate the URL input
     */
    _selectDiscoveredServer(index) {
        const server = this._discoveredServers[index];
        if (server && this._serverInput) {
            this._serverInput.value = server.address;

            log.info(`Selected server ${server.name} (${server.address}) - initiating auto-connect`);

            // Automatically connect to the selected server immediately
            this._connectToServer();
        }
    }

    // ========================================================================
    // Quick Connect Flow
    // ========================================================================

    /**
     * Begin the Quick Connect login flow.
     *
     * 1. Checks the server has Quick Connect enabled.
     * 2. Calls /QuickConnect/Initiate to get a secret + a 6-digit code.
     * 3. Displays the code prominently on screen.
     * 4. Starts polling /QuickConnect/Connect every 5s.
     * 5. When Authenticated === true, exchanges the secret for a real token.
     * 6. Navigates to home on success, shows error on failure/timeout.
     */
    async _startQuickConnect() {
        log.info('LoginPage: Starting Quick Connect flow...');

        this._hideError('quick-connect-error');
        this._showState(STATE.LOADING);

        try {
            // Step 1 — Check the server has QC enabled before going further.
            // Some self-hosted servers have it disabled in admin settings.
            const isEnabled = await api.isQuickConnectEnabled();
            if (!isEnabled) {
                this._showState(STATE.USERS);
                this._showError('users-error', i18n.t('QuickConnectDisabled'));
                return;
            }

            // Step 2 — Initiate: get { Secret, Code }
            const result = await api.initiateQuickConnect();
            if (!result || !result.Secret || !result.Code) {
                throw new Error(i18n.t('Error'));
            }

            // Save secret for polling and (eventually) for authentication
            this._quickConnectSecret = result.Secret;
            this._quickConnectPollCount = 0;

            // Format the raw 6-character code as XXX-XXX for legibility on a TV
            const rawCode = String(result.Code);
            const displayCode = rawCode.length >= 6 ? `${rawCode.slice(0, 3)}-${rawCode.slice(3)}` : rawCode;

            // Step 3 — Show Quick Connect screen with the formatted code
            this._showState(STATE.QUICK_CONNECT);
            this.setActiveSection('login-quick-connect');

            const codeEl = this.$('#quick-connect-code');
            const statusEl = this.$('#quick-connect-status');
            if (codeEl) codeEl.textContent = displayCode;
            if (statusEl) statusEl.textContent = i18n.t('WaitingForAuthorization');

            // Focus the Cancel button so the TV remote has somewhere to go
            setTimeout(() => {
                const cancelBtn = this.$('[data-section="quick-connect"] .back-btn');
                if (cancelBtn) cancelBtn.focus();
            }, 100);

            // Step 4 — Start polling for authorization
            this._quickConnectPollTimer = setInterval(async () => {
                this._quickConnectPollCount++;

                // Bail out after max polls — 3 minute hard limit
                if (this._quickConnectPollCount > QUICK_CONNECT_MAX_POLLS) {
                    this._cancelQuickConnect();
                    this._showState(STATE.USERS);
                    this._showError('users-error', i18n.t('QuickConnectTimeout'));
                    return;
                }

                try {
                    const status = await api.checkQuickConnectStatus(this._quickConnectSecret);

                    if (status && status.Authenticated) {
                        // Authorization confirmed — clear polling before async work
                        const authorizedSecret = this._quickConnectSecret;
                        this._cancelQuickConnect();

                        this._showState(STATE.LOADING);

                        // Step 5 — Exchange the secret for an actual session token
                        await auth.loginWithQuickConnect(authorizedSecret);

                        log.info('Quick Connect login complete, navigating to home');
                        router.navigate('/home', { replace: true });
                    }
                    // If not yet authorized, keep polling silently
                } catch (pollError) {
                    // A single failed poll is not fatal — network blip, etc.
                    // Log and keep going until max polls.
                    log.warn('Quick Connect poll error (will retry):', pollError);
                }
            }, QUICK_CONNECT_POLL_INTERVAL);
        } catch (error) {
            log.error('Quick Connect initiation failed:', error);
            this._cancelQuickConnect();
            this._showState(STATE.USERS);
            this._showError('users-error', error.message || i18n.t('Error'));
        }
    }

    /**
     * Cancel an active Quick Connect session.
     * Clears the polling interval and resets UI to the user selection screen.
     * Called by the Cancel button, _goBack(), and destroy().
     */
    _cancelQuickConnect() {
        // Clear the poll interval if active
        if (this._quickConnectPollTimer !== null) {
            clearInterval(this._quickConnectPollTimer);
            this._quickConnectPollTimer = null;
            log.info('Quick Connect polling cancelled');
        }

        // Reset tracking state
        this._quickConnectSecret = null;
        this._quickConnectPollCount = 0;

        // Return to manual or user selection based on how we got here
        if (this._state === STATE.QUICK_CONNECT) {
            if (this._isManualLoginAutoRedirect) {
                this._showState(STATE.MANUAL);
                this.setActiveSection('login-manual');
            } else {
                this._showState(STATE.USERS);
                this.setActiveSection('login-users');
            }

            // Refocus the Quick Connect button so the user can try again
            setTimeout(() => {
                const activeSection = this.$(`[data-section="${this._state}"]`);
                const qcBtn = activeSection?.querySelector('.quick-connect-btn');
                if (qcBtn) qcBtn.focus();
            }, 100);
        }
    }
}

export default LoginPage;
