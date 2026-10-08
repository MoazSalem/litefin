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

    // -------------------------------------------------------------------------
    // Native ExoPlayer Media3 Hardware Decoder Profile
    // -------------------------------------------------------------------------
    // Native Media3 ExoPlayer paired with Android MediaCodec handles full
    // zero-copy decoding across all broadcast, disc, and web codecs.
    // -------------------------------------------------------------------------
    _cachedCapabilities = {
        uhd: true,
        uhd8K: false,
        hdr10: hdr10,
        hlg: hlg,
        dolbyVision: true,
        hevc: true,
        av1: true,
        vp9: true,
        vp8: true,
        mpeg2video: true,
        mpegts: true,
        ac3: true,
        eac3: true,
        dts: true,
        truehd: true,
        mp2: true,
        maxAudioChannels: 8,
        modelName: 'Android TV (Media3 ExoPlayer)',
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
    // Native ExoPlayer paired with MediaCodec decodes HEVC, VP9, and AV1
    // directly on hardware out of the box without requiring software shims.
    // -------------------------------------------------------------------------
    const enableHEVC = true;
    const enableVP9 = true;
    const enableAV1 = true;

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
    // Transcoding Fallback Profiles (HLS Stream Delivery)
    // -------------------------------------------------------------------------
    // MaxAudioChannels and MinSegments are strictly numeric integers.
    // -------------------------------------------------------------------------
    const transcodingProfiles = [
        {
            Container: 'ts',
            Type: 'Video',
            AudioCodec: 'ac3,eac3,aac,mp3',
            VideoCodec: 'h264,hevc',
            Context: 'Streaming',
            Protocol: 'hls',
            MaxAudioChannels: maxAudioChannelsNum,
            MinSegments: 1,
            BreakOnNonKeyFrames: true
        },
        {
            Container: 'mp4',
            Type: 'Video',
            AudioCodec: 'ac3,eac3,aac,mp3,flac',
            VideoCodec: 'h264,hevc,av1,vp9',
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
