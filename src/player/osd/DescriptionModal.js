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
import { api } from '../../api/index.js';
import { pluginManager } from '../../plugins/PluginManager.js';
import { storage } from '../../utils/StorageService.js';
import { detailsIcons } from '../../utils/Icons.js';

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
        const starRating = item.CommunityRating && shouldShowScore(item) ? `${detailsIcons.ratingStar}${item.CommunityRating.toFixed(1)}` : '';
        const criticScore = item.CriticRating
            ? (String(item.CriticRating).endsWith('%') ? item.CriticRating : `${Math.round(item.CriticRating)}%`)
            : '';
        const criticRating = item.CriticRating && shouldShowScore(item) ? `${detailsIcons.rottenTomatoesFresh}${criticScore}` : '';

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

                    <div id="description-mdb-row" class="description-modal__mdb-row"></div>

                    ${tagline ? `<p class="description-modal__tagline">${tagline}</p>` : ''}
                    
                    <div class="description-modal__overview" tabindex="-1">${overview}</div>
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

        // Load premium ratings in the background
        this._loadMdbRatings();
    }

    /**
     * Fetch and render MDBList ratings if the plugin is enabled.
     * @private
     */
    async _loadMdbRatings() {
        const item = this._item;
        if (!item || !shouldShowScore(item)) return;

        // Check if MDBList integration is enabled in settings (reusing carousel toggle for now)
        if (storage.getItem('pref:heroCarouselMdbList') === 'false') return;

        // Get plugin
        const pluginEntry = pluginManager.getPlugin('mdblist-ratings');
        if (!pluginEntry || !pluginEntry.enabled || !pluginEntry.plugin) return;

        try {
            // Fetch metadata (ratings only, no awards for compact modal)
            const imdbId = item.ProviderIds?.Imdb || item.ProviderIds?.imdb;
            const data = await pluginEntry.plugin.getItemMetadata(item.Id, imdbId, false);

            if (data && data.ratings && data.ratings.length > 0) {
                const row = this.$el.querySelector('#description-mdb-row');
                if (!row) return;

                let html = '';
                const assetBase = `${api.serverUrl}/Plugins/MdbListRatings/Assets/`;

                for (const rating of data.ratings) {
                    if (rating.value === null || rating.value === undefined) continue;

                    const provider = this._getMdbProviderInfo(rating.source, rating.value);
                    const formattedValue = provider.format ? provider.format(rating.value) : rating.value;

                    if (provider.assetName) {
                        const iconUrl = `${assetBase}${provider.assetName}`;
                        html += `
                            <div class="description-modal__mdb-item">
                                <img src="${iconUrl}" class="description-modal__mdb-icon" alt="" />
                                <span class="description-modal__mdb-value">${formattedValue}</span>
                            </div>
                        `;
                    }
                }

                if (html) {
                    row.innerHTML = html;
                    row.classList.add('visible');
                }
            }
        } catch (err) {
            console.warn('Failed to load MDB ratings for DescriptionModal:', err);
        }
    }

    /**
     * Helper to get provider info for MDBList ratings (reused from HeroCarousel logic).
     * @private
     */
    _getMdbProviderInfo(source, value) {
        const s = source ? source.toLowerCase() : '';
        const score = parseFloat(value);

        if (s === 'imdb') {
            return { assetName: 'IMDb.png' };
        }
        if (s === 'tomatoes') {
            const assetName = score < 60 ? 'Rotten_Tomatoes_rotten.png' : 'Rotten_Tomatoes.png';
            return { assetName, format: (v) => `${v}%` };
        }
        if (s === 'tomatoesaudience' || s === 'popcorn') {
            const assetName =
                score < 60 ? 'Rotten_Tomatoes_negative_audience.png' : 'Rotten_Tomatoes_positive_audience.png';
            return { assetName, format: (v) => `${v}%` };
        }
        if (s === 'metacritic') {
            return { assetName: 'Metacritic.png' };
        }
        if (s === 'trakt') {
            return { assetName: 'Trakt.png', format: (v) => `${Math.round(v)}%` };
        }
        if (s === 'tmdb') {
            return { 
                assetName: 'TMDB.png', 
                format: (v) => {
                    const num = parseFloat(v);
                    return (num > 10 ? num / 10 : num).toFixed(1);
                }
            };
        }
        if (s === 'letterboxd') {
            return { assetName: 'letterboxd.png', format: (v) => parseFloat(v).toFixed(1) };
        }

        return { assetName: null };
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
