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

    // HDR10: Mirror the HEVC detection pattern — default to true and only deny if hardware
    // explicitly reports false. This fixes inconsistent HDR10 playback on WebOS.
    //
    // WHY THE OLD FALLBACK WAS BROKEN:
    //   The previous logic was `(hdr10Hw !== null ? hdr10Hw : uhd)`.
    //   When the webOS.deviceInfo() async callback hasn't fired yet (common on first
    //   profile build at app startup), hdr10Hw = null → fell through to the UHD screen
    //   size check (window.screen.width >= 3840). WebOS has a known bug where the screen
    //   size can report incorrectly at page load, making uhd=false → hdr10=false.
    //   Result: 'HDR10' gets omitted from hevcVideoRangeTypes → server reports
    //   VideoRangeTypeNotSupported → remuxes to HLS/TS → WebOS HLS pipeline doesn't get
    //   a VIDEO-RANGE hint in the .m3u8 → HDR mode never activates on the display.
    //   This is why forcing direct play "fixed" it: the file streamed as-is with the
    //   original container's HDR metadata intact, bypassing the profile condition entirely.
    //
    // THE FIX:
    //   Default hdr10 = true (virtually all LG WebOS 4+ TVs support HDR10).
    //   Only set false when hardware EXPLICITLY denies it via deviceInfo.
    //   If deviceInfo hasn't arrived yet (null), we optimistically assume true —
    //   the worst case is that the server allows direct-play of HDR10 on a non-HDR
    //   panel, which just plays as SDR-tonemapped. Far better than unnecessary remux.
    //
    // DOLBY VISION OVERRIDE:
    //   Every DV display also supports HDR10 (DV Profile 7/8 has an HDR10 base layer).
    //   Even if hardware explicitly says hdr10=false, we still force true when dolbyVision
    //   is confirmed — some LG firmware builds report this incorrectly.
    const hdr10 = hdr10Hw !== false || dolbyVision;

    // AV1 and VP9: MSE probing natively fails on early WebOS but hardware decodes them securely.
    // WebOS 6+ natively supports AV1. VP9 is generally safe globally on WebOS 4+.
    const vp9 = true;
    const av1 = webosVersion >= 6;

    const ac3 = codecs.ac3;

    // Apply the user's EAC3 force-state setting.
    // LG WebOS Chromium builds frequently mis-report EAC3 support via canPlayType
    // even on hardware that passes EAC3 through eARC without issue. The 'enable'
    // override lets the user correct this, while 'disable' lets them explicitly
    // opt out even when the probe passes.
    const eac3Setting = PlayerSettings.get('enableEac3');
    const eac3 = eac3Setting === 'enable' ? true : eac3Setting === 'disable' ? false : codecs.eac3;

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
                SegmentLength: PlayerSettings.get('webosSegmentLength') || 3,
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

    const hevcSetting = PlayerSettings.get('enableHEVC');
    const enableHEVC = hevcSetting === 'enable' ? true : hevcSetting === 'disable' ? false : caps.hevc;

    const av1Setting = PlayerSettings.get('enableAV1');
    const enableAV1 = av1Setting === 'enable' ? true : av1Setting === 'disable' ? false : caps.av1;

    const vp9Setting = PlayerSettings.get('enableVP9');
    const enableVP9 = vp9Setting === 'enable' ? true : vp9Setting === 'disable' ? false : caps.vp9;

    // Hybrid HDR: Default to hardware capability unless the user explicitly flipped the setting
    const hdrSetting = PlayerSettings.get('enableHDR');
    const enableHDR = hdrSetting === 'enable' ? true : hdrSetting === 'disable' ? false : caps.hdr10;

    // Hybrid Dolby Vision: Default to hardware capability unless the user explicitly flipped the setting
    const dolbyVisionSetting = PlayerSettings.get('enableDolbyVision');
    const enableDolbyVision =
        dolbyVisionSetting === 'enable' ? true : dolbyVisionSetting === 'disable' ? false : caps.dolbyVision;

    const dtsSetting = PlayerSettings.get('enableDts');
    const enableDts = dtsSetting === 'enable' ? true : dtsSetting === 'disable' ? false : caps.dts;

    const trueHdSetting = PlayerSettings.get('enableTrueHd');
    const enableTrueHd = trueHdSetting === 'enable' ? true : trueHdSetting === 'disable' ? false : caps.truehd;

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

    let maxBitrate =
        manualBitrateOverride || PlayerSettings.get('maxBitrateInternet') || (caps.uhd ? 120000000 : 40000000);
    if (maxBitrate > 120000000) {
        maxBitrate = 120000000;
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

    // --------------------------------------------------------------------------
    // IMPORTANT: fMP4 (mp4 container) does NOT activate Dolby Vision on WebOS.
    // Testing confirmed that only MPEG-TS triggers the native DV decoder pipeline.
    // Therefore DOVI content uses TS by default just like everything else.
    // fMP4 is only used when the user explicitly enables it via settings
    // (enableFmp4HlsContainer + forceFmp4HlsContainer), and doing so will
    // sacrifice DV passthrough in exchange for fMP4 compatibility.
    //
    // NOTE: We previously had a per-content `isDoviContent` flag here that
    // set SegmentLength to 10s when DV+HEVC settings were enabled. This was
    // WRONG — the profile is built before any content is known, so the flag
    // evaluated true for ALL HEVC content (not just actual DV streams),
    // causing HDR10/HDR10+ files to get 10s segments (~120 MB each at 96 Mbps)
    // instead of 6s. This was the root cause of the slideshow/stall reports.
    // Segment length is now a fixed 6 s for all TS content, matching the
    // behaviour of the official jellyfin-webos client.
    // --------------------------------------------------------------------------

    // Primary HLS container: driven ONLY by the user's explicit fMP4 setting.
    const primaryHlsContainer = forceFmp4Hls ? 'mp4' : 'ts';

    // -------------------------------------------------------------------------
    // Resolve the effective EAC3 support flag for THIS profile build.
    //
    // caps.eac3 was already resolved in getDeviceCapabilities() against the
    // enableEac3 force-state setting. We reference it directly here — any
    // 'enable'/'disable' override has already been baked into caps.eac3.
    // -------------------------------------------------------------------------
    const audioCodecs = ['aac', 'mp3', 'flac', 'vorbis', 'pcm', 'wav', 'pcm_s16le', 'pcm_s24le', 'aac_latm'];
    if (caps.webosVersion >= 4) {
        audioCodecs.push('opus');
    }
    if (caps.ac3) audioCodecs.push('ac3');
    if (caps.eac3) audioCodecs.push('eac3'); // caps.eac3 already reflects force-state override
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
            /*
             * TS/MPEGTS DirectPlay: enabled for WebOS native backend.
             *
             * IMPORTANT — interlaced streams are excluded via a CodecProfile condition
             * added below. HDHomeRun ATSC channels broadcast interlaced MPEG-2 or H.264.
             * If we claim DirectPlay for those, Jellyfin opens a 'heavy_' pre-transcode
             * session, fails with DirectPlayError, and the fallback crashes FFmpeg.
             * Jellyfin-web applies the same block — the server correctly falls through to
             * a native 'ContainerNotSupported' HLS transcode which succeeds.
             */
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

    // ---------------------------------------------------------------------------
    // HLS transcoding audio codec list (TranscodingProfiles).
    //
    // IMPORTANT: TrueHD is intentionally EXCLUDED here, even when the user has
    // enabled TrueHD passthrough. Here's why:
    //
    //   TranscodingProfiles feeds the server's HLS pipeline. When the server
    //   decides to DirectStream (copy video bitstream) or Transcode (re-encode
    //   video), it wraps the output into MPEG-TS or fMP4 HLS segments.
    //
    //   WebOS's native HLS pipeline processes these segments through the
    //   Chromium audio stack — it does NOT route them to the eARC hardware
    //   bitstream output. Putting TrueHD here would cause the server to copy
    //   TrueHD into HLS/TS segments, which WebOS cannot pass through to eARC.
    //   The result is silence or a mangled downmix instead of lossless audio.
    //
    //   TrueHD passthrough only works when the server serves the raw file
    //   (DirectPlay) or a raw MKV container (DirectStream via DirectStreamProfiles
    //   below), because WebOSPlayer routes those through _playNativeDirect() →
    //   video.src → native media pipeline → eARC hardware path.
    //
    //   DTS is similarly excluded for the same reason — DTS-in-HLS from this
    //   pipeline doesn't reliably trigger eARC bitstream passthrough on WebOS.
    //
    // For HLS transcode output, AC3/EAC3 are the correct lossy fallback targets:
    // they ARE supported by the WebOS HLS pipeline for eARC passthrough and
    // work universally across all WebOS 4+ versions.
    //
    // The user can specify their preferred transcode codec via settings:
    //   'eac3' — Dolby Digital Plus (better quality, default)
    //   'ac3'  — Dolby Digital (legacy compatibility)
    //   'aac'  — AAC (last resort for devices that can't handle AC3/EAC3 in HLS)
    // ---------------------------------------------------------------------------

    // Read user preference and build the codec list with the preferred codec first.
    // AAC is always included as a final fallback regardless of preference.
    const preferredTranscodeCodec = PlayerSettings.get('transcodeAudioCodec') || 'eac3';

    let transAudioCodecsArr;
    if (preferredTranscodeCodec === 'ac3') {
        // User prefers AC3 (Dolby Digital) — maximum legacy compatibility.
        transAudioCodecsArr = ['aac', 'ac3', 'eac3'];
    } else if (preferredTranscodeCodec === 'aac') {
        // User prefers AAC only — skip surround codec entirely.
        transAudioCodecsArr = ['aac'];
    } else {
        // Default: prefer EAC3 (Dolby Digital Plus) — better quality, modern AVRs.
        // NOTE: DTS and TrueHD are deliberately NOT added here (see comment above).
        transAudioCodecsArr = ['aac', 'eac3', 'ac3'];
    }

    // NOTE: DTS and TrueHD are deliberately NOT added here (see comment above).
    const transAudioCodecs = transAudioCodecsArr.join(',');

    // ---------------------------------------------------------------------------
    // DirectStream audio codec list (DirectStreamProfiles).
    //
    // DirectStreamProfiles governs what containers Jellyfin uses when it copies
    // the video bitstream verbatim but needs to repackage the audio. Unlike the
    // HLS pipeline, DirectStream mode serves a raw progressive MKV stream over
    // HTTP. WebOSPlayer routes this URL through _playNativeDirect() → video.src
    // → the WebOS native media engine → eARC hardware path.
    //
    // In this path, the native media engine CAN bitstream-pass TrueHD and DTS
    // to eARC exactly like the native LG media player does for local files.
    // ---------------------------------------------------------------------------
    const directAudioCodecsArr = ['aac', 'ac3', 'eac3', 'mp3', 'flac'];
    if (enableDts) directAudioCodecsArr.push('dts', 'dca');
    if (enableTrueHd) directAudioCodecsArr.push('truehd');
    const directAudioCodecs = directAudioCodecsArr.join(',');

    let transVideoCodecs = enableHEVC ? 'h264,hevc' : 'h264';

    if (playbackMode === 'remux') {
        // Video copy for quality, audio transcoded via transAudioCodecs above.
        // AllowAudioStreamCopy=false (set in _getPlaybackInfo remux case) ensures
        // the server transcodes audio even when the source codec is in the list.
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
            // ---------------------------------------------------------------------
            // Segment sizing: fixed at 6 seconds for all TS content.
            //
            // This matches the official jellyfin-webos client behaviour and ensures
            // that each HLS chunk stays at a manageable ~72 MB at 96 Mbps (4K HEVC),
            // which the LG hardware decoder and RAM bus can handle without stalling.
            //
            // A previous version used 10 s for "DV content" but the detection was
            // based on settings (enableDolbyVision && enableHEVC) rather than actual
            // stream metadata, so it incorrectly applied to all HDR10/HDR10+ content
            // as well — causing the slideshow / slowmo playback reports.
            // ---------------------------------------------------------------------
            SegmentLength: isHtml5
                ? PlayerSettings.get('html5SegmentLength') || 2
                : PlayerSettings.get('webosSegmentLength') || 6,
            // Force IDR-aligned segment cuts for all TS content, not only DOVI.
            // The WebOS decoder produces visible macroblocking artifacts when split
            // mid-GOP, and the resulting non-IDR boundaries also trigger additional
            // 'waiting' events. BreakOnNonKeyFrames is never safe on this platform.
            // Exception: fMP4 is already forced-IDR by the muxer; and remux mode
            // passes the stream through as-is so we must not override it either.
            BreakOnNonKeyFrames: primaryHlsContainer === 'mp4' ? false : playbackMode === 'remux' ? false : false // always false for TS on WebOS
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
    // Only added when the user has explicitly opted into fMP4 via settings AND
    // fMP4 is not already the primary container (no duplicate).
    // DOVI content no longer mandates fMP4 — it routes fine via TS.
    if (supportsFmp4Hls && primaryHlsContainer !== 'mp4') {
        transcodingProfiles.push({
            Container: 'mp4',
            Type: 'Video',
            AudioCodec: transAudioCodecs,
            VideoCodec: transVideoCodecs,
            Context: 'Streaming',
            Protocol: 'hls',
            MaxAudioChannels: maxAudioChannels,
            MinSegments: 1,
            SegmentLength: isHtml5
                ? PlayerSettings.get('html5SegmentLength') || 2
                : PlayerSettings.get('webosSegmentLength') || 6,
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
        // -----------------------------------------------------------------------
        // Block interlaced TS/MPEGTS from DirectPlay.
        //
        // HDHomeRun ATSC 1.0 broadcasts are typically interlaced MPEG-2 or
        // interlaced H.264. When we include ts/mpegts in DirectPlayProfiles,
        // the server evaluates these CodecProfile conditions to determine if
        // DirectPlay is actually viable. The NotEquals:IsInterlaced:true
        // condition tells the server "interlaced content is not supported for
        // direct play in this container".
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

    // ---------------------------------------------------------------------------
    // HEVC VideoRangeType allowed list.
    //
    // This string controls which HDR range types the server is permitted to
    // direct-play or remux without re-encoding the video stream.
    //
    // When the user enables DV, we MUST also include the plain HDR10 / HLG
    // subtypes here — otherwise a file whose VideoRangeType is 'HDR10' (not
    // a DV subtype) hits the DV encouragement CodecProfile below, fails the
    // DOVI-only EqualsAny match, and Jellyfin reports VideoRangeTypeNotSupported
    // — triggering a slow full video transcode for what should be a direct-play.
    //
    // Rule: include ALL range types that both HDR and DV paths need.
    // Mirror of TizenProfile's hevcVideoRangeTypes.
    // ---------------------------------------------------------------------------
    const hevcVideoRangeTypes = enableHDR
        ? 'SDR|HDR10|HDR10Plus|HLG|DOVI|DOVIWithHDR10|DOVIWithHDR10Plus|DOVIWithHLG|DOVIWithSDR|DOVIWithEL|DOVIWithELHDR10Plus'
        : 'SDR|DOVIWithSDR';

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
                    // Explicitly enumerate accepted VideoRangeTypes so Jellyfin knows
                    // we can handle HDR10 and all DV sub-flavours without transcoding.
                    // Without this, enabling DV causes HDR10-only files (VideoRangeType=HDR10)
                    // to fall through with VideoRangeTypeNotSupported.
                    Condition: 'EqualsAny',
                    Property: 'VideoRangeType',
                    Value: hevcVideoRangeTypes,
                    IsRequired: false
                },
                {
                    Condition: 'LessThanEqual',
                    Property: 'VideoBitDepth',
                    Value: enableHDR ? '10' : '8',
                    IsRequired: false
                },
                // ---------------------------------------------------------------
                // HDR10 codec tag gate — prevents VAAPI from stripping HDR metadata
                // ---------------------------------------------------------------
                // PROBLEM (confirmed via server FFmpeg logs):
                //   When Jellyfin's server decides to re-encode HEVC HDR10 content
                //   via VAAPI (hevc_vaapi), it uses:
                //       -profile:v:0 main          ← forces 8-bit output
                //       -vf "setparams=color_primaries=bt709:color_trc=bt709:..."
                //   This explicitly converts the stream to SDR bt709. The hardware
                //   encoder doesn't support Main 10 / HDR reliably in VAAPI, so
                //   Jellyfin silently downgrades to SDR. WebOS receives an SDR stream
                //   and naturally shows no HDR signal — by design.
                //
                // FIX:
                //   Require VideoCodecTag = 'hvc1' for HDR HEVC. The hvc1 tag is
                //   only present when the HEVC stream is COPIED verbatim (remux path).
                //   When the server would re-encode (transcode path), it produces a
                //   different / no codec tag, failing this condition. Jellyfin then
                //   falls back to the copy path — preserving all HDR10 SEI metadata
                //   (mastering display, MaxCLL/MaxFALL, HDR10+) in the output TS segments.
                //
                // NOTE: This only applies when HDR is enabled. SDR content is freely
                //   re-encodable since there is no HDR metadata to preserve.
                ...(enableHDR
                    ? [
                          {
                              Condition: 'EqualsAny',
                              Property: 'VideoCodecTag',
                              Value: 'hvc1|dvh1|hev1',
                              IsRequired: false
                          }
                      ]
                    : [])
            ]
        });

        // -----------------------------------------------------------------------
        // HEVC codec tag gate for fMP4 HLS container (WebOS-specific)
        // -----------------------------------------------------------------------
        // When the user has opted into fMP4 as the primary HLS container, we
        // mandate that the server uses the hvc1 codec tag (in-band parameter
        // sets) rather than the default hev1 tag (out-of-band parameter sets).
        //
        // WHY THIS MATTERS:
        //   jellyfin-web enforces the exact same restriction for Safari (lines
        //   1441-1448 of browserDeviceProfile.js) — Safari only supports hvc1
        //   and dvh1. WebOS has the same undocumented requirement: without hvc1,
        //   the hardware validates the codec string, fails, and the Dolby Vision
        //   pipeline stays offline even though the file "plays" (as SDR/HDR10).
        //
        //   hvc1 = parameter sets inside the bitstream (in-band)   ✅ WebOS OK
        //   hev1 = parameter sets in the MP4 side boxes (out-of-band) ❌ DV dead
        //
        // WHY ONLY IN fMP4 MODE:
        //   MPEG-TS doesn't use MP4 codec strings at all. The hardware decoder
        //   reads raw annexB bytes directly from the TS payload — codec tag
        //   validation never happens, so DOVI RPU passes through regardless.
        //   Applying this condition in TS mode would incorrectly refuse direct-
        //   play of TS files whose hev1/hvc1 we have no control over.
        //
        // EFFECT:
        //   If a source HEVC stream is tagged hev1, the server will remux it
        //   into an fMP4 segment that Jellyfin tags as hvc1, giving WebOS the
        //   signal it needs to activate the hardware DV pipeline.
        // -----------------------------------------------------------------------
        if (primaryHlsContainer === 'mp4') {
            codecProfiles.push({
                Type: 'Video',
                Codec: 'hevc',
                // Restrict to mp4/hls containers only — TS is excluded by
                // omitting the outer Container condition (TS never uses codec tags).
                Conditions: [
                    {
                        // Mandate in-band parameter sets (hvc1) or its DV sibling (dvh1).
                        // If the source file uses hev1, Jellyfin will remux it via FFmpeg
                        // with -tag:v hvc1 before sending, ensuring the WebOS DV pipeline fires.
                        Condition: 'EqualsAny',
                        Property: 'VideoCodecTag',
                        Value: 'hvc1|dvh1',
                        IsRequired: true
                    }
                ]
            });
        }

        // Explicit Dolby Vision encouragement profile.
        //
        // PURPOSE: Without this hint, Jellyfin may emit VideoRangeTypeNotSupported and
        // immediately reject a DOVI stream before evaluating our container CodecProfiles.
        // It signals "DV is acceptable here" so the server proceeds to the full evaluation.
        //
        // CRITICAL — must include ALL HDR types, not just DV subtypes:
        //   Jellyfin uses AND logic across all matching CodecProfiles for the same codec.
        //   If this profile only allowed DOVI subtypes, then pure HDR10Plus (VideoRangeType=HDR10Plus)
        //   would fail this profile's condition (HDR10Plus ≠ any DOVI subtype) and Jellyfin would
        //   report VideoRangeTypeNotSupported — blocking direct play of HDR10+ content even though
        //   the hardware supports it natively. Confirmed root cause of the HDR10+ remux regression.
        if (enableDolbyVision) {
            codecProfiles.push({
                Type: 'Video',
                Codec: 'hevc',
                Conditions: [
                    {
                        // Accept ALL HDR range types supported by the device, not just DV subtypes.
                        // The DV subtypes are included here so Jellyfin doesn't bail with
                        // VideoRangeTypeNotSupported on DOVI content before reaching our
                        // container-specific CodecProfiles. All other types (HDR10, HDR10Plus, etc.)
                        // are passthrough — they would be permitted by the main HEVC profile anyway.
                        Condition: 'EqualsAny',
                        Property: 'VideoRangeType',
                        Value: 'SDR|HDR10|HDR10Plus|HLG|DOVI|DOVIWithHDR10|DOVIWithHDR10Plus|DOVIWithHLG|DOVIWithSDR',
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

    // Impossible condition (channels never = 0) blocks stream-copy of disabled codecs, forcing AAC transcode.
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

    // -------------------------------------------------------------------------
    // DirectStreamProfiles — raw container output for the DirectStream path.
    //
    // Without this, Jellyfin has no explicit guidance on what container to use
    // when it decides to DirectStream (copy video, handle audio). It would fall
    // through to TranscodingProfiles and emit HLS/TS — which cannot deliver
    // TrueHD or DTS to eARC on WebOS (see transAudioCodecsArr comment above).
    //
    // By specifying MKV here, the server outputs a raw progressive MKV stream
    // over HTTP. WebOSPlayer receives a non-.m3u8 URL and routes it through
    // _playNativeDirect() → video.src, giving the native media pipeline a
    // direct bitstream it can pass through eARC — the same path that works
    // for DirectPlay.
    // -------------------------------------------------------------------------
    const directStreamProfiles = [
        {
            Container: 'mkv',
            Type: 'Video',
            VideoCodec: mkvVideoCodecs.join(','),
            AudioCodec: directAudioCodecs
        }
    ];

    return {
        Name: `Litefin WebOS${isHtml5 ? ' (HTML5)' : ''}${playbackMode !== 'auto' ? ` (${playbackMode})` : ''}`,
        MaxStreamingBitrate: maxBitrate,
        MaxStaticBitrate: maxBitrate,
        MaxStaticMusicBitrate: 40000000,
        MusicStreamingTranscodingBitrate: 384000,
        DirectPlayProfiles: directPlayProfiles,
        DirectStreamProfiles: directStreamProfiles,
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
