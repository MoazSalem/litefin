/**
 * ============================================================================
 * Litefin - Web Platform Adapter
 * ============================================================================
 * Handles browser-specific functionality when running Litefin inside standard
 * modern web browsers (Chrome, Firefox, Safari, Edge):
 * - Physical keyboard shortcut mappings (D-Pad, Media keys, Fullscreen F11, Shortcuts)
 * - HTML5 Fullscreen API management
 * - Web browser and client device identification for Jellyfin session authorization
 * - User idle tracking for screensavers and sleep timers
 * - Mouse, pointer, and touch activity reporting
 * ============================================================================
 */

import { eventBus } from '../core/EventBus.js';
import { storage } from '../utils/StorageService.js';
import { logger } from '../utils/Logger.js';

// Initialize dedicated logger for Web adapter events
const log = logger.create('WebAdapter');

// ============================================================================
// Standard Keyboard Key Code Mappings for Web Browsers
// ============================================================================
const WEB_KEYS = {
    // Spatial navigation controls (Arrow keys and Enter)
    LEFT: 37,
    UP: 38,
    RIGHT: 39,
    DOWN: 40,
    ENTER: 13,

    // Navigation and cancellation keys
    ESCAPE: 27,
    BACKSPACE: 8,

    // Playback control keys
    SPACE: 32,

    // Fullscreen toggle key
    F11: 122,

    // Standard media keys on multimedia keyboards
    MEDIA_PLAY: 415,
    MEDIA_PAUSE: 19,
    MEDIA_PLAY_PAUSE: 179,
    MEDIA_PLAY_PAUSE_ALT: 85,
    MEDIA_STOP: 178,
    MEDIA_NEXT: 176,
    MEDIA_NEXT_ALT: 87,
    MEDIA_PREV: 177,
    MEDIA_PREV_ALT: 88,
    FAST_FORWARD: 228,
    REWIND: 227
};

class WebAdapter {
    constructor() {
        // Enforce singleton initialization lifecycle
        this._initialized = false;

        // Cached human-readable browser model name
        this._deviceName = null;

        // Tracks timestamp of last user interaction for screensaver coordination
        this._lastInputTime = Date.now();
    }

    /**
     * ========================================================================
     * Web Adapter Bootstrap
     * ========================================================================
     * Invoked during App.init() startup sequence when running in a web browser.
     * Hooks window listeners and input event processors.
     * ========================================================================
     */
    init() {
        // Prevent duplicate initialization sequences
        if (this._initialized) {
            log.warn('WebAdapter already initialized, skipping bootstrap.');
            return;
        }
        this._initialized = true;

        log.info('Initializing WebAdapter for standard browser runtime...');

        // Expose adapter reference on global window for runtime debugging
        if (typeof window !== 'undefined') {
            window.webAdapter = this;
        }

        // Initialize interaction timer baseline
        this._lastInputTime = Date.now();

        // Register global physical keyboard handler
        this._setupKeyHandler();

        // Register pointer, mouse, touch, and wheel listeners to report user activity
        document.addEventListener('mousemove', () => this.reportInput(), { passive: true });
        document.addEventListener('mousedown', () => this.reportInput(), { passive: true });
        document.addEventListener('touchstart', () => this.reportInput(), { passive: true });
        document.addEventListener('wheel', () => this.reportInput(), { passive: true });

        // Query browser platform device identity
        this._loadDeviceInfo();

        log.info('WebAdapter successfully initialized.');
    }

    /**
     * Retrieves idle duration in milliseconds since the last recorded interaction.
     * @returns {number} Idle duration in ms.
     */
    get idleTime() {
        return Date.now() - (this._lastInputTime || Date.now());
    }

    /**
     * Reports an active user input interaction to reset idle/screensaver timers.
     */
    reportInput() {
        this._lastInputTime = Date.now();
    }

    /**
     * @returns {boolean} True indicating this is a standard web browser runtime.
     */
    get isWeb() {
        return true;
    }

    /**
     * ========================================================================
     * Physical Keyboard Handler
     * ========================================================================
     * Listens for physical keyboard events in the browser:
     * - Maps Arrow keys to directional spatial navigation events.
     * - Intercepts F11 (and player shortcut 'F') for HTML5 fullscreen toggling.
     * - Maps Escape and Backspace to unified back navigation.
     * - Maps Space and standard media keys to playback controls.
     * - Provides YouTube/VLC-style J/K/L/M player shortcut keys.
     * ========================================================================
     * @private
     */
    _setupKeyHandler() {
        document.addEventListener('keydown', (e) => {
            // Register interaction timestamp immediately
            this.reportInput();

            const keyCode = e.keyCode;
            const key = e.key;

            // -----------------------------------------------------------------
            // 1. F11 Fullscreen Toggle Shortcut
            // -----------------------------------------------------------------
            // F11 should toggle HTML5 fullscreen unconditionally from anywhere.
            if (keyCode === WEB_KEYS.F11 || key === 'F11') {
                e.preventDefault();
                this.toggleFullscreen();
                return;
            }

            // Identify whether user is actively typing inside an input or textarea
            const activeElem = document.activeElement;
            const isTextInput =
                activeElem &&
                ((activeElem.tagName === 'INPUT' && activeElem.type !== 'range') || activeElem.tagName === 'TEXTAREA');

            // Detect if video player is currently active in view
            const isPlayerActive = window.location.hash.startsWith('#/player');

            // -----------------------------------------------------------------
            // 2. Directional and Navigation Key Suppression
            // -----------------------------------------------------------------
            // Prevent default browser scrolling when browsing outside form inputs
            if (!isTextInput) {
                const navKeys = [
                    WEB_KEYS.LEFT,
                    WEB_KEYS.RIGHT,
                    WEB_KEYS.UP,
                    WEB_KEYS.DOWN,
                    WEB_KEYS.ENTER
                ];

                // Suppress browser page scroll on Space bar when player is rendering
                if (isPlayerActive && keyCode === WEB_KEYS.SPACE) {
                    navKeys.push(WEB_KEYS.SPACE);
                }

                if (navKeys.includes(keyCode)) {
                    e.preventDefault();
                }
            }

            // -----------------------------------------------------------------
            // 3. Player-Specific Web Keyboard Shortcuts (J / K / L / M / F)
            // -----------------------------------------------------------------
            // Standard media player conventions enabled only when player is active
            // and user is not focused on a text input element.
            if (isPlayerActive && !isTextInput && !e.ctrlKey && !e.altKey && !e.metaKey) {
                switch (key) {
                    // Play / Pause toggle ('k' or 'K')
                    case 'k':
                    case 'K':
                        e.preventDefault();
                        eventBus.emit('key:playPause', e);
                        return;

                    // Skip backward / rewind ('j' or 'J')
                    case 'j':
                    case 'J':
                        e.preventDefault();
                        eventBus.emit('key:rewind', e);
                        return;

                    // Skip forward / fast-forward ('l' or 'L')
                    case 'l':
                    case 'L':
                        e.preventDefault();
                        eventBus.emit('key:fastForward', e);
                        return;

                    // Mute toggle ('m' or 'M')
                    case 'm':
                    case 'M':
                        e.preventDefault();
                        eventBus.emit('remote:togglemute');
                        return;

                    // Fullscreen toggle ('f' or 'F')
                    case 'f':
                    case 'F':
                        e.preventDefault();
                        this.toggleFullscreen();
                        return;

                    default:
                        break;
                }
            }

            // -----------------------------------------------------------------
            // 4. Central Key Mapping Switch
            // -----------------------------------------------------------------
            switch (keyCode) {
                // Space bar play/pause toggle when player view is active
                case WEB_KEYS.SPACE:
                    if (!isTextInput && isPlayerActive) {
                        e.preventDefault();
                        eventBus.emit('key:playPause', e);
                    }
                    break;

                // Directional D-Pad navigation
                case WEB_KEYS.LEFT:
                    eventBus.emit('key:left', e);
                    break;
                case WEB_KEYS.RIGHT:
                    eventBus.emit('key:right', e);
                    break;
                case WEB_KEYS.UP:
                    eventBus.emit('key:up', e);
                    break;
                case WEB_KEYS.DOWN:
                    eventBus.emit('key:down', e);
                    break;

                // Enter / Selection
                case WEB_KEYS.ENTER:
                    eventBus.emit('key:enter', e);
                    break;

                // Escape always triggers back navigation
                case WEB_KEYS.ESCAPE:
                    e.preventDefault();
                    eventBus.emit('key:back', e);
                    break;

                // Backspace acts as Back when outside text input fields
                case WEB_KEYS.BACKSPACE:
                    if (!isTextInput) {
                        e.preventDefault();
                        eventBus.emit('key:back', e);
                    }
                    break;

                // Media Play / Pause keys
                case WEB_KEYS.MEDIA_PLAY:
                    e.preventDefault();
                    eventBus.emit('key:play', e);
                    break;

                case WEB_KEYS.MEDIA_PAUSE:
                    e.preventDefault();
                    eventBus.emit('key:pause', e);
                    break;

                case WEB_KEYS.MEDIA_PLAY_PAUSE:
                case WEB_KEYS.MEDIA_PLAY_PAUSE_ALT:
                    e.preventDefault();
                    eventBus.emit('key:playPause', e);
                    break;

                case WEB_KEYS.MEDIA_STOP:
                    e.preventDefault();
                    eventBus.emit('key:stop', e);
                    break;

                // Media Next / Previous track keys
                case WEB_KEYS.MEDIA_NEXT:
                case WEB_KEYS.MEDIA_NEXT_ALT:
                    e.preventDefault();
                    eventBus.emit('key:next', e);
                    break;

                case WEB_KEYS.MEDIA_PREV:
                case WEB_KEYS.MEDIA_PREV_ALT:
                    e.preventDefault();
                    eventBus.emit('key:previous', e);
                    break;

                // Media Seek / Rewind keys
                case WEB_KEYS.REWIND:
                    e.preventDefault();
                    eventBus.emit('key:rewind', e);
                    break;

                case WEB_KEYS.FAST_FORWARD:
                    e.preventDefault();
                    eventBus.emit('key:fastForward', e);
                    break;

                default:
                    // Broadcast generic key for unmapped or custom bindings
                    eventBus.emit('key:any', { keyCode, event: e });
                    break;
            }
        });
    }

    /**
     * ========================================================================
     * HTML5 Fullscreen API Toggle
     * ========================================================================
     * Toggles between standard viewport and HTML5 fullscreen display.
     * ========================================================================
     * @returns {Promise<boolean>} True if now fullscreen, false otherwise.
     */
    async toggleFullscreen() {
        try {
            if (typeof document !== 'undefined') {
                if (document.fullscreenElement || document.webkitFullscreenElement) {
                    if (document.exitFullscreen) {
                        await document.exitFullscreen();
                    } else if (document.webkitExitFullscreen) {
                        await document.webkitExitFullscreen();
                    }
                    eventBus.emit('window:fullscreen', false);
                    return false;
                } else {
                    const docEl = document.documentElement;
                    if (docEl.requestFullscreen) {
                        await docEl.requestFullscreen();
                    } else if (docEl.webkitRequestFullscreen) {
                        await docEl.webkitRequestFullscreen();
                    }
                    eventBus.emit('window:fullscreen', true);
                    return true;
                }
            }
        } catch (err) {
            log.warn('Web HTML5 fullscreen toggle failed:', err);
        }

        return false;
    }

    /**
     * ========================================================================
     * Device Information Discovery
     * ========================================================================
     * Identifies the web browser brand and platform from user agent tokens.
     * @private
     */
    _loadDeviceInfo() {
        if (typeof navigator === 'undefined') {
            this._deviceName = 'Litefin Web';
            return;
        }

        const ua = navigator.userAgent;
        let browserName = 'Browser';

        if (/Edg\//i.test(ua)) {
            browserName = 'Edge';
        } else if (/Chrome\//i.test(ua)) {
            browserName = 'Chrome';
        } else if (/Firefox\//i.test(ua)) {
            browserName = 'Firefox';
        } else if (/Safari\//i.test(ua) && !/Chrome/i.test(ua)) {
            browserName = 'Safari';
        }

        this._deviceName = `Litefin Web (${browserName})`;
        log.info(`Detected web platform: ${this._deviceName}`);
    }

    /**
     * Retrieves the human-readable device name for Jellyfin authorization.
     * @returns {string} Device name identifier.
     */
    getDeviceName() {
        if (!this._deviceName) {
            this._loadDeviceInfo();
        }
        return this._deviceName || 'Litefin Web';
    }

    /**
     * ========================================================================
     * Application Exit Handler
     * ========================================================================
     * Flushes pending storage state to disk and attempts to close the web tab.
     */
    exit() {
        log.info('Exiting web application...');

        // Flush storage memory cache to disk immediately
        storage.flush();

        // Standard browser window close
        if (typeof window !== 'undefined') {
            window.close();
        }
    }
}

// Export singleton instance and class definition
export const webAdapter = new WebAdapter();
export default webAdapter;
