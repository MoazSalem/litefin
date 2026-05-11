/**
 * ============================================================================
 * Litefin - WebOS Luna Native Player Backend
 * ============================================================================
 * This backend delegates video playback entirely to the LG webOS built-in
 * media player app (com.webos.app.photovideo / mediadiscovery) using the
 * Luna service API.
 * 
 * IMPORTANT: This is a "fire-and-forget" backend. Once the native app launches,
 * Litefin goes into the background. We have no real-time control over playback,
 * no OSD overlay, and no progress reporting while the native app is active.
 * Playback stops when the user exits the native app and Litefin returns to focus.
 * ============================================================================
 */

import { logger } from '../../utils/Logger.js';
import { webosAdapter } from '../../webos/WebOSAdapter.js';
import { MediaHelper } from './MediaHelper.js';
import { platformInfo } from '../../utils/PlatformInfo.js';

const log = logger.create('WebOSLunaPlayer');

export class WebOSLunaPlayer {
    /**
     * @param {Object} options
     * @param {HTMLElement} options.container - The DOM element to attach to (unused for this backend)
     * @param {Function} options.onEvent - Callback for player events
     * @param {Object} options.settings - Player configuration settings
     */
    constructor(options) {
        log.info('Initializing WebOSLunaPlayer Backend');
        this._onEvent = options.onEvent;
        this._settings = options.settings;
        this._state = {
            currentTime: 0,
            duration: 0,
            paused: true,
            muted: false,
            volume: 100,
            playbackRate: 1.0
        };

        this._visibilityHandler = this._handleVisibilityChange.bind(this);
        this._nativeAppLaunched = false;
        
        // Wait a short moment before emitting ready to allow UI to setup
        setTimeout(() => {
            this._emit('ready', {});
        }, 50);
    }

    /**
     * Helper to emit events to the player core
     */
    _emit(type, data = {}) {
        if (typeof this._onEvent === 'function') {
            this._onEvent({ type, ...data });
        }
    }

    /**
     * Get the appropriate system media player app ID based on webOS version
     * @returns {string} App ID
     */
    _getNativeAppId() {
        // We can infer version from UA or webosAdapter.deviceInfo if populated.
        // For safety, let's parse from UA since it's immediately available.
        const ua = navigator.userAgent;
        let majorVersion = 0;
        
        // Match "Web0S" or "WebOS" followed by version or check Tizen-style strings
        const webosMatch = ua.match(/(?:Web0S|WebOS).*?(\d+)\./i);
        if (webosMatch && webosMatch[1]) {
            majorVersion = parseInt(webosMatch[1], 10);
        } else if (webosAdapter._deviceInfo && webosAdapter._deviceInfo.sdkVersion) {
            majorVersion = parseInt(webosAdapter._deviceInfo.sdkVersion.split('.')[0], 10);
        }
        
        if (majorVersion >= 6) {
            return 'com.webos.app.mediadiscovery';
        } else if (majorVersion >= 3 && majorVersion <= 5) {
            return 'com.webos.app.photovideo';
        } else if (majorVersion >= 1 && majorVersion <= 2) {
            return 'com.webos.app.smartshare';
        }
        
        // Fallback to photovideo which covers the vast majority of active legacy TVs
        return 'com.webos.app.photovideo';
    }

    /**
     * Handles app returning to foreground (user closed the native player)
     */
    _handleVisibilityChange() {
        if (!document.hidden && this._nativeAppLaunched) {
            log.info('App returned to foreground. Assuming native player exited.');
            this._nativeAppLaunched = false;
            document.removeEventListener('visibilitychange', this._visibilityHandler);
            
            // Emit ended so JellyfinPlayer tears down the session
            this._emit('ended');
        }
    }

    /**
     * Start playback
     * @param {Object} options Playback options
     * @returns {Promise<void>}
     */
    async play(options) {
        log.info('play() called with options:', options);

        if (!platformInfo.isWebOS) {
            log.warn('Attempted to launch WebOS Native player on non-WebOS platform. Aborting.');
            this._emit('error', { type: 'NotSupportedError', message: 'Not a WebOS device' });
            return;
        }

        try {
            // Resolve stream URL using MediaHelper
            const mediaSource = options.mediaSource;
            const streamInfo = MediaHelper.buildStreamUrl({
                serverUrl: options.serverUrl,
                itemId: options.itemId,
                mediaSource: mediaSource,
                startPositionTicks: options.startPositionTicks,
                playSessionId: options.playSessionId,
                authToken: options.authToken,
                audioStreamIndex: options.audioStreamIndex
            });

            log.info('Resolved stream info:', streamInfo);

            const startPositionSeconds = Math.floor((options.startPositionTicks || 0) / 10000000);
            
            // Try to extract a clean filename for the native player to use for resume indexing
            // If it's a TV show, provide a unique-enough name. Otherwise use item ID as fallback.
            let fileName = options.item?.Name || 'Jellyfin Video';
            if (options.item?.SeriesName) {
                const s = options.item.ParentIndexNumber ? `S${options.item.ParentIndexNumber.toString().padStart(2, '0')}` : '';
                const e = options.item.IndexNumber ? `E${options.item.IndexNumber.toString().padStart(2, '0')}` : '';
                fileName = `${options.item.SeriesName} ${s}${e} - ${options.item.Name}`;
            } else if (mediaSource && mediaSource.Name) {
                fileName = mediaSource.Name;
            }

            const payload = {
                fullPath: streamInfo.url,
                fileName: fileName,
                mediaType: 'VIDEO',
                // webOS native player checks this for resume
                lastPlayPosition: startPositionSeconds > 0 ? startPositionSeconds : 0
            };

            const appId = this._getNativeAppId();
            
            log.info(`Launching native app [${appId}] with payload:`, payload);

            // Need to use the window.webOS object directly as it has the service.request
            if (typeof window.webOS !== 'undefined' && window.webOS.service && window.webOS.service.request) {
                window.webOS.service.request('luna://com.webos.applicationManager', {
                    method: 'launch',
                    parameters: {
                        id: appId,
                        params: {
                            payload: [payload]
                        }
                    },
                    onSuccess: (res) => {
                        log.info('Native player launch successful', res);
                        this._state.paused = false;
                        this._state.currentTime = streamInfo.playerStartPositionTicks || 0;
                        this._nativeAppLaunched = true;
                        
                        // Listen for return from background
                        document.addEventListener('visibilitychange', this._visibilityHandler);
                        
                        // Signal that playback "started" so progress reporting kicks in
                        // (It will only report start, as we can't get updates while backgrounded)
                        this._emit('playing');
                    },
                    onFailure: (err) => {
                        log.error('Failed to launch native player', err);
                        this._emit('error', { type: 'LunaServiceError', message: 'Failed to launch native player', details: err });
                    }
                });
            } else {
                throw new Error('window.webOS.service.request is not available');
            }

        } catch (error) {
            log.error('Playback failed to initialize', error);
            this._emit('error', { type: 'PlaybackStartError', message: error.message });
        }
    }

    /**
     * Stop playback
     */
    stop() {
        log.info('stop() called');
        this._state.paused = true;
        if (this._nativeAppLaunched) {
            this._nativeAppLaunched = false;
            document.removeEventListener('visibilitychange', this._visibilityHandler);
        }
        
        // We cannot forcefully kill the external app cleanly via standard Luna without root, 
        // but if stop() is called, it means our app is trying to tear down.
        this._emit('ended');
    }

    /**
     * Destroy the player instance
     */
    destroy() {
        log.info('destroy() called');
        this.stop();
    }

    // ========================================================================
    // Unsupported / Best-Effort API Methods
    // ========================================================================

    pause() {
        log.warn('pause() called, but native player is external. Ignoring.');
    }

    unpause() {
        log.warn('unpause() called, but native player is external. Ignoring.');
    }

    seek(positionTicks) {
        log.warn('seek() called, but native player is external. Ignoring.');
    }

    setVolume(vol) {
        log.warn('setVolume() called, but native player is external. Ignoring.');
    }

    getVolume() {
        return this._state.volume;
    }

    setMuted(muted) {
        log.warn('setMuted() called, but native player is external. Ignoring.');
    }

    isMuted() {
        return this._state.muted;
    }

    toggleMute() {
        this.setMuted(!this._state.muted);
    }

    setPlaybackRate(rate) {
        log.warn('setPlaybackRate() called, but native player is external. Ignoring.');
    }

    getPlaybackRate() {
        return this._state.playbackRate;
    }

    setAudioStreamIndex(index) {
        log.warn('setAudioStreamIndex() called, but native player is external. Ignoring.');
    }

    setSubtitleStreamIndex(index) {
        log.warn('setSubtitleStreamIndex() called, but native player is external. Ignoring.');
    }

    setSubtitleStyle(style) {
        // Native player handles its own subtitles
    }

    supportsNativeAudioTracks() {
        return false; // Prevent JellyfinPlayer from trying to handle tracks
    }

    getCurrentTime() {
        return this._state.currentTime; // Static, last known
    }

    getDuration() {
        return this._state.duration;
    }

    isPaused() {
        return this._state.paused;
    }

    getBufferedRanges() {
        return [];
    }

    getVideoElement() {
        return null;
    }

    setAspectRatio(ratio) {
        // Handled by native app
    }

    toggleFullscreen() {
        // Native app is always fullscreen
    }

    isFullscreen() {
        return true;
    }
}

export default WebOSLunaPlayer;
