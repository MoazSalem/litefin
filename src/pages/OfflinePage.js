/**
 * ============================================================================
 * Litefin Tizen - Offline Page
 * ============================================================================
 * A "middle page" shown when a saved server is unreachable during startup.
 * Provides a clean UI to retry connection or change servers.
 * ============================================================================
 */

import Page from './Page.js';
import { auth } from '../api/index.js';
import { router } from '../core/Router.js';
import { i18n } from '../utils/i18n.js';
import { state } from '../core/StateManager.js';
import { eventBus } from '../core/EventBus.js';
import { focusManager } from '../ui/FocusManager.js';
import { logger } from '../utils/Logger.js';
import { pinManager } from '../utils/PinManager.js';
import { storage } from '../utils/StorageService.js';

const log = logger.create('OfflinePage');

class OfflinePage extends Page {
    constructor() {
        super();
        this.title = i18n.t('ServerOffline');
    }

    render() {
        const serverUrl = auth.getSavedServerUrl() || i18n.t('YourServer');

        return `
            <div class="page offline-page">
                <div class="offline-container">
                    <div class="offline-icon">
                        <svg width="120" height="120" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M1 1l22 22"></path>
                            <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"></path>
                            <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"></path>
                            <path d="M10.71 5.05A16 16 0 0 1 22.58 9"></path>
                            <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"></path>
                            <path d="M8.53 16.11a6 6 0 0 1 6.95 0"></path>
                            <path d="M12 20h.01"></path>
                        </svg>
                    </div>
                    
                    <h1 class="offline-title" data-i18n="ServerUnreachable">${i18n.t('ServerUnreachable')}</h1>
                    <p class="offline-message">
                        ${i18n.t('ConnectionErrorMessage', [serverUrl])}
                    </p>
                    
                    <div class="offline-actions" id="offline-actions">
                        <button class="btn btn-primary retry-btn focusable" tabindex="0" data-i18n="ButtonTryAgain">${i18n.t('ButtonTryAgain')}</button>
                        <button class="btn btn-secondary change-server-btn focusable" tabindex="0" data-i18n="ButtonChangeServer">${i18n.t('ButtonChangeServer')}</button>
                    </div>
                </div>
                
                <div class="offline-footer">
                    <button class="exit-btn focusable" tabindex="0" data-i18n="ButtonExitApp">${i18n.t('ButtonExitApp')}</button>
                </div>
            </div>
        `;
    }

    onMounted() {
        this._setupFocus();
        this._bindEvents();

        // Translate static UI labels
        i18n.translateDOM(this.el);

        // Start auto-retry polling interval
        this._startAutoRetry();

        // Listen for hardware / browser network interface coming back online
        // Allows instant recovery without waiting for the 5-second polling tick
        this._onNetworkOnline = () => {
            log.info('Network online event detected on OfflinePage — triggering immediate auto-recovery');
            this._retry();
        };
        window.addEventListener('online', this._onNetworkOnline);

        // Hide boot splash screen if it was waiting for this view
        eventBus.emit('app:hideSplash');
        log.info('Offline page mounted');
    }

    _startAutoRetry() {
        // Clear any existing interval
        this._stopAutoRetry();

        log.info('Starting auto-retry ping interval');
        this._autoRetryInterval = setInterval(async () => {
            log.debug('Pinging server for auto-recovery...');
            const isOnline = await auth.checkServerStatus();

            if (isOnline) {
                log.info('Server detected as online! Triggering auto-recovery...');
                this._stopAutoRetry();
                this._retry();
            }
        }, 5000); // Check every 5 seconds
    }

    _stopAutoRetry() {
        if (this._autoRetryInterval) {
            clearInterval(this._autoRetryInterval);
            this._autoRetryInterval = null;
        }
    }

    destroy() {
        // Remove network online listener
        if (this._onNetworkOnline) {
            window.removeEventListener('online', this._onNetworkOnline);
            this._onNetworkOnline = null;
        }

        this._stopAutoRetry();
        super.destroy();
    }

    _setupFocus() {
        this.registerFocusSection('offline-main', this.$('#offline-actions'), {
            orientation: 'horizontal'
        });

        this.registerFocusSection('offline-footer', this.$('.offline-footer'), {
            orientation: 'horizontal',
            leaveUp: 'offline-main'
        });

        // Link main actions to footer
        const mainConfig = focusManager.getSectionConfig('offline-main');
        if (mainConfig) {
            mainConfig.leaveDown = 'offline-footer';
            focusManager.register('offline-main', mainConfig.container, mainConfig);
        }

        this.setActiveSection('offline-main');
    }

    _bindEvents() {
        // Retry button
        const retryBtn = this.$('.retry-btn');
        if (retryBtn) {
            retryBtn.addEventListener('click', () => {
                this._retry();
            });
        }

        // Change Server button
        const changeServerBtn = this.$('.change-server-btn');
        if (changeServerBtn) {
            changeServerBtn.addEventListener('click', () => {
                log.info('Navigating to login to change server');
                state.set('server:offline', false); // Clear offline flag for a fresh start
                state.set('offline:returnPath', null); // Wipe pending return route
                // Explicitly clear the saved server URL and all associated users
                auth.logoutAll();
            });
        }

        // Exit button
        const exitBtn = this.$('.exit-btn');
        if (exitBtn) {
            exitBtn.addEventListener('click', () => {
                eventBus.emit('app:exitRequested');
            });
        }
    }

    async _retry() {
        if (this._isRetrying) return;
        this._isRetrying = true;

        this.setLoading(true);
        log.info('Retrying connection to server...');

        try {
            // 1. Verify that server endpoint is physically reachable and responding
            const isOnline = await auth.checkServerStatus();

            if (!isOnline) {
                log.warn('Retry failed: server is still unreachable');
                this.setLoading(false);
                this._isRetrying = false;
                return;
            }

            log.info('Server is reachable! Re-authenticating session and restoring route...');

            // Clear global server offline flags now that server response is confirmed
            state.set('server:connected', true);
            state.set('server:offline', false);

            // 2. Restore active authentication session if saved server credentials exist
            const hasSavedServer = Boolean(auth.getSavedServerUrl());
            const hasSessions = auth.getSessions().length > 0;

            if (hasSavedServer && hasSessions) {
                const restored = await auth.init();
                log.info('Session restore on retry result:', restored);

                // If background token verification is running, wait for it to settle
                if (auth.isValidationPending && auth.isValidationPending()) {
                    await auth.waitForValidation();
                }
            }

            // 3. Resolve target destination return path
            let targetPath = this.params?.returnUrl || state.get('offline:returnPath');

            if (targetPath) {
                try {
                    targetPath = decodeURIComponent(targetPath);
                } catch (_) {}
            }

            // Sanitize target path: prevent redirect loops into /offline or invalid routes
            if (
                !targetPath ||
                targetPath === '/offline' ||
                targetPath.startsWith('/offline?') ||
                targetPath.startsWith('/offline/')
            ) {
                const sessionCount = state.get('user:sessionCount', 0);
                const activeUser = auth.getCurrentUser();
                const activeHasPin = activeUser ? pinManager.hasPin(activeUser.Id) : false;
                const rememberLastUser = storage.getItem('pref:rememberLastActiveUser') === 'true';

                if (state.get('user:authenticated')) {
                    if ((sessionCount > 1 && !rememberLastUser) || activeHasPin) {
                        targetPath = '/profiles';
                    } else {
                        targetPath = '/home';
                    }
                } else {
                    targetPath = '/login';
                }
            }

            log.info(`Server back online! Navigating back to previous route: "${targetPath}"`);

            // Clear the stored offline return path
            state.set('offline:returnPath', null);

            // Navigate back to the target route, cleanly replacing /offline in router history
            router.navigate(targetPath, { replace: true });
        } catch (e) {
            log.error('Retry error', e);
            this.setLoading(false);
            this._isRetrying = false;
        }
    }

    onBack() {
        // Pressing back on offline page should exit the app
        eventBus.emit('app:exitRequested');
        return true;
    }
}

export default OfflinePage;
