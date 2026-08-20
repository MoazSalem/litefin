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

function extractCrewByJob(rawCrew, jobMatches) {
    if (!Array.isArray(rawCrew)) return [];
    const names = [];
    const seen = new Set();
    for (const member of rawCrew) {
        const job = (member.job || member.known_for_department || '').toLowerCase();
        const name = typeof member === 'string' ? member : (member && member.name);
        if (!name) continue;
        if (jobMatches.some((match) => job.includes(match))) {
            const key = name.trim().toLowerCase();
            if (!seen.has(key)) {
                seen.add(key);
                names.push(name.trim());
            }
        }
    }
    return names;
}

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
        case SEERR_STATUS.PROCESSING:
            return 'SeerrStatusPending';
        case SEERR_STATUS.PARTIALLY_AVAILABLE:
            return 'SeerrStatusPartial';
        case SEERR_STATUS.AVAILABLE:
            return 'SeerrStatusAvailable';
        case SEERR_STATUS.NOT_REQUESTED:
        case SEERR_STATUS.UNKNOWN:
        case SEERR_STATUS.DELETED:
        default:
            return 'SeerrStatusNotRequested';
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
        OriginalTitle: (() => {
            const orig = result.originalTitle || result.originalName || '';
            const main = result.title || result.name || '';
            return orig !== main ? orig : '';
        })(),
        Type: isTv ? 'Series' : 'Movie',
        ProductionYear: extractYear(isTv ? result.firstAirDate : result.releaseDate),
        Overview: result.overview || '',
        // Read by CardRenderer to bypass Jellyfin URL building
        _imageUrl: result.posterPath ? `${TMDB_POSTER_BASE}${result.posterPath}` : '',
        _detailImageUrl: result.posterPath ? `${TMDB_POSTER_DETAIL_BASE}${result.posterPath}` : '',
        _backdropUrl: result.backdropPath ? `${TMDB_BACKDROP_BASE}${result.backdropPath}` : '',
        _seerrStatus: (result.mediaInfo && result.mediaInfo.status) || SEERR_STATUS.NOT_REQUESTED,
        _jellyfinMediaId: (() => {
            const info = result.mediaInfo || {};
            return info.jellyfinMediaId || info.jellyfinMediaId4k || info.serviceId || info.externalServiceId || null;
        })(),
        _requestId: (() => {
            const requests = (result.mediaInfo && result.mediaInfo.requests) || result.requests || [];
            const firstReq = Array.isArray(requests) ? requests[0] : null;
            return firstReq ? (firstReq.id || firstReq.requestId) : null;
        })(),
        _tmdbId: result.id,
        _mediaType: mediaType,
        RunTimeTicks: (result.runtime || result.episodeRunTime?.[0] || 0) * 600000000,
        ReleaseDate: result.releaseDate || result.firstAirDate || '',
        Budget: typeof result.budget === 'number' && result.budget > 0 ? result.budget : null,
        Revenue: typeof result.revenue === 'number' && result.revenue > 0 ? result.revenue : null,
        MediaStatus: result.status || result.mediaStatus || '',
        CommunityRating: typeof result.voteAverage === 'number' ? result.voteAverage : 0,
        Genres: Array.isArray(result.genres)
            ? result.genres.map((g) => (typeof g === 'object' && g ? { Id: g.id || g.Id || '', Name: g.name || g.Name || '' } : { Id: '', Name: String(g) })).filter((g) => g && Boolean(g.Name))
            : [],
        Studios: Array.isArray(result.productionCompanies)
            ? result.productionCompanies.map((c) => (typeof c === 'object' && c ? { Id: c.id || c.Id || '', Name: c.name || c.Name || '' } : { Id: '', Name: String(c) })).filter((c) => c && Boolean(c.Name))
            : [],
        ProductionTeam: (() => {
            const rawCrew = (result.credits && result.credits.crew) || result.crew || [];
            if (!Array.isArray(rawCrew)) return [];
            
            const jobLimits = {
                'director': 2,
                'writer': 2,
                'screenplay': 2,
                'editor': 1,
                'producer': 2,
                'co-producer': 1
            };
            const counts = {};
            const names = [];
            const seen = new Set();

            for (const member of rawCrew) {
                const job = (member.job || '').trim().toLowerCase();
                const name = typeof member === 'string' ? member : (member && member.name);
                if (!name) continue;
                
                const limit = jobLimits[job];
                if (limit) {
                    counts[job] = counts[job] || 0;
                    if (counts[job] < limit) {
                        const key = name.trim().toLowerCase();
                        if (!seen.has(key)) {
                            seen.add(key);
                            names.push(name.trim());
                        }
                        counts[job]++;
                    }
                }
            }
            return names;
        })(),
        Cast: (() => {
            const rawCast = (result.credits && result.credits.cast) || result.cast || [];
            if (!Array.isArray(rawCast)) return [];
            return rawCast.map((c) => ({
                Id: c.id,
                Name: c.name,
                Role: c.character || '',
                Type: 'Person',
                _imageUrl: c.profilePath ? `${TMDB_POSTER_BASE}${c.profilePath}` : ''
            }));
        })(),
        Tags: (() => {
            const rawKw = result.keywords;
            const kwList = Array.isArray(rawKw) ? rawKw : (rawKw && Array.isArray(rawKw.results) ? rawKw.results : (rawKw && Array.isArray(rawKw.keywords) ? rawKw.keywords : []));
            return kwList.map((k) => {
                if (!k) return null;
                if (typeof k === 'object') {
                    return { Id: k.id || k.Id || '', Name: k.name || k.Name || '' };
                }
                return { Id: '', Name: String(k) };
            }).filter((k) => k && Boolean(k.Name));
        })(),
        RemoteTrailers: (() => {
            const raw = result.relatedVideos || result.videos || [];
            const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.results) ? raw.results : []);
            return list
                .filter((v) => {
                    const site = (v && v.site ? String(v.site) : '').toLowerCase();
                    const type = (v && v.type ? String(v.type) : '').toLowerCase();
                    return site === 'youtube' && type === 'trailer';
                })
                .map((v) => {
                    const key = v.key || v.url || '';
                    const url = key.startsWith('http') ? key : (key ? `https://www.youtube.com/watch?v=${key}` : '');
                    return {
                        Name: v.name || `${result.title || result.name || 'Media'} Trailer`,
                        Url: url
                    };
                })
                .filter((v) => Boolean(v.Url));
        })(),
        Tagline: result.tagline || '',
        collection: result.collection || (result.belongsToCollection ? { id: result.belongsToCollection.id, name: result.belongsToCollection.name } : null),
        Similar: (() => {
            const raw = result.similar;
            const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.results) ? raw.results : []);
            return list.map((item) => normalizeSeerrItem(item, mediaType)).filter(Boolean);
        })(),
        Recommendations: (() => {
            const raw = result.recommendations;
            const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.results) ? raw.results : []);
            return list.map((item) => normalizeSeerrItem(item, mediaType)).filter(Boolean);
        })()
    };
}
