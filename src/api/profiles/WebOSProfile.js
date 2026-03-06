/**
 * ============================================================================
 * Litefin WebOS — WebOS Device Profile
 * ============================================================================
 * WebOS-specific capability detection and Jellyfin profile generation.
 * ============================================================================
 */

import { logger } from '../../utils/Logger.js';
import { PlayerSettings } from '../../utils/PlayerSettings.js';
import { BaseProfile } from './BaseProfile.js';

const log = logger.create('WebOSProfile');

let _cachedCapabilities = null;

function getWebOSVersion() {
    const userAgent = navigator.userAgent.toLowerCase();
    const match = /(?:chrome|crios|crmo)\/([0-9.]+)/.exec(userAgent);
    if (!match) return 0;

    const versionMajor = parseInt(match[1].split('.')[0], 10);

    if (versionMajor >= 94) return 23;
    if (versionMajor >= 87) return 22;
    if (versionMajor >= 79) return 6;
    if (versionMajor >= 68) return 5;
    if (versionMajor >= 53) return 4;
    if (versionMajor >= 38) return 3;
    if (versionMajor >= 34) return 2;
    if (versionMajor >= 26) return 1;

    return 1; // Fallback for very old versions
}

let _maxChannelCount = null;
function getChannelCount() {
    if (_maxChannelCount != null) {
        return _maxChannelCount;
    }

    _maxChannelCount = 2; // Default
    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext || false;
        if (AudioContext) {
            const audioCtx = new AudioContext();
            _maxChannelCount = audioCtx.destination.maxChannelCount || 2;
            audioCtx.close();
        }
    } catch (e) {
        log.warn('Failed to detect AudioContext channels:', e);
    }

    // TVs generally shouldn't report less than 2
    return Math.max(_maxChannelCount, 2);
}

export function getDeviceCapabilities() {
    if (_cachedCapabilities) return _cachedCapabilities;

    let uhd = true;
    let uhd8K = false;
    let hdr10 = true;
    let dolbyVision = false; // Will be set by heuristics or deviceInfo

    const deviceId = BaseProfile.getFallbackDeviceId('litefin_webos_');
    let modelName = 'LG WebOS TV';

    const webosVersion = getWebOSVersion();
    const maxAudioChannels = getChannelCount();

    // Default capabilities based on WebOS version heuristics
    const hevc = webosVersion >= 3;
    const av1 = webosVersion >= 5;
    const vp9 = webosVersion >= 3;
    // LG disabled DTS support on WebOS 5.0 through 22 (2020-2022 models)
    const dts = !(webosVersion >= 5 && webosVersion < 23);

    if (webosVersion >= 4) {
        dolbyVision = true; // Assume Dolby Vision Profile 8 support for WebOS 4+ even if not reported
    }

    if (typeof window.webOS !== 'undefined' && window.webOS.deviceInfo) {
        window.webOS.deviceInfo((info) => {
            if (info.modelName) modelName = info.modelName;
            if (info.uhd) uhd = info.uhd === 'true';
            if (info['8k']) uhd8K = info['8k'] === 'true';
            if (info.hdr10) hdr10 = info.hdr10 === 'true';
            if (info.dolbyVision === 'true') dolbyVision = true;
        });
    }

    const manualRes = PlayerSettings.get('maxResolution');
    if (manualRes && manualRes !== 'auto') {
        switch (manualRes) {
            case '720p':
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

    _cachedCapabilities = {
        modelName,
        deviceId,
        webosVersion,
        screenWidth: uhd8K ? 7680 : uhd ? 3840 : 1920,
        screenHeight: uhd8K ? 4320 : uhd ? 2160 : 1080,
        uhd,
        uhd8K,
        hdr10,
        hdr10Plus: false, // Generally not supported on LG
        hlg: hdr10,
        dolbyVision,
        hevc,
        av1,
        vp9,
        vp8: true,
        ac3: true,
        eac3: true,
        dts,
        truehd: false,
        maxAudioChannels
    };

    log.info('WebOS capabilities:', JSON.stringify(_cachedCapabilities, null, 2));
    return _cachedCapabilities;
}

export function clearCapabilitiesCache() {
    _cachedCapabilities = null;
}

function _buildMinimalProfile(caps) {
    return {
        Name: 'Litefin WebOS (Forced Transcode)',
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
        SubtitleProfiles: BaseProfile.getSubtitleProfiles(),
        ResponseProfiles: []
    };
}

export function buildJellyfinProfile(options = {}) {
    const manualBitrateOverride = typeof options === 'number' ? options : options.manualBitrate;
    const playbackMode = typeof options === 'object' ? options.playbackMode || 'auto' : 'auto';

    const caps = getDeviceCapabilities();

    const enableHEVC = PlayerSettings.get('enableHEVC') && caps.hevc;
    const enableAV1 = PlayerSettings.get('enableAV1') && caps.av1;
    const enableVP9 = PlayerSettings.get('enableVP9') && caps.vp9;
    const enableHDR = PlayerSettings.get('enableHDR') && caps.hdr10;
    const enableDolbyVision = PlayerSettings.get('enableDolbyVision') && caps.dolbyVision;
    const enableDts = PlayerSettings.get('enableDts');
    const enableTrueHd = PlayerSettings.get('enableTrueHd');

    if (PlayerSettings.get('forceTranscode') && playbackMode === 'auto') {
        return _buildMinimalProfile(caps);
    }

    let maxBitrate = 120000000;
    if (playbackMode !== 'directPlay' && playbackMode !== 'transcode' && playbackMode !== 'remux') {
        maxBitrate =
            manualBitrateOverride ||
            PlayerSettings.get('maxBitrateInternet') ||
            (caps.uhd8K ? 120000000 : caps.uhd ? 120000000 : 40000000);
    }

    const maxAudioChannels = String(caps.maxAudioChannels);

    const audioCodecs = ['aac', 'mp3', 'flac', 'opus', 'vorbis', 'pcm', 'wav', 'pcm_s16le', 'pcm_s24le', 'aac_latm'];
    if (caps.ac3) audioCodecs.push('ac3');
    if (caps.eac3) audioCodecs.push('eac3');
    if (enableDts) audioCodecs.push('dts', 'dca');
    if (enableTrueHd) audioCodecs.push('truehd');

    const audioCodecString = audioCodecs.join(',');

    const generalVideoCodecs = ['h264', 'mpeg2video', 'vc1'];
    if (enableHEVC) generalVideoCodecs.push('hevc');
    if (enableVP9) generalVideoCodecs.push('vp9');
    if (caps.vp8) generalVideoCodecs.push('vp8');
    if (enableAV1) generalVideoCodecs.push('av1');

    const mkvVideoCodecs = [...generalVideoCodecs, 'msmpeg4v2'];

    const webmVideoCodecs = [];
    if (caps.vp8) webmVideoCodecs.push('vp8');
    if (enableVP9) webmVideoCodecs.push('vp9');
    if (enableAV1) webmVideoCodecs.push('av1');

    const tsVideoCodecs = ['h264', 'vc1', 'mpeg2video'];
    if (enableHEVC) tsVideoCodecs.push('hevc');
    if (enableAV1) tsVideoCodecs.push('av1');

    const m2tsVideoCodecs = ['h264', 'vc1', 'mpeg2video'];

    const directPlayProfiles = [];

    if (playbackMode !== 'transcode' && playbackMode !== 'remux') {
        directPlayProfiles.push({
            Container: 'mp4,m4v,mov',
            Type: 'Video',
            VideoCodec: generalVideoCodecs.join(','),
            AudioCodec: audioCodecString
        });
        directPlayProfiles.push({
            Container: 'mkv',
            Type: 'Video',
            VideoCodec: mkvVideoCodecs.join(','),
            AudioCodec: audioCodecString
        });
        if (webmVideoCodecs.length > 0) {
            directPlayProfiles.push({
                Container: 'webm',
                Type: 'Video',
                VideoCodec: webmVideoCodecs.join(','),
                AudioCodec: 'vorbis,opus'
            });
        }
        directPlayProfiles.push({
            Container: 'ts,mpegts',
            Type: 'Video',
            VideoCodec: tsVideoCodecs.join(','),
            AudioCodec: audioCodecString
        });
        directPlayProfiles.push({
            Container: 'm2ts',
            Type: 'Video',
            VideoCodec: m2tsVideoCodecs.join(','),
            AudioCodec: audioCodecString
        });
        directPlayProfiles.push({
            Container: 'avi',
            Type: 'Video',
            VideoCodec: ['h264', enableHEVC ? 'hevc' : '', 'mpeg2video'].filter(Boolean).join(','),
            AudioCodec: audioCodecString
        });
        directPlayProfiles.push({
            Container: 'wmv,asf',
            Type: 'Video',
            AudioCodec: audioCodecString
        });
        directPlayProfiles.push({
            Container: 'mpg,mpeg,flv,3gp,vob,vro',
            Type: 'Video',
            AudioCodec: audioCodecString
        });
        directPlayProfiles.push({
            Container: 'mp3,flac,aac,m4a,m4b,ogg,opus,wav,wma,webma',
            Type: 'Audio'
        });
    }

    let transAudioCodecs = caps.ac3 ? 'aac,ac3,eac3' : 'aac';
    let transVideoCodecs = enableHEVC ? 'h264,hevc' : 'h264';

    if (playbackMode === 'remux') {
        transAudioCodecs = audioCodecString;
        const allVideo = new Set([...generalVideoCodecs, ...mkvVideoCodecs, ...tsVideoCodecs]);
        transVideoCodecs = Array.from(allVideo).join(',');
    }

    const broadTransVideo = [transVideoCodecs, enableAV1 ? 'av1' : '', enableVP9 ? 'vp9' : '']
        .filter(Boolean)
        .join(',');

    const transcodingProfiles = [
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
            BreakOnNonKeyFrames: playbackMode !== 'remux'
        },
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
        {
            Container: 'aac',
            Type: 'Audio',
            AudioCodec: 'aac',
            Context: 'Streaming',
            Protocol: 'hls',
            MaxAudioChannels: maxAudioChannels,
            MinSegments: '1'
        },
        {
            Container: 'mp3',
            Type: 'Audio',
            AudioCodec: 'mp3',
            Context: 'Streaming',
            Protocol: 'http'
        },
        {
            Container: 'opus',
            Type: 'Audio',
            AudioCodec: 'opus',
            Context: 'Streaming',
            Protocol: 'http'
        },
        {
            Container: 'mkv',
            Type: 'Video',
            AudioCodec: audioCodecString,
            VideoCodec: mkvVideoCodecs.join(','),
            Context: 'Static',
            CopyTimestamps: true,
            MaxAudioChannels: maxAudioChannels
        },
        {
            Container: 'mp4',
            Type: 'Video',
            AudioCodec: 'aac,ac3',
            VideoCodec: 'h264',
            Context: 'Static'
        }
    ];

    const h264Level = caps.uhd ? '51' : '41';
    const hevcLevel = caps.uhd8K ? '183' : caps.uhd ? '153' : '123';

    let codecProfiles = [];

    if (playbackMode !== 'remux') {
        const hdrCondition = !enableHDR
            ? [{ Condition: 'EqualsAny', Property: 'VideoRangeType', Value: 'SDR', IsRequired: false }]
            : [];

        // Adding condition for Dolby Vision
        if (!enableDolbyVision) {
            hdrCondition.push({ Condition: 'NotEquals', Property: 'VideoRangeType', Value: 'DOVI', IsRequired: false });
        }

        codecProfiles = [
            {
                Type: 'Video',
                Codec: 'h264',
                Conditions: [
                    { Condition: 'NotEquals', Property: 'IsAnamorphic', Value: 'true', IsRequired: false },
                    {
                        Condition: 'EqualsAny',
                        Property: 'VideoProfile',
                        Value: 'high|main|baseline|constrained baseline|high 10',
                        IsRequired: false
                    },
                    { Condition: 'LessThanEqual', Property: 'VideoLevel', Value: h264Level, IsRequired: false },
                    { Condition: 'LessThanEqual', Property: 'VideoBitDepth', Value: '8', IsRequired: false },
                    { Condition: 'LessThanEqual', Property: 'RefFrames', Value: '16', IsRequired: false },
                    ...hdrCondition
                ]
            },
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

        if (enableHEVC) {
            codecProfiles.push({
                Type: 'Video',
                Codec: 'hevc',
                Conditions: [
                    { Condition: 'EqualsAny', Property: 'VideoProfile', Value: 'main|main 10', IsRequired: false },
                    { Condition: 'LessThanEqual', Property: 'VideoLevel', Value: hevcLevel, IsRequired: false },
                    { Condition: 'LessThanEqual', Property: 'VideoBitDepth', Value: '10', IsRequired: false },
                    ...hdrCondition
                ]
            });
        }

        if (enableVP9) {
            codecProfiles.push({
                Type: 'Video',
                Codec: 'vp9',
                Conditions: [
                    {
                        Condition: 'EqualsAny',
                        Property: 'VideoProfile',
                        Value: enableHDR ? 'profile 0|profile 2' : 'profile 0',
                        IsRequired: false
                    },
                    ...hdrCondition
                ]
            });
        }

        if (enableAV1) {
            codecProfiles.push({
                Type: 'Video',
                Codec: 'av1',
                Conditions: [
                    { Condition: 'LessThanEqual', Property: 'VideoLevel', Value: '15', IsRequired: false },
                    {
                        Condition: 'LessThanEqual',
                        Property: 'VideoBitDepth',
                        Value: enableHDR ? '10' : '8',
                        IsRequired: false
                    },
                    ...hdrCondition
                ]
            });
        }
    } else {
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

    return {
        Name: `Litefin WebOS${playbackMode !== 'auto' ? ` (${playbackMode})` : ''}`,
        MaxStreamingBitrate: maxBitrate,
        MaxStaticBitrate: maxBitrate,
        MaxStaticMusicBitrate: 40000000,
        MusicStreamingTranscodingBitrate: 384000,
        DirectPlayProfiles: directPlayProfiles,
        TranscodingProfiles: transcodingProfiles,
        CodecProfiles: codecProfiles,
        SubtitleProfiles: BaseProfile.getSubtitleProfiles(),
        ResponseProfiles: BaseProfile.getResponseProfiles()
    };
}

export function getDeviceId() {
    const caps = getDeviceCapabilities();
    return caps.deviceId;
}

export function getDeviceName() {
    const caps = getDeviceCapabilities();
    return caps.modelName;
}
