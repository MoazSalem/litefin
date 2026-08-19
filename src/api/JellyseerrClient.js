/**
 * ============================================================================
 * Litefin Tizen - Seerr Server Plugin Client
 * ============================================================================
 * Talks to Seerr through the authenticated Litefin Jellyfin server plugin.
 * The Seerr URL and API key stay on the server; the TV only uses its existing
 * Jellyfin session through ApiClient.
 * ============================================================================
 */

import { logger } from '../utils/Logger.js';
import { i18n } from '../utils/i18n.js';
import { storage } from '../utils/StorageService.js';
import { api } from './ApiClient.js';
import { normalizeSeerrItem, seerrStatusKey } from './seerrNormalize.js';

const log = logger.create('JellyseerrClient');
const API_ROOT = '/Litefin/Seerr';

/**
 * Attaches the ready-to-render status badge to a normalized item.
 * @param {Object} item - Item produced by normalizeSeerrItem
 * @returns {Object} The same item, mutated and returned for chaining
 */
export function decorateStatusBadge(item) {
    const key = seerrStatusKey(item._seerrStatus);
    item._statusBadge = key ? { label: i18n.t(key), variant: `seerr-${item._seerrStatus}` } : null;
    return item;
}

export class JellyseerrClient {
    constructor() {
        this._status = null;
        this._clearedLegacyCredentials = false;
        this._cache = new Map();
        this._cacheTtlMs = 5 * 60 * 1000;
    }

    /**
     * Clears all cached network responses.
     */
    clearCache() {
        this._cache.clear();
    }

    /** Last known server-side configuration state. */
    get isConfigured() {
        return !!(this._status && this._status.configured && this._status.available);
    }

    /**
     * Probes the Litefin server plugin and caches its public Seerr status.
     * @param {boolean} [force=false]
     * @returns {Promise<{configured: boolean, available: boolean}>}
     */
    async status(force = false) {
        if (!this._clearedLegacyCredentials) {
            ['seerr:url', 'seerr:apikey', 'seerr:userid', 'seerr:username'].forEach((key) => storage.removeItem(key));
            this._clearedLegacyCredentials = true;
        }

        if (this._status && !force) return this._status;

        try {
            const payload = await api.get(`${API_ROOT}/Status`);
            this._status = {
                configured: !!payload?.configured,
                available: !!payload?.available
            };
        } catch (err) {
            log.debug('Litefin Seerr plugin endpoint is unavailable', err);
            this._status = { configured: false, available: false };
        }

        return this._status;
    }

    /**
     * Makes an authenticated call through the Litefin server plugin.
     * @param {string} path - Path after /Litefin/Seerr
     * @param {Object} [options] - Request method and body
     * @returns {Promise<any>}
     * @private
     */
    async _request(path, options = {}) {
        const method = options.method || 'GET';
        log.debug(`${method} ${path}`);

        try {
            if (method === 'POST') {
                this.clearCache();
                return await api.post(`${API_ROOT}${path}`, options.body);
            }
            if (method === 'DELETE') {
                this.clearCache();
                return await api.delete(`${API_ROOT}${path}`);
            }

            const now = Date.now();
            const cached = this._cache.get(path);
            if (cached && now - cached.timestamp < this._cacheTtlMs) {
                return cached.data;
            }

            const data = await api.get(`${API_ROOT}${path}`);
            this._cache.set(path, { data, timestamp: now });
            return data;
        } catch (err) {
            log.warn(`Request failed: ${method} ${path}`, err);
            throw err;
        }
    }

    /** @private */
    _resultsOf(payload) {
        if (Array.isArray(payload)) return payload;
        if (payload && Array.isArray(payload.results)) return payload.results;
        return [];
    }

    /** @private */
    _normalizeList(payload) {
        return this._resultsOf(payload)
            .filter((result) => result && result.mediaType !== 'person')
            .map(normalizeSeerrItem)
            .filter((item) => item !== null)
            .map((item) => decorateStatusBadge(item));
    }

    async discoverTrending() {
        return this._normalizeList(await this._request('/Discover/Trending'));
    }

    async discoverMovies(page = 1) {
        return this._normalizeList(await this._request(`/Discover/Movies?page=${page}`));
    }

    async discoverTv(page = 1) {
        return this._normalizeList(await this._request(`/Discover/Tv?page=${page}`));
    }

    /**
     * @param {string} query
     * @param {number} [page=1]
     * @returns {Promise<Array<Object>>}
     */
    async search(query, page = 1) {
        const path = `/Search?query=${encodeURIComponent(query)}&page=${page}`;
        return this._normalizeList(await this._request(path));
    }

    /**
     * Gets the full details used by the Seerr details page.
     * @param {string} mediaType
     * @param {number} tmdbId
     * @returns {Promise<Object>}
     */
    async details(mediaType, tmdbId) {
        const type = mediaType === 'tv' ? 'Tv' : 'Movie';
        const result = await this._request(`/${type}/${tmdbId}`);
        const item = normalizeSeerrItem(result, mediaType);
        if (!item) throw new Error('SeerrInvalidResponse');
        return decorateStatusBadge(item);
    }

    async similar(mediaType, tmdbId, page = 1) {
        const type = mediaType === 'tv' ? 'Tv' : 'Movie';
        try {
            const raw = await this._request(`/${type}/${tmdbId}/similar?page=${page}`);
            const list = this._resultsOf(raw);
            return list
                .filter((r) => r && r.mediaType !== 'person')
                .map((r) => normalizeSeerrItem(r, mediaType))
                .filter(Boolean)
                .map(decorateStatusBadge);
        } catch (e) {
            log.warn(`Failed to fetch similar for ${mediaType} ${tmdbId}`, e);
            return [];
        }
    }

    async recommendations(mediaType, tmdbId, page = 1) {
        const type = mediaType === 'tv' ? 'Tv' : 'Movie';
        try {
            const raw = await this._request(`/${type}/${tmdbId}/recommendations?page=${page}`);
            const list = this._resultsOf(raw);
            return list
                .filter((r) => r && r.mediaType !== 'person')
                .map((r) => normalizeSeerrItem(r, mediaType))
                .filter(Boolean)
                .map(decorateStatusBadge);
        } catch (e) {
            log.warn(`Failed to fetch recommendations for ${mediaType} ${tmdbId}`, e);
            return [];
        }
    }

    /**
     * Gets requestable seasons of a series.
     * @param {number} tmdbId
     * @returns {Promise<Array<{seasonNumber: number, name: string, episodeCount: number, status: number}>>}
     */
    async tvSeasons(tmdbId) {
        const detail = await this._request(`/Tv/${tmdbId}`);
        const seasons = (detail && detail.seasons) || [];
        const seasonStatuses = {};

        const infoSeasons = (detail && detail.mediaInfo && detail.mediaInfo.seasons) || [];
        infoSeasons.forEach((season) => {
            const sNum = season.seasonNumber ?? season.season_number;
            if (sNum != null) {
                seasonStatuses[Number(sNum)] = season.status ?? 0;
            }
        });

        const requests = (detail && detail.mediaInfo && detail.mediaInfo.requests) || [];
        requests.forEach((req) => {
            const reqSeasons = req.seasons || [];
            reqSeasons.forEach((s) => {
                const sNum = s.seasonNumber ?? s.season_number;
                if (sNum != null) {
                    const numKey = Number(sNum);
                    if (!seasonStatuses[numKey] || seasonStatuses[numKey] === 0) {
                        seasonStatuses[numKey] = s.status || req.status || 2;
                    }
                }
            });
        });

        return seasons
            .filter((season) => (season.seasonNumber ?? season.season_number) > 0)
            .map((season) => {
                const sNum = Number(season.seasonNumber ?? season.season_number);
                const status = seasonStatuses[sNum] || season.status || season.mediaInfo?.status || 0;
                return {
                    seasonNumber: sNum,
                    name: season.name || `Season ${sNum}`,
                    episodeCount: season.episodeCount ?? season.episode_count ?? 0,
                    status: status
                };
            });
    }

    /**
     * Creates a request attributed server-side to the authenticated Jellyfin user.
     * @param {Object} params
     * @param {string} params.mediaType
     * @param {number} params.tmdbId
     * @param {Array<number>} [params.seasons]
     * @returns {Promise<Object>}
     */
    async createRequest({ mediaType, tmdbId, seasons, serverId, profileId, rootFolder, languageProfileId, is4k }) {
        const body = { mediaType, mediaId: tmdbId };
        if (mediaType === 'tv') body.seasons = seasons || [];
        if (serverId != null) body.serverId = serverId;
        if (profileId != null) body.profileId = profileId;
        if (rootFolder) body.rootFolder = rootFolder;
        if (languageProfileId != null) body.languageProfileId = languageProfileId;
        body.is4k = !!is4k;
        log.info(`Requesting ${mediaType} ${tmdbId}${seasons ? ` seasons ${seasons.join(',')}` : ''}`);
        return this._request('/Requests', { method: 'POST', body });
    }

    async cancelRequest(requestId) {
        return this._request(`/Requests/${requestId}`, { method: 'DELETE' });
    }

    async getRatingsCombined(mediaType, tmdbId) {
        try {
            return await this._request(`/Ratings/${mediaType}/${tmdbId}`);
        } catch (err) {
            log.warn(`Failed to fetch ratings for ${mediaType} ${tmdbId}`, err);
            return null;
        }
    }

    async requestOptions(mediaType) {
        const user = await this._request('/User');
        if (!((user.permissions || 0) & (2 | 8192))) return null;
        const servers = await this._request(`/Services/${mediaType}`);
        const details = await Promise.all(
            servers.map((server) => this._request(`/Services/${mediaType}/${server.id}`))
        );
        return { servers, details };
    }

    /**
     * Enriches a list of normalized Seerr items with full TMDB details (poster image, overview, title)
     * if any item is missing its poster image URL.
     * @param {Array<Object>} items
     * @returns {Promise<Array<Object>>}
     * @private
     */
    async _enrichSeerrItems(items) {
        if (!Array.isArray(items) || items.length === 0) return [];

        const enriched = await Promise.all(
            items.map(async (item) => {
                if (!item) return null;
                // If item already has poster image URL and title, return as-is
                if (item._imageUrl && item.Name) return item;

                try {
                    // Fetch full details which populates _imageUrl, _backdropUrl, Name, Overview, etc.
                    const detail = await this.details(item._mediaType, item._tmdbId);
                    if (detail) {
                        return {
                            ...detail,
                            _seerrStatus: item._seerrStatus !== 0 ? item._seerrStatus : detail._seerrStatus,
                            _requestId: item._requestId || detail._requestId
                        };
                    }
                } catch (err) {
                    log.warn(`Failed to enrich Seerr item details for ${item._mediaType} ${item._tmdbId}`, err);
                }
                return item;
            })
        );
        return enriched.filter(Boolean);
    }

    /**
     * Gets user requests from Seerr with automatic route fallback.
     * @param {number} [take=20]
     * @param {number} [skip=0]
     * @param {string} [filter='all']
     * @returns {Promise<Array<Object>>}
     */
    async requests(take = 20, skip = 0, filter = 'all') {
        let payload = null;
        // Fallback route chain: /request -> /Request -> /Requests
        try {
            payload = await this._request(`/request?take=${take}&skip=${skip}&filter=${filter}`);
        } catch (err1) {
            if (err1.status === 404) {
                try {
                    payload = await this._request(`/Request?take=${take}&skip=${skip}&filter=${filter}`);
                } catch (err2) {
                    if (err2.status === 404) {
                        payload = await this._request(`/Requests?take=${take}&skip=${skip}&filter=${filter}`);
                    } else {
                        throw err2;
                    }
                }
            } else {
                throw err1;
            }
        }

        const rawList = this._resultsOf(payload);
        const items = rawList
            .map((req) => {
                if (!req) return null;
                const media = req.media || req;
                const tmdbId = media.tmdbId || media.id || req.tmdbId || req.id;
                if (!tmdbId) return null;

                const item = normalizeSeerrItem({
                    ...media,
                    id: tmdbId,
                    mediaType: media.mediaType || req.type || (req.type === 1 ? 'movie' : req.type === 2 ? 'tv' : 'movie'),
                    mediaInfo: media.mediaInfo || media,
                    requests: media.requests || [req]
                });
                return item;
            })
            .filter(Boolean)
            .map((item) => decorateStatusBadge(item));

        return this._enrichSeerrItems(items);
    }

    /**
     * Gets user watchlist from Seerr with detail enrichment for poster images.
     * @param {number} [page=1]
     * @returns {Promise<Array<Object>>}
     */
    async watchlist(page = 1) {
        let payload = null;
        // Fallback route chain: /Watchlist -> /watchlist
        try {
            payload = await this._request(`/Watchlist?page=${page}`);
        } catch (err1) {
            if (err1.status === 404) {
                payload = await this._request(`/watchlist?page=${page}`);
            } else {
                throw err1;
            }
        }

        const rawList = this._resultsOf(payload);
        const items = rawList
            .map((entry) => {
                if (!entry) return null;
                const tmdbId = entry.tmdbId || entry.mediaId || entry.id;
                if (!tmdbId) return null;

                const item = normalizeSeerrItem({
                    ...entry,
                    id: tmdbId,
                    mediaType: entry.mediaType
                });
                return item;
            })
            .filter(Boolean)
            .map((item) => decorateStatusBadge(item));

        return this._enrichSeerrItems(items);
    }

    /**
     * Gets recently added media items from Seerr.
     * @param {number} [take=20]
     * @returns {Promise<Array<Object>>}
     */
    async recentlyAdded(take = 20) {
        let payload = null;
        try {
            payload = await this._request(`/RecentlyAdded?take=${take}`);
        } catch (err1) {
            if (err1.status === 404) {
                payload = await this._request(`/Media?take=${take}`);
            } else {
                throw err1;
            }
        }

        const rawList = this._resultsOf(payload);
        const items = rawList
            .map((entry) => {
                if (!entry) return null;
                const tmdbId = entry.tmdbId || entry.mediaId || entry.id;
                if (!tmdbId) return null;

                const item = normalizeSeerrItem({
                    ...entry,
                    id: tmdbId,
                    mediaType: entry.mediaType
                });
                return item;
            })
            .filter(Boolean)
            .map((item) => decorateStatusBadge(item));

        return this._enrichSeerrItems(items);
    }

    async isWatchlisted(mediaType, tmdbId) {
        const payload = await this._request('/Watchlist');
        return this._resultsOf(payload).some(
            (entry) => Number(entry.mediaId || entry.tmdbId) === Number(tmdbId) && entry.mediaType === mediaType
        );
    }

    async addToWatchlist(item) {
        return this._request('/Watchlist', {
            method: 'POST',
            body: { mediaId: item._tmdbId, tmdbId: item._tmdbId, mediaType: item._mediaType, title: item.Name }
        });
    }

    async removeFromWatchlist(item) {
        return this._request(`/Watchlist/${item._mediaType}/${item._tmdbId}`, { method: 'DELETE' });
    }
}

export const seerr = new JellyseerrClient();
