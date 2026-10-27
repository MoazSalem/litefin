/**
 * ============================================================================
 * Litefin Tizen - Prewarm Manager (Zero Latency Playback)
 * ============================================================================
 * Pre-warms video items and pre-fetches Jellyfin PlaybackInfo in the background
 * while the user is browsing the Details page. When the user presses "Play",
 * the network round-trip for PlaybackInfo and item details is already complete,
 * eliminating the 2-5 second black-screen loading spinner.
 * ============================================================================
 */

import { logger } from '../../utils/Logger.js';
import { eventBus } from '../../core/EventBus.js';
import { api } from '../../api/index.js';
import { PlayerSettings } from '../../utils/PlayerSettings.js';
import { buildJellyfinProfile } from '../../api/DeviceProfile.js';
import FontLoader from '../../utils/FontLoader.js';
import SubtitleStyles from '../../utils/SubtitleStyles.js';
import { platformInfo } from '../../utils/PlatformInfo.js';
import { webCodecsProbe } from '../../utils/WebCodecsProbe.js';
import { resolveBestAudioStream, doesAudioTrackRequireDirectStream, resolveSubtitleStream, getEffectiveSubtitleMode } from './StreamUtils.js';

const log = logger.create('PrewarmManager');

export class PrewarmManager {
    constructor() {
        // ID of the currently cached item
        this._cachedItemId = null;
        // Full item metadata cached to bypass redundant api.getItem calls
        this._cachedItem = null;
        // Promise representing the ongoing or resolved PlaybackInfo HTTP request
        this._playbackInfoPromise = null;
        // AbortController used to cancel in-flight PlaybackInfo requests
        this._abortController = null;
        // High-precision timestamp marking when prewarm started
        this._timestamp = 0;
        // Validity duration before prewarmed data expires (3 minutes)
        this._ttlMs = 180000;
        // Track the exact playback parameters used when generating the prewarmed request
        this._prewarmParams = null;
    }

    /**
     * Pre-warm a video item and trigger background PlaybackInfo resolution.
     * Safe to call repeatedly; silently no-ops if already pre-warmed with the same options.
     *
     * @param {Object} item - The Jellyfin Item object (Movie, Episode, etc.)
     * @param {Object} [prewarmOptions={}] - Optional overrides such as mediaSourceId, audioStreamIndex, subtitleStreamIndex
     */
    prewarm(item, prewarmOptions = {}) {
        // Guard check: Ensure valid item with an ID is provided
        if (!item || !item.Id) return;

        // Verify user hasn't disabled zero-latency prewarm in settings
        if (PlayerSettings.get('enablePrewarm') === false) return;

        // Skip non-video media types that do not use standard video player
        const validTypes = ['Movie', 'Episode', 'Video', 'TvChannel', 'Trailer'];
        if (item.Type && !validTypes.includes(item.Type) && item.MediaType !== 'Video') {
            return;
        }

        // Resolve target media source ID (specified override or first available source)
        const targetMediaSourceId = prewarmOptions.mediaSourceId || item.MediaSources?.[0]?.Id || null;

        // Resolve target audio track (specified override or auto-resolved DirectPlay track)
        let targetAudioIndex = prewarmOptions.audioStreamIndex ?? null;
        if (targetAudioIndex === null && item.MediaSources && typeof resolveBestAudioStream === 'function') {
            const fallbackSource = item.MediaSources[0];
            const ms = item.MediaSources.find((m) => m.Id === targetMediaSourceId) || fallbackSource;
            if (ms) {
                const bestStream = resolveBestAudioStream(ms);
                if (bestStream) {
                    targetAudioIndex = bestStream.Index;
                    log.info(
                        `Auto-resolved DirectPlay audio track for "${item.Name}": Index ${targetAudioIndex} (${bestStream.Codec})`
                    );
                }
            }
        }

        // ---------------------------------------------------------------------
        // Resolve Target Subtitle Track
        // ---------------------------------------------------------------------
        // If an explicit subtitle stream index is provided, use it.
        // Otherwise, resolve the subtitle stream using the user's active Subtitle Mode.
        let targetSubtitleIndex = prewarmOptions.subtitleStreamIndex;
        const effectiveSubMode = getEffectiveSubtitleMode();
        if (targetSubtitleIndex === undefined || (effectiveSubMode === 'Always' && targetSubtitleIndex === -1)) {
            const fallbackSource = item.MediaSources?.[0];
            const ms = targetMediaSourceId && item.MediaSources
                ? item.MediaSources.find(m => m.Id === targetMediaSourceId)
                : fallbackSource;
            if (ms && ms.MediaStreams) {
                targetSubtitleIndex = resolveSubtitleStream(ms, {
                    audioStreamIndex: targetAudioIndex
                });
            } else {
                targetSubtitleIndex = -1;
            }
        }

        // Read active global policy settings for parity checks
        const activeForceDirectPlay = PlayerSettings.get('forceDirectPlay') || 'off';
        const activeForceTranscode = Boolean(PlayerSettings.get('forceTranscode'));

        // Check if item is already prewarmed with identical track, media source, and policy options
        const isSameItem = this._cachedItemId === item.Id;
        const isFresh = Date.now() - this._timestamp < 60000;
        const isSameSource = this._prewarmParams?.mediaSourceId === targetMediaSourceId;
        const isSameAudio = this._prewarmParams?.audioStreamIndex === targetAudioIndex;
        const isSameSubtitle = this._prewarmParams?.subtitleStreamIndex === targetSubtitleIndex;
        const isSameForceDirectPlay = this._prewarmParams?.forceDirectPlay === activeForceDirectPlay;
        const isSameForceTranscode = this._prewarmParams?.forceTranscode === activeForceTranscode;

        if (isSameItem && isFresh && isSameSource && isSameAudio && isSameSubtitle && isSameForceDirectPlay && isSameForceTranscode) {
            log.debug(`Item "${item.Name}" already pre-warmed with matching parameters, skipping duplicate.`);
            return;
        }

        // Cancel any pending prewarm for a previous item or differing configuration
        this.clear();

        log.info(`Initiating zero-latency prewarm for "${item.Name}" (${item.Id})`, {
            mediaSourceId: targetMediaSourceId,
            audioStreamIndex: targetAudioIndex,
            subtitleStreamIndex: targetSubtitleIndex,
            forceDirectPlay: activeForceDirectPlay,
            forceTranscode: activeForceTranscode
        });

        // Store active caching state including user playback policy flags
        this._cachedItemId = item.Id;
        this._cachedItem = item;
        this._timestamp = Date.now();
        this._abortController = new AbortController();
        this._prewarmParams = {
            mediaSourceId: targetMediaSourceId,
            audioStreamIndex: targetAudioIndex,
            subtitleStreamIndex: targetSubtitleIndex,
            playbackMode: 'auto',
            forceDirectPlay: activeForceDirectPlay,
            forceTranscode: activeForceTranscode
        };

        // 1. Preload subtitle font in background if configured
        try {
            const fontId = SubtitleStyles.getCurrentFontId();
            if (fontId) {
                FontLoader.loadFont(fontId).catch(() => { });
            }
        } catch (_) { }

        // 2. Pre-fetch PlaybackInfo from Jellyfin server using ApiClient
        try {
            // Determine video player backend configuration based on user setting or platform recommendation
            const playerBackendSetting = PlayerSettings.get('playerBackend') || 'html5';
            let backendType = 'html5';
            if (playerBackendSetting === 'exoplayer') {
                backendType = 'exoplayer';
            } else if (playerBackendSetting === 'movi' && platformInfo.hasWebCodecsSupport) {
                // Prewarm Movi backend when configured and WebCodecs hardware decode is supported
                backendType = 'movi';
            } else if (playerBackendSetting === 'avplay') {
                backendType = 'avplay';
            } else if (playerBackendSetting === 'webos') {
                backendType = 'webos';
            }

            // No quality picked in the OSD, as for a new item in JellyfinPlayer: the device
            // profile applies the global limit (maxBitrateInternet) or the device default
            const manualBitrate = null;

            // Resolve target MediaSource object for track requirement analysis
            const targetSource = targetMediaSourceId && item.MediaSources
                ? item.MediaSources.find(m => m.Id === targetMediaSourceId)
                : (item.MediaSources ? item.MediaSources[0] : null);

            // Determine if the prewarmed audio track requires remuxing (DirectStream)
            // on WebOS / HTML5 to prevent prewarming in DirectPlay and falling back to AC3
            const needsRemux = targetSource && targetAudioIndex !== null && targetAudioIndex !== undefined &&
                doesAudioTrackRequireDirectStream(targetSource, targetAudioIndex, backendType);

            // The desktop and web profiles depend on the WebCodecs AV1 probe; skip prewarming until it has run
            if ((platformInfo.isDesktop || platformInfo.isWeb) && platformInfo.hasWebCodecsSupport && webCodecsProbe.av1Decodes === null) {
                return;
            }

            const prewarmPlaybackMode = needsRemux ? 'remux' : 'auto';

            // Build the device profile according to player capabilities and platform
            const deviceProfile = buildJellyfinProfile({
                manualBitrate,
                playbackMode: prewarmPlaybackMode,
                backend: backendType
            });

            // If remux is needed for this audio track, disable DirectPlay in profile
            if (needsRemux) {
                deviceProfile.DirectPlayProfiles = [];
            }

            // =================================================================
            // MKV → MP4 Remux Preference Alignment
            // =================================================================
            // When "Remux MKV to MP4" is active and the prewarmed item is an MKV container,
            // strip 'mkv' from DirectPlayProfiles so the prewarmed response aligns with
            // DirectStream remuxing instead of caching a raw DirectPlay response.
            // Check targetSource, item.Container, and nested MediaSources[0].Container.
            const remuxMkvToMp4 = PlayerSettings.get('remuxMkvToMp4');
            const itemContainer = (
                targetSource?.Container ||
                item.Container ||
                item.MediaSources?.[0]?.Container ||
                ''
            ).toLowerCase();
            const isMkvItem = itemContainer === 'mkv' || itemContainer === 'matroska' || itemContainer.includes('mkv');
            if (remuxMkvToMp4 && !needsRemux && isMkvItem && Array.isArray(deviceProfile.DirectPlayProfiles)) {
                for (const profile of deviceProfile.DirectPlayProfiles) {
                    if (typeof profile.Container === 'string') {
                        const containers = profile.Container.split(',').filter(c => c.trim() !== 'mkv');
                        profile.Container = containers.join(',');
                    }
                }
                deviceProfile.DirectPlayProfiles = deviceProfile.DirectPlayProfiles.filter(
                    p => typeof p.Container !== 'string' || p.Container.length > 0
                );
            }

            // Clone profile to prevent accidental external mutations
            const clonedProfile = JSON.parse(JSON.stringify(deviceProfile));
            // Assemble base PlaybackInfo request payload.
            // If the item has saved progress, align the prewarm StartTimeTicks with the
            // configured resume rewind offset so transcoded playback aligns perfectly.
            const rawResumeTicks = item.UserData?.PlaybackPositionTicks || 0;
            const defaultStartTicks = rawResumeTicks > 0
                ? PlayerSettings.getAdjustedResumePositionTicks(rawResumeTicks)
                : 0;

            const requestBody = {
                DeviceProfile: clonedProfile,
                UserId: api.userId,
                // Same value JellyfinPlayer._getPlaybackInfo() sends for this profile
                MaxStreamingBitrate: clonedProfile.MaxStreamingBitrate || manualBitrate || 120000000,
                StartTimeTicks: prewarmOptions.startPositionTicks ?? defaultStartTicks,
                AutoOpenLiveStream: true,
                IsPlayback: true,
                EnableDirectPlay: true,
                EnableDirectStream: true
            };

            // =================================================================
            // Global Playback Policy Overrides in Prewarm Payload
            // =================================================================
            // Replicate the exact profile overrides that JellyfinPlayer uses so
            // the server pre-warms with the correct PlayMethod (e.g. strict Direct Play
            // or Forced Video Copy) instead of producing an incompatible transcode stream.
            // =================================================================
            if (activeForceTranscode) {
                // Strict transcode mode
                requestBody.EnableDirectPlay = false;
                requestBody.EnableDirectStream = false;
                requestBody.EnableTranscoding = true;
                requestBody.AllowVideoStreamCopy = false;
                requestBody.AllowAudioStreamCopy = false;
                if (requestBody.DeviceProfile) {
                    requestBody.DeviceProfile.DirectPlayProfiles = [];
                    requestBody.DeviceProfile.DirectStreamProfiles = [];
                }
            } else if (activeForceDirectPlay === 'all' || activeForceDirectPlay === true) {
                // Strict Direct Play: Direct play all audio and video formats natively
                requestBody.EnableDirectPlay = true;
                requestBody.EnableDirectStream = false;
                requestBody.EnableTranscoding = false;
                requestBody.AllowVideoStreamCopy = false;
                requestBody.AllowAudioStreamCopy = false;

                if (requestBody.DeviceProfile) {
                    requestBody.DeviceProfile.DirectPlayProfiles = [{
                        Container: 'm4v,3gp,ts,mpegts,mov,xvid,vob,mkv,wmv,asf,ogm,ogv,m2v,avi,mpg,mpeg,mp4,webm,wtv,dvr-ms,m2ts,rmvb,mxf',
                        AudioCodec: 'aac,mp3,mpa,wav,wma,wv,flac,ogg,oga,vorbis,ac3,eac3,dts,dtshd,opus,truehd,alac',
                        VideoCodec: 'h264,h265,hevc,vp8,vp9,mpeg1video,mpeg2video,mpeg4,wmv2,wmv3,vcl,theora,vc1,mpeg,h263,msmpeg4,av1',
                        Type: 'Video'
                    }, {
                        Container: 'aac,mp3,mpa,wav,wma,wv,flac,ogg,oga,vorbis,ac3,eac3,dts,dtshd,opus,truehd,alac',
                        AudioCodec: 'aac,mp3,mpa,wav,wma,wv,flac,ogg,oga,vorbis,ac3,eac3,dts,dtshd,opus,truehd,alac',
                        Type: 'Audio'
                    }];
                    requestBody.DeviceProfile.TranscodingProfiles = [];
                    requestBody.DeviceProfile.DirectStreamProfiles = [];
                    requestBody.DeviceProfile.CodecProfiles = [];
                    requestBody.DeviceProfile.ContainerProfiles = [];
                }
            } else if (activeForceDirectPlay === 'video') {
                // Video Direct Play Only: Video is always copied, audio may transcode
                requestBody.EnableDirectPlay = true;
                requestBody.EnableDirectStream = true;
                requestBody.EnableTranscoding = true;
                requestBody.AllowVideoStreamCopy = true;
                requestBody.AllowAudioStreamCopy = true;

                const allVideoContainers = 'm4v,3gp,ts,mpegts,mov,xvid,vob,mkv,wmv,asf,ogm,ogv,m2v,avi,mpg,mpeg,mp4,webm,wtv,dvr-ms,m2ts,rmvb,mxf';
                const allVideoCodecs = 'h264,h265,hevc,vp8,vp9,mpeg1video,mpeg2video,mpeg4,wmv2,wmv3,vcl,theora,vc1,mpeg,h263,msmpeg4,av1';

                if (requestBody.DeviceProfile && Array.isArray(requestBody.DeviceProfile.DirectPlayProfiles)) {
                    const supportedAudioCodecs = requestBody.DeviceProfile.DirectPlayProfiles
                        .filter(p => p.Type === 'Video' && p.AudioCodec)
                        .map(p => p.AudioCodec)
                        .join(',');
                    const audioCodecsList = supportedAudioCodecs || 'aac,mp3,ac3,eac3,flac,vorbis,opus';

                    requestBody.DeviceProfile.DirectPlayProfiles = [{
                        Container: allVideoContainers,
                        AudioCodec: audioCodecsList,
                        VideoCodec: allVideoCodecs,
                        Type: 'Video'
                    }, {
                        Container: 'aac,mp3,mpa,wav,wma,wv,flac,ogg,oga,vorbis,ac3,eac3,dts,dtshd,opus,truehd,alac',
                        AudioCodec: 'aac,mp3,mpa,wav,wma,wv,flac,ogg,oga,vorbis,ac3,eac3,dts,dtshd,opus,truehd,alac',
                        Type: 'Audio'
                    }];
                }

                if (requestBody.DeviceProfile && Array.isArray(requestBody.DeviceProfile.CodecProfiles)) {
                    requestBody.DeviceProfile.CodecProfiles = requestBody.DeviceProfile.CodecProfiles.filter(p => p.Type !== 'Video' && p.Type !== 'VideoAudio');
                }
            } else if (activeForceDirectPlay === 'audio') {
                // Audio Direct Play Only: Audio is direct-played/copied, video may transcode
                requestBody.EnableDirectPlay = true;
                requestBody.EnableDirectStream = true;
                requestBody.EnableTranscoding = true;
                requestBody.AllowVideoStreamCopy = true;
                requestBody.AllowAudioStreamCopy = true;

                const allAudioCodecs = 'aac,mp3,mpa,wav,wma,wv,flac,ogg,oga,vorbis,ac3,eac3,dts,dtshd,opus,truehd,alac';
                const allContainersList = 'm4v,3gp,ts,mpegts,mov,xvid,vob,mkv,wmv,asf,ogm,ogv,m2v,avi,mpg,mpeg,mp4,webm,wtv,dvr-ms,m2ts,rmvb,mxf';

                if (requestBody.DeviceProfile && Array.isArray(requestBody.DeviceProfile.DirectPlayProfiles)) {
                    const supportedVideoCodecs = requestBody.DeviceProfile.DirectPlayProfiles
                        .filter(p => p.Type === 'Video' && p.VideoCodec)
                        .map(p => p.VideoCodec)
                        .join(',');
                    const videoCodecsList = supportedVideoCodecs || 'h264,hevc,vp9,av1';

                    requestBody.DeviceProfile.DirectPlayProfiles = [{
                        Container: allContainersList,
                        AudioCodec: allAudioCodecs,
                        VideoCodec: videoCodecsList,
                        Type: 'Video'
                    }, {
                        Container: allAudioCodecs,
                        AudioCodec: allAudioCodecs,
                        Type: 'Audio'
                    }];
                }

                if (requestBody.DeviceProfile && Array.isArray(requestBody.DeviceProfile.CodecProfiles)) {
                    requestBody.DeviceProfile.CodecProfiles = requestBody.DeviceProfile.CodecProfiles.filter(p => p.Type !== 'Audio');
                }
            }

            // consumePlaybackInfo() reuses the response only for the same bitrate limit
            this._prewarmParams.maxStreamingBitrate = requestBody.MaxStreamingBitrate;

            // Attach MediaSourceId if specifically resolved and not a dynamic Live TV channel
            const isLiveChannel = item.Type === 'TvChannel';
            if (targetMediaSourceId && !isLiveChannel) {
                requestBody.MediaSourceId = targetMediaSourceId;
            }

            // Attach requested AudioStreamIndex if explicitly provided
            if (targetAudioIndex !== null && targetAudioIndex !== undefined) {
                requestBody.AudioStreamIndex = targetAudioIndex;
            }

            // -----------------------------------------------------------------
            // Subtitle Selection in Prewarm Payload
            // -----------------------------------------------------------------
            // Attach requested SubtitleStreamIndex if resolved (including -1 for off).
            // Explicitly sending -1 prevents the Jellyfin server from falling back to
            // internal default subtitles or generating burned-in subtitles during transcode.
            const isAudioItem = item.MediaType === 'Audio' || item.Type === 'Audio';
            if (!isAudioItem && targetSubtitleIndex !== null && targetSubtitleIndex !== undefined) {
                requestBody.SubtitleStreamIndex = targetSubtitleIndex;
            }

            // Execute PlaybackInfo request through ApiClient to standardize auth headers and error handling
            this._playbackInfoPromise = api.post(
                `/Items/${item.Id}/PlaybackInfo?UserId=${api.userId}`,
                requestBody,
                { signal: this._abortController.signal }
            )
                .then((data) => {
                    log.info(`Successfully pre-fetched PlaybackInfo for "${item.Name}"!`);
                    return data;
                })
                .catch((err) => {
                    // Suppress abort errors triggered by clean invalidation
                    if (err.name !== 'AbortError') {
                        log.warn('Background PlaybackInfo fetch failed:', err);
                    }
                    return null;
                });
        } catch (err) {
            log.warn('Failed to setup background PlaybackInfo prewarm:', err);
            this._playbackInfoPromise = null;
        }
    }

    /**
     * Retrieve pre-cached item metadata if available and valid.
     *
     * @param {string} itemId
     * @returns {Object|null}
     */
    getPrewarmedItem(itemId) {
        // Ensure cache matches requested item ID and is within validity TTL window
        if (this._cachedItemId === itemId && this._cachedItem && Date.now() - this._timestamp < this._ttlMs) {
            log.info(`Cache hit! Reusing pre-loaded item metadata for: ${itemId}`);
            return this._cachedItem;
        }
        return null;
    }

    /**
     * Consume and retrieve the pre-warmed PlaybackInfo Promise.
     * Consuming removes it from the cache to prevent stale re-use.
     *
     * @param {string} itemId
     * @param {Object} options - Play options
     * @returns {Promise<Object>|null}
     */
    consumePlaybackInfo(itemId, options = {}) {
        // Verify that cached item matches, promise exists, and TTL window has not expired
        if (
            this._cachedItemId === itemId &&
            this._playbackInfoPromise &&
            Date.now() - this._timestamp < this._ttlMs
        ) {
            // 1. Validate playback mode: If user forced transcode or remux, generic prewarm cannot be used
            if (options.playbackMode && options.playbackMode !== 'auto') {
                log.debug('Custom playbackMode requested, discarding generic prewarm.');
                this.clear();
                return null;
            }

            // 2. Validate forceDirectPlay & forceTranscode settings parity if tracked
            const activeForceDirectPlay = PlayerSettings.get('forceDirectPlay') || 'off';
            const activeForceTranscode = Boolean(PlayerSettings.get('forceTranscode'));

            if (this._prewarmParams?.forceDirectPlay !== undefined && this._prewarmParams.forceDirectPlay !== activeForceDirectPlay) {
                log.info(
                    `ForceDirectPlay setting changed since prewarm ` +
                    `(prewarmed: ${this._prewarmParams.forceDirectPlay}, active: ${activeForceDirectPlay}). Discarding prewarm.`
                );
                this.clear();
                return null;
            }

            if (this._prewarmParams?.forceTranscode !== undefined && this._prewarmParams.forceTranscode !== activeForceTranscode) {
                log.info(
                    `ForceTranscode setting changed since prewarm ` +
                    `(prewarmed: ${this._prewarmParams.forceTranscode}, active: ${activeForceTranscode}). Discarding prewarm.`
                );
                this.clear();
                return null;
            }

            // 3. Validate MediaSourceId: If user or player selected a different version, invalidate
            if (options.mediaSourceId && this._prewarmParams?.mediaSourceId) {
                if (options.mediaSourceId !== this._prewarmParams.mediaSourceId) {
                    log.info(
                        `MediaSource mismatch (expected ${this._prewarmParams.mediaSourceId}, requested ${options.mediaSourceId}). Discarding prewarm.`
                    );
                    this.clear();
                    return null;
                }
            }

            // =================================================================
            // 3. Validate AudioStreamIndex Parity
            // =================================================================
            // When prewarming occurs, the server-side PlaybackInfo endpoint generates
            // direct-stream or transcoding URLs specifically prepared for the chosen
            // audio track index. If playback is requested with an audio index that
            // differs from what was prewarmed (e.g. prewarmed default vs commentary),
            // consuming the prewarmed data would route playback to the wrong audio stream.
            // Discard the prewarm cache immediately so a clean PlaybackInfo is resolved.
            // =================================================================
            // Compare prewarmed audio index with requested index using type-safe Number coercion
            const prewarmedAudio =
                this._prewarmParams?.audioStreamIndex !== null && this._prewarmParams?.audioStreamIndex !== undefined
                    ? Number(this._prewarmParams.audioStreamIndex)
                    : null;
            const requestedAudio =
                options.audioStreamIndex !== null && options.audioStreamIndex !== undefined
                    ? Number(options.audioStreamIndex)
                    : null;
            if (prewarmedAudio !== requestedAudio) {
                log.info(
                    `Audio stream mismatch (prewarmed: ${prewarmedAudio}, requested: ${requestedAudio}). Discarding prewarm.`
                );
                this.clear();
                return null;
            }

            // =================================================================
            // 4. Validate SubtitleStreamIndex Parity
            // =================================================================
            // Mirroring the audio track guard above, verify that the requested subtitle
            // track matches the prewarmed parameters. If the user selected an alternative
            // subtitle or explicitly toggled subtitles Off (-1), discard the cached prewarm
            // to avoid rendering mismatched or unwanted subtitle streams.
            // =================================================================
            const prewarmedSubtitle =
                this._prewarmParams?.subtitleStreamIndex !== null && this._prewarmParams?.subtitleStreamIndex !== undefined
                    ? Number(this._prewarmParams.subtitleStreamIndex)
                    : null;
            const requestedSubtitle =
                options.subtitleStreamIndex !== null && options.subtitleStreamIndex !== undefined
                    ? Number(options.subtitleStreamIndex)
                    : null;
            if (prewarmedSubtitle !== requestedSubtitle) {
                log.info(
                    `Subtitle stream mismatch (prewarmed: ${prewarmedSubtitle}, requested: ${requestedSubtitle}). Discarding prewarm.`
                );
                this.clear();
                return null;
            }

            // =================================================================
            // 5. Validate Bitrate Limit Parity
            // =================================================================
            // The server picks direct play or a transcode (and its bitrate) from
            // the request's limit. A quality lowered in the OSD must not reuse a
            // response negotiated for the default limit.
            // =================================================================
            const prewarmedBitrate = this._prewarmParams?.maxStreamingBitrate;
            if (options.maxStreamingBitrate && prewarmedBitrate && Number(options.maxStreamingBitrate) !== Number(prewarmedBitrate)) {
                log.info(
                    `Bitrate limit mismatch (prewarmed: ${prewarmedBitrate}, requested: ${options.maxStreamingBitrate}). Discarding prewarm.`
                );
                this.clear();
                return null;
            }

            log.info(`Zero-Latency Cache Hit! Consuming prewarmed PlaybackInfo for: ${itemId}`);
            const promise = this._playbackInfoPromise;
            // Prevent duplicate consumption; subsequent calls will trigger fresh request
            this._playbackInfoPromise = null;
            return promise;
        }
        return null;
    }

    /**
     * Invalidate and clear all cached prewarm data and in-flight requests.
     *
     * Semantic alias for clear() used when playback configuration (such as
     * audio or subtitle tracks) changes during playback. This guarantees that
     * stale prewarmed metadata holding old track defaults will not be consumed
     * on subsequent launches of the media item.
     */
    invalidateCache() {
        // Log cache invalidation event for playback diagnostics
        log.info('Invalidate cache requested — clearing prewarm manager memory and aborting requests');

        // Flush all cached data and abort any ongoing network pre-fetches
        this.clear();
    }

    /**
     * Drop a prewarmed PlaybackInfo that no playback has taken yet, e.g. because
     * the device profile it was built with changed. A request already handed to
     * the player by consumePlaybackInfo() is left to finish.
     */
    discardUnconsumed() {
        if (!this._playbackInfoPromise) return;
        log.info('Device capabilities changed — discarding the prewarmed PlaybackInfo');
        this.clear();
    }

    /**
     * Abort any ongoing network operations and clear memory references.
     */
    clear() {
        // Abort in-flight network request if active
        if (this._abortController) {
            try {
                this._abortController.abort();
            } catch (_) { }
            this._abortController = null;
        }
        // Reset cached variables and tracked parameters
        this._cachedItemId = null;
        this._cachedItem = null;
        this._playbackInfoPromise = null;
        this._prewarmParams = null;
        this._timestamp = 0;
    }
}

/**
 * webOS reports the real panel (UHD, Dolby Vision) only after startup, and a
 * PlaybackInfo prewarmed before that was built with the fallback profile.
 * @param {PrewarmManager} manager
 * @returns {PrewarmManager}
 */
function discardOnCapabilityChange(manager) {
    eventBus.on('webos:deviceInfoReady', () => manager.discardUnconsumed());
    return manager;
}

export const prewarmManager = discardOnCapabilityChange(new PrewarmManager());
export default prewarmManager;
