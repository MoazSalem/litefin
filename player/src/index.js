/**
 * Jellyfin Player - Main Entry Point
 * 
 * A standalone, reusable video player extracted from jellyfin-web
 * with support for HTML5 video and Tizen AVPlay backends.
 * 
 * @module jellyfin-player
 */

import { JellyfinPlayer } from './core/JellyfinPlayer';
import { SettingsManager } from './settings/SettingsManager';
import { SettingsPage } from './ui/settings/SettingsPage';
import { PlayerBridge } from './bridge/PlayerBridge';
import { debug } from './utils/debug';

// Import styles
import './ui/osd/osd.scss';

// ============================================================================
// Export public API
// ============================================================================

export { JellyfinPlayer, SettingsManager, SettingsPage, PlayerBridge };

// Default export for UMD bundle - exposes window.JellyfinPlayer
const api = {
    JellyfinPlayer,
    SettingsManager,
    SettingsPage,
    PlayerBridge,

    /**
     * Quick initialization for WebView usage.
     * Creates player instance and attaches to window for host app access.
     * 
     * @param {Object} config - Initial configuration
     * @returns {JellyfinPlayer} Player instance
     */
    init(config = {}) {
        const container = config.container || document.getElementById('player-container');
        const settings = new SettingsManager();

        const player = new JellyfinPlayer({
            container,
            settings,
            serverUrl: config.serverUrl,
            authToken: config.authToken,
            useTizenPlayer: config.useTizenPlayer ?? this.isTizen()
        });

        // Set up bridge for WebView communication
        const bridge = new PlayerBridge(player, settings);
        bridge.attach();

        // Expose on window for host app
        window.JellyfinPlayerInstance = player;

        return player;
    },

    /**
     * Initialize Settings Page
     * @param {Object} config
     * @returns {SettingsPage}
     */
    initSettings(config = {}) {
        const container = config.container || document.getElementById('settings-app');
        if (!container) return null;

        const settingsManager = new SettingsManager();
        const page = new SettingsPage({
            container,
            settingsManager
        });

        page.init();

        // Expose settings manager globally for host app interaction if needed
        window.JellyfinSettingsManager = settingsManager;

        // Helper to set settings from host
        this.setSettings = (newSettings) => {
            for (const [key, value] of Object.entries(newSettings)) {
                settingsManager[key] = value;
            }
            // Reload UI
            page.loadValues();
        };

        this.getSettings = () => settingsManager.exportSettings();
        this.resetSettings = () => {
            settingsManager.resetToDefaults();
            page.loadValues();
        };

        return page;
    },

    /**
     * Detect if running on Tizen platform
     * @returns {boolean}
     */
    isTizen() {
        const hasTizenApi = !!(window.tizen || window.webapis?.avplay);
        const hasTizenUserAgent = /Tizen/i.test(navigator.userAgent);
        debug.log('[JellyfinPlayer] isTizen check - tizen:', !!window.tizen, 'webapis.avplay:', !!window.webapis?.avplay, 'UA:', hasTizenUserAgent);
        return hasTizenApi || hasTizenUserAgent;
    }
};

export default api;

// Auto-initialize if on settings page
if (typeof document !== 'undefined') {
    if (document.getElementById('settings-app')) {
        // Defer slightly to ensure DOM is ready? 
        // Bundler usually puts script in head or end of body. 
        // If head (as configured in HTML plugin), we need DOMContentLoaded.
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => api.initSettings());
        } else {
            api.initSettings();
        }
    }
}
