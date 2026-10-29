/**
 * ============================================================================
 * Litefin - Home Row Prefetch Coordinator
 * ============================================================================
 * Fires the Continue Watching / Next Up requests at the earliest moment the
 * app knows it will land on the home page, so their network round-trips
 * overlap the HomePage async chunk download + lazy style loading instead of
 * serializing behind them.
 *
 * Boot timeline this enables:
 *   AuthManager._restoreSession() (optimistic, ~0ms)
 *     -> App.init() fires fireHomeRowPrefetch() alongside the Sidebar's
 *        GET /Users/{id}/Views
 *     -> HomePage chunk + modern/theme CSS chunks download in parallel
 *     -> HomePage._startRenderPipeline() consumes the in-flight promises
 *        via consumeHomeRowPrefetch() - zero additional latency for the
 *        rows users actually look at first.
 *
 * One-shot semantics: each stored promise is consumed exactly once (nulled
 * after read) and the store resets once every key has been consumed, so a
 * later HomePage visit re-fires fresh requests. The store is keyed by user
 * ID - a profile switch discards stale promises instead of feeding the new
 * user the old user's Continue Watching row.
 * ============================================================================
 */

import { api } from '../api/ApiClient.js';
import { storage } from './StorageService.js';
import { logger } from './Logger.js';
import { PlayerSettings } from './PlayerSettings.js';
import { homeLayoutManager } from './HomeLayoutManager.js';

const log = logger.create('HomeRowPrefetch');

/**
 * In-flight prefetch promises, or null when nothing is pending.
 * @type {{ userId: string, merged?: Promise<Object>, resume?: Promise<Object>, nextUp?: Promise<Object> }|null}
 */
let store = null;

/**
 * Fire the Continue Watching / Next Up requests for the given user (unless
 * already fired for that same user). Safe to call multiple times: repeated
 * calls for the same user are no-ops, and a call for a different user
 * discards the previous user's in-flight requests.
 *
 * Respects the user's home-row visibility config: hidden rows are not
 * prefetched. Rejections carry a no-op catch so an unconsumed prefetch
 * never surfaces as an unhandled promise error; consumed rejections
 * propagate into the row's own error handling exactly like a fresh
 * request would.
 * @param {string} userId - Active user ID the requests are fired for
 * @public
 */
export function fireHomeRowPrefetch(userId) {
    try {
        if (!userId) return;

        // Same user already armed - nothing to do.
        if (store && store.userId === userId) return;

        // Different user (profile switch): drop stale in-flight requests.
        store = { userId };

        const homeRowLimit = parseInt(storage.getItem('pref:homeRowsLimit') || 12, 10);

        // Respect the user's row visibility config: a hidden row must not
        // cause a wasted request.
        const savedLayout = homeLayoutManager.getSavedLayout() || [];
        const isHidden = (id) => savedLayout.some((c) => c.id === id && c.hidden);

        const mergeResumeNextUp = storage.getItem('pref:mergeResumeNextUp') === 'true';

        if (mergeResumeNextUp) {
            if (isHidden('resume')) return;

            // Replicate the merged-mode params computed inside the row's
            // fetchFn (limit / watched threshold / NextUpDateCutoff).
            const maxDays = parseInt(storage.getItem('pref:nextUpMaxDays'), 10);
            const daysLimit = isNaN(maxDays) ? 365 : maxDays;
            const mergedParams = { limit: homeRowLimit };
            mergedParams.watchedThreshold = Math.round(PlayerSettings.getWatchedThresholdFraction() * 100);
            if (daysLimit > 0) {
                const cutoff = new Date();
                cutoff.setDate(cutoff.getDate() - daysLimit);
                const cutoffIso = cutoff.toISOString();
                mergedParams.nextUpDateCutoff = cutoffIso;
                mergedParams.NextUpDateCutoff = cutoffIso;
            }

            const p = api.getMergedRows(mergedParams);
            p.catch(() => {});
            store.merged = p;
        } else {
            if (!isHidden('resume')) {
                const p = api.getResumeItems({ Limit: homeRowLimit });
                p.catch(() => {});
                store.resume = p;
            }
            if (!isHidden('next-up')) {
                const maxDays = parseInt(storage.getItem('pref:nextUpMaxDays'), 10);
                const daysLimit = isNaN(maxDays) ? 365 : maxDays;
                const params = { Limit: homeRowLimit };
                if (daysLimit > 0) {
                    const cutoff = new Date();
                    cutoff.setDate(cutoff.getDate() - daysLimit);
                    params.NextUpDateCutoff = cutoff.toISOString();
                }
                const p = api.getNextUp(params);
                p.catch(() => {});
                store.nextUp = p;
            }
        }

        log.debug('Home row prefetch fired (resume/next-up in flight)');
    } catch (err) {
        log.warn('Home row prefetch failed:', err);
    }
}

/**
 * Consume an in-flight prefetch promise fired by fireHomeRowPrefetch().
 * Returns the promise (still pending or already settled) exactly once - the
 * key is nulled after read so a later pipeline run cannot reuse a stale
 * response. Awaiting a rejected prefetch rethrows into the row's normal
 * error handling.
 *
 * When the store belongs to a different user (profile switched between fire
 * and consume), or the key was never armed, returns null so the caller falls
 * back to issuing a fresh request.
 * @param {string} key - 'merged' | 'resume' | 'nextUp'
 * @param {string} userId - Active user ID requesting consumption
 * @returns {Promise<Object>|null}
 * @public
 */
export function consumeHomeRowPrefetch(key, userId) {
    if (!store || store.userId !== userId) return null;

    const p = store[key] || null;
    store[key] = null;

    // Store fully drained - reset so the next HomePage visit re-fires.
    if (!store.merged && !store.resume && !store.nextUp) {
        store = null;
    }

    return p;
}
