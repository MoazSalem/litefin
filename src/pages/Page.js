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

        // Back handler
        // REMOVED: App.js handles this directly
        // this._onBack = this._onBack.bind(this);
    }

    /**
     * Initialize the page with route params
     * Called by router after construction
     * @param {Object} params - Route parameters
     */
    init(params = {}) {
        this.params = params;

        // Get main container
        this.container = document.getElementById('app');

        // IMPORTANT: Clear the container (removes loading screen)
        this.container.innerHTML = '';

        // Mount the page
        this.mount();

        // Register back handler
        // REMOVED: App.js now coordinates back events
        // eventBus.on('key:back', this._onBack);

        // Set document title
        if (this.title) {
            document.title = `${this.title} - Litefin`;
        }

        // Call page-specific initialization
        this.onInit();
    }

    /**
     * Override in subclass for page-specific init
     */
    onInit() { }

    /**
     * Handle back button press
     * Override for custom behavior
     * @returns {boolean} True if handled, False to trigger default router back
     */
    onBack() {
        return false; // Not handled by default
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
     * @param {string} name - Section name
     */
    setActiveSection(name) {
        focusManager.setActiveSection(name);
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

        // Call parent destroy
        super.destroy();
    }

    /**
     * Show loading state
     * @param {boolean} show - Show or hide
     */
    setLoading(show) {
        if (show) {
            this.el?.classList.add('loading');
        } else {
            this.el?.classList.remove('loading');
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
}

export default Page;
