/**
 * ============================================================================
 * Litefin Tizen - Settings Dropdown Dispatcher Controller
 * ============================================================================
 * Coordinates dropdown selection events, async options population, and executes
 * targeted preference persistence, hardware decoder updates, and state cache invalidations.
 * ============================================================================
 */

import { api } from '../../../api/index.js';
import { state } from '../../../core/StateManager.js';
import { router } from '../../../core/Router.js';
import { eventBus } from '../../../core/EventBus.js';
import { clearCapabilitiesCache } from '../../../api/DeviceProfile.js';
import { layoutManager } from '../../../ui/LayoutManager.js';
import { focusManager } from '../../../ui/FocusManager.js';
import { imageService } from '../../../utils/ImageService.js';
import { PlayerSettings } from '../../../utils/PlayerSettings.js';
import FontLoader from '../../../utils/FontLoader.js';
import { debugOverlay } from '../../../ui/DebugOverlay.js';
import { storage } from '../../../utils/StorageService.js';
import { i18n } from '../../../utils/i18n.js';
import CardRenderer from '../../../utils/CardRenderer.js';
import { logger } from '../../../utils/Logger.js';
import { getSettingsDropdownMap } from './SettingsDropdownConfig.js';
import { resolveAsyncDropdownOptions } from './SettingsDropdownAsyncOptions.js';

const log = logger.create('SettingsDropdownDispatcher');

/**
 * Controller class governing dropdown triggers and preference updates.
 */
export class SettingsDropdownDispatcher {
    /**
     * Creates an instance of SettingsDropdownDispatcher.
     * @param {Object} page Host SettingsPage instance
     */
    constructor(page) {
        this.page = page;
        this.settingsMap = getSettingsDropdownMap();
    }

    /**
     * Binds click listeners to all dropdown selector buttons in the settings view.
     * Restricts query to elements with data-id to avoid intercepting action buttons.
     */
    bindDropdownEvents() {
        const selectButtons = this.page.$$('.select-btn');
        if (!selectButtons || !selectButtons.length) return;

        // Iterate through all rendered dropdown elements
        selectButtons.forEach((btn) => {
            const id = btn.dataset.id;
            if (!id) return;

            btn.addEventListener('click', async () => {
                let options = [];
                try {
                    options = JSON.parse(btn.dataset.options);
                } catch (_) {}

                const currentValue = btn.dataset.value;
                const settingConfig = this.settingsMap[id];
                const title =
                    btn.closest('.setting-item')?.querySelector('.setting-name')?.textContent || i18n.t('SelectOption');

                // Delegate dynamic async options population
                options = await resolveAsyncDropdownOptions(this.page, id, btn, options, currentValue);

                // Open selection modal overlay with options
                if (typeof this.page._renderSelectionModal === 'function') {
                    this.page._renderSelectionModal(
                        title,
                        options,
                        currentValue,
                        (newValue) => {
                            this._applySettingValue(id, newValue, btn, options, settingConfig);
                        },
                        id
                    );
                }
            });
        });
    }

    /**
     * Dispatches setting persistence and side-effects across subsystems.
     * @private
     */
    _applySettingValue(id, newValue, btn, options, settingConfig) {
        // Update button visual label and stored dataset value
        const newLabel = options.find((o) => String(o.value) === String(newValue))?.label;
        const labelSpan = btn.querySelector('.btn-label');
        if (labelSpan) labelSpan.innerText = newLabel;
        btn.dataset.value = newValue;

        // Store collection names for trending labels
        if (id === 'trending-movies-collection-select') {
            storage.setItem('pref:trendingMoviesCollectionName', newLabel);
        } else if (id === 'trending-series-collection-select') {
            storage.setItem('pref:trendingSeriesCollectionName', newLabel);
        }

        if (!settingConfig) {
            log.debug(`Setting ${id} saved without config: ${newValue}`);
            return;
        }

        // Dispatch based on configuration target type
        if (settingConfig.type === 'local') {
            this._applyLocalSetting(id, newValue, settingConfig);
        } else if (settingConfig.type === 'service') {
            imageService.setPreset(newValue);
        } else if (settingConfig.type === 'details-service') {
            imageService.setDetailsPreset(newValue);
        } else if (settingConfig.type === 'player') {
            this._applyPlayerSetting(id, newValue, settingConfig);
        } else if (settingConfig.type === 'debug') {
            storage.setItem(settingConfig.key, newValue);
            if (settingConfig.key === 'debug_width') debugOverlay.setWidth(newValue);
            else if (settingConfig.key === 'debug_height') debugOverlay.setHeight(newValue);
            else if (settingConfig.key === 'debug_position') debugOverlay.setPosition(newValue);
        }

        log.debug(`Setting ${id} saved: ${newValue}`);
    }

    /**
     * Dispatches settings mapped to local storage and UI layout controllers.
     * @private
     */
    _applyLocalSetting(id, newValue, settingConfig) {
        // Direct layout setter mapping table
        const setters = {
            'alpha-picker-position-select': () => layoutManager.setAlphaPickerPosition(newValue),
            'default-library-view-mode-select': () => this._handleDefaultLibraryViewMode(newValue),
            'default-library-columns-select': () => {
                const activeDefaultMode = layoutManager.getDefaultLibraryViewMode() || 'poster';
                layoutManager.setDefaultLibraryGridColumns(newValue, activeDefaultMode);
            },
            'badge-style-select': () => layoutManager.setBadgeStyle(newValue),
            'button-style-select': () => layoutManager.setButtonStyle(newValue),
            'focus-border-style-select': () => layoutManager.setFocusBorderStyle(newValue),
            'hover-border-style-select': () => layoutManager.setHoverBorderStyle(newValue),
            'sidebar-selected-color-select': () => layoutManager.setSidebarSelectedColor(newValue),
            'sidebar-unselected-color-select': () => layoutManager.setSidebarUnselectedColor(newValue),
            'sidebar-logo-color-select': () => layoutManager.setSidebarLogoColor(newValue),
            'sidebar-icon-shadows-select': () => layoutManager.setSidebarIconShadows(newValue === 'shadow' || newValue === 'true'),
            'osd-button-style-select': () => layoutManager.setOsdButtonStyle(newValue),
            'osd-focus-border-style-select': () => layoutManager.setOsdFocusBorderStyle(newValue),
            'osd-button-shape-select': () => layoutManager.setOsdButtonShape(newValue),
            'osd-unfocused-button-style-select': () => layoutManager.setOsdUnfocusedButtonStyle(newValue),
            'osd-seekbar-thumb-color-select': () => layoutManager.setOsdSeekBarThumbColor(newValue),
            'osd-seekbar-progress-color-select': () => layoutManager.setOsdSeekBarProgressColor(newValue),
            'theme-mode-select': () => {
                layoutManager.setThemeMode(newValue);
                this.page._updateLighterBackgroundVisibility?.();
                this.page._updateSignatureAccentVisibility?.();
            },
            'watched-threshold-select': () => {
                PlayerSettings.set('watchedThreshold', newValue);
                if (newValue === 'server') {
                    api.getServerConfiguration({ silent: true }).catch((err) => {
                        log.warn('Unable to query server configuration for watched threshold:', err);
                    });
                }
            }
        };

        if (setters[id]) {
            setters[id]();
        } else {
            storage.setItem(settingConfig.key, newValue);
        }

        // Library paging and layout cache invalidations
        if (settingConfig.key === 'pref:libraryPageSize') {
            state.clearByPrefix('library:state');
            if (router && typeof router.clearHistoryState === 'function') {
                router.clearHistoryState('/library');
            }
            eventBus.emit('pref:libraryPageSize:changed', newValue);
        }

        if (
            settingConfig.key === 'pref:defaultLibraryViewMode' ||
            settingConfig.key === 'pref:defaultLibraryGridColumns'
        ) {
            log.info(`Invalidating library caches due to default view layout change: ${settingConfig.key}=${newValue}`);
            state.clearByPrefix('library:state');
            if (router && typeof router.clearHistoryState === 'function') {
                router.clearHistoryState('/library');
            }
            eventBus.emit(settingConfig.key + ':changed', newValue);
        }

        if (settingConfig.key === 'pref:detailsLayout' || settingConfig.key === 'pref:seasonEpisodeDetailsLayout') {
            this.page._updateDetailsTitleStyleVisibility?.();
        }

        if (settingConfig.triggerEvent) {
            eventBus.emit(settingConfig.key, newValue);
        }

        // Trigger hard reload for structural application layout changes
        const RELOAD_KEYS = new Set([
            'pref:mediaRowsLayout', 'pref:loginPageLayout', 'layout_direction',
            'app_language', 'pref:classicCardSizeScale', 'pref:modernCardSizeScale',
            'pref:expandedCardSizeScale', 'pref:modernPostersCardSizeScale'
        ]);
        if (RELOAD_KEYS.has(settingConfig.key) && typeof this.page._triggerHardReload === 'function') {
            this.page._triggerHardReload();
        }

        if (settingConfig.key === 'pref:libraryThumbMode') {
            this._handleLibraryThumbMode(newValue);
        }

        if (id === 'screensaver-type-select') {
            const isBackdrop = newValue === 'backdrop';
            ['screensaver-dim-item', 'screensaver-hide-text-item', 'screensaver-include-music-item'].forEach((itemId) => {
                const el = document.getElementById(itemId);
                if (el) el.classList.toggle('hidden', !isBackdrop);
            });
            focusManager.invalidateCache('settings-content');
        }
    }

    /**
     * Handles column updates when switching default library layout modes.
     * @private
     */
    _handleDefaultLibraryViewMode(newValue) {
        layoutManager.setDefaultLibraryViewMode(newValue);
        const columnsItem = this.page.$('#item-default-library-columns');
        if (columnsItem) {
            columnsItem.style.display = newValue === 'list' ? 'none' : '';
        }

        // Adjust column count dropdown options based on the chosen view mode
        const colsBtn = this.page.$('#default-library-columns-select-btn');
        if (colsBtn && typeof this.page._getLibraryColumnOptionsForMode === 'function') {
            const newColOptions = this.page._getLibraryColumnOptionsForMode(newValue);
            const savedForNewMode = storage.getItem(`pref:defaultLibraryGridColumns:${newValue}`);
            const defaultColsForMode = { poster: '7', 'small-poster': '9', thumb: '4', banner: '3', list: '1' }[newValue] || '7';
            const selectedCol = newColOptions.some((o) => o.value === String(savedForNewMode)) ? String(savedForNewMode) : defaultColsForMode;
            colsBtn.dataset.options = JSON.stringify(newColOptions);
            colsBtn.dataset.value = selectedCol;
            const colLabel = colsBtn.querySelector('.btn-label');
            if (colLabel) {
                colLabel.innerText = newColOptions.find((o) => o.value === selectedCol)?.label || selectedCol;
            }
        }
        focusManager.invalidateCache('settings-content');
    }

    /**
     * Clears library thumbnail caches when thumb rendering mode toggles.
     * @private
     */
    _handleLibraryThumbMode(newValue) {
        const libraryThumbContainer = this.page.$('#library-thumb-regenerate-container');
        if (libraryThumbContainer) {
            libraryThumbContainer.style.display = newValue === 'static' ? '' : 'none';
            focusManager.invalidateCache('settings-content');
        }
        storage.clearByPrefix('libThumb:');
        const pageCache = state.get('home:pageCache');
        if (pageCache && pageCache.thumbUrls) {
            pageCache.thumbUrls = {};
            state.set('home:pageCache', pageCache);
        }
        CardRenderer.clearCache();
    }

    /**
     * Dispatches settings mapped to video playback, audio normalization, and codec limits.
     * @private
     */
    _applyPlayerSetting(id, newValue, settingConfig) {
        const floatKeys = ['webosBufferGate', 'subtitleAssPrescaleFactor'];
        const intKeys = [
            'skipForwardLength',
            'skipBackLength',
            'resumeRewindLength',
            'maxBitrateInternet',
            'webosStallRecovery',
            'webosSegmentLength',
            'tizenInitialBuffer',
            'tizenResumeBuffer',
            'tizenSegmentLength',
            'html5MaxBufferLength',
            'html5MaxMaxBufferLength',
            'html5SegmentLength',
            'playQueueEpisodeLimit'
        ];

        let val = newValue;
        if (floatKeys.includes(settingConfig.key)) {
            val = parseFloat(newValue);
        } else if (intKeys.includes(settingConfig.key)) {
            val = parseInt(newValue, 10);
        }
        PlayerSettings.set(settingConfig.key, val);

        if (settingConfig.key === 'playerBackend') {
            if (typeof this.page._switchTab === 'function') {
                this.page._switchTab('player', false, true);
            }
            return;
        }

        if (settingConfig.key === 'assRenderer') {
            const isLibass = newValue === 'libass-wasm';
            const animContainer = this.page.$('#ass-drop-animations-container');
            const scaleContainer = this.page.$('#ass-prescale-factor-container');
            if (animContainer) animContainer.style.display = isLibass ? '' : 'none';
            if (scaleContainer) scaleContainer.style.display = isLibass ? '' : 'none';
            focusManager.invalidateCache('settings-content');
        }

        // Flush hardware capabilities cache when codec parameters alter
        const CLEAR_CAPS_KEYS = new Set([
            'maxResolution', 'maxBitrateInternet', 'pgsPlaybackMode',
            'webosSegmentLength', 'tizenSegmentLength', 'html5SegmentLength',
            'enableHEVC', 'enableAV1', 'enableVP9', 'enableHDR',
            'enableDolbyVision', 'enableDts', 'enableTrueHd',
            'enableEac3', 'enableMp2', 'transcodeAudioCodec', 'forceDirectPlay'
        ]);
        if (CLEAR_CAPS_KEYS.has(settingConfig.key)) {
            clearCapabilitiesCache();
        }

        this._updatePlayerContainerVisibilities(id, newValue);

        // Preload fonts when plain or advanced subtitle typography updates
        if (settingConfig.key === 'subtitleFont' || settingConfig.key === 'subtitleFontAss') {
            storage.flush();
            if (newValue) {
                FontLoader.loadFont(newValue, true).then((loaded) => {
                    log.debug(`Font loaded status: ${newValue} = ${loaded}`);
                });
            }
        }
    }

    /**
     * Updates visibility toggles for auxiliary subtitle and clock preferences.
     * @private
     */
    _updatePlayerContainerVisibilities(id, newValue) {
        if (id === 'time-source-select') {
            const tzContainer = document.getElementById('time-timezone-item');
            if (tzContainer) {
                tzContainer.style.display = newValue === 'server' ? '' : 'none';
                focusManager.invalidateCache('settings-content');
            }
        }

        if (id === 'subtitle-bg-select') {
            const opacityContainer = document.getElementById('subtitle-bg-opacity-container');
            if (opacityContainer) {
                opacityContainer.style.display = (newValue === 'transparent' || newValue === 'none') ? 'none' : '';
                focusManager.invalidateCache('settings-content');
            }
        }

        if (id === 'subtitle-position-select' || id === 'subtitle-size-select') {
            const elId = id === 'subtitle-position-select' ? 'subtitle-custom-pos-container' : 'subtitle-custom-size-container';
            const targetContainer = document.getElementById(elId);
            if (targetContainer) {
                targetContainer.style.display = newValue === 'custom' ? '' : 'none';
                focusManager.invalidateCache('settings-content');
            }
        }

        if (id === 'subtitle-shadow-select') {
            const isBorder = newValue === 'border' || newValue === 'uniform_border';
            const isNoneOrBorder = newValue === 'none' || newValue === 'border';
            [
                ['subtitle-border-width-container', isBorder],
                ['subtitle-border-opacity-container', isBorder],
                ['subtitle-shadow-opacity-container', !isNoneOrBorder],
                ['subtitle-shadow-blur-container', !isNoneOrBorder]
            ].forEach(([elId, show]) => {
                const el = document.getElementById(elId);
                if (el) el.style.display = show ? '' : 'none';
            });
            focusManager.invalidateCache('settings-content');
        }
    }
}

export default SettingsDropdownDispatcher;
