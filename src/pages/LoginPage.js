/**
 * ============================================================================
 * Litefin Tizen - Login Page
 * ============================================================================
 * Server connection and user authentication flow.
 * Steps: 1) Enter server URL -> 2) Select user -> 3) Enter password
 * ============================================================================
 */

import Page from './Page.js';
import { auth, api, discoverServers, cancelDiscovery, ServerUnreachableError } from '../api/index.js';
import { state } from '../core/StateManager.js';
import { router } from '../core/Router.js';
import { animationManager } from '../ui/AnimationManager.js';
import { focusManager } from '../ui/FocusManager.js';
import { storage } from '../utils/StorageService.js';
import { logger } from '../utils/Logger.js';
import { i18n } from '../utils/i18n.js';

const log = logger.create('Login');

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
        this._isLoggingIn = false;

        // Quick Connect polling state
        this._quickConnectSecret = null; // Secret returned by /QuickConnect/Initiate
        this._quickConnectPollTimer = null; // setInterval handle for status polling
        this._quickConnectPollCount = 0; // How many polls have been made so far
    }

    destroy() {
        // Stop any active discovery when leaving page
        cancelDiscovery();
        // Always cancel any in-flight Quick Connect poll on teardown
        this._cancelQuickConnect();
        super.destroy();
    }

    render() {
        return `
            <div class="page login-page">
                <div class="login-container">
                    <!-- Header -->
                    <div class="login-header">
                        <div class="login-logo-container">
                            <svg viewBox="0 0 100 100" class="login-logo-svg" preserveAspectRatio="xMidYMid meet">
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
                            <h1 class="login-logo">Litefin</h1>
                        </div>
                        <p class="login-tagline" data-i18n="LitefinTagline">${i18n.t('LitefinTagline')}</p>
                    </div>
                    
                    <!-- Server URL Form -->
                    <div class="login-section server-section" data-section="server">
                        <label class="input-label" data-i18n="ConnectToServer">Connect to Server</label>
                        <div class="server-input-container">
                            <input 
                                type="url" 
                                id="server-url" 
                                class="text-input tv-input server-url-input"
                                placeholder="https://your-server.com"
                                autocomplete="off"
                                readonly
                                tabindex="0"
                            >
                            <button type="button" class="btn btn-primary connect-btn" tabindex="0" data-i18n="Connect">
                                Connect
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
                            <div class="discovery-status" id="discovery-status">
                                <div class="loading-spinner-small"></div>
                                <span data-i18n="ScanningNetwork">Scanning network...</span>
                            </div>
                            <ul class="server-list" id="server-list"></ul>
                        </div>
                    </div>
                    
                    <!-- User Selection -->
                    <div class="login-section users-section hidden" data-section="users">
                        <h2 data-i18n="SelectUser">Select User</h2>
                        <div class="users-grid" id="users-grid">
                            <!-- Users will be rendered here -->
                        </div>
                        <p class="login-error" id="users-error"></p>
                        <div class="login-actions">
                            <button type="button" class="btn btn-secondary quick-connect-btn" tabindex="0" data-i18n="QuickConnect">
                                Quick Connect
                            </button>
                            <button type="button" class="btn btn-secondary manual-login-btn" tabindex="0" data-i18n="ButtonManualLogin">
                                Manual Login
                            </button>
                            <button type="button" class="btn btn-secondary change-server-btn" tabindex="0" data-i18n="ButtonChangeServer">
                                Log out of server
                            </button>
                        </div>
                    </div>
                    
                    <!-- Manual Login Form -->
                    <div class="login-section manual-section hidden" data-section="manual">
                        <h2 data-i18n="ManualLogin">Manual Login</h2>
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
                            <button type="button" class="btn btn-primary manual-signin-btn" tabindex="0" data-i18n="ButtonSignIn">
                                Sign In
                            </button>
                            <button type="button" class="btn btn-secondary back-btn" tabindex="0" data-i18n="ButtonBack">
                                Back
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
                            <button type="button" class="btn btn-primary login-btn" tabindex="0" data-i18n="ButtonSignIn">
                                Sign In
                            </button>
                            <button type="button" class="btn btn-secondary back-btn" tabindex="0" data-i18n="ButtonBack">
                                Back
                            </button>
                        </div>
                        <p class="login-error" id="password-error"></p>
                    </div>
                    
                    <!-- Quick Connect -->
                    <div class="login-section quick-connect-section hidden" data-section="quick-connect">
                        <h2 data-i18n="QuickConnect">Quick Connect</h2>
                        <p class="quick-connect-instructions" data-i18n="QuickConnectInstructions">
                            Open your Jellyfin app or web UI on another device, go to
                            Dashboard → Quick Connect, and enter this code:
                        </p>
                        <!-- The big, beautiful code the user reads off the screen -->
                        <div class="quick-connect-code" id="quick-connect-code">------</div>
                        <p class="quick-connect-status" id="quick-connect-status" data-i18n="WaitingForAuthorization">Waiting for authorization…</p>
                        <p class="login-error" id="quick-connect-error"></p>
                        <div class="login-actions">
                            <button type="button" class="btn btn-secondary back-btn" tabindex="0" data-i18n="ButtonCancel">
                                Cancel
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
        this._discoveryStatus = this.$('#discovery-status');

        // Translate the page
        i18n.translateDOM(this.el);

        // Bind events
        this._bindEvents();

        // Setup focus sections
        this._setupFocus();

        // Check if we have a saved server - auto-connect if so
        const savedUrl = auth.getSavedServerUrl();
        const isKnownOffline = state.get('server:offline') === true;

        if (savedUrl && !isKnownOffline) {
            // Server already saved and not known to be offline - skip server selection
            this._serverInput.value = savedUrl;
            this._autoConnectToSavedServer(savedUrl);
        } else {
            // No saved server or known offline - show server selection immediately
            if (savedUrl) {
                this._serverInput.value = savedUrl;
                this._showError('server-error', i18n.t('ServerUnreachableMessage'));
            }

            this._startDiscovery();
            setTimeout(() => {
                this._serverInput.focus();
            }, 100);
        }
    }

    _bindEvents() {
        // Connect button
        this.$('.connect-btn')?.addEventListener('click', () => this._connectToServer());

        // Refresh discovery button
        this.$('#refresh-discovery')?.addEventListener('click', () => {
            if (!this._isDiscovering) {
                this._startDiscovery();
            }
        });

        // Login button
        this.$('.login-btn')?.addEventListener('click', () => this._login());

        // Quick Connect button (on the users screen)
        this.$('.quick-connect-btn')?.addEventListener('click', () => this._startQuickConnect());

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
                const card = e.target.closest('.user-card');
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
     * Auto-connect to a saved server on app startup
     * Skips server selection and goes straight to user list
     * @param {string} savedUrl - The saved server URL
     */
    async _autoConnectToSavedServer(savedUrl) {
        log.info(`Auto-connecting to saved server ${savedUrl}`);
        this._showState(STATE.LOADING);

        try {
            this._serverUrl = savedUrl;
            await auth.connectToServer(savedUrl);

            // Get public users
            this._users = await api.getPublicUsers();

            if (this._users.length > 0) {
                this._renderUsers();
                this._showState(STATE.USERS);
                this.setActiveSection('login-users');

                // Focus first user card
                setTimeout(() => {
                    const firstCard = this._usersGrid.querySelector('.user-card');
                    if (firstCard) focusManager.focusElement(firstCard);
                }, 100);
            } else {
                // No public users - show manual login
                this._goToManualLogin();
            }
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
            }, 100);
        }
    }

    /**
     * Go to server selection screen (when Change Server button is clicked)
     * This is the only way users can change their server after initial setup.
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

        // Explicitly clear ONLY server URL for local purposes if not handled by logout
        // But auth.logout() handles the rest and notifies server
        storage.removeItem('litefin:serverUrl');

        // Call proper logout to notify server.
        // NOTE: AuthManager.logout() calls router.reset('/login') internally.
        auth.logout();

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

    async _connectToServer() {
        const url = this._serverInput.value.trim();

        if (!url) {
            this._showError('server-error', i18n.t('EnterServerURL'));
            return;
        }

        this._showState(STATE.LOADING);
        this._hideError('server-error');

        try {
            // Add https if no protocol
            const serverUrl = url.includes('://') ? url : `https://${url}`;
            this._serverUrl = serverUrl;

            // Connect to server
            // Stop scanning first
            cancelDiscovery();
            await auth.connectToServer(serverUrl);

            // Get public users
            this._users = await api.getPublicUsers();

            if (this._users.length > 0) {
                this._renderUsers();
                this._showState(STATE.USERS);
                this.setActiveSection('login-users');

                // Focus first user card
                setTimeout(() => {
                    const firstCard = this._usersGrid.querySelector('.user-card');
                    if (firstCard) focusManager.focusElement(firstCard);
                }, 100);
            } else {
                // No public users - go straight to manual entry
                this._showState(STATE.PASSWORD);
                this._selectedUser = { Name: '', Id: '' };
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
            this._showState(STATE.SERVER);
            if (error instanceof ServerUnreachableError) {
                this._showError('server-error', i18n.t('ServerUnreachableMessage'));
            } else {
                this._showError('server-error', error.message || i18n.t('Error'));
            }
        }
    }

    _renderUsers() {
        const html = this._users
            .map(
                (user, index) => `
            <div class="user-item">
                <button class="user-card" data-user-index="${index}" tabindex="0">
                        <img 
                            class="user-avatar ${user.PrimaryImageTag ? '' : 'hidden'}" 
                            src="${user.PrimaryImageTag ? api.getUserImageUrl(user.Id, { maxWidth: 300 }) : ''}"
                            alt="${user.Name}"
                            onerror="this.classList.add('hidden'); this.nextElementSibling.classList.remove('hidden')"
                        >
                        <div class="user-avatar-placeholder ${user.PrimaryImageTag ? 'hidden' : ''}">${user.Name.charAt(0).toUpperCase()}</div>
                </button>
                <div class="user-name">${user.Name}</div>
            </div>
        `
            )
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
    async _selectUser(user) {
        log.info(`LoginPage: _selectUser called for "${user?.Name}"`);

        if (!user) {
            log.error('LoginPage: _selectUser called with null/undefined user');
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
                router.navigate('/home', { replace: true });
            } else {
                // Password required - show password form
                log.info(`LoginPage: User "${user.Name}" requires password`);

                // Update password section with user info
                const userEl = this.$('#selected-user');
                userEl.querySelector('.user-name').textContent = user.Name;

                const img = userEl.querySelector('.user-avatar');
                const placeholder = userEl.querySelector('.user-avatar-placeholder');

                placeholder.textContent = user.Name.charAt(0).toUpperCase();

                if (user.PrimaryImageTag) {
                    img.src = api.getUserImageUrl(user.Id, { maxWidth: 100 });
                    img.classList.remove('hidden');
                    placeholder.classList.add('hidden');
                } else {
                    img.src = '';
                    img.classList.add('hidden');
                    placeholder.classList.remove('hidden');
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

            // Success! Navigate to home
            router.navigate('/home', { replace: true });
        } catch (error) {
            this._showState(STATE.PASSWORD);
            this._showError('password-error', error.message || i18n.t('Error'));
            this._passwordInput.focus();
        }
    }

    _goToManualLogin() {
        this._manualUsername.value = '';
        this._manualPassword.value = '';
        this._showState(STATE.MANUAL);
        this.setActiveSection('login-manual');
        this.setActiveSection('login-manual');
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

            router.navigate('/home', { replace: true });
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
            return;
        } else if (this._state === STATE.PASSWORD) {
            if (this._users.length > 0) {
                this._showState(STATE.USERS);
                this.setActiveSection('login-users');

                // Focus first user card
                setTimeout(() => {
                    const firstCard = this._usersGrid.querySelector('.user-card');
                    if (firstCard) firstCard.focus();
                }, 100);
                this.setActiveSection('login-server');
                setTimeout(() => this._serverInput.focus(), 100);
            }
        } else if (this._state === STATE.SERVER) {
            // Exit app if back is pressed on server screen
            if (typeof tizen !== 'undefined') {
                try {
                    tizen.application.getCurrentApplication().exit();
                } catch (e) {
                    log.error('App exit failed:', e);
                }
            } else {
                log.info('App exit (simulated)');
            }
        } else if (this._state === STATE.USERS) {
            this._showState(STATE.SERVER);
            this.setActiveSection('login-server');
            this.setActiveSection('login-server');
            this._serverInput.focus();
        } else if (this._state === STATE.MANUAL) {
            this._showState(STATE.USERS);
            this.setActiveSection('login-users');
            setTimeout(() => {
                this.$('.manual-login-btn')?.focus();
            }, 100);
        }
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
            animationManager.fadeIn(activeSection, { duration: 200 });
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
        this._goBack();
    }

    // ========================================================================
    // Server Discovery
    // ========================================================================

    /**
     * Start LAN server discovery in the background
     */
    async _startDiscovery() {
        if (this._isDiscovering) return;
        this._isDiscovering = true;

        log.info('LoginPage: Starting server discovery...');

        // Clear previous results
        this._discoveredServers = [];
        this._renderDiscoveredServers();

        try {
            // Show scanning status
            if (this._discoveryStatus) {
                this._discoveryStatus.style.display = 'flex';
            }

            // Run discovery
            const servers = await discoverServers(
                (checked, total) => {
                    // Update progress if desired
                    const percent = Math.round((checked / total) * 100);
                    log.info(`LoginPage: Discovery ${percent}%`);
                },
                (server) => {
                    // Server found! Add and render immediately
                    log.info(`LoginPage: Found server ${server.name} (${server.address})`);
                    this._discoveredServers.push(server);
                    this._renderDiscoveredServers();
                }
            );

            // Ensure final list is synced
            this._discoveredServers = servers;
            this._renderDiscoveredServers();
        } catch (error) {
            log.error('LoginPage: Discovery failed', error);
            if (this._discoveryStatus) {
                this._discoveryStatus.innerHTML = `<span>${i18n.t('Error')}</span>`;
            }
        } finally {
            this._isDiscovering = false;
        }
    }

    /**
     * Render discovered servers list
     */
    _renderDiscoveredServers() {
        if (!this._serverList) return;

        // Remember current focus before destroying DOM
        const activeElement = document.activeElement;
        const isFocusInList = this._serverList.contains(activeElement);
        let focusedIndex = -1;
        let isFocusPreserved = false;

        if (isFocusInList && activeElement && activeElement.classList.contains('server-item')) {
            focusedIndex = parseInt(activeElement.getAttribute('data-server-index'), 10);
        } else if (activeElement && document.body.contains(activeElement)) {
            isFocusPreserved = true;
        }

        // Hide scanning status
        if (this._discoveryStatus) {
            this._discoveryStatus.style.display = 'none';
        }

        if (this._discoveredServers.length === 0) {
            // Only show empty message if NOT discovering
            if (!this._isDiscovering) {
                this._serverList.innerHTML = `<li class="server-item empty">${i18n.t('NoItemsFound')}</li>`;
            } else {
                this._serverList.innerHTML = '';
            }
            return;
        }

        // Render server items
        this._serverList.innerHTML = this._discoveredServers
            .map(
                (server, index) => `
            <li class="server-item" data-server-index="${index}" tabindex="0">
                <span class="server-name">${server.name}</span>
                <span class="server-address">${server.address}</span>
                <span class="server-version">v${server.version || '?'}</span>
            </li>
        `
            )
            .join('');

        // Invalid focus cache so new items are found
        focusManager.invalidateCache('login-server');

        // Restore focus
        if (isFocusInList && focusedIndex >= 0) {
            const items = this._serverList.querySelectorAll('.server-item:not(.empty)');
            if (items.length > 0) {
                // Try to focus the same index, or the last available item if it was removed
                const indexToFocus = Math.min(focusedIndex, items.length - 1);
                focusManager.focusElement(items[indexToFocus]);
            }
        } else if (isFocusPreserved) {
            // Restore focus if Tizen dropped it from an unaffected element (e.g. server URL input)
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

            // Focus the Connect button so user can proceed immediately
            const connectBtn = this.$('.connect-btn');
            if (connectBtn) {
                connectBtn.focus();
            }

            log.info(`Selected server ${server.name} (${server.address})`);
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

        // Return to user selection if we're still on the Quick Connect screen
        if (this._state === STATE.QUICK_CONNECT) {
            this._showState(STATE.USERS);
            this.setActiveSection('login-users');

            // Refocus the Quick Connect button so the user can try again
            setTimeout(() => {
                const qcBtn = this.$('.quick-connect-btn');
                if (qcBtn) qcBtn.focus();
            }, 100);
        }
    }
}

export default LoginPage;
