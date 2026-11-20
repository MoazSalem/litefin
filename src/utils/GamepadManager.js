/**
 * ============================================================================
 * Litefin - Gamepad & Controller Manager
 * ============================================================================
 * Provides unified, plug-and-play controller support across desktop shells
 * (Tauri v2 on Windows, macOS, Linux) and standard modern web browsers.
 *
 * Supported Hardware & Profiles:
 * - Microsoft Xbox Controllers (Xbox 360, Xbox One, Xbox Series X|S)
 * - Sony PlayStation Controllers (DualShock 4, DualSense PS5)
 * - 8BitDo Controllers (Ultimate, Pro 2, SN30 Pro in X-Input/Switch/D-Input)
 * - Nintendo Switch Pro Controllers & Joy-Cons
 * - Generic W3C Standard Gamepads (HID / Bluetooth / USB)
 *
 * Architecture Highlights:
 * - Zero-overhead polling: Only loops via requestAnimationFrame when >=1 pad is connected.
 * - Hardware deadzone filtering to completely eliminate analog stick drift.
 * - Tactile repeat timing: Immediate response, 380ms hold delay, 110ms auto-repeat.
 * - Bridges directly into Litefin EventBus (key:enter, key:back, key:playPause, etc.).
 * - Apple-style toast feedback on controller connect and disconnect.
 * ============================================================================
 */

import { eventBus } from '../core/EventBus.js';
import { toast } from '../ui/Toast.js';
import { logger } from './Logger.js';

// Dedicated logger instance for gamepad subsystem
const log = logger.create('GamepadManager');

// ============================================================================
// Controller Tuning & Physics Constants
// ============================================================================

// Minimum analog stick displacement before recognizing directional navigation
const ANALOG_DEADZONE = 0.4;

// Analog trigger threshold for recognizing LT / RT as button activations
const TRIGGER_THRESHOLD = 0.5;

// Milliseconds before a held directional stick/pad begins auto-repeating
const REPEAT_INITIAL_DELAY_MS = 380;

// Interval between subsequent repeat steps when holding directional controls
const REPEAT_INTERVAL_MS = 110;

// ============================================================================
// Standard Gamepad Button Indices (W3C Standard Gamepad Specification)
// ============================================================================
const GP_BUTTONS = {
    // Face button cluster
    A: 0, // Bottom (Xbox A, PS Cross, Nintendo B)
    B: 1, // Right (Xbox B, PS Circle, Nintendo A)
    X: 2, // Left (Xbox X, PS Square, Nintendo Y)
    Y: 3, // Top (Xbox Y, PS Triangle, Nintendo X)

    // Shoulder bumpers
    LB: 4, // Left bumper / L1
    RB: 5, // Right bumper / R1

    // Triggers
    LT: 6, // Left trigger / L2
    RT: 7, // Right trigger / R2

    // System navigation
    SELECT: 8, // Back / View / Share
    START: 9, // Start / Options / Menu

    // Stick clicks
    L3: 10, // Left stick press
    R3: 11, // Right stick press

    // Directional pad buttons
    DPAD_UP: 12,
    DPAD_DOWN: 13,
    DPAD_LEFT: 14,
    DPAD_RIGHT: 15,

    // Guide / Home
    GUIDE: 16 // Xbox Guide / PS Button / Home
};

class GamepadManager {
    constructor() {
        // Enforce single registration of event listeners
        this._initialized = false;

        // Animation frame handle for the active polling loop
        this._rafId = null;

        // Map of connected gamepads: index -> { id, name }
        this._connectedGamepads = new Map();

        // Previous button press states: gamepadIndex -> Map<buttonIndex, boolean>
        this._prevButtonStates = new Map();

        // Directional repeat tracker for D-Pad and Left Analog Stick
        this._directionState = {
            activeDir: null, // 'up' | 'down' | 'left' | 'right' | null
            nextRepeatTime: 0 // Timestamp in ms for next repeat event
        };

        // Callbacks supplied by the host adapter (DesktopAdapter or WebAdapter)
        this._onActivity = null;
        this._onFullscreen = null;

        // Pre-bind methods for browser event listener attachments
        this._onGamepadConnected = this._onGamepadConnected.bind(this);
        this._onGamepadDisconnected = this._onGamepadDisconnected.bind(this);
        this._poll = this._poll.bind(this);
    }

    /**
     * ========================================================================
     * Gamepad Manager Bootstrap
     * ========================================================================
     * Registers connection event listeners and begins monitoring for controllers.
     *
     * @param {Object} options
     * @param {Function} [options.onActivity] - Notifies host adapter of user interaction
     * @param {Function} [options.onFullscreen] - Toggles fullscreen mode on R3 click
     * ========================================================================
     */
    init(options = {}) {
        // Prevent duplicate initialization calls
        if (this._initialized) {
            log.warn('GamepadManager already initialized.');
            return;
        }

        // Verify Gamepad API support in current environment
        if (typeof window === 'undefined' || !('getGamepads' in navigator)) {
            log.info('Gamepad API is not supported in this runtime environment.');
            return;
        }

        this._initialized = true;
        this._onActivity = options.onActivity || null;
        this._onFullscreen = options.onFullscreen || null;

        log.info('Initializing GamepadManager for controller input handling...');

        // Register window listeners for hardware connection and disconnection
        window.addEventListener('gamepadconnected', this._onGamepadConnected);
        window.addEventListener('gamepaddisconnected', this._onGamepadDisconnected);

        // Detect any gamepads that were already plugged in prior to app load
        this._detectExistingGamepads();
    }

    /**
     * Inspects navigator.getGamepads() immediately on startup for existing controllers.
     * @private
     */
    _detectExistingGamepads() {
        try {
            const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
            let foundCount = 0;

            for (let i = 0; i < gamepads.length; i++) {
                const gp = gamepads[i];
                if (gp && gp.connected) {
                    const friendlyName = this._formatGamepadName(gp.id);
                    this._connectedGamepads.set(gp.index, {
                        id: gp.id,
                        name: friendlyName
                    });
                    this._prevButtonStates.set(gp.index, new Map());
                    foundCount++;
                    log.info(`Detected pre-connected controller at index ${gp.index}: ${friendlyName}`);
                }
            }

            // Start polling loop if controllers are present
            if (foundCount > 0) {
                this._startPolling();
            }
        } catch (err) {
            log.warn('Failed to query initial gamepads:', err);
        }
    }

    /**
     * ========================================================================
     * Gamepad Connection Handler
     * ========================================================================
     * Fired when a physical or Bluetooth controller is paired or plugged in.
     * @private
     */
    _onGamepadConnected(e) {
        const gp = e.gamepad;
        if (!gp) return;

        const friendlyName = this._formatGamepadName(gp.id);
        this._connectedGamepads.set(gp.index, {
            id: gp.id,
            name: friendlyName
        });
        this._prevButtonStates.set(gp.index, new Map());

        log.info(`Controller connected at index ${gp.index}: "${friendlyName}" (ID: ${gp.id})`);

        // Notify user with clean, polished Apple-style toast notification
        try {
            toast.show(`🎮 ${friendlyName} Connected`, 3500);
        } catch (_) {}

        // Ensure polling animation loop is running
        this._startPolling();

        // Immediately register interaction activity
        this._reportActivity();
    }

    /**
     * ========================================================================
     * Gamepad Disconnection Handler
     * ========================================================================
     * Fired when a controller is unplugged, turned off, or disconnected.
     * @private
     */
    _onGamepadDisconnected(e) {
        const gp = e.gamepad;
        if (!gp) return;

        const info = this._connectedGamepads.get(gp.index);
        const friendlyName = info ? info.name : this._formatGamepadName(gp.id);

        this._connectedGamepads.delete(gp.index);
        this._prevButtonStates.delete(gp.index);

        log.info(`Controller disconnected from index ${gp.index}: "${friendlyName}"`);

        // Display disconnection feedback to user
        try {
            toast.show(`🎮 ${friendlyName} Disconnected`, 2500);
        } catch (_) {}

        // Reset direction repeat if no controllers remain active
        if (this._connectedGamepads.size === 0) {
            this._stopPolling();
        }
    }

    /**
     * Starts the requestAnimationFrame polling loop if not already running.
     * @private
     */
    _startPolling() {
        if (this._rafId !== null) return;
        this._rafId = requestAnimationFrame(this._poll);
    }

    /**
     * Halts the requestAnimationFrame loop to ensure zero idle CPU usage.
     * @private
     */
    _stopPolling() {
        if (this._rafId !== null) {
            cancelAnimationFrame(this._rafId);
            this._rafId = null;
        }

        // Reset repeat state cleanly
        this._directionState.activeDir = null;
        this._directionState.nextRepeatTime = 0;
    }

    /**
     * ========================================================================
     * Central Frame Polling Loop
     * ========================================================================
     * Scans connected gamepads each frame for analog stick displacement and
     * button state transitions.
     * @private
     */
    _poll(timestamp) {
        // Exit if no gamepads remain registered
        if (this._connectedGamepads.size === 0) {
            this._stopPolling();
            return;
        }

        const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
        let combinedDir = null;

        for (let i = 0; i < gamepads.length; i++) {
            const gp = gamepads[i];
            if (!gp || !gp.connected) continue;

            // 1. Process directional inputs (D-Pad buttons & Left Analog Stick)
            const padDir = this._readDirectionalInput(gp);
            if (padDir && !combinedDir) {
                combinedDir = padDir;
            }

            // 2. Process edge-triggered action buttons (A, B, X, Y, Bumpers, Triggers)
            this._readButtonInputs(gp);
        }

        // Process spatial navigation cadence with repeat delay and steady rate
        this._handleDirectionalCadence(combinedDir, timestamp || performance.now());

        // Queue next frame iteration
        this._rafId = requestAnimationFrame(this._poll);
    }

    /**
     * Reads directional inputs from both the D-Pad and Left Analog Stick.
     * Priority is given to D-Pad if pressed, falling back to Left Stick.
     *
     * @param {Gamepad} gp - The active Gamepad object
     * @returns {'up'|'down'|'left'|'right'|null} Active directional intent
     * @private
     */
    _readDirectionalInput(gp) {
        const b = gp.buttons;
        const axes = gp.axes;

        // ---------------------------------------------------------------------
        // Check D-Pad Buttons (Standard indices 12, 13, 14, 15)
        // ---------------------------------------------------------------------
        if (b[GP_BUTTONS.DPAD_UP]?.pressed || b[GP_BUTTONS.DPAD_UP]?.value > 0.5) return 'up';
        if (b[GP_BUTTONS.DPAD_DOWN]?.pressed || b[GP_BUTTONS.DPAD_DOWN]?.value > 0.5) return 'down';
        if (b[GP_BUTTONS.DPAD_LEFT]?.pressed || b[GP_BUTTONS.DPAD_LEFT]?.value > 0.5) return 'left';
        if (b[GP_BUTTONS.DPAD_RIGHT]?.pressed || b[GP_BUTTONS.DPAD_RIGHT]?.value > 0.5) return 'right';

        // ---------------------------------------------------------------------
        // Check Left Analog Stick (Axes 0 for X, Axes 1 for Y) with Deadzone
        // ---------------------------------------------------------------------
        if (axes && axes.length >= 2) {
            const axisX = axes[0] || 0;
            const axisY = axes[1] || 0;

            // Stick tilted vertically
            if (Math.abs(axisY) > Math.abs(axisX)) {
                if (axisY < -ANALOG_DEADZONE) return 'up';
                if (axisY > ANALOG_DEADZONE) return 'down';
            } else {
                // Stick tilted horizontally
                if (axisX < -ANALOG_DEADZONE) return 'left';
                if (axisX > ANALOG_DEADZONE) return 'right';
            }
        }

        return null;
    }

    /**
     * Manages directional repeat timing for smooth, tactile console navigation.
     * Fires immediately upon press, waits for initial delay, then repeats steadily.
     *
     * @param {'up'|'down'|'left'|'right'|null} activeDir
     * @param {number} now - High-resolution timestamp
     * @private
     */
    _handleDirectionalCadence(activeDir, now) {
        const state = this._directionState;

        // Case 1: Direction has just changed or newly pressed
        if (activeDir && activeDir !== state.activeDir) {
            state.activeDir = activeDir;
            state.nextRepeatTime = now + REPEAT_INITIAL_DELAY_MS;

            this._fireDirection(activeDir);
            this._reportActivity();
            return;
        }

        // Case 2: Same direction is continuously held
        if (activeDir && activeDir === state.activeDir) {
            if (now >= state.nextRepeatTime) {
                state.nextRepeatTime = now + REPEAT_INTERVAL_MS;

                this._fireDirection(activeDir);
                this._reportActivity();
            }
            return;
        }

        // Case 3: Direction released
        if (!activeDir && state.activeDir) {
            state.activeDir = null;
            state.nextRepeatTime = 0;
        }
    }

    /**
     * Emits directional spatial navigation event through Litefin EventBus.
     * @private
     */
    _fireDirection(dir) {
        eventBus.emit(`key:${dir}`);
    }

    /**
     * Evaluates face, bumper, trigger, and system buttons.
     * Buttons are strictly edge-triggered (fired on press transition only).
     *
     * @param {Gamepad} gp - The active Gamepad object
     * @private
     */
    _readButtonInputs(gp) {
        const prevMap = this._prevButtonStates.get(gp.index);
        if (!prevMap) return;

        const b = gp.buttons;
        if (!b) return;

        // List of actionable buttons to test for edge transitions
        const buttonsToTest = [
            GP_BUTTONS.A,
            GP_BUTTONS.B,
            GP_BUTTONS.X,
            GP_BUTTONS.Y,
            GP_BUTTONS.LB,
            GP_BUTTONS.RB,
            GP_BUTTONS.LT,
            GP_BUTTONS.RT,
            GP_BUTTONS.SELECT,
            GP_BUTTONS.START,
            GP_BUTTONS.L3,
            GP_BUTTONS.R3,
            GP_BUTTONS.GUIDE
        ];

        for (let i = 0; i < buttonsToTest.length; i++) {
            const btnIdx = buttonsToTest[i];
            const btn = b[btnIdx];
            if (!btn) continue;

            const isPressed = btn.pressed || btn.value >= TRIGGER_THRESHOLD;
            const wasPressed = prevMap.get(btnIdx) || false;

            // Edge trigger: execute on rising edge (initial press)
            if (isPressed && !wasPressed) {
                this._handleButtonAction(btnIdx);
                this._reportActivity();
            }

            // Cache current state for the next frame
            prevMap.set(btnIdx, isPressed);
        }
    }

    /**
     * Dispatches action button events directly to Litefin's subsystem handlers.
     *
     * @param {number} btnIdx - W3C button index
     * @private
     */
    _handleButtonAction(btnIdx) {
        const isPlayerActive = typeof window !== 'undefined' && window.location.hash.startsWith('#/player');

        switch (btnIdx) {
            // -----------------------------------------------------------------
            // A Button (Bottom face button: Xbox A, PS Cross, Nintendo B)
            // -----------------------------------------------------------------
            // Primary confirmation and item activation (Select)
            case GP_BUTTONS.A:
                eventBus.emit('key:enter');
                break;

            // -----------------------------------------------------------------
            // B Button (Right face button: Xbox B, PS Circle, Nintendo A)
            // -----------------------------------------------------------------
            // Primary cancel, back navigation, or modal dismissal
            case GP_BUTTONS.B: {
                // If keyboard focus is trapped in an input element, release it
                const activeEl = document.activeElement;
                if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) {
                    activeEl.blur();
                }
                eventBus.emit('key:back');
                break;
            }

            // -----------------------------------------------------------------
            // X Button (Left face button: Xbox X, PS Square, Nintendo Y)
            // -----------------------------------------------------------------
            // Quick Play / Play-Pause toggle
            case GP_BUTTONS.X:
                eventBus.emit('key:playPause');
                break;

            // -----------------------------------------------------------------
            // Y Button (Top face button: Xbox Y, PS Triangle, Nintendo X)
            // -----------------------------------------------------------------
            // Search shortcut when browsing, or OSD toggle in player
            case GP_BUTTONS.Y:
                if (isPlayerActive) {
                    eventBus.emit('key:playPause');
                } else if (typeof window !== 'undefined') {
                    window.location.hash = '#/search';
                }
                break;

            // -----------------------------------------------------------------
            // Left Bumper (LB / L1)
            // -----------------------------------------------------------------
            // Media track skip backward or chapter seek
            case GP_BUTTONS.LB:
                if (isPlayerActive) {
                    eventBus.emit('key:rewind');
                } else {
                    eventBus.emit('key:previous');
                }
                break;

            // -----------------------------------------------------------------
            // Right Bumper (RB / R1)
            // -----------------------------------------------------------------
            // Media track skip forward or chapter seek
            case GP_BUTTONS.RB:
                if (isPlayerActive) {
                    eventBus.emit('key:fastForward');
                } else {
                    eventBus.emit('key:next');
                }
                break;

            // -----------------------------------------------------------------
            // Left Trigger (LT / L2) & Right Trigger (RT / R2)
            // -----------------------------------------------------------------
            // High-speed scrubbing / rewind & fast-forward
            case GP_BUTTONS.LT:
                eventBus.emit('key:rewind');
                break;

            case GP_BUTTONS.RT:
                eventBus.emit('key:fastForward');
                break;

            // -----------------------------------------------------------------
            // Back / Select / View & Guide
            // -----------------------------------------------------------------
            case GP_BUTTONS.SELECT:
            case GP_BUTTONS.GUIDE:
                eventBus.emit('key:back');
                break;

            // -----------------------------------------------------------------
            // Start / Options / Menu
            // -----------------------------------------------------------------
            // Universal Play / Pause toggle
            case GP_BUTTONS.START:
                eventBus.emit('key:playPause');
                break;

            // -----------------------------------------------------------------
            // Left Stick Click (L3)
            // -----------------------------------------------------------------
            // Audio mute toggle
            case GP_BUTTONS.L3:
                eventBus.emit('remote:togglemute');
                break;

            // -----------------------------------------------------------------
            // Right Stick Click (R3)
            // -----------------------------------------------------------------
            // Fullscreen toggle
            case GP_BUTTONS.R3:
                if (typeof this._onFullscreen === 'function') {
                    this._onFullscreen();
                } else {
                    eventBus.emit('window:fullscreen');
                }
                break;

            default:
                break;
        }
    }

    /**
     * Reports an active user input interaction to reset idle/screensaver timers.
     * @private
     */
    _reportActivity() {
        if (typeof this._onActivity === 'function') {
            try {
                this._onActivity();
            } catch (_) {}
        }
    }

    /**
     * Transforms raw Gamepad ID strings from browsers into clean, branded labels.
     *
     * @param {string} rawId - e.g. "Xbox Wireless Controller (STANDARD GAMEPAD...)"
     * @returns {string} Human-friendly display title
     * @private
     */
    _formatGamepadName(rawId) {
        if (!rawId || typeof rawId !== 'string') {
            return 'Controller';
        }

        const lower = rawId.toLowerCase();

        // Microsoft Xbox series
        if (lower.includes('xbox') || lower.includes('045e') || lower.includes('xinput')) {
            return 'Xbox Controller';
        }

        // Sony PlayStation series
        if (lower.includes('dualsense') || lower.includes('ps5')) {
            return 'PlayStation DualSense Controller';
        }
        if (lower.includes('dualshock') || lower.includes('ps4') || lower.includes('054c') || lower.includes('sony')) {
            return 'PlayStation DualShock Controller';
        }

        // 8BitDo series
        if (lower.includes('8bitdo') || lower.includes('2dc8')) {
            return '8BitDo Controller';
        }

        // Nintendo Switch Pro & Joy-Cons
        if (
            lower.includes('switch') ||
            lower.includes('joy-con') ||
            lower.includes('nintendo') ||
            lower.includes('057e')
        ) {
            return 'Nintendo Controller';
        }

        // Strip noisy browser annotations like "(STANDARD GAMEPAD Vendor: xxxx Product: yyyy)"
        const sanitized = rawId
            .replace(/\(standard gamepad.*?\)/gi, '')
            .replace(/\(vendor:.*?\)/gi, '')
            .replace(/vendor:\s*[0-9a-f]+/gi, '')
            .replace(/product:\s*[0-9a-f]+/gi, '')
            .trim();

        if (sanitized.length > 0 && sanitized.length < 35) {
            return sanitized;
        }

        return 'Game Controller';
    }

    /**
     * Cleans up all listeners and halts active polling loops.
     */
    destroy() {
        this._stopPolling();

        if (typeof window !== 'undefined') {
            window.removeEventListener('gamepadconnected', this._onGamepadConnected);
            window.removeEventListener('gamepaddisconnected', this._onGamepadDisconnected);
        }

        this._connectedGamepads.clear();
        this._prevButtonStates.clear();
        this._initialized = false;
        log.info('GamepadManager cleanly destroyed.');
    }
}

// Export singleton instance and class definition
export const gamepadManager = new GamepadManager();
export default gamepadManager;
