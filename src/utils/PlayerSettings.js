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
import { storage } from './StorageService.js';

const log = logger.create('PlayerSettings');

/**
 * Default values for all player settings
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

    // Subtitle drop shadow ('none', 'uniform', 'dropshadow', 'raised', 'depressed')
    subtitleDropShadow: 'uniform',

    // Drop shadow color
    subtitleDropShadowColor: '#000000',

    // Drop shadow opacity (0-100)
    subtitleDropShadowOpacity: 20,

    // Drop shadow blur radius (px)
    subtitleDropShadowBlur: 6,

    // Custom subtitle font (empty = system default)
    subtitleFont: '',

    // Custom ASS subtitle font (empty = system default)
    // Separate setting for Anime/ASS content
    subtitleFontAss: '',

    // Global font scale multiplier for ASS subtitles
    subtitleFontScale: 1.0,

    // Outline thickness for ASS (baseline is 0.4)
    subtitleOutlineThickness: 0.4,

    // Shadow thickness for ASS (baseline is 0.3)
    subtitleShadowThickness: 0.3,

    // Subtitle text color
    subtitleTextColor: '#ffffff',

    // Subtitle text opacity (0-100)
    subtitleTextOpacity: 100,

    // Subtitle background color
    subtitleTextBackground: 'transparent',

    // Subtitle background opacity (0-100)
    subtitleBackgroundOpacity: 100,

    // Vertical Position (-1 = top, -2 = bottom standard, etc. See SubtitleStyles.js)
    subtitleVerticalPosition: '-2',

    // Custom Vertical Position (0-100% from bottom, used when subtitleVerticalPosition is 'custom')
    subtitleVerticalPositionCustom: 10,

    // Burn-in subtitles mode ('', 'allcomplex', 'all')
    subtitleBurnIn: '',

    // =========================================================================
    // DEVICE PROFILE / COMPATIBILITY SETTINGS
    // =========================================================================

    // Enable HEVC/H.265 codec for direct play (safe to leave on for all Tizen 4+)
    enableHEVC: true,

    // Enable AV1 codec (auto-gated by Tizen version ≥ 5.5 in DeviceProfile)
    enableAV1: true,

    // Enable VP9 codec (auto-gated by Tizen version / panel resolution)
    enableVP9: true,

    // Enable HDR10/HLG pass-through
    enableHDR: true,

    // Enable Dolby Vision pass-through (auto-detected via avinfo API)
    enableDolbyVision: true,

    // Enable DTS and TrueHD — see AUDIO SETTINGS above (enableDts, enableTrueHd)

    // Maximum resolution ('auto', '720p', '1080p', '2160p', '4320p')
    // 'auto' uses hardware detection via webapis
    maxResolution: 'auto',

    // Force all content to transcode (emergency/debug fallback)
    forceTranscode: false,

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

        const stored = storage.getItem(STORAGE_PREFIX + key);
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

        storage.setItem(STORAGE_PREFIX + key, String(value));
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
            storage.removeItem(STORAGE_PREFIX + key);
        }
    },

    /**
     * Reset all settings to defaults
     */
    resetAll() {
        for (const key of Object.keys(DEFAULTS)) {
            storage.removeItem(STORAGE_PREFIX + key);
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
