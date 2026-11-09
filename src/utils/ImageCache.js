/**
 * ============================================================================
 * Litefin - ImageCache
 * ============================================================================
 * Lightweight homepage image pre-warmer using the browser's native HTTP cache.
 *
 * Design:
 *  - Only HomePage / LibraryPage pre-warm this cache (via preload()).
 *  - Pre-warming uses hidden `new Image()` elements — NOT fetch() — so images
 *    go through the exact same pipeline as LazyLoader's img.src assignments.
 *    This means the browser's memory cache ("from memory cache") is hit on the
 *    second assignment, giving instant renders.
 *  - Requests are throttled with an adaptive concurrency cap and a small
 *    inter-load cooldown so the TV's limited HTTP connection pool (6–8 slots)
 *    and main thread never get saturated.
 *  - The queue is scroll-aware: ScrollController calls pause() when a scroll
 *    animation starts and resume() once it settles, so pre-warming never
 *    competes with compositor frames during D-pad navigation.
 *  - LazyLoader is completely unchanged — it sets img.src as normal, and the
 *    browser serves the pre-loaded image from memory cache automatically.
 *  - Details pages, favorites, and library grids are unaffected since only
 *    HomePage / LibraryPage call preload().
 *
 * ES5-SAFE QUEUE BOOKKEEPING:
 *  - AppleWebKit/538.1 (Tizen 2.3–2.4, webOS 1–2) has incomplete ES6 Set
 *    iterator support. This module therefore never uses Set/Map iterators,
 *    `for..of`, `Set.prototype.values()`, or `Object.values`. Queue membership
 *    and warmed-URL tracking use plain arrays plus null-prototype lookup maps.
 * ============================================================================
 */

import { logger } from './Logger.js';
import { customHeaders } from './CustomHeaders.js';

const log = logger.create('ImageCache');

// ============================================================================
// Configuration — legacy engine detection (evaluated once per app boot)
// ============================================================================

/**
 * Legacy browser engine detection.
 * Older engines (such as Tizen 2.x / webOS 1–2 / ancient rendering engines) need
 * a far gentler pre-warm cadence: a single connection at a time plus a longer
 * cooldown lets the single-core CPU + compositor keep painting scroll frames.
 *
 * Modern Chromium browsers include the legacy engine token in their User-Agent
 * string (e.g. AppleWebKit/537.36). A naive pattern matching against versions 530-538
 * causes modern platforms (like Tizen 9.0 running Chromium 120) to be falsely
 * classified as legacy, unnecessarily retaining image DOM nodes in memory.
 *
 * We verify that Chromium versions 50+ are never classified as legacy, while
 * preserving legacy classifications for true older engines and early Chromium (< 50).
 */
const _userAgent =
    typeof navigator !== 'undefined' && navigator && typeof navigator.userAgent === 'string'
        ? navigator.userAgent
        : '';

// Evaluate legacy engine status with guard against false-positive modern Chromium
const isLegacyWebKit = (() => {
    // Check if a Chromium engine token is present (standard or Tizen format)
    const chromeMatch =
        _userAgent.match(/(?:Chrome|Chromium|CriOS)\/(\d+)/i) ||
        _userAgent.match(/like Gecko\)\s+(\d+)\.\d+/i);

    // If Chromium is detected, evaluate the major version
    if (chromeMatch) {
        const majorVersion = parseInt(chromeMatch[1], 10);
        // Only Chromium versions prior to 50 require the legacy profile
        return !isNaN(majorVersion) && majorVersion < 50;
    }

    // When no Chromium token exists, verify legacy engine indicators
    return /AppleWebKit\/53[0-8]|Tizen 2\.|Web0S; Linux\/SmartTV/i.test(_userAgent);
})();

/**
 * Maximum number of parallel image pre-load requests at any given time.
 * Kept extremely low on legacy TVs to protect the HTTP connection pool and
 * the single main thread from being starved during scrolling.
 */
const MAX_CONCURRENT = isLegacyWebKit ? 1 : 2;

/**
 * Cooldown (ms) after each completed load before the next one starts. Gives
 * the main thread and GPU compositor a frame to breathe between decodes.
 */
const INTER_LOAD_DELAY_MS = isLegacyWebKit ? 50 : 20;

/**
 * Scroll-settle delay (ms) before pre-warming resumes after a scroll finishes.
 */
const DEFAULT_RESUME_DELAY_MS = isLegacyWebKit ? 400 : 250;

/**
 * Maximum number of warmed URLs remembered for de-duplication. Bounded so the
 * registry can never grow without limit on a long-lived TV session.
 */
const MAX_WARMED = 150;

/**
 * Number of Image instances retained on legacy WebKit. Without a live JS
 * reference, AppleWebKit/538.1 may evict decoded preloaded resources as soon
 * as garbage collection runs, defeating the pre-warm entirely.
 */
const MAX_RETAINED_IMAGES = 20;

class ImageCache {
    constructor() {
        // ====================================================================
        // PENDING QUEUE (plain array + null-prototype lookup map)
        // ====================================================================
        /** URLs currently in the pre-load queue, waiting their turn. */
        this._queue = [];

        /** Lookup map of URLs currently pending in _queue (dedupe guard). */
        this._queuedMap = Object.create(null);

        /** Number of in-flight pre-load operations right now. */
        this._activeCount = 0;

        /**
         * Image objects currently loading. Plain array (not a Set) so older
         * WebKit builds never touch ES6 iterators. Kept so cancel() can null
         * their src synchronously, aborting the TCP request and releasing the
         * HTTP connection slot back to the pool immediately.
         */
        this._activeImages = [];

        // ====================================================================
        // WARMED-URL REGISTRY (FIFO array + null-prototype lookup map)
        // ====================================================================
        /** FIFO of URLs already warmed (oldest first). */
        this._warmedList = [];

        /** Lookup map of warmed URLs (dedupe guard). */
        this._warmedMap = Object.create(null);

        // ====================================================================
        // LEGACY WEBKIT RETENTION RING BUFFER
        // ====================================================================
        /** Small ring buffer of retained Image instances (legacy only). */
        this._retainedImages = [];

        // ====================================================================
        // SCROLL / INTERACTION PAUSE STATE
        // ====================================================================
        /** True while scroll smoothness takes priority over pre-warming. */
        this._isPaused = false;

        /** Pending resume timer id (or null). */
        this._resumeTimer = null;

        /**
         * Monotonic generation counter. cancel() increments it so delayed
         * decode()/cooldown callbacks belonging to an aborted page can never
         * decrement the new page's active counter or restart the queue.
         */
        this._generation = 0;

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
        log.info(
            `ImageCache ready (native HTTP cache mode, ${isLegacyWebKit ? 'legacy' : 'modern'} profile: ` +
                `concurrency=${MAX_CONCURRENT}, cooldown=${INTER_LOAD_DELAY_MS}ms).`
        );
    }

    /**
     * Pre-warm the browser's HTTP cache for a list of image URLs.
     * Called by HomePage / LibraryPage after their API data is fetched.
     *
     * Uses hidden Image elements — the same mechanism LazyLoader uses —
     * so the browser memory cache is populated for instant reuse. Requests
     * are throttled to MAX_CONCURRENT to protect the TV connection pool.
     *
     * @param {string[]} urls - Image URLs to pre-warm.
     */
    preload(urls) {
        if (!this._ready || !urls || urls.length === 0) return;

        const freshCount = this._queue.length;

        // De-duplicate against both the pending queue and the warmed registry.
        for (let i = 0; i < urls.length; i++) {
            const url = urls[i];
            if (!url) continue;
            if (this._warmedMap[url] || this._queuedMap[url]) continue;

            this._queuedMap[url] = true;
            this._queue.push(url);
        }

        const added = this._queue.length - freshCount;

        if (added === 0) {
            log.debug('All URLs already pre-warmed or queued.');
            return;
        }

        log.info(`Queueing ${added} URLs for pre-warming (${urls.length - added} already done).`);

        // Kick off the draining loop — safe to call even if already draining
        this._processQueue();
    }

    /**
     * Suspends pre-warming while the viewport is in motion. In-flight loads are
     * allowed to finish; no new requests are started until resume() fires.
     * Clears any pending resume timer so a scroll that starts during the settle
     * delay keeps the queue paused.
     */
    pause() {
        this._isPaused = true;

        if (this._resumeTimer) {
            clearTimeout(this._resumeTimer);
            this._resumeTimer = null;
        }
    }

    /**
     * Resumes pre-warming after a delayed settle window, giving the compositor
     * time to finish its final frame before new image decodes compete for CPU.
     *
     * @param {number} [delayMs] - Settle delay; defaults per engine profile.
     */
    resume(delayMs) {
        const wait = typeof delayMs === 'number' && delayMs >= 0 ? delayMs : DEFAULT_RESUME_DELAY_MS;

        if (this._resumeTimer) {
            clearTimeout(this._resumeTimer);
            this._resumeTimer = null;
        }

        this._resumeTimer = setTimeout(() => {
            this._resumeTimer = null;
            this._isPaused = false;
            this._processQueue();
        }, wait);
    }

    /**
     * Empties the pending queue WITHOUT forgetting warmed URLs. Used when
     * navigating away from a page so stale lookahead requests never linger,
     * while still letting a quick return hit already-warmed images.
     *
     * @returns {number} Number of queued URLs dropped.
     */
    clearQueue() {
        const dropped = this._queue.length;

        this._queue = [];
        this._queuedMap = Object.create(null);

        if (dropped > 0) {
            log.debug(`Cleared ${dropped} queued pre-warm URLs.`);
        }

        return dropped;
    }

    /**
     * No-op stub kept for API compatibility.
     * Browser cache is managed by the browser itself.
     */
    getBlobUrl() {
        return null;
    }

    /**
     * Immediately abort all in-flight image loads and empty the queue.
     *
     * Called by HomePage.onDestroyed() / LibraryPage.onDestroyed() so that
     * background preloads do NOT continue saturating the browser's HTTP
     * connection pool (6–8 slots on Chromium) after the user navigates away.
     * Without this, pending Image loads can block all subsequent XHR/fetch
     * requests for 30+ seconds.
     *
     * Technique: setting img.src = '' causes the browser to abort the
     * underlying TCP request synchronously and release the connection slot
     * back to the pool — exactly what we need.
     *
     * Warmed URLs are intentionally retained so a quick back-navigation can
     * still reuse the browser memory cache. Use clear() for a full reset.
     */
    cancel() {
        // Invalidate delayed decode()/cooldown callbacks from this generation.
        this._generation++;

        const abortedCount = this._activeImages.length;
        const queuedCount = this._queue.length;

        /* ── 1. Kill every in-flight Image object ────────────────────────── */
        for (let i = 0; i < this._activeImages.length; i++) {
            const img = this._activeImages[i];
            // Remove callbacks first so the onload/onerror drain path
            // does not re-start the queue with stale state.
            img.onload = null;
            img.onerror = null;
            img.src = ''; // Signals the browser to abort the pending TCP request
        }
        this._activeImages = [];

        /* ── 2. Flush the pending queue ──────────────────────────────────── */
        this._queue = [];
        this._queuedMap = Object.create(null);

        /* ── 3. Reset the active slot counter ────────────────────────────── */
        this._activeCount = 0;

        /* ── 4. Clear pause state so the next page never starts frozen ───── */
        this._isPaused = false;
        if (this._resumeTimer) {
            clearTimeout(this._resumeTimer);
            this._resumeTimer = null;
        }

        /* ── 5. Release retained legacy Image references ─────────────────── */
        this._retainedImages = [];

        log.info(`ImageCache cancelled: ${abortedCount} in-flight aborted, ${queuedCount} queued dropped.`);
    }

    /**
     * Full reset (e.g. after logout or an image-editing operation, so a new
     * user's / replaced artwork pre-warms fresh).
     */
    clear() {
        this.cancel();

        this._warmedList = [];
        this._warmedMap = Object.create(null);

        log.info('ImageCache cleared (warmed registry reset).');
    }

    // =========================================================================
    // Throttled Queue Processing
    // =========================================================================

    /**
     * Drain the pre-load queue, keeping at most MAX_CONCURRENT requests live
     * at any one time. Called whenever the queue grows, a slot frees up, or a
     * scroll settles. Returns immediately while paused.
     * @private
     */
    _processQueue() {
        if (this._isPaused) return;

        while (this._activeCount < MAX_CONCURRENT && this._queue.length > 0) {
            const url = this._queue.shift();
            delete this._queuedMap[url];
            this._activeCount++;
            this._loadOne(url);
        }
    }

    /**
     * Pre-load a single image URL into the browser's HTTP cache using a
     * hidden Image element. When done (success or error), wait out the
     * inter-load cooldown, free the slot, and process the next item.
     *
     * @param {string} url
     * @private
     */
    _loadOne(url) {
        const img = new Image();
        const generation = this._generation;

        /* Track this object so cancel() can abort it if the page is destroyed
         * before the load completes. */
        this._activeImages.push(img);

        /* Async decode is a hint only available on modern engines. Touching an
         * unsupported property is harmless in practice, but the guard keeps
         * very old WebKit builds from treating it as unknown state. */
        if ('decoding' in img) {
            img.decoding = 'async';
        }

        const onDone = (loaded) => {
            // Remove callbacks first — prevents duplicate finish calls if the
            // browser fires a late error after onload.
            img.onload = null;
            img.onerror = null;

            if (loaded) this._markWarmed(url);

            const finish = () => {
                setTimeout(() => {
                    // A cancel()/clear() happened while we were decoding:
                    // that call already reset counters and queue state.
                    if (generation !== this._generation) return;

                    this._removeActiveImage(img);
                    if (this._activeCount > 0) this._activeCount--;

                    // Keep a live reference on legacy WebKit so GC cannot
                    // evict freshly decoded preloaded resources.
                    if (loaded && isLegacyWebKit) this._retainImage(img);

                    this._processQueue();
                }, INTER_LOAD_DELAY_MS);
            };

            if (loaded && typeof img.decode === 'function') {
                try {
                    // Always settle exactly once — a rejected decode() promise
                    // must never leave the queue hanging forever.
                    img.decode().then(finish, finish);
                } catch (_) {
                    finish();
                }
            } else {
                finish();
            }
        };

        img.onload = () => onDone(true);
        img.onerror = () => onDone(false); // Failures are silently ignored — LazyLoader will retry

        // Configure anonymous CORS so images load seamlessly across local network origins
        img.crossOrigin = 'anonymous';

        // Assigning src starts the network request.
        // When custom reverse proxy headers are active, pre-warm via CustomHeadersManager
        // so the Blob URL is immediately available in memory when LazyLoader visits the card.
        if (customHeaders && typeof customHeaders.hasCustomHeaders === 'function' && customHeaders.hasCustomHeaders()) {
            customHeaders
                .resolveImageUrl(url)
                .then((resolvedUrl) => {
                    // Page was cancelled while headers were being resolved —
                    // do not start a request the queue no longer owns.
                    if (generation !== this._generation) return;
                    img.src = resolvedUrl;
                })
                .catch(() => {
                    if (generation !== this._generation) return;
                    img.src = url;
                });
        } else {
            img.src = url;
        }
    }

    /**
     * Removes an Image from the live-tracking array.
     * @param {HTMLImageElement} img
     * @private
     */
    _removeActiveImage(img) {
        const idx = this._activeImages.indexOf(img);
        if (idx !== -1) this._activeImages.splice(idx, 1);
    }

    /**
     * Marks a URL as warmed and bounds the registry with FIFO eviction.
     * @param {string} url
     * @private
     */
    _markWarmed(url) {
        if (this._warmedMap[url]) return;

        this._warmedMap[url] = true;
        this._warmedList.push(url);

        while (this._warmedList.length > MAX_WARMED) {
            const oldest = this._warmedList.shift();
            delete this._warmedMap[oldest];
        }
    }

    /**
     * Retains a loaded Image instance in the small legacy ring buffer. WebKit
     * 538.1 evicts decoded images whose only reference is the browser cache;
     * holding the JS object keeps the resource alive until it scrolls off the
     * bounded window.
     * @param {HTMLImageElement} img
     * @private
     */
    _retainImage(img) {
        this._retainedImages.push(img);

        while (this._retainedImages.length > MAX_RETAINED_IMAGES) {
            this._retainedImages.shift();
        }
    }
}

// ============================================================================
// Singleton Export
// ============================================================================

export const imageCache = new ImageCache();
export default ImageCache;
