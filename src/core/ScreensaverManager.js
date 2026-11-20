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
import { webosAdapter } from '../webos/WebOSAdapter.js';
import { desktopAdapter } from '../desktop/DesktopAdapter.js';
import { webAdapter } from '../web/WebAdapter.js';
import { platformInfo } from '../utils/PlatformInfo.js';
import { auth } from '../api/index.js';
import { logger } from '../utils/Logger.js';
import { cssVarsPolyfill } from '../utils/CssVarsPolyfill.js';
import { LogoScreensaver } from './screensaver/LogoScreensaver.js';
import { BackdropScreensaver } from './screensaver/BackdropScreensaver.js';
import { BlackScreensaver } from './screensaver/BlackScreensaver.js';

const log = logger.create('ScreensaverManager');

class ScreensaverManager {
    constructor() {
        this._activePlugin = null;
        this._interval = null;
        this._initialized = false;

        // Track functional playback to block screensaver
        this._isVideoPlaying = false;

        // Screensaver settings from storage defaults
        this._delaySeconds = parseInt(storage.getItem('pref:screensaverDelay'), 10) || 0;
        this._pluginType = storage.getItem('pref:screensaverType') || 'backdrop';

        // Whether the lazy screensaver stylesheet chunk has been kicked
        this._stylesLoaded = false;

        this._hideBound = this.hide.bind(this);
    }

    /**
     * Resolves the active platform adapter for system idle tracking and input reporting.
     * Ensures WebOS, Android, Desktop (Tauri), Tizen, and Web Browser environments
     * each communicate with their dedicated adapter rather than assuming TV defaults.
     *
     * @private
     * @returns {Object} The platform-specific adapter instance.
     */
    _getPlatformAdapter() {
        // LG webOS TV adapter
        if (platformInfo.isWebOS) {
            return webosAdapter;
        }

        // Desktop application adapter (Tauri windowing)
        if (platformInfo.isDesktop) {
            return desktopAdapter;
        }

        // Samsung Tizen TV adapter (dedicated to Tizen hardware)
        if (platformInfo.isTizen) {
            return tizenAdapter;
        }

        // Standard web browser fallback
        return webAdapter;
    }

    /**
     * Lazily loads the Android adapter. AndroidAdapter is Android-only code
     * (MediaSession/back-button/keep-screen-on management) that is not part
     * of the statically parsed boot bundle on TV tiers; it is fetched the
     * first time any screensaver functionality actually needs it.
     *
     * @private
     * @returns {Promise<Object>} The AndroidAdapter singleton.
     */
    _getAndroidAdapter() {
        if (!this._androidAdapterPromise) {
            this._androidAdapterPromise = import('../android/AndroidAdapter.js').then((m) => m.androidAdapter);
        }
        return this._androidAdapterPromise;
    }

    /**
     * Resets the platform idle counter after an interaction.
     *
     * @private
     */
    _resetPlatformIdle() {
        if (!platformInfo.isAndroid) {
            this._getPlatformAdapter().reportInput?.();
            return;
        }
        this._getAndroidAdapter()
            .then((adapter) => adapter.reportInput?.())
            .catch((err) => log.warn('Failed to reset Android idle counter:', err));
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
            /*
             * Reset the platform idle timer when playback ends.
             *
             * During a film the user doesn't press any buttons, so by the time
             * they return to the details page the platform idle clock has been
             * ticking for potentially hours. Without this reset the screensaver
             * would fire almost instantly after router.back() lands.
             *
             * reportInput() resets the OS-level idle counter, giving the user a
             * full delay period before the screensaver can appear again.
             */
            // Reset OS idle timer on the resolved platform adapter
            this._resetPlatformIdle();
        });
        eventBus.on('auth:logout', () => {
            this.hide();
        }); // hide on logout to switch visuals safely

        // Reload prefs on change
        eventBus.on('pref:screensaverDelay', () => this._updateConfig());
        eventBus.on('pref:screensaverType', () => this._updateConfig());

        this._initialized = true;
        log.info('Initialized with delay:', this._delaySeconds, 's');
    }

    _updateConfig() {
        this._delaySeconds = parseInt(storage.getItem('pref:screensaverDelay'), 10);
        if (isNaN(this._delaySeconds)) this._delaySeconds = 0; // default never

        this._pluginType = storage.getItem('pref:screensaverType') || 'backdrop';

        // Preload the screensaver stylesheet while enabled but idle - the
        // activation is minutes away, so the small async chunk is long since
        // arrived by the time show() renders. Never fetched when the
        // screensaver is disabled (the default), keeping it out of boot.
        if (this._delaySeconds > 0 && !this._stylesLoaded) {
            this._stylesLoaded = true;
            import(/* webpackChunkName: "screensaver-css" */ '../styles/screensaver.css')
                .then(() => cssVarsPolyfill.ensureStylesResolved())
                .catch((err) => {
                    this._stylesLoaded = false;
                    log.warn('Screensaver stylesheet chunk failed:', err);
                });
        }

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

    _checkIdleTime() {
        if (this.isShowing) return;
        if (this._delaySeconds <= 0) return;

        // If currently playing video, never show screensaver
        if (this._isVideoPlaying) return;

        // Query idle time from the active platform adapter
        const minIdleTimeMs = this._delaySeconds * 1000;

        if (platformInfo.isAndroid) {
            // AndroidAdapter is lazily imported; evaluate idle time once the
            // module has loaded (the next interval tick re-checks normally).
            this._getAndroidAdapter()
                .then((adapter) => {
                    if (adapter.idleTime >= minIdleTimeMs) {
                        log.info('System idle time reached limit, showing screensaver');
                        this.show();
                    }
                })
                .catch((err) => log.debug('Android idle time unavailable:', err));
            return;
        }

        const platformAdapter = this._getPlatformAdapter();

        if (platformAdapter.idleTime >= minIdleTimeMs) {
            log.info('System idle time reached limit, showing screensaver');
            this.show();
        }
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

        // Choose plugin based on user preference
        if (this._pluginType === 'black') {
            // New "Completely Black" screensaver option
            pluginToRun = new BlackScreensaver();
        } else if (this._pluginType === 'backdrop' && auth.isAuthenticated()) {
            // Backdrop slideshow (requires auth)
            pluginToRun = new BackdropScreensaver();
        } else {
            // Bouncing app logo (default fallback or unauthenticated)
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

        // Reset tracking to prevent immediate re-triggering across platforms
        this._resetPlatformIdle();

        // Let plugin clean up DOM/Animation
        if (this._activePlugin) {
            await this._activePlugin.hide();
            this._activePlugin = null;
        }
    }
}

export const screensaverManager = new ScreensaverManager();
export default ScreensaverManager;
