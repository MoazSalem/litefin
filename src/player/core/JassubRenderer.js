/**
 * ============================================================================
 * JassubRenderer — High-Performance WASM/WebGL ASS Subtitle Renderer
 * ============================================================================
 * Wraps ThaUnknown's JASSUB library to parse and render ASS/SSA subtitle files
 * using libass compiled to WebAssembly.
 *
 * This wrapper implements the exact same API signature as ASSRenderer.js
 * to allow seamless hot-swapping between rendering backends.
 *
 * Supports two playback configurations:
 *   1. HTML5 Video: Hooks into HTMLVideoElement events for auto-sync.
 *   2. Tizen AVPlay: Driven manually via explicit tick() invocations.
 * ============================================================================
 */

import JASSUB from 'jassub';
import FontLoader from '../../utils/FontLoader.js';
import { logger } from '../../utils/Logger.js';
// Fetch player setting definitions to dynamically control subtitle preferences,
// including the toggle to allow online font fetching via external APIs.
import { PlayerSettings } from '../../utils/PlayerSettings.js';

const log = logger.create('JassubRenderer');

export default class JassubRenderer {
    /**
     * @param {Object} options
     * @param {HTMLElement} options.container - Container element that wraps the video
     * @param {HTMLVideoElement} [options.video] - The video element (for VideoClock sync)
     * @param {number} [options.width] - Video width (required if video not provided)
     * @param {number} [options.height] - Video height (required if video not provided)
     */
    constructor({ container, video, width, height }) {
        // Parent container where we append the canvas wrapper
        this._container = container;

        // Video element reference (null on Tizen AVPlay mode)
        this._videoElement = video || null;
        this._isVirtual = !video;

        // Video dimensions used for letterbox sizing calculations
        this._videoWidth = width || 1920;
        this._videoHeight = height || 1080;

        // Current styling settings
        this._fontFamily = null;
        this._fontClass = null;
        this._fontScale = 1.0;
        this._outlineThickness = null;
        this._shadowThickness = null;
        this._lineHeight = 0;
        this._letterSpacing = 0;
        this._bottomOffset = 0;

        // Jassub instance and DOM elements
        this._jassub = null;
        this._wrapper = null;
        this._canvas = null;

        // Tracks timing offset delay (seconds)
        this._delaySeconds = 0;
        this._lastTime = null;
        this._rawContent = null;

        // Binding resize listener
        this._onWindowResize = () => this._resizeRenderer();

        log.info('JassubRenderer initialized' +
            (this._isVirtual ? ' (AVPlay/Manual mode)' : ' (HTML5/Auto mode)'));
    }

    // ========================================================================
    // Public API (Matches ASSRenderer)
    // ========================================================================

    /**
     * Update the current playback time (only used for AVPlay/Manual mode).
     * In HTML5 mode, Jassub binds directly to the video element's events.
     * @param {number} timeSeconds - Current time in seconds
     */
    tick(timeSeconds) {
        this._lastTime = timeSeconds;
        if (this._isVirtual && this._jassub) {
            // Apply delay offset. Positive delay means subtitles display later
            const offsetTime = timeSeconds - this._delaySeconds;
            
            // Jassub manual render expects mediaTime in seconds
            this._jassub.manualRender({
                mediaTime: offsetTime,
                width: this._videoWidth,
                height: this._videoHeight
            });
        }
    }

    /**
     * Resize the subtitle canvas to match the video layout.
     * Handles letterbox calculations.
     */
    resize(width, height) {
        if (width) this._videoWidth = width;
        if (height) this._videoHeight = height;
        this._resizeRenderer();
    }

    /**
     * Load and render an ASS subtitle track.
     * @param {string} content - Raw ASS/SSA file content
     */
    async setTrack(content) {
        if (typeof content !== 'string') {
            log.error('setTrack received non-string content:', typeof content);
            throw new Error('Subtitle content must be a string');
        }

        this._rawContent = content;

        // Clear any existing renderer session
        this._teardownJassub();

        try {
            // Setup DOM nodes
            this._setupDOM();

            // Run the text pre-processor to apply our font/border styling overrides
            const processedContent = this._preProcessAssContent(
                content,
                this._fontFamily,
                this._fontScale,
                this._outlineThickness,
                this._shadowThickness
            );

            // Fetch container fonts loaded in this session
            const fonts = FontLoader.getContainerFontUrls();

            log.info(`Initializing JASSUB with ${fonts.length} container font(s)`);

            // ========================================================================
            // ABSOLUTE PATH RESOLUTION
            // ========================================================================
            // Web Workers evaluate relative paths (like 'js/jassub-worker.wasm')
            // relative to the worker script's URL (e.g. 'js/jassub-worker.js')
            // rather than the document's base URL. This results in 404 resource errors
            // (e.g. attempting to fetch 'js/js/jassub-worker.wasm').
            //
            // To resolve this mismatch, we dynamically translate all paths to
            // absolute URLs relative to the main application's current base location
            // (e.g. window.location.href) before passing them to the Jassub constructor.
            // ========================================================================
            const getAbsoluteUrl = (relPath) => new URL(relPath, window.location.href).href;

            // Resolve the default font family name from style overrides.
            // If none is selected or it is 'null', fall back to 'Roboto'.
            const activeDefaultFont = (this._fontFamily && this._fontFamily !== 'null') ? this._fontFamily : 'Roboto';

            // Initialize the JASSUB instance and assign to a local reference.
            // Storing this locally prevents concurrent setTrack executions from
            // referencing or modifying state values of incorrect instances.
            const jassub = new JASSUB({
                // Attach the video and canvas element bindings
                video: this._videoElement,
                canvas: this._canvas,
                subContent: processedContent,
                
                // Jassub expects a negative timeOffset for delay values
                timeOffset: -this._delaySeconds,
                fonts: fonts,

                // Configure the default font and available font resources.
                // Because we replaced './default.woff2' with the local Roboto font asset at
                // compile-time, we must declare the correct active font family name
                // so that libass successfully matches it. We map all static bundled fonts
                // so the worker can dynamically fetch them over HTTP when requested.
                defaultFont: activeDefaultFont,
                availableFonts: {
                    'roboto': getAbsoluteUrl('assets/fonts/Roboto.woff2'),
                    'liberation sans': getAbsoluteUrl('assets/fonts/Roboto.woff2'),
                    'courier prime': getAbsoluteUrl('assets/fonts/CourierPrime.woff2'),
                    'merriweather': getAbsoluteUrl('assets/fonts/Merriweather.woff2'),
                    'inconsolata': getAbsoluteUrl('assets/fonts/Inconsolata.woff2'),
                    'dancing script': getAbsoluteUrl('assets/fonts/DancingScript.woff2'),
                    'patrick hand': getAbsoluteUrl('assets/fonts/PatrickHand.woff2'),
                    'cinzel': getAbsoluteUrl('assets/fonts/Cinzel.woff2'),
                    'poppins': getAbsoluteUrl('assets/fonts/Poppins.woff2'),
                    'noto sans arabic': getAbsoluteUrl('assets/fonts/NotoSansArabic.woff2'),
                    'silkscreen': getAbsoluteUrl('assets/fonts/Silkscreen.woff2'),
                    'space grotesk': getAbsoluteUrl('assets/fonts/SpaceGrotesk.woff2'),
                    'retrotech': getAbsoluteUrl('assets/fonts/RETROTECH.woff2'),
                    'kitty': getAbsoluteUrl('assets/fonts/Kitty.woff2'),
                    'inter': getAbsoluteUrl('assets/fonts/Inter.woff2'),
                    'proxima nova': getAbsoluteUrl('assets/fonts/ProximaNova.woff2'),
                    'baloo bhaijaan 2': getAbsoluteUrl('assets/fonts/BalooBhaijaan2.woff2'),
                    'opendyslexic': getAbsoluteUrl('assets/fonts/OpenDyslexic.woff2'),
                    'atkinson hyperlegible': getAbsoluteUrl('assets/fonts/Atkinson-Hyperlegible.woff2')
                },

                // Fully qualified URLs resolved against the active origin
                workerUrl: getAbsoluteUrl('js/jassub-worker.js'),
                wasmUrl: getAbsoluteUrl('js/jassub-worker.wasm'),
                modernWasmUrl: getAbsoluteUrl('js/jassub-worker-modern.wasm'),

                // Configure font lookup behavior based on user setting.
                // When enabled, 'localandremote' permits JASSUB to request missing
                // fonts dynamically from Google Fonts API, ensuring rich styling fallbacks.
                // When disabled, 'local' blocks remote web requests, restricting queries
                // to local pre-loaded fonts to save CPU cycles and bandwidth.
                queryFonts: (PlayerSettings.get('subtitleAssOnlineFonts') !== false) ? 'localandremote' : 'local'
            });

            // Bind the active instance property
            this._jassub = jassub;

            // Wait for WASM initialization to complete on the local reference
            await jassub.ready;
            log.info('Jassub WebAssembly engine ready');

            // Guard against race conditions where a newer setTrack call has already
            // overwritten the active Jassub instance while we were awaiting ready.
            if (this._jassub !== jassub) {
                log.info('Discarding obsolete Jassub initialization pass');
                return;
            }

            // Force initial layout pass
            this._resizeRenderer();

            // Listen for window resizes
            window.addEventListener('resize', this._onWindowResize);

            // If we are in virtual mode, trigger an initial tick render
            if (this._isVirtual && this._lastTime !== null) {
                this.tick(this._lastTime);
            }
        } catch (err) {
            log.error('Failed to initialize Jassub engine:', err);
            this.destroy();
            throw err;
        }
    }

    /**
     * Set subtitle timing offset.
     * @param {number} seconds - Offset in seconds
     */
    setDelay(seconds) {
        this._delaySeconds = seconds || 0;
        if (this._jassub) {
            // Jassub expects negative offset for delays
            this._jassub.timeOffset = -this._delaySeconds;
        }
        log.debug(`Jassub delay set to ${seconds}s`);
    }

    /**
     * Configure styling overrides on the wrapper and parsed ASS styles.
     */
    async setFontStyles(className, fontFamily, fontScale = 1.0, outlineThickness = 0.8, shadowThickness = 0.5, lineHeight = 0, letterSpacing = 0, bottomOffset = 0) {
        log.info(`JassubRenderer.setFontStyles: family="${fontFamily}", scale=${fontScale}, outline=${outlineThickness}, shadow=${shadowThickness}`);

        const styleRequiresReparse =
            this._fontFamily !== fontFamily ||
            this._fontScale !== fontScale ||
            this._outlineThickness !== outlineThickness ||
            this._shadowThickness !== shadowThickness;

        this._fontClass = className;
        this._fontFamily = fontFamily;
        this._fontScale = fontScale;
        this._outlineThickness = outlineThickness;
        this._shadowThickness = shadowThickness;
        this._lineHeight = lineHeight;
        this._letterSpacing = letterSpacing;
        this._bottomOffset = bottomOffset;

        // Apply wrapper offsets if Jassub is active
        this._updateWrapperStyles();

        // If styling changes require re-injecting ASS data, re-preprocess the track
        if (this._rawContent && styleRequiresReparse) {
            log.info('Re-preprocessing ASS content for Jassub...');
            await this.setTrack(this._rawContent);
        }
    }

    /**
     * Show subtitles overlay.
     */
    show() {
        if (this._wrapper) {
            this._wrapper.style.display = '';
        }
    }

    /**
     * Hide subtitles overlay.
     */
    hide() {
        if (this._wrapper) {
            this._wrapper.style.display = 'none';
        }
    }

    /**
     * Soft reset for track switching.
     */
    clearTrack() {
        this._teardownJassub();
        this._rawContent = null;
        if (this._wrapper) {
            this._wrapper.style.display = 'none';
        }
    }

    /**
     * Clear active cues immediately on seek.
     */
    clear() {
        if (this._jassub && this._isVirtual) {
            log.info('Clearing Jassub canvas overlay on seek');
            // Force rendering at a negative timestamp to clear screen
            this._jassub.manualRender({
                mediaTime: -1,
                width: this._videoWidth,
                height: this._videoHeight
            });
        }
    }

    /**
     * Wipe all resources, terminate workers, and clean the DOM.
     */
    destroy() {
        window.removeEventListener('resize', this._onWindowResize);
        this._teardownJassub();
        this._removeDOM();
    }

    // ========================================================================
    // Private Helpers
    // ========================================================================

    /**
     * Initialize DOM structures for the canvas overlay
     * @private
     */
    _setupDOM() {
        // Create the parent wrapper container if it does not already exist
        if (!this._wrapper) {
            this._wrapper = document.createElement('div');
            this._wrapper.className = 'jassub-wrapper';
            this._wrapper.style.position = 'absolute';
            this._wrapper.style.top = '0';
            this._wrapper.style.left = '0';
            this._wrapper.style.width = '100%';
            this._wrapper.style.height = '100%';
            this._wrapper.style.pointerEvents = 'none';

            // Align overlay layering matching PGS Subtitles priority
            const isUltraLegacy = document.documentElement.getAttribute('data-layout-tier') === 'ultra-legacy';
            this._wrapper.style.zIndex = isUltraLegacy ? '50' : '1';

            this._container.appendChild(this._wrapper);
        }

        // Web Assembly / Offscreen Canvas requires a new element to be generated
        // when resetting the track session. Re-using the same canvas and calling
        // transferControlToOffscreen() twice throws an InvalidStateError.
        if (this._canvas) {
            this._canvas.remove();
        }

        // Generate a clean HTMLCanvasElement for the new rendering instance
        this._canvas = document.createElement('canvas');
        this._canvas.style.position = 'absolute';
        this._canvas.style.pointerEvents = 'none';

        // Bind the element within our OSD container hierarchy
        this._wrapper.appendChild(this._canvas);
    }

    /**
     * Clean DOM structures
     * @private
     */
    _removeDOM() {
        if (this._wrapper) {
            if (this._wrapper.parentNode) {
                this._wrapper.parentNode.removeChild(this._wrapper);
            }
            this._wrapper = null;
            this._canvas = null;
        }
    }

    /**
     * Safely dispose the current Jassub instance
     * @private
     */
    _teardownJassub() {
        if (this._jassub) {
            try {
                this._jassub.destroy();
            } catch (e) {
                log.warn('Error destroying Jassub instance:', e);
            }
            this._jassub = null;
        }
    }

    /**
     * Sizing calculations for letterbox canvas positioning
     * @private
     */
    _resizeRenderer() {
        if (!this._canvas || !this._wrapper) return;

        let videoWidth = this._videoWidth;
        let videoHeight = this._videoHeight;

        if (this._videoElement) {
            videoWidth = this._videoElement.videoWidth || this._videoWidth;
            videoHeight = this._videoElement.videoHeight || this._videoHeight;
        }

        if (!videoWidth || !videoHeight) {
            videoWidth = 1280;
            videoHeight = 720;
        }

        const containerWidth = this._container.offsetWidth || videoWidth;
        const containerHeight = this._container.offsetHeight || videoHeight;

        // Scale factor preservation (letterboxing math)
        const ratio = Math.min(
            containerWidth / videoWidth,
            containerHeight / videoHeight
        );

        const subsWidth = videoWidth * ratio;
        const subsHeight = videoHeight * ratio;
        const subsLeft = (containerWidth - subsWidth) / 2;
        const subsTop = (containerHeight - subsHeight) / 2;

        // Position the canvas exactly over the active video frame
        this._canvas.style.width = Math.round(subsWidth) + 'px';
        this._canvas.style.height = Math.round(subsHeight) + 'px';
        this._canvas.style.left = Math.round(subsLeft) + 'px';
        this._canvas.style.top = Math.round(subsTop) + 'px';

        // Notify the Jassub worker of the resize
        if (this._jassub) {
            this._jassub.resize();
        }
    }

    /**
     * Update margins, offsets, and scales on the wrapper element
     * @private
     */
    _updateWrapperStyles() {
        if (!this._wrapper) return;

        // Apply margins or position transformations if necessary
        // Jassub renders internally to canvas, but we can nudge our wrapper
        if (this._bottomOffset) {
            this._wrapper.style.transform = `translateY(${-this._bottomOffset}px)`;
        } else {
            this._wrapper.style.transform = '';
        }
    }

    /**
     * Preprocesses raw ASS text content to enforce styling parameters
     * @private
     */
    _preProcessAssContent(content, fontFamily, fontScale = 1.0, outlineThickness = 0.8, shadowThickness = 0.5) {
        if (!content) return content;

        log.debug('Pre-processing ASS content for Jassub...');

        const lines = content.split(/\r?\n/);

        // Capture numeric values for PlayRes checks
        const getPlayRes = (key) => {
            const line = lines.find(l => new RegExp(`^${key}\\s*:`, 'i').test(l.trim()));
            if (!line) return -1;
            return parseInt(line.split(':')[1], 10) || 0;
        };

        const resX = getPlayRes('PlayResX');
        const resY = getPlayRes('PlayResY');

        const safeResX = 384;
        const safeResY = 288;

        if (resX <= 0 || resY <= 0) {
            log.warn(`ASS script has invalid PlayRes (${resX}x${resY}) — patching to ${safeResX}x${safeResY}`);

            const scriptInfoIdx = lines.findIndex(l => /^\[Script Info\]/i.test(l.trim()));
            const insertAt = scriptInfoIdx !== -1 ? scriptInfoIdx + 1 : 0;

            const setPlayRes = (key, value) => {
                const idx = lines.findIndex(l => new RegExp(`^${key}\\s*:`, 'i').test(l.trim()));
                if (idx !== -1) {
                    lines[idx] = `${key}: ${value}`;
                } else {
                    lines.splice(insertAt, 0, `${key}: ${value}`);
                }
            };

            setPlayRes('PlayResX', safeResX);
            setPlayRes('PlayResY', safeResY);
        }

        let styleFormat = null;

        const processedLines = lines.map(line => {
            const trimmed = line.trim();

            if (trimmed.startsWith('Format:') && (trimmed.includes('Outline') || trimmed.includes('Fontname'))) {
                styleFormat = trimmed.substring(trimmed.indexOf(':') + 1).split(',').map(s => s.trim());
                return line;
            }

            if (trimmed.startsWith('Style:') && styleFormat) {
                const parts = line.substring(line.indexOf(':') + 1).split(',');
                const fontIdx = styleFormat.indexOf('Fontname');

                if (fontIdx !== -1 && fontFamily && fontFamily !== 'null') {
                    parts[fontIdx] = fontFamily;
                }

                // Inline Fontsize override (applying the fontScale directly to the font size field)
                const sizeIdx = styleFormat.indexOf('Fontsize');
                if (sizeIdx !== -1 && fontScale && fontScale !== 1.0) {
                    const originalSize = parseFloat(parts[sizeIdx]) || 16;
                    parts[sizeIdx] = String(originalSize * fontScale);
                }

                const outlineIdx = styleFormat.indexOf('Outline');
                if (outlineIdx !== -1 && outlineThickness !== null && outlineThickness !== undefined) {
                    parts[outlineIdx] = String(outlineThickness);
                }

                const shadowIdx = styleFormat.indexOf('Shadow');
                if (shadowIdx !== -1 && shadowThickness !== null && shadowThickness !== undefined) {
                    parts[shadowIdx] = String(shadowThickness);
                }

                return 'Style: ' + parts.join(',');
            }

            // Dialogue-level cleanup
            if (trimmed.startsWith('Dialogue:')) {
                return line.replace(/\\(fn|bord|shad|s?out|s?shad)[^\\})]+(?=[\\})])/g, '');
            }

            return line;
        });

        return processedLines.join('\n');
    }
}
