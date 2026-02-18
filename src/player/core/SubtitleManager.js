/**
 * SubtitleManager — Unified Subtitle Orchestrator
 *
 * Centralized manager for all subtitle rendering across both playback backends
 * (TizenAVPlayer and HtmlVideoPlayer). Implements a priority-based delivery
 * chain: embedded native → external text → burn-in fallback.
 *
 * Phase 1: Text-based subtitles (SRT, VTT, TTML, SMI) via DOM rendering.
 * Phase 2: Native ASS/SSA rendering via canvas overlay (future).
 * Phase 3: PGS bitmap subtitles (future).
 *
 * @module core/SubtitleManager
 */

import { SubtitleParser } from './SubtitleParser.js';
import ASSRenderer from './ASSRenderer.js';
import PGSRenderer from './PGSRenderer.js';
import MediaHelper from './MediaHelper.js';
import SubtitleStyles from '../../utils/SubtitleStyles.js';
import { logger } from '../../utils/Logger.js';
import { PlayerSettings } from '../../utils/PlayerSettings.js';

const log = logger.create('SubtitleManager');

// ============================================================================
// Subtitle delivery method constants
// ============================================================================

const DeliveryMethod = {
    /** Embedded in the container, rendered natively by the backend (Tizen AVPlay) */
    EMBEDDED_NATIVE: 'embedded_native',
    /** Fetched from server as text, rendered by SubtitleManager onto DOM overlay */
    EXTERNAL_TEXT: 'external_text',
    /** Future: ASS/SSA rendered via canvas overlay */
    ASS_CANVAS: 'ass_canvas',
    /** Future: PGS bitmap rendered via canvas overlay */
    PGS_BITMAP: 'pgs_bitmap',
    /** No delivery method available — subtitle cannot be displayed */
    NONE: 'none'
};

// ============================================================================
// Text-based subtitle formats that we can fetch and render ourselves
// ============================================================================

const TEXT_FORMATS = [
    'srt', 'subrip',
    'vtt', 'webvtt',
    'ttml', 'dfxp',
    'smi', 'sami',
    'mov_text', 'tx3g',
    'scc',
    'sbv',
    'ttxt'
];

// ============================================================================
// SubtitleManager Class
// ============================================================================

export default class SubtitleManager {
    /**
     * @param {Object} options
     * @param {string} options.serverUrl - Jellyfin server base URL
     * @param {string} options.authToken - Authentication token for API calls
     * @param {Function} options.onPrimaryCue - Callback when primary subtitle cue changes
     * @param {Function} options.onSecondaryCue - Callback when secondary subtitle cue changes
     * @param {Function} options.onDeliveryChange - Callback when delivery method changes
     */
    constructor(options) {
        // ====================================================================
        // Configuration
        // ====================================================================

        this._serverUrl = options.serverUrl;
        this._authToken = options.authToken;
        this._container = options.container;

        // Callbacks to notify the host (JellyfinPlayer) about cue changes
        this._onPrimaryCue = options.onPrimaryCue || (() => {});
        this._onSecondaryCue = options.onSecondaryCue || (() => {});
        this._onDeliveryChange = options.onDeliveryChange || (() => {});

        // ====================================================================
        // Media Context — set by the host when playback begins
        // ====================================================================

        this._itemId = null;
        this._mediaSourceId = null;
        this._mediaStreams = [];  // All MediaStreams from the current media source
        this._backendType = null; // 'tizen' or 'html5'
        this._videoElement = null; // Reference to real video element (or null)

        // ====================================================================
        // Renderers renderers
        // ====================================================================

        this._assRenderer = null;
        this._pgsRenderer = null;

        // ====================================================================
        // Primary Subtitle State
        // ====================================================================

        this._primaryTrack = null;          // Selected Jellyfin subtitle stream object
        this._primaryDelivery = DeliveryMethod.NONE;
        this._primaryCues = [];             // Parsed cue array for text-based rendering
        this._activePrimaryCue = null;      // Currently displayed primary cue
        this._primaryOffset = 0;            // User-applied timing offset in seconds

        // ====================================================================
        // Secondary Subtitle State
        // ====================================================================

        this._secondaryTrack = null;
        this._secondaryDelivery = DeliveryMethod.NONE;
        this._secondaryCues = [];
        this._activeSecondaryCue = null;
        this._secondaryOffset = 0;

        log.info('SubtitleManager initialized');
    }

    // ========================================================================
    // Media Context
    // ========================================================================

    /**
     * Set the current media context. Called by JellyfinPlayer when a new
     * item starts playing. This resets all subtitle state.
     *
     * @param {Object} context
     * @param {string} context.itemId - Jellyfin item ID
     * @param {string} context.mediaSourceId - Media source ID
     * @param {Array} context.mediaStreams - All MediaStreams from the media source
     * @param {string} context.backendType - 'tizen' or 'html5'
     */
    setMediaContext(context) {
        // Clear any active subtitles before switching context
        this._clearPrimary();
        this._clearSecondary();

        // Destroy existing renderers as context (video/container) might change
        if (this._assRenderer) {
            this._assRenderer.destroy();
            this._assRenderer = null;
        }
        if (this._pgsRenderer) {
            this._pgsRenderer.destroy();
            this._pgsRenderer = null;
        }

        this._itemId = context.itemId;
        this._mediaSourceId = context.mediaSourceId;
        this._mediaStreams = context.mediaStreams || [];
        this._backendType = context.backendType;
        this._videoElement = context.videoElement || null;

        log.info(`Media context set: item=${this._itemId}, source=${this._mediaSourceId}, backend=${this._backendType}`);
    }

    // ========================================================================
    // Primary Subtitle
    // ========================================================================

    /**
     * Set the primary subtitle track. Determines the best delivery method
     * and sets up rendering accordingly.
     *
     * @param {number} streamIndex - Jellyfin subtitle stream index (-1 to disable)
     * @returns {Promise<string>} The delivery method chosen
     */
    async setPrimaryTrack(streamIndex) {
        // Clear any existing primary subtitle
        this._clearPrimary();

        // Disable subtitles entirely
        if (streamIndex === -1) {
            log.info('Primary subtitles disabled');
            this._onDeliveryChange({ primary: DeliveryMethod.NONE });
            return DeliveryMethod.NONE;
        }

        // Find the subtitle track in the media streams
        const track = this._findSubtitleTrack(streamIndex);
        if (!track) {
            log.warn('Primary subtitle track not found for index:', streamIndex);
            return DeliveryMethod.NONE;
        }

        this._primaryTrack = track;

        // Determine how to deliver this subtitle
        const delivery = this._determineDeliveryMethod(track);
        this._primaryDelivery = delivery;
        log.info(`Primary subtitle: "${track.DisplayTitle}" (${track.Codec}) → delivery: ${delivery}`);

        // Notify host about the delivery method (so it can delegate to backend if needed)
        this._onDeliveryChange({ primary: delivery, track });

        // If we're handling it ourselves (external text), fetch and parse
        if (delivery === DeliveryMethod.EXTERNAL_TEXT) {
            await this._fetchAndParseCues(track, 'primary');
        } else if (delivery === DeliveryMethod.ASS_CANVAS) {
            await this._loadASSTrack(track);
        } else if (delivery === DeliveryMethod.PGS_BITMAP) {
            await this._loadPGSTrack(track);
        }

        // For EMBEDDED_NATIVE, the host (JellyfinPlayer) will delegate to the
        // backend directly. We don't need to do anything else here.

        return delivery;
    }

    /**
     * Set the secondary subtitle track. Always fetched as external text
     * regardless of whether the track is embedded or not.
     *
     * @param {number} streamIndex - Jellyfin subtitle stream index (-1 to disable)
     * @returns {Promise<string>} The delivery method chosen
     */
    async setSecondaryTrack(streamIndex) {
        // Clear existing secondary subtitle
        this._clearSecondary();

        if (streamIndex === -1) {
            log.info('Secondary subtitles disabled');
            return DeliveryMethod.NONE;
        }

        // Find the track
        const track = this._findSubtitleTrack(streamIndex);
        if (!track) {
            log.warn('Secondary subtitle track not found for index:', streamIndex);
            return DeliveryMethod.NONE;
        }

        this._secondaryTrack = track;

        // Secondary subtitles are always fetched externally and rendered as text
        // (even if the track is embedded, we request it from the server's API)
        this._secondaryDelivery = DeliveryMethod.EXTERNAL_TEXT;
        log.info(`Secondary subtitle: "${track.DisplayTitle}" (${track.Codec}) → delivery: external_text`);

        await this._fetchAndParseCues(track, 'secondary');

        return DeliveryMethod.EXTERNAL_TEXT;
    }

    // ========================================================================
    // Time-Based Cue Updates (the "tick" method)
    // ========================================================================

    /**
     * Called on every time update to check if the active subtitle cue has
     * changed. This drives the DOM-rendered subtitles.
     *
     * For EMBEDDED_NATIVE delivery, the backend handles its own cue updates
     * via onsubtitlechange, so we skip primary ticking in that case.
     *
     * @param {number} currentTimeSeconds - Current playback position in seconds
     */
    tick(currentTimeSeconds) {
        // Tick primary subtitle (only if we're managing it, not the backend)
        if (this._primaryDelivery === DeliveryMethod.EXTERNAL_TEXT && this._primaryCues.length > 0) {
            this._tickCues(currentTimeSeconds, 'primary');
        }

        // Tick secondary subtitle (always managed by us)
        if (this._secondaryDelivery === DeliveryMethod.EXTERNAL_TEXT && this._secondaryCues.length > 0) {
            this._tickCues(currentTimeSeconds, 'secondary');
        }

        // Tick ASS renderer (needed for virtual video backend on Tizen)
        if (this._primaryDelivery === DeliveryMethod.ASS_CANVAS && this._assRenderer) {
            this._assRenderer.tick(currentTimeSeconds);
        }

        // Tick PGS renderer (needed for Tizen AVPlay / manual timing)
        if (this._primaryDelivery === DeliveryMethod.PGS_BITMAP && this._pgsRenderer) {
            this._pgsRenderer.tick(currentTimeSeconds);
        }
    }

    /**
     * Handle an embedded subtitle event from the backend (TizenAVPlayer).
     * Routes the event through to the primary cue callback.
     *
     * @param {Object} data - Subtitle event data from backend
     * @param {string} data.text - Subtitle text
     * @param {number} data.duration - Duration in milliseconds
     */
    handleEmbeddedSubtitleEvent(data) {
        // Only handle if primary delivery is embedded native
        if (this._primaryDelivery !== DeliveryMethod.EMBEDDED_NATIVE) return;

        // Pass through to the primary cue callback
        this._onPrimaryCue(data);
    }

    // ========================================================================
    // Subtitle Offset
    // ========================================================================

    /**
     * Set the primary subtitle timing offset.
     * Positive = subtitles display later, negative = earlier.
     *
     * @param {number} seconds - Offset in seconds
     */
    setPrimaryOffset(seconds) {
        this._primaryOffset = seconds;
        log.debug(`Primary subtitle offset set: ${seconds}s`);
        if (this._assRenderer) {
            this._assRenderer.setDelay(seconds);
        }
        if (this._pgsRenderer) {
            this._pgsRenderer.setOffset(seconds);
        }
    }

    /**
     * Set the secondary subtitle timing offset.
     * @param {number} seconds - Offset in seconds
     */
    setSecondaryOffset(seconds) {
        this._secondaryOffset = seconds;
        log.debug(`Secondary subtitle offset set: ${seconds}s`);
    }

    /**
     * Get the current primary subtitle offset.
     * @returns {number} Offset in seconds
     */
    getPrimaryOffset() {
        return this._primaryOffset;
    }

    // ========================================================================
    // Getters
    // ========================================================================

    /**
     * Get the current primary delivery method.
     * @returns {string} One of the DeliveryMethod constants
     */
    getPrimaryDelivery() {
        return this._primaryDelivery;
    }

    /**
     * Get the current primary subtitle track.
     * @returns {Object|null} The Jellyfin subtitle stream object
     */
    getPrimaryTrack() {
        return this._primaryTrack;
    }

    /**
     * Refresh subtitle styles (e.g. font override)
     */
    async refreshStyles() {
        // Update ASS renderer if active
        if (this._assRenderer) {
            const fontClass = SubtitleStyles.getFontClassName('subtitleFontAss');
            const fontFamily = SubtitleStyles.getFontFamily('subtitleFontAss');
            const fontScale = SubtitleStyles.getFontScale('subtitleFontAss');
            const outlineThickness = PlayerSettings.get('subtitleOutlineThickness');
            const shadowThickness = PlayerSettings.get('subtitleShadowThickness');
            if (fontClass && fontFamily) {
                await this._assRenderer.setFontStyles(fontClass, fontFamily, fontScale, outlineThickness, shadowThickness);
            }
        }
    }

    /**
     * Get the current secondary subtitle track.
     * @returns {Object|null}
     */
    getSecondaryTrack() {
        return this._secondaryTrack;
    }

    /**
     * Check if the primary subtitle is being managed by SubtitleManager
     * (as opposed to the backend handling it natively).
     * @returns {boolean}
     */
    isPrimaryManagedByUs() {
        return this._primaryDelivery === DeliveryMethod.EXTERNAL_TEXT ||
               this._primaryDelivery === DeliveryMethod.ASS_CANVAS ||
               this._primaryDelivery === DeliveryMethod.PGS_BITMAP;
    }

    /**
     * Check if the current primary subtitle is an ASS/SSA track.
     * @returns {boolean}
     */
    isASSActive() {
        return this._primaryDelivery === DeliveryMethod.ASS_CANVAS;
    }

    // ========================================================================
    // Cleanup
    // ========================================================================

    /**
     * Full cleanup — destroy the subtitle manager and release all resources.
     */
    destroy() {
        this._clearPrimary();
        this._clearSecondary();
        this._itemId = null;
        this._mediaSourceId = null;
        this._mediaStreams = [];
        if (this._assRenderer) {
            this._assRenderer.destroy();
            this._assRenderer = null;
        }
        if (this._pgsRenderer) {
            this._pgsRenderer.destroy();
            this._pgsRenderer = null;
        }
        log.info('SubtitleManager destroyed');
    }

    // ========================================================================
    // Private: Delivery Method Resolution
    // ========================================================================

    /**
     * Determine the best delivery method for a given subtitle track.
     * Implements the priority chain:
     *
     * 1. Embedded + TizenAV backend → EMBEDDED_NATIVE (native rendering)
     * 2. Text format → EXTERNAL_TEXT (fetch from server API, render on DOM)
     * 3. Future: ASS → ASS_CANVAS
     * 4. Future: PGS → PGS_BITMAP
     * 5. Fallback → NONE (can't render it)
     *
     * @param {Object} track - Jellyfin subtitle stream object
     * @returns {string} DeliveryMethod constant
     * @private
     */
    _determineDeliveryMethod(track) {
        const codec = (track.Codec || '').toLowerCase();
        const isExternal = track.IsExternal === true;
        const isEmbedded = !isExternal;

        // Priority 1: Embedded subtitle on Tizen AVPlay backend
        // AVPlay can natively render embedded text subtitles (SRT, TTML, VTT, etc.)
        // but often fails with bitmap formats (PGS, VOBSUB).
        // We restrict this to known text formats to avoid selecting unsupported tracks.
        if (isEmbedded && this._backendType === 'tizen') {
            if (this._isTextFormat(codec)) {
                log.debug(`Track "${track.DisplayTitle}" is embedded text + Tizen → EMBEDDED_NATIVE`);
                return DeliveryMethod.EMBEDDED_NATIVE;
            }
        }

        // Priority 2: ASS/SSA → ASS_CANVAS
        if (codec === 'ass' || codec === 'ssa') {
            log.debug(`Track "${track.DisplayTitle}" is ASS/SSA → ASS_CANVAS`);
            return DeliveryMethod.ASS_CANVAS;
        }

        // Priority 3: Text-based format → fetch from server and render on DOM
        // The Jellyfin API can extract embedded text subs and serve them as VTT/SRT,
        // so this works for both embedded and external text subtitles.
        if (this._isTextFormat(codec)) {
            log.debug(`Track "${track.DisplayTitle}" is text format (${codec}) → EXTERNAL_TEXT`);
            return DeliveryMethod.EXTERNAL_TEXT;
        }

        // Priority 4: PGS → PGS_BITMAP
        if (codec === 'pgs' || codec === 'pgssub') {
            log.debug(`Track "${track.DisplayTitle}" is PGS → PGS_BITMAP`);
            return DeliveryMethod.PGS_BITMAP;
        }

        // Image-based subtitles (PGS, DVDsub) on HTML5 backend cannot be rendered yet
        log.warn(`No delivery method for track "${track.DisplayTitle}" (codec: ${codec}, embedded: ${isEmbedded}, backend: ${this._backendType})`);
    }

    /**
     * Load an ASS/SSA track and initialize the ASSRenderer.
     * @param {Object} track
     * @private
     */
    async _loadASSTrack(track) {
        if (!this._itemId || !this._mediaSourceId) return;

        try {
            // Lazy init renderer
            if (!this._assRenderer) {
                // Find video dimensions for virtual element if needed
                let width = 1920;
                let height = 1080;
                const videoStream = this._mediaStreams.find(s => s.Type === 'Video');
                if (videoStream && videoStream.Width && videoStream.Height) {
                    width = videoStream.Width;
                    height = videoStream.Height;
                }

                this._assRenderer = new ASSRenderer({
                    container: this._container,
                    video: this._videoElement,
                    width,
                    height
                });
            }

            // Fetch raw ASS content
            // We request the original format (no conversion to vtt)
            const url = MediaHelper.getSubtitleUrl(
                track,
                this._serverUrl,
                this._itemId,
                this._mediaSourceId,
                this._authToken,
                track.Codec // 'ass' or 'ssa'
            );

            log.debug(`Fetching ASS subtitle: ${url}`);
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            
            const content = await response.text();

            await this._assRenderer.setTrack(content);
            
            // Apply current subtitle font override
            const fontClass = SubtitleStyles.getFontClassName('subtitleFontAss');
            const fontFamily = SubtitleStyles.getFontFamily('subtitleFontAss');
            const fontScale = SubtitleStyles.getFontScale('subtitleFontAss');
            const outlineThickness = PlayerSettings.get('subtitleOutlineThickness');
            const shadowThickness = PlayerSettings.get('subtitleShadowThickness');
            if (fontClass && fontFamily) {
                await this._assRenderer.setFontStyles(fontClass, fontFamily, fontScale, outlineThickness, shadowThickness);
            }

            this._assRenderer.show();

        } catch (err) {
            const errorMsg = err ? (err.name + ': ' + err.message + '\n' + err.stack) : err;
            log.error('Failed to load ASS track:', errorMsg);
        }
    }

    /**
     * Load a PGS track and initialize the PGSRenderer.
     * @param {Object} track
     * @private
     */
    async _loadPGSTrack(track) {
        if (!this._itemId || !this._mediaSourceId) return;

        try {
            // Lazy init renderer
            if (!this._pgsRenderer) {
                this._pgsRenderer = new PGSRenderer({
                    track,
                    container: this._container,
                    videoElement: this._videoElement,
                    // Initial offset
                    timeOffset: this._primaryOffset
                });
            }

            // Build the subtitle URL (PGS/.sup)
            // We use the 'stream' endpoint with .sup extension
            // Jellyfin API: /Videos/{itemId}/{mediaSourceId}/Subtitles/{streamIndex}/Stream.sup
            const url = MediaHelper.getSubtitleUrl(
                track,
                this._serverUrl,
                this._itemId,
                this._mediaSourceId,
                this._authToken,
                'sup'
            );

            log.info(`Loading PGS subtitle from: ${url}`);
            
            // The renderer handles fetching via libpgs
            // But wait, libpgs takes a URL or buffer.
            // Our PGSRenderer constructor took the URL but we didn't update it here if reusing renderer?
            // Actually we destroy/recreate renderers on context switch, but not necessarily on track switch
            // if we stayed in same context.
            // But above lazy init logic only creates if generic _pgsRenderer is null.
            // If we switch from one PGS track to another, we need to update it.
            
            // Simpler: Just destroy and recreate if it exists to be safe and clean
            if (this._pgsRenderer) {
                this._pgsRenderer.destroy();
            }
            
            this._pgsRenderer = new PGSRenderer({
                track,
                container: this._container,
                videoElement: this._videoElement,
                subUrl: url,
                timeOffset: this._primaryOffset
            });

        } catch (err) {
            log.error('Failed to load PGS track:', err);
        }
    }

    /**
     * Check if a codec is a text-based subtitle format that we can parse.
     * @param {string} codec - Subtitle codec name (lowercase)
     * @returns {boolean}
     * @private
     */
    _isTextFormat(codec) {
        return TEXT_FORMATS.includes(codec);
    }

    // ========================================================================
    // Private: Track Lookup
    // ========================================================================

    /**
     * Find a subtitle track in the current media streams by its stream index.
     * @param {number} streamIndex - Jellyfin subtitle stream index
     * @returns {Object|null} The matching subtitle stream, or null
     * @private
     */
    _findSubtitleTrack(streamIndex) {
        return this._mediaStreams.find(
            (s) => s.Type === 'Subtitle' && s.Index === streamIndex
        ) || null;
    }

    // ========================================================================
    // Private: Fetch & Parse
    // ========================================================================

    /**
     * Fetch a subtitle track from the Jellyfin API and parse it into cues.
     * We request VTT format from the server — it handles conversion for us.
     *
     * @param {Object} track - Subtitle stream object
     * @param {'primary'|'secondary'} slot - Which subtitle slot to populate
     * @private
     */
    async _fetchAndParseCues(track, slot) {
        if (!this._itemId || !this._mediaSourceId) {
            log.error(`Cannot fetch subtitle — missing media context (${slot})`);
            return;
        }

        try {
            // Build the subtitle URL — Jellyfin converts to VTT on the fly
            const url = MediaHelper.getSubtitleUrl(
                track,
                this._serverUrl,
                this._itemId,
                this._mediaSourceId,
                this._authToken,
                'vtt'  // Request VTT format; server transcodes from any source format
            );

            log.debug(`Fetching ${slot} subtitle (${track.Codec}): ${url}`);

            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const text = await response.text();
            const cues = SubtitleParser.parse(text);

            // Store parsed cues in the correct slot
            if (slot === 'primary') {
                this._primaryCues = cues;
            } else {
                this._secondaryCues = cues;
            }

            log.info(`Parsed ${cues.length} ${slot} subtitle cues from "${track.DisplayTitle}"`);
        } catch (err) {
            log.error(`Failed to fetch/parse ${slot} subtitle:`, err ? (err.name + ': ' + err.message + '\n' + err.stack) : err);

            // Clear cues on failure
            if (slot === 'primary') {
                this._primaryCues = [];
            } else {
                this._secondaryCues = [];
            }
        }
    }

    // ========================================================================
    // Private: Cue Ticking
    // ========================================================================

    /**
     * Check if the active cue has changed for a given subtitle slot, and
     * fire the appropriate callback if so.
     *
     * @param {number} currentTimeSeconds - Current playback position
     * @param {'primary'|'secondary'} slot - Which subtitle slot to tick
     * @private
     */
    _tickCues(currentTimeSeconds, slot) {
        const cues = slot === 'primary' ? this._primaryCues : this._secondaryCues;
        const offset = slot === 'primary' ? this._primaryOffset : this._secondaryOffset;
        const callback = slot === 'primary' ? this._onPrimaryCue : this._onSecondaryCue;

        // Apply the user's timing offset
        const adjustedTime = currentTimeSeconds - offset;

        // Binary search would be faster for large cue arrays, but linear
        // scan is fine for typical subtitle file sizes (~500-2000 cues)
        const activeCue = cues.find(
            (cue) => adjustedTime >= cue.start && adjustedTime <= cue.end
        );

        // Determine the current "active cue" reference for this slot
        const currentActive = slot === 'primary' ? this._activePrimaryCue : this._activeSecondaryCue;

        if (activeCue) {
            // Only emit if the cue actually changed (avoid redundant renders)
            if (currentActive !== activeCue) {
                if (slot === 'primary') {
                    this._activePrimaryCue = activeCue;
                } else {
                    this._activeSecondaryCue = activeCue;
                }

                callback({
                    text: activeCue.text,
                    duration: (activeCue.end - activeCue.start) * 1000
                });
            }
        } else {
            // No active cue — clear the display if something was showing
            if (currentActive !== null) {
                if (slot === 'primary') {
                    this._activePrimaryCue = null;
                } else {
                    this._activeSecondaryCue = null;
                }

                callback({ text: '' });
            }
        }
    }

    // ========================================================================
    // Private: Cleanup Helpers
    // ========================================================================

    /**
     * Clear all primary subtitle state and notify the host.
     * @private
     */
    _clearPrimary() {
        const wasActive = this._primaryTrack !== null;

        this._primaryTrack = null;
        this._primaryDelivery = DeliveryMethod.NONE;
        this._primaryCues = [];
        this._activePrimaryCue = null;
        this._primaryOffset = 0;

        // Clear the display if something was showing
        if (wasActive) {
            this._onPrimaryCue({ text: '' });
        }
        
        // Hide ASS if it was active
        if (this._assRenderer) {
            this._assRenderer.hide();
        }
        
        // Destroy PGS renderer to stop worker and clear canvas
        if (this._pgsRenderer) {
            this._pgsRenderer.destroy();
            this._pgsRenderer = null;
        }
    }

    /**
     * Clear all secondary subtitle state and notify the host.
     * @private
     */
    _clearSecondary() {
        const wasActive = this._secondaryTrack !== null;

        this._secondaryTrack = null;
        this._secondaryDelivery = DeliveryMethod.NONE;
        this._secondaryCues = [];
        this._activeSecondaryCue = null;
        this._secondaryOffset = 0;

        // Clear the display if something was showing
        if (wasActive) {
            this._onSecondaryCue({ text: '' });
        }
    }
}

// Export the delivery method constants for use by other modules
export { DeliveryMethod };
