/**
 * ============================================================================
 * Litefin Tizen - Lazy Loader
 * ============================================================================
 * Polyfill-like functionality for lazy loading images using IntersectionObserver.
 * Necessary because Tizen 4 (Chromium 56) ignores loading="lazy".
 * ============================================================================
 */

import { logger } from './Logger.js';
import { eventBus } from '../core/EventBus.js';
import BlurHashDecoder from './BlurHashDecoder.js';

const log = logger.create('LazyLoader');

class LazyLoader {
    constructor() {
        this.observer = null;
        this._init();
    }

    _init() {
        // Legacy TV Focus-Driven Lazy Load
        // Since IntersectionObserver fails on Tizen/WebOS hardware layers (especially for grids),
        // we use D-Pad focus events to aggressively preload the grid as the user navigates.
        // NATIVE focus is disabled in this TV app, so we must hook EventBus.
        eventBus.on('focus:changed', (target) => {
            if (!target || !target.classList) return;

            // If it's a media card
            if (target.classList.contains('media-card')) {
                const img = target.querySelector('img[data-src]');
                if (img) {
                    this.forceLoad(img);
                }
                // Batch preload ahead to prevent popping
                this._batchPreloadImages(img || target);
            }
        });

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
            this._decodeAndDrawBlurhash(img);

            img.src = img.dataset.src;
            img.onload = () => {
                img.classList.add('loaded');

                // Remove shimmer from parent card-image and handle BlurHash fade out
                const parent = img.parentElement;
                if (parent && parent.classList.contains('card-image')) {
                    parent.classList.remove('skeleton-shimmer');

                    const canvas = parent.querySelector('.blurhash-canvas');
                    if (canvas) {
                        canvas.classList.add('fade-out');
                        setTimeout(() => canvas.remove(), 160);
                    }
                }

                img.removeAttribute('data-src');
            };
            img.onerror = () => {
                this._handleImageError(img);
            };
        });

        // Stop observing this row since we loaded it
        if (this.observer) {
            this.observer.unobserve(row);
        }
    }

    _loadImage(img) {
        if (!img || !img.dataset.src) return;

        this._decodeAndDrawBlurhash(img);

        img.src = img.dataset.src;
        img.onload = () => {
            img.classList.add('loaded');

            // Remove shimmer from parent card-image and handle BlurHash fade out
            const parent = img.parentElement;
            if (parent && parent.classList.contains('card-image')) {
                parent.classList.remove('skeleton-shimmer');

                const canvas = parent.querySelector('.blurhash-canvas');
                if (canvas) {
                    canvas.classList.add('fade-out');
                    setTimeout(() => canvas.remove(), 160);
                }
            }

            img.removeAttribute('data-src');
        };
        img.onerror = () => {
            this._handleImageError(img);
        };

        if (this.observer) {
            this.observer.unobserve(img);
        }
    }

    /**
     * Decode and draw the BlurHash string onto the sibling canvas element.
     * Run asynchronously to keep the main thread and D-pad event loops responsive on TV hardware.
     * @param {HTMLImageElement} img - The image element being loaded
     * @private
     */
    _decodeAndDrawBlurhash(img) {
        const parent = img.parentElement;
        if (!parent) return;

        const canvas = parent.querySelector('.blurhash-canvas');
        if (!canvas || canvas.classList.contains('blurhash-decoded')) return;

        const blurHashStr = canvas.dataset.blurhash;
        if (!blurHashStr) return;

        // Mark it decoded immediately to prevent duplicate decoding attempts
        canvas.classList.add('blurhash-decoded');

        // Defer decoding to keep UI/focus animations perfectly butter-smooth
        setTimeout(() => {
            // Decoded dimensions are kept extremely small (20x20) for optimal CPU/GPU usage
            const width = 20;
            const height = 20;

            const pixels = BlurHashDecoder.decode(blurHashStr, width, height);
            if (!pixels) return;

            // Prepare the 2D canvas context and write pixels
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            if (ctx) {
                const imgData = ctx.createImageData(width, height);
                imgData.data.set(pixels);
                ctx.putImageData(imgData, 0, 0);
            }
        }, 0);
    }

    /**
     * Handles image load failure by injecting lightweight gradient fallback
     * @param {HTMLElement} img
     */
    _handleImageError(img) {
        img.style.display = 'none';

        // Extract fallback dataset attached by CardRenderer
        const parent = img.parentElement;
        const isSupportedParent =
            parent &&
            (parent.classList.contains('card-image') ||
                parent.classList.contains('chapter-row__thumb-wrap') ||
                parent.classList.contains('queue-row__thumb-wrap'));

        if (isSupportedParent) {
            const isModern = document.documentElement.getAttribute('data-layout') === 'modern';

            // Remove shimmer
            parent.classList.remove('skeleton-shimmer');

            // Remove any dynamic overlays (tints/labels) and BlurHash canvases that might conflict with the fallback
            const overlays = parent.querySelectorAll('.card-overlay-tint, .card-overlay-label, .blurhash-canvas');
            overlays.forEach((el) => el.remove());

            // Construct and inject fallback if attributes exist
            const gradNum = img.dataset.fbGrad;
            const initials = img.dataset.fbInit;
            const name = img.dataset.fbName;

            if (gradNum && initials && name && !parent.querySelector('.media-fallback')) {
                const hideInitials = img.dataset.fbHideInitials === 'true';
                const fallbackHtml = `
                    <div class="media-fallback grad-${gradNum}">
                        ${!hideInitials ? `<div class="media-fallback-initials">${initials}</div>` : ''}
                        ${!isModern ? `<div class="media-fallback-name">${name}</div>` : ''}
                    </div>
                `;
                // Insert at the beginning so overlays (like progress/badges) render on top
                parent.insertAdjacentHTML('afterbegin', fallbackHtml);
            }
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

        // Default preload is 20 images. If in a dense small-poster grid, preload 6 more (26).
        let limit = 20;
        if (currentCard.parentElement && currentCard.parentElement.classList.contains('view-small-poster')) {
            limit += 7;
        }

        while (nextCard && count < limit) {
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

        const images = container.querySelectorAll('img[data-src]');

        // LEGACY FIX: Eagerly load the first 25 images in the container.
        // If view mode is small-poster, load 2 more items (27 total).
        // This ensures the initial viewport is populated even if IntersectionObserver fails.
        let eagerLoadCount = 25;
        if (container.classList.contains('view-small-poster')) {
            eagerLoadCount += 2; // 27 items
        }

        for (let i = 0; i < Math.min(images.length, eagerLoadCount); i++) {
            this.forceLoad(images[i]);
        }

        // If no observer (older browser?), we are done.
        // Focus-driven event handler will load the rest as the user navigates.
        if (!this.observer) {
            return;
        }

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
            this.forceLoad(img);
            return;
        }

        this.observer.observe(img);
    }
}

export const lazyLoader = new LazyLoader();
export default lazyLoader;
