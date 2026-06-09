/**
 * ============================================================================
 * SyncPlayTimeSync — Clock synchronization between client and Jellyfin server
 * ============================================================================
 *
 * The Jellyfin server is the authoritative clock; each client calculates how
 * far its local clock deviates from the server's using a series of "ping"
 * round-trips.
 *
 * Each measurement:
 *   - Records T0 = Date.now() just before calling syncPlayPing()
 *   - Gets back from the server:
 *       RequestReceptionTime  — when the server received the request
 *       ResponseTransmissionTime — when the server sent its response
 *   - Records T3 = Date.now() just after the response arrives (in the ping handler)
 *   - Calculates:
 *       roundtrip = T3 - T0
 *       serverProcessing = (ResponseTransmissionTime - RequestReceptionTime) in ms
 *       networkDelay = (roundtrip - serverProcessing) / 2
 *       clockOffset  = RequestReceptionTime - T0 - networkDelay
 *         (positive  → local clock is BEHIND server;
 *          negative → local clock is AHEAD of server)
 *
 * We keep the N most recent measurements, sort by roundtrip delay, and use
 * the lower half as a more accurate estimate (standard NTP filter approach).
 *
 * Port of jellyfin-web's src/plugins/syncPlay/core/timeSync/*.js
 * ============================================================================
 */

import { api } from '../../api/index.js';
import { logger } from '../../utils/Logger.js';

const log = logger.create('SyncPlayTimeSync');

// ============================================================================
// Constants
// ============================================================================

/**
 * How many measurements to keep in history.
 * Lower half of this (by round-trip) are used for final estimation.
 */
const MEASUREMENT_COUNT = 8;

/**
 * How often to poll for a new measurement while actively syncing (ms).
 * Jellyfin-web uses 1 000ms during the initial burst then backs off.
 */
const INITIAL_POLL_INTERVAL_MS = 1000;

/**
 * After collecting the first MEASUREMENT_COUNT samples, back off to this
 * interval to avoid hammering the server (ms).
 */
const STEADY_STATE_POLL_INTERVAL_MS = 60000; // 1 minute

/**
 * Maximum error (ms) before we notify listeners that the sync is stale
 * and should trigger a correction.
 */
const MAX_ALLOWED_ERROR_MS = 500;

// ============================================================================
// SyncPlayTimeSync Class
// ============================================================================

export class SyncPlayTimeSync {
    constructor() {
        /**
         * Array of { clockOffset, roundTrip } measurement objects.
         * Kept in insertion order; truncated at MEASUREMENT_COUNT.
         * @type {Array<{clockOffset: number, roundTrip: number}>}
         */
        this._measurements = [];

        /**
         * The calculated clock offset in milliseconds.
         * Positive → local is behind server. Negative → local is ahead.
         * @type {number}
         */
        this._timeOffset = 0;

        /**
         * Estimated one-way network ping in ms (half of median round-trip).
         * @type {number}
         */
        this._ping = 0;

        /**
         * Whether time sync is running.
         * @type {boolean}
         */
        this._isRunning = false;

        /**
         * Timer ID for the poll interval.
         * @type {number|null}
         */
        this._pollTimer = null;

        /**
         * Whether the initial burst of measurements is complete.
         * Controls whether we use fast or slow poll interval.
         * @type {boolean}
         */
        this._isStable = false;
    }

    // ========================================================================
    // Public API
    // ========================================================================

    /**
     * Start the time-sync polling loop.
     * Fires an initial burst at INITIAL_POLL_INTERVAL_MS, then
     * backs off to STEADY_STATE_POLL_INTERVAL_MS once stable.
     */
    enable() {
        if (this._isRunning) return;

        log.info('TimeSync starting');
        this._isRunning = true;
        this._isStable = false;
        this._measurements = [];

        // Start with the first poll immediately
        this._schedulePoll(0);
    }

    /**
     * Stop the polling loop and reset state.
     */
    disable() {
        if (!this._isRunning) return;

        log.info('TimeSync stopping');
        this._isRunning = false;
        this._isStable = false;

        if (this._pollTimer !== null) {
            clearTimeout(this._pollTimer);
            this._pollTimer = null;
        }

        // Keep offset and ping — they're still usable until next enable()
    }

    /**
     * Convert a local timestamp (ms) to the server's clock (ms).
     * @param {number} localTimeMs - Local Date.now() value
     * @returns {number} Estimated server time in ms
     */
    toServer(localTimeMs) {
        return localTimeMs + this._timeOffset;
    }

    /**
     * Convert a server timestamp (ms) to local time (ms).
     * @param {number} serverTimeMs - Server time in ms
     * @returns {number} Estimated local equivalent in ms
     */
    toLocal(serverTimeMs) {
        return serverTimeMs - this._timeOffset;
    }

    /**
     * Get the estimated one-way network latency (ms).
     * @returns {number}
     */
    getPing() {
        return this._ping;
    }

    /**
     * Get the calculated clock offset (ms).
     * @returns {number}
     */
    getTimeOffset() {
        return this._timeOffset;
    }

    /**
     * How many measurements we have so far.
     * @returns {number}
     */
    getMeasurementCount() {
        return this._measurements.length;
    }

    // ========================================================================
    // Private — Polling & Measurement
    // ========================================================================

    /**
     * Schedule the next poll after `delayMs` ms.
     * @private
     * @param {number} delayMs
     */
    _schedulePoll(delayMs) {
        if (!this._isRunning) return;

        this._pollTimer = setTimeout(() => {
            this._pollTimer = null;
            this._takeMeasurement();
        }, delayMs);
    }

    /**
     * Perform one ping-pong measurement against the server.
     *
     * NOTE: We use GET /System/Info/Public (getServerTime) — NOT POST /SyncPlay/Ping.
     * The /SyncPlay/Ping endpoint returns 204 No Content; it does not echo time fields
     * back to the client. /System/Info/Public does return RequestReceptionTime and
     * ResponseTransmissionTime in its JSON body, which is exactly what we need.
     * This matches the behaviour of jellyfin-web's TimeSyncServer.js.
     *
     * @private
     */
    async _takeMeasurement() {
        if (!this._isRunning) return;

        // T0: moment we fire the request, recorded from the local clock
        const t0 = Date.now();

        try {
            // GET /System/Info/Public — server stamps RequestReceptionTime and
            // ResponseTransmissionTime into the JSON response body so we can
            // derive an accurate clock offset and network delay.
            const response = await api.getServerTime();

            // T3: moment the response arrived, recorded from the local clock
            const t3 = Date.now();

            // Parse the two server-side timestamps from the response
            const requestReceptionTime = this._parseServerTime(response?.RequestReceptionTime);
            const responseTransmissionTime = this._parseServerTime(response?.ResponseTransmissionTime);

            if (requestReceptionTime === null || responseTransmissionTime === null) {
                // This can happen on an older Jellyfin server that doesn't populate
                // these fields — just skip rather than poisoning our measurements.
                log.warn(
                    'TimeSync: server response missing RequestReceptionTime / ResponseTransmissionTime fields, skipping measurement'
                );
            } else {
                // Classic NTP-style calculation:
                //   roundTrip       = total elapsed time for the request
                //   serverProcessing = time the server spent between receiving and sending
                //   networkDelay    = half of the actual network transit time
                //   clockOffset     = how far our local clock is behind (+) or ahead (-) of the server
                const roundTrip = t3 - t0;
                const serverProcessing = responseTransmissionTime - requestReceptionTime; // typically ~0ms
                const networkDelay = (roundTrip - serverProcessing) / 2;
                const clockOffset = requestReceptionTime - t0 - networkDelay;

                this._addMeasurement({ clockOffset, roundTrip });

                log.debug(
                    `TimeSync ping — rtt: ${roundTrip}ms, ` +
                        `delay: ${networkDelay.toFixed(1)}ms, ` +
                        `offset: ${clockOffset.toFixed(1)}ms`
                );
            }
        } catch (err) {
            log.warn('TimeSync ping failed:', err.message || err);
        }

        // Back off to the slower interval once we have a full buffer of samples
        const nextDelay = this._isStable ? STEADY_STATE_POLL_INTERVAL_MS : INITIAL_POLL_INTERVAL_MS;

        this._schedulePoll(nextDelay);
    }

    /**
     * Add a measurement to the history and recalculate the clock offset.
     * @private
     * @param {{ clockOffset: number, roundTrip: number }} measurement
     */
    _addMeasurement(measurement) {
        this._measurements.push(measurement);

        // Keep only the N most recent
        if (this._measurements.length > MEASUREMENT_COUNT) {
            this._measurements.shift();
        }

        // Transition to steady-state once we have a full buffer
        if (!this._isStable && this._measurements.length >= MEASUREMENT_COUNT) {
            this._isStable = true;
            log.info(`TimeSync: ${MEASUREMENT_COUNT} measurements collected — entering steady state`);
        }

        // Recalculate offset using best (lowest round-trip) measurements
        this._recalculate();
    }

    /**
     * Recalculate _timeOffset and _ping from the measurement history.
     *
     * Strategy: sort by roundTrip ascending, take the lower half (best quality
     * measurements), then average their clock offsets. This mirrors the NTP
     * filter algorithm used in jellyfin-web's TimeSync.js.
     * @private
     */
    _recalculate() {
        if (this._measurements.length === 0) return;

        // Sort by roundtrip ascending — lower roundtrip = better estimate
        const sorted = [...this._measurements].sort((a, b) => a.roundTrip - b.roundTrip);

        // Take the better half (at least 1)
        const bestCount = Math.max(1, Math.floor(sorted.length / 2));
        const best = sorted.slice(0, bestCount);

        // Average offset and roundtrip from best measurements
        const avgOffset = best.reduce((sum, m) => sum + m.clockOffset, 0) / best.length;
        const avgRoundTrip = best.reduce((sum, m) => sum + m.roundTrip, 0) / best.length;

        this._timeOffset = avgOffset;
        this._ping = avgRoundTrip / 2;

        log.debug(
            `TimeSync updated — offset: ${this._timeOffset.toFixed(1)}ms, ` +
                `ping: ${this._ping.toFixed(1)}ms ` +
                `(from ${best.length}/${this._measurements.length} samples)`
        );
    }

    /**
     * Parse an ISO8601 server timestamp string into a local ms integer.
     * Returns null if the string is missing or unparseable.
     * @private
     * @param {string|undefined|null} isoString
     * @returns {number|null}
     */
    _parseServerTime(isoString) {
        if (!isoString) return null;
        const ms = Date.parse(isoString);
        return isNaN(ms) ? null : ms;
    }
}

// Export a convenience constant for max allowed sync error
export { MAX_ALLOWED_ERROR_MS };

// Export singleton — SyncPlayManager uses this directly
export const syncPlayTimeSync = new SyncPlayTimeSync();
