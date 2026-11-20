/**
 * ============================================================================
 * Litefin — Base Profile Helpers
 * ============================================================================
 * Shared logic for building basic profile components (like Subtitles)
 * that are common across Tizen, WebOS, and Web platforms.
 * ============================================================================
 */

import { PlayerSettings } from '../../utils/PlayerSettings.js';
import { storage } from '../../utils/StorageService.js';

/** Legacy 'NNNNp' values of the maxResolution setting, as width/height. */
const LEGACY_RESOLUTIONS = {
    '720p': { width: 1280, height: 720 },
    '1080p': { width: 1920, height: 1080 },
    '2160p': { width: 3840, height: 2160 },
    '4320p': { width: 7680, height: 4320 }
};

export class BaseProfile {
    /**
     * Parse the "Max resolution" player setting.
     *
     * The settings menu stores 'WIDTHxHEIGHT' values (e.g. '1920x1080'). The
     * 'NNNNp' form (e.g. '1080p') is also accepted, for older stored values.
     * @param {string} [value] - Setting value; defaults to the stored setting
     * @returns {{width: number, height: number}|null} null for 'auto' or an unrecognised value
     */
    static getMaxResolution(value = PlayerSettings.get('maxResolution')) {
        if (!value || value === 'auto') return null;
        const text = String(value).trim().toLowerCase();
        if (LEGACY_RESOLUTIONS[text]) return { ...LEGACY_RESOLUTIONS[text] };
        const match = /^(\d+)x(\d+)$/.exec(text);
        if (!match) return null;
        const width = parseInt(match[1], 10);
        const height = parseInt(match[2], 10);
        return width > 0 && height > 0 ? { width, height } : null;
    }

    /**
     * Whether a codec profile is a video size limit: a Video profile for every
     * codec and container whose conditions are only Width / Height limits.
     * Playback modes that drop codec restrictions keep it, because a video
     * larger than the panel can decode fails in every mode.
     * @param {Object} codecProfile - Entry of DeviceProfile.CodecProfiles
     * @returns {boolean}
     */
    static isVideoSizeLimitProfile(codecProfile) {
        return Boolean(
            codecProfile &&
            codecProfile.Type === 'Video' &&
            !codecProfile.Codec &&
            !codecProfile.Container &&
            Array.isArray(codecProfile.Conditions) &&
            codecProfile.Conditions.length > 0 &&
            codecProfile.Conditions.every((c) => c.Property === 'Width' || c.Property === 'Height')
        );
    }

    /**
     * Build the standard subtitle profiles array based on the subtitleBurnIn setting.
     * @returns {Array} List of subtitle profiles
     */
    static getSubtitleProfiles() {
        const subtitleBurnIn = PlayerSettings.get('subtitleBurnIn') || '';
        const pgsMode = PlayerSettings.get('pgsPlaybackMode') || 'client';

        const textSubtitleProfiles = [
            { Format: 'srt', Method: 'External' },
            { Format: 'subrip', Method: 'External' },
            { Format: 'vtt', Method: 'External' },
            { Format: 'smi', Method: 'External' },
            { Format: 'ttml', Method: 'External' },
            { Format: 'sub', Method: 'External' },
            { Format: 'vtt', Method: 'Hls' }
        ];

        const complexSubtitleMethod =
            subtitleBurnIn === 'all' || subtitleBurnIn === 'allcomplex' || subtitleBurnIn === 'auto'
                ? 'Encode'
                : 'External';

        const complexTextSubtitleProfiles = [
            { Format: 'ass', Method: complexSubtitleMethod },
            { Format: 'ssa', Method: complexSubtitleMethod }
        ];

        // ====================================================================
        // Bitmap subtitle delivery method:
        //
        // 'External' → Jellyfin serves the raw .sup/.vobsub file via the
        //   /Subtitles/{index}/Stream.sup endpoint. Our PGSRenderer fetches
        //   this directly and renders it as a canvas overlay, completely
        //   independent of the video pipeline. This is the correct mode when
        //   the client can handle PGS itself.
        //
        // 'Embed' → Jellyfin tries to mux the bitmap subtitle track into the
        //   output container. For HLS/TS transcodes this is IMPOSSIBLE, so
        //   the server falls back to burning the subtitles into the video
        //   frames (hard-encoding), which forces a full video transcode.
        //
        // 'Encode' → explicit burn-in: always encode into video frames.
        // ====================================================================
        let bitmapSubtitleMethod =
            subtitleBurnIn === 'all' || subtitleBurnIn === 'allcomplex' || subtitleBurnIn === 'auto'
                ? 'Encode'
                : 'External';

        if (pgsMode === 'burn') {
            bitmapSubtitleMethod = 'Encode';
        }

        // We MUST declare 'External' support for PGS even when the user selects 'disable',
        // otherwise Jellyfin will forcefully transcode the video to burn them in if a PGS
        // track is set as default. The UI will hide the track from the user, and SubtitleManager
        // will refuse to render it, achieving a clean 'disable' without breaking DirectPlay.
        const bitmapSubtitleProfiles = [
            { Format: 'pgs', Method: bitmapSubtitleMethod },
            { Format: 'pgssub', Method: bitmapSubtitleMethod },
            { Format: 'dvdsub', Method: bitmapSubtitleMethod },
            { Format: 'dvbsub', Method: bitmapSubtitleMethod }
        ];

        if (subtitleBurnIn === 'all') {
            return [
                { Format: 'srt', Method: 'Encode' },
                { Format: 'subrip', Method: 'Encode' },
                { Format: 'vtt', Method: 'Encode' },
                { Format: 'ass', Method: 'Encode' },
                { Format: 'ssa', Method: 'Encode' },
                { Format: 'smi', Method: 'Encode' },
                { Format: 'ttml', Method: 'Encode' },
                { Format: 'sub', Method: 'Encode' },
                ...bitmapSubtitleProfiles
            ];
        }

        return [
            ...textSubtitleProfiles,
            ...complexTextSubtitleProfiles,
            ...bitmapSubtitleProfiles,
            { Format: 'srt', Method: 'Embed' },
            { Format: 'subrip', Method: 'Embed' },
            { Format: 'vtt', Method: 'Embed' }
        ];
    }

    /**
     * Build standard response profiles.
     */
    static getResponseProfiles() {
        return [
            {
                Type: 'Video',
                Container: 'm4v',
                MimeType: 'video/mp4'
            },
            {
                Type: 'Video',
                Container: 'mkv',
                MimeType: 'video/x-matroska'
            }
        ];
    }

    /**
     * Generates or retrieves a persistent ID for the device based on a prefix.
     * @param {string} prefix e.g. 'litefin_webos_'
     */
    static getFallbackDeviceId(prefix) {
        let deviceId = storage.getItem('litefin_device_id');
        if (!deviceId) {
            deviceId = prefix + Date.now().toString(36) + Math.random().toString(36).substring(2);
            storage.setItem('litefin_device_id', deviceId);
        }
        return deviceId;
    }

    /**
     * AudioCodec values for the per-codec video TranscodingProfiles. Jellyfin does not treat E-AC-3
     * as an encode target (ffmpeg's encoder is worse than AC-3 at the same bitrate), so a profile
     * offering E-AC-3 alone gets that weaker encoder for other sources, and MP3 when an E-AC-3 source
     * has to be re-encoded (e.g. downmixed to stereo). Paired with the next codec, E-AC-3 is still
     * copied when it can be and the server encodes the next codec otherwise.
     * @param {string[]} codecs - Transcode audio codecs in order of preference
     * @returns {string[]} One AudioCodec value per transcoding profile
     */
    static getTranscodeAudioCodecs(codecs) {
        return codecs.map((codec, i) => (codec === 'eac3' && i + 1 < codecs.length ? `eac3,${codecs[i + 1]}` : codec));
    }
}
