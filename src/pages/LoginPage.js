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
import { focusManager } from '../ui/FocusManager.js';

// Login states
const STATE = {
    SERVER: 'server',
    USERS: 'users',
    PASSWORD: 'password',
    MANUAL: 'manual',
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
        this._isLoggingIn = false;
    }

    render() {
        return `
            <div class="page login-page">
                <div class="login-container">
                    <!-- Header -->
                    <div class="login-header">
                        <h1 class="login-logo">LiteFin</h1>
                        <p class="login-tagline">Jellyfin Client for Tizen OS</p>
                    </div>
                    
                    <!-- Server URL Form -->
                    <div class="login-section server-section" data-section="server">
                        <label class="input-label">Connect to Server</label>
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
                            <button type="button" class="btn btn-primary connect-btn" tabindex="0">
                                Connect
                            </button>
                        </div>
                        <p class="login-error" id="server-error"></p>
                        
                        <!-- Discovered Servers -->
                        <div class="discovered-servers" id="discovered-servers">
                            <div class="discovered-header">
                                <h3>Discovered Servers</h3>
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
                        <p class="login-error" id="users-error"></p>
                        <div class="login-actions">
                            <button type="button" class="btn btn-secondary manual-login-btn" tabindex="0">
                                Manual Login
                            </button>
                            <button type="button" class="btn btn-secondary change-server-btn" tabindex="0">
                                Log out of server
                            </button>
                        </div>
                    </div>
                    
                    <!-- Manual Login Form -->
                    <div class="login-section manual-section hidden" data-section="manual">
                        <h2>Manual Login</h2>
                        <div class="input-group">
                            <input 
                                type="text" 
                                id="manual-username" 
                                class="text-input tv-input"
                                placeholder="Username"
                                readonly
                                tabindex="0"
                            >
                        </div>
                        <div class="input-group">
                            <input 
                                type="password" 
                                id="manual-password" 
                                class="text-input tv-input"
                                placeholder="Password"
                                readonly
                                tabindex="0"
                            >
                        </div>
                        <button type="button" class="btn btn-primary manual-signin-btn" tabindex="0">
                            Sign In
                        </button>
                        <button type="button" class="btn btn-secondary back-btn" tabindex="0">
                            Back
                        </button>
                        <p class="login-error" id="manual-error"></p>
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
                                readonly
                                tabindex="0"
                            >
                        </div>
                        <button type="button" class="btn btn-primary login-btn" tabindex="0">
                            Sign In
                        </button>
                        <button type="button" class="btn btn-secondary back-btn" tabindex="0">
                            Back
                        </button>
                        <p class="login-error" id="password-error"></p>
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
        // CRITICAL: Clear any stale authentication data when entering login screen
        // This prevents 401 errors from stale tokens if logout failed
        console.log('LoginPage: Clearing any stale auth data');
        api.clearAuth();

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

        // Bind events
        this._bindEvents();

        // Setup focus sections
        this._setupFocus();

        // Check if we have a saved server - auto-connect if so
        const savedUrl = auth.getSavedServerUrl();
        if (savedUrl) {
            // Server already saved - skip server selection, go straight to users
            this._serverInput.value = savedUrl;
            this._autoConnectToSavedServer(savedUrl);
        } else {
            // No saved server - show server selection
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

        // Manual Login buttons
        this.$('.manual-login-btn')?.addEventListener('click', () => this._goToManualLogin());
        this.$('.manual-signin-btn')?.addEventListener('click', () => this._handleManualLogin());

        // Back buttons (for password and manual screens)
        this.$$('.back-btn').forEach(btn => {
            btn.addEventListener('click', () => this._goBack());
        });

        // Change Server button - goes back to server selection
        this.$('.change-server-btn')?.addEventListener('click', () => this._goToServerSelection());

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

        // Manual Login inputs handling
        this._setupInputHandler(this._manualUsername, () => this._manualPassword.focus());
        this._setupInputHandler(this._manualPassword, () => this._handleManualLogin());
    }

    _setupInputHandler(input, onSubmit) {
        if (!input) return;
        input.addEventListener('keydown', (e) => {
            if (e.keyCode === 13) {
                if (input.readOnly) {
                    input.readOnly = false;
                    input.focus();
                } else {
                    input.readOnly = true;
                    if (onSubmit) onSubmit();
                }
            }
        });
        input.addEventListener('blur', () => {
            if (input) input.readOnly = true;
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

        this.setActiveSection('login-server');
    }

    /**
     * Auto-connect to a saved server on app startup
     * Skips server selection and goes straight to user list
     * @param {string} savedUrl - The saved server URL
     */
    async _autoConnectToSavedServer(savedUrl) {
        console.log(`LoginPage: Auto-connecting to saved server ${savedUrl}`);
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
                    if (firstCard) firstCard.focus();
                }, 100);
            } else {
                // No public users - show manual login
                this._goToManualLogin();
            }
        } catch (error) {
            // Connection failed - show server selection
            console.warn('LoginPage: Auto-connect failed, showing server selection');
            this._showState(STATE.SERVER);
            this._startDiscovery();
            setTimeout(() => this._serverInput.focus(), 100);
        }
    }

    /**
     * Go to server selection screen (when Change Server button is clicked)
     * This is the only way users can change their server after initial setup
     */
    /**
     * Go to server selection screen (when Change Server button is clicked)
     * This is the only way users can change their server after initial setup
     */
    _goToServerSelection() {
        console.log('LoginPage: Going to server selection');

        // Explicitly clear ONLY server URL for local purposes if not handled by logout
        // But auth.logout() handles the rest and notifies server
        localStorage.removeItem('litefin:serverUrl');

        // Call proper logout to notify server
        auth.logout();

        // Reset state
        this._showState(STATE.SERVER);
        this.setActiveSection('login-server');

        // Clear visible errors (since onMounted might not run)
        this._hideError('server-error');
        this._hideError('manual-error');
        this._hideError('password-error');
        this._hideError('users-error');

        // Reset navigator history
        router.reset('/login');

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
                setTimeout(() => {
                    if (this._passwordInput) {
                        this._passwordInput.readOnly = true;
                        this._passwordInput.focus();
                    }
                }, 100);
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
                    <div class="user-avatar-placeholder">${user.Name.charAt(0).toUpperCase()}</div>
                    <img 
                        class="user-avatar" 
                        src="${user.PrimaryImageTag ? api.getUserImageUrl(user.Id, { maxWidth: 300 }) : ''}"
                        alt="${user.Name}"
                        onerror="this.style.display='none'"
                    >
                </div>
                <span class="user-name">${user.Name}</span>
            </button>
        `).join('');

        this._usersGrid.innerHTML = html;

        // Invalidate focus cache so new items are found
        focusManager.invalidateCache('login-users');

        // Add click and keyboard handlers
        this._usersGrid.querySelectorAll('.user-card').forEach(card => {
            card.addEventListener('click', () => {
                const index = parseInt(card.dataset.userIndex);
                console.log(`LoginPage: User card clicked, index=${index}`);
                if (this._users[index]) {
                    console.log(`LoginPage: User found: ${this._users[index].Name}`);
                    this._selectUser(this._users[index]);
                } else {
                    console.error(`LoginPage: No user at index ${index}`);
                }
            });

            // Enter key to select user
            card.addEventListener('keydown', (e) => {
                if (e.keyCode === 13) {
                    const index = parseInt(card.dataset.userIndex);
                    console.log(`LoginPage: User card Enter pressed, index=${index}`);
                    if (this._users[index]) {
                        this._selectUser(this._users[index]);
                    }
                }
            });
        });
    }

    /**
     * Handle user card selection
     * If user has no password, login directly
     * If user has password, show password form
     * @param {Object} user - User object from getPublicUsers
     */
    async _selectUser(user) {
        console.log(`LoginPage: _selectUser called for "${user?.Name}"`);

        if (!user) {
            console.error('LoginPage: _selectUser called with null/undefined user');
            return;
        }

        try {
            this._selectedUser = user;

            // Check HasPassword field (key jellyfin-web pattern)
            if (user.HasPassword === false) {
                // No password required - login directly
                console.log(`LoginPage: User "${user.Name}" has no password, logging in directly`);
                this._showState(STATE.LOADING);

                await auth.login(user.Name, '');
                router.navigate('/home', { replace: true });
            } else {
                // Password required - show password form
                console.log(`LoginPage: User "${user.Name}" requires password`);

                // Update password section with user info
                const userEl = this.$('#selected-user');
                userEl.querySelector('.user-name').textContent = user.Name;
                userEl.querySelector('.user-avatar').src = user.PrimaryImageTag
                    ? api.getUserImageUrl(user.Id, { maxWidth: 100 })
                    : '';

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
            console.error('LoginPage: _selectUser error:', error);
            this._showState(STATE.USERS);
            this._showError('users-error', error.message || 'Login failed');
        }
    }

    async _login() {
        this._hideError('password-error');

        const password = this._passwordInput.value;
        const username = this._selectedUser.Name;

        this._showState(STATE.LOADING);

        try {
            console.log('LoginPage: AuthManager.login calling...');
            await auth.login(username, password);
            console.log('LoginPage: AuthManager.login success. Navigating to home...');

            // Short delay to ensure state propagation
            await new Promise(resolve => setTimeout(resolve, 50));

            // Success! Navigate to home
            router.navigate('/home', { replace: true });
        } catch (error) {
            this._showState(STATE.PASSWORD);
            this._showError('password-error', error.message || 'Login failed');
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

        console.log(`LoginPage: Manual Login. User="${username}" PassLength=${password ? password.length : 0}`);

        if (!username) {
            this._showError('manual-error', 'Username is required');
            return;
        }

        this._showState(STATE.LOADING);

        try {
            console.log('LoginPage: AuthManager.login calling...');
            await auth.login(username, password);
            console.log('LoginPage: AuthManager.login success. Navigating to home...');

            // Short delay to ensure state propagation
            await new Promise(resolve => setTimeout(resolve, 50));

            router.navigate('/home', { replace: true });
        } catch (error) {
            this._showState(STATE.MANUAL);
            this._showError('manual-error', error.message || 'Login failed');
            this._manualUsername.focus();
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
                this.setActiveSection('login-server');
                setTimeout(() => this._serverInput.focus(), 100);
            }
        } else if (this._state === STATE.SERVER) {
            // Exit app if back is pressed on server screen
            if (typeof tizen !== 'undefined') {
                try {
                    tizen.application.getCurrentApplication().exit();
                } catch (e) {
                    console.error('App exit failed:', e);
                }
            } else {
                console.log('App exit (simulated)');
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
                    console.log(`LoginPage: Discovery ${percent}%`);
                },
                (server) => {
                    // Server found! Add and render immediately
                    console.log(`LoginPage: Found server ${server.name} (${server.address})`);
                    this._discoveredServers.push(server);
                    this._renderDiscoveredServers();
                }
            );

            // Ensure final list is synced
            this._discoveredServers = servers;
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
            // Only show empty message if NOT discovering
            if (!this._isDiscovering) {
                this._serverList.innerHTML = '<li class="server-item empty">No servers found</li>';
            } else {
                this._serverList.innerHTML = '';
            }
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

        // Invalid focus cache so new items are found
        focusManager.invalidateCache('login-server');

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

    /**
     * Initialize debug overlay
     * Intercepts console logs and shows them on screen
     */
    _initDebugOverlay() {
        const overlay = this.$('#debug-overlay');
        const content = this.$('#debug-content');

        if (!overlay || !content) return;

        // Make overlay visible
        overlay.style.display = 'block';

        // Keep original console methods
        const originalLog = console.log;
        const originalError = console.error;
        const originalWarn = console.warn;

        const addLog = (type, args) => {
            const line = document.createElement('div');
            line.style.borderBottom = '1px solid #333';
            line.style.padding = '2px 0';

            if (type === 'error') line.style.color = '#f55';
            else if (type === 'warn') line.style.color = '#fa0';

            const text = args.map(arg => {
                if (typeof arg === 'object') return JSON.stringify(arg);
                return String(arg);
            }).join(' ');

            line.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
            content.appendChild(line);

            // Auto-scroll
            overlay.scrollTop = overlay.scrollHeight;
        };

        console.log = (...args) => {
            originalLog.apply(console, args);
            addLog('log', args);
        };

        console.error = (...args) => {
            originalError.apply(console, args);
            addLog('error', args);
        };

        console.warn = (...args) => {
            originalWarn.apply(console, args);
            addLog('warn', args);
        };

        console.log('LoginPage: Debug overlay initialized');
    }
}

export default LoginPage;
