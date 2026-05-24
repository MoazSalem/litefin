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
import { screensaverManager } from './ScreensaverManager.js';
import { toast } from '../ui/Toast.js';
import { i18n } from '../utils/i18n.js';

// Setup highly targeted logger to trace button mapping execution details
const log = logger.create('RemoteButtonManager');

class RemoteButtonManager {
    constructor() {
        // Prevent double-initialization scenarios during hot reloading or app re-starts
        this._initialized = false;
        
        // Track customizable Sleep Timer parameters dynamically
        this._sleepTimerMinutes = 0;
        this._sleepTimerInterval = null;
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

            case 'sleepTimer':
                // 4. Sleep Timer - Increments shutdown/screensaver countdown
                log.info('Sleep Timer Mapped: Adding 5 minutes to countdown timer.');
                this._addSleepTimerTime();
                break;

            case 'playerSubtitles':
                // 5. Open Subtitles track selection overlay menu in active video player
                log.info('Player Subtitles Mapped: Triggering active subtitle track menu.');
                this._handlePlayerAction('subtitles');
                break;

            case 'playerAudio':
                // 6. Open Audio track selection overlay menu in active video player
                log.info('Player Audio Mapped: Triggering active audio track menu.');
                this._handlePlayerAction('audio');
                break;

            case 'playerSettings':
                // 7. Open Quick configuration settings overlay menu in active video player
                log.info('Player Settings Mapped: Triggering active player settings menu.');
                this._handlePlayerAction('settings');
                break;

            case 'playerSubtitleOffset':
                // 8. Toggle Subtitle Offset adjustment overlay menu in active video player
                log.info('Player Subtitle Offset Mapped: Triggering active subtitle offset toggle.');
                this._handlePlayerAction('subtitleOffset');
                break;

            case 'playerQueue':
                // 9. Open Queue selection modal in active video player
                log.info('Player Queue Mapped: Triggering active queue overlay.');
                this._handlePlayerAction('queue');
                break;

            case 'playerChapters':
                // 10. Open Chapters list modal in active video player
                log.info('Player Chapters Mapped: Triggering active chapters list.');
                this._handlePlayerAction('chapters');
                break;

            case 'playerPlaybackInfo':
                // 11. Toggle Stats/Playback Info panel in active video player
                log.info('Player Playback Info Mapped: Toggling active playback info overlay.');
                this._handlePlayerAction('playbackInfo');
                break;

            case 'playerPreviousChapter':
                /*
                 * ====================================================================
                 * ACTION: NAVIGATE TO PREVIOUS CHAPTER
                 * ====================================================================
                 * If video playback is currently active, this will immediately skip
                 * backward to the start of the previous chapter. Operates dynamically
                 * by sending a 'previousChapter' directive to the player's OSD layer.
                 * ====================================================================
                 */
                log.info('Player Previous Chapter Mapped: Skipping backward one chapter.');
                this._handlePlayerAction('previousChapter');
                break;

            case 'playerNextChapter':
                /*
                 * ====================================================================
                 * ACTION: NAVIGATE TO NEXT CHAPTER
                 * ====================================================================
                 * If video playback is currently active, this will immediately skip
                 * forward to the start of the next chapter. Operates dynamically
                 * by sending a 'nextChapter' directive to the player's OSD layer.
                 * ====================================================================
                 */
                log.info('Player Next Chapter Mapped: Skipping forward one chapter.');
                this._handlePlayerAction('nextChapter');
                break;

            case 'none':
            default:
                // No custom operation is configured, ignore key press
                log.debug(`None Mapped: Colored key ${color} ignored.`);
                break;
        }
    }

    /**
     * ========================================================================
     * CONTEXT-AWARE MEDIA PLAYER INTERACTION ROUTER
     * ========================================================================
     * Processes color remote button workflows that only apply while a video
     * is playing. Inspects current view router state to fetch the active player,
     * wakes the OSD, and triggers the corresponding OSD modal menu layer.
     * ========================================================================
     * @param {string} actionType - The target menu to open ('subtitles', 'audio', 'settings')
     * @private
     */
    _handlePlayerAction(actionType) {
        log.info(`Evaluation: Checking player page context for action: ${actionType}`);

        // Fetch the currently active view page from the global single-page Router
        const currentPage = router.getCurrentPage();
        
        // Match player contexts using constructor class checks or fallback properties
        if (currentPage && (currentPage.constructor.name === 'PlayerPage' || currentPage._osd || currentPage.osd)) {
            // Retrieve OSDController instance from the active page using getter or internal prop
            const osd = currentPage.osd || currentPage._osd;
            if (osd) {
                log.info(`Active PlayerPage located! Triggering OSD overlay for: ${actionType}`);
                
                // Ensure OSD overlays are rendered and visible to the user
                osd.show();
                
                // Reset the auto-hide timer to prevent controls disappearing while viewing menu
                osd.resetAutoHide();
                
                // Directly execute the corresponding built-in OSD action workflow
                osd._executeAction(actionType);
            } else {
                log.warn('Validation Error: Active PlayerPage exists, but OSD instance is missing.');
            }
        } else {
            log.info(`Ignored: Action "${actionType}" only works when video playback is active.`);
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
     * ========================================================================
     * HIGH-FIDELITY SLEEP TIMER CONTROLLER
     * ========================================================================
     * Dynamically adds 5 minutes to the sleep timer on each press.
     * If the sleep timer exceeds 120 minutes (2 hours), it resets to 0 (disabled).
     * Displays real-time feedback to the user via elegant Toast notifications.
     * When the countdown finishes, playback is paused, and the screensaver starts.
     * ========================================================================
     * @private
     */
    _addSleepTimerTime() {
        // Clear any running interval first to avoid race conditions
        if (this._sleepTimerInterval) {
            clearInterval(this._sleepTimerInterval);
            this._sleepTimerInterval = null;
        }

        // Add 5 minutes to the active sleep timer
        this._sleepTimerMinutes += 5;

        // Reset to zero if we exceed 2 hours (120 minutes)
        if (this._sleepTimerMinutes > 120) {
            this._sleepTimerMinutes = 0;
            log.info('Sleep Timer: Exceeded 120 minutes limit. Resetting to 0 (Disabled).');
            toast.show(i18n.t('SleepTimerDisabled') || 'Sleep Timer: Off', 3000);
            return;
        }

        log.info(`Sleep Timer: Set to ${this._sleepTimerMinutes} minutes.`);

        // Format a beautiful, user-facing time message
        let timeString = `${this._sleepTimerMinutes} min`;
        if (this._sleepTimerMinutes >= 60) {
            const hours = Math.floor(this._sleepTimerMinutes / 60);
            const mins = this._sleepTimerMinutes % 60;
            timeString = mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
        }

        toast.show(`${i18n.t('SleepTimerSet') || 'Sleep Timer'}: ${timeString}`, 3000);

        // Start countdown interval ticking every 1 minute (60,000 ms)
        this._sleepTimerInterval = setInterval(() => {
            if (this._sleepTimerMinutes > 0) {
                this._sleepTimerMinutes -= 1;
                log.info(`Sleep Timer Tick: ${this._sleepTimerMinutes} minutes remaining.`);

                if (this._sleepTimerMinutes === 0) {
                    this._triggerSleepTimerTimeout();
                }
            } else {
                this._clearSleepTimer();
            }
        }, 60000);
    }

    /**
     * Helper to clear sleep timer safely.
     * @private
     */
    _clearSleepTimer() {
        if (this._sleepTimerInterval) {
            clearInterval(this._sleepTimerInterval);
            this._sleepTimerInterval = null;
        }
        this._sleepTimerMinutes = 0;
    }

    /**
     * Executes the actual sleep timeout workflow:
     * 1. Pauses any active media playback globally.
     * 2. Force-triggers the screensaver overlay.
     * 3. Displays a final confirmation toast.
     * @private
     */
    _triggerSleepTimerTimeout() {
        log.info('Sleep Timer Finished! Pausing playback and activating screensaver.');

        // Clean up the timer resources completely
        this._clearSleepTimer();

        // 1. Pause active video playback safely
        try {
            const currentPage = router.getCurrentPage();
            if (currentPage && (currentPage.constructor.name === 'PlayerPage' || currentPage._osd || currentPage.osd)) {
                log.info('Active PlayerPage detected. Initiating remote pause sequence.');
                if (typeof currentPage._onRemotePause === 'function') {
                    currentPage._onRemotePause();
                } else if (currentPage._player && typeof currentPage._player.pause === 'function') {
                    currentPage._player.pause();
                }
            } else {
                // If not on PlayerPage but we want to be safe, emit the global key:pause event
                log.info('No active PlayerPage in focus. Emitting global playPause/pause key command.');
                eventBus.emit('key:pause');
            }
        } catch (err) {
            log.error('Failed to pause playback during sleep timer execution:', err);
        }

        // 2. Start/show screensaver
        try {
            if (!screensaverManager.isShowing) {
                log.info('Launching screensaver manager...');
                screensaverManager.show();
            }
        } catch (err) {
            log.error('Failed to trigger screensaver during sleep timer execution:', err);
        }

        // 3. Inform the user with a gentle notification
        toast.show(i18n.t('SleepTimerActivated') || 'Sleep Timer: Goodnight!', 5000);
    }
}

// Export singleton engine instance to maintain consistency across scripts
const remoteButtonManager = new RemoteButtonManager();
export { remoteButtonManager };
export default remoteButtonManager;
