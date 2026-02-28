/**
 * ============================================================================
 * Litefin - ImageCache
 * ============================================================================
 * Lightweight homepage image pre-warmer using the browser's native HTTP cache.
 *
 * Design:
 *  - Only HomePage pre-warms this cache (via preload()).
 *  - Pre-warming uses hidden `new Image()` elements — NOT fetch() — so images
 *    go through the exact same pipeline as LazyLoader's img.src assignments.
 *    This means the browser's memory cache ("from memory cache") is hit on the
 *    second assignment, giving instant renders.
 *  - Requests are throttled to MAX_CONCURRENT to avoid exhausting Tizen's
 *    limited HTTP connection pool (6–8 concurrent connections max).
 *  - LazyLoader is completely unchanged — it sets img.src as normal, and the
 *    browser serves the pre-loaded image from memory cache automatically.
 *  - Details pages, favorites, and library grids are unaffected since only
 *    HomePage calls preload().
 * ============================================================================
 */

import { logger } from './Logger.js';

const log = logger.create('ImageCache');

// ============================================================================
// Configuration
// ============================================================================

/**
 * Maximum number of parallel image pre-load requests at any given time.
 * Keep this low enough to leave headroom for other network requests.
 * Tizen 4 (Chromium 56) allows ~6 concurrent connections per host.
 */
const MAX_CONCURRENT = 4;

class ImageCache {
    constructor() {
        /** URLs currently in the pre-load queue, waiting their turn. */
        this._queue = [];

        /** Number of in-flight pre-load operations right now. */
        this._active = 0;

        /** Set of URLs we have already started or completed a pre-load for. */
        this._started = new Set();

        /** Whether the cache system is enabled (true unless explicitly disabled). */
        this._ready = true;
    }

    // =========================================================================
    // Public API
    // =========================================================================

    /**
     * No-op init kept for API compatibility with App.js boot sequence.
     * Native Image() pre-loading needs no setup — it's always available.
     * @returns {Promise<void>}
     */
    async init() {
        log.info('ImageCache ready (native HTTP cache mode).');
    }

    /**
     * Pre-warm the browser's HTTP cache for a list of image URLs.
     * Called ONLY by HomePage after its API data is fetched.
     *
     * Uses hidden Image elements — the same mechanism LazyLoader uses —
     * so the browser memory cache is populated for instant reuse.
     * Requests are throttled to MAX_CONCURRENT to protect Tizen's connection pool.
     *
     * @param {string[]} urls - Image URLs to pre-warm.
     */
    preload(urls) {
        if (!this._ready || !urls || urls.length === 0) return;

        // Only queue URLs we haven't already started
        const fresh = urls.filter((url) => url && !this._started.has(url));

        if (fresh.length === 0) {
            log.debug('All URLs already pre-warmed.');
            return;
        }

        log.info(`Queueing ${fresh.length} URLs for pre-warming (${urls.length - fresh.length} already done).`);

        // Add to queue and mark as started immediately to prevent duplicates
        // from a rapid double-call (e.g., user navigates away and back quickly)
        for (const url of fresh) {
            this._started.add(url);
            this._queue.push(url);
        }

        // Kick off the draining loop — safe to call even if already draining
        this._drain();
    }

    /**
     * No-op stub kept for API compatibility.
     * Browser cache is managed by the browser itself.
     */
    getBlobUrl() {
        return null;
    }

    /**
     * Reset the pre-warm tracker (e.g. after logout, so a new user's
     * homepage pre-warms fresh).
     */
    clear() {
        this._queue = [];
        this._started.clear();
        this._active = 0;
        log.info('ImageCache cleared.');
    }

    // =========================================================================
    // Throttled Drain Loop
    // =========================================================================

    /**
     * Drain the pre-load queue, keeping at most MAX_CONCURRENT requests
     * live at any one time. Called whenever the queue grows or a slot frees up.
     * @private
     */
    _drain() {
        // Fill up to the concurrency cap
        while (this._active < MAX_CONCURRENT && this._queue.length > 0) {
            const url = this._queue.shift();
            this._active++;
            this._loadOne(url);
        }
    }

    /**
     * Pre-load a single image URL into the browser's HTTP cache using a
     * hidden Image element. When done (success or error), free the slot
     * and drain the next item from the queue.
     *
     * @param {string} url
     * @private
     */
    _loadOne(url) {
        const img = new Image();

        const onDone = () => {
            // Free this concurrency slot and immediately try the next item
            this._active--;
            this._drain();
        };

        img.onload = onDone;
        img.onerror = onDone; // Failures are silently ignored — LazyLoader will handle them

        // Assigning src starts the network request.
        // The browser caches the response under this URL, so any subsequent
        // img.src = url assignment (by LazyLoader) hits "from memory cache".
        img.src = url;
    }
}

// ============================================================================
// Singleton Export
// ============================================================================

export const imageCache = new ImageCache();
export default ImageCache;
