/**
 * ============================================================================
 * FastFin Tizen - AnimationManager
 * ============================================================================
 * GPU-accelerated animation utilities optimized for TV performance.
 * Uses CSS transforms and opacity for smooth 60fps animations.
 * 
 * Features:
 * - Predefined TV-optimized animations
 * - Automatic GPU layer promotion
 * - Animation queue management
 * - Respects reduced-motion preferences
 * ============================================================================
 */

// Default animation durations (ms)
const DURATION = {
    fast: 150,
    normal: 250,
    slow: 400
};

// Easing functions
const EASING = {
    ease: 'cubic-bezier(0.25, 0.1, 0.25, 1)',
    easeIn: 'cubic-bezier(0.42, 0, 1, 1)',
    easeOut: 'cubic-bezier(0, 0, 0.58, 1)',
    easeInOut: 'cubic-bezier(0.42, 0, 0.58, 1)',
    spring: 'cubic-bezier(0.175, 0.885, 0.32, 1.275)'
};

class AnimationManager {
    constructor() {
        // Check for reduced motion preference
        this._prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

        // Active animations for cleanup
        this._activeAnimations = new Map();
    }

    /**
     * Check if animations should be skipped
     * @returns {boolean} True if animations should be skipped
     */
    shouldSkipAnimation() {
        return this._prefersReducedMotion;
    }

    /**
     * Promote element to GPU layer for smooth animations
     * @param {HTMLElement} element - Element to promote
     */
    promoteToGPU(element) {
        element.style.transform = 'translateZ(0)';
        element.style.willChange = 'transform, opacity';
    }

    /**
     * Remove GPU layer promotion
     * @param {HTMLElement} element - Element to demote
     */
    demoteFromGPU(element) {
        element.style.willChange = 'auto';
    }

    /**
     * Animate element with CSS transition
     * @param {HTMLElement} element - Element to animate
     * @param {Object} properties - CSS properties to animate
     * @param {Object} [options] - Animation options
     * @returns {Promise} Resolves when animation completes
     */
    animate(element, properties, options = {}) {
        const {
            duration = DURATION.normal,
            easing = EASING.ease,
            delay = 0
        } = options;

        // Skip if reduced motion
        if (this._prefersReducedMotion) {
            Object.assign(element.style, properties);
            return Promise.resolve();
        }

        return new Promise((resolve) => {
            // Prepare GPU layer
            this.promoteToGPU(element);

            // Set up transition
            const props = Object.keys(properties);
            element.style.transition = props
                .map(prop => `${this._kebabCase(prop)} ${duration}ms ${easing} ${delay}ms`)
                .join(', ');

            // Apply properties
            requestAnimationFrame(() => {
                Object.assign(element.style, properties);
            });

            // Clean up after animation
            const cleanup = () => {
                element.style.transition = '';
                this.demoteFromGPU(element);
                element.removeEventListener('transitionend', onEnd);
                resolve();
            };

            const onEnd = (e) => {
                if (e.target === element) {
                    cleanup();
                }
            };

            element.addEventListener('transitionend', onEnd);

            // Fallback timeout in case transitionend doesn't fire
            setTimeout(cleanup, duration + delay + 50);
        });
    }

    /**
     * Fade in animation
     * @param {HTMLElement} element - Element to fade in
     * @param {Object} [options] - Animation options
     */
    async fadeIn(element, options = {}) {
        element.style.opacity = '0';
        element.style.display = '';

        await this.animate(element, { opacity: '1' }, {
            duration: options.duration || DURATION.fast,
            ...options
        });
    }

    /**
     * Fade out animation
     * @param {HTMLElement} element - Element to fade out
     * @param {Object} [options] - Animation options
     */
    async fadeOut(element, options = {}) {
        await this.animate(element, { opacity: '0' }, {
            duration: options.duration || DURATION.fast,
            ...options
        });

        if (options.hide !== false) {
            element.style.display = 'none';
        }
    }

    /**
     * Scale animation (for focus effects)
     * @param {HTMLElement} element - Element to scale
     * @param {number} scale - Target scale (e.g., 1.1)
     * @param {Object} [options] - Animation options
     */
    async scale(element, scale, options = {}) {
        await this.animate(element, {
            transform: `scale(${scale}) translateZ(0)`
        }, {
            duration: options.duration || DURATION.fast,
            easing: EASING.spring,
            ...options
        });
    }

    /**
     * Slide in from direction
     * @param {HTMLElement} element - Element to slide
     * @param {string} from - Direction: 'left', 'right', 'top', 'bottom'
     * @param {Object} [options] - Animation options
     */
    async slideIn(element, from = 'right', options = {}) {
        const distance = options.distance || 100;
        let startTransform;

        switch (from) {
            case 'left':
                startTransform = `translateX(-${distance}px)`;
                break;
            case 'right':
                startTransform = `translateX(${distance}px)`;
                break;
            case 'top':
                startTransform = `translateY(-${distance}px)`;
                break;
            case 'bottom':
                startTransform = `translateY(${distance}px)`;
                break;
        }

        element.style.transform = startTransform;
        element.style.opacity = '0';
        element.style.display = '';

        await this.animate(element, {
            transform: 'translateX(0) translateY(0) translateZ(0)',
            opacity: '1'
        }, {
            duration: options.duration || DURATION.normal,
            easing: EASING.easeOut,
            ...options
        });
    }

    /**
     * Slide out in direction
     * @param {HTMLElement} element - Element to slide
     * @param {string} to - Direction: 'left', 'right', 'top', 'bottom'
     * @param {Object} [options] - Animation options
     */
    async slideOut(element, to = 'left', options = {}) {
        const distance = options.distance || 100;
        let endTransform;

        switch (to) {
            case 'left':
                endTransform = `translateX(-${distance}px) translateZ(0)`;
                break;
            case 'right':
                endTransform = `translateX(${distance}px) translateZ(0)`;
                break;
            case 'top':
                endTransform = `translateY(-${distance}px) translateZ(0)`;
                break;
            case 'bottom':
                endTransform = `translateY(${distance}px) translateZ(0)`;
                break;
        }

        await this.animate(element, {
            transform: endTransform,
            opacity: '0'
        }, {
            duration: options.duration || DURATION.normal,
            easing: EASING.easeIn,
            ...options
        });

        if (options.hide !== false) {
            element.style.display = 'none';
        }
    }

    /**
     * Focus scale animation for cards
     * @param {HTMLElement} element - Card element
     * @param {boolean} focused - Focus state
     */
    focusScale(element, focused) {
        if (this._prefersReducedMotion) {
            element.style.transform = focused ? 'scale(1.05) translateZ(0)' : 'translateZ(0)';
            return;
        }

        element.style.transition = `transform ${DURATION.fast}ms ${EASING.spring}`;
        element.style.transform = focused ? 'scale(1.05) translateZ(0)' : 'translateZ(0)';
    }

    /**
     * Stagger animation for lists
     * @param {HTMLElement[]} elements - Elements to animate
     * @param {Function} animateFn - Animation function for each element
     * @param {number} [staggerDelay=50] - Delay between each element
     */
    async stagger(elements, animateFn, staggerDelay = 50) {
        const promises = elements.map((el, index) => {
            return new Promise(resolve => {
                setTimeout(async () => {
                    await animateFn(el, index);
                    resolve();
                }, index * staggerDelay);
            });
        });

        await Promise.all(promises);
    }

    /**
     * Convert camelCase to kebab-case
     * @private
     */
    _kebabCase(str) {
        return str.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`);
    }
}

// Export singleton instance
export const animationManager = new AnimationManager();

// Export constants
export { DURATION, EASING };

export default AnimationManager;
