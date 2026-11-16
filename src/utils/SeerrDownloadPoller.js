/**
 * ============================================================================
 * Litefin Tizen - Seerr Download Poller
 * ============================================================================
 * Re-fetches a Seerr item on a timer while a download (or an approved request
 * waiting for the downloader) is in progress, and hands each fresh result to
 * the page.
 *
 * Owns cadence, pausing and stale-response handling, so the page only decides
 * what to fetch and how to apply it. Kept free of imports: the cadence comes
 * from the caller and the timers are injectable, which lets node tests drive
 * it with a fake clock.
 * ============================================================================
 */

export default class SeerrDownloadPoller {
    /**
     * @param {Object} options
     * @param {Function} options.fetch - Returns a Promise of the fresh item
     * @param {Function} options.getDelay - Delay in ms until the next poll, 0 to stop polling
     * @param {Function} [options.isPaused] - True while a poll must not touch the page
     *        (hidden app, other page on top, modal open); paused ticks are skipped and re-armed
     * @param {Function} options.onUpdate - Receives (freshItem, isStale); may be async. isStale()
     *        turns true once the poller was rescheduled or stopped, so late work can bail out
     * @param {Function} [options.onError] - Receives fetch or update errors; polling continues
     * @param {Object} [options.timers] - { setTimeout, clearTimeout }, for tests
     */
    constructor({ fetch, getDelay, isPaused, onUpdate, onError, timers }) {
        this._fetch = fetch;
        this._getDelay = getDelay;
        this._isPaused = isPaused || (() => false);
        this._onUpdate = onUpdate;
        this._onError = onError || (() => {});
        this._timers = timers || { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id) };
        this._timer = null;
        this._generation = 0;
        this._stopped = false;
    }

    /**
     * (Re)arms the timer from the current state. Any response still in flight
     * is discarded, so call this after the page changed the item itself
     * (request created or cancelled).
     */
    schedule() {
        this._clearTimer();
        this._generation++;
        if (this._stopped) return;

        const delay = this._getDelay();
        if (!delay) return;

        const generation = this._generation;
        this._timer = this._timers.setTimeout(() => {
            void this._tick(generation);
        }, delay);
    }

    /**
     * Stops polling for good and discards any response still in flight.
     */
    stop() {
        this._stopped = true;
        this._generation++;
        this._clearTimer();
    }

    // ========================================================================
    // Internals
    // ========================================================================

    /** @private */
    _clearTimer() {
        if (this._timer !== null) {
            this._timers.clearTimeout(this._timer);
            this._timer = null;
        }
    }

    /**
     * @param {number} generation - Generation the timer was armed for
     * @private
     */
    async _tick(generation) {
        this._timer = null;
        if (this._stopped || generation !== this._generation) return;

        if (this._isPaused()) {
            this.schedule();
            return;
        }

        const isStale = () => this._stopped || generation !== this._generation;
        try {
            const fresh = await this._fetch();
            // A modal may have opened while the request was in flight
            if (!isStale() && !this._isPaused()) {
                await this._onUpdate(fresh, isStale);
            }
        } catch (err) {
            this._onError(err);
        }

        if (!isStale()) this.schedule();
    }
}
