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

    const hdr10 = window.matchMedia
        ? window.matchMedia('(color-gamut: rec2020)').matches || window.matchMedia('(color-gamut: p3)').matches
        : false;
    const hlg = hdr10;

    const deviceId = BaseProfile.getFallbackDeviceId('litefin_web_');
    const modelName = 'Web Browser';

    const video = document.createElement('video');

    let hevc = false;
    let av1 = false;
    let vp9 = false;
    let vp8 = false;
    let ac3 = false;
    let eac3 = false;
    let mpeg2video = false;
    let mpegts = false;
    let mp2 = false;

    // Check basic MSE support
    if (window.MediaSource) {
        hevc =
            MediaSource.isTypeSupported('video/mp4; codecs="hev1"') ||
            MediaSource.isTypeSupported('video/mp4; codecs="hvc1"') ||
            MediaSource.isTypeSupported('video/mp4; codecs="hev1.1.6.L93.B0"') ||
            MediaSource.isTypeSupported('video/mp4; codecs="hev1.2.4.L120.B0"') ||
            MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L93.B0"') ||
            MediaSource.isTypeSupported('video/mp4; codecs="hvc1.2.4.L120.B0"');
        av1 = MediaSource.isTypeSupported('video/mp4; codecs="av01"');
        vp9 =
            MediaSource.isTypeSupported('video/webm; codecs="vp9"') ||
            MediaSource.isTypeSupported('video/mp4; codecs="vp09.00.10.08"');
        vp8 = MediaSource.isTypeSupported('video/webm; codecs="vp8"');
        ac3 = MediaSource.isTypeSupported('audio/mp4; codecs="ac-3"');
        eac3 = MediaSource.isTypeSupported('audio/mp4; codecs="ec-3"');
    }

    hevc =
        hevc ||
        video.canPlayType('video/mp4; codecs="hev1"') !== '' ||
        video.canPlayType('video/mp4; codecs="hvc1"') !== '' ||
        video.canPlayType('video/mp4; codecs="hev1.1.6.L93.B0"') !== '' ||
        video.canPlayType('video/mp4; codecs="hev1.2.4.L120.B0"') !== '' ||
        video.canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"') !== '' ||
        video.canPlayType('video/mp4; codecs="hvc1.2.4.L120.B0"') !== '';
    av1 = av1 || video.canPlayType('video/mp4; codecs="av01"') !== '';
    vp9 =
        vp9 ||
        video.canPlayType('video/webm; codecs="vp9"') !== '' ||
        video.canPlayType('video/mp4; codecs="vp09.00.10.08"') !== '';
    vp8 = vp8 || video.canPlayType('video/webm; codecs="vp8"') !== '';
    ac3 = ac3 || video.canPlayType('audio/mp4; codecs="ac-3"') !== '';
    eac3 = eac3 || video.canPlayType('audio/mp4; codecs="ec-3"') !== '';

    // MPEG-2 Video and TS container detection via HTML5 video canPlayType
    mpeg2video =
        video.canPlayType('video/mp4; codecs="mp2v.20.2"') !== '' ||
        video.canPlayType('video/mpeg') !== '' ||
        video.canPlayType('video/mp2t; codecs="mp2v.20.2"') !== '';
    mpegts =
        video.canPlayType('video/mp2t') !== '';

    // MP2 audio detection via HTML5 audio canPlayType
    mp2 = false; // HTML5 browsers do not support MP2 in media streams natively (probes are unreliable)

    // Apply the user's EAC3 force-state setting.
    // Browser canPlayType / MSE.isTypeSupported for EAC3 are notoriously unreliable
    // on some platforms (WebOS, some Samsung browsers). If the user has set 'enable',
    // we override the probe result so EAC3 gets into the DirectPlay list and the
    // transcode target list regardless of what the browser reports.
    const eac3ForceSetting = PlayerSettings.get('enableEac3');
    if (eac3ForceSetting === 'enable') {
        eac3 = true;
    } else if (eac3ForceSetting === 'disable') {
        eac3 = false;
    }
    // 'auto' (default): keep the probed value as-is

    // Dolby Vision detection
    const dolbyVision =
        video.canPlayType('video/mp4; codecs="dvh1.05.01"') !== '' ||
        video.canPlayType('video/mp4; codecs="dvhe.05.01"') !== '' ||
        video.canPlayType('video/mp4; codecs="dvc1.05.01"') !== '';

    // DTS & TrueHD detection
    const dts =
        video.canPlayType('audio/mp4; codecs="dts-"') !== '' ||
        video.canPlayType('audio/mp4; codecs="dtsc"') !== '' ||
        video.canPlayType('audio/mp4; codecs="dtsb"') !== '' ||
        video.canPlayType('audio/mp4; codecs="dtse"') !== '';
    const truehd = video.canPlayType('audio/mp4; codecs="mlpa"') !== '';

    // Dynamic max audio channel detection via Web Audio API
    let maxAudioChannels = 2;
    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (AudioContext) {
            const ctx = new AudioContext();
            maxAudioChannels = ctx.destination.maxChannelCount || 2;
            ctx.close();
        }
    } catch (e) {
        maxAudioChannels = 2;
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
        hlg,
        dolbyVision,
        hevc,
        av1,
        vp9,
        vp8,
        ac3,
        eac3,
        dts,
        truehd,
        mpeg2video,
        mpegts,
        mp2,
        maxAudioChannels
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
                SegmentLength: String(PlayerSettings.get('html5SegmentLength') || 2),
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

    const hevcSetting = PlayerSettings.get('enableHEVC');
    const enableHEVC = hevcSetting === 'enable' ? true : hevcSetting === 'disable' ? false : caps.hevc;

    const av1Setting = PlayerSettings.get('enableAV1');
    const enableAV1 = av1Setting === 'enable' ? true : av1Setting === 'disable' ? false : caps.av1;

    const vp9Setting = PlayerSettings.get('enableVP9');
    const enableVP9 = vp9Setting === 'enable' ? true : vp9Setting === 'disable' ? false : caps.vp9;

    // Hybrid HDR: Default to hardware capability unless the user explicitly flipped the setting
    const hdrSetting = PlayerSettings.get('enableHDR');
    const enableHDR = hdrSetting === 'enable' ? true : hdrSetting === 'disable' ? false : !!caps.hdr10;

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

    const dtsSetting = PlayerSettings.get('enableDts');
    const enableDts = dtsSetting === 'enable' ? true : dtsSetting === 'disable' ? false : caps.dts;

    const trueHdSetting = PlayerSettings.get('enableTrueHd');
    const enableTrueHd = trueHdSetting === 'enable' ? true : trueHdSetting === 'disable' ? false : caps.truehd;

    // Standard web audio. Place EAC3 and AC3 first so they are preferred
    // over AAC in the DirectPlay lists when supported or force-enabled.
    const audioCodecs = [];
    if (caps.eac3) audioCodecs.push('eac3');
    if (caps.ac3) audioCodecs.push('ac3');
    audioCodecs.push('aac', 'mp3');
    if (caps.mp2) audioCodecs.push('mp2');
    audioCodecs.push('flac', 'opus', 'vorbis', 'pcm', 'wav');
    if (enableDts) audioCodecs.push('dts', 'dca');
    if (enableTrueHd) audioCodecs.push('truehd');

    const audioCodecString = audioCodecs.join(',');

    const generalVideoCodecs = ['h264'];
    if (enableHEVC) generalVideoCodecs.push('hevc');
    if (enableVP9) generalVideoCodecs.push('vp9');
    if (caps.vp8) generalVideoCodecs.push('vp8');
    if (enableAV1) generalVideoCodecs.push('av1');
    if (caps.mpeg2video) generalVideoCodecs.push('mpeg2video');

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

        // Add TS/MPEGTS DirectPlay profile if natively supported by the browser (e.g. Safari, Smart TVs)
        if (caps.mpegts) {
            directPlayProfiles.push({
                Container: 'ts,mpegts',
                Type: 'Video',
                VideoCodec: generalVideoCodecs.join(','),
                AudioCodec: audioCodecString
            });
        }

        directPlayProfiles.push({
            Container: 'mp3,flac,aac,m4a,m4b,ogg,opus,wav,wma,webma',
            Type: 'Audio',
            AudioCodec: audioCodecString
        });
    }

    // -------------------------------------------------------------------------
    // HLS transcode audio codec selection.
    //
    // Uses the user's preferred transcode audio codec setting. The preferred
    // codec is placed first so the Jellyfin server selects it when evaluating
    // supported codecs. AAC is always retained as an inner fallback.
    //
    // Note: for the Web/HTML5 profile, AC3/EAC3 are only used here if the
    // effective caps value is true (which already accounts for the force-state
    // override applied in getDeviceCapabilities()). This prevents the server
    // from transcoding to a codec the player truly cannot handle.
    // -------------------------------------------------------------------------
    const preferredTranscodeCodec = PlayerSettings.get('transcodeAudioCodec') || 'auto';
    const transAudioCodecsArr = [];

    if (preferredTranscodeCodec === 'auto') {
        // Auto (Prefer E-AC3)
        if (caps.eac3) transAudioCodecsArr.push('eac3');
        if (caps.ac3) transAudioCodecsArr.push('ac3');
        transAudioCodecsArr.push('aac');
    } else if (preferredTranscodeCodec === 'prefer_ac3') {
        // Prefer AC3
        if (caps.ac3) transAudioCodecsArr.push('ac3');
        if (caps.eac3) transAudioCodecsArr.push('eac3');
        transAudioCodecsArr.push('aac');
    } else if (preferredTranscodeCodec === 'prefer_aac') {
        // Prefer AAC
        transAudioCodecsArr.push('aac');
        if (caps.eac3) transAudioCodecsArr.push('eac3');
        if (caps.ac3) transAudioCodecsArr.push('ac3');
    } else if (preferredTranscodeCodec === 'force_eac3') {
        // Only E-AC3
        transAudioCodecsArr.push('eac3');
    } else if (preferredTranscodeCodec === 'force_ac3') {
        // Only AC3
        transAudioCodecsArr.push('ac3');
    } else if (preferredTranscodeCodec === 'force_mp3') {
        // Only MP3
        transAudioCodecsArr.push('mp3');    
    } else {
        // Only AAC (force_aac)
        transAudioCodecsArr.push('aac');
    }

    let transVideoCodecs = enableHEVC ? 'h264,hevc' : 'h264';
    if (caps.mpeg2video) transVideoCodecs += ',mpeg2video';

    if (playbackMode === 'remux') {
        // Keep the custom resolved transcode audio codec list so that the server
        // transcodes the audio to the user's preferred target codec (e.g. EAC3)
        // instead of falling back to default browser codecs in audioCodecString.
        transVideoCodecs = generalVideoCodecs.join(',');
    }

    const broadTransVideo = [transVideoCodecs, enableAV1 ? 'av1' : '', enableVP9 ? 'vp9' : '']
        .filter(Boolean)
        .join(',');

    const transcodingProfiles = [];

    // Primary HLS video transcoding profile (one for each codec in transAudioCodecsArr)
    for (const audioCodec of transAudioCodecsArr) {
        transcodingProfiles.push({
            Container: 'mp4',
            Type: 'Video',
            AudioCodec: audioCodec,
            VideoCodec: broadTransVideo,
            Context: 'Streaming',
            Protocol: 'hls',
            MaxAudioChannels: maxAudioChannels,
            MinSegments: '2',
            SegmentLength: String(PlayerSettings.get('html5SegmentLength') || 2),
            BreakOnNonKeyFrames: playbackMode !== 'remux'
        });
    }

    // Secondary HLS video transcoding profile (one for each codec in transAudioCodecsArr)
    for (const audioCodec of transAudioCodecsArr) {
        transcodingProfiles.push({
            Container: 'ts',
            Type: 'Video',
            AudioCodec: audioCodec,
            VideoCodec: transVideoCodecs,
            Context: 'Streaming',
            Protocol: 'hls',
            MaxAudioChannels: maxAudioChannels,
            MinSegments: '2',
            SegmentLength: String(PlayerSettings.get('html5SegmentLength') || 2),
            BreakOnNonKeyFrames: playbackMode !== 'remux'
        });
    }

    // Pure Audio transcoding profiles
    transcodingProfiles.push(
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
    );

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
                    Value: '10',
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
                    Value: 'profile 0|profile 2',
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
                    Value: '10',
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
