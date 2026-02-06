/**
 * PlayerBridge - WebView ↔ Host Communication
 * 
 * Exposes player controls via window.JellyfinPlayer and handles
 * postMessage communication with host apps (e.g., Litefin).
 * 
 * @module bridge/PlayerBridge
 */

import { postToHost, listenToHost } from './EventEmitter';
import { debug } from '../utils/debug';

// ============================================================================
// PlayerBridge Class
// ============================================================================

export class PlayerBridge {
    /**
     * @param {JellyfinPlayer} player - Player instance
     * @param {SettingsManager} settings - Settings manager
     */
    constructor(player, settings) {
        this.player = player;
        this.settings = settings;

        this._cleanupListener = null;
    }

    /**
     * Attach bridge to window and start listening for messages
     */
    attach() {
        // Expose API on window for host app access
        window.JellyfinPlayer = this._createApi();

        // Forward player events to host
        this._setupEventForwarding();

        // Listen for commands from host
        this._cleanupListener = listenToHost(this._handleHostMessage.bind(this));

        debug.log('[PlayerBridge] Attached to window.JellyfinPlayer');

        // Notify host that player is ready
        postToHost('ready', { version: '0.1.0' });
    }

    /**
     * Create the public API object
     * @private
     */
    _createApi() {
        const player = this.player;
        const settings = this.settings;

        return {
            // ================================================================
            // Playback Control
            // ================================================================

            /**
             * Play media
             * @param {Object} options - Play options
             */
            async play(options) {
                return player.play(options);
            },

            /**
             * Pause playback
             */
            pause() {
                player.pause();
            },

            /**
             * Resume playback
             */
            unpause() {
                player.unpause();
            },

            /**
             * Toggle play/pause
             */
            togglePlay() {
                player.togglePlay();
            },

            /**
             * Stop playback
             */
            async stop() {
                return player.stop();
            },

            /**
             * Seek to position
             * @param {number} positionTicks - Position in ticks
             */
            seek(positionTicks) {
                player.seek(positionTicks);
            },

            /**
             * Seek forward by skip length
             */
            skipForward() {
                player.seekRelative(settings.skipForwardLength);
            },

            /**
             * Seek backward by skip length
             */
            skipBack() {
                player.seekRelative(-settings.skipBackLength);
            },

            // ================================================================
            // Volume Control
            // ================================================================

            /**
             * Set volume (0-100)
             */
            setVolume(volume) {
                player.setVolume(volume);
            },

            /**
             * Get current volume
             */
            getVolume() {
                return player.getVolume();
            },

            /**
             * Toggle mute
             */
            toggleMute() {
                player.toggleMute();
            },

            /**
             * Check if muted
             */
            isMuted() {
                return player.isMuted();
            },

            // ================================================================
            // Track Selection
            // ================================================================

            /**
             * Set audio track
             */
            setAudioTrack(index) {
                player.setAudioStreamIndex(index);
            },

            /**
             * Set subtitle track (-1 to disable)
             */
            setSubtitleTrack(index) {
                player.setSubtitleStreamIndex(index);
            },

            /**
             * Get available audio tracks
             */
            getAudioTracks() {
                return player.getAudioTracks();
            },

            /**
             * Get available subtitle tracks
             */
            getSubtitleTracks() {
                return player.getSubtitleTracks();
            },

            // ================================================================
            // State
            // ================================================================

            /**
             * Get current position in ticks
             */
            getPosition() {
                return player.getCurrentPositionTicks();
            },

            /**
             * Get duration in ticks
             */
            getDuration() {
                return player.getDurationTicks();
            },

            /**
             * Check if playing
             */
            isPlaying() {
                return player.isPlaying();
            },

            /**
             * Check if paused
             */
            isPaused() {
                return player.isPaused();
            },

            /**
             * Get current item info
             */
            getCurrentItem() {
                return player.getCurrentItem();
            },

            // ================================================================
            // Fullscreen
            // ================================================================

            /**
             * Toggle fullscreen
             */
            toggleFullscreen() {
                player.toggleFullscreen();
            },

            /**
             * Check if fullscreen
             */
            isFullscreen() {
                return player.isFullscreen();
            },

            // ================================================================
            // Settings
            // ================================================================

            /**
             * Get all settings
             */
            getSettings() {
                return settings.exportSettings();
            },

            /**
             * Update settings
             */
            setSettings(data) {
                settings.importSettings(data);
            },

            /**
             * Reset settings to defaults
             */
            resetSettings() {
                settings.resetToDefaults();
            },

            // ================================================================
            // Events
            // ================================================================

            /**
             * Subscribe to player events
             */
            on(event, callback) {
                player.on(event, callback);
            },

            /**
             * Unsubscribe from events
             */
            off(event, callback) {
                player.off(event, callback);
            },

            // ================================================================
            // Destroy
            // ================================================================

            /**
             * Destroy player
             */
            destroy() {
                player.destroy();
            }
        };
    }

    /**
     * Set up forwarding of player events to host
     * @private
     */
    _setupEventForwarding() {
        const events = [
            'play', 'pause', 'stop',
            'timeupdate', 'volumechange',
            'playbackstart', 'playbackstop',
            'mediastreamschange', 'error',
            'fullscreenchange', 'statechange'
        ];

        for (const event of events) {
            this.player.on(event, (data) => {
                postToHost(event, data);
            });
        }
    }

    /**
     * Handle incoming messages from host
     * @private
     */
    _handleHostMessage(message) {
        const { command, ...params } = message;

        debug.log('[PlayerBridge] Received command:', command, params);

        const api = window.JellyfinPlayer;
        if (!api) return;

        try {
            switch (command) {
                case 'play':
                    api.play(params);
                    break;
                case 'pause':
                    api.pause();
                    break;
                case 'unpause':
                    api.unpause();
                    break;
                case 'togglePlay':
                    api.togglePlay();
                    break;
                case 'stop':
                    api.stop();
                    break;
                case 'seek':
                    api.seek(params.positionTicks);
                    break;
                case 'skipForward':
                    api.skipForward();
                    break;
                case 'skipBack':
                    api.skipBack();
                    break;
                case 'setVolume':
                    api.setVolume(params.volume);
                    break;
                case 'toggleMute':
                    api.toggleMute();
                    break;
                case 'setAudioTrack':
                    api.setAudioTrack(params.index);
                    break;
                case 'setSubtitleTrack':
                    api.setSubtitleTrack(params.index);
                    break;
                case 'toggleFullscreen':
                    api.toggleFullscreen();
                    break;
                case 'getState':
                    postToHost('state', {
                        isPlaying: api.isPlaying(),
                        isPaused: api.isPaused(),
                        position: api.getPosition(),
                        duration: api.getDuration(),
                        volume: api.getVolume(),
                        isMuted: api.isMuted(),
                        isFullscreen: api.isFullscreen(),
                        currentItem: api.getCurrentItem()
                    });
                    break;
                default:
                    debug.warn('[PlayerBridge] Unknown command:', command);
            }
        } catch (e) {
            debug.error('[PlayerBridge] Command error:', e);
            postToHost('error', { command, error: e.message });
        }
    }

    /**
     * Detach bridge and clean up
     */
    detach() {
        if (this._cleanupListener) {
            this._cleanupListener();
            this._cleanupListener = null;
        }

        delete window.JellyfinPlayer;
    }
}
