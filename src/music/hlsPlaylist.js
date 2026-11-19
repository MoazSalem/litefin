const MAP_URI = /^#EXT-X-MAP:.*URI="([^"]+)"/;
const EXTINF = /^#EXTINF:([\d.]+)/;

export function parseHlsPlaylist(text, playlistUrl) {
    const resolve = (rel) => new URL(rel, playlistUrl).href;
    let initUrl = null;
    let pendingDuration = null;
    let start = 0;
    const segments = [];

    for (const raw of String(text).split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        const map = MAP_URI.exec(line);
        if (map) {
            initUrl = resolve(map[1]);
            continue;
        }
        const inf = EXTINF.exec(line);
        if (inf) {
            pendingDuration = parseFloat(inf[1]);
            continue;
        }
        if (line.startsWith('#') || pendingDuration === null) continue;
        segments.push({ url: resolve(line), start, duration: pendingDuration });
        start += pendingDuration;
        pendingDuration = null;
    }

    if (!initUrl) throw new Error('HLS playlist has no EXT-X-MAP');
    return { initUrl, segments };
}

export function segmentIndexAt(segments, seconds) {
    const index = segments.findIndex((s) => seconds < s.start + s.duration);
    return index === -1 ? segments.length - 1 : index;
}
