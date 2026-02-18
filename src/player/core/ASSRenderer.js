/**
 * ASSRenderer — ASS/SSA Subtitle Renderer
 *
 * Renders ASS subtitles as DOM elements overlaid on the video using libjass.
 * libjass uses pure inline styles (no CSS variables, no nesting) making it
 * natively compatible with Tizen 4+ (Chrome 56+).
 *
 * Two rendering modes:
 *   1. HTML5 video: Uses WebRenderer + VideoClock (auto clock sync, manual DOM)
 *   2. Tizen AVPlay: Uses WebRenderer + ManualClock (manual time sync via tick())
 *
 * We always use WebRenderer directly (not DefaultRenderer) because
 * DefaultRenderer replaces the video element in the DOM with its own wrapper,
 * which breaks the player's existing layout and positioning.
 *
 * @module core/ASSRenderer
 */

import libjass from 'libjass';
import 'libjass/libjass.css';
import { logger } from '../../utils/Logger.js';

const log = logger.create('ASSRenderer');


export default class ASSRenderer {
    /**
     * @param {Object} options
     * @param {HTMLElement} options.container - Container element that wraps the video
     * @param {HTMLVideoElement} [options.video] - The video element (for VideoClock sync)
     * @param {number} [options.width] - Video width (required if video not provided)
     * @param {number} [options.height] - Video height (required if video not provided)
     */
    constructor({ container, video, width, height }) {
        // The container that overlaps the video — we render subtitles inside this
        this._container = container;

        // If a video element is provided, we use VideoClock for auto time-sync.
        // Otherwise, ManualClock for Tizen AVPlay.
        this._videoElement = video || null;
        this._isVirtual = !video;

        // Video dimensions (used for calculating subtitle overlay size)
        this._videoWidth = width || 1920;
        this._videoHeight = height || 1080;

        // libjass WebRenderer instance
        this._renderer = null;
        // Clock instance (VideoClock or ManualClock)
        this._clock = null;
        // The wrapper div that libjass manages
        this._wrapper = null;
        // Current font family override (e.g. 'Poppins')
        this._fontFamily = null;
        // Current font class override (e.g. 'font-poppins')
        this._fontClass = null;
        // Store the original raw content for re-parsing on style changes
        this._rawContent = null;
        // Last known playback time for nudging on style change
        this._lastTime = null;

        log.info('ASSRenderer initialized' +
            (this._isVirtual ? ' (AVPlay/ManualClock mode)' : ' (HTML5/VideoClock mode)'));
    }

    // ========================================================================
    // Public API
    // ========================================================================

    /**
     * Update the current playback time (only used for AVPlay/ManualClock mode).
     * In HTML5 video mode, VideoClock auto-syncs with the video element.
     *
     * @param {number} timeSeconds - Current time in seconds
     */
    tick(timeSeconds) {
        this._lastTime = timeSeconds;
        if (this._clock) {
            this._clock.tick(timeSeconds);
        }
    }

    /**
     * Resize the subtitle area to match current video/container dimensions.
     *
     * @param {number} [width] - New video width (optional, reads from video element)
     * @param {number} [height] - New video height (optional, reads from video element)
     */
    resize(width, height) {
        if (width) this._videoWidth = width;
        if (height) this._videoHeight = height;

        if (this._renderer) {
            this._resizeRenderer();
        }
    }

    /**
     * Load and render an ASS subtitle track.
     * Parses the ASS content and creates the WebRenderer.
     *
     * @param {string} content - Raw ASS/SSA subtitle file content
     */
    async setTrack(content) {
        if (typeof content !== 'string') {
            log.error('setTrack received non-string content:', typeof content);
            throw new Error('Subtitle content must be a string');
        }

        // Destroy any existing renderer before creating a new one
        this.destroy();

        try {
            // Store the original content for later style changes
            this._rawContent = content;

            // Parse the raw ASS content into a structured ASS object
            log.info('Pre-processing ASS content for style enforcement...');
            const processedContent = this._preProcessAssContent(content, this._fontFamily);
            
            this._ass = await libjass.ASS.fromString(processedContent);
            log.info(`ASS parsed: ${this._ass.dialogues.length} dialogue lines, ` +
                     `script res: ${this._ass.properties.resolutionX}x${this._ass.properties.resolutionY}`);

            // Create the renderer (always WebRenderer, different clock per mode)
            this._createRenderer();

            log.info('ASS renderer created successfully');
        } catch (err) {
            const errorMsg = err ? (err.name + ': ' + err.message + '\n' + err.stack) : err;
            log.error('Failed to create ASS renderer:', errorMsg);
            this.destroy();
            throw err;
        }
    }

    /**
     * Set subtitle timing offset.
     * Note: libjass doesn't have a built-in delay property. For ManualClock
     * mode, we offset the time in tick(). For VideoClock mode, this is a no-op
     * for now.
     *
     * @param {number} seconds - Offset in seconds
     */
    setDelay(seconds) {
        this._delaySeconds = seconds || 0;
        log.debug(`Subtitle delay set to ${seconds}s`);
    }

    /**
     * Set a custom font styles on the subtitle wrapper and the ASS object.
     * This allows overriding the embedded ASS fonts with a user-selected font.
     * @param {string} className - CSS class name (e.g. 'font-poppins')
     * @param {string} fontFamily - Raw font family name (e.g. 'Poppins')
     */
    async setFontStyles(className, fontFamily, fontScale = 1.0, outlineThickness = 0.4, shadowThickness = 0.3) {
        log.info(`ASSRenderer.setFontStyles: class="${className}", family="${fontFamily}", scale=${fontScale}, outline=${outlineThickness}, shadow=${shadowThickness}`);
        this._fontClass = className;
        this._fontFamily = fontFamily;
        this._fontScale = fontScale;
        this._outlineThickness = outlineThickness;
        this._shadowThickness = shadowThickness;

        if (this._wrapper) {
            this._wrapper.className = 'libjass-wrapper ' + (className || '');
            log.debug(`Wrapper className set to: ${this._wrapper.className}`);
        }

        if (this._rawContent && fontFamily) {
            log.info(`Re-parsing ASS with new font choice: ${fontFamily} (Scale: ${fontScale}, Out: ${outlineThickness}, Shad: ${shadowThickness})`);
            
            // Re-preprocess and re-parse the entire string.
            // This is the most "Nuclear" and definitive way to ensure the new font
            // and border styles are applied throughout the entire track.
            const processedContent = this._preProcessAssContent(this._rawContent, fontFamily, fontScale, outlineThickness, shadowThickness);
            this._ass = await libjass.ASS.fromString(processedContent);

            // Re-creating the renderer is the only way to apply ASS object changes
            // The renderer will now handle its own "nudge" once ready.
            this._createRenderer();
        }
    }

    _preProcessAssContent(content, fontFamily, fontScale = 1.0, outlineThickness = 0.4, shadowThickness = 0.3) {
        if (!content) return content;

        log.info(`Preprocessing ASS content with font="${fontFamily}", scale=${fontScale}, outline=${outlineThickness}, shadow=${shadowThickness}`);

        const lines = content.split(/\r?\n/);
        let styleFormat = null;
        let stylesOverridden = 0;

        const processedLines = lines.map(line => {
            const trimmed = line.trim();
            
            // 1. Capture the Styles format line
            if (trimmed.startsWith('Format:') && (trimmed.includes('Outline') || trimmed.includes('Fontname'))) {
                // Ensure we handle both "Format:" and "[V4 Styles]" headers correctly if needed
                // For now we just parse the format line in the Styles section.
                styleFormat = trimmed.substring(trimmed.indexOf(':') + 1).split(',').map(s => s.trim());
                log.debug(`Found Styles Format: ${styleFormat.join(', ')}`);
                return line;
            }
            
            // 2. Override Style definitions
            if (trimmed.startsWith('Style:') && styleFormat) {
                const parts = line.substring(line.indexOf(':') + 1).split(',');
                
                // Override Fontname
                const fontIdx = styleFormat.indexOf('Fontname');
                if (fontIdx !== -1 && fontFamily) {
                    parts[fontIdx] = fontFamily;
                }
                
                // Override Fontsize - Scaling up if a specific boost is requested (e.g. for Noto Arabic)
                const sizeIdx = styleFormat.indexOf('Fontsize');
                if (sizeIdx !== -1 && fontFamily && fontScale !== 1.0) {
                    const originalSize = parseFloat(parts[sizeIdx]);
                    if (!isNaN(originalSize)) {
                        parts[sizeIdx] = (originalSize * fontScale).toFixed(2);
                    }
                }
                
                // Override Outline
                const outlineIdx = styleFormat.indexOf('Outline');
                if (outlineIdx !== -1) {
                    parts[outlineIdx] = String(outlineThickness);
                }
                
                // Override Shadow
                const shadowIdx = styleFormat.indexOf('Shadow');
                if (shadowIdx !== -1) {
                    parts[shadowIdx] = String(shadowThickness);
                }
                
                stylesOverridden++;
                // Adding a space after "Style: " for standard ASS compatibility
                return 'Style: ' + parts.join(',');
            }

            // 3. Strip problematic inline overrides from Dialogues (\fn, \bord, \shad, etc.)
            if (trimmed.startsWith('Dialogue:')) {
                // This regex strips \fn..., \bord..., \shad..., \out..., etc.
                // It targets the tag name and everything until the next \ or }
                return line.replace(/\\(fn|bord|shad|s?out|s?shad)[^\\}]+(?=[\\}])/g, '');
            }

            return line;
        });

        log.info(`ASS Pre-processor: Overrode ${stylesOverridden} style(s) with font "${fontFamily}"`);
        return processedLines.join('\n');
    }

    /**
     * Show subtitles (if hidden).
     */
    show() {
        if (this._wrapper) {
            this._wrapper.style.display = '';
        }
    }

    /**
     * Hide subtitles without destroying the renderer.
     */
    hide() {
        if (this._wrapper) {
            this._wrapper.style.display = 'none';
        }
    }

    /**
     * Destroy the renderer and clean up all resources.
     * Safe to call multiple times.
     */
    destroy() {
        // Remove event listeners for video and window events
        if (this._onMetadata && this._videoElement) {
            this._videoElement.removeEventListener('loadedmetadata', this._onMetadata);
            this._onMetadata = null;
        }

        if (this._videoElement) {
            this._videoElement.removeEventListener('timeupdate', this._onTimeUpdate);
            this._videoElement.removeEventListener('seeking', this._onSeeking);
            this._videoElement.removeEventListener('play', this._onPlay);
            this._videoElement.removeEventListener('pause', this._onPause);
        }

        if (this._onWindowResize) {
            window.removeEventListener('resize', this._onWindowResize);
            this._onWindowResize = null;
        }

        // Disable the clock first (stops ticking)
        if (this._clock) {
            try {
                this._clock.disable();
            } catch (err) {
                log.warn('Error disabling clock:', err);
            }
            this._clock = null;
        }

        // Clear the renderer reference
        if (this._renderer) {
            this._renderer = null;
            log.info('ASS renderer destroyed');
        }

        // Remove the wrapper div from the DOM
        if (this._wrapper && this._wrapper.parentNode) {
            this._wrapper.parentNode.removeChild(this._wrapper);
        }
        this._wrapper = null;

        this._ass = null;
    }

    // ========================================================================
    // Private: Renderer Creation
    // ========================================================================

    /**
     * Create the WebRenderer with the appropriate clock.
     *
     * For HTML5 video mode: uses VideoClock (auto-syncs with <video> events)
     * For AVPlay mode: uses ManualClock (driven via tick() calls)
     *
     * We always use WebRenderer directly instead of DefaultRenderer because
     * DefaultRenderer does DOM manipulation (replaces the video element with
     * a wrapper div) that breaks our player's layout. By using WebRenderer,
     * we keep full control of the DOM.
     *
     * @private
     */
    _createRenderer() {
        // IMPORTANT: Thoroughly clean up any previous renderer/clock/DOM
        // This prevents "stacking" where multiple clocks/wrappers fight for resources.
        if (this._clock) {
            try {
                this._clock.disable();
                log.info('Disabled old ASS clock');
            } catch (err) {
                log.warn('Error disabling old clock:', err);
            }
            this._clock = null;
        }

        if (this._renderer) {
            this._renderer = null;
        }

        if (this._wrapper && this._wrapper.parentNode) {
            log.info('Removing old subtitle wrapper');
            this._wrapper.parentNode.removeChild(this._wrapper);
            this._wrapper = null;
        }

        // Create the wrapper div for subtitle rendering
        this._wrapper = document.createElement('div');
        this._wrapper.className = 'libjass-wrapper';
        this._wrapper.style.position = 'absolute';
        this._wrapper.style.top = '0';
        this._wrapper.style.left = '0';
        this._wrapper.style.width = '100%';
        this._wrapper.style.height = '100%';
        this._wrapper.style.pointerEvents = 'none';
        this._wrapper.style.zIndex = '1';

        // Append to the player container (overlays the video)
        this._container.appendChild(this._wrapper);

        // Re-apply class if it was set
        if (this._fontClass) {
            this._wrapper.className = 'libjass-wrapper ' + this._fontClass;
        }

        // Create the clock based on what mode we're in
        // Create the clock - We now UNIFY on ManualClock for both HTML5 and AVPlay.
        // This avoids the lack of seeking() in VideoClock and gives us perfect control.
        this._clock = new libjass.renderers.ManualClock();
        log.info('Created ManualClock (Unified Strategy)');

        if (this._videoElement) {
            // Drive the ManualClock via HTML5 Video events
            this._onTimeUpdate = () => this.tick(this._videoElement.currentTime);
            this._onSeeking = () => {
                // ManualClock uses tick() for both progression and seeking
                if (this._clock) this._clock.tick(this._videoElement.currentTime);
            };
            this._onPlay = () => {
                if (this._clock) this._clock.play();
            };
            this._onPause = () => {
                if (this._clock) this._clock.pause();
            };

            this._videoElement.addEventListener('timeupdate', this._onTimeUpdate);
            this._videoElement.addEventListener('seeking', this._onSeeking);
            this._videoElement.addEventListener('play', this._onPlay);
            this._videoElement.addEventListener('pause', this._onPause);

            // Sync initial state
            if (!this._videoElement.paused) {
                this._clock.play();
            }
            this._clock.tick(this._videoElement.currentTime);
        }

        // Renderer settings — disable SVG filters for Tizen compatibility
        // (uses CSS text-shadow instead, which works on Chrome 56+)
        const settings = new libjass.renderers.RendererSettings();
        settings.enableSvg = true;

        // Create WebRenderer: (ass, clock, wrapperDiv, settings)
        this._renderer = new libjass.renderers.WebRenderer(
            this._ass,
            this._clock,
            this._wrapper,
            settings
        );

        // When the renderer is ready (fonts measured, etc.), do initial sizing
        this._renderer.addEventListener('ready', () => {
            log.info('WebRenderer ready, triggering initial resize');

            // Size the subtitle overlay to match the video
            this._resizeRenderer();

            // For ManualClock, start playing (it's paused by default)
            if (this._isVirtual && this._clock) {
                this._clock.play();
            }

            // Nudge the renderer to show subs immediately, especially if paused.
            // Priority: Last tracked tick > Actual video currentTime > 0
            const nudgeTime = this._lastTime ?? (this._videoElement ? this._videoElement.currentTime : 0);
            log.info(`ASSRenderer: Nudging renderer on ready at ${nudgeTime}s`);
            if (this._clock) {
                // ManualClock uses tick() to sync to a specific point in time
                this._clock.tick(nudgeTime);
            }
        });

        // ================================================================
        // Re-resize when video dimensions become available or change.
        // The 'ready' event often fires before loadedmetadata, so
        // videoWidth/Height are 0 at that point.
        // ================================================================
        if (this._videoElement) {
            this._onMetadata = () => {
                log.info('Video metadata loaded, re-resizing subtitle overlay');
                this._resizeRenderer();
            };
            this._videoElement.addEventListener('loadedmetadata', this._onMetadata);

            // If metadata is already loaded (video already playing), resize now
            if (this._videoElement.videoWidth > 0) {
                log.info('Video metadata already available, resizing immediately');
                // Small delay to ensure DOM is settled
                setTimeout(() => this._resizeRenderer(), 100);
            }
        }

        // Re-resize when the window/container changes size
        this._onWindowResize = () => this._resizeRenderer();
        window.addEventListener('resize', this._onWindowResize);
    }

    /**
     * Resize the WebRenderer's subtitle area to match the video dimensions.
     * Accounts for letterboxing when the container aspect ratio differs
     * from the video aspect ratio.
     *
     * @private
     */
    _resizeRenderer() {
        if (!this._renderer || !this._wrapper) return;

        // For HTML5 video, read the actual video element dimensions
        let videoWidth = this._videoWidth;
        let videoHeight = this._videoHeight;
        if (this._videoElement) {
            videoWidth = this._videoElement.videoWidth || this._videoWidth;
            videoHeight = this._videoElement.videoHeight || this._videoHeight;
        }

        // Container dimensions (what space we have to render in)
        const containerWidth = this._container.offsetWidth || videoWidth;
        const containerHeight = this._container.offsetHeight || videoHeight;

        // Compute the scale factor to fit video in the container
        // while preserving aspect ratio (letterboxing)
        const ratio = Math.min(
            containerWidth / videoWidth,
            containerHeight / videoHeight
        );

        // Calculate the subtitle overlay size and offset (centered)
        const subsWidth = videoWidth * ratio;
        const subsHeight = videoHeight * ratio;
        const subsLeft = (containerWidth - subsWidth) / 2;
        const subsTop = (containerHeight - subsHeight) / 2;

        log.debug(`Resize: video=${videoWidth}x${videoHeight}, ` +
                  `container=${containerWidth}x${containerHeight}, ` +
                  `subs=${subsWidth.toFixed(0)}x${subsHeight.toFixed(0)}, ` +
                  `offset=(${subsLeft.toFixed(0)},${subsTop.toFixed(0)})`);

        // Tell libjass the subtitle rendering area dimensions + position
        this._renderer.resize(subsWidth, subsHeight, subsLeft, subsTop);
    }
}
