/**
 * ============================================================================
 * Litefin Tizen - PluginManager
 * ============================================================================
 * The central hub of the Litefin plugin system. Loads all bundled plugins,
 * initializes them with a PluginAPI, manages their lifecycle, and broadcasts
 * player/page events to all active plugins.
 *
 * Architecture:
 *   - All plugins are bundled into the app and listed in BUNDLED_PLUGINS below.
 *   - Each plugin is a JS module exporting a default plugin object (or factory).
 *   - Plugins receive a PluginAPI instance giving them controlled access to the app.
 *   - If a plugin declares a serverDependency, we check availability before init.
 *     If the dependency is missing, we disable the plugin and warn the user.
 *
 * Player Integration:
 *   The PlayerPage calls notifyPlayerStart() / notifyTimeUpdate() / notifyPlayerStop()
 *   on this manager. These are forwarded to all active plugins.
 *
 * Page Integration:
 *   The Router calls notifyPageLoad() / notifyPageUnload() when pages mount/unmount.
 *
 * Usage:
 *   import { pluginManager } from './PluginManager.js';
 *   await pluginManager.init(deps);
 *   pluginManager.notifyPlayerStart(item, player, osd);
 *   pluginManager.notifyTimeUpdate(positionTicks, durationTicks);
 *   pluginManager.notifyPlayerStop();
 * ============================================================================
 */

import { logger } from '../utils/Logger.js';
import { serverPluginClient } from './ServerPluginClient.js';
import PluginAPI from './PluginAPI.js';
import PluginWidgetHost from './PluginWidgetHost.js';

const log = logger.create('PluginManager');

// ============================================================================
// Bundled Plugin Registry
// ============================================================================
// Add new bundled plugins here. Each entry is a dynamic import factory.
// The import path is relative to THIS file (src/plugins/PluginManager.js).
//
// Format:
// {
//   id: 'unique-id',          — must match the plugin object's id property
//   load: () => import(...)   — dynamic import returning { default: pluginObject }
// }
const BUNDLED_PLUGINS = [
    {
        id: 'skip-intro',
        load: () => import('./installed/skip-intro/index.js')
    }
];

// ============================================================================
// PluginManager Class
// ============================================================================
class PluginManager {
    constructor() {
        // Map<pluginId, { plugin, api, enabled }>
        this._plugins = new Map();

        // Current OSD widget host (valid during playback only)
        this._widgetHost = null;

        // Current player reference (valid during playback only)
        this._currentPlayer = null;

        // Current media item (valid during playback only)
        this._currentItem = null;

        // Injected dependency references (set via init())
        this._deps = {};

        // Whether the manager has been initialized
        this._initialized = false;
    }

    // ========================================================================
    // Initialization
    // ========================================================================

    /**
     * Initialize the plugin manager. Must be called once at app startup.
     *
     * @param {Object} deps - App-level dependencies
     * @param {Object} deps.api - ApiClient singleton
     * @param {Object} deps.focusManager - FocusManager singleton
     * @param {Object} deps.toast - Toast UI helper
     */
    async init(deps = {}) {
        if (this._initialized) {
            log.warn('PluginManager.init() called more than once — ignoring');
            return;
        }

        this._deps = deps;

        // Give the server plugin client access to the API
        serverPluginClient.init(deps.api);

        log.info(`Loading ${BUNDLED_PLUGINS.length} bundled plugin(s)...`);

        // Load all bundled plugins concurrently
        await Promise.all(BUNDLED_PLUGINS.map((entry) => this._loadPlugin(entry)));

        this._initialized = true;
        log.info(`Plugin system ready. ${this._plugins.size} plugin(s) active.`);
    }

    // ========================================================================
    // Player Lifecycle Notifications
    // ========================================================================

    /**
     * Notify all plugins that playback has started for a new media item.
     * Also sets up the OSD widget host for this playback session.
     *
     * @param {Object} item - The Jellyfin media item
     * @param {Object} player - JellyfinPlayer instance
     * @param {Object} osd - OSDController instance
     */
    async notifyPlayerStart(item, player, osd) {
        this._currentItem = item;
        this._currentPlayer = player;

        // Create a fresh widget host wired to this OSD session
        this._destroyWidgetHost();
        this._widgetHost = new PluginWidgetHost(osd);

        // Update all PluginAPI instances so getPlayer() / getCurrentItem() work
        this._updateAPIRefs();

        // Also update widgetHost reference in PluginAPI instances so addOSDWidget() works
        for (const [, entry] of this._plugins) {
            if (entry.enabled) {
                entry.api._osdWidgetHost = this._widgetHost;
            }
        }

        log.info(`notifyPlayerStart: ${item?.Name || item?.Id}`);

        // ———————————————————————————————————————————————————————————————
        // Lazy dependency re-check for non-admin users.
        //
        // At startup, non-admin users can't probe server plugin endpoints because
        // most probes need an itemId (e.g. intro-skipper needs an episode ID).
        // Now that we have one, clear the stale cache entry and re-probe.
        // ———————————————————————————————————————————————————————————————
        for (const [id, entry] of this._plugins) {
            if (!entry.dependencyDeferred || !entry.plugin.serverDependency) continue;

            // Clear the cached "deferred" result so isPluginAvailable re-runs with itemId
            serverPluginClient._availabilityCache.delete(entry.plugin.serverDependency);

            const result = await serverPluginClient.isPluginAvailable(entry.plugin.serverDependency, item.Id);

            // Mark dependency as resolved (won't re-check on every episode)
            entry.dependencyDeferred = false;

            if (result.available) {
                log.info(`Plugin '${id}' dependency confirmed at playback — enabling`);
                entry.enabled = true;
                entry.api._osdWidgetHost = this._widgetHost;

                // Run init now that we know the dependency is present
                try {
                    await entry.plugin.init(entry.api);
                } catch (err) {
                    log.error(`Plugin '${id}' late init() threw:`, err);
                    entry.enabled = false;
                }
            } else {
                log.warn(
                    `Plugin '${id}' disabled: server plugin '${entry.plugin.serverDependency}' confirmed not present`
                );
                entry.enabled = false;
            }
        }

        // Forward to all enabled plugins
        for (const [id, entry] of this._plugins) {
            if (!entry.enabled) continue;
            try {
                if (typeof entry.plugin.onPlayerStart === 'function') {
                    await entry.plugin.onPlayerStart(item, entry.api);
                }
            } catch (err) {
                log.error(`Plugin '${id}' onPlayerStart() threw:`, err);
            }
        }
    }

    /**
     * Notify all plugins of a playback time update tick.
     * Also evaluates OSD widget visibility for the current position.
     *
     * @param {number} positionTicks - Current position in ticks
     * @param {number} durationTicks - Total duration in ticks
     */
    notifyTimeUpdate(positionTicks, durationTicks) {
        // Update widget host visibility first (fast path — no async)
        if (this._widgetHost) {
            this._widgetHost.onTimeUpdate(positionTicks, durationTicks);
        }

        // Forward to all enabled plugins
        for (const [id, entry] of this._plugins) {
            if (!entry.enabled) continue;
            try {
                if (typeof entry.plugin.onTimeUpdate === 'function') {
                    entry.plugin.onTimeUpdate(positionTicks, durationTicks, entry.api);
                }
            } catch (err) {
                log.error(`Plugin '${id}' onTimeUpdate() threw:`, err);
            }
        }
    }

    /**
     * Notify all plugins that playback has stopped.
     * Tears down the OSD widget host.
     */
    notifyPlayerStop() {
        log.debug('notifyPlayerStop');

        // Forward to all enabled plugins before cleanup
        for (const [id, entry] of this._plugins) {
            if (!entry.enabled) continue;
            try {
                if (typeof entry.plugin.onPlayerStop === 'function') {
                    entry.plugin.onPlayerStop(entry.api);
                }
            } catch (err) {
                log.error(`Plugin '${id}' onPlayerStop() threw:`, err);
            }
        }

        // Tear down the widget host and clear player refs
        this._destroyWidgetHost();
        this._currentItem = null;
        this._currentPlayer = null;
        this._updateAPIRefs();
    }

    // ========================================================================
    // Page Lifecycle Notifications
    // ========================================================================

    /**
     * Notify all plugins that a page has mounted.
     * Plugins can use this to inject UI into non-player pages.
     *
     * @param {string} pageId - Route/page identifier (e.g., 'details', 'home')
     * @param {HTMLElement} pageEl - The page's root DOM element
     */
    notifyPageLoad(pageId, pageEl) {
        for (const [id, entry] of this._plugins) {
            if (!entry.enabled) continue;
            try {
                if (typeof entry.plugin.onPageLoad === 'function') {
                    entry.plugin.onPageLoad(pageId, pageEl, entry.api);
                }
            } catch (err) {
                log.error(`Plugin '${id}' onPageLoad() threw:`, err);
            }
        }
    }

    /**
     * Notify all plugins that a page has unmounted.
     *
     * @param {string} pageId - Route/page identifier
     */
    notifyPageUnload(pageId) {
        for (const [id, entry] of this._plugins) {
            if (!entry.enabled) continue;
            try {
                if (typeof entry.plugin.onPageUnload === 'function') {
                    entry.plugin.onPageUnload(pageId, entry.api);
                }
            } catch (err) {
                log.error(`Plugin '${id}' onPageUnload() threw:`, err);
            }
        }
    }

    // ========================================================================
    // Plugin Access
    // ========================================================================

    /**
     * Get a loaded plugin entry by ID.
     * @param {string} pluginId
     * @returns {{ plugin, api, enabled }|undefined}
     */
    getPlugin(pluginId) {
        return this._plugins.get(pluginId);
    }

    /**
     * Get all currently loaded plugin IDs.
     * @returns {string[]}
     */
    getPluginIds() {
        return Array.from(this._plugins.keys());
    }

    // ========================================================================
    // OSD Key Forwarding
    // ========================================================================

    /**
     * Forward a key event to the active widget host (if in player).
     * Called by OSDController when focus is in the overlay row and a widget
     * may want to handle custom key input.
     *
     * @param {string} key - Key name (e.g., 'enter', 'left', 'right')
     * @param {HTMLElement} focusedEl - The currently focused DOM element
     * @returns {boolean} True if a widget consumed the event
     */
    handleWidgetKey(key, focusedEl) {
        if (!this._widgetHost) return false;
        return this._widgetHost.handleKey(key, focusedEl);
    }

    // ========================================================================
    // Teardown
    // ========================================================================

    /**
     * Destroy all plugins and clean up resources.
     */
    destroy() {
        log.info('PluginManager destroying...');

        this._destroyWidgetHost();

        // Destroy each plugin and its API
        for (const [id, entry] of this._plugins) {
            this._destroyPlugin(id, entry);
        }
        this._plugins.clear();

        serverPluginClient.reset();
        this._initialized = false;
        log.info('PluginManager destroyed');
    }

    // ========================================================================
    // Internal Helpers
    // ========================================================================

    /**
     * Load, validate, and initialize a single bundled plugin.
     * @private
     */
    async _loadPlugin(registryEntry) {
        const { id, load } = registryEntry;
        log.debug(`Loading plugin: ${id}`);

        let pluginModule;
        try {
            pluginModule = await load();
        } catch (err) {
            log.error(`Failed to import plugin '${id}':`, err);
            return;
        }

        // Support both default export (object) and factory function
        let plugin = pluginModule.default;
        if (typeof plugin === 'function') {
            try {
                plugin = plugin();
            } catch (err) {
                log.error(`Plugin '${id}' factory threw:`, err);
                return;
            }
        }

        if (!plugin || !plugin.id) {
            log.error(`Plugin '${id}' export is missing required 'id' property`);
            return;
        }

        // Check server dependency availability.
        // We do this at startup so we can warn early — but non-admin users
        // won't have an itemId yet, so the probe may be deferred.
        let enabled = true;
        let dependencyDeferred = false;

        if (plugin.serverDependency) {
            const result = await serverPluginClient.isPluginAvailable(plugin.serverDependency);

            if (result.deferred) {
                // Non-admin user, no itemId yet — can't probe the endpoint.
                // Enable tentatively; we'll re-check in notifyPlayerStart with a real itemId.
                log.info(`Plugin '${id}' dependency check deferred — will verify at playback start`);
                dependencyDeferred = true;
            } else if (!result.available) {
                log.warn(`Plugin '${id}' disabled: server plugin '${plugin.serverDependency}' not found`);

                // Warn the user via toast so they know the plugin was skipped
                if (this._deps.toast) {
                    this._deps.toast.show(
                        `'${plugin.name || id}' requires the '${plugin.serverDependency}' server plugin`,
                        { duration: 5000 }
                    );
                }

                enabled = false;
            }
        }

        // Create the plugin's sandboxed API
        const api = new PluginAPI(plugin.id, {
            osdWidgetHost: this._widgetHost, // null until player starts
            focusManager: this._deps.focusManager,
            toast: this._deps.toast,
            getPlayer: () => this._currentPlayer,
            getCurrentItem: () => this._currentItem
        });

        // Register the plugin entry early so it appears in getPluginIds()
        this._plugins.set(plugin.id, { plugin, api, enabled, dependencyDeferred });

        // Call the plugin's init() only if it's enabled
        if (enabled) {
            try {
                await plugin.init(api);
                log.info(`Plugin '${plugin.id}' (${plugin.name}) initialized`);
            } catch (err) {
                log.error(`Plugin '${id}' init() threw:`, err);
                // Disable the plugin to prevent broken state on future calls
                this._plugins.get(plugin.id).enabled = false;
            }
        }
    }

    /**
     * Destroy a single plugin and its API.
     * @private
     */
    _destroyPlugin(id, entry) {
        try {
            if (typeof entry.plugin.destroy === 'function') {
                entry.plugin.destroy(entry.api);
            }
        } catch (err) {
            log.error(`Plugin '${id}' destroy() threw:`, err);
        }

        // Clean up the API's subscriptions, focus sections, and widgets
        try {
            entry.api._destroy();
        } catch (err) {
            log.error(`PluginAPI for '${id}' _destroy() threw:`, err);
        }
    }

    /**
     * Tear down the current OSD widget host.
     * @private
     */
    _destroyWidgetHost() {
        if (this._widgetHost) {
            this._widgetHost.destroy();
            this._widgetHost = null;
        }
    }

    /**
     * Update getPlayer()/getCurrentItem() closures in all PluginAPI instances.
     * Called whenever the player starts or stops.
     * @private
     */
    _updateAPIRefs() {
        for (const [, entry] of this._plugins) {
            // The PluginAPI closures already reference this._currentPlayer /
            // this._currentItem via the factory functions we passed in init().
            // Nothing to update here — the closures are live references.
            // But we DO need to update the widgetHost reference.
            entry.api._osdWidgetHost = this._widgetHost;
        }
    }
}

// Export singleton instance
export const pluginManager = new PluginManager();
export default PluginManager;
