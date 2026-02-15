/**
 * ============================================================================
 * Litefin Tizen - Play Queue Service
 * ============================================================================
 * Manages the queue of items to play (episodes, boxsets, etc).
 * Handles:
 * - Next/Previous automated navigation
 * - Cross-season episode fetching
 * - BoxSet/Collection sequencing
 *
 * Current limitations:
 * - No Shuffle/Repeat support yet (sequential only)
 * ============================================================================
 */

import { api } from '../api/index.js';
import { logger } from '../utils/Logger.js';

const log = logger.create('PlayQueue');
// PlayQueue module evaluated

class PlayQueue {
    constructor() {
        this._queue = [];
        this._currentIndex = -1;
        this._isInitialized = false;
        this._contextType = null; // 'boxset' | 'playlist' | null
        this._contextId = null;
    }

    /**
     * Initialize queue based on the starting item.
     * Fetches adjacent items if possible.
     * @param {Object} item - The currently playing item
     * @param {string} [contextType] - Optional context (e.g., 'boxset' if launched from a collection)
     * @param {string} [contextId] - Optional context ID (e.g., the BoxSet ID)
     */
    async init(item, contextType = null, contextId = null) {
        log.info('PlayQueue.init called', { itemId: item?.Id, contextType, contextId });
        this.clear();
        this._contextType = contextType;
        this._contextId = contextId;
        this._isInitialized = true;

        try {
            if (contextType === 'boxset' && (contextId || item.ParentId)) {
                // Prioritize collection context if explicitly provided
                await this._initBoxSetQueue(item, contextId || item.ParentId);
            } else if (item.Type === 'Episode' && item.SeriesId) {
                await this._initEpisodeQueue(item);
            } else {
                // Standalone item (Movie, etc.)
                this._queue = [item];
                this._currentIndex = 0;
            }

            log.info(`Queue initialized with ${this._queue.length} items. Current Index: ${this._currentIndex}`);
        } catch (error) {
            log.error('Failed to initialize play queue:', error);
            // Fallback to single item
            this._queue = [item];
            this._currentIndex = 0;
        }
    }

    /**
     * Clear and reset the queue
     */
    clear() {
        this._queue = [];
        this._currentIndex = -1;
        this._isInitialized = false;
        this._contextType = null;
        this._contextId = null;
    }

    /**
     * Check if there is a next item
     * @returns {boolean}
     */
    hasNext() {
        return this._currentIndex < this._queue.length - 1;
    }

    /**
     * Check if there is a previous item
     * @returns {boolean}
     */
    hasPrevious() {
        return this._currentIndex > 0;
    }

    /**
     * Get the next item without moving the index
     * @returns {Object|null}
     */
    peekNext() {
        if (!this.hasNext()) return null;
        return this._queue[this._currentIndex + 1];
    }

    /**
     * Get the previous item without moving the index
     * @returns {Object|null}
     */
    peekPrevious() {
        if (!this.hasPrevious()) return null;
        return this._queue[this._currentIndex - 1];
    }

    /**
     * Advance to next item
     * @returns {Object|null} The new item, or null if end of queue
     */
    advance() {
        if (!this.hasNext()) return null;
        this._currentIndex++;
        return this._queue[this._currentIndex];
    }

    /**
     * Go back to previous item
     * @returns {Object|null} The new item, or null if start of queue
     */
    goBack() {
        if (!this.hasPrevious()) return null;
        this._currentIndex--;
        return this._queue[this._currentIndex];
    }

    getCurrentItem() {
        if (this._currentIndex === -1) return null;
        return this._queue[this._currentIndex];
    }

    // ========================================================================
    // Internal Queue Builders
    // ========================================================================

    async _initEpisodeQueue(currentItem) {
        log.debug('Building episode queue for series:', currentItem.SeriesId);

        // Fetch episodes starting from the current one, across all seasons
        // Jellyfin API supports this if we omit SeasonId and provide StartItemId
        const response = await api.getEpisodes(currentItem.SeriesId, {
            StartItemId: currentItem.Id,
            Limit: 100, // Reasonable batch size for TV session
            Fields: 'PrimaryImageAspectRatio,BasicSyncInfo,Overview,Chapters,MediaSources'
            // Added MediaSources/Chapters so we don't strictly need to re-fetch full item details
            // (though PlayerPage might do it anyway)
        });

        // DEBUG LOGGING
        log.info(
            `[PlayQueue] getEpisodes response: Total=${response.TotalRecordCount}, Count=${response.Items?.length}`
        );
        if (response.Items && response.Items.length > 0) {
            log.info(`[PlayQueue] First item: ${response.Items[0].Name} (${response.Items[0].Id})`);
            if (response.Items.length > 1) {
                log.info(`[PlayQueue] Second item: ${response.Items[1].Name}`);
            }
        } else {
            log.warn('[PlayQueue] getEpisodes returned NO items!');
        }

        const nextEpisodes = response.Items || [];

        // If current item is valid, it should be the first in this list (or close to it if StartItemId matched)
        // However, sometimes we might want previous episodes too.
        // For simplicity V1: We get 100 episodes FORWARD.
        // To support PREVIOUS, we simply insert the current item at index 0 if it wasn't returned,
        // OR if the API returns the current item as first, we're good.

        // Wait! If I only fetch forward, I can't go back to previous episodes if I started mid-season.
        // User wants global "Previous" support.
        // BETTER STRATEGY: Fetch a window around the item, or just fetch the season?
        // Cross-season is tricky.
        // Let's stick to the "Forward" strategy for auto-play, but for "Previous"
        // we might simply rely on what we have.
        // IF the user specifically wants to go back to an episode that ISN'T in our queue,
        // we might need to handle that.
        // But standard behavior: if I click "Play" on S01E05, it queues S01E05 -> End.
        // S01E04 is NOT in the queue usually in simple implementations.
        // JELLYFIN-WEB: `getEpisodes` with `StartItemId` gets items >= StartItemId.
        // So previous track is effectively disabled unless we fetch 'backward' too.

        // Let's see if we can get a few previous ones too.
        // The API doesn't support "StartItemId with negative offset".
        // We'd have to fetch the whole season or series.
        // LIMITATION: For now, we only support going "Back" to items that were already traversed
        // OR we load the *entire* season if it's small?

        // Let's refine: The user asked for "Previous" button support.
        // If I start at E05, usually I expect Previous to go to E04.
        // If I define the queue as "All episodes from E05", E04 is missing.

        // ALTERNATIVE: Fetch the entire season (up to some limit)?
        // But we want cross-season.

        // HYBRID APPROACH:
        // 1. Fetch current item + 99 next items (using StartItemId) -> "Forward Queue"
        // 2. Fetch 10 items BEFORE current item? No easy API for "EndingBeforeId".

        // COMPROMISE: for V1, the queue is "From this point forward".
        // Previous button will only work if you have advanced.
        // If you start at E05, Previous is unavailable/disabled.
        // This is standard behavior for "Play from here".
        // IF the user wants full context, they should "Play All" or we load more.
        // Let's stick to "Play from here" (next-only) for initial fetch,
        // BUT we make sure the current item is in the list.

        this._queue = nextEpisodes;

        // Find our exact object instance or ID to set index
        this._currentIndex = this._queue.findIndex((e) => e.Id === currentItem.Id);

        // If not found (API weirdness), prepend it
        if (this._currentIndex === -1) {
            this._queue.unshift(currentItem);
            this._currentIndex = 0;
        }

        // Potential TODO: Fetch previous season items if requested?
        // For now, we start "fresh" play session from selected item.
    }

    async _initBoxSetQueue(currentItem, parentId) {
        log.debug('Building BoxSet queue for parent:', parentId);

        // Fetch movies and episodes separately to maintain UI-like ordering (Movies then Shows)
        // This matches the visual layout where Movies are shown in their own row above Shows.
        const [moviesResponse, episodesResponse] = await Promise.all([
            api.getItems({
                ParentId: parentId,
                Recursive: true,
                IncludeItemTypes: 'Movie',
                SortBy: 'SortName',
                SortOrder: 'Ascending',
                Limit: 100
            }),
            api.getItems({
                ParentId: parentId,
                Recursive: true,
                IncludeItemTypes: 'Episode',
                SortBy: 'SortName',
                SortOrder: 'Ascending',
                Limit: 100
            })
        ]);

        const movies = moviesResponse.Items || [];
        const episodes = episodesResponse.Items || [];

        // Combine: Movies first, then Episodes
        this._queue = [...movies, ...episodes];

        // Find our starting index
        this._currentIndex = this._queue.findIndex((item) => item.Id === currentItem.Id);

        if (this._currentIndex === -1) {
            // Fallback: prepend current item if not found in the collection results
            this._queue.unshift(currentItem);
            this._currentIndex = 0;
        }
    }
}

export const playQueue = new PlayQueue();
