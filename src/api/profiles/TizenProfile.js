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
                SegmentLength: PlayerSettings.get('tizenSegmentLength') || 3,
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
    let transAudioCodecsArr = [];
    let transMaxAudioChannels;

    if (caps.tizenVersion >= 6) {
        // Tizen 6+: AC3/EAC3 in HLS/TS is reliable — use full surround sound
        transAudioCodecsArr.push('ac3', 'eac3');
        transMaxAudioChannels = maxAudioChannels;
    } else {
        // Tizen 5.x: strict AAC-only HLS path. Must also cap at 2 channels —
        // multichannel AAC in TS also crashes AVPlay on Tizen 5.0.
        transAudioCodecsArr.push('aac');
        // Cap at 2 (integer) — multichannel AAC in TS crashes AVPlay on Tizen 5.x
        transMaxAudioChannels = 2;
    }

    if (enableDts) transAudioCodecsArr.push('dts', 'dca');
    if (enableTrueHd) transAudioCodecsArr.push('truehd');

    let transAudioCodecs = transAudioCodecsArr.join(',');

    let directAudioCodecsArr = ['aac', 'ac3', 'eac3', 'mp3'];
    if (enableDts) directAudioCodecsArr.push('dts', 'dca');
    if (enableTrueHd) directAudioCodecsArr.push('truehd');
    let directAudioCodecs = directAudioCodecsArr.join(',');

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
    // transVideoCodecs — video codecs Jellyfin is ALLOWED to copy (no re-encode)
    // into the HLS output segments. We maintain TWO separate lists because the
    // container determines what codecs are muxable:
    //
    //   MPEG-TS (tsCompatibleVideoCodecs):
    //     Supports H264, HEVC, MPEG-2 Video, VC1 — but NOT AV1 or VP9.
    //     When an AV1/VP9 source has incompatible audio (e.g. DTS-HD MA), the
    //     MPEG-TS profile can't copy the video — it must re-encode to H264.
    //
    //   fMP4/MP4 (fmp4TransVideoCodecs):
    //     The MP4 container CAN carry AV1 and VP9 natively. By adding them here,
    //     we tell Jellyfin: "use the fMP4 HLS profile to copy AV1/VP9 video while
    //     only transcoding the audio (DTS→AC3)." This turns a full re-encode into
    //     a fast, lightweight audio-only transcode — exactly what DirectStream is.
    //
    // directVideoCodecs is used in DirectStreamProfiles (progressive HTTP remux).
    // =========================================================================
    const tsCompatibleVideoCodecs = ['h264', 'vc1', 'mpeg2video'];
    if (enableHEVC) tsCompatibleVideoCodecs.push('hevc');

    // TS-compatible list (AV1/VP9 intentionally excluded — not muxable into MPEG-TS)
    let transVideoCodecs = tsCompatibleVideoCodecs.join(',');

    // fMP4-compatible list — built from scratch, NOT by spreading tsCompatibleVideoCodecs.
    //
    // The ISO Base Media File Format (MP4/fMP4) only supports a specific set of modern
    // codecs via standardised codec boxes (avc1, hvc1, av01, vp09). Crucially:
    //
    //   mpeg2video → NOT supported in MP4. No standard codec box exists for it.
    //               It belongs only in MPEG-TS. Including it here causes the server
    //               to re-encode it anyway (server-side container compat check wins).
    //
    //   vc1 → similarly TS-only in practice; MP4 carrying vc1 is non-standard.
    //
    // So we explicitly list only H264 and HEVC (always fMP4-safe), plus AV1/VP9
    // when enabled. mpeg2video/vc1 fall back to the TS HLS profile instead.
    const fmp4CompatibleVideoCodecs = ['h264'];
    if (enableHEVC) fmp4CompatibleVideoCodecs.push('hevc');
    if (enableAV1) fmp4CompatibleVideoCodecs.push('av1');
    if (enableVP9) fmp4CompatibleVideoCodecs.push('vp9');
    const fmp4TransVideoCodecs = fmp4CompatibleVideoCodecs.join(',');

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
             *     AV1/VP9 copy-stream remuxing over HLS on Tizen devices where fMP4
             *     is known-good but the tizenVersion >= 6 gate would normally block it.
             *     When forced, we use fmp4TransVideoCodecs which includes AV1/VP9.
             *   default (no force) — use MPEG-TS, which is the only AVPlay-safe
             *     container on Tizen 5.x and below. TS cannot carry AV1/VP9.
             */
            Container: primaryHlsContainer,
            Type: 'Video',
            AudioCodec: transAudioCodecs,
            // When forceFmp4Hls is active the primary container is MP4, so we use
            // fmp4TransVideoCodecs (includes AV1/VP9). Otherwise it's MPEG-TS, which
            // cannot carry AV1/VP9, so we use the TS-restricted transVideoCodecs.
            VideoCodec: forceFmp4Hls ? fmp4TransVideoCodecs : transVideoCodecs,
            Context: 'Streaming',
            Protocol: 'hls',
            // Tizen 5.x: capped at 2 channels (stereo AAC only); Tizen 6+: full surround (AC3/EAC3)
            // Integer fields — Jellyfin TranscodingProfileDto schema is strict
            MaxAudioChannels: transMaxAudioChannels,
            MinSegments: isHtml5 ? 1 : 2,
            SegmentLength: isHtml5 ? (PlayerSettings.get('html5SegmentLength') || 2) : (PlayerSettings.get('tizenSegmentLength') || 6),
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
            // Use fmp4TransVideoCodecs here — this is the key difference from the TS profile.
            // fMP4 (MP4 container) can carry AV1 and VP9, so we advertise them as copyable.
            // This allows Jellyfin to pick this profile for AV1/VP9 sources with incompatible
            // audio (e.g. DTS-HD MA): it will copy the video stream and only transcode audio.
            AudioCodec: transAudioCodecs,
            VideoCodec: fmp4TransVideoCodecs,
            Context: 'Streaming',
            Protocol: 'hls',
            // On Tizen 6+ the transMaxAudioChannels is full surround (AC3/EAC3),
            // which fMP4 HLS handles without issue.
            MaxAudioChannels: transMaxAudioChannels,
            MinSegments: isHtml5 ? 1 : 2,
            SegmentLength: isHtml5 ? (PlayerSettings.get('html5SegmentLength') || 2) : (PlayerSettings.get('tizenSegmentLength') || 6),
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

    // Samsung TVs do not natively support Dolby Vision and lack a hardware DV decoder.
    // However, they can play the HDR10/HDR10+ compatibility/fallback layer of Dolby Vision
    // Profile 7 and Profile 8 encodes flawlessly.
    //
    // CRITICAL DETAIL:
    // Raw 'DOVI' (typically Profile 5) lacks a fallback layer and must be transcoded to SDR.
    // More importantly, advertising raw 'DOVI' support in the profile makes the Jellyfin server
    // assume the client has native Dolby Vision support, causing it to copy the video stream
    // and tag it as 'dvh1' inside HLS fMP4 segments. The Tizen AVPlay engine cannot parse
    // Dolby Vision configuration parameters inside the MP4 headers, leading to indefinite buffering.
    //
    // By excluding raw 'DOVI' but retaining compatibility range types ('DOVIWithHDR10', etc.),
    // we tell the server that we only support playing the base compatibility layer. The server
    // will copy the HEVC video stream but tag it as standard HEVC 'hvc1' without the DV boxes,
    // which plays perfectly on Tizen (exactly as it does in the official client).
    const hevcVideoRangeTypes = enableHDR
        ? 'SDR|HDR10|HDR10Plus|HLG|DOVIWithHDR10|DOVIWithHDR10Plus|DOVIWithHLG|DOVIWithSDR|DOVIWithEL|DOVIWithELHDR10Plus|DOVIInvalid'
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
                /*
                 * Interlaced H264 restriction — AVPlay-only:
                 *
                 * Samsung's AVPlay HLS parser crashes (PLAYER_ERROR_NOT_SUPPORTED_FORMAT) when
                 * it encounters interlaced H264 frames inside an HLS TS stream. The fix is to
                 * require IsInterlaced=false in the CodecProfile so that Jellyfin will transcode
                 * (deinterlace) before delivering the stream.
                 *
                 * The HTML5/Chromium backend Software H264 decoder is fully spec-compliant and
                 * handles interlaced content natively — no deinterlacing transcode needed there.
                 * We therefore skip this condition when the caller has indicated html5 backend,
                 * allowing the server to direct-stream (or direct-play) interlaced content.
                 */
                ...(!isHtml5 ? [{
                    Condition: 'Equals',
                    Property: 'IsInterlaced',
                    Value: 'false',
                    IsRequired: true,
                }] : []),
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
        },
        // -----------------------------------------------------------------------
        // Block interlaced TS/MPEGTS from DirectPlay.
        //
        // HDHomeRun ATSC 1.0 broadcasts are typically interlaced MPEG-2 or
        // interlaced H.264. When we include ts/mpegts in DirectPlayProfiles,
        // the server evaluates these CodecProfile conditions to determine if
        // DirectPlay is actually viable.
        //
        // Without this, Jellyfin opens a 'heavy_' pre-transcode session, then
        // fails at runtime with DirectPlayError — causing FFmpeg to crash.
        // With this, the server issues ContainerNotSupported immediately and
        // opens a 'native_' capture + HLS transcode pipeline, which is exactly
        // what jellyfin-web does and what works correctly.
        // -----------------------------------------------------------------------
        {
            Type: 'Video',
            Container: 'ts,mpegts',
            Conditions: [
                {
                    Condition: 'Equals',
                    Property: 'IsInterlaced',
                    Value: 'false',
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
            Type: 'VideoAudio',
            Codec: 'dts,dca,dts-hd,dts-ma,dts-x',
            Conditions: [{ Condition: 'Equals', Property: 'AudioChannels', Value: '0', IsRequired: true }]
        });
    }
    if (!enableTrueHd) {
        codecProfiles.push({
            Type: 'VideoAudio',
            Codec: 'truehd',
            Conditions: [{ Condition: 'Equals', Property: 'AudioChannels', Value: '0', IsRequired: true }]
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
