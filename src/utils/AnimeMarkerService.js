/**
 * ============================================================================
 * Litefin - Anime Marker & Episode Badge Service
 * ============================================================================
 * Manages classification metadata for anime episodes:
 * - Content categories: Filler, Mixed Canon/Filler, and Recap markers.
 * - Audio categories: Subbed, Dubbed, and Subbed/Dubbed stream classifications.
 *
 * Provides thread-safe in-memory caching, request deduplication, and
 * fallback discovery across active Jellyfin server companion extensions.
 * ============================================================================
 */

import { api } from '../api/index.js';
import { i18n } from './i18n.js';
import { logger } from './Logger.js';
import { AudioClassifier } from './AudioClassifier.js';
import { escapeHtml } from './Utils.js';

const log = logger.create('AnimeMarkerService');

/** Cache validity duration for series marker listings (30 minutes) */
const CACHE_TTL_MS = 30 * 60 * 1000;

/** Backoff duration for negative caching on 404 or missing markers (3 minutes) */
const NEGATIVE_CACHE_TTL_MS = 3 * 60 * 1000;

class AnimeMarkerService {
    constructor() {
        /**
         * Series marker cache keyed by normalized series ID.
         * Stores { fetchedAt: number, data: { episodes: Object, seasons: Object } }
         * @type {Map<string, Object>}
         */
        this._seriesCache = new Map();

        /**
         * Negative cache recording failure or missing marker timestamps.
         * @type {Map<string, number>}
         */
        this._negativeCache = new Map();

        /**
         * In-flight network request promises to deduplicate simultaneous callers.
         * @type {Map<string, Promise>}
         */
        this._pendingRequests = new Map();

        /**
         * Tracks whether the server companion extension is disabled globally.
         * @type {number}
         */
        this._featureOffTimestamp = 0;
        // Observers notified whenever series markers finish loading
        this._listeners = new Set();
    }

    /**
     * Standardizes GUIDs and IDs into lowercase alphanumeric tokens without hyphens.
     *
     * @param {string} [id] - Raw item identifier
     * @returns {string} Sanitized ID token
     */
    normalizeId(id) {
        if (!id) return '';
        return String(id).replace(/-/g, '').toLowerCase();
    }

    /**
     * Checks if a series has been negatively cached within the backoff window.
     *
     * @param {string} key - Normalized series key
     * @returns {boolean} True if negative cache is active
     */
    isNegativelyCached(key) {
        const timestamp = this._negativeCache.get(key);
        if (!timestamp) return false;

        // Check if backoff window is still active
        if (Date.now() - timestamp < NEGATIVE_CACHE_TTL_MS) {
            return true;
        }

        // Expired negative cache entry
        this._negativeCache.delete(key);
        return false;
    }

    /**
     * Registers a callback invoked whenever series markers finish loading.
     * Allows UI renderers to flush cached HTML and re-render with fresh badges.
     *
     * @param {Function} callback - Function receiving (seriesId, parsedData)
     * @returns {Function} Unsubscribe teardown function
     */
    onMarkersLoaded(callback) {
        if (typeof callback === 'function') {
            this._listeners.add(callback);
        }
        return () => this._listeners.delete(callback);
    }

    /**
     * Broadcasts marker load events to all registered listeners.
     *
     * @param {string} seriesId - Normalized series identifier
     * @param {Object} data - Parsed marker dataset
     * @private
     */
    _notifyMarkersLoaded(seriesId, data) {
        this._listeners.forEach((listener) => {
            try {
                listener(seriesId, data);
            } catch (err) {
                // Ignore listener exceptions to protect core loop
            }
        });
    }

    /**
     * Clears all memory caches and in-flight promises.
     * Should be invoked on logout or server transition.
     */
    clearCache() {
        this._seriesCache.clear();
        this._negativeCache.clear();
        this._pendingRequests.clear();
        this._featureOffTimestamp = 0;
    }

    /**
     * Synchronously returns cached series markers from memory if available.
     * Prevents async delay during synchronous card rendering.
     *
     * @param {string} seriesId - Jellyfin series identifier
     * @returns {Object|null} Cached marker data or null if not yet loaded
     */
    getCachedSeriesMarkers(seriesId) {
        const key = this.normalizeId(seriesId);
        if (!key) return null;
        const cached = this._seriesCache.get(key);
        if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
            return cached.data;
        }
        return null;
    }

    /**
     * Retrieves classification metadata for an entire series from the Litefin companion plugin.
     * Falls back to local heuristic checks if the server plugin is not installed.
     *
     * @param {string} seriesId - Jellyfin series identifier
     * @returns {Promise<Object|null>} Object containing episodes and seasons classification maps
     */
    async fetchSeriesMarkers(seriesId) {
        // Normalize unique identifier to ensure clean dictionary lookups
        const key = this.normalizeId(seriesId);
        if (!key) return null;

        // --------------------------------------------------------------------
        // Check global circuit breaker state
        // If the server reported that companion anime markers are disabled,
        // we skip network attempts across all series for the cooldown window.
        // --------------------------------------------------------------------
        if (this._featureOffTimestamp > 0 && Date.now() - this._featureOffTimestamp < CACHE_TTL_MS) {
            log.verbose(`Skipping fetch for ${seriesId}: feature globally backed off (server reported disabled)`);
            return null;
        }

        // --------------------------------------------------------------------
        // Evaluate primary in-memory cache
        // Hot-path cache hit: return cached metadata immediately without logging
        // to avoid flooding the console during rapid grid / row rendering.
        // --------------------------------------------------------------------
        const cached = this._seriesCache.get(key);
        if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
            log.verbose(`Skipping fetch for ${seriesId}: served from memory cache`);
            return cached.data;
        }

        // --------------------------------------------------------------------
        // Verify negative cache backoff
        // Suppresses redundant 404 queries for series that previously failed.
        // --------------------------------------------------------------------
        if (this.isNegativelyCached(key)) {
            log.verbose(`Skipping fetch for ${seriesId}: negatively cached (previous failure/missing data)`);
            return null;
        }

        // --------------------------------------------------------------------
        // Concurrency deduplication
        // Reuse in-flight network promise if a query for this series is running.
        // --------------------------------------------------------------------
        if (this._pendingRequests.has(key)) {
            log.verbose(`Skipping fetch for ${seriesId}: request already in flight (deduplicated)`);
            return this._pendingRequests.get(key);
        }

        // Construct background fetch task
        const requestPromise = (async () => {
            try {
                // Validate host server endpoint configuration
                const serverUrl = api.serverUrl;
                if (!serverUrl) {
                    log.debug(`Cannot fetch anime markers for ${seriesId}: no server URL configured`);
                    return null;
                }

                // Verbose tracing for background fetch lifecycle
                log.verbose(`Requesting Litefin AnimeMarkers for series ${seriesId}...`);

                let responseData = null;

                // ------------------------------------------------------------
                // Strategy 1: Query native Litefin companion endpoint
                // ------------------------------------------------------------
                try {
                    responseData = await api.get(
                        `/Litefin/AnimeMarkers/Series`,
                        { seriesId },
                        { silent: true, warnOnError: false }
                    );
                    if (responseData) {
                        const epCount = responseData.episodes ? Object.keys(responseData.episodes).length : 0;
                        log.verbose(`Litefin AnimeMarkers responded: matched=${responseData.matched}, slug=${responseData.slug || 'none'}, episodes=${epCount}, seasons=${responseData.seasons ? Object.keys(responseData.seasons).length : 0}`);
                    } else {
                        log.verbose('Litefin AnimeMarkers returned an empty response');
                    }
                } catch (litefinErr) {
                    log.verbose(`Litefin AnimeMarkers request failed (status=${litefinErr?.status || 'unknown'}): ${litefinErr?.message || litefinErr}`);
                    responseData = null;
                }

                // ------------------------------------------------------------
                // Strategy 2: Local heuristics fallback probe
                // When dedicated companion plugins are absent, query the core
                // series item to determine whether local anime rules apply.
                // ------------------------------------------------------------
                if (!responseData) {
                    try {
                        // Request core series metadata with necessary classification fields
                        const seriesItem = await api.getItem(seriesId, {
                            Fields: 'Genres,Tags,ProviderIds,Path,Studios'
                        });

                        // Run heuristic classifier against series attributes
                        const isAnimeMatch = this.isAnime(seriesItem);
                        log.verbose(`AnimeMarkers endpoints unavailable for series ${seriesId}; local probe isAnime=${isAnimeMatch}`);
                        const fallbackData = {
                            episodes: {},
                            seasons: {},
                            matched: isAnimeMatch,
                            isAnime: isAnimeMatch
                        };

                        // Cache local probe verdict with reduced TTL to allow subsequent plugin sync
                        this._seriesCache.set(key, {
                            fetchedAt: Date.now() - CACHE_TTL_MS + NEGATIVE_CACHE_TTL_MS,
                            data: fallbackData
                        });

                        // Notify UI listeners only if anime was successfully identified
                        if (isAnimeMatch) {
                            this._notifyMarkersLoaded(key, fallbackData);
                        }

                        return fallbackData;
                    } catch (probeErr) {
                        log.debug(`Anime markers probe failed for series ${seriesId}: ${probeErr?.message || probeErr}`);
                        this._negativeCache.set(key, Date.now());
                        return null;
                    }
                }

                // Server signaled explicit feature deactivation
                if (responseData.enabled === false) {
                    log.debug(`Litefin AnimeMarkers reports feature disabled for this server; backing off globally`);
                    this._featureOffTimestamp = Date.now();
                    return null;
                }

                // Temporary pending status on remote processing
                if (responseData.pending === true) {
                    log.verbose(`Litefin AnimeMarkers reports processing pending for series ${seriesId}; retrying later`);
                    this._negativeCache.set(key, Date.now());
                    return null;
                }

                // ------------------------------------------------------------
                // Transform and normalize episode classification dictionaries
                // ------------------------------------------------------------
                const episodes = {};
                const rawEpisodes = responseData.episodes || {};
                Object.keys(rawEpisodes).forEach((epId) => {
                    const entry = rawEpisodes[epId];
                    if (!entry) return;

                    // Map content types (Filler, Mixed, MangaCanon, AnimeCanon)
                    let normalizedKind = null;
                    if (entry.kind !== null && entry.kind !== undefined) {
                        const kindStr = String(entry.kind).toLowerCase();
                        if (kindStr === 'filler' || entry.kind === 3) {
                            normalizedKind = 'Filler';
                        } else if (kindStr === 'mixed' || entry.kind === 2) {
                            normalizedKind = 'Mixed';
                        } else if (kindStr === 'mangacanon' || kindStr === 'manga_canon' || entry.kind === 0) {
                            normalizedKind = 'MangaCanon';
                        } else if (kindStr === 'animecanon' || kindStr === 'anime_canon' || entry.kind === 1) {
                            normalizedKind = 'AnimeCanon';
                        }
                    }

                    // Cast recap flag cleanly across string and numeric inputs
                    const isRecap = entry.recap === true || entry.recap === 'true' || entry.recap === 1;

                    episodes[this.normalizeId(epId)] = {
                        kind: normalizedKind,
                        recap: isRecap,
                        audio: entry.audio || null
                    };
                });

                // ------------------------------------------------------------
                // Transform season level audio verdicts
                // ------------------------------------------------------------
                const seasons = {};
                const rawSeasons = responseData.seasons || {};
                Object.keys(rawSeasons).forEach((seasonId) => {
                    const seasonEntry = rawSeasons[seasonId];
                    if (seasonEntry?.audio) {
                        seasons[this.normalizeId(seasonId)] = seasonEntry.audio;
                    }
                });

                // ------------------------------------------------------------
                // Check if any episode contains verified anime content kinds
                // (Filler, Mixed, MangaCanon, AnimeCanon) or recap flag
                // ------------------------------------------------------------
                const hasAnimeContentMarkers = Object.values(episodes).some(
                    (e) => e && (e.kind === 'Filler' || e.kind === 'Mixed' || e.kind === 'MangaCanon' || e.kind === 'AnimeCanon' || e.recap)
                );

                // Confirm whether series satisfies anime classification criteria:
                // requires either an explicit database slug match from the server OR
                // verified anime content markers present on the episode list
                const isConfirmedAnime =
                    (responseData.matched === true && Boolean(responseData.slug)) ||
                    hasAnimeContentMarkers;

                const parsedData = {
                    episodes,
                    seasons,
                    matched: isConfirmedAnime,
                    isAnime: isConfirmedAnime,
                    slug: responseData.slug || null,
                    title: responseData.title || null
                };

                // Store resolved metadata payload in primary memory cache
                this._seriesCache.set(key, {
                    fetchedAt: Date.now(),
                    data: parsedData
                });

                // Only emit debug log if anime markers were actually discovered
                if (isConfirmedAnime && (hasAnimeContentMarkers || (responseData.matched && responseData.slug))) {
                    log.debug(`Anime markers loaded for series ${seriesId}: ${Object.keys(episodes).length} episode entries, content kinds: ${Object.values(episodes).filter((e) => e.kind === 'Filler' || e.kind === 'Mixed').length} filler/mixed, ${Object.values(episodes).filter((e) => e.recap).length} recap`);
                }

                // Broadcast cache invalidation and UI updates to listeners
                this._notifyMarkersLoaded(key, parsedData);

                return parsedData;
            } catch (error) {
                // Unexpected runtime exception during parsing or network call
                log.error(`Anime markers fetch threw unexpectedly for series ${seriesId}: ${error?.message || error}`, error);
                this._negativeCache.set(key, Date.now());
                return null;
            } finally {
                // Clear active in-flight request registration
                this._pendingRequests.delete(key);
            }
        })();

        this._pendingRequests.set(key, requestPromise);
        return requestPromise;
    }

    /**
     * Resolves individual episode marker metadata from preloaded series data.
     * Supports direct lookup by normalized episode identifier, and fallback lookup by episode IndexNumber.
     *
     * @param {Object} seriesMarkers - Preloaded series markers data
     * @param {string} [episodeId] - Episode identifier GUID
     * @param {Object} [episode] - Optional episode item model for index-based fallback
     * @returns {Object|null} Marker entry containing { kind, recap, audio }
     */
    getEpisodeMarker(seriesMarkers, episodeId, episode = null) {
        if (!seriesMarkers?.episodes) return null;

        // Primary lookup: direct match by normalized episode GUID
        if (episodeId) {
            const normalizedId = this.normalizeId(episodeId);
            const direct = seriesMarkers.episodes[normalizedId];
            if (direct) return direct;
        }

        // Secondary lookup: fallback match by episode index number
        const indexNum = episode?.IndexNumber ?? episode?.Index;
        if (indexNum != null) {
            const numKey = String(indexNum);
            if (seriesMarkers.episodes[numKey]) {
                return seriesMarkers.episodes[numKey];
            }
        }

        return null;
    }

    /**
     * Determines whether a given media item (or its parent series) represents anime content.
     * Evaluates multiple deterministic criteria:
     * 1. Server companion match indicators (AnimeFillerList slug or matched flag).
     * 2. Dedicated anime metadata provider IDs (AniList, AniDB, Kitsu, MyAnimeList).
     * 3. Specific Anime genre descriptors.
     * 4. Media tags containing 'anime'.
     * 5. Storage filesystem paths (e.g. /Anime/ or \Anime\).
     * 6. Dedicated anime animation studios.
     * 7. Animation genre combined with Japanese audio track or Japanese script in title.
     *
     * @param {Object} [item] - Jellyfin episode, series, or movie item
     * @param {Object} [seriesMarkers] - Optional preloaded series markers
     * @param {Object} [options] - Additional context options
     * @returns {boolean} True if the item is verified as anime
     */
    isAnime(item, seriesMarkers = null, options = {}) {
        if (!item) return false;

        // 1. Direct validation via preloaded or explicit series markers
        // Explicit positive match requires database slug synchronization OR verified content markers
        if (seriesMarkers) {
            // Check if backend companion confirmed anime match with a registered slug
            if ((seriesMarkers.matched === true && Boolean(seriesMarkers.slug)) || seriesMarkers.isAnime === true) {
                return true;
            }
            // Verify if marker payload contains verified anime kinds (Filler, Mixed, Manga/Anime Canon, Recap)
            if (seriesMarkers.episodes && typeof seriesMarkers.episodes === 'object') {
                const hasAnimeKinds = Object.values(seriesMarkers.episodes).some(
                    (e) => e && (e.kind === 'Filler' || e.kind === 'Mixed' || e.kind === 'MangaCanon' || e.kind === 'AnimeCanon' || e.recap)
                );
                if (hasAnimeKinds) {
                    return true;
                }
            }
        }

        // 2. Resolve series identifier with robust context fallbacks
        // Resolves SeriesId across direct properties, Series models, Season models, and passed series options
        const seriesId =
            item.SeriesId ||
            (item.Type === 'Series' ? item.Id : null) ||
            (item.Type === 'Season' ? item.SeriesId : null) ||
            options?.series?.SeriesId ||
            (options?.series?.Type === 'Series' ? options?.series?.Id : null);

        // Check cached series markers in memory for the resolved series ID
        if (seriesId) {
            const cached = this.getCachedSeriesMarkers(seriesId);
            if (cached) {
                // Verified database slug match confirms anime status
                if ((cached.matched === true && Boolean(cached.slug)) || cached.isAnime === true) {
                    return true;
                }
                // Check if cached markers include verified filler/mixed/recap content kinds
                if (cached.episodes && typeof cached.episodes === 'object') {
                    const hasAnimeKinds = Object.values(cached.episodes).some(
                        (e) => e && (e.kind === 'Filler' || e.kind === 'Mixed' || e.kind === 'MangaCanon' || e.kind === 'AnimeCanon' || e.recap)
                    );
                    if (hasAnimeKinds) {
                        return true;
                    }
                }
            }
        }

        // 3. Optional parent series object passed in context
        // Check parent series metadata (e.g. SeriesGenres, SeriesTags, Studio names)
        const seriesObj = options?.series;
        if (seriesObj && seriesObj !== item && this.isAnime(seriesObj, seriesMarkers)) {
            return true;
        }

        // 4. Provider IDs check
        // Check standard anime provider namespaces: AniList, AniDB, AniSearch, Kitsu, MyAnimeList
        const ANIME_PROVIDER_KEYS = new Set([
            'anilist',
            'anidb',
            'anisearch',
            'kitsu',
            'kitsuio',
            'myanimelist',
            'mal'
        ]);

        const hasAnimeProvider = (pIds) => {
            if (!pIds || typeof pIds !== 'object') return false;
            return Object.keys(pIds).some((key) => {
                const lower = key.toLowerCase();
                return ANIME_PROVIDER_KEYS.has(lower) && Boolean(pIds[key]);
            });
        };

        if (hasAnimeProvider(item.ProviderIds) || hasAnimeProvider(item.SeriesProviderIds)) {
            return true;
        }

        // 5. Genre descriptors check
        const checkAnimeGenre = (gList) => {
            if (!Array.isArray(gList)) return false;
            return gList.some((g) => {
                const name = typeof g === 'string' ? g : g?.Name || '';
                return /(\banime\b|japanese animation)/i.test(name);
            });
        };

        if (
            checkAnimeGenre(item.Genres) ||
            checkAnimeGenre(item.GenreItems) ||
            checkAnimeGenre(item.SeriesGenres)
        ) {
            return true;
        }

        // 6. Media Tags check
        const checkAnimeTag = (tList) => {
            if (!Array.isArray(tList)) return false;
            return tList.some((t) => {
                const name = typeof t === 'string' ? t : t?.Name || '';
                return /\banime\b/i.test(name);
            });
        };

        if (
            checkAnimeTag(item.Tags) ||
            checkAnimeTag(item.TagItems) ||
            checkAnimeTag(item.SeriesTags)
        ) {
            return true;
        }

        // 7. Filesystem path check (e.g. /Anime/ or \Anime\)
        if (item.Path && /[\\/](anime|animes)[\\/]/i.test(item.Path)) {
            return true;
        }

        // 8. Collection or library type check
        if (item.CollectionType === 'anime' || (item.LibraryName && /\banime\b/i.test(item.LibraryName))) {
            return true;
        }

        // 9. Japanese animation studios
        const ANIME_STUDIO_REGEX = /\b(toei animation|studio ghibli|ghibli|madhouse|bones|mappa|wit studio|kyoto animation|ufotable|cloverworks|a-1 pictures|sunrise|shaft|pierrot|production i\.?g\.?|david production|trigger|gainax|tms entertainment|j\.?c\.?staff|comix wave films|coMix wave)\b/i;
        const checkStudio = (sList) => {
            if (!Array.isArray(sList)) return false;
            return sList.some((s) => {
                const name = typeof s === 'string' ? s : s?.Name || '';
                return ANIME_STUDIO_REGEX.test(name);
            });
        };

        if (checkStudio(item.Studios) || checkStudio(item.StudioItems)) {
            return true;
        }

        // 10. Animation genre paired with Japanese audio or Japanese script in title
        const isAnimationGenre = (() => {
            const genres = item.Genres || item.GenreItems || [];
            return genres.some((g) => {
                const name = typeof g === 'string' ? g : g?.Name || '';
                return /\banimation\b/i.test(name);
            });
        })();

        if (isAnimationGenre) {
            // Check for Japanese audio stream
            const hasJapanese = AudioClassifier.hasJapaneseAudio(item);
            if (hasJapanese) {
                return true;
            }

            // Check for Japanese kanji/kana script in original title or title
            const hasJapaneseScript = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/.test(
                item.OriginalTitle || item.Name || ''
            );
            if (hasJapaneseScript) {
                return true;
            }
        }

        return false;
    }

    /**
     * Extracts an array of badge descriptor objects for a given episode.
     * Combines server content classification with native stream audio detection.
     *
     * Badge precedence:
     * 1. Content Type:
     *    - "Filler" (Anime filler content)
     *    - "Mixed Canon/Filler" (Episode contains both canon and anime padding)
     * 2. Recap:
     *    - "Recap" (Summary / recap episode)
     * 3. Audio:
     *    - "Subbed" (Japanese audio only)
     *    - "Dubbed" (Foreign audio only)
     *    - "Subbed/Dubbed" (Both Japanese and dub tracks present)
     *
     * @param {Object} episode - Jellyfin episode object
     * @param {Object} [seriesMarkers] - Optional preloaded series markers
     * @param {Object} [options] - Additional context options
     * @returns {Array<{ id: string, type: string, label: string }>} List of active pills
     */
    getEpisodePills(episode, seriesMarkers = null, options = {}) {
        if (!episode) return [];

        // --------------------------------------------------------------------
        // Resolve target series identifier with robust context fallbacks
        // --------------------------------------------------------------------
        // Guarantees series marker resolution even if individual episode models
        // lack a direct SeriesId attribute (e.g. nested season/details contexts)
        const seriesId =
            episode.SeriesId ||
            options?.series?.SeriesId ||
            (options?.series?.Type === 'Series' ? options?.series?.Id : null);

        // Check if series markers should be retrieved from memory cache if not provided
        if (!seriesMarkers && seriesId) {
            seriesMarkers = this.getCachedSeriesMarkers(seriesId);
        }

        // STRICT GUARD: Anime badges and audio classifications must only be shown for anime
        if (!this.isAnime(episode, seriesMarkers, options)) {
            return [];
        }

        const pills = [];
        const getLabel = (key, fallback) => {
            const translated = i18n.t(key);
            return translated && translated !== key ? translated : fallback;
        };

        // 1. Resolve content markers (Filler / Mixed / Recap)
        const marker = seriesMarkers ? this.getEpisodeMarker(seriesMarkers, episode.Id, episode) : null;

        if (marker) {
            // Check kind (Filler vs Mixed) supporting lowercase strings and numeric enum values
            const kindStr = String(marker.kind || '').toLowerCase();
            if (kindStr === 'filler' || marker.kind === 3) {
                pills.push({
                    id: 'filler',
                    type: 'filler',
                    label: getLabel('BadgeFiller', 'Filler')
                });
            } else if (kindStr === 'mixed' || marker.kind === 2) {
                pills.push({
                    id: 'mixed',
                    type: 'mixed',
                    label: getLabel('BadgeMixed', 'Mixed Canon/Filler')
                });
            }

            // Check recap flag supporting boolean and string variants
            if (marker.recap === true || marker.recap === 'true' || marker.recap === 1) {
                pills.push({
                    id: 'recap',
                    type: 'recap',
                    label: getLabel('BadgeRecap', 'Recap')
                });
            }
        }

        // 2. Resolve audio classification directly from stream metadata or episode marker
        let audioVerdict = AudioClassifier.classify(episode) || marker?.audio;

        // Fallback: If episode has no direct audio verdict, inherit from season verdict
        if (!audioVerdict && seriesMarkers?.seasons) {
            const seasonId = episode.SeasonId || (options?.season?.Id ? options.season.Id : null);
            if (seasonId) {
                const normSeasonId = this.normalizeId(seasonId);
                audioVerdict = seriesMarkers.seasons[normSeasonId] || null;
            }
            // If still unresolvable, check if seasons have a uniform audio verdict across the series
            if (!audioVerdict) {
                const seasonAudioValues = Object.values(seriesMarkers.seasons).filter(Boolean);
                if (seasonAudioValues.length > 0 && seasonAudioValues.every((v) => v === seasonAudioValues[0])) {
                    audioVerdict = seasonAudioValues[0];
                }
            }
        }

        if (audioVerdict === 'Subbed') {
            pills.push({
                id: 'subbed',
                type: 'subbed',
                label: getLabel('BadgeSubbed', 'Subbed')
            });
        } else if (audioVerdict === 'Dubbed') {
            pills.push({
                id: 'dubbed',
                type: 'dubbed',
                label: getLabel('BadgeDubbed', 'Dubbed')
            });
        } else if (audioVerdict === 'Subbed/Dubbed') {
            pills.push({
                id: 'dual',
                type: 'dual',
                label: getLabel('BadgeSubbedDubbed', 'Subbed/Dubbed')
            });
        }

        return pills;
    }

    /**
     * Generates a lightweight HTML string for the given pills.
     * Uses flat, clean styling with crisp borders, zero shadows, and zero backdrop blur.
     *
     * @param {Array<{ id: string, type: string, label: string }>} pills - List of badges
     * @param {Object} [options] - Optional layout flags
     * @param {string} [options.className=''] - Extra container class names
     * @param {boolean} [options.compact=false] - Whether to use compact padding
     * @returns {string} Rendered HTML string or empty string
     */
    renderPillsHtml(pills, options = {}) {
        if (!Array.isArray(pills) || pills.length === 0) {
            return '';
        }

        const compactClass = options.compact ? 'compact' : '';
        const customClass = options.className || '';
        const containerClasses = `anime-pills-row ${compactClass} ${customClass}`.trim();

        // Build individual badge pills
        const pillsHtml = pills
            .map((pill) => {
                const labelEscaped = escapeHtml(pill.label);
                return `<span class="anime-pill anime-pill-${pill.type}" data-pill-id="${pill.id}">${labelEscaped}</span>`;
            })
            .join('');

        return `<div class="${containerClasses}">${pillsHtml}</div>`;
    }
}

export const animeMarkerService = new AnimeMarkerService();
