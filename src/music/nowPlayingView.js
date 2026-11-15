export const LAYOUT = { LYRICS: 'lyrics', STATIC_LYRICS: 'static-lyrics', AMBIENT: 'ambient' };

const LYRICS_ANCHOR = 0.32;
const REPEAT_CYCLE = ['RepeatNone', 'RepeatAll', 'RepeatOne'];
const WASH_STOPS = [
    { at: '30% 35%', alpha: 0.55, reach: '42%' },
    { at: '70% 65%', alpha: 0.7, reach: '46%' },
    { at: '55% 20%', alpha: 0.35, reach: '36%' }
];

export function chooseLayout(lyrics, lyricsOn) {
    if (!lyrics || !lyricsOn) return LAYOUT.AMBIENT;
    return lyrics.synced ? LAYOUT.LYRICS : LAYOUT.STATIC_LYRICS;
}

export function lineState(index, activeIndex) {
    if (index === activeIndex) return 'now';
    return index < activeIndex ? 'past' : 'next';
}

export function changedLineStates(previousIndex, activeIndex) {
    const changes = [];
    const first = Math.max(0, Math.min(previousIndex, activeIndex));
    const last = Math.max(previousIndex, activeIndex);
    for (let index = first; index <= last; index++) {
        const state = lineState(index, activeIndex);
        if (state !== lineState(index, previousIndex)) changes.push({ index, state });
    }
    return changes;
}

export function lyricsScrollOffset(lineTop, viewportHeight, anchor = LYRICS_ANCHOR) {
    return Math.max(0, Math.round(lineTop - viewportHeight * anchor));
}

export function nextRepeatMode(mode) {
    const index = Math.max(0, REPEAT_CYCLE.indexOf(mode));
    return REPEAT_CYCLE[(index + 1) % REPEAT_CYCLE.length];
}

export function washBackground(palette) {
    return WASH_STOPS.map(({ at, alpha, reach }, i) => {
        const [r, g, b] = palette[i];
        return `radial-gradient(circle at ${at}, rgba(${r}, ${g}, ${b}, ${alpha}), transparent ${reach})`;
    }).join(', ');
}
