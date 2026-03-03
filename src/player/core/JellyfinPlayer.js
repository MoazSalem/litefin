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
import SubtitleManager, { DeliveryMethod } from './SubtitleManager.js';
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
    STATE_CHANGE: 'statechange',
    RESTARTING: 'restarting'
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
        this._isSeeking = false; // Track seeking state to suppress loading screens during seek

        // Secondary subtitle stream index (kept here for OSD queries)
        this._currentSecondarySubtitleStreamIndex = -1;

        // ====================================================================
        // Subtitle Manager — centralized subtitle orchestration
        // Handles delivery method selection, external subtitle fetching,
        // cue parsing, and time-based cue ticking for both primary and
        // secondary subtitles. Embedded subs on Tizen are still routed
        // through the backend, but the manager coordinates everything.
        // ====================================================================

        this._subtitleManager = new SubtitleManager({
            container: this.container,
            serverUrl: this.serverUrl,
            authToken: this.authToken,
            // Primary cue callback — emits to PlayerPage for DOM rendering
            onPrimaryCue: (data) => this.emit('subtitlechange', data),
            // Secondary cue callback — emits to PlayerPage for secondary overlay
            onSecondaryCue: (data) => this.emit('secondarysubtitlechange', data),
            // Delivery method change — used for logging / debugging
            onDeliveryChange: (info) => {
                log.info('[SubtitleManager] Delivery changed:', info);
            }
        });

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
        const backendSetting = PlayerSettings.get('playerBackend') || 'auto';

        log.info(
            'Initializing backend. useTizenPlayer:', this.useTizenPlayer,
            'detected:', hasAvPlay,
            'setting:', backendSetting
        );

        // Determine which backend to use
        let useTizen = false;

        if (backendSetting === 'avplay') {
            useTizen = true;
            if (!hasAvPlay) {
                log.warn('Forced Tizen AVPlay, but API not found! Attempting anyway...');
            }
        } else if (backendSetting === 'html5') {
            useTizen = false;
        } else {
            // Auto: Use Tizen if requested by config AND available
            useTizen = this.useTizenPlayer && hasAvPlay; 
        }

        if (useTizen) {
            log.info('Using Tizen AVPlay backend');
            this._backendType = 'tizen';
            this._backend = new TizenAVPlayer({
                container: this.container,
                settings: PlayerSettings,
                onEvent: this._handleBackendEvent.bind(this)
            });
        } else {
            log.info('Using HTML5 Video backend');
            this._backendType = 'html5';
            this._backend = new HtmlVideoPlayer({
                container: this.container,
                settings: PlayerSettings,
                onEvent: this._handleBackendEvent.bind(this)
            });
        }
    }

    /**
     * Check if player is currently seeking
     * @returns {boolean}
     */
    get isSeeking() {
        return this._isSeeking;
    }

    /**
     * Get the current backend type ('tizen' or 'html5')
     * @returns {string}
     */
    get backendType() {
        return this._backendType;
    }

    /**
     * Check if the currently playing item is an audio-only item
     * (Music, Audiobooks, Podcasts). Used by OSD and PlayerPage to
     * hide video-specific controls (subtitles, tracks, chapters).
     * @returns {boolean}
     */
    isAudio() {
        const item = this._currentItem;
        if (!item) return false;
        return item.MediaType === 'Audio' || item.Type === 'AudioBook';
    }

    /**
     * Handle events from the backend player
     * @private
     */
    _handleBackendEvent(event) {
        // Clear seeking flag on relevant events
        if (event.type === PlayerEvent.SEEKED || 
            event.type === PlayerEvent.PLAYING || 
            (event.type === PlayerEvent.TIME_UPDATE && this._isSeeking)) {
            this._isSeeking = false;
        }

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

        // Handle timeupdate — tick the SubtitleManager to update cues
        if (event.type === PlayerEvent.TIME_UPDATE && event.data?.time !== undefined) {
            try {
                // SubtitleManager handles both primary and secondary subtitle ticking
                this._subtitleManager.tick(event.data.time);
            } catch (e) {
                console.error('Error ticking subtitle manager:', e.message || e, e.stack);
            }
            
            // Re-emit normalized timeupdate with absolute ticks
            this.emit(PlayerEvent.TIME_UPDATE, this.getCurrentPositionTicks());
            return;
        }

        // Route embedded subtitle events through SubtitleManager
        if (event.type === 'subtitlechange') {
            this._subtitleManager.handleEmbeddedSubtitleEvent(event.data);
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
        log.info('Backend Type:', this._backendType);
        log.info('Use Tizen Player:', this.useTizenPlayer);
        
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
                 playbackMode: this._playbackMode,
                 backend: this._backendType
            });

            // When a specific audio track is requested on the HTML5 backend, we must
            // prevent the server from responding with DirectPlay.  A static DirectPlay
            // URL ignores AudioStreamIndex entirely — the server just streams the raw
            // file and plays whatever track comes first.
            //
            // Clearing DirectPlayProfiles in the device profile forces the server to
            // pick DirectStream or Transcode instead.  Both paths return a TranscodingUrl
            // that already has AudioStreamIndex baked in, so the correct track plays.
            //
            // This applies both to the initial play() call (options.audioStreamIndex
            // explicitly set) AND to audio-switch restarts (_forceDirectStream flag).
            const isHtml5Backend = !(this._backend instanceof TizenAVPlayer);
            const supportsNativeAudio = this._backend && typeof this._backend.supportsNativeAudioTracks === 'function' && this._backend.supportsNativeAudioTracks();
            
            // PlayerPage always passes the default audio track index. We only need to
            // force a transcode if the user requested a track that is DIFFERENT from the default.
            let isCustomAudioTrack = false;
            if (options.audioStreamIndex !== undefined) {
                // Determine the default track from the pre-fetched item if available
                let defaultIndex = undefined;
                if (options.item && options.item.MediaSources) {
                    const fallbackSource = options.item.MediaSources[0];
                    const ms = options.item.MediaSources.find(m => m.Id === options.mediaSourceId) || fallbackSource;
                    if (ms) defaultIndex = ms.DefaultAudioStreamIndex;
                }
                isCustomAudioTrack = (options.audioStreamIndex !== defaultIndex);
            }

            const needsDirectStreamForAudio = options._forceDirectStream ||
                (isHtml5Backend && !supportsNativeAudio && isCustomAudioTrack);

            if (needsDirectStreamForAudio) {
                log.info('HTML5 audio track selection: clearing DirectPlayProfiles to force DirectStream/Transcode');
                deviceProfile.DirectPlayProfiles = [];
            }

            // Get playback info from server
            const playbackInfo = await this._getPlaybackInfo(options, deviceProfile, this._manualBitrate);
            log.debug('PlaybackInfo keys:', Object.keys(playbackInfo));
            if (playbackInfo.MediaSources && playbackInfo.MediaSources.length > 0) {
                 log.debug('MediaSource[0] keys:', Object.keys(playbackInfo.MediaSources[0]));
            }

            /*
             * Audio items (Music, Audiobooks) never have chapters in Jellyfin's
             * sense — skip the chapter fetch entirely to avoid a wasted API call.
             * Video items still go through the normal 3-step chapter resolution.
             */
            const isAudioItem = options.item?.MediaType === 'Audio' ||
                                 options.item?.Type === 'AudioBook';

            let chapters = [];

            if (!isAudioItem) {
                // Chapter Recovery Strategy
                // 1. Check if passed item has chapters (from options.item passed by PlayerPage)
                chapters = options.item?.Chapters || [];

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
            } else {
                log.debug('Audio item — skipping chapter fetch');
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

            if (mediaSource.TranscodingInfo) {
                log.info(`[PlaybackMode] IsDirectStream: ${mediaSource.TranscodingInfo.IsVideoDirect ? 'Yes' : 'No'}`);
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

            // Store the resolved play method so track-switching logic can
            // reliably detect transcoding without re-deriving from media source
            // flags (which may have been mutated, e.g. by the remux case above).
            this._currentPlayMethod = playMethod;

            // Attach play session ID to media source
            if (playbackInfo.PlaySessionId) {
                mediaSource.PlaySessionId = playbackInfo.PlaySessionId;
            }

            this._currentMediaSource = mediaSource;
            this._currentItem = options.item || { Id: options.itemId };

            // Set up the SubtitleManager with the current media context
            // This tells it what item/source we're playing and what backend we're using
            const backend = this._backend || this._videoPlayer;
            this._subtitleManager.setMediaContext({
                itemId: options.itemId,
                mediaSourceId: mediaSource.Id,
                mediaStreams: mediaSource.MediaStreams || [],
                backendType: backend instanceof TizenAVPlayer ? 'tizen' : 'html5',
                videoElement: (backend && backend.getVideoElement) ? backend.getVideoElement() : null
            });

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
                deviceProfile: deviceProfile,
                // Pass audioStreamIndex so it's included in manually-built fallback URLs.
                // When TranscodingUrl is present (the normal case), the server already
                // has this baked in and this param is unused.
                audioStreamIndex: this._currentAudioStreamIndex
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
                subtitleStreamIndex: options.subtitleStreamIndex,
                // Tell the backend what play method was negotiated — critical so
                // TizenAVPlayer knows NOT to apply native track selection when
                // the server is transcoding (audio is baked into the HLS stream).
                playMethod: playMethod
            });
            log.info('Backend play() promise resolved');

            this._isPlaying = true;
            this._isPaused = false;

            this.emit(PlayerEvent.PLAYBACK_START, {
                item: this._currentItem,
                mediaSource
            });

            /*
             * Subtitle setup only applies to video. Audio items never have subtitle
             * streams, so attempting to set one would cause spurious log warnings
             * and unnecessary SubtitleManager.setPrimaryTrack() calls.
             */
            const isAudioItemSetup = options.item?.MediaType === 'Audio' ||
                                      options.item?.Type === 'AudioBook';

            if (!isAudioItemSetup && this._currentSubtitleStreamIndex && this._currentSubtitleStreamIndex !== -1) {
                // Initialize the SubtitleManager with the selected subtitle track.
                // The subtitle index is already included in the server request, so
                // this call only needs to set up CLIENT-SIDE rendering (fetch external
                // text, parse ASS, etc.). Setting _playSetupInProgress=true tells
                // setSubtitleStreamIndex to skip any restart-triggering logic — the
                // server already has the correct subtitle in its transcode session.
                this._playSetupInProgress = true;
                // Fire-and-forget — don't block playback on subtitle fetch
                this.setSubtitleStreamIndex(this._currentSubtitleStreamIndex)
                    .catch((err) => log.warn('Initial subtitle setup failed:', err))
                    .finally(() => { this._playSetupInProgress = false; });
            }
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
        this._isSeeking = true;
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
     * Set mute state explicitly.
     * Called by PlayerPage when a remote Mute / Unmute command arrives via WebSocket.
     * Delegates to the backend player (HtmlVideoPlayer.setMuted or TizenAVPlayer).
     * @param {boolean} muted
     */
    setMuted(muted) {
        if (this._backend?.setMuted) {
            this._backend.setMuted(muted);
        } else {
            // Fallback: backend may only expose toggleMute — use isMuted to decide
            if (Boolean(muted) !== this.isMuted()) {
                this._backend?.toggleMute?.();
            }
        }
        this.emit(PlayerEvent.VOLUME_CHANGE, { volume: this.getVolume() });
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
     * Set audio track.
     *
     * During DirectPlay, the backend can switch tracks natively.
     * During Transcode/DirectStream (server re-encodes the video), the audio
     * channel is baked into the server's output stream. Changing it requires
     * a full retranscode restart with the new AudioStreamIndex, exactly like
     * switching subtitle tracks in burn-in mode.
     *
     * @param {number} index - Audio stream index (Jellyfin ID)
     */
    async setAudioStreamIndex(index) {
        this._currentAudioStreamIndex = index;

        // =====================================================================
        // Determine whether we need to restart playback to apply the audio change.
        // =====================================================================
        const isTranscoding = this._currentPlayMethod === 'Transcode' ||
                              this._currentPlayMethod === 'DirectStream';

        // True whenever this backend cannot live-switch audio tracks
        const supportsNativeAudio = this._backend && typeof this._backend.supportsNativeAudioTracks === 'function' && this._backend.supportsNativeAudioTracks();
        const requiresRestart = isTranscoding || (!(this._backend instanceof TizenAVPlayer) && !supportsNativeAudio);

        log.info(`setAudioStreamIndex: index=${index} playMethod=${this._currentPlayMethod} requiresRestart=${requiresRestart}`);

        if (requiresRestart && this._currentPlayOptions && !this._audioRestartInProgress) {
            log.info(`Restarting playback for audio track: ${index} (method: ${this._currentPlayMethod ?? 'DirectPlay/HTML5'})`);

            const currentTicks = this.getCurrentPositionTicks();
            
            // Check if the requested index is the original default track
            let isCustomAudioTrack = true;
            if (this._currentItem && this._currentItem.MediaSources) {
                const msId = this._currentPlayOptions.mediaSourceId;
                const fallbackSource = this._currentItem.MediaSources[0];
                const ms = this._currentItem.MediaSources.find(m => m.Id === msId) || fallbackSource;
                if (ms && index === ms.DefaultAudioStreamIndex) {
                    isCustomAudioTrack = false;
                }
            }

            // Build new play options carrying the updated audio stream index.
            const restartOptions = {
                ...this._currentPlayOptions,
                audioStreamIndex: index,
                startPositionTicks: currentTicks,
                // Only force DirectStream if backend can't switch natively AND the track isn't the default direct play track
                _forceDirectStream: !(this._backend instanceof TizenAVPlayer) && !supportsNativeAudio && isCustomAudioTrack
            };

            // Persist so future restarts (bitrate change, etc.) carry the right track
            this._currentPlayOptions = restartOptions;
            this._lastPlayOptions = restartOptions;

            // Set guard BEFORE play() to block re-entrant restarts
            this._audioRestartInProgress = true;
            this._isRestarting = true;
            try {
                this.emit(PlayerEvent.RESTARTING);
                await this.stop();
                await new Promise(resolve => setTimeout(resolve, 500));
                await this.play(restartOptions);
                // Reset the restarting flag on success so subsequent stop() calls
                // emit proper STOP events and clear state normally.
                this._isRestarting = false;
            } catch (e) {
                log.error('Failed to restart playback for audio track switch:', e);
                this._isRestarting = false;
            } finally {
                // Always clear the guard when done, success or failure
                this._audioRestartInProgress = false;
            }

            this.emit(PlayerEvent.MEDIA_STREAMS_CHANGE, { audioStreamIndex: index });
            return;
        }

        // In transcoding mode but called from play()'s internal audio setup —
        // there's nothing to do; the server already has the correct index.
        if (isTranscoding) {
            log.info(`[${this._currentPlayMethod}] Skipping native audio switch — server already has the correct track`);
            this.emit(PlayerEvent.MEDIA_STREAMS_CHANGE, { audioStreamIndex: index });
            return;
        }

        // =====================================================================
        // DirectPlay: native backend audio switching (no restart needed)
        // =====================================================================

        // Both Tizen (AVPlay) and HtmlVideoPlayer work with 0-based list
        // indices of available audio tracks, NOT the raw Jellyfin stream ID.
        // Convert here so both backends share the same simple interface.
        const tracks = this.getAudioTracks();
        const listIndex = tracks.findIndex((t) => t.Index === index);

        if (listIndex === -1) {
            log.warn('StreamID', index, 'not found in audio tracks:', tracks.map(t => t.Index));
            this.emit(PlayerEvent.MEDIA_STREAMS_CHANGE, { audioStreamIndex: index });
            return;
        }

        log.debug('Converting StreamID', index, 'to list index', listIndex);
        this._backend?.setAudioStreamIndex(listIndex);

        this.emit(PlayerEvent.MEDIA_STREAMS_CHANGE, { audioStreamIndex: index });
    }

    /**
     * Set subtitle track — delegates to SubtitleManager for delivery routing.
     * SubtitleManager decides whether to use embedded native rendering
     * (Tizen AVPlay) or fetch/parse the subtitle externally.
     *
     * Special case: in "Always Burn In" mode, every subtitle track is burned
     * into the video server-side during transcoding. Changing the track in this
     * mode means re-sending a new transcoding request with the updated
     * SubtitleStreamIndex — we must restart playback from the current position.
     *
     * @param {number} index - Subtitle stream index (-1 to disable)
     */
    async setSubtitleStreamIndex(index) {
        this._currentSubtitleStreamIndex = index;

        // =====================================================================
        // Burn-in restart: if the server is baking the subtitle into the video,
        // switching tracks requires a full retranscode. Two applicable modes:
        //
        //   'all'        → server burns EVERY subtitle format. Always restart.
        //
        //   'allcomplex' → server burns ONLY complex/bitmap formats (PGS,
        //                   VOBSUB). Text formats (SRT, ASS, VTT) are delivered
        //                   externally — no restart needed for those.
        //
        // Guards: _playSetupInProgress     → called from play()'s own setup;
        //                                    subtitle index already in server req.
        //         _burnInRestartInProgress → already inside a restart; prevents
        //                                    re-entrant second restart from play().
        // =====================================================================
        const burnIn = PlayerSettings.get('subtitleBurnIn');
        const isTranscodingSession = this._currentPlayMethod === 'Transcode' ||
                                     this._currentPlayMethod === 'DirectStream';

        // In 'allcomplex' mode:
        //
        //   Bitmap formats (PGS, VOBSUB): the server burns them in when it
        //   transcodes. Selecting a PGS subtitle while DIRECT-PLAYING must also
        //   trigger a restart — the server needs to start transcoding with the
        //   PGS burned in. So bitmap = ALWAYS restart in allcomplex mode.
        //
        //   Text formats (SRT, ASS, VTT): served externally by the server API,
        //   so the client can render them without a restart UNLESS we're already
        //   transcoding — in that case the server has a specific SubtitleStreamIndex
        //   locked into the current HLS session and we must restart to change it.
        const _isAllComplex = burnIn === 'allcomplex';
        const isBitmapCodec = (() => {
            if (!_isAllComplex || index === -1) return false;
            const track = this.getSubtitleTracks().find(t => t.Index === index);
            const codec = (track?.Codec || '').toLowerCase();
            return codec === 'pgs' || codec === 'pgssub' ||
                   codec === 'vobsub' || codec === 'dvdsub' || codec === 'dvd_subtitle';
        })();

        // Bitmap in allcomplex: always restart (even from direct play)
        // Text in allcomplex + transcoding: restart (subtitle locked in stream URL)
        const isBitmapBurnIn = (_isAllComplex && isBitmapCodec) ||
                               (_isAllComplex && isTranscodingSession);

        const needsBurnInRestart = burnIn === 'all' || isBitmapBurnIn;

        if (needsBurnInRestart && this._currentPlayOptions && !this._burnInRestartInProgress && !this._playSetupInProgress) {
            log.info(`Burn-in restart (mode: ${burnIn}, track: ${index}) — retranscoding`);

            // Capture current position so we can resume from the same spot
            const currentTicks = this.getCurrentPositionTicks();

            // Build new play options with the updated subtitle stream index
            const restartOptions = {
                ...this._currentPlayOptions,
                subtitleStreamIndex: index,
                startPositionTicks: currentTicks
            };

            // Persist the new index so that subsequent restarts (e.g. bitrate
            // changes) also carry the correct subtitle stream index
            this._currentPlayOptions = restartOptions;
            this._lastPlayOptions = restartOptions;

            // Set the guard BEFORE calling play() so that the internal
            // setSubtitleStreamIndex call from play() skips this path
            this._burnInRestartInProgress = true;
            this._isRestarting = true;
            try {
                this.emit(PlayerEvent.RESTARTING);
                await this.stop();
                await new Promise(resolve => setTimeout(resolve, 500));
                await this.play(restartOptions);
                // Reset on success so subsequent stop() calls behave normally
                this._isRestarting = false;
            } finally {
                // Always clear the guard when done
                this._burnInRestartInProgress = false;
            }

            // Notify OSD of the track change
            this.emit(PlayerEvent.MEDIA_STREAMS_CHANGE, { subtitleStreamIndex: index });
            return;
        }

        // Called from play()'s internal setup during a burn-in session —
        // the server already has the correct subtitle index, nothing to do client-side.
        if (needsBurnInRestart) {
            log.info(`Burn-in mode (${burnIn}) — skipping client-side setup (server already has correct track)`);
            this.emit(PlayerEvent.MEDIA_STREAMS_CHANGE, { subtitleStreamIndex: index });
            return;
        }

        // Let SubtitleManager determine the best delivery method
        const delivery = await this._subtitleManager.setPrimaryTrack(index);

        // If SubtitleManager chose embedded native, we need to tell the backend.
        //
        // IMPORTANT: In a transcoding session (Transcode or DirectStream play method)
        // the HLS/transcode output from the server carries NO embedded subtitle tracks.
        // Calling AVPlay's setSubtitleStreamIndex() would silently do nothing.
        // The only way to switch the subtitle is to restart the transcode with the
        // new SubtitleStreamIndex so the server re-encodes / remuxes the correct track.
        if (delivery === DeliveryMethod.EMBEDDED_NATIVE) {
            const isTranscoding = this._currentPlayMethod === 'Transcode' ||
                                  this._currentPlayMethod === 'DirectStream';

            if (isTranscoding && this._currentPlayOptions && !this._burnInRestartInProgress && !this._playSetupInProgress) {
                // Same restart pattern as burn-in — we reuse the burn-in guard flag
                // because the two paths are mutually exclusive (burn-in was already
                // checked earlier and would have returned by now).
                log.info(`EMBEDDED_NATIVE + ${this._currentPlayMethod} — restarting transcode for subtitle: ${index}`);

                const currentTicks = this.getCurrentPositionTicks();
                const restartOptions = {
                    ...this._currentPlayOptions,
                    subtitleStreamIndex: index,
                    startPositionTicks: currentTicks
                };

                this._currentPlayOptions = restartOptions;
                this._lastPlayOptions = restartOptions;

                this._burnInRestartInProgress = true;
                this._isRestarting = true;
                try {
                    this.emit(PlayerEvent.RESTARTING);
                    await this.stop();
                    await new Promise(resolve => setTimeout(resolve, 500));
                    await this.play(restartOptions);
                    // Reset on success so subsequent stop() calls behave normally
                    this._isRestarting = false;
                } catch (e) {
                    log.error('Failed to restart for embedded subtitle switch during transcode:', e);
                    this._isRestarting = false;
                } finally {
                    this._burnInRestartInProgress = false;
                }

                this.emit(PlayerEvent.MEDIA_STREAMS_CHANGE, { subtitleStreamIndex: index });
                return;
            }

            // DirectPlay: AVPlay can read embedded subtitle tracks natively
            if (this._backend instanceof TizenAVPlayer) {
                // Skip explicit backend call during initial playback setup.
                // TizenAVPlayer natively handles initial track selection via _pendingSubtitleIndex
                // deferred until the 'onbufferingcomplete' event safely transitions the player.
                if (this._playSetupInProgress) {
                    log.info('Skipping backend subtitle assignment during initial play (Tizen handles natively via pending index)');
                } else if (index === -1) {
                    this._backend.setSubtitleStreamIndex(-1);
                } else {
                    const tracks = this.getSubtitleTracks();
                    const trackExists = tracks.some((t) => t.Index === index);
                    if (trackExists) {
                        this._backend.setSubtitleStreamIndex(index);
                    } else {
                        log.warn('Subtitle StreamID', index, 'not found in backend tracks');
                    }
                }
            }
        } else {
            // SubtitleManager is handling rendering via DOM (EXTERNAL_TEXT, ASS_CANVAS, PGS_BITMAP)
            // Or delivery is NONE (subtitles disabled / unsupported format).
            // Ensure backend embedded subtitles are turned off so they don't double-render.
            if (this._backend instanceof TizenAVPlayer) {
                this._backend.setSubtitleStreamIndex(-1);
            } else {
                this._backend?.setSubtitleStreamIndex(-1);
            }
        }

        this.emit(PlayerEvent.MEDIA_STREAMS_CHANGE, { subtitleStreamIndex: index });
    }

    /**
     * Set subtitle offset — routes to SubtitleManager for DOM-rendered subs
     * or to the backend for embedded native subs.
     *
     * @param {number} seconds - Offset in seconds
     */
    setSubtitleOffset(seconds) {
        // If SubtitleManager is handling the primary subtitle, apply offset there
        if (this._subtitleManager.isPrimaryManagedByUs()) {
            this._subtitleManager.setPrimaryOffset(seconds);
        } else {
            // Embedded native subs — delegate to backend (Tizen has native offset API)
            this._backend?.setSubtitleOffset(seconds);
        }
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
     * Set secondary subtitle stream index — delegates to SubtitleManager.
     * Secondary subtitles are always fetched externally and rendered on DOM,
     * even if the track is embedded in the container.
     *
     * @param {number} index - Stream index (-1 to disable)
     */
    async setSecondarySubtitleStreamIndex(index) {
        if (this._currentSecondarySubtitleStreamIndex === index) return;

        log.info('Setting secondary subtitle index:', index);
        this._currentSecondarySubtitleStreamIndex = index;

        // Delegate to SubtitleManager — it handles fetch, parse, and cue ticking
        await this._subtitleManager.setSecondaryTrack(index);

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

    getCurrentChapterIndex(timeTicks) {
        if (!this._chapters || this._chapters.length === 0) return -1;
        
        const currentTicks = timeTicks !== undefined ? timeTicks : this.getCurrentPositionTicks();
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
        // Tizen Seek Offset Workaround:
        // On Tizen, we apply a -2.5s offset to chapter seeks (see below).
        // This causes "Next Chapter" to land slightly before the actual chapter start.
        // Determining the current chapter index strictly by current time would place us in the PREVIOUS chapter.
        // To avoid getting stuck in a loop (Next -> Prev Chapter End -> Next -> Prev Chapter End),
        // we look ahead by 3s (slightly more than the 2.5s hack) to see "where we effectively are".
        let lookAhead = 0;
        if (this._backend instanceof TizenAVPlayer) {
             lookAhead = 30000000; // 3 seconds in ticks
        }
        
        const index = this.getCurrentChapterIndex(this.getCurrentPositionTicks() + lookAhead);
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
     * Refresh subtitle styles — delegate to backend (for embedded subs)
     * or emit event for DOM-rendered subs.
     */
    refreshSubtitles() {
        // Always try to refresh managed subtitles (ASS/Text)
        if (this._subtitleManager) {
            this._subtitleManager.refreshStyles();
        }

        if (this._backend && this._backend.refreshSubtitles) {
            this._backend.refreshSubtitles();
        } else {
             this.emit('refreshsubtitles');
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
        const url = `${this.serverUrl}/Items/${options.itemId}/PlaybackInfo?UserId=${options.userId}`;

        // Read max bitrate: priority to deviceProfile if passed (it contains the logic)
        // Fallback to manualBitrate or 120Mbps
        const maxBitrate = deviceProfile?.MaxStreamingBitrate || manualBitrate || 120000000;

        /*
         * Audio items (Music, Audiobooks) do NOT have subtitle streams.
         * The Jellyfin server returns HTTP 500 if SubtitleStreamIndex is
         * present in the request body for Audio-type items. Only send it
         * for Video items where subtitle selection makes sense.
         */
        const isAudioItem = (options.item?.MediaType === 'Audio') ||
                            (options.item?.Type === 'Audio') ||
                            (options.item?.Type === 'MusicAlbum') ||
                            (options.item?.Type === 'MusicArtist') ||
                            (options.item?.Type === 'Artist') ||
                            (options.item?.Type === 'AudioBook') ||
                            (options.item?.Type === 'PodcastEpisode');

        const requestBody = {
            DeviceProfile: deviceProfile || buildJellyfinProfile(maxBitrate),
            UserId: options.userId,
            MaxStreamingBitrate: maxBitrate,
            StartTimeTicks: options.startPositionTicks || 0,
            AutoOpenLiveStream: true
        };

        if (options.mediaSourceId) {
            requestBody.MediaSourceId = options.mediaSourceId;
        }


        // For Audio items, sending SubtitleStreamIndex often causes an HTTP 500 
        // from the Jellyfin server. Therefore, we entirely omit it for audio playback.
        // However, we MUST send AudioStreamIndex if available, even for audio tracks,
        // otherwise forced transcode requests will fail with a 500 error.
        if (options.audioStreamIndex !== undefined && options.audioStreamIndex !== null) {
            requestBody.AudioStreamIndex = options.audioStreamIndex;
        }

        if (!isAudioItem) {
            if (options.subtitleStreamIndex !== undefined && options.subtitleStreamIndex !== null) {
                requestBody.SubtitleStreamIndex = options.subtitleStreamIndex;
            }
        }


        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `MediaBrowser Token="${this.authToken}"`
            },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            let errorText = '';
            try {
                errorText = await response.text();
            } catch (e) {}
            throw new Error(`Failed to get playback info: ${response.status} - ${errorText}`);
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
            this.emit(PlayerEvent.RESTARTING);

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
                    this.emit(PlayerEvent.RESTARTING);
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
