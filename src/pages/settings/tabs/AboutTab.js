/**
 * ============================================================================
 * Litefin Tizen - About Tab Controller
 * ============================================================================
 * Handles rendering, lifecycle orchestration, and event wiring for the
 * Settings About tab. Dialogs and hardware specifications are delegated to
 * AboutModals to maintain strict file length limits.
 * ============================================================================
 */

import { storage } from '../../../utils/StorageService.js';
import { versionChecker } from '../../../utils/VersionChecker.js';
import { i18n } from '../../../utils/i18n.js';
import { logger } from '../../../utils/Logger.js';
import { ABOUT_ICONS, CHEVRON_RIGHT_SVG } from '../../../utils/Icons.js';
import { AboutModals, openExternalUrl, getDeviceSpecsData } from '../modals/AboutModals.js';

const log = logger.create('AboutTab');

/**
 * Controller for the Settings About tab view.
 */
export class AboutTab {
    /**
     * Creates an instance of AboutTab.
     * @param {Object} pageContext The parent SettingsPage instance
     */
    constructor(pageContext) {
        // Reference parent page for DOM lookup and modal overlay resolution
        this.page = pageContext;

        // Track bound event listeners for clean unmount teardown
        this._listeners = [];

        // Dedicated modal dialog sub-controller
        this.modals = new AboutModals(() => this._getOverlay());
    }

    /**
     * Helper to resolve the global modal overlay container safely.
     * @private
     * @returns {HTMLElement|null}
     */
    _getOverlay() {
        if (this.page && typeof this.page.$ === 'function') {
            const el = this.page.$('#modal-overlay');
            if (el) return el;
        }
        return document.getElementById('modal-overlay');
    }

    /**
     * Generates HTML markup for the primary About tab content.
     * @returns {string} Serialized HTML template
     */
    render() {
        // Resolve application version with universal fallback
        const appVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '1.0.0';

        return `
            <div class="settings-tab-content">
                <h2 class="content-title" data-i18n="AboutLitefin">${i18n.t('AboutLitefin')}</h2>
                <p class="content-subtitle" data-i18n="AboutTabDescription">
                    ${i18n.t('AboutTabDescription') || 'View application version, platform specifications, and hardware identity.'}
                </p>
                
                <!-- Main application version banner -->
                <div class="about-card" tabindex="0">
                    <h3 class="app-version">${i18n.t('AppVersion', [appVersion])}</h3>
                    <p class="about-desc" data-i18n="AppDescription">
                        ${i18n.t('AppDescription')}
                    </p>
                    <p class="about-credits" data-i18n="DevelopedBy">${i18n.t('DevelopedBy')}</p>
                </div>

                <!-- Community and Resources Section -->
                <h3 class="setting-section-title" data-i18n="AboutResourcesTitle">${i18n.t('AboutResourcesTitle') || 'Community & Resources'}</h3>
                <p class="content-subtitle" data-i18n="AboutResourcesDesc" style="margin-top: -10px; margin-bottom: 16px;">
                    ${i18n.t('AboutResourcesDesc') || 'Explore project source code, install server plugins, access quick issue reporting, join Discord, or support development.'}
                </p>

                <!-- Compact Action Cards Grid -->
                <div class="about-actions-grid" id="about-actions-grid">
                    <!-- Device Information Card (Row 1 Left) -->
                    <button class="about-action-card focusable" 
                            id="btn-about-device-info" 
                            tabindex="0" 
                            data-focusable="true"
                            data-nav-right="#btn-about-github"
                            data-nav-down="#btn-about-issues">
                        <div class="about-card-icon-wrap" aria-hidden="true">
                            ${ABOUT_ICONS.deviceInfo}
                        </div>
                        <div class="about-card-info">
                            <span class="about-card-title" data-i18n="ViewDeviceInfo">${i18n.t('ViewDeviceInfo') || 'Device Specifications'}</span>
                            <span class="about-card-desc" data-i18n="ViewDeviceInfoDesc">${i18n.t('ViewDeviceInfoDesc') || 'Hardware model, platform details, resolution, and supported audio/video codecs.'}</span>
                        </div>
                        <div class="about-card-chevron" aria-hidden="true">
                            ${CHEVRON_RIGHT_SVG}
                        </div>
                    </button>

                    <!-- GitHub Repository Card (Row 1 Right) -->
                    <button class="about-action-card focusable" 
                            id="btn-about-github" 
                            tabindex="0" 
                            data-focusable="true"
                            data-nav-left="#btn-about-device-info"
                            data-nav-down="#btn-about-plugins">
                        <div class="about-card-icon-wrap" aria-hidden="true">
                            ${ABOUT_ICONS.github}
                        </div>
                        <div class="about-card-info">
                            <span class="about-card-title" data-i18n="GitHubRepo">${i18n.t('GitHubRepo') || 'GitHub Repository'}</span>
                            <span class="about-card-desc" data-i18n="GitHubRepoDesc">${i18n.t('GitHubRepoDesc') || 'Explore the source code, check releases, and follow development.'}</span>
                        </div>
                        <div class="about-card-chevron" aria-hidden="true">
                            ${CHEVRON_RIGHT_SVG}
                        </div>
                    </button>

                    <!-- Quick Issue Reporter Card (Row 2 Left) -->
                    <button class="about-action-card focusable" 
                            id="btn-about-issues" 
                            tabindex="0" 
                            data-focusable="true"
                            data-nav-up="#btn-about-device-info"
                            data-nav-right="#btn-about-plugins"
                            data-nav-down="#btn-about-discord">
                        <div class="about-card-icon-wrap" aria-hidden="true">
                            ${ABOUT_ICONS.issues}
                        </div>
                        <div class="about-card-info">
                            <span class="about-card-title" data-i18n="ReportIssue">${i18n.t('ReportIssue') || 'Quick Issue Reporter'}</span>
                            <span class="about-card-desc" data-i18n="ReportIssueDesc">${i18n.t('ReportIssueDesc') || 'Quickly submit bug reports and feature requests via GitHub.'}</span>
                        </div>
                        <div class="about-card-chevron" aria-hidden="true">
                            ${CHEVRON_RIGHT_SVG}
                        </div>
                    </button>

                    <!-- Companion Plugins Card (Row 2 Right) -->
                    <button class="about-action-card focusable" 
                            id="btn-about-plugins" 
                            tabindex="0" 
                            data-focusable="true"
                            data-nav-up="#btn-about-github"
                            data-nav-left="#btn-about-issues"
                            data-nav-down="#btn-about-support">
                        <div class="about-card-icon-wrap" aria-hidden="true">
                            ${ABOUT_ICONS.plugins}
                        </div>
                        <div class="about-card-info">
                            <span class="about-card-title" data-i18n="CompanionPlugins">${i18n.t('CompanionPlugins') || 'Companion Plugins'}</span>
                            <span class="about-card-desc" data-i18n="CompanionPluginsDesc">${i18n.t('CompanionPluginsDesc') || 'Download the Litefin companion plugins for Jellyfin and Emby servers.'}</span>
                        </div>
                        <div class="about-card-chevron" aria-hidden="true">
                            ${CHEVRON_RIGHT_SVG}
                        </div>
                    </button>

                    <!-- Discord Community Card (Row 3 Left) -->
                    <button class="about-action-card focusable" 
                            id="btn-about-discord" 
                            tabindex="0" 
                            data-focusable="true"
                            data-nav-up="#btn-about-issues"
                            data-nav-right="#btn-about-support">
                        <div class="about-card-icon-wrap" aria-hidden="true">
                            ${ABOUT_ICONS.discord}
                        </div>
                        <div class="about-card-info">
                            <span class="about-card-title" data-i18n="DiscordCommunity">${i18n.t('DiscordCommunity') || 'Discord Community'}</span>
                            <span class="about-card-desc" data-i18n="DiscordCommunityDesc">${i18n.t('DiscordCommunityDesc') || 'Join our live Discord chat for questions, discussions, and updates.'}</span>
                        </div>
                        <div class="about-card-chevron" aria-hidden="true">
                            ${CHEVRON_RIGHT_SVG}
                        </div>
                    </button>

                    <!-- Support & Donations Card (Row 3 Right) -->
                    <button class="about-action-card focusable" 
                            id="btn-about-support" 
                            tabindex="0" 
                            data-focusable="true"
                            data-nav-up="#btn-about-plugins"
                            data-nav-left="#btn-about-discord">
                        <div class="about-card-icon-wrap" aria-hidden="true">
                            ${ABOUT_ICONS.support}
                        </div>
                        <div class="about-card-info">
                            <span class="about-card-title" data-i18n="SupportDonations">${i18n.t('SupportDonations') || 'Support & Donations'}</span>
                            <span class="about-card-desc" data-i18n="SupportDonationsDesc">${i18n.t('SupportDonationsDesc') || 'Help support continuous development of Litefin via Buy Me a Coffee or Sponsors.'}</span>
                        </div>
                        <div class="about-card-chevron" aria-hidden="true">
                            ${CHEVRON_RIGHT_SVG}
                        </div>
                    </button>
                </div>

                <!-- Updates Section -->
                <h3 class="setting-section-title" data-i18n="Updates">${i18n.t('Updates')}</h3>
                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="AutoUpdateCheck">${i18n.t('AutoUpdateCheck')}</span>
                        <span class="setting-description" data-i18n="AutoUpdateCheckDesc">${i18n.t('AutoUpdateCheckDesc')}</span>
                    </div>
                    <div class="setting-control">
                        <button class="toggle-switch focusable ${storage.getItem('pref:checkForUpdates') !== 'false' ? 'active' : ''}" 
                                id="toggle-check-updates" 
                                tabindex="0"
                                data-focusable="true">
                        </button>
                    </div>
                </div>
                
                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="CheckForUpdates">${i18n.t('CheckForUpdates')}</span>
                        <span class="setting-description" data-i18n="CheckForUpdatesDesc">${i18n.t('CheckForUpdatesDesc') || 'Trigger a manual check for new releases on GitHub.'}</span>
                    </div>
                    <div class="setting-control">
                        <button class="btn btn-secondary btn-small focusable" id="btn-check-updates" tabindex="0" data-focusable="true" style="width: auto; min-width: 120px;">
                            ${i18n.t('CheckForUpdatesNow')}
                        </button>
                    </div>
                </div>
            </div>
        `;
    }

    /**
     * Binds DOM event listeners when the About tab is mounted.
     * @param {HTMLElement} container The tab container or page root
     */
    mount(container) {
        this._unbindListeners();

        const find = (selector) => {
            return (container && container.querySelector(selector)) || document.querySelector(selector);
        };

        const addManagedListener = (element, event, handler) => {
            if (!element) return;
            element.addEventListener(event, handler);
            this._listeners.push({ element, event, handler });
        };

        // Action card click triggers
        addManagedListener(find('#btn-about-device-info'), 'click', () => {
            this.modals.showDeviceInformationDialog();
        });

        addManagedListener(find('#btn-about-github'), 'click', () => {
            this.modals.showGitHubDialog('repo');
        });

        addManagedListener(find('#btn-about-issues'), 'click', () => {
            this.modals.showGitHubDialog('issues');
        });

        addManagedListener(find('#btn-about-plugins'), 'click', () => {
            this.modals.showPluginsDialog();
        });

        addManagedListener(find('#btn-about-discord'), 'click', () => {
            this.modals.showDiscordDialog();
        });

        addManagedListener(find('#btn-about-support'), 'click', () => {
            this.modals.showSupportDialog();
        });

        // Toggle Switch for Auto Update Check
        const autoUpdateToggle = find('#toggle-check-updates');
        addManagedListener(autoUpdateToggle, 'click', () => {
            const currentValue = storage.getItem('pref:checkForUpdates') !== 'false';
            const newValue = !currentValue;
            storage.setItem('pref:checkForUpdates', newValue.toString());
            if (autoUpdateToggle) {
                autoUpdateToggle.classList.toggle('active', newValue);
            }
            log.info(`Auto Update Check set to: ${newValue}`);
        });

        // Manual Check for Updates Button
        addManagedListener(find('#btn-check-updates'), 'click', () => {
            versionChecker.checkUpdate(true);
        });
    }

    /**
     * Delegation helpers for dialog triggers.
     */
    showDeviceInformationDialog() {
        return this.modals.showDeviceInformationDialog();
    }

    showGitHubDialog(initialFocus = 'repo') {
        return this.modals.showGitHubDialog(initialFocus);
    }

    showPluginsDialog() {
        return this.modals.showPluginsDialog();
    }

    showDiscordDialog() {
        return this.modals.showDiscordDialog();
    }

    showSupportDialog() {
        return this.modals.showSupportDialog();
    }

    closeDialog() {
        return this.modals.closeDialog();
    }

    getDeviceSpecsData() {
        return getDeviceSpecsData();
    }

    openExternalUrl(url) {
        return openExternalUrl(url);
    }

    /**
     * Handles back key navigation. Dismisses open modal if present.
     * @returns {boolean} True if back key was handled
     */
    handleBack() {
        const overlay = this._getOverlay();
        if (overlay && overlay.querySelector('.about-dialog-modal')) {
            this.closeDialog();
            return true;
        }
        return false;
    }

    /**
     * Cleanly removes all managed DOM listeners.
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
     * Teardown hook.
     */
    destroy() {
        this._unbindListeners();
        if (this.modals) {
            this.modals.destroy();
        }
        this.page = null;
    }
}

export default AboutTab;
