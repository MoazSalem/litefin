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
// ============================================================================
// ScrollController integration for unified native / GPU-accelerated scrolling
// ============================================================================
import { scrollController } from '../ui/ScrollController.js';
import { logger } from '../utils/Logger.js';

const log = logger.create('NavigationState');

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

        let focusedEl = focusManager.getFocused();
        let sectionName = focusManager.getSectionForElement(focusedEl);

        // If the user is navigating via the sidebar, their focus is currently on the sidebar block.
        // We actually want to capture what they were focused on IN THE PAGE before they moved
        // to the sidebar.
        if (sectionName === 'sidebar') {
            const prevSection = focusManager.getPreviousSection();
            if (prevSection && prevSection !== 'sidebar') {
                const memory = focusManager._focusMemory.get(prevSection);
                if (memory && memory.element) {
                    focusedEl = memory.element;
                    sectionName = prevSection;
                    if (this._debug) log.debug(`Sidebar intercept: capturing underlying page focus (${prevSection})`);
                }
            }
        }

        const state = {
            // ================================================================
            // Scroll position
            // ================================================================
            // Rather than reading scrollContainer.scrollTop directly (which is
            // always 0 when in GPU-accelerated composite layout mode), we route
            // the read through ScrollController.getVerticalScroll. This resolves
            // the correct translation offset dynamically if GPU scroll is active.
            // ================================================================
            scrollTop: scrollContainer ? scrollController.getVerticalScroll(scrollContainer) : 0,
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
            log.debug('Captured state:', state);
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
            log.debug('Restoring page state:', state.pageState);
        }

        // Pages implement setNavigationState() to handle this
        if (typeof pageInstance.setNavigationState === 'function') {
            pageInstance.setNavigationState(state.pageState);
        }
    }

    /**
     * Restore scroll position and focus.
     * Called AFTER onInit() so DOM is ready.
     * Waits for the page's `ready` Promise to ensure async content is loaded natively.
     * @param {Page} pageInstance - The new page instance
     * @param {Object} state - Previously captured state
     */
    restoreScrollFocus(pageInstance, state) {
        if (!state) return;

        if (this._debug) {
            log.debug('Scheduling scroll/focus restoration:', state);
        }

        const executeRestore = () => {
            // Still use requestAnimationFrame to ensure layout updates are flushed
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    this._doRestoreScrollFocus(pageInstance, state);
                });
            });
        };

        // Await the page's ready signal natively to avoid arbitrary setTimeout
        if (pageInstance && pageInstance.ready) {
            pageInstance.ready.then(executeRestore);
        } else {
            // Fallback for missing promises
            setTimeout(executeRestore, 50);
        }
    }

    /**
     * Internal method that actually performs the restoration.
     * @param {Page} pageInstance - The current page instance
     * @param {Object} state - Previously captured state
     * @private
     */
    _doRestoreScrollFocus(pageInstance, state) {
        if (this._debug) {
            log.debug('Executing scroll/focus restoration');
        }

        // ====================================================================
        // Restore scroll position
        // ====================================================================
        // Under GPU-accelerated vertical scroll layout configurations, setting
        // scrollContainer.scrollTop directly fails to shift the hardware layers
        // and causes visual jumps. We use scrollController.smoothScrollTo with
        // an animation duration of 0 to snap the compositor layers instantly
        // to the saved scroll offset.
        // ====================================================================
        const scrollContainer = this._getScrollContainer(pageInstance);
        if (scrollContainer && state.scrollTop > 0) {
            scrollController.smoothScrollTo(scrollContainer, state.scrollTop, 0, 'vertical');
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

        // Step 2: Restore scroll and focus waiting on the page Promise natively
        pageInstance.ready.then(() => {
            this.restoreScrollFocus(pageInstance, state);
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

        // VIRTUALIZED SUPPORT: Always prefer absolute virtual index
        // over positional array index which fluctuates continuously
        if (element.dataset && element.dataset.virtualIndex !== undefined) {
            return parseInt(element.dataset.virtualIndex, 10);
        }

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
        // First check if the section config defines an explicit index restorer
        // Essential for virtualized lists where querySelector fails since off-screen
        // nodes aren't generated in the DOM yet
        if (state.focusSectionName && state.focusElementIndex >= 0) {
            const config = focusManager._sections.get(state.focusSectionName);
            if (config && typeof config.onRestoreIndex === 'function') {
                if (this._debug) log.debug('Focus restored via onRestoreIndex hook:', state.focusElementIndex);
                focusManager.setActiveSection(state.focusSectionName, false);
                const target = config.onRestoreIndex(state.focusElementIndex);
                if (target) {
                    focusManager.focusElement(target, { skipScroll: true });
                    return;
                }
            }
        }

        // Strategy 1: Try to find element by selector (most reliable)
        if (state.focusElementSelector) {
            const el = document.querySelector(state.focusElementSelector);
            if (el) {
                if (this._debug) {
                    log.debug('Focus restored by selector:', state.focusElementSelector);
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
                        log.debug('Focus restored by index:', clampedIndex);
                    }
                    focusManager.focusElement(target, { skipScroll: true });
                    return;
                }
            }
        }

        // Strategy 3: Let FocusManager handle it (will focus first available)
        if (state.focusSectionName) {
            if (this._debug) {
                log.debug('Focus fallback to section:', state.focusSectionName);
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
        // First priority: Ask the page natively (eliminates generic querySelector misses)
        if (pageInstance && typeof pageInstance.getScrollContainer === 'function') {
            const container = pageInstance.getScrollContainer();
            if (container) return container;
        }

        // Fall back to global page-content
        return document.querySelector('.page-content');
    }
}

// Export singleton
export const navigationState = new NavigationState();
export default NavigationState;
