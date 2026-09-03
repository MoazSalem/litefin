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
import { api } from '../../api/index.js';
import { PlayerSettings } from '../../utils/PlayerSettings.js';
import { buildJellyfinProfile } from '../../api/DeviceProfile.js';
import FontLoader from '../../utils/FontLoader.js';
import SubtitleStyles from '../../utils/SubtitleStyles.js';
import { platformInfo } from '../../utils/PlatformInfo.js';

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
        // Resolve target audio track (specified override or null/default)
        const targetAudioIndex = prewarmOptions.audioStreamIndex ?? null;
        // Resolve target subtitle track (specified override or null/default)
        const targetSubtitleIndex = prewarmOptions.subtitleStreamIndex ?? null;

        // Check if item is already prewarmed with identical track and media source options
        const isSameItem = this._cachedItemId === item.Id;
        const isFresh = Date.now() - this._timestamp < 60000;
        const isSameSource = this._prewarmParams?.mediaSourceId === targetMediaSourceId;
        const isSameAudio = this._prewarmParams?.audioStreamIndex === targetAudioIndex;
        const isSameSubtitle = this._prewarmParams?.subtitleStreamIndex === targetSubtitleIndex;

        if (isSameItem && isFresh && isSameSource && isSameAudio && isSameSubtitle) {
            log.debug(`[Prewarm] Item "${item.Name}" already pre-warmed with matching parameters, skipping duplicate.`);
            return;
        }

        // Cancel any pending prewarm for a previous item or differing configuration
        this.clear();

        log.info(`[Prewarm] Initiating zero-latency prewarm for "${item.Name}" (${item.Id})`, {
            mediaSourceId: targetMediaSourceId,
            audioStreamIndex: targetAudioIndex,
            subtitleStreamIndex: targetSubtitleIndex
        });

        // Store active caching state
        this._cachedItemId = item.Id;
        this._cachedItem = item;
        this._timestamp = Date.now();
        this._abortController = new AbortController();
        this._prewarmParams = {
            mediaSourceId: targetMediaSourceId,
            audioStreamIndex: targetAudioIndex,
            subtitleStreamIndex: targetSubtitleIndex,
            playbackMode: 'auto'
        };

        // 1. Preload subtitle font in background if configured
        try {
            const fontId = SubtitleStyles.getCurrentFontId();
            if (fontId) {
                FontLoader.loadFont(fontId).catch(() => {});
            }
        } catch (_) {}

        // 2. Pre-fetch PlaybackInfo from Jellyfin server using ApiClient
        try {
            // Determine video player backend configuration based on platform
            const playerBackendSetting = PlayerSettings.get('playerBackend') || 'auto';
            let backendType = 'html5';
            if (playerBackendSetting === 'avplay' || (playerBackendSetting === 'auto' && platformInfo.isTizen)) {
                backendType = 'avplay';
            } else if (playerBackendSetting === 'webos' || (playerBackendSetting === 'auto' && platformInfo.isWebOS)) {
                backendType = 'webos';
            }

            // Retrieve maximum streaming bitrate configured by user or default to 120Mbps
            const manualBitrate = PlayerSettings.get('maxBitrateInternet') || 120000000;
            // Build the device profile according to player capabilities and platform
            const deviceProfile = buildJellyfinProfile({
                manualBitrate,
                playbackMode: 'auto',
                backend: backendType
            });

            // Clone profile to prevent accidental external mutations
            const clonedProfile = JSON.parse(JSON.stringify(deviceProfile));
            // Assemble base PlaybackInfo request payload
            const requestBody = {
                DeviceProfile: clonedProfile,
                UserId: api.userId,
                MaxStreamingBitrate: manualBitrate,
                StartTimeTicks: prewarmOptions.startPositionTicks ?? (item.UserData?.PlaybackPositionTicks || 0),
                AutoOpenLiveStream: true,
                IsPlayback: true,
                EnableDirectPlay: true,
                EnableDirectStream: true
            };

            // Attach MediaSourceId if specifically resolved and not a dynamic Live TV channel
            const isLiveChannel = item.Type === 'TvChannel';
            if (targetMediaSourceId && !isLiveChannel) {
                requestBody.MediaSourceId = targetMediaSourceId;
            }

            // Attach requested AudioStreamIndex if explicitly provided
            if (targetAudioIndex !== null && targetAudioIndex !== undefined) {
                requestBody.AudioStreamIndex = targetAudioIndex;
            }

            // Attach requested SubtitleStreamIndex if explicitly provided (and not disabled -1)
            if (targetSubtitleIndex !== null && targetSubtitleIndex !== undefined && targetSubtitleIndex >= 0) {
                requestBody.SubtitleStreamIndex = targetSubtitleIndex;
            }

            // Execute PlaybackInfo request through ApiClient to standardize auth headers and error handling
            this._playbackInfoPromise = api.post(
                `/Items/${item.Id}/PlaybackInfo?UserId=${api.userId}`,
                requestBody,
                { signal: this._abortController.signal }
            )
                .then((data) => {
                    log.info(`[Prewarm] Successfully pre-fetched PlaybackInfo for "${item.Name}"!`);
                    return data;
                })
                .catch((err) => {
                    // Suppress abort errors triggered by clean invalidation
                    if (err.name !== 'AbortError') {
                        log.warn('[Prewarm] Background PlaybackInfo fetch failed:', err);
                    }
                    return null;
                });
        } catch (err) {
            log.warn('[Prewarm] Failed to setup background PlaybackInfo prewarm:', err);
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
            log.info(`[Prewarm] Cache hit! Reusing pre-loaded item metadata for: ${itemId}`);
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
                log.debug('[Prewarm] Custom playbackMode requested, discarding generic prewarm.');
                this.clear();
                return null;
            }

            // 2. Validate MediaSourceId: If user or player selected a different version, invalidate
            if (options.mediaSourceId && this._prewarmParams?.mediaSourceId) {
                if (options.mediaSourceId !== this._prewarmParams.mediaSourceId) {
                    log.info(
                        `[Prewarm] MediaSource mismatch (expected ${this._prewarmParams.mediaSourceId}, requested ${options.mediaSourceId}). Discarding prewarm.`
                    );
                    this.clear();
                    return null;
                }
            }

            // 3. Validate AudioStreamIndex: If a specific audio track was chosen and differs from prewarm
            if (options.audioStreamIndex !== undefined && options.audioStreamIndex !== null) {
                if (
                    this._prewarmParams?.audioStreamIndex !== null &&
                    this._prewarmParams?.audioStreamIndex !== undefined &&
                    options.audioStreamIndex !== this._prewarmParams.audioStreamIndex
                ) {
                    log.info(
                        `[Prewarm] Audio stream mismatch (prewarmed: ${this._prewarmParams.audioStreamIndex}, requested: ${options.audioStreamIndex}). Discarding prewarm.`
                    );
                    this.clear();
                    return null;
                }
            }

            // 4. Validate SubtitleStreamIndex: If a specific subtitle track was chosen and differs from prewarm
            if (options.subtitleStreamIndex !== undefined && options.subtitleStreamIndex !== null) {
                if (
                    this._prewarmParams?.subtitleStreamIndex !== null &&
                    this._prewarmParams?.subtitleStreamIndex !== undefined &&
                    options.subtitleStreamIndex !== this._prewarmParams.subtitleStreamIndex
                ) {
                    log.info(
                        `[Prewarm] Subtitle stream mismatch (prewarmed: ${this._prewarmParams.subtitleStreamIndex}, requested: ${options.subtitleStreamIndex}). Discarding prewarm.`
                    );
                    this.clear();
                    return null;
                }
            }

            log.info(`[Prewarm] Zero-Latency Cache Hit! Consuming prewarmed PlaybackInfo for: ${itemId}`);
            const promise = this._playbackInfoPromise;
            // Prevent duplicate consumption; subsequent calls will trigger fresh request
            this._playbackInfoPromise = null;
            return promise;
        }
        return null;
    }

    /**
     * Abort any ongoing network operations and clear memory references.
     */
    clear() {
        // Abort in-flight network request if active
        if (this._abortController) {
            try {
                this._abortController.abort();
            } catch (_) {}
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

export const prewarmManager = new PrewarmManager();
export default prewarmManager;
