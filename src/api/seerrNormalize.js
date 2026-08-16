/**
 * ============================================================================
 * Litefin Tizen - Jellyseerr Result Normalization
 * ============================================================================
 * Converts TMDB results returned by Jellyseerr into Jellyfin-shaped items so
 * that MediaGrid and CardRenderer can display them unchanged. Kept free of
 * imports so it stays runnable under node for check-seerr-normalize.mjs.
 * ============================================================================
 */

const TMDB_POSTER_BASE = 'https://image.tmdb.org/t/p/w300';
const TMDB_POSTER_DETAIL_BASE = 'https://image.tmdb.org/t/p/w500';
const TMDB_BACKDROP_BASE = 'https://image.tmdb.org/t/p/w1280';

/**
 * Jellyseerr MediaStatus values. 0 does not exist server-side — it is our
 * value for "never requested", when the result carries no mediaInfo.
 */
export const SEERR_STATUS = Object.freeze({
    NOT_REQUESTED: 0,
    UNKNOWN: 1,
    PENDING: 2,
    PROCESSING: 3,
    PARTIALLY_AVAILABLE: 4,
    AVAILABLE: 5,
    DELETED: 6
});

/**
 * Normalizes a user-typed instance address: trims, drops trailing slashes and
 * infers a scheme when none was typed. Typing 'http://' on a remote is painful,
 * and fetch() rejects a schemeless URL outright rather than assuming one.
 * @param {string} [url]
 * @returns {string} Normalized base URL, or '' when nothing usable was given
 */
export function normalizeSeerrBaseUrl(url) {
    const trimmed = (url || '').trim().replace(/\/+$/, '');
    if (!trimmed) return '';
    if (/^https?:\/\//i.test(trimmed)) return trimmed;

    // An explicit port or a bare IPv4 means a LAN instance reached over plain
    // HTTP; anything else is a hostname, which in practice sits behind TLS.
    const isLan = /:\d+$/.test(trimmed) || /^\d{1,3}(\.\d{1,3}){3}(:|$)/.test(trimmed);
    return `${isLan ? 'http' : 'https'}://${trimmed}`;
}

/**
 * i18n key for the status badge, or an empty string when no badge should show.
 * @param {number} [status] - MediaStatus value
 * @returns {string}
 */
export function seerrStatusKey(status) {
    switch (status) {
        case SEERR_STATUS.PENDING:
            return 'SeerrStatusPending';
        case SEERR_STATUS.PROCESSING:
            return 'SeerrStatusProcessing';
        case SEERR_STATUS.PARTIALLY_AVAILABLE:
            return 'SeerrStatusPartial';
        case SEERR_STATUS.AVAILABLE:
            return 'SeerrStatusAvailable';
        default:
            return '';
    }
}

/**
 * i18n key for season status indicator (including Not Requested).
 * @param {number} [status] - MediaStatus value
 * @returns {string}
 */
export function seerrSeasonStatusKey(status) {
    switch (status) {
        case SEERR_STATUS.PENDING:
            return 'SeerrStatusPending';
        case SEERR_STATUS.PROCESSING:
            return 'SeerrStatusProcessing';
        case SEERR_STATUS.PARTIALLY_AVAILABLE:
            return 'SeerrStatusPartial';
        case SEERR_STATUS.AVAILABLE:
            return 'SeerrStatusAvailable';
        default:
            return 'SeerrStatusNotRequested';
    }
}

/**
 * Extracts the year from a TMDB date ('1999-03-30'). Returns undefined rather
 * than NaN on missing or malformed input, so cards never render "NaN".
 * @param {string} [dateStr]
 * @returns {number|undefined}
 */
function extractYear(dateStr) {
    if (!dateStr || typeof dateStr !== 'string') return undefined;
    const year = parseInt(dateStr.slice(0, 4), 10);
    return isNaN(year) ? undefined : year;
}

/**
 * Converts a Jellyseerr result into a Jellyfin-shaped item.
 * @param {Object} result - Raw result from /discover, /search, /movie or /tv
 * @param {string} [fallbackMediaType] - Explicit fallback ('tv' or 'movie') when result.mediaType is missing
 * @returns {Object|null} Normalized item, or null when the result is unusable
 */
export function normalizeSeerrItem(result, fallbackMediaType = null) {
    if (!result || !result.id) return null;

    const isTv =
        result.mediaType === 'tv' ||
        (fallbackMediaType && fallbackMediaType === 'tv') ||
        (!result.mediaType && (!!result.firstAirDate || !!result.seasons || !!result.numberOfSeasons));
    const mediaType = isTv ? 'tv' : 'movie';

    return {
        // Cannot collide with a Jellyfin GUID, and doubles as the CardRenderer
        // HTML cache key.
        Id: `tmdb-${mediaType}-${result.id}`,
        Name: result.title || result.name || '',
        Type: isTv ? 'Series' : 'Movie',
        ProductionYear: extractYear(isTv ? result.firstAirDate : result.releaseDate),
        Overview: result.overview || '',
        // Read by CardRenderer to bypass Jellyfin URL building
        _imageUrl: result.posterPath ? `${TMDB_POSTER_BASE}${result.posterPath}` : '',
        _detailImageUrl: result.posterPath ? `${TMDB_POSTER_DETAIL_BASE}${result.posterPath}` : '',
        _backdropUrl: result.backdropPath ? `${TMDB_BACKDROP_BASE}${result.backdropPath}` : '',
        _seerrStatus: (result.mediaInfo && result.mediaInfo.status) || SEERR_STATUS.NOT_REQUESTED,
        _requestId: (() => {
            const requests = (result.mediaInfo && result.mediaInfo.requests) || result.requests || [];
            const firstReq = Array.isArray(requests) ? requests[0] : null;
            return firstReq ? (firstReq.id || firstReq.requestId) : null;
        })(),
        _tmdbId: result.id,
        _mediaType: mediaType,
        RunTimeTicks: (result.runtime || result.episodeRunTime?.[0] || 0) * 600000000,
        CommunityRating: typeof result.voteAverage === 'number' ? result.voteAverage : 0,
        Genres: Array.isArray(result.genres) ? result.genres.map((genre) => genre.name).filter(Boolean) : [],
        Tagline: result.tagline || ''
    };
}
