/**
 * ============================================================================
 * LiteFin Tizen - VirtualGrid
 * ============================================================================
 * 2D virtual grid for displaying media cards with D-pad navigation.
 * Extends VirtualList concepts to handle rows and columns.
 * 
 * Usage:
 *   const grid = new VirtualGrid({
 *       container: document.getElementById('grid'),
 *       itemWidth: 200,
 *       itemHeight: 300,
 *       columns: 6,
 *       itemRenderer: (item) => cardHTML
 *   });
 * ============================================================================
 */

import { eventBus } from '../core/EventBus.js';
import { focusManager } from './FocusManager.js';
import { animationManager } from './AnimationManager.js';

class VirtualGrid {
    /**
     * Create a virtual grid
     * @param {Object} options - Configuration
     * @param {HTMLElement} options.container - Container element
     * @param {number} options.itemWidth - Width of each item
     * @param {number} options.itemHeight - Height of each item
     * @param {Function} options.itemRenderer - Render function (item, index) => HTML
     * @param {Array} [options.items=[]] - Initial items
     * @param {number} [options.columns=0] - Columns (0 = auto-calculate)
     * @param {number} [options.gap=16] - Gap between items
     * @param {number} [options.buffer=2] - Extra rows to render
     */
    constructor(options) {
        this.container = options.container;
        this.itemWidth = options.itemWidth;
        this.itemHeight = options.itemHeight;
        this.itemRenderer = options.itemRenderer;
        this.items = options.items || [];
        this.gap = options.gap ?? 16;
        this.buffer = options.buffer ?? 2;

        // Calculate columns if not specified
        this._columns = options.columns || 0;

        // Internal state
        this._focusedIndex = 0;
        this._scrollTop = 0;
        this._visibleRowStart = 0;
        this._visibleRowEnd = 0;

        // DOM
        this._wrapper = null;
        this._content = null;
        this._activeElements = new Map();
        this._pool = [];

        // Bound methods
        this._onScroll = this._onScroll.bind(this);
        this._onResize = this._debounce(this._onResize.bind(this), 200);

        this._init();
    }

    /**
     * Initialize grid
     * @private
     */
    _init() {
        // Create wrapper
        this._wrapper = document.createElement('div');
        this._wrapper.className = 'vgrid-wrapper';
        this._wrapper.style.cssText = `
            position: relative;
            width: 100%;
            height: 100%;
            overflow-y: auto;
            overflow-x: hidden;
        `;

        // Create content container
        this._content = document.createElement('div');
        this._content.className = 'vgrid-content';

        this._wrapper.appendChild(this._content);
        this.container.appendChild(this._wrapper);

        // Calculate columns
        this._calculateColumns();

        // Update content size
        this._updateContentSize();

        // Attach listeners
        this._wrapper.addEventListener('scroll', this._onScroll, { passive: true });
        window.addEventListener('resize', this._onResize);

        // Initial render
        this._render();

        // Setup focus events
        this._setupFocusEvents();

        console.log(`VirtualGrid: Initialized with ${this.items.length} items, ${this._columns} columns`);
    }

    /**
     * Calculate number of columns based on container width
     * @private
     */
    _calculateColumns() {
        if (this._columns > 0) return;

        const containerWidth = this._wrapper.clientWidth;
        this._columns = Math.max(1, Math.floor((containerWidth + this.gap) / (this.itemWidth + this.gap)));
    }

    /**
     * Get total row count
     * @private
     */
    _getRowCount() {
        return Math.ceil(this.items.length / this._columns);
    }

    /**
     * Get row height including gap
     * @private
     */
    _getRowHeight() {
        return this.itemHeight + this.gap;
    }

    /**
     * Update content container size
     * @private
     */
    _updateContentSize() {
        const totalHeight = this._getRowCount() * this._getRowHeight();
        this._content.style.cssText = `
            position: relative;
            width: 100%;
            height: ${totalHeight}px;
        `;
    }

    /**
     * Handle scroll events
     * @private
     */
    _onScroll() {
        const newScrollTop = this._wrapper.scrollTop;

        if (Math.abs(newScrollTop - this._scrollTop) > 10) {
            this._scrollTop = newScrollTop;
            this._render();
        }
    }

    /**
     * Handle resize events
     * @private
     */
    _onResize() {
        const oldColumns = this._columns;
        this._columns = 0;
        this._calculateColumns();

        if (oldColumns !== this._columns) {
            this._updateContentSize();

            // Clear and re-render
            for (const [index, element] of this._activeElements) {
                this._recycleElement(element, index);
            }

            this._render();
        }
    }

    /**
     * Render visible items
     * @private
     */
    _render() {
        const viewportHeight = this._wrapper.clientHeight;
        const rowHeight = this._getRowHeight();

        // Calculate visible row range
        const startRow = Math.max(0, Math.floor(this._scrollTop / rowHeight) - this.buffer);
        const endRow = Math.min(
            this._getRowCount() - 1,
            Math.ceil((this._scrollTop + viewportHeight) / rowHeight) + this.buffer
        );

        // Calculate visible item range
        const startIndex = startRow * this._columns;
        const endIndex = Math.min(this.items.length - 1, (endRow + 1) * this._columns - 1);

        // Track needed indices
        const neededIndices = new Set();
        for (let i = startIndex; i <= endIndex; i++) {
            neededIndices.add(i);
        }

        // Remove out-of-view elements
        for (const [index, element] of this._activeElements) {
            if (!neededIndices.has(index)) {
                this._recycleElement(element, index);
            }
        }

        // Render visible elements
        for (let i = startIndex; i <= endIndex; i++) {
            if (!this._activeElements.has(i)) {
                this._renderItem(i);
            }
        }

        this._visibleRowStart = startRow;
        this._visibleRowEnd = endRow;
    }

    /**
     * Render a single item
     * @private
     */
    _renderItem(index) {
        if (index < 0 || index >= this.items.length) return;

        const item = this.items[index];
        const row = Math.floor(index / this._columns);
        const col = index % this._columns;

        // Calculate position
        const top = row * this._getRowHeight();
        const left = col * (this.itemWidth + this.gap);

        // Get or create element
        let element = this._pool.pop();
        if (!element) {
            element = document.createElement('div');
            element.className = 'vgrid-item';
        }

        // Position
        element.style.cssText = `
            position: absolute;
            top: ${top}px;
            left: ${left}px;
            width: ${this.itemWidth}px;
            height: ${this.itemHeight}px;
            transform: translateZ(0);
        `;

        // Make focusable
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

        // Add focus handlers
        element.addEventListener('focus', () => this._onItemFocus(index));
        element.addEventListener('click', () => this._onItemSelect(index));

        this._content.appendChild(element);
        this._activeElements.set(index, element);

        // Apply focus styling if this is the focused item
        if (index === this._focusedIndex) {
            element.classList.add('focused');
            animationManager.focusScale(element, true);
        }
    }

    /**
     * Recycle element to pool
     * @private
     */
    _recycleElement(element, index) {
        element.remove();
        element.className = 'vgrid-item';
        element.innerHTML = '';
        element.removeAttribute('data-index');
        animationManager.focusScale(element, false);
        this._activeElements.delete(index);

        if (this._pool.length < 50) {
            this._pool.push(element);
        }
    }

    /**
     * Setup focus event handlers
     * @private
     */
    _setupFocusEvents() {
        eventBus.on('key:up', () => this._move(-this._columns));
        eventBus.on('key:down', () => this._move(this._columns));
        eventBus.on('key:left', () => this._move(-1));
        eventBus.on('key:right', () => this._move(1));
        eventBus.on('key:enter', () => this._onItemSelect(this._focusedIndex));
    }

    /**
     * Move focus
     * @private
     */
    _move(delta) {
        const newIndex = this._focusedIndex + delta;

        // Handle row boundaries for left/right
        if (Math.abs(delta) === 1) {
            const currentRow = Math.floor(this._focusedIndex / this._columns);
            const newRow = Math.floor(newIndex / this._columns);

            if (newRow !== currentRow || newIndex < 0 || newIndex >= this.items.length) {
                return; // Don't wrap
            }
        }

        this.focusItem(newIndex);
    }

    /**
     * Handle item focus
     * @private
     */
    _onItemFocus(index) {
        if (index !== this._focusedIndex) {
            this._setFocused(index);
        }
    }

    /**
     * Handle item selection
     * @private
     */
    _onItemSelect(index) {
        eventBus.emit('grid:select', {
            index,
            item: this.items[index]
        });
    }

    /**
     * Set focused item
     * @private
     */
    _setFocused(index) {
        // Unfocus old
        const oldElement = this._activeElements.get(this._focusedIndex);
        if (oldElement) {
            oldElement.classList.remove('focused');
            animationManager.focusScale(oldElement, false);
        }

        this._focusedIndex = index;

        // Focus new
        const newElement = this._activeElements.get(index);
        if (newElement) {
            newElement.classList.add('focused');
            animationManager.focusScale(newElement, true);
        }
    }

    /**
     * Focus a specific item
     * @param {number} index - Item index
     */
    focusItem(index) {
        index = Math.max(0, Math.min(this.items.length - 1, index));

        if (index === this._focusedIndex) return;

        this._setFocused(index);
        this.scrollToItem(index);

        const element = this._activeElements.get(index);
        if (element) {
            element.focus();
        }

        eventBus.emit('grid:focus', {
            index,
            item: this.items[index]
        });
    }

    /**
     * Scroll to make item visible
     * @param {number} index - Item index
     */
    scrollToItem(index) {
        const row = Math.floor(index / this._columns);
        const rowTop = row * this._getRowHeight();
        const rowBottom = rowTop + this.itemHeight;

        const viewportTop = this._scrollTop;
        const viewportBottom = this._scrollTop + this._wrapper.clientHeight;

        if (rowTop < viewportTop) {
            this._wrapper.scrollTop = rowTop - this.gap;
        } else if (rowBottom > viewportBottom) {
            this._wrapper.scrollTop = rowBottom - this._wrapper.clientHeight + this.gap;
        }
    }

    /**
     * Update items
     * @param {Array} items - New items array
     */
    setItems(items) {
        this.items = items;

        // Clear all elements
        for (const [index, element] of this._activeElements) {
            this._recycleElement(element, index);
        }

        this._updateContentSize();
        this._focusedIndex = Math.min(this._focusedIndex, items.length - 1);
        this._render();
    }

    /**
     * Get focused item
     * @returns {Object} { index, item }
     */
    getFocused() {
        return {
            index: this._focusedIndex,
            item: this.items[this._focusedIndex]
        };
    }

    /**
     * Debounce helper
     * @private
     */
    _debounce(fn, wait) {
        let timeout;
        return (...args) => {
            clearTimeout(timeout);
            timeout = setTimeout(() => fn.apply(this, args), wait);
        };
    }

    /**
     * Destroy grid
     */
    destroy() {
        this._wrapper.removeEventListener('scroll', this._onScroll);
        window.removeEventListener('resize', this._onResize);

        this._activeElements.clear();
        this._pool = [];

        this._wrapper.remove();
    }
}

export default VirtualGrid;
