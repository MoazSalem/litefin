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
                                    <span>${i18n.t('SeerrRequest')}</span>
                                </button>
                                <button class="btn btn-action seerr-cancel-request-btn hidden" tabindex="0">
                                    <span>${i18n.t('SeerrCancelRequest')}</span>
                                </button>
                                <button class="btn btn-action seerr-watchlist-btn" tabindex="0">
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
        } catch (err) {
            log.warn('Unable to load Seerr details', err);
            this._showError();
        } finally {
            this.setLoading(false);
            this.markReady();
            this.restoreScrollFocusWhenReady();
        }
    }

    _renderDetails() {
        const item = this._item;
        const runtimeMinutes = item.RunTimeTicks ? Math.round(item.RunTimeTicks / 600000000) : 0;
        const runtime = runtimeMinutes
            ? `${Math.floor(runtimeMinutes / 60) ? `${Math.floor(runtimeMinutes / 60)}h ` : ''}${runtimeMinutes % 60}m`
            : '';
        const statusKey = seerrStatusKey(item._seerrStatus);
        const meta = [
            item.ProductionYear ? `<span class="meta-item">${item.ProductionYear}</span>` : '',
            runtime ? `<span class="meta-item">${runtime}</span>` : '',
            item.CommunityRating
                ? `<span class="meta-item meta-star">${detailsIcons.ratingStar}${item.CommunityRating.toFixed(1)}</span>`
                : '',
            statusKey
                ? `<span class="meta-item meta-badge seerr-details-status">${escapeHtml(i18n.t(statusKey))}</span>`
                : ''
        ].join('');

        this.$('#hero-info').innerHTML = `
            <h1 class="details-title" style="max-width: 100%;">${escapeHtml(i18n.ensureBiDi(item.Name))}</h1>
            ${item.Tagline ? `<p class="details-tagline">${escapeHtml(item.Tagline)}</p>` : ''}
            <div class="details-meta-row">${meta}</div>
        `;

        this.$('#overview-text').textContent = item.Overview || '';
        this.$('.see-more-btn').classList.toggle('hidden', !item.Overview);
        this.$('.see-more-btn').tabIndex = item.Overview ? 0 : -1;

        if (item._detailImageUrl) {
            const poster = document.createElement('img');
            poster.alt = item.Name || '';
            poster.addEventListener('load', () => poster.classList.add('loaded'));
            poster.src = item._detailImageUrl;
            this.$('#poster').appendChild(poster);
        }

        if (item._backdropUrl) BackdropManager.applyBackdrop(this.$('#backdrop'), item._backdropUrl);

        this._richMetaTable = new RichMetadataTable({
            container: this.$('#rich-meta'),
            containerWrapper: this.$('#rich-meta-container'),
            onChipClick: (chip) => {
                const name = chip.dataset.name;
                log.info(`Selected genre chip: ${name}`);
            }
        });

        const htmlParts = [];
        if (item.Genres && item.Genres.length > 0) {
            htmlParts.push(RichMetadataTable.createChipRow('Genres', item.Genres));
        }
        if (item.Studios && item.Studios.length > 0) {
            htmlParts.push(RichMetadataTable.createChipRow('Studios', item.Studios));
        }
        if (item.Tags && item.Tags.length > 0) {
            htmlParts.push(RichMetadataTable.createChipRow('Tags', item.Tags));
        }
        this._richMetaTable.render(htmlParts.join(''));

        this.$('#details-info-col').classList.add('visible');
        this._updateRequestButton();
        this._updateWatchlistButton();
    }

    _bindActions() {
        this.$('.seerr-request-btn')?.addEventListener('click', () => {
            SeerrRequestModal.show(this._item, (newStatus, requestId) => {
                this._item._seerrStatus = newStatus;
                if (requestId) this._item._requestId = requestId;
                this._updateRequestButton();
                this._renderStatus();
                this._registerFocus();
                focusManager.invalidateCache('seerr-details-actions');
                const overviewButton = this.$('.see-more-btn:not(.hidden)');
                if (overviewButton) {
                    this.setActiveSection('seerr-details-overview');
                    focusManager.focusElement(overviewButton);
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
                this._hasUnrequestedSeasons = true;
                this._updateRequestButton();
                this._renderStatus();
                this._registerFocus();
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

    _registerFocus() {
        const requestButton = this.$('.seerr-request-btn');
        const hasRequestAction = requestButton && !requestButton.classList.contains('hidden');
        const cancelBtn = this.$('.seerr-cancel-request-btn');
        const hasCancelAction = cancelBtn && !cancelBtn.classList.contains('hidden');
        const hasAction = hasRequestAction || hasCancelAction || !!this.$('.seerr-watchlist-btn');
        const hasOverviewAction = !this.$('.see-more-btn')?.classList.contains('hidden');
        const hasRichMeta = !this.$('#rich-meta-container')?.classList.contains('hidden');

        if (hasAction) {
            this.registerFocusSection('seerr-details-actions', this.$('#actions'), {
                orientation: 'horizontal',
                leaveLeft: 'sidebar',
                leaveDown: hasOverviewAction ? 'seerr-details-overview' : (hasRichMeta ? 'details-rich-meta' : null)
            });
        }
        if (hasOverviewAction) {
            this.registerFocusSection('seerr-details-overview', this.$('.details-overview'), {
                orientation: 'vertical',
                leaveUp: hasAction ? 'seerr-details-actions' : null,
                leaveDown: hasRichMeta ? 'details-rich-meta' : null,
                leaveLeft: 'sidebar'
            });
        }
        if (hasRichMeta) {
            this.registerFocusSection('details-rich-meta', this.$('#rich-meta-container'), {
                orientation: 'vertical',
                leaveUp: hasOverviewAction ? 'seerr-details-overview' : (hasAction ? 'seerr-details-actions' : null),
                leaveLeft: 'sidebar',
                enterTo: 'first'
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
    }

    _renderStatus() {
        const statusKey = seerrStatusKey(this._item._seerrStatus);
        const row = this.$('.details-meta-row');
        const oldStatus = row?.querySelector('.seerr-details-status');
        if (oldStatus) oldStatus.remove();
        if (!row || !statusKey) return;

        const status = document.createElement('span');
        status.className = 'meta-item meta-badge seerr-details-status';
        status.textContent = i18n.t(statusKey);
        row.appendChild(status);
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
