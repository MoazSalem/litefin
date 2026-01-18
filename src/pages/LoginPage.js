/**
 * ============================================================================
 * LiteFin Tizen - Login Page
 * ============================================================================
 * Server connection and user authentication flow.
 * Steps: 1) Enter server URL -> 2) Select user -> 3) Enter password
 * ============================================================================
 */

import Page from './Page.js';
import { auth, api, discoverServers } from '../api/index.js';
import { router } from '../core/Router.js';
import { eventBus } from '../core/EventBus.js';
import { animationManager } from '../ui/AnimationManager.js';

// Login states
const STATE = {
    SERVER: 'server',
    USERS: 'users',
    PASSWORD: 'password',
    LOADING: 'loading'
};

class LoginPage extends Page {
    constructor() {
        super();
        this.title = 'Login';

        this._state = STATE.SERVER;
        this._users = [];
        this._selectedUser = null;
        this._serverUrl = '';
        this._discoveredServers = []; // Servers found via LAN discovery
        this._isDiscovering = false;
    }

    render() {
        return `
            <div class="page login-page">
                <div class="login-container">
                    <!-- Header -->
                    <div class="login-header">
                        <h1 class="login-logo">LiteFin</h1>
                        <p class="login-tagline">Jellyfin for Tizen</p>
                    </div>
                    
                    <!-- Server URL Form -->
                    <div class="login-section server-section" data-section="server">
                        <h2>Connect to Server</h2>
                        <div class="input-group">
                            <input 
                                type="url" 
                                id="server-url" 
                                class="text-input tv-input"
                                placeholder="https://your-server.com"
                                autocomplete="off"
                                tabindex="0"
                                readonly
                            >
                        </div>
                        <button class="btn btn-primary connect-btn" tabindex="0">
                            Connect
                        </button>
                        <p class="login-error" id="server-error"></p>
                        
                        <!-- Discovered Servers -->
                        <div class="discovered-servers" id="discovered-servers">
                            <h3>Discovered Servers</h3>
                            <div class="discovery-status" id="discovery-status">
                                <div class="loading-spinner-small"></div>
                                <span>Scanning network...</span>
                            </div>
                            <ul class="server-list" id="server-list"></ul>
                        </div>
                    </div>
                    
                    <!-- User Selection -->
                    <div class="login-section users-section hidden" data-section="users">
                        <h2>Select User</h2>
                        <div class="users-grid" id="users-grid">
                            <!-- Users will be rendered here -->
                        </div>
                        <button class="btn btn-secondary back-btn" tabindex="0">
                            Back
                        </button>
                    </div>
                    
                    <!-- Password Form -->
                    <div class="login-section password-section hidden" data-section="password">
                        <h2>Enter Password</h2>
                        <div class="selected-user" id="selected-user">
                            <img class="user-avatar" src="" alt="">
                            <span class="user-name"></span>
                        </div>
                        <div class="input-group">
                            <input 
                                type="password" 
                                id="password-input" 
                                class="text-input tv-input"
                                placeholder="Password (leave empty if none)"
                                tabindex="0"
                                readonly
                            >
                        </div>
                        <button class="btn btn-primary login-btn" tabindex="0">
                            Sign In
                        </button>
                        <button class="btn btn-secondary back-btn" tabindex="0">
                            Back
                        </button>
                        <p class="login-error" id="password-error"></p>
                    </div>
                    
                    <!-- Loading -->
                    <div class="login-section loading-section hidden" data-section="loading">
                        <div class="loading-spinner"></div>
                        <p>Connecting...</p>
                    </div>
                </div>
            </div>
        `;
    }

    onMounted() {
        // Get element references
        this._serverInput = this.$('#server-url');
        this._passwordInput = this.$('#password-input');
        this._usersGrid = this.$('#users-grid');
        this._serverList = this.$('#server-list');
        this._discoveryStatus = this.$('#discovery-status');

        // Load saved server URL
        const savedUrl = auth.getSavedServerUrl();
        if (savedUrl) {
            this._serverInput.value = savedUrl;
        }

        // Bind events
        this._bindEvents();

        // Setup focus sections
        this._setupFocus();

        // Start server discovery in background
        this._startDiscovery();

        // Set initial focus
        setTimeout(() => {
            this._serverInput.focus();
        }, 100);
    }

    _bindEvents() {
        // Connect button
        this.$('.connect-btn')?.addEventListener('click', () => this._connectToServer());

        // Login button
        this.$('.login-btn')?.addEventListener('click', () => this._login());

        // Back buttons
        this.$$('.back-btn').forEach(btn => {
            btn.addEventListener('click', () => this._goBack());
        });

        // Enter key on inputs - open keyboard first, or submit if already editable
        this._serverInput?.addEventListener('keydown', (e) => {
            if (e.keyCode === 13) {
                if (this._serverInput.readOnly) {
                    // First Enter press: enable editing and open keyboard
                    this._serverInput.readOnly = false;
                    this._serverInput.focus();
                } else {
                    // Second Enter press: submit
                    this._serverInput.readOnly = true;
                    this._connectToServer();
                }
            }
        });

        // Restore readonly when input loses focus
        this._serverInput?.addEventListener('blur', () => {
            this._serverInput.readOnly = true;
        });

        this._passwordInput?.addEventListener('keydown', (e) => {
            if (e.keyCode === 13) {
                if (this._passwordInput.readOnly) {
                    // First Enter press: enable editing and open keyboard
                    this._passwordInput.readOnly = false;
                    this._passwordInput.focus();
                } else {
                    // Second Enter press: submit
                    this._passwordInput.readOnly = true;
                    this._login();
                }
            }
        });

        // Restore readonly when input loses focus
        this._passwordInput?.addEventListener('blur', () => {
            this._passwordInput.readOnly = true;
        });
    }

    _setupFocus() {
        // Register server section - vertical for input + button + discovered servers
        this.registerFocusSection('login-server', this.$('[data-section="server"]'), {
            orientation: 'vertical'
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

        this.setActiveSection('login-server');
    }

    async _connectToServer() {
        const url = this._serverInput.value.trim();

        if (!url) {
            this._showError('server-error', 'Please enter a server URL');
            return;
        }

        this._showState(STATE.LOADING);
        this._hideError('server-error');

        try {
            // Add https if no protocol
            const serverUrl = url.includes('://') ? url : `https://${url}`;
            this._serverUrl = serverUrl;

            // Connect to server
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
                    if (firstCard) firstCard.focus();
                }, 100);
            } else {
                // No public users - go straight to manual entry
                this._showState(STATE.PASSWORD);
                this._selectedUser = { Name: '', Id: '' };
                this.setActiveSection('login-password');

                // Focus password input
                setTimeout(() => this._passwordInput.focus(), 100);
            }
        } catch (error) {
            this._showState(STATE.SERVER);
            this._showError('server-error', error.message || 'Failed to connect');
        }
    }

    _renderUsers() {
        const html = this._users.map((user, index) => `
            <button class="user-card" data-user-index="${index}" tabindex="0">
                <div class="user-avatar-wrapper">
                    <img 
                        class="user-avatar" 
                        src="${user.PrimaryImageTag ? api.getUserImageUrl(user.Id, { maxWidth: 150 }) : ''}"
                        alt="${user.Name}"
                        onerror="this.style.display='none'"
                    >
                    <div class="user-avatar-placeholder">${user.Name.charAt(0).toUpperCase()}</div>
                </div>
                <span class="user-name">${user.Name}</span>
            </button>
        `).join('');

        this._usersGrid.innerHTML = html;

        // Add click and keyboard handlers
        this._usersGrid.querySelectorAll('.user-card').forEach(card => {
            card.addEventListener('click', () => {
                const index = parseInt(card.dataset.userIndex);
                this._selectUser(this._users[index]);
            });

            // Enter key to select user
            card.addEventListener('keydown', (e) => {
                if (e.keyCode === 13) {
                    const index = parseInt(card.dataset.userIndex);
                    this._selectUser(this._users[index]);
                }
            });
        });
    }

    _selectUser(user) {
        this._selectedUser = user;

        // Update password section with user info
        const userEl = this.$('#selected-user');
        userEl.querySelector('.user-name').textContent = user.Name;
        userEl.querySelector('.user-avatar').src = user.PrimaryImageTag
            ? api.getUserImageUrl(user.Id, { maxWidth: 100 })
            : '';

        // Clear password
        this._passwordInput.value = '';

        // Show password section
        this._showState(STATE.PASSWORD);
        this.setActiveSection('login-password');

        // Focus password input
        setTimeout(() => this._passwordInput.focus(), 100);
    }

    async _login() {
        this._hideError('password-error');

        const password = this._passwordInput.value;
        const username = this._selectedUser.Name;

        this._showState(STATE.LOADING);

        try {
            await auth.login(username, password);

            // Success! Navigate to home
            router.navigate('/home', { replace: true });
        } catch (error) {
            this._showState(STATE.PASSWORD);
            this._showError('password-error', error.message || 'Login failed');
            this._passwordInput.focus();
        }
    }

    _goBack() {
        if (this._state === STATE.PASSWORD) {
            if (this._users.length > 0) {
                this._showState(STATE.USERS);
                this.setActiveSection('login-users');

                // Focus first user card
                setTimeout(() => {
                    const firstCard = this._usersGrid.querySelector('.user-card');
                    if (firstCard) firstCard.focus();
                }, 100);
            } else {
                this._showState(STATE.SERVER);
                this.setActiveSection('login-server');
                setTimeout(() => this._serverInput.focus(), 100);
            }
        } else if (this._state === STATE.USERS) {
            this._showState(STATE.SERVER);
            this.setActiveSection('login-server');
            this._serverInput.focus();
        }
    }

    _showState(newState) {
        this._state = newState;

        // Hide all sections
        this.$$('.login-section').forEach(section => {
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

        console.log('LoginPage: Starting server discovery...');

        try {
            // Show scanning status
            if (this._discoveryStatus) {
                this._discoveryStatus.style.display = 'flex';
            }

            // Run discovery
            const servers = await discoverServers((checked, total) => {
                // Update progress if desired
                const percent = Math.round((checked / total) * 100);
                console.log(`LoginPage: Discovery ${percent}%`);
            });

            this._discoveredServers = servers;

            // Render discovered servers
            this._renderDiscoveredServers();

        } catch (error) {
            console.error('LoginPage: Discovery failed', error);
            if (this._discoveryStatus) {
                this._discoveryStatus.innerHTML = '<span>Discovery failed</span>';
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

        // Hide scanning status
        if (this._discoveryStatus) {
            this._discoveryStatus.style.display = 'none';
        }

        if (this._discoveredServers.length === 0) {
            this._serverList.innerHTML = '<li class="server-item empty">No servers found</li>';
            return;
        }

        // Render server items
        this._serverList.innerHTML = this._discoveredServers.map((server, index) => `
            <li class="server-item" data-server-index="${index}" tabindex="0">
                <span class="server-name">${server.name}</span>
                <span class="server-address">${server.address}</span>
                <span class="server-version">v${server.version || '?'}</span>
            </li>
        `).join('');

        // Bind click events
        this._serverList.querySelectorAll('.server-item:not(.empty)').forEach(item => {
            item.addEventListener('click', () => {
                const index = parseInt(item.dataset.serverIndex);
                this._selectDiscoveredServer(index);
            });
            item.addEventListener('keydown', (e) => {
                if (e.keyCode === 13) {
                    const index = parseInt(item.dataset.serverIndex);
                    this._selectDiscoveredServer(index);
                }
            });
        });
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

            console.log(`LoginPage: Selected server ${server.name} (${server.address})`);
        }
    }
}

export default LoginPage;
