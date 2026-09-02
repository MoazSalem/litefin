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
        this._cachedItemId = null;
        this._cachedItem = null;
        this._playbackInfoPromise = null;
        this._abortController = null;
        this._timestamp = 0;
        this._ttlMs = 180000; // 3 minutes validity window
    }

    /**
     * Pre-warm a video item and trigger background PlaybackInfo resolution.
     * Safe to call repeatedly; silently no-ops if already pre-warmed.
     *
     * @param {Object} item - The Jellyfin Item object (Movie, Episode, etc.)
     */
    prewarm(item) {
        if (!item || !item.Id) return;

        // Check if user disabled prewarm in settings
        if (PlayerSettings.get('enablePrewarm') === false) return;

        // Skip non-video media types that do not use standard video player
        const validTypes = ['Movie', 'Episode', 'Video', 'TvChannel', 'Trailer'];
        if (item.Type && !validTypes.includes(item.Type) && item.MediaType !== 'Video') {
            return;
        }

        // Avoid re-fetching if already pre-warmed recently (within 60s)
        if (this._cachedItemId === item.Id && Date.now() - this._timestamp < 60000) {
            log.debug(`[Prewarm] Item "${item.Name}" already pre-warmed, skipping duplicate.`);
            return;
        }

        // Cancel any pending prewarm for a previous item
        this.clear();

        log.info(`[Prewarm] Initiating zero-latency prewarm for "${item.Name}" (${item.Id})`);
        this._cachedItemId = item.Id;
        this._cachedItem = item;
        this._timestamp = Date.now();
        this._abortController = new AbortController();

        // 1. Preload subtitle font in background if configured
        try {
            const fontId = SubtitleStyles.getCurrentFontId();
            if (fontId) {
                FontLoader.loadFont(fontId).catch(() => {});
            }
        } catch (_) {}

        // 2. Pre-fetch PlaybackInfo from Jellyfin server
        try {
            const playerBackendSetting = PlayerSettings.get('playerBackend') || 'auto';
            let backendType = 'html5';
            if (playerBackendSetting === 'avplay' || (playerBackendSetting === 'auto' && platformInfo.isTizen)) {
                backendType = 'avplay';
            } else if (playerBackendSetting === 'webos' || (playerBackendSetting === 'auto' && platformInfo.isWebOS)) {
                backendType = 'webos';
            }

            const manualBitrate = PlayerSettings.get('maxBitrateInternet') || 120000000;
            const deviceProfile = buildJellyfinProfile({
                manualBitrate,
                playbackMode: 'auto',
                backend: backendType
            });

            const clonedProfile = JSON.parse(JSON.stringify(deviceProfile));
            const requestBody = {
                DeviceProfile: clonedProfile,
                UserId: api.userId,
                MaxStreamingBitrate: manualBitrate,
                StartTimeTicks: item.UserData?.PlaybackPositionTicks || 0,
                AutoOpenLiveStream: true,
                IsPlayback: true,
                EnableDirectPlay: true,
                EnableDirectStream: true
            };

            const url = `${api.serverUrl}/Items/${item.Id}/PlaybackInfo?UserId=${api.userId}`;
            const headers = {
                'Content-Type': 'application/json'
            };

            if (api.isEmby && api.isEmby()) {
                headers['X-Emby-Authorization'] = `MediaBrowser Client="${api.clientName}", Device="${api.deviceName}", DeviceId="${api.deviceId}", Version="${api.clientVersion}", Token="${api.token}"`;
                headers['X-Emby-Token'] = api.token;
            } else {
                headers['Authorization'] = `MediaBrowser Client="${api.clientName}", Device="${api.deviceName}", DeviceId="${api.deviceId}", Version="${api.clientVersion}", Token="${api.token}"`;
            }

            this._playbackInfoPromise = fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(requestBody),
                signal: this._abortController.signal
            })
                .then(async (res) => {
                    if (!res.ok) {
                        log.warn(`[Prewarm] PlaybackInfo returned HTTP ${res.status}`);
                        return null;
                    }
                    const data = await res.json();
                    log.info(`[Prewarm] Successfully pre-fetched PlaybackInfo for "${item.Name}"!`);
                    return data;
                })
                .catch((err) => {
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
        if (
            this._cachedItemId === itemId &&
            this._playbackInfoPromise &&
            Date.now() - this._timestamp < this._ttlMs
        ) {
            // If user explicitly forced transcode, remux, or custom audio/subtitle index,
            // the server needs a dedicated PlaybackInfo tailored to those overrides.
            if (options.playbackMode && options.playbackMode !== 'auto') {
                log.debug('[Prewarm] Custom playbackMode requested, discarding generic prewarm.');
                this.clear();
                return null;
            }

            log.info(`[Prewarm] Zero-Latency Cache Hit! Consuming prewarmed PlaybackInfo for: ${itemId}`);
            const promise = this._playbackInfoPromise;
            this._playbackInfoPromise = null; // Single consumption
            return promise;
        }
        return null;
    }

    /**
     * Abort any ongoing network operations and clear memory references.
     */
    clear() {
        if (this._abortController) {
            try {
                this._abortController.abort();
            } catch (_) {}
            this._abortController = null;
        }
        this._cachedItemId = null;
        this._cachedItem = null;
        this._playbackInfoPromise = null;
        this._timestamp = 0;
    }
}

export const prewarmManager = new PrewarmManager();
export default prewarmManager;
