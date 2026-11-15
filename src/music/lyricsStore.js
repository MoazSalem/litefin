import { parseLyrics } from './lyricsSync.js';

const DEFAULT_LIMIT = 8;

const hasText = (lyrics) => lyrics.lines.some((line) => line.text.trim() !== '');

function toLyrics(dto) {
    const lyrics = parseLyrics(dto);
    return hasText(lyrics) ? lyrics : null;
}

export function createLyricsStore({ fetchLyrics, limit = DEFAULT_LIMIT, log = { debug: () => {} } }) {
    const entries = new Map();

    const remember = (itemId, entry) => {
        entries.delete(itemId);
        entries.set(itemId, entry);
        if (entries.size > limit) entries.delete(entries.keys().next().value);
    };

    const fetchEntry = (itemId) => {
        const entry = { settled: false, lyrics: null, promise: null };
        entry.promise = Promise.resolve()
            .then(() => fetchLyrics(itemId))
            .then(toLyrics)
            .then(
                (lyrics) => {
                    entry.lyrics = lyrics;
                    entry.settled = true;
                    return lyrics;
                },
                (err) => {
                    log.debug('No lyrics for item', itemId, err);
                    if (entries.get(itemId) === entry) entries.delete(itemId);
                    return null;
                }
            );
        return entry;
    };

    const load = (item) => {
        if (!item) return Promise.resolve(null);
        const existing = entries.get(item.Id);
        if (existing) {
            remember(item.Id, existing);
            return existing.promise;
        }
        const entry =
            item.HasLyrics === false
                ? { settled: true, lyrics: null, promise: Promise.resolve(null) }
                : fetchEntry(item.Id);
        remember(item.Id, entry);
        return entry.promise;
    };

    const peek = (itemId) => {
        const entry = entries.get(itemId);
        return entry && entry.settled ? { lyrics: entry.lyrics } : undefined;
    };

    return { load, peek };
}
