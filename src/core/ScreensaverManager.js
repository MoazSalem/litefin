/**
 * ============================================================================
 * Litefin Tizen - Screensaver Manager
 * ============================================================================
 * Manages idle time detection and activates the appropriate screensaver plugin
 * (Logo or Backdrop). Blocks activation if media is currently playing.
 * ============================================================================
 */

import { eventBus } from './EventBus.js';
import { storage } from '../utils/StorageService.js';
import { tizenAdapter } from '../tizen/TizenAdapter.js';
import { auth } from '../api/index.js';
import { logger } from '../utils/Logger.js';
import { LogoScreensaver } from './screensaver/LogoScreensaver.js';
import { BackdropScreensaver } from './screensaver/BackdropScreensaver.js';

const log = logger.create('ScreensaverManager');

class ScreensaverManager {
    constructor() {
        this._activePlugin = null;
        this._interval = null;
        this._initialized = false;

        // Track functional playback to block screensaver
        this._isVideoPlaying = false;

        // Screensaver settings from storage defaults
        this._delaySeconds = parseInt(storage.getItem('pref:screensaverDelay'), 10) || 300;
        this._pluginType = storage.getItem('pref:screensaverType') || 'backdrop';

        this._hideBound = this.hide.bind(this);
        this._onPointerMoveBound = this._onPointerMove.bind(this);
        this._lastPointerInputTime = Date.now();
    }

    init() {
        if (this._initialized) {
            log.warn('Already initialized');
            return;
        }

        // Only start checking if screensaver is actually enabled (Delay > 0)
        this._updateConfig();

        // Listeners for external state changes
        eventBus.on('player:play', () => {
            this._isVideoPlaying = true;
            this.hide();
        });
        eventBus.on('player:playing', () => {
            this._isVideoPlaying = true;
            this.hide(); // Hide if resumed from pause
        });
        eventBus.on('player:paused', () => {
            this._isVideoPlaying = false; // Allow idle timer to trigger during pause
        });
        eventBus.on('player:stopped', () => {
            this._isVideoPlaying = false;
        });
        eventBus.on('auth:logout', () => {
            this.hide();
        }); // hide on logout to switch visuals safely

        // Reload prefs on change
        eventBus.on('pref:screensaverDelay', () => this._updateConfig());
        eventBus.on('pref:screensaverType', () => this._updateConfig());

        // Setup mouse listeners for non-tv pointers
        document.addEventListener('mousemove', this._onPointerMoveBound, { passive: true });
        document.addEventListener('pointermove', this._onPointerMoveBound, { passive: true });

        this._initialized = true;
        log.info('Initialized with delay:', this._delaySeconds, 's');
    }

    _updateConfig() {
        this._delaySeconds = parseInt(storage.getItem('pref:screensaverDelay'), 10);
        if (isNaN(this._delaySeconds)) this._delaySeconds = 300; // default 5 mins

        this._pluginType = storage.getItem('pref:screensaverType') || 'backdrop';

        this._startPolling();
    }

    _startPolling() {
        this._stopPolling();

        if (this._delaySeconds > 0) {
            // Check every 5 seconds like jellyfin-web
            this._interval = setInterval(() => this._checkIdleTime(), 5000);
        }
    }

    _stopPolling() {
        if (this._interval) {
            clearInterval(this._interval);
            this._interval = null;
        }
    }

    _onPointerMove() {
        this._lastPointerInputTime = Date.now();
        if (this.isShowing) {
            this.hide();
        }
    }

    _checkIdleTime() {
        if (this.isShowing) return;
        if (this._delaySeconds <= 0) return;

        // If currently playing video, never show screensaver
        // Audio playback can show screensaver (like JF web does)
        if (this._isVideoPlaying) return;

        const minIdleTimeMs = this._delaySeconds * 1000;

        // Check platform keys (TV remote)
        if (tizenAdapter.idleTime < minIdleTimeMs) return;

        // Check pointer (Magic Remote / Web mouse)
        const pointerIdleTimeMs = Date.now() - this._lastPointerInputTime;
        if (pointerIdleTimeMs < minIdleTimeMs) return;

        log.info('System idle time reached limit, showing screensaver');
        this.show();
    }

    get isShowing() {
        return this._activePlugin !== null;
    }

    show() {
        if (this.isShowing) {
            log.warn('Screensaver already active');
            return;
        }

        // Select plugin
        let pluginToRun = null;

        // Fallback to logo if backdrop requested but not authenticated
        if (this._pluginType === 'backdrop' && auth.isAuthenticated()) {
            pluginToRun = new BackdropScreensaver();
        } else {
            pluginToRun = new LogoScreensaver();
        }

        log.info(`Activating ${pluginToRun.name}`);
        this._activePlugin = pluginToRun;

        // Create an overlay to swallow clicks
        document.body.classList.add('screensaver-active');

        // Render the UI
        pluginToRun.show();

        // Listen for ANY dismissal interaction
        document.addEventListener('keydown', this._hideBound, { capture: true });
        document.addEventListener('click', this._hideBound, { capture: true });
    }

    async hide(e) {
        if (!this.isShowing) return;

        if (e) {
            e.preventDefault();
            e.stopPropagation();
        }

        log.info('Hiding screensaver');

        // Remove listeners
        document.removeEventListener('keydown', this._hideBound, { capture: true });
        document.removeEventListener('click', this._hideBound, { capture: true });

        document.body.classList.remove('screensaver-active');

        // Reset tracking to prevent immediate re-triggering
        tizenAdapter.reportInput?.();
        this._lastPointerInputTime = Date.now();

        // Let plugin clean up DOM/Animation
        if (this._activePlugin) {
            await this._activePlugin.hide();
            this._activePlugin = null;
        }
    }
}

export const screensaverManager = new ScreensaverManager();
export default ScreensaverManager;
