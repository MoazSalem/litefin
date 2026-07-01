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
    _availableFonts = {
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
     */
    constructor({ container, video, width, height }) {
        this._container = container;
        this._videoElement = video || null;
        this._isVirtual = !video;
        this._videoWidth = width || 1920;
        this._videoHeight = height || 1080;

        this._fontFamily = null;
        this._fontClass = null;
        this._fontScale = 1.0;
        this._outlineThickness = null;
        this._shadowThickness = null;
        this._lineHeight = 0;
        this._letterSpacing = 0;
        this._bottomOffset = 0;

        this._octopus = null;
        this._wrapper = null;
        this._canvas = null;
        this._delaySeconds = 0;
        this._lastTime = null;
        this._rawContent = null;
        this._lastProcessedHash = null;
        this._lastProcessedResult = null;

        this._videoProxy = {
            currentTime: 0,
            paused: false,
            playbackRate: 1.0
        };

        this._onWindowResize = () => this._resizeRenderer();

        log.info('LibassWasmRenderer initialized' +
            (this._isVirtual ? ' (AVPlay/Manual mode)' : ' (HTML5/Auto mode)'));
    }

    tick(timeSeconds) {
        this._lastTime = timeSeconds;
        if (this._isVirtual && this._octopus) {
            const offsetTime = timeSeconds - this._delaySeconds;
            this._videoProxy.currentTime = offsetTime;
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

            const fonts = FontLoader.getContainerFontUrls();
            log.info(`Initializing SubtitlesOctopus with ${fonts.length} container font(s)`);

            const availableFonts = getAvailableFonts();
            const overrideFontFamily = SubtitleStyles.getFontFamily('subtitleFontAss');
            const targetFontFamily = (this._fontFamily && this._fontFamily !== 'null')
                ? this._fontFamily
                : (overrideFontFamily || 'Roboto');

            const fallbackFontUrl = availableFonts[targetFontFamily.toLowerCase()] || getAbsoluteUrl('js/default.woff2');

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
                targetFps: 24,
                prescaleFactor: prescaleFactor,
                prescaleHeightLimit: 1080,
                maxRenderHeight: maxHeight,
                resizeVariation: 0.2,
                renderAhead: this._isVirtual ? 30 : 50
            };

            this._octopus = new SubtitlesOctopus(options);

            if (this._isVirtual) {
                this._octopus.video = this._videoProxy;
                log.info('Injected virtual video proxy into SubtitlesOctopus (AVPlay mode)');
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
        log.info(`LibassWasmRenderer.setFontStyles: family="${fontFamily}", scale=${fontScale}, outline=${outlineThickness}, shadow=${shadowThickness}`);

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

        this._updateWrapperStyles();

        if (this._rawContent && styleRequiresReparse) {
            // Invalidate hash so setTrack re-processes the content
            this._lastProcessedHash = null;
            log.info('Re-preprocessing ASS content for SubtitlesOctopus...');
            await this.setTrack(this._rawContent);
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
        if (this._octopus && this._isVirtual) {
            log.info('Clearing SubtitlesOctopus canvas overlay on seek');
            this._octopus.lastRenderTime = -999999;
            this._octopus.setCurrentTime(-1);
        }
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

        if (this._bottomOffset) {
            log.debug(`Applying translateY offset translation: ${-this._bottomOffset}px`);
            target.style.transform = `translateY(${-this._bottomOffset}px)`;
        } else {
            target.style.transform = '';
        }
    }

    _preProcessAssContent(content, fontFamily, fontScale = 1.0, outlineThickness = 0.8, shadowThickness = 0.5) {
        if (!content) return content;

        log.debug('Pre-processing ASS content for SubtitlesOctopus...');

        const lines = content.split(/\r?\n/);

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

            if (trimmed.startsWith('Dialogue:')) {
                return line.replace(/\\(fn|bord|shad|s?out|s?shad)[^\\})]+(?=[\\})])/g, '');
            }

            return line;
        });

        return processedLines.join('\n');
    }
}
