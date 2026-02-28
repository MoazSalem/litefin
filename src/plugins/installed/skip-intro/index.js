/**
 * ============================================================================
 * Litefin Plugin — Skip Intro & Outro
 * ============================================================================
 * Adds "Skip Intro" and "Skip Outro" overlay buttons to the player OSD.
 * Buttons appear automatically when the playback position falls within a
 * segment identified by the intro-skipper server plugin.
 *
 * Server Dependency: intro-skipper (Jellyfin server plugin)
 *   https://github.com/intro-skipper/intro-skipper
 *
 * Design Notes:
 *   - This plugin only works for Episodes (not Movies).
 *   - Segment data is fetched once per episode via the intro-skipper API.
 *   - Buttons are styled to match the existing OSD overlay style (see skip-intro.css).
 *   - Buttons integrate into the existing OSD overlay focus row (Row -1) via
 *     the PluginWidgetHost — no OSD changes are needed.
 * ============================================================================
 */
import './skip-intro.css';
import { i18n } from '../../../utils/i18n.js';

// ============================================================================
// Constants
// ============================================================================

// Ticks per second (Jellyfin uses 10,000,000 ticks per second)
const TICKS_PER_SECOND = 10_000_000;

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
    version: '1.0.0',

    // Require the intro-skipper server plugin — PluginManager checks this
    // before calling init() and will disable us with a toast if not found
    serverDependency: 'intro-skipper',

    // ---- Private state ----

    // Map<itemId, { intro: Segment|null, outro: Segment|null }>
    // Cached per-episode so we only hit the server once per item
    _cache: new Map(),

    // Currently loaded segments for the active item
    _introSegment: null,
    _outroSegment: null,
    _recapSegment: null,
    _previewSegment: null,

    // Saved PluginAPI reference (set in init)
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
        api.log.info('Skip Intro plugin initialized');
    },

    /**
     * Called when playback starts for a new media item.
     * We only operate on Episodes — fetch segment data for this episode.
     * @param {Object} item - Jellyfin media item
     * @param {import('../../PluginAPI.js').default} api
     */
    async onPlayerStart(item, api) {
        // Reset segments from any previous episode
        this._introSegment = null;
        this._outroSegment = null;

        // Skip Intro only makes sense for episodes
        if (item.Type !== 'Episode') {
            api.log.debug(`Skip Intro: item type is '${item.Type}', skipping segment fetch`);
            return;
        }

        // Try to load segment data for this episode (with caching)
        await this._loadSegments(item.Id, api);

        // Register our OSD widgets — PluginWidgetHost will handle visibility
        if (this._introSegment) {
            api.addOSDWidget(this._buildWidget('intro', this._introSegment, api));
        }
        if (this._outroSegment) {
            api.addOSDWidget(this._buildWidget('outro', this._outroSegment, api));
        }
        if (this._recapSegment) {
            api.addOSDWidget(this._buildWidget('recap', this._recapSegment, api));
        }
        if (this._previewSegment) {
            api.addOSDWidget(this._buildWidget('preview', this._previewSegment, api));
        }
    },

    /**
     * Called on each time update tick.
     * Widget visibility is handled automatically by PluginWidgetHost via
     * shouldShow() — we don't need manual show/hide here.
     * This hook is available if we need extra time-based logic.
     */
    onTimeUpdate(positionTicks, durationTicks, api) {
        // No additional time-based logic needed.
        // PluginWidgetHost evaluates shouldShow() on each widget automatically.
    },

    /**
     * Called when playback stops or the player is destroyed.
     * PluginAPI._destroy() handles widget removal — nothing extra needed here.
     */
    onPlayerStop(api) {
        // PluginAPI handles removing OSD widgets on stop
        api.log.debug('Skip Intro: playback stopped');
    },

    /**
     * Clean up plugin resources.
     * Called by PluginManager.destroy() when the app shuts down.
     */
    destroy(api) {
        this._cache.clear();
        this._introSegment = null;
        this._outroSegment = null;
        this._recapSegment = null;
        this._previewSegment = null;
    },

    // ========================================================================
    // Internal Logic
    // ========================================================================

    /**
     * Fetch and cache intro/outro segment timestamps for an episode.
     * Uses the intro-skipper v1 API endpoint.
     *
     * @param {string} itemId - Jellyfin episode item ID
     * @param {import('../../PluginAPI.js').default} api
     * @private
     */
    async _loadSegments(itemId, api) {
        // Return from cache if we already fetched this episode
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
            // Correct endpoint: GET /Episode/{id}/Timestamps
            // Returns: { Introduction: {Start, End}, Credits: {Start, End}, ... }
            // Start/End are in SECONDS (doubles), not ticks.
            // A segment with End=0 is "empty" (intro-skipper's Segment.Valid = End > 0).
            const data = await api.serverPlugins.call(`/Episode/${itemId}/Timestamps`);

            // Parse intro segment — only valid if End > 0
            const intro = data?.Introduction;
            this._introSegment =
                intro?.End > 0 ? { start: intro.Start * TICKS_PER_SECOND, end: intro.End * TICKS_PER_SECOND } : null;

            // Parse credits/outro segment — only valid if End > 0
            const credits = data?.Credits;
            this._outroSegment =
                credits?.End > 0
                    ? { start: credits.Start * TICKS_PER_SECOND, end: credits.End * TICKS_PER_SECOND }
                    : null;

            // Parse recap segment -- only valid if End > 0
            const recap = data?.Recap;
            this._recapSegment =
                recap?.End > 0 ? { start: recap.Start * TICKS_PER_SECOND, end: recap.End * TICKS_PER_SECOND } : null;

            // Parse preview segment -- only valid if End > 0
            const preview = data?.Preview;
            this._previewSegment =
                preview?.End > 0
                    ? { start: preview.Start * TICKS_PER_SECOND, end: preview.End * TICKS_PER_SECOND }
                    : null;

            // Cache result for this item
            this._cache.set(itemId, {
                intro: this._introSegment,
                outro: this._outroSegment,
                recap: this._recapSegment,
                preview: this._previewSegment
            });

            api.log.info(
                `Skip Intro: fetched segments for ${itemId}`,
                `intro=${this._introSegment ? 'yes' : 'no'}`,
                `outro=${this._outroSegment ? 'yes' : 'no'}`,
                `recap=${this._recapSegment ? 'yes' : 'no'}`,
                `preview=${this._previewSegment ? 'yes' : 'no'}`
            );
        } catch (err) {
            // 404 = intro-skipper has no data for this episode (not all episodes have intros)
            if (err.status === 404) {
                api.log.debug(`Skip Intro: no segments for episode ${itemId}`);
            } else {
                api.log.warn(`Skip Intro: failed to fetch segments for ${itemId}:`, err.message);
            }
            // Cache null result to avoid re-fetching for the same episode on timeupdate
            this._cache.set(itemId, { intro: null, outro: null, recap: null, preview: null });
            this._introSegment = null;
            this._outroSegment = null;
            this._recapSegment = null;
            this._previewSegment = null;
        }
    },

    /**
     * Build an OSD widget descriptor for a given segment.
     *
     * @param {'intro'|'outro'} type - Segment type
     * @param {{ start: number, end: number }} segment - Segment bounds in ticks
     * @param {import('../../PluginAPI.js').default} api - Plugin API
     * @returns {Object} Widget descriptor for PluginWidgetHost
     * @private
     */
    _buildWidget(type, segment, api) {
        let labelKey = 'SkipIntro';
        let widgetId = 'skip-intro-btn';
        let cssClass = 'skip-intro-widget';

        if (type === 'outro') {
            labelKey = 'SkipCredits';
            widgetId = 'skip-outro-btn';
            cssClass = 'skip-outro-widget';
        } else if (type === 'recap') {
            labelKey = 'SkipRecap';
            widgetId = 'skip-recap-btn';
            cssClass = 'skip-recap-widget';
        } else if (type === 'preview') {
            labelKey = 'SkipPreview';
            widgetId = 'skip-preview-btn';
            cssClass = 'skip-preview-widget';
        }

        // Button labels — keeping it simple and familiar to Jellyfin users
        const label = i18n.t(labelKey);

        return {
            id: widgetId,

            /**
             * Render the widget's root element.
             * Styled to match the OSD's existing overlay buttons.
             * @returns {HTMLElement}
             */
            render() {
                const container = document.createElement('div');
                container.className = `plugin-widget ${cssClass}`;

                // The button is what gets focused by the OSD overlay row (Row -1).
                // It follows the same .osd-btn pattern as other OSD buttons
                // so the existing focus CSS (:focus, .focused) kicks in automatically.
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
             * Determine if this widget should be visible for the current position.
             * PluginWidgetHost calls this every ~500ms and manages .visible class.
             *
             * @param {number} positionTicks - Current playback position in ticks
             * @returns {boolean}
             */
            shouldShow(positionTicks) {
                return positionTicks >= segment.start && positionTicks < segment.end;
            },

            /**
             * Called by PluginWidgetHost / PluginManager when Enter is pressed
             * on this widget's button.
             * Seeks to the end of the segment to skip it.
             *
             * @param {import('../../PluginAPI.js').default} pluginApi
             */
            onSelect(pluginApi) {
                const player = pluginApi.getPlayer();
                if (!player) {
                    pluginApi.log.warn('Skip Intro: onSelect called but player is null');
                    return;
                }

                // Seek to 1 second after segment end to clear the boundary cleanly
                const seekTarget = segment.end + TICKS_PER_SECOND;
                player.seek(seekTarget);

                pluginApi.log.info(`Skip ${type}: seeking to ${seekTarget}`);

                // Instantly remove focus outline to make the UI feel snappier before
                // the next timeupdate tick officially hides the button element
                if (document.activeElement && document.activeElement.classList.contains(widgetId)) {
                    document.activeElement.blur();
                }
            }
        };
    }
};

export default skipIntroPlugin;
