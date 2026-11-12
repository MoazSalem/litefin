import assert from 'node:assert/strict';
import test from 'node:test';
import { albumMetaLine, mergeAlbumArtists, fetchAllPages, isMusicDetailsType } from '../src/music/albumPage.js';

test('mergeAlbumArtists de-duplicates artists by id across ArtistItems and AlbumArtists', () => {
    const item = {
        ArtistItems: [
            { Id: 'a', Name: 'Marina Vale' },
            { Id: 'b', Name: 'Theo Ash' }
        ],
        AlbumArtists: [{ Id: 'a', Name: 'Marina Vale' }]
    };
    assert.deepEqual(
        mergeAlbumArtists(item).map((a) => a.Id),
        ['a', 'b']
    );
});

test('mergeAlbumArtists falls back to name when id is missing and tolerates empty input', () => {
    const item = { ArtistItems: [{ Name: 'X' }], AlbumArtists: [{ Name: 'x' }] };
    assert.equal(mergeAlbumArtists(item).length, 1);
    assert.deepEqual(mergeAlbumArtists({}), []);
});

test('fetchAllPages pages until TotalRecordCount is reached', async () => {
    const calls = [];
    const data = Array.from({ length: 5 }, (_, i) => ({ Id: i }));
    const all = await fetchAllPages(async (start, size) => {
        calls.push([start, size]);
        return { Items: data.slice(start, start + size), TotalRecordCount: data.length };
    }, 2);
    assert.equal(all.length, 5);
    assert.deepEqual(calls, [
        [0, 2],
        [2, 2],
        [4, 2]
    ]);
});

test('fetchAllPages stops on a short page without a total and on empty pages', async () => {
    const all = await fetchAllPages(async () => ({ Items: [{ Id: 1 }] }), 5);
    assert.equal(all.length, 1);
    assert.deepEqual(await fetchAllPages(async () => ({ Items: [] }), 5), []);
});

test('isMusicDetailsType', () => {
    assert.equal(isMusicDetailsType('MusicAlbum'), true);
    assert.equal(isMusicDetailsType('Audio'), true);
    assert.equal(isMusicDetailsType('Movie'), false);
});

const t = (key, args = []) => ({ 'music.songCount': `${args[0]} songs`, 'music.songCountOne': '1 song' })[key];

test('albumMetaLine joins year, genre, song count and duration', () => {
    const album = { ProductionYear: 2023, Genres: ['Indie Pop'] };
    const tracks = [{ RunTimeTicks: 2_400_000_000 }, { RunTimeTicks: 1_200_000_000 }];
    assert.equal(albumMetaLine(album, tracks, t), '2023 · Indie Pop · 2 songs · 6:00');
});

test('albumMetaLine omits missing parts and uses singular', () => {
    assert.equal(albumMetaLine({}, [{ RunTimeTicks: 0 }], t), '1 song');
});
