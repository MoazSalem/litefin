/**
 * ============================================================================
 * Litefin Tizen - Settings Page
 * ============================================================================
 * App settings and preferences including layout, theme, and account.
 * ============================================================================
 */

import Page from './Page.js';
import { auth } from '../api/index.js';
import { router } from '../core/Router.js';
import { state } from '../core/StateManager.js';
import { layoutManager, THEMES } from '../ui/LayoutManager.js';

class SettingsPage extends Page {
    constructor() {
        super();
        this.title = 'Settings';
    }

    render() {
        const currentLayout = layoutManager.getLayout();
        const currentTheme = layoutManager.getTheme();
        const availableThemes = layoutManager.getAvailableThemes();
        const user = auth.getCurrentUser();

        return `
            <div class="page settings-page">
                <!-- Header -->
                <header class="page-header">
                    <button class="back-btn" tabindex="0">←</button>
                    <h1 class="page-title">Settings</h1>
                </header>
                
                <!-- Settings content -->
                <main class="page-content">
                    <div class="settings-container">
                        <!-- Appearance section -->
                        <section class="settings-section">
                            <h2 class="section-title">Appearance</h2>
                            
                            <div class="setting-item">
                                <div class="setting-label">
                                    <span class="setting-name">Layout</span>
                                    <span class="setting-description">Choose between classic and modern UI</span>
                                </div>
                                <div class="setting-control">
                                    <button class="btn btn-option layout-btn ${currentLayout === 'classic' ? 'active' : ''}" data-layout="classic" tabindex="0">
                                        Classic
                                    </button>
                                    <button class="btn btn-option layout-btn ${currentLayout === 'modern' ? 'active' : ''}" data-layout="modern" tabindex="0">
                                        Modern
                                    </button>
                                </div>
                            </div>
                            
                            <div class="setting-item">
                                <div class="setting-label">
                                    <span class="setting-name">Theme</span>
                                    <span class="setting-description">Select color theme</span>
                                </div>
                                <div class="setting-control theme-options" id="theme-options">
                                    ${availableThemes.map(theme => `
                                        <button class="btn btn-option theme-btn ${currentTheme === theme ? 'active' : ''}" data-theme="${theme}" tabindex="0">
                                            ${this._getThemeDisplayName(theme)}
                                        </button>
                                    `).join('')}
                                </div>
                            </div>
                        </section>
                        
                        <!-- Playback section -->
                        <section class="settings-section">
                            <h2 class="section-title">Playback</h2>
                            
                            <div class="setting-item">
                                <div class="setting-label">
                                    <span class="setting-name">Quality</span>
                                    <span class="setting-description">Maximum streaming quality</span>
                                </div>
                                <div class="setting-control">
                                    <select class="setting-select" id="quality-select" tabindex="0">
                                        <option value="auto">Auto</option>
                                        <option value="4k">4K (if available)</option>
                                        <option value="1080p">1080p</option>
                                        <option value="720p">720p</option>
                                    </select>
                                </div>
                            </div>
                            
                            <div class="setting-item">
                                <div class="setting-label">
                                    <span class="setting-name">Subtitles</span>
                                    <span class="setting-description">Default subtitle language</span>
                                </div>
                                <div class="setting-control">
                                    <select class="setting-select" id="subtitle-select" tabindex="0">
                                        <option value="none">None</option>
                                        <option value="eng">English</option>
                                        <option value="ara">Arabic</option>
                                        <option value="spa">Spanish</option>
                                    </select>
                                </div>
                            </div>
                        </section>
                        
                        <!-- Account section -->
                        <section class="settings-section">
                            <h2 class="section-title">Account</h2>
                            
                            <div class="setting-item account-info">
                                <div class="setting-label">
                                    <span class="setting-name">Logged in as</span>
                                    <span class="setting-value">${user?.Name || 'Unknown'}</span>
                                </div>
                            </div>
                            
                            <div class="setting-item">
                                <div class="setting-label">
                                    <span class="setting-name">Server</span>
                                    <span class="setting-value">${auth.getSavedServerUrl() || 'Not connected'}</span>
                                </div>
                            </div>
                            
                            <div class="setting-actions">
                                <button class="btn btn-secondary switch-user-btn" tabindex="0">
                                    Log Out
                                </button>
                            </div>
                        </section>
                        
                        <!-- About section -->
                        <section class="settings-section">
                            <h2 class="section-title">About</h2>
                            
                            <div class="setting-item">
                                <div class="setting-label">
                                    <span class="setting-name">Litefin for Tizen</span>
                                    <span class="setting-value">Version 0.1.0</span>
                                </div>
                            </div>
                        </section>
                    </div>
                </main>
            </div>
        `;
    }

    onMounted() {
        // Bind events
        this._bindEvents();

        // Setup focus
        this._setupFocus();
    }

    _bindEvents() {
        // Back button
        this.$('.back-btn')?.addEventListener('click', () => {
            router.back();
        });

        // Layout buttons
        this.$$('.layout-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const layout = btn.dataset.layout;
                this._setLayout(layout);
            });
        });

        // Theme buttons
        this.$$('.theme-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const theme = btn.dataset.theme;
                this._setTheme(theme);
            });
        });

        // Log Out
        this.$('.switch-user-btn')?.addEventListener('click', async () => {
            // Perform logout to clear user session
            await auth.logout();
            // Navigate and clear history so user can't go back
            router.reset('/login');
        });
    }

    _setupFocus() {
        this.registerFocusSection('settings-header', this.$('.page-header'), {
            orientation: 'horizontal',
            leaveDown: 'settings-content'
        });

        this.registerFocusSection('settings-content', this.$('.settings-container'), {
            orientation: 'vertical',
            leaveUp: 'settings-header'
        });

        this.setActiveSection('settings-content');
    }

    _setLayout(layout) {
        layoutManager.setLayout(layout);

        // Update button states
        this.$$('.layout-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.layout === layout);
        });

        // Update theme options (different themes available per layout)
        this._updateThemeOptions();
    }

    _setTheme(theme) {
        layoutManager.setTheme(theme);

        // Update button states
        this.$$('.theme-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.theme === theme);
        });
    }

    _updateThemeOptions() {
        const availableThemes = layoutManager.getAvailableThemes();
        const currentTheme = layoutManager.getTheme();

        const container = this.$('#theme-options');
        container.innerHTML = availableThemes.map(theme => `
            <button class="btn btn-option theme-btn ${currentTheme === theme ? 'active' : ''}" data-theme="${theme}" tabindex="0">
                ${this._getThemeDisplayName(theme)}
            </button>
        `).join('');

        // Rebind events
        container.querySelectorAll('.theme-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this._setTheme(btn.dataset.theme);
            });
        });
    }

    _getThemeDisplayName(theme) {
        const names = {
            dark: 'Dark',
            light: 'Light',
            blueradiance: 'Blue Radiance',
            purplehaze: 'Purple Haze',
            wmc: 'WMC',
            appletv: 'Apple TV'
        };
        return names[theme] || theme;
    }

    onBack() {
        router.back();
    }
}

export default SettingsPage;
