const TICKS_PER_MS = 10_000;

/* Jellyfin strips the spaces of word-synced lines but keeps each word's position in Cues */
function lineText(line) {
    const text = line.Text || '';
    const cues = Array.isArray(line.Cues) ? line.Cues : [];
    if (cues.length < 2 || /\s/.test(text)) return text;
    return cues
        .map((cue) => text.slice(cue.Position, cue.EndPosition))
        .filter(Boolean)
        .join(' ');
}

export function parseLyrics(dto) {
    const raw = dto && Array.isArray(dto.Lyrics) ? dto.Lyrics : [];
    const lines = raw.map((l) => ({
        startMs: typeof l.Start === 'number' ? Math.round(l.Start / TICKS_PER_MS) : null,
        text: lineText(l)
    }));
    const synced = lines.length > 0 && lines.every((l) => l.text === '' || l.startMs !== null);
    if (!synced) return { synced: false, lines };

    let previous = 0;
    const monotonic = lines.map((l) => {
        previous = l.startMs ?? previous;
        return { startMs: previous, text: l.text };
    });
    return { synced: true, lines: monotonic };
}

export function activeLineIndex(lines, positionMs) {
    let low = 0;
    let high = lines.length - 1;
    let found = -1;
    while (low <= high) {
        const mid = (low + high) >> 1;
        if (lines[mid].startMs <= positionMs) {
            found = mid;
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }
    return found;
}
