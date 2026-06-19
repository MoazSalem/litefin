/**
 * PGSRenderer — Image-based PGS Subtitle Renderer
 *
 * Renders PGS (Presentation Graphics Stream) subtitles using libpgs.
 * libpgs uses Web Workers and OffscreenCanvas for performance.
 *
 * @module core/PGSRenderer
 */

import { PgsRenderer } from 'libpgs';
import { logger } from '../../utils/Logger.js';

const log = logger.create('PGSRenderer');

class PGSRenderer {
    /**
     * Create a new PGS renderer
     * @param {Object} context - Render context
     * @param {Object} context.track - The subtitle track object
     * @param {HTMLVideoElement} [context.videoElement] - The video element (optional for AVPlay)
     * @param {HTMLElement} context.container - The container to append the canvas to
     * @param {string} context.subUrl - The URL to the .sup subtitle file
     * @param {number} [context.timeOffset=0] - Time offset in seconds
     */
    constructor({ track, videoElement, container, subUrl, subBuffer, timeOffset = 0 }) {
        this.track = track;
        this._video = videoElement;
        this._container = container;
        this._url = subUrl || null;           // Fallback URL for non-TV / legacy path
        this._subBuffer = subBuffer || null;  // Pre-fetched binary, preferred on Tizen
        this._timeOffset = timeOffset;
        this._renderer = null;
        this._canvas = null;
        this._canvasWrapper = null;
        this._isDestroyed = false;
        this._hasLoggedFirstTick = false;    // One-time tick confirmation log
        this._lastTickTime = null;           // Last time passed to tick() — used for post-load re-render
        this._isBufferLoaded = false;        // True once loadFromBuffer().then() has resolved

        this._init();
    }

    /**
     * Initialize the renderer
     * @private
     */
    _init() {
        log.info(`Initializing PGS renderer for track "${this.track.DisplayTitle}"`);

        // ====================================================================
        // Renderer mode selection
        //
        // We explicitly force 'workerWithoutOffscreenCanvas' for all TV platforms.
        // Webpack is configured to copy 'libpgs.worker.js' to the 'js/' directory.
        // Using a Web Worker pushes the heavy binary extraction and RLE decoding
        // of `.pgssub` streams onto a background thread.
        // 
        // While this does not make the 30-second network parsing phase faster,
        // it completely frees up the Main Thread, allowing the TV UI, OSD,
        // and background video playback to remain perfectly smooth instead
        // of freezing entirely while libpgs crunches the arrays.
        // ====================================================================
        const rendererMode = 'workerWithoutOffscreenCanvas';

        // Create a wrapper for the canvas to ensure correct positioning
        this._canvasWrapper = document.createElement('div');
        this._canvasWrapper.className = 'pgs-subtitle-wrapper';
        this._canvasWrapper.style.position = 'absolute';
        this._canvasWrapper.style.top = '0';
        this._canvasWrapper.style.left = '0';
        this._canvasWrapper.style.width = '100%';
        this._canvasWrapper.style.height = '100%';
        this._canvasWrapper.style.pointerEvents = 'none';
        this._canvasWrapper.style.zIndex = '30'; // Above video, below OSD (50-100)

        // libpgs expects a canvas element if we want to manually control it
        this._canvas = document.createElement('canvas');
        this._canvas.style.width = '100%';
        this._canvas.style.height = '100%';
        this._canvas.style.objectFit = 'contain';

        this._canvasWrapper.appendChild(this._canvas);
        this._container.appendChild(this._canvasWrapper);

        const config = {
            video: this._video, // null for AVPlay; libpgs is OK without a video element
            canvas: this._canvas,
            timeOffset: this._timeOffset,
            mode: rendererMode,
            workerUrl: 'js/libpgs.worker.js'
        };

        log.debug(`PGS renderer mode: ${rendererMode} (Worker: ${config.workerUrl})`);

        try {
            this._renderer = new PgsRenderer(config);
            log.debug('PgsRenderer instance created');

            // ================================================================
            // THE REAL FIX: Override renderAtIndex to prevent -1 from ever
            // being cached as previousTimestampIndex.
            //
            // Reading the libpgs dist confirms:
            //   • previousTimestampIndex initialises to 0 (not -1).
            //   • renderAtIndex(t) dedup check: if (previousTimestampIndex !== t)
            //       → previousTimestampIndex = t; render(t)
            //   • getIndexFromTimestamps returns -1 when t < timestamps[0],
            //     i.e. when playback is before the very first subtitle cue.
            //
            // On Tizen the AVPlay startup stabilisation holds the timeline
            // near t=0 for several seconds — before subtitle cues begin.
            // Every tick() + every post-load rAF calls renderAtTimestamp(~0)
            // → getIndexFromTimestamps → -1 → renderAtIndex(-1)
            //   → previousTimestampIndex = -1  ← POISONED
            // From that point every further call returns -1 → dedup fires
            // → render() never called → subtitles invisible until seek.
            //
            // Fix: patch renderAtIndex so -1 is NEVER stored. The dedup still
            // works normally for valid (≥ 0) cue indices, avoiding redundant
            // GPU paints. Only the "nothing here yet" sentinel is exempted.
            // ================================================================
            this._renderer.implementation.renderAtIndex = function (index) {
                if (index < 0) {
                    // Log once per change so we don't spam 60 times a second
                    if (this.previousTimestampIndex !== -1) {
                        log.debug('getIndexFromTimestamps returned -1: Parse progress has not yet reached the requested playback time, waiting...');
                    }
                    // Before the first cue or past the last — clear canvas but
                    // do NOT cache -1 as previousTimestampIndex, so the very
                    // next tick that lands on a real cue is never suppressed.
                    this.render(index);
                    return;
                }

                // Track when the subtitle FINALLY catches up to the playback target!
                if (this.previousTimestampIndex === undefined || this.previousTimestampIndex === -1 || isNaN(this.previousTimestampIndex)) {
                    log.info(`BINGO! Target subtitle cue ${index} successfully mapped and rendered.`);
                }

                // Standard dedup for actual subtitle frames: only repaint when
                // the cue index changes (avoids churning the GPU every tick).
                if (this.previousTimestampIndex !== index) {
                    this.previousTimestampIndex = index;
                    this.render(index);
                }
            };

            // ================================================================
            // Post-parse hook: trigger a render at the current playing time so
            // progressive subtitles appear as they download.
            // ================================================================
            this._renderer.implementation.onTimestampsUpdated = () => {
                this._isBufferLoaded = true;
                if (this._isDestroyed) return;

                // Show how many subtitles are loaded so far (if property exists)
                const c = this._renderer.implementation.timestamps ? this._renderer.implementation.timestamps.length : '?';

                // Throttle the rendering requests so we don't spam the browser
                // if libpgs emits 50 update events in a single microtask burst.
                if (!this._isRenderingPending) {
                    this._isRenderingPending = true;

                    requestAnimationFrame(() => {
                        this._isRenderingPending = false;
                        if (!this._isDestroyed && this._renderer) {
                            const renderTime = this._lastTickTime !== null
                                ? this._lastTickTime + this._timeOffset
                                : this._timeOffset;

                            log.debug(`Parsing active: ${c} cues mapped so far. Checking target t=${renderTime.toFixed(2)}s...`);
                            this._renderer.renderAtTimestamp(renderTime);
                        }
                    });
                }
            };

            if (this._url) {
                // Primary path: pass the URL to libpgs — it streams the file
                // progressively (StreamBinaryReader on modern Chromium, falling back
                // to ArrayBinaryReader) without holding the entire file in JS heap.
                // SubtitleManager already validated the URL via HEAD before getting here.
                log.debug(`Loading PGS from URL (streaming): ${this._url}`);
                this._renderer.loadFromUrl(this._url);
            } else if (this._subBuffer) {
                // Fallback path: pre-fetched ArrayBuffer (kept for compatibility
                // in case the caller already has the buffer in memory).
                log.debug(`Loading PGS from pre-fetched buffer (${this._subBuffer.byteLength.toLocaleString()} bytes)`);
                this._renderer.loadFromBuffer(this._subBuffer);
            } else {
                log.error('PGSRenderer: no subUrl or subBuffer provided — subtitle will not render');
            }
        } catch (e) {
            log.error('Failed to create PgsRenderer:', e);
        }
    }


    /**
     * Update the time offset
     * @param {number} offset - Offset in seconds
     */
    setOffset(offset) {
        this._timeOffset = offset;
        if (this._renderer) {
            this._renderer.timeOffset = offset;
        }
    }

    /**
     * Resize the subtitle canvas (if needed)
     */
    resize() {
        // CSS handles this mostly, but we can force a redraw if needed
    }

    /**
     * Tick function for manual timing (Tizen AVPlay)
     * @param {number} currentTime - Current playback time in seconds
     */
    tick(currentTime) {
        if (this._renderer) {
            // Log the first tick once to confirm the time-update loop is connected
            if (!this._hasLoggedFirstTick) {
                this._hasLoggedFirstTick = true;
                log.debug(`First tick received at t=${currentTime.toFixed(2)}s — PGS renderer is active`);
            }

            // Always track the most recent time so the post-load re-render has
            // a valid position to render at when the buffer finishes parsing.
            this._lastTickTime = currentTime;

            // ================================================================
            // CRITICAL: Do NOT call renderAtTimestamp until the buffer is fully
            // parsed. If we render during parsing, libpgs returns index -1 for
            // every timestamp (no cues loaded yet). This -1 gets cached in
            // previousTimestampIndex.  Once the buffer is ready, any tick that
            // lands between subtitle cues ALSO returns -1, matching the cached
            // value and triggering the dedup guard — painting nothing forever.
            // onTimestampsUpdated resets the lock unconditionally after parsing.
            // ================================================================
            if (!this._isBufferLoaded) return;

            // libpgs expects timestamp in seconds.
            // renderAtTimestamp handles the timestamp→index lookup internally.
            const targetTime = currentTime + this._timeOffset;
            this._renderer.renderAtTimestamp(targetTime);
        }
    }

    /**
     * Clear the PGS canvas immediately (e.g. on seek).
     * 
     * Forces libpgs to render timestamp -1, which is before the timeline begins.
     * This triggers a clean wipe of the OffscreenCanvas rendering context 
     * and clears any current subtitle frames from the screen instantly.
     */
    clear() {
        // Only trigger clear if the renderer is fully active and not destroyed
        if (this._renderer && !this._isDestroyed) {
            // Fancy Logging: track seek clearing action
            log.info('Clearing PGS canvas instantly on seek');

            try {
                // Ticking/rendering to -1 forces a canvas repaint to blank
                this._renderer.renderAtTimestamp(-1);
            } catch (e) {
                // Safeguard against any internal worker sync exceptions
                log.warn('Failed to clear PGS renderer canvas:', e);
            }
        }
    }

    /**
     * Destroy the renderer
     */
    destroy() {
        if (this._isDestroyed) return;
        this._isDestroyed = true;

        log.info('Destroying PGS renderer');

        if (this._renderer) {
            // Sever the callback BEFORE dispose() — libpgs's internal async
            // promise chain (loadFromBuffer parsing, streaming chunks) does NOT
            // stop when dispose() is called. If onTimestampsUpdated is still set,
            // it fires our closure which logs, mutates implementation state, and
            // schedules rAF callbacks long after the player has exited.
            if (this._renderer.implementation) {
                this._renderer.implementation.onTimestampsUpdated = null;
            }

            this._renderer.dispose();
            this._renderer = null;
        }

        if (this._url && this._url.startsWith('blob:')) {
            URL.revokeObjectURL(this._url);
            log.debug('Revoked blob URL for PGS track');
        }

        if (this._canvasWrapper && this._canvasWrapper.parentNode) {
            this._canvasWrapper.parentNode.removeChild(this._canvasWrapper);
        }

        this._canvas = null;
        this._canvasWrapper = null;
        this._video = null;
        this._container = null;
    }
}

export default PGSRenderer;
