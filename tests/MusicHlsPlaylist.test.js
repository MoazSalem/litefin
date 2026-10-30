import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHlsPlaylist, segmentIndexAt } from '../src/music/hlsPlaylist.js';

const PLAYLIST_URL = 'http://192.168.0.48:8097/Audio/abc/main.m3u8?segmentContainer=mp4&audioCodec=copy&ApiKey=tok';
const QS = 'segmentContainer=mp4&audioCodec=copy';
const PLAYLIST = [
    '#EXTM3U',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-VERSION:7',
    '#EXT-X-TARGETDURATION:4',
    '#EXT-X-MEDIA-SEQUENCE:0',
    `#EXT-X-MAP:URI="hls1/main/-1.mp4?${QS}&runtimeTicks=0&actualSegmentLengthTicks=0"`,
    '#EXTINF:4.0000, nodesc',
    `hls1/main/0.mp4?${QS}&runtimeTicks=0&actualSegmentLengthTicks=40000000`,
    '#EXTINF:4.0000, nodesc',
    `hls1/main/1.mp4?${QS}&runtimeTicks=40000000&actualSegmentLengthTicks=40000000`,
    '#EXTINF:1.4560, nodesc',
    `hls1/main/2.mp4?${QS}&runtimeTicks=80000000&actualSegmentLengthTicks=14560000`,
    '#EXT-X-ENDLIST',
    ''
].join('\n');

test('resolves init and segment URLs against the playlist URL, keeping their query strings', () => {
    const { initUrl, segments } = parseHlsPlaylist(PLAYLIST, PLAYLIST_URL);
    assert.equal(
        initUrl,
        `http://192.168.0.48:8097/Audio/abc/hls1/main/-1.mp4?${QS}&runtimeTicks=0&actualSegmentLengthTicks=0`
    );
    assert.equal(
        segments[1].url,
        `http://192.168.0.48:8097/Audio/abc/hls1/main/1.mp4?${QS}&runtimeTicks=40000000&actualSegmentLengthTicks=40000000`
    );
    assert.ok(!segments[0].url.includes('ApiKey'));
});

test('computes cumulative starts and keeps the short last segment duration', () => {
    const { segments } = parseHlsPlaylist(PLAYLIST, PLAYLIST_URL);
    assert.deepEqual(
        segments.map((s) => s.start),
        [0, 4, 8]
    );
    assert.deepEqual(
        segments.map((s) => s.duration),
        [4, 4, 1.456]
    );
});

test('tolerates CRLF line endings and trailing whitespace', () => {
    const crlf = PLAYLIST.split('\n')
        .map((l) => (l ? `${l}  ` : l))
        .join('\r\n');
    const { initUrl, segments } = parseHlsPlaylist(crlf, PLAYLIST_URL);
    assert.ok(initUrl.endsWith('actualSegmentLengthTicks=0'));
    assert.equal(segments.length, 3);
    assert.ok(segments[2].url.endsWith('actualSegmentLengthTicks=14560000'));
});

test('throws when the playlist has no EXT-X-MAP', () => {
    const noMap = PLAYLIST.split('\n')
        .filter((l) => !l.startsWith('#EXT-X-MAP'))
        .join('\n');
    assert.throws(() => parseHlsPlaylist(noMap, PLAYLIST_URL), /HLS playlist has no EXT-X-MAP/);
});

test('segmentIndexAt finds the containing segment and clamps to the last', () => {
    const { segments } = parseHlsPlaylist(PLAYLIST, PLAYLIST_URL);
    assert.equal(segmentIndexAt(segments, 0), 0);
    assert.equal(segmentIndexAt(segments, 3.99), 0);
    assert.equal(segmentIndexAt(segments, 4), 1);
    assert.equal(segmentIndexAt(segments, 100), 2);
});
