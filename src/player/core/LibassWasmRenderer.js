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
     * @param {Object} options
     * @param {HTMLElement} options.container - Container element that wraps the video
     * @param {HTMLVideoElement} [options.video] - The video element (for VideoClock sync)
     * @param {number} [options.width] - Video width (required if video not provided)
     * @param {number} [options.height] - Video height (required if video not provided)
     * @param {number} [options.videoFrameRate] - Video framerate (for render sync)
     */
    constructor({ container, video, width, height, videoFrameRate, getTime, avplayLatency }) {
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
        this._lastProcessedHash = null;
        this._lastProcessedResult = null;

        this._seekPending = false;
        /* throttle: skip setCurrentTime if time moved < 20ms */
        this._MIN_TICK_DELTA = 0.020;

        this._videoProxy = {
            currentTime: 0,
            paused: false,
            playbackRate: 1.0
        };

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
     * @returns {number} Current time in seconds, or -1 if unavailable.
     * @private
     */
    _getPlatformTime() {
        if (typeof this._getTime === 'function') {
            return this._getTime();
        }
        try {
            const avplay = window.webapis?.avplay || window.tizen?.avplay;
            if (avplay && typeof avplay.getCurrentTime === 'function') {
                const timeMs = Number(avplay.getCurrentTime());
                if (!isNaN(timeMs) && timeMs >= 0) {
                    // AVPlay's getCurrentTime() reflects the decode pipeline
                    // position, which is slightly ahead of the actual displayed
                    // frame. Subtract the configured pipeline latency so
                    // subtitles align with what's on screen.
                    return (timeMs / 1000) - this._avplayLatency;
                }
            }
        } catch (e) {}
        return -1;
    }

    /**
     * Replace the static proxy with a getter-based one so Octopus's internal
     * oneshotRender() rAF loop reads the real AVPlay time on every frame.
     *
     * This eliminates the need for a separate rAF loop — no duplicate frame
     * work, no interpolation drift, and the time is always frame-accurate.
     * @private
     */
    _setupVirtualProxy() {
        const self = this;
        const oldCurrentTime = this._videoProxy.currentTime;
        Object.defineProperty(this._videoProxy, 'currentTime', {
            get() {
                const t = self._getPlatformTime();
                return t >= 0 ? t : oldCurrentTime;
            },
            configurable: true
        });
    }

    tick(timeSeconds) {
        this._lastTime = timeSeconds;
        if (this._isVirtual && this._octopus) {
            const offsetTime = timeSeconds - this._delaySeconds;

            if (this._seekPending) {
                this._seekPending = false;
            }

            // Gate: skip if the player tick time is close to the real AVPlay
            // time already seen by Octopus's internal rAF loop. This avoids
            // redundant setCurrentTime calls (the getter returns raw AVPlay
            // time; delay is applied separately via offsetTime).
            if (Math.abs(timeSeconds - this._videoProxy.currentTime) < this._MIN_TICK_DELTA) {
                return;
            }

            this._octopus.setCurrentTime(offsetTime);
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

            const fonts = FontLoader.getContainerFontUrls();
            // Only add fallbackUrl to fonts if it is not already being used as the primary fallbackFont
            if (fallbackUrl && fallbackUrl !== fallbackFontUrl) {
                fonts.push(fallbackUrl);
            }
            log.info(`Initializing SubtitlesOctopus with ${fonts.length} font(s)`);

            const dropAnimations = PlayerSettings.get('subtitleAssDropAnimations') === true;
            const prescaleFactor = parseFloat(PlayerSettings.get('subtitleAssPrescaleFactor')) || 0.8;
            const maxHeight = Math.min(2160, typeof screen !== 'undefined' ? (screen.height || 1080) : 1080);

            const options = {
                video: this._videoElement,
                canvas: this._isVirtual ? this._canvas : undefined,
                subContent: processedContent,
                timeOffset: -this._delaySeconds,
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
                renderAhead: this._isVirtual ? 100 : 90
            };

            this._octopus = new SubtitlesOctopus(options);

            if (this._isVirtual) {
                this._setupVirtualProxy();
                this._octopus.video = this._videoProxy;
                log.info('Injected virtual video proxy into SubtitlesOctopus (AVPlay mode)');

                // Start the oneshotRender rAF loop. Octopus only starts this
                // loop inside resetRenderAheadCache(), which is called from
                // setTrack()/setTrackByUrl(). Since we pass subContent in
                // options instead of calling setTrack(), the loop never starts
                // automatically — leaving subtitles jerky (~250ms updates from
                // tick() only). This gives us 60fps per-frame time reads via
                // the virtual proxy getter.
                this._octopus.resetRenderAheadCache(false);
            }

            if (!this._isVirtual && this._octopus.canvasParent) {
                const isUltraLegacy = document.documentElement.getAttribute('data-layout-tier') === 'ultra-legacy';
                this._octopus.canvasParent.style.zIndex = isUltraLegacy ? '50' : '1';
                this._octopus.canvasParent.style.pointerEvents = 'none';
            }

            this._updateWrapperStyles();

            if (this._isVirtual) {
                this._resizeRenderer();
                window.addEventListener('resize', this._onWindowResize);
            }

            if (this._isVirtual && this._lastTime !== null) {
                this.tick(this._lastTime);
            }
        } catch (err) {
            log.error('Failed to initialize SubtitlesOctopus engine:', err);
            this.destroy();
            throw err;
        }
    }

    setDelay(seconds) {
        this._delaySeconds = seconds || 0;
        if (this._octopus) {
            this._octopus.timeOffset = -this._delaySeconds;
        }
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

    clear() {
        if (!this._isVirtual) return;
        // Immediately wipe the canvas so the user sees a blank frame
        if (this._canvas) {
            const ctx = this._canvas.getContext('2d');
            if (ctx) ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
        }
        // Flag the next tick() to reset the worker state cleanly instead of
        // calling setCurrentTime(-1) which floods the worker and causes freezes.
        this._seekPending = true;

        // Break Octopus prerender deadlock: reset the render request flag and
        // increment the iteration so stale in-flight worker responses are ignored.
        // Without this, oneshotState.renderRequested stays true after seek and
        // blocks all future prerender requests — subtitles never reappear.
        if (this._octopus && this._octopus.oneshotState) {
            this._octopus.oneshotState.renderRequested = false;
            this._octopus.oneshotState.iteration++;
            this._octopus.oneshotState.requestNextTimestamp = -1;
            this._octopus.oneshotState.displayedEvent = null;
            this._octopus.oneshotState.restart = true;
            this._octopus.renderedItems = [];
            this._octopus.lastRenderTime = -999999;
        }

        log.info('SubtitlesOctopus canvas cleared (seek reset — prerender deadlock broken)');
    }

    destroy() {
        window.removeEventListener('resize', this._onWindowResize);
        this._teardownOctopus();
        this._removeDOM();
    }

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

                const isUltraLegacy = document.documentElement.getAttribute('data-layout-tier') === 'ultra-legacy';
                this._wrapper.style.zIndex = isUltraLegacy ? '50' : '1';

                this._container.appendChild(this._wrapper);
            }

            if (this._canvas) {
                log.info('Removing stale virtual canvas element before recreation');
                this._canvas.remove();
            }

            this._canvas = document.createElement('canvas');
            this._canvas.style.position = 'absolute';
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

    _teardownOctopus() {
        if (this._octopus) {
            try {
                if (this._isVirtual) {
                    this._octopus.video = null;
                }
                this._octopus.dispose();
            } catch (err) {
                log.warn('Error disposing SubtitlesOctopus instance:', err);
            }
            this._octopus = null;
        }
    }

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

        const ratio = Math.min(
            containerWidth / videoWidth,
            containerHeight / videoHeight
        );

        const subsWidth = videoWidth * ratio;
        const subsHeight = videoHeight * ratio;
        const subsLeft = (containerWidth - subsWidth) / 2;
        const subsTop = (containerHeight - subsHeight) / 2;

        this._canvas.style.width = Math.round(subsWidth) + 'px';
        this._canvas.style.height = Math.round(subsHeight) + 'px';
        this._canvas.style.left = Math.round(subsLeft) + 'px';
        this._canvas.style.top = Math.round(subsTop) + 'px';

        if (this._octopus) {
            log.info(`Manual resize virtual worker canvas to ${Math.round(subsWidth)}x${Math.round(subsHeight)}`);
            this._octopus.resize(Math.round(subsWidth), Math.round(subsHeight));
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
