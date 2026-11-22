/**
 * ============================================================================
 * Litefin Tizen - Seerr Catalog Queries
 * ============================================================================
 * Single place that turns "which Seerr titles do we want" into the matching
 * Seerr client call. A catalog query is a plain value:
 *
 *   {
 *     mediaType: 'movie' | 'tv',
 *     kind: 'discover' | 'studio' | 'network' | 'search',
 *     genre?, keywords?, language?, certification?, sortBy?,   // discover
 *     watchRegion?, watchProviders?,                             // discover
 *     studio?, network?, query?                                  // other kinds
 *   }
 *
 * Callers build queries from route params (Seerr library page) or from Seerr
 * discover sliders (custom Discover rows) and fetch pages through
 * fetchCatalogPage(), so the dispatch rules live here only.
 * ============================================================================
 */

import { seerr } from './seerrClient.js';

/**
 * Seerr DiscoverSliderType values (server/constants/discover.ts).
 */
export const SEERR_SLIDER_TYPE = {
    RECENTLY_ADDED: 1,
    RECENT_REQUESTS: 2,
    PLEX_WATCHLIST: 3,
    TRENDING: 4,
    POPULAR_MOVIES: 5,
    MOVIE_GENRES: 6,
    UPCOMING_MOVIES: 7,
    STUDIOS: 8,
    POPULAR_TV: 9,
    TV_GENRES: 10,
    UPCOMING_TV: 11,
    NETWORKS: 12,
    TMDB_MOVIE_KEYWORD: 13,
    TMDB_MOVIE_GENRE: 14,
    TMDB_TV_KEYWORD: 15,
    TMDB_TV_GENRE: 16,
    TMDB_SEARCH: 17,
    TMDB_STUDIO: 18,
    TMDB_NETWORK: 19,
    TMDB_MOVIE_STREAMING_SERVICES: 20,
    TMDB_TV_STREAMING_SERVICES: 21
};

/** TMDB sort fields offered by the Seerr library page. */
const VALID_SORT_FIELDS = ['popularity', 'release_date', 'first_air_date', 'vote_average', 'original_title'];

const SINGLE_ID = /^[0-9]+$/;
const ID_LIST = /^[0-9]+(,[0-9]+)*$/;
const PROVIDER_LIST = /^[0-9]+(\|[0-9]+)*$/;
const REGION = /^[A-Z]{2}$/;

/**
 * Normalizes route media type aliases ('series', 'tvshows') to Seerr's 'movie' | 'tv'.
 * @param {string|undefined} rawMediaType
 * @returns {'movie'|'tv'}
 */
function normalizeMediaType(rawMediaType) {
    return rawMediaType === 'tv' || rawMediaType === 'series' || rawMediaType === 'tvshows' ? 'tv' : 'movie';
}

/**
 * Builds the TMDB sortBy expression for the Seerr library page.
 * Returns null for the upstream default (popularity.desc) and for fields TMDB does not
 * understand, e.g. a Jellyfin 'SortName' carried over by navigation state restore —
 * sending that made Seerr return an empty result.
 *
 * @param {string|null|undefined} sortBy - Sort field from page state
 * @param {string|null|undefined} sortOrder - 'Ascending' | 'Descending'
 * @returns {string|null}
 */
export function seerrSortParam(sortBy, sortOrder) {
    if (!VALID_SORT_FIELDS.includes(sortBy)) return null;
    const field = sortBy;
    const dir = (sortOrder || 'Descending').toLowerCase().startsWith('asc') ? 'asc' : 'desc';
    return field === 'popularity' && dir === 'desc' ? null : `${field}.${dir}`;
}

/**
 * Derives a catalog query from Seerr library route params and active filters.
 * Keeps the precedence of the original library page logic:
 * keyword → genre/language/certification → studio → network → plain discover.
 *
 * @param {Object} params - Route params (seerrType, mediaType, genreId, studioId, ...)
 * @param {Object} [filters] - Active library filters (genre, language, certification)
 * @param {string|null} [sortBy] - TMDB sort expression (see seerrSortParam)
 * @returns {Object} Catalog query
 */
export function catalogQueryFromLibraryParams(params = {}, filters = {}, sortBy = null) {
    const seerrType = params.seerrType;
    const mediaType = normalizeMediaType(params.mediaType || (seerrType === 'network' ? 'tv' : 'movie'));
    const genre = filters.genre !== undefined ? filters.genre : params.genreId || params.genre;
    const language = filters.language !== undefined ? filters.language : params.language;
    const certification = filters.certification !== undefined ? filters.certification : params.certification;
    const studio = params.studioId || params.studio;
    const network = params.networkId || params.network;
    const keywords = params.keywordId || params.keywords || params.keyword;

    const discover = { mediaType, kind: 'discover', genre, keywords, language, certification, sortBy };

    if (seerrType === 'keyword' || seerrType === 'tag' || keywords) return discover;
    if (genre || language || certification || seerrType === 'genre') return { ...discover, keywords: undefined };
    if (seerrType === 'studio' || studio) return { mediaType: 'movie', kind: 'studio', studio };
    if (seerrType === 'network' || network) return { mediaType: 'tv', kind: 'network', network };
    return { ...discover, genre: undefined, keywords: undefined };
}

/**
 * Derives a catalog query from a custom Seerr discover slider (types 13–21).
 * Built-in slider types and malformed slider data return null.
 *
 * @param {Object} slider - Seerr DiscoverSlider ({ type, data, ... })
 * @returns {Object|null} Catalog query, or null when the slider is not a catalog slider
 */
export function catalogQueryFromSlider(slider) {
    if (!slider || typeof slider.data !== 'string') return null;
    const data = slider.data.trim();
    if (!data) return null;
    const T = SEERR_SLIDER_TYPE;

    switch (slider.type) {
        case T.TMDB_MOVIE_KEYWORD:
        case T.TMDB_TV_KEYWORD:
            if (!ID_LIST.test(data)) return null;
            return {
                mediaType: slider.type === T.TMDB_TV_KEYWORD ? 'tv' : 'movie',
                kind: 'discover',
                keywords: data
            };
        case T.TMDB_MOVIE_GENRE:
        case T.TMDB_TV_GENRE:
            if (!ID_LIST.test(data)) return null;
            return { mediaType: slider.type === T.TMDB_TV_GENRE ? 'tv' : 'movie', kind: 'discover', genre: data };
        case T.TMDB_SEARCH:
            return { mediaType: 'movie', kind: 'search', query: data };
        case T.TMDB_STUDIO:
            return SINGLE_ID.test(data) ? { mediaType: 'movie', kind: 'studio', studio: data } : null;
        case T.TMDB_NETWORK:
            return SINGLE_ID.test(data) ? { mediaType: 'tv', kind: 'network', network: data } : null;
        case T.TMDB_MOVIE_STREAMING_SERVICES:
        case T.TMDB_TV_STREAMING_SERVICES: {
            // Seerr stores "<region>,<provider>|<provider>"
            const comma = data.indexOf(',');
            if (comma === -1) return null;
            const watchRegion = data.slice(0, comma);
            const watchProviders = data.slice(comma + 1);
            if (!REGION.test(watchRegion) || !PROVIDER_LIST.test(watchProviders)) return null;
            return {
                mediaType: slider.type === T.TMDB_TV_STREAMING_SERVICES ? 'tv' : 'movie',
                kind: 'discover',
                watchRegion,
                watchProviders
            };
        }
        default:
            return null;
    }
}

/**
 * Fetches one page of titles for a catalog query.
 * A single keyword id goes out as the legacy `keywords` parameter every plugin version
 * understands; only real keyword lists use `keywordIds` (newer plugins).
 *
 * @param {Object} query - Catalog query
 * @param {number} [page=1] - Page index (each page merges 5 upstream pages on the plugin)
 * @param {Object} [client=seerr] - Seerr client (injectable for tests)
 * @returns {Promise<Array<Object>>} Normalized items
 */
export async function fetchCatalogPage(query, page = 1, client = seerr) {
    if (!query) return [];

    switch (query.kind) {
        case 'studio':
            return client.moviesByStudio(query.studio, page);
        case 'network':
            return client.tvByNetwork(query.network, page);
        case 'search':
            return client.search(query.query, page);
        default: {
            const keywords = query.keywords != null ? String(query.keywords) : '';
            const options = {
                keywords: SINGLE_ID.test(keywords) ? keywords : undefined,
                keywordIds: keywords && !SINGLE_ID.test(keywords) ? keywords : undefined,
                genre: query.genre,
                language: query.language,
                certification: query.certification,
                sortBy: query.sortBy,
                watchRegion: query.watchRegion,
                watchProviders: query.watchProviders
            };
            return query.mediaType === 'tv' ? client.discoverTv(page, options) : client.discoverMovies(page, options);
        }
    }
}
