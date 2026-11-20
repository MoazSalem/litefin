/**
 * ============================================================================
 * Litefin - Next Up Activity Dates
 * ============================================================================
 * Resolves the date Jellyfin itself ranks a series by in Next Up: the
 * LastPlayedDate of the furthest-watched (highest season/episode) non-special
 * episode. Rewatching or marking an earlier episode does not change this date,
 * so merged Continue Watching + Next Up rows keep the series in place.
 * Mirrors the Litefin server plugin's MergedRows ranking.
 * ============================================================================
 */

import { api } from '../api/ApiClient.js';
import { logger } from './Logger.js';

const log = logger.create('NextUpActivity');

/**
 * Fetch the furthest-watched episode's play date for each series.
 *
 * @param {string[]} seriesIds - Series IDs (duplicates and empty values allowed)
 * @returns {Promise<Object<string, number>>} seriesId → timestamp in ms; series
 *   without a played non-special episode are omitted
 */
export async function getSeriesLastWatchedDates(seriesIds) {
    const map = {};
    const uniqueIds = [...new Set(seriesIds.filter(Boolean))];

    await Promise.all(
        uniqueIds.map(async (seriesId) => {
            try {
                /* Highest season/episode first; specials (season 0) sort last. */
                const res = await api.getItems({
                    ParentId: seriesId,
                    IncludeItemTypes: 'Episode',
                    IsPlayed: true,
                    SortBy: 'ParentIndexNumber,IndexNumber',
                    SortOrder: 'Descending',
                    EnableImages: false,
                    Limit: 1
                });
                const ep = res?.Items?.[0];
                const lastPlayed = ep && ep.ParentIndexNumber !== 0 ? ep.UserData?.LastPlayedDate : null;
                if (lastPlayed) {
                    map[seriesId] = new Date(lastPlayed).getTime();
                }
            } catch (err) {
                log.warn(`Failed to fetch last watched episode for series ${seriesId}:`, err?.message || err);
            }
        })
    );

    return map;
}
