/**
 * ============================================================================
 * Litefin - Remote Button Manager
 * ============================================================================
 * Coordinates the mapping and execution of custom actions bound to the physical
 * remote control's colored buttons (Red, Green, Yellow, Blue).
 * 
 * Fits cleanly into the global event bus architecture by subscribing to standard
 * hardware adapter key events and executing requested system workflows. Persists
 * settings locally via the centralized StorageService.
 * ============================================================================
 */

import { eventBus } from './EventBus.js';
import { router } from './Router.js';
import { storage } from '../utils/StorageService.js';
import { logger } from '../utils/Logger.js';
import { platformInfo } from '../utils/PlatformInfo.js';
import { screensaverManager } from './ScreensaverManager.js';

// Setup highly targeted logger to trace button mapping execution details
const log = logger.create('RemoteButtonManager');

class RemoteButtonManager {
    constructor() {
        // Prevent double-initialization scenarios during hot reloading or app re-starts
        this._initialized = false;
    }

    /**
     * Bootstraps the manager and hooks physical key events from the platform adapters.
     * Called during App.init() sequence once global systems are loaded.
     */
    init() {
        // Enforce singleton initialization constraints
        if (this._initialized) {
            log.warn('RemoteButtonManager already initialized, skipping bootstrap.');
            return;
        }

        log.info('Initializing RemoteButtonManager engine...');

        // Subscribe to standard color remote keypresses propagated by Tizen and WebOS adapters
        eventBus.on('key:red', (e) => this._executeAction('red', e));
        eventBus.on('key:green', (e) => this._executeAction('green', e));
        eventBus.on('key:yellow', (e) => this._executeAction('yellow', e));
        eventBus.on('key:blue', (e) => this._executeAction('blue', e));

        // Mark as successfully running to block redundant initializations
        this._initialized = true;
        log.info('RemoteButtonManager successfully bound to global EventBus.');
    }

    /**
     * Executes the custom user-defined action configured for a color key.
     * @param {string} color - The remote button color identifier ('red', 'green', 'yellow', 'blue')
     * @param {KeyboardEvent} e - The raw browser KeyboardEvent delivered from adapters
     * @private
     */
    _executeAction(color, e) {
        // Capitalize color string to properly align with StorageService preference key structure
        const capitalizedColor = color.charAt(0).toUpperCase() + color.slice(1);
        const prefKey = `pref:remote${capitalizedColor}Action`;
        
        // Fetch saved user preference, fallback to 'none' if undefined or empty
        const action = storage.getItem(prefKey) || 'none';

        log.info(`Remote Event: Color=${color} pressed, MappedAction=${action}`);

        // Route the action command to the appropriate system logic handler
        switch (action) {
            case 'home':
                // 1. Reset current page state and clear all navigation history stack entries
                log.info('Home Mapped: Resetting route to /home and purging history stack.');
                router.reset('/home');
                break;

            case 'playPause':
                // 2. Play/Pause toggle - Emitted globally to control active media play state
                log.info('Play/Pause Mapped: Emitting global playPause remote command.');
                eventBus.emit('key:playPause', e);
                break;

            case 'screensaver':
                // 3. Toggle screensaver - Manually activate or dismiss based on state
                log.info('Screensaver Mapped: Toggling screensaver overlay display.');
                this._toggleScreensaver();
                break;

            case 'powerOff':
                // 4. Turn Off Screen - Direct panel sleep request to hardware
                log.info('Power sleep Mapped: Initializing TV display sleep command.');
                this._turnOffScreen();
                break;

            case 'none':
            default:
                // No custom operation is configured, ignore key press
                log.debug(`None Mapped: Colored key ${color} ignored.`);
                break;
        }
    }

    /**
     * Toggles the Screensaver Manager state programmatically.
     * Triggers active screensaver display or forces exit to the UI immediately.
     * @private
     */
    _toggleScreensaver() {
        // Delegate toggle decision based on active overlay display state
        if (screensaverManager.isShowing) {
            log.info('Screensaver is active, dismissing screensaver overlay.');
            screensaverManager.hide();
        } else {
            log.info('Screensaver is inactive, forcing immediate backdrop/logo show.');
            screensaverManager.show();
        }
    }

    /**
     * Issues native system requests to put the display panel to sleep.
     * Safely checks environment and isolates platform-specific Luna or Tizen APIs.
     * @private
     */
    _turnOffScreen() {
        log.info('Requesting TV hardware to turn off display screen...');

        // 1. LG WebOS Luna Service API Path
        if (platformInfo.isWebOS) {
            log.debug('Executing WebOS Luna service request...');
            
            // Check global window scope for webOS library injection availability
            if (window.webOS && window.webOS.service) {
                try {
                    // Triggers the com.webos.service.tvpower service to put the panel to sleep
                    window.webOS.service.request('luna://com.webos.service.tvpower', {
                        method: 'power/turnOffScreen',
                        parameters: {},
                        onSuccess: (inResponse) => {
                            log.info('WebOS: tvpower/turnOffScreen call successful.', inResponse);
                        },
                        onFailure: (inError) => {
                            log.error('WebOS: Failed tvpower/turnOffScreen request:', inError);
                        }
                    });
                } catch (e) {
                    log.error('WebOS: Unexpected error during Luna service request:', e);
                }
            } else {
                log.warn('WebOS: window.webOS or service object is unavailable in current scope.');
            }
        } 
        // 2. Samsung Tizen Power API Path
        else if (platformInfo.isTizen) {
            log.debug('Executing Samsung Tizen power request...');
            
            // Verify Samsung Tizen system global object exists
            if (typeof tizen !== 'undefined' && tizen.power) {
                try {
                    // Extract Tizen OS version to handle legacy API differences
                    const tizenVer = platformInfo.tizenVersion;
                    
                    /*
                     * -----------------------------------------------------------------
                     * TIZEN SCREEN POWER LEGACY API FALLBACK
                     * -----------------------------------------------------------------
                     * Samsung Tizen versions prior to 4.0 (like 2.4 or 3.0) do not
                     * support the unified `tizen.power.request('SCREEN', 'SCREEN_OFF')`
                     * API method. They rely on the dedicated `tizen.power.turnScreenOff()`
                     * interface instead. We evaluate version and fall back gracefully.
                     * -----------------------------------------------------------------
                     */
                    if (tizenVer !== null && tizenVer < 4) {
                        log.info(`Tizen OS version < 4 detected (${tizenVer}). Using legacy turnScreenOff API.`);
                        if (typeof tizen.power.turnScreenOff === 'function') {
                            tizen.power.turnScreenOff();
                            log.info('Tizen: tizen.power.turnScreenOff() executed successfully.');
                        } else {
                            log.warn('Tizen: turnScreenOff function is missing on tizen.power object.');
                        }
                    } else {
                        log.info(`Tizen OS version >= 4 detected (${tizenVer || 'unknown'}). Using modern request API.`);
                        tizen.power.request('SCREEN', 'SCREEN_OFF');
                        log.info('Tizen: tizen.power.request SCREEN_OFF succeeded.');
                    }
                } catch (error) {
                    log.error('Tizen: Failed to put screen to sleep:', error);
                }
            } else {
                log.warn('Tizen: tizen.power API object is missing or unprivileged.');
            }
        } 
        // 3. Standard Browser Fallback
        else {
            log.info('Browser: Ignoring screen turn-off command in developer browser environment.');
        }
    }
}

// Export singleton engine instance to maintain consistency across scripts
export const remoteButtonManager = new RemoteButtonManager();
export default remoteButtonManager;
