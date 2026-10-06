/**
 * ============================================================================
 * Litefin - Movi Video Player Backend
 * ============================================================================
 * Hardware-accelerated and container-agnostic video player backend powered by
 * movi-player (FFmpeg libavformat WebAssembly demuxer + WebCodecs API + WebGL2).
 *
 * Designed primarily for desktop releases of Litefin (Windows, macOS, Linux),
 * enabling native Direct Play of MKV, MP4, and WebM containers with HEVC, AV1,
 * VP9, H.264 video, and multi-channel AC-3, E-AC-3, TrueHD, DTS, Opus, and FLAC
 * audio without requiring server-side transcoding or remuxing.
 *
 * Architecture & Integration:
 * - Implements the identical backend interface as HtmlVideoPlayer & TizenAVPlayer.
 * - Wraps the <movi-player> custom element with controls disabled, delegating
 *   all UI and user interaction to Litefin's native OSDController.
 * - Synchronizes audio track switching directly within the WASM demuxer.
 * - Bridges stream events into Litefin's PlayerEvent bus for SubtitleManager,
 *   TrickplayManager, and server progress reporting.
 *
 * @module core/MoviVideoPlayer
 * ============================================================================
 */

import { logger } from '../../utils/Logger.js';
import { MediaHelper } from './MediaHelper.js';
import { PlayerEvent } from './JellyfinPlayer.js';
import { PlayerSettings } from '../../utils/PlayerSettings.js';
import { platformInfo } from '../../utils/PlatformInfo.js';

const log = logger.create('MoviVideoPlayer');

// Minimum seek difference in milliseconds to trigger a hardware seek
const SEEK_THRESHOLD_MS = 1000;

// ============================================================================
// Movi Video Player Backend Class
// ============================================================================

export class MoviVideoPlayer {
    /**
     * @param {Object} options - Initialization options
     * @param {HTMLElement} options.container - DOM container hosting video elements
     * @param {Object} options.settings - PlayerSettings configuration manager
     * @param {Function} options.onEvent - Callback for normalized player events ({ type, data })
     */
    constructor(options) {
        this.container = options.container;
        this.settings = options.settings;
        this.onEvent = options.onEvent || (() => {});

        // Core player DOM elements and state
        this._moviElement = null;
        this._videoElement = null;
        this._currentSrc = null;
        this._currentPlayOptions = null;
        this._started = false;
        this._timeUpdated = false;
        this._startPositionTicks = 0;

        // Active track indexes
        this._currentAudioIndex = -1;
        this._currentSubtitleIndex = -1;
        this._subtitleOffset = 0;

        // Playback state tracking
        this._isPaused = false;
        this._isSeeking = false;
        this._lastTimeUpdateTicks = 0;

        // Bound event handler map for clean teardown and unbinding
        this._boundHandlers = {};

        // Module loading state
        this._isLoaded = false;
    }

    // ========================================================================
    // Module and Custom Element Initialization
    // ========================================================================

    /**
     * Ensures the movi-player web component bundle is registered in the DOM.
     * Uses dynamic import to allow smooth fallbacks on non-WASM runtimes.
     *
     * @private
     * @returns {Promise<boolean>} True if element is registered and ready.
     */
    async _ensureMoviRegistered() {
        if (typeof window === 'undefined') {
            return false;
        }

        // Check if the custom element is already registered
        if (window.customElements && window.customElements.get('movi-player')) {
            this._isLoaded = true;
            return true;
        }

        try {
            // Log entry into web component dynamic import
            log.info('Dynamically registering movi-player web component...');

            /*
             * -----------------------------------------------------------------
             * Bundle Web Component Registration
             * -----------------------------------------------------------------
             * Importing the root 'movi-player' bundle executes element.ts which
             * registers the custom HTML element <movi-player> with the browser's
             * CustomElementRegistry. Webpack bundles this into a dedicated chunk.
             * -----------------------------------------------------------------
             */
            await import(/* webpackChunkName: "movi-player" */ 'movi-player');

            // Mark module as successfully loaded
            this._isLoaded = true;
            log.info('movi-player web component registered successfully');
            return true;
        } catch (err) {
            // Log registration failure if module cannot be found or loaded
            log.error('Failed to register movi-player custom element:', err);
            return false;
        }
    }

    /**
     * Create or retrieve the <movi-player> custom element.
     *
     * @private
     * @returns {HTMLElement} The <movi-player> DOM element
     */
    _ensurePlayerElement() {
        if (this._moviElement) {
            // Re-bind events if they were unbound during stop()
            if (Object.keys(this._boundHandlers).length === 0) {
                this._bindEvents(this._moviElement);
            }
            return this._moviElement;
        }

        // Instantiate the custom element
        const element = document.createElement('movi-player');
        element.className = 'jellyfin-video-player movi-player-container';

        // Configure presentation attributes
        // Disable built-in controls so Litefin's native OSD handles all UI
        element.removeAttribute('controls');
        element.setAttribute('objectfit', 'contain');
        element.setAttribute('playsinline', 'true');

        /*
         * -----------------------------------------------------------------
         * Local WebAssembly Binary & Autoplay Configuration
         * -----------------------------------------------------------------
         * Point the engine directly to the bundled movi.wasm copied by Webpack
         * to avoid external CDN resolution in offline / desktop runtimes.
         * Default to autoplay enabled so the WASM engine kicks off immediately.
         * -----------------------------------------------------------------
         */
        element.setAttribute('wasmurl', 'wasm/movi.wasm');
        element.setAttribute('autoplay', '');
        element.autoplay = true;

        // Apply saved system volume
        const savedVol = MediaHelper.getSavedVolume();
        element.volume = typeof savedVol === 'number' ? savedVol : 1.0;

        // Ensure parent container exists
        if (!this.container) {
            this.container = document.createElement('div');
            this.container.className = 'jellyfin-player-container';
            document.body.appendChild(this.container);
        }

        this.container.appendChild(element);
        this._moviElement = element;
        this._videoElement = element;

        // Bind DOM events to normalized Litefin events
        this._bindEvents(element);

        return element;
    }

    /**
     * Bind media events from the <movi-player> element to Litefin handlers.
     *
     * @private
     * @param {HTMLElement} element - The <movi-player> element
     */
    _bindEvents(element) {
        this._unbindEvents();

        const handlers = {
            loadstart: () => {
                log.debug('movi-player: loadstart');
                this.onEvent({ type: PlayerEvent.LOAD_START });
            },

            loadedmetadata: () => {
                log.info(`movi-player: loadedmetadata (duration: ${element.duration}s)`);
                this.onEvent({
                    type: PlayerEvent.LOADED_METADATA,
                    data: { duration: element.duration }
                });

                /*
                 * -----------------------------------------------------------------
                 * Initial Audio Track Application
                 * -----------------------------------------------------------------
                 * Now that the demuxer has parsed the Matroska/MP4 container header,
                 * switch to the requested audio track if one was pre-selected.
                 * -----------------------------------------------------------------
                 */
                if (typeof this._currentAudioIndex === 'number' && this._currentAudioIndex >= 0) {
                    log.info(`movi-player: Applying initial audio track index ${this._currentAudioIndex} after metadata load`);
                    this.setAudioStreamIndex(this._currentAudioIndex);
                }
            },

            canplay: () => {
                log.info('movi-player: canplay');
                this.onEvent({ type: PlayerEvent.CAN_PLAY });

                /*
                 * -----------------------------------------------------------------
                 * Autoplay Engagement
                 * -----------------------------------------------------------------
                 * If playback is requested and the web component sits in paused state
                 * at canplay, kick off playback via element.play() to begin rendering.
                 * -----------------------------------------------------------------
                 */
                if (this._currentPlayOptions?.autoPlay !== false && element.paused) {
                    log.info('movi-player: canplay fired while paused — starting playback');
                    element.play().catch(err => {
                        log.warn('movi-player: element.play() execution in canplay failed:', err);
                    });
                }
            },

            play: () => {
                log.debug('movi-player: play');
                this._isPaused = false;
                this.onEvent({ type: PlayerEvent.PLAY });
            },

            playing: () => {
                log.info('movi-player: playing');
                this._started = true;
                this._isPaused = false;
                this.onEvent({ type: PlayerEvent.PLAYING });
            },

            pause: () => {
                log.debug('movi-player: pause');
                this._isPaused = true;
                this.onEvent({ type: PlayerEvent.PAUSE });
            },

            seeking: () => {
                log.debug('movi-player: seeking');
                this._isSeeking = true;
                this.onEvent({ type: PlayerEvent.SEEK });
            },

            seeked: () => {
                log.info(`movi-player: seeked to ${element.currentTime.toFixed(2)}s`);
                this._isSeeking = false;
                this.onEvent({
                    type: PlayerEvent.SEEKED,
                    data: { time: element.currentTime }
                });
            },

            timeupdate: () => {
                // Throttle updates to ~4 times per second to prevent OSD thrashing
                const now = Date.now();
                if (now - this._lastTimeUpdateTicks < 250) {
                    return;
                }
                this._lastTimeUpdateTicks = now;
                this._timeUpdated = true;

                this.onEvent({
                    type: PlayerEvent.TIME_UPDATE,
                    data: { time: element.currentTime }
                });
            },

            waiting: () => {
                log.debug('movi-player: waiting / buffering');
                this.onEvent({ type: PlayerEvent.WAITING });
            },

            ended: () => {
                log.info('movi-player: playback ended');
                this.onEvent({ type: PlayerEvent.ENDED });
            },

            volumechange: () => {
                this.onEvent({
                    type: PlayerEvent.VOLUME_CHANGE,
                    data: {
                        volume: Math.round(element.volume * 100),
                        muted: element.muted
                    }
                });
            },

            error: (event) => {
                const err = element.error || event.error || { message: 'Unknown playback error' };
                log.error('movi-player error encountered:', err);
                this.onEvent({
                    type: PlayerEvent.ERROR,
                    data: {
                        code: err.code || -1,
                        message: err.message || 'Movi playback failed'
                    }
                });
            }
        };

        // Attach listeners and cache handles for removal
        for (const [eventName, handler] of Object.entries(handlers)) {
            element.addEventListener(eventName, handler);
            this._boundHandlers[eventName] = handler;
        }
    }

    /**
     * Unbind all event listeners from the active element.
     *
     * @private
     */
    _unbindEvents() {
        if (!this._moviElement || !this._boundHandlers) {
            return;
        }

        for (const [eventName, handler] of Object.entries(this._boundHandlers)) {
            this._moviElement.removeEventListener(eventName, handler);
        }
        this._boundHandlers = {};
    }

    // ========================================================================
    // Public Playback Lifecycle Methods
    // ========================================================================

    /**
     * Get the underlying visual element (for layout and positioning).
     *
     * @returns {HTMLElement} The <movi-player> element.
     */
    getVideoElement() {
        return this._ensurePlayerElement();
    }

    /**
     * Start video playback with given Jellyfin stream options.
     *
     * @param {Object} options - Playback options
     * @param {string} options.url - Direct stream URL
     * @param {number} [options.startPositionTicks=0] - Initial resume offset in ticks
     * @param {number} [options.audioStreamIndex] - Selected audio stream index
     * @param {number} [options.subtitleStreamIndex] - Selected subtitle stream index
     * @param {Object} [options.headers] - Authorization headers
     * @returns {Promise<void>}
     */
    async play(options) {
        log.info('MoviVideoPlayer.play() called with URL:', options?.url);
        this._currentPlayOptions = options;
        this._currentSrc = options.url;
        this._started = false;
        this._timeUpdated = false;
        this._startPositionTicks = options.startPositionTicks || 0;

        // Ensure custom element is registered
        await this._ensureMoviRegistered();

        const playerElement = this._ensurePlayerElement();

        // If the custom element is awaiting registration/upgrade, wait for it
        if (typeof window !== 'undefined' && window.customElements && typeof window.customElements.whenDefined === 'function') {
            try {
                await Promise.race([
                    window.customElements.whenDefined('movi-player'),
                    new Promise(resolve => setTimeout(resolve, 2000))
                ]);
            } catch (_) {}
        }

        // Verify that the element has been upgraded with the MoviPlayer API
        if (typeof playerElement.play !== 'function') {
            /*
             * -----------------------------------------------------------------
             * Missing Web Component Guard
             * -----------------------------------------------------------------
             * If the custom element was not upgraded (e.g. npm install has not
             * been executed in litefin to fetch movi-player), the HTML tag
             * exists in the DOM as an un-upgraded HTMLElement without methods.
             * -----------------------------------------------------------------
             */
            const errorMsg = 'MoviPlayer custom element is not registered or upgraded. Please run npm install in litefin.';
            log.error(`MoviVideoPlayer: ${errorMsg}`);

            // Dispatch error event to player subscribers
            this.onEvent({
                type: PlayerEvent.ERROR,
                data: { message: errorMsg }
            });

            /*
             * CRITICAL ARCHITECTURAL REQUIREMENT:
             * We must reject this promise by throwing an error. If play() resolves,
             * JellyfinPlayer and PlayerPage assume playback successfully started,
             * firing PLAYBACK_START and POST /Sessions/Playing to the Jellyfin server,
             * which subsequently overwrites the user's saved resume position with 0.
             */
            throw new Error(errorMsg);
        }

        // --------------------------------------------------------------------
        // Authentication & Custom Request Headers
        // --------------------------------------------------------------------
        // Forward Jellyfin authentication tokens to the player's network layer.
        // MoviPlayer sends these headers with all range requests and demuxer reads.
        // --------------------------------------------------------------------
        if (options.headers) {
            try {
                // Attach custom authorization and API key headers
                playerElement.headers = options.headers;
            } catch (e) {
                // Log warning if header attachment encounters a proxy error
                log.warn('Could not assign headers to movi-player:', e);
            }
        }

        /*
         * --------------------------------------------------------------------
         * Pre-configure Element Attributes Prior to Source Assignment
         * --------------------------------------------------------------------
         * MoviElement reads its attributes during the initial load() microtask.
         * Setting wasmurl, autoplay, and startat before setting .src guarantees
         * that the initial decoder pipeline starts at the resume position with
         * playback automatically engaged.
         * --------------------------------------------------------------------
         */
        const resumeSeconds = (options.startPositionTicks || 0) / 10000000;
        playerElement.setAttribute('wasmurl', 'wasm/movi.wasm');

        // Configure autoplay attribute and property
        if (options.autoPlay !== false) {
            playerElement.setAttribute('autoplay', '');
            playerElement.autoplay = true;
        } else {
            playerElement.removeAttribute('autoplay');
            playerElement.autoplay = false;
        }

        // Configure startat attribute and property for resume positioning
        if (resumeSeconds > 0) {
            log.info(`MoviVideoPlayer: Configuring initial resume startat to ${resumeSeconds.toFixed(2)}s`);
            playerElement.setAttribute('startat', resumeSeconds.toString());
            playerElement.startAt = resumeSeconds;
        } else {
            playerElement.removeAttribute('startat');
            playerElement.startAt = 0;
        }

        // If an initial audio stream was requested, cache it for metadata readiness
        if (typeof options.audioTrackListIndex === 'number' && options.audioTrackListIndex >= 0) {
            this._currentAudioIndex = options.audioTrackListIndex;
        } else if (typeof options.audioStreamIndex === 'number' && options.audioStreamIndex >= 0) {
            this._currentAudioIndex = options.audioStreamIndex;
        }

        // Apply media source URL (triggers scheduleAttrLoad via microtask)
        playerElement.src = options.url;

        /*
         * --------------------------------------------------------------------
         * Begin Video Playback
         * --------------------------------------------------------------------
         * Trigger the custom element's play() promise. Rejections (autoplay policy
         * blocks, network aborts, or codec errors) are surfaced to JellyfinPlayer.
         * Resolving immediately allows PlayerPage to initialize the OSD and UI
         * without blocking the application thread.
         * --------------------------------------------------------------------
         */
        try {
            await playerElement.play();
            log.info('MoviVideoPlayer: play() resolved successfully');
        } catch (err) {
            // Autoplay rejection or stream failure
            log.warn('MoviVideoPlayer: play() rejected:', err);

            // Re-emit error event if playback aborted completely
            if (err.name !== 'AbortError') {
                this.onEvent({
                    type: PlayerEvent.ERROR,
                    data: { message: err.message || 'Autoplay prevented or stream failed' }
                });
            }

            // Propagate error upwards to prevent false playbackstart emission
            throw err;
        }
    }

    /**
     * Pause video playback.
     */
    pause() {
        if (!this._moviElement) return;
        log.debug('MoviVideoPlayer.pause()');
        if (typeof this._moviElement.pause === 'function') {
            this._moviElement.pause();
        }
    }

    /**
     * Unpause / resume video playback.
     */
    unpause() {
        if (!this._moviElement) return;
        log.debug('MoviVideoPlayer.unpause()');
        if (typeof this._moviElement.play === 'function') {
            this._moviElement.play().catch(err => {
                log.warn('MoviVideoPlayer.unpause() play failed:', err);
            });
        }
    }

    /**
     * Stop playback and release stream resources.
     *
     * @returns {Promise<void>}
     */
    async stop() {
        log.info('MoviVideoPlayer.stop() called');
        this._unbindEvents();

        if (this._moviElement) {
            try {
                // Safely pause only if element has been upgraded
                if (typeof this._moviElement.pause === 'function') {
                    this._moviElement.pause();
                }
                // Clear source to cleanly abort active network streams
                this._moviElement.src = '';
                this._moviElement.removeAttribute('src');

                // If internal player destroy method is exposed, trigger it
                if (typeof this._moviElement.player?.destroy === 'function') {
                    this._moviElement.player.destroy();
                } else if (typeof this._moviElement.destroy === 'function') {
                    this._moviElement.destroy();
                }
            } catch (err) {
                log.warn('Error stopping movi-player element:', err);
            }
        }

        this._started = false;
        this._timeUpdated = false;
        this._currentSrc = null;
        this._currentPlayOptions = null;
    }

    /**
     * Seek to a specific timestamp in Jellyfin ticks (1 tick = 100ns).
     *
     * @param {number} positionTicks - Target position in ticks
     */
    seek(positionTicks) {
        if (!this._moviElement) return;

        const targetSeconds = positionTicks / 10000000;
        const currentSeconds = this._moviElement.currentTime || 0;
        const diffMs = Math.abs(targetSeconds - currentSeconds) * 1000;

        // Skip micro-seeks under threshold
        if (diffMs < SEEK_THRESHOLD_MS && this._started) {
            log.debug(`MoviVideoPlayer.seek: delta below threshold (${diffMs.toFixed(0)}ms) — skipping`);
            return;
        }

        log.info(`MoviVideoPlayer.seek to ${targetSeconds.toFixed(2)}s`);
        try {
            this._moviElement.currentTime = targetSeconds;
        } catch (err) {
            log.error('MoviVideoPlayer seek failed:', err);
        }
    }

    // ========================================================================
    // Audio and Volume Controls
    // ========================================================================

    /**
     * Set playback volume (0 to 100 scale).
     *
     * @param {number} volume - Volume level from 0 to 100
     */
    setVolume(volume) {
        if (!this._moviElement) return;
        const clamped = Math.max(0, Math.min(100, volume));
        this._moviElement.volume = clamped / 100;
        MediaHelper.saveVolume(clamped / 100);
    }

    /**
     * Retrieve current volume (0 to 100 scale).
     *
     * @returns {number} Current volume
     */
    getVolume() {
        if (!this._moviElement) return 100;
        return Math.round((this._moviElement.volume || 0) * 100);
    }

    /**
     * Set playback speed / rate.
     *
     * @param {number} speed - Playback rate (e.g. 1.0, 1.25, 1.5, 2.0)
     */
    setSpeed(speed) {
        if (!this._moviElement) return;
        log.info(`MoviVideoPlayer: Setting playback speed to ${speed}x`);
        this._moviElement.playbackRate = speed;
    }

    /**
     * Toggle mute state.
     */
    toggleMute() {
        if (!this._moviElement) return;
        this._moviElement.muted = !this._moviElement.muted;
    }

    /**
     * Set explicit mute state.
     *
     * @param {boolean} muted - True to mute, false to unmute
     */
    setMuted(muted) {
        if (!this._moviElement) return;
        this._moviElement.muted = Boolean(muted);
    }

    /**
     * Check if audio is currently muted.
     *
     * @returns {boolean} True if muted
     */
    isMuted() {
        return this._moviElement ? Boolean(this._moviElement.muted) : false;
    }

    /**
     * Signals to JellyfinPlayer whether this backend supports native multi-audio
     * track switching within a Direct Play container.
     *
     * movi-player demuxes container audio tracks in WebAssembly and plays them
     * via Web Audio, enabling native in-container audio switching without remuxing!
     *
     * @returns {boolean} True
     */
    supportsNativeAudioTracks() {
        return true;
    }

    /**
     * Switch active audio track list index.
     *
     * @param {number} listIndex - Target 0-based audio track index
     */
    setAudioStreamIndex(listIndex) {
        if (!this._moviElement) return;
        log.info(`MoviVideoPlayer: Switching audio track to list index ${listIndex}`);
        this._currentAudioIndex = listIndex;

        // First attempt: Select via standard audioTracks property list
        if (this._moviElement.audioTracks && this._moviElement.audioTracks[listIndex]) {
            try {
                this._moviElement.audioTracks[listIndex].enabled = true;
                log.info(`MoviVideoPlayer: Successfully enabled audio track ${listIndex} via audioTracks property`);
                return;
            } catch (e) {
                log.debug('MoviVideoPlayer: audioTracks property switch failed:', e);
            }
        }

        // Second attempt: Access element-level selectAudioTrack method
        if (typeof this._moviElement.selectAudioTrack === 'function') {
            try {
                this._moviElement.selectAudioTrack(listIndex);
                log.info(`MoviVideoPlayer: Selected audio track ${listIndex} via element.selectAudioTrack`);
                return;
            } catch (e) {
                log.warn('Could not select audio track via element:', e);
            }
        }

        // Third attempt: Access internal player instance if exposed on custom element
        const innerPlayer = this._moviElement.player;
        if (innerPlayer && typeof innerPlayer.selectAudioTrack === 'function') {
            try {
                innerPlayer.selectAudioTrack(listIndex);
                log.info(`MoviVideoPlayer: Selected audio track ${listIndex} via innerPlayer.selectAudioTrack`);
            } catch (e) {
                log.warn('Could not select audio track via innerPlayer:', e);
            }
        }
    }

    // ========================================================================
    // Subtitle & Presentation Controls
    // ========================================================================

    /**
     * Configure active subtitle stream index.
     * Subtitles are predominantly handled by Litefin's SubtitleManager (rendering
     * styled ASS/SSA, PGS bitmaps, or WebVTT cues on dedicated overlays).
     *
     * @param {number} index - Stream index (-1 to disable)
     */
    setSubtitleStreamIndex(index) {
        this._currentSubtitleIndex = index;
        log.info(`MoviVideoPlayer.setSubtitleStreamIndex: ${index}`);
    }

    /**
     * Adjust subtitle timing offset.
     *
     * @param {number} seconds - Offset in seconds
     */
    setSubtitleOffset(seconds) {
        this._subtitleOffset = seconds;
    }

    /**
     * Set video presentation aspect ratio.
     *
     * @param {'contain'|'cover'|'fill'} mode - Aspect ratio mode
     */
    setAspectRatio(mode) {
        if (!this._moviElement) return;
        const fitMode = mode === 'cover' ? 'cover' : mode === 'fill' ? 'fill' : 'contain';
        this._moviElement.style.objectFit = fitMode;
        this._moviElement.setAttribute('objectfit', fitMode);
    }

    // ========================================================================
    // State Query Getters
    // ========================================================================

    /**
     * Get current playback position in seconds.
     *
     * @returns {number} Position in seconds
     */
    getCurrentTime() {
        return this._moviElement ? this._moviElement.currentTime || 0 : 0;
    }

    /**
     * Get total duration in seconds.
     *
     * @returns {number} Duration in seconds
     */
    getDuration() {
        return this._moviElement ? this._moviElement.duration || 0 : 0;
    }

    /**
     * Get duration estimated by manifest (same as getDuration for progressive streams).
     *
     * @returns {number} Duration in seconds
     */
    getHlsManifestDuration() {
        return this.getDuration();
    }

    /**
     * Retrieve the initial resume offset configured for this session in ticks.
     *
     * @returns {number} Start position ticks
     */
    getStartPositionTicks() {
        return this._startPositionTicks || 0;
    }

    /**
     * Check if playback is currently paused.
     *
     * @returns {boolean} True if paused
     */
    isPaused() {
        if (!this._moviElement) return true;
        return Boolean(this._moviElement.paused);
    }

    // ========================================================================
    // Teardown and Cleanup
    // ========================================================================

    /**
     * Completely destroy player instance and remove DOM nodes.
     */
    destroy() {
        log.info('MoviVideoPlayer.destroy() called');
        this.stop();

        if (this._moviElement) {
            try {
                this._moviElement.remove();
            } catch (_) {}
            this._moviElement = null;
            this._videoElement = null;
        }

        this.container = null;
        this.settings = null;
        this.onEvent = () => {};
    }
}
