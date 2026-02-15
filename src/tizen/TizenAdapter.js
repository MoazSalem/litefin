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
     * @private
     */
    _detectPlatform() {
        // Check for Tizen global object
        if (typeof tizen !== 'undefined') {
            this._isTizen = true;

            // Try to get Tizen version
            try {
                const appInfo = tizen.application.getCurrentApplication().appInfo;
                log.info(`Running on Tizen (App: ${appInfo.id} v${appInfo.version})`);
            } catch (e) {
                log.info('Running on Tizen (app info unavailable)');
            }
        } else {
            log.info('Not running on Tizen platform (browser mode)');
        }
    }

    /**
     * Initialize Tizen-specific features
     * Call this after DOM is ready
     */
    init() {
        log.info('Initializing...');

        // Register remote control keys
        this._registerKeys();

        // Setup key event handler
        this._setupKeyHandler();

        // Get device info
        this._getDeviceInfo();

        log.info('Initialized');
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
                'Tools'
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
            const keyCode = e.keyCode;

            // Map key codes to events
            switch (keyCode) {
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

                // Media controls
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
}

// Export singleton instance
export const tizenAdapter = new TizenAdapter();

// Also export constants
export { TIZEN_KEYS };

export default TizenAdapter;
