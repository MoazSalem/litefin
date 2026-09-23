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
import { logger } from '../../utils/Logger.js';

const log = logger.create('MediaHelper');

// Maximum number of media entities (series/items) preserved in track memory
const MAX_LRU_ENTRIES = 50;
// Storage key indexing all tracked entities in Least-Recently-Used order
const LRU_INDEX_KEY = 'track:lru_index';

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

        if (playMethod === 'DirectPlay' || playMethod === 'DirectStream' || playMethod === 'Remux') {
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

                // For DirectStream or Remux, always prefer the server-provided TranscodingUrl —
                // it has AudioStreamIndex, SubtitleStreamIndex, and all session params
                // baked in. For DirectPlay, build the static URL directly (TranscodingUrl
                // may be an HLS manifest the native player can't handle).
            } else if ((playMethod === 'DirectStream' || playMethod === 'Remux') && mediaSource.TranscodingUrl) {
                url = serverUrl + mediaSource.TranscodingUrl;
                isHls = url.includes('.m3u8');

            } else if (mediaSource.SupportsDirectStream) {
                // ============================================================
                // DIRECTPLAY / DIRECTSTREAM STATIC CONTAINER URL
                // ============================================================
                // Static-serve the container file as-is directly from the server.
                // Include PlaySessionId and DeviceId so the Jellyfin server's
                // session tracking properly correlates the streaming socket
                // with the client's reported session (matching official web client).
                // ============================================================
                url = `${serverUrl}/Videos/${itemId}/stream.${mediaSource.Container}`;
                url += `?Static=true`;
                url += `&mediaSourceId=${encodeURIComponent(mediaSource.Id)}`;
                if (playSessionId) {
                    url += `&PlaySessionId=${encodeURIComponent(playSessionId)}`;
                }
                const deviceId = state.get('device:id') || '';
                if (deviceId) {
                    url += `&DeviceId=${encodeURIComponent(deviceId)}`;
                }
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

        // =====================================================================
        // Stream Offset & Start Position Mapping:
        // In HLS streaming (whether Transcode, DirectStream, or Remux), the server's
        // master.m3u8 playlist indexes segments across the full media timeline from 0s.
        // The player backend (Hls.js, WebOS native, or Tizen AVPlay) directly seeks or
        // starts buffering at playerStartPositionTicks.
        //
        // transcodingOffsetTicks is ONLY non-zero for progressive HTTP streams (!isHls)
        // where ffmpeg cuts the beginning (-ss) without copying original timestamps.
        // =====================================================================
        const isProgressiveTranscode = (playMethod === 'Transcode' || playMethod === 'DirectStream') && !isHls;

        return {
            url,
            playMethod,
            isHls,
            mediaSource,
            transcodingOffsetTicks: isProgressiveTranscode ? startPositionTicks : 0,
            playerStartPositionTicks: isProgressiveTranscode ? 0 : startPositionTicks
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
            const codec = (track.Codec || 'pgssub').toLowerCase();
            const format_ = format || codec;            // honour caller's override
            deliveryPath = `/Videos/${itemId}/${mediaSourceId}/Subtitles/${track.Index}/0/Stream.${format_}`;
            const sep = '?';
            return `${serverUrl}${deliveryPath}${sep}${authKey}=${encodeURIComponent(authToken)}`;
        }

        // ====================================================================
        // Filesystem path guard for external subtitle files.
        //
        // When a subtitle track is external (IsExternal = true), Jellyfin may
        // set DeliveryUrl to the server's local filesystem path (e.g.
        // "/Volumes/Storage/movie.srt"). This path is not accessible from the
        // client — we must stream the subtitle through the server's subtitle
        // API endpoint instead.
        //
        // We detect this by checking that the DeliveryUrl is neither an HTTP
        // URL nor a server-relative API path under /Videos/ or /Audio/.
        // ====================================================================
        if (
            deliveryPath.startsWith('/') &&
            !deliveryPath.startsWith('/Videos/') &&
            !deliveryPath.startsWith('/Audio/')
        ) {
            const codec = (track.Codec || 'subrip').toLowerCase();
            const format_ = format || codec;
            deliveryPath = `/Videos/${itemId}/${mediaSourceId}/Subtitles/${track.Index}/0/Stream.${format_}`;
            return `${serverUrl}${deliveryPath}?${authKey}=${encodeURIComponent(authToken)}`;
        }

        // ====================================================================
        // SUBTITLE CUE TIMELINE NORMALIZATION:
        // When playback starts with a non-zero StartPositionTicks, Jellyfin server
        // builds DeliveryUrl with that offset in the URL path:
        //   /Videos/{itemId}/{mediaSourceId}/Subtitles/{index}/{startPositionTicks}/Stream.{format}
        //
        // Jellyfin's SubtitleService shifts every cue timestamp backwards by
        // startPositionTicks when this segment is non-zero. Since Litefin fetches
        // and parses external text subtitles into memory once for the stream lifetime,
        // baked-in cue offsets permanently corrupt the subtitle clock on any seek.
        //
        // Replacing any non-zero start position segment with '0' guarantees that
        // the server returns absolute timestamps matching the media timeline.
        // ====================================================================
        deliveryPath = deliveryPath.replace(/(\/Subtitles\/[^/]+)\/\d+(\/Stream\b)/i, '$1/0$2');

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

        // Append auth token only if the DeliveryUrl doesn't already include one.
        if (!url.includes(authKey + '=')) {
            const separator = url.includes('?') ? '&' : '?';
            url += `${separator}${authKey}=${encodeURIComponent(authToken)}`;
        }

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

    getCrossOriginValue(mediaSource) {
        return null; // Disable CORS checks for video element to avoid "Failed to initialize" on local networks
    },

    /**
     * Poll an HLS manifest URL until the server writes #EXTM3U.
     * Prevents backends from opening/loading a URL that the transcoder
     * hasn't started writing yet, which causes unrecoverable decoder errors
     * on some Smart TV platforms.
     *
     * @param {string} url - HLS playlist URL
     * @param {Function} [shouldAbort] - Optional callback; return true to stop polling
     * @returns {Promise<void>} Resolves when manifest is ready or timeout reached
     */
    async pollHlsManifest(url, shouldAbort) {
        if (!url || !url.includes('.m3u8')) return;

        const maxRetries = 30;
        const delayMs = 500;

        log.info(`Polling HLS manifest: ${url}`);

        for (let i = 0; i < maxRetries; i++) {
            if (typeof shouldAbort === 'function' && shouldAbort()) {
                log.info('HLS polling aborted');
                return;
            }

            try {
                const response = await fetch(url, { method: 'GET' });
                if (response.ok) {
                    const text = await response.text();
                    if (text && text.includes('#EXTM3U')) {
                        log.info(`HLS manifest ready after ${i * delayMs}ms`);
                        return;
                    }
                }
            } catch (e) {
                // Server may still be starting up — retry
            }

            await new Promise(resolve => setTimeout(resolve, delayMs));
        }

        log.warn(`HLS manifest polling timed out after ${maxRetries * delayMs}ms — proceeding`);
    },

    // ========================================================================
    // Media Error Diagnostics
    // ========================================================================

    /**
     * Parse and format HTML5 MediaError objects into rich, informative diagnostics.
     * Provides clear human-readable error names and descriptions when older TV
     * browsers (such as webOS 4 / Tizen 3) emit an empty or generic 'Unknown error'.
     *
     * @param {MediaError|Object|null} error - The video element's error object
     * @returns {{code: number, name: string, message: string, details: string}}
     */
    formatMediaError(error) {
        // Extract numeric error code (default to 0 if not present)
        const code = error?.code || 0;
        const rawMessage = error?.message || '';

        let name = 'MEDIA_ERR_UNKNOWN';
        let details = 'An unknown media playback error occurred.';

        // Map standard HTML5 MediaError codes
        switch (code) {
            case 1: // MEDIA_ERR_ABORTED
                name = 'MEDIA_ERR_ABORTED';
                details = 'Media playback was aborted by client request.';
                break;
            case 2: // MEDIA_ERR_NETWORK
                name = 'MEDIA_ERR_NETWORK';
                details = 'A network error caused the media download to fail.';
                break;
            case 3: // MEDIA_ERR_DECODE
                name = 'MEDIA_ERR_DECODE';
                details = 'Hardware/software decoder error: Incompatible codec, profile, bit depth, or corrupted bitstream.';
                break;
            case 4: // MEDIA_ERR_SRC_NOT_SUPPORTED
                name = 'MEDIA_ERR_SRC_NOT_SUPPORTED';
                details = 'The media resource format or MIME type is not supported by this device.';
                break;
            default:
                break;
        }

        // Build clean diagnostic message incorporating raw error if provided
        const hasSpecificMsg = rawMessage && rawMessage.trim().length > 0 && rawMessage.toLowerCase() !== 'unknown error';
        const message = hasSpecificMsg
            ? `${name} (${code}): ${rawMessage} — ${details}`
            : `${name} (${code}): ${details}`;

        return {
            code,
            name,
            message,
            details
        };
    },

    // =========================================================================
    // Track Selection Persistence & Dynamic Re-indexing Resolution
    // =========================================================================

    /**
     * Persist selected track choice with metadata signature for an item.
     * Storing the track metadata (language, title, codec, channels) alongside its index
     * prevents silent track regressions when Jellyfin shifts stream indices (for instance,
     * when external subtitles or additional tracks are downloaded or deleted).
     *
     * @param {string} itemId - Media item ID
     * @param {'Audio'|'Subtitle'} type - Track type
     * @param {Object|number} trackOrIndex - The selected MediaStream object or stream index (-1 for Subtitle Off)
     * @param {Object} [mediaSource] - Optional MediaSource to resolve metadata if only an index was supplied
     */
    /**
     * Retrieve the persistent LRU index of tracked media entities (shows/items).
     *
     * @private
     * @returns {Array<{ id: string, type: 'series'|'item', lastUsed: number }>}
     */
    _getLruIndex() {
        // Read raw index JSON array from storage
        const raw = storage.getItem(LRU_INDEX_KEY);
        if (!raw) return [];
        try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        } catch (e) {
            log.warn('[Track Memory LRU] Failed to parse index, resetting:', e);
            return [];
        }
    },

    /**
     * Persist the updated LRU index to storage.
     *
     * @private
     * @param {Array<{ id: string, type: 'series'|'item', lastUsed: number }>} index
     */
    _saveLruIndex(index) {
        // Store ordered list of entries
        storage.setItem(LRU_INDEX_KEY, JSON.stringify(index));
    },

    /**
     * Touch an entry in the LRU index to refresh its lifespan upon playback.
     * If entry exists, bumps its lastUsed timestamp to Date.now() and moves it to the head.
     *
     * @param {string} [itemId] - Media item ID
     * @param {string} [seriesId] - Optional series ID
     */
    touchTrackMemory(itemId, seriesId = null) {
        if (!itemId && !seriesId) return;

        // Series takes precedence for TV episodes to maintain show-level vitality
        const targetId = seriesId ? `series:${seriesId}` : `item:${itemId}`;

        // Retrieve current LRU index
        const index = this._getLruIndex();
        const existingIdx = index.findIndex((entry) => entry.id === targetId);

        if (existingIdx !== -1) {
            // Update existing entry timestamp and promote to the front
            const entry = index.splice(existingIdx, 1)[0];
            entry.lastUsed = Date.now();
            index.unshift(entry);
            this._saveLruIndex(index);

            // Also update internal timestamp inside series object if applicable
            if (seriesId) {
                const seriesKey = `track:series:${seriesId}`;
                const rawSeries = storage.getItem(seriesKey);
                if (rawSeries) {
                    try {
                        const parsed = JSON.parse(rawSeries);
                        parsed.lastUsed = Date.now();
                        storage.setItem(seriesKey, JSON.stringify(parsed));
                    } catch {
                        // Ignore malformed record
                    }
                }
            }

            log.debug(`[Track Memory LRU] Touched and promoted ${targetId}`);
        }
    },

    /**
     * Register or update an entity in the LRU index and prune overflow.
     *
     * @private
     * @param {string} idKey - Full entity key (e.g. 'series:123' or 'item:456')
     * @param {'series'|'item'} type - Entity type
     */
    _registerLruEntry(idKey, type) {
        const index = this._getLruIndex();
        const existingIdx = index.findIndex((entry) => entry.id === idKey);

        if (existingIdx !== -1) {
            // Remove from current position to re-insert at the head
            index.splice(existingIdx, 1);
        }

        // Insert at the head as most recently used
        index.unshift({
            id: idKey,
            type,
            lastUsed: Date.now()
        });

        // Prune oldest entries if capacity exceeded
        while (index.length > MAX_LRU_ENTRIES) {
            const evicted = index.pop();
            if (evicted) {
                this._evictLruEntry(evicted);
            }
        }

        this._saveLruIndex(index);
    },

    /**
     * Clean up stored track data for an evicted LRU entry.
     *
     * @private
     * @param {{ id: string, type: 'series'|'item' }} entry
     */
    _evictLruEntry(entry) {
        log.info(`[Track Memory LRU] Evicting oldest entry: ${entry.id}`);
        if (entry.type === 'series') {
            const seriesId = entry.id.replace('series:', '');
            storage.removeItem(`track:series:${seriesId}`);
        } else {
            const itemId = entry.id.replace('item:', '');
            storage.removeItem(`track:audio:${itemId}`);
            storage.removeItem(`track:subtitle:${itemId}`);
        }
    },

    /**
     * Persist selected track choice with metadata signature for an item and its parent series.
     * Storing track metadata (language, title, codec, channels) alongside its index
     * prevents silent track regressions when Jellyfin shifts stream indices.
     *
     * @param {string} itemId - Media item ID
     * @param {'Audio'|'Subtitle'} type - Track type
     * @param {Object|number} trackOrIndex - Selected MediaStream object or stream index (-1 for Subtitle Off)
     * @param {Object} [mediaSource] - Optional MediaSource to resolve metadata if only an index was supplied
     * @param {string} [seriesId] - Optional Series ID for TV episodes
     */
    saveTrackMemory(itemId, type, trackOrIndex, mediaSource = null, seriesId = null) {
        // Validate required identification inputs
        if (!itemId || !type) return;

        // Subtitle Off check: invariant to stream indexing shifts and always uses index -1
        const isSubOff = type === 'Subtitle' && (trackOrIndex === -1 || trackOrIndex?.Index === -1);

        // Determine stream object and target index
        let stream = null;
        const index = typeof trackOrIndex === 'number' ? trackOrIndex : trackOrIndex?.Index;

        // If a full stream object was passed, use it directly
        if (typeof trackOrIndex === 'object' && trackOrIndex !== null) {
            stream = trackOrIndex;
        } else if (mediaSource?.MediaStreams && typeof index === 'number') {
            // Otherwise resolve the stream from the provided media source inventory
            stream = mediaSource.MediaStreams.find((s) => s.Type === type && s.Index === index);
        }

        // =========================================================================
        // 1. Persist Item-Specific Track Memory
        // =========================================================================
        const storageKey = `track:${type.toLowerCase()}:${itemId}`;

        if (isSubOff) {
            storage.setItem(storageKey, JSON.stringify({ index: -1 }));
        } else if (stream) {
            // Snapshot full track identity attributes for robust reconciliation across re-indexing
            const data = {
                index: stream.Index,
                language: stream.Language || 'und',
                title: stream.DisplayTitle || stream.Title || 'none',
                codec: stream.Codec || '',
                channels: stream.Channels || null,
                isExternal: stream.IsExternal || false
            };
            storage.setItem(storageKey, JSON.stringify(data));
        } else if (typeof index === 'number') {
            // Fallback when stream object is missing from memory
            storage.setItem(storageKey, JSON.stringify({ index }));
        }

        // =========================================================================
        // 2. Persist Series-Level Track Preference (if TV series episode)
        // =========================================================================
        if (seriesId) {
            const seriesKey = `track:series:${seriesId}`;
            let seriesData = null;
            const existingRaw = storage.getItem(seriesKey);

            if (existingRaw) {
                try {
                    seriesData = JSON.parse(existingRaw);
                } catch {
                    seriesData = null;
                }
            }
            if (!seriesData || typeof seriesData !== 'object') {
                seriesData = {};
            }

            if (type === 'Audio' && stream) {
                // Save preferred audio language and title for the series
                seriesData.audio = {
                    language: stream.Language || 'und',
                    title: stream.DisplayTitle || stream.Title || 'none',
                    codec: stream.Codec || ''
                };
            } else if (type === 'Subtitle') {
                if (isSubOff) {
                    // Record explicit subtitle disabling for the series
                    seriesData.subtitle = { isOff: true };
                } else if (stream) {
                    // Record preferred subtitle language and title for the series
                    seriesData.subtitle = {
                        isOff: false,
                        language: stream.Language || 'und',
                        title: stream.DisplayTitle || stream.Title || 'none',
                        isExternal: stream.IsExternal || false
                    };
                }
            }

            seriesData.lastUsed = Date.now();
            storage.setItem(seriesKey, JSON.stringify(seriesData));

            // Register series in LRU ring buffer
            this._registerLruEntry(`series:${seriesId}`, 'series');
        } else {
            // Register standalone movie/video in LRU ring buffer
            this._registerLruEntry(`item:${itemId}`, 'item');
        }
    },

    /**
     * Resolve a series-level track preference against the active MediaSource.
     * Matches tracks based on language and title to ensure consistency across episodes.
     *
     * @param {Object} mediaSource - Active MediaSource containing MediaStreams
     * @param {'Audio'|'Subtitle'} type - Track type ('Audio' or 'Subtitle')
     * @param {string} seriesId - Series ID
     * @returns {number|undefined} The resolved stream index, -1 for Subtitle Off, or undefined
     */
    resolveSeriesTrack(mediaSource, type, seriesId) {
        if (!mediaSource || !Array.isArray(mediaSource.MediaStreams) || !seriesId) {
            return undefined;
        }

        const seriesKey = `track:series:${seriesId}`;
        const raw = storage.getItem(seriesKey);
        if (!raw) return undefined;

        let seriesData = null;
        try {
            seriesData = JSON.parse(raw);
        } catch {
            return undefined;
        }

        if (!seriesData || typeof seriesData !== 'object') return undefined;

        const candidateStreams = mediaSource.MediaStreams.filter((s) => s.Type === type);
        if (candidateStreams.length === 0) return undefined;

        // Resolve Audio preference
        if (type === 'Audio' && seriesData.audio) {
            const targetLang = (seriesData.audio.language || 'und').toLowerCase();
            const targetTitle = seriesData.audio.title || 'none';

            // Match Priority 1: Exact Language AND Title
            let match = candidateStreams.find(
                (s) =>
                    (s.Language || 'und').toLowerCase() === targetLang &&
                    (s.DisplayTitle || s.Title || 'none') === targetTitle
            );

            // Match Priority 2: Language match (when defined)
            if (!match && targetLang !== 'und') {
                match = candidateStreams.find(
                    (s) => (s.Language || 'und').toLowerCase() === targetLang
                );
            }

            if (match) {
                log.info(
                    `[Track Memory] Resolved series audio for ${seriesId}: Index ${match.Index} (${match.Language} - ${match.DisplayTitle || match.Title})`
                );
                return match.Index;
            }
        } else if (type === 'Subtitle' && seriesData.subtitle) {
            // Resolve Subtitle preference
            if (seriesData.subtitle.isOff) {
                log.info(`[Track Memory] Resolved series subtitle for ${seriesId}: Off (-1)`);
                return -1;
            }

            const targetLang = (seriesData.subtitle.language || 'und').toLowerCase();
            const targetTitle = seriesData.subtitle.title || 'none';

            // Match Priority 1: Exact Language AND Title
            let match = candidateStreams.find(
                (s) =>
                    (s.Language || 'und').toLowerCase() === targetLang &&
                    (s.DisplayTitle || s.Title || 'none') === targetTitle
            );

            // Match Priority 2: Language match (when defined)
            if (!match && targetLang !== 'und') {
                match = candidateStreams.find(
                    (s) => (s.Language || 'und').toLowerCase() === targetLang
                );
            }

            if (match) {
                log.info(
                    `[Track Memory] Resolved series subtitle for ${seriesId}: Index ${match.Index} (${match.Language} - ${match.DisplayTitle || match.Title})`
                );
                return match.Index;
            }
        }

        return undefined;
    },

    /**
     * Resolve a saved track selection against the active MediaSource.
     * Validates that the track at the saved index still matches the recorded metadata.
     * If stream indices shifted due to external subtitle downloads, deletions, or server re-probing,
     * this dynamically re-identifies the correct stream index and updates storage.
     *
     * Backward-compatible with legacy numeric strings (e.g. "2" or "-1").
     *
     * @param {Object} mediaSource - Active MediaSource containing MediaStreams
     * @param {'Audio'|'Subtitle'} type - 'Audio' or 'Subtitle'
     * @param {string|number|Object} savedRaw - The stored track value
     * @param {string} [itemId] - Optional item ID to automatically update storage if re-indexed
     * @returns {number|undefined} The resolved stream index, -1 for Subtitle Off, or undefined if invalid
     */
    resolveSavedTrack(mediaSource, type, savedRaw, itemId = null) {
        // Guard check: Media source and MediaStreams must be populated
        if (!mediaSource || !Array.isArray(mediaSource.MediaStreams)) return undefined;
        if (savedRaw === null || savedRaw === undefined) return undefined;

        // Parse saved value (handles JSON object string, legacy numeric string, or plain number/object)
        let saved;
        if (typeof savedRaw === 'string') {
            try {
                saved = JSON.parse(savedRaw);
            } catch {
                const num = Number(savedRaw);
                saved = !isNaN(num) ? num : null;
            }
        } else {
            saved = savedRaw;
        }

        if (saved === null || saved === undefined) return undefined;

        // Normalize numeric or object structure into standard shape
        const savedObj = typeof saved === 'number' ? { index: saved } : saved;
        if (typeof savedObj.index !== 'number') return undefined;

        // Subtitle Off (-1) is invariant to stream indexing shifts
        if (type === 'Subtitle' && savedObj.index === -1) {
            return -1;
        }

        // Filter media streams matching requested track type
        const candidateStreams = mediaSource.MediaStreams.filter((s) => s.Type === type);
        if (candidateStreams.length === 0) return undefined;

        // =====================================================================
        // Step 1: Check if the stream currently at savedObj.index still matches
        // =====================================================================
        const streamAtIndex = candidateStreams.find((s) => s.Index === savedObj.index);
        const hasMetadata = savedObj.language && savedObj.language !== 'und';

        if (streamAtIndex) {
            // For legacy storage entries without recorded language, trust the existing index
            if (!hasMetadata) {
                return streamAtIndex.Index;
            }

            // Verify language alignment
            const langMatches = (streamAtIndex.Language || 'und').toLowerCase() === savedObj.language.toLowerCase();
            // Verify title alignment if saved
            const titleMatches =
                !savedObj.title ||
                savedObj.title === 'none' ||
                (streamAtIndex.DisplayTitle || streamAtIndex.Title || 'none') === savedObj.title;

            // If identity attributes align, stream has not shifted
            if (langMatches && titleMatches) {
                return streamAtIndex.Index;
            }

            // Stream index collision: another track now occupies this index due to stream shifting
            log.warn(
                `[Track Memory] Stream index ${savedObj.index} for ${type} no longer matches saved track ` +
                `("${savedObj.language}" - "${savedObj.title}"). Stream at index is now ` +
                `("${streamAtIndex.Language}" - "${streamAtIndex.DisplayTitle || streamAtIndex.Title}"). ` +
                `Searching for shifted track...`
            );
        }

        // =====================================================================
        // Step 2: Stream shifted or missing — Reconcile by track metadata
        // =====================================================================
        if (hasMetadata) {
            const targetLang = savedObj.language.toLowerCase();

            // Priority A: Exact Language AND Title/DisplayTitle match
            let matchedStream = candidateStreams.find(
                (s) =>
                    (s.Language || 'und').toLowerCase() === targetLang &&
                    (s.DisplayTitle || s.Title || 'none') === savedObj.title
            );

            // Priority B: Language AND Codec (and Channels for Audio streams)
            if (!matchedStream && savedObj.codec) {
                matchedStream = candidateStreams.find(
                    (s) =>
                        (s.Language || 'und').toLowerCase() === targetLang &&
                        (s.Codec || '').toLowerCase() === savedObj.codec.toLowerCase() &&
                        (savedObj.channels ? s.Channels === savedObj.channels : true)
                );
            }

            // Priority C: Language AND External status (for Subtitle streams)
            if (!matchedStream && type === 'Subtitle' && savedObj.isExternal !== undefined) {
                matchedStream = candidateStreams.find(
                    (s) =>
                        (s.Language || 'und').toLowerCase() === targetLang &&
                        Boolean(s.IsExternal) === Boolean(savedObj.isExternal)
                );
            }

            // Priority D: Fall back to best Language match
            if (!matchedStream) {
                matchedStream = candidateStreams.find(
                    (s) => (s.Language || 'und').toLowerCase() === targetLang
                );
            }

            if (matchedStream) {
                log.info(
                    `[Track Memory] Re-indexed shifted ${type} track from old index ${savedObj.index} ` +
                    `to new index ${matchedStream.Index} (${matchedStream.Language} - "${matchedStream.DisplayTitle || matchedStream.Title}")`
                );

                // Self-healing: persist the new index and refreshed metadata immediately
                if (itemId) {
                    this.saveTrackMemory(itemId, type, matchedStream, mediaSource);
                }

                return matchedStream.Index;
            }
        }

        return undefined;
    }
};

export default MediaHelper;
