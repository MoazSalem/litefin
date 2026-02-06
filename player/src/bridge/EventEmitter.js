/**
 * EventEmitter - Simple event system for player components
 * 
 * Provides pub/sub functionality for player events and
 * postMessage communication with host apps.
 * 
 * @module bridge/EventEmitter
 */

export class EventEmitter {
    constructor() {
        this._listeners = {};
    }
    
    /**
     * Register event listener
     * @param {string} event - Event name
     * @param {Function} callback - Event handler
     * @returns {this}
     */
    on(event, callback) {
        if (!this._listeners[event]) {
            this._listeners[event] = [];
        }
        this._listeners[event].push(callback);
        return this;
    }
    
    /**
     * Register one-time event listener
     * @param {string} event - Event name
     * @param {Function} callback - Event handler
     * @returns {this}
     */
    once(event, callback) {
        const wrapper = (...args) => {
            this.off(event, wrapper);
            callback.apply(this, args);
        };
        return this.on(event, wrapper);
    }
    
    /**
     * Remove event listener
     * @param {string} event - Event name
     * @param {Function} callback - Event handler to remove
     * @returns {this}
     */
    off(event, callback) {
        if (!this._listeners[event]) return this;
        
        if (!callback) {
            delete this._listeners[event];
        } else {
            this._listeners[event] = this._listeners[event].filter(cb => cb !== callback);
        }
        return this;
    }
    
    /**
     * Emit event to all listeners
     * @param {string} event - Event name
     * @param {*} data - Event data
     * @returns {this}
     */
    emit(event, data) {
        const listeners = this._listeners[event];
        if (listeners) {
            listeners.forEach(callback => {
                try {
                    callback(data);
                } catch (e) {
                    console.error(`Error in event listener for "${event}":`, e);
                }
            });
        }
        return this;
    }
    
    /**
     * Remove all event listeners
     */
    removeAllListeners() {
        this._listeners = {};
    }
}

// ============================================================================
// PostMessage Bridge for WebView Communication
// ============================================================================

/**
 * Send event to parent window (for WebView integration)
 * @param {string} type - Event type
 * @param {Object} data - Event data
 */
export function postToHost(type, data = {}) {
    const message = { type, ...data, source: 'jellyfin-player' };
    
    try {
        // Try parent window (iframe)
        if (window.parent && window.parent !== window) {
            window.parent.postMessage(message, '*');
        }
        
        // Try opener (popup)
        if (window.opener) {
            window.opener.postMessage(message, '*');
        }
        
        // Trigger custom event for same-window listening
        window.dispatchEvent(new CustomEvent('jellyfin-player-event', { detail: message }));
    } catch (e) {
        console.warn('[EventEmitter] Failed to post message to host:', e);
    }
}

/**
 * Listen for messages from host app
 * @param {Function} handler - Message handler function
 * @returns {Function} Cleanup function
 */
export function listenToHost(handler) {
    const listener = (event) => {
        // Accept messages that look like player commands
        if (event.data && (event.data.target === 'jellyfin-player' || event.data.command)) {
            handler(event.data);
        }
    };
    
    window.addEventListener('message', listener);
    
    // Return cleanup function
    return () => window.removeEventListener('message', listener);
}
