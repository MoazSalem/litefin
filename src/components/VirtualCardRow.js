import { lazyLoader } from '../utils/LazyLoader.js';
import { focusManager } from '../ui/FocusManager.js';
import { eventBus } from '../core/EventBus.js';
import { platformInfo } from '../utils/PlatformInfo.js';
import { storage } from '../utils/StorageService.js';

export class VirtualCardRow {
    /**
     * @param {HTMLElement} trackContainer - The `.row-items-track` wrapper element
     * @param {Array} items - Array of data items to render
     * @param {Object} options - Configuration for rendering options
     * @param {number} [options.visibleCount=10] - Number of items to render simultaneously in the sliding window
     * @param {number|null} [options.initialWindow=null] - If set, ALL items up to this count are rendered eagerly
     *   on construction so the row is fully ready before the user scrolls to it.
     *   After the first interactive navigation, _updateWindow trims back to the normal sliding window.
     *   Pass `items.length` to pre-render everything.
     * @param {boolean} [options.isLandscape=false] - If items use the landscape (wider) layout
     * @param {Function} options.renderCard - Callback returning HTML string for an item
     */
    constructor(trackContainer, items, options = {}) {
        this.track = trackContainer;
        this.items = items;

        this.visibleCount = options.visibleCount || 10;

        // Optional: pre-render a larger initial window to avoid on-demand DOM creation
        // lag when the user first scrolls into this row. Resets to the normal sliding
        // window on the first interactive _updateWindow call.
        this._initialWindow = options.initialWindow != null ? options.initialWindow : null;
        this._initialRenderDone = false; // Tracks whether the eager boot render has fired
        this.isLandscape = options.isLandscape || false;
        this.cardType = options.cardType || 'poster';
        this.hideLabels = options.hideLabels || false;
        this.focusSectionId = options.focusSectionId;
        this.renderCard = options.renderCard;

        // Static CSS measurements from home.css
        // Landscape width: 400px, Portrait width: 240px, Margin-right: 24px
        // Modern / Modern Posters: 212px poster / 396px landscape / 223px square (26px margin)
        // Modern Cards (Expanded): 396px widescreen / 223px square (26px margin)
        // Expanding Posters: 175.5px poster -> 468px expanded (31px margin)
        const mediaLayout = document.documentElement.getAttribute('data-layout-media-rows');
        const isModern = mediaLayout === 'modern';
        const isExpanded = mediaLayout === 'expanded';
        const isModernPosters = mediaLayout === 'modern-posters';
        const isExpanding = mediaLayout === 'expanding';
        this.isModern = isModern;
        this.isExpanded = isExpanded;
        this.isModernPosters = isModernPosters;
        this.isExpanding = isExpanding;

        // Determine user-configured scale multiplier based on active layout
        const scale = isExpanded
            ? parseFloat(storage.getItem('pref:expandedCardSizeScale')) || 1.2
            : isModernPosters
                ? parseFloat(storage.getItem('pref:modernPostersCardSizeScale')) || 1.2
                : isModern
                    ? parseFloat(storage.getItem('pref:modernCardSizeScale')) || 1.2
                    : isExpanding
                        ? parseFloat(storage.getItem('pref:expandingCardSizeScale')) || 1.0
                        : parseFloat(storage.getItem('pref:classicCardSizeScale')) || 1.0;

        if (isExpanded) {
            this.modernMultiplier = scale;

            // =================================================================
            // Modern Cards (Expanded): Uniform 16:9 Widescreen Cards (396px base)
            // =================================================================
            if (this.cardType === 'square' || this.cardType === 'artist' || (isExpanded && this.cardType === 'person')) {
                this.itemWidth = Math.round(223 * scale);
            } else {
                this.itemWidth = Math.round(396 * scale);
            }
            this.itemMargin = Math.round(26 * scale);
            this.sidePadding = 60;

            // Inject CSS custom properties on the track container
            this.track.style.setProperty('--card-width', `${Math.round(396 * scale)}px`);
            this.track.style.setProperty('--card-height', `${Math.round(222.75 * scale)}px`);
            this.track.style.setProperty('--card-margin', `${this.itemMargin}px`);
            this.track.style.setProperty('--card-expanded-width', `${Math.round(396 * scale)}px`);
            this.track.style.setProperty('--card-square-width', `${Math.round(223 * scale)}px`);
            this.track.style.setProperty('--card-expansion', '0px');
        } else if (isModern || isModernPosters) {
            // =================================================================
            // Modern & Modern Posters Layout (Ultra-Lightweight Static Cards)
            // =================================================================
            // - Modern: Portrait posters for movie/series, 16:9 landscape cards
            //   for next up/continue watching/my media, squares for music/artists.
            // - Modern Posters: Portrait posters everywhere except my media & square.
            // =================================================================
            if (this.cardType === 'square' || this.cardType === 'artist') {
                this.itemWidth = Math.round(223 * scale);
                this.itemMargin = Math.round(26 * scale);
            } else if (this.isLandscape) {
                this.itemWidth = Math.round(396 * scale);
                this.itemMargin = Math.round(26 * scale);
            } else {
                this.itemWidth = Math.round(212 * scale);
                this.itemMargin = Math.round(26 * scale);
            }
            this.sidePadding = 60;

            // Inject CSS custom properties on the track container
            this.track.style.setProperty('--card-width', `${Math.round(212 * scale)}px`);
            this.track.style.setProperty('--card-height', `${Math.round(318 * scale)}px`);
            this.track.style.setProperty('--card-margin', `${this.itemMargin}px`);
            this.track.style.setProperty('--card-expanded-width', `${Math.round(396 * scale)}px`);
            this.track.style.setProperty('--card-landscape-width', `${Math.round(396 * scale)}px`);
            this.track.style.setProperty('--card-landscape-height', `${Math.round(222.75 * scale)}px`);
            this.track.style.setProperty('--card-square-width', `${Math.round(223 * scale)}px`);
            this.track.style.setProperty('--card-square-height', `${Math.round(223 * scale)}px`);
            this.track.style.setProperty('--card-expansion', '0px');
        } else if (isExpanding) {
            // =================================================================
            // Expanding Posters Mode (Dynamic Focus Expansion & Shifting)
            // =================================================================
            this.modernMultiplier = scale;

            // Target Height: 468px * 56.25% (16:9) = 263.25px (* scale)
            if (this.isLandscape) {
                this.itemWidth = Math.round(468 * scale);
            } else if (this.cardType === 'square' || this.cardType === 'artist') {
                this.itemWidth = Math.round(264 * scale); // 264px height
            } else {
                this.itemWidth = Math.round(175.5 * scale); // 175.5px * 150% = 263.25px height
            }
            this.itemMargin = Math.round(31 * scale);
            this.sidePadding = 60;

            // Inject CSS custom properties on the track container to update card styles dynamically
            this.track.style.setProperty('--card-width', `${Math.round(175.5 * scale)}px`);
            this.track.style.setProperty('--card-height', `${Math.round(263.25 * scale)}px`);
            this.track.style.setProperty('--card-margin', `${this.itemMargin}px`);
            this.track.style.setProperty('--card-expanded-width', `${Math.round(468 * scale)}px`);
            this.track.style.setProperty('--card-square-width', `${Math.round(264 * scale)}px`);
            this.track.style.setProperty('--card-expansion', `${Math.round(292.5 * scale)}px`);
        } else {
            this.itemWidth = Math.round((this.isLandscape ? 400 : 240) * scale);
            this.itemMargin = Math.round(24 * scale);
            this.sidePadding = 60;
        }

        this.totalItemWidth = this.itemWidth + this.itemMargin;

        this.totalItems = this.items.length;

        // Set the total width of the track to simulate all items existing
        // Add sidePadding on left and right from layout.css
        const totalWidth = this.totalItems * this.totalItemWidth + this.sidePadding * 2;
        this.track.style.width = `${totalWidth}px`;
        // Ensure track is relative for absolute positioned children
        this.track.style.position = 'relative';
        this.track.style.display = 'block'; // Inline-flex breaks absolute positioning inside
        this.track.innerHTML = '';

        // Link the instance to the DOM element so ScrollController can access computationally
        // derived layout values instead of forcing synchronous layout flushes.
        this.track.__virtualRow = this;

        // Expanding: Handle Poster-to-Landscape Expansion logic
        let loadExpansionThumb;
        if (isExpanding) {
            // Add a buffer for the expanded card width (375px) so the track doesn't clip.
            // Symmetrical spacing keeps the row scroll boundaries aligned cleanly.
            const expansion =
                this.isLandscape || this.cardType === 'square' || this.cardType === 'artist'
                    ? 0
                    : 375 * (this.modernMultiplier || 1.0);
            this.track.style.width = `${totalWidth + expansion}px`;

            /**
             * Helper function to lazy-load the expansion thumb image (the backdrop).
             * Prepares the image tags and triggers the CSS transition classes once loaded.
             *
             * @param {HTMLElement} card - The .media-card element that is expanding.
             */
            loadExpansionThumb = (card) => {
                // Safely grab references to the lazy backdrop layer inside the card structure.
                const thumb = card.querySelector('.thumb-layer');
                const thumbSrc = thumb ? thumb.getAttribute('data-thumb-src') : null;

                // If a valid image element and source exists:
                if (thumb && thumbSrc) {
                    if (!thumb.getAttribute('src')) {
                        // Set src to kick off the browser's asynchronous download.
                        thumb.setAttribute('src', thumbSrc);

                        // On successful download, mark the card and image layers as ready.
                        // This triggers the CSS-driven transitions (e.g. thumb fades in).
                        thumb.onload = () => {
                            thumb.classList.add('loaded');
                            card.classList.add('expansion-ready');
                        };

                        // Graceful degradation in case of network drops or bad URLs.
                        thumb.onerror = () => {
                            thumb.classList.add('load-failed');
                            card.classList.remove('expansion-ready');
                        };
                    }

                    // If the browser already resolved or cached the asset synchronously:
                    if (thumb.complete && thumb.naturalWidth > 0) {
                        thumb.classList.add('loaded');
                        card.classList.add('expansion-ready');
                    }
                } else if (!thumb) {
                    // ---------------------------------------------------------
                    // GRADIENT FALLBACK EXPANSION DISPATCHER
                    // ---------------------------------------------------------
                    // If this card does not have an image layer (meaning it is
                    // using the premium gradient fallback with initials), it
                    // has no assets to lazy-fetch! We immediately mark it as
                    // 'expansion-ready' so the expand transforms and inside
                    // metadata overlays can fade in on focus/hover.
                    // ---------------------------------------------------------
                    card.classList.add('expansion-ready');
                }
            };

            /**
             * Focus entrypoint for focus-bound layout shifting.
             * Triggered when the card receives focus (via remote D-pad or mouse action).
             *
             * @param {HTMLElement} element - The target focused element or sub-component.
             */
            const handleFocus = (element) => {
                // Find the closest media-card ancestor within this row
                const card = element.closest('.media-card');

                // Ensure the card exists and belongs strictly to this row track
                if (card && this.track.contains(card)) {
                    // Extract the mathematical virtual index from the dataset
                    const index = parseInt(card.dataset.virtualIndex);

                    // Shift sibling cards relative to this card's expansion state.
                    // Marks expanding index inside the CSS custom property.
                    const isCardExpanding = card.classList.contains('has-expansion');

                    // Apply focused index to track custom properties for modern styling layout shifts
                    if (isCardExpanding) {
                        this.track.style.setProperty('--focused-index', index);
                    } else {
                        this.track.style.setProperty('--focused-index', -1);
                    }

                    // Trigger asynchronous image preloading for the expanding backdrop
                    loadExpansionThumb(card);

                    // =========================================================
                    // 🚀 ACTIVE SLIDING WINDOW BACKDROP PRELOADING
                    // =========================================================
                    // To keep navigation feeling lightning fast and premium ,
                    // we pre-fetch the next card's backdrop while focused on card N.
                    // This creates a 1-item ahead sliding buffer, so the subsequent
                    // expansion backdrop is completely ready before focus lands on it.
                    // =========================================================
                    const nextCard = this.domNodes.get(index + 1);

                    // If the next card is rendered and in the DOM, preload its asset
                    if (nextCard) {
                        loadExpansionThumb(nextCard);
                    }
                }
            };

            // Listen for global focus changes from FocusManager (native focus is disabled on Tizen)
            // Ensures our spatial navigator correctly updates states in sync.
            //
            // PERFORMANCE: Gate the callback with track.contains() FIRST so that
            // only the row that actually owns the focused element does any DOM
            // traversal or CSS property writes.
            this._focusUnsubscribe = eventBus.on('focus:changed', (element) => {
                if (this.track.contains(element)) {
                    handleFocus(element);
                } else {
                    // Focus left this row — reset expansion state, but only if
                    // it was active (avoid redundant CSS property write + recalc)
                    if (this.track.style.getPropertyValue('--focused-index') !== '-1') {
                        this.track.style.setProperty('--focused-index', -1);
                    }
                }
            });

            // Native focus/mouse listeners.
            this.track.addEventListener('focusin', (e) => handleFocus(e.target));
            this.track.addEventListener('mousedown', (e) => handleFocus(e.target));

            // Mouseover hover listener:
            this.track.addEventListener('mouseover', (e) => {
                const card = e.target.closest('.media-card');
                if (card && this.track.contains(card)) {
                    loadExpansionThumb(card);
                }
            });

            // Focusout listener to reset sibling translation shifts.
            this.track.addEventListener('focusout', (e) => {
                if (!e.relatedTarget || !this.track.contains(e.relatedTarget)) {
                    if (this.track.style.getPropertyValue('--focused-index') !== '-1') {
                        this.track.style.setProperty('--focused-index', -1);
                    }
                }
            });
        }

        // Inject a hidden dummy element to natively expand the track's height.
        // Since absolute children collapse the parent, this static element prevents
        // the 3px height bug without needing hardcoded pixel guessing.
        // We use a zero-width block to avoid interfering with horizontal (RTL) layout.
        if (this.totalItems > 0) {
            const dummyDiv = document.createElement('div');
            dummyDiv.style.width = '0';
            dummyDiv.style.height = 'auto';
            dummyDiv.style.display = 'block';
            dummyDiv.style.position = 'static';
            dummyDiv.style.visibility = 'hidden';
            dummyDiv.style.pointerEvents = 'none';
            dummyDiv.style.overflow = 'visible';

            const dummyContent = document.createElement('div');
            dummyContent.style.width = `${this.itemWidth}px`;
            dummyContent.style.display = 'block';

            if (!isModern && !isExpanded && !isModernPosters && !isExpanding) {
                // =============================================================
                // Classic Layout: Restored Native Dimensions & Dummy Metrics
                // =============================================================
                // Fully separate Classic calculations with authentic values.
                // 3px transparent border, 12px 4px 0 4px info padding,
                // and font-scaled line-box expansion for title and subtitle.
                // =============================================================
                dummyContent.style.border = '3px solid transparent';

                // Emulate .card-image
                const imageRatioDiv = document.createElement('div');
                imageRatioDiv.style.width = '100%';
                imageRatioDiv.style.height = '0';
                imageRatioDiv.style.paddingBottom = this.isLandscape
                    ? '56.25%'
                    : this.cardType === 'square' || this.cardType === 'artist'
                        ? '100%'
                        : '150%';
                imageRatioDiv.style.border = '3px solid transparent';
                dummyContent.appendChild(imageRatioDiv);

                // Emulate .card-info
                if (!this.hideLabels) {
                    const infoDiv = document.createElement('div');
                    infoDiv.style.padding = '12px 4px 0 4px';
                    // font-size with CSS custom property ensures line-box height scales correctly
                    infoDiv.innerHTML = `<div style="font-size: calc(1.2rem * var(--card-title-font-scale, 1)); font-weight: 600; line-height: 1.35; margin: 0;">&nbsp;</div><div style="font-size: calc(1rem * var(--card-title-font-scale, 1)); line-height: 1.35; margin-top: 6px;">&nbsp;</div>`;
                    dummyContent.appendChild(infoDiv);
                }
            } else {
                // =============================================================
                // Modern, Expanded, Modern Posters & Expanding Dummy
                // =============================================================
                dummyContent.style.border = '4px solid transparent';

                // Emulate .card-image
                const imageRatioDiv = document.createElement('div');
                imageRatioDiv.style.width = '100%';
                imageRatioDiv.style.height = '0';
                let padding = '150%'; // Classic & Modern Portrait Poster (2:3)
                if (this.cardType === 'square' || this.cardType === 'artist' || ((isExpanded || isModernPosters) && this.cardType === 'person')) {
                    // Square / Artist / Person icon: 1:1 aspect ratio
                    padding = '100%';
                } else if (this.isLandscape || isExpanded) {
                    // Landscape or Expanded Poster: 16:9 widescreen
                    padding = '56.25%';
                }
                imageRatioDiv.style.paddingBottom = padding;
                imageRatioDiv.style.border = '4px solid transparent';
                dummyContent.appendChild(imageRatioDiv);

                // Emulate .card-info
                // Only Expanding mode puts labels inside the card without external dummy height
                const isIntegratedExpanding =
                    isExpanding && (this.isLandscape || this.cardType === 'square' || this.cardType === 'artist');
                const isPortraitExpanding =
                    isExpanding && !this.isLandscape && this.cardType !== 'square' && this.cardType !== 'artist';

                if (!this.hideLabels && !isIntegratedExpanding && !isPortraitExpanding) {
                    const infoDiv = document.createElement('div');
                    infoDiv.style.padding = '14px 4px 0 4px';
                    infoDiv.innerHTML = `<div style="font-size: calc(1.4rem * var(--card-title-font-scale, 1)); font-weight: 700; line-height: 1.2; margin: 0;">&nbsp;</div><div style="font-size: calc(1.15rem * var(--card-title-font-scale, 1)); font-weight: 500; line-height: 1.2; margin-top: 4px;">&nbsp;</div>`;
                    dummyContent.appendChild(infoDiv);
                }
            }

            dummyDiv.appendChild(dummyContent);
            this.track.appendChild(dummyDiv);
        }

        this.bufferZone = Math.floor(this.visibleCount / 2);

        // -------------------------------------------------------------
        // Initialize focused index.
        // -------------------------------------------------------------
        this.currentIndex = options.currentIndex !== undefined ? options.currentIndex : 0;

        this.domNodes = new Map(); // Maps index -> HTMLElement

        if (this._initialWindow != null && this.currentIndex === 0) {
            this._isBootRender = true;
        }
        this._updateWindow(this.currentIndex);

        // -------------------------------------------------------------
        // Align scroll position instantly to center on initial focused index
        // -------------------------------------------------------------
        if (this.currentIndex > 0) {
            const isRtl = document.documentElement.dir === 'rtl';
            const elementPos = this.getItemPosition(this.currentIndex);
            const canExpand = isExpanding && !this.isLandscape && this.cardType !== 'square' && this.cardType !== 'artist';
            const elementWidth = canExpand ? Math.round(600 * (this.modernMultiplier || 1.0)) : this.itemWidth;

            const containerWidth = this.track.parentElement ? this.track.parentElement.clientWidth : window.innerWidth;
            const targetScroll = elementPos - containerWidth / 2 + elementWidth / 2;
            const maxScroll = Math.max(0, this.getTrackWidth() - containerWidth);
            const finalScrollLeft = Math.max(0, Math.min(targetScroll, maxScroll));

            this.track.style.transition = 'none';
            this.track.style.webkitTransition = 'none';

            const transformValue = isRtl
                ? `translate3d(${finalScrollLeft}px, 0, 0)`
                : `translate3d(-${finalScrollLeft}px, 0, 0)`;

            this.track.style.webkitTransform = transformValue;
            this.track.style.transform = transformValue;

            requestAnimationFrame(() => {
                this.track.style.webkitTransition = '';
                this.track.style.transition = '';
            });
        }

        // =================================================================
        // STARTUP BACKDROP CACHING (Expanding Posters Mode)
        // =================================================================
        if (isExpanding) {
            const firstCard = this.domNodes.get(0);
            if (firstCard) {
                loadExpansionThumb(firstCard);
            }

            const secondCard = this.domNodes.get(1);
            if (secondCard) {
                loadExpansionThumb(secondCard);
            }
        }

        if ((platformInfo.isWeb || platformInfo.isWebOS) && this.totalItems > 4) {
            this._injectScrollArrows();
        }
    }

    /**
     * Injects left/right navigation arrows for web users.
     */
    _injectScrollArrows() {
        const sectionEl = this.track.parentElement?.parentElement;
        if (!sectionEl) return;

        // Prevent duplicate injection
        if (sectionEl.querySelector('.row-scroll-arrows')) return;

        sectionEl.style.position = 'relative';

        const arrowContainer = document.createElement('div');
        arrowContainer.className = 'row-scroll-arrows';

        const leftBtn = document.createElement('button');
        leftBtn.className = 'scroll-arrow left-arrow';
        leftBtn.setAttribute('aria-label', 'Scroll left');
        leftBtn.setAttribute('tabindex', '-1');
        leftBtn.innerHTML =
            '<svg viewBox="0 0 24 24" width="28" height="28"><path fill="currentColor" d="M15.41 16.59L10.83 12l4.58-4.59L14 6l-6 6 6 6 1.41-1.41z"/></svg>';

        const rightBtn = document.createElement('button');
        rightBtn.className = 'scroll-arrow right-arrow';
        rightBtn.setAttribute('aria-label', 'Scroll right');
        rightBtn.setAttribute('tabindex', '-1');
        rightBtn.innerHTML =
            '<svg viewBox="0 0 24 24" width="28" height="28"><path fill="currentColor" d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6-1.41-1.41z"/></svg>';

        arrowContainer.appendChild(leftBtn);
        arrowContainer.appendChild(rightBtn);

        // Page size: roughly half the visible row width per click
        const pageSize = Math.max(1, Math.floor(this.visibleCount / 1.5));

        /**
         * Scroll the track to center on `targetIndex` without touching focus.
         *
         * We replicate the exact same translate3d formula that ScrollController uses
         * (src/ui/ScrollController.js ~L508-L564) so the visual result is identical,
         * but we skip focusManager.focusElement() so the keyboard/remote focus ring
         * stays exactly where the user left it.
         */
        const scrollToIndex = (targetIndex) => {
            const isRtl = document.documentElement.dir === 'rtl';
            const clamped = Math.max(0, Math.min(this.totalItems - 1, targetIndex));

            // Update virtual window so the target cards are in the DOM
            this.currentIndex = clamped;
            this._updateWindow(this.currentIndex);

            // Compute the scroll offset (mirrors ScrollController logic exactly)
            const elementPos = this.getItemPosition(clamped);

            // -----------------------------------------------------------------
            // Card Centering Geometry (Expanding Posters)
            // -----------------------------------------------------------------
            // If we are running the expanding posters layout and the cards can expand,
            // we center the card based on its EXPANDED width (468px/600px).
            // This prevents the card's right boundary from clipping and centers
            // the expanded card perfectly in the middle of the viewport.
            // -----------------------------------------------------------------
            const isExpanding = document.documentElement.getAttribute('data-layout-media-rows') === 'expanding';
            const canExpand = isExpanding && !this.isLandscape && this.cardType !== 'square' && this.cardType !== 'artist';
            const elementWidth = canExpand ? Math.round(600 * (this.modernMultiplier || 1.0)) : this.itemWidth;

            const containerWidth = this.track.parentElement ? this.track.parentElement.clientWidth : window.innerWidth;
            const trackWidth = this.getTrackWidth();

            const targetScroll = elementPos - containerWidth / 2 + elementWidth / 2;
            const maxScroll = Math.max(0, trackWidth - containerWidth);
            const finalScrollLeft = Math.max(0, Math.min(targetScroll, maxScroll));

            // Apply smooth CSS transition — same transition the track CSS already has
            const transformValue = isRtl
                ? `translate3d(${finalScrollLeft}px, 0, 0)`
                : `translate3d(-${finalScrollLeft}px, 0, 0)`;

            this.track.style.webkitTransform = transformValue;
            this.track.style.transform = transformValue;
        };

        leftBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            scrollToIndex(this.currentIndex - pageSize);
        });

        rightBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            scrollToIndex(this.currentIndex + pageSize);
        });

        sectionEl.appendChild(arrowContainer);
    }

    /**
     * Determines which items should be in the DOM and updates it
     * @param {number} centerIndex
     */
    _updateWindow(centerIndex) {
        if (this.totalItems === 0) return;

        // ── Boot-render path ────────────────────────────────────────────────
        // On the very first call (triggered by the constructor), if initialWindow
        // was requested we build the full initial set of DOM nodes in one pass.
        // All subsequent calls fall through to the normal sliding-window logic.
        if (this._isBootRender) {
            this._isBootRender = false; // Never repeat the boot path
            const bootEnd = Math.min(this.totalItems - 1, this._initialWindow - 1);

            // Build [0 .. bootEnd] — unconditionally, no size checks needed
            const start = 0;
            const end = bootEnd;

            for (let i = start; i <= end; i++) {
                if (!this.domNodes.has(i)) {
                    // -----------------------------------------------------------------
                    // Safely extract HTML representation from renderCard
                    // Handles potential null/undefined returns gracefully in legacy engines
                    // -----------------------------------------------------------------
                    const tempDiv = document.createElement('div');
                    const cardHtml = this.renderCard(this.items[i]);
                    tempDiv.innerHTML = (cardHtml || '').trim();
                    const cardNode = tempDiv.firstElementChild;
                    if (cardNode) {
                        const leftPos = this.sidePadding + i * this.totalItemWidth;
                        cardNode.style.position = 'absolute';
                        const isRtl = document.documentElement.dir === 'rtl';
                        if (isRtl) {
                            cardNode.style.right = `${leftPos}px`;
                        } else {
                            cardNode.style.left = `${leftPos}px`;
                        }
                        cardNode.style.top = '0';
                        if (!this.isModern && !this.isExpanded && !this.isModernPosters && !this.isExpanding) {
                            cardNode.style.width = `${this.itemWidth}px`;
                        }
                        cardNode.dataset.virtualIndex = i;
                        cardNode.setAttribute('data-virtual-index', i);
                        this.track.appendChild(cardNode);
                        this.domNodes.set(i, cardNode);

                        // Eager image load — same as the normal window path
                        const img = cardNode.querySelector('img.lazy');
                        if (img) {
                            lazyLoader.forceLoad(img);
                        }
                    }
                }
            }

            // Invalidate FocusManager spatial cache so freshly added nodes are seen
            if (this.focusSectionId) {
                focusManager.invalidateCache(this.focusSectionId);
            }

            // Boot render is complete. Normal _updateWindow calls will trim the window
            // back to visibleCount as the user navigates, which is exactly what we want.
            return;
        }
        // ── End boot-render path ────────────────────────────────────────────

        let start, end;

        if (this.totalItems <= this.visibleCount) {
            // If the row is small enough to fit within the visible bounds entirely,
            // just render everything simultaneously so bounds clipping is never an issue.
            start = 0;
            end = this.totalItems - 1;
        } else {
            start = Math.max(0, centerIndex - this.bufferZone);
            end = Math.min(this.totalItems - 1, centerIndex + this.bufferZone);

            // Ensure we always render exactly visibleCount items if possible.
            // Symmetrically expand it to the right (if bounded left) or left (if bounded right).
            const currentSize = end - start + 1;
            if (currentSize < this.visibleCount) {
                const deficit = this.visibleCount - currentSize;
                if (start === 0) {
                    end = Math.min(this.totalItems - 1, end + deficit);
                } else if (end === this.totalItems - 1) {
                    start = Math.max(0, start - deficit);
                }
            }
        }

        const requiredIndices = new Set();
        for (let i = start; i <= end; i++) {
            requiredIndices.add(i);
        }

        // 1. Remove nodes that are no longer in the window
        let domChanged = false;

        for (const [index, node] of this.domNodes.entries()) {
            if (!requiredIndices.has(index)) {
                if (node.parentNode === this.track) {
                    this.track.removeChild(node);
                    domChanged = true;
                }
                this.domNodes.delete(index);
            }
        }

        // 2. Add or update required nodes
        for (let i = start; i <= end; i++) {
            if (!this.domNodes.has(i)) {
                const itemData = this.items[i];

                // -----------------------------------------------------------------
                // Safely extract HTML representation from renderCard
                // Ensures legacy JS engines never throw TypeError if card string is nullish
                // -----------------------------------------------------------------
                const tempDiv = document.createElement('div');
                const cardHtml = this.renderCard(itemData);
                tempDiv.innerHTML = (cardHtml || '').trim();
                const cardNode = tempDiv.firstElementChild;

                if (cardNode) {
                    // Position the card absolutely within the relative track
                    // Include sidePadding from layout.css
                    const leftPos = this.sidePadding + i * this.totalItemWidth;
                    cardNode.style.position = 'absolute';

                    const isRtl = document.documentElement.dir === 'rtl';
                    if (isRtl) {
                        cardNode.style.right = `${leftPos}px`;
                    } else {
                        cardNode.style.left = `${leftPos}px`;
                    }

                    cardNode.style.top = '0'; // Assumes uniform height, margins handle spacing
                    if (!this.isModern && !this.isExpanded && !this.isModernPosters && !this.isExpanding) {
                        cardNode.style.width = `${this.itemWidth}px`;
                    }

                    // Add index for identifying the card in focus handlers
                    cardNode.dataset.virtualIndex = i;
                    // CRITICAL FOR TIZEN: Older webkits fail to persist JS dataset object graphs through DOM detach.
                    // We must forcefully inject the physical DOM attribute so syncIndex queries can read it perfectly.
                    cardNode.setAttribute('data-virtual-index', i);

                    this.track.appendChild(cardNode);
                    this.domNodes.set(i, cardNode);
                    domChanged = true;

                    // EAGER LOAD: The row natively culls bounds (windowing), so appended nodes are guaranteed
                    // to be within the user's immediate physical view window or pre-buffer.
                    // We forcibly load them to bypass IntersectionObserver, which permanently fails
                    // to track horizontal hardware-composited `translate3d` bounds on old Tizen.
                    const img = cardNode.querySelector('img.lazy');
                    if (img) {
                        lazyLoader.forceLoad(img);
                    }
                }
            }
        }

        // 3. Ensure DOM order exactly matches dataset indexing to prevent FocusManager spatial routing from reversing directions
        // We use a safe differential alignment loop to exclusively move out-of-order elements
        // This prevents Tizen native `blur` events from dumping focus to the document root
        if (domChanged) {
            const expectedChildren = Array.from(this.track.children);
            expectedChildren.sort((a, b) => {
                const idxA = parseInt(a.getAttribute('data-virtual-index') || a.dataset.virtualIndex, 10);
                const idxB = parseInt(b.getAttribute('data-virtual-index') || b.dataset.virtualIndex, 10);
                // Keep the structural dummy div at the beginning
                if (isNaN(idxA)) return -1;
                if (isNaN(idxB)) return 1;
                return idxA - idxB;
            });

            // Perform minimal DOM mutations
            for (let c = 0; c < expectedChildren.length; c++) {
                if (this.track.children[c] !== expectedChildren[c]) {
                    this.track.insertBefore(expectedChildren[c], this.track.children[c]);
                }
            }

            if (this.focusSectionId) {
                focusManager.invalidateCache(this.focusSectionId);
            }
        }
    }

    /**
     * Finds and focuses the virtual item closest to the provided X coordinate.
     * Use to support spatial down/up entry from other rows.
     * @param {number} documentX - The X coordinate of the center of the elements left behind
     */
    focusClosestToX(documentX) {
        if (this.totalItems === 0) return null;

        const trackRect = this.track.getBoundingClientRect();
        const isRtl = document.documentElement.dir === 'rtl';

        let relativeX;
        let bestIndex;

        if (isRtl) {
            relativeX = trackRect.right - documentX;
        } else {
            relativeX = documentX - trackRect.left;
        }

        // Items are placed at: sidePadding + i * totalItemWidth
        // We want to find index i where target center is closest
        bestIndex = Math.round((relativeX - this.sidePadding - this.itemWidth / 2) / this.totalItemWidth);
        bestIndex = Math.max(0, Math.min(this.totalItems - 1, bestIndex));

        this.currentIndex = bestIndex;
        this._updateWindow(this.currentIndex);
        return this.domNodes.get(this.currentIndex);
    }

    /**
     * Finds and focuses the virtual item by its absolute index.
     * Used by NavigationState to restore exact focus when page history pops.
     * @param {number} index - The absolute dataset.virtualIndex to restore
     */
    focusByIndex(index) {
        if (this.totalItems === 0) return null;
        this.currentIndex = Math.max(0, Math.min(this.totalItems - 1, index));
        this._updateWindow(this.currentIndex);
        return this.domNodes.get(this.currentIndex);
    }

    /**
     * FocusManager interaction hook
     * Handles horizontal movement events triggered by the controller.
     * @param {string} direction 'left' or 'right'
     * @param {number} currentIndex The currently focused item's absolute physical index (single source of truth)
     * @returns {HTMLElement|null} The next dom node to focus, or null if bound is hit
     */
    handleMove(direction, currentIndex) {
        // The current index is now passed in directly from the physically active DOM node.
        let nextIndex = currentIndex !== undefined ? currentIndex : this.currentIndex;

        const isLeft = direction === 'left' || direction === 'Left';
        const isRight = direction === 'right' || direction === 'Right';
        const isRtl = document.documentElement.dir === 'rtl';

        if (!isLeft && !isRight) {
            return null; // Ignore non-horizontal movement
        }

        if (isRtl) {
            if (isLeft) nextIndex++;
            else if (isRight) nextIndex--;
        } else {
            if (isLeft) nextIndex--;
            else if (isRight) nextIndex++;
        }

        if (nextIndex < 0 || nextIndex >= this.totalItems) {
            return null; // At boundaries, let FocusManager handle normal wrap/exit logic
        }

        // 1. Update our internal state (for vertical navigation restoration)
        this.currentIndex = nextIndex;

        // 2. Recalculate DOM nodes window to ensure the target is rendered
        this._updateWindow(this.currentIndex);

        // 3. Return the newly guaranteed DOM node for FocusManager to focus on
        return this.domNodes.get(this.currentIndex);
    }

    /**
     * Resets internal index tracking back to an existing DOM node.
     * Needed when focus jumps to this row from another vertical section.
     * @param {HTMLElement} targetNode
     */
    syncIndexFromNode(targetNode) {
        if (targetNode && targetNode.dataset && targetNode.dataset.virtualIndex !== undefined) {
            this.currentIndex = parseInt(targetNode.dataset.virtualIndex, 10);
        }
    }

    /**
     * Compute the total scrollable width of the track mathematically, without touching the DOM.
     * Prevents synchronous layout flushes when retrieved by ScrollController.
     * @returns {number}
     */
    getTrackWidth() {
        // -------------------------------------------------------------
        // Mathematical Scroll Boundary Logic
        // -------------------------------------------------------------
        // In the expanding layout, we expand posters by exactly 375px on focus.
        // To prevent layout clipping and allow the last card in the row to
        // scroll fully into view, we must include the 375px expansion buffer
        // in our calculated mathematical track width (matching the DOM track
        // width style set inside the constructor).
        // -------------------------------------------------------------
        const isExpanding = document.documentElement.getAttribute('data-layout-media-rows') === 'expanding';
        const expansion =
            isExpanding && !this.isLandscape && this.cardType !== 'square' && this.cardType !== 'artist'
                ? 375 * (this.modernMultiplier || 1.0)
                : 0;
        return this.totalItems * this.totalItemWidth + this.sidePadding * 2 + expansion;
    }

    /**
     * Compute the exact left position of an item relative to the track computationally.
     * Prevents `element.offsetLeft` forced layouts.
     * @param {number} index - The absolute physical index of the item
     * @returns {number}
     */
    getItemPosition(index) {
        return this.sidePadding + index * this.totalItemWidth; // Matches leftPos calculation in constructor / _updateWindow
    }
}
