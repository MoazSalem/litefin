/**
 * JellyfinPlayer - Main orchestrating class
 *
 * Manages video playback using either HtmlVideoPlayer or TizenAVPlayer backend.
 * Handles media source selection, track switching, and playback state.
 *
 * Integrated directly into litefin — no UMD bundle, no bridge, no standalone
 * settings manager. Uses litefin's Logger and PlayerSettings.
 *
 * @module core/JellyfinPlayer
 */

import { HtmlVideoPlayer } from './HtmlVideoPlayer.js';
import { TizenAVPlayer } from './TizenAVPlayer.js';
import { MediaHelper } from './MediaHelper.js';
import { buildJellyfinProfile } from '../../api/DeviceProfile.js';
import { SubtitleParser } from './SubtitleParser.js';
import { logger } from '../../utils/Logger.js';
import { PlayerSettings } from '../../utils/PlayerSettings.js';

const log = logger.create('JellyfinPlayer');

// ============================================================================
// Minimal EventEmitter (inlined from player/src/bridge/EventEmitter.js)
// Only the on/off/once/emit/removeAllListeners subset — no postMessage stuff.
// ============================================================================

class EventEmitter {
    constructor() {
        this._listeners = {};
    }

    /**
     * Register a listener for an event
     * @param {string} event - Event name
     * @param {Function} callback - Callback function
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
     * Register a one-time listener
     * @param {string} event - Event name
     * @param {Function} callback - Callback function
     * @returns {this}
     */
    once(event, callback) {
        const wrapper = (...args) => {
            this.off(event, wrapper);
            callback.apply(this, args);
        };
        wrapper._original = callback;
        return this.on(event, wrapper);
    }

    /**
     * Remove a listener
     * @param {string} event - Event name
     * @param {Function} callback - Callback function
     * @returns {this}
     */
    off(event, callback) {
        if (!this._listeners[event]) return this;
        this._listeners[event] = this._listeners[event].filter(
            (fn) => fn !== callback && fn._original !== callback
        );
        return this;
    }

    /**
     * Emit an event to all registered listeners
     * @param {string} event - Event name
     * @param {...*} args - Arguments to pass to listeners
     * @returns {this}
     */
    emit(event, ...args) {
        const listeners = this._listeners[event];
        if (listeners) {
            // Iterate a copy so listeners can safely remove themselves
            [...listeners].forEach((fn) => fn.apply(this, args));
        }
        return this;
    }

    /**
     * Remove all listeners, optionally for a specific event
     * @param {string} [event] - Event name (omit to clear all)
     * @returns {this}
     */
    removeAllListeners(event) {
        if (event) {
            delete this._listeners[event];
        } else {
            this._listeners = {};
        }
        return this;
    }
}

// ============================================================================
// Player Events
// ============================================================================

export const PlayerEvent = {
    PLAY: 'play',
    PAUSE: 'pause',
    STOP: 'stop',
    TIME_UPDATE: 'timeupdate',
    VOLUME_CHANGE: 'volumechange',
    PLAYBACK_START: 'playbackstart',
    PLAYBACK_STOP: 'playbackstop',
    MEDIA_STREAMS_CHANGE: 'mediastreamschange',
    ERROR: 'error',
    FULLSCREEN_CHANGE: 'fullscreenchange',
    STATE_CHANGE: 'statechange'
};

// ============================================================================
// JellyfinPlayer Class
// ============================================================================

export class JellyfinPlayer extends EventEmitter {
    /**
     * @param {Object} options - Player options
     * @param {HTMLElement} options.container - Container element for the player
     * @param {string} options.serverUrl - Jellyfin server URL
     * @param {string} options.authToken - Authentication token
     * @param {boolean} [options.useTizenPlayer=false] - Use Tizen native player
     */
    constructor(options) {
        super();

        // ====================================================================
        // Configuration
        // ====================================================================

        this.container = options.container;
        this.serverUrl = options.serverUrl;
        this.authToken = options.authToken;
        this.useTizenPlayer = options.useTizenPlayer || false;

        // ====================================================================
        // State
        // ====================================================================

        this._currentItem = null;
        this._currentMediaSource = null;
        this._currentPlayOptions = null;
        this._isPlaying = false;
        this._isPaused = false;

        // Secondary Subtitle State
        this._currentSecondarySubtitleStreamIndex = -1;
        this._secondaryCues = [];
        this._lastSecondaryCue = null;

        // ====================================================================
        // Player Backend
        // ====================================================================

        this._backend = null;
        // Device profile now uses unified api/DeviceProfile module

        // Initialize the appropriate backend
        this._initBackend();
    }

    // ========================================================================
    // Initialization
    // ========================================================================

    /**
     * Initialize the player backend based on platform
     * @private
     */
    _initBackend() {
        // Check for Tizen AVPlay API (can be on tizen or webapis namespace)
        const hasAvPlay = !!(window.tizen?.avplay || window.webapis?.avplay);

        log.info(
            'Initializing backend. useTizenPlayer:',
            this.useTizenPlayer,
            'detected:',
            hasAvPlay
        );

        if (this.useTizenPlayer && hasAvPlay) {
            log.info('Using Tizen AVPlay backend');
            this._backend = new TizenAVPlayer({
                container: this.container,
                settings: PlayerSettings,
                onEvent: this._handleBackendEvent.bind(this)
            });
        } else {
            log.info('Using HTML5 Video backend');
            this._backend = new HtmlVideoPlayer({
                container: this.container,
                settings: PlayerSettings,
                onEvent: this._handleBackendEvent.bind(this)
            });
        }
    }

    /**
     * Handle events from the backend player
     * @private
     */
    _handleBackendEvent(event) {
        // Sync internal state
        if (event.type === PlayerEvent.PAUSE) {
            this._isPaused = true;
        } else if (event.type === PlayerEvent.PLAY || event.type === PlayerEvent.PLAYING) {
            this._isPaused = false;
        }

        // Handle timeupdate for syncing secondary subtitles
        if (event.type === PlayerEvent.TIME_UPDATE && event.data?.time !== undefined) {
            this._updateSecondarySubtitles(event.data.time);
        }

        // Re-emit events from backend
        this.emit(event.type, event.data);
    }

    // ========================================================================
    // Playback Control
    // ========================================================================

    /**
     * Play media item
     *
     * @param {Object} options - Play options
     * @param {string} options.itemId - Jellyfin item ID
     * @param {string} [options.mediaSourceId] - Specific media source ID
     * @param {number} [options.startPositionTicks=0] - Start position in ticks
     * @param {number} [options.audioStreamIndex] - Audio track index
     * @param {number} [options.subtitleStreamIndex] - Subtitle track index
     * @returns {Promise<void>}
     */
    async play(options) {
        log.info('Play requested:', options);

        // Update server URL/Auth if provided in play options
        if (options.serverUrl) this.serverUrl = options.serverUrl;
        if (options.authToken) this.authToken = options.authToken;

        this._currentPlayOptions = options;

        try {
            log.debug(`Requesting PlaybackInfo from ${this.serverUrl}...`);

            // Build device profile once (avoids duplicate logs/work)
            const deviceProfile = buildJellyfinProfile();

            // Get playback info from server
            const playbackInfo = await this._getPlaybackInfo(options, deviceProfile);
            log.debug('PlaybackInfo received:', playbackInfo);

            if (!playbackInfo || !playbackInfo.MediaSources?.length) {
                log.error('No media sources in PlaybackInfo');
                throw new Error('No media sources available');
            }

            // Select best media source
            const mediaSource = options.mediaSourceId
                ? playbackInfo.MediaSources.find((ms) => ms.Id === options.mediaSourceId)
                : playbackInfo.MediaSources[0];

            if (!mediaSource) {
                log.error('Media source selection failed');
                throw new Error('Media source not found');
            }

            // Attach play session ID to media source
            if (playbackInfo.PlaySessionId) {
                mediaSource.PlaySessionId = playbackInfo.PlaySessionId;
            }

            this._currentMediaSource = mediaSource;
            this._currentItem = options.item || { Id: options.itemId };

            // Initialize current stream indices
            this._currentAudioStreamIndex = options.audioStreamIndex;
            this._currentSubtitleStreamIndex = options.subtitleStreamIndex;

            // If not provided, try to find default from MediaSource
            if (this._currentAudioStreamIndex === undefined && mediaSource.MediaStreams) {
                const audioStream =
                    mediaSource.MediaStreams.find((s) => s.Type === 'Audio' && s.IsDefault) ||
                    mediaSource.MediaStreams.find((s) => s.Type === 'Audio');
                if (audioStream) this._currentAudioStreamIndex = audioStream.Index;
            }

            // If not provided, subtitles default to -1 (off) or forced
            if (this._currentSubtitleStreamIndex === undefined && mediaSource.MediaStreams) {
                const subStream = mediaSource.MediaStreams.find(
                    (s) => s.Type === 'Subtitle' && (s.IsDefault || s.IsForced)
                );
                if (subStream) this._currentSubtitleStreamIndex = subStream.Index;
                else this._currentSubtitleStreamIndex = -1;
            }

            // Build stream URL
            const streamInfo = MediaHelper.buildStreamUrl({
                serverUrl: this.serverUrl,
                itemId: options.itemId,
                mediaSource,
                startPositionTicks: options.startPositionTicks || 0,
                playSessionId: playbackInfo.PlaySessionId,
                authToken: this.authToken,
                deviceProfile: deviceProfile
            });

            log.debug('Stream Info built:', streamInfo);

            // Start playback on backend
            log.info('Initializing backend playback...');
            await this._backend.play({
                ...streamInfo,
                item: this._currentItem,
                mediaSource,
                startPositionTicks: options.startPositionTicks || 0,
                audioStreamIndex: options.audioStreamIndex,
                subtitleStreamIndex: options.subtitleStreamIndex
            });
            log.info('Backend play() promise resolved');

            this._isPlaying = true;
            this._isPaused = false;

            this.emit(PlayerEvent.PLAYBACK_START, {
                item: this._currentItem,
                mediaSource
            });
        } catch (error) {
            log.error('Playback error caught:', error);
            this.emit(PlayerEvent.ERROR, { error, type: 'playback' });
            throw error;
        }
    }

    /**
     * Pause playback
     */
    pause() {
        this._backend?.pause();
        // State update and event emission handled by _handleBackendEvent
    }

    /**
     * Resume playback
     */
    unpause() {
        this._backend?.unpause();
        // State update and event emission handled by _handleBackendEvent
    }

    /**
     * Toggle play/pause
     */
    togglePlay() {
        if (this._isPaused) {
            this.unpause();
        } else {
            this.pause();
        }
    }

    /**
     * Stop playback
     */
    async stop() {
        if (this._backend) {
            await this._backend.stop();
        }

        const item = this._currentItem;
        const positionTicks = this.getCurrentPositionTicks();

        this._currentItem = null;
        this._currentMediaSource = null;
        this._currentPlayOptions = null;
        this._isPlaying = false;
        this._isPaused = false;

        this.emit(PlayerEvent.PLAYBACK_STOP, {
            item,
            positionTicks
        });
    }

    /**
     * Seek to position
     * @param {number} positionTicks - Position in ticks (1 tick = 100 nanoseconds)
     */
    seek(positionTicks) {
        this._backend?.seek(positionTicks);
    }

    /**
     * Seek relative to current position
     * @param {number} offsetMs - Offset in milliseconds (positive = forward)
     */
    seekRelative(offsetMs) {
        const currentMs = this.getCurrentPositionMs();
        const newMs = Math.max(0, currentMs + offsetMs);
        this.seek(newMs * 10000); // Convert ms to ticks
    }

    // ========================================================================
    // Volume Control
    // ========================================================================

    /**
     * Set volume
     * @param {number} volume - Volume level (0-100)
     */
    setVolume(volume) {
        this._backend?.setVolume(volume);
        this.emit(PlayerEvent.VOLUME_CHANGE, { volume });
    }

    /**
     * Get current volume
     * @returns {number} Volume level (0-100)
     */
    getVolume() {
        return this._backend?.getVolume() ?? 100;
    }

    /**
     * Toggle mute
     */
    toggleMute() {
        this._backend?.toggleMute();
    }

    /**
     * Check if muted
     * @returns {boolean}
     */
    isMuted() {
        return this._backend?.isMuted() ?? false;
    }

    // ========================================================================
    // Track Selection
    // ========================================================================

    /**
     * Set audio track
     * @param {number} index - Audio stream index (Jellyfin ID)
     */
    setAudioStreamIndex(index) {
        this._currentAudioStreamIndex = index;

        // Tizen AVPlay expects 0-based index of available tracks
        // HtmlVideoPlayer expects Stream ID
        if (this._backend instanceof TizenAVPlayer) {
            const tracks = this.getAudioTracks();
            const listIndex = tracks.findIndex((t) => t.Index === index);
            if (listIndex !== -1) {
                log.debug('Converting StreamID', index, 'to Tizen Index', listIndex);
                this._backend.setAudioStreamIndex(listIndex);
            } else {
                log.warn('StreamID', index, 'not found in audio tracks');
            }
        } else {
            this._backend?.setAudioStreamIndex(index);
        }

        this.emit(PlayerEvent.MEDIA_STREAMS_CHANGE, { audioStreamIndex: index });
    }

    /**
     * Set subtitle track
     * @param {number} index - Subtitle stream index (-1 to disable)
     */
    setSubtitleStreamIndex(index) {
        this._currentSubtitleStreamIndex = index;

        if (this._backend instanceof TizenAVPlayer) {
            if (index === -1) {
                this._backend.setSubtitleStreamIndex(-1);
            } else {
                const tracks = this.getSubtitleTracks();
                const listIndex = tracks.findIndex((t) => t.Index === index);
                if (listIndex !== -1) {
                    this._backend.setSubtitleStreamIndex(listIndex);
                } else {
                    log.warn('Subtitle StreamID', index, 'not found');
                }
            }
        } else {
            this._backend?.setSubtitleStreamIndex(index);
        }

        this.emit(PlayerEvent.MEDIA_STREAMS_CHANGE, { subtitleStreamIndex: index });
    }

    /**
     * Set subtitle offset
     * @param {number} seconds - Offset in seconds
     */
    setSubtitleOffset(seconds) {
        this._backend?.setSubtitleOffset(seconds);
    }

    /**
     * Get current audio stream index
     * @returns {number}
     */
    getCurrentAudioStreamIndex() {
        return this._currentAudioStreamIndex;
    }

    /**
     * Get current subtitle stream index
     * @returns {number}
     */
    getCurrentSubtitleStreamIndex() {
        return this._currentSubtitleStreamIndex;
    }

    // ========================================================================
    // Secondary Subtitle Support
    // ========================================================================

    /**
     * Set secondary subtitle stream index
     * @param {number} index - Stream index (-1 to disable)
     */
    async setSecondarySubtitleStreamIndex(index) {
        if (this._currentSecondarySubtitleStreamIndex === index) return;

        log.info('Setting secondary subtitle index:', index);
        this._currentSecondarySubtitleStreamIndex = index;
        this._secondaryCues = [];
        this._lastSecondaryCue = null;

        // Clear current display
        this.emit('secondarysubtitlechange', { text: '' });

        if (index !== -1) {
            await this._fetchAndParseSecondarySubtitle(index);
        }

        this.emit(PlayerEvent.MEDIA_STREAMS_CHANGE, { secondarySubtitleStreamIndex: index });
    }

    /**
     * Get current secondary subtitle stream index
     * @returns {number}
     */
    getCurrentSecondarySubtitleStreamIndex() {
        return this._currentSecondarySubtitleStreamIndex;
    }

    /**
     * Fetch and parse secondary subtitle file
     * @private
     */
    async _fetchAndParseSecondarySubtitle(streamIndex) {
        if (!this._currentMediaSource || !this._currentItem) {
            log.warn('Cannot fetch secondary subtitle - no media source');
            return;
        }

        // Find the subtitle track
        const tracks = this.getSubtitleTracks();
        const track = tracks.find((t) => t.Index === streamIndex);
        if (!track) {
            log.warn('Secondary subtitle track not found:', streamIndex);
            return;
        }

        try {
            const url = MediaHelper.getSubtitleUrl(
                track,
                this.serverUrl,
                this._currentItem.Id,
                this._currentMediaSource.Id,
                this.authToken,
                'vtt'
            );

            log.debug('Fetching secondary subtitle:', url);
            const response = await fetch(url);
            if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);

            const text = await response.text();
            this._secondaryCues = SubtitleParser.parse(text);
            log.info(`Parsed ${this._secondaryCues.length} secondary subtitle cues`);
        } catch (err) {
            log.error('Failed to load secondary subtitle:', err);
            this._secondaryCues = [];
        }
    }

    /**
     * Update secondary subtitles based on current playback time
     * @private
     */
    /**
     * Refresh subtitle styles
     * delegate to backend if supported
     */
    refreshSubtitles() {
        if (this._backend && this._backend.refreshSubtitles) {
            this._backend.refreshSubtitles();
        } else {
             this.emit('refreshsubtitles');
        }
    }
    _updateSecondarySubtitles(currentTimeSeconds) {
        // Skip if no cues loaded
        if (!this._secondaryCues.length) return;

        // Find active cue for current time
        const activeCue = this._secondaryCues.find(
            (cue) => currentTimeSeconds >= cue.start && currentTimeSeconds <= cue.end
        );

        if (activeCue) {
            // Only emit if cue changed
            if (this._lastSecondaryCue !== activeCue) {
                this._lastSecondaryCue = activeCue;
                this.emit('secondarysubtitlechange', {
                    text: activeCue.text,
                    duration: (activeCue.end - activeCue.start) * 1000
                });
            }
        } else {
            // Clear display if no active cue
            if (this._lastSecondaryCue !== null) {
                this._lastSecondaryCue = null;
                this.emit('secondarysubtitlechange', { text: '' });
            }
        }
    }

    /**
     * Get current stream type
     * @returns {string} 'HLS' or 'Video'
     */
    getStreamType() {
        if (this._backend && this._backend._hlsPlayer) {
            return 'HLS';
        }
        return 'Video';
    }

    /**
     * Get available audio tracks
     * @returns {Array} Audio streams
     */
    getAudioTracks() {
        return this._currentMediaSource?.MediaStreams?.filter((s) => s.Type === 'Audio') || [];
    }

    /**
     * Get available subtitle tracks
     * @returns {Array} Subtitle streams
     */
    getSubtitleTracks() {
        return this._currentMediaSource?.MediaStreams?.filter((s) => s.Type === 'Subtitle') || [];
    }

    // ========================================================================
    // State Getters
    // ========================================================================

    /**
     * Get current position in ticks
     * @returns {number}
     */
    getCurrentPositionTicks() {
        return Math.round((this._backend?.getCurrentTime() ?? 0) * 10000000);
    }

    /**
     * Get current position in milliseconds
     * @returns {number}
     */
    getCurrentPositionMs() {
        return (this._backend?.getCurrentTime() ?? 0) * 1000;
    }

    /**
     * Get total duration in ticks
     * @returns {number}
     */
    getDurationTicks() {
        return this._currentMediaSource?.RunTimeTicks ?? 0;
    }

    /**
     * Check if currently playing
     * @returns {boolean}
     */
    isPlaying() {
        return this._isPlaying && !this._isPaused;
    }

    /**
     * Check if paused
     * @returns {boolean}
     */
    isPaused() {
        return this._isPaused;
    }

    /**
     * Get current item
     * @returns {Object|null}
     */
    getCurrentItem() {
        return this._currentItem;
    }

    /**
     * Get current media source
     * @returns {Object|null}
     */
    getCurrentMediaSource() {
        return this._currentMediaSource;
    }

    // ========================================================================
    // Fullscreen
    // ========================================================================

    /**
     * Toggle fullscreen mode
     */
    toggleFullscreen() {
        this._backend?.toggleFullscreen();
    }

    /**
     * Check if in fullscreen
     * @returns {boolean}
     */
    isFullscreen() {
        return this._backend?.isFullscreen() ?? false;
    }

    // ========================================================================
    // API Helpers
    // ========================================================================

    /**
     * Get playback info from Jellyfin server
     * @private
     */
    async _getPlaybackInfo(options, deviceProfile) {
        const url = `${this.serverUrl}/Items/${options.itemId}/PlaybackInfo`;

        // Read max bitrate from litefin's PlayerSettings
        const maxBitrate = PlayerSettings.get('maxBitrateInternet') || 120000000;

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `MediaBrowser Token="${this.authToken}"`
            },
            body: JSON.stringify({
                DeviceProfile: deviceProfile || buildJellyfinProfile(),
                UserId: options.userId,
                MaxStreamingBitrate: maxBitrate,
                StartTimeTicks: options.startPositionTicks || 0,
                AudioStreamIndex: options.audioStreamIndex,
                SubtitleStreamIndex: options.subtitleStreamIndex,
                MediaSourceId: options.mediaSourceId,
                AutoOpenLiveStream: true
            })
        });

        if (!response.ok) {
            throw new Error(`Failed to get playback info: ${response.status}`);
        }

        return response.json();
    }

    // ========================================================================
    // Cleanup
    // ========================================================================

    /**
     * Destroy the player and clean up resources
     */
    destroy() {
        this.stop();
        this._backend?.destroy();
        this._backend = null;
        this.removeAllListeners();
    }
}
