/**
 * ============================================================================
 * DescriptionModal
 * ============================================================================
 * Side-panel modal that displays full item description and metadata.
 * Stripped down version of the Details page for quick access during playback.
 * ============================================================================
 */

import BaseMenu from './BaseMenu.js';
import { i18n } from '../../utils/i18n.js';
import { shouldShowScore } from '../../utils/visibility.js';

export default class DescriptionModal extends BaseMenu {

    constructor(osdController) {
        super(osdController);
        this.isModal = true;
        this._item = null;
    }

    /**
     * Open the description modal.
     * @param {Object} item - The current media item.
     */
    open(item) {
        this._item = item;
        this.render();
        
        // Capture previous focus state
        this._prevRow = this.osd._currentFocusRow;
        this._prevIndex = this.osd._currentFocusIndex;

        this.show();
        
        /* Ignore Enter keys for 300ms after opening to prevent double-triggering */
        this._openedAt = Date.now();
        
        /* Focus the content for scrolling */
        requestAnimationFrame(() => {
            this.updateFocus();
        });
    }

    render() {
        if (this.$el) {
            this.$el.remove();
            this.$el = null;
        }

        const item = this._item;
        if (!item) return;

        /* Build meta items (Year, Runtime, Ratings) - Reused logic from DetailsPage */
        const year = item.ProductionYear || '';
        let runtimeText = '';

        if (item.RunTimeTicks) {
            const totalMinutes = Math.round(item.RunTimeTicks / 600000000);
            const hours = Math.floor(totalMinutes / 60);
            const minutes = totalMinutes % 60;
            runtimeText = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
        }

        const rating = item.OfficialRating;
        const starRating = item.CommunityRating && shouldShowScore(item) ? `★ ${item.CommunityRating.toFixed(1)}` : '';
        const criticRating = item.CriticRating && shouldShowScore(item) ? `🍅 ${item.CriticRating}` : '';

        let metaHtml = '';
        if (year) metaHtml += `<span class="description-modal__meta-item">${year}</span>`;
        if (runtimeText) metaHtml += `<span class="description-modal__meta-item">${runtimeText}</span>`;
        if (rating) metaHtml += `<span class="description-modal__meta-item description-modal__meta-badge">${rating}</span>`;
        if (starRating) metaHtml += `<span class="description-modal__meta-item description-modal__meta-star">${starRating}</span>`;
        if (criticRating) metaHtml += `<span class="description-modal__meta-item description-modal__meta-tomato">${criticRating}</span>`;

        const isSeason = item.Type === 'Season';
        const displayTitle = i18n.ensureBiDi(isSeason ? item.SeriesName || item.Name : item.Name);
        const displaySubtitle = i18n.ensureBiDi(
            isSeason ? item.Name : item.OriginalTitle && item.OriginalTitle !== item.Name ? item.OriginalTitle : ''
        );

        const tagline = item.Taglines && item.Taglines.length > 0 ? item.Taglines[0] : '';
        const overview = item.Overview || '';

        const overlay = document.createElement('div');
        overlay.className = 'description-modal-overlay';

        overlay.innerHTML = `
            <div class="description-modal">
                <div class="description-modal__content" tabindex="0">
                    <h1 class="description-modal__title">${displayTitle}</h1>
                    ${displaySubtitle && displaySubtitle !== displayTitle ? `<h2 class="description-modal__original-title">${displaySubtitle}</h2>` : ''}
                    
                    ${item.Type === 'Episode' ? `
                        <p class="description-modal__episode-info">
                            ${i18n.ensureBiDi(`S${(item.ParentIndexNumber || 0).toString().padStart(2, '0')}E${(item.IndexNumber || 0).toString().padStart(2, '0')} - ${item.SeriesName}`)}
                        </p>
                    ` : ''}

                    <div class="description-modal__meta-row">
                        ${metaHtml}
                    </div>

                    ${tagline ? `<p class="description-modal__tagline">${tagline}</p>` : ''}
                    
                    <p class="description-modal__overview">${overview}</p>
                </div>
                <div class="description-modal__footer">
                    Press Back or OK to Resume
                </div>
            </div>
        `;

        const overlaysEl = this.osd._osdEl.querySelector('.osd-overlays');
        if (overlaysEl) {
            overlaysEl.appendChild(overlay);
        }

        this.$el = overlay;
    }

    handleKey(key) {
        const content = this.$el ? this.$el.querySelector('.description-modal__content') : null;
        if (!content) return false;

        switch (key) {
            case 'up':
                content.scrollTop -= 100;
                return true;
            case 'down':
                content.scrollTop += 100;
                return true;
            case 'enter':
                /* DEBOUNCE: Ignore Enter keys fired immediately after opening.
                 * This prevents the same press that opened the OSD button from closing us. */
                if (this._openedAt && (Date.now() - this._openedAt < 300)) {
                    return true;
                }
            case 'back':
                this.osd.closeMenu();
                return true;
            default:
                return false;
        }
    }

    updateFocus() {
        if (!this.$el) return;
        const content = this.$el.querySelector('.description-modal__content');
        if (content) {
            content.focus();
        }
    }

    show() {
        super.show();
    }

    hide() {
        if (!this.isVisible) return;
        this.isVisible = false;
        
        if (this.$el) {
            this.$el.classList.remove('visible');
            this.$el.classList.add('hidden');
        }
        
        // Restore focus to wherever it was before opening
        if (this._prevRow !== undefined) {
            this.osd._currentFocusRow = this._prevRow;
            this.osd._currentFocusIndex = this._prevIndex;
            this.osd._updateFocus();
        }
    }
}
