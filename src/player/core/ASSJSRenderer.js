import ASS from 'assjs';
import { logger } from '../../utils/Logger.js';

const log = logger.create('ASSJSRenderer');

/**
 * ASS.js can produce malformed CSS keyframe offsets from certain \fade()
 * combinations (non-monotonically-decreasing). Element.animate() throws
 * TypeError when this happens, breaking the rAF loop. We patch the method
 * once globally to swallow only this specific error and return a no-op
 * Animation stub so ASS.js can continue without crashing.
 */
if (typeof Element !== 'undefined' && Element.prototype.animate && !Element.prototype._assPatched) {
    const _origAnimate = Element.prototype.animate;
    const _noopAnimation = {
        currentTime: null,
        effect: null,
        finished: Promise.resolve(),
        id: '',
        oncancel: null,
        onfinish: null,
        pause: () => {},
        play: () => {},
        cancel: () => {},
        finish: () => {},
        reverse: () => {},
        commitStyles: () => {},
        persist: () => {},
        updatePlaybackRate: () => {},
        pending: false,
        playbackRate: 1,
        ready: Promise.resolve(),
        replaceState: 'active',
        startTime: null,
        timeline: null
    };
    Element.prototype.animate = function (keyframes, options) {
        try {
            return _origAnimate.call(this, keyframes, options);
        } catch (e) {
            log.verbose('ASS.js animate error:', e.message);
            return _noopAnimation;
        }
    };
    Element.prototype._assPatched = true;
}

export default class ASSJSRenderer {
    constructor({ container, video, width, height }) {
        this._container = container;
        this._videoElement = video || null;
        this._videoWidth = width || 1920;
        this._videoHeight = height || 1080;

        this._ass = null;
        this._assContainer = null;
        this._clockProxy = null;
        this._delaySeconds = 0;
        this._lastTime = null;
        this._content = null;
        this._gcObserver = null;

        this._currentTime = 0;
        this._paused = false;

        this._fontClass = null;
        this._fontFamily = null;
        this._fontScale = 1.0;
        this._outlineThickness = null;
        this._shadowThickness = null;
        this._lineHeight = 0;
        this._letterSpacing = 0;
        this._bottomOffset = 0;
        log.info('ASSJSRenderer initialized');
    }

    setStyleConfig({ enableModifications, preferredEngine } = {}) {
        this._enableModifications = enableModifications;
        this._preferredEngine = preferredEngine;
    }

    _createClockProxy() {
        const proxy = document.createElement('div');
        proxy.style.position = 'absolute';
        proxy.style.top = '0';
        proxy.style.left = '0';
        proxy.style.width = '100%';
        proxy.style.height = '100%';
        proxy.style.opacity = '0';
        proxy.style.pointerEvents = 'none';
        proxy.style.zIndex = '-1';
        this._container.appendChild(proxy);

        const self = this;
        Object.defineProperty(proxy, 'currentTime', {
            get: () => self._currentTime,
            set: (v) => { self._currentTime = v; },
            configurable: true
        });
        Object.defineProperty(proxy, 'paused', {
            get: () => self._paused,
            configurable: true
        });
        Object.defineProperty(proxy, 'videoWidth', {
            get: () => self._videoWidth || 1920,
            configurable: true
        });
        Object.defineProperty(proxy, 'videoHeight', {
            get: () => self._videoHeight || 1080,
            configurable: true
        });

        return proxy;
    }

    _dispatchSeeking(from) {
        if (!this._clockProxy) return;
        try {
            this._clockProxy.dispatchEvent(new Event('seeking'));
        } catch (err) {
            log.warn(`ASS.js seek error (${from}):`, err.message);
        }
    }

    tick(timeSeconds) {
        this._lastTime = timeSeconds;
        if (!this._ass) return;

        this._currentTime = timeSeconds;

        if (this._assContainer && this._assContainer.style.visibility === 'hidden') {
            this._assContainer.style.visibility = '';
        }
    }

    resize(width, height) {
        if (width) this._videoWidth = width;
        if (height) this._videoHeight = height;

        if (this._clockProxy) {
            this._clockProxy.style.width = (width || this._videoWidth) + 'px';
            this._clockProxy.style.height = (height || this._videoHeight) + 'px';
            this._dispatchSeeking('resize');
        }
    }

    async setTrack(content) {
        if (typeof content !== 'string') {
            log.error('setTrack received non-string content:', typeof content);
            throw new Error('Subtitle content must be a string');
        }

        this.destroy();
        this._content = content;

        try {
            // Cache container dimensions BEFORE any heavy DOM creation to avoid
            // forcing a full synchronous layout after ass.js adds thousands of
            // elements.  Reading offsetWidth/offsetHeight at the right moment
            // — before the subtitle DOM tree exists — is essentially free.
            const containerWidth = this._container.offsetWidth || this._videoWidth;
            const containerHeight = this._container.offsetHeight || this._videoHeight;

            this._assContainer = document.createElement('div');
            this._assContainer.style.position = 'absolute';
            this._assContainer.style.top = '0';
            this._assContainer.style.left = '0';
            this._assContainer.style.width = containerWidth + 'px';
            this._assContainer.style.height = containerHeight + 'px';
            this._assContainer.style.pointerEvents = 'none';
            this._container.appendChild(this._assContainer);

            this._gcObserver = new MutationObserver((mutations) => {
                for (const mutation of mutations) {
                    for (const node of mutation.removedNodes) {
                        if (node.nodeType === 1) {
                            node.getAnimations().forEach((a) => a.cancel());
                            node.querySelectorAll('*').forEach((el) => el.getAnimations().forEach((a) => a.cancel()));
                        }
                    }
                }
            });
            this._gcObserver.observe(this._assContainer, { childList: true, subtree: true });

            const processedContent = this._preProcessAssContent(content, this._fontFamily);
            const video = this._createClockProxy();
            this._clockProxy = video;

            this._ass = new ASS(processedContent, video, {
                container: this._assContainer
            });

            if (this._delaySeconds) {
                this._ass.delay = this._delaySeconds;
            }

            this._applyStyles();

            video.dispatchEvent(new Event('play'));

            log.info('ASS.js renderer created successfully');
        } catch (err) {
            log.error('Failed to create ASS.js renderer:', err);
            this.destroy();
            throw err;
        }
    }

    setDelay(seconds) {
        this._delaySeconds = seconds || 0;
        if (this._ass) {
            this._ass.delay = this._delaySeconds;
        }
        log.debug(`ASS.js delay set to ${seconds}s`);
    }

    async setFontStyles(className, fontFamily, fontScale, outlineThickness, shadowThickness, lineHeight, letterSpacing, bottomOffset) {
        log.info(`ASSJSRenderer.setFontStyles: class="${className}", family="${fontFamily}"`);

        const needsReparse = this._fontFamily !== fontFamily;
        this._fontClass = className;
        this._fontFamily = fontFamily;
        this._fontScale = fontScale || 1.0;
        this._outlineThickness = outlineThickness !== undefined ? outlineThickness : null;
        this._shadowThickness = shadowThickness !== undefined ? shadowThickness : null;
        this._lineHeight = lineHeight || 0;
        this._letterSpacing = letterSpacing || 0;
        this._bottomOffset = bottomOffset || 0;

        if (this._content && needsReparse) {
            log.info(`Re-creating ASS.js with new font: ${fontFamily}`);
            const currentTime = this._lastTime || 0;
            const content = this._content;
            const delay = this._delaySeconds;
            this.destroy();
            await this.setTrack(content);
            if (this._ass && delay) {
                this._ass.delay = delay;
            }
            this._currentTime = currentTime;
        }

        this._applyStyles();
    }

    play() {
        this._paused = false;
        if (this._clockProxy) {
            this._clockProxy.dispatchEvent(new Event('play'));
        }
    }

    pause() {
        this._paused = true;
        if (this._clockProxy) {
            this._clockProxy.dispatchEvent(new Event('pause'));
        }
    }

    show() {
        if (this._assContainer) {
            this._assContainer.style.display = '';
        }
        if (this._ass) {
            this._ass.show();
        }
    }

    hide() {
        if (this._assContainer) {
            this._assContainer.style.display = 'none';
        }
    }

    clearTrack() {
        this.destroy();
    }

    clear() {
        if (!this._ass) return;
        this._currentTime = -1;
        this._dispatchSeeking('clear');
        if (this._assContainer) {
            this._assContainer.style.visibility = 'hidden';
        }
    }

    destroy() {
        if (this._ass) {
            try {
                this._ass.destroy();
            } catch (err) {
                log.warn('Error destroying ASS instance:', err);
            }
            this._ass = null;
        }

        if (this._styleElement && this._styleElement.parentNode) {
            this._styleElement.parentNode.removeChild(this._styleElement);
        }
        this._styleElement = null;

        if (this._assContainer && this._assContainer.parentNode) {
            this._assContainer.parentNode.removeChild(this._assContainer);
        }
        this._assContainer = null;

        if (this._clockProxy && this._clockProxy.parentNode) {
            this._clockProxy.parentNode.removeChild(this._clockProxy);
        }
        this._clockProxy = null;

        this._content = null;

        if (this._gcObserver) {
            this._gcObserver.disconnect();
            this._gcObserver = null;
        }
    }

    _applyStyles() {
        if (this._styleElement && this._styleElement.parentNode) {
            this._styleElement.parentNode.removeChild(this._styleElement);
            this._styleElement = null;
        }

        if (!this._assContainer) return;

        const rules = [];

        if (this._fontScale && this._fontScale !== 1.0) {
            rules.push(`
.ASS-dialogue [data-text] {
    font-size: calc(var(--ass-scale) * var(--ass-real-fs) * ${this._fontScale}px) !important;
}`);
        }

        if (this._lineHeight) {
            rules.push(`
.ASS-dialogue [data-text] {
    line-height: calc(var(--ass-scale) * var(--ass-tag-fs) * 1px + ${this._lineHeight}px) !important;
}`);
        }

        if (this._letterSpacing) {
            rules.push(`
.ASS-dialogue [data-text] {
    letter-spacing: calc(var(--ass-scale) * var(--ass-tag-fsp) * 1px + ${this._letterSpacing}px) !important;
}`);
        }

        if (this._bottomOffset) {
            rules.push(`
.ASS-box {
    margin-top: -${this._bottomOffset}px !important;
}`);
        }

        if (this._outlineThickness !== null && this._outlineThickness !== undefined) {
            rules.push(`
.ASS-dialogue [data-border-style="1"]::after {
    -webkit-text-stroke: calc(var(--ass-scale-stroke) * var(--ass-border-width) * ${this._outlineThickness}px) var(--ass-border-color) !important;
}`);
        }

        if (this._shadowThickness !== null && this._shadowThickness !== undefined) {
            rules.push(`
.ASS-dialogue [data-border-style="1"]::before {
    transform: translate(calc(var(--ass-scale-stroke) * var(--ass-tag-xshad) * ${this._shadowThickness}px), calc(var(--ass-scale-stroke) * var(--ass-tag-yshad) * ${this._shadowThickness}px)) !important;
}`);
        }

        if (rules.length === 0) return;

        const style = document.createElement('style');
        style.textContent = rules.join('\n');
        this._assContainer.appendChild(style);
        this._styleElement = style;
    }

    _preProcessAssContent(content, fontFamily) {
        if (!content || !fontFamily || fontFamily === 'null') return content;

        const lines = content.split(/\r?\n/);
        let styleFormat = null;

        const processed = lines.map(line => {
            const trimmed = line.trim();
            if (trimmed.startsWith('Format:') && (trimmed.includes('Outline') || trimmed.includes('Fontname'))) {
                styleFormat = trimmed.substring(trimmed.indexOf(':') + 1).split(',').map(s => s.trim());
                return line;
            }
            if (trimmed.startsWith('Style:') && styleFormat) {
                const parts = line.substring(line.indexOf(':') + 1).split(',');
                const fontIdx = styleFormat.indexOf('Fontname');
                if (fontIdx !== -1) {
                    parts[fontIdx] = fontFamily;
                }
                return 'Style: ' + parts.join(',');
            }
            return line;
        });

        return processed.join('\n');
    }
}
