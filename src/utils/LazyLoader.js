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
import { escapeHtml } from './Utils.js';
import { customHeaders } from './CustomHeaders.js';

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

        /* ----------------------------------------------------------------
         * SCROLL ACTIVITY STATE & BLURHASH THROTTLING
         * Track scroll state exclusively for heavy mathematical operations
         * such as BlurHash DCT decoding. Network and image fetches proceed
         * unimpeded through IntersectionObserver rootMargin ahead of time.
         * ---------------------------------------------------------------- */
        this._scrollTimeout = null;

        // ── Deferred marquee measurement ────────────────────────────────────
        // Holds the focused card element when its text-overflow measurement was
        // deferred because a scroll transition was in flight. Flushed when
        // scrolling settles (see _flushPendingMarquee).
        this._pendingMarqueeTarget = null;

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
                    // Resume deferred BlurHash decoding once viewport scrolling settles
                    if (!this._isScrolling()) {
                        this._processBlurHashQueue();
                        this._flushPendingMarquee();
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
                    // Resume deferred BlurHash decoding once scrolling transitions settle
                    this._processBlurHashQueue();
                    // Engage any marquee check deferred during the scroll transition
                    this._flushPendingMarquee();
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
                //
                // PERFORMANCE NOTE:
                // Reading scrollWidth and clientWidth immediately after focus class
                // assignment forces an expensive synchronous layout reflow (50-100ms
                // on TV hardware) right as the viewport needs to begin its smooth
                // scroll. Deferring this check via requestAnimationFrame lets the layout
                // settle cleanly without dropping animation frames.
                // ----------------------------------------------------------------
                if (storage.getItem('pref:loopOverflowingText') !== 'false') {
                    requestAnimationFrame(() => {
                        // Guard against focus having already left the card
                        if (!target || !target.classList.contains('focused')) return;

                        // PERFORMANCE: Reading scrollWidth/clientWidth forces a synchronous
                        // layout reflow (50-100ms on TV hardware). If a scroll transition is
                        // in flight at this frame, defer the measurement until scrolling
                        // settles so frame 1 of the transition is never blocked. The pending
                        // target is flushed from the native-scroll debounce and the
                        // 'scroll:finished' listener above.
                        if (this._isScrolling()) {
                            this._pendingMarqueeTarget = target;
                            return;
                        }

                        this._checkTextMarquee(target);
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

                        // ====================================================
                        // IMMEDIATE INTERSECTION LOADING
                        // ====================================================
                        // Load immediately as soon as cards touch the rootMargin
                        // (~0.35 screens ahead, approx 1 row). Pre-fetching images just ahead
                        // of the viewport ensures adjacent cards are ready without saturating
                        // the browser's HTTP connection pool with distant off-screen decodes.
                        // ====================================================
                        if (entry.isIntersecting) {
                            if (target.hasAttribute('data-lazy-row')) {
                                this._loadRow(target);
                            } else {
                                // Load this specific intersecting image directly.
                                // Do NOT cascade _batchPreloadImages here: directional batch preloading
                                // is managed exclusively by active focus navigation (focus:changed) to avoid
                                // exponential duplicate preload storms during rapid scrolling.
                                this._loadImage(target);
                            }
                        }
                    });
                },
                {
                    // Calibrated lookahead cushion (~0.35 screens / approx 1 row ahead).
                    // Prevents focus-driven preloads and virtual grid pre-warming from competing
                    // for limited HTTP connections and CPU decode bandwidth on low-power TVs.
                    rootMargin: `${Math.ceil(window.innerHeight * 0.35)}px`,
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
     * Measure text overflow on the focused card and engage the CSS marquee
     * animation when the inner span overflows its container.
     *
     * PERFORMANCE NOTE: Reading scrollWidth/clientWidth forces a synchronous
     * layout reflow on low-end TV CPUs. Never call this while a scroll
     * transition is in flight — the focus:changed handler defers the call and
     * it is flushed from the scroll-settle paths instead.
     * @param {HTMLElement} target - The focused media card element
     * @private
     */
    _checkTextMarquee(target) {
        if (!target || !target.isConnected || !target.classList.contains('focused')) return;

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

    /**
     * Flush a marquee overflow check that was deferred during active scrolling.
     * Invoked from the scroll-settle paths (native scroll debounce and the
     * 'scroll:finished' event) so the forced reflow only happens once motion
     * has ended.
     * @private
     */
    _flushPendingMarquee() {
        if (!this._pendingMarqueeTarget) return;

        const target = this._pendingMarqueeTarget;
        this._pendingMarqueeTarget = null;

        this._checkTextMarquee(target);
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

            // Mark as lazy loading immediately to prevent duplicate triggers
            img.setAttribute('data-lazy-loading', '');

            // Decode and draw BlurHash canvas if present
            this._decodeAndDrawBlurhash(img);

            img.onload = () => {
                // Ignore load events fired by the initial transparent 1x1 GIF placeholder
                if (img.src && img.src.startsWith('data:image/gif')) return;

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
                // Ignore error events fired while transitioning from placeholder
                if (img.src && img.src.startsWith('data:image/gif')) return;

                img.removeAttribute('data-lazy-loading');
                this._handleImageError(img);
            };

            // Assign image source (handles crossOrigin and custom headers resolution)
            this._assignImageSource(img, img.dataset.src);
        });

        if (this.observer) {
            this.observer.unobserve(row);
        }
    }

    /**
     * Assigns the final image source to an image element.
     * When custom reverse proxy headers are active, resolves the URL via
     * CustomHeadersManager (which fetches the image with headers and converts
     * to a local in-memory blob URL), falling back gracefully on failure.
     *
     * @param {HTMLImageElement} img - Image element to update
     * @param {string} targetSrc - Jellyfin image URL from dataset
     * @private
     */
    _assignImageSource(img, targetSrc) {
        // Fast path: if no custom headers configured, assign src directly with standard anonymous crossOrigin
        if (!customHeaders?.hasCustomHeaders?.()) {
            img.crossOrigin = 'anonymous';
            img.src = targetSrc;
            return;
        }

        // Check if Blob URL is already in cache for zero-latency synchronous hit
        const cached = customHeaders.getCachedBlobUrl(targetSrc);
        if (cached) {
            // Blob URLs are local memory pointers; avoid setting crossOrigin on them
            img.removeAttribute('crossorigin');
            img.src = cached;
            return;
        }

        // Mark as lazy loading so in-flight state is preserved across async fetch
        img.setAttribute('data-lazy-loading', '');

        // Asynchronously fetch with custom headers and convert to Blob URL
        customHeaders
            .resolveImageUrl(targetSrc)
            .then((resolvedUrl) => {
                // Ensure image element is still attached to the DOM and target URL hasn't changed
                if (img.isConnected && img.dataset.src === targetSrc) {
                    // Local blob URLs must not enforce CORS check in Chromium WebViews
                    if (resolvedUrl && resolvedUrl.startsWith('blob:')) {
                        img.removeAttribute('crossorigin');
                    } else {
                        img.crossOrigin = 'anonymous';
                    }
                    img.src = resolvedUrl;
                }
            })
            .catch(() => {
                // Fallback to original URL so browser error handler can render initials
                if (img.isConnected && img.dataset.src === targetSrc) {
                    img.crossOrigin = 'anonymous';
                    img.src = targetSrc;
                }
            });
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
            // Ignore load events fired by the initial transparent 1x1 GIF placeholder
            if (img.src && img.src.startsWith('data:image/gif')) return;

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
            // Ignore error events fired while transitioning from placeholder
            if (img.src && img.src.startsWith('data:image/gif')) return;

            img.removeAttribute('data-lazy-loading');
            this._handleImageError(img);
        };

        // Assign image source (handles crossOrigin and custom headers resolution)
        this._assignImageSource(img, img.dataset.src);

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
        // Fast exit: if image is already cached or completed loading, skip BlurHash entirely
        if (img.classList.contains('loaded') || (img.complete && img.naturalWidth > 0)) {
            return;
        }

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

        // Defer BlurHash DCT computations while viewport scroll animations are active.
        // This ensures full CPU budget is dedicated to 60fps compositor transitions.
        if (this._isScrolling()) {
            return;
        }

        this._blurHashProcessing = true;

        const processBatch = () => {
            // Re-check scrolling state before each animation frame batch
            if (this._isScrolling()) {
                this._blurHashProcessing = false;
                return;
            }

            const batch = this._blurHashQueue.splice(0, this._maxBlurhashPerFrame);

            for (const { canvas, blurHashStr } of batch) {
                // Skip if canvas was detached or image has already arrived in the meantime
                if (!canvas || !canvas.isConnected || canvas.classList.contains('fade-out')) {
                    continue;
                }
                const parent = canvas.parentElement;
                if (parent && parent.querySelector('img.loaded')) {
                    continue;
                }

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

        // Hide chapter thumbnails completely if loading fails instead of injecting gradient fallback
        if (parent && parent.classList.contains('chapter-row__thumb-wrap')) {
            parent.classList.remove('skeleton-shimmer');
            parent.style.display = 'none';
            return;
        }

        const isSupportedParent =
            parent && (parent.classList.contains('card-image') || parent.classList.contains('queue-row__thumb-wrap'));

        if (isSupportedParent) {
            const mediaLayout = document.documentElement.getAttribute('data-layout-media-rows');
            const isModernOrExpanded =
                mediaLayout === 'modern' || mediaLayout === 'expanded' || mediaLayout === 'modern-posters';

            parent.classList.remove('skeleton-shimmer');

            const overlays = parent.querySelectorAll('.card-overlay-tint, .card-overlay-label, .blurhash-canvas');
            overlays.forEach((el) => el.remove());

            const gradNum = img.dataset.fbGrad;
            const initials = img.dataset.fbInit;
            const name = img.dataset.fbName;

            if (gradNum && initials && name && !parent.querySelector('.media-fallback')) {
                const hideInitials = img.dataset.fbHideInitials === 'true';
                const isLibrary =
                    parent.closest('.library-grid, .library-row, .library-content') !== null ||
                    parent.dataset?.contextType === 'library';
                const showName = isLibrary || hideInitials || !isModernOrExpanded;
                // dataset.* decodes the escaped attribute values back to raw
                // strings — escape again before insertAdjacentHTML.
                const fallbackHtml = `
                    <div class="media-fallback grad-${gradNum}">
                        ${!hideInitials ? `<div class="media-fallback-initials">${escapeHtml(initials)}</div>` : ''}
                        ${showName ? `<div class="media-fallback-name">${escapeHtml(name)}</div>` : ''}
                    </div>
                `;
                parent.insertAdjacentHTML('afterbegin', fallbackHtml);
            }
        }
    }

    /**
     * Forcibly load an image immediately, bypassing IntersectionObserver bounding box checks.
     * Required for GPU hardware-accelerated containers (`translate3d`) where older web engines
     * fail to intersect bounding rects reliably.
     * @param {HTMLElement} img - The image element to load
     * @param {boolean} [forceImmediate=false] - Retained for backward API compatibility
     */
    forceLoad(img, forceImmediate = false) {
        if (!img) return;

        // --------------------------------------------------------------------
        // DIRECT IMAGE PIPELINE
        // Hand off directly to image loader without artificial scroll holds.
        // --------------------------------------------------------------------
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

        // Locate parent media card container for sibling traversal
        const currentCard = startImg.closest('.media-card');
        if (!currentCard) return;

        // ----------------------------------------------------------------
        // STAGGERED PRELOAD: current row, previous row, then next row
        // ----------------------------------------------------------------
        // Reads the grid column count from a data attribute set by
        // LibraryPage._renderGrid(). Falls back to 5 if not present.
        //
        // Phase 1 (immediate, this frame):
        //   columns forward + 1 backward — covers Right in current row
        //   and one Left press. Cost: columns + 1.
        //
        // Phase 2 (next rAF, deferred):
        //   columns - 1 more backward — completes a full previous row
        //   so pressing Up lands on fully-preloaded items.
        //
        // Phase 3 (next rAF after Phase 2, chained):
        //   columns forward — covers the row below for Down navigation.
        // ----------------------------------------------------------------
        const grid = currentCard.closest('#library-grid');
        const columns = parseInt(grid?.dataset.gridColumns, 10) || 7;

        // Phase 1: current row forward + 1 backward (immediate)
        let nextCard = currentCard.nextElementSibling;
        let count = 0;
        while (nextCard && count < columns) {
            const img = nextCard.querySelector('img[data-src]');
            if (img) this._loadImage(img);
            nextCard = nextCard.nextElementSibling;
            count++;
        }

        const prevCard = currentCard.previousElementSibling;
        if (prevCard) {
            const img = prevCard.querySelector('img[data-src]');
            if (img) this._loadImage(img);
        }

        // Helper to load images from a starting sibling, up to `limit` cards
        const loadSiblings = (start, limit, backwards) => {
            let card = start;
            let count = 0;
            while (card && count < limit) {
                const img = card.querySelector('img[data-src]');
                if (img) this._loadImage(img);
                card = backwards ? card.previousElementSibling : card.nextElementSibling;
                count++;
            }
        };

        // Cancel any pending deferred preload from a previous focus change
        // so stale rAFs don't pile up (e.g. rapid D-pad holding).
        if (this._deferredPreloadFrameId) {
            cancelAnimationFrame(this._deferredPreloadFrameId);
            this._deferredPreloadFrameId = null;
        }

        // Schedule deferred phases (chained: Phase 2 -> Phase 3)
        const schedulePhase3 = () => {
            if (nextCard) {
                this._deferredPreloadFrameId = requestAnimationFrame(() => {
                    this._deferredPreloadFrameId = null;
                    loadSiblings(nextCard, columns, false);
                });
            }
        };

        if (prevCard) {
            // Phase 2: complete the previous row
            this._deferredPreloadFrameId = requestAnimationFrame(() => {
                this._deferredPreloadFrameId = null;
                loadSiblings(prevCard.previousElementSibling, columns - 1, true);
                // Chain: Phase 3 runs after Phase 2
                schedulePhase3();
            });
        } else {
            // No previous row, skip straight to Phase 3
            schedulePhase3();
        }
    }

    /**
     * Start observing images in a container
     * @param {HTMLElement} container - functionality scoped to this container
     */
    observe(container) {
        if (!container) return;

        const images = container.querySelectorAll('img[data-src]');

        /*
         * ====================================================================
         * ROW-ALIGNED EAGER INITIAL LOAD
         * ====================================================================
         * Read explicit column count directly from the grid container dataset,
         * or derive safe defaults based on layout class modifiers.
         *
         * Always calculate eager image load counts in complete row multiples.
         * Hardcoded values (e.g. 25 or 27) slice across mid-row boundaries on
         * 4, 5, 7, or 8 column layouts, causing visible half-row loading states.
         * ====================================================================
         */
        const gridCols =
            parseInt(container.dataset.gridColumns, 10) ||
            (container.classList.contains('view-small-poster')
                ? 8
                : container.classList.contains('view-thumb') || container.classList.contains('landscape-grid')
                  ? 4
                  : container.classList.contains('view-list')
                    ? 1
                    : 7);

        // Preload 4 full rows to saturate the initial viewport and forward scroll cushion
        const eagerRows = container.classList.contains('view-list') ? 15 : 4;
        const eagerLoadCount = gridCols * eagerRows;

        for (let i = 0; i < Math.min(images.length, eagerLoadCount); i++) {
            // Force immediate network/cache load for initial visible rows
            this.forceLoad(images[i], true);
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

        // Cancel any pending deferred preload for the next row
        if (this._deferredPreloadFrameId) {
            cancelAnimationFrame(this._deferredPreloadFrameId);
            this._deferredPreloadFrameId = null;
        }

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
