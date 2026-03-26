/**
 * MediaHelper - Utility functions for media handling
 *
 * Extracted and simplified from jellyfin-web's htmlMediaHelper.js
 * Provides stream URL building, HLS detection, and media utilities.
 *
 * @module core/MediaHelper
 */

// ============================================================================
// Stream URL Building
// ============================================================================

import { storage } from '../../utils/StorageService.js';

export const MediaHelper = {
    /**
     * Build stream URL for playback
     *
     * @param {Object} options - Build options
     * @param {string} options.serverUrl - Jellyfin server URL
     * @param {string} options.itemId - Item ID
     * @param {Object} options.mediaSource - Media source info
     * @param {number} options.startPositionTicks - Start position
     * @param {string} options.playSessionId - Play session ID
     * @param {string} options.authToken - Auth token
     * @returns {Object} Stream info with URL and metadata
     */
    buildStreamUrl(options) {
        const { serverUrl, itemId, mediaSource, startPositionTicks, playSessionId, authToken, audioStreamIndex } = options;

        // Determine play method
        const playMethod = this.getPlayMethod(mediaSource);

        let url;
        let isHls = false;

        if (playMethod === 'DirectPlay' || playMethod === 'DirectStream') {
            // For DirectStream, always prefer the server-provided TranscodingUrl —
            // it has AudioStreamIndex, SubtitleStreamIndex, and all session params
            // baked in.  For DirectPlay, build the static URL directly (TranscodingUrl
            // may be an HLS manifest the native player can't handle).
            if (playMethod === 'DirectStream' && mediaSource.TranscodingUrl) {
                url = serverUrl + mediaSource.TranscodingUrl;
                isHls = url.includes('.m3u8');
            } else if (mediaSource.SupportsDirectStream) {
                // Static-serve the container file as-is
                url = `${serverUrl}/Videos/${itemId}/stream.${mediaSource.Container}`;
                url += `?Static=true`;
                url += `&mediaSourceId=${encodeURIComponent(mediaSource.Id)}`;
                url += `&api_key=${encodeURIComponent(authToken)}`;
                if (audioStreamIndex !== undefined && audioStreamIndex !== null) {
                    url += `&AudioStreamIndex=${audioStreamIndex}`;
                }
            } else if (mediaSource.SupportsDirectPlay && mediaSource.Path) {
                // Local/SMB file path (native-app only, not used in browser)
                url = mediaSource.Path;
            }
        } else {
            // Transcode: HLS from server or HTTP stream (for audio).
            // Prefer the pre-built TranscodingUrl — it has AudioStreamIndex,
            // SubtitleStreamIndex, codec params, etc. already embedded.
            if (mediaSource.TranscodingUrl) {
                url = serverUrl + mediaSource.TranscodingUrl;
                isHls = url.includes('.m3u8') || (mediaSource.TranscodingSubProtocol && mediaSource.TranscodingSubProtocol.toLowerCase() === 'hls');
            } else {
                // Manual HLS URL fallback
                url = `${serverUrl}/Videos/${itemId}/master.m3u8`;
                url += `?mediaSourceId=${encodeURIComponent(mediaSource.Id)}`;
                url += `&PlaySessionId=${encodeURIComponent(playSessionId)}`;
                url += `&api_key=${encodeURIComponent(authToken)}`;
                url += `&StartTimeTicks=${startPositionTicks || 0}`;
                if (audioStreamIndex !== undefined && audioStreamIndex !== null) {
                    url += `&AudioStreamIndex=${audioStreamIndex}`;
                }
                isHls = true;
            }
        }

        return {
            url,
            playMethod,
            isHls,
            mediaSource,
            transcodingOffsetTicks: playMethod === 'Transcode' ? startPositionTicks : 0,
            playerStartPositionTicks: playMethod === 'Transcode' ? 0 : startPositionTicks
        };
    },

    /**
     * Determine play method based on media source.
     * Aligned with jellyfin-web/src/components/playback/playmethodhelper.js
     * 
     * @param {Object} mediaSource
     * @returns {string} 'DirectPlay', 'Remux', 'DirectStream', or 'Transcode'
     */
    getPlayMethod(mediaSource) {
        const { isVideoDirect, isAudioDirect } = this.getTranscodeStatus(mediaSource);

        if (isVideoDirect && isAudioDirect) {
            // Both streams are direct. If it's the original file, it's DirectPlay.
            // If it's being repackaged (DirectStream), we call it Remux.
            return mediaSource.SupportsDirectPlay ? 'DirectPlay' : 'Remux';
        }

        if (isVideoDirect) {
            // Video is direct, but audio is being transcoded.
            return 'DirectStream';
        }

        // Full transcoding (video + usually audio).
        return 'Transcode';
    },

    /**
     * Get granular transcode status for video and audio.
     *
     * Jellyfin's `TranscodingInfo` is only present on MediaSource objects received
     * via the session WebSocket hub — it is NOT included in the PlaybackInfo API
     * response. When it's absent, we fall back to parsing the `TranscodeReasons`
     * query parameter from the TranscodingUrl, which IS always present.
     *
     * @param {Object} mediaSource
     * @returns {{ isVideoDirect: boolean, isAudioDirect: boolean }}
     */
    getTranscodeStatus(mediaSource) {
        const transcodeInfo = mediaSource.TranscodingInfo;

        // Prefer server-provided TranscodingInfo when available (session hub updates)
        if (transcodeInfo) {
            return {
                isVideoDirect: !!(transcodeInfo.IsVideoDirect || !transcodeInfo.VideoCodec),
                isAudioDirect: !!transcodeInfo.IsAudioDirect
            };
        }

        // No TranscodingUrl at all → DirectPlay (original file served directly)
        const transcodeUrl = mediaSource.TranscodingUrl;
        if (!transcodeUrl) {
            return { isVideoDirect: true, isAudioDirect: true };
        }

        // Parse TranscodeReasons from the URL — Jellyfin always includes this
        // when transcoding is required.
        const reasonsMatch = transcodeUrl.match(/[?&]TranscodeReasons=([^&]+)/);
        if (!reasonsMatch) {
            // URL exists but no reason listed → conservatively assume full transcode
            return { isVideoDirect: false, isAudioDirect: false };
        }

        const reasonList = decodeURIComponent(reasonsMatch[1]).split(',').map(r => r.trim());

        // These reasons require the VIDEO track to be re-encoded.
        // If any of these are present, video is NOT directly copied.
        const VIDEO_REASONS = new Set([
            'VideoCodecNotSupported',
            'VideoProfileNotSupported',
            'VideoLevelNotSupported',
            'VideoChannelNotSupported',
            'VideoResolutionNotSupported',
            'AnamorphicVideoNotSupported',
            // Subtitle burn-in forces a video encode pass
            'SubtitleCodecNotSupported',
            'UnknownVideoStreamInfo'
        ]);

        // These reasons only affect the AUDIO track — video can still be copied.
        const AUDIO_ONLY_REASONS = new Set([
            'AudioCodecNotSupported',
            'AudioChannelsNotSupported',
            'AudioBitrateNotSupported',
            'AudioSampleRateNotSupported',
            'AudioBitDepthNotSupported',
            'AudioProfileNotSupported'
        ]);

        const hasVideoReason   = reasonList.some(r => VIDEO_REASONS.has(r));
        const hasAudioReason   = reasonList.some(r => AUDIO_ONLY_REASONS.has(r));

        return {
            isVideoDirect: !hasVideoReason,
            isAudioDirect: !hasAudioReason
        };
    },


    /**
     * Check if media source uses HLS
     * @param {Object} mediaSource
     * @returns {boolean}
     */
    isHls(mediaSource) {
        const protocol = mediaSource?.TranscodingSubProtocol?.toLowerCase();
        return protocol === 'hls' || (mediaSource?.TranscodingUrl && mediaSource.TranscodingUrl.includes('.m3u8'));
    },

    /**
     * Get subtitle track URL from the Jellyfin API
     * @param {Object} track - Subtitle track
     * @param {string} serverUrl - Server URL
     * @param {string} itemId - Item ID
     * @param {string} mediaSourceId - Media source ID
     * @param {string} authToken - Auth token
     * @param {string} [format='vtt'] - Desired format
     * @returns {string} Subtitle URL
     */
    getSubtitleUrl(track, serverUrl, itemId, mediaSourceId, authToken, format = 'vtt') {
        // Canonical Jellyfin API path:
        // /Videos/{itemId}/{mediaSourceId}/Subtitles/{streamIndex}/0/Stream.{format}
        //                                                          ↑ start-position offset, always 0 for full-file subtitle fetches.
        //
        // The server's own DeliveryUrl includes this segment — omitting it causes
        // some server versions or proxy configs to 404, especially for .sup (PGS) fetches
        // that don't go through the standard subtitle transcode pipeline.
        const streamIndex = track.Index;
        let url = `${serverUrl}/Videos/${itemId}/${mediaSourceId}/Subtitles/${streamIndex}/0/Stream.${format}`;
        url += `?api_key=${encodeURIComponent(authToken)}`;
        return url;
    },

    // ========================================================================
    // Volume Helpers
    // ========================================================================

    /**
     * Get saved volume from storage
     * @returns {number} Volume (0-1)
     */
    getSavedVolume() {
        const stored = storage.getItem('jellyfin-player-volume');
        return stored ? parseFloat(stored) : 1;
    },

    /**
     * Save volume to storage
     * @param {number} value - Volume (0-1)
     */
    saveVolume(value) {
        if (typeof value === 'number') {
            storage.setItem('jellyfin-player-volume', value.toString());
        }
    },

    // ========================================================================
    // Duration Helpers
    // ========================================================================

    /**
     * Check if duration value is valid
     * @param {number} duration
     * @returns {boolean}
     */
    isValidDuration(duration) {
        return duration && !isNaN(duration) && duration !== Infinity && duration !== -Infinity;
    },

    /**
     * Format ticks to display time
     * @param {number} ticks
     * @returns {string}
     */
    ticksToTime(ticks) {
        const totalSeconds = Math.floor(ticks / 10000000);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;

        if (hours > 0) {
            return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        }
        return `${minutes}:${seconds.toString().padStart(2, '0')}`;
    },

    /**
     * Get buffered ranges from media element
     * @param {HTMLMediaElement} elem
     * @param {number} [offsetTicks=0]
     * @returns {Array<{start: number, end: number}>}
     */
    getBufferedRanges(elem, offsetTicks = 0) {
        const ranges = [];
        const buffered = elem.buffered || [];

        for (let i = 0; i < buffered.length; i++) {
            const start = buffered.start(i);
            const end = buffered.end(i);

            if (this.isValidDuration(start) && this.isValidDuration(end)) {
                ranges.push({
                    start: start * 10000000 + offsetTicks,
                    end: end * 10000000 + offsetTicks
                });
            }
        }

        return ranges;
    },

    // ========================================================================
    // Cross-Origin Helpers
    // ========================================================================

    /**
     * Get cross-origin value for media element
     * @param {Object} mediaSource
     * @returns {string|null}
     */
    getCrossOriginValue(mediaSource) {
        return null; // Disable CORS checks for video element to avoid "Failed to initialize" on local networks
    }
};

export default MediaHelper;
