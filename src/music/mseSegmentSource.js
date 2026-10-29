import { parseHlsPlaylist } from './hlsPlaylist.js';

export const PLAYLIST_TIMEOUT_MS = 10000;
export const SEGMENT_TIMEOUT_MS = 20000;

/* races the abort as well, so a fetch that ignores its signal still settles */
function request({ fetchFn, timers }, url, signal, timeoutMs, read) {
    const controller = new AbortController();
    let reason = 'aborted';
    const aborted = new Promise((resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(new Error(`Request ${reason}: ${url}`)));
    });
    const abort = () => controller.abort();
    const timer = timers.setTimeoutFn(() => {
        reason = `timed out after ${timeoutMs} ms`;
        abort();
    }, timeoutMs);
    if (signal) signal.addEventListener('abort', abort);
    if (signal && signal.aborted) abort();
    const cleanup = () => {
        timers.clearTimeoutFn(timer);
        if (signal) signal.removeEventListener('abort', abort);
    };
    const work = fetchFn(url, { signal: controller.signal }).then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return read(response);
    });
    return Promise.race([work, aborted]).then(
        (value) => {
            cleanup();
            return value;
        },
        (err) => {
            cleanup();
            throw err;
        }
    );
}

export function createHttpFetchers({
    fetchFn = (url, init) => globalThis.fetch(url, init),
    setTimeoutFn = (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeoutFn = (handle) => globalThis.clearTimeout(handle)
} = {}) {
    const deps = { fetchFn, timers: { setTimeoutFn, clearTimeoutFn } };
    return {
        fetchText: (url, signal) => request(deps, url, signal, PLAYLIST_TIMEOUT_MS, (response) => response.text()),
        fetchBytes: (url, signal) =>
            request(
                deps,
                url,
                signal,
                SEGMENT_TIMEOUT_MS,
                async (response) => new Uint8Array(await response.arrayBuffer())
            )
    };
}

const http = createHttpFetchers();
export const defaultFetchText = http.fetchText;
export const defaultFetchBytes = http.fetchBytes;

export async function fetchPlaylist(fetchText, track, signal) {
    const playlist = parseHlsPlaylist(await fetchText(track.url, signal), track.url);
    if (playlist.segments.length === 0) throw new Error(`HLS playlist for ${track.id} has no segments`);
    return playlist;
}

export async function fetchTrackStart(fetchText, fetchBytes, track, signal) {
    const playlist = await fetchPlaylist(fetchText, track, signal);
    return { playlist, init: await fetchBytes(playlist.initUrl, signal) };
}

/* Jellyfin restarts a transcode whose segments vanished once the playlist is requested again */
export async function fetchSegment({ fetchText, fetchBytes, item, isLive, log, signal }) {
    try {
        return { bytes: await fetchBytes(item.playlist.segments[item.index].url, signal) };
    } catch (err) {
        if (!isLive()) throw err;
        log.warn(`Segment ${item.index} of ${item.track.id} failed, refetching the playlist`, err);
        const playlist = await fetchPlaylist(fetchText, item.track, signal);
        const segment = playlist.segments[item.index];
        if (!segment) throw new Error(`Refetched playlist for ${item.track.id} lacks segment ${item.index}`);
        if (!isLive()) return { playlist };
        return { playlist, bytes: await fetchBytes(segment.url, signal) };
    }
}
