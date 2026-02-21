/**
 * ============================================================================
 * Litefin Tizen - WebSocket Handler
 * ============================================================================
 * Processes incoming WebSocket commands from Jellyfin server.
 * Enables remote control from Jellyfin dashboard (pause, stop, messages, etc.)
 * ============================================================================
 */

import { eventBus } from '../core/EventBus.js';
import { toast } from '../ui/Toast.js';
import { logger } from '../utils/Logger.js';
import { focusManager } from '../ui/FocusManager.js';
import { router } from '../core/Router.js';

const log = logger.create('WebSocketHandler');

// ============================================================================
// WebSocketHandler Class
// ============================================================================

class WebSocketHandler {
    constructor() {
        // Bind the handler method
        this._onMessage = this._onMessage.bind(this);
    }

    /**
     * Initialize WebSocket handler
     * Should be called after EventBus is ready
     */
    init() {
        // Listen for WebSocket messages from ApiClient
        eventBus.on('websocket:message', this._onMessage);
        log.info('Initialized');
    }

    /**
     * Handle incoming WebSocket message
     * Routes to appropriate handler based on MessageType
     * @param {Object} msg - Parsed WebSocket message
     * @private
     */
    _onMessage(msg) {
        if (!msg || !msg.MessageType) return;

        log.debug('Received:', msg.MessageType, msg.Data);

        switch (msg.MessageType) {
            // ================================================================
            // Playback State Commands (Pause, Stop, Seek, etc.)
            // ================================================================
            case 'Playstate':
                this._handlePlaystate(msg.Data);
                break;

            // ================================================================
            // General Commands (Messages, Volume, Navigation)
            // ================================================================
            case 'GeneralCommand':
                this._handleGeneralCommand(msg.Data);
                break;

            // ================================================================
            // Play Commands (Remote playback initiation)
            // ================================================================
            case 'Play':
                this._handlePlay(msg.Data);
                break;
            // ================================================================
            // UserDataChanged — another client toggled favourite, watched, etc.
            // Re-emit so PlayerPage can sync the OSD favourite button.
            // ================================================================
            case 'UserDataChanged':
                if (msg.Data?.UserDataList?.length) {
                    eventBus.emit('remote:userdatachanged', msg.Data.UserDataList);
                }
                break;

            // ================================================================
            // Unhandled message types - log for debugging
            // ================================================================
            default: {
                // These are routine server-push updates — no action required.
                const SILENT_TYPES = new Set([
                    'Sessions', // Session list refresh (polled by dashboard)
                    'KeepAlive', // Server keepalive echo
                    'ForceKeepAlive', // Server asks us to send a keepalive
                    'LibraryChanged', // Library scan completed
                    'RefreshProgress', // Library metadata refresh progress
                    'ScheduledTaskEnded',
                    'PackageInstallationCompleted'
                ]);

                if (!SILENT_TYPES.has(msg.MessageType)) {
                    // Genuinely unexpected — log so we can diagnose new command types
                    log.warn('Unhandled WebSocket message type:', msg.MessageType, JSON.stringify(msg.Data));
                }
                break;
            }
        }
    }

    // ========================================================================
    // Playstate Handler
    // ========================================================================

    /**
     * Handle Playstate commands from server
     * @param {Object} data - Command data with Command field
     * @private
     */
    _handlePlaystate(data) {
        if (!data || !data.Command) return;

        log.info('Playstate:', data.Command);

        switch (data.Command) {
            case 'Pause':
                // Pause playback
                eventBus.emit('remote:pause');
                break;

            case 'Unpause':
                // Resume playback
                eventBus.emit('remote:play');
                break;

            case 'PlayPause':
                // Toggle pause/play
                eventBus.emit('remote:playpause');
                break;

            case 'Stop':
                // Stop playback entirely
                eventBus.emit('remote:stop');
                break;

            case 'Seek':
                // Seek to specific position
                // data.SeekPositionTicks is the target position
                if (data.SeekPositionTicks !== undefined) {
                    eventBus.emit('remote:seek', data.SeekPositionTicks);
                }
                break;

            case 'NextTrack':
                // Skip to next item in queue
                eventBus.emit('remote:next');
                break;

            case 'PreviousTrack':
                // Go to previous item in queue
                eventBus.emit('remote:previous');
                break;

            default:
                log.warn('Unknown Playstate command:', data.Command);
        }
    }

    // ========================================================================
    // GeneralCommand Handler
    // ========================================================================

    /**
     * Handle GeneralCommand from server
     * @param {Object} data - Command data with Name and Arguments fields
     * @private
     */
    _handleGeneralCommand(data) {
        if (!data || !data.Name) return;

        log.info('GeneralCommand:', data.Name);

        switch (data.Name) {
            // ================================================================
            // Display Message - Show toast notification
            // ================================================================
            case 'DisplayMessage':
                this._displayMessage(data.Arguments);
                break;

            // ================================================================
            // Volume Controls
            // ================================================================
            case 'SetVolume':
                // Set absolute volume (0-100)
                if (data.Arguments?.Volume !== undefined) {
                    eventBus.emit('remote:volume', parseInt(data.Arguments.Volume, 10));
                }
                break;

            case 'VolumeUp':
                eventBus.emit('remote:volumeup');
                break;

            case 'VolumeDown':
                eventBus.emit('remote:volumedown');
                break;

            case 'Mute':
                eventBus.emit('remote:mute', true);
                break;

            case 'Unmute':
                eventBus.emit('remote:mute', false);
                break;

            case 'ToggleMute':
                eventBus.emit('remote:togglemute');
                break;

            // ================================================================
            // Audio/Subtitle Track Selection
            // ================================================================
            case 'SetAudioStreamIndex':
                if (data.Arguments?.Index !== undefined) {
                    eventBus.emit('remote:audiotrack', parseInt(data.Arguments.Index, 10));
                }
                break;

            case 'SetSubtitleStreamIndex':
                if (data.Arguments?.Index !== undefined) {
                    eventBus.emit('remote:subtitle', parseInt(data.Arguments.Index, 10));
                }
                break;

            // ================================================================
            // D-Pad Navigation — mirrors TV remote arrow keys.
            //
            // Two-tier approach:
            //   1. Emit remote:navigate so PlayerPage can forward to OSD when
            //      the player is active (FocusManager is suspended in that state).
            //   2. Also call focusManager._handleKey() for regular app navigation
            //      when the player is NOT active.
            // ================================================================
            case 'MoveUp':
                eventBus.emit('remote:navigate', 'up');
                focusManager._handleKey('up');
                break;

            case 'MoveDown':
                eventBus.emit('remote:navigate', 'down');
                focusManager._handleKey('down');
                break;

            case 'MoveLeft':
                eventBus.emit('remote:navigate', 'left');
                focusManager._handleKey('left');
                break;

            case 'MoveRight':
                eventBus.emit('remote:navigate', 'right');
                focusManager._handleKey('right');
                break;

            case 'Select':
                // Emit remote:select so OSD can handle it as 'enter' when
                // the player is active and FocusManager is suspended.
                eventBus.emit('remote:select');
                // Fallback for non-player screens: click the focused element.
                if (!focusManager._isSuspended) {
                    const focused = focusManager.getFocused();
                    if (focused) {
                        focused.click();
                    } else {
                        document.activeElement?.click();
                    }
                }
                break;

            // ================================================================
            // App Navigation
            // ================================================================
            case 'GoHome':
                eventBus.emit('remote:home');
                break;

            case 'GoToSettings':
                // Navigate directly to the Settings page.
                // If the player is active this will exit it first (router destroys current page).
                router.navigate('/settings');
                break;

            case 'GoToSearch':
                // Navigate directly to the Search page.
                router.navigate('/search');
                break;

            case 'Back':
                eventBus.emit('remote:back');
                break;

            // ================================================================
            // Queue state (Shuffle / Repeat)
            // ================================================================
            case 'SetRepeatMode':
                if (data.Arguments?.RepeatMode !== undefined) {
                    eventBus.emit('remote:repeatmode', data.Arguments.RepeatMode);
                }
                break;

            case 'SetShuffleQueue':
                // The web client sends "SetShuffleQueue" command.
                // Arguments usually contain { ItemId: '...', Mode: 'Shuffle' } or { Mode: 'Sorted' }
                if (data.Arguments?.Mode !== undefined) {
                    const isShuffled = String(data.Arguments.Mode).toLowerCase() === 'shuffle';
                    eventBus.emit('remote:shufflemode', isShuffled);
                } else if (data.Arguments?.ShuffleMode !== undefined) {
                    // Fallback just in case
                    const isShuffled = String(data.Arguments.ShuffleMode).toLowerCase() === 'true';
                    eventBus.emit('remote:shufflemode', isShuffled);
                }
                break;

            default:
                log.warn('Unhandled GeneralCommand:', data.Name);
        }
    }

    /**
     * Display a message from the server
     * Shows as toast (auto-dismiss) or alert (requires dismiss)
     * @param {Object} args - Message arguments (Header, Text, TimeoutMs)
     * @private
     */
    _displayMessage(args) {
        if (!args) return;

        const header = args.Header || '';
        const text = args.Text || '';
        const timeout = args.TimeoutMs || 5000; // Default 5 seconds

        // Combine header and text for display
        const message = header ? `${header}: ${text}` : text;

        // Show as auto-dismiss toast
        toast.show(message, timeout);
    }

    // ========================================================================
    // Play Handler
    // ========================================================================

    /**
     * Handle Play command - remote playback initiation
     * @param {Object} data - Play data with ItemIds and PlayCommand
     * @private
     */
    _handlePlay(data) {
        if (!data || !data.ItemIds || data.ItemIds.length === 0) return;

        log.info('Play:', data.PlayCommand, data.ItemIds);

        // PlayCommand can be: PlayNow, PlayNext, PlayLast
        const playCommand = data.PlayCommand || 'PlayNow';

        switch (playCommand) {
            case 'PlayNow':
                // Start playing immediately
                eventBus.emit('remote:playnow', {
                    itemIds: data.ItemIds,
                    startPositionTicks: data.StartPositionTicks || 0,
                    startIndex: data.StartIndex || 0,
                    mediaSourceId: data.MediaSourceId,
                    audioStreamIndex: data.AudioStreamIndex,
                    subtitleStreamIndex: data.SubtitleStreamIndex
                });
                break;

            case 'PlayNext':
                // Add to queue as next item
                eventBus.emit('remote:playnext', { itemIds: data.ItemIds });
                break;

            case 'PlayLast':
                // Add to end of queue
                eventBus.emit('remote:queue', { itemIds: data.ItemIds });
                break;

            default:
                log.warn('Unknown PlayCommand:', playCommand);
        }
    }
}

// ============================================================================
// Export Singleton
// ============================================================================

export const webSocketHandler = new WebSocketHandler();
export default WebSocketHandler;
