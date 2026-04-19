/**
 * ============================================================================
 * Litefin Tizen - PluginAPI
 * ============================================================================
 * The sandboxed API surface that each plugin receives via its init() call.
 * Plugins should ONLY interact with the app through this object — never
 * import internal modules directly. This keeps plugins isolated and lets us
 * change internals without breaking plugins.
 *
 * Each plugin instance gets its own PluginAPI, namespaced by its plugin ID.
 *
 * Usage (inside a plugin):
 *   init(api) {
 *       api.on('player:timeupdate', ({ positionTicks }) => { ... });
 *       api.addOSDWidget(myWidget);
 *       api.showToast('Hello from my plugin!');
 *   }
 * ============================================================================
 */

import { logger } from '../utils/Logger.js';
import { eventBus } from '../core/EventBus.js';
import { storage } from '../utils/StorageService.js';
import { i18n } from '../utils/i18n.js';
import { serverPluginClient } from './ServerPluginClient.js';
import { playQueue } from '../core/PlayQueue.js';
import { api as jellyfinApi } from '../api/ApiClient.js';

// ============================================================================
// PluginAPI Class
// ============================================================================
class PluginAPI {
    /**
     * @param {string} pluginId - Unique plugin identifier (for namespacing)
     * @param {Object} refs - Internal references injected by PluginManager
     * @param {Object} refs.osdWidgetHost - PluginWidgetHost for OSD injection
     * @param {Object} refs.focusManager - FocusManager singleton
     * @param {Object} refs.toast - Toast UI helper
     * @param {Function} refs.getPlayer - Returns the current JellyfinPlayer (or null)
     * @param {Function} refs.getCurrentItem - Returns the current media item (or null)
     */
    constructor(pluginId, refs = {}) {
        // Plugin identifier — used for log namespacing and storage namespacing
        this._pluginId = pluginId;

        // Internal references from the app
        this._osdWidgetHost = refs.osdWidgetHost || null;
        this._focusManager = refs.focusManager || null;
        this._toast = refs.toast || null;
        this._getPlayer = refs.getPlayer || (() => null);
        this._getCurrentItem = refs.getCurrentItem || (() => null);

        // Namespaced logger for this plugin
        this.log = logger.create(`Plugin:${pluginId}`);

        // Track subscriptions and focus sections for cleanup on destroy
        this._subscriptions = [];
        this._focusSections = [];

        // Expose the server plugin client directly (it's already a controlled interface)
        this.serverPlugins = serverPluginClient;

        // Expose the play queue for sequence manipulation (e.g., intros)
        this.playQueue = playQueue;
    }

    /**
     * Trigger the player to skip to the next item in the queue.
     */
    playNext() {
        eventBus.emit('remote:next');
    }

    /**
     * Trigger the player to return to the previous item in the queue.
     */
    playPrevious() {
        eventBus.emit('remote:previous');
    }

    // ========================================================================
    // Jellyfin API Access
    // ========================================================================

    /**
     * Get pre-roll intro items for a given media item.
     * @param {string} itemId - The target media item ID
     * @returns {Promise<Object>} Object containing Items array and TotalRecordCount
     */
    async getIntros(itemId) {
        return jellyfinApi.getIntros(itemId);
    }

    /**
     * Get a specific media item.
     * @param {string} itemId - The item ID
     * @param {Object} [params] - Optional query parameters
     * @returns {Promise<Object>}
     */
    async getItem(itemId, params = {}) {
        return jellyfinApi.getItem(itemId, params);
    }

    // ========================================================================
    // Player Access
    // ========================================================================

    /**
     * Get the current JellyfinPlayer instance.
     * Returns null if nothing is currently playing.
     * @returns {Object|null}
     */
    getPlayer() {
        return this._getPlayer();
    }

    /**
     * Get the current media item metadata.
     * Returns null if nothing is currently playing.
     * @returns {Object|null}
     */
    getCurrentItem() {
        return this._getCurrentItem();
    }

    // ========================================================================
    // OSD Widget Injection (Player)
    // ========================================================================

    /**
     * Inject a UI widget into the player OSD overlay layer (Row -1).
     * The widget will participate in D-pad focus navigation alongside
     * the Subtitle Offset and Playback Info overlays.
     *
     * @param {Object} widget - Widget descriptor (see PluginWidgetHost for interface)
     * @param {string} widget.id - Unique widget ID
     * @param {Function} widget.render - Returns an HTMLElement
     * @param {Function} [widget.shouldShow] - (posTicks) => boolean for visibility
     * @param {Function} [widget.onSelect] - Called when Enter is pressed on widget
     * @param {Function} [widget.handleKey] - Custom key handler, return true to consume
     */
    addOSDWidget(widget) {
        if (!this._osdWidgetHost) {
            this.log.warn('addOSDWidget called but no OSD widget host available (not in player?)');
            return;
        }
        // Namespace the widget ID to avoid collisions between plugins
        const namespacedWidget = {
            ...widget,
            id: `${this._pluginId}:${widget.id}`
        };
        this._osdWidgetHost.addWidget(namespacedWidget, this);
    }

    /**
     * Remove a previously injected OSD widget.
     * @param {string} widgetId - The ID passed to addOSDWidget (will be auto-namespaced)
     */
    removeOSDWidget(widgetId) {
        if (!this._osdWidgetHost) return;
        this._osdWidgetHost.removeWidget(`${this._pluginId}:${widgetId}`);
    }

    // ========================================================================
    // App UI Integration (Non-Player Pages)
    // ========================================================================

    /**
     * Register a DOM container as a focusable section in the FocusManager.
     * Use this when your plugin injects UI into a regular app page (e.g., Details).
     * The section is automatically unregistered on destroy().
     *
     * @param {string} sectionName - Unique name for this focus section
     * @param {HTMLElement} container - The DOM container to register
     * @param {Object} [options] - FocusManager section options
     */
    addFocusSection(sectionName, container, options = {}) {
        if (!this._focusManager) {
            this.log.warn('addFocusSection called but FocusManager is not available');
            return;
        }
        // Namespace section name to prevent collisions
        const namespacedName = `plugin:${this._pluginId}:${sectionName}`;
        this._focusManager.register(namespacedName, container, options);
        this._focusSections.push(namespacedName);
        this.log.debug(`Registered focus section: ${namespacedName}`);
    }

    /**
     * Unregister a focus section previously registered via addFocusSection().
     * @param {string} sectionName - The name given to addFocusSection (will be auto-namespaced)
     */
    removeFocusSection(sectionName) {
        if (!this._focusManager) return;
        const namespacedName = `plugin:${this._pluginId}:${sectionName}`;
        this._focusManager.unregister(namespacedName);
        this._focusSections = this._focusSections.filter((n) => n !== namespacedName);
    }

    // ========================================================================
    // Event Bus
    // ========================================================================

    /**
     * Subscribe to an EventBus event.
     * The subscription is automatically cleaned up when the plugin is destroyed.
     *
     * @param {string} event - Event name (e.g., 'player:timeupdate', 'plugin:skip-intro:skip')
     * @param {Function} handler - Event handler
     * @returns {Function} Unsubscribe function (optional manual cleanup)
     */
    on(event, handler) {
        const unsub = eventBus.on(event, handler);
        this._subscriptions.push(unsub);
        return unsub;
    }

    /**
     * Subscribe to an EventBus event only once.
     * @param {string} event - Event name
     * @param {Function} handler - Event handler
     */
    once(event, handler) {
        const unsub = eventBus.once(event, handler);
        this._subscriptions.push(unsub);
        return unsub;
    }

    /**
     * Emit an event on the EventBus.
     * Use namespaced event names like 'plugin:myplugin:myevent'.
     *
     * @param {string} event - Event name
     * @param {...any} args - Event arguments
     */
    emit(event, ...args) {
        eventBus.emit(event, ...args);
    }

    // ========================================================================
    // UI Utilities
    // ========================================================================

    /**
     * Show a toast notification to the user.
     * @param {string} message - The message to display
     * @param {number} [duration=3000] - Duration in ms
     */
    showToast(message, duration = 3000) {
        if (this._toast) {
            this._toast.show(message, { duration });
        } else {
            this.log.warn('showToast called but Toast is not available');
        }
    }

    // ========================================================================
    // Storage
    // ========================================================================

    /**
     * Get a namespaced localStorage wrapper for this plugin's settings.
     * All keys are automatically prefixed with 'plugin:<pluginId>:' to
     * prevent collision with app storage.
     *
     * @returns {Object} { get(key), set(key, value), remove(key) }
     */
    getStorage() {
        const prefix = `plugin:${this._pluginId}:`;
        return {
            /**
             * Get a stored value.
             * @param {string} key
             * @returns {string|null}
             */
            get: (key) => storage.getItem(`${prefix}${key}`),

            /**
             * Store a value.
             * @param {string} key
             * @param {string|number|boolean} value
             */
            set: (key, value) => storage.setItem(`${prefix}${key}`, String(value)),

            /**
             * Remove a stored value.
             * @param {string} key
             */
            remove: (key) => storage.removeItem(`${prefix}${key}`)
        };
    }

    // ========================================================================
    // Localization
    // ========================================================================

    /**
     * Translate a localization key using the app's i18n system.
     * @param {string} key - Translation key
     * @param {Object} [params] - Interpolation parameters
     * @returns {string}
     */
    t(key, params) {
        return i18n.t(key, params);
    }

    // ========================================================================
    // Cleanup
    // ========================================================================

    /**
     * Clean up all subscriptions and registered focus sections.
     * Called automatically by PluginManager when a plugin is unloaded.
     * @internal
     */
    _destroy() {
        // Unsubscribe from all EventBus events
        for (const unsub of this._subscriptions) {
            if (typeof unsub === 'function') unsub();
        }
        this._subscriptions = [];

        // Unregister all focus sections
        for (const sectionName of this._focusSections) {
            if (this._focusManager) {
                this._focusManager.unregister(sectionName);
            }
        }
        this._focusSections = [];

        // Remove all OSD widgets
        if (this._osdWidgetHost) {
            this._osdWidgetHost.removeAllWidgetsForPlugin(this._pluginId);
        }

        this.log.debug('PluginAPI cleaned up');
    }
}

export default PluginAPI;
