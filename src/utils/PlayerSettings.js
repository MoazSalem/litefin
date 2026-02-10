/**
 * ============================================================================
 * Litefin Tizen - Player Settings Manager
 * ============================================================================
 * Centralized settings manager for the Jellyfin Player integration.
 * Uses localStorage with 'player:' prefix for all settings.
 *
 * Settings are organized into categories:
 * - Audio: Channel configuration, codecs
 * - Video: Bitrate limits, preferred codecs
 * - Subtitles: Appearance, behavior, positioning
 * - Playback: Skip durations, auto-play behavior
 * ============================================================================
 */

import { logger } from './Logger.js';

const log = logger.create('PlayerSettings');

/**
 * Default values for all player settings
 * These match the patterns from moonfin-tizen's settings.js
 */
const DEFAULTS = {
    // =========================================================================
    // AUDIO SETTINGS
    // =========================================================================

    // Maximum audio channels (-1 = all available)
    allowedAudioChannels: -1,

    // Enable DTS passthrough (requires hardware support)
    enableDts: false,

    // Enable TrueHD passthrough (requires hardware support)
    enableTrueHd: false,

    // Audio normalization mode ('Off', 'TrackGain', 'AlbumGain')
    audioNormalization: 'Off',

    // =========================================================================
    // VIDEO SETTINGS
    // =========================================================================

    // Max streaming bitrate for internet (120 Mbps default)
    maxBitrateInternet: 120000000,

    // Max streaming bitrate on home network (0 = unlimited)
    maxBitrateInNetwork: 0,

    // Preferred video codec ('', 'h265', 'vp9', 'av1')
    preferredVideoCodec: '',

    // =========================================================================
    // SUBTITLE SETTINGS
    // =========================================================================

    // Subtitle mode ('Default', 'Smart', 'OnlyForced', 'Always', 'None')
    subtitleMode: 'Default',

    // Subtitle text size ('small', 'medium', 'large', 'larger', 'extralarge')
    subtitleSize: 'medium',

    // Subtitle font weight ('normal', 'bold', 'bolder')
    subtitleWeight: 'normal',

    // Subtitle drop shadow ('none', 'dropshadow', 'raised', 'depressed', 'uniform')
    subtitleDropShadow: 'dropshadow',

    // Custom subtitle font (empty = system default)
    subtitleFont: '',

    // Subtitle text color
    subtitleTextColor: '#ffffff',

    // Subtitle text opacity (0-100)
    subtitleTextOpacity: 100,

    // Subtitle background color
    subtitleTextBackground: 'transparent',

    // Subtitle background opacity (0-100)
    subtitleBackgroundOpacity: 100,

    // Vertical position offset (-5 to 5, negative = higher)
    subtitleVerticalPosition: -2,

    // Burn-in subtitles mode ('', 'allcomplex', 'all')
    subtitleBurnIn: '',

    // =========================================================================
    // PLAYBACK SETTINGS
    // =========================================================================

    // Skip forward duration in milliseconds
    skipForwardLength: 10000,

    // Skip back duration in milliseconds
    skipBackLength: 5000,

    // Auto-play next episode when current finishes
    enableNextEpisodeAutoPlay: true,

    // Enable cinema mode (dim lights during playback)
    enableCinemaMode: false
};

/**
 * Storage key prefix for all player settings
 */
const STORAGE_PREFIX = 'player:';

/**
 * Player Settings Manager
 * Provides get/set/reset functionality for all player-related preferences
 */
export const PlayerSettings = {
    /**
     * Get a setting value
     * @param {string} key - Setting key from DEFAULTS
     * @returns {*} Setting value or default
     */
    get(key) {
        if (!(key in DEFAULTS)) {
            log.warn(`Unknown setting: ${key}`);
            return undefined;
        }

        const stored = localStorage.getItem(STORAGE_PREFIX + key);
        if (stored === null) {
            return DEFAULTS[key];
        }

        // Parse based on default type
        const defaultValue = DEFAULTS[key];
        if (typeof defaultValue === 'boolean') {
            return stored === 'true';
        } else if (typeof defaultValue === 'number') {
            return Number(stored);
        }
        return stored;
    },

    /**
     * Set a setting value
     * @param {string} key - Setting key
     * @param {*} value - Value to store
     */
    set(key, value) {
        if (!(key in DEFAULTS)) {
            log.warn(`Unknown setting: ${key}`);
            return;
        }

        localStorage.setItem(STORAGE_PREFIX + key, String(value));
        log.debug(`Saved ${key}: ${value}`);
    },

    /**
     * Get all settings as an object
     * @returns {Object} All settings with current values
     */
    getAll() {
        const result = {};
        for (const key of Object.keys(DEFAULTS)) {
            result[key] = this.get(key);
        }
        return result;
    },

    /**
     * Reset a specific setting to default
     * @param {string} key - Setting key
     */
    reset(key) {
        if (key in DEFAULTS) {
            localStorage.removeItem(STORAGE_PREFIX + key);
        }
    },

    /**
     * Reset all settings to defaults
     */
    resetAll() {
        for (const key of Object.keys(DEFAULTS)) {
            localStorage.removeItem(STORAGE_PREFIX + key);
        }
        log.info('All settings reset to defaults');
    },

    /**
     * Get default values (for reference in UI)
     */
    getDefaults() {
        return { ...DEFAULTS };
    }
};

export default PlayerSettings;
