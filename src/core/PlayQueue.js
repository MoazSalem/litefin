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
 * ============================================================================
 */

import { api } from '../api/index.js';
import { logger } from '../utils/Logger.js';
import { PlayerSettings } from '../utils/PlayerSettings.js';

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

        // Dynamic TV Series Episode Queue window tracking
        this._episodeSeriesId = null;
        this._seriesAllEpisodes = null;
        this._seriesWindowStartIndex = 0;
        this._isLoadingMore = false;
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
     * @param {string} [boxsetSortBy] - Optional sort field for BoxSet queues (e.g., 'PremiereDate', 'SortName')
     */
    async init(item, contextType = null, contextId = null, boxsetSortBy = null) {
        log.info('PlayQueue.init called', { itemId: item?.Id, contextType, contextId, boxsetSortBy });
        this.clear();
        this._contextType = contextType;
        this._contextId = contextId;
        this._isInitialized = true;

        try {
            if ((contextType === 'boxset' || contextType === 'music') && (contextId || item.ParentId)) {
                // Prioritize collection context if explicitly provided.
                // Pass through the sort order so the queue matches the display grid.
                await this._initBoxSetQueue(item, contextId || item.ParentId, boxsetSortBy);
            } else if (contextType === 'season' && contextId) {
                // Season-specific shuffle: fetch only episodes for this season
                await this._initSeasonQueue(item, contextId);
            } else if (contextType === 'playlist' && contextId) {
                // Playlist: fetch ALL items in the user's playlist, preserving server order
                await this._initPlaylistQueue(item, contextId);
            } else if (item.Type === 'Episode' && item.SeriesId) {
                await this._initEpisodeQueue(item);
            } else if (item.Type === 'TvChannel') {
                await this._initLiveTvQueue(item);
            } else if (item.Type === 'Audio' && item.AlbumId) {
                // Auto-init album queue for songs played standalone
                await this._initBoxSetQueue(item, item.AlbumId);
            } else {
                // Standalone item (Movie, Video, etc.) — check for additional parts and queue
                await this._initMultiPartOrStandaloneQueue(item);
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
     * Build play queue for standalone items (Movies, Videos) with support for multi-part items.
     * Checks if the item has additional video parts (Part 2, Part 3, etc.) and appends them
     * to ensure seamless continuous playback across split files.
     *
     * @param {Object} item - The starting media item
     * @private
     */
    async _initMultiPartOrStandaloneQueue(item) {
        log.debug('Initializing standalone or multi-part queue for item:', item.Id);

        // Always stamp the primary item with a session-unique PlaylistItemId
        _stampPlaylistItemId(item);

        // Default queue contains single item
        this._queue = [item];
        this._currentIndex = 0;

        // Query Jellyfin server for additional video parts if item indicates PartCount > 1
        // or for Movie/Video types which might contain split files
        if (item.PartCount > 1 || item.Type === 'Movie' || item.Type === 'Video') {
            try {
                // Primary item ID to query additional parts for
                const targetId = item.PrimaryItemId || item.Id;

                // Request additional parts from Jellyfin server API
                const response = await api.getAdditionalParts(targetId);
                const parts = response?.Items || [];

                if (parts.length > 0) {
                    log.info(`Found ${parts.length} additional part(s) for item ${targetId}`);

                    // Fetch details or stamp each part with a session-unique PlaylistItemId
                    parts.forEach(_stampPlaylistItemId);

                    // Combine primary item with additional parts in natural sequence
                    this._queue = [item, ...parts];

                    // Locate index of currently selected item within the combined queue
                    const activeIndex = this._queue.findIndex((p) => p.Id === item.Id);
                    this._currentIndex = activeIndex !== -1 ? activeIndex : 0;
                }
            } catch (err) {
                log.warn('Failed to fetch additional parts for item in PlayQueue:', err);
            }
        }
    }

    /**
     * Build the play queue for Live TV channels.
     * Fetches the full channel list so users can navigate via the OSD queue.
     * @param {Object} currentItem - The starting channel
     * @private
     */
    async _initLiveTvQueue(currentItem) {
        log.debug('Building Live TV channel queue');

        // Fetch the full channel list (up to 2000) with logical sorting.
        // This ensures the OSD Queue matches the user's expected EPG order.
        const response = await api.getLiveTvChannels({
            Limit: 2000,
            SortBy: 'Number,SortName',
            SortOrder: 'Ascending'
        });

        const channels = response.Items || [];

        // Stamp every channel with a session-unique PlaylistItemId
        channels.forEach(_stampPlaylistItemId);

        this._queue = channels;

        // Locate the starting channel
        this._currentIndex = this._queue.findIndex((c) => c.Id === currentItem.Id);

        // Fallback: if not found, prepend the current item
        if (this._currentIndex === -1) {
            _stampPlaylistItemId(currentItem);
            this._queue.unshift(currentItem);
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

        // Reset dynamic episode queue window state
        this._episodeSeriesId = null;
        this._seriesAllEpisodes = null;
        this._seriesWindowStartIndex = 0;
        this._isLoadingMore = false;
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
     * Insert one or more items immediately after the current index.
     * Useful for pre-roll intros and adding items "up next".
     * @param {Object|Object[]} items - Item(s) to insert
     */
    insertNext(items) {
        const toInsert = Array.isArray(items) ? items : [items];
        if (toInsert.length === 0) return;

        log.debug('PlayQueue.insertNext', { count: toInsert.length, afterIndex: this._currentIndex });

        // Stamp every item with a session-unique PlaylistItemId
        toInsert.forEach(_stampPlaylistItemId);

        // Splice into the queue starting at the position AFTER current index
        const insertIndex = this._currentIndex + 1;
        this._queue.splice(insertIndex, 0, ...toInsert);

        eventBus.emit('playqueue:updated', {
            queue: this._queue,
            currentIndex: this._currentIndex,
            repeatMode: this._repeatMode,
            shuffleMode: this._shuffleMode
        });
    }

    /**
     * Insert one or more items at a specific index.
     * If safeIndex <= _currentIndex, the _currentIndex is shifted right.
     * @param {number} index - Desired index to insert at
     * @param {Object|Object[]} items - Item(s) to insert
     */
    insertAt(index, items) {
        const toInsert = Array.isArray(items) ? items : [items];
        if (toInsert.length === 0) return;

        const safeIndex = Math.max(0, Math.min(index, this._queue.length));
        log.debug('PlayQueue.insertAt', { count: toInsert.length, atIndex: safeIndex });

        toInsert.forEach(_stampPlaylistItemId);

        this._queue.splice(safeIndex, 0, ...toInsert);

        // If we inserted before the current item, we must shift the index to maintain track continuity
        if (safeIndex <= this._currentIndex) {
            this._currentIndex += toInsert.length;
        }

        eventBus.emit('playqueue:updated', {
            queue: this._queue,
            currentIndex: this._currentIndex,
            repeatMode: this._repeatMode,
            shuffleMode: this._shuffleMode
        });
    }

    /**
     * Inject one or more pre-roll items at the CURRENT index.
     * The old item at the current index (and everything after it) is shifted right.
     * Since the index is not modified, playback seamlessly transitions to the first injected item.
     * @param {Object|Object[]} items - Item(s) to inject
     */
    injectPreRoll(items) {
        const toInsert = Array.isArray(items) ? items : [items];
        if (toInsert.length === 0) return;

        log.debug('PlayQueue.injectPreRoll', { count: toInsert.length, atIndex: this._currentIndex });

        toInsert.forEach(_stampPlaylistItemId);

        // Splice exactly at the current active pointer
        this._queue.splice(this._currentIndex, 0, ...toInsert);

        // We DO NOT modify this._currentIndex!
        // It now naturally points to the first injected item.

        eventBus.emit('playqueue:updated', {
            queue: this._queue,
            currentIndex: this._currentIndex,
            repeatMode: this._repeatMode,
            shuffleMode: this._shuffleMode
        });
    }

    /**
     * Get the current active index within the queue
     */
    getCurrentIndex() {
        return this._currentIndex;
    }

    /**
     * Check if there is a next item
     * Handles both loaded queue items and series boundary expansions
     * @returns {boolean}
     */
    hasNext() {
        if (this._queue.length === 0) return false;
        if (this._repeatMode === 'RepeatAll') return true;
        if (this._currentIndex < this._queue.length - 1) return true;

        // If at the end of the loaded slice, check if more series episodes remain in the manifest
        if (this._episodeSeriesId && this._seriesAllEpisodes?.length) {
            const nextWindowEnd = this._seriesWindowStartIndex + this._queue.length;
            if (nextWindowEnd < this._seriesAllEpisodes.length) {
                return true;
            }
        }
        return false;
    }

    /**
     * Check if there is a previous item
     * Handles both loaded queue items and series boundary expansions
     * @returns {boolean}
     */
    hasPrevious() {
        if (this._queue.length === 0) return false;
        if (this._repeatMode === 'RepeatAll') return true;
        if (this._currentIndex > 0) return true;

        // If at index 0 of the loaded slice, check if earlier series episodes exist in the manifest
        if (this._episodeSeriesId && this._seriesWindowStartIndex > 0) {
            return true;
        }
        return false;
    }

    /**
     * Get the next item without moving the index
     * Automatically requests background queue expansion when nearing the window boundary
     * @returns {Object|null}
     */
    peekNext() {
        if (!this.hasNext()) return null;

        let nextIndex = this._currentIndex + 1;
        if (nextIndex >= this._queue.length && this._repeatMode === 'RepeatAll') {
            nextIndex = 0; // Wrap around
        }

        // Trigger dynamic preload ahead of time so the next batch is ready before playback ends
        this._maybeExpandQueue('next');

        return this._queue[nextIndex] || null;
    }

    /**
     * Get the previous item without moving the index
     * Automatically requests background queue expansion when nearing the start boundary
     * @returns {Object|null}
     */
    peekPrevious() {
        if (!this.hasPrevious()) return null;

        let prevIndex = this._currentIndex - 1;
        if (prevIndex < 0 && this._repeatMode === 'RepeatAll') {
            prevIndex = this._queue.length - 1; // Wrap around
        }

        // Trigger dynamic preload ahead of time
        this._maybeExpandQueue('previous');

        return this._queue[prevIndex] || null;
    }

    /**
     * Advance to next item
     * Automatically preloads next batch of episodes if approaching queue boundary
     * @returns {Object|null} The new item, or null if end of queue
     */
    advance() {
        if (!this.hasNext()) return null;

        this._currentIndex++;
        if (this._currentIndex >= this._queue.length && this._repeatMode === 'RepeatAll') {
            this._currentIndex = 0; // Wrap around
        }

        // Trigger dynamic preloading if approaching window boundary
        this._maybeExpandQueue('next');

        return this._queue[this._currentIndex];
    }

    /**
     * Go back to previous item
     * Automatically preloads previous batch of episodes if approaching queue boundary
     * @returns {Object|null} The new item, or null if start of queue
     */
    goBack() {
        if (!this.hasPrevious()) return null;

        this._currentIndex--;
        if (this._currentIndex < 0 && this._repeatMode === 'RepeatAll') {
            this._currentIndex = this._queue.length - 1; // Wrap around
        }

        // Trigger dynamic preloading if approaching window boundary
        this._maybeExpandQueue('previous');

        return this._queue[this._currentIndex];
    }

    getCurrentItem() {
        if (this._currentIndex === -1) return null;

        // Proactively verify if current position is near window edges to preload seamlessly
        if (this._episodeSeriesId) {
            const remainingAhead = this._queue.length - 1 - this._currentIndex;
            if (remainingAhead <= 5) {
                this._maybeExpandQueue('next');
            }
            if (this._currentIndex <= 5) {
                this._maybeExpandQueue('previous');
            }
        }

        return this._queue[this._currentIndex];
    }

    /**
     * Public helper to guarantee an item possesses a session-unique PlaylistItemId.
     * Stamping items prior to reporting prevents desynchronization with the server's
     * session manager and ensures parity with jellyfin-web playlist tracking.
     *
     * @param {Object} item - Media item candidate
     * @returns {string|null} The resolved PlaylistItemId
     */
    stampPlaylistItemId(item) {
        if (!item) return null;
        _stampPlaylistItemId(item);
        return item.PlaylistItemId;
    }

    // ========================================================================
    // Internal Queue Builders
    // ========================================================================

    /**
     * ========================================================================
     * Dynamic Episode Queue Builder (Series Playback)
     * ========================================================================
     * Builds an optimized playback queue centered around the target episode.
     * Instead of naively retrieving all 500+ or 1,000+ episodes with heavy metadata
     * (chapters, media sources, trickplay, overview), which saturates memory
     * and crashes on constrained TV hardware, this implementation:
     *
     * 1. Fetches a lightweight series episode manifest (minimal fields).
     * 2. Locates the active episode index in the entire series sequence.
     * 3. Calculates a dynamic sliding window: [currentIndex - limit, currentIndex + limit].
     * 4. Fetches full metadata only for the windowed subset.
     * 5. Enables automated background expansion when approaching window boundaries.
     *
     * @param {Object} currentItem - The starting episode item
     * @private
     */
    async _initEpisodeQueue(currentItem) {
        log.debug('Building dynamic episode queue for series:', currentItem.SeriesId);

        // Retrieve configured episode window limit (default: 50 before, 50 after)
        const windowLimit = Math.max(10, PlayerSettings.get('playQueueEpisodeLimit') || 50);

        try {
            // Step 1: Fetch lightweight manifest of all episodes across all seasons
            // Request minimal fields to ensure ultra-low network payload (~30KB for 1,000 episodes)
            const manifestResponse = await api.getEpisodes(currentItem.SeriesId, {
                Limit: 10000,
                Fields: 'Id,SeriesId,SeasonId,IndexNumber,ParentIndexNumber'
            });

            const allSeriesEpisodes = manifestResponse?.Items || [];
            log.info(`[PlayQueue] Series manifest retrieved: Total=${allSeriesEpisodes.length} episodes`);

            // Step 2: Locate the active episode within the series sequence
            let currentIdx = allSeriesEpisodes.findIndex((e) => e.Id === currentItem.Id);

            // If the series has no episodes or the item could not be found in the manifest,
            // fall back gracefully to a single-item queue to keep playback running.
            if (allSeriesEpisodes.length === 0 || currentIdx === -1) {
                log.warn('[PlayQueue] Item not found in series manifest. Falling back to single-item queue.');
                _stampPlaylistItemId(currentItem);
                this._queue = [currentItem];
                this._currentIndex = 0;
                return;
            }

            // Step 3: Handle Shuffle vs Sequential playback
            if (this._shuffleMode) {
                // For shuffle mode across massive series, shuffle the full manifest order
                // while locking the currently selected item at the front.
                const remainingManifest = allSeriesEpisodes.filter((e) => e.Id !== currentItem.Id);
                for (let i = remainingManifest.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [remainingManifest[i], remainingManifest[j]] = [remainingManifest[j], remainingManifest[i]];
                }
                this._seriesAllEpisodes = [allSeriesEpisodes[currentIdx], ...remainingManifest];
                this._seriesWindowStartIndex = 0;
                currentIdx = 0;
            } else {
                // Store natural chronological series sequence
                this._seriesAllEpisodes = allSeriesEpisodes;
            }

            this._episodeSeriesId = currentItem.SeriesId;

            // Step 4: Compute sliding window boundaries
            // We want [currentIdx - windowLimit] to [currentIdx + windowLimit]
            const startIndex = Math.max(0, currentIdx - windowLimit);
            const endIndex = Math.min(this._seriesAllEpisodes.length - 1, currentIdx + windowLimit);
            const countToFetch = endIndex - startIndex + 1;

            this._seriesWindowStartIndex = startIndex;

            log.info(
                `[PlayQueue] Fetching window: startIndex=${startIndex}, count=${countToFetch}, total=${this._seriesAllEpisodes.length}`
            );

            // Step 5: Fetch full rich metadata ONLY for the windowed slice
            let windowItems = [];
            if (this._shuffleMode) {
                // For shuffled order, fetch by IDs or batch
                const windowIds = this._seriesAllEpisodes.slice(startIndex, startIndex + countToFetch).map((e) => e.Id);
                const itemsResponse = await api.getItems({
                    Ids: windowIds.join(','),
                    Fields: 'Overview,RunTimeTicks,Chapters,MediaSources,Trickplay'
                });
                const fetchedMap = new Map((itemsResponse?.Items || []).map((i) => [i.Id, i]));
                windowItems = windowIds.map((id) => fetchedMap.get(id)).filter(Boolean);
            } else {
                // For sequential order, standard StartIndex + Limit is optimal and fast
                const fullResponse = await api.getEpisodes(currentItem.SeriesId, {
                    StartIndex: startIndex,
                    Limit: countToFetch,
                    Fields: 'Overview,RunTimeTicks,Chapters,MediaSources,Trickplay'
                });
                windowItems = fullResponse?.Items || [];
            }

            // Step 6: Stamp session-unique PlaylistItemId onto each episode
            windowItems.forEach(_stampPlaylistItemId);
            this._queue = windowItems;

            // Step 7: Resolve the exact current index inside our windowed queue
            this._currentIndex = this._queue.findIndex((e) => e.Id === currentItem.Id);

            // Safety check: if currentItem was missing from window response, prepend it
            if (this._currentIndex === -1) {
                _stampPlaylistItemId(currentItem);
                this._queue.unshift(currentItem);
                this._currentIndex = 0;
            }

            log.info(
                `[PlayQueue] Dynamic queue ready: windowSize=${this._queue.length}, currentIndex=${this._currentIndex}`
            );
        } catch (error) {
            log.error('[PlayQueue] Failed to build dynamic episode queue:', error);
            _stampPlaylistItemId(currentItem);
            this._queue = [currentItem];
            this._currentIndex = 0;
        }
    }

    /**
     * Dynamically expand the queue in either direction ('next' or 'previous')
     * when the playback cursor approaches either boundary of the loaded window.
     * @param {'next'|'previous'} direction
     * @private
     */
    async _maybeExpandQueue(direction) {
        if (!this._episodeSeriesId || !this._seriesAllEpisodes?.length || this._isLoadingMore) {
            return;
        }

        const windowLimit = Math.max(10, PlayerSettings.get('playQueueEpisodeLimit') || 50);
        const threshold = Math.min(5, Math.floor(windowLimit / 4));

        if (direction === 'next') {
            const remainingAhead = this._queue.length - 1 - this._currentIndex;
            const currentWindowEnd = this._seriesWindowStartIndex + this._queue.length;

            if (remainingAhead <= threshold && currentWindowEnd < this._seriesAllEpisodes.length) {
                this._isLoadingMore = true;
                try {
                    const fetchCount = Math.min(windowLimit, this._seriesAllEpisodes.length - currentWindowEnd);
                    log.info(`[PlayQueue] Preloading next ${fetchCount} episodes...`);

                    let newItems = [];
                    if (this._shuffleMode) {
                        const nextIds = this._seriesAllEpisodes
                            .slice(currentWindowEnd, currentWindowEnd + fetchCount)
                            .map((e) => e.Id);
                        const res = await api.getItems({
                            Ids: nextIds.join(','),
                            Fields: 'Overview,RunTimeTicks,Chapters,MediaSources,Trickplay'
                        });
                        const map = new Map((res?.Items || []).map((i) => [i.Id, i]));
                        newItems = nextIds.map((id) => map.get(id)).filter(Boolean);
                    } else {
                        const res = await api.getEpisodes(this._episodeSeriesId, {
                            StartIndex: currentWindowEnd,
                            Limit: fetchCount,
                            Fields: 'Overview,RunTimeTicks,Chapters,MediaSources,Trickplay'
                        });
                        newItems = res?.Items || [];
                    }

                    if (newItems.length > 0) {
                        newItems.forEach(_stampPlaylistItemId);
                        this._queue.push(...newItems);
                        log.info(`[PlayQueue] Appended ${newItems.length} episodes. Queue size: ${this._queue.length}`);
                        eventBus.emit('playqueue:updated', {
                            queue: this._queue,
                            currentIndex: this._currentIndex,
                            repeatMode: this._repeatMode,
                            shuffleMode: this._shuffleMode
                        });
                    }
                } catch (err) {
                    log.warn('[PlayQueue] Failed to preload next episodes:', err);
                } finally {
                    this._isLoadingMore = false;
                }
            }
        } else if (direction === 'previous') {
            if (this._currentIndex <= threshold && this._seriesWindowStartIndex > 0) {
                this._isLoadingMore = true;
                try {
                    const fetchCount = Math.min(windowLimit, this._seriesWindowStartIndex);
                    const prevStartIndex = this._seriesWindowStartIndex - fetchCount;
                    log.info(`[PlayQueue] Preloading previous ${fetchCount} episodes...`);

                    let prevItems = [];
                    if (this._shuffleMode) {
                        const prevIds = this._seriesAllEpisodes
                            .slice(prevStartIndex, prevStartIndex + fetchCount)
                            .map((e) => e.Id);
                        const res = await api.getItems({
                            Ids: prevIds.join(','),
                            Fields: 'Overview,RunTimeTicks,Chapters,MediaSources,Trickplay'
                        });
                        const map = new Map((res?.Items || []).map((i) => [i.Id, i]));
                        prevItems = prevIds.map((id) => map.get(id)).filter(Boolean);
                    } else {
                        const res = await api.getEpisodes(this._episodeSeriesId, {
                            StartIndex: prevStartIndex,
                            Limit: fetchCount,
                            Fields: 'Overview,RunTimeTicks,Chapters,MediaSources,Trickplay'
                        });
                        prevItems = res?.Items || [];
                    }

                    if (prevItems.length > 0) {
                        prevItems.forEach(_stampPlaylistItemId);
                        this._queue.unshift(...prevItems);
                        this._seriesWindowStartIndex = prevStartIndex;
                        this._currentIndex += prevItems.length;
                        log.info(`[PlayQueue] Prepended ${prevItems.length} episodes. Queue size: ${this._queue.length}`);
                        eventBus.emit('playqueue:updated', {
                            queue: this._queue,
                            currentIndex: this._currentIndex,
                            repeatMode: this._repeatMode,
                            shuffleMode: this._shuffleMode
                        });
                    }
                } catch (err) {
                    log.warn('[PlayQueue] Failed to preload previous episodes:', err);
                } finally {
                    this._isLoadingMore = false;
                }
            }
        }
    }

    /**
     * Build the play queue for a BoxSet (collection) or music album.
     *
     * @param {Object} currentItem - The item playback started on
     * @param {string} parentId - The BoxSet/Album ID
     * @param {string|null} [sortBy] - Sort field to use ('PremiereDate', 'SortName',
     *   'DateModified'). Defaults to 'PremiereDate' when not provided, matching the
     *   Litefin default display order for collections.
     */
    async _initBoxSetQueue(currentItem, parentId, sortBy = 'PremiereDate') {
        log.debug('Building BoxSet queue for parent:', parentId, '| sortBy:', sortBy);

        // Fetch movies, episodes, and audio separately to maintain UI-like ordering.
        // All three fetches share the same sort field so the full queue is consistent
        // with whatever Display Order the user has chosen for this collection.
        /*
         * Request RunTimeTicks for movies, episodes, and audio in BoxSet queues.
         * This ensures any queued successor item retains duration metadata needed
         * for server scrobbling and playback completion overrides.
         */
        const [moviesResponse, episodesResponse, audioResponse] = await Promise.all([
            api.getItems({
                ParentId: parentId,
                Recursive: true,
                IncludeItemTypes: 'Movie',
                SortBy: sortBy,
                SortOrder: 'Ascending',
                Limit: 100,
                Fields: 'RunTimeTicks,Trickplay'
            }),
            api.getItems({
                ParentId: parentId,
                Recursive: true,
                IncludeItemTypes: 'Episode',
                SortBy: sortBy,
                SortOrder: 'Ascending',
                Limit: 100,
                Fields: 'RunTimeTicks,Trickplay'
            }),
            api.getItems({
                ParentId: parentId,
                Recursive: true,
                IncludeItemTypes: 'Audio',
                SortBy: (this._contextType === 'music' || currentItem.Type === 'Audio')
                    ? 'ParentIndexNumber,IndexNumber,SortName'
                    : sortBy,
                SortOrder: 'Ascending',
                Limit: 100,
                Fields: 'RunTimeTicks'
            })
        ]);

        let audios = audioResponse.Items || [];

        // Fallback for virtual music albums or artist collections where tracks
        // are linked by AlbumId or ArtistIds rather than folder-level ParentId
        if (audios.length === 0 && (this._contextType === 'music' || currentItem.Type === 'Audio')) {
            const albumAudioRes = await api.getItems({
                AlbumIds: parentId,
                Recursive: true,
                IncludeItemTypes: 'Audio',
                SortBy: 'ParentIndexNumber,IndexNumber,SortName',
                SortOrder: 'Ascending',
                Limit: 100,
                Fields: 'RunTimeTicks'
            });

            if (albumAudioRes?.Items?.length > 0) {
                audios = albumAudioRes.Items;
            } else {
                // Check if the container is an Artist
                const artistAudioRes = await api.getItems({
                    ArtistIds: parentId,
                    Recursive: true,
                    IncludeItemTypes: 'Audio',
                    SortBy: 'ParentIndexNumber,IndexNumber,SortName',
                    SortOrder: 'Ascending',
                    Limit: 100,
                    Fields: 'RunTimeTicks'
                });
                if (artistAudioRes?.Items?.length > 0) {
                    audios = artistAudioRes.Items;
                }
            }
        }

        const movies = moviesResponse.Items || [];
        const episodes = episodesResponse.Items || [];

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
        /*
         * Fetch season episodes with RunTimeTicks included in the requested fields
         * to guarantee accurate playback duration on consecutive episodes.
         */
        const response = await api.getEpisodes(currentItem.SeriesId, {
            SeasonId: seasonId,
            Fields: 'Overview,RunTimeTicks,Chapters,MediaSources,Trickplay'
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

    /**
     * Build a play queue from a Jellyfin Playlist.
     *
     * Uses the dedicated /Playlists/{id}/Items endpoint so server-defined
     * ordering is preserved exactly, and each item carries a PlaylistItemId
     * for SyncPlay queue tracking.
     *
     * Unlike BoxSet which is organised by type (Movies, Episodes, Audio),
     * a Playlist can be mixed media in any user-defined order — we respect
     * that order faithfully and do NOT re-sort.
     *
     * @param {Object} currentItem - The item playback started on
     * @param {string} playlistId  - The Playlist container item ID
     */
    async _initPlaylistQueue(currentItem, playlistId) {
        log.debug('Building Playlist queue for:', playlistId);

        // Fetch all items from the playlist endpoint — this preserves the
        // server-defined order and includes PlaylistItemId per entry.
        // We also request Trickplay and MediaSources for a richer player
        // experience (chapter thumbnails, stream selection) without a second fetch.
        const response = await api.getPlaylistItems(playlistId, {
            Fields: 'Overview,RunTimeTicks,Chapters,MediaSources,Trickplay'
        });

        const items = response?.Items || [];

        // Stamp every queued item with a session-unique PlaylistItemId so
        // the NowPlayingQueue payload sent to the server has valid slot IDs.
        items.forEach(_stampPlaylistItemId);

        this._queue = items;

        // Locate the starting position — match by item Id.
        // Note: if the user started from a random item (shuffle play), this
        // finds its natural position in the list; shuffling is then applied
        // afterwards by PlayQueue.init() if _shuffleMode is true.
        this._currentIndex = this._queue.findIndex((e) => e.Id === currentItem.Id);

        // Fallback: if the API result didn't include the starting item
        // (race condition, server mismatch, item removed mid-session),
        // prepend it so playback still begins correctly.
        if (this._currentIndex === -1) {
            _stampPlaylistItemId(currentItem);
            this._queue.unshift(currentItem);
            this._currentIndex = 0;
        }

        log.info(
            `[PlayQueue] Playlist queue built: ${this._queue.length} items, starting at index ${this._currentIndex}`
        );
    }
}

export const playQueue = new PlayQueue();
