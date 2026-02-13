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
        const { serverUrl, itemId, mediaSource, startPositionTicks, playSessionId, authToken, deviceProfile } = options;

        // Determine play method
        const playMethod = this.getPlayMethod(mediaSource);

        let url;
        let isHls = false;

        if (playMethod === 'DirectStream' || playMethod === 'DirectPlay') {
            // Direct stream/play URL
            if (mediaSource.SupportsDirectStream) {
                url = `${serverUrl}/Videos/${itemId}/stream.${mediaSource.Container}`;
                url += `?Static=true`;
                url += `&mediaSourceId=${encodeURIComponent(mediaSource.Id)}`;
                url += `&api_key=${encodeURIComponent(authToken)}`;
            } else if (mediaSource.SupportsDirectPlay && mediaSource.Path) {
                // Local file path (for native apps)
                url = mediaSource.Path;
            }
        } else {
            // Transcode URL (HLS)
            url = `${serverUrl}/Videos/${itemId}/master.m3u8`;
            url += `?mediaSourceId=${encodeURIComponent(mediaSource.Id)}`;
            url += `&PlaySessionId=${encodeURIComponent(playSessionId)}`;
            url += `&api_key=${encodeURIComponent(authToken)}`;
            url += `&StartTimeTicks=${startPositionTicks || 0}`;

            // Use pre-built transcoding URL if available from the server
            if (mediaSource.TranscodingUrl) {
                url = serverUrl + mediaSource.TranscodingUrl;
            }

            isHls = true;
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
     * Determine play method based on media source
     * @param {Object} mediaSource
     * @returns {string} 'DirectPlay', 'DirectStream', or 'Transcode'
     */
    getPlayMethod(mediaSource) {
        if (mediaSource.SupportsDirectPlay) {
            return 'DirectPlay';
        }
        if (mediaSource.SupportsDirectStream) {
            return 'DirectStream';
        }
        return 'Transcode';
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
        // Jellyfin API: /Videos/{itemId}/{mediaSourceId}/Subtitles/{streamIndex}/Stream.{format}
        const streamIndex = track.Index;
        let url = `${serverUrl}/Videos/${itemId}/${mediaSourceId}/Subtitles/${streamIndex}/Stream.${format}`;
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
        if (mediaSource?.IsRemote) {
            return null;
        }
        return 'anonymous';
    }
};

export default MediaHelper;
