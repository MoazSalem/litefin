const TICKS_PER_SECOND = 10_000_000;

const pad2 = (n) => String(n).padStart(2, '0');

export function formatDuration(ticks) {
    const totalSeconds = Math.floor((ticks || 0) / TICKS_PER_SECOND);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return hours > 0 ? `${hours}:${pad2(minutes)}:${pad2(seconds)}` : `${minutes}:${pad2(seconds)}`;
}

export function groupByDisc(tracks) {
    const groups = [];
    for (const track of tracks || []) {
        const disc = track.ParentIndexNumber ?? null;
        const last = groups[groups.length - 1];
        if (last && last.disc === disc) {
            last.tracks.push(track);
        } else {
            groups.push({ disc, tracks: [track] });
        }
    }
    const distinctDiscs = new Set(groups.map((g) => g.disc).filter((d) => d !== null));
    if (distinctDiscs.size <= 1) {
        return groups.length ? [{ disc: null, tracks: groups.flatMap((g) => g.tracks) }] : [];
    }
    return groups;
}

export function trackNumber(track, positionInGroup) {
    return track.IndexNumber ?? positionInGroup + 1;
}

export function trackArtistLine(track, album) {
    const artists = track.Artists || [];
    if (!artists.length) return '';
    const albumArtists = new Set((album.AlbumArtists || []).map((a) => a.Name.toLowerCase()));
    const trackArtists = new Set(artists.map((a) => a.toLowerCase()));
    const same = albumArtists.size === trackArtists.size && [...trackArtists].every((a) => albumArtists.has(a));
    return same ? '' : artists.join(', ');
}

export function albumMetaParts(album, tracks) {
    return {
        year: album.ProductionYear ?? null,
        genre: (album.Genres && album.Genres[0]) || null,
        songCount: tracks.length,
        totalTicks: tracks.reduce((sum, t) => sum + (t.RunTimeTicks || 0), 0)
    };
}
