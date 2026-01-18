/**
 * ============================================================================
 * LiteFin Tizen - FocusManager
 * ============================================================================
 * Manages focus navigation for TV remote D-pad control. Handles:
 * - 2D grid navigation (up/down/left/right)
 * - Focus memory per section
 * - Smooth scroll-into-view
 * - Focus restoration on back navigation
 * 
 * Usage:
 *   focusManager.register('home-row', rowElement);
 *   focusManager.setActiveSection('home-row');
 * ============================================================================
 */

import { eventBus } from '../core/EventBus.js';

// Focusable element selector
const FOCUSABLE_SELECTOR = '[tabindex], a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])';

class FocusManager {
    constructor() {
        // Registered sections: name -> config
        this._sections = new Map();

        // Currently active section
        this._activeSection = null;

        // Focus memory: section -> last focused element info
        this._focusMemory = new Map();

        // Currently focused element
        this._focusedElement = null;

        // Focus trap stack (for modals)
        this._trapStack = [];

        // Bound methods
        this._onKeyDown = this._onKeyDown.bind(this);

        // Setup global key listener
        this._init();
    }

    /**
     * Initialize focus manager
     * @private
     */
    _init() {
        // Listen for key events from TizenAdapter
        eventBus.on('key:up', () => this._move('up'));
        eventBus.on('key:down', () => this._move('down'));
        eventBus.on('key:left', () => this._move('left'));
        eventBus.on('key:right', () => this._move('right'));
        eventBus.on('key:enter', () => this._activate());

        // Also listen for native keydown as fallback
        document.addEventListener('keydown', this._onKeyDown);

        // Track focus changes
        document.addEventListener('focusin', (e) => {
            this._focusedElement = e.target;
            this._updateFocusMemory();
        });

        console.log('FocusManager: Initialized');
    }

    /**
     * Handle keydown events
     * @private
     */
    _onKeyDown(e) {
        switch (e.keyCode) {
            case 38: // Up
                e.preventDefault();
                this._move('up');
                break;
            case 40: // Down
                e.preventDefault();
                this._move('down');
                break;
            case 37: // Left
                e.preventDefault();
                this._move('left');
                break;
            case 39: // Right
                e.preventDefault();
                this._move('right');
                break;
            case 13: // Enter
                this._activate();
                break;
        }
    }

    /**
     * Register a focusable section
     * @param {string} name - Section identifier
     * @param {HTMLElement} container - Section container element
     * @param {Object} [options] - Section options
     * @param {string} [options.orientation='horizontal'] - 'horizontal', 'vertical', or 'grid'
     * @param {boolean} [options.loop=false] - Loop navigation at ends
     * @param {string} [options.leaveUp] - Section to enter when leaving up
     * @param {string} [options.leaveDown] - Section to enter when leaving down
     * @param {string} [options.leaveLeft] - Section to enter when leaving left
     * @param {string} [options.leaveRight] - Section to enter when leaving right
     */
    register(name, container, options = {}) {
        const config = {
            container,
            orientation: options.orientation || 'horizontal',
            loop: options.loop || false,
            leaveUp: options.leaveUp || null,
            leaveDown: options.leaveDown || null,
            leaveLeft: options.leaveLeft || null,
            leaveRight: options.leaveRight || null,
            selector: options.selector || FOCUSABLE_SELECTOR
        };

        this._sections.set(name, config);
        console.log(`FocusManager: Registered section "${name}"`);
    }

    /**
     * Unregister a section
     * @param {string} name - Section name
     */
    unregister(name) {
        this._sections.delete(name);
        this._focusMemory.delete(name);

        if (this._activeSection === name) {
            this._activeSection = null;
        }
    }

    /**
     * Set the active section
     * @param {string} name - Section name
     * @param {boolean} [restoreFocus=true] - Restore last focused element
     */
    setActiveSection(name, restoreFocus = true) {
        if (!this._sections.has(name)) {
            console.warn(`FocusManager: Unknown section "${name}"`);
            return;
        }

        this._activeSection = name;

        if (restoreFocus) {
            this._restoreFocus(name);
        }

        eventBus.emit('focus:sectionChanged', name);
    }

    /**
     * Get focusable elements in a section
     * @private
     * @param {string} sectionName - Section name
     * @returns {HTMLElement[]} Array of focusable elements
     */
    _getFocusables(sectionName) {
        const config = this._sections.get(sectionName);
        if (!config) return [];

        return Array.from(config.container.querySelectorAll(config.selector))
            .filter(el => {
                // Filter out hidden elements
                const rect = el.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
            });
    }

    /**
     * Move focus in a direction
     * @private
     * @param {string} direction - 'up', 'down', 'left', 'right'
     */
    _move(direction) {
        if (!this._activeSection) return;

        const config = this._sections.get(this._activeSection);
        if (!config) return;

        const focusables = this._getFocusables(this._activeSection);
        if (focusables.length === 0) return;

        const currentIndex = focusables.indexOf(this._focusedElement);
        let nextIndex = currentIndex;

        // Determine movement based on orientation
        const isHorizontalNav = direction === 'left' || direction === 'right';
        const isVerticalNav = direction === 'up' || direction === 'down';

        if (config.orientation === 'horizontal') {
            if (isHorizontalNav) {
                nextIndex = direction === 'left' ? currentIndex - 1 : currentIndex + 1;
            } else {
                // Leave section
                this._leaveSection(direction);
                return;
            }
        } else if (config.orientation === 'vertical') {
            if (isVerticalNav) {
                nextIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
            } else {
                // Leave section
                this._leaveSection(direction);
                return;
            }
        } else {
            // Grid orientation - use spatial navigation
            nextIndex = this._findSpatialNeighbor(focusables, currentIndex, direction);
        }

        // Handle boundaries
        if (nextIndex < 0 || nextIndex >= focusables.length) {
            if (config.loop) {
                nextIndex = nextIndex < 0 ? focusables.length - 1 : 0;
            } else {
                // Try to leave section
                this._leaveSection(direction);
                return;
            }
        }

        // Focus new element
        this.focusElement(focusables[nextIndex]);
    }

    /**
     * Find spatially closest neighbor in direction
     * @private
     */
    _findSpatialNeighbor(focusables, currentIndex, direction) {
        if (currentIndex < 0 || !focusables[currentIndex]) {
            return 0;
        }

        const current = focusables[currentIndex];
        const currentRect = current.getBoundingClientRect();
        const currentCenter = {
            x: currentRect.left + currentRect.width / 2,
            y: currentRect.top + currentRect.height / 2
        };

        let bestIndex = -1;
        let bestScore = Infinity;

        focusables.forEach((el, index) => {
            if (index === currentIndex) return;

            const rect = el.getBoundingClientRect();
            const center = {
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2
            };

            // Check if element is in the right direction
            const dx = center.x - currentCenter.x;
            const dy = center.y - currentCenter.y;

            let inDirection = false;
            switch (direction) {
                case 'up': inDirection = dy < -10; break;
                case 'down': inDirection = dy > 10; break;
                case 'left': inDirection = dx < -10; break;
                case 'right': inDirection = dx > 10; break;
            }

            if (inDirection) {
                // Calculate distance score (prefer straight lines)
                const distance = Math.sqrt(dx * dx + dy * dy);
                const angle = Math.abs(direction === 'up' || direction === 'down'
                    ? dx / (Math.abs(dy) || 1)
                    : dy / (Math.abs(dx) || 1));

                const score = distance + angle * 100;

                if (score < bestScore) {
                    bestScore = score;
                    bestIndex = index;
                }
            }
        });

        return bestIndex;
    }

    /**
     * Leave current section in a direction
     * @private
     */
    _leaveSection(direction) {
        const config = this._sections.get(this._activeSection);
        if (!config) return;

        const leaveKey = `leave${direction.charAt(0).toUpperCase() + direction.slice(1)}`;
        const nextSection = config[leaveKey];

        if (nextSection && this._sections.has(nextSection)) {
            eventBus.emit('focus:leaveSection', {
                from: this._activeSection,
                to: nextSection,
                direction
            });

            this.setActiveSection(nextSection);
        }
    }

    /**
     * Focus a specific element
     * @param {HTMLElement} element - Element to focus
     * @param {Object} [options] - Focus options
     * @param {boolean} [options.scroll=true] - Scroll into view
     */
    focusElement(element, options = {}) {
        if (!element) return;

        const { scroll = true } = options;

        // Remove focus class from previous
        if (this._focusedElement) {
            this._focusedElement.classList.remove('focused');
        }

        // Apply focus
        element.classList.add('focused');
        element.focus({ preventScroll: !scroll });

        // Smooth scroll into view if needed
        if (scroll) {
            element.scrollIntoView({
                behavior: 'smooth',
                block: 'nearest',
                inline: 'nearest'
            });
        }

        this._focusedElement = element;

        eventBus.emit('focus:changed', element);
    }

    /**
     * Update focus memory for current section
     * @private
     */
    _updateFocusMemory() {
        if (!this._activeSection || !this._focusedElement) return;

        const config = this._sections.get(this._activeSection);
        if (!config) return;

        // Check if focused element is in current section
        if (config.container.contains(this._focusedElement)) {
            this._focusMemory.set(this._activeSection, {
                element: this._focusedElement,
                index: this._getFocusables(this._activeSection).indexOf(this._focusedElement)
            });
        }
    }

    /**
     * Restore focus for a section
     * @private
     */
    _restoreFocus(sectionName) {
        const memory = this._focusMemory.get(sectionName);
        const focusables = this._getFocusables(sectionName);

        if (memory && document.contains(memory.element)) {
            // Element still exists, focus it
            this.focusElement(memory.element);
        } else if (memory && memory.index >= 0 && focusables[memory.index]) {
            // Element gone, but try same index
            this.focusElement(focusables[memory.index]);
        } else if (focusables.length > 0) {
            // No memory, focus first element
            this.focusElement(focusables[0]);
        }
    }

    /**
     * Activate (click/select) the focused element
     * @private
     */
    _activate() {
        if (this._focusedElement) {
            this._focusedElement.click();
            eventBus.emit('focus:activated', this._focusedElement);
        }
    }

    /**
     * Push a focus trap (for modals/dialogs)
     * @param {HTMLElement} container - Container to trap focus in
     */
    pushTrap(container) {
        // Save current state
        this._trapStack.push({
            section: this._activeSection,
            element: this._focusedElement
        });

        // Create temporary section for trap
        this.register('__trap__', container, { orientation: 'grid' });
        this.setActiveSection('__trap__');
    }

    /**
     * Pop focus trap and restore previous focus
     */
    popTrap() {
        const previous = this._trapStack.pop();

        this.unregister('__trap__');

        if (previous) {
            this._activeSection = previous.section;
            if (previous.element && document.contains(previous.element)) {
                this.focusElement(previous.element);
            }
        }
    }

    /**
     * Get currently focused element
     * @returns {HTMLElement|null} Focused element
     */
    getFocused() {
        return this._focusedElement;
    }

    /**
     * Get active section name
     * @returns {string|null} Active section name
     */
    getActiveSection() {
        return this._activeSection;
    }

    /**
     * Clean up
     */
    destroy() {
        document.removeEventListener('keydown', this._onKeyDown);
        this._sections.clear();
        this._focusMemory.clear();
        this._trapStack = [];
    }
}

// Export singleton instance
export const focusManager = new FocusManager();

export default FocusManager;
