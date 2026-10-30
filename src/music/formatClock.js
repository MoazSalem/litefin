const pad = (value) => String(value).padStart(2, '0');

export function formatClock(ms) {
    const totalSeconds = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

export function progressRatio(positionMs, durationMs) {
    if (!(durationMs > 0) || !(positionMs > 0)) return 0;
    return Math.min(1, positionMs / durationMs);
}
