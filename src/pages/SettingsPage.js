/**
 * ============================================================================
 * Litefin Tizen - Settings Page
 * ============================================================================
 * App settings and preferences including layout, theme, and account.
 * Redesigned for TV with a split-view layout.
 * ============================================================================
 */

import Page from './Page.js';
import { auth, api } from '../api/index.js';
import { getDeviceCapabilities, clearCapabilitiesCache } from '../api/DeviceProfile.js';
import { router } from '../core/Router.js';
import { layoutManager } from '../ui/LayoutManager.js';
import { focusManager } from '../ui/FocusManager.js';
import { imageService } from '../utils/ImageService.js';
import { PlayerSettings } from '../utils/PlayerSettings.js';
import FontLoader from '../utils/FontLoader.js';
import { debugOverlay } from '../ui/DebugOverlay.js';
import { storage } from '../utils/StorageService.js';
import { logger } from '../utils/Logger.js';

const log = logger.create('SettingsPage');

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
                label: 'Display',
                icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="13.5" cy="6.5" r="2.5"/><path d="M20.38 10.32a.86.86 0 0 0-.25-.43l-1.62-1.66c-.46-.46-1.12-.58-1.57-.28l-.34.23c-.56.37-1.32.17-1.56-.46l-.16-.62c-.17-.67-.78-1.1-1.47-1.1H13c-.69 0-1.3.43-1.47 1.1l-.16.62c-.24.63-.99.83-1.56.46l-.33-.23c-.46-.3-1.12-.18-1.57.28L6.29 9.89a.86.86 0 0 0-.25.43 3.99 3.99 0 0 0 4.6 5.56l.32-.09c.64-.18 1.22.25 1.34.9l.06.33c.12.63.74 1.08 1.4.98l.61-.1c.64-.1.97-.78.7-1.37l-.2-.43c-.27-.6.03-1.32.64-1.52l.27-.09a4.01 4.01 0 0 0 3.6-4.17Z"/><path d="M2 22h20"/></svg>'
            },
            {
                id: 'player',
                label: 'Playback',
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
                        ${tabs
                            .map(
                                (tab) => `
                            <button class="settings-menu-btn ${this.activeTab === tab.id ? 'active' : ''}" 
                                    data-tab="${tab.id}" tabindex="0">
                                <span class="menu-icon">${tab.icon}</span>
                                <span class="menu-label">${tab.label}</span>
                            </button>
                        `
                            )
                            .join('')}
                    </aside>

                    <!-- Content Panel -->
                    <main class="settings-content-panel page-content" id="settings-content-panel">
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
                <h2 class="content-title">Display</h2>

                <!-- Theme Section -->
                <h3 class="setting-section-title">Theme</h3>
                
                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name">Layout Mode</span>
                        <span class="setting-description">Choose optimized layout for your screen</span>
                    </div>
                    <div class="setting-control">
                        <button class="btn btn-option layout-btn ${currentLayout === 'classic' ? 'active' : ''}" data-layout="classic" tabindex="0">Classic</button>
                        <button class="btn btn-option layout-btn ${currentLayout === 'modern' ? 'active' : ''}" data-layout="modern" tabindex="-1" disabled>Modern (later)</button>
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name">Color Theme</span>
                        <span class="setting-description">Select your preferred color scheme</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'theme-select',
                            availableThemes.map((t) => ({
                                value: t,
                                label: this._getThemeDisplayName(t)
                            })),
                            currentTheme
                        )}
                    </div>
                </div>

                <!-- Home Screen Section -->
                <h3 class="setting-section-title">Home Screen</h3>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name">Home Screen Customization</span>
                        <span class="setting-description">Hide "My Media" row from home screen</span>
                    </div>
                    <div class="setting-control">
                         <button class="toggle-switch ${storage.getItem('pref:hideMyMedia') === 'true' ? 'active' : ''}" 
                                 id="toggle-my-media" 
                                 tabindex="0"
                                 aria-label="Toggle My Media visibility">
                        </button>
                    </div>
                </div>

                <!-- Image Related Section -->
                <h3 class="setting-section-title">Image Related</h3>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name">Image Quality</span>
                        <span class="setting-description">Adjust for device performance (requires restart)</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'image-quality-select',
                            [
                                { value: 'low', label: 'Low (Fastest)' },
                                { value: 'medium', label: 'Medium (Balanced)' },
                                { value: 'high', label: 'High (High Quality)' },
                                { value: 'ultra', label: 'Ultra (Maximum)' }
                            ],
                            imageService.getPreset() || 'medium'
                        )}
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
                <h2 class="content-title">Playback</h2>
                
                <!-- Video Quality Section -->
                <h3 class="setting-section-title">Video Quality</h3>
                
                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name">Max Resolution</span>
                        <span class="setting-description">Override panel detection (Auto uses hardware APIs)</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'max-resolution-select',
                            [
                                { value: 'auto', label: 'Auto (Detect)' },
                                { value: '360p', label: '360p SD' },
                                { value: '480p', label: '480p SD' },
                                { value: '720p', label: '720p HD' },
                                { value: '1080p', label: '1080p FHD' },
                                { value: '2160p', label: '4K UHD' },
                                { value: '4320p', label: '8K UHD' }
                            ],
                            PlayerSettings.get('maxResolution') || 'auto'
                        )}
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name">Max Streaming Bitrate</span>
                        <span class="setting-description">Quality when streaming over internet</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'max-bitrate-select',
                            [
                                { value: '120000000', label: '120 Mbps (4K Max)' },
                                { value: '80000000', label: '80 Mbps (4K High)' },
                                { value: '60000000', label: '60 Mbps (4K)' },
                                { value: '40000000', label: '40 Mbps (1080p Max)' },
                                { value: '20000000', label: '20 Mbps (1080p)' },
                                { value: '15000000', label: '15 Mbps' },
                                { value: '10000000', label: '10 Mbps' },
                                { value: '8000000', label: '8 Mbps' },
                                { value: '6000000', label: '6 Mbps' },
                                { value: '4000000', label: '4 Mbps' },
                                { value: '3000000', label: '3 Mbps' },
                                { value: '1500000', label: '1.5 Mbps' },
                                { value: '720000', label: '720 kbps' },
                                { value: '420000', label: '420 kbps' }
                            ],
                            String(PlayerSettings.get('maxBitrateInternet') || 120000000)
                        )}
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name">Preferred Audio Language</span>
                        <span class="setting-description">Default language for audio tracks</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'audio-lang-select',
                            [
                                { value: 'auto', label: 'Auto' },
                                { value: 'eng', label: 'English' },
                                { value: 'ara', label: 'Arabic' },
                                { value: 'spa', label: 'Spanish' },
                                { value: 'fre', label: 'French' },
                                { value: 'jpn', label: 'Japanese' },
                                { value: 'kor', label: 'Korean' }
                            ],
                            storage.getItem('pref:audioLang') || 'auto'
                        )}
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
                        ${this._renderDropdown(
                            'skip-forward-select',
                            [
                                { value: '5000', label: '5 seconds' },
                                { value: '10000', label: '10 seconds' },
                                { value: '15000', label: '15 seconds' },
                                { value: '30000', label: '30 seconds' }
                            ],
                            String(PlayerSettings.get('skipForwardLength'))
                        )}
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name">Skip Back Duration</span>
                        <span class="setting-description">Seconds to skip when pressing back</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'skip-back-select',
                            [
                                { value: '5000', label: '5 seconds' },
                                { value: '10000', label: '10 seconds' },
                                { value: '15000', label: '15 seconds' },
                                { value: '30000', label: '30 seconds' }
                            ],
                            String(PlayerSettings.get('skipBackLength'))
                        )}
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

                <!-- ============================================================ -->
                <!-- Playback Compatibility Section -->
                <!-- ============================================================ -->
                <h3 class="setting-section-title">Playback Compatibility</h3>

                <!-- HEVC Toggle -->
                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name">HEVC / H.265</span>
                        <span class="setting-description">Direct play HEVC content (supported on all Tizen 4+ TVs)</span>
                    </div>
                    <div class="setting-control">
                         <button class="toggle-switch ${PlayerSettings.get('enableHEVC') ? 'active' : ''}" 
                                 id="toggle-enable-hevc" 
                                 data-setting="enableHEVC"
                                 tabindex="0"
                                 aria-label="Toggle HEVC">
                        </button>
                    </div>
                </div>

                <!-- HDR Toggle -->
                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name">HDR10 / HLG</span>
                        <span class="setting-description">Pass HDR content to the display without transcoding</span>
                    </div>
                    <div class="setting-control">
                         <button class="toggle-switch ${PlayerSettings.get('enableHDR') ? 'active' : ''}" 
                                 id="toggle-enable-hdr" 
                                 data-setting="enableHDR"
                                 tabindex="0"
                                 aria-label="Toggle HDR">
                        </button>
                    </div>
                </div>

                <!-- Dolby Vision Toggle -->
                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name">Dolby Vision</span>
                        <span class="setting-description">Enable DV if your TV supports it (auto-detected)</span>
                    </div>
                    <div class="setting-control">
                         <button class="toggle-switch ${PlayerSettings.get('enableDolbyVision') ? 'active' : ''}" 
                                 id="toggle-enable-dv" 
                                 data-setting="enableDolbyVision"
                                 tabindex="0"
                                 aria-label="Toggle Dolby Vision">
                        </button>
                    </div>
                </div>

                <!-- Advanced Codec Section -->
                <h3 class="setting-section-title">Advanced Codec Settings</h3>

                <!-- AV1 Toggle -->
                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name">AV1</span>
                        <span class="setting-description">Direct play AV1 content (requires Tizen 5.5+ / 2020+ TV)</span>
                    </div>
                    <div class="setting-control">
                         <button class="toggle-switch ${PlayerSettings.get('enableAV1') ? 'active' : ''}" 
                                 id="toggle-enable-av1" 
                                 data-setting="enableAV1"
                                 tabindex="0"
                                 aria-label="Toggle AV1">
                        </button>
                    </div>
                </div>

                <!-- VP9 Toggle -->
                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name">VP9</span>
                        <span class="setting-description">Direct play VP9 content (WebM, YouTube-style files)</span>
                    </div>
                    <div class="setting-control">
                         <button class="toggle-switch ${PlayerSettings.get('enableVP9') ? 'active' : ''}" 
                                 id="toggle-enable-vp9" 
                                 data-setting="enableVP9"
                                 tabindex="0"
                                 aria-label="Toggle VP9">
                        </button>
                    </div>
                </div>

                <!-- DTS Passthrough Toggle -->
                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name">DTS Passthrough</span>
                        <span class="setting-description">⚠ Samsung TVs do NOT decode DTS — only enable with external audio</span>
                    </div>
                    <div class="setting-control">
                         <button class="toggle-switch ${PlayerSettings.get('enableDts') ? 'active' : ''}" 
                                 id="toggle-enable-dts" 
                                 data-setting="enableDts"
                                 tabindex="0"
                                 aria-label="Toggle DTS">
                        </button>
                    </div>
                </div>

                <!-- TrueHD Passthrough Toggle -->
                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name">TrueHD Passthrough</span>
                        <span class="setting-description">⚠ Not in Samsung specs — only enable with external audio</span>
                    </div>
                    <div class="setting-control">
                         <button class="toggle-switch ${PlayerSettings.get('enableTrueHd') ? 'active' : ''}" 
                                 id="toggle-enable-truehd" 
                                 data-setting="enableTrueHd"
                                 tabindex="0"
                                 aria-label="Toggle TrueHD">
                        </button>
                    </div>
                </div>

                <!-- Force Transcode Toggle -->
                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name">Force Transcode</span>
                        <span class="setting-description">⚠ Emergency fallback — forces ALL content to transcode via HLS</span>
                    </div>
                    <div class="setting-control">
                         <button class="toggle-switch ${PlayerSettings.get('forceTranscode') ? 'active' : ''}" 
                                 id="toggle-force-transcode" 
                                 data-setting="forceTranscode"
                                 tabindex="0"
                                 aria-label="Toggle Force Transcode">
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
                        ${this._renderDropdown(
                            'subtitle-lang-select',
                            [
                                { value: 'none', label: 'None' },
                                { value: 'eng', label: 'English' },
                                { value: 'ara', label: 'Arabic' },
                                { value: 'spa', label: 'Spanish' },
                                { value: 'fre', label: 'French' },
                                { value: 'jpn', label: 'Japanese' },
                                { value: 'kor', label: 'Korean' }
                            ],
                            storage.getItem('pref:subtitleLang') || 'none'
                        )}
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name">Subtitle Mode</span>
                        <span class="setting-description">When to show subtitles automatically</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'subtitle-mode-select',
                            [
                                { value: 'Default', label: 'Default (Server preference)' },
                                { value: 'Smart', label: 'Smart (Foreign audio only)' },
                                { value: 'OnlyForced', label: 'Only Forced' },
                                { value: 'Always', label: 'Always' },
                                { value: 'None', label: 'None' }
                            ],
                            PlayerSettings.get('subtitleMode')
                        )}
                    </div>
                </div>

                <!-- Subtitle Appearance Section -->
                <h3 class="setting-section-title">Appearance</h3>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name">Font Family</span>
                        <span class="setting-description">Subtitle font style</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'subtitle-font-select',
                            [
                                { value: '', label: 'Default - Tizen Sans' },
                                { value: 'poppins', label: 'Modern - Poppins' },
                                { value: 'noto-arabic', label: 'Arabic - Noto Sans' },
                                { value: 'typewriter', label: 'Typewriter - Courier Prime' },
                                { value: 'print', label: 'Print - Merriweather' },
                                { value: 'console', label: 'Console - Inconsolata' },
                                { value: 'cursive', label: 'Cursive - Dancing Script' },
                                { value: 'casual', label: 'Casual - Patrick Hand' },
                                { value: 'smallcaps', label: 'Small Caps - Variant' }
                            ],
                            PlayerSettings.get('subtitleFont')
                        )}
                    </div>
                </div>
                
                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name">Text Size</span>
                        <span class="setting-description">Subtitle text size</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'subtitle-size-select',
                            [
                                { value: 'small', label: 'Small' },
                                { value: 'medium', label: 'Medium' },
                                { value: 'large', label: 'Large' },
                                { value: 'larger', label: 'Larger' },
                                { value: 'extralarge', label: 'Extra Large' }
                            ],
                            PlayerSettings.get('subtitleSize')
                        )}
                    </div>
                </div>

                  <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name">Vertical Position</span>
                        <span class="setting-description">Subtitle vertical position</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'subtitle-position-select',
                            [
                                { value: '-1', label: 'Bottom (Low)' },
                                { value: '-2', label: 'Bottom (Standard)' },
                                { value: '-5', label: 'Bottom (High)' },
                                { value: '0', label: 'Top' },
                                { value: '2', label: 'Top (Low)' },
                                { value: 'custom', label: 'Custom (Absolute)' }
                            ],
                            String(PlayerSettings.get('subtitleVerticalPosition')) // allow 0
                        )}
                    </div>
                </div>

                <div class="setting-item" id="subtitle-custom-pos-container">
                    <div class="setting-label">
                        <span class="setting-name">Absolute Position %</span>
                        <span class="setting-description">Distance from bottom (0-100%)</span>
                    </div>
                    <div class="setting-control slider-control">
                        ${this._renderSlider(
                            'subtitle-custom-pos',
                            PlayerSettings.get('subtitleVerticalPositionCustom'),
                            0,
                            100,
                            1
                        )}
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name">Font Weight</span>
                        <span class="setting-description">Subtitle text thickness</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'subtitle-weight-select',
                            [
                                { value: 'normal', label: 'Normal' },
                                { value: 'bold', label: 'Bold' }
                            ],
                            PlayerSettings.get('subtitleWeight') || 'normal'
                        )}
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name">Text Color</span>
                        <span class="setting-description">Subtitle text color</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'subtitle-color-select',
                            [
                                { value: '#ffffff', label: 'White' },
                                { value: '#d3d3d3', label: 'Light Grey' },
                                { value: '#a9a9a9', label: 'Dark Grey' },
                                { value: '#000000', label: 'Black' },
                                { value: '#ffff00', label: 'Yellow' },
                                { value: '#00ffff', label: 'Cyan' },
                                { value: '#0000ff', label: 'Blue' }
                            ],
                            PlayerSettings.get('subtitleTextColor') || '#ffffff'
                        )}
                    </div>
                </div>

                                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name">Text Opacity</span>
                        <span class="setting-description">Subtitle text transparency</span>
                    </div>
                    <div class="setting-control slider-control">
                        ${this._renderSlider(
                            'subtitle-text-opacity',
                            PlayerSettings.get('subtitleTextOpacity'),
                            0,
                            100,
                            5
                        )}
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name">Background Color</span>
                        <span class="setting-description">Subtitle background color</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'subtitle-bg-select',
                            [
                                { value: 'transparent', label: 'None' },
                                { value: '#000000', label: 'Black' },
                                { value: '#ffffff', label: 'White' },
                                { value: '#d3d3d3', label: 'Light Grey' },
                                { value: '#a9a9a9', label: 'Dark Grey' },
                                { value: '#ffff00', label: 'Yellow' },
                                { value: '#00ffff', label: 'Cyan' },
                                { value: '#0000ff', label: 'Blue' }
                            ],
                            PlayerSettings.get('subtitleTextBackground')
                        )}
                    </div>
                </div>

                <div class="setting-item" id="subtitle-bg-opacity-container">
                    <div class="setting-label">
                        <span class="setting-name">Background Opacity</span>
                        <span class="setting-description">Subtitle background transparency</span>
                    </div>
                    <div class="setting-control slider-control">
                        ${this._renderSlider(
                            'subtitle-bg-opacity',
                            PlayerSettings.get('subtitleBackgroundOpacity'),
                            0,
                            100,
                            5
                        )}
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name">Text Shadow</span>
                        <span class="setting-description">Subtitle shadow style</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'subtitle-shadow-select',
                            [
                                { value: 'none', label: 'None' },
                                { value: 'uniform', label: 'Uniform' },
                                { value: 'dropshadow', label: 'Drop Shadow' },
                                { value: 'raised', label: 'Raised' },
                                { value: 'depressed', label: 'Depressed' }
                            ],
                            PlayerSettings.get('subtitleDropShadow')
                        )}
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name">Shadow Color</span>
                        <span class="setting-description">Color of the drop shadow</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'subtitle-shadow-color-select',
                            [
                                { value: '#000000', label: 'Black' },
                                { value: '#ffffff', label: 'White' },
                                { value: '#ff0000', label: 'Red' },
                                { value: '#00ff00', label: 'Green' },
                                { value: '#0000ff', label: 'Blue' },
                                { value: '#ffff00', label: 'Yellow' },
                                { value: '#00ffff', label: 'Cyan' },
                                { value: '#ff00ff', label: 'Magenta' },
                                { value: '#808080', label: 'Grey' }
                            ],
                            PlayerSettings.get('subtitleDropShadowColor') || '#000000'
                        )}
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name">Shadow Opacity</span>
                        <span class="setting-description">Opacity of the drop shadow</span>
                    </div>
                    <div class="setting-control slider-control">
                        ${this._renderSlider(
                            'subtitle-shadow-opacity',
                            PlayerSettings.get('subtitleDropShadowOpacity') ?? 100,
                            0,
                            100,
                            5
                        )}
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name">Shadow Blur</span>
                        <span class="setting-description">Softness of the shadow</span>
                    </div>
                    <div class="setting-control slider-control">
                        ${this._renderSlider(
                            'subtitle-shadow-blur',
                            PlayerSettings.get('subtitleDropShadowBlur') ?? 4,
                            0,
                            20,
                            1
                        )}
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
        const caps = getDeviceCapabilities();

        return `
            <div class="settings-tab-content">
                <h2 class="content-title">About Litefin</h2>
                
                <div class="about-card" tabindex="0">
                    <h3 class="app-version">Version ${__APP_VERSION__}</h3>
                    <p class="about-desc">
                        A lightweight, community-driven Jellyfin client optimized for Tizen TVs.
                        Built with love for speed and simplicity.
                    </p>
                    <p class="about-credits">Developed by MoazSalem</p>
                </div>

                <h3 class="setting-section-title">Device Information</h3>
                <div class="about-card identity-card" tabindex="0">
                    <div class="identity-grid">
                        <div class="identity-item">
                            <span class="identity-label">Model</span>
                            <span class="identity-value">${caps.modelName}</span>
                        </div>
                        <div class="identity-item">
                            <span class="identity-label">Platform</span>
                            <span class="identity-value">Tizen ${caps.tizenVersion}</span>
                        </div>
                        <div class="identity-item">
                            <span class="identity-label">Resolution</span>
                            <span class="identity-value">${caps.screenWidth}x${caps.screenHeight} (${caps.uhd8K ? '8K' : caps.uhd ? '4K' : 'FHD'})</span>
                        </div>
                        <div class="identity-item">
                            <span class="identity-label">HDR Support</span>
                            <span class="identity-value">${
                                [
                                    caps.hdr10 ? 'HDR10' : null,
                                    caps.hdr10Plus ? 'HDR10+' : null,
                                    caps.hlg ? 'HLG' : null,
                                    caps.dolbyVision ? 'Dolby Vision' : null
                                ]
                                    .filter(Boolean)
                                    .join(', ') || 'SDR Only'
                            }</span>
                        </div>
                        <div class="identity-item">
                            <span class="identity-label">Video Codecs</span>
                            <span class="identity-value">${[
                                'H.264',
                                caps.hevc ? 'HEVC' : null,
                                caps.av1 ? 'AV1' : null,
                                caps.vp9 ? 'VP9' : null
                            ]
                                .filter(Boolean)
                                .join(', ')}</span>
                        </div>
                    </div>
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

                <!-- Logging Section -->
                <h3 class="setting-section-title">Logging</h3>

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
                        <span class="setting-name">Upload Logs</span>
                        <span class="setting-description">Send current session logs to the jellyfin server</span>
                    </div>
                    <div class="setting-control">
                        <button class="btn btn-option" id="btn-upload-logs" tabindex="0" style="width: auto; min-width: 120px;">
                            Upload
                        </button>
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name">Overlay Width</span>
                        <span class="setting-description">Horizontal size of the debug window</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'debug-width-select',
                            [
                                { value: 'small', label: 'Small' },
                                { value: 'medium', label: 'Medium' },
                                { value: 'large', label: 'Large' },
                                { value: 'full', label: 'Full Screen' }
                            ],
                            debugOverlay.Width || 'small'
                        )}
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name">Overlay Height</span>
                        <span class="setting-description">Vertical size of the debug window</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'debug-height-select',
                            [
                                { value: 'small', label: 'Small' },
                                { value: 'medium', label: 'Medium' },
                                { value: 'large', label: 'Large' },
                                { value: 'full', label: 'Full Screen' }
                            ],
                            debugOverlay.Height || 'small'
                        )}
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name">Overlay Position</span>
                        <span class="setting-description">Screen location of the debug window</span>
                    </div>
            <div class="setting-control">
                        ${this._renderDropdown(
                            'debug-position-select',
                            [
                                { value: 'top-left', label: 'Top Left' },
                                { value: 'top-right', label: 'Top Right' },
                                { value: 'bottom-left', label: 'Bottom Left' },
                                { value: 'bottom-right', label: 'Bottom Right' }
                            ],
                            debugOverlay.Position || 'bottom-right'
                        )}
                    </div>
                </div>

                <!-- Module Filters -->
                <h3 class="setting-section-title">Module Filters</h3>
                <div class="module-filters-grid">
                    <div class="setting-item compact">
                        <div class="setting-label">
                            <span class="setting-name">Enable All Filters</span>
                        </div>
                        <div class="setting-control">
                            <button class="btn btn-option" id="btn-enable-all-filters" tabindex="0" style="width: auto; min-width: 100px;">
                                Enable
                            </button>
                        </div>
                    </div>
                    <div class="setting-item compact">
                        <div class="setting-label">
                            <span class="setting-name">Disable All Filters</span>
                        </div>
                        <div class="setting-control">
                            <button class="btn btn-option" id="btn-disable-all-filters" tabindex="0" style="width: auto; min-width: 100px;">
                                Disable
                            </button>
                        </div>
                    </div>
                    ${debugOverlay
                        .getKnownModules()
                        .map(
                            (module) => `
                        <div class="setting-item compact">
                            <div class="setting-label">
                                <span class="setting-name">${module}</span>
                            </div>
                            <div class="setting-control">
                                <button class="toggle-switch module-filter-toggle ${debugOverlay.isModuleEnabled(module) ? 'active' : ''}" 
                                        data-module="${module}"
                                        tabindex="0">
                                </button>
                            </div>
                        </div>
                    `
                        )
                        .join('')}
                </div>
            </div>
        `;
    }

    onMounted() {
        this._bindEvents();
        this._setupFocus();

        // Default focus to the active tab button in the sidebar.
        // We do this explicitly instead of relying on last-focused behavior,
        // to ensure we always start at the current selection.
        const activeBtn = this.$(`.settings-menu-btn[data-tab="${this.activeTab}"]`);
        if (activeBtn) {
            focusManager.focusElement(activeBtn);
        } else {
            this.setActiveSection('settings-sidebar');
        }
    }

    _bindEvents() {
        // Back button

        // Sidebar Navigation
        this.$$('.settings-menu-btn').forEach((btn) => {
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
        this.$$('.layout-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                this._setLayout(btn.dataset.layout);
            });
        });

        // Toggle My Media
        const myMediaBtn = this.$('#toggle-my-media');
        if (myMediaBtn) {
            myMediaBtn.addEventListener('click', () => {
                const isHidden = storage.getItem('pref:hideMyMedia') === 'true';
                const newValue = !isHidden;
                storage.setItem('pref:hideMyMedia', newValue);
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

        // === Playback Compatibility Toggles ===
        // Generic handler for all toggle-switch buttons with data-setting attribute
        // Each toggle reads/writes to PlayerSettings and invalidates the cached profile
        const profileToggles = [
            'toggle-enable-hevc',
            'toggle-enable-hdr',
            'toggle-enable-dv',
            'toggle-enable-av1',
            'toggle-enable-vp9',
            'toggle-enable-dts',
            'toggle-enable-truehd',
            'toggle-force-transcode'
        ];
        profileToggles.forEach((toggleId) => {
            const btn = this.$(`#${toggleId}`);
            if (btn && btn.dataset.setting) {
                btn.addEventListener('click', () => {
                    const settingKey = btn.dataset.setting;
                    const currentValue = PlayerSettings.get(settingKey);
                    const newValue = !currentValue;
                    PlayerSettings.set(settingKey, newValue);
                    btn.classList.toggle('active', newValue);
                    // Invalidate cached device capabilities so next profile build uses new settings
                    clearCapabilitiesCache();
                    log.info(`Profile setting changed: ${settingKey} = ${newValue}`);
                });
            }
        });

        // Log Out
        this.$('.switch-user-btn')?.addEventListener('click', async () => {
            await auth.logout();
            router.reset('/login');
        });

        // Initialize Custom Dropdowns
        this._bindDropdownEvents();

        // Initialize Sliders
        this._bindSliderEvents();

        // Upload Logs Button
        const uploadLogsBtn = this.$('#btn-upload-logs');
        if (uploadLogsBtn) {
            uploadLogsBtn.addEventListener('click', async () => {
                uploadLogsBtn.disabled = true;
                uploadLogsBtn.textContent = 'Uploading...';

                try {
                    const logs = debugOverlay.getLogDump();
                    if (!logs) {
                        throw new Error('No logs to upload');
                    }

                    const filename = `Litefin_Log_${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;

                    // Attempt upload
                    await api.uploadClientLog(filename, logs);

                    // Success feedback
                    uploadLogsBtn.textContent = 'Success!';
                    setTimeout(() => {
                        uploadLogsBtn.disabled = false;
                        uploadLogsBtn.textContent = 'Upload';
                    }, 2000);
                } catch (error) {
                    log.error('Failed to upload logs:', error);
                    uploadLogsBtn.textContent = 'Failed';
                    // Re-enable after delay
                    setTimeout(() => {
                        uploadLogsBtn.disabled = false;
                        uploadLogsBtn.textContent = 'Upload';
                    }, 2000);

                    // Show error toast if we had one, but button text update is good for now
                }
            });
        }
    }

    _renderSlider(id, value, min, max, step) {
        // Calculate percentage for background gradient
        const percent = ((value - min) / (max - min)) * 100;

        return `
            <div class="slider-wrapper">
                <div class="slider-track" style="--progress: ${percent}%">
                    <input type="range" 
                        id="${id}" 
                        class="setting-slider focusable" 
                        min="${min}" 
                        max="${max}" 
                        step="${step}" 
                        value="${value}"
                        tabindex="0">
                    <div class="slider-fill" style="width: ${percent}%"></div>
                </div>
                <span class="slider-value" id="${id}-value">${value}%</span>
            </div>
        `;
    }

    _bindSliderEvents() {
        const sliderMap = {
            'subtitle-text-opacity': 'subtitleTextOpacity',
            'subtitle-bg-opacity': 'subtitleBackgroundOpacity',
            'subtitle-shadow-opacity': 'subtitleDropShadowOpacity',
            'subtitle-shadow-blur': 'subtitleDropShadowBlur',
            'subtitle-custom-pos': 'subtitleVerticalPositionCustom'
        };

        this.$$('.setting-slider').forEach((slider) => {
            slider.addEventListener('input', (e) => {
                const id = slider.id;
                const value = e.target.value;
                const key = sliderMap[id];

                // Update value display
                const valueDisplay = this.$(`#${id}-value`);
                if (valueDisplay) {
                    valueDisplay.textContent = `${value}%`;
                }

                // Update slider fill visual
                const percent = ((value - slider.min) / (slider.max - slider.min)) * 100;
                const track = slider.closest('.slider-track');
                if (track) {
                    track.style.setProperty('--progress', `${percent}%`);
                    const fill = track.querySelector('.slider-fill');
                    if (fill) {
                        fill.style.width = `${percent}%`;
                    }
                }

                // Save setting
                if (key) {
                    PlayerSettings.set(key, parseInt(value, 10));
                }
            });

            // FORCE UPDATE ON INIT:
            // Tizen sometimes misses the initial inline style paint or needs a layout trigger.
            // We manually trigger the 'input' event logic (without saving) to ensure visuals are set.
            const value = slider.value;
            const percent = ((value - slider.min) / (slider.max - slider.min)) * 100;
            const track = slider.closest('.slider-track');
            if (track) {
                track.style.setProperty('--progress', `${percent}%`);
                const fill = track.querySelector('.slider-fill');
                if (fill) {
                    fill.style.width = `${percent}%`;
                }
            }
        });
    }

    _renderDropdown(id, options, currentValue) {
        // Find current label
        const currentOption = options.find((o) => o.value === currentValue) || options[0];
        const currentLabel = currentOption ? currentOption.label : 'Select';

        // Render as a button that triggers the modal
        return `
            <button class="setting-action-btn select-btn" id="${id}-btn" 
                    data-id="${id}" 
                    data-value="${currentValue}"
                    data-options='${JSON.stringify(options).replace(/'/g, '&#39;')}'
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
                    ${options
                        .map(
                            (opt) => `
                        <button class="modal-option-btn ${opt.value === currentValue ? 'selected' : ''}" 
                                data-value="${opt.value}"
                                tabindex="0">
                            <span>${opt.label}</span>
                            <div class="check-icon"></div>
                        </button>
                    `
                        )
                        .join('')}
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
        overlay.querySelectorAll('.modal-option-btn').forEach((btn) => {
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
            const selected =
                overlay.querySelector('.modal-option-btn.selected') || overlay.querySelector('.modal-option-btn');
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
            layout: { key: 'layout', type: 'local' },
            'theme-select': { key: 'theme', type: 'local' },
            'image-quality-select': { key: 'imageQuality', type: 'service' },
            'max-resolution-select': { key: 'maxResolution', type: 'player' },
            'max-bitrate-select': { key: 'maxBitrateInternet', type: 'player' },
            'audio-lang-select': { key: 'pref:audioLang', type: 'local' },
            'subtitle-lang-select': { key: 'pref:subtitleLang', type: 'local' },
            'skip-forward-select': { key: 'skipForwardLength', type: 'player' },
            'skip-back-select': { key: 'skipBackLength', type: 'player' },
            'subtitle-mode-select': { key: 'subtitleMode', type: 'player' },
            'subtitle-size-select': { key: 'subtitleSize', type: 'player' },
            'subtitle-weight-select': { key: 'subtitleWeight', type: 'player' },
            'subtitle-font-select': { key: 'subtitleFont', type: 'player' },
            'subtitle-color-select': { key: 'subtitleTextColor', type: 'player' },
            'subtitle-shadow-select': { key: 'subtitleDropShadow', type: 'player' },
            'subtitle-shadow-color-select': { key: 'subtitleDropShadowColor', type: 'player' },
            'subtitle-bg-select': { key: 'subtitleTextBackground', type: 'player' },
            'subtitle-position-select': { key: 'subtitleVerticalPosition', type: 'player' },
            'debug-width-select': { key: 'debug_width', type: 'debug' },
            'debug-height-select': { key: 'debug_height', type: 'debug' },
            'debug-position-select': { key: 'debug_position', type: 'debug' }
        };

        this.$$('.select-btn').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                const id = btn.dataset.id;
                const options = JSON.parse(btn.dataset.options);
                const currentValue = btn.dataset.value;
                const settingConfig = settingsMap[id];
                const title =
                    btn.closest('.setting-item')?.querySelector('.setting-name')?.textContent || 'Select Option';

                this._renderSelectionModal(title, options, currentValue, (newValue) => {
                    // Update button UI
                    const newLabel = options.find((o) => o.value === newValue)?.label;
                    const labelSpan = btn.querySelector('.btn-label');
                    if (labelSpan) labelSpan.innerText = newLabel;
                    btn.dataset.value = newValue;

                    // Save Setting based on type
                    if (settingConfig) {
                        if (id === 'theme-select') {
                            // SPECIAL CASE: Theme changes should be handled by LayoutManager
                            // It handles persistence (litefin:theme) and DOM updates
                            layoutManager.setTheme(newValue);
                            // No reload needed!
                        } else if (settingConfig.type === 'local') {
                            storage.setItem(settingConfig.key, newValue);
                            if (settingConfig.key === 'layout') {
                                window.location.reload();
                            }
                        } else if (settingConfig.type === 'service') {
                            imageService.setPreset(newValue);
                        } else if (settingConfig.type === 'player') {
                            // Numeric settings need parseInt conversion
                            const numericKeys = ['skipForwardLength', 'skipBackLength', 'maxBitrateInternet'];
                            const val = numericKeys.includes(settingConfig.key) ? parseInt(newValue, 10) : newValue;
                            PlayerSettings.set(settingConfig.key, val);

                            // Invalidate cached device capabilities when profile-affecting settings change
                            if (settingConfig.key === 'maxResolution' || settingConfig.key === 'maxBitrateInternet') {
                                clearCapabilitiesCache();
                            }

                            // VISIBILITY TIGGLE: Hide background opacity if background is None
                            if (id === 'subtitle-bg-select') {
                                const opacityContainer = document.getElementById('subtitle-bg-opacity-container');
                                if (opacityContainer) {
                                    if (newValue === 'transparent' || newValue === 'none') {
                                        opacityContainer.style.display = 'none';
                                    } else {
                                        opacityContainer.style.display = ''; // Restore to CSS (flex)
                                    }
                                    // REFRESH FOCUS: The focusable elements changed
                                    focusManager.invalidateCache('settings-content');
                                }
                            }

                            // VISIBILITY TOGGLE: Show custom position slider if Position is Custom
                            if (id === 'subtitle-position-select') {
                                const customPosContainer = document.getElementById('subtitle-custom-pos-container');
                                if (customPosContainer) {
                                    if (newValue === 'custom') {
                                        customPosContainer.style.display = ''; // Restore to CSS (flex)
                                    } else {
                                        customPosContainer.style.display = 'none';
                                    }
                                    // REFRESH FOCUS: The focusable elements changed
                                    focusManager.invalidateCache('settings-content');
                                }
                            }

                            // FONT LOADING: Trigger download if needed
                            if (settingConfig.key === 'subtitleFont' && newValue) {
                                FontLoader.loadFont(newValue).then((loaded) => {
                                    if (loaded) {
                                        log.debug(`Font loaded: ${newValue}`);
                                    } else {
                                        log.warn(`Failed to load font: ${newValue}`);
                                    }
                                });
                            }
                        } else if (settingConfig.type === 'debug') {
                            storage.setItem(settingConfig.key, newValue);
                            if (settingConfig.key === 'debug_width') {
                                debugOverlay.setWidth(newValue);
                            } else if (settingConfig.key === 'debug_height') {
                                debugOverlay.setHeight(newValue);
                            } else if (settingConfig.key === 'debug_position') {
                                debugOverlay.setPosition(newValue);
                            }
                        }
                    }

                    log.debug(`Setting ${id} saved: ${newValue}`);
                });
            });
        });

        // Initial Visibility Check for Background Opacity
        const bgContainer = document.getElementById('subtitle-bg-opacity-container');
        if (bgContainer) {
            const currentBg = PlayerSettings.get('subtitleTextBackground');
            if (currentBg === 'transparent' || currentBg === 'none') {
                bgContainer.style.display = 'none';
            } else {
                bgContainer.style.display = ''; // Restore to CSS (flex)
            }
        }

        // Initial Visibility Check for Custom Position
        const customPosContainer = document.getElementById('subtitle-custom-pos-container');
        if (customPosContainer) {
            const currentPos = PlayerSettings.get('subtitleVerticalPosition');
            if (currentPos === 'custom') {
                customPosContainer.style.display = ''; // Restore to CSS (flex)
            } else {
                customPosContainer.style.display = 'none';
            }
        }

        // Debug Toggles
        const toggleLogs = this.$('#toggle-debug-logs');
        if (toggleLogs) {
            toggleLogs.addEventListener('click', () => {
                const newState = !toggleLogs.classList.contains('active');
                toggleLogs.classList.toggle('active');

                // Update DebugOverlay
                debugOverlay.setLogsEnabled(newState);

                // Persist
                storage.setItem('debug_logs_enabled', newState);

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
                            storage.setItem('debug_overlay_enabled', false);
                        }
                    }
                }
            });
        }

        const toggleOverlay = this.$('#toggle-debug-overlay');
        if (toggleOverlay) {
            toggleOverlay.addEventListener('click', () => {
                if (toggleOverlay.getAttribute('disabled')) return;

                const newState = !toggleOverlay.classList.contains('active');
                toggleOverlay.classList.toggle('active');

                // Update DebugOverlay
                debugOverlay.setOverlayEnabled(newState);
                storage.setItem('debug_overlay_enabled', newState);
            });
        }

        // Enable All Filters
        const btnEnableAll = this.$('#btn-enable-all-filters');
        const btnDisableAll = this.$('#btn-disable-all-filters');

        if (btnEnableAll) {
            btnEnableAll.addEventListener('click', () => {
                const modules = debugOverlay.getKnownModules();
                modules.forEach((module) => {
                    debugOverlay.toggleModule(module, true);
                });

                // Update UI toggles
                this.$$('.module-filter-toggle').forEach((btn) => {
                    btn.classList.add('active');
                });
            });
        }

        if (btnDisableAll) {
            btnDisableAll.addEventListener('click', () => {
                const modules = debugOverlay.getKnownModules();
                modules.forEach((module) => {
                    debugOverlay.toggleModule(module, false);
                });

                // Update UI toggles
                this.$$('.module-filter-toggle').forEach((btn) => {
                    btn.classList.remove('active');
                });
            });
        }

        // Module Filter Toggles
        this.$$('.module-filter-toggle').forEach((btn) => {
            btn.addEventListener('click', () => {
                const module = btn.dataset.module;
                const newState = !btn.classList.contains('active');

                btn.classList.toggle('active');
                debugOverlay.toggleModule(module, newState);
            });
        });
    }

    _switchTab(tabId, force = false) {
        if (this.activeTab === tabId && !force) return;
        this.activeTab = tabId;

        // Update sidebar UI
        this.$$('.settings-menu-btn').forEach((btn) => {
            btn.classList.toggle('active', btn.dataset.tab === tabId);
        });

        // Re-render content panel
        const panel = this.$('#settings-content-panel');
        if (panel) {
            panel.innerHTML = this._renderActiveTabContent();
            panel.scrollTop = 0; // Reset scroll position to top on tab change
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
            leaveLeft: 'sidebar',
            enterTo: 'last-focused'
        });

        focusManager.register('settings-content', this.$('#settings-content-panel'), {
            orientation: 'vertical',
            // Custom Left Navigation: Always return to the ACTIVE sidebar tab
            // This ensures predictable navigation ("Back to parent") behavior
            onMove: (dir) => {
                if (dir === 'left') {
                    const activeBtn = this.$(`.settings-menu-btn[data-tab="${this.activeTab}"]`);
                    if (activeBtn) {
                        focusManager.focusElement(activeBtn);
                        return true; // Handled
                    }
                }
                return false;
            },
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
