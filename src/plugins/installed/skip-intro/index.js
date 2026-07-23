/**
 * ============================================================================
 * Litefin Plugin — Skip Intro & Outro
 * ============================================================================
 * Adds "Skip Intro" and "Skip Outro" overlay buttons to the player OSD,
 * or automatically seeks past segments depending on the user's per-segment
 * action preference.
 *
 * Server Dependency: intro-skipper (Jellyfin server plugin)
 *   https://github.com/intro-skipper/intro-skipper
 *
 * Per-segment behavior is controlled by four PlayerSettings keys:
 *   skipActionIntro   — 'None' | 'AskToSkip' | 'Skip'
 *   skipActionOutro   — 'None' | 'AskToSkip' | 'Skip'
 *   skipActionRecap   — 'None' | 'AskToSkip' | 'Skip'
 *   skipActionPreview — 'None' | 'AskToSkip' | 'Skip'
 *
 * Action semantics (mirrors jellyfin-web's MediaSegmentAction enum):
 *   None      — Ignore this segment type entirely. No button, no auto-seek.
 *   AskToSkip — Show an OSD button; user manually confirms the skip.
 *   Skip      — Automatically seek past the segment end with no UI shown.
 *
 * Design Notes:
 *   - This plugin only works for Episodes (not Movies).
 *   - Segment data is fetched once per episode via the intro-skipper API.
 *   - All 4 segment types (Intro, Outro, Recap, Preview) are supported.
 *   - Buttons integrate into the existing OSD overlay focus row (Row -1) via
 *     the PluginWidgetHost — no OSD changes are needed.
 * ============================================================================
 */
import './skip-intro.css';
import { i18n } from '../../../utils/i18n.js';
import { PlayerSettings } from '../../../utils/PlayerSettings.js';

// ============================================================================
// Constants
// ============================================================================

/** Jellyfin uses 10,000,000 ticks per second */
const TICKS_PER_SECOND = 10_000_000;

/**
 * Segment type keys — used to map segment types to their settings keys,
 * i18n label keys, and widget IDs in a DRY config-driven way.
 *
 * @type {Array<{type: string, settingKey: string, labelKey: string, widgetId: string, cssClass: string}>}
 */
const SEGMENT_TYPES = [
    {
        type: 'intro',
        settingKey: 'skipActionIntro',
        labelKey: 'SkipIntro',
        widgetId: 'skip-intro-btn',
        cssClass: 'skip-intro-widget'
    },
    {
        type: 'outro',
        settingKey: 'skipActionOutro',
        labelKey: 'SkipCredits',
        widgetId: 'skip-outro-btn',
        cssClass: 'skip-outro-widget'
    },
    {
        type: 'recap',
        settingKey: 'skipActionRecap',
        labelKey: 'SkipRecap',
        widgetId: 'skip-recap-btn',
        cssClass: 'skip-recap-widget'
    },
    {
        type: 'preview',
        settingKey: 'skipActionPreview',
        labelKey: 'SkipPreview',
        widgetId: 'skip-preview-btn',
        cssClass: 'skip-preview-widget'
    }
];

// ============================================================================
// Skip Intro Plugin
// ============================================================================

/**
 * @type {Object} LitefinPlugin
 */
const skipIntroPlugin = {
    // === Required metadata ===
    id: 'skip-intro',
    name: 'Skip Intro & Outro',
    version: '3.0.0',

    // No strict serverDependency defined here so the PluginManager does not disable us.
    // Instead, we check intro-skipper availability dynamically at playback and fall back
    // to video chapter markers if it is missing or disabled.

    // ---- Private state ----

    /**
     * Per-episode segment cache so we only hit the server once per item.
     * Map<itemId, { intro, outro, recap, preview }>
     * Each value is { start: number, end: number } in ticks, or null.
     * @private
     */
    _cache: new Map(),

    /**
     * Loaded segments for the current item — values are arrays containing
     * { start, end } bounds in ticks.
     * @private
     */
    _introSegment: [],
    _outroSegment: [],
    _recapSegment: [],
    _previewSegment: [],

    /**
     * Segments that should be *auto-skipped* (action === 'Skip').
     * Map<type, Array<{ start, end }>> — only populated segments land here.
     * @private
     */
    _autoSkipSegments: {},

    /**
     * Tracks the type and index of the last segment we auto-skipped so we don't
     * re-trigger the seek on every subsequent timeupdate tick.
     * Format: 'type-index'
     * @private
     */
    _lastAutoSkipped: null,

    /** Saved PluginAPI reference (set in init) @private */
    _api: null,

    // ========================================================================
    // Plugin Lifecycle
    // ========================================================================

    /**
     * Called once when the plugin is loaded.
     * @param {import('../../PluginAPI.js').default} api
     */
    init(api) {
        this._api = api;
        this._cache.clear();
        api.log.info('Skip Intro plugin initialized (v2: respects segment action settings)');
    },

    /**
     * Called when playback starts for a new media item.
     * Reads per-segment action settings, fetches segment data, and then
     * builds OSD widgets for 'AskToSkip' types or registers auto-skips
     * for 'Skip' types. 'None' segments are completely ignored.
     *
     * @param {Object} item - Jellyfin media item
     * @param {import('../../PluginAPI.js').default} api
     */
    async onPlayerStart(item, api) {
        // ----------------------------------------------------------------
        // Reset all state from any previous episode to empty arrays
        // ----------------------------------------------------------------
        this._introSegment = [];
        this._outroSegment = [];
        this._recapSegment = [];
        this._previewSegment = [];
        this._autoSkipSegments = {};
        this._lastAutoSkipped = null;

        // Skip Intro only makes sense for episodes
        if (item.Type !== 'Episode') {
            api.log.debug(`Skip Intro: item type is '${item.Type}', skipping segment fetch`);
            return;
        }

        // ----------------------------------------------------------------
        // Read user-configured action for each segment type from settings.
        // This is intentionally done on every onPlayerStart so that changes
        // made in Settings mid-session are picked up on the next episode.
        // ----------------------------------------------------------------
        const actions = {};
        for (const seg of SEGMENT_TYPES) {
            actions[seg.type] = PlayerSettings.get(seg.settingKey) || 'None';
        }

        // Early-exit if absolutely everything is disabled
        const allNone = Object.values(actions).every((a) => a === 'None');
        if (allNone) {
            api.log.info('Skip Intro: all segment actions are set to None — nothing to do');
            return;
        }

        // ----------------------------------------------------------------
        // Fetch segment data for this episode (with per-item caching)
        // ----------------------------------------------------------------
        await this._loadSegments(item, api);

        // ----------------------------------------------------------------
        // Convenience reference map for the 4 raw segments by type string
        // ----------------------------------------------------------------
        const segments = {
            intro: this._introSegment,
            outro: this._outroSegment,
            recap: this._recapSegment,
            preview: this._previewSegment
        };

        // ----------------------------------------------------------------
        // For each segment type, apply its configured action.
        // Since there can be multiple segments of the same type (e.g. both
        // an intro chapter and an opening theme song chapter), we handle
        // segments as an array.
        // ----------------------------------------------------------------
        for (const seg of SEGMENT_TYPES) {
            const action = actions[seg.type];
            const segmentList = segments[seg.type] || [];

            // Skip if no matching segments exist
            if (segmentList.length === 0) continue;

            if (action === 'AskToSkip') {
                // Register an independent OSD widget for each individual segment
                segmentList.forEach((segment, idx) => {
                    const segDef = {
                        ...seg,
                        widgetId: `${seg.widgetId}-${idx}`
                    };
                    api.addOSDWidget(this._buildWidget(segDef, segment, api));
                });
                api.log.debug(`Skip Intro: [${seg.type}] registered ${segmentList.length} AskToSkip widgets`);
            } else if (action === 'Skip') {
                // Store all segments of this type for automatic seek bypasses
                this._autoSkipSegments[seg.type] = segmentList;
                api.log.debug(`Skip Intro: [${seg.type}] registered ${segmentList.length} Auto-Skips`);
            } else {
                // Action is 'None' — ignore entirely
                api.log.debug(`Skip Intro: [${seg.type}] action is None — ignored`);
            }
        }
    },

    /**
     * Called on each time update tick by the PluginManager.
     * Handles auto-skip logic: when the current playback position enters
     * any segment whose action is 'Skip', seek past its end immediately.
     *
     * @param {number} positionTicks  - Current playback position in ticks
     * @param {number} durationTicks  - Total duration in ticks
     * @param {import('../../PluginAPI.js').default} api
     */
    onTimeUpdate(positionTicks, durationTicks, api) {
        // Safe exit if no auto-skips registered
        if (Object.keys(this._autoSkipSegments).length === 0) return;

        for (const [type, segmentList] of Object.entries(this._autoSkipSegments)) {
            let matchedSegment = null;
            let matchedIndex = -1;

            // Check if player is currently in any of the segments for this type
            segmentList.forEach((segment, idx) => {
                if (positionTicks >= segment.start && positionTicks < segment.end) {
                    matchedSegment = segment;
                    matchedIndex = idx;
                }
            });

            if (!matchedSegment) continue;

            // Unique guard identifier for the specific matched segment
            const guardKey = `${type}-${matchedIndex}`;
            if (this._lastAutoSkipped === guardKey) continue;

            this._lastAutoSkipped = guardKey;

            const player = api.getPlayer();
            if (!player) {
                api.log.warn(`Skip Intro: auto-skip for [${type}-${matchedIndex}] failed — no player`);
                continue;
            }

            const durationTicks = player.getDurationTicks ? player.getDurationTicks() : 0;
            const seekTarget = matchedSegment.end + TICKS_PER_SECOND;

            // Handle clean completion if seeking past video boundary
            if (durationTicks > 0 && seekTarget >= durationTicks) {
                api.log.info(
                    `Skip Intro: auto-skip target [${type}-${matchedIndex}] at ${seekTarget / TICKS_PER_SECOND}s is at or past duration ${durationTicks / TICKS_PER_SECOND}s. Triggering ended event.`
                );
                player.emit('ended');
            } else {
                api.log.info(`Skip Intro: auto-skipping [${type}-${matchedIndex}] → ${seekTarget / TICKS_PER_SECOND}s`);
                player.seek(seekTarget);
            }

            break;
        }

        // Reset the auto-skipped guard when the player transitions past the active segment
        if (this._lastAutoSkipped !== null) {
            const [type, idxStr] = this._lastAutoSkipped.split('-');
            const idx = parseInt(idxStr, 10);
            const skippedSeg = this._autoSkipSegments[type]?.[idx];
            if (skippedSeg && positionTicks >= skippedSeg.end) {
                this._lastAutoSkipped = null;
            }
        }
    },

    /**
     * Called when playback stops or the player is destroyed.
     * PluginAPI._destroy() handles widget removal — nothing extra needed here.
     * @param {import('../../PluginAPI.js').default} api
     */
    onPlayerStop(api) {
        api.log.debug('Skip Intro: playback stopped');
    },

    /**
     * Clean up plugin resources.
     * Called by PluginManager.destroy() when the app shuts down.
     * @param {import('../../PluginAPI.js').default} api
     */
    destroy(api) {
        this._cache.clear();
        this._introSegment = [];
        this._outroSegment = [];
        this._recapSegment = [];
        this._previewSegment = [];
        this._autoSkipSegments = {};
        this._lastAutoSkipped = null;
    },

    // ========================================================================
    // Internal Logic
    // ========================================================================

    /**
     * Fetch and cache intro/outro/recap/preview segment timestamps for an
     * episode. Uses the intro-skipper v1 API endpoint.
     *
     * Endpoint:  GET /Episode/{id}/Timestamps
     * Response:  { Introduction, Credits, Recap, Preview }
     *            where each field has { Start, End } in SECONDS (doubles).
     *            A segment with End === 0 is "empty" (not detected).
     *
     * @param {string} itemId - Jellyfin episode item ID
     * @param {import('../../PluginAPI.js').default} api
     * @private
     */
    /**
     * Fetch and cache segment timestamps.
     * Checks if the intro-skipper plugin is available on the server:
     * - If available: Fetches from the /Episode/{id}/Timestamps endpoint.
     * - If unavailable: Falls back to parsing chapter markers on the item.
     *
     * @param {Object} item - Jellyfin episode item object
     * @param {import('../../PluginAPI.js').default} api
     * @private
     */
    async _loadSegments(item, api) {
        const itemId = item.Id;

        // --------------------------------------------------------------------
        // Cache Check: Avoid hit to network if already loaded for this item.
        // --------------------------------------------------------------------
        if (this._cache.has(itemId)) {
            const cached = this._cache.get(itemId);
            this._introSegment = cached.intro;
            this._outroSegment = cached.outro;
            this._recapSegment = cached.recap;
            this._previewSegment = cached.preview;
            api.log.debug(`Skip Intro: segments for ${itemId} loaded from cache`);
            return;
        }

        const sourcePref = PlayerSettings.get('skipSegmentSource') || 'both';

        // Initialize state arrays for this load run
        this._introSegment = [];
        this._outroSegment = [];
        this._recapSegment = [];
        this._previewSegment = [];

        // --------------------------------------------------------------------
        // Check Plugin Presence dynamically and fetch server timestamps
        // --------------------------------------------------------------------
        if (sourcePref !== 'chapters') {
            let introSkipperAvailable = false;
            try {
                api.log.debug(`Skip Intro: probing intro-skipper plugin availability`);
                const check = await api.serverPlugins.isPluginAvailable('intro-skipper', item);
                introSkipperAvailable = !!check.available;
            } catch (err) {
                api.log.warn(`Skip Intro: failed to probe intro-skipper availability:`, err.message);
            }

            if (introSkipperAvailable) {
                try {
                    api.log.info(`Skip Intro: fetching timestamps from intro-skipper for item ${itemId}`);
                    const data = await api.serverPlugins.call(`/Episode/${itemId}/Timestamps`);

                    // Helper to safely transform raw values into ticks as an array
                    const toSegment = (raw) => {
                        if (!raw || !(raw.End > 0)) return [];
                        return [{
                            start: raw.Start * TICKS_PER_SECOND,
                            end: raw.End * TICKS_PER_SECOND
                        }];
                    };

                    this._introSegment = toSegment(data?.Introduction);
                    this._outroSegment = toSegment(data?.Credits);
                    this._recapSegment = toSegment(data?.Recap);
                    this._previewSegment = toSegment(data?.Preview);

                    api.log.info(
                        `Skip Intro: loaded timestamps from server —`,
                        `intro=${this._introSegment.length > 0 ? 'yes' : 'no'}`,
                        `outro=${this._outroSegment.length > 0 ? 'yes' : 'no'}`,
                        `recap=${this._recapSegment.length > 0 ? 'yes' : 'no'}`,
                        `preview=${this._previewSegment.length > 0 ? 'yes' : 'no'}`
                    );
                } catch (err) {
                    if (err.status === 404) {
                        api.log.debug(`Skip Intro: no intro-skipper timestamps found for ${itemId}`);
                    } else {
                        api.log.warn(`Skip Intro: intro-skipper API call failed:`, err.message);
                    }
                }
            }
        }

        // --------------------------------------------------------------------
        // Retrieve chapters and merge/set results if enabled
        // --------------------------------------------------------------------
        if (sourcePref !== 'server') {
            let chapters = item.Chapters;
            if (!chapters) {
                try {
                    api.log.debug(`Skip Intro: fetching full item to retrieve chapters list`);
                    const fullItem = await api.getItem(itemId, { Fields: 'Chapters,RunTimeTicks' });
                    chapters = fullItem?.Chapters || [];
                    item.Chapters = chapters;
                    if (fullItem?.RunTimeTicks) {
                        item.RunTimeTicks = fullItem.RunTimeTicks;
                    }
                } catch (err) {
                    api.log.warn(`Skip Intro: failed to retrieve item chapters:`, err.message);
                    chapters = [];
                }
            }

            if (chapters && chapters.length > 0) {
                // Sort chapters by start position for reliable sequential boundaries
                const sortedChapters = [...chapters].sort((a, b) => a.StartPositionTicks - b.StartPositionTicks);

                const chapterIntros = [];
                const chapterOutros = [];
                const chapterRecaps = [];

                sortedChapters.forEach((c, idx) => {
                    const start = c.StartPositionTicks;
                    let end;
                    if (idx + 1 < sortedChapters.length) {
                        end = sortedChapters[idx + 1].StartPositionTicks;
                    } else {
                        end = start + (120 * TICKS_PER_SECOND);
                    }

                    // Check intro keywords
                    const isIntro = c.MarkerType === 'IntroStart' || (c.Name && (
                        c.Name.toLowerCase().includes('intro') ||
                        c.Name.toLowerCase().includes('opening') ||
                        /\bop\b/i.test(c.Name)
                    ));

                    // Check outro keywords
                    const isCredits = c.MarkerType === 'Credits' || (c.Name && (
                        c.Name.toLowerCase().includes('credit') ||
                        c.Name.toLowerCase().includes('ending') ||
                        /\bed\b/i.test(c.Name)
                    ));

                    // Check recap keywords
                    const isRecap = c.Name && c.Name.toLowerCase().includes('recap');

                    if (isIntro) {
                        const durationTicks = end - start;
                        const durationMinutes = durationTicks / (60 * TICKS_PER_SECOND);
                        if (durationMinutes >= 3) {
                            api.log.info(
                                `Skip Intro: skipped mapping intro chapter [${c.Name || c.MarkerType}] ` +
                                `due to long duration: ${durationMinutes.toFixed(1)} minutes (>= 3m)`
                            );
                        } else {
                            chapterIntros.push({ start, end });
                        }
                    } else if (isCredits) {
                        const creditsEnd = item.RunTimeTicks || (start + (300 * TICKS_PER_SECOND));
                        chapterOutros.push({ start, end: creditsEnd });
                    } else if (isRecap) {
                        const recapEnd = idx + 1 < sortedChapters.length ? sortedChapters[idx + 1].StartPositionTicks : (start + (60 * TICKS_PER_SECOND));
                        chapterRecaps.push({ start, end: recapEnd });
                    }
                });

                if (sourcePref === 'both') {
                    // Local helper to merge segments without duplicates or overlaps
                    const mergeSegments = (serverSegs, chapterSegs) => {
                        const merged = [...serverSegs];
                        chapterSegs.forEach(c => {
                            const overlaps = merged.some(s => {
                                const timeOverlap = Math.max(c.start, s.start) < Math.min(c.end, s.end);
                                const closeStart = Math.abs(c.start - s.start) < 5 * TICKS_PER_SECOND;
                                return timeOverlap || closeStart;
                            });
                            if (!overlaps) {
                                merged.push(c);
                            }
                        });
                        return merged.sort((a, b) => a.start - b.start);
                    };

                    this._introSegment = mergeSegments(this._introSegment, chapterIntros);
                    this._outroSegment = mergeSegments(this._outroSegment, chapterOutros);
                    this._recapSegment = mergeSegments(this._recapSegment, chapterRecaps);
                } else if (sourcePref === 'chapters') {
                    this._introSegment = chapterIntros;
                    this._outroSegment = chapterOutros;
                    this._recapSegment = chapterRecaps;
                }
            } else {
                api.log.debug(`Skip Intro: no chapters found for item ${itemId}`);
            }
        }

        // Cache whatever results we gathered (even if null) to prevent redundant queries
        this._cache.set(itemId, {
            intro: this._introSegment,
            outro: this._outroSegment,
            recap: this._recapSegment,
            preview: this._previewSegment
        });
    },

    /**
     * Build an OSD widget descriptor for an 'AskToSkip' segment.
     * The widget is rendered as an on-screen button in the OSD overlay row.
     * PluginWidgetHost manages its visibility via shouldShow().
     *
     * @param {{ type: string, labelKey: string, widgetId: string, cssClass: string }} segDef
     *   - The SEGMENT_TYPES entry for this segment
     * @param {{ start: number, end: number }} segment
     *   - Segment bounds in ticks
     * @param {import('../../PluginAPI.js').default} api
     * @returns {Object} Widget descriptor for PluginWidgetHost
     * @private
     */
    _buildWidget(segDef, segment, api) {
        const { type, labelKey, widgetId, cssClass } = segDef;
        const label = i18n.t(labelKey);

        return {
            id: widgetId,

            /**
             * Render the widget's root element.
             * Follows the same .osd-btn pattern as other OSD buttons so that
             * the existing focus CSS (:focus, .focused) kicks in automatically.
             * @returns {HTMLElement}
             */
            render() {
                const container = document.createElement('div');
                container.className = `plugin-widget ${cssClass}`;
                container.innerHTML = `
                    <button
                        class="skip-intro-btn"
                        tabindex="0"
                        aria-label="${label}"
                    >
                        <span class="skip-intro-label">${label}</span>
                        <span class="skip-intro-arrow">▶</span>
                    </button>
                `;
                return container;
            },

            /**
             * PluginWidgetHost evaluates this every ~500ms to decide whether
             * to show or hide the widget element.
             *
             * @param {number} positionTicks - Current position in ticks
             * @returns {boolean}
             */
            shouldShow(positionTicks) {
                return positionTicks >= segment.start && positionTicks < segment.end;
            },

            /**
             * Called when the user presses Enter on this widget's button.
             * Seeks to 1 second past the segment end for a clean cutover.
             *
             * @param {import('../../PluginAPI.js').default} pluginApi
             */
            onSelect(pluginApi) {
                // ------------------------------------------------------------
                // Retrieve player instance to execute the seek or playback end.
                // ------------------------------------------------------------
                const player = pluginApi.getPlayer();
                if (!player) {
                    pluginApi.log.warn(`Skip Intro: onSelect for [${type}] — player is null`);
                    return;
                }

                // ------------------------------------------------------------
                // Calculate the target seek location with a 1-second safety buffer
                // past the segment boundary. Also fetch total video duration ticks.
                // ------------------------------------------------------------
                const seekTarget = segment.end + TICKS_PER_SECOND;
                const durationTicks = player.getDurationTicks ? player.getDurationTicks() : 0;

                // ------------------------------------------------------------
                // Guard: If our seek target exceeds the media duration (e.g. Skip Outro
                // at the very end of an episode), seeking on AVPlay gets stuck/fails.
                // We bypass seek and trigger the 'ended' flow directly.
                // ------------------------------------------------------------
                if (durationTicks > 0 && seekTarget >= durationTicks) {
                    pluginApi.log.info(
                        `Skip ${type}: target ${seekTarget / TICKS_PER_SECOND}s is past duration ${durationTicks / TICKS_PER_SECOND}s. Ending playback.`
                    );
                    player.emit('ended');
                } else {
                    pluginApi.log.info(`Skip ${type}: seeking to ${seekTarget / TICKS_PER_SECOND}s`);
                    player.seek(seekTarget);
                }

                /*
                 * ====================================================================
                 * SNAP FOCUS AWAY:
                 * We blur the active element immediately to clear native focus
                 * from the button. This prevents the button from rendering
                 * in a focused/hovered state while it transitions out.
                 * Using el.contains() is generic and works perfectly for all
                 * segment widget variations (intro, outro, recap, etc.).
                 * ====================================================================
                 */
                if (document.activeElement && document.activeElement.closest('.skip-intro-btn')) {
                    document.activeElement.blur();
                }
            }
        };
    }
};

export default skipIntroPlugin;
