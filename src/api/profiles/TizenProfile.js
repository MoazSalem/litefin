/**
 * ============================================================================
 * Litefin Tizen — Tizen Device Profile
 * ============================================================================
 * Tizen-specific capability detection and Jellyfin profile generation.
 * ============================================================================
 */

import { logger } from '../../utils/Logger.js';
import { PlayerSettings } from '../../utils/PlayerSettings.js';
import { BaseProfile } from './BaseProfile.js';

const log = logger.create('TizenProfile');

let _cachedCapabilities = null;
let _cachedModelName = null;

function _getModelName() {
    if (_cachedModelName) return _cachedModelName;

    if (typeof tizen !== 'undefined' && tizen.systeminfo) {
        try {
            _cachedModelName = tizen.systeminfo.getCapability('http://tizen.org/system/model_name') || '';
        } catch (e) {
            log.warn('Could not get model name from systeminfo:', e.message);
        }
    }

    return _cachedModelName || 'Samsung TV';
}

export function detectTizenVersion() {
    if (typeof tizen !== 'undefined' && tizen.systeminfo) {
        try {
            const platformVersion = tizen.systeminfo.getCapability('http://tizen.org/feature/platform.version');
            if (platformVersion) {
                const ver = parseFloat(platformVersion);
                if (!isNaN(ver) && ver >= 2) {
                    return ver;
                }
            }
        } catch (e) {
            // ignore
        }
    }
    return 4; // Safe default
}

export function getDeviceCapabilities() {
    if (_cachedCapabilities) return _cachedCapabilities;

    const tizenVersion = detectTizenVersion();
    const modelName = _getModelName();

    const MODEL_8K = ['QN990', 'QN900', 'QN800', 'QN700', 'Q950', 'Q900', 'Q800'];
    const MODEL_FHD = ['T5300', 'N5200', 'Q50A', '32LS03', 'H5000', 'F6000', 'J6200', 'J5200', 'M5500'];
    const MODEL_HD = ['N5300', 'H5000F', 'N4300', 'T4300', 'N4000', 'T4000', 'J4000'];

    const is8K = MODEL_8K.some((m) => modelName.includes(m));
    const isFHD = MODEL_FHD.some((m) => modelName.includes(m));
    const isHD = MODEL_HD.some((m) => modelName.includes(m));

    let uhd = true;
    let uhd8K = false;

    if (is8K) {
        uhd8K = true;
    } else if (isFHD || isHD) {
        uhd = false;
    }

    const hdr10 = tizenVersion >= 4 && uhd;

    let deviceId = '';
    if (typeof tizen !== 'undefined' && tizen.systeminfo) {
        try {
            deviceId = tizen.systeminfo.getCapability('http://tizen.org/system/tizenid') || '';
        } catch (e) {}
    }

    if (!deviceId) {
        deviceId = BaseProfile.getFallbackDeviceId('litefin_tizen_');
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
        tizenVersion,
        screenWidth: uhd8K ? 7680 : uhd ? 3840 : 1920,
        screenHeight: uhd8K ? 4320 : uhd ? 2160 : 1080,
        uhd,
        uhd8K,
        hdr10,
        hdr10Plus: hdr10 && tizenVersion >= 5,
        hlg: hdr10 && tizenVersion >= 4,
        dolbyVision: false, // Tizen generally does not support Dolby Vision natively
        hevc: true, // Tizen 4+
        av1: tizenVersion >= 5.5,
        vp9: tizenVersion >= 6 || (tizenVersion >= 4 && uhd),
        vp8: true,
        ac3: true,
        eac3: true,
        dts: tizenVersion < 4, // Samsung dropped DTS in 2018 (Tizen 4.0)
        truehd: false,
        maxAudioChannels: uhd8K ? 8 : 6
    };

    log.info('Tizen capabilities:', JSON.stringify(_cachedCapabilities, null, 2));
    return _cachedCapabilities;
}

export function clearCapabilitiesCache() {
    _cachedCapabilities = null;
    _cachedModelName = null;
}

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
        SubtitleProfiles: BaseProfile.getSubtitleProfiles(),
        ResponseProfiles: []
    };
}

export function buildJellyfinProfile(options = {}) {
    const manualBitrateOverride = typeof options === 'number' ? options : options.manualBitrate;
    const playbackMode = typeof options === 'object' ? options.playbackMode || 'auto' : 'auto';
    const isHtml5 = typeof options === 'object' && options.backend === 'html5';

    const caps = getDeviceCapabilities();

    const enableHEVC = PlayerSettings.get('enableHEVC') && caps.hevc;
    const enableAV1 = PlayerSettings.get('enableAV1') && caps.av1;
    const enableVP9 = PlayerSettings.get('enableVP9') && caps.vp9;
    const enableHDR = PlayerSettings.get('enableHDR') && caps.hdr10;
    const enableDts = PlayerSettings.get('enableDts');
    const enableTrueHd = PlayerSettings.get('enableTrueHd');

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

    const audioCodecs = ['aac', 'mp3', 'flac', 'opus', 'vorbis', 'pcm', 'wav', 'pcm_s16le', 'pcm_s24le', 'aac_latm'];
    if (caps.ac3) audioCodecs.push('ac3');
    if (caps.eac3) audioCodecs.push('eac3');
    if (caps.tizenVersion >= 6.5) audioCodecs.push('ac4');
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
        // Standard Web formats (MP4, MKV, WebM)
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

        // Add HLS as a DirectPlay profile to encourage the server to Direct Stream (Remux)
        // for HLS sources, which is much more reliable on HTML5 players.
        directPlayProfiles.push({
            Container: 'hls',
            Type: 'Video',
            VideoCodec: generalVideoCodecs.join(','),
            AudioCodec: audioCodecString
        });

        // AVPlay handles many legacy containers natively
        if (!isHtml5) {
            directPlayProfiles.push({
                Container: 'asf',
                Type: 'Video',
                AudioCodec: audioCodecString
            });
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
        }

        directPlayProfiles.push({
            Container: 'mp3,flac,aac,m4a,m4b,ogg,opus,wav,wma,webma',
            Type: 'Audio',
            AudioCodec: audioCodecString
        });
    }

    // Tizen AVPlay frequently crashes or fails to prepareAsync when attempting to play
    // HLS Fragmented MP4 (fMP4) streams that contain AC3 or EAC3 audio tracks.
    // To ensure stable playback when audio MUST be transcoded (e.g. from DTS),
    // we restrict the transcoding audio codec exclusively to AAC, which is fully supported.
    // However, for DirectStream (progressive mp4 Remux), we safely allow native AC3/EAC3 capability.
    let transAudioCodecs = 'aac';
    let directAudioCodecs = 'aac,ac3,eac3,mp3';

    let transVideoCodecs = enableHEVC ? 'h264,hevc' : 'h264';
    let directVideoCodecs = enableHEVC ? 'h264,hevc' : 'h264';

    if (playbackMode === 'remux') {
        transAudioCodecs = audioCodecString;
        directAudioCodecs = audioCodecString;

        const allVideo = new Set([...generalVideoCodecs, ...mkvVideoCodecs, ...tsVideoCodecs]);
        transVideoCodecs = Array.from(allVideo).join(',');
        directVideoCodecs = transVideoCodecs;
    }

    const transcodingProfiles = [
        {
            Container: 'ts',
            Type: 'Video',
            AudioCodec: transAudioCodecs,
            VideoCodec: transVideoCodecs, // ts container only safely supports h264/hevc
            Context: 'Streaming',
            Protocol: 'hls',
            MaxAudioChannels: maxAudioChannels,
            MinSegments: isHtml5 ? '1' : '2',
            SegmentLength: isHtml5 ? '2' : '6',
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
            Container: caps.tizenVersion >= 5 ? 'opus' : 'mp3',
            Type: 'Audio',
            AudioCodec: caps.tizenVersion >= 5 ? 'opus' : 'mp3',
            Context: 'Streaming',
            Protocol: 'http'
        },
        {
            Container: 'mp4',
            Type: 'Video',
            AudioCodec: transAudioCodecs,
            VideoCodec: transVideoCodecs,
            Context: 'Streaming',
            Protocol: 'http'
        }
        // Removed MKV and MP4 Static containers from TranscodingProfiles
        // to force the server to always use HLS (segmented) streaming
        // instead of progressive HTTP streams for transcodes,
        // which Tizen AVPlay cannot reliably parse.
    ];

    const h264Level = caps.uhd ? '51' : caps.tizenVersion >= 5 ? '52' : caps.tizenVersion >= 4 ? '42' : '41';
    const hevcLevel = caps.uhd8K ? '183' : caps.uhd ? '153' : '150'; // Standardize to 5.0 fallback for HEVC

    const hdrCondition = !enableHDR
        ? [{ Condition: 'EqualsAny', Property: 'VideoRangeType', Value: 'SDR', IsRequired: false }]
        : [];

    // Samsung TVs can play the HDR10/HDR10+ fallback of Dolby Vision Profile 7/8.
    // DOVIWithHDR10Plus is a distinct type from DOVIWithHDR10 and must be listed separately —
    // Jellyfin reports these based on the actual base layer of the encode, not just the DV type.
    const hevcVideoRangeTypes = enableHDR
        ? 'SDR|HDR10|HDR10Plus|HLG|DOVI|DOVIWithHDR10|DOVIWithHDR10Plus|DOVIWithHLG|DOVIWithSDR'
        : 'SDR|DOVIWithSDR';

    const codecProfiles = [
        {
            Type: 'Video',
            Codec: 'h264',
            Conditions: [
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

    // Explicitly force transcoding of DTS/TrueHD tracks if the user
    // has disabled passthrough for them.
    if (!enableDts) {
        codecProfiles.push({
            Type: 'Audio',
            Codec: 'dts,dca,dts-hd,dts-ma,dts-x',
            Conditions: [{ Condition: 'Equals', Property: 'IsSecondaryAudio', Value: 'false', IsRequired: false }]
        });
    }
    if (!enableTrueHd) {
        codecProfiles.push({
            Type: 'Audio',
            Codec: 'truehd',
            Conditions: [{ Condition: 'Equals', Property: 'IsSecondaryAudio', Value: 'false', IsRequired: false }]
        });
    }

    if (enableHEVC) {
        codecProfiles.push({
            Type: 'Video',
            Codec: 'hevc',
            Conditions: [
                { Condition: 'EqualsAny', Property: 'VideoProfile', Value: 'main|main 10', IsRequired: false },
                {
                    Condition: 'EqualsAny',
                    Property: 'VideoRangeType',
                    Value: hevcVideoRangeTypes,
                    IsRequired: false
                },
                { Condition: 'LessThanEqual', Property: 'VideoLevel', Value: hevcLevel, IsRequired: false },
                { Condition: 'LessThanEqual', Property: 'VideoBitDepth', Value: '10', IsRequired: false }
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

    // DirectStreamProfiles governs what containers Jellyfin is allowed to use when copying
    // the video stream while transcoding the audio stream. If not provided, Jellyfin guesses
    // based on DirectPlayProfiles (e.g. outputting a progressive MKV HTTP stream), which
    // crashes Tizen AVPlay. We force DirectStream progressive remuxes into stable MP4 containers.
    const directStreamProfiles = [
        {
            Container: 'mp4',
            Type: 'Video',
            VideoCodec: [directVideoCodecs, enableAV1 ? 'av1' : '', enableVP9 ? 'vp9' : ''].filter(Boolean).join(','),
            AudioCodec: directAudioCodecs
        }
    ];

    return {
        Name: `Litefin Tizen ${caps.tizenVersion}${isHtml5 ? ' (HTML5)' : ''}${playbackMode !== 'auto' ? ` (${playbackMode})` : ''}`,
        MaxStreamingBitrate: maxBitrate,
        MaxStaticBitrate: maxBitrate,
        MaxStaticMusicBitrate: 40000000,
        MusicStreamingTranscodingBitrate: 384000,
        EnableSubtitlesInManifest: true,
        DirectPlayProfiles: directPlayProfiles,
        DirectStreamProfiles: directStreamProfiles,
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
    return caps.modelName || `Samsung TV Tizen ${caps.tizenVersion}`;
}
