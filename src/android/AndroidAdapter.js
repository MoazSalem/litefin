/**
 * ============================================================================
 * Litefin - Android Adapter
 * ============================================================================
 * Handles all Android-specific functionality when running inside the Android
 * WebView host application:
 * - Hardware/system Back gesture and Back button mapping
 * - App exit requests forwarded to the native shell
 * - Device identification for the Jellyfin dashboard (device name/model)
 *
 * Communication with the native shell happens over the injected
 * `window.AndroidBridge` JavascriptInterface (see LitefinBridge.java in the
 * android/ host project). Every bridge call is wrapped in try/catch because
 * the bridge is absent when this bundle runs in a plain desktop browser.
 * ============================================================================
 */

import { eventBus } from '../core/EventBus.js';
import { storage } from '../utils/StorageService.js';
import { logger } from '../utils/Logger.js';

const log = logger.create('AndroidAdapter');

class AndroidAdapter {
    constructor() {
        this._isAndroid = false;
        this._deviceInfo = null;

        // Immediate platform detection via the injected native bridge.
        this._detectPlatform();
    }

    /**
     * Get idle time in milliseconds
     * @returns {number} Idle time
     */
    get idleTime() {
        // The Android shell does not push idle events; report as always active.
        return 0;
    }

    /**
     * Report an input interaction (touch etc from outside). No-op on Android —
     * the OS handles screen-off/idle behavior natively.
     */
    reportInput() {
        /* Intentionally empty — parity with other adapters. */
    }

    /**
     * Detect if running on the Android WebView platform
     * @private
     */
    _detectPlatform() {
        if (typeof window !== 'undefined' && typeof window.AndroidBridge !== 'undefined') {
            this._isAndroid = true;
            log.info('Running on Android adapter mode (native bridge present)');
        } else {
            log.info('Not running on Android platform (bridge absent)');
        }
    }

    /**
     * Initialize Android-specific features.
     * Called from App.init() when platformInfo.isAndroid is true.
     */
    init() {
        if (!this._isAndroid) return;

        log.info('Initializing AndroidAdapter...');

        /*
         * Expose a global hook the native shell invokes when the hardware
         * Back button/gesture is used. The Activity calls
         * window.__litefinAndroidBack() via evaluateJavascript; we translate
         * it into the standard 'key:back' event so all existing TV back
         * handling (modals, router history, exit flow) works unchanged.
         */
        try {
            window.__litefinAndroidBack = () => this.handleBackButton();
        } catch (e) {
            log.warn('Failed to register back hook:', e);
        }

        // Notify the shell that the web app finished booting (hides the
        // native splash window on devices where it is shown).
        this._notifyReady();

        log.info('AndroidAdapter initialized');
    }

    /**
     * Tell the native shell the app is ready (hides native splash).
     * @private
     */
    _notifyReady() {
        try {
            if (typeof window.AndroidBridge?.notifyAppReady === 'function') {
                window.AndroidBridge.notifyAppReady();
            }
        } catch (e) {
            log.warn('notifyAppReady failed:', e);
        }
    }

    /**
     * Ask the native shell to finish the activity (app exit).
     * Mirrors tizenAdapter.exit() / webosAdapter.exit().
     */
    exit() {
        try {
            storage.flush();
        } catch (_) {
            /* storage may be unavailable very early — non-fatal */
        }
        try {
            if (typeof window.AndroidBridge?.exitApp === 'function') {
                log.info('Exiting application via AndroidBridge.exitApp()');
                window.AndroidBridge.exitApp();
            }
        } catch (e) {
            log.error('Failed to exit via Android bridge:', e);
        }
    }

    /**
     * Get device name for server identification.
     * The bridge exposes Build.MODEL from the native side; falls back to a
     * generic name when the property is missing.
     * @returns {string} Device name (e.g. "SM-S928B" for Galaxy S24 Ultra)
     */
    getDeviceName() {
        try {
            const model = window.AndroidBridge?.getDeviceModel?.();
            if (model) return String(model);
        } catch (e) {
            log.warn('getDeviceModel failed:', e);
        }
        return 'Android Device';
    }

    /**
     * Get device manufacturer
     * @returns {string} Manufacturer name (e.g. "samsung")
     */
    getManufacturer() {
        try {
            const brand = window.AndroidBridge?.getDeviceBrand?.();
            if (brand) return String(brand);
        } catch (e) {
            log.warn('getDeviceBrand failed:', e);
        }
        return 'Android';
    }

    /**
     * Handle the hardware/system Back button dispatched by the native shell.
     * The Android host forwards the back event into the web app; we translate
     * it into the same eventBus message the TV adapters use so every existing
     * back-handler (modals, router history, exit) works unchanged.
     * @param {Object} [payload] - Optional extra data from the shell
     */
    handleBackButton(payload = {}) {
        log.debug('Hardware back pressed');
        eventBus.emit('key:back', { source: 'android-bridge', ...payload });
    }

    get isAndroid() {
        return this._isAndroid;
    }
    get deviceInfo() {
        return this._deviceInfo;
    }
}

export const androidAdapter = new AndroidAdapter();
export default androidAdapter;
