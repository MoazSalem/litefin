/**
 * ============================================================================
 * Litefin Tizen - Tizen Adapter
 * ============================================================================
 * Handles all Tizen-specific functionality including:
 * - Remote control key registration
 * - App lifecycle (exit, suspend, resume)
 * - Device info and capabilities
 * - Platform detection
 * ============================================================================
 */

import { eventBus } from '../core/EventBus.js';
import { storage } from '../utils/StorageService.js';
import { logger } from '../utils/Logger.js';
import { platformInfo } from '../utils/PlatformInfo.js';

const log = logger.create('TizenAdapter');

// ============================================================================
// Key code mappings for Samsung TV remotes
// ============================================================================
const TIZEN_KEYS = {
    // Navigation
    LEFT: 37,
    UP: 38,
    RIGHT: 39,
    DOWN: 40,
    ENTER: 13,
    BACK: 10009,

    // Media controls
    PLAY: 415,
    PAUSE: 19,
    STOP: 413,
    PLAY_PAUSE: 10252,
    REWIND: 412,
    FAST_FORWARD: 417,
    PREVIOUS: 10232,
    NEXT: 10233,

    // Color buttons
    RED: 403,
    GREEN: 404,
    YELLOW: 405,
    BLUE: 406,

    // Numeric
    NUM_0: 48,
    NUM_1: 49,
    NUM_2: 50,
    NUM_3: 51,
    NUM_4: 52,
    NUM_5: 53,
    NUM_6: 54,
    NUM_7: 55,
    NUM_8: 56,
    NUM_9: 57,

    // Other
    INFO: 457,
    TOOLS: 433, // Often used as "Options"
    MENU: 18,
    CHANNEL_UP: 427,
    CHANNEL_DOWN: 428,
    VOLUME_UP: 447,
    VOLUME_DOWN: 448,
    MUTE: 449
};

class TizenAdapter {
    constructor() {
        this._isTizen = false;
        this._tizenVersion = null;
        this._deviceInfo = null;

        // Detect Tizen environment
        this._detectPlatform();
    }

    /**
     * Detect if running on Tizen platform
     * Uses centralized platformInfo single source of truth when available,
     * falling back safely in isolated VM sandboxes.
     * @private
     */
    _detectPlatform() {
        if (typeof platformInfo !== 'undefined') {
            this._isTizen = platformInfo.isTizen;
            this._tizenVersion = platformInfo.tizenVersion;
        } else {
            this._isTizen = typeof tizen !== 'undefined';
            this._tizenVersion = null;
        }

        if (this._isTizen) {
            // Try to get Tizen app info for diagnostic telemetry
            try {
                const appInfo = typeof tizen !== 'undefined' ? tizen.application.getCurrentApplication().appInfo : null;
                if (appInfo) {
                    log.info(
                        `Running on Tizen (App: ${appInfo.id} v${appInfo.version}, OS v${this._tizenVersion || 'unknown'})`
                    );
                } else {
                    log.info(`Running on Tizen OS v${this._tizenVersion || 'unknown'}`);
                }
            } catch (e) {
                log.info(`Running on Tizen OS v${this._tizenVersion || 'unknown'}`);
            }
        } else {
            log.info('Not running on Samsung Tizen platform');
        }
    }

    /**
     * Initialize Tizen-specific features
     * Call this after DOM is ready
     */
    init() {
        // Enforce strict platform isolation - never run on non-Tizen targets
        if (!this._isTizen) {
            log.info('TizenAdapter: Skipped initialization (target is not Samsung Tizen TV)');
            return;
        }

        log.info('Initializing TizenAdapter for Samsung TV hardware...');

        this._lastInputTime = Date.now();

        // Register remote control keys
        this._registerKeys();

        // Setup key event handler
        this._setupKeyHandler();

        // Setup mouse listeners for Tizen pointer/air-mouse mode
        document.addEventListener('mousemove', () => this.reportInput(), { passive: true });
        document.addEventListener('mousedown', () => this.reportInput(), { passive: true });

        // Get device info
        this._getDeviceInfo();

        // Prime hardware overlay / AVPlay compositor pipeline on Tizen boot
        // while #app-splash covers the screen, without touching playback state.
        this.warmupCompositor();

        log.info('TizenAdapter initialized');
    }

    /**
     * Warm up the Tizen WebAppEngine / Chromium hardware overlay pipeline once
     * during startup so subsequent home-screen scrolling benefits from hardware
     * overlay compositing without waiting for initial video playback.
     *
     * Strictly isolated to Samsung Tizen targets, completely read-only against
     * `webapis.avplay` session state, and removes the transient probe element once
     * two compositor frames settle so zero dormant plugin nodes remain.
     *
     * @returns {boolean} True when Tizen warmup executed or had already run
     */
    warmupCompositor() {
        // Hard isolation guard — never touch hardware plane primitives off Tizen
        if (!this._isTizen) {
            return false;
        }
        if (this._compositorWarmed) {
            return true;
        }
        this._compositorWarmed = true;

        // Read-only AVPlay state probe — avoids avplay.open('about:blank') which
        // fails or stalls native pipelines with a fake URL. Holding the persistent
        // plugin <object> below plus real micro-media decode handles hardware warmup.
        try {
            const avplay = typeof window !== 'undefined' ? window.webapis?.avplay || window.tizen?.avplay : null;
            if (avplay && typeof avplay.getState === 'function') {
                avplay.getState();
            }
        } catch (_) {
            // Hardware plugin unavailable in simulator or older TV firmwares before open()
        }

        // Real 1-frame 16x16 baseline H.264 MP4 (~1.4KB) used once per cold boot to
        // spin up Chromium's hardware video decoder and high-FPS compositor path
        // without opening a network socket or spawning native AVPlay errors.
        const MICRO_VIDEO_DATA_URI =
            'data:video/mp4;base64,' +
            'AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAMPbW9vdgAAAGxtdmhkAAAAAAAA' +
            'AAAAAAAAAAAD6AAAA+gAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAA' +
            'AAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAjl0cmFrAAAAXHRr' +
            'aGQAAAADAAAAAAAAAAAAAAABAAAAAAAAA+gAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAA' +
            'AAAAAAABAAAAAAAAAAAAAAAAAABAAAAAABAAAAAQAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAA' +
            'AAEAAAPoAAAAAAABAAAAAAGxbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAAAQABVxAAA' +
            'AAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABXG1pbmYA' +
            'AAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAA' +
            'AQAAARxzdGJsAAAAuHN0c2QAAAAAAAAAAQAAAKhhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAA' +
            'AAAAAAEAAABIAAAASAAAAAAAAAABFUxhdmM2Mi4zMC4xMDAgbGlieDI2NAAAAAAAAAAAAAAA' +
            'GP//AAAALmF2Y0MBQsAe/+EAFmdCwB7ZHsBEAAADAAQAAAMACDxYuSABAAVoy4PLIAAAABBw' +
            'YXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAABPAAAAAAAAAABhzdHRzAAAAAAAAAAEAAAABAABA' +
            'AAAAABxzdHNjAAAAAAAAAAEAAAABAAAAAQAAAAEAAAAUc3RzegAAAAAAAAJ4AAAAAQAAABRz' +
            'dGNvAAAAAAAAAAEAAAM/AAAAYnVkdGEAAABabWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRp' +
            'cmFwcGwAAAAAAAAAAAAAAAAtaWxzdAAAACWpdG9vAAAAHWRhdGEAAAABAAAAAExhdmY2Mi4x' +
            'My4xMDIAAAAIZnJlZQAAAoBtZGF0AAACYgYF//9e3EXpvebZSLeWLNgg2SPu73gyNjQgLSBj' +
            'b3JlIDE2NSAtIEguMjY0L01QRUctNCBBVkMgY29kZWMgLSBDb3B5bGVmdCAyMDAzLTIwMjUg' +
            'LSBodHRwOi8vd3d3LnZpZGVvbGFuLm9yZy94MjY0Lmh0bWwgLSBvcHRpb25zOiBjYWJhYz0w' +
            'IHJlZj0zIGRlYmxvY2s9MTowOjAgYW5hbHlzZT0weDE6MHgxMTEgbWU9aGV4IHN1Ym1lPTcg' +
            'cHN5PTEgcHN5X3JkPTEuMDA6MC4wMCBtaXhlZF9yZWY9MSBtZV9yYW5nZT0xNiBjaHJvbWFf' +
            'bWU9MSB0cmVsbGlzPTEgOHg4ZGN0PTAgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tp' +
            'cD0xIGNocm9tYV9xcF9vZmZzZXQ9LTIgdGhyZWFkcz0xIGxvb2thaGVhZF90aHJlYWRzPTEg' +
            'c2xpY2VkX3RocmVhZHM9MCBucj0wIGRlY2ltYXRlPTEgaW50ZXJsYWNlZD0wIGJsdXJheV9j' +
            'b21wYXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MCB3ZWlnaHRwPTAga2V5aW50' +
            'PTI1MCBrZXlpbnRfbWluPTEgc2NlbmVjdXQ9NDAgaW50cmFfcmVmcmVzaD0wIHJjX2xvb2th' +
            'aGVhZD00MCByYz1jcmYgbWJ0cmVlPTEgY3JmPTIzLjAgcWNvbXA9MC42MCBxcG1pbj0wIHFw' +
            'bWF4PTY5IHFwc3RlcD00IGlwX3JhdGlvPTEuNDAgYXE9MToxLjAwAIAAAAAOZYiEBX///w9F' +
            'AAFC34A=';

        // Wake the browser audio HAL / WebAudio thread silently so first playback
        // or mixer transitions do not stall the UI compositor later.
        try {
            const AudioCtx = typeof window !== 'undefined' ? window.AudioContext || window.webkitAudioContext : null;
            if (AudioCtx) {
                const audioCtx = new AudioCtx();
                const closeAudioCtx = () => {
                    try {
                        if (typeof audioCtx.close === 'function' && audioCtx.state !== 'closed') {
                            const closePromise = audioCtx.close();
                            if (closePromise && typeof closePromise.catch === 'function') {
                                closePromise.catch(() => {});
                            }
                        }
                    } catch (_) {
                        // Ignore cleanup errors on restricted or mocked audio contexts
                    }
                };

                if (typeof audioCtx.resume === 'function') {
                    const resumeResult = audioCtx.resume();
                    // Modern Chromium returns a Promise from resume(); legacy WebKit may not
                    if (resumeResult && typeof resumeResult.then === 'function') {
                        resumeResult.then(closeAudioCtx, closeAudioCtx);
                    } else {
                        closeAudioCtx();
                    }
                } else {
                    closeAudioCtx();
                }
            }
        } catch (_) {
            // AudioContext blocked or unavailable in headless/stub environments
        }

        if (typeof document === 'undefined' || !document.body) {
            return true;
        }

        // Helper for off-view 1x1 hidden layer styling without layout impact
        const applyWarmupStyle = (el) => {
            el.setAttribute('aria-hidden', 'true');
            el.style.position = 'fixed';
            el.style.top = '0px';
            el.style.left = '0px';
            el.style.width = '1px';
            el.style.height = '1px';
            el.style.opacity = '0';
            el.style.pointerEvents = 'none';
            el.style.zIndex = '-1';
        };

        try {
            // Keep a persistent 1x1 AVPlayer object mounted in the body so Tizen
            // retains its native video-plane compositor mode across navigation
            // instead of dropping back to software/throttled composition.
            const existingProbe =
                typeof document.getElementById === 'function'
                    ? document.getElementById('litefin-avplay-warmup')
                    : null;
            if (!existingProbe) {
                const probe = document.createElement('object');
                probe.id = 'litefin-avplay-warmup';
                probe.type = 'application/avplayer';
                applyWarmupStyle(probe);
                document.body.appendChild(probe);
                this._compositorWarmupProbe = probe;
            } else {
                this._compositorWarmupProbe = existingProbe;
            }

            // Decode a genuine 1-frame muted inline MP4 inside a hidden 1x1 <video>,
            // pause right after the play promise settles, and detach so decoder
            // slots remain completely free for real media playback.
            const existingVideo =
                typeof document.getElementById === 'function'
                    ? document.getElementById('litefin-video-warmup')
                    : null;
            if (!existingVideo) {
                const video = document.createElement('video');
                video.id = 'litefin-video-warmup';
                video.muted = true;
                video.playsInline = true;
                video.preload = 'auto';
                if (typeof video.setAttribute === 'function') {
                    video.setAttribute('muted', '');
                    video.setAttribute('playsinline', '');
                }
                applyWarmupStyle(video);
                video.src = MICRO_VIDEO_DATA_URI;
                document.body.appendChild(video);

                let videoCleaned = false;
                let fallbackTimerId = null;
                const cleanupVideo = () => {
                    if (videoCleaned) return;
                    videoCleaned = true;
                    if (fallbackTimerId) {
                        clearTimeout(fallbackTimerId);
                        fallbackTimerId = null;
                    }
                    try {
                        if (typeof video.pause === 'function') {
                            video.pause();
                        }
                    } catch (_) {
                        // Safe ignore during teardown
                    }
                    if (video.parentNode) {
                        video.parentNode.removeChild(video);
                    }
                };

                // Guarantee bounded teardown even if the media pipeline never resolves
                fallbackTimerId = setTimeout(cleanupVideo, 400);

                try {
                    const playResult = typeof video.play === 'function' ? video.play() : null;
                    if (playResult && typeof playResult.then === 'function') {
                        playResult.then(cleanupVideo, cleanupVideo);
                    } else if (typeof requestAnimationFrame === 'function') {
                        // Legacy Chromium/WebKit engines return undefined from video.play()
                        requestAnimationFrame(() => {
                            requestAnimationFrame(cleanupVideo);
                        });
                    } else {
                        cleanupVideo();
                    }
                } catch (_) {
                    cleanupVideo();
                }
            }

            log.debug('TizenAdapter: Micro-video + AudioContext compositor warmup executed');
        } catch (err) {
            log.debug('TizenAdapter: Compositor warmup skipped cleanly', err);
        }

        return true;
    }

    /**
     * Get idle time in milliseconds
     * @returns {number} Idle time
     */
    get idleTime() {
        return Date.now() - (this._lastInputTime || Date.now());
    }

    /**
     * Report an input interaction (mouse, touch etc from outside)
     */
    reportInput() {
        this._lastInputTime = Date.now();
    }

    /**
     * Register remote control keys with Tizen
     * @private
     */
    _registerKeys() {
        if (!this._isTizen) return;

        try {
            const keys = [
                'MediaPlay',
                'MediaPause',
                'MediaStop',
                'MediaPlayPause',
                'MediaRewind',
                'MediaFastForward',
                'MediaTrackPrevious',
                'MediaTrackNext',
                'ColorF0Red',
                'ColorF1Green',
                'ColorF2Yellow',
                'ColorF3Blue',
                'Info',
                'Tools',
                // Numeric keys (0-9). Tizen does NOT deliver these to the web app
                // unless registered. Needed so the profile PIN keypad can read
                // physical remote number presses (see ui/PinDialog.js).
                '0',
                '1',
                '2',
                '3',
                '4',
                '5',
                '6',
                '7',
                '8',
                '9'
            ];

            keys.forEach((key) => {
                try {
                    tizen.tvinputdevice.registerKey(key);
                } catch (e) {
                    // Key might not be available on all devices
                }
            });

            log.info('Remote keys registered');
        } catch (e) {
            log.error('Failed to register keys:', e);
        }
    }

    /**
     * Setup global key event handler
     * @private
     */
    _setupKeyHandler() {
        document.addEventListener('keydown', (e) => {
            this._lastInputTime = Date.now();
            const keyCode = e.keyCode;

            // Block Tizen's default spatial navigation unless user is typing in an input field.
            // Failing to prevent default allows the TV to natively jump its internal hardware focus
            // instantly before JS calculates the virtual row, triggering ghost focusin loops.
            const activeElem = document.activeElement;
            const isTextInput =
                activeElem &&
                !activeElem.readOnly &&
                ((activeElem.tagName === 'INPUT' && activeElem.type !== 'range') || activeElem.tagName === 'TEXTAREA');

            /*
             * Space bar control helper:
             * We only want to hijack the space bar if the player is actively rendering
             * on screen. This prevents breaking standard browser scroll functionality
             * on the settings, details, or library grid pages.
             */
            const isPlayerActive = window.location.hash.startsWith('#/player');

            // Physical keyboard media player shortcuts (J/K/L/M) on attached keyboards
            if (isPlayerActive && !isTextInput && !e.ctrlKey && !e.altKey && !e.metaKey) {
                switch (e.key) {
                    case 'k':
                    case 'K':
                        e.preventDefault();
                        eventBus.emit('key:playPause', e);
                        return;
                    case 'j':
                    case 'J':
                        e.preventDefault();
                        eventBus.emit('key:rewind', e);
                        return;
                    case 'l':
                    case 'L':
                        e.preventDefault();
                        eventBus.emit('key:fastForward', e);
                        return;
                    case 'm':
                    case 'M':
                        e.preventDefault();
                        eventBus.emit('remote:togglemute');
                        return;
                    default:
                        break;
                }
            }

            if (!isTextInput) {
                const keysToPrevent = [
                    TIZEN_KEYS.LEFT,
                    TIZEN_KEYS.RIGHT,
                    TIZEN_KEYS.UP,
                    TIZEN_KEYS.DOWN,
                    TIZEN_KEYS.ENTER
                ];
                if (isPlayerActive && keyCode === 32) {
                    keysToPrevent.push(32);
                }
                if (keysToPrevent.includes(keyCode)) {
                    e.preventDefault();
                }
            }

            // Map key codes to events
            switch (keyCode) {
                // Space bar mapping for web/desktop players
                case 32:
                    if (!isTextInput && isPlayerActive) {
                        e.preventDefault();
                        eventBus.emit('key:playPause', e);
                    }
                    break;
                // Navigation
                case TIZEN_KEYS.LEFT:
                    eventBus.emit('key:left', e);
                    break;
                case TIZEN_KEYS.RIGHT:
                    eventBus.emit('key:right', e);
                    break;
                case TIZEN_KEYS.UP:
                    eventBus.emit('key:up', e);
                    break;
                case TIZEN_KEYS.DOWN:
                    eventBus.emit('key:down', e);
                    break;
                case TIZEN_KEYS.ENTER:
                    eventBus.emit('key:enter', e);
                    break;
                case TIZEN_KEYS.BACK:
                    e.preventDefault();
                    eventBus.emit('key:back', e);
                    break;
                case 27: // Escape
                case 8: // Backspace
                    if (!isTextInput) {
                        e.preventDefault();
                        eventBus.emit('key:back', e);
                    }
                    break;

                // Media controls
                case TIZEN_KEYS.PLAY:
                    e.preventDefault();
                    eventBus.emit('key:play', e);
                    break;
                case TIZEN_KEYS.PAUSE:
                    e.preventDefault();
                    eventBus.emit('key:pause', e);
                    break;
                case TIZEN_KEYS.PLAY_PAUSE:
                    e.preventDefault();
                    eventBus.emit('key:playPause', e);
                    break;
                case TIZEN_KEYS.STOP:
                    e.preventDefault();
                    eventBus.emit('key:stop', e);
                    break;
                case TIZEN_KEYS.REWIND:
                    e.preventDefault();
                    eventBus.emit('key:rewind', e);
                    break;
                case TIZEN_KEYS.FAST_FORWARD:
                    e.preventDefault();
                    eventBus.emit('key:fastForward', e);
                    break;

                // Color buttons
                case TIZEN_KEYS.RED:
                    eventBus.emit('key:red', e);
                    break;
                case TIZEN_KEYS.GREEN:
                    eventBus.emit('key:green', e);
                    break;
                case TIZEN_KEYS.YELLOW:
                    eventBus.emit('key:yellow', e);
                    break;
                case TIZEN_KEYS.BLUE:
                    eventBus.emit('key:blue', e);
                    break;

                case TIZEN_KEYS.INFO:
                    eventBus.emit('key:info', e);
                    break;

                case TIZEN_KEYS.TOOLS:
                    eventBus.emit('key:options', e);
                    break;

                case TIZEN_KEYS.CHANNEL_UP:
                    eventBus.emit('key:channelUp', e);
                    break;

                case TIZEN_KEYS.CHANNEL_DOWN:
                    eventBus.emit('key:channelDown', e);
                    break;

                default:
                    // Emit generic key event with code
                    eventBus.emit('key:any', { keyCode, event: e });
                    break;
            }
        });

        log.info('Key handler setup');
    }

    /**
     * Get device information
     * @private
     */
    _getDeviceInfo() {
        if (!this._isTizen) {
            this._deviceInfo = {
                model: 'Browser',
                platform: 'Web',
                resolution: {
                    width: window.innerWidth,
                    height: window.innerHeight
                }
            };
            return;
        }

        try {
            // Get display info
            tizen.systeminfo.getPropertyValue('DISPLAY', (display) => {
                this._deviceInfo = {
                    resolution: {
                        width: display.resolutionWidth,
                        height: display.resolutionHeight
                    }
                };

                // Check for 4K/8K support
                if (typeof webapis !== 'undefined' && webapis.productinfo) {
                    try {
                        if (webapis.productinfo.is8KPanelSupported && webapis.productinfo.is8KPanelSupported()) {
                            this._deviceInfo.maxResolution = '8K';
                        } else if (webapis.productinfo.isUdPanelSupported && webapis.productinfo.isUdPanelSupported()) {
                            this._deviceInfo.maxResolution = '4K';
                        } else {
                            this._deviceInfo.maxResolution = 'FHD';
                        }
                    } catch (e) {
                        this._deviceInfo.maxResolution = 'Unknown';
                    }
                }

                log.info('Device info (Physical):', this._deviceInfo);

                const manualRes = storage.getItem('player:maxResolution');
                if (manualRes && manualRes !== 'auto') {
                    log.info(`⚠️ MANUAL RESOLUTION OVERRIDE ACTIVE: ${manualRes}`);
                }
            });
        } catch (e) {
            log.error('Failed to get device info:', e);
        }
    }

    /**
     * Exit the application
     */
    exit() {
        if (this._isTizen) {
            // Flush all pending storage writes to disk before exiting.
            // On Tizen 9.0+, Chromium 120 aggressively throttles background timers,
            // so the debounced flush may never fire if the app is suspended. Without
            // this explicit flush, critical keys (server URL, auth tokens) can be lost,
            // causing the app to start fresh on next launch.
            storage.flush();
            try {
                tizen.application.getCurrentApplication().exit();
            } catch (e) {
                log.error('Failed to exit:', e);
            }
        } else {
            log.info('Exit requested (browser mode - no action)');
        }
    }

    /**
     * Check if running on Tizen
     * @returns {boolean} True if on Tizen platform
     */
    isTizen() {
        return this._isTizen;
    }

    /**
     * Get the current Tizen platform version as a float (e.g. 5.0, 4.0, 3.0).
     *
     * Reads the platform.version capability once and caches the result on
     * _tizenVersion (already initialised to null in the constructor) so
     * subsequent calls are free lookups.
     *
     * Returns 0 when not running on Tizen or when the capability API throws.
     *
     * @returns {number} Tizen version as a float, or 0 if unavailable.
     */
    getTizenVersion() {
        /* Non-Tizen environment — return sentinel zero immediately. */
        if (!this._isTizen) return 0;

        /* Return the cached value from a previous call. */
        if (this._tizenVersion !== null) return this._tizenVersion;

        try {
            const raw = tizen.systeminfo.getCapability('http://tizen.org/feature/platform.version');
            this._tizenVersion = parseFloat(raw) || 0;
        } catch (e) {
            log.warn('Could not read Tizen platform version:', e);
            this._tizenVersion = 0;
        }

        return this._tizenVersion;
    }

    /**
     * Get device info
     * @returns {Object} Device information
     */
    getDeviceInfo() {
        return this._deviceInfo;
    }

    /**
     * Get device name
     * @returns {string} Device name (e.g. "Samsung Smart TV" or "Web Browser")
     */
    getDeviceName() {
        if (this._isTizen) {
            // Could try to get specific model if needed, but "Samsung Smart TV" is standard
            return 'Samsung Smart TV';
        }
        return 'Web Browser';
    }

    /**
     * Get device manufacturer
     * @returns {string} Manufacturer name
     */
    getManufacturer() {
        if (this._isTizen) {
            return 'Samsung';
        }
        return 'Generic';
    }

    /**
     * Get key codes map
     * @returns {Object} Key code constants
     */
    getKeyCodes() {
        return { ...TIZEN_KEYS };
    }
    /**
     * Get device IP address
     * @returns {Promise<string|null>} IP address (IPv4) or null
     */
    getIPAddress() {
        return new Promise((resolve) => {
            if (!this._isTizen) {
                resolve(null); // Browser - can't get local IP easily
                return;
            }

            try {
                tizen.systeminfo.getPropertyValue(
                    'NETWORK',
                    (network) => {
                        resolve(network.ipAddress || null);
                    },
                    (error) => {
                        log.warn('Failed to get network info', error);
                        resolve(null);
                    }
                );
            } catch (e) {
                log.error('Error getting IP:', e);
                resolve(null);
            }
        });
    }

    /**
     * Launch the native YouTube application on Samsung Tizen TVs and navigate
     * directly to the specified video.
     *
     * Tries known YouTube App IDs first. If the launch fails (app not installed,
     * or running in browser dev mode), falls back to opening the standard
     * YouTube URL in a browser tab.
     *
     * @param {string} videoId - The YouTube video ID (e.g. "dQw4w9WgXcQ")
     */
    launchYouTube(videoId) {
        if (!videoId) return;

        /* ── Browser / dev fallback ─────────────────────────────────────── */
        if (!this._isTizen) {
            log.info('launchYouTube: not on Tizen, opening browser tab');
            window.open(`https://www.youtube.com/watch?v=${videoId}`, '_blank');
            return;
        }

        log.info(`launchYouTube: launching YouTube app for videoId=${videoId}`);

        /* The ApplicationControl paired with the 111299001912 ID requires the 
           URL to be passed as ApplicationControlData rather than the main URI
           argument, otherwise the YouTube app fails to parse it and opens 
           the browser instead. */
        const appControl = new tizen.ApplicationControl(
            'http://tizen.org/appcontrol/operation/view',
            null, // uri
            null, // mime
            null, // category
            [
                new tizen.ApplicationControlData('http://tizen.org/appcontrol/data/url', [
                    `https://www.youtube.com/watch?v=${videoId}`
                ])
            ]
        );

        // Sequence of app IDs to try.
        // 111299001912 is standard Smart TV YouTube.
        // 9Ur5IzDKqV.TizenYouTube is an alternate reported on some sets.
        const appIds = ['111299001912', '9Ur5IzDKqV.TizenYouTube'];
        let currentTry = 0;

        const tryNextApp = () => {
            if (currentTry >= appIds.length) {
                // All known explicit App IDs failed.
                log.warn('launchYouTube: all explicit app IDs failed, falling back to browser');
                window.open(`https://www.youtube.com/watch?v=${videoId}`, '_blank');
                return;
            }

            const appId = appIds[currentTry];
            currentTry++;

            try {
                tizen.application.launchAppControl(
                    appControl,
                    appId,
                    () => log.info(`launchYouTube: successfully launched app ${appId}`),
                    (err) => {
                        log.warn(`launchYouTube: failed to launch ${appId}`, err);
                        tryNextApp();
                    }
                );
            } catch (e) {
                log.warn(`launchYouTube: exception launching ${appId}`, e);
                tryNextApp();
            }
        };

        tryNextApp();
    }
}

// Export singleton instance
export const tizenAdapter = new TizenAdapter();

// Also export constants
export { TIZEN_KEYS };

export default TizenAdapter;
