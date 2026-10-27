/**
 * ============================================================================
 * Litefin - Stream Utilities & Track Resolution Engine
 * ============================================================================
 * Centralized track evaluation, language matching, and capability scoring.
 * Decoupled from JellyfinPlayer so pages (such as DetailsPage and PrewarmManager)
 * can evaluate streams, subtitle modes, and DirectPlay compatibility without
 * statically bundling heavy player engines or hls.js into the main bundle.
 * ============================================================================
 */

import { PlayerSettings } from '../../utils/PlayerSettings.js';
import { getDeviceCapabilities } from '../../api/DeviceProfile.js';
import { platformInfo } from '../../utils/PlatformInfo.js';
import { MediaHelper } from './MediaHelper.js';
import { storage } from '../../utils/StorageService.js';
import { auth } from '../../api/index.js';
import { languageManager } from '../../utils/LanguageManager.js';
import { AUDIO_FALLBACK_STORAGE_KEYS } from '../../utils/AudioFallbackConfig.js';
import { logger } from '../../utils/Logger.js';

const log = logger.create('StreamUtils');

// ============================================================================
// Audio Capability Detection Helpers
// ============================================================================

/**
 * Checks whether TrueHD audio decoding or passthrough is supported.
 * Evaluates user settings and queries hardware device profile on 'auto'.
 * @returns {boolean}
 */
export const isTrueHdSupported = () => {
    const setting = PlayerSettings.get('enableTrueHd');
    if (setting === 'enable') return true;
    if (setting === 'disable') return false;
    try {
        const caps = getDeviceCapabilities();
        return !!caps?.truehd;
    } catch (e) {
        return false;
    }
};

/**
 * Checks whether DTS audio decoding or passthrough is supported.
 * Evaluates user settings and queries hardware device profile on 'auto'.
 * @returns {boolean}
 */
export const isDtsSupported = () => {
    const setting = PlayerSettings.get('enableDts');
    if (setting === 'enable') return true;
    if (setting === 'disable') return false;
    try {
        const caps = getDeviceCapabilities();
        return !!caps?.dts;
    } catch (e) {
        return false;
    }
};

/**
 * Check whether an audio track is natively playable by the current device
 * and player settings without forcing a server transcode.
 *
 * Evaluates codec support, hardware channel constraints, user audio settings,
 * and media container compatibility against active device profiles.
 *
 * @param {Object} track - Jellyfin MediaStream object for an audio track
 * @param {Object|string} [mediaSource] - Optional parent MediaSource or backendType string
 * @param {string} [backendType] - Active backend ('tizen', 'webos', 'html5', 'avplay')
 * @returns {boolean} True if the track direct plays natively; false if it requires transcoding
 */
export function isAudioTrackNativelyPlayable(track, mediaSource = null, backendType = null) {
    // -------------------------------------------------------------------------
    // 0. Signature Flexibility & Argument Normalization
    // -------------------------------------------------------------------------
    if (typeof mediaSource === 'string' && backendType === null) {
        backendType = mediaSource;
        mediaSource = null;
    }

    // Guard: If track metadata or codec is missing, treat as playable to avoid breaking
    if (!track || !track.Codec) return true;

    // When forced transcoding is enabled (emergency fallback), all streams transcode
    if (PlayerSettings.get('forceTranscode')) {
        return false;
    }

    const codec = track.Codec.toLowerCase();
    const caps = getDeviceCapabilities();

    // -------------------------------------------------------------------------
    // Advanced Backend (ExoPlayer & MoviPlayer) Capabilities
    // -------------------------------------------------------------------------
    const isExo =
        backendType === 'exoplayer' ||
        (!backendType && (PlayerSettings.get('playerBackend') === 'exoplayer' || (typeof platformInfo !== 'undefined' && platformInfo.isAndroid)));

    const isMovi =
        backendType === 'movi' ||
        (!backendType && (PlayerSettings.get('playerBackend') === 'movi' || (typeof platformInfo !== 'undefined' && (platformInfo.isDesktop || platformInfo.isWeb) && platformInfo.hasWebCodecsSupport)));

    const isAdvancedBackend = isMovi || isExo;

    // -------------------------------------------------------------------------
    // 2. Active Playback Session / Transcoding Status Inspection
    // -------------------------------------------------------------------------
    if (mediaSource?.TranscodingUrl && !isAdvancedBackend) {
        const { isVideoDirect, isAudioDirect } = MediaHelper.getTranscodeStatus(mediaSource);

        const urlAudioIndexMatch = mediaSource.TranscodingUrl.match(/[?&]AudioStreamIndex=([^&]+)/);
        const activeUrlAudioIndex = urlAudioIndexMatch
            ? parseInt(urlAudioIndexMatch[1], 10)
            : (mediaSource.DefaultAudioStreamIndex ?? mediaSource.MediaStreams?.find((s) => s.Type === 'Audio' && s.IsDefault)?.Index);

        if (track.Index === activeUrlAudioIndex || activeUrlAudioIndex === undefined) {
            if (!isAudioDirect) {
                return false;
            }
        }

        const allowedAudioCodecsStr = (mediaSource.TranscodingUrl.match(/[?&]AudioCodec=([^&]+)/) || [])[1];
        if (allowedAudioCodecsStr) {
            const allowed = allowedAudioCodecsStr.toLowerCase().split(',').map((c) => c.trim());
            if (!allowed.includes(codec)) {
                return false;
            }
        }

        if (!isVideoDirect) {
            const HLS_TS_SAFE_AUDIO = new Set(['aac', 'ac3', 'eac3', 'mp3', 'mp2']);
            if (!HLS_TS_SAFE_AUDIO.has(codec)) {
                return false;
            }
        }
    }

    // -------------------------------------------------------------------------
    // 3. Maximum Audio Channels Resolution & Constraint Checking
    // -------------------------------------------------------------------------
    const userAllowedChannels = PlayerSettings.get('allowedAudioChannels');
    const effectiveMaxChannels = (userAllowedChannels && userAllowedChannels > 0)
        ? userAllowedChannels
        : (isAdvancedBackend ? 8 : caps?.maxAudioChannels);

    if (effectiveMaxChannels && typeof track.Channels === 'number' && track.Channels > effectiveMaxChannels) {
        return false;
    }

    if (codec === 'aac' && typeof track.Channels === 'number' && track.Channels > 6 && !isAdvancedBackend) {
        return false;
    }

    // -------------------------------------------------------------------------
    // 4. Container & Delivery Format Checks
    // -------------------------------------------------------------------------
    const container = (mediaSource?.Container || '').toLowerCase();

    const enablePcmInVideo = PlayerSettings.get('enablePcmInVideo');
    if ((codec.startsWith('pcm') || codec === 'wav') && !isAdvancedBackend && !enablePcmInVideo) {
        return false;
    }

    if (codec === 'vorbis' && container && container !== 'webm' && container !== 'ogg' && !isAdvancedBackend) {
        return false;
    }

    if (container === 'webm' && codec !== 'opus' && codec !== 'vorbis' && !isAdvancedBackend) {
        return false;
    }

    const isTizen = typeof platformInfo !== 'undefined' && platformInfo.isTizen;
    const isWebOS = typeof platformInfo !== 'undefined' && platformInfo.isWebOS;
    if (backendType === 'html5' || (!isTizen && !isWebOS && !isAdvancedBackend)) {
        const videoStream = mediaSource?.MediaStreams?.find((s) => s.Type === 'Video');
        if (videoStream?.Codec) {
            const vCodec = videoStream.Codec.toLowerCase();
            if (vCodec === 'av1' && !caps?.av1) {
                if (codec === 'opus' || codec === 'vorbis' || codec === 'flac') {
                    return false;
                }
            }
            if ((vCodec === 'hevc' || vCodec === 'h265') && !caps?.hevc) {
                if (codec === 'opus' || codec === 'vorbis' || codec === 'flac') {
                    return false;
                }
            }
        }
    }

    // -------------------------------------------------------------------------
    // 5. Codec-Specific Native Hardware & Settings Validation
    // -------------------------------------------------------------------------
    if (isAdvancedBackend) {
        if (codec === 'flac' || codec === 'alac') return true;
        if (codec.includes('dts') || codec === 'dca') {
            const setting = PlayerSettings.get('enableDts');
            return setting !== 'disable';
        }
        if (codec === 'truehd' || codec === 'mlp') {
            const setting = PlayerSettings.get('enableTrueHd');
            return setting !== 'disable';
        }
        if (codec === 'eac3' || codec === 'ec-3') {
            const setting = PlayerSettings.get('enableEac3');
            return setting !== 'disable';
        }
        if (codec === 'ac3') return true;
        if (codec === 'opus' || codec === 'vorbis') return true;
        if (codec.startsWith('pcm') || codec === 'wav') return true;
        if (codec === 'mp2' || codec === 'mp1l2') {
            const setting = PlayerSettings.get('enableMp2');
            return setting !== 'disable';
        }
        if (codec === 'aac' || codec === 'mp3') return true;
        if (codec.includes('wma')) return isMovi || !!caps?.wma;
        return false;
    }

    // Standard backend validation (HTML5 / Tizen AVPlay / WebOS):
    if (codec === 'flac' || codec === 'alac') {
        const isWebOSNative =
            backendType === 'webos' || (!backendType && isWebOS && PlayerSettings.get('playerBackend') !== 'html5');
        if (codec === 'flac' && isWebOSNative) {
            return !(track.Channels > 2);
        }
        return PlayerSettings.get('enableFlacInVideo') === true;
    }

    if (codec.startsWith('pcm') || codec === 'wav') {
        const isTizenPlatform = typeof platformInfo !== 'undefined' && platformInfo.isTizen;
        const isTizenActive = backendType === 'tizen' || backendType === 'avplay' || isTizenPlatform;
        return isTizenActive && Boolean(PlayerSettings.get('enablePcmInVideo'));
    }

    if (codec.includes('dts') || codec === 'dca') {
        return isDtsSupported();
    }

    if (codec === 'truehd' || codec === 'mlp') {
        return isTrueHdSupported();
    }

    if (codec === 'eac3' || codec === 'ec-3') {
        const setting = PlayerSettings.get('enableEac3');
        if (setting === 'enable') return true;
        if (setting === 'disable') return false;
        try {
            return caps?.eac3 !== false;
        } catch (e) {
            return true;
        }
    }

    if (codec === 'ac3') {
        try {
            return caps?.ac3 !== false;
        } catch (e) {
            return true;
        }
    }

    if (codec === 'mp2' || codec === 'mp1l2') {
        const setting = PlayerSettings.get('enableMp2');
        if (setting === 'enable') return true;
        if (setting === 'disable') return false;
        try {
            return !!caps?.mp2;
        } catch (e) {
            return false;
        }
    }

    if (codec === 'opus') {
        const isTizenPlatform = typeof platformInfo !== 'undefined' && platformInfo.isTizen;
        if (backendType === 'tizen' || backendType === 'avplay' || isTizenPlatform) {
            return caps?.opus !== false;
        }
        if (container && container !== 'webm' && container !== 'ogg' && container !== 'opus') {
            return false;
        }
        return caps?.opus !== false;
    }

    if (codec === 'vorbis') {
        return container === 'webm' || container === 'ogg';
    }

    if (codec.includes('wma')) {
        return !!caps?.wma;
    }

    if (codec === 'aac_latm') {
        return backendType === 'tizen' || backendType === 'avplay';
    }

    if (codec === 'aac' || codec === 'mp3') {
        return true;
    }

    return false;
}

/**
 * Matches media stream languages across 2-letter ISO, 3-letter ISO, regional prefixes,
 * and track metadata titles using the centralized LanguageManager cache.
 *
 * @param {string|Object} trackOrLang - Language tag string or media stream object
 * @param {string} targetLanguage - Target language tag or name to match against
 * @returns {boolean} True if the languages represent a match
 */
export const isLanguageMatch = (trackOrLang, targetLanguage) => {
    if (!trackOrLang || !targetLanguage) return false;

    const trackLang = typeof trackOrLang === 'object' ? trackOrLang.Language : trackOrLang;
    const trackTitle = typeof trackOrLang === 'object' ? (trackOrLang.Title || '') : '';
    const trackDisplayTitle = typeof trackOrLang === 'object' ? (trackOrLang.DisplayTitle || '') : '';

    const cleanTarget = String(targetLanguage).trim().toLowerCase();

    // 1. Direct language code match if trackLang is available
    if (trackLang) {
        const cleanTrack = String(trackLang).trim().toLowerCase();
        if (cleanTrack === cleanTarget) return true;

        if (typeof languageManager !== 'undefined' && typeof languageManager?.normalizeLanguage === 'function') {
            const normTrack = languageManager.normalizeLanguage(cleanTrack);
            const normTarget = languageManager.normalizeLanguage(cleanTarget);
            if (normTrack && normTarget) {
                if (normTrack.code && normTarget.code && normTrack.code.toLowerCase() === normTarget.code.toLowerCase()) {
                    return true;
                }
                if (normTrack.twoLetter && normTarget.twoLetter && normTrack.twoLetter.toLowerCase() === normTarget.twoLetter.toLowerCase()) {
                    return true;
                }
            }
        }

        if (cleanTrack.length >= 2 && cleanTarget.length >= 2 && cleanTrack.slice(0, 2) === cleanTarget.slice(0, 2)) {
            return true;
        }
    }

    // 2. Title / DisplayTitle Fallback Matching
    if (trackTitle || trackDisplayTitle) {
        const combinedTitle = `${trackTitle} ${trackDisplayTitle}`.toLowerCase();
        if (combinedTitle.includes(cleanTarget)) {
            return true;
        }

        if (typeof languageManager !== 'undefined' && typeof languageManager?.normalizeLanguage === 'function') {
            const normTarget = languageManager.normalizeLanguage(cleanTarget);
            if (normTarget) {
                if (normTarget.name && combinedTitle.includes(normTarget.name.toLowerCase())) {
                    return true;
                }
                if (normTarget.nativeName && combinedTitle.includes(normTarget.nativeName.toLowerCase())) {
                    return true;
                }
                if (normTarget.code && new RegExp(`\\b${normTarget.code}\\b`, 'i').test(combinedTitle)) {
                    return true;
                }
            }
        }
    }

    return false;
};

/**
 * Resolves the effective subtitle mode taking into account the server user's
 * configured SubtitleMode when Litefin is set to 'Default' (Server Preference).
 *
 * @param {string} [mode] - Active client subtitle mode setting
 * @returns {string} Effective subtitle mode ('None', 'OnlyForced', 'Default', 'Always', 'Smart')
 */
export function getEffectiveSubtitleMode(mode) {
    const rawClientMode = mode || PlayerSettings.get('subtitleMode') || 'Default';
    const cleanClient = String(rawClientMode).trim().toLowerCase();

    if (cleanClient === 'default') {
        const currentUser = auth?.getCurrentUser?.();
        const serverMode = currentUser?.Configuration?.SubtitleMode;
        if (serverMode) {
            const cleanServer = String(serverMode).trim().toLowerCase();
            if (cleanServer === 'always') return 'Always';
            if (cleanServer === 'onlyforced' || cleanServer === 'only_forced' || cleanServer === 'forced') return 'OnlyForced';
            if (cleanServer === 'none' || cleanServer === 'off') return 'None';
            if (cleanServer === 'smart') return 'Smart';
        }
        return 'Default';
    }

    if (cleanClient === 'always') return 'Always';
    if (cleanClient === 'onlyforced' || cleanClient === 'only_forced' || cleanClient === 'forced') return 'OnlyForced';
    if (cleanClient === 'none' || cleanClient === 'off') return 'None';
    if (cleanClient === 'smart') return 'Smart';

    return 'Default';
}

/**
 * Determine if a subtitle stream is flagged or designated as forced.
 *
 * @param {Object} stream - Subtitle stream metadata object
 * @returns {boolean} True if the track is forced
 */
export function isForcedStream(stream) {
    if (!stream || typeof stream !== 'object') return false;
    if (stream.IsForced === true || stream.Forced === true) return true;

    const title = stream.Title || '';
    const displayTitle = stream.DisplayTitle || '';
    return /\bforced\b/i.test(title) || /\bforced\b/i.test(displayTitle);
}

/**
 * Automatically resolve the target subtitle track for a media source
 * based on user subtitle mode, preferred subtitle language, and active audio language.
 *
 * @param {Object} mediaSource - Jellyfin MediaSource object containing MediaStreams
 * @param {Object} [options] - Resolution options
 * @returns {number} Resolved stream index, or -1 if subtitles should remain off
 */
export function resolveSubtitleStream(mediaSource, options = {}) {
    if (!mediaSource || !Array.isArray(mediaSource.MediaStreams)) {
        return -1;
    }

    const rawMode = options.subtitleMode || PlayerSettings.get('subtitleMode') || 'Default';
    const subtitleMode = getEffectiveSubtitleMode(rawMode);

    if (subtitleMode === 'None') {
        return -1;
    }

    const disablePgs = PlayerSettings.get('pgsPlaybackMode') === 'disable';
    const subtitleStreams = mediaSource.MediaStreams.filter((s) => {
        if (s.Type !== 'Subtitle') return false;
        if (disablePgs) {
            const codec = (s.Codec || '').toLowerCase();
            if (codec === 'pgs' || codec === 'pgssub') return false;
        }
        return true;
    });

    if (subtitleStreams.length === 0) {
        return -1;
    }

    const getCodecPriority = (codec) => {
        const c = (codec || '').toLowerCase();
        if (c === 'ass' || c === 'ssa') return 4;
        if (c === 'srt' || c === 'subrip') return 3;
        if (c === 'pgs' || c === 'pgssub') return 2;
        return 1;
    };

    subtitleStreams.sort((a, b) => {
        const aExt = !!a.IsExternal;
        const bExt = !!b.IsExternal;
        if (aExt !== bExt) return aExt ? -1 : 1;
        const aPriority = getCodecPriority(a.Codec);
        const bPriority = getCodecPriority(b.Codec);
        if (aPriority !== bPriority) return bPriority - aPriority;
        return 0;
    });

    if (subtitleMode === 'Default') {
        const serverDefaultTrack =
            mediaSource.DefaultSubtitleStreamIndex !== undefined && mediaSource.DefaultSubtitleStreamIndex !== null
                ? mediaSource.MediaStreams.find((s) => s.Index === mediaSource.DefaultSubtitleStreamIndex)
                : null;
        const isServerDefaultPgs =
            serverDefaultTrack &&
            ((serverDefaultTrack.Codec || '').toLowerCase() === 'pgs' ||
                (serverDefaultTrack.Codec || '').toLowerCase() === 'pgssub');

        if (
            mediaSource.DefaultSubtitleStreamIndex !== undefined &&
            mediaSource.DefaultSubtitleStreamIndex !== null &&
            !(disablePgs && isServerDefaultPgs)
        ) {
            return mediaSource.DefaultSubtitleStreamIndex;
        }

        const subStream = subtitleStreams.find((s) => s.IsDefault || isForcedStream(s));
        return subStream ? subStream.Index : -1;
    }

    let prefLang = options.prefLang || storage.getItem('pref:subtitleLang');
    if (!prefLang || prefLang === 'none' || prefLang === 'Default' || prefLang === 'default') {
        const currentUser = auth?.getCurrentUser?.();
        const serverSubLang = currentUser?.Configuration?.SubtitleLanguagePreference;
        if (serverSubLang && serverSubLang !== 'none' && serverSubLang !== 'Default') {
            prefLang = serverSubLang;
        } else {
            prefLang = 'none';
        }
    }

    const defaultAudioStream =
        (mediaSource.MediaStreams || []).find((s) => s.Type === 'Audio' && s.IsDefault) ||
        (mediaSource.MediaStreams || []).find((s) => s.Type === 'Audio' && s.Index === mediaSource.DefaultAudioStreamIndex) ||
        (mediaSource.MediaStreams || []).find((s) => s.Type === 'Audio');

    const audioStreamIndex =
        options.audioStreamIndex !== undefined && options.audioStreamIndex !== null
            ? options.audioStreamIndex
            : defaultAudioStream?.Index;

    const audioStream = mediaSource.MediaStreams.find(
        (s) => s.Type === 'Audio' && s.Index === audioStreamIndex
    );
    const audioLang = audioStream ? audioStream.Language || 'und' : 'und';

    if (subtitleMode === 'OnlyForced') {
        let forced = null;
        if (prefLang && prefLang !== 'none') {
            forced = subtitleStreams.find((s) => isForcedStream(s) && isLanguageMatch(s, prefLang));
        }
        if (!forced && audioLang && audioLang !== 'und') {
            forced = subtitleStreams.find((s) => isForcedStream(s) && isLanguageMatch(s, audioLang));
        }
        if (!forced) {
            forced = subtitleStreams.find((s) => isForcedStream(s));
        }
        return forced ? forced.Index : -1;
    }

    if (subtitleMode === 'Always') {
        let best = undefined;

        if (PlayerSettings.get('preferExternalSubtitles')) {
            const externalStreams = subtitleStreams.filter((s) => s.IsExternal);
            if (externalStreams.length > 0) {
                if (prefLang && prefLang !== 'none') {
                    best = externalStreams.find(
                        (s) => isLanguageMatch(s, prefLang) && (s.IsDefault || isForcedStream(s))
                    );
                    if (!best) {
                        best = externalStreams.find((s) => isLanguageMatch(s, prefLang));
                    }
                }
                if (!best) {
                    best = externalStreams.find((s) => {
                        const lang = (s.Language || '').toLowerCase();
                        return !lang || lang === 'und' || lang === 'unknown' || lang === 'none';
                    });
                }
            }
        }

        if (!best) {
            if (prefLang && prefLang !== 'none') {
                best = subtitleStreams.find(
                    (s) => isLanguageMatch(s, prefLang) && (s.IsDefault || isForcedStream(s))
                );
                if (!best) {
                    best = subtitleStreams.find((s) => isLanguageMatch(s, prefLang));
                }
            }
            if (!best) {
                best = subtitleStreams.find((s) => s.IsDefault || isForcedStream(s));
            }
            if (!best && subtitleStreams.length > 0) {
                best = subtitleStreams[0];
            }
        }

        return best ? best.Index : -1;
    }

    if (subtitleMode === 'Smart') {
        if (prefLang !== 'none' && !isLanguageMatch(audioLang, prefLang)) {
            let best = subtitleStreams.find(
                (s) => isLanguageMatch(s, prefLang) && (s.IsDefault || isForcedStream(s))
            );
            if (!best) {
                best = subtitleStreams.find((s) => isLanguageMatch(s, prefLang));
            }
            if (best) return best.Index;
        }

        let forced = null;
        if (prefLang && prefLang !== 'none') {
            forced = subtitleStreams.find((s) => isForcedStream(s) && isLanguageMatch(s, prefLang));
        }
        if (!forced && audioLang && audioLang !== 'und') {
            forced = subtitleStreams.find((s) => isForcedStream(s) && isLanguageMatch(s, audioLang));
        }
        if (!forced) {
            forced = subtitleStreams.find((s) => isForcedStream(s));
        }
        return forced ? forced.Index : -1;
    }

    return -1;
}

/**
 * Automatically resolve the best audio track for a given media source.
 *
 * @param {Object} mediaSource - Jellyfin MediaSource object containing MediaStreams
 * @param {string} [targetLang] - Optional language ISO code override
 * @param {string} [backendType] - Active player backend type
 * @returns {Object|null} The resolved best audio MediaStream object, or null
 */
export function resolveBestAudioStream(mediaSource, targetLang, backendType = null) {
    if (!mediaSource || !Array.isArray(mediaSource.MediaStreams)) {
        return null;
    }

    const audioStreams = mediaSource.MediaStreams.filter((s) => s.Type === 'Audio');
    if (audioStreams.length === 0) {
        return null;
    }

    const standardDefaultTrack =
        audioStreams.find((s) => s.IsDefault) ||
        (mediaSource.DefaultAudioStreamIndex !== undefined && mediaSource.DefaultAudioStreamIndex !== null
            ? audioStreams.find((s) => s.Index === mediaSource.DefaultAudioStreamIndex)
            : null) ||
        audioStreams[0];

    const getCodecScore = (codec) => {
        const c = (codec || '').toLowerCase();
        if (c === 'truehd') return 95;
        if (c.includes('dts-hd') || c.includes('dtshd') || c.includes('dts-ma') || c.includes('dts-x') || c.includes('dtsx')) return 90;
        if (c === 'flac' || c === 'alac') return 80;
        if (c.includes('dts') || c === 'dca') return 70;
        if (c === 'eac3') return 50;
        if (c === 'ac3') return 40;
        if (c === 'opus') return 35;
        if (c === 'aac') return 30;
        if (c === 'mp3') return 20;
        return 10;
    };

    const scoreTrack = (track) => {
        let score = 0;
        const title = (track.Title || '').toLowerCase();
        const displayTitle = (track.DisplayTitle || '').toLowerCase();

        const isCommentary =
            title.includes('commentary') ||
            displayTitle.includes('commentary') ||
            track.DeliveryMethod === 'Commentary';
        const isDescriptive =
            title.includes('description') ||
            title.includes('visual') ||
            displayTitle.includes('descriptive') ||
            displayTitle.includes('visually impaired');

        if (!isCommentary && !isDescriptive) {
            score += 1000;
        }

        const channels = Number(track.Channels) || 2;
        score += channels * 20;
        score += getCodecScore(track.Codec);

        if (track.IsDefault) {
            score += 5;
        }

        const bitrate = Number(track.BitRate) || 0;
        score += Math.min(bitrate / 100000, 10);

        return score;
    };

    const pickBestTrack = (tracks) => {
        if (!tracks || tracks.length === 0) return null;
        if (tracks.length === 1) return tracks[0];
        const scored = tracks.map((track) => ({ track, score: scoreTrack(track) }));
        scored.sort((a, b) => b.score - a.score);
        return scored[0].track;
    };

    const preferDirectPlay = PlayerSettings.get('preferDirectPlayAudio') !== false;
    const userPrefLang = storage.getItem('pref:audioLang');
    const explicitTargetLang = (targetLang && targetLang !== 'Default' && targetLang !== 'none') ? targetLang : null;

    const selectTrackForLanguage = (lang) => {
        const matchingTracks = audioStreams.filter((t) => isLanguageMatch(t.Language, lang));
        if (matchingTracks.length === 0) return null;

        if (preferDirectPlay) {
            const playablePreferred = matchingTracks.filter((t) => isAudioTrackNativelyPlayable(t, mediaSource, backendType));
            if (playablePreferred.length > 0) return pickBestTrack(playablePreferred);
            return pickBestTrack(matchingTracks);
        }

        return pickBestTrack(matchingTracks);
    };

    let languageChain = [];
    if (explicitTargetLang) {
        languageChain = [explicitTargetLang];
    } else {
        const globalPref = (userPrefLang && userPrefLang !== 'Default' && userPrefLang !== 'none') ? userPrefLang : null;
        if (globalPref) languageChain.push(globalPref);

        for (const key of AUDIO_FALLBACK_STORAGE_KEYS) {
            const value = storage.getItem(key);
            if (value && value !== 'Default' && value !== 'none') {
                languageChain.push(value);
            }
        }
    }

    const seenLanguages = new Set();
    languageChain = languageChain.filter((lang) => {
        const id = String(lang).trim().toLowerCase();
        if (seenLanguages.has(id)) return false;
        seenLanguages.add(id);
        return true;
    });

    for (const lang of languageChain) {
        const chosenTrack = selectTrackForLanguage(lang);
        if (chosenTrack) {
            log.info(
                `[AudioTrackSelector] Selected audio track Index ${chosenTrack.Index} ` +
                `(${chosenTrack.Codec}, ${chosenTrack.Channels || 2}ch, ${chosenTrack.Language || 'und'}) ` +
                `matching language '${lang}' (container default was Index ${standardDefaultTrack?.Index})`
            );
            return chosenTrack;
        }
    }

    if (!preferDirectPlay) {
        return standardDefaultTrack;
    }

    const defaultLang = standardDefaultTrack?.Language || 'und';
    const sameLangTracks = audioStreams.filter(
        (t) => isLanguageMatch(t.Language, defaultLang) || (defaultLang === 'und' && (!t.Language || t.Language === 'und'))
    );
    const sameLangPlayable = sameLangTracks.filter((t) => isAudioTrackNativelyPlayable(t, mediaSource, backendType));

    const isDefaultPlayable = standardDefaultTrack && isAudioTrackNativelyPlayable(standardDefaultTrack, mediaSource, backendType);
    if (isDefaultPlayable) {
        if (sameLangPlayable.length > 1) {
            const bestPlayable = pickBestTrack(sameLangPlayable);
            const isHighFidelityUpgrade = bestPlayable &&
                getCodecScore(bestPlayable.Codec) >= 70 &&
                getCodecScore(bestPlayable.Codec) > getCodecScore(standardDefaultTrack.Codec);

            if (isHighFidelityUpgrade && scoreTrack(bestPlayable) > scoreTrack(standardDefaultTrack)) {
                log.info(
                    `[AudioTrackSelector] Upgraded playable default track Index ${standardDefaultTrack.Index} ` +
                    `to higher-fidelity playable track Index ${bestPlayable.Index} (${bestPlayable.Codec}, ${bestPlayable.Channels || 2}ch)`
                );
                return bestPlayable;
            }
        }
        return standardDefaultTrack;
    }

    if (sameLangPlayable.length > 0) {
        const bestPlayable = pickBestTrack(sameLangPlayable);
        log.info(
            `[AudioTrackSelector] Selected compatible DirectPlay track Index ${bestPlayable.Index} ` +
            `(${bestPlayable.Codec}, ${bestPlayable.Channels || 2}ch) in place of transcode-inducing default Index ${standardDefaultTrack?.Index}`
        );
        return bestPlayable;
    }

    return standardDefaultTrack;
}

// ────────────────────────────────────────────────────────────────────────────
// Containers Without Audio Track Lists
// ────────────────────────────────────────────────────────────────────────────
const containersWithoutAudioTracks = {};

function audioTrackContainerKey(backendType, container) {
    const name = String(container || '').toLowerCase();
    return name ? `${backendType}:${name}` : null;
}

export function rememberContainerWithoutAudioTracks(backendType, container) {
    const key = audioTrackContainerKey(backendType, container);
    if (key) containersWithoutAudioTracks[key] = true;
}

export function hasContainerWithoutAudioTracks(backendType, container) {
    const key = audioTrackContainerKey(backendType, container);
    return Boolean(key && containersWithoutAudioTracks[key]);
}

/**
 * Determine whether playing a specific audio track requires server DirectStream (remux)
 * rather than raw DirectPlay (Static=true).
 *
 * @param {Object} mediaSource - Jellyfin MediaSource object
 * @param {number|string} audioStreamIndex - Stream Index to evaluate
 * @param {string} backendType - Active backend ('webos', 'html5', 'avplay', etc.)
 * @returns {boolean} True if the track requires DirectStream (remux)
 */
export function doesAudioTrackRequireDirectStream(mediaSource, audioStreamIndex, backendType) {
    if (!mediaSource || !Array.isArray(mediaSource.MediaStreams)) {
        return false;
    }

    const audioStreams = mediaSource.MediaStreams.filter((s) => s.Type === 'Audio');
    if (audioStreams.length === 0) {
        return false;
    }

    const reqIndex = Number(audioStreamIndex);
    const targetStream = audioStreams.find((s) => s.Index === reqIndex) || audioStreams[0];
    if (!targetStream) {
        return false;
    }

    if (!isAudioTrackNativelyPlayable(targetStream, mediaSource, backendType)) {
        return true;
    }

    if (backendType === 'avplay' || backendType === 'tizen' || backendType === 'movi' || backendType === 'exoplayer') {
        return false;
    }

    if (audioStreams.length <= 1) {
        return false;
    }

    const physicalDefaultStream = audioStreams.find((s) => s.IsDefault) || audioStreams[0];
    if (physicalDefaultStream && !isAudioTrackNativelyPlayable(physicalDefaultStream, mediaSource, backendType)) {
        return true;
    }

    // If the requested track matches the container's physical default track,
    // and that track is confirmed natively playable, DirectPlay operates natively.
    if (physicalDefaultStream && targetStream.Index === physicalDefaultStream.Index) {
        return false;
    }

    // Direct play of this container already came back without video.audioTracks
    // on this backend, so a non-default track cannot be switched to natively.
    if (hasContainerWithoutAudioTracks(backendType, mediaSource.Container)) {
        return true;
    }

    // Chromium's media demuxer drops passthrough/bitstream audio codecs from the
    // native HTML5 video.audioTracks collection (DTS, TrueHD, FLAC, ALAC).
    // On WebOS and HTML5, the browser cannot switch to non-default tracks of these
    // formats in DirectPlay mode without server remuxing isolating the audio stream.
    const codec = (targetStream.Codec || '').toLowerCase();
    const isPassthroughOrDropped =
        codec.includes('dts') ||
        codec === 'dca' ||
        codec === 'truehd' ||
        codec === 'flac' ||
        codec === 'alac';

    if (isPassthroughOrDropped) {
        return true;
    }

    return false;
}
