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
import { platformInfo } from '../../utils/PlatformInfo.js';
import { state } from '../../core/StateManager.js';

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

        /*
         * Dynamically select the token query parameter key name.
         * Emby does not return a 'ProductName' in its public (unauthenticated)
         * System Info response, whereas Jellyfin does.
         */
        const serverInfo = state.get('server:info') || {};
        const isEmbyInstance = !!(serverInfo.ServerName && (!serverInfo.ProductName || serverInfo.ProductName.toLowerCase().includes('emby')));
        const authKey = isEmbyInstance ? 'api_key' : 'ApiKey';

        // Determine play method
        const playMethod = this.getPlayMethod(mediaSource);

        let url;
        let isHls = false;

        if (playMethod === 'DirectPlay' || playMethod === 'DirectStream') {
            // ================================================================
            // PRIORITY INTERCEPT: Live TV / IPTV loopback guard.
            //
            // Jellyfin sets Protocol='Http' for any media source that originates
            // from an m3u playlist or Live TV stream. The `Path` it returns is
            // its own internal loopback proxy address, e.g.:
            //   http://127.0.0.1:8096/LiveTv/LiveStreamFiles/{id}/stream.ts
            //
            // This address is unreachable from a TV on the LAN. To avoid this,
            // we must detect this case BEFORE checking SupportsDirectStream,
            // because Jellyfin also sets that flag on Live TV sources, which
            // would cause us to build a /Videos/{id}/stream.ts URL (wrong).
            //
            // The fix: any Http-protocol source whose path is a loopback URL
            // or contains 'LiveStreamFiles' is routed through the server's public
            // /Videos/{id}/live.m3u8 HLS proxy — exactly what the official web
            // client does.
            // ================================================================
            // Any source that requires opening or has a live stream ID must be proxied by the server
            const requiresServerProxy = mediaSource.RequiresOpening || mediaSource.LiveStreamId || (mediaSource.Path &&
                (mediaSource.Path.includes('127.0.0.1') ||
                 mediaSource.Path.includes('localhost') ||
                 mediaSource.Path.includes('LiveStreamFiles')));

            // ================================================================
            // PROTOCOL DETECTION & ROUTING:
            // M3U IPTV streams → Protocol: 'Http'. When DirectPlaying,
            //   Jellyfin proxies these via its own loopback which is
            //   unreachable from the LAN. These must go through the
            //   /live.m3u8 HLS proxy endpoint.
            //
            // However, if the server explicitly set up a transcoding or remux
            // session (indicated by TranscodeReasons in the TranscodingUrl),
            // we MUST use the server's provided master.m3u8 pipeline instead
            // of the simple live proxy, regardless of the protocol.
            // ================================================================
            const isHttpProxy = mediaSource.Protocol === 'Http' && requiresServerProxy;
            const hasTranscodeReasons = mediaSource.TranscodingUrl && mediaSource.TranscodingUrl.includes('TranscodeReasons=');
            
            const needsLiveProxy = isHttpProxy && !hasTranscodeReasons;

            if (needsLiveProxy) {


                // Tizen AVPlay has severe limitations with HLS: it cannot decode MPEG-2 video
                // or interlaced H.264 when wrapped in an .m3u8 payload. However, AVPlay's native
                // MPEG-TS demuxer perfectly handles raw progressive HTTP TS streams.
                // HDHomeRun broadcasts ATSC 1.0 in MPEG-2. Thus, we bypass the HLS proxy for them.
                const videoStream = mediaSource.MediaStreams?.find(s => s.Type === 'Video');
                const isMpeg2 = videoStream && videoStream.Codec && videoStream.Codec.toLowerCase().includes('mpeg2');
                const isInterlaced = videoStream && videoStream.IsInterlaced;

                // Check global variable platformInfo if it's imported (we must import it!)
                const useProgressiveTs = platformInfo.isTizen && (isMpeg2 || isInterlaced);

                if (useProgressiveTs) {
                    const ext = mediaSource.Container ? `.${mediaSource.Container}` : '.ts';
                    url = `${serverUrl}/Videos/${itemId}/stream${ext}`;
                    url += `?Static=true`;
                    url += `&MediaSourceId=${encodeURIComponent(mediaSource.Id)}`;
                    if (playSessionId) {
                        url += `&PlaySessionId=${encodeURIComponent(playSessionId)}`;
                    }
                    if (mediaSource.LiveStreamId) {
                        url += `&LiveStreamId=${encodeURIComponent(mediaSource.LiveStreamId)}`;
                    }
                    url += `&${authKey}=${encodeURIComponent(authToken)}`;
                    if (audioStreamIndex !== undefined && audioStreamIndex !== null) {
                        url += `&AudioStreamIndex=${audioStreamIndex}`;
                    }
                    isHls = false;
                } else {
                    // Route through the server's public HLS proxy endpoint.
                    // The LiveStreamId is critical — without it the server cannot identify
                    // which open live stream to serve HLS segments from. This matches the
                    // exact parameter set used by the official Jellyfin web client.
                    url = `${serverUrl}/Videos/${itemId}/live.m3u8`;
                    url += `?Container=m3u8`;
                    url += `&MediaSourceId=${encodeURIComponent(mediaSource.Id)}`;
                    if (playSessionId) {
                        url += `&PlaySessionId=${encodeURIComponent(playSessionId)}`;
                    }
                    if (mediaSource.LiveStreamId) {
                        url += `&LiveStreamId=${encodeURIComponent(mediaSource.LiveStreamId)}`;
                    }
                    url += `&${authKey}=${encodeURIComponent(authToken)}`;
                    isHls = true;
                }

            // ----------------------------------------------------------------
            // SPECIAL CASE: Remote/external HTTP sources (e.g. publicly-hosted
            // IPTV with a direct URL). These are NOT loopback and should be
            // played directly from the source URL.
            // ----------------------------------------------------------------
            } else if (mediaSource.IsRemote && mediaSource.Protocol === 'Http' && mediaSource.Path) {
                url = mediaSource.Path;
                isHls = url.includes('.m3u8') || mediaSource.Container === 'hls';

            // For DirectStream, always prefer the server-provided TranscodingUrl —
            // it has AudioStreamIndex, SubtitleStreamIndex, and all session params
            // baked in.  For DirectPlay, build the static URL directly (TranscodingUrl
            // may be an HLS manifest the native player can't handle).
            } else if (playMethod === 'DirectStream' && mediaSource.TranscodingUrl) {
                url = serverUrl + mediaSource.TranscodingUrl;
                isHls = url.includes('.m3u8');

            } else if (mediaSource.SupportsDirectStream) {
                // Static-serve the container file as-is
                url = `${serverUrl}/Videos/${itemId}/stream.${mediaSource.Container}`;
                url += `?Static=true`;
                url += `&mediaSourceId=${encodeURIComponent(mediaSource.Id)}`;
                url += `&${authKey}=${encodeURIComponent(authToken)}`;
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
                url += `&${authKey}=${encodeURIComponent(authToken)}`;
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
            'VideoBitDepthNotSupported',
            'VideoFramerateNotSupported',
            'VideoBitrateNotSupported',
            'RefFramesNotSupported',
            'AnamorphicVideoNotSupported',
            'InterlacedVideoNotSupported',
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

        let isVideoDirect = !reasonList.some(r => VIDEO_REASONS.has(r));
        let isAudioDirect = !reasonList.some(r => AUDIO_ONLY_REASONS.has(r));

        // Generic reasons like DirectPlayError or ContainerNotSupported don't explicitly declare 
        // which stream is being re-encoded. To guarantee accuracy, we manually check if the 
        // source track's codec is permitted in the target codec pool requested by the client.
        const allowedVideoCodecsStr = (transcodeUrl.match(/[?&]VideoCodec=([^&]+)/) || [])[1];
        const allowedAudioCodecsStr = (transcodeUrl.match(/[?&]AudioCodec=([^&]+)/) || [])[1];

        if (allowedVideoCodecsStr) {
            const allowedVideoCodecs = allowedVideoCodecsStr.toLowerCase().split(',');
            const videoStream = mediaSource.MediaStreams?.find(s => s.Type === 'Video');
            if (videoStream && videoStream.Codec && !allowedVideoCodecs.includes(videoStream.Codec.toLowerCase())) {
                isVideoDirect = false;
            }
        }

        if (allowedAudioCodecsStr) {
            const allowedAudioCodecs = allowedAudioCodecsStr.toLowerCase().split(',');
            const audioStreamIndexStr = (transcodeUrl.match(/[?&]AudioStreamIndex=([^&]+)/) || [])[1];
            let audioStream;
            if (audioStreamIndexStr) {
                audioStream = mediaSource.MediaStreams?.find(s => s.Index === parseInt(audioStreamIndexStr, 10));
            } else {
                audioStream = mediaSource.MediaStreams?.find(s => s.Type === 'Audio' && s.IsDefault) || 
                              mediaSource.MediaStreams?.find(s => s.Type === 'Audio');
            }

            if (audioStream && audioStream.Codec && !allowedAudioCodecs.includes(audioStream.Codec.toLowerCase())) {
                isAudioDirect = false;
            }
        }

        return {
            isVideoDirect,
            isAudioDirect
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
     * Get subtitle track URL from the Jellyfin API.
     *
     * Mirrors jellyfin-web's getTextTrackUrl() — trust the server-provided
     * DeliveryUrl on the track object rather than constructing a URL from
     * scratch. The server already bakes in the correct path segment, format
     * extension (e.g. '.sup' for PGS, '.vtt' for text tracks), and any
     * start-position offset.  Constructing a manual URL can produce formats
     * the server rejects with a 400 (e.g. asking for '.pgs' when only '.sup'
     * is valid, or skipping the required start-position segment).
     *
     * When a specific format is requested (e.g. 'vtt' for text conversion),
     * we replace the extension in the DeliveryUrl — again, matching
     * jellyfin-web's `url.replace('.vtt', format)` pattern.
     *
     * If the track has no DeliveryUrl (external URL tracks), we fall back to
     * the raw IsExternalUrl path.
     *
     * @param {Object} track       - Subtitle stream object from Jellyfin PlaybackInfo
     * @param {string} serverUrl   - Jellyfin server base URL (e.g. http://host:8096)
     * @param {string} itemId      - Item ID (unused, kept for backward-compat signature)
     * @param {string} mediaSourceId - Media source ID (unused, kept for backward-compat)
     * @param {string} authToken   - Authentication token for the ApiKey query param
     * @param {string} [format]    - If provided, overrides the extension in the DeliveryUrl
     *                               (e.g. 'vtt').  If omitted the DeliveryUrl is used as-is.
     * @returns {string} Fully-qualified subtitle URL including auth token
     */
    getSubtitleUrl(track, serverUrl, itemId, mediaSourceId, authToken, format) {
        /*
         * Dynamically select the token query parameter key name.
         * Emby does not return a 'ProductName' in its public (unauthenticated)
         * System Info response, whereas Jellyfin does.
         */
        const serverInfo = state.get('server:info') || {};
        const isEmbyInstance = !!(serverInfo.ServerName && (!serverInfo.ProductName || serverInfo.ProductName.toLowerCase().includes('emby')));
        const authKey = isEmbyInstance ? 'api_key' : 'ApiKey';

        // ====================================================================
        // External URL tracks (e.g. HTTP/HTTPS subtitles hosted elsewhere)
        // have no server-relative DeliveryUrl — use their URL directly.
        // ====================================================================
        if (track.IsExternalUrl) {
            return track.DeliveryUrl || '';
        }

        // ====================================================================
        // Internal tracks: prefer the server-provided DeliveryUrl.
        // The server bakes in the correct path segment, format extension, and
        // start-position offset — we trust it over any manual construction.
        //
        // HOWEVER: for embedded subtitle tracks during Direct Play, the server
        // does NOT populate DeliveryUrl because the subtitle profile Method is
        // 'Embed' (the player is supposed to read it from the container).
        // When we want to render PGS ourselves (client-side, via libpgs) we
        // still need to fetch the raw stream from the server, so we fall back
        // to the standard Jellyfin subtitle API path:
        //   /Videos/{itemId}/{mediaSourceId}/Subtitles/{streamIndex}/0/Stream.{codec}
        // ====================================================================
        let deliveryPath = track.DeliveryUrl;

        if (!deliveryPath) {
            // Build the URL manually from the track's own index and the known
            // media source — this matches the Jellyfin server's subtitle route.
            const codec  = (track.Codec || 'pgssub').toLowerCase();
            const format_  = format || codec;            // honour caller's override
            deliveryPath = `/Videos/${itemId}/${mediaSourceId}/Subtitles/${track.Index}/0/Stream.${format_}`;
            const sep = '?';
            return `${serverUrl}${deliveryPath}${sep}${authKey}=${encodeURIComponent(authToken)}`;
        }

        // Ensure it's a fully-qualified URL (DeliveryUrl is usually root-relative)
        let url = deliveryPath.startsWith('http')
            ? deliveryPath
            : `${serverUrl}${deliveryPath}`;

        // If the caller wants a specific format (e.g. 'vtt' for text conversion),
        // swap the extension — mirrors jellyfin-web's url.replace('.vtt', format).
        if (format) {
            url = url.replace(/\.\w+(?=\?)/, `.${format}`)  // before query string
                     .replace(/\.\w+$/, `.${format}`);      // or at end of string
        }

        // Append auth token (DeliveryUrl itself usually omits it)
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}${authKey}=${encodeURIComponent(authToken)}`;

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
