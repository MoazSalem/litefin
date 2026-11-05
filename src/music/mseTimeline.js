export const emptyTimeline = () => ({ entries: [] });

export const addTrack = (timeline, trackId, origin) => ({
    entries: [...timeline.entries, { trackId, origin, end: null }]
});

export const closeTrack = (timeline, trackId, end) => ({
    entries: timeline.entries.map((entry) => (entry.trackId === trackId ? { ...entry, end } : entry))
});

export function dropFrom(timeline, trackId) {
    const index = timeline.entries.findIndex((entry) => entry.trackId === trackId);
    if (index === -1) return timeline;
    return { entries: timeline.entries.slice(0, index) };
}

export function entryAt(timeline, mediaTime) {
    const reached = timeline.entries.filter((entry) => entry.origin <= mediaTime);
    return reached.length > 0 ? reached[reached.length - 1] : null;
}

export function positionMs(timeline, mediaTime) {
    const entry = entryAt(timeline, mediaTime);
    return entry ? (mediaTime - entry.origin) * 1000 : 0;
}

export const evictionEnd = (currentTime, keepBehind = 4) => Math.max(0, currentTime - keepBehind);
