/**
 * ============================================================================
 * Litefin Tizen - Seerr Details Page
 * ============================================================================
 * Presents Seerr catalogue metadata with the same visual and focus primitives
 * as Jellyfin details, without coupling external items to playback logic.
 * ============================================================================
 */

// Page-scoped styles - loads with this module's chunk instead of the boot bundle
import '../styles/discover.css';
// Own the shared details layout (backdrop, hero, meta rows) instead of relying
// on DetailsPage having loaded it: a direct reload into a Seerr page otherwise
// renders unstyled until the details chunk is prefetched in idle time.
import '../styles/details.css';

import Page from './Page.js';
import DescriptionModal from '../components/DescriptionModal.js';
import SeerrRequestModal from '../components/SeerrRequestModal.js';
import { RichMetadataTable } from '../components/RichMetadataTable.js';
import { api } from '../api/ApiClient.js';
import { seerr } from '../api/seerrClient.js';
import { renderWatchProviders, watchProviderRegion } from '../utils/WatchProviders.js';
import {
    SEERR_STATUS,
    seerrStatusKey,
    hasUnrequestedSeerrSeasons,
    getSeerrRequestActions,
    seerrDownloadPollDelay,
    describeSeerrDownloadBadge
} from '../api/seerrNormalize.js';
import SeerrDownloadPoller from '../utils/SeerrDownloadPoller.js';
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
import { eventBus } from '../core/EventBus.js';
import { getOverviewClampClass, shouldAlwaysShowOverviewButton, getOverviewButtonText } from '../utils/Utils.js';
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

    render() {
        const detailsLayout = storage.getItem('pref:detailsLayout') || 'posterLeft';
        const layoutClasses = {
            posterRight: 'layout-poster-right',
            backdropMinimal: 'layout-backdrop-minimal',
            backdropLeft: 'layout-backdrop-left'
        };

        // Resolve action tooltips display mode (floating text default, name cards, or hidden)
        const tooltipMode = this._getActionTooltipsMode();
        // Hide tooltips class used for layout adjustments when tooltips are disabled
        const tooltipsClass = tooltipMode === 'hidden' ? 'tooltips-disabled' : '';
        // Modifier class indicating whether floating or card style is active
        const tooltipModeClass = `tooltip-mode-${tooltipMode}`;

        return `
            <div class="page details-page seerr-details-page ${layoutClasses[detailsLayout] || 'layout-poster-left'} ${tooltipsClass} ${tooltipModeClass}">
                <div class="details-backdrop" id="backdrop">
                    <div class="backdrop-gradient"></div>
                </div>
                <div class="details-content page-content">
                    <div class="details-main-split media-row">
                        <div class="hero-poster" id="poster"></div>
                        <div class="details-info-col" id="details-info-col">
                            <div class="hero-info" id="hero-info"></div>
                            <section class="details-actions" id="actions">
                                <button class="btn btn-action btn-primary seerr-play-btn hidden" tabindex="0" data-tooltip="${i18n.t('Play')}">
                                    ${detailsIcons.play}
                                    <span>${i18n.t('Play')}</span>
                                </button>
                                <button class="btn btn-action seerr-jellyfin-btn hidden" tabindex="0" data-tooltip="${i18n.t('SeerrViewInJellyfin') || 'View in Jellyfin'}">
                                    ${detailsIcons.jellyfinDetails}
                                    <span>${i18n.t('SeerrViewInJellyfin')}</span>
                                </button>
                                <button class="btn btn-action seerr-request-btn" tabindex="0" data-tooltip="${i18n.t('SeerrRequest') || 'Request'}">
                                    ${detailsIcons.add}
                                    <span>${i18n.t('SeerrRequest')}</span>
                                </button>
                                <button class="btn btn-action seerr-cancel-request-btn hidden" tabindex="0" data-tooltip="${i18n.t('SeerrCancelRequest') || 'Cancel Request'}">
                                    ${detailsIcons.cancel}
                                    <span>${i18n.t('SeerrCancelRequest')}</span>
                                </button>
                                <button class="btn btn-action seerr-trailer-btn hidden" tabindex="0" data-tooltip="${i18n.t('WatchTrailer') || 'Watch Trailer'}">
                                    ${detailsIcons.trailer}
                                    <span>${i18n.t('WatchTrailer')}</span>
                                </button>
                                <button class="btn btn-action seerr-watchlist-btn" tabindex="0" data-tooltip="${i18n.t('SeerrAddToWatchlist') || 'Add to Watchlist'}">
                                    ${detailsIcons.watchlist}
                                    <span>${i18n.t('SeerrAddToWatchlist')}</span>
                                </button>
                                <div class="action-btn-tooltip-bar style-${tooltipMode}" id="action-tooltip-bar">
                                    <span class="action-btn-tooltip-text" id="action-tooltip-text"></span>
                                </div>
                            </section>
                            <div id="watch-providers-container" class="hidden"></div>
                            <div class="details-overview">
                                <div class="overview-text ${getOverviewClampClass()}" id="overview-text" tabindex="-1"></div>
                                <button class="see-more-btn" tabindex="0" data-i18n="${shouldAlwaysShowOverviewButton() ? 'DetailedView' : 'ShowMore'}">${getOverviewButtonText()}</button>
                            </div>
                        </div>
                    </div>
                    <!-- Note: NOT marked as media-row to prevent aggressive top-snapping on focus -->
                    <div id="rich-meta-container" class="hidden">
                        <div class="details-rich-meta" id="rich-meta"></div>
                    </div>

                    <!-- Cast & Crew -->
                    <section class="details-people media-row hidden" id="seerr-people-section">
                        <h2 class="row-title" data-i18n="HeaderCastAndCrew">${i18n.t('HeaderCastAndCrew')}</h2>
                        <div class="people-row" id="seerr-people-row"></div>
                    </section>

                    <!-- Collection -->
                    <section class="details-collection media-row hidden" id="seerr-collection-section">
                        <h2 class="row-title" id="seerr-collection-title"></h2>
                        <div class="collection-row" id="seerr-collection-row"></div>
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
                </div>
            </div>
        `;
    }

    async onInit() {
        const mediaType = this.params.mediaType === 'tv' || this.params.mediaType === 'series' ? 'tv' : 'movie';
        this._mediaType = mediaType;
        const tmdbId = parseInt(this.params.tmdbId, 10);

        if (!tmdbId) {
            this._showError();
            return;
        }

        // --------------------------------------------------------------------
        // Resolve Seerr admin status up-front so _updateRequestButton can
        // correctly gate the cancel button based on request status.
        //
        // Seerr rules:
        //   - PENDING  → any user can cancel (queued, not yet approved)
        //   - PROCESSING / beyond → only Seerr admins can cancel (approved)
        //
        // We match the current Jellyfin user ID against the Seerr users list
        // and check their permissions bitmask: ADMIN=2, MANAGE_REQUESTS=8192.
        // Defaults to false so non-admins are safe if the fetch fails.
        // --------------------------------------------------------------------
        this._isSeerrAdmin = false;
        seerr
            .getUsers()
            .then((users) => {
                if (!Array.isArray(users)) return;
                const currentJfId = (api.userId || '').replace(/-/g, '').toLowerCase();
                const me = users.find((u) => {
                    const uJfId = (u.jellyfinUserId || '').replace(/-/g, '').toLowerCase();
                    return currentJfId && uJfId && uJfId === currentJfId;
                });
                // Bits: 2 = ADMIN, 8192 = MANAGE_REQUESTS
                this._isSeerrAdmin = !!((me?.permissions || 0) & (2 | 8192));
                // Re-evaluate cancel button visibility now that admin status is known
                this._updateRequestButton();
            })
            .catch(() => {
                /* silently default to non-admin */
            });

        this.setLoading(true);
        try {
            // Always fresh: the response cache (5 min, also filled by Discover card
            // enrichment) can hold an outdated download list, which rendered stale
            // blocks until the first poll replaced them 15 s later.
            this._item = await seerr.details(mediaType, tmdbId, { fresh: true });
            if (this._item) {
                this._item._mediaType = mediaType;
            }
            if (mediaType === 'tv') {
                // Fall back to allowing a request if the season check fails
                const unrequested = await this._loadUnrequestedSeasons();
                this._hasUnrequestedSeasons = unrequested === null ? true : unrequested;
            }
            try {
                this._isWatchlisted = await seerr.isWatchlisted(mediaType, tmdbId);
            } catch (err) {
                log.warn('Unable to load Seerr watchlist state', err);
            }
            this._renderDetails();
            this._bindActions();
            this._setupTooltipListener();
            this._setupDownloadPolling();
            this._registerFocus();
            if (
                this._item._seerrStatus === SEERR_STATUS.AVAILABLE ||
                this._item._seerrStatus === SEERR_STATUS.PARTIALLY_AVAILABLE
            ) {
                void this._checkJellyfinMediaAvailability(mediaType, tmdbId);
            }
            seerr
                .getRatingsCombined(mediaType, tmdbId)
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
        const providersContainer = this.$('#watch-providers-container');
        if (providersContainer) {
            const showProviders = storage.getItem('pref:showWatchProviders') === 'true';
            providersContainer.classList.toggle('hidden', !showProviders);
            providersContainer.innerHTML = showProviders
                ? renderWatchProviders(
                      this._item.WatchProviders,
                      watchProviderRegion(storage.getItem('pref:watchProviderRegion')),
                      (key) => i18n.t(key),
                      i18n.currentLang
                  )
                : '';
        }

        const item = this._item;
        const runtimeMinutes = item.RunTimeTicks ? Math.round(item.RunTimeTicks / 600000000) : 0;
        const runtime = runtimeMinutes
            ? `${Math.floor(runtimeMinutes / 60) ? `${Math.floor(runtimeMinutes / 60)}h ` : ''}${runtimeMinutes % 60}m`
            : '';
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
            item.OfficialRating
                ? `<span class="meta-item meta-badge seerr-content-rating">${escapeHtml(item.OfficialRating)}</span>`
                : '',
            item.CommunityRating
                ? `<span class="meta-item seerr-rating-item seerr-tmdb-rating">${detailsIcons.tmdbRating} ${item.CommunityRating.toFixed(1)}</span>`
                : ''
        ]
            .filter(Boolean)
            .join('');

        const seasonsCount =
            item.NumberOfSeasons ||
            (Array.isArray(item.Seasons) ? item.Seasons.length : null) ||
            (Array.isArray(item.seasons) ? item.seasons.length : null);
        const seasonsLabel =
            (item.Type === 'Series' || this._mediaType === 'tv' || seasonsCount) && seasonsCount
                ? `${seasonsCount} ${seasonsCount === 1 ? i18n.t('Season') || 'Season' : i18n.t('HeaderSeasons') || 'Seasons'}`
                : '';

        const secondaryMeta = [
            this._statusBadgeMarkup(),
            seasonsLabel
                ? `<span class="meta-item seerr-meta-card seerr-seasons-badge">${escapeHtml(seasonsLabel)}</span>`
                : '',
            item.MediaStatus ? `<span class="meta-item seerr-meta-card">${escapeHtml(item.MediaStatus)}</span>` : '',
            item.ReleaseDate ? `<span class="meta-item seerr-meta-card">${escapeHtml(item.ReleaseDate)}</span>` : '',
            item.Budget
                ? `<span class="meta-item seerr-meta-card">Budget: ${formatCompactCurrency(item.Budget)}</span>`
                : '',
            item.Revenue
                ? `<span class="meta-item seerr-meta-card">Revenue: ${formatCompactCurrency(item.Revenue)}</span>`
                : ''
        ]
            .filter(Boolean)
            .join('');

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
        const clampClass = getOverviewClampClass();
        overviewEl.className = `overview-text ${clampClass}`;

        if (item._detailImageUrl) {
            const poster = document.createElement('img');
            poster.alt = item.Name || '';
            poster.addEventListener('load', () => poster.classList.add('loaded'));
            poster.src = item._detailImageUrl;
            this.$('#poster').appendChild(poster);
        }

        if (item._backdropUrl) BackdropManager.applyBackdrop(this.$('#backdrop'), item._backdropUrl);

        // Defaults to 'genres-studios-writers' to avoid hundreds of tag chips on low-end TV chips
        const richMetadataStyle =
            storage.getItem('pref:richMetadataStyle') ||
            (storage.getItem('pref:hideRichMetadata') === 'true' ? 'none' : 'genres-studios-writers');
        const isHidden = richMetadataStyle === 'none';

        this._richMetaTable = new RichMetadataTable({
            container: this.$('#rich-meta'),
            containerWrapper: this.$('#rich-meta-container'),
            onChipClick: (chip) => {
                const name = chip.dataset.name;
                const id = chip.dataset.id;
                const type = chip.dataset.type;
                const mediaType =
                    this._mediaType || this._item?._mediaType || (this.params.mediaType === 'tv' ? 'tv' : 'movie');

                log.info(`Selected Seerr metadata chip: type=${type}, name=${name}, id=${id}, mediaType=${mediaType}`);

                if (type === 'tags' || type === 'tag' || type === 'keywords') {
                    if (id) {
                        router.navigate(
                            `/library/seerr?seerrType=keyword&mediaType=${mediaType}&keywordId=${id}&name=${encodeURIComponent(name)}`
                        );
                    }
                } else if (type === 'genres' || type === 'genre') {
                    if (id) {
                        router.navigate(
                            `/library/seerr?seerrType=genre&mediaType=${mediaType}&genreId=${id}&name=${encodeURIComponent(name)}`
                        );
                    }
                } else if (type === 'studios' || type === 'studio') {
                    if (id) {
                        if (mediaType === 'tv') {
                            router.navigate(
                                `/library/seerr?seerrType=network&networkId=${id}&name=${encodeURIComponent(name)}`
                            );
                        } else {
                            router.navigate(
                                `/library/seerr?seerrType=studio&studioId=${id}&name=${encodeURIComponent(name)}`
                            );
                        }
                    }
                } else if (type === 'networks' || type === 'network') {
                    if (id) {
                        router.navigate(
                            `/library/seerr?seerrType=network&networkId=${id}&name=${encodeURIComponent(name)}`
                        );
                    }
                } else if (
                    type === 'productionteam' ||
                    type === 'production_team' ||
                    type === 'directors' ||
                    type === 'director' ||
                    type === 'writers' ||
                    type === 'writer' ||
                    type === 'crew' ||
                    type === 'person'
                ) {
                    // Navigate directly to the Seerr person details page for the selected crew/team member
                    let personId = id;

                    // Fallback: If person ID was missing on the chip element, look it up in normalized crew data
                    if (!personId && this._item) {
                        const rawCrew =
                            this._item.ProductionTeam ||
                            (this._item.credits && this._item.credits.crew) ||
                            this._item.crew ||
                            [];

                        const found = rawCrew.find((m) => {
                            const memberName = typeof m === 'string' ? m : m && (m.Name || m.name);
                            return memberName && memberName.trim().toLowerCase() === (name || '').trim().toLowerCase();
                        });

                        if (found && (found.Id || found.id)) {
                            personId = found.Id || found.id;
                        }
                    }

                    if (personId) {
                        log.info(
                            `Navigating to Seerr person details page for crew member: personId=${personId}, name=${name}`
                        );
                        router.navigate(`/seerr/person/${personId}`);
                    }
                }
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
        this._updatePlayButton();

        requestAnimationFrame(() => {
            this.$('#details-info-col').classList.add('visible');
            this._checkOverviewTruncation();
        });
    }

    async _checkJellyfinMediaAvailability(mediaType, tmdbId) {
        let jfId = this._item ? this._item._jellyfinMediaId : null;

        // Seerr's serviceId/externalServiceId is NOT guaranteed to be a valid
        // Jellyfin item id. When it is stale (or a Seerr-internal media id), the
        // player navigates to /player/<badId> and Jellyfin answers
        // "GET /Items/<badId> -> 400 The value '<badId>' is not valid", which the
        // UI shows as "Playback Error / HTTP 400". Validate before trusting it.
        if (jfId) {
            try {
                const probe = await api.getItem(jfId);
                if (!probe || !probe.Id) jfId = null;
            } catch (e) {
                log.warn('Seerr media id is not a valid Jellyfin item, resolving by TMDB id instead:', jfId, e);
                jfId = null;
            }
        }

        if (!jfId) {
            try {
                const jfRes = await api.getItems({
                    Recursive: true,
                    IncludeItemTypes: mediaType === 'tv' ? 'Series' : 'Movie',
                    AnyProviderIdEquals: `tmdb.${tmdbId}`,
                    Fields: 'ProviderIds,ProductionYear'
                });
                // api.getItems() resolves to {Items, TotalRecordCount}, not an array.
                const jfItems = jfRes?.Items || (Array.isArray(jfRes) ? jfRes : []);
                if (jfItems.length > 0) {
                    // Never take "the first result": this query is not a strict
                    // filter on every server version. Only an exact TMDB match
                    // may be used, otherwise we would start a different movie.
                    const exact = jfItems.find((item) => {
                        const tmdbVal = item.ProviderIds?.Tmdb || item.ProviderIds?.tmdb;
                        return tmdbVal && String(tmdbVal) === String(tmdbId);
                    });
                    jfId = exact ? exact.Id : null;
                }
            } catch (e) {
                log.debug('Jellyfin media lookup failed for tmdb ID', tmdbId, e);
            }
        }

        if (!jfId && this._item && this._item.Name) {
            try {
                const searchRaw = await api.getItems({
                    Recursive: true,
                    IncludeItemTypes: mediaType === 'tv' ? 'Series' : 'Movie',
                    SearchTerm: this._item.Name,
                    Fields: 'ProviderIds,ProductionYear',
                    Limit: 10
                });
                const searchRes = searchRaw?.Items || (Array.isArray(searchRaw) ? searchRaw : []);
                if (searchRes.length > 0) {
                    const match = searchRes.find((item) => {
                        const tmdbVal = item.ProviderIds?.Tmdb || item.ProviderIds?.tmdb;
                        const tmdbMatch = tmdbVal && String(tmdbVal) === String(tmdbId);
                        const yearMatch =
                            !this._item.ProductionYear || item.ProductionYear === this._item.ProductionYear;
                        return tmdbMatch || yearMatch;
                    });
                    if (match) jfId = match.Id;
                }
            } catch (e) {
                log.debug('Jellyfin fallback title search failed', e);
            }
        }

        if (jfId) {
            this._jellyfinMediaId = jfId;
            this._updatePlayButton();
            this._registerFocus();
        }
    }

    _updatePlayButton() {
        const playBtn = this.$('.seerr-play-btn');
        const jellyfinBtn = this.$('.seerr-jellyfin-btn');
        if (!playBtn) return;

        const isAvailable = !!this._jellyfinMediaId;

        // Play button — shown whenever the Jellyfin media ID is resolved
        playBtn.classList.toggle('hidden', !isAvailable);
        playBtn.tabIndex = isAvailable ? 0 : -1;

        const showJellyfinBtn = isAvailable;
        if (jellyfinBtn) {
            jellyfinBtn.classList.toggle('hidden', !showJellyfinBtn);
            jellyfinBtn.tabIndex = showJellyfinBtn ? 0 : -1;
        }

        focusManager.invalidateCache('seerr-details-actions');
    }

    _updateTrailerButton() {
        const trailerBtn = this.$('.seerr-trailer-btn');
        if (!trailerBtn) return;
        const hasTrailers =
            this._item && Array.isArray(this._item.RemoteTrailers) && this._item.RemoteTrailers.length > 0;
        trailerBtn.classList.toggle('hidden', !hasTrailers);
        trailerBtn.tabIndex = hasTrailers ? 0 : -1;
    }

    _showRemoteTrailerPlayer() {
        themeSongPlayer.stopInstant();
        const mode = PlayerSettings.get('trailerPlaybackMode');
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

        const alwaysShow = shouldAlwaysShowOverviewButton();
        const hasText = Boolean(overviewEl.textContent && overviewEl.textContent.trim().length > 0);
        const isTruncated = overviewEl.scrollHeight > overviewEl.clientHeight + 2;
        const shouldShow = (alwaysShow && hasText) || isTruncated;

        seeMoreBtn.textContent = getOverviewButtonText();
        seeMoreBtn.setAttribute('data-i18n', alwaysShow ? 'DetailedView' : 'ShowMore');
        seeMoreBtn.classList.toggle('hidden', !shouldShow);
        seeMoreBtn.tabIndex = shouldShow ? 0 : -1;
        this._registerFocus();
    }

    async _refreshTvSeasonState() {
        if (this._item._mediaType === 'tv') {
            // Keep the previous answer when the refresh fails
            const unrequested = await this._loadUnrequestedSeasons();
            if (unrequested !== null) this._hasUnrequestedSeasons = unrequested;
        }
        this._updateRequestButton();
        this._renderStatus();
        this._registerFocus();
        focusManager.invalidateCache('seerr-details-actions');
        // A request was created or cancelled: restart polling from the new state
        this._pendingActionUpdate = false;
        if (this._downloadPoller) this._downloadPoller.schedule();
    }

    /**
     * Asks Seerr whether any season of this series can still be requested.
     * @returns {Promise<boolean|null>} null when the season lookup failed
     * @private
     */
    async _loadUnrequestedSeasons() {
        try {
            return hasUnrequestedSeerrSeasons(await seerr.tvSeasons(this._item._tmdbId));
        } catch (err) {
            log.warn('Failed to load TV season statuses', err);
            return null;
        }
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
                this._item._downloads = [];
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
                // 1. Send update to Seerr API
                if (this._isWatchlisted) {
                    await seerr.removeFromWatchlist(this._item);
                } else {
                    await seerr.addToWatchlist(this._item);
                }

                // 2. Toggle local button state and notify user
                this._isWatchlisted = !this._isWatchlisted;
                this._updateWatchlistButton();
                toast.show(i18n.t(this._isWatchlisted ? 'SeerrAddedToWatchlist' : 'SeerrRemovedFromWatchlist'));

                // 3. Clear cached responses and invalidate Discover page so returning to it reflects
                // watchlist updates. Seerr availability did not change, so keep the status cache.
                seerr.clearResponseCache();
            } catch (err) {
                log.warn('Unable to update Seerr watchlist', err);
                toast.show(i18n.t('SeerrWatchlistFailed'));
            } finally {
                button.disabled = false;
            }
        });

        this.$('.seerr-play-btn')?.addEventListener('click', () => {
            if (!this._jellyfinMediaId) return;
            const isTv = this.params.mediaType === 'tv' || this._item?._mediaType === 'tv';
            if (isTv) {
                router.navigate(`/details/${this._jellyfinMediaId}`);
            } else {
                router.navigate(`/player/${this._jellyfinMediaId}/false`);
            }
        });

        // Navigate to the Jellyfin details page — for TV shows this lets the
        // user browse seasons and episodes directly within Jellyfin rather than
        // going straight to the player.
        this.$('.seerr-jellyfin-btn')?.addEventListener('click', () => {
            if (!this._jellyfinMediaId) return;
            router.navigate(`/details/${this._jellyfinMediaId}`);
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
            cardType,
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
            cardType: cardType,
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
                item = virtualRow.items.find(
                    (i) => String(i.Id) === String(cardId) || String(i._tmdbId) === String(cardId)
                );
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
            enterTo: 'first',
            onMove: (direction, currentElement) => {
                if (!currentElement || currentElement.dataset.virtualIndex === undefined) return false;
                const currentIndex = parseInt(currentElement.dataset.virtualIndex, 10);
                const nextNode = virtualRow.handleMove(direction, currentIndex);
                if (nextNode) {
                    virtualRow._hasBeenFocused = true;
                    virtualRow.syncIndexFromNode(nextNode);
                    focusManager.focusElement(nextNode);
                    return true;
                }
                return false;
            },
            onEnter: (fromElement, options) => {
                if (fromElement && options && (options.direction === 'up' || options.direction === 'down')) {
                    const targetIndex = virtualRow._hasBeenFocused ? virtualRow.currentIndex : 0;
                    virtualRow._updateWindow(targetIndex);
                    return virtualRow.domNodes.get(targetIndex);
                }
                return null;
            }
        });

        list.addEventListener('focusin', (e) => {
            if (e.target.classList.contains('media-card')) {
                virtualRow._hasBeenFocused = true;
                virtualRow.syncIndexFromNode(e.target);
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
                cardType: 'person',
                renderCard: (person) => CardRenderer.createCardHtml(person, { type: 'person' }),
                focusSectionName: 'seerr-details-people',
                onClick: (card, person) => {
                    const target =
                        person ||
                        this._item.Cast.find(
                            (p) =>
                                String(p.Id) ===
                                String(card.getAttribute('data-id') || card.dataset.id || card.dataset.itemId)
                        );
                    if (target && target.Id) {
                        const stateKey = `seerr:lastFocusedItem:${this._item._tmdbId}`;
                        if (storage.getItem('pref:disableFocusRestore') !== 'true') {
                            state.set(stateKey, {
                                itemId: target.Id,
                                sectionId: 'seerr-details-people'
                            });
                        }
                        router.navigate(`/seerr/person/${target.Id}`);
                    }
                }
            });
        }

        // 1.5. Collection items (after cast row)
        const collectionObj =
            this._item?.collection ||
            (this._item?.belongsToCollection
                ? { id: this._item.belongsToCollection.id, name: this._item.belongsToCollection.name }
                : null);
        const collectionId = collectionObj?.id || (typeof collectionObj === 'number' ? collectionObj : null);
        if (collectionId) {
            try {
                const colData = await seerr.collection(collectionId);
                if (colData && Array.isArray(colData.items) && colData.items.length > 0) {
                    const colTitle = colData.name || i18n.t('HeaderCollection') || 'Collection';
                    const titleEl = this.$('#seerr-collection-title');
                    if (titleEl) titleEl.textContent = colTitle;

                    this._renderVirtualRow({
                        sectionId: 'seerr-collection-section',
                        listId: 'seerr-collection-row',
                        items: colData.items,
                        isLandscape: false,
                        renderCard: (item) => CardRenderer.createCardHtml(item, { type: 'poster' }),
                        focusSectionName: 'seerr-details-collection',
                        onClick: (card, item) => {
                            const target =
                                item ||
                                colData.items.find(
                                    (i) => String(i.Id) === String(card.getAttribute('data-id') || card.dataset.id)
                                );
                            if (target && target._tmdbId) {
                                const stateKey = `seerr:lastFocusedItem:${this._item._tmdbId}`;
                                if (storage.getItem('pref:disableFocusRestore') !== 'true') {
                                    state.set(stateKey, {
                                        itemId: target.Id || target._tmdbId,
                                        sectionId: 'seerr-details-collection'
                                    });
                                }
                                router.navigate(`/seerr/${target._mediaType || mediaType}/${target._tmdbId}`);
                            }
                        }
                    });
                }
            } catch (e) {
                log.warn('Failed to load Seerr collection items', e);
            }
        }

        // 2. Recommendations
        let recommendedItems =
            this._item && Array.isArray(this._item.Recommendations) ? this._item.Recommendations : [];
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
                    const target =
                        item ||
                        recommendedItems.find(
                            (i) => String(i.Id) === String(card.getAttribute('data-id') || card.dataset.id)
                        );
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
        let similarItems = this._item && Array.isArray(this._item.Similar) ? this._item.Similar : [];
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
                    const target =
                        item ||
                        similarItems.find(
                            (i) => String(i.Id) === String(card.getAttribute('data-id') || card.dataset.id)
                        );
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
        const playBtn = this.$('.seerr-play-btn');
        const hasPlayAction = playBtn && !playBtn.classList.contains('hidden');
        const requestButton = this.$('.seerr-request-btn');
        const hasRequestAction = requestButton && !requestButton.classList.contains('hidden');
        const cancelBtn = this.$('.seerr-cancel-request-btn');
        const hasCancelAction = cancelBtn && !cancelBtn.classList.contains('hidden');
        const trailerBtn = this.$('.seerr-trailer-btn');
        const hasTrailerAction = trailerBtn && !trailerBtn.classList.contains('hidden');
        const hasAction =
            hasPlayAction ||
            hasRequestAction ||
            hasCancelAction ||
            !!this.$('.seerr-watchlist-btn') ||
            hasTrailerAction;

        const hasOverviewAction = !this.$('.see-more-btn')?.classList.contains('hidden');
        const hasRichMeta = !this.$('#rich-meta-container')?.classList.contains('hidden');
        const hasPeople = !this.$('#seerr-people-section')?.classList.contains('hidden');
        const hasCollection = !this.$('#seerr-collection-section')?.classList.contains('hidden');
        const hasRecs = !this.$('#seerr-recommendations-section')?.classList.contains('hidden');
        const hasSimilar = !this.$('#seerr-similar-section')?.classList.contains('hidden');

        const getDownFromActions = () => {
            if (hasOverviewAction) return 'seerr-details-overview';
            if (hasRichMeta) return 'details-rich-meta';
            if (hasPeople) return 'seerr-details-people';
            if (hasCollection) return 'seerr-details-collection';
            if (hasRecs) return 'seerr-details-recommendations';
            if (hasSimilar) return 'seerr-details-similar';
            return null;
        };

        const getDownFromOverview = () => {
            if (hasRichMeta) return 'details-rich-meta';
            if (hasPeople) return 'seerr-details-people';
            if (hasCollection) return 'seerr-details-collection';
            if (hasRecs) return 'seerr-details-recommendations';
            if (hasSimilar) return 'seerr-details-similar';
            return null;
        };

        const getDownFromRichMeta = () => {
            if (hasPeople) return 'seerr-details-people';
            if (hasCollection) return 'seerr-details-collection';
            if (hasRecs) return 'seerr-details-recommendations';
            if (hasSimilar) return 'seerr-details-similar';
            return null;
        };

        const getDownFromPeople = () => {
            if (hasCollection) return 'seerr-details-collection';
            if (hasRecs) return 'seerr-details-recommendations';
            if (hasSimilar) return 'seerr-details-similar';
            return null;
        };

        const updateSection = (name, container, opts) => {
            const existing = focusManager.getSectionConfig(name);
            if (existing) {
                if (opts.leaveUp !== undefined) existing.leaveUp = opts.leaveUp;
                if (opts.leaveDown !== undefined) existing.leaveDown = opts.leaveDown;
                if (opts.leaveLeft !== undefined) existing.leaveLeft = opts.leaveLeft;
                if (opts.orientation !== undefined) existing.orientation = opts.orientation;
                if (opts.enterTo !== undefined) existing.enterTo = opts.enterTo;
            } else if (container) {
                this.registerFocusSection(name, container, opts);
            }
        };

        if (hasAction) {
            updateSection('seerr-details-actions', this.$('#actions'), {
                orientation: 'horizontal',
                leaveLeft: 'sidebar',
                leaveDown: getDownFromActions()
            });
        }

        if (hasOverviewAction) {
            updateSection('seerr-details-overview', this.$('.details-overview'), {
                orientation: 'vertical',
                leaveUp: hasAction ? 'seerr-details-actions' : null,
                leaveDown: getDownFromOverview(),
                leaveLeft: 'sidebar'
            });
        }

        if (hasRichMeta) {
            // Target the table element directly to avoid querying or filtering inactive chips on D-pad moves
            updateSection('details-rich-meta', this.$('#rich-meta-container'), {
                orientation: 'vertical',
                selector: '#rich-meta',
                leaveUp: hasOverviewAction ? 'seerr-details-overview' : hasAction ? 'seerr-details-actions' : null,
                leaveDown: getDownFromRichMeta(),
                leaveLeft: 'sidebar',
                enterTo: 'first'
            });
        }

        if (hasPeople) {
            updateSection('seerr-details-people', this.$('#seerr-people-section'), {
                orientation: 'horizontal',
                leaveUp: hasRichMeta
                    ? 'details-rich-meta'
                    : hasOverviewAction
                      ? 'seerr-details-overview'
                      : hasAction
                        ? 'seerr-details-actions'
                        : null,
                leaveDown: getDownFromPeople(),
                leaveLeft: 'sidebar'
            });
        }

        if (hasCollection) {
            updateSection('seerr-details-collection', this.$('#seerr-collection-section'), {
                orientation: 'horizontal',
                leaveUp: hasPeople
                    ? 'seerr-details-people'
                    : hasRichMeta
                      ? 'details-rich-meta'
                      : hasOverviewAction
                        ? 'seerr-details-overview'
                        : hasAction
                          ? 'seerr-details-actions'
                          : null,
                leaveDown: hasRecs ? 'seerr-details-recommendations' : hasSimilar ? 'seerr-details-similar' : null,
                leaveLeft: 'sidebar'
            });
        }

        if (hasRecs) {
            updateSection('seerr-details-recommendations', this.$('#seerr-recommendations-section'), {
                orientation: 'horizontal',
                leaveUp: hasCollection
                    ? 'seerr-details-collection'
                    : hasPeople
                      ? 'seerr-details-people'
                      : hasRichMeta
                        ? 'details-rich-meta'
                        : hasOverviewAction
                          ? 'seerr-details-overview'
                          : hasAction
                            ? 'seerr-details-actions'
                            : null,
                leaveDown: hasSimilar ? 'seerr-details-similar' : null,
                leaveLeft: 'sidebar'
            });
        }

        if (hasSimilar) {
            updateSection('seerr-details-similar', this.$('#seerr-similar-section'), {
                orientation: 'horizontal',
                leaveUp: hasRecs
                    ? 'seerr-details-recommendations'
                    : hasCollection
                      ? 'seerr-details-collection'
                      : hasPeople
                        ? 'seerr-details-people'
                        : hasRichMeta
                          ? 'details-rich-meta'
                          : hasOverviewAction
                            ? 'seerr-details-overview'
                            : hasAction
                              ? 'seerr-details-actions'
                              : null,
                leaveLeft: 'sidebar'
            });
        }

        if (hasAction) this.setActiveSection('seerr-details-actions');
        else if (hasOverviewAction) this.setActiveSection('seerr-details-overview');
        else if (hasRichMeta) this.setActiveSection('details-rich-meta');
    }

    /**
     * @returns {{requestable: boolean, canCancel: boolean, labelKey: string}}
     * @private
     */
    _getRequestActions() {
        return getSeerrRequestActions(this._item, {
            hasUnrequestedSeasons: this._hasUnrequestedSeasons,
            isAdmin: this._isSeerrAdmin
        });
    }

    _updateRequestButton() {
        const button = this.$('.seerr-request-btn');
        const cancelBtn = this.$('.seerr-cancel-request-btn');
        if (!button) return;

        const { requestable, canCancel, labelKey } = this._getRequestActions();

        // Toggle request button visibility and focus accessibility. Writes are
        // skipped when nothing changed, so a background poll leaves the DOM alone.
        const setTabIndex = (el, value) => {
            if (el.tabIndex !== value) el.tabIndex = value;
        };
        button.classList.toggle('hidden', !requestable);
        setTabIndex(button, requestable ? 0 : -1);

        if (cancelBtn) {
            cancelBtn.classList.toggle('hidden', !canCancel);
            setTabIndex(cancelBtn, canCancel ? 0 : -1);
        }

        // "Request" / "Request More" / "View Request" (see getSeerrRequestActions)
        const span = button.querySelector('span');
        const labelText = i18n.t(labelKey);
        if (span && span.textContent !== labelText) {
            span.textContent = labelText;
        }
        if (button.getAttribute('data-tooltip') !== labelText) {
            button.setAttribute('data-tooltip', labelText);
        }

        // Re-evaluate focus layout for action buttons
        focusManager.invalidateCache('seerr-details-actions');
    }

    _updateWatchlistButton() {
        const btn = this.$('.seerr-watchlist-btn');
        const label = this.$('.seerr-watchlist-btn span');
        const text = i18n.t(this._isWatchlisted ? 'SeerrRemoveFromWatchlist' : 'SeerrAddToWatchlist');
        if (label) label.textContent = text;
        if (btn) btn.setAttribute('data-tooltip', text);
        focusManager.invalidateCache('seerr-details-actions');
    }

    _setupTooltipListener() {
        const tooltipBar = this.$('#action-tooltip-bar');
        const tooltipText = this.$('#action-tooltip-text');
        if (!tooltipBar || !tooltipText) return;

        this._onFocusChangedForTooltip = (focusedEl) => {
            // Check if tooltips mode is active (either floating or cards)
            const tooltipMode = this._getActionTooltipsMode();
            const isEnabled = tooltipMode !== 'hidden';
            const targetEl = focusedEl || document.activeElement;
            if (!isEnabled || !targetEl) {
                tooltipBar.classList.remove('visible');
                return;
            }

            const actionsContainer = this.$('#actions');
            if (actionsContainer && actionsContainer.contains(targetEl)) {
                let text = targetEl.getAttribute('data-tooltip') || targetEl.getAttribute('aria-label');
                if (!text) {
                    const span = targetEl.querySelector('span[data-i18n], span');
                    if (span) text = span.textContent?.trim();
                }

                if (text) {
                    const btnCenterX = targetEl.offsetLeft + targetEl.offsetWidth / 2;
                    const btnBottomY = targetEl.offsetTop + targetEl.offsetHeight;

                    tooltipBar.style.left = `${btnCenterX}px`;
                    // Both styles hang from the focused button, so a wrapped second row gets its own label
                    tooltipBar.style.top = `${btnBottomY}px`;
                    tooltipText.textContent = text;
                    tooltipBar.classList.add('visible');
                    return;
                }
            }

            tooltipBar.classList.remove('visible');
        };

        eventBus.on('focus:changed', this._onFocusChangedForTooltip);

        const actionsContainer = this.$('#actions');
        if (actionsContainer) {
            actionsContainer.addEventListener('mouseover', (e) => {
                const btn = e.target.closest('.btn, button');
                if (btn) this._onFocusChangedForTooltip?.(btn);
            });

            actionsContainer.addEventListener('mouseout', (e) => {
                const related = e.relatedTarget;
                if (!related || !actionsContainer.contains(related)) {
                    const activeInActions = document.activeElement && actionsContainer.contains(document.activeElement);
                    if (activeInActions) {
                        this._onFocusChangedForTooltip?.(document.activeElement);
                    } else {
                        tooltipBar.classList.remove('visible');
                    }
                } else {
                    const newBtn = related.closest('.btn, button');
                    if (newBtn) {
                        this._onFocusChangedForTooltip?.(newBtn);
                    }
                }
            });
        }

        this._tooltipTimers = [];
        const updateInitial = () => {
            if (typeof this._onFocusChangedForTooltip !== 'function') return;
            const actionsContainer = this.$('#actions');
            const targetEl =
                document.activeElement && actionsContainer && actionsContainer.contains(document.activeElement)
                    ? document.activeElement
                    : this.$('#actions .btn-action:not(.hidden)');
            if (targetEl) {
                this._onFocusChangedForTooltip?.(targetEl);
            }
        };
        updateInitial();
        requestAnimationFrame(updateInitial);
        this._tooltipTimers.push(setTimeout(updateInitial, 150));
        this._tooltipTimers.push(setTimeout(updateInitial, 400));
    }

    // ========================================================================
    // Status Badge & Download Progress
    // ========================================================================

    /**
     * Builds the status badge. While Seerr reports a running download the badge
     * mirrors Seerr's own (progress fill, S1E3 / S1 tag, spinner) and appends
     * the ETA of that download: "Downloading S17 · in 2 h 55 min".
     * @returns {string}
     * @private
     */
    _statusBadgeMarkup() {
        const download = describeSeerrDownloadBadge(this._item);
        if (!download) {
            const statusKey = seerrStatusKey(this._item._seerrStatus);
            return statusKey
                ? `<span class="meta-item meta-badge seerr-details-status">${escapeHtml(i18n.t(statusKey))}</span>`
                : '';
        }

        const eta = this._etaText(download.eta);
        const label = [i18n.t('SeerrStatusDownloading'), download.episodeTag].filter(Boolean).join(' ');

        return `<span class="meta-item meta-badge seerr-details-status is-downloading">
                <span class="seerr-status-fill" style="width: ${download.percent}%;"></span>
                <span class="seerr-status-label">${escapeHtml(label)}${eta ? ` · ${escapeHtml(eta)}` : ''}</span>
                <span class="seerr-status-spinner"></span>
            </span>`;
    }

    /**
     * Brings the status badge in line with the current item. A refresh with the
     * same kind of badge only patches the changed text and fill width, so the
     * spinner keeps turning and nothing reflows or flickers every poll.
     * @private
     */
    _renderStatus() {
        const row = this.$('.secondary-meta-row') || this.$('.details-meta-row');
        const markup = this._statusBadgeMarkup();
        const holder = document.createElement('div');
        holder.innerHTML = markup;
        const next = holder.firstElementChild;
        const existing = this.$$('.seerr-details-status');

        if (next && existing.length === 1 && existing[0].className === next.className) {
            this._patchStatusBadge(existing[0], next);
            return;
        }

        // Kind of badge changed (or a stray duplicate exists): replace all of them
        Array.prototype.forEach.call(existing, (el) => el.remove());
        if (row && next) row.insertBefore(next, row.firstChild);
    }

    /**
     * Copies text and fill width from a freshly built badge onto the mounted one,
     * touching the DOM only where a value actually differs.
     * @param {HTMLElement} current
     * @param {HTMLElement} next
     * @private
     */
    _patchStatusBadge(current, next) {
        const nextLabel = next.querySelector('.seerr-status-label');
        if (!nextLabel) {
            if (current.textContent !== next.textContent) current.textContent = next.textContent;
            return;
        }

        const label = current.querySelector('.seerr-status-label');
        if (label && label.textContent !== nextLabel.textContent) label.textContent = nextLabel.textContent;

        const fill = current.querySelector('.seerr-status-fill');
        const nextFill = next.querySelector('.seerr-status-fill');
        if (fill && nextFill && fill.style.width !== nextFill.style.width) fill.style.width = nextFill.style.width;
    }

    /**
     * @param {{hours: number, minutes: number}|null} eta - From describeSeerrDownloadBadge
     * @returns {string} "in 2 h 55 min", or '' when Seerr has no estimate
     * @private
     */
    _etaText(eta) {
        if (!eta) return '';
        return eta.hours > 0
            ? i18n.t('SeerrDownloadInHoursMinutes', [eta.hours, eta.minutes])
            : i18n.t('SeerrDownloadInMinutes', [eta.minutes]);
    }

    // ------------------------------------------------------------------------
    // Polling
    //
    // Hard rule: a poll refresh must never change focus. It only rewrites text
    // and widths on non-focusable nodes, never clears caches that drive focus
    // restoration, and defers hiding a button for as long as it holds focus.
    // ------------------------------------------------------------------------

    /**
     * Starts the download poller and the deferred button update it relies on.
     * @private
     */
    _setupDownloadPolling() {
        this._pendingActionUpdate = false;

        // Apply a deferred button update once focus has left the affected button
        this.on('focus:changed', (focusedEl) => {
            if (this._pendingActionUpdate) this._applyPolledActionState(focusedEl);
        });

        this._downloadPoller = new SeerrDownloadPoller({
            fetch: () => seerr.details(this._mediaType, this._item._tmdbId, { fresh: true }),
            getDelay: () => seerrDownloadPollDelay(this._item),
            isPaused: () => this._isDownloadPollPaused(),
            onUpdate: (fresh, isStale) => this._applyPolledState(fresh, isStale),
            onError: (err) => log.warn('Seerr download progress refresh failed', err)
        });
        this._downloadPoller.schedule();
    }

    /**
     * True while a refresh must not touch the page: hidden app, another page
     * on top, or a modal holding a focus trap.
     * @returns {boolean}
     * @private
     */
    _isDownloadPollPaused() {
        if (typeof document !== 'undefined' && document.hidden) return true;
        // The router may hand out a lazy-loading proxy that wraps this instance
        // (App.js `_realInstance`), so compare against both.
        const current = router.getCurrentPage();
        if (!current || (current !== this && current._realInstance !== this)) return true;
        if (!this.el || !document.body.contains(this.el)) return true;
        return focusManager.isTrapped();
    }

    /**
     * Merges a fresh details response into the page without re-rendering it.
     *
     * Hard rule: a refresh must never change focus. It only patches text and
     * widths on non-focusable nodes and defers hiding a button that holds focus.
     * @param {Object} fresh - Item returned by seerr.details
     * @param {Function} isStale - True once the poller was rescheduled or stopped
     * @private
     */
    async _applyPolledState(fresh, isStale) {
        const previousStatus = this._item._seerrStatus;

        this._item._seerrStatus = fresh._seerrStatus;
        this._item._downloads = fresh._downloads || [];
        this._item._requestId = fresh._requestId || null;
        if (fresh._jellyfinMediaId) this._item._jellyfinMediaId = fresh._jellyfinMediaId;

        this._guardFocus(() => this._renderStatus());

        const statusChanged = previousStatus !== this._item._seerrStatus;
        if (statusChanged && this._item._mediaType === 'tv') {
            // Served from the response cache the fresh details call just filled
            const unrequested = await this._loadUnrequestedSeasons();
            if (isStale()) return;
            if (unrequested !== null) this._hasUnrequestedSeasons = unrequested;
        }

        this._guardFocus(() => this._applyPolledActionState());

        const isPlayable =
            this._item._seerrStatus === SEERR_STATUS.AVAILABLE ||
            this._item._seerrStatus === SEERR_STATUS.PARTIALLY_AVAILABLE;
        if (isPlayable && !this._jellyfinMediaId) {
            // Only ever reveals the play buttons; it does not move focus
            void this._checkJellyfinMediaAvailability(this._mediaType, this._item._tmdbId);
        }
    }

    /**
     * Safety net around a synchronous refresh step: nothing in it may move
     * focus. Kept synchronous on purpose, so focus the user moves themselves
     * (between awaits) is never mistaken for a regression and reverted.
     * @param {Function} update
     * @private
     */
    _guardFocus(update) {
        const focusedBefore = document.activeElement;
        update();
        if (focusedBefore && document.activeElement !== focusedBefore && document.body.contains(focusedBefore)) {
            log.warn('Download refresh changed focus unexpectedly, restoring');
            try {
                focusedBefore.focus({ preventScroll: true });
            } catch (_) {}
        }
    }

    /**
     * Applies request/cancel button visibility after a poll. Hiding a button
     * that currently holds focus would drop focus, so that update waits until
     * the user has moved away (see the focus:changed handler).
     * @param {HTMLElement} [focusedEl] - Newly focused element, when called from focus:changed
     * @private
     */
    _applyPolledActionState(focusedEl) {
        if (!this._item) return;
        const active = focusedEl || document.activeElement;
        const requestBtn = this.$('.seerr-request-btn');
        const cancelBtn = this.$('.seerr-cancel-request-btn');
        const next = this._getRequestActions();

        const wouldHideFocused =
            (active && active === requestBtn && !next.requestable) ||
            (active && active === cancelBtn && !next.canCancel);
        if (wouldHideFocused) {
            this._pendingActionUpdate = true;
            return;
        }

        const wasRequestable = !!requestBtn && !requestBtn.classList.contains('hidden');
        const couldCancel = !!cancelBtn && !cancelBtn.classList.contains('hidden');

        this._pendingActionUpdate = false;
        this._updateRequestButton();
        // Section wiring only needs a refresh when the set of visible buttons changed
        if (wasRequestable !== next.requestable || couldCancel !== next.canCancel) {
            this._registerFocus();
        }
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
        if (this._downloadPoller) {
            this._downloadPoller.stop();
            this._downloadPoller = null;
        }

        if (this._tooltipTimers) {
            this._tooltipTimers.forEach((t) => clearTimeout(t));
            this._tooltipTimers = null;
        }

        if (this._onFocusChangedForTooltip) {
            eventBus.off('focus:changed', this._onFocusChangedForTooltip);
            this._onFocusChangedForTooltip = null;
        }
        BackdropManager.clearBackdrop(this.$('#backdrop'));
        super.destroy();
    }
}

export default SeerrDetailsPage;
