import { parseHlsPlaylist } from './hlsPlaylist.js';

async function fetchOk(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response;
}

export const defaultFetchText = async (url) => (await fetchOk(url)).text();
export const defaultFetchBytes = async (url) => new Uint8Array(await (await fetchOk(url)).arrayBuffer());

export async function fetchPlaylist(fetchText, track) {
    const playlist = parseHlsPlaylist(await fetchText(track.url), track.url);
    if (playlist.segments.length === 0) throw new Error(`HLS playlist for ${track.id} has no segments`);
    return playlist;
}

export async function fetchTrackStart(fetchText, fetchBytes, track) {
    const playlist = await fetchPlaylist(fetchText, track);
    return { playlist, init: await fetchBytes(playlist.initUrl) };
}

/* Jellyfin restarts a transcode whose segments vanished once the playlist is requested again */
export async function fetchSegment({ fetchText, fetchBytes, item, isLive, log }) {
    try {
        return { bytes: await fetchBytes(item.playlist.segments[item.index].url) };
    } catch (err) {
        if (!isLive()) throw err;
        log.warn(`Segment ${item.index} of ${item.track.id} failed, refetching the playlist`, err);
        const playlist = await fetchPlaylist(fetchText, item.track);
        const segment = playlist.segments[item.index];
        if (!segment) throw new Error(`Refetched playlist for ${item.track.id} lacks segment ${item.index}`);
        if (!isLive()) return { playlist };
        return { playlist, bytes: await fetchBytes(segment.url) };
    }
}
