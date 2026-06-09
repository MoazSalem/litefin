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
    version: '2.0.0',

    // Require the intro-skipper server plugin — PluginManager checks this
    // before calling init() and will disable us with a toast if not found
    serverDependency: 'intro-skipper',

    // ---- Private state ----

    /**
     * Per-episode segment cache so we only hit the server once per item.
     * Map<itemId, { intro, outro, recap, preview }>
     * Each value is { start: number, end: number } in ticks, or null.
     * @private
     */
    _cache: new Map(),

    /**
     * Loaded segments for the current item — values are null if segment
     * was not returned by the server OR if the setting is 'None'.
     * @private
     */
    _introSegment: null,
    _outroSegment: null,
    _recapSegment: null,
    _previewSegment: null,

    /**
     * Segments that should be *auto-skipped* (action === 'Skip').
     * Map<type, { start, end }> — only populated segments land here.
     * @private
     */
    _autoSkipSegments: {},

    /**
     * Tracks the type of the last segment we auto-skipped so we don't
     * re-trigger the seek on every subsequent timeupdate tick until the
     * player has moved past the segment.
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
        // Reset all state from any previous episode
        // ----------------------------------------------------------------
        this._introSegment = null;
        this._outroSegment = null;
        this._recapSegment = null;
        this._previewSegment = null;
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
        await this._loadSegments(item.Id, api);

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
        // For each segment type, apply its configured action
        // ----------------------------------------------------------------
        for (const seg of SEGMENT_TYPES) {
            const action = actions[seg.type];
            const segment = segments[seg.type];

            // No segment data from the server — nothing to do regardless
            if (!segment) continue;

            if (action === 'AskToSkip') {
                // Show the skip button in the OSD overlay row (existing behavior)
                api.addOSDWidget(this._buildWidget(seg, segment, api));
                api.log.debug(`Skip Intro: [${seg.type}] AskToSkip widget registered`);
            } else if (action === 'Skip') {
                // Store for auto-seek; no widget is added to the OSD
                this._autoSkipSegments[seg.type] = segment;
                api.log.debug(
                    `Skip Intro: [${seg.type}] Auto-Skip registered (${segment.start / TICKS_PER_SECOND}s – ${segment.end / TICKS_PER_SECOND}s)`
                );
            } else {
                // action === 'None' — completely ignore this segment
                api.log.debug(`Skip Intro: [${seg.type}] action is None — ignored`);
            }
        }
    },

    /**
     * Called on each time update tick by the PluginManager.
     * Handles auto-skip logic: when the current playback position enters
     * a segment whose action is 'Skip', seek past its end immediately.
     *
     * Widget visibility (AskToSkip) is managed automatically by
     * PluginWidgetHost via each widget's shouldShow() — no extra work needed.
     *
     * @param {number} positionTicks  - Current playback position in ticks
     * @param {number} durationTicks  - Total duration in ticks
     * @param {import('../../PluginAPI.js').default} api
     */
    onTimeUpdate(positionTicks, durationTicks, api) {
        // Nothing to auto-skip — short-circuit for performance
        if (Object.keys(this._autoSkipSegments).length === 0) return;

        for (const [type, segment] of Object.entries(this._autoSkipSegments)) {
            // Is the player currently inside this segment?
            const inSegment = positionTicks >= segment.start && positionTicks < segment.end;
            if (!inSegment) continue;

            // Avoid re-triggering until the player has moved past the segment
            // (the seek fires this callback again momentarily, so the guard
            // prevents an infinite loop / double-seek on the same segment)
            if (this._lastAutoSkipped === type) continue;

            // Mark before seeking so the next tick from the async seek
            // doesn't trigger it again
            this._lastAutoSkipped = type;

            const player = api.getPlayer();
            if (!player) {
                api.log.warn(`Skip Intro: auto-skip for [${type}] failed — no player`);
                continue;
            }

            // ----------------------------------------------------------------
            // Determine total video duration to avoid seeking past the file boundaries.
            // On hardware players like Tizen's AVPlay, seeking to or beyond the
            // media's actual duration results in an invalid operation that freezes
            // the video decoder rather than completing naturally.
            // ----------------------------------------------------------------
            const durationTicks = player.getDurationTicks ? player.getDurationTicks() : 0;

            // Seek 1 second past segment end for a clean boundary
            const seekTarget = segment.end + TICKS_PER_SECOND;

            // ----------------------------------------------------------------
            // If the seek target reaches or exceeds the absolute duration of the video,
            // we bypass the native seek pipeline entirely and emit the 'ended' event.
            // This triggers the player page to halt playback and clean up properly.
            // ----------------------------------------------------------------
            if (durationTicks > 0 && seekTarget >= durationTicks) {
                api.log.info(
                    `Skip Intro: auto-skip target [${type}] at ${seekTarget / TICKS_PER_SECOND}s is at or past duration ${durationTicks / TICKS_PER_SECOND}s. Triggering ended event.`
                );
                player.emit('ended');
            } else {
                api.log.info(`Skip Intro: auto-skipping [${type}] → ${seekTarget / TICKS_PER_SECOND}s`);
                player.seek(seekTarget);
            }

            // Only handle one auto-skip per tick
            break;
        }

        // Reset the auto-skipped guard once the player has moved past ALL
        // auto-skip segments so the same segment can fire again if the user
        // seeks back into it manually.
        if (this._lastAutoSkipped !== null) {
            const skippedSeg = this._autoSkipSegments[this._lastAutoSkipped];
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
        this._introSegment = null;
        this._outroSegment = null;
        this._recapSegment = null;
        this._previewSegment = null;
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
    async _loadSegments(itemId, api) {
        // Return from cache if already fetched for this episode
        if (this._cache.has(itemId)) {
            const cached = this._cache.get(itemId);
            this._introSegment = cached.intro;
            this._outroSegment = cached.outro;
            this._recapSegment = cached.recap;
            this._previewSegment = cached.preview;
            api.log.debug(`Skip Intro: segments for ${itemId} loaded from cache`);
            return;
        }

        try {
            const data = await api.serverPlugins.call(`/Episode/${itemId}/Timestamps`);

            // Helper: coerce a raw segment object to { start, end } in ticks,
            // returning null when the server has no data (End === 0 or missing).
            const toSegment = (raw) => {
                if (!raw || !(raw.End > 0)) return null;
                return {
                    start: raw.Start * TICKS_PER_SECOND,
                    end: raw.End * TICKS_PER_SECOND
                };
            };

            this._introSegment = toSegment(data?.Introduction);
            this._outroSegment = toSegment(data?.Credits);
            this._recapSegment = toSegment(data?.Recap);
            this._previewSegment = toSegment(data?.Preview);

            // Cache the raw results — we'll apply action filtering in onPlayerStart
            this._cache.set(itemId, {
                intro: this._introSegment,
                outro: this._outroSegment,
                recap: this._recapSegment,
                preview: this._previewSegment
            });

            api.log.info(
                `Skip Intro: fetched segments for ${itemId} —`,
                `intro=${this._introSegment ? 'yes' : 'no'}`,
                `outro=${this._outroSegment ? 'yes' : 'no'}`,
                `recap=${this._recapSegment ? 'yes' : 'no'}`,
                `preview=${this._previewSegment ? 'yes' : 'no'}`
            );
        } catch (err) {
            // 404 = intro-skipper has no data for this episode
            if (err.status === 404) {
                api.log.debug(`Skip Intro: no segments for episode ${itemId}`);
            } else {
                api.log.warn(`Skip Intro: failed to fetch segments for ${itemId}:`, err.message);
            }

            // Cache a null-result to avoid hammering the server on every tick
            this._cache.set(itemId, { intro: null, outro: null, recap: null, preview: null });
            this._introSegment = null;
            this._outroSegment = null;
            this._recapSegment = null;
            this._previewSegment = null;
        }
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
                        class="osd-btn skip-intro-btn"
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
