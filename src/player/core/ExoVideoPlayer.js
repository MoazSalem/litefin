/**
 * ============================================================================
 * Litefin - Media3 ExoPlayer Video Backend
 * ============================================================================
 * Hardware-accelerated native Android video player backend powered by Google
 * Media3 ExoPlayer and Android SurfaceView zero-copy hardware rendering.
 *
 * Designed specifically for Android and Android TV deployments of Litefin:
 * - Decouples 4K / 60 FPS video decoding from Chromium's JavaScript main thread.
 * - Routes bitstreams directly into Android MediaCodec and AudioTrack NDK.
 * - Provides comprehensive Direct Play for MKV, MP4, WebM, and TS containers
 *   containing HEVC (Main/Main10/HDR), AV1, VP9, H.264, and advanced audio codecs
 *   including AC-3, E-AC-3, TrueHD, DTS, DTS-HD, FLAC, and Opus.
 * - Operates seamlessly beneath Litefin's transparent WebView layer while
 *   preserving all OSD controls, subtitles, and gestures.
 *
 * @module core/ExoVideoPlayer
 * ============================================================================
 */

import { logger } from '../../utils/Logger.js';
import { MediaHelper } from './MediaHelper.js';
import { PlayerEvent } from './JellyfinPlayer.js';
import { storage } from '../../utils/StorageService.js';

// Dedicated logger channels
const log = logger.create('ExoVideoPlayer');

// Maximum time in milliseconds to wait for the native player to report playback readiness
// 30 seconds accommodates high-bitrate HEVC/4K network streams resuming deep into files
const STARTUP_TIMEOUT_MS = 30000;

// Minimum seek distance in milliseconds to trigger a native seek
const SEEK_THRESHOLD_MS = 500;

/**
 * Invokes a native command on ExoPlayer via the direct JavaScript interface
 * or through the Tauri v2 Android plugin IPC bridge.
 *
 * @param {string} command - Method identifier
 * @param {Object} [args={}] - Argument payload
 * @returns {Promise<any>}
 */
async function invokeNative(command, args = {}) {
    const isDebug = typeof storage !== 'undefined' && storage.getItem('debug_exoplayer_logs') === 'true';
    if (isDebug) {
        log.info(`[ExoDebug] invokeNative -> ${command}:`, JSON.stringify(args));
    }

    // 1. Direct high-throughput @JavascriptInterface bridge
    if (typeof window !== 'undefined' && window.LitefinExoPlayer) {
        const bridge = window.LitefinExoPlayer;
        if (typeof bridge[command] === 'function') {
            try {
                let res;
                if (command === 'prepare') {
                    const headersJson = args.headers ? JSON.stringify(args.headers) : null;
                    res = bridge.prepare(args.url || '', headersJson, args.startPositionMs || 0);
                } else if (command === 'seek') {
                    res = bridge.seek(args.positionMs || 0);
                } else if (command === 'setPlaybackSpeed') {
                    res = bridge.setPlaybackSpeed(args.speed || 1.0);
                } else if (command === 'setVolume') {
                    res = bridge.setVolume(args.volume ?? 1.0);
                } else if (command === 'selectAudioTrack') {
                    res = bridge.selectAudioTrack(args.trackIndex ?? 0);
                } else {
                    res = bridge[command]();
                }
                if (isDebug) {
                    log.info(`[ExoDebug] Direct bridge ${command} returned:`, res);
                }
                return res;
            } catch (err) {
                log.warn(`Direct bridge invoke failed for ${command}:`, err);
            }
        }
    }

    // 2. Standard Tauri v2 internal IPC bridge
    if (typeof window !== 'undefined' && window.__TAURI_INTERNALS__?.invoke) {
        return window.__TAURI_INTERNALS__.invoke(`plugin:exoplayer|${command}`, args);
    }

    // 3. Fallback to Tauri v2 core API
    if (typeof window !== 'undefined' && window.__TAURI__?.core?.invoke) {
        return window.__TAURI__.core.invoke(`plugin:exoplayer|${command}`, args);
    }

    log.warn(`No native Android bridge available to execute ExoPlayer command: ${command}`);
}

export class ExoVideoPlayer {
    /**
     * @param {Object} options - Initialization options
     * @param {HTMLElement} options.container - DOM container hosting player overlays
     * @param {Object} options.settings - PlayerSettings configuration manager
     * @param {Function} options.onEvent - Callback for normalized player events
     */
    constructor(options) {
        this.container = options.container;
        this.settings = options.settings;
        this.onEvent = options.onEvent || (() => { });

        // Core playback state
        this._currentSrc = null;
        this._currentPlayOptions = null;
        this._started = false;
        this._currentTime = 0;
        this._duration = 0;
        this._bufferedTime = 0;
        this._volume = MediaHelper.getSavedVolume();
        this._playbackSpeed = 1.0;

        // Volume and mute state
        this._isMuted = false;

        // Subtitle synchronization and presentation layout
        this._subtitleOffset = 0;
        this._aspectRatio = 'auto';

        // Active stream tracking
        this._currentAudioIndex = -1;
        this._currentSubtitleIndex = -1;
        this._audioTracks = [];

        // Operational flags
        this._isPaused = false;
        this._isSeeking = false;
        this._isBuffering = false;

        // Startup watchdog timer
        this._startupWatchdogTimer = null;

        // Active polling heartbeat timer (250ms cadence)
        this._pollInterval = null;

        // Bound event listeners for clean unbinding
        this._boundEventHandlers = [];

        // DOM proxy element ensuring OSD and subtitle geometry measurements
        this._proxyElement = null;

        // Register native event bus listeners
        this._initNativeListeners();
    }

    /**
     * ========================================================================
     * Native Event Bus Listener Registration
     * ========================================================================
     * Listens for DOM CustomEvents dispatched from ExoPlayerPlugin.kt.
     * ========================================================================
     * @private
     */
    _initNativeListeners() {
        if (typeof window === 'undefined') return;

        // 1. Playback State Transitions
        const onPlaybackState = (event) => {
            const data = event.detail || {};
            const isDebug = typeof storage !== 'undefined' && storage.getItem('debug_exoplayer_logs') === 'true';
            if (isDebug) {
                log.info('[ExoDebug] Playback state event:', JSON.stringify(data));
            } else {
                log.debug('ExoPlayer state event received:', data);
            }

            if (data.state === 'buffering') {
                this._isBuffering = true;
                this.onEvent({ type: PlayerEvent.WAITING });
            } else if (data.state === 'ready') {
                this._clearStartupWatchdog();
                this._isBuffering = false;

                if (!this._started) {
                    this._started = true;
                    this.onEvent({ type: PlayerEvent.CAN_PLAY });
                    this.onEvent({ type: PlayerEvent.PLAY });
                    this.onEvent({ type: PlayerEvent.PLAYING });
                } else if (!this._isPaused) {
                    this.onEvent({ type: PlayerEvent.PLAYING });
                }
            } else if (data.state === 'ended') {
                this._isBuffering = false;
                this.onEvent({ type: PlayerEvent.ENDED });
            }

            if (typeof data.isPlaying === 'boolean') {
                if (data.isPlaying) {
                    // Actively playing frames — disarm startup deadlock watchdog immediately
                    this._clearStartupWatchdog();
                    if (this._isPaused) {
                        this._isPaused = false;
                        this.onEvent({ type: PlayerEvent.PLAYING });
                    }
                } else if (!this._isPaused && !this._isBuffering) {
                    this._isPaused = true;
                    this.onEvent({ type: PlayerEvent.PAUSE });
                }
            }
        };

        // 2. High-Frequency Time Updates (250ms cadence)
        const onTimeUpdate = (event) => {
            const data = event.detail || {};
            const posMs = data.positionMs || 0;
            const durMs = data.durationMs || 0;
            const bufMs = data.bufferedMs || 0;

            const isDebug = typeof storage !== 'undefined' && storage.getItem('debug_exoplayer_logs') === 'true';
            if (isDebug && Math.floor(posMs / 1000) % 5 === 0) {
                log.info(`[ExoDebug] Time update: ${posMs}ms / ${durMs}ms (buffered: ${bufMs}ms)`);
            }

            this._currentTime = posMs / 1000;
            if (durMs > 0) {
                this._duration = durMs / 1000;
            }
            this._bufferedTime = bufMs / 1000;

            // Media data is arriving or advancing — disarm startup timer
            if (posMs > 0 || bufMs > 0) {
                this._clearStartupWatchdog();
            }

            // -----------------------------------------------------------------
            // Startup & Buffering Progress Guard
            // -----------------------------------------------------------------
            // Suppress dispatching timeupdate events to the higher layers (JellyfinPlayer)
            // while the media pipeline is still buffering or has not presented frames.
            // Dispatching premature time updates during initial resume seeks causes the
            // loading screen to dismiss prematurely before the video frame renders.
            // -----------------------------------------------------------------
            if (!this._started || this._isBuffering) {
                return;
            }

            // Normalize and dispatch to Jellyfin player event pipeline
            this.onEvent({
                type: PlayerEvent.TIME_UPDATE,
                data: {
                    time: this._currentTime,
                    currentTime: this._currentTime,
                    duration: this._duration,
                    positionTicks: Math.round(posMs * 10000),
                    bufferedTime: this._bufferedTime
                }
            });
        };

        // 3. Audio & Video Track Discovery
        const onTracksChanged = (event) => {
            const data = event.detail || {};
            if (Array.isArray(data.videoTracks)) {
                for (const vt of data.videoTracks) {
                    log.info(`[ExoDebug] Video track [${vt.index}]: mime=${vt.mimeType || 'unknown'}, ${vt.width}x${vt.height}, supported=${vt.isSupported}, selected=${vt.isSelected}`);
                }
            }
            if (Array.isArray(data.audioTracks)) {
                this._audioTracks = data.audioTracks;
                log.info(`Discovered ${data.audioTracks.length} native audio tracks via ExoPlayer`);

                // -------------------------------------------------------------
                // Target Audio Track Verification & Enforcement
                // -------------------------------------------------------------
                // If a specific 0-based audio track index was requested prior to
                // container demuxing, check if the currently selected native track
                // aligns with it. If not, re-assert the selection immediately.
                if (typeof this._currentAudioIndex === 'number' && this._currentAudioIndex >= 0) {
                    const activeTrack = data.audioTracks.find((t) => t.isSelected);
                    if (!activeTrack || activeTrack.index !== this._currentAudioIndex) {
                        log.info(`[ExoPlayer] Re-applying target audio track index ${this._currentAudioIndex} after tracks discovery`);
                        invokeNative('selectAudioTrack', { trackIndex: this._currentAudioIndex }).catch((err) => {
                            log.warn('[ExoPlayer] Failed to re-apply target audio track:', err);
                        });
                    }
                }

                this.onEvent({
                    type: PlayerEvent.MEDIA_STREAMS_CHANGE,
                    data: { audioTracks: this._audioTracks }
                });
            }
        };

        // 4. Video Dimensions & Aspect Ratio
        const onVideoSize = (event) => {
            const data = event.detail || {};
            this._videoWidth = data.width || 0;
            this._videoHeight = data.height || 0;
            log.info(`ExoPlayer native video dimensions: ${data.width}x${data.height}`);
        };

        // 5. Playback Errors
        const onError = (event) => {
            const data = event.detail || {};
            this._clearStartupWatchdog();
            log.error('ExoPlayer native error:', data);
            this.onEvent({
                type: PlayerEvent.ERROR,
                data: {
                    error: data.message || 'ExoPlayer playback failure',
                    code: data.errorCode || 0
                }
            });
        };

        // 6. First Decoded Frame Presentation Event
        const onFirstFrame = () => {
            log.info('ExoPlayer first frame presented on display');
            this._clearStartupWatchdog();
            this._isBuffering = false;
            if (!this._started) {
                this._started = true;
                this.onEvent({ type: PlayerEvent.CAN_PLAY });
                this.onEvent({ type: PlayerEvent.PLAY });
                this.onEvent({ type: PlayerEvent.PLAYING });
            }
        };

        // Attach listeners to window
        window.addEventListener('exoplayer://playback-state', onPlaybackState);
        window.addEventListener('exoplayer://time-update', onTimeUpdate);
        window.addEventListener('exoplayer://tracks-changed', onTracksChanged);
        window.addEventListener('exoplayer://video-size', onVideoSize);
        window.addEventListener('exoplayer://error', onError);
        window.addEventListener('exoplayer://first-frame', onFirstFrame);

        // Retain unbind handles
        this._boundEventHandlers.push(
            { name: 'exoplayer://playback-state', handler: onPlaybackState },
            { name: 'exoplayer://time-update', handler: onTimeUpdate },
            { name: 'exoplayer://tracks-changed', handler: onTracksChanged },
            { name: 'exoplayer://video-size', handler: onVideoSize },
            { name: 'exoplayer://error', handler: onError },
            { name: 'exoplayer://first-frame', handler: onFirstFrame }
        );
    }

    /**
     * Unregisters all native DOM event listeners.
     * @private
     */
    _removeNativeListeners() {
        if (typeof window === 'undefined') return;
        for (const item of this._boundEventHandlers) {
            window.removeEventListener(item.name, item.handler);
        }
        this._boundEventHandlers = [];
    }

    /**
     * ========================================================================
     * DOM Proxy Element
     * ========================================================================
     * Generates a transparent placeholder element inside the player container.
     * Allows OSDController and SubtitleManager to compute coordinate bounding
     * boxes without needing a real <video> element.
     * ========================================================================
     * @returns {HTMLElement}
     */
    getVideoElement() {
        if (this._proxyElement && this._proxyElement.isConnected) {
            return this._proxyElement;
        }

        // Create virtual video placeholder
        const proxy = document.createElement('div');
        proxy.className = 'jellyfin-video-player exoplayer-surface-proxy';
        proxy.style.position = 'absolute';
        proxy.style.top = '0';
        proxy.style.left = '0';
        proxy.style.width = '100%';
        proxy.style.height = '100%';
        proxy.style.pointerEvents = 'none';
        proxy.style.backgroundColor = 'transparent';

        if (this.container) {
            this.container.appendChild(proxy);
        }

        this._proxyElement = proxy;
        return proxy;
    }

    /**
     * ========================================================================
     * Playback Control Pipeline
     * ========================================================================
     */

    /**
     * Initiates media playback with the requested stream parameters.
     *
     * @param {Object} options - Playback parameters
     * @param {string} options.url - Media stream endpoint URL
     * @param {number} [options.resumePositionTicks=0] - Starting timestamp in ticks
     * @param {number} [options.audioStreamIndex] - Initial audio stream index
     * @param {Object} [options.headers] - Custom HTTP request headers
     * @returns {Promise<void>}
     */
    async play(options) {
        log.info('ExoVideoPlayer.play() called with URL:', options?.url);
        this._currentPlayOptions = options;
        this._currentSrc = options?.url;
        this._started = false;
        this._isPaused = false;

        // Notify UI that stream load has started
        this.onEvent({ type: PlayerEvent.LOAD_START });

        // Calculate resume position in milliseconds
        // Support startPositionTicks (standard streamInfo) with fallback to resumePositionTicks
        const resumeTicks = options?.startPositionTicks || options?.resumePositionTicks || 0;
        const resumeMs = Math.round(resumeTicks / 10000);
        log.info(`ExoVideoPlayer.play: target resumeTicks=${resumeTicks} (${resumeMs}ms)`);

        // Arm startup deadlock watchdog
        this._armStartupWatchdog();

        // 1. Prepare ExoPlayer hardware pipeline
        await invokeNative('prepare', {
            url: options.url,
            headers: options.headers || {},
            startPositionMs: resumeMs
        });

        // 2. Apply initial volume setting and aspect ratio mode
        await this.setVolume(this._volume * 100);
        this.setAspectRatio(this._aspectRatio || 'auto');

        // ---------------------------------------------------------------------
        // 3. Switch Audio Stream If Explicitly Specified
        // ---------------------------------------------------------------------
        // JellyfinPlayer calculates audioTrackListIndex (0-based container track index).
        // Fall back to mapping options.audioStreamIndex against MediaStreams if needed.
        if (typeof options.audioTrackListIndex === 'number' && options.audioTrackListIndex >= 0) {
            this._currentAudioIndex = options.audioTrackListIndex;
        } else if (typeof options.audioStreamIndex === 'number' && options.mediaSource?.MediaStreams) {
            const audioStreams = options.mediaSource.MediaStreams.filter((s) => s.Type === 'Audio');
            const foundIndex = audioStreams.findIndex((s) => s.Index === options.audioStreamIndex);
            this._currentAudioIndex = foundIndex >= 0 ? foundIndex : 0;
        } else if (typeof options.audioStreamIndex === 'number' && options.audioStreamIndex >= 0) {
            this._currentAudioIndex = options.audioStreamIndex;
        }

        if (typeof this._currentAudioIndex === 'number' && this._currentAudioIndex >= 0) {
            log.info(`ExoVideoPlayer.play: Queuing initial audio track index ${this._currentAudioIndex}`);
            await invokeNative('selectAudioTrack', { trackIndex: this._currentAudioIndex });
        }

        // 4. Trigger playback
        await invokeNative('play');

        // 5. Start active polling heartbeat as failsafe
        this._startPollingLoop();
    }

    /**
     * Pauses video playback.
     * @returns {Promise<void>}
     */
    async pause() {
        log.debug('ExoVideoPlayer.pause()');
        this._isPaused = true;
        await invokeNative('pause');
        this.onEvent({ type: PlayerEvent.PAUSE });
    }

    /**
     * Resumes video playback.
     * @returns {Promise<void>}
     */
    async unpause() {
        log.debug('ExoVideoPlayer.unpause()');
        this._isPaused = false;
        await invokeNative('play');
        this.onEvent({ type: PlayerEvent.PLAY });
        this.onEvent({ type: PlayerEvent.PLAYING });
    }

    /**
     * Stops video playback and hides the native surface plane.
     * @returns {Promise<void>}
     */
    async stop() {
        log.info('ExoVideoPlayer.stop() called');
        this._clearStartupWatchdog();
        this._stopPollingLoop();
        this._started = false;
        this._isPaused = true;

        await invokeNative('stop');
        this.onEvent({ type: PlayerEvent.STOP });
    }

    /**
     * Seeks to the specified position in 100ns ticks.
     *
     * @param {number} positionTicks - Target position in ticks
     * @param {Object} [options] - Optional seek parameters
     * @returns {Promise<void>}
     */
    async seek(positionTicks, options = {}) {
        const targetSeconds = positionTicks / 10000000;
        const targetMs = Math.round(positionTicks / 10000);
        const currentSeconds = this._currentTime || 0;
        const diffMs = Math.abs(targetSeconds - currentSeconds) * 1000;

        // Skip micro-seeks below threshold if already playing
        if (diffMs < SEEK_THRESHOLD_MS && this._started) {
            log.debug(`ExoVideoPlayer.seek: delta below threshold (${diffMs.toFixed(0)}ms) — skipping`);
            return;
        }

        log.info(`ExoVideoPlayer.seek to ${targetSeconds.toFixed(2)}s`);
        this._isSeeking = true;
        this.onEvent({ type: PlayerEvent.SEEK });

        // Invoke native seek on ExoPlayer
        await invokeNative('seek', { positionMs: targetMs });

        this._currentTime = targetSeconds;
        this._isSeeking = false;
        this.onEvent({ type: PlayerEvent.SEEKED });

        // Dispatch authoritative timeupdate immediately following seek completion
        // Ensures OSD seekbar, timeline, and SubtitleManager instantly reflect landed position
        this.onEvent({
            type: PlayerEvent.TIME_UPDATE,
            data: {
                time: targetSeconds,
                currentTime: targetSeconds,
                duration: this._duration,
                positionTicks: Math.round(positionTicks),
                bufferedTime: this._bufferedTime
            }
        });
    }

    /**
     * Adjusts playback rate.
     *
     * @param {number} speed - Playback speed multiplier (e.g. 1.0, 1.25, 1.5)
     * @returns {Promise<void>}
     */
    async setPlaybackSpeed(speed) {
        log.info(`ExoVideoPlayer: Setting playback speed to ${speed}x`);
        this._playbackSpeed = speed;
        await invokeNative('setPlaybackSpeed', { speed });
    }

    /**
     * Adjusts player volume.
     *
     * @param {number} volume - Volume level on a 0 to 100 scale
     * @returns {Promise<void>}
     */
    async setVolume(volume) {
        // Clamp volume level within legitimate audio boundaries
        const clamped = Math.max(0, Math.min(100, volume));
        this._volume = clamped / 100;

        // If volume is raised above zero, clear active mute state
        if (this._volume > 0 && this._isMuted) {
            this._isMuted = false;
        }

        // Store volume in persistent application settings
        MediaHelper.saveVolume(this._volume);

        // Forward volume to native Media3 player instance
        const effectiveVol = this._isMuted ? 0 : this._volume;
        await invokeNative('setVolume', { volume: effectiveVol });

        // Notify UI and Jellyfin state machine of volume adjustment
        this.onEvent({ type: PlayerEvent.VOLUME_CHANGE });
    }

    /**
     * Returns the current volume level on a 0 to 100 scale.
     * @returns {number} Current volume (0-100)
     */
    getVolume() {
        return Math.round(this._volume * 100);
    }

    /**
     * Checks if audio output is currently muted.
     * @returns {boolean} True if explicitly muted or volume is zero
     */
    isMuted() {
        return this._isMuted || this._volume === 0;
    }

    /**
     * Explicitly sets mute state.
     * @param {boolean} muted - Target mute state
     * @returns {Promise<void>}
     */
    async setMuted(muted) {
        // Update local mute flag
        this._isMuted = Boolean(muted);

        // Calculate target volume for native pipeline
        const effectiveVol = this._isMuted ? 0 : this._volume;
        await invokeNative('setVolume', { volume: effectiveVol });

        // Dispatch volume change event to notify OSD
        this.onEvent({ type: PlayerEvent.VOLUME_CHANGE });
    }

    /**
     * Toggles mute state.
     * @returns {Promise<void>}
     */
    async toggleMute() {
        await this.setMuted(!this.isMuted());
    }

    /**
     * Selects an audio stream by index without requiring server-side remuxing.
     *
     * @param {number} index - Desired audio track index
     * @returns {Promise<void>}
     */
    async setAudioStreamIndex(index) {
        log.info(`ExoVideoPlayer: Switching audio track to index ${index}`);
        this._currentAudioIndex = index;
        await invokeNative('selectAudioTrack', { trackIndex: index });
    }

    /**
     * Selects a subtitle stream index.
     *
     * @param {number} index - Desired subtitle track index
     * @returns {Promise<void>}
     */
    async setSubtitleStreamIndex(index) {
        log.info(`ExoVideoPlayer: Subtitle index updated to ${index}`);
        this._currentSubtitleIndex = index;
    }

    /**
     * Informs JellyfinPlayer that ExoPlayer natively supports track switching.
     * @returns {boolean} Always true for ExoPlayer
     */
    supportsNativeAudioTracks() {
        return true;
    }

    /**
     * Returns audio tracks discovered natively by ExoPlayer.
     * @returns {Array} Array of native audio track objects
     */
    getAudioTracks() {
        return this._audioTracks || [];
    }

    /**
     * Cleans up resources, detaches listeners, and terminates the native player.
     * @returns {Promise<void>}
     */
    async destroy() {
        log.info('ExoVideoPlayer.destroy() called');
        this._clearStartupWatchdog();
        this._stopPollingLoop();
        this._removeNativeListeners();

        try {
            await invokeNative('destroy');
        } catch (err) {
            log.error('ExoVideoPlayer: Error during destroy invoke:', err);
        }

        if (this._proxyElement && this._proxyElement.parentNode) {
            this._proxyElement.parentNode.removeChild(this._proxyElement);
            this._proxyElement = null;
        }

        this.onEvent = () => { };
    }

    // ========================================================================
    // Internal Watchdog Utilities
    // ========================================================================

    /**
     * Arms the startup watchdog timer to detect hung hardware decoders.
     * @private
     */
    _armStartupWatchdog() {
        this._clearStartupWatchdog();
        this._startupWatchdogTimer = setTimeout(() => {
            log.error(`ExoVideoPlayer: Playback startup timed out after ${STARTUP_TIMEOUT_MS}ms`);
            this.onEvent({
                type: PlayerEvent.ERROR,
                data: { error: 'ExoPlayer startup timeout' }
            });
        }, STARTUP_TIMEOUT_MS);
    }

    /**
     * Clears the startup watchdog timer.
     * @private
     */
    _clearStartupWatchdog() {
        if (this._startupWatchdogTimer) {
            clearTimeout(this._startupWatchdogTimer);
            this._startupWatchdogTimer = null;
        }
    }

    /**
     * Starts continuous 250ms polling loop as an active heartbeat.
     * Ensures OSD and Jellyfin progress never stall even if WebView CustomEvents are delayed.
     * @private
     */
    _startPollingLoop() {
        this._stopPollingLoop();
        this._pollInterval = setInterval(() => {
            if (typeof window === 'undefined' || !window.LitefinExoPlayer) return;
            try {
                const bridge = window.LitefinExoPlayer;
                const posMs = bridge.getCurrentPositionMs ? bridge.getCurrentPositionMs() : 0;
                const durMs = bridge.getDurationMs ? bridge.getDurationMs() : 0;

                if (posMs > 0) {
                    this._currentTime = posMs / 1000;
                }
                if (durMs > 0) {
                    this._duration = durMs / 1000;
                }

                // Forward timeupdate only if playback has started, is not paused, and is not buffering
                // This prevents the polling loop from falsely reporting active playback during initial seek buffer
                if (posMs > 0 && !this._isPaused && !this._isBuffering && this._started) {
                    this.onEvent({
                        type: PlayerEvent.TIME_UPDATE,
                        data: {
                            time: this._currentTime,
                            currentTime: this._currentTime,
                            duration: this._duration,
                            positionTicks: Math.round(posMs * 10000),
                            bufferedTime: this._bufferedTime
                        }
                    });
                }
            } catch (_) { }
        }, 250);
    }

    /**
     * Halts polling heartbeat.
     * @private
     */
    _stopPollingLoop() {
        if (this._pollInterval) {
            clearInterval(this._pollInterval);
            this._pollInterval = null;
        }
    }

    // ========================================================================
    // State Query Methods & Properties
    // ========================================================================

    /**
     * Returns the current playback position in seconds.
     * Essential for JellyfinPlayer.getCurrentPositionTicks and OSD slider tracking.
     * @returns {number} Current position in seconds
     */
    getCurrentTime() {
        if (typeof window !== 'undefined' && window.LitefinExoPlayer?.getCurrentPositionMs) {
            try {
                const posMs = window.LitefinExoPlayer.getCurrentPositionMs();
                if (posMs > 0) {
                    this._currentTime = posMs / 1000;
                }
            } catch (_) { }
        }
        return this._currentTime || 0;
    }

    /**
     * Returns the total media duration in seconds.
     * @returns {number} Duration in seconds
     */
    getDuration() {
        if (typeof window !== 'undefined' && window.LitefinExoPlayer?.getDurationMs) {
            try {
                const durMs = window.LitefinExoPlayer.getDurationMs();
                if (durMs > 0) {
                    this._duration = durMs / 1000;
                }
            } catch (_) { }
        }
        return this._duration || 0;
    }

    /**
     * Returns the buffered time range in seconds.
     * @returns {number} Buffered time in seconds
     */
    getBufferedTime() {
        return this._bufferedTime || 0;
    }

    /**
     * Returns true if playback is currently paused.
     * @returns {boolean}
     */
    isPaused() {
        return this._isPaused;
    }

    /**
     * Returns true if playback is actively progressing.
     * @returns {boolean}
     */
    isPlaying() {
        return !this._isPaused && this._started && !this._isBuffering;
    }

    /**
     * Returns true if the hardware decoder pipeline is actively buffering stream data.
     * Consulted by JellyfinPlayer to prevent premature dismissal of loading screens during resume seeks.
     * @returns {boolean}
     */
    isBuffering() {
        return this._isBuffering;
    }

    /**
     * Returns current playback rate multiplier.
     * @returns {number}
     */
    getPlaybackRate() {
        return this._playbackSpeed || 1.0;
    }

    /**
     * Returns current playback rate multiplier (alias for getPlaybackRate).
     * @returns {number}
     */
    getSpeed() {
        return this._playbackSpeed || 1.0;
    }

    /**
     * Sets playback speed multiplier (alias for setPlaybackSpeed).
     * @param {number} speed - Multiplier (e.g. 1.0, 1.25, 1.5)
     * @returns {Promise<void>}
     */
    async setSpeed(speed) {
        return this.setPlaybackSpeed(speed);
    }

    /**
     * Stores subtitle synchronization offset in seconds.
     * @param {number} seconds - Offset in seconds
     */
    setSubtitleOffset(seconds) {
        this._subtitleOffset = seconds || 0;
    }

    /**
     * Retrieves the active aspect ratio mode ('auto', 'zoom', 'stretch').
     * @returns {string}
     */
    getAspectRatio() {
        return this._aspectRatio || 'auto';
    }

    /**
     * Sets presentation aspect ratio mode.
     * Forwards directly to native Media3 AspectRatioFrameLayout.
     * @param {string} mode - 'auto' | 'zoom' | 'stretch'
     */
    setAspectRatio(mode) {
        this._aspectRatio = mode || 'auto';
        if (typeof window !== 'undefined' && window.LitefinExoPlayer?.setAspectRatio) {
            window.LitefinExoPlayer.setAspectRatio(this._aspectRatio);
        } else if (typeof window !== 'undefined' && window.LitefinAndroid?.setAspectRatio) {
            window.LitefinAndroid.setAspectRatio(this._aspectRatio);
        } else {
            invokeNative('setAspectRatio', { mode: this._aspectRatio }).catch(() => { });
        }
    }

    // ========================================================================
    // Property Getters (ECMAScript Property Accessors)
    // ========================================================================

    get currentTime() {
        return this._currentTime;
    }

    get duration() {
        return this._duration;
    }

    get paused() {
        return this._isPaused;
    }

    get isSeeking() {
        return this._isSeeking;
    }

    get playbackRate() {
        return this._playbackSpeed;
    }

    get videoWidth() {
        return this._videoWidth || 0;
    }

    get videoHeight() {
        return this._videoHeight || 0;
    }
}
