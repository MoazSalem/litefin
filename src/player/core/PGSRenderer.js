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
    constructor({ track, videoElement, container, subUrl, timeOffset = 0 }) {
        this.track = track;
        this._video = videoElement;
        this._container = container;
        this._url = subUrl;
        this._timeOffset = timeOffset;
        this._renderer = null;
        this._canvas = null;
        this._canvasWrapper = null;
        this._isDestroyed = false;

        this._init();
    }

    /**
     * Initialize the renderer
     * @private
     */
    _init() {
        log.info(`Initializing PGS renderer for track "${this.track.DisplayTitle}"`);

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

        // libpgs expects a canvas element if we want to manaul control it
        this._canvas = document.createElement('canvas');
        this._canvas.style.width = '100%';
        this._canvas.style.height = '100%';
        this._canvas.style.objectFit = 'contain';

        this._canvasWrapper.appendChild(this._canvas);
        this._container.appendChild(this._canvasWrapper);

        // Config object for libpgs
        const config = {
            video: this._video, // Can be null/undefined for AVPlay, libpgs handles it if we provide canvas
            canvas: this._canvas,
            subUrl: this._url,
            workerUrl: 'js/libpgs.worker.js', // Copied to js/ by webpack
            timeOffset: this._timeOffset
        };

        try {
            this._renderer = new PgsRenderer(config);
            log.debug('PgsRenderer instance created');
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
            // libpgs expects timestamp in seconds
            // We need to add the offset manually if using renderAtTimestamp directly?
            // Actually libpgs.js source shows:
            // renderAtVideoTimestamp() { this.video && this.renderAtTimestamp(this.video.currentTime + this.$timeOffset) }
            // So for manual tick, we should implement logic similar to renderAtVideoTimestamp
            
            // However, PgsRenderer class on libpgs documentation or main file might behave differently. 
            // Checking source: renderAtTimestamp calls `this.implementation.renderAtTimestamp(t)`
            
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
