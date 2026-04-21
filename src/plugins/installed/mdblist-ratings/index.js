/**
 * ============================================================================
 * Litefin Tizen - MDBList Ratings Plugin
 * ============================================================================
 * Fetches ratings from the MDBList server plugin and injects them into
 * the Details page.
 * ============================================================================
 */

import './mdblist-ratings.css';

export default {
    id: 'mdblist-ratings',
    name: 'MDBList Ratings',
    description: 'Displays comprehensive ratings (IMDB, RT, etc.) from MDBList.',
    version: '1.4.0',
    serverDependency: 'mdblist-ratings',
    defaultEnabled: false,

    async init(api) {
        this.api = api;
        this.log = api.log;
        this.log.info('MDBList Ratings plugin initialized');
    },

    async onPageLoad(pageId, pageEl, api) {
        if (pageId !== 'details') return;

        // Extract itemId from the route hash (#/details/12345)
        const match = window.location.hash.match(/#\/details\/([a-zA-Z0-9-]+)/);
        if (!match) return;

        const itemId = match[1];
        this.log.info(`Details page loaded for item ${itemId}, fetching MDBList ratings...`);

        try {
            // Using correct endpoint based on MdbListRatings Controller
            const data = await api.serverPlugins.call(`/Plugins/MdbListRatings/CachedByItemId?itemId=${itemId}`);
            if (data && data.ratings && data.ratings.length > 0) {
                const tryRender = () => {
                    const metaRow = pageEl.querySelector('.details-meta-row');
                    if (metaRow) {
                        this._renderRatingsRow(pageEl, data.ratings);
                        return true;
                    }
                    return false;
                };

                if (!tryRender()) {
                    this._observer = new MutationObserver((mutations, obs) => {
                        if (tryRender()) {
                            obs.disconnect();
                            this._observer = null;
                        }
                    });
                    this._observer.observe(pageEl, { childList: true, subtree: true });
                }
            }
        } catch (err) {
            this.log.warn('Failed to fetch MDBList ratings:', err);
        }
    },

    onPageUnload(pageId, api) {
        if (pageId === 'details' && this._observer) {
            this._observer.disconnect();
            this._observer = null;
        }
    },

    _renderRatingsRow(pageEl, ratings) {
        const metaRow = pageEl.querySelector('.details-meta-row');
        if (!metaRow) return;

        // Hide default standard ratings (star and tomato)
        const defaultStar = metaRow.querySelector('.meta-star');
        if (defaultStar) defaultStar.style.display = 'none';
        const defaultTomato = metaRow.querySelector('.meta-tomato');
        if (defaultTomato) defaultTomato.style.display = 'none';

        // Check if our row already exists to prevent duplicates
        if (pageEl.querySelector('.mdblist-ratings-row')) return;

        // Base URL for plugin assets
        const assetBase = `${this.api.serverUrl}/Plugins/MdbListRatings/Assets/`;

        // Build items
        let html = '<div class="mdblist-ratings-row" tabindex="-1">';

        for (const rating of ratings) {
            if (rating.value === null || rating.value === undefined) continue;

            const provider = this._getProviderInfo(rating.source, rating.value);
            const formattedValue = provider.format ? provider.format(rating.value) : rating.value;

            // Determine if we use an <img> or an emoji fallback
            let iconHtml = '';
            if (provider.assetName) {
                const iconUrl = `${assetBase}${provider.assetName}`;
                iconHtml = `<img src="${iconUrl}" class="mdblist-rating-icon" alt="${rating.source}" />`;
            } else {
                iconHtml = `<span class="mdblist-rating-icon star-emoji">⭐</span>`;
            }

            html += `
                <div class="mdblist-item">
                    <span class="provider-icon ${provider.className}">
                        ${iconHtml}
                    </span>
                    <span class="mdblist-value">${formattedValue}</span>
                </div>
            `;
        }

        html += '</div>';

        // Inject below the meta row
        metaRow.insertAdjacentHTML('afterend', html);

        // Add subtle entrance animation
        requestAnimationFrame(() => {
            const row = pageEl.querySelector('.mdblist-ratings-row');
            if (row) {
                row.classList.add('visible');
            }
        });
    },

    _getProviderInfo(source, value) {
        const s = source ? source.toLowerCase() : '';
        const score = parseFloat(value);

        if (s === 'imdb') {
            return { className: 'icon-imdb', assetName: 'IMDb.png' };
        }
        if (s === 'tomatoes') {
            const assetName = score < 60 ? 'Rotten_Tomatoes_rotten.png' : 'Rotten_Tomatoes.png';
            return { className: 'icon-rt', assetName, format: (v) => `${v}%` };
        }
        if (s === 'tomatoesaudience' || s === 'popcorn') {
            const assetName =
                score < 60 ? 'Rotten_Tomatoes_negative_audience.png' : 'Rotten_Tomatoes_positive_audience.png';
            return { className: 'icon-rt-aud', assetName, format: (v) => `${v}%` };
        }
        if (s === 'metacritic') {
            return { className: 'icon-metacritic', assetName: 'Metacritic.png' };
        }
        if (s === 'metacriticuser') {
            // Server plugin uses the same icon for metacritic and metacriticuser
            return { className: 'icon-metacritic-user', assetName: 'Metacritic.png' };
        }
        if (s === 'metacriticms') {
            return { className: 'icon-metacritic-ms', assetName: 'metacriticms.png' };
        }
        if (s === 'letterboxd') {
            return {
                className: 'icon-letterboxd',
                assetName: 'letterboxd.png',
                format: (v) => parseFloat(v).toFixed(1)
            };
        }
        if (s === 'trakt') {
            return { className: 'icon-trakt', assetName: 'Trakt.png', format: (v) => `${Math.round(v)}%` };
        }
        if (s === 'tmdb') {
            return { className: 'icon-tmdb', assetName: 'TMDB.png', format: (v) => `${Math.round(v)}%` };
        }
        if (s === 'kinopoisk') {
            return { className: 'icon-kinopoisk', assetName: 'kinopoisk.png' };
        }
        if (s === 'myanimelist' || s === 'mal') {
            return { className: 'icon-mal', assetName: 'mal.png' };
        }
        if (s === 'anilist') {
            return { className: 'icon-anilist', assetName: 'anilist.png' };
        }
        if (s === 'tvmaze') {
            return { className: 'icon-tvmaze', assetName: 'tvmaze.png' };
        }
        if (s === 'rogerebert') {
            return { className: 'icon-rogerebert', assetName: 'Roger_Ebert.png' };
        }

        return { className: 'icon-default', assetName: null }; // Uses fallback emoji
    }
};
