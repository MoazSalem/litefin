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
import { storage } from './StorageService.js';

const log = logger.create('LazyLoader');

class LazyLoader {
    constructor() {
        this.observer = null;

        /* ----------------------------------------------------------------
         * SHIMMER OBSERVER
         * A separate IntersectionObserver (zero rootMargin) tracks every
         * .skeleton-shimmer element. Off-screen shimmers get the class
         * 'shimmer-hidden' which CSS maps to animation-play-state: paused.
         * A paused CSS animation requires ZERO compositor layers — this is
         * exactly what eliminates the 100+ GPU layers causing the Layerize
         * spike in Segment 1 of the profile.
         * ---------------------------------------------------------------- */
        this._shimmerObserver = null;

        // Track the native scroll debounce timer context
        this._scrollTimeout = null;

        // Queue elements that intersect during active scrolling animations or events
        this._pendingLoads = new Map();

        // ── BlurHash decode queue ───────────────────────────────────────────
        // Prevents micro-freeze storms on low-end TV CPUs by throttling
        // BlurHash DCT inversions to at most N per animation frame.
        this._blurHashQueue = [];
        this._blurHashProcessing = false;
        this._maxBlurhashPerFrame = 2;

        this._init();
    }

    _init() {
        // Capture native scroll events in the capture phase to track all scrollable nodes
        window.addEventListener(
            'scroll',
            () => {
                if (this._scrollTimeout) {
                    clearTimeout(this._scrollTimeout);
                }
                // Debounce check: scrolling is considered stopped after 150ms of silence
                this._scrollTimeout = setTimeout(() => {
                    this._scrollTimeout = null;
                    // If no scroll animations are still active, process all queued loads
                    if (!this._isScrolling()) {
                        this._processPendingLoads();
                    }
                }, 150);
            },
            true
        );

        // Listen for ScrollController finishing its transitions
        eventBus.on('scroll:finished', () => {
            // Tiny buffer allows subsequent animation frames to settle or register
            setTimeout(() => {
                if (!this._isScrolling()) {
                    this._processPendingLoads();
                }
            }, 50);
        });

        // Legacy TV Focus-Driven Lazy Load
        // Since IntersectionObserver fails on Tizen/WebOS hardware layers (especially for grids),
        // we use D-Pad focus events to aggressively preload the grid as the user navigates.
        // NATIVE focus is disabled in this TV app, so we must hook EventBus.
        eventBus.on('focus:changed', (target) => {
            if (!target || !target.classList) return;

            // Reset any previous active marquees
            // ----------------------------------------------------------------
            // MARQUEE CLEANUP: Ensure any previously animating text elements
            // are reset to their default static states. This drops animation
            // loops and releases Compositor layers when they are off focus.
            // ----------------------------------------------------------------
            document.querySelectorAll('.marquee-active').forEach((el) => {
                el.classList.remove('marquee-active');
                const span = el.querySelector('span');
                if (span) {
                    span.style.removeProperty('transform');
                }
                el.style.removeProperty('--scroll-dist');
                el.style.removeProperty('--marquee-duration');
            });

            // If it's a media card
            if (target.classList.contains('media-card')) {
                const img = target.querySelector('img[data-src]');
                if (img) {
                    this.forceLoad(img);
                }
                // Batch preload ahead to prevent popping.
                // PERFORMANCE: Defer to the next animation frame so the 20-sibling
                // DOM walk doesn't block the critical focus transition paint.
                // The focus ring appears instantly; images preload before the next frame.
                const preloadTarget = img || target;
                requestAnimationFrame(() => this._batchPreloadImages(preloadTarget));

                // ----------------------------------------------------------------
                // DYNAMIC TEXT MARQUEE SCROLL DETECTOR
                // ----------------------------------------------------------------
                // Calculates text overflow dynamically on card focus. If the inner
                // span's scrollWidth exceeds the parent clientWidth, a scrolling
                // keyframe animation is applied using HSL/CSS custom variables.
                // ----------------------------------------------------------------
                if (storage.getItem('pref:loopOverflowingText') !== 'false') {
                    const textElements = target.querySelectorAll('.card-title, .card-subtitle');
                    textElements.forEach((el) => {
                        const span = el.querySelector('span');
                        if (!span) return;

                        const scrollW = span.scrollWidth;
                        const clientW = el.clientWidth;

                        // Check if text exceeds horizontal boundaries of the card
                        if (scrollW > clientW) {
                            const scrollDist = scrollW - clientW;
                            const extraSpacing = 30; // 30px visual buffer/margin before looping back
                            const totalScroll = scrollDist + extraSpacing;

                            // Adjust scrolling duration dynamically based on length (30px/sec speed)
                            const duration = Math.max(3, totalScroll / 30);

                            el.style.setProperty('--scroll-dist', `-${totalScroll}px`);
                            el.style.setProperty('--marquee-duration', `${duration}s`);
                            el.classList.add('marquee-active');
                        }
                    });
                }
            }
        });

        // Tizen 4 (Chrome 56) supports IntersectionObserver
        if ('IntersectionObserver' in window) {
            this.observer = new IntersectionObserver(
                (entries, observer) => {
                    entries.forEach((entry) => {
                        const target = entry.target;

                        if (entry.isIntersecting) {
                            const type = target.hasAttribute('data-lazy-row') ? 'row' : 'image';

                            // Defer loading if a scroll or animation is actively running
                            if (this._isScrolling()) {
                                this._pendingLoads.set(target, type);
                            } else {
                                if (type === 'row') {
                                    this._loadRow(target);
                                } else {
                                    this._loadImage(target);
                                    this._batchPreloadImages(target);
                                }
                            }
                        } else {
                            // OPTIMIZATION: If the element exits viewport before scroll stops,
                            // remove it from queue so we never allocate decoders/requests for it.
                            this._pendingLoads.delete(target);
                        }
                    });
                },
                {
                    // Preload ~0.8 screens ahead — enough to have the next row ready
                    // before it scrolls into view, without triggering a burst of 60+
                    // simultaneous decode requests on page load.
                    // VirtualCardRow handles home-screen card preloading internally via forceLoad()
                    rootMargin: `${Math.ceil(window.innerHeight * 0.8)}px`,
                    threshold: 0.01
                }
            );

            // ================================================================
            // SHIMMER ANIMATION OBSERVER
            // ================================================================
            // CSS @keyframes animations still maintain a compositor layer even
            // without will-change when the animation is actively running — the
            // browser promotes the element so it can drive the transform on the
            // GPU thread. With 100 off-screen skeletons all animating, that is
            // 100 compositor layers eating Tizen VRAM and causing Layerize spikes.
            //
            // This observer watches .card-image.skeleton-shimmer elements with a
            // ZERO rootMargin (strictly visible only). Off-screen shimmers get
            // the 'shimmer-hidden' class which CSS maps to:
            //   animation-play-state: paused
            //
            // A PAUSED animation requires NO compositor layer — the GPU is free.
            // ================================================================
            this._shimmerObserver = new IntersectionObserver(
                (entries) => {
                    entries.forEach((entry) => {
                        // Use classList directly — no touching other properties
                        if (entry.isIntersecting) {
                            // Back in view: resume shimmer animation
                            entry.target.classList.remove('shimmer-hidden');
                        } else {
                            // Out of view: pause shimmer animation to drop GPU layer
                            entry.target.classList.add('shimmer-hidden');
                        }
                    });
                },
                {
                    // Strict viewport — only truly visible elements animate.
                    // Small negative margin ensures elements partially off the
                    // top/bottom edge are also paused.
                    rootMargin: '0px',
                    threshold: 0.0
                }
            );
        } else {
            log.warn('IntersectionObserver not supported. Fallback to immediate load.');
        }
    }

    /**
     * Check if a scrolling action or transition is active on the screen
     * @returns {boolean}
     * @private
     */
    _isScrolling() {
        // Inspect exposed ScrollController state to see if active transitions exist
        if (window.__scrollController && window.__scrollController.isAnimating) {
            return true;
        }
        return this._scrollTimeout !== null;
    }

    /**
     * Process all queued intersections once scrolling has come to a stop
     * @private
     */
    _processPendingLoads() {
        if (this._pendingLoads.size === 0) return;

        log.info(`Processing ${this._pendingLoads.size} pending lazy loads after scroll stop.`);

        // Execute batch loads for all queued elements
        this._pendingLoads.forEach((type, target) => {
            if (type === 'row') {
                this._loadRow(target);
            } else {
                this._loadImage(target);
                this._batchPreloadImages(target);
            }
        });

        this._pendingLoads.clear();
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
            if (img.classList.contains('loaded')) return;
            if (img.hasAttribute('data-lazy-loading')) return;

            this._decodeAndDrawBlurhash(img);

            img.onload = () => {
                img.classList.add('loaded');
                img.removeAttribute('data-lazy-loading');

                const parent = img.parentElement;
                if (parent) {
                    parent.classList.remove('skeleton-shimmer');

                    if (this._shimmerObserver) {
                        this._shimmerObserver.unobserve(parent);
                    }

                    if (parent.classList.contains('card-image')) {
                        const canvas = parent.querySelector('.blurhash-canvas');
                        if (canvas) {
                            canvas.classList.add('fade-out');
                            setTimeout(() => canvas.remove(), 160);
                        }
                    }
                }
            };
            img.onerror = () => {
                img.removeAttribute('data-lazy-loading');
                this._handleImageError(img);
            };

            img.src = img.dataset.src;
        });

        if (this.observer) {
            this.observer.unobserve(row);
        }
    }

    _loadImage(img) {
        if (!img || !img.dataset.src || img.classList.contains('loaded')) return;
        // Prevent re-entering while a load is in-flight.
        // The IntersectionObserver may fire before onload completes on
        // eagerly loaded images; setting src again can abort the fetch
        // on older Chromium (Tizen 3/4), causing the image to never load.
        if (img.hasAttribute('data-lazy-loading')) return;
        img.setAttribute('data-lazy-loading', '');

        this._decodeAndDrawBlurhash(img);

        img.onload = () => {
            img.classList.add('loaded');
            img.removeAttribute('data-lazy-loading');

            const parent = img.parentElement;
            if (parent) {
                parent.classList.remove('skeleton-shimmer');

                if (this._shimmerObserver) {
                    this._shimmerObserver.unobserve(parent);
                }

                if (parent.classList.contains('card-image')) {
                    const canvas = parent.querySelector('.blurhash-canvas');
                    if (canvas) {
                        canvas.classList.add('fade-out');
                        setTimeout(() => canvas.remove(), 160);
                    }
                }
            }
        };
        img.onerror = () => {
            img.removeAttribute('data-lazy-loading');
            this._handleImageError(img);
        };

        img.src = img.dataset.src;

        if (this.observer) {
            this.observer.unobserve(img);
        }
    }

    /**
     * Enqueue a BlurHash canvas for deferred, throttled decoding.
     * Instead of decoding every card's BlurHash immediately (which causes
     * micro-freeze storms on single-core TV CPUs when 30+ cards load at once),
     * we process at most `_maxBlurhashPerFrame` per animation frame.
     *
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

        // Enqueue for throttled batch processing instead of firing 30+
        // concurrent setTimeout(0) tasks that freeze the main thread.
        this._blurHashQueue.push({ canvas, blurHashStr });
        this._processBlurHashQueue();
    }

    /**
     * Process pending BlurHash decodes at a throttled rate.
     * Drains up to `_maxBlurhashPerFrame` items per rAF cycle.
     * @private
     */
    _processBlurHashQueue() {
        if (this._blurHashProcessing) return;
        if (this._blurHashQueue.length === 0) return;

        this._blurHashProcessing = true;

        const processBatch = () => {
            const batch = this._blurHashQueue.splice(0, this._maxBlurhashPerFrame);

            for (const { canvas, blurHashStr } of batch) {
                // Decoded dimensions are kept extremely small (20x20)
                const width = 20;
                const height = 20;

                const pixels = BlurHashDecoder.decode(blurHashStr, width, height);
                if (!pixels) continue;

                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                if (ctx) {
                    const imgData = ctx.createImageData(width, height);
                    imgData.data.set(pixels);
                    ctx.putImageData(imgData, 0, 0);
                }
            }

            if (this._blurHashQueue.length > 0) {
                requestAnimationFrame(processBatch);
            } else {
                this._blurHashProcessing = false;
            }
        };

        requestAnimationFrame(processBatch);
    }

    /**
     * Handles image load failure by injecting lightweight gradient fallback
     * @param {HTMLElement} img
     */
    _handleImageError(img) {
        // Prevent browser from retrying the broken URL
        const placeholder = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
        img.src = placeholder;
        img.onerror = null;
        img.onload = null;
        img.removeAttribute('data-src');
        img.removeAttribute('data-lazy-loading');
        img.style.display = 'none';

        const parent = img.parentElement;
        const isSupportedParent =
            parent &&
            (parent.classList.contains('card-image') ||
                parent.classList.contains('chapter-row__thumb-wrap') ||
                parent.classList.contains('queue-row__thumb-wrap'));

        if (isSupportedParent) {
            const isModern = document.documentElement.getAttribute('data-layout-media-rows') === 'modern';

            parent.classList.remove('skeleton-shimmer');

            const overlays = parent.querySelectorAll('.card-overlay-tint, .card-overlay-label, .blurhash-canvas');
            overlays.forEach((el) => el.remove());

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
     * Helper to batch preload subsequent images in a grid.
     * Loads in staggered chunks to avoid flooding the compositor with
     * simultaneous opacity transitions (each one promotes a GPU layer).
     * @param {HTMLElement} startImg
     * @private
     */
    _batchPreloadImages(startImg) {
        if (!startImg) return;

        const currentCard = startImg.closest('.media-card');
        if (!currentCard) return;

        let limit = 20;
        if (currentCard.parentElement && currentCard.parentElement.classList.contains('view-small-poster')) {
            limit += 7;
        }

        const backwardCount = Math.min(5, limit - 1);
        const forwardCount = limit - backwardCount;

        const pending = [];

        // Preload forward siblings (most common navigation direction)
        let nextCard = currentCard.nextElementSibling;
        let nextCount = 0;
        while (nextCard && nextCount < forwardCount) {
            const img = nextCard.querySelector('img[data-src]');
            if (img) {
                pending.push(img);
            }
            nextCard = nextCard.nextElementSibling;
            nextCount++;
        }

        // Preload backward siblings so navigating up/left also shows loaded images
        let prevCard = currentCard.previousElementSibling;
        let prevCount = 0;
        const backwardPending = [];
        while (prevCard && prevCount < backwardCount) {
            const img = prevCard.querySelector('img[data-src]');
            if (img) {
                backwardPending.push(img);
            }
            prevCard = prevCard.previousElementSibling;
            prevCount++;
        }
        // Reverse so nearest cards load first
        pending.push(...backwardPending.reverse());

        if (!pending.length) return;

        // ================================================================
        // STAGGERED LOADING: Load 5 images per setTimeout tick (0ms delay).
        // ================================================================
        // Loading all 20 at once causes 20 simultaneous opacity: 0 → 1 CSS
        // transitions, which forces 20 compositor layer promotions in a single
        // frame — directly producing the Layerize spike in the profile.
        // By chunking 5 per tick, the compositor processes each batch across
        // separate scheduler ticks, spreading the layer cost over multiple frames.
        // ================================================================
        const CHUNK_SIZE = 5;
        let offset = 0;

        const loadChunk = () => {
            const end = Math.min(offset + CHUNK_SIZE, pending.length);
            for (let i = offset; i < end; i++) {
                this._loadImage(pending[i]);
            }
            offset = end;
            if (offset < pending.length) {
                setTimeout(loadChunk, 0);
            }
        };

        loadChunk();
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
            eagerLoadCount += 2;
        }

        for (let i = 0; i < Math.min(images.length, eagerLoadCount); i++) {
            this.forceLoad(images[i]);
        }

        // If no observer (older browser?), we are done.
        // Focus-driven event handler will load the rest as the user navigates.
        if (!this.observer) {
            return;
        }

        images.forEach((img, index) => {
            // Skip eagerly loaded images to avoid observing + loading them twice
            if (index < eagerLoadCount) return;
            if (!img.closest('[data-lazy-row]')) {
                this.observer.observe(img);
            }
        });

        // Observe lazy rows (horizontal scrollers)
        const rows = container.querySelectorAll('[data-lazy-row]');
        rows.forEach((row) => this.observer.observe(row));

        // ====================================================================
        // SHIMMER OBSERVATION: Register all skeleton shimmer wrappers so
        // their CSS animations are paused when scrolled out of viewport.
        // ====================================================================
        if (this._shimmerObserver) {
            const shimmers = container.querySelectorAll('.card-image.skeleton-shimmer');
            shimmers.forEach((el) => this._shimmerObserver.observe(el));
        }
    }

    /**
     * Unobserve all lazy-load elements within a container and clear pending loads.
     * Call this when a component/page is destroyed to prevent stale observer entries.
     * @param {HTMLElement} container
     */
    clearContainer(container) {
        if (!container) return;

        // Remove pending loads that belong to this container
        this._pendingLoads.forEach((type, target) => {
            if (container.contains(target)) {
                this._pendingLoads.delete(target);
            }
        });

        // Unobserve all images tracked by the main observer
        if (this.observer) {
            const images = container.querySelectorAll('img.lazy, img[data-src]');
            images.forEach((img) => this.observer.unobserve(img));
            const rows = container.querySelectorAll('[data-lazy-row]');
            rows.forEach((row) => this.observer.unobserve(row));
        }

        // Unobserve shimmers tracked by the shimmer observer
        if (this._shimmerObserver) {
            const shimmers = container.querySelectorAll('.card-image.skeleton-shimmer');
            shimmers.forEach((el) => this._shimmerObserver.unobserve(el));
        }
    }

    /**
     * Observe a specific single element
     * @param {HTMLElement} img
     * @private
     */
    observeElement(img) {
        if (!img || !img.dataset.src || img.classList.contains('loaded')) return;

        if (!this.observer) {
            this.forceLoad(img);
            return;
        }

        this.observer.observe(img);
    }
}

export const lazyLoader = new LazyLoader();
export default lazyLoader;
