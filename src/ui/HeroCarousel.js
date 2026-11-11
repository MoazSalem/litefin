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
import { detailsIcons } from '../utils/Icons.js';
import { escapeHtml } from '../utils/Utils.js';
import { getMdbProviderInfo } from '../plugins/installed/mdblist-ratings/ratingsFormatter.js';
import { customHeaders } from '../utils/CustomHeaders.js';
import { pluginManager } from '../plugins/PluginManager.js';
import { idleGate } from '../utils/IdleGate.js';
import { imageCache } from '../utils/ImageCache.js';
import { markPerfOperation } from '../utils/PerfMarker.js';

const log = logger.create('HeroCarousel');

class HeroCarousel {
    constructor(options = {}) {
        // Filter out items lacking valid IDs to prevent broken image requests and routing errors
        this._items = (options.items || []).filter((item) => item && item.Id && item.Id !== '0');
        this._currentIndex = 0;
        this._timer = null;
        this._container = null;
        this._isFocused = false;
        const savedInterval = storage.getItem('pref:heroCarouselInterval');
        this._autoScrollInterval = savedInterval ? parseInt(savedInterval, 10) : 8000; // Default 8s
        this._hideTimeoutId = null;
        this._indicatorTimeoutId = null;
        this._indicatorRafId = null;

        // Viewport visibility and progressive preloading state tracking
        this._isVisible = true;
        this._intersectionObserver = null;
        this._preloadTimeoutId = null;
        this._preloadIdleId = null;

        // ---------------------------------------------------------------------
        // Idle preload & stacked layer bookkeeping
        // ---------------------------------------------------------------------
        // Stacked slides sit in the DOM at opacity: 0 with static GPU promotion
        // and no visibility:hidden churn, so goTo() strictly toggles .active
        // classes without triggering layerization or alpha-mask rasterization.
        // Backdrops/logos preload & decode asynchronously upfront for the stack.
        // ---------------------------------------------------------------------
        this._idlePreloadTask = null;
        this._preloadedSlides = Object.create(null);
        this._decodedAssets = Object.create(null);
        this._stackPreloadTimerId = null;

        // Cached DOM node references populated in init() and cleared in destroy()
        // so navigation never re-queries the carousel DOM tree on keypress frames.
        this._slideItems = null;
        this._dotItems = null;
        this._slideBackdrops = null;
        this._slideLogos = null;
        this._slideLogoContainers = null;

        // Cached storage preferences populated on first render/init to avoid
        // synchronous localStorage reads inside hot transition paths.
        this._carouselStyle = null;
        this._indicatorStyle = null;
        this._isCompact = null;
        this._isZoomEnabled = null;
        this._isAnimationEnabled = null;
        this._isBlurhashFill = null;

        // Bindings
        this._handleFocus = this._handleFocus.bind(this);
        this._handleBlur = this._handleBlur.bind(this);
    }

    /**
     * Reads and caches static hero carousel storage preferences once per
     * carousel instance so slide transitions avoid synchronous storage reads.
     *
     * @private
     */
    _loadCachedPrefs() {
        if (this._carouselStyle !== null) return;

        // Default carousel style is 'immersive-performance' for GPU compositing
        this._carouselStyle = storage.getItem('pref:heroCarouselStyle') || 'immersive-performance';
        this._indicatorStyle = storage.getItem('pref:heroCarouselIndicatorStyle') || 'dots';
        this._isCompact = storage.getItem('pref:heroCarouselCompact') !== 'false';
        this._isZoomEnabled = storage.getItem('pref:heroCarouselZoom') === 'true';
        this._isAnimationEnabled = storage.getItem('pref:heroCarouselIndicatorAnimation') !== 'false';
        // BlurHash ambient color fill is exclusive to Immersive (Performance) mode and disabled by default
        this._isBlurhashFill =
            this._carouselStyle === 'immersive-performance' &&
            storage.getItem('pref:heroCarouselBlurhashFill') === 'true';
    }

    /**
     * Render the carousel HTML structure
     */
    render() {
        if (!this._items || this._items.length === 0) return '';

        // Populate cached storage preferences once prior to rendering slides
        this._loadCachedPrefs();
        const carouselStyle = this._carouselStyle;
        const indicatorStyle = this._indicatorStyle;

        // Render slides and indicator elements
        const itemsHtml = this._items.map((item, index) => this._renderItem(item, index, carouselStyle)).join('');
        const dotsHtml = this._items
            .map(
                (_, index) =>
                    `<div class="hero-dot ${index === 0 ? 'active' : ''}" data-index="${index}"><div class="hero-dot-progress"></div></div>`
            )
            .join('');

        // Reuse cached layout configuration flags
        const isCompact = this._isCompact;
        const isZoomEnabled = this._isZoomEnabled;
        const isAnimationEnabled = this._isAnimationEnabled;
        const isBlurhashFill = this._isBlurhashFill;
        const intervalInSeconds = (this._autoScrollInterval / 1000).toFixed(1) + 's';

        let navArrowsHtml = '';
        // ---------------------------------------------------------------------
        // Interactive Carousel Navigation Arrows
        // ---------------------------------------------------------------------
        // Render navigation arrows across all platforms whenever multiple slides
        // exist. Arrows are styled with opacity: 0 and tabindex="-1" so they never
        // interfere with D-pad navigation, and smoothly reveal on mouse hover.
        // ---------------------------------------------------------------------
        if (this._items.length > 1) {
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
        // Use with-blurhash-fill to apply background ambient fill styling
        // Use no-indicator-animation to disable the progress bar fill
        // Use indicator-${indicatorStyle} to switch between lines, dots, or progress pills
        return `
            <div id="hero-carousel-container" 
                 class="hero-carousel-container ${carouselStyle} indicator-${indicatorStyle} ${isCompact ? 'compact' : ''} ${isZoomEnabled ? 'with-zoom' : ''} ${isBlurhashFill ? 'with-blurhash-fill' : ''} ${!isAnimationEnabled ? 'no-indicator-animation' : ''} focusable" 
                 style="--indicator-duration: ${intervalInSeconds}"
                 tabindex="0">
                <div class="hero-carousel">
                    <div class="hero-carousel-track">
                        ${itemsHtml}
                    </div>
                    ${
                        this._items.length > 1
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

        // Resolve backdrop tag and source item ID (supports both item and parent series backdrops)
        const backdropTag =
            item.BackdropImageTags && item.BackdropImageTags.length > 0
                ? item.BackdropImageTags[0]
                : item.ParentBackdropImageTags && item.ParentBackdropImageTags.length > 0
                  ? item.ParentBackdropImageTags[0]
                  : item.ImageTags?.Backdrop;

        // Fall back to parent backdrop ID when the child item lacks its own artwork
        const backdropItemId =
            item.BackdropImageTags && item.BackdropImageTags.length > 0
                ? item.Id
                : item.ParentBackdropItemId || item.Id;

        // Compile optimized backdrop URL with tag query for HTTP cache validation
        const backdropUrl = api.getImageUrl(backdropItemId, 'Backdrop', {
            maxWidth: params.maxWidth,
            quality: params.quality,
            tag: backdropTag
        });

        // Get Logo URL (prefer Logo, then ParentLogo)
        const logoTag = item.ImageTags?.Logo || item.ParentLogoImageTag;
        const logoItemId = item.ImageTags?.Logo ? item.Id : item.ParentLogoItemId || item.SeriesId;
        const useTextTitle = storage.getItem('pref:heroCarouselTextTitle') === 'true';

        let logoHtml = '';

        if (!useTextTitle && logoItemId && logoTag) {
            const logoParams = imageService.getParams('hero-logo');
            const isCompact = this._isCompact !== null ? this._isCompact : storage.getItem('pref:heroCarouselCompact') !== 'false';
            const dpr = window.devicePixelRatio || 1;
            const logoUrl = api.getImageUrl(logoItemId, 'Logo', {
                fillWidth: Math.round(400 * dpr),
                fillHeight: Math.round((isCompact ? 110 : 130) * dpr),
                quality: logoParams.quality,
                tag: logoTag
            });
            // -----------------------------------------------------------------
            // Progressive asset loading:
            // The active slide (index 0) loads its logo immediately via src.
            // Inactive slides store the URL in data-src to prevent the browser
            // from making 5-10 concurrent high-res image requests on mount.
            // -----------------------------------------------------------------
            const logoSrc = isActive ? `src="${logoUrl}"` : `data-src="${logoUrl}"`;
            logoHtml = `<div class="hero-logo-container"><img ${logoSrc} alt="" class="hero-logo"></div>`;
        } else {
            logoHtml = `<h1 class="hero-item-title">${escapeHtml(i18n.ensureBiDi(item.Name))}</h1>`;
        }

        // Meta Info Row
        const metaHtml = this._renderMetaHtml(item);

        // Resolve BlurHash for the hero backdrop and ambient fill background
        const blurHash = this._resolveBlurHash(item);
        // Ambient BlurHash fill is exclusive to the Immersive (Performance) style and off by default
        const isBlurhashFill =
            this._isBlurhashFill !== null
                ? this._isBlurhashFill
                : carouselStyle === 'immersive-performance' && storage.getItem('pref:heroCarouselBlurhashFill') === 'true';

        // ---------------------------------------------------------------------
        // Lazy Backdrop & BlurHash Texture Allocation
        // ---------------------------------------------------------------------
        // TV chipsets have limited GPU texture memory. If all 5-10 slides mount
        // with inline background-image, the browser decodes every full-screen
        // 1820px backdrop at once, starving the main thread during page load.
        // We set background-image exclusively for the active slide (index 0).
        // Inactive slides store the URL in data-backdrop and load just-in-time.
        // When reverse proxy headers are active, check native interception or cached Blob URL.
        // ---------------------------------------------------------------------
        const initialBackdrop = customHeaders?.hasCustomHeaders?.()
            ? (customHeaders.hasNativeInterception?.(backdropUrl) ? backdropUrl : customHeaders.getCachedBlobUrl(backdropUrl) || null)
            : backdropUrl;
        const backdropStyle = isActive && initialBackdrop ? ` style="background-image: url('${initialBackdrop}')"` : '';

        return `
            <div class="hero-item ${isActive ? 'active' : ''}" data-index="${index}">
                ${
                    isBlurhashFill && blurHash
                        ? `
                    <div class="hero-blurhash-fill-wrap">
                        <canvas class="hero-blurhash-fill-canvas" data-blurhash="${blurHash}"></canvas>
                        <div class="hero-blurhash-fill-vignette"></div>
                    </div>
                `
                        : ''
                }
                <div class="hero-backdrop" data-backdrop="${backdropUrl}"${backdropStyle}>
                    ${blurHash && isActive ? `<canvas class="hero-blurhash-canvas" data-blurhash="${blurHash}" style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; object-fit: cover; transition: opacity 500ms ease-out; z-index: 0; pointer-events: none; opacity: 1;"></canvas>` : ''}
                </div>
                <div class="hero-content">
                    ${logoHtml}
                    <div class="hero-meta-row">
                        ${metaHtml}
                    </div>
                    <div class="hero-description" tabindex="-1">${escapeHtml(i18n.ensureBiDi(item.Overview || ''))}</div>
                </div>
            </div>
        `;
    }

    /**
     * Builds the meta row (year, runtime, parental rating, scores) for a slide.
     * @param {Object} item - Hero item
     * @returns {string} HTML string
     * @private
     */
    _renderMetaHtml(item) {
        const year = item.ProductionYear || '';
        let runtimeText = '';
        if (item.RunTimeTicks) {
            const totalMinutes = Math.round(item.RunTimeTicks / 600000000);
            const hours = Math.floor(totalMinutes / 60);
            const minutes = totalMinutes % 60;
            runtimeText = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
        }

        // Ratings logic: Hide standard community score if MDBList ratings are available, but keep Parental Guide (OfficialRating).
        // Cached hero items keep their _mdbMetadata, so re-check the plugin and the hero preference at render time
        // in case either was turned off since the items were enriched.
        const mdbData = this._isMdbEnabled() ? item._mdbMetadata : null;
        const hasMdbRatings = mdbData && mdbData.ratings && mdbData.ratings.length > 0;
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
        if (mdbData && shouldShowScore(item)) {
            metaHtml += this._renderMdbMetadata(mdbData);
        }

        return metaHtml;
    }

    /**
     * Whether MDBList ratings should be shown on the hero (plugin enabled and hero preference on).
     * @returns {boolean}
     * @private
     */
    _isMdbEnabled() {
        return storage.getItem('pref:heroCarouselMdbList') !== 'false' && pluginManager.isEnabled('mdblist-ratings');
    }

    /**
     * Re-renders the meta rows in place, e.g. after MDBList ratings arrive
     * asynchronously once the plugin system finishes initializing.
     */
    refreshMeta() {
        if (!this._container) return;
        this._items.forEach((item, index) => {
            const row = this._container.querySelector(`.hero-item[data-index="${index}"] .hero-meta-row`);
            if (row) row.innerHTML = this._renderMetaHtml(item);
        });
    }

    /**
     * Renders MDBList Ratings and Awards for the carousel row.
     * @private
     */
    _renderMdbMetadata(data) {
        if (!data) return '';

        let html = '';
        const assetBase = `${api.serverUrl}/Plugins/MdbListRatings/Assets/`;
        const features = data.features || null;
        const settings = data.settings || null;

        // 1. Render Ratings
        if (data.ratings && data.ratings.length > 0) {
            for (const rating of data.ratings) {
                // Resolve normalized provider info and precision formatting
                const provider = getMdbProviderInfo(
                    rating.source || rating.Source,
                    rating.value !== undefined ? rating.value : rating.Value,
                    rating.score !== undefined ? rating.score : rating.Score,
                    features,
                    settings
                );

                // Skip if formatting failed or no display text
                if (!provider || !provider.formattedText) continue;

                if (provider.assetName) {
                    const iconUrl = `${assetBase}${provider.assetName}`;
                    // Include onerror fallback to hide broken image icon cleanly on older 10.xx servers
                    html += `
                        <div class="hero-mdb-item" title="${provider.displayName}: ${provider.formattedText}">
                            <img src="${iconUrl}" class="hero-mdb-icon" alt="${provider.displayName}" onerror="this.onerror=null;this.style.display='none';" />
                            <span class="hero-mdb-value">${provider.formattedText}</span>
                        </div>
                    `;
                } else {
                    html += `
                        <div class="hero-mdb-item" title="${provider.displayName}: ${provider.formattedText}">
                            <span class="hero-mdb-icon star-emoji">⭐</span>
                            <span class="hero-mdb-value">${provider.formattedText}</span>
                        </div>
                    `;
                }
            }
        }

        return html;
    }

    /**
     * Helper to get provider info for MDBList ratings (backward-compatible delegate).
     * @private
     */
    _getMdbProviderInfo(source, value, score = null) {
        return getMdbProviderInfo(source, value, score);
    }
    /**
     * Initialize the component after it's in the DOM
     */
    init(el) {
        this._container = el || document.getElementById('hero-carousel-container');
        if (!this._container) return;

        // Populate cached storage prefs and static slide DOM node arrays once
        // so navigation transitions run in O(1) without querying or parsing storage.
        this._loadCachedPrefs();
        this._slideItems = Array.prototype.slice.call(this._container.querySelectorAll('.hero-item'));
        this._dotItems = Array.prototype.slice.call(this._container.querySelectorAll('.hero-dot'));
        this._slideBackdrops = this._slideItems.map((slide) => slide.querySelector('.hero-backdrop'));
        this._slideLogos = this._slideItems.map((slide) => slide.querySelector('.hero-logo'));
        this._slideLogoContainers = this._slideLogos.map((img) =>
            img && typeof img.closest === 'function' ? img.closest('.hero-logo-container') : null
        );

        // Flag to prevent accidental detail navigation when completing a swipe gesture
        this._suppressItemClick = false;

        // Enter key handling via native click (FocusManager triggers .click())
        this._container.addEventListener('click', (e) => {
            // Suppress navigation if user just completed a swipe gesture
            if (this._suppressItemClick) return;
            // Ignore direct clicks on navigation arrows or indicator dots
            if (e.target.closest('.hero-arrow') || e.target.closest('.hero-dot')) return;
            this._onItemClick();
        });

        // ---------------------------------------------------------------------
        // Native Touch Swipe & Gesture Tracking (Mobile & Tablet Ergonomics)
        // ---------------------------------------------------------------------
        // Implements horizontal swipe physics for touchscreen devices.
        // Pauses auto-scroll on touch, computes horizontal delta, and triggers
        // next() or previous() based on swipe direction while cleanly preserving
        // vertical scrolling for browsing home content rows below.
        // ---------------------------------------------------------------------
        let touchStartX = 0;
        let touchStartY = 0;
        let touchStartTime = 0;
        let isSwipingHorizontal = false;
        let swipeDeltaX = 0;

        const onTouchStart = (e) => {
            const touch = e.touches ? e.touches[0] : e;
            touchStartX = touch.clientX;
            touchStartY = touch.clientY;
            touchStartTime = Date.now();
            isSwipingHorizontal = false;
            swipeDeltaX = 0;
            // Temporarily pause auto-scroll during user interaction
            this._stopAutoScroll();
        };

        const onTouchMove = (e) => {
            const touch = e.touches ? e.touches[0] : e;
            const diffX = touch.clientX - touchStartX;
            const diffY = touch.clientY - touchStartY;

            // Classify dominant axis once movement passes minimum threshold
            if (!isSwipingHorizontal && Math.abs(diffX) > 10) {
                if (Math.abs(diffX) > Math.abs(diffY)) {
                    isSwipingHorizontal = true;
                }
            }

            if (isSwipingHorizontal) {
                swipeDeltaX = diffX;
            }
        };

        const onTouchEnd = () => {
            if (isSwipingHorizontal) {
                const isRtl = document.documentElement.dir === 'rtl';
                const timeDiff = Date.now() - touchStartTime;
                const minDistance = 35; // 35px threshold for deliberate swipe
                const velocity = Math.abs(swipeDeltaX) / Math.max(1, timeDiff);

                if (Math.abs(swipeDeltaX) >= minDistance || velocity > 0.25) {
                    // Suppress click so we don't accidentally navigate to details
                    this._suppressItemClick = true;
                    setTimeout(() => {
                        this._suppressItemClick = false;
                    }, 350);

                    // Navigate according to swipe direction and RTL setting
                    const isNext = isRtl ? swipeDeltaX > 0 : swipeDeltaX < 0;
                    if (isNext) {
                        this.next();
                    } else {
                        this.previous();
                    }
                }
            } else {
                // Resume timer if user just tapped without swiping
                this._startAutoScroll();
            }

            isSwipingHorizontal = false;
            swipeDeltaX = 0;
        };

        const onTouchCancel = () => {
            isSwipingHorizontal = false;
            swipeDeltaX = 0;
            this._startAutoScroll();
        };

        this._touchHandlers = { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel };
        this._container.addEventListener('touchstart', onTouchStart, { passive: true });
        this._container.addEventListener('touchmove', onTouchMove, { passive: true });
        this._container.addEventListener('touchend', onTouchEnd, { passive: true });
        this._container.addEventListener('touchcancel', onTouchCancel, { passive: true });

        // Indicator dots direct tap handling
        const indicators = this._container.querySelector('.hero-indicators');
        if (indicators) {
            indicators.addEventListener('click', (e) => {
                const dot = e.target.closest('.hero-dot');
                if (dot && dot.dataset.index !== undefined) {
                    e.stopPropagation();
                    const targetIndex = parseInt(dot.dataset.index, 10);
                    if (!isNaN(targetIndex)) {
                        this.goTo(targetIndex);
                    }
                }
            });
        }

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

        // =========================================================================
        // Dynamic D-Pad Down Section Linker
        // =========================================================================
        // When focused on the hero carousel, pressing D-pad Down leaves the hero
        // section and enters the content rows below. In asynchronous and cached
        // environments, rows may finish rendering before, during, or after hero
        // initialization. Hardcoding leaveDown to null or a static ID causes focus
        // traps if the target is overwritten or unrendered.
        // This dynamic resolver evaluates the first live content row in real-time
        // when the down move is initiated, guaranteeing seamless bidirectional flow.
        // =========================================================================
        const dynamicLeaveDown = () => {
            // Respect any explicitly configured target if it is valid and registered
            const currentConfig = focusManager.getSectionConfig('home-hero');
            const explicit = currentConfig?.leaveDown;
            if (typeof explicit === 'string' && focusManager.getSectionConfig(explicit)) {
                return explicit;
            }
            if (typeof explicit === 'function' && explicit !== dynamicLeaveDown) {
                const result = explicit();
                if (result) return result;
            }

            const container = document.getElementById('home-rows');
            if (!container) return null;

            // Prioritize the topmost fully rendered (non-skeleton) content row
            const firstLive = container.querySelector('section[data-row-id]:not(.media-row--skeleton)');
            if (firstLive) {
                const rowId = firstLive.getAttribute('data-row-id');
                const sName = `home-row-${rowId}`;
                if (focusManager.getSectionConfig(sName)) return sName;
            }

            // Fallback: search all section elements with data-row-id in DOM order
            const allSections = container.querySelectorAll('section[data-row-id]');
            for (let i = 0; i < allSections.length; i++) {
                const rowId = allSections[i].getAttribute('data-row-id');
                const sName = `home-row-${rowId}`;
                if (focusManager.getSectionConfig(sName)) return sName;
            }

            return null;
        };

        // Register with focus manager with dynamic leaveDown resolution
        // Explicitly isolate selector to #hero-carousel-container so internal children
        // (such as dots, titles, or descriptions) are never targeted as separate focus stops
        focusManager.register('home-hero', this._container.parentElement, {
            orientation: 'horizontal',
            selector: '#hero-carousel-container',
            defaultFocusSelector: '#hero-carousel-container',
            onMove: (direction) => this._onMove(direction),
            leaveDown: dynamicLeaveDown,
            leaveLeft: 'sidebar'
        });

        // ---------------------------------------------------------------------
        // Seamless Focus Handover & Restoration
        // ---------------------------------------------------------------------
        // When the real hero carousel replaces the initial loading skeleton in
        // the DOM via innerHTML, any previous focus placed on the skeleton container
        // becomes detached from the document. We detect if the hero section was
        // the active section or if focus was orphaned/inside the placeholder, and
        // immediately re-bind focus to this newly rendered live carousel container.
        // ---------------------------------------------------------------------
        const currentActive = focusManager.getActiveSection();
        const currentFocused = focusManager.getFocused();
        const isFocusOrphaned =
            !currentFocused ||
            !document.contains(currentFocused) ||
            (this._container.parentElement && this._container.parentElement.contains(currentFocused));

        if (
            (currentActive === 'home-hero' || isFocusOrphaned || this._container.classList.contains('focused')) &&
            !focusManager.isTrapped()
        ) {
            focusManager.setActiveSection('home-hero', false);
            focusManager.focusElement(this._container, { instantScroll: true, skipScroll: true });
            this._handleFocus();
        }

        // ---------------------------------------------------------------------
        // Pointer & Mouse Click Navigation for Carousel Arrows
        // ---------------------------------------------------------------------
        // Binds previous and next slide transitions on mouse click events.
        // Works seamlessly across all platforms when buttons exist in the DOM.
        // ---------------------------------------------------------------------
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
        // Adjust only slides whose logo src is already eager (slide 0 on mount).
        // Deferred logos (slides 1..N) size themselves inside _preloadSlide().
        const isCompact = this._isCompact;
        for (let idx = 0; idx < this._slideLogos.length; idx++) {
            const img = this._slideLogos[idx];
            if (!img) continue;

            const logoContainer = this._slideLogoContainers[idx];
            const adjustHeight = () => {
                // Skip layout mutation until intrinsic dimensions are actually known
                if (!logoContainer || !img.naturalWidth || !img.naturalHeight) return;

                const aspect = img.naturalWidth / img.naturalHeight || 1;
                const maxW = 400; // max-width of .hero-logo in CSS
                const maxHeight = isCompact ? 110 : 130;
                const minHeight = isCompact ? 50 : 60;

                const targetHeight = maxW / aspect;
                const containerHeight = Math.min(maxHeight, Math.max(minHeight, Math.round(targetHeight)));
                const heightCss = `${containerHeight}px`;
                if (logoContainer.style.height !== heightCss) {
                    logoContainer.style.height = heightCss;
                }
            };

            if (img.complete && img.naturalWidth > 0) {
                adjustHeight();
            } else if (img.getAttribute('src')) {
                img.onload = adjustHeight;
            }
        }

        // ────────────────────────────────────────────────────────────────────
        // BlurHash Background Placeholders for Hero Carousel items
        // ────────────────────────────────────────────────────────────────────
        const canvases = this._container.querySelectorAll('.hero-blurhash-canvas');
        canvases.forEach((canvas) => {
            const hash = canvas.dataset.blurhash;
            if (!hash) return;

            // Resolve the parent backdrop element
            const heroBackdrop = canvas.closest('.hero-backdrop');
            if (!heroBackdrop) return;

            // Resolve the backdrop background-image URL
            const style = heroBackdrop.style.backgroundImage;
            const match = style.match(/url\(['"]?([^'"]+)['"]?\)/);
            const url = (match && match[1]) || heroBackdrop.dataset.backdrop;
            if (!url) return;

            // Decode blurhash at low resolution asynchronously, from an idle task.
            // Home boot also mounts many rows; decoding every hero canvas inline
            // would compete with the first D-pad navigation frame.
            idleGate.runWhenIdle(
                () => {
                    import('../utils/BlurHashDecoder.js')
                        .then(({ default: BlurHashDecoder }) => {
                            const pixels = BlurHashDecoder.decode(hash, 64, 36);
                            if (pixels && canvas && canvas.isConnected) {
                                canvas.width = 64;
                                canvas.height = 36;
                                const ctx = canvas.getContext('2d');
                                const imageData = ctx.createImageData(64, 36);
                                imageData.data.set(pixels);
                                ctx.putImageData(imageData, 0, 0);
                            }
                        })
                        .catch((err) => log.error('Failed to decode hero blurhash', err));
                },
                1200,
                0
            );

            // Track image load to cleanly fade out the blurhash canvas placeholder
            const img = new Image();
            img.onload = () => {
                requestAnimationFrame(() => {
                    canvas.style.opacity = '0';
                    setTimeout(() => {
                        if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
                    }, 500);
                });
            };
            img.onerror = () => {
                // If loading fails, remove canvas so it doesn't block underlying display
                if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
            };
            img.src = url;
        });

        // ────────────────────────────────────────────────────────────────────
        // Ambient BlurHash Background Color Fill for Active Slide
        // ────────────────────────────────────────────────────────────────────
        // Exclusive to the Immersive (Performance) style and disabled by default.
        // Extracts ambient colors from BlurHash to fill any empty canvas area.
        // ────────────────────────────────────────────────────────────────────
        if (this._isBlurhashFill) {
            const activeSlide = this._slideItems[this._currentIndex] || this._container.querySelector('.hero-item.active');
            if (activeSlide) {
                this._decodeBlurhashFill(activeSlide);
            }
        }

        // ---------------------------------------------------------------------
        // Viewport Visibility Observer (Off-screen CPU/GPU Suspension)
        // ---------------------------------------------------------------------
        // When the user scrolls down into content rows on the home page, the
        // carousel is no longer visible. Running background auto-scroll transitions
        // and crossfade animations off-screen steals CPU/GPU cycles and causes
        // frame drops during vertical row navigation. We suspend the timer when
        // off-screen and resume instantly when scrolled back into view.
        // ---------------------------------------------------------------------
        if ('IntersectionObserver' in window) {
            this._intersectionObserver = new IntersectionObserver(
                (entries) => {
                    for (let i = 0; i < entries.length; i++) {
                        const entry = entries[i];
                        const isVisible = entry.isIntersecting && entry.intersectionRatio > 0.15;
                        if (this._isVisible !== isVisible) {
                            this._isVisible = isVisible;
                            if (!isVisible) {
                                log.debug('Hero carousel off-screen; suspending timer');
                                this._stopAutoScroll();
                            } else if (!this._timer && !this._isFocused) {
                                log.debug('Hero carousel visible; resuming timer');
                                // Guard against triggering indicator progress animations or timer restarts mid-scroll
                                if (window.__scrollController && window.__scrollController.isAnimating) {
                                    if (!this._observerScrollFinishHandler) {
                                        this._observerScrollFinishHandler = () => {
                                            this._observerScrollFinishHandler = null;
                                            if (this._isVisible && !this._timer && !this._isFocused) {
                                                this._startAutoScroll();
                                            }
                                        };
                                        eventBus.once('scroll:finished', this._observerScrollFinishHandler);
                                    }
                                } else {
                                    this._startAutoScroll();
                                }
                            }
                        }
                    }
                },
                { threshold: [0, 0.15] }
            );
            this._intersectionObserver.observe(this._container);
        }

        // Slide 0 is guaranteed to be the visible slide, so its backdrop starts
        // loading immediately (mount path — no transition is in flight here).
        // This also triggers the authenticated blob fetch when custom reverse
        // proxy headers are configured (handled inside _preloadSlide).
        this._preloadSlide(0);

        // Pre-warm upcoming slides (up to the first 5 total slides) through
        // ImageCache's scroll-aware queue and gently decode stacked slides
        // ahead of user input so initial slide changes hit decoded layers.
        this._prewarmHeroImages();
        this._scheduleStackPreload(1);

        // ---------------------------------------------------------------------
        // Deferred Sliding Preload Window (for >5 slide configurations)
        // ---------------------------------------------------------------------
        this._scheduleIdlePreload(800);
    }

    /**
     * Staggers off-thread backdrop + logo decoding for stacked slides (indices
     * 1..4) one slide per short quiet interval so stacked slides are already
     * decoded and height-adjusted before the user transitions to them.
     *
     * @param {number} index - Slide index to schedule next
     * @private
     */
    _scheduleStackPreload(index) {
        if (!this._container) return;
        const maxStack = Math.min(5, this._slideItems ? this._slideItems.length : 0);
        if (index >= maxStack) return;

        if (this._stackPreloadTimerId) {
            clearTimeout(this._stackPreloadTimerId);
            this._stackPreloadTimerId = null;
        }

        // Wait one short frame window so init() paints cleanly before background
        // stacked slides kick off async decode and logo height measurement.
        this._stackPreloadTimerId = setTimeout(() => {
            this._stackPreloadTimerId = null;
            if (!this._container) return;

            // Pause staggered preloading while actively scrolling or fading a slide
            const isScrolling =
                typeof window !== 'undefined' && window.__scrollController && window.__scrollController.isAnimating;
            if (isScrolling || this._hideTimeoutId) {
                this._stackPreloadTimerId = setTimeout(() => this._scheduleStackPreload(index), 150);
                return;
            }

            this._preloadSlide(index);
            this._scheduleStackPreload(index + 1);
        }, 60);
    }

    /**
     * Queues up to the first 5 slides' backdrop and logo URLs into ImageCache
     * so bitmap fetching/decoding spreads gently over idle ticks instead of
     * stalling the first D-pad slide transitions.
     *
     * @private
     */
    _prewarmHeroImages() {
        if (!imageCache || typeof imageCache.preload !== 'function') return;

        const maxSlides = Math.min(5, this._slideItems ? this._slideItems.length : 0);
        if (maxSlides <= 1) return;

        // Deduplicate URLs across slides 1..4 (slide 0 already loads eagerly above).
        const urls = [];
        const seen = Object.create(null);
        const pushUrl = (url) => {
            if (!url || seen[url]) return;
            seen[url] = true;
            urls.push(url);
        };

        for (let i = 1; i < maxSlides; i++) {
            const backdrop = this._slideBackdrops ? this._slideBackdrops[i] : null;
            if (backdrop && backdrop.dataset && backdrop.dataset.backdrop) {
                pushUrl(backdrop.dataset.backdrop);
            }

            const logo = this._slideLogos ? this._slideLogos[i] : null;
            if (logo) {
                const logoUrl = (logo.dataset && logo.dataset.src) || logo.getAttribute('src');
                pushUrl(logoUrl);
            }
        }

        if (urls.length > 0) {
            imageCache.preload(urls);
        }
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
        if (this._hideTimeoutId) {
            clearTimeout(this._hideTimeoutId);
            this._hideTimeoutId = null;
        }
        if (this._preloadTimeoutId) {
            clearTimeout(this._preloadTimeoutId);
            this._preloadTimeoutId = null;
        }
        if (this._idlePreloadTask) {
            idleGate.cancel(this._idlePreloadTask);
            this._idlePreloadTask = null;
        }
        if (this._preloadIdleId && 'cancelIdleCallback' in window) {
            window.cancelIdleCallback(this._preloadIdleId);
            this._preloadIdleId = null;
        }
        // Cancel any staggered stacked-slide preload timer
        if (this._stackPreloadTimerId) {
            clearTimeout(this._stackPreloadTimerId);
            this._stackPreloadTimerId = null;
        }
        if (this._intersectionObserver) {
            this._intersectionObserver.disconnect();
            this._intersectionObserver = null;
        }
        if (this._observerScrollFinishHandler) {
            eventBus.off('scroll:finished', this._observerScrollFinishHandler);
            this._observerScrollFinishHandler = null;
        }
        if (this._scrollFinishHandler) {
            eventBus.off('scroll:finished', this._scrollFinishHandler);
            this._scrollFinishHandler = null;
        }
        if (this._onFocusChanged) {
            eventBus.off('focus:changed', this._onFocusChanged);
        }
        if (this._container && this._touchHandlers) {
            this._container.removeEventListener('touchstart', this._touchHandlers.onTouchStart);
            this._container.removeEventListener('touchmove', this._touchHandlers.onTouchMove);
            this._container.removeEventListener('touchend', this._touchHandlers.onTouchEnd);
            this._container.removeEventListener('touchcancel', this._touchHandlers.onTouchCancel);
            this._touchHandlers = null;
        }
        // Release cached DOM element references
        this._slideItems = null;
        this._dotItems = null;
        this._slideBackdrops = null;
        this._slideLogos = null;
        this._slideLogoContainers = null;
        this._container = null;
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
     * @param {Object} [options={}]
     * @param {boolean} [options.resetIndicator=true] - Whether to reset an already-active indicator dot
     * @private
     */
    _startAutoScroll(options = {}) {
        this._stopAutoScroll();
        if (this._items.length <= 1) return;

        // Bypassed if carousel is currently suspended off-screen
        if (this._isVisible === false) return;

        // Reset the visual progress bar to stay in sync with the JS timer ONLY
        // when restarting on an already-active dot (e.g. re-focusing carousel).
        // When goTo() just activated a brand-new dot, avoid stripping/re-adding
        // .active 40ms later since that triggers a duplicate width transition.
        const indicatorStyle =
            this._indicatorStyle !== null ? this._indicatorStyle : storage.getItem('pref:heroCarouselIndicatorStyle') || 'dots';
        const isAnimationEnabled =
            this._isAnimationEnabled !== null
                ? this._isAnimationEnabled
                : storage.getItem('pref:heroCarouselIndicatorAnimation') !== 'false';
        const shouldResetIndicator = options.resetIndicator !== false;
        if (indicatorStyle === 'progress' && isAnimationEnabled && shouldResetIndicator) {
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

        // Bypassed completely for static indicator styles (Lines and Dots)
        const indicatorStyle =
            this._indicatorStyle !== null ? this._indicatorStyle : storage.getItem('pref:heroCarouselIndicatorStyle') || 'dots';
        if (indicatorStyle !== 'progress') return;

        // Retrieve cached dot indicators (fallback query only if called pre-init)
        const dots = this._dotItems || this._container.querySelectorAll('.hero-dot');
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
     * Preload images for a specific slide by index
     * Loads backdrop and logo images so they're ready for display
     * @private
     */
    _preloadSlide(index) {
        const items = this._slideItems || this._container.querySelectorAll('.hero-item');
        const item = items[index];
        if (!item) return;

        // Deduplicate: a slide is only preloaded once. The idle sweep calls this
        // for every slide, and adjacent preloads used to re-create Image objects
        // every time because background-image is only applied asynchronously.
        if (this._preloadedSlides[index]) return;
        this._preloadedSlides[index] = true;

        // Track remaining async assets (backdrop and optional logo) so we can
        // record once both textures have decoded off the main transition path.
        let pendingAssets = 0;
        const markAssetReady = () => {
            pendingAssets--;
            if (pendingAssets <= 0) {
                this._decodedAssets[index] = true;
            }
        };

        // Preload backdrop image
        const backdrop = this._slideBackdrops ? this._slideBackdrops[index] : item.querySelector('.hero-backdrop');
        if (backdrop && backdrop.dataset.backdrop && !backdrop.style.backgroundImage) {
            pendingAssets++;
            const url = backdrop.dataset.backdrop;

            /*
             * Applies the loaded backdrop image to the hero element.
             * Fades out and discards the BlurHash canvas once the graphic settles.
             * Uses img.src or effectiveUrl so that fallback Blob URLs are correctly applied.
             */
            const applyBackdrop = (effectiveUrl) => {
                const img = new Image();

                // Applies the decoded bitmap to the slide's background layer.
                // Using img.decode() guarantees the pixels are ready before the
                // slide becomes visible, so the transition never paints a blank
                // backdrop or blocks on a synchronous decode.
                let applied = false;
                const commitBackdrop = () => {
                    if (applied) return;
                    applied = true;
                    if (!this._container || backdrop.dataset.backdrop !== url) return;

                    if (typeof markPerfOperation === 'function') markPerfOperation('HeroCarousel.commitBackdrop');
                    // Prefer resolved img.src to ensure fallback Blob URLs are utilized
                    const finalUrl = img.src || effectiveUrl;
                    backdrop.style.backgroundImage = `url('${finalUrl}')`;

                    // Fade out blurhash canvas once the high-res graphic settles
                    const canvas = item.querySelector('.hero-blurhash-canvas');
                    if (canvas) {
                        canvas.style.opacity = '0';
                        setTimeout(() => {
                            if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
                        }, 500);
                    }

                    markAssetReady();
                };

                // When image finishes downloading, attach to background-image
                img.onload = commitBackdrop;

                // Handle backdrop loading failure with authenticated JS fetch fallback
                img.onerror = () => {
                    if (customHeaders?.hasCustomHeaders?.() && (effectiveUrl === url || !img.src.startsWith('blob:'))) {
                        customHeaders
                            .resolveImageUrl(url, null, { bypassNative: true })
                            .then((blobUrl) => {
                                if (blobUrl && blobUrl !== url) {
                                    img.src = blobUrl;
                                } else {
                                    markAssetReady();
                                }
                            })
                            .catch(markAssetReady);
                    } else {
                        markAssetReady();
                    }
                };

                // Decode off the UI thread whenever supported before starting network fetch
                if ('decoding' in img) {
                    img.decoding = 'async';
                }

                // Trigger network load
                img.src = effectiveUrl;

                // Decode off the critical transition path. decode() resolves once
                // the bitmap is fully decoded and safe to paint.
                if (typeof img.decode === 'function') {
                    img.decode().then(commitBackdrop).catch(() => {});
                }
            };

            // Resolve via customHeaders if reverse proxy credentials are required
            if (customHeaders?.hasCustomHeaders?.()) {
                const cached = customHeaders.getCachedBlobUrl(url);
                if (cached) {
                    applyBackdrop(cached);
                } else {
                    customHeaders
                        .resolveImageUrl(url)
                        .then(applyBackdrop)
                        .catch(() => applyBackdrop(url));
                }
            } else {
                applyBackdrop(url);
            }
        }

        // Load logo image if deferred
        const logo = this._slideLogos ? this._slideLogos[index] : item.querySelector('.hero-logo');
        if (logo && logo.dataset.src && !logo.src) {
            pendingAssets++;
            const container =
                this._slideLogoContainers && this._slideLogoContainers[index]
                    ? this._slideLogoContainers[index]
                    : logo.closest('.hero-logo-container');

            // Recalculate natural aspect ratio container height once deferred logo loads
            const adjustLogoHeight = () => {
                if (container && logo.naturalWidth > 0 && logo.naturalHeight > 0) {
                    const aspect = logo.naturalWidth / logo.naturalHeight || 1;
                    const isCompact =
                        this._isCompact !== null ? this._isCompact : storage.getItem('pref:heroCarouselCompact') !== 'false';
                    const maxW = 400; // max-width of .hero-logo in CSS
                    const maxHeight = isCompact ? 110 : 130;
                    const minHeight = isCompact ? 50 : 60;

                    const targetHeight = maxW / aspect;
                    const containerHeight = Math.min(maxHeight, Math.max(minHeight, Math.round(targetHeight)));
                    const heightCss = `${containerHeight}px`;
                    if (container.style.height !== heightCss) {
                        container.style.height = heightCss;
                    }
                }
            };

            let logoDone = false;
            const finalizeLogo = () => {
                if (logoDone) return;
                logoDone = true;
                if (typeof markPerfOperation === 'function') markPerfOperation('HeroCarousel.finalizeLogo');
                adjustLogoHeight();
                markAssetReady();
            };

            /*
             * Applies the resolved logo source URL, decodes off-thread when available,
             * and adjusts container height once dimensions are ready.
             */
            const applyLogo = (effectiveUrl) => {
                if ('decoding' in logo) {
                    logo.decoding = 'async';
                }
                logo.onload = finalizeLogo;
                logo.src = effectiveUrl;
                if (typeof logo.decode === 'function') {
                    logo.decode().then(finalizeLogo).catch(() => {});
                } else if (logo.complete) {
                    finalizeLogo();
                }
            };

            // Fallback for logo images if native network request fails
            logo.onerror = () => {
                if (customHeaders?.hasCustomHeaders?.() && !logo.dataset.nativeFallbackTried) {
                    logo.dataset.nativeFallbackTried = 'true';
                    customHeaders
                        .resolveImageUrl(logo.dataset.src, null, { bypassNative: true })
                        .then((blobUrl) => {
                            if (blobUrl && blobUrl !== logo.dataset.src) {
                                logo.removeAttribute('crossorigin');
                                logo.src = blobUrl;
                            } else {
                                markAssetReady();
                            }
                        })
                        .catch(markAssetReady);
                } else {
                    markAssetReady();
                }
            };

            // Resolve via customHeaders if reverse proxy credentials are required
            if (customHeaders?.hasCustomHeaders?.()) {
                const cached = customHeaders.getCachedBlobUrl(logo.dataset.src);
                if (cached) {
                    applyLogo(cached);
                } else {
                    customHeaders
                        .resolveImageUrl(logo.dataset.src)
                        .then(applyLogo)
                        .catch(() => applyLogo(logo.dataset.src));
                }
            } else {
                applyLogo(logo.dataset.src);
            }
        }

        // Slide had no deferred backdrop/logo left to load — mark immediately decoded
        if (pendingAssets === 0) {
            this._decodedAssets[index] = true;
        }
    }

    /**
     * Schedules an idle preload sweep for slides around the active index.
     * Supports configurations beyond the initial 5 stacked preloads while
     * keeping goTo() strictly a class toggle.
     *
     * @param {number} [delay=800] - Quiet window required before the sweep runs
     * @private
     */
    _scheduleIdlePreload(delay = 800) {
        // Deduplicate: one pending sweep is enough, it covers the whole window.
        if (this._idlePreloadTask) return;
        if (!this._container || this._items.length === 0) return;

        this._idlePreloadTask = idleGate.runWhenIdle(() => {
            this._idlePreloadTask = null;
            if (!this._container) return;

            // Keep preloading & height adjustments off the active 1000ms CSS crossfade.
            if (this._hideTimeoutId) {
                this._scheduleIdlePreload(350);
                return;
            }

            if (typeof markPerfOperation === 'function') markPerfOperation('HeroCarousel.idlePreload');
            const count = this._items.length;
            const start = Math.max(0, this._currentIndex - 1);
            const end = Math.min(count - 1, this._currentIndex + 2);

            for (let i = start; i <= end; i++) {
                this._preloadSlide(i);
            }

            // Preload wrap-around neighbors when parked at boundary slides
            if (count > 2) {
                if (this._currentIndex === 0) {
                    this._preloadSlide(count - 1);
                } else if (this._currentIndex === count - 1) {
                    this._preloadSlide(0);
                }
            }

            // Ambient BlurHash fills are decoded here, outside any transition.
            const isBlurhashFill =
                this._isBlurhashFill !== null
                    ? this._isBlurhashFill
                    : (storage.getItem('pref:heroCarouselStyle') || 'immersive-performance') === 'immersive-performance' &&
                      storage.getItem('pref:heroCarouselBlurhashFill') === 'true';
            if (isBlurhashFill) {
                const slides = this._slideItems || this._container.querySelectorAll('.hero-item');
                for (let i = start; i <= end && i < slides.length; i++) {
                    this._decodeBlurhashFill(slides[i]);
                }
            }
        }, delay, 0);
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
        if (index === this._currentIndex || !this._container) return;

        if (typeof markPerfOperation === 'function') markPerfOperation('HeroCarousel.goTo');
        log.debug(`Navigating to hero item ${index}`);

        const items = this._slideItems || this._container.querySelectorAll('.hero-item');
        const dots = this._dotItems || this._container.querySelectorAll('.hero-dot');

        if (!items[index] || !dots[index]) return;

        const prevIndex = this._currentIndex;
        const prevItem = items[prevIndex];
        const nextItem = items[index];

        // Pure class toggle: slides stay pre-stacked at opacity:0 with static
        // CSS compositor promotion, so switching active classes triggers zero
        // visibility flips, mask re-rasterization, or GPU layer rebuilds.
        prevItem.classList.remove('active');
        dots[prevIndex].classList.remove('active');

        this._currentIndex = index;

        nextItem.classList.add('active');
        dots[this._currentIndex].classList.add('active');

        // Track active 1000ms crossfade window so idle BlurHash / preload sweeps wait.
        if (this._hideTimeoutId) clearTimeout(this._hideTimeoutId);
        this._hideTimeoutId = setTimeout(() => {
            this._hideTimeoutId = null;
        }, 1050);

        // Extend any sliding-window preload (>5 slides) / BlurHash fill past crossfade.
        this._scheduleIdlePreload(1200);

        // Restart timer on slide switch without stripping/re-adding .active on the
        // brand-new dot 40ms later, preventing a duplicate indicator width transition.
        this._startAutoScroll({ resetIndicator: false });
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

        // Clean up any pending deferred scroll listener
        if (this._scrollFinishHandler) {
            eventBus.off('scroll:finished', this._scrollFinishHandler);
            this._scrollFinishHandler = null;
        }

        // If an active vertical scroll animation is in flight (e.g. smooth scrolling from
        // the first content row up to the hero carousel), defer starting the auto-scroll timer
        // and restarting progress dot animations until the camera lands cleanly.
        if (window.__scrollController && window.__scrollController.isAnimating) {
            this._scrollFinishHandler = () => {
                this._scrollFinishHandler = null;
                if (this._isFocused && this._isVisible) {
                    this._startAutoScroll();
                }
            };
            eventBus.once('scroll:finished', this._scrollFinishHandler);
        } else {
            // Restart the timer AND resync the progress dot animation immediately if stationary
            this._startAutoScroll();
        }
    }

    /**
     * Handle blur — remove visual focus state AND pause the auto-scroll timer.
     *
     * Stopping the timer here means the carousel does NOT advance while the
     * user is navigating the sidebar or other rows. The dot progress bar
     * freezes in place. When focus returns, _handleFocus restarts everything
     * fresh from index 0 of the timer so the user always sees a full 8-second
     * cycle from whatever slide is currently shown.
    /**
     * Resolves the most suitable BlurHash string for a carousel item.
     * Evaluates backdrop blurhashes first (checking both direct item and
     * parent series hashes), and falls back to primary artwork hashes.
     *
     * @private
     * @param {Object} item - Media item from Jellyfin API
     * @returns {string} BlurHash string or empty string
     */
    _resolveBlurHash(item) {
        if (!item) return '';

        // Check if BlurHash decoding is globally disabled in user preferences
        const isBlurHashDisabled = storage.getItem('litefin:disableBlurhash') === 'true';
        if (isBlurHashDisabled) return '';

        // Check item backdrop blurhash
        if (item.ImageBlurHashes?.Backdrop) {
            const keys = Object.keys(item.ImageBlurHashes.Backdrop);
            if (keys.length > 0) return item.ImageBlurHashes.Backdrop[keys[0]];
        }

        // Check parent backdrop blurhash (e.g. for series / seasons)
        if (item.ParentImageBlurHashes?.Backdrop) {
            const keys = Object.keys(item.ParentImageBlurHashes.Backdrop);
            if (keys.length > 0) return item.ParentImageBlurHashes.Backdrop[keys[0]];
        }

        // Fall back to item primary blurhash
        if (item.ImageBlurHashes?.Primary) {
            const keys = Object.keys(item.ImageBlurHashes.Primary);
            if (keys.length > 0) return item.ImageBlurHashes.Primary[keys[0]];
        }

        // Fall back to parent primary blurhash
        if (item.ParentImageBlurHashes?.Primary) {
            const keys = Object.keys(item.ParentImageBlurHashes.Primary);
            if (keys.length > 0) return item.ParentImageBlurHashes.Primary[keys[0]];
        }

        return '';
    }

    /**
     * Decodes and renders the ambient BlurHash color fill background for a slide.
     * Extracts low-frequency ambient colors to fill any exposed canvas area
     * behind right-aligned or masked hero backdrop artwork.
     *
     * @private
     * @param {HTMLElement} itemElement - Hero slide container (.hero-item)
     */
    _decodeBlurhashFill(itemElement) {
        if (!itemElement) return;

        // Locate the blurhash fill canvas element within this slide
        const canvas = itemElement.querySelector('.hero-blurhash-fill-canvas');
        if (!canvas || canvas.dataset.decoded === 'true') return;

        const hash = canvas.dataset.blurhash;
        if (!hash) return;

        // Never decode during an active crossfade or scroll transition. Requeue
        // the work on the idle gate instead of burning the transition frame.
        if (
            this._hideTimeoutId ||
            (typeof window !== 'undefined' && window.__scrollController && window.__scrollController.isAnimating)
        ) {
            if (!canvas.dataset.decodeDeferred) {
                canvas.dataset.decodeDeferred = '1';
                idleGate.runWhenIdle(
                    () => {
                        if (canvas.dataset) delete canvas.dataset.decodeDeferred;
                        this._decodeBlurhashFill(itemElement);
                    },
                    600,
                    0
                );
            }
            return;
        }

        // Mark decoding initiated to avoid redundant decode passes
        canvas.dataset.decoded = 'true';

        // Load the BlurHash decoder module asynchronously
        import('../utils/BlurHashDecoder.js')
            .then(({ default: BlurHashDecoder }) => {
                // Decode at low resolution (32x18) for ultra-fast processing and negligible memory.
                // The browser's GPU bilinear texture scaling will stretch this across 4K smoothly.
                const width = 32;
                const height = 18;
                const pixels = BlurHashDecoder.decode(hash, width, height);

                if (pixels && canvas) {
                    canvas.width = width;
                    canvas.height = height;
                    const ctx = canvas.getContext('2d');
                    const imageData = ctx.createImageData(width, height);
                    imageData.data.set(pixels);
                    ctx.putImageData(imageData, 0, 0);

                    // Fade in smoothly once canvas buffer is committed
                    requestAnimationFrame(() => {
                        if (canvas) {
                            canvas.style.opacity = '1';
                        }
                    });
                }
            })
            .catch((err) => {
                log.error('Failed to decode hero carousel blurhash fill', err);
            });
    }

    _handleBlur() {
        this._isFocused = false;
        this._container.classList.remove('focused');

        // Cancel any pending deferred start from a scroll that was in flight
        if (this._scrollFinishHandler) {
            eventBus.off('scroll:finished', this._scrollFinishHandler);
            this._scrollFinishHandler = null;
        }

        // Pause the timer — don't advance slides while user is elsewhere
        this._stopAutoScroll();
    }
}

export default HeroCarousel;
