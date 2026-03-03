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

import { eventBus } from './EventBus.js';

class PlayQueue {
    constructor() {
        this._queue = [];
        this._unshuffledQueue = []; // Holds the original order when shuffling
        this._currentIndex = -1;
        this._isInitialized = false;
        this._contextType = null; // 'boxset' | 'playlist' | null
        this._contextId = null;

        // Shuffle / Repeat state
        this._repeatMode = 'RepeatNone'; // 'RepeatNone' | 'RepeatAll' | 'RepeatOne'
        this._shuffleMode = false;
    }

    /**
     * Get current repeat mode
     * @returns {string}
     */
    getRepeatMode() {
        return this._repeatMode;
    }

    /**
     * Set the repeat mode
     * @param {string} mode - 'RepeatNone', 'RepeatAll', 'RepeatOne'
     */
    setRepeatMode(mode) {
        if (['RepeatNone', 'RepeatAll', 'RepeatOne'].includes(mode)) {
            this._repeatMode = mode;
            log.info(`RepeatMode set to: ${mode}`);
            eventBus.emit('playqueue:updated', {
                repeatMode: this._repeatMode,
                shuffleMode: this._shuffleMode
            });
        }
    }

    /**
     * Get current shuffle mode
     * @returns {boolean}
     */
    getShuffleMode() {
        return this._shuffleMode;
    }

    /**
     * Toggle shuffle mode on the current queue
     * @param {boolean} isShuffled
     */
    setShuffleMode(isShuffled) {
        if (this._shuffleMode === isShuffled) return;

        this._shuffleMode = isShuffled;
        log.info(`ShuffleMode set to: ${isShuffled}`);

        if (!this._isInitialized || this._queue.length === 0) {
            // State is saved but queue is empty, so no sorting needed yet
            return;
        }

        this._applyShuffle();
    }

    /**
     * Internal helper to apply shuffle/unshuffle based on _shuffleMode.
     * Ensures consistent behavior across setShuffleMode and init.
     */
    _applyShuffle() {
        if (!this._isInitialized || this._queue.length === 0) return;

        const currentItem = this.getCurrentItem();
        if (!currentItem) return;

        if (this._shuffleMode) {
            // Already shuffled? Avoid re-shuffling if un-shuffled queue exists
            // This prevents "shuffling the shuffle" and losing the origin
            if (this._unshuffledQueue.length > 0) return;

            // 1. Save original queue
            this._unshuffledQueue = [...this._queue];

            // 2. Remove the currently playing item from the pool to be shuffled
            const remainingItems = this._queue.filter((item) => item.PlaylistItemId !== currentItem.PlaylistItemId);

            // 3. Shuffle remaining items (Fisher-Yates)
            for (let i = remainingItems.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [remainingItems[i], remainingItems[j]] = [remainingItems[j], remainingItems[i]];
            }

            // 4. Rebuild queue: current item stays at front, shuffled items follow
            this._queue = [currentItem, ...remainingItems];
            this._currentIndex = 0;

            log.debug(`Shuffle applied to ${this._queue.length} items`);
        } else {
            // Restore original sort order
            if (this._unshuffledQueue.length > 0) {
                this._queue = [...this._unshuffledQueue];
                this._unshuffledQueue = []; // clear memory

                // Recalculate index of currently playing item
                this._currentIndex = this._queue.findIndex(
                    (item) => item.PlaylistItemId === currentItem.PlaylistItemId
                );

                if (this._currentIndex === -1) this._currentIndex = 0;
                log.debug('Shuffle restored to original order');
            }
        }

        eventBus.emit('playqueue:updated', {
            repeatMode: this._repeatMode,
            shuffleMode: this._shuffleMode
        });
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
            if ((contextType === 'boxset' || contextType === 'music') && (contextId || item.ParentId)) {
                // Prioritize collection context if explicitly provided
                await this._initBoxSetQueue(item, contextId || item.ParentId);
            } else if (contextType === 'season' && contextId) {
                // Season-specific shuffle: fetch only episodes for this season
                await this._initSeasonQueue(item, contextId);
            } else if (item.Type === 'Episode' && item.SeriesId) {
                await this._initEpisodeQueue(item);
            } else if (item.Type === 'Audio' && item.AlbumId) {
                // Auto-init album queue for songs played standalone
                await this._initBoxSetQueue(item, item.AlbumId);
            } else {
                // Standalone item (Movie, etc.) — stamp and queue
                _stampPlaylistItemId(item);
                this._queue = [item];
                this._currentIndex = 0;
            }

            // If shuffle mode was flipped on BEFORE the queue was initialized
            // (e.g. user pressed a Play Shuffled button on the library UI)
            if (this._shuffleMode) {
                this._applyShuffle();
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
        this._unshuffledQueue = [];
        this._currentIndex = -1;
        this._isInitialized = false;
        this._contextType = null;
        this._contextId = null;
        // Should NOT clear RepeatMode and ShuffleMode - they are user preferences
    }

    /**
     * Get a shallow copy of the full queue.
     * Used by PlayerPage to build the NowPlayingQueue payload for playback reports.
     * Each item will have a PlaylistItemId stamped on it.
     * @returns {Object[]}
     */
    getQueue() {
        return this._queue;
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
    setQueue(items, activeIndex = 0) {
        log.info('PlayQueue.setQueue called', { itemCount: items?.length, activeIndex });
        this.clear();

        if (!items || !Array.isArray(items) || items.length === 0) {
            log.warn('Attempted to set an empty or invalid queue.');
            return;
        }

        // Stamp PlaylistItemIds to ensure uniqueness
        items.forEach(_stampPlaylistItemId);

        this._queue = items;
        this._currentIndex = Math.max(0, Math.min(activeIndex, this._queue.length - 1));
        this._isInitialized = true;

        if (this._shuffleMode) {
            this._shuffleMode = false;
            this.setShuffleMode(true);
        }

        log.info(`Queue set manually with ${this._queue.length} items. Current Index: ${this._currentIndex}`);
    }

    /**
     * Get the current active index within the queue
     */
    getCurrentIndex() {
        return this._currentIndex;
    }

    /**
     * Check if there is a next item
     * @returns {boolean}
     */
    hasNext() {
        if (this._queue.length <= 1) return false;
        if (this._repeatMode === 'RepeatAll') return true;
        return this._currentIndex < this._queue.length - 1;
    }

    /**
     * Check if there is a previous item
     * @returns {boolean}
     */
    hasPrevious() {
        if (this._queue.length <= 1) return false;
        if (this._repeatMode === 'RepeatAll') return true;
        return this._currentIndex > 0;
    }

    /**
     * Get the next item without moving the index
     * @returns {Object|null}
     */
    peekNext() {
        if (!this.hasNext()) return null;

        let nextIndex = this._currentIndex + 1;
        if (nextIndex >= this._queue.length && this._repeatMode === 'RepeatAll') {
            nextIndex = 0; // Wrap around
        }
        return this._queue[nextIndex];
    }

    /**
     * Get the previous item without moving the index
     * @returns {Object|null}
     */
    peekPrevious() {
        if (!this.hasPrevious()) return null;

        let prevIndex = this._currentIndex - 1;
        if (prevIndex < 0 && this._repeatMode === 'RepeatAll') {
            prevIndex = this._queue.length - 1; // Wrap around
        }
        return this._queue[prevIndex];
    }

    /**
     * Advance to next item
     * @returns {Object|null} The new item, or null if end of queue
     */
    advance() {
        if (!this.hasNext()) return null;

        this._currentIndex++;
        if (this._currentIndex >= this._queue.length && this._repeatMode === 'RepeatAll') {
            this._currentIndex = 0; // Wrap around
        }

        return this._queue[this._currentIndex];
    }

    /**
     * Go back to previous item
     * @returns {Object|null} The new item, or null if start of queue
     */
    goBack() {
        if (!this.hasPrevious()) return null;

        this._currentIndex--;
        if (this._currentIndex < 0 && this._repeatMode === 'RepeatAll') {
            this._currentIndex = this._queue.length - 1; // Wrap around
        }

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

        // Fetch movies, episodes, and audio separately to maintain UI-like ordering
        const [moviesResponse, episodesResponse, audioResponse] = await Promise.all([
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
            }),
            api.getItems({
                ParentId: parentId,
                Recursive: true,
                IncludeItemTypes: 'Audio',
                SortBy: 'SortName',
                SortOrder: 'Ascending',
                Limit: 100
            })
        ]);

        const movies = moviesResponse.Items || [];
        const episodes = episodesResponse.Items || [];
        const audios = audioResponse.Items || [];

        // Combine: Movies first, then Episodes, then Audio, and stamp each with a PlaylistItemId
        this._queue = [...movies, ...episodes, ...audios];
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

    async _initSeasonQueue(currentItem, seasonId) {
        log.debug('Building Season queue for:', seasonId);

        // Fetch only episodes for this specific season
        const response = await api.getEpisodes(currentItem.SeriesId, {
            SeasonId: seasonId,
            Fields: 'PrimaryImageAspectRatio,BasicSyncInfo,Overview,Chapters,MediaSources'
        });

        const episodes = response.Items || [];
        episodes.forEach(_stampPlaylistItemId);

        this._queue = episodes;
        this._currentIndex = this._queue.findIndex((e) => e.Id === currentItem.Id);

        if (this._currentIndex === -1) {
            _stampPlaylistItemId(currentItem);
            this._queue.unshift(currentItem);
            this._currentIndex = 0;
        }
    }
}

export const playQueue = new PlayQueue();
