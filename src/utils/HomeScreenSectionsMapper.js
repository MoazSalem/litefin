/**
 * ============================================================================
 * Litefin Tizen - Home Screen Sections Mapper
 * ============================================================================
 *
 * Pure helpers that turn the Home Screen Sections server plugin
 * (IAmParadox27/jellyfin-plugin-home-sections) responses into Litefin row
 * data. The module has no imports so it can be unit-tested without the app
 * runtime; network access lives in HomeScreenSections.js.
 * ============================================================================
 */

export const HSS_ROW_ID_PREFIX = 'hss-';

/** Storage key holding the last loaded section list for the Home layout editor. */
export const HSS_SECTIONS_STORAGE_KEY = 'home:hssSections';

/**
 * Sections Litefin already renders natively: My Media, Continue Watching, Next Up,
 * Live TV, and the per-library "Recently Added" rows (sorted by date added, like
 * Litefin's own "Recently Added in <library>" rows). Kept on purpose:
 * "Latest *" (sorted by release date) and "RecentlyAddedArtists" (artists, not media).
 */
export const DUPLICATE_SECTIONS = [
    'MyMedia',
    'ContinueWatching',
    'NextUp',
    'ContinueWatchingNextUp',
    'LiveTV',
    'RecentlyAddedMovies',
    'RecentlyAddedShows',
    'RecentlyAddedAlbums',
    'RecentlyAddedBooks',
    'RecentlyAddedAudioBooks',
    'RecentlyAddedMusicVideos',
    'RecentlyAddedInLibrary'
];

/** Sections whose items come from Jellyseerr and only exist as TMDB entries. */
export const DISCOVER_SECTIONS = ['Discover', 'DiscoverMovies', 'DiscoverTV'];

/** Server-side container class of the Top Ten section. */
const TOP_TEN_CONTAINER_CLASS = 'top-ten';

/**
 * @param {string} key - HSS section type (e.g. 'Genre')
 * @returns {boolean}
 */
export function isDiscoverSection(key) {
    return DISCOVER_SECTIONS.indexOf(key) !== -1;
}

/**
 * Upcoming sections are fed by Sonarr / Radarr / Lidarr / Readarr calendars.
 * @param {string} key
 * @returns {boolean}
 */
export function isUpcomingSection(key) {
    return typeof key === 'string' && key.indexOf('Upcoming') === 0;
}

/**
 * Whether a Home row id belongs to a Home Screen Sections row.
 * @param {string} id
 * @returns {boolean}
 */
export function isHssRowId(id) {
    return typeof id === 'string' && id.indexOf(HSS_ROW_ID_PREFIX) === 0;
}

/**
 * Keeps the sections Litefin should render, in server order.
 * Drops the duplicates of native rows and, when Seerr is not available in
 * Litefin, the Discover sections (their cards could not open anything).
 *
 * @param {Array<Object>} items - HomeScreenSectionInfo list from /HomeScreen/Sections
 * @param {{ seerrAvailable: boolean }} options
 * @returns {Array<Object>}
 */
export function filterSections(items, { seerrAvailable }) {
    if (!Array.isArray(items)) return [];
    return items
        .map((info, index) => ({ info, index }))
        .filter(({ info }) => {
            const key = info && info.Section;
            if (!key || DUPLICATE_SECTIONS.indexOf(key) !== -1) return false;
            return seerrAvailable || !isDiscoverSection(key);
        })
        .sort((a, b) => (a.info.OrderIndex || 0) - (b.info.OrderIndex || 0) || a.index - b.index)
        .map(({ info }) => info);
}

/**
 * Normalizes sections into plain records with stable slot ids. Sections such as
 * Genre or Because You Watched can appear several times with a different
 * AdditionalData on every load, so ids count per type (`hss-Genre-1`,
 * `hss-Genre-2`) instead of naming the content. The Home layout editor keeps
 * the user's order and visibility per slot.
 *
 * @param {Array<Object>} sections - Filtered HomeScreenSectionInfo list
 * @returns {Array<{id: string, section: string, title: string, additionalData: string|null,
 *   viewMode: string|null, containerClass: string|null, displayTitleText: boolean}>}
 */
export function assignSlotIds(sections) {
    const counts = {};
    return sections.map((info) => {
        const key = info.Section;
        counts[key] = (counts[key] || 0) + 1;
        return {
            id: `${HSS_ROW_ID_PREFIX}${key}-${counts[key]}`,
            section: key,
            title: info.DisplayText || key,
            additionalData: info.AdditionalData || null,
            viewMode: info.ViewMode || null,
            containerClass: info.ContainerClass || null,
            displayTitleText: info.DisplayTitleText !== false
        };
    });
}

/**
 * Maps the HSS ViewMode onto a Litefin row layout and card type.
 * @param {string|null} viewMode - 'Portrait' | 'Landscape' | 'Square' | 'Small'
 * @returns {{layout: string, cardType: string}}
 */
export function viewModeToLayout(viewMode) {
    if (viewMode === 'Landscape' || viewMode === 'Small') return { layout: 'landscape', cardType: 'thumb' };
    if (viewMode === 'Square') return { layout: 'square', cardType: 'square' };
    return { layout: 'portrait', cardType: 'poster' };
}

/**
 * Resolves image URLs the plugin returns relative to the server
 * (e.g. `/HomeScreen/CachedImage/<key>`).
 * @param {string|null} url
 * @param {string} serverUrl
 * @returns {string|null}
 */
export function absoluteUrl(url, serverUrl) {
    if (!url || typeof url !== 'string') return null;
    if (/^https?:\/\//i.test(url)) return url;
    const base = String(serverUrl || '').replace(/\/+$/, '');
    return url.charAt(0) === '/' ? `${base}${url}` : `${base}/${url}`;
}

/**
 * Builds a card item for an entry that does not exist in the Jellyfin library.
 * Every pseudo item has the same fields so card rendering sees one object shape.
 * The id always carries the `hss-` prefix: the plugin hands out random GUIDs for
 * Upcoming entries, and those must never reach item or playback endpoints.
 * @private
 */
function createPseudoItem(fields) {
    return {
        Id: fields.Id,
        Name: fields.Name || '',
        Type: fields.Type,
        SeriesName: null,
        ProductionYear: fields.ProductionYear || null,
        PremiereDate: fields.PremiereDate || null,
        CommunityRating: fields.CommunityRating || null,
        _imageUrl: fields._imageUrl || null,
        _subtitleOverride: fields._subtitleOverride || null,
        _rank: null,
        _hideCardLabels: false,
        _hssDisplayOnly: !!fields._hssDisplayOnly,
        _hssSeerr: fields._hssSeerr || null
    };
}

/**
 * @param {string|null} date
 * @returns {number|null}
 */
function yearOf(date) {
    if (!date) return null;
    const year = new Date(date).getFullYear();
    return Number.isNaN(year) || year <= 1970 ? null : year;
}

/**
 * Maps a Discover (Jellyseerr) entry to a card that opens the Seerr details page.
 * @param {Object} item - BaseItemDto built by the plugin
 * @param {string} serverUrl
 * @returns {Object|null} null when the entry has no TMDB id
 */
export function mapDiscoverItem(item, serverUrl) {
    const ids = (item && item.ProviderIds) || {};
    const tmdbId = ids.Jellyseerr ? String(ids.Jellyseerr) : null;
    if (!tmdbId) return null;

    const mediaType = item.SourceType === 'tv' ? 'tv' : 'movie';
    return createPseudoItem({
        Id: `${HSS_ROW_ID_PREFIX}seerr-${mediaType}-${tmdbId}`,
        Name: item.Name,
        Type: mediaType === 'tv' ? 'Series' : 'Movie',
        ProductionYear: yearOf(item.PremiereDate),
        PremiereDate: item.PremiereDate,
        CommunityRating: item.CommunityRating,
        _imageUrl: absoluteUrl(ids.JellyseerrPoster, serverUrl),
        _hssSeerr: { mediaType, tmdbId }
    });
}

/**
 * Maps an Upcoming (Sonarr / Radarr / Lidarr / Readarr) entry to a display-only
 * card. The arr services expose no TMDB or Jellyfin id, so there is nothing to open.
 * @param {Object} item
 * @param {string} serverUrl
 * @param {number} index - Position in the row, keeps ids unique
 * @returns {Object}
 */
export function mapUpcomingItem(item, serverUrl, index) {
    const ids = (item && item.ProviderIds) || {};
    let type = 'Movie';
    let poster = ids.RadarrPoster;
    let sourceId = ids.RadarrMovieId;
    if (item.Type === 'Episode' || ids.SonarrSeriesId) {
        type = 'Series';
        poster = ids.SonarrPoster;
        sourceId = ids.SonarrEpisodeId;
    } else if (item.Type === 'MusicAlbum' || ids.LidarrAlbumId) {
        type = 'MusicAlbum';
        poster = ids.LidarrPoster;
        sourceId = ids.LidarrAlbumId;
    } else if (item.Type === 'Book' || ids.ReadarrBookId) {
        type = 'Book';
        poster = ids.ReadarrPoster;
        sourceId = ids.ReadarrBookId;
    }

    const subtitle = [ids.EpisodeInfo, ids.FormattedDate].filter(Boolean).join(' · ');
    return createPseudoItem({
        Id: `${HSS_ROW_ID_PREFIX}upcoming-${type}-${sourceId || index}`,
        Name: item.SeriesName || item.Name,
        Type: type,
        ProductionYear: item.ProductionYear || yearOf(item.PremiereDate),
        PremiereDate: item.PremiereDate,
        _imageUrl: absoluteUrl(poster, serverUrl),
        _subtitleOverride: subtitle || null,
        _hssDisplayOnly: true
    });
}

/**
 * Whether a card's item id belongs to a pseudo item (Discover / Upcoming) that
 * must not reach item or playback endpoints. Real Jellyfin ids are 32 hex chars.
 * @param {string|null} id
 * @returns {boolean}
 */
export function isHssPseudoId(id) {
    return typeof id === 'string' && id.indexOf(HSS_ROW_ID_PREFIX) === 0;
}

/**
 * Maps the raw items of one section to card items.
 * @param {Object} section - Record from assignSlotIds()
 * @param {Array<Object>} items - Items returned by /HomeScreen/Section/{type}
 * @param {{ serverUrl: string, limit: number }} options
 * @returns {Array<Object>}
 */
export function mapSectionItems(section, items, { serverUrl, limit }) {
    if (!Array.isArray(items)) return [];
    let mapped;
    if (isDiscoverSection(section.section)) {
        mapped = items.map((item) => mapDiscoverItem(item, serverUrl)).filter(Boolean);
    } else if (isUpcomingSection(section.section)) {
        mapped = items.map((item, index) => mapUpcomingItem(item, serverUrl, index));
    } else {
        mapped = items.filter((item) => item && item.Id);
    }

    mapped = mapped.slice(0, limit > 0 ? limit : mapped.length);

    const isTopTen = section.containerClass === TOP_TEN_CONTAINER_CLASS;
    const hideLabels = section.displayTitleText === false;
    if (isTopTen || hideLabels) {
        // Copy before tagging so the plugin's response objects stay untouched
        mapped = mapped.map((item, index) => ({
            ...item,
            _rank: isTopTen ? index + 1 : item._rank || null,
            _hideCardLabels: hideLabels
        }));
    }
    return mapped;
}
