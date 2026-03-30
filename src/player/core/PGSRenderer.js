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
        // libpgs supports three modes: 'worker' (OffscreenCanvas), 
        // 'workerWithoutOffscreenCanvas', and 'mainThread'.
        //
        // On Tizen and WebOS, the worker-based modes silently fail because:
        //   1. The libpgs worker file ('libpgs.worker.js') is not bundled into
        //      the webpack output as a separate asset — it's not being copied
        //      or emitted by any webpack rule.
        //   2. new Worker(workerUrl) 404s silently; all subsequent postMessage()
        //      calls go into a dead worker and the subtitle canvas stays blank.
        //
        // 'mainThread' mode bypasses the Web Worker entirely — libpgs parses 
        // the .sup file and renders PGS bitmaps directly on the main thread.
        // This is slightly less performant but works reliably on all TV platforms.
        // ====================================================================
        const isTizen = typeof tizen !== 'undefined' ||
            navigator.userAgent.indexOf('SMART-TV') >= 0 ||
            navigator.userAgent.indexOf('Tizen') >= 0;
        const isWebOS = navigator.userAgent.indexOf('Web0S') >= 0 ||
            navigator.userAgent.indexOf('WebOS') >= 0;

        // Force main thread rendering on TV platforms where the worker approach fails
        const rendererMode = (isTizen || isWebOS) ? 'mainThread' : undefined; // undefined = auto-detect

        // Create a wrapper for the canvas to ensure correct positioning
        this._canvasWrapper = document.createElement('div');
        this._canvasWrapper.className = 'pgs-subtitle-wrapper';
        this._canvasWrapper.style.position = 'absolute';
        this._canvasWrapper.style.top = '0';
        this._canvasWrapper.style.left = '0';
        this._canvasWrapper.style.width = '100%';
        this._canvasWrapper.style.height = '100%';
        this._canvasWrapper.style.pointerEvents = 'none';
        this._canvasWrapper.style.zIndex = '200'; // Above video, below OSD

        // libpgs expects a canvas element if we want to manually control it
        this._canvas = document.createElement('canvas');
        this._canvas.style.width = '100%';
        this._canvas.style.height = '100%';
        this._canvas.style.objectFit = 'contain';

        this._canvasWrapper.appendChild(this._canvas);
        this._container.appendChild(this._canvasWrapper);

        // Config for libpgs — note: we do NOT pass subUrl here.
        // SubtitleManager pre-fetches the .sup and passes an ArrayBuffer via `subBuffer`.
        // Passing subUrl would make libpgs do its own internal fetch (no error propagation),
        // which silently fails on Tizen and leaves updateTimestamps empty forever.
        const config = {
            video: this._video, // null for AVPlay; libpgs is OK without a video element
            canvas: this._canvas,
            timeOffset: this._timeOffset,
            // Mode override: TV platforms use main thread to avoid dead-worker 404 issues
            ...(rendererMode ? { mode: rendererMode } : { workerUrl: 'js/libpgs.worker.js' })
        };

        log.debug(`PGS renderer mode: ${rendererMode || 'auto-detect (non-TV)'}`);

        try {
            this._renderer = new PgsRenderer(config);
            log.debug('PgsRenderer instance created');

            // ================================================================
            // Post-load dedup-reset guard  (applies to BOTH loading paths)
            //
            // loadFromUrl() and loadFromBuffer() are both async internally.
            // ticks() start arriving before the file is fully parsed, so
            // updateTimestamps is still empty.  getIndexFromTimestamps returns
            // -1, renderAtIndex sets previousTimestampIndex = -1, and when
            // real timestamps finally arrive:
            //   • libpgs's default onTimestampsUpdated calls renderAtVideoTimestamp()
            //     which needs this.video — null on Tizen → complete no-op.
            //   • subsequent ticks at a time before the first subtitle also map
            //     to -1 → dedup guard fires → no render ever.
            //
            // Fix: replace the default callback with one that directly resets
            // previousTimestampIndex to NaN (NaN !== any number, so the dedup
            // guard always passes on the next call) then re-renders at the
            // last-known playback position.  This happens once after load and
            // is harmless for subsequent onTimestampsUpdated calls (partial-
            // progress updates during URL streaming) because we always re-
            // render at current time regardless.
            // ================================================================
            this._renderer.implementation.onTimestampsUpdated = () => {
                this._isBufferLoaded = true;
                if (this._lastTickTime !== null && !this._isDestroyed) {
                    log.debug(`Timestamps updated — re-rendering at t=${this._lastTickTime.toFixed(2)}s (dedup reset)`);
                    // TypeScript 'private' is erased at runtime — safe to set directly.
                    this._renderer.implementation.previousTimestampIndex = NaN;
                    this._renderer.renderAtTimestamp(this._lastTickTime + this._timeOffset);
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

            // libpgs expects timestamp in seconds.
            // renderAtTimestamp handles the timestamp→index lookup internally.
            const targetTime = currentTime + this._timeOffset;
            this._renderer.renderAtTimestamp(targetTime);
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
            this._renderer.dispose();
            this._renderer = null;
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
