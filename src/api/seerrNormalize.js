/**
 * ============================================================================
 * Litefin Tizen - Jellyseerr Result Normalization
 * ============================================================================
 * Converts TMDB results returned by Jellyseerr into Jellyfin-shaped items so
 * that MediaGrid and CardRenderer can display them unchanged. Kept free of
 * imports so it stays runnable under node for check-seerr-normalize.mjs.
 * ============================================================================
 */

const TMDB_IMAGE_ORIGIN = 'https://image.tmdb.org/';
let resolveImageBase = () => null;

/**
 * Registers the function that decides where TMDB images are served from. It
 * is called every time a URL is built and returns the Litefin server plugin's
 * Seerr image proxy (e.g. `${serverUrl}/Litefin/Seerr/Image`), or a falsy
 * value to load images straight from TMDB.
 * @param {(() => string|null)|null} fn
 */
export function setTmdbImageResolver(fn) {
    resolveImageBase = typeof fn === 'function' ? fn : () => null;
}

/**
 * Rewrites a complete TMDB image URL onto the current image base. Any other
 * value (non-TMDB URLs, empty strings, no proxy available) is returned unchanged.
 * Prefer tmdbUrl() when building a URL from a size and a path.
 * @param {string} url
 * @returns {string}
 */
export function tmdbImage(url) {
    if (typeof url !== 'string' || !url.startsWith(TMDB_IMAGE_ORIGIN)) return url;
    const base = resolveImageBase();
    return base ? base.replace(/\/+$/, '') + '/' + url.slice(TMDB_IMAGE_ORIGIN.length) : url;
}

/**
 * Builds a TMDB image URL for a size and a file path, routed through the image
 * proxy when one is available.
 * @param {string} size - e.g. 'w300' or 'w780_filter(duotone,ffffff,bababa)'
 * @param {string} path - TMDB file path, with or without the leading slash
 * @returns {string} The URL, or '' when there is no path
 */
export function tmdbUrl(size, path) {
    if (!path || typeof path !== 'string') return '';
    return tmdbImage(`${TMDB_IMAGE_ORIGIN}t/p/${size}${path.charAt(0) === '/' ? '' : '/'}${path}`);
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
 * TMDB keyword ID Seerr uses to classify a series as anime (mirrors
 * ANIME_KEYWORD_ID in the Seerr source). It is a keyword, not a genre:
 * TMDB has no anime TV genre, so the keyword is the only reliable marker.
 */
export const SEERR_ANIME_KEYWORD_ID = 210024;

/** Poll delay while Seerr reports a running download (details page). */
export const SEERR_DOWNLOAD_POLL_ACTIVE_MS = 15000;

/** Poll delay while a request is approved but no download has started yet. */
export const SEERR_DOWNLOAD_POLL_IDLE_MS = 60000;

/**
 * Tells whether a normalized Seerr item is an anime. Anime routing only
 * applies to TV series — movies are never flagged. A missing keywords list
 * degrades to false (treated as a classic series), matching Seerr's own
 * fallback when it cannot detect.
 * @param {Object|null} item - Item produced by normalizeSeerrItem
 * @returns {boolean}
 */
export function isSeerrAnimeItem(item) {
    if (!item || item._mediaType !== 'tv') return false;
    if (!Array.isArray(item.Tags)) return false;
    return item.Tags.some((tag) => tag && Number(tag.Id) === SEERR_ANIME_KEYWORD_ID);
}

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
            // Awaiting admin approval — not yet picked up by the downloader
            return 'SeerrStatusPending';
        case SEERR_STATUS.PROCESSING:
            // Approved by admin, downloader is actively working on it
            return 'SeerrStatusProcessing';
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

// ============================================================================
// Request State
// ============================================================================
// Single home for the rules that turn Seerr's status enums into UI decisions,
// so cards, the details page and the request modal cannot drift apart.

/**
 * Whether a season is already covered by Seerr (available, or requested and not
 * yet declined). Partially available, unknown and deleted seasons stay open.
 * @param {number} [status] - MediaStatus value of one season
 * @returns {boolean}
 */
export function isSeerrSeasonCovered(status) {
    return status === SEERR_STATUS.AVAILABLE || status === SEERR_STATUS.PENDING || status === SEERR_STATUS.PROCESSING;
}

/**
 * Whether any season of a series can still be requested.
 * @param {Array<{status: number}>} seasons - Result of SeerrClient.tvSeasons
 * @returns {boolean}
 */
export function hasUnrequestedSeerrSeasons(seasons) {
    if (!Array.isArray(seasons)) return false;
    return seasons.some((season) => season && !isSeerrSeasonCovered(season.status));
}

/**
 * Which request actions the details page offers for an item.
 *
 * Cancel rules follow Seerr: a PENDING request is only a queue entry any user
 * may withdraw; once approved (PROCESSING and beyond) only Seerr admins can.
 * @param {Object} item - Item produced by normalizeSeerrItem
 * @param {Object} [context]
 * @param {boolean} [context.hasUnrequestedSeasons] - From hasUnrequestedSeerrSeasons; unknown counts as true
 * @param {boolean} [context.isAdmin] - Seerr ADMIN or MANAGE_REQUESTS permission
 * @returns {{requestable: boolean, canCancel: boolean, labelKey: string}}
 */
export function getSeerrRequestActions(item, context = {}) {
    const status = item ? item._seerrStatus : SEERR_STATUS.NOT_REQUESTED;
    const isTv = !!item && item._mediaType === 'tv';

    // Series: more seasons can be requested until everything is available.
    // Movies: only when nothing is requested yet.
    const requestable = isTv
        ? status !== SEERR_STATUS.AVAILABLE && context.hasUnrequestedSeasons !== false
        : status === SEERR_STATUS.NOT_REQUESTED || status === SEERR_STATUS.UNKNOWN || status === SEERR_STATUS.DELETED;

    const hasRequest = !!(item && item._requestId) && status !== SEERR_STATUS.AVAILABLE;
    const canCancel = hasRequest && (status === SEERR_STATUS.PENDING || !!context.isAdmin);

    // PARTIALLY_AVAILABLE → "Request More"; PENDING / PROCESSING → "View Request"
    let labelKey = 'SeerrRequest';
    if (isTv && status === SEERR_STATUS.PARTIALLY_AVAILABLE) {
        labelKey = 'SeerrRequestMore';
    } else if (isTv && (status === SEERR_STATUS.PENDING || status === SEERR_STATUS.PROCESSING)) {
        labelKey = 'SeerrViewRequest';
    }

    return { requestable, canCancel, labelKey };
}

/**
 * State shown by the small icon in the top-right corner of a Seerr card.
 * @param {Object} item - Item produced by normalizeSeerrItem
 * @returns {'downloading'|'requested'|'partial'|'available'|null}
 */
export function seerrCardState(item) {
    if (!item || item._seerrStatus === undefined || item._seerrStatus === null) return null;
    const status = item._seerrStatus;
    const isPartial = status === SEERR_STATUS.PARTIALLY_AVAILABLE;
    const isAvailable = status === SEERR_STATUS.AVAILABLE;

    // Like Seerr, a running download wins over every other state (even AVAILABLE, e.g. a 4K copy)
    if (Array.isArray(item._downloads) && item._downloads.length > 0) return 'downloading';
    if (
        status === SEERR_STATUS.PENDING ||
        status === SEERR_STATUS.PROCESSING ||
        (item._requestId && !isAvailable && !isPartial)
    ) {
        return 'requested';
    }
    if (isPartial) return 'partial';
    if (isAvailable) return 'available';
    return null;
}

// ============================================================================
// Download Progress
// ============================================================================

/**
 * Parses the *arr "timeLeft" duration ('00:18:30' or '1.02:00:00') into ms.
 * @param {string} [timeLeft]
 * @returns {number|null}
 */
function parseTimeLeft(timeLeft) {
    if (!timeLeft || typeof timeLeft !== 'string') return null;
    const match = /^(?:(\d+)\.)?(\d{1,2}):(\d{2}):(\d{2})/.exec(timeLeft.trim());
    if (!match) return null;
    const days = parseInt(match[1] || '0', 10);
    const hours = parseInt(match[2], 10);
    const minutes = parseInt(match[3], 10);
    const seconds = parseInt(match[4], 10);
    const ms = (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
    return ms > 0 ? ms : null;
}

/**
 * Converts one Seerr DownloadingItem into the shape the UI renders.
 * @param {Object} raw
 * @param {boolean} is4k
 * @param {number} now
 * @returns {Object|null}
 */
function normalizeDownload(raw, is4k, now) {
    if (!raw || typeof raw !== 'object') return null;

    const size = Number(raw.size) || 0;
    const sizeLeft = Number(raw.sizeLeft) || 0;
    // Same formula as Seerr's DownloadBlock: unknown size reads as 0%
    const percent = size > 0 ? Math.min(100, Math.max(0, Math.round(((size - sizeLeft) / size) * 100))) : 0;

    let etaMs = null;
    if (raw.estimatedCompletionTime) {
        const eta = new Date(raw.estimatedCompletionTime).getTime();
        if (!isNaN(eta) && eta > now) etaMs = eta - now;
    }
    if (etaMs === null) etaMs = parseTimeLeft(raw.timeLeft);

    const episode = raw.episode && typeof raw.episode === 'object' ? raw.episode : null;
    const toNumber = (value) => (typeof value === 'number' && !isNaN(value) ? value : null);

    return {
        title: typeof raw.title === 'string' ? raw.title : '',
        percent,
        status: typeof raw.status === 'string' ? raw.status : '',
        etaMs,
        is4k,
        season: episode ? toNumber(episode.seasonNumber) : null,
        episode: episode ? toNumber(episode.episodeNumber) : null,
        isSeasonPack: false,
        _downloadId: raw.downloadId || ''
    };
}

/**
 * Extracts the active downloads Seerr attaches to a media entry
 * (mediaInfo.downloadStatus / downloadStatus4k). Mirrors Seerr's own UI: when
 * every entry of a list shares one downloadId it is a season pack, shown once.
 * @param {Object|null} mediaInfo
 * @param {number} [now] - Reference time in ms, injectable for tests
 * @returns {Array<{title: string, percent: number, status: string, etaMs: number|null, is4k: boolean, season: number|null, episode: number|null, isSeasonPack: boolean}>}
 */
export function extractSeerrDownloads(mediaInfo, now = Date.now()) {
    if (!mediaInfo || typeof mediaInfo !== 'object') return [];

    const collect = (list, is4k) => {
        if (!Array.isArray(list)) return [];
        const items = list.map((raw) => normalizeDownload(raw, is4k, now)).filter(Boolean);
        const isPack =
            items.length > 1 && items.every((item) => item._downloadId && item._downloadId === items[0]._downloadId);
        if (isPack) {
            items[0].isSeasonPack = true;
            items[0].episode = null;
            return [items[0]];
        }
        return items;
    };

    return collect(mediaInfo.downloadStatus, false)
        .concat(collect(mediaInfo.downloadStatus4k, true))
        .map((item) => {
            delete item._downloadId;
            return item;
        });
}

/**
 * Splits a remaining duration into whole hours and minutes, rounded up so a
 * running download never reads "0 min".
 * @param {number|null} etaMs
 * @returns {{hours: number, minutes: number}|null}
 */
export function splitSeerrEta(etaMs) {
    if (typeof etaMs !== 'number' || isNaN(etaMs) || etaMs <= 0) return null;
    const totalMinutes = Math.max(1, Math.ceil(etaMs / 60000));
    return { hours: Math.floor(totalMinutes / 60), minutes: totalMinutes % 60 };
}

/**
 * Poll cadence for the details page: fast while Seerr reports a running
 * download, slow while an approved request waits for the downloader.
 * @param {Object|null} item - Item produced by normalizeSeerrItem
 * @returns {number} Delay in ms, or 0 when there is nothing to watch
 */
export function seerrDownloadPollDelay(item) {
    if (!item) return 0;
    if (Array.isArray(item._downloads) && item._downloads.length > 0) return SEERR_DOWNLOAD_POLL_ACTIVE_MS;
    if (item._seerrStatus === SEERR_STATUS.PROCESSING) return SEERR_DOWNLOAD_POLL_IDLE_MS;
    return 0;
}

/**
 * What the status badge shows for a running download, mirroring Seerr's own
 * badge: progress of the first download, an S1E3 / S1 tag and its ETA.
 * Text is left to the caller so this module stays free of i18n.
 * @param {Object|null} item - Item produced by normalizeSeerrItem
 * @returns {{percent: number, episodeTag: string, eta: {hours: number, minutes: number}|null}|null}
 */
export function describeSeerrDownloadBadge(item) {
    if (!item || !Array.isArray(item._downloads) || item._downloads.length === 0) return null;
    const first = item._downloads[0];

    let episodeTag = '';
    if (item._mediaType === 'tv' && first.season !== null) {
        episodeTag =
            first.isSeasonPack || first.episode === null ? `S${first.season}` : `S${first.season}E${first.episode}`;
    }

    return { percent: first.percent, episodeTag, eta: splitSeerrEta(first.etaMs) };
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

    const isPerson =
        result.mediaType === 'person' ||
        fallbackMediaType === 'person' ||
        (!result.mediaType && !!result.profilePath && !result.releaseDate && !result.firstAirDate && !result.title);

    const isTv =
        !isPerson &&
        (result.mediaType === 'tv' ||
            (fallbackMediaType && fallbackMediaType === 'tv') ||
            (!result.mediaType && (!!result.firstAirDate || !!result.seasons || !!result.numberOfSeasons)));

    const mediaType = isPerson ? 'person' : isTv ? 'tv' : 'movie';

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
        Type: isPerson ? 'Person' : isTv ? 'Series' : 'Movie',
        ProductionYear: extractYear(isTv ? result.firstAirDate : result.releaseDate),
        Overview: result.overview || '',
        // Read by CardRenderer to bypass Jellyfin URL building
        _imageUrl: tmdbUrl('w300', result.posterPath || result.profilePath),
        _detailImageUrl: tmdbUrl('w500', result.posterPath || result.profilePath),
        _backdropUrl: tmdbUrl('w1280', result.backdropPath),
        WatchProviders: Array.isArray(result.watchProviders) ? result.watchProviders : [],
        _seerrStatus: (result.mediaInfo && result.mediaInfo.status) || SEERR_STATUS.NOT_REQUESTED,
        _downloads: extractSeerrDownloads(result.mediaInfo),
        _jellyfinMediaId: (() => {
            const info = result.mediaInfo || {};
            return info.jellyfinMediaId || info.jellyfinMediaId4k || info.serviceId || info.externalServiceId || null;
        })(),
        _requestId: (() => {
            const requests = (result.mediaInfo && result.mediaInfo.requests) || result.requests || [];
            const firstReq = Array.isArray(requests) ? requests[0] : null;
            return firstReq ? firstReq.id || firstReq.requestId : null;
        })(),
        _tmdbId: result.id,
        _mediaType: mediaType,
        RunTimeTicks: (result.runtime || result.episodeRunTime?.[0] || 0) * 600000000,
        ReleaseDate: result.releaseDate || result.firstAirDate || '',
        Budget: typeof result.budget === 'number' && result.budget > 0 ? result.budget : null,
        Revenue: typeof result.revenue === 'number' && result.revenue > 0 ? result.revenue : null,
        MediaStatus: result.status || result.mediaStatus || '',
        NumberOfSeasons: (() => {
            if (typeof result.numberOfSeasons === 'number' && result.numberOfSeasons > 0) {
                return result.numberOfSeasons;
            }
            if (typeof result.number_of_seasons === 'number' && result.number_of_seasons > 0) {
                return result.number_of_seasons;
            }
            if (Array.isArray(result.seasons)) {
                const regular = result.seasons.filter((s) => s && (s.seasonNumber > 0 || s.season_number > 0));
                return regular.length > 0 ? regular.length : result.seasons.length;
            }
            return null;
        })(),
        Seasons: Array.isArray(result.seasons) ? result.seasons : [],
        OfficialRating: (() => {
            // Check direct properties if present
            if (result.certification) return String(result.certification).trim();
            if (result.rating) return String(result.rating).trim();

            // Check contentRatings (TV shows in Overseerr / TMDB)
            const rawCr = result.contentRatings || result.content_ratings;
            const crList = Array.isArray(rawCr) ? rawCr : rawCr && Array.isArray(rawCr.results) ? rawCr.results : [];
            if (crList.length > 0) {
                const usEntry = crList.find((r) => r && (r.iso_3166_1 === 'US' || r.iso3166_1 === 'US'));
                if (usEntry) {
                    const rating = usEntry.rating || usEntry.certification;
                    if (rating) return String(rating).trim();
                }
                // Fallback to first available rating if no US
                for (const entry of crList) {
                    const rating = entry && (entry.rating || entry.certification);
                    if (rating) return String(rating).trim();
                }
            }

            // Check releases (Movies in Overseerr / TMDB)
            const rawRel = result.releases || result.release_dates;
            const relList = Array.isArray(rawRel)
                ? rawRel
                : rawRel && Array.isArray(rawRel.results)
                  ? rawRel.results
                  : [];
            if (relList.length > 0) {
                const usEntry = relList.find((r) => r && (r.iso_3166_1 === 'US' || r.iso3166_1 === 'US'));
                if (usEntry) {
                    if (usEntry.rating) return String(usEntry.rating).trim();
                    if (usEntry.certification) return String(usEntry.certification).trim();
                    if (Array.isArray(usEntry.release_dates)) {
                        const cert = usEntry.release_dates.find((d) => d && d.certification)?.certification;
                        if (cert) return String(cert).trim();
                    }
                }
                // Fallback to first available rating if no US
                for (const entry of relList) {
                    if (entry) {
                        if (entry.rating) return String(entry.rating).trim();
                        if (entry.certification) return String(entry.certification).trim();
                        if (Array.isArray(entry.release_dates)) {
                            const cert = entry.release_dates.find((d) => d && d.certification)?.certification;
                            if (cert) return String(cert).trim();
                        }
                    }
                }
            }

            return '';
        })(),
        CommunityRating: typeof result.voteAverage === 'number' ? result.voteAverage : 0,
        Genres: Array.isArray(result.genres)
            ? result.genres
                  .map((g) =>
                      typeof g === 'object' && g
                          ? { Id: g.id || g.Id || '', Name: g.name || g.Name || '' }
                          : { Id: '', Name: String(g) }
                  )
                  .filter((g) => g && Boolean(g.Name))
            : [],
        Studios: Array.isArray(result.productionCompanies)
            ? result.productionCompanies
                  .map((c) =>
                      typeof c === 'object' && c
                          ? { Id: c.id || c.Id || '', Name: c.name || c.Name || '' }
                          : { Id: '', Name: String(c) }
                  )
                  .filter((c) => c && Boolean(c.Name))
            : [],
        ProductionTeam: (() => {
            // Combine creators (for TV series) and crew members into a unified candidate pool
            const rawCreators = (result.createdBy || result.created_by || []).map((c) => ({
                id: c.id || c.Id,
                name: c.name || c.Name,
                job: 'Creator'
            }));
            const rawCrew = [...rawCreators, ...((result.credits && result.credits.crew) || result.crew || [])];
            if (!Array.isArray(rawCrew) || rawCrew.length === 0) return [];

            // Limit the maximum number of people per key production role
            const jobLimits = {
                creator: 2,
                director: 2,
                writer: 2,
                screenplay: 2,
                editor: 1,
                producer: 2,
                'co-producer': 1
            };
            const counts = {};
            const team = [];
            const seen = new Set();

            for (const member of rawCrew) {
                const job = (member.job || '').trim().toLowerCase();
                const name = typeof member === 'string' ? member : member && (member.name || member.Name);
                if (!name) continue;

                const limit = jobLimits[job];
                if (limit) {
                    counts[job] = counts[job] || 0;
                    if (counts[job] < limit) {
                        const key = name.trim().toLowerCase();
                        if (!seen.has(key)) {
                            seen.add(key);
                            // Preserve TMDB person ID alongside name and job title
                            team.push({
                                Id: member.id || member.Id || '',
                                Name: name.trim(),
                                Job: member.job || ''
                            });
                        }
                        counts[job]++;
                    }
                }
            }
            return team;
        })(),
        Cast: (() => {
            const rawCast = (result.credits && result.credits.cast) || result.cast || [];
            if (!Array.isArray(rawCast)) return [];
            return rawCast.map((c) => ({
                Id: c.id,
                Name: c.name,
                Role: c.character || '',
                Type: 'Person',
                _imageUrl: tmdbUrl('w300', c.profilePath)
            }));
        })(),
        Tags: (() => {
            const rawKw = result.keywords;
            const kwList = Array.isArray(rawKw)
                ? rawKw
                : rawKw && Array.isArray(rawKw.results)
                  ? rawKw.results
                  : rawKw && Array.isArray(rawKw.keywords)
                    ? rawKw.keywords
                    : [];
            return kwList
                .map((k) => {
                    if (!k) return null;
                    if (typeof k === 'object') {
                        return { Id: k.id || k.Id || '', Name: k.name || k.Name || '' };
                    }
                    return { Id: '', Name: String(k) };
                })
                .filter((k) => k && Boolean(k.Name));
        })(),
        RemoteTrailers: (() => {
            const raw = result.relatedVideos || result.videos || [];
            const list = Array.isArray(raw) ? raw : raw && Array.isArray(raw.results) ? raw.results : [];
            return list
                .filter((v) => {
                    const site = (v && v.site ? String(v.site) : '').toLowerCase();
                    const type = (v && v.type ? String(v.type) : '').toLowerCase();
                    return site === 'youtube' && type === 'trailer';
                })
                .map((v) => {
                    const key = v.key || v.url || '';
                    const url = key.startsWith('http') ? key : key ? `https://www.youtube.com/watch?v=${key}` : '';
                    return {
                        Name: v.name || `${result.title || result.name || 'Media'} Trailer`,
                        Url: url
                    };
                })
                .filter((v) => Boolean(v.Url));
        })(),
        Tagline: result.tagline || '',
        collection:
            result.collection ||
            (result.belongsToCollection
                ? { id: result.belongsToCollection.id, name: result.belongsToCollection.name }
                : null),
        Similar: (() => {
            const raw = result.similar;
            const list = Array.isArray(raw) ? raw : raw && Array.isArray(raw.results) ? raw.results : [];
            return list.map((item) => normalizeSeerrItem(item, mediaType)).filter(Boolean);
        })(),
        Recommendations: (() => {
            const raw = result.recommendations;
            const list = Array.isArray(raw) ? raw : raw && Array.isArray(raw.results) ? raw.results : [];
            return list.map((item) => normalizeSeerrItem(item, mediaType)).filter(Boolean);
        })()
    };
}
