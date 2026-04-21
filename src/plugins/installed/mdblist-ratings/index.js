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
        this._awardsEnabledOnServer = true; // Default to true until checked
        this.log.info('MDBList Ratings plugin initialized');

        // Check if awards are enabled on the server configuration
        this._checkAwardsCapability(api);
    },

    /**
     * Check if the server-side plugin supports and has enabled awards.
     */
    async _checkAwardsCapability(api) {
        try {
            // MDBList Ratings Server Plugin ID
            const pluginId = 'ab96f8b5-45ef-44be-81d6-99bc01e26b9d';
            const config = await api.serverPlugins.call(`/Plugins/${pluginId}/Configuration`);
            
            if (config && config.EnableWebAwardBadges === false) {
                this._awardsEnabledOnServer = false;
                this.log.info('Awards are disabled in server plugin configuration. Skipping awards integration.');
            } else {
                this._awardsEnabledOnServer = true;
            }
        } catch (e) {
            // If we can't fetch config (likely 403 for non-admins), we'll probe the endpoint instead
            this.log.debug('Could not fetch server plugin config (expected for non-admins), probing endpoint instead...');
            try {
                // If this endpoint exists, the plugin version supports awards
                // We use AwardsDefinitions as a safe, no-side-effect probe
                await api.serverPlugins.call('/Plugins/MdbListRatings/AwardsDefinitions');
                this._awardsEnabledOnServer = true;
            } catch (err) {
                // If 404, the server plugin is an old version that doesn't support awards
                if (err.status === 404) {
                    this._awardsEnabledOnServer = false;
                    this.log.info('Server-side Awards API not found (legacy plugin version). Awards will not be loaded.');
                }
            }
        }
    },

    async onPageLoad(pageId, pageEl, api) {
        if (pageId !== 'details') return;

        // Extract itemId from the route hash (#/details/12345)
        const match = window.location.hash.match(/#\/details\/([a-zA-Z0-9-]+)/);
        if (!match) return;

        const itemId = match[1];
        try {
            // 1. Try to get IDs and ratings from MDBList cache
            const data = await api.serverPlugins.call(`/Plugins/MdbListRatings/CachedByItemId?itemId=${itemId}`);
            
            let imdbId = data?.ids?.imdb || data?.ids?.Imdb;

            // 2. Fallback: If MDBList plugin doesn't have the item in cache, ask Jellyfin directly for the IMDb ID
            if (!imdbId) {
                try {
                    const itemInfo = await api.getItem(itemId);
                    imdbId = itemInfo?.ProviderIds?.Imdb || itemInfo?.ProviderIds?.imdb;
                } catch (e) {
                    this.log.warn('Could not fetch IMDb ID from Jellyfin primary metadata:', e);
                }
            }

            const tryRender = () => {
                const metaRow = pageEl.querySelector('.details-meta-row');
                if (metaRow) {
                    // Render Ratings (requires cache)
                    if (data && data.hasCache && data.ratings && data.ratings.length > 0) {
                        this._renderRatingsRow(pageEl, data.ratings);
                    }

                    // Fetch Awards (only requires IMDb ID)
                    if (imdbId) {
                        this._fetchAndRenderAwards(pageEl, imdbId);
                    }
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
        } catch (err) {
            this.log.warn('MDBList Plugin interaction failed:', err);
        }
    },

    onPageUnload(pageId, api) {
        if (pageId === 'details') {
            if (this._observer) {
                this._observer.disconnect();
                this._observer = null;
            }
            // Rows are in the page lifecycle, so they'll be destroyed with the page,
            // but we can help by removing them if they are persisted in a cached view.
        }
    },

    async _fetchAndRenderAwards(pageEl, imdbId, retryCount = 0) {
        // Skip if awards are explicitly disabled or unsupported on the server
        if (this._awardsEnabledOnServer === false) {
            return;
        }

        try {
            // Wait for DOM and server stability
            const delay = retryCount === 0 ? 800 : 3000;
            await new Promise(r => setTimeout(r, delay));

            this.log.info(`Fetch Awards attempt ${retryCount + 1}/2 for ${imdbId}`);
            const data = await this.api.serverPlugins.call(`/Plugins/MdbListRatings/AwardsByImdb?imdbId=${imdbId}`);
            
            if (data && data.hasAwards && data.badges && data.badges.length > 0) {
                this._renderAwardsRow(pageEl, data.badges);
            } else if (retryCount < 1) { // Total 2 attempts
                this._fetchAndRenderAwards(pageEl, imdbId, retryCount + 1);
            }
        } catch (err) {
            this.log.warn('Awards fetch failed:', err);
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
    },

    _renderAwardsRow(pageEl, badges) {
        if (pageEl.querySelector('.mdblist-awards-row')) return;

        const metaRow = pageEl.querySelector('.details-meta-row');
        if (!metaRow) return;

        const ratingsRow = pageEl.querySelector('.mdblist-ratings-row');
        const assetBase = `${this.api.serverUrl}/Plugins/MdbListRatings/Assets/`;
        let html = '<div class="mdblist-awards-row" tabindex="-1">';

        for (const badge of badges) {
            const iconUrl = `${assetBase}${badge.iconFile || badge.IconFile}`;
            const name = badge.name || badge.Name;
            const tooltip = badge.tooltip || badge.Tooltip || name;

            html += `
                <div class="award-item" title="${tooltip}">
                    <div class="award-icon icon-${badge.key || badge.Key}">
                        <img src="${iconUrl}" class="mdblist-award-icon" alt="${name}" />
                    </div>
                </div>
            `;
        }

        html += '</div>';

        // Inject below ratings row if present, otherwise directly below metaRow
        if (ratingsRow) {
            ratingsRow.insertAdjacentHTML('afterend', html);
        } else {
            metaRow.insertAdjacentHTML('afterend', html);
        }

        // Entrance animation
        requestAnimationFrame(() => {
            const row = pageEl.querySelector('.mdblist-awards-row');
            if (row) row.classList.add('visible');
        });
    }
};
