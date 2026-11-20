/**
 * ============================================================================
 * Litefin Tizen - Settings Reset & Hard-Reload Controller
 * ============================================================================
 * Manages cold-start application reload navigations and system reset workflows.
 * Ensures complete module re-initialization on Smart TV webviews (Tizen and webOS)
 * by stripping hash fragments to bypass soft-reload caching issues.
 * ============================================================================
 */

import { storage } from '../../../utils/StorageService.js';
import { PlayerSettings } from '../../../utils/PlayerSettings.js';
import { logger } from '../../../utils/Logger.js';

const log = logger.create('SettingsResetController');

/**
 * Controller governing reset routines and hardware WebView reload cycles.
 */
export class SettingsResetController {
    /**
     * Creates an instance of SettingsResetController.
     * @param {Object} page Host SettingsPage instance
     */
    constructor(page) {
        this.page = page;
    }

    /**
     * Computes the clean base root entry URL without hash routing fragments.
     * Differentiates packaged local file schemes from hosted HTTP development servers.
     *
     * @returns {string} Root entry point URL suitable for cold navigation
     */
    getReloadEntryUrl() {
        const href = window.location.href;
        const protocol = window.location.protocol;

        // Strip everything from the hash fragment onward for file:// packaged apps
        if (protocol === 'file:') {
            return href.split('#')[0];
        }

        // Use origin plus pathname for standard HTTP/HTTPS dev server environments
        return window.location.origin + window.location.pathname;
    }

    /**
     * Triggers a true cold-start hard navigation.
     * Flushes persistent storage and navigates to the root entry-point URL.
     *
     * Explanation:
     * Standard window.location.reload() performs a soft reload on Tizen and webOS,
     * preserving in-memory module states. A root URL navigation forces a full restart,
     * re-running initialization sequences like i18n locale loading and CSS theme application.
     */
    triggerHardReload() {
        log.info('Flushing storage and initiating cold-start application reload');

        // Flush all pending synchronous storage operations to disk
        try {
            storage.flush();
        } catch (err) {
            log.warn('Storage flush prior to hard reload failed:', err);
        }

        // Compute clean URL and execute navigation
        const entryUrl = this.getReloadEntryUrl();
        window.location.href = entryUrl;
    }

    /**
     * Restores all application, video player, and layout settings to default states.
     * Clears user preferences and triggers a hard reload to apply fresh defaults.
     */
    resetAllSettings() {
        log.warn('Performing full application settings reset to factory defaults');

        try {
            // Reset player settings registry
            PlayerSettings.resetAll();

            // Clear custom layout and appearance image preset overrides
            storage.removeItem('image_preset');
            storage.removeItem('image_details_preset');

            // Force hard restart into initial state
            this.triggerHardReload();
        } catch (err) {
            log.error('Failed to perform complete settings reset:', err);
        }
    }
}

export default SettingsResetController;
