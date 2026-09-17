/**
 * ============================================================================
 * LibassWasmRenderer — High-Performance WASM Subtitle Renderer (SubtitlesOctopus)
 * ============================================================================
 * Wraps @jellyfin/libass-wasm to parse and render ASS/SSA subtitle files
 * using libass compiled to WebAssembly.
 *
 * Implements the exact same API signature as ASSRenderer to support seamless
 * swapping between rendering engines.
 *
 * Supports:
 *   1. HTML5 Video: Synchronizes directly with HTMLVideoElement events.
 *   2. Tizen AVPlay: Driven manually via tick() invocations.
 * ============================================================================
 */

import SubtitlesOctopus from '@jellyfin/libass-wasm';
import FontLoader from '../../utils/FontLoader.js';
import { logger } from '../../utils/Logger.js';
import { PlayerSettings } from '../../utils/PlayerSettings.js';
import SubtitleStyles from '../../utils/SubtitleStyles.js';
import { platformInfo } from '../../utils/PlatformInfo.js';

const log = logger.create('LibassWasmRenderer');

const getAbsoluteUrl = (relPath) => new URL(relPath, window.location.href).href;

let _availableFonts = null;
function getAvailableFonts() {
    if (_availableFonts) return _availableFonts;
    const defaultFontUrl = getAbsoluteUrl('assets/fonts/Roboto.woff2');
    _availableFonts = {
        'roboto': defaultFontUrl,
        'liberation sans': defaultFontUrl,
        'arial': defaultFontUrl,
        'arial unicode ms': defaultFontUrl,
        'sans-serif': defaultFontUrl,
        'tahoma': defaultFontUrl,
        'verdana': defaultFontUrl,
        'segoe ui': defaultFontUrl,
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
    };
    return _availableFonts;
}

export default class LibassWasmRenderer {
    /**
     * =========================================================================
     * WebAssembly Support Verification
     * =========================================================================
     * Runtime capability check for WebAssembly execution.
     * Evaluates whether the underlying platform runtime has full WebAssembly
     * execution support (present by default on Chromium 57+).
     *
     * Delegates to centralized platformInfo.hasWasmSupport detection.
     *
     * @returns {boolean} True if WebAssembly execution is supported.
     */
    static isSupported() {
        return platformInfo.hasWasmSupport;
    }

    /**
     * @param {Object} options
     * @param {HTMLElement} options.container - Container element that wraps the video
     * @param {HTMLVideoElement} [options.video] - The video element (for VideoClock sync)
     * @param {number} [options.width] - Video width (required if video not provided)
     * @param {number} [options.height] - Video height (required if video not provided)
     * @param {number} [options.videoFrameRate] - Video framerate (for render sync)
     */
    constructor({ container, video, width, height, videoFrameRate, getTime, avplayLatency }) {
        // Assert WebAssembly capability prior to performing hardware or DOM setup
        if (!LibassWasmRenderer.isSupported()) {
            throw new Error('LibassWasmRenderer is not supported on this platform (WebAssembly unavailable)');
        }

        this._container = container;
        this._videoElement = video || null;
        this._isVirtual = !video;
        this._videoWidth = width || 1920;
        this._videoHeight = height || 1080;
        this._videoFrameRate = videoFrameRate || 24;
        this._getTime = typeof getTime === 'function' ? getTime : null;
        // AVPlay's getCurrentTime() leads the actual displayed frame by
        // the hardware decode pipeline depth (~1-2 frames). Default 0.06s
        // (60ms ~1.5 frames at 24fps) for AVPlay mode; override via
        // constructor if tuning for a different device.
        this._avplayLatency = typeof avplayLatency === 'number'
            ? Math.max(0, avplayLatency)
            : (this._isVirtual ? 0.06 : 0);

        this._fontFamily = null;
        this._fontClass = null;
        this._fontScale = 1.0;
        this._outlineThickness = null;
        this._shadowThickness = null;
        this._lineHeight = 0;
        this._letterSpacing = 0;
        this._bottomOffset = 0;

        // Whether to apply style modifications (font/outline/shadow overrides,
        // dialogue stripping, Fontsize scaling, bottom offset). Default off.
        this._enableStyleMods = false;
        this._prevEnableStyleMods = false;

        this._octopus = null;
        this._wrapper = null;
        this._canvas = null;
        this._delaySeconds = 0;
        this._lastTime = null;
        this._rawContent = null;
        this._lastProcessedHash = null;
        this._lastProcessedResult = null;

        this._seekPending = false;
        /* throttle: skip setCurrentTime if time moved < 20ms */
        this._MIN_TICK_DELTA = 0.020;

        this._onWindowResize = () => this._resizeRenderer();

        log.info('LibassWasmRenderer initialized' +
            (this._isVirtual ? ' (AVPlay/Manual mode)' : ' (HTML5/Auto mode)'));
    }

    /**
     * Configure whether ASS style modifications are enabled.
     *
     * @param {Object} config
     * @param {boolean} [config.enableModifications=false] - Apply style overrides,
     *        dialogue stripping, Fontsize scaling, and bottom offset.
     */
    setStyleConfig({ enableModifications } = {}) {
        this._enableStyleMods = enableModifications === true;
        log.debug(`LibassWasmRenderer style config: modifications=${this._enableStyleMods}`);
    }

    /**
     * Get the current playback time from the platform's native time source.
     * Priority: injected callback > AVPlay direct.
     *
     * AVPlay's getCurrentTime() reflects the hardware decode pipeline position,
     * which leads the actual displayed frame by ~1-2 frames. We subtract the
     * configured pipeline latency (default 60ms) so subtitles align with the
     * on-screen image, clamping to 0 to prevent negative timestamps.
     *
     * @returns {number} Current time in seconds, or -1 if unavailable.
     * @private
     */
    _getPlatformTime() {
        // Evaluate injected time callback first if available
        if (typeof this._getTime === 'function') {
            const injectedTime = this._getTime();
            return typeof injectedTime === 'number' && !isNaN(injectedTime)
                ? Math.max(0, injectedTime)
                : -1;
        }

        // Query native Tizen AVPlay API directly as fallback
        try {
            const avplay = window.webapis?.avplay || window.tizen?.avplay;
            if (avplay && typeof avplay.getCurrentTime === 'function') {
                const timeMs = Number(avplay.getCurrentTime());
                if (!isNaN(timeMs) && timeMs >= 0) {
                    // Compensate for hardware decode pipeline depth and prevent negative results
                    return Math.max(0, (timeMs / 1000) - this._avplayLatency);
                }
            }
        } catch (e) {
            // AVPlay API query trapped; return unavailable sentinel
        }
        return -1;
    }

    /**
     * Drive subtitle rendering for the current timeline position.
     * Invoked by SubtitleManager on each playback clock/timeupdate event.
     *
     * @param {number} timeSeconds - Current media playback time in seconds
     */
    tick(timeSeconds) {
        this._lastTime = timeSeconds;

        // Manual ticking only applies to virtual canvas mode (Tizen AVPlay)
        if (this._isVirtual && this._octopus) {
            // ================================================================
            // Tizen 5.5 / Broken-WASM Safety Guard:
            // SubtitlesOctopus's internal workerError handler calls dispose()
            // which sets self.worker = null. If the worker crashed or was
            // terminated while we still retain the instance reference, calling
            // setCurrentTime() will throw "Cannot read property 'postMessage' of null".
            // Detect this state early and null out our reference cleanly.
            // ================================================================
            if (this._octopus.worker === null) {
                log.warn('SubtitlesOctopus worker appears terminated (worker=null); clearing stale reference');
                this._octopus = null;
                return;
            }

            // Apply subtitle delay offset and clamp to 0 (libass rejects negative timestamps)
            const offsetTime = Math.max(0, timeSeconds - this._delaySeconds);

            // Clear any pending seek flag on active tick
            if (this._seekPending) {
                this._seekPending = false;
            }

            // ================================================================
            // Deduplication Throttle Gate:
            // Skip sending worker messages if playback time moved less than 20ms
            // since the last render request. Eliminates redundant CPU/WASM paints
            // when AVPlay dispatches rapid or bursty timeupdate events.
            // ================================================================
            if (this._lastSetTime !== undefined &&
                Math.abs(offsetTime - this._lastSetTime) < this._MIN_TICK_DELTA) {
                return;
            }
            this._lastSetTime = offsetTime;

            // Dispatch render timestamp directly to libass Web Worker
            this._octopus.setCurrentTime(offsetTime);
        }
    }

    /**
     * Resume subtitle rendering when playback begins or unpauses.
     * Signals the SubtitlesOctopus WebAssembly worker to resume frame generation.
     */
    play() {
        if (this._octopus && typeof this._octopus.setIsPaused === 'function') {
            // Resolve the current media time to synchronize the worker's internal clock
            const platformTime = this._getPlatformTime();
            const rawTime = platformTime >= 0 ? platformTime : (this._lastTime || 0);
            const syncTime = Math.max(0, rawTime - this._delaySeconds);

            // Signal worker that media playback has resumed
            this._octopus.setIsPaused(false, syncTime);
        }
    }

    /**
     * Pause subtitle rendering when video playback pauses.
     * Stops background rendering cycles inside the worker to conserve TV CPU cycles.
     */
    pause() {
        if (this._octopus && typeof this._octopus.setIsPaused === 'function') {
            // Resolve the current media time for pause alignment
            const platformTime = this._getPlatformTime();
            const rawTime = platformTime >= 0 ? platformTime : (this._lastTime || 0);
            const syncTime = Math.max(0, rawTime - this._delaySeconds);

            // Signal worker that media playback is paused
            this._octopus.setIsPaused(true, syncTime);
        }
    }

    resize(width, height) {
        if (width) this._videoWidth = width;
        if (height) this._videoHeight = height;
        this._resizeRenderer();
    }

    async setTrack(content) {
        if (typeof content !== 'string') {
            log.error('setTrack received non-string content:', typeof content);
            throw new Error('Subtitle content must be a string');
        }

        this._rawContent = content;
        this._teardownOctopus();

        try {
            this._setupDOM();

            // Cache preprocessed content — skip reprocessing if content unchanged
            const contentHash = content.length + '|' + (this._fontFamily || '') + '|' + this._fontScale;
            if (this._lastProcessedHash !== contentHash) {
                this._lastProcessedResult = this._preProcessAssContent(
                    content,
                    this._fontFamily,
                    this._fontScale,
                    this._outlineThickness,
                    this._shadowThickness
                );
                this._lastProcessedHash = contentHash;
            }
            const processedContent = this._lastProcessedResult;

            const availableFonts = getAvailableFonts();
            const fallbackUrl = FontLoader.getFallbackFontUrl();
            if (fallbackUrl) {
                availableFonts['jellyfin fallback font'] = fallbackUrl;
            }

            const overrideFontFamily = SubtitleStyles.getFontFamily('subtitleFontAss');
            const targetFontFamily = (this._fontFamily && this._fontFamily !== 'null')
                ? this._fontFamily
                : (overrideFontFamily || 'Roboto');

            const fallbackFontUrl = availableFonts[targetFontFamily.toLowerCase()] || getAbsoluteUrl('assets/fonts/default.woff2');

            // ================================================================
            // Collect container-embedded fonts to pass to the SubtitlesOctopus worker.
            //
            // IMPORTANT: We use getContainerFontServerUrls() (HTTP URLs) rather than
            // getContainerFontUrls() (blob: URLs). The worker fetches these files via
            // XMLHttpRequest from inside the Web Worker thread. On Tizen 5.5 (Chrome 69),
            // blob: URLs created in the main thread are NOT accessible from a Worker XHR
            // — this was the cause of the "Worker error: {isTrusted:true}" crash.
            // HTTP URLs (pointing to the Jellyfin server's font delivery endpoint) work
            // correctly on all platforms including Tizen 5.5.
            // ================================================================
            const fonts = FontLoader.getContainerFontServerUrls();
            // Only add fallbackUrl to fonts if it is not already being used as the primary fallbackFont
            if (fallbackUrl && fallbackUrl !== fallbackFontUrl) {
                fonts.push(fallbackUrl);
            }
            log.info(`Initializing SubtitlesOctopus with ${fonts.length} server font URL(s) (container fonts: ${fonts.length - (fallbackUrl && fallbackUrl !== fallbackFontUrl ? 1 : 0)})`);


            const dropAnimations = PlayerSettings.get('subtitleAssDropAnimations') === true;
            const prescaleFactor = parseFloat(PlayerSettings.get('subtitleAssPrescaleFactor')) || 0.8;
            const maxHeight = Math.min(2160, typeof screen !== 'undefined' ? (screen.height || 1080) : 1080);

            // ================================================================
            // onError callback: fired by SubtitlesOctopus's workerError handler
            // when the web worker crashes internally (e.g. WASM init failure on
            // Tizen 5.5). At that point octopus already calls dispose() which
            // sets self.worker = null — but our _octopus reference stays alive.
            // Hooking onError lets us proactively null it out so that the very
            // next tick() call doesn't crash on worker.postMessage().
            // ================================================================
            const onOctopusError = (err) => {
                log.error('SubtitlesOctopus worker error — renderer disabled for this track:', err);
                // Null out our reference cleanly so subsequent ticks do not invoke dead worker
                this._octopus = null;
            };

            // Callback fired once the SubtitlesOctopus worker thread is compiled and initialized
            const onOctopusReady = () => {
                log.info('SubtitlesOctopus WebAssembly worker is active and ready');
                // Immediately paint current position on ready without waiting for next tick interval
                if (this._isVirtual) {
                    const currentTime = this._lastTime !== null ? this._lastTime : this._getPlatformTime();
                    if (currentTime >= 0) {
                        this.tick(currentTime);
                    }
                }
            };

            // Build SubtitlesOctopus initialization config matching official Jellyfin Smart-TV
            const options = {
                // In virtual mode (Tizen AVPlay), omit video element so SubtitlesOctopus operates in pure canvas mode
                video: this._isVirtual ? undefined : this._videoElement,
                // In virtual mode, pass our pre-sized overlay canvas directly
                canvas: this._isVirtual ? this._canvas : undefined,
                subContent: processedContent,
                // Time offset is handled manually in tick() for virtual canvas mode
                timeOffset: this._isVirtual ? 0 : -this._delaySeconds,
                fonts: fonts,
                workerUrl: getAbsoluteUrl('js/subtitles-octopus-worker.js'),
                legacyWorkerUrl: getAbsoluteUrl('js/subtitles-octopus-worker-legacy.js'),
                fallbackFont: fallbackFontUrl,
                availableFonts: availableFonts,
                renderMode: 'wasm-blend',
                dropAllAnimations: dropAnimations,
                libassMemoryLimit: 40,
                libassGlyphLimit: 40,
                targetFps: this._videoFrameRate,
                prescaleFactor: prescaleFactor,
                prescaleHeightLimit: 1080,
                maxRenderHeight: maxHeight,
                resizeVariation: 0.2,
                // renderAhead=0 disables the prerender RAF loop; frames are rendered on-demand via tick()
                renderAhead: 0,
                onReady: onOctopusReady,
                onError: onOctopusError
            };

            // Instantiate SubtitlesOctopus instance
            this._octopus = new SubtitlesOctopus(options);

            // Configure z-index and event pass-through if canvasParent was created (HTML5 video mode)
            if (!this._isVirtual && this._octopus.canvasParent) {
                const isUltraLegacy = document.documentElement.getAttribute('data-layout-tier') === 'ultra-legacy';
                this._octopus.canvasParent.style.zIndex = isUltraLegacy ? '50' : '30';
                this._octopus.canvasParent.style.pointerEvents = 'none';
            }

            this._updateWrapperStyles();

            if (this._isVirtual) {
                // Ensure canvas resolution and layout matches viewport
                this._resizeRenderer();
                window.addEventListener('resize', this._onWindowResize);
            }

            // Immediately schedule initial subtitle paint if timestamp is known
            if (this._isVirtual && this._lastTime !== null) {
                this.tick(this._lastTime);
            }
        } catch (err) {
            log.error('Failed to initialize SubtitlesOctopus engine:', err);
            this.destroy();
            throw err;
        }
    }

    /**
     * Set playback subtitle delay offset in seconds.
     * Positive delay shifts subtitles to display later in time.
     *
     * @param {number} seconds - Delay offset in seconds
     */
    setDelay(seconds) {
        this._delaySeconds = seconds || 0;
        // In HTML5 mode, Octopus handles timeOffset internally
        if (this._octopus && !this._isVirtual) {
            this._octopus.timeOffset = -this._delaySeconds;
        }
        // Invalidate tick deduplication cache so the next tick renders with updated delay
        this._lastSetTime = undefined;
        log.debug(`SubtitlesOctopus delay set to ${seconds}s`);
    }

    async setFontStyles(className, fontFamily, fontScale = 1.0, outlineThickness = 0.8, shadowThickness = 0.5, lineHeight = 0, letterSpacing = 0, bottomOffset = 0) {
        log.info(`LibassWasmRenderer.setFontStyles: family="${fontFamily}", scale=${fontScale}, outline=${outlineThickness}, shadow=${shadowThickness}, enableMods=${this._enableStyleMods}`);

        const modsToggled = this._enableStyleMods !== this._prevEnableStyleMods;
        this._prevEnableStyleMods = this._enableStyleMods;

        if (this._enableStyleMods) {
            const styleRequiresReparse =
                this._fontFamily !== fontFamily ||
                this._fontScale !== fontScale ||
                this._outlineThickness !== outlineThickness ||
                this._shadowThickness !== shadowThickness ||
                modsToggled;

            this._fontClass = className;
            this._fontFamily = fontFamily;
            this._fontScale = fontScale;
            this._outlineThickness = outlineThickness;
            this._shadowThickness = shadowThickness;
            this._lineHeight = lineHeight;
            this._letterSpacing = letterSpacing;
            this._bottomOffset = bottomOffset;

            this._updateWrapperStyles();

            if (this._rawContent && styleRequiresReparse) {
                // Invalidate hash so setTrack re-processes the content
                this._lastProcessedHash = null;
                log.info('Re-preprocessing ASS content for SubtitlesOctopus...');
                await this.setTrack(this._rawContent);
            }
        } else {
            this._updateWrapperStyles();

            // If mods were just turned off, re-process from original (unmodified)
            // content so SubtitlesOctopus renders with original embedded styles.
            if (modsToggled && this._rawContent) {
                this._lastProcessedHash = null;
                log.info('Style modifications disabled — re-processing ASS with original content');
                await this.setTrack(this._rawContent);
            }
        }
    }

    show() {
        if (this._wrapper) {
            this._wrapper.style.display = '';
        } else if (this._octopus && this._octopus.canvasParent) {
            this._octopus.canvasParent.style.display = '';
        }
    }

    hide() {
        if (this._wrapper) {
            this._wrapper.style.display = 'none';
        } else if (this._octopus && this._octopus.canvasParent) {
            this._octopus.canvasParent.style.display = 'none';
        }
    }

    clearTrack() {
        this._teardownOctopus();
        this._rawContent = null;
        this._lastProcessedHash = null;
        this._lastProcessedResult = null;
        if (this._wrapper) {
            this._wrapper.style.display = 'none';
        }
    }

    /**
     * Clear subtitle display from the canvas overlay immediately.
     * Invoked during seek operations or when stopping playback.
     */
    clear() {
        if (!this._isVirtual) return;

        // Wipe 2D canvas bitmap buffer so the user immediately sees a clean screen
        if (this._canvas) {
            const ctx = this._canvas.getContext('2d');
            if (ctx) {
                ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
            }
        }

        // Invalidate tick deduplication cache so the post-seek tick renders immediately
        this._lastSetTime = undefined;

        log.info('SubtitlesOctopus canvas cleared');
    }

    destroy() {
        window.removeEventListener('resize', this._onWindowResize);
        this._teardownOctopus();
        this._removeDOM();
    }

    /**
     * Set up DOM container wrapper and canvas element for virtual rendering mode.
     * Creates a full-screen hardware-accelerated canvas overlay above the video plane.
     * @private
     */
    _setupDOM() {
        if (this._isVirtual) {
            if (!this._wrapper) {
                log.info('Creating manual layout wrapper div for virtual rendering mode');
                this._wrapper = document.createElement('div');
                this._wrapper.className = 'libass-wasm-wrapper';
                this._wrapper.style.position = 'absolute';
                this._wrapper.style.top = '0';
                this._wrapper.style.left = '0';
                this._wrapper.style.width = '100%';
                this._wrapper.style.height = '100%';
                this._wrapper.style.pointerEvents = 'none';

                // Ensure subtitle overlay sits above the AVPlay video plane and below OSD (50-100)
                const isUltraLegacy = document.documentElement.getAttribute('data-layout-tier') === 'ultra-legacy';
                this._wrapper.style.zIndex = isUltraLegacy ? '50' : '30';

                this._container.appendChild(this._wrapper);
            }

            // Restore display in case clearTrack() previously hid the wrapper
            this._wrapper.style.display = '';

            if (this._canvas) {
                log.info('Removing stale virtual canvas element before recreation');
                this._canvas.remove();
            }

            // Obtain target dimensions from container or viewport fallback upfront
            const initialWidth = this._container.offsetWidth || window.innerWidth || this._videoWidth || 1920;
            const initialHeight = this._container.offsetHeight || window.innerHeight || this._videoHeight || 1080;

            this._canvas = document.createElement('canvas');
            this._canvas.className = 'libass-wasm-canvas';
            // Explicitly set internal bitmap drawing dimensions before SubtitlesOctopus constructor reads them
            this._canvas.width = initialWidth;
            this._canvas.height = initialHeight;
            // Layout styling: full coverage overlay
            this._canvas.style.position = 'absolute';
            this._canvas.style.top = '0';
            this._canvas.style.left = '0';
            this._canvas.style.width = '100%';
            this._canvas.style.height = '100%';
            this._canvas.style.pointerEvents = 'none';

            this._wrapper.appendChild(this._canvas);
        }
    }

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
     * Terminate the SubtitlesOctopus Web Worker and release its memory.
     * @private
     */
    _teardownOctopus() {
        if (this._octopus) {
            try {
                // If the worker already self-disposed (e.g. internal workerError
                // sets worker=null internally), skip dispose() to prevent an unhandled exception
                if (this._octopus.worker !== null) {
                    this._octopus.dispose();
                }
            } catch (err) {
                log.warn('Error disposing SubtitlesOctopus instance:', err);
            }
            this._octopus = null;
        }
        // Invalidate tick deduplication cache so the next track begins cleanly
        this._lastSetTime = undefined;
    }

    /**
     * Synchronize canvas bitmap drawing buffer and notify SubtitlesOctopus
     * worker of viewport or container resolution changes.
     * @private
     */
    _resizeRenderer() {
        if (!this._canvas || !this._wrapper) return;

        // Obtain target render dimensions from container or viewport
        const containerWidth = this._container.offsetWidth || window.innerWidth || this._videoWidth || 1920;
        const containerHeight = this._container.offsetHeight || window.innerHeight || this._videoHeight || 1080;

        // Keep bitmap buffer resolution synchronized
        this._canvas.width = containerWidth;
        this._canvas.height = containerHeight;
        this._canvas.style.position = 'absolute';
        this._canvas.style.top = '0';
        this._canvas.style.left = '0';
        this._canvas.style.width = '100%';
        this._canvas.style.height = '100%';

        // Notify SubtitlesOctopus worker of updated render target dimensions
        if (this._octopus) {
            log.info(`Resizing virtual worker canvas to ${containerWidth}x${containerHeight}`);
            this._octopus.resize(containerWidth, containerHeight);
        }
    }

    _updateWrapperStyles() {
        const target = this._wrapper || (this._octopus && this._octopus.canvasParent);
        if (!target) return;

        if (this._enableStyleMods && this._bottomOffset) {
            log.debug(`Applying translateY offset translation: ${-this._bottomOffset}px`);
            target.style.transform = `translateY(${-this._bottomOffset}px)`;
        } else {
            target.style.transform = '';
        }
    }

    _preProcessAssContent(content, fontFamily, fontScale = 1.0, outlineThickness = 0.8, shadowThickness = 0.5) {
        if (!content) return content;

        log.debug(`Pre-processing ASS content for SubtitlesOctopus... enableStyleMods=${this._enableStyleMods}`);

        const lines = content.split(/\r?\n/);

        // libass-wasm handles missing PlayRes natively — skip injection.
        // Just warn so developers know the file is non-compliant.
        const getPlayRes = (key) => {
            const line = lines.find(l => new RegExp(`^${key}\\s*:`, 'i').test(l.trim()));
            if (!line) return -1;
            return parseInt(line.split(':')[1], 10) || 0;
        };

        let resX = getPlayRes('PlayResX');
        let resY = getPlayRes('PlayResY');

        // ====================================================================
        // Patch missing or invalid PlayResX / PlayResY in [Script Info]
        //
        // When PlayResX or PlayResY is omitted or set to 0, libass defaults
        // PlayResY to 288 and PlayResX to 384. If PlayResX was specified (e.g. 1920)
        // without PlayResY, or if the header was omitted entirely, libass's
        // internal coordinate calculations can produce distorted scaling.
        // We inject safe standard defaults (384x288) if absent.
        // ====================================================================
        const safeResX = 384;
        const safeResY = 288;

        if (resX <= 0 || resY <= 0) {
            log.warn(`ASS script has invalid PlayRes (${resX}x${resY}) — patching Script Info to ${safeResX}x${safeResY}`);

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

            if (resX <= 0) {
                setPlayRes('PlayResX', safeResX);
                resX = safeResX;
            }
            if (resY <= 0) {
                setPlayRes('PlayResY', safeResY);
                resY = safeResY;
            }
        }

        const isFfmpegScript = /Script generated by FFmpeg|Lavc|libass/i.test(content);
        const shouldModifyStyles = this._enableStyleMods || isFfmpegScript || (fontScale && fontScale !== 1.0);

        if (!shouldModifyStyles) {
            // Style modifications disabled & not an FFmpeg script: return content with PlayRes patched
            return lines.join('\n');
        }

        const effectivePlayResY = resY > 0 ? resY : safeResY;
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

                if (this._enableStyleMods && fontIdx !== -1 && fontFamily && fontFamily !== 'null') {
                    parts[fontIdx] = fontFamily;
                }

                const sizeIdx = styleFormat.indexOf('Fontsize');
                if (sizeIdx !== -1) {
                    let size = parseFloat(parts[sizeIdx]) || 16;
                    const appliedScale = (fontScale && fontScale !== 1.0) ? fontScale : 1.0;
                    size *= appliedScale;

                    // ================================================================
                    // PlayRes Fontsize Normalization for Undersized Subtitles
                    // ----------------------------------------------------------------
                    // Standard TV dialogue subtitles should be ~7.5% of PlayResY
                    // (~81px on 1080p, ~54px on 720p, ~22px on 288p).
                    // FFmpeg and auto-converters generate ASS scripts with PlayResY: 288
                    // and Fontsize: 16 (only 5.5% height), or PlayResY: 1080 and Fontsize: 20
                    // (< 2% height), making subtitles look miniscule on screen.
                    // If the font size ratio is undersized (< 7.0% of PlayResY),
                    // auto-scale it up to a comfortable ~7.5% baseline ratio.
                    // ================================================================
                    const minRatio = 0.075;
                    const sizeRatio = size / (effectivePlayResY * appliedScale);

                    if (sizeRatio < 0.070) {
                        const normalizedSize = Math.round(effectivePlayResY * minRatio * appliedScale);
                        log.info(`Normalizing undersized ASS Fontsize (${parts[sizeIdx]}px on PlayResY ${effectivePlayResY}, isFfmpeg=${isFfmpegScript}) -> ${normalizedSize}px`);
                        size = normalizedSize;
                    }

                    parts[sizeIdx] = String(size);
                }

                if (this._enableStyleMods) {
                    const outlineIdx = styleFormat.indexOf('Outline');
                    if (outlineIdx !== -1 && outlineThickness !== null && outlineThickness !== undefined) {
                        parts[outlineIdx] = String(outlineThickness);
                    }

                    const shadowIdx = styleFormat.indexOf('Shadow');
                    if (shadowIdx !== -1 && shadowThickness !== null && shadowThickness !== undefined) {
                        parts[shadowIdx] = String(shadowThickness);
                    }
                }

                return 'Style: ' + parts.join(',');
            }

            if (this._enableStyleMods && trimmed.startsWith('Dialogue:')) {
                return line.replace(/\\(fn|bord|shad|s?out|s?shad)[^\\})]+(?=[\\})])/g, '');
            }

            return line;
        });

        return processedLines.join('\n');
    }
}
