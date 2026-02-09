/**
 * TizenAVPlayer - Tizen Native Video Backend
 *
 * Uses Tizen's AVPlay API for hardware-accelerated playback on Samsung TVs.
 * Provides better codec support and performance than HTML5 video on Tizen.
 *
 * @module core/TizenAVPlayer
 */

import { MediaHelper } from './MediaHelper';
import { debug } from '../utils/debug';

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

        // Check Tizen availability
        this._avplay = window.tizen?.avplay || window.webapis?.avplay || null;

        if (!this._avplay) {
            debug.warn('[TizenAVPlayer] Tizen AVPlay API not available');
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

        // Get container dimensions
        const rect = this.container.getBoundingClientRect();
        debug.log('[TizenAVPlayer] _createDisplay rect:', rect);

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
            debug.error('[TizenAVPlayer] Failed to set display:', e);
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

        debug.log('[TizenAVPlayer] Starting playback:', options.url);

        this._currentPlayOptions = options;
        this._currentSrc = options.url;

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

            // Seek to start position if specified
            if (options.playerStartPositionTicks) {
                const startMs = options.playerStartPositionTicks / 10000;
                this._avplay.seekTo(startMs);
            }

            // Start playback
            this._avplay.play();
            this._isPlaying = true;

            // Start playback
            this._avplay.play();
            this._isPlaying = true;

            // Store selected tracks to be applied after buffering completes
            // This is more reliable on Tizen TVs
            if (options.audioStreamIndex !== undefined && options.audioStreamIndex !== null) {
                this._pendingAudioIndex = options.audioStreamIndex;
            }

            if (options.subtitleStreamIndex !== undefined) {
                this._pendingSubtitleIndex = options.subtitleStreamIndex;
            }

            // Initialize current indices
            this._currentAudioStreamIndex = options.audioStreamIndex;
            this._currentSubtitleStreamIndex = options.subtitleStreamIndex;

            // Start position tracking
            this._startPositionTracking();

            this.onEvent({ type: 'playbackstart' });
        } catch (e) {
            debug.error('[TizenAVPlayer] Playback failed:', e);
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
                        debug.log('[TizenAVPlayer] Media prepared');
                        this._isPrepared = true;
                        this._duration = this._avplay.getDuration();
                        resolve();
                    },
                    (error) => {
                        debug.error('[TizenAVPlayer] Prepare failed:', error);
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
                debug.log('[TizenAVPlayer] Buffering started');
                this.onEvent({ type: 'waiting' });
            },
            onbufferingprogress: (percent) => {
                // Buffering progress (0-100)
            },
            onbufferingcomplete: () => {
                debug.log('[TizenAVPlayer] Buffering complete');
                this.onEvent({ type: 'playing' });

                // Apply pending track selections once buffering is done
                // This is the most reliable time to switch tracks on Tizen
                this._applyPendingTracks();
            },
            oncurrentplaytime: (time) => {
                // This is called periodically with current time in ms
                this.onEvent({ type: 'timeupdate', data: { time: time / 1000 } });
            },
            onevent: (eventType, eventData) => {
                debug.log('[TizenAVPlayer] Event:', eventType, eventData);
            },
            onstreamcompleted: () => {
                debug.log('[TizenAVPlayer] Playback completed');
                this._isPlaying = false;
                this.onEvent({ type: 'ended' });
            },
            onerror: (eventType) => {
                debug.error('[TizenAVPlayer] Error:', eventType);
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
     * Apply any pending audio/subtitle track selections
     * @private
     */
    _applyPendingTracks() {
        if (this._pendingAudioIndex !== null) {
            const tizenAudioIndex = this._findTizenAudioIndex(this._pendingAudioIndex);
            if (tizenAudioIndex !== null) {
                try {
                    this._avplay.setSelectTrack('AUDIO', tizenAudioIndex);
                    this._avplay.setSelectTrack('AUDIO', tizenAudioIndex);
                    this._pendingAudioIndex = null; // Clear pending
                } catch (e) {
                    debug.warn('[TizenAVPlayer] Failed to apply audio track:', e);
                }
            }
        }

        if (this._pendingSubtitleIndex !== null) {
            if (this._pendingSubtitleIndex === -1) {
                try {
                    this._avplay.setSilentSubtitle(true);
                    this._pendingSubtitleIndex = null;
                } catch (e) {
                    debug.warn('[TizenAVPlayer] Failed to disable subtitles:', e);
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
                        debug.warn('[TizenAVPlayer] Failed to apply subtitle track:', e);
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
        this._stopPositionTracking();

        this._positionTimer = setInterval(() => {
            if (this._isPlaying && this._avplay) {
                try {
                    const time = this._avplay.getCurrentTime();
                    this.onEvent({ type: 'timeupdate', data: { time: time / 1000 } });
                } catch (e) {
                    // Ignore errors during position tracking
                }
            }
        }, 1000); // Update every second
    }

    /**
     * Stop position tracking timer
     * @private
     */
    _stopPositionTracking() {
        if (this._positionTimer) {
            clearInterval(this._positionTimer);
            this._positionTimer = null;
        }
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
            // 1. Find which N-th audio track this is in Jellyfin MediaSource
            if (!this._currentPlayOptions?.mediaSource?.MediaStreams) {
                debug.warn('[TizenAVPlayer] No MediaStreams info to map audio index');
                return null;
            }

            const jellyfinAudioStreams = this._currentPlayOptions.mediaSource.MediaStreams.filter(
                (s) => s.Type === 'Audio'
            );
            const targetStreamIndexInAudioList = jellyfinAudioStreams.findIndex((s) => s.Index === streamIndex);

            if (targetStreamIndexInAudioList === -1) {
                debug.warn('[TizenAVPlayer] Requested audio stream index not found in MediaSource:', streamIndex);
                return null;
            }

            // 2. Select the N-th available audio track in Tizen
            if (audioTracks[targetStreamIndexInAudioList]) {
                const tizenIndex = audioTracks[targetStreamIndexInAudioList].index;
                debug.log(`[TizenAVPlayer] Mapped Jellyfin Audio ${streamIndex} to Tizen index ${tizenIndex}`);
                return parseInt(tizenIndex, 10);
            }

            debug.warn('[TizenAVPlayer] Could not map audio stream index (out of bounds)');
            return null;
        } catch (e) {
            debug.error('[TizenAVPlayer] Error mapping audio index:', e);
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

            const jellyfinSubStreams = this._currentPlayOptions.mediaSource.MediaStreams.filter(
                (s) => s.Type === 'Subtitle' && !s.IsExternal
            );
            // Note: External subtitles are handled separately by player, we only care about internal ones here for Tizen native switch
            // But verify if Tizen lists external ones too? For now assume internal.

            const targetStreamIndexInSubList = jellyfinSubStreams.findIndex((s) => s.Index === streamIndex);

            if (targetStreamIndexInSubList === -1) {
                // Might be external or not found
                debug.warn('[TizenAVPlayer] Requested subtitle stream not found in internal list:', streamIndex);
                return null;
            }

            if (textTracks[targetStreamIndexInSubList]) {
                const tizenIndex = textTracks[targetStreamIndexInSubList].index;
                debug.log(
                    `[TizenAVPlayer] Mapped Jellyfin Subtitle ${streamIndex} (Nth: ${targetStreamIndexInSubList}) to Tizen index ${tizenIndex}`
                );
                return parseInt(tizenIndex, 10);
            }

            return null;
        } catch (e) {
            debug.error('[TizenAVPlayer] Error mapping subtitle index:', e);
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
                debug.error('[TizenAVPlayer] Pause failed:', e);
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
                debug.error('[TizenAVPlayer] Resume failed:', e);
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
            const positionMs = positionTicks / 10000;
            this._avplay.seekTo(positionMs);
        } catch (e) {
            debug.error('[TizenAVPlayer] Seek failed:', e);
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
            debug.error('[TizenAVPlayer] No avplay instance');
            return;
        }
        if (!this._isPrepared) {
            debug.error('[TizenAVPlayer] Player not prepared');
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
                debug.error('[TizenAVPlayer] Invalid audio index:', index, 'max:', audioTracks.length - 1);
            }
        } catch (e) {
            debug.error('[TizenAVPlayer] Set audio track failed:', e);
        }
    }

    /**
     * Set subtitle stream index
     * @param {number} index - Subtitle stream index (-1 to disable)
     */
    setSubtitleStreamIndex(index) {
        if (!this._avplay) return;

        try {
            if (index < 0) {
                this._avplay.setSilentSubtitle(true);
                this._currentSubtitleStreamIndex = index; // Update state
            } else {
                this._avplay.setSilentSubtitle(false);

                const tracks = this._avplay.getTotalTrackInfo();
                const textTracks = tracks.filter((t) => t.type === 'TEXT');

                if (textTracks[index]) {
                    this._avplay.setSelectTrack('TEXT', textTracks[index].index);
                    this._currentSubtitleStreamIndex = index; // Update state
                }
            }
        } catch (e) {
            debug.error('[TizenAVPlayer] Set subtitle track failed:', e);
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
            let timeMs = Number(this._avplay.getCurrentTime());
            if (isNaN(timeMs)) return 0;

            // Add transcoding offset safely
            if (this._currentPlayOptions && typeof this._currentPlayOptions.transcodingOffsetTicks === 'number') {
                timeMs += this._currentPlayOptions.transcodingOffsetTicks / 10000;
            }

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
