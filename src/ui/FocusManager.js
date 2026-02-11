/**
 * ============================================================================
 * Litefin Tizen - FocusManager
 * ============================================================================
 * Manages focus navigation for TV remote D-pad control.
 * Uses robust spatial navigation for grid traversal.
 * ============================================================================
 */

import { eventBus } from '../core/EventBus.js';
import { logger } from '../utils/Logger.js';
import { spatialNavigator } from './SpatialNavigator.js';
import { scrollController } from './ScrollController.js';

const log = logger.create('FocusManager');

// Focusable element selector
// Strictly exclude tabindex="-1" from ALL elements (buttons, inputs, etc.)
const FOCUSABLE_SELECTOR = `
    a[href]:not([tabindex="-1"]),
    button:not([disabled]):not([tabindex="-1"]),
    input:not([disabled]):not([tabindex="-1"]),
    select:not([disabled]):not([tabindex="-1"]),
    textarea:not([disabled]):not([tabindex="-1"]),
    [tabindex]:not([tabindex="-1"])
`
    .replace(/\s+/g, ' ')
    .trim();

// ============================================================================
// Constants
// ============================================================================

// Minimum time (ms) between key events to prevent event flooding.
// Keypresses faster than this interval are dropped.
const KEY_DEBOUNCE_MS = 50;

// Maximum number of empty sections to skip through when leaving a section.
// Prevents infinite loops if section linking is misconfigured.
const MAX_SECTION_SKIP_DEPTH = 20;

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

        // Debounce handling - track PREVIOUS move time for rapid navigation detection
        this._lastMoveTime = 0;
        this._prevMoveTime = 0;

        // Suspended flag — when true, all key processing is skipped.
        // Used by components that manage their own focus (e.g. PlayerOSD)
        this._suspended = false;

        // Delegated utilities (extracted from this God Object)
        this._spatial = spatialNavigator;
        this._scroll = scrollController;

        // Initialize
        this._init();
    }

    // _cancelScrollAnimation → moved to ScrollController
    // _smoothScrollTo → moved to ScrollController

    /**
     * Initialize focus manager
     * @private
     */
    _init() {
        // Listen for key events from TizenAdapter
        // PREVENT DEFAULT on all handled keys to avoid browser/native double-handling
        eventBus.on('key:up', (e) => {
            if (this._suspended) return;
            e?.preventDefault();
            this._handleKey('up');
        });
        eventBus.on('key:down', (e) => {
            if (this._suspended) return;
            e?.preventDefault();
            this._handleKey('down');
        });
        eventBus.on('key:left', (e) => {
            if (this._suspended) return;
            e?.preventDefault();
            this._handleKey('left');
        });
        eventBus.on('key:right', (e) => {
            if (this._suspended) return;
            e?.preventDefault();
            this._handleKey('right');
        });

        eventBus.on('key:enter', (e) => {
            if (this._suspended) return;
            e?.preventDefault(); // Prevent native button click (we trigger it manually)
            this._activate();
        });

        // REMOVED: Direct document keydown listener
        // We now rely solely on TizenAdapter -> EventBus to be the Single Source of Truth.
        // This fixes double-handling issues.

        // Track focus changes globally
        document.addEventListener('focusin', (e) => {
            if (this._focusedElement !== e.target) {
                // If trap is active, check if focus is escaping
                if (this._trapStack.length > 0) {
                    const trapConfig = this._sections.get('__trap__');
                    if (trapConfig && !trapConfig.container.contains(e.target)) {
                        // Focus escaped the trap! Force it back
                        log.warn('Focus escaped trap, forcing back');
                        const focusables = this._getFocusables('__trap__', true);
                        if (focusables.length > 0) {
                            this.focusElement(focusables[0]);
                        }
                        return;
                    }
                }

                this._focusedElement = e.target;

                // Auto-sync active section if the element belongs to one (but not during trap)
                if (this._trapStack.length === 0) {
                    const sectionName = this.getSectionForElement(e.target);
                    if (sectionName && this._activeSection !== sectionName) {
                        this._activeSection = sectionName;
                        eventBus.emit('focus:sectionChanged', sectionName);
                        log.debug(`Auto-synced active section to "${sectionName}" via focusin`);
                    }
                }

                this._updateFocusMemory();
            }
        });

        log.info('Initialized (v3 Single Source Rewrite)');
    }

    // REMOVED: _onKeyDown (Redundant)

    /**
     * Handle directional key press
     * @param {string} direction
     */
    _handleKey(direction) {
        // Simple debounce to prevent event flooding
        const now = Date.now();
        if (now - this._lastMoveTime < KEY_DEBOUNCE_MS) return;

        // Track previous move time BEFORE updating current
        // This allows us to detect rapid key holds (moves < 200ms apart)
        this._prevMoveTime = this._lastMoveTime;
        this._lastMoveTime = now;

        // SLIDER HANDLING: When a range input is focused, Left/Right keys
        // should adjust the slider value instead of navigating to other elements.
        // On TV remotes, arrow keys are intercepted by FocusManager before
        // the native <input type="range"> can process them.
        if ((direction === 'left' || direction === 'right') && this._focusedElement) {
            const el = this._focusedElement;
            if (el.tagName === 'INPUT' && el.type === 'range') {
                const step = parseFloat(el.step) || 1;
                const min = parseFloat(el.min) || 0;
                const max = parseFloat(el.max) || 100;
                let value = parseFloat(el.value) || 0;

                // Adjust value based on direction
                if (direction === 'right') {
                    value = Math.min(max, value + step);
                } else {
                    value = Math.max(min, value - step);
                }

                // Apply the new value and fire the input event
                // so that any listeners (e.g. SettingsPage._bindSliderEvents) react
                el.value = value;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                return; // Don't navigate, we handled it
            }
        }

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
            // Directional Entry logic
            enterTo: options.enterTo || null, // 'first' or null (spatial/memory)
            // Custom Override
            onMove: options.onMove || null,
            // Custom Scroll Logic
            scrollOffsetTop: options.scrollOffsetTop || 0,
            // CSS selector for the default element to focus when entering the section.
            // If provided, overrides spatial/memory entry logic.
            // Example: '#sidebar-home' to always land on the Home button.
            defaultFocusSelector: options.defaultFocusSelector || null,
            // Custom selector
            selector: options.selector || FOCUSABLE_SELECTOR
        };

        this._sections.set(name, config);
        this.invalidateCache(name);
        log.debug(`Registered section "${name}"`);
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
        this._focusablesCache.clear();
        this._scroll.resetCache();
    }

    /**
     * Set the active section and focus inside it
     * @param {string} name
     * @param {boolean} restoreFocus
     * @param {HTMLElement} [fromElement] - Element user is coming FROM (for spatial entry)
     */
    setActiveSection(name, restoreFocus = true, fromElement = null, options = {}) {
        if (!this._sections.has(name)) {
            log.warn(`Unknown section "${name}"`);
            return;
        }

        if (this._activeSection && this._activeSection !== name) {
            this._previousSection = this._activeSection;
        }

        this._activeSection = name;
        eventBus.emit('focus:sectionChanged', name);

        if (restoreFocus) {
            this._restoreFocus(name, fromElement, options);
        }
    }

    getPreviousSection() {
        return this._previousSection;
    }

    getActionSection() {
        return this._activeSection;
    } // Alias if needed? No, getActiveSection exists.

    /**
     * Get config for a section
     * @param {string} name
     */
    getSectionConfig(name) {
        return this._sections.get(name);
    }

    // Alias for getSectionConfig
    getConfig(name) {
        return this.getSectionConfig(name);
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

        // Query focusables and filter out hidden elements.
        // TIZEN OPTIMIZATION: Batch all DOM reads (getComputedStyle, offsetParent)
        // before the filter pass to avoid layout thrashing. Each offsetParent
        // access forces a synchronous layout calc — interleaving reads with
        // other work in a loop causes N layout recalcs on TV hardware.
        const allElements = Array.from(config.container.querySelectorAll(config.selector));

        // Pass 1: Batch-read all layout-triggering properties
        const elementData = new Array(allElements.length);
        for (let i = 0; i < allElements.length; i++) {
            const el = allElements[i];
            const style = window.getComputedStyle(el);
            elementData[i] = {
                el,
                display: style.display,
                position: style.position,
                offsetParent: el.offsetParent
            };
        }

        // Pass 2: Pure filtering on cached data — zero DOM access
        const focusables = [];
        for (let i = 0; i < elementData.length; i++) {
            const { el, display, position, offsetParent } = elementData[i];
            // Skip display:none elements
            if (display === 'none') continue;
            // Visible if has an offsetParent, or is position:fixed (no offsetParent)
            if (offsetParent !== null || position === 'fixed') {
                focusables.push(el);
            }
        }

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

        // log.debug(`_move(${direction}) Active: ${this._activeSection}`); // DEBUG LOG

        const config = this._sections.get(this._activeSection);
        if (!config) return;

        // Custom Override Handler
        if (config.onMove) {
            const handled = config.onMove(direction, this._focusedElement);
            if (handled) return; // Handler took care of it (returned true or truthy)
        }

        const focusables = this._getFocusables(this._activeSection);
        if (!focusables.length) return;

        // If nothing focused, focus first available
        if (!this._focusedElement || !config.container.contains(this._focusedElement)) {
            this.focusElement(focusables[0]);
            return;
        }

        const currentIndex = focusables.indexOf(this._focusedElement);
        let nextElement = null;

        // 1. Handling strict orientations
        if (config.orientation === 'horizontal') {
            if (direction === 'left') {
                if (currentIndex > 0) nextElement = focusables[currentIndex - 1];
            } else if (direction === 'right') {
                if (currentIndex < focusables.length - 1) nextElement = focusables[currentIndex + 1];
            }
        } else if (config.orientation === 'vertical') {
            if (direction === 'up') {
                if (currentIndex > 0) nextElement = focusables[currentIndex - 1];
            } else if (direction === 'down') {
                if (currentIndex < focusables.length - 1) nextElement = focusables[currentIndex + 1];
            }
        } else {
            // 'grid' or default — delegate to SpatialNavigator
            nextElement = this._spatial.findNext(this._focusedElement, focusables, direction);
        }

        // 2. If we found a target, move to it
        if (nextElement) {
            this.focusElement(nextElement);
            // Track timing AFTER focus for next rapid-scroll detection
            this._lastMoveTime = Date.now();
            return;
        }

        log.debug(`No valid target in section. Leaving section: ${direction}`);

        // 3. If no target found inside, try to leave section
        this._leaveSection(direction);
    }

    // _findSpatialNext → moved to SpatialNavigator
    // _findSpatialClosest → moved to SpatialNavigator

    /**
     * Leave current section (OPTIMIZED)
     * Uses instant scroll when changing sections vertically.
     * @param {string} direction
     */
    _leaveSection(direction) {
        const config = this._sections.get(this._activeSection);
        if (!config) return;

        const key = `leave${direction.charAt(0).toUpperCase() + direction.slice(1)}`;
        let nextSection = config[key];

        log.debug(`_leaveSection: direction=${direction}, key=${key}, nextSection=${nextSection}`);

        // Keep searching if target section exists but has no focusable elements
        // This handles empty rows in library grids/lists
        const maxSearchDepth = MAX_SECTION_SKIP_DEPTH;
        let searchDepth = 0;

        while (nextSection && this._sections.has(nextSection) && searchDepth < maxSearchDepth) {
            const nextConfig = this._sections.get(nextSection);
            const focusables = this._getFocusables(nextSection, true); // Force refresh

            if (focusables && focusables.length > 0) {
                // Found a valid section with focusable elements!
                // log.debug(
                //    `_leaveSection: Found valid section ${nextSection} with ${focusables.length} focusables`
                // );
                break;
            }

            // Section is empty, try to skip to the next one in the same direction
            log.debug(`_leaveSection: Section ${nextSection} is empty, skipping...`);
            const skipToSection = nextConfig ? nextConfig[key] : null;

            if (!skipToSection || !this._sections.has(skipToSection)) {
                // No more sections to skip to
                nextSection = null;
                break;
            }

            nextSection = skipToSection;
            searchDepth++;
        }

        if (nextSection && this._sections.has(nextSection)) {
            const originElement = this._focusedElement; // Capture for spatial handover

            // Unfocus current
            if (this._focusedElement) {
                this._focusedElement.classList.remove('focused');
            }

            // Pass instantScroll as parameter (not a class field) to avoid
            // fragile state if the call chain ever becomes async
            const instantScroll = direction === 'up' || direction === 'down';

            // Pass originElement to allow selecting closest target in new section
            this.setActiveSection(nextSection, true, originElement, { instantScroll });
        } else if (direction === 'up') {
            // No section to navigate to (at top of page)
            // Still scroll to top to show full backdrop as visual feedback
            const scrollContainer = this._scroll.getScrollContainer(this._focusedElement);
            if (scrollContainer && scrollContainer.scrollTop > 0) {
                this._scroll.smoothScrollTo(scrollContainer, 0);
            }
        }
    }

    // _getScrollContainer → moved to ScrollController

    /**
     * Focus a specific element (OPTIMIZED per Samsung Tizen Guidelines)
     * Coordinates cleanup, section switching, scroll delegation, and focus.
     */
    focusElement(element, options = {}) {
        if (!element) return;

        const defaults = { scroll: true, skipScroll: false };
        options = { ...defaults, ...options };

        // Cleanup old focus FIRST (lightweight)
        // TIZEN FIX: Explicitly blur the old element to remove native :focus state
        if (this._focusedElement && this._focusedElement !== element) {
            this._focusedElement.classList.remove('focused');
            this._focusedElement.blur(); // Clear native :focus styling on Tizen
        }

        // Get section config for custom scroll offsets
        const sectionName = this.getSectionForElement(element);
        const config = sectionName ? this._sections.get(sectionName) : null;

        // Auto-switch active section if:
        // 1. Element belongs to a section
        // 2. We are not already in that section
        // 3. We are NOT currently in a Trap (Traps manage their own focus)
        if (sectionName && this._activeSection !== sectionName) {
            // Check if we are in a trap (don't switch if we are, unless we're popping)
            const isTrapped = this._trapStack.length > 0 && this._activeSection === '__trap__';

            if (!isTrapped) {
                log.debug(`focusElement: Switching active section from "${this._activeSection}" to "${sectionName}"`);
                this.setActiveSection(sectionName, false); // false = Don't trigger restoreFocus (prevent loop)
            } else {
                log.debug(
                    `focusElement: Staying in trap "${this._activeSection}" despite element belonging to "${sectionName}"`
                );
            }
        }

        // Delegate scroll positioning to ScrollController
        // Passes section config for custom offsets (scrollOffsetTop, etc.)
        this._scroll.scrollIntoView(element, config || {}, options);

        // NOW set focus (after scroll is done)
        this._focusedElement = element;

        // NOW modify the DOM (Dirty the layout)
        this._focusedElement.classList.add('focused');

        // NATIVE FOCUS DISABLED: eliminates scroll rebounding/fighting on Tizen
        // FocusManager handles all input internally via EventBus.
        // this._focusedElement.focus({ preventScroll: true });

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

    _restoreFocus(sectionName, fromElement = null, options = {}) {
        const config = this._sections.get(sectionName);
        if (!config) return;

        const focusables = this._getFocusables(sectionName);
        const memory = this._focusMemory.get(sectionName);
        if (!focusables.length) return;

        // Whether to skip scroll (passed from _leaveSection for vertical transitions)
        const skipScroll = !!options.instantScroll;

        // 0. Default Focus Selector (config-driven, replaces hardcoded section checks)
        // If a section specifies defaultFocusSelector, always focus that element on entry.
        // Example: sidebar uses '#sidebar-home' to always land on Home.
        if (config.defaultFocusSelector) {
            const defaultEl = focusables.find((el) => el.matches(config.defaultFocusSelector));
            const target = defaultEl || focusables[0];
            this.focusElement(target, { skipScroll: true });
            return;
        }

        let target = null;

        // 1. Forced Entry Logic (Highest Priority)
        // Support 'first' or 'active-element' (finds .active or .selected)
        if (config.enterTo === 'first' && focusables.length > 0) {
            target = focusables[0];
            this.focusElement(target, { skipScroll });
            return;
        } else if (config.enterTo === 'active-element' && focusables.length > 0) {
            target =
                focusables.find((el) => el.classList.contains('active') || el.classList.contains('selected')) ||
                focusables[0];
            this.focusElement(target, { skipScroll });
            return;
        }

        // 2. Spatial Entry
        // If we came from another element (e.g. Button below grid), pick closest grid item
        if (fromElement && document.contains(fromElement)) {
            target = this._spatial.findClosest(fromElement, focusables);
        }

        // 3. Memory (Fallback)
        if (!target && memory) {
            // Try exact element
            if (document.contains(memory.element) && focusables.includes(memory.element)) {
                target = memory.element;
            }
            // Try index
            else if (memory.index >= 0 && memory.index < focusables.length) {
                target = focusables[memory.index];
            }
        }

        // 4. Default (First Item)
        if (!target) {
            target = focusables[0];
        }

        // Use skipScroll when changing sections vertically (much faster)
        this.focusElement(target, { skipScroll });
    }

    _activate() {
        if (this._suspended) return;
        if (this._focusedElement) {
            // Dispatch click
            this._focusedElement.click();
            eventBus.emit('focus:activated', this._focusedElement);
        }
    }

    // ========================================================================
    // Suspend / Resume
    // ========================================================================

    /**
     * Suspend all key event processing.
     * Used by components that manage their own focus (e.g. PlayerOSD)
     * to prevent FocusManager from double-handling key events.
     */
    suspend() {
        this._suspended = true;
        log.info('Key processing suspended');
    }

    /**
     * Resume key event processing after a prior suspend() call.
     */
    resume() {
        this._suspended = false;
        log.info('Key processing resumed');
    }

    pushTrap(container, options = {}) {
        this._trapStack.push({
            section: this._activeSection,
            element: this._focusedElement
        });
        this.register('__trap__', container, {
            orientation: options.orientation || 'grid',
            selector: options.selector || undefined,
            // Explicitly block all leaving directions
            leaveUp: null,
            leaveDown: null,
            leaveLeft: null,
            leaveRight: null
        });
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

    getActiveSection() {
        return this._activeSection;
    }
    getFocused() {
        return this._focusedElement;
    }

    /**
     * Find the registered section name that contains the element
     * @param {HTMLElement} element
     */
    getSectionForElement(element) {
        if (!element) return null;

        // Fast path: check active section first (most lookups are for the current section)
        if (this._activeSection) {
            const activeConfig = this._sections.get(this._activeSection);
            if (activeConfig && activeConfig.container.contains(element)) {
                return this._activeSection;
            }
        }

        // Fallback: linear scan through all sections
        for (const [name, config] of this._sections.entries()) {
            if (name === this._activeSection) continue; // Already checked
            if (config.container.contains(element)) {
                return name;
            }
        }
        return null;
    }

    destroy() {
        // document.removeEventListener('keydown', this._onKeyDown);
        this._sections.clear();
        this._focusMemory.clear();
    }
}

export const focusManager = new FocusManager();
export default FocusManager;
