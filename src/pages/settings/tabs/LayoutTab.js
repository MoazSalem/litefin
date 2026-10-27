/**
 * ============================================================================
 * Litefin Tizen - Layout Tab Controller
 * ============================================================================
 * Manages layout customizations including login page style, media rows modes,
 * movies/series/episodes details layouts, library view modes, card scale,
 * card labels & badges, player OSD alignments, and metadata field visibility.
 * ============================================================================
 */

import { storage } from '../../../utils/StorageService.js';
import { layoutManager } from '../../../ui/LayoutManager.js';
import { PlayerSettings } from '../../../utils/PlayerSettings.js';
import { pluginManager } from '../../../plugins/PluginManager.js';
import { i18n } from '../../../utils/i18n.js';
import { logger } from '../../../utils/Logger.js';
import { watchProviderRegion, watchProviderRegionName } from '../../../utils/WatchProviders.js';

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
    { value: '0.8', label: '80%' }, { value: '0.85', label: '85%' },
    { value: '0.9', label: '90%' }, { value: '0.95', label: '95%' },
    { value: '1', label: 'Normal (100%)' }, { value: '1.05', label: '105%' },
    { value: '1.1', label: '110%' }, { value: '1.15', label: '115%' },
    { value: '1.2', label: '120%' }, { value: '1.25', label: '125%' },
    { value: '1.3', label: '130%' }, { value: '1.35', label: '135%' },
    { value: '1.4', label: '140%' }, { value: '1.45', label: '145%' },
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
     * Computes the active Action Tooltips display mode.
     * @returns {string} 'hidden' | 'cards' | 'floating'
     */
    static getActionTooltipsMode() {
        const pref = storage.getItem('pref:showActionTooltips');
        if (pref === 'hidden' || pref === 'false') return 'hidden';
        if (pref === 'cards') return 'cards';
        return 'floating';
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
            if ((opt.value === '1.2' && !isExpanding && !isClassic) ||
                (opt.value === '1' && (isExpanding || isClassic))) {
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
        const defVal = (isExpanding || isClassic) ? '1' : '1.2';
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
            ? String(savedCols) : String(libColOptions[libColOptions.length - 1]?.value || '7');

        const movieLayout = storage.getItem('pref:detailsLayout') || 'posterLeft';
        const seasonLayout = storage.getItem('pref:seasonEpisodeDetailsLayout') || movieLayout;
        const hideTitleStyle = (movieLayout === 'backdropMinimal' || movieLayout === 'backdropLeft') &&
            (seasonLayout === 'backdropMinimal' || seasonLayout === 'backdropLeft');

        const detailsLayoutOpts = [
            { value: 'posterLeft', label: i18n.t('OptionDetailsLayoutPosterLeft') || 'Poster Left Aligned (Default)' },
            { value: 'posterRight', label: i18n.t('OptionDetailsLayoutPosterRight') || 'Poster Right Aligned' },
            { value: 'backdropMinimal', label: i18n.t('OptionDetailsLayoutBackdropMinimal') || 'Cinematic Backdrop (Centered)' },
            { value: 'backdropLeft', label: i18n.t('OptionDetailsLayoutBackdropLeft') || 'Cinematic Backdrop (Left Aligned)' }
        ];

        const wpRegion = watchProviderRegion(storage.getItem('pref:watchProviderRegion'));

        return `
            <div class="settings-tab-content">
                <h2 class="content-title" data-i18n="Layout">${i18n.t('Layout') || 'Layout'}</h2>
                <p class="content-subtitle" data-i18n="LayoutTabDescription">${i18n.t('LayoutTabDescription') || 'Configure page structures, login and details layouts, and UI component alignments.'}</p>

                <div class="setting-item">
                    <div class="setting-label"><span class="setting-name" data-i18n="MediaRowsLayout">${i18n.t('MediaRowsLayout') || 'Media Rows Layout'}</span><span class="setting-description" data-i18n="MediaRowsLayoutDescription">${i18n.t('MediaRowsLayoutDescription') || 'Choose the layout mode for horizontal media rows.'}</span></div>
                    <div class="setting-control">${this._drop('media-rows-layout-select', [{ value: 'classic', label: i18n.t('LayoutClassic') || 'Classic' }, { value: 'modern', label: i18n.t('LayoutModern') || 'Modern' }, { value: 'expanded', label: i18n.t('LayoutExpandedPosters') || 'Modern Cards' }, { value: 'modern-posters', label: i18n.t('LayoutModernPosters') || 'Modern Posters' }, { value: 'expanding', label: i18n.t('LayoutExpandingPosters') || 'Expanding Posters' }], layoutManager.getMediaRowsLayout() || 'modern')}</div>
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
                    <div class="setting-control">${this._drop('login-page-layout-select', [{ value: 'classic', label: i18n.t('LayoutClassic') || 'Classic' }, { value: 'modern', label: i18n.t('LayoutModernLoginPage') || 'Modern layout' }], layoutManager.getLoginPageLayout() || 'classic')}</div>
                </div>

                <div class="setting-item">
                    <div class="setting-label"><span class="setting-name" data-i18n="OsdLayout">${i18n.t('OsdLayout') || 'OSD Layout'}</span><span class="setting-description" data-i18n="OsdLayoutDescription">${i18n.t('OsdLayoutDescription') || 'Choose the layout alignment of player playback and menu control buttons.'}</span></div>
                    <div class="setting-control">${this._drop('osd-layout-select', [{ value: 'left', label: i18n.t('OsdLayoutLeft') || 'Left Aligned (Default)' }, { value: 'centered', label: i18n.t('OsdLayoutCentered') || 'Centered' }, { value: 'hidden', label: i18n.t('OsdLayoutHidden') || 'Stealth / Anti-Spoiler (Hold Down to Reveal)' }], PlayerSettings.get('osdLayout') || 'left')}</div>
                </div>

                <div class="setting-item">
                    <div class="setting-label"><span class="setting-name" data-i18n="LabelDetailsLayout">${i18n.t('LabelDetailsLayout') || 'Movies & Series Details Layout'}</span><span class="setting-description" data-i18n="MovieDetailsLayoutDescription">${i18n.t('MovieDetailsLayoutDescription') || 'Choose the layout mode for movies and series details pages.'}</span></div>
                    <div class="setting-control">${this._drop('details-layout-select', detailsLayoutOpts, movieLayout)}</div>
                </div>

                <div class="setting-item">
                    <div class="setting-label"><span class="setting-name" data-i18n="LabelSeasonEpisodeDetailsLayout">${i18n.t('LabelSeasonEpisodeDetailsLayout') || 'Seasons & Episodes Details Layout'}</span><span class="setting-description" data-i18n="SeasonEpisodeDetailsLayoutDescription">${i18n.t('SeasonEpisodeDetailsLayoutDescription') || 'Choose the layout mode for season and episode details pages.'}</span></div>
                    <div class="setting-control">${this._drop('season-episode-details-layout-select', detailsLayoutOpts, storage.getItem('pref:seasonEpisodeDetailsLayout') || movieLayout)}</div>
                </div>

                <h3 class="setting-section-title" data-i18n="LibraryLayout">${i18n.t('LibraryLayout') || 'Library View Layout'}</h3>
                <div class="setting-item">
                    <div class="setting-label"><span class="setting-name" data-i18n="LabelDefaultLibraryViewMode">${i18n.t('LabelDefaultLibraryViewMode') || 'Default Library View Mode'}</span><span class="setting-description" data-i18n="DefaultLibraryViewModeDescription">${i18n.t('DefaultLibraryViewModeDescription') || 'Choose the default view layout for libraries.'}</span></div>
                    <div class="setting-control">${this._drop('default-library-view-mode-select', [{ value: 'poster', label: i18n.t('ViewModePoster') || 'Poster' }, { value: 'small-poster', label: i18n.t('ViewModeSmallPoster') || 'Small' }, { value: 'thumb', label: i18n.t('ViewModeThumb') || 'Thumbs' }, { value: 'banner', label: i18n.t('ViewModeBanner') || 'Banner' }, { value: 'list', label: i18n.t('ViewModeList') || 'List' }], curLibMode)}</div>
                </div>

                <div class="setting-item" id="item-default-library-columns" style="${curLibMode === 'list' ? 'display: none;' : ''}">
                    <div class="setting-label"><span class="setting-name" data-i18n="LabelDefaultLibraryColumns">${i18n.t('LabelDefaultLibraryColumns') || 'Default Items Per Row'}</span><span class="setting-description" data-i18n="DefaultLibraryColumnsDescription">${i18n.t('DefaultLibraryColumnsDescription') || 'Choose the default number of items displayed per row for libraries.'}</span></div>
                    <div class="setting-control">${this._drop('default-library-columns-select', libColOptions, activeCols)}</div>
                </div>

                <div class="setting-item">
                    <div class="setting-label"><span class="setting-name" data-i18n="LabelAlphaPickerPosition">${i18n.t('LabelAlphaPickerPosition') || 'Alphabet Selector Position'}</span><span class="setting-description" data-i18n="AlphaPickerPositionDescription">${i18n.t('AlphaPickerPositionDescription') || 'Choose the layout and placement of the alphabet quick-jump selector.'}</span></div>
                    <div class="setting-control">${this._drop('alpha-picker-position-select', [{ value: 'top', label: i18n.t('OptionAlphaPickerTop') || 'Top (Horizontal)' }, { value: 'right', label: i18n.t('OptionAlphaPickerRight') || 'Right Side (Vertical)' }], layoutManager.getAlphaPickerPosition() || 'top')}</div>
                </div>

                <h3 class="setting-section-title" data-i18n="PlayerOSD">${i18n.t('PlayerOSD')}</h3>
                <div class="setting-item">
                    <div class="setting-label"><span class="setting-name" data-i18n="OsdButtonsLocation">${i18n.t('OsdButtonsLocation') || 'OSD Buttons Location'}</span><span class="setting-description" data-i18n="OsdButtonsLocationDescription">${i18n.t('OsdButtonsLocationDescription') || 'Choose the location of playback control buttons relative to the seek bar.'}</span></div>
                    <div class="setting-control">${this._drop('osd-buttons-location-select', [{ value: 'above', label: i18n.t('OsdButtonsAbove') || 'Above Seek Bar' }, { value: 'below', label: i18n.t('OsdButtonsBelow') || 'Below Seek Bar' }], PlayerSettings.get('osdButtonsLocation') || 'above')}</div>
                </div>

                <div class="setting-item">
                    <div class="setting-label"><span class="setting-name" data-i18n="LabelOsdGradientOpacity">${i18n.t('LabelOsdGradientOpacity') || 'OSD Background Gradient Opacity'}</span><span class="setting-description" data-i18n="OsdGradientOpacityDescription">${i18n.t('OsdGradientOpacityDescription') || 'Adjust the opacity of the top and bottom dark gradient overlays.'}</span></div>
                    <div class="setting-control slider-control">${this._slider('osd-gradient-opacity', PlayerSettings.get('osdGradientOpacity') ?? 75, 0, 100, 5)}</div>
                </div>

                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="LabelOsdHideFavorite">${i18n.t('LabelOsdHideFavorite') || 'Hide Favorite Button'}</span><span class="setting-description" data-i18n="OsdHideFavoriteDescription">${i18n.t('OsdHideFavoriteDescription') || 'Hide the favorite heart button from the playback overlay.'}</span></div><div class="setting-control"><button class="toggle-switch ${PlayerSettings.get('osdHideFavorite') === true ? 'active' : ''}" id="toggle-osd-hide-favorite" data-setting="osdHideFavorite" tabindex="0"></button></div></div>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="LabelOsdHideInfo">${i18n.t('LabelOsdHideInfo') || 'Hide Info Button'}</span><span class="setting-description" data-i18n="OsdHideInfoDescription">${i18n.t('OsdHideInfoDescription') || 'Hide the playback details button from the playback overlay.'}</span></div><div class="setting-control"><button class="toggle-switch ${PlayerSettings.get('osdHideInfo') === true ? 'active' : ''}" id="toggle-osd-hide-info" data-setting="osdHideInfo" tabindex="0"></button></div></div>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="LabelOsdHideBackButton">${i18n.t('LabelOsdHideBackButton') || 'Hide Back Button'}</span><span class="setting-description" data-i18n="OsdHideBackButtonDescription">${i18n.t('OsdHideBackButtonDescription') || 'Hide the back arrow button from the player header.'}</span></div><div class="setting-control"><button class="toggle-switch ${PlayerSettings.get('osdHideBackButton') === true ? 'active' : ''}" id="toggle-osd-hide-back-button" data-setting="osdHideBackButton" tabindex="0"></button></div></div>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="LabelOsdCombineSkipButtons">${i18n.t('LabelOsdCombineSkipButtons') || 'Combine Navigation Buttons'}</span><span class="setting-description" data-i18n="OsdCombineSkipButtonsDescription">${i18n.t('OsdCombineSkipButtonsDescription') || 'Combine seek, chapter, and file skip buttons.'}</span></div><div class="setting-control"><button class="toggle-switch ${PlayerSettings.get('osdCombineSkipButtons') === true ? 'active' : ''}" id="toggle-osd-combine-skip-buttons" data-setting="osdCombineSkipButtons" tabindex="0"></button></div></div>

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
                    <div class="setting-control">${this._drop('card-label-style-select', [{ value: 'default', label: i18n.t('CardLabelStyleDefault') || 'Show Title and Subtitle' }, { value: 'titleOnly', label: i18n.t('CardLabelStyleTitleOnly') || 'Show Title Only' }, { value: 'titleOnly2Lines', label: i18n.t('CardLabelStyleTitleOnly2Lines') || 'Show Title Only (2 Lines)' }, { value: 'hidden', label: i18n.t('CardLabelStyleHidden') || 'Hidden' }], storage.getItem('pref:cardLabelStyle') || 'default')}</div>
                </div>

                <div class="setting-item">
                    <div class="setting-label"><span class="setting-name" data-i18n="CardLabelAlign">${i18n.t('CardLabelAlign') || 'Card Label Alignment'}</span><span class="setting-description" data-i18n="CardLabelAlignDescription">${i18n.t('CardLabelAlignDescription') || 'Choose how titles and subtitles are aligned under media cards.'}</span></div>
                    <div class="setting-control">${this._drop('card-label-align-select', [{ value: 'center', label: i18n.t('CardLabelAlignDefault') || 'Center' }, { value: 'start', label: i18n.t('CardLabelAlignStart') || 'Align to Start' }, { value: 'end', label: i18n.t('CardLabelAlignEnd') || 'Align to End' }], storage.getItem('pref:cardLabelAlign') || 'start')}</div>
                </div>

                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="LoopOverflowingText">${i18n.t('LoopOverflowingText') || 'Loop Overflowing Text'}</span><span class="setting-description" data-i18n="LoopOverflowingTextDescription">${i18n.t('LoopOverflowingTextDescription') || 'Loop title and subtitle text horizontally on focus.'}</span></div><div class="setting-control"><button class="toggle-switch ${storage.getItem('pref:loopOverflowingText') !== 'false' ? 'active' : ''}" id="toggle-loop-overflowing-text" data-storage="pref:loopOverflowingText" data-default="true" tabindex="0"></button></div></div>
                <div class="setting-item">
                    <div class="setting-label"><span class="setting-name" data-i18n="BadgeStyle">${i18n.t('BadgeStyle') || 'Badge Style'}</span><span class="setting-description" data-i18n="BadgeStyleDescription">${i18n.t('BadgeStyleDescription') || 'Select the appearance of media poster badges.'}</span></div>
                    <div class="setting-control">${this._drop('badge-style-select', [{ value: 'auto', label: i18n.t('BadgeStyleAuto') || 'Auto (Follow Layout)' }, { value: 'tinted', label: i18n.t('BadgeStyleTinted') || 'Accent Tinted' }, { value: 'dark', label: i18n.t('BadgeStyleDark') || 'Translucent Dark' }], layoutManager.getBadgeStyle() || 'auto')}</div>
                </div>

                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="HideEpisodeCounts">${i18n.t('HideEpisodeCounts') || 'Hide Episode Counts'}</span><span class="setting-description" data-i18n="HideEpisodeCountsDescription">${i18n.t('HideEpisodeCountsDescription') || 'Hide the unplayed episode count badge on series cards.'}</span></div><div class="setting-control"><button class="toggle-switch ${storage.getItem('pref:hideEpisodeCounts') === 'true' ? 'active' : ''}" id="toggle-hide-episode-counts" data-storage="pref:hideEpisodeCounts" tabindex="0"></button></div></div>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="HideProgressBar">${i18n.t('HideProgressBar') || 'Hide Progress Bar'}</span><span class="setting-description" data-i18n="HideProgressBarDescription">${i18n.t('HideProgressBarDescription') || 'Hide playback progress indicators on media cards.'}</span></div><div class="setting-control"><button class="toggle-switch ${storage.getItem('pref:hideProgressBar') === 'true' ? 'active' : ''}" id="toggle-hide-progress-bar" data-storage="pref:hideProgressBar" tabindex="0"></button></div></div>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="ShowMediaSourceCounts">${i18n.t('ShowMediaSourceCounts') || 'Show Version Counts'}</span><span class="setting-description" data-i18n="ShowMediaSourceCountsDescription">${i18n.t('ShowMediaSourceCountsDescription') || 'Display a badge showing the number of available video versions.'}</span></div><div class="setting-control"><button class="toggle-switch ${storage.getItem('pref:showMediaSourceCounts') !== 'false' ? 'active' : ''}" id="toggle-show-media-source-counts" data-storage="pref:showMediaSourceCounts" data-default="true" tabindex="0"></button></div></div>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="ShowQualityBadges">${i18n.t('ShowQualityBadges') || 'Show Quality Badges'}</span><span class="setting-description" data-i18n="ShowQualityBadgesDescription">${i18n.t('ShowQualityBadgesDescription') || 'Display quality badges on media poster cards.'}</span></div><div class="setting-control"><button class="toggle-switch ${storage.getItem('pref:showQualityBadges') === 'true' ? 'active' : ''}" id="toggle-show-quality-badges" data-storage="pref:showQualityBadges" tabindex="0"></button></div></div>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="UseEpisodeBadges">${i18n.t('UseEpisodeBadges') || 'Show Episode Badges'}</span><span class="setting-description" data-i18n="UseEpisodeBadgesDescription">${i18n.t('UseEpisodeBadgesDescription') || 'Display episode SxxExx badge on media cards.'}</span></div><div class="setting-control"><button class="toggle-switch ${storage.getItem('pref:useEpisodeBadges') !== 'false' ? 'active' : ''}" id="toggle-use-episode-badges" data-storage="pref:useEpisodeBadges" data-default="true" tabindex="0"></button></div></div>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="UseSeasonBadges">${i18n.t('UseSeasonBadges') || 'Show Season Badges'}</span><span class="setting-description" data-i18n="UseSeasonBadgesDescription">${i18n.t('UseSeasonBadgesDescription') || 'Display season name/number badge on season cards.'}</span></div><div class="setting-control"><button class="toggle-switch ${storage.getItem('pref:useSeasonBadges') === 'true' ? 'active' : ''}" id="toggle-use-season-badges" data-storage="pref:useSeasonBadges" tabindex="0"></button></div></div>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="ShowFavoriteBadges">${i18n.t('ShowFavoriteBadges') || 'Show Favorite Badges'}</span><span class="setting-description" data-i18n="ShowFavoriteBadgesDescription">${i18n.t('ShowFavoriteBadgesDescription') || 'Display a heart badge on favorited media cards.'}</span></div><div class="setting-control"><button class="toggle-switch ${storage.getItem('pref:showFavoriteBadges') === 'true' ? 'active' : ''}" id="toggle-show-favorite-badges" data-storage="pref:showFavoriteBadges" tabindex="0"></button></div></div>

                <h3 class="setting-section-title" data-i18n="DetailsPage">${i18n.t('DetailsPage') || 'Details Page'}</h3>
                <div class="setting-item">
                    <div class="setting-label"><span class="setting-name" data-i18n="EpisodeLayout">${i18n.t('EpisodeLayout') || 'Episode Layout'}</span><span class="setting-description">Choose the layout mode for TV show episodes on Season details pages.</span></div>
                    <div class="setting-control">${this._drop('episode-layout-select', [{ value: 'grid', label: i18n.t('EpisodeLayoutGrid') || 'Grid' }, { value: 'list', label: i18n.t('EpisodeLayoutList') || 'List with Details' }], storage.getItem('pref:episodeLayout') || 'list')}</div>
                </div>

                <div class="setting-item">
                    <div class="setting-label"><span class="setting-name" data-i18n="LabelScoreVisibility">${i18n.t('LabelScoreVisibility') || 'Score Visibility'}</span><span class="setting-description" data-i18n="ScoreVisibilityDescription">${i18n.t('ScoreVisibilityDescription') || 'Control how community and critic scores are displayed.'}</span></div>
                    <div class="setting-control">${this._drop('score-visibility-select', [{ value: 'all', label: i18n.t('OptionScoreAll') || 'Show All' }, { value: 'mystery', label: i18n.t('OptionScoreMystery') || 'Mystery Mode (Hide All)' }, { value: 'watched', label: i18n.t('OptionScoreWatched') || 'Watched Items Only' }], storage.getItem('pref:scoreVisibility') || 'all')}</div>
                </div>

                <div class="setting-item ${hideTitleStyle ? 'hidden' : ''}" id="details-title-style-container">
                    <div class="setting-label"><span class="setting-name" data-i18n="LabelDetailsTitleStyle">${i18n.t('LabelDetailsTitleStyle') || 'Title and Icon Style'}</span><span class="setting-description" data-i18n="DetailsTitleStyleDescription">${i18n.t('DetailsTitleStyleDescription') || 'Choose how the title and logo/icon are displayed.'}</span></div>
                    <div class="setting-control">${this._drop('details-title-style-select', [{ value: 'both', label: i18n.t('OptionDetailsTitleStyleBoth') || 'Text Title and Icon' }, { value: 'logo-only', label: i18n.t('OptionDetailsTitleStyleLogoOnly') || 'Only Icon as Title (Large)' }, { value: 'text-only', label: i18n.t('OptionDetailsTitleStyleTextOnly') || 'Only Text Title' }], storage.getItem('pref:detailsTitleStyle') || 'both')}</div>
                </div>

                <div class="setting-item">
                    <div class="setting-label"><span class="setting-name" data-i18n="LabelDetailsOverviewMaxLines">${i18n.t('LabelDetailsOverviewMaxLines') || 'Overview Max Lines'}</span><span class="setting-description" data-i18n="DetailsOverviewMaxLinesDescription">${i18n.t('DetailsOverviewMaxLinesDescription') || 'Configure maximum lines for overviews and biographies.'}</span></div>
                    <div class="setting-control">${this._drop('details-overview-max-lines-select', ['2', '3', '4', '5', '6', '7', '8', '10', '12', 'none'].map((v) => ({ value: v, label: v === '6' ? `${i18n.t('ValueLines', [6]) || '6 lines'} (${i18n.t('Default') || 'Default'})` : v === 'none' ? (i18n.t('OptionDetailsOverviewLinesNone') || i18n.t('Unlimited') || 'Unlimited (Full Overview)') : (i18n.t('ValueLines', [Number(v)]) || `${v} lines`) })), storage.getItem('pref:detailsOverviewMaxLines') || '6')}</div>
                </div>

                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="LabelDetailsAlwaysShowSeeMore">${i18n.t('LabelDetailsAlwaysShowSeeMore') || 'Always Show Detailed View Button'}</span><span class="setting-description" data-i18n="DetailsAlwaysShowSeeMoreDescription">${i18n.t('DetailsAlwaysShowSeeMoreDescription') || 'Always display Detailed View button even if description fits.'}</span></div><div class="setting-control"><button class="toggle-switch ${storage.getItem('pref:detailsAlwaysShowSeeMore') === 'true' ? 'active' : ''}" id="toggle-details-always-show-see-more" data-storage="pref:detailsAlwaysShowSeeMore" tabindex="0"></button></div></div>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="LabelHideGhostMode">${i18n.t('LabelHideGhostMode') || 'Hide Ghost Mode Button'}</span><span class="setting-description" data-i18n="HideGhostModeDescription">${i18n.t('HideGhostModeDescription') || 'Hide the ghost mode button on details page.'}</span></div><div class="setting-control"><button class="toggle-switch ${storage.getItem('pref:hideGhostMode') === 'true' ? 'active' : ''}" id="toggle-hide-ghost-mode" data-storage="pref:hideGhostMode" tabindex="0"></button></div></div>
                <div class="setting-item">
                    <div class="setting-label"><span class="setting-name" data-i18n="ShowActionTooltips">${i18n.t('ShowActionTooltips') || 'Show Button Names Tooltip'}</span><span class="setting-description" data-i18n="ShowActionTooltipsDescription">${i18n.t('ShowActionTooltipsDescription') || 'Display label under focused action buttons.'}</span></div>
                    <div class="setting-control">${this._drop('show-action-tooltips-select', [{ value: 'hidden', label: i18n.t('OptionActionTooltipsHidden') || 'Hidden' }, { value: 'floating', label: `${i18n.t('OptionActionTooltipsFloating') || 'Floating Text'} (${i18n.t('Default') || 'Default'})` }, { value: 'cards', label: i18n.t('OptionActionTooltipsCards') || 'Name Cards' }], LayoutTab.getActionTooltipsMode())}</div>
                </div>

                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="LabelHideOriginalTitle">${i18n.t('LabelHideOriginalTitle') || 'Hide Original Language Title'}</span><span class="setting-description" data-i18n="HideOriginalTitleDescription">${i18n.t('HideOriginalTitleDescription') || 'Do not show original language title on details page.'}</span></div><div class="setting-control"><button class="toggle-switch ${storage.getItem('pref:hideOriginalTitle') === 'true' ? 'active' : ''}" id="toggle-hide-original-title" data-storage="pref:hideOriginalTitle" tabindex="0"></button></div></div>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="LabelSecondaryTitleSecondaryColor">${i18n.t('LabelSecondaryTitleSecondaryColor') || 'Use Secondary Color for Episode Info'}</span><span class="setting-description" data-i18n="SecondaryTitleSecondaryColorDescription">${i18n.t('SecondaryTitleSecondaryColorDescription') || 'Use secondary text color for episode info.'}</span></div><div class="setting-control"><button class="toggle-switch ${storage.getItem('pref:secondaryTitleSecondaryColor') !== 'false' ? 'active' : ''}" id="toggle-secondary-title-color" data-storage="pref:secondaryTitleSecondaryColor" data-default="true" tabindex="0"></button></div></div>
                <div class="setting-item" id="mdb-awards-item" style="display: ${pluginManager.isEnabled('mdblist-ratings') ? '' : 'none'}"><div class="setting-label"><span class="setting-name" data-i18n="ShowMdbAwards">${i18n.t('ShowMdbAwards') || 'Show Awards Badges'}</span><span class="setting-description" data-i18n="ShowMdbAwardsDescription">${i18n.t('ShowMdbAwardsDescription') || 'Display award badges from MDBList.'}</span></div><div class="setting-control"><button class="toggle-switch ${storage.getItem('pref:showMdbAwards') !== 'false' ? 'active' : ''}" id="toggle-mdb-awards" data-storage="pref:showMdbAwards" data-default="true" tabindex="0"></button></div></div>
                <div class="setting-item">
                    <div class="setting-label"><span class="setting-name" data-i18n="LabelShowDates">${i18n.t('LabelShowDates') || 'Show Dates'}</span><span class="setting-description" data-i18n="ShowDatesDescription">${i18n.t('ShowDatesDescription') || 'Display added or premiere date on details page.'}</span></div>
                    <div class="setting-control">${this._drop('show-dates-select', [{ value: 'none', label: i18n.t('OptionDatesNone') || 'Hide All' }, { value: 'both', label: i18n.t('OptionDatesBoth') || 'Show Both (Added & Aired)' }, { value: 'added', label: i18n.t('OptionDatesAddedOnly') || 'Show Added Date Only' }, { value: 'aired', label: i18n.t('OptionDatesAiredOnly') || 'Show Aired Date Only' }], storage.getItem('pref:showDates') || 'none')}</div>
                </div>

                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="LabelShowDatesIncludeYear">${i18n.t('LabelShowDatesIncludeYear') || 'Include Year in Dates'}</span><span class="setting-description" data-i18n="ShowDatesIncludeYearDescription">${i18n.t('ShowDatesIncludeYearDescription') || 'Include calendar year when displaying dates.'}</span></div><div class="setting-control"><button class="toggle-switch ${storage.getItem('pref:showDatesIncludeYear') === 'true' ? 'active' : ''}" id="toggle-show-dates-include-year" data-storage="pref:showDatesIncludeYear" tabindex="0"></button></div></div>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="LabelShowTechnicalDetails">${i18n.t('LabelShowTechnicalDetails') || 'Show Technical Details'}</span><span class="setting-description" data-i18n="ShowTechnicalDetailsDescription">${i18n.t('ShowTechnicalDetailsDescription') || 'Display specs (resolution, codec, audio) on details page.'}</span></div><div class="setting-control"><button class="toggle-switch ${storage.getItem('pref:showTechnicalDetails') !== 'false' ? 'active' : ''}" id="toggle-show-technical-details" data-storage="pref:showTechnicalDetails" data-default="true" tabindex="0"></button></div></div>
                <div class="setting-item">
                    <div class="setting-label"><span class="setting-name" data-i18n="LabelRichMetadataStyle">${i18n.t('LabelRichMetadataStyle') || 'Rich Metadata Display'}</span><span class="setting-description" data-i18n="RichMetadataStyleDescription">${i18n.t('RichMetadataStyleDescription') || 'Customize which metadata fields are shown.'}</span></div>
                    <div class="setting-control">${this._drop('rich-metadata-select', [{ value: 'all', label: i18n.t('OptionRichMetadataAll') || 'Show Full Rich Metadata' }, { value: 'genres-studios-writers', label: i18n.t('OptionRichMetadataHideTagsOnly') || 'Hide Tags Only' }, { value: 'genres-writers', label: i18n.t('OptionRichMetadataHideTagsAndStudios') || 'Hide Tags and Studios' }, { value: 'genres-only', label: i18n.t('OptionRichMetadataShowGenresOnly') || 'Show Genres Only' }, { value: 'none', label: i18n.t('OptionRichMetadataNone') || 'Hide All' }], storage.getItem('pref:richMetadataStyle') || 'genres-studios-writers')}</div>
                </div>

                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="IncludeCurrentEpisodeInMoreFromSeason">${i18n.t('IncludeCurrentEpisodeInMoreFromSeason') || 'Include Current Episode in More From Season'}</span><span class="setting-description" data-i18n="IncludeCurrentEpisodeInMoreFromSeasonDescription">${i18n.t('IncludeCurrentEpisodeInMoreFromSeasonDescription') || 'Include currently opened episode in More from Season row.'}</span></div><div class="setting-control"><button class="toggle-switch ${storage.getItem('pref:includeCurrentEpisodeInMoreFromSeason') === 'true' ? 'active' : ''}" id="toggle-include-current-episode" data-storage="pref:includeCurrentEpisodeInMoreFromSeason" tabindex="0"></button></div></div>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="LabelHideNextUpSection">${i18n.t('LabelHideNextUpSection') || 'Hide Next Up'}</span><span class="setting-description" data-i18n="HideNextUpSectionDescription">${i18n.t('HideNextUpSectionDescription') || 'Do not display Next Up row on details page.'}</span></div><div class="setting-control"><button class="toggle-switch ${storage.getItem('pref:hideNextUpSection') === 'true' ? 'active' : ''}" id="toggle-hide-next-up-section" data-storage="pref:hideNextUpSection" tabindex="0"></button></div></div>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="LabelHideCastSection">${i18n.t('LabelHideCastSection') || 'Hide Cast & Guest Stars'}</span><span class="setting-description" data-i18n="HideCastSectionDescription">${i18n.t('HideCastSectionDescription') || 'Hide actors and guest stars on details page.'}</span></div><div class="setting-control"><button class="toggle-switch ${storage.getItem('pref:hideCastSection') === 'true' ? 'active' : ''}" id="toggle-hide-cast-section" data-storage="pref:hideCastSection" tabindex="0"></button></div></div>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="LabelHideSimilarSection">${i18n.t('LabelHideSimilarSection') || 'Hide More Like This'}</span><span class="setting-description" data-i18n="HideSimilarSectionDescription">${i18n.t('HideSimilarSectionDescription') || 'Do not display recommendations on details page.'}</span></div><div class="setting-control"><button class="toggle-switch ${storage.getItem('pref:hideSimilarSection') === 'true' ? 'active' : ''}" id="toggle-hide-similar-section" data-storage="pref:hideSimilarSection" tabindex="0"></button></div></div>
                <div class="setting-item"><div class="setting-label"><span class="setting-name">${i18n.t('ShowWatchProviders')}</span><span class="setting-description">${i18n.t('ShowWatchProvidersDescription')}</span></div><div class="setting-control"><button class="toggle-switch ${storage.getItem('pref:showWatchProviders') === 'true' ? 'active' : ''}" id="toggle-show-watch-providers" data-storage="pref:showWatchProviders" tabindex="0" role="switch"></button></div></div>

                <h3 class="setting-section-title" data-i18n="Seerr">${i18n.t('Seerr') || 'Seerr'}</h3>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="SeerrRecommendations">${i18n.t('SeerrRecommendations') || 'Seerr Recommendations'}</span><span class="setting-description" data-i18n="SeerrRecommendationsDescription">${i18n.t('SeerrRecommendationsDescription') || 'Show recommendations from Seerr on details pages.'}</span></div><div class="setting-control"><button class="toggle-switch ${storage.getItem('pref:SeerrRecommendations') !== 'false' ? 'active' : ''}" id="toggle-show-seerr-recommendations" data-storage="pref:SeerrRecommendations" data-default="true" tabindex="0" role="switch"></button></div></div>
                <div class="setting-item"><div class="setting-label"><span class="setting-name">${i18n.t('WatchProvidersRegion')}</span><span class="setting-description">${i18n.t('WatchProvidersRegionDescription')}</span></div><div class="setting-control">${this._drop('watch-provider-region-select', [{ value: wpRegion, label: watchProviderRegionName(wpRegion, i18n.currentLang) }], wpRegion)}</div></div>
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
     * Updates visibility of details page title style option based on layouts.
     */
    updateDetailsTitleStyleVisibility() {
        if (this.page && typeof this.page._updateDetailsTitleStyleVisibility === 'function') {
            this.page._updateDetailsTitleStyleVisibility();
        }
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
