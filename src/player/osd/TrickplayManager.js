/**
 * ============================================================================
 * TrickplayManager
 * ============================================================================
 * Handles trickplay thumbnail preview logic for the video player OSD.
 *
 * Jellyfin generates tiled "sprite sheet" images — a single JPEG that contains
 * multiple video frames arranged in a grid (e.g. 10×10). Given a playback
 * position in ticks, this class calculates which sprite sheet to load, which
 * tile within it corresponds to that position, and returns the CSS background
 * properties needed to crop and display just that tile.
 *
 * Performance design (tuned for low-end Chromium on Tizen/WebOS):
 *   - Pure CSS background-image + background-position (GPU composited)
 *   - No canvas, no blob URLs, no pixel manipulation
 *   - Only one sprite sheet is loaded at a time (the current one)
 *   - The enabled state is cached at init-time to avoid repeated localStorage reads
 *   - When disabled, every method returns/exits immediately with zero work
 * ============================================================================
 */

import { PlayerSettings } from '../../utils/PlayerSettings.js';
import { logger } from '../../utils/Logger.js';
import { state } from '../../core/StateManager.js';

const log = logger.create('TrickplayManager');

export class TrickplayManager {
    constructor() {
        /*
         * Whether trickplay is enabled for the current session.
         * Cached from PlayerSettings on init() to avoid repeated localStorage
         * reads during rapid seek inputs (D-pad hold can fire 30×/s).
         */
        this._enabled = false;

        /*
         * Parsed trickplay info for the current media source.
         * Shape (from Jellyfin API):
         *   {
         *     Width:          number,  // thumbnail width in pixels
         *     Height:         number,  // thumbnail height in pixels
         *     TileWidth:      number,  // horizontal tiles per sprite sheet
         *     TileHeight:     number,  // vertical tiles per sprite sheet
         *     Interval:       number,  // milliseconds between captured frames
         *     ThumbnailCount: number   // total number of frames
         *   }
         */
        this._trickplayInfo = null;

        /* Jellyfin item ID for building the sprite sheet URL */
        this._itemId = null;

        /* Base server URL (no trailing slash) */
        this._serverUrl = null;

        /* API access token — appended as ?ApiKey= query param in sprite sheet URLs */
        this._authToken = null;

        /* Index of the sprite sheet that was most recently requested */
        this._lastSpriteSheetIndex = -1;

        /* Media Source ID - used in the image URL to improve server-side lookup */
        this._mediaSourceId = null;
    }

    // =========================================================================
    // Public API
    // =========================================================================

    /**
     * Initialize TrickplayManager for a new media item.
     *
     * Call this from OSDController.setMetadata() so that trickplay data is ready
     * before the user starts scrubbing.
     *
     * @param {Object}      item           - Jellyfin item object (must include Trickplay field)
     * @param {string}      mediaSourceId  - Media source ID to look up in item.Trickplay
     * @param {string}      serverUrl      - Jellyfin server base URL (no trailing slash)
     * @param {string}      authToken      - API access token
     */
    init(item, mediaSourceId, serverUrl, authToken) {
        /* Reset previous state every time a new item is loaded */
        this._reset();

        /* ------------------------------------------------------------------ */
        /* Fast exit: user disabled trickplay in settings                      */
        /* ------------------------------------------------------------------ */
        this._enabled = PlayerSettings.get('enableTrickplay') !== false;
        if (!this._enabled) {
            log.debug('Trickplay disabled by user setting — skipping init.');
            return;
        }

        /* Validate required parameters */
        if (!item || !mediaSourceId || !serverUrl || !authToken) {
            log.debug('TrickplayManager.init: missing required params, trickplay unavailable.');
            this._enabled = false;
            return;
        }

        /*
         * Identify the correct query parameter key name for the connected server.
         * Emby does not return a 'ProductName' in its public (unauthenticated)
         * System Info response, whereas Jellyfin does.
         */
        const serverInfo = state.get('server:info') || {};
        const isEmbyInstance = !!(serverInfo.ServerName && (!serverInfo.ProductName || serverInfo.ProductName.toLowerCase().includes('emby')));
        this._authParamKey = isEmbyInstance ? 'api_key' : 'ApiKey';

        /* ------------------------------------------------------------------ */
        /* Look up trickplay data in the item's Trickplay map                  */
        /* ------------------------------------------------------------------ */

        const trickplayBySource = item.Trickplay;
        if (!trickplayBySource) {
            log.debug('Item has no Trickplay data.');
            this._enabled = false;
            return;
        }

        const resolutions = trickplayBySource[mediaSourceId];
        if (!resolutions || typeof resolutions !== 'object') {
            log.debug(`No trickplay resolutions for mediaSourceId: ${mediaSourceId}`);
            this._enabled = false;
            return;
        }

        /* ------------------------------------------------------------------ */
        /* Select the best resolution (~20% of screen width, mirrors           */
        /* jellyfin-web's heuristic)                                           */
        /* ------------------------------------------------------------------ */
        const widths = Object.keys(resolutions).map(Number).sort((a, b) => a - b);

        if (widths.length === 0) {
            log.debug('Trickplay resolutions list is empty.');
            this._enabled = false;
            return;
        }

        /* Target roughly 12% of the current viewport width (optimized for performance on Tizen) */
        const targetWidth = Math.floor(window.innerWidth * 0.12);

        /*
         * Strategy: pick the largest width that is still ≤ target.
         * If all widths are larger than target, fall back to the smallest
         * available (better than nothing, and the CSS will size it correctly).
         */
        let selectedWidth = widths[0]; // Default to smallest
        for (const w of widths) {
            if (w <= targetWidth) {
                selectedWidth = w;
            }
        }

        const info = resolutions[selectedWidth];
        if (!info || !info.TileWidth || !info.TileHeight || !info.Interval) {
            log.debug(`Trickplay info for width ${selectedWidth} is incomplete:`, info);
            this._enabled = false;
            return;
        }

        /* Store the resolved info and credentials */
        this._trickplayInfo = {
            ...info,
            width: selectedWidth
        };
        this._itemId      = item.Id;
        this._mediaSourceId = mediaSourceId;
        this._serverUrl   = serverUrl;
        this._authToken   = authToken;

        log.info(
            `Trickplay ready: ${selectedWidth}×${info.Height}px tiles,`,
            `${info.Interval}ms interval. Performance: 12% scale target, q=30.`
        );
    }

    /**
     * Returns true if trickplay is enabled AND valid data was loaded.
     * Use this as a fast pre-check before calling getThumbnail() to avoid
     * any function-call overhead on every seek tick.
     *
     * @returns {boolean}
     */
    isEnabled() {
        return this._enabled;
    }

    /**
     * Calculate the CSS background properties for the trickplay thumbnail
     * that corresponds to the given playback position.
     *
     * @param {number} positionTicks - Current playback position in 100-ns ticks
     *
     * @returns {{ url: string, backgroundX: number, backgroundY: number,
     *             thumbWidth: number, thumbHeight: number,
     *             spriteWidth: number, spriteHeight: number } | null}
     *   Returns null if trickplay is disabled, no data, or position is out of range.
     */
    getThumbnail(positionTicks) {
        /* Fast exit when disabled or no data */
        if (!this._enabled || !this._trickplayInfo) return null;

        const info = this._trickplayInfo;

        /* ------------------------------------------------------------------ */
        /* Tile math (mirrors jellyfin-web's updateTrickplayBubbleHtml)        */
        /* ------------------------------------------------------------------ */

        /*
         * Convert ticks to milliseconds, then divide by the capture interval
         * to get the zero-based frame (thumbnail) index.
         * Round down — we show the nearest frame BEFORE the position.
         */
        const positionMs     = positionTicks / 10000;
        const frameIndex     = Math.max(0, Math.floor(positionMs / info.Interval));
        const tilesPerSheet  = info.TileWidth * info.TileHeight;

        /* Which sprite sheet JPEG contains this frame */
        const spriteSheetIdx = Math.floor(frameIndex / tilesPerSheet);

        /* Frame index within that particular sprite sheet */
        const offsetIndex    = frameIndex % tilesPerSheet;

        /*
         * Convert linear offset to 2D tile coordinates:
         *   tileX — column (0 = leftmost)
         *   tileY — row    (0 = topmost)
         */
        const tileX = offsetIndex % info.TileWidth;
        const tileY = Math.floor(offsetIndex / info.TileWidth);

        /*
         * CSS background-position moves the image LEFTWARD/UPWARD by the
         * pixel offset of the desired tile. Negative values are correct here.
         */
        const thumbWidth  = info.width;
        const thumbHeight = info.Height;
        const backgroundX = -(tileX * thumbWidth);
        const backgroundY = -(tileY * thumbHeight);

        /* ------------------------------------------------------------------ */
        /* Build the sprite sheet URL                                          */
        /* ------------------------------------------------------------------ */
        /*
         * Endpoint: GET /Videos/{ItemId}/Trickplay/{Width}/{SpriteSheetIndex}.jpg
         * We add quality=20 to encourage the server to serve a smaller JPEG,
         * and MediaSourceId to ensure we get the correct tiles for this stream.
         */
        // Sprite sheet URL — loaded via new Image(), so a query param is required for auth.
        // Use ApiKey= (non-deprecated) instead of the old api_key=.
        const url = `${this._serverUrl}/Videos/${this._itemId}/Trickplay/${thumbWidth}/${spriteSheetIdx}.jpg?${this._authParamKey}=${this._authToken}&quality=20&MediaSourceId=${this._mediaSourceId}`;

        /* Log only when the sheet changes (not on every frame) — avoids spam */
        if (spriteSheetIdx !== this._lastSpriteSheetIndex) {
            log.debug(`Sprite sheet ${spriteSheetIdx}: tile (${tileX},${tileY}), frame ${frameIndex}`);
            this._lastSpriteSheetIndex = spriteSheetIdx;

            /* Proactively pre-fetch the next and previous sprite sheets to eliminate loading flickers */
            this._prefetch(spriteSheetIdx + 1);
            if (spriteSheetIdx > 0) {
                this._prefetch(spriteSheetIdx - 1);
            }
        }

        return {
            url,
            backgroundX,
            backgroundY,
            thumbWidth,
            thumbHeight,
            /*
             * Total sprite sheet image dimensions (needed for background-size).
             * background-size must match the full sheet so the browser doesn't
             * scale the image and misalign the calculated tile offsets.
             */
            spriteWidth:  thumbWidth  * info.TileWidth,
            spriteHeight: thumbHeight * info.TileHeight
        };
    }

    /**
     * Release all cached state.
     * Call this from OSDController.onBeforeDestroy() and when playback stops.
     */
    destroy() {
        this._reset();
    }

    // =========================================================================
    // Private Helpers
    // =========================================================================

    /**
     * Trigger a background load for a sprite sheet so it's ready in the cache.
     * @param {number} index - Sprite sheet index
     * @private
     */
    _prefetch(index) {
        if (!this._trickplayInfo) return;
        
        const width = this._trickplayInfo.width;
        
        /* Stop if we exceed the total number of frames */
        const tilesPerSheet = this._trickplayInfo.TileWidth * this._trickplayInfo.TileHeight;
        if (index * tilesPerSheet >= this._trickplayInfo.ThumbnailCount) return;

        // Pre-fetch URL also uses the dynamic authentication parameter key
        const prefetchUrl = `${this._serverUrl}/Videos/${this._itemId}/Trickplay/${width}/${index}.jpg?${this._authParamKey}=${this._authToken}&quality=20&MediaSourceId=${this._mediaSourceId}`;
        
        const img = new Image();
        img.src = prefetchUrl;
    }

    /**
     * Reset internal state to a clean slate.
     * @private
     */
    _reset() {
        this._enabled            = false;
        this._trickplayInfo      = null;
        this._itemId             = null;
        this._mediaSourceId      = null;
        this._serverUrl          = null;
        this._authToken          = null;
        this._lastSpriteSheetIndex = -1;
        this._authParamKey       = null;
    }
}
