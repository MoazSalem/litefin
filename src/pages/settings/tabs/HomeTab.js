/**
 * ============================================================================
 * Litefin Tizen - Home Tab Controller
 * ============================================================================
 * Manages Home Screen settings, featured Hero Carousel controls, custom
 * collection and trending row integration, library card thumbnail modes,
 * row item limits, and live section reordering and visibility toggles.
 * ============================================================================
 */

import { storage } from '../../../utils/StorageService.js';
import { i18n } from '../../../utils/i18n.js';
import { api } from '../../../api/index.js';
import { focusManager } from '../../../ui/FocusManager.js';
import { homeLayoutManager } from '../../../utils/HomeLayoutManager.js';
import { layoutManager } from '../../../ui/LayoutManager.js';
import { pluginManager } from '../../../plugins/PluginManager.js';
import { router } from '../../../core/Router.js';
import { state } from '../../../core/StateManager.js';
import { logger } from '../../../utils/Logger.js';
import { UP_SVG, DOWN_SVG, EYE_OFF, EYE_ON } from '../../../utils/Icons.js';
import { CustomCollectionsModal, getCustomCollectionsLabel } from '../modals/CustomCollectionsModal.js';

const log = logger.create('HomeTab');

/**
 * Controller class governing home tab rendering, layout ordering, and event bindings.
 */
export class HomeTab {
    constructor(page) {
        this.page = page;
        this.customCollectionsModal = new CustomCollectionsModal(page);
        this._listeners = [];
    }

    _drop(id, options, current) {
        return (this.page && typeof this.page._renderDropdown === 'function') ? this.page._renderDropdown(id, options, current) : '';
    }

    _item(name, desc, control, id = '', show = true) {
        const idAttr = id ? ` id="${id}"` : '';
        const styleAttr = show ? '' : ' style="display: none;"';
        return `<div class="setting-item"${idAttr}${styleAttr}><div class="setting-label"><span class="setting-name">${name}</span><span class="setting-description">${desc}</span></div><div class="setting-control">${control}</div></div>`;
    }

    _toggle(id, active) {
        return `<button class="toggle-switch ${active ? 'active' : ''}" id="${id}" tabindex="0"></button>`;
    }

    getCustomCollectionsLabel() {
        return getCustomCollectionsLabel();
    }

    async showCustomCollectionsModal() {
        await this.customCollectionsModal.show(() => this.setupHomeLayoutUI());
    }

    render() {
        const enableRows = storage.getItem('pref:enableCollectionRows') === 'true';
        const heroEnabled = storage.getItem('pref:heroCarousel') !== 'false';
        const heroStyle = storage.getItem('pref:heroCarouselStyle') || 'immersive-performance';
        const indicatorStyle = storage.getItem('pref:heroCarouselIndicatorStyle') || 'dots';
        const thumbMode = storage.getItem('pref:libraryThumbMode') || 'off';

        const rowsOpts = [8, 10, 12, 15, 20, 25, 30, 50, 100, 200].map((v) => ({
            value: v,
            label: (i18n.t('ItemCountValue', [v]) || `${v} items`) + (v === 12 ? ` (${i18n.t('Default') || 'Default'})` : '')
        }));

        const buildTrending = (colKey, nameKey) => {
            const val = storage.getItem(colKey) || 'none';
            const name = storage.getItem(nameKey);
            const opts = [{ value: 'none', label: i18n.t('Disabled') }, { value: 'auto', label: i18n.t('Auto') }, { value: 'top-rated', label: i18n.t('CommunityRating') }];
            if (val && val !== 'none' && val !== 'auto' && val !== 'top-rated') opts.push({ value: val, label: name || val });
            return { opts, val };
        };
        const mTrend = buildTrending('pref:trendingMoviesCollection', 'pref:trendingMoviesCollectionName');
        const sTrend = buildTrending('pref:trendingSeriesCollection', 'pref:trendingSeriesCollectionName');

        const daysOpts = [0, 1, 2, 3, 4, 5, 6, 7, 14, 21, 28, 30, 60, 90, 180, 365].map((v) => ({
            value: v,
            label: v === 0 ? i18n.t('Unlimited') : (v >= 365 ? i18n.t('YearValue', [1]) : (v >= 60 ? i18n.t('MonthsValue', [Math.round(v / 30)]) : i18n.t('DaysValue', [v])))
        }));

        const heroStyles = [
            { value: 'banner', label: i18n.t('StyleBanner') || 'Banner' },
            { value: 'semi-immersive', label: i18n.t('StyleSemiImmersive') || 'Semi-Immersive' },
            { value: 'immersive', label: i18n.t('StyleImmersive') || 'Immersive' },
            { value: 'immersive-performance', label: i18n.t('StyleImmersivePerformance') || 'Immersive (Performance)' }
        ];

        const heroQualities = ['default', 'low', 'medium-low', 'medium', 'medium-high', 'high', 'very-high', 'ultra', 'original'].map((q) => ({
            value: q,
            label: i18n.t(q.charAt(0).toUpperCase() + q.slice(1).replace('-', '')) || q
        }));

        const intervals = [2, 4, 5, 8, 10, 15, 20, 25, 30, 40, 60].map((s) => ({
            value: (s * 1000).toString(),
            label: i18n.t('Seconds', [s]) || `${s} seconds`
        }));

        const vignettes = [{ value: 'transparent', label: i18n.t('Transparent') || 'Transparent (0%)' }, ...[10, 20, 30, 40, 50, 60, 70, 80, 90].map((p) => ({
            value: p.toString(),
            label: p === 70 ? `70% (${i18n.t('Default') || 'Default'})` : `${p}%`
        }))];

        const customColsBtn = `<button class="setting-action-btn select-btn" id="btn-manage-custom-collections" tabindex="0" data-focusable="true"><span class="btn-label" id="custom-collections-count-label">${this.getCustomCollectionsLabel()}</span></button>`;
        const regenBtn = `<button class="btn btn-option" id="btn-regenerate-thumbs" tabindex="0" style="width: auto; min-width: 120px;" data-i18n="Regenerate">${i18n.t('Regenerate') || 'Regenerate'}</button>`;

        return `
            <div class="settings-tab-content">
                <h2 class="content-title" data-i18n="Home">${i18n.t('Home') || 'Home'}</h2>
                <p class="content-subtitle" data-i18n="HomeTabDescription">${i18n.t('HomeTabDescription') || 'Manage home screen sections, featured hero carousel, and content row limits.'}</p>

                ${this._item(i18n.t('LabelHomeRowsLimit') || 'Home Rows Limit', i18n.t('HomeRowsLimitDescription') || 'Maximum items per row.', this._drop('home-rows-limit-select', rowsOpts, parseInt(storage.getItem('pref:homeRowsLimit') || 12, 10)))}
                ${this._item(i18n.t('LabelMergeResumeNextUp'), i18n.t('LabelMergeResumeNextUpDescription'), this._toggle('toggle-merge-resume-nextup', storage.getItem('pref:mergeResumeNextUp') === 'true'))}
                ${this._item(i18n.t('EnableCollectionRows') || 'Enable Collection Rows in Home Screen', i18n.t('EnableCollectionRowsDescription') || 'Display custom collection and trending rows.', this._toggle('toggle-enable-collection-rows', enableRows))}
                ${this._item(i18n.t('LabelTrendingMoviesCollection'), i18n.t('LabelTrendingMoviesCollectionDescription'), this._drop('trending-movies-collection-select', mTrend.opts, mTrend.val), 'trending-movies-collection-item', enableRows)}
                ${this._item(i18n.t('LabelTrendingSeriesCollection'), i18n.t('LabelTrendingSeriesCollectionDescription'), this._drop('trending-series-collection-select', sTrend.opts, sTrend.val), 'trending-series-collection-item', enableRows)}
                ${this._item(i18n.t('LabelUseTrendingCollectionName'), i18n.t('LabelUseTrendingCollectionNameDescription'), this._toggle('toggle-use-trending-collection-name', storage.getItem('pref:useTrendingCollectionName') === 'true'), 'trending-collection-name-item', enableRows)}
                ${this._item(i18n.t('LabelCustomCollectionRows'), i18n.t('LabelCustomCollectionRowsDesc'), customColsBtn, 'setting-custom-collections', enableRows)}
                ${this._item(i18n.t('PreferEpisodeImages') || 'Prefer Episode Images', i18n.t('PreferEpisodeImagesDescription') || 'Show episode preview thumbnail on Next Up cards.', this._toggle('toggle-prefer-episode-images', storage.getItem('pref:preferEpisodeImagesLocal') === 'true'))}
                ${this._item(i18n.t('LabelMaxDaysForNextUp'), i18n.t('MaxDaysForNextUpDescription'), this._drop('next-up-max-days-select', daysOpts, storage.getItem('pref:nextUpMaxDays') || 365))}
                ${this._item(i18n.t('HideWatchedContentFromLatestMedia') || 'Hide played from Recently Added', i18n.t('HideWatchedContentFromLatestMediaDescription') || 'Hide watched items from Recently Added.', this._toggle('toggle-hide-played-latest', storage.getItem('pref:hidePlayedInLatest') === 'true'))}
                ${this._item(i18n.t('LibraryThumbnails') || 'Library Thumbnails', i18n.t('LibraryThumbnailsDescription') || 'Style of library cards on home screen', this._drop('library-thumb-mode-select', [{ value: 'off', label: i18n.t('fromJellyfin') || 'From Jellyfin' }, { value: 'static', label: i18n.t('RandomStatic') || 'Random Backdrop (Static)' }, { value: 'dynamic', label: i18n.t('RandomDynamic') || 'Random Backdrop (Dynamic)' }], thumbMode))}
                ${this._item(i18n.t('RegenerateThumbnails') || 'Regenerate Thumbnails', i18n.t('RegenerateThumbnailsDescription') || 'Pick new random backdrops for libraries', regenBtn, 'library-thumb-regenerate-container', thumbMode === 'static')}
                ${this._item(i18n.t('HideLibraryLabels'), i18n.t('HideLibraryLabelsDescription'), this._toggle('toggle-library-labels', storage.getItem('pref:hideLibraryLabels') === 'true'))}
                ${this._item(i18n.t('HideLiveTvInMyMedia') || 'Hide Live TV from My Media', i18n.t('HideLiveTvInMyMediaDescription') || "Hide Live TV card from 'My Media' row.", this._toggle('toggle-hide-livetv-home', storage.getItem('pref:hideLiveTvInMyMedia') === 'true'))}
                ${this._item(i18n.t('DefaultLiveTvTab') || 'Default Live TV Tab', i18n.t('DefaultLiveTvTabDescription') || 'Default selected tab in Live TV.', this._drop('default-livetv-tab-select', [{ value: 'suggestions', label: (i18n.t('Suggestions') || 'Suggestions') + ` (${i18n.t('Default') || 'Default'})` }, { value: 'guide', label: i18n.t('Guide') || 'Guide' }, { value: 'channels', label: i18n.t('Channels') || 'Channels' }], storage.getItem('pref:defaultLiveTvTab') || 'suggestions'))}

                <h3 class="setting-section-title" data-i18n="HeroCarousel" style="margin-top: 40px;">${i18n.t('HeroCarousel') || 'Hero Carousel'}</h3>
                ${this._item(i18n.t('EnableHeroCarousel') || 'Hero Carousel', i18n.t('EnableHeroCarouselDescription') || 'Show featured carousel at the top of the home screen.', this._toggle('toggle-hero-carousel', heroEnabled))}
                ${this._item(i18n.t('HeroStyle'), i18n.t('HeroStyleDescription') || 'Visual style of the hero carousel', this._drop('hero-carousel-style-select', heroStyles, heroStyle), 'hero-carousel-style-item', heroEnabled)}
                ${this._item(i18n.t('HeroCarouselCompact') || 'Compact Mode', i18n.t('HeroCarouselCompactDescription') || 'Reduces height of hero section.', this._toggle('toggle-hero-carousel-compact', storage.getItem('pref:heroCarouselCompact') !== 'false'), 'hero-carousel-compact-item', heroEnabled)}
                ${this._item(i18n.t('HeroImageQuality') || 'Hero Background Quality', i18n.t('HeroImageQualityDescription') || 'Image quality for hero backgrounds.', this._drop('hero-image-quality-select', heroQualities, storage.getItem('pref:heroImageQuality') || 'default'), 'hero-image-quality-item', heroEnabled)}
                ${this._item(i18n.t('HeroCarouselInterval') || 'Carousel Switch Timer', i18n.t('HeroCarouselIntervalDescription') || 'Slide switch duration.', this._drop('hero-carousel-interval-select', intervals, storage.getItem('pref:heroCarouselInterval') || '8000'), 'hero-carousel-interval-item', heroEnabled)}
                ${this._item(i18n.t('HeroCarouselCount') || 'Carousel Item Count', i18n.t('HeroCarouselCountDescription') || 'Items to load in carousel (1-30).', this._drop('hero-carousel-count-select', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20, 25, 30].map((v) => ({ value: v.toString(), label: v.toString() })), storage.getItem('pref:heroCarouselCount') || '5'), 'hero-carousel-count-item', heroEnabled)}
                ${this._item(i18n.t('HeroCarouselMdbList') || 'Show MDB Ratings & Awards', i18n.t('HeroCarouselMdbListDescription') || 'Display premium ratings and awards.', this._toggle('toggle-hero-carousel-mdb', storage.getItem('pref:heroCarouselMdbList') !== 'false'), 'hero-carousel-mdb-item', heroEnabled && pluginManager.isEnabled('mdblist-ratings'))}
                ${this._item(i18n.t('HeroCarouselIgnoreWatched') || 'Ignore Watched Content', i18n.t('HeroCarouselIgnoreWatchedDescription') || 'Excludes watched content from carousel.', this._toggle('toggle-hero-carousel-ignore-watched', storage.getItem('pref:heroCarouselIgnoreWatched') === 'true'), 'hero-carousel-ignore-watched-item', heroEnabled)}
                ${this._item(i18n.t('HeroCarouselTextTitle') || 'Use Text Titles', i18n.t('HeroCarouselTextTitleDescription') || 'Prefer text titles over logos.', this._toggle('toggle-hero-carousel-text-title', storage.getItem('pref:heroCarouselTextTitle') === 'true'), 'hero-carousel-text-title-item', heroEnabled)}
                ${this._item(i18n.t('HeroCarouselVignette') || 'Text Vignette Contrast', i18n.t('HeroCarouselVignetteDescription') || 'Dark vignette gradient behind titles.', this._drop('hero-carousel-vignette-select', vignettes, layoutManager.getHeroVignette()), 'hero-carousel-vignette-item', heroEnabled)}
                ${this._item(i18n.t('HeroCarouselZoom') || 'Enable Zoom Effect', i18n.t('HeroCarouselZoomDescription') || 'Subtle zoom animation on focus.', this._toggle('toggle-hero-carousel-zoom', storage.getItem('pref:heroCarouselZoom') === 'true'), 'hero-carousel-zoom-item', heroEnabled)}
                ${this._item(i18n.t('HeroCarouselBlurhashFill') || 'BlurHash Color Fill', i18n.t('HeroCarouselBlurhashFillDescription') || 'Fill background with BlurHash colors.', this._toggle('toggle-hero-carousel-blurhash-fill', storage.getItem('pref:heroCarouselBlurhashFill') === 'true'), 'hero-carousel-blurhash-fill-item', heroEnabled && heroStyle === 'immersive-performance')}
                ${this._item(i18n.t('HeroCarouselIndicatorStyle') || 'Indicator Style', i18n.t('HeroCarouselIndicatorStyleDescription') || 'Visual style of position indicators.', this._drop('hero-carousel-indicator-style-select', [{ value: 'dots', label: i18n.t('IndicatorStyleDots') || 'Simple Dots' }, { value: 'lines', label: i18n.t('IndicatorStyleLines') || 'Lines' }, { value: 'progress', label: i18n.t('IndicatorStyleProgress') || 'Progress Pill' }], indicatorStyle), 'hero-carousel-indicator-style-item', heroEnabled)}
                ${this._item(i18n.t('HeroCarouselIndicatorAnimation') || 'Indicator Animation', i18n.t('HeroCarouselIndicatorAnimationDescription') || 'Progress animation for indicators.', this._toggle('toggle-indicator-animation', storage.getItem('pref:heroCarouselIndicatorAnimation') !== 'false'), 'hero-carousel-indicator-animation-item', heroEnabled && indicatorStyle === 'progress')}

                <h3 class="setting-section-title" data-i18n="HomeLayoutOrder" style="margin-top: 40px;">${i18n.t('HomeLayoutOrder') || 'Home Screen Layout'}</h3>
                <div class="home-layout-container" id="home-layout-container">
                    <div class="setting-item"><div class="setting-label"><div class="loading-spinner small"></div></div></div>
                </div>
            </div>
        `;
    }

    async setupHomeLayoutUI() {
        const container = this.page.$('#home-layout-container');
        if (!container) return;

        try {
            const viewsResponse = await api.getUserViews();
            const views = viewsResponse.Items || [];
            const mergeResumeNextUp = storage.getItem('pref:mergeResumeNextUp') === 'true';
            const descriptors = [{ id: 'my-media', title: i18n.t('HeaderMyMedia') }, { id: 'resume', title: i18n.t('HeaderContinueWatching') }];

            const useTrendingColName = storage.getItem('pref:useTrendingCollectionName') === 'true';
            const addTrending = (colKey, nameKey, defTitleKey, id) => {
                const col = storage.getItem(colKey) || 'auto';
                const name = storage.getItem(nameKey);
                if (col !== 'none') {
                    descriptors.push({ id, title: (useTrendingColName && col !== 'auto' && col !== 'top-rated' && name) ? name : i18n.t(defTitleKey) });
                }
            };
            addTrending('pref:trendingMoviesCollection', 'pref:trendingMoviesCollectionName', 'HeaderTrendingMovies', 'trending');
            addTrending('pref:trendingSeriesCollection', 'pref:trendingSeriesCollectionName', 'HeaderTrendingSeries', 'trending-series');
            if (!mergeResumeNextUp) descriptors.push({ id: 'next-up', title: i18n.t('NextUp') });
            views.forEach((lib) => descriptors.push({ id: `latest-${lib.Id}`, title: i18n.t('LatestFromLibrary', [lib.Name]) }));

            try {
                const rawCustom = storage.getItem('pref:customCollectionRows');
                const customList = rawCustom ? JSON.parse(rawCustom) : [];
                if (Array.isArray(customList)) {
                    customList.forEach((c) => { if (c && c.id) descriptors.push({ id: `collection-${c.id}`, title: c.name || 'Collection' }); });
                }
            } catch (_) {}

            const layoutVars = homeLayoutManager.buildSettingsLayout(descriptors);

            const renderList = () => {
                if (!layoutVars.length) {
                    container.innerHTML = `<span class="setting-description">No layout configuration available.</span>`;
                    return;
                }
                container.innerHTML = `<div class="home-layout-list">` + layoutVars.map((item, idx) => {
                    const isLocked = item.locked;
                    const isFirst = idx === 0 || (idx > 0 && layoutVars[idx - 1].locked);
                    const isLast = idx === layoutVars.length - 1 || (idx < layoutVars.length - 1 && layoutVars[idx + 1].locked);
                    const eye = item.hidden ? EYE_OFF : EYE_ON;
                    return `<div class="setting-item layout-row ${item.hidden ? 'layout-row-hidden' : ''}" data-id="${item.id}" data-index="${idx}"><div class="setting-label"><span class="setting-name layout-row-title">${item.title}</span></div><div class="setting-control layout-btns" dir="ltr"><button class="btn btn-icon layout-btn-up" tabindex="0" ${isFirst || isLocked ? 'disabled style="opacity:0.3"' : ''} aria-label="Move Up">${UP_SVG}</button><button class="btn btn-icon layout-btn-down" tabindex="0" ${isLast || isLocked ? 'disabled style="opacity:0.3"' : ''} aria-label="Move Down">${DOWN_SVG}</button><button class="btn btn-icon layout-btn-toggle" tabindex="0" aria-label="${item.hidden ? 'Show' : 'Hide'}">${eye}</button></div></div>`;
                }).join('') + `</div>`;
                focusManager.invalidateCache('settings-content');
            };

            container.onclick = (e) => {
                const btn = e.target.closest('button');
                const row = e.target.closest('.layout-row');
                if (!btn || !row) return;
                const idx = parseInt(row.dataset.index, 10);
                const swap = (targetIdx, sel) => {
                    [layoutVars[targetIdx], layoutVars[idx]] = [layoutVars[idx], layoutVars[targetIdx]];
                    homeLayoutManager.saveLayout(layoutVars);
                    renderList();
                    setTimeout(() => { const r = container.querySelector(`.layout-row[data-index="${targetIdx}"]`); if (r) focusManager.focusElement(r.querySelector(sel)); }, 50);
                };
                if (btn.classList.contains('layout-btn-up') && idx > 0 && !layoutVars[idx].locked && !layoutVars[idx - 1].locked) {
                    swap(idx - 1, '.layout-btn-up');
                } else if (btn.classList.contains('layout-btn-down') && idx < layoutVars.length - 1 && !layoutVars[idx].locked && !layoutVars[idx + 1].locked) {
                    swap(idx + 1, '.layout-btn-down');
                } else if (btn.classList.contains('layout-btn-toggle') && !layoutVars[idx].locked) {
                    layoutVars[idx].hidden = !layoutVars[idx].hidden;
                    homeLayoutManager.saveLayout(layoutVars);
                    renderList();
                    setTimeout(() => { const r = container.querySelector(`.layout-row[data-index="${idx}"]`); if (r) focusManager.focusElement(r.querySelector('.layout-btn-toggle')); }, 50);
                }
            };

            renderList();
        } catch (e) {
            log.error('Failed to load layouts', e);
            container.innerHTML = `<span class="setting-description">Error loading layouts.</span>`;
        }
    }

    async mount(root) {
        const rootEl = root || (this.page && this.page.element) || document;

        const enableRowsBtn = rootEl.querySelector('#toggle-enable-collection-rows');
        const items = ['#trending-movies-collection-item', '#trending-series-collection-item', '#trending-collection-name-item', '#setting-custom-collections'];

        if (enableRowsBtn) {
            enableRowsBtn.addEventListener('click', () => {
                const nextVal = storage.getItem('pref:enableCollectionRows') !== 'true';
                storage.setItem('pref:enableCollectionRows', nextVal.toString());
                enableRowsBtn.classList.toggle('active', nextVal);

                if (!nextVal) {
                    storage.setItem('pref:trendingMoviesCollection', 'none');
                    storage.setItem('pref:trendingSeriesCollection', 'none');
                    ['trending-movies-collection-select', 'trending-series-collection-select'].forEach((selId) => {
                        const b = rootEl.querySelector(`.select-btn[data-id="${selId}"]`);
                        if (b) {
                            b.dataset.value = 'none';
                            const l = b.querySelector('.btn-label');
                            if (l) l.innerText = i18n.t('Disabled') || 'Disabled';
                        }
                    });
                }

                items.forEach((sel) => {
                    const el = rootEl.querySelector(sel);
                    if (el) el.style.display = nextVal ? '' : 'none';
                });

                this.setupHomeLayoutUI();
                focusManager.invalidateCache('settings-content');
            });
        }

        const manageCustomBtn = rootEl.querySelector('#btn-manage-custom-collections');
        if (manageCustomBtn) {
            manageCustomBtn.addEventListener('click', () => this.showCustomCollectionsModal());
        }

        const bindToggle = (sel, key, isNegated = false, onChange = null) => {
            const btn = rootEl.querySelector(sel);
            if (!btn) return;
            btn.addEventListener('click', () => {
                const cur = isNegated ? storage.getItem(key) !== 'false' : storage.getItem(key) === 'true';
                const next = !cur;
                storage.setItem(key, next.toString());
                btn.classList.toggle('active', next);
                if (typeof onChange === 'function') onChange(next);
            });
        };

        bindToggle('#toggle-use-trending-collection-name', 'pref:useTrendingCollectionName');
        bindToggle('#toggle-prefer-episode-images', 'pref:preferEpisodeImagesLocal');
        bindToggle('#toggle-hide-played-latest', 'pref:hidePlayedInLatest');
        bindToggle('#toggle-library-labels', 'pref:hideLibraryLabels');
        bindToggle('#toggle-hide-livetv-home', 'pref:hideLiveTvInMyMedia');
        bindToggle('#toggle-hero-carousel-text-title', 'pref:heroCarouselTextTitle');
        bindToggle('#toggle-hero-carousel-compact', 'pref:heroCarouselCompact', true);
        bindToggle('#toggle-hero-carousel-zoom', 'pref:heroCarouselZoom');
        bindToggle('#toggle-hero-carousel-blurhash-fill', 'pref:heroCarouselBlurhashFill');
        bindToggle('#toggle-indicator-animation', 'pref:heroCarouselIndicatorAnimation', true);
        bindToggle('#toggle-hero-carousel-mdb', 'pref:heroCarouselMdbList', true);
        bindToggle('#toggle-hero-carousel-ignore-watched', 'pref:heroCarouselIgnoreWatched');

        const mergeBtn = rootEl.querySelector('#toggle-merge-resume-nextup');
        if (mergeBtn) {
            mergeBtn.addEventListener('click', () => {
                const next = !(storage.getItem('pref:mergeResumeNextUp') === 'true');
                storage.setItem('pref:mergeResumeNextUp', next.toString());
                mergeBtn.classList.toggle('active', next);
                this.setupHomeLayoutUI();
                focusManager.invalidateCache('settings-content');
                state.delete('home:pageCache');
            });
        }

        const heroBtn = rootEl.querySelector('#toggle-hero-carousel');
        if (heroBtn) {
            heroBtn.addEventListener('click', () => {
                const next = !(storage.getItem('pref:heroCarousel') !== 'false');
                storage.setItem('pref:heroCarousel', next.toString());
                heroBtn.classList.toggle('active', next);

                const ids = ['#hero-carousel-text-title-item', '#hero-carousel-compact-item', '#hero-carousel-style-item', '#hero-carousel-zoom-item', '#hero-image-quality-item', '#hero-carousel-indicator-style-item', '#hero-carousel-interval-item', '#hero-carousel-count-item', '#hero-carousel-ignore-watched-item'];
                ids.forEach((id) => {
                    const el = rootEl.querySelector(id);
                    if (el) el.style.display = next ? '' : 'none';
                });

                const curStyle = storage.getItem('pref:heroCarouselStyle') || 'immersive-performance';
                const blurFill = rootEl.querySelector('#hero-carousel-blurhash-fill-item');
                if (blurFill) blurFill.style.display = next && curStyle === 'immersive-performance' ? '' : 'none';

                const indStyle = storage.getItem('pref:heroCarouselIndicatorStyle') || 'dots';
                const indAnim = rootEl.querySelector('#hero-carousel-indicator-animation-item');
                if (indAnim) indAnim.style.display = next && indStyle === 'progress' ? '' : 'none';

                const mdbItem = rootEl.querySelector('#hero-carousel-mdb-item');
                if (mdbItem) mdbItem.style.display = next && pluginManager.isEnabled('mdblist-ratings') ? '' : 'none';

                focusManager.invalidateCache('settings-content');
                state.delete('home:pageCache');
            });
        }

        const regenBtn = rootEl.querySelector('#btn-regenerate-thumbs');
        if (regenBtn) {
            regenBtn.addEventListener('click', () => {
                regenBtn.disabled = true;
                regenBtn.textContent = i18n.t('Working');
                storage.clearByPrefix('libThumb:');
                setTimeout(() => router.reset('/home'), 500);
            });
        }

        await this.setupHomeLayoutUI();
    }

    destroy() {
        if (this.customCollectionsModal) {
            this.customCollectionsModal.close();
        }
        this._listeners.forEach((fn) => {
            try { fn(); } catch (_) {}
        });
        this._listeners = [];
    }
}
