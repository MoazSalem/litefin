/**
 * ============================================================================
 * Litefin Tizen - Seerr Details Page
 * ============================================================================
 * Presents Seerr catalogue metadata with the same visual and focus primitives
 * as Jellyfin details, without coupling external items to playback logic.
 * ============================================================================
 */

import Page from './Page.js';
import DescriptionModal from '../components/DescriptionModal.js';
import SeerrRequestModal from '../components/SeerrRequestModal.js';
import { RichMetadataTable } from '../components/RichMetadataTable.js';
import { seerr } from '../api/JellyseerrClient.js';
import { SEERR_STATUS, seerrStatusKey } from '../api/seerrNormalize.js';
import BackdropManager from '../utils/BackdropManager.js';
import { focusManager } from '../ui/FocusManager.js';
import { toast } from '../ui/Toast.js';
import { storage } from '../utils/StorageService.js';
import { detailsIcons } from '../utils/Icons.js';
import { i18n } from '../utils/i18n.js';
import { TrailerPlayer } from '../components/TrailerPlayer.js';
import { PlayerSettings } from '../utils/PlayerSettings.js';
import { themeSongPlayer } from '../utils/ThemeSongPlayer.js';
import { VirtualCardRow } from '../components/VirtualCardRow.js';
import CardRenderer from '../utils/CardRenderer.js';
import { lazyLoader } from '../utils/LazyLoader.js';
import { router } from '../core/Router.js';
import { state } from '../core/StateManager.js';
import { logger } from '../utils/Logger.js';

const log = logger.create('SeerrDetailsPage');

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

class SeerrDetailsPage extends Page {
    constructor() {
        super();
        this._isAsyncPage = true;
        this._item = null;
        this._isWatchlisted = false;
    }

    render() {
        const detailsLayout = storage.getItem('pref:detailsLayout') || 'posterLeft';
        const layoutClasses = {
            posterRight: 'layout-poster-right',
            backdropMinimal: 'layout-backdrop-minimal',
            backdropLeft: 'layout-backdrop-left'
        };

        return `
            <div class="page details-page seerr-details-page ${layoutClasses[detailsLayout] || 'layout-poster-left'}">
                <div class="details-backdrop" id="backdrop">
                    <div class="backdrop-gradient"></div>
                </div>
                <div class="details-content page-content">
                    <div class="details-main-split media-row">
                        <div class="hero-poster" id="poster"></div>
                        <div class="details-info-col" id="details-info-col">
                            <div class="hero-info" id="hero-info"></div>
                            <section class="details-actions" id="actions">
                                <button class="btn btn-action seerr-request-btn" tabindex="0">
                                    ${detailsIcons.add}
                                    <span>${i18n.t('SeerrRequest')}</span>
                                </button>
                                <button class="btn btn-action seerr-cancel-request-btn hidden" tabindex="0">
                                    ${detailsIcons.cancel}
                                    <span>${i18n.t('SeerrCancelRequest')}</span>
                                </button>
                                <button class="btn btn-action seerr-trailer-btn hidden" tabindex="0">
                                    ${detailsIcons.trailer}
                                    <span>${i18n.t('WatchTrailer')}</span>
                                </button>
                                <button class="btn btn-action seerr-watchlist-btn" tabindex="0">
                                    ${detailsIcons.watchlist}
                                    <span>${i18n.t('SeerrAddToWatchlist')}</span>
                                </button>
                            </section>
                            <div class="details-overview">
                                <div class="overview-text line-clamp-6" id="overview-text" tabindex="-1"></div>
                                <button class="see-more-btn" tabindex="0">${i18n.t('ShowMore')}</button>
                            </div>
                        </div>
                    </div>
                    <div id="rich-meta-container" class="media-row hidden">
                        <div class="details-rich-meta" id="rich-meta"></div>
                    </div>

                    <!-- Cast & Crew -->
                    <section class="details-people media-row hidden" id="seerr-people-section">
                        <h2 class="row-title" data-i18n="HeaderCastAndCrew">${i18n.t('HeaderCastAndCrew')}</h2>
                        <div class="people-row" id="seerr-people-row"></div>
                    </section>

                    <!-- Recommendations -->
                    <section class="details-recommendations media-row hidden" id="seerr-recommendations-section">
                        <h2 class="row-title" data-i18n="HeaderRecommendations">${i18n.t('HeaderRecommendations')}</h2>
                        <div class="recommendations-row" id="seerr-recommendations-row"></div>
                    </section>

                    <!-- Similar items -->
                    <section class="details-similar media-row hidden" id="seerr-similar-section">
                        <h2 class="row-title" data-i18n="HeaderMoreLikeThis">${i18n.t('HeaderMoreLikeThis')}</h2>
                        <div class="similar-row" id="seerr-similar-row"></div>
                    </section>

                    <div class="discover-message hidden" id="seerr-details-message"></div>
                    <div class="page-loading hidden"><div class="loading-spinner"></div></div>
                </div>
            </div>
        `;
    }

    async onInit() {
        const mediaType = this.params.mediaType === 'tv' ? 'tv' : 'movie';
        const tmdbId = parseInt(this.params.tmdbId, 10);

        if (!tmdbId) {
            this._showError();
            return;
        }

        this.setLoading(true);
        try {
            this._item = await seerr.details(mediaType, tmdbId);
            if (mediaType === 'tv') {
                try {
                    const seasons = await seerr.tvSeasons(tmdbId);
                    this._hasUnrequestedSeasons = seasons.some(
                        (s) => s.status === SEERR_STATUS.NOT_REQUESTED || s.status === SEERR_STATUS.DELETED
                    );
                } catch (e) {
                    this._hasUnrequestedSeasons = true;
                }
            }
            try {
                this._isWatchlisted = await seerr.isWatchlisted(mediaType, tmdbId);
            } catch (err) {
                log.warn('Unable to load Seerr watchlist state', err);
            }
            this.title = this._item.Name;
            this._renderDetails();
            this._bindActions();
            this._registerFocus();
            seerr.getRatingsCombined(mediaType, tmdbId)
                .then((ratings) => this._renderRatings(ratings))
                .catch((err) => log.warn('Ratings fetch failed', err));

            const focusStateKey = `seerr:lastFocusedItem:${tmdbId}`;
            const hasFocusTarget = this._pendingNavState || state.get(focusStateKey);
            if (hasFocusTarget) {
                this._deferredLoading = true;
            } else {
                this.setLoading(false);
                this.markReady();
                this.restoreScrollFocusWhenReady();
            }

            if (this._deferredLoading) {
                await this._loadSecondaryContent(mediaType, tmdbId);
                this.setLoading(false);
                this._deferredLoading = false;
                this.markReady();
                this.restoreScrollFocusWhenReady();
            } else {
                setTimeout(() => this._loadSecondaryContent(mediaType, tmdbId), 50);
            }
        } catch (err) {
            log.warn('Unable to load Seerr details', err);
            this._showError();
            this.setLoading(false);
            this.markReady();
        }
    }

    _renderDetails() {
        const item = this._item;
        const runtimeMinutes = item.RunTimeTicks ? Math.round(item.RunTimeTicks / 600000000) : 0;
        const runtime = runtimeMinutes
            ? `${Math.floor(runtimeMinutes / 60) ? `${Math.floor(runtimeMinutes / 60)}h ` : ''}${runtimeMinutes % 60}m`
            : '';
        const statusKey = seerrStatusKey(item._seerrStatus);
        const formatCompactCurrency = (val) => {
            if (typeof val !== 'number' || val <= 0) return '';
            if (val >= 1e9) return `$${(val / 1e9).toFixed(1).replace(/\.0$/, '')}B`;
            if (val >= 1e6) return `$${(val / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
            if (val >= 1e3) return `$${(val / 1e3).toFixed(1).replace(/\.0$/, '')}K`;
            return `$${val}`;
        };

        const primaryMeta = [
            item.ProductionYear ? `<span class="meta-item">${item.ProductionYear}</span>` : '',
            runtime ? `<span class="meta-item">${runtime}</span>` : '',
            item.CommunityRating
                ? `<span class="meta-item seerr-rating-item seerr-tmdb-rating">${detailsIcons.tmdbRating} ${item.CommunityRating.toFixed(1)}</span>`
                : ''
        ].filter(Boolean).join('');

        const secondaryMeta = [
            statusKey
                ? `<span class="meta-item meta-badge seerr-details-status">${escapeHtml(i18n.t(statusKey))}</span>`
                : '',
            item.MediaStatus
                ? `<span class="meta-item seerr-meta-card">${escapeHtml(item.MediaStatus)}</span>`
                : '',
            item.ReleaseDate
                ? `<span class="meta-item seerr-meta-card">${escapeHtml(item.ReleaseDate)}</span>`
                : '',
            item.Budget
                ? `<span class="meta-item seerr-meta-card">Budget: ${formatCompactCurrency(item.Budget)}</span>`
                : '',
            item.Revenue
                ? `<span class="meta-item seerr-meta-card">Revenue: ${formatCompactCurrency(item.Revenue)}</span>`
                : ''
        ].filter(Boolean).join('');

        this.$('#hero-info').innerHTML = `
            <h1 class="details-title" style="max-width: 100%;">${escapeHtml(i18n.ensureBiDi(item.Name))}</h1>
            ${item.OriginalTitle ? `<h2 class="details-original-title">${escapeHtml(i18n.ensureBiDi(item.OriginalTitle))}</h2>` : ''}
            <div class="details-meta-row">${primaryMeta}</div>
            ${secondaryMeta ? `<div class="details-meta-row secondary-meta-row" style="margin-top: 6px;">${secondaryMeta}</div>` : ''}
        `;

        const overviewContainer = this.$('.details-overview');
        const overviewEl = this.$('#overview-text');
        let taglineEl = overviewContainer.querySelector('.details-tagline');
        if (!taglineEl && item.Tagline) {
            taglineEl = document.createElement('p');
            taglineEl.className = 'details-tagline';
            overviewContainer.insertBefore(taglineEl, overviewEl);
        }
        if (taglineEl) {
            taglineEl.textContent = item.Tagline || '';
            taglineEl.style.display = item.Tagline ? 'block' : 'none';
        }

        overviewEl.textContent = item.Overview || '';

        if (item._detailImageUrl) {
            const poster = document.createElement('img');
            poster.alt = item.Name || '';
            poster.addEventListener('load', () => poster.classList.add('loaded'));
            poster.src = item._detailImageUrl;
            this.$('#poster').appendChild(poster);
        }

        if (item._backdropUrl) BackdropManager.applyBackdrop(this.$('#backdrop'), item._backdropUrl);

        const richMetadataStyle =
            storage.getItem('pref:richMetadataStyle') ||
            (storage.getItem('pref:hideRichMetadata') === 'true' ? 'none' : 'all');
        const isHidden = richMetadataStyle === 'none';

        this._richMetaTable = new RichMetadataTable({
            container: this.$('#rich-meta'),
            containerWrapper: this.$('#rich-meta-container'),
            onChipClick: (chip) => {
                const name = chip.dataset.name;
                log.info(`Selected metadata chip: ${name}`);
            }
        });

        if (isHidden) {
            this._richMetaTable.render('');
        } else {
            const htmlParts = [];
            if (item.Genres && item.Genres.length > 0) {
                htmlParts.push(RichMetadataTable.createChipRow('Genres', item.Genres));
            }
            if (
                (richMetadataStyle === 'all' ||
                    richMetadataStyle === 'genres-studios' ||
                    richMetadataStyle === 'genres-studios-writers') &&
                item.Studios &&
                item.Studios.length > 0
            ) {
                htmlParts.push(RichMetadataTable.createChipRow('Studios', item.Studios));
            }
            if (
                (richMetadataStyle === 'all' ||
                    richMetadataStyle === 'genres-studios-writers' ||
                    richMetadataStyle === 'genres-writers') &&
                item.ProductionTeam &&
                item.ProductionTeam.length > 0
            ) {
                htmlParts.push(RichMetadataTable.createChipRow('ProductionTeam', item.ProductionTeam));
            }
            if (richMetadataStyle === 'all' && item.Tags && item.Tags.length > 0) {
                htmlParts.push(RichMetadataTable.createChipRow('Tags', item.Tags));
            }
            this._richMetaTable.render(htmlParts.join(''));
        }

        this._updateRequestButton();
        this._updateWatchlistButton();
        this._updateTrailerButton();

        requestAnimationFrame(() => {
            this.$('#details-info-col').classList.add('visible');
            this._checkOverviewTruncation();
        });
    }

    _updateTrailerButton() {
        const trailerBtn = this.$('.seerr-trailer-btn');
        if (!trailerBtn) return;
        const hasTrailers = this._item && Array.isArray(this._item.RemoteTrailers) && this._item.RemoteTrailers.length > 0;
        trailerBtn.classList.toggle('hidden', !hasTrailers);
        trailerBtn.tabIndex = hasTrailers ? 0 : -1;
    }

    _showRemoteTrailerPlayer() {
        themeSongPlayer.stopInstant();
        const mode = PlayerSettings.get('trailerPlaybackMode') || 'internal_proxy';
        const trailers = (this._item && this._item.RemoteTrailers) || [];
        if (!trailers.length) return;

        if (mode === 'external') {
            TrailerPlayer.launchExternal(trailers, this);
        } else if (mode === 'internal_iframe') {
            TrailerPlayer.showLegacy(trailers, this);
        } else {
            TrailerPlayer.show(trailers, this);
        }
    }

    _checkOverviewTruncation() {
        const overviewEl = this.$('#overview-text');
        const seeMoreBtn = this.$('.see-more-btn');
        if (!overviewEl || !seeMoreBtn) return;

        const isTruncated = overviewEl.scrollHeight > overviewEl.clientHeight + 2;
        seeMoreBtn.classList.toggle('hidden', !isTruncated);
        seeMoreBtn.tabIndex = isTruncated ? 0 : -1;
        this._registerFocus();
    }

    async _refreshTvSeasonState() {
        if (this._item._mediaType === 'tv') {
            try {
                const seasons = await seerr.tvSeasons(this._item._tmdbId);
                this._hasUnrequestedSeasons = seasons.some(
                    (s) => s.status === SEERR_STATUS.NOT_REQUESTED || s.status === SEERR_STATUS.DELETED
                );
            } catch (e) {
                log.warn('Failed to refresh TV seasons status', e);
            }
        }
        this._updateRequestButton();
        this._renderStatus();
        this._registerFocus();
        focusManager.invalidateCache('seerr-details-actions');
    }

    _bindActions() {
        this.$('.seerr-request-btn')?.addEventListener('click', () => {
            SeerrRequestModal.show(this._item, async (newStatus, requestId) => {
                this._item._seerrStatus = newStatus;
                if (requestId) this._item._requestId = requestId;
                await this._refreshTvSeasonState();

                const reqBtn = this.$('.seerr-request-btn:not(.hidden)');
                const cancelBtn = this.$('.seerr-cancel-request-btn:not(.hidden)');
                const watchlistBtn = this.$('.seerr-watchlist-btn:not(.hidden)');
                const targetBtn = reqBtn || cancelBtn || watchlistBtn;
                if (targetBtn) {
                    this.setActiveSection('seerr-details-actions');
                    focusManager.focusElement(targetBtn);
                } else {
                    const overviewButton = this.$('.see-more-btn:not(.hidden)');
                    if (overviewButton) {
                        this.setActiveSection('seerr-details-overview');
                        focusManager.focusElement(overviewButton);
                    }
                }
            });
        });

        this.$('.seerr-cancel-request-btn')?.addEventListener('click', async () => {
            const button = this.$('.seerr-cancel-request-btn');
            if (!this._item._requestId) return;
            button.disabled = true;
            try {
                await seerr.cancelRequest(this._item._requestId);
                this._item._seerrStatus = SEERR_STATUS.NOT_REQUESTED;
                this._item._requestId = null;
                await this._refreshTvSeasonState();
                const reqBtn = this.$('.seerr-request-btn:not(.hidden)');
                if (reqBtn) focusManager.focusElement(reqBtn);
                toast.show(i18n.t('SeerrRequestCancelled'));
            } catch (err) {
                log.warn('Unable to cancel Seerr request', err);
                toast.show(i18n.t('SeerrCancelRequestFailed'));
            } finally {
                button.disabled = false;
            }
        });

        this.$('.seerr-watchlist-btn')?.addEventListener('click', async () => {
            const button = this.$('.seerr-watchlist-btn');
            button.disabled = true;
            try {
                if (this._isWatchlisted) await seerr.removeFromWatchlist(this._item);
                else await seerr.addToWatchlist(this._item);
                this._isWatchlisted = !this._isWatchlisted;
                this._updateWatchlistButton();
                toast.show(i18n.t(this._isWatchlisted ? 'SeerrAddedToWatchlist' : 'SeerrRemovedFromWatchlist'));
            } catch (err) {
                log.warn('Unable to update Seerr watchlist', err);
                toast.show(i18n.t('SeerrWatchlistFailed'));
            } finally {
                button.disabled = false;
            }
        });

        this.$('.seerr-trailer-btn')?.addEventListener('click', () => {
            this._showRemoteTrailerPlayer();
        });

        this.$('.see-more-btn')?.addEventListener('click', () => {
            DescriptionModal.show(
                { title: escapeHtml(this._item.Name), overview: escapeHtml(this._item.Overview) },
                this
            );
        });
    }

    onBackKey() {
        if (this._richMetaTable && this._richMetaTable.isActive()) {
            this._richMetaTable.deactivate();
            return true;
        }
        return super.onBackKey();
    }

    _renderVirtualRow(options) {
        const {
            sectionId,
            listId,
            items,
            isLandscape = false,
            renderCard,
            focusSectionName,
            onClick
        } = options;

        const section = this.$(`#${sectionId}`);
        const list = this.$(`#${listId}`);
        if (!section || !list || !items || items.length === 0) return;

        section.classList.remove('hidden');
        list.classList.add('row-items');
        list.innerHTML = `<div class="row-items-track"></div>`;
        const trackContainer = list.querySelector('.row-items-track');

        const virtualRow = new VirtualCardRow(trackContainer, items, {
            isLandscape: isLandscape,
            visibleCount: 10,
            initialWindow: Math.min(20, items.length),
            focusSectionId: focusSectionName,
            renderCard: renderCard
        });

        if (!this._virtualRows) this._virtualRows = {};
        this._virtualRows[focusSectionName] = virtualRow;

        const handleCardClick = (e) => {
            const card = e.target.closest('.media-card');
            if (!card) return;
            const virtualIndex = parseInt(card.getAttribute('data-virtual-index') || card.dataset.virtualIndex, 10);
            let item = !isNaN(virtualIndex) ? virtualRow.items[virtualIndex] : null;
            if (!item) {
                const cardId = card.getAttribute('data-id') || card.dataset.id;
                item = virtualRow.items.find((i) => String(i.Id) === String(cardId) || String(i._tmdbId) === String(cardId));
            }
            if (onClick) {
                onClick(card, item);
            } else if (item && item._tmdbId) {
                router.navigate(`/seerr/${item._mediaType || 'movie'}/${item._tmdbId}`);
            }
        };

        list.onclick = handleCardClick;
        trackContainer.onclick = handleCardClick;

        lazyLoader.observe(list);

        this.registerFocusSection(focusSectionName, list, {
            orientation: 'horizontal',
            leaveLeft: 'sidebar',
            onMove: (direction, currentElement) => {
                if (!currentElement || currentElement.dataset.virtualIndex === undefined) return false;
                const currentIndex = parseInt(currentElement.dataset.virtualIndex, 10);
                const nextNode = virtualRow.handleMove(direction, currentIndex);
                if (nextNode) {
                    virtualRow.syncIndexFromNode(nextNode);
                    focusManager.focusElement(nextNode);
                    return true;
                }
                return false;
            },
            onEnter: (fromElement, options) => {
                if (fromElement && options && (options.direction === 'up' || options.direction === 'down')) {
                    virtualRow._updateWindow(virtualRow.currentIndex);
                    return virtualRow.domNodes.get(virtualRow.currentIndex);
                }
                return null;
            }
        });

        this._registerFocus();
    }

    async _loadSecondaryContent(mediaType, tmdbId) {
        if (!this._item) return;

        // 1. Cast & Crew (check setting pref:hideCastSection)
        const hideCast = storage.getItem('pref:hideCastSection') === 'true';
        if (!hideCast && Array.isArray(this._item.Cast) && this._item.Cast.length > 0) {
            this._renderVirtualRow({
                sectionId: 'seerr-people-section',
                listId: 'seerr-people-row',
                items: this._item.Cast,
                isLandscape: false,
                renderCard: (person) => CardRenderer.createCardHtml(person, { type: 'person' }),
                focusSectionName: 'seerr-details-people'
            });
        }

        // 2. Recommendations
        let recommendedItems = (this._item && Array.isArray(this._item.Recommendations)) ? this._item.Recommendations : [];
        if (!recommendedItems.length) {
            try {
                recommendedItems = await seerr.recommendations(mediaType, tmdbId);
            } catch (e) {
                log.warn('Failed to load Seerr recommendations', e);
            }
        }
        if (recommendedItems && recommendedItems.length > 0) {
            this._renderVirtualRow({
                sectionId: 'seerr-recommendations-section',
                listId: 'seerr-recommendations-row',
                items: recommendedItems,
                isLandscape: false,
                renderCard: (item) => CardRenderer.createCardHtml(item, { type: 'poster' }),
                focusSectionName: 'seerr-details-recommendations',
                onClick: (card, item) => {
                    const target = item || recommendedItems.find((i) => String(i.Id) === String(card.getAttribute('data-id') || card.dataset.id));
                    if (target && target._tmdbId) {
                        const stateKey = `seerr:lastFocusedItem:${this._item._tmdbId}`;
                        if (storage.getItem('pref:disableFocusRestore') !== 'true') {
                            state.set(stateKey, {
                                itemId: target.Id || target._tmdbId,
                                sectionId: 'seerr-details-recommendations'
                            });
                        }
                        router.navigate(`/seerr/${target._mediaType || mediaType}/${target._tmdbId}`);
                    }
                }
            });
        }

        // 3. Similar items
        let similarItems = (this._item && Array.isArray(this._item.Similar)) ? this._item.Similar : [];
        if (!similarItems.length) {
            try {
                similarItems = await seerr.similar(mediaType, tmdbId);
            } catch (e) {
                log.warn('Failed to load Seerr similar items', e);
            }
        }
        if (similarItems && similarItems.length > 0) {
            this._renderVirtualRow({
                sectionId: 'seerr-similar-section',
                listId: 'seerr-similar-row',
                items: similarItems,
                isLandscape: false,
                renderCard: (item) => CardRenderer.createCardHtml(item, { type: 'poster' }),
                focusSectionName: 'seerr-details-similar',
                onClick: (card, item) => {
                    const target = item || similarItems.find((i) => String(i.Id) === String(card.getAttribute('data-id') || card.dataset.id));
                    if (target && target._tmdbId) {
                        const stateKey = `seerr:lastFocusedItem:${this._item._tmdbId}`;
                        if (storage.getItem('pref:disableFocusRestore') !== 'true') {
                            state.set(stateKey, {
                                itemId: target.Id || target._tmdbId,
                                sectionId: 'seerr-details-similar'
                            });
                        }
                        router.navigate(`/seerr/${target._mediaType || mediaType}/${target._tmdbId}`);
                    }
                }
            });
        }

        this._restoreLastFocusedItem();
    }

    _restoreLastFocusedItem() {
        if (!this._item) return;

        const stateKey = `seerr:lastFocusedItem:${this._item._tmdbId}`;
        if (storage.getItem('pref:disableFocusRestore') === 'true') {
            state.delete(stateKey);
            return;
        }

        const lastFocusedObj = state.get(stateKey);
        if (!lastFocusedObj) return;

        const targetId = lastFocusedObj.itemId;
        const sectionId = lastFocusedObj.sectionId;
        const virtualRow = this._virtualRows ? this._virtualRows[sectionId] : null;

        if (virtualRow) {
            const index = virtualRow.items.findIndex(
                (i) => String(i.Id) === String(targetId) || String(i._tmdbId) === String(targetId)
            );
            if (index !== -1) {
                this.setActiveSection(sectionId, false);
                const node = virtualRow.focusByIndex(index);
                if (node) {
                    focusManager.focusElement(node, { instantScroll: true });
                }
            }
        }
        state.delete(stateKey);
    }

    _registerFocus() {
        const requestButton = this.$('.seerr-request-btn');
        const hasRequestAction = requestButton && !requestButton.classList.contains('hidden');
        const cancelBtn = this.$('.seerr-cancel-request-btn');
        const hasCancelAction = cancelBtn && !cancelBtn.classList.contains('hidden');
        const trailerBtn = this.$('.seerr-trailer-btn');
        const hasTrailerAction = trailerBtn && !trailerBtn.classList.contains('hidden');
        const hasAction = hasRequestAction || hasCancelAction || !!this.$('.seerr-watchlist-btn') || hasTrailerAction;

        const hasOverviewAction = !this.$('.see-more-btn')?.classList.contains('hidden');
        const hasRichMeta = !this.$('#rich-meta-container')?.classList.contains('hidden');
        const hasPeople = !this.$('#seerr-people-section')?.classList.contains('hidden');
        const hasRecs = !this.$('#seerr-recommendations-section')?.classList.contains('hidden');
        const hasSimilar = !this.$('#seerr-similar-section')?.classList.contains('hidden');

        const getDownFromActions = () => {
            if (hasOverviewAction) return 'seerr-details-overview';
            if (hasRichMeta) return 'details-rich-meta';
            if (hasPeople) return 'seerr-details-people';
            if (hasRecs) return 'seerr-details-recommendations';
            if (hasSimilar) return 'seerr-details-similar';
            return null;
        };

        const getDownFromOverview = () => {
            if (hasRichMeta) return 'details-rich-meta';
            if (hasPeople) return 'seerr-details-people';
            if (hasRecs) return 'seerr-details-recommendations';
            if (hasSimilar) return 'seerr-details-similar';
            return null;
        };

        const getDownFromRichMeta = () => {
            if (hasPeople) return 'seerr-details-people';
            if (hasRecs) return 'seerr-details-recommendations';
            if (hasSimilar) return 'seerr-details-similar';
            return null;
        };

        if (hasAction) {
            this.registerFocusSection('seerr-details-actions', this.$('#actions'), {
                orientation: 'horizontal',
                leaveLeft: 'sidebar',
                leaveDown: getDownFromActions()
            });
        }

        if (hasOverviewAction) {
            this.registerFocusSection('seerr-details-overview', this.$('.details-overview'), {
                orientation: 'vertical',
                leaveUp: hasAction ? 'seerr-details-actions' : null,
                leaveDown: getDownFromOverview(),
                leaveLeft: 'sidebar'
            });
        }

        if (hasRichMeta) {
            this.registerFocusSection('details-rich-meta', this.$('#rich-meta-container'), {
                orientation: 'vertical',
                leaveUp: hasOverviewAction ? 'seerr-details-overview' : (hasAction ? 'seerr-details-actions' : null),
                leaveDown: getDownFromRichMeta(),
                leaveLeft: 'sidebar',
                enterTo: 'first'
            });
        }

        if (hasPeople) {
            this.registerFocusSection('seerr-details-people', this.$('#seerr-people-section'), {
                orientation: 'horizontal',
                leaveUp: hasRichMeta ? 'details-rich-meta' : (hasOverviewAction ? 'seerr-details-overview' : (hasAction ? 'seerr-details-actions' : null)),
                leaveDown: hasRecs ? 'seerr-details-recommendations' : (hasSimilar ? 'seerr-details-similar' : null),
                leaveLeft: 'sidebar'
            });
        }

        if (hasRecs) {
            this.registerFocusSection('seerr-details-recommendations', this.$('#seerr-recommendations-section'), {
                orientation: 'horizontal',
                leaveUp: hasPeople ? 'seerr-details-people' : (hasRichMeta ? 'details-rich-meta' : (hasOverviewAction ? 'seerr-details-overview' : (hasAction ? 'seerr-details-actions' : null))),
                leaveDown: hasSimilar ? 'seerr-details-similar' : null,
                leaveLeft: 'sidebar'
            });
        }

        if (hasSimilar) {
            this.registerFocusSection('seerr-details-similar', this.$('#seerr-similar-section'), {
                orientation: 'horizontal',
                leaveUp: hasRecs ? 'seerr-details-recommendations' : (hasPeople ? 'seerr-details-people' : (hasRichMeta ? 'details-rich-meta' : (hasOverviewAction ? 'seerr-details-overview' : (hasAction ? 'seerr-details-actions' : null)))),
                leaveLeft: 'sidebar'
            });
        }

        if (hasAction) this.setActiveSection('seerr-details-actions');
        else if (hasOverviewAction) this.setActiveSection('seerr-details-overview');
        else if (hasRichMeta) this.setActiveSection('details-rich-meta');
    }

    _updateRequestButton() {
        const button = this.$('.seerr-request-btn');
        const cancelBtn = this.$('.seerr-cancel-request-btn');
        if (!button) return;
        const isTv = this._item._mediaType === 'tv';
        let requestable;
        if (isTv) {
            requestable = this._item._seerrStatus !== SEERR_STATUS.AVAILABLE && this._hasUnrequestedSeasons !== false;
        } else {
            requestable =
                this._item._seerrStatus === SEERR_STATUS.NOT_REQUESTED ||
                this._item._seerrStatus === SEERR_STATUS.UNKNOWN ||
                this._item._seerrStatus === SEERR_STATUS.DELETED;
        }
        button.classList.toggle('hidden', !requestable);
        button.tabIndex = requestable ? 0 : -1;

        const canCancel = !!(this._item._requestId && this._item._seerrStatus !== SEERR_STATUS.AVAILABLE);
        if (cancelBtn) {
            cancelBtn.classList.toggle('hidden', !canCancel);
            cancelBtn.tabIndex = canCancel ? 0 : -1;
        }

        const isPartialOrPending =
            isTv &&
            (this._item._seerrStatus === SEERR_STATUS.PENDING ||
                this._item._seerrStatus === SEERR_STATUS.PROCESSING ||
                this._item._seerrStatus === SEERR_STATUS.PARTIALLY_AVAILABLE);
        const span = button.querySelector('span');
        if (span) {
            span.textContent = i18n.t(isPartialOrPending ? 'SeerrRequestMore' : 'SeerrRequest');
        }
        focusManager.invalidateCache('seerr-details-actions');
    }

    _updateWatchlistButton() {
        const label = this.$('.seerr-watchlist-btn span');
        if (label) label.textContent = i18n.t(this._isWatchlisted ? 'SeerrRemoveFromWatchlist' : 'SeerrAddToWatchlist');
        focusManager.invalidateCache('seerr-details-actions');
    }

    _renderStatus() {
        const statusKey = seerrStatusKey(this._item._seerrStatus);
        const row = this.$('.secondary-meta-row') || this.$('.details-meta-row');
        const oldStatus = this.$('.seerr-details-status');
        if (oldStatus) oldStatus.remove();
        if (!row || !statusKey) return;

        const status = document.createElement('span');
        status.className = 'meta-item meta-badge seerr-details-status';
        status.textContent = i18n.t(statusKey);
        row.insertBefore(status, row.firstChild);
    }

    _renderRatings(ratings) {
        if (!ratings) return;
        const row = this.$('.details-meta-row');
        if (!row) return;

        const oldContainer = row.querySelector('.seerr-ratings-container');
        if (oldContainer) oldContainer.remove();

        const ratingItems = [];

        // 2. IMDb
        if (ratings.imdb && typeof ratings.imdb.criticsScore === 'number' && ratings.imdb.criticsScore > 0) {
            ratingItems.push(
                `<span class="meta-item seerr-rating-item" title="IMDb">${detailsIcons.imdbRating} ${ratings.imdb.criticsScore.toFixed(1)}</span>`
            );
        }

        // 3. Rotten Tomatoes Critics
        if (ratings.rt && typeof ratings.rt.criticsScore === 'number' && ratings.rt.criticsScore > 0) {
            ratingItems.push(
                `<span class="meta-item seerr-rating-item" title="Rotten Tomatoes Critics">${detailsIcons.rottenTomatoesFresh} ${ratings.rt.criticsScore}%</span>`
            );
        }

        // 4. Rotten Tomatoes Audience
        if (ratings.rt && typeof ratings.rt.audienceScore === 'number' && ratings.rt.audienceScore > 0) {
            ratingItems.push(
                `<span class="meta-item seerr-rating-item" title="Rotten Tomatoes Audience">${detailsIcons.rottenTomatoesAudience} ${ratings.rt.audienceScore}%</span>`
            );
        }

        if (ratingItems.length > 0) {
            const container = document.createElement('div');
            container.className = 'seerr-ratings-container';
            container.style.display = 'inline-flex';
            container.style.gap = '20px';
            container.style.alignItems = 'center';
            container.style.marginLeft = '20px';
            container.innerHTML = ratingItems.join('');

            const tmdbItem = row.querySelector('.seerr-tmdb-rating');
            if (tmdbItem && tmdbItem.nextSibling) {
                row.insertBefore(container, tmdbItem.nextSibling);
            } else {
                row.appendChild(container);
            }
        }
    }

    _showError() {
        const message = this.$('#seerr-details-message');
        if (message) {
            message.textContent = i18n.t('SeerrLoadFailed');
            message.classList.remove('hidden');
        }
        this.markReady();
        this.restoreScrollFocusWhenReady();
    }

    destroy() {
        BackdropManager.clearBackdrop(this.$('#backdrop'));
        super.destroy();
    }
}

export default SeerrDetailsPage;
