/**
 * TizenAVPlayer - Tizen Native Video Backend
 *
 * Uses Tizen's AVPlay API for hardware-accelerated playback on Samsung TVs.
 * Provides better codec support and performance than HTML5 video on Tizen.
 *
 * @module core/TizenAVPlayer
 */

import { MediaHelper } from './MediaHelper.js';
import { logger } from '../../utils/Logger.js';

const log = logger.create('TizenAVPlayer');

// ============================================================================
// TizenAVPlayer Class
// ============================================================================

export class TizenAVPlayer {
    /**
     * @param {Object} options
     * @param {HTMLElement} options.container - Container element
     * @param {Object} options.settings - Settings manager
     * @param {Function} options.onEvent - Event callback
     */
    constructor(options) {
        this.container = options.container;
        this.settings = options.settings;
        this.onEvent = options.onEvent || (() => {});

        // ====================================================================
        // State
        // ====================================================================

        this._currentSrc = null;
        this._currentPlayOptions = null;
        this._duration = 0;
        this._isPlaying = false;
        this._isPrepared = false;

        // Volume (Tizen stores 0-100)
        this._volume = MediaHelper.getSavedVolume() * 100;
        this._isMuted = false;

        // Position tracking
        this._positionTimer = null;

        // Pending track selection (applied on buffering complete)
        this._pendingAudioIndex = null;
        this._pendingSubtitleIndex = null;

        // Current track indices (Jellyfin indices)
        this._currentAudioStreamIndex = null;
        this._currentSubtitleStreamIndex = null;

        // Subtitle offset in seconds (applied via AVPlay's native API)
        this._subtitleOffset = 0;

        // Throttle for timeupdate events
        this._lastTimeUpdateTicks = 0;

        // Check Tizen availability
        this._avplay = window.tizen?.avplay || window.webapis?.avplay || null;

        if (!this._avplay) {
            log.warn('Tizen AVPlay API not available');
        }
    }

    // ========================================================================
    // Initialization
    // ========================================================================

    /**
     * Create video display area
     * @private
     */
    _createDisplay() {
        if (!this._avplay) return;

        // Get container dimensions for display rect
        const rect = this.container.getBoundingClientRect();
        log.debug('_createDisplay rect:', rect);

        try {
            this._avplay.setDisplayRect(
                Math.round(rect.left),
                Math.round(rect.top),
                Math.round(rect.width),
                Math.round(rect.height)
            );

            // Use LETTER_BOX to preserve aspect ratio
            this._avplay.setDisplayMethod('PLAYER_DISPLAY_MODE_LETTER_BOX');

            // NOTE: Do NOT call tizen.tvwindow.show() here. That API is for TV tuner/HDMI input,
            // not for AVPlay. Calling it can cause the video plane to render above HTML elements.
        } catch (e) {
            log.error('Failed to set display:', e);
        }
    }

    /**
     * Set aspect ratio mode
     * @param {string} mode - 'auto', 'zoom', 'stretch'
     */
    setAspectRatio(mode) {
        if (!this._avplay) return;

        try {
            let displayMethod = 'PLAYER_DISPLAY_MODE_LETTER_BOX'; // Default/Auto

            switch (mode) {
                case 'zoom':
                    displayMethod = 'PLAYER_DISPLAY_MODE_CROPPED_FULL';
                    break;
                case 'stretch':
                    displayMethod = 'PLAYER_DISPLAY_MODE_FULL_SCREEN';
                    break;
                case 'auto':
                default:
                    displayMethod = 'PLAYER_DISPLAY_MODE_LETTER_BOX';
                    break;
            }

            log.info('Setting aspect ratio:', mode, '->', displayMethod);
            this._avplay.setDisplayMethod(displayMethod);
        } catch (e) {
            log.error('Failed to set aspect ratio:', e);
        }
    }

    // ========================================================================
    // Playback Control
    // ========================================================================

    /**
     * Start playback
     * @param {Object} options - Play options
     */
    async play(options) {
        if (!this._avplay) {
            throw new Error('Tizen AVPlay not available');
        }

        log.info('Starting playback');

        this._currentPlayOptions = options;
        this._currentSrc = options.url;

        // Reset subtitle offset for new playback session
        this._subtitleOffset = 0;
        this._hasEmittedPlaying = false;
        this._firstFrameRendered = false;
        this._playbackStabilized = false;

        try {
            // Track if we were actually active to know if a cleanup sleep is needed
            const wasActive = this._isPlaying || this._isPrepared;

            // Stop any existing playback
            await this._stopInternal();

            // Only sleep if we just forcefully stopped an active stream
            if (wasActive) {
                // Give Tizen time to cleanup (helps with buffer errors on rapid changes)
                await new Promise((resolve) => setTimeout(resolve, 200));
            }

            // Open the media
            this._avplay.open(options.url);

            try {
                const isAdaptive = (options.url.indexOf('.m3u8') > -1) || (options.url.indexOf('.mpd') > -1) || (options.playMethod !== 'DirectPlay');
                if (isAdaptive || (options.mediaSource && options.mediaSource.VideoType === '4K')) {
                    this._avplay.setStreamingProperty("ADAPTIVE_INFO", "FIXED_MAX_RESOLUTION=3840X2160");
                    log.debug('Set ADAPTIVE_INFO for 4K streaming');
                    
                    // Configure time-based buffer thresholds (proper API, works on Tizen 5.0+)
                    // Initial buffer: accumulate 3 seconds of content before onbufferingcomplete fires
                    try {
                        this._avplay.setBufferSize("PLAYER_BUFFER_FOR_PLAY", "PLAYER_BUFFER_SIZE_IN_SECOND", 3);
                        log.info('Set initial play buffer to 3 seconds');
                    } catch (e) { log.warn('Failed to set PLAYER_BUFFER_FOR_PLAY:', e); }

                    // Resume buffer: after a stall, accumulate 5 seconds before resuming playback
                    try {
                        this._avplay.setBufferSize("PLAYER_BUFFER_FOR_RESUME", "PLAYER_BUFFER_SIZE_IN_SECOND", 5);
                        log.info('Set resume buffer to 5 seconds');
                    } catch (e) { log.warn('Failed to set PLAYER_BUFFER_FOR_RESUME:', e); }
                }
            } catch (e) {
                log.warn('Failed to set streaming properties', e);
            }

            // Set up display
            this._createDisplay();

            // Set up event listeners
            this._setupListeners();

            // Only queue native track selection for DirectPlay.
            // During Transcode/DirectStream, audio is baked into the HLS output,
            // so AVPlay only has one muxed audio track — calling setSelectTrack
            // would either silently fail or cause spurious errors, and it retried
            // on every onbufferingcomplete invocation (seeking, re-buffers, etc.).
            const isDirectPlay = options.playMethod === 'DirectPlay';

            // CRITICAL: Set pending indices BEFORE prepareAsync(), not after!
            // onbufferingcomplete fires DURING prepareAsync phase, which is when
            // _applyPendingTracks() runs. Setting these after would mean they're
            // always null when the handler fires, silently dropping initial track selection.
            if (isDirectPlay && options.audioStreamIndex !== undefined && options.audioStreamIndex !== null) {
                this._pendingAudioIndex = options.audioStreamIndex;
            } else {
                this._pendingAudioIndex = null;
            }

            if (options.subtitleStreamIndex !== undefined) {
                this._pendingSubtitleIndex = options.subtitleStreamIndex;
                this._delayedSubtitleIndex = options.subtitleStreamIndex; // Used for Tizen 5.0 re-apply
            } else {
                this._pendingSubtitleIndex = null;
                this._delayedSubtitleIndex = null;
            }

            // Prepare asynchronously
            await this._prepareAsync();

            // Start playback — must be after prepare
            this._avplay.play();
            this._isPlaying = true;
            this._playStartTime = Date.now(); // Record when play() was called

            // Apply tracks immediately after play() as some older Tizen versions 
            // populate track info right after start even before buffering complete
            this._applyPendingTracks();

            // Seek to start position if specified (must be called after play() on HLS to prevent Invalid Operation)
            if (options.playerStartPositionTicks) {
                const startMs = options.playerStartPositionTicks / 10000;
                try {
                    this._avplay.seekTo(startMs);
                } catch (e) {
                    log.warn('Seek immediately after play failed, will defer:', e);
                    setTimeout(() => {
                        if (this._isPlaying) {
                            try { this._avplay.seekTo(startMs); } catch (e2) { log.error('Deferred seek failed:', e2); }
                        }
                    }, 500);
                }
            }

            // Initialize current indices
            this._currentAudioStreamIndex = options.audioStreamIndex;
            this._currentSubtitleStreamIndex = options.subtitleStreamIndex;

            // Start position tracking
            this._startPositionTracking();

            this.onEvent({ type: 'playbackstart' });
        } catch (e) {
            log.error('Playback failed:', e);
            this.onEvent({ type: 'error', data: { message: e.message } });
            throw e;
        }
    }

    /**
     * Prepare media asynchronously
     * @private
     */
    _prepareAsync() {
        return new Promise((resolve, reject) => {
            try {
                this._avplay.prepareAsync(
                    () => {
                        log.info('Media prepared');
                        this._isPrepared = true;
                        this._duration = this._avplay.getDuration();
                        
                        // Emit loadedmetadata so OSD can update duration/chapters
                        this.onEvent({ 
                            type: 'loadedmetadata', 
                            data: { duration: this._duration / 1000 } 
                        });
                        
                        resolve();
                    },
                    (error) => {
                        log.error('Prepare failed:', error);
                        reject(new Error('Failed to prepare media'));
                    }
                );
            } catch (e) {
                reject(e);
            }
        });
    }

    /**
     * Set up Tizen AVPlay listeners
     * @private
     */
    _setupListeners() {
        if (!this._avplay) return;

        const listener = {
            onbufferingstart: () => {
                log.debug('Buffering started');
                if (this._isPlaying) {
                    this.onEvent({ type: 'waiting' });
                }
            },
            onbufferingprogress: (percent) => {
                // Buffering progress (0-100)
            },
            onbufferingcomplete: () => {
                log.debug('Buffering complete');
                
                // Track transition point: Buffer is full but clock hasn't started yet.
                // Apply pending tracks now. If they fail (e.g., Tizen needs more time to parse text),
                // they remain pending and get picked up by oncurrentplaytime.
                if (this._pendingAudioIndex !== null || this._pendingSubtitleIndex !== null) {
                    this._applyPendingTracks();
                }

                // Only emit playing if we are actually playing (not paused)
                if (this._isPlaying && !this._hasEmittedPlaying) {
                    this._hasEmittedPlaying = true;
                    this.onEvent({ type: 'playing' });
                }
            },
            oncurrentplaytime: (time) => {
                // Track when the first frame has actually rendered (time >= 0).
                // This is independent of the 'playing' event — onbufferingcomplete may
                // have already emitted 'playing', but that doesn't mean frames are drawing.
                // Pending subtitle tracks are gated on this flag to avoid silent no-ops.
                if (!this._firstFrameRendered && time >= 0) {
                    this._firstFrameRendered = true;
                }

                // Track when playback has stabilized (e.g. 1000ms of actual playback).
                // Used to delay the re-application of subtitles on Tizen 5.0, as
                // pausing/resuming immediately on the first frame triggers buffering loops.
                if (!this._playbackStabilized && time >= 1000) {
                    this._playbackStabilized = true;
                }

                // timeupdate fires as frames are drawn. 
                // We emit 'playing' only after the first frame has rendered (time >= 0).
                // On some Tizen versions, time might stay at 0 for a moment after buffering complete,
                // so we gate it on time >= 0 to be definitive.
                if (this._isPlaying && !this._hasEmittedPlaying && time >= 0) {
                    log.debug(`First frame rendered (time ${time}), emitting playing`);
                    this._hasEmittedPlaying = true;
                    this.onEvent({ type: 'playing' });
                }

                // AVPlay tracks are definitively fully populated once frames start rendering.
                // Apply pending tracks now. If they fail (e.g. index out of bounds or missing),
                // they remain pending. We try for up to 5 seconds of watch time on older Tizen,
                // then drop them to prevent infinite API polling performance penalties.
                if (this._pendingAudioIndex !== null || this._pendingSubtitleIndex !== null || (this._playbackStabilized && this._delayedSubtitleIndex !== null)) {
                    this._applyPendingTracks();
                    
                    if (time > 5000) {
                        if (this._pendingAudioIndex !== null) log.warn('Pending audio track dropped (timeout)');
                        if (this._pendingSubtitleIndex !== null || this._delayedSubtitleIndex !== null) log.warn('Pending/delayed subtitle track dropped (timeout)');
                        this._pendingAudioIndex = null;
                        this._pendingSubtitleIndex = null;
                        this._delayedSubtitleIndex = null;
                    }
                }

                // This is called periodically with current time in ms
                // Throttle to ~250ms to reduce main thread load on slow TVs
                const currentTime = this.getCurrentTime();
                const currentTimeTicks = Math.floor(currentTime * 10000000);
                
                if (Math.abs(currentTimeTicks - this._lastTimeUpdateTicks) > 2500000) {
                    this._lastTimeUpdateTicks = currentTimeTicks;
                    this.onEvent({ type: 'timeupdate', data: { time: currentTime } });
                }
            },
            onevent: (eventType, eventData) => {
                log.debug('Event:', eventType, eventData);
            },
            onstreamcompleted: () => {
                log.info('Playback completed');
                this._isPlaying = false;
                this.onEvent({ type: 'ended' });
            },
            onerror: (eventType) => {
                log.error('Error:', eventType);
                this.onEvent({ type: 'error', data: { message: eventType } });
            },
            onsubtitlechange: (duration, text, type, attributes) => {
                // Emit event with subtitle text so the UI layer can display it
                this.onEvent({
                    type: 'subtitlechange',
                    data: { text: text || '', duration: duration, subType: type, attributes }
                });
            },
            ondrmevent: (drmEvent, drmData) => {
                // DRM events
            }
        };

        this._avplay.setListener(listener);
    }

    /**
     * Set playback speed
     * @param {number} speed
     */
    setSpeed(speed) {
        if (this._avplay && this._isPrepared) {
             try {
                 this._avplay.setSpeed(speed);
             } catch (e) {
                 log.error('Failed to set speed:', speed, e);
             }
        }
    }

    /**
     * Apply any pending audio/subtitle track selections
     * @private
     */
    _applyPendingTracks() {
        if (!this._avplay || !this._isPrepared) return;

        const trackInfo = this._avplay.getTotalTrackInfo() || [];
        
        // If track info is completely empty, older Tizen might still be parsing headers.
        // Return early to try again on next timeupdate/buffering event.
        if (trackInfo.length === 0) {
            log.debug('_applyPendingTracks: No track info available yet, will retry...');
            return;
        }

        if (this._pendingAudioIndex !== null) {
            const tizenAudioIndex = this._findTizenAudioIndex(this._pendingAudioIndex);
            if (tizenAudioIndex !== null) {
                try {
                    this._avplay.setSelectTrack('AUDIO', tizenAudioIndex);
                    this._pendingAudioIndex = null;
                } catch (e) {
                    log.warn('Failed to apply audio track:', e);
                    this._pendingAudioIndex = null;
                }
            } else {
                const totalTracks = this._avplay.getTotalTrackInfo() || [];
                if (totalTracks.some(t => t.type === 'AUDIO')) {
                    log.warn(`Could not map pending audio index ${this._pendingAudioIndex}`);
                    this._pendingAudioIndex = null;
                }
                // Else: AVPlay hasn't parsed audio tracks yet. Remain pending.
            }
        }

        // Apply subtitle tracks eagerly (works on Tizen 5.5+), but only CLEAR
        // _pendingSubtitleIndex once the first frame has rendered. This way, on
        // Tizen 5.0 where setSelectTrack silently no-ops during buffering, the
        // track gets re-applied from oncurrentplaytime once frames are drawing.
        if (this._pendingSubtitleIndex !== null) {
            if (this._pendingSubtitleIndex === -1) {
                try {
                    this._avplay.setSilentSubtitle(true);
                    this._pendingSubtitleIndex = null;
                    this._delayedSubtitleIndex = null;
                } catch (e) {
                    log.warn('Failed to disable subtitles:', e);
                }
            } else {
                // Pre-first-frame: try the raw setSelectTrack. This works on
                // Tizen 5.5+ where tracks activate during buffering. On Tizen 5.0
                // it silently no-ops, but _delayedSubtitleIndex stays set so the
                // post-stabilization path will catch it later.
                const tizenSubIndex = this._findTizenSubtitleIndex(this._pendingSubtitleIndex);
                if (tizenSubIndex !== null) {
                    try {
                        log.debug(`Attempting early apply of TEXT track index ${tizenSubIndex}`);
                        this._avplay.setSelectTrack('TEXT', tizenSubIndex);
                        this._avplay.setSilentSubtitle(true);
                        this._avplay.setSilentSubtitle(false);
                        log.info(`Early TEXT track ${tizenSubIndex} applied (pending kept for re-apply)`);
                        this._pendingSubtitleIndex = null; // Clear so we don't spam oncurrentplaytime
                    } catch (e) {
                        log.warn(`Early apply of subtitle track ${tizenSubIndex} failed:`, e);
                    }
                } else {
                    const totalTracks = this._avplay.getTotalTrackInfo() || [];
                    if (totalTracks.some(t => t.type === 'TEXT')) {
                        log.warn(`Could not map pending subtitle index ${this._pendingSubtitleIndex}, disabling native subtitles and requesting fallback`);
                        try { this._avplay.setSilentSubtitle(true); } catch(e){}
                        
                        const failedIndex = this._pendingSubtitleIndex;
                        this._pendingSubtitleIndex = null;
                        this._delayedSubtitleIndex = null;
                        
                        // Emit event back to JellyfinPlayer to trigger forceExternalTextFallback
                        // This handles initial tracks that exceed Tizen's 30-track limit
                        this.onEvent({
                            type: 'subtitlefallback',
                            data: { index: failedIndex }
                        });
                    }
                    // Else: AVPlay hasn't parsed text tracks yet. Remain pending.
                }
            }
        } else if (this._playbackStabilized && this._delayedSubtitleIndex !== null && this._delayedSubtitleIndex !== -1) {
            // Post-stabilization: use setSubtitleStreamIndex which includes a
            // pause/resume cycle. On Tizen 5.0, early setSelectTrack silently failed.
            const savedIndex = this._delayedSubtitleIndex;
            this._delayedSubtitleIndex = null;
            try {
                log.info(`Re-applying subtitle track ${savedIndex} via setSubtitleStreamIndex (post-stabilization)`);
                this.setSubtitleStreamIndex(savedIndex);
            } catch (e) {
                log.warn(`Post-stabilization subtitle re-apply failed for index ${savedIndex}:`, e);
            }
        }
    }

    /**
     * Start position tracking timer
     * @private
     */
    _startPositionTracking() {
        // Position tracking handled by native oncurrentplaytime event to avoid jitter
    }

    /**
     * Stop position tracking timer
     * @private
     */
    _stopPositionTracking() {
        // No-op (handled by native events)
    }

    /**
     * Find Tizen internal audio track index for a given Jellyfin StreamIndex
     * @private
     * @param {number} streamIndex - Jellyfin Audio StreamIndex
     * @returns {number|null} Tizen track index or null if not found
     */
    _findTizenAudioIndex(streamIndex) {
        try {
            const trackInfo = this._avplay.getTotalTrackInfo();

            // Tizen returns objects like { type: 'AUDIO', index: 0, extra_info: ... }
            const audioTracks = trackInfo.filter((t) => t.type === 'AUDIO');

            // We need to map Jellyfin StreamIndex to Tizen's index
            // Strategy: Assume Tizen and Jellyfin see audio tracks in the same order
            if (!this._currentPlayOptions?.mediaSource?.MediaStreams) {
                log.warn('No MediaStreams info to map audio index');
                return null;
            }

            // Find which N-th audio track this is in Jellyfin MediaSource
            let jellyfinAudioStreams = this._currentPlayOptions.mediaSource.MediaStreams.filter(
                (s) => s.Type === 'Audio'
            );

            // If Tizen has fewer audio tracks, it usually silently dropped unsupported ones (DTS/TrueHD)
            if (audioTracks.length > 0 && jellyfinAudioStreams.length > audioTracks.length) {
                log.debug('Tizen audio track count mismatch, filtering unsupported codecs');
                jellyfinAudioStreams = jellyfinAudioStreams.filter(s => {
                    const c = (s.Codec || '').toLowerCase();
                    return !c.includes('truehd') && !c.includes('dts');
                });
            }

            const targetStreamIndexInAudioList = jellyfinAudioStreams.findIndex((s) => s.Index === streamIndex);

            if (targetStreamIndexInAudioList === -1) {
                log.warn('Requested audio stream index not found in MediaSource:', streamIndex);
                return null;
            }

            // Select the N-th available audio track in Tizen
            if (audioTracks[targetStreamIndexInAudioList]) {
                const tizenIndex = audioTracks[targetStreamIndexInAudioList].index;
                log.debug(`Mapped Jellyfin Audio ${streamIndex} to Tizen index ${tizenIndex}`);
                return parseInt(tizenIndex, 10);
            }

            log.warn('Could not map audio stream index (out of bounds)');
            return null;
        } catch (e) {
            log.error('Error mapping audio index:', e);
            return null;
        }
    }

    /**
     * Find Tizen internal subtitle track index for a given Jellyfin StreamIndex
     * @private
     * @param {number} streamIndex - Jellyfin Subtitle StreamIndex
     * @returns {number|null} Tizen track index or null if not found
     */
    _findTizenSubtitleIndex(streamIndex) {
        try {
            const trackInfo = this._avplay.getTotalTrackInfo() || [];
            const textTracks = trackInfo.filter((t) => t.type === 'TEXT');

            if (!this._currentPlayOptions?.mediaSource?.MediaStreams) {
                return null;
            }

            // Get ALL embedded subtitles from Jellyfin
            const jellyfinSubStreams = this._currentPlayOptions.mediaSource.MediaStreams.filter(
                (s) => s.Type === 'Subtitle' && !s.IsExternal
            );

            // Is the requested track actually an embedded subtitle?
            const targetStreamIndexInSubList = jellyfinSubStreams.findIndex((s) => s.Index === streamIndex);
            if (targetStreamIndexInSubList === -1) {
                log.warn('Requested subtitle stream not found in internal list:', streamIndex);
                return null;
            }

            // Tizen AVPlay silently skips loading bitmap/image-based embedded subtitles (PGS, VobSub).
            // This means Tizen's TEXT track length will be SHORTER than Jellyfin's Subtitle track length.
            // We must filter out those invisible tracks from Jellyfin's list *before* sequential mapping,
            // so that Jellyfin's text track N exactly aligns with Tizen's text track N.
            const jellyfinTextOnlyStreams = jellyfinSubStreams.filter(s => {
                const codec = (s.Codec || '').toLowerCase();
                return codec !== 'pgs' && codec !== 'pgssub' && 
                       codec !== 'vobsub' && codec !== 'dvdsub' && 
                       codec !== 'dvd_subtitle';
            });

            // Find the sequential position (Nth track) among the visible text tracks
            const occurrenceIndex = jellyfinTextOnlyStreams.findIndex(s => s.Index === streamIndex);

            if (occurrenceIndex === -1) {
                log.warn(`Requested subtitle track ${streamIndex} is a bitmap format not supported by Tizen AVPlay.`);
                return null;
            }

            // Map the Jellyfin Nth text track to Tizen's Nth text track
            if (textTracks[occurrenceIndex]) {
                const tizenIndex = textTracks[occurrenceIndex].index;
                log.debug(`Mapped Jellyfin Subtitle ${streamIndex} (Text sequence #${occurrenceIndex}) to Tizen index ${tizenIndex}`);
                return parseInt(tizenIndex, 10);
            }

            // Should never reach here unless Tizen failed to parse a text track entirely
            log.warn(`Tizen AVPlay out-of-bounds error: Track occurrence ${occurrenceIndex} exceeds Tizen's available TEXT tracks (${textTracks.length}).`);
            return null;

        } catch (e) {
            log.error('Error mapping subtitle index:', e);
            return null; // Safest fallback to let SubtitleManager catch it
        }
    }

    /**
     * Pause playback
     */
    pause() {
        if (this._avplay && this._isPlaying) {
            try {
                this._avplay.pause();
                this._isPlaying = false;
                this._hasEmittedPlaying = false; // Reset so playing fires cleanly on resume
                this.onEvent({ type: 'pause' });
            } catch (e) {
                log.error('Pause failed:', e);
            }
        }
    }

    /**
     * Resume playback
     */
    unpause() {
        if (this._avplay && !this._isPlaying && this._isPrepared) {
            try {
                this._avplay.play();
                this._isPlaying = true;
                this.onEvent({ type: 'play' });
            } catch (e) {
                log.error('Resume failed:', e);
            }
        }
    }

    /**
     * Stop playback (internal)
     * @private
     */
    async _stopInternal() {
        if (this._avplay) {
            try {
                const state = this._avplay.getState();
                if (state !== 'NONE' && state !== 'IDLE') {
                    this._avplay.stop();
                }
                this._avplay.close();
            } catch (e) {
                // Ignore stop errors
            }
        }
        this._isPrepared = false;
        this._isPlaying = false;
    }

    /**
     * Stop playback
     */
    async stop() {
        this._stopPositionTracking();
        await this._stopInternal();

        this._currentSrc = null;
        this._currentPlayOptions = null;

        this.onEvent({ type: 'stopped' });
    }

    /**
     * Seek to position
     * @param {number} positionTicks - Position in ticks
     */
    seek(positionTicks) {
        if (!this._avplay || !this._isPrepared) return;

        try {
            let targetTicks = positionTicks;
            if (this._currentPlayOptions?.transcodingOffsetTicks) {
                targetTicks = Math.max(0, positionTicks - this._currentPlayOptions.transcodingOffsetTicks);
            }
            const positionMs = Math.floor(targetTicks / 10000);
            this._avplay.seekTo(positionMs);

            // Manual timeupdate for paused state (native oncurrentplaytime is only fired when playing)
            const currentTime = targetTicks / 10000000;
            this.onEvent({ type: 'timeupdate', data: { time: currentTime } });
        } catch (e) {
            log.error('Seek failed:', e);
        }
    }

    // ========================================================================
    // Volume Control
    // ========================================================================

    /**
     * Set volume
     * @param {number} volume - Volume (0-100)
     */
    setVolume(volume) {
        this._volume = Math.max(0, Math.min(100, volume));

        if (this._avplay && !this._isMuted) {
            try {
                this._avplay.setVolume(this._volume);
            } catch (e) {
                // Some versions don't support setVolume
            }
        }

        MediaHelper.saveVolume(this._volume / 100);
    }

    /**
     * Get current volume
     * @returns {number} Volume (0-100)
     */
    getVolume() {
        return this._volume;
    }

    /**
     * Toggle mute
     */
    toggleMute() {
        this._isMuted = !this._isMuted;

        if (this._avplay) {
            try {
                this._avplay.setVolume(this._isMuted ? 0 : this._volume);
            } catch (e) {
                // Ignore
            }
        }
    }

    /**
     * Check if muted
     * @returns {boolean}
     */
    isMuted() {
        return this._isMuted;
    }

    // ========================================================================
    // Track Selection
    // ========================================================================

    /**
     * Set audio stream index
     * @param {number} index - Audio stream index
     */
    setAudioStreamIndex(index) {
        if (!this._avplay) {
            log.error('No avplay instance');
            return;
        }
        if (!this._isPrepared) {
            log.error('Player not prepared');
            return;
        }

        try {
            const tracks = this._avplay.getTotalTrackInfo();
            const audioTracks = tracks.filter((t) => t.type === 'AUDIO');

            if (index >= 0 && index < audioTracks.length) {
                const track = audioTracks[index];
                this._avplay.setSelectTrack('AUDIO', track.index);
                this._currentAudioStreamIndex = index; // Update state
            } else {
                log.error('Invalid audio index:', index, 'max:', audioTracks.length - 1);
            }
        } catch (e) {
            log.error('Set audio track failed:', e);
        }
    }

    /**
     * Set subtitle stream index
     * @param {number} index - Subtitle stream index (-1 to disable)
     */
    setSubtitleStreamIndex(index) {
        if (!this._avplay) return;

        // Workaround: Pause/Resume to force subtitle refresh on track change
        // Tizen AVPlay doesn't always update the current cue immediately when switching tracks
        let wasPlaying = false;
        try {
            wasPlaying = this._isPlaying && this._avplay.getState() === 'PLAYING';
            if (wasPlaying) {
                 try {
                    this._avplay.pause();
                 } catch (e) {
                    log.warn('Pause for subtitle switch failed:', e);
                 }
            }
        } catch (stateErr) {
             log.warn('Could not verify playing state for subtitle switch:', stateErr);
        }

        try {
            if (index < 0) {
                // -1 = disable subtitles
                this._avplay.setSilentSubtitle(true);
                this._currentSubtitleStreamIndex = index;
            } else {
                /*
                 * IMPORTANT: `index` here is a Jellyfin stream index (e.g. 3, 5, 7),
                 * NOT a 0-based Tizen array position. Using it directly as textTracks[index]
                 * would select the completely wrong track.
                 *
                 * We must map it via _findTizenSubtitleIndex(), which finds the N-th
                 * embedded subtitle in the Jellyfin MediaStreams list and maps that
                 * to the corresponding Tizen TEXT track by position.
                 */
                const tizenSubIndex = this._findTizenSubtitleIndex(index);
                if (tizenSubIndex !== null) {
                    this._avplay.setSelectTrack('TEXT', tizenSubIndex);
                    this._avplay.setSilentSubtitle(true);
                    this._avplay.setSilentSubtitle(false);
                    this._currentSubtitleStreamIndex = index;
                    log.debug(`setSubtitleStreamIndex: Jellyfin ${index} → Tizen TEXT ${tizenSubIndex}`);
                } else {
                    log.warn(`setSubtitleStreamIndex: Could not map Jellyfin index ${index} to Tizen TEXT track`);
                    throw new Error('OUT_OF_BOUNDS_TIZEN_LIMIT');
                }
            }
        } catch (e) {
            // OUT_OF_BOUNDS_TIZEN_LIMIT is a handled fallback, not a crash — use WARN, not ERROR
            if (e && e.message === 'OUT_OF_BOUNDS_TIZEN_LIMIT') {
                log.warn('Subtitle track exceeds Tizen 30-track limit, requesting external text fallback');
            } else {
                log.error('Failed to set subtitle track:', e);
            }
            throw e; // Re-throw so JellyfinPlayer can catch limits and fallback!
        }

        if (wasPlaying) {
             try {
                 this._avplay.play();
             } catch (e) {
                 log.warn('Resume after subtitle switch failed:', e);
             }
        }

    }

    /**
     * Signal to the UI that subtitle styles should be refreshed.
     * Called by settings menu when style preferences change.
     */
    refreshSubtitles() {
        this.onEvent({ type: 'refreshsubtitles' });
    }

    /**
     * Set subtitle offset using Tizen's native AVPlay API.
     * Positive values delay subtitles, negative values advance them.
     * @param {number} seconds - Offset in seconds
     */
    setSubtitleOffset(seconds) {
        this._subtitleOffset = seconds;
        this._applySubtitlePosition();
    }

    /**
     * Apply the current subtitle offset to AVPlay.
     * Uses webapis.avplay.setSubtitlePosition(ms) which accepts
     * positive (delay) and negative (advance) millisecond values.
     * Only callable in PLAYING or PAUSED states.
     * @private
     */
    _applySubtitlePosition() {
        if (!this._avplay || !this._isPrepared) return;

        try {
            // Convert seconds to milliseconds for AVPlay API
            const offsetMs = Math.round(this._subtitleOffset * 1000);
            this._avplay.setSubtitlePosition(offsetMs);
            log.debug(`Subtitle offset applied: ${this._subtitleOffset}s (${offsetMs}ms)`);
        } catch (e) {
            // setSubtitlePosition may fail if not in PLAYING/PAUSED state
            log.warn('Failed to apply subtitle offset:', e);
        }
    }

    // ========================================================================
    // State Getters
    // ========================================================================

    /**
     * Get current time in seconds
     * @returns {number}
     */
    getCurrentTime() {
        if (!this._avplay || !this._isPrepared) return 0;

        try {
            const timeMs = Number(this._avplay.getCurrentTime());
            if (isNaN(timeMs)) return 0;

            return timeMs / 1000;
        } catch (e) {
            return 0;
        }
    }

    /**
     * Get start position in ticks
     * @returns {number}
     */
    getStartPositionTicks() {
        return this._currentPlayOptions?.playerStartPositionTicks || 0;
    }

    /**
     * Get duration in seconds
     * @returns {number}
     */
    getDuration() {
        return this._duration / 1000;
    }

    /**
     * Check if paused
     * @returns {boolean}
     */
    isPaused() {
        if (!this._avplay) return true;

        try {
            return this._avplay.getState() === 'PAUSED';
        } catch (e) {
            return !this._isPlaying;
        }
    }

    // ========================================================================
    // Fullscreen (Tizen TVs are always fullscreen)
    // ========================================================================

    /**
     * Toggle fullscreen (no-op on Tizen TV)
     */
    toggleFullscreen() {
        // Tizen TV apps are always fullscreen
    }

    /**
     * Check if in fullscreen
     * @returns {boolean}
     */
    isFullscreen() {
        return true; // Always fullscreen on TV
    }

    // ========================================================================
    // Cleanup
    // ========================================================================

    /**
     * Destroy the player
     */
    destroy() {
        this._stopPositionTracking();

        if (this._avplay) {
            try {
                this._avplay.stop();
                this._avplay.close();
            } catch (e) {
                // Ignore cleanup errors
            }
        }

        this._avplay = null;
        this._currentSrc = null;
        this._currentPlayOptions = null;
    }

    /**
     * Get current audio stream index
     * @returns {number|null}
     */
    getCurrentAudioStreamIndex() {
        return this._currentAudioStreamIndex;
    }

    /**
     * Get current subtitle stream index
     * @returns {number|null}
     */
    getCurrentSubtitleStreamIndex() {
        return this._currentSubtitleStreamIndex;
    }
}
