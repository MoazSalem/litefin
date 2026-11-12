import { albumMetaParts, formatDuration } from './albumFormat.js';

const PAGE_SIZE = 200;

export function mergeAlbumArtists(item) {
    const merged = [];
    const seen = new Set();
    for (const artist of [...(item.ArtistItems || []), ...(item.AlbumArtists || [])]) {
        const key = artist.Id || (artist.Name || '').toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        merged.push(artist);
    }
    return merged;
}

export async function fetchAllPages(fetchPage, pageSize = PAGE_SIZE) {
    const all = [];
    for (;;) {
        const response = await fetchPage(all.length, pageSize);
        const items = response?.Items || [];
        all.push(...items);
        const total = response?.TotalRecordCount;
        if (!items.length || (total !== undefined ? all.length >= total : items.length < pageSize)) break;
    }
    return all;
}

export function isMusicDetailsType(type) {
    return type === 'MusicAlbum' || type === 'Audio';
}

export function albumMetaLine(album, tracks, t) {
    const { year, genre, songCount, totalTicks } = albumMetaParts(album, tracks);
    const songs = songCount === 1 ? t('music.songCountOne') : t('music.songCount', [songCount]);
    return [year, genre, songCount ? songs : null, totalTicks ? formatDuration(totalTicks) : null]
        .filter((part) => part !== null && part !== '')
        .join(' · ');
}
