/**
 * ============================================================================
 * LiteFin Tizen - VirtualList
 * ============================================================================
 * High-performance virtual scrolling list that only renders visible items.
 * Critical for smooth scrolling on TV devices with limited resources.
 * 
 * Features:
 * - Only renders items in viewport + buffer
 * - Recycles DOM elements to minimize garbage collection
 * - Supports both vertical and horizontal scrolling
 * - Keyboard/D-pad navigation support
 * 
 * Usage:
 *   const list = new VirtualList({
 *       container: document.getElementById('list'),
 *       itemHeight: 200,
 *       itemRenderer: (item, index) => `<div>${item.name}</div>`,
 *       items: myItems
 *   });
 * ============================================================================
 */

import { eventBus } from '../core/EventBus.js';

class VirtualList {
    /**
     * Create a virtual list
     * @param {Object} options - Configuration options
     * @param {HTMLElement} options.container - Container element
     * @param {number} options.itemHeight - Height of each item in pixels
     * @param {number} [options.itemWidth] - Width for horizontal lists
     * @param {Function} options.itemRenderer - Function to render item HTML
     * @param {Array} [options.items=[]] - Initial items array
     * @param {number} [options.buffer=3] - Extra items to render outside viewport
     * @param {boolean} [options.horizontal=false] - Horizontal scroll mode
     * @param {string} [options.itemClass='vlist-item'] - CSS class for items
     */
    constructor(options) {
        // Required options
        this.container = options.container;
        this.itemHeight = options.itemHeight;
        this.itemRenderer = options.itemRenderer;

        // Optional with defaults
        this.itemWidth = options.itemWidth || options.itemHeight;
        this.items = options.items || [];
        this.buffer = options.buffer ?? 3;
        this.horizontal = options.horizontal || false;
        this.itemClass = options.itemClass || 'vlist-item';

        // Internal state
        this._scrollPos = 0;
        this._visibleStart = 0;
        this._visibleEnd = 0;
        this._focusedIndex = 0;

        // DOM element pool for recycling
        this._pool = [];
        this._activeElements = new Map();  // index -> element

        // Wrapper elements
        this._wrapper = null;
        this._content = null;

        // Bound methods
        this._onScroll = this._onScroll.bind(this);
        this._onKeyDown = this._onKeyDown.bind(this);

        // Initialize
        this._init();
    }

    /**
     * Initialize the virtual list DOM structure
     * @private
     */
    _init() {
        // Create wrapper for scroll handling
        this._wrapper = document.createElement('div');
        this._wrapper.className = 'vlist-wrapper';
        this._wrapper.style.cssText = `
            position: relative;
            overflow: auto;
            width: 100%;
            height: 100%;
            ${this.horizontal ? 'overflow-x: auto; overflow-y: hidden;' : 'overflow-x: hidden; overflow-y: auto;'}
        `;

        // Create content container with full height for scroll
        this._content = document.createElement('div');
        this._content.className = 'vlist-content';
        this._updateContentSize();

        this._wrapper.appendChild(this._content);
        this.container.appendChild(this._wrapper);

        // Attach scroll listener with passive for performance
        this._wrapper.addEventListener('scroll', this._onScroll, { passive: true });

        // Initial render
        this._render();

        console.log(`VirtualList: Initialized with ${this.items.length} items`);
    }

    /**
     * Update the content container size based on total items
     * @private
     */
    _updateContentSize() {
        const totalSize = this.items.length * (this.horizontal ? this.itemWidth : this.itemHeight);

        if (this.horizontal) {
            this._content.style.cssText = `
                position: relative;
                height: 100%;
                width: ${totalSize}px;
            `;
        } else {
            this._content.style.cssText = `
                position: relative;
                width: 100%;
                height: ${totalSize}px;
            `;
        }
    }

    /**
     * Handle scroll events
     * @private
     */
    _onScroll() {
        const newScrollPos = this.horizontal
            ? this._wrapper.scrollLeft
            : this._wrapper.scrollTop;

        // Only re-render if scroll position changed significantly
        if (Math.abs(newScrollPos - this._scrollPos) > 10) {
            this._scrollPos = newScrollPos;
            this._render();
        }
    }

    /**
     * Calculate visible range and render items
     * @private
     */
    _render() {
        const viewportSize = this.horizontal
            ? this._wrapper.clientWidth
            : this._wrapper.clientHeight;

        const itemSize = this.horizontal ? this.itemWidth : this.itemHeight;

        // Calculate visible range with buffer
        const startIndex = Math.max(0, Math.floor(this._scrollPos / itemSize) - this.buffer);
        const endIndex = Math.min(
            this.items.length - 1,
            Math.ceil((this._scrollPos + viewportSize) / itemSize) + this.buffer
        );

        // Track which indices need rendering
        const neededIndices = new Set();
        for (let i = startIndex; i <= endIndex; i++) {
            neededIndices.add(i);
        }

        // Remove elements no longer in view
        for (const [index, element] of this._activeElements) {
            if (!neededIndices.has(index)) {
                this._recycleElement(element, index);
            }
        }

        // Render new elements
        for (let i = startIndex; i <= endIndex; i++) {
            if (!this._activeElements.has(i)) {
                this._renderItem(i);
            }
        }

        this._visibleStart = startIndex;
        this._visibleEnd = endIndex;
    }

    /**
     * Render a single item
     * @private
     * @param {number} index - Item index
     */
    _renderItem(index) {
        if (index < 0 || index >= this.items.length) return;

        const item = this.items[index];
        const itemSize = this.horizontal ? this.itemWidth : this.itemHeight;
        const position = index * itemSize;

        // Get element from pool or create new
        let element = this._pool.pop();

        if (!element) {
            element = document.createElement('div');
            element.className = this.itemClass;
        }

        // Position the element
        element.style.cssText = `
            position: absolute;
            ${this.horizontal ? 'left' : 'top'}: ${position}px;
            ${this.horizontal ? 'height: 100%' : 'width: 100%'};
            ${this.horizontal ? `width: ${this.itemWidth}px` : `height: ${this.itemHeight}px`};
            transform: translateZ(0);
        `;

        // Set focusable
        element.tabIndex = 0;
        element.setAttribute('data-index', index);

        // Render content
        const content = this.itemRenderer(item, index);
        if (typeof content === 'string') {
            element.innerHTML = content;
        } else {
            element.innerHTML = '';
            element.appendChild(content);
        }

        // Add to DOM and track
        this._content.appendChild(element);
        this._activeElements.set(index, element);

        // Apply focus if this is the focused item
        if (index === this._focusedIndex) {
            element.classList.add('focused');
        }
    }

    /**
     * Recycle an element back to the pool
     * @private
     * @param {HTMLElement} element - Element to recycle
     * @param {number} index - Item index
     */
    _recycleElement(element, index) {
        element.remove();
        element.className = this.itemClass;
        element.innerHTML = '';
        this._activeElements.delete(index);

        // Keep pool from growing too large
        if (this._pool.length < 50) {
            this._pool.push(element);
        }
    }

    /**
     * Handle keyboard navigation
     * @private
     * @param {KeyboardEvent} e - Keyboard event
     */
    _onKeyDown(e) {
        let delta = 0;

        if (this.horizontal) {
            if (e.keyCode === 37) delta = -1;  // Left
            if (e.keyCode === 39) delta = 1;   // Right
        } else {
            if (e.keyCode === 38) delta = -1;  // Up
            if (e.keyCode === 40) delta = 1;   // Down
        }

        if (delta !== 0) {
            e.preventDefault();
            this.focusItem(this._focusedIndex + delta);
        }
    }

    /**
     * Focus a specific item by index
     * @param {number} index - Item index to focus
     */
    focusItem(index) {
        // Clamp to valid range
        index = Math.max(0, Math.min(this.items.length - 1, index));

        if (index === this._focusedIndex) return;

        // Update focus state
        const oldElement = this._activeElements.get(this._focusedIndex);
        if (oldElement) {
            oldElement.classList.remove('focused');
        }

        this._focusedIndex = index;

        // Scroll into view if needed
        this.scrollToItem(index);

        // Apply focus to new element
        const newElement = this._activeElements.get(index);
        if (newElement) {
            newElement.classList.add('focused');
            newElement.focus();
        }

        // Emit focus event
        eventBus.emit('virtualList:focus', {
            index,
            item: this.items[index]
        });
    }

    /**
     * Scroll to make an item visible
     * @param {number} index - Item index
     * @param {string} [align='center'] - Alignment: 'start', 'center', 'end'
     */
    scrollToItem(index, align = 'center') {
        const itemSize = this.horizontal ? this.itemWidth : this.itemHeight;
        const viewportSize = this.horizontal
            ? this._wrapper.clientWidth
            : this._wrapper.clientHeight;

        const itemStart = index * itemSize;
        const itemEnd = itemStart + itemSize;

        let scrollTo = this._scrollPos;

        // Calculate scroll position based on alignment
        if (align === 'start') {
            scrollTo = itemStart;
        } else if (align === 'end') {
            scrollTo = itemEnd - viewportSize;
        } else {
            // Center
            scrollTo = itemStart - (viewportSize - itemSize) / 2;
        }

        // Only scroll if item is not already visible
        const isVisible = itemStart >= this._scrollPos &&
            itemEnd <= this._scrollPos + viewportSize;

        if (!isVisible) {
            if (this.horizontal) {
                this._wrapper.scrollLeft = Math.max(0, scrollTo);
            } else {
                this._wrapper.scrollTop = Math.max(0, scrollTo);
            }
        }
    }

    /**
     * Update the items array and re-render
     * @param {Array} items - New items array
     */
    setItems(items) {
        this.items = items;
        this._updateContentSize();

        // Clear all elements
        for (const [index, element] of this._activeElements) {
            this._recycleElement(element, index);
        }

        // Reset focus to valid range
        this._focusedIndex = Math.min(this._focusedIndex, items.length - 1);

        // Re-render
        this._render();
    }

    /**
     * Append items to the list
     * @param {Array} newItems - Items to append
     */
    appendItems(newItems) {
        this.items = [...this.items, ...newItems];
        this._updateContentSize();
        this._render();
    }

    /**
     * Get currently focused item
     * @returns {Object} { index, item }
     */
    getFocused() {
        return {
            index: this._focusedIndex,
            item: this.items[this._focusedIndex]
        };
    }

    /**
     * Enable keyboard navigation
     */
    enableKeyboard() {
        this._wrapper.addEventListener('keydown', this._onKeyDown);
    }

    /**
     * Disable keyboard navigation
     */
    disableKeyboard() {
        this._wrapper.removeEventListener('keydown', this._onKeyDown);
    }

    /**
     * Clean up and destroy the virtual list
     */
    destroy() {
        this._wrapper.removeEventListener('scroll', this._onScroll);
        this._wrapper.removeEventListener('keydown', this._onKeyDown);

        this._activeElements.clear();
        this._pool = [];

        this._wrapper.remove();

        console.log('VirtualList: Destroyed');
    }
}

export default VirtualList;
