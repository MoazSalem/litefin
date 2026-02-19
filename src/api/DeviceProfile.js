/**
 * ============================================================================
 * Litefin Tizen — Device Profile (Unified)
 * ============================================================================
 * Single source of truth for all device capability detection and Jellyfin
 * profile generation. Consolidates hardware detection, codec support, and
 * transcoding configuration into one module.
 *
 * Uses tizen.systeminfo for model name, Tizen version, and device ID.
 * Panel resolution determined by model name lookup (known 8K/FHD/720p models).
 * Codec support gated by Tizen version. HDR defaults based on version + resolution.
 *
 * @module api/DeviceProfile
 * ============================================================================
 */

import { logger } from '../utils/Logger.js';
import { storage } from '../utils/StorageService.js';
import { PlayerSettings } from '../utils/PlayerSettings.js';

const log = logger.create('DeviceProfile');

// ============================================================================
// Tizen Version Detection
// ============================================================================

// --- Cached hardware queries (only run once) ---
let _cachedModelName = null;

/**
 * Get the TV model name via tizen.systeminfo.
 * Only caches a successful (non-empty) result so we retry if systeminfo wasn't ready.
 * @returns {string}
 */
function _getModelName() {
    if (_cachedModelName) return _cachedModelName;

    if (typeof tizen !== 'undefined' && tizen.systeminfo) {
        try {
            _cachedModelName = tizen.systeminfo.getCapability('http://tizen.org/system/model_name') || '';
        } catch (e) {
            log.warn('Could not get model name from systeminfo:', e.message);
        }
    }
    return _cachedModelName || '';
}

/**
 * Detect the Tizen platform version from tizen.systeminfo.
 * @returns {number} Tizen version (e.g. 5.5, 6, 8). Defaults to 4 if unavailable.
 */
export function detectTizenVersion() {
    if (typeof tizen !== 'undefined' && tizen.systeminfo) {
        try {
            const platformVersion = tizen.systeminfo.getCapability('http://tizen.org/feature/platform.version');
            if (platformVersion) {
                const ver = parseFloat(platformVersion);
                if (!isNaN(ver) && ver >= 2) {
                    log.info(`Tizen version: ${ver}`);
                    return ver;
                }
            }
        } catch (e) {
            log.debug('systeminfo API not available');
        }
    }

    // Safe default — Tizen 4 (2018, earliest commonly supported)
    log.warn('Could not detect Tizen version, defaulting to 4');
    return 4;
}

// ============================================================================
// Panel & HDR Capability Detection
// ============================================================================

/** Cached capabilities object — built once, reused for lifetime of app */
let _cachedCapabilities = null;

/**
 * Detect hardware capabilities using tizen.systeminfo and model-based resolution.
 * Results are cached after first successful call.
 *
 * @returns {Object} Capabilities object with resolution, HDR, codec flags
 */
export function getDeviceCapabilities() {
    if (_cachedCapabilities) return _cachedCapabilities;

    const tizenVersion = detectTizenVersion();

    // --- Model identity via systeminfo (needed for resolution lookup) ---
    const modelName = _getModelName() || 'Samsung TV';

    // --- Panel Resolution ---
    // Determined by model name — screen.width and systeminfo both return CSS
    // viewport (1920) not physical panel. Known models listed explicitly.
    const MODEL_8K = ['QN990', 'QN900', 'QN800', 'QN700', 'Q950', 'Q900', 'Q800'];
    const MODEL_FHD = ['T5300', 'N5200', 'Q50A', '32LS03', 'H5000', 'F6000', 'J6200', 'J5200', 'M5500'];
    const MODEL_HD = ['N5300', 'H5000F', 'N4300', 'T4300', 'N4000', 'T4000', 'J4000'];

    // Check if model name contains any of the known substrings
    const is8K = MODEL_8K.some((m) => modelName.includes(m));
    const isFHD = MODEL_FHD.some((m) => modelName.includes(m));
    const isHD = MODEL_HD.some((m) => modelName.includes(m));

    // Default: 4K (the vast majority of Samsung Tizen TVs)
    let uhd = true;
    let uhd8K = false;
    if (is8K) {
        uhd8K = true;
    } else if (isFHD || isHD) {
        uhd = false;
    }
    log.info(`Panel resolution for model "${modelName}": ${uhd8K ? '8K' : uhd ? '4K' : isFHD ? 'FHD' : 'HD'}`);

    // --- HDR Capabilities ---
    // HDR10 on most UHD panels from Tizen 4+ (2018+)
    // Dolby Vision: rare even on premium models — default off, user can enable
    const hdr10 = tizenVersion >= 4 && uhd;
    const dolbyVision = false;

    let deviceId = '';

    // Get device ID from systeminfo
    if (typeof tizen !== 'undefined' && tizen.systeminfo) {
        try {
            deviceId = tizen.systeminfo.getCapability('http://tizen.org/system/tizenid') || '';
        } catch (e) {
            log.warn('Could not get device ID from systeminfo:', e.message);
        }
    }

    // Fallback: generate and persist a stable identifier
    if (!deviceId) {
        deviceId = storage.getItem('litefin_device_id');
        if (!deviceId) {
            deviceId = 'litefin_tizen_' + Date.now().toString(36) + Math.random().toString(36).substring(2);
            storage.setItem('litefin_device_id', deviceId);
        }
    }

    // --- Apply manual overrides from PlayerSettings ---
    const manualRes = PlayerSettings.get('maxResolution');
    if (manualRes && manualRes !== 'auto') {
        switch (manualRes) {
            case '720p':
                uhd = false;
                uhd8K = false;
                break;
            case '1080p':
                uhd = false;
                uhd8K = false;
                break;
            case '2160p':
                uhd = true;
                uhd8K = false;
                break;
            case '4320p':
                uhd = true;
                uhd8K = true;
                break;
        }
    }

    // --- Build and cache capabilities ---
    _cachedCapabilities = {
        // Identity
        modelName,
        deviceId,

        // Platform
        tizenVersion,

        // Resolution (derived from screen or manual override)
        screenWidth: uhd8K ? 7680 : uhd ? 3840 : 1920,
        screenHeight: uhd8K ? 4320 : uhd ? 2160 : 1080,
        uhd,
        uhd8K,

        // HDR (version-based defaults — user can toggle in Settings)
        hdr10,
        hdr10Plus: hdr10 && tizenVersion >= 5, // HDR10+ on 2019+ premium models
        hlg: hdr10 && tizenVersion >= 4, // HLG on 2018+ HDR-capable models
        dolbyVision,

        // Video codec support (gated by Tizen version)
        hevc: true, // All Tizen 4+ (2018+)
        av1: tizenVersion >= 5.5, // AV1 from Tizen 5.5 (2020+)
        vp9: tizenVersion >= 6 || (tizenVersion >= 4 && uhd), // VP9 UHD from Tizen 4, all from 6
        vp8: true, // VP8 supported on all

        // Audio codec support (per Samsung spec tables)
        // Samsung explicitly says DTS is NOT supported on any TV (2018–2025)
        // TrueHD is not documented in Samsung specifications
        ac3: true,
        eac3: true,
        dts: false,
        truehd: false,

        // Max audio channels — Samsung docs: "DD+: 5.1 channel supported"
        // 8K models list DD/DD+ (5.1, 7.1)
        maxAudioChannels: uhd8K ? 8 : 6
    };

    log.info('Device capabilities detected:', JSON.stringify(_cachedCapabilities, null, 2));
    return _cachedCapabilities;
}

/**
 * Clear the cached capabilities (useful for testing or settings changes).
 */
export function clearCapabilitiesCache() {
    _cachedCapabilities = null;
}

// ============================================================================
// Jellyfin Device Profile Builder
// ============================================================================

/**
 * Build the complete Jellyfin DeviceProfile object.
 *
 * This tells the server exactly what the device can play natively (direct play)
 * and what it needs transcoded. Every field is derived from the detected
 * capabilities and current PlayerSettings toggles.
 *
 * @param {Object} [options={}] - Options for profile generation
 * @param {number} [options.manualBitrate] - Optional overrides for max bitrate
 * @param {string} [options.playbackMode='auto'] - 'auto', 'directPlay', 'transcode', 'remux'
 * @returns {Object} A Jellyfin-compatible DeviceProfile
 */
export function buildJellyfinProfile(options = {}) {
    // Backwards compatibility for when it was just (manualBitrate)
    let manualBitrateOverride = null;
    let playbackMode = 'auto';

    if (typeof options === 'number') {
        manualBitrateOverride = options;
    } else {
        manualBitrateOverride = options.manualBitrate;
        playbackMode = options.playbackMode || 'auto';
    }

    const isHtml5 = options.backend === 'html5';
    if (isHtml5) {
        log.info('Building profile for HTML5 backend (Tizen Browser)');
    }

    const caps = getDeviceCapabilities();

    // --- Read user toggle overrides from PlayerSettings ---
    const enableHEVC = PlayerSettings.get('enableHEVC') && caps.hevc;
    const enableAV1 = PlayerSettings.get('enableAV1') && caps.av1;
    const enableVP9 = PlayerSettings.get('enableVP9') && caps.vp9;
    const enableHDR = PlayerSettings.get('enableHDR') && caps.hdr10;
    const enableDolbyVision = PlayerSettings.get('enableDolbyVision') && caps.dolbyVision;
    const enableDts = PlayerSettings.get('enableDts');
    const enableTrueHd = PlayerSettings.get('enableTrueHd');
    const forceTranscodeSetting = PlayerSettings.get('forceTranscode');

    // If force transcode is on in settings, OR mode is transcode/remux
    // But we handle specific logic below.
    if (forceTranscodeSetting && playbackMode === 'auto') {
        log.warn('Force transcode enabled via Settings — returning minimal profile');
        return _buildMinimalProfile(caps);
    }

    // ====================================================================
    // Bitrate Calculation
    // ====================================================================

    // Samsung spec table max bitrates:
    //   8K HEVC: ~80–100 Mbps, UHD: ~60–80 Mbps, FHD: ~40 Mbps

    let maxBitrate;

    if (playbackMode === 'directPlay' || playbackMode === 'transcode' || playbackMode === 'remux') {
        // Force high bitrate to avoid unnecessary transcoding due to bitrate limits
        maxBitrate = 120000000;
    } else {
        // Auto mode
        // Priority:
        // 1. manualOverride (passed as argument)
        // 2. PlayerSettings 'maxBitrateInternet'
        // 3. Hardware capability default
        maxBitrate =
            manualBitrateOverride ||
            PlayerSettings.get('maxBitrateInternet') ||
            (caps.uhd8K ? 120000000 : caps.uhd ? 120000000 : 40000000);
    }

    const maxAudioChannels = String(caps.maxAudioChannels);

    // ====================================================================
    // Audio Codec List
    // ====================================================================

    // Per Samsung video spec tables: AAC, MP3, Vorbis, AC3, EAC3, Opus,
    // LPCM, ADPCM, WMA, G.711, FLAC (music table), AC4 (2022+)
    const audioCodecs = ['aac', 'mp3', 'flac', 'opus', 'vorbis', 'pcm', 'wav', 'pcm_s16le', 'pcm_s24le', 'aac_latm'];
    if (caps.ac3) audioCodecs.push('ac3');
    if (caps.eac3) audioCodecs.push('eac3');
    // AC4 — newer Tizen models (6.5+ / 2022+)
    if (caps.tizenVersion >= 6.5) audioCodecs.push('ac4');
    // DTS — Samsung explicitly says not supported, but user may enable for passthrough
    if (enableDts) audioCodecs.push('dts', 'dca');
    // TrueHD — not in Samsung specs, but user may enable for passthrough
    if (enableTrueHd) audioCodecs.push('truehd');

    const audioCodecString = audioCodecs.join(',');

    // ====================================================================
    // Video Codec Lists (per container type)
    // ====================================================================

    // General containers (MP4, MKV, TS, etc.) — broadest codec support
    const generalVideoCodecs = ['h264'];
    if (enableHEVC) generalVideoCodecs.push('hevc');
    // Legacy codecs — many DVDs, Blu-rays, and TV recordings use these
    generalVideoCodecs.push('mpeg2video', 'vc1');
    if (enableVP9) generalVideoCodecs.push('vp9');
    if (caps.vp8) generalVideoCodecs.push('vp8');
    if (enableAV1) generalVideoCodecs.push('av1');

    // MKV gets a few extra legacy codecs
    const mkvVideoCodecs = [...generalVideoCodecs, 'msmpeg4v2'];

    // WebM container — only VP8/VP9/AV1
    const webmVideoCodecs = [];
    if (caps.vp8) webmVideoCodecs.push('vp8');
    if (enableVP9) webmVideoCodecs.push('vp9');
    if (enableAV1) webmVideoCodecs.push('av1');

    // TS container — subset (no vc1 quirks, more reliable)
    const tsVideoCodecs = ['h264'];
    if (enableHEVC) tsVideoCodecs.push('hevc');
    tsVideoCodecs.push('vc1', 'mpeg2video');
    if (enableAV1) tsVideoCodecs.push('av1');

    // M2TS container — typically Blu-ray, limited codec set
    const m2tsVideoCodecs = ['h264', 'vc1', 'mpeg2video'];

    // MOV container — primarily H.264 on Samsung

    // HLS — codecs suitable for adaptive streaming
    const hlsVideoCodecs = ['h264'];
    if (enableHEVC) hlsVideoCodecs.push('hevc');
    if (enableVP9) hlsVideoCodecs.push('vp9');
    if (enableAV1) hlsVideoCodecs.push('av1');

    // ====================================================================
    // DirectPlay Profiles
    // ====================================================================

    let directPlayProfiles = [];

    // Only add DirectPlay profiles if NOT in explicit Transcode or Remux mode
    // Actually, Remux (Direct Stream) requires DirectPlay profiles to be empty primarily,
    // but strict Remux usually means "Transcode container, copy codec".
    // If we want to force remux/direct stream, we should report no direct play support for the container.
    // If we want to force transcode, we report no direct play support at all.

    if (playbackMode !== 'transcode' && playbackMode !== 'remux') {
        // MP4 / M4V / MOV (Supported by both AVPlay and Browser)
        directPlayProfiles.push({
            Container: 'mp4,m4v,mov',
            Type: 'Video',
            VideoCodec: generalVideoCodecs.join(','),
            AudioCodec: audioCodecString
        });

        // MKV (Supported by both AVPlay and Browser)
        directPlayProfiles.push({
            Container: 'mkv',
            Type: 'Video',
            VideoCodec: mkvVideoCodecs.join(','),
            AudioCodec: audioCodecString
        });

        // WebM (Supported by both AVPlay and Browser)
        if (webmVideoCodecs.length > 0) {
            directPlayProfiles.push({
                Container: 'webm',
                Type: 'Video',
                VideoCodec: webmVideoCodecs.join(','),
                AudioCodec: 'vorbis,opus'
            });
        }

        // --- AVPlayer-Specific Containers (Excluded from HTML5) ---
        if (!isHtml5) {
            // TS / MPEGTS
            directPlayProfiles.push({
                Container: 'ts,mpegts',
                Type: 'Video',
                VideoCodec: tsVideoCodecs.join(','),
                AudioCodec: audioCodecString
            });

            // M2TS
            directPlayProfiles.push({
                Container: 'm2ts',
                Type: 'Video',
                VideoCodec: m2tsVideoCodecs.join(','),
                AudioCodec: audioCodecString
            });

            // AVI
            directPlayProfiles.push({
                Container: 'avi',
                Type: 'Video',
                VideoCodec: ['h264', enableHEVC ? 'hevc' : '', 'mpeg2video'].filter(Boolean).join(','),
                AudioCodec: audioCodecString
            });

            // WMV / ASF
            directPlayProfiles.push({
                Container: 'wmv,asf',
                Type: 'Video',
                AudioCodec: audioCodecString
            });

            // Legacy containers
            directPlayProfiles.push({
                Container: 'mpg,mpeg,flv,3gp,vob,vro',
                Type: 'Video',
                AudioCodec: audioCodecString
            });
        }

        // Audio-only (Supported by both)
        directPlayProfiles.push({
            Container: 'mp3,flac,aac,m4a,m4b,ogg,opus,wav,wma,webma',
            Type: 'Audio'
        });
    }

    // ====================================================================
    // Transcoding Profiles (multiple fallback paths)
    // ====================================================================

    // Transcoding audio codec list (server-side encoding targets)
    let transAudioCodecs = caps.ac3 ? 'aac,ac3,eac3' : 'aac';
    let transVideoCodecs = enableHEVC ? 'h264,hevc' : 'h264';

    // If forcing Remux (Direct Stream), we need to tell the server that we support
    // ALL our native codecs in the Transcoding profile, so it knows it can "transcode" (copy)
    // them into the container.
    if (playbackMode === 'remux') {
        transAudioCodecs = audioCodecString; // 'aac,mp3,flac...'

        // Assemble all supported video codecs unique list
        const allVideo = new Set([...generalVideoCodecs, ...mkvVideoCodecs, ...tsVideoCodecs]);
        transVideoCodecs = Array.from(allVideo).join(',');

        log.info('Remux mode: Expanded transcoding codecs to:', transVideoCodecs);
    }

    // Broader set for fMP4/MKV transcoding
    const broadTransVideo = [transVideoCodecs, enableAV1 ? 'av1' : '', enableVP9 ? 'vp9' : '']
        .filter(Boolean)
        .join(',');

    // If forcing Remux, we MUST NOT break on non-key frames,
    // because that requires re-encoding (creating new keyframes).
    // Direct Stream (Remux) can only split at existing keyframes.
    const breakOnNonKeyFrames = playbackMode === 'remux' ? false : true;

    const transcodingProfiles = [
        // Primary: HLS in TS container (most compatible streaming fallback)
        {
            Container: 'ts',
            Type: 'Video',
            AudioCodec: transAudioCodecs,
            VideoCodec: transVideoCodecs,
            Context: 'Streaming',
            Protocol: 'hls',
            MaxAudioChannels: maxAudioChannels,
            MinSegments: '1',
            SegmentLength: '3',
            BreakOnNonKeyFrames: breakOnNonKeyFrames
        },
        // Secondary: HLS in fMP4 container (newer, better codec support)
        {
            Container: 'mp4',
            Type: 'Video',
            AudioCodec: transAudioCodecs + ',opus',
            VideoCodec: broadTransVideo,
            Context: 'Streaming',
            Protocol: 'hls',
            MaxAudioChannels: maxAudioChannels,
            MinSegments: '1',
            SegmentLength: '3',
            BreakOnNonKeyFrames: false
        },
        // Audio transcoding: AAC via HLS
        {
            Container: 'aac',
            Type: 'Audio',
            AudioCodec: 'aac',
            Context: 'Streaming',
            Protocol: 'hls',
            MaxAudioChannels: maxAudioChannels,
            MinSegments: '1'
        },
        // Audio transcoding: MP3 via HTTP
        {
            Container: 'mp3',
            Type: 'Audio',
            AudioCodec: 'mp3',
            Context: 'Streaming',
            Protocol: 'http'
        },
        // Audio transcoding: Opus via HTTP
        {
            Container: 'opus',
            Type: 'Audio',
            AudioCodec: 'opus',
            Context: 'Streaming',
            Protocol: 'http'
        }
    ];

    // Static Remuxing profiles
    // If mode is 'remux', we need to make sure we support static remuxing or similar
    // Actually, usually Remux happens via HLS/Stream Copy.
    // We add static profiles for compatibility.

    transcodingProfiles.push(
        // Static remux: MKV container (broad codec support, lossless remux)
        {
            Container: 'mkv',
            Type: 'Video',
            AudioCodec: audioCodecString,
            VideoCodec: mkvVideoCodecs.join(','),
            Context: 'Static',
            CopyTimestamps: true,
            MaxAudioChannels: maxAudioChannels
        },
        // Static fallback: MP4
        {
            Container: 'mp4',
            Type: 'Video',
            AudioCodec: 'aac,ac3',
            VideoCodec: 'h264',
            Context: 'Static'
        }
    );

    // ====================================================================
    // Codec Profiles (level/profile constraints)
    // ====================================================================

    // H.264 Level: UHD → 5.1, FHD on Tizen 5.5+ → 4.2, older FHD → 4.1
    // For HTML5, we use 6.2 (120) for 4K/8K compatibility in browser engine
    const h264Level = isHtml5 ? '120' : caps.uhd ? '51' : caps.tizenVersion >= 5.5 ? '42' : '41';

    // HEVC Level: 8K → 6.1 (183), UHD → 5.1 (153), FHD → 4.1 (123)
    // For HTML5, we use 6.1 (183) for 4K/8K compatibility
    const hevcLevel = isHtml5 ? '183' : caps.uhd8K ? '183' : caps.uhd ? '153' : '123';

    // HEVC bit depth — 10-bit if HDR is enabled, 8-bit otherwise
    // HEVC bit depth — 10-bit if HDR is enabled, 8-bit otherwise
    const hevcBitDepth = enableHDR || enableDolbyVision ? '10' : '8';

    let codecProfiles = [];

    // If forcing Remux, we disable restrictive codec profiles (levels, bit depth, refs)
    // to prevent the server from deciding "RefFrames too high -> Transcode".
    // We assume the user knows what they are doing.
    if (playbackMode !== 'remux') {
        codecProfiles = [
            // --- H.264 constraints ---
            {
                Type: 'Video',
                Codec: 'h264',
                Conditions: [
                    {
                        Condition: 'NotEquals',
                        Property: 'IsAnamorphic',
                        Value: 'true',
                        IsRequired: false
                    },
                    {
                        Condition: 'EqualsAny',
                        Property: 'VideoProfile',
                        Value: 'high|main|baseline|constrained baseline|high 10',
                        IsRequired: false
                    },
                    {
                        Condition: 'LessThanEqual',
                        Property: 'VideoLevel',
                        Value: h264Level,
                        IsRequired: false
                    },
                    {
                        Condition: 'LessThanEqual',
                        Property: 'VideoBitDepth',
                        Value: '8',
                        IsRequired: false
                    },
                    {
                        Condition: 'LessThanEqual',
                        Property: 'RefFrames',
                        Value: '16',
                        IsRequired: false
                    }
                ]
            },
            // --- Audio channel limit (global) ---
            {
                Type: 'Audio',
                Conditions: [
                    {
                        Condition: 'LessThanEqual',
                        Property: 'AudioChannels',
                        Value: maxAudioChannels,
                        IsRequired: false
                    }
                ]
            }
        ];

        // HEVC constraints (only if enabled)
        if (enableHEVC) {
            codecProfiles.push({
                Type: 'Video',
                Codec: 'hevc',
                Conditions: [
                    {
                        Condition: 'EqualsAny',
                        Property: 'VideoProfile',
                        Value: 'main|main 10',
                        IsRequired: false
                    },
                    {
                        Condition: 'LessThanEqual',
                        Property: 'VideoLevel',
                        Value: hevcLevel,
                        IsRequired: false
                    },
                    {
                        Condition: 'LessThanEqual',
                        Property: 'VideoBitDepth',
                        Value: hevcBitDepth,
                        IsRequired: false
                    }
                ]
            });
        }

        // VP9 constraints (profile 0 for SDR, profile 2 for HDR 10-bit)
        if (enableVP9) {
            codecProfiles.push({
                Type: 'Video',
                Codec: 'vp9',
                Conditions: [
                    {
                        Condition: 'EqualsAny',
                        Property: 'VideoProfile',
                        Value: 'profile 0|profile 2',
                        IsRequired: false
                    }
                ]
            });
        }

        // AV1 constraints
        if (enableAV1) {
            codecProfiles.push({
                Type: 'Video',
                Codec: 'av1',
                Conditions: [
                    {
                        Condition: 'LessThanEqual',
                        Property: 'VideoLevel',
                        Value: '15', // AV1 Main Level 5.1
                        IsRequired: false
                    },
                    {
                        Condition: 'LessThanEqual',
                        Property: 'VideoBitDepth',
                        Value: enableHDR ? '10' : '8',
                        IsRequired: false
                    }
                ]
            });
        }
    } else {
        log.info('Remux mode: Clearing strict CodecProfiles to favor stream copy.');
        // We still usually want to enforce AudioChannels though,
        // as the TV definitely can't output more than it supports via ARC/internal speakers?
        // Actually, if we are remuxing, we might be transcoding audio anyway if needed.
        // Let's keep Audio limit just in case.
        codecProfiles = [
            {
                Type: 'Audio',
                Conditions: [
                    {
                        Condition: 'LessThanEqual',
                        Property: 'AudioChannels',
                        Value: maxAudioChannels,
                        IsRequired: false
                    }
                ]
            }
        ];
    }

    // ====================================================================
    // Subtitle Profiles
    // ====================================================================

    const subtitleProfiles = [
        // External method — server extracts text tracks and delivers via API
        // This is the lightest path (no transcoding required)
        { Format: 'srt', Method: 'External' },
        { Format: 'subrip', Method: 'External' },
        { Format: 'vtt', Method: 'External' },
        { Format: 'ass', Method: 'External' },
        { Format: 'ssa', Method: 'External' },
        { Format: 'smi', Method: 'External' },
        { Format: 'ttml', Method: 'External' },
        { Format: 'sub', Method: 'External' },

        // HLS embedded VTT
        { Format: 'vtt', Method: 'Hls' }
    ];

    // Only add Embed profiles if NOT in Transcode/Remux mode?
    // Actually, Remuxing might want to Embed.
    // If we are forcing transcode, we generally want to burn in subs if they are image based,
    // or external if text.

    // For simplicity, we keep these unless we are in strict transcode mode which might want to avoid direct play completely.
    // But direct play profiles are already empty in transcode mode.
    // So if the server transcodes, it uses TranscodingProfiles.

    subtitleProfiles.push(
        { Format: 'srt', Method: 'Embed' },
        { Format: 'subrip', Method: 'Embed' },
        { Format: 'vtt', Method: 'Embed' },
        { Format: 'pgs', Method: 'Embed' },
        { Format: 'pgssub', Method: 'Embed' },
        { Format: 'dvdsub', Method: 'Embed' },
        { Format: 'dvbsub', Method: 'Embed' }
    );

    // ====================================================================
    // Response Profiles (container MIME type overrides)
    // ====================================================================

    const responseProfiles = [
        {
            Type: 'Video',
            Container: 'm4v',
            MimeType: 'video/mp4'
        },
        {
            Type: 'Video',
            Container: 'mkv',
            MimeType: 'video/x-matroska'
        }
    ];

    // ====================================================================
    // Assemble Final Profile
    // ====================================================================

    const profile = {
        Name:
            (isHtml5 ? 'Litefin Web (HTML5)' : `Litefin Tizen ${caps.tizenVersion}`) +
            (playbackMode !== 'auto' ? ` (${playbackMode})` : ''),
        MaxStreamingBitrate: maxBitrate,
        MaxStaticBitrate: maxBitrate,
        MaxStaticMusicBitrate: 40000000,
        MusicStreamingTranscodingBitrate: isHtml5 ? 192000 : 384000,

        DirectPlayProfiles: directPlayProfiles,
        TranscodingProfiles: transcodingProfiles,
        CodecProfiles: codecProfiles,
        SubtitleProfiles: isHtml5
            ? [
                  { Format: 'vtt', Method: 'External' },
                  { Format: 'vtt', Method: 'Hls' }
              ]
            : subtitleProfiles,
        ResponseProfiles: isHtml5 ? [] : responseProfiles
    };

    log.info('Built Jellyfin profile:', profile.Name);

    return profile;
}

/**
 * Build a minimal profile that forces transcoding for everything.
 * Used when "Force Transcode" is enabled as an emergency fallback.
 * @private
 */
function _buildMinimalProfile(caps) {
    return {
        Name: 'Litefin Tizen (Forced Transcode)',
        MaxStreamingBitrate: PlayerSettings.get('maxBitrateInternet') || 40000000,
        MaxStaticBitrate: 40000000,
        MusicStreamingTranscodingBitrate: 384000,
        DirectPlayProfiles: [],
        TranscodingProfiles: [
            {
                Container: 'ts',
                Type: 'Video',
                AudioCodec: 'aac',
                VideoCodec: 'h264',
                Context: 'Streaming',
                Protocol: 'hls',
                MaxAudioChannels: String(caps.maxAudioChannels),
                MinSegments: '1',
                SegmentLength: '3',
                BreakOnNonKeyFrames: true
            },
            {
                Container: 'mp3',
                Type: 'Audio',
                AudioCodec: 'mp3',
                Context: 'Streaming',
                Protocol: 'http'
            }
        ],
        CodecProfiles: [],
        SubtitleProfiles: [
            { Format: 'vtt', Method: 'External' },
            { Format: 'srt', Method: 'External' },
            { Format: 'ssa', Method: 'External' },
            { Format: 'ass', Method: 'External' },
            { Format: 'smi', Method: 'External' },
            { Format: 'sami', Method: 'External' },
            { Format: 'sub', Method: 'External' },
            { Format: 'mov_text', Method: 'Embed' },
            { Format: 'tx3g', Method: 'Embed' },
            { Format: 'ttml', Method: 'External' }
        ],
        ResponseProfiles: []
    };
}

// ============================================================================
// Device Identity Helpers
// ============================================================================

/**
 * Get a unique device identifier.
 * Prefers Tizen DUID, falls back to a generated+stored ID.
 * @returns {string}
 */
export function getDeviceId() {
    // Try tizen.systeminfo for device ID
    if (typeof tizen !== 'undefined' && tizen.systeminfo) {
        try {
            const tizenId = tizen.systeminfo.getCapability('http://tizen.org/system/tizenid');
            if (tizenId) return tizenId;
        } catch (e) {
            // Fall through to localStorage approach
        }
    }

    // Generate and persist a stable identifier
    let deviceId = storage.getItem('litefin_device_id');
    if (!deviceId) {
        deviceId = 'litefin_tizen_' + Date.now().toString(36) + Math.random().toString(36).substring(2);
        storage.setItem('litefin_device_id', deviceId);
    }
    return deviceId;
}

/**
 * Get a human-readable device name.
 * @returns {string}
 */
export function getDeviceName() {
    const caps = getDeviceCapabilities();
    return caps.modelName || `Samsung TV Tizen ${caps.tizenVersion}`;
}

// ============================================================================
// Convenience / Backward Compatibility Exports
// ============================================================================

/**
 * Get profile with auto-detected capabilities (backward compat).
 * @returns {Object} Jellyfin DeviceProfile
 */
export function getAutoProfile() {
    return buildJellyfinProfile();
}

/**
 * Legacy alias — wraps buildJellyfinProfile for old callers.
 * @param {Object} [options] - Ignored (capabilities are auto-detected now)
 * @returns {Object} Jellyfin DeviceProfile
 */
export function getDeviceProfile(options = {}) {
    return buildJellyfinProfile();
}

export default {
    detectTizenVersion,
    getDeviceCapabilities,
    clearCapabilitiesCache,
    buildJellyfinProfile,
    getDeviceId,
    getDeviceName,
    getAutoProfile,
    getDeviceProfile
};
