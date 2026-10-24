export const CHUNK_SECONDS = 5;
export const LOOKAHEAD_MAX_SECONDS = 15;
export const LEAD_IN_SECONDS = 0.3;
export const STARVATION_MARGIN_SECONDS = 0.005;
export const RESTART_LEAD_SECONDS = 0.05;

export function positionFromContext(ctxNow, trackStartCtxTime, offsetSec) {
    return Math.max(0, (Math.max(0, ctxNow - trackStartCtxTime) + offsetSec) * 1000);
}

export function resolveChunkStart(clockEnd, now) {
    if (clockEnd === null) return { when: now + LEAD_IN_SECONDS, shift: 0, starved: false };
    if (clockEnd >= now + STARVATION_MARGIN_SECONDS) return { when: clockEnd, shift: 0, starved: false };
    const when = now + RESTART_LEAD_SECONDS;
    return { when, shift: when - clockEnd, starved: true };
}

export function hasLookaheadRoom(clockEnd, now) {
    return clockEnd === null || clockEnd - now + CHUNK_SECONDS <= LOOKAHEAD_MAX_SECONDS;
}

export function seekTargetSample(ms, sampleRate, totalSamples) {
    const sample = Math.max(0, Math.round((ms / 1000) * sampleRate));
    return totalSamples > 0 ? Math.min(sample, totalSamples - 1) : sample;
}

export function chunkTrimSeconds(targetSample, chunkFirstSample, sampleRate) {
    return Math.max(0, targetSample - chunkFirstSample) / sampleRate;
}
