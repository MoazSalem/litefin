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
/** Minimum suggestions required to display a 'Because You Watched' row. */
export const BYW_MIN_ITEMS = 3;

/**
 * Parses the "rows per recommendation type" setting into 1..BYW_MAX_ROWS (default 1).
 * @param {string|number|null} value
 * @returns {number}
 */
export function clampRowCount(value) {
    const n = parseInt(value, 10);
    return Math.min(Math.max(Number.isNaN(n) ? 1 : n, 1), BYW_MAX_ROWS);
}
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
 * Default position of a recommendation row relative to its anchor row (Next Up / Continue Watching),
 * always below 1 so it stays ahead of the next saved row. Because-you-watched rows come first, then
 * actor, director, studio and genre rows; row ids end in the row number (`reco-actor-2`).
 * @param {string} id
 * @returns {number}
 */
export function recommendationRowOffset(id) {
    const n = (parseInt(id.slice(id.lastIndexOf('-') + 1), 10) || 1) * 0.01;
    if (id.startsWith(BYW_ROW_ID_PREFIX)) return 0.5 + n;
    const kind = id.slice(RECO_ROW_ID_PREFIX.length).split('-')[0];
    const order = ['actor', 'director', 'studio', 'genre'].indexOf(kind);
    return 0.6 + (order < 0 ? 3 : order) * 0.1 + n;
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
export function createBecauseWatchedLoader({ getPlayed, getSimilar, onError, exclude = new Set(), queue, minItems = BYW_MIN_ITEMS }) {
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
                    // Reset cached promise so subsequent attempts can retry the fetch
                    sourcesPromise = null;
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
            // Drop suggestions already watched or claimed by earlier rows
            const items = filterSimilar(similar, exclude);
            // Skip sources that cannot populate a healthy carousel (minimum 3 items)
            if (items.length < minItems) continue;
            items.forEach((item) => exclude.add(item.Id));
            return { sourceName: source.name, items };
        }
        return null;
    };

    const load = (index) => {
        if (!slots[index]) {
            // Prevent rejection cascading: an unexpected failure in an earlier slot
            // should not prevent downstream recommendation rows from loading.
            const previous = index > 0 ? load(index - 1).catch(() => null) : Promise.resolve();
            slots[index] = previous.then(() => run(resolveNext));
        }
        return slots[index];
    };

    return load;
}
