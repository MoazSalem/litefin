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
import { seerr } from '../api/JellyseerrClient.js';
import { SEERR_STATUS, seerrStatusKey } from '../api/seerrNormalize.js';
import BackdropManager from '../utils/BackdropManager.js';
import { focusManager } from '../ui/FocusManager.js';
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
                                <button class="btn btn-primary seerr-request-btn" tabindex="0">
                                    <span>${i18n.t('SeerrRequest')}</span>
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

        if (item.Genres.length > 0) {
            this.$('#rich-meta').innerHTML =
                `<strong>${i18n.t('Genres')}:</strong> ${escapeHtml(item.Genres.join(', '))}`;
            this.$('#rich-meta-container').classList.remove('hidden');
        }

        this.$('#details-info-col').classList.add('visible');
        this._updateRequestButton();
    }

    _bindActions() {
        this.$('.seerr-request-btn')?.addEventListener('click', () => {
            SeerrRequestModal.show(this._item, (newStatus) => {
                this._item._seerrStatus = newStatus;
                this._updateRequestButton();
                this._renderStatus();
                const overviewButton = this.$('.see-more-btn:not(.hidden)');
                if (overviewButton) {
                    this.setActiveSection('seerr-details-overview');
                    focusManager.focusElement(overviewButton);
                }
            });
        });

        this.$('.see-more-btn')?.addEventListener('click', () => {
            DescriptionModal.show(
                { title: escapeHtml(this._item.Name), overview: escapeHtml(this._item.Overview) },
                this
            );
        });
    }

    _registerFocus() {
        const requestButton = this.$('.seerr-request-btn');
        const hasRequestAction = requestButton && !requestButton.classList.contains('hidden');
        const hasOverviewAction = !this.$('.see-more-btn')?.classList.contains('hidden');

        if (hasRequestAction) {
            this.registerFocusSection('seerr-details-actions', this.$('#actions'), {
                orientation: 'horizontal',
                leaveLeft: 'sidebar',
                leaveDown: hasOverviewAction ? 'seerr-details-overview' : null
            });
        }
        if (hasOverviewAction) {
            this.registerFocusSection('seerr-details-overview', this.$('.details-overview'), {
                orientation: 'vertical',
                leaveUp: hasRequestAction ? 'seerr-details-actions' : null,
                leaveLeft: 'sidebar'
            });
        }

        if (hasRequestAction) this.setActiveSection('seerr-details-actions');
        else if (hasOverviewAction) this.setActiveSection('seerr-details-overview');
    }

    _updateRequestButton() {
        const button = this.$('.seerr-request-btn');
        if (!button) return;
        const requestable =
            this._item._seerrStatus === SEERR_STATUS.NOT_REQUESTED ||
            this._item._seerrStatus === SEERR_STATUS.PARTIALLY_AVAILABLE;
        button.classList.toggle('hidden', !requestable);
        button.tabIndex = requestable ? 0 : -1;
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
