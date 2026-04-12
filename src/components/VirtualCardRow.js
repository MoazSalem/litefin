import { lazyLoader } from '../utils/LazyLoader.js';
import { focusManager } from '../ui/FocusManager.js';

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
        this.itemWidth = this.isLandscape ? 400 : 240;
        this.itemMargin = 24;
        this.totalItemWidth = this.itemWidth + this.itemMargin;

        this.totalItems = this.items.length;

        // Set the total width of the track to simulate all items existing
        // Add 60px padding-left and padding-right from layout.css
        const totalWidth = this.totalItems * this.totalItemWidth + 120;
        this.track.style.width = `${totalWidth}px`;
        // Ensure track is relative for absolute positioned children
        this.track.style.position = 'relative';
        this.track.style.display = 'block'; // Inline-flex breaks absolute positioning inside
        this.track.innerHTML = '';

        // Link the instance to the DOM element so ScrollController can access computationally
        // derived layout values instead of forcing synchronous layout flushes.
        this.track.__virtualRow = this;

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
            dummyContent.style.border = '3px solid transparent';
            dummyContent.style.display = 'block';

            // Emulate .card-image
            const imageRatioDiv = document.createElement('div');
            imageRatioDiv.style.width = '100%';
            imageRatioDiv.style.height = '0';
            let padding = '150%'; // Poster
            if (this.isLandscape) padding = '56.25%';
            else if (this.cardType === 'square' || this.cardType === 'artist') padding = '100%';
            imageRatioDiv.style.paddingBottom = padding;
            imageRatioDiv.style.border = '3px solid transparent';
            dummyContent.appendChild(imageRatioDiv);

            // Emulate .card-info
            if (!this.hideLabels) {
                const infoDiv = document.createElement('div');
                infoDiv.style.padding = '12px 4px 0 4px';
                infoDiv.innerHTML = `<div style="height: 1.2rem; margin: 0; line-height: normal;">&nbsp;</div><div style="height: 1rem; margin-top: 6px; line-height: normal;">&nbsp;</div>`;
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
                        const leftPos = 60 + i * this.totalItemWidth;
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
                    // Include 60px padding-left from layout.css
                    const leftPos = 60 + i * this.totalItemWidth;
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

        // Items are placed at: 60 + i * totalItemWidth
        // We want to find index i where target center is closest
        bestIndex = Math.round((relativeX - 60 - this.itemWidth / 2) / this.totalItemWidth);
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
        return this.totalItems * this.totalItemWidth + 120; // Matches totalWidth calculation in constructor
    }

    /**
     * Compute the exact left position of an item relative to the track computationally.
     * Prevents `element.offsetLeft` forced layouts.
     * @param {number} index - The absolute physical index of the item
     * @returns {number}
     */
    getItemPosition(index) {
        return 60 + index * this.totalItemWidth; // Matches leftPos calculation in constructor / _updateWindow
    }
}
