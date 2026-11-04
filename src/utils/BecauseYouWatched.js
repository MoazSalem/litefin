/**
 * ============================================================================
 * Litefin Tizen - Because You Watched
 * ============================================================================
 *
 * Builds the "Because you watched X" Home rows. The module has no imports so
 * the picking and filtering logic can be unit-tested without the app runtime;
 * the API calls are injected by HomePage.
 * ============================================================================
 */

export const BYW_ROW_ID_PREFIX = 'because-watched-';
export const BYW_MAX_ROWS = 3;
export const RECO_ROW_ID_PREFIX = 'reco-';

/**
 * Whether a Home row id belongs to the recommendation rows (Because you watched,
 * or the actor / director / studio / genre rows).
 * @param {string} id
 * @returns {boolean}
 */
export function isRecommendationRowId(id) {
    return typeof id === 'string' && (id.startsWith(BYW_ROW_ID_PREFIX) || id.startsWith(RECO_ROW_ID_PREFIX));
}

/**
 * Default position of a recommendation row relative to its anchor row (Next Up / Continue Watching).
 * Because-you-watched rows come first, then actor, director, studio and genre rows.
 * @param {string} id
 * @returns {number}
 */
export function recommendationRowOffset(id) {
    if (id.startsWith(BYW_ROW_ID_PREFIX)) {
        return 0.8 + (parseInt(id.slice(BYW_ROW_ID_PREFIX.length), 10) || 1) * 0.01;
    }
    const order = ['actor', 'director', 'studio', 'genre'].indexOf(id.slice(RECO_ROW_ID_PREFIX.length));
    return 0.9 + (order < 0 ? 5 : order) * 0.01;
}

/**
 * Runs async jobs one at a time. Recommendation rows share one queue so each row
 * sees what the previous rows already suggested.
 * @returns {{run: (fn: () => Promise<any>) => Promise<any>}}
 */
export function createSerialQueue() {
    let tail = Promise.resolve();
    return {
        run(fn) {
            const result = tail.then(fn);
            tail = result.catch(() => {});
            return result;
        }
    };
}

/** How many recently played entries to scan for distinct source titles. */
const SOURCE_SCAN_LIMIT = 60;

/**
 * Collapses recently played items into distinct source titles, newest first.
 * Episodes resolve to their series so one binge doesn't fill every row.
 *
 * @param {Array<Object>} played - Played items, most recent first.
 * @returns {Array<{id: string, name: string}>}
 */
export function pickSources(played) {
    const seen = new Set();
    const sources = [];
    for (const item of played || []) {
        if (!item) continue;
        const isEpisode = item.Type === 'Episode' && item.SeriesId;
        const id = isEpisode ? item.SeriesId : item.Id;
        const name = isEpisode ? item.SeriesName : item.Name;
        if (!id || !name || seen.has(id)) continue;
        seen.add(id);
        sources.push({ id, name });
    }
    return sources;
}

/**
 * Drops suggestions that are already watched, already used by an earlier row,
 * or are one of the user's own recent sources.
 *
 * @param {Array<Object>} items - Items returned by the Similar endpoint.
 * @param {Set<string>} excludeIds
 * @returns {Array<Object>}
 */
export function filterSimilar(items, excludeIds) {
    return (items || []).filter((item) => item && item.Id && !excludeIds.has(item.Id) && !item.UserData?.Played);
}

/**
 * Creates a loader that resolves row N of the feature. Rows resolve in order so
 * that each one can exclude what the previous rows already suggested.
 *
 * @param {Object} deps
 * @param {() => Promise<Array<Object>>} deps.getPlayed - Recently played items, newest first.
 * @param {(id: string) => Promise<Array<Object>>} deps.getSimilar - Similar items for a source id.
 * @param {(msg: string, err: any) => void} [deps.onError]
 * @param {Set<string>} [deps.exclude] - Ids never to suggest; pass a shared set to dedupe across row kinds.
 * @param {{run: Function}} [deps.queue] - Shared serial queue; defaults to running immediately.
 * @returns {(index: number) => Promise<{sourceName: string, items: Array<Object>}|null>}
 */
export function createBecauseWatchedLoader({ getPlayed, getSimilar, onError, exclude = new Set(), queue }) {
    let sourcesPromise = null;
    let cursor = 0;
    const run = queue ? (fn) => queue.run(fn) : (fn) => fn();
    const slots = [];

    const getSources = () => {
        if (!sourcesPromise) {
            sourcesPromise = Promise.resolve()
                .then(getPlayed)
                .then((played) => {
                    const sources = pickSources(played).slice(0, SOURCE_SCAN_LIMIT);
                    // Never suggest something the user just watched.
                    sources.forEach((s) => exclude.add(s.id));
                    return sources;
                })
                .catch((err) => {
                    if (onError) onError('Failed to load recently played items', err);
                    return [];
                });
        }
        return sourcesPromise;
    };

    const resolveNext = async () => {
        const sources = await getSources();
        while (cursor < sources.length) {
            const source = sources[cursor++];
            let similar;
            try {
                similar = await getSimilar(source.id);
            } catch (err) {
                if (onError) onError(`Failed to load similar items for ${source.name}`, err);
                continue;
            }
            const items = filterSimilar(similar, exclude);
            if (items.length === 0) continue;
            items.forEach((item) => exclude.add(item.Id));
            return { sourceName: source.name, items };
        }
        return null;
    };

    const load = (index) => {
        if (!slots[index]) {
            const previous = index > 0 ? load(index - 1) : Promise.resolve();
            slots[index] = previous.then(() => run(resolveNext));
        }
        return slots[index];
    };

    return load;
}
