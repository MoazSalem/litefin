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

test('parseLyrics restores spaces of word-synced lines from their cues', () => {
    const cue = (Position, EndPosition) => ({ Position, EndPosition, Start: 0, End: 0 });
    const { lines } = parseLyrics({
        Lyrics: [
            {
                Text: "Pa'unaciudaddelnorte",
                Start: 10_000,
                Cues: [cue(0, 3), cue(3, 6), cue(6, 12), cue(12, 15), cue(15, 20)]
            },
            { Text: 'Already spaced line', Start: 20_000, Cues: [cue(0, 7), cue(8, 14)] },
            { Text: 'NoCues', Start: 30_000 },
            { Text: 'Single', Start: 40_000, Cues: [cue(0, 6)] }
        ]
    });
    assert.deepEqual(
        lines.map((l) => l.text),
        ["Pa' una ciudad del norte", 'Already spaced line', 'NoCues', 'Single']
    );
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
