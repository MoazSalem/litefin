import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLyrics, activeLineIndex } from '../src/music/lyricsSync.js';

test('parseLyrics converts ticks to ms and detects synced', () => {
    const r = parseLyrics({
        Lyrics: [
            { Text: 'a', Start: 10_000_000 },
            { Text: 'b', Start: 25_000_000 }
        ]
    });
    assert.equal(r.synced, true);
    assert.deepEqual(r.lines, [
        { startMs: 1000, text: 'a' },
        { startMs: 2500, text: 'b' }
    ]);
});

test('parseLyrics unsynced when Start missing', () => {
    assert.equal(parseLyrics({ Lyrics: [{ Text: 'a' }, { Text: 'b' }] }).synced, false);
});

test('parseLyrics handles null', () => {
    assert.deepEqual(parseLyrics(null), { synced: false, lines: [] });
});

test('activeLineIndex', () => {
    const lines = [{ startMs: 1000 }, { startMs: 2500 }, { startMs: 4000 }];
    assert.equal(activeLineIndex(lines, 0), -1);
    assert.equal(activeLineIndex(lines, 1000), 0);
    assert.equal(activeLineIndex(lines, 3999), 1);
    assert.equal(activeLineIndex(lines, 99999), 2);
});
