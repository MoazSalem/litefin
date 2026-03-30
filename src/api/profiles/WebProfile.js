/**
 * ============================================================================
 * Litefin Web — Web Device Profile
 * ============================================================================
 * Capability detection and Jellyfin profile generation for standard HTML5
 * web browsers.
 * ============================================================================
 */

import { logger } from '../../utils/Logger.js';
import { PlayerSettings } from '../../utils/PlayerSettings.js';
import { BaseProfile } from './BaseProfile.js';

const log = logger.create('WebProfile');

let _cachedCapabilities = null;
let _cachedBrowserVersion = null;

function _getBrowserVersion() {
    if (_cachedBrowserVersion) return _cachedBrowserVersion;

    const ua = navigator.userAgent;
    let version = '';

    // Check for Chrome/Chromium
    const chromeMatch = ua.match(/(?:Chrome|Chromium)\/([0-9]+)/);
    if (chromeMatch) {
        version = chromeMatch[1];
    } else {
        // Fallback to other browsers if needed, but we mostly care about Chromium
        const versionMatch = ua.match(/(?:Version|Firefox|Edge|Safari)\/([0-9]+)/);
        if (versionMatch) {
            version = versionMatch[1];
        }
    }

    _cachedBrowserVersion = version || 'Unknown';
    return _cachedBrowserVersion;
}

export function getDeviceCapabilities() {
    if (_cachedCapabilities) return _cachedCapabilities;

    const browserVersion = _getBrowserVersion();

    // A modern web browser we assume is capable of standard formats
    let uhd = true;
    let uhd8K = false;
    const hdr10 = false;
    const dolbyVision = false;

    const deviceId = BaseProfile.getFallbackDeviceId('litefin_web_');
    const modelName = 'Web Browser';

    // Typically, we could check navigator for some things, but for codec flags
    // we often rely on standard MediaSource or just server fallback
    let hevc = false;
    let av1 = false;
    let vp9 = true;
    const vp8 = true;
    let ac3 = false;
    let eac3 = false;

    // Check basic MSE support
    if (window.MediaSource) {
        hevc =
            MediaSource.isTypeSupported('video/mp4; codecs="hev1"') ||
            MediaSource.isTypeSupported('video/mp4; codecs="hvc1"');
        av1 = MediaSource.isTypeSupported('video/mp4; codecs="av01"');
        vp9 = MediaSource.isTypeSupported('video/webm; codecs="vp9"');
        ac3 = MediaSource.isTypeSupported('audio/mp4; codecs="ac-3"');
        eac3 = MediaSource.isTypeSupported('audio/mp4; codecs="ec-3"');
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
        browserVersion,
        screenWidth: window.screen ? window.screen.width : uhd ? 3840 : 1920,
        screenHeight: window.screen ? window.screen.height : uhd ? 2160 : 1080,
        uhd,
        uhd8K,
        hdr10,
        hdr10Plus: false,
        hlg: false,
        dolbyVision,
        hevc,
        av1,
        vp9,
        vp8,
        ac3,
        eac3,
        dts: false,
        truehd: false,
        maxAudioChannels: 6
    };

    log.info('Web capabilities:', JSON.stringify(_cachedCapabilities, null, 2));
    return _cachedCapabilities;
}

export function clearCapabilitiesCache() {
    _cachedCapabilities = null;
}

function _buildMinimalProfile(caps) {
    return {
        Name: 'Litefin Web (Forced Transcode)',
        MaxStreamingBitrate: PlayerSettings.get('maxBitrateInternet') || 40000000,
        MaxStaticBitrate: 40000000,
        MusicStreamingTranscodingBitrate: 192000,
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

    let enableHEVC = PlayerSettings.get('enableHEVC');
    if (localStorage.getItem('player:enableHEVC') === null) enableHEVC = caps.hevc;

    let enableAV1 = PlayerSettings.get('enableAV1');
    if (localStorage.getItem('player:enableAV1') === null) enableAV1 = caps.av1;

    let enableVP9 = PlayerSettings.get('enableVP9');
    if (localStorage.getItem('player:enableVP9') === null) enableVP9 = caps.vp9;

    // Hybrid HDR: Default to hardware capability unless the user explicitly flipped the setting
    let enableHDR = PlayerSettings.get('enableHDR');
    if (localStorage.getItem('player:enableHDR') === null) {
        // HDR isn't handled perfectly in all browsers, but many 4K screens/OSs handle tone mapping.
        // We'll stick to caps.hdr10 default (which is usually false for Web) but allow full user override.
        enableHDR = !!caps.hdr10;
    }

    if (PlayerSettings.get('forceTranscode') || playbackMode === 'transcode') {
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

    // Standard web audio
    const audioCodecs = ['aac', 'mp3', 'flac', 'opus', 'vorbis', 'pcm', 'wav'];
    if (caps.ac3) audioCodecs.push('ac3');
    if (caps.eac3) audioCodecs.push('eac3');

    const audioCodecString = audioCodecs.join(',');

    const generalVideoCodecs = ['h264'];
    if (enableHEVC) generalVideoCodecs.push('hevc');
    if (enableVP9) generalVideoCodecs.push('vp9');
    if (caps.vp8) generalVideoCodecs.push('vp8');
    if (enableAV1) generalVideoCodecs.push('av1');

    const webmVideoCodecs = [];
    if (caps.vp8) webmVideoCodecs.push('vp8');
    if (enableVP9) webmVideoCodecs.push('vp9');
    if (enableAV1) webmVideoCodecs.push('av1');

    const directPlayProfiles = [];

    if (playbackMode !== 'transcode' && playbackMode !== 'remux') {
        // MP4 / M4V / MOV
        directPlayProfiles.push({
            Container: 'mp4,m4v,mov',
            Type: 'Video',
            VideoCodec: generalVideoCodecs.join(','),
            AudioCodec: audioCodecString
        });

        // MKV is technically playable by some browsers but generally safer to assume MP4/WEBM
        directPlayProfiles.push({
            Container: 'mkv',
            Type: 'Video',
            VideoCodec: generalVideoCodecs.join(','),
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

        // Add HLS as a DirectPlay profile to encourage the server to Direct Stream (Remux)
        directPlayProfiles.push({
            Container: 'hls',
            Type: 'Video',
            VideoCodec: generalVideoCodecs.join(','),
            AudioCodec: audioCodecString
        });

        directPlayProfiles.push({
            Container: 'mp3,flac,aac,m4a,m4b,ogg,opus,wav,wma,webma',
            Type: 'Audio',
            AudioCodec: audioCodecString
        });
    }

    let transAudioCodecs = caps.ac3 ? 'aac,ac3,eac3' : 'aac';
    let transVideoCodecs = enableHEVC ? 'h264,hevc' : 'h264';

    if (playbackMode === 'remux') {
        transAudioCodecs = audioCodecString;
        transVideoCodecs = generalVideoCodecs.join(',');
    }

    const broadTransVideo = [transVideoCodecs, enableAV1 ? 'av1' : '', enableVP9 ? 'vp9' : '']
        .filter(Boolean)
        .join(',');

    const transcodingProfiles = [
        {
            Container: 'mp4',
            Type: 'Video',
            AudioCodec: transAudioCodecs,
            VideoCodec: broadTransVideo,
            Context: 'Streaming',
            Protocol: 'hls',
            MaxAudioChannels: maxAudioChannels,
            MinSegments: '2',
            SegmentLength: '4',
            BreakOnNonKeyFrames: playbackMode !== 'remux'
        },
        {
            Container: 'ts',
            Type: 'Video',
            AudioCodec: transAudioCodecs,
            VideoCodec: transVideoCodecs,
            Context: 'Streaming',
            Protocol: 'hls',
            MaxAudioChannels: maxAudioChannels,
            MinSegments: '2',
            SegmentLength: '4',
            BreakOnNonKeyFrames: playbackMode !== 'remux'
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
        }
    ];

    // Relaxed levels for HTML5/MSE
    const h264Level = '51';
    const hevcLevel = '183';

    const rangeTypes = ['SDR'];
    if (enableHDR)
        rangeTypes.push(
            'HDR10',
            'HDR10Plus',
            'HLG',
            'DOVIWithSDR',
            'DOVIWithHDR10',
            'DOVIWithHDR10Plus',
            'DOVIWithHLG',
            'DOVIWithEL',
            'DOVIWithELHDR10Plus',
            'DOVIInvalid'
        );

    const rangeCondition = {
        Condition: 'EqualsAny',
        Property: 'VideoRangeType',
        Value: rangeTypes.join('|'),
        IsRequired: false
    };

    const bitrateCondition = {
        Condition: 'LessThanEqual',
        Property: 'VideoBitrate',
        Value: maxBitrate.toString(),
        IsRequired: true
    };

    const codecProfiles = [
        {
            Type: 'Video',
            Codec: 'h264',
            Conditions: [
                { Condition: 'LessThanEqual', Property: 'VideoLevel', Value: h264Level, IsRequired: false },
                rangeCondition,
                bitrateCondition
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
                { Condition: 'LessThanEqual', Property: 'VideoLevel', Value: hevcLevel, IsRequired: false },
                {
                    Condition: 'LessThanEqual',
                    Property: 'VideoBitDepth',
                    Value: enableHDR ? '10' : '8',
                    IsRequired: false
                },
                rangeCondition,
                bitrateCondition
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
                rangeCondition,
                bitrateCondition
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
                rangeCondition,
                bitrateCondition
            ]
        });
    }

    return {
        Name: `Litefin Web (HTML5)${playbackMode !== 'auto' ? ` (${playbackMode})` : ''}`,
        MaxStreamingBitrate: maxBitrate,
        MaxStaticBitrate: maxBitrate,
        MaxStaticMusicBitrate: 40000000,
        MusicStreamingTranscodingBitrate: 192000,
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
