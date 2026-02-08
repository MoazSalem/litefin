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
        console.log('WebSocketHandler: Initialized');
    }

    /**
     * Handle incoming WebSocket message
     * Routes to appropriate handler based on MessageType
     * @param {Object} msg - Parsed WebSocket message
     * @private
     */
    _onMessage(msg) {
        if (!msg || !msg.MessageType) return;

        console.log('[WebSocketHandler] Received:', msg.MessageType, msg.Data);

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
            // Other message types (ignored for now)
            // ================================================================
            default:
                // UserDataChanged, SyncPlay, etc. - not handled yet
                break;
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

        console.log('[WebSocketHandler] Playstate:', data.Command);

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
                console.log('[WebSocketHandler] Unknown Playstate command:', data.Command);
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

        console.log('[WebSocketHandler] GeneralCommand:', data.Name);

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
            // Navigation (optional, nice to have)
            // ================================================================
            case 'GoHome':
                eventBus.emit('remote:home');
                break;

            case 'Back':
                eventBus.emit('remote:back');
                break;

            default:
                console.log('[WebSocketHandler] Unhandled GeneralCommand:', data.Name);
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

        console.log('[WebSocketHandler] Play:', data.PlayCommand, data.ItemIds);

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
                console.log('[WebSocketHandler] Unknown PlayCommand:', playCommand);
        }
    }
}

// ============================================================================
// Export Singleton
// ============================================================================

export const webSocketHandler = new WebSocketHandler();
export default WebSocketHandler;
