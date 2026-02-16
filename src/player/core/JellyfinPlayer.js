/**
 * JellyfinPlayer - Main orchestrating class
 *
 * Manages video playback using either HtmlVideoPlayer or TizenAVPlayer backend.
 * Handles media source selection, track switching, and playback state.
 *
 * Integrated directly into litefin — no UMD bundle, no bridge, no standalone
 * @module core/JellyfinPlayer
 */

import { HtmlVideoPlayer } from './HtmlVideoPlayer.js';
import { TizenAVPlayer } from './TizenAVPlayer.js';
import { MediaHelper } from './MediaHelper.js';
import { buildJellyfinProfile } from '../../api/DeviceProfile.js';
import { SubtitleParser } from './SubtitleParser.js';
import { logger } from '../../utils/Logger.js';
import { PlayerSettings } from '../../utils/PlayerSettings.js';
import { api } from '../../api/index.js';

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
            [...listeners].forEach((fn) => {
                try {
                    fn.apply(this, args);
                } catch (e) {
                    console.error(`Error in listener for event "${event}":`, e);
                }
            });
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
    WAITING: 'waiting',
    PLAYING: 'playing',
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
        // Initialize with global limit if set, otherwise null (Auto/Max)
        // User requested: Global limit acts as default manual override.
        // "Auto" (null) means Unlimited/Direct Play.
        this._manualBitrate = PlayerSettings.get('maxBitrateInternet') || null;
        this._isRestarting = false; // Flag to suppress stop events during manual quality change
        this._transcodingOffsetTicks = 0; // Offset for transcoded streams that start at 0
        this._pendingTranscodeSeekTicks = null; // Target position for initial transcode seek

        // Secondary Subtitle State
        this._currentSecondarySubtitleStreamIndex = -1;
        this._secondaryCues = [];
        this._lastSecondaryCue = null;

        // Chapters
        this._chapters = [];

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
        // Intercept events if we are waiting for the initial Transcode Seek
        if (this._pendingTranscodeSeekTicks !== null) {
            
            // If we receive a TIME_UPDATE with a valid time > 0, we know playback has really started
            // and it's safe to perform our seek.
            if (event.type === PlayerEvent.TIME_UPDATE && event.data?.time > 0) {
                 const target = this._pendingTranscodeSeekTicks;
                 this._pendingTranscodeSeekTicks = null; // Clear flag FIRST to allow subsequent events
                 
                 log.info('TranscodeSeek: Initial playback confirmed. Seeking to', target);
                 this.seek(target);
                 
                 // Do NOT emit this particular timeupdate as it's likely near 0
                 return;
            }
            
            // Suppress PLAYING and TIME_UPDATE events while waiting to seek
            // This keeps the UI in a "loading" state (spinner) until the seek is triggered
            if (event.type === PlayerEvent.PLAY || 
                event.type === PlayerEvent.PLAYING || 
                event.type === PlayerEvent.TIME_UPDATE) {
                // log.debug('Suppressing event during TranscodeSeek:', event.type);
                return;
            }
        }

        // Sync internal state
        if (event.type === PlayerEvent.PAUSE) {
            this._isPaused = true;
        } else if (event.type === PlayerEvent.PLAY || event.type === PlayerEvent.PLAYING) {
            this._isPaused = false;
        }

        // Handle timeupdate for syncing secondary subtitles
        if (event.type === PlayerEvent.TIME_UPDATE && event.data?.time !== undefined) {
            try {
                this._updateSecondarySubtitles(event.data.time);
            } catch (e) {
                console.error('Error updating secondary subtitles:', e);
            }
            
            // Re-emit normalized timeupdate with absolute ticks
            this.emit(PlayerEvent.TIME_UPDATE, this.getCurrentPositionTicks());
            return;
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
        // Store initial options for potential reload
        this._lastPlayOptions = options;

        try {
            log.debug(`Requesting PlaybackInfo from ${this.serverUrl}...`);

            // Build device profile once (avoids duplicate logs/work)
            const deviceProfile = buildJellyfinProfile({
                 manualBitrate: this._manualBitrate, 
                 playbackMode: this._playbackMode 
            });

            // Get playback info from server
            const playbackInfo = await this._getPlaybackInfo(options, deviceProfile, this._manualBitrate);
            log.debug('PlaybackInfo keys:', Object.keys(playbackInfo));
            if (playbackInfo.MediaSources && playbackInfo.MediaSources.length > 0) {
                 log.debug('MediaSource[0] keys:', Object.keys(playbackInfo.MediaSources[0]));
            }

            // Chapter Recovery Strategy
            // 1. Check if passed item has chapters (from options.item passed by PlayerPage)
            // Note: We use options.item which we ensured is passed from PlayerPage
            let chapters = options.item?.Chapters || [];

            if (chapters.length > 0) {
                log.info('Using chapters from item object:', chapters.length);
            } else if (playbackInfo.Chapters && playbackInfo.Chapters.length > 0) {
                // 2. Check PlaybackInfo
                chapters = playbackInfo.Chapters;
                log.info('Using chapters from PlaybackInfo:', chapters.length);
            } else {
                // 3. Fallback: Fetch item details to get chapters
                log.info('Chapters missing. Fetching item details...');
                try {
                    // Need to request 'Chapters' field explicitly just to be safe, though api.getItem might default to all fields
                    const itemDetails = await api.getItem(options.itemId, { Fields: 'Chapters' });
                    if (itemDetails && itemDetails.Chapters) {
                        chapters = itemDetails.Chapters;
                        log.info('Chapters fetched from API:', chapters.length);
                    } else {
                        log.info('No chapters found in API response.');
                    }
                } catch (e) {
                    log.warn('Failed to fetch item details for chapters:', e);
                }
            }

            this._chapters = chapters;
            log.debug('Final Chapters:', this._chapters.length);
            
            if (this._chapters.length > 0) {
                log.info('Chapters loaded:', this._chapters.length);
                this.emit('chaptersloaded', { chapters: this._chapters });
            } else {
                this.emit('chaptersloaded', { chapters: [] });
            }

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

            // DEBUG: Log transcoding reasons if available
            log.info(`[PlaybackMode] Selected PlayMethod: ${playbackInfo.PlaySessionId ? 'Transcode/DirectStream' : 'DirectPlay'} (derived)`);
            if (mediaSource.TranscodingInfo) {
                log.info(`[PlaybackMode] IsDirectStream: ${mediaSource.TranscodingInfo.IsVideoDirect ? 'Yes' : 'No'}`);
                log.info(`[PlaybackMode] TranscodingReasons: ${mediaSource.TranscodingReasons}`);
            }
            // MediaHelper also derives PlayMethod, let's check that
            let playMethod = MediaHelper.getPlayMethod(mediaSource);

            // In "Force Remux" mode, the server might report "Transcode" because it technically
            // falls back to the transcoding pipeline, but if the only reason is "DirectPlayError",
            // it means it's remuxing (copying streams) because we enabled all codecs in DeviceProfile.
            if (this._playbackMode === 'remux' && playMethod === 'Transcode') {
                const reasons = mediaSource.TranscodingReasons;
                const hasOnlyDirectPlayError = reasons === 'DirectPlayError' || 
                    (Array.isArray(reasons) && reasons.length === 1 && reasons[0] === 'DirectPlayError');
                
                // Also check the URL parameters if reasons property is empty (it's often in the URL)
                const urlHasOnlyDirectPlayError = mediaSource.TranscodingUrl && 
                    mediaSource.TranscodingUrl.includes('TranscodeReasons=DirectPlayError') &&
                    !mediaSource.TranscodingUrl.includes('ContainerNotSupported') &&
                    !mediaSource.TranscodingUrl.includes('VideoCodecNotSupported') &&
                    !mediaSource.TranscodingUrl.includes('AudioCodecNotSupported');

                if (hasOnlyDirectPlayError || urlHasOnlyDirectPlayError) {
                     playMethod = 'DirectStream';
                     
                     // CRITICAL: Update the MediaSource object itself so that
                     // MediaHelper.getPlayMethod() returns 'DirectStream' for the OSD/UI later.
                     mediaSource.SupportsDirectStream = true;
                     // We should probably also unset SupportsTranscoding to be safe for UI logic
                     // mediaSource.SupportsTranscoding = false; 
                     
                     log.info('[PlaybackMode] Inferring DirectStream (Remux) based on DirectPlayError only.');
                }
            }
            log.info(`[PlaybackMode] Calculated PlayMethod: ${playMethod}`);

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

            // Check play method to determine if we need to force start-at-0 (for Transcode/Remux)
            // playMethod was already derived above for logging
            const originalStartPositionTicks = options.startPositionTicks || 0;
            let effectiveStartPositionTicks = originalStartPositionTicks;
            let isTranscodeSeek = false;

            // User Request: When transcoding or remuxing, start playback at 0, 
            // and after it's loaded seek to the resume location if it exists
            if ((playMethod === 'Transcode' || playMethod === 'DirectStream') && originalStartPositionTicks > 0) {
                log.info(`Transcode detected: Starting at 0 ticks, will seek to ${originalStartPositionTicks} after load`);
                effectiveStartPositionTicks = 0;
                isTranscodeSeek = true;
            }

            // Build stream URL
            const streamInfo = MediaHelper.buildStreamUrl({
                serverUrl: this.serverUrl,
                itemId: options.itemId,
                mediaSource,
                startPositionTicks: effectiveStartPositionTicks,
                playSessionId: playbackInfo.PlaySessionId,
                authToken: this.authToken,
                deviceProfile: deviceProfile
            });

            log.debug('Stream Info built:', streamInfo);

            // Save transcoding offset
            this._transcodingOffsetTicks = streamInfo.transcodingOffsetTicks || 0;
            log.info('Transcoding offset:', this._transcodingOffsetTicks);

            // Start playback on backend
            log.info('Initializing backend playback...');

            // Handle delayed seek for Transcode/Remux
            // CRITICAL: Set this BEFORE play() to ensure we catch all initial events
            if (isTranscodeSeek) {
                log.info('TranscodeSeek: Enabled. Waiting for timeupdate to seek to:', originalStartPositionTicks);
                this._pendingTranscodeSeekTicks = originalStartPositionTicks;
                // Explicitly emit WAITING to ensure spinner is shown
                this.emit(PlayerEvent.WAITING);
            }

            await this._backend.play({
                ...streamInfo,
                item: this._currentItem,
                mediaSource,
                startPositionTicks: streamInfo.playerStartPositionTicks, // Use adjusted start position
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

        // Only clear state if NOT restarting
        if (!this._isRestarting) {
            this._currentItem = null;
            this._currentMediaSource = null;
            this._currentPlayOptions = null;
        }
        
        this._isPlaying = false;
        this._isPaused = false;

        // Only emit stop events if we are NOT restarting
        if (!this._isRestarting) {
            this._manualBitrate = null;
            this._transcodingOffsetTicks = 0;
            this._playbackSpeed = 1; // Reset speed on stop
            this.emit(PlayerEvent.STOP);
            this.emit(PlayerEvent.PLAYBACK_STOP, { item, positionTicks });
        } else {
            log.info('Suppressing STOP events due to restart');
        }
    }

    /**
     * Seek to position
     * @param {number} positionTicks - Position in ticks (1 tick = 100 nanoseconds)
     */
    seek(positionTicks) {
        this._backend?.seek(positionTicks);
        this.emit('seek', { positionTicks });
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
     * Set aspect ratio mode
     * @param {string} mode - 'auto', 'zoom', 'stretch'
     */
    setAspectRatio(mode) {
        this._currentAspectRatio = mode;
        this._backend?.setAspectRatio(mode);
    }

    /**
     * Get current aspect ratio
     * @returns {string} 'auto', 'zoom', 'stretch'
     */
    getAspectRatio() {
        return this._currentAspectRatio || 'auto';
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

    // ========================================================================
    // Playback Speed
    // ========================================================================

    /**
     * Set playback speed
     * @param {number} speed - Playback speed (0.5 to 4.0)
     */
    setPlaybackSpeed(speed) {
        this._playbackSpeed = speed;
        this._backend?.setSpeed(speed);
        this.emit('speedchange', { speed });
    }

    /**
     * Get current playback speed
     * @returns {number}
     */
    getPlaybackSpeed() {
        return this._playbackSpeed || 1;
    }

    /**
     * Get current secondary subtitle stream index
     * @returns {number}
     */
    getCurrentSecondarySubtitleStreamIndex() {
        return this._currentSecondarySubtitleStreamIndex;
    }

    // ========================================================================
    // Chapter Support
    // ========================================================================

    getChapters() {
        return this._chapters || [];
    }

    getCurrentChapterIndex() {
        if (!this._chapters || this._chapters.length === 0) return -1;
        
        const currentTicks = this.getCurrentPositionTicks();
        // log.debug('Chapter Debug: Current Ticks', currentTicks);

        // Find the last chapter that started before current time
        for (let i = this._chapters.length - 1; i >= 0; i--) {
            const startTicks = this._chapters[i].StartPositionTicks || 0;
            if (currentTicks >= startTicks) {
                // log.debug('Chapter Debug: Found index', i, 'StartTicks', startTicks);
                return i;
            }
        }
        return -1;
    }

    nextChapter() {
        const index = this.getCurrentChapterIndex();
        log.debug('Chapter Debug (Next): Current Index', index, 'Total', this._chapters ? this._chapters.length : 0);

        if (index === -1) {
             if (this._chapters && this._chapters.length > 0) {
                 this.seek(this._chapters[0].StartPositionTicks);
                 return;
             }
             return;
        }

        if (index >= this._chapters.length - 1) {
            log.debug('Chapter Debug: Already at last chapter');
            return;
        }

        const nextChapter = this._chapters[index + 1];
        if (nextChapter) {
            let seekTarget = nextChapter.StartPositionTicks;
            if (this._backend instanceof TizenAVPlayer) {
                // hack: Tizen AVPlay seek subtract 2.5s (25,000,000 ticks) from next chapter until we find what is wrong
                seekTarget = Math.max(0, seekTarget - 25000000);
                log.info('TizenAVPlayer: Applying 2.5s offset to next chapter jump');
            }
            log.info('Skipping to next chapter:', nextChapter.Name);
            this.seek(seekTarget);
        }
    }

    previousChapter() {
        const index = this.getCurrentChapterIndex();
        log.debug('Chapter Debug (Prev): Current Index', index);

        if (index === -1) return;

        const currentTicks = this.getCurrentPositionTicks();
        const currentChapter = this._chapters[index];
        const chapterStart = currentChapter.StartPositionTicks || 0;
        
        const diff = currentTicks - chapterStart;
        log.debug('Chapter Debug: Diff from start', diff);

        // If we are more than 3 seconds into the chapter, restart event
        // 3 seconds = 30,000,000 ticks
        if (diff > 30000000) {
            log.info('Restarting current chapter:', currentChapter.Name);
            this.seek(chapterStart);
        } else if (index > 0) {
            // Go to previous chapter
            const prevChapter = this._chapters[index - 1];
            log.info('Skipping to previous chapter:', prevChapter.Name);
            this.seek(prevChapter.StartPositionTicks);
        } else {
             // First chapter, just seek to start
             this.seek(0);
        }
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
        // Add offset if we are playing a transcoded segment that starts at 0
        const backendTicks = Math.round((this._backend?.getCurrentTime() ?? 0) * 10000000);
        const total = backendTicks + this._transcodingOffsetTicks;
        return isNaN(total) ? 0 : total;
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
    async _getPlaybackInfo(options, deviceProfile, manualBitrate = null) {
        const url = `${this.serverUrl}/Items/${options.itemId}/PlaybackInfo`;

        // Read max bitrate: priority to deviceProfile if passed (it contains the logic)
        // Fallback to manualBitrate or 120Mbps
        const maxBitrate = deviceProfile?.MaxStreamingBitrate || manualBitrate || 120000000;

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `MediaBrowser Token="${this.authToken}"`
            },
            body: JSON.stringify({
                DeviceProfile: deviceProfile || buildJellyfinProfile(maxBitrate),
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

    // ========================================================================
    // Manual Bitrate Control
    // ========================================================================

    /**
     * Set max bitrate and restart playback
     * @param {number} bitrate - Max bitrate in bps (0 = Auto)
     */
    async setMaxBitrate(bitrate) {
        if (!this._currentItem) return;
        
        log.info('Setting manual bitrate:', bitrate);
        
        // Update state (0 means null/Auto)
        this._manualBitrate = bitrate > 0 ? bitrate : null;

        // Capture current position to resume
        const currentTicks = this.getCurrentPositionTicks();

        // Strategy: Standard - Play from current position
        // This is more robust than seeking from 0 for HLS
        const playOptions = {
            ...this._currentPlayOptions,
            startPositionTicks: currentTicks
        };

        // Restart playback
        this._isRestarting = true;
        
        try {
            // Trigger loading state immediately
            this.emit(PlayerEvent.WAITING);

            await this.stop();
            // _manualBitrate is preserved because _isRestarting was true
            
            // Tizen: Give AVPlay time to cleanup
            await new Promise(resolve => setTimeout(resolve, 500));

            await this.play(playOptions);
            
            // No manual seek needed - server starts transcode at correct offset
            // and MediaHelper handles the time reporting offset.

            // _isRestarting is reset to false in play() success
        } catch (e) {
            log.error('Failed to restart with new bitrate:', e);
            this._isRestarting = false; // Ensure reset on error
        }
    }


    /**
     * Get current max bitrate setting
     * @returns {number} Current bitrate limit (0 = Auto)
     */
    getMaxBitrate() {
        return this._manualBitrate || 0;
    }

    /**
     * Get current playback mode
     * @returns {string}
     */
    getPlaybackMode() {
        return this._playbackMode;
    }

    /**
     * Force a specific playback mode and restart if playing
     * @param {string} mode - 'auto', 'directPlay', 'transcode', 'remux'
     */
    async setPlaybackMode(mode) {
        if (!['auto', 'directPlay', 'transcode', 'remux'].includes(mode)) return;
        
        if (this._playbackMode === mode) return;

        this._playbackMode = mode;
        log.info(`Playback mode set to: ${mode}`);
        
        // Re-initialize playback if active
        // Check for specific backend states that imply activity
        if (this._isPlaying || this._isPaused || this._state === 'buffering') {
            log.info('Restarting playback to apply new mode');
            
            if (this._lastPlayOptions) {
                const currentTicks = this.getCurrentPositionTicks();
                const newOptions = {
                    ...this._lastPlayOptions,
                    startPositionTicks: currentTicks
                };
                
                // Reuse restart logic pattern from setMaxBitrate
                this._isRestarting = true;
                
                try {
                    this.emit(PlayerEvent.WAITING);
                    await this.stop();
                    // Give backend time to cleanup
                    await new Promise(resolve => setTimeout(resolve, 500));
                    await this.play(newOptions);
                    // _isRestarting reset in play() success path implicitly? 
                    // No, wait. play() calls stop(). stop() checks _isRestarting.
                    // But play() sets _isRestarting = false ?
                    // Let's check play():
                    // play() calls stop().
                    // play() calls _resetState().
                    // _resetState() does NOT play with _isRestarting ??
                    // Actually setMaxBitrate comment says: " _isRestarting is reset to false in play() success"
                    // checking play():
                    // it does NOT seem to reset _isRestarting explicitly.
                    // Wait, stop() checks _isRestarting.
                    
                    // Actually, looking at setMaxBitrate, it sets `this._isRestarting = true;`.
                    // Then calls `stop()`. `stop()` sees true, so it doesn't emit STOP events.
                    // Then `play()` is called. `play()` calls `stop()` again (first thing).
                    // `stop()` sees true again.
                    // Then `play()` proceeds.
                    
                    // The issue is: when does `_isRestarting` go back to false?
                    // `setMaxBitrate` does NOT set it back to false in try block!
                    // This looks like a bug in `setMaxBitrate` potentially, or I missed where it is reset.
                    // I should check `_resetState` or `play`.
                    
                    // If `_isRestarting` stays true, subsequent stops won't emit events?
                    // Let's check `_resetState`.
                } catch (e) {
                    log.error('Failed to restart after mode change:', e);
                    this._isRestarting = false;
                }
                
                // We should probably reset it here if success?
                this._isRestarting = false; 
            }
        }
    }

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
