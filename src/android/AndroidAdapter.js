/**
 * ============================================================================
 * Litefin - Android Platform & Mobile Touch Adapter
 * ============================================================================
 * Handles Android TV, mobile phones, tablets, and Tauri Android shells:
 * - Responsive display scaling via CSS zoom for phones & tablets (landscape & portrait)
 * - Native touch horizontal row scrolling via TouchHorizontalScroller
 * - Hardware remote control & physical keyboard key mappings (D-pad, Media, Back)
 * - Hardware Back button interception to drive unified Litefin back navigation
 * - Native bridge integration (AndroidBridge, LitefinAndroid, Tauri IPC exit)
 * - Idle tracking for screensavers and power management
 * ============================================================================
 */

import { eventBus } from '../core/EventBus.js';
import { storage } from '../utils/StorageService.js';
import { logger } from '../utils/Logger.js';
import { touchHorizontalScroller } from './TouchHorizontalScroller.js';
import { layoutManager } from '../ui/LayoutManager.js';

const log = logger.create('AndroidAdapter');

// ============================================================================
// Key code mappings for Android TV remote controls and keyboards
// ============================================================================
const ANDROID_KEYS = {
    // Standard directional D-pad controls
    LEFT: 37,
    UP: 38,
    RIGHT: 39,
    DOWN: 40,
    ENTER: 13,

    // Hardware Back & fallback keys
    BACK: 4, // Android KeyEvent.KEYCODE_BACK in Chromium WebView
    ESCAPE: 27, // Standard desktop Escape key
    BACKSPACE: 8, // Backspace key on external physical keyboards

    // Media playback controls found on Android TV remotes
    PLAY: 250,
    PLAY_ALT: 126, // Android KeyEvent.KEYCODE_MEDIA_PLAY
    PLAY_LEGACY: 415,
    PAUSE: 19,
    PAUSE_ALT: 127, // Android KeyEvent.KEYCODE_MEDIA_PAUSE
    PLAY_PAUSE: 179,
    PLAY_PAUSE_ALT: 85, // Android KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE
    PLAY_PAUSE_LEGACY: 10252,
    STOP: 178,
    STOP_ALT: 86, // Android KeyEvent.KEYCODE_MEDIA_STOP
    STOP_LEGACY: 413,
    FAST_FORWARD: 228,
    FAST_FORWARD_ALT: 90, // Android KeyEvent.KEYCODE_MEDIA_FAST_FORWARD
    FAST_FORWARD_STEP: 272, // Android KeyEvent.KEYCODE_MEDIA_STEP_FORWARD
    FAST_FORWARD_SKIP: 274, // Android KeyEvent.KEYCODE_MEDIA_SKIP_FORWARD
    FAST_FORWARD_LEGACY: 417,
    REWIND: 227,
    REWIND_ALT: 89, // Android KeyEvent.KEYCODE_MEDIA_REWIND
    REWIND_STEP: 273, // Android KeyEvent.KEYCODE_MEDIA_STEP_BACKWARD
    REWIND_SKIP: 275, // Android KeyEvent.KEYCODE_MEDIA_SKIP_BACKWARD
    REWIND_LEGACY: 412,
    NEXT: 87, // Android KeyEvent.KEYCODE_MEDIA_NEXT
    PREV: 88, // Android KeyEvent.KEYCODE_MEDIA_PREVIOUS

    // Channel stepping
    PAGE_UP: 33,
    PAGE_DOWN: 34,

    // Color buttons (Red, Green, Yellow, Blue) found on TV remotes (TCL, Philips, Sony, etc.)
    RED: 183, // Android KeyEvent.KEYCODE_PROG_RED
    RED_LEGACY: 403, // Standard Smart TV / HbbTV red keycode
    GREEN: 184, // Android KeyEvent.KEYCODE_PROG_GREEN
    GREEN_LEGACY: 404, // Standard Smart TV / HbbTV green keycode
    YELLOW: 185, // Android KeyEvent.KEYCODE_PROG_YELLOW
    YELLOW_LEGACY: 405, // Standard Smart TV / HbbTV yellow keycode
    BLUE: 186, // Android KeyEvent.KEYCODE_PROG_BLUE
    BLUE_LEGACY: 406, // Standard Smart TV / HbbTV blue keycode

    // TV utility & function buttons
    CAPTIONS: 175, // Android KeyEvent.KEYCODE_CAPTIONS
    SUBTITLE: 460, // Standard Smart TV subtitle keycode
    INFO: 165, // Android KeyEvent.KEYCODE_INFO
    INFO_LEGACY: 457, // Standard Smart TV info keycode
    GUIDE: 172, // Android KeyEvent.KEYCODE_GUIDE
    GUIDE_LEGACY: 458, // Standard Smart TV guide keycode
    BOOKMARK: 174 // Android KeyEvent.KEYCODE_BOOKMARK
};

class AndroidAdapter {
    constructor() {
        // Tracks whether adapter has been initialized
        this._initialized = false;

        // Cached human-readable device model and brand
        this._deviceName = null;
        this._manufacturer = null;

        // Tracks timestamp of last user interaction for screensaver
        this._lastInputTime = Date.now();

        // Active Screen Wake Lock sentinel reference for browser WebViews
        this._wakeLock = null;

        // Tracks active media playback status for wake lock management
        this._isPlaybackActive = false;
    }

    /**
     * ========================================================================
     * Initialization & Global Listener Registration
     * ========================================================================
     * Executed when DOM is ready during application startup.
     */
    init() {
        if (this._initialized) {
            return;
        }
        this._initialized = true;

        log.info('Initializing AndroidAdapter...');

        // Expose adapter reference on window for native activity routing
        if (typeof window !== 'undefined') {
            window.androidAdapter = this;
            try {
                // Hook invoked by native host when hardware back button or gesture is detected
                window.__litefinAndroidBack = () => this.handleHardwareBack();

                // Direct native bridge dispatchers for TV remotes with colored contextual keys
                window.__litefinAndroidColorButton = (color) => this.handleColorButton(color);
                window.onTvRemoteColor = (color) => this.handleColorButton(color);

                // Direct native bridge dispatchers for hardware media transport commands
                window.__litefinAndroidMediaCommand = (cmd) => this.handleMediaCommand(cmd);
            } catch (e) {
                log.warn('Failed registering native bridge globals in AndroidAdapter:', e);
            }
        }

        // Initialize user interaction timestamp
        this._lastInputTime = Date.now();

        // Register hardware remote and physical keyboard input listeners
        this._setupKeyHandler();

        // Track touch and pointer interactions to keep power timers alive
        document.addEventListener('mousemove', () => this.reportInput(), { passive: true });
        document.addEventListener('mousedown', () => this.reportInput(), { passive: true });
        document.addEventListener('touchstart', () => this.reportInput(), { passive: true });

        // Synchronize display wake lock and standard Media Session playback state
        // Prevents the Android system screensaver (Ambient Mode, Daydream) from activating
        // while informing Android's MediaSessionManager of active media playback.
        if (typeof eventBus !== 'undefined' && typeof eventBus?.on === 'function') {
            eventBus.on('player:play', () => {
                this._isPlaybackActive = true;
                this.setKeepScreenOn(true);
                this._updatePlaybackState('playing');
            });
            eventBus.on('player:playing', () => {
                this._isPlaybackActive = true;
                this.setKeepScreenOn(true);
                this._updatePlaybackState('playing');
            });
            eventBus.on('player:paused', () => {
                this._isPlaybackActive = false;
                this.setKeepScreenOn(false);
                this._updatePlaybackState('paused');
            });
            eventBus.on('player:stopped', () => {
                // Clear active media playback flag and wake lock
                this._isPlaybackActive = false;
                this.setKeepScreenOn(false);
                this._updatePlaybackState('none');

                // -------------------------------------------------------------
                // Restore Mobile Fullscreen Setting Upon Playback Exit
                // -------------------------------------------------------------
                // Restores the user's mobile preference when leaving the player.
                // Android TV remains in permanent fullscreen mode.
                // -------------------------------------------------------------
                const shouldBeFs = this.isAndroidTv || this.isMobileFullscreenEnabled();
                this.setFullscreen(shouldBeFs);
            });
        }

        // Initialize native-feel touch scrolling for media rows
        if (typeof touchHorizontalScroller !== 'undefined' && touchHorizontalScroller?.init) {
            touchHorizontalScroller.init();
        }

        // ---------------------------------------------------------------------
        // Viewport Meta Tag Normalization & Safe Area Inset Activation
        // ---------------------------------------------------------------------
        // - Android TV: locked to width=1920 for identical 1080p canvas proportions
        // - Mobile & Tablets: width=device-width with viewport-fit=cover to enable
        //   standard CSS env(safe-area-inset-*) metrics for notches & bars.
        // ---------------------------------------------------------------------
        if (typeof document !== 'undefined' && typeof document.querySelector === 'function') {
            const metaViewport = document.querySelector('meta[name="viewport"]');
            if (this.isAndroidTv) {
                if (metaViewport && metaViewport.getAttribute('content') !== 'width=1920, user-scalable=no') {
                    metaViewport.setAttribute('content', 'width=1920, user-scalable=no');
                }
            } else {
                if (metaViewport && metaViewport.getAttribute('content')?.includes('width=1920')) {
                    metaViewport.setAttribute(
                        'content',
                        'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover'
                    );
                } else if (metaViewport && !metaViewport.getAttribute('content')?.includes('viewport-fit=cover')) {
                    const currentContent =
                        metaViewport.getAttribute('content') || 'width=device-width, initial-scale=1.0';
                    metaViewport.setAttribute('content', `${currentContent}, viewport-fit=cover`);
                }
                // Stamp touch-primary input indicator onto root element for mobile phones and tablets
                document.documentElement?.setAttribute?.('data-litefin-touch', '1');
            }
        }

        // Display scaling: phone and tablet viewports use CSS zoom scaling.
        // Android TV runs at 1:1 scale on the 1920 canvas without zoom.
        if (!this.isAndroidTv) {
            this._applyDisplayScale();
        } else {
            document.documentElement?.style?.removeProperty('zoom');
            document.documentElement?.removeAttribute?.('data-litefin-scaled');
            document.documentElement?.style?.removeProperty('--litefin-app-w');
            document.documentElement?.style?.removeProperty('--litefin-app-h');
        }

        // ---------------------------------------------------------------------
        // Initial Fullscreen Configuration
        // ---------------------------------------------------------------------
        // Android TV remains in permanent fullscreen mode without system bars.
        // Mobile phones & tablets default to non-fullscreen (safe area) unless
        // explicitly enabled in display preferences.
        // ---------------------------------------------------------------------
        const shouldBeFullscreen = this.isAndroidTv || this.isMobileFullscreenEnabled();
        this.setFullscreen(shouldBeFullscreen);

        // Re-enforce fullscreen preference when the window regains focus or visibility
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
            window.addEventListener(
                'focus',
                () => {
                    const fs = this._isPlaybackActive || this.isAndroidTv || this.isMobileFullscreenEnabled();
                    this.setFullscreen(fs);
                },
                { passive: true }
            );
        }
        if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
            document.addEventListener(
                'visibilitychange',
                () => {
                    if (!document.hidden) {
                        const fs = this._isPlaybackActive || this.isAndroidTv || this.isMobileFullscreenEnabled();
                        this.setFullscreen(fs);
                        // Re-acquire wake lock if player was actively playing when resuming visibility
                        if (this._isPlaybackActive) {
                            this.setKeepScreenOn(true);
                        }
                    } else {
                        // Release web wake lock when tab or activity is concealed
                        if (this._wakeLock) {
                            this._wakeLock.release().catch(() => {});
                            this._wakeLock = null;
                        }
                    }
                },
                { passive: true }
            );

            // Browser gesture hook for user interaction (respects active preference)
            document.addEventListener(
                'touchstart',
                () => {
                    if (this._isPlaybackActive || this.isAndroidTv || this.isMobileFullscreenEnabled()) {
                        this.setFullscreen(true);
                    }
                },
                { passive: true, once: true }
            );
            document.addEventListener(
                'click',
                () => {
                    if (this._isPlaybackActive || this.isAndroidTv || this.isMobileFullscreenEnabled()) {
                        this.setFullscreen(true);
                    }
                },
                { passive: true, once: true }
            );
        }

        // Retrieve hardware details from native bridge
        this._loadDeviceInfo();

        // Signal native shell that bootstrap has finished
        this._notifyReady();

        log.info(`AndroidAdapter initialized successfully (isAndroidTv: ${this.isAndroidTv})`);
    }

    /**
     * Determines whether the current host device is an Android TV / Google TV.
     * Evaluates native bridge isTv() method or user agent / touch capabilities fallback.
     * @returns {boolean} True if running on Android TV
     */
    get isAndroidTv() {
        try {
            if (typeof window !== 'undefined') {
                if (typeof window.LitefinAndroid?.isTv === 'function') {
                    return !!window.LitefinAndroid.isTv();
                }
                if (typeof window.AndroidBridge?.isTv === 'function') {
                    return !!window.AndroidBridge.isTv();
                }
            }
            if (typeof navigator !== 'undefined' && navigator.userAgent) {
                const ua = navigator.userAgent;
                const hasTvToken =
                    /Android.*(TV|Television|GoogleTV|Large Screen|SmartTV|BRAVIA|AFT|Nexus Player|MIBOX|SHIELD)/i.test(
                        ua
                    );
                const isNonMobileWithoutTouch =
                    !/Mobile/i.test(ua) &&
                    (typeof window === 'undefined' || !('ontouchstart' in window) || navigator.maxTouchPoints === 0);
                return hasTvToken || isNonMobileWithoutTouch;
            }
        } catch (_) {}
        return false;
    }

    /**
     * Retrieves idle duration in milliseconds since the last user action.
     * @returns {number} Idle time in milliseconds
     */
    get idleTime() {
        return Date.now() - (this._lastInputTime || Date.now());
    }

    /**
     * Reports user interaction to keep screensaver and power timers alive.
     */
    reportInput() {
        this._lastInputTime = Date.now();
    }

    /**
     * Returns true indicating this is an Android runtime environment.
     * @returns {boolean}
     */
    get isAndroid() {
        return true;
    }

    /**
     * =========================================================================
     * Mobile Fullscreen Preference Evaluator
     * =========================================================================
     * Checks whether mobile fullscreen mode is active:
     * - Android TV / Leanback devices: Always returns true (TV displays lack
     *   system status and navigation bars).
     * - Mobile phones & tablets: Defaults to false (safe area layout) unless
     *   the user explicitly toggles it on in display preferences.
     * =========================================================================
     * @returns {boolean} True if application UI should run in fullscreen mode.
     */
    isMobileFullscreenEnabled() {
        // Television panels always run in permanent fullscreen
        if (this.isAndroidTv) {
            return true;
        }

        // Retrieve persisted setting from local storage (default is false)
        try {
            if (typeof storage !== 'undefined' && typeof storage.getItem === 'function') {
                const savedPreference = storage.getItem('pref:mobileFullscreen');
                return savedPreference === 'true';
            }
        } catch (_) {}
        return false;
    }

    /**
     * =========================================================================
     * Mobile Fullscreen Preference Setter
     * =========================================================================
     * Toggles fullscreen mode for mobile devices and updates running host:
     * - Persists preference to storage when save=true.
     * - Immediately applies instruction to native host window if media
     *   playback is not currently active (player always remains fullscreen).
     * =========================================================================
     * @param {boolean} enabled - Whether mobile fullscreen should be enabled
     * @param {boolean} [save=true] - Whether to persist setting to local storage
     */
    setMobileFullscreen(enabled, save = true) {
        log.info(`Updating mobile fullscreen preference: ${enabled}`);

        // Persist preference to local storage
        if (save) {
            try {
                if (typeof storage !== 'undefined' && typeof storage.setItem === 'function') {
                    storage.setItem('pref:mobileFullscreen', enabled ? 'true' : 'false');
                }
            } catch (_) {}
        }

        // Apply immediately if not currently on TV and not actively playing media
        if (!this.isAndroidTv && !this._isPlaybackActive) {
            this.setFullscreen(Boolean(enabled));
        }

        // Notify UI components of layout change
        if (typeof eventBus !== 'undefined' && typeof eventBus.emit === 'function') {
            eventBus.emit('settings:mobileFullscreenChanged', Boolean(enabled));
        }
    }

    /**
     * =========================================================================
     * System Fullscreen Mode Dispatcher
     * =========================================================================
     * Enters or exits native OS fullscreen mode across native bridges and DOM APIs.
     * When fullscreen is true, hides status bar and navigation bar.
     * When fullscreen is false, restores system bars and safe zone layout.
     * =========================================================================
     * @param {boolean} [fullscreen=true] - Target fullscreen state
     */
    setFullscreen(fullscreen = true) {
        const isFs = Boolean(fullscreen);
        log.debug(`Dispatching setFullscreen: ${isFs}`);

        try {
            // Forward instruction to native LitefinAndroid bridge if present
            if (typeof window !== 'undefined') {
                if (typeof window.LitefinAndroid?.setFullscreen === 'function') {
                    window.LitefinAndroid.setFullscreen(isFs);
                    return;
                }
                // Fallback to legacy AndroidBridge interface
                if (typeof window.AndroidBridge?.setFullscreen === 'function') {
                    window.AndroidBridge.setFullscreen(isFs);
                    return;
                }
            }

            // Fallback to standard W3C DOM Fullscreen API for mobile browsers
            if (typeof document !== 'undefined') {
                if (isFs) {
                    if (document.documentElement.requestFullscreen) {
                        document.documentElement.requestFullscreen().catch(() => {});
                    } else if (document.documentElement.webkitRequestFullscreen) {
                        document.documentElement.webkitRequestFullscreen();
                    }
                } else {
                    if (document.exitFullscreen) {
                        document.exitFullscreen().catch(() => {});
                    } else if (document.webkitExitFullscreen) {
                        document.webkitExitFullscreen();
                    }
                }
            }
        } catch (e) {
            log.warn('Failed configuring fullscreen in AndroidAdapter:', e);
        }
    }

    /**
     * Controls screen orientation on mobile devices.
     * Automatically locks the view to landscape orientation during video playback
     * and restores standard auto-rotation when leaving the player.
     *
     * @param {'landscape'|'portrait'|'auto'|'unspecified'} orientation - Target orientation
     */
    setOrientation(orientation = 'auto') {
        // Dedicated TV hardware runs fixed horizontal displays; bypass changes
        if (this.isAndroidTv) {
            return;
        }

        log.debug(`Setting orientation to: ${orientation}`);

        try {
            // Forward orientation instruction to native LitefinAndroid bridge
            if (typeof window !== 'undefined' && typeof window.LitefinAndroid?.setOrientation === 'function') {
                window.LitefinAndroid.setOrientation(orientation);
                return;
            }

            // Fallback to legacy AndroidBridge interface if active
            if (typeof window !== 'undefined' && typeof window.AndroidBridge?.setOrientation === 'function') {
                window.AndroidBridge.setOrientation(orientation);
                return;
            }

            // Fallback to W3C Screen Orientation API for modern mobile web views / PWAs
            if (typeof window !== 'undefined' && window.screen?.orientation) {
                if (orientation === 'landscape' || orientation === 'sensorLandscape') {
                    if (typeof window.screen.orientation.lock === 'function') {
                        window.screen.orientation.lock('landscape').catch((err) => {
                            log.debug('screen.orientation.lock failed or requires user gesture:', err);
                        });
                    }
                } else {
                    if (typeof window.screen.orientation.unlock === 'function') {
                        window.screen.orientation.unlock();
                    }
                }
            }
        } catch (e) {
            log.warn('Failed setting screen orientation in AndroidAdapter:', e);
        }
    }

    /**
     * ========================================================================
     * Screen Wake Lock & Display Keep-Awake Management
     * ========================================================================
     * Prevents the Android system screensaver (Ambient Mode, Daydream) and display
     * sleep timer from engaging while media playback is actively running.
     * Dispatches instruction to native LitefinAndroid bridge with fallback
     * to modern W3C Screen Wake Lock API for browser WebViews.
     *
     * @param {boolean} [keepOn=true] - Whether to keep display active
     */
    setKeepScreenOn(keepOn = true) {
        log.debug(`Setting keepScreenOn to: ${keepOn}`);

        try {
            // Forward instruction to native LitefinAndroid bridge
            if (typeof window !== 'undefined' && typeof window.LitefinAndroid?.setKeepScreenOn === 'function') {
                window.LitefinAndroid.setKeepScreenOn(Boolean(keepOn));
                return;
            }

            // Fallback to legacy AndroidBridge interface if present
            if (typeof window !== 'undefined' && typeof window.AndroidBridge?.setKeepScreenOn === 'function') {
                window.AndroidBridge.setKeepScreenOn(Boolean(keepOn));
                return;
            }

            // Fallback to W3C Screen Wake Lock API for modern browser WebViews / PWAs
            if (typeof navigator !== 'undefined' && 'wakeLock' in navigator) {
                if (keepOn) {
                    if (!this._wakeLock) {
                        navigator.wakeLock
                            .request('screen')
                            .then((lock) => {
                                this._wakeLock = lock;
                                lock.addEventListener('release', () => {
                                    this._wakeLock = null;
                                });
                            })
                            .catch((err) => {
                                log.debug('Screen Wake Lock request rejected:', err);
                            });
                    }
                } else if (this._wakeLock) {
                    this._wakeLock.release().catch(() => {});
                    this._wakeLock = null;
                }
            }
        } catch (e) {
            log.warn('Failed setting keepScreenOn in AndroidAdapter:', e);
        }
    }

    /**
     * ========================================================================
     * Centralized Hardware Back Dispatcher
     * ========================================================================
     * Invoked when the user triggers the physical remote Back button or system
     * predictive back navigation gesture. Dispatches `key:back` onto Litefin's
     * eventBus so open dialogs, menus, and pages can handle navigation cleanly.
     * @param {Object} [payload] - Optional metadata from native shell
     */
    handleHardwareBack(payload = {}) {
        this.reportInput();
        log.info('Hardware Back event received from native Android layer');

        // Central eventBus emission matching Tizen and WebOS back handling
        eventBus.emit('key:back', { source: 'android-bridge', ...payload });
    }

    /**
     * Backwards-compatible alias for handleHardwareBack.
     * @param {Object} [payload]
     */
    handleBackButton(payload = {}) {
        this.handleHardwareBack(payload);
    }

    /**
     * ========================================================================
     * Hardware Remote Color Buttons Dispatcher
     * ========================================================================
     * Invoked when physical colored buttons (Red, Green, Yellow, Blue) on TV
     * remotes (such as TCL, Philips, Sony, or generic Leanback remotes) are pressed.
     * Emits standard `key:red`, `key:green`, `key:yellow`, `key:blue` events
     * onto Litefin's EventBus so RemoteButtonManager and OSD handle user actions.
     *
     * @param {'red'|'green'|'yellow'|'blue'|string} color - Button color name
     * @param {Object} [payload] - Optional metadata from native shell or keydown
     */
    handleColorButton(color, payload = {}) {
        this.reportInput();
        if (!color || typeof color !== 'string') {
            return;
        }

        const normalized = color.toLowerCase().trim();
        log.info(`Color button received from hardware remote/bridge: ${normalized}`);

        // Route normalized color key to standard Litefin EventBus topic
        eventBus.emit(`key:${normalized}`, { source: 'android-remote', ...payload });
    }

    /**
     * ========================================================================
     * Media Transport Command Dispatcher
     * ========================================================================
     * Invoked when native host shell or accessibility services intercept dedicated
     * media playback keys from external remote controls (Play, Pause, FastForward,
     * Rewind, Stop, Next, Previous).
     *
     * @param {'play'|'pause'|'playPause'|'stop'|'rewind'|'fastForward'|'next'|'previous'|string} command
     * @param {Object} [payload] - Optional metadata
     */
    handleMediaCommand(command, payload = {}) {
        this.reportInput();
        if (!command || typeof command !== 'string') {
            return;
        }

        log.info(`Media transport command received from native Android bridge: ${command}`);

        // Dispatch to unified playback event listeners
        switch (command) {
            case 'play':
                eventBus.emit('key:play', { source: 'android-media-bridge', ...payload });
                break;
            case 'pause':
                eventBus.emit('key:pause', { source: 'android-media-bridge', ...payload });
                break;
            case 'playPause':
            case 'togglePlay':
                eventBus.emit('key:playPause', { source: 'android-media-bridge', ...payload });
                break;
            case 'stop':
                eventBus.emit('key:stop', { source: 'android-media-bridge', ...payload });
                break;
            case 'rewind':
            case 'seekBackward':
                eventBus.emit('key:rewind', { source: 'android-media-bridge', ...payload });
                break;
            case 'fastForward':
            case 'seekForward':
                eventBus.emit('key:fastForward', { source: 'android-media-bridge', ...payload });
                break;
            case 'next':
            case 'nextTrack':
                eventBus.emit('key:next', { source: 'android-media-bridge', ...payload });
                break;
            case 'previous':
            case 'previousTrack':
                eventBus.emit('key:previous', { source: 'android-media-bridge', ...payload });
                break;
            default:
                log.warn(`Unrecognized media command from native Android bridge: ${command}`);
                break;
        }
    }

    /**
     * ========================================================================
     * Media Session Integration (Hardware Remote & System Transport Controls)
     * ========================================================================
     * Synchronizes media playback state and transport control action handlers with
     * the standard W3C Media Session API (navigator.mediaSession).
     *
     * On Android TV / Google TV, physical remote playback buttons (Play, Pause,
     * Fast-Forward, Rewind, Stop, Next, Previous) are captured by the system
     * MediaSessionManager service and dispatched directly to active action handlers.
     *
     * @param {Object} metadata - Track or video metadata { title, artist, album, artworkUrl }
     * @param {Object} callbacks - Handlers { onPlay, onPause, onStop, onSeekForward, onSeekBackward, onNext, onPrevious }
     */
    updateMediaSession(metadata = {}, callbacks = {}) {
        if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) {
            return;
        }

        log.info('Updating Media Session for Android hardware remote support');

        // Set system-level metadata (lock screen, notification, TV overlay)
        try {
            if (typeof window !== 'undefined' && typeof window.MediaMetadata !== 'undefined') {
                navigator.mediaSession.metadata = new window.MediaMetadata({
                    title: metadata.title || '',
                    artist: metadata.artist || '',
                    album: metadata.album || 'Litefin',
                    artwork: metadata.artworkUrl ? [{ src: metadata.artworkUrl }] : []
                });
            }
        } catch (e) {
            log.warn('Failed setting MediaSession metadata in AndroidAdapter:', e);
        }

        // Map system action handlers to player callbacks
        const actions = {
            play: callbacks.onPlay,
            pause: callbacks.onPause,
            stop: callbacks.onStop,
            seekbackward: callbacks.onSeekBackward,
            seekforward: callbacks.onSeekForward,
            previoustrack: callbacks.onPrevious,
            nexttrack: callbacks.onNext
        };

        // Register each action handler with the browser's MediaSession manager
        Object.keys(actions).forEach((action) => {
            try {
                if (typeof actions[action] === 'function') {
                    navigator.mediaSession.setActionHandler(action, actions[action]);
                } else {
                    navigator.mediaSession.setActionHandler(action, null);
                }
            } catch (e) {
                log.warn(`Failed setting MediaSession action handler for ${action}:`, e);
            }
        });
    }

    /**
     * Clears all registered Media Session action handlers and resets metadata.
     */
    clearMediaSession() {
        if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) {
            return;
        }

        try {
            const actions = ['play', 'pause', 'stop', 'seekbackward', 'seekforward', 'previoustrack', 'nexttrack'];
            actions.forEach((action) => {
                try {
                    navigator.mediaSession.setActionHandler(action, null);
                } catch (_) {}
            });
            navigator.mediaSession.metadata = null;
            navigator.mediaSession.playbackState = 'none';
        } catch (e) {
            log.warn('Failed clearing MediaSession in AndroidAdapter:', e);
        }
    }

    /**
     * Synchronizes playback state with the standard Media Session API.
     * @param {'none'|'paused'|'playing'} state
     * @private
     */
    _updatePlaybackState(state) {
        try {
            if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
                navigator.mediaSession.playbackState = state;
            }
        } catch (_) {}
    }

    /**
     * ========================================================================
     * Key Event Setup & Spatial Navigation Controls
     * ========================================================================
     * Configures document-level keyboard listeners for Android TV remotes and
     * external Bluetooth/USB keyboards.
     * @private
     */
    _setupKeyHandler() {
        // Tracks currently held keycodes to prevent duplicate actions between keydown and keyup
        const pressedKeys = new Set();

        // Clear tracking set if window loses focus to prevent stuck keys
        if (typeof window?.addEventListener === 'function') {
            window.addEventListener('blur', () => pressedKeys.clear(), { passive: true });
        }

        /**
         * Unified key event processor handling both standard hardware remotes
         * and virtual accessibility key injections (e.g. tvQuickActions).
         *
         * @param {KeyboardEvent} e - DOM KeyboardEvent
         * @param {boolean} isKeyUp - True when triggered on keyup / ACTION_UP
         */
        const processKeyEvent = (e, isKeyUp = false) => {
            this.reportInput();
            const keyCode = e.keyCode;
            const keyStr = typeof e.key === 'string' ? e.key : '';
            const codeStr = typeof e.code === 'string' ? e.code : '';

            // Handle press lifecycle: if keydown already handled the action, ignore keyup.
            // If an accessibility tool or virtual remote sends a lone keyup, process it.
            if (isKeyUp) {
                if (pressedKeys.has(keyCode)) {
                    pressedKeys.delete(keyCode);
                    return;
                }
            } else {
                pressedKeys.add(keyCode);
            }

            // Determine if the user is currently editing a text input element
            const activeElem = document.activeElement;
            const isTextInput =
                Boolean(activeElem) &&
                (activeElem.tagName === 'TEXTAREA' ||
                    activeElem.isContentEditable ||
                    (activeElem.tagName === 'INPUT' &&
                        !['range', 'checkbox', 'radio', 'button', 'submit', 'reset'].includes(activeElem.type)));

            // Form input guard: allow all typing, letters, and editing keys to pass through untouched
            if (isTextInput) {
                if (keyCode === ANDROID_KEYS.ESCAPE || keyCode === ANDROID_KEYS.BACK) {
                    e.preventDefault();
                    this.handleHardwareBack();
                    return;
                }
                return;
            }

            // -----------------------------------------------------------------
            // Subtitles / Closed Captions Shortcut
            // -----------------------------------------------------------------
            const isCaptionsKey =
                keyCode === ANDROID_KEYS.CAPTIONS ||
                keyCode === ANDROID_KEYS.SUBTITLE ||
                keyStr === 'Subtitle' ||
                keyStr === 'ClosedCaption' ||
                codeStr === 'ClosedCaption';

            if (isCaptionsKey) {
                e.preventDefault();
                eventBus.emit('key:captions', e);
                return;
            }

            // -----------------------------------------------------------------
            // Info / OSD Toggle Shortcut
            // -----------------------------------------------------------------
            const isInfoKey =
                keyCode === ANDROID_KEYS.INFO ||
                keyCode === ANDROID_KEYS.INFO_LEGACY ||
                keyStr === 'Info' ||
                codeStr === 'Info';

            if (isInfoKey) {
                e.preventDefault();
                eventBus.emit('key:info', e);
                return;
            }

            // -----------------------------------------------------------------
            // Electronic Program Guide (EPG) Shortcut
            // -----------------------------------------------------------------
            const isGuideKey =
                keyCode === ANDROID_KEYS.GUIDE ||
                keyCode === ANDROID_KEYS.GUIDE_LEGACY ||
                keyStr === 'Guide' ||
                codeStr === 'Guide';

            if (isGuideKey) {
                e.preventDefault();
                eventBus.emit('key:guide', e);
                return;
            }

            /*
             * ====================================================================
             * Hardware Remote Color Buttons (Red, Green, Yellow, Blue)
             * ====================================================================
             * TV remotes (such as TCL, Philips, Sony, and generic Android TV remotes)
             * feature dedicated colored programmable function buttons.
             * Dispatches standard key events onto the eventBus so RemoteButtonManager
             * and player OSD can trigger user-configured system actions or shortcuts.
             * ====================================================================
             */
            const isRedKey =
                keyCode === ANDROID_KEYS.RED ||
                keyCode === ANDROID_KEYS.RED_LEGACY ||
                keyStr === 'ColorF0Red' ||
                keyStr === 'Red' ||
                codeStr === 'ColorF0Red' ||
                codeStr === 'Props';

            if (isRedKey) {
                e.preventDefault();
                eventBus.emit('key:red', e);
                return;
            }

            const isGreenKey =
                keyCode === ANDROID_KEYS.GREEN ||
                keyCode === ANDROID_KEYS.GREEN_LEGACY ||
                keyStr === 'ColorF1Green' ||
                keyStr === 'Green' ||
                codeStr === 'ColorF1Green';

            if (isGreenKey) {
                e.preventDefault();
                eventBus.emit('key:green', e);
                return;
            }

            const isYellowKey =
                keyCode === ANDROID_KEYS.YELLOW ||
                keyCode === ANDROID_KEYS.YELLOW_LEGACY ||
                keyStr === 'ColorF2Yellow' ||
                keyStr === 'Yellow' ||
                codeStr === 'ColorF2Yellow';

            if (isYellowKey) {
                e.preventDefault();
                eventBus.emit('key:yellow', e);
                return;
            }

            const isBlueKey =
                keyCode === ANDROID_KEYS.BLUE ||
                keyCode === ANDROID_KEYS.BLUE_LEGACY ||
                keyStr === 'ColorF3Blue' ||
                keyStr === 'Blue' ||
                codeStr === 'ColorF3Blue';

            if (isBlueKey) {
                e.preventDefault();
                eventBus.emit('key:blue', e);
                return;
            }

            /*
             * ====================================================================
             * Hardware Remote Media Playback Controls
             * ====================================================================
             * Android TV remotes often emit DOM KeyEvents alongside or instead of
             * MediaSession signals. Handles Play, Pause, Toggle, Stop, Forward,
             * Rewind, Next, and Previous across diverse Android TV manufacturers.
             * ====================================================================
             */
            const isPlayKey =
                keyCode === ANDROID_KEYS.PLAY ||
                keyCode === ANDROID_KEYS.PLAY_ALT ||
                keyCode === ANDROID_KEYS.PLAY_LEGACY ||
                keyStr === 'MediaPlay' ||
                codeStr === 'MediaPlay';

            if (isPlayKey) {
                e.preventDefault();
                eventBus.emit('key:play', e);
                return;
            }

            const isPauseKey =
                keyCode === ANDROID_KEYS.PAUSE ||
                keyCode === ANDROID_KEYS.PAUSE_ALT ||
                keyStr === 'MediaPause' ||
                codeStr === 'MediaPause';

            if (isPauseKey) {
                e.preventDefault();
                eventBus.emit('key:pause', e);
                return;
            }

            const isPlayPauseKey =
                keyCode === ANDROID_KEYS.PLAY_PAUSE ||
                keyCode === ANDROID_KEYS.PLAY_PAUSE_ALT ||
                keyCode === ANDROID_KEYS.PLAY_PAUSE_LEGACY ||
                keyStr === 'MediaPlayPause' ||
                codeStr === 'MediaPlayPause';

            if (isPlayPauseKey) {
                e.preventDefault();
                eventBus.emit('key:playPause', e);
                return;
            }

            const isStopKey =
                keyCode === ANDROID_KEYS.STOP ||
                keyCode === ANDROID_KEYS.STOP_ALT ||
                keyCode === ANDROID_KEYS.STOP_LEGACY ||
                keyStr === 'MediaStop' ||
                codeStr === 'MediaStop';

            if (isStopKey) {
                e.preventDefault();
                eventBus.emit('key:stop', e);
                return;
            }

            const isFastForwardKey =
                keyCode === ANDROID_KEYS.FAST_FORWARD ||
                keyCode === ANDROID_KEYS.FAST_FORWARD_ALT ||
                keyCode === ANDROID_KEYS.FAST_FORWARD_STEP ||
                keyCode === ANDROID_KEYS.FAST_FORWARD_SKIP ||
                keyCode === ANDROID_KEYS.FAST_FORWARD_LEGACY ||
                keyStr === 'MediaFastForward' ||
                keyStr === 'FastFwd' ||
                keyStr === 'SkipForward' ||
                codeStr === 'MediaFastForward' ||
                codeStr === 'FastFwd';

            if (isFastForwardKey) {
                e.preventDefault();
                eventBus.emit('key:fastForward', e);
                return;
            }

            const isRewindKey =
                keyCode === ANDROID_KEYS.REWIND ||
                keyCode === ANDROID_KEYS.REWIND_ALT ||
                keyCode === ANDROID_KEYS.REWIND_STEP ||
                keyCode === ANDROID_KEYS.REWIND_SKIP ||
                keyCode === ANDROID_KEYS.REWIND_LEGACY ||
                keyStr === 'MediaRewind' ||
                keyStr === 'Rewind' ||
                keyStr === 'SkipBackward' ||
                codeStr === 'MediaRewind' ||
                codeStr === 'Rewind';

            if (isRewindKey) {
                e.preventDefault();
                eventBus.emit('key:rewind', e);
                return;
            }

            const isNextKey =
                keyCode === ANDROID_KEYS.NEXT || keyStr === 'MediaTrackNext' || codeStr === 'MediaTrackNext';

            if (isNextKey) {
                e.preventDefault();
                eventBus.emit('key:next', e);
                return;
            }

            const isPrevKey =
                keyCode === ANDROID_KEYS.PREV || keyStr === 'MediaTrackPrevious' || codeStr === 'MediaTrackPrevious';

            if (isPrevKey) {
                e.preventDefault();
                eventBus.emit('key:previous', e);
                return;
            }

            // Determine if player page is actively rendering in the DOM
            const isPlayerActive = window.location.hash.startsWith('#/player');

            // Physical keyboard shortcuts when video player is active (J/K/L/M)
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

            // Prevent default spatial navigation jumps when browsing outside text fields
            if (!isTextInput) {
                const directionalKeys = [
                    ANDROID_KEYS.LEFT,
                    ANDROID_KEYS.RIGHT,
                    ANDROID_KEYS.UP,
                    ANDROID_KEYS.DOWN,
                    ANDROID_KEYS.ENTER
                ];

                // Prevent space bar page scroll when player is visible
                if (isPlayerActive && keyCode === 32) {
                    directionalKeys.push(32);
                }

                if (directionalKeys.includes(keyCode)) {
                    e.preventDefault();
                }
            }

            // Route standard navigation and legacy key codes to internal events
            switch (keyCode) {
                // Space bar play/pause toggle for physical keyboards
                case 32:
                    if (!isTextInput && isPlayerActive) {
                        e.preventDefault();
                        eventBus.emit('key:playPause', e);
                    }
                    break;

                // D-Pad directional navigation
                case ANDROID_KEYS.LEFT:
                    eventBus.emit('key:left', e);
                    break;
                case ANDROID_KEYS.RIGHT:
                    eventBus.emit('key:right', e);
                    break;
                case ANDROID_KEYS.UP:
                    eventBus.emit('key:up', e);
                    break;
                case ANDROID_KEYS.DOWN:
                    eventBus.emit('key:down', e);
                    break;
                case ANDROID_KEYS.ENTER:
                    eventBus.emit('key:enter', e);
                    break;

                // Channel stepping
                case ANDROID_KEYS.PAGE_UP:
                    eventBus.emit('key:channelUp', e);
                    break;
                case ANDROID_KEYS.PAGE_DOWN:
                    eventBus.emit('key:channelDown', e);
                    break;

                // Hardware Back and Escape keys
                case ANDROID_KEYS.BACK:
                case ANDROID_KEYS.ESCAPE:
                    e.preventDefault();
                    this.handleHardwareBack();
                    break;

                // Backspace acts as Back when outside text inputs
                case ANDROID_KEYS.BACKSPACE:
                    if (!isTextInput) {
                        e.preventDefault();
                        this.handleHardwareBack();
                    }
                    break;

                default:
                    // Propagate raw unhandled key for global or contextual listeners
                    eventBus.emit('key:any', { keyCode, event: e });
                    break;
            }
        };

        // Register both keydown and keyup listeners to capture standard physical remotes
        // alongside virtual remote injectors and accessibility tools (tvQuickActions)
        document.addEventListener('keydown', (e) => processKeyEvent(e, false));
        document.addEventListener('keyup', (e) => processKeyEvent(e, true));
    }

    /**
     * =========================================================================
     * Portrait Display Scale Calculation
     * =========================================================================
     * Fits a fixed design width (750px) using CSS zoom so the TV-authored layout
     * fills phone screens cleanly in portrait orientation.
    /**
     * Checks if portrait scale is currently active.
     * Delegates evaluation to LayoutManager's unified display scaling engine.
     * @private
     * @returns {boolean} True if viewport was portrait and handled
     */
    _applyPortraitScale() {
        if (typeof layoutManager !== 'undefined' && layoutManager?._applyDisplayScale) {
            layoutManager._applyDisplayScale();
        }
        return Boolean(document.documentElement?.hasAttribute?.('data-litefin-portrait'));
    }

    /**
     * =========================================================================
     * Display Scaling Engine (Phones & Tablets)
     * =========================================================================
     * Delegates mobile display scaling to LayoutManager's unified scaling engine,
     * which incorporates user display scale preferences across portrait & landscape.
     * @private
     */
    _applyDisplayScale() {
        if (typeof layoutManager !== 'undefined' && layoutManager?._applyDisplayScale) {
            layoutManager._applyDisplayScale();
        }
    }

    /**
     * ========================================================================
     * Deep Link Navigation Dispatcher
     * ========================================================================
     * Delegates deep-link navigation to AndroidLauncherManager when invoked
     * from native activity bridges or external hooks.
     *
     * @param {Object} actionData - Target coordinates { id, type, seriesid?, seasonid? }
     */
    handleDeepLink(actionData) {
        if (typeof window !== 'undefined' && window.androidLauncherManager?.handleDeepLink) {
            window.androidLauncherManager.handleDeepLink(actionData);
        } else if (typeof window !== 'undefined') {
            window.__pendingAndroidDeepLink = actionData;
        }
    }

    /**
     * Notifies native shell that JavaScript application has finished bootstrapping.
     * @private
     */
    _notifyReady() {
        try {
            if (typeof window.AndroidBridge?.notifyAppReady === 'function') {
                window.AndroidBridge.notifyAppReady();
            }
        } catch (e) {
            log.warn('notifyAppReady invocation failed:', e);
        }
    }

    /**
     * ========================================================================
     * Device Information Discovery
     * ========================================================================
     * Queries native Android bridges for hardware details.
     * @private
     */
    _loadDeviceInfo() {
        try {
            if (typeof window !== 'undefined') {
                const model = window.AndroidBridge?.getDeviceModel?.() || window.LitefinAndroid?.getDeviceName?.();
                if (model) {
                    this._deviceName = String(model);
                    log.info(`Identified Android device model: ${this._deviceName}`);
                }
                const brand = window.AndroidBridge?.getDeviceBrand?.() || window.LitefinAndroid?.getDeviceBrand?.();
                if (brand) {
                    this._manufacturer = String(brand);
                }
            }
        } catch (err) {
            log.warn('Failed retrieving device info from native bridge:', err);
        }
    }

    /**
     * Returns human-readable device model name.
     * @returns {string}
     */
    getDeviceName() {
        if (this._deviceName) {
            return this._deviceName;
        }
        try {
            if (typeof window !== 'undefined') {
                const model = window.AndroidBridge?.getDeviceModel?.() || window.LitefinAndroid?.getDeviceName?.();
                if (model) {
                    this._deviceName = String(model);
                    return this._deviceName;
                }
            }
        } catch (err) {
            log.warn('Failed retrieving device name:', err);
        }
        return 'Android Device';
    }

    /**
     * Returns device manufacturer name.
     * @returns {string}
     */
    getManufacturer() {
        if (this._manufacturer) {
            return this._manufacturer;
        }
        try {
            if (typeof window !== 'undefined') {
                const brand = window.AndroidBridge?.getDeviceBrand?.() || window.LitefinAndroid?.getDeviceBrand?.();
                if (brand) {
                    this._manufacturer = String(brand);
                    return this._manufacturer;
                }
            }
        } catch (err) {
            log.warn('Failed retrieving manufacturer:', err);
        }
        return 'Android';
    }

    /**
     * ========================================================================
     * Application Exit Handler
     * ========================================================================
     * Flushes pending storage cache to disk and terminates the host Android
     * activity via native bridge or Tauri IPC.
     */
    exit() {
        log.info('Exiting Android application...');

        // Flush all pending storage state to disk
        try {
            storage.flush();
        } catch (err) {
            log.warn('Storage flush failed during exit:', err);
        }

        try {
            // 1. Check window.LitefinAndroid.exit() bridge
            if (typeof window !== 'undefined' && typeof window.LitefinAndroid?.exit === 'function') {
                log.info('Invoking native LitefinAndroid.exit() bridge');
                window.LitefinAndroid.exit();
                return;
            }

            // 2. Check window.AndroidBridge.exitApp() bridge
            if (typeof window !== 'undefined' && typeof window.AndroidBridge?.exitApp === 'function') {
                log.info('Invoking AndroidBridge.exitApp() bridge');
                window.AndroidBridge.exitApp();
                return;
            }

            // 3. Tauri v2 IPC bridge fallback
            if (typeof window !== 'undefined' && window.__TAURI_INTERNALS__?.invoke) {
                log.info('Invoking Tauri plugin:app|exit IPC command');
                window.__TAURI_INTERNALS__.invoke('plugin:app|exit').catch(() => {
                    window.close();
                });
                return;
            }

            // 4. Browser window close fallback
            log.info('Falling back to window.close()');
            window.close();
        } catch (err) {
            log.error('Failed exiting Android application cleanly:', err);
        }
    }
}

// Export singleton instance and class definition
export const androidAdapter = new AndroidAdapter();
export default androidAdapter;
