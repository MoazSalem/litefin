/**
 * ============================================================================
 * SyncPlayPlaybackCore — Keeps local playback in sync with the group
 * ============================================================================
 *
 * Periodically checks the expected group play position (calculated from the
 * last server command + elapsed local time + clock offset) against the actual
 * player position. If the delta exceeds the allowed threshold it applies a
 * correction.
 *
 * Two correction strategies (matching jellyfin-web's PlaybackCore.js):
 *
 *   SkipToSync (default, works on ALL backends)
 *     Immediately seeks to the expected position.
 *     Precise but causes a brief visual hitch.
 *
 *   SpeedToSync (HTML5 only — TizenAVPlayer does NOT support playbackRate)
 *     Temporarily speeds up / slows down playback (<= ±10%).
 *     Much less jarring for small drifts.
 *
 * The strategy is chosen based on the backend type exposed by JellyfinPlayer
 * and the size of the detected error.
 *
 * Port of jellyfin-web's src/plugins/syncPlay/core/PlaybackCore.js
 * ============================================================================
 */

import { logger } from '../../utils/Logger.js';
import { MAX_ALLOWED_ERROR_MS } from './SyncPlayTimeSync.js';

const log = logger.create('SyncPlayPlaybackCore');

// ============================================================================
// Constants
// ============================================================================

/**
 * Maximum error where we still try SpeedToSync instead of skipping.
 * If the drift is larger than this we skip directly (too much to ramp up).
 * Only applies when the backend supports playback rate changes.
 * Value matches jellyfin-web: 2 seconds.
 */
const SPEED_SYNC_THRESHOLD_MS = 2000;

/**
 * How much to adjust playback rate for SpeedToSync.
 * E.g. 0.10 → max 10% speed change (0.90x–1.10x).
 */
const MAX_SPEED_ADJUSTMENT = 0.10;

/**
 * Minimum cycle time between sync check ticks (ms).
 * Even though timeupdate fires every ~250ms in HTML5, capping avoids spam.
 */
const SYNC_CHECK_INTERVAL_MS = 500;

/**
 * Ticks → milliseconds conversion factor.
 * Jellyfin uses 100-nanosecond ticks; 1 ms = 10 000 ticks.
 */
const TICKS_PER_MS = 10000;

// ============================================================================
// SyncPlayPlaybackCore Class
// ============================================================================

export class SyncPlayPlaybackCore {
    /**
     * @param {object} options
     * @param {object} options.timeSync     - SyncPlayTimeSync instance
     * @param {object} options.player       - JellyfinPlayer instance
     */
    constructor({ timeSync, player }) {
        /**
         * Reference to the time-sync module for toLocal() conversions.
         */
        this._timeSync = timeSync;

        /**
         * Reference to the active JellyfinPlayer.
         */
        this._player = player;

        /**
         * Whether we are tracking and correcting drift.
         * True between group Play and group Pause/Stop commands.
         * @type {boolean}
         */
        this._isTracking = false;

        /**
         * The server's last reported "at this server time, the media was at
         * this position" anchor point. Set on every SyncPlayCommand.
         *
         * Shape: {
         *   positionTicks:  number,   // position in media at anchor
         *   whenMs:         number,   // server time (ms) of the anchor
         *   isPlaying:      boolean,
         * }
         * @type {object|null}
         */
        this._playbackAnchor = null;

        /**
         * Timestamp of the last sync check (local ms). Used to throttle
         * how frequently we evaluate and apply corrections.
         * @type {number}
         */
        this._lastSyncCheck = 0;

        /**
         * Whether SpeedToSync is currently active. When true we have already
         * modified playback rate and will restore it once back in sync.
         * @type {boolean}
         */
        this._isSpeedSyncing = false;

        /**
         * Backend type string ('tizen', 'webos', 'html5').
         * Determined once when the player is attached.
         * @type {string}
         */
        this._backendType = player?.backendType || 'html5';
    }

    // ========================================================================
    // State Setters
    // ========================================================================

    /**
     * Update the playback anchor from a SyncPlayCommand.
     * Called by SyncPlayManager on every play/seek/unpause command.
     *
     * @param {object} anchor
     * @param {number}  anchor.positionTicks - Media position at anchor point (ticks)
     * @param {number}  anchor.whenMs        - Server time of the anchor (ms)
     * @param {boolean} anchor.isPlaying     - Whether the group is playing
     */
    setAnchor(anchor) {
        this._playbackAnchor = anchor;
        log.debug(
            `Anchor updated: pos=${anchor.positionTicks}ticks / ` +
            `when=${anchor.whenMs}ms / playing=${anchor.isPlaying}`
        );
    }

    /**
     * Start tracking and correcting drift. Call this when the group starts
     * (or resumes) playback.
     */
    startTracking() {
        this._isTracking = true;
        log.debug('PlaybackCore: tracking started');
    }

    /**
     * Stop drift tracking. Call this when the group pauses, stops, or the
     * local player stops. Restores playback rate if SpeedToSync is active.
     */
    stopTracking() {
        this._isTracking = false;
        this._restoreNormalSpeed();
        log.debug('PlaybackCore: tracking stopped');
    }

    // ========================================================================
    // Sync Check — called on every timeupdate from the player
    // ========================================================================

    /**
     * Called by SyncPlayManager on every `timeupdate` event from JellyfinPlayer.
     * Computes expected position from the anchor + elapsed server time, then
     * applies a correction if the actual position drifts too far.
     *
     * @param {number} currentPositionTicks - Reported current position in ticks
     */
    onTimeUpdate(currentPositionTicks) {
        if (!this._isTracking || !this._playbackAnchor || !this._playbackAnchor.isPlaying) {
            return;
        }

        // Throttle: don't check on every single timeupdate to avoid spam
        const now = Date.now();
        if (now - this._lastSyncCheck < SYNC_CHECK_INTERVAL_MS) return;
        this._lastSyncCheck = now;

        // ====================================================================
        // Compute expected position
        //
        // anchor.whenMs is a server timestamp; convert to local time to get
        // the wall-clock instant when the anchor was set.
        // Since then, `elapsedMs` ms of real time have passed, so the media
        // should have advanced by the same amount (assuming 1x playback rate).
        // ====================================================================

        const anchorLocalTimeMs = this._timeSync.toLocal(this._playbackAnchor.whenMs);
        const elapsedMs         = now - anchorLocalTimeMs;

        // Convert anchor position from ticks to ms, add elapsed, convert back
        const expectedPositionMs    = (this._playbackAnchor.positionTicks / TICKS_PER_MS) + elapsedMs;
        const expectedPositionTicks = expectedPositionMs * TICKS_PER_MS;

        // Delta in ms (positive = we are behind, negative = we are ahead)
        const deltaMs = (expectedPositionTicks - currentPositionTicks) / TICKS_PER_MS;

        // ====================================================================
        // Decide on correction strategy
        // ====================================================================

        const absDeltaMs = Math.abs(deltaMs);

        if (absDeltaMs <= MAX_ALLOWED_ERROR_MS) {
            // We are within tolerance — restore normal speed if we were speeding
            if (this._isSpeedSyncing) {
                this._restoreNormalSpeed();
            }
            return;
        }

        // Large drift or non-HTML5 backend → always SkipToSync
        if (absDeltaMs > SPEED_SYNC_THRESHOLD_MS || this._backendType !== 'html5') {
            this._skipToSync(expectedPositionTicks);
            return;
        }

        // Moderate drift on HTML5 → try SpeedToSync for a smoother experience
        this._speedToSync(deltaMs);
    }

    // ========================================================================
    // Correction Strategies
    // ========================================================================

    /**
     * SkipToSync: direct seek to the expected position.
     * Works on ALL backends; causes a brief seek hitch.
     *
     * @private
     * @param {number} targetTicks - Target position in ticks
     */
    _skipToSync(targetTicks) {
        log.info(`SkipToSync: seeking to ${Math.round(targetTicks / TICKS_PER_MS)}ms`);

        // Restore normal speed first in case we were in SpeedToSync
        this._restoreNormalSpeed();

        if (this._player) {
            this._player.seek(targetTicks);
        }

        // Reset the check timer so we don't immediately re-trigger
        this._lastSyncCheck = Date.now() + 1000;
    }

    /**
     * SpeedToSync: temporarily adjust playback rate to drift back into sync.
     * Only viable on the HTML5 backend (TizenAVPlayer does not support rate changes).
     *
     * Rate adjustment: clamp to ±MAX_SPEED_ADJUSTMENT around 1.0.
     * We compute how long the drift will take to correct at the chosen rate
     * and schedule a restore after that window.
     *
     * @private
     * @param {number} deltaMs - Signed drift: positive = behind, negative = ahead
     */
    _speedToSync(deltaMs) {
        if (!this._player || typeof this._player.setPlaybackRate !== 'function') {
            // Graceful fallback — backend doesn't support rate changes
            this._skipToSync((this._playbackAnchor.positionTicks / TICKS_PER_MS +
                             (Date.now() - this._timeSync.toLocal(this._playbackAnchor.whenMs))) * TICKS_PER_MS);
            return;
        }

        // Determine rate: speed up if behind, slow down if ahead
        // Rate is proportional to drift but clamped to ±MAX_SPEED_ADJUSTMENT
        const rate = Math.min(
            1.0 + MAX_SPEED_ADJUSTMENT,
            Math.max(
                1.0 - MAX_SPEED_ADJUSTMENT,
                1.0 + (deltaMs / 1000) * 0.1  // 100ms off → ±1% rate change
            )
        );

        if (Math.abs(rate - 1.0) < 0.001) {
            // Skip trivial adjustments
            return;
        }

        log.debug(`SpeedToSync: rate=${rate.toFixed(3)} (drift=${deltaMs.toFixed(0)}ms)`);

        this._isSpeedSyncing = true;
        this._player.setPlaybackRate(rate);

        // Estimate time to correct the drift and restore normal speed
        const correctionWindowMs = Math.abs(deltaMs) / Math.abs(rate - 1.0);
        setTimeout(() => {
            if (this._isSpeedSyncing) {
                this._restoreNormalSpeed();
            }
        }, correctionWindowMs + 200); // add 200ms buffer
    }

    /**
     * Restore the playback rate to 1.0 (normal speed).
     * No-op if the backend doesn't support rate changes.
     * @private
     */
    _restoreNormalSpeed() {
        if (!this._isSpeedSyncing) return;

        this._isSpeedSyncing = false;

        if (this._player && typeof this._player.setPlaybackRate === 'function') {
            this._player.setPlaybackRate(1.0);
        }
    }
}
