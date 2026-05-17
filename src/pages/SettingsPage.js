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
import { spatialNavigator } from '../ui/SpatialNavigator.js';
import { imageService } from '../utils/ImageService.js';
import { PlayerSettings } from '../utils/PlayerSettings.js';
import FontLoader from '../utils/FontLoader.js';
import { debugOverlay } from '../ui/DebugOverlay.js';
import { storage } from '../utils/StorageService.js';
import { logger } from '../utils/Logger.js';
import { i18n } from '../utils/i18n.js';
import { availableLanguages } from '../locales/languages.js';
import { pluginManager } from '../plugins/PluginManager.js';
import { platformInfo } from '../utils/PlatformInfo.js';
import { homeLayoutManager } from '../utils/HomeLayoutManager.js';
import { sidebarLayoutManager } from '../utils/SidebarLayoutManager.js';
import { eventBus } from '../core/EventBus.js';
import { versionChecker } from '../utils/VersionChecker.js';

const log = logger.create('SettingsPage');

// Cache cultures across page instances
let cachedCultures = null;

class SettingsPage extends Page {
    constructor() {
        super();
        this.title = i18n.t('Settings');
        this.activeTab = 'appearance'; // Default tab

        // UI Languages (for app interface)
        this.uiLanguages = availableLanguages;

        // Preference Languages (Audio/Subtitle) - fetched from server
        this.prefLanguages = cachedCultures || [{ value: 'Default', label: i18n.t('Default') }];
    }

    async onInit() {
        // If we don't have cultures cached, fetch them
        if (!cachedCultures) {
            try {
                const cultures = await api.getCultures();
                // Map to dropdown format and sort alphabetically by display name
                cachedCultures = cultures
                    .map((c) => ({
                        value: c.ThreeLetterISOLanguageName,
                        label: i18n.ensureBiDi(c.DisplayName)
                    }))
                    .sort((a, b) => a.label.localeCompare(b.label));

                this.prefLanguages = cachedCultures;

                // Re-render if we are on a tab that uses these languages
                if (this.activeTab === 'player' || this.activeTab === 'subtitles') {
                    this._switchTab(this.activeTab, true);
                }
            } catch (error) {
                log.error('Failed to fetch cultures:', error);
            }
        }

        this.markReady();
    }

    render() {
        const tabs = [
            {
                id: 'appearance',
                label: i18n.t('Display'),
                icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="13.5" cy="6.5" r="2.5"/><path d="M20.38 10.32a.86.86 0 0 0-.25-.43l-1.62-1.66c-.46-.46-1.12-.58-1.57-.28l-.34.23c-.56.37-1.32.17-1.56-.46l-.16-.62c-.17-.67-.78-1.1-1.47-1.1H13c-.69 0-1.3.43-1.47 1.1l-.16.62c-.24.63-.99.83-1.56.46l-.33-.23c-.46-.3-1.12-.18-1.57.28L6.29 9.89a.86.86 0 0 0-.25.43 3.99 3.99 0 0 0 4.6 5.56l.32-.09c.64-.18 1.22.25 1.34.9l.06.33c.12.63.74 1.08 1.4.98l.61-.1c.64-.1.97-.78.7-1.37l-.2-.43c-.27-.6.03-1.32.64-1.52l.27-.09a4.01 4.01 0 0 0 3.6-4.17Z"/><path d="M2 22h20"/></svg>'
            },
            {
                id: 'home',
                label: i18n.t('Home') || 'Home',
                icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>'
            },
            {
                id: 'sidebar',
                label: i18n.t('Sidebar') || 'Sidebar',
                icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="9" y1="3" x2="9" y2="21"/></svg>'
            },
            {
                id: 'player',
                label: i18n.t('TitlePlayback'),
                icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>'
            },
            {
                id: 'subtitles',
                label: i18n.t('Subtitles'),
                icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M7 15h4M15 15h2M7 11h2M13 11h4"/></svg>'
            },
            {
                id: 'plugins',
                label: i18n.t('Plugins'),
                icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5l6.74-6.76z"/><line x1="16" y1="8" x2="2" y2="22"/><line x1="17" y1="15" x2="9" y2="15"/></svg>'
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
                            <h2 data-i18n="Settings">${i18n.t('Settings')}</h2>
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
            case 'home':
                return this._renderHomeTab();
            case 'sidebar':
                return this._renderSidebarTab();
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
            case 'plugins':
                return this._renderPluginsTab();
            default:
                return this._renderAppearanceTab();
        }
    }

    _renderPluginsTab() {
        /* Get the live list from the PluginManager.
           Each entry: { id, name, version, description, serverDependency, enabled, dependencyDeferred } */
        const plugins = pluginManager.getPluginList();

        // Helper: build a human-readable status badge for a plugin entry
        const statusBadge = (p) => {
            if (!p.enabled && !p.dependencyDeferred) {
                // Disabled either by user choice or missing server plugin
                return `<span class="plugin-status plugin-status--disabled">${i18n.t('Disabled')}</span>`;
            }
            if (p.dependencyDeferred) {
                // Server dependency hasn't been probed yet (non-admin first boot)
                return `<span class="plugin-status plugin-status--pending">${i18n.t('PendingVerification', ['Pending'])}</span>`;
            }
            return `<span class="plugin-status plugin-status--active">${i18n.t('Active')}</span>`;
        };

        // Build a toggle row for each plugin
        const rows = plugins
            .map(
                (p) => `
            <div class="setting-item">
                <div class="setting-label">
                    <span class="setting-name">
                        ${p.name}
                        <span class="plugin-version">v${p.version}</span>
                        ${statusBadge(p)}
                    </span>
                    ${p.description ? `<span class="setting-description">${p.description}</span>` : ''}
                    ${
                        p.serverDependency
                            ? `<span class="setting-description plugin-dep">
                               ${i18n.t('RequiresPlugin', ['Requires'])}:
                               <code>${p.serverDependency}</code>
                           </span>`
                            : ''
                    }
                </div>
                <div class="setting-control">
                    <button class="toggle-switch ${p.enabled ? 'active' : ''}"
                            data-plugin-id="${p.id}"
                            id="plugin-toggle-${p.id}"
                            tabindex="0">
                    </button>
                </div>
            </div>
        `
            )
            .join('');

        // Show a friendly empty state if no plugins are loaded
        const content =
            plugins.length > 0
                ? rows
                : `<p class="settings-empty-state">${i18n.t('NoPlugins', ['No plugins installed.'])}</p>`;

        return `
            <div class="settings-tab-content">
                <h2 class="content-title">${i18n.t('Plugins')}</h2>
                <h3 class="setting-section-title">${i18n.t('InstalledPlugins', ['Installed Plugins'])}</h3>
                ${content}
            </div>
        `;
    }

    _renderAppearanceTab() {
        return `
            <div class="settings-tab-content">
                <h2 class="content-title" data-i18n="Display">${i18n.t('Display')}</h2>

                <!-- Language Section -->
                <h3 class="setting-section-title" data-i18n="LabelLanguage">${i18n.t('LabelLanguage')}</h3>
                
                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="LabelPreferredDisplayLanguage">${i18n.t('LabelPreferredDisplayLanguage')}</span>
                        <span class="setting-description" data-i18n="AppLanguageDescription">${i18n.t('AppLanguageDescription')}</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'app-language-select',
                            this.uiLanguages,
                            storage.getItem('app_language') || 'en-us'
                        )}
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="LayoutDirection">${i18n.t('LayoutDirection')}</span>
                        <span class="setting-description" data-i18n="LayoutDirectionDescription">${i18n.t('LayoutDirectionDescription')}</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'layout-direction-select',
                            [
                                { value: 'auto', label: i18n.t('DirectionAuto', ['Auto']) },
                                { value: 'ltr', label: i18n.t('DirectionLTR', ['Left-to-Right']) },
                                { value: 'rtl', label: i18n.t('DirectionRTL', ['Right-to-Left']) }
                            ],
                            storage.getItem('layout_direction') || 'auto'
                        )}
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="AppFont">${i18n.t('AppFont')}</span>
                        <span class="setting-description" data-i18n="AppFontDescription">${i18n.t('AppFontDescription')}</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'ui-font-select',
                            [
                                { value: 'poppins', label: i18n.t('ModernPoppins') },
                                {
                                    value: 'system',
                                    label: i18n.t(platformInfo.isWebOS ? 'DefaultWebOSSans' : 'DefaultTizenSans')
                                },
                                { value: 'noto-arabic', label: i18n.t('ArabicNotoSans') },
                                { value: 'roboto', label: i18n.t('FontRoboto') },
                                { value: 'google', label: i18n.t('FontGoogleSans') },
                                { value: 'typewriter', label: i18n.t('Typewriter') },
                                { value: 'print', label: i18n.t('Print') },
                                { value: 'console', label: i18n.t('Console') },
                                { value: 'cursive', label: i18n.t('Cursive') },
                                { value: 'casual', label: i18n.t('Casual') },
                                { value: 'smallcaps', label: i18n.t('SmallCaps') },
                                { value: 'silkscreen', label: i18n.t('FontSilkscreen') || 'Silkscreen' },
                                { value: 'space-grotesk', label: i18n.t('FontSpaceGrotesk') || 'Space Grotesk' },
                                { value: 'retrotech', label: i18n.t('FontRetrotech') || 'RETROTECH' },
                                { value: 'kitty', label: i18n.t('FontKitty') || 'Kitty' },
                                { value: 'inter', label: i18n.t('FontInter') || 'Inter' },
                                { value: 'proxima', label: i18n.t('FontProxima') || 'Proxima Nova' },
                                { value: 'baloo', label: i18n.t('FontBaloo') || 'Baloo Bhaijaan 2' }
                            ],
                            layoutManager.getUiFont()
                        )}
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="TextScale">${i18n.t('TextScale') || 'Text scale'}</span>
                        <span class="setting-description" data-i18n="TextScaleDescription">${i18n.t('TextScaleDescription') || 'Adjust the size of all text and UI elements proportionally'}</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'text-scale-select',
                            [
                                { value: '0.8', label: '80%' },
                                { value: '0.85', label: '85%' },
                                { value: '0.9', label: '90%' },
                                { value: '0.95', label: '95%' },
                                { value: '1', label: 'Normal (100%)' },
                                { value: '1.05', label: '105%' },
                                { value: '1.1', label: '110%' },
                                { value: '1.15', label: '115%' },
                                { value: '1.2', label: '120%' },
                                { value: '1.25', label: '125%' },
                                { value: '1.3', label: '130%' },
                                { value: '1.35', label: '135%' },
                                { value: '1.4', label: '140%' }
                            ],
                            layoutManager.getTextScale().toString()
                        )}
                    </div>
                </div>

                <!-- Theme Section -->
                <h3 class="setting-section-title" data-i18n="ColorTheme">${i18n.t('ColorTheme')}</h3>
            
                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="ThemeMode">${i18n.t('ThemeMode') || 'Theme Mode'}</span>
                        <span class="setting-description" data-i18n="ThemeModeDescription">${i18n.t('ThemeModeDescription') || 'Choose the base visual style of the application.'}</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'theme-mode-select',
                            [
                                { value: 'tinted', label: i18n.t('ThemeTinted') || 'Tinted' },
                                { value: 'black', label: i18n.t('ThemeBlack') || 'Black (OLED)' },
                                { value: 'classic-dark', label: i18n.t('ThemeDarkClassic') || 'Dark Classic' },
                                { value: 'classic-light', label: i18n.t('ThemeLightClassic') || 'Light Classic' }
                            ],
                            layoutManager.getThemeMode()
                        )}
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="ThemeColor">${i18n.t('ThemeColor') || 'Theme Color'}</span>
                        <span class="setting-description" data-i18n="ThemeColorDescription">${i18n.t('ThemeColorDescription') || 'Choose your primary accent color.'}</span>
                    </div>
                    <div class="setting-control">
                        <div class="theme-color-grid">
                            ${this._renderColorOptions()}
                        </div>
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="RoundedCorners">${i18n.t('RoundedCorners')}</span>
                        <span class="setting-description" data-i18n="RoundedCornersDescription">${i18n.t('RoundedCornersDescription')}</span>
                    </div>
                    <div class="setting-control">
                        <button class="toggle-switch ${layoutManager.getRoundedCorners() ? 'active' : ''}" 
                                id="toggle-rounded-corners" 
                                tabindex="0">
                        </button>
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="LabelLibraryPageSize">${i18n.t('LabelLibraryPageSize') || 'Items per page (Library)'}</span>
                        <span class="setting-description" data-i18n="LibraryPageSizeDescription">${i18n.t('LibraryPageSizeDescription') || 'Choose how many items to load at once in the grid view.'}</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'library-page-size-select',
                            [
                                { value: 25, label: '25' },
                                { value: 50, label: '50' },
                                { value: 75, label: '75' },
                                { value: 100, label: '100' },
                                { value: 150, label: '150' }
                            ],
                            storage.getItem('pref:libraryPageSize') || 100
                        )}
                    </div>
                </div>

                <!-- Performance Tweaks Section -->
                <h3 class="setting-section-title" data-i18n="PerformanceTweaks">${i18n.t('PerformanceTweaks') || 'Performance Tweaks'}</h3>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="LabelLowVramMode">${i18n.t('LabelLowVramMode') || 'Low VRAM Mode'}</span>
                        <span class="setting-description" data-i18n="LowVramModeDescription">${i18n.t('LowVramModeDescription') || 'Disable GPU-intensive animations and transitions to prevent rendering glitches on older hardware.'}</span>
                    </div>
                    <div class="setting-control">
                        <button class="toggle-switch ${layoutManager.getLowVramMode() ? 'active' : ''}" 
                                id="toggle-low-vram-mode" 
                                tabindex="0">
                        </button>
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="LabelDisableCardScaling">${i18n.t('LabelDisableCardScaling') || 'Disable Card Scaling'}</span>
                        <span class="setting-description" data-i18n="DisableCardScalingDescription">${i18n.t('DisableCardScalingDescription') || 'Stop movie posters and thumbnails from scaling up when focused. Helpful for grid stability.'}</span>
                    </div>
                    <div class="setting-control">
                        <button class="toggle-switch ${layoutManager.getDisableCardScaling() ? 'active' : ''}" 
                                id="toggle-disable-card-scaling" 
                                tabindex="0">
                        </button>
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="ReduceMotionLargeScrolls">${i18n.t('ReduceMotionLargeScrolls') || 'Reduce Motion (Large Scrolls)'}</span>
                        <span class="setting-description" data-i18n="ReduceMotionLargeScrollsDescription">${i18n.t('ReduceMotionLargeScrollsDescription') || 'Instantly snap to the target instead of animating when scrolling long distances (improves performance).'}</span>
                    </div>
                    <div class="setting-control">
                         <button class="toggle-switch ${storage.getItem('pref:snapLargeScrolls') === 'true' ? 'active' : ''}" 
                                 id="toggle-snap-large-scrolls" 
                                 tabindex="0">
                        </button>
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="LabelSimpleLoader">${i18n.t('LabelSimpleLoader') || 'Simple Loading Indicator'}</span>
                        <span class="setting-description" data-i18n="SimpleLoaderDescription">${i18n.t('SimpleLoaderDescription') || 'Replace the standard animated loader with a lightweight rotating ring to reduce CPU usage.'}</span>
                    </div>
                    <div class="setting-control">
                        <button class="toggle-switch ${layoutManager.getSimpleLoader() ? 'active' : ''}" 
                                id="toggle-simple-loader" 
                                tabindex="0">
                        </button>
                    </div>
                </div>

                <!-- OSD Section -->
                <!-- Allows users to toggle specific metadata fields on the Details Page hero section -->
                <h3 class="setting-section-title" data-i18n="OSDCustomization">${i18n.t('OSDCustomization') || 'OSD Customization'}</h3>
                
                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="LabelShowLogoInOsd">${i18n.t('LabelShowLogoInOsd') || 'Show Logo in OSD'}</span>
                        <span class="setting-description" data-i18n="ShowLogoInOsdDescription">${i18n.t('ShowLogoInOsdDescription') || 'Display show or movie logo instead of text title in the player interface (if available).'}</span>
                    </div>
                    <div class="setting-control">
                        <button class="toggle-switch ${PlayerSettings.get('osdShowLogo') ? 'active' : ''}" 
                                id="toggle-osd-show-logo" 
                                data-setting="osdShowLogo"
                                tabindex="0">
                        </button>
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="LabelHideYearInOsd">${i18n.t('LabelHideYearInOsd') || 'Hide Year in OSD'}</span>
                        <span class="setting-description" data-i18n="HideYearInOsdDescription">${i18n.t('HideYearInOsdDescription') || 'Hides the production year from the playback overlay title.'}</span>
                    </div>
                    <div class="setting-control">
                        <button class="toggle-switch ${PlayerSettings.get('osdHideYear') ? 'active' : ''}" 
                                id="toggle-osd-hide-year" 
                                data-setting="osdHideYear"
                                tabindex="0">
                        </button>
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="LabelHideShowNameInOsd">${i18n.t('LabelHideShowNameInOsd') || 'Hide Show Name'}</span>
                        <span class="setting-description" data-i18n="HideShowNameInOsdDescription">${i18n.t('HideShowNameInOsdDescription') || 'Hides the show name (or logo) for episodes in the playback overlay.'}</span>
                    </div>
                    <div class="setting-control">
                        <button class="toggle-switch ${PlayerSettings.get('osdHideShowName') ? 'active' : ''}" 
                                id="toggle-osd-hide-show-name" 
                                data-setting="osdHideShowName"
                                tabindex="0">
                        </button>
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="LabelOsdTimeDisplay">${i18n.t('LabelOsdTimeDisplay') || 'Time Display Mode'}</span>
                        <span class="setting-description" data-i18n="OsdTimeDisplayDescription">${i18n.t('OsdTimeDisplayDescription') || 'Choose whether to show the total duration or remaining time on the player seek bar.'}</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'osd-time-display-select',
                            [
                                { value: 'total', label: i18n.t('OsdTimeTotal') || 'Total Duration' },
                                { value: 'remaining', label: i18n.t('OsdTimeRemaining') || 'Remaining Time' }
                            ],
                            PlayerSettings.get('osdTimeDisplayMode') || 'total'
                        )}
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="OsdButtonBorders">${i18n.t('OsdButtonBorders') || 'OSD Button Borders'}</span>
                        <span class="setting-description" data-i18n="OsdButtonBordersDescription">${i18n.t('OsdButtonBordersDescription') || 'Choose the border style for player control buttons.'}</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'osd-button-borders-select',
                            [
                                { value: 'auto', label: i18n.t('Auto') || 'Auto' },
                                { value: 'light', label: i18n.t('BorderLight') || 'Light' },
                                { value: 'dark', label: i18n.t('BorderDark') || 'Dark' },
                                { value: 'hidden', label: i18n.t('BorderHidden') || 'Hidden' }
                            ],
                            layoutManager.getOsdButtonBorders()
                        )}
                    </div>
                </div>

                <!-- Details Page Section -->
                <!-- Allows users to toggle specific metadata fields on the Details Page hero section -->
                <h3 class="setting-section-title" data-i18n="DetailsPage">${i18n.t('DetailsPage') || 'Details Page'}</h3>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="LabelScoreVisibility">${i18n.t('LabelScoreVisibility') || 'Score Visibility'}</span>
                        <span class="setting-description" data-i18n="ScoreVisibilityDescription">${i18n.t('ScoreVisibilityDescription') || 'Control how community and critic scores are displayed.'}</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'score-visibility-select',
                            [
                                { value: 'all', label: i18n.t('OptionScoreAll') || 'Show All' },
                                { value: 'mystery', label: i18n.t('OptionScoreMystery') || 'Mystery Mode (Hide All)' },
                                { value: 'watched', label: i18n.t('OptionScoreWatched') || 'Watched Items Only' }
                            ],
                            storage.getItem('pref:scoreVisibility') || 'all'
                        )}
                    </div>
                </div>

                <div class="setting-item" id="mdb-awards-item" style="display: ${pluginManager.isEnabled('mdblist-ratings') ? '' : 'none'}">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="ShowMdbAwards">${i18n.t('ShowMdbAwards') || 'Show Awards Badges'}</span>
                        <span class="setting-description" data-i18n="ShowMdbAwardsDescription">${i18n.t('ShowMdbAwardsDescription') || 'Display award badges from MDBList on the details page.'}</span>
                    </div>
                    <div class="setting-control">
                         <button class="toggle-switch ${storage.getItem('pref:showMdbAwards') !== 'false' ? 'active' : ''}" 
                                 id="toggle-mdb-awards" 
                                 tabindex="0">
                        </button>
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="LabelShowAddedDate">${i18n.t('LabelShowAddedDate') || 'Show Added Date'}</span>
                        <span class="setting-description" data-i18n="ShowAddedDateDescription">${i18n.t('ShowAddedDateDescription') || 'Display the date this item was added to your library on the details page.'}</span>
                    </div>
                    <div class="setting-control">
                        <button class="toggle-switch ${storage.getItem('pref:showAddedDate') === 'true' ? 'active' : ''}" 
                                id="toggle-show-added-date" 
                                tabindex="0">
                        </button>
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="LabelShowDateAired">${i18n.t('LabelShowDateAired') || 'Show Date Aired'}</span>
                        <span class="setting-description" data-i18n="ShowDateAiredDescription">${i18n.t('ShowDateAiredDescription') || 'Display the premiere date on the details page.'}</span>
                    </div>
                    <div class="setting-control">
                        <button class="toggle-switch ${storage.getItem('pref:showDateAired') === 'true' ? 'active' : ''}" 
                                id="toggle-show-date-aired" 
                                tabindex="0">
                        </button>
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="LabelHideRichMetadata">${i18n.t('LabelHideRichMetadata') || 'Hide Rich Metadata'}</span>
                        <span class="setting-description" data-i18n="HideRichMetadataDescription">${i18n.t('HideRichMetadataDescription') || 'Hide the genres, directors, and studios table on the details page.'}</span>
                    </div>
                    <div class="setting-control">
                        <button class="toggle-switch ${storage.getItem('pref:hideRichMetadata') === 'true' ? 'active' : ''}" 
                                id="toggle-hide-rich-metadata" 
                                tabindex="0">
                        </button>
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="LabelHideCastSection">${i18n.t('LabelHideCastSection') || 'Hide Cast & Guest Stars'}</span>
                        <span class="setting-description" data-i18n="HideCastSectionDescription">${i18n.t('HideCastSectionDescription') || 'Hide the actors and guest stars rows on the details page.'}</span>
                    </div>
                    <div class="setting-control">
                        <button class="toggle-switch ${storage.getItem('pref:hideCastSection') === 'true' ? 'active' : ''}" 
                                id="toggle-hide-cast-section" 
                                tabindex="0">
                        </button>
                    </div>
                </div>

                
                <!-- Image Related Section -->
                <h3 class="setting-section-title" data-i18n="ImageRelated">${i18n.t('ImageRelated')}</h3>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="ImageQuality">${i18n.t('ImageQuality')}</span>
                        <span class="setting-description" data-i18n="ImageQualityDescription">${i18n.t('ImageQualityDescription')}</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'image-quality-select',
                            [
                                { value: 'low', label: i18n.t('Low') },
                                { value: 'medium-low', label: i18n.t('MediumLow') || 'Medium Low' },
                                { value: 'medium', label: i18n.t('Medium') },
                                { value: 'medium-high', label: i18n.t('MediumHigh') || 'Medium High' },
                                { value: 'high', label: i18n.t('High') },
                                { value: 'very-high', label: i18n.t('VeryHigh') || 'Very High' },
                                { value: 'ultra', label: i18n.t('Ultra') },
                                { value: 'original', label: i18n.t('Original') }
                            ],
                            imageService.getPreset() || 'medium'
                        )}
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="DetailsImageQuality">${i18n.t('DetailsImageQuality') || 'Details Image Quality'}</span>
                        <span class="setting-description" data-i18n="DetailsImageQualityDescription">${i18n.t('DetailsImageQualityDescription') || 'Set the image quality specifically for the item details page.'}</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'details-image-quality-select',
                            [
                                { value: 'default', label: i18n.t('Default') || 'Default' },
                                { value: 'low', label: i18n.t('Low') || 'Low' },
                                { value: 'medium-low', label: i18n.t('MediumLow') || 'Medium Low' },
                                { value: 'medium', label: i18n.t('Medium') || 'Medium' },
                                { value: 'medium-high', label: i18n.t('MediumHigh') || 'Medium High' },
                                { value: 'high', label: i18n.t('High') || 'High' },
                                { value: 'very-high', label: i18n.t('VeryHigh') || 'Very High' },
                                { value: 'ultra', label: i18n.t('Ultra') },
                                { value: 'original', label: i18n.t('Original') }
                            ],
                            imageService.getDetailsPreset() || 'very-high'
                        )}
                    </div>
                </div>

                <!-- controls Section -->
                <h3 class="setting-section-title" data-i18n="controls">${i18n.t('controls')}</h3>                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="HoverScrollNavigation">${i18n.t('HoverScrollNavigation') || 'Scroll Navigation'}</span>
                        <span class="setting-description" data-i18n="HoverScrollNavigationDescription">${i18n.t('HoverScrollNavigationDescription') || 'Traverse vertical lists and rows using the scroll wheel or magic remote wheel.'}</span>
                    </div>
                    <div class="setting-control">
                        <button class="toggle-switch ${storage.getItem('pref:hoverScrollNavigation') === 'true' ? 'active' : ''}" 
                                id="toggle-hover-scroll-nav" 
                                tabindex="0">
                        </button>
                    </div>
                </div>
                
                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="EnablePlayerCursor">${i18n.t('EnablePlayerCursor') || 'Enable Player Cursor'}</span>
                        <span class="setting-description" data-i18n="EnablePlayerCursorDescription">${i18n.t('EnablePlayerCursorDescription') || 'Allow cursor/mouse interaction within the player (clicking to pause, waking the OSD on move).'}</span>
                    </div>
                    <div class="setting-control">
                        <button class="toggle-switch ${PlayerSettings.get('enableMagicCursor') ? 'active' : ''}" 
                                id="toggle-magic-cursor" 
                                data-setting="enableMagicCursor"
                                tabindex="0">
                        </button>
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="EnableHoverTrickplay">${i18n.t('EnableHoverTrickplay') || 'Hover Trickplay'}</span>
                        <span class="setting-description" data-i18n="EnableHoverTrickplayDescription">${i18n.t('EnableHoverTrickplayDescription') || 'Show timestamp and trickplay images when hovering over the seekbar with the mouse.'}</span>
                    </div>
                    <div class="setting-control">
                        <button class="toggle-switch ${PlayerSettings.get('enableHoverTrickplay') ? 'active' : ''}" 
                                id="toggle-hover-trickplay" 
                                data-setting="enableHoverTrickplay"
                                tabindex="0">
                        </button>
                    </div>
                </div>
                
                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="LabelFocusFirstItemInLibrary">${i18n.t('LabelFocusFirstItemInLibrary') || 'Focus first item in Library'}</span>
                        <span class="setting-description" data-i18n="FocusFirstItemInLibraryDescription">${i18n.t('FocusFirstItemInLibraryDescription') || 'Automatically focus the first item when entering a library instead of the navigation tabs.'}</span>
                    </div>
                    <div class="setting-control">
                         <button class="toggle-switch ${storage.getItem('pref:focusFirstItemLibrary') !== 'false' ? 'active' : ''}" 
                                 id="toggle-focus-first-item-library" 
                                 tabindex="0">
                        </button>
                    </div>
                </div>

                <!-- Time Section -->
                <h3 class="setting-section-title" data-i18n="Time">${i18n.t('Time') || 'Time'}</h3>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="LabelTimeFormat">${i18n.t('LabelTimeFormat') || 'Time Format'}</span>
                        <span class="setting-description" data-i18n="TimeFormatDescription">${i18n.t('TimeFormatDescription') || 'Choose how the clock and playback end times are displayed.'}</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'time-format-select',
                            [
                                { value: '12h', label: i18n.t('TimeFormat12h') || '12-hour' },
                                { value: '24h', label: i18n.t('TimeFormat24h') || '24-hour' },
                                { value: 'none', label: i18n.t('TimeFormatNone') || 'Hidden' }
                            ],
                            PlayerSettings.get('timeFormat') || '12h'
                        )}
                    </div>
                </div>

                <!-- Screensaver Section -->
                <h3 class="setting-section-title" data-i18n="Screensaver">${i18n.t('Screensaver') || 'Screensaver'}</h3>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="ScreensaverDelay">${i18n.t('ScreensaverDelay') || 'Display time'}</span>
                        <span class="setting-description" data-i18n="ScreensaverDelayDescription">${i18n.t('ScreensaverDelayDescription') || 'When to display the screensaver while idle'}</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'screensaver-delay-select',
                            [
                                { value: 0, label: i18n.t('Never') || 'Never' },
                                { value: 60, label: i18n.t('1Minute') || '1 Minute' },
                                { value: 300, label: i18n.t('5Minutes') || '5 Minutes' },
                                { value: 600, label: i18n.t('10Minutes') || '10 Minutes' },
                                { value: 1800, label: i18n.t('30Minutes') || '30 Minutes' }
                            ],
                            storage.getItem('pref:screensaverDelay') || 0
                        )}
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="ScreensaverType">${i18n.t('ScreensaverType') || 'Screensaver style'}</span>
                        <span class="setting-description" data-i18n="ScreensaverTypeDescription">${i18n.t('ScreensaverTypeDescription') || 'Visual style of the screensaver'}</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'screensaver-type-select',
                            [
                                { value: 'backdrop', label: i18n.t('Backdrop') || 'Backdrop' },
                                { value: 'logo', label: i18n.t('Logo') || 'Logo' },
                                { value: 'black', label: i18n.t('ScreensaverBlack') || 'Black' }
                            ],
                            storage.getItem('pref:screensaverType') || 'backdrop'
                        )}
                    </div>
                </div>

                <div class="setting-item ${storage.getItem('pref:screensaverType') !== 'backdrop' ? 'hidden' : ''}" id="screensaver-dim-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="BackdropDimmer">${i18n.t('BackdropDimmer') || 'Backdrop dim level'}</span>
                        <span class="setting-description" data-i18n="BackdropDimmerDescription">${i18n.t('BackdropDimmerDescription') || 'How dark the backdrop screensaver should be'}</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'backdrop-dimmer-select',
                            [
                                { value: '0', label: i18n.t('Off') || 'Off' },
                                { value: '0.1', label: '10%' },
                                { value: '0.2', label: '20%' },
                                { value: '0.3', label: '30%' },
                                { value: '0.4', label: '40%' },
                                { value: '0.5', label: '50%' },
                                { value: '0.6', label: '60%' },
                                { value: '0.7', label: '70%' },
                                { value: '0.8', label: '80%' },
                                { value: '0.9', label: '90%' }
                            ],
                            storage.getItem('pref:backdropDimmer') || '0.3'
                        )}
                    </div>
                </div>

                <div class="setting-item ${storage.getItem('pref:screensaverType') !== 'backdrop' ? 'hidden' : ''}" id="screensaver-hide-text-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="BackdropHideText">${i18n.t('BackdropHideText') || 'Hide title and catchphrase'}</span>
                        <span class="setting-description" data-i18n="BackdropHideTextDescription">${i18n.t('BackdropHideTextDescription') || 'Do not show any text over the backdrop screensaver images'}</span>
                    </div>
                    <div class="setting-control">
                         <button class="toggle-switch ${storage.getItem('pref:backdropHideText') === 'true' ? 'active' : ''}" 
                                 id="toggle-backdrop-hide-text" 
                                 tabindex="0">
                        </button>
                    </div>
                </div>

                <div class="setting-item ${storage.getItem('pref:screensaverType') !== 'backdrop' ? 'hidden' : ''}" id="screensaver-include-music-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="BackdropIncludeMusic">${i18n.t('BackdropIncludeMusic') || 'Include music library'}</span>
                        <span class="setting-description" data-i18n="BackdropIncludeMusicDescription">${i18n.t('BackdropIncludeMusicDescription') || 'Show backdrops from music artists in the screensaver'}</span>
                    </div>
                    <div class="setting-control">
                         <button class="toggle-switch ${storage.getItem('pref:backdropIncludeMusic') === 'true' ? 'active' : ''}" 
                                 id="toggle-backdrop-include-music" 
                                 tabindex="0">
                        </button>
                    </div>
                </div>
            </div>
        `;
    }

    /**
     * Render Home tab with layout customizations and library thumbnails
     */
    _renderHomeTab() {
        return `
            <div class="settings-tab-content">
                <h2 class="content-title" data-i18n="Home">${i18n.t('Home') || 'Home'}</h2>

                <!-- Home Screen Section -->
                <h3 class="setting-section-title" data-i18n="Customizations">${i18n.t('Customizations')}</h3>

                <!-- Application Behavior -->
                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="ConfirmAppExitLabel">${i18n.t('ConfirmAppExitLabel') || 'Confirm on Exit'}</span>
                        <span class="setting-description" data-i18n="ConfirmAppExitDescription">${i18n.t('ConfirmAppExitDescription') || 'Show a confirmation prompt before closing the application.'}</span>
                    </div>
                    <div class="setting-control">
                        <button class="toggle-switch ${storage.getItem('pref:confirmExit') === 'true' ? 'active' : ''}" 
                                id="toggle-confirm-exit" 
                                tabindex="0">
                        </button>
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="HideLibraryLabels">${i18n.t('HideLibraryLabels')}</span>
                        <span class="setting-description" data-i18n="HideLibraryLabelsDescription">${i18n.t('HideLibraryLabelsDescription')}</span>
                    </div>
                    <div class="setting-control">
                         <button class="toggle-switch ${storage.getItem('pref:hideLibraryLabels') === 'true' ? 'active' : ''}" 
                                 id="toggle-library-labels" 
                                 tabindex="0">
                        </button>
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="HideLiveTvInMyMedia">${i18n.t('HideLiveTvInMyMedia') || 'Hide Live TV from My Media'}</span>
                        <span class="setting-description" data-i18n="HideLiveTvInMyMediaDescription">${i18n.t('HideLiveTvInMyMediaDescription') || "Hide the Live TV library card from the 'My Media' row on the home screen"}</span>
                    </div>
                    <div class="setting-control">
                         <button class="toggle-switch ${storage.getItem('pref:hideLiveTvInMyMedia') === 'true' ? 'active' : ''}" 
                                 id="toggle-hide-livetv-home" 
                                 tabindex="0">
                        </button>
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="PreferEpisodeImages">${i18n.t('PreferEpisodeImages') || 'Prefer Episode Images'}</span>
                        <span class="setting-description" data-i18n="PreferEpisodeImagesDescription">${i18n.t('PreferEpisodeImagesDescription') || 'Use episode thumbnails instead of series images for Next Up and Continue Watching rows.'}</span>
                    </div>
                    <div class="setting-control">
                         <button class="toggle-switch ${storage.getItem('pref:preferEpisodeImagesLocal') === 'true' ? 'active' : ''}" 
                                 id="toggle-prefer-episode-images" 
                                 tabindex="0">
                        </button>
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="LabelMergeResumeNextUp">${i18n.t('LabelMergeResumeNextUp')}</span>
                        <span class="setting-description" data-i18n="LabelMergeResumeNextUpDescription">${i18n.t('LabelMergeResumeNextUpDescription')}</span>
                    </div>
                    <div class="setting-control">
                         <button class="toggle-switch ${storage.getItem('pref:mergeResumeNextUp') === 'true' ? 'active' : ''}" 
                                 id="toggle-merge-resume-nextup" 
                                 tabindex="0">
                        </button>
                    </div>
                </div>
                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="LabelMaxDaysForNextUp">${i18n.t('LabelMaxDaysForNextUp')}</span>
                        <span class="setting-description" data-i18n="MaxDaysForNextUpDescription">${i18n.t('MaxDaysForNextUpDescription')}</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'next-up-max-days-select',
                            [
                                { value: 0, label: i18n.t('Unlimited') },
                                { value: 1, label: i18n.t('DaysValue', [1]) },
                                { value: 2, label: i18n.t('DaysValue', [2]) },
                                { value: 3, label: i18n.t('DaysValue', [3]) },
                                { value: 4, label: i18n.t('DaysValue', [4]) },
                                { value: 5, label: i18n.t('DaysValue', [5]) },
                                { value: 6, label: i18n.t('DaysValue', [6]) },
                                { value: 7, label: i18n.t('DaysValue', [7]) },
                                { value: 14, label: i18n.t('DaysValue', [14]) },
                                { value: 21, label: i18n.t('DaysValue', [21]) },
                                { value: 28, label: i18n.t('DaysValue', [28]) },
                                { value: 30, label: i18n.t('DaysValue', [30]) },
                                { value: 60, label: i18n.t('MonthsValue', [2]) },
                                { value: 90, label: i18n.t('MonthsValue', [3]) },
                                { value: 180, label: i18n.t('MonthsValue', [6]) },
                                { value: 365, label: i18n.t('YearValue', [1]) }
                            ],
                            storage.getItem('pref:nextUpMaxDays') || 365
                        )}
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="HideWatchedContentFromLatestMedia">${i18n.t('HideWatchedContentFromLatestMedia') || 'Hide played from Recently Added'}</span>
                        <span class="setting-description" data-i18n="HideWatchedContentFromLatestMediaDescription">${i18n.t('HideWatchedContentFromLatestMediaDescription') || 'Hide watched content from Recently Added Media.'}</span>
                    </div>
                    <div class="setting-control">
                         <button class="toggle-switch ${storage.getItem('pref:hidePlayedInLatest') === 'true' ? 'active' : ''}" 
                                 id="toggle-hide-played-latest" 
                                 tabindex="0">
                        </button>
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="LibraryThumbnails">${i18n.t('LibraryThumbnails') || 'Library Thumbnails'}</span>
                        <span class="setting-description" data-i18n="LibraryThumbnailsDescription">${i18n.t('LibraryThumbnailsDescription') || 'Style of library cards on the home screen'}</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'library-thumb-mode-select',
                            [
                                { value: 'off', label: i18n.t('fromJellyfin') || 'From Jellyfin' },
                                { value: 'static', label: i18n.t('RandomStatic') || 'Random Backdrop (Static)' },
                                { value: 'dynamic', label: i18n.t('RandomDynamic') || 'Random Backdrop (Dynamic)' }
                            ],
                            storage.getItem('pref:libraryThumbMode') || 'off'
                        )}
                    </div>
                </div>

                <div class="setting-item" id="library-thumb-regenerate-container" style="display: ${storage.getItem('pref:libraryThumbMode') === 'static' ? '' : 'none'}">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="RegenerateThumbnails">${i18n.t('RegenerateThumbnails') || 'Regenerate Thumbnails'}</span>
                        <span class="setting-description" data-i18n="RegenerateThumbnailsDescription">${i18n.t('RegenerateThumbnailsDescription') || 'Pick new random backdrops for libraries'}</span>
                    </div>
                    <div class="setting-control">
                        <button class="btn btn-option" id="btn-regenerate-thumbs" tabindex="0" style="width: auto; min-width: 120px;" data-i18n="Regenerate">
                            ${i18n.t('Regenerate') || 'Regenerate'}
                        </button>
                    </div>
                </div>

                <h3 class="setting-section-title" data-i18n="HeroCarousel" style="margin-top: 40px;">${i18n.t('HeroCarousel') || 'Hero Carousel'}</h3>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="EnableHeroCarousel">${i18n.t('EnableHeroCarousel') || 'Hero Carousel'}</span>
                        <span class="setting-description" data-i18n="EnableHeroCarouselDescription">${i18n.t('EnableHeroCarouselDescription') || 'Show a featured carousel at the top of the home screen.'}</span>
                    </div>
                    <div class="setting-control">
                         <button class="toggle-switch ${storage.getItem('pref:heroCarousel') !== 'false' ? 'active' : ''}" 
                                 id="toggle-hero-carousel" 
                                 tabindex="0">
                        </button>
                    </div>
                </div>

                <div class="setting-item" id="hero-carousel-style-item" style="display: ${storage.getItem('pref:heroCarousel') !== 'false' ? '' : 'none'}">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="HeroStyle">${i18n.t('HeroStyle')}</span>
                        <span class="setting-description" data-i18n="HeroStyleDescription">${i18n.t('HeroStyleDescription') || 'Visual style of the hero carousel'}</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'hero-carousel-style-select',
                            [
                                { value: 'banner', label: i18n.t('StyleBanner') || 'Banner' },
                                { value: 'immersive', label: i18n.t('StyleImmersive') || 'Immersive' }
                            ],
                            storage.getItem('pref:heroCarouselStyle') || 'banner'
                        )}
                    </div>
                </div>

                <div class="setting-item" id="hero-image-quality-item" style="display: ${storage.getItem('pref:heroCarousel') !== 'false' ? '' : 'none'}">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="HeroImageQuality">${i18n.t('HeroImageQuality') || 'Hero Background Quality'}</span>
                        <span class="setting-description" data-i18n="HeroImageQualityDescription">${i18n.t('HeroImageQualityDescription') || 'Set the image quality specifically for hero backgrounds. Lower quality can improve performance.'}</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'hero-image-quality-select',
                            [
                                { value: 'default', label: i18n.t('Default') || 'Default' },
                                { value: 'low', label: i18n.t('Low') || 'Low' },
                                { value: 'medium-low', label: i18n.t('MediumLow') || 'Medium Low' },
                                { value: 'medium', label: i18n.t('Medium') || 'Medium' },
                                { value: 'medium-high', label: i18n.t('MediumHigh') || 'Medium High' },
                                { value: 'high', label: i18n.t('High') || 'High' },
                                { value: 'very-high', label: i18n.t('VeryHigh') || 'Very High' },
                                { value: 'ultra', label: i18n.t('Ultra') },
                                { value: 'original', label: i18n.t('Original') }
                            ],
                            storage.getItem('pref:heroImageQuality') || 'default'
                        )}
                    </div>
                </div>

                <div class="setting-item" id="hero-carousel-text-title-item" style="display: ${storage.getItem('pref:heroCarousel') !== 'false' ? '' : 'none'}">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="HeroCarouselTextTitle">${i18n.t('HeroCarouselTextTitle') || 'Use Text Titles'}</span>
                        <span class="setting-description" data-i18n="HeroCarouselTextTitleDescription">${i18n.t('HeroCarouselTextTitleDescription') || 'Prefer text titles over logos in the hero carousel.'}</span>
                    </div>
                    <div class="setting-control">
                         <button class="toggle-switch ${storage.getItem('pref:heroCarouselTextTitle') === 'true' ? 'active' : ''}" 
                                 id="toggle-hero-carousel-text-title" 
                                 tabindex="0">
                        </button>
                    </div>
                </div>

                <div class="setting-item" id="hero-carousel-compact-item" style="display: ${storage.getItem('pref:heroCarousel') !== 'false' ? '' : 'none'}">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="HeroCarouselCompact">${i18n.t('HeroCarouselCompact') || 'Compact Mode'}</span>
                        <span class="setting-description" data-i18n="HeroCarouselCompactDescription">${i18n.t('HeroCarouselCompactDescription') || 'Reduces the height of the hero section to improve scroll performance.'}</span>
                    </div>
                    <div class="setting-control">
                         <button class="toggle-switch ${storage.getItem('pref:heroCarouselCompact') !== 'false' ? 'active' : ''}" 
                                 id="toggle-hero-carousel-compact" 
                                 tabindex="0">
                        </button>
                    </div>
                </div>

                <div class="setting-item" id="hero-carousel-zoom-item" style="display: ${storage.getItem('pref:heroCarousel') !== 'false' ? '' : 'none'}">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="HeroCarouselZoom">${i18n.t('HeroCarouselZoom') || 'Enable Zoom Effect'}</span>
                        <span class="setting-description" data-i18n="HeroCarouselZoomDescription">${i18n.t('HeroCarouselZoomDescription') || 'Adds a subtle zoom animation when focusing the hero section.'}</span>
                    </div>
                    <div class="setting-control">
                         <button class="toggle-switch ${storage.getItem('pref:heroCarouselZoom') === 'true' ? 'active' : ''}" 
                                 id="toggle-hero-carousel-zoom" 
                                 tabindex="0">
                        </button>
                    </div>
                </div>

                <div class="setting-item" id="hero-carousel-indicator-animation-item" style="display: ${storage.getItem('pref:heroCarousel') !== 'false' ? '' : 'none'}">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="HeroCarouselIndicatorAnimation">${i18n.t('HeroCarouselIndicatorAnimation') || 'Indicator Animation'}</span>
                        <span class="setting-description" data-i18n="HeroCarouselIndicatorAnimationDescription">${i18n.t('HeroCarouselIndicatorAnimationDescription') || 'Enable the progress bar animation for the carousel dots.'}</span>
                    </div>
                    <div class="setting-control">
                         <button class="toggle-switch ${storage.getItem('pref:heroCarouselIndicatorAnimation') !== 'false' ? 'active' : ''}" 
                                 id="toggle-indicator-animation" 
                                 tabindex="0">
                        </button>
                    </div>
                </div>

                <div class="setting-item" id="hero-carousel-interval-item" style="display: ${storage.getItem('pref:heroCarousel') !== 'false' ? '' : 'none'}">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="HeroCarouselInterval">${i18n.t('HeroCarouselInterval') || 'Carousel Switch Timer'}</span>
                        <span class="setting-description" data-i18n="HeroCarouselIntervalDescription">${i18n.t('HeroCarouselIntervalDescription') || 'Customize how long each hero slide stays on screen before switching.'}</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'hero-carousel-interval-select',
                            [
                                { value: '2000', label: i18n.t('Seconds', [2]) || '2 seconds' },
                                { value: '4000', label: i18n.t('Seconds', [4]) || '4 seconds' },
                                { value: '5000', label: i18n.t('Seconds', [5]) || '5 seconds' },
                                { value: '8000', label: i18n.t('Seconds', [8]) || '8 seconds' },
                                { value: '10000', label: i18n.t('Seconds', [10]) || '10 seconds' },
                                { value: '15000', label: i18n.t('Seconds', [15]) || '15 seconds' },
                                { value: '20000', label: i18n.t('Seconds', [20]) || '20 seconds' },
                                { value: '25000', label: i18n.t('Seconds', [25]) || '25 seconds' },
                                { value: '30000', label: i18n.t('Seconds', [30]) || '30 seconds' },
                                { value: '40000', label: i18n.t('Seconds', [40]) || '40 seconds' },
                                { value: '60000', label: i18n.t('Seconds', [60]) || '60 seconds' }
                            ],
                            storage.getItem('pref:heroCarouselInterval') || '8000'
                        )}
                    </div>
                </div>

                <div class="setting-item" id="hero-carousel-count-item" style="display: ${storage.getItem('pref:heroCarousel') !== 'false' ? '' : 'none'}">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="HeroCarouselCount">${i18n.t('HeroCarouselCount') || 'Carousel Item Count'}</span>
                        <span class="setting-description" data-i18n="HeroCarouselCountDescription">${i18n.t('HeroCarouselCountDescription') || 'Choose how many items to load in the hero carousel (1-10).'}</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'hero-carousel-count-select',
                            [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20, 25, 30].map((v) => ({
                                value: v.toString(),
                                label: v.toString()
                            })),
                            storage.getItem('pref:heroCarouselCount') || '5'
                        )}
                    </div>
                </div>

                <div class="setting-item" id="hero-carousel-mdb-item" style="display: ${storage.getItem('pref:heroCarousel') !== 'false' && pluginManager.isEnabled('mdblist-ratings') ? '' : 'none'}">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="HeroCarouselMdbList">${i18n.t('HeroCarouselMdbList') || 'Show MDB Ratings & Awards'}</span>
                        <span class="setting-description" data-i18n="HeroCarouselMdbListDescription">${i18n.t('HeroCarouselMdbListDescription') || 'Display premium ratings (IMDb, RT) and awards directly on the home carousel items.'}</span>
                    </div>
                    <div class="setting-control">
                         <button class="toggle-switch ${storage.getItem('pref:heroCarouselMdbList') !== 'false' ? 'active' : ''}" 
                                 id="toggle-hero-carousel-mdb" 
                                 tabindex="0">
                        </button>
                    </div>
                </div>

                <h3 class="setting-section-title" data-i18n="HomeLayoutOrder" style="margin-top: 40px;">${i18n.t('HomeLayoutOrder') || 'Home Screen Layout'}</h3>
                
                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="UnlockMyMediaOrder">${i18n.t('UnlockMyMediaOrder') || 'Unlock My Media Order'}</span>
                        <span class="setting-description" data-i18n="UnlockMyMediaOrderDescription">${i18n.t('UnlockMyMediaOrderDescription') || 'Allow "My Media" to be moved from the top position. WARNING: This may cause focus layout breaks on older devices.'}</span>
                    </div>
                    <div class="setting-control">
                         <button class="toggle-switch ${storage.getItem('pref:unlockMyMediaOrder') === 'true' ? 'active' : ''}" 
                                 id="toggle-unlock-my-media-order" 
                                 tabindex="0">
                        </button>
                    </div>
                </div>

                <!-- 
                     Loaded dynamically via _setupHomeLayoutUI. 
                     Each row inside will be a distinct .setting-item .layout-row
                -->
                <div class="home-layout-container" id="home-layout-container">
                    <div class="setting-item">
                        <div class="setting-label">
                            <div class="loading-spinner small"></div>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    /**
     * Render Sidebar tab with layout customizations and initial focus
     */
    _renderSidebarTab() {
        return `
            <div class="settings-tab-content">
                <h2 class="content-title" data-i18n="Sidebar">${i18n.t('Sidebar') || 'Sidebar'}</h2>

                <!-- Default Focus Section -->
                <h3 class="setting-section-title" data-i18n="SidebarOptions">${i18n.t('SidebarOptions') || 'Sidebar Options'}</h3>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="InitialSidebarFocus">${i18n.t('InitialSidebarFocus') || 'Initial Sidebar Focus'}</span>
                        <span class="setting-description" data-i18n="InitialSidebarFocusDescription">${i18n.t('InitialSidebarFocusDescription') || 'Select which item gets focused first when opening the sidebar.'}</span>
                    </div>
                    <div class="setting-control" id="sidebar-focus-select-container">
                        <div class="loading-spinner small"></div>
                    </div>
                </div>

                <!-- Clickable Logo Section -->
                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="SidebarLogoSettings">${i18n.t('SidebarLogoSettings') || 'Clickable Logo'}</span>
                        <span class="setting-description" data-i18n="SidebarLogoSettingsDescription">${i18n.t('SidebarLogoSettingsDescription') || 'Allow the top Litefin logo to be selected to open settings.'}</span>
                    </div>
                    <div class="setting-control">
                         <button class="toggle-switch ${storage.getItem('pref:logoSettings') === 'true' ? 'active' : ''}" 
                                 id="toggle-sidebar-logo-settings" 
                                 tabindex="0">
                        </button>
                    </div>
                </div>

                <!-- Disable Animation Section -->
                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="DisableSidebarAnimation">${i18n.t('DisableSidebarAnimation') || 'Disable Sidebar Animation'}</span>
                        <span class="setting-description" data-i18n="DisableSidebarAnimationDescription">${i18n.t('DisableSidebarAnimationDescription') || 'Sidebar will open and close instantly without animation.'}</span>
                    </div>
                    <div class="setting-control">
                         <button class="toggle-switch ${storage.getItem('pref:disableSidebarAnimation') === 'true' ? 'active' : ''}" 
                                 id="toggle-disable-sidebar-animation" 
                                 tabindex="0">
                        </button>
                    </div>
                </div>
                
                <!-- Sidebar Mode Section -->
                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="SidebarMode">${i18n.t('SidebarMode') || 'Sidebar Mode'}</span>
                        <span class="setting-description" data-i18n="SidebarModeDescription">${i18n.t('SidebarModeDescription') || 'Choose how the sidebar behaves when collapsed.'}</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'sidebar-mode-select',
                            [
                                { value: 'shown', label: i18n.t('AlwaysShown') || 'Always Shown' },
                                { value: 'hidden', label: i18n.t('AlwaysHidden') || 'Always Hidden' },
                                { value: 'mixed', label: i18n.t('MixedMode') || 'Hidden in Details' }
                            ],
                            storage.getItem('pref:sidebarMode') || 'shown'
                        )}
                    </div>
                </div>

                <h3 class="setting-section-title" data-i18n="SidebarLayoutOrder" style="margin-top: 40px;">${i18n.t('SidebarLayoutOrder') || 'Sidebar Layout'}</h3>
                <!-- Loaded dynamically via _setupSidebarLayoutUI -->
                <div class="home-layout-container" id="sidebar-layout-container">
                    <div class="setting-item">
                        <div class="setting-label">
                            <div class="loading-spinner small"></div>
                        </div>
                    </div>
                </div>

                <h3 class="setting-section-title" data-i18n="MyMediaOrder" style="margin-top: 40px;">${i18n.t('MyMediaOrder') || 'My Media Order'}</h3>
                <!-- Loaded dynamically via _setupSidebarLayoutUI -->
                <div class="home-layout-container" id="sidebar-lib-layout-container">
                    <div class="setting-item">
                        <div class="setting-label">
                            <div class="loading-spinner small"></div>
                        </div>
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
                <h2 class="content-title" data-i18n="VideoQuality">${i18n.t('VideoQuality')}</h2>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="LabelMaxVideoResolution">${i18n.t('LabelMaxVideoResolution')}</span>
                        <span class="setting-description" data-i18n="MaxResolutionDescription">${i18n.t('MaxResolutionDescription')}</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'max-resolution-select',
                            [
                                { value: 'auto', label: i18n.t('AutoRecommended') },
                                { value: '7680x4320', label: i18n.t('ResolutionValue', ['7680', '4320', '8K']) },
                                { value: '3840x2160', label: i18n.t('ResolutionValue', ['3840', '2160', '4K']) },
                                { value: '1920x1080', label: i18n.t('ResolutionValue', ['1920', '1080', 'FHD']) },
                                { value: '1280x720', label: i18n.t('ResolutionValue', ['1280', '720', 'HD']) }
                            ],
                            currentMaxRes
                        )}
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="MaxStreamingBitrate">${i18n.t('MaxStreamingBitrate')}</span>
                        <span class="setting-description" data-i18n="MaxStreamingBitrateDescription">${i18n.t('MaxStreamingBitrateDescription')}</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'max-bitrate-select',
                            [
                                { value: 0, label: i18n.t('AutoRecommended') },
                                { value: 120000000, label: i18n.t('BitrateMbps', ['120']) },
                                { value: 80000000, label: i18n.t('BitrateMbps', ['80']) },
                                { value: 60000000, label: i18n.t('BitrateMbps', ['60']) },
                                { value: 40000000, label: i18n.t('BitrateMbps', ['40']) },
                                { value: 30000000, label: i18n.t('BitrateMbps', ['30']) },
                                { value: 20000000, label: i18n.t('BitrateMbps', ['20']) },
                                { value: 15000000, label: i18n.t('BitrateMbps', ['15']) },
                                { value: 10000000, label: i18n.t('BitrateMbps', ['10']) },
                                { value: 8000000, label: i18n.t('BitrateMbps', ['8']) },
                                { value: 6000000, label: i18n.t('BitrateMbps', ['6']) },
                                { value: 4000000, label: i18n.t('BitrateMbps', ['4']) },
                                { value: 3000000, label: i18n.t('BitrateMbps', ['3']) },
                                { value: 2000000, label: i18n.t('BitrateMbps', ['2']) },
                                { value: 1500000, label: i18n.t('BitrateMbps', ['1.5']) },
                                { value: 1000000, label: i18n.t('BitrateMbps', ['1']) },
                                { value: 750000, label: i18n.t('BitrateKbps', ['750']) },
                                { value: 500000, label: i18n.t('BitrateKbps', ['500']) }
                            ],
                            currentBitrate
                        )}
                    </div>
                </div>

                <h3 class="setting-section-title" data-i18n="TrailersSettings">${i18n.t('TrailersSettings')}</h3>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="TrailerPlayback">${i18n.t('TrailerPlayback') || 'Trailer Playback'}</span>
                        <span class="setting-description" data-i18n="TrailerPlaybackDescription">${i18n.t('TrailerPlaybackDescription') || 'Choose how remote trailers are opened'}</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'trailer-playback-select',
                            [
                                {
                                    value: 'internal_proxy',
                                    label: i18n.t('InternalPlayerNew') || 'Internal Player (New)'
                                },
                                {
                                    value: 'internal_iframe',
                                    label: i18n.t('InternalPlayerLegacy') || 'Internal Player (Legacy Iframe)'
                                },
                                { value: 'external', label: i18n.t('ExternalApp') || 'External App' }
                            ],
                            PlayerSettings.get('trailerPlaybackMode') || 'internal_proxy'
                        )}
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="TrailerAutoChain">${i18n.t('TrailerAutoChain') || 'Auto-play local, then online'}</span>
                        <span class="setting-description" data-i18n="TrailerAutoChainDescription">${i18n.t('TrailerAutoChainDescription') || 'Plays the server-side trailer first, then jumps straight to the online trailer when it ends. No picking required.'}</span>
                    </div>
                    <div class="setting-control">
                        <button class="toggle-switch ${PlayerSettings.get('trailerAutoChain') ? 'active' : ''}"
                                id="toggle-trailer-auto-chain"
                                data-setting="trailerAutoChain"
                                tabindex="0">
                        </button>
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="EnableBackgroundService">${i18n.t('EnableBackgroundService') || 'Enable Background Service'}</span>
                        <span class="setting-description" data-i18n="EnableBackgroundServiceDescription">${i18n.t('EnableBackgroundServiceDescription') || 'Enable the background Node.js service for Discovery and Proxy playback. Disable if you experience performance issues.'}</span>
                    </div>
                    <div class="setting-control">
                        <button class="toggle-switch ${PlayerSettings.get('enableBackgroundService') ? 'active' : ''}" 
                                id="toggle-background-service" 
                                data-setting="enableBackgroundService"
                                tabindex="0">
                        </button>
                    </div>
                </div>

                <h3 class="setting-section-title" data-i18n="PlaybackBehavior">${i18n.t('PlaybackBehavior')}</h3>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="LabelAudioLanguagePreference">${i18n.t('LabelAudioLanguagePreference')}</span>
                        <span class="setting-description" data-i18n="PreferredAudioLanguageDescription">${i18n.t('PreferredAudioLanguageDescription')}</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'audio-lang-select',
                            [{ value: 'Default', label: i18n.t('Default') }, ...this.prefLanguages],
                            storage.getItem('pref:audioLang') || 'Default'
                        )}
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="LabelSkipForwardLength">${i18n.t('LabelSkipForwardLength')}</span>
                        <span class="setting-description" data-i18n="SkipForwardDurationDescription">${i18n.t('SkipForwardDurationDescription')}</span>
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
                        <span class="setting-name" data-i18n="LabelSkipBackLength">${i18n.t('LabelSkipBackLength')}</span>
                        <span class="setting-description" data-i18n="SkipBackDurationDescription">${i18n.t('SkipBackDurationDescription')}</span>
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
                        <span class="setting-name" data-i18n="PlayNextEpisodeAutomatically">${i18n.t('PlayNextEpisodeAutomatically')}</span>
                        <span class="setting-description" data-i18n="AutoPlayNextDescription">${i18n.t('AutoPlayNextDescription')}</span>
                    </div>
                    <div class="setting-control">
                        <button class="toggle-switch ${PlayerSettings.get('enableNextEpisodeAutoPlay') ? 'active' : ''}" 
                                id="toggle-auto-next" 
                                tabindex="0">
                        </button>
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="EnableTrickplay">${i18n.t('EnableTrickplay') || 'Thumbnail Preview'}</span>
                        <span class="setting-description" data-i18n="EnableTrickplayDescription">${i18n.t('EnableTrickplayDescription') || 'Show video frame previews when scrubbing through a video'}</span>
                    </div>
                    <div class="setting-control">
                        <button class="toggle-switch ${PlayerSettings.get('enableTrickplay') ? 'active' : ''}" 
                                id="toggle-trickplay" 
                                tabindex="0">
                        </button>
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="SeekWithArrows">${i18n.t('SeekWithArrows') || 'Seek with Arrows'}</span>
                        <span class="setting-description" data-i18n="SeekWithArrowsDescription">${i18n.t('SeekWithArrowsDescription') || 'When the player controls are hidden, pressing Left or Right will instantly seek instead of just showing the controls.'}</span>
                    </div>
                    <div class="setting-control">
                        <button class="toggle-switch ${PlayerSettings.get('seekWithArrows') ? 'active' : ''}" 
                                id="toggle-seek-with-arrows" 
                                data-setting="seekWithArrows"
                                tabindex="0">
                        </button>
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="OsdFocusRestoreMode">${i18n.t('OsdFocusRestoreMode') || 'OSD Focus Restore'}</span>
                        <span class="setting-description" data-i18n="OsdFocusRestoreModeDescription">${i18n.t('OsdFocusRestoreModeDescription') || 'Where the remote cursor lands when the player controls reappear after being auto-hidden.'}</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'osd-focus-mode-select',
                            [
                                /* Always snap to Play/Pause on every OSD reveal */
                                { value: 'always', label: i18n.t('OsdFocusAlways') || 'Always return to Play/Pause' },
                                /* Reset to Play/Pause only if idle for ≥ 10 s */
                                {
                                    value: 'timeout',
                                    label: i18n.t('OsdFocusTimeout') || 'Return to Play/Pause after 10 s'
                                },
                                /* Keep the last button the user navigated to — the legacy behaviour */
                                { value: 'remember', label: i18n.t('OsdFocusRemember') || 'Remember last position' },
                                /* Always snap to seekbar on every OSD reveal */
                                { value: 'seekbar', label: i18n.t('OsdFocusSeekbar') || 'Always return to Seekbar' }
                            ],
                            PlayerSettings.get('osdFocusRestoreMode') || 'always'
                        )}
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="KeepFocusOnSubtitleOffset">${i18n.t('KeepFocusOnSubtitleOffset') || 'Pin Subtitle Offset'}</span>
                        <span class="setting-description" data-i18n="KeepFocusOnSubtitleOffsetDescription">${i18n.t('KeepFocusOnSubtitleOffsetDescription') || 'Prevent the player controls from auto-hiding while the subtitle offset menu is open.'}</span>
                    </div>
                    <div class="setting-control">
                        <button class="toggle-switch ${PlayerSettings.get('keepFocusOnSubtitleOffset') ? 'active' : ''}" 
                                id="toggle-keep-focus-subtitle-offset" 
                                data-setting="keepFocusOnSubtitleOffset"
                                tabindex="0">
                        </button>
                    </div>
                </div>

                <!-- ============================================================
                     SEGMENT SKIPPING
                     Per-type setting for what happens when the player enters
                     a detected segment (intro, credits, recap, preview).
                     Only applies when the skip-intro plugin is active.
                     ============================================================ -->
                <h3 class="setting-section-title" data-i18n="SegmentSkipping" style="margin-top: 40px;">${i18n.t('SegmentSkipping') || 'Segment Skipping'}</h3>

                <!-- Section description — gives context about the dependency -->
                <p class="setting-section-description" style="
                    font-size: 0.82rem;
                    color: var(--text-color-secondary, rgba(255,255,255,0.5));
                    margin: -12px 0 20px 0;
                    line-height: 1.4;
                ">${i18n.t('SegmentSkippingDescription') || 'Choose what happens when playback enters a detected segment. Requires the intro-skipper server plugin.'}</p>

                <!-- Intro segment action -->
                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="LabelSegmentActionIntro">${i18n.t('LabelSegmentActionIntro') || 'Intro Segment'}</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'segment-action-intro-select',
                            [
                                { value: 'None', label: i18n.t('SegmentActionNone') || 'Disabled' },
                                { value: 'AskToSkip', label: i18n.t('SegmentActionAskToSkip') || 'Show Skip Button' },
                                { value: 'Skip', label: i18n.t('SegmentActionSkip') || 'Auto-Skip' }
                            ],
                            PlayerSettings.get('skipActionIntro') || 'AskToSkip'
                        )}
                    </div>
                </div>

                <!-- Credits / outro segment action -->
                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="LabelSegmentActionOutro">${i18n.t('LabelSegmentActionOutro') || 'Credits Segment'}</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'segment-action-outro-select',
                            [
                                { value: 'None', label: i18n.t('SegmentActionNone') || 'Disabled' },
                                { value: 'AskToSkip', label: i18n.t('SegmentActionAskToSkip') || 'Show Skip Button' },
                                { value: 'Skip', label: i18n.t('SegmentActionSkip') || 'Auto-Skip' }
                            ],
                            PlayerSettings.get('skipActionOutro') || 'AskToSkip'
                        )}
                    </div>
                </div>

                <!-- Recap segment action -->
                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="LabelSegmentActionRecap">${i18n.t('LabelSegmentActionRecap') || 'Recap Segment'}</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'segment-action-recap-select',
                            [
                                { value: 'None', label: i18n.t('SegmentActionNone') || 'Disabled' },
                                { value: 'AskToSkip', label: i18n.t('SegmentActionAskToSkip') || 'Show Skip Button' },
                                { value: 'Skip', label: i18n.t('SegmentActionSkip') || 'Auto-Skip' }
                            ],
                            PlayerSettings.get('skipActionRecap') || 'None'
                        )}
                    </div>
                </div>

                <!-- Preview / next-episode teaser segment action -->
                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="LabelSegmentActionPreview">${i18n.t('LabelSegmentActionPreview') || 'Preview Segment'}</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'segment-action-preview-select',
                            [
                                { value: 'None', label: i18n.t('SegmentActionNone') || 'Disabled' },
                                { value: 'AskToSkip', label: i18n.t('SegmentActionAskToSkip') || 'Show Skip Button' },
                                { value: 'Skip', label: i18n.t('SegmentActionSkip') || 'Auto-Skip' }
                            ],
                            PlayerSettings.get('skipActionPreview') || 'None'
                        )}
                    </div>
                </div>

                <h3 class="setting-section-title" data-i18n="PlaybackCompatibility">${i18n.t('PlaybackCompatibility')}</h3>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="PlayerBackend">${i18n.t('PlayerBackend')}</span>
                        <span class="setting-description" data-i18n="PlayerBackendDescription">${i18n.t('PlayerBackendDescription')}</span>
                    </div>
                    <div class="setting-control">
                        ${(() => {
                            const options = [
                                { value: 'auto', label: i18n.t('AutoRecommended') },
                                { value: 'html5', label: i18n.t('BackendWeb') }
                            ];
                            if (platformInfo.isTizen) {
                                options.push({ value: 'avplay', label: i18n.t('BackendTizen') });
                            } else if (platformInfo.isWebOS) {
                                options.push({ value: 'webos', label: i18n.t('BackendWebOS') });
                            }
                            return this._renderDropdown('player-backend-select', options, currentBackend);
                        })()}
                    </div>
                </div>

                ${
                    platformInfo.isTizen
                        ? `
                <!-- Interlaced content backend fallback toggle.
                     Only meaningful on Tizen/AVPlay — when AVPlay encounters interlaced H264
                     inside an HLS stream it crashes. This toggle makes the player automatically
                     detect that and retry using the HTML5 (Chromium) backend instead.
                     HTML5 decodes interlaced natively, no server transcode needed. -->
                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="InterlacedBackendFallback">${i18n.t('InterlacedBackendFallback') || 'Auto-Switch for Interlaced Content'}</span>
                        <span class="setting-description" data-i18n="InterlacedBackendFallbackDescription">${i18n.t('InterlacedBackendFallbackDescription') || 'Automatically use the HTML5 player for interlaced video (1080i) when AVPlay is active.'}</span>
                    </div>
                    <div class="setting-control">
                        <button class="toggle-switch ${PlayerSettings.get('interlacedBackendFallback') ? 'active' : ''}"
                                id="toggle-interlaced-backend-fallback"
                                data-setting="interlacedBackendFallback"
                                tabindex="0">
                        </button>
                    </div>
                </div>
                `
                        : ''
                }

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="EnableHEVC">${i18n.t('EnableHEVC')}</span>
                        <span class="setting-description" data-i18n="HEVCDescription">${i18n.t('HEVCDescription')}</span>
                    </div>
                    <div class="setting-control">
                        <button class="toggle-switch ${PlayerSettings.get('enableHEVC') ? 'active' : ''}" 
                                id="toggle-enable-hevc" 
                                data-setting="enableHEVC"
                                tabindex="0">
                        </button>
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="EnableHDR">${i18n.t('EnableHDR')}</span>
                        <span class="setting-description" data-i18n="HDRDescription">${i18n.t('HDRDescription')}</span>
                    </div>
                    <div class="setting-control">
                        ${(() => {
                            // Hybrid dynamic default for HDR
                            let isHdrOn = PlayerSettings.get('enableHDR');
                            if (localStorage.getItem('player:enableHDR') === null) {
                                // First launch: Base the toggle state entirely on hardware capabilities
                                // If running on WebOS/Tizen, default OFF if it's an SDR 1080p display
                                try {
                                    // Hacky lazy-evaluation against global scope for adapters or rely on platform
                                    // but we can just require DeviceProfile generically if we were importing it.
                                    // To be safer without circular imports in SettingsPage, we inspect window width.
                                    isHdrOn = window.screen.width >= 3840;
                                } catch (e) {
                                    isHdrOn = true;
                                }
                            }
                            return `
                                <button class="toggle-switch ${isHdrOn ? 'active' : ''}" 
                                        id="toggle-enable-hdr" 
                                        data-setting="enableHDR"
                                        tabindex="0">
                                </button>
                            `;
                        })()}
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="EnableDV">${i18n.t('EnableDV')}</span>
                        <span class="setting-description" data-i18n="DolbyVisionDescription">${i18n.t('DolbyVisionDescription')}</span>
                    </div>
                    <div class="setting-control">
                        <button class="toggle-switch ${PlayerSettings.get('enableDolbyVision') ? 'active' : ''}" 
                                id="toggle-enable-dv" 
                                data-setting="enableDolbyVision"
                                tabindex="0">
                        </button>
                    </div>
                </div>

                <h3 class="setting-section-title" data-i18n="AdvancedCodecSettings">${i18n.t('AdvancedCodecSettings')}</h3>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="EnableAV1">${i18n.t('EnableAV1')}</span>
                        <span class="setting-description" data-i18n="AV1Description">${i18n.t('AV1Description')}</span>
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
                        <span class="setting-name" data-i18n="EnableVP9">${i18n.t('EnableVP9')}</span>
                        <span class="setting-description" data-i18n="VP9Description">${i18n.t('VP9Description')}</span>
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
                        <span class="setting-name" data-i18n="DTSPassthrough">${i18n.t('DTSPassthrough')}</span>
                        <span class="setting-description" data-i18n="DTSPassthroughDescription">${i18n.t('DTSPassthroughDescription')}</span>
                    </div>
                    <div class="setting-control">
                        <button class="toggle-switch ${PlayerSettings.get('enableDts') ? 'active' : ''}" 
                                id="toggle-enable-dts" 
                                data-setting="enableDts"
                                tabindex="0">
                        </button>
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="TrueHDPassthrough">${i18n.t('TrueHDPassthrough')}</span>
                        <span class="setting-description" data-i18n="TrueHDPassthroughDescription">${i18n.t('TrueHDPassthroughDescription')}</span>
                    </div>
                    <div class="setting-control">
                        <button class="toggle-switch ${PlayerSettings.get('enableTrueHd') ? 'active' : ''}" 
                                id="toggle-enable-truehd" 
                                data-setting="enableTrueHd"
                                tabindex="0">
                        </button>
                    </div>
                </div>

                ${
                    platformInfo.isTizen
                        ? `
                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="FLACPassthrough">${i18n.t('FLACPassthrough') || 'FLAC in Video Passthrough'}</span>
                        <span class="setting-description" data-i18n="FLACPassthroughDescription">${i18n.t('FLACPassthroughDescription') || 'Allow FLAC audio tracks in video files to play directly. Disable if you hear audio/video sync issues (~2s delay). Does not affect FLAC music files.'}</span>
                    </div>
                    <div class="setting-control">
                        <button class="toggle-switch ${PlayerSettings.get('enableFlacInVideo') ? 'active' : ''}" 
                                id="toggle-enable-flac-in-video" 
                                data-setting="enableFlacInVideo"
                                tabindex="0">
                        </button>
                    </div>
                </div>
                `
                        : ''
                }

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="EnableFmp4HlsContainer">${i18n.t('EnableFmp4HlsContainer') || 'Prefer fMP4 HLS Container'}</span>
                        <span class="setting-description" data-i18n="EnableFmp4HlsContainerDescription">${i18n.t('EnableFmp4HlsContainerDescription')}</span>
                    </div>
                    <div class="setting-control">
                        <button class="toggle-switch ${PlayerSettings.get('enableFmp4HlsContainer') ? 'active' : ''}" 
                                id="toggle-enable-fmp4-hls" 
                                data-setting="enableFmp4HlsContainer"
                                tabindex="0">
                        </button>
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="ForceFmp4HlsContainer">${i18n.t('ForceFmp4HlsContainer') || 'Force fMP4 HLS Container'}</span>
                        <span class="setting-description" data-i18n="ForceFmp4HlsContainerDescription">${i18n.t('ForceFmp4HlsContainerDescription')}</span>
                    </div>
                    <div class="setting-control">
                        <button class="toggle-switch ${PlayerSettings.get('forceFmp4HlsContainer') ? 'active' : ''}" 
                                id="toggle-force-fmp4-hls" 
                                data-setting="forceFmp4HlsContainer"
                                tabindex="0">
                        </button>
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="ForceTranscode">${i18n.t('ForceTranscode')}</span>
                        <span class="setting-description" data-i18n="ForceTranscodeDescription">${i18n.t('ForceTranscodeDescription')}</span>
                    </div>
                    <div class="setting-control">
                        <button class="toggle-switch ${PlayerSettings.get('forceTranscode') ? 'active' : ''}" 
                                id="toggle-force-transcode" 
                                data-setting="forceTranscode"
                                tabindex="0">
                        </button>
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="ForceDirectPlay">${i18n.t('ForceDirectPlay') || 'Force Direct Play'}</span>
                        <span class="setting-description" data-i18n="ForceDirectPlayDescription">${i18n.t('ForceDirectPlayDescription') || 'Forces direct play for all media formats. May cause playback failure if the device does not support the format natively.'}</span>
                    </div>
                    <div class="setting-control">
                        <button class="toggle-switch ${PlayerSettings.get('forceDirectPlay') ? 'active' : ''}" 
                                id="toggle-force-direct-play" 
                                data-setting="forceDirectPlay"
                                tabindex="0">
                        </button>
                    </div>
                </div>

                <!-- Playback Buffering Section -->
                <h3 class="setting-section-title" data-i18n="PlaybackBuffering">${i18n.t('PlaybackBuffering') || 'Playback Buffering'}</h3>
                
                ${(() => {
                    let html = '';

                    // WebOS Buffering
                    if (currentBackend === 'webos' || (currentBackend === 'auto' && platformInfo.isWebOS)) {
                        html += `
                        <div class="setting-item">
                            <div class="setting-label">
                                <span class="setting-name" data-i18n="WebosBufferGate">${i18n.t('WebosBufferGate') || 'Buffer Gate'}</span>
                                <span class="setting-description" data-i18n="WebosBufferGateDesc">${i18n.t('WebosBufferGateDesc') || 'Threshold in seconds for micro-stall recovery.'}</span>
                            </div>
                            <div class="setting-control">
                                ${this._renderDropdown(
                                    'webos-buffer-gate-select',
                                    [
                                        { value: 0.05, label: '0.05s' },
                                        { value: 0.1, label: '0.1s' },
                                        { value: 0.3, label: '0.3s' },
                                        { value: 0.5, label: '0.5s' },
                                        { value: 1.0, label: '1.0s' },
                                        { value: 2.0, label: '2.0s' },
                                        { value: 3.0, label: '3.0s' },
                                        { value: 5.0, label: '5.0s' }
                                    ],
                                    PlayerSettings.get('webosBufferGate') || 0.3
                                )}
                            </div>
                        </div>
                        <div class="setting-item">
                            <div class="setting-label">
                                <span class="setting-name" data-i18n="WebosStallRecovery">${i18n.t('WebosStallRecovery') || 'Stall Recovery Timeout'}</span>
                                <span class="setting-description" data-i18n="WebosStallRecoveryDesc">${i18n.t('WebosStallRecoveryDesc') || 'Timeout in milliseconds before a recovery kick is applied.'}</span>
                            </div>
                            <div class="setting-control">
                                ${this._renderDropdown(
                                    'webos-stall-recovery-select',
                                    [
                                        { value: 250, label: '250ms' },
                                        { value: 500, label: '500ms' },
                                        { value: 1000, label: '1000ms' },
                                        { value: 2000, label: '2000ms' },
                                        { value: 3000, label: '3000ms' },
                                        { value: 5000, label: '5000ms' },
                                        { value: 8000, label: '8000ms' },
                                        { value: 10000, label: '10000ms' }
                                    ],
                                    PlayerSettings.get('webosStallRecovery') || 1000
                                )}
                            </div>
                        </div>
                        <div class="setting-item">
                            <div class="setting-label">
                                <span class="setting-name" data-i18n="TranscodingSegmentLength">${i18n.t('TranscodingSegmentLength') || 'Segment Length'}</span>
                                <span class="setting-description" data-i18n="TranscodingSegmentLengthDesc">${i18n.t('TranscodingSegmentLengthDesc') || 'Length of HLS segments generated by the server. Only applied when the video is transcoded.'}</span>
                            </div>
                            <div class="setting-control">
                                ${this._renderDropdown(
                                    'webos-segment-length-select',
                                    [
                                        { value: 1, label: i18n.t('Seconds', [1]) || '1s' },
                                        { value: 2, label: i18n.t('Seconds', [2]) || '2s' },
                                        { value: 3, label: i18n.t('Seconds', [3]) || '3s' },
                                        { value: 4, label: i18n.t('Seconds', [4]) || '4s' },
                                        { value: 5, label: i18n.t('Seconds', [5]) || '5s' },
                                        { value: 6, label: i18n.t('Seconds', [6]) || '6s' },
                                        { value: 8, label: i18n.t('Seconds', [8]) || '8s' },
                                        { value: 10, label: i18n.t('Seconds', [10]) || '10s' },
                                        { value: 12, label: i18n.t('Seconds', [12]) || '12s' },
                                        { value: 15, label: i18n.t('Seconds', [15]) || '15s' }
                                    ],
                                    PlayerSettings.get('webosSegmentLength') || 3
                                )}
                            </div>
                        </div>
                        `;
                    }

                    // Tizen Buffering
                    if (currentBackend === 'avplay' || (currentBackend === 'auto' && platformInfo.isTizen)) {
                        html += `
                        <div class="setting-item">
                            <div class="setting-label">
                                <span class="setting-name" data-i18n="TizenInitialBuffer">${i18n.t('TizenInitialBuffer') || 'Initial Buffer'}</span>
                                <span class="setting-description" data-i18n="TizenInitialBufferDesc">${i18n.t('TizenInitialBufferDesc') || 'Seconds of video to buffer before playback begins.'}</span>
                            </div>
                            <div class="setting-control">
                                ${this._renderDropdown(
                                    'tizen-initial-buffer-select',
                                    [
                                        { value: 1, label: i18n.t('Seconds', [1]) || '1s' },
                                        { value: 2, label: i18n.t('Seconds', [2]) || '2s' },
                                        { value: 4, label: i18n.t('Seconds', [4]) || '4s' },
                                        { value: 6, label: i18n.t('Seconds', [6]) || '6s' },
                                        { value: 8, label: i18n.t('Seconds', [8]) || '8s' },
                                        { value: 10, label: i18n.t('Seconds', [10]) || '10s' },
                                        { value: 15, label: i18n.t('Seconds', [15]) || '15s' },
                                        { value: 20, label: i18n.t('Seconds', [20]) || '20s' },
                                        { value: 30, label: i18n.t('Seconds', [30]) || '30s' },
                                        { value: 60, label: i18n.t('Seconds', [60]) || '60s' }
                                    ],
                                    PlayerSettings.get('tizenInitialBuffer') || 6
                                )}
                            </div>
                        </div>
                        <div class="setting-item">
                            <div class="setting-label">
                                <span class="setting-name" data-i18n="TizenResumeBuffer">${i18n.t('TizenResumeBuffer') || 'Resume Buffer'}</span>
                                <span class="setting-description" data-i18n="TizenResumeBufferDesc">${i18n.t('TizenResumeBufferDesc') || 'Seconds of video to buffer after a seek or underflow.'}</span>
                            </div>
                            <div class="setting-control">
                                ${this._renderDropdown(
                                    'tizen-resume-buffer-select',
                                    [
                                        { value: 1, label: i18n.t('Seconds', [1]) || '1s' },
                                        { value: 2, label: i18n.t('Seconds', [2]) || '2s' },
                                        { value: 4, label: i18n.t('Seconds', [4]) || '4s' },
                                        { value: 6, label: i18n.t('Seconds', [6]) || '6s' },
                                        { value: 8, label: i18n.t('Seconds', [8]) || '8s' },
                                        { value: 10, label: i18n.t('Seconds', [10]) || '10s' },
                                        { value: 15, label: i18n.t('Seconds', [15]) || '15s' },
                                        { value: 20, label: i18n.t('Seconds', [20]) || '20s' },
                                        { value: 30, label: i18n.t('Seconds', [30]) || '30s' },
                                        { value: 60, label: i18n.t('Seconds', [60]) || '60s' }
                                    ],
                                    PlayerSettings.get('tizenResumeBuffer') || 4
                                )}
                            </div>
                        </div>
                        <div class="setting-item">
                            <div class="setting-label">
                                <span class="setting-name" data-i18n="TranscodingSegmentLength">${i18n.t('TranscodingSegmentLength') || 'Segment Length'}</span>
                                <span class="setting-description" data-i18n="TranscodingSegmentLengthDesc">${i18n.t('TranscodingSegmentLengthDesc') || 'Length of HLS segments generated by the server. Only applied when the video is transcoded.'}</span>
                            </div>
                            <div class="setting-control">
                                ${this._renderDropdown(
                                    'tizen-segment-length-select',
                                    [
                                        { value: 1, label: i18n.t('Seconds', [1]) || '1s' },
                                        { value: 2, label: i18n.t('Seconds', [2]) || '2s' },
                                        { value: 3, label: i18n.t('Seconds', [3]) || '3s' },
                                        { value: 4, label: i18n.t('Seconds', [4]) || '4s' },
                                        { value: 5, label: i18n.t('Seconds', [5]) || '5s' },
                                        { value: 6, label: i18n.t('Seconds', [6]) || '6s' },
                                        { value: 8, label: i18n.t('Seconds', [8]) || '8s' },
                                        { value: 10, label: i18n.t('Seconds', [10]) || '10s' },
                                        { value: 12, label: i18n.t('Seconds', [12]) || '12s' },
                                        { value: 15, label: i18n.t('Seconds', [15]) || '15s' }
                                    ],
                                    PlayerSettings.get('tizenSegmentLength') || 6
                                )}
                            </div>
                        </div>
                        `;
                    }

                    // HTML5 Buffering
                    if (
                        currentBackend === 'html5' ||
                        (currentBackend === 'auto' && !platformInfo.isTizen && !platformInfo.isWebOS)
                    ) {
                        html += `
                        <div class="setting-item">
                            <div class="setting-label">
                                <span class="setting-name" data-i18n="Html5MaxBufferLength">${i18n.t('Html5MaxBufferLength') || 'Max Buffer Length'}</span>
                                <span class="setting-description" data-i18n="Html5MaxBufferLengthDesc">${i18n.t('Html5MaxBufferLengthDesc') || 'Maximum length of video to keep in the forward buffer (seconds).'}</span>
                            </div>
                            <div class="setting-control">
                                ${this._renderDropdown(
                                    'html5-max-buffer-select',
                                    [
                                        { value: 15, label: i18n.t('Seconds', [15]) || '15s' },
                                        { value: 30, label: i18n.t('Seconds', [30]) || '30s' },
                                        { value: 45, label: i18n.t('Seconds', [45]) || '45s' },
                                        { value: 60, label: i18n.t('Seconds', [60]) || '60s' },
                                        { value: 90, label: i18n.t('Seconds', [90]) || '90s' },
                                        { value: 120, label: i18n.t('Seconds', [120]) || '120s' },
                                        { value: 180, label: i18n.t('Seconds', [180]) || '180s' },
                                        { value: 300, label: i18n.t('Seconds', [300]) || '300s' },
                                        { value: 600, label: i18n.t('Seconds', [600]) || '600s' },
                                        { value: 900, label: i18n.t('Seconds', [900]) || '900s' }
                                    ],
                                    PlayerSettings.get('html5MaxBufferLength') || 60
                                )}
                            </div>
                        </div>
                        <div class="setting-item">
                            <div class="setting-label">
                                <span class="setting-name" data-i18n="Html5MaxMaxBufferLength">${i18n.t('Html5MaxMaxBufferLength') || 'Max Max Buffer Length'}</span>
                                <span class="setting-description" data-i18n="Html5MaxMaxBufferLengthDesc">${i18n.t('Html5MaxMaxBufferLengthDesc') || 'Maximum length of video buffer allowed when bitrates are low.'}</span>
                            </div>
                            <div class="setting-control">
                                ${this._renderDropdown(
                                    'html5-max-max-buffer-select',
                                    [
                                        { value: 30, label: i18n.t('Seconds', [30]) || '30s' },
                                        { value: 60, label: i18n.t('Seconds', [60]) || '60s' },
                                        { value: 90, label: i18n.t('Seconds', [90]) || '90s' },
                                        { value: 120, label: i18n.t('Seconds', [120]) || '120s' },
                                        { value: 180, label: i18n.t('Seconds', [180]) || '180s' },
                                        { value: 240, label: i18n.t('Seconds', [240]) || '240s' },
                                        { value: 300, label: i18n.t('Seconds', [300]) || '300s' },
                                        { value: 480, label: i18n.t('Seconds', [480]) || '480s' },
                                        { value: 600, label: i18n.t('Seconds', [600]) || '600s' },
                                        { value: 900, label: i18n.t('Seconds', [900]) || '900s' },
                                        { value: 1200, label: i18n.t('Seconds', [1200]) || '1200s' }
                                    ],
                                    PlayerSettings.get('html5MaxMaxBufferLength') || 120
                                )}
                            </div>
                        </div>
                        <div class="setting-item">
                            <div class="setting-label">
                                <span class="setting-name" data-i18n="TranscodingSegmentLength">${i18n.t('TranscodingSegmentLength') || 'Segment Length'}</span>
                                <span class="setting-description" data-i18n="TranscodingSegmentLengthDesc">${i18n.t('TranscodingSegmentLengthDesc') || 'Length of HLS segments generated by the server. Only applied when the video is transcoded.'}</span>
                            </div>
                            <div class="setting-control">
                                ${this._renderDropdown(
                                    'html5-segment-length-select',
                                    [
                                        { value: 1, label: i18n.t('Seconds', [1]) || '1s' },
                                        { value: 2, label: i18n.t('Seconds', [2]) || '2s' },
                                        { value: 3, label: i18n.t('Seconds', [3]) || '3s' },
                                        { value: 4, label: i18n.t('Seconds', [4]) || '4s' },
                                        { value: 5, label: i18n.t('Seconds', [5]) || '5s' },
                                        { value: 6, label: i18n.t('Seconds', [6]) || '6s' },
                                        { value: 8, label: i18n.t('Seconds', [8]) || '8s' },
                                        { value: 10, label: i18n.t('Seconds', [10]) || '10s' },
                                        { value: 12, label: i18n.t('Seconds', [12]) || '12s' },
                                        { value: 15, label: i18n.t('Seconds', [15]) || '15s' }
                                    ],
                                    PlayerSettings.get('html5SegmentLength') || 2
                                )}
                            </div>
                        </div>
                        `;
                    }

                    return html;
                })()}
            </div>
        `;
    }

    /**
     * Render Subtitles tab with appearance and behavior settings
     */
    _renderSubtitlesTab() {
        return `
            <div class="settings-tab-content">
                <h2 class="content-title" data-i18n="Subtitles">${i18n.t('Subtitles')}</h2>
                
                <!-- Subtitle Behavior Section -->
                <h3 class="setting-section-title" data-i18n="Behavior">${i18n.t('Behavior')}</h3>
                
                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="LabelPreferredSubtitleLanguage">${i18n.t('LabelPreferredSubtitleLanguage')}</span>
                        <span class="setting-description" data-i18n="PreferredSubtitleLanguageDescription">${i18n.t('PreferredSubtitleLanguageDescription')}</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'subtitle-lang-select',
                            [{ value: 'none', label: i18n.t('None') }, ...this.prefLanguages],
                            storage.getItem('pref:subtitleLang') || 'none'
                        )}
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="LabelSubtitlePlaybackMode">${i18n.t('LabelSubtitlePlaybackMode')}</span>
                        <span class="setting-description" data-i18n="SubtitleModeDescription">${i18n.t('SubtitleModeDescription')}</span>
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
                        <span class="setting-name" data-i18n="SubtitleDelivery">${i18n.t('SubtitleDelivery')}</span>
                        <span class="setting-description" data-i18n="SubtitleDeliveryDescription">${i18n.t('SubtitleDeliveryDescription')}</span>
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
                        <span class="setting-name" data-i18n="LabelRememberTracksForSession">${i18n.t('LabelRememberTracksForSession') || 'Remember Tracks for Session'}</span>
                        <span class="setting-description" data-i18n="RememberTracksForSessionDescription">${i18n.t('RememberTracksForSessionDescription') || 'Automatically carry your active audio and subtitle tracks to the next episode.'}</span>
                    </div>
                    <div class="setting-control">
                         <button class="toggle-switch ${PlayerSettings.get('rememberTracksForSession') !== false ? 'active' : ''}" 
                                 id="subtitle-remember-tracks-toggle" 
                                 data-setting="rememberTracksForSession"
                                 tabindex="0">
                        </button>
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="DisableAssRendering">${i18n.t('DisableAssRendering')}</span>
                        <span class="setting-description" data-i18n="DisableAssRenderingDescription">${i18n.t('DisableAssRenderingDescription')}</span>
                    </div>
                    <div class="setting-control">
                         <button class="toggle-switch ${PlayerSettings.get('disableAssStyling') ? 'active' : ''}" 
                                 id="subtitle-force-text-toggle" 
                                 data-setting="disableAssStyling"
                                 tabindex="0">
                        </button>
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="LabelPgsPlaybackMode">${i18n.t('LabelPgsPlaybackMode') || 'PGS Subtitle Engine'}</span>
                        <span class="setting-description" data-i18n="PgsPlaybackModeDescription">${i18n.t('PgsPlaybackModeDescription') || 'Choose how graphic subtitles (PGS/VOBSUB) are handled.'}</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'pgs-playback-mode-select',
                            [
                                {
                                    value: 'client',
                                    label: i18n.t('PgsModeClient') || 'Client Rendering (Web Worker, Smooth TV UI)'
                                },
                                { value: 'burn', label: i18n.t('PgsModeBurn') || 'Transcode (Force Server Burn-In)' },
                                { value: 'disable', label: i18n.t('PgsModeDisable') || 'Disable and Hide Completely' }
                            ],
                            PlayerSettings.get('pgsPlaybackMode')
                        )}
                    </div>
                </div>

                <!-- Subtitle Appearance Section -->
                <h3 class="setting-section-title" data-i18n="HeaderSubtitleAppearance">${i18n.t('HeaderSubtitleAppearance')}</h3>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="AppFont">${i18n.t('AppFont')}</span>
                        <span class="setting-description" data-i18n="AppFontDescription">${i18n.t('AppFontDescription')}</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'subtitle-font-select',
                            [
                                {
                                    value: '',
                                    label: i18n.t(platformInfo.isWebOS ? 'DefaultWebOSSans' : 'DefaultTizenSans')
                                },
                                { value: 'poppins', label: i18n.t('FontPoppins') || 'Poppins' },
                                { value: 'roboto', label: i18n.t('FontRoboto') || 'Roboto' },
                                { value: 'inter', label: i18n.t('FontInter') || 'Inter' },
                                { value: 'proxima', label: i18n.t('FontProxima') || 'Proxima Nova' },
                                { value: 'noto-arabic', label: i18n.t('ArabicNotoSans') },
                                { value: 'typewriter', label: i18n.t('Typewriter') },
                                { value: 'print', label: i18n.t('Print') },
                                { value: 'console', label: i18n.t('Console') },
                                { value: 'cursive', label: i18n.t('Cursive') },
                                { value: 'casual', label: i18n.t('Casual') },
                                { value: 'smallcaps', label: i18n.t('SmallCaps') },
                                { value: 'silkscreen', label: i18n.t('FontSilkscreen') || 'Silkscreen' },
                                { value: 'space-grotesk', label: i18n.t('FontSpaceGrotesk') || 'Space Grotesk' },
                                { value: 'retrotech', label: i18n.t('FontRetrotech') || 'RETROTECH' },
                                { value: 'kitty', label: i18n.t('FontKitty') || 'Kitty' }
                            ],
                            PlayerSettings.get('subtitleFont')
                        )}
                    </div>
                </div>
                
                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="LabelTextSize">${i18n.t('LabelTextSize')}</span>
                        <span class="setting-description" data-i18n="TextSizeDescription">${i18n.t('TextSizeDescription')}</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'subtitle-size-select',
                            [
                                { value: 'small', label: i18n.t('Small') },
                                { value: 'medium', label: i18n.t('Medium') },
                                { value: 'mediumlarge', label: i18n.t('MediumLarge') },
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
                        <span class="setting-name" data-i18n="CustomSize">${i18n.t('CustomSize')} (vh)</span>
                        <span class="setting-description" data-i18n="CustomSizeDescription">${i18n.t('CustomSizeDescription')}</span>
                    </div>
                    <div class="setting-control slider-control">
                        ${this._renderSlider(
                            'subtitle-custom-size',
                            PlayerSettings.get('subtitleSizeCustomValue'),
                            1,
                            20,
                            0.1,
                            'vh'
                        )}
                    </div>
                </div>

                  <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="LabelSubtitleVerticalPosition">${i18n.t('LabelSubtitleVerticalPosition')}</span>
                        <span class="setting-description" data-i18n="VerticalPositionDescription">${i18n.t('VerticalPositionDescription')}</span>
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
                        <span class="setting-name" data-i18n="AbsolutePosition">${i18n.t('AbsolutePosition')}</span>
                        <span class="setting-description" data-i18n="AbsolutePositionDescription">${i18n.t('AbsolutePositionDescription')}</span>
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
                        <span class="setting-name" data-i18n="LabelTextWeight">${i18n.t('LabelTextWeight')}</span>
                        <span class="setting-description" data-i18n="FontWeightDescription">${i18n.t('FontWeightDescription')}</span>
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
                        <span class="setting-name" data-i18n="LabelTextColor">${i18n.t('LabelTextColor')}</span>
                        <span class="setting-description" data-i18n="TextColorDescription">${i18n.t('TextColorDescription')}</span>
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
                        <span class="setting-name" data-i18n="TextOpacity">${i18n.t('TextOpacity')}</span>
                        <span class="setting-description" data-i18n="TextOpacityDescription">${i18n.t('TextOpacityDescription')}</span>
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
                        <span class="setting-name" data-i18n="BackgroundColor">${i18n.t('BackgroundColor')}</span>
                        <span class="setting-description" data-i18n="BackgroundColorDescription">${i18n.t('BackgroundColorDescription')}</span>
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
                        <span class="setting-name" data-i18n="BackgroundOpacity">${i18n.t('BackgroundOpacity')}</span>
                        <span class="setting-description" data-i18n="BackgroundOpacityDescription">${i18n.t('BackgroundOpacityDescription')}</span>
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
                        <span class="setting-name" data-i18n="TextShadowStyle">${i18n.t('TextShadowStyle')}</span>
                        <span class="setting-description" data-i18n="TextShadowStyleDescription">${i18n.t('TextShadowStyleDescription')}</span>
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
                        <span class="setting-name" data-i18n="BorderWidth">${i18n.t('BorderWidth')}</span>
                        <span class="setting-description" data-i18n="BorderWidthDescription">${i18n.t('BorderWidthDescription')}</span>
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
                        <span class="setting-name" data-i18n="ShadowColor">${i18n.t('ShadowColor')}</span>
                        <span class="setting-description" data-i18n="ShadowColorDescription">${i18n.t('ShadowColorDescription')}</span>
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
                        <span class="setting-name" data-i18n="ShadowOpacity">${i18n.t('ShadowOpacity')}</span>
                        <span class="setting-description" data-i18n="ShadowOpacityDescription">${i18n.t('ShadowOpacityDescription')}</span>
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
                <h3 class="setting-section-title" data-i18n="AdvancedAssSettings">${i18n.t('AdvancedAssSettings')}</h3>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="OverrideAssFonts">${i18n.t('OverrideAssFonts')}</span>
                        <span class="setting-description" data-i18n="OverrideAssFontsDescription">${i18n.t('OverrideAssFontsDescription')}</span>
                    </div>
                    <div class="setting-control">
                         <button class="toggle-switch ${PlayerSettings.get('subtitleOverrideAssFonts') === true ? 'active' : ''}" 
                                 id="toggle-subtitle-override-ass-fonts" 
                                 data-setting="subtitleOverrideAssFonts"
                                 tabindex="0">
                        </button>
                    </div>
                </div>

                <div class="setting-item" id="subtitle-font-ass-container" style="display: ${PlayerSettings.get('subtitleOverrideAssFonts') === true ? '' : 'none'}">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="AssFontFamily">${i18n.t('AssFontFamily')}</span>
                        <span class="setting-description" data-i18n="FontFamilyAssDescription">${i18n.t('FontFamilyAssDescription')}</span>
                    </div>
                    <div class="setting-control">
                        ${this._renderDropdown(
                            'subtitle-font-ass-select',
                            [
                                {
                                    value: '',
                                    label: i18n.t(platformInfo.isWebOS ? 'DefaultWebOSSans' : 'DefaultTizenSans')
                                },
                                { value: 'poppins', label: i18n.t('ModernPoppins') },
                                { value: 'noto-arabic', label: i18n.t('ArabicNotoSans') },
                                { value: 'typewriter', label: i18n.t('Typewriter') },
                                { value: 'print', label: i18n.t('Print') },
                                { value: 'console', label: i18n.t('Console') },
                                { value: 'cursive', label: i18n.t('Cursive') },
                                { value: 'casual', label: i18n.t('Casual') },
                                { value: 'smallcaps', label: i18n.t('SmallCaps') },
                                { value: 'silkscreen', label: i18n.t('FontSilkscreen') || 'Silkscreen' },
                                { value: 'space-grotesk', label: i18n.t('FontSpaceGrotesk') || 'Space Grotesk' },
                                { value: 'retrotech', label: i18n.t('FontRetrotech') || 'RETROTECH' },
                                { value: 'kitty', label: i18n.t('FontKitty') || 'Kitty' },
                                { value: 'inter', label: i18n.t('FontInter') || 'Inter' },
                                { value: 'proxima', label: i18n.t('FontProxima') || 'Proxima Nova' },
                                { value: 'baloo', label: i18n.t('FontBaloo') || 'Baloo Bhaijaan 2' }
                            ],
                            PlayerSettings.get('subtitleFontAss')
                        )}
                    </div>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="FontScaleAss">${i18n.t('FontScaleAss')}</span>
                        <span class="setting-description" data-i18n="FontScaleAssDescription">${i18n.t('FontScaleAssDescription')}</span>
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
                        <span class="setting-name" data-i18n="VerticalPositionAss">${i18n.t('VerticalPositionAss')}</span>
                        <span class="setting-description" data-i18n="VerticalPositionAssDescription">${i18n.t('VerticalPositionAssDescription')}</span>
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
                        <span class="setting-name" data-i18n="OverrideOutlineShadow">${i18n.t('OverrideOutlineShadow')}</span>
                        <span class="setting-description" data-i18n="OverrideOutlineShadowDescription">${i18n.t('OverrideOutlineShadowDescription')}</span>
                    </div>
                    <div class="setting-control">
                        <button class="toggle-switch ${PlayerSettings.get('subtitleOverrideAssOutlineShadow') !== false ? 'active' : ''}" 
                                id="subtitle-override-ass-toggle" 
                                data-setting="subtitleOverrideAssOutlineShadow"
                                tabindex="0">
                        </button>
                    </div>
                </div>

                <div class="setting-item" id="subtitle-outline-thickness-container" style="display: ${PlayerSettings.get('subtitleOverrideAssOutlineShadow') !== false ? '' : 'none'}">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="OutlineThicknessAss">${i18n.t('OutlineThicknessAss')}</span>
                        <span class="setting-description" data-i18n="OutlineThicknessAssDescription">${i18n.t('OutlineThicknessAssDescription')}</span>
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

                <div class="setting-item" id="subtitle-shadow-thickness-container" style="display: ${PlayerSettings.get('subtitleOverrideAssOutlineShadow') !== false ? '' : 'none'}">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="ShadowThicknessAss">${i18n.t('ShadowThicknessAss')}</span>
                        <span class="setting-description" data-i18n="ShadowThicknessAssDescription">${i18n.t('ShadowThicknessAssDescription')}</span>
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
                        <span class="setting-name" data-i18n="VerticalSpacingAss">${i18n.t('VerticalSpacingAss')}</span>
                        <span class="setting-description" data-i18n="VerticalSpacingAssDescription">${i18n.t('VerticalSpacingAssDescription')}</span>
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
                        <span class="setting-name" data-i18n="HorizontalSpacingAss">${i18n.t('HorizontalSpacingAss')}</span>
                        <span class="setting-description" data-i18n="HorizontalSpacingAssDescription">${i18n.t('HorizontalSpacingAssDescription')}</span>
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

    _renderAboutTab() {
        const caps = getDeviceCapabilities();

        return `
            <div class="settings-tab-content">
                <h2 class="content-title" data-i18n="AboutLitefin">${i18n.t('AboutLitefin')}</h2>
                
                <div class="about-card" tabindex="0">
                    <h3 class="app-version">${i18n.t('AppVersion', [__APP_VERSION__])}</h3>
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
                            <span class="identity-value">${platformInfo.isWeb ? i18n.t('BrowserValue', [caps.browserVersion]) : platformInfo.isWebOS ? i18n.t('WebOSValue', [caps.webosVersion]) : i18n.t('TizenValue', [caps.tizenVersion])}</span>
                        </div>
                        <div class="identity-item">
                            <span class="identity-label" data-i18n="Resolution">${i18n.t('Resolution')}</span>
                            <span class="identity-value">${i18n.t('ResolutionValue', [
                                caps.screenWidth,
                                caps.screenHeight,
                                caps.uhd8K ? i18n.t('UHD8K') : caps.uhd ? i18n.t('UHD') : i18n.t('FHD')
                            ])}</span>
                        </div>
                        <div class="identity-item">
                            <span class="identity-label" data-i18n="HDRSupport">${i18n.t('HDRSupport')}</span>
                            <span class="identity-value">${(() => {
                                const userHdr = PlayerSettings.get('enableHDR');
                                const hwHdr = [
                                    caps.hdr10 ? 'HDR10' : null,
                                    caps.hdr10Plus ? 'HDR10+' : null,
                                    caps.hlg ? 'HLG' : null,
                                    caps.dolbyVision ? i18n.t('DolbyVision') : null
                                ].filter(Boolean);

                                if (hwHdr.length === 0) return i18n.t('SDROnly');
                                if (!userHdr) return `${hwHdr.join(', ')} (${i18n.t('Disabled')})`;
                                return hwHdr.join(', ');
                            })()}</span>
                        </div>
                        <div class="identity-item">
                            <span class="identity-label" data-i18n="VideoCodecs">${i18n.t('VideoCodecs')}</span>
                            <span class="identity-value">${(() => {
                                const codecs = [
                                    { name: 'H.264', hw: true, user: true },
                                    { name: 'HEVC', hw: caps.hevc, user: PlayerSettings.get('enableHEVC') },
                                    { name: 'AV1', hw: caps.av1, user: PlayerSettings.get('enableAV1') },
                                    { name: 'VP9', hw: caps.vp9, user: PlayerSettings.get('enableVP9') }
                                ];

                                return codecs
                                    .filter((c) => c.hw)
                                    .map((c) => (c.user ? c.name : `${c.name} (${i18n.t('Disabled')})`))
                                    .join(', ');
                            })()}</span>
                        </div>
                    </div>
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
                        <button class="btn btn-secondary setting-btn focusable" id="btn-check-updates" tabindex="0" data-i18n="CheckForUpdatesNow" data-focusable="true" style="width: auto; min-width: 160px;">
                            ${i18n.t('CheckForUpdatesNow')}
                        </button>
                    </div>
                </div>

                <div class="setting-item" style="margin-top: 40px; border-top: 1px solid var(--jf-divider); padding-top: 40px;">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="LabelResetSettings">${i18n.t('LabelResetSettings') || 'Reset All Settings'}</span>
                        <span class="setting-description" data-i18n="LabelResetSettingsDescription">${i18n.t('LabelResetSettingsDescription') || 'Restore all application and player settings to their default values. This will not sign you out.'}</span>
                    </div>
                    <div class="setting-control">
                        <button class="btn btn-danger btn-small" id="btn-reset-settings" tabindex="0">
                            ${i18n.t('ButtonResetAll') || 'Reset All'}
                        </button>
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

                <!-- ============================================================ -->
                <!-- Storage Management Section                                   -->
                <!-- ============================================================ -->
                <h3 class="setting-section-title" data-i18n="StorageManagement">${i18n.t('StorageManagement')}</h3>

                <!-- Usage display: populated dynamically in onMounted -->
                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="LocalStorageUsage">${i18n.t('LocalStorageUsage')}</span>
                        <span class="setting-description" id="storage-usage-display" data-i18n="Calculating">${i18n.t('Calculating')}</span>
                    </div>
                </div>

                <!-- Clear cached library thumbnail URLs -->
                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="ClearImageCache">${i18n.t('ClearImageCache')}</span>
                        <span class="setting-description" data-i18n="ClearImageCacheDescription">${i18n.t('ClearImageCacheDescription')}</span>
                    </div>
                    <div class="setting-control">
                        <button class="btn btn-option" id="btn-clear-image-cache" tabindex="0" style="width: auto; min-width: 120px;" data-i18n="Clear">
                            ${i18n.t('Clear')}
                        </button>
                    </div>
                </div>

                <!-- Clear stale debug module filter history -->
                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="ClearDebugFilters">${i18n.t('ClearDebugFilters')}</span>
                        <span class="setting-description" data-i18n="ClearDebugFiltersDescription">${i18n.t('ClearDebugFiltersDescription')}</span>
                    </div>
                    <div class="setting-control">
                        <button class="btn btn-option" id="btn-clear-debug-filters" tabindex="0" style="width: auto; min-width: 120px;" data-i18n="Clear">
                            ${i18n.t('Clear')}
                        </button>
                    </div>
                </div>

                <!-- Nuke all non-essential caches (auth-safe) -->
                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="ClearAllCaches">${i18n.t('ClearAllCaches')}</span>
                        <span class="setting-description" data-i18n="ClearAllCachesDescription">${i18n.t('ClearAllCachesDescription')}</span>
                    </div>
                    <div class="setting-control">
                        <button class="btn btn-danger" id="btn-clear-all-storage" tabindex="0" style="width: auto; min-width: 120px; padding: 12px 24px; font-size: 1.2rem;" data-i18n="Clear">
                            ${i18n.t('Clear')}
                        </button>
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

        // If the debug tab is active, populate the live storage usage display
        // so the user gets immediate feedback without having to navigate away.
        if (this.activeTab === 'debug') {
            this._updateStorageUsageDisplay();
        }
    }

    _bindEvents() {
        // Back button

        // Sidebar Navigation
        this.$$('.settings-menu-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                const tab = btn.dataset.tab;
                this._switchTab(tab, false, true);
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

        // Toggle Backdrop Hide Text
        const hideTextBtn = this.$('#toggle-backdrop-hide-text');
        if (hideTextBtn) {
            hideTextBtn.addEventListener('click', () => {
                const isHidden = storage.getItem('pref:backdropHideText') === 'true';
                const newValue = !isHidden;
                storage.setItem('pref:backdropHideText', newValue);
                hideTextBtn.classList.toggle('active', newValue);
            });
        }

        // Toggle Backdrop Include Music
        const includeMusicBtn = this.$('#toggle-backdrop-include-music');
        if (includeMusicBtn) {
            includeMusicBtn.addEventListener('click', () => {
                const isIncluded = storage.getItem('pref:backdropIncludeMusic') === 'true';
                const newValue = !isIncluded;
                storage.setItem('pref:backdropIncludeMusic', newValue);
                includeMusicBtn.classList.toggle('active', newValue);
            });
        }

        // Reset Settings Button
        const resetSettingsBtn = this.$('#btn-reset-settings');
        if (resetSettingsBtn) {
            resetSettingsBtn.addEventListener('click', () => {
                this._showResetConfirmation();
            });
        }

        // Toggle Rounded Corners
        const roundedCornersBtn = this.$('#toggle-rounded-corners');
        if (roundedCornersBtn) {
            roundedCornersBtn.addEventListener('click', () => {
                const newValue = !layoutManager.getRoundedCorners();
                layoutManager.setRoundedCorners(newValue);
                roundedCornersBtn.classList.toggle('active', newValue);
            });
        }

        // Toggle Hide Library Labels
        const hideLabelsBtn = this.$('#toggle-library-labels');
        if (hideLabelsBtn) {
            hideLabelsBtn.addEventListener('click', () => {
                const isHidden = storage.getItem('pref:hideLibraryLabels') === 'true';
                const newValue = !isHidden;
                storage.setItem('pref:hideLibraryLabels', newValue);
                hideLabelsBtn.classList.toggle('active', newValue);
            });
        }

        // Toggle Hide Live TV in My Media
        const hideLiveTvBtn = this.$('#toggle-hide-livetv-home');
        if (hideLiveTvBtn) {
            hideLiveTvBtn.addEventListener('click', () => {
                const isHidden = storage.getItem('pref:hideLiveTvInMyMedia') === 'true';
                const newValue = !isHidden;
                storage.setItem('pref:hideLiveTvInMyMedia', newValue);
                hideLiveTvBtn.classList.toggle('active', newValue);
                log.info(`Hide Live TV in My Media set to: ${newValue}`);
            });
        }

        // Toggle Prefer Episode Images
        const preferEpisodeImagesBtn = this.$('#toggle-prefer-episode-images');
        if (preferEpisodeImagesBtn) {
            preferEpisodeImagesBtn.addEventListener('click', () => {
                const isEnabled = storage.getItem('pref:preferEpisodeImagesLocal') === 'true';
                const newValue = !isEnabled;
                storage.setItem('pref:preferEpisodeImagesLocal', newValue);
                preferEpisodeImagesBtn.classList.toggle('active', newValue);
                log.info(`Prefer Episode Images set to: ${newValue}`);
            });
        }

        // Toggle Focus First Item in Library
        const focusFirstItemBtn = this.$('#toggle-focus-first-item-library');
        if (focusFirstItemBtn) {
            focusFirstItemBtn.addEventListener('click', () => {
                const isEnabled = storage.getItem('pref:focusFirstItemLibrary') !== 'false';
                const newValue = !isEnabled;
                storage.setItem('pref:focusFirstItemLibrary', newValue.toString());
                focusFirstItemBtn.classList.toggle('active', newValue);
                log.info(`Focus First Item in Library set to: ${newValue}`);
            });
        }

        // Toggle Merge Resume and Next Up
        const mergeResumeNextUpBtn = this.$('#toggle-merge-resume-nextup');
        if (mergeResumeNextUpBtn) {
            mergeResumeNextUpBtn.addEventListener('click', () => {
                const isEnabled = storage.getItem('pref:mergeResumeNextUp') === 'true';
                const newValue = !isEnabled;
                storage.setItem('pref:mergeResumeNextUp', newValue);
                mergeResumeNextUpBtn.classList.toggle('active', newValue);
                log.info(`Merge Resume and Next Up set to: ${newValue}`);

                // Refresh the home layout UI so "Next Up" disappears/reappears
                // This ensures the user doesn't see conflicting options.
                this._setupHomeLayoutUI();

                // Invalidate focus cache to keep navigation stable
                focusManager.invalidateCache('settings-content');
            });
        }

        // Toggle Random Button
        const randomBtnToggle = this.$('#toggle-random-button');
        if (randomBtnToggle) {
            randomBtnToggle.addEventListener('click', () => {
                const isEnabled = storage.getItem('pref:showRandomButton') === 'true';
                const newValue = !isEnabled;
                storage.setItem('pref:showRandomButton', newValue);
                randomBtnToggle.classList.toggle('active', newValue);

                // Notify components (like Sidebar) to update
                eventBus.emit('prefChanged:showRandomButton', newValue);

                log.info(`Random Button set to: ${newValue}`);
            });
        }

        // Toggle Hero Carousel
        const heroCarouselBtn = this.$('#toggle-hero-carousel');
        if (heroCarouselBtn) {
            heroCarouselBtn.addEventListener('click', () => {
                const isEnabled = storage.getItem('pref:heroCarousel') !== 'false';
                const newValue = !isEnabled;
                storage.setItem('pref:heroCarousel', newValue.toString());
                heroCarouselBtn.classList.toggle('active', newValue);

                // Toggle visibility of dependent settings (style, text title, compact)
                const textTitleItem = this.$('#hero-carousel-text-title-item');
                const compactItem = this.$('#hero-carousel-compact-item');
                const styleItem = this.$('#hero-carousel-style-item');
                const zoomItem = this.$('#hero-carousel-zoom-item');
                const heroQualityItem = this.$('#hero-image-quality-item');
                const indicatorAnimItem = this.$('#hero-carousel-indicator-animation-item');
                const intervalItem = this.$('#hero-carousel-interval-item');
                const countItem = this.$('#hero-carousel-count-item');
                const mdbItem = this.$('#hero-carousel-mdb-item');

                if (textTitleItem) textTitleItem.style.display = newValue ? '' : 'none';
                if (compactItem) compactItem.style.display = newValue ? '' : 'none';
                if (styleItem) styleItem.style.display = newValue ? '' : 'none';
                if (zoomItem) zoomItem.style.display = newValue ? '' : 'none';
                if (heroQualityItem) heroQualityItem.style.display = newValue ? '' : 'none';
                if (indicatorAnimItem) indicatorAnimItem.style.display = newValue ? '' : 'none';
                if (intervalItem) intervalItem.style.display = newValue ? '' : 'none';
                if (countItem) countItem.style.display = newValue ? '' : 'none';
                if (mdbItem)
                    mdbItem.style.display = newValue && pluginManager.isEnabled('mdblist-ratings') ? '' : 'none';

                focusManager.invalidateCache('settings-content');
                log.info(`Hero Carousel set to: ${newValue}`);
            });
        }

        // Toggle Hide Rich Metadata
        const hideRichMetaBtn = this.$('#toggle-hide-rich-metadata');
        if (hideRichMetaBtn) {
            hideRichMetaBtn.addEventListener('click', () => {
                const isHidden = storage.getItem('pref:hideRichMetadata') === 'true';
                const newValue = !isHidden;
                storage.setItem('pref:hideRichMetadata', newValue.toString());
                hideRichMetaBtn.classList.toggle('active', newValue);
                log.info(`Hide Rich Metadata set to: ${newValue}`);
            });
        }

        // Toggle Low VRAM Mode
        const lowVramBtn = this.$('#toggle-low-vram-mode');
        if (lowVramBtn) {
            lowVramBtn.addEventListener('click', () => {
                const newValue = !layoutManager.getLowVramMode();
                layoutManager.setLowVramMode(newValue);
                lowVramBtn.classList.toggle('active', newValue);
            });
        }

        // Toggle Disable Card Scaling
        const disableScalingBtn = this.$('#toggle-disable-card-scaling');
        if (disableScalingBtn) {
            disableScalingBtn.addEventListener('click', () => {
                const newValue = !layoutManager.getDisableCardScaling();
                layoutManager.setDisableCardScaling(newValue);
                disableScalingBtn.classList.toggle('active', newValue);
            });
        }

        // Toggle Simple Loader
        const simpleLoaderBtn = this.$('#toggle-simple-loader');
        if (simpleLoaderBtn) {
            simpleLoaderBtn.addEventListener('click', () => {
                const newValue = !layoutManager.getSimpleLoader();
                layoutManager.setSimpleLoader(newValue);
                simpleLoaderBtn.classList.toggle('active', newValue);
            });
        }

        // Toggle Hide Cast & Guest Stars
        const hideCastBtn = this.$('#toggle-hide-cast-section');
        if (hideCastBtn) {
            hideCastBtn.addEventListener('click', () => {
                const isHidden = storage.getItem('pref:hideCastSection') === 'true';
                const newValue = !isHidden;
                storage.setItem('pref:hideCastSection', newValue.toString());
                hideCastBtn.classList.toggle('active', newValue);
                log.info(`Hide Cast & Guest Stars set to: ${newValue}`);
            });
        }

        // Toggle Hero Carousel Text Title
        const heroCarouselTextBtn = this.$('#toggle-hero-carousel-text-title');
        if (heroCarouselTextBtn) {
            heroCarouselTextBtn.addEventListener('click', () => {
                const isEnabled = storage.getItem('pref:heroCarouselTextTitle') === 'true';
                const newValue = !isEnabled;
                storage.setItem('pref:heroCarouselTextTitle', newValue.toString());
                heroCarouselTextBtn.classList.toggle('active', newValue);
                log.info(`Hero Carousel Text Title set to: ${newValue}`);
            });
        }

        // Toggle Hero Carousel Compact Mode
        const heroCarouselCompactBtn = this.$('#toggle-hero-carousel-compact');
        if (heroCarouselCompactBtn) {
            heroCarouselCompactBtn.addEventListener('click', () => {
                const isEnabled = storage.getItem('pref:heroCarouselCompact') !== 'false';
                const newValue = !isEnabled;
                storage.setItem('pref:heroCarouselCompact', newValue.toString());
                heroCarouselCompactBtn.classList.toggle('active', newValue);
                log.info(`Hero Carousel Compact Mode set to: ${newValue}`);
            });
        }

        // Toggle Hero Carousel Zoom Effect
        const heroCarouselZoomBtn = this.$('#toggle-hero-carousel-zoom');
        if (heroCarouselZoomBtn) {
            heroCarouselZoomBtn.addEventListener('click', () => {
                const isEnabled = storage.getItem('pref:heroCarouselZoom') === 'true';
                const newValue = !isEnabled;
                storage.setItem('pref:heroCarouselZoom', newValue.toString());
                heroCarouselZoomBtn.classList.toggle('active', newValue);
                log.info(`Hero Carousel Zoom Effect set to: ${newValue}`);
            });
        }

        // Toggle Hero Carousel Indicator Animation
        const heroCarouselIndicatorBtn = this.$('#toggle-indicator-animation');
        if (heroCarouselIndicatorBtn) {
            heroCarouselIndicatorBtn.addEventListener('click', () => {
                const isEnabled = storage.getItem('pref:heroCarouselIndicatorAnimation') !== 'false';
                const newValue = !isEnabled;
                storage.setItem('pref:heroCarouselIndicatorAnimation', newValue.toString());
                heroCarouselIndicatorBtn.classList.toggle('active', newValue);
                log.info(`Hero Carousel Indicator Animation set to: ${newValue}`);
            });
        }

        // Toggle Hero Carousel MDBList
        const heroCarouselMdbBtn = this.$('#toggle-hero-carousel-mdb');
        if (heroCarouselMdbBtn) {
            heroCarouselMdbBtn.addEventListener('click', () => {
                const isEnabled = storage.getItem('pref:heroCarouselMdbList') !== 'false';
                const newValue = !isEnabled;
                storage.setItem('pref:heroCarouselMdbList', newValue.toString());
                heroCarouselMdbBtn.classList.toggle('active', newValue);
                log.info(`Hero Carousel MDBList set to: ${newValue}`);
            });
        }

        // Toggle Reduce Motion (Large Scrolls)
        const snapLargeScrollsBtn = this.$('#toggle-snap-large-scrolls');
        if (snapLargeScrollsBtn) {
            snapLargeScrollsBtn.addEventListener('click', () => {
                const isEnabled = storage.getItem('pref:snapLargeScrolls') === 'true';
                const newValue = !isEnabled;
                storage.setItem('pref:snapLargeScrolls', newValue.toString());
                snapLargeScrollsBtn.classList.toggle('active', newValue);
                log.info(`Snap Large Scrolls set to: ${newValue}`);
            });
        }

        // Toggle Hide Played in Latest
        const hidePlayedLatestBtn = this.$('#toggle-hide-played-latest');
        if (hidePlayedLatestBtn) {
            hidePlayedLatestBtn.addEventListener('click', async () => {
                const isHidden = storage.getItem('pref:hidePlayedInLatest') === 'true';
                const newValue = !isHidden;
                storage.setItem('pref:hidePlayedInLatest', newValue);
                hidePlayedLatestBtn.classList.toggle('active', newValue);

                // Sync preference with Jellyfin server so it's applied securely
                try {
                    const user = await api.getCurrentUser();
                    if (user && user.Configuration) {
                        user.Configuration.HidePlayedInLatest = newValue;
                        await api.updateUserConfiguration(user.Configuration);
                        log.info(`Synced HidePlayedInLatest (${newValue}) to server`);
                    }
                } catch (e) {
                    log.error('Failed to sync HidePlayedInLatest to server', e);
                }
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

        // Toggle Trickplay Thumbnail Previews
        const trickplayBtn = this.$('#toggle-trickplay');
        if (trickplayBtn) {
            trickplayBtn.addEventListener('click', () => {
                const currentValue = PlayerSettings.get('enableTrickplay');
                const newValue = !currentValue;
                PlayerSettings.set('enableTrickplay', newValue);
                trickplayBtn.classList.toggle('active', newValue);
            });
        }

        // Toggle OSD Show Logo
        const showLogoBtn = this.$('#toggle-osd-show-logo');
        if (showLogoBtn) {
            showLogoBtn.addEventListener('click', () => {
                const currentValue = PlayerSettings.get('osdShowLogo');
                const newValue = !currentValue;
                PlayerSettings.set('osdShowLogo', newValue);
                showLogoBtn.classList.toggle('active', newValue);
            });
        }

        // Toggle OSD Hide Year
        const hideYearBtn = this.$('#toggle-osd-hide-year');
        if (hideYearBtn) {
            hideYearBtn.addEventListener('click', () => {
                const currentValue = PlayerSettings.get('osdHideYear');
                const newValue = !currentValue;
                PlayerSettings.set('osdHideYear', newValue);
                hideYearBtn.classList.toggle('active', newValue);
            });
        }

        // Toggle OSD Hide Show Name
        const hideShowNameBtn = this.$('#toggle-osd-hide-show-name');
        if (hideShowNameBtn) {
            hideShowNameBtn.addEventListener('click', () => {
                const currentValue = PlayerSettings.get('osdHideShowName');
                const newValue = !currentValue;
                PlayerSettings.set('osdHideShowName', newValue);
                hideShowNameBtn.classList.toggle('active', newValue);
            });
        }

        // Toggle Keep Focus On Subtitle Offset
        const keepFocusOffsetBtn = this.$('#toggle-keep-focus-subtitle-offset');
        if (keepFocusOffsetBtn) {
            keepFocusOffsetBtn.addEventListener('click', () => {
                const currentValue = PlayerSettings.get('keepFocusOnSubtitleOffset');
                const newValue = !currentValue;
                PlayerSettings.set('keepFocusOnSubtitleOffset', newValue);
                keepFocusOffsetBtn.classList.toggle('active', newValue);
            });
        }

        // Toggle ASS Font Override
        const assFontOverrideBtn = this.$('#toggle-subtitle-override-ass-fonts');
        if (assFontOverrideBtn) {
            assFontOverrideBtn.addEventListener('click', () => {
                const currentValue = PlayerSettings.get('subtitleOverrideAssFonts') === true;
                const newValue = !currentValue;
                PlayerSettings.set('subtitleOverrideAssFonts', newValue);
                assFontOverrideBtn.classList.toggle('active', newValue);

                // Update visibility of the font dropdown container
                const fontContainer = this.$('#subtitle-font-ass-container');
                if (fontContainer) fontContainer.style.display = newValue ? '' : 'none';

                // Invalidate focus cache so the newly visible items can be focused
                focusManager.invalidateCache();
            });
        }

        // Toggle ASS Outline/Shadow Override
        const assOverrideBtn = this.$('#subtitle-override-ass-toggle');
        if (assOverrideBtn) {
            assOverrideBtn.addEventListener('click', () => {
                const currentValue = PlayerSettings.get('subtitleOverrideAssOutlineShadow') !== false;
                const newValue = !currentValue;
                PlayerSettings.set('subtitleOverrideAssOutlineShadow', newValue);
                assOverrideBtn.classList.toggle('active', newValue);

                // Update visibility of thickness sliders
                const outlineContainer = this.$('#subtitle-outline-thickness-container');
                const shadowContainer = this.$('#subtitle-shadow-thickness-container');
                if (outlineContainer) outlineContainer.style.display = newValue ? '' : 'none';
                if (shadowContainer) shadowContainer.style.display = newValue ? '' : 'none';

                // Invalidate focus cache so the newly visible items can be focused
                focusManager.invalidateCache();
            });
        }

        // Regenerate Library Thumbnails
        // Uses storage.clearByPrefix() so the in-memory StorageService cache
        // is kept in sync with the disk — previously this called localStorage
        // directly, leaving stale values in the in-memory Map.
        const regenerateThumbsBtn = this.$('#btn-regenerate-thumbs');
        if (regenerateThumbsBtn) {
            regenerateThumbsBtn.addEventListener('click', () => {
                regenerateThumbsBtn.disabled = true;
                regenerateThumbsBtn.textContent = i18n.t('Working');

                // Clear via StorageService so both the in-memory cache and disk stay in sync
                storage.clearByPrefix('libThumb:');

                // Short delay for visual feedback then navigate home
                setTimeout(() => {
                    router.reset('/home');
                }, 500);
            });
        }

        // ================================================================
        // Storage Management Button Handlers (Debug tab)
        // ================================================================

        // Helper: refresh the usage display element after a clear action
        const _refreshUsageDisplay = () => {
            this._updateStorageUsageDisplay();
        };

        // ── Clear Image Cache ─────────────────────────────────────────────
        // Removes all libThumb:* cache entries. Safe to use at any time —
        // these are purely cosmetic and regenerate on the next home load.
        const clearImageCacheBtn = this.$('#btn-clear-image-cache');
        if (clearImageCacheBtn) {
            clearImageCacheBtn.addEventListener('click', () => {
                const removed = storage.clearByPrefix('libThumb:');
                clearImageCacheBtn.textContent = removed > 0 ? i18n.t('Done') : i18n.t('AlreadyEmpty');
                setTimeout(() => {
                    clearImageCacheBtn.textContent = i18n.t('Clear');
                }, 2000);
                _refreshUsageDisplay();
            });
        }

        // ── Clear Debug Filter History ────────────────────────────────────
        // Removes all debug_filter_* keys so the module filters start fresh.
        // Also clears the Logger's in-memory disabled-modules set so the
        // change takes effect immediately (no reload needed).
        const clearDebugFiltersBtn = this.$('#btn-clear-debug-filters');
        if (clearDebugFiltersBtn) {
            clearDebugFiltersBtn.addEventListener('click', () => {
                // Wipe from StorageService's in-memory cache and disk
                const removed = storage.clearByPrefix('debug_filter_');
                // Wipe the logger's runtime disabled-module set too
                // (logger exposes _disabledModules as part of its controlled surface)
                logger._disabledModules.clear();
                clearDebugFiltersBtn.textContent = removed > 0 ? i18n.t('Done') : i18n.t('AlreadyEmpty');
                setTimeout(() => {
                    clearDebugFiltersBtn.textContent = i18n.t('Clear');
                }, 2000);
                _refreshUsageDisplay();
            });
        }

        // ── Clear All Caches (auth-safe) ──────────────────────────────────
        // Removes all non-essential cache groups.
        //
        // IMPORTANT: We only clear known cache prefixes — we do NOT call
        // localStorage.clear() here. That would wipe auth tokens, server URL,
        // and user preferences, causing an unexpected signed-out state.
        //
        // Keys that are intentionally preserved:
        //   auth_*         — access token and user session
        //   server_url     — server connection
        //   pref:*         — user preferences
        //   player:*       — player settings
        //   app_*          — app settings (language, theme etc.)
        //   debug_*        — debug overlay config (logs enabled, position etc.)
        const clearAllBtn = this.$('#btn-clear-all-storage');
        if (clearAllBtn) {
            clearAllBtn.addEventListener('click', () => {
                clearAllBtn.disabled = true;
                clearAllBtn.textContent = i18n.t('Working');

                // Clear each non-essential cache group
                let totalRemoved = 0;
                totalRemoved += storage.clearByPrefix('libThumb:');

                // Also clear the logger's runtime disabled-module set
                logger._disabledModules.clear();

                clearAllBtn.disabled = false;
                clearAllBtn.textContent = totalRemoved > 0 ? i18n.t('Done') : i18n.t('AlreadyEmpty');
                setTimeout(() => {
                    clearAllBtn.textContent = i18n.t('ClearAll');
                }, 2500);
                _refreshUsageDisplay();
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
            'toggle-enable-flac-in-video',
            'toggle-enable-fmp4-hls',
            'toggle-force-fmp4-hls',
            'toggle-force-transcode',
            'toggle-force-direct-play',
            'toggle-background-service',
            // Interlaced content fallback — auto-switch to HTML5 when AVPlay
            // encounters interlaced H264 (1080i MPEG-TS in HLS). No profile
            // cache invalidation needed (device caps don't change), but keeping
            // it in this list wires the click → PlayerSettings.set() for us.
            'toggle-interlaced-backend-fallback'
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

        // Switch Users — navigate to the Who's Watching profile picker
        this.$('.switch-profiles-btn')?.addEventListener('click', () => {
            router.navigate('/profiles');
        });

        // Sign Out — logs out the active user (other server sessions preserved)
        this.$('.switch-user-btn')?.addEventListener('click', async () => {
            await auth.logout();
        });

        // Color Selection
        this.$$('.color-option').forEach((btn) => {
            const color = btn.dataset.color;
            const fillEl = btn.querySelector('.color-option-fill');

            // CSP-Safe styling: apply color via JS DOM API instead of inline HTML string style
            if (fillEl && color) {
                fillEl.style.backgroundColor = color;
            }

            btn.addEventListener('click', () => {
                layoutManager.setThemeColor(color);

                // Update UI state
                this.$$('.color-option').forEach((b) => b.classList.remove('active'));
                btn.classList.add('active');
            });
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

        // === Plugin Enable/Disable Toggles ===
        // Each plugin toggle button has a data-plugin-id attribute.
        // Wire them all using the same toggle pattern as the other settings switches.
        this.$$('[data-plugin-id]').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const pluginId = btn.dataset.pluginId;
                const isCurrentlyEnabled = btn.classList.contains('active');
                const newEnabled = !isCurrentlyEnabled;

                // Get the status badge element once for reuse
                const statusEl = btn.closest('.setting-item')?.querySelector('.plugin-status');

                // ── Disabling is always immediate, no server check needed ──────
                if (!newEnabled) {
                    btn.classList.remove('active');
                    if (statusEl) {
                        statusEl.className = 'plugin-status plugin-status--disabled';
                        statusEl.textContent = i18n.t('Disabled');
                    }
                    await pluginManager.setPluginEnabled(pluginId, false);
                    return;
                }

                // ── Enabling: check server dependency first ───────────────────
                // Check if this plugin requires a Jellyfin server plugin to function.
                const entry = pluginManager.getPlugin(pluginId);
                const hasDependency = !!entry?.plugin?.serverDependency;

                if (hasDependency) {
                    // Show a "checking..." interim state so the user knows something is happening
                    btn.disabled = true;
                    if (statusEl) {
                        statusEl.className = 'plugin-status plugin-status--pending';
                        statusEl.textContent = i18n.t('Checking');
                    }

                    try {
                        const depCheck = await pluginManager.checkServerDependency(pluginId);

                        if (!depCheck.available && !depCheck.deferred) {
                            // ── Server plugin is MISSING ─────────────────────
                            // Revert UI to disabled state and show an error modal
                            btn.disabled = false;
                            btn.classList.remove('active');
                            if (statusEl) {
                                statusEl.className = 'plugin-status plugin-status--disabled';
                                statusEl.textContent = i18n.t('Disabled');
                            }

                            // Show an informational error dialog using the existing modal overlay
                            this._showPluginDependencyError(entry.plugin.name || pluginId, depCheck.serverPluginName);
                            return;
                        }

                        // ── Dependency found (or deferred) — proceed to enable ─
                        // If deferred, we allow enabling tentatively (consistent with startup flow).
                        // The dependency will be re-confirmed at next playback.
                        if (depCheck.deferred) {
                            log.warn(
                                `Plugin '${pluginId}' dependency check deferred (non-admin, no itemId) — enabling tentatively`
                            );
                        }
                    } catch (err) {
                        // Network or unexpected error — fail open (allow enabling)
                        log.warn(`Plugin '${pluginId}' dependency check failed with error, enabling anyway:`, err);
                    }

                    btn.disabled = false;
                }

                // ── All clear — commit the enable ─────────────────────────────
                // Optimistically update toggle and status badge
                btn.classList.add('active');
                if (statusEl) {
                    statusEl.className = 'plugin-status plugin-status--active';
                    statusEl.textContent = i18n.t('Active');
                }
                await pluginManager.setPluginEnabled(pluginId, true);
            });
        });
    }

    /**
     * Populate the #storage-usage-display element in the Debug tab with a
     * live summary of localStorage usage pulled from StorageService's report.
     *
     * This is pure in-memory: the report reads from the StorageService Map,
     * so there is zero synchronous disk I/O involved.
     *
     * Called on mount when the debug tab is active, and after each clear action
     * so the numbers update in real time without a page reload.
     */
    _updateStorageUsageDisplay() {
        const el = this.$('#storage-usage-display');
        if (!el) return;

        // Pull the usage report from StorageService (all in-memory, instant)
        const report = storage.getStorageReport();

        // Internal byte formatter — keeps this self-contained
        const fmt = (bytes) => {
            if (bytes < 1024) return `${bytes} B`;
            if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
            return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
        };

        // Build a short summary: total + a list of the largest prefixes
        const topGroups = Object.entries(report.breakdown)
            .sort(([, a], [, b]) => b - a) // Descending by size
            .slice(0, 4) // Show top 4 groups
            .map(([prefix, bytes]) => `${prefix}: ${fmt(bytes)}`)
            .join(' · ');

        el.textContent = `${fmt(report.totalBytes)} across ${report.keyCount} keys — ${topGroups}`;
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
                        class="setting-slider" 
                        min="${min}" 
                        max="${max}" 
                        step="${step}" 
                        value="${value}"
                        data-unit="${unit}"
                        tabindex="0"
                        data-focusable="true">
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
            'subtitle-bottom-offset': 'subtitleBottomOffset',
            'subtitle-custom-size': 'subtitleSizeCustomValue'
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
                    const floatKeys = [
                        'subtitleFontScale',
                        'subtitleSizeCustomValue',
                        'subtitleOutlineThickness',
                        'subtitleShadowThickness',
                        'subtitleLetterSpacing'
                    ];
                    const val = floatKeys.includes(key) ? parseFloat(value) : parseInt(value, 10);
                    PlayerSettings.set(key, val);
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
        // Find current label (using String conversion to match storage strings with number options)
        const currentOption = options.find((o) => String(o.value) === String(currentValue)) || options[0];
        const currentLabel = currentOption ? i18n.ensureBiDi(currentOption.label) : i18n.t('Select');

        // Render as a button that triggers the modal
        return `
            <button class="setting-action-btn select-btn" id="${id}-btn" 
                    data-id="${id}" 
                    data-value="${currentValue}"
                    data-options='${JSON.stringify(options).replace(/'/g, '&#39;')}'
                    tabindex="0"
                    data-focusable="true">
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
                        .map((opt) => {
                            let badge = '';
                            if (opt.completeness !== undefined) {
                                const percentage = Math.floor(opt.completeness);
                                let innerBadge = '';
                                if (percentage === 0) {
                                    innerBadge = `<span class="track-badge lang-badge badge-danger">0%</span>`;
                                } else if (percentage < 85) {
                                    innerBadge = `<span class="track-badge lang-badge badge-warning">${percentage}%</span>`;
                                } else {
                                    innerBadge = `<span class="track-badge lang-badge badge-success">100%</span>`;
                                }
                                badge = `<span class="track-badges">${innerBadge}</span>`;
                            }
                            return `
                        <button class="modal-option-btn ${String(opt.value) === String(currentValue) ? 'selected' : ''}" 
                                data-value="${opt.value}"
                                tabindex="0">
                            <span style="margin-right: 12px;">${i18n.ensureBiDi(opt.label)}</span>
                            ${badge}
                        </button>
                    `;
                        })
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
        this.registerFocusSection('modal-options', overlay.querySelector('.modal-options'), {
            orientation: 'vertical',
            leaveDown: 'modal-actions',
            leaveUp: 'modal-actions',
            enterTo: 'last-focused'
        });

        this.registerFocusSection('modal-actions', overlay.querySelector('.modal-actions'), {
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
        focusManager.unregister('modal-error-content');

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

    /**
     * Show an error modal when a plugin requires a server dependency that isn't met.
     */
    _showPluginDependencyError(pluginName, dependencyName) {
        const overlay = this.$('#modal-overlay');
        if (!overlay) return;

        // Store focus context for restoration
        this._prevFocus = focusManager.getFocused();
        this._prevSection = focusManager.getActiveSection();

        const title = i18n.t('MissingServerPlugin') || 'Missing Server Plugin';
        const message =
            i18n.t('MissingServerPluginMessage', [pluginName, dependencyName]) ||
            `'${pluginName}' requires the '${dependencyName}' plugin to be installed and enabled on your Jellyfin server. Please install it via the Jellyfin dashboard and try again.`;
        const btnCloseText = i18n.t('ButtonClose') || 'Close';

        overlay.innerHTML = `
            <div class="settings-modal modal-error" role="dialog" aria-modal="true">
                <div class="modal-header">
                    <h2>${title}</h2>
                </div>
                <div class="modal-content" style="padding: 20px; font-size: 1.1em; color: var(--text-secondary); text-align: center; line-height: 1.5;">
                    ${message}
                </div>
                <div class="modal-actions" style="margin-top: 10px;">
                    <button class="modal-action-btn" id="btn-modal-error-ok" tabindex="0">${btnCloseText}</button>
                </div>
            </div>
        `;

        // Show Overlay
        overlay.classList.add('visible');
        overlay.setAttribute('aria-hidden', 'false');

        // Bind Events
        const btnOk = overlay.querySelector('#btn-modal-error-ok');
        btnOk.addEventListener('click', (e) => {
            e.stopPropagation();
            this._closeSelectionModal();
        });

        // Register Focus Section just for the action button
        this.registerFocusSection('modal-error-content', overlay.querySelector('.modal-actions'), {
            orientation: 'horizontal',
            enterTo: 'first'
        });

        // Set Focus
        focusManager.setActiveSection('modal-error-content');
        setTimeout(() => {
            focusManager.focusElement(btnOk);
        }, 50);
    }

    /**
     * Render the color selection grid
     */
    _renderColorOptions() {
        const colors = [
            // Row 1: Primary Swatches
            { name: 'Jellyfin Blue', hex: '#00a4dc' },
            { name: 'Litefin Blue', hex: '#007aff' },
            { name: 'Indigo', hex: '#5856d6' },
            { name: 'Royal Blue', hex: '#2962ff' },
            { name: 'Deep Purple', hex: '#6200ea' },
            { name: 'Lavender', hex: '#af52de' },
            { name: 'Purple Haze', hex: '#9d50bb' },
            { name: 'Magenta', hex: '#d500f9' },
            { name: 'Pink', hex: '#ff2d55' },
            { name: 'Rose', hex: '#ff007f' },

            // Row 2: Vibrant Palette
            { name: 'Red', hex: '#f44336' },
            { name: 'Orange', hex: '#ff9800' },
            { name: 'Amber', hex: '#ffc107' },
            { name: 'Yellow', hex: '#ffeb3b' },
            { name: 'Lime', hex: '#c6ff00' },
            { name: 'Green', hex: '#4caf50' },
            { name: 'Emerald', hex: '#00c853' },
            { name: 'Mint', hex: '#00c7be' },
            { name: 'Teal', hex: '#009688' },
            { name: 'Cyan', hex: '#00bcd4' },

            // Row 3: Sophisticated & Classic
            { name: 'Sky', hex: '#03a9f4' },
            { name: 'Ocean', hex: '#0077be' },
            { name: 'Slate', hex: '#607d8b' },
            { name: 'Graphite', hex: '#3a3a3c' },
            { name: 'Silver', hex: '#9e9e9e' },
            { name: 'Coffee', hex: '#795548' },
            { name: 'Brown', hex: '#a2845e' },
            { name: 'Copper', hex: '#b87333' },
            { name: 'Gold', hex: '#d4af37' },
            { name: 'White', hex: '#ffffff' }
        ];

        const currentColor = layoutManager.getThemeColor();

        return colors
            .map(
                (c) => `
            <div class="color-option ${currentColor === c.hex ? 'active' : ''}" 
                 data-color="${c.hex}"
                 title="${c.name}"
                 tabindex="0"
                 data-focusable="true">
                 <div class="color-option-fill"></div>
            </div>
        `
            )
            .join('');
    }

    _bindDropdownEvents() {
        // Use a map to handle setting IDs to storage keys/methods easily
        const settingsMap = {
            'library-thumb-mode-select': { key: 'pref:libraryThumbMode', type: 'local' },
            'app-language-select': { key: 'app_language', type: 'local' },
            'layout-direction-select': { key: 'layout_direction', type: 'local' },
            layout: { key: 'layout', type: 'local' },
            'theme-mode-select': { key: 'themeMode', type: 'local', triggerEvent: true },
            'ui-font-select': { key: 'uiFont', type: 'local' },
            'image-quality-select': { key: 'imageQuality', type: 'service' },
            'details-image-quality-select': { key: 'detailsImageQuality', type: 'details-service' },
            'max-resolution-select': { key: 'maxResolution', type: 'player' },
            'player-backend-select': { key: 'playerBackend', type: 'player' },
            'max-bitrate-select': { key: 'maxBitrateInternet', type: 'player' },
            'trailer-playback-select': { key: 'trailerPlaybackMode', type: 'player' },
            'audio-lang-select': { key: 'pref:audioLang', type: 'local' },
            'subtitle-lang-select': { key: 'pref:subtitleLang', type: 'local' },
            'skip-forward-select': { key: 'skipForwardLength', type: 'player' },
            'skip-back-select': { key: 'skipBackLength', type: 'player' },
            'subtitle-mode-select': { key: 'subtitleMode', type: 'player' },
            // Subtitle delivery mode — drives SubtitleProfiles in DeviceProfile
            'subtitle-burn-in-select': { key: 'subtitleBurnIn', type: 'player' },
            'pgs-playback-mode-select': { key: 'pgsPlaybackMode', type: 'player' },
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
            'debug-position-select': { key: 'debug_position', type: 'debug' },
            'screensaver-delay-select': { key: 'pref:screensaverDelay', type: 'local', triggerEvent: true },
            'screensaver-type-select': { key: 'pref:screensaverType', type: 'local', triggerEvent: true },
            'backdrop-dimmer-select': { key: 'pref:backdropDimmer', type: 'local', triggerEvent: true },
            'time-format-select': { key: 'timeFormat', type: 'player' },
            /*
             * OSD focus restore mode — read live by OSDController._applyFocusRestoreMode()
             * every time the OSD transitions from hidden to visible. No extra handler needed.
             */
            'osd-focus-mode-select': { type: 'player', key: 'osdFocusRestoreMode' },
            'osd-time-display-select': { type: 'player', key: 'osdTimeDisplayMode' },

            // Per-segment-type skip action — read by the skip-intro plugin on each onPlayerStart
            'segment-action-intro-select': { type: 'player', key: 'skipActionIntro' },
            'segment-action-outro-select': { type: 'player', key: 'skipActionOutro' },
            'segment-action-recap-select': { type: 'player', key: 'skipActionRecap' },
            'segment-action-preview-select': { type: 'player', key: 'skipActionPreview' },

            'webos-buffer-gate-select': { type: 'player', key: 'webosBufferGate' },
            'webos-stall-recovery-select': { type: 'player', key: 'webosStallRecovery' },
            'webos-segment-length-select': { type: 'player', key: 'webosSegmentLength' },

            'tizen-initial-buffer-select': { type: 'player', key: 'tizenInitialBuffer' },
            'tizen-resume-buffer-select': { type: 'player', key: 'tizenResumeBuffer' },
            'tizen-segment-length-select': { type: 'player', key: 'tizenSegmentLength' },

            'html5-max-buffer-select': { type: 'player', key: 'html5MaxBufferLength' },
            'html5-max-max-buffer-select': { type: 'player', key: 'html5MaxMaxBufferLength' },
            'html5-segment-length-select': { type: 'player', key: 'html5SegmentLength' },

            'text-scale-select': { key: 'litefin:textScale', type: 'local' },
            'next-up-max-days-select': { key: 'pref:nextUpMaxDays', type: 'local' },
            'score-visibility-select': { key: 'pref:scoreVisibility', type: 'local' },
            'library-page-size-select': { key: 'pref:libraryPageSize', type: 'local' },
            'hero-carousel-style-select': { key: 'pref:heroCarouselStyle', type: 'local' },
            'hero-image-quality-select': { key: 'pref:heroImageQuality', type: 'local' },
            'hero-carousel-interval-select': { key: 'pref:heroCarouselInterval', type: 'local' },
            'hero-carousel-count-select': { key: 'pref:heroCarouselCount', type: 'local' },
            'sidebar-mode-select': { key: 'pref:sidebarMode', type: 'local' },
            'osd-button-borders-select': { key: 'litefin:osdButtonBorders', type: 'local' }
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
                    const newLabel = options.find((o) => String(o.value) === String(newValue))?.label;
                    const labelSpan = btn.querySelector('.btn-label');
                    if (labelSpan) labelSpan.innerText = newLabel;
                    btn.dataset.value = newValue;

                    // Save Setting based on type
                    if (settingConfig) {
                        if (id === 'theme-mode-select') {
                            layoutManager.setThemeMode(newValue);
                        } else if (id === 'ui-font-select') {
                            // SPECIAL CASE: Font changes handled by LayoutManager
                            layoutManager.setUiFont(newValue);
                        } else if (id === 'text-scale-select') {
                            // SPECIAL CASE: Text Scale handled by LayoutManager
                            layoutManager.setTextScale(parseFloat(newValue));
                        } else if (id === 'osd-button-borders-select') {
                            // SPECIAL CASE: OSD Button Borders handled by LayoutManager
                            layoutManager.setOsdButtonBorders(newValue);
                        } else if (id === 'sidebar-mode-select') {
                            storage.setItem('pref:sidebarMode', newValue);
                            document.body.classList.toggle('sidebar-mode-hidden', newValue === 'hidden');
                            focusManager.invalidateCache('sidebar');
                            focusManager.invalidateCache('home');
                        } else if (settingConfig.type === 'local') {
                            storage.setItem(settingConfig.key, newValue);

                            if (settingConfig.triggerEvent) {
                                eventBus.emit(settingConfig.key, newValue);
                            }

                            if (
                                settingConfig.key === 'layout' ||
                                settingConfig.key === 'layout_direction' ||
                                settingConfig.key === 'app_language'
                            ) {
                                /*
                                 * ----------------------------------------------------------------
                                 * Language/Layout changes need a TRUE hard reload.
                                 *
                                 * WHY window.location.reload() BREAKS ON TIZEN/WEBOS:
                                 * On these platforms, reload() is a *soft* reload — the JS
                                 * module cache is preserved. The 'app' singleton stays alive
                                 * with _initialized=true, so App.init() exits early without
                                 * ever calling i18n.init(). The dictionary stays {}, causing
                                 * all i18n.t() calls to return raw key strings.
                                 *
                                 * FIX: Navigate to the app's root entry-point URL *without
                                 * the hash fragment*. The WebView treats this as a fresh
                                 * cold-start navigation, fully re-parsing and re-executing
                                 * all JS modules from scratch — identical to a native restart.
                                 * ----------------------------------------------------------------
                                 */
                                storage.flush();

                                // Compute the base URL (strips the hash / current route)
                                const href = window.location.href;
                                const protocol = window.location.protocol;
                                let entryUrl;

                                if (protocol === 'file:') {
                                    // file:// packaged app — strip everything from '#' onward
                                    entryUrl = href.split('#')[0];
                                } else {
                                    // http(s):// dev server — use origin + pathname (no hash)
                                    entryUrl = window.location.origin + window.location.pathname;
                                }

                                // Hard-navigate: forces a true cold-start re-init on all platforms
                                window.location.href = entryUrl;
                            }

                            if (settingConfig.key === 'pref:libraryThumbMode') {
                                const libraryThumbContainer = this.$('#library-thumb-regenerate-container');
                                if (libraryThumbContainer) {
                                    libraryThumbContainer.style.display = newValue === 'static' ? '' : 'none';
                                    focusManager.invalidateCache('settings-content');
                                }
                            }

                            if (id === 'screensaver-type-select') {
                                const dimContainer = document.getElementById('screensaver-dim-item');
                                const hideTextContainer = document.getElementById('screensaver-hide-text-item');
                                const musicContainer = document.getElementById('screensaver-include-music-item');
                                const isBackdrop = newValue === 'backdrop';

                                if (dimContainer) {
                                    dimContainer.classList.toggle('hidden', !isBackdrop);
                                }
                                if (hideTextContainer) {
                                    hideTextContainer.classList.toggle('hidden', !isBackdrop);
                                }
                                if (musicContainer) {
                                    musicContainer.classList.toggle('hidden', !isBackdrop);
                                }
                                focusManager.invalidateCache('settings-content');
                            }
                        } else if (settingConfig.type === 'service') {
                            imageService.setPreset(newValue);
                        } else if (settingConfig.type === 'details-service') {
                            imageService.setDetailsPreset(newValue);
                        } else if (settingConfig.type === 'player') {
                            // Numeric settings need parseFloat/parseInt conversion
                            const floatKeys = ['webosBufferGate'];
                            const intKeys = [
                                'skipForwardLength',
                                'skipBackLength',
                                'maxBitrateInternet',
                                'webosStallRecovery',
                                'webosSegmentLength',
                                'tizenInitialBuffer',
                                'tizenResumeBuffer',
                                'tizenSegmentLength',
                                'html5MaxBufferLength',
                                'html5MaxMaxBufferLength',
                                'html5SegmentLength'
                            ];

                            let val = newValue;
                            if (floatKeys.includes(settingConfig.key)) {
                                val = parseFloat(newValue);
                            } else if (intKeys.includes(settingConfig.key)) {
                                val = parseInt(newValue, 10);
                            }
                            PlayerSettings.set(settingConfig.key, val);

                            // Trigger complete tab re-render when changing player backend to show the correct buffering options
                            if (settingConfig.key === 'playerBackend') {
                                this._switchTab('player', false, true);
                                return; // Skip further processing, DOM is refreshed
                            }

                            // Invalidate cached device capabilities when profile-affecting settings change
                            if (
                                settingConfig.key === 'maxResolution' ||
                                settingConfig.key === 'maxBitrateInternet' ||
                                settingConfig.key === 'pgsPlaybackMode' ||
                                settingConfig.key === 'webosSegmentLength' ||
                                settingConfig.key === 'tizenSegmentLength' ||
                                settingConfig.key === 'html5SegmentLength'
                            ) {
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

        // Toggle Switch for Remember Tracks
        const rememberTracksToggle = this.$('#subtitle-remember-tracks-toggle');
        if (rememberTracksToggle) {
            rememberTracksToggle.addEventListener('click', () => {
                const currentValue = PlayerSettings.get('rememberTracksForSession') !== false;
                const newValue = !currentValue;
                PlayerSettings.set('rememberTracksForSession', newValue);
                rememberTracksToggle.classList.toggle('active', newValue);
                log.info(`Remember Tracks For Session set to: ${newValue}`);
            });
        }

        // Toggle Switch for Confirm App Exit
        const confirmExitToggle = this.$('#toggle-confirm-exit');
        if (confirmExitToggle) {
            confirmExitToggle.addEventListener('click', () => {
                const currentValue = storage.getItem('pref:confirmExit') === 'true';
                const newValue = !currentValue;
                storage.setItem('pref:confirmExit', newValue);
                confirmExitToggle.classList.toggle('active', newValue);
                log.info(`Confirm Exit set to: ${newValue}`);
            });
        }

        // Toggle Switch for Sidebar Clickable Logo
        const logoSettingsToggle = this.$('#toggle-sidebar-logo-settings');
        if (logoSettingsToggle) {
            logoSettingsToggle.addEventListener('click', () => {
                const currentValue = storage.getItem('pref:logoSettings') === 'true';
                const newValue = !currentValue;
                storage.setItem('pref:logoSettings', newValue.toString());
                logoSettingsToggle.classList.toggle('active', newValue);
                eventBus.emit('prefChanged:logoSettings', newValue);
                log.info(`Clickable Logo set to: ${newValue}`);
            });
        }

        // Toggle Switch for Disable Sidebar Animation
        const disableAnimationToggle = this.$('#toggle-disable-sidebar-animation');
        if (disableAnimationToggle) {
            disableAnimationToggle.addEventListener('click', () => {
                const currentValue = storage.getItem('pref:disableSidebarAnimation') === 'true';
                const newValue = !currentValue;
                storage.setItem('pref:disableSidebarAnimation', newValue.toString());
                disableAnimationToggle.classList.toggle('active', newValue);
                eventBus.emit('prefChanged:disableSidebarAnimation', newValue);
                log.info(`Disable Sidebar Animation set to: ${newValue}`);
            });
        }

        // Toggle Switch for Trailer Auto-Chain
        const trailerAutoChainToggle = this.$('#toggle-trailer-auto-chain');
        if (trailerAutoChainToggle) {
            trailerAutoChainToggle.addEventListener('click', () => {
                const currentValue = PlayerSettings.get('trailerAutoChain');
                const newValue = !currentValue;
                PlayerSettings.set('trailerAutoChain', newValue);
                trailerAutoChainToggle.classList.toggle('active', newValue);
                log.info(`Trailer Auto-Chain set to: ${newValue}`);
            });
        }

        // Toggle Switch for Seek With Arrows
        const seekWithArrowsToggle = this.$('#toggle-seek-with-arrows');
        if (seekWithArrowsToggle) {
            seekWithArrowsToggle.addEventListener('click', () => {
                const currentValue = PlayerSettings.get('seekWithArrows');
                const newValue = !currentValue;
                PlayerSettings.set('seekWithArrows', newValue);
                seekWithArrowsToggle.classList.toggle('active', newValue);
                log.info(`Seek with Arrows set to: ${newValue}`);
            });
        }

        // Toggle Switch for Magic Cursor
        const magicCursorToggle = this.$('#toggle-magic-cursor');
        if (magicCursorToggle) {
            magicCursorToggle.addEventListener('click', () => {
                const currentValue = PlayerSettings.get('enableMagicCursor');
                const newValue = !currentValue;
                PlayerSettings.set('enableMagicCursor', newValue);
                magicCursorToggle.classList.toggle('active', newValue);
                log.info(`Magic Cursor set to: ${newValue}`);
            });
        }

        // Toggle Switch for Scroll Navigation
        const hoverScrollNavToggle = this.$('#toggle-hover-scroll-nav');
        if (hoverScrollNavToggle) {
            hoverScrollNavToggle.addEventListener('click', () => {
                const currentValue = storage.getItem('pref:hoverScrollNavigation') === 'true';
                const newValue = !currentValue;
                storage.setItem('pref:hoverScrollNavigation', newValue.toString());
                hoverScrollNavToggle.classList.toggle('active', newValue);
                log.info(`Scroll Navigation set to: ${newValue}`);
            });
        }

        // Toggle Switch for Hover Trickplay
        const hoverTrickplayToggle = this.$('#toggle-hover-trickplay');
        if (hoverTrickplayToggle) {
            hoverTrickplayToggle.addEventListener('click', () => {
                const currentValue = PlayerSettings.get('enableHoverTrickplay');
                const newValue = !currentValue;
                PlayerSettings.set('enableHoverTrickplay', newValue);
                hoverTrickplayToggle.classList.toggle('active', newValue);
                log.info(`Hover Trickplay set to: ${newValue}`);
            });
        }

        // Toggle Switch for Show Added Date
        const showAddedDateToggle = this.$('#toggle-show-added-date');
        if (showAddedDateToggle) {
            showAddedDateToggle.addEventListener('click', () => {
                const currentValue = storage.getItem('pref:showAddedDate') === 'true';
                const newValue = !currentValue;
                storage.setItem('pref:showAddedDate', newValue.toString());
                showAddedDateToggle.classList.toggle('active', newValue);
                log.info(`Show Added Date set to: ${newValue}`);
            });
        }

        // Toggle Switch for Show Date Aired
        const showDateAiredToggle = this.$('#toggle-show-date-aired');
        if (showDateAiredToggle) {
            showDateAiredToggle.addEventListener('click', () => {
                const currentValue = storage.getItem('pref:showDateAired') === 'true';
                const newValue = !currentValue;
                storage.setItem('pref:showDateAired', newValue.toString());
                showDateAiredToggle.classList.toggle('active', newValue);
                log.info(`Show Date Aired set to: ${newValue}`);
            });
        }

        // Toggle Switch for Auto Update Check
        const autoUpdateToggle = this.$('#toggle-check-updates');
        if (autoUpdateToggle) {
            autoUpdateToggle.addEventListener('click', () => {
                const currentValue = storage.getItem('pref:checkForUpdates') !== 'false';
                const newValue = !currentValue;
                storage.setItem('pref:checkForUpdates', newValue.toString());
                autoUpdateToggle.classList.toggle('active', newValue);
                log.info(`Auto Update Check set to: ${newValue}`);
            });
        }

        // Button for Manual Update Check
        const manualUpdateBtn = this.$('#btn-check-updates');
        if (manualUpdateBtn) {
            manualUpdateBtn.addEventListener('click', () => {
                versionChecker.checkUpdate(true);
            });
        }

        // Toggle Switch for Unlock My Media Order
        const unlockMyMediaOrderToggle = this.$('#toggle-unlock-my-media-order');
        if (unlockMyMediaOrderToggle) {
            unlockMyMediaOrderToggle.addEventListener('click', () => {
                const currentValue = storage.getItem('pref:unlockMyMediaOrder') === 'true';
                const newValue = !currentValue;
                storage.setItem('pref:unlockMyMediaOrder', newValue.toString());
                unlockMyMediaOrderToggle.classList.toggle('active', newValue);
                this._setupHomeLayoutUI();
                log.info(`Unlock My Media Order set to: ${newValue}`);
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

        // Initial Visibility Check for Custom Size
        const customSizeContainer = document.getElementById('subtitle-custom-size-container');
        if (customSizeContainer) {
            const currentSize = PlayerSettings.get('subtitleSize');
            if (currentSize === 'custom') {
                customSizeContainer.style.display = '';
            } else {
                customSizeContainer.style.display = 'none';
            }
        }

        // Initial Visibility Checks for Shadow Properties
        const shadowStyle = PlayerSettings.get('subtitleDropShadow');
        const borderWidthContainer = document.getElementById('subtitle-border-width-container');
        if (borderWidthContainer) {
            borderWidthContainer.style.display = shadowStyle === 'border' ? '' : 'none';
        }

        const opacityContainer = document.getElementById('subtitle-shadow-opacity-container');
        if (opacityContainer) {
            opacityContainer.style.display = shadowStyle === 'none' || shadowStyle === 'border' ? 'none' : '';
        }

        // Initial Visibility Checks for ASS Overrides
        const assOverride = PlayerSettings.get('subtitleOverrideAssOutlineShadow') !== false;
        const outlineThicknessContainer = document.getElementById('subtitle-outline-thickness-container');
        if (outlineThicknessContainer) {
            outlineThicknessContainer.style.display = assOverride ? '' : 'none';
        }

        const shadowThicknessContainer = document.getElementById('subtitle-shadow-thickness-container');
        if (shadowThicknessContainer) {
            shadowThicknessContainer.style.display = assOverride ? '' : 'none';
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

    _switchTab(tabId, force = false, focusContent = false) {
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

            // Apply translations to the newly rendered content
            i18n.translateDOM(panel);

            this._bindContentEvents(); // Re-bind events for new content

            if (tabId === 'home') {
                this._setupHomeLayoutUI();
            } else if (tabId === 'sidebar') {
                this._setupSidebarLayoutUI();
            }

            // Populate the live storage usage display whenever the debug tab is opened.
            // _bindContentEvents() already wired the buttons; this fills in the initial numbers.
            if (tabId === 'debug') {
                this._updateStorageUsageDisplay();
            }

            focusManager.invalidateCache('settings-content');
            this._setupFocus();

            if (focusContent) {
                focusManager.setActiveSection('settings-content', true);
            }
        }
    }

    async _setupSidebarLayoutUI() {
        const topContainer = this.$('#sidebar-layout-container');
        const libContainer = this.$('#sidebar-lib-layout-container');
        const focusSelectContainer = this.$('#sidebar-focus-select-container');
        if (!topContainer) return;

        try {
            // 1. Fetch live views explicitly so we build the layout config correctly
            const viewsResponse = await api.getUserViews();
            const views = viewsResponse.Items || [];

            // Build base list of live items (static ones)
            const liveStaticItems = sidebarLayoutManager
                .getStaticItems()
                .map((s) => ({ ...s, label: i18n.t(s.label) || s.label }));
            // Build live libraries
            const liveLibraries = views.map((lib) => ({ id: `lib-${lib.Id}`, label: lib.Name }));

            // 2. Extract configs
            const layoutVars = sidebarLayoutManager.buildSettingsLayout(liveStaticItems);
            const libraryVars = sidebarLayoutManager.buildLibrarySettingsLayout(liveLibraries);

            const buildListHtml = (vars) => {
                return vars
                    .map((item, index) => {
                        const isFirst = index === 0;
                        const isLast = index === vars.length - 1;
                        const isLocked = item.locked; // 'home' is locked
                        return `
                    <div class="setting-item layout-row ${item.hidden && !isLocked ? 'layout-row-hidden' : ''}" data-id="${item.id}" data-index="${index}">
                        <div class="setting-label">
                            <span class="setting-name layout-row-title">${item.label}</span>
                        </div>
                        <div class="setting-control layout-btns" dir="ltr">
                            <button class="btn btn-icon layout-btn-up" tabindex="0" ${isFirst ? 'disabled' : ''} aria-label="Move Up">
                                <svg viewBox="0 0 24 24"><path fill="currentColor" d="M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z"/></svg>
                            </button>
                            <button class="btn btn-icon layout-btn-down" tabindex="0" ${isLast ? 'disabled' : ''} aria-label="Move Down">
                                <svg viewBox="0 0 24 24"><path fill="currentColor" d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/></svg>
                            </button>
                            <button class="btn btn-icon layout-btn-toggle" tabindex="0" ${isLocked ? 'disabled style="opacity:0.3"' : ''} aria-label="${!item.hidden || isLocked ? 'Hide' : 'Show'}">
                                ${
                                    !item.hidden || isLocked
                                        ? '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>'
                                        : '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z"/></svg>'
                                }
                            </button>
                        </div>
                    </div>`;
                    })
                    .join('');
            };

            const bindContainerEvents = (containerDOM, varsArray, renderCallback) => {
                const saveAndNotify = () => {
                    const config = sidebarLayoutManager.getSavedConfig() || { defaultFocus: 'home' };
                    config.items = layoutVars.map(({ id, hidden, order }) => ({ id, hidden, order }));
                    config.libraryItems = libraryVars.map(({ id, hidden, order }) => ({ id, hidden, order }));
                    sidebarLayoutManager.saveConfig(config);
                    eventBus.emit('prefChanged:sidebarLayout');
                };

                containerDOM.querySelectorAll('.layout-btn-up').forEach((btn) => {
                    btn.addEventListener('click', (e) => {
                        const row = e.target.closest('.layout-row');
                        const idx = parseInt(row.dataset.index, 10);
                        if (idx > 0) {
                            const temp = varsArray[idx - 1];
                            varsArray[idx - 1] = varsArray[idx];
                            varsArray[idx] = temp;
                            saveAndNotify();
                            renderCallback();
                            setTimeout(() => {
                                const newRow = containerDOM.querySelector(`.layout-row[data-index="${idx - 1}"]`);
                                if (newRow) focusManager.focusElement(newRow.querySelector('.layout-btn-up'));
                            }, 50);
                        }
                    });
                });

                containerDOM.querySelectorAll('.layout-btn-down').forEach((btn) => {
                    btn.addEventListener('click', (e) => {
                        const row = e.target.closest('.layout-row');
                        const idx = parseInt(row.dataset.index, 10);
                        if (idx < varsArray.length - 1) {
                            const temp = varsArray[idx + 1];
                            varsArray[idx + 1] = varsArray[idx];
                            varsArray[idx] = temp;
                            saveAndNotify();
                            renderCallback();
                            setTimeout(() => {
                                const newRow = containerDOM.querySelector(`.layout-row[data-index="${idx + 1}"]`);
                                if (newRow) focusManager.focusElement(newRow.querySelector('.layout-btn-down'));
                            }, 50);
                        }
                    });
                });

                containerDOM.querySelectorAll('.layout-btn-toggle').forEach((btn) => {
                    btn.addEventListener('click', (e) => {
                        const row = e.target.closest('.layout-row');
                        const idx = parseInt(row.dataset.index, 10);
                        if (varsArray[idx].locked) return; // double check

                        varsArray[idx].hidden = !varsArray[idx].hidden;

                        if (varsArray[idx].hidden) {
                            const currentFocus = sidebarLayoutManager.getDefaultFocus();
                            if (currentFocus === varsArray[idx].id) {
                                const config = sidebarLayoutManager.getSavedConfig() || {};
                                config.defaultFocus = 'home';
                                sidebarLayoutManager.saveConfig(config);
                            }
                        }

                        saveAndNotify();
                        renderCallback();
                        setTimeout(() => {
                            const newRow = containerDOM.querySelector(`.layout-row[data-index="${idx}"]`);
                            if (newRow) focusManager.focusElement(newRow.querySelector('.layout-btn-toggle'));
                        }, 50);
                    });
                });
            };

            const renderUI = () => {
                if (layoutVars.length === 0) {
                    topContainer.innerHTML = `<span class="setting-description">No layout configuration available.</span>`;
                    return;
                }

                // Render default focus dropdown using currently visible items
                if (focusSelectContainer) {
                    // Combine both lists for the focus target choices
                    const visibleItems = layoutVars.filter((v) => !v.hidden || v.locked);

                    const defaultFocus = sidebarLayoutManager.getDefaultFocus();

                    // Only static items are valid targets for initial focus, excluding the libraries container itself
                    const validTargets = visibleItems.filter((v) => v.id !== 'librariesContainer');

                    const options = validTargets.map((item) => ({ value: item.id, label: item.label }));

                    focusSelectContainer.innerHTML = this._renderDropdown(
                        'sidebar-default-focus-select',
                        options,
                        defaultFocus
                    );

                    const btn = focusSelectContainer.querySelector('.select-btn');
                    if (btn) {
                        btn.addEventListener('click', () => {
                            const title = i18n.t('InitialSidebarFocus') || 'Initial Sidebar Focus';
                            this._renderSelectionModal(title, options, btn.dataset.value, (newValue) => {
                                // Update button UI
                                const newLabel = options.find((o) => String(o.value) === String(newValue))?.label;
                                const labelSpan = btn.querySelector('.btn-label');
                                if (labelSpan) labelSpan.innerText = newLabel;
                                btn.dataset.value = newValue;

                                // Save Setting
                                const config = sidebarLayoutManager.getSavedConfig() || {
                                    items: layoutVars,
                                    libraryItems: libraryVars
                                };
                                config.defaultFocus = newValue;
                                sidebarLayoutManager.saveConfig(config);
                                eventBus.emit('prefChanged:sidebarLayout');
                            });
                        });
                    }
                }

                // Render both reorderable lists
                topContainer.innerHTML = `<div class="home-layout-list">${buildListHtml(layoutVars)}</div>`;
                if (libContainer) {
                    libContainer.innerHTML = `<div class="home-layout-list">${buildListHtml(libraryVars)}</div>`;
                    bindContainerEvents(libContainer, libraryVars, renderUI);
                }

                bindContainerEvents(topContainer, layoutVars, renderUI);

                // Clear layout focus cache
                focusManager.invalidateCache('settings-content');
            };

            renderUI();
        } catch (e) {
            log.error('Failed to load sidebar layouts', e);
            topContainer.innerHTML = `<span class="setting-description">Error loading layouts.</span>`;
        }
    }

    async _setupHomeLayoutUI() {
        const container = this.$('#home-layout-container');
        if (!container) return;

        try {
            // Fetch default descriptors exactly as HomePage does
            const viewsResponse = await api.getUserViews();
            const views = viewsResponse.Items || [];

            // Build the base descriptors
            const mergeResumeNextUp = storage.getItem('pref:mergeResumeNextUp') === 'true';
            const descriptors = [
                { id: 'my-media', title: i18n.t('HeaderMyMedia') },
                { id: 'resume', title: i18n.t('HeaderContinueWatching') }
            ];

            // If merging is enabled, 'next-up' is handled as part of 'resume' row,
            // so we hide it from the standalone layout sorting to avoid confusion.
            if (!mergeResumeNextUp) {
                descriptors.push({ id: 'next-up', title: i18n.t('NextUp') });
            }

            views.forEach((lib) => {
                descriptors.push({
                    id: `latest-${lib.Id}`,
                    title: i18n.t('LatestFromLibrary', [lib.Name])
                });
            });

            // Reconcile with saved layout
            const layoutVars = homeLayoutManager.buildSettingsLayout(descriptors);

            const renderLayoutList = () => {
                if (layoutVars.length === 0) {
                    container.innerHTML = `<span class="setting-description">No layout configuration available.</span>`;
                    return;
                }

                const listHtml = layoutVars
                    .map((item, index) => {
                        const isLocked = item.locked;
                        const isFirst = index === 0 || (index > 0 && layoutVars[index - 1].locked);
                        const isLast =
                            index === layoutVars.length - 1 ||
                            (index < layoutVars.length - 1 && layoutVars[index + 1].locked);

                        return `
                        <div class="setting-item layout-row ${item.hidden ? 'layout-row-hidden' : ''}" data-id="${item.id}" data-index="${index}">
                            <div class="setting-label">
                                <span class="setting-name layout-row-title">${item.title}</span>
                            </div>
                            <div class="setting-control layout-btns" dir="ltr">
                                <button class="btn btn-icon layout-btn-up" tabindex="0" ${isFirst || isLocked ? 'disabled style="opacity:0.3"' : ''} aria-label="Move Up">
                                    <svg viewBox="0 0 24 24"><path fill="currentColor" d="M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z"/></svg>
                                </button>
                                <button class="btn btn-icon layout-btn-down" tabindex="0" ${isLast || isLocked ? 'disabled style="opacity:0.3"' : ''} aria-label="Move Down">
                                    <svg viewBox="0 0 24 24"><path fill="currentColor" d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/></svg>
                                </button>
                                <button class="btn btn-icon layout-btn-toggle" tabindex="0" aria-label="${item.hidden ? 'Show' : 'Hide'}">
                                    ${
                                        item.hidden
                                            ? '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z"/></svg>'
                                            : '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>'
                                    }
                                </button>
                            </div>
                        </div>
                    `;
                    })
                    .join('');

                container.innerHTML = `<div class="home-layout-list">${listHtml}</div>`;

                // Bind interactivity
                container.querySelectorAll('.layout-btn-up').forEach((btn) => {
                    btn.addEventListener('click', (e) => {
                        const row = e.target.closest('.layout-row');
                        const idx = parseInt(row.dataset.index, 10);
                        if (idx > 0 && !layoutVars[idx].locked && !layoutVars[idx - 1].locked) {
                            // Swap with preceding
                            const temp = layoutVars[idx - 1];
                            layoutVars[idx - 1] = layoutVars[idx];
                            layoutVars[idx] = temp;
                            homeLayoutManager.saveLayout(layoutVars);
                            renderLayoutList();

                            // Re-focus the UP button on the moved row (which is now at idx - 1)
                            setTimeout(() => {
                                const newRow = container.querySelector(`.layout-row[data-index="${idx - 1}"]`);
                                if (newRow) focusManager.focusElement(newRow.querySelector('.layout-btn-up'));
                            }, 50);
                        }
                    });
                });

                container.querySelectorAll('.layout-btn-down').forEach((btn) => {
                    btn.addEventListener('click', (e) => {
                        const row = e.target.closest('.layout-row');
                        const idx = parseInt(row.dataset.index, 10);
                        if (idx < layoutVars.length - 1 && !layoutVars[idx].locked && !layoutVars[idx + 1].locked) {
                            // Swap with succeeding
                            const temp = layoutVars[idx + 1];
                            layoutVars[idx + 1] = layoutVars[idx];
                            layoutVars[idx] = temp;
                            homeLayoutManager.saveLayout(layoutVars);
                            renderLayoutList();

                            // Re-focus the DOWN button on the moved row (which is now at idx + 1)
                            setTimeout(() => {
                                const newRow = container.querySelector(`.layout-row[data-index="${idx + 1}"]`);
                                if (newRow) focusManager.focusElement(newRow.querySelector('.layout-btn-down'));
                            }, 50);
                        }
                    });
                });

                container.querySelectorAll('.layout-btn-toggle').forEach((btn) => {
                    btn.addEventListener('click', (e) => {
                        const row = e.target.closest('.layout-row');
                        const idx = parseInt(row.dataset.index, 10);
                        layoutVars[idx].hidden = !layoutVars[idx].hidden;
                        homeLayoutManager.saveLayout(layoutVars);
                        renderLayoutList();

                        setTimeout(() => {
                            const newRow = container.querySelector(`.layout-row[data-index="${idx}"]`);
                            if (newRow) focusManager.focusElement(newRow.querySelector('.layout-btn-toggle'));
                        }, 50);
                    });
                });

                // Clear layout focus cache
                focusManager.invalidateCache('settings-content');
            };

            renderLayoutList();
        } catch (e) {
            log.error('Failed to load layouts', e);
            container.innerHTML = `<span class="setting-description">Error loading layouts.</span>`;
        }
    }

    _setupFocus() {
        // Navigation: Sidebar <-> Content
        // We define these purely logically (LTR space).
        // FocusManager automatically inverts 'leaveLeft' and 'leaveRight' when document dir is 'rtl'.
        this.registerFocusSection('settings-sidebar', this.$('#settings-sidebar'), {
            orientation: 'vertical',
            leaveRight: 'settings-content',
            leaveLeft: 'sidebar',
            enterTo: 'last-focused',
            defaultFocusSelector: '.settings-menu-btn.active'
        });

        this.registerFocusSection('settings-content', this.$('#settings-content-panel'), {
            orientation: 'grid',
            leaveLeft: 'settings-sidebar',
            leaveRight: null,
            enterTo: 'first',
            onMove: (direction, currentElement) => {
                // 0. Check for explicit navigation override (highest priority)
                if (currentElement) {
                    const navOverride = currentElement.getAttribute(`data-nav-${direction}`);
                    if (navOverride) {
                        const target = document.querySelector(navOverride);
                        if (target) {
                            focusManager.focusElement(target);
                            return true;
                        }
                    }
                }

                // To prevent the "diagonal trap" where pressing left from a right-aligned setting control
                if (direction === 'left' && currentElement) {
                    const row = currentElement.closest('.setting-item');
                    if (row) {
                        // Find all focusable elements in THIS specific row
                        const focusSelector = 'a, button, input, select, [tabindex]:not([tabindex="-1"])';
                        const candidates = Array.from(row.querySelectorAll(focusSelector)).filter(
                            (el) => el.tabIndex !== -1 && !el.disabled && el.offsetParent !== null
                        );

                        // Use SpatialNavigator to see if there's anything to the left within the SAME row
                        const nextInRow = spatialNavigator.findNext(currentElement, candidates, 'left');

                        // If nothing is to the left in this row, immediately escape to the sidebar
                        if (!nextInRow) {
                            focusManager._leaveSection('left');
                            return true; // Handled
                        }
                    } else {
                        // If not in a setting-item (fallback), just escape
                        focusManager._leaveSection('left');
                        return true;
                    }
                }
                return false;
            }
        });
    }

    /**
     * Show a confirmation dialog before resetting all settings.
     * @private
     */
    _showResetConfirmation() {
        const prevFocus = focusManager.getFocused();
        const prevSection = focusManager.getActiveSection();

        const overlay = document.createElement('div');
        overlay.id = 'reset-settings-dialog';
        overlay.className = 'modal-overlay visible';
        document.body.appendChild(overlay);

        overlay.innerHTML = `
            <div class="settings-modal exit-dialog-modal" role="dialog" aria-modal="true" aria-label="${i18n.t('LabelResetSettings')}">
                <div class="modal-header">
                    <h2>${i18n.t('LabelResetSettings')}</h2>
                </div>
                <div class="modal-content" style="padding: 0 24px 24px; color: var(--text-color); font-size: 1.1rem; text-align: center;">
                    ${i18n.t('ResetSettingsWarning')}
                </div>
                <div class="modal-actions" id="reset-dialog-actions" style="margin-top: 0; justify-content: center; gap: 16px;">
                    <button class="modal-action-btn" id="reset-dialog-no" tabindex="0">
                        ${i18n.t('ButtonCancel') || 'Cancel'}
                    </button>
                    <button class="modal-action-btn danger-btn" id="reset-dialog-yes" tabindex="0">
                        ${i18n.t('ButtonResetAll') || 'Reset All'}
                    </button>
                </div>
            </div>
        `;

        const closeDialog = () => {
            overlay.classList.remove('visible');
            setTimeout(() => {
                if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
            }, 300);
            focusManager.unregister('reset-dialog-actions');
            if (prevSection) focusManager.setActiveSection(prevSection, false);
            if (prevFocus) focusManager.focusElement(prevFocus);
        };

        focusManager.register('reset-dialog-actions', overlay.querySelector('#reset-dialog-actions'), {
            orientation: 'horizontal',
            enterTo: 'first' // Focus Cancel safely
        });

        focusManager.setActiveSection('reset-dialog-actions');

        overlay.querySelector('#reset-dialog-no').onclick = (e) => {
            e.stopPropagation();
            closeDialog();
        };

        overlay.querySelector('#reset-dialog-yes').onclick = (e) => {
            e.stopPropagation();
            log.info('User confirmed reset all settings.');
            this._handleResetAll();
        };

        overlay.onclick = (e) => {
            if (e.target === overlay) closeDialog();
        };
    }

    /**
     * Clear all preference keys from storage and reload the application.
     * @private
     */
    _handleResetAll() {
        // 1. Clear player settings
        PlayerSettings.resetAll();

        // 2. Clear app preferences
        storage.clearByPrefix('pref:');

        // 3. Clear layout/theme preferences
        storage.removeItem('litefin:layout');
        storage.removeItem('litefin:themeMode');
        storage.removeItem('litefin:theme');
        storage.removeItem('litefin:themeColor');
        storage.removeItem('litefin:uiFont');
        storage.removeItem('litefin:roundedCorners');
        storage.removeItem('litefin:textScale');
        storage.removeItem('litefin:osdButtonBorders');

        // 4. Clear other app settings
        storage.removeItem('app_language');
        storage.removeItem('layout_direction');

        // 5. Clear image presets
        storage.removeItem('image_preset');
        storage.removeItem('image_details_preset');

        // 6. Clear debug settings
        storage.clearByPrefix('debug_');

        // 7. Hard reload to apply defaults everywhere and re-initialize i18n correctly.
        // We navigate to the app's root entry-point URL without the hash fragment.
        // This forces a true cold-start navigation, re-executing all JS modules.
        const href = window.location.href;
        const protocol = window.location.protocol;
        let entryUrl;

        if (protocol === 'file:') {
            // file:// packaged app (Tizen/WebOS) — strip everything from '#' onward
            entryUrl = href.split('#')[0];
        } else {
            // http(s):// dev server — use origin + pathname (no hash)
            entryUrl = window.location.origin + window.location.pathname;
        }

        window.location.href = entryUrl;
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
