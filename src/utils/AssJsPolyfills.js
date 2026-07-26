/**
 * ============================================================================
 * Litefin Tizen - ASS.js Platform Polyfills
 * ============================================================================
 * Polyfills for Web APIs that ASS.js depends on but are missing in older
 * Chromium versions on Tizen and webOS smart TVs.
 *
 * Bundled via webpack entry arrays for Normal (Chrome 63) and Legacy (Chrome
 * 47) builds. Modern/Debug builds (Chrome 78+) skip this entirely.
 *
 * Polyfills provided:
 *   ResizeObserver   — Chrome 64+. rAF-based polling fallback.
 *   linear() easing  — Chrome 113+. Sanitized in Element.animate() calls.
 *   round() CSS      — Chrome 125+. Fallback stylesheet for \bord0\blur.
 * ============================================================================
 */

// ========================================================================
// ResizeObserver — Chrome 64+ (Tizen 5.0 = Chrome 63, Tizen 3.0 = Chrome 47)
// ASS.js instantiates ResizeObserver in its constructor. Without this
// polyfill it throws ReferenceError and subtitles never render.
// We use rAF-based polling of clientWidth/clientHeight.
// ========================================================================
if (typeof window.ResizeObserver === 'undefined') {
    window.ResizeObserver = class {
        constructor(callback) {
            this._callback = callback;
            this._elements = new Map();
            this._rafId = null;
            this._boundTick = this._tick.bind(this);
        }

        observe(target) {
            if (this._elements.has(target)) return;
            this._elements.set(target, {
                width: target.clientWidth,
                height: target.clientHeight
            });
            if (this._rafId === null) {
                this._rafId = requestAnimationFrame(this._boundTick);
            }
        }

        unobserve(target) {
            this._elements.delete(target);
            if (this._elements.size === 0 && this._rafId !== null) {
                cancelAnimationFrame(this._rafId);
                this._rafId = null;
            }
        }

        disconnect() {
            this._elements.clear();
            if (this._rafId !== null) {
                cancelAnimationFrame(this._rafId);
                this._rafId = null;
            }
        }

        _tick() {
            for (const [target, last] of this._elements) {
                const w = target.clientWidth;
                const h = target.clientHeight;
                if (w !== last.width || h !== last.height) {
                    last.width = w;
                    last.height = h;
                    try {
                        this._callback([
                            {
                                target,
                                contentRect: { width: w, height: h, top: 0, left: 0, bottom: h, right: w },
                                contentBoxSize: [{ inlineSize: w, blockSize: h }]
                            }
                        ]);
                    } catch (e) {
                        /* swallow errors in observer callbacks (per spec) */
                    }
                }
            }
            if (this._elements.size > 0) {
                this._rafId = requestAnimationFrame(this._boundTick);
            } else {
                this._rafId = null;
            }
        }
    };
}

// ========================================================================
// linear() easing function — Chrome 113+
// ASS.js generates linear(p1, p2, ...) easing strings for \t() acceleration.
// On unsupported browsers Element.animate() silently falls back to 'ease',
// but we strip the syntax preemptively to avoid any warnings and make the
// fallback path explicit.
// ========================================================================
if (typeof Element !== 'undefined' && Element.prototype.animate && !Element.prototype._assEasingPatched) {
    const _supportsLinear =
        typeof CSS !== 'undefined' && CSS.supports && CSS.supports('transition-timing-function', 'linear(0, 1)');

    if (!_supportsLinear) {
        const _origAnimate = Element.prototype.animate;
        Element.prototype.animate = function (keyframes, options) {
            if (options && options.easing && typeof options.easing === 'string') {
                if (options.easing.indexOf('linear(') === 0) {
                    options = Object.assign({}, options, { easing: 'ease' });
                }
            }
            return _origAnimate.call(this, keyframes, options);
        };
        Element.prototype._assEasingPatched = true;
    }
}

// ========================================================================
// round() CSS function — Chrome 125+
// ASS.js uses round(up, ...) in a filter: blur(calc(...)) rule to implement
// \blur with \bord0 (inner-glow effect). Without round() the entire filter
// declaration is invalid and the blur never applies.
// We inject a fallback that always permits the blur on [data-text] when
// round() is absent. The visual difference is that blur will also apply
// when borders are non-zero (rather than being suppressed), which is a
// minor cosmetic trade-off vs. losing the feature entirely.
// ========================================================================
if (
    typeof document !== 'undefined' &&
    typeof CSS !== 'undefined' &&
    CSS.supports &&
    CSS.supports('width', 'round(up, 1px, 1px)') === false
) {
    (function () {
        const style = document.createElement('style');
        style.textContent = '[data-text]{filter:blur(calc(var(--ass-scale-stroke)*var(--ass-tag-blur)*1px))!important}';
        document.head.appendChild(style);
    })();
}
