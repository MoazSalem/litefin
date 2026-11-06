export const RETRY_FIRST_DELAY_MS = 500;
export const RETRY_MAX_DELAY_MS = 4000;
export const RETRY_BUDGET_MS = 30000;
export const RETRY_MIN_AHEAD_SECONDS = 3;
export const GIVE_UP_AHEAD_SECONDS = 1;

/* null means the failure is reported. The playlist is refetched until one refetch succeeds,
   because Jellyfin restarts a transcode job whose segments vanished once the playlist is requested again. */
export function nextRetry(retry, { now, ahead, refetched }) {
    if (!retry) {
        if (ahead <= RETRY_MIN_AHEAD_SECONDS) return null;
        return { startedAt: now, attempt: 1, at: now + RETRY_FIRST_DELAY_MS, refetchPlaylist: true };
    }
    if (ahead < GIVE_UP_AHEAD_SECONDS || now - retry.startedAt >= RETRY_BUDGET_MS) return null;
    return {
        startedAt: retry.startedAt,
        attempt: retry.attempt + 1,
        at: now + Math.min(RETRY_FIRST_DELAY_MS * 2 ** retry.attempt, RETRY_MAX_DELAY_MS),
        refetchPlaylist: retry.refetchPlaylist && !refetched
    };
}

/* a draining buffer brings the attempt forward, so the last one runs before playback reaches the gap */
export function retryDue(retry, { now, ahead }) {
    return !retry || now >= retry.at || ahead < GIVE_UP_AHEAD_SECONDS;
}
