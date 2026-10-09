/**
 * ============================================================================
 * Litefin — Android Device Profile (Media3 ExoPlayer)
 * ============================================================================
 * Generates Jellyfin DeviceProfile configurations tailored specifically for
 * Android and Android TV runtimes utilizing native Media3 ExoPlayer.
 *
 * Direct Play Capabilities:
 * - Containers: MKV, MP4, M4V, MOV, WebM, TS, MPEG-TS, M2TS, HLS.
 * - Video Codecs: HEVC (Main, Main 10, HDR10, HLG), H.264 (High/Main/Baseline),
 *   AV1 (Main Profile), VP9 (Profile 0, Profile 2), VP8, MPEG-2.
 * - Audio Codecs: AC-3, E-AC-3, Dolby TrueHD, DTS, DTS-HD MA, DTS:X, AAC,
 *   FLAC, Opus, MP3, Vorbis, PCM.
 * - Multichannel Audio: 8 channels (7.1 surround sound passthrough).
 *
 * @module api/profiles/AndroidProfile
 * ============================================================================
 */

import { logger } from '../../utils/Logger.js';
import { PlayerSettings } from '../../utils/PlayerSettings.js';
import { BaseProfile } from './BaseProfile.js';
import * as WebProfile from './WebProfile.js';

const log = logger.create('AndroidProfile');

let _cachedCapabilities = null;

/**
 * Detects actual hardware video decoding capabilities via the native
 * Android MediaCodecList interface exposed on window.LitefinAndroid.
 * Accurately handles chipsets (like Amlogic S905X on Android 9) that
 * lack hardware AV1 decoders to prevent black-screen playback errors.
 */
function detectHardwareVideoCodecs() {
    try {
        if (typeof window !== 'undefined' && window.LitefinAndroid?.getSupportedVideoCodecs) {
            const raw = window.LitefinAndroid.getSupportedVideoCodecs();
            if (raw) {
                const parsed = JSON.parse(raw);
                log.info('Detected hardware video codecs via Android MediaCodecList:', parsed);
                return parsed;
            }
        }
    } catch (e) {
        log.warn('Failed to parse hardware codecs from LitefinAndroid bridge:', e);
    }

    // Default safe baseline: TV boxes running Android 9 / S905X do NOT have AV1 hardware decoders
    return {
        h264: true,
        hevc: true,
        vp9: true,
        vp8: true,
        av1: false,
        mpeg2video: true
    };
}

/**
 * Detects the device model name cleanly from the native Android bridge or User Agent.
 * Strips internal player backend labels (e.g. Media3 ExoPlayer) so the genuine
 * device model is reported (e.g. "MIBOX4" or "Xiaomi MIBOX4").
 */
function detectDeviceModel() {
    try {
        // Query native Android bridge for model name if available
        if (typeof window !== 'undefined' && window.LitefinAndroid?.getDeviceName) {
            const name = window.LitefinAndroid.getDeviceName();
            if (name && typeof name === 'string' && name.trim()) {
                return name.trim();
            }
        }
    } catch (e) {
        log.warn('Failed to query device name from LitefinAndroid bridge:', e);
    }

    // Parse model from User Agent string:
    // e.g. "Mozilla/5.0 (Linux; Android 9; MIBOX4 Build/PI; wv)..."
    if (typeof navigator !== 'undefined' && navigator.userAgent) {
        const match = navigator.userAgent.match(/Android[^;)]*;\s*([^;)]+?)\s+Build/i);
        if (match && match[1]) {
            return match[1].trim();
        }
    }

    // Generic fallback when neither bridge nor UA pattern yields a model
    return 'Android TV';
}

/**
 * Resolves the Android OS release version string from User Agent.
 */
function detectAndroidVersion() {
    if (typeof navigator !== 'undefined' && navigator.userAgent) {
        const match = navigator.userAgent.match(/Android\s+([0-9.]+)/i);
        if (match && match[1]) {
            return match[1].trim();
        }
    }
    return '';
}

/**
 * ============================================================================
 * Android Device Capability Detection
 * ============================================================================
 * Evaluates hardware and decoding capabilities for Android platforms.
 * Dynamically switches to standard WebProfile capabilities when the user
 * has selected the HTML5 web player backend in settings.
 * ============================================================================
 * @returns {Object} Capabilities descriptor
 */
export function getDeviceCapabilities() {
    // -------------------------------------------------------------------------
    // HTML5 Player Engine Check
    // -------------------------------------------------------------------------
    // When HTML5 playback backend is selected, report Chromium WebView limits
    // so HTML video player does not attempt unsupported hardware formats.
    // -------------------------------------------------------------------------
    const isHtml5 = PlayerSettings.get('playerBackend') === 'html5';
    if (isHtml5) {
        return WebProfile.getDeviceCapabilities();
    }

    if (_cachedCapabilities) return _cachedCapabilities;

    // Detect HDR display capabilities via media queries
    const hdr10 = typeof window !== 'undefined' && window.matchMedia
        ? window.matchMedia('(color-gamut: rec2020)').matches || window.matchMedia('(color-gamut: p3)').matches
        : true; // Default true on modern Android TV displays

    const hlg = hdr10;

    // Detect actual viewport and screen resolutions
    const screenWidth = typeof window !== 'undefined' ? (window.screen?.width || window.innerWidth || 1920) : 1920;
    const screenHeight = typeof window !== 'undefined' ? (window.screen?.height || window.innerHeight || 1080) : 1080;
    const uhd8K = screenWidth >= 7680 || screenHeight >= 4320;
    const uhd = (screenWidth >= 3840 || screenHeight >= 2160) && !uhd8K;

    // Extract device identity and OS information
    const modelName = detectDeviceModel();
    const androidVersion = detectAndroidVersion();

    // -------------------------------------------------------------------------
    // Native ExoPlayer Media3 Hardware Decoder Profile
    // -------------------------------------------------------------------------
    // Query actual MediaCodecList decoders so devices without AV1 hardware
    // report av1: false, triggering seamless Jellyfin server transcoding.
    // -------------------------------------------------------------------------
    const hwCodecs = detectHardwareVideoCodecs();

    _cachedCapabilities = {
        screenWidth,
        screenHeight,
        uhd,
        uhd8K,
        hdr10: hdr10,
        hlg: hlg,
        dolbyVision: true,
        hevc: hwCodecs.hevc !== false,
        av1: hwCodecs.av1 === true,
        vp9: hwCodecs.vp9 !== false,
        vp8: hwCodecs.vp8 !== false,
        mpeg2video: hwCodecs.mpeg2video !== false,
        mpegts: true,
        ac3: true,
        eac3: true,
        dts: true,
        truehd: true,
        mp2: true,
        maxAudioChannels: 8,
        modelName,
        androidVersion,
        deviceId: BaseProfile.getFallbackDeviceId('litefin_android_')
    };

    return _cachedCapabilities;
}

/**
 * Clears cached capabilities across Android and Web profile modules.
 */
export function clearCapabilitiesCache() {
    _cachedCapabilities = null;
    WebProfile.clearCapabilitiesCache();
}

/**
 * ============================================================================
 * Jellyfin DeviceProfile Builder (Android / Media3 ExoPlayer)
 * ============================================================================
 * Builds the complete Jellyfin-compatible DeviceProfile object.
 *
 * CRITICAL SCHEMA RULES:
 * 1. Do NOT specify 'Id' in the returned DeviceProfile object.
 *    In Jellyfin's ASP.NET Core server, passing an arbitrary 'Id' causes the
 *    server to search for a pre-saved profile in its database. Failing to find
 *    it triggers: HTTP 400 "The supplied value is invalid."
 * 2. TranscodingProfileDto numeric fields (MaxAudioChannels, MinSegments, etc.)
 *    MUST be integers, never strings, to avoid System.Text.Json binding errors.
 * 3. When backend is 'html5', delegate directly to WebProfile for Chromium MSE.
 * ============================================================================
 * @param {Object|number} [options={}] - Profile construction options or manualBitrate
 * @returns {Object} Jellyfin-compatible DeviceProfile
 */
export function buildJellyfinProfile(options = {}) {
    // -------------------------------------------------------------------------
    // Legacy Calling Convention Normalization
    // -------------------------------------------------------------------------
    // Options may be passed as a number (maxBitrate) or an options dictionary.
    // -------------------------------------------------------------------------
    const manualBitrate = typeof options === 'number' ? options : options?.manualBitrate;
    const playbackMode = typeof options === 'object' ? options?.playbackMode || 'auto' : 'auto';

    // -------------------------------------------------------------------------
    // HTML5 Backend Delegation for Android
    // -------------------------------------------------------------------------
    // If the active playback request or user preference specifies HTML5 backend,
    // delegate profile creation directly to WebProfile for Chromium WebView.
    // -------------------------------------------------------------------------
    const isHtml5 = typeof options === 'object'
        ? options?.backend === 'html5'
        : (PlayerSettings.get('playerBackend') === 'html5');

    if (isHtml5) {
        log.info('Delegating Android DeviceProfile creation to WebProfile (HTML5 backend active)');
        return WebProfile.buildJellyfinProfile(options);
    }

    // -------------------------------------------------------------------------
    // Hardware Video Codec Capabilities
    // -------------------------------------------------------------------------
    // Determine exact hardware codec support so that older TV boxes (e.g. S905X)
    // without AV1 hardware decoders trigger server-side video transcoding,
    // avoiding pure black screens and dropped video renderers.
    // -------------------------------------------------------------------------
    const hwCodecs = detectHardwareVideoCodecs();
    const enableHEVC = hwCodecs.hevc !== false;
    const enableVP9 = hwCodecs.vp9 !== false;
    const enableAV1 = hwCodecs.av1 === true;

    // Audio format passthrough settings
    const dtsSetting = PlayerSettings.get('enableDts');
    const enableDts = dtsSetting === 'disable' ? false : true;

    const trueHdSetting = PlayerSettings.get('enableTrueHd');
    const enableTrueHd = trueHdSetting === 'disable' ? false : true;

    const eac3Setting = PlayerSettings.get('enableEac3');
    const enableEac3 = eac3Setting === 'disable' ? false : true;

    // Enforce numeric channel count for DTO serialization
    const userMaxChannels = PlayerSettings.get('allowedAudioChannels');
    const maxAudioChannelsNum = (userMaxChannels && userMaxChannels > 0) ? Number(userMaxChannels) : 8;
    const maxAudioChannelsStr = String(maxAudioChannelsNum);

    // -------------------------------------------------------------------------
    // Direct Play Video Codecs Suite
    // -------------------------------------------------------------------------
    const videoCodecs = ['h264'];
    if (enableHEVC) videoCodecs.push('hevc', 'h265');
    if (enableVP9) videoCodecs.push('vp9');
    if (enableAV1) videoCodecs.push('av1');
    videoCodecs.push('vp8', 'mpeg2video', 'vc1');

    // -------------------------------------------------------------------------
    // Direct Play Audio Codecs Suite
    // -------------------------------------------------------------------------
    const audioCodecs = [];
    if (enableEac3) audioCodecs.push('eac3');
    audioCodecs.push('ac3');
    if (enableTrueHd) audioCodecs.push('truehd');
    if (enableDts) audioCodecs.push('dts', 'dca', 'dtshd', 'dts-hd', 'dts-ma', 'dts-x');
    audioCodecs.push('aac', 'mp3', 'flac', 'opus', 'vorbis', 'pcm', 'wav', 'mp2');

    const videoCodecString = videoCodecs.join(',');
    const audioCodecString = audioCodecs.join(',');

    // -------------------------------------------------------------------------
    // Direct Play Profiles Construction
    // -------------------------------------------------------------------------
    const directPlayProfiles = [];

    if (playbackMode !== 'transcode' && playbackMode !== 'remux' &&
        playbackMode !== 'transcodeVideo' && playbackMode !== 'transcodeAudio') {

        // MKV, MP4, WebM, and MPEG-TS containers
        directPlayProfiles.push({
            Container: 'mkv,mp4,m4v,mov,webm,ts,mpegts,m2ts,avi,wmv,asf',
            Type: 'Video',
            VideoCodec: videoCodecString,
            AudioCodec: audioCodecString
        });

        // Dedicated audio-only Direct Play profile
        directPlayProfiles.push({
            Container: 'mp3,flac,ogg,oga,opus,aac,m4a,wma,wav,alac',
            Type: 'Audio',
            AudioCodec: audioCodecString
        });

        // HLS Direct Stream / Remux container
        directPlayProfiles.push({
            Container: 'hls',
            Type: 'Video',
            VideoCodec: videoCodecString,
            AudioCodec: audioCodecString
        });
    }

    // -------------------------------------------------------------------------
    // DirectStreamProfiles (Progressive Container DirectStream)
    // -------------------------------------------------------------------------
    // Omitted in remux/transcode modes to ensure seekable segmented HLS delivery.
    // -------------------------------------------------------------------------
    const directStreamProfiles = (playbackMode !== 'transcode' && playbackMode !== 'remux' &&
        playbackMode !== 'transcodeVideo' && playbackMode !== 'transcodeAudio') ? [
        {
            Container: 'mp4',
            Type: 'Video',
            VideoCodec: videoCodecString,
            AudioCodec: audioCodecString
        }
    ] : [];

    // -------------------------------------------------------------------------
    // Codec Profiles (Levels and Audio Channel Ceiling)
    // -------------------------------------------------------------------------
    const codecProfiles = [
        // HEVC Main, Main 10, HDR10 up to Level 6.1
        {
            Type: 'Video',
            Codec: 'hevc',
            Conditions: [
                {
                    Condition: 'LessThanEqual',
                    Property: 'VideoLevel',
                    Value: '183',
                    IsRequired: false
                }
            ]
        },
        // H.264 High Profile up to Level 5.2
        {
            Type: 'Video',
            Codec: 'h264',
            Conditions: [
                {
                    Condition: 'LessThanEqual',
                    Property: 'VideoLevel',
                    Value: '52',
                    IsRequired: false
                }
            ]
        },
        // Multichannel audio constraint
        {
            Type: 'VideoAudio',
            Conditions: [
                {
                    Condition: 'LessThanEqual',
                    Property: 'AudioChannels',
                    Value: maxAudioChannelsStr,
                    IsRequired: false
                }
            ]
        }
    ];

    // -------------------------------------------------------------------------
    // Video Transcode Codec Resolution (MPEG-TS & fMP4 HLS)
    // -------------------------------------------------------------------------
    // Build transcode video codecs dynamically matching verified hardware capabilities.
    // If a codec is unsupported by the chipset (e.g., AV1 on older TV boxes like S905X),
    // it MUST NOT be advertised in TranscodingProfiles. Otherwise, Jellyfin's
    // StreamBuilder assumes the client can consume AV1 inside HLS and will attempt to
    // copy/remux the raw AV1 stream rather than transcoding to H.264/HEVC, triggering
    // fatal native ExoPlayer playback errors (ERROR_CODE_IO_UNSPECIFIED).
    // -------------------------------------------------------------------------
    const tsTransVideoCodecs = ['h264'];
    if (enableHEVC) tsTransVideoCodecs.push('hevc');
    const tsTransVideoCodecString = tsTransVideoCodecs.join(',');

    let mp4TransVideoCodecs = ['h264'];
    if (enableHEVC) mp4TransVideoCodecs.push('hevc');
    if (enableVP9) mp4TransVideoCodecs.push('vp9');
    if (enableAV1) mp4TransVideoCodecs.push('av1');

    // Force universal H.264 video transcode when user explicitly forces video transcode mode
    if (playbackMode === 'transcodeVideo') {
        mp4TransVideoCodecs = ['h264'];
    }
    const mp4TransVideoCodecString = mp4TransVideoCodecs.join(',');

    // -------------------------------------------------------------------------
    // Audio Transcode Codec Resolution
    // -------------------------------------------------------------------------
    // Align HLS audio transcode targets with user-configured audio capabilities.
    // Respect EAC-3 toggle so the server does not transcode to EAC-3 when disabled.
    // -------------------------------------------------------------------------
    const transAudioCodecs = [];
    if (enableEac3) transAudioCodecs.push('eac3');
    transAudioCodecs.push('ac3', 'aac', 'mp3');
    const transAudioCodecString = transAudioCodecs.join(',');

    // MP4/fMP4 containers can additionally carry lossless FLAC audio
    const mp4TransAudioCodecString = [...transAudioCodecs, 'flac'].join(',');

    // -------------------------------------------------------------------------
    // Transcoding Fallback Profiles (HLS Stream Delivery)
    // -------------------------------------------------------------------------
    // MaxAudioChannels and MinSegments are strictly numeric integers.
    // -------------------------------------------------------------------------
    const transcodingProfiles = [
        {
            Container: 'ts',
            Type: 'Video',
            AudioCodec: transAudioCodecString,
            VideoCodec: tsTransVideoCodecString,
            Context: 'Streaming',
            Protocol: 'hls',
            MaxAudioChannels: maxAudioChannelsNum,
            MinSegments: 1,
            BreakOnNonKeyFrames: true
        },
        {
            Container: 'mp4',
            Type: 'Video',
            AudioCodec: mp4TransAudioCodecString,
            VideoCodec: mp4TransVideoCodecString,
            Context: 'Streaming',
            Protocol: 'hls',
            MaxAudioChannels: maxAudioChannelsNum,
            MinSegments: 1,
            BreakOnNonKeyFrames: true
        },
        {
            Container: 'mp3',
            Type: 'Audio',
            AudioCodec: 'mp3',
            Context: 'Streaming',
            Protocol: 'http'
        }
    ];

    // -------------------------------------------------------------------------
    // Assemble Unified Jellyfin DeviceProfile
    // -------------------------------------------------------------------------
    // Notice: Id is strictly omitted here to prevent server lookup validation errors.
    // -------------------------------------------------------------------------
    const effectiveBitrate = manualBitrate || 120000000;
    const profile = {
        Name: `Litefin Android (Media3 ExoPlayer)${playbackMode !== 'auto' ? ` (${playbackMode})` : ''}`,
        MaxStreamingBitrate: effectiveBitrate,
        MaxStaticBitrate: effectiveBitrate,
        MusicStreamingTranscodingBitrate: 320000,
        DirectPlayProfiles: directPlayProfiles,
        DirectStreamProfiles: directStreamProfiles,
        TranscodingProfiles: transcodingProfiles,
        CodecProfiles: codecProfiles,
        SubtitleProfiles: BaseProfile.getSubtitleProfiles(),
        ResponseProfiles: BaseProfile.getResponseProfiles()
    };

    log.info('Constructed Jellyfin Android profile:', profile.Name);
    return profile;
}

/**
 * Returns the persistent device identifier for Session registration.
 * @returns {string}
 */
export function getDeviceId() {
    return getDeviceCapabilities().deviceId;
}

/**
 * Returns human-readable device model name.
 * @returns {string}
 */
export function getDeviceName() {
    return getDeviceCapabilities().modelName;
}
