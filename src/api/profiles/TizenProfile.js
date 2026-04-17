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
        enableHDR = !!caps.hdr10;
    }
    
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

    // Keep as integer — the Jellyfin server TranscodingProfileDto schema expects
    // MaxAudioChannels, MinSegments and SegmentLength to be integers, not strings.
    // Sending a string (e.g. "6") causes a JSON-schema validation 400 Bad Request
    // on strict server versions.
    const maxAudioChannels = caps.maxAudioChannels;

    // ProfileCondition.Value is always a string in Jellyfin's schema, so we keep
    // a separate string-form for use inside CodecProfile condition objects.
    const maxAudioChannelsStr = String(caps.maxAudioChannels);

    // enableFlacInVideo: when false (default), FLAC is NOT included in the video
    // DirectPlay audio codec list. This forces Jellyfin to transcode FLAC tracks
    // in video containers to AC3, which AVPlay buffers correctly and without the
    // ~2s A/V sync drift that FLAC+video container demuxing causes on Tizen hardware.
    //
    // IMPORTANT: Music (audio-only) files are always kept as-is — the musicAudioCodecString
    // always contains FLAC so .flac containers DirectPlay regardless of this setting.
    const enableFlacInVideo = PlayerSettings.get('enableFlacInVideo');

    // Base codec list shared by all audio contexts.
    // mp2 (MPEG-1 Layer 2) is included because it is the standard audio codec for
    // broadcast Live TV (DVB/MPEG-TS) streams in Europe and elsewhere. Without it,
    // Jellyfin will set AudioCodecNotSupported and force a full transcode for Live TV.
    // AVPlay handles mp2 natively in TS containers — no transcode needed.
    const baseAudioCodecs = ['aac', 'mp3', 'mp2', 'mp1l2', 'opus', 'vorbis', 'pcm', 'wav', 'pcm_s16le', 'pcm_s24le', 'aac_latm'];
    if (caps.ac3) baseAudioCodecs.push('ac3');
    if (caps.eac3) baseAudioCodecs.push('eac3');
    if (caps.tizenVersion >= 6.5) baseAudioCodecs.push('ac4');
    if (enableDts) baseAudioCodecs.push('dts', 'dca');
    if (enableTrueHd) baseAudioCodecs.push('truehd');

    // Video audio: conditionally includes FLAC based on setting
    const videoAudioCodecs = enableFlacInVideo
        ? ['flac', ...baseAudioCodecs]
        : [...baseAudioCodecs];  // FLAC excluded → server transcodes to AC3

    const videoAudioCodecString = videoAudioCodecs.join(',');

    // Music audio: FLAC always included — audio-only containers have no sync issue
    const musicAudioCodecString = ['flac', ...baseAudioCodecs].join(',');

    // Removed legacy alias audioCodecString to fix lint warning

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
        // Video DirectPlay: audioCodec string excludes FLAC by default (see enableFlacInVideo)
        directPlayProfiles.push({
            Container: 'mp4,m4v,mov',
            Type: 'Video',
            VideoCodec: generalVideoCodecs.join(','),
            AudioCodec: videoAudioCodecString
        });

        directPlayProfiles.push({
            Container: 'mkv',
            Type: 'Video',
            VideoCodec: mkvVideoCodecs.join(','),
            AudioCodec: videoAudioCodecString
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
            AudioCodec: videoAudioCodecString
        });

        // AVPlay handles many legacy containers natively
        if (!isHtml5) {
            directPlayProfiles.push({
                Container: 'asf',
                Type: 'Video',
                AudioCodec: videoAudioCodecString
            });
            directPlayProfiles.push({
                Container: 'ts,mpegts',
                Type: 'Video',
                VideoCodec: tsVideoCodecs.join(','),
                AudioCodec: videoAudioCodecString
            });
            directPlayProfiles.push({
                Container: 'm2ts',
                Type: 'Video',
                VideoCodec: m2tsVideoCodecs.join(','),
                AudioCodec: videoAudioCodecString
            });
            directPlayProfiles.push({
                Container: 'avi',
                Type: 'Video',
                VideoCodec: ['h264', enableHEVC ? 'hevc' : '', 'mpeg2video'].filter(Boolean).join(','),
                AudioCodec: videoAudioCodecString
            });
            directPlayProfiles.push({
                Container: 'wmv,asf',
                Type: 'Video',
                AudioCodec: videoAudioCodecString
            });
            directPlayProfiles.push({
                Container: 'mpg,mpeg,flv,3gp,vob,vro',
                Type: 'Video',
                AudioCodec: videoAudioCodecString
            });
        }

        // Music/audio-only files: FLAC always allowed regardless of enableFlacInVideo.
        // Audio-only containers don't have the video-sync drift issue.
        directPlayProfiles.push({
            Container: 'mp3,flac,aac,m4a,m4b,ogg,opus,wav,wma,webma',
            Type: 'Audio',
            AudioCodec: musicAudioCodecString
        });
    }

    // =========================================================================
    // HLS Transcode Audio Configuration (Version-Gated)
    //
    // There are two completely separate audio decoder paths on Samsung TVs:
    //   1. Hardware passthrough (for local/DLNA/progressive HTTP files) — supports AC3, DTS, etc.
    //   2. AVPlay HLS media extractor (for HLS streams) — this is more restrictive.
    //
    // Tizen 5.x (2019-2020 TVs):
    //   AVPlay's HLS parser only accepts AAC in MPEG-TS segments. AC3/EAC3 in the TS
    //   container causes PLAYER_ERROR_NOT_SUPPORTED_FORMAT during buffering — the same
    //   crash we saw with multichannel AAC. The ONLY safe option for HLS transcodes
    //   on Tizen 5.x is stereo AAC (2 channels), which is universally reliable.
    //
    // Tizen 6+ (2021+ TVs):
    //   The updated AVPlay properly supports AC3/EAC3 in HLS/TS, so we can request
    //   surround-sound AC3/EAC3 and AVPlay will decode it natively.
    // =========================================================================
    let transAudioCodecs;
    let transMaxAudioChannels;

    if (caps.tizenVersion >= 6) {
        // Tizen 6+: AC3/EAC3 in HLS/TS is reliable — use full surround sound
        transAudioCodecs = 'ac3,eac3';
        transMaxAudioChannels = maxAudioChannels;
    } else {
        // Tizen 5.x: strict AAC-only HLS path. Must also cap at 2 channels —
        // multichannel AAC in TS also crashes AVPlay on Tizen 5.0.
        transAudioCodecs = 'aac';
        // Cap at 2 (integer) — multichannel AAC in TS crashes AVPlay on Tizen 5.x
        transMaxAudioChannels = 2;
    }

    let directAudioCodecs = 'aac,ac3,eac3,mp3';

    // -------------------------------------------------------------------------
    // fMP4 HLS preference resolution
    // -------------------------------------------------------------------------
    // enableFmp4HlsContainer = master toggle (default on).
    // forceFmp4HlsContainer  = bypass the tizenVersion >= 6 hardware gate and
    //                          promote fMP4 to the PRIMARY HLS transcode.
    const enableFmp4Hls = PlayerSettings.get('enableFmp4HlsContainer');
    const forceFmp4Hls  = enableFmp4Hls && PlayerSettings.get('forceFmp4HlsContainer');

    // Hardware version gate: Tizen < 6 cannot reliably parse fMP4 HLS segments
    // through AVPlay (fires PLAYER_ERROR_NOT_SUPPORTED_FORMAT on some 5.x builds).
    // The force flag lets the user override this when they know their TV is safe.
    const supportsFmp4Hls = enableFmp4Hls && (forceFmp4Hls || caps.tizenVersion >= 6);

    // When fMP4 is forced, it becomes the PRIMARY HLS container (replaces TS as
    // the first entry the Jellyfin server picks from the TranscodingProfiles list).
    const primaryHlsContainer = forceFmp4Hls ? 'mp4' : 'ts';


    // =========================================================================
    // Transcode codec selection
    //
    // transVideoCodecs determines which input video codecs Jellyfin is ALLOWED
    // to "copy" (pass-through, no re-encode) into the output HLS segments.
    //
    // MPEG-TS can natively carry H264, HEVC, MPEG-2 Video, and VC1 — so listing
    // all of these lets Jellyfin copy any of them while only transcoding the audio.
    //
    // VP9 and AV1 are intentionally EXCLUDED: they cannot be muxed into MPEG-TS.
    // When a VP9/AV1 file has an incompatible audio codec, the video must be
    // re-encoded to H264 regardless — no way around it with an HLS/TS container.
    // =========================================================================
    const tsCompatibleVideoCodecs = ['h264', 'vc1', 'mpeg2video'];
    if (enableHEVC) tsCompatibleVideoCodecs.push('hevc');

    let transVideoCodecs = tsCompatibleVideoCodecs.join(',');
    let directVideoCodecs = enableHEVC ? 'h264,hevc' : 'h264';

    if (playbackMode === 'remux') {
        transAudioCodecs = videoAudioCodecString;
        directAudioCodecs = videoAudioCodecString;

        const allVideo = new Set([...generalVideoCodecs, ...mkvVideoCodecs, ...tsVideoCodecs]);
        transVideoCodecs = Array.from(allVideo).join(',');
        directVideoCodecs = transVideoCodecs;
    }

    const transcodingProfiles = [
        {
            /*
             * Primary HLS video transcoding profile.
             *
             * Container selection:
             *   forceFmp4Hls — use fMP4 (mp4) as the primary container. This unlocks
             *     HEVC/AV1 copy-stream remuxing over HLS on Tizen devices where fMP4
             *     is known-good but the tizenVersion >= 6 gate would normally block it.
             *   default (no force) — use MPEG-TS, which is the only AVPlay-safe
             *     container on Tizen 5.x and below.
             */
            Container: primaryHlsContainer,
            Type: 'Video',
            AudioCodec: transAudioCodecs,
            VideoCodec: transVideoCodecs, // fMP4 also safely carries h264/hevc
            Context: 'Streaming',
            Protocol: 'hls',
            // Tizen 5.x: capped at 2 channels (stereo AAC only); Tizen 6+: full surround (AC3/EAC3)
            // Integer fields — Jellyfin TranscodingProfileDto schema is strict
            MaxAudioChannels: transMaxAudioChannels,
            MinSegments: isHtml5 ? 1 : 2,
            SegmentLength: isHtml5 ? 2 : 6,
            // BreakOnNonKeyFrames with fMP4 must be false — fMP4 segments must align to IDR
            // frames. For TS we keep the original behaviour (false for AVPlay, true for HTML5).
            BreakOnNonKeyFrames: forceFmp4Hls ? false : (isHtml5 ? (playbackMode !== 'remux') : false),
            // VBR AAC in MPEG-TS uses LATM framing (stream type 0x11 in the PMT).
            // Tizen 5.0 AVPlay's HLS parser expects standard ADTS framing (0x0F) and
            // immediately fires PLAYER_ERROR_NOT_SUPPORTED_FORMAT when it sees LATM in the PMT.
            // Setting this to false forces CBR AAC with ADTS framing on AVPlay.
            // HTML5/MSE players handle LATM fine, so keep VBR enabled there.
            EnableAudioVbrEncoding: isHtml5
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

    // -------------------------------------------------------------------------
    // Secondary fMP4 HLS profile (Tizen 6+ only by default)
    // -------------------------------------------------------------------------
    // Only added when fMP4 is supported but NOT already the primary container.
    // If forceFmp4Hls is true, the primary profile above is already mp4, so
    // there is nothing extra to push here — avoid a duplicate.
    if (supportsFmp4Hls && !forceFmp4Hls) {
        transcodingProfiles.push({
            Container: 'mp4',
            Type: 'Video',
            AudioCodec: transAudioCodecs,
            VideoCodec: transVideoCodecs,
            Context: 'Streaming',
            Protocol: 'hls',
            // On Tizen 6+ the transMaxAudioChannels is full surround (AC3/EAC3),
            // which fMP4 HLS handles without issue.
            MaxAudioChannels: transMaxAudioChannels,
            MinSegments: isHtml5 ? 1 : 2,
            SegmentLength: isHtml5 ? 2 : 6,
            // fMP4 segments MUST align to IDR boundaries — never cut on subtitle cue points.
            BreakOnNonKeyFrames: false,
            EnableAudioVbrEncoding: isHtml5
        });
    }

    const h264Level = caps.uhd ? '51' : caps.tizenVersion >= 5 ? '52' : caps.tizenVersion >= 4 ? '42' : '41';
    const hevcLevel = caps.uhd8K ? '183' : caps.uhd ? '153' : '150'; // Standardize to 5.0 fallback for HEVC

    const hdrCondition = !enableHDR
        ? [{ Condition: 'EqualsAny', Property: 'VideoRangeType', Value: 'SDR', IsRequired: false }]
        : [];

    // Samsung TVs can play the HDR10/HDR10+ fallback of Dolby Vision Profile 7/8.
    // DOVIWithHDR10Plus is a distinct type from DOVIWithHDR10 and must be listed separately —
    // Jellyfin reports these based on the actual base layer of the encode, not just the DV type.
    // Full Dolby Vision subtype list — each mode is a distinct value Jellyfin reports.
    // DOVIWithEL = DV with Enhancement Layer (EL-only profile, common in remuxes).
    // DOVIWithELHDR10Plus = DV EL + HDR10+ base (the type that triggered the transcode here).
    // Omitting any of these causes VideoRangeTypeNotSupported → unnecessary full video transcode.
    // WebProfile.js already includes both: keep Tizen in sync.
    const hevcVideoRangeTypes = enableHDR
        ? 'SDR|HDR10|HDR10Plus|HLG|DOVI|DOVIWithHDR10|DOVIWithHDR10Plus|DOVIWithHLG|DOVIWithSDR|DOVIWithEL|DOVIWithELHDR10Plus'
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
                {
                    Condition: 'Equals',
                    Property: 'IsInterlaced',
                    Value: 'false',
                    IsRequired: true,
                },
                ...hdrCondition
            ]
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

    // CodecProfile for AAC: limit to stereo channels for DirectPlay qualification.
    // This tells Jellyfin: "only DirectPlay an AAC source if it has ≤2 channels".
    // On Tizen < 6, multichannel AAC in HLS/TS crashes AVPlay, so we exclude those from
    // DirectPlay. Tizen 6+ uses fMP4 which handles 5.1 AAC reliably.
    //
    // NOTE: This does NOT control the output channel count of transcodes — that is governed
    // solely by MaxAudioChannels in the TranscodingProfile, which we've already set correctly.
    // This CodecProfile only affects DirectPlay/DirectStream path decisions.
    codecProfiles.push({
        Type: 'Audio',
        Codec: 'aac',
        Conditions: [
            {
                Condition: 'LessThanEqual',
                Property: 'AudioChannels',
                // Permit DirectPlay of AAC only if channel count is within safe limits.
                // ProfileCondition.Value must always be a string in Jellyfin's schema.
                Value: caps.tizenVersion >= 6 ? maxAudioChannelsStr : '2',
                IsRequired: false
            }
        ]
    });

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
