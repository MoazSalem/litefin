/**
 * SettingsManager - Unified Settings API
 *
 * Consolidates all player-related settings with localStorage persistence.
 * Settings can be synced with Jellyfin server for user preferences.
 *
 * @module settings/SettingsManager
 */

// ============================================================================
// Default Settings
// ============================================================================

const DEFAULTS = {
    // Audio Settings
    allowedAudioChannels: -1, // -1 = Auto detect
    audioLanguagePreference: '',
    playDefaultAudioTrack: false,
    enableDts: false,
    enableTrueHd: false,
    disableVbrAudio: false,
    audioNormalization: 'Off',

    // Video Quality Settings
    maxVideoWidth: 0, // 0 = Auto
    maxBitrateInNetwork: 0, // 0 = Auto
    maxBitrateInternet: 120000000, // 120 Mbps default (for Direct Play)
    limitSupportedResolution: false,
    preferredVideoCodec: '',
    preferredAudioCodec: '',
    enableH264Hi10p: false,
    preferFmp4Hls: false,

    // Subtitle Settings
    subtitleLanguagePreference: '',
    subtitleMode: 'Default', // Default, Smart, Always, OnlyForced, None
    subtitleBurnIn: '', // '', 'all', 'onlyImageFormats', 'onlyText'
    renderPgs: false,

    // Subtitle Appearance
    subtitleSize: 'medium', // Options: smaller, small, medium, larger, extralarge
    subtitleWeight: 'normal',
    subtitleDropShadow: 'dropshadow', // Options: dropshadow, raised, depressed, uniform, heavy, none
    subtitleFont: '',
    subtitleTextColor: '#ffffff',
    subtitleTextBackground: 'transparent',
    subtitleVerticalPosition: -3,

    // Playback Behavior
    enableCinemaMode: true,
    enableNextEpisodeAutoPlay: false,
    showNextVideoInfoOverlay: true,
    skipForwardLength: 10000, // 10 seconds (options: 5, 10, 15, 20, 25, 30, 45, 60)
    skipBackLength: 5000, // 5 seconds (options: 5, 10, 15, 20, 25, 30, 45, 60)
    rememberAudioSelections: false,
    rememberSubtitleSelections: false,

    // Platform Settings
    useTizenPlayer: 'auto', // 'auto', 'true', 'false'

    // Media Segment Actions
    segmentIntro: 'None',
    segmentOutro: 'None',
    segmentPreview: 'None',
    segmentRecap: 'None',
    segmentCommercial: 'None'
};

// ============================================================================
// SettingsManager Class
// ============================================================================

export class SettingsManager {
    constructor() {
        this._prefix = 'jellyfin-player-';
        this._cache = {};

        // Load all settings into cache
        this._loadAll();
    }

    // ========================================================================
    // Core Methods
    // ========================================================================

    /**
     * Load all settings from localStorage
     * @private
     */
    _loadAll() {
        for (const key of Object.keys(DEFAULTS)) {
            this._cache[key] = this._get(key);
        }
    }

    /**
     * Get setting value
     * @private
     */
    _get(key) {
        const stored = localStorage.getItem(this._prefix + key);

        if (stored === null) {
            return DEFAULTS[key];
        }

        // Parse based on default type
        const defaultValue = DEFAULTS[key];

        if (typeof defaultValue === 'boolean') {
            return stored === 'true';
        }
        if (typeof defaultValue === 'number') {
            const num = parseFloat(stored);
            return isNaN(num) ? defaultValue : num;
        }

        return stored;
    }

    /**
     * Set setting value
     * @private
     */
    _set(key, value) {
        this._cache[key] = value;

        if (value === DEFAULTS[key]) {
            localStorage.removeItem(this._prefix + key);
        } else {
            localStorage.setItem(this._prefix + key, String(value));
        }
    }

    // ========================================================================
    // Audio Settings
    // ========================================================================

    get allowedAudioChannels() {
        return this._cache.allowedAudioChannels;
    }
    set allowedAudioChannels(val) {
        this._set('allowedAudioChannels', val);
    }

    get audioLanguagePreference() {
        return this._cache.audioLanguagePreference;
    }
    set audioLanguagePreference(val) {
        this._set('audioLanguagePreference', val);
    }

    get playDefaultAudioTrack() {
        return this._cache.playDefaultAudioTrack;
    }
    set playDefaultAudioTrack(val) {
        this._set('playDefaultAudioTrack', val);
    }

    get enableDts() {
        return this._cache.enableDts;
    }
    set enableDts(val) {
        this._set('enableDts', val);
    }

    get enableTrueHd() {
        return this._cache.enableTrueHd;
    }
    set enableTrueHd(val) {
        this._set('enableTrueHd', val);
    }

    get disableVbrAudio() {
        return this._cache.disableVbrAudio;
    }
    set disableVbrAudio(val) {
        this._set('disableVbrAudio', val);
    }

    get audioNormalization() {
        return this._cache.audioNormalization;
    }
    set audioNormalization(val) {
        this._set('audioNormalization', val);
    }

    // ========================================================================
    // Video Quality Settings
    // ========================================================================

    get maxVideoWidth() {
        return this._cache.maxVideoWidth;
    }
    set maxVideoWidth(val) {
        this._set('maxVideoWidth', val);
    }

    get maxBitrateInNetwork() {
        return this._cache.maxBitrateInNetwork;
    }
    set maxBitrateInNetwork(val) {
        this._set('maxBitrateInNetwork', val);
    }

    get maxBitrateInternet() {
        return this._cache.maxBitrateInternet;
    }
    set maxBitrateInternet(val) {
        this._set('maxBitrateInternet', val);
    }

    /**
     * Get max bitrate for streaming
     * @param {boolean} [isInNetwork=false] - Whether on local network
     * @returns {number}
     */
    getMaxBitrate(isInNetwork = false) {
        const bitrate = isInNetwork ? this.maxBitrateInNetwork : this.maxBitrateInternet;

        // 0 means auto - return high value
        return bitrate || 120000000;
    }

    get limitSupportedResolution() {
        return this._cache.limitSupportedResolution;
    }
    set limitSupportedResolution(val) {
        this._set('limitSupportedResolution', val);
    }

    get preferredVideoCodec() {
        return this._cache.preferredVideoCodec;
    }
    set preferredVideoCodec(val) {
        this._set('preferredVideoCodec', val);
    }

    get preferredAudioCodec() {
        return this._cache.preferredAudioCodec;
    }
    set preferredAudioCodec(val) {
        this._set('preferredAudioCodec', val);
    }

    get enableH264Hi10p() {
        return this._cache.enableH264Hi10p;
    }
    set enableH264Hi10p(val) {
        this._set('enableH264Hi10p', val);
    }

    get preferFmp4Hls() {
        return this._cache.preferFmp4Hls;
    }
    set preferFmp4Hls(val) {
        this._set('preferFmp4Hls', val);
    }

    // ========================================================================
    // Subtitle Settings
    // ========================================================================

    get subtitleLanguagePreference() {
        return this._cache.subtitleLanguagePreference;
    }
    set subtitleLanguagePreference(val) {
        this._set('subtitleLanguagePreference', val);
    }

    get subtitleMode() {
        return this._cache.subtitleMode;
    }
    set subtitleMode(val) {
        this._set('subtitleMode', val);
    }

    get subtitleBurnIn() {
        return this._cache.subtitleBurnIn;
    }
    set subtitleBurnIn(val) {
        this._set('subtitleBurnIn', val);
    }

    get renderPgs() {
        return this._cache.renderPgs;
    }
    set renderPgs(val) {
        this._set('renderPgs', val);
    }

    /**
     * Get subtitle appearance settings object
     * @returns {Object}
     */
    getSubtitleAppearance() {
        return {
            size: this._cache.subtitleSize,
            weight: this._cache.subtitleWeight,
            dropShadow: this._cache.subtitleDropShadow,
            font: this._cache.subtitleFont,
            textColor: this._cache.subtitleTextColor,
            textBackground: this._cache.subtitleTextBackground,
            verticalPosition: this._cache.subtitleVerticalPosition
        };
    }

    /**
     * Set subtitle appearance from object
     * @param {Object} settings
     */
    setSubtitleAppearance(settings) {
        if (settings.size !== undefined) this._set('subtitleSize', settings.size);
        if (settings.weight !== undefined) this._set('subtitleWeight', settings.weight);
        if (settings.dropShadow !== undefined) this._set('subtitleDropShadow', settings.dropShadow);
        if (settings.font !== undefined) this._set('subtitleFont', settings.font);
        if (settings.textColor !== undefined) this._set('subtitleTextColor', settings.textColor);
        if (settings.textBackground !== undefined) this._set('subtitleTextBackground', settings.textBackground);
        if (settings.verticalPosition !== undefined) this._set('subtitleVerticalPosition', settings.verticalPosition);
    }

    // ========================================================================
    // Playback Behavior Settings
    // ========================================================================

    get enableCinemaMode() {
        return this._cache.enableCinemaMode;
    }
    set enableCinemaMode(val) {
        this._set('enableCinemaMode', val);
    }

    get enableNextEpisodeAutoPlay() {
        return this._cache.enableNextEpisodeAutoPlay;
    }
    set enableNextEpisodeAutoPlay(val) {
        this._set('enableNextEpisodeAutoPlay', val);
    }

    get showNextVideoInfoOverlay() {
        return this._cache.showNextVideoInfoOverlay;
    }
    set showNextVideoInfoOverlay(val) {
        this._set('showNextVideoInfoOverlay', val);
    }

    get skipForwardLength() {
        return this._cache.skipForwardLength;
    }
    set skipForwardLength(val) {
        this._set('skipForwardLength', val);
    }

    get skipBackLength() {
        return this._cache.skipBackLength;
    }
    set skipBackLength(val) {
        this._set('skipBackLength', val);
    }

    get rememberAudioSelections() {
        return this._cache.rememberAudioSelections;
    }
    set rememberAudioSelections(val) {
        this._set('rememberAudioSelections', val);
    }

    get rememberSubtitleSelections() {
        return this._cache.rememberSubtitleSelections;
    }
    set rememberSubtitleSelections(val) {
        this._set('rememberSubtitleSelections', val);
    }

    // ========================================================================
    // Platform Settings
    // ========================================================================

    get useTizenPlayer() {
        return this._cache.useTizenPlayer;
    }
    set useTizenPlayer(val) {
        this._set('useTizenPlayer', val);
    }

    /**
     * Determine if Tizen player should be used
     * @returns {boolean}
     */
    shouldUseTizenPlayer() {
        const setting = this.useTizenPlayer;

        if (setting === 'true') return true;
        if (setting === 'false') return false;

        // Auto-detect
        return !!window.tizen?.avplay;
    }

    // ========================================================================
    // Media Segment Actions
    // ========================================================================

    getSegmentAction(type) {
        const key = 'segment' + type.charAt(0).toUpperCase() + type.slice(1);
        return this._cache[key] || 'None';
    }

    setSegmentAction(type, action) {
        const key = 'segment' + type.charAt(0).toUpperCase() + type.slice(1);
        this._set(key, action);
    }

    // ========================================================================
    // Export/Import
    // ========================================================================

    /**
     * Export all settings as JSON
     * @returns {Object}
     */
    exportSettings() {
        return { ...this._cache };
    }

    /**
     * Import settings from JSON
     * @param {Object} data
     */
    importSettings(data) {
        for (const [key, value] of Object.entries(data)) {
            if (key in DEFAULTS) {
                this._set(key, value);
            }
        }
    }

    /**
     * Reset all settings to defaults
     */
    resetToDefaults() {
        for (const key of Object.keys(DEFAULTS)) {
            localStorage.removeItem(this._prefix + key);
            this._cache[key] = DEFAULTS[key];
        }
    }
}
