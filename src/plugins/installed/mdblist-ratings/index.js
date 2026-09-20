/**
 * ============================================================================
 * Litefin Tizen - MDBList Ratings Plugin
 * ============================================================================
 * Fetches ratings from the MDBList server plugin and injects them into
 * the Details page.
 * ============================================================================
 */

import './mdblist-ratings.css';
import { shouldShowScore } from '../../../utils/visibility.js';
import { storage } from '../../../utils/StorageService.js';
import { getMdbProviderInfo, formatRatingValue } from './ratingsFormatter.js';

export default {
    id: 'mdblist-ratings',
    name: 'MDBList Ratings',
    description: 'Displays comprehensive ratings (IMDB, RT, etc.) from MDBList.',
    version: '1.5.0',
    serverDependency: 'mdblist-ratings',
    defaultEnabled: false,

    async init(api) {
        this.api = api;
        this.log = api.log;
        this._awardsEnabledOnServer = true; // Default to true until checked
        this.log.info('MDBList Ratings plugin initialization started');

        // Check if awards are enabled on the server configuration
        // We await this to ensure capability is resolved before any metadata calls occur
        await this._checkAwardsCapability(api);
        this.log.info('MDBList Ratings plugin initialization complete');
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
            this.log.debug(
                'Could not fetch server plugin config (expected for non-admins), probing endpoint instead...'
            );
            try {
                // If this endpoint exists, the plugin version supports awards
                // We use AwardsDefinitions as a safe, no-side-effect probe
                await api.serverPlugins.call('/Plugins/MdbListRatings/AwardsDefinitions');
                this._awardsEnabledOnServer = true;
            } catch (err) {
                // If 404, the server plugin is an old version that doesn't support awards
                if (err.status === 404) {
                    this._awardsEnabledOnServer = false;
                    this.log.info(
                        'Server-side Awards API not found (legacy plugin version). Awards will not be loaded.'
                    );
                }
            }
        }
    },

    /**
     * Public method to fetch ratings and awards for a specific item.
     * Used by external components like the Hero Carousel.
     *
     * @param {string} itemId - Jellyfin item ID
     * @param {string} [imdbId] - Optional IMDb ID if already known
     * @param {boolean} [includeAwards=true] - Whether to fetch awards metadata
     * @returns {Promise<{ ratings: Array, badges: Array, features: Object|null, imdbId: string }>}
     */
    async getItemMetadata(itemId, imdbId = null, includeAwards = true) {
        try {
            // 1. Try to get IDs, ratings, and features from MDBList cache
            const data = await this.api.serverPlugins.call(`/Plugins/MdbListRatings/CachedByItemId?itemId=${itemId}`);

            // 2. Resolve IMDb ID only if awards are requested (to avoid wasteful fallback API calls)
            let finalImdbId = null;
            if (includeAwards) {
                finalImdbId = imdbId || data?.ids?.imdb || data?.ids?.Imdb;
                if (!finalImdbId) {
                    try {
                        const itemInfo = await this.api.getItem(itemId);
                        finalImdbId = itemInfo?.ProviderIds?.Imdb || itemInfo?.ProviderIds?.imdb;
                    } catch (e) {
                        this.log.warn('Could not fetch IMDb ID from Jellyfin for metadata request:', e);
                    }
                }
            }

            // 3. Fetch awards if we have an IMDb ID and requested
            let awards = null;
            const userWantsAwards = storage.getItem('pref:showMdbAwards') !== 'false';
            if (includeAwards && finalImdbId && this._awardsEnabledOnServer !== false && userWantsAwards) {
                try {
                    const awardsData = await this.api.serverPlugins.call(
                        `/Plugins/MdbListRatings/AwardsByImdb?imdbId=${finalImdbId}`
                    );
                    if (awardsData && awardsData.hasAwards) {
                        awards = awardsData.badges || [];
                    }
                } catch (e) {
                    this.log.debug(`Awards fetch skipped or failed for ${finalImdbId}`);
                }
            }

            return {
                ratings: data && data.hasCache ? data.ratings || [] : [],
                badges: awards || [],
                features: data?.whatsonFeatures || data?.whatson_features || null,
                imdbId: finalImdbId
            };
        } catch (err) {
            this.log.warn(`MDBList Plugin metadata fetch failed for ${itemId}:`, err);
            return { ratings: [], badges: [], features: null, imdbId };
        }
    },

    async onPageLoad(pageId, pageEl, api) {
        if (pageId !== 'details') return;

        // Extract itemId from the route hash (#/details/12345)
        const match = window.location.hash.match(/#\/details\/([a-zA-Z0-9-]+)/);
        if (!match) return;

        const itemId = match[1];

        try {
            // Use the public method to get metadata
            const userWantsAwards = storage.getItem('pref:showMdbAwards') !== 'false';
            const metadata = await this.getItemMetadata(itemId, null, userWantsAwards);

            const tryRender = () => {
                const metaRow = pageEl.querySelector('.details-meta-row');
                if (metaRow) {
                    // Render Ratings Row (Respect Score Visibility / Mystery Mode)
                    const item = api.getCurrentItem();
                    if (metadata.ratings.length > 0 && shouldShowScore(item)) {
                        this._renderRatingsRow(pageEl, metadata.ratings, metadata.features);
                    }

                    // Render Awards Row
                    if (metadata.badges.length > 0) {
                        this._renderAwardsRow(pageEl, metadata.badges);
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
            this.log.warn('MDBList PageLoad interaction failed:', err);
        }
    },

    onPageUnload(pageId, api) {
        if (pageId === 'details') {
            if (this._observer) {
                this._observer.disconnect();
                this._observer = null;
            }
            // Rows are in the page lifecycle, so they'll be destroyed with the page
        }
    },

    async _fetchAndRenderAwards(pageEl, imdbId, retryCount = 0) {
        // Skip if awards are explicitly disabled or unsupported on the server, or locally
        const userWantsAwards = storage.getItem('pref:showMdbAwards') !== 'false';
        if (this._awardsEnabledOnServer === false || !userWantsAwards) {
            return;
        }

        try {
            // Wait for DOM and server stability
            const delay = retryCount === 0 ? 800 : 3000;
            await new Promise((r) => setTimeout(r, delay));

            this.log.info(`Fetch Awards attempt ${retryCount + 1}/2 for ${imdbId}`);
            const data = await this.api.serverPlugins.call(`/Plugins/MdbListRatings/AwardsByImdb?imdbId=${imdbId}`);

            if (data && data.hasAwards && data.badges && data.badges.length > 0) {
                this._renderAwardsRow(pageEl, data.badges);
            } else if (retryCount < 1) {
                // Total 2 attempts
                this._fetchAndRenderAwards(pageEl, imdbId, retryCount + 1);
            }
        } catch (err) {
            this.log.warn('Awards fetch failed:', err);
        }
    },

    /**
     * Renders all resolved ratings on the Details page.
     *
     * @param {HTMLElement} pageEl - Container page element
     * @param {Array} ratings - Array of rating objects
     * @param {Object} [features] - Extra metadata features (e.g. IMDb Top 250)
     */
    _renderRatingsRow(pageEl, ratings, features = null) {
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
            // Resolve formatted provider info using centralized formatter
            const provider = getMdbProviderInfo(
                rating.source || rating.Source,
                rating.value !== undefined ? rating.value : rating.Value,
                rating.score !== undefined ? rating.score : rating.Score,
                features
            );

            // Skip if formatting failed
            if (!provider || !provider.formattedText) continue;

            // Determine if we use an <img> or an emoji fallback
            let iconHtml = '';
            if (provider.assetName) {
                const iconUrl = `${assetBase}${provider.assetName}`;
                // Include onerror handler to fall back to a clean star emoji if the server lacks the asset (e.g. older 10.xx plugin)
                iconHtml = `<img src="${iconUrl}" class="mdblist-rating-icon" alt="${provider.displayName}" onerror="this.onerror=null;this.parentElement.innerHTML='<span class=\\'mdblist-rating-icon star-emoji\\'>⭐</span>';" />`;
            } else {
                iconHtml = `<span class="mdblist-rating-icon star-emoji">⭐</span>`;
            }

            html += `
                <div class="mdblist-item" title="${provider.displayName}: ${provider.formattedText}">
                    <span class="provider-icon ${provider.className}">
                        ${iconHtml}
                    </span>
                    <span class="mdblist-value">${provider.formattedText}</span>
                </div>
            `;
        }

        html += '</div>';

        // Inject below techRow if present, otherwise below metaRow
        const techRow = pageEl.querySelector('.details-tech-row');
        const targetRow = techRow || metaRow;
        targetRow.insertAdjacentHTML('afterend', html);

        // Add subtle entrance animation with Apple HIG spring curve
        requestAnimationFrame(() => {
            const row = pageEl.querySelector('.mdblist-ratings-row');
            if (row) {
                row.classList.add('visible');
            }
        });
    },

    /**
     * Backward-compatible helper method pointing to shared formatter.
     */
    _getProviderInfo(source, value, score = null) {
        return getMdbProviderInfo(source, value, score);
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

        // Inject below ratings row if present, otherwise techRow if present, otherwise metaRow
        const techRow = pageEl.querySelector('.details-tech-row');
        const targetRow = ratingsRow || techRow || metaRow;
        targetRow.insertAdjacentHTML('afterend', html);

        // Entrance animation
        requestAnimationFrame(() => {
            const row = pageEl.querySelector('.mdblist-awards-row');
            if (row) row.classList.add('visible');
        });
    }
};
