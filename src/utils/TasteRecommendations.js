/**
 * ============================================================================
 * Litefin Tizen - Taste Recommendations
 * ============================================================================
 *
 * Builds the actor / director / studio / genre recommendation rows for Home.
 * A taste profile ranks people, studios and genres by how much of the user's
 * recent viewing they account for, so rows follow real habits instead of a
 * random pick from the watch history. API calls are injected by HomePage, and
 * the module only imports other pure helpers so it can be unit-tested.
 * ============================================================================
 */

import { pickSources, filterSimilar } from './BecauseYouWatched.js';

export const TASTE_KINDS = ['actor', 'director', 'studio', 'genre'];

/** Settings key that enables the row for each kind. */
export const TASTE_PREF_KEYS = {
    actor: 'pref:recoActors',
    director: 'pref:recoDirectors',
    studio: 'pref:recoStudios',
    genre: 'pref:recoGenres'
};

/** Locale keys: the generic row name (layout editor, while loading) and the title that names the source. */
export const TASTE_HEADER_KEYS = {
    actor: 'HeaderRecommendedActor',
    director: 'HeaderRecommendedDirector',
    studio: 'HeaderRecommendedStudio',
    genre: 'HeaderRecommendedGenre'
};
/** Settings labels; the description key is the label key plus "Description". */
export const TASTE_LABEL_KEYS = {
    actor: 'LabelRecommendActors',
    director: 'LabelRecommendDirectors',
    studio: 'LabelRecommendStudios',
    genre: 'LabelRecommendGenres'
};
export const TASTE_TITLE_KEYS = {
    actor: 'RecommendationMoreWith',
    director: 'RecommendationDirectedBy',
    studio: 'RecommendationMoreFromStudio',
    genre: 'RecommendationBecauseYouLikeGenre'
};

/** How many recently watched titles feed the profile. */
export const PROFILE_SOURCE_LIMIT = 30;

/** Billing positions counted per title; later cast members are rarely a reason someone watched. */
const ACTORS_PER_TITLE = 5;
const DIRECTORS_PER_TITLE = 2;

/** A source must come from at least this many distinct titles, so one-off watches don't get a row. */
export const MIN_SUPPORT = 2;

/** A row with fewer suggestions than this is not worth showing. */
export const MIN_ROW_ITEMS = 3;

/** Weight of a favorite relative to the newest watched title (1.0). */
const FAVORITE_WEIGHT = 1.5;

/** Candidate sources tried per row before giving up. */
const MAX_TRIES = 5;

/**
 * Recency weight: the newest title counts fully, older ones fade.
 * @param {number} index - 0 is the most recently watched
 * @returns {number}
 */
function recencyWeight(index) {
    return 1 / (1 + index * 0.15);
}

function addScore(map, id, name, weight, itemId) {
    if (!id || !name) return;
    let entry = map.get(id);
    if (!entry) {
        entry = { id, name, score: 0, items: new Set() };
        map.set(id, entry);
    }
    entry.score += weight;
    entry.items.add(itemId);
}

function collect(item, weight, maps) {
    const people = item.People || [];
    let actors = 0;
    let directors = 0;
    for (const person of people) {
        if (person.Type === 'Actor' && actors < ACTORS_PER_TITLE) {
            addScore(maps.actor, person.Id, person.Name, weight, item.Id);
            actors++;
        } else if (person.Type === 'Director' && directors < DIRECTORS_PER_TITLE) {
            addScore(maps.director, person.Id, person.Name, weight, item.Id);
            directors++;
        }
    }
    for (const studio of item.Studios || []) {
        addScore(maps.studio, studio.Id, studio.Name, weight, item.Id);
    }
    // Genres are filtered by name, so the name doubles as the id.
    const genres = item.GenreItems && item.GenreItems.length ? item.GenreItems.map((g) => g.Name) : item.Genres || [];
    for (const name of genres) {
        addScore(maps.genre, name, name, weight, item.Id);
    }
}

/**
 * Ranks people, studios and genres by how much of the user's viewing they cover.
 *
 * @param {Array<Object>} watched - Titles (movies / series) with People, Studios and Genres, newest first.
 * @param {Array<Object>} [favorites] - Favorite titles with the same fields.
 * @returns {{actor: Array, director: Array, studio: Array, genre: Array}} Candidates per kind as
 *   `{id, name, score, support}`, best first. `support` is the number of distinct titles behind a candidate.
 */
export function buildTasteProfile(watched, favorites) {
    const maps = { actor: new Map(), director: new Map(), studio: new Map(), genre: new Map() };

    (watched || []).forEach((item, index) => {
        if (item) collect(item, recencyWeight(index), maps);
    });
    (favorites || []).forEach((item) => {
        if (item) collect(item, FAVORITE_WEIGHT, maps);
    });

    const profile = {};
    for (const kind of TASTE_KINDS) {
        profile[kind] = Array.from(maps[kind].values())
            .map((e) => ({ id: e.id, name: e.name, score: e.score, support: e.items.size }))
            .sort((a, b) => b.score - a.score || b.support - a.support || a.name.localeCompare(b.name));
    }
    return profile;
}

/**
 * Creates a memoized provider of the user's taste profile.
 *
 * @param {Object} deps
 * @param {() => Promise<Array<Object>>} deps.getPlayed - Recently played items, newest first.
 * @param {(ids: string[]) => Promise<Array<Object>>} deps.getDetails - Titles by id with People, Studios, Genres.
 * @param {() => Promise<Array<Object>>} [deps.getFavorites]
 * @param {Set<string>} [deps.exclude] - Receives the ids of recently watched titles so they are never suggested.
 * @param {(msg: string, err: any) => void} [deps.onError]
 * @returns {() => Promise<Object>}
 */
export function createTasteProfileProvider({ getPlayed, getDetails, getFavorites, exclude, onError }) {
    let promise = null;

    const build = async () => {
        const played = await getPlayed();
        const sources = pickSources(played).slice(0, PROFILE_SOURCE_LIMIT);
        const ids = sources.map((s) => s.id);
        if (exclude) ids.forEach((id) => exclude.add(id));

        const [details, favorites] = await Promise.all([
            ids.length > 0 ? getDetails(ids) : [],
            getFavorites ? getFavorites().catch(() => []) : []
        ]);

        // The server returns details in its own order; restore recency order.
        const rank = new Map(ids.map((id, i) => [id, i]));
        const ordered = (details || [])
            .filter((item) => item && rank.has(item.Id))
            .sort((a, b) => rank.get(a.Id) - rank.get(b.Id));

        return buildTasteProfile(ordered, favorites);
    };

    return () => {
        if (!promise) {
            promise = build().catch((err) => {
                if (onError) onError('Failed to build taste profile', err);
                // A failed build must not stick: the next row retries instead of staying empty.
                promise = null;
                return buildTasteProfile([], []);
            });
        }
        return promise;
    };
}

/**
 * Creates a loader that resolves one recommendation row per kind (actor, director, studio, genre).
 * Rows run through a shared queue and exclusion set, so no title is suggested twice.
 *
 * @param {Object} deps
 * @param {() => Promise<Object>} deps.getProfile - From createTasteProfileProvider.
 * @param {(kind: string, source: {id: string, name: string}) => Promise<Array<Object>>} deps.fetchByKind
 * @param {Set<string>} deps.exclude - Shared with the other recommendation rows.
 * @param {{run: Function}} [deps.queue]
 * @param {(msg: string, err: any) => void} [deps.onError]
 * @param {boolean} [deps.claimTitles=true] - Add shown titles to `exclude`. Turn off so a row's result
 *   never depends on which other rows loaded first.
 * @param {number} [deps.rowLimit] - Titles a row shows. Only these are claimed, so a row never starves later ones.
 * @param {(msg: string) => void} [deps.onTrace] - Reports why a candidate was kept or skipped.
 * @returns {(kind: string, index: number) => Promise<{kind: string, sourceName: string, items: Array<Object>}|null>}
 */
export function createTasteRowLoader({ getProfile, fetchByKind, exclude, queue, onError, onTrace, rowLimit, claimTitles = true }) {
    const trace = onTrace || (() => {});
    const used = {};
    const slots = {};
    const run = queue ? (fn) => queue.run(fn) : (fn) => fn();

    const resolveNext = async (kind) => {
        const profile = await getProfile();
        const usedForKind = used[kind] || (used[kind] = new Set());
        const all = profile[kind] || [];
        const candidates = all.filter((c) => c.support >= MIN_SUPPORT && !usedForKind.has(c.id)).slice(0, MAX_TRIES);
        trace(`${kind}: ${all.length} sources in profile, ${candidates.length} with at least ${MIN_SUPPORT} titles`);

        for (const candidate of candidates) {
            usedForKind.add(candidate.id);
            let found;
            try {
                found = await fetchByKind(kind, candidate);
            } catch (err) {
                if (onError) onError(`Failed to load ${kind} recommendations for ${candidate.name}`, err);
                continue;
            }
            const usable = filterSimilar(found, exclude);
            const items = rowLimit ? usable.slice(0, rowLimit) : usable;
            trace(`${kind}: ${candidate.name} returned ${(found || []).length} items, ${usable.length} usable`);
            if (items.length < MIN_ROW_ITEMS) continue;
            if (claimTitles) items.forEach((item) => exclude.add(item.Id));
            return { kind, sourceName: candidate.name, items };
        }
        return null;
    };

    return (kind, index) => {
        const list = slots[kind] || (slots[kind] = []);
        const load = (i) => {
            if (!list[i]) {
                const previous = i > 0 ? load(i - 1) : Promise.resolve();
                list[i] = previous.then(() => run(() => resolveNext(kind)));
            }
            return list[i];
        };
        return load(index);
    };
}
