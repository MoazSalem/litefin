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
import { eventBus } from '../core/EventBus.js';
import { platformInfo } from './PlatformInfo.js';

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
    enableDts: 'auto',

    // Enable TrueHD passthrough (requires hardware support)
    enableTrueHd: 'auto',

    // -------------------------------------------------------------------------
    // EAC3 (E-AC3 / Dolby Digital Plus) FORCE STATE
    // -------------------------------------------------------------------------
    // On some platforms (WebOS, web browsers), the canPlayType / isTypeSupported
    // probe for EAC3 returns '' (unsupported) even when the hardware is capable.
    // This is a known bug — particularly on LG WebOS TVs where the Chromium build
    // reports no EAC3 support, yet the native media pipeline passes it through
    // eARC just fine.
    //
    // When this reports false:
    //   - EAC3 is excluded from the DirectPlay audio codec list (Jellyfin treats
    //     source EAC3 tracks as unsupported and forces an unnecessary transcode).
    //   - The transcode target codec check (WebProfile) rejects EAC3 even when
    //     the user has chosen it, silently falling back to AAC.
    //
    // 'auto'    — trust the hardware probe (default; may be wrong on some TVs)
    // 'enable'  — force EAC3 into the profile regardless of what the probe says
    // 'disable' — explicitly exclude EAC3 even if the probe says it is supported
    enableEac3: 'auto',

    // -------------------------------------------------------------------------
    // PREFERRED TRANSCODE AUDIO CODEC
    // -------------------------------------------------------------------------
    // Controls which audio codec Jellyfin targets when it must transcode the
    // audio stream (e.g. DTS is not natively supported, so it transcodes to one
    // of these lossy surround formats).
    //
    // Valid values:
    //   'eac3'  — E-AC3 / Dolby Digital Plus: higher quality, ~640 kbps cap.
    //             Modern AVRs (HDMI 1.4+, eARC) handle this natively. Default.
    //   'ac3'   — AC3 / Dolby Digital: widest compatibility, capped at 640 kbps
    //             on the 5.1 layout. Best for older receivers.
    //   'aac'   — Advanced Audio Coding: stereo/multichannel, universal browser
    //             support. Choose this on devices that can't decode AC3/EAC3
    //             at all (e.g. phones, tablets).
    //
    // NOTE: This only affects HLS transcode output. DirectPlay/DirectStream paths
    // bypass this entirely — the source audio is copied as-is in those cases.
    transcodeAudioCodec: 'eac3',

    // Allow FLAC audio in video containers (MKV, MP4, etc.) to DirectPlay.
    // Disabled by default: FLAC demuxing inside video containers causes a ~2s
    // A/V sync drift on Tizen hardware (the audio buffer diverges from the video
    // PTS). FLAC audio-only files (.flac containers) are NOT affected by this
    // setting — those always DirectPlay regardless.
    enableFlacInVideo: false,

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

    // Remember tracks for session (automatically carry active audio and subtitle to next episode)
    rememberTracksForSession: true,

    // Subtitle text size ('small', 'medium', 'large', 'larger', 'extralarge', 'custom')
    subtitleSize: 'medium',

    // Custom subtitle size value (used when subtitleSize is 'custom')
    subtitleSizeCustomValue: 5,

    // Subtitle font weight ('normal', 'bold', 'bolder')
    subtitleWeight: 'normal',

    // Subtitle drop shadow ('none', 'uniform', 'dropshadow', 'raised', 'depressed', 'border')
    subtitleDropShadow: 'uniform',

    // Drop shadow color
    subtitleDropShadowColor: '#000000',

    // Drop shadow opacity (0-100)
    subtitleDropShadowOpacity: 20,

    // Drop shadow blur radius (px)
    subtitleDropShadowBlur: 6,

    // Subtitle border width (px, used when subtitleDropShadow is 'border')
    subtitleBorderWidth: 3,

    // Custom subtitle font (empty = system default)
    subtitleFont: '',

    // Custom ASS subtitle font (empty = system default)
    // Separate setting for Anime/ASS content
    subtitleFontAss: '',

    // Override container fonts with the chosen ASS font (or system fallback)
    subtitleOverrideAssFonts: false,

    // Global font scale multiplier for ASS subtitles
    subtitleFontScale: 1.0,

    // Outline thickness for ASS (baseline is 1.0)
    subtitleOutlineThickness: 1.0,

    // Shadow thickness for ASS (baseline is 1.0)
    subtitleShadowThickness: 1.0,

    // Vertical spacing offset for ASS (baseline is 0px)
    subtitleLineHeight: 0,

    // Letter spacing for ASS (baseline is 0.0)
    subtitleLetterSpacing: 0,

    // Vertical position offset for ASS (baseline is 0px)
    subtitleBottomOffset: 0,

    // Enable user-defined outline and shadow thickness overrides for ASS
    subtitleOverrideAssOutlineShadow: false,

    // Force text-only rendering for ASS/SSA (disables libjass)
    disableAssStyling: false,

    // Subtitle text color for SDR content
    subtitleTextColor: '#ffffff',

    /* -------------------------------------------------------------------------
       HDR SUBTITLE TEXT COLOR
       -------------------------------------------------------------------------
       Separate color configuration dedicated for HDR/Dolby Vision playback.
       Allows customizing subtitle text chromaticity independently under high-contrast
       high peak-luminance dynamic ranges.
       ------------------------------------------------------------------------- */
    subtitleTextColorHdr: '#ffffff',

    // Subtitle text opacity (0-100)
    // Used specifically when rendering subtitles over SDR content
    subtitleTextOpacity: 100,

    /* -------------------------------------------------------------------------
       HDR SUBTITLE TEXT OPACITY
       -------------------------------------------------------------------------
       Separate transparency setting (0-100) dedicated for HDR playback.
       This enables dialing down the blinding intensity of subtitles when the TV
       switches into high-brightness HDR/Dolby Vision video modes, without
       affecting the standard readability of subtitles in SDR content.
       ------------------------------------------------------------------------- */
    subtitleTextOpacityHdr: 100,

    // Subtitle background color
    subtitleTextBackground: 'transparent',

    // Subtitle background opacity (0-100)
    subtitleBackgroundOpacity: 100,

    // Vertical Position (-1 = top, -2 = bottom standard, etc. See SubtitleStyles.js)
    subtitleVerticalPosition: '-2',

    // Custom Vertical Position (0-100% from bottom, used when subtitleVerticalPosition is 'custom')
    subtitleVerticalPositionCustom: 10,

    // PGS Subtitle Playback Mode ('client', 'burn', 'disable')
    // 'client' = Custom Web Worker rendering on the TV (Default)
    // 'burn' = Force server to transcode video and burn into frames
    // 'disable' = Completely hide/ignore PGS tracks
    pgsPlaybackMode: 'client',

    // =========================================================================
    // SECONDARY SUBTITLE SETTINGS
    // These override only position and size — all other styles (color, shadow, font)
    // are inherited from the primary subtitle settings above.
    // =========================================================================

    // Secondary subtitle text size (independent from primary)
    secondarySubtitleSize: 'medium',

    // Secondary subtitle vertical position (defaults to 'custom' for absolute slider)
    secondarySubtitleVerticalPosition: 'custom',

    // Secondary subtitle absolute position (% from top)
    secondarySubtitleVerticalPositionCustom: 10,

    // Burn-in subtitles mode ('', 'allcomplex', 'all')
    subtitleBurnIn: '',

    // =========================================================================
    // DEVICE PROFILE / COMPATIBILITY SETTINGS
    // =========================================================================

    // Enable HEVC/H.265 codec for direct play (safe to leave on for all Tizen 4+)
    enableHEVC: 'auto',

    // Enable AV1 codec (auto-gated by Tizen version ≥ 5.5 in DeviceProfile)
    enableAV1: 'auto',

    // Enable VP9 codec (auto-gated by Tizen version / panel resolution)
    enableVP9: 'auto',

    // Enable HDR10/HLG pass-through
    enableHDR: 'auto',

    // Player backend ('auto', 'avplay', 'webos', 'html5')
    playerBackend: 'auto',

    /*
     * Interlaced Content Backend Fallback
     * ------------------------------------
     * When enabled and the active backend is AVPlay (Tizen native), the player
     * will automatically detect interlaced video streams (e.g. 1080i DVB broadcasts)
     * and transparently restart playback using the HTML5/Chromium backend instead.
     *
     * Why: Samsung's AVPlay HLS parser cannot handle interlaced H264 inside HLS TS
     * segments (throws PLAYER_ERROR_NOT_SUPPORTED_FORMAT). The HTML5 backend
     * (Chromium's software decoder) handles interlaced H264 natively and perfectly.
     *
     * Trade-off: Software decoding uses more CPU on the TV SoC vs AVPlay hardware
     * acceleration, but for standard 1080i broadcast content this is well within range.
     *
     * Default: true — best experience out of the box for Live TV users.
     */
    interlacedBackendFallback: true,

    // Enable Dolby Vision pass-through (auto-detected via avinfo API)
    enableDolbyVision: 'auto',

    // Enable DTS and TrueHD — see AUDIO SETTINGS above (enableDts, enableTrueHd)

    // Maximum resolution ('auto', '720p', '1080p', '2160p', '4320p')
    // 'auto' uses hardware detection via webapis
    maxResolution: 'auto',

    // Force all content to transcode (emergency/debug fallback)
    forceTranscode: false,

    // Force all content to direct play (override for testing native decoding)
    forceDirectPlay: false,

    // -------------------------------------------------------------------------
    // fMP4 HLS CONTAINER PREFERENCES
    // -------------------------------------------------------------------------
    // When enabled, the device profile will advertise an fMP4 (ISOBMFF) HLS
    // transcoding profile in addition to (or instead of) the classic MPEG-TS
    // one. fMP4 unlocks HEVC and AV1 copy-stream remuxing over HLS, which
    // MPEG-TS cannot carry reliably on many TV platforms.
    //
    //   enableFmp4HlsContainer — Master switch. When false the fMP4 HLS profile
    //     is never advertised, regardless of the hardware version gate.
    //     Default: false — tests showed fMP4 does NOT activate Dolby Vision on
    //     WebOS; only MPEG-TS reliably triggers the DV pipeline. fMP4 is
    //     therefore opt-in rather than opt-out.
    //
    //   forceFmp4HlsContainer — When true, completely bypasses the hardware
    //     version gate (webosVersion >= 6) and promotes the fMP4 profile to be
    //     the PRIMARY HLS transcode. Only use this if you have confirmed your
    //     TV handles fMP4 HLS correctly and you don't need DV passthrough.
    //     Ignored when enableFmp4HlsContainer is false.
    //     Default: false.
    enableFmp4HlsContainer: false,
    forceFmp4HlsContainer: false,

    // =========================================================================
    // BUFFER SETTINGS
    // =========================================================================

    // Tizen
    tizenInitialBuffer: 6,
    tizenResumeBuffer: 4,
    tizenSegmentLength: 6,

    // WebOS
    webosStallRecovery: 8,
    webosBufferGate: 10,
    webosSegmentLength: 6,

    // HTML5
    html5MaxBufferLength: 60,
    html5MaxMaxBufferLength: 120,
    html5SegmentLength: 2,

    // =========================================================================
    // PLAYBACK SETTINGS
    // =========================================================================

    // Trailer playback mode ('internal_proxy', 'internal_iframe', 'external')
    trailerPlaybackMode: 'internal_proxy',

    /*
     * Await Tracks Before Playback
     * -------------------------------------------------------------------------
     * When enabled, the player page will hold the loading screen and defer
     * initiating hardware playback until all audio and subtitle track mapping
     * has fully completed. This ensures that the first rendered frame already
     * has the correct subtitle cues and audio channel mapped.
     *
     * Trade-off: Deferring playback adds a brief startup delay (especially
     * for remote external subtitles that need to be fetched/parsed over HTTP),
     * but prevents audio/subtitle flashing and out-of-sync presentation.
     *
     * Default: false (start playback instantly once video is canplay/ready).
     */
    awaitTracksBeforePlayback: false,

    // Auto-chain mode: when both local AND remote trailers exist and this is
    // true, the TrailerDialog selection screen is skipped entirely. Instead,
    // the local trailer plays immediately via the native player. When it ends
    // (or the user presses Next), the remote trailer player opens automatically.
    // Pressing Back at any point returns to the Details page cleanly.
    trailerAutoChain: false,

    // Enable background Node.js service (for Discovery and Proxy)
    enableBackgroundService: true,

    // Skip forward duration in milliseconds
    skipForwardLength: 10000,

    // Skip back duration in milliseconds
    skipBackLength: 5000,

    // Auto-play next episode when current finishes
    enableNextEpisodeAutoPlay: true,

    /**
     * =========================================================================
     * UP NEXT DIALOG TOGGLE
     * =========================================================================
     * Controls whether the interactive countdown card (Up Next dialog) is shown
     * near the end of an episode playthrough. When enabled, it allows the user
     * to manually advance early or hide the prompt.
     * =========================================================================
     */
    enableNextUpDialog: true,

    // Show trickplay (sprite-sheet) thumbnail previews when scrubbing through videos.
    // Disable to skip all trickplay calculations and image fetches entirely.
    enableTrickplay: true,

    // Enable cinema mode (dim lights during playback)
    enableCinemaMode: false,

    // Time format for clock and playback ('12h', '24h')
    timeFormat: '12h',

    // Instant seek when OSD is hidden using directional arrows
    seekWithArrows: true,

    // Enable mouse/magic cursor support in the OSD (hover and click)
    // Disabled by default on Tizen due to cursor interaction bugs
    enableMagicCursor: !platformInfo.isTizen,

    // Show timestamp and trickplay images on hover with mouse
    enableHoverTrickplay: false,

    /*
     * OSD Focus Restore Mode
     * Controls where the remote cursor lands when the OSD is revealed
     * after having been auto-hidden.
     *
     *   'remember' — Stay on the last button the user was on (legacy behaviour).
     *   'timeout'  — If the OSD was hidden for ≥ 10 seconds, jump to Play/Pause;
     *                otherwise stay on the last button.
     *   'always'   — Always land on Play/Pause whenever the OSD re-appears,
     *                no matter how short the hide was.
     */
    osdFocusRestoreMode: 'always',

    // Keep focus on subtitle offset menu (prevent auto-hide)
    keepFocusOnSubtitleOffset: true,

    // Time display mode ('total', 'remaining')
    osdTimeDisplayMode: 'total',

    // =========================================================================
    // SEGMENT SKIP SETTINGS
    // Controls what happens when playback enters a detected media segment.
    // Requires the intro-skipper server plugin to function.
    //
    // Possible values (mirrors jellyfin-web's MediaSegmentAction enum):
    //   'None'       — Segment is ignored entirely. No button, no auto-skip.
    //   'AskToSkip'  — Show a skip button on-screen; user presses OK to skip.
    //   'Skip'       — Automatically seek past the segment end without any UI.
    // =========================================================================

    // Intro segment action (e.g. opening credits / title card)
    skipActionIntro: 'AskToSkip',

    // Credits/outro segment action (e.g. end-of-episode roll)
    skipActionOutro: 'AskToSkip',

    // Recap segment action (e.g. "previously on…")
    skipActionRecap: 'None',

    // Preview/next-episode teaser segment action
    skipActionPreview: 'None',

    // Show show/movie logo in OSD instead of text title
    osdShowLogo: false,

    // Hide production year from the OSD title
    osdHideYear: false,

    // Hide the show name (or logo) for episodes
    osdHideShowName: false,

    // Size of the show/movie logo in OSD ('small', 'medium', 'large')
    osdLogoSize: 'medium',

    // Background opacity of the track menus (0-100)
    osdTrackMenuBgOpacity: 85
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
        // Legacy migration for compatibility settings converted from boolean to auto/enable/disable string
        if (
            key === 'enableHEVC' ||
            key === 'enableAV1' ||
            key === 'enableVP9' ||
            key === 'enableHDR' ||
            key === 'enableDolbyVision' ||
            key === 'enableDts' ||
            key === 'enableTrueHd'
        ) {
            if (stored === 'true') return 'enable';
            if (stored === 'false') return 'disable';
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

        // Notify subscribers that a setting has changed
        eventBus.emit(`pref:${key}`, value);
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
