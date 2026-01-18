/**
 * ============================================================================
 * FastFin Tizen - Component Base Class
 * ============================================================================
 * Base class for all UI components. Provides lifecycle hooks, DOM management,
 * and event handling. Components should extend this class.
 * 
 * Lifecycle:
 *   constructor() -> render() -> mount() -> [updates] -> destroy()
 * 
 * Usage:
 *   class MyComponent extends Component {
 *       render() { return '<div>Hello</div>'; }
 *   }
 * ============================================================================
 */

import { eventBus } from './EventBus.js';

class Component {
    /**
     * Create a new component
     * @param {Object} [options] - Component options
     * @param {HTMLElement} [options.container] - Parent element to mount into
     * @param {Object} [options.props] - Initial props
     */
    constructor(options = {}) {
        // DOM element reference
        this.el = null;

        // Parent container
        this.container = options.container || null;

        // Component props (immutable from parent)
        this.props = options.props || {};

        // Internal state (mutable)
        this._state = {};

        // Event subscriptions for cleanup
        this._subscriptions = [];

        // Child components for cleanup
        this._children = [];

        // Bound methods cache
        this._boundMethods = new Map();

        // Track mounted state
        this._isMounted = false;
    }

    /**
     * Render the component's HTML
     * Override in subclass to return HTML string or element
     * @returns {string|HTMLElement} HTML content
     */
    render() {
        return '';
    }

    /**
     * Mount the component to its container
     * @param {HTMLElement} [container] - Container to mount into (optional if set in constructor)
     */
    mount(container = null) {
        if (container) {
            this.container = container;
        }

        if (!this.container) {
            console.error('Component: Cannot mount without a container');
            return;
        }

        // Render to get HTML
        const content = this.render();

        // Create element from HTML string if needed
        if (typeof content === 'string') {
            const temp = document.createElement('div');
            temp.innerHTML = content.trim();
            this.el = temp.firstChild;
        } else {
            this.el = content;
        }

        // Append to container
        if (this.el) {
            this.container.appendChild(this.el);
        }

        this._isMounted = true;

        // Call mounted lifecycle hook
        this.onMounted();
    }

    /**
     * Update the component - override for reactive updates
     * @param {Object} [newProps] - New props to apply
     */
    update(newProps = {}) {
        // Merge new props
        this.props = { ...this.props, ...newProps };

        // Re-render if mounted
        if (this._isMounted && this.el) {
            const newContent = this.render();

            if (typeof newContent === 'string') {
                this.el.innerHTML = newContent;
            }

            this.onUpdated();
        }
    }

    /**
     * Set internal state and trigger update
     * @param {Object} newState - State updates to merge
     */
    setState(newState) {
        this._state = { ...this._state, ...newState };
        this.update();
    }

    /**
     * Destroy the component and clean up
     */
    destroy() {
        // Call lifecycle hook first
        this.onBeforeDestroy();

        // Destroy child components
        for (const child of this._children) {
            if (typeof child.destroy === 'function') {
                child.destroy();
            }
        }
        this._children = [];

        // Unsubscribe from all events
        for (const unsubscribe of this._subscriptions) {
            if (typeof unsubscribe === 'function') {
                unsubscribe();
            }
        }
        this._subscriptions = [];

        // Remove from DOM
        if (this.el && this.el.parentNode) {
            this.el.parentNode.removeChild(this.el);
        }

        this.el = null;
        this._isMounted = false;

        this.onDestroyed();
    }

    // ========================================================================
    // Lifecycle hooks - override in subclasses
    // ========================================================================

    /**
     * Called after component is mounted to DOM
     */
    onMounted() { }

    /**
     * Called after component updates
     */
    onUpdated() { }

    /**
     * Called before component is destroyed
     */
    onBeforeDestroy() { }

    /**
     * Called after component is destroyed
     */
    onDestroyed() { }

    // ========================================================================
    // Helper methods
    // ========================================================================

    /**
     * Query selector within component
     * @param {string} selector - CSS selector
     * @returns {HTMLElement|null} Found element or null
     */
    $(selector) {
        return this.el ? this.el.querySelector(selector) : null;
    }

    /**
     * Query selector all within component
     * @param {string} selector - CSS selector
     * @returns {NodeList} Found elements
     */
    $$(selector) {
        return this.el ? this.el.querySelectorAll(selector) : [];
    }

    /**
     * Subscribe to an event with auto-cleanup on destroy
     * @param {string} event - Event name
     * @param {Function} handler - Event handler
     */
    on(event, handler) {
        const unsubscribe = eventBus.on(event, handler);
        this._subscriptions.push(unsubscribe);
        return unsubscribe;
    }

    /**
     * Emit an event
     * @param {string} event - Event name
     * @param {...any} args - Event arguments
     */
    emit(event, ...args) {
        eventBus.emit(event, ...args);
    }

    /**
     * Add a child component
     * @param {Component} child - Child component
     */
    addChild(child) {
        this._children.push(child);
    }

    /**
     * Get a bound version of a method (cached for event handlers)
     * @param {string} methodName - Method name to bind
     * @returns {Function} Bound method
     */
    bound(methodName) {
        if (!this._boundMethods.has(methodName)) {
            this._boundMethods.set(methodName, this[methodName].bind(this));
        }
        return this._boundMethods.get(methodName);
    }
}

export default Component;
