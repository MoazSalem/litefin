/**
 * ============================================================================
 * Litefin Tizen - Jellyseerr Request Modal
 * ============================================================================
 * Detail sheet for a discovery item and request creation. For a series, loads
 * the season list and lets the viewer pick which seasons to request.
 * ============================================================================
 */

import { seerr } from '../api/JellyseerrClient.js';
import { SEERR_STATUS, seerrStatusKey } from '../api/seerrNormalize.js';
import { focusManager } from '../ui/FocusManager.js';
import { router } from '../core/Router.js';
import { toast } from '../ui/Toast.js';
import { i18n } from '../utils/i18n.js';
import { logger } from '../utils/Logger.js';

const log = logger.create('SeerrRequestModal');

const OVERLAY_ID = 'seerr-request-modal';

class SeerrRequestModal {
    /**
     * @param {Object} item - Normalized item (see seerrNormalize)
     * @param {Function} [onRequested] - Called with the new status on success
     */
    static async show(item, onRequested) {
        const existing = document.getElementById(OVERLAY_ID);
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = OVERLAY_ID;
        overlay.className = 'modal-overlay visible';
        document.body.appendChild(overlay);

        const isTv = item._mediaType === 'tv';
        const isAvailable = item._seerrStatus === SEERR_STATUS.AVAILABLE;
        const statusKey = seerrStatusKey(item._seerrStatus);

        overlay.innerHTML = `
            <div class="settings-modal seerr-modal" role="dialog" aria-modal="true">
                <div class="modal-header">
                    <h2>${item.Name}${item.ProductionYear ? ` (${item.ProductionYear})` : ''}</h2>
                </div>
                <div class="modal-options seerr-modal-body">
                    ${statusKey ? `<p class="seerr-modal-status">${i18n.t(statusKey)}</p>` : ''}
                    <p class="seerr-modal-overview">${item.Overview || ''}</p>
                    <div class="seerr-seasons" id="seerr-seasons"></div>
                </div>
                <div class="modal-actions">
                    ${
                        isAvailable
                            ? ''
                            : `<button class="modal-action-btn" id="btn-seerr-request" tabindex="0">${i18n.t('SeerrRequest')}</button>`
                    }
                    <button class="modal-action-btn" id="btn-seerr-close" tabindex="0">${i18n.t('ButtonBack')}</button>
                </div>
            </div>
        `;

        const panel = overlay.querySelector('.seerr-modal');
        // pushTrap locks focus inside the modal and remembers the previous
        // section and element; popTrap restores them.
        focusManager.pushTrap(panel);

        // The remote's hardware Back button is a separate event path from D-pad
        // navigation (FocusManager's trap only blocks Up/Down/Left/Right). Without
        // hijacking the current page's onBack, Back would fall through to page/router
        // navigation while this trap stays registered, stranding focus — the same
        // failure mode MediaInfoModal and DescriptionModal guard against.
        const currentPage = router.getCurrentPage();
        const oldOnBack = currentPage ? currentPage.onBack : null;

        const close = () => {
            if (currentPage && currentPage.onBack === myOnBack) currentPage.onBack = oldOnBack;
            focusManager.popTrap();
            overlay.remove();
        };

        const myOnBack = () => {
            close();
            return true;
        };
        if (currentPage) currentPage.onBack = myOnBack;

        overlay.querySelector('#btn-seerr-close').addEventListener('click', close);

        const requestBtn = overlay.querySelector('#btn-seerr-request');

        // Series: load the seasons
        let selectedSeasons = [];
        if (isTv && !isAvailable) {
            selectedSeasons = await SeerrRequestModal._renderSeasons(overlay, item, requestBtn);
        }

        if (requestBtn) {
            requestBtn.addEventListener('click', async () => {
                if (isTv && selectedSeasons.length === 0) return;
                requestBtn.disabled = true;
                try {
                    await seerr.createRequest({
                        mediaType: item._mediaType,
                        tmdbId: item._tmdbId,
                        seasons: isTv ? selectedSeasons.slice() : undefined
                    });
                    toast.show(i18n.t('SeerrRequestSent'));
                    if (onRequested) onRequested(SEERR_STATUS.PENDING);
                    close();
                } catch (err) {
                    requestBtn.disabled = false;
                    // 409 means Jellyseerr already knows about this request —
                    // not an error from the viewer's point of view.
                    if (err.status === 409) {
                        toast.show(i18n.t('SeerrAlreadyRequested'));
                        if (onRequested) onRequested(SEERR_STATUS.PENDING);
                        close();
                        return;
                    }
                    log.warn('Request failed', err);
                    toast.show(i18n.t('SeerrRequestFailed'));
                }
            });
        }
    }

    /**
     * Loads and renders the season list. Returns the live array of selected
     * season numbers.
     * @returns {Promise<Array<number>>}
     * @private
     */
    static async _renderSeasons(overlay, item, requestBtn) {
        const container = overlay.querySelector('#seerr-seasons');
        const selected = [];

        let seasons = [];
        try {
            seasons = await seerr.tvSeasons(item._tmdbId);
        } catch (err) {
            log.warn('Could not load seasons', err);
            return selected;
        }

        if (seasons.length === 0) return selected;

        // A season already available or already requested cannot be re-requested
        const isLocked = (s) => s.status >= SEERR_STATUS.PENDING;

        container.innerHTML = `
            <button class="seerr-season-row" id="seerr-season-all" tabindex="0">
                ${i18n.t('SeerrAllSeasons')}
            </button>
            ${seasons
                .map(
                    (s) => `
                <button class="seerr-season-row ${isLocked(s) ? 'is-locked' : ''}"
                        data-season="${s.seasonNumber}" tabindex="0" ${isLocked(s) ? 'disabled' : ''}>
                    <span class="seerr-season-name">${s.name}</span>
                    <span class="seerr-season-meta">
                        ${isLocked(s) ? i18n.t(seerrStatusKey(s.status)) : i18n.t('SeerrSeasonEpisodes', [s.episodeCount])}
                    </span>
                </button>
            `
                )
                .join('')}
        `;

        const syncRequestBtn = () => {
            if (requestBtn) requestBtn.disabled = selected.length === 0;
        };
        syncRequestBtn();

        const toggle = (btn, seasonNumber) => {
            const idx = selected.indexOf(seasonNumber);
            if (idx === -1) {
                selected.push(seasonNumber);
                btn.classList.add('is-selected');
            } else {
                selected.splice(idx, 1);
                btn.classList.remove('is-selected');
            }
            syncRequestBtn();
        };

        container.querySelectorAll('.seerr-season-row[data-season]').forEach((btn) => {
            btn.addEventListener('click', () => {
                if (btn.disabled) return;
                toggle(btn, parseInt(btn.dataset.season, 10));
            });
        });

        const allBtn = container.querySelector('#seerr-season-all');
        allBtn.addEventListener('click', () => {
            const selectable = Array.prototype.slice
                .call(container.querySelectorAll('.seerr-season-row[data-season]'))
                .filter((b) => !b.disabled);
            const selectAll = selected.length !== selectable.length;

            selected.length = 0;
            selectable.forEach((b) => {
                b.classList.toggle('is-selected', selectAll);
                if (selectAll) selected.push(parseInt(b.dataset.season, 10));
            });
            syncRequestBtn();
        });

        // Seasons arrive after the initial pushTrap, so the trap has to pick up
        // the newly focusable elements.
        focusManager.invalidateCache('__trap__');

        return selected;
    }
}

export default SeerrRequestModal;
