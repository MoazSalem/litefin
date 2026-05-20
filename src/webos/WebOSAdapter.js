/**
 * ============================================================================
 * Litefin - WebOS Adapter
 * ============================================================================
 * Handles all LG WebOS-specific functionality including:
 * - Remote control key registration and mapping
 * - Magic Remote cursor visibility management
 * - Media Session integration for physical remote media keys
 * - Device info and platform detection
 * ============================================================================
 */

import { eventBus } from '../core/EventBus.js';
import { logger } from '../utils/Logger.js';

const log = logger.create('WebOSAdapter');

// Minimum pixel movement to consider as an interaction.
// Filters out gyro noise from LG Magic Remotes.
const MOVEMENT_THRESHOLD = 5;

/**
 * Key code mappings for LG WebOS remotes
 * Based on LG Developer Documentation and Jellyfin's input mapping.
 */
const WEBOS_KEYS = {
    // Navigation
    LEFT: 37,
    UP: 38,
    RIGHT: 39,
    DOWN: 40,
    ENTER: 13,
    BACK: 461, // The critical "Return/Back" button on LG remotes

    // Media controls (Physical buttons on the bottom of many LG remotes)
    PLAY: 415,
    PAUSE: 19,
    STOP: 413,
    REWIND: 412,
    FAST_FORWARD: 417,

    // Channel / Track keys (effectively Skip Next/Previous)
    NEXT: 33, // PageUp / ChannelUp
    PREV: 34, // PageDown / ChannelDown

    // Color buttons (Red, Green, Yellow, Blue)
    RED: 403,
    GREEN: 404,
    YELLOW: 405,
    BLUE: 406
};

class WebOSAdapter {
    constructor() {
        this._isWebOS = false;
        this._deviceInfo = null;
        this._cursorActive = false;
        this._lastInteractionTime = Date.now();

        // Track mouse position to filter out minor gyro noise
        this._lastMouseX = -1;
        this._lastMouseY = -1;

        // Immediate platform detection via User Agent or Global
        this._detectPlatform();
    }

    /**
     * Get idle time in milliseconds
     * @returns {number} Idle time
     */
    get idleTime() {
        return Date.now() - (this._lastInteractionTime || Date.now());
    }

    /**
     * Report an input interaction (mouse, touch etc from outside)
     */
    reportInput() {
        this._lastInteractionTime = Date.now();
    }

    /**
     * Detect if running on WebOS platform
     * @private
     */
    _detectPlatform() {
        const ua = navigator.userAgent;
        // Rely strictly on hardware UA strings. window.webOS is defined on all platforms via script tag.
        if (/Web[O0]S|NetCast|LG[ -]Browser/i.test(ua)) {
            this._isWebOS = true;
            log.info('Running on WebOS adapter mode');
        }
    }

    /**
     * Initialize WebOS-specific features
     */
    init() {
        if (!this._isWebOS) return;

        log.info('Initializing WebOSAdapter...');

        // 1. Register for remote buttons (Key Masking)
        // This ensures the OS delivers these physical keys to the web app
        this._registerRemoteKeys();

        // 2. Setup global key listener for Back button and Navigation
        this._setupKeyHandler();

        // 3. Setup Magic Remote cursor tracking
        this._setupCursorTracking();

        // 4. Load Device Info
        this._loadDeviceInfo();

        // 5. Setup wheel amplification for Magic Remote
        this._setupWheelHandler();

        log.info('WebOSAdapter initialized');
    }

    /**
     * WebOS Magic Remote scroll wheel is notoriously slow and "resistive".
     * This handler intercepts the native wheel event and amplifies the delta
     * to make vertical scrolling feel responsive and fluid.
     * @private
     */
    _setupWheelHandler() {
        window.addEventListener(
            'wheel',
            (e) => {
                // Only handle vertical scrolling
                if (Math.abs(e.deltaY) < 0.1) return;

                // Find the nearest scrollable container
                const container = e.target.closest(
                    '.page-content, .modal-options, .filter-main, .sidebar-libraries-wrapper, .settings-content'
                );

                if (container) {
                    let delta = e.deltaY;

                    // Normalize delta based on deltaMode (0=pixels, 1=lines, 2=pages)
                    if (e.deltaMode === 1) {
                        delta *= 40; // Approx line height
                    } else if (e.deltaMode === 2) {
                        delta *= 800; // Approx page height
                    }

                    // Amplify the delta for WebOS responsiveness (reduced by 30%)
                    const multiplier = 2.0;
                    container.scrollTop += delta * multiplier;

                    // Prevent native slow scroll
                    e.preventDefault();
                }
            },
            { passive: false }
        );
    }

    /**
     * Register extended remote keys with the OS.
     * Some LG models require this "masking" to receive color and media keys.
     * @private
     */
    _registerRemoteKeys() {
        try {
            if (window.webOS && window.webOS.keyboard && typeof window.webOS.keyboard.setKeyMask === 'function') {
                const keys = [
                    'back',
                    'play',
                    'pause',
                    'stop',
                    'rewind',
                    'fastforward',
                    'red',
                    'green',
                    'yellow',
                    'blue'
                ];
                window.webOS.keyboard.setKeyMask(keys);
                log.info('Remote key mask set:', keys);
            }
        } catch (e) {
            log.warn('Failed to set WebOS key mask:', e);
        }
    }

    /**
     * Setup global key event handler
     * @private
     */
    _setupKeyHandler() {
        document.addEventListener('keydown', (e) => {
            this._lastInteractionTime = Date.now();
            const keyCode = e.keyCode;

            // Hide the Magic Remote cursor as soon as a navigation key is pressed
            if (this._cursorActive) {
                this._setCursorActive(false);
            }

            // Block WebOS default spatial navigation/scrolling unless user is typing in an input field.
            const activeElem = document.activeElement;
            const isTextInput =
                activeElem &&
                ((activeElem.tagName === 'INPUT' && activeElem.type !== 'range') || activeElem.tagName === 'TEXTAREA');

            if (!isTextInput) {
                if (
                    [WEBOS_KEYS.LEFT, WEBOS_KEYS.RIGHT, WEBOS_KEYS.UP, WEBOS_KEYS.DOWN, WEBOS_KEYS.ENTER].includes(
                        keyCode
                    )
                ) {
                    e.preventDefault();
                }
            }

            // Map key codes to eventBus events
            switch (keyCode) {
                // Navigation
                case WEBOS_KEYS.LEFT:
                    eventBus.emit('key:left', e);
                    break;
                case WEBOS_KEYS.RIGHT:
                    eventBus.emit('key:right', e);
                    break;
                case WEBOS_KEYS.UP:
                    eventBus.emit('key:up', e);
                    break;
                case WEBOS_KEYS.DOWN:
                    eventBus.emit('key:down', e);
                    break;
                case WEBOS_KEYS.ENTER:
                    eventBus.emit('key:enter', e);
                    break;
                case WEBOS_KEYS.BACK:
                    // LG requires preventDefault on 461 to prevent the app from closing immediately
                    e.preventDefault();
                    eventBus.emit('key:back', e);
                    break;

                case WEBOS_KEYS.PLAY:
                    eventBus.emit('key:play', e);
                    break;
                case WEBOS_KEYS.PAUSE:
                    eventBus.emit('key:pause', e);
                    break;
                case WEBOS_KEYS.STOP:
                    eventBus.emit('key:stop', e);
                    break;
                case WEBOS_KEYS.REWIND:
                    eventBus.emit('key:rewind', e);
                    break;
                case WEBOS_KEYS.FAST_FORWARD:
                    eventBus.emit('key:fastForward', e);
                    break;
                case WEBOS_KEYS.NEXT:
                    eventBus.emit('key:next', e);
                    eventBus.emit('key:channelUp', e);
                    break;
                case WEBOS_KEYS.PREV:
                    eventBus.emit('key:previous', e);
                    eventBus.emit('key:channelDown', e);
                    break;

                case WEBOS_KEYS.RED:
                    eventBus.emit('key:red', e);
                    break;
                case WEBOS_KEYS.GREEN:
                    eventBus.emit('key:green', e);
                    break;
                case WEBOS_KEYS.YELLOW:
                    eventBus.emit('key:yellow', e);
                    break;
                case WEBOS_KEYS.BLUE:
                    eventBus.emit('key:blue', e);
                    break;
            }
        });
    }

    /**
     * Setup mousemove listener to detect Magic Remote pointer movement
     * @private
     */
    _setupCursorTracking() {
        document.addEventListener('mousemove', (e) => {
            // Check if movement is significant enough to count as interaction
            const deltaX = Math.abs(e.clientX - this._lastMouseX);
            const deltaY = Math.abs(e.clientY - this._lastMouseY);

            if (deltaX < MOVEMENT_THRESHOLD && deltaY < MOVEMENT_THRESHOLD) {
                return;
            }

            this._lastMouseX = e.clientX;
            this._lastMouseY = e.clientY;

            this._lastInteractionTime = Date.now();
            if (!this._cursorActive) {
                this._setCursorActive(true);
            }
        });

        // Also track mouse clicks (Magic Remote wheel click)
        document.addEventListener('mousedown', () => {
            this._lastInteractionTime = Date.now();
            if (!this._cursorActive) {
                this._setCursorActive(true);
            }
        });
    }

    /**
     * Update the cursor state and apply CSS classes to the body
     * @param {boolean} active
     * @private
     */
    _setCursorActive(active) {
        if (this._cursorActive === active) return;
        this._cursorActive = active;

        if (active) {
            document.body.classList.add('webos-cursor-active');
            log.debug('Magic Remote cursor activated');
        } else {
            document.body.classList.remove('webos-cursor-active');
            log.debug('Magic Remote cursor hidden (switching to D-pad mode)');
        }
    }

    /**
     * Load WebOS device information
     * @private
     */
    _loadDeviceInfo() {
        if (!this._isWebOS) return;

        try {
            if (window.webOS && typeof window.webOS.deviceInfo === 'function') {
                window.webOS.deviceInfo((info) => {
                    this._deviceInfo = info;
                    log.info('WebOS Device Info loaded:', info);
                    eventBus.emit('webos:deviceInfoReady', info);
                });
            }
        } catch (e) {
            log.error('Failed to load WebOS device info:', e);
        }
    }

    /**
     * Initialize/Update Media Session metadata and handlers.
     * This links the physical remote media buttons (Play/Pause/Skip) to the player.
     *
     * @param {Object} metadata - { title, artist, album, artworkUrl }
     * @param {Object} callbacks - { onPlay, onPause, onStop, onSeekForward, onSeekBackward }
     */
    updateMediaSession(metadata = {}, callbacks = {}) {
        if (!('mediaSession' in navigator)) return;

        log.info('Updating Media Session for WebOS remote support');

        // Set metadata
        try {
            if (typeof window.MediaMetadata !== 'undefined') {
                navigator.mediaSession.metadata = new window.MediaMetadata({
                    title: metadata.title || '',
                    artist: metadata.artist || '',
                    album: metadata.album || 'Litefin',
                    artwork: metadata.artworkUrl ? [{ src: metadata.artworkUrl }] : []
                });
            }
        } catch (e) {
            log.warn('Failed to set MediaSession metadata:', e);
        }

        // Set action handlers
        // These are triggered when the user presses buttons on the bottom of the LG remote
        const actions = {
            play: callbacks.onPlay,
            pause: callbacks.onPause,
            stop: callbacks.onStop,
            seekbackward: callbacks.onSeekBackward,
            seekforward: callbacks.onSeekForward,
            previoustrack: callbacks.onPrevious,
            nexttrack: callbacks.onNext
        };

        Object.keys(actions).forEach((action) => {
            try {
                if (typeof actions[action] === 'function') {
                    navigator.mediaSession.setActionHandler(action, actions[action]);
                } else {
                    navigator.mediaSession.setActionHandler(action, null);
                }
            } catch (e) {
                log.warn(`Failed to set MediaSession action handler for ${action}:`, e);
            }
        });
    }

    /**
     * Perform exit action
     */
    exit() {
        if (this._isWebOS) {
            log.info('Exiting application via webOS.platformBack()');
            if (window.webOS && typeof window.webOS.platformBack === 'function') {
                window.webOS.platformBack();
            } else {
                window.close();
            }
        }
    }

    /**
     * Get device name for server identification
     * @returns {string} Device name (e.g. "LG Smart TV" or specific model)
     */
    getDeviceName() {
        if (this._isWebOS && this._deviceInfo && this._deviceInfo.modelName) {
            return this._deviceInfo.modelName;
        }
        return this._isWebOS ? 'LG Smart TV' : 'Web Browser';
    }

    /**
     * Get device manufacturer
     * @returns {string} Manufacturer name
     */
    getManufacturer() {
        return this._isWebOS ? 'LG' : 'Generic';
    }

    get isWebOS() {
        return this._isWebOS;
    }
    get deviceInfo() {
        return this._deviceInfo;
    }

    /**
     * Launch the native YouTube application on LG WebOS TVs and navigate
     * directly to the specified video.
     *
     * Uses the WebOS Application Manager Luna service to launch the YouTube
     * Leanback app (`youtube.leanback.v4`) with the video ID passed as a
     * parameter. If the launch fails, falls back to opening a browser tab.
     *
     * @param {string} videoId - The YouTube video ID (e.g. "dQw4w9WgXcQ")
     */
    launchYouTube(videoId) {
        if (!videoId) return;

        /* ── Browser / dev fallback ─────────────────────────────────────── */
        if (!this._isWebOS) {
            log.info('launchYouTube: not on WebOS, opening browser tab');
            window.open(`https://www.youtube.com/watch?v=${videoId}`, '_blank');
            return;
        }

        try {
            log.info(`launchYouTube: launching YouTube app for videoId=${videoId}`);

            /* `com.webos.applicationManager/launch` is the standard Luna service
               used to start any installed app on WebOS. The YouTube Leanback app
               accepts a `videoId` param in its launch params object. */
            window.webOS.service.request('luna://com.webos.applicationManager', {
                method: 'launch',
                parameters: {
                    id: 'youtube.leanback.v4',
                    params: {
                        videoId: videoId,
                        contentId: videoId // Fallback for some YouTube TV app versions
                    }
                },
                onSuccess: () => log.info('launchYouTube: YouTube app launched successfully'),
                onFailure: (err) => {
                    /* App not installed or service call failed — open browser as
                       last-resort fallback so the user still sees the video. */
                    log.warn('launchYouTube: launch failed, falling back to browser', err);
                    window.open(`https://www.youtube.com/watch?v=${videoId}`, '_blank');
                }
            });
        } catch (e) {
            log.error('launchYouTube: unexpected error', e);
            window.open(`https://www.youtube.com/watch?v=${videoId}`, '_blank');
        }
    }
}

export const webosAdapter = new WebOSAdapter();
export default webosAdapter;
