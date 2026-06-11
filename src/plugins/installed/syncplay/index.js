/**
 * ============================================================================
 * SyncPlay Plugin — Litefin Plugin System Entry Point
 * ============================================================================
 *
 * This file is the plugin object loaded by PluginManager. It bridges the plugin
 * lifecycle (init, onPlayerStart, onPlayerStop, destroy) with the SyncPlayManager
 * singleton:
 *
 *   init()          → initializes the SyncPlayManager, subscribes to events
 *   onPlayerStart() → updates SyncPlayManager with the current JellyfinPlayer
 *   onPlayerStop()  → notifies SyncPlayManager so it can pause drift tracking
 *   destroy()       → shuts down SyncPlayManager and cleans up listeners
 *
 * The plugin has NO server-side dependency (SyncPlay is a core Jellyfin feature
 * available in all servers v10.8+), so `serverDependency` is omitted.
 * ============================================================================
 */

import { syncPlayManager } from '../../../core/syncplay/SyncPlayManager.js';
import { eventBus } from '../../../core/EventBus.js';
import { router } from '../../../core/Router.js';
import { logger } from '../../../utils/Logger.js';

const log = logger.create('SyncPlayPlugin');

// ============================================================================
// Plugin object
// ============================================================================

const syncPlayPlugin = {
    // -------------------------------------------------------------------------
    // Plugin metadata (shown in Settings → Plugins)
    // -------------------------------------------------------------------------

    /** @type {string} Unique plugin identifier */
    id: 'syncplay',

    /** @type {string} Display name */
    name: 'SyncPlay',

    /** @type {string} Plugin version */
    version: '1.0.0',

    /** @type {string} Short description shown in Settings */
    description: 'Synchronize playback with other Jellyfin clients in real time.',

    // -------------------------------------------------------------------------
    // Lifecycle hooks
    // -------------------------------------------------------------------------

    /**
     * Called once by PluginManager at startup (or when re-enabled by the user).
     * Initializes the SyncPlayManager — subscribes to WebSocket events via eventBus.
     *
     * @param {object} api - PluginAPI instance (access to player, OSD, toast, etc.)
     */
    init(api) {
        log.info('SyncPlay plugin init');

        // Initialize the manager — this wires up eventBus listeners
        // for 'syncplay:command' and 'syncplay:groupupdate'.
        syncPlayManager.init();

        // ----------------------------------------------------------------
        // App-level playback start (joining from sidebar or outside player).
        //
        // When the user joins a SyncPlay group from the home screen or any
        // non-player page, the server sends a PlayQueue update that reveals
        // what the group is currently watching. SyncPlayManager emits
        // 'syncplay:startplayback' and we navigate to the player here.
        // ----------------------------------------------------------------
        this._onStartPlayback = ({ itemId, startPositionTicks, playlistItemId }) => {
            log.info(
                `SyncPlay: starting playback for item ${itemId} ` + `at ${Math.round(startPositionTicks / 10000)}ms`
            );

            // Check if we are already playing this exact item — if so, just
            // let the sync machinery take over without re-launching the player.
            const currentPath = router.getCurrentPath();
            const alreadyOnItem = currentPath.startsWith('/player/') && currentPath.includes(itemId);

            if (alreadyOnItem) {
                log.info('SyncPlay: already playing this item — skipping navigation');
                return;
            }

            // Navigate to the player.
            // Player route is registered as /player/:id/:resume, so we pass /false for resume.
            // We pass the start position and syncplay flag as query params so PlayerPage
            // can read them from `this.params` and seek to the right point before
            // SyncPlay sync takes over.
            router.navigate(`/player/${itemId}/false?startPositionTicks=${startPositionTicks}&syncplay=1`, {
                replace: true,
                state: {
                    playlistItemId
                }
            });
        };
        eventBus.on('syncplay:startplayback', this._onStartPlayback);

        // ----------------------------------------------------------------
        // Mid-session queue item switch (handled by the player already).
        // ----------------------------------------------------------------
        this._onSwitchItem = ({ item, index }) => {
            log.info('SyncPlay: switching to item', item?.Name || item?.Id, 'at index', index);
            eventBus.emit('remote:queueupdate', {
                itemIds: null, // PlayerPage uses item objects when itemIds is null
                startIndex: index,
                _items: [item] // Non-standard but PlayerPage checks for this
            });
        };
        eventBus.on('syncplay:switchitem', this._onSwitchItem);

        // Show a toast when SyncPlay is enabled/disabled so the user knows
        this._onEnabled = (groupInfo) => {
            if (api.toast) {
                api.toast.show('SyncPlay: joined group', { duration: 3000 });
            }
            log.info('SyncPlay enabled:', groupInfo);
        };
        this._onDisabled = () => {
            if (api.toast) {
                api.toast.show('SyncPlay: left group', { duration: 3000 });
            }
            log.info('SyncPlay disabled');
        };

        eventBus.on('syncplay:enabled', this._onEnabled);
        eventBus.on('syncplay:disabled', this._onDisabled);
    },

    /**
     * Called by PluginManager.notifyPlayerStart() whenever a media item starts.
     * Passes the JellyfinPlayer reference to SyncPlayManager so it can hook
     * into play/pause/timeupdate events for drift correction.
     *
     * @param {object} item - The Jellyfin media item that started playing
     * @param {object} api  - PluginAPI instance (use api.getPlayer() for the player)
     */
    onPlayerStart(item, api) {
        const player = api.getPlayer();
        if (player) {
            log.info('SyncPlay: player started for', item?.Name || item?.Id);
            syncPlayManager.setPlayer(player);
        }
    },

    /**
     * Called by PluginManager.notifyPlayerStop() when playback stops.
     * Lets SyncPlayManager pause drift correction while keeping the group alive.
     *
     * @param {object} api - PluginAPI instance
     */
    onPlayerStop(api) {
        log.info('SyncPlay: player stopped');
        syncPlayManager.onPlayerStop();
    },

    /**
     * Called by PluginManager when the plugin is disabled by the user or app exit.
     * Tears down SyncPlayManager: leaves the group, stops TimeSync, clears listeners.
     *
     * @param {object} api - PluginAPI instance
     */
    destroy(api) {
        log.info('SyncPlay plugin destroy');

        syncPlayManager.destroy();

        if (this._onStartPlayback) {
            eventBus.off('syncplay:startplayback', this._onStartPlayback);
            this._onStartPlayback = null;
        }
        if (this._onSwitchItem) {
            eventBus.off('syncplay:switchitem', this._onSwitchItem);
            this._onSwitchItem = null;
        }
        if (this._onEnabled) {
            eventBus.off('syncplay:enabled', this._onEnabled);
            this._onEnabled = null;
        }
        if (this._onDisabled) {
            eventBus.off('syncplay:disabled', this._onDisabled);
            this._onDisabled = null;
        }
    }
};

export default syncPlayPlugin;
