import { lazyLoader } from '../utils/LazyLoader.js';

export class VirtualCardRow {
    /**
     * @param {HTMLElement} trackContainer - The `.row-items-track` wrapper element
     * @param {Array} items - Array of data items to render
     * @param {Object} options - Configuration for rendering options
     * @param {number} [options.visibleCount=10] - Number of items to render simultaneously
     * @param {boolean} [options.isLandscape=false] - If items use the landscape (wider) layout
     * @param {Function} options.renderCard - Callback returning HTML string for an item
     */
    constructor(trackContainer, items, options = {}) {
        this.track = trackContainer;
        this.items = items;

        this.visibleCount = options.visibleCount || 10;
        this.isLandscape = options.isLandscape || false;
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

        // Inject a hidden dummy element to natively expand the track's height.
        // Since absolute children collapse the parent, this static element prevents
        // the 3px height bug without needing hardcoded pixel guessing.
        if (this.totalItems > 0) {
            // Build a pure DIV dummy to force native track height without any focusable elements
            const dummyDiv = document.createElement('div');
            dummyDiv.style.width = `${this.itemWidth}px`;
            dummyDiv.style.border = '3px solid transparent';
            dummyDiv.style.position = 'static';
            dummyDiv.style.visibility = 'hidden';
            dummyDiv.style.pointerEvents = 'none';
            dummyDiv.style.display = 'inline-block';

            // Emulate .card-image
            const imageRatioDiv = document.createElement('div');
            imageRatioDiv.style.width = '100%';
            imageRatioDiv.style.paddingBottom = this.isLandscape ? '56.25%' : '150%';
            imageRatioDiv.style.border = '3px solid transparent';
            dummyDiv.appendChild(imageRatioDiv);

            // Emulate .card-info
            const infoDiv = document.createElement('div');
            infoDiv.style.padding = '12px 4px 0 4px';
            infoDiv.innerHTML = `<div style="font-size: 1.2rem; margin: 0;">&nbsp;</div><div style="font-size: 1rem; margin-top: 6px;">&nbsp;</div>`;
            dummyDiv.appendChild(infoDiv);

            this.track.appendChild(dummyDiv);
        }

        this.bufferZone = Math.floor(this.visibleCount / 2);
        this.currentIndex = 0; // The index of the currently focused item relative to the array

        this.domNodes = new Map(); // Maps index -> HTMLElement

        // Render the initial block
        this._updateWindow(0);
    }

    /**
     * Determines which items should be in the DOM and updates it
     * @param {number} centerIndex
     */
    _updateWindow(centerIndex) {
        if (this.totalItems === 0) return;

        let start = Math.max(0, centerIndex - this.bufferZone);
        let end = Math.min(this.totalItems - 1, centerIndex + this.bufferZone);

        // Ensure we always render exactly visibleCount items if possible
        if (end - start + 1 < this.visibleCount) {
            if (start === 0) {
                end = Math.min(this.totalItems - 1, start + this.visibleCount - 1);
            } else if (end === this.totalItems - 1) {
                start = Math.max(0, end - this.visibleCount + 1);
            }
        }

        const requiredIndices = new Set();
        for (let i = start; i <= end; i++) {
            requiredIndices.add(i);
        }

        // 1. Remove nodes that are no longer in the window
        for (const [index, node] of this.domNodes.entries()) {
            if (!requiredIndices.has(index)) {
                if (node.parentNode === this.track) {
                    this.track.removeChild(node);
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
                const cardNode = tempDiv.firstChild;

                // Position the card absolutely within the relative track
                // Include 60px padding-left from layout.css
                const leftPos = 60 + i * this.totalItemWidth;
                cardNode.style.position = 'absolute';
                cardNode.style.left = `${leftPos}px`;
                cardNode.style.top = '0'; // Assumes uniform height, margins handle spacing

                // Add index for identifying the card in focus handlers
                cardNode.dataset.virtualIndex = i;

                this.track.appendChild(cardNode);
                this.domNodes.set(i, cardNode);

                // Trigger lazy loader for new images
                const img = cardNode.querySelector('img.lazy');
                if (img) {
                    lazyLoader.observeElement(img);
                }
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
        // Calculate relative X inside the track container
        const relativeX = documentX - trackRect.left;

        // Items are placed at: 60 + i * totalItemWidth
        // We want to find index i where target center is closest
        // center i = 60 + i * totalItemWidth + itemWidth / 2
        let bestIndex = Math.round((relativeX - 60 - this.itemWidth / 2) / this.totalItemWidth);
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
     * @returns {HTMLElement|null} The next dom node to focus, or null if bound is hit
     */
    handleMove(direction) {
        let nextIndex = this.currentIndex;

        if (direction === 'left' || direction === 'Left') {
            nextIndex--;
        } else if (direction === 'right' || direction === 'Right') {
            nextIndex++;
        } else {
            return null; // Ignore non-horizontal movement
        }

        if (nextIndex < 0 || nextIndex >= this.totalItems) {
            return null; // At boundaries, let FocusManager handle normal wrap/exit logic
        }

        // 1. Update our internal state
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
}
