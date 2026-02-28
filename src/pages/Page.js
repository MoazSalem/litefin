/**
 * ============================================================================
 * Litefin Tizen - Base Page Class
 * ============================================================================
 * Base class for all pages. Extends Component with page-specific features:
 * - Route parameter handling
 * - Focus section registration
 * - Back navigation handling
 * ============================================================================
 */

import Component from '../core/Component.js';
import { eventBus } from '../core/EventBus.js';
import { focusManager } from '../ui/FocusManager.js';
import { router } from '../core/Router.js';
import { navigationState } from '../core/NavigationState.js';
import CardRenderer from '../utils/CardRenderer.js';
import { logger } from '../utils/Logger.js';

const log = logger.create('Page');

class Page extends Component {
    /**
     * Create a page
     * @param {Object} [options] - Page options
     */
    constructor(options = {}) {
        super(options);

        // Route parameters
        this.params = {};

        // Page title
        this.title = '';

        // Registered focus sections for this page
        this._focusSections = [];

        // Promise to track when the page is fully rendered and ready for interaction
        this._readyResolve = null;
        this.ready = new Promise((resolve) => {
            this._readyResolve = resolve;
        });

        // Back handler
        // REMOVED: App.js handles this directly
        // this._onBack = this._onBack.bind(this);
    }

    /**
     * Mark the page as fully loaded and rendered.
     */
    markReady() {
        if (this._readyResolve) {
            this._readyResolve();
            this._readyResolve = null;
        }

        // Ensure DOM has painted the new state before revealing it
        setTimeout(() => {
            eventBus.emit('app:hideSplash');
        }, 10);
    }

    /**
     * Initialize the page with route params
     * Called by router after construction
     * @param {Object} params - Route parameters
     */
    init(params = {}) {
        this.params = params;

        // Get main container
        this.container = document.getElementById('page-container') || document.getElementById('app');

        // Mount the page
        this.mount();

        // Register back handler
        // REMOVED: App.js now coordinates back events
        // eventBus.on('key:back', this._onBack);

        // Set document title
        if (this.title) {
            document.title = `${this.title} - Litefin`;
        }

        // PHASE 1: Restore page-specific state BEFORE onInit
        // This ensures filters, sort, pagination are set before content loads
        const pendingState = router._isBackNavigation ? router._pendingRestoreState : null;
        if (pendingState) {
            navigationState.restorePageState(this, pendingState);
            // Store for deferred restoration (async pages)
            this._pendingNavState = pendingState;
        }

        // Clear router flags immediately
        if (router._isBackNavigation) {
            router._pendingRestoreState = null;
            router._isBackNavigation = false;
        }

        // Call page-specific initialization (may be async)
        // If page is sync, _pendingNavState will be consumed below
        // If page is async, page must call restoreScrollFocusWhenReady() after content loads
        this.onInit();

        // PHASE 2: For SYNC pages, restore scroll/focus immediately
        // Async pages should call restoreScrollFocusWhenReady() themselves
        // We use a small delay to allow sync onInit to complete
        if (this._pendingNavState && !this._isAsyncPage) {
            requestAnimationFrame(() => {
                if (this._pendingNavState) {
                    navigationState.restoreScrollFocus(this, this._pendingNavState);
                    this._pendingNavState = null;
                }
            });
        }
    }

    /**
     * Call this from async pages after content is fully loaded
     * to trigger scroll/focus restoration
     */
    restoreScrollFocusWhenReady() {
        if (this._pendingNavState) {
            log.debug('Restoring scroll/focus (deferred)');
            navigationState.restoreScrollFocus(this, this._pendingNavState);
            this._pendingNavState = null;
        }
    }

    /**
     * Override in subclass for page-specific init
     */
    onInit() {}

    /**
     * Handle back button press
     * Override for custom behavior
     * @returns {boolean} True if handled, False to trigger default router back
     */
    onBack() {
        return false; // Not handled by default
    }

    /**
     * Get page-specific state for navigation history.
     * Override in subclass to save filters, sort, pagination, etc.
     * @returns {Object|null} State object or null
     */
    getNavigationState() {
        return null;
    }

    /**
     * Restore page-specific state from navigation history.
     * Override in subclass to restore filters, sort, pagination, etc.
     * Called BEFORE scroll/focus restoration, so DOM changes happen first.
     * @param {Object} state - Previously captured state
     */
    setNavigationState(state) {
        // Override in subclass
    }

    /**
     * Register a focus section for this page
     * @param {string} name - Section name
     * @param {HTMLElement} container - Section container
     * @param {Object} [options] - Focus options
     */
    registerFocusSection(name, container, options = {}) {
        focusManager.register(name, container, options);
        this._focusSections.push(name);
    }

    /**
     * Set the active focus section
     * @param {...any} args - Arguments passed to focusManager.setActiveSection
     */
    setActiveSection(...args) {
        focusManager.setActiveSection(...args);
    }

    /**
     * Clean up the page
     */
    destroy() {
        // Unregister focus sections
        for (const name of this._focusSections) {
            focusManager.unregister(name);
        }
        this._focusSections = [];

        // Remove back handler
        eventBus.off('key:back', this._onBack);

        // Remove the page's DOM element gracefully
        if (this.el && this.el.parentNode) {
            this.el.parentNode.removeChild(this.el);
        }

        // Call parent destroy
        super.destroy();
    }

    setLoading(show) {
        if (!this.el) return;

        const isCurrentlyLoading = this.el.classList.contains('loading');

        if (show) {
            // Reuse existing loader if present — never re-create the
            // DOM element, because that restarts the CSS animation.
            let loader = this.el.querySelector('.page-loading');
            if (!loader) {
                loader = document.createElement('div');
                loader.className = 'page-loading';
                loader.innerHTML = '<div class="loading-spinner"></div>';
                this.el.appendChild(loader);
            }

            // Only toggle the class if not already loading (prevents
            // redundant style recalcs from repeated setLoading(true) calls)
            if (!isCurrentlyLoading) {
                this.el.classList.add('loading');
            }
        } else if (isCurrentlyLoading) {
            this.el.classList.remove('loading');

            // Ensure DOM has painted the new state before revealing it
            setTimeout(() => {
                eventBus.emit('app:hideSplash');
            }, 10);
        }
    }

    /**
     * Show error message
     * @param {string} message - Error message
     */
    showError(message) {
        const errorEl = this.$('.page-error');
        if (errorEl) {
            errorEl.textContent = message;
            errorEl.style.display = 'block';
        }
    }

    /**
     * Hide error message
     */
    hideError() {
        const errorEl = this.$('.page-error');
        if (errorEl) {
            errorEl.style.display = 'none';
        }
    }
    /**
     * Render a standard media card
     * Unified method for Home and Details pages
     */
    _renderMediaCard(item, isLandscape = false, type = 'poster', contextType = null) {
        return CardRenderer.createCardHtml(item, { isLandscape, type, contextType });
    }
}

export default Page;
