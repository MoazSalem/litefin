/**
 * ============================================================================
 * Litefin Tizen - EventBus
 * ============================================================================
 * Global publish/subscribe event system for decoupled communication between
 * components. Enables loose coupling and makes testing easier.
 * 
 * Usage:
 *   EventBus.on('user:login', (user) => console.log('Logged in:', user));
 *   EventBus.emit('user:login', { name: 'John' });
 *   EventBus.off('user:login', handler);
 * ============================================================================
 */

class EventBus {
    constructor() {
        // Map of event names to arrays of listener functions
        this._listeners = new Map();
    }

    /**
     * Subscribe to an event
     * @param {string} event - Event name (supports namespacing like 'user:login')
     * @param {Function} callback - Handler function to call when event fires
     * @returns {Function} Unsubscribe function for cleanup
     */
    on(event, callback) {
        if (!this._listeners.has(event)) {
            this._listeners.set(event, []);
        }

        this._listeners.get(event).push(callback);

        // Return unsubscribe function for easy cleanup
        return () => this.off(event, callback);
    }

    /**
     * Subscribe to an event only once - auto-removes after first call
     * @param {string} event - Event name
     * @param {Function} callback - Handler function
     * @returns {Function} Unsubscribe function
     */
    once(event, callback) {
        const wrapper = (...args) => {
            this.off(event, wrapper);
            callback.apply(this, args);
        };
        return this.on(event, wrapper);
    }

    /**
     * Unsubscribe from an event
     * @param {string} event - Event name
     * @param {Function} callback - The exact handler function to remove
     */
    off(event, callback) {
        if (!this._listeners.has(event)) return;

        const listeners = this._listeners.get(event);
        const index = listeners.indexOf(callback);

        if (index > -1) {
            listeners.splice(index, 1);
        }

        // Clean up empty arrays
        if (listeners.length === 0) {
            this._listeners.delete(event);
        }
    }

    /**
     * Emit an event to all subscribers
     * @param {string} event - Event name
     * @param {...any} args - Arguments to pass to handlers
     */
    emit(event, ...args) {
        if (!this._listeners.has(event)) return;

        // Create a copy to avoid issues if handlers modify the list
        const listeners = [...this._listeners.get(event)];

        for (const callback of listeners) {
            try {
                callback.apply(this, args);
            } catch (error) {
                console.error(`EventBus: Error in handler for "${event}":`, error);
            }
        }
    }

    /**
     * Remove all listeners for an event, or all events if no event specified
     * @param {string} [event] - Optional event name
     */
    clear(event) {
        if (event) {
            this._listeners.delete(event);
        } else {
            this._listeners.clear();
        }
    }

    /**
     * Get the number of listeners for an event
     * @param {string} event - Event name
     * @returns {number} Number of listeners
     */
    listenerCount(event) {
        return this._listeners.has(event) ? this._listeners.get(event).length : 0;
    }
}

// Export singleton instance for global use
export const eventBus = new EventBus();

// Also export class for testing or multiple instances
export default EventBus;
