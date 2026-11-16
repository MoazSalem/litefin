/**
 * ============================================================================
 * Litefin Tizen - Details Tab Controller
 * ============================================================================
 * Consolidates details page preferences previously split across the Layout tab:
 * 1. Movies, series, seasons, and episode layout modes
 * 2. Title styling, score visibility, and overview presentation
 * 3. Metadata density (dates, technical specs, rich metadata)
 * 4. Section visibility toggles (Next Up, Cast, Similar) and Seerr extras
 * ============================================================================
 */

import { i18n } from '../../../utils/i18n.js';
import { storage } from '../../../utils/StorageService.js';
import { pluginManager } from '../../../plugins/PluginManager.js';
import { watchProviderRegion, watchProviderRegionName } from '../../../utils/WatchProviders.js';
import { logger } from '../../../utils/Logger.js';

const log = logger.create('DetailsTab');

/**
 * Controller managing details page layout and content settings.
 */
export class DetailsTab {
    /**
     * Initializes a new instance of DetailsTab.
     * @param {Object} page Host SettingsPage controller
     */
    constructor(page) {
        this.page = page;
        this._listeners = [];
    }

    /**
     * Helper to render standardized setting item container.
     * @private
     */
    _item(title, desc, controlHtml, opt = {}) {
        const idStr = opt.id ? ` id="${opt.id}"` : '';
        const styleStr = opt.style ? ` style="${opt.style}"` : '';
        const clsStr = opt.cls ? ` ${opt.cls}` : '';
        return `
            <div class="setting-item${clsStr}"${idStr}${styleStr}>
                <div class="setting-label">
                    <span class="setting-name">${title}</span>
                    <span class="setting-description">${desc}</span>
                </div>
                <div class="setting-control">${controlHtml}</div>
            </div>`;
    }

    /** Helper to render dropdown controls via host page. @private */
    _drop(id, options, currentVal, disabled = false) {
        return this.page ? this.page._renderDropdown(id, options, currentVal, disabled) : '';
    }

    /** Track and attach event listener on target element. @private */
    _listen(el, event, handler) {
        if (!el) return;
        el.addEventListener(event, handler);
        this._listeners.push({ element: el, event, handler });
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
     * Renders the complete HTML markup for the Details tab.
     * @returns {string} Serialized HTML template
     */
    render() {
        const movieLayout = storage.getItem('pref:detailsLayout') || 'posterLeft';
        const seasonLayout = storage.getItem('pref:seasonEpisodeDetailsLayout') || movieLayout;
        const hideTitleStyle =
            (movieLayout === 'backdropMinimal' || movieLayout === 'backdropLeft') &&
            (seasonLayout === 'backdropMinimal' || seasonLayout === 'backdropLeft');

        const detailsLayoutOpts = [
            { value: 'posterLeft', label: i18n.t('OptionDetailsLayoutPosterLeft') || 'Poster Left Aligned (Default)' },
            { value: 'posterRight', label: i18n.t('OptionDetailsLayoutPosterRight') || 'Poster Right Aligned' },
            {
                value: 'backdropMinimal',
                label: i18n.t('OptionDetailsLayoutBackdropMinimal') || 'Cinematic Backdrop (Centered)'
            },
            {
                value: 'backdropLeft',
                label: i18n.t('OptionDetailsLayoutBackdropLeft') || 'Cinematic Backdrop (Left Aligned)'
            }
        ];

        const wpRegion = watchProviderRegion(storage.getItem('pref:watchProviderRegion'));

        return `
            <div class="settings-tab-content">
                <h2 class="content-title" data-i18n="DetailsPage">${i18n.t('DetailsPage') || 'Details Page'}</h2>
                <p class="content-subtitle" data-i18n="SettingsDescDetails">${i18n.t('SettingsDescDetails') || 'Configure movie, series, and episode details page layouts and content.'}</p>

                <div class="setting-item">
                    <div class="setting-label"><span class="setting-name" data-i18n="LabelDetailsLayout">${i18n.t('LabelDetailsLayout') || 'Movies & Series Details Layout'}</span><span class="setting-description" data-i18n="MovieDetailsLayoutDescription">${i18n.t('MovieDetailsLayoutDescription') || 'Choose the layout mode for movies and series details pages.'}</span></div>
                    <div class="setting-control">${this._drop('details-layout-select', detailsLayoutOpts, movieLayout)}</div>
                </div>

                <div class="setting-item">
                    <div class="setting-label"><span class="setting-name" data-i18n="LabelSeasonEpisodeDetailsLayout">${i18n.t('LabelSeasonEpisodeDetailsLayout') || 'Seasons & Episodes Details Layout'}</span><span class="setting-description" data-i18n="SeasonEpisodeDetailsLayoutDescription">${i18n.t('SeasonEpisodeDetailsLayoutDescription') || 'Choose the layout mode for season and episode details pages.'}</span></div>
                    <div class="setting-control">${this._drop('season-episode-details-layout-select', detailsLayoutOpts, storage.getItem('pref:seasonEpisodeDetailsLayout') || movieLayout)}</div>
                </div>

                <div class="setting-item">
                    <div class="setting-label"><span class="setting-name" data-i18n="EpisodeLayout">${i18n.t('EpisodeLayout') || 'Episode Layout'}</span><span class="setting-description">Choose the layout mode for TV show episodes on Season details pages.</span></div>
                    <div class="setting-control">${this._drop(
                        'episode-layout-select',
                        [
                            { value: 'grid', label: i18n.t('EpisodeLayoutGrid') || 'Grid' },
                            { value: 'list', label: i18n.t('EpisodeLayoutList') || 'List with Details' }
                        ],
                        storage.getItem('pref:episodeLayout') || 'list'
                    )}</div>
                </div>

                <div class="setting-item">
                    <div class="setting-label"><span class="setting-name" data-i18n="LabelScoreVisibility">${i18n.t('LabelScoreVisibility') || 'Score Visibility'}</span><span class="setting-description" data-i18n="ScoreVisibilityDescription">${i18n.t('ScoreVisibilityDescription') || 'Control how community and critic scores are displayed.'}</span></div>
                    <div class="setting-control">${this._drop(
                        'score-visibility-select',
                        [
                            { value: 'all', label: i18n.t('OptionScoreAll') || 'Show All' },
                            { value: 'mystery', label: i18n.t('OptionScoreMystery') || 'Mystery Mode (Hide All)' },
                            { value: 'watched', label: i18n.t('OptionScoreWatched') || 'Watched Items Only' }
                        ],
                        storage.getItem('pref:scoreVisibility') || 'all'
                    )}</div>
                </div>

                <div class="setting-item ${hideTitleStyle ? 'hidden' : ''}" id="details-title-style-container">
                    <div class="setting-label"><span class="setting-name" data-i18n="LabelDetailsTitleStyle">${i18n.t('LabelDetailsTitleStyle') || 'Title and Icon Style'}</span><span class="setting-description" data-i18n="DetailsTitleStyleDescription">${i18n.t('DetailsTitleStyleDescription') || 'Choose how the title and logo/icon are displayed.'}</span></div>
                    <div class="setting-control">${this._drop(
                        'details-title-style-select',
                        [
                            { value: 'both', label: i18n.t('OptionDetailsTitleStyleBoth') || 'Text Title and Icon' },
                            {
                                value: 'logo-only',
                                label: i18n.t('OptionDetailsTitleStyleLogoOnly') || 'Only Icon as Title (Large)'
                            },
                            {
                                value: 'text-only',
                                label: i18n.t('OptionDetailsTitleStyleTextOnly') || 'Only Text Title'
                            }
                        ],
                        storage.getItem('pref:detailsTitleStyle') || 'both'
                    )}</div>
                </div>

                <div class="setting-item">
                    <div class="setting-label"><span class="setting-name" data-i18n="LabelDetailsOverviewMaxLines">${i18n.t('LabelDetailsOverviewMaxLines') || 'Overview Max Lines'}</span><span class="setting-description" data-i18n="DetailsOverviewMaxLinesDescription">${i18n.t('DetailsOverviewMaxLinesDescription') || 'Configure maximum lines for overviews and biographies.'}</span></div>
                    <div class="setting-control">${this._drop(
                        'details-overview-max-lines-select',
                        ['2', '3', '4', '5', '6', '7', '8', '10', '12', 'none'].map((v) => ({
                            value: v,
                            label:
                                v === '6'
                                    ? `${i18n.t('ValueLines', [6]) || '6 lines'} (${i18n.t('Default') || 'Default'})`
                                    : v === 'none'
                                      ? i18n.t('OptionDetailsOverviewLinesNone') ||
                                        i18n.t('Unlimited') ||
                                        'Unlimited (Full Overview)'
                                      : i18n.t('ValueLines', [Number(v)]) || `${v} lines`
                        })),
                        storage.getItem('pref:detailsOverviewMaxLines') || '6'
                    )}</div>
                </div>

                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="LabelDetailsAlwaysShowSeeMore">${i18n.t('LabelDetailsAlwaysShowSeeMore') || 'Always Show Detailed View Button'}</span><span class="setting-description" data-i18n="DetailsAlwaysShowSeeMoreDescription">${i18n.t('DetailsAlwaysShowSeeMoreDescription') || 'Always display Detailed View button even if description fits.'}</span></div><div class="setting-control"><button class="toggle-switch ${storage.getItem('pref:detailsAlwaysShowSeeMore') === 'true' ? 'active' : ''}" id="toggle-details-always-show-see-more" data-storage="pref:detailsAlwaysShowSeeMore" tabindex="0"></button></div></div>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="LabelHideGhostMode">${i18n.t('LabelHideGhostMode') || 'Hide Ghost Mode Button'}</span><span class="setting-description" data-i18n="HideGhostModeDescription">${i18n.t('HideGhostModeDescription') || 'Hide the ghost mode button on details page.'}</span></div><div class="setting-control"><button class="toggle-switch ${storage.getItem('pref:hideGhostMode') === 'true' ? 'active' : ''}" id="toggle-hide-ghost-mode" data-storage="pref:hideGhostMode" tabindex="0"></button></div></div>
                <div class="setting-item">
                    <div class="setting-label"><span class="setting-name" data-i18n="ShowActionTooltips">${i18n.t('ShowActionTooltips') || 'Show Button Names Tooltip'}</span><span class="setting-description" data-i18n="ShowActionTooltipsDescription">${i18n.t('ShowActionTooltipsDescription') || 'Display label under focused action buttons.'}</span></div>
                    <div class="setting-control">${this._drop(
                        'show-action-tooltips-select',
                        [
                            { value: 'hidden', label: i18n.t('OptionActionTooltipsHidden') || 'Hidden' },
                            {
                                value: 'floating',
                                label: `${i18n.t('OptionActionTooltipsFloating') || 'Floating Text'} (${i18n.t('Default') || 'Default'})`
                            },
                            { value: 'cards', label: i18n.t('OptionActionTooltipsCards') || 'Name Cards' }
                        ],
                        DetailsTab.getActionTooltipsMode()
                    )}</div>
                </div>

                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="LabelHideOriginalTitle">${i18n.t('LabelHideOriginalTitle') || 'Hide Original Language Title'}</span><span class="setting-description" data-i18n="HideOriginalTitleDescription">${i18n.t('HideOriginalTitleDescription') || 'Do not show original language title on details page.'}</span></div><div class="setting-control"><button class="toggle-switch ${storage.getItem('pref:hideOriginalTitle') === 'true' ? 'active' : ''}" id="toggle-hide-original-title" data-storage="pref:hideOriginalTitle" tabindex="0"></button></div></div>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="LabelSecondaryTitleSecondaryColor">${i18n.t('LabelSecondaryTitleSecondaryColor') || 'Use Secondary Color for Episode Info'}</span><span class="setting-description" data-i18n="SecondaryTitleSecondaryColorDescription">${i18n.t('SecondaryTitleSecondaryColorDescription') || 'Use secondary text color for episode info.'}</span></div><div class="setting-control"><button class="toggle-switch ${storage.getItem('pref:secondaryTitleSecondaryColor') !== 'false' ? 'active' : ''}" id="toggle-secondary-title-color" data-storage="pref:secondaryTitleSecondaryColor" data-default="true" tabindex="0"></button></div></div>
                <div class="setting-item" id="mdb-awards-item" style="display: ${pluginManager.isEnabled('mdblist-ratings') ? '' : 'none'}"><div class="setting-label"><span class="setting-name" data-i18n="ShowMdbAwards">${i18n.t('ShowMdbAwards') || 'Show Awards Badges'}</span><span class="setting-description" data-i18n="ShowMdbAwardsDescription">${i18n.t('ShowMdbAwardsDescription') || 'Display award badges from MDBList.'}</span></div><div class="setting-control"><button class="toggle-switch ${storage.getItem('pref:showMdbAwards') !== 'false' ? 'active' : ''}" id="toggle-mdb-awards" data-storage="pref:showMdbAwards" data-default="true" tabindex="0"></button></div></div>
                <div class="setting-item">
                    <div class="setting-label"><span class="setting-name" data-i18n="LabelShowDates">${i18n.t('LabelShowDates') || 'Show Dates'}</span><span class="setting-description" data-i18n="ShowDatesDescription">${i18n.t('ShowDatesDescription') || 'Display added or premiere date on details page.'}</span></div>
                    <div class="setting-control">${this._drop(
                        'show-dates-select',
                        [
                            { value: 'none', label: i18n.t('OptionDatesNone') || 'Hide All' },
                            { value: 'both', label: i18n.t('OptionDatesBoth') || 'Show Both (Added & Aired)' },
                            { value: 'added', label: i18n.t('OptionDatesAddedOnly') || 'Show Added Date Only' },
                            { value: 'aired', label: i18n.t('OptionDatesAiredOnly') || 'Show Aired Date Only' }
                        ],
                        storage.getItem('pref:showDates') || 'none'
                    )}</div>
                </div>

                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="LabelShowDatesIncludeYear">${i18n.t('LabelShowDatesIncludeYear') || 'Include Year in Dates'}</span><span class="setting-description" data-i18n="ShowDatesIncludeYearDescription">${i18n.t('ShowDatesIncludeYearDescription') || 'Include calendar year when displaying dates.'}</span></div><div class="setting-control"><button class="toggle-switch ${storage.getItem('pref:showDatesIncludeYear') === 'true' ? 'active' : ''}" id="toggle-show-dates-include-year" data-storage="pref:showDatesIncludeYear" tabindex="0"></button></div></div>
                <div class="setting-item"><div class="setting-label"><span class="setting-name" data-i18n="LabelShowTechnicalDetails">${i18n.t('LabelShowTechnicalDetails') || 'Show Technical Details'}</span><span class="setting-description" data-i18n="ShowTechnicalDetailsDescription">${i18n.t('ShowTechnicalDetailsDescription') || 'Display specs (resolution, codec, audio) on details page.'}</span></div><div class="setting-control"><button class="toggle-switch ${storage.getItem('pref:showTechnicalDetails') !== 'false' ? 'active' : ''}" id="toggle-show-technical-details" data-storage="pref:showTechnicalDetails" data-default="true" tabindex="0"></button></div></div>
                <div class="setting-item">
                    <div class="setting-label"><span class="setting-name" data-i18n="LabelRichMetadataStyle">${i18n.t('LabelRichMetadataStyle') || 'Rich Metadata Display'}</span><span class="setting-description" data-i18n="RichMetadataStyleDescription">${i18n.t('RichMetadataStyleDescription') || 'Customize which metadata fields are shown.'}</span></div>
                    <div class="setting-control">${this._drop(
                        'rich-metadata-select',
                        [
                            { value: 'all', label: i18n.t('OptionRichMetadataAll') || 'Show Full Rich Metadata' },
                            {
                                value: 'genres-studios-writers',
                                label: i18n.t('OptionRichMetadataHideTagsOnly') || 'Hide Tags Only'
                            },
                            {
                                value: 'genres-writers',
                                label: i18n.t('OptionRichMetadataHideTagsAndStudios') || 'Hide Tags and Studios'
                            },
                            {
                                value: 'genres-only',
                                label: i18n.t('OptionRichMetadataShowGenresOnly') || 'Show Genres Only'
                            },
                            { value: 'none', label: i18n.t('OptionRichMetadataNone') || 'Hide All' }
                        ],
                        storage.getItem('pref:richMetadataStyle') || 'genres-studios-writers'
                    )}</div>
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
     * Binds DOM event listeners for the details tab controls.
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
                log.info(`Details storage setting changed: ${storageKey} = ${nextVal}`);
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

export default DetailsTab;
