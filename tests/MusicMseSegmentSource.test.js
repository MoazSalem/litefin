import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    PLAYLIST_TIMEOUT_MS,
    SEGMENT_TIMEOUT_MS,
    createHttpFetchers,
    fetchPlaylist,
    fetchSegment,
    fetchTrackStart
} from '../src/music/mseSegmentSource.js';

const URL_A = 'http://srv/a/main.m3u8';
const track = { id: 'a', url: URL_A };
const playlistText = (suffix) =>
    ['#EXTM3U', '#EXT-X-MAP:URI="init.mp4"', '#EXTINF:4,', `seg0.mp4${suffix}`, '#EXTINF:4,', `seg1.mp4${suffix}`].join(
        '\n'
    );
const noopLog = { warn: () => {} };

function source({ failures = {}, live = () => true } = {}) {
    const texts = [];
    const bytes = [];
    const left = new Map(Object.entries(failures));
    const fetchText = async (url) => {
        texts.push(url);
        return playlistText('?job=2');
    };
    const fetchBytes = async (url) => {
        bytes.push(url);
        if ((left.get(url) || 0) > 0) {
            left.set(url, left.get(url) - 1);
            throw new Error('HTTP 503');
        }
        return url;
    };
    return { texts, bytes, fetchText, fetchBytes, live };
}

const itemAt = async (index) => ({
    track,
    index,
    playlist: await fetchPlaylist(async () => playlistText(''), track)
});

test('fetchPlaylist rejects a playlist without segments', async () => {
    await assert.rejects(
        fetchPlaylist(async () => '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"', track),
        /no segments/
    );
});

const plenty = () => ({ now: 100, ahead: 10 });
const fetchArgs = (s, item, clock = plenty) => ({ ...s, item, clock, log: noopLog });

test('a segment that loads needs no playlist refetch and clears the retry', async () => {
    const s = source();
    const item = { ...(await itemAt(1)), retry: null };
    const result = await fetchSegment(fetchArgs(s, item));

    assert.equal(result.bytes, 'http://srv/a/seg1.mp4');
    assert.equal(result.retry, null);
    assert.deepEqual(s.texts, []);
});

test('a failed segment with buffer ahead resolves with a retry instead of rejecting', async () => {
    const s = source({ failures: { 'http://srv/a/seg1.mp4': 1 } });
    const result = await fetchSegment(fetchArgs(s, { ...(await itemAt(1)), bytes: null, retry: null }));

    assert.equal(result.bytes, null);
    assert.deepEqual(result.retry, { startedAt: 100, attempt: 1, at: 600, refetchPlaylist: true });
    assert.deepEqual(s.texts, []);
});

test('the first retry refetches the playlist and fetches the same index from it', async () => {
    const s = source();
    const retry = { startedAt: 100, attempt: 1, at: 600, refetchPlaylist: true };
    const result = await fetchSegment(fetchArgs(s, { ...(await itemAt(1)), retry }));

    assert.equal(result.bytes, 'http://srv/a/seg1.mp4?job=2');
    assert.equal(result.playlist.segments[1].url, 'http://srv/a/seg1.mp4?job=2');
    assert.deepEqual(s.texts, [URL_A]);
});

test('a retry that fails after a successful refetch keeps the playlist and does not refetch again', async () => {
    const s = source({ failures: { 'http://srv/a/seg1.mp4?job=2': 1 } });
    const retry = { startedAt: 100, attempt: 1, at: 600, refetchPlaylist: true };
    const result = await fetchSegment(fetchArgs(s, { ...(await itemAt(1)), retry }));

    assert.equal(result.playlist.segments[1].url, 'http://srv/a/seg1.mp4?job=2');
    assert.equal(result.retry.refetchPlaylist, false);
});

test('a failure without a retry left rejects', async () => {
    const s = source({ failures: { 'http://srv/a/seg0.mp4': 1 } });
    const item = { ...(await itemAt(0)), retry: null };
    await assert.rejects(fetchSegment(fetchArgs(s, item, () => ({ now: 0, ahead: 2 }))), /HTTP 503/);
});

test('the request signal reaches every fetch', async () => {
    const seen = [];
    const signal = new AbortController().signal;
    const fetchText = async (url, sig) => {
        seen.push(sig);
        return playlistText('');
    };
    const fetchBytes = async (url, sig) => {
        seen.push(sig);
        return url;
    };
    const retry = { startedAt: 0, attempt: 1, at: 0, refetchPlaylist: true };
    await fetchSegment({ fetchText, fetchBytes, item: { ...(await itemAt(0)), retry }, signal, clock: plenty });
    await fetchTrackStart(fetchText, fetchBytes, track, signal);
    assert.equal(seen.length, 4);
    assert.ok(seen.every((sig) => sig === signal));
});

test('fetchTrackStart returns the playlist with its init segment', async () => {
    const s = source();
    const start = await fetchTrackStart(s.fetchText, s.fetchBytes, track);

    assert.equal(start.init, 'http://srv/a/init.mp4');
    assert.equal(start.playlist.segments.length, 2);
});

function http(responder) {
    const timers = [];
    const requests = [];
    const fetchers = createHttpFetchers({
        fetchFn: (url, init) => {
            requests.push({ url, signal: init.signal });
            return responder(url);
        },
        setTimeoutFn: (fn, ms) => timers.push({ fn, ms, cleared: false }),
        clearTimeoutFn: (handle) => {
            timers[handle - 1].cleared = true;
        }
    });
    const fire = () => timers.filter((t) => !t.cleared).forEach((t) => t.fn());
    return { ...fetchers, timers, requests, fire };
}
const never = () => new Promise(() => {});

test('I1: a playlist request that never answers rejects once its 10 s timeout fires', async () => {
    const h = http(never);
    const pending = h.fetchText('http://srv/a/main.m3u8');

    assert.deepEqual(
        h.timers.map((t) => t.ms),
        [PLAYLIST_TIMEOUT_MS]
    );
    assert.equal(PLAYLIST_TIMEOUT_MS, 10000);
    h.fire();
    await assert.rejects(pending, /timed out after 10000 ms/);
    assert.equal(h.requests[0].signal.aborted, true);
});

test('I1: a segment request that never answers rejects once its 20 s timeout fires', async () => {
    const h = http(never);
    const pending = h.fetchBytes('http://srv/a/seg0.mp4');

    assert.equal(SEGMENT_TIMEOUT_MS, 20000);
    assert.deepEqual(
        h.timers.map((t) => t.ms),
        [SEGMENT_TIMEOUT_MS]
    );
    h.fire();
    await assert.rejects(pending, /timed out/);
});

test('I1: aborting the caller signal cancels a hanging request at once', async () => {
    const h = http(never);
    const owner = new AbortController();
    const pending = h.fetchBytes('http://srv/a/seg0.mp4', owner.signal);

    owner.abort();
    await assert.rejects(pending, /aborted/);
    assert.equal(h.requests[0].signal.aborted, true);
    assert.equal(h.timers[0].cleared, true);
});

test('I1: an answered request clears its timeout and a non-OK status still rejects', async () => {
    const h = http(async (url) =>
        url.endsWith('missing') ? { ok: false, status: 404 } : { ok: true, text: async () => '#EXTM3U' }
    );

    assert.equal(await h.fetchText('http://srv/a/main.m3u8'), '#EXTM3U');
    await assert.rejects(h.fetchText('http://srv/a/missing'), /HTTP 404/);
    assert.ok(h.timers.every((t) => t.cleared));
});
