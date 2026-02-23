/**
 * ============================================================================
 * Litefin Tizen - Router
 * ============================================================================
 * Simple hash-based router for single-page navigation. Uses URL hash to
 * manage current page state without requiring History API support.
 *
 * Usage:
 *   router.register('/home', HomePage);
 *   router.register('/library/:id', LibraryPage);
 *   router.navigate('/library/movies');
 * ============================================================================
 */

import { eventBus } from './EventBus.js';
import { state } from './StateManager.js';
import { navigationState } from './NavigationState.js';
import { logger } from '../utils/Logger.js';

const log = logger.create('Router');

class Router {
    constructor() {
        // Registered routes: pattern -> handler
        this._routes = [];

        // Current page instance
        this._currentPage = null;

        // Navigation history for back support
        this._history = [];

        // Maximum history length (memory management)
        this._maxHistory = 20;

        // Bind hash change handler
        this._onHashChange = this._onHashChange.bind(this);

        // Navigation state tracking
        // Set to true when navigating back (triggers state restoration)
        this._isBackNavigation = false;
        // State to restore when back navigation completes
        this._pendingRestoreState = null;
    }

    /**
     * Initialize the router - call once on app start
     */
    init() {
        window.addEventListener('hashchange', this._onHashChange);

        // Handle initial route
        this._onHashChange();

        log.info('Initialized');
    }

    /**
     * Clean up router listeners
     */
    destroy() {
        window.removeEventListener('hashchange', this._onHashChange);
    }

    /**
     * Register a route pattern with a page class
     * @param {string} pattern - Route pattern (e.g., '/library/:id')
     * @param {Function} PageClass - Page class to instantiate for this route
     */
    register(pattern, PageClass) {
        // Convert pattern to regex
        // :param becomes a named capture group
        const paramNames = [];
        const regexPattern = pattern.replace(/:([^/]+)/g, (match, paramName) => {
            paramNames.push(paramName);
            return '([^/]+)';
        });

        this._routes.push({
            pattern,
            regex: new RegExp(`^${regexPattern}$`),
            paramNames,
            PageClass
        });

        log.debug(`Registered route "${pattern}"`);
    }

    /**
     * Navigate to a new route
     * @param {string} path - Path to navigate to
     * @param {Object} [options] - Navigation options
     * @param {boolean} [options.replace=false] - Replace current history entry
     * @param {Object} [options.state] - Additional state to pass to the page
     */
    navigate(path, options = {}) {
        const { replace = false, state: pageState = null } = options;

        // Store state for the incoming page
        if (pageState) {
            state.set('router:pageState', pageState);
        }

        // Track this navigation so _onHashChange knows it was expected
        this._lastNavigatePath = path;

        if (replace) {
            // Remove the current entry from internal history so the next one replaces it
            this._history.pop();
            // Replace current hash without adding to browser history
            window.location.replace(`#${path}`);
        } else {
            window.location.hash = path;
        }
    }

    /**
     * Go back to previous page
     * @returns {boolean} True if back was possible
     */
    back() {
        if (this._history.length > 1) {
            // Remove current page from history
            this._history.pop();

            // PEEK the previous entry (it stays in history)
            const previousEntry = this._history[this._history.length - 1];

            // Flag this as a back navigation so Page.js knows to restore state
            this._isBackNavigation = true;

            // Store pending state for restoration
            this._pendingRestoreState = previousEntry ? previousEntry.state : null;

            // Navigate to previous path using REPLACE
            const previousPath = previousEntry ? previousEntry.path : '/';

            // Track this navigation so _onHashChange knows it was expected
            this._lastNavigatePath = previousPath;

            // Use window.location.replace to change hash without triggering push
            window.location.replace(`#${previousPath}`);
            return true;
        }

        return false;
    }

    /**
     * Reset history and navigate to a new path (clears stack)
     * @param {string} path - Path to navigate to
     */
    reset(path) {
        this._history = [];
        this.navigate(path, { replace: true });
    }

    /**
     * Get current route path
     * @returns {string} Current path without the hash
     */
    getCurrentPath() {
        return window.location.hash.slice(1) || '/';
    }

    /**
     * Get current page instance
     * @returns {Page|null} Current page
     */
    getCurrentPage() {
        return this._currentPage;
    }

    /**
     * Handle hash change events
     * @private
     */
    _onHashChange() {
        const path = this.getCurrentPath();

        // Clear expected navigation tracking (used to detect unexpected hash changes)
        this._lastNavigatePath = null;

        log.info(`Navigating to "${path}"`);

        // Find matching route
        for (const route of this._routes) {
            const match = path.match(route.regex);

            if (match) {
                // Extract params
                const params = {};
                route.paramNames.forEach((name, index) => {
                    params[name] = match[index + 1];
                });

                // Capture state from current page before destroying
                // This saves focus, scroll, and page-specific state
                if (this._currentPage) {
                    const capturedState = navigationState.captureState(this._currentPage);

                    // Update the current history entry with captured state
                    const currentEntry = this._history[this._history.length - 1];
                    if (currentEntry && typeof currentEntry === 'object') {
                        currentEntry.state = capturedState;
                    }
                }

                // Destroy current page (after capturing state)
                if (this._currentPage && typeof this._currentPage.destroy === 'function') {
                    this._currentPage.destroy();
                }

                // Add to history as an object with path and state
                // Skip if: back navigation via replace (path already at top)
                if (this._isBackNavigation) {
                    // Clear the flag and skip the push
                    this._isBackNavigation = false;
                } else {
                    const topPath = this._history.length > 0 ? this._history[this._history.length - 1]?.path : null;
                    if (path !== topPath) {
                        // Only push if path is different from top of history
                        this._history.push({ path: path, state: null });
                        if (this._history.length > this._maxHistory) {
                            this._history.shift();
                        }
                    }
                }

                // Create new page instance
                // Handle both class constructors and plain object handlers
                if (typeof route.PageClass === 'function') {
                    // It's a class/constructor - use 'new'
                    this._currentPage = new route.PageClass();
                } else {
                    // It's a plain object with methods (like the '/' redirect route)
                    this._currentPage = route.PageClass;
                }

                // Initialize the page with route params
                if (typeof this._currentPage.init === 'function') {
                    this._currentPage.init(params);
                }

                // Update state
                state.set('router:currentPath', path);
                state.set('router:currentParams', params);

                // Emit navigation event
                eventBus.emit('router:navigate', { path, params });

                return;
            }
        }

        // No matching route - handle 404
        log.warn(`No route found for "${path}"`);
        eventBus.emit('router:notFound', { path });
    }

    /**
     * Check if can go back
     * @returns {boolean} True if there's history to go back to
     */
    canGoBack() {
        return this._history.length > 1;
    }
}

// Export singleton instance
export const router = new Router();

// Expose router on window for components that can't import (e.g., OSD IIFE)
window.router = router;

// Also export class for testing
export default Router;
