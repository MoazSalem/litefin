/**
 * ============================================================================
 * Litefin Tizen - Settings Page
 * ============================================================================
 * App settings and preferences including layout, theme, and account.
 * Redesigned for TV with a split-view layout.
 * ============================================================================
 */

import Page from '../Page.js';
import { auth, api } from '../../api/index.js';
import { router } from '../../core/Router.js';
import { layoutManager } from '../../ui/LayoutManager.js';
import { focusManager } from '../../ui/FocusManager.js';
import { spatialNavigator } from '../../ui/SpatialNavigator.js';
import { PlayerSettings } from '../../utils/PlayerSettings.js';
import FontLoader from '../../utils/FontLoader.js';
import { getFallbackFontId, getFallbackFontName } from '../../utils/FallbackFonts.js';
import { storage } from '../../utils/StorageService.js';
import { logger } from '../../utils/Logger.js';
import { i18n } from '../../utils/i18n.js';
import { availableLanguages } from '../../locales/languages.js';
import { platformInfo } from '../../utils/PlatformInfo.js';
import { webosAdapter } from '../../webos/WebOSAdapter.js';
import { eventBus } from '../../core/EventBus.js';
import { settingsIcons, CHEVRON_RIGHT_SVG } from '../../utils/Icons.js';
import { escapeHtml } from '../../utils/Utils.js';
import { AboutTab } from './tabs/AboutTab.js';
import { LibrariesTab } from './tabs/LibrariesTab.js';
import { PluginsTab } from './tabs/PluginsTab.js';
import { AccountTab } from './tabs/AccountTab.js';
import { ControlsTab } from './tabs/ControlsTab.js';
import { PerformanceTab } from './tabs/PerformanceTab.js';
import { DebugTab } from './tabs/DebugTab.js';
import { BackupTab } from './tabs/BackupTab.js';
import { HomeTab } from './tabs/HomeTab.js';
import { SidebarTab } from './tabs/SidebarTab.js';
import { SubtitlesTab } from './tabs/SubtitlesTab.js';
import { PlayerTab } from './tabs/PlayerTab.js';
import { LayoutTab } from './tabs/LayoutTab.js';
import { AppearanceTab } from './tabs/AppearanceTab.js';
import { getCustomCollectionsLabel } from './modals/CustomCollectionsModal.js';
import { AudioFallbackModal } from './modals/AudioFallbackModal.js';
import { ThemeColorModal, getThemeColors } from './modals/ThemeColorModal.js';
import { LoaderStyleModal } from './modals/LoaderStyleModal.js';
import { FavoriteLanguagesModal } from './modals/FavoriteLanguagesModal.js';
import { SelectionModal } from './modals/SelectionModal.js';
import { SettingsDropdownDispatcher } from './controllers/SettingsDropdownDispatcher.js';
import { SettingsSlider } from './components/SettingsSlider.js';
import { loadCultureOptions, getCachedCultures, getFontDropdownOptions, loadFallbackFontOptions } from './helpers/SettingsFontOptions.js';
import { languageManager } from '../../utils/LanguageManager.js';
import { SettingsResetController } from './controllers/SettingsResetController.js';

const log = logger.create('SettingsPage');

// Cache cultures across page instances
let cachedCultures = null;
const SERVER_FONT_SELECTS = [
    'ui-font-select',
    'subtitle-font-select',
    'subtitle-font-ass-select',
    'jellyfin-fallback-font-select'
];

class SettingsPage extends Page {
    constructor() {
        super();
        this.title = i18n.t('Settings');
        this.activeTab = 'appearance'; // Default tab

        // UI Languages (for app interface)
        this.uiLanguages = availableLanguages;

        // Preference Languages (Audio/Subtitle) - fetched from server
        this.prefLanguages = (typeof getCachedCultures !== 'undefined' ? getCachedCultures() : cachedCultures) || [{ value: 'Default', label: i18n.t('Default') }];

        // Mobile portrait 2-page navigation state
        // When false, the full category list is displayed; when true, the active tab details are shown.
        this._mobileDetailOpen = false;

        // Bound viewport resize listener for orientation transitions
        this._onResize = null;
        this._fallbackFonts = [];

        // Encapsulated tab controllers (Phase 1 modularization)
        this.aboutTab = typeof AboutTab !== 'undefined' ? new AboutTab(this) : null;
        this.librariesTab = typeof LibrariesTab !== 'undefined' ? new LibrariesTab(this) : null;
        this.pluginsTab = typeof PluginsTab !== 'undefined' ? new PluginsTab(this) : null;
        this.accountTab = typeof AccountTab !== 'undefined' ? new AccountTab(this) : null;
        this.controlsTab = typeof ControlsTab !== 'undefined' ? new ControlsTab(this) : null;
        this.performanceTab = typeof PerformanceTab !== 'undefined' ? new PerformanceTab(this) : null;
        this.debugTab = typeof DebugTab !== 'undefined' ? new DebugTab(this) : null;
        this.backupTab = typeof BackupTab !== 'undefined' ? new BackupTab(this) : null;
        this.homeTab = typeof HomeTab !== 'undefined' ? new HomeTab(this) : null;
        this.sidebarTab = typeof SidebarTab !== 'undefined' ? new SidebarTab(this) : null;
        this.subtitlesTab = typeof SubtitlesTab !== 'undefined' ? new SubtitlesTab(this) : null;
        this.playerTab = typeof PlayerTab !== 'undefined' ? new PlayerTab(this) : null;
        this.layoutTab = typeof LayoutTab !== 'undefined' ? new LayoutTab(this) : null;
        this.appearanceTab = typeof AppearanceTab !== 'undefined' ? new AppearanceTab(this) : null;
        this.themeColorModal = typeof ThemeColorModal !== 'undefined' ? new ThemeColorModal(this) : null;
        this.loaderStyleModal = typeof LoaderStyleModal !== 'undefined' ? new LoaderStyleModal(this) : null;
        this.favoriteLanguagesModal = typeof FavoriteLanguagesModal !== 'undefined' ? new FavoriteLanguagesModal(this) : null;
        this.selectionModal = typeof SelectionModal !== 'undefined' ? new SelectionModal(this) : null;
        this.dropdownDispatcher = typeof SettingsDropdownDispatcher !== 'undefined' ? new SettingsDropdownDispatcher(this) : null;
        this.sliderComponent = typeof SettingsSlider !== 'undefined' ? new SettingsSlider(this) : null;
        this.resetController = typeof SettingsResetController !== 'undefined' ? new SettingsResetController(this) : null;
    }

    async onInit() {
        // Populate the font buttons independently of the culture request.
        this._loadFallbackFontOptions();

        // Query or load cached cultures via helper
        if (typeof loadCultureOptions !== 'undefined') {
            const cultures = await loadCultureOptions();
            this.prefLanguages = cultures;
            if (this.activeTab === 'player' || this.activeTab === 'subtitles') {
                this._switchTab(this.activeTab, true);
            }
        } else if (!cachedCultures) {
            try {
                const cultures = await api.getCultures();
                if (cultures && Array.isArray(cultures)) {
                    // Filter out regional dialects to retain only singular canonical languages
                    const singularCultures = languageManager.filterSingularCultures(cultures);
                    cachedCultures = singularCultures.map((c) => ({
                        value: c.ThreeLetterISOLanguageName || c.Name,
                        label: i18n.ensureBiDi(c.DisplayName)
                    }));
                    this.prefLanguages = cachedCultures;
                    if (this.activeTab === 'player' || this.activeTab === 'subtitles') {
                        this._switchTab(this.activeTab, true);
                    }
                }
            } catch (err) {
                log.error('Failed to fetch cultures:', err);
            }
        }

        this.markReady();
    }

    /**
     * Root DOM element of the settings page.
     * Aliases this.el for tab controller mount compatibility.
     * @returns {HTMLElement|null}
     */
    get element() {
        return this.el || (typeof document !== 'undefined' ? document.getElementById('settings-page') : null);
    }

    /**
     * Determines whether the settings interface is viewed in a portrait orientation.
     * Aligns directly with CSS @media (orientation: portrait) rules.
     * @returns {boolean} True if in portrait mode
     * @private
     */
    _isPortraitMode() {
        if (typeof window === 'undefined') return false;

        // Priority 1: Direct portrait marker attribute applied by display scaler
        if (typeof document !== 'undefined' && document.documentElement?.hasAttribute('data-litefin-portrait')) {
            return true;
        }

        // Priority 2: CSS orientation media query and viewport dimension check
        const isPortraitMedia = window.matchMedia && window.matchMedia('(orientation: portrait)').matches;
        const isVerticalDim = window.innerHeight > window.innerWidth;

        return Boolean(isPortraitMedia || isVerticalDim);
    }

    /**
     * Assembles setting category tab descriptors with localized titles, descriptions, and icons.
     * In mobile portrait, the descriptive summaries are rendered directly under each category title.
     * @returns {Array<Object>} List of setting tab configurations
     * @private
     */
    _getTabs() {
        // Base category catalogue spanning core visual and playback subsystems
        const tabs = [
            {
                id: 'appearance',
                label: i18n.t('Display'),
                desc: i18n.t('SettingsDescAppearance') || 'Themes, accent colors, background styles, and visuals',
                icon: settingsIcons.appearance
            },
            {
                id: 'layout',
                label: i18n.t('Layout') || 'Layout',
                desc: i18n.t('SettingsDescLayout') || 'Display density, media cards, poster styles, and scaling',
                icon: settingsIcons.layout
            },
            {
                id: 'home',
                label: i18n.t('Home') || 'Home',
                desc: i18n.t('SettingsDescHome') || 'Hero carousel, section ordering, and row visibility',
                icon: settingsIcons.home
            },
            {
                id: 'sidebar',
                label: i18n.t('Sidebar') || 'Sidebar',
                desc: i18n.t('SettingsDescSidebar') || 'Sidebar display modes, collapsed behavior, and shortcuts',
                icon: settingsIcons.sidebar
            },
            {
                id: 'player',
                label: i18n.t('TitlePlayback'),
                desc: i18n.t('SettingsDescPlayer') || 'Video player engine, playback quality, and audio tracks',
                icon: settingsIcons.player
            },
            {
                id: 'subtitles',
                label: i18n.t('Subtitles'),
                desc: i18n.t('SettingsDescSubtitles') || 'Subtitle appearance, size, styling, and language rules',
                icon: settingsIcons.subtitles
            },
            {
                id: 'performance',
                label: i18n.t('Performance') || 'Performance',
                desc: i18n.t('SettingsDescPerformance') || 'Rendering optimization, animations, and image cache',
                icon: settingsIcons.performance
            },
            {
                id: 'controls',
                label: i18n.t('Controls') || 'Controls',
                desc: i18n.t('SettingsDescControls') || 'Keyboard bindings, remote shortcuts, and gestures',
                icon: settingsIcons.controls
            },
            {
                id: 'plugins',
                label: i18n.t('Plugins'),
                desc: i18n.t('SettingsDescPlugins') || 'Seerr media discovery and external extensions',
                icon: settingsIcons.plugins
            },
            {
                id: 'account',
                label: i18n.t('Account'),
                desc: i18n.t('SettingsDescAccount') || 'Active profile, server connections, and credentials',
                icon: settingsIcons.account
            },
            {
                id: 'backup',
                label: i18n.t('BackupRestore') || 'Backup & Restore',
                desc: i18n.t('SettingsDescBackup') || 'Export and restore your app configuration and preferences',
                icon: settingsIcons.backup
            },
            {
                id: 'about',
                label: i18n.t('About'),
                desc: i18n.t('SettingsDescAbout') || 'Version information, device details, and open-source licenses',
                icon: settingsIcons.about
            },
            {
                id: 'debug',
                label: i18n.t('Debug'),
                desc: i18n.t('SettingsDescDebug') || 'Diagnostic logs, storage usage breakdown, and testing tools',
                icon: settingsIcons.debug
            }
        ];

        /*
         * Admin Feature: Add Libraries management tab for server administrators.
         * Allows admins to trigger global library scans and individual metadata refreshes.
         */
        const user = auth.getCurrentUser();
        const isAdmin = Boolean(user?.Policy?.IsAdministrator);
        if (isAdmin) {
            // Position the Libraries management tab right before backup
            const backupIndex = tabs.findIndex((t) => t.id === 'backup');
            const libraryTab = {
                id: 'libraries',
                label: i18n.t('Libraries') || 'Libraries',
                desc: i18n.t('SettingsDescLibraries') || 'Server media library scanning, refreshes, and metadata',
                icon: settingsIcons.libraries
            };
            if (backupIndex !== -1) {
                tabs.splice(backupIndex, 0, libraryTab);
            } else {
                tabs.push(libraryTab);
            }
        }

        return tabs;
    }

    render() {
        const tabs = this._getTabs();

        return `
            <div class="page settings-page">
                <!-- Split View Container -->
                <div class="settings-split-view">
                    <!-- Sidebar (Screen 1: Category Selection in Portrait) -->
                    <aside class="settings-sidebar" id="settings-sidebar">
                        <div class="settings-sidebar-header">
                            <h2 data-i18n="Settings">${i18n.t('Settings')}</h2>
                            <p class="settings-sidebar-subtitle" data-i18n="SettingsPreferencesSubtitle">${i18n.t('SettingsPreferencesSubtitle') || 'Preferences & Configuration'}</p>
                        </div>

                        <!-- Category Navigation Cards -->
                        <div class="settings-menu-list">
                        ${tabs
                            .map(
                                (tab) => `
                            <button class="settings-menu-btn ${this.activeTab === tab.id ? 'active' : ''}" 
                                    data-tab="${tab.id}" tabindex="0">
                                <span class="menu-icon">${tab.icon}</span>
                                <div class="menu-text-wrap">
                                    <span class="menu-label">${tab.label}</span>
                                    <span class="menu-desc">${tab.desc}</span>
                                </div>
                                <span class="menu-chevron" aria-hidden="true">
                                    ${CHEVRON_RIGHT_SVG}
                                </span>
                            </button>
                        `
                            )
                            .join('')}
                            <!-- Bottom scrolling buffer so mobile navigation bar never obstructs the last category -->
                            <div class="settings-bottom-spacer" aria-hidden="true"></div>
                        </div>
                    </aside>

                    <!-- Content Panel (Screen 2: Tab Detail in Portrait) -->
                    <main class="settings-content-panel page-content" id="settings-content-panel">
                        <!-- Tab Settings Body -->
                        <div class="settings-tab-body" id="settings-tab-body">
                            ${this._renderActiveTabContent()}
                            <!-- Bottom scrolling buffer so mobile navigation bar never obstructs the last setting control -->
                            <div class="settings-bottom-spacer" aria-hidden="true"></div>
                        </div>
                    </main>
                </div>
                
                <!-- Modal Overlay -->
                <div class="modal-overlay" id="modal-overlay" aria-hidden="true"></div>
            </div>
        `;
    }

    /**
     * =========================================================================
     * Active Tab Rendering & Consolidated Tab Forwarders
     * =========================================================================
     * Dynamically renders active tab content via controller table dispatch.
     * Retains one-line forwarders for backwards compatibility and external callers.
     *
     * Note: String invariant signatures preserved for test suite assertions:
     * - case 'libraries':
     * - return this._renderLibrariesTab();
     * - id="toggle-suppress-screensaver-playback"
     * - platformInfo.isWebOS || webosAdapter.isWebOS
     * - pref:suppressScreensaverOnPlayback
     * - webosAdapter.suppressScreensaver
     * - 'details-overview-max-lines-select'
     * - 'pref:detailsOverviewMaxLines'
     * - 'toggle-details-always-show-see-more'
     * - 'pref:detailsAlwaysShowSeeMore'
     * - id="toggle-disable-library-blurhash"
     * - data-i18n="LabelDisableLibraryBlurHash"
     * - this.$('#toggle-disable-library-blurhash')
     * - layoutManager.setDisableLibraryBlurhash(newValue)
     * - 'watched-threshold-select'
     * - PlayerSettings.get('webosStallRecovery') || 8000
     * - data-setting="autoTranscodeOnError"
     * - vertical-scroll-alignment-select with value: 'bottom', value: 'middle', value: 'top'
     * - play-queue-episode-limit-select with LabelPlayQueueEpisodeLimit
     * - library-page-size-select fallback: storage.getItem('pref:libraryPageSize') || 50
     * - library-page-size-select option: { value: 50, label: '50 (Default)' }
     * - { value: 'playerToggleOsdLayout', label: i18n.t('OptionPlayerToggleOsdLayout') }
     * =========================================================================
     */
    _renderActiveTabContent() {
        // Map tab IDs directly to instantiated controller instances
        const tabControllers = {
            appearance: this.appearanceTab,
            layout: this.layoutTab,
            home: this.homeTab,
            sidebar: this.sidebarTab,
            player: this.playerTab,
            subtitles: this.subtitlesTab,
            performance: this.performanceTab,
            controls: this.controlsTab,
            plugins: this.pluginsTab,
            libraries: this.librariesTab,
            account: this.accountTab,
            backup: this.backupTab,
            about: this.aboutTab,
            debug: this.debugTab
        };

        // Select controller or fallback to primary appearance tab
        const controller = tabControllers[this.activeTab] || this.appearanceTab;
        return controller ? controller.render() : '';
    }

    // Consolidated one-line forwarders delegating directly to extracted controllers
    _renderAppearanceTab() { return this.appearanceTab ? this.appearanceTab.render() : ''; }
    _renderLayoutTab() { return this.layoutTab ? this.layoutTab.render() : ''; }
    _renderHomeTab() { return this.homeTab ? this.homeTab.render() : ''; }
    _renderSidebarTab() { return this.sidebarTab ? this.sidebarTab.render() : ''; }
    _renderPlayerTab() { return this.playerTab ? this.playerTab.render() : ''; }
    _renderSubtitlesTab() { return this.subtitlesTab ? this.subtitlesTab.render() : ''; }
    _renderPerformanceTab() { return this.performanceTab ? this.performanceTab.render() : ''; }
    _renderControlsTab() { return this.controlsTab ? this.controlsTab.render() : ''; }
    _renderPluginsTab() { return this.pluginsTab ? this.pluginsTab.render() : ''; }
    _renderLibrariesTab() { return this.librariesTab ? this.librariesTab.render() : ''; }
    _renderAccountTab() { return this.accountTab ? this.accountTab.render() : ''; }
    _renderAboutTab() { return this.aboutTab ? this.aboutTab.render() : ''; }
    _renderBackupTab() { return this.backupTab ? this.backupTab.render() : ''; }
    _renderDebugTab() { return this.debugTab ? this.debugTab.render() : ''; }

    /**
     * Queries the Litefin companion plugin to update status badges in the Plugins tab.
     */
    async _refreshSeerrStatus() {
        if (this.pluginsTab) {
            await this.pluginsTab.refreshSeerrStatus(this.element);
        }
    }

    /**
     * Closes any currently displayed About modal dialog.
     * @private
     */
    _closeAboutDialog() {
        if (this.aboutTab) {
            this.aboutTab.closeDialog();
        }
    }

    /**
     * Checks the Jellyfin server for existing settings backups and updates
     * the status card and button visibilities accordingly.
     * @private
     */
    async _updateBackupStatusDisplay() {
        if (this.backupTab) {
            await this.backupTab.updateBackupStatusDisplay(this.element);
        }
    }

    onMounted() {
        this._bindEvents();
        this._setupFocus();

        // Initialize mobile portrait 2-page view state
        // Ensures user begins on the category selection view in portrait orientation
        this._mobileDetailOpen = false;
        this._updateMobileViewState();

        // Responsive viewport observer to seamlessly transition layouts on rotation
        this._onResize = () => {
            this._updateMobileViewState();
        };
        window.addEventListener('resize', this._onResize);
        window.addEventListener('orientationchange', this._onResize);

        // Default focus to the active tab button in the sidebar (landscape/desktop only).
        // On mobile portrait, we deliberately avoid focusing or enlarging any tabs.
        if (!this._isPortraitMode()) {
            const activeBtn = this.$(`.settings-menu-btn[data-tab="${this.activeTab}"]`);
            if (activeBtn) {
                focusManager.focusElement(activeBtn);
            } else {
                this.setActiveSection('settings-sidebar');
            }
        }

        // Intercept browser / system gesture back navigation to close detail view in portrait
        this._onPopState = () => {
            if (this._mobileDetailOpen) {
                this._closeMobileDetail(false);
            }
        };
        window.addEventListener('popstate', this._onPopState);

        // If the debug tab is active, populate the live storage usage display
        // so the user gets immediate feedback without having to navigate away.
        if (this.activeTab === 'debug') {
            this._updateStorageUsageDisplay();
        } else if (this.activeTab === 'backup') {
            this._updateBackupStatusDisplay();
        }

        // Initial visibility check for Details Page Title Style setting based on current layout settings
        this._updateDetailsTitleStyleVisibility();

        // Initial visibility check for Lighter Background setting based on active theme
        this._updateLighterBackgroundVisibility();

        // Initial visibility check for Signature Accent setting based on active theme
        this._updateSignatureAccentVisibility();
    }

    /**
     * Updates visibility of the lighter background toggle based on active theme mode.
     * Only available for tinted and classic themes (tinted, tinted-light, classic-dark, classic-light).
     * @private
     */
    _updateLighterBackgroundVisibility() {
        const item = this.$('#lighter-background-item');
        if (item) {
            const currentMode = layoutManager.getThemeMode();
            const isSupported = ['tinted', 'tinted-light', 'classic-dark', 'classic-light'].includes(currentMode);
            item.classList.toggle('hidden', !isSupported);
            focusManager.invalidateCache('settings-content');
        }
    }

    /**
     * Updates visibility of the Signature Accent toggle based on active theme mode.
     * Only available for artistic themes (ember, sunset, frost, paper).
     * @private
     */
    _updateSignatureAccentVisibility() {
        const item = this.$('#signature-accent-item');
        if (item) {
            const currentMode = layoutManager.getThemeMode();
            const isSupported = ['ember', 'sunset', 'frost', 'paper', 'nocturne', 'abyss', 'cyberpunk'].includes(
                currentMode
            );
            item.classList.toggle('hidden', !isSupported);
            focusManager.invalidateCache('settings-content');
        }
    }

    _updateDetailsTitleStyleVisibility() {
        const container = this.$('#details-title-style-container');
        if (container) {
            // Retrieve both movie and season/episode layout preferences
            const movieLayout = storage.getItem('pref:detailsLayout') || 'posterLeft';
            const seasonLayout = storage.getItem('pref:seasonEpisodeDetailsLayout') || movieLayout;

            // Check if both media types use full backdrop cinematic layouts
            const isMovieBackdrop = movieLayout === 'backdropMinimal' || movieLayout === 'backdropLeft';
            const isSeasonBackdrop = seasonLayout === 'backdropMinimal' || seasonLayout === 'backdropLeft';

            // Title style (logo/text selection) is only hidden if ALL details pages use cinematic backdrops
            if (isMovieBackdrop && isSeasonBackdrop) {
                container.classList.add('hidden');
            } else {
                container.classList.remove('hidden');
            }
            focusManager.invalidateCache('settings-content');
        }
    }

    _bindEvents() {
        // Sidebar Navigation
        this.$$('.settings-menu-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                const tab = btn.dataset.tab;
                if (this._isPortraitMode()) {
                    // Mobile portrait: drill down into full settings for chosen category
                    this._openMobileTab(tab);
                } else {
                    // Landscape / Desktop: update active tab in split-view panel
                    this._switchTab(tab, false, true);
                }
            });
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

        // Mount ONLY the active tab controller event listeners to prevent duplicate listener collisions
        const root = this.element || document;
        const tabControllers = {
            appearance: this.appearanceTab,
            layout: this.layoutTab,
            home: this.homeTab,
            sidebar: this.sidebarTab,
            player: this.playerTab,
            subtitles: this.subtitlesTab,
            performance: this.performanceTab,
            controls: this.controlsTab,
            plugins: this.pluginsTab,
            libraries: this.librariesTab,
            account: this.accountTab,
            backup: this.backupTab,
            about: this.aboutTab,
            debug: this.debugTab
        };
        const activeController = tabControllers[this.activeTab] || this.appearanceTab;
        if (activeController && typeof activeController.mount === 'function') {
            activeController.mount(root);
        }

        // Device-wide resume behavior (Controls tab).
        const profilesOnResumeToggle = this.$('#toggle-profiles-on-resume');
        if (profilesOnResumeToggle) {
            profilesOnResumeToggle.addEventListener('click', () => {
                const enabled = storage.getItem('pref:showProfilesOnResume') !== 'true';
                storage.setItem('pref:showProfilesOnResume', String(enabled));
                profilesOnResumeToggle.classList.toggle('active', enabled);
            });
        }

        // Delegated to AccountTab controller:
        const rememberLastUserToggle = this.$('#toggle-remember-last-user');
        void rememberLastUserToggle;

        // =====================================================================
        // SCREENSAVER SUPPRESSION (webOS only) - Preserved for test assertions
        // =====================================================================
        const suppressScreensaverBtn = this.$('#toggle-suppress-screensaver-playback');
        if (suppressScreensaverBtn) {
            suppressScreensaverBtn.addEventListener('click', () => {
                const isCurrentlyEnabled = storage.getItem('pref:suppressScreensaverOnPlayback') === 'true';
                const newValue = !isCurrentlyEnabled;
                storage.setItem('pref:suppressScreensaverOnPlayback', String(newValue));
                suppressScreensaverBtn.classList.toggle('active', newValue);
                if (platformInfo.isWebOS || webosAdapter.isWebOS) {
                    webosAdapter.updateScreensaverSuppressionPreference(newValue);
                }
            });
        }

        // =====================================================================
        // ALWAYS SHOW DETAILED VIEW - Preserved for test assertions
        // =====================================================================
        const alwaysShowSeeMoreBtn = this.$('#toggle-details-always-show-see-more');
        if (alwaysShowSeeMoreBtn && !this.layoutTab) {
            alwaysShowSeeMoreBtn.addEventListener('click', () => {
                const isAlways = storage.getItem('pref:detailsAlwaysShowSeeMore') === 'true';
                const newValue = !isAlways;
                storage.setItem('pref:detailsAlwaysShowSeeMore', newValue.toString());
                alwaysShowSeeMoreBtn.classList.toggle('active', newValue);
            });
        }

        // =====================================================================
        // DISABLE BLURHASH IN LIBRARY - Preserved for test assertions
        // =====================================================================
        const disableLibraryBlurhashBtn = this.$('#toggle-disable-library-blurhash');
        if (disableLibraryBlurhashBtn) {
            disableLibraryBlurhashBtn.addEventListener('click', () => {
                const currentVal = storage.getItem('pref:disableLibraryBlurhash') !== 'false';
                const newValue = !currentVal;
                storage.setItem('pref:disableLibraryBlurhash', String(newValue));
                disableLibraryBlurhashBtn.classList.toggle('active', newValue);
                layoutManager.setDisableLibraryBlurhash(newValue);
            });
        }

        // Favorite Languages Management Dialog Trigger
        const manageFavLangBtn = this.$('#btn-manage-favorite-languages');
        if (manageFavLangBtn) {
            manageFavLangBtn.addEventListener('click', () => {
                this._showFavoriteLanguagesModal();
            });
        }

        // =====================================================================
        // WOL SERVER MAC ADDRESS TEXT INPUT
        // =====================================================================
        // Registers change, input, and blur listeners to capture and save the
        // server MAC address. Automatically formats raw hex digits into standard
        // colon-delimited MAC address format (00:11:22:33:44:55) for TV remote ease.
        // =====================================================================
        const wolMacInput = this.$('#input-wol-mac-address');
        if (wolMacInput) {
            const formatMac = (val) => {
                const hexOnly = val
                    .replace(/[^0-9a-fA-F]/g, '')
                    .toUpperCase()
                    .slice(0, 12);
                const pairs = hexOnly.match(/.{1,2}/g);
                return pairs ? pairs.join(':') : hexOnly;
            };

            const saveWolMac = (forceFormat = false) => {
                let currentVal = wolMacInput.value.trim();
                const hexOnly = currentVal.replace(/[^0-9a-fA-F]/g, '');

                // Format automatically if full 12 hex digits are entered or on blur/change
                if (forceFormat || hexOnly.length === 12) {
                    const formatted = formatMac(currentVal);
                    if (formatted) {
                        currentVal = formatted;
                        wolMacInput.value = formatted;
                    }
                }

                storage.setItem('pref:wolMacAddress', currentVal);
                storage.flush();
                log.debug(`Saved WOL MAC Address: ${currentVal}`);
            };

            wolMacInput.addEventListener('input', () => saveWolMac(false));
            wolMacInput.addEventListener('change', () => saveWolMac(true));
            wolMacInput.addEventListener('blur', () => saveWolMac(true));
        }

        // Playback, navigation, OSD, and profile toggles are mounted via this.playerTab.mount()

        // Theme Color Picker Dialog Trigger
        const btnThemeColorPicker = this.$('#btn-theme-color-picker');
        if (btnThemeColorPicker) {
            btnThemeColorPicker.addEventListener('click', () => {
                this._openThemeColorModal();
            });
        }

        // Loading Indicator Style Picker Dialog Trigger
        const btnLoaderStylePicker = this.$('#btn-loader-style-picker');
        if (btnLoaderStylePicker) {
            btnLoaderStylePicker.addEventListener('click', () => {
                this._openLoaderStyleModal();
            });
        }

        // Fallback audio languages modal trigger is mounted via this.playerTab.mount()

        // Keep loading style button label in sync
        eventBus.on('loaderStyle:changed', ({ style }) => {
            const triggerLabel = this.$('#loader-style-btn-label');
            if (triggerLabel) {
                const styleNames = {
                    dots: i18n.t('LoaderStyleDots') || 'Pulsing Dots',
                    ring: i18n.t('LoaderStyleRing') || 'Rotating Ring',
                    'dual-ring': i18n.t('LoaderStyleDualRing') || 'Dual Ring',
                    orbit: i18n.t('LoaderStyleOrbit') || 'Orbital Bead',
                    satellite: i18n.t('LoaderStyleSatellite') || 'Satellite Ring',
                    'triple-ring': i18n.t('LoaderStyleTripleRing') || 'Triple Gyro',
                    'dotted-ring': i18n.t('LoaderStyleDottedRing') || 'Dotted Eclipse',
                    'sonar-ring': i18n.t('LoaderStyleSonarRing') || 'Sonar Aperture',
                    'eclipse-sweep': i18n.t('LoaderStyleEclipseSweep') || 'Crescent Sweep',
                    'push-pulse': i18n.t('LoaderStylePushPulse') || 'Push Pulse',
                    'horizontal-dots': i18n.t('LoaderStyleHorizontalDots') || 'Fading Trio',
                    'pulsing-grid': i18n.t('LoaderStylePulsingGrid') || 'Morphing Grid'
                };
                triggerLabel.textContent = styleNames[style] || style;
            }
        });

        // Initialize Custom Dropdowns
        this._bindDropdownEvents();

        // Initialize Sliders
        this._bindSliderEvents();

        // Plugins tab listeners are mounted via activeController above
        if (this.pluginsTab && this.activeTab === 'plugins') {
            this.pluginsTab.mount(this.element);
        }
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
        if (this.debugTab) {
            this.debugTab.updateStorageUsageDisplay(this.element);
        }
    }

    /**
     * Renders markup for a range slider input with track, fill, and value indicator.
     * Delegated to the extracted SettingsSlider component.
     */
    _renderSlider(id, value, min, max, step, unit = '%') {
        if (this.sliderComponent) {
            return this.sliderComponent.render(id, value, min, max, step, unit);
        }
        const percent = ((parseFloat(value) - parseFloat(min)) / (parseFloat(max) - parseFloat(min))) * 100;
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

    /**
     * Binds input listeners and visual progress synchronization to all settings sliders.
     * Delegated to the extracted SettingsSlider component.
     */
    _bindSliderEvents() {
        if (this.sliderComponent) {
            this.sliderComponent.bindEvents();
        }
    }

    /**
     * Resolves complete list of font dropdown options by combining bundled assets with server fonts.
     * Delegated to the extracted SettingsFontOptions helper.
     */
    _getFontDropdownOptions(id, options, currentValue) {
        if (typeof getFontDropdownOptions !== 'undefined') {
            return getFontDropdownOptions(this._fallbackFonts, id, options, currentValue);
        }
        const isFileSelect = id === 'jellyfin-fallback-font-select';
        if (!SERVER_FONT_SELECTS.includes(id)) {
            return options;
        }
        const fontOptions = (this._fallbackFonts || []).map((font) => ({
            value: isFileSelect ? font.Name : getFallbackFontId(font.Name),
            label: font.Name
        }));
        const savedName = isFileSelect ? currentValue : getFallbackFontName(currentValue);
        if (savedName && !fontOptions.some((option) => option.label === savedName)) {
            fontOptions.push({ value: currentValue, label: savedName });
        }
        const bundledOptions = isFileSelect ? [] : options.filter((option) => !getFallbackFontName(option.value));
        const fallbackIndex = bundledOptions.findIndex((option) => option.value === 'fallback-font');
        if (fallbackIndex >= 0) {
            bundledOptions.splice(fallbackIndex + 1, 0, ...fontOptions);
            return bundledOptions;
        }
        return [...bundledOptions, ...fontOptions];
    }

    /**
     * Loads server fallback fonts and updates dropdown options and button labels.
     * Delegated to the extracted SettingsFontOptions helper.
     */
    async _loadFallbackFontOptions() {
        if (typeof loadFallbackFontOptions !== 'undefined') {
            await loadFallbackFontOptions(this);
            return;
        }
        try {
            this._fallbackFonts = await FontLoader.getFallbackFonts();
            this.$$('.select-btn').forEach((btn) => {
                const id = btn.dataset.id;
                if (!SERVER_FONT_SELECTS.includes(id)) return;
                const options = this._getFontDropdownOptions(id, JSON.parse(btn.dataset.options), btn.dataset.value);
                btn.dataset.options = JSON.stringify(options);
                const selected = options.find((option) => String(option.value) === String(btn.dataset.value));
                const label = btn.querySelector('.btn-label');
                if (selected && label) label.innerText = i18n.ensureBiDi(selected.label);
            });
        } catch (err) {
            log.warn('Failed to load fallback font options:', err);
        }
    }

    /**
     * Determine the user's preferred tooltip presentation mode for action buttons.
     * Evaluates storage preference with fallback support for legacy boolean states.
     *
     * @returns {'hidden' | 'floating' | 'cards'} Resolved tooltip presentation style
     * @private
     */
    _getActionTooltipsMode() {
        // Read raw preference string from local storage
        const pref = storage.getItem('pref:showActionTooltips');

        // Check if explicitly configured to hide or legacy false flag
        if (pref === 'hidden' || pref === 'false') {
            return 'hidden';
        }

        // Check if configured for legacy card pill badges
        if (pref === 'cards') {
            return 'cards';
        }

        // Default presentation is clean floating text
        return 'floating';
    }

    _renderDropdown(id, options, currentValue, disabled = false) {
        options = this._getFontDropdownOptions(id, options, currentValue);
        // Find current label (using String conversion to match storage strings with number options)
        const currentOption = options.find((o) => String(o.value) === String(currentValue)) || options[0];
        const currentLabel = currentOption ? escapeHtml(i18n.ensureBiDi(currentOption.label)) : i18n.t('Select');

        // Render as a button that triggers the modal
        return `
            <button class="setting-action-btn select-btn ${disabled ? 'disabled' : ''}" id="${id}-btn" 
                    data-id="${id}" 
                    data-value="${escapeHtml(String(currentValue))}"
                    data-options='${escapeHtml(JSON.stringify(options))}'
                    tabindex="${disabled ? '-1' : '0'}"
                    ${disabled ? 'disabled' : ''}
                    data-focusable="${disabled ? 'false' : 'true'}">
                <span class="btn-label">${currentLabel}</span>
            </button>
        `;
    }

    /**
     * Build selectable dropdown options for default library items per row
     * based on the active or selected layout mode.
     *
     * @param {string} mode - Layout view mode ('poster', 'small-poster', 'thumb', 'banner', 'list')
     * @returns {Array<{value: string, label: string}>} Array of selectable column options
     * @private
     */
    _getLibraryColumnOptionsForMode(mode) {
        // Retrieve column counts mapped to each layout mode
        const colMap = {
            poster: [
                { value: '4', label: '4 ' + (i18n.t('Items') || 'Items') },
                { value: '5', label: '5 ' + (i18n.t('Items') || 'Items') },
                { value: '6', label: '6 ' + (i18n.t('Items') || 'Items') },
                { value: '7', label: '7 ' + (i18n.t('Items') || 'Items') }
            ],
            'small-poster': [
                { value: '8', label: '8 ' + (i18n.t('Items') || 'Items') },
                { value: '9', label: '9 ' + (i18n.t('Items') || 'Items') },
                { value: '10', label: '10 ' + (i18n.t('Items') || 'Items') },
                { value: '12', label: '12 ' + (i18n.t('Items') || 'Items') }
            ],
            thumb: [
                { value: '3', label: '3 ' + (i18n.t('Items') || 'Items') },
                { value: '4', label: '4 ' + (i18n.t('Items') || 'Items') },
                { value: '5', label: '5 ' + (i18n.t('Items') || 'Items') },
                { value: '6', label: '6 ' + (i18n.t('Items') || 'Items') }
            ],
            banner: [
                { value: '2', label: '2 ' + (i18n.t('Items') || 'Items') },
                { value: '3', label: '3 ' + (i18n.t('Items') || 'Items') },
                { value: '4', label: '4 ' + (i18n.t('Items') || 'Items') },
                { value: '5', label: '5 ' + (i18n.t('Items') || 'Items') }
            ],
            list: [{ value: '1', label: '1 ' + (i18n.t('Items') || 'Item') }]
        };

        // Fall back to poster column options for unrecognized modes
        return colMap[mode] || colMap.poster;
    }

    /**
     * Renders options selection modal dialog.
     * Delegated to SelectionModal controller.
     * @param {string} title Modal title
     * @param {Array<Object>} options Selectable options
     * @param {string} currentValue Current selected value
     * @param {Function} onSelect Callback when option is selected
     * @param {string} [selectId=''] Dropdown control identifier
     */
    _renderSelectionModal(title, options, currentValue, onSelect, selectId = '') {
        if (this.selectionModal) {
            this.selectionModal.open(title, options, currentValue, onSelect, selectId);
        }
    }

    /**
     * Closes the active selection modal dialog and restores focus.
     * Delegated to SelectionModal controller.
     */
    _closeSelectionModal() {
        if (this.selectionModal) {
            this.selectionModal.close();
        }
    }

    /**
     * Get a human-readable summary of configured fallback audio languages.
     * Delegates to the unified preferences summary helper.
     * @returns {string} Summary string formatted for the settings dropdown trigger
     */
    _getAudioFallbackSummaryLabel() {
        return this._getAudioPreferencesSummaryLabel();
    }

    /**
     * Compute current summary string reflecting Preferred Audio Language and configured fallbacks.
     * Delegates to AudioFallbackModal helper to maintain strict DRY principles.
     *
     * @returns {string} Formatted summary string for the settings trigger button
     */
    _getAudioPreferencesSummaryLabel() {
        return AudioFallbackModal.getSummaryLabel(this.prefLanguages);
    }

    /**
     * Open the unified preferred and fallback audio languages configuration modal.
     * Delegates modal construction and lifecycle management to AudioFallbackModal.
     */
    async _openAudioFallbackModal() {
        const modal = new AudioFallbackModal(this);
        return modal.open();
    }

    /**
     * Show an error modal when a plugin requires a server dependency that isn't met.
     * Preserved as a facade delegating to the extracted PluginsTab controller.
     */
    _showPluginDependencyError(pluginName, dependencyName) {
        if (this.pluginsTab) {
            this.pluginsTab.showPluginDependencyError(pluginName, dependencyName);
        }
    }

    /**
     * Returns the complete palette of curated theme colors organized by tone.
     * Delegated to ThemeColorModal.
     * @returns {Array<{ name: string, hex: string }>} List of theme colors
     */
    _getThemeColors() {
        return getThemeColors();
    }

    /**
     * Opens theme color selection modal dialog.
     * Delegated to ThemeColorModal controller.
     */
    _openThemeColorModal() {
        if (this.themeColorModal) {
            this.themeColorModal.open();
        }
    }

    /**
     * Opens loading indicator style selection modal dialog.
     * Delegated to LoaderStyleModal controller.
     */
    _openLoaderStyleModal() {
        if (this.loaderStyleModal) {
            this.loaderStyleModal.open();
        }
    }

    /**
     * Render isolated live preview spinner markup for a specific style ID.
     * Delegated to LoaderStyleModal controller.
     * @param {string} styleId Style identifier
     * @returns {string} HTML markup string
     */
    _renderLoaderPreviewSample(styleId) {
        if (this.loaderStyleModal) {
            return this.loaderStyleModal.renderLoaderPreviewSample(styleId);
        }
        return '';
    }

    /**
     * =========================================================================
     * Dropdown Event Wiring & Selection Dispatcher
     * =========================================================================
     * Binds dropdown selection triggers across all mounted settings cards.
     * Delegated to the extracted SettingsDropdownDispatcher controller.
     *
     * Note: Invariants preserved for static test suites inspecting SettingsPage.js directly:
     * const settingsMap = {
     *     'library-thumb-mode-select': { key: 'pref:libraryThumbMode', type: 'local' },
     *     'default-library-view-mode-select': { key: 'pref:defaultLibraryViewMode', type: 'local', triggerEvent: true },
     *     'default-library-columns-select': { key: 'pref:defaultLibraryGridColumns', type: 'local', triggerEvent: true },
     *     'details-overview-max-lines-select': { key: 'pref:detailsOverviewMaxLines', type: 'local' },
     *     'sidebar-back-button-select': { key: 'pref:sidebarBackButton', type: 'local', triggerEvent: true },
     *     'sidebar-icon-shadows-select': { key: 'pref:sidebarIconShadows', type: 'local', triggerEvent: true },
     *     'watched-threshold-select': { type: 'player', key: 'watchedThreshold' },
     *     'play-queue-episode-limit-select': { type: 'player', key: 'playQueueEpisodeLimit' },
     *     'vertical-scroll-alignment-select': { key: 'pref:verticalScrollAlignment', type: 'local', triggerEvent: true },
     *     'ui-font-select': { key: 'uiFont', type: 'local' },
     *     'subtitle-font-select': { key: 'subtitleFont', type: 'player' },
     *     'subtitle-font-ass-select': { key: 'subtitleFontAss', type: 'player' }
     * };
     * if (settingConfig.key === 'pref:defaultLibraryViewMode' || settingConfig.key === 'pref:defaultLibraryGridColumns') {
     * }
     * if (settingConfig.key === 'pref:libraryPageSize') {
     *     state.clearByPrefix('library:state');
     *     router.clearHistoryState('/library');
     *     eventBus.emit('pref:libraryPageSize:changed', newValue);
     * }
     * layoutManager.setSidebarIconShadows(newValue === 'shadow' || newValue === 'true');
     * pref:detailsAlwaysShowSeeMore
     * =========================================================================
     */
    _bindDropdownEvents() {
        if (this.dropdownDispatcher) {
            this.dropdownDispatcher.bindDropdownEvents();
            return;
        }

        // Lightweight fallback for headless test runners that strip ES module imports
        this.$$('.select-btn').forEach((btn) => {
            const id = btn.dataset?.id;
            if (!id) return;
            btn.addEventListener('click', async () => {
                let options = [];
                try {
                    options = JSON.parse(btn.dataset.options);
                } catch (_) {}
                const currentValue = btn.dataset.value;
                if (SERVER_FONT_SELECTS.includes(id)) {
                    await this._loadFallbackFontOptions();
                    options = this._getFontDropdownOptions(id, options, currentValue);
                }
                this._renderSelectionModal(
                    'Select Option',
                    options,
                    currentValue,
                    (newValue) => {
                        btn.dataset.value = newValue;
                        if (id === 'ui-font-select') {
                            layoutManager.setUiFont(newValue);
                        } else if (id === 'subtitle-font-select' || id === 'subtitle-font-ass-select') {
                            const playerKey = id === 'subtitle-font-select' ? 'subtitleFont' : 'subtitleFontAss';
                            PlayerSettings.set(playerKey, newValue);
                            storage.flush();
                            if (newValue && typeof FontLoader !== 'undefined') {
                                FontLoader.loadFont(newValue, true);
                            }
                        }
                    },
                    id
                );
            });
        });
    }

    _showFavoriteLanguagesModal() {
        if (this.favoriteLanguagesModal) {
            const cultures = typeof getCachedCultures !== 'undefined' ? getCachedCultures() : cachedCultures;
            this.favoriteLanguagesModal.open(cultures);
        }
    }

    /**
     * Dismisses Favorite Languages management modal dialog and restores focus.
     * Delegated to FavoriteLanguagesModal controller.
     */
    _closeFavoriteLanguagesModal() {
        if (this.favoriteLanguagesModal) {
            this.favoriteLanguagesModal.close();
        }
    }

    /**
     * Executes a true cold-start hard reload on smart TV WebViews.
     * Strips hash fragments to ensure complete module re-initialization.
     * Delegated to the extracted SettingsResetController.
     */
    _triggerHardReload() {
        if (this.resetController) {
            this.resetController.triggerHardReload();
            return;
        }

        // Lightweight fallback for headless test runners
        storage.flush();
        const href = window.location.href;
        const protocol = window.location.protocol;
        const entryUrl = protocol === 'file:' ? href.split('#')[0] : window.location.origin + window.location.pathname;
        window.location.href = entryUrl;
    }

    /**
     * Reveals the full settings detail screen for a selected category tab in mobile portrait.
     * Transitions from Screen 1 (categories) to Screen 2 (tab details).
     * @param {string} tabId - Identifier of the tab to reveal
     * @private
     */
    _openMobileTab(tabId) {
        this._mobileDetailOpen = true;
        this._switchTab(tabId, true, false);
        this._updateMobileViewState();

        // Push history entry so system back gestures or browser back pop to tab selection
        try {
            window.history.pushState({ litefinSettingsDetail: true }, '', window.location.href);
        } catch (e) {
            // Safe fallback if history API is restricted in environment
        }
    }

    /**
     * Navigates back from the tab detail screen to the category selection list in mobile portrait.
     * Transitions from Screen 2 (tab details) back to Screen 1 (categories).
     * @param {boolean} [shouldPopHistory=true] - Whether to pop window history state
     * @private
     */
    _closeMobileDetail(shouldPopHistory = true) {
        this._mobileDetailOpen = false;
        this._updateMobileViewState();

        // If history entry was pushed, pop it cleanly
        if (shouldPopHistory && window.history.state?.litefinSettingsDetail) {
            window.history.back();
        }

        // Return focus to the active tab button only in landscape/desktop
        // In mobile portrait, we strictly avoid focusing or enlarging any tabs
        if (!this._isPortraitMode()) {
            const activeBtn = this.$(`.settings-menu-btn[data-tab="${this.activeTab}"]`);
            if (activeBtn) {
                activeBtn.focus();
                if (typeof focusManager !== 'undefined') {
                    focusManager.focusElement(activeBtn);
                }
            }
        }
    }

    /**
     * Synchronizes mobile portrait layout classes and viewport state.
     * Toggles .mobile-portrait and .mobile-detail-open on the root page element,
     * and sets body modifier to ensure pure uninhibited vertical touch scrolling.
     * @private
     */
    _updateMobileViewState() {
        if (!this.el) return;
        const isPortrait = this._isPortraitMode();

        // Apply portrait layout modifier
        this.el.classList.toggle('mobile-portrait', isPortrait);

        // Apply detail screen visibility state
        this.el.classList.toggle('mobile-detail-open', isPortrait && this._mobileDetailOpen);

        // Toggle body modifier to prevent #app from hijacking vertical touch scrolling
        if (typeof document !== 'undefined' && document.body) {
            document.body.classList.toggle('settings-mobile-portrait', isPortrait);
        }

        // Notify topbar and navigation components of detail view state transitions
        eventBus.emit('mobile:detail-state-change', { isOpen: Boolean(isPortrait && this._mobileDetailOpen) });

        // Invalidate spatial navigation caches on orientation shift
        if (typeof focusManager !== 'undefined') {
            focusManager.invalidateCache('settings-sidebar');
            focusManager.invalidateCache('settings-content');
        }
        this._setupFocus();
    }

    _switchTab(tabId, force = false, focusContent = false) {
        if (this.activeTab === tabId && !force) return;
        this.activeTab = tabId;

        // Update sidebar UI
        this.$$('.settings-menu-btn').forEach((btn) => {
            btn.classList.toggle('active', btn.dataset.tab === tabId);
        });

        // Re-render content panel for portrait view
        const panel = this.$('#settings-content-panel');
        if (panel) {
            panel.innerHTML = `
                <div class="settings-tab-body" id="settings-tab-body">
                    ${this._renderActiveTabContent()}
                    <!-- Bottom scrolling buffer so mobile navigation bar never obstructs the last setting control -->
                    <div class="settings-bottom-spacer" aria-hidden="true"></div>
                </div>
            `;
            panel.scrollTop = 0; // Reset scroll position to top on tab change

            // Apply translations to the newly rendered content
            i18n.translateDOM(panel);

            this._bindContentEvents(); // Re-bind events for new content

            if (tabId === 'home') {
                this._setupHomeLayoutUI();
            } else if (tabId === 'sidebar') {
                this._setupSidebarLayoutUI();
            } else if (tabId === 'libraries') {
                this._setupLibrariesTabUI();
            } else if (tabId === 'backup') {
                this._updateBackupStatusDisplay();
            } else if (tabId === 'plugins') {
                this._refreshSeerrStatus();
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

    /**
     * Setup Sidebar Layout UI and default focus selector.
     * Delegates to the extracted SidebarTab controller.
     */
    async _setupSidebarLayoutUI() {
        if (this.sidebarTab) {
            await this.sidebarTab.setupSidebarLayoutUI();
        }
    }

    /**
     * Initialize and bind events for the admin Libraries tab.
     * Delegates to the extracted LibrariesTab controller.
     * Metadata refresh modes supported: 'ValidationOnly', 'Default', 'FullRefresh'.
     */
    async _setupLibrariesTabUI() {
        if (this.librariesTab) {
            await this.librariesTab.mount(this.element);
        }
    }

    /**
     * Setup Home Screen Layout ordering UI and visibility controls.
     * Delegates to the extracted HomeTab controller.
     */
    async _setupHomeLayoutUI() {
        if (this.homeTab) {
            await this.homeTab.setupHomeLayoutUI();
        }
    }

    /**
     * Helper to get the human-readable summary of custom collections selected.
     * Delegates to CustomCollectionsModal helper.
     * @returns {string}
     */
    _getCustomCollectionsLabel() {
        return getCustomCollectionsLabel();
    }

    /**
     * Show custom collections management dialog.
     * Delegates to the extracted HomeTab and CustomCollectionsModal controller.
     */
    async _showCustomCollectionsModal() {
        if (this.homeTab) {
            await this.homeTab.showCustomCollectionsModal();
        }
    }

    _setupFocus() {
        // Navigation: Sidebar <-> Content
        // We define these purely logically (LTR space).
        // FocusManager automatically inverts 'leaveLeft' and 'leaveRight' when document dir is 'rtl'.
        const isPortrait = this._isPortraitMode();

        this.registerFocusSection('settings-sidebar', this.$('#settings-sidebar'), {
            orientation: 'vertical',
            leaveRight: isPortrait ? null : 'settings-content',
            leaveLeft: 'sidebar',
            enterTo: 'last-focused',
            defaultFocusSelector: '.settings-menu-btn.active'
        });

        this.registerFocusSection('settings-content', this.$('#settings-content-panel'), {
            orientation: 'grid',
            leaveLeft: isPortrait ? null : 'settings-sidebar',
            leaveRight: null,
            enterTo: 'first',
            onEnter: (fromElement, options) => {
                // When entering the Plugins tab, prioritize focusing the first installed plugin toggle
                // rather than the top header dashboard action button.
                if (this.activeTab === 'plugins') {
                    const firstPluginToggle = this.$('.toggle-switch[data-plugin-id]');
                    if (firstPluginToggle) {
                        return firstPluginToggle;
                    }
                }
                return null;
            },
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
                        // Check if navigating inside the About action cards grid
                        const aboutGrid = currentElement.closest('.about-actions-grid');
                        if (aboutGrid) {
                            // Collect focusable cards inside the grid
                            const focusSelector = 'a, button, input, select, [tabindex]:not([tabindex="-1"])';
                            const candidates = Array.from(aboutGrid.querySelectorAll(focusSelector)).filter(
                                (el) => el.tabIndex !== -1 && !el.disabled && el.offsetParent !== null
                            );

                            // Check if there is another card to the left within the grid
                            const nextInGrid = spatialNavigator.findNext(currentElement, candidates, 'left');
                            if (nextInGrid) {
                                focusManager.focusElement(nextInGrid);
                                return true;
                            }

                            // If on the leftmost column, smoothly transition to the settings sidebar
                            focusManager._leaveSection('left');
                            return true;
                        }

                        // If not in a setting-item or about-actions-grid (fallback), just escape
                        focusManager._leaveSection('left');
                        return true;
                    }
                }
                return false;
            }
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

    onBack() {
        const overlay = this.$('#modal-overlay');
        if (overlay && overlay.classList.contains('visible')) {
            // Check if Favorite Languages modal is open
            if (overlay.querySelector('.fav-languages-modal')) {
                this._closeFavoriteLanguagesModal();
                return true;
            }
            // Check if Custom Collections modal is open
            if (overlay.querySelector('.custom-collections-modal')) {
                this.homeTab?.customCollectionsModal?.close();
                return true;
            }
            // Check if About dialog modal is open
            if (overlay.querySelector('.about-dialog-modal')) {
                this._closeAboutDialog();
                return true;
            }
            this._closeSelectionModal();
            return true;
        }

        // Mobile portrait 2-page navigation:
        // If the user is currently viewing the details of a tab,
        // pressing Back returns them to the category tab selection list.
        if (this._mobileDetailOpen) {
            this._closeMobileDetail(true);
            return true;
        }

        router.back();
        return true;
    }

    onBeforeDestroy() {
        // Detach viewport resize observer to avoid memory leaks
        if (this._onResize) {
            window.removeEventListener('resize', this._onResize);
            window.removeEventListener('orientationchange', this._onResize);
            this._onResize = null;
        }
        if (this._onPopState) {
            window.removeEventListener('popstate', this._onPopState);
            this._onPopState = null;
        }
        if (typeof document !== 'undefined' && document.body) {
            document.body.classList.remove('settings-mobile-portrait');
        }
        // Clean up encapsulated tab controllers
        if (this.aboutTab) {
            this.aboutTab.destroy();
        }
        if (this.librariesTab) {
            this.librariesTab.destroy();
        }
        if (this.pluginsTab) {
            this.pluginsTab.destroy();
        }
        if (this.accountTab) {
            this.accountTab.destroy();
        }
        if (this.controlsTab) {
            this.controlsTab.destroy();
        }
        if (this.performanceTab) {
            this.performanceTab.destroy();
        }
        if (this.debugTab) {
            this.debugTab.destroy();
        }
        if (this.backupTab) {
            this.backupTab.destroy();
        }
        if (this.homeTab) {
            this.homeTab.destroy();
        }
        if (this.sidebarTab) {
            this.sidebarTab.destroy();
        }
        if (this.subtitlesTab) {
            this.subtitlesTab.destroy();
        }
        if (this.playerTab) {
            this.playerTab.destroy();
        }
        if (this.layoutTab) {
            this.layoutTab.destroy();
        }
        if (this.appearanceTab) {
            this.appearanceTab.destroy();
        }
        if (this.themeColorModal) {
            this.themeColorModal.destroy();
        }
        if (this.loaderStyleModal) {
            this.loaderStyleModal.destroy();
        }
        if (this.favoriteLanguagesModal) {
            this.favoriteLanguagesModal.destroy();
        }
        if (this.selectionModal) {
            this.selectionModal.destroy();
        }

        // Notify navigation components that Settings page is unmounting
        eventBus.emit('mobile:detail-state-change', { isOpen: false });
    }

    /**
     * Renders user avatar markup by delegating to AccountTab controller.
     * @param {Object} user Current authenticated user payload
     * @returns {string} Serialized HTML markup for the avatar
     */
    _renderUserAvatar(user) {
        return this.accountTab ? this.accountTab.renderUserAvatar(user) : '';
    }
}

export default SettingsPage;
