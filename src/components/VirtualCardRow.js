import { lazyLoader } from '../utils/LazyLoader.js';
import { focusManager } from '../ui/FocusManager.js';
import { eventBus } from '../core/EventBus.js';
import { platformInfo } from '../utils/PlatformInfo.js';

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
        // Modern override: 600px / 260px with 28px margin
        const isModern = document.documentElement.getAttribute('data-layout') === 'modern';
        if (isModern) {
            // Target Height: 600px * 56.25% (16:9) = 337.5px
            if (this.isLandscape) {
                this.itemWidth = 600;
            } else if (this.cardType === 'square' || this.cardType === 'artist') {
                this.itemWidth = 338; // 338px * 100% = 338px height
            } else {
                this.itemWidth = 225; // 225px * 150% = 337.5px height
            }
            this.itemMargin = 40; // Increased gap for premium feel
            this.sidePadding = 60; // Match classic alignment (60px)
        } else {
            this.itemWidth = this.isLandscape ? 400 : 240;
            this.itemMargin = 24;
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

        // Modern: Handle Poster-to-Landscape Expansion logic
        let loadExpansionThumb;
        if (isModern) {
            // Add a buffer for the expanded card width (375px) so the track doesn't clip.
            // Symmetrical spacing keeps the row scroll boundaries aligned cleanly.
            const expansion = (this.isLandscape || this.cardType === 'square' || this.cardType === 'artist') ? 0 : 375;
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
                
                // If a valid image element and source exists, and we haven't fetched it yet:
                if (thumb && !thumb.getAttribute('src') && thumbSrc) {
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
                    const isExpanding = card.classList.contains('has-expansion');
                    
                    // Apply focused index to track custom properties for modern styling layout shifts
                    if (isExpanding) {
                        this.track.style.setProperty('--focused-index', index);
                    } else {
                        this.track.style.setProperty('--focused-index', -1);
                    }
                    
                    // Trigger asynchronous image preloading for the expanding backdrop
                    loadExpansionThumb(card);

                    // =========================================================
                    // 🚀 ACTIVE SLIDING WINDOW BACKDROP PRELOADING
                    // =========================================================
                    // To keep navigation feeling lightning fast and premium (Apple HIG style),
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
            this._focusUnsubscribe = eventBus.on('focus:changed', (element) => {
                handleFocus(element);
            });

            // Native focus/mouse listeners.
            // focusin handles physical focus events; mousedown handles mouse clicks/selects.
            this.track.addEventListener('focusin', (e) => handleFocus(e.target));
            this.track.addEventListener('mousedown', (e) => handleFocus(e.target));

            // Mouseover hover listener:
            // Ensure hover actions instantly fetch backdrop assets so they expand smoothly.
            // This is key for pointer-driven platforms (Desktop browser, WebOS pointer remote).
            this.track.addEventListener('mouseover', (e) => {
                const card = e.target.closest('.media-card');
                if (card && this.track.contains(card)) {
                    // Pre-fetch assets ahead of CSS hover transitions
                    loadExpansionThumb(card);
                }
            });

            // Focusout listener to reset sibling translation shifts.
            // Resets only if focus actually left the bounds of this horizontal row.
            this.track.addEventListener('focusout', (e) => {
                if (!e.relatedTarget || !this.track.contains(e.relatedTarget)) {
                    this.track.style.setProperty('--focused-index', -1);
                }
            });
        }

        // Inject a hidden dummy element to natively expand the track's height.
        // Since absolute children collapse the parent, this static element prevents
        // the 3px height bug without needing hardcoded pixel guessing.
        // We use a zero-width block to avoid interfering with horizontal (RTL) layout.
        if (this.totalItems > 0) {
            const dummyDiv = document.createElement('div');
            // Outer container has zero width and no horizontal impact
            dummyDiv.style.width = '0';
            dummyDiv.style.height = 'auto';
            dummyDiv.style.display = 'block';
            dummyDiv.style.position = 'static';
            dummyDiv.style.visibility = 'hidden';
            dummyDiv.style.pointerEvents = 'none';
            dummyDiv.style.overflow = 'visible';

            // Inner wrapper provides the actual pixel context for height calculation
            const dummyContent = document.createElement('div');
            dummyContent.style.width = `${this.itemWidth}px`;
            const borderWidth = isModern ? '4px' : '3px';
            dummyContent.style.border = `${borderWidth} solid transparent`;
            dummyContent.style.display = 'block';

            // Emulate .card-image
            const imageRatioDiv = document.createElement('div');
            imageRatioDiv.style.width = '100%';
            imageRatioDiv.style.height = '0';
            let padding = '150%'; // Poster
            if (this.isLandscape) padding = '56.25%';
            else if (this.cardType === 'square' || this.cardType === 'artist') padding = '100%';
            imageRatioDiv.style.paddingBottom = padding;
            imageRatioDiv.style.border = `${borderWidth} solid transparent`;
            dummyContent.appendChild(imageRatioDiv);

            // Emulate .card-info
            const isIntegratedModern = isModern && (this.isLandscape || this.cardType === 'square' || this.cardType === 'artist');
            const isPortraitModern = isModern && !this.isLandscape && this.cardType !== 'square' && this.cardType !== 'artist';

            if (!this.hideLabels && !isIntegratedModern && !isPortraitModern) {
                const infoDiv = document.createElement('div');
                const infoPadding = isModern ? '16px 8px 0 8px' : '12px 4px 0 4px';
                infoDiv.style.padding = infoPadding;

                if (isModern) {
                    // Modern: 1.6rem title (1.2 line-height) + 4px margin + 1.2rem subtitle
                    infoDiv.innerHTML = `<div style="height: 1.92rem; margin: 0; line-height: normal;">&nbsp;</div><div style="height: 1.2rem; margin-top: 4px; line-height: normal;">&nbsp;</div>`;
                } else {
                    // Classic: 1.2rem title + 6px margin + 1rem subtitle
                    infoDiv.innerHTML = `<div style="height: 1.2rem; margin: 0; line-height: normal;">&nbsp;</div><div style="height: 1rem; margin-top: 6px; line-height: normal;">&nbsp;</div>`;
                }
                dummyContent.appendChild(infoDiv);
            }

            dummyDiv.appendChild(dummyContent);
            this.track.appendChild(dummyDiv);
        }

        this.bufferZone = Math.floor(this.visibleCount / 2);
        this.currentIndex = 0; // The index of the currently focused item relative to the array

        this.domNodes = new Map(); // Maps index -> HTMLElement

        // Render the initial block.
        // If an initialWindow was requested, temporarily widen visibleCount so
        // _updateWindow builds the full initial set of DOM nodes in one pass.
        // The flag is cleared on the next _updateWindow call so the normal
        // sliding window takes over transparently from that point.
        if (this._initialWindow != null) {
            this._isBootRender = true;
        }
        this._updateWindow(0);

        // =================================================================
        // 💎 STARTUP BACKDROP CACHING
        // =================================================================
        // Eagerly preloads the backdrops for index 0 and index 1 on startup.
        // This ensures the current row has at least 2 backdrops cached
        // immediately when the page loads, giving a gorgeous, lag-free first
        // impression exactly matching the Apple HIG standard.
        // =================================================================
        if (isModern) {
            // Retrieve the first card (index 0) and preload its backdrop
            const firstCard = this.domNodes.get(0);
            if (firstCard) {
                loadExpansionThumb(firstCard);
            }
            
            // Retrieve the second card (index 1) and preload its backdrop
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
            const elementPos   = this.getItemPosition(clamped);
            
            // -----------------------------------------------------------------
            // Card Centering Geometry (Expanded Posters)
            // -----------------------------------------------------------------
            // If we are running the modern layout and the cards can expand,
            // we center the card based on its EXPANDED width (600px).
            // This prevents the card's right boundary from clipping and centers
            // the expanded card perfectly in the middle of the viewport.
            // -----------------------------------------------------------------
            const isModern = document.documentElement.getAttribute('data-layout') === 'modern';
            const canExpand = isModern && !this.isLandscape && this.cardType !== 'square' && this.cardType !== 'artist';
            const elementWidth = canExpand ? 600 : this.itemWidth;

            const containerWidth = this.track.parentElement
                ? this.track.parentElement.clientWidth
                : window.innerWidth;
            const trackWidth   = this.getTrackWidth();

            const targetScroll   = elementPos - containerWidth / 2 + elementWidth / 2;
            const maxScroll      = Math.max(0, trackWidth - containerWidth);
            const finalScrollLeft = Math.max(0, Math.min(targetScroll, maxScroll));

            // Apply smooth CSS transition — same transition the track CSS already has
            const transformValue = isRtl
                ? `translate3d(${finalScrollLeft}px, 0, 0)`
                : `translate3d(-${finalScrollLeft}px, 0, 0)`;

            this.track.style.webkitTransform = transformValue;
            this.track.style.transform       = transformValue;
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
                    const tempDiv = document.createElement('div');
                    tempDiv.innerHTML = this.renderCard(this.items[i]).trim();
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

                // Create a temporary container to extract the HTML string into a node
                const tempDiv = document.createElement('div');
                tempDiv.innerHTML = this.renderCard(itemData).trim();
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
        // In the modern layout, we expand posters by exactly 375px on focus.
        // To prevent layout clipping and allow the last card in the row to
        // scroll fully into view, we must include the 375px expansion buffer
        // in our calculated mathematical track width (matching the DOM track
        // width style set inside the constructor).
        // -------------------------------------------------------------
        const isModern = document.documentElement.getAttribute('data-layout') === 'modern';
        const expansion = (isModern && !this.isLandscape && this.cardType !== 'square' && this.cardType !== 'artist') ? 375 : 0;
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
