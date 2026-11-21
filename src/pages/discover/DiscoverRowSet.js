/**
 * ============================================================================
 * Litefin Tizen - Discover Row Set
 * ============================================================================
 * Decides which rows the Discover page shows, in which order, and how each
 * row loads its items. Follows the Seerr discover slider configuration
 * (order, enabled state, custom rows) when the server plugin exposes it and
 * falls back to the built-in row list otherwise (older plugins, errors).
 *
 * The Discover page only renders: it never sees Seerr slider types.
 * ============================================================================
 */

import { seerr } from '../../api/seerrClient.js';
import { SEERR_SLIDER_TYPE, catalogQueryFromSlider, fetchCatalogPage } from '../../api/SeerrCatalog.js';
import { i18n } from '../../utils/i18n.js';
import { logger } from '../../utils/Logger.js';

const log = logger.create('DiscoverRowSet');

const T = SEERR_SLIDER_TYPE;

/**
 * Built-in rows in their default order. `type` is the matching Seerr slider type;
 * keys are stable because focus restoration and the page cache are keyed by them.
 */
const BUILT_IN_ROWS = [
    {
        type: T.RECENTLY_ADDED,
        key: 'recentlyAdded',
        titleKey: 'SeerrRecentlyAdded',
        defaultTitle: 'Recently Added',
        cardType: 'poster',
        fetch: (client) => client.recentlyAdded()
    },
    {
        type: T.RECENT_REQUESTS,
        key: 'requests',
        titleKey: 'SeerrMyRequests',
        defaultTitle: 'My Requests',
        cardType: 'poster',
        fetch: (client) => client.requests()
    },
    {
        type: T.PLEX_WATCHLIST,
        key: 'watchlist',
        titleKey: 'SeerrWatchlist',
        defaultTitle: 'Watchlist',
        cardType: 'poster',
        fetch: (client) => client.watchlist()
    },
    {
        type: T.TRENDING,
        key: 'trending',
        titleKey: 'SeerrTrending',
        defaultTitle: 'Trending',
        cardType: 'poster',
        fetch: (client) => client.discoverTrending()
    },
    {
        type: T.POPULAR_MOVIES,
        key: 'movies',
        titleKey: 'SeerrPopularMovies',
        defaultTitle: 'Popular Movies',
        cardType: 'poster',
        fetch: (client) => client.discoverMovies()
    },
    {
        type: T.MOVIE_GENRES,
        key: 'genreMovies',
        titleKey: 'SeerrMovieGenres',
        defaultTitle: 'Movie Genres',
        cardType: 'landscape',
        noCardLabels: true,
        fetch: (client) => client.genreSliderMovies()
    },
    {
        type: T.UPCOMING_MOVIES,
        key: 'upcomingMovies',
        titleKey: 'SeerrUpcomingMovies',
        defaultTitle: 'Upcoming Movies',
        cardType: 'poster',
        fetch: (client) => client.upcomingMovies()
    },
    {
        type: T.STUDIOS,
        key: 'studios',
        titleKey: 'SeerrStudios',
        defaultTitle: 'Studios',
        cardType: 'landscape',
        noCardLabels: true,
        fetch: (client) => client.studios()
    },
    {
        type: T.POPULAR_TV,
        key: 'series',
        titleKey: 'SeerrPopularSeries',
        defaultTitle: 'Popular Series',
        cardType: 'poster',
        fetch: (client) => client.discoverTv()
    },
    {
        type: T.TV_GENRES,
        key: 'genreSeries',
        titleKey: 'SeerrSeriesGenres',
        defaultTitle: 'Series Genres',
        cardType: 'landscape',
        noCardLabels: true,
        fetch: (client) => client.genreSliderTv()
    },
    {
        type: T.UPCOMING_TV,
        key: 'upcomingSeries',
        titleKey: 'SeerrUpcomingSeries',
        defaultTitle: 'Upcoming Series',
        cardType: 'poster',
        fetch: (client) => client.upcomingTv()
    },
    {
        type: T.NETWORKS,
        key: 'networks',
        titleKey: 'SeerrNetworks',
        defaultTitle: 'Networks',
        cardType: 'landscape',
        noCardLabels: true,
        fetch: (client) => client.networks()
    }
];

/**
 * Wraps a fetch so a failing endpoint yields an empty row instead of breaking the page.
 * @private
 */
function safeLoad(key, fetchFn) {
    return async () => {
        try {
            const items = await fetchFn();
            return Array.isArray(items) ? items : [];
        } catch (err) {
            log.warn(`Discover row fetch failed for "${key}"`, err);
            return [];
        }
    };
}

/** @private */
function builtInRow(def, client) {
    return {
        key: def.key,
        title: i18n.t(def.titleKey, [def.defaultTitle]),
        cardType: def.cardType,
        noCardLabels: Boolean(def.noCardLabels),
        load: safeLoad(def.key, () => def.fetch(client))
    };
}

/** @private */
function rowsFromSliders(sliders, client) {
    if (!Array.isArray(sliders)) return [];

    const ordered = sliders
        .map((slider, index) => ({ slider, index }))
        .filter(({ slider }) => slider && slider.enabled !== false)
        .sort((a, b) => (a.slider.order ?? a.index) - (b.slider.order ?? b.index) || a.index - b.index)
        .map(({ slider }) => slider);

    const rows = [];
    const seenKeys = new Set();
    for (const slider of ordered) {
        const def = BUILT_IN_ROWS.find((d) => d.type === slider.type);
        let row = null;

        if (def) {
            row = builtInRow(def, client);
        } else {
            const query = catalogQueryFromSlider(slider);
            if (!query) {
                log.debug('Skipping unsupported Seerr discover slider', { id: slider.id, type: slider.type });
                continue;
            }
            const key = `custom-${slider.id}`;
            row = {
                key,
                title: slider.title || i18n.t('SeerrDiscover', ['Discover']),
                cardType: 'poster',
                noCardLabels: false,
                load: safeLoad(key, () => fetchCatalogPage(query, 1, client))
            };
        }

        if (seenKeys.has(row.key)) continue;
        seenKeys.add(row.key);
        rows.push(row);
    }
    return rows;
}

/**
 * Resolves the Discover rows.
 *
 * @param {Object} [options]
 * @param {Object} [options.cached] - cacheEntry from a previous call; when given, no network request is made
 * @param {Object} [deps]
 * @param {Object} [deps.client=seerr] - Seerr client (injectable for tests)
 * @returns {Promise<{ rows: Array<{ key: string, title: string, cardType: string, noCardLabels: boolean, load: () => Promise<Array> }>, cacheEntry: { sliders: Array|null } }>}
 *   `rows` in display order; `load()` never throws. `cacheEntry` is opaque — store it with the page cache
 *   and pass it back as `cached` to rebuild the same rows instantly.
 */
export async function resolveDiscoverRows({ cached } = {}, { client = seerr } = {}) {
    const sliders = cached !== undefined ? (cached && cached.sliders) || null : await client.discoverSettings();

    let rows = rowsFromSliders(sliders, client);
    if (rows.length === 0) {
        rows = BUILT_IN_ROWS.map((def) => builtInRow(def, client));
    }

    return { rows, cacheEntry: { sliders: sliders || null } };
}
