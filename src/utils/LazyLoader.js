/**
 * ============================================================================
 * Litefin Tizen - Lazy Loader
 * ============================================================================
 * Polyfill-like functionality for lazy loading images using IntersectionObserver.
 * Necessary because Tizen 4 (Chromium 56) ignores loading="lazy".
 * ============================================================================
 */

import { logger } from './Logger.js';

const log = logger.create('LazyLoader');

class LazyLoader {
    constructor() {
        this.observer = null;
        this._init();
    }

    _init() {
        // Tizen 4 (Chrome 56) supports IntersectionObserver
        if ('IntersectionObserver' in window) {
            this.observer = new IntersectionObserver(
                (entries, observer) => {
                    entries.forEach((entry) => {
                        if (entry.isIntersecting) {
                            const target = entry.target;

                            // Case 1: Lazy Row (Load all children when it enters view)
                            // NOTE: VirtualCardRow calls forceLoad() eagerly on all windowed
                            // home-screen cards, so this path mainly fires for non-virtual rows
                            // (e.g. library grids, details cast rows).
                            if (target.hasAttribute('data-lazy-row')) {
                                this._loadRow(target);

                                // Removed: aggressive next-3-rows burst preload.
                                // The 2.5-screen rootMargin already ensures the next row enters
                                // the observer before it's visible. Loading 3 rows in a burst
                                // caused a spike of 60+ simultaneous image requests on page load,
                                // choking the CPU exactly when it's also trying to animate the scroll.
                            }
                            // Case 2: Individual Image (Grid)
                            else if (target.dataset.src) {
                                this._loadImage(target);

                                // AGGRESSIVE PRELOAD: Load next 20 images in grid sequence
                                // Simulates "Page Loading" - once we hit a new section, load a full screen ahead
                                this._batchPreloadImages(target);
                            }
                        }
                    });
                },
                {
                    // Preload ~0.8 screens ahead — enough to have the next row ready
                    // before it scrolls into view, without triggering a burst of 60+
                    // simultaneous decode requests on page load.
                    // VirtualCardRow handles home-screen card preloading internally via forceLoad().
                    rootMargin: `${Math.ceil(window.innerHeight * 0.8)}px`,
                    threshold: 0.01
                }
            );
        } else {
            log.warn('IntersectionObserver not supported. Fallback to immediate load.');
        }
    }

    /**
     * Helper to load all images in a row container
     * @param {HTMLElement} row
     * @private
     */
    _loadRow(row) {
        if (!row) return;

        const images = row.querySelectorAll('img[data-src]');
        images.forEach((img) => {
            img.src = img.dataset.src;
            img.onload = () => {
                img.classList.add('loaded');

                // Remove shimmer from parent card-image
                const parent = img.parentElement;
                if (parent && parent.classList.contains('card-image')) {
                    parent.classList.remove('skeleton-shimmer');
                }

                img.removeAttribute('data-src');
            };
            img.onerror = () => {
                img.style.display = 'none';
            };
        });

        // Stop observing this row since we loaded it
        if (this.observer) {
            this.observer.unobserve(row);
        }
    }

    _loadImage(img) {
        if (!img || !img.dataset.src) return;

        img.src = img.dataset.src;
        img.onload = () => {
            img.classList.add('loaded');

            // Remove shimmer from parent card-image
            const parent = img.parentElement;
            if (parent && parent.classList.contains('card-image')) {
                parent.classList.remove('skeleton-shimmer');
            }

            img.removeAttribute('data-src');
        };
        img.onerror = () => {
            img.style.display = 'none';
        };

        if (this.observer) {
            this.observer.unobserve(img);
        }
    }

    /**
     * Forcibly load an image immediately, bypassing IntersectionObserver bounding box checks.
     * Required for GPU hardware-accelerated containers (`translate3d`) where old webkits
     * fail to intersect bounding rects correctly.
     * @param {HTMLElement} img
     */
    forceLoad(img) {
        this._loadImage(img);
    }

    /**
     * Helper to batch preload subsequent images in a grid
     * Finds next 20 images in the DOM sequence from the current image
     * @param {HTMLElement} startImg
     * @private
     */
    _batchPreloadImages(startImg) {
        if (!startImg) return;

        // Find parent card to traverse siblings
        const currentCard = startImg.closest('.media-card');
        if (!currentCard) return; // Should not happen in standard grid

        let nextCard = currentCard.nextElementSibling;
        let count = 0;

        while (nextCard && count < 20) {
            const img = nextCard.querySelector('img[data-src]');
            if (img) {
                this._loadImage(img);
            }
            nextCard = nextCard.nextElementSibling;
            count++;
        }
    }

    /**
     * Start observing images in a container
     * @param {HTMLElement} container - functionality scoped to this container
     */
    observe(container) {
        if (!container) return;

        // If no observer (older browser?), just load immediately
        if (!this.observer) {
            const images = container.querySelectorAll('img[data-src]');
            images.forEach((img) => {
                img.src = img.dataset.src;
                img.removeAttribute('data-src');
            });
            return;
        }

        // Observe individual images (vertical grids)
        const images = container.querySelectorAll('img[data-src]');
        images.forEach((img) => {
            // Only observe if NOT inside a lazy row (avoid double observation)
            if (!img.closest('[data-lazy-row]')) {
                this.observer.observe(img);
            }
        });

        // Observe lazy rows (horizontal scrollers)
        // This solves horizontal clipping issues by loading the whole row when it enters the viewport
        const rows = container.querySelectorAll('[data-lazy-row]');
        rows.forEach((row) => this.observer.observe(row));
    }

    /**
     * Observe a specific single element
     * @param {HTMLElement} img
     * @private
     */
    observeElement(img) {
        if (!img || !img.dataset.src) return;

        if (!this.observer) {
            img.src = img.dataset.src;
            return;
        }

        this.observer.observe(img);
    }
}

export const lazyLoader = new LazyLoader();
export default lazyLoader;
