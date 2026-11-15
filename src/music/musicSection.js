const MUSIC_ITEM_TYPES = new Set(['MusicAlbum', 'Audio', 'MusicArtist', 'MusicGenre']);
const MUSIC_CONTAINER_TYPES = new Set(['MusicAlbum', 'MusicArtist', 'MusicGenre']);
const PENDING_ROUTE_PREFIXES = ['/details/', '/library/'];

const isVideo = (item) => item.MediaType === 'Video';

export function classifyRoute(path) {
    if (path === '/now-playing') return 'music';
    if (PENDING_ROUTE_PREFIXES.some((prefix) => path.startsWith(prefix))) return 'pending';
    return 'outside';
}

export function isMusicItem(item) {
    return !isVideo(item) && MUSIC_ITEM_TYPES.has(item.Type);
}

export function isMusicPlayRequest(item) {
    if (isVideo(item)) return false;
    return item.Type === 'Audio' || MUSIC_CONTAINER_TYPES.has(item.Type);
}
