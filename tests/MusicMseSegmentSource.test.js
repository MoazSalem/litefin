import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchPlaylist, fetchSegment, fetchTrackStart } from '../src/music/mseSegmentSource.js';

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

test('a segment that loads needs no playlist refetch', async () => {
    const s = source();
    const result = await fetchSegment({ ...s, item: await itemAt(1), isLive: s.live, log: noopLog });

    assert.deepEqual(result, { bytes: 'http://srv/a/seg1.mp4' });
    assert.deepEqual(s.texts, []);
});

test('a failed segment refetches the playlist once and retries the same index from it', async () => {
    const s = source({ failures: { 'http://srv/a/seg1.mp4': 1 } });
    const result = await fetchSegment({ ...s, item: await itemAt(1), isLive: s.live, log: noopLog });

    assert.equal(result.bytes, 'http://srv/a/seg1.mp4?job=2');
    assert.equal(result.playlist.segments[1].url, 'http://srv/a/seg1.mp4?job=2');
    assert.deepEqual(s.texts, [URL_A]);
});

test('a retry that fails again rejects without a second refetch', async () => {
    const s = source({ failures: { 'http://srv/a/seg1.mp4': 1, 'http://srv/a/seg1.mp4?job=2': 1 } });
    await assert.rejects(fetchSegment({ ...s, item: await itemAt(1), isLive: s.live, log: noopLog }), /HTTP 503/);
    assert.deepEqual(s.texts, [URL_A]);
});

test('a failure after the item went stale rethrows without refetching', async () => {
    const s = source({ failures: { 'http://srv/a/seg0.mp4': 1 }, live: () => false });
    await assert.rejects(fetchSegment({ ...s, item: await itemAt(0), isLive: s.live, log: noopLog }), /HTTP 503/);
    assert.deepEqual(s.texts, []);
});

test('fetchTrackStart returns the playlist with its init segment', async () => {
    const s = source();
    const start = await fetchTrackStart(s.fetchText, s.fetchBytes, track);

    assert.equal(start.init, 'http://srv/a/init.mp4');
    assert.equal(start.playlist.segments.length, 2);
});
