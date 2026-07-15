/**
 * ============================================================================
 * Litefin Tizen - Hero Carousel Component
 * ============================================================================
 * A premium auto-scrolling hero section for the HomePage.
 * Handles content rendering, state transitions, and TV focus management.
 * ============================================================================
 */

import { api } from '../api/index.js';
import { eventBus } from '../core/EventBus.js';
import { focusManager } from '../ui/FocusManager.js';
import { i18n } from '../utils/i18n.js';
import { logger } from '../utils/Logger.js';
import { router } from '../core/Router.js';
import { storage } from '../utils/StorageService.js';
import { imageService } from '../utils/ImageService.js';
import { shouldShowScore } from '../utils/visibility.js';
import { platformInfo } from '../utils/PlatformInfo.js';
import { detailsIcons } from '../utils/Icons.js';

const log = logger.create('HeroCarousel');

class HeroCarousel {
    constructor(options = {}) {
        this._items = options.items || [];
        this._currentIndex = 0;
        this._timer = null;
        this._container = null;
        this._isFocused = false;
        const savedInterval = storage.getItem('pref:heroCarouselInterval');
        this._autoScrollInterval = savedInterval ? parseInt(savedInterval, 10) : 8000; // Default 8s

        // Bindings
        this._handleFocus = this._handleFocus.bind(this);
        this._handleBlur = this._handleBlur.bind(this);
    }

    /**
     * Render the carousel HTML structure
     */
    render() {
        if (!this._items || this._items.length === 0) return '';

        // Default carousel style is set to 'immersive' for a premium tvOS-style design.
        const carouselStyle = storage.getItem('pref:heroCarouselStyle') || 'immersive';
        const itemsHtml = this._items.map((item, index) => this._renderItem(item, index, carouselStyle)).join('');
        const dotsHtml = this._items
            .map(
                (_, index) =>
                    `<div class="hero-dot ${index === 0 ? 'active' : ''}" data-index="${index}"><div class="hero-dot-progress"></div></div>`
            )
            .join('');

        const isCompact = storage.getItem('pref:heroCarouselCompact') !== 'false';
        const isZoomEnabled = storage.getItem('pref:heroCarouselZoom') === 'true';
        const isAnimationEnabled = storage.getItem('pref:heroCarouselIndicatorAnimation') !== 'false';
        const intervalInSeconds = (this._autoScrollInterval / 1000).toFixed(1) + 's';

        let navArrowsHtml = '';
        if ((platformInfo.isWeb || platformInfo.isWebOS) && this._items.length > 1) {
            navArrowsHtml = `
                <div class="hero-nav-arrows">
                    <button class="hero-arrow hero-arrow-left" aria-label="Previous" tabindex="-1">
                        <svg viewBox="0 0 24 24" width="36" height="36"><path fill="currentColor" d="M15.41 16.59L10.83 12l4.58-4.59L14 6l-6 6 6 6 1.41-1.41z"/></svg>
                    </button>
                    <button class="hero-arrow hero-arrow-right" aria-label="Next" tabindex="-1">
                        <svg viewBox="0 0 24 24" width="36" height="36"><path fill="currentColor" d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6-1.41-1.41z"/></svg>
                    </button>
                </div>
            `;
        }

        // Apply compact to the container to manage external margins (Banner Mode)
        // Use with-zoom to conditionally apply the focus transform
        // Use no-indicator-animation to disable the progress bar fill
        return `
            <div id="hero-carousel-container" 
                 class="hero-carousel-container ${carouselStyle} ${isCompact ? 'compact' : ''} ${isZoomEnabled ? 'with-zoom' : ''} ${!isAnimationEnabled ? 'no-indicator-animation' : ''} focusable" 
                 style="--indicator-duration: ${intervalInSeconds}"
                 tabindex="0">
                <div class="hero-carousel">
                    <div class="hero-carousel-track">
                        ${itemsHtml}
                    </div>
                    ${this._items.length > 1
                ? `
                    <div class="hero-indicators">
                        ${dotsHtml}
                    </div>
                    `
                : ''
            }
                </div>
                ${navArrowsHtml}
            </div>
        `;
    }

    /**
     * Render a single hero item
     * @private
     */
    _renderItem(item, index, carouselStyle) {
        const isActive = index === 0;

        // Get optimized image parameters from ImageService based on style
        const params = imageService.getParams(`hero-${carouselStyle}`);

        const backdropUrl = api.getImageUrl(item.Id, 'Backdrop', {
            maxWidth: params.maxWidth,
            quality: params.quality,
            tag: item.ImageTags?.Backdrop
        });

        // Get Logo URL (prefer Logo, then ParentLogo)
        const logoTag = item.ImageTags?.Logo || item.ParentLogoImageTag;
        const logoItemId = item.ImageTags?.Logo ? item.Id : item.ParentLogoItemId || item.SeriesId;
        const useTextTitle = storage.getItem('pref:heroCarouselTextTitle') === 'true';

        let logoHtml = '';

        if (!useTextTitle && logoItemId && logoTag) {
            const logoParams = imageService.getParams('hero-logo');
            const isCompact = storage.getItem('pref:heroCarouselCompact') !== 'false';
            const dpr = window.devicePixelRatio || 1;
            const logoUrl = api.getImageUrl(logoItemId, 'Logo', {
                fillWidth: Math.round(400 * dpr),
                fillHeight: Math.round((isCompact ? 110 : 130) * dpr),
                quality: logoParams.quality,
                tag: logoTag
            });
            logoHtml = `<div class="hero-logo-container"><img src="${logoUrl}" alt="" class="hero-logo"></div>`;
        } else {
            logoHtml = `<h1 class="hero-item-title">${i18n.ensureBiDi(item.Name)}</h1>`;
        }

        // Meta Info Row
        const year = item.ProductionYear || '';
        let runtimeText = '';
        if (item.RunTimeTicks) {
            const totalMinutes = Math.round(item.RunTimeTicks / 600000000);
            const hours = Math.floor(totalMinutes / 60);
            const minutes = totalMinutes % 60;
            runtimeText = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
        }

        // Ratings logic: Hide standard community score if MDBList ratings are available, but keep Parental Guide (OfficialRating)
        const hasMdbRatings = item._mdbMetadata && item._mdbMetadata.ratings && item._mdbMetadata.ratings.length > 0;
        const rating = item.OfficialRating;
        const starRating =
            !hasMdbRatings && item.CommunityRating && shouldShowScore(item)
                ? `${detailsIcons.ratingStar}${item.CommunityRating.toFixed(1)}`
                : '';

        let metaHtml = '';
        if (year) metaHtml += `<span class="hero-meta-item">${year}</span>`;
        if (runtimeText) metaHtml += `<span class="hero-meta-item">${runtimeText}</span>`;
        if (rating) metaHtml += `<span class="hero-meta-item hero-meta-badge">${rating}</span>`;
        if (starRating)
            metaHtml += `<span class="hero-meta-item hero-meta-star" style="color: #f5c518;">${starRating}</span>`;

        // Inject MDBList Metadata if present (Respect Score Visibility / Mystery Mode)
        if (item._mdbMetadata && shouldShowScore(item)) {
            metaHtml += this._renderMdbMetadata(item._mdbMetadata);
        }

        // Resolve BlurHash for the hero backdrop
        const isBlurHashDisabled = storage.getItem('litefin:disableBlurhash') === 'true';
        let blurHash = '';
        if (!isBlurHashDisabled && item.ImageBlurHashes?.Backdrop) {
            const keys = Object.keys(item.ImageBlurHashes.Backdrop);
            if (keys.length > 0) {
                blurHash = item.ImageBlurHashes.Backdrop[keys[0]];
            }
        }

        return `
            <div class="hero-item ${isActive ? 'active' : ''}" data-index="${index}">
                <div class="hero-backdrop" style="background-image: url('${backdropUrl}')">
                    ${blurHash ? `<canvas class="hero-blurhash-canvas" data-blurhash="${blurHash}" style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; object-fit: cover; transition: opacity 500ms ease-out; z-index: 0; pointer-events: none; opacity: 1;"></canvas>` : ''}
                </div>
                <div class="hero-content">
                    ${logoHtml}
                    <div class="hero-meta-row">
                        ${metaHtml}
                    </div>
                    <p class="hero-description">${i18n.ensureBiDi(item.Overview || '')}</p>
                </div>
            </div>
        `;
    }

    /**
     * Renders MDBList Ratings and Awards for the carousel row.
     * @private
     */
    _renderMdbMetadata(data) {
        if (!data) return '';

        let html = '';
        const assetBase = `${api.serverUrl}/Plugins/MdbListRatings/Assets/`;

        // 1. Render Ratings
        if (data.ratings && data.ratings.length > 0) {
            for (const rating of data.ratings) {
                if (rating.value === null || rating.value === undefined) continue;

                const provider = this._getMdbProviderInfo(rating.source, rating.value);
                const formattedValue = provider.format ? provider.format(rating.value) : rating.value;

                if (provider.assetName) {
                    const iconUrl = `${assetBase}${provider.assetName}`;
                    html += `
                        <div class="hero-mdb-item">
                            <img src="${iconUrl}" class="hero-mdb-icon" alt="" />
                            <span class="hero-mdb-value">${formattedValue}</span>
                        </div>
                    `;
                }
            }
        }

        return html;
    }

    /**
     * Helper to get provider info for MDBList ratings.
     * @private
     */
    _getMdbProviderInfo(source, value) {
        const s = source ? source.toLowerCase() : '';
        const score = parseFloat(value);

        if (s === 'imdb') {
            return { assetName: 'IMDb.png' };
        }
        if (s === 'tomatoes') {
            const assetName = score < 60 ? 'Rotten_Tomatoes_rotten.png' : 'Rotten_Tomatoes.png';
            return { assetName, format: (v) => `${v}%` };
        }
        if (s === 'tomatoesaudience' || s === 'popcorn') {
            const assetName =
                score < 60 ? 'Rotten_Tomatoes_negative_audience.png' : 'Rotten_Tomatoes_positive_audience.png';
            return { assetName, format: (v) => `${v}%` };
        }
        if (s === 'metacritic') {
            return { assetName: 'Metacritic.png' };
        }
        if (s === 'trakt') {
            return { assetName: 'Trakt.png', format: (v) => `${Math.round(v)}%` };
        }
        if (s === 'tmdb') {
            return {
                assetName: 'TMDB.png',
                format: (v) => {
                    const num = parseFloat(v);
                    return (num > 10 ? num / 10 : num).toFixed(1);
                }
            };
        }
        if (s === 'letterboxd') {
            return { assetName: 'letterboxd.png', format: (v) => parseFloat(v).toFixed(1) };
        }

        return { assetName: null };
    }
    /**
     * Initialize the component after it's in the DOM
     */
    init(el) {
        this._container = el || document.getElementById('hero-carousel-container');
        if (!this._container) return;

        // Enter key handling via native click (FocusManager triggers .click())
        this._container.addEventListener('click', () => this._onItemClick());

        // Focus and Blur handling via section change events
        // since native focus is disabled in FocusManager.
        this._onFocusChanged = (element) => {
            const isMe = element === this._container;
            if (isMe && !this._isFocused) {
                this._handleFocus();
            } else if (!isMe && this._isFocused) {
                this._handleBlur();
            }
        };
        eventBus.on('focus:changed', this._onFocusChanged);

        // Register with focus manager.
        focusManager.register('home-hero', this._container.parentElement, {
            orientation: 'horizontal',
            onMove: (direction) => this._onMove(direction),
            leaveDown: null, // Linked dynamically by HomePage
            leaveLeft: 'sidebar'
        });

        // Initial check if we are already focused (though unlikely during init)
        if (this._container.classList.contains('focused')) {
            this._handleFocus();
        }

        if (platformInfo.isWeb || platformInfo.isWebOS) {
            const leftBtn = this._container.querySelector('.hero-arrow-left');
            const rightBtn = this._container.querySelector('.hero-arrow-right');
            if (leftBtn && rightBtn) {
                leftBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.previous();
                });
                rightBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.next();
                });
            }
        }

        // Start auto-scroll
        this._startAutoScroll();

        // =========================================================================
        // Dynamic Visual Weight Adaptation for Hero Logos
        // =========================================================================
        // Calculate the natural aspect ratio of the loaded hero logo image.
        // Cap the height dynamically to keep the layout visually balanced:
        // - Tall/square logos get more height (up to 130px) to remain legible.
        // - Wide/short logos shrink in container height to eliminate vertical gaps.
        // =========================================================================
        const logos = this._container.querySelectorAll('.hero-logo');
        logos.forEach((img) => {
            const adjustHeight = () => {
                const container = img.closest('.hero-logo-container');
                if (container) {
                    const aspect = img.naturalWidth / img.naturalHeight || 1;
                    const isCompact = storage.getItem('pref:heroCarouselCompact') !== 'false';
                    const maxW = 400; // max-width of .hero-logo in CSS
                    const maxHeight = isCompact ? 110 : 130;
                    const minHeight = isCompact ? 50 : 60;

                    const targetHeight = maxW / aspect;
                    const containerHeight = Math.min(maxHeight, Math.max(minHeight, Math.round(targetHeight)));
                    container.style.height = `${containerHeight}px`;
                }
            };

            if (img.complete) {
                adjustHeight();
            } else {
                img.onload = adjustHeight;
            }
        });

        // ────────────────────────────────────────────────────────────────────
        // BlurHash Background Placeholders for Hero Carousel items
        // ────────────────────────────────────────────────────────────────────
        const canvases = this._container.querySelectorAll('.hero-blurhash-canvas');
        canvases.forEach((canvas) => {
            const hash = canvas.dataset.blurhash;
            if (!hash) return;

            // Resolve the backdrop background-image URL
            const parentHeroItem = canvas.closest('.hero-item');
            const heroBackdrop = parentHeroItem.querySelector('.hero-backdrop');

            const style = heroBackdrop.style.backgroundImage;
            const match = style.match(/url\(['"]?([^'"]+)['"]?\)/);
            if (match && match[1]) {
                const url = match[1];

                // Decode blurhash at low resolution asynchronously
                import('../utils/BlurHashDecoder.js')
                    .then(({ default: BlurHashDecoder }) => {
                        const pixels = BlurHashDecoder.decode(hash, 64, 36);
                        if (pixels && canvas) {
                            canvas.width = 64;
                            canvas.height = 36;
                            const ctx = canvas.getContext('2d');
                            const imageData = ctx.createImageData(64, 36);
                            imageData.data.set(pixels);
                            ctx.putImageData(imageData, 0, 0);
                        }
                    })
                    .catch((err) => log.error('Failed to decode hero blurhash', err));

                // Listen for backdrop image to finish preloading
                const img = new Image();
                img.onload = () => {
                    requestAnimationFrame(() => {
                        canvas.style.opacity = '0';
                        setTimeout(() => {
                            if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
                        }, 500);
                    });
                };
                img.src = url;
            }
        });
    }

    /**
     * Clean up resources
     */
    destroy() {
        // Pause timer
        this._stopAutoScroll();

        // Cancel any in-flight indicator animation frame or timeout
        if (this._indicatorRafId) {
            cancelAnimationFrame(this._indicatorRafId);
            this._indicatorRafId = null;
        }
        if (this._indicatorTimeoutId) {
            clearTimeout(this._indicatorTimeoutId);
            this._indicatorTimeoutId = null;
        }
        if (this._onFocusChanged) {
            eventBus.off('focus:changed', this._onFocusChanged);
        }
        focusManager.unregister('home-hero');
    }

    /**
     * Handle internal moves (switching slides)
     * @private
     */
    _onMove(direction) {
        const isRtl = document.documentElement.dir === 'rtl';

        // Map physical directions to logical navigation based on current layout
        const backDir = isRtl ? 'right' : 'left';
        const forwardDir = isRtl ? 'left' : 'right';

        if (direction === backDir) {
            if (this._currentIndex > 0) {
                this.previous();
                return true; // Handled internally
            }
            return false; // Leave towards sidebar (Left in LTR, Right in RTL)
        }

        if (direction === forwardDir) {
            this.next();
            return true; // Handled internally
        }

        return false; // Up/Down handles by FocusManager (leaveDown)
    }

    /**
     * Start the auto-scroll timer
     * @private
     */
    _startAutoScroll() {
        this._stopAutoScroll();
        if (this._items.length <= 1) return;

        // Reset the visual progress bar to stay in sync with the JS timer
        // if animations are enabled.
        const isAnimationEnabled = storage.getItem('pref:heroCarouselIndicatorAnimation') !== 'false';
        if (isAnimationEnabled) {
            this._resetIndicatorAnimation();
        }

        this._timer = setInterval(() => {
            this.next();
        }, this._autoScrollInterval);
    }

    /**
     * Stop the auto-scroll timer
     * @private
     */
    _stopAutoScroll() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
    }

    /**
     * Restart the CSS animation on the current dot.
     *
     * IMPORTANT: We must NOT use `void el.offsetWidth` to restart the
     * animation — that forces a synchronous layout reflow on the main
     * thread (50-150ms on Tizen) which blocks CSS transitions from
     * starting on the same frame. Instead we split remove → add across
     * two animation frames. The browser will commit the 'remove' paint
     * in frame N and the 'add' in frame N+1, giving CSS a clean state
     * transition without ever touching layout.
     * @private
     */
    _resetIndicatorAnimation() {
        if (!this._container) return;

        // Retrieve all dot indicators
        const dots = this._container.querySelectorAll('.hero-dot');
        const currentDot = dots[this._currentIndex];
        if (!currentDot) return;

        // --------------------------------------------------------------------
        // Cleanup existing timers or animation frames to prevent double-firing
        // --------------------------------------------------------------------
        if (this._indicatorRafId) {
            cancelAnimationFrame(this._indicatorRafId);
            this._indicatorRafId = null;
        }
        if (this._indicatorTimeoutId) {
            clearTimeout(this._indicatorTimeoutId);
            this._indicatorTimeoutId = null;
        }

        // --------------------------------------------------------------------
        // Stop current animation immediately by removing the active class
        // --------------------------------------------------------------------
        currentDot.classList.remove('active');

        // --------------------------------------------------------------------
        // Re-add the class on a macro-task boundary (setTimeout) instead of
        // requestAnimationFrame. On Tizen/TV WebKit platforms, if the element
        // is off-screen or during scrolling, requestAnimationFrame can be
        // coalesced or skipped, leaving the progress bar stuck at width 0.
        // A short setTimeout guarantees the browser registers the removal.
        // --------------------------------------------------------------------
        this._indicatorTimeoutId = setTimeout(() => {
            this._indicatorTimeoutId = null;
            currentDot.classList.add('active');
        }, 40); // 40ms is a safe window (~2-3 frames) to ensure rendering pipeline updates
    }

    /**
     * Go to the next item
     */
    next() {
        const nextIndex = (this._currentIndex + 1) % this._items.length;
        this.goTo(nextIndex);
    }

    /**
     * Go to the previous item
     */
    previous() {
        const nextIndex = (this._currentIndex - 1 + this._items.length) % this._items.length;
        this.goTo(nextIndex);
    }

    /**
     * Navigate to a specific item
     */
    goTo(index) {
        if (index === this._currentIndex) return;

        log.debug(`Navigating to hero item ${index}`);

        const items = this._container.querySelectorAll('.hero-item');
        const dots = this._container.querySelectorAll('.hero-dot');

        if (!items[index] || !dots[index]) return;

        // Update classes
        items[this._currentIndex].classList.remove('active');
        dots[this._currentIndex].classList.remove('active');

        this._currentIndex = index;

        items[this._currentIndex].classList.add('active');
        dots[this._currentIndex].classList.add('active');

        // Restart timer on navigation. This will also restart the progress
        // animation if it is enabled.
        this._startAutoScroll();
    }

    /**
     * Handle item click (Navigate to details)
     * @private
     */
    _onItemClick() {
        const item = this._items[this._currentIndex];
        if (item) {
            router.navigate(`/details/${item.Id}`);
        }
    }

    /**
     * Handle focus — restart auto-scroll and indicator animation
     * so the progress bar stays in sync with the JS timer.
     * @private
     */
    _handleFocus() {
        this._isFocused = true;
        this._container.classList.add('focused');
        // Restart the timer AND resync the progress dot animation
        this._startAutoScroll();
    }

    /**
     * Handle blur — remove visual focus state AND pause the auto-scroll timer.
     *
     * Stopping the timer here means the carousel does NOT advance while the
     * user is navigating the sidebar or other rows. The dot progress bar
     * freezes in place. When focus returns, _handleFocus restarts everything
     * fresh from index 0 of the timer so the user always sees a full 8-second
     * cycle from whatever slide is currently shown.
     * @private
     */
    _handleBlur() {
        this._isFocused = false;
        this._container.classList.remove('focused');
        // Pause the timer — don't advance slides while user is elsewhere
        this._stopAutoScroll();
    }
}

export default HeroCarousel;
