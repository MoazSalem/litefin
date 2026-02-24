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
                        ${i18n.t('ConnectionErrorMessage', serverUrl)}
                    </p>
                    
                    <div class="offline-actions" id="offline-actions">
                        <button class="btn btn-primary retry-btn focusable" tabindex="0" data-i18n="TryAgain">${i18n.t('TryAgain')}</button>
                        <button class="btn btn-secondary change-server-btn focusable" tabindex="0" data-i18n="ChangeServer">${i18n.t('ChangeServer')}</button>
                    </div>
                </div>
                
                <div class="offline-footer">
                    <button class="exit-btn focusable" tabindex="0" data-i18n="ExitApp">${i18n.t('ExitApp')}</button>
                </div>
            </div>
        `;
    }

    onMounted() {
        this._setupFocus();
        this._bindEvents();

        // Translate static UI labels
        i18n.translateDOM(this.el);

        // Start auto-retry interval
        this._startAutoRetry();

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
                router.navigate('/login', { replace: true });
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
        log.info('Retrying connection...');

        try {
            const restored = await auth.init();
            if (restored) {
                log.info('Retry successful, navigating to home');
                router.navigate('/home', { replace: true });
            } else {
                log.warn('Retry failed, server still unreachable');
                this.setLoading(false);
                this._isRetrying = false;
            }
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
