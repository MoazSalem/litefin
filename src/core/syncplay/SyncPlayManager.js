/**
 * ============================================================================
 * SyncPlayManager — Orchestrates SyncPlay group state and commands
 * ============================================================================
 *
 * This is the central hub of the SyncPlay subsystem. It:
 *
 *   1. Listens to the eventBus for WebSocket messages from the server:
 *        syncplay:command     → play/pause/stop/seek commands for the group
 *        syncplay:groupupdate → group membership / queue / state changes
 *
 *   2. Drives the JellyfinPlayer with the correct timing (via timeSync offsets).
 *
 *   3. Delegates drift correction to SyncPlayPlaybackCore on each timeupdate.
 *
 *   4. Reports this client's buffering status back to the server so other
 *      group members know when to hold playback.
 *
 *   5. Manages group join/leave lifecycle cleanly.
 *
 * SyncPlayManager is instantiated (and destroyed) by the SyncPlay plugin
 * (src/plugins/installed/syncplay/index.js). The player reference is updated
 * on every notifyPlayerStart() call from PluginManager.
 *
 * Port of jellyfin-web's src/plugins/syncPlay/core/Manager.js
 * ============================================================================
 */

import { eventBus } from '../EventBus.js';
import { api } from '../../api/index.js';
import { logger } from '../../utils/Logger.js';
import { playQueue } from '../PlayQueue.js';
import { syncPlayTimeSync } from './SyncPlayTimeSync.js';
import { SyncPlayPlaybackCore } from './SyncPlayPlaybackCore.js';

const log = logger.create('SyncPlayManager');

// ============================================================================
// Constants
// ============================================================================

/**
 * Ticks → milliseconds conversion (1 tick = 100ns; 1 ms = 10 000 ticks).
 */
const TICKS_PER_MS = 10000;

/**
 * Minimum gap (ms) between consecutive buffering reports.
 * Prevents spamming the server during rapid buffer starve-fill cycles.
 */
const BUFFERING_REPORT_THROTTLE_MS = 500;

// ============================================================================
// SyncPlayManager Class
// ============================================================================

export class SyncPlayManager {
    constructor() {
        // ====================================================================
        // State
        // ====================================================================

        /** Whether the client is currently in a SyncPlay group. @type {boolean} */
        this._isEnabled = false;

        /** Full group info as returned by the server's GroupUpdate. @type {object|null} */
        this._groupInfo = null;

        /**
         * Human-readable group name — e.g. "Alice's Group".
         * The Jellyfin WebSocket GroupJoined event only carries GroupId, so we
         * store the name ourselves at the point of create/join and clear it
         * when we leave, so the badge always has something legible to show.
         * @type {string|null}
         */
        this._groupName = null;

        /**
         * The current JellyfinPlayer instance.
         * Updated every time notifyPlayerStart() is called by the plugin.
         * @type {object|null}
         */
        this._player = null;

        /**
         * Playback core — computes and applies drift corrections.
         * Re-created whenever the player changes.
         * @type {SyncPlayPlaybackCore|null}
         */
        this._playbackCoreInstance = null;

        /**
         * The playlist item ID of the item the group is currently playing.
         * Used to match incoming commands to the right queue slot.
         * @type {string|null}
         */
        this._currentPlaylistItemId = null;

        /**
         * Tracks whether THIS client is currently buffering (reported to server).
         * @type {boolean}
         */
        this._isBuffering = false;

        /**
         * Timestamp of the last buffering report (ms). Used for throttling.
         * @type {number}
         */
        this._lastBufferingReportMs = 0;

        /**
         * Timer ID for a scheduled Pause or Play command (from the server's `When` field).
         * When a new command arrives, the old one is cancelled via _clearScheduledCommand()
         * before the new one is scheduled, matching jellyfin-web's clearScheduledCommand().
         * @type {ReturnType<typeof setTimeout>|null}
         */
        this._scheduledCommandTimer = null;

        // ====================================================================
        // Event handler references (saved so we can .off() them on destroy)
        // ====================================================================

        this._onSyncPlayCommand     = null;
        this._onSyncPlayGroupUpdate = null;
        this._onTimeUpdate          = null;
        this._onWaiting             = null;
        this._onPlaying             = null;
    }

    // ========================================================================
    // Lifecycle
    // ========================================================================

    /**
     * Initialize the manager and subscribe to eventBus.
     * Call this once when the SyncPlay plugin is initialized.
     */
    init() {
        log.info('SyncPlayManager: init');

        // ----------------------------------------------------------------
        // Subscribe to WebSocket events (routed from WebSocketHandler)
        // ----------------------------------------------------------------

        this._onSyncPlayCommand = (data) => this._handleCommand(data);
        eventBus.on('syncplay:command', this._onSyncPlayCommand);

        this._onSyncPlayGroupUpdate = (data) => this._handleGroupUpdate(data);
        eventBus.on('syncplay:groupupdate', this._onSyncPlayGroupUpdate);
    }

    /**
     * Tear down event listeners and leave the group cleanly.
     * Call this when the SyncPlay plugin is destroyed.
     */
    destroy() {
        log.info('SyncPlayManager: destroy');

        if (this._isEnabled) {
            // Leave the group silently — don't await since we may be shutting down
            api.syncPlayLeave().catch(err => log.warn('Leave failed on destroy:', err));
        }

        this._disableInternal();

        // Unsubscribe from all eventBus events
        if (this._onSyncPlayCommand)     eventBus.off('syncplay:command',     this._onSyncPlayCommand);
        if (this._onSyncPlayGroupUpdate) eventBus.off('syncplay:groupupdate', this._onSyncPlayGroupUpdate);
    }

    // ========================================================================
    // Player Lifecycle (called by plugin)
    // ========================================================================

    /**
     * Called by the plugin whenever a new media item starts playing.
     * Updates the player reference and wires up player event listeners.
     *
     * @param {object} player - JellyfinPlayer instance
     */
    setPlayer(player) {
        // Unwire old player events
        this._unwirePlayerEvents();

        this._player = player;

        // Clear the old playback core instance so it is rebuilt on demand
        // by the getter, which safely injects the performProgrammaticSeek wrapper.
        if (this._playbackCoreInstance) {
            this._playbackCoreInstance.stopTracking();
            this._playbackCoreInstance = null;
        }

        // Wire up player events only if we're in a group
        if (this._isEnabled) {
            this._wirePlayerEvents();
        }

        log.info('SyncPlayManager: player updated');
    }

    /**
     * Called by the plugin when playback stops.
     * Stops drift correction but does NOT leave the group — the user stays in
     * the group so the next track can be synced too.
     */
    onPlayerStop() {
        log.info('SyncPlayManager: player stopped');
        this._unwirePlayerEvents();

        if (this._playbackCoreInstance) {
            this._playbackCoreInstance.stopTracking();
        }

        this._player = null;
    }

    // ========================================================================
    // Group Join / Leave (public API for the UI)
    // ========================================================================

    /**
     * Create a new SyncPlay group.
     *
     * We match jellyfin-web's behavior by fetching the current user's display
     * name and sending it as part of the group creation body so the server
     * names the group "Username's Group" instead of falling back to the UUID.
     *
     * @returns {Promise<void>}
     */
    async createGroup() {
        try {
            log.info('Creating SyncPlay group...');

            // -----------------------------------------------------------------
            // Build a human-readable group name: "Username's Group"
            // Gracefully fall back to a generic label if the user fetch fails.
            // -----------------------------------------------------------------
            let groupName = 'My Group';
            try {
                const user = await api.getCurrentUser();
                if (user?.Name) {
                    // Apostrophe possessive — matches the jellyfin-web locale key
                    // "SyncPlayGroupDefaultTitle" which resolves to "{0}'s Group"
                    groupName = `${user.Name}'s Group`;
                }
            } catch (userErr) {
                log.warn('Could not fetch user name for group creation, using default:', userErr);
            }

            log.info(`Creating SyncPlay group with name: "${groupName}"`);

            // Store the name locally so the status badge can display it —
            // the GroupJoined WebSocket event only carries GroupId, not GroupName.
            this._groupName = groupName;

            await api.syncPlayNew({ GroupName: groupName });

            // Server will send a SyncPlayGroupUpdate once the group is created
        } catch (err) {
            log.error('Failed to create SyncPlay group:', err);
            throw err;
        }
    }

    /**
     * Join an existing SyncPlay group.
     *
     * Before actually sending the join request we fetch the group list so we
     * can record the human-readable GroupName locally. The WebSocket response
     * that follows (GroupJoined) only contains the GroupId, so without this
     * step the badge would show the UUID.
     *
     * @param {string} groupId - The group ID (from syncPlayList())
     * @returns {Promise<void>}
     */
    async joinGroup(groupId) {
        try {
            log.info('Joining SyncPlay group:', groupId);

            // ----------------------------------------------------------------
            // Opportunistically look up the group name from the server list
            // before joining — the GroupJoined WebSocket event won't include it.
            // ----------------------------------------------------------------
            try {
                const groups = await api.syncPlayList();
                const target = groups?.find(g => g.GroupId === groupId);
                if (target?.GroupName) {
                    this._groupName = target.GroupName;
                    log.debug(`SyncPlay: resolved group name "${this._groupName}" for ${groupId}`);
                }
            } catch (listErr) {
                log.warn('Could not fetch group list for name resolution:', listErr);
            }

            await api.syncPlayJoin({ GroupId: groupId });
            // Server will respond with a SyncPlayGroupUpdate
        } catch (err) {
            log.error('Failed to join SyncPlay group:', err);
            throw err;
        }
    }

    /**
     * Leave the current SyncPlay group.
     * @returns {Promise<void>}
     */
    async leaveGroup() {
        try {
            log.info('Leaving SyncPlay group');
            await api.syncPlayLeave();
            this._disableInternal();
        } catch (err) {
            log.error('Failed to leave SyncPlay group:', err);
            throw err;
        }
    }

    /**
     * Whether the client is currently in a SyncPlay group.
     * @returns {boolean}
     */
    get isEnabled() {
        return this._isEnabled;
    }

    /**
     * Get information about the current SyncPlay group.
     * @returns {object|null}
     */
    get groupInfo() {
        return this._groupInfo;
    }

    /**
     * Human-readable name of the current group (e.g. "Alice's Group").
     * Set at create/join time since the WebSocket event only carries GroupId.
     * @returns {string|null}
     */
    get groupName() {
        return this._groupName;
    }

    // ========================================================================
    // Private — WebSocket Command Handlers
    // ========================================================================

    /**
     * Route an incoming SyncPlayCommand to the appropriate handler.
     * Command types mirror jellyfin-web's SyncPlayCommands enum.
     *
     * @private
     * @param {object} data - SyncPlayCommand payload from server
     */
    _handleCommand(data) {
        if (!data || !data.Command) return;

        log.debug('SyncPlayCommand:', data.Command, data);

        // Prevent our own player's reactions to this remote command
        // from being broadcast back to the server as a local action.
        this._ignoreLocalEventsAction = true;

        try {
            switch (data.Command) {
                // ----------------------------------------------------------------
                // Playback state commands
                // ----------------------------------------------------------------

                case 'Play':
                case 'Unpause':
                    this._handlePlayCommand(data);
                    break;

                case 'Pause':
                    this._handlePauseCommand(data);
                    break;

                case 'Stop':
                    this._handleStopCommand();
                    break;

                case 'Seek':
                    this._handleSeekCommand(data);
                    break;

                // ----------------------------------------------------------------
                // Buffering coordination commands
                // ----------------------------------------------------------------

                case 'WaitForNextItem':
                case 'WaitForContainerReady':
                    // Server is asking us to hold — if we're already playing,
                    // pause and send a buffering report to signal we're waiting.
                    this._handleWaitCommand(data);
                    break;

                case 'SetPlaylistItem':
                    // Server wants us to switch to a specific playlist slot
                    this._handleSetPlaylistItemCommand(data);
                    break;

                default:
                    log.debug('Unhandled SyncPlayCommand:', data.Command);
            }
        } finally {
            // Restore normal event processing. We use a short timeout because
            // the player's 'play'/'pause' events fire asynchronously after we call
            // this._player.pause() / play().
            setTimeout(() => {
                this._ignoreLocalEventsAction = false;
            }, 500);
        }
    }

    /**
     * Handle a SyncPlayGroupUpdate message.
     * These arrive when group membership or state changes
     * (join, leave, ready, queue update, etc.).
     *
     * @private
     * @param {object} data - SyncPlayGroupUpdate payload
     */
    _handleGroupUpdate(data) {
        if (!data || !data.Type) return;

        log.debug('SyncPlayGroupUpdate:', data.Type, data);

        switch (data.Type) {
            // ----------------------------------------------------------------
            // We successfully joined a group — enable SyncPlay mode.
            // The server sends GroupId at the top level of the message.
            // ----------------------------------------------------------------
            case 'GroupJoined':
                // data shape: { Type: 'GroupJoined', GroupId: '...', Data: { ... } }
                this._enableInternal(data);
                break;

            // ----------------------------------------------------------------
            // StateUpdate: the server echoes the group's current state.
            // This arrives alongside explicit SyncPlayCommands but also fires
            // on its own (e.g. when we first join a group that is already paused).
            // We must drive the player state here — the SyncPlayCommand may not
            // always arrive or may arrive slightly later.
            //
            // data.Data  = { State: 'Waiting'|'Playing'|'Paused', Reason: '...' }
            // ----------------------------------------------------------------
            case 'StateUpdate': {
                // Re-enable (in case we rejoined or need a group info refresh)
                this._enableInternal(data);

                const state  = data.Data?.State;
                const reason = data.Data?.Reason;

                log.info(`SyncPlay StateUpdate: state=${state} reason=${reason}`);

                if (state === 'Waiting') {
                    /*
                     * Group is waiting — either because someone paused, is
                     * buffering after a seek, or is waiting for a member to be ready.
                     * In all cases we should be paused locally.
                     */
                    if (this._player) {
                        this._playbackCore?.stopTracking();
                        this._player.pause();
                        log.info(`SyncPlay StateUpdate: pausing player (reason: ${reason})`);
                    }
                } else if (state === 'Playing') {
                    /*
                     * Group is playing — the explicit SyncPlayCommand 'Unpause'/'Play'
                     * carries the timing anchor and will handle the actual unpause +
                     * position correction. We just log here to avoid double-processing.
                     * If somehow we missed the SyncPlayCommand, the drift corrector
                     * in PlaybackCore will eventually re-align us.
                     */
                    log.debug('SyncPlay StateUpdate: group is playing — awaiting explicit Play command for timing');
                } else if (state === 'Paused') {
                    // Explicit paused state (no timing handshake needed)
                    if (this._player) {
                        this._playbackCore?.stopTracking();
                        this._player.pause();
                    }
                }
                break;
            }

            // ----------------------------------------------------------------
            // Client left the group (always us in litefin's case, as we handle
            // Leave manually via leaveGroup() → _disableInternal())
            // ----------------------------------------------------------------
            case 'GroupLeft':
                if (this._isEnabled) {
                    log.info('SyncPlay: left group (server notification)');
                    this._disableInternal();
                }
                break;

            // ----------------------------------------------------------------
            // Queue update — the server has changed what's in the group queue
            // ----------------------------------------------------------------
            case 'Queue':
                if (data.Queue?.Playlist) {
                    this._applyQueueUpdate(data.Queue);
                }
                break;

            // ----------------------------------------------------------------
            // Another user's ready/buffering state changed — no local action needed
            // ----------------------------------------------------------------
            case 'UserJoined':
            case 'UserLeft':
            case 'UserReady':
            case 'UserBuffering':
                log.debug('SyncPlay group membership event:', data.Type);
                // These are informational — we could update the UI later
                break;

            default:
                log.debug('Unhandled SyncPlayGroupUpdate type:', data.Type);
        }
    }

    // ========================================================================
    // Host Action Guarding
    // ========================================================================

    /**
     * Perform a player seek programmatically without triggering local host action broadcasts.
     * This is used for drift correction and incoming server commands.
     * @private
     */
    _programmaticSeek(positionTicks) {
        if (!this._player) return;

        // Temporarily suppress the _onSeek handler so it doesn't think the user
        // manually scrubbed the timeline and broadcast an echo to the server.
        this._ignoreLocalEventsAction = true;
        try {
            this._player.seek(positionTicks);
        } finally {
            // setTimeout ensures the suppression outlives the synchronous 'seek'
            // event, and briefly covers async event bubbles if any.
            setTimeout(() => {
                this._ignoreLocalEventsAction = false;
            }, 500);
        }
    }

    /**
     * Cancels any pending scheduled playback command (Pause or Play).
     * Matches jellyfin-web PlaybackCore.clearScheduledCommand().
     * @private
     */
    _clearScheduledCommand() {
        if (this._scheduledCommandTimer !== null) {
            clearTimeout(this._scheduledCommandTimer);
            this._scheduledCommandTimer = null;
        }
    }

    // ========================================================================
    // Private — Playback Command Implementations
    // ========================================================================

    /**
     * Provide the SyncPlayPlaybackCore instance, creating it if needed.
     * @private
     */
    get _playbackCore() {
        if (!this._playbackCoreInstance && this._player) {
            this._playbackCoreInstance = new SyncPlayPlaybackCore({
                timeSync: syncPlayTimeSync,
                player: this._player,
                // Provide our guarded seek method so drift corrections don't trigger local action echoes
                performProgrammaticSeek: (ticks) => this._programmaticSeek(ticks)
            });
        }
        return this._playbackCoreInstance;
    }

    /**
     * Handle Play / Unpause commands from the server.
     *
     * Matches jellyfin-web's scheduleUnpause():
     *   - If the play time (When) is in the FUTURE: seek to positionTicks,
     *     schedule the actual unpause() for exactly then.
     *   - If the play time is NOW or IN THE PAST: immediately unpause and
     *     seek to the estimated current position (compensating for how late we are).
     * @private
     */
    _handlePlayCommand(data) {
        if (!this._player) {
            log.warn('Play command received but no player is active');
            return;
        }

        // Cancel any pending scheduled command (another Pause/Play arrived)
        this._clearScheduledCommand();

        const positionTicks = data.PositionTicks ?? 0;
        const whenMs        = this._parseServerTime(data.When);

        if (whenMs === null) {
            log.warn('Play command missing When field');
            return;
        }

        // Convert server play-time to local clock
        const playAtLocalMs = syncPlayTimeSync.toLocal(whenMs);
        const nowMs         = Date.now();

        // Update playback anchor for drift correction (regardless of schedule)
        this._playbackCore?.setAnchor({ positionTicks, whenMs, isPlaying: true });

        if (playAtLocalMs > nowMs) {
            // ── Future play: pre-seek to the start position a touch early,
            //    then fire the actual unpause() at exactly the right moment.
            const delayMs = playAtLocalMs - nowMs;

            log.info(`SyncPlay Play: scheduled in ${Math.round(delayMs)}ms at tick=${Math.round(positionTicks / TICKS_PER_MS)}ms`);

            this._programmaticSeek(positionTicks);

            this._scheduledCommandTimer = setTimeout(() => {
                this._scheduledCommandTimer = null;

                log.debug('SyncPlay Play: executing scheduled unpause');

                // Mask so our _onPlaying listener doesn't re-intercept this
                this._ignoreLocalEventsAction = true;
                try {
                    this._player.unpause();
                } finally {
                    setTimeout(() => { this._ignoreLocalEventsAction = false; }, 500);
                }

                this._playbackCore?.startTracking();
            }, delayMs);

        } else {
            // ── Immediate (or late) play: figure out where we should be *now*
            //    by extrapolating from the server's anchor.
            const lateMs       = nowMs - playAtLocalMs;
            const currentTicks = positionTicks + (lateMs * TICKS_PER_MS);

            log.info(
                `SyncPlay Play: executing now (${Math.round(lateMs)}ms late), ` +
                `seeking to ${Math.round(currentTicks / TICKS_PER_MS)}ms`
            );

            this._programmaticSeek(Math.max(0, currentTicks));

            // Mask so our _onPlaying listener doesn't re-intercept this
            this._ignoreLocalEventsAction = true;
            try {
                this._player.unpause();
            } finally {
                setTimeout(() => { this._ignoreLocalEventsAction = false; }, 500);
            }

            this._playbackCore?.startTracking();
        }
    }

    /**
     * Handle Pause commands from the server.
     *
     * Matches jellyfin-web's schedulePause():
     *   - Schedule the actual pause() at exactly `When`.
     *   - After the player fires its own 'pause' event, snap to positionTicks.
     *     This prevents a visible jump before the pause is committed.
     * @private
     */
    _handlePauseCommand(data) {
        if (!this._player) return;

        // Cancel any pending scheduled command
        this._clearScheduledCommand();

        const positionTicks = data.PositionTicks ?? 0;
        const whenMs        = this._parseServerTime(data.When);

        log.info(`SyncPlay Pause at ${Math.round(positionTicks / TICKS_PER_MS)}ms`);

        // Stop drift correction — anchor is now stale
        this._playbackCore?.stopTracking();

        // Update anchor (frozen — isPlaying:false stops drift accumulation)
        if (whenMs !== null) {
            this._playbackCore?.setAnchor({ positionTicks, whenMs, isPlaying: false });
        }

        /**
         * The actual pause action: pause the player, then wait for the player's
         * own 'pause' event to fire. Only AFTER it fires do we seek to the
         * server's requested position. This prevents a frame-jump where the
         * video snaps to the new position before the player has stopped rendering.
         */
        const doPause = () => {
            // Listen for the pause event once, then seek to correct tick
            const onPause = () => {
                this._player.off('pause', onPause);

                // Snap to the server's canonical position on pause
                if (positionTicks > 0) {
                    this._programmaticSeek(positionTicks);
                }
            };

            this._player.on('pause', onPause);

            // Suppress the _onPause local-action echo since this is server-side
            this._ignoreLocalEventsAction = true;
            this._player.pause();
            setTimeout(() => { this._ignoreLocalEventsAction = false; }, 500);
        };

        const pauseAtLocalMs = whenMs !== null ? syncPlayTimeSync.toLocal(whenMs) : Date.now();
        const nowMs = Date.now();

        if (pauseAtLocalMs > nowMs) {
            const delayMs = pauseAtLocalMs - nowMs;
            log.debug(`SyncPlay Pause: scheduled in ${Math.round(delayMs)}ms`);

            this._scheduledCommandTimer = setTimeout(() => {
                this._scheduledCommandTimer = null;
                doPause();
            }, delayMs);
        } else {
            doPause();
        }
    }

    /**
     * Handle Stop commands from the server.
     * Stops playback but keeps us in the group.
     * @private
     */
    _handleStopCommand() {
        if (!this._player) return;

        log.info('SyncPlay Stop');

        this._playbackCore?.stopTracking();
        this._player.stop();
    }

    /**
     * Handle Seek commands from the server.
     *
     * The SyncPlay seek protocol (matches jellyfin-web's scheduleSeek()):
     *
     *   1. Stop drift tracking immediately — the anchor is stale after a seek.
     *   2. Pause the player so we don't keep playing while repositioning.
     *   3. Seek to the requested positionTicks.
     *   4. Wait for the player to finish buffering (the 'playing' event fires
     *      once the new position is buffered and ready to go).
     *   5. Immediately re-pause (we do NOT want to start playing yet).
     *   6. Report syncPlayReady to the server — "I'm at the right spot, waiting."
     *
     * The server tracks which group members have reported ready and, once ALL
     * of them have, broadcasts a Play command with a shared start time so every
     * client resumes in unison. That Play arrives and is handled by
     * _handlePlayCommand which unpauses at the correct, time-corrected position.
     *
     * Without this handshake our client would start playing immediately while the
     * host (and the server) waited for the group to reconverge — which is exactly
     * the bug the user reported.
     *
     * @private
     */
    _handleSeekCommand(data) {
        if (!this._player) return;

        const positionTicks = data.PositionTicks ?? 0;

        log.info(`SyncPlay Seek to ${Math.round(positionTicks / TICKS_PER_MS)}ms — entering buffering handshake`);

        // ── Step 1: stop drift correction, anchor is now invalid ──────────────
        this._playbackCore?.stopTracking();

        // ── Step 2: pause so we stop advancing while we reposition ────────────
        this._player.pause();

        // ── Step 3: seek to the target position ───────────────────────────────
        this._programmaticSeek(positionTicks);

        // ── Steps 4–6: wait until the player has finished buffering the new ───
        // position, then pause and report Ready. The server will send a Play
        // command once all group members have reported Ready.
        //
        // We listen for the 'timeupdate' event which fires once the player
        // has successfully seeked and the new time is registered. Waiting for
        // 'playing' is dangerous because if the player was already paused,
        // it will just fire 'seeked' and 'timeupdate', but never 'playing'!
        const timeout = 6000; // 6s max — don't hang forever if the event never fires
        let settled = false;

        const onTimeUpdate = () => {
            if (settled) return;
            settled = true;

            // Remove the listener immediately to avoid it firing again
            this._player.off('timeupdate', onTimeUpdate);

            log.debug('SyncPlay Seek: player registered new time after seek — pausing and reporting ready to server');

            // Pause straight away — we must NOT start playing yet
            this._player.pause();

            // Tell the server we're at the seek position and waiting for the group
            this._reportBuffering(/* isPlaying= */ true);
        };

        // Attach as a regular listener (JellyfinPlayer has no .once() API)
        this._player.on('timeupdate', onTimeUpdate);

        // Safety timeout: if the event never arrives (e.g. the seek
        // failed silently), still report ready after a fallback delay so we
        // don't block the entire group indefinitely.
        setTimeout(() => {
            if (settled) return;
            settled = true;

            // Clean up the dangling listener
            this._player.off('timeupdate', onTimeUpdate);

            log.warn('SyncPlay Seek: timed out waiting for timeupdate event after seek — force-reporting ready');
            this._player.pause();
            this._reportBuffering(/* isPlaying= */ true);
        }, timeout);
    }

    /**
     * Handle WaitForNextItem / WaitForContainerReady commands.
     * The server is asking everyone to hold so the group can re-sync.
     * @private
     */
    _handleWaitCommand(data) {
        if (!this._player) return;

        log.info('SyncPlay: server asked us to wait (buffering coordination)');

        this._playbackCore?.stopTracking();
        this._player.pause();

        // Report that we are now waiting (ready = false)
        this._reportBuffering(false);
    }

    /**
     * Handle SetPlaylistItem — server wants us to switch to a different queue item.
     * @private
     */
    _handleSetPlaylistItemCommand(data) {
        const playlistItemId = data.PlaylistItemId;

        if (!playlistItemId) {
            log.warn('SetPlaylistItem missing PlaylistItemId');
            return;
        }

        log.info('SyncPlay: switching to playlist item', playlistItemId);

        this._currentPlaylistItemId = playlistItemId;

        // Find the item in the current queue
        const queue   = playQueue.getQueue();
        const itemIdx = queue.findIndex(i => i.PlaylistItemId === playlistItemId);

        if (itemIdx === -1) {
            log.warn('SetPlaylistItem: item not found in queue:', playlistItemId);
            return;
        }

        const newItem = queue[itemIdx];

        // Emit a remote:play-like event so PlayerPage can handle the switch.
        // Rather than reimplementing playback here we piggyback on existing infra.
        eventBus.emit('syncplay:switchitem', {
            item:  newItem,
            index: itemIdx
        });
    }

    // ========================================================================
    // Private — Group Lifecycle
    // ========================================================================

    /**
     * Activate SyncPlay mode with the provided group info.
     * Starts the time-sync loop and wires player events.
     * @private
     */
    _enableInternal(groupInfo) {
        const wasEnabled = this._isEnabled;

        this._isEnabled  = true;
        this._groupInfo  = groupInfo;

        if (!wasEnabled) {
            // Start clock synchronization
            syncPlayTimeSync.enable();
            log.info(`SyncPlay enabled — group: ${groupInfo?.GroupId || 'unknown'}`);
        }

        // Wire player events if we have a player (we may not yet on first join)
        if (this._player) {
            this._wirePlayerEvents();
        }

        // Notify UI that SyncPlay is active
        eventBus.emit('syncplay:enabled', groupInfo);
    }

    /**
     * Deactivate SyncPlay mode: stop the sync loop, unwire events, clear state.
     * @private
     */
    _disableInternal() {
        if (!this._isEnabled) return;

        log.info('SyncPlay disabled');

        this._isEnabled             = false;
        this._groupInfo             = null;
        this._groupName             = null;  // Clear the stored human-readable name
        this._currentPlaylistItemId = null;
        this._isBuffering           = false;

        this._playbackCore?.stopTracking();
        this._unwirePlayerEvents();
        syncPlayTimeSync.disable();

        // Notify UI
        eventBus.emit('syncplay:disabled');
    }

    // ========================================================================
    // Private — Player Event Wiring
    // ========================================================================

    // ========================================================================
    // Player Events Wiring
    // ========================================================================

    /**
     * Wire the player's events to our handlers.
     * @private
     */
    _wirePlayerEvents() {
        if (!this._player) return;

        // Remove any stale handlers first
        this._unwirePlayerEvents();

        // --------------------------------------------------------------------
        // Drift Correction & Buffering Reporting
        // --------------------------------------------------------------------

        // Time update → check for drift
        this._onTimeUpdate = (positionTicks) => {
            this._playbackCore?.onTimeUpdate(positionTicks);
        };
        this._player.on('timeupdate', this._onTimeUpdate);

        // Player started buffering → tell the server to wait for us
        this._onWaiting = () => {
            if (!this._isBuffering) {
                this._isBuffering = true;
                this._reportBuffering(false); // isPlaying = false while buffering
            }
        };
        this._player.on('waiting', this._onWaiting);

        // Player resumed/started playing
        this._onPlaying = () => {
            // When buffering resolves and player resumes, clear buffering state
            if (this._isBuffering) {
                this._isBuffering = false;
                this._reportBuffering(true); // isPlaying = true again
            }

            // Propagate local play events (iff not triggered by a SyncPlayCommand),
            // but DON'T intercept the play — just tell the server.
            // The server will respond with a Play command to re-sync the group.
            if (!this._ignoreLocalEventsAction) {
                this._reportLocalAction('Unpause');
            }
        };
        this._player.on('playing', this._onPlaying);

        // --------------------------------------------------------------------
        // Host Action Propagation (Local user pressed pause/seek)
        // --------------------------------------------------------------------

        this._onPause = () => {
            if (!this._ignoreLocalEventsAction && !this._isBuffering) {
                this._reportLocalAction('Pause');
            }
        };
        this._player.on('pause', this._onPause);

        this._onSeek = () => {
            if (!this._ignoreLocalEventsAction) {
                const ticks = this._player.getCurrentPositionTicks?.() ?? 0;
                log.info(`SyncPlay: local seek detected at ${Math.round(ticks / TICKS_PER_MS)}ms, broadcasting to group...`);

                // We must mask local events immediately following a user seek.
                // The player will fire 'waiting' as it loads new segments, and if
                // we report isPlaying:false to the server now, it will think the
                // user manually paused, leaving the group parked after the seek!
                this._ignoreLocalEventsAction = true;
                
                api.syncPlaySeek(ticks).catch(err => log.error('Failed to broadcast seek:', err));

                setTimeout(() => {
                    this._ignoreLocalEventsAction = false;
                }, 1000); // Give the player a second to settle
            }
        };
        this._player.on('seek', this._onSeek);

        log.debug('Player events wired for SyncPlay');
    }

    /**
     * Helper to broadcast a local play/pause state change to the server.
     * @private
     */
    _reportLocalAction(action) {
        log.info(`SyncPlay: local ${action} detected, broadcasting to group...`);
        const payload = {
            When: new Date().toISOString(),
            PositionTicks: this._player?.getCurrentPositionTicks?.() ?? 0,
            IsPlaying: action === 'Unpause',
            PlaylistItemId: this._currentPlaylistItemId || undefined
        };

        if (action === 'Unpause') {
            api.syncPlayUnpause(payload).catch(err => log.error('Failed to broadcast play:', err));
        } else if (action === 'Pause') {
            api.syncPlayPause(payload).catch(err => log.error('Failed to broadcast pause:', err));
        }
    }

    /**
     * Remove all player event handlers attached by _wirePlayerEvents.
     * @private
     */
    _unwirePlayerEvents() {
        if (!this._player) return;

        if (this._onTimeUpdate) {
            this._player.off('timeupdate', this._onTimeUpdate);
            this._onTimeUpdate = null;
        }
        if (this._onWaiting) {
            this._player.off('waiting', this._onWaiting);
            this._onWaiting = null;
        }
        if (this._onPlaying) {
            this._player.off('playing', this._onPlaying);
            this._onPlaying = null;
        }
        if (this._onPause) {
            this._player.off('pause', this._onPause);
            this._onPause = null;
        }
        if (this._onSeek) {
            this._player.off('seek', this._onSeek);
            this._onSeek = null;
        }
    }

    // ========================================================================
    // Private — Buffering Reports
    // ========================================================================

    /**
     * Report our buffering/ready state to the server.
     *
     * @private
     * @param {boolean} isPlaying - True = we're playing (ready), false = buffering
     */
    _reportBuffering(isPlaying) {
        // Throttle to prevent flooding the server during rapid buffer events
        const now = Date.now();
        if (now - this._lastBufferingReportMs < BUFFERING_REPORT_THROTTLE_MS) return;
        this._lastBufferingReportMs = now;

        if (!this._player) return;

        const positionTicks     = this._player.getCurrentPositionTicks?.() ?? 0;
        const currentLocalTimeMs = Date.now();

        const payload = {
            // ISO8601 — the server uses this to compute clock-adjusted triggers
            When:             new Date(currentLocalTimeMs).toISOString(),
            PositionTicks:    positionTicks,
            IsPlaying:        isPlaying,
            PlaylistItemId:   this._currentPlaylistItemId || undefined
        };

        if (isPlaying) {
            log.debug('SyncPlay: reporting ready (isPlaying=true)');
            api.syncPlayReady(payload).catch(err => log.warn('syncPlayReady failed:', err));
        } else {
            log.debug('SyncPlay: reporting buffering (isPlaying=false)');
            api.syncPlayBuffering(payload).catch(err => log.warn('syncPlayBuffering failed:', err));
        }
    }

    // ========================================================================
    // Private — Queue Update
    // ========================================================================

    /**
     * Apply an updated group queue from the server.
     * Maps server-format PlaylistItems to the format PlayQueue expects.
     *
     * @private
     * @param {object} queueData - Queue object from SyncPlayGroupUpdate
     */
    _applyQueueUpdate(queueData) {
        const playlist = queueData.Playlist;
        if (!Array.isArray(playlist) || playlist.length === 0) return;

        const startIndex = queueData.StartIndex ?? 0;

        log.info(`SyncPlay: applying queue update — ${playlist.length} items, startIndex=${startIndex}`);

        // PlayQueue.setQueue() expects item objects with PlaylistItemId already stamped
        playQueue.setQueue(playlist, startIndex);

        // Track which playlist slot is current so commands can be matched
        const currentItem = playQueue.getCurrentItem();
        this._currentPlaylistItemId = currentItem?.PlaylistItemId || null;
    }

    // ========================================================================
    // Private — Utility
    // ========================================================================

    /**
     * Parse an ISO8601 server timestamp string to a local milliseconds integer.
     * Returns null if missing or unparseable.
     * @private
     */
    _parseServerTime(isoString) {
        if (!isoString) return null;
        const ms = Date.parse(isoString);
        return isNaN(ms) ? null : ms;
    }
}

// Singleton exported for the plugin and UI to share
export const syncPlayManager = new SyncPlayManager();

// Explicitly expose to window to bypass Webpack 5 TDZ issues with dynamic module getter evaluation 
// in certain circular import topologies involving the UI layer.
window.__syncPlayManager = syncPlayManager;
