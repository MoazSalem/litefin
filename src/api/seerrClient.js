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
import { state } from '../core/StateManager.js';
import { api } from './ApiClient.js';
import { eventBus } from '../core/EventBus.js';
import { normalizeSeerrItem, seerrStatusKey, SEERR_STATUS, setTmdbImageResolver, tmdbUrl } from './seerrNormalize.js';
import { buildGenreSliderItems, buildStudioItems, buildNetworkItems } from '../utils/seerrGenres.js';

const log = logger.create('SeerrClient');
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

export class SeerrClient {
    constructor() {
        this._status = null;
        this._statusPromise = null;
        this._clearedLegacyCredentials = false;
        this._cache = new Map();
        this._cacheTtlMs = 5 * 60 * 1000;

        /*
         * The image base is resolved each time a URL is built rather than copied
         * once, so it always matches the current status and server. A status
         * cached for another server never routes images to that server's proxy.
         */
        setTmdbImageResolver(() => {
            const s = this._currentStatus();
            return s && s.imageProxy && api.serverUrl ? `${api.serverUrl}/Litefin/Seerr/Image` : null;
        });
    }

    /**
     * Returns the cached status only when it was probed against the current server.
     * @returns {Object|null}
     * @private
     */
    _currentStatus() {
        const s = this._status;
        return s && s.serverUrl === api.serverUrl ? s : null;
    }

    /**
     * Clears cached API responses without resetting companion service status.
     */
    clearResponseCache() {
        // Clear in-memory HTTP response cache for Seerr requests
        this._cache.clear();

        // Invalidate DiscoverPage rendered rows cache so navigating back displays fresh data
        state.delete('discover:pageCache');
    }

    /**
     * Clears all cached network responses and resets companion service status.
     */
    clearCache() {
        // Clear cached request responses and Discover page row states
        this.clearResponseCache();

        // Reset in-memory and session status cache
        this._status = null;
        if (typeof sessionStorage !== 'undefined') {
            try {
                sessionStorage.removeItem('seerr:session_status');
            } catch (_) {}
        }
    }

    /** Last known server-side configuration state. */
    get isConfigured() {
        return !!(this._status && this._status.configured && this._status.available);
    }

    /**
     * Probes the Litefin server plugin and caches its public Seerr status once per session.
     * @param {boolean} [force=false]
     * @returns {Promise<{configured: boolean, available: boolean}>}
     */
    async status(force = false) {
        if (!this._clearedLegacyCredentials) {
            ['seerr:url', 'seerr:apikey', 'seerr:userid', 'seerr:username'].forEach((key) => storage.removeItem(key));
            this._clearedLegacyCredentials = true;
        }

        // When forcing a refresh, bust memory and session storage caches
        if (force) {
            this._status = null;
            if (typeof sessionStorage !== 'undefined') {
                try {
                    sessionStorage.removeItem('seerr:session_status');
                } catch (_) {}
            }
        }

        if (!force && this._currentStatus()) return this._status;

        // In-flight deduplication: return active shared probe promise
        if (!force && this._statusPromise) {
            return this._statusPromise;
        }

        // Check session-level cache to ensure probe occurs once per session
        if (!force && typeof sessionStorage !== 'undefined') {
            try {
                const sessionCached = sessionStorage.getItem('seerr:session_status');
                if (sessionCached) {
                    const parsed = JSON.parse(sessionCached);
                    // Only honor cached status if Seerr was previously verified as available on this server
                    if (parsed && parsed.available && parsed.serverUrl === api.serverUrl) {
                        this._status = parsed;
                        return this._status;
                    }
                }
            } catch (_) {}
        }

        /*
         * Wrap probing routine inside a shared promise to prevent multiple components
         * (e.g. Sidebar, Search, Discover) from dispatching duplicate concurrent network probes.
         */
        this._statusPromise = (async () => {
            // First check if companion plugin is already known to be available
            let isLitefinAvailable = api._hasLitefinServerPlugin;
            if (isLitefinAvailable === null || isLitefinAvailable === undefined) {
                isLitefinAvailable = await api.isLitefinPluginAvailable();
            }

            // If companion server plugin is confirmed not present, return early
            if (!isLitefinAvailable) {
                this._status = { configured: false, available: false, serverUrl: api.serverUrl };
                return this._status;
            }

            try {
                // Bound the Seerr status probe to 8 seconds so an unresponsive or sleeping
                // upstream Seerr instance fails fast while allowing reverse-proxy handshake latency
                const payload = await api.get(
                    `${API_ROOT}/Status`,
                    {},
                    { silent: true, warnOnError: true, timeout: 8000 }
                );

                this._status = {
                    configured: !!payload?.configured,
                    available: !!payload?.available,
                    // Newer server plugins serve Seerr's TMDB image cache (airgapped clients)
                    imageProxy: !!payload?.imageProxy,
                    serverUrl: api.serverUrl
                };

                // When payload is received successfully, mark companion plugin as active
                if (payload) {
                    api._hasLitefinServerPlugin = true;
                }

                // Only cache successful status in sessionStorage to allow retries on transient boot failures
                if (this._status.available && typeof sessionStorage !== 'undefined') {
                    try {
                        sessionStorage.setItem('seerr:session_status', JSON.stringify(this._status));
                    } catch (_) {}
                }

                // Notify all components that seerr availability is now resolved so they
                // can update their UI without an additional probe round-trip
                eventBus.emit('seerr:statusResolved', this._status);
            } catch (err) {
                // Do NOT cache failure in this._status — the request may have failed due to
                // an auth race condition (sidebar probing before session is fully restored).
                // Leaving this._status null allows the next caller to retry cleanly.
                log.debug('Litefin Seerr plugin endpoint is unavailable or not yet ready', err);
                return { configured: false, available: false };
            } finally {
                this._statusPromise = null;
            }

            return this._status;
        })();

        return this._statusPromise;
    }

    /**
     * Asynchronously checks if Seerr is configured and available (cached once per session).
     * @param {boolean} [force=false]
     * @returns {Promise<boolean>}
     */
    async isAvailable(force = false) {
        const s = await this.status(force);
        return !!(s && s.configured && s.available);
    }

    /**
     * Resolves the active user interface language formatted for TMDB/Seerr metadata queries.
     * Normalizes language codes to ISO 639-1 / BCP-47 strings suitable for TMDB (e.g. 'de', 'es', 'pt-BR', 'zh-CN').
     *
     * @returns {string} Standardized language tag for upstream media localization
     * @private
     */
    _getPreferredLanguage() {
        // Retrieve raw language tag from active internationalization instance or persistent storage
        const rawLang =
            i18n?.currentLang ||
            storage.getItem('app_language') ||
            (typeof navigator !== 'undefined' ? navigator.language : null) ||
            'en-us';

        if (!rawLang || typeof rawLang !== 'string') {
            return 'en';
        }

        // Deconstruct language identifier into primary language code and regional subtag
        const parts = rawLang.trim().split(/[-_]/);
        if (parts.length >= 2) {
            // Reconstruct as standard BCP-47 tag with uppercase country subtag (e.g., pt-BR, zh-CN, en-US)
            return `${parts[0].toLowerCase()}-${parts[1].toUpperCase()}`;
        }

        // Return lowercase 2-letter primary language code (e.g., de, fr, es, ar, ja)
        return parts[0].toLowerCase();
    }

    /**
     * Appends the active language query parameter to an API path when not explicitly present.
     *
     * @param {string} path - Target API route
     * @param {string|null} [overrideLanguage] - Optional explicit language code
     * @returns {string} Enriched path containing the language parameter
     * @private
     */
    _withLanguage(path, overrideLanguage = null) {
        if (!path || typeof path !== 'string') return path;

        // If route already specifies an explicit language parameter, leave it unmodified
        if (/[?&]language=/i.test(path)) {
            return path;
        }

        const lang = overrideLanguage || this._getPreferredLanguage();
        if (!lang) {
            return path;
        }

        // Append query separator based on existing parameter structure
        const separator = path.includes('?') ? '&' : '?';
        return `${path}${separator}language=${encodeURIComponent(lang)}`;
    }

    /**
     * Makes an authenticated call through the Litefin server plugin.
     * @param {string} path - Path after /Litefin/Seerr
     * @param {Object} [options] - Request method, body, and `fresh` to bypass the cached GET response
     * @returns {Promise<any>}
     * @private
     */
    async _request(path, options = {}) {
        const method = options.method || 'GET';
        log.debug(`${method} ${path}`);

        // Pages opened directly (deep links, launch targets) may not have probed
        // yet, and the probe decides whether image URLs go through the proxy.
        // Cheap once cached; status() uses api.get directly, so it never recurses.
        await this.status();

        try {
            if (method === 'POST') {
                this.clearResponseCache();
                return await api.post(`${API_ROOT}${path}`, options.body);
            }
            if (method === 'DELETE') {
                this.clearResponseCache();
                return await api.delete(`${API_ROOT}${path}`);
            }

            const now = Date.now();
            const lang = this._getPreferredLanguage();
            const cacheKey = `${api._userId || 'anon'}:${lang}:${path}`;
            // options.fresh skips the cache read only (live download polling). It must
            // never clear caches: wiping discover:pageCache would rebuild Discover on
            // back navigation and lose the restored focus.
            const cached = options.fresh ? null : this._cache.get(cacheKey);
            if (cached && now - cached.timestamp < this._cacheTtlMs) {
                return cached.data;
            }

            const data = await api.get(`${API_ROOT}${path}`);
            this._cache.set(cacheKey, { data, timestamp: now });
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
    _normalizeList(payload, allowPerson = false) {
        const results = this._resultsOf(payload)
            .filter((result) => result && (allowPerson || result.mediaType !== 'person'))
            .map(normalizeSeerrItem)
            .filter((item) => item !== null)
            .map((item) => decorateStatusBadge(item));

        if (payload && typeof payload === 'object') {
            results.page = payload.page || 1;
            results.totalPages = payload.totalPages || 1;
            results.totalResults = payload.totalResults || results.length;
        }

        return results;
    }

    /**
     * Retrieves currently trending media from Seerr, localized to active application language.
     *
     * @param {number} [page=1] - Requested pagination index
     * @param {string|null} [language=null] - Explicit language code override
     * @returns {Promise<Array<Object>>} Normalized list of trending titles
     */
    async discoverTrending(page = 1, language = null) {
        // Construct localized endpoint path for trending content
        const path = this._withLanguage('/Discover/Trending', language);
        return this._normalizeList(await this._request(path));
    }

    /**
     * Queries discovered movies filtered by genre, studio, keywords, or sorting,
     * decorated with localized metadata matching the user's active UI locale.
     *
     * @param {number} [page=1] - Requested pagination index
     * @param {Object|number|string} [options={}] - Filter and sort configuration
     * @returns {Promise<Array<Object>>} Normalized list of movie cards
     */
    async discoverMovies(page = 1, options = {}) {
        let queryParams = `page=${page}`;

        // Support shorthand invocation where options is directly a genre identifier
        if (typeof options === 'number' || typeof options === 'string') {
            queryParams += `&genre=${options}`;
        } else if (options && typeof options === 'object') {
            // Append genre filter parameter if specified
            if (options.genre) queryParams += `&genre=${encodeURIComponent(options.genre)}`;

            // Append explicit language override if supplied in options
            if (options.language) queryParams += `&language=${encodeURIComponent(options.language)}`;

            // Append age rating and certification country filters
            if (options.certification) {
                const country = options.certificationCountry || 'US';
                queryParams += `&certificationCountry=${encodeURIComponent(country)}&certification=${encodeURIComponent(options.certification)}`;
            }

            // Append keyword and studio constraints
            if (options.keywords) queryParams += `&keywords=${options.keywords}`;
            if (options.studio) queryParams += `&studio=${options.studio}`;

            // Append TMDB sort expression
            if (options.sortBy) queryParams += `&sortBy=${encodeURIComponent(options.sortBy)}`;
        }

        // Ensure path receives user's active preferred language tag
        const optLang = typeof options === 'object' && options ? options.language : null;
        const targetPath = this._withLanguage(`/Discover/Movies?${queryParams}`, optLang);
        return this._normalizeList(await this._request(targetPath));
    }

    /**
     * Queries discovered television series filtered by genre, network, keywords, or sorting,
     * decorated with localized metadata matching the user's active UI locale.
     *
     * @param {number} [page=1] - Requested pagination index
     * @param {Object|number|string} [options={}] - Filter and sort configuration
     * @returns {Promise<Array<Object>>} Normalized list of TV series cards
     */
    async discoverTv(page = 1, options = {}) {
        let queryParams = `page=${page}`;

        // Support shorthand invocation where options is directly a genre identifier
        if (typeof options === 'number' || typeof options === 'string') {
            queryParams += `&genre=${options}`;
        } else if (options && typeof options === 'object') {
            // Append genre filter parameter if specified
            if (options.genre) queryParams += `&genre=${encodeURIComponent(options.genre)}`;

            // Append explicit language override if supplied in options
            if (options.language) queryParams += `&language=${encodeURIComponent(options.language)}`;

            // Append age rating and certification country filters
            if (options.certification) {
                const country = options.certificationCountry || 'US';
                queryParams += `&certificationCountry=${encodeURIComponent(country)}&certification=${encodeURIComponent(options.certification)}`;
            }

            // Append keyword and network constraints
            if (options.keywords) queryParams += `&keywords=${options.keywords}`;
            if (options.network) queryParams += `&network=${options.network}`;

            // Append TMDB sort expression
            if (options.sortBy) queryParams += `&sortBy=${encodeURIComponent(options.sortBy)}`;
        }

        // Ensure path receives user's active preferred language tag
        const optLang = typeof options === 'object' && options ? options.language : null;
        const targetPath = this._withLanguage(`/Discover/Tv?${queryParams}`, optLang);
        return this._normalizeList(await this._request(targetPath));
    }

    async moviesByGenre(genreId, page = 1, sortBy = null, language = null) {
        // Forward genre search with localized language tag
        return this.discoverMovies(page, { genre: genreId, sortBy, language });
    }

    async tvByGenre(genreId, page = 1, sortBy = null, language = null) {
        // Forward TV genre search with localized language tag
        return this.discoverTv(page, { genre: genreId, sortBy, language });
    }

    async moviesByKeyword(keywordId, page = 1, sortBy = null, language = null) {
        // Forward movie keyword discovery with localized language tag
        return this.discoverMovies(page, { keywords: keywordId, sortBy, language });
    }

    async tvByKeyword(keywordId, page = 1, sortBy = null, language = null) {
        // Forward TV series keyword discovery with localized language tag
        return this.discoverTv(page, { keywords: keywordId, sortBy, language });
    }

    async moviesByStudio(studioId, page = 1, language = null) {
        // Request movies by production studio, normalized with preferred language
        const path = this._withLanguage(`/Discover/Movies/Studio/${studioId}?page=${page}`, language);
        return this._normalizeList(await this._request(path));
    }

    async tvByNetwork(networkId, page = 1, language = null) {
        // Request television series by network, normalized with preferred language
        const path = this._withLanguage(`/Discover/Tv/Network/${networkId}?page=${page}`, language);
        return this._normalizeList(await this._request(path));
    }

    /**
     * Searches the Seerr catalogue with automatic query localization.
     *
     * @param {string} query - Keyword search term
     * @param {number} [page=1] - Requested pagination index
     * @param {string|null} [language=null] - Optional language code override
     * @returns {Promise<Array<Object>>} Normalized search results
     */
    async search(query, page = 1, language = null) {
        // Formulate search query route enriched with localization tag
        const rawPath = `/Search?query=${encodeURIComponent(query)}&page=${page}`;
        const path = this._withLanguage(rawPath, language);
        return this._normalizeList(await this._request(path), true);
    }

    /**
     * Gets the full details used by the Seerr details page with localized text.
     *
     * @param {string} mediaType - Media type string ('movie' or 'tv')
     * @param {number} tmdbId - The TMDB identifier
     * @param {Object} [options]
     * @param {boolean} [options.fresh] - Bypass the response cache (download progress polling)
     * @param {string|null} [options.language] - Optional explicit language code override
     * @returns {Promise<Object>} Normalized detail item with status badges
     */
    async details(mediaType, tmdbId, options = {}) {
        // Resolve target endpoint controller segment
        const type = mediaType === 'tv' ? 'Tv' : 'Movie';
        const rawPath = `/${type}/${tmdbId}`;

        // Ensure detail route requests translated overview, title, and tagline
        const path = this._withLanguage(rawPath, options.language);
        const result = await this._request(path, options.fresh ? { fresh: true } : {});
        const item = normalizeSeerrItem(result, mediaType);
        if (!item) throw new Error('SeerrInvalidResponse');
        return decorateStatusBadge(item);
    }

    async similar(mediaType, tmdbId, page = 1, language = null) {
        // Resolve media controller segment
        const type = mediaType === 'tv' ? 'Tv' : 'Movie';
        try {
            // Formulate localized path for similar media suggestions
            const path = this._withLanguage(`/${type}/${tmdbId}/similar?page=${page}`, language);
            const raw = await this._request(path);
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

    async recommendations(mediaType, tmdbId, page = 1, language = null) {
        // Resolve target entity route segment based on media type
        const type = mediaType === 'tv' ? 'Tv' : 'Movie';

        try {
            // Formulate localized route paths respecting upstream casing conventions
            let raw;
            const primaryPath = this._withLanguage(`/${type}/${tmdbId}/recommendations?page=${page}`, language);
            try {
                raw = await this._request(primaryPath);
            } catch (primaryErr) {
                // Route casing fallback for strict reverse proxy environments
                const fallbackPath = this._withLanguage(`/${type}/${tmdbId}/Recommendations?page=${page}`, language);
                raw = await this._request(fallbackPath);
            }

            // Extract results list from raw response payload
            const list = this._resultsOf(raw);

            // Filter non-person entries and transform into normalized card models
            return list
                .filter((r) => r && r.mediaType !== 'person')
                .map((r) => normalizeSeerrItem(r, mediaType))
                .filter(Boolean)
                .map(decorateStatusBadge);
        } catch (e) {
            // Gracefully handle missing recommendations without failing page rendering
            log.warn(`Failed to fetch recommendations for ${mediaType} ${tmdbId}`, e);
            return [];
        }
    }

    async collection(collectionId, language = null) {
        try {
            // Request collection bundle with localized part descriptions
            const path = this._withLanguage(`/Collection/${collectionId}`, language);
            const raw = await this._request(path);
            const list = this._resultsOf(raw?.parts || raw?.results || raw);
            const title = raw?.name || raw?.title || '';
            const items = list
                .filter((r) => r && r.mediaType !== 'person')
                .map((r) => normalizeSeerrItem(r, r.mediaType || 'movie'))
                .filter(Boolean)
                .map(decorateStatusBadge);
            return {
                id: collectionId,
                name: title,
                items: items
            };
        } catch (e) {
            log.warn(`Failed to fetch collection ${collectionId}`, e);
            return { id: collectionId, name: '', items: [] };
        }
    }

    /**
     * Gets person details along with combined cast and crew filmography from Seerr.
     * Normalizes and decorates each credit item with availability badges.
     *
     * @param {number} personId - The TMDB person identifier.
     * @param {string|null} [language=null] - Optional explicit language code override
     * @returns {Promise<Object>} Normalized person details and appearances.
     */
    async person(personId, language = null) {
        try {
            // Request person entity and combined credits in parallel with localized biographies
            const personPath = this._withLanguage(`/Person/${personId}`, language);
            const creditsPath = this._withLanguage(`/Person/${personId}/combined_credits`, language);
            const [rawPersonRes, creditsRes] = await Promise.allSettled([
                this._request(personPath),
                this._request(creditsPath)
            ]);

            const raw = rawPersonRes.status === 'fulfilled' ? rawPersonRes.value || {} : {};
            const creditsRaw = creditsRes.status === 'fulfilled' ? creditsRes.value || {} : {};

            if (!raw && !creditsRaw) throw new Error('SeerrInvalidResponse');

            // Extract cast and crew arrays from combined credits response or person entity
            const cast =
                creditsRaw.cast ||
                creditsRaw.Cast ||
                creditsRaw.combinedCredits?.cast ||
                creditsRaw.combined_credits?.cast ||
                raw.combinedCredits?.cast ||
                raw.combined_credits?.cast ||
                raw.credits?.cast ||
                raw.cast ||
                [];

            const crew =
                creditsRaw.crew ||
                creditsRaw.Crew ||
                creditsRaw.combinedCredits?.crew ||
                creditsRaw.combined_credits?.crew ||
                raw.combinedCredits?.crew ||
                raw.combined_credits?.crew ||
                raw.credits?.crew ||
                raw.crew ||
                [];

            // Deduplicate items appearing in both cast and crew roles
            const combined = [...cast, ...crew]
                .filter(
                    (item, index, self) =>
                        item &&
                        index ===
                            self.findIndex(
                                (t) =>
                                    t &&
                                    (t.id || t.Id) === (item.id || item.Id) &&
                                    (t.mediaType || t.media_type) === (item.mediaType || item.media_type)
                            )
                )
                // Order credits by popularity descending for relevant filmography presentation
                .sort((a, b) => (b.popularity || b.voteAverage || 0) - (a.popularity || a.voteAverage || 0));

            // Convert TMDB credit entries to standard normalized cards with status badges
            const appearances = combined
                .map((r) => normalizeSeerrItem(r, r.mediaType || r.media_type || (r.title ? 'movie' : 'tv')))
                .filter(Boolean)
                .map(decorateStatusBadge);

            const profile = raw.profilePath || raw.profile_path || raw.ProfilePath || '';

            // Construct unified person view model
            return {
                id: raw.id || raw.Id || personId,
                name: raw.name || raw.Name || '',
                biography: raw.biography || raw.Biography || raw.overview || raw.Overview || '',
                birthday: raw.birthday || raw.Birthday || '',
                deathday: raw.deathday || raw.Deathday || null,
                placeOfBirth: raw.placeOfBirth || raw.place_of_birth || raw.PlaceOfBirth || '',
                knownForDepartment: raw.knownForDepartment || raw.known_for_department || raw.KnownForDepartment || '',
                profilePath: profile,
                _imageUrl: tmdbUrl('h632', profile),
                appearances: appearances,
                combinedCredits: {
                    cast: cast,
                    crew: crew
                },
                raw: { ...raw, combinedCredits: { cast, crew } }
            };
        } catch (e) {
            log.warn(`Failed to fetch person ${personId}`, e);
            throw e;
        }
    }

    /**
     * Gets requestable seasons of a series with localized season titles.
     * @param {number} tmdbId - The TMDB series identifier
     * @param {string|null} [language=null] - Optional explicit language code override
     * @returns {Promise<Array<{seasonNumber: number, name: string, episodeCount: number, status: number}>>}
     */
    async tvSeasons(tmdbId, language = null) {
        // Query TV series details with localized metadata
        const path = this._withLanguage(`/Tv/${tmdbId}`, language);
        const detail = await this._request(path);
        const seasons = (detail && detail.seasons) || [];
        const seasonStatuses = {};

        // -------------------------------------------------------------------
        // Seerr uses TWO separate status enums:
        //
        //   MediaStatus (mediaInfo.status, mediaInfo.seasons[].status):
        //     1=UNKNOWN, 2=PENDING, 3=PROCESSING, 4=PARTIALLY_AVAILABLE, 5=AVAILABLE
        //
        //   RequestStatus (requests[].status, requests[].seasons[].status):
        //     1=PENDING (awaiting admin approval)
        //     2=APPROVED (downloader picked it up)
        //     3=DECLINED
        //
        // We must translate RequestStatus → MediaStatus before comparing.
        // -------------------------------------------------------------------
        const requestStatusToMediaStatus = (rs) => {
            switch (rs) {
                case 1:
                    return SEERR_STATUS.PENDING; // Request pending → MediaStatus PENDING (2)
                case 2:
                    return SEERR_STATUS.PROCESSING; // Request approved → MediaStatus PROCESSING (3)
                default:
                    return 0; // Declined or unknown → ignore
            }
        };

        // Pass 1: read season statuses from mediaInfo.seasons (uses MediaStatus directly)
        const infoSeasons = (detail && detail.mediaInfo && detail.mediaInfo.seasons) || [];
        infoSeasons.forEach((season) => {
            const sNum = season.seasonNumber ?? season.season_number;
            if (sNum != null) {
                seasonStatuses[Number(sNum)] = season.status ?? 0;
            }
        });

        // Pass 2: overlay statuses from active requests (translate RequestStatus → MediaStatus)
        const requests = (detail && detail.mediaInfo && detail.mediaInfo.requests) || [];
        requests.forEach((req) => {
            // Translate this request's status to MediaStatus
            const reqMediaStatus = requestStatusToMediaStatus(req.status);
            if (!reqMediaStatus) return; // DECLINED — skip entirely

            const reqSeasons = req.seasons || [];
            reqSeasons.forEach((s) => {
                const sNum = s.seasonNumber ?? s.season_number;
                if (sNum != null) {
                    const numKey = Number(sNum);
                    // Take the higher of any existing MediaStatus and this request's translated status
                    // so AVAILABLE (5) is never downgraded to PENDING (2) by a stale request.
                    const existing = seasonStatuses[numKey] || 0;
                    seasonStatuses[numKey] = Math.max(existing, reqMediaStatus);
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
     * @param {number} [params.userId]
     * @returns {Promise<Object>}
     */
    async createRequest({
        mediaType,
        tmdbId,
        seasons,
        serverId,
        profileId,
        rootFolder,
        languageProfileId,
        is4k,
        userId
    }) {
        const body = { mediaType, mediaId: tmdbId };
        if (mediaType === 'tv') body.seasons = seasons || [];
        if (serverId != null) body.serverId = serverId;
        if (profileId != null) body.profileId = profileId;
        if (rootFolder) body.rootFolder = rootFolder;
        if (languageProfileId != null) body.languageProfileId = languageProfileId;
        if (userId != null) body.userId = userId;
        body.is4k = !!is4k;
        log.info(
            `Requesting ${mediaType} ${tmdbId}${seasons ? ` seasons ${seasons.join(',')}` : ''}${userId != null ? ` for user ${userId}` : ''}`
        );
        return this._request('/Requests', { method: 'POST', body });
    }

    async cancelRequest(requestId) {
        return this._request(`/Requests/${requestId}`, { method: 'DELETE' });
    }

    async getUsers(take = 1000, sort = 'displayname') {
        try {
            const data = await this._request(`/Users?take=${take}&sort=${encodeURIComponent(sort)}`);
            return data?.results || (Array.isArray(data) ? data : []);
        } catch (err) {
            log.warn('Failed to fetch Seerr users', err);
            return [];
        }
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
        const isAdmin = !!((user.permissions || 0) & (2 | 8192));
        if (!isAdmin) return null;
        const servers = await this._request(`/Services/${mediaType}`);
        const details = await Promise.all(
            servers.map((server) => this._request(`/Services/${mediaType}/${server.id}`))
        );
        return { servers, details, user };
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
                            _requestId: item._requestId || detail._requestId,
                            _downloads: item._downloads && item._downloads.length ? item._downloads : detail._downloads
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
     * @param {number} [take=12]
     * @param {number} [skip=0]
     * @param {string} [filter='all']
     * @returns {Promise<Array<Object>>}
     */
    async requests(take = 12, skip = 0, filter = 'all') {
        let payload = null;

        // Fallback route chain: /request -> /Request -> /Requests
        try {
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
        } catch (err) {
            // Gracefully handle unlinked accounts or upstream errors by returning an empty list
            log.warn('Failed to retrieve Seerr requests, returning empty collection', err);
            return [];
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
                    mediaType:
                        media.mediaType || req.type || (req.type === 1 ? 'movie' : req.type === 2 ? 'tv' : 'movie'),
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
            try {
                payload = await this._request(`/Watchlist?page=${page}`);
            } catch (err1) {
                if (err1.status === 404) {
                    payload = await this._request(`/watchlist?page=${page}`);
                } else {
                    throw err1;
                }
            }
        } catch (err) {
            // Gracefully handle unlinked accounts or network errors with an empty list
            log.warn('Failed to retrieve Seerr watchlist, returning empty collection', err);
            return [];
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
     * @param {number} [take=12]
     * @returns {Promise<Array<Object>>}
     */
    async recentlyAdded(take = 12) {
        let payload = null;
        try {
            payload = await this._request(`/RecentlyAdded?take=${take}`);
        } catch (err1) {
            if (err1.status === 404) {
                try {
                    payload = await this._request(`/Media?take=${take}`);
                } catch (err2) {
                    log.warn('Failed to retrieve recently added Seerr items', err2);
                    return [];
                }
            } else {
                log.warn('Failed to retrieve recently added Seerr items', err1);
                return [];
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
     * Gets upcoming movies from Seerr with localized titles and descriptions.
     * @param {number} [page=1]
     * @param {string|null} [language=null] - Optional explicit language code override
     * @returns {Promise<Array<Object>>}
     */
    async upcomingMovies(page = 1, language = null) {
        let payload = null;
        try {
            try {
                // Attempt upper-case route with preferred language
                const primaryPath = this._withLanguage(`/Discover/Movies/Upcoming?page=${page}`, language);
                payload = await this._request(primaryPath);
            } catch (err) {
                // Fallback to lower-case route if upper-case failed
                const fallbackPath = this._withLanguage(`/discover/movies/upcoming?page=${page}`, language);
                payload = await this._request(fallbackPath);
            }
        } catch (err) {
            log.warn('Failed to retrieve Seerr upcoming movies, returning empty collection', err);
            return [];
        }
        return this._normalizeList(payload);
    }

    /**
     * Gets upcoming TV series from Seerr with localized titles and descriptions.
     * @param {number} [page=1]
     * @param {string|null} [language=null] - Optional explicit language code override
     * @returns {Promise<Array<Object>>}
     */
    async upcomingTv(page = 1, language = null) {
        let payload = null;
        try {
            try {
                // Attempt upper-case route with preferred language
                const primaryPath = this._withLanguage(`/Discover/Tv/Upcoming?page=${page}`, language);
                payload = await this._request(primaryPath);
            } catch (err) {
                // Fallback to lower-case route if upper-case failed
                const fallbackPath = this._withLanguage(`/discover/tv/upcoming?page=${page}`, language);
                payload = await this._request(fallbackPath);
            }
        } catch (err) {
            log.warn('Failed to retrieve Seerr upcoming TV series, returning empty collection', err);
            return [];
        }
        return this._normalizeList(payload);
    }

    /**
     * Gets movie genre slider items from Seerr with localized genre names.
     * @param {string|null} [language=null] - Optional explicit language code override
     * @returns {Promise<Array<Object>>}
     */
    async genreSliderMovies(language = null) {
        let payload = null;
        try {
            // Attempt upper-case genre slider route with preferred language
            const primaryPath = this._withLanguage('/Discover/GenreSlider/Movie', language);
            payload = await this._request(primaryPath);
        } catch (err) {
            try {
                // Fallback to lower-case genre slider route
                const fallbackPath = this._withLanguage('/discover/genreslider/movie', language);
                payload = await this._request(fallbackPath);
            } catch (err2) {
                payload = null;
            }
        }
        const rawList = this._resultsOf(payload);
        return buildGenreSliderItems(rawList, 'movie');
    }

    /**
     * Gets TV genre slider items from Seerr with localized genre names.
     * @param {string|null} [language=null] - Optional explicit language code override
     * @returns {Promise<Array<Object>>}
     */
    async genreSliderTv(language = null) {
        let payload = null;
        try {
            // Attempt upper-case TV genre slider route with preferred language
            const primaryPath = this._withLanguage('/Discover/GenreSlider/Tv', language);
            payload = await this._request(primaryPath);
        } catch (err) {
            try {
                // Fallback to lower-case TV genre slider route
                const fallbackPath = this._withLanguage('/discover/genreslider/tv', language);
                payload = await this._request(fallbackPath);
            } catch (err2) {
                payload = null;
            }
        }
        const rawList = this._resultsOf(payload);
        return buildGenreSliderItems(rawList, 'tv');
    }

    /**
     * Gets movie studios list with logos.
     * @returns {Promise<Array<Object>>}
     */
    async studios() {
        return buildStudioItems();
    }

    /**
     * Gets streaming networks list with logos.
     * @returns {Promise<Array<Object>>}
     */
    async networks() {
        return buildNetworkItems();
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

export const seerr = new SeerrClient();
