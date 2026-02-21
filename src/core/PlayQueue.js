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

// ============================================================================
// PlaylistItemId Stamping
// ============================================================================
//
// Each item that enters the queue is given a session-unique PlaylistItemId
// (e.g. "playlistItem0", "playlistItem1", ...). This mirrors jellyfin-web's
// addUniquePlaylistItemId() pattern and is required for the NowPlayingQueue
// field in playback reports — the server uses it to identify queue slots
// independently of the item's actual Jellyfin Id.
//
let _playlistItemCounter = 0;

/**
 * Stamp a PlaylistItemId onto an item if it doesn't already have one.
 * Safe to call multiple times on the same item.
 * @param {Object} item - Queue item to stamp
 */
function _stampPlaylistItemId(item) {
    if (!item.PlaylistItemId) {
        item.PlaylistItemId = `playlistItem${_playlistItemCounter++}`;
    }
}

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
                // Standalone item (Movie, etc.) — stamp and queue
                _stampPlaylistItemId(item);
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
     * Clear and reset the queue.
     * Note: we do NOT reset _playlistItemCounter since it's module-level
     * and intentionally survives queue resets to keep IDs globally unique
     * within the app session.
     */
    clear() {
        this._queue = [];
        this._currentIndex = -1;
        this._isInitialized = false;
        this._contextType = null;
        this._contextId = null;
    }

    /**
     * Get a shallow copy of the full queue.
     * Used by PlayerPage to build the NowPlayingQueue payload for playback reports.
     * Each item will have a PlaylistItemId stamped on it.
     * @returns {Object[]}
     */
    getQueue() {
        return this._queue.slice(0);
    }

    /**
     * Explicitly replace the queue with a new ordered list.
     *
     * Called when a remote controller sends a queue-manipulation Play command
     * (e.g. remove item, reorder, jump-to-item). This bypasses the normal
     * async init() path so it can be applied mid-playback without re-fetching
     * anything from the server.
     *
     * Any items that already have a PlaylistItemId (carried over from the
     * server's NowPlayingQueue) are kept as-is; new ones are stamped fresh.
     *
     * @param {Object[]} items        - Full ordered array of media items
     * @param {number}   currentIndex - Index of the item that should be current
     */
    setQueue(items, currentIndex) {
        // Stamp any item that isn't already tagged — preserves IDs the server
        // sent back (via NowPlayingQueue) so PlaylistItemIds stay consistent.
        items.forEach(_stampPlaylistItemId);

        this._queue = items;
        this._currentIndex = Math.max(0, Math.min(currentIndex, items.length - 1));
        this._isInitialized = true;

        log.info(`Queue replaced via setQueue(): ${items.length} items, current index: ${this._currentIndex}`);
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

        // Fetch the ENTIRE series episode list (all seasons, all episodes).
        // We do NOT pass StartItemId so we get every episode, including those
        // before the one the user clicked — that way the Previous button works
        // correctly across season boundaries.
        const response = await api.getEpisodes(currentItem.SeriesId, {
            Limit: 500, // large enough for any series
            Fields: 'PrimaryImageAspectRatio,BasicSyncInfo,Overview,Chapters,MediaSources'
        });

        log.info(
            `[PlayQueue] getEpisodes response: Total=${response.TotalRecordCount}, Count=${response.Items?.length}`
        );

        const allEpisodes = response.Items || [];

        // Stamp a PlaylistItemId onto every episode in the queue
        allEpisodes.forEach(_stampPlaylistItemId);

        this._queue = allEpisodes;

        // Locate the starting episode — this is our current _currentIndex
        this._currentIndex = this._queue.findIndex((e) => e.Id === currentItem.Id);

        // Fallback: if not found (API weirdness), prepend the current item
        if (this._currentIndex === -1) {
            _stampPlaylistItemId(currentItem);
            this._queue.unshift(currentItem);
            this._currentIndex = 0;
        }
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

        // Combine: Movies first, then Episodes, and stamp each with a PlaylistItemId
        this._queue = [...movies, ...episodes];
        this._queue.forEach(_stampPlaylistItemId);

        // Find our starting index
        this._currentIndex = this._queue.findIndex((item) => item.Id === currentItem.Id);

        if (this._currentIndex === -1) {
            // Fallback: stamp and prepend current item if not found in the collection results
            _stampPlaylistItemId(currentItem);
            this._queue.unshift(currentItem);
            this._currentIndex = 0;
        }
    }
}

export const playQueue = new PlayQueue();
