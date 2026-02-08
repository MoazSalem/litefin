/**
 * ============================================================================
 * Litefin Tizen - Settings Page
 * ============================================================================
 * App settings and preferences including layout, theme, and account.
 * Redesigned for TV with a split-view layout.
 * ============================================================================
 */

import Page from './Page.js';
import { auth } from '../api/index.js';
import { router } from '../core/Router.js';
import { layoutManager } from '../ui/LayoutManager.js';
import { api } from '../api/index.js';
import { focusManager } from '../ui/FocusManager.js';
import { imageService } from '../utils/ImageService.js';
import { PlayerSettings } from '../utils/PlayerSettings.js';
import { debugOverlay } from '../ui/DebugOverlay.js';

class SettingsPage extends Page {
    constructor() {
        super();
        this.title = 'Settings';
        this.activeTab = 'appearance'; // Default tab
    }

    render() {
        const tabs = [
            {
                id: 'appearance',
                label: 'Appearance',
                icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="13.5" cy="6.5" r="2.5"/><path d="M20.38 10.32a.86.86 0 0 0-.25-.43l-1.62-1.66c-.46-.46-1.12-.58-1.57-.28l-.34.23c-.56.37-1.32.17-1.56-.46l-.16-.62c-.17-.67-.78-1.1-1.47-1.1H13c-.69 0-1.3.43-1.47 1.1l-.16.62c-.24.63-.99.83-1.56.46l-.33-.23c-.46-.3-1.12-.18-1.57.28L6.29 9.89a.86.86 0 0 0-.25.43 3.99 3.99 0 0 0 4.6 5.56l.32-.09c.64-.18 1.22.25 1.34.9l.06.33c.12.63.74 1.08 1.4.98l.61-.1c.64-.1.97-.78.7-1.37l-.2-.43c-.27-.6.03-1.32.64-1.52l.27-.09a4.01 4.01 0 0 0 3.6-4.17Z"/><path d="M2 22h20"/></svg>'
            },
            {
                id: 'player',
                label: 'Player',
                icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>'
            },
            {
                id: 'subtitles',
                label: 'Subtitles',
                icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M7 15h4M15 15h2M7 11h2M13 11h4"/></svg>'
            },
            {
                id: 'account',
                label: 'Account',
                icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>'
            },
            {
                id: 'about',
                label: 'About',
                icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'
            },
            {
                id: 'debug',
                label: 'Debug',
                icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="8" height="14" x="8" y="6" rx="4"/><path d="m19 7-3 2"/><path d="m5 7 3 2"/><path d="m19 19-3-2"/><path d="m5 19 3-2"/><path d="M20 13h-4"/><path d="M4 13h4"/><path d="m10 4 1 2"/><path d="m14 4-1 2"/></svg>'
            }
        ];

        return `
            <div class="page settings-page">

                
                <!-- Split View Container -->
                <div class="settings-split-view">
                    <!-- Sidebar -->
                    <aside class="settings-sidebar" id="settings-sidebar">
                        <div class="settings-sidebar-header">
                            <h2>Settings</h2>
                        </div>
                        ${tabs.map(tab => `
                            <button class="settings-menu-btn ${this.activeTab === tab.id ? 'active' : ''}" 
                                    data-tab="${tab.id}" tabindex="0">
                                <span class="menu-icon">${tab.icon}</span>
                                <span class="menu-label">${tab.label}</span>
                            </button>
                        `).join('')}
                    </aside>

                    <!-- Content Panel -->
                    <main class="settings-content-panel" id="settings-content-panel">
                        ${this._renderActiveTabContent()}
                    </main>
                </div>
                
                <!-- Modal Overlay -->
                <div class="modal-overlay" id="modal-overlay" aria-hidden="true"></div>
            </div>
        `;
    }

    _renderActiveTabContent() {
        switch (this.activeTab) {
            case 'appearance':
                return this._renderAppearanceTab();
            case 'player':
                return this._renderPlayerTab();
            case 'subtitles':
                return this._renderSubtitlesTab();
            case 'account':
                return this._renderAccountTab();
            case 'about':
                return this._renderAboutTab();
            case 'debug':
                return this._renderDebugTab();
            default:
                return this._renderAppearanceTab();
        }
    }

    _renderAppearanceTab() {
        const currentLayout = layoutManager.getLayout();
        const currentTheme = layoutManager.getTheme();
        const availableThemes = layoutManager.getAvailableThemes();

        return `
            <div class="settings-tab-content">
                <h2 class="content-title">Appearance</h2>
                
                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name">Layout Mode</span>
                        <span class="setting-description">Choose optimized layout for your screen</span>
                    </div>
                    <div class="setting-control">
                        <button class="btn btn-option layout-btn ${currentLayout === 'classic' ? 'active' : ''}" data-layout="classic" tabindex="0">Classic</button>
                        <button class="btn btn-option layout-btn ${currentLayout === 'modern' ? 'active' : ''}" data-layout="modern" tabindex="-1" disabled>Modern (Soon)</button>
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name">Color Theme</span>
                        <span class="setting-description">Select your preferred color scheme</span>
                    </div>
                    <div class="setting-control theme-options" id="theme-options">
                        ${availableThemes.map(theme => `
                            <button class="btn btn-option theme-btn ${currentTheme === theme ? 'active' : ''}" data-theme="${theme}" tabindex="0">
                                ${this._getThemeDisplayName(theme)}
                            </button>
                        `).join('')}
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name">Image Quality</span>
                        <span class="setting-description">Adjust for device performance (requires restart)</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown('image-quality-select', [
            { value: 'low', label: 'Low (Fastest)' },
            { value: 'medium', label: 'Medium (Balanced)' },
            { value: 'high', label: 'High (High Quality)' },
            { value: 'ultra', label: 'Ultra (Maximum)' }
        ], imageService.getPreset() || 'medium')}
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name">Home Screen Customization</span>
                        <span class="setting-description">Hide "My Media" row from home screen</span>
                    </div>
                    <div class="setting-control">
                         <button class="toggle-switch ${localStorage.getItem('pref:hideMyMedia') === 'true' ? 'active' : ''}" 
                                 id="toggle-my-media" 
                                 tabindex="0"
                                 aria-label="Toggle My Media visibility">
                        </button>
                    </div>
                </div>
            </div>
        `;
    }

    /**
     * Render Player tab with video/audio quality and playback behavior
     */
    _renderPlayerTab() {
        return `
            <div class="settings-tab-content">
                <h2 class="content-title">Player</h2>
                
                <!-- Video Quality Section -->
                <h3 class="setting-section-title">Video Quality</h3>
                
                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name">Max Resolution</span>
                        <span class="setting-description">Manually override max resolution to bypass detection issues</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown('max-resolution-select', [
            { value: 'auto', label: 'Auto (Detect)' },
            { value: '720p', label: '720p HD' },
            { value: '1080p', label: '1080p FHD' },
            { value: '2160p', label: '4K UHD (Default)' },
            { value: '4320p', label: '8K UHD' }
        ], localStorage.getItem('litefin_max_resolution') || '2160p')}
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name">Max Streaming Bitrate</span>
                        <span class="setting-description">Quality when streaming over internet</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown('max-bitrate-select', [
            { value: 'auto', label: 'Auto (Recommended)' },
            { value: '120000000', label: '4K - 120 Mbps' },
            { value: '60000000', label: '4K - 60 Mbps' },
            { value: '20000000', label: '1080p - 20 Mbps' },
            { value: '10000000', label: '1080p - 10 Mbps' },
            { value: '4000000', label: '720p - 4 Mbps' }
        ], localStorage.getItem('pref:maxBitrate') || 'auto')}
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name">Preferred Audio Language</span>
                        <span class="setting-description">Default language for audio tracks</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown('audio-lang-select', [
            { value: 'auto', label: 'Auto' },
            { value: 'eng', label: 'English' },
            { value: 'ara', label: 'Arabic' },
            { value: 'spa', label: 'Spanish' },
            { value: 'fre', label: 'French' },
            { value: 'jpn', label: 'Japanese' },
            { value: 'kor', label: 'Korean' }
        ], localStorage.getItem('pref:audioLang') || 'auto')}
                    </div>
                </div>

                <!-- Playback Behavior Section -->
                <h3 class="setting-section-title">Playback Behavior</h3>
                
                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name">Skip Forward Duration</span>
                        <span class="setting-description">Seconds to skip when pressing forward</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown('skip-forward-select', [
            { value: '5000', label: '5 seconds' },
            { value: '10000', label: '10 seconds' },
            { value: '15000', label: '15 seconds' },
            { value: '30000', label: '30 seconds' }
        ], String(PlayerSettings.get('skipForwardLength')))}
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name">Skip Back Duration</span>
                        <span class="setting-description">Seconds to skip when pressing back</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown('skip-back-select', [
            { value: '5000', label: '5 seconds' },
            { value: '10000', label: '10 seconds' },
            { value: '15000', label: '15 seconds' },
            { value: '30000', label: '30 seconds' }
        ], String(PlayerSettings.get('skipBackLength')))}
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name">Auto-play Next Episode</span>
                        <span class="setting-description">Automatically play next episode when current ends</span>
                    </div>
                    <div class="setting-control">
                         <button class="toggle-switch ${PlayerSettings.get('enableNextEpisodeAutoPlay') ? 'active' : ''}" 
                                 id="toggle-auto-next" 
                                 data-setting="enableNextEpisodeAutoPlay"
                                 tabindex="0"
                                 aria-label="Toggle auto-play next">
                        </button>
                    </div>
                </div>
            </div>
        `;
    }

    /**
     * Render Subtitles tab with appearance and behavior settings
     */
    _renderSubtitlesTab() {
        return `
            <div class="settings-tab-content">
                <h2 class="content-title">Subtitles</h2>
                
                <!-- Subtitle Behavior Section -->
                <h3 class="setting-section-title">Behavior</h3>
                
                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name">Preferred Subtitle Language</span>
                        <span class="setting-description">Default language for subtitles</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown('subtitle-lang-select', [
            { value: 'none', label: 'None' },
            { value: 'eng', label: 'English' },
            { value: 'ara', label: 'Arabic' },
            { value: 'spa', label: 'Spanish' },
            { value: 'fre', label: 'French' },
            { value: 'jpn', label: 'Japanese' },
            { value: 'kor', label: 'Korean' }
        ], localStorage.getItem('pref:subtitleLang') || 'none')}
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name">Subtitle Mode</span>
                        <span class="setting-description">When to show subtitles automatically</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown('subtitle-mode-select', [
            { value: 'Default', label: 'Default (Server preference)' },
            { value: 'Smart', label: 'Smart (Foreign audio only)' },
            { value: 'OnlyForced', label: 'Only Forced' },
            { value: 'Always', label: 'Always' },
            { value: 'None', label: 'None' }
        ], PlayerSettings.get('subtitleMode'))}
                    </div>
                </div>

                <!-- Subtitle Appearance Section -->
                <h3 class="setting-section-title">Appearance</h3>
                
                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name">Text Size</span>
                        <span class="setting-description">Subtitle text size</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown('subtitle-size-select', [
            { value: 'small', label: 'Small' },
            { value: 'medium', label: 'Medium' },
            { value: 'large', label: 'Large' },
            { value: 'larger', label: 'Larger' },
            { value: 'extralarge', label: 'Extra Large' }
        ], PlayerSettings.get('subtitleSize'))}
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name">Text Style</span>
                        <span class="setting-description">Shadow and outline style</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown('subtitle-shadow-select', [
            { value: 'none', label: 'None' },
            { value: 'dropshadow', label: 'Drop Shadow' },
            { value: 'raised', label: 'Raised' },
            { value: 'depressed', label: 'Depressed' },
            { value: 'uniform', label: 'Uniform Outline' }
        ], PlayerSettings.get('subtitleDropShadow'))}
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name">Background</span>
                        <span class="setting-description">Subtitle background style</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown('subtitle-bg-select', [
            { value: 'transparent', label: 'Transparent' },
            { value: 'rgba(0,0,0,0.5)', label: 'Semi-transparent' },
            { value: 'rgba(0,0,0,0.8)', label: 'Dark' },
            { value: '#000000', label: 'Solid Black' }
        ], PlayerSettings.get('subtitleTextBackground'))}
                    </div>
                </div>
            </div>
        `;
    }

    _renderAccountTab() {
        const user = auth.getCurrentUser();
        const serverUrl = auth.getSavedServerUrl();

        return `
            <div class="settings-tab-content">
                <h2 class="content-title">Account</h2>
                
                <div class="user-profile-card">
                    <div class="user-avatar-wrapper">
                         ${this._renderUserAvatar(user)}
                    </div>
                    <h3 class="user-name-large">${user?.Name || 'Guest'}</h3>
                    <p class="server-url-display">${serverUrl || 'Offline'}</p>
                </div>

                <div class="setting-actions centered">
                    <button class="btn btn-danger switch-user-btn focusable" tabindex="0">
                        Sign Out
                    </button>
                </div>
            </div>
        `;
    }

    _renderAboutTab() {
        return `
            <div class="settings-tab-content">
                <h2 class="content-title">About Litefin</h2>
                
                <div class="about-card" tabindex="0">
                    <h3 class="app-version">Version ${__APP_VERSION__}</h3>
                    <p class="about-desc">
                        A lightweight, community-driven Jellyfin client optimized for Tizen TVs.
                        Built with love for speed and simplicity.
                    </p>
                    <p class="about-credits">Developed by the MoazSalem</p>
                </div>
            </div>
        `;
    }

    _renderDebugTab() {
        const logsEnabled = debugOverlay.isLogsEnabled;
        const overlayEnabled = debugOverlay.isOverlayEnabled;

        return `
            <div class="settings-tab-content">
                <h2 class="content-title">Debug</h2>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name">Enable Debug Logs</span>
                        <span class="setting-description">Allow application to output logs to console</span>
                    </div>
                    <div class="setting-control">
                        <button class="toggle-switch ${logsEnabled ? 'active' : ''}" 
                                id="toggle-debug-logs" 
                                tabindex="0">
                        </button>
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name">Show Debug Overlay</span>
                        <span class="setting-description">Display logs on screen (requires Debug Logs)</span>
                    </div>
                    <div class="setting-control">
                        <button class="toggle-switch ${overlayEnabled ? 'active' : ''}" 
                                id="toggle-debug-overlay" 
                                tabindex="0"
                                ${!logsEnabled ? 'disabled style="opacity: 0.5"' : ''}>
                        </button>
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name">Overlay Width</span>
                        <span class="setting-description">Horizontal size of the debug window</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown('debug-width-select', [
            { value: 'small', label: 'Small' },
            { value: 'medium', label: 'Medium' },
            { value: 'large', label: 'Large' },
            { value: 'full', label: 'Full Screen' }
        ], debugOverlay.Width || 'small')}
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name">Overlay Height</span>
                        <span class="setting-description">Vertical size of the debug window</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown('debug-height-select', [
            { value: 'small', label: 'Small' },
            { value: 'medium', label: 'Medium' },
            { value: 'large', label: 'Large' },
            { value: 'full', label: 'Full Screen' }
        ], debugOverlay.Height || 'small')}
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name">Overlay Position</span>
                        <span class="setting-description">Screen location of the debug window</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown('debug-position-select', [
            { value: 'top-left', label: 'Top Left' },
            { value: 'top-right', label: 'Top Right' },
            { value: 'bottom-left', label: 'Bottom Left' },
            { value: 'bottom-right', label: 'Bottom Right' }
        ], debugOverlay.Position || 'bottom-right')}
                    </div>
                </div>
            </div>
        `;
    }

    onMounted() {
        this._bindEvents();
        this._setupFocus();

        // Restore focus to active tab based on last state if needed, or default
        this._setupFocus();

        // Default focus to sidebar
        this.setActiveSection('settings-sidebar');
    }

    _bindEvents() {
        // Back button


        // Sidebar Navigation
        this.$$('.settings-menu-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const tab = btn.dataset.tab;
                this._switchTab(tab);
            });

            // Also switch on focus for hover-like preview? 
            // Better to switch on click/enter for stability, or debounce focus.
            // Let's stick to click/enter (standard behavior)
        });

        this._bindContentEvents();
    }

    _bindContentEvents() {
        // Layout buttons
        this.$$('.layout-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this._setLayout(btn.dataset.layout);
            });
        });

        // Theme buttons
        this.$$('.theme-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this._setTheme(btn.dataset.theme);
            });
        });



        // Toggle My Media
        const myMediaBtn = this.$('#toggle-my-media');
        if (myMediaBtn) {
            myMediaBtn.addEventListener('click', () => {
                const isHidden = localStorage.getItem('pref:hideMyMedia') === 'true';
                const newValue = !isHidden;
                localStorage.setItem('pref:hideMyMedia', newValue);
                myMediaBtn.classList.toggle('active', newValue);
            });
        }

        // Toggle Auto-play Next Episode
        const autoNextBtn = this.$('#toggle-auto-next');
        if (autoNextBtn) {
            autoNextBtn.addEventListener('click', () => {
                const currentValue = PlayerSettings.get('enableNextEpisodeAutoPlay');
                const newValue = !currentValue;
                PlayerSettings.set('enableNextEpisodeAutoPlay', newValue);
                autoNextBtn.classList.toggle('active', newValue);
            });
        }

        // Log Out
        this.$('.switch-user-btn')?.addEventListener('click', async () => {
            await auth.logout();
            router.reset('/login');
        });

        // Initialize Custom Dropdowns
        this._bindDropdownEvents();
    }

    _renderDropdown(id, options, currentValue) {
        // Find current label
        const currentOption = options.find(o => o.value === currentValue) || options[0];
        const currentLabel = currentOption ? currentOption.label : 'Select';

        // Render as a button that triggers the modal
        return `
            <button class="setting-action-btn select-btn" id="${id}-btn" 
                    data-id="${id}" 
                    data-value="${currentValue}"
                    data-options='${JSON.stringify(options).replace(/'/g, "&#39;")}'
                    tabindex="0">
                <span class="btn-label">${currentLabel}</span>
            </button>
        `;
    }

    _renderSelectionModal(title, options, currentValue, onSelect) {
        const overlay = this.$('#modal-overlay');
        if (!overlay) return;

        // Store focus context for restoration
        this._prevFocus = focusManager.getFocused();
        this._prevSection = focusManager.getActiveSection();

        overlay.innerHTML = `
            <div class="settings-modal" role="dialog" aria-modal="true">
                <div class="modal-header">
                    <h2>${title}</h2>
                </div>
                <div class="modal-options">
                    ${options.map(opt => `
                        <button class="modal-option-btn ${opt.value === currentValue ? 'selected' : ''}" 
                                data-value="${opt.value}"
                                tabindex="0">
                            <span>${opt.label}</span>
                            <div class="check-icon"></div>
                        </button>
                    `).join('')}
                </div>
                <div class="modal-actions">
                    <button class="modal-action-btn" id="btn-modal-cancel" tabindex="0">Cancel</button>
                </div>
            </div>
        `;

        // Show Overlay
        overlay.classList.add('visible');
        overlay.setAttribute('aria-hidden', 'false');

        // Bind Events
        overlay.querySelectorAll('.modal-option-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                onSelect(btn.dataset.value);
                this._closeSelectionModal();
            });
        });

        overlay.querySelector('#btn-modal-cancel').addEventListener('click', (e) => {
            e.stopPropagation();
            this._closeSelectionModal();
        });

        // Register Focus Sections
        focusManager.register('modal-options', overlay.querySelector('.modal-options'), {
            orientation: 'vertical',
            leaveDown: 'modal-actions',
            leaveUp: 'modal-actions',
            enterTo: 'last-focused'
        });

        focusManager.register('modal-actions', overlay.querySelector('.modal-actions'), {
            orientation: 'horizontal',
            leaveUp: 'modal-options'
        });

        // Set Focus
        focusManager.setActiveSection('modal-options');
        setTimeout(() => {
            const selected = overlay.querySelector('.modal-option-btn.selected') || overlay.querySelector('.modal-option-btn');
            if (selected) focusManager.focusElement(selected);
        }, 50);
    }

    _closeSelectionModal() {
        const overlay = this.$('#modal-overlay');
        if (!overlay || !overlay.classList.contains('visible')) return;

        overlay.classList.remove('visible');
        overlay.setAttribute('aria-hidden', 'true');
        overlay.innerHTML = '';

        // Unregister modal focus
        focusManager.unregister('modal-options');
        focusManager.unregister('modal-actions');

        // Restore Section & Focus
        if (this._prevSection) {
            focusManager.setActiveSection(this._prevSection, false);
        }
        if (this._prevFocus) {
            focusManager.focusElement(this._prevFocus);
        }

        this._prevFocus = null;
        this._prevSection = null;
    }

    _bindDropdownEvents() {
        // Use a map to handle setting IDs to storage keys/methods easily
        const settingsMap = {
            'layout': { key: 'layout', type: 'local' },
            'theme': { key: 'theme', type: 'local' },
            'image-quality-select': { key: 'imageQuality', type: 'service' },
            'max-resolution-select': { key: 'litefin_max_resolution', type: 'local' },
            'max-bitrate-select': { key: 'pref:maxBitrate', type: 'local' },
            'audio-lang-select': { key: 'pref:audioLang', type: 'local' },
            'subtitle-lang-select': { key: 'pref:subtitleLang', type: 'local' },
            'skip-forward-select': { key: 'skipForwardLength', type: 'player' },
            'skip-back-select': { key: 'skipBackLength', type: 'player' },
            'subtitle-mode-select': { key: 'subtitleMode', type: 'player' },
            'subtitle-size-select': { key: 'subtitleSize', type: 'player' },
            'subtitle-shadow-select': { key: 'subtitleDropShadow', type: 'player' },
            'subtitle-bg-select': { key: 'subtitleTextBackground', type: 'player' },
            'subtitle-size-select': { key: 'subtitleSize', type: 'player' },
            'subtitle-shadow-select': { key: 'subtitleDropShadow', type: 'player' },
            'subtitle-bg-select': { key: 'subtitleTextBackground', type: 'player' },
            'debug-width-select': { key: 'debug_width', type: 'debug' },
            'debug-height-select': { key: 'debug_height', type: 'debug' },
            'debug-position-select': { key: 'debug_position', type: 'debug' }
        };

        this.$$('.select-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const id = btn.dataset.id;
                const options = JSON.parse(btn.dataset.options);
                const currentValue = btn.dataset.value;
                const settingConfig = settingsMap[id];
                const title = btn.closest('.setting-item')?.querySelector('.setting-name')?.textContent || 'Select Option';

                this._renderSelectionModal(title, options, currentValue, (newValue) => {
                    // Update button UI
                    const newLabel = options.find(o => o.value === newValue)?.label;
                    const labelSpan = btn.querySelector('.btn-label');
                    if (labelSpan) labelSpan.innerText = newLabel;
                    btn.dataset.value = newValue;

                    // Save Setting based on type
                    if (settingConfig) {
                        if (settingConfig.type === 'local') {
                            localStorage.setItem(settingConfig.key, newValue);
                            if (settingConfig.key === 'layout' || settingConfig.key === 'theme' || settingConfig.key === 'litefin_max_resolution') {
                                window.location.reload();
                            }
                        } else if (settingConfig.type === 'service') {
                            imageService.setPreset(newValue);
                        } else if (settingConfig.type === 'player') {
                            const val = (settingConfig.key === 'skipForwardLength' || settingConfig.key === 'skipBackLength')
                                ? parseInt(newValue, 10)
                                : newValue;
                            PlayerSettings.set(settingConfig.key, val);
                        } else if (settingConfig.type === 'debug') {
                            localStorage.setItem(settingConfig.key, newValue);
                            if (settingConfig.key === 'debug_width') {
                                debugOverlay.setWidth(newValue);
                            } else if (settingConfig.key === 'debug_height') {
                                debugOverlay.setHeight(newValue);
                            } else if (settingConfig.key === 'debug_position') {
                                debugOverlay.setPosition(newValue);
                            }
                        }
                    }

                    console.log(`Setting ${id} saved: ${newValue}`);
                });
            });
        });

        // Debug Toggles
        const toggleLogs = this.$('#toggle-debug-logs');
        if (toggleLogs) {
            toggleLogs.addEventListener('click', () => {
                const newState = !toggleLogs.classList.contains('active');
                toggleLogs.classList.toggle('active');

                // Update DebugOverlay
                debugOverlay.setLogsEnabled(newState);

                // Persist
                localStorage.setItem('debug_logs_enabled', newState);

                // Update overlay toggle state
                const toggleOverlay = this.$('#toggle-debug-overlay');
                if (toggleOverlay) {
                    if (newState) {
                        toggleOverlay.removeAttribute('disabled');
                        toggleOverlay.style.opacity = '1';
                    } else {
                        toggleOverlay.setAttribute('disabled', 'true');
                        toggleOverlay.style.opacity = '0.5';

                        // Force disable overlay if logs are disabled
                        if (toggleOverlay.classList.contains('active')) {
                            toggleOverlay.classList.remove('active');
                            debugOverlay.setOverlayEnabled(false);
                            localStorage.setItem('debug_overlay_enabled', false);
                        }
                    }
                }
            });
        }

        const toggleOverlay = this.$('#toggle-debug-overlay');
        if (toggleOverlay) {
            toggleOverlay.addEventListener('click', () => {
                const newState = !toggleOverlay.classList.contains('active');
                toggleOverlay.classList.toggle('active');

                // Update DebugOverlay
                debugOverlay.setOverlayEnabled(newState);

                // Persist
                localStorage.setItem('debug_overlay_enabled', newState);
            });
        }
    }

    _switchTab(tabId, force = false) {
        if (this.activeTab === tabId && !force) return;
        this.activeTab = tabId;

        // Update sidebar UI
        this.$$('.settings-menu-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === tabId);
        });

        // Re-render content panel
        const panel = this.$('#settings-content-panel');
        if (panel) {
            panel.innerHTML = this._renderActiveTabContent();
            this._bindContentEvents(); // Re-bind events for new content

            // Invalidate focus cache
            focusManager.invalidateCache('settings-content');
            this._setupFocus();
        }
    }

    _setupFocus() {
        // Navigation: Sidebar <-> Content
        focusManager.register('settings-sidebar', this.$('#settings-sidebar'), {
            orientation: 'vertical',
            leaveRight: 'settings-content',
            enterTo: 'last-focused'
        });

        focusManager.register('settings-content', this.$('#settings-content-panel'), {
            orientation: 'grid',
            leaveLeft: 'settings-sidebar',
            enterTo: 'last-focused'
        });
    }

    _setLayout(layout) {
        layoutManager.setLayout(layout);
        this._switchTab('appearance', true);

        setTimeout(() => {
            const btn = this.$(`.layout-btn[data-layout="${layout}"]`);
            if (btn) focusManager.focusElement(btn);
        }, 50);
    }

    _setTheme(theme) {
        layoutManager.setTheme(theme);
        this._switchTab('appearance', true);

        setTimeout(() => {
            const btn = this.$(`.theme-btn[data-theme="${theme}"]`);
            if (btn) focusManager.focusElement(btn);
        }, 50);
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
        const overlay = this.$('#modal-overlay');
        if (overlay && overlay.classList.contains('visible')) {
            this._closeSelectionModal();
            return true;
        }

        router.back();
        return true;
    }

    _renderUserAvatar(user) {
        if (user?.PrimaryImageTag) {
            const imageUrl = api.getUserImageUrl(user.Id, {
                tag: user.PrimaryImageTag,
                quality: 90,
                maxWidth: 300
            });
            return `<img src="${imageUrl}" class="user-avatar" alt="${user.Name}" onerror="this.classList.add('hidden'); this.nextElementSibling.classList.remove('hidden')">
                    <div class="user-avatar-placeholder hidden">${user.Name[0].toUpperCase()}</div>`;
        }
        return `<div class="user-avatar-placeholder">${user?.Name ? user.Name[0].toUpperCase() : '?'}</div>`;
    }
}

export default SettingsPage;
