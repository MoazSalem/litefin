/**
 * ============================================================================
 * Litefin - Desktop Platform Adapter
 * ============================================================================
 * Handles all desktop-specific functionality across packaged desktop runtime
 * shells (Tauri v2 on Windows, macOS, Linux):
 * - Physical keyboard shortcut mappings (D-Pad, Media keys, Fullscreen F11, Shortcuts)
 * - Native window management (Fullscreen toggle, Window close / application exit)
 * - Hardware and desktop operating system device identification
 * - User idle tracking for screensavers and sleep timers
 * - Mouse and trackpad pointer activity reporting
 * ============================================================================
 */

import { eventBus } from '../core/EventBus.js';
import { storage } from '../utils/StorageService.js';
import { logger } from '../utils/Logger.js';
import { gamepadManager } from '../utils/GamepadManager.js';
import { mouseRowScroller } from '../ui/MouseRowScroller.js';

// Initialize dedicated logger for Desktop adapter events
const log = logger.create('DesktopAdapter');

// ============================================================================
// Standard Keyboard Key Code Mappings for Desktop
// ============================================================================
const DESKTOP_KEYS = {
    // Spatial navigation controls (Arrow keys and Enter)
    LEFT: 37,
    UP: 38,
    RIGHT: 39,
    DOWN: 40,
    ENTER: 13,

    // Navigation and dialog cancellation keys
    ESCAPE: 27,
    BACKSPACE: 8,
    TAB: 9,

    // Playback control keys
    SPACE: 32,

    // Function keys
    F11: 122,

    // Standard media keys on physical desktop multimedia keyboards
    MEDIA_PLAY: 415,
    MEDIA_PAUSE: 19,
    MEDIA_PLAY_PAUSE: 179,
    MEDIA_STOP: 178,
    MEDIA_NEXT: 176,
    MEDIA_PREV: 177,
    FAST_FORWARD: 228,
    REWIND: 227
};

class DesktopAdapter {
    constructor() {
        // Enforce singleton initialization lifecycle
        this._initialized = false;

        // Cached human-readable OS device name
        this._deviceName = null;

        // Tracks timestamp of last user input for screensaver coordination
        this._lastInputTime = Date.now();
    }

    /**
     * ========================================================================
     * Desktop Adapter Bootstrap
     * ========================================================================
     * Invoked during App.init() startup sequence when running in desktop mode.
     * Hooks window listeners and input event processors.
     * ========================================================================
     */
    init() {
        // Prevent duplicate initialization sequences
        if (this._initialized) {
            log.warn('DesktopAdapter already initialized, skipping bootstrap.');
            return;
        }
        this._initialized = true;

        log.info('Initializing DesktopAdapter for native desktop runtime...');

        // Expose adapter reference on global window for runtime inspection
        if (typeof window !== 'undefined') {
            window.desktopAdapter = this;
        }

        // Initialize interaction timer baseline
        this._lastInputTime = Date.now();

        // Register global physical keyboard handler
        this._setupKeyHandler();

        // Initialize gamepad and controller navigation subsystem (Xbox, DualShock/DualSense, 8BitDo)
        gamepadManager.init({
            onActivity: () => this.reportInput(),
            onFullscreen: () => this.toggleFullscreen()
        });

        // Register pointer, mouse, and wheel listeners to report user activity
        document.addEventListener('mousemove', () => this.reportInput(), { passive: true });
        document.addEventListener('mousedown', () => this.reportInput(), { passive: true });
        document.addEventListener('wheel', () => this.reportInput(), { passive: true });

        // Enable mouse wheel / trackpad horizontal scrolling of media rows
        mouseRowScroller.init();

        // Synchronize HTML5 fullscreen changes with desktop runtime state
        document.addEventListener('fullscreenchange', () => {
            const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
            this._isFullscreen = isFs;
            eventBus.emit('window:fullscreen', isFs);
        });

        // Query desktop platform device identity
        this._loadDeviceInfo();

        log.info('DesktopAdapter successfully initialized.');
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
     * @returns {boolean} True indicating this is a native desktop runtime.
     */
    get isDesktop() {
        return true;
    }

    /**
     * ========================================================================
     * Physical Keyboard Handler
     * ========================================================================
     * Listens for physical keyboard events across the entire application:
     * - Maps Arrow keys to directional spatial navigation events.
     * - Intercepts F11 (and player shortcut 'F') for fullscreen toggling.
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
            // F11 should toggle windowed fullscreen unconditionally from anywhere.
            if (keyCode === DESKTOP_KEYS.F11 || key === 'F11') {
                e.preventDefault();
                this.toggleFullscreen();
                return;
            }

            // Identify whether user is actively typing inside an input or textarea
            const activeElem = document.activeElement;
            const isTextInput =
                Boolean(activeElem) &&
                (activeElem.tagName === 'TEXTAREA' ||
                    activeElem.isContentEditable ||
                    (activeElem.tagName === 'INPUT' &&
                        !['range', 'checkbox', 'radio', 'button', 'submit', 'reset'].includes(activeElem.type)));

            // -----------------------------------------------------------------
            // Form Input Field Guard: Allow All Letters and Characters
            // -----------------------------------------------------------------
            // When user is typing inside an input field, textarea, or editable element,
            // never intercept or suppress any typing, editing, navigation, or letter keys.
            // Allow all characters (including W, X, U, etc.) to be typed unimpeded.
            if (isTextInput) {
                // F11 should toggle windowed fullscreen unconditionally from anywhere.
                if (keyCode === DESKTOP_KEYS.F11 || key === 'F11') {
                    e.preventDefault();
                    this.toggleFullscreen();
                    return;
                }

                // Escape always triggers back navigation / dialog dismissal
                if (keyCode === DESKTOP_KEYS.ESCAPE || key === 'Escape') {
                    e.preventDefault();
                    eventBus.emit('key:back', e);
                    return;
                }

                // Let all other keys (letters, digits, backspace, enter, arrows, etc.)
                // pass through to native text input handling without interference.
                return;
            }

            // Detect if video player is currently active in view
            const isPlayerActive = window.location.hash.startsWith('#/player');

            // -----------------------------------------------------------------
            // 2. Directional and Navigation Key Suppression
            // -----------------------------------------------------------------
            // Prevent default browser scrolling when browsing outside form inputs
            if (!isTextInput) {
                const navKeys = [
                    DESKTOP_KEYS.LEFT,
                    DESKTOP_KEYS.RIGHT,
                    DESKTOP_KEYS.UP,
                    DESKTOP_KEYS.DOWN,
                    DESKTOP_KEYS.ENTER
                ];

                // Suppress browser page scroll on Space bar when player is rendering
                if (isPlayerActive && keyCode === DESKTOP_KEYS.SPACE) {
                    navKeys.push(DESKTOP_KEYS.SPACE);
                }

                if (navKeys.includes(keyCode)) {
                    e.preventDefault();
                }
            }

            // -----------------------------------------------------------------
            // 3. Player-Specific Desktop Keyboard Shortcuts (J / K / L / M / F)
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

                    /*
                     * =================================================================
                     * Escape / Esc Fullscreen Dismissal Override
                     * =================================================================
                     * When player is actively rendering in fullscreen mode, pressing
                     * Escape disables fullscreen back to windowed mode without exiting
                     * the player or navigating backward.
                     *
                     * Exception: If a selection modal (subtitles, audio, settings) is
                     * currently open, let Escape pass through to back handler to dismiss
                     * the menu popup first.
                     * =================================================================
                     */
                    case 'Escape':
                    case 'Esc':
                        if (this.isFullscreen()) {
                            // If a modal or menu popup is active, let back close the modal first
                            if (
                                document.querySelector(
                                    '.track-menu.visible, .settings-menu.visible, .modal.visible, .osd-menu.visible'
                                )
                            ) {
                                break;
                            }
                            e.preventDefault();
                            this.toggleFullscreen();
                            return;
                        }
                        break;

                    // Volume increase shortcut (ArrowUp)
                    case 'ArrowUp':
                    case 'Up':
                        // Only intercept when no modal popup or selection menu is open in view
                        if (
                            !document.querySelector(
                                '.track-menu.visible, .settings-menu.visible, .modal.visible, .osd-menu.visible'
                            )
                        ) {
                            e.preventDefault();
                            eventBus.emit('remote:volumeup');
                            return;
                        }
                        break;

                    // Volume decrease shortcut (ArrowDown)
                    case 'ArrowDown':
                    case 'Down':
                        // Only intercept when no modal popup or selection menu is open in view
                        if (
                            !document.querySelector(
                                '.track-menu.visible, .settings-menu.visible, .modal.visible, .osd-menu.visible'
                            )
                        ) {
                            e.preventDefault();
                            eventBus.emit('remote:volumedown');
                            return;
                        }
                        break;

                    default:
                        break;
                }
            }

            // -----------------------------------------------------------------
            // 4. Central Key Mapping Switch
            // -----------------------------------------------------------------
            switch (keyCode) {
                // Space bar play/pause toggle when player view is active
                case DESKTOP_KEYS.SPACE:
                    if (!isTextInput && isPlayerActive) {
                        e.preventDefault();
                        eventBus.emit('key:playPause', e);
                    }
                    break;

                // Directional D-Pad navigation
                case DESKTOP_KEYS.LEFT:
                    eventBus.emit('key:left', e);
                    break;
                case DESKTOP_KEYS.RIGHT:
                    eventBus.emit('key:right', e);
                    break;
                case DESKTOP_KEYS.UP:
                    eventBus.emit('key:up', e);
                    break;
                case DESKTOP_KEYS.DOWN:
                    eventBus.emit('key:down', e);
                    break;

                // Enter / Selection
                case DESKTOP_KEYS.ENTER:
                    eventBus.emit('key:enter', e);
                    break;

                // Escape always triggers back navigation
                case DESKTOP_KEYS.ESCAPE:
                    e.preventDefault();
                    eventBus.emit('key:back', e);
                    break;

                // Backspace acts as Back when outside text input fields
                case DESKTOP_KEYS.BACKSPACE:
                    if (!isTextInput) {
                        e.preventDefault();
                        eventBus.emit('key:back', e);
                    }
                    break;

                // Media Play / Pause keys
                case DESKTOP_KEYS.MEDIA_PLAY:
                    e.preventDefault();
                    eventBus.emit('key:play', e);
                    break;

                case DESKTOP_KEYS.MEDIA_PAUSE:
                    e.preventDefault();
                    eventBus.emit('key:pause', e);
                    break;

                case DESKTOP_KEYS.MEDIA_PLAY_PAUSE:
                    e.preventDefault();
                    eventBus.emit('key:playPause', e);
                    break;

                case DESKTOP_KEYS.MEDIA_STOP:
                    e.preventDefault();
                    eventBus.emit('key:stop', e);
                    break;

                // Media Next / Previous track keys
                case DESKTOP_KEYS.MEDIA_NEXT:
                    e.preventDefault();
                    eventBus.emit('key:next', e);
                    break;

                case DESKTOP_KEYS.MEDIA_PREV:
                    e.preventDefault();
                    eventBus.emit('key:previous', e);
                    break;

                // Media Seek / Rewind keys
                case DESKTOP_KEYS.REWIND:
                    e.preventDefault();
                    eventBus.emit('key:rewind', e);
                    break;

                case DESKTOP_KEYS.FAST_FORWARD:
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
     * Native Fullscreen Mode Toggle
     * ========================================================================
     * Toggles between windowed presentation and OS-level fullscreen mode.
     * Uses the native Tauri window management command and IPC plugin.
     * ========================================================================
     * @returns {Promise<boolean>} True if now fullscreen, false otherwise.
     */
    async toggleFullscreen() {
        // Inspect for presence of the Tauri IPC runtime bridge
        if (typeof window !== 'undefined' && (window.__TAURI_INTERNALS__ || window.__TAURI__)) {
            try {
                // Attempt native Rust command first if registered
                if (window.__TAURI_INTERNALS__?.invoke) {
                    try {
                        const newState = await window.__TAURI_INTERNALS__.invoke('toggle_fullscreen');
                        log.info(`Tauri fullscreen toggled via native command: ${newState}`);
                        this._isFullscreen = newState;
                        eventBus.emit('window:fullscreen', newState);
                        return newState;
                    } catch (_) {
                        // Fall back to Tauri v2 core window plugin IPC
                        const label = window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label || 'main';
                        const isFullscreen = await window.__TAURI_INTERNALS__.invoke('plugin:window|is_fullscreen', {
                            label
                        });
                        const nextState = !isFullscreen;
                        await window.__TAURI_INTERNALS__.invoke('plugin:window|set_fullscreen', {
                            label,
                            value: nextState
                        });
                        log.info(`Tauri fullscreen toggled via window plugin: ${nextState}`);
                        this._isFullscreen = nextState;
                        eventBus.emit('window:fullscreen', nextState);
                        return nextState;
                    }
                } else if (window.__TAURI__?.core?.invoke) {
                    try {
                        const newState = await window.__TAURI__.core.invoke('toggle_fullscreen');
                        log.info(`Tauri fullscreen toggled via core invoke: ${newState}`);
                        this._isFullscreen = newState;
                        eventBus.emit('window:fullscreen', newState);
                        return newState;
                    } catch (_) {
                        const label = 'main';
                        const isFullscreen = await window.__TAURI__.core.invoke('plugin:window|is_fullscreen', {
                            label
                        });
                        const nextState = !isFullscreen;
                        await window.__TAURI__.core.invoke('plugin:window|set_fullscreen', { label, value: nextState });
                        log.info(`Tauri fullscreen toggled via core window plugin: ${nextState}`);
                        this._isFullscreen = nextState;
                        eventBus.emit('window:fullscreen', nextState);
                        return nextState;
                    }
                }
            } catch (err) {
                log.error('Failed to toggle Tauri window fullscreen:', err);
            }
        }

        // Standard HTML5 fallback if running outside Tauri
        try {
            if (typeof document !== 'undefined') {
                if (document.fullscreenElement || document.webkitFullscreenElement) {
                    if (document.exitFullscreen) {
                        await document.exitFullscreen();
                    } else if (document.webkitExitFullscreen) {
                        await document.webkitExitFullscreen();
                    }
                    this._isFullscreen = false;
                    eventBus.emit('window:fullscreen', false);
                    return false;
                } else {
                    const docEl = document.documentElement;
                    if (docEl.requestFullscreen) {
                        await docEl.requestFullscreen();
                    } else if (docEl.webkitRequestFullscreen) {
                        await docEl.webkitRequestFullscreen();
                    }
                    this._isFullscreen = true;
                    eventBus.emit('window:fullscreen', true);
                    return true;
                }
            }
        } catch (err) {
            log.warn('Desktop HTML5 fullscreen toggle fallback failed:', err);
        }

        return false;
    }

    /**
     * ========================================================================
     * Fullscreen State Inspection
     * ========================================================================
     * Determines whether the desktop window is currently presented in
     * fullscreen mode, checking DOM fullscreen elements and internal Tauri state.
     * ========================================================================
     * @returns {boolean} True if in fullscreen mode, false otherwise.
     */
    isFullscreen() {
        // Query active document fullscreen elements across browser engines
        if (typeof document !== 'undefined' && (document.fullscreenElement || document.webkitFullscreenElement)) {
            return true;
        }

        // Return internal tracked state for native Tauri shell windows
        return !!this._isFullscreen;
    }

    /**
     * ========================================================================
     * Device Information Discovery
     * ========================================================================
     * Identifies the desktop host platform from user agent tokens.
     * @private
     */
    _loadDeviceInfo() {
        if (typeof navigator === 'undefined') {
            this._deviceName = 'Litefin Desktop';
            return;
        }

        const ua = navigator.userAgent;
        if (/Win32|Win64|Windows/i.test(ua)) {
            this._deviceName = 'Litefin Desktop (Windows)';
        } else if (/Macintosh|Mac OS X/i.test(ua)) {
            this._deviceName = 'Litefin Desktop (macOS)';
        } else if (/Linux/i.test(ua)) {
            this._deviceName = 'Litefin Desktop (Linux)';
        } else {
            this._deviceName = 'Litefin Desktop';
        }

        log.info(`Detected desktop platform: ${this._deviceName}`);
    }

    /**
     * Retrieves the human-readable device model name for Jellyfin authorization.
     * @returns {string} Device name identifier.
     */
    getDeviceName() {
        if (!this._deviceName) {
            this._loadDeviceInfo();
        }
        return this._deviceName || 'Litefin Desktop';
    }

    /**
     * ========================================================================
     * Application Exit Handler
     * ========================================================================
     * Flushes pending storage state to disk and closes the desktop window.
     */
    exit() {
        log.info('Exiting desktop application...');

        // Flush storage memory cache to disk immediately
        storage.flush();

        // 1. Terminate native Tauri desktop window
        if (typeof window !== 'undefined' && window.__TAURI_INTERNALS__?.invoke) {
            try {
                const label = window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label || 'main';
                window.__TAURI_INTERNALS__.invoke('plugin:window|close', { label }).catch(() => {
                    window.close();
                });
                return;
            } catch (_) {}
        }

        // 2. Standard window close fallback
        if (typeof window !== 'undefined') {
            window.close();
        }
    }
}

// Export singleton instance and class definition
export const desktopAdapter = new DesktopAdapter();
export default desktopAdapter;
