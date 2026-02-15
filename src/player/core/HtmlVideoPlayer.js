/**
 * HtmlVideoPlayer - HTML5 Video Backend
 *
 * Core video playback using HTML5 video element with HLS.js support.
 * Extracted and simplified from jellyfin-web's htmlVideoPlayer plugin.
 *
 * @module core/HtmlVideoPlayer
 */

import Hls from 'hls.js';
import Screenfull from 'screenfull';
import { MediaHelper } from './MediaHelper.js';
import { logger } from '../../utils/Logger.js';

const log = logger.create('HtmlVideoPlayer');

// ============================================================================
// Constants
// ============================================================================

const SEEK_THRESHOLD_MS = 1000; // Minimum seek difference to trigger seek

// ============================================================================
// HtmlVideoPlayer Class
// ============================================================================

export class HtmlVideoPlayer {
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

        this._videoElement = null;
        this._hlsPlayer = null;
        this._currentSrc = null;
        this._currentPlayOptions = null;
        this._started = false;
        this._timeUpdated = false;

        // Subtitle state
        this._currentSubtitleIndex = -1;
        this._subtitleOffset = 0;
        this._previousOffset = 0; // Tracks the last applied offset for delta calc

        // Bound event handlers (for cleanup)
        this._boundHandlers = {};
    }

    // ========================================================================
    // Initialization
    // ========================================================================

    /**
     * Create or get video element
     * @private
     */
    _ensureVideoElement() {
        if (this._videoElement) {
            // Ensure events are bound if they were unbound in stop()
            if (Object.keys(this._boundHandlers).length === 0) {
                this._bindEvents(this._videoElement);
            }
            return this._videoElement;
        }

        // Create video element
        const video = document.createElement('video');
        video.className = 'jellyfin-video-player';
        video.setAttribute('playsinline', 'true');
        video.setAttribute('webkit-playsinline', 'true');
        video.preload = 'metadata';

        // Apply saved volume
        video.volume = MediaHelper.getSavedVolume();

        // Create container if needed
        if (!this.container) {
            this.container = document.createElement('div');
            this.container.className = 'jellyfin-player-container';
            document.body.appendChild(this.container);
        }

        this.container.appendChild(video);
        this._videoElement = video;

        // Bind event handlers
        this._bindEvents(video);

        return video;
    }

    /**
     * Bind event handlers to video element
     * @private
     */
    _bindEvents(video) {
        const handlers = {
            timeupdate: this._onTimeUpdate.bind(this),
            ended: this._onEnded.bind(this),
            error: this._onError.bind(this),
            pause: this._onPause.bind(this),
            play: this._onPlay.bind(this),
            playing: this._onPlaying.bind(this),
            waiting: this._onWaiting.bind(this),
            volumechange: this._onVolumeChange.bind(this),
            loadedmetadata: this._onLoadedMetadata.bind(this)
        };

        for (const [event, handler] of Object.entries(handlers)) {
            video.addEventListener(event, handler);
            this._boundHandlers[event] = handler;
        }
    }

    /**
     * Remove event handlers from video element
     * @private
     */
    _unbindEvents(video) {
        if (!video) return;

        for (const [event, handler] of Object.entries(this._boundHandlers)) {
            video.removeEventListener(event, handler);
        }
        this._boundHandlers = {};
    }

    // ========================================================================
    // Playback Control
    // ========================================================================

    /**
     * Start playback
     * @param {Object} options - Play options from JellyfinPlayer
     */
    async play(options) {
        log.info('Starting playback:', options.url);

        this._currentPlayOptions = options;
        this._started = false;
        this._timeUpdated = false;

        // Reset subtitle offset for new playback session
        this._subtitleOffset = 0;
        this._previousOffset = 0;

        const video = this._ensureVideoElement();

        // Destroy any existing HLS player
        this._destroyHlsPlayer();

        // Determine playback method
        if (this._shouldUseHlsJs(options)) {
            await this._playWithHlsJs(video, options);
        } else {
            await this._playNative(video, options);
        }

        this._currentSrc = options.url;
    }

    /**
     * Check if we should use HLS.js
     * @private
     */
    _shouldUseHlsJs(options) {
        // Use HLS.js if:
        // 1. Browser supports MSE (required for HLS.js)
        // 2. It's an HLS stream
        // 3. Native HLS isn't preferred (non-Safari)
        if (!Hls.isSupported()) {
            return false;
        }

        const isHlsStream = options.isHls || (options.url && options.url.includes('.m3u8'));

        if (!isHlsStream) {
            return false;
        }

        // Safari has native HLS support, but we might want HLS.js for better control
        const hasNativeHls = this._checkNativeHlsSupport();

        // Prefer HLS.js on most platforms for better control
        // But use native on iOS where HLS.js doesn't work well
        const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);

        return !isIOS || !hasNativeHls;
    }

    /**
     * Check native HLS support
     * @private
     */
    _checkNativeHlsSupport() {
        const video = document.createElement('video');
        return !!(
            video.canPlayType('application/x-mpegURL').replace(/no/, '') ||
            video.canPlayType('application/vnd.apple.mpegURL').replace(/no/, '')
        );
    }

    /**
     * Play using HLS.js
     * @private
     */
    _playWithHlsJs(video, options) {
        return new Promise((resolve, reject) => {
            log.info('Using HLS.js for playback');

            const hls = new Hls({
                startPosition: (options.playerStartPositionTicks || 0) / 10000000,
                maxBufferLength: 30,
                maxMaxBufferLength: 60,
                manifestLoadingTimeOut: 20000,
                levelLoadingTimeOut: 20000,
                fragLoadingTimeOut: 20000
            });

            // HLS.js events
            hls.on(Hls.Events.MANIFEST_PARSED, () => {
                log.info('HLS manifest parsed');

                // Apply saved tracks
                if (options.audioStreamIndex !== undefined && options.audioStreamIndex >= 0) {
                    if (options.audioStreamIndex < hls.audioTracks.length) {
                        hls.audioTrack = options.audioStreamIndex;
                        log.debug('Set HLS audio track:', options.audioStreamIndex);
                    }
                }

                if (options.subtitleStreamIndex !== undefined) {
                    // HLS.js subtitle tracks
                    if (options.subtitleStreamIndex === -1) {
                        hls.subtitleTrack = -1; // Disabled
                    } else if (options.subtitleStreamIndex < hls.subtitleTracks.length) {
                        hls.subtitleTrack = options.subtitleStreamIndex;
                        log.debug('Set HLS subtitle track:', options.subtitleStreamIndex);
                    }
                }

                video.play().then(resolve).catch(reject);
            });

            hls.on(Hls.Events.ERROR, (event, data) => {
                log.error('HLS error:', data);

                if (data.fatal) {
                    switch (data.type) {
                        case Hls.ErrorTypes.NETWORK_ERROR:
                            log.info('Attempting to recover from network error');
                            hls.startLoad();
                            break;
                        case Hls.ErrorTypes.MEDIA_ERROR:
                            log.info('Attempting to recover from media error');
                            hls.recoverMediaError();
                            break;
                        default:
                            log.error('Fatal HLS error, cannot recover');
                            hls.destroy();
                            reject(new Error('HLS playback failed'));
                            break;
                    }
                }
            });

            // Load source
            log.debug('HLS Loading source:', options.url);
            hls.loadSource(options.url);
            hls.attachMedia(video);

            this._hlsPlayer = hls;

            // Failsafe timeout
            setTimeout(() => {
                if (!this._started && !this._videoElement?.paused) {
                    log.warn('No playback start detected after 10s');
                }
            }, 10000);
        });
    }

    /**
     * Play using native video element
     * @private
     */
    async _playNative(video, options) {
        log.info('Using native playback');

        // Set cross-origin if needed
        const crossOrigin = MediaHelper.getCrossOriginValue(options.mediaSource);
        if (crossOrigin) {
            video.crossOrigin = crossOrigin;
        }

        video.src = options.url;
        video.autoplay = true;

        // Seek if starting from position
        if (options.playerStartPositionTicks) {
            const startSeconds = options.playerStartPositionTicks / 10000000;
            if (video.duration >= startSeconds || !MediaHelper.isValidDuration(video.duration)) {
                video.currentTime = startSeconds;
            }
        }

        return video.play();
    }

    /**
     * Pause playback
     */
    pause() {
        this._videoElement?.pause();
    }

    /**
     * Resume playback
     */
    unpause() {
        this._videoElement?.play();
    }

    /**
     * Stop playback
     */
    async stop() {
        this._destroyHlsPlayer();

        const video = this._videoElement;

        if (video) {
            // Unbind events before clearing src to prevent error events from firing
            this._unbindEvents(video);
            
            video.pause();
            // Use removeAttribute instead of setting src to empty string to be cleaner
            video.removeAttribute('src');
            video.load();
        }

        this._currentSrc = null;
        this._currentPlayOptions = null;
        this._started = false;
        this._timeUpdated = false;
    }

    /**
     * Seek to position
     * @param {number} positionTicks - Position in ticks
     */
    seek(positionTicks) {
        const video = this._videoElement;
        if (!video) return;

        const seconds = positionTicks / 10000000;
        log.debug('seek to seconds', seconds, 'ticks', positionTicks);

        // Account for transcoding offset
        let targetSeconds = seconds;
        if (this._currentPlayOptions?.transcodingOffsetTicks) {
            targetSeconds = (positionTicks - this._currentPlayOptions.transcodingOffsetTicks) / 10000000;
        }

        if (Math.abs(video.currentTime - targetSeconds) > SEEK_THRESHOLD_MS / 1000) {
            video.currentTime = Math.max(0, targetSeconds);
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
        if (this._videoElement) {
            const normalizedVolume = Math.max(0, Math.min(100, volume)) / 100;
            this._videoElement.volume = normalizedVolume;
            MediaHelper.saveVolume(normalizedVolume);
        }
    }

    /**
     * Get current volume
     * @returns {number} Volume (0-100)
     */
    getVolume() {
        return (this._videoElement?.volume ?? 1) * 100;
    }

    /**
     * Toggle mute
     */
    toggleMute() {
        if (this._videoElement) {
            this._videoElement.muted = !this._videoElement.muted;
        }
    }

    /**
     * Check if muted
     * @returns {boolean}
     */
    isMuted() {
        return this._videoElement?.muted ?? false;
    }

    // ========================================================================
    // Track Selection
    // ========================================================================

    /**
     * Set audio stream index
     * @param {number} index - Audio stream index
     */
    setAudioStreamIndex(index) {
        const video = this._videoElement;
        if (!video) return;

        const audioTracks = video.audioTracks;
        if (!audioTracks || audioTracks.length < 2) return;

        for (let i = 0; i < audioTracks.length; i++) {
            audioTracks[i].enabled = i === index;
        }
    }

    /**
     * Set subtitle stream index
     * @param {number} index - Subtitle stream index (-1 to disable)
     */
    setSubtitleStreamIndex(index) {
        const video = this._videoElement;
        if (!video) return;

        this._currentSubtitleIndex = index;

        // Reset offset state when switching tracks
        this._subtitleOffset = 0;
        this._previousOffset = 0;

        // Handle native text tracks
        const textTracks = video.textTracks;
        if (textTracks) {
            for (let i = 0; i < textTracks.length; i++) {
                textTracks[i].mode = i === index ? 'showing' : 'hidden';
            }
        }

        // TODO: Handle custom subtitle rendering for ASS/PGS
    }

    /**
     * Set aspect ratio mode
     * @param {string} mode - 'auto', 'zoom', 'stretch'
     */
    setAspectRatio(mode) {
        if (!this._videoElement) return;

        let objectFit = 'contain'; // Default/Auto

        switch (mode) {
            case 'zoom':
                objectFit = 'cover';
                break;
            case 'stretch':
                objectFit = 'fill';
                break;
            case 'auto':
            default:
                objectFit = 'contain';
                break;
        }

        log.info('Setting aspect ratio:', mode, '->', objectFit);
        this._videoElement.style.objectFit = objectFit;
    }

    /**
     * Set subtitle offset by shifting VTT cue timing.
     * Uses delta-based approach: calculates the difference between the new
     * offset and the previously applied offset, then shifts all cue times.
     * Positive offset = subtitles display later, negative = earlier.
     * @param {number} seconds - Offset in seconds
     */
    setSubtitleOffset(seconds) {
        this._subtitleOffset = seconds;

        const video = this._videoElement;
        if (!video || !video.textTracks) {
            log.debug(`Subtitle offset stored: ${seconds}s (no video/tracks)`);
            return;
        }

        // Calculate the relative delta from the last applied offset
        const delta = seconds - this._previousOffset;
        if (delta === 0) return; // No change needed

        // Apply the delta to all 'showing' text tracks' cues
        for (let i = 0; i < video.textTracks.length; i++) {
            const track = video.textTracks[i];
            if (track.mode !== 'showing' || !track.cues) continue;

            // Shift every cue's start and end time by the delta
            for (let j = 0; j < track.cues.length; j++) {
                const cue = track.cues[j];
                cue.startTime += delta;
                cue.endTime += delta;
            }
        }

        // Update the tracked offset for next delta calculation
        this._previousOffset = seconds;
        log.debug(`Subtitle offset applied: ${seconds}s (delta: ${delta}s)`);
    }

    // ========================================================================
    // State Getters
    // ========================================================================

    /**
     * Get current time in seconds
     * @returns {number}
     */
    getCurrentTime() {
        let time = this._videoElement?.currentTime ?? 0;

        // Add transcoding offset
        if (this._currentPlayOptions?.transcodingOffsetTicks) {
            time += this._currentPlayOptions.transcodingOffsetTicks / 10000000;
        }

        return time;
    }

    /**
     * Get duration in seconds
     * @returns {number}
     */
    getDuration() {
        return this._videoElement?.duration ?? 0;
    }

    /**
     * Check if paused
     * @returns {boolean}
     */
    isPaused() {
        return this._videoElement?.paused ?? true;
    }

    // ========================================================================
    // Fullscreen
    // ========================================================================

    /**
     * Toggle fullscreen
     */
    toggleFullscreen() {
        if (Screenfull.isEnabled) {
            if (Screenfull.isFullscreen) {
                Screenfull.exit();
            } else {
                Screenfull.request(this.container || this._videoElement);
            }
        } else if (this._videoElement?.webkitEnterFullscreen) {
            // iOS fallback
            this._videoElement.webkitEnterFullscreen();
        }
    }

    /**
     * Check if in fullscreen
     * @returns {boolean}
     */
    isFullscreen() {
        if (Screenfull.isEnabled) {
            return Screenfull.isFullscreen;
        }
        return !!document.fullscreenElement;
    }

    // ========================================================================
    // Event Handlers
    // ========================================================================

    /** @private */
    _onTimeUpdate() {
        if (!this._timeUpdated && this._videoElement?.currentTime) {
            this._timeUpdated = true;
        }

        this.onEvent({ type: 'timeupdate', data: { time: this.getCurrentTime() } });
    }

    /** @private */
    _onEnded() {
        log.info('Playback ended');
        this.onEvent({ type: 'ended' });
    }

    /** @private */
    _onError(e) {
        const video = e.target;

        // Ignore errors if we don't have a source and no HLS player is active.
        // This commonly happens during stop/cleanup when src is removed.
        if (!video.src && !this._hlsPlayer) {
            log.debug('Ignoring error event on empty source during cleanup');
            return;
        }

        const errorCode = video.error?.code || 0;
        const errorMessage = video.error?.message || 'Unknown error';

        log.error(`Error ${errorCode}: ${errorMessage}`);

        // Try HLS.js recovery for decode errors
        if (errorCode === 3 && this._hlsPlayer) {
            log.info('Attempting HLS.js media error recovery');
            this._hlsPlayer.recoverMediaError();
            return;
        }

        this.onEvent({ type: 'error', data: { code: errorCode, message: errorMessage } });
    }

    /** @private */
    _onPause() {
        this.onEvent({ type: 'pause' });
    }

    /** @private */
    _onPlay() {
        this.onEvent({ type: 'play' });
    }

    /** @private */
    _onPlaying() {
        if (!this._started) {
            this._started = true;
            log.info('Playback started');
            this.onEvent({ type: 'playbackstart' });
        }
        this.onEvent({ type: 'playing' });
    }

    /** @private */
    _onWaiting() {
        this.onEvent({ type: 'waiting' });
    }

    /** @private */
    _onVolumeChange() {
        if (this._videoElement) {
            MediaHelper.saveVolume(this._videoElement.volume);
        }
        this.onEvent({ type: 'volumechange', data: { volume: this.getVolume() } });
    }

    /** @private */
    _onLoadedMetadata() {
        log.debug('Metadata loaded');
        this.onEvent({ type: 'loadedmetadata', data: { duration: this.getDuration() } });
    }

    // ========================================================================
    // Cleanup
    // ========================================================================

    /**
     * Destroy HLS.js player
     * @private
     */
    _destroyHlsPlayer() {
        if (this._hlsPlayer) {
            try {
                this._hlsPlayer.destroy();
            } catch (e) {
                log.error('Error destroying HLS player:', e);
            }
            this._hlsPlayer = null;
        }
    }

    /**
     * Destroy the player and clean up
     */
    destroy() {
        this.stop();

        if (this._videoElement) {
            this._unbindEvents(this._videoElement);

            if (this._videoElement.parentNode) {
                this._videoElement.parentNode.removeChild(this._videoElement);
            }

            this._videoElement = null;
        }

        // Exit fullscreen if active
        if (Screenfull.isEnabled && Screenfull.isFullscreen) {
            Screenfull.exit();
        }
    }
}
