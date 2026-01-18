/**
 * ============================================================================
 * LiteFin Tizen - Router
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
    }

    /**
     * Initialize the router - call once on app start
     */
    init() {
        window.addEventListener('hashchange', this._onHashChange);

        // Handle initial route
        this._onHashChange();

        console.log('Router: Initialized');
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

        console.log(`Router: Registered route "${pattern}"`);
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

        if (replace) {
            // Replace current hash without adding to history
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

            // Navigate to previous page
            const previousPath = this._history.pop();
            this.navigate(previousPath, { replace: true });
            return true;
        }

        return false;
    }

    /**
     * Get current route path
     * @returns {string} Current path without the hash
     */
    getCurrentPath() {
        return window.location.hash.slice(1) || '/';
    }

    /**
     * Handle hash change events
     * @private
     */
    _onHashChange() {
        const path = this.getCurrentPath();

        console.log(`Router: Navigating to "${path}"`);

        // Find matching route
        for (const route of this._routes) {
            const match = path.match(route.regex);

            if (match) {
                // Extract params
                const params = {};
                route.paramNames.forEach((name, index) => {
                    params[name] = match[index + 1];
                });

                // Destroy current page
                if (this._currentPage && typeof this._currentPage.destroy === 'function') {
                    this._currentPage.destroy();
                }

                // Add to history
                this._history.push(path);
                if (this._history.length > this._maxHistory) {
                    this._history.shift();
                }

                // Create new page instance
                this._currentPage = new route.PageClass();

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
        console.warn(`Router: No route found for "${path}"`);
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

// Also export class for testing
export default Router;
