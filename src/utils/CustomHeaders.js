/**
 * ============================================================================
 * Litefin - Custom HTTP Headers Utility
 * ============================================================================
 * Centralized manager for reverse proxy authentication headers (Cloudflare
 * Zero Trust / Access, Pangolin, Authelia, Traefik, etc.).
 *
 * Provides safe storage, RFC 7230 header validation, URL origin matching,
 * and preset configurations for Smart TVs and low-spec web runtimes.
 * ============================================================================
 */

import { storage } from './StorageService.js';
import { logger } from './Logger.js';

const log = logger.create('CustomHeaders');

/**
 * Storage key prefix for per-server custom headers.
 * Stored as a JSON-serialized array of header definitions.
 */
const STORAGE_PREFIX = 'litefin:customHeaders:';

/**
 * Valid RFC 7230 token characters for HTTP header names.
 * Ensures custom header keys contain no illegal characters or separators.
 */
const HEADER_NAME_REGEX = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Protected header names that must not be overridden by custom headers.
 * Overriding these would break core Jellyfin or Emby session authentication.
 */
const RESERVED_HEADER_NAMES = new Set(['authorization', 'x-emby-authorization', 'x-emby-token']);

/**
 * Ready-made header presets for standard reverse proxy setups.
 * Allows instant configuration on TV hardware without tedious typing.
 */
export const HEADER_PRESETS = [
    {
        id: 'cloudflare',
        name: 'Cloudflare Zero Trust',
        description: 'CF-Access-Client-Id & CF-Access-Client-Secret',
        headers: [
            { key: 'CF-Access-Client-Id', value: '', enabled: true },
            { key: 'CF-Access-Client-Secret', value: '', enabled: true }
        ]
    },
    {
        id: 'pangolin',
        name: 'Pangolin',
        description: 'P-Access-Token-Id & P-Access-Token',
        headers: [
            { key: 'P-Access-Token-Id', value: '', enabled: true },
            { key: 'P-Access-Token', value: '', enabled: true }
        ]
    }
];

class CustomHeadersManager {
    constructor() {
        /**
         * In-memory cache of normalized header maps keyed by normalized server URL.
         * Eliminates JSON parsing and storage reads on high-frequency API calls.
         */
        this._cache = new Map();

        /**
         * Currently active server URL to fast-path lookups during normal app flow.
         */
        this._activeServerUrl = null;

        /**
         * In-memory cache of resolved Blob URLs for reverse proxy authenticated images.
         * Maps raw Jellyfin image URL to { blobUrl, timestamp }.
         * Enables standard <img> tags and CSS backgrounds to display images protected
         * by Cloudflare Access, Authentik, or Authelia without raw Chromium header limitations.
         */
        this._blobCache = new Map();

        /**
         * In-flight image fetch promises to prevent redundant duplicate network requests
         * when multiple cards or components request the identical poster concurrently.
         */
        this._inFlightImages = new Map();

        /**
         * Maximum number of concurrent Blob URLs retained in memory simultaneously.
         * Sized to comfortably cache active library pages without TV heap pressure.
         */
        this._maxBlobCacheSize = 250;
    }

    /**
     * Normalizes a server URL by trimming whitespace and trailing slashes.
     *
     * @param {string} url - Raw server URL
     * @returns {string} Cleaned server URL
     */
    normalizeServerUrl(url) {
        if (!url || typeof url !== 'string') return '';
        return url.trim().replace(/\/+$/, '');
    }

    /**
     * Retrieves the storage key for a specific server address.
     *
     * @param {string} serverUrl - Server base URL
     * @returns {string} Unique storage key
     */
    getStorageKey(serverUrl) {
        const normalized = this.normalizeServerUrl(serverUrl);
        return `${STORAGE_PREFIX}${normalized}`;
    }

    /**
     * Retrieves stored custom header configurations for a server.
     *
     * @param {string} serverUrl - Server address
     * @returns {Array<{key: string, value: string, enabled: boolean, presetId?: string}>} Header list
     */
    getServerHeaders(serverUrl) {
        if (!serverUrl) return [];
        const normalized = this.normalizeServerUrl(serverUrl);
        const key = this.getStorageKey(normalized);

        try {
            let raw = storage.getItem(key);

            // Protocol-agnostic fallback lookup:
            // Allows retrieving headers saved with or without http/https scheme,
            // preventing configuration drops if user entered a bare hostname in the modal.
            if (!raw) {
                if (/^https?:\/\//i.test(normalized)) {
                    const withoutProto = normalized.replace(/^https?:\/\//i, '');
                    raw = storage.getItem(this.getStorageKey(withoutProto));
                } else {
                    raw =
                        storage.getItem(this.getStorageKey(`https://${normalized}`)) ||
                        storage.getItem(this.getStorageKey(`http://${normalized}`));
                }
            }

            if (!raw) return [];
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        } catch (error) {
            log.error(`Failed to parse custom headers for ${serverUrl}:`, error);
            return [];
        }
    }

    /**
     * Saves custom header configurations for a specific server address.
     *
     * @param {string} serverUrl - Server address
     * @param {Array<{key: string, value: string, enabled: boolean, presetId?: string}>} headers - Header array
     */
    setServerHeaders(serverUrl, headers) {
        if (!serverUrl) return;
        const normalized = this.normalizeServerUrl(serverUrl);
        const key = this.getStorageKey(normalized);

        // Filter and sanitize entries before writing to storage
        const sanitized = (headers || [])
            .filter((h) => h && typeof h.key === 'string' && h.key.trim().length > 0)
            .map((h) => ({
                key: h.key.trim(),
                value: typeof h.value === 'string' ? h.value.trim() : '',
                enabled: h.enabled !== false,
                presetId: h.presetId || null
            }));

        if (sanitized.length > 0) {
            storage.setItem(key, JSON.stringify(sanitized));
        } else {
            storage.removeItem(key);
        }

        // Invalidate in-memory cache for this server address
        this._cache.delete(normalized);
        this.clearBlobCache();
        log.info(`Updated custom headers for ${normalized} (${sanitized.length} entries)`);
    }

    /**
     * Validates and converts raw header entries into an outgoing HTTP header object.
     * Drops disabled, malformed, control-character-laden, or reserved keys.
     *
     * @param {Array<{key: string, value: string, enabled: boolean}>} headers - Raw header items
     * @returns {Object<string, string>} Sanitized key-value dictionary
     */
    normalizeHeaders(headers) {
        const result = {};
        if (!Array.isArray(headers)) return result;

        const seenKeys = new Set();

        for (const item of headers) {
            if (!item || !item.enabled || !item.key || !item.value) {
                continue;
            }

            const rawKey = item.key.trim();
            const rawValue = item.value.trim();
            const lowerKey = rawKey.toLowerCase();

            // Validate header name against RFC 7230 token specifications
            if (!HEADER_NAME_REGEX.test(rawKey)) {
                log.warn(`Skipping invalid header name: ${rawKey}`);
                continue;
            }

            // Guard against control characters in values to prevent header injection
            let hasControlChars = false;
            for (let i = 0; i < rawValue.length; i++) {
                const code = rawValue.charCodeAt(i);
                if (code <= 0x1f || code === 0x7f) {
                    hasControlChars = true;
                    break;
                }
            }
            if (hasControlChars) {
                log.warn(`Skipping header with control characters: ${rawKey}`);
                continue;
            }

            // Guard against collisions with core Jellyfin and Emby auth headers
            if (RESERVED_HEADER_NAMES.has(lowerKey)) {
                log.warn(`Skipping reserved auth header: ${rawKey}`);
                continue;
            }

            // Case-insensitive deduplication — first entry wins
            if (seenKeys.has(lowerKey)) {
                continue;
            }

            seenKeys.add(lowerKey);
            result[rawKey] = rawValue;
        }

        return result;
    }

    /**
     * Retrieves sanitized, ready-to-send headers for a specific server URL.
     * Uses in-memory caching to eliminate repeated storage reads and parsing.
     *
     * @param {string} serverUrl - Server address
     * @returns {Object<string, string>} Dictionary of HTTP headers
     */
    getNormalizedHeaders(serverUrl) {
        if (!serverUrl) return {};
        const normalized = this.normalizeServerUrl(serverUrl);

        if (this._cache.has(normalized)) {
            return this._cache.get(normalized);
        }

        const rawList = this.getServerHeaders(normalized);
        const normalizedHeaders = this.normalizeHeaders(rawList);

        this._cache.set(normalized, normalizedHeaders);
        return normalizedHeaders;
    }

    /**
     * Checks if a destination URL matches the configured server origin and base path.
     * Prevents leaking proxy credentials to external CDNs, TMDB, or third-party hosts.
     *
     * @param {string} requestUrl - Destination URL
     * @param {string} serverUrl - Jellyfin server base URL
     * @returns {boolean} True if the request is destined for the server
     */
    isUrlForServer(requestUrl, serverUrl) {
        if (!requestUrl || !serverUrl) return false;

        const normalizedServer = this.normalizeServerUrl(serverUrl);

        // Fast-path prefix check for standard server sub-paths
        if (
            requestUrl.length > normalizedServer.length &&
            requestUrl.startsWith(`${normalizedServer}/`) &&
            !requestUrl.includes('..')
        ) {
            return true;
        }

        // Full URL origin and path comparison fallback
        try {
            const parsedReq = new URL(requestUrl, normalizedServer);
            const parsedServer = new URL(normalizedServer);

            if (parsedReq.origin !== parsedServer.origin) {
                return false;
            }

            const serverPath = parsedServer.pathname.replace(/\/+$/, '');
            if (!serverPath || serverPath === '') {
                return true;
            }

            return parsedReq.pathname === serverPath || parsedReq.pathname.startsWith(`${serverPath}/`);
        } catch (_) {
            return false;
        }
    }

    /**
     * Retrieves custom headers if the target URL belongs to the server.
     *
     * @param {string} url - Target request URL
     * @param {string} serverUrl - Active server URL
     * @returns {Object<string, string>} Custom headers or empty object
     */
    getHeadersForUrl(url, serverUrl) {
        if (!url || !serverUrl) return {};
        if (!this.isUrlForServer(url, serverUrl)) return {};

        return this.getNormalizedHeaders(serverUrl);
    }

    /**
     * Sets the active server URL for convenience lookups.
     *
     * @param {string} serverUrl - Currently connected server URL
     */
    setActiveServer(serverUrl) {
        this._activeServerUrl = this.normalizeServerUrl(serverUrl);
    }

    /**
     * Gets custom headers for the currently active server.
     *
     * @returns {Object<string, string>} Active headers
     */
    getActiveHeaders() {
        return this.getNormalizedHeaders(this._activeServerUrl);
    }

    /**
     * Checks if custom reverse proxy headers are configured and active for a server.
     * Fast-path check so image components can avoid asynchronous resolution when
     * operating on standard local networks without custom authentication headers.
     *
     * @param {string} [serverUrl] - Optional server address to inspect
     * @returns {boolean} True if at least one custom header is defined and active
     */
    hasCustomHeaders(serverUrl) {
        // Resolve headers against specific server or fall back to globally active server
        const headers = serverUrl ? this.getNormalizedHeaders(serverUrl) : this.getActiveHeaders();

        // Check if header dictionary contains any valid key-value pairs
        return Boolean(headers && Object.keys(headers).length > 0);
    }

    /**
     * Synchronously returns a previously resolved and cached Blob URL if available.
     * Provides zero-overhead, frame-accurate rendering for cards and pages revisited
     * within the same browsing session.
     *
     * @param {string} url - Target media image URL
     * @returns {string|null} Cached Blob URL or null if not yet resolved
     */
    getCachedBlobUrl(url) {
        // Guard against falsy URL inputs
        if (!url || typeof url !== 'string') return null;

        // Retrieve existing blob URL wrapper from memory cache
        const entry = this._blobCache.get(url);
        return entry?.blobUrl || null;
    }

    /**
     * =========================================================================
     * Authenticated Image URL Resolver
     * =========================================================================
     * Standard HTML5 <img> tags and CSS url('...') directives cannot attach
     * custom HTTP headers in browser WebViews. When operating behind Zero Trust
     * proxies (Cloudflare Access, Authentik, etc.), requests for artwork receive
     * 403 Forbidden or HTML login pages.
     *
     * This method intercepts artwork requests for protected servers, performs
     * a CORS-compliant fetch() with the required service token headers, and
     * converts the resulting binary payload into an in-memory blob: URL.
     *
     * For URLs not matching the protected server, or when no custom headers are
     * configured, the original URL is returned synchronously without overhead.
     * =========================================================================
     *
     * @param {string} url - Target artwork or backdrop image URL
     * @param {string} [serverUrl] - Optional server URL override
     * @returns {Promise<string>} Blob URL or original image URL
     */
    async resolveImageUrl(url, serverUrl) {
        // Fast-path exit for invalid or empty image paths
        if (!url || typeof url !== 'string') return url;

        // Fast-path exit for local data URIs, SVGs, or already resolved blob URLs
        if (url.startsWith('data:') || url.startsWith('blob:')) {
            return url;
        }

        // Determine destination server address
        const targetServer = serverUrl || this._activeServerUrl;

        // Verify if destination belongs to the server and requires reverse proxy headers
        const headers = this.getHeadersForUrl(url, targetServer);
        if (!headers || Object.keys(headers).length === 0) {
            return url;
        }

        // 1. Check in-memory blob cache for immediate synchronous hit
        const cached = this._blobCache.get(url);
        if (cached && cached.blobUrl) {
            return cached.blobUrl;
        }

        // 2. Deduplicate in-flight fetch requests for the exact same image
        if (this._inFlightImages.has(url)) {
            return await this._inFlightImages.get(url);
        }

        // 3. Initiate authenticated fetch with custom headers
        const fetchPromise = (async () => {
            try {
                // Execute fetch with custom headers
                const response = await fetch(url, {
                    headers,
                    mode: 'cors'
                });

                // Check for successful HTTP status
                if (!response.ok) {
                    log.warn(`Authenticated image fetch failed (HTTP ${response.status}) for ${url}`);
                    return url;
                }

                // Convert response stream to binary blob
                const blob = await response.blob();

                // Allocate native browser Object URL for the blob
                const blobUrl = URL.createObjectURL(blob);

                // Enforce bounded LRU cache limit to prevent memory leak on TV devices
                if (this._blobCache.size >= this._maxBlobCacheSize) {
                    const oldestKey = this._blobCache.keys().next().value;
                    const oldest = this._blobCache.get(oldestKey);

                    // Revoke old blob URL to release native memory back to the OS
                    if (oldest?.blobUrl) {
                        try {
                            URL.revokeObjectURL(oldest.blobUrl);
                        } catch (_) {}
                    }
                    this._blobCache.delete(oldestKey);
                }

                // Store in cache with current timestamp for eviction tracking
                this._blobCache.set(url, { blobUrl, timestamp: Date.now() });
                return blobUrl;
            } catch (err) {
                // Non-fatal warning if network fails — fall back to original URL
                log.warn(`Failed to fetch authenticated image: ${err?.message || err}`);
                return url;
            } finally {
                // Clear active in-flight tracking once network promise settles
                this._inFlightImages.delete(url);
            }
        })();

        // Track in-flight operation and await result
        this._inFlightImages.set(url, fetchPromise);
        return await fetchPromise;
    }

    /**
     * Revokes all allocated in-memory Blob URLs and purges image caches.
     * Prevents memory leaks upon server switching, logout, or session termination.
     */
    clearBlobCache() {
        // Iterate through all cached blob entries and revoke native handles
        for (const entry of this._blobCache.values()) {
            if (entry?.blobUrl) {
                try {
                    URL.revokeObjectURL(entry.blobUrl);
                } catch (_) {}
            }
        }

        // Flush tracking maps
        this._blobCache.clear();
        this._inFlightImages.clear();
        log.debug('CustomHeaders blob URL cache purged');
    }

    /**
     * Clears all in-memory caches including headers and allocated image blobs.
     */
    clearCache() {
        this._cache.clear();
        this.clearBlobCache();
    }
}

export const customHeaders = new CustomHeadersManager();
