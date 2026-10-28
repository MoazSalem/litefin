/**
 * ============================================================================
 * Litefin Tizen - Performance Tab Controller
 * ============================================================================
 * Manages rendering optimization, hardware acceleration flags, vertical and
 * horizontal animation loops, scroll alignment, blurhash backdrop decoding,
 * memory conservation heuristics, and cache retention rules.
 * ============================================================================
 */

import { storage } from '../../../utils/StorageService.js';
import { platformInfo } from '../../../utils/PlatformInfo.js';
import { layoutManager } from '../../../ui/LayoutManager.js';
import { PlayerSettings } from '../../../utils/PlayerSettings.js';
import { i18n } from '../../../utils/i18n.js';
import { logger } from '../../../utils/Logger.js';

const log = logger.create('PerformanceTab');

/**
 * Controller for the Settings Performance and Memory management tab.
 */
export class PerformanceTab {
    /**
     * Creates an instance of PerformanceTab.
     * @param {Object} pageContext The parent SettingsPage instance
     */
    constructor(pageContext) {
        // Retain parent page context for dropdown rendering and spatial navigation
        this.page = pageContext;

        // Track active event listeners for deterministic cleanup
        this._listeners = [];
    }

    /**
     * Helper to render dropdown markup via parent page facade.
     * @private
     */
    _renderDropdown(id, options, current) {
        if (this.page && typeof this.page._renderDropdown === 'function') {
            return this.page._renderDropdown(id, options, current);
        }
        return '';
    }

    /**
     * Generates HTML markup for the Performance tab.
     * @returns {string} Serialized HTML template
     */
    render() {
        const isTv = platformInfo.isTizen || platformInfo.isWebOS || platformInfo.isAndroid;
        const savedReloadPref = storage.getItem('pref:reloadOnResume');
        const reloadOnResumeEnabled = savedReloadPref !== null ? savedReloadPref === 'true' : isTv;

        const vertScrollMode =
            storage.getItem('pref:verticalScrollMode') || 'native';
        /*
         * Horizontal scrolling mode resolution.
         * Defaults to 'native' (Smooth) across all environments.
         * Eliminates platform-specific fragmentation so all targets share smooth scrolling.
         */
        const horizScrollMode =
            storage.getItem('pref:horizontalScrollMode') ||
            'native';
        /*
         * Vertical scroll smoothing duration resolution.
         * Defaults to 'smooth' for fluid navigation speed and duration.
         */
        const scrollSmoothing = storage.getItem('pref:scrollSmoothingDuration') || 'smooth';
        /*
         * Scroll motion physics engine resolution.
         * Defaults to velocity-based spring dynamics.
         */
        const scrollPhysics = storage.getItem('pref:scrollPhysics') || 'spring';
        const scrollAlignment = storage.getItem('pref:verticalScrollAlignment') || 'bottom';
        const libraryPageSize = storage.getItem('pref:libraryPageSize') || 50;
        const queueEpisodeLimit = PlayerSettings.get('playQueueEpisodeLimit') || 50;

        return `
            <div class="settings-tab-content">
                <h2 class="content-title" data-i18n="Performance">${i18n.t('Performance') || 'Performance'}</h2>
                <p class="content-subtitle" data-i18n="PerformanceTabDescription">${i18n.t('PerformanceTabDescription') || 'Optimize memory usage, scrolling animations, cache policies, and rendering speed.'}</p>

                <div class="setting-item">
                    <div class="setting-label"><span class="setting-name" data-i18n="LabelReloadOnResume">${i18n.t('LabelReloadOnResume') || 'Reload Page on Resume'}</span><span class="setting-description" data-i18n="ReloadOnResumeDescription">${i18n.t('ReloadOnResumeDescription') || 'Automatically reload the active view when returning from background or waking from sleep.'}</span></div>
                    <div class="setting-control"><button class="toggle-switch ${reloadOnResumeEnabled ? 'active' : ''}" id="toggle-reload-on-resume" tabindex="0"></button></div>
                </div>

                <div class="setting-item">
                    <div class="setting-label"><span class="setting-name" data-i18n="LabelUseBatchLatestPlugin">${i18n.t('LabelUseBatchLatestPlugin') || 'Use Plugin for Home Libraries'}</span><span class="setting-description" data-i18n="UseBatchLatestPluginDescription">${i18n.t('UseBatchLatestPluginDescription') || 'Fetch all home screen library rows in a single batched HTTP request via the Litefin plugin.'}</span></div>
                    <div class="setting-control"><button class="toggle-switch ${storage.getItem('pref:useBatchLatestPlugin') !== 'false' ? 'active' : ''}" id="toggle-use-batch-latest-plugin" tabindex="0"></button></div>
                </div>

                <div class="setting-item">
                    <div class="setting-label"><span class="setting-name" data-i18n="UseItemsForSearch">${i18n.t('UseItemsForSearch') || 'Use Items API for Search'}</span><span class="setting-description" data-i18n="UseItemsForSearchDescription">${i18n.t('UseItemsForSearchDescription') || 'Query the /Items API instead of /Search/Hints for global search.'}</span></div>
                    <div class="setting-control"><button class="toggle-switch ${storage.getItem('pref:useItemsForSearch') === 'true' ? 'active' : ''}" id="toggle-use-items-for-search" tabindex="0"></button></div>
                </div>

                <div class="setting-item">
                    <div class="setting-label"><span class="setting-name" data-i18n="VerticalScrollMode">${i18n.t('VerticalScrollMode') || 'Vertical Scroll Animation'}</span><span class="setting-description" data-i18n="VerticalScrollModeDescription">${i18n.t('VerticalScrollModeDescription') || 'Choose how vertical page scrolling is animated.'}</span></div>
                    <div class="setting-control">${this._renderDropdown(
                        'vertical-scroll-mode-select',
                        [
                            { value: 'current', label: i18n.t('ScrollModeCurrent') || 'Normal (Current)' },
                            { value: 'native', label: i18n.t('ScrollModeNative') || 'Smooth (Native)' },
                            { value: 'gpu', label: i18n.t('ScrollModeGpu') || 'Fast (GPU Accelerated)' },
                            { value: 'instant', label: i18n.t('ScrollModeInstant') || 'Instant (No Animation)' }
                        ],
                        vertScrollMode
                    )}</div>
                </div>

                <div class="setting-item">
                    <div class="setting-label"><span class="setting-name" data-i18n="HorizontalScrollMode">${i18n.t('HorizontalScrollMode') || 'Horizontal Scroll Animation'}</span><span class="setting-description" data-i18n="HorizontalScrollModeDescription">${i18n.t('HorizontalScrollModeDescription') || 'Choose how horizontal media row scrolling is animated.'}</span></div>
                    <div class="setting-control">${this._renderDropdown(
                        'horizontal-scroll-mode-select',
                        [
                            /*
                             * Option 1: Smooth (Native container scrolling) - standard default for all targets
                             * Option 2: Fast (GPU Accelerated translate3d)
                             * Option 3: Instant (Immediate jump without animation)
                             */
                            { value: 'native', label: i18n.t('ScrollModeNative') || 'Smooth (Native)' },
                            { value: 'gpu', label: i18n.t('ScrollModeGpu') || 'Fast (GPU Accelerated)' },
                            { value: 'instant', label: i18n.t('ScrollModeInstant') || 'Instant (No Animation)' }
                        ],
                        horizScrollMode
                    )}</div>
                </div>

                <div class="setting-item">
                    <div class="setting-label"><span class="setting-name" data-i18n="ScrollSmoothingDuration">${i18n.t('ScrollSmoothingDuration') || 'Scroll Smoothing (Duration)'}</span><span class="setting-description" data-i18n="ScrollSmoothingDurationDescription">${i18n.t('ScrollSmoothingDurationDescription') || 'Configure animation duration and speed for vertical row navigation.'}</span></div>
                    <div class="setting-control">${this._renderDropdown(
                        'scroll-smoothing-duration-select',
                        [
                            { value: 'instant', label: i18n.t('ScrollDurationInstant') || 'Instant (No Animation)' },
                            { value: 'current', label: i18n.t('ScrollDurationCurrent') || 'Fast' },
                            { value: 'smooth', label: i18n.t('ScrollDurationSmooth') || 'Smooth (Default)' },
                            { value: 'slower', label: i18n.t('ScrollDurationSlower') || 'Slower (Ultra Smooth)' }
                        ],
                        scrollSmoothing
                    )}</div>
                </div>

                <div class="setting-item">
                    <div class="setting-label"><span class="setting-name" data-i18n="ScrollPhysics">${i18n.t('ScrollPhysics') || 'Scroll Physics Engine'}</span><span class="setting-description" data-i18n="ScrollPhysicsDescription">${i18n.t('ScrollPhysicsDescription') || 'Velocity-based scroll motion. Spring is the Apple TV glide; Chase and Rail are tuned for slower TV panels (webOS 3 era); Fling adds a momentum sweep. Disable for the classic easing curves.'}</span></div>
                    <div class="setting-control">${this._renderDropdown(
                        'scroll-physics-select',
                        [
                            { value: 'easing', label: i18n.t('ScrollPhysicsEasing') || 'Classic Easing' },
                            { value: 'spring', label: i18n.t('ScrollPhysicsSpring') || 'Spring (Apple TV - Default)' },
                            { value: 'chase', label: i18n.t('ScrollPhysicsChase') || 'Chase (Continuous Follow)' },
                            { value: 'rail', label: i18n.t('ScrollPhysicsRail') || 'Rail (Constant Velocity)' },
                            { value: 'fling', label: i18n.t('ScrollPhysicsFling') || 'Fling (Momentum Sweep)' }
                        ],
                        scrollPhysics
                    )}</div>
                </div>

                <div class="setting-item">
                    <div class="setting-label"><span class="setting-name" data-i18n="VerticalScrollAlignment">${i18n.t('VerticalScrollAlignment') || 'Scroll Focus Alignment'}</span><span class="setting-description" data-i18n="VerticalScrollAlignmentDescription">${i18n.t('VerticalScrollAlignmentDescription') || 'Choose where focused rows align on screen.'}</span></div>
                    <div class="setting-control">${this._renderDropdown(
                        'vertical-scroll-alignment-select',
                        [
                            {
                                value: 'bottom',
                                label: i18n.t('ScrollAlignmentBottom') || 'Bottom (Default - Minimal Scrolling)'
                            },
                            { value: 'middle', label: i18n.t('ScrollAlignmentMiddle') || 'Middle (Centered)' },
                            { value: 'top', label: i18n.t('ScrollAlignmentTop') || 'Top (Classic Litefin)' }
                        ],
                        scrollAlignment
                    )}</div>
                </div>
                
                <div class="setting-item">
                    <div class="setting-label"><span class="setting-name" data-i18n="LabelLibraryPageSize">${i18n.t('LabelLibraryPageSize') || 'Items per page (Library)'}</span><span class="setting-description" data-i18n="LibraryPageSizeDescription">${i18n.t('LibraryPageSizeDescription') || 'Choose how many items to load at once in the grid view.'}</span></div>
                    <div class="setting-control">${this._renderDropdown(
                        'library-page-size-select',
                        [
                            { value: 25, label: '25' },
                            { value: 50, label: '50 (Default)' },
                            { value: 75, label: '75' },
                            { value: 100, label: '100' },
                            { value: 150, label: '150' },
                            { value: 'unlimited', label: i18n.t('OptionUnlimited') || 'Unlimited (Infinite Scroll)' }
                        ],
                        libraryPageSize
                    )}</div>
                </div>

                <div class="setting-item">
                    <div class="setting-label"><span class="setting-name" data-i18n="LabelPlayQueueEpisodeLimit">${i18n.t('LabelPlayQueueEpisodeLimit') || 'Episode Queue Window Size'}</span><span class="setting-description" data-i18n="PlayQueueEpisodeLimitDescription">${i18n.t('PlayQueueEpisodeLimitDescription') || 'Number of episodes to load into queue around active item.'}</span></div>
                    <div class="setting-control">${this._renderDropdown(
                        'play-queue-episode-limit-select',
                        [
                            { value: 25, label: '25' },
                            { value: 50, label: '50 (Default)' },
                            { value: 75, label: '75' },
                            { value: 100, label: '100' },
                            { value: 150, label: '150' }
                        ],
                        queueEpisodeLimit
                    )}</div>
                </div>

                <div class="setting-item" id="alpha-picker-scroll-mode-item" style="${storage.getItem('pref:libraryPageSize') === 'unlimited' ? '' : 'display: none;'}">
                    <div class="setting-label"><span class="setting-name" data-i18n="LabelAlphaPickerScrollMode">${i18n.t('LabelAlphaPickerScrollMode') || 'Alphabet Quick-Jump Action'}</span><span class="setting-description" data-i18n="AlphaPickerScrollModeDescription">${i18n.t('AlphaPickerScrollModeDescription') || 'In unlimited mode, scroll directly to letter sections.'}</span></div>
                    <div class="setting-control"><button class="toggle-switch ${storage.getItem('pref:alphaPickerScrollMode') !== 'false' ? 'active' : ''}" id="toggle-alpha-picker-scroll-mode" tabindex="0"></button></div>
                </div>

                <div class="setting-item">
                    <div class="setting-label"><span class="setting-name" data-i18n="LabelOnlyBlurHashBackdrop">${i18n.t('LabelOnlyBlurHashBackdrop') || 'Only Use BlurHash for Details Backdrop'}</span><span class="setting-description" data-i18n="OnlyBlurHashBackdropDescription">${i18n.t('OnlyBlurHashBackdropDescription') || 'Use lightweight blurhash instead of heavy background image.'}</span></div>
                    <div class="setting-control"><button class="toggle-switch ${layoutManager.getOnlyBlurHashBackdrop() ? 'active' : ''}" id="toggle-only-blurhash-backdrop" tabindex="0"></button></div>
                </div>

                <div class="setting-item">
                    <div class="setting-label"><span class="setting-name" data-i18n="LabelLightMusicPlayer">${i18n.t('LabelLightMusicPlayer') || 'Light Music Player'}</span><span class="setting-description" data-i18n="LightMusicPlayerDescription">${i18n.t('LightMusicPlayerDescription') || 'Removes background blur from music player on older TVs.'}</span></div>
                    <div class="setting-control"><button class="toggle-switch ${layoutManager.getLightMusicPlayer() ? 'active' : ''}" id="toggle-light-music-player" tabindex="0"></button></div>
                </div>

                <div class="setting-item">
                    <div class="setting-label"><span class="setting-name" data-i18n="LabelLowVramMode">${i18n.t('LabelLowVramMode') || 'Low VRAM Mode'}</span><span class="setting-description" data-i18n="LowVramModeDescription">${i18n.t('LowVramModeDescription') || 'Disable GPU animations on older hardware.'}</span></div>
                    <div class="setting-control"><button class="toggle-switch ${layoutManager.getLowVramMode() ? 'active' : ''}" id="toggle-low-vram-mode" tabindex="0"></button></div>
                </div>

                <div class="setting-item">
                    <div class="setting-label"><span class="setting-name" data-i18n="LabelDisableCardScaling">${i18n.t('LabelDisableCardScaling') || 'Disable Card Scaling'}</span><span class="setting-description" data-i18n="DisableCardScalingDescription">${i18n.t('DisableCardScalingDescription') || 'Stop movie posters from scaling up when focused.'}</span></div>
                    <div class="setting-control"><button class="toggle-switch ${layoutManager.getDisableCardScaling() ? 'active' : ''}" id="toggle-disable-card-scaling" tabindex="0"></button></div>
                </div>

                <div class="setting-item">
                    <div class="setting-label"><span class="setting-name" data-i18n="ReduceMotionLargeScrolls">${i18n.t('ReduceMotionLargeScrolls') || 'Reduce Motion (Large Scrolls)'}</span><span class="setting-description" data-i18n="ReduceMotionLargeScrollsDescription">${i18n.t('ReduceMotionLargeScrollsDescription') || 'Instantly snap to target on large scroll operations.'}</span></div>
                    <div class="setting-control"><button class="toggle-switch ${storage.getItem('pref:snapLargeScrolls') === 'true' ? 'active' : ''}" id="toggle-snap-large-scrolls" tabindex="0"></button></div>
                </div>           

                <div class="setting-item">
                    <div class="setting-label"><span class="setting-name" data-i18n="LabelDisableBlurHash">${i18n.t('LabelDisableBlurHash') || 'Disable BlurHash'}</span><span class="setting-description" data-i18n="DisableBlurHashDescription">${i18n.t('DisableBlurHashDescription') || 'Stop showing color-accurate blurred backgrounds while images are loading.'}</span></div>
                    <div class="setting-control"><button class="toggle-switch ${layoutManager.getDisableBlurhash() ? 'active' : ''}" id="toggle-disable-blurhash" tabindex="0"></button></div>
                </div>

                <div class="setting-item">
                    <div class="setting-label"><span class="setting-name" data-i18n="LabelDisableLibraryBlurHash">${i18n.t('LabelDisableLibraryBlurHash') || 'Disable BlurHash in Library'}</span><span class="setting-description" data-i18n="DisableLibraryBlurHashDescription">${i18n.t('DisableLibraryBlurHashDescription') || 'Stop decoding BlurHash canvases in library grids to maximize navigation speed.'}</span></div>
                    <div class="setting-control"><button class="toggle-switch ${layoutManager.getDisableLibraryBlurhash() ? 'active' : ''}" id="toggle-disable-library-blurhash" tabindex="0"></button></div>
                </div>

                <div class="setting-item">
                    <div class="setting-label"><span class="setting-name" data-i18n="LabelDisableFocusRestore">${i18n.t('LabelDisableFocusRestore') || 'Disable Focus Restoration'}</span><span class="setting-description" data-i18n="DisableFocusRestoreDescription">${i18n.t('DisableFocusRestoreDescription') || 'Skip saving and restoring last focused item between pages.'}</span></div>
                    <div class="setting-control"><button class="toggle-switch ${storage.getItem('pref:disableFocusRestore') === 'true' ? 'active' : ''}" id="toggle-disable-focus-restore" tabindex="0"></button></div>
                </div>

                <div class="setting-item">
                    <div class="setting-label"><span class="setting-name" data-i18n="HomeScreenCache">${i18n.t('HomeScreenCache') || 'Disable Home Screen Caching'}</span><span class="setting-description" data-i18n="HomeScreenCacheDescription">${i18n.t('HomeScreenCacheDescription') || 'Skip caching home screen data between page visits.'}</span></div>
                    <div class="setting-control"><button class="toggle-switch ${storage.getItem('pref:homeScreenCache') === 'false' ? 'active' : ''}" id="toggle-home-screen-cache" tabindex="0"></button></div>
                </div>

                <div class="setting-item">
                    <div class="setting-label"><span class="setting-name" data-i18n="LabelDisableLibraryCache">${i18n.t('LabelDisableLibraryCache') || 'Disable Library Cache'}</span><span class="setting-description" data-i18n="LabelDisableLibraryCacheDescription">${i18n.t('LabelDisableLibraryCacheDescription') || 'Skip caching library content between page visits.'}</span></div>
                    <div class="setting-control"><button class="toggle-switch ${storage.getItem('pref:disableLibraryCache') === 'true' ? 'active' : ''}" id="toggle-disable-library-cache" tabindex="0"></button></div>
                </div>
            </div>
        `;
    }

    /**
     * Helper to attach and track an event listener for cleanup.
     * @private
     */
    _addListener(element, event, handler) {
        if (!element) return;
        element.addEventListener(event, handler);
        this._listeners.push({ element, event, handler });
    }

    /**
     * Binds interactive events for Performance tab toggles.
     * @param {HTMLElement} [container] Root settings DOM element
     */
    mount(container) {
        this._unbindListeners();

        const root =
            container || (this.page && typeof this.page.$ === 'function' ? this.page.element : null) || document;

        // Toggle Reload Page on Resume
        const reloadResumeToggle = root.querySelector('#toggle-reload-on-resume');
        if (reloadResumeToggle) {
            this._addListener(reloadResumeToggle, 'click', () => {
                const isTv = platformInfo.isTizen || platformInfo.isWebOS || platformInfo.isAndroid;
                const current = storage.getItem('pref:reloadOnResume');
                const isEnabled = current !== null ? current === 'true' : isTv;
                const nextState = !isEnabled;
                storage.setItem('pref:reloadOnResume', String(nextState));
                reloadResumeToggle.classList.toggle('active', nextState);
                log.info(`Reload on resume preference set to: ${nextState}`);
            });
        }

        // Toggle Use Batch Latest Plugin
        const batchPluginToggle = root.querySelector('#toggle-use-batch-latest-plugin');
        if (batchPluginToggle) {
            this._addListener(batchPluginToggle, 'click', () => {
                const isEnabled = storage.getItem('pref:useBatchLatestPlugin') !== 'false';
                const nextState = !isEnabled;
                storage.setItem('pref:useBatchLatestPlugin', String(nextState));
                batchPluginToggle.classList.toggle('active', nextState);
                log.info(`Batch latest plugin preference set to: ${nextState}`);
            });
        }

        // Toggle Use Items API for Search
        const useItemsSearchToggle = root.querySelector('#toggle-use-items-for-search');
        if (useItemsSearchToggle) {
            this._addListener(useItemsSearchToggle, 'click', () => {
                const isEnabled = storage.getItem('pref:useItemsForSearch') === 'true';
                const nextState = !isEnabled;
                storage.setItem('pref:useItemsForSearch', String(nextState));
                useItemsSearchToggle.classList.toggle('active', nextState);
                log.info(`Use Items for Search preference set to: ${nextState}`);
            });
        }

        // Toggle Alphabet Quick-Jump Scroll Mode
        const alphaPickerToggle = root.querySelector('#toggle-alpha-picker-scroll-mode');
        if (alphaPickerToggle) {
            this._addListener(alphaPickerToggle, 'click', () => {
                const isEnabled = storage.getItem('pref:alphaPickerScrollMode') !== 'false';
                const nextState = !isEnabled;
                storage.setItem('pref:alphaPickerScrollMode', String(nextState));
                alphaPickerToggle.classList.toggle('active', nextState);
                log.info(`Alpha picker quick jump preference set to: ${nextState}`);
            });
        }

        // Toggle Only Use BlurHash for Details Backdrop
        const onlyBlurhashToggle = root.querySelector('#toggle-only-blurhash-backdrop');
        if (onlyBlurhashToggle) {
            this._addListener(onlyBlurhashToggle, 'click', () => {
                const nextState = !layoutManager.getOnlyBlurHashBackdrop();
                layoutManager.setOnlyBlurHashBackdrop(nextState);
                onlyBlurhashToggle.classList.toggle('active', nextState);
                log.info(`Only blurhash backdrop set to: ${nextState}`);
            });
        }

        // Toggle Light Music Player
        const lightMusicToggle = root.querySelector('#toggle-light-music-player');
        if (lightMusicToggle) {
            this._addListener(lightMusicToggle, 'click', () => {
                const nextState = !layoutManager.getLightMusicPlayer();
                layoutManager.setLightMusicPlayer(nextState);
                lightMusicToggle.classList.toggle('active', nextState);
                log.info(`Light music player set to: ${nextState}`);
            });
        }

        // Toggle Low VRAM Mode
        const lowVramToggle = root.querySelector('#toggle-low-vram-mode');
        if (lowVramToggle) {
            this._addListener(lowVramToggle, 'click', () => {
                const nextState = !layoutManager.getLowVramMode();
                layoutManager.setLowVramMode(nextState);
                lowVramToggle.classList.toggle('active', nextState);
                log.info(`Low VRAM mode set to: ${nextState}`);
            });
        }

        // Toggle Disable Card Scaling
        const disableCardScalingToggle = root.querySelector('#toggle-disable-card-scaling');
        if (disableCardScalingToggle) {
            this._addListener(disableCardScalingToggle, 'click', () => {
                const nextState = !layoutManager.getDisableCardScaling();
                layoutManager.setDisableCardScaling(nextState);
                disableCardScalingToggle.classList.toggle('active', nextState);
                log.info(`Disable card scaling set to: ${nextState}`);
            });
        }

        // Toggle Snap Large Scrolls
        const snapLargeScrollsToggle = root.querySelector('#toggle-snap-large-scrolls');
        if (snapLargeScrollsToggle) {
            this._addListener(snapLargeScrollsToggle, 'click', () => {
                const isEnabled = storage.getItem('pref:snapLargeScrolls') === 'true';
                const nextState = !isEnabled;
                storage.setItem('pref:snapLargeScrolls', String(nextState));
                snapLargeScrollsToggle.classList.toggle('active', nextState);
                log.info(`Snap large scrolls set to: ${nextState}`);
            });
        }

        // Toggle Disable BlurHash
        const disableBlurhashToggle = root.querySelector('#toggle-disable-blurhash');
        if (disableBlurhashToggle) {
            this._addListener(disableBlurhashToggle, 'click', () => {
                const nextState = !layoutManager.getDisableBlurhash();
                layoutManager.setDisableBlurhash(nextState);
                disableBlurhashToggle.classList.toggle('active', nextState);
                log.info(`Disable blurhash set to: ${nextState}`);
            });
        }

        // Toggle Disable BlurHash in Library is wired centrally by SettingsPage controller

        // Toggle Disable Focus Restoration
        const disableFocusRestoreToggle = root.querySelector('#toggle-disable-focus-restore');
        if (disableFocusRestoreToggle) {
            this._addListener(disableFocusRestoreToggle, 'click', () => {
                const isEnabled = storage.getItem('pref:disableFocusRestore') === 'true';
                const nextState = !isEnabled;
                storage.setItem('pref:disableFocusRestore', String(nextState));
                disableFocusRestoreToggle.classList.toggle('active', nextState);
                log.info(`Disable focus restore set to: ${nextState}`);
            });
        }

        // Toggle Home Screen Caching
        const homeCacheToggle = root.querySelector('#toggle-home-screen-cache');
        if (homeCacheToggle) {
            this._addListener(homeCacheToggle, 'click', () => {
                const isDisabled = storage.getItem('pref:homeScreenCache') === 'false';
                const nextState = !isDisabled;
                storage.setItem('pref:homeScreenCache', nextState ? 'false' : 'true');
                homeCacheToggle.classList.toggle('active', nextState);
                log.info(`Disable home screen cache set to: ${nextState}`);
            });
        }

        // Toggle Disable Library Cache
        const disableLibCacheToggle = root.querySelector('#toggle-disable-library-cache');
        if (disableLibCacheToggle) {
            this._addListener(disableLibCacheToggle, 'click', () => {
                const isEnabled = storage.getItem('pref:disableLibraryCache') === 'true';
                const nextState = !isEnabled;
                storage.setItem('pref:disableLibraryCache', String(nextState));
                disableLibCacheToggle.classList.toggle('active', nextState);
                log.info(`Disable library cache set to: ${nextState}`);
            });
        }
    }

    /**
     * Unbinds registered DOM event listeners.
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
     * Teardown lifecycle hook called when unmounting or switching tabs.
     */
    destroy() {
        this._unbindListeners();
        this.page = null;
    }
}

export default PerformanceTab;
