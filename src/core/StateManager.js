/**
 * ============================================================================
 * FastFin Tizen - StateManager
 * ============================================================================
 * Simple observable state container with reactive updates. Components can
 * subscribe to state changes and automatically update when values change.
 * 
 * Usage:
 *   state.set('user', { name: 'John' });
 *   state.get('user');  // { name: 'John' }
 *   state.subscribe('user', (newValue, oldValue) => { ... });
 * ============================================================================
 */

import { eventBus } from './EventBus.js';

class StateManager {
    constructor() {
        // Internal state storage
        this._state = new Map();

        // Subscriber callbacks per key
        this._subscribers = new Map();
    }

    /**
     * Get the current value for a state key
     * @param {string} key - State key
     * @param {*} [defaultValue] - Default value if key doesn't exist
     * @returns {*} The state value
     */
    get(key, defaultValue = null) {
        return this._state.has(key) ? this._state.get(key) : defaultValue;
    }

    /**
     * Set a state value and notify subscribers
     * @param {string} key - State key
     * @param {*} value - New value to set
     * @param {boolean} [silent=false] - If true, don't notify subscribers
     */
    set(key, value, silent = false) {
        const oldValue = this._state.get(key);

        // Skip if value hasn't changed (shallow comparison)
        if (oldValue === value) return;

        this._state.set(key, value);

        if (!silent) {
            this._notifySubscribers(key, value, oldValue);
        }
    }

    /**
     * Update a state value using a function (useful for objects/arrays)
     * @param {string} key - State key
     * @param {Function} updater - Function that receives old value and returns new value
     */
    update(key, updater) {
        const oldValue = this.get(key);
        const newValue = updater(oldValue);
        this.set(key, newValue);
    }

    /**
     * Delete a state key
     * @param {string} key - State key to delete
     */
    delete(key) {
        if (this._state.has(key)) {
            const oldValue = this._state.get(key);
            this._state.delete(key);
            this._notifySubscribers(key, undefined, oldValue);
        }
    }

    /**
     * Check if a state key exists
     * @param {string} key - State key
     * @returns {boolean} True if key exists
     */
    has(key) {
        return this._state.has(key);
    }

    /**
     * Subscribe to changes on a specific state key
     * @param {string} key - State key to watch
     * @param {Function} callback - Handler receiving (newValue, oldValue)
     * @returns {Function} Unsubscribe function
     */
    subscribe(key, callback) {
        if (!this._subscribers.has(key)) {
            this._subscribers.set(key, []);
        }

        this._subscribers.get(key).push(callback);

        // Return unsubscribe function
        return () => this.unsubscribe(key, callback);
    }

    /**
     * Unsubscribe from state changes
     * @param {string} key - State key
     * @param {Function} callback - The exact handler to remove
     */
    unsubscribe(key, callback) {
        if (!this._subscribers.has(key)) return;

        const subscribers = this._subscribers.get(key);
        const index = subscribers.indexOf(callback);

        if (index > -1) {
            subscribers.splice(index, 1);
        }
    }

    /**
     * Notify all subscribers of a state change
     * @private
     */
    _notifySubscribers(key, newValue, oldValue) {
        // Notify key-specific subscribers
        if (this._subscribers.has(key)) {
            const subscribers = [...this._subscribers.get(key)];
            for (const callback of subscribers) {
                try {
                    callback(newValue, oldValue);
                } catch (error) {
                    console.error(`StateManager: Error in subscriber for "${key}":`, error);
                }
            }
        }

        // Also emit on EventBus for global listeners
        eventBus.emit(`state:${key}`, newValue, oldValue);
    }

    /**
     * Get all state as a plain object (useful for debugging)
     * @returns {Object} Snapshot of all state
     */
    getAll() {
        const result = {};
        for (const [key, value] of this._state) {
            result[key] = value;
        }
        return result;
    }

    /**
     * Clear all state
     */
    clear() {
        this._state.clear();
        this._subscribers.clear();
    }
}

// Export singleton instance for global use
export const state = new StateManager();

// Also export class for testing
export default StateManager;
