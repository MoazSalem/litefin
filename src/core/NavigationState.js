/**
 * ============================================================================
 * Litefin Tizen - NavigationState
 * ============================================================================
 * Centralized service for capturing and restoring page state during navigation.
 * Stores focus position, scroll position, and page-specific state (filters, etc.)
 * in the navigation history stack.
 *
 * Tizen 4 Compatible: No async/await in critical paths, no WeakMap/WeakRef.
 * ============================================================================
 */

import { focusManager } from '../ui/FocusManager.js';

class NavigationState {
    constructor() {
        // Debug logging
        this._debug = true;
    }

    /**
     * Capture current page state before navigating away.
     * Called by Router before destroying the current page.
     * @param {Page} pageInstance - The current page instance
     * @returns {Object} Captured state object
     */
    captureState(pageInstance) {
        // Find the main scroll container
        const scrollContainer = this._getScrollContainer(pageInstance);
        const focusedEl = focusManager.getFocused();
        const sectionName = focusManager.getSectionForElement(focusedEl);

        const state = {
            // Scroll position
            scrollTop: scrollContainer ? scrollContainer.scrollTop : 0,
            scrollLeft: scrollContainer ? scrollContainer.scrollLeft : 0,

            // Focus position
            focusSectionName: sectionName || null,
            focusElementIndex: this._getFocusIndex(focusedEl, sectionName),
            focusElementSelector: this._getSelector(focusedEl),

            // Page-specific state (filters, sort, pagination, etc.)
            // Pages implement getNavigationState() to provide this
            pageState: typeof pageInstance.getNavigationState === 'function' ? pageInstance.getNavigationState() : null
        };

        if (this._debug) {
            console.log('[NavigationState] Captured state:', state);
        }

        return state;
    }

    /**
     * Restore page-specific state (filters, sort, pagination).
     * Called BEFORE onInit() so content loads with correct state.
     * @param {Page} pageInstance - The new page instance
     * @param {Object} state - Previously captured state
     */
    restorePageState(pageInstance, state) {
        if (!state || !state.pageState) return;

        if (this._debug) {
            console.log('[NavigationState] Restoring page state:', state.pageState);
        }

        // Pages implement setNavigationState() to handle this
        if (typeof pageInstance.setNavigationState === 'function') {
            pageInstance.setNavigationState(state.pageState);
        }
    }

    /**
     * Restore scroll position and focus.
     * Called AFTER onInit() so DOM is ready.
     * Uses a delay to ensure focus sections are fully registered.
     * @param {Object} state - Previously captured state
     */
    restoreScrollFocus(state) {
        if (!state) return;

        if (this._debug) {
            console.log('[NavigationState] Scheduling scroll/focus restoration:', state);
        }

        // Use double requestAnimationFrame + setTimeout for robust timing
        // This ensures:
        // 1. Current execution stack completes
        // 2. Two paint cycles pass (for layout)
        // 3. Additional delay for async focus registration to complete
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                // Add a small delay to ensure focus sections are registered
                // (they get registered during render, which may still be async)
                setTimeout(() => {
                    this._doRestoreScrollFocus(state);
                }, 50);
            });
        });
    }

    /**
     * Internal method that actually performs the restoration.
     * @param {Object} state - Previously captured state
     * @private
     */
    _doRestoreScrollFocus(state) {
        if (this._debug) {
            console.log('[NavigationState] Executing scroll/focus restoration');
        }

        // Restore scroll position
        const scrollContainer = document.querySelector('.page-content');
        if (scrollContainer && state.scrollTop > 0) {
            scrollContainer.scrollTop = state.scrollTop;
        }
        if (scrollContainer && state.scrollLeft > 0) {
            scrollContainer.scrollLeft = state.scrollLeft;
        }

        // Restore focus position
        this._restoreFocus(state);
    }

    /**
     * Restore full page state (legacy method, still works).
     * Calls both restorePageState and restoreScrollFocus.
     * @param {Page} pageInstance - The new page instance
     * @param {Object} state - Previously captured state
     * @param {Function} [callback] - Optional callback after restoration
     */
    restoreState(pageInstance, state, callback) {
        if (!state) {
            if (callback) callback();
            return;
        }

        // Step 1: Restore page-specific state
        this.restorePageState(pageInstance, state);

        // Step 2: Restore scroll and focus after DOM is ready
        requestAnimationFrame(() => {
            this.restoreScrollFocus(state);
            if (callback) callback();
        });
    }

    /**
     * Get the index of the focused element within its section.
     * @param {HTMLElement} element - The focused element
     * @param {string} sectionName - The section name
     * @returns {number} Index or -1 if not found
     * @private
     */
    _getFocusIndex(element, sectionName) {
        if (!element || !sectionName) return -1;

        // Use FocusManager's internal method to get focusables
        const focusables = focusManager._getFocusables(sectionName);
        return focusables.indexOf(element);
    }

    /**
     * Generate a selector string for an element.
     * Prioritizes data attributes for stability across content changes.
     * @param {HTMLElement} element - The element
     * @returns {string|null} CSS selector or null
     * @private
     */
    _getSelector(element) {
        if (!element) return null;

        // Priority 1: data-item-id (most stable for media items)
        if (element.dataset.itemId) {
            return `[data-item-id="${element.dataset.itemId}"]`;
        }

        // Priority 2: data-episode-id
        if (element.dataset.episodeId) {
            return `[data-episode-id="${element.dataset.episodeId}"]`;
        }

        // Priority 3: Element ID
        if (element.id) {
            return `#${element.id}`;
        }

        // Priority 4: data-value (for settings options)
        if (element.dataset.value) {
            return `[data-value="${element.dataset.value}"]`;
        }

        // Priority 5: data-action (for buttons)
        if (element.dataset.action) {
            return `[data-action="${element.dataset.action}"]`;
        }

        return null;
    }

    /**
     * Restore focus to the previously focused element.
     * Tries selector first (handles content changes), then falls back to index.
     * @param {Object} state - The captured state object
     * @private
     */
    _restoreFocus(state) {
        // Strategy 1: Try to find element by selector (most reliable)
        if (state.focusElementSelector) {
            const el = document.querySelector(state.focusElementSelector);
            if (el) {
                if (this._debug) {
                    console.log('[NavigationState] Focus restored by selector:', state.focusElementSelector);
                }
                focusManager.focusElement(el, { skipScroll: true });
                return;
            }
        }

        // Strategy 2: Fall back to section + index
        if (state.focusSectionName && state.focusElementIndex >= 0) {
            // First, set the active section
            focusManager.setActiveSection(state.focusSectionName, false);

            // Then find the element at the index (or nearest valid)
            const focusables = focusManager._getFocusables(state.focusSectionName, true);
            if (focusables.length > 0) {
                // Clamp index to valid range (content may have changed)
                const clampedIndex = Math.min(state.focusElementIndex, focusables.length - 1);
                const target = focusables[clampedIndex];

                if (target) {
                    if (this._debug) {
                        console.log('[NavigationState] Focus restored by index:', clampedIndex);
                    }
                    focusManager.focusElement(target, { skipScroll: true });
                    return;
                }
            }
        }

        // Strategy 3: Let FocusManager handle it (will focus first available)
        if (state.focusSectionName) {
            if (this._debug) {
                console.log('[NavigationState] Focus fallback to section:', state.focusSectionName);
            }
            focusManager.setActiveSection(state.focusSectionName);
        }
    }

    /**
     * Find the main scroll container for a page.
     * @param {Page} pageInstance - The page instance
     * @returns {HTMLElement|null} The scroll container
     * @private
     */
    _getScrollContainer(pageInstance) {
        // Try page's own container first
        if (pageInstance.el) {
            const pageContent = pageInstance.el.querySelector('.page-content');
            if (pageContent) return pageContent;
        }

        // Fall back to global page-content
        return document.querySelector('.page-content');
    }
}

// Export singleton
export const navigationState = new NavigationState();
export default NavigationState;
