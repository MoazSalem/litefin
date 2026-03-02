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

        log.info('Starting playback:', options.url);

        this._currentPlayOptions = options;
        this._currentSrc = options.url;

        // Reset subtitle offset for new playback session
        this._subtitleOffset = 0;

        try {
            // Stop any existing playback
            await this._stopInternal();

            // Give Tizen time to cleanup (helps with buffer errors on rapid changes)
            await new Promise((resolve) => setTimeout(resolve, 200));

            // Open the media
            this._avplay.open(options.url);

            // Set up display
            this._createDisplay();

            // Set up event listeners
            this._setupListeners();

            // Prepare asynchronously
            await this._prepareAsync();

            // Start playback
            this._avplay.play();
            this._isPlaying = true;

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

            // Only queue native track selection for DirectPlay.
            // During Transcode/DirectStream, audio is baked into the HLS output,
            // so AVPlay only has one muxed audio track — calling setSelectTrack
            // would either silently fail or cause spurious errors, and it retried
            // on every onbufferingcomplete invocation (seeking, re-buffers, etc.).
            const isDirectPlay = options.playMethod === 'DirectPlay';

            if (isDirectPlay && options.audioStreamIndex !== undefined && options.audioStreamIndex !== null) {
                this._pendingAudioIndex = options.audioStreamIndex;
            } else {
                // Explicitly clear any leftover pending index from a previous session
                this._pendingAudioIndex = null;
            }

            if (isDirectPlay && options.subtitleStreamIndex !== undefined) {
                this._pendingSubtitleIndex = options.subtitleStreamIndex;
            } else {
                this._pendingSubtitleIndex = null;
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
                this.onEvent({ type: 'waiting' });
            },
            onbufferingprogress: (percent) => {
                // Buffering progress (0-100)
            },
            onbufferingcomplete: () => {
                log.debug('Buffering complete');
                // Only emit playing if we are actually playing (not paused)
                if (this._isPlaying) {
                    this.onEvent({ type: 'playing' });
                }

                // Apply pending track selections once buffering is done
                // This is the most reliable time to switch tracks on Tizen
                this._applyPendingTracks();
            },
            oncurrentplaytime: (time) => {
                // This is called periodically with current time in ms
                this.onEvent({ type: 'timeupdate', data: { time: this.getCurrentTime() } });
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
        if (this._pendingAudioIndex !== null) {
            const tizenAudioIndex = this._findTizenAudioIndex(this._pendingAudioIndex);
            // Always clear the pending index, whether or not we found a valid Tizen track.
            // Without this, a failed lookup (null return) would leave the index dirty
            // and retry on every subsequent onbufferingcomplete event.
            this._pendingAudioIndex = null;
            if (tizenAudioIndex !== null) {
                try {
                    this._avplay.setSelectTrack('AUDIO', tizenAudioIndex);
                    this._avplay.setSelectTrack('AUDIO', tizenAudioIndex);
                } catch (e) {
                    log.warn('Failed to apply audio track:', e);
                }
            }
        }

        if (this._pendingSubtitleIndex !== null) {
            if (this._pendingSubtitleIndex === -1) {
                try {
                    this._avplay.setSilentSubtitle(true);
                    this._pendingSubtitleIndex = null;
                } catch (e) {
                    log.warn('Failed to disable subtitles:', e);
                }
            } else {
                const tizenSubIndex = this._findTizenSubtitleIndex(this._pendingSubtitleIndex);
                if (tizenSubIndex !== null) {
                    try {
                        this._avplay.setSilentSubtitle(false);
                        this._avplay.setSelectTrack('TEXT', tizenSubIndex);
                        this._avplay.setSelectTrack('TEXT', tizenSubIndex);
                        this._pendingSubtitleIndex = null;
                    } catch (e) {
                        log.warn('Failed to apply subtitle track:', e);
                    }
                }
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
            const jellyfinAudioStreams = this._currentPlayOptions.mediaSource.MediaStreams.filter(
                (s) => s.Type === 'Audio'
            );
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
            const trackInfo = this._avplay.getTotalTrackInfo();
            const textTracks = trackInfo.filter((t) => t.type === 'TEXT');

            if (!this._currentPlayOptions?.mediaSource?.MediaStreams) {
                return null;
            }

            // Only internal (embedded) subtitles are managed by Tizen,
            // external subtitles are handled separately by the player
            const jellyfinSubStreams = this._currentPlayOptions.mediaSource.MediaStreams.filter(
                (s) => s.Type === 'Subtitle' && !s.IsExternal
            );

            const targetStreamIndexInSubList = jellyfinSubStreams.findIndex((s) => s.Index === streamIndex);

            if (targetStreamIndexInSubList === -1) {
                // Might be external or not found
                log.warn('Requested subtitle stream not found in internal list:', streamIndex);
                return null;
            }

            if (textTracks[targetStreamIndexInSubList]) {
                const tizenIndex = textTracks[targetStreamIndexInSubList].index;
                log.debug(
                    `Mapped Jellyfin Subtitle ${streamIndex} (Nth: ${targetStreamIndexInSubList}) to Tizen index ${tizenIndex}`
                );
                return parseInt(tizenIndex, 10);
            }

            return null;
        } catch (e) {
            log.error('Error mapping subtitle index:', e);
            return null;
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
                    this._avplay.setSilentSubtitle(false);
                    this._avplay.setSelectTrack('TEXT', tizenSubIndex);
                    this._currentSubtitleStreamIndex = index;
                    log.debug(`setSubtitleStreamIndex: Jellyfin ${index} → Tizen TEXT ${tizenSubIndex}`);
                } else {
                    log.warn(`setSubtitleStreamIndex: Could not map Jellyfin index ${index} to Tizen TEXT track`);
                }
            }
        } catch (e) {
             log.error('Failed to set subtitle track:', e);
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
