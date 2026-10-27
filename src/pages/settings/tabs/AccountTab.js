/**
 * ============================================================================
 * Litefin Tizen - Account Tab Controller
 * ============================================================================
 * Manages active user account details, avatar rendering, profile PIN security,
 * auto-login preferences, custom reverse-proxy headers, profile switching,
 * and user session termination.
 * ============================================================================
 */

import { auth, api } from '../../../api/index.js';
import { storage } from '../../../utils/StorageService.js';
import { i18n } from '../../../utils/i18n.js';
import { pinManager } from '../../../utils/PinManager.js';
import { pinDialog } from '../../../ui/PinDialog.js';
import { customHeadersDialog } from '../../../ui/CustomHeadersDialog.js';
import { router } from '../../../core/Router.js';
import { escapeHtml } from '../../../utils/Utils.js';

/**
 * Controller for the Settings Account management tab.
 */
export class AccountTab {
    /**
     * Creates an instance of AccountTab.
     * @param {Object} pageContext The parent SettingsPage instance
     */
    constructor(pageContext) {
        // Retain reference to parent SettingsPage for tab switching and dom helpers
        this.page = pageContext;

        // Track active event listeners for deterministic cleanup
        this._listeners = [];
    }

    /**
     * Renders avatar image markup or initials fallback for the given user profile.
     * @param {Object} user Current authenticated user payload
     * @returns {string} Serialized HTML markup for the avatar
     */
    renderUserAvatar(user) {
        // Check whether user profile possesses a custom primary avatar image on server
        if (user?.PrimaryImageTag) {
            const imageUrl = api.getUserImageUrl(user.Id, {
                tag: user.PrimaryImageTag,
                quality: 90,
                maxWidth: 300
            });

            // Fallback gracefully to placeholder initial if network loading fails
            return `<img src="${imageUrl}" class="user-avatar" alt="${escapeHtml(user.Name)}" onerror="this.classList.add('hidden'); this.nextElementSibling.classList.remove('hidden')">
                    <div class="user-avatar-placeholder hidden">${escapeHtml(user.Name ? user.Name[0].toUpperCase() : '?')}</div>`;
        }

        // Render fallback letter badge if no image tag exists
        return `<div class="user-avatar-placeholder">${user?.Name ? user.Name[0].toUpperCase() : '?'}</div>`;
    }

    /**
     * Generates HTML markup for the Account tab.
     * Includes profile card, PIN security controls, auto-login switch,
     * reverse proxy headers button, and session management actions.
     * @returns {string} Serialized HTML template
     */
    render() {
        // Resolve active authenticated user and server connection endpoint
        const user = auth.getCurrentUser();
        const serverUrl = auth.getSavedServerUrl();
        const userId = user?.Id;

        // Query whether a profile security PIN is currently enforced
        const hasPin = userId ? pinManager.hasPin(userId) : false;

        // Check whether automatic login for last active user is enabled
        const rememberLastUser = storage.getItem('pref:rememberLastActiveUser') === 'true';

        return `
            <div class="settings-tab-content">
                <h2 class="content-title" data-i18n="Account">${i18n.t('Account')}</h2>
                <p class="content-subtitle" data-i18n="AccountTabDescription">
                    ${i18n.t('AccountTabDescription') || 'Manage active user sessions, switch profiles, configure security PINs, and sign out.'}
                </p>

                <div class="user-profile-card">
                    <div class="user-avatar-wrapper">
                         ${this.renderUserAvatar(user)}
                    </div>
                    <h3 class="user-name-large">${user?.Name || i18n.t('Guest')}</h3>
                    <p class="server-url-display">${serverUrl || i18n.t('Offline')}</p>
                </div>

                ${
                    userId
                        ? `
                <h3 class="setting-section-title" data-i18n="ProfilePin">${i18n.t('ProfilePin')}</h3>
                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="RequirePin">${i18n.t('RequirePin')}</span>
                        <span class="setting-description" data-i18n="RequirePinDescription">${i18n.t('RequirePinDescription')}</span>
                    </div>
                    <div class="setting-control">
                        <button class="toggle-switch ${hasPin ? 'active' : ''}" id="toggle-profile-pin" tabindex="0"></button>
                    </div>
                </div>
                ${
                    hasPin
                        ? `<div class="setting-actions centered">
                        <button class="btn btn-secondary btn-small focusable" id="btn-change-pin" tabindex="0" data-i18n="ChangePin">${i18n.t('ChangePin')}</button>
                    </div>`
                        : ''
                }
                `
                        : ''
                }

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="RememberLastActiveUser">${i18n.t('RememberLastActiveUser')}</span>
                        <span class="setting-description" data-i18n="RememberLastActiveUserDescription">${i18n.t('RememberLastActiveUserDescription')}</span>
                    </div>
                    <div class="setting-control">
                        <button class="toggle-switch ${rememberLastUser ? 'active' : ''}" id="toggle-remember-last-user" tabindex="0"></button>
                    </div>
                </div>

                <!-- Custom HTTP Reverse Proxy Headers -->
                <h3 class="setting-section-title" data-i18n="CustomHttpHeaders">${i18n.t('CustomHttpHeaders') || 'Custom HTTP Headers'}</h3>
                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="ProxyAuthHeaders">${i18n.t('ProxyAuthHeaders') || 'Reverse Proxy Headers'}</span>
                        <span class="setting-description" data-i18n="ProxyAuthHeadersDesc">
                            ${i18n.t('ProxyAuthHeadersDesc') || 'Configure proxy gateway headers (e.g. Cloudflare Zero Trust, Pangolin) for this Jellyfin server.'}
                        </span>
                    </div>
                    <div class="setting-control">
                        <button class="btn btn-secondary btn-small focusable" id="btn-custom-headers" tabindex="0">
                            ${i18n.t('ConfigureHeaders') || 'Configure Headers'}
                        </button>
                    </div>
                </div>

                <div class="setting-actions centered">
                    <!-- Navigate to the Who's Watching screen to pick a different profile -->
                    <button class="btn btn-secondary btn-small switch-profiles-btn focusable" 
                            id="btn-switch-profiles"
                            tabindex="0" 
                            data-nav-right="#btn-sign-out"
                            data-i18n="SwitchUsers">
                        ${i18n.t('SwitchUsers')}
                    </button>

                    <!-- Sign out the current user session (other sessions preserved) -->
                    <button class="btn btn-danger btn-small switch-user-btn focusable" 
                            id="btn-sign-out"
                            tabindex="0" 
                            data-nav-left="#btn-switch-profiles"
                            data-i18n="ButtonSignOut">
                        ${i18n.t('ButtonSignOut')}
                    </button>
                </div>
            </div>
        `;
    }

    /**
     * Helper to attach and track an event listener for cleanup.
     * @private
     */
    _addListener(element, event, handler) {
        if (!element) return;
        element.addEventListener(event, handler);
        this._listeners.push({ element, event, handler });
    }

    /**
     * Binds interactive events for Account tab controls.
     * @param {HTMLElement} [container] Root settings DOM element
     */
    mount(container) {
        // Clean up any stale listeners before binding new nodes
        this._unbindListeners();

        // Scope queries to container if provided, falling back to parent page or document
        const root =
            container ||
            (this.page && typeof this.page.$ === 'function' ? this.page.element : null) ||
            document;

        // ====================================================================
        // Profile PIN Enable / Disable Toggle
        // ====================================================================
        const profilePinToggle = root.querySelector('#toggle-profile-pin');
        if (profilePinToggle) {
            this._addListener(profilePinToggle, 'click', () => {
                const userId = auth.getCurrentUser()?.Id;
                if (!userId) return;

                if (pinManager.hasPin(userId)) {
                    // Currently enabled: verify current PIN before allowing removal
                    pinDialog.show({
                        mode: 'verify',
                        userId,
                        title: i18n.t('EnterPin') || 'Enter PIN',
                        onSuccess: () => {
                            pinManager.removePin(userId);
                            if (this.page && typeof this.page._switchTab === 'function') {
                                this.page._switchTab('account', true);
                            }
                        }
                    });
                } else {
                    // Currently disabled: prompt user to configure a new PIN
                    pinDialog.show({
                        mode: 'set',
                        title: i18n.t('SetPin') || 'Set PIN',
                        onSuccess: (pin) => {
                            pinManager.setPin(userId, pin);
                            if (this.page && typeof this.page._switchTab === 'function') {
                                this.page._switchTab('account', true);
                            }
                        }
                    });
                }
            });
        }

        // ====================================================================
        // Change Existing PIN Action
        // ====================================================================
        const changePinBtn = root.querySelector('#btn-change-pin');
        if (changePinBtn) {
            this._addListener(changePinBtn, 'click', () => {
                const userId = auth.getCurrentUser()?.Id;
                if (!userId) return;

                // Enforce authentication of previous PIN before opening set mode
                pinDialog.show({
                    mode: 'verify',
                    userId,
                    title: i18n.t('EnterPin') || 'Enter PIN',
                    onSuccess: () => {
                        pinDialog.show({
                            mode: 'set',
                            title: i18n.t('ChangePin') || 'Change PIN',
                            onSuccess: (pin) => {
                                pinManager.setPin(userId, pin);
                                if (this.page && typeof this.page._switchTab === 'function') {
                                    this.page._switchTab('account', true);
                                }
                            }
                        });
                    }
                });
            });
        }

        // ====================================================================
        // Remember Last Active User Toggle
        // ====================================================================
        const rememberLastUserToggle = root.querySelector('#toggle-remember-last-user');
        if (rememberLastUserToggle) {
            this._addListener(rememberLastUserToggle, 'click', () => {
                const isCurrentlyActive = storage.getItem('pref:rememberLastActiveUser') === 'true';
                const nextState = !isCurrentlyActive;

                // Update storage and toggle button visual class
                storage.setItem('pref:rememberLastActiveUser', String(nextState));
                rememberLastUserToggle.classList.toggle('active', nextState);
            });
        }

        // ====================================================================
        // Custom Reverse Proxy Gateway Headers Dialog
        // ====================================================================
        const btnCustomHeaders = root.querySelector('#btn-custom-headers');
        if (btnCustomHeaders) {
            this._addListener(btnCustomHeaders, 'click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const serverUrl = auth.getSavedServerUrl() || api.serverUrl;
                customHeadersDialog.show({ serverUrl });
            });
        }

        // ====================================================================
        // Switch Users (Who's Watching screen navigation)
        // ====================================================================
        const switchProfilesBtn = root.querySelector('.switch-profiles-btn');
        if (switchProfilesBtn) {
            this._addListener(switchProfilesBtn, 'click', () => {
                router.navigate('/profiles');
            });
        }

        // ====================================================================
        // User Session Sign Out Action
        // ====================================================================
        const switchUserBtn = root.querySelector('.switch-user-btn');
        if (switchUserBtn) {
            this._addListener(switchUserBtn, 'click', async () => {
                await auth.logout();
            });
        }
    }

    /**
     * Unbinds all registered DOM event listeners.
     * @private
     */
    _unbindListeners() {
        for (let i = 0; i < this._listeners.length; i++) {
            const { element, event, handler } = this._listeners[i];
            if (element && typeof element.removeEventListener === 'function') {
                element.removeEventListener(event, handler);
            }
        }
        this._listeners = [];
    }

    /**
     * Teardown lifecycle hook called when unmounting or switching tabs.
     */
    destroy() {
        this._unbindListeners();
        this.page = null;
    }
}

export default AccountTab;
