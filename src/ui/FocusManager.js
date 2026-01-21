/**
 * ============================================================================
 * LiteFin Tizen - FocusManager
 * ============================================================================
 * Manages focus navigation for TV remote D-pad control.
 * Uses robust spatial navigation for grid traversal.
 * ============================================================================
 */

import { eventBus } from '../core/EventBus.js';

// Focusable element selector
const FOCUSABLE_SELECTOR = '[tabindex], a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])';

class FocusManager {
    constructor() {
        // Registered sections: name -> config
        this._sections = new Map();

        // Currently active section name
        this._activeSection = null;

        // Focus memory: section -> { element, index }
        this._focusMemory = new Map();

        // PERFORMANCE: Cache focusables per section
        this._focusablesCache = new Map();

        // Currently focused element
        this._focusedElement = null;

        // Focus trap stack (for modals)
        this._trapStack = [];

        // Debounce handling
        this._lastMoveTime = 0;

        // SAMSUNG OPTIMIZATION: Cache DOM reference to avoid repeated queries
        this._pageContent = null;

        // Bound methods
        this._onKeyDown = this._onKeyDown.bind(this);

        // Initialize
        this._init();
    }

    /**
     * Initialize focus manager
     * @private
     */
    _init() {
        // Listen for key events from TizenAdapter
        eventBus.on('key:up', () => this._handleKey('up'));
        eventBus.on('key:down', () => this._handleKey('down'));
        eventBus.on('key:left', () => this._handleKey('left'));
        eventBus.on('key:right', () => this._handleKey('right'));
        // We handle Enter via native click, but listen just in case
        eventBus.on('key:enter', () => this._activate());

        // Listen for native keydown (fallback & web testing)
        document.addEventListener('keydown', this._onKeyDown);

        // Track focus changes globally
        document.addEventListener('focusin', (e) => {
            if (this._focusedElement !== e.target) {
                this._focusedElement = e.target;
                this._updateFocusMemory();
            }
        });

        console.log('FocusManager: Initialized (v2 Rewrite)');
    }

    /**
     * Handle keydown events
     * @private
     */
    _onKeyDown(e) {
        let dir = null;
        switch (e.keyCode) {
            case 38: dir = 'up'; break;
            case 40: dir = 'down'; break;
            case 37: dir = 'left'; break;
            case 39: dir = 'right'; break;
            case 13:
                this._activate();
                return;
        }

        if (dir) {
            e.preventDefault();
            this._handleKey(dir);
        }
    }

    /**
     * Handle directional key press
     * @param {string} direction 
     */
    _handleKey(direction) {
        // Simple debounce to prevent event flooding
        const now = Date.now();
        if (now - this._lastMoveTime < 50) return;
        this._lastMoveTime = now;

        this._move(direction);
    }

    /**
     * Register a focusable section
     * @param {string} name - Section identifier
     * @param {HTMLElement} container - Section container element
     * @param {Object} [options] - Section options
     */
    register(name, container, options = {}) {
        const config = {
            container,
            orientation: options.orientation || 'horizontal', // 'horizontal', 'vertical', 'grid'
            loop: options.loop || false,
            // Navigation overrides
            leaveUp: options.leaveUp || null,
            leaveDown: options.leaveDown || null,
            leaveLeft: options.leaveLeft || null,
            leaveRight: options.leaveRight || null,
            // Custom selector
            selector: options.selector || FOCUSABLE_SELECTOR
        };

        this._sections.set(name, config);
        console.log(`FocusManager: Registered section "${name}"`);
    }

    /**
     * Unregister a section
     * @param {string} name 
     */
    unregister(name) {
        this._sections.delete(name);
        this._focusMemory.delete(name);
        // CRITICAL: Clear cache to prevent returning detached elements if section name is reused
        this.invalidateCache(name);

        if (this._activeSection === name) this._activeSection = null;
    }

    /**
     * Clear cached DOM references
     */
    resetDOMCache() {
        this._pageContent = null;
        this._focusablesCache.clear();
    }

    /**
     * Set the active section and focus inside it
     * @param {string} name 
     * @param {boolean} restoreFocus 
     */
    setActiveSection(name, restoreFocus = true) {
        if (!this._sections.has(name)) {
            console.warn(`FocusManager: Unknown section "${name}"`);
            return;
        }

        this._activeSection = name;
        eventBus.emit('focus:sectionChanged', name);

        if (restoreFocus) {
            this._restoreFocus(name);
        }
    }

    /**
     * Get focusable elements in section (OPTIMIZED)
     * Uses cache to avoid repeated expensive DOM queries.
     * @param {string} sectionName 
     * @param {boolean} forceRefresh - Force cache refresh
     */
    _getFocusables(sectionName, forceRefresh = false) {
        const config = this._sections.get(sectionName);
        if (!config || !document.contains(config.container)) return [];

        // Return cached if available and not forcing refresh
        if (!forceRefresh && this._focusablesCache.has(sectionName)) {
            return this._focusablesCache.get(sectionName);
        }

        // Query focusables - rely on tabindex for visibility (much faster)
        // Skip expensive getBoundingClientRect checks
        const focusables = Array.from(
            config.container.querySelectorAll(config.selector)
        ).filter(el => el.offsetParent !== null); // Basic visibility check only

        this._focusablesCache.set(sectionName, focusables);
        return focusables;
    }

    /**
     * Invalidate focusables cache for a section
     * @param {string} sectionName 
     */
    invalidateCache(sectionName) {
        if (sectionName) {
            this._focusablesCache.delete(sectionName);
        } else {
            this._focusablesCache.clear();
        }
    }

    /**
     * Core movement logic
     * @param {string} direction 
     */
    _move(direction) {
        if (!this._activeSection) return;

        const config = this._sections.get(this._activeSection);
        if (!config) return;

        const focusables = this._getFocusables(this._activeSection);
        if (!focusables.length) return;

        // If nothing focused, focus first available
        if (!this._focusedElement || !config.container.contains(this._focusedElement)) {
            this.focusElement(focusables[0]);
            return;
        }

        const currentIndex = focusables.indexOf(this._focusedElement);
        let nextElement = null;

        // 1. Check Forced Leave (e.g. leaveUp: 'other-section')
        // We only do this if we are at the edge, OR if it's not a grid/spatial navigation
        // Actually, let's keep it simple: Try to move internally first. If fail, then leave.

        // Handling strict orientations
        if (config.orientation === 'horizontal') {
            if (direction === 'left') {
                if (currentIndex > 0) nextElement = focusables[currentIndex - 1];
            } else if (direction === 'right') {
                if (currentIndex < focusables.length - 1) nextElement = focusables[currentIndex + 1];
            }
        }
        else if (config.orientation === 'vertical') {
            if (direction === 'up') {
                if (currentIndex > 0) nextElement = focusables[currentIndex - 1];
            } else if (direction === 'down') {
                if (currentIndex < focusables.length - 1) nextElement = focusables[currentIndex + 1];
            }
        }
        else {
            // 'grid' or default - Use Spatial Navigation
            nextElement = this._findSpatialNext(this._focusedElement, focusables, direction);
        }

        // 2. If we found a target, move to it
        if (nextElement) {
            this.focusElement(nextElement);
            return;
        }

        // 3. If no target found inside, try to leave section
        this._leaveSection(direction);
    }

    /**
     * Spatial Navigation: Find best candidate in direction
     * Uses "Cone" + "Projected Distance" logic
     */
    _findSpatialNext(current, candidates, direction) {
        const rect1 = current.getBoundingClientRect();
        const center1 = {
            x: rect1.left + rect1.width / 2,
            y: rect1.top + rect1.height / 2
        };

        let bestCandidate = null;
        let minScore = Infinity;

        // Filter for candidates in the cone
        for (const candidate of candidates) {
            if (candidate === current) continue;

            const rect2 = candidate.getBoundingClientRect();
            const center2 = {
                x: rect2.left + rect2.width / 2,
                y: rect2.top + rect2.height / 2
            };

            // Calculate vector
            const dx = center2.x - center1.x;
            const dy = center2.y - center1.y;

            // 1. Check Direction
            let isValid = false;
            let distMain = 0;  // parallel to direction
            let distCross = 0; // perpendicular to direction

            if (direction === 'right') {
                // Must be roughly to the right
                if (dx > 0) {
                    isValid = true;
                    distMain = dx;
                    distCross = Math.abs(dy);
                }
            } else if (direction === 'left') {
                if (dx < 0) {
                    isValid = true;
                    distMain = Math.abs(dx);
                    distCross = Math.abs(dy);
                }
            } else if (direction === 'down') {
                if (dy > 0) {
                    isValid = true;
                    distMain = dy;
                    distCross = Math.abs(dx);
                }
            } else if (direction === 'up') {
                if (dy < 0) {
                    isValid = true;
                    distMain = Math.abs(dy);
                    distCross = Math.abs(dx);
                }
            }

            if (!isValid) continue;

            // 2. Cone Check
            // Verify candidate is within a reasonable angle (e.g., 45 degrees)
            // If cross distance > main distance, it's > 45 degrees.
            // We relax this slightly for close elements to allow reaching diagonal neighbors if necessary,
            // but strict grid navigation usually prefers < 45 deg.

            // However, to fix "skipping", we want to favor elements that are "in line".
            // i.e., distCross should be small.

            // Scoring Function:
            // Score = distMain + (distCross * WEIGHT)
            // Weight > 1 penalizes off-axis elements.
            // Weight ~ 2-3 is usually good.

            // Additional: Overlap Bonus
            // If the element overlaps on the cross-axis, it's definitely the intended target.
            // e.g. moving Right, and the next element has Y-overlap -> huge bonus.

            let overlap = 0;
            if (direction === 'left' || direction === 'right') {
                // Check Y overlap
                const top = Math.max(rect1.top, rect2.top);
                const bottom = Math.min(rect1.bottom, rect2.bottom);
                overlap = Math.max(0, bottom - top);
            } else {
                // Check X overlap
                const left = Math.max(rect1.left, rect2.left);
                const right = Math.min(rect1.right, rect2.right);
                overlap = Math.max(0, right - left);
            }

            // If effective overlap (covers > 30% of source or dest), reduce cross penalty
            if (overlap > 0) {
                distCross = 0; // It is "aligned"
            }

            // Calculate final score
            const score = distMain + (distCross * 3.0);

            if (score < minScore) {
                minScore = score;
                bestCandidate = candidate;
            }
        }

        return bestCandidate;
    }

    /**
     * Leave current section (OPTIMIZED)
     * Uses instant scroll when changing sections vertically.
     * @param {string} direction 
     */
    _leaveSection(direction) {
        const config = this._sections.get(this._activeSection);
        if (!config) return;

        const key = `leave${direction.charAt(0).toUpperCase() + direction.slice(1)}`;
        const nextSection = config[key];

        if (nextSection && this._sections.has(nextSection)) {
            // Unfocus current
            if (this._focusedElement) {
                this._focusedElement.classList.remove('focused');
            }

            // Set flag for instant scroll when changing rows
            this._useInstantScroll = (direction === 'up' || direction === 'down');
            this.setActiveSection(nextSection);
            this._useInstantScroll = false;
        }
    }

    /**
     * Focus a specific element (OPTIMIZED per Samsung Tizen Guidelines)
     * - Cache DOM queries
     * - Batch reads before writes  
     * - Scroll first, then focus
     */
    focusElement(element, options = {}) {
        if (!element) return;

        const defaults = { scroll: true, skipScroll: false };
        options = { ...defaults, ...options };

        // Cleanup old focus FIRST (lightweight)
        if (this._focusedElement && this._focusedElement !== element) {
            this._focusedElement.classList.remove('focused');
        }

        // SAMSUNG OPTIMIZATION: Cache page-content DOM reference
        // Check if cached content is still valid (attached to DOM)
        if (this._pageContent && !document.contains(this._pageContent)) {
            this._pageContent = null;
        }

        if (!this._pageContent) {
            this._pageContent = document.querySelector('.page-content');
        }
        const pageContent = this._pageContent;

        // SCROLL FIRST - before focus
        if (options.skipScroll && pageContent) {
            // For vertical row changes: scroll row section into view
            const row = element.closest('.media-row');
            if (row) {
                // SAMSUNG: Batch all reads first
                const rowTop = row.offsetTop;
                const rowHeight = row.offsetHeight;
                const rowBottom = rowTop + rowHeight;

                const viewHeight = pageContent.clientHeight;
                const currentScroll = pageContent.scrollTop;
                const viewBottom = currentScroll + viewHeight;

                // Check visibility with padding/buffer
                const topCutoff = rowTop < currentScroll + 50;  // 50px buffer at top
                const bottomCutoff = rowBottom > viewBottom - 50; // 50px buffer at bottom

                // If cut off at bottom, scroll down JUST enough to show it
                // Align bottom of row with bottom of view (minus padding)
                if (bottomCutoff) {
                    const padding = 60; // Bottom buffer
                    const targetScroll = rowBottom - viewHeight + padding;
                    pageContent.scrollTop = Math.max(0, targetScroll);
                }
                // If cut off at top, scroll up JUST enough to show it
                // Align top of row with top of view (minus padding)
                else if (topCutoff) {
                    const padding = 100; // Top buffer (larger for title visibility)
                    pageContent.scrollTop = Math.max(0, rowTop - padding);
                }
            }
        } else if (options.scroll) {
            // For horizontal navigation within row
            const rowItems = element.closest('.row-items');
            if (rowItems) {
                // SAMSUNG: Batch all reads first
                const elementLeft = element.offsetLeft;
                const elementWidth = element.offsetWidth;
                const containerWidth = rowItems.clientWidth;

                // Then write
                const targetScroll = elementLeft - (containerWidth / 2) + (elementWidth / 2);
                rowItems.scrollLeft = Math.max(0, targetScroll);
            }
        }

        // NOW set focus (after scroll is done)
        this._focusedElement = element;
        this._focusedElement.classList.add('focused');
        this._focusedElement.focus({ preventScroll: true });

        this._updateFocusMemory();
        eventBus.emit('focus:changed', element);
    }

    _updateFocusMemory() {
        if (!this._activeSection || !this._focusedElement) return;
        const config = this._sections.get(this._activeSection);

        if (config.container.contains(this._focusedElement)) {
            const focusables = this._getFocusables(this._activeSection);
            const index = focusables.indexOf(this._focusedElement);
            this._focusMemory.set(this._activeSection, {
                element: this._focusedElement,
                index
            });
        }
    }

    _restoreFocus(sectionName) {
        const memory = this._focusMemory.get(sectionName);
        const focusables = this._getFocusables(sectionName);
        if (!focusables.length) return;

        let target = focusables[0];

        if (memory) {
            // 1. Try exact element
            if (document.contains(memory.element) && focusables.includes(memory.element)) {
                target = memory.element;
            }
            // 2. Try index
            else if (memory.index >= 0 && memory.index < focusables.length) {
                target = focusables[memory.index];
            }
        }

        // Use skipScroll when changing sections vertically (much faster)
        this.focusElement(target, { skipScroll: this._useInstantScroll });
    }

    _activate() {
        if (this._focusedElement) {
            // Dispatch click
            this._focusedElement.click();
            eventBus.emit('focus:activated', this._focusedElement);
        }
    }

    pushTrap(container) {
        this._trapStack.push({
            section: this._activeSection,
            element: this._focusedElement
        });
        this.register('__trap__', container, { orientation: 'grid' });
        this.setActiveSection('__trap__');
    }

    popTrap() {
        const prev = this._trapStack.pop();
        this.unregister('__trap__');
        if (prev) {
            this.setActiveSection(prev.section, false);
            if (prev.element && document.contains(prev.element)) {
                this.focusElement(prev.element);
            }
        }
    }

    getActiveSection() { return this._activeSection; }
    getFocused() { return this._focusedElement; }

    destroy() {
        document.removeEventListener('keydown', this._onKeyDown);
        this._sections.clear();
        this._focusMemory.clear();
    }
}

export const focusManager = new FocusManager();
export default FocusManager;
