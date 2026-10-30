import assert from 'node:assert/strict';
import test from 'node:test';
import { formatDuration, groupByDisc, trackNumber, trackArtistLine, albumMetaParts } from '../src/music/albumFormat.js';

test('formatDuration', () => {
    assert.equal(formatDuration(2_210_000_000), '3:41');
    assert.equal(formatDuration(36_610_000_000), '1:01:01');
    assert.equal(formatDuration(0), '0:00');
    assert.equal(formatDuration(undefined), '0:00');
});

test('groupByDisc: single disc -> one group with disc null', () => {
    const g = groupByDisc([{ IndexNumber: 1 }, { IndexNumber: 2 }]);
    assert.deepEqual(
        g.map((x) => x.disc),
        [null]
    );
});

test('groupByDisc: two discs keep order', () => {
    const g = groupByDisc([{ ParentIndexNumber: 1 }, { ParentIndexNumber: 2 }, { ParentIndexNumber: 2 }]);
    assert.deepEqual(
        g.map((x) => [x.disc, x.tracks.length]),
        [
            [1, 1],
            [2, 2]
        ]
    );
});

test('trackNumber falls back to position', () => {
    assert.equal(trackNumber({}, 4), 5);
    assert.equal(trackNumber({ IndexNumber: 9 }, 0), 9);
});

test('trackArtistLine hides when same as album artist', () => {
    const album = { AlbumArtists: [{ Name: 'Marina Vale' }] };
    assert.equal(trackArtistLine({ Artists: ['marina vale'] }, album), '');
    assert.equal(trackArtistLine({ Artists: ['Marina Vale', 'Theo Ash'] }, album), 'Marina Vale, Theo Ash');
    assert.equal(trackArtistLine({ Artists: [] }, album), '');
    assert.equal(trackArtistLine({}, {}), '');
});

test('albumMetaParts sums durations', () => {
    const m = albumMetaParts({ ProductionYear: 2023, Genres: ['Indie Pop'] }, [
        { RunTimeTicks: 10 },
        { RunTimeTicks: 5 }
    ]);
    assert.deepEqual(m, { year: 2023, genre: 'Indie Pop', songCount: 2, totalTicks: 15 });
});
