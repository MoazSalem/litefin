/**
 * ============================================================================
 * Litefin Tizen - Layout Tab Controller
 * ============================================================================
 * Manages layout customizations including login page style, media rows modes,
 * library view modes, card scale, card labels & badges, and metadata badges.
 * (Details page and player OSD settings live in their dedicated tabs.)
 * ============================================================================
 */

import { storage } from '../../../utils/StorageService.js';
import { layoutManager } from '../../../ui/LayoutManager.js';
import { PlayerSettings } from '../../../utils/PlayerSettings.js';
import { i18n } from '../../../utils/i18n.js';
import { logger } from '../../../utils/Logger.js';

const log = logger.create('LayoutTab');

/** Selectable options for media card scale percentages */
const CARD_SIZE_PERCENTAGES = [
    { value: '1', label: '100%' },
    { value: '1.05', label: '105%' },
    { value: '1.1', label: '110%' },
    { value: '1.15', label: '115%' },
    { value: '1.2', label: '120%' },
    { value: '1.25', label: '125%' },
    { value: '1.3', label: '130%' },
    { value: '1.35', label: '135%' },
    { value: '1.4', label: '140%' },
    { value: '1.45', label: '145%' },
    { value: '1.5', label: '150%' }
];

/** Selectable options for card label text scales */
const CARD_LABEL_SCALES = [
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
    { value: '1.4', label: '140%' },
    { value: '1.45', label: '145%' },
    { value: '1.5', label: '150%' }
];

/**
 * Controller for the Settings Layout tab.
 */
export class LayoutTab {
    /**
     * Initializes a new instance of LayoutTab.
     * @param {Object} pageContext The parent SettingsPage instance
     */
    constructor(pageContext) {
        // Parent SettingsPage reference for dropdowns and sliders
        this.page = pageContext;
        // Event listeners tracked for deterministic cleanup
        this._listeners = [];
    }

    /** Helper to render dropdown markup via parent page facade */
    _drop(id, options, current, disabled = false) {
        return this.page?._renderDropdown ? this.page._renderDropdown(id, options, current, disabled) : '';
    }

    /** Helper to render slider control markup via parent page facade */
    _slider(id, value, min, max, step) {
        return this.page?._renderSlider ? this.page._renderSlider(id, value, min, max, step) : '';
    }

    /** Track and attach event listener on target element */
    _listen(element, event, handler) {
        if (!element) return;
        element.addEventListener(event, handler);
        this._listeners.push({ element, event, handler });
    }

    /**
     * Build selectable dropdown options for default library items per row.
     * @param {string} mode Layout view mode
     * @returns {Array<{value: string, label: string}>} Selectable column options
     */
    static getLibraryColumnOptionsForMode(mode) {
        const itemsWord = i18n.t('Items') || 'Items';
        const colMap = {
            poster: ['4', '5', '6', '7'].map((v) => ({ value: v, label: `${v} ${itemsWord}` })),
            'small-poster': ['8', '9', '10', '12'].map((v) => ({ value: v, label: `${v} ${itemsWord}` })),
            thumb: ['3', '4', '5', '6'].map((v) => ({ value: v, label: `${v} ${itemsWord}` })),
            banner: ['2', '3'].map((v) => ({ value: v, label: `${v} ${itemsWord}` })),
            list: [{ value: '1', label: `1 ${itemsWord}` }]
        };
        return colMap[mode] || colMap.poster;
    }

    /**
     * Renders Card Size Scale dropdown according to active media rows layout mode.
     * @private
     */
    _renderCardSizeDropdown() {
        const mediaRowsLayout = layoutManager.getMediaRowsLayout();
        const isExpanding = mediaRowsLayout === 'expanding';
        const isClassic = !['expanded', 'modern-posters', 'modern', 'expanding'].includes(mediaRowsLayout);

        const options = CARD_SIZE_PERCENTAGES.map((opt) => {
            if (
                (opt.value === '1.2' && !isExpanding && !isClassic) ||
                (opt.value === '1' && (isExpanding || isClassic))
            ) {
                return { value: opt.value, label: `${opt.label} (${i18n.t('Default') || 'Default'})` };
            }
            return opt;
        });

        const keyMap = {
            expanded: 'pref:expandedCardSizeScale',
            'modern-posters': 'pref:modernPostersCardSizeScale',
            modern: 'pref:modernCardSizeScale',
            expanding: 'pref:expandingCardSizeScale'
        };
        const storageKey = keyMap[mediaRowsLayout] || 'pref:classicCardSizeScale';
        const defVal = isExpanding || isClassic ? '1' : '1.2';
        return this._drop('classic-card-size-scale-select', options, storage.getItem(storageKey) || defVal);
    }

    /**
     * Renders the complete HTML markup for the Layout tab.
     * @returns {string} Serialized HTML template
     */
    render() {
        const mediaRowsLayout = layoutManager.getMediaRowsLayout();
        const curLibMode = layoutManager.getDefaultLibraryViewMode() || 'poster';
        const libColOptions = LayoutTab.getLibraryColumnOptionsForMode(curLibMode);
        const savedCols = layoutManager.getDefaultLibraryGridColumns(curLibMode);
        const activeCols = libColOptions.some((o) => String(o.value) === String(savedCols))
            ? String(savedCols)
            : String(libColOptions[libColOptions.length - 1]?.value || '7');

        return `
            <div class="settings-tab-content">
                <h2 class="content-title" data-i18n="Layout">${i18n.t('Layout') || 'Layout'}</h2>
                <p class="content-subtitle" data-i18n="LayoutTabDescription">${i18n.t('LayoutTabDescription') || 'Configure page structures, login and details layouts, and UI component alignments.'}</p>

                <div class="setting-item">
                    <div class="setting-label"><span class="setting-name" data-i18n="MediaRowsLayout">${i18n.t('MediaRowsLayout') || 'Media Rows Layout'}</span><span class="setting-description" data-i18n="MediaRowsLayoutDescription">${i18n.t('MediaRowsLayoutDescription') || 'Choose the layout mode for horizontal media rows.'}</span></div>
                    <div class="setting-control">${this._drop(
                        'media-rows-layout-select',
                        [
                            { value: 'classic', label: i18n.t('LayoutClassic') || 'Classic' },
                            { value: 'modern', label: i18n.t('LayoutModern') || 'Modern' },
                            { value: 'expanded', label: i18n.t('LayoutExpandedPosters') || 'Modern Cards' },
                            { value: 'modern-posters', label: i18n.t('LayoutModernPosters') || 'Modern Posters' },
                            { value: 'expanding', label: i18n.t('LayoutExpandingPosters') || 'Expanding Posters' }
                        ],
                        layoutManager.getMediaRowsLayout() || 'modern'
                    )}</div>
                </div>

                <div class="setting-item ${mediaRowsLayout === 'expanding' || mediaRowsLayout === 'expanded' ? '' : 'hidden'}" id="item-prefer-backdrops-over-thumbs">
                    <div class="setting-label"><span class="setting-name" data-i18n="PreferBackdropsOverThumbs">${i18n.t('PreferBackdropsOverThumbs') || 'Use Backdrops Instead of Thumbs'}</span><span class="setting-description" data-i18n="PreferBackdropsOverThumbsDescription">${i18n.t('PreferBackdropsOverThumbsDescription') || 'Prefer backdrop artwork over thumbnails for wide cards.'}</span></div>
                    <div class="setting-control"><button class="toggle-switch ${storage.getItem('pref:preferBackdropsOverThumbs') === 'true' ? 'active' : ''}" id="toggle-prefer-backdrops-over-thumbs" data-storage="pref:preferBackdropsOverThumbs" tabindex="0"></button></div>
                </div>

                <div class="setting-item ${mediaRowsLayout === 'expanding' ? '' : 'hidden'}" id="item-home-force-expandable-posters">
                    <div class="setting-label"><span class="setting-name" data-i18n="HomeForceExpandablePosters">${i18n.t('HomeForceExpandablePosters') || 'Force Expandable Posters'}</span><span class="setting-description" data-i18n="HomeForceExpandablePostersDescription">${i18n.t('HomeForceExpandablePostersDescription') || 'Force all home screen rows to use portrait posters that expand horizontally.'}</span></div>
                    <div class="setting-control"><button class="toggle-switch ${storage.getItem('pref:homeForceExpandablePosters') === 'true' ? 'active' : ''}" id="toggle-home-force-expandable-posters" data-storage="pref:homeForceExpandablePosters" tabindex="0"></button></div>
                </div>

                <div class="setting-item">
                    <div class="setting-label"><span class="setting-name" data-i18n="LoginPageLayout">${i18n.t('LoginPageLayout') || 'Login Page Layout'}</span><span class="setting-description" data-i18n="LoginPageLayoutDescription">${i18n.t('LoginPageLayoutDescription') || 'Choose the layout mode for the login pages.'}</span></div>
                    <div class="setting-control">${this._drop(
                        'login-page-layout-select',
                        [
                            { value: 'classic', label: i18n.t('LayoutClassic') || 'Classic' },
                            { value: 'modern', label: i18n.t('LayoutModernLoginPage') || 'Modern layout' }
                        ],
                        layoutManager.getLoginPageLayout() || 'classic'
                    )}</div>
                </div>

                <h3 class="setting-section-title" data-i18n="LibraryLayout">${i18n.t('LibraryLayout') || 'Library View Layout'}</h3>
                <div class="setting-item">
                    <div class="setting-label"><span class="setting-name" data-i18n="LabelDefaultLibraryViewMode">${i18n.t('LabelDefaultLibraryViewMode') || 'Default Library View Mode'}</span><span class="setting-description" data-i18n="DefaultLibraryViewModeDescription">${i18n.t('DefaultLibraryViewModeDescription') || 'Choose the default view layout for libraries.'}</span></div>
                    <div class="setting-control">${this._drop(
                        'default-library-view-mode-select',
                        [
                            { value: 'poster', label: i18n.t('ViewModePoster') || 'Poster' },
                            { value: 'small-poster', label: i18n.t('ViewModeSmallPoster') || 'Small' },
                            { value: 'thumb', label: i18n.t('ViewModeThumb') || 'Thumbs' },
                            { value: 'banner', label: i18n.t('ViewModeBanner') || 'Banner' },
                            { value: 'list', label: i18n.t('ViewModeList') || 'List' }
                        ],
                        curLibMode
                    )}</div>
                </div>

                <div class="setting-item" id="item-default-library-columns" style="${curLibMode === 'list' ? 'display: none;' : ''}">
                    <div class="setting-label"><span class="setting-name" data-i18n="LabelDefaultLibraryColumns">${i18n.t('LabelDefaultLibraryColumns') || 'Default Items Per Row'}</span><span class="setting-description" data-i18n="DefaultLibraryColumnsDescription">${i18n.t('DefaultLibraryColumnsDescription') || 'Choose the default number of items displayed per row for libraries.'}</span></div>
                    <div class="setting-control">${this._drop('default-library-columns-select', libColOptions, activeCols)}</div>
                </div>

                <div class="setting-item">
                    <div class="setting-label"><span class="setting-name" data-i18n="LabelAlphaPickerPosition">${i18n.t('LabelAlphaPickerPosition') || 'Alphabet Selector Position'}</span><span class="setting-description" data-i18n="AlphaPickerPositionDescription">${i18n.t('AlphaPickerPositionDescription') || 'Choose the layout and placement of the alphabet quick-jump selector.'}</span></div>
                    <div class="setting-control">${this._drop(
                        'alpha-picker-position-select',
                        [
                            { value: 'top', label: i18n.t('OptionAlphaPickerTop') || 'Top (Horizontal)' },
                            { value: 'right', label: i18n.t('OptionAlphaPickerRight') || 'Right Side (Vertical)' }
                        ],
                        layoutManager.getAlphaPickerPosition() || 'top'
                    )}</div>
                </div>

                <h3 class="setting-section-title" data-i18n="MediaRows">${i18n.t('MediaRows')}</h3>
                <div class="setting-item">
                    <div class="setting-label"><span class="setting-name" data-i18n="CardSizeScale">${i18n.t('CardSizeScale') || 'Card Size Scale'}</span><span class="setting-description" data-i18n="CardSizeScaleDescription">${i18n.t('CardSizeScaleDescription') || 'Adjust the size of horizontal row items.'}</span></div>
                    <div class="setting-control">${this._renderCardSizeDropdown()}</div>
                </div>

                <div class="setting-item">
                    <div class="setting-label"><span class="setting-name" data-i18n="CardLabelScale">${i18n.t('CardLabelScale') || 'Card Label Scale'}</span><span class="setting-description" data-i18n="CardLabelScaleDescription">${i18n.t('CardLabelScaleDescription') || 'Adjust the text size of titles and subtitles under media cards.'}</span></div>
                    <div class="setting-control">${this._drop('card-label-scale-select', CARD_LABEL_SCALES, (layoutManager.getCardLabelScale() || 1.0).toString())}</div>
                </div>

                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="SwapEpisodeTitles">${i18n.t('SwapEpisodeTitles') || 'Swap Episode Title & Subtitle'}</span><span class="setting-description" data-i18n="SwapEpisodeTitlesDescription">${i18n.t('SwapEpisodeTitlesDescription') || 'Display the episode name as the card title and show name as subtitle.'}</span></div><div class="setting-control"><button class="toggle-switch ${storage.getItem('pref:swapEpisodeTitles') !== 'false' ? 'active' : ''}" id="toggle-swap-episode-titles" data-storage="pref:swapEpisodeTitles" data-default="true" tabindex="0"></button></div></div>
                <div class="setting-item">
                    <div class="setting-label"><span class="setting-name" data-i18n="CardLabelStyle">${i18n.t('CardLabelStyle') || 'Card Labels'}</span><span class="setting-description" data-i18n="CardLabelStyleDescription">${i18n.t('CardLabelStyleDescription') || 'Choose how title and subtitle are displayed under media cards.'}</span></div>
                    <div class="setting-control">${this._drop(
                        'card-label-style-select',
                        [
                            { value: 'default', label: i18n.t('CardLabelStyleDefault') || 'Show Title and Subtitle' },
                            { value: 'titleOnly', label: i18n.t('CardLabelStyleTitleOnly') || 'Show Title Only' },
                            {
                                value: 'titleOnly2Lines',
                                label: i18n.t('CardLabelStyleTitleOnly2Lines') || 'Show Title Only (2 Lines)'
                            },
                            { value: 'hidden', label: i18n.t('CardLabelStyleHidden') || 'Hidden' }
                        ],
                        storage.getItem('pref:cardLabelStyle') || 'default'
                    )}</div>
                </div>

                <div class="setting-item">
                    <div class="setting-label"><span class="setting-name" data-i18n="CardLabelAlign">${i18n.t('CardLabelAlign') || 'Card Label Alignment'}</span><span class="setting-description" data-i18n="CardLabelAlignDescription">${i18n.t('CardLabelAlignDescription') || 'Choose how titles and subtitles are aligned under media cards.'}</span></div>
                    <div class="setting-control">${this._drop(
                        'card-label-align-select',
                        [
                            { value: 'center', label: i18n.t('CardLabelAlignDefault') || 'Center' },
                            { value: 'start', label: i18n.t('CardLabelAlignStart') || 'Align to Start' },
                            { value: 'end', label: i18n.t('CardLabelAlignEnd') || 'Align to End' }
                        ],
                        storage.getItem('pref:cardLabelAlign') || 'start'
                    )}</div>
                </div>

                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="LoopOverflowingText">${i18n.t('LoopOverflowingText') || 'Loop Overflowing Text'}</span><span class="setting-description" data-i18n="LoopOverflowingTextDescription">${i18n.t('LoopOverflowingTextDescription') || 'Loop title and subtitle text horizontally on focus.'}</span></div><div class="setting-control"><button class="toggle-switch ${storage.getItem('pref:loopOverflowingText') !== 'false' ? 'active' : ''}" id="toggle-loop-overflowing-text" data-storage="pref:loopOverflowingText" data-default="true" tabindex="0"></button></div></div>
                <div class="setting-item">
                    <div class="setting-label"><span class="setting-name" data-i18n="BadgeStyle">${i18n.t('BadgeStyle') || 'Badge Style'}</span><span class="setting-description" data-i18n="BadgeStyleDescription">${i18n.t('BadgeStyleDescription') || 'Select the appearance of media poster badges.'}</span></div>
                    <div class="setting-control">${this._drop(
                        'badge-style-select',
                        [
                            { value: 'auto', label: i18n.t('BadgeStyleAuto') || 'Auto (Follow Layout)' },
                            { value: 'tinted', label: i18n.t('BadgeStyleTinted') || 'Accent Tinted' },
                            { value: 'dark', label: i18n.t('BadgeStyleDark') || 'Translucent Dark' }
                        ],
                        layoutManager.getBadgeStyle() || 'auto'
                    )}</div>
                </div>

                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="HideEpisodeCounts">${i18n.t('HideEpisodeCounts') || 'Hide Episode Counts'}</span><span class="setting-description" data-i18n="HideEpisodeCountsDescription">${i18n.t('HideEpisodeCountsDescription') || 'Hide the unplayed episode count badge on series cards.'}</span></div><div class="setting-control"><button class="toggle-switch ${storage.getItem('pref:hideEpisodeCounts') === 'true' ? 'active' : ''}" id="toggle-hide-episode-counts" data-storage="pref:hideEpisodeCounts" tabindex="0"></button></div></div>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="HideProgressBar">${i18n.t('HideProgressBar') || 'Hide Progress Bar'}</span><span class="setting-description" data-i18n="HideProgressBarDescription">${i18n.t('HideProgressBarDescription') || 'Hide playback progress indicators on media cards.'}</span></div><div class="setting-control"><button class="toggle-switch ${storage.getItem('pref:hideProgressBar') === 'true' ? 'active' : ''}" id="toggle-hide-progress-bar" data-storage="pref:hideProgressBar" tabindex="0"></button></div></div>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="ShowMediaSourceCounts">${i18n.t('ShowMediaSourceCounts') || 'Show Version Counts'}</span><span class="setting-description" data-i18n="ShowMediaSourceCountsDescription">${i18n.t('ShowMediaSourceCountsDescription') || 'Display a badge showing the number of available video versions.'}</span></div><div class="setting-control"><button class="toggle-switch ${storage.getItem('pref:showMediaSourceCounts') !== 'false' ? 'active' : ''}" id="toggle-show-media-source-counts" data-storage="pref:showMediaSourceCounts" data-default="true" tabindex="0"></button></div></div>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="ShowQualityBadges">${i18n.t('ShowQualityBadges') || 'Show Quality Badges'}</span><span class="setting-description" data-i18n="ShowQualityBadgesDescription">${i18n.t('ShowQualityBadgesDescription') || 'Display quality badges on media poster cards.'}</span></div><div class="setting-control"><button class="toggle-switch ${storage.getItem('pref:showQualityBadges') === 'true' ? 'active' : ''}" id="toggle-show-quality-badges" data-storage="pref:showQualityBadges" tabindex="0"></button></div></div>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="UseEpisodeBadges">${i18n.t('UseEpisodeBadges') || 'Show Episode Badges'}</span><span class="setting-description" data-i18n="UseEpisodeBadgesDescription">${i18n.t('UseEpisodeBadgesDescription') || 'Display episode SxxExx badge on media cards.'}</span></div><div class="setting-control"><button class="toggle-switch ${storage.getItem('pref:useEpisodeBadges') !== 'false' ? 'active' : ''}" id="toggle-use-episode-badges" data-storage="pref:useEpisodeBadges" data-default="true" tabindex="0"></button></div></div>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="ShowAnimeMarkers">${i18n.t('ShowAnimeMarkers') || 'Show Anime & Audio Badges'}</span><span class="setting-description" data-i18n="ShowAnimeMarkersDescription">${i18n.t('ShowAnimeMarkersDescription') || 'Display episode content badges (Filler, Mixed, Recap) and audio track tags (Subbed, Dubbed, Subbed/Dubbed).'}</span></div><div class="setting-control"><button class="toggle-switch ${storage.getItem('pref:showAnimeMarkers') === 'true' ? 'active' : ''}" id="toggle-show-anime-markers" data-storage="pref:showAnimeMarkers" tabindex="0"></button></div></div>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="UseSeasonBadges">${i18n.t('UseSeasonBadges') || 'Show Season Badges'}</span><span class="setting-description" data-i18n="UseSeasonBadgesDescription">${i18n.t('UseSeasonBadgesDescription') || 'Display season name/number badge on season cards.'}</span></div><div class="setting-control"><button class="toggle-switch ${storage.getItem('pref:useSeasonBadges') === 'true' ? 'active' : ''}" id="toggle-use-season-badges" data-storage="pref:useSeasonBadges" tabindex="0"></button></div></div>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="ShowFavoriteBadges">${i18n.t('ShowFavoriteBadges') || 'Show Favorite Badges'}</span><span class="setting-description" data-i18n="ShowFavoriteBadgesDescription">${i18n.t('ShowFavoriteBadgesDescription') || 'Display a heart badge on favorited media cards.'}</span></div><div class="setting-control"><button class="toggle-switch ${storage.getItem('pref:showFavoriteBadges') === 'true' ? 'active' : ''}" id="toggle-show-favorite-badges" data-storage="pref:showFavoriteBadges" tabindex="0"></button></div></div>

            </div>
        `;
    }

    /**
     * Binds DOM event listeners for the layout tab controls.
     * @param {HTMLElement} root The settings content container
     */
    mount(root) {
        const container = root || this.page?.el || this.page?.element || document;
        if (!container) return;
        this.destroy();

        // Wire generic data-storage toggle switches
        const storageToggles = container.querySelectorAll('.toggle-switch[data-storage]');
        storageToggles.forEach((btn) => {
            this._listen(btn, 'click', () => {
                const storageKey = btn.dataset.storage;
                const defVal = btn.dataset.default === 'true';
                const currentVal = storage.getItem(storageKey);
                const isEnabled = currentVal === null ? defVal : currentVal === 'true';
                const nextVal = !isEnabled;
                storage.setItem(storageKey, String(nextVal));
                storage.flush();
                btn.classList.toggle('active', nextVal);
                log.info(`Layout storage setting changed: ${storageKey} = ${nextVal}`);
            });
        });

        // Wire generic data-setting toggle switches (PlayerSettings)
        const playerToggles = container.querySelectorAll('.toggle-switch[data-setting]');
        playerToggles.forEach((btn) => {
            this._listen(btn, 'click', () => {
                const settingKey = btn.dataset.setting;
                const nextVal = !PlayerSettings.get(settingKey);
                PlayerSettings.set(settingKey, nextVal);
                storage.flush();
                btn.classList.toggle('active', nextVal);
                log.info(`Layout player setting changed: ${settingKey} = ${nextVal}`);
            });
        });
    }

    /**
     * Cleans up all attached event listeners to prevent memory leaks.
     */
    destroy() {
        for (const { element, event, handler } of this._listeners) {
            try {
                element.removeEventListener(event, handler);
            } catch (err) {
                log.warn('Failed to remove listener', err);
            }
        }
        this._listeners = [];
    }
}

export default LayoutTab;
