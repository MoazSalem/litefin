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
import { i18n } from '../utils/i18n.js';

const log = logger.create('SettingsPage');

class SettingsPage extends Page {
    constructor() {
        super();
        this.title = i18n.t('Settings');
        this.activeTab = 'appearance'; // Default tab
    }

    render() {
        const tabs = [
            {
                id: 'appearance',
                label: i18n.t('Display'),
                icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="13.5" cy="6.5" r="2.5"/><path d="M20.38 10.32a.86.86 0 0 0-.25-.43l-1.62-1.66c-.46-.46-1.12-.58-1.57-.28l-.34.23c-.56.37-1.32.17-1.56-.46l-.16-.62c-.17-.67-.78-1.1-1.47-1.1H13c-.69 0-1.3.43-1.47 1.1l-.16.62c-.24.63-.99.83-1.56.46l-.33-.23c-.46-.3-1.12-.18-1.57.28L6.29 9.89a.86.86 0 0 0-.25.43 3.99 3.99 0 0 0 4.6 5.56l.32-.09c.64-.18 1.22.25 1.34.9l.06.33c.12.63.74 1.08 1.4.98l.61-.1c.64-.1.97-.78.7-1.37l-.2-.43c-.27-.6.03-1.32.64-1.52l.27-.09a4.01 4.01 0 0 0 3.6-4.17Z"/><path d="M2 22h20"/></svg>'
            },
            {
                id: 'player',
                label: i18n.t('Playback'),
                icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>'
            },
            {
                id: 'subtitles',
                label: i18n.t('Subtitles'),
                icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M7 15h4M15 15h2M7 11h2M13 11h4"/></svg>'
            },
            {
                id: 'account',
                label: i18n.t('Account'),
                icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>'
            },
            {
                id: 'about',
                label: i18n.t('About'),
                icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'
            },
            {
                id: 'debug',
                label: i18n.t('Debug'),
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
                            <h2 data-i18n="Settings">Settings</h2>
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
                <h2 class="content-title" data-i18n="Display">Display</h2>

                <!-- Theme Section -->
                <h3 class="setting-section-title" data-i18n="ColorTheme">Theme</h3>
                
                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="LayoutMode">Layout Mode</span>
                        <span class="setting-description" data-i18n="LayoutModeDescription">Choose optimized layout for your screen</span>
                    </div>
                    <div class="setting-control">
                        <button class="btn btn-option layout-btn ${currentLayout === 'classic' ? 'active' : ''}" data-layout="classic" tabindex="0">Classic</button>
                        <button class="btn btn-option layout-btn ${currentLayout === 'modern' ? 'active' : ''}" data-layout="modern" tabindex="-1" disabled>Modern (later)</button>
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="ColorTheme">Color Theme</span>
                        <span class="setting-description" data-i18n="ColorThemeDescription">Select your preferred color scheme</span>
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

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="AppFont">App Font</span>
                        <span class="setting-description" data-i18n="AppFontDescription">Select global font style</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'ui-font-select',
                            [
                                { value: 'poppins', label: i18n.t('ModernPoppins') },
                                { value: 'system', label: i18n.t('DefaultTizenSans') },
                                { value: 'noto-arabic', label: i18n.t('ArabicNotoSans') },
                                { value: 'typewriter', label: i18n.t('Typewriter') },
                                { value: 'print', label: i18n.t('Print') },
                                { value: 'console', label: i18n.t('Console') },
                                { value: 'cursive', label: i18n.t('Cursive') },
                                { value: 'casual', label: i18n.t('Casual') },
                                { value: 'smallcaps', label: i18n.t('SmallCaps') }
                            ],
                            layoutManager.getUiFont()
                        )}
                    </div>
                </div>

                <!-- Home Screen Section -->
                <h3 class="setting-section-title" data-i18n="HomeScreen">Home Screen</h3>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="HomeScreenCustomization">Home Screen Customization</span>
                        <span class="setting-description" data-i18n="HomeScreenCustomizationDescription">Hide "My Media" row from home screen</span>
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
                <h3 class="setting-section-title" data-i18n="ImageRelated">Image Related</h3>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="ImageQuality">Image Quality</span>
                        <span class="setting-description" data-i18n="ImageQualityDescription">Adjust for device performance (requires restart)</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'image-quality-select',
                            [
                                { value: 'low', label: i18n.t('Small') + ' (' + i18n.t('Small') + ')' }, // Placeholder for actual "Low" label if missing
                                { value: 'medium', label: i18n.t('Medium') },
                                { value: 'high', label: i18n.t('High') || 'High' },
                                { value: 'ultra', label: i18n.t('ExtraLarge') || 'Ultra' }
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
        const currentMaxRes = PlayerSettings.get('maxResolution') || 'auto';
        const currentBitrate = PlayerSettings.get('maxBitrateInternet') || 0;
        const currentBackend = PlayerSettings.get('playerBackend') || 'auto';
        const skipForward = PlayerSettings.get('skipForwardLength') || 30000;
        const skipBack = PlayerSettings.get('skipBackLength') || 10000;

        return `
            <div class="settings-tab-content">
                <h2 class="content-title" data-i18n="VideoQuality">Video Quality</h2>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="LabelMaxVideoResolution">Max Resolution</span>
                        <span class="setting-description" data-i18n="MaxResolutionDescription">Override panel detection (Auto uses hardware APIs)</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'max-resolution-select',
                            [
                                { value: 'auto', label: i18n.t('AutoRecommended') },
                                { value: '7680x4320', label: '7680x4320 (8K)' },
                                { value: '3840x2160', label: '3840x2160 (4K)' },
                                { value: '1920x1080', label: '1920x1080 (FHD)' },
                                { value: '1280x720', label: '1280x720 (HD)' }
                            ],
                            currentMaxRes
                        )}
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="MaxStreamingBitrate">Max Streaming Bitrate</span>
                        <span class="setting-description" data-i18n="MaxStreamingBitrateDescription">Quality when streaming over internet</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'max-bitrate-select',
                            [
                                { value: 0, label: i18n.t('AutoHighQuality') },
                                { value: 120000000, label: '120 Mbps' },
                                { value: 80000000, label: '80 Mbps' },
                                { value: 60000000, label: '60 Mbps' },
                                { value: 40000000, label: '40 Mbps' },
                                { value: 30000000, label: '30 Mbps' },
                                { value: 20000000, label: '20 Mbps' },
                                { value: 15000000, label: '15 Mbps' },
                                { value: 10000000, label: '10 Mbps' },
                                { value: 8000000, label: '8 Mbps' },
                                { value: 6000000, label: '6 Mbps' },
                                { value: 4000000, label: '4 Mbps' },
                                { value: 3000000, label: '3 Mbps' },
                                { value: 2000000, label: '2 Mbps' },
                                { value: 1500000, label: '1.5 Mbps' },
                                { value: 1000000, label: '1 Mbps' },
                                { value: 750000, label: '750 Kbps' },
                                { value: 500000, label: '500 Kbps' }
                            ],
                            currentBitrate
                        )}
                    </div>
                </div>

                <h3 class="setting-section-title" data-i18n="PlaybackBehavior">Playback Behavior</h3>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="LabelAudioLanguagePreference">Preferred Audio Language</span>
                        <span class="setting-description" data-i18n="PreferredAudioLanguageDescription">Default language for audio tracks</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'audio-lang-select',
                            this.languages,
                            storage.getItem('pref:audioLang') || 'Default'
                        )}
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="LabelSkipForwardLength">Skip Forward Duration</span>
                        <span class="setting-description" data-i18n="SkipForwardDurationDescription">Seconds to skip when pressing forward</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'skip-forward-select',
                            [
                                { value: 5000, label: i18n.t('Seconds', ['5']) },
                                { value: 10000, label: i18n.t('Seconds', ['10']) },
                                { value: 15000, label: i18n.t('Seconds', ['15']) },
                                { value: 30000, label: i18n.t('Seconds', ['30']) },
                                { value: 60000, label: i18n.t('Seconds', ['60']) }
                            ],
                            skipForward
                        )}
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="LabelSkipBackLength">Skip Back Duration</span>
                        <span class="setting-description" data-i18n="SkipBackDurationDescription">Seconds to skip when pressing back</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'skip-back-select',
                            [
                                { value: 5000, label: i18n.t('Seconds', ['5']) },
                                { value: 10000, label: i18n.t('Seconds', ['10']) },
                                { value: 15000, label: i18n.t('Seconds', ['15']) },
                                { value: 30000, label: i18n.t('Seconds', ['30']) },
                                { value: 60000, label: i18n.t('Seconds', ['60']) }
                            ],
                            skipBack
                        )}
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="PlayNextEpisodeAutomatically">Auto-play Next Episode</span>
                        <span class="setting-description" data-i18n="AutoPlayNextDescription">Automatically play next episode when current ends</span>
                    </div>
                    <div class="setting-control">
                        <button class="toggle-switch ${PlayerSettings.get('enableNextEpisodeAutoPlay') ? 'active' : ''}" 
                                id="toggle-auto-next" 
                                tabindex="0">
                        </button>
                    </div>
                </div>

                <h3 class="setting-section-title" data-i18n="PlaybackCompatibility">Playback Compatibility</h3>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="PlayerBackend">Player Backend</span>
                        <span class="setting-description" data-i18n="PlayerBackendDescription">Manually select playback engine (Restart required)</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'player-backend-select',
                            [
                                { value: 'auto', label: i18n.t('AutoRecommended') },
                                { value: 'web', label: 'Web (Standard)' },
                                { value: 'tizen', label: 'Native (Tizen)' }
                            ],
                            currentBackend
                        )}
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name">Enable HEVC (H.265)</span>
                        <span class="setting-description" data-i18n="HEVCDescription">Direct play HEVC content (supported on all Tizen 4+ TVs)</span>
                    </div>
                    <div class="setting-control">
                        <button class="toggle-switch ${PlayerSettings.get('enableH265') ? 'active' : ''}" 
                                id="toggle-enable-hevc" 
                                data-setting="enableH265"
                                tabindex="0">
                        </button>
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name">Enable HDR (High Dynamic Range)</span>
                        <span class="setting-description" data-i18n="HDRDescription">Pass HDR content to the display without transcoding</span>
                    </div>
                    <div class="setting-control">
                        <button class="toggle-switch ${PlayerSettings.get('enableHDR') ? 'active' : ''}" 
                                id="toggle-enable-hdr" 
                                data-setting="enableHDR"
                                tabindex="0">
                        </button>
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name">Enable Dolby Vision</span>
                        <span class="setting-description" data-i18n="DolbyVisionDescription">Enable DV if your TV supports it (auto-detected)</span>
                    </div>
                    <div class="setting-control">
                        <button class="toggle-switch ${PlayerSettings.get('enableDV') ? 'active' : ''}" 
                                id="toggle-enable-dv" 
                                data-setting="enableDV"
                                tabindex="0">
                        </button>
                    </div>
                </div>

                <h3 class="setting-section-title" data-i18n="AdvancedCodecSettings">Advanced Codec Settings</h3>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name">Enable AV1 Decode</span>
                        <span class="setting-description" data-i18n="AV1Description">Direct play AV1 content (requires Tizen 5.5+ / 2020+ TV)</span>
                    </div>
                    <div class="setting-control">
                        <button class="toggle-switch ${PlayerSettings.get('enableAV1') ? 'active' : ''}" 
                                id="toggle-enable-av1" 
                                data-setting="enableAV1"
                                tabindex="0">
                        </button>
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name">Enable VP9 Decode</span>
                        <span class="setting-description" data-i18n="VP9Description">Direct play VP9 content (WebM, YouTube-style files)</span>
                    </div>
                    <div class="setting-control">
                        <button class="toggle-switch ${PlayerSettings.get('enableVP9') ? 'active' : ''}" 
                                id="toggle-enable-vp9" 
                                data-setting="enableVP9"
                                tabindex="0">
                        </button>
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="DTSPassthrough">DTS Passthrough</span>
                        <span class="setting-description" data-i18n="DTSPassthroughDescription">⚠ Samsung TVs do NOT decode DTS — only enable with external audio</span>
                    </div>
                    <div class="setting-control">
                        <button class="toggle-switch ${PlayerSettings.get('enableDTS') ? 'active' : ''}" 
                                id="toggle-enable-dts" 
                                data-setting="enableDTS"
                                tabindex="0">
                        </button>
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="TrueHDPassthrough">TrueHD Passthrough</span>
                        <span class="setting-description" data-i18n="TrueHDPassthroughDescription">⚠ Not in Samsung specs — only enable with external audio</span>
                    </div>
                    <div class="setting-control">
                        <button class="toggle-switch ${PlayerSettings.get('enableTrueHD') ? 'active' : ''}" 
                                id="toggle-enable-truehd" 
                                data-setting="enableTrueHD"
                                tabindex="0">
                        </button>
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="ForceTranscode">Force Transcode</span>
                        <span class="setting-description" data-i18n="ForceTranscodeDescription">⚠ Emergency fallback — forces ALL content to transcode via HLS</span>
                    </div>
                    <div class="setting-control">
                        <button class="toggle-switch ${PlayerSettings.get('forceTranscode') ? 'active' : ''}" 
                                id="toggle-force-transcode" 
                                data-setting="forceTranscode"
                                tabindex="0">
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
                <h2 class="content-title" data-i18n="Subtitles">Subtitles</h2>
                
                <!-- Subtitle Behavior Section -->
                <h3 class="setting-section-title" data-i18n="Behavior">Behavior</h3>
                
                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="LabelPreferredSubtitleLanguage">Preferred Subtitle Language</span>
                        <span class="setting-description" data-i18n="PreferredSubtitleLanguageDescription">Default language for subtitles</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'subtitle-lang-select',
                            [
                                { value: 'none', label: i18n.t('None') },
                                { value: 'eng', label: i18n.t('English') },
                                { value: 'ara', label: i18n.t('Arabic') },
                                { value: 'spa', label: i18n.t('Spanish') },
                                { value: 'fre', label: i18n.t('French') },
                                { value: 'jpn', label: i18n.t('Japanese') },
                                { value: 'kor', label: i18n.t('Korean') }
                            ],
                            storage.getItem('pref:subtitleLang') || 'none'
                        )}
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="LabelSubtitlePlaybackMode">Subtitle Mode</span>
                        <span class="setting-description" data-i18n="SubtitleModeDescription">When to show subtitles automatically</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'subtitle-mode-select',
                            [
                                { value: 'Default', label: i18n.t('DefaultServerPreference') },
                                { value: 'Smart', label: i18n.t('SmartForeignAudioOnly') },
                                { value: 'OnlyForced', label: i18n.t('OnlyForced') },
                                { value: 'Always', label: i18n.t('Always') },
                                { value: 'None', label: i18n.t('None') }
                            ],
                            PlayerSettings.get('subtitleMode')
                        )}
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="SubtitleDelivery">Subtitle Delivery</span>
                        <span class="setting-description" data-i18n="SubtitleDeliveryDescription">How subtitles are delivered during video playback</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'subtitle-burn-in-select',
                            [
                                { value: '', label: i18n.t('ClientRendersRecommended') },
                                { value: 'allcomplex', label: i18n.t('AutoComplexFormatsOnly') },
                                { value: 'all', label: i18n.t('AlwaysBurnIn') }
                            ],
                            PlayerSettings.get('subtitleBurnIn') || ''
                        )}
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="DisableAssRendering">Disable ASS/SSA Rendering</span>
                        <span class="setting-description" data-i18n="DisableAssRenderingDescription">Disable ASS/SSA styling (converts to text)</span>
                    </div>
                    <div class="setting-control">
                         <button class="toggle-switch ${PlayerSettings.get('disableAssStyling') ? 'active' : ''}" 
                                 id="subtitle-force-text-toggle" 
                                 data-setting="disableAssStyling"
                                 tabindex="0">
                        </button>
                    </div>
                </div>

                <!-- Subtitle Appearance Section -->
                <h3 class="setting-section-title" data-i18n="HeaderSubtitleAppearance">Appearance</h3>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="AppFont">Font Family</span>
                        <span class="setting-description" data-i18n="AppFontDescription">Subtitle font style</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'subtitle-font-select',
                            [
                                { value: '', label: i18n.t('DefaultTizenSans') },
                                { value: 'poppins', label: i18n.t('ModernPoppins') },
                                { value: 'noto-arabic', label: i18n.t('ArabicNotoSans') },
                                { value: 'typewriter', label: i18n.t('Typewriter') },
                                { value: 'print', label: i18n.t('Print') },
                                { value: 'console', label: i18n.t('Console') },
                                { value: 'cursive', label: i18n.t('Cursive') },
                                { value: 'casual', label: i18n.t('Casual') },
                                { value: 'smallcaps', label: i18n.t('SmallCaps') }
                            ],
                            PlayerSettings.get('subtitleFont')
                        )}
                    </div>
                </div>
                
                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="LabelTextSize">Text Size</span>
                        <span class="setting-description" data-i18n="TextSizeDescription">Subtitle text size</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'subtitle-size-select',
                            [
                                { value: 'small', label: i18n.t('Small') },
                                { value: 'medium', label: i18n.t('Medium') },
                                { value: 'large', label: i18n.t('Large') },
                                { value: 'larger', label: i18n.t('Larger') },
                                { value: 'extralarge', label: i18n.t('ExtraLarge') },
                                { value: 'custom', label: i18n.t('Custom') }
                            ],
                            PlayerSettings.get('subtitleSize')
                        )}
                    </div>
                </div>

                <div class="setting-item" id="subtitle-custom-size-container" style="display: ${PlayerSettings.get('subtitleSize') === 'custom' ? '' : 'none'}">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="CustomSize">Custom Size (vh)</span>
                        <span class="setting-description">Manually adjust subtitle size</span>
                    </div>
                    <div class="setting-control slider-control">
                        ${this._renderSlider(
                            'subtitle-custom-size',
                            PlayerSettings.get('subtitleSizeCustomValue'),
                            1,
                            20,
                            1
                        )}
                    </div>
                </div>

                  <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="LabelSubtitleVerticalPosition">Vertical Position</span>
                        <span class="setting-description" data-i18n="VerticalPositionDescription">Subtitle vertical position</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'subtitle-position-select',
                            [
                                { value: '-1', label: i18n.t('BottomLow') },
                                { value: '-2', label: i18n.t('BottomStandard') },
                                { value: '-5', label: i18n.t('BottomHigh') },
                                { value: '0', label: i18n.t('Top') },
                                { value: '2', label: i18n.t('TopLow') },
                                { value: 'custom', label: i18n.t('CustomAbsolute') }
                            ],
                            String(PlayerSettings.get('subtitleVerticalPosition'))
                        )}
                    </div>
                </div>

                <div class="setting-item" id="subtitle-custom-pos-container">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="AbsolutePosition">Absolute Position %</span>
                        <span class="setting-description" data-i18n="AbsolutePositionDescription">Distance from bottom (0-100%)</span>
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
                        <span class="setting-name" data-i18n="LabelTextWeight">Font Weight</span>
                        <span class="setting-description" data-i18n="FontWeightDescription">Subtitle text thickness</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'subtitle-weight-select',
                            [
                                { value: 'normal', label: i18n.t('Normal') },
                                { value: 'bold', label: i18n.t('Bold') }
                            ],
                            PlayerSettings.get('subtitleWeight') || 'normal'
                        )}
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="LabelTextColor">Text Color</span>
                        <span class="setting-description" data-i18n="TextColorDescription">Subtitle text color</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'subtitle-color-select',
                            [
                                { value: '#ffffff', label: i18n.t('SubtitleWhite') },
                                { value: '#d3d3d3', label: i18n.t('LightGrey') },
                                { value: '#a9a9a9', label: i18n.t('DarkGrey') },
                                { value: '#000000', label: i18n.t('SubtitleBlack') },
                                { value: '#ffff00', label: i18n.t('SubtitleYellow') },
                                { value: '#00ffff', label: i18n.t('SubtitleCyan') },
                                { value: '#0000ff', label: i18n.t('SubtitleBlue') }
                            ],
                            PlayerSettings.get('subtitleTextColor') || '#ffffff'
                        )}
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="TextOpacity">Text Opacity</span>
                        <span class="setting-description" data-i18n="TextOpacityDescription">Subtitle text transparency</span>
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
                        <span class="setting-name" data-i18n="BackgroundColor">Background Color</span>
                        <span class="setting-description" data-i18n="BackgroundColorDescription">Subtitle background color</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'subtitle-bg-select',
                            [
                                { value: 'transparent', label: i18n.t('None') },
                                { value: '#000000', label: i18n.t('SubtitleBlack') },
                                { value: '#ffffff', label: i18n.t('SubtitleWhite') },
                                { value: '#d3d3d3', label: i18n.t('LightGrey') },
                                { value: '#a9a9a9', label: i18n.t('DarkGrey') },
                                { value: '#ffff00', label: i18n.t('SubtitleYellow') },
                                { value: '#00ffff', label: i18n.t('SubtitleCyan') },
                                { value: '#0000ff', label: i18n.t('SubtitleBlue') }
                            ],
                            PlayerSettings.get('subtitleTextBackground')
                        )}
                    </div>
                </div>

                <div class="setting-item" id="subtitle-bg-opacity-container">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="BackgroundOpacity">Background Opacity</span>
                        <span class="setting-description" data-i18n="BackgroundOpacityDescription">Subtitle background transparency</span>
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
                        <span class="setting-name" data-i18n="TextShadowStyle">Text Shadow Style</span>
                        <span class="setting-description" data-i18n="TextShadowStyleDescription">Subtitle shadow type</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'subtitle-shadow-select',
                            [
                                { value: 'none', label: i18n.t('None') },
                                { value: 'uniform', label: i18n.t('Uniform') },
                                { value: 'border', label: i18n.t('Border') },
                                { value: 'dropshadow', label: i18n.t('DropShadow') },
                                { value: 'raised', label: i18n.t('Raised') },
                                { value: 'depressed', label: i18n.t('Depressed') }
                            ],
                            PlayerSettings.get('subtitleDropShadow')
                        )}
                    </div>
                </div>

                <div class="setting-item" id="subtitle-border-width-container" style="display: ${PlayerSettings.get('subtitleDropShadow') === 'border' ? '' : 'none'}">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="BorderWidth">Border Width</span>
                        <span class="setting-description" data-i18n="BorderWidthDescription">Width of the sharp text border</span>
                    </div>
                    <div class="setting-control slider-control">
                        ${this._renderSlider(
                            'subtitle-border-width',
                            PlayerSettings.get('subtitleBorderWidth'),
                            1,
                            20,
                            1
                        )}
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="ShadowColor">Shadow Color</span>
                        <span class="setting-description" data-i18n="ShadowColorDescription">Color of the drop shadow</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'subtitle-shadow-color-select',
                            [
                                { value: '#000000', label: i18n.t('SubtitleBlack') },
                                { value: '#ffffff', label: i18n.t('SubtitleWhite') },
                                { value: '#ff0000', label: i18n.t('SubtitleRed') },
                                { value: '#00ff00', label: i18n.t('SubtitleGreen') },
                                { value: '#0000ff', label: i18n.t('SubtitleBlue') },
                                { value: '#ffff00', label: i18n.t('SubtitleYellow') },
                                { value: '#00ffff', label: i18n.t('SubtitleCyan') },
                                { value: '#ff00ff', label: i18n.t('SubtitleMagenta') },
                                { value: '#808080', label: i18n.t('Grey') }
                            ],
                            PlayerSettings.get('subtitleDropShadowColor') || '#000000'
                        )}
                    </div>
                </div>

                <div class="setting-item" id="subtitle-shadow-opacity-container" style="display: ${!PlayerSettings.get('subtitleDropShadow') || PlayerSettings.get('subtitleDropShadow') === 'none' || PlayerSettings.get('subtitleDropShadow') === 'border' ? 'none' : ''}">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="ShadowOpacity">Shadow Opacity</span>
                        <span class="setting-description" data-i18n="ShadowOpacityDescription">Opacity of the drop shadow</span>
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

                <!-- Advanced ASS Settings -->
                <h3 class="setting-section-title" data-i18n="AdvancedAssSettings">Advanced ASS Settings</h3>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="AssFontFamily">Font Family (ASS)</span>
                        <span class="setting-description" data-i18n="FontFamilyAssDescription">Force overrides font for ASS/SSA subs</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'subtitle-font-ass-select',
                            [
                                { value: '', label: i18n.t('DefaultTizenSans') },
                                { value: 'poppins', label: i18n.t('ModernPoppins') },
                                { value: 'noto-arabic', label: i18n.t('ArabicNotoSans') },
                                { value: 'typewriter', label: i18n.t('Typewriter') },
                                { value: 'print', label: i18n.t('Print') },
                                { value: 'console', label: i18n.t('Console') },
                                { value: 'cursive', label: i18n.t('Cursive') },
                                { value: 'casual', label: i18n.t('Casual') },
                                { value: 'smallcaps', label: i18n.t('SmallCaps') }
                            ],
                            PlayerSettings.get('subtitleFontAss')
                        )}
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="FontScaleAss">Font Scale (ASS)</span>
                        <span class="setting-description" data-i18n="FontScaleAssDescription">Vertical/Horizontal scaling booster</span>
                    </div>
                    <div class="setting-control slider-control">
                        ${this._renderSlider(
                            'subtitle-font-scale',
                            PlayerSettings.get('subtitleFontScale') ?? 1,
                            0.5,
                            3,
                            0.1,
                            'x'
                        )}
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="VerticalPositionAss">Vertical Position (ASS)</span>
                        <span class="setting-description" data-i18n="VerticalPositionAssDescription">Main track bottom offset</span>
                    </div>
                    <div class="setting-control slider-control">
                        ${this._renderSlider(
                            'subtitle-bottom-offset',
                            PlayerSettings.get('subtitleBottomOffset') ?? 0,
                            -100,
                            750,
                            5,
                            'px'
                        )}
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="OutlineThicknessAss">Outline Thickness (ASS)</span>
                        <span class="setting-description" data-i18n="OutlineThicknessAssDescription">Text border stroke width</span>
                    </div>
                    <div class="setting-control slider-control">
                        ${this._renderSlider(
                            'subtitle-outline-thickness',
                            PlayerSettings.get('subtitleOutlineThickness') ?? 0.4,
                            0,
                            5,
                            0.1,
                            ''
                        )}
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="ShadowThicknessAss">Shadow Thickness (ASS)</span>
                        <span class="setting-description" data-i18n="ShadowThicknessAssDescription">Text shadow depth</span>
                    </div>
                    <div class="setting-control slider-control">
                        ${this._renderSlider(
                            'subtitle-shadow-thickness',
                            PlayerSettings.get('subtitleShadowThickness') ?? 0.3,
                            0,
                            5,
                            0.1,
                            ''
                        )}
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="VerticalSpacingAss">Vertical Spacing (ASS)</span>
                        <span class="setting-description" data-i18n="VerticalSpacingAssDescription">Adjust gap between lines</span>
                    </div>
                    <div class="setting-control slider-control">
                        ${this._renderSlider(
                            'subtitle-line-height',
                            PlayerSettings.get('subtitleLineHeight') ?? 0,
                            -50,
                            50,
                            1,
                            'px'
                        )}
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="HorizontalSpacingAss">Horizontal Spacing (ASS)</span>
                        <span class="setting-description" data-i18n="HorizontalSpacingAssDescription">Adjust gap between characters</span>
                    </div>
                    <div class="setting-control slider-control">
                        ${this._renderSlider(
                            'subtitle-letter-spacing',
                            PlayerSettings.get('subtitleLetterSpacing') ?? 0,
                            -20,
                            40,
                            0.5,
                            'px'
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
                <h2 class="content-title" data-i18n="Account">${i18n.t('Account')}</h2>
                
                <div class="user-profile-card">
                    <div class="user-avatar-wrapper">
                         ${this._renderUserAvatar(user)}
                    </div>
                    <h3 class="user-name-large">${user?.Name || i18n.t('Guest')}</h3>
                    <p class="server-url-display">${serverUrl || i18n.t('Offline')}</p>
                </div>

                <div class="setting-actions centered">
                    <button class="btn btn-danger switch-user-btn focusable" tabindex="0" data-i18n="ButtonSignOut">
                        ${i18n.t('ButtonSignOut')}
                    </button>
                </div>
            </div>
        `;
    }

    _renderAboutTab() {
        const caps = getDeviceCapabilities();

        return `
            <div class="settings-tab-content">
                <h2 class="content-title" data-i18n="AboutLitefin">${i18n.t('AboutLitefin')}</h2>
                
                <div class="about-card" tabindex="0">
                    <h3 class="app-version">${i18n.t('AppVersion', __APP_VERSION__)}</h3>
                    <p class="about-desc" data-i18n="AppDescription">
                        ${i18n.t('AppDescription')}
                    </p>
                    <p class="about-credits" data-i18n="DevelopedBy">${i18n.t('DevelopedBy')}</p>
                </div>

                <h3 class="setting-section-title" data-i18n="DeviceInformation">${i18n.t('DeviceInformation')}</h3>
                <div class="about-card identity-card" tabindex="0">
                    <div class="identity-grid">
                        <div class="identity-item">
                            <span class="identity-label" data-i18n="Model">${i18n.t('Model')}</span>
                            <span class="identity-value">${caps.modelName}</span>
                        </div>
                        <div class="identity-item">
                            <span class="identity-label" data-i18n="Platform">${i18n.t('Platform')}</span>
                            <span class="identity-value">Tizen ${caps.tizenVersion}</span>
                        </div>
                        <div class="identity-item">
                            <span class="identity-label" data-i18n="Resolution">${i18n.t('Resolution')}</span>
                            <span class="identity-value">${caps.screenWidth}x${caps.screenHeight} (${caps.uhd8K ? '8K' : caps.uhd ? '4K' : 'FHD'})</span>
                        </div>
                        <div class="identity-item">
                            <span class="identity-label" data-i18n="HDRSupport">${i18n.t('HDRSupport')}</span>
                            <span class="identity-value">${
                                [
                                    caps.hdr10 ? 'HDR10' : null,
                                    caps.hdr10Plus ? 'HDR10+' : null,
                                    caps.hlg ? 'HLG' : null,
                                    caps.dolbyVision ? 'Dolby Vision' : null
                                ]
                                    .filter(Boolean)
                                    .join(', ') || i18n.t('SDROnly')
                            }</span>
                        </div>
                        <div class="identity-item">
                            <span class="identity-label" data-i18n="VideoCodecs">${i18n.t('VideoCodecs')}</span>
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
                <h2 class="content-title" data-i18n="Debug">${i18n.t('Debug')}</h2>

                <!-- Logging Section -->
                <h3 class="setting-section-title" data-i18n="Logging">${i18n.t('Logging')}</h3>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="EnableDebugLogs">${i18n.t('EnableDebugLogs')}</span>
                        <span class="setting-description" data-i18n="EnableDebugLogsDescription">${i18n.t('EnableDebugLogsDescription')}</span>
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
                        <span class="setting-name" data-i18n="ShowDebugOverlay">${i18n.t('ShowDebugOverlay')}</span>
                        <span class="setting-description" data-i18n="ShowDebugOverlayDescription">${i18n.t('ShowDebugOverlayDescription')}</span>
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
                        <span class="setting-name" data-i18n="UploadLogs">${i18n.t('UploadLogs')}</span>
                        <span class="setting-description" data-i18n="UploadLogsDescription">${i18n.t('UploadLogsDescription')}</span>
                    </div>
                    <div class="setting-control">
                        <button class="btn btn-option" id="btn-upload-logs" tabindex="0" style="width: auto; min-width: 120px;" data-i18n="Upload">
                            ${i18n.t('Upload')}
                        </button>
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="OverlayWidth">${i18n.t('OverlayWidth')}</span>
                        <span class="setting-description" data-i18n="OverlayWidthDescription">${i18n.t('OverlayWidthDescription')}</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'debug-width-select',
                            [
                                { value: 'small', label: i18n.t('Small') },
                                { value: 'medium', label: i18n.t('Medium') },
                                { value: 'large', label: i18n.t('Large') },
                                { value: 'full', label: i18n.t('FullScreen') }
                            ],
                            debugOverlay.Width || 'small'
                        )}
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="OverlayHeight">${i18n.t('OverlayHeight')}</span>
                        <span class="setting-description" data-i18n="OverlayHeightDescription">${i18n.t('OverlayHeightDescription')}</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'debug-height-select',
                            [
                                { value: 'small', label: i18n.t('Small') },
                                { value: 'medium', label: i18n.t('Medium') },
                                { value: 'large', label: i18n.t('Large') },
                                { value: 'full', label: i18n.t('FullScreen') }
                            ],
                            debugOverlay.Height || 'small'
                        )}
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="OverlayPosition">${i18n.t('OverlayPosition')}</span>
                        <span class="setting-description" data-i18n="OverlayPositionDescription">${i18n.t('OverlayPositionDescription')}</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'debug-position-select',
                            [
                                { value: 'top-left', label: i18n.t('TopLeft') },
                                { value: 'top-right', label: i18n.t('TopRight') },
                                { value: 'bottom-left', label: i18n.t('BottomLeft') },
                                { value: 'bottom-right', label: i18n.t('BottomRight') }
                            ],
                            debugOverlay.Position || 'bottom-right'
                        )}
                    </div>
                </div>

                <!-- Module Filters -->
                <h3 class="setting-section-title" data-i18n="ModuleFilters">${i18n.t('ModuleFilters')}</h3>
                <div class="module-filters-grid">
                    <div class="setting-item compact">
                        <div class="setting-label">
                            <span class="setting-name" data-i18n="EnableAllFilters">${i18n.t('EnableAllFilters')}</span>
                        </div>
                        <div class="setting-control">
                            <button class="btn btn-option" id="btn-enable-all-filters" tabindex="0" style="width: auto; min-width: 100px;" data-i18n="Enable">
                                ${i18n.t('Enable')}
                            </button>
                        </div>
                    </div>
                    <div class="setting-item compact">
                        <div class="setting-label">
                            <span class="setting-name" data-i18n="DisableAllFilters">${i18n.t('DisableAllFilters')}</span>
                        </div>
                        <div class="setting-control">
                            <button class="btn btn-option" id="btn-disable-all-filters" tabindex="0" style="width: auto; min-width: 100px;" data-i18n="Disable">
                                ${i18n.t('Disable')}
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
                uploadLogsBtn.textContent = i18n.t('Uploading');

                try {
                    const logs = debugOverlay.getLogDump();
                    if (!logs) {
                        throw new Error('No logs to upload');
                    }

                    const filename = `Litefin_Log_${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;

                    // Attempt upload
                    await api.uploadClientLog(filename, logs);

                    // Success feedback
                    uploadLogsBtn.textContent = i18n.t('Success');
                    setTimeout(() => {
                        uploadLogsBtn.disabled = false;
                        uploadLogsBtn.textContent = i18n.t('Upload');
                    }, 2000);
                } catch (error) {
                    log.error('Failed to upload logs:', error);
                    uploadLogsBtn.textContent = i18n.t('Failed');
                    // Re-enable after delay
                    setTimeout(() => {
                        uploadLogsBtn.disabled = false;
                        uploadLogsBtn.textContent = i18n.t('Upload');
                    }, 2000);

                    // Show error toast if we had one, but button text update is good for now
                }
            });
        }
    }

    _renderSlider(id, value, min, max, step, unit = '%') {
        const percent = ((value - min) / (max - min)) * 100;

        return `
            <div class="slider-wrapper">
                <div class="slider-container">
                    <div class="slider-track">
                        <div class="slider-fill" style="width: ${percent}%"></div>
                    </div>
                    <input type="range" 
                        id="${id}" 
                        class="setting-slider focusable" 
                        min="${min}" 
                        max="${max}" 
                        step="${step}" 
                        value="${value}"
                        data-unit="${unit}"
                        tabindex="0">
                </div>
                <span class="slider-value" id="${id}-value">${value}${unit}</span>
            </div>
        `;
    }

    _bindSliderEvents() {
        const sliderMap = {
            'subtitle-text-opacity': 'subtitleTextOpacity',
            'subtitle-bg-opacity': 'subtitleBackgroundOpacity',
            'subtitle-shadow-opacity': 'subtitleDropShadowOpacity',
            'subtitle-shadow-blur': 'subtitleDropShadowBlur',
            'subtitle-custom-pos': 'subtitleVerticalPositionCustom',
            'subtitle-font-scale': 'subtitleFontScale',
            'subtitle-outline-thickness': 'subtitleOutlineThickness',
            'subtitle-shadow-thickness': 'subtitleShadowThickness',
            'subtitle-line-height': 'subtitleLineHeight',
            'subtitle-letter-spacing': 'subtitleLetterSpacing',
            'subtitle-bottom-offset': 'subtitleBottomOffset'
        };

        this.$$('.setting-slider').forEach((slider) => {
            slider.addEventListener('input', (e) => {
                const id = slider.id;
                const value = e.target.value;
                const key = sliderMap[id];
                const unit = slider.dataset.unit || '%';

                // Update value display
                const valueDisplay = this.$(`#${id}-value`);
                if (valueDisplay) {
                    valueDisplay.textContent = `${value}${unit}`;
                }

                // Update slider fill visual
                const percent = ((value - slider.min) / (slider.max - slider.min)) * 100;
                const container = slider.closest('.slider-container');
                if (container) {
                    const track = container.querySelector('.slider-track');
                    const fill = container.querySelector('.slider-fill');
                    if (track) track.style.setProperty('--progress', `${percent}%`);
                    if (fill) fill.style.width = `${percent}%`;
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
            const container = slider.closest('.slider-container');
            if (container) {
                const track = container.querySelector('.slider-track');
                const fill = container.querySelector('.slider-fill');
                if (track) track.style.setProperty('--progress', `${percent}%`);
                if (fill) fill.style.width = `${percent}%`;
            }
        });
    }

    _renderDropdown(id, options, currentValue) {
        // Find current label
        const currentOption = options.find((o) => o.value === currentValue) || options[0];
        const currentLabel = currentOption ? currentOption.label : i18n.t('Select');

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
                    <button class="modal-action-btn" id="btn-modal-cancel" tabindex="0" data-i18n="ButtonCancel">${i18n.t('ButtonCancel')}</button>
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
            leaveUp: 'modal-options',
            onMove: (direction) => {
                if (direction === 'down') {
                    focusManager.setActiveSection('modal-options', true, null, { enterTo: 'first' });
                    return true;
                }
                return false;
            }
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
            'ui-font-select': { key: 'uiFont', type: 'local' },
            'image-quality-select': { key: 'imageQuality', type: 'service' },
            'max-resolution-select': { key: 'maxResolution', type: 'player' },
            'player-backend-select': { key: 'playerBackend', type: 'player' },
            'max-bitrate-select': { key: 'maxBitrateInternet', type: 'player' },
            'audio-lang-select': { key: 'pref:audioLang', type: 'local' },
            'subtitle-lang-select': { key: 'pref:subtitleLang', type: 'local' },
            'skip-forward-select': { key: 'skipForwardLength', type: 'player' },
            'skip-back-select': { key: 'skipBackLength', type: 'player' },
            'subtitle-mode-select': { key: 'subtitleMode', type: 'player' },
            // Subtitle delivery mode — drives SubtitleProfiles in DeviceProfile
            'subtitle-burn-in-select': { key: 'subtitleBurnIn', type: 'player' },
            'subtitle-size-select': { key: 'subtitleSize', type: 'player' },
            'subtitle-weight-select': { key: 'subtitleWeight', type: 'player' },
            'subtitle-font-select': { key: 'subtitleFont', type: 'player' },
            'subtitle-font-ass-select': { key: 'subtitleFontAss', type: 'player' },
            'subtitle-color-select': { key: 'subtitleTextColor', type: 'player' },
            'subtitle-shadow-select': { key: 'subtitleDropShadow', type: 'player' },
            'subtitle-shadow-color-select': { key: 'subtitleDropShadowColor', type: 'player' },
            'subtitle-bg-select': { key: 'subtitleTextBackground', type: 'player' },
            'subtitle-position-select': { key: 'subtitleVerticalPosition', type: 'player' },
            'subtitle-custom-size': { key: 'subtitleSizeCustomValue', type: 'player' },
            'subtitle-border-width': { key: 'subtitleBorderWidth', type: 'player' },
            'subtitle-font-scale': { key: 'subtitleFontScale', type: 'player' },
            'subtitle-outline-thickness': { key: 'subtitleOutlineThickness', type: 'player' },
            'subtitle-shadow-thickness': { key: 'subtitleShadowThickness', type: 'player' },
            'subtitle-line-height': { key: 'subtitleLineHeight', type: 'player' },
            'subtitle-letter-spacing': { key: 'subtitleLetterSpacing', type: 'player' },
            'subtitle-bottom-offset': { key: 'subtitleBottomOffset', type: 'player' },
            'subtitle-force-text-toggle': { key: 'disableAssStyling', type: 'player' },
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
                    btn.closest('.setting-item')?.querySelector('.setting-name')?.textContent || i18n.t('SelectOption');

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
                        } else if (id === 'ui-font-select') {
                            // SPECIAL CASE: Font changes handled by LayoutManager
                            layoutManager.setUiFont(newValue);
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
                                    customPosContainer.style.display = newValue === 'custom' ? '' : 'none';
                                    focusManager.invalidateCache('settings-content');
                                }
                            }

                            if (id === 'subtitle-size-select') {
                                const customSizeContainer = document.getElementById('subtitle-custom-size-container');
                                if (customSizeContainer) {
                                    customSizeContainer.style.display = newValue === 'custom' ? '' : 'none';
                                    focusManager.invalidateCache('settings-content');
                                }
                            }

                            if (id === 'subtitle-shadow-select') {
                                const borderWidthContainer = document.getElementById('subtitle-border-width-container');
                                if (borderWidthContainer) {
                                    borderWidthContainer.style.display = newValue === 'border' ? '' : 'none';
                                }

                                const opacityContainer = document.getElementById('subtitle-shadow-opacity-container');
                                if (opacityContainer) {
                                    opacityContainer.style.display =
                                        newValue === 'none' || newValue === 'border' ? 'none' : '';
                                }

                                const blurContainer = document.getElementById('subtitle-shadow-blur-container');
                                if (blurContainer) {
                                    blurContainer.style.display =
                                        newValue === 'none' || newValue === 'border' ? 'none' : '';
                                }
                                focusManager.invalidateCache('settings-content');
                            }

                            // FONT LOADING: Trigger download if needed
                            if (
                                (settingConfig.key === 'subtitleFont' || settingConfig.key === 'subtitleFontAss') &&
                                newValue
                            ) {
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

        // Toggle Switch for Force Text
        const forceTextToggle = this.$('#subtitle-force-text-toggle');
        if (forceTextToggle) {
            forceTextToggle.addEventListener('click', () => {
                const currentValue = PlayerSettings.get('disableAssStyling');
                const newValue = !currentValue;
                PlayerSettings.set('disableAssStyling', newValue);
                forceTextToggle.classList.toggle('active', newValue);
                log.info(`Force Text Mode set to: ${newValue}`);
            });
        }

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
            dark: i18n.t('Dark'),
            light: i18n.t('Light'),
            blueradiance: i18n.t('BlueRadiance'),
            purplehaze: i18n.t('PurpleHaze'),
            wmc: i18n.t('WMC'),
            appletv: i18n.t('AppleTV')
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
