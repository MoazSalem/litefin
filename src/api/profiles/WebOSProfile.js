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

        // Check Native <video> decoder FIRST (DirectPlay pipeline uses this)
        const video = document.createElement('video');
        isSupported = video.canPlayType(mime) !== '';

        // Check MediaSource as fallback (MSE pipeline used by Hls.js)
        // Some older WebOS versions return false in MSE even when Native succeeds
        if (
            !isSupported &&
            typeof window.MediaSource !== 'undefined' &&
            typeof window.MediaSource.isTypeSupported === 'function'
        ) {
            if (window.MediaSource.isTypeSupported(mime)) {
                isSupported = true;
            }
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

    if (versionMajor >= 120) return 25; // Estimate for WebOS 25
    if (versionMajor >= 108) return 24;
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
    // ------------------------------------------------------------------------
    // Conservatively determine 4K screens based on viewport if the OS hasn't reported it yet.
    // Assuming uhd = true globally causes 1080p TVs to fail on playback bounds.
    let uhd = window.screen.width >= 3840 || window.innerHeight >= 2160;
    let uhd8K = false;
    let dolbyVision = false;

    const deviceId = BaseProfile.getFallbackDeviceId('litefin_webos_');
    let modelName = 'LG WebOS TV';

    const webosVersion = getWebOSVersion();

    // ------------------------------------------------------------------------
    // Sync Device Info
    // ------------------------------------------------------------------------
    let hdr10Hw = null;
    let screenWidthHw = null;
    let screenHeightHw = null;

    const info = webosAdapter.deviceInfo;
    if (info) {
        log.debug('WebOSProfile: Using cached webosAdapter deviceInfo');
        if (info.modelName) modelName = info.modelName;
        if (info.uhd !== undefined) uhd = info.uhd === true || info.uhd === 'true';
        if (info.uhd8K !== undefined) uhd8K = info.uhd8K === true || info.uhd8K === 'true';
        if (info['8k'] !== undefined) uhd8K = info['8k'] === true || info['8k'] === 'true';
        if (info.dolbyVision !== undefined) dolbyVision = info.dolbyVision === true || info.dolbyVision === 'true';
        if (info.hdr10 !== undefined) hdr10Hw = info.hdr10 === true || info.hdr10 === 'true';
        if (info.screenWidth) screenWidthHw = parseInt(info.screenWidth, 10);
        if (info.screenHeight) screenHeightHw = parseInt(info.screenHeight, 10);
    } else if (typeof window.webOS !== 'undefined' && window.webOS.deviceInfo) {
        window.webOS.deviceInfo((res) => {
            log.info('WebOSProfile: Async deviceInfo received, clearing cache');
            clearCapabilitiesCache();
        });
    }

    const codecs = getProbedCodecs();

    // HEVC: Always trust TV to support HEVC unless explicitly denied by device info
    let hevc = true;
    if (info && info.hevc !== undefined) {
        hevc = info.hevc === true || info.hevc === 'true';
    }

    // HDR10: Use WebOS Adapter's detected hardware value if available.
    // Otherwise rely strictly on the UHD detection. MSE probing natively fails across WebOS.
    const hdr10 = hdr10Hw !== null ? hdr10Hw : uhd;

    // AV1 and VP9: MSE probing natively fails on early WebOS but hardware decodes them securely.
    // WebOS 6+ natively supports AV1. VP9 is generally safe globally on WebOS 4+.
    const vp9 = true;
    const av1 = webosVersion >= 6;

    const ac3 = codecs.ac3;
    const eac3 = codecs.eac3;

    // LG disabled DTS decode support on WebOS 5.0 through 22, however, TVs can
    // still pass-through DTS over eARC. Delegate this capability directly to the user's
    // settings toggle, rather than hardcoding it to true or false.
    const dts = PlayerSettings.get('enableDts') === true;

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
        screenWidth: screenWidthHw || (uhd8K ? 7680 : uhd ? 3840 : 1920),
        screenHeight: screenHeightHw || (uhd8K ? 4320 : uhd ? 2160 : 1080),
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
                // Integer fields — Jellyfin TranscodingProfileDto schema is strict
                // (MaxAudioChannels, MinSegments, SegmentLength must be numbers, not strings)
                MaxAudioChannels: caps.maxAudioChannels,
                MinSegments: 1,
                SegmentLength: 3,
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

    let enableHEVC = PlayerSettings.get('enableHEVC');
    if (localStorage.getItem('player:enableHEVC') === null) enableHEVC = caps.hevc;

    let enableAV1 = PlayerSettings.get('enableAV1');
    if (localStorage.getItem('player:enableAV1') === null) enableAV1 = caps.av1;

    let enableVP9 = PlayerSettings.get('enableVP9');
    if (localStorage.getItem('player:enableVP9') === null) enableVP9 = caps.vp9;

    // Hybrid HDR: Default to hardware capability unless the user explicitly flipped the setting
    let enableHDR = PlayerSettings.get('enableHDR');
    if (localStorage.getItem('player:enableHDR') === null) {
        enableHDR = caps.hdr10;
    }

    // Hybrid Dolby Vision: Default to hardware capability unless the user explicitly flipped the setting
    let enableDolbyVision = PlayerSettings.get('enableDolbyVision');
    if (localStorage.getItem('player:enableDolbyVision') === null) {
        enableDolbyVision = caps.dolbyVision;
    }
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

    // Keep as integer — the Jellyfin server TranscodingProfileDto schema expects
    // MaxAudioChannels, MinSegments and SegmentLength to be integers, not strings.
    // Sending a string (e.g. "6") triggers a JSON-schema validation 400 Bad Request
    // on strict server versions.
    const maxAudioChannels = caps.maxAudioChannels;

    // ProfileCondition.Value is always a string in Jellyfin's schema, so we keep
    // a separate string-form for use inside CodecProfile condition objects.
    const maxAudioChannelsStr = String(caps.maxAudioChannels);

    // -------------------------------------------------------------------------
    // fMP4 HLS preference resolution
    // -------------------------------------------------------------------------
    // enableFmp4HlsContainer = master toggle (default on).
    // forceFmp4HlsContainer  = bypass the webosVersion >= 6 hardware gate and
    //                          promote fMP4 to the primary HLS transcode.
    const enableFmp4Hls = PlayerSettings.get('enableFmp4HlsContainer');
    const forceFmp4Hls = enableFmp4Hls && PlayerSettings.get('forceFmp4HlsContainer');

    // Hardware version gate: WebOS < 6 frequently stutters on fMP4 HLS chunks.
    // The force flag overrides this gate when the user explicitly enables it.
    const supportsFmp4Hls = enableFmp4Hls && (forceFmp4Hls || caps.webosVersion >= 6);

    // Dolby Vision HEVC content MUST travel in an fMP4 HLS stream.
    // MPEG-TS cannot carry the DOVI RPU metadata layer correctly, and WebOS
    // will silently strip it, producing broken colours or a hard crash.
    // We auto-promote to fMP4 here regardless of user settings or version gates.
    const shouldForceFmp4ForDovi = enableDolbyVision && enableHEVC;

    // When fMP4 is forced (user setting OR DOVI mandate), it becomes the PRIMARY
    // HLS container, replacing TS as the first profile the server picks.
    const primaryHlsContainer = forceFmp4Hls || shouldForceFmp4ForDovi ? 'mp4' : 'ts';

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

    // Always include EAC3 (Dolby Digital Plus) in the safe-to-transmux audio list.
    // TrueHD and DTS can silently block the Dolby Vision decode pipeline on WebOS,
    // so we deliberately omit them here and let the DirectPlay audio profiles handle
    // pass-through when the container allows it.
    let transAudioCodecs = 'aac,ac3,eac3';

    // When Dolby Vision is active we MUST restrict to HEVC only.
    // Leaving h264 in the list gives Jellyfin an escape hatch to fall back to
    // an H.264 transcode, which strips the DOVI layer entirely and produces SDR.
    // For non-DOVI streams, including h264 lets the server choose lightweight
    // H.264 for 1080p content where HEVC is unnecessary overhead.
    let transVideoCodecs = enableHEVC ? (enableDolbyVision ? 'hevc' : 'h264,hevc') : 'h264';

    if (playbackMode === 'remux') {
        transAudioCodecs = 'copy';
        transVideoCodecs = 'copy';
    }

    const transcodingProfiles = [
        {
            /*
             * Primary HLS video transcoding profile.
             *
             * Container selection:
             *   forceFmp4Hls — use fMP4 (mp4) as the primary container. This unlocks
             *     HEVC/AV1 copy-stream remuxing over HLS on devices where fMP4 is
             *     known-good but the hardware version gate would normally block it.
             *   default (no force) — use MPEG-TS, which is the universally safe
             *     container and required for legacy WebOS 4/5 systems.
             *
             * Segment sizing strategy:
             *   webos  (native) — larger segments (4s) reduce HTTP round-trips and
             *            give the hardware decoder more headroom.
             *   html5  (Hls.js) — smaller segments (2s) enable faster startup and
             *            allow Hls.js to recover from network blips more quickly.
             */
            Container: primaryHlsContainer,
            Type: 'Video',
            AudioCodec: transAudioCodecs,
            VideoCodec: transVideoCodecs,
            Context: 'Streaming',
            Protocol: 'hls',
            // Integer fields — Jellyfin TranscodingProfileDto schema is strict
            MaxAudioChannels: maxAudioChannels,
            MinSegments: 1,
            // Dolby Vision RPU metadata must be aligned to IDR keyframe boundaries.
            // A 3 s segment (our new default for standard content) is already safe,
            // but DV needs an extra margin — 4 s guarantees every segment boundary
            // is an IDR frame, preventing RPU orphans that crash the LG decoder.
            SegmentLength: shouldForceFmp4ForDovi ? 4 : 3,
            // fMP4 segments must always be cut on IDR frames; BreakOnNonKeyFrames
            // is only safe for MPEG-TS and only when not in dedicated remux mode.
            BreakOnNonKeyFrames: primaryHlsContainer !== 'mp4' && playbackMode !== 'remux'
        },
        {
            Container: 'aac',
            Type: 'Audio',
            AudioCodec: 'aac',
            Context: 'Streaming',
            Protocol: 'hls',
            MaxAudioChannels: maxAudioChannels,
            MinSegments: 1
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
            AudioCodec: 'aac,ac3,eac3',
            VideoCodec: enableHEVC ? 'h264,hevc' : 'h264',
            Context: 'Static'
        }
    ];

    // -------------------------------------------------------------------------
    // Secondary fMP4 HLS profile
    // -------------------------------------------------------------------------
    // Only added when fMP4 is *supported* but NOT already the primary container.
    // If forceFmp4Hls is true the primary profile above is already mp4, so
    // there is nothing extra to push here — avoid a duplicate.
    if (supportsFmp4Hls && !forceFmp4Hls) {
        transcodingProfiles.push({
            Container: 'mp4',
            Type: 'Video',
            AudioCodec: transAudioCodecs,
            VideoCodec: transVideoCodecs,
            Context: 'Streaming',
            Protocol: 'hls',
            // Integer fields — Jellyfin TranscodingProfileDto schema is strict
            MaxAudioChannels: maxAudioChannels,
            MinSegments: 1,
            SegmentLength: 2,
            // fMP4 segments MUST align to IDR boundaries; never break on subtitle cue points.
            BreakOnNonKeyFrames: false
        });
    }

    // H.264 levels: 5.1 for UHD, 4.1 for 1080p
    const h264Level = caps.uhd ? '51' : '41';

    // We no longer strictly ban DOVI if enableDolbyVision is false because DOVI Profile 7/8
    // contains an HDR10 baselayer that most HDR10 TVs can play natively.
    // If the file is strictly Profile 5, it will play with wrong colors, but
    // transcoding 4K HEVC Profile 5 usually requires significant server power anyway.

    const codecProfiles = [
        {
            Type: 'Video',
            Codec: 'h264',
            Conditions: [{ Condition: 'LessThanEqual', Property: 'VideoLevel', Value: h264Level, IsRequired: false }]
        },
        {
            Type: 'Audio',
            Conditions: [
                {
                    Condition: 'LessThanEqual',
                    Property: 'AudioChannels',
                    // ProfileCondition.Value must be a string in Jellyfin's schema
                    Value: maxAudioChannelsStr,
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
                    Value: enableHDR ? 'main|main 10' : 'main',
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

        // Explicit Dolby Vision encouragement profile.
        // Without this hint, Jellyfin may emit VideoRangeTypeNotSupported and reject
        // the DOVI stream before we even get a chance to remux it. This tells the
        // server "DV is acceptable here" so it proceeds to the CodecProfile / container
        // evaluation step rather than bailing out immediately.
        if (enableDolbyVision) {
            codecProfiles.push({
                Type: 'Video',
                Codec: 'hevc',
                Conditions: [
                    {
                        Condition: 'EqualsAny',
                        Property: 'VideoRangeType',
                        Value: 'DOVI|DOVIWithHDR10|DOVIWithHDR10Plus|DOVIWithHLG|DOVIWithSDR',
                        IsRequired: false
                    }
                ]
            });
        }
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
                }
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
                }
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

    // -------------------------------------------------------------------------
    // Dolby Vision MKV — Force Remux on WebOS < 25
    // -------------------------------------------------------------------------
    // WebOS < 25 cannot reliably direct-play Dolby Vision content wrapped in an
    // MKV container, regardless of the video codec (HEVC, H.264, etc.). DirectPlay
    // of DOVI MKVs causes the native player to stall and crash due to the way the
    // raw MKV byte stream is fed to the hardware decoder over HTTP.
    //
    // The correct fix: add a CodecProfile scoped to Container:'mkv' with no Codec
    // restriction (so it applies universally to every video codec). The NotEquals
    // conditions tell the Jellyfin server "DOVI is not supported for direct-play in
    // this container" — causing it to immediately fall back to an fMP4 HLS Remux,
    // which packages the identical stream into segments the TV handles flawlessly.
    //
    // WebOS >= 25 handles DOVI MKV natively, so we skip this block for those devices.
    if (enableDolbyVision && caps.webosVersion < 25) {
        codecProfiles.push({
            Type: 'Video',
            // No Codec field = applies to ALL video codecs (hevc, h264, av1, vp9, etc.)
            Container: 'mkv',
            Conditions: [
                { Condition: 'NotEquals', Property: 'VideoRangeType', Value: 'DOVI', IsRequired: false },
                { Condition: 'NotEquals', Property: 'VideoRangeType', Value: 'DOVIWithHDR10', IsRequired: false },
                { Condition: 'NotEquals', Property: 'VideoRangeType', Value: 'DOVIWithHLG', IsRequired: false },
                { Condition: 'NotEquals', Property: 'VideoRangeType', Value: 'DOVIWithSDR', IsRequired: false },
                { Condition: 'NotEquals', Property: 'VideoRangeType', Value: 'DOVIWithHDR10Plus', IsRequired: false }
            ]
        });
    }

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
                        Value: 'h264'
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
