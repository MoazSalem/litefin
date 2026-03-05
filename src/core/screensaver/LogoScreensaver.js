/**
 * ============================================================================
 * Litefin Tizen - Logo Screensaver
 * ============================================================================
 * Displays a bouncing/animating logo when the app is idle (unauthenticated)
 * Ported from jellyfin-web.
 * ============================================================================
 */

import { randomInt } from '../../utils/Utils.js';

export class LogoScreensaver {
    constructor() {
        this.name = 'LogoScreensaver';
        this.id = 'logoscreensaver';
        this._interval = null;
        this._elem = null;
    }

    _animate() {
        const animations = [
            this._bounceInLeft,
            this._bounceInRight,
            this._swing,
            this._tada,
            this._wobble,
            this._rotateIn,
            this._rotateOut
        ];

        if (this._elem?.animate) {
            const random = randomInt(0, animations.length - 1);
            animations[random](this._elem, 1);
        }
    }

    _bounceInLeft(elem, iterations) {
        const keyframes = [
            { transform: 'translate3d(-3000px, 0, 0)', opacity: '0', offset: 0 },
            { transform: 'translate3d(25px, 0, 0)', opacity: '1', offset: 0.6 },
            { transform: 'translate3d(-100px, 0, 0)', offset: 0.75 },
            { transform: 'translate3d(5px, 0, 0)', offset: 0.9 },
            { transform: 'none', opacity: '1', offset: 1 }
        ];
        const timing = { duration: 900, iterations: iterations, easing: 'cubic-bezier(0.215, 0.610, 0.355, 1.000)' };
        return elem.animate(keyframes, timing);
    }

    _bounceInRight(elem, iterations) {
        const keyframes = [
            { transform: 'translate3d(3000px, 0, 0)', opacity: '0', offset: 0 },
            { transform: 'translate3d(-25px, 0, 0)', opacity: '1', offset: 0.6 },
            { transform: 'translate3d(100px, 0, 0)', offset: 0.75 },
            { transform: 'translate3d(-5px, 0, 0)', offset: 0.9 },
            { transform: 'none', opacity: '1', offset: 1 }
        ];
        const timing = { duration: 900, iterations: iterations, easing: 'cubic-bezier(0.215, 0.610, 0.355, 1.000)' };
        return elem.animate(keyframes, timing);
    }

    _swing(elem, iterations) {
        const keyframes = [
            { transform: 'translate(0%)', offset: 0 },
            { transform: 'rotate3d(0, 0, 1, 15deg)', offset: 0.2 },
            { transform: 'rotate3d(0, 0, 1, -10deg)', offset: 0.4 },
            { transform: 'rotate3d(0, 0, 1, 5deg)', offset: 0.6 },
            { transform: 'rotate3d(0, 0, 1, -5deg)', offset: 0.8 },
            { transform: 'rotate3d(0, 0, 1, 0deg)', offset: 1 }
        ];
        const timing = { duration: 900, iterations: iterations };
        return elem.animate(keyframes, timing);
    }

    _tada(elem, iterations) {
        const keyframes = [
            { transform: 'scale3d(1, 1, 1)', offset: 0 },
            { transform: 'scale3d(.9, .9, .9) rotate3d(0, 0, 1, -3deg)', offset: 0.1 },
            { transform: 'scale3d(.9, .9, .9) rotate3d(0, 0, 1, -3deg)', offset: 0.2 },
            { transform: 'scale3d(1.1, 1.1, 1.1) rotate3d(0, 0, 1, 3deg)', offset: 0.3 },
            { transform: 'scale3d(1.1, 1.1, 1.1) rotate3d(0, 0, 1, -3deg)', offset: 0.4 },
            { transform: 'scale3d(1.1, 1.1, 1.1) rotate3d(0, 0, 1, 3deg)', offset: 0.5 },
            { transform: 'scale3d(1.1, 1.1, 1.1) rotate3d(0, 0, 1, -3deg)', offset: 0.6 },
            { transform: 'scale3d(1.1, 1.1, 1.1) rotate3d(0, 0, 1, 3deg)', offset: 0.7 },
            { transform: 'scale3d(1.1, 1.1, 1.1) rotate3d(0, 0, 1, -3deg)', offset: 0.8 },
            { transform: 'scale3d(1.1, 1.1, 1.1) rotate3d(0, 0, 1, 3deg)', offset: 0.9 },
            { transform: 'scale3d(1, 1, 1)', offset: 1 }
        ];
        const timing = { duration: 900, iterations: iterations };
        return elem.animate(keyframes, timing);
    }

    _wobble(elem, iterations) {
        const keyframes = [
            { transform: 'translate(0%)', offset: 0 },
            { transform: 'translate3d(20%, 0, 0) rotate3d(0, 0, 1, 3deg)', offset: 0.15 },
            { transform: 'translate3d(-15%, 0, 0) rotate3d(0, 0, 1, -3deg)', offset: 0.45 },
            { transform: 'translate3d(10%, 0, 0) rotate3d(0, 0, 1, 2deg)', offset: 0.6 },
            { transform: 'translate3d(-5%, 0, 0) rotate3d(0, 0, 1, -1deg)', offset: 0.75 },
            { transform: 'translate(0%)', offset: 1 }
        ];
        const timing = { duration: 900, iterations: iterations };
        return elem.animate(keyframes, timing);
    }

    _rotateIn(elem, iterations) {
        const keyframes = [
            { transform: 'rotate3d(0, 0, 1, -200deg)', opacity: '0', transformOrigin: 'center', offset: 0 },
            { transform: 'none', opacity: '1', transformOrigin: 'center', offset: 1 }
        ];
        const timing = { duration: 900, iterations: iterations };
        return elem.animate(keyframes, timing);
    }

    _rotateOut(elem, iterations) {
        const keyframes = [
            { transform: 'none', opacity: '1', transformOrigin: 'center', offset: 0 },
            { transform: 'rotate3d(0, 0, 1, 200deg)', opacity: '0', transformOrigin: 'center', offset: 1 }
        ];
        const timing = { duration: 900, iterations: iterations };
        return elem.animate(keyframes, timing);
    }

    _fadeOut(elem, iterations) {
        const keyframes = [
            { opacity: '1', offset: 0 },
            { opacity: '0', offset: 1 }
        ];
        const timing = { duration: 400, iterations: iterations };
        return elem.animate(keyframes, timing);
    }

    _stopInterval() {
        if (this._interval) {
            clearInterval(this._interval);
            this._interval = null;
        }
    }

    show() {
        let container = document.querySelector('.logo-screensaver');

        if (!container) {
            container = document.createElement('div');
            container.className = 'logo-screensaver';
            document.body.appendChild(container);

            this._elem = document.createElement('img');
            this._elem.className = 'logo-screensaver-image';
            this._elem.src = 'assets/icon.png';
            container.appendChild(this._elem);
        } else {
            this._elem = container.querySelector('.logo-screensaver-image');
        }

        this._stopInterval();

        // Ensure web animations API is supported before running intervals
        if (this._elem && this._elem.animate) {
            this._interval = setInterval(() => this._animate(), 3000);
            this._animate(); // trigger first animation instantly
        }
    }

    hide() {
        this._stopInterval();

        const container = document.querySelector('.logo-screensaver');

        if (container) {
            return new Promise((resolve) => {
                const onAnimationFinish = () => {
                    if (container.parentNode) {
                        container.parentNode.removeChild(container);
                    }
                    this._elem = null;
                    resolve();
                };

                if (container.animate) {
                    const animation = this._fadeOut(container, 1);
                    animation.onfinish = onAnimationFinish;
                } else {
                    onAnimationFinish();
                }
            });
        }

        return Promise.resolve();
    }
}
