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
import { webosAdapter } from '../../webos/WebOSAdapter.js';

const log = logger.create('WebOSProfile');

let _cachedCapabilities = null;
let _codecCache = null;

/**
 * Probes the actual decoder pipeline using both MSE and native
 * HTML5 <video> canPlayType. This covers both native and HLS playback paths.
 * @param {string} mime - Mime type string with codec parameters
 * @returns {boolean}
 */
function supportsCodec(mime) {
    try {
        let isSupported = false;

        // Check MediaSource (MSE pipeline used by Hls.js)
        if (typeof window.MediaSource !== 'undefined' && typeof window.MediaSource.isTypeSupported === 'function') {
            if (window.MediaSource.isTypeSupported(mime)) {
                isSupported = true;
            }
        }

        // Check Native <video> decoder (DirectPlay pipeline)
        if (!isSupported) {
            const video = document.createElement('video');
            isSupported = video.canPlayType(mime) !== '';
        }

        return isSupported;
    } catch (e) {
        return false;
    }
}

/**
 * Returns a cached object of probed codec results.
 * @returns {Object}
 */
function getProbedCodecs() {
    if (_codecCache) return _codecCache;

    const v = document.createElement('video');

    _codecCache = {
        // Broaden HEVC detection with multiple variants (fragmented, regular, and generic strings)
        hevc:
            supportsCodec('video/mp4; codecs="hev1.1.6.L93.B0"') ||
            supportsCodec('video/mp4; codecs="hvc1.1.6.L93.B0"') ||
            supportsCodec('video/mp4; codecs="hvc1"') ||
            supportsCodec('video/mp4; codecs="hev1"'),

        // Some TVs only support VP9 in WebM, others in MP4
        vp9: supportsCodec('video/webm; codecs="vp9"') || supportsCodec('video/mp4; codecs="vp09.00.10.08"'),

        // AV1 typically only on WebOS 6+ (O7, G1, C1 etc.)
        av1: supportsCodec('video/mp4; codecs="av01.0.05M.08"') || supportsCodec('video/webm; codecs="av1"'),

        // Probe for 10-bit HEVC support as a proxy for HDR10 with multiple level/string variants
        hdr10:
            supportsCodec('video/mp4; codecs="hev1.2.4.L153.B0"') ||
            supportsCodec('video/mp4; codecs="hvc1.2.4.L153.B0"') ||
            supportsCodec('video/mp4; codecs="hev1.2.4.L120.B0"') ||
            supportsCodec('video/mp4; codecs="hvc1.2.4.L120.B0"'),

        ac3: v.canPlayType('audio/mp4; codecs="ac-3"') !== '',
        eac3: v.canPlayType('audio/mp4; codecs="ec-3"') !== ''
    };

    return _codecCache;
}

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

// Max audio channels — default to 6 for surround support on TV hardware
const DEFAULT_MAX_CHANNELS = 6;

export function getDeviceCapabilities() {
    if (_cachedCapabilities) return _cachedCapabilities;

    // ------------------------------------------------------------------------
    // Safe Defaults for Smart TVs
    // Defaulting to UHD and HDR10 support is safer for Smart TVs to avoid
    // unnecessary transcoding of 4K/HDR content on initial load.
    // ------------------------------------------------------------------------
    let uhd = true;
    let uhd8K = false;
    let dolbyVision = false;

    const deviceId = BaseProfile.getFallbackDeviceId('litefin_webos_');
    let modelName = 'LG WebOS TV';

    const webosVersion = getWebOSVersion();

    // ------------------------------------------------------------------------
    // Sync Device Info
    // Check webosAdapter first — it may have already loaded device info
    // asynchronously during app startup.
    // ------------------------------------------------------------------------
    const info = webosAdapter.deviceInfo;
    if (info) {
        log.debug('WebOSProfile: Using cached webosAdapter deviceInfo');
        if (info.modelName) modelName = info.modelName;
        if (info.uhd) uhd = info.uhd === 'true';
        if (info['8k']) uhd8K = info['8k'] === 'true';
        if (uhd) {
            if (info.dolbyVision === 'true') dolbyVision = true;
        }
    } else if (typeof window.webOS !== 'undefined' && window.webOS.deviceInfo) {
        // Fallback: Fire off the async call for the next profile build
        window.webOS.deviceInfo((res) => {
            log.info('WebOSProfile: Async deviceInfo received, clearing cache');
            clearCapabilitiesCache();
        });
    }

    const codecs = getProbedCodecs();
    const hevc = codecs.hevc;
    const av1 = codecs.av1;
    const vp9 = codecs.vp9;

    // Use probed HDR10 support, but allow device info to override if present
    let hdr10 = codecs.hdr10;
    if (info && info.hdr10) {
        hdr10 = info.hdr10 === 'true';
    }

    const ac3 = codecs.ac3;
    const eac3 = codecs.eac3;

    // LG disabled DTS support on WebOS 5.0 through 22 (2020-2022 models)
    const dts = !(webosVersion >= 5 && webosVersion < 23);

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

    const caps = {
        modelName,
        deviceId,
        webosVersion,
        screenWidth: uhd8K ? 7680 : uhd ? 3840 : 1920,
        screenHeight: uhd8K ? 4320 : uhd ? 2160 : 1080,
        uhd,
        uhd8K,
        hdr10,
        hdr10Plus: false,
        hlg: hdr10,
        dolbyVision,
        hevc,
        av1,
        vp9,
        vp8: true,
        ac3,
        eac3,
        dts,
        truehd: false,
        maxAudioChannels: DEFAULT_MAX_CHANNELS
    };

    log.info('WebOS capabilities:', JSON.stringify(caps, null, 2));
    _cachedCapabilities = caps;

    return caps;
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

    /*
     * Backend awareness: 'webos' = native WebOSPlayer (hardware decode via <video>),
     * 'html5' = fallback HtmlVideoPlayer using Hls.js.
     *
     * The two backends have different capabilities:
     *   webos  - can hardware-decode TS/M2TS/AVI/WMV/legacy containers via the
     *            native media pipeline. Prefers larger HLS segments for stability.
     *   html5  - Hls.js can only reliably handle MP4/MKV/WebM. Needs smaller
     *            segments for faster startup and Hls.js buffer recovery.
     *
     * This mirrors the pattern in TizenProfile.js (isHtml5 flag).
     */
    const isHtml5 = typeof options === 'object' && options.backend === 'html5';
    const caps = getDeviceCapabilities();

    const enableHEVC = PlayerSettings.get('enableHEVC') && caps.hevc;
    const enableAV1 = PlayerSettings.get('enableAV1') && caps.av1;
    const enableVP9 = PlayerSettings.get('enableVP9') && caps.vp9;
    const enableHDR = PlayerSettings.get('enableHDR') && caps.hdr10;
    const enableDolbyVision = PlayerSettings.get('enableDolbyVision') && caps.dolbyVision;
    const enableDts = PlayerSettings.get('enableDts');
    const enableTrueHd = PlayerSettings.get('enableTrueHd');

    log.info('Evaluation flags:', {
        isHtml5,
        playbackMode,
        enableHEVC,
        enableAV1,
        enableVP9,
        enableHDR,
        enableDolbyVision,
        enableDts,
        enableTrueHd
    });

    if (PlayerSettings.get('forceTranscode') || playbackMode === 'transcode') {
        return _buildMinimalProfile(caps);
    }

    // Cap bitrate for TVs to prevent buffer stalls on high-bitrate remuxes.
    // 80 Mbps is a safe ceiling for most Smart TV decoders.
    let maxBitrate =
        manualBitrateOverride || PlayerSettings.get('maxBitrateInternet') || (caps.uhd ? 80000000 : 40000000);
    if (maxBitrate > 80000000) {
        maxBitrate = 80000000;
    }
    if (!caps.uhd && maxBitrate > 40000000) {
        maxBitrate = 40000000;
    }

    const maxAudioChannels = String(caps.maxAudioChannels);
    const supportsFmp4Hls = caps.webosVersion >= 4; // WebOS 3.5 (some models) and 4.0+ support fMP4 HLS

    const audioCodecs = ['aac', 'mp3', 'flac', 'vorbis', 'pcm', 'wav', 'pcm_s16le', 'pcm_s24le', 'aac_latm'];
    if (caps.webosVersion >= 4) {
        audioCodecs.push('opus');
    }
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
    // AV1 in MPEG-TS is not supported on WebOS

    const m2tsVideoCodecs = ['h264', 'vc1', 'mpeg2video'];

    const directPlayProfiles = [];

    if (playbackMode !== 'transcode' && playbackMode !== 'remux') {
        // Standard web containers — available on both backends
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

        /*
         * Extended container support — only the native WebOS backend (WebOSPlayer) can
         * reliably direct-play these containers. The HTML5 fallback (Hls.js) cannot
         * handle TS/M2TS/AVI/WMV natively and would fail silently or stall.
         * By gating these profiles on the native backend, we ensure that a library of
         * Blu-ray rips (M2TS), DVB recordings (TS), or legacy AVI/WMV files direct-play
         * on real WebOS hardware rather than triggering an unnecessary transcode.
         */
        if (!isHtml5) {
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
                VideoCodec: 'h264,mpeg2video',
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

    let transAudioCodecs = caps.ac3 ? 'aac,ac3,eac3' : 'aac';
    let transVideoCodecs = enableHEVC ? 'h264,hevc' : 'h264';

    if (playbackMode === 'remux') {
        transAudioCodecs = 'copy';
        transVideoCodecs = 'copy';
    }

    const transcodingProfiles = [
        {
            /*
             * Primary HLS video transcoding profile.
             *
             * Segment sizing strategy:
             *   webos  (native) — larger segments (4s) reduce the number of HTTP round-trips
             *            and give the hardware decoder more headroom for smooth playback.
             *   html5  (Hls.js) — smaller segments (2s) enable faster startup and allow
             *            Hls.js to recover from network blips more quickly.
             */
            Container: 'ts',
            Type: 'Video',
            AudioCodec: transAudioCodecs,
            VideoCodec: transVideoCodecs,
            Context: 'Streaming',
            Protocol: 'hls',
            MaxAudioChannels: maxAudioChannels,
            MinSegments: '1',
            SegmentLength: '2',
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

    // fMP4 HLS as a secondary option for devices that support it (WebOS 4+).
    // Apply the same per-backend segment sizing as the primary TS profile above.
    if (supportsFmp4Hls) {
        transcodingProfiles.push({
            Container: 'mp4',
            Type: 'Video',
            AudioCodec: transAudioCodecs,
            VideoCodec: transVideoCodecs,
            Context: 'Streaming',
            Protocol: 'hls',
            MaxAudioChannels: maxAudioChannels,
            MinSegments: '1',
            SegmentLength: '2',
            BreakOnNonKeyFrames: false
        });
    }

    // H.264 levels: 5.1 for UHD, 4.1 for 1080p
    const h264Level = caps.uhd ? '51' : '41';

    // HEVC levels: 5.1 for UHD, 4.0 for 1080p (Safe default)

    const hdrCondition = !enableHDR
        ? [{ Condition: 'EqualsAny', Property: 'VideoRangeType', Value: 'SDR', IsRequired: false }]
        : [];

    // We no longer strictly ban DOVI if enableDolbyVision is false because DOVI Profile 7/8
    // contains an HDR10 baselayer that most HDR10 TVs can play natively.
    // If the file is strictly Profile 5, it will play with wrong colors, but
    // transcoding 4K HEVC Profile 5 usually requires significant server power anyway.

    const codecProfiles = [
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
                {
                    Condition: 'EqualsAny',
                    Property: 'VideoProfile',
                    Value: caps.uhd || caps.hdr10 ? 'main|main 10' : 'main',
                    IsRequired: false
                },
                {
                    Condition: 'LessThanEqual',
                    Property: 'VideoBitDepth',
                    Value: caps.uhd || caps.hdr10 ? '10' : '8',
                    IsRequired: false
                },
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
                    Value: caps.uhd || caps.hdr10 ? 'profile 0|profile 2' : 'profile 0',
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

    // WebOS natively fails to decode FLAC with more than 2 channels
    codecProfiles.push({
        Type: 'VideoAudio',
        Codec: 'flac',
        Conditions: [{ Condition: 'LessThanEqual', Property: 'AudioChannels', Value: '2', IsRequired: false }]
    });
    codecProfiles.push({
        Type: 'Audio',
        Codec: 'flac',
        Conditions: [{ Condition: 'LessThanEqual', Property: 'AudioChannels', Value: '2', IsRequired: false }]
    });

    return {
        Name: `Litefin WebOS${isHtml5 ? ' (HTML5)' : ''}${playbackMode !== 'auto' ? ` (${playbackMode})` : ''}`,
        MaxStreamingBitrate: maxBitrate,
        MaxStaticBitrate: maxBitrate,
        MaxStaticMusicBitrate: 40000000,
        MusicStreamingTranscodingBitrate: 384000,
        DirectPlayProfiles: directPlayProfiles,
        TranscodingProfiles: transcodingProfiles,
        CodecProfiles: codecProfiles,
        SubtitleProfiles: BaseProfile.getSubtitleProfiles(),
        ResponseProfiles: [
            {
                Container: 'mkv',
                Type: 'Video',
                Conditions: [
                    {
                        Condition: 'EqualsAny',
                        Property: 'VideoCodec',
                        Value: 'hevc,h264'
                    }
                ],
                Action: 'Remux',
                ContainerOverride: 'mp4'
            },
            ...BaseProfile.getResponseProfiles()
        ]
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
